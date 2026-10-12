import { createHash } from 'node:crypto';

export const FORGE_PROGRESS_DETECTOR_SCHEMA_VERSION = 2;
export const PROGRESS_DECISIONS = Object.freeze([
  'CONTINUE',
  'SWITCH_TO_IMPLEMENT',
  'STOP',
  'ESCALATE_AT_IMMUTABLE_BOUNDARY',
  'RESERVE_CLOSEOUT',
]);

const PHASES = new Set([
  'DISCOVER', 'DESIGN', 'RED_GATE', 'IMPLEMENT_INCREMENT', 'INCREMENT_GATE',
  'VERIFY_AFFECTED', 'REPAIR', 'ACCEPTANCE', 'CLOSEOUT',
]);
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;

export class ForgeProgressDetectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeProgressDetectorError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeProgressDetectorError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('PROGRESS_INPUT_INVALID', `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function safeKeys(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || value.length > 256 || (!allowEmpty && value.length === 0)) {
    fail('PROGRESS_INPUT_INVALID', `${label} must be a bounded array.`);
  }
  const normalized = value.map((entry) => {
    if (typeof entry !== 'string' || !SAFE_KEY.test(entry)) {
      fail('PROGRESS_INPUT_INVALID', `${label} contains an invalid progress key.`);
    }
    return entry;
  });
  if (new Set(normalized).size !== normalized.length) {
    fail('PROGRESS_INPUT_INVALID', `${label} contains duplicate progress keys.`);
  }
  return normalized;
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (!plainObject(value)) fail('PROGRESS_NOT_SERIALIZABLE', 'Only canonical JSON values are supported.');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('PROGRESS_NOT_SERIALIZABLE', `Undefined field ${key}.`);
    result[key] = canonical(value[key]);
  }
  return result;
}

function seal(value) {
  const normalized = canonical(value);
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex')}`;
  return Object.freeze({ ...normalized, digest });
}

function normalizeObservation(value, index) {
  if (!plainObject(value)) fail('PROGRESS_INPUT_INVALID', `observations[${index}] must be an object.`);
  const allowed = new Set([
    'requestOrdinal', 'toolCallOrdinal', 'progressKeys', 'actionDigest', 'resultDigest',
    'dependencyBlocked', 'capabilityProbe', 'safetyViolation',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    fail('PROGRESS_INPUT_INVALID', `observations[${index}] contains an unsupported field.`);
  }
  const digestField = (field) => {
    if (value[field] !== null && value[field] !== undefined
        && (typeof value[field] !== 'string' || !DIGEST.test(value[field]))) {
      fail('PROGRESS_INPUT_INVALID', `observations[${index}].${field} is invalid.`);
    }
    return value[field] ?? null;
  };
  for (const field of ['dependencyBlocked', 'capabilityProbe', 'safetyViolation']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') {
      fail('PROGRESS_INPUT_INVALID', `observations[${index}].${field} must be boolean.`);
    }
  }
  return {
    requestOrdinal: boundedInteger(value.requestOrdinal, 0, 1_000_000, `observations[${index}].requestOrdinal`),
    toolCallOrdinal: boundedInteger(value.toolCallOrdinal, 0, 1_000_000, `observations[${index}].toolCallOrdinal`),
    progressKeys: safeKeys(value.progressKeys ?? [], `observations[${index}].progressKeys`),
    actionDigest: digestField('actionDigest'),
    resultDigest: digestField('resultDigest'),
    dependencyBlocked: value.dependencyBlocked === true,
    capabilityProbe: value.capabilityProbe === true,
    safetyViolation: value.safetyViolation === true,
  };
}

