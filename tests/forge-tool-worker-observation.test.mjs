import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createToolWorkerProviders } from '../docker/harness/forge-tool-worker-provider.mjs';

test('TODO-047 typed worker observations retain provider processPath and fileUrl after copy and removal', { timeout: 10000 }, async () => {
  const runtime = resolve(process.env.FORGE_NATIVE_TEST_RUNTIME ?? '../ForgeAdminHarness/tmp/runtime-deps-ci');
  const require = createRequire(join(runtime, 'package.json'));
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
  const root = await mkdtemp(join(tmpdir(), 'forge-worker-observation-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\forge-observation-${randomUUID()}` : join(root, 'worker.sock');
  const child = fork(fileURLToPath(new URL('./fixtures/forge-tool-worker-host.mjs', import.meta.url)), [runtime, socketPath, root, 'all'], {
    env: { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let ctx, stderr = ''; child.stderr.on('data', data => { stderr += data; });
  try {
    await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
    const [{ Context }, fsApi, subprocessApi, sandboxApi, { SandboxPolicyService }, typed] = await Promise.all([
      load('cordis'), load('dsh-fs'), load('dsh-subprocess'), load('dsh-sandbox'), load('dsh-sandbox-policy'),
      import('../docker/harness/forge-typed-file-removal.mjs'),
    ]);
    const { ToolWorkerFileSystem } = createToolWorkerProviders({ ...fsApi, ...subprocessApi, ...sandboxApi }, { socketPath });
    ctx = new Context(); await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root });
    await ctx.plugin(ToolWorkerFileSystem);
    const inputRoot = join(root, 'inputs'); await mkdir(inputRoot);
    const text = 'public synthetic reference'; await writeFile(join(inputRoot, 'reference.txt'), text);
    const events = [];
    const facade = { fs: ctx.fs, sandboxPolicy: ctx.sandboxPolicy,
      waterfall: async (event, target) => event === 'fs/write-intent' ? { kind: 'createIfAbsent' } : { version: (await ctx.fs.stat(target)).version },
      emit: (...event) => events.push(event) };
    await typed.copyReferenceFile(facade, { source_path: join(inputRoot, 'reference.txt'), file_path: 'ordinary.ts',
      source_sha256: createHash('sha256').update(text).digest('hex') }, {}, { workspaceRoot: root, inputRoot });
    await typed.removeObservedFile(facade, { file_path: 'ordinary.ts' }, {}, { workspaceRoot: root });
    assert.deepEqual(events.map(row => row[2].kind), ['present', 'absent']);
    for (const [, target] of events) {
      assert.equal(ctx.fs.processPath(target), join(root, 'ordinary.ts'));
      assert.equal(ctx.fs.fileUrl(target), pathToFileURL(join(root, 'ordinary.ts')).href);
    }
  } finally {
    if (ctx) await ctx.fiber.dispose();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); if (child.connected) child.send('close'); else child.kill(); await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
