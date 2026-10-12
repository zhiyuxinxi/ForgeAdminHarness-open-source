import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import test from 'node:test';
import fixture from './fixtures/forge-business-data-approval/valid.json' with { type: 'json' };
import {
  ForgeBusinessDataApprovalError,
  createForgeBusinessDataApprovalRequest,
  evaluateForgeBusinessDataApproval,
  issueForgeBusinessDataApprovalAttestation,
  verifyForgeBusinessDataApprovalAttestation,
} from '../docker/harness/forge-business-data-approval.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;
const actorUserId = '123e4567-e89b-42d3-a456-426614174000';

function requestInput() {
  return structuredClone(fixture.request);
}

function attestation(request) {
  return { ...structuredClone(fixture.attestation), requestDigest: request.requestDigest };
}

function current(request) {
  return {
    observedAt: '2026-09-01T00:02:00.000Z',
    projectSlug: request.projectSlug,
    action: request.action,
    actor: structuredClone(request.actor),
    source: structuredClone(request.source),
    scope: structuredClone(request.scope),
    objects: structuredClone(request.objects),
  };
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ForgeBusinessDataApprovalError);
    assert.equal(error.code, code);
    return true;
  });
}

function protectedKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const issuer = structuredClone(fixture.attestation.issuer);
  return {
    signing: { issuer, privateKey, observedAt: '2026-09-01T00:01:00.000Z' },
    verifying: { issuer, publicKey, observedAt: '2026-09-01T00:02:00.000Z' },
  };
}

function issue(request, context) {
  return issueForgeBusinessDataApprovalAttestation({ request, approvalId: fixture.attestation.approvalId, expiresAt: fixture.attestation.expiresAt }, context.signing);
}

test('approval request canonicalizes exact objects and binds before, after, fields, scope, actor, and source', () => {
  const first = createForgeBusinessDataApprovalRequest(requestInput());
  const reordered = requestInput(); reordered.objects.reverse(); reordered.objects[1].fields.reverse();
  const second = createForgeBusinessDataApprovalRequest(reordered);
  assert.deepEqual(second, first);
  assert.match(first.requestDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(first));
});

test('AUTHZ003 a protected valid approval remains explicitly insufficient to authorize a writer', async () => {
  const request = createForgeBusinessDataApprovalRequest(requestInput());
  const context = protectedKeys();
  const approval = issue(request, context);
  const result = await evaluateForgeBusinessDataApproval(
    { request, attestation: approval, current: current(request) },
    { approvalVerifier: context.verifying },
  );
  assert.equal(result.status, 'approval-valid-not-writer-authority');
  assert.equal(result.approvalValid, true);
  assert.equal(result.writerAuthorized, false);
  assert.equal(result.requiresProtectedAtomicConsumption, true);
  assert.match(result.consumptionKey, /^sha256:[0-9a-f]{64}$/u);
});

test('AUTHZ003 model-authored JSON and natural-language approval cannot replace the protected verifier', async () => {
  const request = createForgeBusinessDataApprovalRequest(requestInput());
  const approval = attestation(request);
  const noVerifier = await evaluateForgeBusinessDataApproval({ request, attestation: approval, current: current(request) });
  assert.equal(noVerifier.reasonCode, 'PROTECTED_APPROVAL_VERIFIER_REQUIRED');
  assert.equal(noVerifier.writerAuthorized, false);
  await assert.rejects(
    evaluateForgeBusinessDataApproval({ request, attestation: 'OK, approved', current: current(request) }),
    (error) => error instanceof ForgeBusinessDataApprovalError && error.code === 'SCHEMA_INVALID',
  );
  for (const pretendResult of [false, true]) {
    const rejected = await evaluateForgeBusinessDataApproval(
      { request, attestation: approval, current: current(request) },
      { verifyProtectedApprovalAttestation: async () => pretendResult },
    );
    assert.equal(rejected.reasonCode, 'PROTECTED_APPROVAL_VERIFIER_REQUIRED');
    assert.equal(rejected.writerAuthorized, false);
  }
});

