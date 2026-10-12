import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { questionHistory, isQuestion } from '../docker/harness/forge-question-history.mjs';
import { patchHistoryHost, patchHistoryConnection, patchHistoryRuntime, patchHistoryUi } from '../docker/harness/forge-question-history-patch.mjs';

const text = value => [{ type: 'text', text: value }];
const e = (seq, type, data) => ({ seq, type, time: seq * 1000, data });
function turn(start, prompt, answer, tool = 'large tool body') {
  return [e(start, 'user/message', { id: 'u' + start, source: { kind: 'user' }, content: text(prompt) }),
    e(start + 1, 'turn/start', { turn: start }), e(start + 2, 'user/message', { source: { kind: 'plugin' }, content: text('injected ' + prompt) }),
    e(start + 3, 'step/start', { turn: start, step: 0 }), e(start + 4, 'tool/call', { callId: 'c' + start, arguments: tool }),
    e(start + 5, 'tool/result', { callId: 'c' + start, content: text(tool) }), e(start + 6, 'step/end', { turn: start, step: 0 }),
    e(start + 7, 'step/start', { turn: start, step: 1 }), e(start + 8, 'assistant/message', { turn: start, step: 1, message: { content: text(answer) } }),
    e(start + 9, 'step/end', { turn: start, step: 1 }), e(start + 10, 'turn/end', { turn: start })];
}
test('summary opens the latest genuine question without tool bodies or injected context', () => {
  const events = [...turn(0, 'first', 'old answer'), ...turn(11, 'second', 'final answer', 'x'.repeat(200_000))];
  const result = questionHistory(events, { forgeView: 'summary' });
  assert.equal(result.events[0].seq, 11); assert.equal(result.hasMore, true);
  assert.equal(result.events.at(-1).seq, 21);
  assert(!JSON.stringify(result).includes('x'.repeat(100)));
  assert(result.events.some(x => x.type === 'assistant/message'));
  assert.equal(result.events[0].data.forgeHistory.loaded, false);
  assert.deepEqual(questionHistory(events, { forgeView: 'summary', beforeSeq: 11 }).events.map(x => x.seq), [0, 1, 7, 8, 9, 10]);
});
test('search is session-local, literal, Unicode-normalized and genuine-user-only', () => {
  const events = [...turn(0, '审批 AＢＣ', 'assistant-only'), ...turn(11, 'next', '审批 answer')];
  const result = questionHistory(events, { forgeView: 'search', query: 'abc' });
  assert.deepEqual(result.forgeSearch.items.map(x => x.seq), [0]);
  assert.equal(questionHistory(events, { forgeView: 'search', query: 'injected' }).forgeSearch.items.length, 0);
  assert.equal(questionHistory(events, { forgeView: 'search', query: 'assistant-only' }).forgeSearch.items.length, 0);
  assert.equal(questionHistory(events, { forgeView: 'search', query: '' }).forgeSearch.items.length, 0);
});

test('question list includes every genuine prompt and excludes injected or replacement messages', () => {
  const events = [...turn(0, 'first prompt', 'answer', 'private tool body'),
    e(11, 'user/message', { message: { source: { kind: 'user' }, content: [{ type: 'image', attachmentId: 'a' }] } }),
    e(12, 'user/message', { source: { kind: 'user' }, content: text('steering prompt') }),
    { ...e(13, 'user/message', { source: { kind: 'user' }, content: text('replacement') }), surfaceOp: { kind: 'replace' } }];
  const original = JSON.stringify(events);
  const result = questionHistory(events, { forgeView: 'questions' });
  assert.deepEqual(result.forgeQuestions, { items: [
    { seq: 12, time: 12000, text: 'steering prompt' },
    { seq: 11, time: 11000, text: '' },
    { seq: 0, time: 0, text: 'first prompt' },
  ], total: 3, nextCursor: null });
  assert.deepEqual(result.events, []);
  assert.equal(result.hasMore, false);
  assert.equal(JSON.stringify(events), original);
});

