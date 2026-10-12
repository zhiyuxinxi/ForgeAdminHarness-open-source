import assert from 'node:assert/strict';
import test from 'node:test';
import fixture from './fixtures/forge-ui-edit-session/valid.json' with { type: 'json' };
import {
  ForgeUiEditSessionError,
  beginForgeUiSubmit,
  completeForgeUiSubmit,
  createForgeUiEditSession,
  failForgeUiSubmit,
  markForgeUiFieldDirty,
  resolveForgeUiRefill,
  startForgeUiRefill,
} from '../docker/harness/forge-ui-edit-session.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;
const clone = (value) => structuredClone(value);
const request1 = '123e4567-e89b-42d3-a456-426614174402';
const request2 = '123e4567-e89b-42d3-a456-426614174403';
const submitKey = '123e4567-e89b-42d3-a456-426614174404';
const expectCode = (code, callback) => assert.throws(callback, (error) => {
  assert.ok(error instanceof ForgeUiEditSessionError);
  assert.equal(error.code, code);
  return true;
});
const create = () => createForgeUiEditSession(clone(fixture.session));
const field = (session, name) => session.currentFields.find((item) => item.field === name).valueSha256;

test('record switch increments epoch, aborts the old request, and clears old record state', () => {
  const first = startForgeUiRefill(create(), { expectedRevision: 0, requestId: request1, recordId: 'order-1' });
  const second = startForgeUiRefill(first.session, { expectedRevision: 1, requestId: request2, recordId: 'order-2' });
  assert.deepEqual(second.abortRequestIds, [request1]);
  assert.equal(second.session.requestEpoch, 2);
  assert.equal(second.session.recordId, 'order-2');
  assert.deepEqual(second.session.baselineFields, []);
  assert.deepEqual(second.session.currentFields, []);
});

test('late response is ignored by identity and epoch even after session revision advances', () => {
  const first = startForgeUiRefill(create(), { expectedRevision: 0, requestId: request1, recordId: 'order-1' });
  const second = startForgeUiRefill(first.session, { expectedRevision: 1, requestId: request2, recordId: 'order-2' });
  const late = resolveForgeUiRefill(second.session, { expectedRevision: 1, requestId: request1, recordId: 'order-1', epoch: 1, responseFields: clone(fixture.session.fields), mergeStrategy: 'preserve-dirty' });
  assert.equal(late.outcome, 'late-response-ignored');
  assert.equal(late.session, second.session);
  assert.equal(late.cas, null);
});

test('preserve-dirty merges server refill into clean fields without clobbering edits', () => {
  const refill = startForgeUiRefill(create(), { expectedRevision: 0, requestId: request1, recordId: 'order-1' });
  const dirty = markForgeUiFieldDirty(refill.session, { expectedRevision: 1, recordId: 'order-1', field: 'status', valueSha256: sha('e') });
  const applied = resolveForgeUiRefill(dirty.session, { expectedRevision: 2, requestId: request1, recordId: 'order-1', epoch: 1, responseFields: [{ field: 'name', valueSha256: sha('c') }, { field: 'status', valueSha256: sha('d') }], mergeStrategy: 'preserve-dirty' });
  assert.equal(applied.outcome, 'refill-applied');
  assert.equal(field(applied.session, 'name'), sha('c'));
  assert.equal(field(applied.session, 'status'), sha('e'));
  assert.equal(applied.session.baselineFields.find((item) => item.field === 'status').valueSha256, sha('d'));
  assert.deepEqual(applied.session.dirtyFields, ['status']);
});

test('replacement strategy and record identity fail closed around dirty state', () => {
  const refill = startForgeUiRefill(create(), { expectedRevision: 0, requestId: request1, recordId: 'order-1' });
  const dirty = markForgeUiFieldDirty(refill.session, { expectedRevision: 1, recordId: 'order-1', field: 'status', valueSha256: sha('e') });
  expectCode('DIRTY_FIELD_REPLACE_FORBIDDEN', () => resolveForgeUiRefill(dirty.session, { expectedRevision: 2, requestId: request1, recordId: 'order-1', epoch: 1, responseFields: clone(fixture.session.fields), mergeStrategy: 'replace-clean-only' }));
  expectCode('RECORD_IDENTITY_STALE', () => markForgeUiFieldDirty(dirty.session, { expectedRevision: 2, recordId: 'order-2', field: 'status', valueSha256: sha('f') }));
  expectCode('REFILL_PENDING', () => beginForgeUiSubmit(dirty.session, { expectedRevision: 2, recordId: 'order-1', idempotencyKey: submitKey }));
});

