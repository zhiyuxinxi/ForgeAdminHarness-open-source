import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationMessageQueue } from '../docker/harness/conversation-message-queue.mjs';

const body = (id, sessionId = 'a', text = id) => ({ type: 'client-request', rpcId: id, method: 'session.prompt',
  payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] } });

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'conversation-message-queue-'));
  const statePath = path.join(directory, 'queue', 'state.json');
  const calls = [], observations = new Map(), live = { allowed: false, busy: false, result: { status: 'accepted' } };
  let queue;
  const make = async () => {
    queue = createConversationMessageQueue({ statePath, pollMs: 60_000,
      canDispatch: () => live.allowed,
      observe: async entry => entry ? (observations.get(entry.id) ?? { busy: true, evidence: { accepted: true } }) : { busy: live.busy },
      dispatch: async entry => { calls.push(entry); return typeof live.result === 'function' ? live.result(entry) : live.result; },
    });
    await queue.ready;
    return queue;
  };
  await make();
  t.after(async () => { await queue.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, statePath, live, calls, observations, get queue() { return queue; },
    add: (id, sessionId = 'a', text = id) => queue.enqueue({ id, sessionId, body: body(id, sessionId, text) }),
    async restart() { await queue.close(); return make(); },
    async terminal(id, terminal = 'completed') { observations.set(id, { busy: false, evidence: { accepted: true, terminal } }); await queue.tick(); },
  };
}

test('concurrent submissions receive one durable workpod FIFO across sessions', async t => {
  const f = await fixture(t);
  const submitted = await Promise.all([f.add('a1'), f.add('a2'), f.add('b1', 'b'), f.add('a3'), f.add('b2', 'b')]);
  assert.deepEqual(submitted.map(item => item.sequence), [1, 2, 3, 4, 5]);
  const persisted = JSON.parse(await readFile(f.statePath, 'utf8'));
  assert.equal(persisted.entries.length, 5, 'successful enqueue means persistence has completed');
  await f.queue.tick(); f.live.allowed = true;
  for (const id of ['a1', 'a2', 'b1', 'a3', 'b2']) {
    await f.queue.tick();
    assert.equal(f.calls.at(-1).id, id);
    await f.terminal(id);
  }
  assert.deepEqual(f.calls.map(item => item.id), ['a1', 'a2', 'b1', 'a3', 'b2']);
  assert.ok((await f.queue.list()).items.every(item => item.status === 'completed'));
});

test('enqueue remains available while preparation is awaiting native acceptance', async t => {
  const f = await fixture(t);
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  f.live.result = () => { began(); return new Promise(resolve => { release = resolve; }); };
  await f.add('a1'); await f.queue.tick(); f.live.allowed = true;
  const running = f.queue.tick(); await started;
  await Promise.all([f.add('a2'), f.add('a3'), f.add('a4'), f.add('b1', 'b')]);
  assert.equal((await f.queue.list()).items.length, 5);
  assert.equal(f.calls.length, 1);
  release({ status: 'accepted' }); await running;
  assert.equal((await f.queue.list()).items[0].status, 'running');
});

test('restart preserves messages, order and idempotent body binding; list excludes full body', async t => {
  const f = await fixture(t);
  const first = await f.add('a1', 'a', 'x'.repeat(300));
  await f.add('b1', 'b'); await f.restart();
  assert.equal((await f.add('a1', 'a', 'x'.repeat(300))).sequence, first.sequence);
  await assert.rejects(f.add('a1', 'a', 'different'), { code: 'QUEUE_ID_CONFLICT' });
  await assert.rejects(f.add('a1', 'b', 'x'.repeat(300)), { code: 'QUEUE_ID_CONFLICT' });
  const listing = await f.queue.list();
  assert.deepEqual(listing.items.map(item => item.sequence), [1, 2]);
  assert.equal(listing.items[0].preview.length, 240);
  assert.equal('body' in listing.items[0], false);
  assert.equal('digest' in listing.items[0], false);
});

test('cancel only affects waiting messages and persists without dispatching them', async t => {
  const f = await fixture(t);
  await f.add('a1'); await f.add('a2'); await f.add('b1', 'b');
  await f.queue.cancel('a2'); await f.restart(); await f.queue.tick(); f.live.allowed = true;
  await f.queue.tick();
  await assert.rejects(f.queue.cancel('a1'), { code: 'QUEUE_NOT_CANCELLABLE' });
  await f.terminal('a1'); await f.queue.tick();
  assert.deepEqual(f.calls.map(item => item.id), ['a1', 'b1']);
  assert.equal((await f.queue.list()).items[1].status, 'cancelled');
});

