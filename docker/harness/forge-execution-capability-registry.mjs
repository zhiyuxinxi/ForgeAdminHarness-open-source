import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXECUTION_CAPABILITY_SCHEMA_VERSION = 1;
export const EXECUTION_PROOF_LEVELS = Object.freeze(['declared', 'static', 'runtime', 'independent']);
export const EXECUTION_BLOCKING_STAGES = Object.freeze([
  'DISCOVER', 'MUTATE', 'VERIFY', 'ACCEPT', 'CLOSEOUT', 'RELEASE',
]);

const SAFE_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const REGISTRY_KEYS = ['blockingStages', 'capabilities', 'demandProfiles', 'proofLevels', 'registryVersion', 'schemaVersion'];
const CAPABILITY_KEYS = ['blockingStage', 'capabilityId', 'dependsOn', 'minimumProofLevel', 'summary'];
const PROFILE_KEYS = ['capabilityIds', 'profileId'];
const MODULE_DIRECTORY = fileURLToPath(new URL('./', import.meta.url));
const PACKAGED_SHARE_DIRECTORY = path.basename(MODULE_DIRECTORY) === 'lib'
  && path.basename(path.dirname(MODULE_DIRECTORY)) === 'local'
  ? path.resolve(MODULE_DIRECTORY, '..', 'share')
  : MODULE_DIRECTORY;
const DEFAULT_REGISTRY_PATH = path.join(PACKAGED_SHARE_DIRECTORY, 'forge-execution-capability-registry.json');

export class ForgeExecutionCapabilityRegistryError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeExecutionCapabilityRegistryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeExecutionCapabilityRegistryError(code, message);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, location) {
  if (!plainObject(value)) fail('EXECUTION_CAPABILITY_SCHEMA_INVALID', `${location} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail('EXECUTION_CAPABILITY_UNSUPPORTED_FIELD', `${location} has missing or unsupported fields.`);
  }
}

function canonicalValue(value, location = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('EXECUTION_CAPABILITY_CANONICAL_INVALID', `${location} is not a canonical number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${location}[${index}]`));
  if (!plainObject(value)) fail('EXECUTION_CAPABILITY_CANONICAL_INVALID', `${location} must be canonical JSON data.`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('EXECUTION_CAPABILITY_CANONICAL_INVALID', `${location}.${key} is undefined.`);
    result[key] = canonicalValue(value[key], `${location}.${key}`);
  }
  return result;
}

export function canonicalExecutionCapabilityJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalExecutionCapabilityDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalExecutionCapabilityJson(value), 'utf8').digest('hex')}`;
}

function stringArray(value, location, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail('EXECUTION_CAPABILITY_SCHEMA_INVALID', `${location} must be ${allowEmpty ? 'an' : 'a non-empty'} array.`);
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !SAFE_ID.test(item)) fail('EXECUTION_CAPABILITY_SCHEMA_INVALID', `${location}[${index}] is invalid.`);
  });
  if (new Set(value).size !== value.length) fail('EXECUTION_CAPABILITY_DUPLICATE', `${location} contains duplicates.`);
  return value;
}

