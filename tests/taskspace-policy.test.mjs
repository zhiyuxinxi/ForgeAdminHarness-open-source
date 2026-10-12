import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sourceTransitionCanonicalDigest,
  validateSourceTransition,
  validateTaskspaceAction,
} from '../docker/harness/taskspace-policy.mjs';

const start = {
  action: 'integrate',
  mode: 'start',
  expectedHead: '1'.repeat(40),
  expectedWorkspaceFingerprint: '2'.repeat(64),
  canonicalHead: '3'.repeat(40),
  paths: [],
};

test('integrate policy accepts only the exact bounded start and continue schemas', () => {
  assert.deepEqual(validateTaskspaceAction(start), start);
  const continued = {
    ...start,
    mode: 'continue',
    operationId: '123e4567-e89b-42d3-a456-426614174000',
    paths: ['forge-admin-ui/src/conflict.ts'],
  };
  assert.deepEqual(validateTaskspaceAction(continued), continued);
  assert.throws(() => validateTaskspaceAction({ ...start, operationId: continued.operationId }), /unsupported field/u);
  assert.throws(() => validateTaskspaceAction({ ...continued, operationId: undefined }), /operationId is invalid/u);
  assert.throws(() => validateTaskspaceAction({ ...start, mode: 'finish' }), /mode is invalid/u);
});

test('integrate policy rejects invalid identities and duplicate or unsafe paths', () => {
  assert.throws(() => validateTaskspaceAction({ ...start, expectedHead: 'short' }), /expectedHead is invalid/u);
  assert.throws(() => validateTaskspaceAction({ ...start, expectedWorkspaceFingerprint: 'x'.repeat(64) }), /expectedWorkspaceFingerprint is invalid/u);
  assert.throws(() => validateTaskspaceAction({ ...start, canonicalHead: 'x'.repeat(40) }), /canonicalHead is invalid/u);
  assert.throws(() => validateTaskspaceAction({ ...start, paths: ['src/a.js', 'src/a.js'] }), /unique/u);
  assert.throws(() => validateTaskspaceAction({ ...start, paths: ['../outside'] }), /safe repository-relative/u);
  assert.throws(() => validateTaskspaceAction({ ...start, paths: null }), /must be an array/u);
});

test('checkpoint and integrate retain every authorized path beyond the old 64-file limit', () => {
  const paths = Array.from({ length: 66 }, (_, index) => `src/module/File${index}.java`);
  assert.deepEqual(validateTaskspaceAction({ ...start, paths }).paths, paths);
  assert.deepEqual(validateTaskspaceAction({ action: 'checkpoint', paths, message: 'Complete module',
    expectedHead: start.expectedHead, expectedWorkspaceFingerprint: start.expectedWorkspaceFingerprint }).paths, paths);
});

function transition(overrides = {}) {
  const payload = {
    schemaVersion: 1,
    operationId: '123e4567-e89b-42d3-a456-426614174000',
    task: {
      projectSlug: 'forge-base', taskId: 'task-01',
      actorUserId: '11111111-1111-4111-8111-111111111111', actorUsername: 'alice',
      conversationId: 'conversation:1', dshSessionId: 'session:1',
    },
    from: { head: '1'.repeat(40), fingerprint: '2'.repeat(64) },
    to: { head: '3'.repeat(40), fingerprint: '4'.repeat(64) },
    canonicalHead: '5'.repeat(40), phase: 'conflict-open',
    sourceAuthority: {
      executionId: '22222222-2222-4222-8222-222222222222', generation: 7,
      contractId: '6'.repeat(64), productionAuthorityDigest: '7'.repeat(64),
      controllerGrantDigest: '8'.repeat(64), actionCeiling: 'release',
      issuedAt: '2026-09-12T00:00:00.000Z', expiresAt: '2026-09-12T00:15:00.000Z',
    },
    digestAlgorithm: 'sha256', digestEncoding: 'canonical-json-v1',
    ...overrides,
  };
  return { ...payload, digest: sourceTransitionCanonicalDigest(payload) };
}

test('source transition validator accepts only the exact canonical Broker contract', () => {
  const value = transition();
  assert.equal(validateSourceTransition(value), value);
  assert.equal(sourceTransitionCanonicalDigest({ z: [3, { b: 2, a: 1 }], a: true }),
    sourceTransitionCanonicalDigest({ a: true, z: [3, { a: 1, b: 2 }] }));
  assert.throws(() => validateSourceTransition({ ...value, browserClaim: true }), /unsupported field/u);
  assert.throws(() => validateSourceTransition({ ...value, phase: 'source-saved-error' }), /phase is invalid/u);
  assert.throws(() => validateSourceTransition({ ...value, digest: '0'.repeat(64) }), /digest is invalid/u);
  assert.throws(() => validateSourceTransition(transition({ sourceAuthority: {
    ...value.sourceAuthority, actionCeiling: 'workspace-write',
  } })), /actionCeiling is invalid/u);
  const checkpointed = transition({ phase: 'checkpointed' });
  assert.equal(validateSourceTransition(checkpointed), checkpointed);
  const gitCheckpoint = transition({
    phase: 'checkpointed',
    sourceAuthority: { ...value.sourceAuthority, actionCeiling: 'git-checkpoint' },
  });
  assert.equal(validateSourceTransition(gitCheckpoint), gitCheckpoint);
  for (const phase of ['integrated', 'conflict-open']) {
    const localSync = transition({ phase,
      sourceAuthority: { ...value.sourceAuthority, actionCeiling: 'git-checkpoint' } });
    assert.equal(validateSourceTransition(localSync), localSync);
    assert.throws(() => validateSourceTransition(transition({ phase,
      sourceAuthority: { ...value.sourceAuthority, actionCeiling: 'workspace-write' } })), /actionCeiling is invalid/u);
  }
});
