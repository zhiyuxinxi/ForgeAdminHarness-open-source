import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { patchPromptQueueUi } from '../docker/harness/forge-question-history-patch.mjs';

const helpers = await readFile(new URL('../docker/harness/forge-question-history-client.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const native = `class Conversation {
  scopedSession() { return session; }
  draftImages(ids) { return ids.map(id => ({ id, file: id })); }
  serializeImages(files) { return Promise.resolve(files.map(file => ({ type: 'image', file }))); }
  releaseDraftImages(images) { this.released = images; }
  async send(text) {
\t\t\t\tconst result = await this.scopedSession("send").prompt([{
      type: 'text', text
    }], 'queue');
    if (!result.ok) throw new Error(result.error.message);
  }
  async sendSession(session, text, imageIds, mode, signal) {
    const attachments = this.draftImages(imageIds);
    const content = [...await this.serializeImages(attachments.map(attachment => attachment.file)), ...text === '' ? [] : [{ type: 'text', text }]];
    if (!(await session.prompt(content, mode, signal)).ok) return { kind: "error" };
    this.releaseDraftImages(attachments);
    return { kind: 'success' };
  }
}
function ChatView({ loadQuestionHistory, order, nodeStore, sessionId, useSessions, running, connectionReady, renderNode }) {
  return react_jsx_runtime.jsx(ForgeQuestionRows, { order, nodeStore, loadQuestionHistory, sessionId, running, connectionReady, renderNode: renderNode });
}
function ConversationSession({ sessionId, useSession, blank, composerPhase }) {
  if (blank && composerPhase === "blank") return null;
}
function injected(sessions, sessionId, views) {
  return {
    jumpQuestion: seq => sessions.binding(sessionId).session.forgeJumpQuestion(seq),
    views,
\t\t\t\t\t\treleaseSessionImages: (id) => {}
  };
}
function ConversationRoot({ sessionId, useSession, useSessions, renderSlot }) {
  const phase = 'active', composerSeat = 'native composer';
  return (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tclassName: ConversationRoot_module_css_default.root,
    "data-phase": phase,
    children: [renderSlot("conversation.session.header", {}), (0, react_jsx_runtime.jsxs)("div", {
      className: ConversationRoot_module_css_default.scrollBody,
      "data-conversation-scroll": "",
      children: [renderSlot("conversation.session", {}), composerSeat]
\t\t\t\t})]
\t\t\t});
}
function rootInjected(sessions) {
  return { inject: (sessionId) => ({
\t\t\t\t\thooks: { composerBlock: null }
  }) };
}
function InputBar({ running, subagent, stop, inputActions, empty = false, disabled = false, machineBusy = false }) {
  const continuable = subagent?.address.mode === 'continuable';
  const t = key => key;
  const primaryStops = running && subagent === null;
\t\t\tconst interruptible = running && continuable;
  const primaryLabel = primaryStops ? t("input.stop") : t("input.send");
  const onPrimary = () => {
    if (primaryStops) { stop?.(); return; }
    if (inputActions === void 0) return;
    if (!empty && !disabled && !machineBusy) inputActions.submit();
  };
  return { primaryStops, interruptible, primaryLabel, onPrimary, stop };
}
globalThis.conversation = new Conversation();`;

function composerFixture() {
  const requests = [], nativeCalls = [];
  let engaged = 0;
  const session = { sessionId: 'A', blankBit: true, running: false, promptAttempted: false,
    options: { onEngaged: () => { engaged++; } }, notifier: { markDirty() {} }, handleBlank(value) { this.blankBit = value; },
    prompt: async (...args) => { nativeCalls.push(args); return { ok: true, value: { accepted: true } }; } };
  const context = vm.createContext({ session, Intl, document: { querySelector: () => ({}) },
    __forgeEnqueuePrompt: (payload, signal) => new Promise((resolve, reject) => requests.push({ payload, signal, resolve, reject })) });
  vm.runInContext(helpers + '\n' + patchPromptQueueUi(native), context);
  return { session, context, requests, nativeCalls, get engaged() { return engaged; } };
}

test('composer releases each submitted draft on queue admission without fabricating native execution', async () => {
  const f = composerFixture();
  for (const text of ['A1', 'A2', 'A3', 'A4']) {
    let settled = false;
    const sending = f.context.conversation.sendSession(f.session, text, [], 'queue').then(value => { settled = true; return value; });
    await tick();
    assert.equal(settled, false, 'draft stays pending until server admission');
    f.requests.at(-1).resolve({ id: text, status: 'queued' });
    assert.equal((await sending).kind, 'success', 'native input machine can clear this draft and accept another');
  }
  assert.equal(f.requests.length, 4);
  assert.equal(f.nativeCalls.length, 0);
  assert.equal(f.session.running, false);
  assert.equal(f.session.blankBit, false);
  assert.equal(f.session.promptAttempted, true);
  assert.equal(f.engaged, 1);
});

test('queue refusal preserves attachment drafts and steer stays on the native path', async () => {
  const f = composerFixture();
  const sending = f.context.conversation.sendSession(f.session, '图片说明', ['image1'], 'queue');
  await tick();
  f.requests[0].reject(new Error('队列未接纳'));
  await assert.rejects(sending, /未接纳/);
  assert.equal(f.context.conversation.released, undefined);
  assert.equal(f.session.blankBit, true);
  const steered = await f.context.conversation.sendSession(f.session, '实时纠正', [], 'steer');
  assert.equal(steered.kind, 'success');
  assert.equal(f.nativeCalls.length, 1);
  assert.equal(f.nativeCalls[0][1], 'steer');
});

test('programmatic send uses the same durable queue and continuable subagents retain native routing', async () => {
  const f = composerFixture();
  const sending = f.context.conversation.send('同一入口');
  await tick(); f.requests[0].resolve({ status: 'queued' }); await sending;
  f.session.address = { mode: 'continuable' };
  await f.context.conversation.sendSession(f.session, '子代理消息', [], 'queue');
  assert.equal(f.nativeCalls.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(patchPromptQueueUi(patchPromptQueueUi(native)), patchPromptQueueUi(native));
  assert.match(patchPromptQueueUi(native), /ForgeConversationQueueLayout, \{ sessionId, useSessions, openSession/, 'the resident root owns the queue independently of the current chat');
});

test('an already installed composer patch gains native navigation without reinstalling send handling', () => {
  const installed = '// forge-prompt-queue-composer-v1\n' + native.slice(native.indexOf('function ChatView'))
    .replace('if (blank && composerPhase === "blank") return null;', 'if (blank && composerPhase === "blank") return sessionId ? react_jsx_runtime.jsx(ForgePromptQueueStatus, { sessionId, blank: true }) : null;')
    .replace('globalThis.conversation = new Conversation();', '');
  const updated = patchPromptQueueUi(installed);
  assert.equal(patchPromptQueueUi(updated), updated);
  assert.doesNotMatch(updated, /async send/);
  const opened = [];
  const jsx = (type, props) => ({ type, props });
  const context = vm.createContext({ document: { querySelector: () => ({}) }, react_jsx_runtime: { jsx } });
  vm.runInContext(helpers + '\n' + updated, context);
  const injected = context.injected({ open: id => opened.push(id) }, 'A', {});
  injected.openSession('B');
  assert.deepEqual(opened, ['B']);
  const useSessions = selector => selector({ byId: {} });
  const blank = context.ConversationSession({ sessionId: 'A', blank: true, composerPhase: 'blank', useSessions, openSession: injected.openSession });
  assert.equal(blank, null, 'the blank chat no longer duplicates the independent sidebar');
  const chat = context.ChatView({ useSessions, openSession: injected.openSession });
  assert.equal(chat.props.useSessions, useSessions);
  assert.equal(chat.props.openSession, injected.openSession);
});

test('the installed navigation consumer upgrades to a sidebar and busy mouse send remains separate from stop', () => {
  const installed = '// forge-prompt-queue-composer-v1\n// forge-prompt-queue-navigation-v1\n' +
    'function ConversationSession({ sessionId, useSessions, openSession, blank, composerPhase }) { if (blank && composerPhase === "blank") return sessionId ? react_jsx_runtime.jsx(ForgePromptQueueStatus, { sessionId, useSessions, openSession, blank: true }) : null; }\n' +
    native.slice(native.indexOf('function ConversationRoot'), native.indexOf('globalThis.conversation'));
  const updated = patchPromptQueueUi(installed);
  assert.equal(patchPromptQueueUi(updated), updated);
  const sends = [], stops = [];
  const jsx = (type, props) => ({ type, props });
  const context = vm.createContext({ __forgeEnqueuePrompt() {}, react_jsx_runtime: { jsx, jsxs: jsx },
    ConversationRoot_module_css_default: { root: 'native-root', scrollBody: 'native-scroll' }, ForgeConversationQueueLayout() {} });
  vm.runInContext(updated, context);
  const inputActions = { submit: () => sends.push('queue') }, stop = () => stops.push('stop');
  const busy = context.InputBar({ running: true, subagent: null, inputActions, stop });
  assert.equal(busy.primaryLabel, '发送并排队');
  assert.equal(busy.primaryStops, false);
  assert.equal(busy.interruptible, true, 'the original independent stop button is shown');
  busy.onPrimary(); busy.onPrimary(); busy.onPrimary();
  assert.deepEqual(sends, ['queue', 'queue', 'queue']);
  assert.equal(stops.length, 0);
  busy.stop(); assert.equal(stops.length, 1);
  const subagent = context.InputBar({ running: true, subagent: { address: { mode: 'continuable' } }, inputActions, stop });
  assert.equal(subagent.primaryLabel, 'input.send');
  assert.equal(subagent.interruptible, true);
  delete context.__forgeEnqueuePrompt;
  const withoutQueue = context.InputBar({ running: true, subagent: null, inputActions, stop });
  assert.equal(withoutQueue.primaryLabel, 'input.stop');
  assert.equal(withoutQueue.interruptible, false);
  withoutQueue.onPrimary(); assert.equal(stops.length, 2);
  const useSessions = () => ({}), openSession = () => {};
  const root = context.ConversationRoot({ sessionId: 'A', useSessions, openSession, renderSlot: name => name });
  assert.equal(root.props.useSessions, useSessions);
  assert.equal(root.props.openSession, openSession);
  assert.equal(root.props.children.props.className, 'native-root');
  assert.equal(root.props.children.props.children[1].props.children[1], 'native composer');
});

const children = node => [node?.props?.children].flat(Infinity).filter(value => value !== false && value != null);
const walk = node => typeof node === 'object' && node !== null ? [node, ...children(node).flatMap(walk)] : [];
const content = node => typeof node === 'object' && node !== null ? children(node).map(content).join('') : String(node ?? '');
function panel(state, { sessionId = 'A', titles = { A: { displayTitle: '对话 A' }, B: { displayTitle: '对话 B' } }, openSession = () => {}, blank = false } = {}) {
  const jsx = (type, props, key) => ({ type, props, key });
  const context = vm.createContext({ document: { querySelector: () => ({}) },
    react: { useState: () => [state, () => {}], useEffect() {} }, react_jsx_runtime: { jsx, jsxs: jsx } });
  vm.runInContext(helpers, context);
  return context.ForgePromptQueueStatus({ sessionId, useSessions: select => select({ byId: titles }), openSession, blank });
}
test('queue panel distinguishes sessions, pending cancellation, native running and failure recovery', () => {
  const actions = [];
  const tree = panel({ items: [
    { id: '1', sessionId: 'A', sequence: 1, status: 'running', preview: 'A1' },
    { id: '2', sessionId: 'A', sequence: 2, status: 'queued', preview: 'A2', position: 1 },
    { id: '3', sessionId: 'B', sequence: 3, status: 'failed', preview: 'B1', message: '准备失败' },
    { id: '4', sessionId: 'B', sequence: 4, status: 'queued', preview: 'B2', position: 2 },
  ], pausedSessions: ['B'], busyIds: [], refresh() {}, cancel: id => actions.push(['cancel', id]), resume: id => actions.push(['resume', id]) });
  assert.match(content(tree), /当前对话/);
  assert.match(content(tree), /对话 B/);
  assert.match(content(tree), /正在执行/);
  assert.match(content(tree), /执行失败/);
  assert.match(content(tree), /已暂停/);
  const rows = walk(tree).filter(node => node.type === 'li');
  assert.equal(walk(rows[0]).filter(node => node.type === 'button' && content(node) === '取消排队').length, 0, 'running item offers no queue cancellation');
  const cancel = walk(rows[1]).find(node => node.type === 'button' && content(node) === '取消排队');
  assert.equal(cancel.props['aria-label'], '取消第 2 条排队消息'); cancel.props.onClick();
  walk(tree).find(node => node.type === 'button' && content(node) === '恢复后续消息').props.onClick();
  assert.deepEqual(actions, [['cancel', '2'], ['resume', 'B']]);
});

test('the workpod sidebar keeps clickable active messages and removes completed or cancelled results', () => {
  const opened = [];
  const state = { items: [
    { id: 'own-pending', sessionId: 'A', sequence: 2, status: 'queued', preview: '请检查当前结果' },
    { id: 'other-active', sessionId: 'B', sequence: 3, status: 'running', preview: '另一个对话的消息' },
    { id: 'own-done', sessionId: 'A', sequence: 4, status: 'completed', preview: '我的已完成消息' },
    { id: 'other-done', sessionId: 'B', sequence: 5, status: 'completed', preview: '别的对话已完成' },
    { id: 'own-cancelled', sessionId: 'A', sequence: 6, status: 'cancelled', preview: '我的已取消消息' },
    { id: 'other-cancelled', sessionId: 'B', sequence: 7, status: 'cancelled', preview: '别的对话已取消' },
  ], pausedSessions: [], busyIds: [], refresh() {} };
  const tree = panel(state, { titles: { A: { displayTitle: '代码检查' }, B: { displayTitle: '测试反馈' } }, openSession: id => opened.push(id) });
  assert.match(content(tree), /消息序号 2代码检查（当前对话）/);
  assert.match(content(tree), /已发送，等待 AI 处理/);
  assert.match(content(tree), /请检查当前结果/);
  assert.match(content(tree), /测试反馈/);
  const rows = walk(tree).filter(node => node.type === 'li');
  assert.deepEqual(rows.map(row => row.props['data-forge-queue-id']), ['own-pending', 'other-active']);
  walk(rows[1]).find(node => node.type === 'button' && content(node) === '测试反馈').props.onClick();
  assert.deepEqual(opened, ['B']);
  const blank = panel({ ...state, items: state.items.filter(item => item.sessionId === 'B' && ['completed', 'cancelled'].includes(item.status)) }, { blank: true });
  assert.equal(walk(blank).filter(node => node.type === 'li').length, 0, 'finished messages do not occupy the queue even from a blank chat');
  assert.match(content(blank), /当前没有排队消息/);
  assert.equal(state.items.length, 6, 'hiding finished rows does not delete the stored messages');
});

test('the sidebar preserves the native chat subtree and its narrow-screen control can collapse after navigation', () => {
  let expanded = false;
  const opened = [], nativeChat = { type: 'native-chat', props: {} };
  const jsx = (type, props) => ({ type, props });
  const context = vm.createContext({ document: { querySelector: () => ({}) },
    react: { useState: () => [expanded, value => { expanded = typeof value === 'function' ? value(expanded) : value; }] },
    react_jsx_runtime: { jsx, jsxs: jsx } });
  vm.runInContext(helpers, context);
  const render = () => context.ForgeConversationQueueLayout({ sessionId: 'A', children: nativeChat, useSessions: () => ({}), openSession: id => opened.push(id) });
  const tree = render();
  assert.equal(walk(tree).filter(node => node === nativeChat).length, 1);
  assert.equal(walk(tree).find(node => node.type === 'aside').props['data-expanded'], false);
  walk(tree).find(node => node.type === 'button').props.onClick();
  const expandedTree = render();
  assert.equal(walk(expandedTree).find(node => node.type === 'aside').props['data-expanded'], true);
  walk(expandedTree).find(node => node.type === context.ForgePromptQueueStatus).props.openSession('B');
  assert.deepEqual(opened, ['B']);
  assert.equal(expanded, false);
});

test('queue panel exposes saved-message recovery, explicit errors and an honest empty state', () => {
  const base = { items: [], pausedSessions: [], busyIds: [], refresh() {} };
  assert.match(content(panel({ ...base, loading: true })), /正在读取/);
  assert.match(content(panel(base)), /当前没有排队消息/);
  const tree = panel({ ...base, error: '队列查询暂时不可用', actionError: '取消未成功' });
  assert.equal(walk(tree).filter(node => node.props.role === 'alert').length, 2);
  const uncertain = panel({ ...base, items: [{ id: 'x', sessionId: 'A', sequence: 1, status: 'uncertain', preview: '核对结果' }] });
  assert.match(content(uncertain), /接收结果待确认/);
  assert.match(content(uncertain), /未自动重发/);
});

test('queue panel distinguishes two native session identifiers after their shared prefix', () => {
  const tree = panel({ items: [
    { id: '1', sessionId: 'session-12345678-abcd', sequence: 1, status: 'queued', preview: '第一条' },
    { id: '2', sessionId: 'session-87654321-abcd', sequence: 2, status: 'queued', preview: '第二条' },
  ], pausedSessions: [], busyIds: [], refresh() {} });
  assert.match(content(tree), /对话 12345678/);
  assert.match(content(tree), /对话 87654321/);
  assert.doesNotMatch(content(tree), /对话 session-/);
});