test('AUTHZ003 Ed25519 interoperates with independently encoded domain-separated bytes and PEM keys', () => {
  const request = createForgeBusinessDataApprovalRequest(requestInput());
  const context = protectedKeys();
  const approval = issue(request, context);
  const message = Buffer.from('forge-business-data/protected-approval/ed25519/v1\0' + JSON.stringify({
    approvalId: approval.approvalId, approvedAt: approval.approvedAt,
    attestationType: approval.attestationType, authorizedActorUserId: approval.authorizedActorUserId,
    decision: approval.decision, expiresAt: approval.expiresAt,
    issuer: { keyId: approval.issuer.keyId, role: approval.issuer.role, subjectId: approval.issuer.subjectId },
    requestDigest: request.requestDigest, schemaVersion: 1,
  }), 'utf8');
  assert.equal(verify(null, message, context.verifying.publicKey, Buffer.from(approval.signature, 'base64url')), true);
  assert.equal(verifyForgeBusinessDataApprovalAttestation(approval, request, context.verifying), true);
  const wrongDomain = { ...approval, signature: sign(null, message.subarray(message.indexOf(0) + 1), context.signing.privateKey).toString('base64url') };
  assert.equal(verifyForgeBusinessDataApprovalAttestation(wrongDomain, request, context.verifying), false);
  const pemContext = {
    signing: { ...context.signing, privateKey: context.signing.privateKey.export({ type: 'pkcs8', format: 'pem' }) },
    verifying: { ...context.verifying, publicKey: context.verifying.publicKey.export({ type: 'spki', format: 'pem' }) },
  };
  assert.deepEqual(issue(request, pemContext), approval);
  assert.equal(verifyForgeBusinessDataApprovalAttestation(approval, request, pemContext.verifying), true);
  assert.ok(Object.isFrozen(approval) && Object.isFrozen(approval.issuer));
});

test('AUTHZ003 altered request, receipt identity, signature, and protected key or issuer are rejected', async () => {
  const request = createForgeBusinessDataApprovalRequest(requestInput());
  const context = protectedKeys();
  const approval = issue(request, context);
  const changed = structuredClone(request); changed.objects[0].afterSha256 = sha('0');
  expectCode('REQUEST_INTEGRITY_INVALID', () => verifyForgeBusinessDataApprovalAttestation(approval, changed, context.verifying));
  expectCode('REQUEST_INTEGRITY_INVALID', () => issue(changed, context));
  const changedInput = requestInput(); changedInput.objects[0].afterSha256 = sha('0');
  const resealed = createForgeBusinessDataApprovalRequest(changedInput);
  assert.equal(verifyForgeBusinessDataApprovalAttestation({ ...approval, requestDigest: resealed.requestDigest }, resealed, context.verifying), false);
  for (const mutation of [
    { approvalId: '123e4567-e89b-42d3-a456-426614174099' },
    { expiresAt: '2026-09-01T00:13:00.000Z' },
    { signature: (approval.signature[0] === 'A' ? 'B' : 'A') + approval.signature.slice(1) },
  ]) assert.equal(verifyForgeBusinessDataApprovalAttestation({ ...approval, ...mutation }, request, context.verifying), false);
  for (const trusted of [
    { ...context.verifying, publicKey: protectedKeys().verifying.publicKey },
    { ...context.verifying, issuer: { ...context.verifying.issuer, keyId: 'other-key' } },
    { ...context.verifying, issuer: { ...context.verifying.issuer, subjectId: 'other-approver' } },
  ]) assert.equal(verifyForgeBusinessDataApprovalAttestation(approval, request, trusted), false);
  const rejected = await evaluateForgeBusinessDataApproval(
    { request, attestation: { ...approval, signature: 'forged-signature' }, current: current(request) },
    { approvalVerifier: context.verifying, verifyProtectedApprovalAttestation: async () => true },
  );
  assert.equal(rejected.reasonCode, 'PROTECTED_APPROVAL_VERIFICATION_FAILED');
  assert.equal(rejected.writerAuthorized, false);
});

