import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHarnessProxy } from '../docker/harness/tcp-proxy.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 160; i++) { if (await check()) return; await delay(15); } assert.fail('Queue did not reach expected state'); }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-message-queue-runtime-'));
  const fence = path.join(root, 'fence.json');
  await writeFile(fence, JSON.stringify({ schemaVersion: 1, state: 'committed', epoch: 'test' }));
  const statePath = path.join(root, 'queue', 'state.json');
  const state = new Map(['session-a', 'session-b'].map(id => [id, { running: false, events: [], seq: 0 }]));
  const dispatched = [], prepared = [];
  let refuseCookie = false, loseNextResponse = false;
  const native = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks)); let value;
    if (rpc.method === 'session.list') value = { items: [...state].map(([sessionId, s]) => ({ sessionId, running: s.running })) };
    else if (rpc.method === 'session.history') {
      const events = state.get(rpc.payload.sessionId).events.filter(event => rpc.payload.beforeSeq === undefined || event.seq < rpc.payload.beforeSeq);
      value = { events: events.slice(-50).map(event => ({ event })), hasMore: events.length > 50 };
    }
    else if (rpc.method === 'session.prompt') {
      assert.equal(request.headers.cookie, undefined);
      const s = state.get(rpc.payload.sessionId); assert.equal([...state.values()].some(x => x.running), false);
      s.running = true; dispatched.push(rpc);
      s.events.push({ type: 'turn/start', seq: ++s.seq, data: { turn: dispatched.length } });
      s.events.push({ type: 'user/message', seq: ++s.seq, data: { source: { kind: 'user', rpcId: rpc.rpcId } } });
      value = { accepted: true };
      if (loseNextResponse) { loseNextResponse = false; request.socket.destroy(); return; }
    } else throw new Error(`Unexpected native method ${rpc.method}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'server-response', rpcId: rpc.rpcId, result: { ok: true, value } }));
  });
  const targetPort = await listen(native);
  const authorizer = { url: 'http://auth.invalid/internal/taskspace-authorize', projectSlug: 'forge-base', taskspaceId: 'c-test',
    async fetchImpl(url, options) {
      if (String(url).includes('execution-prepare')) {
        const input = JSON.parse(options.body); prepared.push(input);
        return new Response(JSON.stringify({ ok: true, execution: { ...input, generation: 1 } }), { status: 200 });
      }
      return new Response(null, { status: refuseCookie ? 401 : 204 });
    } };
  let proxy, port;
  const start = async () => {
    proxy = createHarnessProxy({ targetHost: '127.0.0.1', targetPort, trustedAuthority: 'workpod.test:20801',
      privilegedApiMode: 'trusted-host', accessAuthorizer: authorizer, maintenanceFencePath: fence,
      promptQueueStatePath: statePath, promptQueuePollMs: 15 });
    port = await listen(proxy);
  };
  await start();
  const api = (route = '', body, cookie = 'test-login-proof') => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const request = http.request({ host: '127.0.0.1', port, path: `/forge-prompt-queue${route}`,
      method: data === null ? 'GET' : 'POST', headers: { host: 'workpod.test:20801', origin: 'http://workpod.test:20801', cookie,
        ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) } }, response => {
      const chunks = []; response.on('data', c => chunks.push(c)); response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); resolve({ status: response.statusCode, body: raw.startsWith('{') ? JSON.parse(raw) : raw });
      });
    }); request.on('error', reject); request.end(data);
  });
  const finish = (id, reason = 'completed') => { const s = state.get(id); s.events.push({ type: 'turn/end', seq: ++s.seq, data: { reason: { kind: reason } } }); s.running = false; };
  t.after(async () => { await new Promise(resolve => proxy.close(resolve)); await new Promise(resolve => native.close(resolve)); await rm(root, { force: true, recursive: true }); });
  return { api, statePath, state, dispatched, prepared, finish, setRefuse(v) { refuseCookie = v; }, loseResponse() { loseNextResponse = true; },
    fill(id, count) { const s = state.get(id); for (let i = 0; i < count; i++) s.events.push({ type: 'assistant/message', seq: ++s.seq, data: {} }); },
    async restart() { await new Promise(resolve => proxy.close(resolve)); await delay(50); await start(); } };
}
const input = (sessionId, text) => ({ id: randomUUID(), sessionId, content: [{ type: 'text', text }] });

test('two conversations admit multiple messages promptly, persist them and prepare only at dispatch', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const a1 = input('session-a', 'A1'); assert.equal((await f.api('', a1)).status, 202);
  await until(() => f.dispatched.length === 1);
  const pending = [input('session-a', 'A2'), input('session-a', 'A3'), input('session-b', 'B1'), input('session-b', 'B2'), input('session-a', 'A4')];
  for (const message of pending) assert.equal((await f.api('', message)).body.queued, true);
  assert.equal(f.prepared.length, 1);
  const snapshot = await f.api(); assert.equal(snapshot.body.items.length, 6);
  assert.deepEqual(snapshot.body.items.map(x => x.id), [a1, ...pending].map(x => x.id));
  const stored = await readFile(f.statePath, 'utf8'); assert.ok(!stored.includes('test-login-proof'));
  assert.equal((await f.api('', pending[0])).body.item.id, pending[0].id);
  assert.equal((await f.api()).body.items.length, 6);
  f.finish('session-a');
  for (let i = 0; i < pending.length; i++) {
    await until(() => f.dispatched.length === i + 2);
    assert.equal(f.dispatched[i + 1].rpcId, pending[i].id);
    f.finish(pending[i].sessionId);
  }
  await until(async () => (await f.api()).body.items.every(x => x.status === 'completed'));
  assert.equal(f.prepared.length, 6);
});

test('unknown native response reconciles original identity without resend; restart retains queued content', { timeout: 10000 }, async t => {
  const f = await fixture(t); f.loseResponse();
  const a = input('session-a', 'Only once'); const b = input('session-b', 'After restart');
  await f.api('', a); await until(() => f.dispatched.length === 1); await f.api('', b);
  await until(async () => (await f.api()).body.items[0].status === 'running');
  await f.restart();
  const snapshot = await f.api(); assert.equal(snapshot.body.items.length, 2);
  f.finish('session-a'); await until(() => f.dispatched.length === 2); f.finish('session-b');
  await until(async () => (await f.api()).body.items.every(x => x.status === 'completed'));
  assert.deepEqual(f.dispatched.map(x => x.rpcId), [a.id, b.id]);
});

test('failure pauses only following messages in its conversation; cancellation never reaches native', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const [a1, a2, b1, b2] = [input('session-a', 'A1'), input('session-a', 'A2'), input('session-b', 'B1'), input('session-b', 'B2')];
  await f.api('', a1); await until(() => f.dispatched.length === 1);
  for (const x of [a2, b1, b2]) await f.api('', x);
  assert.equal((await f.api('/cancel', { id: b2.id })).status, 200);
  f.finish('session-a', 'error'); await until(() => f.dispatched.length === 2);
  assert.equal(f.dispatched[1].rpcId, b1.id);
  const snapshot = (await f.api()).body; assert.ok(snapshot.pausedSessions.includes('session-a'));
  f.finish('session-b'); await f.api('/resume', { sessionId: 'session-a' });
  await until(() => f.dispatched.length === 3); assert.equal(f.dispatched[2].rpcId, a2.id);
  f.finish('session-a');
});

test('long native turns advance the history cursor and native aborted maps to cancelled', { timeout: 10000 }, async t => {
  const f = await fixture(t); const a = input('session-a', 'Long turn'), b = input('session-b', 'Next turn');
  await f.api('', a); await until(() => f.dispatched.length === 1); await f.api('', b);
  f.fill('session-a', 650); f.finish('session-a');
  await until(() => f.dispatched.length === 2);
  assert.equal((await f.api()).body.items[0].status, 'completed');
  f.finish('session-b', 'aborted');
  await until(async () => (await f.api()).body.items[1].status === 'cancelled');
});

test('stopped accepted turn without turn/end releases the workpod while its conversation stays paused', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const a = input('session-a', 'A'), a2 = input('session-a', 'Keep paused'), b = input('session-b', 'B');
  await f.api('', a); await until(() => f.dispatched.length === 1);
  await f.api('', a2); await f.api('', b);
  const nativeA = f.state.get('session-a');
  nativeA.events.push({ type: 'step/end', seq: ++nativeA.seq, data: {} });
  nativeA.running = false;
  await until(() => f.dispatched.length === 2);
  assert.deepEqual(f.dispatched.map(x => x.rpcId), [a.id, b.id]);
  const snapshot = (await f.api()).body;
  assert.deepEqual(snapshot.items.map(x => x.status), ['cancelled', 'paused', 'running']);
  assert.ok(snapshot.pausedSessions.includes('session-a'));
  assert.equal(nativeA.running, false);
  assert.equal(nativeA.events.some(x => x.type === 'turn/end'), false, 'reconciliation preserves the original missing receipt');
  f.finish('session-b');
  await until(async () => (await f.api()).body.items[2].status === 'completed');
  await f.restart();
  assert.deepEqual((await f.api()).body.items.map(x => x.status), ['cancelled', 'paused', 'completed']);
  assert.deepEqual(f.dispatched.map(x => x.rpcId), [a.id, b.id], 'restart must not resume A or resend B');
});

test('idle native state without the original request identity cannot release an active queue item', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const a = input('session-a', 'A'), b = input('session-b', 'B');
  await f.api('', a); await until(() => f.dispatched.length === 1);
  await f.api('', b);
  const nativeA = f.state.get('session-a');
  nativeA.running = false;
  nativeA.events = [];
  await f.restart();
  const snapshot = (await f.api()).body;
  assert.deepEqual(snapshot.items.map(x => x.status), ['running', 'queued']);
  await delay(100);
  assert.equal(f.dispatched.length, 1);
  assert.deepEqual((await f.api()).body.items.map(x => x.status), ['running', 'queued']);
});
