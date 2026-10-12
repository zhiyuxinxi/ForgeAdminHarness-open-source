import { createHash } from 'node:crypto';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,255}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;
const TYPES = new Set(['menu', 'permission', 'table', 'api', 'dictionary', 'workflow', 'migration-version', 'table-column', 'ui-component']);
const MAX_LEASE_MS = 15 * 60 * 1000;

export class ForgeSemanticLeaseError extends Error {
  constructor(code, message) { super(message); this.name = 'ForgeSemanticLeaseError'; this.code = code; }
}
function fail(code, message) { throw new ForgeSemanticLeaseError(code, message); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, label) { if (!plain(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) fail('SCHEMA_INVALID', `${label} has unsupported or missing fields.`); }
function safe(value, label, pattern = SAFE) { if (typeof value !== 'string' || !pattern.test(value)) fail('SCHEMA_INVALID', `${label} is invalid.`); return value; }
function time(value, label) { const parsed = Date.parse(value); if (typeof value !== 'string' || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail('SCHEMA_INVALID', `${label} must be an ISO timestamp.`); return parsed; }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (!plain(value)) return value; return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); }
function digest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }
function freeze(value) { if (plain(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

function normalizeApi(value) {
  const match = /^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/iu.exec(value.trim());
  if (!match) fail('RESOURCE_INVALID', 'API semantic key must include an HTTP method and path.');
  let route = match[2].replace(/\{([^}/]+)\}/gu, ':$1').replace(/\/+/gu, '/');
  if (!route.startsWith('/') || route.includes('?') || route.includes('#')) fail('RESOURCE_INVALID', 'API semantic route is invalid.');
  if (route.length > 1) route = route.replace(/\/$/u, '');
  return `${match[1].toUpperCase()} ${route}`;
}
function normalizeResource(item) {
  exact(item, ['type', 'key'], 'semantic resource');
  if (!TYPES.has(item.type)) fail('RESOURCE_INVALID', `Unknown semantic resource type: ${String(item.type)}`);
  let key;
  if (item.type === 'api') {
    if (typeof item.key !== 'string' || item.key.length < 1 || item.key.length > 512) fail('RESOURCE_INVALID', 'API semantic key is invalid.');
    key = normalizeApi(item.key);
  } else if (item.type === 'table-column') {
    // Explicit SQL identity: table#column or schema.table#column. No file inference.
    key = safe(item.key, 'resource.key', /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*#[A-Za-z_][A-Za-z0-9_]*$/u).toLowerCase();
  } else if (item.type === 'migration-version') {
    // Case-sensitive namespace@version; version is an opaque declared identifier.
    key = safe(item.key, 'resource.key', /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u);
  } else if (item.type === 'ui-component') {
    // Case-sensitive namespace/component, not a source filename or path prefix.
    key = safe(item.key, 'resource.key', /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u);
  } else key = safe(item.key, 'resource.key').trim();
  if (item.type !== 'api' && key.length > 256) fail('RESOURCE_INVALID', 'Semantic resource key exceeds 256 characters.');
  if (['table', 'dictionary'].includes(item.type)) key = key.toLowerCase();
  return { type: item.type, key };
}
function resources(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) fail('RESOURCE_INVALID', 'Semantic resources must contain from 1 to 256 entries.');
  const normalized = value.map(normalizeResource).sort((left, right) => `${left.type}\0${left.key}`.localeCompare(`${right.type}\0${right.key}`));
  if (new Set(normalized.map((item) => `${item.type}\0${item.key}`)).size !== normalized.length) fail('RESOURCE_INVALID', 'Semantic resources contain duplicates.');
  return normalized;
}
export function normalizeForgeSemanticResources(value) { return freeze(resources(value)); }

export function forgeSemanticResourcesOverlap(leftArray, rightArray) {
  const normalize = value => Array.isArray(value) && value.length === 0 ? [] : resources(value);
  const left = normalize(leftArray); const right = normalize(rightArray);
  return left.some(a => right.some(b => (a.type === b.type && a.key === b.key)
    || (a.type === 'table' && b.type === 'table-column' && b.key.split('#')[0] === a.key)
    || (b.type === 'table' && a.type === 'table-column' && a.key.split('#')[0] === b.key)));
}
function ownedPaths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || !SAFE_PATH.test(item))) fail('SCHEMA_INVALID', 'ownedPaths are invalid.');
  const normalized = value.map((item) => item.split('/').filter((segment) => segment !== '' && segment !== '.').join('/'));
  if (normalized.some((item) => item.length === 0) || new Set(normalized).size !== normalized.length) fail('SCHEMA_INVALID', 'ownedPaths contain empty or equivalent paths.');
  return normalized.sort();
}
function pathsOverlap(left, right) { return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`); }
export { ownedPaths as normalizeForgeLeasePaths, pathsOverlap as forgeLeasePathsOverlap };
function unsigned(registry) { const { registryDigest, ...rest } = registry; return rest; }
function sealRegistry(input) { return freeze({ ...input, registryDigest: digest(input) }); }

export function createForgeSemanticLeaseRegistry(input) {
  exact(input, ['schemaVersion', 'registryType', 'projectSlug', 'sourceFingerprint'], 'lease registry input');
  if (input.schemaVersion !== 1 || input.registryType !== 'forge-semantic-resource/lease-registry') fail('SCHEMA_INVALID', 'lease registry header is invalid.');
  return sealRegistry({ schemaVersion: 1, registryType: input.registryType, projectSlug: safe(input.projectSlug, 'projectSlug'), sourceFingerprint: safe(input.sourceFingerprint, 'sourceFingerprint', SHA256), revision: 0, leases: [] });
}
function validateLease(item) {
  exact(item, ['leaseId', 'leaseVersion', 'taskId', 'actorUserId', 'ownedPaths', 'resources', 'acquiredAt', 'expiresAt'], 'lease');
  if (!Number.isSafeInteger(item.leaseVersion) || item.leaseVersion < 1) fail('SCHEMA_INVALID', 'leaseVersion is invalid.');
  const acquired = time(item.acquiredAt, 'acquiredAt'); const expires = time(item.expiresAt, 'expiresAt');
  if (expires <= acquired || expires - acquired > MAX_LEASE_MS) fail('SCHEMA_INVALID', 'lease duration is invalid.');
  return { leaseId: safe(item.leaseId, 'leaseId', UUID), leaseVersion: item.leaseVersion, taskId: safe(item.taskId, 'taskId'), actorUserId: safe(item.actorUserId, 'actorUserId', UUID), ownedPaths: ownedPaths(item.ownedPaths), resources: resources(item.resources), acquiredAt: item.acquiredAt, expiresAt: item.expiresAt };
}
function validateRegistry(value) {
  exact(value, ['schemaVersion', 'registryType', 'projectSlug', 'sourceFingerprint', 'revision', 'leases', 'registryDigest'], 'lease registry');
  if (value.schemaVersion !== 1 || value.registryType !== 'forge-semantic-resource/lease-registry' || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.leases)) fail('SCHEMA_INVALID', 'lease registry is invalid.');
  const normalized = { schemaVersion: 1, registryType: value.registryType, projectSlug: safe(value.projectSlug, 'projectSlug'), sourceFingerprint: safe(value.sourceFingerprint, 'sourceFingerprint', SHA256), revision: value.revision, leases: value.leases.map(validateLease).sort((left, right) => left.leaseId.localeCompare(right.leaseId)) };
  if (new Set(normalized.leases.map((item) => item.leaseId)).size !== normalized.leases.length || digest(normalized) !== value.registryDigest) fail('REGISTRY_INTEGRITY_INVALID', 'lease registry digest is invalid.');
  return freeze({ ...normalized, registryDigest: value.registryDigest });
}
function cas(registry, expectedRevision) { if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== registry.revision) fail('REGISTRY_CAS_CONFLICT', 'Lease registry revision is stale.'); }
function transition(registry, leases) { const input = { ...unsigned(registry), revision: registry.revision + 1, leases: [...leases].sort((left, right) => left.leaseId.localeCompare(right.leaseId)) }; const next = sealRegistry(input); return freeze({ registry: next, cas: { expectedRevision: registry.revision, expectedDigest: registry.registryDigest, nextRevision: next.revision, nextDigest: next.registryDigest }, writerAuthorized: false }); }

export function acquireForgeSemanticResourceLease(registryInput, request) {
  const registry = validateRegistry(registryInput);
  exact(request, ['expectedRevision', 'leaseId', 'taskId', 'actorUserId', 'ownedPaths', 'resources', 'acquiredAt', 'expiresAt'], 'lease acquire request');
  cas(registry, request.expectedRevision); const acquired = time(request.acquiredAt, 'acquiredAt'); const expires = time(request.expiresAt, 'expiresAt');
  if (expires <= acquired || expires - acquired > MAX_LEASE_MS) fail('SCHEMA_INVALID', 'lease duration is invalid.');
  const active = registry.leases.filter((item) => Date.parse(item.expiresAt) > acquired);
  const requestedResources = resources(request.resources);
  const conflicts = active.filter((lease) => forgeSemanticResourcesOverlap(lease.resources, requestedResources));
  if (conflicts.length > 0) fail('SEMANTIC_RESOURCE_CONFLICT', `Semantic resources are already leased by ${conflicts.map((item) => item.taskId).join(', ')}.`);
  const requestedPaths = ownedPaths(request.ownedPaths);
  const pathConflicts = active.filter((lease) => lease.ownedPaths.some((owned) => requestedPaths.some((requested) => pathsOverlap(owned, requested))));
  if (pathConflicts.length > 0) fail('PATH_RESOURCE_CONFLICT', `Owned paths are already leased by ${pathConflicts.map((item) => item.taskId).join(', ')}.`);
  const lease = validateLease({ leaseId: request.leaseId, leaseVersion: 1, taskId: request.taskId, actorUserId: request.actorUserId, ownedPaths: requestedPaths, resources: requestedResources, acquiredAt: request.acquiredAt, expiresAt: request.expiresAt });
  return transition(registry, [...active, lease]);
}

export function renewForgeSemanticResourceLease(registryInput, request) {
  const registry = validateRegistry(registryInput);
  exact(request, ['expectedRevision', 'leaseId', 'expectedLeaseVersion', 'taskId', 'actorUserId', 'observedAt', 'expiresAt'], 'lease renew request');
  cas(registry, request.expectedRevision); const observed = time(request.observedAt, 'observedAt'); const expires = time(request.expiresAt, 'expiresAt');
  const lease = registry.leases.find((item) => item.leaseId === request.leaseId);
  if (!lease) fail('LEASE_NOT_FOUND', 'Lease does not exist.');
  if (lease.taskId !== request.taskId || lease.actorUserId !== request.actorUserId) fail('LEASE_OWNER_MISMATCH', 'Lease owner does not match.');
  if (lease.leaseVersion !== request.expectedLeaseVersion) fail('LEASE_CAS_CONFLICT', 'Lease version is stale.');
  if (Date.parse(lease.expiresAt) <= observed) fail('LEASE_EXPIRED', 'Expired leases cannot be renewed.');
  if (expires <= observed || expires - observed > MAX_LEASE_MS) fail('SCHEMA_INVALID', 'Renewed lease duration is invalid.');
  const renewed = { ...lease, leaseVersion: lease.leaseVersion + 1, acquiredAt: request.observedAt, expiresAt: request.expiresAt };
  return transition(registry, registry.leases.map((item) => item.leaseId === lease.leaseId ? renewed : item));
}

export function releaseForgeSemanticResourceLease(registryInput, request) {
  const registry = validateRegistry(registryInput);
  exact(request, ['expectedRevision', 'leaseId', 'expectedLeaseVersion', 'taskId', 'actorUserId'], 'lease release request');
  cas(registry, request.expectedRevision); const lease = registry.leases.find((item) => item.leaseId === request.leaseId);
  if (!lease) fail('LEASE_NOT_FOUND', 'Lease does not exist.');
  if (lease.taskId !== request.taskId || lease.actorUserId !== request.actorUserId) fail('LEASE_OWNER_MISMATCH', 'Lease owner does not match.');
  if (lease.leaseVersion !== request.expectedLeaseVersion) fail('LEASE_CAS_CONFLICT', 'Lease version is stale.');
  return transition(registry, registry.leases.filter((item) => item.leaseId !== lease.leaseId));
}
