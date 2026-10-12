import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createToolWorkerProviders, RemoteWorkflowWorker } from '../docker/harness/forge-tool-worker-provider.mjs';
import { call, callSync } from '../docker/harness/forge-tool-worker-wire.mjs';
import { createToolWorkerBashExecutor, trustedToolArgv } from '../docker/harness/forge-tool-worker-bash.mjs';

const runtime = resolve(process.env.FORGE_NATIVE_TEST_RUNTIME ?? '../ForgeAdminHarness/tmp/runtime-deps-ci');
const require = createRequire(join(runtime, 'package.json'));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
const fsWorkflowOnly = process.env.FORGE_TOOL_WORKER_TEST_SUBSET === 'fs-workflow';

test('TODO-047 typed CLI routing preserves ordinary Bash and keeps user files and environment outside the trusted client', () => {
  assert.deepEqual(trustedToolArgv('forge-verify profiles --format json'), ['/usr/local/bin/forge-verify', 'profiles', '--format', 'json']);
  const head = 'a'.repeat(40), fingerprint = 'b'.repeat(64);
  const argv = trustedToolArgv(`forge-release prepare --expected-head ${head} --expected-fingerprint ${fingerprint} --plan-json '{"value":"$(cat /private/sentinel)"}'`);
  assert.equal(argv[0], '/usr/local/bin/forge-release');
  assert.equal(argv.at(-1), '{"value":"$(cat /private/sentinel)"}'); // argv data, never a shell expansion.
  for (const ordinary of ['pwd', 'git status --short', 'npm test', 'forge-delivery contract inspect --source ordinary.json',
    'forge-verify profiles --format json; cat /private/sentinel', 'NODE_OPTIONS=--require=/workspace/untrusted.js forge-verify profiles --format json']) {
    assert.equal(trustedToolArgv(ordinary), null);
  }
  const calls = [];
  class Ordinary {
    run(spec) { calls.push({ kind: 'ordinary', spec }); }
    start(spec) { calls.push({ kind: 'ordinary-background', spec }); }
  }
  const Adapter = createToolWorkerBashExecutor(Ordinary, {
    runArgv(spec, argv) { calls.push({ kind: 'trusted', spec, argv }); },
    startArgv(spec, argv) { calls.push({ kind: 'trusted-background', spec, argv }); },
  });
  const executor = new Adapter();
  executor.run({ command: 'pwd', env: { ORDINARY: 'value' }, workdir: '/workspace/project' });
  executor.start({ command: 'forge-verify profiles --format json', env: { NODE_OPTIONS: '--require=/workspace/untrusted.js' },
    dshEnv: { LD_PRELOAD: '/workspace/untrusted.so' }, stdin: 'untrusted', workdir: '/private' });
  assert.equal(calls[0].kind, 'ordinary'); assert.equal(calls[0].spec.env.ORDINARY, 'value');
  assert.equal(calls[1].kind, 'trusted-background'); assert.equal(calls[1].spec.workdir, '/workspace');
  for (const key of ['env', 'dshEnv', 'stdin']) assert.equal(Object.hasOwn(calls[1].spec, key), false);
});