test('question list pages through the whole session with a stable total and no duplicates', () => {
  const events = Array.from({ length: 45 }, (_, i) => turn(i * 11, `question ${i}`, 'answer')).flat();
  const pages = [];
  let cursor;
  do {
    const page = questionHistory(events, { forgeView: 'questions', beforeSeq: cursor }).forgeQuestions;
    assert.equal(page.total, 45);
    pages.push(page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(pages.map(page => page.length), [20, 20, 5]);
  assert.deepEqual(pages.flat().map(item => item.seq), Array.from({ length: 45 }, (_, i) => (44 - i) * 11));
  assert.deepEqual(questionHistory([], { forgeView: 'questions' }).forgeQuestions, { items: [], total: 0, nextCursor: null });
});

test('question list refresh sees new prompts and bounds individual previews', () => {
  const events = turn(0, 'x'.repeat(2000), 'answer');
  const first = questionHistory(events, { forgeView: 'questions' }).forgeQuestions;
  assert.equal(first.items[0].text.length, 600);
  events.push(...turn(11, 'new prompt', 'new answer'));
  const refreshed = questionHistory(events, { forgeView: 'questions' }).forgeQuestions;
  assert.equal(refreshed.total, 2);
  assert.equal(refreshed.items[0].seq, 11);
});

test('version one native patch consumers upgrade once and keep existing history behavior', () => {
  const fixtures = [
    [patchHistoryHost, `// forge-question-history-v1 host\nforgeView: z$1.enum(['summary', 'details', 'search']).optional(),\nforgeSearch: z$1.unknown().optional(),`, "'search', 'questions'", 'forgeQuestions: z$1.unknown()'],
    [patchHistoryConnection, '// forge-question-history-v1 connection\nforgeSearch: unknown().optional(),', 'forgeQuestions: unknown()', 'forgeSearch: unknown()'],
    [patchHistoryRuntime, "// forge-question-history-v1 runtime\nif (payload.forgeView === 'search') return result.value;\nthis.installWindow(entries, this.hasMore);", "payload.forgeView === 'questions'", 'this.installWindow(entries, this.hasMore)'],
    [patchHistoryUi, '// forge-question-history-v1 ui\nfunction OldQuestionHelper() {}\nfunction ChatView({ sessionId }) { react_jsx_runtime.jsx(ForgeQuestionRows, { order, nodeStore, loadQuestionHistory, renderNode: render }); return react_jsx_runtime.jsx(ForgeQuestionSearch, { sessionId, loadQuestionHistory, jump }, sessionId); }', 'historyRevision:', 'function ChatView({ sessionId })'],
  ];
  for (const [patch, legacy, added, retained] of fixtures) {
    const upgraded = patch(legacy);
    assert(upgraded.includes('forge-question-history-v2'));
    assert(upgraded.includes(added));
    assert(upgraded.includes(retained));
    assert.equal(patch(upgraded), upgraded);
    assert(!upgraded.includes('OldQuestionHelper'));
  }
});

test('history revision changes only when the latest user prompt changes', () => {
  const legacy = '// forge-question-history-v1 ui\nfunction ChatView({ sessionId }) { react_jsx_runtime.jsx(ForgeQuestionRows, { order, nodeStore, loadQuestionHistory, renderNode: render }); return react_jsx_runtime.jsx(ForgeQuestionSearch, { sessionId, loadQuestionHistory, jump }, sessionId); }';
  const upgraded = patchHistoryUi(legacy);
  const expression = upgraded.match(/historyRevision: (order\.reduce\(.*?, null\))/)?.[1];
  assert(expression, 'Question list must receive the latest user sequence');
  const revision = new Function('order', 'nodeStore', `return ${expression}`);
  const nodeStore = new Map([
    ['old', { kind: 'user', data: { seq: 1 } }],
    ['current', { kind: 'user', data: { seq: 20 } }],
    ['answer', { kind: 'assistant-step', data: { seq: 21 } }],
    ['steering', { kind: 'steering', data: { seq: 25 } }],
  ]);
  assert.equal(revision(['current', 'answer'], nodeStore), 20);
  assert.equal(revision(['old', 'current', 'answer'], nodeStore), 20);
  assert.equal(revision(['old', 'current', 'answer', 'steering'], nodeStore), 25);
});

test('version two UI upgrades its helpers and action props exactly once', () => {
  const legacy = '// forge-question-history-v2 ui\nfunction OldQuestionHelper() {}\nfunction ChatView({ sessionId }) { return react_jsx_runtime.jsx(ForgeQuestionRows, { order, nodeStore, loadQuestionHistory, renderNode: render }); }';
  const upgraded = patchHistoryUi(legacy);
  assert.match(upgraded, /forge-workpod-flow-v1 ui/);
  assert.match(upgraded, /loadQuestionHistory, sessionId, running, connectionReady, renderNode:/);
  assert.match(upgraded, /function ForgeWorkpodActions/);
  assert(!upgraded.includes('OldQuestionHelper'));
  assert.equal(patchHistoryUi(upgraded), upgraded);
});

test('an installed workpod v1 consumer refreshes helpers and keeps unrelated bundle patches byte-identical', () => {
  const prefix = '// forge-workpod-flow-v1 ui\nconst existingModelControl = "keep this parent image patch";\n';
  const suffix = 'function ChatView({ sessionId }) { return react_jsx_runtime.jsx(ForgeQuestionRows, { order, nodeStore, loadQuestionHistory, sessionId, running, connectionReady, renderNode: render }); }\nconst existingComposerPatch = "keep this too";';
  const oldHelpers = '// forge-question-history-v2 ui\nasync function forgeSubmitWorkpodAction() { return fetch("/api/session.prompt"); }\nfunction ForgeQuestionRows() { return []; }\n';
  const installed = prefix + oldHelpers + suffix;
  const currentHelpers = readFileSync(new URL('../docker/harness/forge-question-history-client.js', import.meta.url), 'utf8');
  const upgraded = patchHistoryUi(installed);
  assert.notEqual(upgraded, installed, 'an existing workpod marker cannot skip the helper upgrade');
  assert.equal(upgraded, prefix + '// forge-question-history-v2 ui\n' + currentHelpers + '\n' + suffix);
  assert.match(upgraded, /function ForgePromptQueueStatus/);
  assert.match(upgraded, /__forgeSubscribePromptQueue/);
  assert.match(upgraded, /const timer = setTimeout\(\(\) => controller\.abort/);
  assert.match(upgraded, /150000/);
  assert.match(upgraded, /requestAccepted === false/);
  assert.equal(patchHistoryUi(upgraded), upgraded, 'a second incremental install is byte-identical');
});

test('confirmation metadata comes only from the current prepare_task result and a prepared result clears it', () => {
  const events = turn(0, 'change one page', 'please confirm');
  events[4].data.name = 'prepare_task';
  events[5].data = { message: { source: { callId: 'c0' }, content: [{ type: 'tool-result', content: text(JSON.stringify({ status: 'needs-confirmation' })) }] } };
  const summary = () => questionHistory(events, { forgeView: 'summary' }).events[0].data.forgeHistory;
  assert.equal(summary().needsConfirmation, true);
  events[5].data.message.content[0].content = text(JSON.stringify({ status: 'prepared' }));
  assert.equal(summary().needsConfirmation, false);
  events[5].data.message.content[0].content = text(JSON.stringify({ status: 'needs-confirmation' }));
  events[4].data.name = 'read';
  assert.equal(summary().needsConfirmation, false);
});
test('details are requested for one exact question and preserve source events', () => {
  const events = [...turn(0, 'first', 'answer'), ...turn(11, 'second', 'answer')];
  const original = JSON.stringify(events), result = questionHistory(events, { forgeView: 'details', questionSeq: 0 });
  assert(result.events.some(x => x.type === 'tool/result'));
  assert(result.events.every(x => x.seq < 11));
  assert.equal(result.events[0].data.forgeHistory.loaded, true);
  assert.equal(result.events[0].data.forgeHistory.nextDetailSeq, null);
  assert.equal(JSON.stringify(events), original);
  assert.throws(() => questionHistory(events, { forgeView: 'details', questionSeq: 5 }));
});
test('bounded result pages advance and never duplicate the cursor question', () => {
  const events = Array.from({ length: 45 }, (_, i) => turn(i * 11, `question ${i}`, 'answer')).flat();
  const first = questionHistory(events, { forgeView: 'search', query: 'question' }).forgeSearch;
  const second = questionHistory(events, { forgeView: 'search', query: 'question', beforeSeq: first.nextCursor }).forgeSearch;
  assert.equal(first.items.length, 20); assert.equal(second.items.length, 20);
  assert(first.items.every(a => second.items.every(b => a.seq !== b.seq)));
  const range = questionHistory(events, { forgeView: 'summary', questionSeq: 0, beforeSeq: 440 });
  assert.equal(range.events.filter(isQuestion).length, 30);
  assert.equal(range.events[0].seq, 110);
});
test('native nested user messages and image-only prompts remain navigable', () => {
  const events = [e(2, 'user/message', { message: { id: 'image', source: { kind: 'user' }, content: [{ type: 'image', attachmentId: 'a' }] } })];
  assert.equal(isQuestion(events[0]), true);
  const result = questionHistory(events, { forgeView: 'summary' });
  assert.equal(result.events[0].data.message.forgeHistory.questionSeq, 2);
  assert.equal(result.hasMore, false);
});
test('all textual answers remain visible while reasoning loads only with details', () => {
  const events = turn(0, 'question', 'first answer');
  events[8].data.message.content.unshift({ type: 'reasoning', text: 'private process content' });
  events.splice(10, 0, e(10, 'step/start', { turn: 0, step: 2 }), e(11, 'assistant/message', { content: text('second answer') }), e(12, 'step/end', { turn: 0, step: 2 }));
  events.at(-1).seq = 13;
  const summary = questionHistory(events, { forgeView: 'summary' });
  assert.equal(summary.events.filter(x => x.type === 'assistant/message').length, 2);
  assert(!JSON.stringify(summary).includes('private process content'));
  assert(JSON.stringify(questionHistory(events, { forgeView: 'details', questionSeq: 0 })).includes('private process content'));
});
test('detail pagination is bounded and excludes historical streaming chunks', () => {
  const events = [e(0, 'user/message', { source: { kind: 'user' }, content: text('long') }),
    ...Array.from({ length: 400 }, (_, i) => e(i + 1, 'tool/result', { content: text('body') })),
    e(401, 'assistant/chunk', { content: 'huge chunk' }), e(402, 'turn/end', { turn: 1 })];
  const first = questionHistory(events, { forgeView: 'details', questionSeq: 0 });
  assert.equal(first.events.filter(x => x.type === 'tool/result').length, 160);
  const cursor = first.events[0].data.forgeHistory.nextDetailSeq;
  const second = questionHistory(events, { forgeView: 'details', questionSeq: 0, detailAfterSeq: cursor });
  assert.equal(second.events.filter(x => x.type === 'tool/result').length, 160);
  assert(second.events.filter(x => x.type === 'tool/result').every(x => x.seq > cursor));
  assert(!first.events.some(x => x.type === 'assistant/chunk'));
});
