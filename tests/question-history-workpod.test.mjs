import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../docker/harness/forge-question-history-client.js', import.meta.url), 'utf8');
const context = vm.createContext({ document: { querySelector: () => ({}) }, crypto: { randomUUID }, AbortController, setTimeout, clearTimeout });
vm.runInContext(source, context);
const target = { sessionId: 'current-session', questionSeq: 10, terminalSeq: 20 };
const question = { type: 'user/message', seq: 10, data: { source: { kind: 'user' }, forgeHistory: { needsConfirmation: false } } };
function fixture() {
  const calls = [], state = { current: true, submitted: false, failPrompt: false };
  const history = { events: [{ event: structuredClone(question) }, { event: { type: 'turn/end', seq: 20, data: { reason: { kind: 'completed' } } } }], projections: { asOfSeq: 21 } };
  const listing = { items: [{ sessionId: target.sessionId, running: false, projections: { asOfSeq: 21 } }] };
  const options = { isCurrent: () => state.current, onSubmitting: () => { state.submitted = true; }, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, init, body });
    if (body.method === state.hangMethod) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    if (body.method === 'session.prompt' && state.failPrompt) throw new Error('network outcome unknown');
    if (body.method === 'session.prompt' && state.rejectPrompt) return { ok: false, json: async () => ({ rpcId: body.rpcId,
      result: { ok: false, error: { message: '当前结果已变化，本次未执行。', details: { requestAccepted: false } } } }) };
    const value = body.method === 'session.history' ? history : body.method === 'session.list' ? listing : { accepted: true };
    if (body.method === 'session.list' && state.changeSession) state.current = false;
    return { ok: true, json: async () => ({ rpcId: body.rpcId, result: { ok: true, value } }) };
  } };
  return { calls, state, history, listing, options, send: action => context.forgeSubmitWorkpodAction(target, action, options) };
}

test('release is one normal user prompt bound to the displayed current session and fresh snapshot', async () => {
  const f = fixture();
  await f.send('release');
  assert.deepEqual(f.calls.map(call => call.body.method), ['session.history', 'session.list', 'session.prompt']);
  const sent = f.calls.at(-1);
  assert.equal(sent.init.credentials, 'same-origin');
  assert.equal(sent.init.headers['x-forge-action-session-id'], target.sessionId);
  assert.equal(sent.init.headers['x-forge-action-as-of-seq'], '21');
  assert.deepEqual(sent.body.payload, { sessionId: target.sessionId, mode: 'queue', content: [{ type: 'text', text: '发版' }] });
  assert.equal(f.state.submitted, true);
});

test('confirmation is available only for the current structured preparation need', async () => {
  const f = fixture();
  await assert.rejects(f.send('confirm'), /无需再次确认/);
  assert.equal(f.calls.some(call => call.body.method === 'session.prompt'), false);
  f.history.events[0].event.data.forgeHistory.needsConfirmation = true;
  await f.send('confirm');
  assert.equal(f.calls.at(-1).body.payload.content[0].text, '确认执行当前范围');
});

test('missing preparation confirmation prevents a release shortcut', async () => {
  const f = fixture();
  f.history.events[0].event.data.forgeHistory.needsConfirmation = true;
  await assert.rejects(f.send('release'), /先确认/);
  assert.equal(f.state.submitted, false);
});

for (const [name, modify] of [
  ['a newer user question', f => { f.history.events[0].event.seq = 11; }],
  ['a newer terminal result', f => { f.history.events[1].event.seq = 22; }],
  ['a running session', f => { f.listing.items[0].running = true; }],
  ['a different session', f => { f.listing.items[0].sessionId = 'another-session'; }],
  ['missing snapshot identity', f => { delete f.listing.items[0].projections; }],
  ['history to list drift', f => { f.listing.items[0].projections.asOfSeq = 22; }],
  ['navigation during preflight', f => { f.state.changeSession = true; }],
]) test(`no prompt is submitted after ${name}`, async () => {
  const f = fixture(); modify(f);
  await assert.rejects(f.send('release'));
  assert.equal(f.calls.some(call => call.body.method === 'session.prompt'), false);
  assert.equal(f.state.submitted, false);
});

test('an unknown network outcome is never automatically retried', async () => {
  const f = fixture(); f.state.failPrompt = true;
  await assert.rejects(f.send('release'), /network outcome unknown/);
  assert.equal(f.calls.filter(call => call.body.method === 'session.prompt').length, 1);
  assert.equal(f.state.submitted, true);
});

