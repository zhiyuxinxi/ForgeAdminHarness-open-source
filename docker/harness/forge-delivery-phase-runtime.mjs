import crypto from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalStringify,
  compileForgeTaskExecutionContract,
} from './forge-task-execution-contract.mjs';

export const FORGE_DELIVERY_PHASE_CATALOG_SCHEMA = 'forge-delivery-phase-catalog/v1';
export const FORGE_DELIVERY_PHASE_STATE_SCHEMA = 'forge-delivery-phase-state/v2';
export const FORGE_DELIVERY_PHASE_ARTIFACT_SCHEMA = 'forge-delivery-phase-artifact/v1';
export const FORGE_DELIVERY_PHASE_RECEIPT_SCHEMA = 'forge-delivery-phase-receipt/v1';
export const FORGE_CROSS_LAYER_HOST_REUSE_REASON = 'CROSS_LAYER_UNCHANGED_SOURCE_HOST_REUSED';
export const FORGE_STALE_WRITE_RECOVERY_RECEIPT_SCHEMA = 'forge-delivery-phase-stale-write-recovery/v1';
export const FORGE_READONLY_ROLE_RECOVERY_RECEIPT_SCHEMA = 'forge-delivery-phase-readonly-role-recovery/v1';

const LEGACY_FORGE_DELIVERY_PHASE_STATE_SCHEMA = 'forge-delivery-phase-state/v1';
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const SESSION_ID_PATTERN = /^[^\0\r\n]{1,1024}$/u;
const RPC_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/u;
const ARTIFACT_KIND_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const STALE_WRITE_INCIDENT_CODE = 'STALE_WRITE_PROGRESS_GUARD_DEADLOCK';
const LEGACY_FRONTEND_PROFILE_CATALOG_VERSION = '2026.09.03.4';
const FRONTEND_TYPECHECK_REQUIRED_CATALOG_VERSION = '2026.09.03.5';
const FRONTEND_TYPECHECK_PROFILE = 'frontend-admin-typecheck';
const PHASE_KEYS = Object.freeze([
  'id',
  'index',
  'sessionMode',
  'actionCeiling',
  'taskProfiles',
  'ownedPaths',
  'sourceMutation',
  'patchScope',
  'artifactKind',
  'requiresArtifacts',
  'requiredPayloadKeys',
  'requiredSkills',
  'contractVerificationProfiles',
  'hostVerificationProfiles',
  'maxAttempts',
]);

export class ForgeDeliveryPhaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeDeliveryPhaseError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeDeliveryPhaseError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail('PHASE_INPUT_INVALID', `${label} must be an object.`);
  const expected = new Set(allowed);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    fail('PHASE_INPUT_INVALID', `${label} fields do not match the reviewed schema.`);
  }
}

function requiredString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('PHASE_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function iso(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail('PHASE_INPUT_INVALID', `${label} must be an ISO timestamp.`);
  }
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stringArray(value, label, { pattern, allowEmpty = true, canonical = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((entry) => typeof entry !== 'string' || entry.length === 0
      || (pattern !== undefined && !pattern.test(entry)))) {
    fail('PHASE_INPUT_INVALID', `${label} must be a bounded string array.`);
  }
  if (new Set(value).size !== value.length) fail('PHASE_INPUT_INVALID', `${label} must be unique.`);
  if (canonical && [...value].sort().some((entry, index) => entry !== value[index])) {
    fail('PHASE_INPUT_INVALID', `${label} must use canonical order.`);
  }
  return value;
}

function relativePath(value, label) {
  requiredString(value, /^.{1,512}$/u, label);
  const normalized = value.replaceAll('\\', '/').normalize('NFC');
  if (normalized !== value || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)
    || normalized.includes(':') || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail('PHASE_PATH_INVALID', `${label} must be one normalized repository-relative path.`);
  }
  return normalized;
}

