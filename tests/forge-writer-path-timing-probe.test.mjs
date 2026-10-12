import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installForgeWriterPathTimingProbe } from '../scripts/acceptance/forge-writer-path-timing-probe.mjs';
import { installForgeWriterScopeLease } from '../docker/harness/forge-writer-scope-client.mjs';

const NONCE = '17'.repeat(16);
const FILE = 'code-copilot/changes/路径 @例/spec.md';
const SESSION = 'session-timing-test';
const PERMIT = 'b8d759fa-76ee-4a05-9d66-02bb38243e43';
const execution = (overrides = {}) => ({ name: 'write', callId: 'call-a',
  agent: { session: { id: SESSION } }, arguments: { file_path: `/workspace/${FILE}`, content: 'native input' },
  signal: new AbortController().signal, ...overrides });

async function fixture(t, { timeoutMs = 2000, body = async () => ({ native: true }), lease = false, probeFirst = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-writer-timing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseDirectory = path.join(root, 'release');
  const arrivedDirectory = path.join(root, 'arrived');
  await mkdir(releaseDirectory); await mkdir(arrivedDirectory);
  const config = { schemaVersion: 1, testOnly: true, dshSessionId: SESSION, toolName: 'write',
    filePath: FILE, nonce: NONCE, timeoutMs, releaseDirectory, arrivedDirectory };
  const events = [];
  const handlers = [];
  const tool = { execute: async function (args, exec) {
    events.push(`body:${exec.callId}`); return body.call(this, args, exec);
  } };
  const original = tool.execute;
  const ctx = { tools: { get: () => tool }, on(event, handler) {
    assert.equal(event, 'tools/execute'); handlers.push(handler);
    return () => { const index = handlers.indexOf(handler); if (index !== -1) handlers.splice(index, 1); };
  } };
  const installLease = () => installForgeWriterScopeLease(ctx, {
    resolveContext: () => ({ projectSlug: 'timing-project', taskId: 'task-a', actorUserId: '2ff962d2-92f4-4a94-a25c-6ff1e11496e2',
      conversationId: 'conversation-a', dshSessionId: SESSION, rpcId: 'rpc-a', textDigest: 'a'.repeat(64),
      executionId: 'execution-a', generation: 1, contractId: 'b'.repeat(64),
      contract: { contractId: 'b'.repeat(64), ownedPaths: [FILE] } }),
    client: async (operation, { context, exec, filePath, permit }) => {
      events.push(operation);
      return operation === 'acquire' ? { schemaVersion: 1, status: 'acquired', permitId: PERMIT,
        executionId: context.executionId, generation: context.generation, contractId: context.contractId,
        callId: exec.callId, toolName: exec.name, filePath, ownedPaths: [FILE], expiresAt: new Date(Date.now() + 60_000).toISOString() }
        : { schemaVersion: 1, status: 'settled', permitId: permit.permitId, callId: exec.callId };
    },
  });
  if (lease && !probeFirst) installLease();
  const dispose = await installForgeWriterPathTimingProbe(ctx, config);
  t.after(dispose);
  if (lease && probeFirst) installLease();
  const invoke = exec => {
    const dispatch = index => index < handlers.length ? handlers[index](exec, () => dispatch(index + 1))
      : tool.execute(exec.arguments, exec);
    return dispatch(0);
  };
  const arrival = async () => {
    const filename = path.join(arrivedDirectory, `${NONCE}.json`);
    const deadline = Date.now() + 2000;
    for (;;) {
      try { return JSON.parse(await readFile(filename, 'utf8')); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (Date.now() >= deadline) assert.fail('probe did not arrive');
      await delay(2);
    }
  };
  const release = async (arrived, overrides = {}) => {
    const final = path.join(releaseDirectory, `${NONCE}.json`);
    await writeFile(`${final}.pending`, JSON.stringify({
      schemaVersion: 1, operation: 'release', ...Object.fromEntries(['nonce', 'callId', 'dshSessionId', 'toolName', 'filePath'].map(key => [key, arrived[key]])),
      ...overrides,
    }), { flag: 'wx' });
    await rename(`${final}.pending`, final);
  };
  return { root, config, ctx, events, tool, original, invoke, arrival, release };
}

for (const probeFirst of [true, false]) {
  test(`native body waits inside the actual lease in both hook orders (probeFirst=${probeFirst})`, async t => {
    const result = { native: ['unchanged'] };
    const f = await fixture(t, { lease: true, probeFirst, body: async () => result });
    const exec = execution();
    const running = f.invoke(exec);
    const arrived = await f.arrival();
    assert.equal(arrived.status, 'native-execute-waiting');
    assert.equal(arrived.callId, exec.callId); assert.equal(arrived.dshSessionId, SESSION);
    assert.equal(arrived.filePath, FILE); assert.equal(arrived.nonce, NONCE);
    assert.equal(Object.hasOwn(arrived, 'content'), false);
    f.events.push('wait');
    assert.deepEqual(f.events, ['acquire', 'wait']);
    await f.release(arrived);
    assert.equal(await running, result);
    assert.deepEqual(f.events, ['acquire', 'wait', 'body:call-a', 'settle']);
    assert.equal(f.tool.execute, f.original);
    assert.equal(exec.arguments.file_path, `/workspace/${FILE}`);
    // A consumed probe must not delay another real execution or replay the first.
    assert.equal(await f.invoke(execution({ callId: 'call-b' })), result);
    assert.equal(f.events.filter(event => event === 'body:call-a').length, 1);
  });
}

test('an original body error is preserved and the actual lease still settles', async t => {
  const expected = new Error('native disk error');
  const f = await fixture(t, { lease: true, body: async () => { throw expected; } });
  const rejection = assert.rejects(f.invoke(execution()), error => error === expected);
  await f.release(await f.arrival()); await rejection;
  assert.deepEqual(f.events, ['acquire', 'body:call-a', 'settle']);
  assert.equal(f.tool.execute, f.original);
});

test('abort while waiting skips the body, restores execute, and settles the lease', async t => {
  const f = await fixture(t, { lease: true });
  const controller = new AbortController();
  const expected = new Error('operator cancellation');
  const rejection = assert.rejects(f.invoke(execution({ signal: controller.signal })), error => error === expected);
  await f.arrival(); controller.abort(expected); await rejection;
  assert.deepEqual(f.events, ['acquire', 'settle']);
  assert.equal(f.tool.execute, f.original);
});

test('bounded timeout skips the body, restores execute, and settles the lease', async t => {
  const f = await fixture(t, { lease: true, probeFirst: false, timeoutMs: 50 });
  await assert.rejects(f.invoke(execution()), { code: 'WRITER_TIMING_TIMEOUT' });
  assert.deepEqual(f.events, ['acquire', 'settle']);
  assert.equal(f.tool.execute, f.original);
});

test('a wrong release identity cannot enter the original body', async t => {
  const f = await fixture(t, { lease: true });
  const rejection = assert.rejects(f.invoke(execution()), { code: 'WRITER_TIMING_RELEASE_MISMATCH' });
  await f.release(await f.arrival(), { callId: 'another-call' }); await rejection;
  assert.deepEqual(f.events, ['acquire', 'settle']);
  assert.equal(f.tool.execute, f.original);
});

test('non-target calls and distinct executions through the wrapped definition pass through unchanged', async t => {
  const f = await fixture(t);
  for (const exec of [execution({ name: 'read' }), execution({ agent: { session: { id: 'other-session' } } }),
    execution({ arguments: { file_path: 'another.md' } })]) {
    assert.deepEqual(await f.invoke(exec), { native: true });
    assert.equal(f.tool.execute, f.original);
  }
  f.events.length = 0;
  const exec = execution();
  const running = f.invoke(exec);
  const arrived = await f.arrival();
  // Even equal call/session values on a different object must not reuse this wait.
  assert.deepEqual(await f.tool.execute(exec.arguments, { ...exec }), { native: true });
  assert.deepEqual(await f.tool.execute(exec.arguments, execution({ callId: 'different-call' })), { native: true });
  assert.deepEqual(await f.tool.execute(exec.arguments, execution({ agent: { session: { id: 'other-session' } } })), { native: true });
  await f.release(arrived); await running;
  assert.equal(f.tool.execute, f.original);
  assert.equal(f.events.length, 4);
});

test('control configuration rejects workspace paths, channel overlap, traversal and extra fields', async t => {
  const f = await fixture(t);
  for (const patch of [{ arrivedDirectory: '/workspace/probe' }, { releaseDirectory: f.config.arrivedDirectory },
    { filePath: '../escape' }, { nonce: '../escape' }, { testOnly: false }, { timeoutMs: 0 }, { arbitrary: true }]) {
    await assert.rejects(installForgeWriterPathTimingProbe(f.ctx, { ...f.config, ...patch }), error => /^WRITER_TIMING_/u.test(error.code));
  }
});