test('failure pauses only its session; resume retains order and never retries the failed message', async t => {
  const f = await fixture(t);
  await f.add('a1'); await f.add('a2'); await f.add('b1', 'b'); await f.add('a3');
  await f.queue.tick(); f.live.allowed = true; await f.queue.tick(); await f.terminal('a1', 'failed');
  assert.deepEqual((await f.queue.list()).items.map(item => item.status), ['failed', 'paused', 'queued', 'paused']);
  assert.equal((await f.add('a4')).status, 'paused');
  await f.queue.tick(); assert.equal(f.calls.at(-1).id, 'b1');
  await f.terminal('b1'); await f.queue.resume('a');
  for (const id of ['a2', 'a3', 'a4']) { await f.queue.tick(); assert.equal(f.calls.at(-1).id, id); await f.terminal(id); }
  assert.deepEqual(f.calls.map(item => item.id), ['a1', 'b1', 'a2', 'a3', 'a4']);
});

test('explicit busy is retryable; unknown acceptance blocks every session until positive native evidence', async t => {
  const f = await fixture(t);
  await f.add('a1'); await f.add('b1', 'b');
  await f.queue.tick(); f.live.result = { status: 'busy' }; f.live.allowed = true; await f.queue.tick();
  assert.equal((await f.queue.list()).items[0].status, 'queued');
  f.live.result = () => { throw new Error('transport disconnected with private credentials'); };
  f.observations.set('a1', { busy: false, evidence: { accepted: false } });
  await f.queue.tick();
  assert.equal((await f.queue.list()).blocked.status, 'uncertain');
  for (let i = 0; i < 3; i++) await f.queue.tick();
  await f.restart(); await f.queue.tick();
  assert.equal(f.calls.length, 2, 'an unknown request is never replayed even when session appears idle');
  assert.equal((await readFile(f.statePath, 'utf8')).includes('private credentials'), false);
  await f.terminal('a1'); f.live.result = { status: 'accepted' }; await f.queue.tick();
  assert.equal(f.calls.at(-1).id, 'b1');
});

test('restart observes running and interrupted preparing requests by their original rpcId', async t => {
  const f = await fixture(t);
  await f.add('a1'); await f.add('b1', 'b');
  await f.queue.tick(); f.live.allowed = true; await f.queue.tick(); await f.restart();
  await f.queue.tick(); assert.equal(f.calls.length, 1);
  assert.equal((await f.queue.list()).items[0].status, 'running');
  await f.queue.close();
  const state = JSON.parse(await readFile(f.statePath, 'utf8'));
  state.entries[0].status = 'preparing'; await writeFile(f.statePath, JSON.stringify(state));
  f.observations.set('a1', { busy: false }); await f.restart();
  assert.equal((await f.queue.list()).items[0].status, 'uncertain');
  await f.queue.tick(); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.rpcId, 'a1');
  await f.terminal('a1'); await f.queue.tick(); assert.equal(f.calls.at(-1).id, 'b1');
});

test('explicit preparation failure pauses following commands, and maintenance gate prevents dispatch', async t => {
  const f = await fixture(t);
  await f.add('a1'); await f.add('a2'); await f.queue.tick();
  assert.equal(f.calls.length, 0);
  f.live.allowed = true; f.live.busy = true; await f.queue.tick(); assert.equal(f.calls.length, 0);
  f.live.busy = false; f.live.result = { status: 'failed' }; await f.queue.tick();
  assert.deepEqual((await f.queue.list()).items.map(item => item.status), ['failed', 'paused']);
  await f.queue.cancel('a2'); assert.equal((await f.queue.list()).items[1].status, 'cancelled');
});

test('queue stores no authentication fields, rejects symlink files and uses private modes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.queue.enqueue({ id: 'secret', sessionId: 'a', body: { ...body('secret'), headers: { authorization: 'Bearer SECRET' } } }), { code: 'QUEUE_SECRET_NOT_ALLOWED' });
  await f.add('a1');
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.statePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(f.statePath))).mode & 0o777, 0o700);
  }
  await f.queue.close();
  await rm(f.statePath);
  const target = path.join(f.directory, 'target.json'); await writeFile(target, '{}');
  try { await symlink(target, f.statePath); } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') { t.diagnostic('Windows account cannot create symlinks; Linux symlink assertion requires runtime verification.'); return; }
    throw error;
  }
  const unsafe = createConversationMessageQueue({ statePath: f.statePath, observe: async () => ({ busy: false }), dispatch: async () => ({ status: 'accepted' }) });
  await assert.rejects(unsafe.ready, { code: 'QUEUE_UNSAFE_PATH' });
  assert.equal(await readFile(target, 'utf8'), '{}');
});