function assertSorted(value, location) {
  const sorted = [...value].sort();
  if (value.some((item, index) => item !== sorted[index])) {
    fail('EXECUTION_CAPABILITY_NON_CANONICAL', `${location} must be lexically sorted.`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function visitDag(capabilityId, byId, colors, order) {
  const color = colors.get(capabilityId) ?? 0;
  if (color === 1) fail('EXECUTION_CAPABILITY_DAG_CYCLE', `Capability DAG contains a cycle at ${capabilityId}.`);
  if (color === 2) return;
  colors.set(capabilityId, 1);
  for (const dependencyId of byId.get(capabilityId).dependsOn) visitDag(dependencyId, byId, colors, order);
  colors.set(capabilityId, 2);
  order.push(capabilityId);
}

export function validateExecutionCapabilityRegistry(registry) {
  exactKeys(registry, REGISTRY_KEYS, 'registry');
  if (registry.schemaVersion !== EXECUTION_CAPABILITY_SCHEMA_VERSION) {
    fail('EXECUTION_CAPABILITY_VERSION_UNSUPPORTED', 'Execution capability registry schemaVersion is unsupported.');
  }
  if (typeof registry.registryVersion !== 'string' || !/^\d{4}\.\d{2}\.\d{2}\.\d+$/u.test(registry.registryVersion)) {
    fail('EXECUTION_CAPABILITY_SCHEMA_INVALID', 'registry.registryVersion is invalid.');
  }
  if (canonicalExecutionCapabilityJson(registry.proofLevels) !== canonicalExecutionCapabilityJson(EXECUTION_PROOF_LEVELS)
    || canonicalExecutionCapabilityJson(registry.blockingStages) !== canonicalExecutionCapabilityJson(EXECUTION_BLOCKING_STAGES)) {
    fail('EXECUTION_CAPABILITY_ENUM_DRIFT', 'Registry proof levels or blocking stages differ from the executable contract.');
  }
  if (!Array.isArray(registry.capabilities) || registry.capabilities.length === 0) {
    fail('EXECUTION_CAPABILITY_SCHEMA_INVALID', 'registry.capabilities must be a non-empty array.');
  }
  const byId = new Map();
  for (const [index, capability] of registry.capabilities.entries()) {
    exactKeys(capability, CAPABILITY_KEYS, `registry.capabilities[${index}]`);
    if (typeof capability.capabilityId !== 'string' || !SAFE_ID.test(capability.capabilityId)) {
      fail('EXECUTION_CAPABILITY_SCHEMA_INVALID', `registry.capabilities[${index}].capabilityId is invalid.`);
    }
    if (byId.has(capability.capabilityId)) fail('EXECUTION_CAPABILITY_DUPLICATE', `Duplicate capability ${capability.capabilityId}.`);
    if (typeof capability.summary !== 'string' || capability.summary.trim().length < 20) {
      fail('EXECUTION_CAPABILITY_SCHEMA_INVALID', `${capability.capabilityId}.summary is too short.`);
    }
    stringArray(capability.dependsOn, `${capability.capabilityId}.dependsOn`, { allowEmpty: true });
    assertSorted(capability.dependsOn, `${capability.capabilityId}.dependsOn`);
    if (!EXECUTION_PROOF_LEVELS.includes(capability.minimumProofLevel)) {
      fail('EXECUTION_CAPABILITY_PROOF_LEVEL_INVALID', `${capability.capabilityId}.minimumProofLevel is invalid.`);
    }
    if (!EXECUTION_BLOCKING_STAGES.includes(capability.blockingStage)) {
      fail('EXECUTION_CAPABILITY_BLOCKING_STAGE_INVALID', `${capability.capabilityId}.blockingStage is invalid.`);
    }
    byId.set(capability.capabilityId, capability);
  }
  for (const capability of registry.capabilities) {
    for (const dependencyId of capability.dependsOn) {
      if (!byId.has(dependencyId)) fail('EXECUTION_CAPABILITY_DEPENDENCY_UNKNOWN', `${capability.capabilityId} depends on unknown ${dependencyId}.`);
      if (dependencyId === capability.capabilityId) fail('EXECUTION_CAPABILITY_DAG_CYCLE', `${capability.capabilityId} depends on itself.`);
      const dependency = byId.get(dependencyId);
      if (EXECUTION_BLOCKING_STAGES.indexOf(dependency.blockingStage) > EXECUTION_BLOCKING_STAGES.indexOf(capability.blockingStage)) {
        fail('EXECUTION_CAPABILITY_STAGE_INVERSION', `${capability.capabilityId} depends on later-stage ${dependencyId}.`);
      }
    }
  }
  const dagOrder = [];
  const colors = new Map();
  for (const capabilityId of [...byId.keys()].sort()) visitDag(capabilityId, byId, colors, dagOrder);

  if (!Array.isArray(registry.demandProfiles) || registry.demandProfiles.length === 0) {
    fail('EXECUTION_CAPABILITY_SCHEMA_INVALID', 'registry.demandProfiles must be a non-empty array.');
  }
  const profileIds = new Set();
  for (const [index, profile] of registry.demandProfiles.entries()) {
    exactKeys(profile, PROFILE_KEYS, `registry.demandProfiles[${index}]`);
    if (typeof profile.profileId !== 'string' || !SAFE_ID.test(profile.profileId)) {
      fail('EXECUTION_CAPABILITY_SCHEMA_INVALID', `registry.demandProfiles[${index}].profileId is invalid.`);
    }
    if (profileIds.has(profile.profileId)) fail('EXECUTION_CAPABILITY_DUPLICATE', `Duplicate demand profile ${profile.profileId}.`);
    profileIds.add(profile.profileId);
    stringArray(profile.capabilityIds, `${profile.profileId}.capabilityIds`);
    assertSorted(profile.capabilityIds, `${profile.profileId}.capabilityIds`);
    for (const capabilityId of profile.capabilityIds) {
      if (!byId.has(capabilityId)) fail('EXECUTION_CAPABILITY_DEMAND_UNKNOWN', `${profile.profileId} demands unknown ${capabilityId}.`);
    }
  }
  const normalized = {
    ...structuredClone(registry),
    capabilities: structuredClone(registry.capabilities)
      .sort((left, right) => left.capabilityId.localeCompare(right.capabilityId)),
    demandProfiles: structuredClone(registry.demandProfiles)
      .sort((left, right) => left.profileId.localeCompare(right.profileId)),
  };
  return deepFreeze({
    ...normalized,
    registryDigest: canonicalExecutionCapabilityDigest(normalized),
    dagOrder: Object.freeze(dagOrder),
  });
}

export async function loadCurrentExecutionCapabilityRegistry(options = {}) {
  if (!plainObject(options) || Object.keys(options).some((key) => key !== 'registryPath')) {
    fail('EXECUTION_CAPABILITY_UNSUPPORTED_FIELD', 'options contains unsupported fields.');
  }
  if (options.registryPath !== undefined && (typeof options.registryPath !== 'string' || options.registryPath.length === 0)) {
    fail('EXECUTION_CAPABILITY_SCHEMA_INVALID', 'options.registryPath must be a non-empty string.');
  }
  const content = await readFile(options.registryPath ?? DEFAULT_REGISTRY_PATH, 'utf8');
  let registry;
  try {
    registry = JSON.parse(content);
  } catch {
    fail('EXECUTION_CAPABILITY_JSON_INVALID', 'Execution capability registry is not valid JSON.');
  }
  return validateExecutionCapabilityRegistry(registry);
}
