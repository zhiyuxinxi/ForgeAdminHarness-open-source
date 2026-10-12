import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../docker/harness/conversation-prompt-queue.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const calls = [];
  const timers = new Map();
  let id = 0;
  let transportStarts = 0;
  const value = { running: true, source: 'initial', fail: false };
  const window = { fetch: async (input, init) => {
    const body = JSON.parse(init?.body ?? '{}');
    if (input === '/api/session.list') {
      if (value.listHang) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      return { ok: !value.fail, json: async () => ({ rpcId: body.rpcId, result: {
        ok: !value.fail, value: { items: [{ sessionId: 'same-session', running: value.running }] },
      } }) };
    }
    calls.push({ input, body, source: value.source });
    if (value.promptDeferred) return value.promptDeferred;
    if (value.promptError) throw value.promptError;
    return value.promptReply ?? { status: 200 };
  } };
  vm.runInNewContext(source, {
    window, URL, DOMException, AbortController, crypto: { randomUUID }, location: new URL('http://harness.test/'),
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: key => timers.delete(key),
  });
  return { value, calls, timers, window, get transportStarts() { return transportStarts; },
    advance() { for (const [key, fn] of [...timers]) { timers.delete(key); fn(); } },
    send(text, signal) { const payload = { mode: 'queue', sessionId: 'same-session', content: [{ type: 'text', text }] };
      return window.__forgeQueuePrompt(payload, signal, () => {
      transportStarts++;
      return window.fetch(new URL('http://harness.test/api/session.prompt'), { method: 'POST', signal,
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'session.prompt',
        payload }),
    }); }); },
  };
}

test('browser feedback waits for the running edit and binds the source only on dispatch', async () => {
  const f = fixture();
  const first = f.send('补充当前候选的验收反馈');
  const second = f.send('同一候选的第二条反馈');
  await tick();
  assert.equal(f.calls.length, 0, 'no protected prompt prepares or replaces the active execution');
  for (let second = 0; second < 35; second++) { f.advance(); await tick(); }
  assert.equal(f.transportStarts, 0, 'the native transport timeout has not started during queue waiting');
  f.value.source = 'completed-edit';
  f.value.running = false;
  f.advance();
  await Promise.all([first, second]);
  assert.equal(f.transportStarts, 2);
  assert.deepEqual(f.calls.map(call => call.body.payload.content[0].text), ['补充当前候选的验收反馈', '同一候选的第二条反馈']);
  assert.deepEqual(f.calls.map(call => call.source), ['completed-edit', 'completed-edit']);
});

test('cancelled or unobservable queued feedback never reaches protected execution', async () => {
  const f = fixture();
  const controller = new AbortController();
  const pending = f.send('反馈', controller.signal);
  await tick();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  f.value.fail = true;
  await assert.rejects(f.send('反馈'), /尚未发送/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 0);
});

test('idle prompts and unrelated requests are forwarded without changing their bodies', async () => {
  const f = fixture();
  f.value.running = false;
  await f.send('继续当前任务');
  await f.window.fetch('/api/session.stop', { method: 'POST', body: '{}' });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.payload.content[0].text, '继续当前任务');
  assert.equal(f.calls[1].input, '/api/session.stop');
});

test('the existing queue waits again when only the prior task tools remain active', async () => {
  const f = fixture();
  f.value.running = false;
  // The pinned native schema retains agent-busy.reason and strips other fields.
  f.value.promptReply = { result: { ok: false, error: { code: 'agent-busy',
    details: { reason: 'CONVERSATION_EXECUTION_BUSY_NOT_ACCEPTED' } } } };
  const first = f.send('继续当前任务');
  const second = f.send('再检查刚才的结果');
  await tick();
  assert.equal(f.transportStarts, 1);
  assert.equal(f.timers.size, 1);
  assert.equal(f.calls[0].body.payload.content[0].text, '继续当前任务');
  f.value.source = 'prior-tools-finished';
  f.value.promptReply = { result: { ok: true, value: { accepted: true } } };
  f.advance();
  await Promise.all([first, second]);
  assert.equal(f.transportStarts, 3, 'only the explicitly unaccepted attempt is retried');
  assert.deepEqual(f.calls.slice(1).map(call => call.body.payload.content[0].text), ['继续当前任务', '再检查刚才的结果']);
  assert.deepEqual(f.calls.slice(1).map(call => call.source), ['prior-tools-finished', 'prior-tools-finished']);
  assert.equal(f.timers.size, 0);
});

