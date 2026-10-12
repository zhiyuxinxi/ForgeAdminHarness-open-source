import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { installControlledReleaseBackground } from '../docker/harness/forge-phase-budget-guard.mjs';

const command = '/usr/local/bin/forge-release release --services forge-admin,forge-ui --version release-fixture';
function fixture() {
  let handler;
  const dispose = installControlledReleaseBackground({ on(name, callback) {
    assert.equal(name, 'tools/execute'); handler = callback;
    return () => { handler = null; };
  } });
  return { run: (exec, next) => handler(exec, next), dispose };
}
const execution = args => ({ name: 'bash', arguments: args, callId: 'release-call',
  agent: { session: { id: 'release-session', header: {} } }, signal: new AbortController().signal });

test('controlled release background dispatch keeps one admitted command and its execution identity', async () => {
  for (const flag of [undefined, false, true]) {
    const args = Object.freeze({ command, description: '发布当前候选', timeoutMs: 30000,
      ...(flag === undefined ? {} : { run_in_background: flag }) });
    const exec = execution(args), agent = exec.agent, signal = exec.signal;
    const f = fixture(); let calls = 0;
    const result = await f.run(exec, async () => {
      calls += 1;
      assert.deepEqual(exec.arguments, { ...args, run_in_background: true });
      assert.equal(exec.agent, agent); assert.equal(exec.signal, signal);
      assert.equal(exec.callId, 'release-call');
      return { kind: 'background', jobId: 'bash-1' };
    });
    assert.deepEqual(result, { kind: 'background', jobId: 'bash-1' });
    assert.equal(calls, 1); assert.equal(args.run_in_background, flag);
    if (flag === true) assert.equal(exec.arguments, args);
    f.dispose();
  }
});

test('controlled release background dispatch leaves other commands and native failures unchanged', async () => {
  const f = fixture();
  for (const cmd of ['forge-release status', 'forge-release diagnose',
    'forge-release release --services invalid', `${command}; echo injected`,
    'forge-release release --services forge-ui --unknown option',
    'forge-release checkpoint --message update', 'forge-verify status --job-id example']) {
    const args = Object.freeze({ command: cmd }); const exec = execution(args);
    await f.run(exec, async () => { assert.equal(exec.arguments, args); });
  }
  const other = { ...execution({ command }), name: 'read' };
  await f.run(other, async () => assert.equal(other.arguments.run_in_background, undefined));
  const failure = new Error('background jobs unavailable'); let calls = 0;
  await assert.rejects(f.run(execution({ command }), async () => { calls += 1; throw failure; }), error => error === failure);
  assert.equal(calls, 1, 'no foreground fallback or retry may resubmit a release');
});

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.FORGE_TEST_NATIVE_RUNTIME || resolve(root, 'tmp/runtime-deps-ci');
const nativeRequire = createRequire(resolve(runtime, 'package.json'));
let nativeBash;
try {
  const entry = nativeRequire.resolve('@deepseek-ai/dsh-tool-bash');
  const pkg = JSON.parse(await readFile(nativeRequire.resolve('@deepseek-ai/dsh-tool-bash/package.json'), 'utf8'));
  assert.equal(pkg.version, '0.1.1-rc.2');
  nativeBash = await import(pathToFileURL(entry).href);
} catch (error) {
  if (process.env.FORGE_TEST_NATIVE_RUNTIME || error.code !== 'MODULE_NOT_FOUND') throw error;
}

test('controlled release background dispatch registers the real native job for the original session', { skip: !nativeBash }, async () => {
  const f = fixture(); let tool, job, starts = 0, finish;
  const done = new Promise(resolveDone => { finish = resolveDone; });
  const proc = { done, status: 'running', exitCode: null, signal: null, kill() {}, readOutput() {} };
  const exec = execution({ command, description: '发布当前候选', timeoutMs: 30000 });
  const env = Object.freeze({ HARNESS_SESSION: 'release-session' });
  nativeBash.apply({
    tools: { register(value) { tool = value; } }, systemPrompt: { section() {} },
    shellEnv: { collect(value) { assert.equal(value, exec); return env; } },
    shell: {
      resolve(spec) { return spec; },
      run() { assert.fail('controlled release must not use the foreground timeout path'); },
      start(spec) { starts += 1; assert.equal(spec.command, command); assert.equal(spec.timeoutMs, 30000);
        assert.equal(spec.dshEnv, env); return proc; },
    },
    get(name) { assert.equal(name, 'jobs'); return { start(spec) { job = spec; return 'bash-1'; } }; },
  });
  const result = await f.run(exec, () => tool.execute(exec.arguments, exec));
  assert.deepEqual(result, { kind: 'background', jobId: 'bash-1' });
  assert.equal(job.owner, exec.agent); assert.equal(job.label, command); assert.equal(job.kind, 'bash');
  const observation = job.run();
  assert.equal(starts, 1);
  let collected = false;
  const terminal = observation.done.then(result => { collected = true; return result; });
  await Promise.resolve(); assert.equal(collected, false, 'registration does not manufacture completion');
  proc.status = 'completed'; proc.exitCode = 0; finish();
  assert.deepEqual(await terminal, { status: 'completed', detail: 'exit code: 0' });
  assert.equal(starts, 1);
});
