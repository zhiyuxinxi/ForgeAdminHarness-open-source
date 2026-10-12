import { createHash } from 'node:crypto';
import {
  isHostExecutionAdmissionReceipt,
  validateHostExecutionAdmissionReceipt,
} from './forge-host-verification-receipt.mjs';
import { VERIFY_PROFILE_NAMES } from './verify-policy.mjs';

export const EXECUTION_STATE_SCHEMA_VERSION = 1;

export const EXECUTION_PHASES = Object.freeze([
  'ADMIT',
  'ROUTE',
  'PREFLIGHT',
  'DISCOVER',
  'RED_GATE',
  'IMPLEMENT_INCREMENT',
  'INCREMENT_GATE',
  'VERIFY_AFFECTED',
  'REPAIR',
  'ACCEPTANCE',
  'CLOSEOUT',
]);

export const EXECUTION_TERMINAL_OUTCOMES = Object.freeze([
  'COMPLETE',
  'BOUNDED_BLOCKED',
  'FAILED_SOURCE',
  'INCOMPLETE_BUDGET',
  'REJECTED',
  'SAFETY_HOLD',
]);

export const EXECUTION_FAILURE_CLASSES = Object.freeze([
  'INPUT_CONTRACT',
  'AUTHORITY',
  'POLICY_VIOLATION',
  'CAPABILITY_HARD',
  'CAPABILITY_TRANSIENT',
  'SAFETY_HOLD',
  'SOURCE_RACE',
  'SOURCE_DEFECT',
  'DEPENDENCY_UNAVAILABLE',
  'EXECUTION_TIMEOUT',
  'EVIDENCE_INVALID',
  'BUDGET_EXHAUSTED',
  'MODEL_RUNTIME',
  'COMPLETION_PROTOCOL',
]);

export const EXECUTION_BUDGET_DIMENSIONS = Object.freeze([
  'steps',
  'requests',
  'toolCalls',
  'mutations',
]);

export const DEFAULT_EXECUTION_BUDGETS = Object.freeze({
  limits: Object.freeze({ steps: 80, requests: 96, toolCalls: 120, mutations: 20 }),
  repairMaxMutations: 5,
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+){0,31}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,127}$/u;
const SHA256 = /^(?:sha256:)?[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GIT_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TERMINAL_SET = new Set(EXECUTION_TERMINAL_OUTCOMES);
const PHASE_SET = new Set(EXECUTION_PHASES);
const FAILURE_SET = new Set(EXECUTION_FAILURE_CLASSES);
const DIMENSION_SET = new Set(EXECUTION_BUDGET_DIMENSIONS);
const ACTION_CEILING_SET = new Set([
  'read-only',
  'workspace-write',
  'git-checkpoint',
  'release',
]);
const RECEIPT_TYPES = Object.freeze({
  redGate: 'forge-execution/red-gate/v1',
  governance: 'forge-execution/governance-ref/v1',
  verification: 'forge-execution/verification-ref/v1',
  acceptance: 'forge-execution/acceptance-verdict-ref/v1',
  evidenceTruth: 'forge-execution/evidence-truth/v1',
});

const FAILURE_POLICY = Object.freeze({
  INPUT_CONTRACT: Object.freeze({ maxRetries: 0, terminalOutcome: 'REJECTED' }),
  AUTHORITY: Object.freeze({ maxRetries: 0, terminalOutcome: 'REJECTED' }),
  POLICY_VIOLATION: Object.freeze({ maxRetries: 0, terminalOutcome: 'REJECTED' }),
  CAPABILITY_HARD: Object.freeze({ maxRetries: 0, terminalOutcome: 'BOUNDED_BLOCKED' }),
  CAPABILITY_TRANSIENT: Object.freeze({ maxRetries: 1, terminalOutcome: 'BOUNDED_BLOCKED' }),
  SAFETY_HOLD: Object.freeze({ maxRetries: 0, terminalOutcome: 'SAFETY_HOLD' }),
  SOURCE_RACE: Object.freeze({ maxRetries: 1, terminalOutcome: 'BOUNDED_BLOCKED' }),
  SOURCE_DEFECT: Object.freeze({ maxRetries: 0, terminalOutcome: 'FAILED_SOURCE' }),
  DEPENDENCY_UNAVAILABLE: Object.freeze({ maxRetries: 0, terminalOutcome: 'BOUNDED_BLOCKED' }),
  EXECUTION_TIMEOUT: Object.freeze({ maxRetries: 0, terminalOutcome: 'BOUNDED_BLOCKED' }),
  EVIDENCE_INVALID: Object.freeze({ maxRetries: 1, terminalOutcome: 'BOUNDED_BLOCKED' }),
  BUDGET_EXHAUSTED: Object.freeze({ maxRetries: 0, terminalOutcome: 'INCOMPLETE_BUDGET' }),
  MODEL_RUNTIME: Object.freeze({ maxRetries: 0, terminalOutcome: 'INCOMPLETE_BUDGET' }),
  COMPLETION_PROTOCOL: Object.freeze({ maxRetries: 1, terminalOutcome: 'BOUNDED_BLOCKED' }),
});

export class ForgeExecutionStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeExecutionStateError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeExecutionStateError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('EXECUTION_FIELD_INVALID', `${label} is invalid.`);
  return value;
}