test('AUTHZ003 issuer identity, Ed25519 algorithm, trusted clock and request expiry cannot be caller-overridden', async () => {
  const request = createForgeBusinessDataApprovalRequest(requestInput());
  const context = protectedKeys();
  const approval = issue(request, context);
  const issuance = { request, approvalId: approval.approvalId, expiresAt: approval.expiresAt };
  expectCode('SCHEMA_INVALID', () => issueForgeBusinessDataApprovalAttestation({ ...issuance, issuer: context.signing.issuer }, context.signing));
  expectCode('SCHEMA_INVALID', () => issueForgeBusinessDataApprovalAttestation({ ...issuance, approvedAt: approval.approvedAt }, context.signing));
  expectCode('ATTESTATION_INVALID', () => issue(request, { signing: { ...context.signing, issuer: { ...context.signing.issuer, subjectId: actorUserId } } }));
  expectCode('PROTECTED_APPROVAL_KEY_INVALID', () => issue(request, { signing: { ...context.signing, privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey } }));
  expectCode('PROTECTED_APPROVAL_KEY_INVALID', () => issue(request, { signing: { ...context.signing, privateKey: context.verifying.publicKey } }));
  expectCode('PROTECTED_APPROVAL_KEY_INVALID', () => verifyForgeBusinessDataApprovalAttestation(approval, request, { ...context.verifying, issuer: { ...context.verifying.issuer, role: 'caller' } }));
  expectCode('APPROVAL_EXPIRED', () => issue(request, { signing: { ...context.signing, observedAt: request.expiresAt } }));
  expectCode('APPROVAL_EXPIRED', () => issue(request, { signing: { ...context.signing, observedAt: '2026-08-31T23:59:00.000Z' } }));
  expectCode('ATTESTATION_INVALID', () => issueForgeBusinessDataApprovalAttestation({ ...issuance, expiresAt: '2026-09-01T00:16:00.000Z' }, context.signing));
  for (const observedAt of [request.requestedAt, approval.expiresAt, request.expiresAt]) {
    assert.equal(verifyForgeBusinessDataApprovalAttestation(approval, request, { ...context.verifying, observedAt }), false);
  }
  const staleClock = await evaluateForgeBusinessDataApproval(
    { request, attestation: approval, current: current(request) },
    { approvalVerifier: { ...context.verifying, observedAt: approval.expiresAt } },
  );
  assert.equal(staleClock.approvalValid, false);
  assert.equal(staleClock.writerAuthorized, false);
});

test('actor, source, scope, object, and action drift all fail closed', async () => {
  const request = createForgeBusinessDataApprovalRequest(requestInput());
  const approval = attestation(request);
  const verifier = { verifyProtectedApprovalAttestation: async () => true };
  for (const [mutate, reason] of [
    [(facts) => { facts.actor.actorUserId = '123e4567-e89b-42d3-a456-426614174099'; }, 'ACTOR_BINDING_STALE'],
    [(facts) => { facts.source.fingerprint = sha('0'); }, 'SOURCE_BINDING_STALE'],
    [(facts) => { facts.scope.tenantId = 'tenant-8'; }, 'SCOPE_BINDING_STALE'],
    [(facts) => { facts.action = 'supplier-delete'; }, 'SCOPE_BINDING_STALE'],
    [(facts) => { facts.objects[0].afterSha256 = sha('1'); }, 'OBJECT_BINDING_STALE'],
  ]) {
    const facts = current(request); mutate(facts);
    const result = await evaluateForgeBusinessDataApproval({ request, attestation: approval, current: facts }, verifier);
    assert.equal(result.reasonCode, reason);
    assert.equal(result.writerAuthorized, false);
  }
});

test('expired, tampered, self-approved, unchanged, and overlong approvals fail closed', async () => {
  const request = createForgeBusinessDataApprovalRequest(requestInput());
  const expiredFacts = current(request); expiredFacts.observedAt = '2026-09-01T00:14:00.000Z';
  const expired = await evaluateForgeBusinessDataApproval({ request, attestation: attestation(request), current: expiredFacts }, { verifyProtectedApprovalAttestation: async () => true });
  assert.equal(expired.reasonCode, 'APPROVAL_EXPIRED');

  const tampered = structuredClone(request); tampered.objects[0].afterSha256 = sha('9');
  await assert.rejects(evaluateForgeBusinessDataApproval({ request: tampered, attestation: attestation(request), current: current(request) }), (error) => error.code === 'REQUEST_INTEGRITY_INVALID');

  const selfApproved = attestation(request); selfApproved.issuer.subjectId = actorUserId;
  await assert.rejects(evaluateForgeBusinessDataApproval({ request, attestation: selfApproved, current: current(request) }), (error) => error.code === 'ATTESTATION_INVALID');

  const unchanged = requestInput(); unchanged.objects[0].afterSha256 = unchanged.objects[0].beforeSha256;
  expectCode('SCHEMA_INVALID', () => createForgeBusinessDataApprovalRequest(unchanged));

  const overlong = requestInput(); overlong.expiresAt = '2026-09-01T01:00:00.000Z';
  expectCode('SCHEMA_INVALID', () => createForgeBusinessDataApprovalRequest(overlong));
});
