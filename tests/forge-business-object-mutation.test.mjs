import assert from 'node:assert/strict';
import test from 'node:test';
import fixture from './fixtures/forge-business-object-mutation/valid.json' with { type: 'json' };
import {
  ForgeBusinessObjectMutationError,
  createForgeBusinessObjectMutationPlan,
  evaluateForgeBusinessObjectMutation,
  sealForgeBusinessObjectSnapshot,
} from '../docker/harness/forge-business-object-mutation.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;
const verified = { verifyProtectedObjectObservation: async (observation) => observation.attestation.protected === true };
function snapshotInput() { return structuredClone(fixture.snapshot); }
function patchInput(snapshot) { return { ...structuredClone(fixture.patch), baselineSnapshot: snapshot }; }
function observation(snapshot, found = true) {
  return {
    found,
    locator: { projectSlug: snapshot.projectSlug, objectType: snapshot.objectType, objectId: snapshot.objectId, tenantId: snapshot.tenantId },
    snapshot: found ? snapshot : null,
    attestation: { protected: true, receiptId: found ? 'read-found' : 'read-not-found' },
  };
}
function expectCode(code, callback) {
  assert.throws(callback, (error) => { assert.ok(error instanceof ForgeBusinessObjectMutationError); assert.equal(error.code, code); return true; });
}

test('protected fresh version-bound patch is valid but never grants writer authority', async () => {
  const baseline = sealForgeBusinessObjectSnapshot(snapshotInput());
  const plan = createForgeBusinessObjectMutationPlan(patchInput(baseline));
  const rereadInput = snapshotInput(); rereadInput.observedAt = '2026-09-01T00:01:00.000Z';
  const reread = sealForgeBusinessObjectSnapshot(rereadInput);
  const result = await evaluateForgeBusinessObjectMutation({ baseline: observation(baseline), current: observation(reread), plan }, verified);
  assert.equal(result.status, 'mutation-valid-not-writer-authority');
  assert.equal(result.mutationValid, true);
  assert.equal(result.writerAuthorized, false);
  assert.equal(result.requiresProtectedAtomicCompareAndWrite, true);
});
test('unknown IDs and unprotected reads fail closed before mutation', async () => {
  const baseline = sealForgeBusinessObjectSnapshot(snapshotInput());
  const plan = createForgeBusinessObjectMutationPlan(patchInput(baseline));
  const missing = await evaluateForgeBusinessObjectMutation({ baseline: observation(baseline), current: observation(baseline, false), plan }, verified);
  assert.equal(missing.reasonCode, 'UNKNOWN_OBJECT');
  const unprotected = await evaluateForgeBusinessObjectMutation({ baseline: observation(baseline), current: observation(baseline), plan });
  assert.equal(unprotected.reasonCode, 'PROTECTED_OBJECT_READER_REQUIRED');
});

test('stale version or ETag rejects both patch and full replacement', async () => {
  const baseline = sealForgeBusinessObjectSnapshot(snapshotInput());
  const patch = createForgeBusinessObjectMutationPlan(patchInput(baseline));
  const staleInput = snapshotInput(); staleInput.observedAt = '2026-09-01T00:01:00.000Z'; staleInput.concurrency.token = '18';
  const stale = sealForgeBusinessObjectSnapshot(staleInput);
  const patchResult = await evaluateForgeBusinessObjectMutation({ baseline: observation(baseline), current: observation(stale), plan: patch }, verified);
  assert.equal(patchResult.reasonCode, 'STALE_OBJECT');

  const replace = createForgeBusinessObjectMutationPlan({
    schemaVersion: 1, planType: 'forge-business-object/mutation-plan', planId: '123e4567-e89b-42d3-a456-426614174101', mode: 'replace', baselineSnapshot: baseline, patchChanges: null,
    replacementFields: baseline.fields.map((item) => ({ field: item.field, valueSha256: item.field === 'remark' ? sha('9') : item.valueSha256 })),
  });
  const replaceResult = await evaluateForgeBusinessObjectMutation({ baseline: observation(baseline), current: observation(stale), plan: replace }, verified);
  assert.equal(replaceResult.reasonCode, 'STALE_OBJECT');
});

test('field-level patch cannot cross mutable, pre-image, or known-field boundaries', () => {
  const baseline = sealForgeBusinessObjectSnapshot(snapshotInput());
  for (const [field, before, code] of [
    ['id', sha('a'), 'PATCH_FIELD_IMMUTABLE'],
    ['missing', sha('a'), 'PATCH_FIELD_UNKNOWN'],
    ['status', sha('0'), 'PATCH_PREIMAGE_INVALID'],
  ]) {
    const input = patchInput(baseline); input.patchChanges = [{ field, beforeSha256: before, afterSha256: sha('9') }];
    expectCode(code, () => createForgeBusinessObjectMutationPlan(input));
  }
});

test('full replacement must preserve every observed field and every immutable value', () => {
  const baseline = sealForgeBusinessObjectSnapshot(snapshotInput());
  const base = { schemaVersion: 1, planType: 'forge-business-object/mutation-plan', planId: '123e4567-e89b-42d3-a456-426614174102', mode: 'replace', baselineSnapshot: baseline, patchChanges: null };
  expectCode('REPLACE_INCOMPLETE', () => createForgeBusinessObjectMutationPlan({ ...base, replacementFields: baseline.fields.slice(1).map(({ field, valueSha256 }) => ({ field, valueSha256 })) }));
  expectCode('REPLACE_IMMUTABLE_CHANGED', () => createForgeBusinessObjectMutationPlan({ ...base, replacementFields: baseline.fields.map(({ field, valueSha256 }) => ({ field, valueSha256: field === 'id' ? sha('8') : field === 'status' ? sha('9') : valueSha256 })) }));
});

test('content-hash is supported as an exact equivalent concurrency condition', () => {
  const input = snapshotInput();
  const temporary = sealForgeBusinessObjectSnapshot(input);
  input.concurrency = { mode: 'content-hash', token: temporary.contentSha256 };
  const snapshot = sealForgeBusinessObjectSnapshot(input);
  assert.equal(snapshot.concurrency.token, snapshot.contentSha256);
  input.concurrency.token = sha('0');
  expectCode('SCHEMA_INVALID', () => sealForgeBusinessObjectSnapshot(input));
});
