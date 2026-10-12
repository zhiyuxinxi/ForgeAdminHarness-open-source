import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { verifyNativeReadonlyTurn } from '../scripts/verify-coverage-readonly-20260929.mjs';

// Synthetic events test rejection only; never counted as model/coverage evidence.
const spec = { input: 10, answer: 12, end: 13, turn: 2, answerText: 'Tool unavailable; stopped.' };
const contract = { promptSha256: createHash('sha256').update('Use missing tool').digest('hex') };
function events() {
  return [
    { seq: 10, type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use missing tool' }] }] } },
    { seq: 11, type: 'turn/start', data: { turn: 2 } },
    { seq: 12, type: 'assistant/message', data: { turn: 2, message: { source: { provider: 'openai-codex', model: 'gpt-5.6-luna' }, content: [{ type: 'text', text: spec.answerText }] } } },
    { seq: 13, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];
}
test('raw turn rejects missing/duplicate events, tool execution and unreviewed answers', () => {
  assert.equal(verifyNativeReadonlyTurn(events(), spec, contract).length, 4);
  const missing = events(); missing.splice(1, 1);
  const duplicate = events(); duplicate.push(duplicate[1]);
  const tool = events(); tool[1].type = 'tool/call';
  const answer = events(); answer[2].data.message.content[0].text = 'Audit passed.';
  for (const candidate of [missing, duplicate, tool, answer]) assert.throws(() => verifyNativeReadonlyTurn(candidate, spec, contract));
});
test('raw turn rejects another model, changed prompt and incomplete terminal state', () => {
  const model = events(); model[2].data.message.source.model = 'other-model';
  const prompt = events(); prompt[0].data.inserted[0].content[0].text = 'Different instruction';
  const terminal = events(); terminal[3].data.reason.kind = 'interrupted';
  for (const candidate of [model, prompt, terminal]) assert.throws(() => verifyNativeReadonlyTurn(candidate, spec, contract));
});