function pathWithin(candidate, root) {
  const candidateKey = candidate.toLocaleLowerCase('en-US');
  const rootKey = root.toLocaleLowerCase('en-US');
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}/`);
}

function stateWithoutDigest(state) {
  const { stateDigest: _ignored, ...payload } = state;
  return payload;
}

function receiptWithoutDigest(receipt) {
  const { receiptDigest: _ignored, ...payload } = receipt;
  return payload;
}

function staleWriteRecoveryWithoutDigest(receipt) {
  const { receiptDigest: _ignored, ...payload } = receipt;
  return payload;
}

function artifactWithoutDigest(artifact) {
  const { artifactDigest: _ignored, ...payload } = artifact;
  return payload;
}

export function validateForgeDeliveryPhaseArtifact(artifact) {
  exactKeys(artifact, [
    'schemaVersion', 'workflowId', 'phaseId', 'artifactKind', 'attemptId',
    'sourceFingerprint', 'upstreamArtifactDigests', 'unresolvedDecisions', 'changedPaths',
    'patchDigest', 'payload', 'artifactDigest',
  ], 'phase artifact');
  if (artifact.schemaVersion !== FORGE_DELIVERY_PHASE_ARTIFACT_SCHEMA
    || !ID_PATTERN.test(artifact.workflowId) || !ID_PATTERN.test(artifact.phaseId)
    || !ARTIFACT_KIND_PATTERN.test(artifact.artifactKind)
    || !ATTEMPT_ID_PATTERN.test(artifact.attemptId)
    || !SHA256_PATTERN.test(artifact.sourceFingerprint)
    || !isPlainObject(artifact.upstreamArtifactDigests)
    || Object.entries(artifact.upstreamArtifactDigests).some(([kind, value]) => (
      !ARTIFACT_KIND_PATTERN.test(kind) || !SHA256_PATTERN.test(value)
    ))
    || !isPlainObject(artifact.payload)
    || (artifact.patchDigest !== null && !SHA256_PATTERN.test(artifact.patchDigest))
    || !SHA256_PATTERN.test(artifact.artifactDigest)
    || artifact.artifactDigest !== digest(artifactWithoutDigest(artifact))) {
    fail('PHASE_ARTIFACT_INVALID', 'Phase artifact schema or digest is invalid.');
  }
  stringArray(artifact.unresolvedDecisions, 'artifact.unresolvedDecisions');
  stringArray(artifact.changedPaths, 'artifact.changedPaths')
    .forEach((entry) => relativePath(entry, 'changedPath'));
  return deepFreeze(clone(artifact));
}

function validateAttempt(attempt, workflow, currentPhaseIndex, previousGeneration) {
  exactKeys(attempt, [
    'attemptId', 'phaseId', 'phaseIndex', 'sessionMode', 'rpcId', 'promptDigest',
    'executionGeneration', 'startedAt',
  ], 'active phase attempt');
  const phase = workflow.phases[currentPhaseIndex];
  if (!ATTEMPT_ID_PATTERN.test(attempt.attemptId)
    || attempt.phaseId !== phase.id || attempt.phaseIndex !== phase.index
    || !['create', 'resume'].includes(attempt.sessionMode)
    || (previousGeneration === 0 ? attempt.sessionMode !== 'create' : attempt.sessionMode !== 'resume')
    || !Number.isSafeInteger(attempt.executionGeneration) || attempt.executionGeneration < 1
    || !RPC_ID_PATTERN.test(attempt.rpcId) || !SHA256_PATTERN.test(attempt.promptDigest)) {
    fail('PHASE_STATE_INVALID', 'Active phase attempt does not match the current workflow generation.');
  }
  iso(attempt.startedAt, 'activeAttempt.startedAt');
}

function validateReceipt(receipt, workflow, expectedPhaseIndex, previousGeneration) {
  const reusedHost = receipt.reasonCode === FORGE_CROSS_LAYER_HOST_REUSE_REASON;
  exactKeys(receipt, [
    'schemaVersion', 'issuer', 'workflowId', 'phaseId', 'phaseIndex', 'attemptId',
    'executionGeneration', 'decision', 'reasonCode', 'artifactDigest', 'patchDigest',
    'hostReceiptDigests', 'completedAt', 'receiptDigest',
    ...(reusedHost ? ['hostVerificationReuse'] : []),
  ], 'phase history receipt');
  const phase = workflow.phases[expectedPhaseIndex];
  if (receipt.schemaVersion !== FORGE_DELIVERY_PHASE_RECEIPT_SCHEMA
    || receipt.issuer !== 'forge-phase-controller' || receipt.workflowId !== workflow.id
    || receipt.phaseId !== phase.id || receipt.phaseIndex !== phase.index
    || !ATTEMPT_ID_PATTERN.test(receipt.attemptId)
    || !Number.isSafeInteger(receipt.executionGeneration)
    || receipt.executionGeneration <= previousGeneration
    || !['accepted', 'rejected', 'blocked'].includes(receipt.decision)
    || (receipt.reasonCode !== null
      && (typeof receipt.reasonCode !== 'string' || !/^[A-Z0-9_]{3,64}$/u.test(receipt.reasonCode)))
    || !Array.isArray(receipt.hostReceiptDigests)
    || receipt.hostReceiptDigests.some((value) => !SHA256_PATTERN.test(value))
    || !SHA256_PATTERN.test(receipt.receiptDigest)
    || receipt.receiptDigest !== digest(receiptWithoutDigest(receipt))) {
    fail('PHASE_STATE_INVALID', 'Phase history receipt is invalid or out of order.');
  }
  iso(receipt.completedAt, 'history.completedAt');
  if (receipt.decision === 'accepted') {
    const expectsPatch = phase.patchScope !== 'none';
    if (!SHA256_PATTERN.test(receipt.artifactDigest ?? '')
      || (expectsPatch ? !SHA256_PATTERN.test(receipt.patchDigest ?? '') : receipt.patchDigest !== null)
      || receipt.hostReceiptDigests.length !== (reusedHost ? 0 : phase.hostVerificationProfiles.length)) {
      fail('PHASE_STATE_INVALID', 'Accepted phase receipt is incomplete.');
    }
  } else if (receipt.artifactDigest !== null || receipt.patchDigest !== null
    || receipt.hostReceiptDigests.length !== 0 || reusedHost) {
    fail('PHASE_STATE_INVALID', 'Rejected phase receipt cannot retain accepted evidence.');
  }
  return phase;
}

// This narrowly scoped reuse is a record of no new Host execution, never three
// fabricated passed receipts. The retained artifact lets history independently
// verify the cumulative source binding, which phase-local patch hashes cannot.
function validateCrossLayerHostReuse({ workflow, history, acceptedArtifacts, sourceArtifact, sourceFingerprint }) {
  const phase = workflow.phases[7];
  if (workflow.id !== 'crud-production' || workflow.phases.length !== 8
    || phase?.id !== 'cross-layer-acceptance' || phase.index !== 7
    || phase.actionCeiling !== 'read-only' || phase.sourceMutation !== false
    || phase.ownedPaths.length !== 0 || phase.patchScope !== 'cumulative'
    || JSON.stringify(phase.hostVerificationProfiles) !== JSON.stringify(['governance', 'changed-safe', 'full-regression'])
    || Object.keys(acceptedArtifacts).length !== 7) {
    fail('PHASE_HOST_RECEIPT_INVALID', 'Host reuse is limited to the unchanged readonly cross-layer phase.');
  }
  for (const prior of workflow.phases.slice(0, 7)) {
    const receipt = history.findLast(entry => entry.decision === 'accepted' && entry.phaseId === prior.id);
    if (!receipt || receipt.artifactDigest !== acceptedArtifacts[prior.artifactKind]
      || receipt.hostReceiptDigests.length !== prior.hostVerificationProfiles.length) {
      fail('PHASE_HOST_RECEIPT_INVALID', 'Host reuse requires all seven current accepted upstream receipt bindings.');
    }
  }
  const source = validateForgeDeliveryPhaseArtifact(sourceArtifact);
  const sourceKind = currentForgeRuntimeSourceArtifactKind({ history, acceptedArtifacts });
  const sourcePhase = workflow.phases.find(item => item.artifactKind === sourceKind);
  const sourceReceipt = history.findLast(entry => entry.decision === 'accepted' && entry.phaseId === sourcePhase?.id);
  if (source.workflowId !== workflow.id || source.artifactKind !== sourceKind || source.phaseId !== sourcePhase?.id
    || source.artifactDigest !== acceptedArtifacts[sourceKind] || sourceReceipt?.artifactDigest !== source.artifactDigest
    || source.attemptId !== sourceReceipt.attemptId || source.unresolvedDecisions.length !== 0
    || source.sourceFingerprint !== sourceFingerprint) {
    fail('PHASE_HOST_RECEIPT_INVALID', 'Host reuse must retain the latest accepted cumulative source, including corrections.');
  }
}

function validateStaleWriteRecoveryReceipt(receipt, state, workflow, expectedPhaseIndex, previousGeneration) {
  exactKeys(receipt, [
    'schemaVersion', 'issuer', 'incidentCode', 'operationId', 'workflowId', 'phaseId',
    'phaseIndex', 'taskId', 'sessionId', 'sourceCommit', 'catalogDigest', 'attemptId',
    'executionGeneration', 'rpcId', 'promptDigest', 'frozenStateFileDigest',
    'failureEvidenceDigest', 'writerRecoveryTraceDigest', 'artifactStatus',
    'hostReceiptDigests', 'hostRunnerExecuted', 'budgetDisposition',
    'executionCostConsumed', 'failedAt', 'receiptDigest',
  ], 'stale-write recovery receipt');
  const phase = workflow.phases[expectedPhaseIndex];
  if (receipt.schemaVersion !== FORGE_STALE_WRITE_RECOVERY_RECEIPT_SCHEMA
    || receipt.issuer !== 'forge-phase-controller'
    || receipt.incidentCode !== STALE_WRITE_INCIDENT_CODE
    || !ATTEMPT_ID_PATTERN.test(receipt.operationId ?? '')
    || receipt.workflowId !== state.workflowId || receipt.phaseId !== 'database'
    || receipt.phaseId !== phase?.id || receipt.phaseIndex !== phase.index
    || receipt.taskId !== state.taskId || receipt.sessionId !== state.sessionId
    || receipt.sourceCommit !== state.sourceCommit || receipt.catalogDigest !== state.catalogDigest
    || !ATTEMPT_ID_PATTERN.test(receipt.attemptId ?? '')
    || !Number.isSafeInteger(receipt.executionGeneration)
    || receipt.executionGeneration <= previousGeneration
    || !RPC_ID_PATTERN.test(receipt.rpcId ?? '') || !SHA256_PATTERN.test(receipt.promptDigest ?? '')
    || !SHA256_PATTERN.test(receipt.frozenStateFileDigest ?? '')
    || !SHA256_PATTERN.test(receipt.failureEvidenceDigest ?? '')
    || !SHA256_PATTERN.test(receipt.writerRecoveryTraceDigest ?? '')
    || receipt.artifactStatus !== 'absent'
    || !Array.isArray(receipt.hostReceiptDigests) || receipt.hostReceiptDigests.length !== 0
    || receipt.hostRunnerExecuted !== false
    || receipt.budgetDisposition !== 'quality-attempt-not-consumed'
    || receipt.executionCostConsumed !== true
    || !SHA256_PATTERN.test(receipt.receiptDigest ?? '')
    || receipt.receiptDigest !== digest(staleWriteRecoveryWithoutDigest(receipt))) {
    fail('PHASE_STATE_INVALID', 'Stale-write recovery receipt is invalid or out of order.');
  }
  iso(receipt.failedAt, 'history.failedAt');
  return phase;
}

function isStaleWriteRecoveryReceipt(entry) {
  return entry?.schemaVersion === FORGE_STALE_WRITE_RECOVERY_RECEIPT_SCHEMA;
}

function validateReadonlyRoleRecoveryReceipt(receipt, state, workflow, expectedPhaseIndex, previousGeneration) {
  exactKeys(receipt, [
    'schemaVersion', 'issuer', 'incidentCode', 'operationId', 'workflowId', 'phaseId',
    'phaseIndex', 'taskId', 'sessionId', 'sourceCommit', 'catalogDigest', 'attemptId',
    'executionGeneration', 'rpcId', 'promptDigest', 'frozenStateFileDigest',
    'failureEvidenceDigest', 'budgetDisposition', 'executionCostConsumed', 'failedAt', 'receiptDigest',
  ], 'readonly-role recovery receipt');
  const phase = workflow.phases[expectedPhaseIndex];
  if (receipt.schemaVersion !== FORGE_READONLY_ROLE_RECOVERY_RECEIPT_SCHEMA
    || receipt.issuer !== 'forge-phase-controller'
    || receipt.incidentCode !== 'READONLY_ROLE_PROMPT_MISCLASSIFIED'
    || !ATTEMPT_ID_PATTERN.test(receipt.operationId ?? '')
    || receipt.workflowId !== state.workflowId || receipt.phaseId !== 'frontend' || receipt.phaseIndex !== 5
    || receipt.phaseId !== phase?.id || receipt.phaseIndex !== phase.index
    || receipt.taskId !== state.taskId || receipt.sessionId !== state.sessionId
    || receipt.sourceCommit !== state.sourceCommit || receipt.catalogDigest !== state.catalogDigest
    || !ATTEMPT_ID_PATTERN.test(receipt.attemptId ?? '')
    || !Number.isSafeInteger(receipt.executionGeneration)
    || receipt.executionGeneration <= previousGeneration
    || !RPC_ID_PATTERN.test(receipt.rpcId ?? '') || !SHA256_PATTERN.test(receipt.promptDigest ?? '')
    || !SHA256_PATTERN.test(receipt.frozenStateFileDigest ?? '')
    || !SHA256_PATTERN.test(receipt.failureEvidenceDigest ?? '')
    || receipt.budgetDisposition !== 'quality-attempt-not-consumed'
    || receipt.executionCostConsumed !== true
    || !SHA256_PATTERN.test(receipt.receiptDigest ?? '')
    || receipt.receiptDigest !== digest(receiptWithoutDigest(receipt))) {
    fail('PHASE_STATE_INVALID', 'Readonly-role recovery receipt is invalid or out of order.');
  }
  iso(receipt.failedAt, 'history.failedAt');
  return phase;
}

function isTechnicalRecoveryReceipt(entry) {
  return isStaleWriteRecoveryReceipt(entry)
    || entry?.schemaVersion === FORGE_READONLY_ROLE_RECOVERY_RECEIPT_SCHEMA
    || isAccessProviderRecovery(entry);
}

const ACCESS_ACCEPTED_CORRECTION_SCHEMA = 'forge-delivery-access-accepted-correction/v1';
const BACKEND_ACCEPTED_CORRECTION_SCHEMA = 'forge-delivery-backend-accepted-correction/v1';
function isAccessAcceptedCorrection(entry) {
  return entry?.schemaVersion === ACCESS_ACCEPTED_CORRECTION_SCHEMA
    || entry?.schemaVersion === BACKEND_ACCEPTED_CORRECTION_SCHEMA;
}

const ACCESS_PROVIDER_RECOVERY_SCHEMA = 'forge-delivery-phase-provider-recovery/v1';
function isAccessProviderRecovery(entry) { return entry?.schemaVersion === ACCESS_PROVIDER_RECOVERY_SCHEMA; }

export function currentForgeAccessAcceptedCorrection(state) {
  const last = state.history.at(-1);
  const entry = isAccessProviderRecovery(last) ? state.history.at(-2) : last;
  return isAccessAcceptedCorrection(entry) ? entry : null;
}

// Both callers validate the state before choosing this cumulative source.
// Only the completed, retained backend correction may replace the A7 source.
export function currentForgeRuntimeSourceArtifactKind(state) {
  const accepted = state.history.findLast(entry => entry.decision === 'accepted');
  const correction = state.history[state.history.indexOf(accepted) - 1];
  return accepted?.phaseId === 'backend' && accepted.phaseIndex === 4
    && correction?.schemaVersion === BACKEND_ACCEPTED_CORRECTION_SCHEMA
    && correction.attemptId === accepted.attemptId
    && accepted.artifactDigest === state.acceptedArtifacts['backend-implementation']
    ? 'backend-implementation' : 'access-wiring-implementation';
}

function accessPhaseExecutions(history) {
  return history.filter((entry, index) => !isAccessAcceptedCorrection(entry)
    && (isAccessProviderRecovery(entry) || currentForgeAccessAcceptedCorrection({ history: history.slice(0, index) }) === null)).length;
}

function validateAccessProviderRecovery(receipt, state, workflow, expectedPhaseIndex, previousGeneration, correction) {
  exactKeys(receipt, ['schemaVersion', 'issuer', 'workflowId', 'phaseId', 'phaseIndex', 'taskId', 'sessionId',
    'sourceCommit', 'catalogDigest', 'attemptId', 'executionGeneration', 'rpcId', 'promptDigest',
    'frozenStateFileDigest', 'failureEvidenceDigest', 'workspaceFingerprint', 'correctionReceiptDigest',
    'attemptStartedAt', 'budgetDisposition', 'executionCostConsumed', 'failedAt', 'receiptDigest'], 'access provider recovery');
  const phase = workflow.phases[expectedPhaseIndex];
  if (!isAccessProviderRecovery(receipt) || receipt.issuer !== 'forge-phase-controller'
    || state.workflowId !== 'crud-production' || receipt.workflowId !== state.workflowId
    || phase?.id !== 'access-wiring' || expectedPhaseIndex !== 6 || receipt.phaseId !== phase.id || receipt.phaseIndex !== 6
    || correction === null || receipt.correctionReceiptDigest !== correction.receiptDigest || receipt.attemptId !== correction.attemptId
    || receipt.taskId !== state.taskId || receipt.sessionId !== state.sessionId || receipt.sourceCommit !== state.sourceCommit
    || receipt.catalogDigest !== state.catalogDigest || !Number.isSafeInteger(receipt.executionGeneration)
    || receipt.executionGeneration <= previousGeneration || !RPC_ID_PATTERN.test(receipt.rpcId ?? '')
    || !SHA256_PATTERN.test(receipt.promptDigest ?? '') || !SHA256_PATTERN.test(receipt.frozenStateFileDigest ?? '')
    || !SHA256_PATTERN.test(receipt.failureEvidenceDigest ?? '') || !SHA256_PATTERN.test(receipt.workspaceFingerprint ?? '')
    || receipt.budgetDisposition !== 'quality-attempt-not-consumed' || receipt.executionCostConsumed !== true
    || receipt.receiptDigest !== digest(receiptWithoutDigest(receipt))) {
    fail('PHASE_STATE_INVALID', 'Provider recovery must consume the existing technical allowance of its accepted-access correction.');
  }
  iso(receipt.attemptStartedAt, 'history.attemptStartedAt'); iso(receipt.failedAt, 'history.failedAt');
  if (Date.parse(receipt.attemptStartedAt) > Date.parse(receipt.failedAt)) fail('PHASE_STATE_INVALID', 'Provider failure predates its attempt.');
  return phase;
}

function repeatsAccessCorrection(left, right) {
  return ['acceptedReceiptDigest', 'artifactDigest', 'acceptedSourceFingerprint', 'failureEvidenceSha256', 'jobId', 'executionId']
    .some(key => left[key] !== null && left[key] === right[key])
    || (isPlainObject(left.runtimeFailure) && isPlainObject(right.runtimeFailure)
      && ['observationId', 'manifestSha256'].some(key => left.runtimeFailure[key] === right.runtimeFailure[key]));
}

function suspendedCrossLayerAttemptFromHistory(history) {
  let suspended = null;
  for (const receipt of history) {
    if (isAccessAcceptedCorrection(receipt) && receipt.runtimeFailure !== undefined) suspended = receipt.suspendedCrossLayerAttempt;
    else if (receipt.phaseIndex === 7) suspended = null;
  }
  return suspended;
}

function validateAccessAcceptedCorrection(receipt, state, previous, expectedPhaseIndex, previousGeneration, workflow) {
  const backend = receipt.schemaVersion === BACKEND_ACCEPTED_CORRECTION_SCHEMA;
  const targetIndex = backend ? 4 : 6;
  const runtimeFailure = Object.hasOwn(receipt, 'runtimeFailure');
  exactKeys(receipt, ['schemaVersion', 'issuer', 'workflowId', 'phaseId', 'phaseIndex', 'taskId', 'sessionId',
    'sourceCommit', 'attemptId', 'acceptedReceiptDigest', 'artifactDigest', 'acceptedSourceFingerprint',
    'failureEvidenceSha256', 'jobId', 'executionId', 'executionGeneration', 'rpcId', 'workspaceFingerprint',
    'candidateCommit', 'sourceStateSha256', 'repairRequestSha256', 'completedAt', 'receiptDigest',
    ...(runtimeFailure ? ['runtimeFailure', 'suspendedCrossLayerAttempt'] : [])], 'accepted access correction');
  if (state.workflowId !== 'crud-production' || expectedPhaseIndex !== 7
    || receipt.issuer !== 'forge-phase-controller' || receipt.workflowId !== state.workflowId
    || receipt.phaseId !== workflow.phases[targetIndex].id || receipt.phaseIndex !== targetIndex
    || (backend && !runtimeFailure)
    || ['taskId', 'sessionId', 'sourceCommit'].some(key => receipt[key] !== state[key])
    || previous?.decision !== 'accepted' || previous.phaseIndex !== targetIndex
    || previous.attemptId !== receipt.attemptId || previous.receiptDigest !== receipt.acceptedReceiptDigest
    || previous.artifactDigest !== receipt.artifactDigest
    || !Number.isSafeInteger(receipt.executionGeneration) || receipt.executionGeneration <= previousGeneration
    || (runtimeFailure ? receipt.jobId !== null : !ATTEMPT_ID_PATTERN.test(receipt.jobId ?? ''))
    || !ATTEMPT_ID_PATTERN.test(receipt.executionId ?? '')
    || !RPC_ID_PATTERN.test(receipt.rpcId ?? '') || !/^[0-9a-f]{40}$/u.test(receipt.candidateCommit ?? '')
    || ['artifactDigest', 'acceptedSourceFingerprint', 'failureEvidenceSha256', 'workspaceFingerprint',
      'sourceStateSha256', 'repairRequestSha256'].some(key => !SHA256_PATTERN.test(receipt[key] ?? ''))
    || receipt.receiptDigest !== digest(receiptWithoutDigest(receipt))) {
    fail('PHASE_STATE_INVALID', 'Accepted access correction is not bound to its original acceptance and newer failure.');
  }
  iso(receipt.completedAt, 'accepted correction completedAt');
  if (runtimeFailure) {
    const terminalKey = backend ? 'formalTerminalSha256' : 'preparationTerminalSha256';
    exactKeys(receipt.runtimeFailure, ['observationId', 'manifestSha256', terminalKey], 'runtime failure binding');
    validateAttempt(receipt.suspendedCrossLayerAttempt, workflow, 7, previousGeneration);
    const suspended = receipt.suspendedCrossLayerAttempt;
    if (!ATTEMPT_ID_PATTERN.test(receipt.runtimeFailure.observationId ?? '')
      || ['manifestSha256', terminalKey].some(key => !SHA256_PATTERN.test(receipt.runtimeFailure[key] ?? ''))
      || suspended.attemptId === receipt.attemptId || suspended.executionGeneration <= previousGeneration
      || (backend ? receipt.executionGeneration !== suspended.executionGeneration : receipt.executionGeneration <= suspended.executionGeneration)
      || Date.parse(suspended.startedAt) < Date.parse(previous.completedAt)
      || Date.parse(receipt.completedAt) < Date.parse(suspended.startedAt)) {
      fail('PHASE_STATE_INVALID', 'Runtime correction must preserve its prior cross-layer attempt and newer protected failure.');
    }
  }
}

export function recordForgeAccessAcceptedCorrection({ state, catalog, binding, phaseId = 'access-wiring', now = new Date().toISOString() }) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  const runtimeFailure = Object.hasOwn(binding, 'runtimeFailure');
  if (current.status !== 'active' || current.currentPhaseIndex !== 7
    || (runtimeFailure ? current.activeAttempt === null : current.activeAttempt !== null)) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only a current accepted access candidate may be corrected.');
  }
  if (!['access-wiring', 'backend'].includes(phaseId) || (phaseId === 'backend' && !runtimeFailure)) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only a runtime-bound backend or access correction is supported.');
  }
  const phaseIndex = phaseId === 'backend' ? 4 : 6;
  const kind = workflowById(catalog, current.workflowId).phases[phaseIndex].artifactKind;
  const previous = phaseId === 'backend' ? current.history.findLast(entry => entry.phaseIndex === 4
    && entry.decision === 'accepted' && entry.artifactDigest === current.acceptedArtifacts[kind]) : current.history.at(-1);
  const receipt = withReceiptDigest({ schemaVersion: phaseId === 'backend' ? BACKEND_ACCEPTED_CORRECTION_SCHEMA : ACCESS_ACCEPTED_CORRECTION_SCHEMA, issuer: 'forge-phase-controller',
    workflowId: current.workflowId, phaseId, phaseIndex, taskId: current.taskId,
    sessionId: current.sessionId, sourceCommit: current.sourceCommit, attemptId: previous.attemptId,
    acceptedReceiptDigest: previous.receiptDigest, artifactDigest: previous.artifactDigest,
    ...binding, ...(runtimeFailure ? { suspendedCrossLayerAttempt: clone(current.activeAttempt) } : {}),
    completedAt: now, receiptDigest: '' });
  if (current.history.some(entry => isAccessAcceptedCorrection(entry) && repeatsAccessCorrection(entry, receipt))) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'An accepted candidate or protected failure cannot be corrected twice.');
  }
  const next = clone(current);
  next.history.push(receipt);
  delete next.acceptedArtifacts[kind];
  next.currentPhaseIndex = phaseIndex; next.currentPhaseId = phaseId;
  next.lastExecutionGeneration = receipt.executionGeneration;
  if (runtimeFailure) next.activeAttempt = null;
  next.revision += runtimeFailure ? 1 : 2; next.updatedAt = now;
  return validateForgeDeliveryPhaseState(withStateDigest(next), catalog);
}

function withStateDigest(state) {
  const next = clone(state);
  next.stateDigest = digest(stateWithoutDigest(next));
  return deepFreeze(next);
}

function withReceiptDigest(receipt) {
  const next = clone(receipt);
  next.receiptDigest = digest(receiptWithoutDigest(next));
  return deepFreeze(next);
}

function withStaleWriteRecoveryDigest(receipt) {
  const next = clone(receipt);
  next.receiptDigest = digest(staleWriteRecoveryWithoutDigest(next));
  return deepFreeze(next);
}

function workflowById(catalog, workflowId) {
  const workflow = catalog.workflows.find((entry) => entry.id === workflowId);
  if (workflow === undefined) fail('PHASE_WORKFLOW_UNKNOWN', `Unknown delivery workflow ${workflowId}.`);
  return workflow;
}

function phaseById(workflow, phaseId) {
  const phase = workflow.phases.find((entry) => entry.id === phaseId);
  if (phase === undefined) fail('PHASE_UNKNOWN', `Unknown delivery phase ${phaseId}.`);
  return phase;
}

function contractProfilesForCatalogVersion(catalogVersion, contract) {
  if (catalogVersion !== LEGACY_FRONTEND_PROFILE_CATALOG_VERSION
    || !contract.requiredVerificationProfiles.includes(FRONTEND_TYPECHECK_PROFILE)) {
    return contract.requiredVerificationProfiles;
  }
  return contract.requiredVerificationProfiles.filter(
    (profile) => profile !== FRONTEND_TYPECHECK_PROFILE,
  );
}

function validateVersionedFrontendProfiles(catalogVersion, phase, contract) {
  if (!contract.requiredVerificationProfiles.includes(FRONTEND_TYPECHECK_PROFILE)) return;
  const contractHasTypecheck = phase.contractVerificationProfiles.includes(FRONTEND_TYPECHECK_PROFILE);
  const hostHasTypecheck = phase.hostVerificationProfiles.includes(FRONTEND_TYPECHECK_PROFILE);
  if (catalogVersion === LEGACY_FRONTEND_PROFILE_CATALOG_VERSION
    && (contractHasTypecheck || hostHasTypecheck)) {
    fail(
      'PHASE_CATALOG_CONTRACT_MISMATCH',
      `Phase ${phase.id} adds a frontend typecheck profile that is not part of catalog ${catalogVersion}.`,
    );
  }
  if (catalogVersion === FRONTEND_TYPECHECK_REQUIRED_CATALOG_VERSION
    && (!contractHasTypecheck || !hostHasTypecheck)) {
    fail(
      'PHASE_CATALOG_CONTRACT_MISMATCH',
      `Phase ${phase.id} must require frontend-admin-typecheck in catalog ${catalogVersion}.`,
    );
  }
}

export function validateForgeDeliveryPhaseCatalog(value) {
  exactKeys(value, ['schemaVersion', 'catalogVersion', 'workflows'], 'phase catalog');
  if (value.schemaVersion !== FORGE_DELIVERY_PHASE_CATALOG_SCHEMA) {
    fail('PHASE_CATALOG_UNSUPPORTED', 'Unsupported delivery phase catalog schema.');
  }
  requiredString(value.catalogVersion, VERSION_PATTERN, 'catalogVersion');
  if (!Array.isArray(value.workflows) || value.workflows.length < 1 || value.workflows.length > 32) {
    fail('PHASE_CATALOG_INVALID', 'Phase catalog workflows are invalid.');
  }
  const workflowIds = new Set();
  for (const workflow of value.workflows) {
    exactKeys(workflow, ['id', 'caseFamilies', 'phases'], 'phase workflow');
    requiredString(workflow.id, ID_PATTERN, 'workflow id');
    if (workflowIds.has(workflow.id)) fail('PHASE_CATALOG_INVALID', 'Workflow ids must be unique.');
    workflowIds.add(workflow.id);
    stringArray(workflow.caseFamilies, 'caseFamilies', { pattern: ID_PATTERN, allowEmpty: false });
    if (!Array.isArray(workflow.phases) || workflow.phases.length < 2 || workflow.phases.length > 16) {
      fail('PHASE_CATALOG_INVALID', 'A delivery workflow must contain from 2 to 16 phases.');
    }
    const phaseIds = new Set();
    const producedArtifacts = new Set();
    for (let index = 0; index < workflow.phases.length; index += 1) {
      const phase = workflow.phases[index];
      exactKeys(phase, PHASE_KEYS, `phase ${index}`);
      requiredString(phase.id, ID_PATTERN, 'phase id');
      if (phaseIds.has(phase.id) || phase.index !== index) {
        fail('PHASE_CATALOG_INVALID', 'Phase ids and indexes must define one strict order.');
      }
      phaseIds.add(phase.id);
      const expectedSessionMode = index === 0 ? 'create' : 'resume';
      if (phase.sessionMode !== expectedSessionMode) {
        fail('PHASE_CATALOG_INVALID', `Phase ${phase.id} must use ${expectedSessionMode}.`);
      }
      if (typeof phase.sourceMutation !== 'boolean'
        || !['none', 'phase', 'cumulative'].includes(phase.patchScope)
        || phase.sourceMutation !== (phase.patchScope === 'phase')) {
        fail('PHASE_CATALOG_INVALID', `Phase ${phase.id} has an inconsistent mutation boundary.`);
      }
      if (phase.sourceMutation !== (phase.actionCeiling !== 'read-only')) {
        fail('PHASE_CATALOG_INVALID', `Phase ${phase.id} action ceiling exceeds its mutation boundary.`);
      }
      if (!Number.isSafeInteger(phase.maxAttempts) || phase.maxAttempts < 1 || phase.maxAttempts > 3) {
        fail('PHASE_CATALOG_INVALID', `Phase ${phase.id} maxAttempts is invalid.`);
      }
      const ownedPaths = stringArray(phase.ownedPaths, `${phase.id}.ownedPaths`)
        .map((entry) => relativePath(entry, `${phase.id}.ownedPaths`));
      if ((phase.sourceMutation && ownedPaths.length === 0) || (!phase.sourceMutation && ownedPaths.length !== 0)) {
        fail('PHASE_CATALOG_INVALID', `Phase ${phase.id} owned paths exceed its mutation boundary.`);
      }
      requiredString(phase.artifactKind, ARTIFACT_KIND_PATTERN, 'artifactKind');
      if (producedArtifacts.has(phase.artifactKind)) fail('PHASE_CATALOG_INVALID', 'Artifact kinds must be unique.');
      stringArray(phase.requiresArtifacts, `${phase.id}.requiresArtifacts`, { pattern: ARTIFACT_KIND_PATTERN });
      if (phase.requiresArtifacts.some((kind) => !producedArtifacts.has(kind))) {
        fail('PHASE_CATALOG_INVALID', `Phase ${phase.id} requires a future or unknown artifact.`);
      }
      stringArray(phase.requiredPayloadKeys, `${phase.id}.requiredPayloadKeys`, {
        pattern: /^[A-Za-z][A-Za-z0-9]{1,63}$/u,
        allowEmpty: false,
      });
      stringArray(phase.requiredSkills, `${phase.id}.requiredSkills`, { pattern: ID_PATTERN, allowEmpty: false });
      stringArray(phase.contractVerificationProfiles, `${phase.id}.contractVerificationProfiles`, {
        pattern: ID_PATTERN,
      });
      stringArray(phase.hostVerificationProfiles, `${phase.id}.hostVerificationProfiles`, {
        pattern: ID_PATTERN,
      });
      const contract = compileForgeTaskExecutionContract({
        prompt: `Execute operator-controlled Forge delivery phase ${phase.id}.`,
        ownedPaths,
        actionCeiling: phase.actionCeiling,
        taskProfiles: phase.taskProfiles,
      });
      const expectedContractProfiles = contractProfilesForCatalogVersion(value.catalogVersion, contract);
      validateVersionedFrontendProfiles(value.catalogVersion, phase, contract);
      if (JSON.stringify(contract.requiredSkills) !== JSON.stringify(phase.requiredSkills)
        || JSON.stringify(expectedContractProfiles)
          !== JSON.stringify(phase.contractVerificationProfiles)) {
        fail('PHASE_CATALOG_CONTRACT_MISMATCH', `Phase ${phase.id} differs from the deterministic task contract.`);
      }
      producedArtifacts.add(phase.artifactKind);
    }
  }
  return deepFreeze(clone(value));
}

export async function loadForgeDeliveryPhaseCatalog(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    fail('PHASE_CATALOG_UNAVAILABLE', 'Phase catalog path must be absolute.');
  }
  const information = await lstat(file).catch(() => undefined);
  if (information === undefined || !information.isFile() || information.isSymbolicLink()
    || information.size < 2 || information.size > 1024 * 1024) {
    fail('PHASE_CATALOG_UNAVAILABLE', 'Phase catalog must be a bounded regular file.');
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    fail('PHASE_CATALOG_INVALID', 'Phase catalog is not valid JSON.');
  }
  const catalog = validateForgeDeliveryPhaseCatalog(parsed);
  return deepFreeze({ catalog, catalogDigest: digest(catalog) });
}

export function resolveForgeDeliveryPhase({ catalog, workflowId, caseFamily, phaseId }) {
  const validated = validateForgeDeliveryPhaseCatalog(catalog);
  const workflow = workflowById(validated, requiredString(workflowId, ID_PATTERN, 'workflowId'));
  requiredString(caseFamily, ID_PATTERN, 'caseFamily');
  if (!workflow.caseFamilies.includes(caseFamily)) {
    fail('PHASE_CASE_FAMILY_DENIED', 'Case family is not admitted by the workflow.');
  }
  const phase = phaseById(workflow, requiredString(phaseId, ID_PATTERN, 'phaseId'));
  return deepFreeze({
    workflowId: workflow.id,
    caseFamily,
    phase: clone(phase),
    catalogVersion: validated.catalogVersion,
    catalogDigest: digest(validated),
  });
}

export function describeForgeDeliveryPhaseWorkflow({ catalog, workflowId, caseFamily }) {
  const validated = validateForgeDeliveryPhaseCatalog(catalog);
  const workflow = workflowById(validated, requiredString(workflowId, ID_PATTERN, 'workflowId'));
  requiredString(caseFamily, ID_PATTERN, 'caseFamily');
  if (!workflow.caseFamilies.includes(caseFamily)) {
    fail('PHASE_CASE_FAMILY_DENIED', 'Case family is not admitted by the workflow.');
  }
  return deepFreeze({
    workflowId: workflow.id,
    caseFamily,
    catalogVersion: validated.catalogVersion,
    catalogDigest: digest(validated),
    phaseCount: workflow.phases.length,
    sessionContinuity: `create-once-resume-${workflow.phases.length - 1}`,
    orderedPhases: workflow.phases.map((phase) => phase.id),
    artifactKinds: workflow.phases.map((phase) => phase.artifactKind),
    phases: workflow.phases.map((phase) => ({
      id: phase.id,
      index: phase.index,
      sessionMode: phase.sessionMode,
      actionCeiling: phase.actionCeiling,
      ownedPaths: [...phase.ownedPaths],
      artifactKind: phase.artifactKind,
      hostVerificationProfiles: [...phase.hostVerificationProfiles],
    })),
  });
}

export function projectCompletedForgeDeliveryPhaseExecution({
  catalog,
  workflowId,
  caseFamily,
  state,
}) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  const workflow = describeForgeDeliveryPhaseWorkflow({ catalog, workflowId, caseFamily });
  const backendCorrection = current.history.some(entry => entry.schemaVersion === BACKEND_ACCEPTED_CORRECTION_SCHEMA);
  const acceptedHistory = current.history.filter((entry) => entry.decision === 'accepted'
    && entry.artifactDigest === current.acceptedArtifacts[workflow.artifactKinds[entry.phaseIndex]]);
  // The validated history keeps execution order; a backend correction legitimately
  // follows the unaffected frontend/access acceptances. Project in workflow order.
  if (backendCorrection) acceptedHistory.sort((left, right) => left.phaseIndex - right.phaseIndex);
  if (current.workflowId !== workflow.workflowId || current.caseFamily !== workflow.caseFamily
    || current.status !== 'completed' || current.activeAttempt !== null
    || current.currentPhaseIndex !== workflow.phaseCount - 1
    || current.currentPhaseId !== workflow.orderedPhases.at(-1)
    || acceptedHistory.length !== workflow.phaseCount
    || acceptedHistory.some((entry, index) => entry.phaseId !== workflow.orderedPhases[index]
      || entry.phaseIndex !== index || !SHA256_PATTERN.test(entry.receiptDigest)
      || (!backendCorrection && index > 0 && entry.executionGeneration <= acceptedHistory[index - 1].executionGeneration))) {
    fail('PHASE_STATE_INVALID', 'Completed phase state does not match the reviewed workflow.');
  }
  const acceptedKinds = Object.keys(current.acceptedArtifacts).sort();
  const expectedKinds = [...workflow.artifactKinds].sort();
  if (acceptedKinds.length !== expectedKinds.length
    || acceptedKinds.some((kind, index) => kind !== expectedKinds[index])) {
    fail('PHASE_STATE_INVALID', 'Completed phase artifacts do not match the reviewed workflow.');
  }
  return deepFreeze({
    enabled: true,
    workflowId: current.workflowId,
    catalogVersion: current.catalogVersion,
    catalogDigest: current.catalogDigest,
    stateDigest: current.stateDigest,
    taskId: current.taskId,
    sessionId: current.sessionId,
    sessionContinuity: workflow.sessionContinuity,
    orderedPhases: [...workflow.orderedPhases],
    acceptedArtifactDigests: clone(current.acceptedArtifacts),
    operatorAdvancementProven: true,
    modelSelectedProfiles: false,
    modelSelectedCommands: false,
  });
}

export function validateForgeDeliveryPhaseExecutionProjection({
  catalog,
  workflowId,
  caseFamily,
  state,
  phaseExecution,
}) {
  if (workflowId === null || workflowId === undefined) {
    if (state !== null && state !== undefined) {
      fail('PHASE_STATE_INVALID', 'A non-phased case cannot retain phase state.');
    }
    if (phaseExecution !== null) {
      fail('PHASE_STATE_INVALID', 'A non-phased case cannot declare phased execution.');
    }
    return null;
  }
  const expected = projectCompletedForgeDeliveryPhaseExecution({
    catalog,
    workflowId,
    caseFamily,
    state,
  });
  if (canonicalStringify(phaseExecution) !== canonicalStringify(expected)) {
    fail('PHASE_STATE_INVALID', 'Phase execution projection does not match validated state.');
  }
  return expected;
}

export function createForgeDeliveryPhaseState({
  catalog,
  workflowId,
  caseFamily,
  taskId,
  sessionId,
  sourceCommit,
  now = new Date().toISOString(),
}) {
  const validated = validateForgeDeliveryPhaseCatalog(catalog);
  const workflow = workflowById(validated, requiredString(workflowId, ID_PATTERN, 'workflowId'));
  requiredString(caseFamily, ID_PATTERN, 'caseFamily');
  if (!workflow.caseFamilies.includes(caseFamily)) fail('PHASE_CASE_FAMILY_DENIED', 'Case family is not admitted.');
  requiredString(taskId, TASK_ID_PATTERN, 'taskId');
  requiredString(sessionId, SESSION_ID_PATTERN, 'sessionId');
  requiredString(sourceCommit, /^[0-9a-f]{40}$/u, 'sourceCommit');
  iso(now, 'now');
  return withStateDigest({
    schemaVersion: FORGE_DELIVERY_PHASE_STATE_SCHEMA,
    workflowId,
    catalogVersion: validated.catalogVersion,
    catalogDigest: digest(validated),
    caseFamily,
    taskId,
    sessionId,
    sourceCommit,
    status: 'active',
    currentPhaseIndex: 0,
    currentPhaseId: workflow.phases[0].id,
    lastExecutionGeneration: 0,
    acceptedArtifacts: {},
    activeAttempt: null,
    history: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    stateDigest: '',
  });
}

export function validateForgeDeliveryPhaseState(state, catalog) {
  exactKeys(state, [
    'schemaVersion', 'workflowId', 'catalogVersion', 'catalogDigest', 'caseFamily', 'taskId',
    'sessionId', 'sourceCommit', 'status', 'currentPhaseIndex', 'currentPhaseId',
    'lastExecutionGeneration', 'acceptedArtifacts', 'activeAttempt', 'history', 'revision',
    'createdAt', 'updatedAt', 'stateDigest',
  ], 'phase state');
  const validated = validateForgeDeliveryPhaseCatalog(catalog);
  const workflow = workflowById(validated, requiredString(state.workflowId, ID_PATTERN, 'workflowId'));
  if (![LEGACY_FORGE_DELIVERY_PHASE_STATE_SCHEMA, FORGE_DELIVERY_PHASE_STATE_SCHEMA]
    .includes(state.schemaVersion)
    || state.catalogVersion !== validated.catalogVersion || state.catalogDigest !== digest(validated)
    || !workflow.caseFamilies.includes(state.caseFamily)
    || !['active', 'blocked', 'completed'].includes(state.status)
    || !Number.isSafeInteger(state.currentPhaseIndex) || state.currentPhaseIndex < 0
    || state.currentPhaseIndex >= workflow.phases.length
    || workflow.phases[state.currentPhaseIndex].id !== state.currentPhaseId
    || !Number.isSafeInteger(state.lastExecutionGeneration) || state.lastExecutionGeneration < 0
    || !Number.isSafeInteger(state.revision) || state.revision < 1
    || !Array.isArray(state.history) || state.history.length > 128
    || !isPlainObject(state.acceptedArtifacts)) {
    fail('PHASE_STATE_INVALID', 'Phase state does not match the active workflow.');
  }
  requiredString(state.taskId, TASK_ID_PATTERN, 'taskId');
  requiredString(state.sessionId, SESSION_ID_PATTERN, 'sessionId');
  requiredString(state.sourceCommit, /^[0-9a-f]{40}$/u, 'sourceCommit');
  iso(state.createdAt, 'createdAt');
  iso(state.updatedAt, 'updatedAt');
  if (Date.parse(state.updatedAt) < Date.parse(state.createdAt)
    || state.revision !== 1 + (state.history.length * 2) + (state.activeAttempt === null ? 0 : 1)
    || (state.status !== 'active' && state.activeAttempt !== null)) {
    fail('PHASE_STATE_INVALID', 'Phase state lifecycle metadata is inconsistent.');
  }
  if (!SHA256_PATTERN.test(state.stateDigest) || state.stateDigest !== digest(stateWithoutDigest(state))) {
    fail('PHASE_STATE_INVALID', 'Phase state digest is invalid.');
  }
  let expectedPhaseIndex = 0;
  let previousGeneration = 0;
  let previousTimestamp = Date.parse(state.createdAt);
  const acceptedFromHistory = {};
  const attemptsByPhase = new Map();
  const totalExecutionsByPhase = new Map();
  const technicalRecoveriesByPhase = new Map();
  let terminalStatus = null;
  let accessCorrection = null;
  let suspendedCrossLayerAttempt = null;
  const accessCorrections = [];
  for (let index = 0; index < state.history.length; index += 1) {
    const receipt = state.history[index];
    if (isAccessAcceptedCorrection(receipt)) {
      if (accessCorrections.some(entry => repeatsAccessCorrection(entry, receipt)) || terminalStatus !== null) {
        fail('PHASE_STATE_INVALID', 'Accepted access correction cannot replay.');
      }
      const previousAcceptance = receipt.schemaVersion === BACKEND_ACCEPTED_CORRECTION_SCHEMA
        ? state.history.slice(0, index).findLast(entry => entry.phaseIndex === 4 && entry.decision === 'accepted'
          && entry.artifactDigest === acceptedFromHistory[workflow.phases[4].artifactKind]) : state.history[index - 1];
      validateAccessAcceptedCorrection(receipt, state, previousAcceptance, expectedPhaseIndex, previousGeneration, workflow);
      if (Date.parse(receipt.completedAt) < previousTimestamp) fail('PHASE_STATE_INVALID', 'Accepted correction timestamp is stale.');
      if (receipt.runtimeFailure !== undefined) {
        const suspended = receipt.suspendedCrossLayerAttempt;
        if (suspendedCrossLayerAttempt !== null && suspended.attemptId !== suspendedCrossLayerAttempt.attemptId) {
          fail('PHASE_STATE_INVALID', 'Runtime correction cannot replace a suspended cross-layer attempt.');
        }
        if (suspendedCrossLayerAttempt === null) {
          const crossPhase = workflow.phases[7];
          const attempts = (attemptsByPhase.get(crossPhase.id) ?? 0) + 1;
          const executions = (totalExecutionsByPhase.get(crossPhase.id) ?? 0) + 1;
          if (attempts > crossPhase.maxAttempts || executions > crossPhase.maxAttempts + 1) {
            fail('PHASE_STATE_INVALID', 'Suspended cross-layer attempt exceeds its existing budget.');
          }
          attemptsByPhase.set(crossPhase.id, attempts);
          totalExecutionsByPhase.set(crossPhase.id, executions);
        }
        suspendedCrossLayerAttempt = suspended;
      }
      accessCorrection = receipt; accessCorrections.push(receipt);
      delete acceptedFromHistory[workflow.phases[receipt.phaseIndex].artifactKind];
      expectedPhaseIndex = receipt.phaseIndex; previousGeneration = receipt.executionGeneration;
      previousTimestamp = Date.parse(receipt.completedAt);
      continue;
    }
    const technicalRecovery = isTechnicalRecoveryReceipt(receipt);
    if (accessCorrection !== null && technicalRecovery && !isAccessProviderRecovery(receipt)) fail('PHASE_STATE_INVALID', 'Accepted correction cannot acquire another recovery allowance.');
    if (technicalRecovery && state.schemaVersion !== FORGE_DELIVERY_PHASE_STATE_SCHEMA) {
      fail('PHASE_STATE_INVALID', 'Legacy phase state cannot contain a technical recovery receipt.');
    }
    const phase = isAccessProviderRecovery(receipt)
      ? validateAccessProviderRecovery(receipt, state, workflow, expectedPhaseIndex, previousGeneration, accessCorrection)
      : isStaleWriteRecoveryReceipt(receipt)
      ? validateStaleWriteRecoveryReceipt(receipt, state, workflow, expectedPhaseIndex, previousGeneration)
      : technicalRecovery
        ? validateReadonlyRoleRecoveryReceipt(receipt, state, workflow, expectedPhaseIndex, previousGeneration)
        : validateReceipt(receipt, workflow, expectedPhaseIndex, previousGeneration);
    if (receipt.reasonCode === FORGE_CROSS_LAYER_HOST_REUSE_REASON) {
      if (expectedPhaseIndex !== 7 || receipt.decision !== 'accepted') {
        fail('PHASE_STATE_INVALID', 'Host reuse cannot accept another phase.');
      }
      validateCrossLayerHostReuse({ workflow, history: state.history.slice(0, index),
        acceptedArtifacts: acceptedFromHistory, sourceArtifact: receipt.hostVerificationReuse,
        sourceFingerprint: receipt.patchDigest });
    }
    const completedAt = Date.parse(technicalRecovery ? receipt.failedAt : receipt.completedAt);
    if (completedAt < previousTimestamp || terminalStatus !== null) {
      fail('PHASE_STATE_INVALID', 'Phase history is not monotonic or continues after a terminal decision.');
    }
    previousTimestamp = completedAt;
    previousGeneration = receipt.executionGeneration;
    const resumingCrossLayerAttempt = phase.index === 7 && suspendedCrossLayerAttempt !== null;
    if (resumingCrossLayerAttempt && (technicalRecovery || receipt.attemptId !== suspendedCrossLayerAttempt.attemptId)) {
      fail('PHASE_STATE_INVALID', 'Suspended cross-layer attempt must resume without another recovery allowance.');
    }
    // A verified correction reuses an accepted attempt; it is not an ordinary retry.
    const totalExecutions = (totalExecutionsByPhase.get(phase.id) ?? 0)
      + (isAccessProviderRecovery(receipt) || (accessCorrection === null && !resumingCrossLayerAttempt) ? 1 : 0);
    totalExecutionsByPhase.set(phase.id, totalExecutions);
    if (totalExecutions > phase.maxAttempts + 1) {
      fail('PHASE_STATE_INVALID', 'Phase history exceeds its total execution budget.');
    }
    if (technicalRecovery) {
      const recoveries = (technicalRecoveriesByPhase.get(phase.id) ?? 0) + 1;
      technicalRecoveriesByPhase.set(phase.id, recoveries);
      if (recoveries > 1) fail('PHASE_STATE_INVALID', 'A phase can record a technical recovery only once.');
      continue;
    }
    const correctingAcceptedAttempt = accessCorrection !== null;
    if (correctingAcceptedAttempt && (technicalRecovery || phase.index !== accessCorrection.phaseIndex || receipt.attemptId !== accessCorrection.attemptId)) {
      fail('PHASE_STATE_INVALID', 'Accepted correction must complete its original attempt.');
    }
    const attempts = (attemptsByPhase.get(phase.id) ?? 0) + (correctingAcceptedAttempt || resumingCrossLayerAttempt ? 0 : 1);
    attemptsByPhase.set(phase.id, attempts);
    if (attempts > phase.maxAttempts) fail('PHASE_STATE_INVALID', 'Phase history exceeds its attempt budget.');
    if (receipt.decision === 'accepted') {
      acceptedFromHistory[phase.artifactKind] = receipt.artifactDigest;
      if (phase.index === workflow.phases.length - 1) terminalStatus = 'completed';
      else expectedPhaseIndex = accessCorrection?.phaseId === 'backend' ? 7 : expectedPhaseIndex + 1;
    } else if (correctingAcceptedAttempt || receipt.decision === 'blocked' || attempts === phase.maxAttempts) {
      terminalStatus = 'blocked';
    }
    accessCorrection = null;
    if (resumingCrossLayerAttempt) suspendedCrossLayerAttempt = null;
  }
  if ((terminalStatus ?? 'active') !== state.status || expectedPhaseIndex !== state.currentPhaseIndex
    || canonicalStringify(acceptedFromHistory) !== canonicalStringify(state.acceptedArtifacts)) {
    fail('PHASE_STATE_INVALID', 'Phase history does not project to the declared current state.');
  }
  if (state.activeAttempt !== null) {
    validateAttempt(state.activeAttempt, workflow, state.currentPhaseIndex, previousGeneration);
    const activePhase = workflow.phases[state.currentPhaseIndex];
    const priorQualityAttempts = attemptsByPhase.get(activePhase.id) ?? 0;
    const priorExecutions = totalExecutionsByPhase.get(activePhase.id) ?? 0;
    const resumingCrossLayerAttempt = activePhase.index === 7 && suspendedCrossLayerAttempt !== null;
    const additionalAttempt = accessCorrection === null && !resumingCrossLayerAttempt ? 1 : 0;
    if (state.activeAttempt.executionGeneration <= previousGeneration
      || (Date.parse(state.activeAttempt.startedAt) < previousTimestamp
         && !(isAccessProviderRecovery(state.history.at(-1)) && state.history.at(-1).attemptId === state.activeAttempt.attemptId
           && state.history.at(-1).attemptStartedAt === state.activeAttempt.startedAt))
      || state.lastExecutionGeneration !== state.activeAttempt.executionGeneration
      || (accessCorrection !== null && state.activeAttempt.attemptId !== accessCorrection.attemptId)
      || (resumingCrossLayerAttempt && state.activeAttempt.attemptId !== suspendedCrossLayerAttempt.attemptId)
      || priorQualityAttempts + additionalAttempt > activePhase.maxAttempts
      || priorExecutions + additionalAttempt > activePhase.maxAttempts + 1) {
      fail('PHASE_STATE_INVALID', 'Active attempt is stale or not generation-bound.');
    }
  } else if (state.lastExecutionGeneration !== previousGeneration) {
    fail('PHASE_STATE_INVALID', 'Last execution generation does not match phase history.');
  }
  const completedPhaseCount = state.status === 'completed'
    ? state.currentPhaseIndex + 1
    : state.currentPhaseIndex;
  const backendCorrection = state.currentPhaseIndex === 4
    && state.history.some(entry => entry.schemaVersion === BACKEND_ACCEPTED_CORRECTION_SCHEMA);
  const expectedArtifacts = (backendCorrection ? workflow.phases.slice(0, 7).filter(phase => phase.index !== 4)
    : workflow.phases.slice(0, completedPhaseCount)).map((phase) => phase.artifactKind);
  if (Object.keys(state.acceptedArtifacts).sort().join('\n') !== [...expectedArtifacts].sort().join('\n')
    || Object.values(state.acceptedArtifacts).some((value) => !SHA256_PATTERN.test(value))) {
    fail('PHASE_STATE_INVALID', 'Accepted artifacts do not match completed phases.');
  }
  return deepFreeze(clone(state));
}

export function beginForgeDeliveryPhase({
  state,
  catalog,
  phaseId,
  rpcId,
  promptDigest,
  executionGeneration,
  now = new Date().toISOString(),
}) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  const workflow = workflowById(catalog, current.workflowId);
  const phase = phaseById(workflow, requiredString(phaseId, ID_PATTERN, 'phaseId'));
  if (current.status !== 'active' || current.currentPhaseId !== phase.id || current.activeAttempt !== null) {
    fail('PHASE_ORDER_VIOLATION', 'Only the current idle phase can begin.');
  }
  requiredString(rpcId, RPC_ID_PATTERN, 'rpcId');
  requiredString(promptDigest, SHA256_PATTERN, 'promptDigest');
  if (!Number.isSafeInteger(executionGeneration)
    || executionGeneration <= current.lastExecutionGeneration) {
    fail('PHASE_GENERATION_REPLAY', 'Every phase attempt requires a newer protected execution generation.');
  }
  iso(now, 'now');
  const phaseHistory = current.history.filter((entry) => entry.phaseId === phase.id);
  const correction = currentForgeAccessAcceptedCorrection(current);
  const suspended = phase.index === 7 ? suspendedCrossLayerAttemptFromHistory(current.history) : null;
  const reusingAttempt = correction !== null || suspended !== null;
  const priorAttempts = new Set(phaseHistory.filter((entry) => !isTechnicalRecoveryReceipt(entry)
    && !isAccessAcceptedCorrection(entry)).map(entry => entry.attemptId)).size + (suspended === null ? 0 : 1);
  if (!reusingAttempt && priorAttempts >= phase.maxAttempts) fail('PHASE_ATTEMPTS_EXHAUSTED', 'Phase attempt budget is exhausted.');
  const priorExecutions = accessPhaseExecutions(phaseHistory) + (suspended === null ? 0 : 1);
  if (priorExecutions + (reusingAttempt ? 0 : 1) > phase.maxAttempts + 1) {
    fail('PHASE_ATTEMPTS_EXHAUSTED', 'Phase total execution budget is exhausted.');
  }
  const sessionMode = current.lastExecutionGeneration === 0 ? 'create' : 'resume';
  if ((current.lastExecutionGeneration === 0 && phase.index !== 0)
    || (phase.index > 0 && sessionMode !== 'resume')) {
    fail('PHASE_SESSION_MODE_INVALID', 'Only the first workflow attempt may create the persisted session.');
  }
  const attempt = {
    attemptId: correction?.attemptId ?? suspended?.attemptId ?? crypto.randomUUID(),
    phaseId: phase.id,
    phaseIndex: phase.index,
    sessionMode,
    rpcId,
    promptDigest,
    executionGeneration,
    startedAt: now,
  };
  const next = clone(current);
  next.activeAttempt = attempt;
  next.lastExecutionGeneration = executionGeneration;
  next.revision += 1;
  next.updatedAt = now;
  return withStateDigest(next);
}

// A requirements clarification is another readonly turn of the same attempt.
// It is not an acceptance, rejection, or a new quality-attempt allowance.
export function continueForgeRequirementsPhase({ state, catalog, rpcId, promptDigest, executionGeneration }) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  if (current.status !== 'active' || current.currentPhaseId !== 'requirements'
    || current.currentPhaseIndex !== 0 || current.activeAttempt === null) {
    fail('PHASE_ORDER_VIOLATION', 'Only an active requirements attempt can receive clarification.');
  }
  return continueReadonlyContractAttempt({ current, catalog, rpcId, promptDigest, executionGeneration });
}

export function continueForgeDomainContractPhase({ state, catalog, rpcId, promptDigest, executionGeneration }) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  if (current.status !== 'active' || current.currentPhaseId !== 'domain-contract'
    || current.currentPhaseIndex !== 1 || current.activeAttempt === null) {
    fail('PHASE_ORDER_VIOLATION', 'Only an active domain contract attempt can resume after user interruption.');
  }
  return continueReadonlyContractAttempt({ current, catalog, rpcId, promptDigest, executionGeneration });
}

export function continueForgeDatabaseLeasePause({ state, catalog, rpcId, promptDigest, executionGeneration }) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  if (current.workflowId !== 'crud-production' || current.status !== 'active'
    || current.currentPhaseId !== 'database' || current.currentPhaseIndex !== 2 || current.activeAttempt === null) {
    fail('PHASE_ORDER_VIOLATION', 'Only the active database attempt can resume its expired writer.');
  }
  return continueReadonlyContractAttempt({ current, catalog, rpcId, promptDigest, executionGeneration });
}

export function continueForgeBackendLeasePause({ state, catalog, rpcId, promptDigest, executionGeneration }) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  if (current.workflowId !== 'crud-production' || current.status !== 'active'
    || current.currentPhaseId !== 'backend' || current.currentPhaseIndex !== 4 || current.activeAttempt === null) {
    fail('PHASE_ORDER_VIOLATION', 'Only the active backend attempt can resume its expired writer.');
  }
  return continueReadonlyContractAttempt({ current, catalog, rpcId, promptDigest, executionGeneration });
}

export function continueForgeFrontendLeasePause({ state, catalog, rpcId, promptDigest, executionGeneration }) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  if (current.workflowId !== 'crud-production' || current.status !== 'active'
    || current.currentPhaseId !== 'frontend' || current.currentPhaseIndex !== 5 || current.activeAttempt === null) {
    fail('PHASE_ORDER_VIOLATION', 'Only the active frontend attempt can resume its expired writer.');
  }
  return continueReadonlyContractAttempt({ current, catalog, rpcId, promptDigest, executionGeneration });
}

export function continueForgeAccessWiringLeasePause({ state, catalog, rpcId, promptDigest, executionGeneration }) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  if (current.workflowId !== 'crud-production' || current.status !== 'active'
    || current.currentPhaseId !== 'access-wiring' || current.currentPhaseIndex !== 6 || current.activeAttempt === null) {
    fail('PHASE_ORDER_VIOLATION', 'Only the active access wiring attempt can resume its expired writer.');
  }
  return continueReadonlyContractAttempt({ current, catalog, rpcId, promptDigest, executionGeneration });
}

export function continueForgeCrossLayerRuntimeReprobe({ state, catalog, rpcId, promptDigest, executionGeneration }) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  if (current.workflowId !== 'crud-production' || current.status !== 'active'
    || current.currentPhaseId !== 'cross-layer-acceptance' || current.currentPhaseIndex !== 7 || current.activeAttempt === null) {
    fail('PHASE_ORDER_VIOLATION', 'Only the active cross-layer attempt can resume its runtime observation.');
  }
  return continueReadonlyContractAttempt({ current, catalog, rpcId, promptDigest, executionGeneration });
}

function continueReadonlyContractAttempt({ current, catalog, rpcId, promptDigest, executionGeneration }) {
  requiredString(rpcId, RPC_ID_PATTERN, 'rpcId');
  requiredString(promptDigest, SHA256_PATTERN, 'promptDigest');
  if (!Number.isSafeInteger(executionGeneration) || executionGeneration <= current.lastExecutionGeneration) {
    fail('PHASE_GENERATION_REPLAY', 'Continuation requires a newer protected execution.');
  }
  const next = clone(current);
  next.activeAttempt = { ...next.activeAttempt, rpcId, promptDigest, executionGeneration };
  next.lastExecutionGeneration = executionGeneration;
  // revision is the existing begin/finalize lifecycle count (validated as
  // 1 + history.length * 2 + active). Generation and stateDigest are the CAS
  // identity for a further execution inside this unchanged business attempt.
  return validateForgeDeliveryPhaseState(withStateDigest(next), catalog);
}

export function createForgeDeliveryPhaseArtifact({
  state,
  catalog,
  phaseId,
  attemptId,
  sourceFingerprint,
  unresolvedDecisions = [],
  changedPaths = [],
  patchDigest = null,
  payload,
}) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  const workflow = workflowById(catalog, current.workflowId);
  const phase = phaseById(workflow, requiredString(phaseId, ID_PATTERN, 'phaseId'));
  if (current.activeAttempt?.attemptId !== attemptId || current.currentPhaseId !== phase.id) {
    fail('PHASE_ATTEMPT_MISMATCH', 'Artifact does not belong to the active phase attempt.');
  }
  requiredString(sourceFingerprint, SHA256_PATTERN, 'sourceFingerprint');
  stringArray(unresolvedDecisions, 'unresolvedDecisions');
  if (!isPlainObject(payload)
    || phase.requiredPayloadKeys.some((key) => !Object.hasOwn(payload, key) || payload[key] === undefined)) {
    fail('PHASE_ARTIFACT_INVALID', 'Phase artifact payload is incomplete.');
  }
  const normalizedPaths = stringArray(changedPaths, 'changedPaths')
    .map((entry) => relativePath(entry, 'changedPath')).sort();
  if (phase.patchScope === 'none' && (normalizedPaths.length !== 0 || patchDigest !== null)) {
    fail('PHASE_MUTATION_DENIED', 'This phase cannot claim a source mutation.');
  }
  if (phase.patchScope === 'phase'
    && (normalizedPaths.length === 0 || typeof patchDigest !== 'string' || !SHA256_PATTERN.test(patchDigest))) {
    fail('PHASE_ARTIFACT_INVALID', 'A source phase requires changed paths and a phase patch digest.');
  }
  if (phase.patchScope === 'cumulative'
    && (normalizedPaths.length !== 0 || typeof patchDigest !== 'string' || !SHA256_PATTERN.test(patchDigest))) {
    fail('PHASE_ARTIFACT_INVALID', 'The acceptance phase requires only the cumulative patch digest.');
  }
  if (normalizedPaths.some((candidate) => !phase.ownedPaths.some((root) => pathWithin(candidate, root)))) {
    fail('PHASE_PATH_DENIED', 'Artifact contains a path outside the current phase owner.');
  }
  const upstreamArtifactDigests = Object.fromEntries(phase.requiresArtifacts.map((kind) => {
    const upstream = current.acceptedArtifacts[kind];
    if (!SHA256_PATTERN.test(upstream ?? '')) fail('PHASE_UPSTREAM_STALE', `Required artifact ${kind} is unavailable.`);
    return [kind, upstream];
  }));
  const artifact = {
    schemaVersion: FORGE_DELIVERY_PHASE_ARTIFACT_SCHEMA,
    workflowId: current.workflowId,
    phaseId: phase.id,
    artifactKind: phase.artifactKind,
    attemptId,
    sourceFingerprint,
    upstreamArtifactDigests,
    unresolvedDecisions: [...unresolvedDecisions],
    changedPaths: normalizedPaths,
    patchDigest,
    payload: clone(payload),
    artifactDigest: '',
  };
  artifact.artifactDigest = digest(artifactWithoutDigest(artifact));
  return validateForgeDeliveryPhaseArtifact(artifact);
}

function validateHostReceipts(receipts, phase, sourceFingerprint) {
  if (!Array.isArray(receipts)) fail('PHASE_HOST_RECEIPT_INVALID', 'Host receipts must be an array.');
  const profiles = receipts.map((receipt) => receipt?.profile);
  if (JSON.stringify(profiles) !== JSON.stringify(phase.hostVerificationProfiles)) {
    fail('PHASE_HOST_RECEIPT_INVALID', 'Host receipt profiles differ from the operator phase plan.');
  }
  for (const receipt of receipts) {
    exactKeys(receipt, ['profile', 'status', 'receiptDigest', 'patchDigest'], 'host receipt');
    if (receipt.status !== 'passed' || !SHA256_PATTERN.test(receipt.receiptDigest)
      || receipt.patchDigest !== sourceFingerprint) {
      fail('PHASE_HOST_VERIFICATION_FAILED', `Host verification ${receipt.profile} did not pass.`);
    }
  }
}

export function validateForgeCrossLayerHostVerificationReuse({ state, catalog, artifact, hostVerificationReuse }) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  const workflow = workflowById(catalog, current.workflowId);
  const candidate = validateForgeDeliveryPhaseArtifact(artifact);
  if (current.status !== 'active' || current.currentPhaseIndex !== 7 || current.activeAttempt === null
    || candidate.workflowId !== current.workflowId || candidate.phaseId !== 'cross-layer-acceptance'
    || candidate.attemptId !== current.activeAttempt.attemptId || candidate.changedPaths.length !== 0
    || candidate.unresolvedDecisions.length !== 0 || candidate.patchDigest !== candidate.sourceFingerprint
    || canonicalStringify(candidate.upstreamArtifactDigests) !== canonicalStringify(current.acceptedArtifacts)) {
    fail('PHASE_HOST_RECEIPT_INVALID', 'Host reuse requires the current unchanged cross-layer candidate and all accepted upstreams.');
  }
  validateCrossLayerHostReuse({ workflow, history: current.history, acceptedArtifacts: current.acceptedArtifacts,
    sourceArtifact: hostVerificationReuse, sourceFingerprint: candidate.sourceFingerprint });
}

export function completeForgeDeliveryPhase({
  state,
  catalog,
  decision,
  artifact = null,
  hostReceipts = [],
  hostVerificationReuse = null,
  reasonCode = null,
  now = new Date().toISOString(),
}) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  const workflow = workflowById(catalog, current.workflowId);
  const phase = workflow.phases[current.currentPhaseIndex];
  const attempt = current.activeAttempt;
  if (attempt === null) fail('PHASE_ATTEMPT_MISSING', 'No active phase attempt can be completed.');
  if (!['accepted', 'rejected', 'blocked'].includes(decision)) fail('PHASE_DECISION_INVALID', 'Unknown phase decision.');
  if (reasonCode !== null && (typeof reasonCode !== 'string' || !/^[A-Z0-9_]{3,64}$/u.test(reasonCode))) {
    fail('PHASE_DECISION_INVALID', 'Phase reasonCode is invalid.');
  }
  if (reasonCode === FORGE_CROSS_LAYER_HOST_REUSE_REASON || (hostVerificationReuse !== null && decision !== 'accepted')) {
    fail('PHASE_HOST_RECEIPT_INVALID', 'Host reuse is derived from accepted source evidence, not a supplied reason code.');
  }
  iso(now, 'now');
  if (decision === 'accepted') {
    const validatedArtifact = validateForgeDeliveryPhaseArtifact(artifact);
    const correction = currentForgeAccessAcceptedCorrection(current);
    if (correction !== null && (artifact.artifactDigest === correction.artifactDigest
      || artifact.sourceFingerprint === correction.acceptedSourceFingerprint)) {
      fail('PHASE_UPSTREAM_STALE', 'Accepted correction requires new candidate source and new Host evidence.');
    }
    if (validatedArtifact.workflowId !== current.workflowId || validatedArtifact.phaseId !== phase.id
      || validatedArtifact.attemptId !== attempt.attemptId
      || validatedArtifact.artifactKind !== phase.artifactKind) {
      fail('PHASE_ARTIFACT_INVALID', 'Accepted phase artifact is invalid or stale.');
    }
    if (artifact.unresolvedDecisions.length > 0) {
      fail('PHASE_BUSINESS_DECISION_REQUIRED', 'Unresolved business decisions prevent phase acceptance.');
    }
    const expectedUpstream = Object.fromEntries(phase.requiresArtifacts.map((kind) => [kind, current.acceptedArtifacts[kind]]));
    if (canonicalStringify(artifact.upstreamArtifactDigests) !== canonicalStringify(expectedUpstream)) {
      fail('PHASE_UPSTREAM_STALE', 'Artifact was derived from stale upstream phase evidence.');
    }
    if (hostVerificationReuse === null) validateHostReceipts(hostReceipts, phase, artifact.sourceFingerprint);
    else {
      if (phase.index !== 7 || !Array.isArray(hostReceipts) || hostReceipts.length !== 0
        || artifact.changedPaths.length !== 0 || artifact.patchDigest !== artifact.sourceFingerprint || reasonCode !== null) {
        fail('PHASE_HOST_RECEIPT_INVALID', 'Host reuse cannot hide new source changes or replace real Host receipts.');
      }
      validateForgeCrossLayerHostVerificationReuse({ state: current, catalog, artifact, hostVerificationReuse });
    }
  }
  const receipt = withReceiptDigest({
    schemaVersion: FORGE_DELIVERY_PHASE_RECEIPT_SCHEMA,
    issuer: 'forge-phase-controller',
    workflowId: current.workflowId,
    phaseId: phase.id,
    phaseIndex: phase.index,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    decision,
    reasonCode: hostVerificationReuse === null ? reasonCode : FORGE_CROSS_LAYER_HOST_REUSE_REASON,
    artifactDigest: artifact?.artifactDigest ?? null,
    patchDigest: artifact?.patchDigest ?? null,
    hostReceiptDigests: hostReceipts.map((receipt) => receipt.receiptDigest),
    ...(hostVerificationReuse === null ? {} : { hostVerificationReuse: clone(hostVerificationReuse) }),
    completedAt: now,
    receiptDigest: '',
  });
  const next = clone(current);
  next.activeAttempt = null;
  next.history.push(receipt);
  next.revision += 1;
  next.updatedAt = now;
  if (decision === 'accepted') {
    next.acceptedArtifacts[phase.artifactKind] = artifact.artifactDigest;
    if (phase.index === workflow.phases.length - 1) {
      next.status = 'completed';
    } else {
      next.currentPhaseIndex = currentForgeAccessAcceptedCorrection(current)?.phaseId === 'backend' ? 7 : next.currentPhaseIndex + 1;
      next.currentPhaseId = workflow.phases[next.currentPhaseIndex].id;
    }
  } else {
    const attempts = next.history.filter(
      (entry) => entry.phaseId === phase.id && !isTechnicalRecoveryReceipt(entry),
    ).length;
    if (currentForgeAccessAcceptedCorrection(current) !== null || decision === 'blocked' || attempts >= phase.maxAttempts) next.status = 'blocked';
  }
  return { state: withStateDigest(next), receipt };
}

export function recordForgeStaleWriteRecovery({
  state,
  catalog,
  operationId,
  frozenStateFileDigest,
  failureEvidenceDigest,
  writerRecoveryTraceDigest,
  now = new Date().toISOString(),
}) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  const workflow = workflowById(catalog, current.workflowId);
  const phase = workflow.phases[current.currentPhaseIndex];
  const attempt = current.activeAttempt;
  if (current.status !== 'active' || phase.id !== 'database' || attempt === null) {
    fail('PHASE_STALE_WRITE_RECOVERY_DENIED', 'Only the active database attempt can recover the stale-write incident.');
  }
  const phaseHistory = current.history.filter((entry) => entry.phaseId === phase.id);
  if (phaseHistory.some(isTechnicalRecoveryReceipt) || phaseHistory.length >= phase.maxAttempts + 1) {
    fail('PHASE_STALE_WRITE_RECOVERY_DENIED', 'The stale-write recovery or total execution budget is exhausted.');
  }
  requiredString(operationId, ATTEMPT_ID_PATTERN, 'operationId');
  for (const [value, label] of [
    [frozenStateFileDigest, 'frozenStateFileDigest'],
    [failureEvidenceDigest, 'failureEvidenceDigest'],
    [writerRecoveryTraceDigest, 'writerRecoveryTraceDigest'],
  ]) requiredString(value, SHA256_PATTERN, label);
  iso(now, 'now');
  if (Date.parse(now) < Date.parse(attempt.startedAt)) {
    fail('PHASE_STALE_WRITE_RECOVERY_DENIED', 'Recovery predates the active attempt.');
  }
  const receipt = withStaleWriteRecoveryDigest({
    schemaVersion: FORGE_STALE_WRITE_RECOVERY_RECEIPT_SCHEMA,
    issuer: 'forge-phase-controller',
    incidentCode: STALE_WRITE_INCIDENT_CODE,
    operationId,
    workflowId: current.workflowId,
    phaseId: phase.id,
    phaseIndex: phase.index,
    taskId: current.taskId,
    sessionId: current.sessionId,
    sourceCommit: current.sourceCommit,
    catalogDigest: current.catalogDigest,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    rpcId: attempt.rpcId,
    promptDigest: attempt.promptDigest,
    frozenStateFileDigest,
    failureEvidenceDigest,
    writerRecoveryTraceDigest,
    artifactStatus: 'absent',
    hostReceiptDigests: [],
    hostRunnerExecuted: false,
    budgetDisposition: 'quality-attempt-not-consumed',
    executionCostConsumed: true,
    failedAt: now,
    receiptDigest: '',
  });
  const next = clone(current);
  next.schemaVersion = FORGE_DELIVERY_PHASE_STATE_SCHEMA;
  next.activeAttempt = null;
  next.history.push(receipt);
  next.revision += 1;
  next.updatedAt = now;
  const recovered = withStateDigest(next);
  validateForgeDeliveryPhaseState(recovered, catalog);
  return { state: recovered, receipt };
}

export function recordForgeAccessProviderRecovery({ state, catalog, rpcId, promptDigest, executionGeneration,
  failureEvidenceDigest, workspaceFingerprint, now = new Date().toISOString() }) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  const phase = workflowById(catalog, current.workflowId).phases[current.currentPhaseIndex];
  const correction = currentForgeAccessAcceptedCorrection(current);
  const attempt = current.activeAttempt;
  const history = current.history.filter(entry => entry.phaseId === phase.id);
  if (current.status !== 'active' || phase.id !== 'access-wiring' || phase.index !== 6 || attempt === null
    || correction === null || attempt.attemptId !== correction.attemptId || history.some(isTechnicalRecoveryReceipt)
    || accessPhaseExecutions(history) + 1 > phase.maxAttempts + 1) {
    fail('PHASE_PROVIDER_RECOVERY_DENIED', 'The current accepted-access repair has no remaining technical recovery allowance.');
  }
  requiredString(rpcId, RPC_ID_PATTERN, 'rpcId'); requiredString(promptDigest, SHA256_PATTERN, 'promptDigest');
  requiredString(failureEvidenceDigest, SHA256_PATTERN, 'failureEvidenceDigest');
  requiredString(workspaceFingerprint, SHA256_PATTERN, 'workspaceFingerprint'); iso(now, 'now');
  if (!Number.isSafeInteger(executionGeneration) || executionGeneration <= current.lastExecutionGeneration
    || rpcId === attempt.rpcId || Date.parse(now) < Date.parse(current.updatedAt)) {
    fail('PHASE_PROVIDER_RECOVERY_DENIED', 'Provider recovery requires a new generation and current bound failure.');
  }
  const receipt = withReceiptDigest({ schemaVersion: ACCESS_PROVIDER_RECOVERY_SCHEMA, issuer: 'forge-phase-controller',
    workflowId: current.workflowId, phaseId: phase.id, phaseIndex: phase.index, taskId: current.taskId,
    sessionId: current.sessionId, sourceCommit: current.sourceCommit, catalogDigest: current.catalogDigest,
    attemptId: attempt.attemptId, executionGeneration: attempt.executionGeneration, rpcId: attempt.rpcId,
    promptDigest: attempt.promptDigest, frozenStateFileDigest: current.stateDigest, failureEvidenceDigest,
    workspaceFingerprint, correctionReceiptDigest: correction.receiptDigest, attemptStartedAt: attempt.startedAt,
    budgetDisposition: 'quality-attempt-not-consumed', executionCostConsumed: true, failedAt: now, receiptDigest: '' });
  const next = clone(current);
  next.history.push(receipt); next.revision += 2; next.updatedAt = now; next.lastExecutionGeneration = executionGeneration;
  next.activeAttempt = { ...attempt, rpcId, promptDigest, executionGeneration };
  return { state: validateForgeDeliveryPhaseState(withStateDigest(next), catalog), receipt };
}

export function recordForgeReadonlyRoleRecovery({
  state,
  catalog,
  operationId,
  frozenStateFileDigest,
  failureEvidenceDigest,
  now = new Date().toISOString(),
}) {
  const current = validateForgeDeliveryPhaseState(state, catalog);
  const workflow = workflowById(catalog, current.workflowId);
  const phase = workflow.phases[current.currentPhaseIndex];
  const attempt = current.activeAttempt;
  if (current.status !== 'active' || phase.id !== 'frontend' || phase.index !== 5 || attempt === null) {
    fail('PHASE_READONLY_ROLE_RECOVERY_DENIED', 'Only the active frontend attempt can recover the readonly-role incident.');
  }
  const phaseHistory = current.history.filter((entry) => entry.phaseId === phase.id);
  if (phaseHistory.some(isTechnicalRecoveryReceipt) || phaseHistory.length >= phase.maxAttempts + 1) {
    fail('PHASE_READONLY_ROLE_RECOVERY_DENIED', 'The technical recovery or total execution budget is exhausted.');
  }
  requiredString(operationId, ATTEMPT_ID_PATTERN, 'operationId');
  requiredString(frozenStateFileDigest, SHA256_PATTERN, 'frozenStateFileDigest');
  requiredString(failureEvidenceDigest, SHA256_PATTERN, 'failureEvidenceDigest');
  iso(now, 'now');
  if (Date.parse(now) < Date.parse(attempt.startedAt)) {
    fail('PHASE_READONLY_ROLE_RECOVERY_DENIED', 'Recovery predates the active attempt.');
  }
  const receipt = withReceiptDigest({
    schemaVersion: FORGE_READONLY_ROLE_RECOVERY_RECEIPT_SCHEMA,
    issuer: 'forge-phase-controller',
    incidentCode: 'READONLY_ROLE_PROMPT_MISCLASSIFIED',
    operationId,
    workflowId: current.workflowId,
    phaseId: phase.id,
    phaseIndex: phase.index,
    taskId: current.taskId,
    sessionId: current.sessionId,
    sourceCommit: current.sourceCommit,
    catalogDigest: current.catalogDigest,
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    rpcId: attempt.rpcId,
    promptDigest: attempt.promptDigest,
    frozenStateFileDigest,
    failureEvidenceDigest,
    budgetDisposition: 'quality-attempt-not-consumed',
    executionCostConsumed: true,
    failedAt: now,
    receiptDigest: '',
  });
  const next = clone(current);
  next.schemaVersion = FORGE_DELIVERY_PHASE_STATE_SCHEMA;
  next.activeAttempt = null;
  next.history.push(receipt);
  next.revision += 1;
  next.updatedAt = now;
  const recovered = withStateDigest(next);
  validateForgeDeliveryPhaseState(recovered, catalog);
  return { state: recovered, receipt };
}

export async function writeForgeDeliveryPhaseState(file, state, catalog) {
  validateForgeDeliveryPhaseState(state, catalog);
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('PHASE_STATE_PATH_INVALID', 'State path must be absolute.');
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await lstat(file).catch(() => undefined);
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    fail('PHASE_STATE_PATH_INVALID', 'Existing phase state is not an ordinary file.');
  }
  const preservedMetadata = existing === undefined ? null : Object.freeze({
    dev: existing.dev,
    ino: existing.ino,
    uid: existing.uid,
    gid: existing.gid,
    mode: existing.mode & 0o7777,
    nlink: existing.nlink,
    size: existing.size,
    mtimeMs: existing.mtimeMs,
  });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  let renamed = false;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    if (preservedMetadata !== null) {
      await handle.chown(preservedMetadata.uid, preservedMetadata.gid);
      await handle.chmod(preservedMetadata.mode);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    const current = await lstat(file).catch(() => undefined);
    if ((preservedMetadata === null && current !== undefined)
      || (preservedMetadata !== null && (current === undefined || !current.isFile()
        || current.isSymbolicLink() || current.nlink !== preservedMetadata.nlink
        || current.dev !== preservedMetadata.dev || current.ino !== preservedMetadata.ino
        || current.uid !== preservedMetadata.uid || current.gid !== preservedMetadata.gid
        || (current.mode & 0o7777) !== preservedMetadata.mode
        || current.size !== preservedMetadata.size || current.mtimeMs !== preservedMetadata.mtimeMs))) {
      fail('PHASE_STATE_PATH_INVALID', 'Existing phase state changed during atomic replacement.');
    }
    await rename(temporary, file);
    renamed = true;
    const written = await lstat(file).catch(() => undefined);
    if (written === undefined || !written.isFile() || written.isSymbolicLink() || written.nlink !== 1
      || (preservedMetadata !== null && (written.uid !== preservedMetadata.uid
        || written.gid !== preservedMetadata.gid || (written.mode & 0o7777) !== preservedMetadata.mode))) {
      fail('PHASE_STATE_PATH_INVALID', 'Written phase state did not preserve its file authority metadata.');
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function readForgeDeliveryPhaseState(file, catalog) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) fail('PHASE_STATE_PATH_INVALID', 'State path must be absolute.');
  const information = await lstat(file).catch(() => undefined);
  if (information === undefined || !information.isFile() || information.isSymbolicLink()
    || information.nlink !== 1 || information.size < 2 || information.size > MAX_STATE_BYTES) {
    fail('PHASE_STATE_INVALID', 'Phase state must be a bounded ordinary file.');
  }
  let state;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    fail('PHASE_STATE_INVALID', 'Phase state is not valid JSON.');
  }
  return validateForgeDeliveryPhaseState(state, catalog);
}

export async function withForgeDeliveryPhaseStateLock(file, operation) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || typeof operation !== 'function') {
    fail('PHASE_STATE_PATH_INVALID', 'State lock requires an absolute state path and an operation.');
  }
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  let handle;
  try {
    handle = await open(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('PHASE_STATE_BUSY', 'Another phase transition owns the state lock.');
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 'utf8');
    await handle.sync();
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(lockFile).catch(() => undefined);
  }
}