test('result view folds intermediate text and tools while retaining the final result and error', () => {
  const nodes = new Map([
    ['user', { key: 'user', kind: 'user', data: { seq: 10 } }],
    ['progress', { kind: 'assistant-step', data: { finalNode: { seq: 12 }, blocks: [{ kind: 'text', text: 'working' }] } }],
    ['tool', { kind: 'tool-call', data: { root: { name: 'ask_user_question' } } }],
    ['final', { kind: 'assistant-step', data: { finalNode: { seq: 18 } } }],
    ['error', { kind: 'turn-error', data: { turn: 2 } }],
    ['tail', { kind: 'turn-tail', data: { seq: 20, turn: 2, closing: { finalNode: { seq: 18 } } } }],
  ]);
  const groups = context.forgeWorkpodGroups([...nodes.keys()], nodes);
  assert.deepEqual([...groups[0].visible], ['final', 'error', 'tail']);
  assert.deepEqual([...groups[0].hidden], ['progress', 'tool']);
  // Pending choices remain in the untouched native composer interaction slot.
  assert.equal(groups[0].tail.data.seq, 20);
});

test('a later prepared live result clears earlier confirmation metadata', () => {
  const nodes = new Map([
    ['user', { key: 'user', kind: 'user', data: { seq: 10, forgeHistory: { needsConfirmation: true } } }],
    ['prepare', { kind: 'tool-call', data: { root: { kind: 'tool-result', call: { name: 'prepare_task' }, content: [{ type: 'text', text: '{"status":"prepared"}' }] } } }],
  ]);
  assert.equal(context.forgeWorkpodGroups([...nodes.keys()], nodes)[0].needsConfirmation, false);
});

function actionFixture(storage = new Map()) {
  const f = fixture(), slots = [], cleanups = [];
  const timers = new Map(); let timerId = 0;
  let index = 0;
  const react = {
    useState(initial) {
      const at = index++;
      if (!(at in slots)) slots[at] = initial;
      return [slots[at], value => { slots[at] = value; }];
    },
    useRef(initial) { const at = index++; return slots[at] ??= { current: initial }; },
    useEffect(callback) { const at = index++; if (!(at in slots)) { slots[at] = true; cleanups.push(callback()); } },
  };
  const jsx = (type, props) => ({ type, props });
  const vmContext = vm.createContext({ document: { querySelector: () => ({}) }, crypto: { randomUUID }, AbortController,
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: key => timers.delete(key),
    fetch: f.options.fetchImpl, react, react_jsx_runtime: { jsx, jsxs: jsx },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => {
      if (f.state.failStorage) throw new Error('storage unavailable'); storage.set(key, value);
    }, removeItem: key => storage.delete(key) } });
  vm.runInContext(source, vmContext);
  const props = { sessionId: target.sessionId, running: false, connectionReady: true,
    group: { question: { data: { seq: 10 } }, tail: { data: { seq: 20 } }, needsConfirmation: false } };
  const render = () => { index = 0; return vmContext.ForgeWorkpodActions(props); };
  return { ...f, props, storage, render, timers, expire: () => { for (const fn of [...timers.values()]) fn(); }, unmount: () => cleanups.forEach(fn => fn?.()) };
}

test('rapid duplicate clicks submit once and the accepted action remains disabled', async () => {
  const f = actionFixture();
  const click = f.render().props.children[0].props.onClick;
  await Promise.all([click(), click()]);
  assert.equal(f.calls.filter(call => call.body.method === 'session.prompt').length, 1);
  assert.equal(f.render().props.children[0].props.disabled, true);
  f.unmount();
});

test('unknown submission outcome locks the button instead of allowing a duplicate request', async () => {
  const f = actionFixture(); f.state.failPrompt = true;
  await f.render().props.children[0].props.onClick();
  const view = f.render();
  assert.equal(view.props.children[0].props.disabled, true);
  assert.match(view.props.children[1].props.children, /勿重复提交/);
  await view.props.children[0].props.onClick();
  assert.equal(f.calls.filter(call => call.body.method === 'session.prompt').length, 1);
  f.unmount();
});

test('running or disconnected views cannot dispatch an action', async () => {
  const f = actionFixture();
  f.props.running = true;
  await f.render().props.children[0].props.onClick();
  f.props.running = false; f.props.connectionReady = false;
  await f.render().props.children[0].props.onClick();
  assert.equal(f.calls.length, 0);
  f.unmount();
});

for (const unknown of [false, true]) test(`${unknown ? 'unknown' : 'accepted'} submission remains locked after a same-window refresh`, async () => {
  const storage = new Map(), first = actionFixture(storage);
  first.state.failPrompt = unknown;
  await first.render().props.children[0].props.onClick();
  assert.equal(storage.size, 1);
  assert.deepEqual(JSON.parse([...storage.values()][0]), { sessionId: target.sessionId, questionSeq: 10, terminalSeq: 20, action: 'release' });
  first.unmount();
  const refreshed = actionFixture(storage);
  assert.equal(refreshed.render().props.children[0].props.disabled, true);
  await refreshed.render().props.children[0].props.onClick();
  assert.equal(refreshed.calls.length, 0);
  refreshed.unmount();
});

test('a correlated explicit not-accepted receipt clears the saved lock without retrying', async () => {
  const f = actionFixture(); f.state.rejectPrompt = true;
  await f.render().props.children[0].props.onClick();
  assert.equal(f.calls.filter(call => call.body.method === 'session.prompt').length, 1);
  assert.equal(f.storage.size, 0);
  assert.equal(f.render().props.children[0].props.disabled, false);
  assert.match(f.render().props.children[1].props.children, /本次未执行/);
  f.unmount();
});

