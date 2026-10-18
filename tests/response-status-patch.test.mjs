import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { forgeResponsePhase, forgeReleaseReceipts, patchResponseRuntime, patchResponseHistory, patchResponseUi } from '../docker/harness/forge-response-status-patch.mjs';
import { patchHistoryUi } from '../docker/harness/forge-question-history-patch.mjs';

const { observeRelease } = createRequire(import.meta.url)('../docker/harness/forge-release');

const receipt = { action: 'release', operation: 'release', operationId: '7a8b1992-1274-4a34-9514-3067dcc2d8b3',
  taskId: 'c-b35ae5c634b4c9584f84afa4', status: 'success', stage: 'complete', terminal: true,
  commit: 'd7117355fee46586eb3e4a72e6a62c77c763bb9e', completedAt: '2026-10-15T01:00:12.481Z' };
const text = JSON.stringify({ ok: true, result: receipt }, null, 2) + '\n[stderr]\n{"status":"accepted"}\n[status: completed, exit code: 0]';
const root = (name, args, text, extra = {}) => ({ kind: 'tool-result', call: { name, argsRaw: JSON.stringify(args) }, content: [{ type: 'text', text }], isError: false, ...extra });
const started = root('bash', { command: 'forge-release release --services forge-ui' }, 'started background job bash-3');
const finished = root('job_output', { job_id: 'bash-3', wait: true }, text);

test('a pending model, compaction and live tool have separate evidence-based phases', () => {
  const e = (type, data = {}) => ({ type, data });
  const start = [e('turn/start'), e('step/start'), e('user/message', { source: { plugin: 'forge-phase-budget-guard' } })];
  assert.equal(forgeResponsePhase(start, true), 'waiting-model');
  assert.equal(forgeResponsePhase([...start, e('compaction/start')], true), 'compacting');
  assert.equal(forgeResponsePhase([...start, e('compaction/start'), e('compaction/end')], true), 'preparing');
  assert.equal(forgeResponsePhase(start, true, [{ callId: 'live' }]), 'tool');
  assert.equal(forgeResponsePhase([...start, e('assistant/chunk', { chunk: { type: 'text', text: '结果' } })], true), 'responding');
  assert.equal(forgeResponsePhase([...start, e('tool/result')], true), 'waiting-model');
  assert.equal(forgeResponsePhase([...start, e('llm/retry')], true), 'retrying-model');
  assert.equal(forgeResponsePhase([...start, e('turn/end')], true), 'preparing');
  assert.equal(forgeResponsePhase(start, false, [{ callId: 'old' }]), null);
});

test('release success requires a correlated command or its actual job and a terminal structured receipt', () => {
  assert.equal(forgeReleaseReceipts([started, finished])[0].operationId, receipt.operationId);
  assert.equal(forgeReleaseReceipts([root('bash', { command: 'forge-release release' }, text)])[0].status, 'success');
  for (const roots of [
    [finished],
    [started, { ...finished, call: { name: 'job_output', argsRaw: '{"job_id":"other-job"}' } }],
    [root('bash', { command: 'cat old-release.json' }, text)],
    [root('bash', { command: 'forge-release release; cat old-release.json' }, text)],
    [started, { ...finished, isError: true }],
    [root('bash', { command: 'forge-release release' }, '发布成功')],
    [root('bash', { command: 'forge-release release' }, JSON.stringify({ ok: true, result: { ...receipt, terminal: false } }))],
    [root('bash', { command: 'forge-release preflight' }, text)],
  ]) assert.deepEqual(forgeReleaseReceipts(roots), []);
});

test('actual failed release observation remains visible only through its command or correlated job', async () => {
  const operation = { ...receipt, status: 'failed', stage: 'failed', error: { code: 'BUILD_FAILED', message: 'Build failed.' } };
  const observed = await observeRelease({ operationId: receipt.operationId, taskId: receipt.taskId }, async () => ({
    statusCode: 200, responseBody: JSON.stringify({ ok: true, result: { release: { operation } } }),
  }));
  assert.equal(observed.ok, false);
  assert.equal(observed.result.terminal, true);
  const observedText = JSON.stringify(observed) + '\n[stderr]\n{"status":"accepted"}';
  const failedText = observedText + '\n[status: completed, exit code: 1]';
  const failed = root('job_output', { job_id: 'bash-3', wait: true }, failedText);
  const direct = root('bash', { command: 'forge-release release' }, observedText + '\n[exit code: 1]');
  assert.equal(forgeReleaseReceipts([started, failed])[0]?.status, 'failed');
  assert.equal(forgeReleaseReceipts([direct])[0]?.status, 'failed');
  for (const roots of [
    [failed],
    [started, { ...failed, call: { name: 'job_output', argsRaw: '{"job_id":"other-job"}' } }],
    [started, { ...failed, isError: true }],
    [root('bash', { command: 'cat old-release.json' }, failedText)],
    [root('bash', { command: 'forge-release release' }, JSON.stringify({ ...observed, ok: true }))],
    [root('bash', { command: 'forge-release release' }, JSON.stringify({ ok: false, result: receipt }))],
    [root('bash', { command: 'forge-release release' }, JSON.stringify({ ...observed, result: { ...observed.result, terminal: false } }))],
    [root('bash', { command: 'forge-release release' }, JSON.stringify({ ...observed, result: { ...observed.result, operationId: undefined } }))],
    [root('bash', { command: 'forge-release preflight' }, failedText)],
  ]) assert.deepEqual(forgeReleaseReceipts(roots), []);
});