export function detectExecutionProgress({
  phase,
  counters,
  limits,
  observations = [],
  requiredProgressKeys = [],
  reservedCloseoutRequests = 2,
  maximumNoProgressObservations = 3,
  maximumRepeatedActionResults = 2,
  suspendHeuristicStops = false,
} = {}) {
  if (!PHASES.has(phase) || !plainObject(counters) || !plainObject(limits)) {
    fail('PROGRESS_INPUT_INVALID', 'phase, counters, and limits are required.');
  }
  const normalizedCounters = {};
  const normalizedLimits = {};
  for (const dimension of ['requests', 'toolCalls', 'mutations']) {
    normalizedCounters[dimension] = boundedInteger(counters[dimension], 0, 1_000_000, `counters.${dimension}`);
    normalizedLimits[dimension] = boundedInteger(limits[dimension], 0, 1_000_000, `limits.${dimension}`);
  }
  boundedInteger(reservedCloseoutRequests, 0, normalizedLimits.requests, 'reservedCloseoutRequests');
  boundedInteger(maximumNoProgressObservations, 1, 100, 'maximumNoProgressObservations');
  boundedInteger(maximumRepeatedActionResults, 2, 100, 'maximumRepeatedActionResults');
  if (!Array.isArray(observations) || observations.length > 10_000) {
    fail('PROGRESS_INPUT_INVALID', 'observations must be a bounded array.');
  }
  const normalizedObservations = observations.map(normalizeObservation).sort((left, right) => (
    left.requestOrdinal - right.requestOrdinal || left.toolCallOrdinal - right.toolCallOrdinal
  ));
  const required = safeKeys(requiredProgressKeys, 'requiredProgressKeys');
  const coverage = new Set();
  const repeated = new Map();
  let noProgressStreak = 0;
  let longestNoProgressStreak = 0;
  let maximumRepeat = 0;
  let dependencyBlockedSeen = false;
  let capabilityProbeAfterBlocker = false;
  let safetyViolation = false;
  for (const observation of normalizedObservations) {
    const before = coverage.size;
    for (const key of observation.progressKeys) coverage.add(key);
    const advanced = coverage.size > before;
    if (advanced) {
      noProgressStreak = 0;
      repeated.clear();
      maximumRepeat = 0;
    } else {
      noProgressStreak += 1;
    }
    longestNoProgressStreak = Math.max(longestNoProgressStreak, noProgressStreak);
    if (observation.actionDigest !== null && observation.resultDigest !== null) {
      const pair = `${observation.actionDigest}:${observation.resultDigest}`;
      const count = (repeated.get(pair) ?? 0) + 1;
      repeated.set(pair, count);
      maximumRepeat = Math.max(maximumRepeat, count);
    }
    if (dependencyBlockedSeen && observation.capabilityProbe) capabilityProbeAfterBlocker = true;
    if (observation.dependencyBlocked) dependencyBlockedSeen = true;
    if (observation.safetyViolation) safetyViolation = true;
  }
  const missingProgressKeys = required.filter((key) => !coverage.has(key)).sort();
  const remaining = Object.fromEntries(Object.keys(normalizedLimits).map((dimension) => [
    dimension, Math.max(0, normalizedLimits[dimension] - normalizedCounters[dimension]),
  ]));
  const canSwitchToImplementation = normalizedCounters.mutations === 0
    && normalizedLimits.mutations > 0
    && ['DISCOVER', 'DESIGN', 'RED_GATE'].includes(phase);
  let decision = 'CONTINUE';
  const reasonCodes = [];
  let immutableBoundary = false;
  if (safetyViolation) {
    decision = 'STOP';
    reasonCodes.push('SAFETY_VIOLATION');
  } else if (capabilityProbeAfterBlocker) {
    decision = 'STOP';
    reasonCodes.push('CAPABILITY_PROBE_AFTER_TYPED_BLOCKER');
  } else if (!suspendHeuristicStops && maximumRepeat >= maximumRepeatedActionResults) {
    decision = canSwitchToImplementation ? 'SWITCH_TO_IMPLEMENT' : 'STOP';
    reasonCodes.push('REPEATED_ACTION_RESULT_NO_PROGRESS');
  } else if (!suspendHeuristicStops && noProgressStreak >= maximumNoProgressObservations) {
    decision = canSwitchToImplementation ? 'SWITCH_TO_IMPLEMENT' : 'STOP';
    reasonCodes.push('NO_MACHINE_OBSERVABLE_PROGRESS');
  } else if (phase === 'DISCOVER' && missingProgressKeys.length > 0
      && normalizedCounters.requests >= normalizedLimits.requests) {
    decision = normalizedCounters.mutations === 0
      ? 'ESCALATE_AT_IMMUTABLE_BOUNDARY' : 'STOP';
    immutableBoundary = normalizedCounters.mutations === 0;
    reasonCodes.push('DISCOVERY_GATE_INCOMPLETE');
  } else if (Object.keys(normalizedLimits).some(
    (dimension) => normalizedLimits[dimension] > 0
      && normalizedCounters[dimension] >= normalizedLimits[dimension],
  )) {
    decision = 'STOP';
    reasonCodes.push('PHASE_BUDGET_EXHAUSTED');
  } else if (!suspendHeuristicStops && phase !== 'CLOSEOUT' && remaining.requests <= reservedCloseoutRequests) {
    decision = 'RESERVE_CLOSEOUT';
    reasonCodes.push('CLOSEOUT_BUDGET_RESERVED');
  }
  if (reasonCodes.length === 0) reasonCodes.push('PROGRESS_WITHIN_BOUNDS');
  return seal({
    schemaVersion: FORGE_PROGRESS_DETECTOR_SCHEMA_VERSION,
    decisionType: 'forge-execution-progress/v2',
    phase,
    decision,
    reasonCodes,
    immutableBoundary,
    counters: normalizedCounters,
    limits: normalizedLimits,
    remaining,
    observedProgressKeys: [...coverage].sort(),
    missingProgressKeys,
    currentNoProgressStreak: noProgressStreak,
    longestNoProgressStreak,
    maximumRepeatedActionResultsObserved: maximumRepeat,
  });
}
