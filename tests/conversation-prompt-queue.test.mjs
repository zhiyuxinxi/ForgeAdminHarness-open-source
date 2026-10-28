import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../docker/harness/conversation-prompt-queue.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const payload = (sessionId, text) => ({ sessionId, content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' });

function fixture(shared = { items: [], pausedSessions: [] }) {
  const calls = [], timers = new Map(), states = [];
  let timerId = 0;
  const controls = {};
  const window = { fetch: async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body });
    if (init.signal.aborted) throw init.signal.reason;
    if (controls.reject) return { ok: false, status: 403, json: async () => ({ ok: false, message: '当前账号无权操作此工作舱。' }) };
    if (controls.hang) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    if (path.endsWith('/cancel')) {
      if (controls.cancelFail) return { ok: false, status: 409, json: async () => ({ ok: false, message: '消息已开始执行，不能取消排队。' }) };
      shared.items.find(item => item.id === body.id).status = 'cancelled';
    } else if (path.endsWith('/resume')) {
      shared.pausedSessions = shared.pausedSessions.filter(id => id !== body.sessionId);
    } else if (body) {
      let item = shared.items.find(item => item.id === body.id);
      if (!item) { item = { id: body.id, sessionId: body.sessionId, sequence: shared.items.length + 1, status: 'queued', preview: body.content[0].text }; shared.items.push(item); }
      if (controls.loseResponse) throw new Error('connection lost after save');
      return { ok: true, status: 202, json: async () => ({ ok: true, queued: true, item: structuredClone(item) }) };
    }
    if (!body && controls.listFail) throw new Error('队列查询暂时不可用');
    return { ok: true, status: 200, json: async () => ({ ok: true, ...structuredClone(shared) }) };
  } };
  vm.runInNewContext(source, { window, DOMException, AbortController, crypto: { randomUUID },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id) });
  return { window, shared, controls, calls, timers, states,
    send: (id, text, signal) => window.__forgeEnqueuePrompt(payload(id, text), signal),
    subscribe(id = 'A') { return window.__forgeSubscribePromptQueue(id, state => states.push(state)); },
    advance(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
  };
}

test('A can submit A1 to A4 and B can submit multiple messages without waiting for execution', async () => {
  const f = fixture();
  const receipts = [];
  for (const [id, text] of [['A','A1'], ['A','A2'], ['B','B1'], ['A','A3'], ['A','A4'], ['B','B2']]) receipts.push(await f.send(id, text));
  assert.deepEqual(receipts.map(x => x.sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(f.shared.items.map(x => x.preview), ['A1', 'A2', 'B1', 'A3', 'A4', 'B2']);
  assert(f.shared.items.every(x => x.status === 'queued'), 'no model completion is required for another submission');
  assert(f.calls.every(x => x.path === '/forge-prompt-queue'), 'no native prompt, prepare, or session.list is dispatched by the browser');
  assert(receipts.every(x => !('accepted' in x) && !('result' in x)), 'queue admission never fabricates native accepted results');
});

test('a recreated browser reads the server queue and cancellation does not call session.stop', async () => {
  const first = fixture();
  const item = await first.send('A', '保留到刷新以后');
  const reopened = fixture(first.shared);
  const unsubscribe = reopened.subscribe();
  await tick();
  assert.equal(reopened.states.at(-1).items[0].id, item.id);
  await reopened.states.at(-1).cancel(item.id);
  assert.equal(reopened.states.at(-1).items[0].status, 'cancelled');
  assert(!reopened.calls.some(x => x.path.includes('session.stop')));
  unsubscribe();
  assert.equal(reopened.timers.size, 0);
});

test('lost admission response reconciles the same request without resubmitting', async () => {
  const f = fixture();
  f.controls.loseResponse = true;
  const item = await f.send('A', '只保存一次');
  assert.equal(item.status, 'queued');
  assert.equal(f.shared.items.length, 1);
  assert.equal(f.calls.filter(x => x.body).length, 1);
});

test('unknown admission keeps a stable identity for the same draft retry', async () => {
  const f = fixture();
  f.controls.loseResponse = true; f.controls.listFail = true;
  await assert.rejects(f.send('A', '结果未知的原消息'), /暂未确认.*输入已保留/);
  f.controls.loseResponse = false; f.controls.listFail = false;
  await f.send('A', '结果未知的原消息');
  const posts = f.calls.filter(x => x.body);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.id, posts[1].body.id);
  assert.equal(f.shared.items.length, 1);
});

test('explicit refusal keeps input available and does not fall through to native prompt', async () => {
  const f = fixture(); f.controls.reject = true;
  await assert.rejects(f.send('A', '无权限的请求'), /无权/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.shared.items.length, 0);
  f.controls.reject = false;
  await f.send('A', '无权限的请求');
  assert.notEqual(f.calls[0].body.id, f.calls[1].body.id, 'a definite refusal can start a fresh request');
});

test('paused messages remain visible until explicit resume and mutation failure stays visible', async () => {
  const f = fixture();
  const item = await f.send('A', '后续消息');
  f.shared.pausedSessions.push('A');
  const unsubscribe = f.subscribe();
  await tick();
  assert.deepEqual([...f.states.at(-1).pausedSessions], ['A']);
  f.controls.cancelFail = true;
  await f.states.at(-1).cancel(item.id);
  assert.match(f.states.at(-1).actionError, /不能取消/);
  await f.states.at(-1).resume('A');
  assert.deepEqual([...f.states.at(-1).pausedSessions], []);
  assert.equal(f.states.at(-1).items.length, 1);
  unsubscribe();
});

test('a failed refresh retains the saved queue and recovers on the next successful read', async () => {
  const f = fixture(); await f.send('A', '不会因查询失败消失');
  const unsubscribe = f.subscribe(); await tick();
  f.controls.listFail = true;
  f.advance(2000); await tick();
  assert.equal(f.states.at(-1).items.length, 1);
  assert.match(f.states.at(-1).error, /暂时不可用/);
  f.controls.listFail = false;
  await f.states.at(-1).refresh();
  assert.equal(f.states.at(-1).error, '');
  unsubscribe();
});

test('an unresponsive queue read is bounded and never dispatches model work', async () => {
  const f = fixture(); f.controls.hang = true;
  const unsubscribe = f.subscribe(); await tick(); f.advance(15000); await tick();
  assert.match(f.states.at(-1).error, /超时/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body, undefined);
  unsubscribe();
});
