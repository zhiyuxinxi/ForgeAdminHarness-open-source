import assert from 'node:assert/strict';
import test from 'node:test';

import { projectConversationOutput, redactConversationOutput } from '../docker/harness/conversation-output-projection.mjs';

const session = { sessionId: 'session-output-test', cwd: '/workspace', running: false };
const history = (events, running = false) => ({ session: { ...session, running }, events });
const event = (seq, type, data) => ({ seq, type, data });

test('archive projection retains user input, intermediate/final output, failures and downloadable code', () => {
  const result = projectConversationOutput(history([
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { message: { source: { kind: 'human' }, content: [{ type: 'text', text: '整理安保需求' }] } }),
    event(3, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '先检查当前资料。' }] } }),
    event(4, 'tool/call', { turn: 1, callId: 'read-1', name: 'read_file', arguments: '{"path":"/workspace/docs/missing.md"}' }),
    event(5, 'tool/result', { turn: 1, message: { source: { callId: 'read-1' }, content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: '文件不存在' }] }] } }),
    event(6, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '需求已整理，仍需补充资料。\n\n```json\n{"标题":"安保需求"}\n```\n\n```html\n<h1>安保</h1>\n```' }] } }),
    event(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]));
  assert.equal(result.status, 'completed');
  assert.equal(result.entries.find((entry) => entry.seq === 2).role, 'user');
  assert.equal(result.entries.find((entry) => entry.seq === 4).status, 'failed');
  assert.equal(result.entries.find((entry) => entry.seq === 5).text, '文件不存在');
  assert.equal(result.files.find((file) => file.name === 'assistant-6-1.json').content, '{"标题":"安保需求"}\n');
  assert.equal(result.files.find((file) => file.name === 'assistant-6-2.html').content, '<h1>安保</h1>\n');
  assert.equal(result.eventCount, 7);
  assert.match(result.eventDigest, /^[a-f0-9]{64}$/u);
  assert.equal('accepted' in result, false);
});

test('a stopped turn retains the interrupted assistant prefix and pending tool state', () => {
  const value = projectConversationOutput(history([
    event(1, 'turn/start', { turn: 2 }),
    event(2, 'tool/call', { turn: 2, callId: 'pending', name: 'read_file', arguments: '{}' }),
    event(3, 'assistant/message', { turn: 2, interrupted: true, message: { content: [{ type: 'text', text: '已完成一部分，' }] } }),
    event(4, 'turn/end', { turn: 2, reason: { kind: 'aborted' } }),
  ]));
  assert.equal(value.status, 'stopped');
  assert.equal(value.entries[1].status, 'pending');
  assert.equal(value.entries[2].text, '已完成一部分，');
  assert.equal(value.entries[2].status, 'stopped');
});

test('a running snapshot does not infer completion from a later session observation', () => {
  const value = projectConversationOutput(history([
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '处理中' }] } }),
  ], false));
  assert.equal(value.status, 'running');
});

test('failure/empty snapshots preserve their actual terminal boundary', () => {
  assert.equal(projectConversationOutput(history([])).status, 'empty');
  assert.equal(projectConversationOutput(history([
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'turn/end', { turn: 1, reason: { kind: 'failed', message: '执行失败' } }),
  ])).status, 'failed');
});

test('native historical replacement cannot settle a pending tool', () => {
  const value = projectConversationOutput(history([
    event(1, 'turn/start', { turn: 2 }),
    event(2, 'tool/call', { turn: 2, callId: 'same-id', name: 'read_file', arguments: '{}' }),
    { ...event(3, 'tool/result', { turn: 1, message: { source: { callId: 'same-id' }, content: [{ type: 'tool-result', content: [{ type: 'text', text: '[pruned]' }] }] } }), surfaceOp: { op: 'replace', start: 0, end: 0 } },
  ], true));
  assert.equal(value.entries[1].status, 'pending');
  assert.equal(value.entries[2].type, 'tool/result-replacement');
});

test('output removes known credential forms and omits headers/private metadata', () => {
  const value = projectConversationOutput(history([
    event(1, 'request/header', { header: { authorization: 'must-not-export-header' } }),
    event(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'password="example-secret"\n密码：示例口令\nBearer abcdefghijklmnop\nknown-local-token' }] }, meta: { secret: 'must-not-export-meta' } }),
  ]), { secrets: ['known-local-token'] });
  const exported = JSON.stringify(value);
  for (const secret of ['example-secret', '示例口令', 'abcdefghijklmnop', 'known-local-token', 'must-not-export-header', 'must-not-export-meta']) {
    assert.equal(exported.includes(secret), false, secret);
  }
  const fixtureKeyBlock = ['BEGIN', 'END'].map((edge) => `-----${edge} PRIVATE KEY-----`).join('\nexample\n');
  assert.match(redactConversationOutput(fixtureKeyBlock), /REDACTED PRIVATE KEY/u);
});

test('invalid identity or reordered history is refused instead of partially exported', () => {
  assert.throws(() => projectConversationOutput({ session: { ...session, cwd: '/other' }, events: [] }), { code: 'OUTPUT_HISTORY_INVALID' });
  assert.throws(() => projectConversationOutput(history([event(2, 'turn/start', {}), event(1, 'turn/end', {})])), { code: 'OUTPUT_HISTORY_INVALID' });
});