test('history refresh retains release receipt under its own question without loading hidden tool logs', async () => {
  const original = readFileSync(new URL('../docker/harness/forge-question-history.mjs', import.meta.url), 'utf8');
  const patched = patchResponseHistory(original);
  assert.equal(patchResponseHistory(patched), patched);
  const { questionHistory } = await import('data:text/javascript;base64,' + Buffer.from(patched).toString('base64'));
  const event = (seq, type, data) => ({ seq, time: seq * 1000, type, data });
  const question = (seq, text) => event(seq, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const call = (seq, id, item) => event(seq, 'tool/call', { callId: id, name: item.call.name, arguments: item.call.argsRaw });
  const result = (seq, id, item) => event(seq, 'tool/result', { message: { source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', content: item.content, isError: false }] } });
  const events = [question(1, '发版'), event(2, 'turn/start', { turn: 1 }), call(3, 'release', started), result(4, 'release', started),
    call(5, 'poll', finished), result(6, 'poll', finished), event(7, 'turn/end', { turn: 1 }), question(8, '可以使用吗')];
  const history = questionHistory(events, { forgeView: 'summary', questionSeq: 1 });
  assert.equal(history.events.find(e => e.seq === 1).data.forgeHistory.releaseReceipts[0].operationId, receipt.operationId);
  assert.deepEqual(history.events.find(e => e.seq === 8).data.forgeHistory.releaseReceipts, []);
  assert.equal(history.events.some(e => e.type === 'tool/result'), false);
  assert.equal(events[0].data.forgeHistory, undefined);
});

// Pinned native anchors plus the installed question-history row boundary.
const ui = `
function TurnStatus({ startTime, t }) {
 const elapsedMs = 20000, showClock = true;
 return { children: ["Deep diving...", showClock && { children: formatRunDuration(elapsedMs, t) }] };
}
function ContextInjectionRow({ provenance, t }) { return { title: t(provenance.role === "recall" ? "message.contextRecall" : "message.contextInjection"), }; }
function StatusSeat({ useSession, runningTurnStart }) {
 const running = useSession((s) => s.running);
			const openState = useSession((s) => s.openState);
 return { startTime: runningTurnStart, };
}
function forgeWorkpodGroups(order, nodeStore) {
 const groups = order;
 for (const group of groups) {
    if (group.standalone) continue;
    for (const { key, node } of group.nodes) {}
 }
 return groups;
}
function Rows({ group, renderNode }) { return [renderNode(group.question.key),
    react_jsx_runtime.jsx(ForgeQuestionProcess, {})]; }
`;

test('UI labels injection as complete, labels total duration and shows release before any final answer', () => {
  const patched = patchResponseUi(ui);
  assert.equal(patchResponseUi(patched), patched);
  const context = vm.createContext({ formatRunDuration: () => '20s', react_jsx_runtime: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }, ForgeQuestionProcess: 'details' });
  vm.runInContext(patched, context);
  assert.match(context.ContextInjectionRow({ provenance: { role: 'plugin' }, t: () => '上下文注入' }).title, /已完成/);
  const status = context.TurnStatus({ phase: 'compacting' });
  assert.equal(status['data-forge-response-phase'], 'compacting');
  assert.equal(status.children[0], '正在压缩上下文');
  assert.equal(status.children[1].children, '本轮总耗时 20s');
  const group = { question: { key: 'q', data: {} }, nodes: [started, finished].map(root => ({ node: { kind: 'tool-call', data: { root } } })) };
  context.forgeWorkpodGroups([group]);
  const rows = context.Rows({ group, renderNode: key => key });
  const release = context.ForgeReleaseReceipts(rows[1].props)[0];
  assert.equal(release.props['data-forge-release-status'], 'success');
  assert.equal(group.tail, undefined); // A model final/turn-end is not a prerequisite.
  assert.equal(rows[2].type, 'details');
  assert.throws(() => patchResponseUi(patched.replace('phase: responsePhase,', 'phase: "stale",')), /Incomplete/);
  const crlf = patchResponseUi(ui.replace(/\n/g, '\r\n'));
  assert.equal(patchResponseUi(crlf), crlf);
});

test('history then response can repeat after the known history helper is refreshed', () => {
  const helper = readFileSync(new URL('../docker/harness/forge-question-history-client.js', import.meta.url), 'utf8');
  const source = `// forge-workpod-flow-v1 ui\n${ui.slice(0, ui.indexOf('function forgeWorkpodGroups('))}// forge-question-history-v2 ui\n${helper}\nfunction ChatView({}) {}`;
  for (const input of [source, source.replace(/\r?\n/g, '\r\n')]) {
    const first = patchResponseUi(patchHistoryUi(input));
    const refreshed = patchHistoryUi(first);
    assert.notEqual(refreshed, first);
    const second = patchResponseUi(refreshed);
    assert.equal(second, first);
    assert.equal(patchResponseUi(second), second);
    new vm.Script(second);
    // Only an exact full helper refresh is repairable; partial/unknown edits still fail.
    for (const partial of [
      refreshed.replace('phase: responsePhase,', 'phase: "stale",'),
      refreshed.replace('function forgeWorkpodGroups(order, nodeStore) {', 'function forgeWorkpodGroups(order, nodeStore) { /* unknown */'),
      first.replace(`${forgeReleaseReceipts.toString()}\n`, ''),
      first.replace(/^    group\.releaseReceipts = .+\n/m, ''),
      first.replace('    react_jsx_runtime.jsx(ForgeReleaseReceipts, { receipts: group.releaseReceipts }),\n', ''),
    ]) {
      assert.notEqual(partial, first);
      assert.throws(() => patchResponseUi(partial), /Incomplete/);
    }
  }
});

test('runtime snapshot consumes its own native event window and patch rejects partial installation', () => {
  const source = `class Session {
buildSnapshot() {
				if (this.pendingCache === null) this.pendingCache = {};
 const legacy = { runningCalls: [] };
 return { runningCalls: legacy.runningCalls, };
}}
globalThis.Session = Session;`;
  const patched = patchResponseRuntime(source);
  assert.equal(patchResponseRuntime(patched), patched);
  const context = vm.createContext({});
  vm.runInContext(patched, context);
  const session = new context.Session();
  session.events = [{ type: 'turn/start' }, { type: 'compaction/start' }]; session.running = true;
  assert.equal(session.buildSnapshot().forgeResponsePhase, 'compacting');
  assert.throws(() => patchResponseRuntime(patched.replace('this.events, this.running', '[], this.running')), /Incomplete/);
});

test('complete legacy v1 receipt helpers upgrade once while unknown or partial helpers are rejected', () => {
  const history = readFileSync(new URL('../docker/harness/forge-question-history.mjs', import.meta.url), 'utf8');
  for (const [source, patch] of [[history, patchResponseHistory], [ui, patchResponseUi]]) {
    const current = patch(source);
    const legacy = current.replace("value?.ok !== (result?.status === 'success')", 'value?.ok !== true');
    assert.notEqual(legacy, current);
    assert.equal(patch(legacy), current);
    assert.equal(patch(patch(legacy)), current);
    assert.throws(() => patch(legacy.replace('return [...receipts.values()];', 'return [];')), /Incomplete/);
  }
});

if (process.env.FORGE_TEST_NATIVE_RUNTIME) {
  test('actual runtime consumers contain the complete idempotent response-status patch', () => {
    const base = process.env.FORGE_TEST_NATIVE_RUNTIME.replace(/[\\/]$/, '');
    const installed = process.env.FORGE_TEST_INSTALLED_RESPONSE_STATUS_PATCH === '1';
    const entries = [
      [`${base}/node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js`, patchResponseRuntime],
      [`${base}/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`, patchResponseUi],
      [process.env.FORGE_TEST_QUESTION_HISTORY_PATH || '/usr/local/lib/forge-question-history.mjs', patchResponseHistory],
    ];
    for (const [path, patch] of entries) {
      const source = readFileSync(path, 'utf8'), patched = patch(source);
      assert.equal(patch(patched), patched, path);
      if (installed) assert.equal(patched, source, `${path} must already be patched`);
      if (path.endsWith('client.js')) new vm.Script(patched);
    }
  });
}