test('submit is idempotent, state-only, and duplicate completion detects collisions', () => {
  const dirty = markForgeUiFieldDirty(create(), { expectedRevision: 0, recordId: 'order-1', field: 'status', valueSha256: sha('e') });
  const begun = beginForgeUiSubmit(dirty.session, { expectedRevision: 1, recordId: 'order-1', idempotencyKey: submitKey });
  assert.equal(begun.outcome, 'submit-ready-not-writer-authority');
  assert.equal(begun.writerAuthorized, false);
  const duplicate = beginForgeUiSubmit(begun.session, { expectedRevision: 1, recordId: 'order-1', idempotencyKey: submitKey });
  assert.equal(duplicate.outcome, 'duplicate-submit-inflight');
  assert.equal(duplicate.cas, null);
  expectCode('SUBMIT_IN_PROGRESS', () => beginForgeUiSubmit(begun.session, { expectedRevision: 2, recordId: 'order-1', idempotencyKey: request2 }));

  const responseFields = [{ field: 'name', valueSha256: sha('a') }, { field: 'status', valueSha256: sha('e') }];
  const completed = completeForgeUiSubmit(begun.session, { expectedRevision: 2, recordId: 'order-1', idempotencyKey: submitKey, responseFields });
  assert.equal(completed.outcome, 'submit-completed-state-only');
  assert.deepEqual(completed.session.dirtyFields, []);
  const replay = completeForgeUiSubmit(completed.session, { expectedRevision: 2, recordId: 'order-1', idempotencyKey: submitKey, responseFields });
  assert.equal(replay.outcome, 'duplicate-completion-no-op');
  expectCode('SUBMIT_RESPONSE_COLLISION', () => completeForgeUiSubmit(completed.session, { expectedRevision: 3, recordId: 'order-1', idempotencyKey: submitKey, responseFields: [{ field: 'name', valueSha256: sha('f') }, { field: 'status', valueSha256: sha('e') }] }));
  assert.equal(beginForgeUiSubmit(completed.session, { expectedRevision: 2, recordId: 'order-1', idempotencyKey: submitKey }).outcome, 'duplicate-submit-completed');
});

test('failed submit can be retried while refill and field changes are blocked during pending submit', () => {
  const begun = beginForgeUiSubmit(create(), { expectedRevision: 0, recordId: 'order-1', idempotencyKey: submitKey });
  expectCode('SUBMIT_IN_PROGRESS', () => startForgeUiRefill(begun.session, { expectedRevision: 1, requestId: request1, recordId: 'order-1' }));
  expectCode('SUBMIT_IN_PROGRESS', () => markForgeUiFieldDirty(begun.session, { expectedRevision: 1, recordId: 'order-1', field: 'status', valueSha256: sha('f') }));
  const failed = failForgeUiSubmit(begun.session, { expectedRevision: 1, recordId: 'order-1', idempotencyKey: submitKey });
  assert.equal(failed.outcome, 'submit-failed-retryable');
  const retried = beginForgeUiSubmit(failed.session, { expectedRevision: 2, recordId: 'order-1', idempotencyKey: submitKey });
  assert.equal(retried.outcome, 'submit-ready-not-writer-authority');
});

test('one idempotency key cannot be rebound to a changed payload after failure', () => {
  const begun = beginForgeUiSubmit(create(), { expectedRevision: 0, recordId: 'order-1', idempotencyKey: submitKey });
  const failed = failForgeUiSubmit(begun.session, { expectedRevision: 1, recordId: 'order-1', idempotencyKey: submitKey });
  const changed = markForgeUiFieldDirty(failed.session, { expectedRevision: 2, recordId: 'order-1', field: 'status', valueSha256: sha('f') });
  expectCode('SUBMIT_IDEMPOTENCY_COLLISION', () => beginForgeUiSubmit(changed.session, { expectedRevision: 3, recordId: 'order-1', idempotencyKey: submitKey }));
  const newKey = beginForgeUiSubmit(changed.session, { expectedRevision: 3, recordId: 'order-1', idempotencyKey: request2 });
  assert.equal(newKey.outcome, 'submit-ready-not-writer-authority');
});

test('session digest and revision CAS reject tampering and stale transitions', () => {
  const session = create();
  const tampered = clone(session); tampered.currentFields[0].valueSha256 = sha('f');
  expectCode('SESSION_INTEGRITY_INVALID', () => startForgeUiRefill(tampered, { expectedRevision: 0, requestId: request1, recordId: 'order-1' }));
  expectCode('SESSION_CAS_CONFLICT', () => markForgeUiFieldDirty(session, { expectedRevision: 9, recordId: 'order-1', field: 'status', valueSha256: sha('f') }));
});
