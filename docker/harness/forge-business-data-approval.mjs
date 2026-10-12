import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HEAD = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_APPROVAL_MS = 30 * 60 * 1000;
const ED25519_SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const APPROVAL_SIGNATURE = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|[A-Za-z0-9_-]{86})$/u;
const SIGNING_DOMAIN = 'forge-business-data/protected-approval/ed25519/v1\0';

export class ForgeBusinessDataApprovalError extends Error {
  constructor(code, message) { super(message); this.name = 'ForgeBusinessDataApprovalError'; this.code = code; }
}
function fail(code, message) { throw new ForgeBusinessDataApprovalError(code, message); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, label) { if (!plain(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) fail('SCHEMA_INVALID', `${label} has unsupported or missing fields.`); }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (!plain(value)) return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); }
function digest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }
function freeze(value) { if (plain(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function safe(value, label, pattern = SAFE) { if (typeof value !== 'string' || !pattern.test(value)) fail('SCHEMA_INVALID', `${label} is invalid.`); return value; }
function timestamp(value, label) { const parsed = Date.parse(value); if (typeof value !== 'string' || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail('SCHEMA_INVALID', `${label} must be an ISO timestamp.`); return parsed; }
function source(value) { exact(value, ['head', 'fingerprint'], 'source'); return { head: safe(value.head, 'source.head', HEAD), fingerprint: safe(value.fingerprint, 'source.fingerprint', SHA256) }; }
function actor(value) { exact(value, ['actorUserId'], 'actor'); return { actorUserId: safe(value.actorUserId, 'actor.actorUserId', UUID) }; }
function scope(value) { exact(value, ['tenantId', 'purpose', 'maximumObjects'], 'scope'); if (!Number.isSafeInteger(value.maximumObjects) || value.maximumObjects < 1 || value.maximumObjects > 100) fail('SCHEMA_INVALID', 'scope.maximumObjects is invalid.'); return { tenantId: safe(value.tenantId, 'scope.tenantId'), purpose: safe(value.purpose, 'scope.purpose'), maximumObjects: value.maximumObjects }; }
function objects(value, maximum) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) fail('SCHEMA_INVALID', 'approval objects are invalid.');
  const normalized = value.map((item) => { exact(item, ['objectType', 'objectId', 'beforeSha256', 'afterSha256', 'fields'], 'approval object'); if (!Array.isArray(item.fields) || item.fields.length < 1 || new Set(item.fields).size !== item.fields.length) fail('SCHEMA_INVALID', 'approval object fields are invalid.'); return { objectType: safe(item.objectType, 'object.objectType'), objectId: safe(item.objectId, 'object.objectId'), beforeSha256: safe(item.beforeSha256, 'object.beforeSha256', SHA256), afterSha256: safe(item.afterSha256, 'object.afterSha256', SHA256), fields: [...item.fields].map((field) => safe(field, 'object.field')).sort() }; }).sort((left, right) => `${left.objectType}\0${left.objectId}`.localeCompare(`${right.objectType}\0${right.objectId}`));
  if (new Set(normalized.map((item) => `${item.objectType}\0${item.objectId}`)).size !== normalized.length || normalized.some((item) => item.beforeSha256 === item.afterSha256)) fail('SCHEMA_INVALID', 'approval objects are duplicated or unchanged.');
  return normalized;
}

export function createForgeBusinessDataApprovalRequest(input) {
  exact(input, ['schemaVersion', 'requestType', 'requestId', 'projectSlug', 'action', 'objects', 'scope', 'actor', 'source', 'requestedAt', 'expiresAt'], 'approval request');
  if (input.schemaVersion !== 1 || input.requestType !== 'forge-business-data/approval-request') fail('SCHEMA_INVALID', 'approval request header is invalid.');
  const requestedAt = timestamp(input.requestedAt, 'requestedAt'); const expiresAt = timestamp(input.expiresAt, 'expiresAt');
  if (expiresAt <= requestedAt || expiresAt - requestedAt > MAX_APPROVAL_MS) fail('SCHEMA_INVALID', 'approval request expiry is invalid.');
  const normalizedScope = scope(input.scope);
  const normalized = { schemaVersion: 1, requestType: input.requestType, requestId: safe(input.requestId, 'requestId', UUID), projectSlug: safe(input.projectSlug, 'projectSlug'), action: safe(input.action, 'action'), objects: objects(input.objects, normalizedScope.maximumObjects), scope: normalizedScope, actor: actor(input.actor), source: source(input.source), requestedAt: input.requestedAt, expiresAt: input.expiresAt };
  return freeze({ ...normalized, requestDigest: digest(normalized) });
}

function validateRequest(request) {
  exact(request, ['schemaVersion', 'requestType', 'requestId', 'projectSlug', 'action', 'objects', 'scope', 'actor', 'source', 'requestedAt', 'expiresAt', 'requestDigest'], 'sealed approval request');
  const { requestDigest, ...input } = request; const sealed = createForgeBusinessDataApprovalRequest(input);
  if (sealed.requestDigest !== requestDigest) fail('REQUEST_INTEGRITY_INVALID', 'approval request digest is invalid.');
  return sealed;
}

function validateAttestation(value, request) {
  exact(value, ['schemaVersion', 'attestationType', 'approvalId', 'requestDigest', 'decision', 'approvedAt', 'expiresAt', 'authorizedActorUserId', 'issuer', 'signature'], 'protected approval attestation');
  exact(value.issuer, ['subjectId', 'keyId', 'role'], 'approval issuer');
  if (value.schemaVersion !== 1 || value.attestationType !== 'forge-business-data/protected-approval' || value.decision !== 'approved'
      || value.requestDigest !== request.requestDigest || value.authorizedActorUserId !== request.actor.actorUserId
      || value.issuer.role !== 'business-data-approver' || value.issuer.subjectId === request.actor.actorUserId) fail('ATTESTATION_INVALID', 'protected approval attestation binding is invalid.');
  safe(value.approvalId, 'approvalId', UUID); safe(value.issuer.subjectId, 'issuer.subjectId'); safe(value.issuer.keyId, 'issuer.keyId'); safe(value.signature, 'signature', APPROVAL_SIGNATURE);
  const approvedAt = timestamp(value.approvedAt, 'approvedAt'); const expiresAt = timestamp(value.expiresAt, 'attestation.expiresAt');
  if (approvedAt < Date.parse(request.requestedAt) || expiresAt <= approvedAt || expiresAt > Date.parse(request.expiresAt)) fail('ATTESTATION_INVALID', 'protected approval attestation time binding is invalid.');
  return value;
}

function protectedApprovalContext(value, keyField) {
  exact(value, ['issuer', keyField, 'observedAt'], 'protected approval key context');
  exact(value.issuer, ['subjectId', 'keyId', 'role'], 'protected approval issuer');
  const issuer = { subjectId: safe(value.issuer.subjectId, 'issuer.subjectId'), keyId: safe(value.issuer.keyId, 'issuer.keyId'), role: value.issuer.role };
  if (issuer.role !== 'business-data-approver') fail('PROTECTED_APPROVAL_KEY_INVALID', 'Protected issuer role is invalid.');
  const observedAt = timestamp(value.observedAt, 'protected.observedAt');
  const type = keyField === 'privateKey' ? 'private' : 'public';
  let key = value[keyField];
  try {
    if (!(key instanceof KeyObject)) {
      if (typeof key !== 'string' && !Buffer.isBuffer(key)) throw new Error('Unsupported key input');
      const pem = Buffer.isBuffer(key) ? key.toString('utf8') : key;
      if (Buffer.byteLength(pem, 'utf8') > 16384 || !pem.startsWith(`-----BEGIN ${type.toUpperCase()} KEY-----`)) throw new Error('Unexpected PEM key type');
      key = type === 'private' ? createPrivateKey(pem) : createPublicKey(pem);
    }
    if (key.type !== type || key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 key');
  } catch {
    fail('PROTECTED_APPROVAL_KEY_INVALID', 'Protected approval requires an Ed25519 key of the expected type.');
  }
  return { issuer, key, observedAt };
}

function approvalSigningMessage(attestation) {
  const { signature, ...payload } = attestation;
  return Buffer.from(SIGNING_DOMAIN + JSON.stringify(canonical(payload)), 'utf8');
}

// This API is for the protected issuer. Its key, issuer identity and clock must
// come from the protected runner, never from the caller's proposed approval.
export function issueForgeBusinessDataApprovalAttestation(input, protectedIssuer) {
  exact(input, ['request', 'approvalId', 'expiresAt'], 'approval issuance');
  const request = validateRequest(input.request);
  const context = protectedApprovalContext(protectedIssuer, 'privateKey');
  if (context.observedAt < Date.parse(request.requestedAt) || context.observedAt >= Date.parse(request.expiresAt)) {
    fail('APPROVAL_EXPIRED', 'Approval request is not currently valid.');
  }
  const attestation = validateAttestation({
    schemaVersion: 1, attestationType: 'forge-business-data/protected-approval',
    approvalId: input.approvalId, requestDigest: request.requestDigest, decision: 'approved',
    approvedAt: protectedIssuer.observedAt, expiresAt: input.expiresAt,
    authorizedActorUserId: request.actor.actorUserId, issuer: context.issuer, signature: 'pending',
  }, request);
  return freeze({ ...attestation, signature: sign(null, approvalSigningMessage(attestation), context.key).toString('base64url') });
}

export function verifyForgeBusinessDataApprovalAttestation(attestation, sealedRequest, protectedVerifier) {
  const request = validateRequest(sealedRequest);
  validateAttestation(attestation, request);
  const context = protectedApprovalContext(protectedVerifier, 'publicKey');
  if (JSON.stringify(context.issuer) !== JSON.stringify({ subjectId: attestation.issuer.subjectId, keyId: attestation.issuer.keyId, role: attestation.issuer.role })
      || context.observedAt < Date.parse(attestation.approvedAt)
      || context.observedAt >= Date.parse(request.expiresAt)
      || context.observedAt >= Date.parse(attestation.expiresAt)
      || !ED25519_SIGNATURE.test(attestation.signature)) return false;
  const signature = Buffer.from(attestation.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== attestation.signature) return false;
  return verify(null, approvalSigningMessage(attestation), context.key, signature);
}

function blocked(reasonCode) { return freeze({ status: 'blocked', reasonCode, approvalValid: false, writerAuthorized: false, requiresProtectedAtomicConsumption: true }); }

export async function evaluateForgeBusinessDataApproval(input, protectedContext = {}) {
  exact(input, ['request', 'attestation', 'current'], 'approval evaluation');
  const request = validateRequest(input.request);
  // Refusing a request without an approval does not require (or establish)
  // current database facts. In particular, historical natural language is not
  // an attestation, and a preview must not invent a live pre-image.
  if (input.attestation === null || input.attestation === undefined) return blocked('APPROVAL_REQUIRED');
  exact(input.current, ['observedAt', 'projectSlug', 'action', 'actor', 'source', 'scope', 'objects'], 'current mutation facts');
  const attestation = validateAttestation(input.attestation, request);
  const observedAt = timestamp(input.current.observedAt, 'current.observedAt');
  if (observedAt >= Date.parse(request.expiresAt) || observedAt >= Date.parse(attestation.expiresAt)) return blocked('APPROVAL_EXPIRED');
  const currentScope = scope(input.current.scope); const currentActor = actor(input.current.actor); const currentSource = source(input.current.source);
  const currentObjects = objects(input.current.objects, currentScope.maximumObjects);
  if (safe(input.current.projectSlug, 'current.projectSlug') !== request.projectSlug || safe(input.current.action, 'current.action') !== request.action) return blocked('SCOPE_BINDING_STALE');
  if (JSON.stringify(currentActor) !== JSON.stringify(request.actor)) return blocked('ACTOR_BINDING_STALE');
  if (JSON.stringify(currentSource) !== JSON.stringify(request.source)) return blocked('SOURCE_BINDING_STALE');
  if (JSON.stringify(currentScope) !== JSON.stringify(request.scope)) return blocked('SCOPE_BINDING_STALE');
  if (JSON.stringify(currentObjects) !== JSON.stringify(request.objects)) return blocked('OBJECT_BINDING_STALE');
  if (!protectedContext.approvalVerifier) return blocked('PROTECTED_APPROVAL_VERIFIER_REQUIRED');
  let verified = false;
  try { verified = verifyForgeBusinessDataApprovalAttestation(attestation, request, protectedContext.approvalVerifier); } catch { return blocked('PROTECTED_APPROVAL_VERIFICATION_FAILED'); }
  if (verified !== true) return blocked('PROTECTED_APPROVAL_VERIFICATION_FAILED');
  return freeze({ status: 'approval-valid-not-writer-authority', reasonCode: 'PROTECTED_APPROVAL_VALID', approvalValid: true, writerAuthorized: false, requiresProtectedAtomicConsumption: true, approvalId: attestation.approvalId, requestDigest: request.requestDigest, consumptionKey: digest({ approvalId: attestation.approvalId, requestDigest: request.requestDigest, actor: request.actor, source: request.source }) });
}

// This schema describes caller-proposed field projections, never observed rows.
// It cannot carry approval, database authority or an arbitrary executable query.
export function validateBusinessDataPreviewProposal(value) {
  exact(value, ['action', 'scope', 'objects'], 'business data preview proposal');
  const normalizedScope = scope(value.scope);
  if (!Array.isArray(value.objects) || value.objects.length < 1 || value.objects.length > normalizedScope.maximumObjects) {
    fail('SCHEMA_INVALID', 'Preview requires a bounded nonempty object list.');
  }
  const scalar = (item) => {
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') <= 2048 && !item.includes('\0')) return item;
    fail('SCHEMA_INVALID', 'Preview values must be bounded JSON scalars.');
  };
  const normalizedObjects = value.objects.map((item) => {
    exact(item, ['objectType', 'objectId', 'changes'], 'preview object');
    if (!Array.isArray(item.changes) || item.changes.length < 1 || item.changes.length > 32) {
      fail('SCHEMA_INVALID', 'Preview requires between 1 and 32 changed fields per object.');
    }
    const changes = item.changes.map((change) => {
      exact(change, ['field', 'before', 'after'], 'preview field change');
      const field = safe(change.field, 'change.field', /^[A-Za-z][A-Za-z0-9_]{0,63}$/u);
      const before = scalar(change.before); const after = scalar(change.after);
      if (Object.is(before, after)) fail('SCHEMA_INVALID', 'Preview contains an unchanged field.');
      return { field, before, after };
    }).sort((left, right) => left.field.localeCompare(right.field));
    if (new Set(changes.map((change) => change.field)).size !== changes.length) fail('SCHEMA_INVALID', 'Preview fields are duplicated.');
    return { objectType: safe(item.objectType, 'objectType'), objectId: safe(item.objectId, 'objectId'), changes };
  }).sort((left, right) => `${left.objectType}\0${left.objectId}`.localeCompare(`${right.objectType}\0${right.objectId}`));
  if (new Set(normalizedObjects.map((item) => `${item.objectType}\0${item.objectId}`)).size !== normalizedObjects.length
    || Buffer.byteLength(JSON.stringify(normalizedObjects), 'utf8') > 12 * 1024) {
    fail('SCHEMA_INVALID', 'Preview objects are duplicated or exceed the bounded payload size.');
  }
  return freeze({ action: safe(value.action, 'action'), scope: normalizedScope, objects: normalizedObjects });
}

export async function createForgeBusinessDataDeniedPreview(proposal, trusted) {
  const normalized = validateBusinessDataPreviewProposal(proposal);
  exact(trusted, ['requestId', 'projectSlug', 'actorUserId', 'source', 'binding', 'requestedAt', 'expiresAt'], 'preview trusted context');
  exact(trusted.binding, ['taskId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest', 'executionId', 'generation', 'callId'], 'preview request binding');
  const binding = { ...trusted.binding };
  for (const key of ['taskId', 'conversationId', 'dshSessionId', 'rpcId', 'executionId', 'callId']) {
    if (typeof binding[key] !== 'string' || binding[key].length < 1 || binding[key].length > 256 || /[\p{Cc}]/u.test(binding[key])) {
      fail('SCHEMA_INVALID', 'Preview request identity is invalid.');
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(binding.textDigest ?? '') || !Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    fail('SCHEMA_INVALID', 'Preview execution generation or user text digest is invalid.');
  }
  const request = createForgeBusinessDataApprovalRequest({
    schemaVersion: 1, requestType: 'forge-business-data/approval-request', requestId: trusted.requestId,
    projectSlug: trusted.projectSlug, action: normalized.action,
    objects: normalized.objects.map((item) => ({
      objectType: item.objectType, objectId: item.objectId,
      beforeSha256: digest(Object.fromEntries(item.changes.map((change) => [change.field, change.before]))),
      afterSha256: digest(Object.fromEntries(item.changes.map((change) => [change.field, change.after]))),
      fields: item.changes.map((change) => change.field),
    })),
    scope: normalized.scope, actor: { actorUserId: trusted.actorUserId }, source: trusted.source,
    requestedAt: trusted.requestedAt, expiresAt: trusted.expiresAt,
  });
  const gate = await evaluateForgeBusinessDataApproval({ request, attestation: null, current: null });
  const preview = {
    schemaVersion: 1, previewType: 'forge-business-data/denied-preview',
    snapshotSource: 'caller-proposed/unverified', snapshotCoverage: 'listed-fields-only', databaseVerified: false,
    binding, request, objects: normalized.objects, gate, writerAuthorized: false,
  };
  return freeze({ ...preview, previewDigest: digest(preview) });
}
