import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCodexModels } from '../docker/harness/forge-sync-model-catalog.mjs';

const shipped = [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6-sol', contextWindow: 272000 }, { id: 'gpt-6-astra', contextWindow: 272000 }, { id: 'gpt-6-luna', contextWindow: 272000 }];
test('refreshes GPT-6 metadata and adds new variants while preserving other model entries', () => {
  const custom = { id: 'custom-model', contextWindow: 10000 };
  const before = [custom, { id: 'gpt-6-sol', contextWindow: 1050000 }];
  const after = mergeCodexModels(before, shipped);
  assert.deepEqual(after, [custom, ...shipped.slice(1)]);
  assert.equal(before[1].contextWindow, 1050000);
  assert.deepEqual(mergeCodexModels(after, shipped), after);
});
test('initial catalog uses shipped entries without duplicates', () => {
  assert.deepEqual(mergeCodexModels(undefined, shipped), shipped);
  assert.deepEqual(mergeCodexModels([], shipped), shipped);
});