test('TODO-047 fixed worker preserves installed native fs, subprocess and workflow seams', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-tool-worker-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\forge-tool-worker-${randomUUID()}` : join(root, 'worker.sock');
  const child = fork(fileURLToPath(new URL('./fixtures/forge-tool-worker-host.mjs', import.meta.url)), [runtime, socketPath, root, fsWorkflowOnly ? 'fs-workflow' : 'all'], {
    env: { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: tmpdir(), TMP: tmpdir() } : {}) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let ctx;
  try {
    const ready = await Promise.race([once(child, 'message').then(([message]) => message),
      once(child, 'exit').then(([code]) => { throw new Error(`Fixture exited ${code}: ${stderr}`); })]);
    assert.equal(ready.status, 'ready');
    process.stderr.write('fixture: client connecting\n');
    const [{ Context }, fsApi, subprocessApi, sandboxApi, { SandboxPolicyService }] = await Promise.all([
      load('cordis'), load('dsh-fs'), load('dsh-subprocess'), load('dsh-sandbox'), load('dsh-sandbox-policy')]);
    const { ToolWorkerFileSystem, ToolWorkerSubprocess, ToolWorkerSandbox } = createToolWorkerProviders({ ...fsApi, ...subprocessApi, ...sandboxApi }, { socketPath });
    ctx = new Context(); await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root });
    await ctx.plugin(ToolWorkerFileSystem); await ctx.plugin(ToolWorkerSubprocess); await ctx.plugin(ToolWorkerSandbox);
    process.stderr.write('fixture: client services ready\n');

    await t.test('filesystem reads, streams, atomic version checks and errors use the real native provider', async () => {
      const target = await ctx.fs.resolve('ordinary.txt', { cwd: root });
      const created = await ctx.fs.writeText(target, '普通 text\n', { kind: 'createIfAbsent' });
      assert.equal(await ctx.fs.readText(target), '普通 text\n');
      assert.equal(Buffer.from(await ctx.fs.readBytes(target, undefined, 100)).toString(), '普通 text\n');
      let streamed = ''; for await (const part of await ctx.fs.streamText(target)) streamed += part;
      assert.equal(streamed, '普通 text\n');
      assert.equal(ctx.fs.processPath(target), join(root, 'ordinary.txt'));
      assert.equal(ctx.fs.contains(await ctx.fs.resolve(root), target), true);
      assert.equal((await ctx.fs.listDir(await ctx.fs.resolve(root))).some(entry => entry.name === 'ordinary.txt'), true);
      await ctx.fs.editText(target, { oldString: 'text', newString: 'edited', replaceAll: false }, { version: created.version });
      await assert.rejects(ctx.fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version: created.version }),
        error => error instanceof fsApi.FsError && error.code === 'FS_STALE_VERSION');
      await assert.rejects(ctx.fs.readBytes(target, undefined, 1), error => error.code === 'FS_TOO_LARGE');
    });

    const spec = script => ({ argv: [process.execPath, '-e', script], cwd: root,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } }, graceMs: 100 });
    await t.test('synchronous spawn returns actual worker child pid and native UTF-8 collector offsets remain readable after done', { skip: fsWorkflowOnly }, async () => {
      const handle = ctx.subprocess.spawn(spec('process.stdout.write(String(process.pid)+" 普通");process.stderr.write("stderr")'));
      assert.ok(handle.pid > 0); assert.notEqual(handle.pid, child.pid);
      assert.equal((await handle.done).exitCode, 0);
      const out = handle.collected.stdout.readFrom(0);
      assert.equal(out.text, `${handle.pid} 普通`);
      assert.equal(out.nextOffset, Buffer.byteLength(out.text));
      assert.equal(handle.collected.stdout.readFrom(out.nextOffset).text, '');
      assert.equal(handle.collected.stderr.readFrom(0).text, 'stderr');
      assert.equal(await handle.waitForExit(), true);
      const tail = ctx.subprocess.spawn({ ...spec('process.stdout.write("普通")'), stdio: { stdin: 'ignore', stdout: { maxBytes: 4 }, stderr: { maxBytes: 4 } } });
      await tail.done; await tail.waitForExit();
      const bytes = Buffer.from('普通');
      assert.deepEqual(tail.collected.stdout.readFrom(0), { text: bytes.subarray(2).toString(), nextOffset: 6, lossy: true });
      assert.deepEqual(tail.collected.stdout.readFrom(3), { text: bytes.subarray(3).toString(), nextOffset: 6, lossy: false });
      assert.equal(ctx.subprocess.live.size, 0, 'remote ownership released after full native tree exit; collected bytes remain local');
    });

    await t.test('native pipe stdin, output streaming and process cancellation retain their contracts', { skip: fsWorkflowOnly }, async () => {
      const piping = ctx.subprocess.spawn({ ...spec('process.stdin.pipe(process.stdout)'), stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } });
      let output = ''; piping.stdout.on('data', chunk => { output += chunk.toString(); }); piping.stderr.resume();
      piping.stdin.end('streamed 普通');
      assert.equal((await piping.done).exitCode, 0); assert.equal(output, 'streamed 普通');
      const cancel = new AbortController();
      const running = ctx.subprocess.spawn({ ...spec('setInterval(()=>{},1000)'), signal: cancel.signal });
      cancel.abort(); await running.done; assert.equal(await running.waitForExit(), true);
    });

    await t.test('ordinary recursive rg and Bash remain executable without transporting native environment secrets', { skip: fsWorkflowOnly }, async () => {
      process.env.FORGE_SYNTHETIC_PRIVATE_TOKEN = 'native-only-sentinel';
      try {
        const echo = ctx.subprocess.spawn(spec('process.stdout.write(process.env.FORGE_SYNTHETIC_PRIVATE_TOKEN??"absent")'));
        await echo.done; assert.equal(echo.collected.stdout.readFrom(0).text, 'absent');
      } finally { delete process.env.FORGE_SYNTHETIC_PRIVATE_TOKEN; }
      const rg = await ctx.subprocess.resolveExecutable('rg');
      const search = ctx.subprocess.spawn({ ...spec(''), argv: [rg, '--files-with-matches', 'edited', root] });
      assert.equal((await search.done).exitCode, 0); assert.match(search.collected.stdout.readFrom(0).text, /ordinary\.txt/);
      const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : await ctx.subprocess.resolveExecutable('bash');
      const shell = ctx.subprocess.spawn({ ...spec(''), argv: [bash, '-c', 'pwd; printf ordinary-bash'] });
      assert.equal((await shell.done).exitCode, 0); assert.match(shell.collected.stdout.readFrom(0).text, /ordinary-bash/);
    });

    await t.test('native terminal output, write and awaited session termination remain available', { skip: fsWorkflowOnly }, async () => {
      const terminal = await ctx.subprocess.spawnTerminal({ argv: [process.execPath, '-e', 'process.stdin.on("data",()=>process.exit(0));process.stdout.write("terminal-ready")'],
        cwd: root, rows: 24, cols: 80, graceMs: 100 });
      let output = '';
      terminal.output.on('data', bytes => { output += bytes.toString(); });
      assert.ok(terminal.pid > 0);
      await terminal.write('input\r');
      await terminal.done; await terminal.terminate();
      assert.match(output, /terminal-ready/);
    });

    await t.test('worker preserves actual sandbox composition and original observed remove/copy implementation', { skip: fsWorkflowOnly }, async () => {
      assert.equal(ctx.fs.sandboxMode, 'workspace-write');
      const { SandboxBashExecutor } = await load('dsh-bash-sandbox');
      await ctx.plugin(SandboxBashExecutor, { cwd: root });
      const result = await ctx.shell.run(ctx.shell.resolve({ command: 'printf sandbox-ordinary', workdir: root }));
      assert.equal(result.exitCode, 0); assert.match(result.stdout.text, /sandbox-ordinary/);
      assert.equal(result.sandbox.mode, 'workspace-write'); assert.equal(result.sandbox.denied, false);
      const inputRoot = join(root, 'inputs'); await mkdir(inputRoot);
      const content = 'synthetic ordinary input\n'; await writeFile(join(inputRoot, 'reference.txt'), content);
      const source = await ctx.fs.resolve(join(inputRoot, 'reference.txt'));
      const sourceVersion = (await ctx.fs.stat(source)).version;
      const events = [];
      const facade = { fs: ctx.fs, sandboxPolicy: ctx.sandboxPolicy,
        waterfall: async (event, target) => event === 'fs/write-intent' ? { kind: 'createIfAbsent' }
          : { version: target.targetKey === source.targetKey ? sourceVersion : (await ctx.fs.stat(target)).version },
        emit: (...event) => events.push(event) };
      const typed = await import('../docker/harness/forge-typed-file-removal.mjs');
      const copied = await typed.copyReferenceFile(facade, { source_path: join(inputRoot, 'reference.txt'), file_path: 'copied.ts',
        source_sha256: createHash('sha256').update(content).digest('hex') }, {}, { workspaceRoot: root, inputRoot });
      assert.equal(copied.copied, true);
      assert.equal(await ctx.fs.readText(await ctx.fs.resolve(join(root, 'copied.ts'))), content);
      const removed = await typed.removeObservedFile(facade, { file_path: 'copied.ts' }, {}, { workspaceRoot: root });
      assert.equal(removed.deleted, true); assert.equal(await ctx.fs.stat(await ctx.fs.resolve(join(root, 'copied.ts'))), undefined);
      assert.deepEqual(events.map(row => row[2].kind), ['present', 'absent']);
    });

    await t.test('fixed native workflow script runs via its actual worker protocol with cancellation and no native token transfer', async () => {
      const init = body => ({ meta: { name: 'fixture-only', description: 'Synthetic interface check' }, body, args: { value: 7 },
        limits: { maxConcurrentAgents: 1, maxTotalAgents: 1, maxItemsPerCall: 4, syncTimeoutMs: 1000 } });
      const execute = body => {
        const worker = new RemoteWorkflowWorker('ignored-fixed-entry', { workerData: init(body), execArgv: [] }, socketPath);
        const messages = []; const result = new Promise((resolve, reject) => {
          worker.on('error', reject);
          worker.on('message', message => { messages.push(message); if (message.type === 'ready') worker.postMessage({ type: 'go' }); if (message.type === 'result') resolve(message); });
        });
        return { worker, messages, result };
      };
      const first = execute('return { value: args.value };');
      const result = await first.result; assert.match(JSON.stringify(result), /"value":7/);
      await first.worker.terminate();
      const second = execute('while (true) {}');
      second.result.catch(() => {});
      await once(second.worker, 'message');
      const code = await second.worker.terminate(); assert.equal(Number.isInteger(code), true);
    });
    await t.test('worker rejects unlisted operations rather than providing privileged native callbacks', async () => {
      await assert.rejects(call(socketPath, { op: 'native.readCredentials', args: [] }), /UNKNOWN_OPERATION/);
    });
  } finally {
    if (ctx) await ctx.fiber.dispose();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); if (child.connected) child.send('close'); else child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('TODO-047 synchronous transport fails within its deadline without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-worker-deadline-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\forge-worker-deadline-${randomUUID()}` : join(root, 'worker.sock');
  let accepted = 0;
  const server = net.createServer(socket => { accepted++; socket.destroy(); });
  try {
    server.listen(socketPath); await once(server, 'listening');
    const start = performance.now();
    // The native event loop is intentionally waiting synchronously; the fixed
    // helper must end even when the transport peer cannot dispatch a reply.
    assert.throws(() => callSync(socketPath, { op: 'fs.capabilities' }, 100));
    assert.ok(performance.now() - start < 1500);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(accepted <= 1, 'one request, no replay');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