function canonicalTimestamp(value, label) {
  requiredString(value, TIMESTAMP, label);
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('EXECUTION_FIELD_INVALID', `${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('EXECUTION_FIELD_INVALID', `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function canonicalStringArray(value, label, { allowEmpty = false, pattern = SAFE_ID, maximum = 256 } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > maximum) {
    fail('EXECUTION_FIELD_INVALID', `${label} must be a bounded${allowEmpty ? '' : ' non-empty'} array.`);
  }
  const normalized = value.map((item) => requiredString(item, pattern, label));
  if (new Set(normalized).size !== normalized.length) fail('EXECUTION_FIELD_INVALID', `${label} contains duplicates.`);
  return [...normalized].sort();
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('EXECUTION_CANONICAL_INVALID', 'Non-canonical number.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!plainObject(value)) fail('EXECUTION_CANONICAL_INVALID', 'Only plain JSON values are supported.');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('EXECUTION_CANONICAL_INVALID', `Undefined field ${key}.`);
    result[key] = canonicalValue(value[key]);
  }
  return result;
}

export function canonicalExecutionJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function executionSha256(value) {
  return `sha256:${createHash('sha256').update(canonicalExecutionJson(value), 'utf8').digest('hex')}`;
}

export function sealExecutionReceipt(value) {
  if (!plainObject(value)) fail('EXECUTION_RECEIPT_INVALID', 'Receipt must be a plain object.');
  const { receiptDigest: _ignored, ...unsigned } = canonicalValue(value);
  return deepFreeze({ ...unsigned, receiptDigest: executionSha256(unsigned) });
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) fail('EXECUTION_RECEIPT_INVALID', `${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
      || actual.some((key, index) => key !== sortedExpected[index])) {
    fail('EXECUTION_RECEIPT_INVALID', `${label} has missing or unsupported fields.`);
  }
}

function validateReceiptEnvelope(value, receiptType, expectedKeys, label) {
  exactKeys(value, expectedKeys, label);
  if (value.receiptType !== receiptType) fail('EXECUTION_RECEIPT_INVALID', `${label}.receiptType is invalid.`);
  requiredString(value.receiptId, SAFE_ID, `${label}.receiptId`);
  requiredString(value.receiptDigest, /^sha256:[0-9a-f]{64}$/u, `${label}.receiptDigest`);
  const { receiptDigest, ...unsigned } = value;
  if (receiptDigest !== executionSha256(unsigned)) fail('EXECUTION_RECEIPT_DIGEST_INVALID', `${label} digest does not match its content.`);
  return value;
}

function validateRedGateReceipt(value, sourceFingerprint) {
  const receipt = validateReceiptEnvelope(value, RECEIPT_TYPES.redGate, [
    'receiptType', 'receiptId', 'receiptDigest', 'sourceFingerprint', 'executedTests',
    'expectedFailureMatched', 'infrastructureFailure', 'sourceReceiptDigest',
  ], 'redGateReceipt');
  if (receipt.sourceFingerprint !== sourceFingerprint) fail('EXECUTION_RED_INVALID', 'RED receipt is stale.');
  requiredString(receipt.sourceReceiptDigest, /^sha256:[0-9a-f]{64}$/u, 'redGateReceipt.sourceReceiptDigest');
  boundedInteger(receipt.executedTests, 1, 1_000_000, 'redGateReceipt.executedTests');
  if (receipt.expectedFailureMatched !== true || receipt.infrastructureFailure !== false) {
    fail('EXECUTION_RED_INVALID', 'RED must prove a non-infrastructure expected behavior failure.');
  }
  return receipt;
}

function validateGovernanceReceipt(value, sourceFingerprint) {
  const receipt = validateReceiptEnvelope(value, RECEIPT_TYPES.governance, [
    'receiptType', 'receiptId', 'receiptDigest', 'sourceFingerprint', 'status',
  ], 'governanceReceipt');
  if (receipt.sourceFingerprint !== sourceFingerprint || receipt.status !== 'passed') {
    fail('EXECUTION_GOVERNANCE_RECEIPT_INVALID', 'Governance receipt must be current and passed.');
  }
  return receipt;
}

function validateVerificationReceipts(values, expectedProfiles, sourceFingerprint, admissionId, label) {
  if (!Array.isArray(values)) fail('EXECUTION_VERIFICATION_RECEIPT_INVALID', `${label} must be an array.`);
  const receipts = values.map((value, index) => {
    const receipt = validateReceiptEnvelope(value, RECEIPT_TYPES.verification, [
      'receiptType', 'receiptId', 'receiptDigest', 'admissionId', 'sourceFingerprint', 'profile', 'status',
      'verificationProven',
    ], `${label}[${index}]`);
    requiredString(receipt.admissionId, UUID, `${label}[${index}].admissionId`);
    requiredString(receipt.profile, SAFE_ID, `${label}[${index}].profile`);
    if (receipt.admissionId !== admissionId
        || receipt.sourceFingerprint !== sourceFingerprint
        || receipt.status !== 'passed'
        || receipt.verificationProven !== true) {
      fail('EXECUTION_VERIFICATION_RECEIPT_INVALID', `${label}[${index}] must match admission, be current, and be proven passed.`);
    }
    return receipt;
  });
  const actualProfiles = receipts.map((receipt) => receipt.profile).sort();
  if (!equalArrays(actualProfiles, [...expectedProfiles].sort())) {
    fail('EXECUTION_VERIFICATION_PROFILE_INCOMPLETE', `${label} profiles must equal the required profile closure.`);
  }
  if (new Set(receipts.map((receipt) => receipt.receiptId)).size !== receipts.length) {
    fail('EXECUTION_VERIFICATION_RECEIPT_INVALID', `${label} receipt ids must be unique.`);
  }
  return receipts;
}

function validateExecutionAdmissionReceipt(value, state, observedAt) {
  if (isHostExecutionAdmissionReceipt(value)) {
    let admission;
    try {
      const expectedProfiles = state.admissionProfiles ?? state.requiredProfiles;
      const selectedProfiles = new Set(expectedProfiles);
      const catalogProfiles = VERIFY_PROFILE_NAMES.filter((profile) => selectedProfiles.has(profile));
      const unknownProfiles = expectedProfiles.filter((profile) => !VERIFY_PROFILE_NAMES.includes(profile));
      admission = validateHostExecutionAdmissionReceipt(value, {
        profiles: [...catalogProfiles, ...unknownProfiles],
        projectSlug: state.projectSlug,
        taskId: state.taskId,
        sourceFingerprint: state.sourceFingerprint,
        observedAt,
      });
    } catch (error) {
      fail('EXECUTION_ADMISSION_INVALID', error?.message ?? 'Host execution admission is invalid.');
    }
    return {
      ...admission,
      admissionDigest: executionSha256(value),
    };
  }
  exactKeys(value, [
    'schemaVersion', 'receiptType', 'admissionId', 'projectSlug', 'taskId', 'runner',
    'profiles', 'source', 'cache', 'executor', 'issuedAt', 'expiresAt', 'outcome',
    'reasonCode', 'truth',
  ], 'executionAdmissionReceipt');
  if (value.receiptType !== 'forge-verify/execution-admission' || value.schemaVersion !== 1) {
    fail('EXECUTION_ADMISSION_INVALID', 'Execution admission type or schema is invalid.');
  }
  requiredString(value.admissionId, UUID, 'executionAdmissionReceipt.admissionId');
  if (value.projectSlug !== state.projectSlug || value.taskId !== state.taskId) {
    fail('EXECUTION_ADMISSION_IDENTITY_MISMATCH', 'Execution admission project or task does not match the execution state.');
  }

  exactKeys(value.runner, ['bootId', 'revision'], 'executionAdmissionReceipt.runner');
  requiredString(value.runner.bootId, UUID, 'executionAdmissionReceipt.runner.bootId');
  requiredString(value.runner.revision, SAFE_ID, 'executionAdmissionReceipt.runner.revision');

  const profiles = canonicalStringArray(value.profiles, 'executionAdmissionReceipt.profiles', { allowEmpty: true });
  const expectedProfiles = state.admissionProfiles ?? state.requiredProfiles;
  if (!equalArrays(profiles, expectedProfiles)) {
    fail('EXECUTION_ADMISSION_PROFILE_MISMATCH', 'Execution admission profiles must exactly close the required profile set.');
  }

  exactKeys(value.source, [
    'head', 'workspaceFingerprint', 'dependencyManifestFingerprint',
  ], 'executionAdmissionReceipt.source');
  requiredString(value.source.head, GIT_HEAD, 'executionAdmissionReceipt.source.head');
  requiredString(value.source.workspaceFingerprint, SHA256, 'executionAdmissionReceipt.source.workspaceFingerprint');
  requiredString(value.source.dependencyManifestFingerprint, SHA256, 'executionAdmissionReceipt.source.dependencyManifestFingerprint');
  if (value.source.workspaceFingerprint !== state.sourceFingerprint) {
    fail('EXECUTION_ADMISSION_SOURCE_MISMATCH', 'Execution admission workspace fingerprint is stale.');
  }

  exactKeys(value.cache, ['mode', 'compatible', 'packDigest'], 'executionAdmissionReceipt.cache');
  if (value.cache.mode !== 'project-scoped-immutable-pack' || value.cache.compatible !== true) {
    fail('EXECUTION_ADMISSION_CACHE_INVALID', 'Execution admission cache is not proven compatible.');
  }
  requiredString(value.cache.packDigest, SHA256, 'executionAdmissionReceipt.cache.packDigest');

  const executorProofs = [
    'proven', 'dockerApiProven', 'toolchainImageProven', 'samePathBindProven',
    'stateWriteProven', 'cleanupProven',
  ];
  exactKeys(value.executor, executorProofs, 'executionAdmissionReceipt.executor');
  if (executorProofs.some((proof) => value.executor[proof] !== true)) {
    fail('EXECUTION_ADMISSION_EXECUTOR_INVALID', 'Execution admission executor proofs must all be true.');
  }

  if (value.outcome !== 'ready' || value.reasonCode !== null) {
    fail('EXECUTION_ADMISSION_NOT_READY', 'Execution admission must have a ready outcome and no failure reason.');
  }
  const issuedAt = canonicalTimestamp(value.issuedAt, 'executionAdmissionReceipt.issuedAt');
  const expiresAt = canonicalTimestamp(value.expiresAt, 'executionAdmissionReceipt.expiresAt');
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  const observedAtMs = Date.parse(observedAt);
  const leaseDurationMs = expiresAtMs - issuedAtMs;
  if (leaseDurationMs < 30_000 || leaseDurationMs > 15 * 60_000
      || observedAtMs < issuedAtMs || observedAtMs > expiresAtMs) {
    fail('EXECUTION_ADMISSION_LEASE_INVALID', 'Execution admission lease must be 30 seconds to 15 minutes and current at observation.');
  }

  const truthFields = [
    'executionProven', 'verificationProven', 'semanticCorrectnessProven',
    'databaseIntegrationProven', 'releaseProven',
  ];
  exactKeys(value.truth, truthFields, 'executionAdmissionReceipt.truth');
  if (truthFields.some((field) => value.truth[field] !== false)) {
    fail('EXECUTION_ADMISSION_TRUTH_INVALID', 'Admission truth fields must remain false.');
  }

  return {
    receipt: value,
    profiles,
    executionMode: 'container-cache',
    dependencyManifestFingerprint: value.source.dependencyManifestFingerprint,
    cachePackDigest: value.cache.packDigest,
    admissionDigest: executionSha256(value),
  };
}

function storedExecutionAdmission(admission, observedAt) {
  const common = {
    admissionId: admission.receipt.admissionId,
    projectSlug: admission.receipt.projectSlug,
    taskId: admission.receipt.taskId,
    runnerBootId: admission.receipt.runner.bootId,
    runnerRevision: admission.receipt.runner.revision,
    profiles: admission.profiles,
    sourceFingerprint: admission.receipt.source.workspaceFingerprint,
    dependencyManifestFingerprint: admission.dependencyManifestFingerprint,
    issuedAt: admission.receipt.issuedAt,
    expiresAt: admission.receipt.expiresAt,
    observedAt,
    admissionDigest: admission.admissionDigest,
    receipt: admission.receipt,
  };
  return admission.executionMode === 'host-toolchain'
    ? {
        ...common,
        executionMode: 'host-toolchain',
        toolchainDigest: admission.toolchainDigest,
        profilePolicyDigest: admission.profilePolicyDigest,
      }
    : {
        ...common,
        cachePackDigest: admission.cachePackDigest,
      };
}

function validateAcceptanceReceipt(value, sourceFingerprint) {
  const receipt = validateReceiptEnvelope(value, RECEIPT_TYPES.acceptance, [
    'receiptType', 'receiptId', 'receiptDigest', 'sourceFingerprint', 'verdict', 'signatureProven',
  ], 'acceptanceReceipt');
  if (!['accepted', 'candidate-blocked'].includes(receipt.verdict)
      || receipt.sourceFingerprint !== sourceFingerprint
      || receipt.signatureProven !== true) {
    fail('EXECUTION_ACCEPTANCE_INVALID', 'Acceptance receipt is invalid or stale.');
  }
  return receipt;
}

function sameSha256(left, right) {
  return left.replace(/^sha256:/u, '') === right.replace(/^sha256:/u, '');
}

function validateEvidenceTruthReceipt(value, sourceFingerprint, receiptHeadDigest) {
  const receipt = validateReceiptEnvelope(value, RECEIPT_TYPES.evidenceTruth, [
    'receiptType', 'receiptId', 'receiptDigest', 'sourceFingerprint', 'evidenceHeadDigest',
  ], 'evidenceTruthReceipt');
  if (receipt.sourceFingerprint !== sourceFingerprint || receipt.evidenceHeadDigest !== receiptHeadDigest) {
    fail('EXECUTION_CLOSEOUT_INVALID', 'Evidence-truth receipt must bind the current source and latest receipt head.');
  }
  return receipt;
}

function cloneState(state) {
  return structuredClone(state);
}

function ensureActive(state) {
  validateExecutionState(state);
  if (state.terminalOutcome !== null) fail('EXECUTION_TERMINAL', `Execution already ended as ${state.terminalOutcome}.`);
}

function normalizedBudgets(value = DEFAULT_EXECUTION_BUDGETS) {
  const limits = value?.limits ?? DEFAULT_EXECUTION_BUDGETS.limits;
  if (!plainObject(limits)) fail('EXECUTION_BUDGET_INVALID', 'budget limits must be an object.');
  const normalizedLimits = {};
  for (const dimension of EXECUTION_BUDGET_DIMENSIONS) {
    const maximum = dimension === 'requests' || dimension === 'toolCalls' ? 10_000 : 1_000;
    normalizedLimits[dimension] = boundedInteger(limits[dimension], 1, maximum, `budgets.limits.${dimension}`);
  }
  return {
    limits: normalizedLimits,
    used: Object.fromEntries(EXECUTION_BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])),
    reserved: Object.fromEntries(EXECUTION_BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])),
    reservations: {},
    repairMaxMutations: boundedInteger(
      value?.repairMaxMutations ?? DEFAULT_EXECUTION_BUDGETS.repairMaxMutations,
      1,
      20,
      'budgets.repairMaxMutations',
    ),
  };
}

function receiptDigest(receipt) {
  const { receiptDigest: _ignored, ...unsigned } = receipt;
  return executionSha256(unsigned);
}

function transitionReceipt(
  state,
  to,
  reasonCode,
  observedAt,
  sourceFingerprint = state.sourceFingerprint,
  evidenceReceiptDigests = [],
) {
  const receipt = {
    schemaVersion: 'forge-execution/phase-transition/v1',
    executionId: state.executionId,
    sequence: state.transitionSequence + 1,
    from: state.phase,
    to,
    reasonCode: requiredString(reasonCode, SAFE_CODE, 'reasonCode'),
    observedAt: canonicalTimestamp(observedAt, 'observedAt'),
    sourceFingerprint: requiredString(sourceFingerprint, SHA256, 'sourceFingerprint'),
    evidenceReceiptDigests: canonicalStringArray(
      evidenceReceiptDigests,
      'evidenceReceiptDigests',
      { allowEmpty: true, pattern: /^sha256:[0-9a-f]{64}$/u },
    ),
    budget: {
      limits: { ...state.budgets.limits },
      used: { ...state.budgets.used },
      reserved: { ...state.budgets.reserved },
    },
    previousReceiptDigest: state.receiptHeadDigest,
    receiptDigest: '',
  };
  receipt.receiptDigest = receiptDigest(receipt);
  return receipt;
}

function move(
  state,
  to,
  reasonCode,
  observedAt,
  sourceFingerprint = state.sourceFingerprint,
  evidenceReceiptDigests = [],
) {
  if (!PHASE_SET.has(to) && !TERMINAL_SET.has(to)) fail('EXECUTION_PHASE_INVALID', `Unknown phase ${to}.`);
  const next = cloneState(state);
  const receipt = transitionReceipt(next, to, reasonCode, observedAt, sourceFingerprint, evidenceReceiptDigests);
  next.phase = to;
  next.transitionSequence = receipt.sequence;
  next.eventSequence += 1;
  next.sourceFingerprint = sourceFingerprint;
  next.phaseReceipts.push(receipt);
  next.receiptHeadDigest = receipt.receiptDigest;
  return next;
}

function stopReceipt(state, outcome, observedAt, failure, openCriteria = []) {
  const truth = {
    implemented: state.budgets.used.mutations > 0,
    audited: state.evidence.lastAuditedFingerprint === state.sourceFingerprint,
    verified: state.evidence.lastVerifiedFingerprint === state.sourceFingerprint,
    accepted: state.acceptance.verdict === 'accepted'
      && state.acceptance.signatureProven === true
      && state.acceptance.sourceFingerprint === state.sourceFingerprint,
  };
  const receipt = {
    schemaVersion: 'forge-execution/stop/v1',
    executionId: state.executionId,
    taskId: state.taskId,
    outcome,
    observedAt: canonicalTimestamp(observedAt, 'observedAt'),
    sourceFingerprint: state.sourceFingerprint,
    contractId: state.contractId,
    registryDigest: state.registryDigest,
    truth,
    openCriteria: canonicalStringArray(openCriteria, 'openCriteria', { allowEmpty: true }),
    failure,
    budget: {
      limits: { ...state.budgets.limits },
      used: { ...state.budgets.used },
      reserved: { ...state.budgets.reserved },
    },
    previousReceiptDigest: state.receiptHeadDigest,
    receiptDigest: '',
  };
  receipt.receiptDigest = receiptDigest(receipt);
  return receipt;
}

function terminalize(
  state,
  outcome,
  observedAt,
  failure = null,
  openCriteria = state.criteria,
  evidenceReceiptDigests = [],
) {
  ensureActive(state);
  if (!TERMINAL_SET.has(outcome)) fail('EXECUTION_OUTCOME_INVALID', `Unknown terminal outcome ${outcome}.`);
  if (outcome === 'COMPLETE') {
    if (state.phase !== 'CLOSEOUT') fail('EXECUTION_FALSE_COMPLETE', 'COMPLETE is only allowed from CLOSEOUT.');
    const currentTruth = {
      audited: state.evidence.lastAuditedFingerprint === state.sourceFingerprint,
      verified: state.evidence.lastVerifiedFingerprint === state.sourceFingerprint,
      accepted: state.acceptance.verdict === 'accepted'
        && state.acceptance.signatureProven === true
        && state.acceptance.sourceFingerprint === state.sourceFingerprint,
    };
    if (!currentTruth.audited || !currentTruth.verified || !currentTruth.accepted
        || state.closeout.evidenceTruthReceipt?.sourceFingerprint !== state.sourceFingerprint) {
      fail('EXECUTION_FALSE_COMPLETE', 'COMPLETE requires current audit, verification, signed acceptance, and fresh evidence truth.');
    }
    if (openCriteria.length !== 0) fail('EXECUTION_FALSE_COMPLETE', 'COMPLETE cannot retain open criteria.');
  }
  const moved = move(state, outcome, `STOP_${outcome}`, observedAt, state.sourceFingerprint, evidenceReceiptDigests);
  moved.terminalOutcome = outcome;
  moved.failure = failure;
  moved.openCriteria = canonicalStringArray(openCriteria, 'openCriteria', { allowEmpty: true });
  const stop = stopReceipt(moved, outcome, observedAt, failure, moved.openCriteria);
  moved.stopReceipt = stop;
  moved.receiptHeadDigest = stop.receiptDigest;
  moved.eventSequence += 1;
  return deepFreeze(moved);
}

function normalizedFailure(value) {
  if (!plainObject(value)) fail('EXECUTION_FAILURE_INVALID', 'failure must be an object.');
  const failureClass = requiredString(value.failureClass, /^[A-Z][A-Z0-9_]{1,63}$/u, 'failureClass');
  if (!FAILURE_SET.has(failureClass)) fail('EXECUTION_FAILURE_INVALID', `Unknown failure class ${failureClass}.`);
  const code = requiredString(value.code, SAFE_CODE, 'failure.code');
  const resolutionAuthority = requiredString(value.resolutionAuthority, SAFE_ID, 'failure.resolutionAuthority');
  const attemptKey = requiredString(value.attemptKey ?? `${failureClass}:${code}`, SAFE_ID, 'failure.attemptKey');
  const policy = FAILURE_POLICY[failureClass];
  return {
    failureClass,
    code,
    resolutionAuthority,
    attemptKey,
    retryable: policy.maxRetries > 0,
    maxRetries: policy.maxRetries,
    terminalOutcome: policy.terminalOutcome,
  };
}

export function failurePolicy(failureClass) {
  if (!FAILURE_SET.has(failureClass)) fail('EXECUTION_FAILURE_INVALID', `Unknown failure class ${failureClass}.`);
  return deepFreeze({ failureClass, ...FAILURE_POLICY[failureClass] });
}

export function createExecutionState(input) {
  if (!plainObject(input)) fail('EXECUTION_INPUT_INVALID', 'Execution input must be an object.');
  const createdAt = canonicalTimestamp(input.createdAt, 'createdAt');
  const sourceFingerprint = requiredString(input.sourceFingerprint, SHA256, 'sourceFingerprint');
  if (!ACTION_CEILING_SET.has(input.actionCeiling)) {
    fail('EXECUTION_FIELD_INVALID', 'actionCeiling is invalid.');
  }
  const state = {
    schemaVersion: EXECUTION_STATE_SCHEMA_VERSION,
    executionId: requiredString(input.executionId, SAFE_ID, 'executionId'),
    projectSlug: requiredString(input.projectSlug, SAFE_ID, 'projectSlug'),
    taskId: requiredString(input.taskId, SAFE_ID, 'taskId'),
    contractId: requiredString(input.contractId, SHA256, 'contractId'),
    registryDigest: requiredString(input.registryDigest, SHA256, 'registryDigest'),
    actionCeiling: input.actionCeiling,
    tddRequired: input.tddRequired === true,
    ...(input.draftBeforeVerification === true ? { draftBeforeVerification: true } : {}),
    requiredSkills: canonicalStringArray(input.requiredSkills, 'requiredSkills', { allowEmpty: true }),
    requiredProfiles: canonicalStringArray(input.requiredProfiles, 'requiredProfiles', { allowEmpty: true }),
    redProfiles: canonicalStringArray(input.redProfiles ?? [], 'redProfiles', { allowEmpty: true }),
    criteria: canonicalStringArray(input.criteria, 'criteria'),
    phase: 'ADMIT',
    terminalOutcome: null,
    eventSequence: 0,
    transitionSequence: 0,
    sourceFingerprint,
    receiptHeadDigest: null,
    phaseReceipts: [],
    stopReceipt: null,
    openCriteria: [...canonicalStringArray(input.criteria, 'criteria')],
    budgets: normalizedBudgets(input.budgets),
    increment: null,
    completedIncrements: [],
    admission: null,
    repair: {
      used: false,
      active: false,
      family: null,
      returnPhase: null,
      mutationCount: 0,
      mutationBaseline: 0,
      sourceBaselineFingerprint: null,
    },
    failureAttempts: {},
    failureHistory: [],
    failure: null,
    evidence: {
      lastAuditedFingerprint: null,
      lastVerifiedFingerprint: null,
    },
    acceptance: {
      verdict: null,
      signatureProven: false,
      sourceFingerprint: null,
      receiptId: null,
      receiptDigest: null,
      receipt: null,
    },
    closeout: { evidenceTruthReceipt: null },
  };
  state.admissionProfiles = [...new Set([...state.requiredProfiles, ...state.redProfiles])].sort();
  const receipt = transitionReceipt({ ...state, phase: 'NONE' }, 'ADMIT', 'EXECUTION_ADMITTED', createdAt, sourceFingerprint);
  state.transitionSequence = receipt.sequence;
  state.eventSequence = 1;
  state.phaseReceipts.push(receipt);
  state.receiptHeadDigest = receipt.receiptDigest;
  return deepFreeze(state);
}

function assertPhase(state, expected, eventType) {
  if (state.phase !== expected) fail('EXECUTION_TRANSITION_INVALID', `${eventType} is not allowed from ${state.phase}.`);
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalAdvance(state, event) {
  ensureActive(state);
  canonicalTimestamp(event.observedAt, 'event.observedAt');
  switch (event.type) {
    case 'route.completed': {
      assertPhase(state, 'ADMIT', event.type);
      const observed = canonicalStringArray(event.observedSkills, 'observedSkills', { allowEmpty: true });
      if (!equalArrays(observed, state.requiredSkills)) fail('EXECUTION_ROUTING_INCOMPLETE', 'Observed Skills must equal required Skills.');
      return deepFreeze(move(state, 'ROUTE', 'ROUTING_CLOSED', event.observedAt));
    }
    case 'preflight.started':
      assertPhase(state, 'ROUTE', event.type);
      return deepFreeze(move(state, 'PREFLIGHT', 'PREFLIGHT_STARTED', event.observedAt));
    case 'draft.started': {
      assertPhase(state, 'PREFLIGHT', event.type);
      if (state.draftBeforeVerification !== true || !['workspace-write', 'git-checkpoint', 'release'].includes(state.actionCeiling) || state.tddRequired) {
        fail('EXECUTION_DRAFT_AUTHORITY_REQUIRED', 'Drafting before verification requires trusted draft authority.');
      }
      return deepFreeze(move(state, 'DISCOVER', 'DRAFT_AUTHORITY_ONLY', event.observedAt));
    }
    case 'preflight.completed': {
      assertPhase(state, 'PREFLIGHT', event.type);
      const admission = validateExecutionAdmissionReceipt(event.receipt, state, event.observedAt);
      const next = cloneState(state);
      next.admission = storedExecutionAdmission(admission, event.observedAt);
      return deepFreeze(move(
        next,
        'DISCOVER',
        'PREFLIGHT_READY',
        event.observedAt,
        state.sourceFingerprint,
        [admission.admissionDigest],
      ));
    }
    case 'discovery.completed': {
      assertPhase(state, 'DISCOVER', event.type);
      const criteria = canonicalStringArray(event.criteria, 'increment.criteria');
      if (criteria.some((criterion) => !state.openCriteria.includes(criterion))) {
        fail('EXECUTION_INCREMENT_INVALID', 'Increment criteria must be currently open.');
      }
      const next = cloneState(state);
      next.increment = {
        incrementId: requiredString(event.incrementId, SAFE_ID, 'incrementId'),
        criteria,
        ownedPaths: canonicalStringArray(event.ownedPaths, 'ownedPaths', { pattern: SAFE_PATH }),
        verificationProfiles: canonicalStringArray(event.verificationProfiles, 'verificationProfiles', { allowEmpty: true }),
        mutationBaseline: state.budgets.used.mutations,
      };
      const target = state.tddRequired ? 'RED_GATE' : 'IMPLEMENT_INCREMENT';
      return deepFreeze(move(next, target, state.tddRequired ? 'RED_REQUIRED' : 'IMPLEMENTATION_READY', event.observedAt));
    }
    case 'red.completed': {
      assertPhase(state, 'RED_GATE', event.type);
      const receipt = validateRedGateReceipt(event.receipt, state.sourceFingerprint);
      const next = cloneState(state);
      // Test-fixture mutations belong to RED preparation. Reset the increment
      // baseline only after an executed failing-test receipt is proven so a
      // test-file write can never satisfy implementation.completed.
      next.increment.mutationBaseline = state.budgets.used.mutations;
      return deepFreeze(move(
        next,
        'IMPLEMENT_INCREMENT',
        'RED_PROVEN',
        event.observedAt,
        state.sourceFingerprint,
        [receipt.receiptDigest],
      ));
    }
    case 'implementation.completed': {
      assertPhase(state, 'IMPLEMENT_INCREMENT', event.type);
      if (!state.increment || state.budgets.used.mutations <= state.increment.mutationBaseline) {
        fail('EXECUTION_IMPLEMENTATION_INVALID', 'Implementation requires at least one committed mutation in this increment.');
      }
      const fingerprint = requiredString(event.sourceFingerprint, SHA256, 'sourceFingerprint');
      if (fingerprint === state.sourceFingerprint) fail('EXECUTION_IMPLEMENTATION_INVALID', 'Implementation must change the source fingerprint.');
      return deepFreeze(move(state, 'INCREMENT_GATE', 'INCREMENT_IMPLEMENTED', event.observedAt, fingerprint));
    }
    case 'increment-gate.completed': {
      assertPhase(state, 'INCREMENT_GATE', event.type);
      if (!state.increment) fail('EXECUTION_INCREMENT_GATE_INVALID', 'Increment gate has no active increment.');
      const governance = validateGovernanceReceipt(event.governanceReceipt, state.sourceFingerprint);
      const verification = validateVerificationReceipts(
        event.verificationReceipts,
        state.increment.verificationProfiles,
        state.sourceFingerprint,
        state.admission?.admissionId,
        'incrementVerificationReceipts',
      );
      const next = cloneState(state);
      next.evidence.lastAuditedFingerprint = state.sourceFingerprint;
      next.evidence.lastVerifiedFingerprint = state.sourceFingerprint;
      next.completedIncrements.push({
        incrementId: state.increment.incrementId,
        criteria: [...state.increment.criteria],
        sourceFingerprint: state.sourceFingerprint,
      });
      next.openCriteria = next.openCriteria.filter((criterion) => !state.increment.criteria.includes(criterion));
      next.increment = null;
      return deepFreeze(move(
        next,
        event.hasMoreIncrements === true ? 'DISCOVER' : 'VERIFY_AFFECTED',
        event.hasMoreIncrements === true ? 'NEXT_INCREMENT_REQUIRED' : 'INCREMENTS_CLOSED',
        event.observedAt,
        state.sourceFingerprint,
        [governance.receiptDigest, ...verification.map((receipt) => receipt.receiptDigest)],
      ));
    }
    case 'affected-verification.completed': {
      assertPhase(state, 'VERIFY_AFFECTED', event.type);
      const governance = validateGovernanceReceipt(event.governanceReceipt, state.sourceFingerprint);
      const verification = validateVerificationReceipts(
        event.verificationReceipts,
        state.requiredProfiles,
        state.sourceFingerprint,
        state.admission?.admissionId,
        'affectedVerificationReceipts',
      );
      const next = cloneState(state);
      next.evidence.lastAuditedFingerprint = state.sourceFingerprint;
      next.evidence.lastVerifiedFingerprint = state.sourceFingerprint;
      return deepFreeze(move(
        next,
        'ACCEPTANCE',
        'AFFECTED_VERIFICATION_PASSED',
        event.observedAt,
        state.sourceFingerprint,
        [governance.receiptDigest, ...verification.map((receipt) => receipt.receiptDigest)],
      ));
    }
    case 'repair.completed': {
      assertPhase(state, 'REPAIR', event.type);
      const fingerprint = requiredString(event.sourceFingerprint, SHA256, 'sourceFingerprint');
      if (!state.repair.active
          || sameSha256(fingerprint, state.sourceFingerprint)
          || sameSha256(fingerprint, state.repair.sourceBaselineFingerprint)
          || state.budgets.used.mutations <= state.repair.mutationBaseline) {
        fail('EXECUTION_REPAIR_INVALID', 'Repair must commit a mutation and submit a new source fingerprint.');
      }
      const next = cloneState(state);
      next.repair.active = false;
      const target = next.repair.returnPhase;
      if (!['INCREMENT_GATE', 'VERIFY_AFFECTED'].includes(target)) fail('EXECUTION_REPAIR_INVALID', 'Repair return phase is invalid.');
      return deepFreeze(move(next, target, 'REPAIR_IMPLEMENTED', event.observedAt, fingerprint));
    }
    case 'acceptance.completed': {
      assertPhase(state, 'ACCEPTANCE', event.type);
      const receipt = validateAcceptanceReceipt(event.receipt, state.sourceFingerprint);
      const next = cloneState(state);
      next.acceptance = {
        verdict: receipt.verdict,
        signatureProven: receipt.signatureProven,
        sourceFingerprint: state.sourceFingerprint,
        receiptId: receipt.receiptId,
        receiptDigest: receipt.receiptDigest,
        receipt,
      };
      return deepFreeze(move(
        next,
        'CLOSEOUT',
        'ACCEPTANCE_EVALUATED',
        event.observedAt,
        state.sourceFingerprint,
        [receipt.receiptDigest],
      ));
    }
    case 'closeout.completed': {
      assertPhase(state, 'CLOSEOUT', event.type);
      const receipt = validateEvidenceTruthReceipt(
        event.receipt,
        state.sourceFingerprint,
        state.receiptHeadDigest,
      );
      const next = cloneState(state);
      next.closeout.evidenceTruthReceipt = receipt;
      const outcome = next.acceptance.verdict === 'accepted' ? 'COMPLETE' : 'BOUNDED_BLOCKED';
      const openCriteria = outcome === 'COMPLETE' ? [] : state.openCriteria;
      return terminalize(next, outcome, event.observedAt, null, openCriteria, [receipt.receiptDigest]);
    }
    default:
      fail('EXECUTION_EVENT_INVALID', `Unknown execution event ${event.type}.`);
  }
}

export function reduceExecutionState(state, event) {
  if (!plainObject(event)) fail('EXECUTION_EVENT_INVALID', 'event must be an object.');
  return normalAdvance(state, event);
}

export function observeExecutionFailure(state, input) {
  ensureActive(state);
  if (!plainObject(input)) fail('EXECUTION_FAILURE_INVALID', 'failure event must be an object.');
  const observedAt = canonicalTimestamp(input.observedAt, 'observedAt');
  const failure = normalizedFailure(input.failure);
  const next = cloneState(state);
  const attempts = (next.failureAttempts[failure.attemptKey] ?? 0) + 1;
  next.failureAttempts[failure.attemptKey] = attempts;
  const observation = { ...failure, attempt: attempts, observedAt, phase: state.phase };
  next.failureHistory.push(observation);
  next.failure = observation;
  next.eventSequence += 1;

  if (failure.failureClass === 'SOURCE_DEFECT') {
    if (!['INCREMENT_GATE', 'VERIFY_AFFECTED'].includes(state.phase) || state.repair.used) {
      return terminalize(next, 'FAILED_SOURCE', observedAt, observation, state.openCriteria);
    }
    next.repair = {
      used: true,
      active: true,
      family: requiredString(input.failure.family, SAFE_ID, 'failure.family'),
      returnPhase: state.phase,
      mutationCount: 0,
      mutationBaseline: state.budgets.used.mutations,
      sourceBaselineFingerprint: state.sourceFingerprint,
    };
    return deepFreeze(move(next, 'REPAIR', 'SOURCE_REPAIR_OPENED', observedAt));
  }

  if (attempts <= failure.maxRetries) return deepFreeze(next);
  return terminalize(next, failure.terminalOutcome, observedAt, observation, state.openCriteria);
}

export function reserveExecutionBudget(state, input) {
  ensureActive(state);
  if (!plainObject(input)) fail('EXECUTION_RESERVATION_INVALID', 'reservation must be an object.');
  const reservationId = requiredString(input.reservationId, SAFE_ID, 'reservationId');
  const dimension = requiredString(input.dimension, /^[a-z][A-Za-z]+$/u, 'dimension');
  if (!DIMENSION_SET.has(dimension)) fail('EXECUTION_RESERVATION_INVALID', `Unknown budget dimension ${dimension}.`);
  const amount = boundedInteger(input.amount ?? 1, 1, 1_000, 'reservation.amount');
  const observedAt = canonicalTimestamp(input.observedAt, 'observedAt');
  const existing = state.budgets.reservations[reservationId];
  if (existing) {
    if (existing.dimension === dimension && existing.amount === amount) return state;
    fail('EXECUTION_RESERVATION_CONFLICT', `Reservation ${reservationId} changed shape.`);
  }
  if (dimension === 'mutations' && !['RED_GATE', 'IMPLEMENT_INCREMENT', 'REPAIR'].includes(state.phase)) {
    fail('EXECUTION_MUTATION_PHASE_INVALID', `Mutation reservation is forbidden in ${state.phase}.`);
  }
  const next = cloneState(state);
  const projected = next.budgets.used[dimension] + next.budgets.reserved[dimension] + amount;
  if (projected > next.budgets.limits[dimension]) {
    return terminalize(next, 'INCOMPLETE_BUDGET', observedAt, {
      ...normalizedFailure({
        failureClass: 'BUDGET_EXHAUSTED',
        code: `BUDGET_${dimension.toUpperCase()}_EXHAUSTED`,
        resolutionAuthority: 'task-coordinator',
        attemptKey: `budget:${dimension}`,
      }),
      attempt: 1,
      observedAt,
      phase: state.phase,
    }, state.openCriteria);
  }
  if (dimension === 'mutations' && state.phase === 'REPAIR') {
    const repairReserved = Object.values(next.budgets.reservations)
      .filter((reservation) => reservation.phase === 'REPAIR' && reservation.dimension === 'mutations')
      .reduce((total, reservation) => total + reservation.amount, 0);
    if (next.repair.mutationCount + repairReserved + amount > next.budgets.repairMaxMutations) {
      return terminalize(next, 'FAILED_SOURCE', observedAt, {
        ...normalizedFailure({
          failureClass: 'SOURCE_DEFECT',
          code: 'REPAIR_MUTATION_BUDGET_EXHAUSTED',
          resolutionAuthority: 'task-owner',
          attemptKey: 'repair:mutations',
        }),
        attempt: 1,
        observedAt,
        phase: state.phase,
      }, state.openCriteria);
    }
  }
  next.budgets.reservations[reservationId] = { reservationId, dimension, amount, phase: state.phase };
  next.budgets.reserved[dimension] += amount;
  next.eventSequence += 1;
  return deepFreeze(next);
}

export function commitExecutionBudget(state, input) {
  ensureActive(state);
  const reservationId = requiredString(input?.reservationId, SAFE_ID, 'reservationId');
  const reservation = state.budgets.reservations[reservationId];
  if (!reservation) fail('EXECUTION_RESERVATION_MISSING', `Reservation ${reservationId} does not exist.`);
  const next = cloneState(state);
  delete next.budgets.reservations[reservationId];
  next.budgets.reserved[reservation.dimension] -= reservation.amount;
  next.budgets.used[reservation.dimension] += reservation.amount;
  if (reservation.dimension === 'mutations' && reservation.phase === 'REPAIR') {
    next.repair.mutationCount += reservation.amount;
  }
  next.eventSequence += 1;
  return deepFreeze(next);
}

export function releaseExecutionBudget(state, input) {
  ensureActive(state);
  const reservationId = requiredString(input?.reservationId, SAFE_ID, 'reservationId');
  const reservation = state.budgets.reservations[reservationId];
  if (!reservation) return state;
  const next = cloneState(state);
  delete next.budgets.reservations[reservationId];
  next.budgets.reserved[reservation.dimension] -= reservation.amount;
  next.eventSequence += 1;
  return deepFreeze(next);
}

export function stopExecution(state, input) {
  ensureActive(state);
  if (!plainObject(input)) fail('EXECUTION_STOP_INVALID', 'stop input must be an object.');
  const failure = input.failure === null || input.failure === undefined
    ? null
    : { ...normalizedFailure(input.failure), attempt: input.failure.attempt ?? 1, observedAt: input.observedAt, phase: state.phase };
  if (failure !== null && input.outcome !== failure.terminalOutcome) {
    fail(
      'EXECUTION_STOP_OUTCOME_MISMATCH',
      `${failure.failureClass} requires terminal outcome ${failure.terminalOutcome}.`,
    );
  }
  return terminalize(
    state,
    input.outcome,
    input.observedAt,
    failure,
    input.openCriteria ?? state.openCriteria,
  );
}

export function verifyExecutionReceiptChain(state) {
  try {
    validateExecutionState(state);
    let previous = null;
    for (const receipt of state.phaseReceipts) {
      if (receipt.previousReceiptDigest !== previous || receipt.receiptDigest !== receiptDigest(receipt)) return false;
      previous = receipt.receiptDigest;
    }
    if (state.stopReceipt !== null) {
      if (state.stopReceipt.previousReceiptDigest !== previous
          || state.stopReceipt.receiptDigest !== receiptDigest(state.stopReceipt)) return false;
      previous = state.stopReceipt.receiptDigest;
    }
    if (state.admission !== null) {
      const admission = validateExecutionAdmissionReceipt(
        state.admission.receipt,
        {
          projectSlug: state.projectSlug,
          taskId: state.taskId,
          requiredProfiles: state.admissionProfiles,
          sourceFingerprint: state.admission.sourceFingerprint,
        },
        state.admission.observedAt,
      );
      const transition = state.phaseReceipts.find((receipt) => receipt.reasonCode === 'PREFLIGHT_READY');
      if (admission.admissionDigest !== state.admission.admissionDigest
          || !transition?.evidenceReceiptDigests.includes(admission.admissionDigest)) return false;
    }
    if (state.acceptance.receipt !== null) {
      const acceptance = validateAcceptanceReceipt(state.acceptance.receipt, state.acceptance.sourceFingerprint);
      const transition = state.phaseReceipts.findLast((receipt) => receipt.to === 'CLOSEOUT');
      if (!transition?.evidenceReceiptDigests.includes(acceptance.receiptDigest)) return false;
    }
    if (state.closeout.evidenceTruthReceipt !== null) {
      const terminalTransition = state.phaseReceipts.at(-1);
      const evidenceTruth = validateEvidenceTruthReceipt(
        state.closeout.evidenceTruthReceipt,
        state.sourceFingerprint,
        terminalTransition?.previousReceiptDigest,
      );
      if (!terminalTransition?.evidenceReceiptDigests.includes(evidenceTruth.receiptDigest)) return false;
    }
    return state.receiptHeadDigest === previous;
  } catch {
    return false;
  }
}

export function validateExecutionState(state) {
  if (!plainObject(state) || state.schemaVersion !== EXECUTION_STATE_SCHEMA_VERSION) {
    fail('EXECUTION_STATE_INVALID', 'Execution state schema is invalid.');
  }
  requiredString(state.executionId, SAFE_ID, 'executionId');
  requiredString(state.projectSlug, SAFE_ID, 'projectSlug');
  requiredString(state.taskId, SAFE_ID, 'taskId');
  requiredString(state.contractId, SHA256, 'contractId');
  requiredString(state.registryDigest, SHA256, 'registryDigest');
  requiredString(state.sourceFingerprint, SHA256, 'sourceFingerprint');
  if (!ACTION_CEILING_SET.has(state.actionCeiling)) {
    fail('EXECUTION_STATE_INVALID', 'State actionCeiling is invalid.');
  }
  if (!PHASE_SET.has(state.phase) && !TERMINAL_SET.has(state.phase)) fail('EXECUTION_STATE_INVALID', 'State phase is invalid.');
  if (state.terminalOutcome !== null && state.terminalOutcome !== state.phase) {
    fail('EXECUTION_STATE_INVALID', 'Terminal outcome must equal terminal phase.');
  }
  if (!plainObject(state.budgets?.limits) || !plainObject(state.budgets?.used)
      || !plainObject(state.budgets?.reserved) || !plainObject(state.budgets?.reservations)) {
    fail('EXECUTION_STATE_INVALID', 'Budget state is invalid.');
  }
  for (const dimension of EXECUTION_BUDGET_DIMENSIONS) {
    boundedInteger(state.budgets.limits[dimension], 1, 10_000, `budgets.limits.${dimension}`);
    boundedInteger(state.budgets.used[dimension], 0, state.budgets.limits[dimension], `budgets.used.${dimension}`);
    boundedInteger(state.budgets.reserved[dimension], 0, state.budgets.limits[dimension], `budgets.reserved.${dimension}`);
    if (state.budgets.used[dimension] + state.budgets.reserved[dimension] > state.budgets.limits[dimension]) {
      fail('EXECUTION_STATE_INVALID', `Budget ${dimension} exceeds its limit.`);
    }
  }
  const reservationTotals = Object.fromEntries(EXECUTION_BUDGET_DIMENSIONS.map((dimension) => [dimension, 0]));
  for (const [reservationId, reservation] of Object.entries(state.budgets.reservations)) {
    requiredString(reservationId, SAFE_ID, 'reservationId');
    if (!plainObject(reservation) || reservation.reservationId !== reservationId
        || !DIMENSION_SET.has(reservation.dimension)
        || (!PHASE_SET.has(reservation.phase) && !TERMINAL_SET.has(reservation.phase))) {
      fail('EXECUTION_STATE_INVALID', `Reservation ${reservationId} is invalid.`);
    }
    boundedInteger(reservation.amount, 1, 1_000, `reservation.${reservationId}.amount`);
    reservationTotals[reservation.dimension] += reservation.amount;
  }
  for (const dimension of EXECUTION_BUDGET_DIMENSIONS) {
    if (reservationTotals[dimension] !== state.budgets.reserved[dimension]) {
      fail('EXECUTION_STATE_INVALID', `Reserved ${dimension} does not match reservation records.`);
    }
  }
  if ((state.terminalOutcome === null) !== (state.stopReceipt === null)) {
    fail('EXECUTION_STATE_INVALID', 'Only terminal state may contain a stop receipt.');
  }
  if (!Array.isArray(state.phaseReceipts) || state.phaseReceipts.length < 1) {
    fail('EXECUTION_STATE_INVALID', 'Phase receipts are missing.');
  }
  if (state.admission !== null) {
    const hostAdmission = isHostExecutionAdmissionReceipt(state.admission.receipt);
    exactKeys(state.admission, hostAdmission ? [
      'admissionId', 'projectSlug', 'taskId', 'runnerBootId', 'runnerRevision', 'profiles',
      'sourceFingerprint', 'dependencyManifestFingerprint', 'executionMode', 'toolchainDigest',
      'profilePolicyDigest', 'issuedAt', 'expiresAt', 'observedAt', 'admissionDigest', 'receipt',
    ] : [
      'admissionId', 'projectSlug', 'taskId', 'runnerBootId', 'runnerRevision', 'profiles',
      'sourceFingerprint', 'dependencyManifestFingerprint', 'cachePackDigest', 'issuedAt',
      'expiresAt', 'observedAt', 'admissionDigest', 'receipt',
    ], 'state.admission');
    const validated = validateExecutionAdmissionReceipt(
      state.admission.receipt,
      {
        projectSlug: state.projectSlug,
        taskId: state.taskId,
        requiredProfiles: state.admissionProfiles,
        sourceFingerprint: state.admission.sourceFingerprint,
      },
      state.admission.observedAt,
    );
    const expectedIdentity = storedExecutionAdmission(validated, state.admission.observedAt);
    if (canonicalExecutionJson(state.admission) !== canonicalExecutionJson(expectedIdentity)) {
      fail('EXECUTION_STATE_INVALID', 'Stored execution admission identity does not match its receipt.');
    }
  }
  return state;
}