test('storage failure prevents submission rather than losing the refresh lock', async () => {
  const f = actionFixture(); f.state.failStorage = true;
  await f.render().props.children[0].props.onClick();
  assert.equal(f.calls.some(call => call.body.method === 'session.prompt'), false);
  assert.match(f.render().props.children[1].props.children, /请求尚未发送/);
  f.unmount();
});

test('release actions use current execution state rather than an exact user phrase', () => {
  const jsx = (type, props) => ({ type, props });
  context.react = { Fragment: 'fragment' }; context.react_jsx_runtime = { jsx, jsxs: jsx };
  const nodes = new Map([
    ['user', { key: 'user', kind: 'user', data: { seq: 10, content: [{ type: 'text', text: '发版' }] } }],
    ['error', { kind: 'turn-error', data: { turn: 2, message: '发布失败' } }],
    ['tail', { kind: 'turn-tail', data: { seq: 20, turn: 2 } }],
  ]);
  const output = context.ForgeQuestionRows({ order: [...nodes.keys()], nodeStore: nodes, sessionId: target.sessionId,
    running: false, connectionReady: true, renderNode: key => 'rendered-' + key });
  const children = output[0].props.children;
  assert(children.includes('rendered-error'), 'the original failure remains visible');
  assert.equal(children.some(node => node?.type === context.ForgeWorkpodActions), true);
  assert.equal(context.forgeWorkpodReleaseRequested, undefined, 'there is no exact-phrase authority in the UI');
});

test('an unresponsive release prompt ends visibly but retains unknown-outcome duplicate protection', async () => {
  const f = actionFixture(); f.state.hangMethod = 'session.prompt';
  const pending = f.render().props.children[0].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(f.render().props.children[1].props.children, /正在提交.*等待接纳/);
  f.expire(); await pending;
  const view = f.render();
  assert.match(view.props.children[1].props.children, /接纳结果超时.*尚未确认.*勿重复提交/);
  assert.equal(view.props.children[0].props.disabled, true);
  assert.equal(f.storage.size, 1);
  await view.props.children[0].props.onClick();
  assert.equal(f.calls.filter(call => call.body.method === 'session.prompt').length, 1);
  assert.equal(f.timers.size, 0);
  f.unmount();
});

test('an unresponsive preflight ends with no prompt or stored submission lock', async () => {
  const f = actionFixture(); f.state.hangMethod = 'session.history';
  const pending = f.render().props.children[0].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  f.expire(); await pending;
  const view = f.render();
  assert.match(view.props.children[1].props.children, /核对当前结果超时.*尚未发送/);
  assert.equal(view.props.children[0].props.disabled, false);
  assert.equal(f.storage.size, 0);
  assert.equal(f.calls.some(call => call.body.method === 'session.prompt'), false);
  assert.equal(f.timers.size, 0);
  f.unmount();
});

test('a navigation change immediately before fetch is explicitly unaccepted', async () => {
  const f = fixture(); f.options.onSubmitting = () => { f.state.current = false; };
  await assert.rejects(f.send('release'), error => error.requestAccepted === false);
  assert.equal(f.calls.some(call => call.body.method === 'session.prompt'), false);
});

test('the result area displays only the current session queue and exposes cancellation only before dispatch', () => {
  let state = null, listener, subscribedSession, cleanup, cancelled = 0, detached = false, mounted = false;
  const jsx = (type, props) => ({ type, props });
  const ui = vm.createContext({ document: { querySelector: () => ({}) }, react_jsx_runtime: { jsx, jsxs: jsx },
    react: { useState: () => [state, value => { state = value; }], useEffect: callback => { if (!mounted) { mounted = true; cleanup = callback(); } } },
    __forgeSubscribePromptQueue: (sessionId, update) => { subscribedSession = sessionId; listener = update; return () => { detached = true; }; },
  });
  vm.runInContext(source, ui);
  assert.equal(ui.ForgePromptQueueStatus({ sessionId: target.sessionId }), null);
  assert.equal(subscribedSession, target.sessionId);
  listener({ phase: 'waiting', seconds: 42, cancel: () => { cancelled++; } });
  let view = ui.ForgePromptQueueStatus({ sessionId: target.sessionId });
  assert.match(view.props.children[0].props.children, /尚未发送.*42 秒/);
  assert.equal(view.props.children[1].props.children, '取消等待');
  view.props.children[1].props.onClick();
  assert.equal(cancelled, 1);
  listener({ phase: 'submitting', seconds: 42, cancel: null });
  view = ui.ForgePromptQueueStatus({ sessionId: target.sessionId });
  assert.match(view.props.children[0].props.children, /正在提交.*等待接纳/);
  assert.equal(view.props.children[1], null);
  listener(null);
  assert.equal(ui.ForgePromptQueueStatus({ sessionId: target.sessionId }), null);
  cleanup(); assert.equal(detached, true);
});
