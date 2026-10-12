import { createHash } from 'node:crypto';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HEAD = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export class ForgeBusinessObjectMutationError extends Error {
  constructor(code, message) { super(message); this.name = 'ForgeBusinessObjectMutationError'; this.code = code; }
}
function fail(code, message) { throw new ForgeBusinessObjectMutationError(code, message); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, label) { if (!plain(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) fail('SCHEMA_INVALID', `${label} has unsupported or missing fields.`); }
function safe(value, label, pattern = SAFE) { if (typeof value !== 'string' || !pattern.test(value)) fail('SCHEMA_INVALID', `${label} is invalid.`); return value; }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (!plain(value)) return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); }
function digest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }
function freeze(value) { if (plain(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function timestamp(value, label) { const parsed = Date.parse(value); if (typeof value !== 'string' || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail('SCHEMA_INVALID', `${label} must be an ISO timestamp.`); return parsed; }
function source(value) { exact(value, ['head', 'fingerprint'], 'source'); return { head: safe(value.head, 'source.head', HEAD), fingerprint: safe(value.fingerprint, 'source.fingerprint', SHA256) }; }
function concurrency(value, contentSha256) {
  exact(value, ['mode', 'token'], 'concurrency');
  if (!['etag', 'version', 'content-hash'].includes(value.mode) || typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 512) fail('SCHEMA_INVALID', 'concurrency token is invalid.');
  if (value.mode === 'content-hash' && value.token !== contentSha256) fail('SCHEMA_INVALID', 'content-hash concurrency token must equal the canonical content digest.');
  return { mode: value.mode, token: value.token };
}
function fields(value) {
  if (!Array.isArray(value) || value.length === 0) fail('SCHEMA_INVALID', 'snapshot fields must be non-empty.');
  const normalized = value.map((item) => { exact(item, ['field', 'valueSha256', 'mutable'], 'snapshot field'); if (typeof item.mutable !== 'boolean') fail('SCHEMA_INVALID', 'snapshot field mutable flag is invalid.'); return { field: safe(item.field, 'field'), valueSha256: safe(item.valueSha256, 'field.valueSha256', SHA256), mutable: item.mutable }; }).sort((left, right) => left.field.localeCompare(right.field));
  if (new Set(normalized.map((item) => item.field)).size !== normalized.length) fail('SCHEMA_INVALID', 'snapshot fields contain duplicates.');
  return normalized;
}

export function sealForgeBusinessObjectSnapshot(input) {
  exact(input, ['schemaVersion', 'snapshotType', 'projectSlug', 'objectType', 'objectId', 'tenantId', 'fields', 'concurrency', 'source', 'observedAt'], 'object snapshot');
  if (input.schemaVersion !== 1 || input.snapshotType !== 'forge-business-object/snapshot') fail('SCHEMA_INVALID', 'object snapshot header is invalid.');
  timestamp(input.observedAt, 'observedAt');
  const normalizedFields = fields(input.fields); const contentSha256 = digest(normalizedFields);
  const normalized = { schemaVersion: 1, snapshotType: input.snapshotType, projectSlug: safe(input.projectSlug, 'projectSlug'), objectType: safe(input.objectType, 'objectType'), objectId: safe(input.objectId, 'objectId'), tenantId: safe(input.tenantId, 'tenantId'), fields: normalizedFields, concurrency: concurrency(input.concurrency, contentSha256), source: source(input.source), observedAt: input.observedAt, contentSha256 };
  return freeze({ ...normalized, snapshotDigest: digest(normalized) });
}

function validateSnapshot(value) {
  exact(value, ['schemaVersion', 'snapshotType', 'projectSlug', 'objectType', 'objectId', 'tenantId', 'fields', 'concurrency', 'source', 'observedAt', 'contentSha256', 'snapshotDigest'], 'sealed snapshot');
  const { contentSha256, snapshotDigest, ...input } = value; const sealed = sealForgeBusinessObjectSnapshot(input);
  if (sealed.contentSha256 !== contentSha256 || sealed.snapshotDigest !== snapshotDigest) fail('SNAPSHOT_INTEGRITY_INVALID', 'object snapshot digest is invalid.');
  return sealed;
}

function normalizeAfterFields(value) {
  if (!Array.isArray(value) || value.length === 0) fail('SCHEMA_INVALID', 'replacement fields are invalid.');
  const normalized = value.map((item) => { exact(item, ['field', 'valueSha256'], 'replacement field'); return { field: safe(item.field, 'replacement.field'), valueSha256: safe(item.valueSha256, 'replacement.valueSha256', SHA256) }; }).sort((left, right) => left.field.localeCompare(right.field));
  if (new Set(normalized.map((item) => item.field)).size !== normalized.length) fail('SCHEMA_INVALID', 'replacement fields contain duplicates.');
  return normalized;
}

export function createForgeBusinessObjectMutationPlan(input) {
  exact(input, ['schemaVersion', 'planType', 'planId', 'mode', 'baselineSnapshot', 'patchChanges', 'replacementFields'], 'mutation plan input');
  if (input.schemaVersion !== 1 || input.planType !== 'forge-business-object/mutation-plan' || !['patch', 'replace'].includes(input.mode)) fail('SCHEMA_INVALID', 'mutation plan header is invalid.');
  const baseline = validateSnapshot(input.baselineSnapshot); const byField = new Map(baseline.fields.map((item) => [item.field, item]));
  let patchChanges = []; let replacementFields = [];
  if (input.mode === 'patch') {
    if (!Array.isArray(input.patchChanges) || input.patchChanges.length === 0 || input.replacementFields !== null) fail('SCHEMA_INVALID', 'patch plan shape is invalid.');
    patchChanges = input.patchChanges.map((item) => { exact(item, ['field', 'beforeSha256', 'afterSha256'], 'patch change'); const field = safe(item.field, 'patch.field'); const baselineField = byField.get(field); if (!baselineField) fail('PATCH_FIELD_UNKNOWN', `Patch field is unknown: ${field}`); if (!baselineField.mutable) fail('PATCH_FIELD_IMMUTABLE', `Patch field is immutable: ${field}`); if (item.beforeSha256 !== baselineField.valueSha256 || !SHA256.test(item.afterSha256 ?? '') || item.afterSha256 === item.beforeSha256) fail('PATCH_PREIMAGE_INVALID', `Patch pre-image or post-image is invalid: ${field}`); return { field, beforeSha256: item.beforeSha256, afterSha256: item.afterSha256 }; }).sort((left, right) => left.field.localeCompare(right.field));
    if (new Set(patchChanges.map((item) => item.field)).size !== patchChanges.length) fail('SCHEMA_INVALID', 'patch fields contain duplicates.');
  } else {
    if (input.patchChanges !== null) fail('SCHEMA_INVALID', 'replace plan cannot contain patch changes.');
    replacementFields = normalizeAfterFields(input.replacementFields);
    const baselineNames = baseline.fields.map((item) => item.field); const afterNames = replacementFields.map((item) => item.field);
    if (JSON.stringify(baselineNames) !== JSON.stringify(afterNames)) fail('REPLACE_INCOMPLETE', 'Full replacement must preserve the complete observed field set.');
    let changed = 0;
    for (const after of replacementFields) { const before = byField.get(after.field); if (!before.mutable && before.valueSha256 !== after.valueSha256) fail('REPLACE_IMMUTABLE_CHANGED', `Full replacement changes immutable field: ${after.field}`); if (before.valueSha256 !== after.valueSha256) changed += 1; }
    if (changed === 0) fail('SCHEMA_INVALID', 'Full replacement does not change the object.');
  }
  const normalized = { schemaVersion: 1, planType: input.planType, planId: safe(input.planId, 'planId', UUID), mode: input.mode, locator: { projectSlug: baseline.projectSlug, objectType: baseline.objectType, objectId: baseline.objectId, tenantId: baseline.tenantId }, baselineSnapshotDigest: baseline.snapshotDigest, expectedConcurrency: baseline.concurrency, patchChanges, replacementFields };
  return freeze({ ...normalized, planDigest: digest(normalized) });
}

function validatePlan(value) {
  exact(value, ['schemaVersion', 'planType', 'planId', 'mode', 'locator', 'baselineSnapshotDigest', 'expectedConcurrency', 'patchChanges', 'replacementFields', 'planDigest'], 'sealed mutation plan');
  if (!SHA256.test(value.baselineSnapshotDigest ?? '') || !SHA256.test(value.planDigest ?? '')) fail('SCHEMA_INVALID', 'mutation plan digests are invalid.');
  const { planDigest, ...unsigned } = value;
  if (digest(unsigned) !== planDigest) fail('PLAN_INTEGRITY_INVALID', 'mutation plan digest is invalid.');
  return value;
}

function observation(value, label) {
  exact(value, ['found', 'locator', 'snapshot', 'attestation'], label);
  exact(value.locator, ['projectSlug', 'objectType', 'objectId', 'tenantId'], `${label}.locator`);
  const locator = Object.fromEntries(Object.entries(value.locator).map(([key, item]) => [key, safe(item, `${label}.${key}`)]));
  if (typeof value.found !== 'boolean' || typeof value.attestation !== 'object' || value.attestation === null) fail('SCHEMA_INVALID', `${label} is invalid.`);
  const snapshot = value.found ? validateSnapshot(value.snapshot) : value.snapshot === null ? null : fail('SCHEMA_INVALID', `${label} not-found observation cannot contain a snapshot.`);
  if (snapshot && JSON.stringify(locator) !== JSON.stringify({ projectSlug: snapshot.projectSlug, objectType: snapshot.objectType, objectId: snapshot.objectId, tenantId: snapshot.tenantId })) fail('OBSERVATION_BINDING_INVALID', `${label} locator does not match its snapshot.`);
  return { found: value.found, locator, snapshot, attestation: value.attestation };
}
function blocked(reasonCode) { return freeze({ status: 'blocked', reasonCode, mutationValid: false, writerAuthorized: false }); }

export async function evaluateForgeBusinessObjectMutation(input, protectedContext = {}) {
  exact(input, ['baseline', 'current', 'plan'], 'mutation evaluation');
  const baseline = observation(input.baseline, 'baseline observation'); const current = observation(input.current, 'current observation'); const plan = validatePlan(input.plan);
  if (!baseline.found) return blocked('UNKNOWN_OBJECT');
  if (typeof protectedContext.verifyProtectedObjectObservation !== 'function') return blocked('PROTECTED_OBJECT_READER_REQUIRED');
  let baselineVerified = false; let currentVerified = false;
  try { baselineVerified = await protectedContext.verifyProtectedObjectObservation(baseline); currentVerified = await protectedContext.verifyProtectedObjectObservation(current); } catch { return blocked('PROTECTED_OBJECT_READER_FAILED'); }
  if (baselineVerified !== true || currentVerified !== true) return blocked('PROTECTED_OBJECT_READER_FAILED');
  if (!current.found) return blocked('UNKNOWN_OBJECT');
  const reconstructedPlan = createForgeBusinessObjectMutationPlan({
    schemaVersion: plan.schemaVersion,
    planType: plan.planType,
    planId: plan.planId,
    mode: plan.mode,
    baselineSnapshot: baseline.snapshot,
    patchChanges: plan.mode === 'patch' ? plan.patchChanges : null,
    replacementFields: plan.mode === 'replace' ? plan.replacementFields : null,
  });
  if (JSON.stringify(reconstructedPlan) !== JSON.stringify(plan)) return blocked('PLAN_BASELINE_STALE');
  if (JSON.stringify(baseline.locator) !== JSON.stringify(current.locator) || JSON.stringify(plan.locator) !== JSON.stringify(current.locator)) return blocked('OBJECT_BINDING_STALE');
  if (plan.baselineSnapshotDigest !== baseline.snapshot.snapshotDigest) return blocked('PLAN_BASELINE_STALE');
  if (JSON.stringify(plan.expectedConcurrency) !== JSON.stringify(baseline.snapshot.concurrency)) return blocked('PLAN_BASELINE_STALE');
  if (current.snapshot.contentSha256 !== baseline.snapshot.contentSha256
      || JSON.stringify(current.snapshot.concurrency) !== JSON.stringify(baseline.snapshot.concurrency)
      || JSON.stringify(current.snapshot.source) !== JSON.stringify(baseline.snapshot.source)) return blocked('STALE_OBJECT');
  return freeze({ status: 'mutation-valid-not-writer-authority', reasonCode: 'FRESH_OBJECT_PLAN_VALID', mutationValid: true, writerAuthorized: false, requiresProtectedAtomicCompareAndWrite: true, planDigest: plan.planDigest, expectedConcurrency: plan.expectedConcurrency });
}