test('queued prompts never retry unknown outcomes and can be cancelled while tools finish', async () => {
  const f = fixture();
  f.value.running = false;
  f.value.promptReply = { result: { ok: false, error: { code: 'agent-busy', details: { reason: 'another-reason' } } } };
  assert.equal(await f.send('反馈'), f.value.promptReply);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
  f.value.promptError = new Error('transport timeout: acceptance unknown');
  await assert.rejects(f.send('反馈'), /acceptance unknown/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.timers.size, 0);
  f.value.promptError = null;
  f.value.promptReply.result.error.details.reason = 'CONVERSATION_EXECUTION_BUSY_NOT_ACCEPTED';
  const controller = new AbortController();
  const pending = f.send('反馈', controller.signal);
  await tick();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.calls.length, 3);
  assert.equal(f.timers.size, 0);
});

test('visible waiting can be cancelled without interrupting or submitting the active task', async () => {
  const f = fixture(), states = [];
  const unsubscribe = f.window.__forgeSubscribePromptQueue('same-session', state => states.push(state));
  const pending = f.send('请检查当前结果');
  await tick();
  assert.equal(states.at(-1).phase, 'waiting');
  states.at(-1).cancel();
  await assert.rejects(pending, /已取消等待.*尚未发送/);
  assert.equal(states.at(-1), null);
  assert.equal(f.transportStarts, 0);
  assert.equal(f.value.running, true);
  f.value.running = false;
  await f.send('恢复后的命令');
  assert.equal(f.calls.length, 1);
  unsubscribe();
  assert.equal(f.timers.size, 0);
});

test('dispatch removes cancellation and a cancelled follower cannot let another prompt overtake', async () => {
  const f = fixture(), states = [];
  f.value.running = false;
  let finish;
  f.value.promptDeferred = new Promise(resolve => { finish = resolve; });
  f.window.__forgeSubscribePromptQueue('same-session', state => states.push(state));
  const first = f.send('第一条');
  await tick();
  assert.equal(states.at(-1).phase, 'submitting');
  assert.equal(states.at(-1).cancel, null);
  const controller = new AbortController();
  const second = f.send('取消第二条', controller.signal);
  controller.abort();
  await assert.rejects(second, { name: 'AbortError' });
  const third = f.send('第三条');
  await tick();
  assert.equal(f.calls.length, 1);
  f.value.promptDeferred = null;
  finish({ result: { ok: true, value: { accepted: true } } });
  await Promise.all([first, third]);
  assert.deepEqual(f.calls.map(call => call.body.payload.content[0].text), ['第一条', '第三条']);
  assert.equal(states.at(-1), null);
});

test('an unresponsive session status read ends without dispatch and releases the queue', async () => {
  const f = fixture(); f.value.listHang = true;
  const pending = f.send('检查当前状态');
  await tick(); f.advance();
  await assert.rejects(pending, /查询当前执行状态超时.*尚未发送/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.size, 0);
  f.value.listHang = false; f.value.running = false;
  await f.send('恢复后的命令');
  assert.equal(f.calls.length, 1);
});

test('explicit preparation rejection settles immediately and never follows busy retry', async () => {
  const f = fixture(); f.value.running = false;
  f.value.promptReply = { result: { ok: false, error: { code: 'internal-error', details: {
    reason: 'CONVERSATION_PREPARATION_UNAVAILABLE', requestAccepted: false, retryable: true,
  } } } };
  assert.equal(await f.send('继续'), f.value.promptReply);
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.size, 0);
});
