import crypto from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FORGE_DELIVERY_PHASE_ARTIFACT_SCHEMA,
  beginForgeDeliveryPhase,
  continueForgeRequirementsPhase,
  continueForgeDomainContractPhase,
  continueForgeDatabaseLeasePause,
  continueForgeBackendLeasePause,
  continueForgeFrontendLeasePause,
  continueForgeAccessWiringLeasePause,
  continueForgeCrossLayerRuntimeReprobe,
  completeForgeDeliveryPhase,
  createForgeDeliveryPhaseState,
  loadForgeDeliveryPhaseCatalog,
  readForgeDeliveryPhaseState,
  recordForgeStaleWriteRecovery,
  recordForgeReadonlyRoleRecovery,
  recordForgeAccessAcceptedCorrection,
  recordForgeAccessProviderRecovery,
  currentForgeAccessAcceptedCorrection,
  currentForgeRuntimeSourceArtifactKind,
  validateForgeDeliveryPhaseArtifact,
  validateForgeDeliveryPhaseState,
  validateForgeCrossLayerHostVerificationReuse,
  withForgeDeliveryPhaseStateLock,
  writeForgeDeliveryPhaseState,
} from './forge-delivery-phase-runtime.mjs';
import {
  buildForgeDeliveryPhasePrompt,
  createForgeDeliveryPhaseArtifactFromProposal,
  extractForgeDeliveryPhaseHumanResponse,
  parseForgeDeliveryPhaseProposal,
} from './forge-delivery-phase-response.mjs';
import {
  digestDirectUserTextContent,
  hasGlobalReadOnlyIntent,
  validateProtectedExecutionContext,
} from './forge-execution-context.mjs';
import { observeForgeDeliveryPhase, snapshotForgeDeliveryWorkspace } from './forge-delivery-phase-workspace-observer.mjs';
import { writeForgePhaseWorkPackage } from './forge-phase-work-package.mjs';
import { issueProductionTaskGrant } from './forge-production-task-grant.mjs';
import { canonicalStringify, isForgeTaskOwnedPath } from './forge-task-execution-contract.mjs';
import { loadForgeCrossLayerRuntimeEvidence } from './forge-cross-layer-runtime-evidence.mjs';
import { validateForgeRequirementsOverloadProof, validateForgeAccessContextFailureProof, validateForgeAccessProviderFailureProof } from './forge-delivery-phase-browser-session.mjs';
import { validateHostRunReceipt } from './forge-host-verification-receipt.mjs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_PROMPT_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 256 * 1024 * 1024;
const EMPTY_SHA256 = sha256(Buffer.alloc(0));
const EMPTY_JSON_ARRAY_FILE_SHA256 = sha256(Buffer.from('[]\n', 'utf8'));
const STALE_WRITE_RECOVERY_SCHEMA = 'forge-delivery-phase-stale-write-recovery/v1';
const STALE_WRITE_EVIDENCE_SCHEMA = 'forge-asset-ledger-database-attempt2-failure/v1';
const STALE_WRITE_TRACE_SCHEMA = 'forge-writer-stale-create-trace/v1';
const INDEPENDENT_SEMANTIC_REVIEW_SCHEMA = 'forge-independent-semantic-review/v1';
const RETRY_PROMPT_RECEIPT_SCHEMA = 'forge-delivery-phase-retry-prompt/v1';
const FORMAT_RETRY_PROMPT_RECEIPT_SCHEMA = 'forge-delivery-phase-format-retry-prompt/v1';
const USER_ABORT_RETRY_SCHEMA = 'forge-delivery-frontend-user-abort-retry/v1';
const USER_ABORT_REASON = 'BROWSER_USER_ABORTED';
const ACCESS_SCOPE_RETRY_SCHEMA = 'forge-delivery-access-scope-retry/v1';
const ACCESS_SCOPE_REASON = 'ACCESS_SCOPE_DENIED';
const REQUIREMENTS_OVERLOAD_RETRY_SCHEMA = 'forge-delivery-requirements-provider-overload-retry/v1';
const REQUIREMENTS_OVERLOAD_REASON = 'REQUIREMENTS_PROVIDER_OVERLOAD';
const BACKEND_UNFINISHED_RETRY_SCHEMA = 'forge-delivery-backend-unfinished-retry/v1';
const BACKEND_UNFINISHED_REASON = 'BACKEND_VERIFICATION_INCOMPLETE';
const READONLY_ROLE_RECOVERY_SCHEMA = 'forge-delivery-phase-readonly-role-recovery/v1';
const READONLY_ROLE_RETRY_SCHEMA = 'forge-delivery-frontend-readonly-role-retry/v1';
const FORMAT_REJECTION_REASON = 'FORMAT_UNEXPECTED_PAYLOAD_KEYS';
const JSON_FORMAT_REJECTION_REASON = 'FORMAT_INVALID_PROPOSAL_JSON';
const MISSING_FORMAT_REJECTION_REASON = 'FORMAT_MISSING_PROPOSAL_BLOCK';
const FINDING_ID_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,63}$/u;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail('PHASE_CONTROLLER_INPUT_INVALID', `${label} does not match the reviewed schema.`);
  }
}

function requiredId(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('PHASE_CONTROLLER_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function currentPhase(state, catalog) {
  const workflow = catalog.workflows.find((entry) => entry.id === state.workflowId);
  const phase = workflow?.phases[state.currentPhaseIndex];
  if (phase === undefined || phase.id !== state.currentPhaseId) {
    fail('PHASE_CONTROLLER_STATE_INVALID', 'Current phase is unavailable.');
  }
  return phase;
}

async function boundedRegularFile(file, maximumBytes, label, { allowEmpty = false, trustedReview = false } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    fail('PHASE_CONTROLLER_PATH_INVALID', `${label} path must be absolute.`);
  }
  const information = await lstat(file);
  if (!information.isFile() || information.isSymbolicLink()
    || (!allowEmpty && information.size < 1) || information.size > maximumBytes) {
    fail('PHASE_CONTROLLER_PATH_INVALID', `${label} must be a bounded ordinary file.`);
  }
  if (trustedReview) {
    const parent = await lstat(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink() || information.nlink !== 1
      || (process.platform !== 'win32' && (information.mode & 0o077) !== 0)
      || (process.getuid?.() === 0 && information.uid !== 0)) {
      fail('PHASE_CONTROLLER_PATH_INVALID', `${label} must be an operator-owned private file in an ordinary directory.`);
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== information.ino || opened.dev !== information.dev
        || opened.size !== information.size || opened.nlink !== 1) {
        fail('PHASE_CONTROLLER_PATH_INVALID', `${label} changed during admission.`);
      }
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  return readFile(file);
}

async function writeExclusive(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizedChangedPaths(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'
    || entry.length === 0 || entry.includes('\0') || path.isAbsolute(entry)
    || entry.split(/[\\/]/u).includes('..'))) {
    fail('PHASE_CONTROLLER_OBSERVATION_INVALID', 'Observed changed paths are invalid.');
  }
  const normalized = value.map((entry) => entry.replaceAll('\\', '/')).sort();
  if (new Set(normalized).size !== normalized.length) {
    fail('PHASE_CONTROLLER_OBSERVATION_INVALID', 'Observed changed paths are not unique.');
  }
  return normalized;
}

async function readJsonFile(file, maximumBytes, label, options) {
  const bytes = await boundedRegularFile(file, maximumBytes, label, options);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('PHASE_CONTROLLER_INPUT_INVALID', `${label} is not valid JSON.`);
  }
}

function boundedReviewText(value, maximumBytes, label) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', `${label} is invalid or oversized.`);
  }
  return value;
}

function validateRetryPreflightReceipt(receipt, { state, phase, rejection }) {
  exactKeys(receipt, [
    'schemaVersion', 'workflowId', 'phaseId', 'phaseIndex', 'phaseAttemptId',
    'candidateArtifactDigest', 'phasePatchDigest', 'cumulativePatchDigest',
    'changedPaths', 'hostVerificationProfiles', 'safeForOperatorHostVerification',
    'stateAdvanced',
  ], 'retry preflight receipt');
  if (receipt.schemaVersion !== 'forge-delivery-phase-controller-preflight/v1'
    || receipt.workflowId !== state.workflowId || receipt.phaseId !== phase.id
    || receipt.phaseIndex !== phase.index || receipt.phaseAttemptId !== rejection.attemptId
    || !SHA256_PATTERN.test(receipt.candidateArtifactDigest ?? '')
    || (receipt.phasePatchDigest !== null && !SHA256_PATTERN.test(receipt.phasePatchDigest))
    || !SHA256_PATTERN.test(receipt.cumulativePatchDigest ?? '')
    || JSON.stringify(normalizedChangedPaths(receipt.changedPaths)) !== JSON.stringify(receipt.changedPaths)
    || JSON.stringify(receipt.hostVerificationProfiles) !== JSON.stringify(phase.hostVerificationProfiles)
    || receipt.safeForOperatorHostVerification !== true || receipt.stateAdvanced !== false) {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Preflight receipt is not bound to the latest rejected attempt.');
  }
  return receipt;
}

function validateIndependentSemanticReview(review, {
  phase,
  responseSha256,
  candidateArtifactDigest,
}) {
  exactKeys(review, [
    'schemaVersion', 'reviewer', 'subject', 'verdict', 'severityCounts',
    'findings', 'coverageSummary', 'cannotClaim',
  ], 'independent semantic review');
  exactKeys(review.subject, [
    'phaseId', 'responseSha256', 'candidateArtifactDigest',
  ], 'independent semantic review subject');
  exactKeys(review.severityCounts, ['p0', 'p1', 'p2'], 'independent semantic review severity counts');
  boundedReviewText(review.reviewer, 256, 'semantic review reviewer');
  boundedReviewText(review.coverageSummary, 32 * 1024, 'semantic review coverage summary');
  if (review.schemaVersion !== INDEPENDENT_SEMANTIC_REVIEW_SCHEMA
    || !['PASS', 'reject'].includes(review.verdict)
    || review.subject.phaseId !== phase.id || review.subject.responseSha256 !== responseSha256
    || review.subject.candidateArtifactDigest !== candidateArtifactDigest
    || !Array.isArray(review.findings) || review.findings.length > 64
    || !Array.isArray(review.cannotClaim) || review.cannotClaim.length > 64) {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Semantic review is not bound to the current candidate.');
  }
  const counts = { p0: 0, p1: 0, p2: 0 };
  const findingIds = new Set();
  for (const finding of review.findings) {
    exactKeys(finding, ['id', 'severity', 'title', 'evidence', 'requiredAction'], 'semantic review finding');
    if (!FINDING_ID_PATTERN.test(finding.id ?? '') || findingIds.has(finding.id)
      || !Object.hasOwn(counts, finding.severity)) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Semantic review findings are invalid.');
    }
    findingIds.add(finding.id);
    counts[finding.severity] += 1;
    boundedReviewText(finding.title, 2 * 1024, `semantic review finding ${finding.id} title`);
    boundedReviewText(finding.evidence, 16 * 1024, `semantic review finding ${finding.id} evidence`);
    boundedReviewText(finding.requiredAction, 16 * 1024, `semantic review finding ${finding.id} requiredAction`);
  }
  try {
    for (const entry of review.cannotClaim) {
      boundedReviewText(entry, 8 * 1024, 'semantic review cannotClaim entry');
    }
  } catch {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Semantic review cannotClaim entries are invalid.');
  }
  if ((review.verdict === 'PASS' && (review.findings.length !== 0 || review.cannotClaim.length !== 0))
    || (review.verdict === 'reject' && review.findings.length === 0)
    || Object.entries(counts).some(([key, value]) => review.severityCounts[key] !== value)
    || new Set(review.cannotClaim).size !== review.cannotClaim.length) {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Semantic review counts or cannotClaim entries are invalid.');
  }
  return review;
}

function recomputeRejectedCandidateDigest({ state, phase, rejection, response, preflightReceipt }) {
  const proposal = parseForgeDeliveryPhaseProposal({ text: response, phase });
  const changedPaths = preflightReceipt.changedPaths;
  if (phase.sourceMutation && (!Array.isArray(proposal.payload.changedPaths)
    || JSON.stringify([...proposal.payload.changedPaths].sort()) !== JSON.stringify([...changedPaths].sort()))) {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Rejected response changedPaths differ from the preflight receipt.');
  }
  if ((phase.patchScope === 'none'
      && (preflightReceipt.phasePatchDigest !== null || changedPaths.length !== 0))
    || (phase.patchScope === 'phase'
      && (!SHA256_PATTERN.test(preflightReceipt.phasePatchDigest ?? '') || changedPaths.length === 0))
    || (phase.patchScope === 'cumulative'
      && (!SHA256_PATTERN.test(preflightReceipt.phasePatchDigest ?? '') || changedPaths.length !== 0))) {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Rejected candidate mutation evidence differs from phase authority.');
  }
  const candidate = {
    schemaVersion: FORGE_DELIVERY_PHASE_ARTIFACT_SCHEMA,
    workflowId: state.workflowId,
    phaseId: phase.id,
    artifactKind: phase.artifactKind,
    attemptId: rejection.attemptId,
    sourceFingerprint: preflightReceipt.cumulativePatchDigest,
    upstreamArtifactDigests: Object.fromEntries(
      phase.requiresArtifacts.map((kind) => [kind, state.acceptedArtifacts[kind]]),
    ),
    unresolvedDecisions: proposal.unresolvedDecisions,
    changedPaths,
    patchDigest: preflightReceipt.phasePatchDigest,
    payload: proposal.payload,
  };
  return sha256(Buffer.from(canonicalStringify(candidate), 'utf8'));
}

function buildRetryPrompt(basePrompt, {
  rejection,
  responseSha256,
  preflightReceiptSha256,
  semanticReviewSha256,
  review,
}) {
  const feedback = {
    rejectedAttemptId: rejection.attemptId,
    rejectedExecutionGeneration: rejection.executionGeneration,
    rejectionReceiptDigest: rejection.receiptDigest,
    reasonCode: rejection.reasonCode,
    responseSha256,
    candidateArtifactDigest: review.subject.candidateArtifactDigest,
    preflightReceiptSha256,
    semanticReviewSha256,
    reviewer: review.reviewer,
    severityCounts: review.severityCounts,
    findings: review.findings,
    cannotClaim: review.cannotClaim,
  };
  return [
    basePrompt,
    '',
    'REJECTED ATTEMPT FEEDBACK (machine-owned, evidence-bound):',
    JSON.stringify(feedback, null, 2),
    '',
    'The previous response is rejected and is not an accepted upstream artifact.',
    'Correct every finding within the current phase authority, preserve compliant content, and return the complete phase response: a concise business-facing explanation followed by exactly one complete replacement artifact.',
    'Do not execute a later phase, invent missing business decisions, or answer with only a patch or review commentary.',
  ].join('\n');
}

export function forgeDeliveryPhaseRetryPromptReceiptPath(promptFile, rejectedAttemptId) {
  if (typeof promptFile !== 'string' || !path.isAbsolute(promptFile)) {
    fail('PHASE_CONTROLLER_PATH_INVALID', 'Retry prompt path must be absolute.');
  }
  requiredId(rejectedAttemptId, UUID_PATTERN, 'rejectedAttemptId');
  return `${promptFile}.${rejectedAttemptId}.retry-receipt.json`;
}

export function validateForgeDeliveryPhaseRetryPromptReceipt({
  receipt,
  state,
  catalog,
  promptDigest,
}) {
  const validatedState = validateForgeDeliveryPhaseState(state, catalog);
  const phase = currentPhase(validatedState, catalog);
  const rejection = validatedState.history.at(-1);
  const phaseAttempts = validatedState.history.filter((entry) => (
    entry.schemaVersion === 'forge-delivery-phase-receipt/v1' && entry.phaseId === phase.id
  )).length;
  if (receipt?.schemaVersion === BACKEND_UNFINISHED_RETRY_SCHEMA) {
    exactKeys(receipt, ['schemaVersion', 'issuer', 'workflowId', 'phaseId', 'phaseIndex', 'sourceCommit',
      'catalogVersion', 'catalogDigest', 'stateDigest', 'rejectedAttemptId', 'rejectedExecutionGeneration',
      'rejectionReceiptDigest', 'reasonCode', 'executionId', 'originalRequestSha256', 'failureEvidenceSha256',
      'feedbackSha256', 'retryPromptDigest', 'remainingAttempts', 'stateAdvanced'], 'backend unfinished retry receipt');
    if (validatedState.status !== 'active' || validatedState.activeAttempt !== null
      || phase.id !== 'backend' || phase.index !== 4 || phaseAttempts >= phase.maxAttempts
      || rejection?.decision !== 'rejected' || rejection.reasonCode !== BACKEND_UNFINISHED_REASON
      || receipt.issuer !== 'forge-phase-controller' || receipt.workflowId !== validatedState.workflowId
      || receipt.phaseId !== phase.id || receipt.phaseIndex !== phase.index || receipt.sourceCommit !== validatedState.sourceCommit
      || receipt.catalogVersion !== validatedState.catalogVersion || receipt.catalogDigest !== validatedState.catalogDigest
      || receipt.stateDigest !== validatedState.stateDigest || receipt.rejectedAttemptId !== rejection.attemptId
      || receipt.rejectedExecutionGeneration !== rejection.executionGeneration || receipt.reasonCode !== rejection.reasonCode
      || receipt.rejectionReceiptDigest !== rejection.receiptDigest || !UUID_PATTERN.test(receipt.executionId ?? '')
      || !['originalRequestSha256', 'failureEvidenceSha256', 'feedbackSha256'].every(key => SHA256_PATTERN.test(receipt[key] ?? ''))
      || receipt.retryPromptDigest !== promptDigest || receipt.remainingAttempts !== phase.maxAttempts - phaseAttempts
      || receipt.stateAdvanced !== false) {
      fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Backend retry must consume its original attempt budget.');
    }
    return receipt;
  }
  if (receipt?.schemaVersion === REQUIREMENTS_OVERLOAD_RETRY_SCHEMA) {
    exactKeys(receipt, ['schemaVersion', 'issuer', 'workflowId', 'phaseId', 'phaseIndex', 'sourceCommit',
      'catalogVersion', 'catalogDigest', 'stateDigest', 'rejectedAttemptId', 'rejectedExecutionGeneration',
      'rejectionReceiptDigest', 'reasonCode', 'executionId', 'originalRequestSha256', 'providerFailureProofSha256',
      'executionSha256', 'baselineSha256', 'beginSha256', 'retryPromptDigest', 'remainingAttempts', 'stateAdvanced'],
    'requirements overload retry receipt');
    if (validatedState.status !== 'active' || validatedState.activeAttempt !== null
      || phase.id !== 'requirements' || phase.index !== 0 || phaseAttempts >= phase.maxAttempts
      || rejection?.decision !== 'rejected' || rejection.reasonCode !== REQUIREMENTS_OVERLOAD_REASON
      || receipt.issuer !== 'forge-phase-controller' || receipt.workflowId !== validatedState.workflowId
      || receipt.phaseId !== phase.id || receipt.phaseIndex !== phase.index || receipt.sourceCommit !== validatedState.sourceCommit
      || receipt.catalogVersion !== validatedState.catalogVersion || receipt.catalogDigest !== validatedState.catalogDigest
      || receipt.stateDigest !== validatedState.stateDigest || receipt.rejectedAttemptId !== rejection.attemptId
      || receipt.rejectedExecutionGeneration !== rejection.executionGeneration || receipt.reasonCode !== rejection.reasonCode
      || receipt.rejectionReceiptDigest !== rejection.receiptDigest || !UUID_PATTERN.test(receipt.executionId ?? '')
      || !['originalRequestSha256', 'providerFailureProofSha256', 'executionSha256', 'baselineSha256', 'beginSha256']
        .every((key) => SHA256_PATTERN.test(receipt[key] ?? ''))
      || receipt.retryPromptDigest !== promptDigest || receipt.remainingAttempts !== phase.maxAttempts - phaseAttempts
      || receipt.stateAdvanced !== false) {
      fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Provider overload retry receipt does not authorize this requirements attempt.');
    }
    return Object.freeze(JSON.parse(JSON.stringify(receipt)));
  }
  if (receipt?.schemaVersion === READONLY_ROLE_RETRY_SCHEMA) {
    exactKeys(receipt, ['schemaVersion', 'issuer', 'workflowId', 'phaseId', 'phaseIndex', 'sourceCommit',
      'catalogVersion', 'catalogDigest', 'stateDigest', 'rejectedAttemptId', 'rejectedExecutionGeneration',
      'recoveryReceiptDigest', 'executionId', 'previousPromptDigest', 'originalRequestSha256',
      'denialProofSha256', 'sessionProofSha256', 'executionSha256', 'baselineSha256', 'beginSha256',
      'feedbackSha256', 'upstreamArtifactDigests', 'retryPromptDigest', 'remainingAttempts', 'stateAdvanced'],
    'readonly-role retry receipt');
    const upstream = Object.fromEntries(phase.requiresArtifacts.map((kind) => [kind, validatedState.acceptedArtifacts[kind]]));
    if (validatedState.status !== 'active' || validatedState.activeAttempt !== null
      || phase.id !== 'frontend' || phase.index !== 5 || phaseAttempts >= phase.maxAttempts
      || rejection?.schemaVersion !== READONLY_ROLE_RECOVERY_SCHEMA
      || rejection.incidentCode !== 'READONLY_ROLE_PROMPT_MISCLASSIFIED'
      || receipt.issuer !== 'forge-phase-controller' || receipt.workflowId !== validatedState.workflowId
      || receipt.phaseId !== phase.id || receipt.phaseIndex !== phase.index || receipt.sourceCommit !== validatedState.sourceCommit
      || receipt.catalogVersion !== validatedState.catalogVersion || receipt.catalogDigest !== validatedState.catalogDigest
      || receipt.stateDigest !== validatedState.stateDigest || receipt.rejectedAttemptId !== rejection.attemptId
      || receipt.rejectedExecutionGeneration !== rejection.executionGeneration
      || receipt.recoveryReceiptDigest !== rejection.receiptDigest || !UUID_PATTERN.test(receipt.executionId ?? '')
      || !['previousPromptDigest', 'originalRequestSha256', 'denialProofSha256', 'sessionProofSha256',
        'executionSha256', 'baselineSha256', 'beginSha256', 'feedbackSha256'].every((key) => SHA256_PATTERN.test(receipt[key] ?? ''))
      || receipt.denialProofSha256 !== rejection.failureEvidenceDigest
      || canonicalStringify(receipt.upstreamArtifactDigests) !== canonicalStringify(upstream)
      || receipt.retryPromptDigest !== promptDigest || receipt.remainingAttempts !== phase.maxAttempts - phaseAttempts
      || receipt.stateAdvanced !== false) {
      fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Readonly-role retry receipt does not authorize this frontend attempt.');
    }
    return Object.freeze(JSON.parse(JSON.stringify(receipt)));
  }
  if (receipt?.schemaVersion === ACCESS_SCOPE_RETRY_SCHEMA) {
    exactKeys(receipt, ['schemaVersion', 'issuer', 'workflowId', 'phaseId', 'phaseIndex', 'sourceCommit',
      'catalogVersion', 'catalogDigest', 'stateDigest', 'rejectedAttemptId', 'rejectedExecutionGeneration',
      'rejectionReceiptDigest', 'reasonCode', 'executionId', 'previousPromptDigest', 'originalRequestSha256',
      'denialProofSha256', 'executionSha256', 'baselineSha256', 'beginSha256', 'feedbackSha256', 'sessionProofSha256', 'zeroDeltaFingerprint',
      'upstreamArtifactDigests', 'retryPromptDigest', 'remainingAttempts', 'stateAdvanced'], 'access-scope retry receipt');
    const upstream = Object.fromEntries(phase.requiresArtifacts.map((kind) => [kind, validatedState.acceptedArtifacts[kind]]));
    if (validatedState.status !== 'active' || validatedState.activeAttempt !== null
      || phase.id !== 'access-wiring' || phase.index !== 6 || phaseAttempts !== 1 || phaseAttempts >= phase.maxAttempts
      || rejection?.decision !== 'rejected' || rejection.reasonCode !== ACCESS_SCOPE_REASON
      || receipt.issuer !== 'forge-phase-controller' || receipt.workflowId !== validatedState.workflowId
      || receipt.phaseId !== phase.id || receipt.phaseIndex !== phase.index || receipt.sourceCommit !== validatedState.sourceCommit
      || receipt.catalogVersion !== validatedState.catalogVersion || receipt.catalogDigest !== validatedState.catalogDigest
      || receipt.stateDigest !== validatedState.stateDigest || receipt.rejectedAttemptId !== rejection.attemptId
      || receipt.rejectedExecutionGeneration !== rejection.executionGeneration || receipt.reasonCode !== rejection.reasonCode
      || receipt.rejectionReceiptDigest !== rejection.receiptDigest || !UUID_PATTERN.test(receipt.executionId ?? '')
      || !['previousPromptDigest', 'originalRequestSha256', 'denialProofSha256', 'executionSha256',
        'baselineSha256', 'beginSha256', 'feedbackSha256', 'sessionProofSha256', 'zeroDeltaFingerprint'].every((key) => SHA256_PATTERN.test(receipt[key] ?? ''))
      || canonicalStringify(receipt.upstreamArtifactDigests) !== canonicalStringify(upstream)
      || receipt.retryPromptDigest !== promptDigest || receipt.remainingAttempts !== phase.maxAttempts - phaseAttempts
      || receipt.stateAdvanced !== false) {
      fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Access-scope retry receipt does not authorize this access attempt.');
    }
    return Object.freeze(JSON.parse(JSON.stringify(receipt)));
  }
  if (receipt?.schemaVersion === USER_ABORT_RETRY_SCHEMA) {
    exactKeys(receipt, ['schemaVersion', 'issuer', 'workflowId', 'phaseId', 'phaseIndex', 'sourceCommit',
      'catalogVersion', 'catalogDigest', 'stateDigest', 'rejectedAttemptId', 'rejectedExecutionGeneration',
      'rejectionReceiptDigest', 'reasonCode', 'executionId', 'previousPromptDigest', 'originalRequestSha256',
      'interruptionProofSha256', 'executionSha256', 'baselineSha256', 'beginSha256', 'feedbackSha256',
      'upstreamArtifactDigests', 'retryPromptDigest', 'remainingAttempts', 'stateAdvanced'], 'user-abort retry receipt');
    const upstream = Object.fromEntries(phase.requiresArtifacts.map((kind) => [kind, validatedState.acceptedArtifacts[kind]]));
    if (validatedState.status !== 'active' || validatedState.activeAttempt !== null
      || phase.id !== 'frontend' || phase.index !== 5 || phaseAttempts !== 1 || phaseAttempts >= phase.maxAttempts
      || rejection?.decision !== 'rejected' || rejection.reasonCode !== USER_ABORT_REASON
      || receipt.issuer !== 'forge-phase-controller' || receipt.workflowId !== validatedState.workflowId
      || receipt.phaseId !== phase.id || receipt.phaseIndex !== phase.index || receipt.sourceCommit !== validatedState.sourceCommit
      || receipt.catalogVersion !== validatedState.catalogVersion || receipt.catalogDigest !== validatedState.catalogDigest
      || receipt.stateDigest !== validatedState.stateDigest || receipt.rejectedAttemptId !== rejection.attemptId
      || receipt.rejectedExecutionGeneration !== rejection.executionGeneration || receipt.reasonCode !== rejection.reasonCode
      || receipt.rejectionReceiptDigest !== rejection.receiptDigest || !UUID_PATTERN.test(receipt.executionId ?? '')
      || !['previousPromptDigest', 'originalRequestSha256', 'interruptionProofSha256', 'executionSha256',
        'baselineSha256', 'beginSha256', 'feedbackSha256'].every((key) => SHA256_PATTERN.test(receipt[key] ?? ''))
      || canonicalStringify(receipt.upstreamArtifactDigests) !== canonicalStringify(upstream)
      || receipt.retryPromptDigest !== promptDigest || receipt.remainingAttempts !== phase.maxAttempts - phaseAttempts
      || receipt.stateAdvanced !== false) {
      fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'User-abort retry receipt does not authorize this frontend attempt.');
    }
    return Object.freeze(JSON.parse(JSON.stringify(receipt)));
  }
  if (receipt?.schemaVersion === FORMAT_RETRY_PROMPT_RECEIPT_SCHEMA) {
    exactKeys(receipt, [
      'schemaVersion', 'issuer', 'workflowId', 'phaseId', 'phaseIndex', 'sourceCommit',
      'catalogVersion', 'catalogDigest', 'stateDigest', 'rejectedAttemptId',
      'rejectedExecutionGeneration', 'rejectionReceiptDigest', 'reasonCode',
      'previousPromptDigest', 'originalRequestSha256', 'responseSha256',
      'unexpectedKeys', 'requiredPayloadKeys', 'allChangedPathsSha256',
      'phaseChangedPathsSha256', 'phasePatchSha256', 'cumulativePatchSha256',
      'upstreamArtifactDigests', 'retryPromptDigest', 'remainingAttempts', 'stateAdvanced',
    ], 'format retry prompt receipt');
    const expectedUpstream = Object.fromEntries(
      phase.requiresArtifacts.map((kind) => [kind, validatedState.acceptedArtifacts[kind]]),
    );
    const untrustedProposal = [JSON_FORMAT_REJECTION_REASON, MISSING_FORMAT_REJECTION_REASON].includes(receipt.reasonCode);
    if (validatedState.status !== 'active' || validatedState.activeAttempt !== null
      || rejection?.decision !== 'rejected' || rejection.phaseId !== phase.id
      || ![FORMAT_REJECTION_REASON, JSON_FORMAT_REJECTION_REASON, MISSING_FORMAT_REJECTION_REASON].includes(rejection.reasonCode)
      || phaseAttempts !== 1 || phaseAttempts >= phase.maxAttempts
      || receipt.issuer !== 'forge-phase-controller' || receipt.workflowId !== validatedState.workflowId
      || receipt.phaseId !== phase.id || receipt.phaseIndex !== phase.index
      || receipt.sourceCommit !== validatedState.sourceCommit
      || receipt.catalogVersion !== validatedState.catalogVersion
      || receipt.catalogDigest !== validatedState.catalogDigest || receipt.stateDigest !== validatedState.stateDigest
      || receipt.rejectedAttemptId !== rejection.attemptId
      || receipt.rejectedExecutionGeneration !== rejection.executionGeneration
      || receipt.rejectionReceiptDigest !== rejection.receiptDigest || receipt.reasonCode !== rejection.reasonCode
      || ![receipt.previousPromptDigest, receipt.originalRequestSha256, receipt.responseSha256,
        receipt.allChangedPathsSha256, receipt.phaseChangedPathsSha256, receipt.phasePatchSha256,
        receipt.cumulativePatchSha256].every((digest) => SHA256_PATTERN.test(digest ?? ''))
      || !Array.isArray(receipt.unexpectedKeys)
      || (untrustedProposal ? receipt.unexpectedKeys.length !== 0 : receipt.unexpectedKeys.length < 1)
      || receipt.unexpectedKeys.length > 16
      || receipt.unexpectedKeys.some((key) => typeof key !== 'string'
        || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) || phase.requiredPayloadKeys.includes(key))
      || new Set(receipt.unexpectedKeys).size !== receipt.unexpectedKeys.length
      || JSON.stringify(receipt.requiredPayloadKeys) !== JSON.stringify(phase.requiredPayloadKeys)
      || canonicalStringify(receipt.upstreamArtifactDigests) !== canonicalStringify(expectedUpstream)
      || receipt.retryPromptDigest !== promptDigest
      || receipt.remainingAttempts !== phase.maxAttempts - phaseAttempts
      || receipt.stateAdvanced !== false) {
      fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Format retry prompt receipt does not authorize the current retry.');
    }
    return Object.freeze(JSON.parse(JSON.stringify(receipt)));
  }
  exactKeys(receipt, [
    'schemaVersion', 'issuer', 'workflowId', 'phaseId', 'phaseIndex', 'sourceCommit',
    'catalogVersion', 'catalogDigest', 'stateDigest', 'rejectedAttemptId',
    'rejectedExecutionGeneration', 'rejectionReceiptDigest', 'reasonCode',
    'previousPromptDigest', 'originalRequestSha256', 'responseSha256',
    'candidateArtifactDigest', 'preflightReceiptSha256', 'semanticReviewSha256',
    'upstreamArtifactDigests', 'retryPromptDigest', 'remainingAttempts', 'stateAdvanced',
  ], 'retry prompt receipt');
  const expectedUpstream = Object.fromEntries(
    phase.requiresArtifacts.map((kind) => [kind, validatedState.acceptedArtifacts[kind]]),
  );
  if (validatedState.status !== 'active' || validatedState.activeAttempt !== null
    || rejection?.decision !== 'rejected' || rejection.phaseId !== phase.id
    || typeof rejection.reasonCode !== 'string' || !rejection.reasonCode.startsWith('SEMANTIC_')
    || phaseAttempts !== 1 || phaseAttempts >= phase.maxAttempts
    || receipt.schemaVersion !== RETRY_PROMPT_RECEIPT_SCHEMA
    || receipt.issuer !== 'forge-phase-controller' || receipt.workflowId !== validatedState.workflowId
    || receipt.phaseId !== phase.id || receipt.phaseIndex !== phase.index
    || receipt.sourceCommit !== validatedState.sourceCommit
    || receipt.catalogVersion !== validatedState.catalogVersion
    || receipt.catalogDigest !== validatedState.catalogDigest || receipt.stateDigest !== validatedState.stateDigest
    || receipt.rejectedAttemptId !== rejection.attemptId
    || receipt.rejectedExecutionGeneration !== rejection.executionGeneration
    || receipt.rejectionReceiptDigest !== rejection.receiptDigest || receipt.reasonCode !== rejection.reasonCode
    || !SHA256_PATTERN.test(receipt.previousPromptDigest ?? '')
    || !SHA256_PATTERN.test(receipt.originalRequestSha256 ?? '')
    || !SHA256_PATTERN.test(receipt.responseSha256 ?? '')
    || !SHA256_PATTERN.test(receipt.candidateArtifactDigest ?? '')
    || !SHA256_PATTERN.test(receipt.preflightReceiptSha256 ?? '')
    || !SHA256_PATTERN.test(receipt.semanticReviewSha256 ?? '')
    || canonicalStringify(receipt.upstreamArtifactDigests) !== canonicalStringify(expectedUpstream)
    || receipt.retryPromptDigest !== promptDigest
    || receipt.remainingAttempts !== phase.maxAttempts - phaseAttempts
    || receipt.stateAdvanced !== false) {
    fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Retry prompt receipt does not authorize the current retry.');
  }
  return Object.freeze(JSON.parse(JSON.stringify(receipt)));
}

async function readPinnedJson(file, expectedDigest, label) {
  requiredId(expectedDigest, SHA256_PATTERN, `${label} SHA-256`);
  const bytes = await boundedRegularFile(file, MAX_RESPONSE_BYTES, label);
  if (sha256(bytes) !== expectedDigest) {
    fail('PHASE_CONTROLLER_STALE_WRITE_EVIDENCE_INVALID', `${label} does not match its operator-pinned digest.`);
  }
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    fail('PHASE_CONTROLLER_STALE_WRITE_EVIDENCE_INVALID', `${label} is not valid JSON.`);
  }
}

async function writeOrVerifyReceipt(file, receipt) {
  const expected = jsonBytes(receipt);
  const information = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (information === null) {
    await writeExclusive(file, expected);
    return;
  }
  const actual = await boundedRegularFile(file, MAX_RESPONSE_BYTES, 'stale-write recovery receipt');
  if (!actual.equals(expected)) {
    fail('PHASE_CONTROLLER_STALE_WRITE_REPLAY_MISMATCH', 'Recovery receipt changed across an idempotent replay.');
  }
}

function validatePinnedStaleWriteTrace(trace, state, attempt, phase) {
  exactKeys(trace, [
    'schemaVersion', 'sessionId', 'sessionUpdatedAt', 'rpcId',
    'executionGeneration', 'path', 'events',
  ], 'writer stale-create trace');
  if (trace.schemaVersion !== STALE_WRITE_TRACE_SCHEMA || trace.sessionId !== state.sessionId
    || !Number.isSafeInteger(trace.sessionUpdatedAt) || trace.sessionUpdatedAt < 1
    || trace.rpcId !== attempt.rpcId || trace.executionGeneration !== attempt.executionGeneration
    || typeof trace.path !== 'string' || normalizedChangedPaths([trace.path])[0] !== trace.path
    || !phase.ownedPaths.some((root) => trace.path === root || trace.path.startsWith(`${root}/`))
    || !Array.isArray(trace.events) || trace.events.length !== 6) {
    fail('PHASE_CONTROLLER_STALE_WRITE_EVIDENCE_INVALID', 'Writer trace is not bound to the active database attempt.');
  }
  const [write1, stale, read1, missing, write2, denied] = trace.events;
  exactKeys(write1, [
    'seq', 'type', 'tool', 'callId', 'argumentsSha256', 'contentBytes', 'contentSha256',
  ], 'first stale write call');
  exactKeys(stale, [
    'seq', 'type', 'callId', 'isError', 'errorName', 'errorCode', 'text',
  ], 'stale write result');
  exactKeys(read1, ['seq', 'type', 'tool', 'callId', 'argumentsSha256'], 'not-found read call');
  exactKeys(missing, [
    'seq', 'type', 'callId', 'isError', 'errorName', 'errorCode', 'text',
  ], 'not-found read result');
  exactKeys(write2, [
    'seq', 'type', 'tool', 'callId', 'argumentsSha256', 'contentBytes', 'contentSha256',
  ], 'retry write call');
  exactKeys(denied, ['seq', 'type', 'callId', 'isError', 'text'], 'Guard denial result');
  const absolutePath = `/workspace/${trace.path}`;
  const validCall = (entry, tool) => Number.isSafeInteger(entry.seq) && entry.seq >= 0
    && entry.type === 'tool/call' && entry.tool === tool
    && typeof entry.callId === 'string' && /^[^\0\r\n]{1,256}$/u.test(entry.callId)
    && SHA256_PATTERN.test(entry.argumentsSha256 ?? '');
  const paired = stale.callId === write1.callId && missing.callId === read1.callId
    && denied.callId === write2.callId && new Set([write1.callId, read1.callId, write2.callId]).size === 3;
  if (!validCall(write1, 'write') || !validCall(read1, 'read') || !validCall(write2, 'write')
    || !Number.isSafeInteger(write1.contentBytes) || write1.contentBytes < 1
    || !Number.isSafeInteger(write2.contentBytes) || write2.contentBytes < 1
    || !SHA256_PATTERN.test(write1.contentSha256 ?? '')
    || !SHA256_PATTERN.test(write2.contentSha256 ?? '')
    || !paired || stale.seq !== write1.seq + 1 || read1.seq <= stale.seq
    || missing.seq !== read1.seq + 1 || write2.seq <= missing.seq || denied.seq !== write2.seq + 1
    || stale.type !== 'tool/result' || stale.isError !== true || stale.errorName !== 'FsError'
    || stale.errorCode !== 'FS_STALE_VERSION'
    || stale.text !== `Error: cannot write "${absolutePath}": file no longer exists — re-read the file, then retry`
    || missing.type !== 'tool/result' || missing.isError !== true || missing.errorName !== 'FsError'
    || missing.errorCode !== 'FS_NOT_FOUND'
    || missing.text !== `Error: cannot read "${absolutePath}": not found`
    || denied.type !== 'tool/result' || denied.isError !== true
    || denied.text !== 'Error: FORGE_PHASE_BUDGET_GUARD_V1: NO_MACHINE_OBSERVABLE_PROGRESS; ordinary mutation is closed, preserve the current immutable evidence and issue a truthful bounded closeout') {
    fail('PHASE_CONTROLLER_STALE_WRITE_EVIDENCE_INVALID', 'Writer trace does not contain the fixed stale-write/read-not-found/Guard-denial chain.');
  }
}

function validatePinnedStaleWriteEvidence(evidence, { state, attempt, traceDigest, stateFileDigest }) {
  exactKeys(evidence, [
    'schemaVersion', 'outcome', 'phaseId', 'phaseAttemptId', 'executionGeneration',
    'rpcId', 'modelTerminalKind', 'controllerPreflight', 'independentContractFailure',
    'workspaceEvidence', 'forensicTurnEvidenceSha256', 'writerRecoveryTraceSha256',
    'controllerStateFrozenSha256', 'hostRunnerExecuted', 'accepted', 'existingRejectInvoked',
    'plannedTechnicalFailureClass', 'disposition', 'cannotClaim',
  ], 'database attempt failure evidence');
  exactKeys(evidence.controllerPreflight, [
    'exitCode', 'errorCode', 'stderrSha256', 'stdoutSha256', 'receiptCreated', 'stateAdvanced',
  ], 'controller preflight failure evidence');
  exactKeys(evidence.independentContractFailure, [
    'artifactOpenCount', 'artifactCloseCount', 'uniqueArtifactPresent', 'responseSha256',
  ], 'independent response failure evidence');
  exactKeys(evidence.workspaceEvidence, [
    'allChangedPathsSha256', 'phaseChangedPathsSha256', 'phasePatchSha256',
    'cumulativePatchSha256', 'sourceCommit', 'clean',
  ], 'workspace failure evidence');
  const preflight = evidence.controllerPreflight;
  const response = evidence.independentContractFailure;
  const workspace = evidence.workspaceEvidence;
  if (evidence.schemaVersion !== STALE_WRITE_EVIDENCE_SCHEMA
    || evidence.outcome !== 'controller-preflight-rejected' || evidence.phaseId !== 'database'
    || evidence.phaseId !== state.currentPhaseId || evidence.phaseAttemptId !== attempt.attemptId
    || evidence.executionGeneration !== attempt.executionGeneration || evidence.rpcId !== attempt.rpcId
    || evidence.modelTerminalKind !== 'completed' || preflight.exitCode !== 1
    || preflight.errorCode !== 'PHASE_CONTROLLER_ZERO_CHANGE' || preflight.receiptCreated !== false
    || preflight.stateAdvanced !== false || !SHA256_PATTERN.test(preflight.stderrSha256 ?? '')
    || preflight.stdoutSha256 !== EMPTY_SHA256
    || response.artifactOpenCount !== 0 || response.artifactCloseCount !== 0
    || response.uniqueArtifactPresent !== false || !SHA256_PATTERN.test(response.responseSha256 ?? '')
    || workspace.allChangedPathsSha256 !== EMPTY_JSON_ARRAY_FILE_SHA256
    || workspace.phaseChangedPathsSha256 !== EMPTY_JSON_ARRAY_FILE_SHA256
    || workspace.phasePatchSha256 !== EMPTY_SHA256 || workspace.cumulativePatchSha256 !== EMPTY_SHA256
    || workspace.sourceCommit !== state.sourceCommit || workspace.clean !== true
    || !SHA256_PATTERN.test(evidence.forensicTurnEvidenceSha256 ?? '')
    || evidence.writerRecoveryTraceSha256 !== traceDigest
    || evidence.controllerStateFrozenSha256 !== stateFileDigest
    || evidence.hostRunnerExecuted !== false || evidence.accepted !== false
    || evidence.existingRejectInvoked !== false
    || evidence.plannedTechnicalFailureClass !== 'PLATFORM_WRITE_RECOVERY_FAILED'
    || evidence.disposition !== 'freeze-active-attempt-until-evidence-bound-technical-invalidation-is-versioned'
    || JSON.stringify(evidence.cannotClaim) !== JSON.stringify([
      'database accepted', 'database code produced', 'Host Runner verified', 'release ready',
    ])) {
    fail('PHASE_CONTROLLER_STALE_WRITE_EVIDENCE_INVALID', 'Failure evidence does not prove the frozen active database incident.');
  }
}

export async function readForgeDeliveryAcceptedArtifact({ state, artifactsDirectory, artifactKind }) {
  const correction = state.history.find(item => (artifactKind === 'access-wiring-implementation'
    && item.schemaVersion === 'forge-delivery-access-accepted-correction/v1')
    || (artifactKind === 'backend-implementation' && item.schemaVersion === 'forge-delivery-backend-accepted-correction/v1'));
  const corrected = correction !== undefined
    && state.acceptedArtifacts[artifactKind] !== correction.artifactDigest;
  const filename = corrected ? `${artifactKind}-${state.acceptedArtifacts[artifactKind]}.json` : `${artifactKind}.json`;
  const candidate = validateForgeDeliveryPhaseArtifact(await readJsonFile(
    path.join(artifactsDirectory, filename), MAX_RESPONSE_BYTES, `accepted artifact ${artifactKind}`));
  if (candidate.artifactKind !== artifactKind || candidate.artifactDigest !== state.acceptedArtifacts[artifactKind]
    || candidate.workflowId !== state.workflowId) {
    fail('PHASE_CONTROLLER_UPSTREAM_STALE', `Accepted artifact ${artifactKind} is stale.`);
  }
  return candidate;
}

async function loadAcceptedArtifacts({ state, catalog, artifactsDirectory }) {
  const artifacts = [];
  const acceptedEntries = Object.entries(state.acceptedArtifacts);
  for (const [kind, expectedDigest] of acceptedEntries) {
    const candidate = await readForgeDeliveryAcceptedArtifact({ state, artifactsDirectory, artifactKind: kind });
    if (candidate.artifactKind !== kind || candidate.artifactDigest !== expectedDigest
      || candidate.workflowId !== state.workflowId) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', `Accepted artifact ${kind} is stale.`);
    }
    artifacts.push(candidate);
  }
  validateForgeDeliveryPhaseState(state, catalog);
  return artifacts;
}

// Called only after loadAcceptedArtifacts has verified the retained artifact digests.
export function projectForgeAcceptedApiContract({ state, acceptedArtifacts }) {
  const domain = acceptedArtifacts.find(item => item.artifactKind === 'domain-api-contract');
  const groups = domain?.payload?.apiContracts?.endpoints;
  if (!domain || domain.artifactDigest !== state.acceptedArtifacts['domain-api-contract']
    || !Array.isArray(groups) || groups.length === 0) return undefined;
  const endpoints = [];
  for (const group of groups) {
    if (!Array.isArray(group?.operations) || group.operations.length === 0) return undefined;
    for (const operation of group.operations) {
      if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/u.test(operation?.method ?? '')) return undefined;
      const paths = operation.path === undefined ? operation.exactPaths : [operation.path];
      if ((operation.path !== undefined && operation.exactPaths !== undefined)
        || !Array.isArray(paths) || paths.length === 0
        || paths.some(value => typeof value !== 'string' || !/^\/[^\s\0]*$/u.test(value))) return undefined;
      for (const endpointPath of paths) endpoints.push({ method: operation.method, path: endpointPath });
    }
  }
  return { schemaVersion: 1, taskId: state.taskId, workflowId: state.workflowId, sourceCommit: state.sourceCommit,
    artifactDigest: domain.artifactDigest, endpoints };
}

async function readForgeCompletedApiContractProjection({
  catalogFile, stateFile, artifactsDirectory, workspace, taskId, sessionId, sourceCommit, workspaceFingerprint,
  publishedRuntimeObservation = false,
}) {
  requiredId(sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  requiredId(workspaceFingerprint, SHA256_PATTERN, 'workspaceFingerprint');
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  const state = await readForgeDeliveryPhaseState(stateFile, catalog);
  if (state.status !== 'completed' || state.activeAttempt !== null
    || state.workflowId !== 'crud-production' || state.taskId !== taskId || state.sessionId !== sessionId) {
    fail('PHASE_CONTROLLER_COMPLETED_IDENTITY_MISMATCH', 'Completed API recovery requires the original completed task and session.');
  }
  const acceptedArtifacts = await loadAcceptedArtifacts({ state, catalog, artifactsDirectory });
  // The terminal cross-layer receipt follows the last accepted source correction.
  const sourceKind = currentForgeRuntimeSourceArtifactKind({ ...state, history: state.history.slice(0, -1) });
  const acceptedSource = acceptedArtifacts.find(artifact => artifact.artifactKind === sourceKind);
  await snapshotForgeDeliveryWorkspace({ workspace,
    baseCommit: state.sourceCommit, expectedHead: sourceCommit });
  // Patch representation is not a substitute for the accepted runtime's content
  // identity, including when its digest happens to remain equal after a change.
  const directory = path.dirname(stateFile);
  const receipt = await readJsonFile(path.join(directory, 'runtime-input-receipt.json'), MAX_RESPONSE_BYTES,
    'completed runtime input receipt', { trustedReview: true });
  const bytes = await boundedRegularFile(path.join(directory, 'runtime-evidence.json'), MAX_RESPONSE_BYTES,
    'completed runtime evidence', { trustedReview: true });
  const bundle = JSON.parse(bytes.toString('utf8'));
  const cross = acceptedArtifacts.find(artifact => artifact.artifactKind === 'cross-layer-acceptance');
  const upstream = { ...state.acceptedArtifacts };
  delete upstream['cross-layer-acceptance'];
  const binding = receipt.preparationBinding;
  if (receipt.schemaVersion !== 'forge-cross-layer-runtime-input-receipt/v1'
    || receipt.bundleSha256 !== sha256(bytes) || receipt.manifestSha256 !== bundle.manifestSha256
    || cross?.payload?.runtimeEvidenceDigest !== bundle.manifestSha256
    || receipt.sessionId !== state.sessionId || bundle.subject?.workflowId !== state.workflowId
    || bundle.subject?.taskId !== state.taskId || bundle.subject?.baseSourceCommit !== state.sourceCommit
    || bundle.subject?.catalogVersion !== state.catalogVersion || bundle.subject?.catalogDigest !== state.catalogDigest
    || bundle.subject?.stateDigest !== receipt.sourceStateDigest
    || !acceptedSource || bundle.subject?.cumulativePatchSha256 !== acceptedSource.sourceFingerprint
    || binding?.stateDigest !== receipt.sourceStateDigest || binding?.baseSourceCommit !== state.sourceCommit
    || !SHA256_PATTERN.test(binding?.workspaceFingerprint ?? '')
    || (!publishedRuntimeObservation && binding.workspaceFingerprint !== workspaceFingerprint)
    || canonicalStringify(receipt.acceptedArtifacts) !== canonicalStringify(upstream)
    || canonicalStringify(binding?.acceptedArtifactDigests) !== canonicalStringify(upstream)) {
    fail('PHASE_CONTROLLER_COMPLETED_SOURCE_MISMATCH', 'Completed API recovery cannot reuse a contract after accepted source changes.');
  }
  const contract = projectForgeAcceptedApiContract({ state, acceptedArtifacts });
  return contract === undefined ? undefined : { ...contract, sourceCommit };
}

export async function readForgeCompletedApiContract(input) {
  return readForgeCompletedApiContractProjection({ ...input, publishedRuntimeObservation: false });
}

function requiredUpstreamArtifacts(allArtifacts, phase) {
  const byKind = new Map(allArtifacts.map((artifact) => [artifact.artifactKind, artifact]));
  return phase.requiresArtifacts.map((kind) => {
    const artifact = byKind.get(kind);
    if (artifact === undefined) fail('PHASE_CONTROLLER_UPSTREAM_STALE', `Required artifact ${kind} is missing.`);
    return artifact;
  });
}

function observePhasePaths({ allChangedPaths, phaseChangedPaths, acceptedArtifacts, phase, retainedPaths = [] }) {
  const prior = new Set(acceptedArtifacts.flatMap((artifact) => artifact.changedPaths));
  const rewritten = phaseChangedPaths.filter((candidate) => prior.has(candidate));
  if (rewritten.length > 0) {
    fail('PHASE_CONTROLLER_ACCEPTED_PATH_REWRITE', `Phase ${phase.id} rewrote an already accepted path.`);
  }
  const expectedCumulative = [...new Set([...prior, ...retainedPaths, ...phaseChangedPaths])].sort();
  if (JSON.stringify(expectedCumulative) !== JSON.stringify(allChangedPaths)) {
    fail('PHASE_CONTROLLER_PATH_DRIFT', 'Cumulative source paths do not match accepted and current phase observations.');
  }
  if (!phase.sourceMutation && phaseChangedPaths.length !== 0) {
    fail('PHASE_CONTROLLER_MUTATION_DENIED', `Read-only phase ${phase.id} changed project source.`);
  }
  if (phase.sourceMutation && phaseChangedPaths.length === 0) {
    fail('PHASE_CONTROLLER_ZERO_CHANGE', `Source phase ${phase.id} produced no new owned change.`);
  }
  return phaseChangedPaths;
}

async function retainedBackendCorrectionPaths({ state, catalog, artifactsDirectory }) {
  const backend = catalog.workflows.find(item => item.id === state.workflowId).phases.find(item => item.id === 'backend');
  const paths = new Set();
  for (const correction of state.history.filter(item => item.schemaVersion === 'forge-delivery-backend-accepted-correction/v1')) {
    // The validated state binds this exact historical acceptance. Reading its
    // paths preserves unchanged source, without accepting the old backend again.
    const artifact = await readForgeDeliveryAcceptedArtifact({
      state: { ...state, acceptedArtifacts: { ...state.acceptedArtifacts, 'backend-implementation': correction.artifactDigest } },
      artifactsDirectory, artifactKind: 'backend-implementation',
    });
    if (artifact.phaseId !== 'backend' || artifact.attemptId !== correction.attemptId
      || artifact.changedPaths.some(candidate => !backend.ownedPaths.some(root => candidate === root || candidate.startsWith(`${root}/`)))) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', 'Retained backend paths differ from the bound accepted correction.');
    }
    for (const candidate of artifact.changedPaths) paths.add(candidate);
  }
  return [...paths];
}

function assertPhaseFileClosure(phase, changedPaths) {
  if (!['database', 'access-wiring'].includes(phase.id)) return;
  const hasMigration = changedPaths.some((candidate) => (
    /^forge-server\/db\/migration\/[^/]+\.sql$/u.test(candidate)
  ));
  const hasMigrationTest = changedPaths.some((candidate) => (
    /^forge-server\/forge-business\/forge-business-core\/src\/test\/java\/.+MigrationContractTest\.java$/u.test(candidate)
  ));
  if (!hasMigration || !hasMigrationTest) {
    fail(
      'PHASE_CONTROLLER_REQUIRED_FILE_MISSING',
      `Phase ${phase.id} requires both a new Flyway migration and a business-core MigrationContractTest.`,
    );
  }
}

async function evaluatePhaseCandidate({
  state,
  stateFile,
  catalog,
  artifactsDirectory,
  response,
  allChangedPaths,
  phaseChangedPaths,
  phasePatchBytes,
  cumulativePatchBytes,
}) {
  const phase = currentPhase(state, catalog);
  if (state.activeAttempt === null) {
    fail('PHASE_CONTROLLER_ATTEMPT_MISSING', 'The current phase has no protected active attempt.');
  }
  const acceptedArtifacts = await loadAcceptedArtifacts({ state, catalog, artifactsDirectory });
  const retainedPaths = await retainedBackendCorrectionPaths({ state, catalog, artifactsDirectory });
  const cumulativePatchDigest = sha256(cumulativePatchBytes);
  const acceptedSource = acceptedArtifacts.find(artifact => artifact.artifactKind === currentForgeRuntimeSourceArtifactKind(state));
  // A retained cross-layer baseline can predate an accepted source correction.
  // Attribute its historical delta to the accepted source without rewriting it.
  const unchangedAcceptedSource = phase.id === 'cross-layer-acceptance' && phase.index === 7
    && phase.actionCeiling === 'read-only' && phase.sourceMutation === false
    && acceptedSource?.sourceFingerprint === cumulativePatchDigest;
  const currentChangedPaths = observePhasePaths({
    allChangedPaths,
    phaseChangedPaths: unchangedAcceptedSource ? [] : phaseChangedPaths,
    acceptedArtifacts,
    phase,
    retainedPaths,
  });
  const proposal = parseForgeDeliveryPhaseProposal({ text: response, phase });
  const runtimeEvidence = phase.id === 'cross-layer-acceptance'
    ? await readPreparedForgeCrossLayerRuntimeEvidence({ stateFile, state }) : null;
  if (runtimeEvidence !== null && proposal.payload.runtimeEvidenceDigest !== runtimeEvidence.manifestSha256) {
    fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'The response does not cite the runtime evidence supplied to this attempt.');
  }
  const phasePatchDigest = sha256(phasePatchBytes);
  const patchDigest = phase.patchScope === 'none'
    ? null
    : phase.patchScope === 'phase' ? phasePatchDigest : cumulativePatchDigest;
  if (phase.patchScope === 'none' && phasePatchBytes.length !== 0) {
    fail('PHASE_CONTROLLER_MUTATION_DENIED', `Read-only phase ${phase.id} emitted a phase patch.`);
  }
  if (phase.patchScope === 'phase' && phasePatchBytes.length === 0) {
    fail('PHASE_CONTROLLER_ZERO_CHANGE', `Source phase ${phase.id} emitted an empty phase patch.`);
  }
  const artifact = createForgeDeliveryPhaseArtifactFromProposal({
    state,
    catalog,
    proposal,
    sourceFingerprint: cumulativePatchDigest,
    changedPaths: currentChangedPaths,
    patchDigest,
  });
  assertPhaseFileClosure(phase, currentChangedPaths);
  const hostVerificationReuse = unchangedAcceptedSource && phase.ownedPaths.length === 0
    && artifact.unresolvedDecisions.length === 0 ? acceptedSource : null;
  if (hostVerificationReuse !== null) {
    validateForgeCrossLayerHostVerificationReuse({ state, catalog, artifact, hostVerificationReuse });
  }
  return {
    phase,
    acceptedArtifacts,
    currentChangedPaths,
    proposal,
    artifact,
    patchDigest,
    phasePatchDigest,
    cumulativePatchDigest,
    runtimeEvidence,
    hostVerificationReuse,
  };
}

export async function inspectForgeCrossLayerHostVerificationReuse(input) {
  const candidate = await evaluatePhaseCandidate({ ...input,
    allChangedPaths: normalizedChangedPaths(input.allChangedPaths),
    phaseChangedPaths: normalizedChangedPaths(input.phaseChangedPaths),
  });
  return { candidateArtifactDigest: candidate.artifact.artifactDigest,
    hostVerificationReuse: candidate.hostVerificationReuse };
}

export async function initializeForgeDeliveryPhaseRun({
  catalogFile,
  workflowId,
  caseFamily,
  taskId,
  sessionId,
  sourceCommit,
  originalRequestFile,
  stateFile,
  artifactsDirectory,
  promptFile,
}) {
  requiredId(workflowId, ID_PATTERN, 'workflowId');
  requiredId(caseFamily, ID_PATTERN, 'caseFamily');
  requiredId(taskId, ID_PATTERN, 'taskId');
  requiredId(sessionId, /^[^\0\r\n]{1,1024}$/u, 'sessionId');
  requiredId(sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  const [{ catalog }, requestBytes] = await Promise.all([
    loadForgeDeliveryPhaseCatalog(catalogFile),
    boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request'),
  ]);
  const request = requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  const state = createForgeDeliveryPhaseState({
    catalog,
    workflowId,
    caseFamily,
    taskId,
    sessionId,
    sourceCommit,
  });
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  await writeForgeDeliveryPhaseState(stateFile, state, catalog);
  const prompt = buildForgeDeliveryPhasePrompt({ state, catalog, originalRequest: request });
  await writeExclusive(promptFile, Buffer.from(`${prompt}\n`, 'utf8'));
  return Object.freeze({
    schemaVersion: 'forge-delivery-phase-controller-init/v1',
    workflowId,
    phaseId: state.currentPhaseId,
    phaseIndex: state.currentPhaseIndex,
    stateDigest: state.stateDigest,
    promptDigest: sha256(Buffer.from(prompt, 'utf8')),
  });
}

export async function prepareForgeDatabaseContinuation({
  catalogFile,
  sourceStateFile,
  expectedSourceStateSha256,
  sourceArtifactsDirectory,
  sourceCommit,
  originalRequestFile,
  outputDirectory,
}) {
  requiredId(expectedSourceStateSha256, SHA256_PATTERN, 'expectedSourceStateSha256');
  requiredId(sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  if (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)
    || typeof sourceArtifactsDirectory !== 'string' || !path.isAbsolute(sourceArtifactsDirectory)) {
    fail('PHASE_CONTROLLER_PATH_INVALID', 'Continuation paths must be absolute.');
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  const sourceBytes = await boundedRegularFile(sourceStateFile, MAX_RESPONSE_BYTES, 'source phase state');
  const sourceStateSha256 = sha256(sourceBytes);
  if (sourceStateSha256 !== expectedSourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Source phase state bytes do not match the pinned digest.');
  }
  let parent;
  try {
    parent = validateForgeDeliveryPhaseState(JSON.parse(sourceBytes.toString('utf8')), catalog);
  } catch (error) {
    if (error?.code) throw error;
    fail('PHASE_CONTROLLER_STATE_INVALID', 'Source phase state is not valid JSON.');
  }
  const phase = currentPhase(parent, catalog);
  const parentFailures = parent.history.filter((entry) => entry.phaseId === 'database');
  if (parent.schemaVersion !== 'forge-delivery-phase-state/v2'
    || parent.sourceCommit !== sourceCommit || parent.status !== 'blocked'
    || parent.currentPhaseIndex !== 2 || phase.id !== 'database'
    || parent.activeAttempt !== null || parentFailures.length === 0
    || parentFailures.some((entry) => entry.decision !== 'rejected')
    || parent.history.at(-1) !== parentFailures.at(-1)
    || Object.keys(parent.acceptedArtifacts).sort().join('\n')
      !== ['domain-api-contract', 'requirements-contract'].join('\n')) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only an exhausted rejected database phase with accepted R/D can be continued.');
  }
  const accepted = await loadAcceptedArtifacts({ state: parent, catalog, artifactsDirectory: sourceArtifactsDirectory });
  const inheritedKinds = ['requirements-contract', 'domain-api-contract'];
  const artifacts = new Map(accepted.map((artifact) => [artifact.artifactKind, artifact]));
  const inheritedHistory = parent.history.filter((entry) => entry.phaseIndex < 2);
  const acceptedHistory = inheritedHistory.filter((entry) => entry.decision === 'accepted');
  if (accepted.length !== 2 || acceptedHistory.length !== 2
    || acceptedHistory.some((entry, index) => entry.phaseIndex !== index
      || entry.phaseId !== ['requirements', 'domain-contract'][index]
      || entry.artifactDigest !== parent.acceptedArtifacts[inheritedKinds[index]])
    || inheritedKinds.some((kind, index) => {
      const artifact = artifacts.get(kind);
      return artifact?.artifactDigest !== acceptedHistory[index].artifactDigest
        || artifact.attemptId !== acceptedHistory[index].attemptId
        || artifact.phaseId !== acceptedHistory[index].phaseId
        || artifact.changedPaths.length !== 0 || artifact.patchDigest !== null
        || artifact.sourceFingerprint !== EMPTY_SHA256;
    })
    || canonicalStringify(artifacts.get(inheritedKinds[0]).upstreamArtifactDigests) !== canonicalStringify({})
    || canonicalStringify(artifacts.get(inheritedKinds[1]).upstreamArtifactDigests)
      !== canonicalStringify({ 'requirements-contract': parent.acceptedArtifacts[inheritedKinds[0]] })) {
    fail('PHASE_CONTROLLER_UPSTREAM_STALE', 'Inherited R/D artifacts do not match their accepted source history.');
  }
  const artifactBytes = new Map();
  for (const kind of inheritedKinds) {
    const bytes = await boundedRegularFile(path.join(sourceArtifactsDirectory, `${kind}.json`),
      MAX_RESPONSE_BYTES, `source accepted artifact ${kind}`);
    const artifact = validateForgeDeliveryPhaseArtifact(JSON.parse(bytes.toString('utf8')));
    if (artifact.artifactDigest !== artifacts.get(kind).artifactDigest) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', `Inherited artifact ${kind} changed during preparation.`);
    }
    artifactBytes.set(kind, bytes);
  }
  const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
  const originalRequest = requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  const next = {
    ...parent,
    status: 'active',
    activeAttempt: null,
    history: inheritedHistory,
    lastExecutionGeneration: inheritedHistory.at(-1).executionGeneration,
    revision: 1 + inheritedHistory.length * 2,
    updatedAt: parent.updatedAt,
  };
  const { stateDigest: _oldDigest, ...withoutDigest } = next;
  next.stateDigest = sha256(Buffer.from(canonicalStringify(withoutDigest), 'utf8'));
  const state = validateForgeDeliveryPhaseState(next, catalog);
  const prompt = buildForgeDeliveryPhasePrompt({
    state, catalog, originalRequest, upstreamArtifacts: requiredUpstreamArtifacts(accepted, phase),
  });
  const promptBytes = Buffer.from(`${prompt}\n`, 'utf8');
  if (sha256(await boundedRegularFile(sourceStateFile, MAX_RESPONSE_BYTES, 'source phase state')) !== sourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Source phase state changed during preparation.');
  }
  const receipt = Object.freeze({
    schemaVersion: 'forge-delivery-database-continuation/v1',
    phaseId: 'database', phaseIndex: 2,
    sourceStateSha256, sourceStateDigest: parent.stateDigest,
    sourceCommit, catalogVersion: parent.catalogVersion, catalogDigest: parent.catalogDigest,
    taskId: parent.taskId, sessionId: parent.sessionId,
    parentLastExecutionGeneration: parent.lastExecutionGeneration,
    nextExecutionGenerationMinimum: parent.lastExecutionGeneration + 1,
    inheritedArtifactDigests: Object.fromEntries(inheritedKinds.map((kind) => [kind, parent.acceptedArtifacts[kind]])),
    inheritedAcceptedReceiptDigests: Object.fromEntries(acceptedHistory.map((entry) => [entry.phaseId, entry.receiptDigest])),
    parentDatabaseFailureReceiptDigests: parentFailures.map((entry) => entry.receiptDigest),
    stateDigest: state.stateDigest, promptSha256: sha256(promptBytes),
    inheritedStageCount: 2, newAcceptedStageCount: 0,
    modelStarted: false, parentStateUnchanged: true,
  });
  await mkdir(outputDirectory, { mode: 0o700 });
  await writeForgeDeliveryPhaseState(path.join(outputDirectory, 'state.json'), state, catalog);
  for (const kind of inheritedKinds) {
    await writeExclusive(path.join(outputDirectory, 'artifacts', `${kind}.json`), artifactBytes.get(kind));
  }
  await writeExclusive(path.join(outputDirectory, 'current-prompt.md'), promptBytes);
  await writeExclusive(path.join(outputDirectory, 'continuation-receipt.json'), jsonBytes(receipt));
  return receipt;
}

export async function prepareForgeBackendFinalizedContinuation({
  catalogFile, sourceCaseDirectory, bindingsFile, expectedBindingsSha256,
  sourceCommit, originalRequestFile, outputDirectory,
}) {
  requiredId(expectedBindingsSha256, SHA256_PATTERN, 'expectedBindingsSha256');
  requiredId(sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  if (![sourceCaseDirectory, outputDirectory].every((value) => typeof value === 'string' && path.isAbsolute(value))
    || realpathSync(sourceCaseDirectory) !== sourceCaseDirectory) {
    fail('PHASE_CONTROLLER_PATH_INVALID', 'Backend continuation requires an ordinary retained case path.');
  }
  const bindingsBytes = await boundedRegularFile(bindingsFile, MAX_RESPONSE_BYTES, 'reviewed backend continuation bindings',
    { trustedReview: true });
  if (sha256(bindingsBytes) !== expectedBindingsSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Reviewed backend continuation bindings changed.');
  }
  const bindings = JSON.parse(bindingsBytes.toString('utf8'));
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation', 'ui-interaction-contract'];
  const phaseNames = ['requirements', 'domain-contract', 'database', 'ui-design'];
  const profiles = ['governance', 'backend-module-compile', 'backend-module-test'];
  const evidenceFiles = [
    'model.stdout.txt', 'all-changed-paths.json', 'phase-changed-paths.json',
    'phase.patch', 'cumulative.patch', 'controller-preflight-receipt.json',
    'independent-semantic-review.json', 'phase-host-receipts.json', 'host-runner/manifest.json',
    ...profiles.map((profile) => `host-runner/${profile}/host-profile.receipt.json`),
  ];
  exactKeys(bindings, ['schemaVersion', 'sourceStateSha256', 'originalRequestSha256',
    'artifactSha256', 'evidenceSha256'], 'backend continuation bindings');
  exactKeys(bindings.artifactSha256, kinds, 'backend continuation accepted artifact hashes');
  exactKeys(bindings.evidenceSha256, evidenceFiles, 'backend continuation evidence hashes');
  if (bindings.schemaVersion !== 'forge-delivery-backend-finalize-bindings/v1'
    || ![bindings.sourceStateSha256, bindings.originalRequestSha256,
      ...Object.values(bindings.artifactSha256), ...Object.values(bindings.evidenceSha256)]
      .every((digest) => SHA256_PATTERN.test(digest))) {
    fail('PHASE_CONTROLLER_INPUT_INVALID', 'Backend continuation hashes are invalid.');
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  const stateFile = path.join(sourceCaseDirectory, 'phase-control/state.json');
  const stateBytes = await boundedRegularFile(stateFile, MAX_RESPONSE_BYTES, 'retained backend state');
  if (sha256(stateBytes) !== bindings.sourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Retained backend state differs from reviewed bytes.');
  }
  const state = validateForgeDeliveryPhaseState(JSON.parse(stateBytes.toString('utf8')), catalog);
  const accepted = await loadAcceptedArtifacts({ state, catalog,
    artifactsDirectory: path.join(sourceCaseDirectory, 'phase-control/artifacts') });
  const acceptedHistory = state.history.filter((entry) => entry.decision === 'accepted');
  if (state.schemaVersion !== 'forge-delivery-phase-state/v2' || state.sourceCommit !== sourceCommit
    || state.caseFamily !== 'crud-complete' || state.status !== 'active'
    || state.currentPhaseId !== 'backend' || state.currentPhaseIndex !== 4
    || state.activeAttempt?.phaseId !== 'backend' || state.activeAttempt?.sessionMode !== 'resume'
    || state.activeAttempt?.executionGeneration < 2 || state.lastExecutionGeneration !== state.activeAttempt.executionGeneration
    || state.history.at(-1)?.phaseId !== 'backend' || state.history.at(-1)?.decision !== 'rejected'
    || accepted.length !== 4 || acceptedHistory.length !== 4
    || acceptedHistory.some((entry, index) => entry.phaseIndex !== index || entry.phaseId !== phaseNames[index]
      || entry.artifactDigest !== state.acceptedArtifacts[kinds[index]])) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only the active second backend attempt after four accepted phases can continue.');
  }
  const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
  if (sha256(requestBytes) !== bindings.originalRequestSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Original request differs from the reviewed input.');
  }
  const artifactBytes = new Map();
  for (const kind of kinds) {
    const bytes = await boundedRegularFile(path.join(sourceCaseDirectory, 'phase-control/artifacts', `${kind}.json`),
      MAX_RESPONSE_BYTES, `retained ${kind}`);
    if (sha256(bytes) !== bindings.artifactSha256[kind]) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', `Retained ${kind} differs from reviewed bytes.`);
    }
    artifactBytes.set(kind, bytes);
  }
  const evidenceDirectory = path.join(sourceCaseDirectory, 'phases/05-backend/attempts/02');
  const evidenceBytes = new Map();
  for (const relative of evidenceFiles) {
    const bytes = await boundedRegularFile(path.join(evidenceDirectory, relative),
      relative.endsWith('.patch') ? MAX_PATCH_BYTES : MAX_RESPONSE_BYTES,
      `retained backend ${relative}`, { trustedReview: relative === 'independent-semantic-review.json' });
    if (sha256(bytes) !== bindings.evidenceSha256[relative]) {
      fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', `Retained backend ${relative} differs from reviewed bytes.`);
    }
    evidenceBytes.set(relative, bytes);
  }
  const inspected = await inspectForgeDeliveryPhaseSemanticReview({ catalogFile, stateFile,
    responseFile: path.join(evidenceDirectory, 'model.stdout.txt'),
    preflightReceiptFile: path.join(evidenceDirectory, 'controller-preflight-receipt.json'),
    semanticReviewFile: path.join(evidenceDirectory, 'independent-semantic-review.json') });
  const preflight = JSON.parse(evidenceBytes.get('controller-preflight-receipt.json').toString('utf8'));
  const host = JSON.parse(evidenceBytes.get('host-runner/manifest.json').toString('utf8'));
  const hostReceipts = JSON.parse(evidenceBytes.get('phase-host-receipts.json').toString('utf8'));
  const originalHostReceipts = profiles.map((profile) => JSON.parse(
    evidenceBytes.get(`host-runner/${profile}/host-profile.receipt.json`).toString('utf8')));
  if (inspected.verdict !== 'PASS' || inspected.phaseAttemptId !== state.activeAttempt.attemptId
    || inspected.candidateArtifactDigest !== preflight.candidateArtifactDigest
    || host.caseId !== 'crud-complete' || host.phaseId !== 'backend' || host.sourceHead !== sourceCommit
    || host.completePatchSha256 !== preflight.cumulativePatchDigest || host.runnerExitCode !== 0
    || JSON.stringify(host.requestedProfiles) !== JSON.stringify(profiles)
    || JSON.stringify(host.completedProfiles) !== JSON.stringify(profiles)
    || profiles.some((profile) => host.receiptStatuses?.[profile] !== 'passed')
    || !Array.isArray(hostReceipts) || hostReceipts.length !== profiles.length
    || profiles.some((profile, index) => hostReceipts[index]?.profile !== profile
      || hostReceipts[index]?.status !== 'passed'
      || hostReceipts[index]?.receiptDigest !== sha256(evidenceBytes.get(
        `host-runner/${profile}/host-profile.receipt.json`))
      || hostReceipts[index]?.patchDigest !== preflight.cumulativePatchDigest
      || originalHostReceipts[index]?.receipt?.status !== 'passed'
      || originalHostReceipts[index]?.receipt?.source?.head !== sourceCommit
      || originalHostReceipts[index]?.receipt?.request?.profile !== profile
      || originalHostReceipts[index]?.receipt?.policy?.profileCatalogVersion !== state.catalogVersion
      || originalHostReceipts[index]?.receipt?.source?.workspaceFingerprint
        !== originalHostReceipts[0]?.receipt?.source?.workspaceFingerprint)) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Backend preflight, independent review or Host evidence does not authorize continuation.');
  }
  if (sha256(await boundedRegularFile(stateFile, MAX_RESPONSE_BYTES, 'retained backend state')) !== bindings.sourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Retained backend state changed during continuation admission.');
  }
  const control = path.join(outputDirectory, 'phase-control');
  const phase = path.join(outputDirectory, 'phases/05-backend/attempts/02');
  await writeExclusive(path.join(control, 'state.json'), stateBytes);
  for (const [kind, bytes] of artifactBytes) await writeExclusive(path.join(control, 'artifacts', `${kind}.json`), bytes);
  for (const [relative, bytes] of evidenceBytes) await writeExclusive(path.join(phase, relative), bytes);
  const finalized = await finalizeForgeDeliveryPhaseRun({ catalogFile, stateFile: path.join(control, 'state.json'),
    artifactsDirectory: path.join(control, 'artifacts'), originalRequestFile,
    responseFile: path.join(phase, 'model.stdout.txt'),
    allChangedPathsFile: path.join(phase, 'all-changed-paths.json'),
    phaseChangedPathsFile: path.join(phase, 'phase-changed-paths.json'),
    phasePatchFile: path.join(phase, 'phase.patch'), cumulativePatchFile: path.join(phase, 'cumulative.patch'),
    hostReceiptsFile: path.join(phase, 'phase-host-receipts.json'),
    outputDirectory: path.join(phase, 'controller'), nextPromptFile: path.join(control, 'current-prompt.md') });
  if (finalized.acceptedPhaseId !== 'backend' || finalized.acceptedPhaseIndex !== 4
    || finalized.phaseArtifactDigest !== preflight.candidateArtifactDigest
    || finalized.nextPhaseId !== 'frontend') {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Finalized backend did not advance only to frontend.');
  }
  const next = await readForgeDeliveryPhaseState(path.join(control, 'state.json'), catalog);
  const receipt = Object.freeze({ schemaVersion: 'forge-delivery-backend-finalize-continuation/v1',
    sourceStateSha256: bindings.sourceStateSha256, bindingsSha256: expectedBindingsSha256,
    sourceCommit, catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest,
    taskId: state.taskId, sessionId: state.sessionId,
    parentLastExecutionGeneration: state.lastExecutionGeneration,
    nextExecutionGenerationMinimum: state.lastExecutionGeneration + 1,
    inheritedArtifactDigests: Object.fromEntries(kinds.map((kind) => [kind, state.acceptedArtifacts[kind]])),
    backendArtifactDigest: finalized.phaseArtifactDigest,
    backendHostReceiptsSha256: bindings.evidenceSha256['phase-host-receipts.json'],
    cumulativePatchSha256: bindings.evidenceSha256['cumulative.patch'],
    stateDigest: next.stateDigest,
    promptSha256: sha256(await boundedRegularFile(path.join(control, 'current-prompt.md'), MAX_PROMPT_BYTES, 'frontend prompt')),
    inheritedStageCount: 4, finalizedBackendStageCount: 1, newModelStarted: false,
    parentStateUnchanged: true });
  await writeExclusive(path.join(control, 'backend-continuation-receipt.json'), jsonBytes(receipt));
  return receipt;
}

export async function prepareForgeAccessWiringContinuation({
  catalogFile, sourceCaseDirectory, bindingsFile, expectedBindingsSha256,
  sourceCommit, originalRequestFile, outputDirectory,
}) {
  requiredId(expectedBindingsSha256, SHA256_PATTERN, 'expectedBindingsSha256');
  requiredId(sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  if (![sourceCaseDirectory, outputDirectory].every((value) => typeof value === 'string' && path.isAbsolute(value))
    || realpathSync(sourceCaseDirectory) !== sourceCaseDirectory
    || outputDirectory === sourceCaseDirectory
    || outputDirectory.startsWith(`${sourceCaseDirectory}${path.sep}`)
    || sourceCaseDirectory.startsWith(`${outputDirectory}${path.sep}`)) {
    fail('PHASE_CONTROLLER_PATH_INVALID', 'Access wiring continuation requires a separate ordinary accepted case path.');
  }
  const bindingsBytes = await boundedRegularFile(bindingsFile, MAX_RESPONSE_BYTES,
    'reviewed access wiring continuation bindings', { trustedReview: true });
  if (sha256(bindingsBytes) !== expectedBindingsSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Reviewed access wiring continuation bindings changed.');
  }
  const bindings = JSON.parse(bindingsBytes.toString('utf8'));
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation', 'frontend-implementation'];
  const phaseNames = ['requirements', 'domain-contract', 'database', 'ui-design', 'backend', 'frontend'];
  const profiles = ['governance', 'frontend-admin-lint', 'frontend-admin-test',
    'frontend-admin-typecheck', 'frontend-admin-build'];
  const evidenceFiles = ['model.stdout.txt', 'controller-preflight-receipt.json',
    'independent-semantic-review.json', 'all-changed-paths.json', 'phase-changed-paths.json',
    'phase.patch', 'cumulative.patch', 'phase-host-receipts.json', 'controller-cli-receipt.json',
    ...profiles.map((profile) => `host-runner/${profile}/host-profile.receipt.json`)];
  exactKeys(bindings, ['schemaVersion', 'sourceStateSha256', 'originalRequestSha256',
    'artifactSha256', 'evidenceSha256', 'currentPromptSha256'], 'access wiring continuation bindings');
  exactKeys(bindings.artifactSha256, kinds, 'access wiring continuation accepted artifact hashes');
  exactKeys(bindings.evidenceSha256, evidenceFiles, 'access wiring continuation evidence hashes');
  if (bindings.schemaVersion !== 'forge-delivery-access-wiring-continuation-bindings/v1'
    || ![bindings.sourceStateSha256, bindings.originalRequestSha256, bindings.currentPromptSha256,
      ...Object.values(bindings.artifactSha256), ...Object.values(bindings.evidenceSha256)]
      .every((digest) => SHA256_PATTERN.test(digest))) {
    fail('PHASE_CONTROLLER_INPUT_INVALID', 'Access wiring continuation hashes are invalid.');
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  const stateFile = path.join(sourceCaseDirectory, 'phase-control/state.json');
  const stateBytes = await boundedRegularFile(stateFile, MAX_RESPONSE_BYTES, 'accepted frontend state');
  if (sha256(stateBytes) !== bindings.sourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Accepted frontend state differs from reviewed bytes.');
  }
  const state = validateForgeDeliveryPhaseState(JSON.parse(stateBytes.toString('utf8')), catalog);
  const accepted = await loadAcceptedArtifacts({ state, catalog,
    artifactsDirectory: path.join(sourceCaseDirectory, 'phase-control/artifacts') });
  const acceptedHistory = state.history.filter((entry) => entry.decision === 'accepted');
  const frontendAcceptance = state.history.at(-1);
  if (state.schemaVersion !== 'forge-delivery-phase-state/v2' || state.sourceCommit !== sourceCommit
    || state.caseFamily !== 'crud-complete' || state.status !== 'active'
    || state.currentPhaseId !== 'access-wiring' || state.currentPhaseIndex !== 6
    || state.activeAttempt !== null || state.lastExecutionGeneration !== 12
    || accepted.length !== 6 || acceptedHistory.length !== 6
    || acceptedHistory.some((entry, index) => entry.phaseIndex !== index
      || entry.phaseId !== phaseNames[index] || entry.artifactDigest !== state.acceptedArtifacts[kinds[index]])
    || frontendAcceptance?.phaseId !== 'frontend' || frontendAcceptance?.phaseIndex !== 5
    || frontendAcceptance?.decision !== 'accepted' || frontendAcceptance?.executionGeneration !== 12
    || frontendAcceptance.artifactDigest !== state.acceptedArtifacts['frontend-implementation']) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only six genuinely accepted phases immediately before access wiring can continue.');
  }
  const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
  const promptFile = path.join(sourceCaseDirectory, 'phase-control/current-prompt.md');
  const promptBytes = await boundedRegularFile(promptFile, MAX_PROMPT_BYTES, 'Controller-generated access wiring prompt');
  if (sha256(requestBytes) !== bindings.originalRequestSha256
    || sha256(promptBytes) !== bindings.currentPromptSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Original request or next prompt differs from reviewed bytes.');
  }
  const artifactBytes = new Map();
  for (const kind of kinds) {
    const bytes = await boundedRegularFile(path.join(sourceCaseDirectory, 'phase-control/artifacts', `${kind}.json`),
      MAX_RESPONSE_BYTES, `accepted ${kind}`);
    if (sha256(bytes) !== bindings.artifactSha256[kind]) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', `Accepted ${kind} differs from reviewed bytes.`);
    }
    artifactBytes.set(kind, bytes);
  }
  const evidenceDirectory = path.join(sourceCaseDirectory, 'candidate-lint-fixed');
  const evidenceBytes = new Map();
  for (const relative of evidenceFiles) {
    const bytes = await boundedRegularFile(path.join(evidenceDirectory, relative),
      relative.endsWith('.patch') ? MAX_PATCH_BYTES : MAX_RESPONSE_BYTES,
      `accepted frontend ${relative}`, { trustedReview: relative === 'independent-semantic-review.json' });
    if (sha256(bytes) !== bindings.evidenceSha256[relative]) {
      fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', `Accepted frontend ${relative} differs from reviewed bytes.`);
    }
    evidenceBytes.set(relative, bytes);
  }
  const preflight = JSON.parse(evidenceBytes.get('controller-preflight-receipt.json').toString('utf8'));
  const review = JSON.parse(evidenceBytes.get('independent-semantic-review.json').toString('utf8'));
  const finalized = JSON.parse(evidenceBytes.get('controller-cli-receipt.json').toString('utf8'));
  const hostReceipts = JSON.parse(evidenceBytes.get('phase-host-receipts.json').toString('utf8'));
  const originalHostReceipts = profiles.map((profile) => JSON.parse(
    evidenceBytes.get(`host-runner/${profile}/host-profile.receipt.json`).toString('utf8')));
  if (preflight.phaseId !== 'frontend' || preflight.phaseIndex !== 5
    || preflight.phaseAttemptId !== frontendAcceptance.attemptId
    || preflight.candidateArtifactDigest !== frontendAcceptance.artifactDigest
    || preflight.phasePatchDigest !== sha256(evidenceBytes.get('phase.patch'))
    || preflight.cumulativePatchDigest !== sha256(evidenceBytes.get('cumulative.patch'))
    || JSON.stringify(preflight.changedPaths)
      !== JSON.stringify(normalizedChangedPaths(JSON.parse(evidenceBytes.get('phase-changed-paths.json').toString('utf8'))))
    || review.verdict !== 'PASS' || review.subject?.phaseId !== 'frontend'
    || review.subject?.responseSha256 !== bindings.evidenceSha256['model.stdout.txt']
    || review.subject?.candidateArtifactDigest !== frontendAcceptance.artifactDigest
    || finalized.schemaVersion !== 'forge-delivery-phase-controller-finalize/v1'
    || finalized.acceptedPhaseId !== 'frontend' || finalized.acceptedPhaseIndex !== 5
    || finalized.phaseArtifactDigest !== frontendAcceptance.artifactDigest
    || finalized.phasePatchDigest !== frontendAcceptance.patchDigest
    || finalized.cumulativePatchDigest !== preflight.cumulativePatchDigest
    || finalized.stateDigest !== state.stateDigest || finalized.nextPhaseId !== 'access-wiring'
    || finalized.nextPromptDigest !== sha256(Buffer.from(promptBytes.toString('utf8').replace(/\n$/u, ''), 'utf8'))
    || !Array.isArray(hostReceipts) || hostReceipts.length !== profiles.length
    || JSON.stringify(preflight.hostVerificationProfiles) !== JSON.stringify(profiles)
    || profiles.some((profile, index) => hostReceipts[index]?.profile !== profile
      || hostReceipts[index]?.status !== 'passed'
      || hostReceipts[index]?.receiptDigest !== sha256(evidenceBytes.get(`host-runner/${profile}/host-profile.receipt.json`))
      || hostReceipts[index]?.patchDigest !== preflight.cumulativePatchDigest
      || frontendAcceptance.hostReceiptDigests[index] !== hostReceipts[index]?.receiptDigest
      || originalHostReceipts[index]?.receipt?.status !== 'passed'
      || originalHostReceipts[index]?.receipt?.source?.head !== sourceCommit
      || originalHostReceipts[index]?.receipt?.request?.profile !== profile
      || originalHostReceipts[index]?.receipt?.policy?.profileCatalogVersion !== state.catalogVersion
      || originalHostReceipts[index]?.receipt?.source?.workspaceFingerprint
        !== originalHostReceipts[0]?.receipt?.source?.workspaceFingerprint)) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Accepted frontend review, Host or finalize evidence does not authorize continuation.');
  }
  if (sha256(await boundedRegularFile(stateFile, MAX_RESPONSE_BYTES, 'accepted frontend state')) !== bindings.sourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Accepted frontend state changed during continuation admission.');
  }
  const control = path.join(outputDirectory, 'phase-control');
  await writeExclusive(path.join(control, 'state.json'), stateBytes);
  await writeExclusive(path.join(control, 'current-prompt.md'), promptBytes);
  for (const [kind, bytes] of artifactBytes) await writeExclusive(path.join(control, 'artifacts', `${kind}.json`), bytes);
  const receipt = Object.freeze({ schemaVersion: 'forge-delivery-access-wiring-continuation/v1',
    sourceStateSha256: bindings.sourceStateSha256, bindingsSha256: expectedBindingsSha256,
    sourceCommit, catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest,
    taskId: state.taskId, sessionId: state.sessionId,
    parentLastExecutionGeneration: state.lastExecutionGeneration,
    nextExecutionGenerationMinimum: state.lastExecutionGeneration + 1,
    inheritedArtifactDigests: Object.fromEntries(kinds.map((kind) => [kind, state.acceptedArtifacts[kind]])),
    stateDigest: state.stateDigest, promptSha256: bindings.currentPromptSha256,
    cumulativePatchSha256: bindings.evidenceSha256['cumulative.patch'],
    inheritedStageCount: 6, newAcceptedStageCount: 0, newModelStarted: false,
    parentStateUnchanged: true });
  await writeExclusive(path.join(control, 'access-wiring-continuation-receipt.json'), jsonBytes(receipt));
  return receipt;
}

export async function readPreparedForgeCrossLayerRuntimeEvidence({ stateFile, state, promptText }) {
  const directory = path.dirname(stateFile);
  let receipt;
  let bytes;
  try {
    receipt = await readJsonFile(path.join(directory, 'runtime-input-receipt.json'), MAX_RESPONSE_BYTES,
      'Controller runtime input receipt', { trustedReview: true });
    bytes = await boundedRegularFile(path.join(directory, 'runtime-evidence.json'), MAX_RESPONSE_BYTES,
      'Controller runtime evidence', { trustedReview: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fail('CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED', 'Deployment, API, browser and database evidence must be prepared before the cross-layer model starts.');
  }
  const bundle = JSON.parse(bytes.toString('utf8'));
  const subject = bundle.subject;
  const reprobe = await readForgeCrossLayerRuntimeReprobe({ stateFile, state });
  const importingObservation = reprobe?.status === 'imported' && state.stateDigest === reprobe.stateDigest;
  const promptDigest = promptText === undefined ? state.activeAttempt?.promptDigest
    : digestDirectUserTextContent([{ type: 'text', text: promptText.replace(/(?:\r?\n)+$/u, '') }]);
  if (receipt.schemaVersion !== 'forge-cross-layer-runtime-input-receipt/v1'
    || state.status !== 'active' || state.currentPhaseId !== 'cross-layer-acceptance'
    || state.currentPhaseIndex !== 7 || receipt.bundleSha256 !== sha256(bytes)
    || receipt.manifestSha256 !== bundle.manifestSha256
    || subject?.workflowId !== state.workflowId || subject?.taskId !== state.taskId
    || receipt.sessionId !== state.sessionId || subject?.baseSourceCommit !== state.sourceCommit
    || subject?.catalogVersion !== state.catalogVersion || subject?.catalogDigest !== state.catalogDigest
    || subject?.stateDigest !== receipt.sourceStateDigest
    || canonicalStringify(receipt.acceptedArtifacts) !== canonicalStringify(state.acceptedArtifacts)
    || (state.activeAttempt === null && receipt.sourceStateDigest !== state.stateDigest)
    || (state.activeAttempt !== null && state.activeAttempt.executionGeneration <= receipt.lastExecutionGeneration && !importingObservation)
    || promptDigest !== receipt.promptDigest) {
    fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Runtime input, phase state or executed prompt differs from the prepared evidence.');
  }
  return bundle;
}

function browserPhaseAuthority(state, phase) {
  return Object.freeze({
    workflowId: state.workflowId,
    phaseId: phase.id,
    phaseIndex: phase.index,
    catalogVersion: state.catalogVersion,
    catalogDigest: state.catalogDigest,
    actionCeiling: phase.actionCeiling,
    ownedPaths: Object.freeze([...phase.ownedPaths]),
    taskProfiles: Object.freeze([...phase.taskProfiles]),
    requiredProfiles: Object.freeze([...phase.contractVerificationProfiles]),
  });
}

function idleBrowserStateProjection(state, catalog) {
  if (state.activeAttempt === null) return state;
  const previous = state.history.at(-1);
  const projection = JSON.parse(JSON.stringify(state));
  projection.activeAttempt = null;
  projection.lastExecutionGeneration = previous?.executionGeneration ?? 0;
  projection.revision -= 1;
  projection.updatedAt = previous?.completedAt ?? previous?.failedAt ?? state.createdAt;
  projection.stateDigest = '';
  const { stateDigest: _ignored, ...unsigned } = projection;
  projection.stateDigest = sha256(Buffer.from(canonicalStringify(unsigned), 'utf8'));
  return validateForgeDeliveryPhaseState(projection, catalog);
}

async function inspectForgeDeliveryBrowserPhase({
  stateFile,
  state,
  catalog,
  artifactsDirectory,
  originalRequestFile,
  promptFile,
  sourceCommit,
  taskId,
  sessionId,
  rpcId,
  promptText,
}) {
  requiredId(sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  requiredId(taskId, ID_PATTERN, 'taskId');
  requiredId(sessionId, /^[^\0\r\n]{1,1024}$/u, 'sessionId');
  requiredId(rpcId, /^[^\0\r\n]{1,256}$/u, 'rpcId');
  const phase = currentPhase(state, catalog);
  const reprobe = await readForgeCrossLayerRuntimeReprobe({ stateFile, state });
  const importedReprobe = reprobe?.status === 'imported' ? reprobe : null;
  const awaitingReprobe = importedReprobe !== null && state.stateDigest === importedReprobe.stateDigest;
  const promptState = importedReprobe === null ? idleBrowserStateProjection(state, catalog)
    : validateForgeDeliveryPhaseState(await readJsonFile(path.join(importedReprobe.archiveDirectory, 'state.json'), MAX_RESPONSE_BYTES, 'runtime observation state'), catalog);
  if (state.status !== 'active'
    || (state.activeAttempt !== null && state.activeAttempt.rpcId !== rpcId && !awaitingReprobe)) {
    fail('PHASE_CONTROLLER_BROWSER_PREPARE_DENIED', 'Only the current idle phase or its exact active browser RPC can be prepared.');
  }
  if (state.taskId !== taskId || state.sessionId !== sessionId) {
    fail('PHASE_CONTROLLER_BROWSER_IDENTITY_MISMATCH', 'Browser phase identity differs from the Controller state.');
  }
  const [requestBytes, promptBytes, acceptedArtifacts] = await Promise.all([
    boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request'),
    boundedRegularFile(promptFile, MAX_PROMPT_BYTES, 'current phase prompt'),
    loadAcceptedArtifacts({ state: promptState, catalog, artifactsDirectory }),
  ]);
  const request = requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  const storedPrompt = promptBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  if (storedPrompt.length === 0 || Buffer.byteLength(storedPrompt, 'utf8') > MAX_PROMPT_BYTES) {
    fail('PHASE_CONTROLLER_BROWSER_PROMPT_MISMATCH', 'Current phase prompt is empty or oversized.');
  }
  if (promptText !== undefined) {
    if (typeof promptText !== 'string' || promptText.includes('\0')
      || Buffer.byteLength(promptText, 'utf8') > MAX_PROMPT_BYTES
      || promptText.replace(/(?:\r?\n)+$/u, '') !== storedPrompt) {
      fail('PHASE_CONTROLLER_BROWSER_PROMPT_MISMATCH', 'Browser prompt differs from the Controller prompt.');
    }
  }
  const protectedPromptDigest = digestDirectUserTextContent([{ type: 'text', text: storedPrompt }]);
  if (state.activeAttempt !== null && state.activeAttempt.promptDigest !== protectedPromptDigest && !awaitingReprobe) {
    fail('PHASE_CONTROLLER_BROWSER_PROMPT_MISMATCH', 'Active browser attempt is bound to another prompt.');
  }
  const upstreamArtifacts = requiredUpstreamArtifacts(acceptedArtifacts, phase);
  const rejection = state.history.at(-1);
  let runtimeEvidence = null;
  if ((rejection?.decision === 'rejected' || rejection?.schemaVersion === READONLY_ROLE_RECOVERY_SCHEMA)
    && rejection.phaseId === phase.id) {
    if (phase.id === 'cross-layer-acceptance') {
      fail('PHASE_CONTROLLER_BROWSER_PREPARE_DENIED', 'Cross-layer browser retry is not supported by the current runtime-evidence prompt contract.');
    }
    const retryReceipt = await readJsonFile(
      forgeDeliveryPhaseRetryPromptReceiptPath(promptFile, rejection.attemptId),
      MAX_RESPONSE_BYTES,
      'Controller retry prompt receipt',
    );
    validateForgeDeliveryPhaseRetryPromptReceipt({
      receipt: retryReceipt,
      state: promptState,
      catalog,
      promptDigest: sha256(Buffer.from(storedPrompt, 'utf8')),
    });
    if (retryReceipt.originalRequestSha256 !== sha256(requestBytes)) {
      fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Retry prompt receipt belongs to another original request.');
    }
    if (retryReceipt.schemaVersion === BACKEND_UNFINISHED_RETRY_SCHEMA) {
      const directory = path.join(path.dirname(stateFile), 'browser-attempts', retryReceipt.executionId);
      const evidenceBytes = await boundedRegularFile(path.join(directory, '后端阶段-失败续修证据.json'), MAX_RESPONSE_BYTES, 'backend failure evidence');
      const feedbackBytes = await boundedRegularFile(path.join(directory, '后端阶段-失败续修反馈.txt'), MAX_PROMPT_BYTES, 'backend feedback');
      if (sha256(evidenceBytes) !== retryReceipt.failureEvidenceSha256 || sha256(feedbackBytes) !== retryReceipt.feedbackSha256) {
        fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Backend retry inputs changed.');
      }
      const evidence = JSON.parse(evidenceBytes.toString('utf8'));
      if (evidence.attemptId !== rejection.attemptId || evidence.executionGeneration !== rejection.executionGeneration
        || evidence.executionId !== retryReceipt.executionId || evidence.sourceCommit !== state.sourceCommit
        || canonicalStringify(evidence.acceptedArtifacts) !== canonicalStringify(state.acceptedArtifacts)) {
        fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Backend retry belongs to another failed candidate.');
      }
      for (const [name, digest] of Object.entries(evidence.retainedFiles)) {
        if (path.basename(name) !== name || sha256(await boundedRegularFile(path.join(directory, name), MAX_RESPONSE_BYTES, name)) !== digest) {
          fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Retained backend failure changed.');
        }
      }
      const expectedPrompt = buildForgeDeliveryPhasePrompt({ state: promptState, catalog,
        originalRequest: `${request}\n\n${feedbackBytes.toString('utf8')}`, upstreamArtifacts });
      if (storedPrompt !== expectedPrompt) fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Backend retry prompt is not derived from retained feedback.');
    } else if (retryReceipt.schemaVersion === REQUIREMENTS_OVERLOAD_RETRY_SCHEMA) {
      const directory = path.join(path.dirname(stateFile), 'browser-attempts', retryReceipt.executionId);
      const retained = {};
      for (const [key, name] of Object.entries({ executionSha256: 'execution.json', baselineSha256: 'session-baseline.json',
        beginSha256: 'begin.json', providerFailureProofSha256: '需求阶段-供应方临时故障证明.json' })) {
        const bytes = await boundedRegularFile(path.join(directory, name), MAX_RESPONSE_BYTES, name);
        if (sha256(bytes) !== retryReceipt[key]) fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Provider overload evidence changed.');
        retained[key] = JSON.parse(bytes.toString('utf8'));
      }
      validateForgeRequirementsOverloadEvidence({ state: promptState, execution: retained.executionSha256,
        baseline: retained.baselineSha256, begin: retained.beginSha256, proof: retained.providerFailureProofSha256,
        attempt: retained.beginSha256.attempt });
      const expectedPrompt = buildForgeDeliveryPhasePrompt({ state: promptState, catalog, originalRequest: request, upstreamArtifacts });
      if (retained.beginSha256.attempt.attemptId !== rejection.attemptId
        || retained.beginSha256.attempt.executionGeneration !== rejection.executionGeneration
        || protectedPromptDigest !== retained.beginSha256.attempt.promptDigest || storedPrompt !== expectedPrompt) {
        fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Provider overload retry must retain the original Controller prompt.');
      }
    } else if (retryReceipt.schemaVersion === READONLY_ROLE_RETRY_SCHEMA) {
      const directory = path.join(path.dirname(stateFile), 'browser-attempts', retryReceipt.executionId);
      const retained = {};
      for (const [key, name] of Object.entries({ executionSha256: 'execution.json', baselineSha256: 'session-baseline.json',
        beginSha256: 'begin.json', sessionProofSha256: '会话终态证明.json', denialProofSha256: '前端阶段-只读误拒证明.json',
        feedbackSha256: '前端阶段-平台故障续修说明.txt' })) {
        const bytes = await boundedRegularFile(path.join(directory, name), MAX_RESPONSE_BYTES, name);
        if (sha256(bytes) !== retryReceipt[key]) fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Readonly-role retry evidence changed.');
        retained[key] = key === 'feedbackSha256' ? bytes.toString('utf8') : JSON.parse(bytes.toString('utf8'));
      }
      const previous = (await boundedRegularFile(path.join(directory, '前端阶段-误拒前提示原文.md'),
        MAX_PROMPT_BYTES, 'retained readonly-role prompt')).toString('utf8').replace(/(?:\r?\n)+$/u, '');
      validateForgeFrontendReadonlyRoleEvidence({ state: promptState, execution: retained.executionSha256,
        baseline: retained.baselineSha256, begin: retained.beginSha256, sessionProof: retained.sessionProofSha256,
        proof: retained.denialProofSha256, promptText: previous, attempt: retained.beginSha256.attempt });
      const expectedPrompt = buildForgeDeliveryPhasePrompt({ state: promptState, catalog,
        originalRequest: `${request}\n\n${retained.feedbackSha256}`, upstreamArtifacts });
      if (sha256(Buffer.from(previous, 'utf8')) !== retryReceipt.previousPromptDigest
        || retained.beginSha256.attempt.attemptId !== rejection.attemptId
        || retained.beginSha256.attempt.executionGeneration !== rejection.executionGeneration || storedPrompt !== expectedPrompt) {
        fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Readonly-role retry prompt does not match its retained inputs.');
      }
    } else if (retryReceipt.schemaVersion === ACCESS_SCOPE_RETRY_SCHEMA) {
      const directory = path.join(path.dirname(stateFile), 'browser-attempts', retryReceipt.executionId);
      const retained = {};
      for (const [key, name] of Object.entries({ executionSha256: 'execution.json', baselineSha256: 'session-baseline.json',
        beginSha256: 'begin.json', sessionProofSha256: '会话终态证明.json', denialProofSha256: '权限阶段-范围误拒证明.json', feedbackSha256: '权限阶段-范围续修说明.txt' })) {
        const bytes = await boundedRegularFile(path.join(directory, name), MAX_RESPONSE_BYTES, name);
        if (sha256(bytes) !== retryReceipt[key]) fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Access-scope retry evidence changed.');
        retained[key] = key === 'feedbackSha256' ? bytes.toString('utf8') : JSON.parse(bytes.toString('utf8'));
      }
      const previous = (await boundedRegularFile(path.join(directory, '权限阶段-误拒前提示原文.md'),
        MAX_PROMPT_BYTES, 'retained interrupted prompt')).toString('utf8').replace(/(?:\r?\n)+$/u, '');
      validateForgeAccessScopeDeniedEvidence({ state: promptState, execution: retained.executionSha256,
        baseline: retained.baselineSha256, begin: retained.beginSha256,
        sessionProof: retained.sessionProofSha256, proof: retained.denialProofSha256, catalog, attempt: retained.beginSha256.attempt });
      const expectedPrompt = buildForgeDeliveryPhasePrompt({ state: promptState, catalog,
        originalRequest: `${request}\n\n${retained.feedbackSha256}`, upstreamArtifacts });
      if (retryReceipt.zeroDeltaFingerprint !== retained.executionSha256.workspaceFingerprint
        || sha256(Buffer.from(previous, 'utf8')) !== retryReceipt.previousPromptDigest
        || retained.beginSha256.attempt.attemptId !== rejection.attemptId
        || retained.beginSha256.attempt.executionGeneration !== rejection.executionGeneration
        || digestDirectUserTextContent([{ type: 'text', text: previous }]) !== retained.beginSha256.attempt.promptDigest
        || storedPrompt !== expectedPrompt) {
        fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'Access-scope retry prompt does not match its retained inputs.');
      }    } else if (retryReceipt.schemaVersion === USER_ABORT_RETRY_SCHEMA) {
      const directory = path.join(path.dirname(stateFile), 'browser-attempts', retryReceipt.executionId);
      const retained = {};
      for (const [key, name] of Object.entries({ executionSha256: 'execution.json', baselineSha256: 'session-baseline.json',
        beginSha256: 'begin.json', interruptionProofSha256: '会话中止证明.json', feedbackSha256: '前端阶段-重试补充说明.txt' })) {
        const bytes = await boundedRegularFile(path.join(directory, name), MAX_RESPONSE_BYTES, name);
        if (sha256(bytes) !== retryReceipt[key]) fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'User-abort retry evidence changed.');
        retained[key] = key === 'feedbackSha256' ? bytes.toString('utf8') : JSON.parse(bytes.toString('utf8'));
      }
      const previous = (await boundedRegularFile(path.join(directory, '前端阶段-中止前提示原文.md'),
        MAX_PROMPT_BYTES, 'retained interrupted prompt')).toString('utf8').replace(/(?:\r?\n)+$/u, '');
      validateForgeFrontendUserAbortedEvidence({ state: promptState, execution: retained.executionSha256,
        baseline: retained.baselineSha256, begin: retained.beginSha256,
        proof: retained.interruptionProofSha256, attempt: retained.beginSha256.attempt });
      const expectedPrompt = buildForgeDeliveryPhasePrompt({ state: promptState, catalog,
        originalRequest: `${request}\n\n${retained.feedbackSha256}`, upstreamArtifacts });
      if (sha256(Buffer.from(previous, 'utf8')) !== retryReceipt.previousPromptDigest
        || retained.beginSha256.attempt.attemptId !== rejection.attemptId
        || retained.beginSha256.attempt.executionGeneration !== rejection.executionGeneration
        || digestDirectUserTextContent([{ type: 'text', text: previous }]) !== retained.beginSha256.attempt.promptDigest
        || storedPrompt !== expectedPrompt) {
        fail('PHASE_CONTROLLER_RETRY_RECEIPT_INVALID', 'User-abort retry prompt does not match its retained inputs.');
      }
    }
  } else {
    runtimeEvidence = phase.id === 'cross-layer-acceptance'
      ? await readPreparedForgeCrossLayerRuntimeEvidence({ stateFile, state, promptText: storedPrompt })
      : null;
    if (runtimeEvidence !== null && runtimeEvidence.subject?.stateDigest !== promptState.stateDigest) {
      fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Runtime input belongs to another idle Controller state.');
    }
    const correction = ['access-wiring', 'backend'].includes(phase.id) ? currentForgeAccessAcceptedCorrection(promptState) : null;
    const correctionText = correction === null ? null : await boundedRegularFile(
      path.join(path.dirname(stateFile), accessAcceptedCorrectionEvidenceName(promptState, correction, '权限接线阶段-后验纠正请求.txt')),
      MAX_PROMPT_BYTES, 'accepted access correction request');
    if (correction !== null && sha256(correctionText) !== correction.repairRequestSha256) {
      fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Accepted correction feedback changed.');
    }
    const expectedPrompt = buildForgeDeliveryPhasePrompt({
      state: promptState,
      catalog,
      originalRequest: correctionText === null ? request : `${request}\n\n${correctionText.toString('utf8')}`.replace(/(?:\r?\n)+$/u, ''),
      upstreamArtifacts,
      runtimeEvidence,
      runtimeObservationContinuation: importedReprobe !== null,
    });
    if (storedPrompt !== expectedPrompt) {
      fail('PHASE_CONTROLLER_BROWSER_PROMPT_MISMATCH', 'Current prompt was not generated from the bound Controller state.');
    }
  }
  const runtimeInput = runtimeEvidence === null ? null
    : await readJsonFile(path.join(path.dirname(stateFile), 'runtime-input-receipt.json'), MAX_RESPONSE_BYTES, 'runtime preparation receipt', { trustedReview: true });
  const preparationBinding = runtimeInput?.preparationBinding;
  if (preparationBinding !== undefined && (preparationBinding.stateDigest !== runtimeInput.sourceStateDigest
    || preparationBinding.baseSourceCommit !== state.sourceCommit || !SHA256_PATTERN.test(preparationBinding.workspaceFingerprint ?? '')
    || canonicalStringify(preparationBinding.acceptedArtifactDigests) !== canonicalStringify(state.acceptedArtifacts))) {
    fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Prepared candidate no longer matches the accepted live source.');
  }
  const executionSourceCommit = preparationBinding?.baseSourceCommit ?? runtimeEvidence?.runtimeSource?.commit ?? state.sourceCommit;
  if (!SOURCE_COMMIT_PATTERN.test(executionSourceCommit) || sourceCommit !== executionSourceCommit) {
    fail('PHASE_CONTROLLER_BROWSER_IDENTITY_MISMATCH', 'Observed execution source differs from the Controller phase input.');
  }
  return Object.freeze({
    schemaVersion: 'forge-delivery-browser-phase-prepare/v1',
    workflowId: state.workflowId,
    phaseId: phase.id,
    phaseIndex: phase.index,
    stateDigest: state.stateDigest,
    sourceCommit: state.sourceCommit,
    executionSourceCommit,
    ...(preparationBinding === undefined ? {} : { runtimeWorkspaceFingerprint: preparationBinding.workspaceFingerprint }),
    caseFamily: state.caseFamily,
    catalogVersion: state.catalogVersion,
    catalogDigest: state.catalogDigest,
    taskId: state.taskId,
    sessionId: state.sessionId,
    rpcId,
    promptDigest: protectedPromptDigest,
    promptFileSha256: sha256(promptBytes),
    promptText: storedPrompt,
    acceptedArtifactDigests: Object.freeze({ ...state.acceptedArtifacts }),
    ...(projectForgeAcceptedApiContract({ state, acceptedArtifacts }) === undefined ? {}
      : { acceptedApiContract: projectForgeAcceptedApiContract({ state, acceptedArtifacts }) }),
    phaseAuthority: browserPhaseAuthority(state, phase),
    idempotent: state.activeAttempt !== null && !awaitingReprobe,
    activeExecutionGeneration: state.activeAttempt?.executionGeneration ?? null,
  });
}

async function sameExecutionRuntimeObservation({ stateFile, state, reprobe, preparationExecution, promptFile }) {
  if (reprobe?.status !== 'imported' || preparationExecution === undefined) return false;
  const execution = validateProtectedExecutionContext(preparationExecution);
  const binding = execution.preparationBinding;
  if (execution.crossLayerPreparation !== true || execution.authorityClass !== 'production-read-only' || execution.testOnly
    || execution.workflowId !== 'crud-production' || execution.phaseId !== 'cross-layer-acceptance' || execution.phaseIndex !== 7
    || execution.actionCeiling !== 'read-only' || execution.ownedPaths.length !== 0
    || execution.taskId !== state.taskId || execution.dshSessionId !== state.sessionId
    || execution.generation <= reprobe.previousExecutionGeneration || state.stateDigest !== reprobe.stateDigest
    || binding?.stateDigest !== state.stateDigest || binding.baseSourceCommit !== state.sourceCommit
    || binding.workspaceFingerprint !== reprobe.workspaceFingerprint
    || canonicalStringify(binding.acceptedArtifactDigests) !== canonicalStringify(state.acceptedArtifacts)) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Sequential observations require the same protected preparation execution.');
  }
  const promptBytes = await boundedRegularFile(promptFile, MAX_PROMPT_BYTES, 'prepared runtime prompt', { trustedReview: true });
  if (sha256(promptBytes) !== reprobe.replacementSha256?.['current-prompt.md']) fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Prepared runtime prompt changed.');
  const bundle = await readPreparedForgeCrossLayerRuntimeEvidence({ stateFile, state, promptText: promptBytes.toString('utf8') });
  if (bundle.manifestSha256 !== reprobe.replacementManifestSha256
    || bundle.runtimeSource.commit !== reprobe.candidateCommit || bundle.runtimeSource.tree !== reprobe.candidateTree
    || bundle.subject.cumulativePatchSha256 !== reprobe.acceptedPatchSha256
    || bundle.evidence.deployment.status !== 'success' || bundle.evidence.deployment.startup?.migrationValidated !== true
    || bundle.evidence.deployment.startup?.applicationStarted !== true
    || !['api', 'database'].some(kind => ['failed', 'blocked'].includes(bundle.evidence[kind].status))
    || ['deployment', 'api', 'database', 'browser'].some(kind => bundle.evidence[kind].executionId !== execution.executionId
      || bundle.evidence[kind].observationId !== reprobe.replacementObservationId)) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only this execution latest failed or blocked observation may be supplemented.');
  }
  return true;
}

export async function prepareForgeCrossLayerPreparation({ catalogFile, stateFile, artifactsDirectory,
  workspace, sourceCommit, workspaceFingerprint, taskId, sessionId, rpcId, promptText, preparationExecution, promptFile }) {
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    if (state.status === 'completed') {
      // Observe a currently published repair against the retained API contract.
      // The producer separately requires the exact current published candidate;
      // this readonly projection never accepts new source or changes phase state.
      const acceptedApiContract = await readForgeCompletedApiContractProjection({ catalogFile, stateFile, artifactsDirectory,
        workspace, taskId, sessionId, sourceCommit, workspaceFingerprint, publishedRuntimeObservation: true });
      const phase = currentPhase(state, catalog);
      const acceptedArtifactDigests = { ...state.acceptedArtifacts };
      delete acceptedArtifactDigests['cross-layer-acceptance'];
      return Object.freeze({ workflowId: state.workflowId, phaseId: phase.id, phaseIndex: 7,
        sourceCommit, executionSourceCommit: sourceCommit, caseFamily: state.caseFamily,
        taskId, sessionId, rpcId, phaseAuthority: browserPhaseAuthority(state, phase), crossLayerPreparation: true,
        ...(acceptedApiContract === undefined ? {} : { acceptedApiContract }),
        preparationBinding: { stateDigest: state.stateDigest, acceptedArtifactDigests,
          baseSourceCommit: sourceCommit, workspaceFingerprint },
        promptText: `${promptText}\n\n当前为已完成任务的同源运行补验，八阶段完成状态和原发布证据保持。先运行 forge-release contract，读取实际 runtimeProbeCapabilities 和获准身份 aliases，由你依据已接受 API/数据库合同制定结构化计划，再用 forge-release prepare --expected-head ${sourceCommit} --expected-fingerprint ${workspaceFingerprint} --plan-base64 <base64url JSON> 复用当前可信已发布候选。不得修改源码、重建候选、执行迁移、checkpoint、integrate 或再次发布。只使用合同公开的身份 aliases，不读取或输出认证秘密，不执行任意 SQL、shell 或外部 URL。补验证据独立保存，保留失败观察并如实报告实际结果与未覆盖项，不重新接受阶段或覆盖原运行证据；浏览器仍为 owner-excluded。`,
      });
    }
    const reprobe = await readForgeCrossLayerRuntimeReprobe({ stateFile, state });
    const sequential = await sameExecutionRuntimeObservation({ stateFile, state, reprobe, preparationExecution, promptFile });
    if (state.workflowId !== 'crud-production' || state.currentPhaseId !== 'cross-layer-acceptance'
      || state.currentPhaseIndex !== 7 || state.status !== 'active' || (state.activeAttempt !== null && reprobe?.status !== 'pending' && !sequential)
      || state.taskId !== taskId || state.sessionId !== sessionId || state.sourceCommit !== sourceCommit
      || !SHA256_PATTERN.test(workspaceFingerprint ?? '') || Object.keys(state.acceptedArtifacts).length !== 7) {
      fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only the current accepted source may enter readonly cross-layer preparation.');
    }
    await loadAcceptedArtifacts({ state, catalog, artifactsDirectory });
    if (reprobe !== null && reprobe.status !== 'pending' && !sequential) fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'The replacement observation already awaits formal review.');
    if (reprobe === null && await lstat(path.join(path.dirname(stateFile), 'runtime-input-receipt.json')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))) {
      fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Imported runtime evidence requires a bound failed-observation recheck.');
    }
    const phase = currentPhase(state, catalog);
    return Object.freeze({ workflowId: state.workflowId, phaseId: phase.id, phaseIndex: 7,
      sourceCommit, executionSourceCommit: sourceCommit, caseFamily: state.caseFamily,
      taskId, sessionId, rpcId, phaseAuthority: browserPhaseAuthority(state, phase),
      crossLayerPreparation: true,
      preparationBinding: { stateDigest: state.stateDigest, acceptedArtifactDigests: { ...state.acceptedArtifacts },
        baseSourceCommit: sourceCommit, workspaceFingerprint },
      promptText: `${promptText}\n\n当前仅为跨层运行证据准备，七个已接受阶段保持，${state.activeAttempt === null ? '正式跨层 attempt 尚未开始' : '保留当前正式跨层 attempt，仅补充同候选运行观察'}。禁止源码修改、checkpoint、integrate 或正式发布。先运行 forge-release contract，读取实际返回的 result.runnerContract.runtimeProbeCapabilities 及同一受保护合同公开的身份 aliases；不要把外层包装的 schemaVersion 当作计划版本。依据该实时能力说明、已接受的 API/数据库范围和真实业务合同，自行制定结构化探测计划及必要认证，用 forge-release prepare --expected-head ${sourceCommit} --expected-fingerprint ${workspaceFingerprint} --plan-base64 <base64url JSON> 运行同一隔离测试候选。只使用合同公开且获准的身份 alias，不读取、输出或自行提交密码、token、cookie、密钥或任意认证 header。计划版本、方法、字段、引用和上限以实时能力为准，不接受任意 SQL、shell、外部 URL 或模型自授范围。保留原候选、已完成迁移及所有失败观察；同一受保护准备执行可以依据最新 failed/blocked 结果顺序补充观察，不重建、不重复迁移、不并发提交。浏览器仍为 owner-excluded；缺认证、空计划和未执行业务必须如实报告，启动或局部探测不代表阶段通过。完成后正常报告真实结果与缺口，再由原阶段入口核验。`,
    });
  });
}

export async function readForgeCrossLayerRuntimeReprobe({ stateFile, state }) {
  const directory = path.dirname(stateFile);
  let record;
  try { record = await readJsonFile(path.join(directory, 'runtime-reprobe.json'), MAX_RESPONSE_BYTES, 'runtime recheck', { trustedReview: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const current = await readJsonFile(stateFile, MAX_RESPONSE_BYTES, 'runtime recheck state');
  if (record.status === 'imported' && (current.status !== 'active' || current.currentPhaseId !== 'cross-layer-acceptance')) return null;
  const archiveDirectory = path.join(directory, 'runtime-rechecks', sha256(Buffer.from(record.rpcId ?? '')));
  if (record.schemaVersion !== 'forge-cross-layer-runtime-reprobe/v1' || !['pending', 'imported'].includes(record.status)
    || current.workflowId !== 'crud-production' || current.currentPhaseId !== 'cross-layer-acceptance'
    || current.currentPhaseIndex !== 7 || current.status !== 'active' || current.activeAttempt?.attemptId !== record.attemptId
    || (record.status === 'pending' && current.stateDigest !== record.stateDigest) || (state && state.stateDigest !== current.stateDigest)
    || current.taskId !== record.taskId || current.sessionId !== record.sessionId
    || current.sourceCommit !== record.baseSourceCommit
    || canonicalStringify(current.acceptedArtifacts) !== canonicalStringify(record.acceptedArtifactDigests)
    || record.archiveDirectory !== archiveDirectory || !SOURCE_COMMIT_PATTERN.test(record.candidateCommit ?? '')
    || !SOURCE_COMMIT_PATTERN.test(record.candidateTree ?? '')
    || ![record.previousStateDigest, record.previousManifestSha256, record.acceptedPatchSha256, record.workspaceFingerprint].every(value => SHA256_PATTERN.test(value ?? ''))) {
    fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Runtime recheck binding differs from the current accepted candidate.');
  }
  for (const name of ['state.json', 'runtime-evidence.json', 'runtime-input-receipt.json', 'current-prompt.md',
    ...(record.archivedSha256?.['runtime-reprobe.json'] === undefined ? [] : ['runtime-reprobe.json'])]) {
    const bytes = await boundedRegularFile(path.join(archiveDirectory, name), name.endsWith('.md') ? MAX_PROMPT_BYTES : MAX_RESPONSE_BYTES, name, { trustedReview: true });
    if (sha256(bytes) !== record.archivedSha256?.[name]) fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Archived failed observation changed.');
    if (record.status === 'pending' && ['runtime-evidence.json', 'runtime-input-receipt.json'].includes(name) && sha256(await boundedRegularFile(path.join(directory, name), MAX_RESPONSE_BYTES, name, { trustedReview: true })) !== record.archivedSha256[name]) {
      fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Failed observation changed before its replacement.');
    }
  }
  const original = await readJsonFile(path.join(archiveDirectory, 'state.json'), MAX_RESPONSE_BYTES, 'original runtime state');
  if (original.stateDigest !== record.stateDigest || original.activeAttempt?.attemptId !== record.attemptId
    || original.activeAttempt.executionGeneration !== record.previousExecutionGeneration) {
    fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Original runtime attempt changed.');
  }
  const projected = JSON.parse(JSON.stringify(original));
  if (current.stateDigest !== original.stateDigest) {
    if (record.status !== 'imported' || current.activeAttempt.executionGeneration <= original.lastExecutionGeneration) {
      fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Runtime observation continuation is stale.');
    }
    for (const key of ['rpcId', 'promptDigest', 'executionGeneration']) projected.activeAttempt[key] = current.activeAttempt[key];
    projected.lastExecutionGeneration = current.activeAttempt.executionGeneration;
    const { stateDigest: _ignored, ...unsigned } = projected;
    projected.stateDigest = sha256(Buffer.from(canonicalStringify(unsigned)));
  }
  if (canonicalStringify(projected) !== canonicalStringify(current)) fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Runtime recheck changed the original attempt or history.');
  if (record.status === 'imported') {
    for (const name of ['runtime-evidence.json', 'runtime-input-receipt.json']) {
      const bytes = await boundedRegularFile(path.join(directory, name), MAX_RESPONSE_BYTES, name, { trustedReview: true });
      if (sha256(bytes) !== record.replacementSha256?.[name]) fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Replacement runtime observation changed.');
    }
  }
  const retained = record.retainedObservations ?? [];
  if (!Array.isArray(retained) || new Set([record.previousObservationId, ...retained.map(item => item.observationId),
    ...(record.status === 'imported' ? [record.replacementObservationId] : [])]).size !== 1 + retained.length + (record.status === 'imported' ? 1 : 0)) {
    fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Runtime observation history contains a replay.');
  }
  for (const item of retained) {
    if (!UUID_PATTERN.test(item.observationId ?? '') || !SHA256_PATTERN.test(item.manifestSha256 ?? '')) fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Invalid retained observation.');
    for (const name of ['runtime-evidence.json', 'runtime-input-receipt.json', 'current-prompt.md']) {
      const bytes = await boundedRegularFile(path.join(archiveDirectory, 'imported-observations', item.observationId, name), name.endsWith('.md') ? MAX_PROMPT_BYTES : MAX_RESPONSE_BYTES, name, { trustedReview: true });
      if (sha256(bytes) !== item.sha256?.[name]) fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Retained observation changed.');
    }
  }
  return Object.freeze(record);
}

export async function prepareForgeCrossLayerRuntimeReprobe({ catalogFile, stateFile, artifactsDirectory,
  sourceCommit, workspaceFingerprint, taskId, sessionId, rpcId, promptText, attemptDirectory, promptFile,
  preparationExecution, preparationTerminal }) {
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  await withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const replay = await readForgeCrossLayerRuntimeReprobe({ stateFile, state });
    if (replay !== null) {
      if (replay.status === 'pending' && replay.rpcId === rpcId && replay.taskId === taskId && replay.sessionId === sessionId
        && replay.baseSourceCommit === sourceCommit && replay.workspaceFingerprint === workspaceFingerprint
        && replay.requestSha256 === sha256(Buffer.from(promptText ?? ''))) return;
      if (replay.rpcId === rpcId || (replay.status !== 'pending'
        && (replay.status !== 'imported' || state.activeAttempt?.executionGeneration <= replay.previousExecutionGeneration))) {
        fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'No newly completed runtime review is available.');
      }
    }
    if (state.workflowId !== 'crud-production' || state.currentPhaseId !== 'cross-layer-acceptance'
      || state.currentPhaseIndex !== 7 || state.status !== 'active' || state.activeAttempt === null || Object.keys(state.acceptedArtifacts).length !== 7
      || state.taskId !== taskId || state.sessionId !== sessionId || state.sourceCommit !== sourceCommit
      || !SHA256_PATTERN.test(workspaceFingerprint ?? '') || typeof rpcId !== 'string' || !rpcId
      || typeof promptText !== 'string' || !promptText.trim()) {
      fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Runtime recheck requires the current seven accepted stages.');
    }
    await loadAcceptedArtifacts({ state, catalog, artifactsDirectory });
    const directory = path.dirname(stateFile);
    if (path.dirname(attemptDirectory) !== path.join(directory, 'browser-attempts')) fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Runtime capture is outside the protected attempt.');
    const [execution, baseline, begin, capture] = await Promise.all(['execution.json', 'session-baseline.json', 'begin.json', '阶段终态采集.json']
      .map(name => readJsonFile(path.join(attemptDirectory, name), MAX_RESPONSE_BYTES, name)));
    validateProtectedExecutionContext(execution);
    const proof = capture.sessionProof;
    const fields = ['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
      'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint', 'workflowId', 'phaseId', 'phaseIndex',
      'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'];
    if (execution.executionId !== path.basename(attemptDirectory) || execution.taskId !== taskId || execution.dshSessionId !== sessionId
      || execution.sourceCommit !== sourceCommit || execution.workflowId !== state.workflowId || execution.phaseId !== state.currentPhaseId
      || execution.phaseIndex !== 7 || execution.phaseCatalogVersion !== state.catalogVersion || execution.phaseCatalogDigest !== state.catalogDigest
      || execution.authorityClass !== 'production-read-only' || execution.testOnly !== false || execution.actionCeiling !== 'read-only' || execution.ownedPaths.length !== 0
      || execution.rpcId !== state.activeAttempt.rpcId || execution.generation !== state.activeAttempt.executionGeneration
      || execution.textDigest !== state.activeAttempt.promptDigest || canonicalStringify(begin.attempt) !== canonicalStringify(state.activeAttempt)
      || proof?.schemaVersion !== 'forge-delivery-phase-browser-session-proof/v1' || baseline.schemaVersion !== 'forge-delivery-phase-browser-session-baseline/v1'
      || fields.some(key => proof[key] !== execution[key] || baseline[key] !== execution[key])
      || proof.terminalReason !== 'completed' || proof.hostReceiptsDerived !== false || proof.sessionCwd !== '/workspace' || baseline.sessionCwd !== '/workspace'
      || proof.baselineObservedSeq !== baseline.observedSeq || !Number.isSafeInteger(proof.requestSeq) || !Number.isSafeInteger(proof.assistantMessageSeq)
      || !Number.isSafeInteger(proof.terminalSeq) || proof.requestSeq <= baseline.observedSeq || proof.assistantMessageSeq <= proof.requestSeq || proof.terminalSeq <= proof.assistantMessageSeq
      || !SHA256_PATTERN.test(proof.terminalEventDigest ?? '') || typeof capture.modelResponse !== 'string' || sha256(Buffer.from(capture.modelResponse)) !== proof.modelResponseSha256) {
      fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Runtime recheck requires the original completed readonly attempt.');
    }
    const bundle = await readPreparedForgeCrossLayerRuntimeEvidence({ stateFile, state });
    const input = await readJsonFile(path.join(directory, 'runtime-input-receipt.json'), MAX_RESPONSE_BYTES, 'runtime input', { trustedReview: true });
    const deployment = bundle.evidence.deployment;
    if (input.preparationBinding?.workspaceFingerprint !== workspaceFingerprint
      || deployment.status !== 'success' || deployment.startup?.migrationValidated !== true || deployment.startup?.applicationStarted !== true
      || !(['api', 'database'].some(kind => bundle.evidence[kind].status === 'failed'
          || (bundle.evidence[kind].status === 'blocked' && Array.isArray(bundle.evidence[kind].checks)
            && bundle.evidence[kind].checks.every(check => check?.status === 'not-executed')))
        || (bundle.evidence.api.status === 'passed' && bundle.evidence.api.roleAuthorizationVerified === false))
      || bundle.evidence.browser.status !== 'not-executed' || bundle.evidence.browser.reason !== 'owner-excluded'
      || !/^[0-9a-f-]{36}$/u.test(deployment.observationId ?? '')
      || ['deployment', 'api', 'database', 'browser'].some(kind => {
        const document = bundle.evidence[kind];
        return document.observationId !== deployment.observationId || document.stateDigest !== input.sourceStateDigest
          || document.taskId !== taskId || document.baseSourceCommit !== sourceCommit || document.workspaceFingerprint !== workspaceFingerprint
          || document.sourceCommit !== bundle.runtimeSource.commit || document.candidateTree !== bundle.runtimeSource.tree
          || document.acceptedPatchSha256 !== bundle.subject.cumulativePatchSha256;
      })) fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only the same migrated candidate with failed checks, unexecuted blocked checks or explicit unverified role authorization may be rechecked.');
    if (replay?.status === 'pending') {
      const preparation = validateProtectedExecutionContext(preparationExecution);
      const binding = preparation.preparationBinding;
      const terminal = preparationTerminal;
      // A provider failure before any tool activity permits preparation only.
      const providerFailedWithoutTools = terminal?.terminalReason === 'error'
        && terminal.terminalErrorCode === 'PI_AI_ERROR'
        && terminal.toolCallCount === 0 && terminal.toolResultCount === 0;
      const identityFields = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
        'dshSessionId', 'sourceCommit', 'workflowId', 'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest'];
      if (preparation.crossLayerPreparation !== true || preparation.authorityClass !== 'production-read-only'
        || preparation.testOnly !== false || preparation.actionCeiling !== 'read-only' || preparation.ownedPaths.length !== 0
        || identityFields.some(key => preparation[key] !== execution[key])
        || preparation.generation <= replay.previousExecutionGeneration || preparation.executionId === execution.executionId
        || preparation.rpcId === rpcId || binding?.stateDigest !== state.stateDigest
        || binding.baseSourceCommit !== sourceCommit || binding.workspaceFingerprint !== workspaceFingerprint
        || replay.workspaceFingerprint !== workspaceFingerprint
        || canonicalStringify(binding.acceptedArtifactDigests) !== canonicalStringify(state.acceptedArtifacts)
        || !terminal || ['executionId', 'generation', 'dshSessionId', 'rpcId', 'textDigest'].some(key => terminal[key] !== preparation[key])
        || (terminal.terminalReason !== 'completed' && !providerFailedWithoutTools) || terminal.sessionRunning !== false
        || !Number.isSafeInteger(terminal.turn) || terminal.turn < 0
        || !Number.isSafeInteger(terminal.requestSeq) || terminal.requestSeq < 0
        || !Number.isSafeInteger(terminal.terminalSeq) || terminal.terminalSeq <= terminal.requestSeq
        || !SHA256_PATTERN.test(terminal.terminalEventDigest ?? '')) {
        fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Pending runtime preparation requires its latest completed execution or zero-tool provider failure.');
      }
      // A rejected plan creates no observation. Keep the original pending
      // record and archived formal review; only authorize another preparation.
      return;
    }
    const archiveDirectory = path.join(directory, 'runtime-rechecks', sha256(Buffer.from(rpcId)));
    const archivedSha256 = {};
    for (const [name, file] of Object.entries({ 'state.json': stateFile, 'runtime-evidence.json': path.join(directory, 'runtime-evidence.json'),
      'runtime-input-receipt.json': path.join(directory, 'runtime-input-receipt.json'), 'current-prompt.md': promptFile,
      ...(replay === null ? {} : { 'runtime-reprobe.json': path.join(directory, 'runtime-reprobe.json') }) })) {
      const bytes = await boundedRegularFile(file, name.endsWith('.md') ? MAX_PROMPT_BYTES : MAX_RESPONSE_BYTES, name, { trustedReview: true });
      archivedSha256[name] = sha256(bytes);
      await writeExclusive(path.join(archiveDirectory, name), bytes);
    }
    const record = { schemaVersion: 'forge-cross-layer-runtime-reprobe/v1', status: 'pending', rpcId,
      requestSha256: sha256(Buffer.from(promptText)), taskId, sessionId, stateDigest: state.stateDigest, attemptId: state.activeAttempt.attemptId,
      baseSourceCommit: sourceCommit, workspaceFingerprint, acceptedArtifactDigests: { ...state.acceptedArtifacts },
      candidateCommit: bundle.runtimeSource.commit, candidateTree: bundle.runtimeSource.tree,
      acceptedPatchSha256: bundle.subject.cumulativePatchSha256, previousManifestSha256: bundle.manifestSha256,
      previousObservationId: deployment.observationId, previousStateDigest: input.sourceStateDigest,
      previousExecutionId: execution.executionId, previousExecutionGeneration: execution.generation,
      archiveDirectory, archivedSha256 };
    await (replay === null ? writeExclusive : writeAtomic)(path.join(directory, 'runtime-reprobe.json'), jsonBytes(record));
  });
  return prepareForgeCrossLayerPreparation({ catalogFile, stateFile, artifactsDirectory, sourceCommit,
    workspaceFingerprint, taskId, sessionId, rpcId, promptText });
}

export async function prepareForgeDeliveryBrowserPhase({
  catalogFile,
  stateFile,
  artifactsDirectory,
  originalRequestFile,
  promptFile,
  sourceCommit,
  taskId,
  sessionId,
  rpcId,
  promptText,
}) {
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const databaseResume = await readDatabaseLeaseResume(stateFile, rpcId);
    if (databaseResume !== null) return inspectDatabaseLeaseResume({ stateFile, state, catalog, artifactsDirectory,
      originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, databaseResume });
    const domainResume = await readDomainContractResume(stateFile, rpcId);
    if (domainResume !== null) return inspectDomainContractResume({
      stateFile, state, catalog, artifactsDirectory, originalRequestFile, promptFile,
      sourceCommit, taskId, sessionId, rpcId, domainResume,
    });
    const clarification = await readRequirementsClarification(stateFile, rpcId);
    if (clarification !== null) return inspectRequirementsClarification({
      stateFile, state, catalog, artifactsDirectory, originalRequestFile, promptFile,
      sourceCommit, taskId, sessionId, rpcId, clarification,
    });
    return inspectForgeDeliveryBrowserPhase({
      stateFile, state, catalog, artifactsDirectory, originalRequestFile, promptFile,
      sourceCommit, taskId, sessionId, rpcId, promptText,
    });
  });
}

const requirementsClarificationFile = (stateFile, rpcId) => path.join(path.dirname(stateFile),
  'requirements-clarifications', `${sha256(Buffer.from(rpcId, 'utf8'))}.json`);

async function readRequirementsClarification(stateFile, rpcId) {
  if (typeof rpcId !== 'string') return null;
  const file = requirementsClarificationFile(stateFile, rpcId);
  if (await lstat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)) === null) return null;
  return readJsonFile(file, MAX_RESPONSE_BYTES, 'requirements clarification');
}

function requirementsClarificationText(text) {
  const compact = typeof text === 'string' ? text.replace(/[\s。！!，,、；;？?：:]/gu, '') : '';
  return typeof text === 'string' && !text.includes('\0') && Buffer.byteLength(text, 'utf8') <= MAX_PROMPT_BYTES
    && compact.length > 0 && !hasGlobalReadOnlyIntent(text)
    // A short business answer such as “并签” is meaningful input. Its adequacy
    // belongs to the model and subsequent preflight, not a keyword/length gate.
    && !/^(?:请你?|麻烦你?|好的?|那就|可以|现在|先|再|继续|接着|开始|执行|完成|推进|修改|处理|分析|当前|本轮|这轮|需求|阶段|任务|工作|的|吧|一下|往下)+$/u.test(compact);
}

async function inspectRequirementsClarification({ stateFile, state, catalog, artifactsDirectory,
  originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, clarification }) {
  exactKeys(clarification, ['schemaVersion', 'previousState', 'originAttempt', 'previousExecutionId', 'rpcId', 'text'],
    'requirements clarification');
  const previous = validateForgeDeliveryPhaseState(clarification.previousState, catalog);
  if (clarification.schemaVersion !== 'forge-requirements-clarification/v1' || clarification.rpcId !== rpcId
    || !requirementsClarificationText(clarification.text) || previous.status !== 'active'
    || previous.currentPhaseId !== 'requirements' || previous.currentPhaseIndex !== 0 || previous.activeAttempt === null
    || previous.taskId !== taskId || previous.sessionId !== sessionId || previous.sourceCommit !== sourceCommit
    || !UUID_PATTERN.test(clarification.previousExecutionId)) {
    fail('PHASE_CONTROLLER_CLARIFICATION_DENIED', 'Clarification is not bound to the active requirements task.');
  }
  // The original contract and overload retry receipt remain byte-for-byte intact.
  const origin = { ...previous, activeAttempt: clarification.originAttempt,
    lastExecutionGeneration: clarification.originAttempt?.executionGeneration, stateDigest: '' };
  origin.stateDigest = sha256(Buffer.from(canonicalStringify((({ stateDigest, ...rest }) => rest)(origin))));
  validateForgeDeliveryPhaseState(origin, catalog);
  if (origin.activeAttempt.attemptId !== previous.activeAttempt.attemptId
    || origin.activeAttempt.startedAt !== previous.activeAttempt.startedAt
    || origin.activeAttempt.executionGeneration > previous.activeAttempt.executionGeneration) {
    fail('PHASE_CONTROLLER_CLARIFICATION_DENIED', 'Clarification cannot replace the original attempt.');
  }
  const base = await inspectForgeDeliveryBrowserPhase({ stateFile, state: origin, catalog,
    artifactsDirectory, originalRequestFile, promptFile, sourceCommit, taskId, sessionId,
    rpcId: origin.activeAttempt.rpcId });
  const directory = path.join(path.dirname(stateFile), 'browser-attempts', clarification.previousExecutionId);
  const [execution, baseline, begin, capture, assessment] = await Promise.all([
    'execution.json', 'session-baseline.json', 'begin.json', '阶段终态采集.json', '阶段候选检查结果.json',
  ].map((name) => readJsonFile(path.join(directory, name), MAX_RESPONSE_BYTES, name)));
  validateProtectedExecutionContext(execution);
  const attempt = previous.activeAttempt;
  const proof = capture.sessionProof;
  const fields = ['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint', 'workflowId',
    'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'];
  if (execution.executionId !== clarification.previousExecutionId || execution.taskId !== taskId
    || execution.dshSessionId !== sessionId || execution.sourceCommit !== sourceCommit
    || execution.workflowId !== previous.workflowId || execution.phaseId !== 'requirements' || execution.phaseIndex !== 0
    || execution.phaseCatalogVersion !== previous.catalogVersion || execution.phaseCatalogDigest !== previous.catalogDigest
    || execution.testOnly !== false || execution.authorityClass !== 'production-read-only'
    || execution.actionCeiling !== 'read-only' || execution.ownedPaths.length !== 0
    || execution.rpcId !== attempt.rpcId || execution.generation !== attempt.executionGeneration
    || execution.textDigest !== attempt.promptDigest || canonicalStringify(begin.attempt) !== canonicalStringify(attempt)
    || begin.schemaVersion !== 'forge-delivery-browser-phase-begin/v1' || begin.workflowId !== previous.workflowId
    || begin.phaseId !== 'requirements' || begin.phaseIndex !== 0
    || proof?.schemaVersion !== 'forge-delivery-phase-browser-session-proof/v1'
    || baseline?.schemaVersion !== 'forge-delivery-phase-browser-session-baseline/v1'
    || fields.some((key) => proof[key] !== execution[key] || baseline[key] !== execution[key])
    || proof.terminalReason !== 'completed' || proof.hostReceiptsDerived !== false
    || proof.baselineObservedSeq !== baseline.observedSeq || baseline.sessionCwd !== '/workspace'
    || proof.sessionCwd !== baseline.sessionCwd || !Number.isSafeInteger(proof.requestSeq)
    || !Number.isSafeInteger(proof.assistantMessageSeq) || !Number.isSafeInteger(proof.terminalSeq)
    || proof.requestSeq <= baseline.observedSeq || proof.assistantMessageSeq <= proof.requestSeq
    || proof.terminalSeq <= proof.assistantMessageSeq || !SHA256_PATTERN.test(proof.terminalEventDigest)
    || typeof capture.modelResponse !== 'string' || sha256(Buffer.from(capture.modelResponse)) !== proof.modelResponseSha256
    || assessment.status !== 'needs-attention' || assessment.code !== 'PHASE_CONTROLLER_BUSINESS_DECISION_REQUIRED'
    || assessment.stateAdvanced !== false || assessment.phaseAttemptId !== attempt.attemptId
    || assessment.phaseId !== 'requirements' || assessment.modelResponseSha256 !== proof.modelResponseSha256) {
    fail('PHASE_CONTROLLER_CLARIFICATION_DENIED', 'Clarification requires the retained real unresolved requirements candidate.');
  }
  const proposal = parseForgeDeliveryPhaseProposal({ text: capture.modelResponse, phase: currentPhase(previous, catalog) });
  if (proposal.unresolvedDecisions.length === 0) {
    fail('PHASE_CONTROLLER_CLARIFICATION_DENIED', 'Requirements candidate has no unresolved business decisions.');
  }
  for (const name of ['累计变更文件.json', '本阶段变更文件.json']) {
    const changed = await readJsonFile(path.join(directory, name), MAX_RESPONSE_BYTES, name);
    if (!Array.isArray(changed) || changed.length !== 0) {
      fail('PHASE_CONTROLLER_CLARIFICATION_DENIED', 'Requirements clarification cannot carry source changes.');
    }
  }
  const promptText = `${base.promptText}\n\n## 当前需求尝试的用户补充说明\n继续处理同一需求候选，结合此前有效补充及以下原话修订；保留仍未解决的业务问题，不推进阶段或修改业务源码。\n\n${clarification.text}`;
  if (Buffer.byteLength(promptText, 'utf8') > MAX_PROMPT_BYTES) {
    fail('PHASE_CONTROLLER_CLARIFICATION_DENIED', 'Clarification exceeds the existing phase prompt limit.');
  }
  const promptDigest = digestDirectUserTextContent([{ type: 'text', text: promptText }]);
  const replay = state.activeAttempt?.rpcId === rpcId;
  const expected = replay ? continueForgeRequirementsPhase({ state: previous, catalog, rpcId, promptDigest,
    executionGeneration: state.activeAttempt.executionGeneration }) : previous;
  if (state.stateDigest !== expected.stateDigest) {
    fail('PHASE_CONTROLLER_CLARIFICATION_DENIED', 'The requirements attempt changed after clarification was prepared.');
  }
  return Object.freeze({ ...base, stateDigest: state.stateDigest, rpcId, promptText, promptDigest,
    idempotent: replay, activeExecutionGeneration: state.activeAttempt.executionGeneration });
}

export async function prepareForgeRequirementsClarification({ catalogFile, stateFile, artifactsDirectory,
  originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, previousExecutionId, clarificationText }) {
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    let clarification = await readRequirementsClarification(stateFile, rpcId);
    if (clarification === null) {
      const prior = await readRequirementsClarification(stateFile, state.activeAttempt?.rpcId ?? '');
      clarification = { schemaVersion: 'forge-requirements-clarification/v1', previousState: state,
        originAttempt: prior?.originAttempt ?? state.activeAttempt, previousExecutionId, rpcId, text: clarificationText };
    } else if (clarification.text !== clarificationText || clarification.previousExecutionId !== previousExecutionId) {
      fail('PHASE_CONTROLLER_CLARIFICATION_DENIED', 'Clarification RPC cannot be rebound to different material.');
    }
    const prepared = await inspectRequirementsClarification({ stateFile, state, catalog, artifactsDirectory,
      originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, clarification });
    const file = requirementsClarificationFile(stateFile, rpcId);
    if (await readRequirementsClarification(stateFile, rpcId) === null) await writeExclusive(file, jsonBytes(clarification));
    return prepared;
  });
}

const domainContractResumeFile = (stateFile, rpcId, correction = false) => path.join(path.dirname(stateFile),
  correction ? 'domain-candidate-corrections' : 'domain-user-interruptions', `${sha256(Buffer.from(rpcId, 'utf8'))}.json`);

async function readDomainContractResume(stateFile, rpcId) {
  if (typeof rpcId !== 'string') return null;
  for (const correction of [false, true]) {
    const file = domainContractResumeFile(stateFile, rpcId, correction);
    if (await lstat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)) === null) continue;
    const record = await readJsonFile(file, MAX_RESPONSE_BYTES, 'domain continuation');
    if (record.schemaVersion !== (correction ? 'forge-domain-candidate-correction/v1' : 'forge-domain-user-interruption/v1')) {
      fail('PHASE_CONTROLLER_DOMAIN_RESUME_DENIED', 'Continuation record kind does not match its evidence store.');
    }
    return record;
  }
  return null;
}

async function validateCompletedDomainCorrection({ previous, execution, baseline, begin, capture, directory, stateFile, catalog, artifactsDirectory }) {
  exactKeys(capture, ['modelResponse', 'sessionProof'], 'completed domain capture');
  const assessment = await readJsonFile(path.join(directory, '阶段候选检查结果.json'), MAX_RESPONSE_BYTES, 'domain assessment');
  validateProtectedExecutionContext(execution);
  const attempt = previous.activeAttempt;
  const proof = capture.sessionProof;
  const fields = ['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint', 'workflowId',
    'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'];
  if (execution.executionId !== path.basename(directory) || execution.taskId !== previous.taskId
    || execution.dshSessionId !== previous.sessionId || execution.sourceCommit !== previous.sourceCommit
    || execution.workflowId !== previous.workflowId || execution.phaseId !== 'domain-contract' || execution.phaseIndex !== 1
    || execution.phaseCatalogVersion !== previous.catalogVersion || execution.phaseCatalogDigest !== previous.catalogDigest
    || execution.testOnly !== false || execution.authorityClass !== 'production-read-only'
    || execution.actionCeiling !== 'read-only' || execution.ownedPaths.length !== 0
    || execution.rpcId !== attempt.rpcId || execution.generation !== attempt.executionGeneration
    || execution.textDigest !== attempt.promptDigest || canonicalStringify(begin.attempt) !== canonicalStringify(attempt)
    || begin.schemaVersion !== 'forge-delivery-browser-phase-begin/v1' || begin.workflowId !== previous.workflowId
    || begin.phaseId !== 'domain-contract' || begin.phaseIndex !== 1
    || proof?.schemaVersion !== 'forge-delivery-phase-browser-session-proof/v1'
    || baseline?.schemaVersion !== 'forge-delivery-phase-browser-session-baseline/v1'
    || fields.some((key) => proof[key] !== execution[key] || baseline[key] !== execution[key])
    || proof.terminalReason !== 'completed' || proof.hostReceiptsDerived !== false
    || proof.baselineObservedSeq !== baseline.observedSeq || baseline.sessionCwd !== '/workspace'
    || proof.sessionCwd !== baseline.sessionCwd || !Number.isSafeInteger(proof.requestSeq)
    || !Number.isSafeInteger(proof.assistantMessageSeq) || !Number.isSafeInteger(proof.terminalSeq)
    || proof.requestSeq <= baseline.observedSeq || proof.assistantMessageSeq <= proof.requestSeq
    || proof.terminalSeq <= proof.assistantMessageSeq || !SHA256_PATTERN.test(proof.terminalEventDigest)
    || typeof capture.modelResponse !== 'string' || sha256(Buffer.from(capture.modelResponse)) !== proof.modelResponseSha256
    || assessment.status !== 'preflight-ready'
    || assessment.stateAdvanced !== false || assessment.phaseAttemptId !== attempt.attemptId
    || assessment.phaseId !== 'domain-contract' || assessment.modelResponseSha256 !== proof.modelResponseSha256) {
    fail('PHASE_CONTROLLER_DOMAIN_RESUME_DENIED', 'Correction requires the retained completed domain candidate.');
  }
  const preflight = await readJsonFile(path.join(directory, '阶段候选预检凭据.json'), MAX_RESPONSE_BYTES, 'domain preflight');
  const candidate = await evaluatePhaseCandidate({ state: previous, stateFile, catalog, artifactsDirectory,
    response: capture.modelResponse.replace(/(?:\r?\n)+$/u, ''), allChangedPaths: [], phaseChangedPaths: [],
    phasePatchBytes: Buffer.alloc(0), cumulativePatchBytes: Buffer.alloc(0) });
  if (preflight.schemaVersion !== 'forge-delivery-phase-controller-preflight/v1'
    || preflight.workflowId !== previous.workflowId || preflight.phaseAttemptId !== attempt.attemptId
    || preflight.stateAdvanced !== false || preflight.phaseId !== 'domain-contract' || preflight.phaseIndex !== 1
    || preflight.candidateArtifactDigest !== candidate.artifact.artifactDigest || candidate.artifact.unresolvedDecisions.length !== 0
    || preflight.hostVerificationProfiles?.length !== 0 || candidate.phase.hostVerificationProfiles.length !== 0) {
    fail('PHASE_CONTROLLER_DOMAIN_RESUME_DENIED', 'Correction requires the matching retained domain preflight.');
  }
  for (const name of ['累计变更文件.json', '本阶段变更文件.json']) {
    const changed = await readJsonFile(path.join(directory, name), MAX_RESPONSE_BYTES, name);
    if (!Array.isArray(changed) || changed.length !== 0) {
      fail('PHASE_CONTROLLER_DOMAIN_RESUME_DENIED', 'Domain correction cannot carry source changes.');
    }
  }
}

async function inspectDomainContractResume({ stateFile, state, catalog, artifactsDirectory,
  originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, domainResume }) {
  exactKeys(domainResume, ['schemaVersion', 'previousState', 'originAttempt', 'previousExecutionId', 'rpcId', 'text'],
    'domain interruption continuation');
  const previous = validateForgeDeliveryPhaseState(domainResume.previousState, catalog);
  const correction = domainResume.schemaVersion === 'forge-domain-candidate-correction/v1';
  if ((!correction && domainResume.schemaVersion !== 'forge-domain-user-interruption/v1') || domainResume.rpcId !== rpcId
    || typeof domainResume.text !== 'string' || domainResume.text.trim().length === 0
    || domainResume.text.includes('\0') || hasGlobalReadOnlyIntent(domainResume.text)
    || previous.status !== 'active' || previous.currentPhaseId !== 'domain-contract' || previous.currentPhaseIndex !== 1
    || previous.activeAttempt === null || previous.taskId !== taskId || previous.sessionId !== sessionId
    || previous.sourceCommit !== sourceCommit || !UUID_PATTERN.test(domainResume.previousExecutionId)) {
    fail('PHASE_CONTROLLER_DOMAIN_RESUME_DENIED', 'Continuation is not bound to the interrupted domain contract.');
  }
  // Validate the unchanged canonical prompt against the first execution of this
  // attempt; each subsequent execution and its terminal proof stay immutable.
  const origin = { ...previous, activeAttempt: domainResume.originAttempt,
    lastExecutionGeneration: domainResume.originAttempt?.executionGeneration, stateDigest: '' };
  origin.stateDigest = sha256(Buffer.from(canonicalStringify((({ stateDigest, ...rest }) => rest)(origin))));
  validateForgeDeliveryPhaseState(origin, catalog);
  if (origin.activeAttempt.attemptId !== previous.activeAttempt.attemptId
    || origin.activeAttempt.startedAt !== previous.activeAttempt.startedAt
    || origin.activeAttempt.executionGeneration > previous.activeAttempt.executionGeneration) {
    fail('PHASE_CONTROLLER_DOMAIN_RESUME_DENIED', 'Continuation cannot replace the original domain attempt.');
  }
  const base = await inspectForgeDeliveryBrowserPhase({ stateFile, state: origin, catalog,
    artifactsDirectory, originalRequestFile, promptFile, sourceCommit, taskId, sessionId,
    rpcId: origin.activeAttempt.rpcId });
  const directory = path.join(path.dirname(stateFile), 'browser-attempts', domainResume.previousExecutionId);
  const [execution, baseline, begin, capture] = await Promise.all([
    'execution.json', 'session-baseline.json', 'begin.json', '阶段终态采集.json',
  ].map((name) => readJsonFile(path.join(directory, name), MAX_RESPONSE_BYTES, name)));
  if (correction) {
    await validateCompletedDomainCorrection({ previous, execution, baseline, begin, capture, directory, stateFile, catalog, artifactsDirectory });
  } else {
    exactKeys(capture, ['interruptionProof'], 'domain interruption capture');
    validateForgeDomainUserAbortedEvidence({ state: previous, execution, baseline, begin, proof: capture.interruptionProof });
  }
  if (execution.executionId !== domainResume.previousExecutionId) {
    fail('PHASE_CONTROLLER_DOMAIN_RESUME_DENIED', 'Interruption belongs to another protected execution.');
  }
  const context = correction
    ? '上一执行已自然完成，但用户尚未接受候选。保留原完整回答和终态，仅按下方反馈修订同一只读领域合同；保持已接受的上游产物，不进入后续阶段。'
    : '上一执行由用户中止；未完成草稿和中途供应方错误仅为历史，不是已通过产物。继续同一只读阶段，保持原合同要求及已接受的上游产物。';
  const promptText = `${base.promptText}\n\n## 当前领域合同尝试的用户续接说明\n${context}\n\n${domainResume.text}`;
  if (Buffer.byteLength(promptText, 'utf8') > MAX_PROMPT_BYTES) {
    fail('PHASE_CONTROLLER_DOMAIN_RESUME_DENIED', 'Continuation exceeds the existing phase prompt limit.');
  }
  const promptDigest = digestDirectUserTextContent([{ type: 'text', text: promptText }]);
  const replay = state.activeAttempt?.rpcId === rpcId;
  const expected = replay ? continueForgeDomainContractPhase({ state: previous, catalog, rpcId, promptDigest,
    executionGeneration: state.activeAttempt.executionGeneration }) : previous;
  if (state.stateDigest !== expected.stateDigest) {
    fail('PHASE_CONTROLLER_DOMAIN_RESUME_DENIED', 'The domain attempt changed after continuation was prepared.');
  }
  return Object.freeze({ ...base, stateDigest: state.stateDigest, rpcId, promptText, promptDigest,
    idempotent: replay, activeExecutionGeneration: state.activeAttempt.executionGeneration });
}

export const prepareForgeDomainUserAbortContinuation = (options) => prepareDomainContinuation(options, false);
export const prepareForgeDomainCandidateCorrection = (options) => prepareDomainContinuation(options, true);

async function prepareDomainContinuation({ catalogFile, stateFile, artifactsDirectory,
  originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, previousExecutionId, continuationText }, correction) {
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    let domainResume = await readDomainContractResume(stateFile, rpcId);
    if (domainResume === null) {
      const prior = await readDomainContractResume(stateFile, state.activeAttempt?.rpcId);
      domainResume = { schemaVersion: correction ? 'forge-domain-candidate-correction/v1' : 'forge-domain-user-interruption/v1', previousState: state,
        originAttempt: prior?.originAttempt ?? state.activeAttempt, previousExecutionId, rpcId, text: continuationText };
    } else if (domainResume.text !== continuationText || domainResume.previousExecutionId !== previousExecutionId
      || (domainResume.schemaVersion === 'forge-domain-candidate-correction/v1') !== correction) {
      fail('PHASE_CONTROLLER_DOMAIN_RESUME_DENIED', 'Continuation RPC cannot be rebound to different material.');
    }
    const prepared = await inspectDomainContractResume({ stateFile, state, catalog, artifactsDirectory,
      originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, domainResume });
    if (await readDomainContractResume(stateFile, rpcId) === null) {
      await writeExclusive(domainContractResumeFile(stateFile, rpcId, correction), jsonBytes(domainResume));
    }
    return prepared;
  });
}

const databaseLeaseResumeFile = (stateFile, rpcId, evidenceCorrection = false) => path.join(path.dirname(stateFile),
  evidenceCorrection ? 'database-evidence-corrections' : 'database-lease-pauses', `${sha256(Buffer.from(rpcId, 'utf8'))}.json`);
async function readDatabaseLeaseResume(stateFile, rpcId) {
  if (typeof rpcId !== 'string') return null;
  const files = [];
  for (const correction of [false, true]) {
    const file = databaseLeaseResumeFile(stateFile, rpcId, correction);
    if (await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)) !== null) files.push(file);
  }
  if (files.length > 1) fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Database continuation RPC has conflicting proofs.');
  return files.length === 0 ? null : readJsonFile(files[0], MAX_RESPONSE_BYTES, 'database continuation');
}

export function isForgeAccessWiringLeasePauseProposal(proposal) {
  const payload = proposal?.payload;
  const migration = payload?.migrationVersion;
  const seed = payload?.apiResourceSeed;
  const coherence = payload?.permissionCoherence;
  if (proposal?.phaseId !== 'access-wiring' || migration?.candidateWritten !== true
    || migration.liveDatabaseApplied !== false || coherence?.status !== 'blocked'
    || ![undefined, 'blocked_draft'].includes(migration.status)
    || ![undefined, 'written_but_governance_failed'].includes(seed?.status)
    || seed?.liveApplied === true || coherence.phaseAcceptanceClaimed === true
    || coherence.databaseIntegrationProven === true || coherence.databaseApplied === true
    || coherence.crossLayerAcceptanceExecuted === true || coherence.releaseExecuted === true
    || coherence.governance?.phasePassed === true) return false;
  if (migration.status === 'blocked_draft' && seed?.status === 'written_but_governance_failed'
    && coherence.phaseAcceptanceClaimed === false && coherence.databaseIntegrationProven === false
    && coherence.latestGovernance?.status === 'failed'
    && UUID_PATTERN.test(coherence.latestGovernance.receiptId ?? '')
    && coherence.backendModuleTest?.status === 'not_run') return true;
  // A passed module test does not make a governance-failed candidate accepted.
  // These are draft markers only; the existing resume still verifies the captured
  // turn, expired identity, exact source/paths and same attempt independently.
  return seed?.liveApplied === false && coherence.databaseApplied === false
    && coherence.crossLayerAcceptanceExecuted === false && coherence.releaseExecuted === false
    && coherence.governance?.status === 'failed' && coherence.governance.phasePassed === false
    && UUID_PATTERN.test(coherence.governance.latestHostReceiptId ?? '')
    && coherence.backendModuleTest?.status === 'passed'
    && UUID_PATTERN.test(coherence.backendModuleTest.receiptId ?? '');
}

export function isForgeFrontendLeasePauseProposal(proposal) {
  const payload = proposal?.payload;
  if (proposal?.phaseId !== 'frontend') return false;
  const verification = payload?.redTests?.verification;
  if (Array.isArray(verification)) {
    return payload.pageImplementation?.status === 'candidate_incomplete_verification'
      && payload.redTests.focusedTest?.executionStatus === 'not_run'
      && verification.some(item => item?.profile === 'frontend-admin-lint'
        && item.recordedStatus === 'failed' && typeof item.receiptId === 'string' && item.receiptId.length > 0);
  }
  // A reported Host failure identifies an unfinished draft, never a passed receipt.
  // The existing continuation still binds its completed turn, source, paths and attempt.
  if (verification === null || typeof verification !== 'object'
    || verification.phasePassingClaimed !== false || verification.releaseOrLiveAcceptanceProven !== false) return false;
  return ['governance', 'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build']
    .some(profile => verification[profile]?.status === 'failed'
      && typeof verification[profile].receiptId === 'string' && verification[profile].receiptId.trim().length > 0);
}

// A context failure can continue only the existing completed access evidence predecessor.
async function inspectAccessContextResume({ stateFile, state, catalog, artifactsDirectory,
  originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, databaseResume }) {
  exactKeys(databaseResume, ['schemaVersion', 'previousState', 'originAttempt', 'previousExecutionId', 'rpcId', 'text', 'draftSource'], 'access context continuation');
  const previous = validateForgeDeliveryPhaseState(databaseResume.previousState, catalog);
  if (previous.status !== 'active' || previous.workflowId !== 'crud-production'
    || previous.currentPhaseId !== 'access-wiring' || previous.currentPhaseIndex !== 6 || previous.activeAttempt === null
    || previous.taskId !== taskId || previous.sessionId !== sessionId || previous.sourceCommit !== sourceCommit
    || databaseResume.rpcId !== rpcId || !UUID_PATTERN.test(databaseResume.previousExecutionId)
    || typeof databaseResume.text !== 'string' || !databaseResume.text.trim() || databaseResume.text.includes('\0')
    || hasGlobalReadOnlyIntent(databaseResume.text)) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Context recovery must retain the current access evidence attempt.');
  }
  const prior = await readDatabaseLeaseResume(stateFile, previous.activeAttempt.rpcId);
  if (prior?.schemaVersion !== 'forge-access-wiring-evidence-correction/v1'
    || canonicalStringify(prior.originAttempt) !== canonicalStringify(databaseResume.originAttempt)
    || canonicalStringify(prior.draftSource) !== canonicalStringify(databaseResume.draftSource)) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Context recovery requires the existing completed access evidence predecessor.');
  }
  // One fixed evidence-correction predecessor, never another context recovery.
  const base = await inspectDatabaseLeaseResume({ stateFile, state: previous, catalog, artifactsDirectory,
    originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId: prior.rpcId, databaseResume: prior });
  const directory = path.join(path.dirname(stateFile), 'browser-attempts', databaseResume.previousExecutionId);
  const [execution, baseline, begin, capture, savedProof] = await Promise.all([
    'execution.json', 'session-baseline.json', 'begin.json', '阶段终态采集.json', '权限阶段-上下文故障证明.json',
  ].map(name => readJsonFile(path.join(directory, name), MAX_RESPONSE_BYTES, name)));
  exactKeys(capture, ['contextFailureProof'], 'failed access context capture');
  validateForgeAccessContextFailureProof({ execution, baseline, proof: capture.contextFailureProof });
  const completedExecution = await readJsonFile(path.join(path.dirname(stateFile), 'browser-attempts', prior.previousExecutionId,
    'execution.json'), MAX_RESPONSE_BYTES, 'completed access predecessor');
  const attempt = previous.activeAttempt;
  if (execution.executionId !== databaseResume.previousExecutionId
    || execution.taskId !== taskId || execution.dshSessionId !== sessionId || execution.sourceCommit !== sourceCommit
    || execution.phaseCatalogVersion !== previous.catalogVersion || execution.phaseCatalogDigest !== previous.catalogDigest
    || execution.workspaceFingerprint !== databaseResume.draftSource.workspaceFingerprint
    || ['projectSlug', 'actorUserId', 'actorUsername', 'conversationId', 'workspaceFingerprint'].some(key => execution[key] !== completedExecution[key])
    || execution.rpcId !== attempt.rpcId || execution.generation !== attempt.executionGeneration || execution.textDigest !== attempt.promptDigest
    || begin.schemaVersion !== 'forge-delivery-browser-phase-begin/v1' || begin.workflowId !== previous.workflowId
    || begin.phaseId !== 'access-wiring' || begin.phaseIndex !== 6 || canonicalStringify(begin.attempt) !== canonicalStringify(attempt)
    || canonicalStringify(savedProof) !== canonicalStringify(capture.contextFailureProof)) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Context failure must bind the current unchanged access execution and retained candidate.');
  }
  const promptText = `${base.promptText}\n\n## 当前权限补证执行的上下文恢复\n上一轮上下文压缩失败，原错误终态继续保留，不能认定完成。沿同一尝试和原候选继续完成缺少的 Host 验证；已接受上游、源码范围和验收要求保持。\n\n${databaseResume.text}`;
  if (Buffer.byteLength(promptText, 'utf8') > MAX_PROMPT_BYTES) fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Continuation exceeds prompt limit.');
  const promptDigest = digestDirectUserTextContent([{ type: 'text', text: promptText }]);
  const replay = state.activeAttempt?.rpcId === rpcId;
  const expected = replay ? continueForgeAccessWiringLeasePause({ state: previous, catalog, rpcId, promptDigest,
    executionGeneration: state.activeAttempt.executionGeneration }) : previous;
  if (state.stateDigest !== expected.stateDigest) fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Access attempt changed after context recovery preparation.');
  return Object.freeze({ ...base, stateDigest: state.stateDigest, rpcId, promptText, promptDigest,
    idempotent: replay, activeExecutionGeneration: state.activeAttempt.executionGeneration });
}

async function inspectAccessProviderResume({ stateFile, state, catalog, artifactsDirectory,
  originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, databaseResume }) {
  exactKeys(databaseResume, ['schemaVersion', 'previousState', 'originAttempt', 'previousExecutionId', 'rpcId', 'text',
    'draftSource', 'providerRecovery', 'preparedAt'], 'access provider continuation');
  const previous = validateForgeDeliveryPhaseState(databaseResume.previousState, catalog);
  const correction = currentForgeAccessAcceptedCorrection(previous);
  const attempt = previous.activeAttempt;
  const phase = currentPhase(previous, catalog);
  if (databaseResume.schemaVersion !== 'forge-access-wiring-evidence-correction/v1' || databaseResume.providerRecovery !== true
    || previous.status !== 'active' || previous.workflowId !== 'crud-production' || phase.id !== 'access-wiring' || phase.index !== 6
    || correction === null || attempt === null || correction.attemptId !== attempt.attemptId
    || previous.taskId !== taskId || previous.sessionId !== sessionId || previous.sourceCommit !== sourceCommit
    || databaseResume.rpcId !== rpcId || !UUID_PATTERN.test(databaseResume.previousExecutionId)
    || typeof databaseResume.text !== 'string' || !databaseResume.text.trim() || databaseResume.text.includes('\0')
    || hasGlobalReadOnlyIntent(databaseResume.text) || canonicalStringify(databaseResume.originAttempt) !== canonicalStringify(attempt)
    || path.basename(path.dirname(stateFile)) !== 'access-wiring-repair'
    || path.basename(path.dirname(path.dirname(stateFile))) !== 'runtime-access-repair') {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Provider recovery requires the current fixed accepted-access correction.');
  }
  const base = await inspectForgeDeliveryBrowserPhase({ stateFile, state: previous, catalog, artifactsDirectory,
    originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId: attempt.rpcId });
  const directory = path.join(path.dirname(stateFile), 'browser-attempts', databaseResume.previousExecutionId);
  const [execution, baseline, begin, capture, savedProof, draft] = await Promise.all([
    'execution.json', 'session-baseline.json', 'begin.json', '阶段终态采集.json', '权限阶段-供应方故障证明.json', '供应方故障候选绑定.json',
  ].map(name => readJsonFile(path.join(directory, name), MAX_RESPONSE_BYTES, name)));
  exactKeys(capture, ['providerFailureProof'], 'failed access provider capture');
  validateProtectedExecutionContext(execution);
  validateForgeAccessProviderFailureProof({ execution, baseline, proof: capture.providerFailureProof });
  if (execution.executionId !== databaseResume.previousExecutionId || execution.taskId !== taskId
    || execution.dshSessionId !== sessionId || execution.sourceCommit !== sourceCommit
    || execution.phaseCatalogVersion !== previous.catalogVersion || execution.phaseCatalogDigest !== previous.catalogDigest
    || execution.testOnly !== false || execution.rpcId !== attempt.rpcId || execution.generation !== attempt.executionGeneration
    || execution.textDigest !== attempt.promptDigest || begin.schemaVersion !== 'forge-delivery-browser-phase-begin/v1'
    || begin.workflowId !== previous.workflowId || begin.phaseId !== phase.id || begin.phaseIndex !== phase.index
    || canonicalStringify(begin.attempt) !== canonicalStringify(attempt)
    || canonicalStringify(savedProof) !== canonicalStringify(capture.providerFailureProof)) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Provider failure must bind the actual current writer and original error terminal.');
  }
  const draftSource = databaseResume.draftSource;
  exactKeys(draftSource, ['sourceCommit', 'workspaceFingerprint', 'snapshotDigest', 'changedPaths'], 'failed access draft');
  if (draftSource.sourceCommit !== sourceCommit || !SHA256_PATTERN.test(draftSource.workspaceFingerprint)
    || !SHA256_PATTERN.test(draftSource.snapshotDigest) || !Array.isArray(draftSource.changedPaths)
    || canonicalStringify(draft) !== canonicalStringify({ snapshotDigest: draftSource.snapshotDigest, changedPaths: draftSource.changedPaths })
    || draftSource.changedPaths.some(candidate => typeof candidate !== 'string' || !phase.ownedPaths.some(owned => isForgeTaskOwnedPath(candidate, owned)))) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Provider recovery cannot replace the retained scoped draft.');
  }
  const controlDirectory = path.dirname(path.dirname(path.dirname(path.dirname(stateFile))));
  if (path.basename(controlDirectory) !== 'phase-control') fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Provider recovery directory changed.');
  const workspace = path.join(path.dirname(path.dirname(path.dirname(path.dirname(controlDirectory)))), taskId, 'workspace');
  const before = await readJsonFile(path.join(path.dirname(stateFile), 'phase-6-workspace-before.json'), MAX_RESPONSE_BYTES, 'access baseline');
  const observed = await observeForgeDeliveryPhase({ workspace, baseCommit: sourceCommit, before });
  if (observed.snapshot.snapshotDigest !== draftSource.snapshotDigest
    || canonicalStringify(observed.phaseChangedPaths) !== canonicalStringify(draftSource.changedPaths)) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Provider recovery source changed after capture.');
  }
  for (const [name, bytes] of [
    ['累计变更文件.json', Buffer.from(`${JSON.stringify(observed.allChangedPaths)}\n`)],
    ['本阶段变更文件.json', Buffer.from(`${JSON.stringify(observed.phaseChangedPaths)}\n`)],
    ['本阶段实际变更.patch', observed.phasePatch], ['累计实际变更.patch', observed.cumulativePatch],
  ]) if (!(await boundedRegularFile(path.join(directory, name), MAX_PATCH_BYTES, name)).equals(bytes)) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Provider recovery must preserve the captured partial changes.');
  }
  const promptText = `${base.promptText}\n\n## 当前权限修复的供应方错误恢复\n原错误终态与已写变更保留，未完成验证或验收。本次消耗原有一次技术恢复额度，沿同一尝试继续必要修复和验证；仍须完整阶段产物及当前源码的正式 Host 回执。\n\n${databaseResume.text}`;
  if (Buffer.byteLength(promptText, 'utf8') > MAX_PROMPT_BYTES) fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Continuation exceeds prompt limit.');
  const promptDigest = digestDirectUserTextContent([{ type: 'text', text: promptText }]);
  const replay = state.activeAttempt?.rpcId === rpcId;
  const failureEvidenceDigest = sha256(await boundedRegularFile(path.join(directory, '权限阶段-供应方故障证明.json'), MAX_RESPONSE_BYTES, 'provider failure proof'));
  const recovered = recordForgeAccessProviderRecovery({ state: previous, catalog, rpcId, promptDigest,
    executionGeneration: replay ? state.activeAttempt.executionGeneration : previous.lastExecutionGeneration + 1,
    failureEvidenceDigest, workspaceFingerprint: draftSource.workspaceFingerprint, now: databaseResume.preparedAt });
  const expected = replay ? recovered.state : previous;
  if (state.stateDigest !== expected.stateDigest) fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Access state changed after provider recovery preparation.');
  return Object.freeze({ ...base, stateDigest: state.stateDigest, rpcId, promptText, promptDigest,
    idempotent: replay, activeExecutionGeneration: state.activeAttempt.executionGeneration });
}

async function inspectDatabaseLeaseResume({ stateFile, state, catalog, artifactsDirectory,
  originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, databaseResume }) {
  if (databaseResume.providerRecovery === true) return inspectAccessProviderResume({
    stateFile, state, catalog, artifactsDirectory, originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, databaseResume });
  if (databaseResume.schemaVersion === 'forge-access-wiring-context-recovery/v1') return inspectAccessContextResume({
    stateFile, state, catalog, artifactsDirectory, originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, databaseResume });
  exactKeys(databaseResume, ['schemaVersion', 'previousState', 'originAttempt', 'previousExecutionId', 'rpcId', 'text',
    ...(databaseResume.draftSource === undefined ? [] : ['draftSource']),
    ...(databaseResume.phasePathsCorrection === undefined ? [] : ['phasePathsCorrection'])], 'database lease continuation');
  const previous = validateForgeDeliveryPhaseState(databaseResume.previousState, catalog);
  const backendResume = ['forge-backend-lease-pause/v1', 'forge-backend-evidence-correction/v1'].includes(databaseResume.schemaVersion);
  const frontendResume = ['forge-frontend-lease-pause/v1', 'forge-frontend-evidence-correction/v1'].includes(databaseResume.schemaVersion);
  const accessWiringResume = ['forge-access-wiring-lease-pause/v1', 'forge-access-wiring-evidence-correction/v1'].includes(databaseResume.schemaVersion);
  const implementationResume = backendResume || frontendResume || accessWiringResume;
  const phaseId = accessWiringResume ? 'access-wiring' : frontendResume ? 'frontend' : backendResume ? 'backend' : 'database';
  const phaseIndex = accessWiringResume ? 6 : frontendResume ? 5 : backendResume ? 4 : 2;
  const evidenceCorrection = ['forge-database-evidence-correction/v1', 'forge-backend-evidence-correction/v1', 'forge-frontend-evidence-correction/v1', 'forge-access-wiring-evidence-correction/v1'].includes(databaseResume.schemaVersion);
  const phasePathsCorrection = databaseResume.phasePathsCorrection === true;
  const backendAcceptedCorrection = backendResume && evidenceCorrection
    && currentForgeAccessAcceptedCorrection(previous)?.phaseId === 'backend'
    && currentForgeAccessAcceptedCorrection(previous)?.attemptId === previous.activeAttempt?.attemptId;
  if (databaseResume.phasePathsCorrection !== undefined && (!phasePathsCorrection || !accessWiringResume || !evidenceCorrection
    || currentForgeAccessAcceptedCorrection(previous)?.attemptId !== previous.activeAttempt?.attemptId
    || path.basename(path.dirname(stateFile)) !== 'access-wiring-repair'
    || path.basename(path.dirname(path.dirname(stateFile))) !== 'runtime-access-repair')) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Path declaration correction requires the current accepted-access repair.');
  }
  if ((!implementationResume && !evidenceCorrection && databaseResume.schemaVersion !== 'forge-database-lease-pause/v1') || databaseResume.rpcId !== rpcId
    || typeof databaseResume.text !== 'string' || !databaseResume.text.trim() || databaseResume.text.includes('\0')
    || hasGlobalReadOnlyIntent(databaseResume.text) || previous.status !== 'active'
    || previous.workflowId !== 'crud-production' || previous.currentPhaseId !== phaseId
    || previous.currentPhaseIndex !== phaseIndex || previous.activeAttempt === null || previous.taskId !== taskId
    || previous.sessionId !== sessionId || previous.sourceCommit !== sourceCommit
    || !UUID_PATTERN.test(databaseResume.previousExecutionId)) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Continuation is not bound to the current database attempt.');
  }
  const origin = { ...previous, activeAttempt: databaseResume.originAttempt,
    lastExecutionGeneration: databaseResume.originAttempt?.executionGeneration, stateDigest: '' };
  origin.stateDigest = sha256(Buffer.from(canonicalStringify((({ stateDigest, ...rest }) => rest)(origin))));
  validateForgeDeliveryPhaseState(origin, catalog);
  if (origin.activeAttempt.attemptId !== previous.activeAttempt.attemptId
    || origin.activeAttempt.startedAt !== previous.activeAttempt.startedAt
    || origin.activeAttempt.executionGeneration > previous.activeAttempt.executionGeneration) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Continuation cannot replace its database attempt.');
  }
  let baseState = origin;
  const originResume = await readDatabaseLeaseResume(stateFile, origin.activeAttempt.rpcId);
  if (originResume?.providerRecovery === true) {
    const beforeRecovery = validateForgeDeliveryPhaseState(originResume.previousState, catalog);
    if (originResume.schemaVersion !== 'forge-access-wiring-evidence-correction/v1'
      || originResume.rpcId !== origin.activeAttempt.rpcId || !UUID_PATTERN.test(originResume.previousExecutionId)
      || canonicalStringify(originResume.originAttempt) !== canonicalStringify(beforeRecovery.activeAttempt)) {
      fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Continuation provider origin does not match its retained attempt.');
    }
    const failureEvidenceDigest = sha256(await boundedRegularFile(path.join(path.dirname(stateFile), 'browser-attempts',
      originResume.previousExecutionId, '权限阶段-供应方故障证明.json'), MAX_RESPONSE_BYTES, 'provider failure proof'));
    const recovered = recordForgeAccessProviderRecovery({ state: beforeRecovery, catalog,
      rpcId: origin.activeAttempt.rpcId, promptDigest: origin.activeAttempt.promptDigest,
      executionGeneration: origin.activeAttempt.executionGeneration, failureEvidenceDigest,
      workspaceFingerprint: originResume.draftSource?.workspaceFingerprint, now: originResume.preparedAt });
    if (recovered.state.stateDigest !== origin.stateDigest) {
      fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Continuation provider origin differs from its recorded recovery.');
    }
    baseState = beforeRecovery;
  }
  const base = await inspectForgeDeliveryBrowserPhase({ stateFile, state: baseState, catalog, artifactsDirectory,
    originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId: baseState.activeAttempt.rpcId });
  const directory = path.join(path.dirname(stateFile), 'browser-attempts', databaseResume.previousExecutionId);
  const [execution, baseline, begin, capture] = await Promise.all([
    'execution.json', 'session-baseline.json', 'begin.json', '阶段终态采集.json',
  ].map(name => readJsonFile(path.join(directory, name), MAX_RESPONSE_BYTES, name)));
  exactKeys(capture, ['modelResponse', 'sessionProof'], 'paused database capture');
  validateProtectedExecutionContext(execution);
  const attempt = previous.activeAttempt;
  const proof = capture.sessionProof;
  const fields = ['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint', 'workflowId',
    'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'];
  if (execution.executionId !== path.basename(directory) || execution.taskId !== previous.taskId
    || execution.dshSessionId !== previous.sessionId || execution.sourceCommit !== previous.sourceCommit
    || execution.workflowId !== previous.workflowId || execution.phaseId !== phaseId || execution.phaseIndex !== phaseIndex
    || execution.phaseCatalogVersion !== previous.catalogVersion || execution.phaseCatalogDigest !== previous.catalogDigest
    || execution.testOnly !== false || execution.authorityClass !== 'production-task-writer'
    || execution.actionCeiling !== 'workspace-write' || execution.ownedPaths.length === 0 || (!evidenceCorrection && Date.parse(execution.expiresAt) > Date.now())
    || execution.rpcId !== attempt.rpcId || execution.generation !== attempt.executionGeneration
    || execution.textDigest !== attempt.promptDigest || canonicalStringify(begin.attempt) !== canonicalStringify(attempt)
    || begin.schemaVersion !== 'forge-delivery-browser-phase-begin/v1' || begin.workflowId !== previous.workflowId
    || begin.phaseId !== phaseId || begin.phaseIndex !== phaseIndex
    || proof?.schemaVersion !== 'forge-delivery-phase-browser-session-proof/v1'
    || baseline?.schemaVersion !== 'forge-delivery-phase-browser-session-baseline/v1'
    || fields.some((key) => proof[key] !== execution[key] || baseline[key] !== execution[key])
    || proof.terminalReason !== 'completed' || proof.hostReceiptsDerived !== false
    || proof.baselineObservedSeq !== baseline.observedSeq || baseline.sessionCwd !== '/workspace'
    || proof.sessionCwd !== baseline.sessionCwd || !Number.isSafeInteger(proof.requestSeq)
    || !Number.isSafeInteger(proof.assistantMessageSeq) || !Number.isSafeInteger(proof.terminalSeq)
    || proof.requestSeq <= baseline.observedSeq || proof.assistantMessageSeq <= proof.requestSeq
    || proof.terminalSeq <= proof.assistantMessageSeq || !SHA256_PATTERN.test(proof.terminalEventDigest)
    || typeof capture.modelResponse !== 'string' || sha256(Buffer.from(capture.modelResponse)) !== proof.modelResponseSha256
) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Continuation requires the retained expired database writer and completed terminal.');
  }

  const proposal = parseForgeDeliveryPhaseProposal({ text: capture.modelResponse, phase: currentPhase(previous, catalog) });
  const draftSource = databaseResume.draftSource;
  const failedDraft = draftSource !== undefined;
  const paths = proposal.payload.changedPaths;
  if (!Array.isArray(paths)) fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Database proposal paths are invalid.');
  const observedPaths = phasePathsCorrection ? draftSource?.changedPaths : paths;
  if (phasePathsCorrection && (!Array.isArray(observedPaths) || paths.length === 0 || paths.length >= observedPaths.length
    || new Set(paths).size !== paths.length || new Set(observedPaths).size !== observedPaths.length
    || paths.some(candidate => typeof candidate !== 'string' || !observedPaths.includes(candidate))
    || proposal.unresolvedDecisions.length !== 0)) {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Only an incomplete strict subset of the observed phase paths can be corrected.');
  }
  if (failedDraft) {
    exactKeys(draftSource, ['sourceCommit', 'workspaceFingerprint', 'snapshotDigest', 'changedPaths'], 'paused database draft');
    if ((frontendResume && !evidenceCorrection && !isForgeFrontendLeasePauseProposal(proposal))
      || (accessWiringResume && !evidenceCorrection && !isForgeAccessWiringLeasePauseProposal(proposal))
      || (backendResume && !evidenceCorrection && (proposal.payload.redTests?.status !== 'not_created'
      || proposal.payload.redTests.verification?.status !== 'failed_before_execution'
      || proposal.payload.redTests.verification.executionProven !== false
      || proposal.payload.redTests.verification.errorCode !== 'ACCEPTANCE_CANDIDATE_BINDING_MISMATCH'))
      || (!implementationResume && !evidenceCorrection && (proposal.payload.migrationVersion?.status !== 'written_not_applied'
      || proposal.payload.migrationVersion.liveDatabaseApplied !== false
      || proposal.payload.migrationTest?.latestModuleRun?.status !== 'failed'
      || !Number.isSafeInteger(proposal.payload.migrationTest.latestModuleRun.failed)
      || proposal.payload.migrationTest.latestModuleRun.failed < 1))
      || draftSource.sourceCommit !== previous.sourceCommit || !SHA256_PATTERN.test(draftSource.workspaceFingerprint)
      || !SHA256_PATTERN.test(draftSource.snapshotDigest) || !Array.isArray(draftSource.changedPaths)
      || observedPaths.length === 0 || canonicalStringify([...observedPaths].sort()) !== canonicalStringify([...draftSource.changedPaths].sort())
      || observedPaths.some(candidate => typeof candidate !== 'string' || !currentPhase(previous, catalog).ownedPaths.some(owned => isForgeTaskOwnedPath(candidate, owned)))) {
      fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Continuation requires the exact scoped written-but-failed database draft.');
    }
  } else if (implementationResume || paths.length !== 0 || proposal.payload.migrationVersion?.status !== 'not_written') {
    fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Only an unwritten database proposal can resume without a draft binding.');
  }
  for (const name of ['累计变更文件.json', '本阶段变更文件.json']) {
    const changed = await readJsonFile(path.join(directory, name), MAX_RESPONSE_BYTES, name);
    if (!Array.isArray(changed) || (failedDraft
      ? ((!implementationResume || name === '本阶段变更文件.json')
        && changed.some(candidate => !currentPhase(previous, catalog).ownedPaths.some(owned => isForgeTaskOwnedPath(candidate, owned))))
        || (name === '本阶段变更文件.json' && canonicalStringify([...changed].sort()) !== canonicalStringify([...observedPaths].sort()))
      : changed.length !== 0)) fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Database pause source observation does not match its retained draft.');
  }
  if (implementationResume) {
    const before = await readJsonFile(path.join(path.dirname(stateFile), `phase-${phaseIndex}-workspace-before.json`), MAX_RESPONSE_BYTES, 'implementation workspace baseline');
    let controlDirectory = path.dirname(stateFile);
    if ((accessWiringResume && evidenceCorrection) || backendAcceptedCorrection) {
      if (path.basename(controlDirectory) === 'access-wiring-repair') controlDirectory = path.dirname(controlDirectory);
      const parent = path.dirname(controlDirectory);
      if (path.basename(controlDirectory) !== 'runtime-access-repair' || path.basename(parent) !== 'access-wiring-repair'
        || path.basename(path.dirname(parent)) !== 'phase-control') {
        fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Access evidence must remain in the existing fixed runtime repair.');
      }
      controlDirectory = path.dirname(parent);
    }
    const workspace = path.join(path.dirname(path.dirname(path.dirname(path.dirname(controlDirectory)))), taskId, 'workspace');
    const observed = await observeForgeDeliveryPhase({ workspace, baseCommit: previous.sourceCommit, before });
    if (phasePathsCorrection) {
      for (const [name, bytes] of [['本阶段实际变更.patch', observed.phasePatch], ['累计实际变更.patch', observed.cumulativePatch]]) {
        if (!(await boundedRegularFile(path.join(directory, name), MAX_PATCH_BYTES, 'retained phase patch')).equals(bytes)) {
          fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Path correction cannot replace the originally captured source.');
        }
      }
    }
    if (observed.snapshot.snapshotDigest !== draftSource.snapshotDigest
      || canonicalStringify([...observed.phaseChangedPaths].sort()) !== canonicalStringify([...observedPaths].sort())
      || (!(accessWiringResume && evidenceCorrection) && !backendAcceptedCorrection
        && observed.phaseChangedPaths.some(candidate => Object.hasOwn(before.entries, candidate)))) {
      fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Backend continuation cannot alter accepted upstream files or replace its current draft.');
    }
  }
  if (phasePathsCorrection) {
    const assessment = await readJsonFile(path.join(directory, '阶段候选检查结果.json'), MAX_RESPONSE_BYTES, 'path declaration assessment');
    if (assessment.status !== 'needs-attention' || assessment.code !== 'PHASE_RESPONSE_INVALID' || assessment.stateAdvanced !== false
      || assessment.phaseId !== phaseId || assessment.phaseAttemptId !== attempt.attemptId
      || assessment.modelResponseSha256 !== proof.modelResponseSha256) {
      fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Path declaration correction requires its original failed assessment.');
    }
  } else if (evidenceCorrection) {
    const preflight = await readJsonFile(path.join(directory, '阶段候选预检凭据.json'), MAX_RESPONSE_BYTES, 'database evidence preflight');
    validateRetryPreflightReceipt(preflight, { state: previous, phase: currentPhase(previous, catalog), rejection: { attemptId: attempt.attemptId } });
    const assessment = await readJsonFile(path.join(directory, '阶段候选检查结果.json'), MAX_RESPONSE_BYTES, 'database evidence assessment');
    if (!failedDraft || assessment.status !== 'preflight-ready' || assessment.code !== 'PHASE_HOST_VERIFICATION_REQUIRED'
      || assessment.phaseAttemptId !== attempt.attemptId || assessment.modelResponseSha256 !== proof.modelResponseSha256
      || canonicalStringify(preflight.changedPaths) !== canonicalStringify([...paths].sort())) {
      fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Database evidence correction requires the retained preflight-ready candidate.');
    }
  }
  const retained = failedDraft ? '已写草稿、失败检查及原终态继续保留' : '未写入候选和原终态继续保留';
  const continuation = phasePathsCorrection
    ? `## 当前权限接线阶段的变更路径声明补正\n原完成回答及路径不一致结论保留。你只声明了本轮部分变更；本阶段基线观察到的完整 changedPaths 为 ${JSON.stringify([...observedPaths].sort())}。请保留当前业务源码与原阶段基线，由你补正完整阶段产物声明，再按正常阶段预检和直接必要的 Host 验证继续。补正机会不代表阶段通过，不得复用不匹配候选的回执。`
    : evidenceCorrection
    ? `## 当前${accessWiringResume ? '权限接线' : frontendResume ? '前端' : backendResume ? '后端' : '数据库'}候选的验证证据补充\n原候选、原终态及缺少有效回执的结论继续保留。本次只沿原${accessWiringResume ? '权限接线' : frontendResume ? '前端' : backendResume ? '后端' : '数据库'}范围补充实际 Host 验证回执的 profile 与 receiptId 引用；复用未变化源码的有效检查，不能用自述结果替代平台核验。`
    : accessWiringResume
    ? '## 当前权限接线尝试的租约恢复\n上一轮租约已过期，已写候选、治理失败和未执行检查继续保留。本次以新代次授权续接同一权限接线尝试，保持六个已接受上游及原作用路径；修复并取得真实 Host 回执前不得宣称阶段通过或数据库已应用。'
    : frontendResume
    ? '## 当前前端尝试的租约恢复\n上一轮执行租约已过期，已有前端候选、未通过的 Host 检查及原终态继续保留。本次以新代次授权续接同一前端尝试，保持五个已接受上游及原作用路径。修复已有问题并完成真实检查前不得宣称通过。'
    : backendResume
    ? '## 当前后端尝试的租约恢复\n上一轮租约过期、测试写入被拒且验证未执行，原候选、失败回执与终态继续保留。本次使用新代次授权续接同一后端尝试，保持已接受的上游文件；完成真实修复与验证前不得宣称通过。'
    : `## 当前数据库尝试的租约恢复\n上一轮因签名租约过期暂停，${retained}。使用本次新代次授权续接同一数据库阶段，复用原对话中已生成的内容；未经实际写入与验证不得宣称完成。`;
  const promptText = `${base.promptText}\n\n${continuation}\n\n${databaseResume.text}`;
  if (Buffer.byteLength(promptText, 'utf8') > MAX_PROMPT_BYTES) fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Continuation exceeds prompt limit.');
  const promptDigest = digestDirectUserTextContent([{ type: 'text', text: promptText }]);
  const replay = state.activeAttempt?.rpcId === rpcId;
  const expected = replay ? (accessWiringResume ? continueForgeAccessWiringLeasePause : frontendResume ? continueForgeFrontendLeasePause : backendResume ? continueForgeBackendLeasePause : continueForgeDatabaseLeasePause)({ state: previous, catalog, rpcId, promptDigest,
    executionGeneration: state.activeAttempt.executionGeneration }) : previous;
  if (state.stateDigest !== expected.stateDigest) fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Database attempt changed after continuation preparation.');
  return Object.freeze({ ...base, stateDigest: state.stateDigest, rpcId, promptText, promptDigest,
    idempotent: replay, activeExecutionGeneration: state.activeAttempt.executionGeneration });
}

export async function prepareForgeDatabaseLeaseContinuation({ catalogFile, stateFile, artifactsDirectory,
  originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, previousExecutionId, continuationText, draftSource, evidenceCorrection = false, contextRecovery = false, phasePathsCorrection = false, providerRecovery = false }) {
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    let databaseResume = await readDatabaseLeaseResume(stateFile, rpcId);
    if (databaseResume === null) {
      const prior = await readDatabaseLeaseResume(stateFile, state.activeAttempt?.rpcId);
      if (providerRecovery && (!evidenceCorrection || contextRecovery || phasePathsCorrection)) fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Provider recovery cannot combine continuation modes.');
      if (phasePathsCorrection && (contextRecovery || !evidenceCorrection || prior?.phasePathsCorrection === true)) {
        fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Path declaration correction cannot replace or repeat its current continuation.');
      }
      if (contextRecovery) {
        if (!evidenceCorrection || state.currentPhaseId !== 'access-wiring' || state.currentPhaseIndex !== 6
          || prior?.schemaVersion !== 'forge-access-wiring-evidence-correction/v1') {
          fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Only the current access evidence correction can recover a context failure.');
        }
        draftSource = prior.draftSource;
      }
      databaseResume = { schemaVersion: contextRecovery ? 'forge-access-wiring-context-recovery/v1' : state.currentPhaseId === 'access-wiring' && state.currentPhaseIndex === 6
          ? (evidenceCorrection ? 'forge-access-wiring-evidence-correction/v1' : 'forge-access-wiring-lease-pause/v1') : state.currentPhaseId === 'frontend' && state.currentPhaseIndex === 5
          ? (evidenceCorrection ? 'forge-frontend-evidence-correction/v1' : 'forge-frontend-lease-pause/v1') : state.currentPhaseId === 'backend' && state.currentPhaseIndex === 4
          ? (evidenceCorrection ? 'forge-backend-evidence-correction/v1' : 'forge-backend-lease-pause/v1')
          : evidenceCorrection ? 'forge-database-evidence-correction/v1' : 'forge-database-lease-pause/v1', previousState: state,
        originAttempt: providerRecovery || prior?.providerRecovery === true ? state.activeAttempt : prior?.originAttempt ?? state.activeAttempt, previousExecutionId, rpcId, text: continuationText,
        ...(providerRecovery ? { providerRecovery: true, preparedAt: new Date().toISOString() } : {}),
        ...(draftSource === undefined ? {} : { draftSource }), ...(phasePathsCorrection ? { phasePathsCorrection: true } : {}) };
    } else if (databaseResume.text !== continuationText || databaseResume.previousExecutionId !== previousExecutionId) {
      fail('PHASE_CONTROLLER_DATABASE_RESUME_DENIED', 'Continuation RPC cannot be rebound.');
    }
    const prepared = await inspectDatabaseLeaseResume({ stateFile, state, catalog, artifactsDirectory,
      originalRequestFile, promptFile, sourceCommit, taskId, sessionId, rpcId, databaseResume });
    if (await readDatabaseLeaseResume(stateFile, rpcId) === null) await writeExclusive(databaseLeaseResumeFile(stateFile, rpcId, evidenceCorrection), jsonBytes(databaseResume));
    return prepared;
  });
}

function stableBrowserPreparation(value) {
  exactKeys(value, [
    'schemaVersion', 'workflowId', 'phaseId', 'phaseIndex', 'stateDigest', 'sourceCommit',
    'executionSourceCommit', 'caseFamily',
    'catalogVersion', 'catalogDigest', 'taskId', 'sessionId', 'rpcId', 'promptDigest',
    'promptFileSha256', 'promptText', 'acceptedArtifactDigests', 'phaseAuthority',
    'idempotent', 'activeExecutionGeneration',
    ...(Object.hasOwn(value ?? {}, 'acceptedApiContract') ? ['acceptedApiContract'] : []),
    ...(Object.hasOwn(value ?? {}, 'runtimeWorkspaceFingerprint') ? ['runtimeWorkspaceFingerprint'] : []),
  ], 'browser phase preparation');
  return {
    schemaVersion: value.schemaVersion,
    workflowId: value.workflowId,
    phaseId: value.phaseId,
    phaseIndex: value.phaseIndex,
    sourceCommit: value.sourceCommit,
    executionSourceCommit: value.executionSourceCommit,
    caseFamily: value.caseFamily,
    catalogVersion: value.catalogVersion,
    catalogDigest: value.catalogDigest,
    taskId: value.taskId,
    sessionId: value.sessionId,
    rpcId: value.rpcId,
    promptDigest: value.promptDigest,
    promptFileSha256: value.promptFileSha256,
    promptText: value.promptText,
    acceptedArtifactDigests: value.acceptedArtifactDigests,
    ...(Object.hasOwn(value, 'acceptedApiContract') ? { acceptedApiContract: value.acceptedApiContract } : {}),
    ...(Object.hasOwn(value, 'runtimeWorkspaceFingerprint') ? { runtimeWorkspaceFingerprint: value.runtimeWorkspaceFingerprint } : {}),
    phaseAuthority: value.phaseAuthority,
  };
}

function validateBrowserPhaseExecution({ execution, prepared, phase }) {
  let validated;
  try {
    const { idempotent, refreshed, ...context } = execution;
    if ((idempotent !== undefined && typeof idempotent !== 'boolean')
      || (refreshed !== undefined && typeof refreshed !== 'boolean')) {
      fail('PHASE_CONTROLLER_BROWSER_EXECUTION_INVALID', 'Browser execution metadata is invalid.');
    }
    validated = validateProtectedExecutionContext(context, Date.now());
  } catch {
    fail('PHASE_CONTROLLER_BROWSER_EXECUTION_INVALID', 'Browser phase execution context is invalid or expired.');
  }
  const actualPathsWithinPhase = validated.ownedPaths.every((candidate) => phase.ownedPaths.some(
    (owner) => candidate === owner || candidate.startsWith(`${owner}/`),
  ));
  if (validated.testOnly !== false
    || !['production-read-only', 'production-task-writer'].includes(validated.authorityClass)
    || validated.route !== 'session.prompt' || validated.classification !== 'claimable-text'
    || validated.mode !== 'queue' || validated.taskId !== prepared.taskId
    || validated.dshSessionId !== prepared.sessionId || validated.rpcId !== prepared.rpcId
    || validated.promptDigest !== prepared.promptDigest || validated.textDigest !== prepared.promptDigest
    || validated.sourceCommit !== prepared.executionSourceCommit
    || (validated.authorityClass === 'production-read-only'
      ? validated.caseFamily !== prepared.caseFamily
      : validated.caseFamily !== 'maintenance')
    || validated.workflowId !== prepared.workflowId || validated.phaseId !== prepared.phaseId
    || validated.phaseIndex !== prepared.phaseIndex
    || validated.phaseCatalogVersion !== prepared.catalogVersion
    || validated.phaseCatalogDigest !== prepared.catalogDigest
    || validated.actionCeiling !== phase.actionCeiling
    || !actualPathsWithinPhase
    || (phase.sourceMutation ? validated.ownedPaths.length === 0 : validated.ownedPaths.length !== 0)
    || JSON.stringify(validated.requiredProfiles) !== JSON.stringify(phase.contractVerificationProfiles)) {
    fail('PHASE_CONTROLLER_BROWSER_EXECUTION_MISMATCH', 'Browser execution does not match the current Controller phase.');
  }
  return validated;
}

export async function beginForgeDeliveryBrowserPhase({
  catalogFile,
  stateFile,
  artifactsDirectory,
  originalRequestFile,
  promptFile,
  prepared,
  execution,
}) {
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const clarification = await readRequirementsClarification(stateFile, prepared?.rpcId);
    const domainResume = await readDomainContractResume(stateFile, prepared?.rpcId);
    const databaseResume = await readDatabaseLeaseResume(stateFile, prepared?.rpcId);
    const inspect = databaseResume !== null ? inspectDatabaseLeaseResume : domainResume !== null ? inspectDomainContractResume
      : clarification === null ? inspectForgeDeliveryBrowserPhase : inspectRequirementsClarification;
    const current = await inspect({
      stateFile,
      state,
      catalog,
      artifactsDirectory,
      originalRequestFile,
      promptFile,
      sourceCommit: prepared?.executionSourceCommit,
      taskId: prepared?.taskId,
      sessionId: prepared?.sessionId,
      rpcId: prepared?.rpcId,
      promptText: prepared?.promptText,
      ...(clarification === null ? {} : { clarification }),
      ...(domainResume === null ? {} : { domainResume }),
      ...(databaseResume === null ? {} : { databaseResume }),
    });
    if (canonicalStringify(stableBrowserPreparation(prepared))
      !== canonicalStringify(stableBrowserPreparation(current))) {
      fail('PHASE_CONTROLLER_BROWSER_PREPARATION_STALE', 'Browser phase preparation is stale or belongs to another prompt.');
    }
    const phase = currentPhase(state, catalog);
    const validatedExecution = validateBrowserPhaseExecution({ execution, prepared: current, phase });
    const runtimeReprobe = await readForgeCrossLayerRuntimeReprobe({ stateFile, state });
    if (runtimeReprobe?.status === 'imported' && state.stateDigest === runtimeReprobe.stateDigest) {
      const previousExecution = await readJsonFile(path.join(path.dirname(stateFile), 'browser-attempts',
        runtimeReprobe.previousExecutionId, 'execution.json'), MAX_RESPONSE_BYTES, 'previous runtime execution');
      if (['projectSlug', 'actorUserId', 'actorUsername', 'conversationId', 'workspaceFingerprint']
        .some(key => validatedExecution[key] !== previousExecution[key])) {
        fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Runtime observation must retain its original owner and source identity.');
      }
      const continued = continueForgeCrossLayerRuntimeReprobe({ state, catalog, rpcId: validatedExecution.rpcId,
        promptDigest: validatedExecution.promptDigest, executionGeneration: validatedExecution.generation });
      await writeForgeDeliveryPhaseState(stateFile, continued, catalog);
      return Object.freeze({ schemaVersion: 'forge-delivery-browser-phase-begin/v1', workflowId: continued.workflowId,
        phaseId: continued.currentPhaseId, phaseIndex: continued.currentPhaseIndex, stateDigest: continued.stateDigest,
        attempt: Object.freeze({ ...continued.activeAttempt }), idempotent: false });
    }
    if (domainResume !== null || databaseResume !== null) {
      const previousExecution = await readJsonFile(path.join(path.dirname(stateFile), 'browser-attempts',
        (domainResume ?? databaseResume).previousExecutionId, 'execution.json'), MAX_RESPONSE_BYTES, 'interrupted execution');
      if (['projectSlug', 'actorUserId', 'actorUsername', 'conversationId']
        .some((key) => validatedExecution[key] !== previousExecution[key])
        || validatedExecution.workspaceFingerprint !== (databaseResume?.draftSource?.workspaceFingerprint ?? previousExecution.workspaceFingerprint)) {
        fail('PHASE_CONTROLLER_DOMAIN_RESUME_DENIED', 'Continuation must retain the original owner and source identity.');
      }
    }
    if ((clarification !== null || domainResume !== null || databaseResume !== null) && state.activeAttempt.rpcId !== validatedExecution.rpcId) {
      const continueAttempt = databaseResume !== null ? (['forge-access-wiring-lease-pause/v1', 'forge-access-wiring-evidence-correction/v1', 'forge-access-wiring-context-recovery/v1'].includes(databaseResume.schemaVersion)
        ? continueForgeAccessWiringLeasePause : ['forge-frontend-lease-pause/v1', 'forge-frontend-evidence-correction/v1'].includes(databaseResume.schemaVersion)
        ? continueForgeFrontendLeasePause : ['forge-backend-lease-pause/v1', 'forge-backend-evidence-correction/v1'].includes(databaseResume.schemaVersion)
          ? continueForgeBackendLeasePause : continueForgeDatabaseLeasePause) : domainResume === null ? continueForgeRequirementsPhase : continueForgeDomainContractPhase;
      const continued = databaseResume?.providerRecovery === true
        ? recordForgeAccessProviderRecovery({ state, catalog, rpcId: validatedExecution.rpcId,
          promptDigest: validatedExecution.promptDigest, executionGeneration: validatedExecution.generation,
          failureEvidenceDigest: sha256(await boundedRegularFile(path.join(path.dirname(stateFile), 'browser-attempts',
            databaseResume.previousExecutionId, '权限阶段-供应方故障证明.json'), MAX_RESPONSE_BYTES, 'provider failure proof')),
          workspaceFingerprint: databaseResume.draftSource.workspaceFingerprint, now: databaseResume.preparedAt }).state
        : continueAttempt({ state, catalog, rpcId: validatedExecution.rpcId,
          promptDigest: validatedExecution.promptDigest, executionGeneration: validatedExecution.generation });
      await writeForgeDeliveryPhaseState(stateFile, continued, catalog);
      return Object.freeze({ schemaVersion: 'forge-delivery-browser-phase-begin/v1', workflowId: continued.workflowId,
        phaseId: continued.currentPhaseId, phaseIndex: continued.currentPhaseIndex, stateDigest: continued.stateDigest,
        attempt: Object.freeze({ ...continued.activeAttempt }), idempotent: false });
    }
    if (state.activeAttempt !== null) {
      if (state.activeAttempt.rpcId !== validatedExecution.rpcId
        || state.activeAttempt.promptDigest !== validatedExecution.promptDigest
        || state.activeAttempt.executionGeneration !== validatedExecution.generation) {
        fail('PHASE_CONTROLLER_BROWSER_EXECUTION_MISMATCH', 'Active phase belongs to another protected browser execution.');
      }
      return Object.freeze({
        schemaVersion: 'forge-delivery-browser-phase-begin/v1',
        workflowId: state.workflowId,
        phaseId: state.currentPhaseId,
        phaseIndex: state.currentPhaseIndex,
        stateDigest: state.stateDigest,
        attempt: Object.freeze({ ...state.activeAttempt }),
        idempotent: true,
      });
    }
    if (prepared.stateDigest !== state.stateDigest) {
      fail('PHASE_CONTROLLER_BROWSER_PREPARATION_STALE', 'Controller state changed after browser phase preparation.');
    }
    const begun = beginForgeDeliveryPhase({
      state,
      catalog,
      phaseId: phase.id,
      rpcId: validatedExecution.rpcId,
      promptDigest: validatedExecution.promptDigest,
      executionGeneration: validatedExecution.generation,
    });
    await writeForgeDeliveryPhaseState(stateFile, begun, catalog);
    return Object.freeze({
      schemaVersion: 'forge-delivery-browser-phase-begin/v1',
      workflowId: begun.workflowId,
      phaseId: begun.currentPhaseId,
      phaseIndex: begun.currentPhaseIndex,
      stateDigest: begun.stateDigest,
      attempt: Object.freeze({ ...begun.activeAttempt }),
      idempotent: false,
    });
  });
}

export async function prepareForgeCrossLayerRuntimePrompt({
  catalogFile, stateFile, artifactsDirectory, originalRequestFile,
  runtimeEvidenceDirectory, expectedRuntimeManifestSha256, sourceRepository, promptFile, preparationBinding,
  preparationExecution, expectedPreviousManifestSha256,
}) {
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const reprobe = await readForgeCrossLayerRuntimeReprobe({ stateFile, state });
    const sequential = await sameExecutionRuntimeObservation({ stateFile, state, reprobe, preparationExecution, promptFile });
    if (sequential && expectedPreviousManifestSha256 !== reprobe.replacementManifestSha256) fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Concurrent runtime observation replacement is stale.');
    if (state.status !== 'active' || state.currentPhaseId !== 'cross-layer-acceptance'
      || state.currentPhaseIndex !== 7 || (state.activeAttempt !== null && reprobe?.status !== 'pending' && !sequential)) {
      fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Runtime input preparation requires an idle cross-layer phase.');
    }
    if (preparationBinding !== undefined && (preparationBinding.stateDigest !== state.stateDigest
      || preparationBinding.baseSourceCommit !== state.sourceCommit || !SHA256_PATTERN.test(preparationBinding.workspaceFingerprint ?? '')
      || canonicalStringify(preparationBinding.acceptedArtifactDigests) !== canonicalStringify(state.acceptedArtifacts))) {
      fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Preparation input does not match accepted source.');
    }
    const acceptedArtifacts = await loadAcceptedArtifacts({ state, catalog, artifactsDirectory });
    const bundle = await loadForgeCrossLayerRuntimeEvidence({
      directory: runtimeEvidenceDirectory, expectedManifestSha256: expectedRuntimeManifestSha256,
      state, catalog, acceptedArtifacts, sourceRepository,
    });
    if (reprobe !== null && (bundle.runtimeSource.commit !== reprobe.candidateCommit || bundle.runtimeSource.tree !== reprobe.candidateTree
      || bundle.subject.cumulativePatchSha256 !== reprobe.acceptedPatchSha256 || preparationBinding?.workspaceFingerprint !== reprobe.workspaceFingerprint
      || ['deployment', 'api', 'database', 'browser'].some(kind => {
        const document = bundle.evidence[kind];
        return document.stateDigest !== state.stateDigest || document.taskId !== state.taskId || document.baseSourceCommit !== state.sourceCommit
          || document.workspaceFingerprint !== reprobe.workspaceFingerprint || document.candidateTree !== reprobe.candidateTree
          || document.acceptedPatchSha256 !== reprobe.acceptedPatchSha256
          || [reprobe.previousObservationId, reprobe.replacementObservationId, ...(reprobe.retainedObservations ?? []).map(item => item.observationId)].includes(document.observationId)
          || !/^[0-9a-f-]{36}$/u.test(document.observationId ?? '') || document.observationId !== bundle.evidence.deployment.observationId;
      }))) fail('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', 'Replacement observation differs from the retained candidate or is not new.');
    const prompt = buildForgeDeliveryPhasePrompt({ state, catalog,
      originalRequest: requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, ''),
      upstreamArtifacts: acceptedArtifacts, runtimeEvidence: bundle, runtimeObservationContinuation: reprobe !== null });
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      fail('PHASE_CONTROLLER_INPUT_INVALID', 'Runtime evidence exceeds the existing prompt size limit.');
    }
    const bytes = jsonBytes(bundle);
    const receipt = { schemaVersion: 'forge-cross-layer-runtime-input-receipt/v1',
      sourceStateDigest: state.stateDigest, sessionId: state.sessionId,
      lastExecutionGeneration: state.lastExecutionGeneration, acceptedArtifacts: state.acceptedArtifacts,
      manifestSha256: bundle.manifestSha256, bundleSha256: sha256(bytes),
      promptDigest: digestDirectUserTextContent([{ type: 'text', text: prompt }]),
      promptSha256: sha256(Buffer.from(`${prompt}\n`, 'utf8')),
      modelStarted: false, acceptedStageCountChanged: false,
      ...(preparationBinding === undefined ? {} : { preparationBinding }) };
    const directory = path.dirname(stateFile);
    const retainedObservations = [...(reprobe?.retainedObservations ?? [])];
    if (sequential) {
      const retained = { observationId: reprobe.replacementObservationId, manifestSha256: reprobe.replacementManifestSha256, sha256: {} };
      for (const [name, file] of Object.entries({ 'runtime-evidence.json': path.join(directory, 'runtime-evidence.json'),
        'runtime-input-receipt.json': path.join(directory, 'runtime-input-receipt.json'), 'current-prompt.md': promptFile })) {
        const previous = await boundedRegularFile(file, name.endsWith('.md') ? MAX_PROMPT_BYTES : MAX_RESPONSE_BYTES, name, { trustedReview: true });
        retained.sha256[name] = sha256(previous);
        await writeExclusive(path.join(reprobe.archiveDirectory, 'imported-observations', retained.observationId, name), previous);
      }
      retainedObservations.push(retained);
    }
    const writeInput = reprobe === null ? writeExclusive : writeAtomic;
    await writeInput(path.join(directory, 'runtime-evidence.json'), bytes);
    await writeInput(path.join(directory, 'runtime-input-receipt.json'), jsonBytes(receipt));
    await writeAtomic(promptFile, Buffer.from(`${prompt}\n`, 'utf8'));
    if (reprobe !== null) await writeAtomic(path.join(directory, 'runtime-reprobe.json'), jsonBytes({ ...reprobe,
      status: 'imported', ...(retainedObservations.length === 0 ? {} : { retainedObservations }), replacementManifestSha256: bundle.manifestSha256, replacementObservationId: bundle.evidence.deployment.observationId,
      replacementSha256: { 'runtime-evidence.json': sha256(bytes), 'runtime-input-receipt.json': sha256(jsonBytes(receipt)),
        'current-prompt.md': receipt.promptSha256 } }));
    return Object.freeze(receipt);
  });
}

export async function prepareForgeCrossLayerContinuation({
  catalogFile, sourceCaseDirectory, bindingsFile, expectedBindingsSha256,
  sourceCommit, originalRequestFile, outputDirectory,
}) {
  requiredId(expectedBindingsSha256, SHA256_PATTERN, 'expectedBindingsSha256');
  requiredId(sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  if (![sourceCaseDirectory, outputDirectory].every((value) => typeof value === 'string' && path.isAbsolute(value))
    || realpathSync(sourceCaseDirectory) !== sourceCaseDirectory
    || outputDirectory === sourceCaseDirectory
    || outputDirectory.startsWith(`${sourceCaseDirectory}${path.sep}`)
    || sourceCaseDirectory.startsWith(`${outputDirectory}${path.sep}`)) {
    fail('PHASE_CONTROLLER_PATH_INVALID', 'Cross layer continuation requires a separate ordinary accepted case path.');
  }
  const bindingsBytes = await boundedRegularFile(bindingsFile, MAX_RESPONSE_BYTES,
    'reviewed cross layer continuation bindings', { trustedReview: true });
  if (sha256(bindingsBytes) !== expectedBindingsSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Reviewed cross layer continuation bindings changed.');
  }
  const bindings = JSON.parse(bindingsBytes.toString('utf8'));
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation', 'frontend-implementation',
    'access-wiring-implementation'];
  const phaseNames = ['requirements', 'domain-contract', 'database', 'ui-design', 'backend', 'frontend', 'access-wiring'];
  const profiles = ['governance', 'backend-module-test'];
  const evidenceFiles = ['model.stdout.txt', 'controller-preflight-receipt.json',
    'independent-semantic-review.json', 'all-changed-paths.json', 'phase-changed-paths.json',
    'phase.patch', 'cumulative.patch', 'phase-host-receipts.json', 'controller-cli-receipt.json',
    ...profiles.map((profile) => `host-runner/${profile}/host-profile.receipt.json`)];
  exactKeys(bindings, ['schemaVersion', 'sourceStateSha256', 'originalRequestSha256',
    'artifactSha256', 'evidenceSha256', 'currentPromptSha256'], 'cross layer continuation bindings');
  exactKeys(bindings.artifactSha256, kinds, 'cross layer continuation accepted artifact hashes');
  exactKeys(bindings.evidenceSha256, evidenceFiles, 'cross layer continuation evidence hashes');
  if (bindings.schemaVersion !== 'forge-delivery-cross-layer-continuation-bindings/v1'
    || ![bindings.sourceStateSha256, bindings.originalRequestSha256, bindings.currentPromptSha256,
      ...Object.values(bindings.artifactSha256), ...Object.values(bindings.evidenceSha256)]
      .every((digest) => SHA256_PATTERN.test(digest))) {
    fail('PHASE_CONTROLLER_INPUT_INVALID', 'Cross layer continuation hashes are invalid.');
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  const stateFile = path.join(sourceCaseDirectory, 'phase-control/state.json');
  const stateBytes = await boundedRegularFile(stateFile, MAX_RESPONSE_BYTES, 'accepted access wiring state');
  if (sha256(stateBytes) !== bindings.sourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Accepted access wiring state differs from reviewed bytes.');
  }
  const state = validateForgeDeliveryPhaseState(JSON.parse(stateBytes.toString('utf8')), catalog);
  const accepted = await loadAcceptedArtifacts({ state, catalog,
    artifactsDirectory: path.join(sourceCaseDirectory, 'phase-control/artifacts') });
  const acceptedHistory = state.history.filter((entry) => entry.decision === 'accepted');
  const accessAcceptance = state.history.at(-1);
  if (state.schemaVersion !== 'forge-delivery-phase-state/v2' || state.sourceCommit !== sourceCommit
    || state.caseFamily !== 'crud-complete' || state.status !== 'active'
    || state.currentPhaseId !== 'cross-layer-acceptance' || state.currentPhaseIndex !== 7
    || state.activeAttempt !== null || state.lastExecutionGeneration !== 14
    || accepted.length !== 7 || acceptedHistory.length !== 7
    || acceptedHistory.some((entry, index) => entry.phaseIndex !== index
      || entry.phaseId !== phaseNames[index] || entry.artifactDigest !== state.acceptedArtifacts[kinds[index]])
    || accessAcceptance?.phaseId !== 'access-wiring' || accessAcceptance?.phaseIndex !== 6
    || accessAcceptance?.decision !== 'accepted' || accessAcceptance?.executionGeneration !== 14
    || accessAcceptance.artifactDigest !== state.acceptedArtifacts['access-wiring-implementation']) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only seven genuinely accepted phases immediately before cross-layer acceptance can continue.');
  }
  const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
  const promptFile = path.join(sourceCaseDirectory, 'phase-control/current-prompt.md');
  const promptBytes = await boundedRegularFile(promptFile, MAX_PROMPT_BYTES, 'Controller-generated cross-layer prompt');
  if (sha256(requestBytes) !== bindings.originalRequestSha256
    || sha256(promptBytes) !== bindings.currentPromptSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Original request or next prompt differs from reviewed bytes.');
  }
  const artifactBytes = new Map();
  for (const kind of kinds) {
    const bytes = await boundedRegularFile(path.join(sourceCaseDirectory, 'phase-control/artifacts', `${kind}.json`),
      MAX_RESPONSE_BYTES, `accepted ${kind}`);
    if (sha256(bytes) !== bindings.artifactSha256[kind]) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', `Accepted ${kind} differs from reviewed bytes.`);
    }
    artifactBytes.set(kind, bytes);
  }
  const evidenceDirectory = path.join(sourceCaseDirectory, 'phases/07-access-wiring/attempts/02');
  const evidenceBytes = new Map();
  for (const relative of evidenceFiles) {
    const bytes = await boundedRegularFile(path.join(evidenceDirectory, relative),
      relative.endsWith('.patch') ? MAX_PATCH_BYTES : MAX_RESPONSE_BYTES,
      `accepted access wiring ${relative}`, { trustedReview: relative === 'independent-semantic-review.json' });
    if (sha256(bytes) !== bindings.evidenceSha256[relative]) {
      fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', `Accepted access wiring ${relative} differs from reviewed bytes.`);
    }
    evidenceBytes.set(relative, bytes);
  }
  const preflight = JSON.parse(evidenceBytes.get('controller-preflight-receipt.json').toString('utf8'));
  const review = JSON.parse(evidenceBytes.get('independent-semantic-review.json').toString('utf8'));
  const finalized = JSON.parse(evidenceBytes.get('controller-cli-receipt.json').toString('utf8'));
  const hostReceipts = JSON.parse(evidenceBytes.get('phase-host-receipts.json').toString('utf8'));
  const originalHostReceipts = profiles.map((profile) => JSON.parse(
    evidenceBytes.get(`host-runner/${profile}/host-profile.receipt.json`).toString('utf8')));
  if (preflight.phaseId !== 'access-wiring' || preflight.phaseIndex !== 6
    || preflight.phaseAttemptId !== accessAcceptance.attemptId
    || preflight.candidateArtifactDigest !== accessAcceptance.artifactDigest
    || preflight.phasePatchDigest !== sha256(evidenceBytes.get('phase.patch'))
    || preflight.cumulativePatchDigest !== sha256(evidenceBytes.get('cumulative.patch'))
    || JSON.stringify(preflight.changedPaths)
      !== JSON.stringify(normalizedChangedPaths(JSON.parse(evidenceBytes.get('phase-changed-paths.json').toString('utf8'))))
    || review.verdict !== 'PASS' || review.subject?.phaseId !== 'access-wiring'
    || review.subject?.responseSha256 !== bindings.evidenceSha256['model.stdout.txt']
    || review.subject?.candidateArtifactDigest !== accessAcceptance.artifactDigest
    || finalized.schemaVersion !== 'forge-delivery-phase-controller-finalize/v1'
    || finalized.acceptedPhaseId !== 'access-wiring' || finalized.acceptedPhaseIndex !== 6
    || finalized.phaseArtifactDigest !== accessAcceptance.artifactDigest
    || finalized.phasePatchDigest !== accessAcceptance.patchDigest
    || finalized.cumulativePatchDigest !== preflight.cumulativePatchDigest
    || finalized.stateDigest !== state.stateDigest || finalized.nextPhaseId !== 'cross-layer-acceptance'
    || (finalized.nextPromptPendingReason === 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED'
      ? finalized.nextPromptDigest !== null
        || !currentPhase(state, catalog).requiredPayloadKeys.includes('runtimeEvidenceDigest')
      : finalized.nextPromptDigest !== sha256(Buffer.from(promptBytes.toString('utf8').replace(/\n$/u, ''), 'utf8')))
    || !Array.isArray(hostReceipts) || hostReceipts.length !== profiles.length
    || JSON.stringify(preflight.hostVerificationProfiles) !== JSON.stringify(profiles)
    || profiles.some((profile, index) => hostReceipts[index]?.profile !== profile
      || hostReceipts[index]?.status !== 'passed'
      || hostReceipts[index]?.receiptDigest !== sha256(evidenceBytes.get(`host-runner/${profile}/host-profile.receipt.json`))
      || hostReceipts[index]?.patchDigest !== preflight.cumulativePatchDigest
      || accessAcceptance.hostReceiptDigests[index] !== hostReceipts[index]?.receiptDigest
      || originalHostReceipts[index]?.receipt?.status !== 'passed'
      || originalHostReceipts[index]?.receipt?.source?.head !== sourceCommit
      || originalHostReceipts[index]?.receipt?.request?.profile !== profile
      || originalHostReceipts[index]?.receipt?.policy?.profileCatalogVersion !== state.catalogVersion
      || originalHostReceipts[index]?.receipt?.source?.workspaceFingerprint
        !== originalHostReceipts[0]?.receipt?.source?.workspaceFingerprint)) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Accepted access wiring review, Host or finalize evidence does not authorize continuation.');
  }
  if (sha256(await boundedRegularFile(stateFile, MAX_RESPONSE_BYTES, 'accepted access wiring state')) !== bindings.sourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Accepted access wiring state changed during continuation admission.');
  }
  const control = path.join(outputDirectory, 'phase-control');
  await writeExclusive(path.join(control, 'state.json'), stateBytes);
  await writeExclusive(path.join(control, 'current-prompt.md'), promptBytes);
  for (const [kind, bytes] of artifactBytes) await writeExclusive(path.join(control, 'artifacts', `${kind}.json`), bytes);
  const receipt = Object.freeze({ schemaVersion: 'forge-delivery-cross-layer-continuation/v1',
    sourceStateSha256: bindings.sourceStateSha256, bindingsSha256: expectedBindingsSha256,
    sourceCommit, catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest,
    taskId: state.taskId, sessionId: state.sessionId,
    parentLastExecutionGeneration: state.lastExecutionGeneration,
    nextExecutionGenerationMinimum: state.lastExecutionGeneration + 1,
    inheritedArtifactDigests: Object.fromEntries(kinds.map((kind) => [kind, state.acceptedArtifacts[kind]])),
    stateDigest: state.stateDigest, promptSha256: bindings.currentPromptSha256,
    cumulativePatchSha256: bindings.evidenceSha256['cumulative.patch'],
    inheritedStageCount: 7, newAcceptedStageCount: 0, newModelStarted: false,
    parentStateUnchanged: true });
  await writeExclusive(path.join(control, 'cross-layer-continuation-receipt.json'), jsonBytes(receipt));
  return receipt;
}

async function accessWiringRepairInputs({ catalogFile, sourceStateFile, expectedSourceStateSha256,
  sourceArtifactsDirectory, sourceCommit, originalRequestFile, outputDirectory, repairRequestText,
  failureEvidenceFile, expectedFailureEvidenceSha256, acceptedCorrection = false }) {
  requiredId(expectedSourceStateSha256, SHA256_PATTERN, 'expectedSourceStateSha256');
  requiredId(expectedFailureEvidenceSha256, SHA256_PATTERN, 'expectedFailureEvidenceSha256');
  requiredId(sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  const parentDirectory = path.dirname(sourceStateFile);
  const runtimeParent = path.basename(parentDirectory) === 'runtime-access-repair'
    && path.basename(path.dirname(parentDirectory)) === 'access-wiring-repair'
    && path.basename(path.dirname(path.dirname(parentDirectory))) === 'phase-control';
  const finalParent = path.basename(parentDirectory) === 'access-wiring-repair'
    && path.basename(path.dirname(parentDirectory)) === 'runtime-access-repair'
    && path.basename(path.dirname(path.dirname(parentDirectory))) === 'access-wiring-repair'
    && path.basename(path.dirname(path.dirname(path.dirname(parentDirectory)))) === 'phase-control';
  if (![sourceStateFile, sourceArtifactsDirectory, originalRequestFile, outputDirectory, failureEvidenceFile]
    .every(file => typeof file === 'string' && path.isAbsolute(file))
    || (acceptedCorrection ? !finalParent
      : ['access-wiring-repair', 'runtime-access-repair'].includes(path.basename(parentDirectory)) && !runtimeParent)
    || outputDirectory !== (acceptedCorrection ? parentDirectory : path.join(parentDirectory, 'access-wiring-repair'))
    || !/^runtime-preparations\/[0-9a-f-]{36}\/migration-failure\.json$/u.test(
      path.relative(path.dirname(sourceStateFile), failureEvidenceFile).replaceAll('\\', '/'))) {
    fail('PHASE_CONTROLLER_PATH_INVALID', 'Access repair requires the fixed private parent, failure and child paths.');
  }
  boundedReviewText(repairRequestText, MAX_PROMPT_BYTES, 'access repair feedback');
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  const parentBytes = await boundedRegularFile(sourceStateFile, MAX_RESPONSE_BYTES, 'access repair parent');
  if (sha256(parentBytes) !== expectedSourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Accepted parent changed before access repair.');
  }
  const parent = validateForgeDeliveryPhaseState(JSON.parse(parentBytes.toString('utf8')), catalog);
  const priorCorrections = parent.history.filter(item => item.schemaVersion === 'forge-delivery-access-accepted-correction/v1');
  if (acceptedCorrection && priorCorrections.some(item => item.acceptedReceiptDigest === parent.history.at(-1)?.receiptDigest
    || item.artifactDigest === parent.acceptedArtifacts['access-wiring-implementation']
    || item.failureEvidenceSha256 === expectedFailureEvidenceSha256)) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'The accepted candidate or protected failure has already been corrected.');
  }
  if (parent.workflowId !== 'crud-production' || parent.status !== 'active'
    || parent.currentPhaseId !== 'cross-layer-acceptance' || parent.currentPhaseIndex !== 7
    || parent.activeAttempt !== null || parent.sourceCommit !== sourceCommit
    || Object.keys(parent.acceptedArtifacts).length !== 7) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only an idle cross-layer parent with seven accepted phases may repair access wiring.');
  }
  const accepted = await loadAcceptedArtifacts({ state: parent, catalog, artifactsDirectory: sourceArtifactsDirectory });
  const phases = catalog.workflows.find(item => item.id === parent.workflowId).phases;
  const acceptedHistory = parent.history.filter(item => item.decision === 'accepted'
    && parent.acceptedArtifacts[phases[item.phaseIndex]?.artifactKind] === item.artifactDigest);
  const artifacts = new Map(accepted.map(artifact => [artifact.artifactKind, artifact]));
  if (acceptedHistory.length !== 7 || phases.slice(0, 7).some((phase, index) => {
    const artifact = artifacts.get(phase.artifactKind);
    const receipt = acceptedHistory[index];
    return receipt.phaseId !== phase.id || receipt.phaseIndex !== index || artifact.phaseId !== phase.id
      || artifact.attemptId !== receipt.attemptId || artifact.artifactDigest !== receipt.artifactDigest
      || artifact.patchDigest !== receipt.patchDigest || artifact.unresolvedDecisions.length !== 0
      || canonicalStringify(artifact.upstreamArtifactDigests) !== canonicalStringify(Object.fromEntries(
        phase.requiresArtifacts.map(kind => [kind, parent.acceptedArtifacts[kind]])))
      || phase.requiredPayloadKeys.some(key => !Object.hasOwn(artifact.payload, key))
      || (phase.patchScope === 'none' && (artifact.changedPaths.length !== 0
        || artifact.sourceFingerprint !== (index === 0 ? EMPTY_SHA256 : artifacts.get(phases[index - 1].artifactKind).sourceFingerprint)));
  })) fail('PHASE_CONTROLLER_UPSTREAM_STALE', 'Accepted inputs do not match their retained phase history.');
  const failureBytes = await boundedRegularFile(failureEvidenceFile, MAX_RESPONSE_BYTES,
    'protected migration failure', { trustedReview: true });
  if (sha256(failureBytes) !== expectedFailureEvidenceSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Protected migration failure changed.');
  }
  const failure = JSON.parse(failureBytes.toString('utf8'));
  if (acceptedCorrection && priorCorrections.some(item => item.jobId === failure.jobId || item.executionId === failure.executionId
    || item.acceptedSourceFingerprint === failure.acceptedPatchSha256)) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'A consumed source candidate or protected failure cannot authorize another correction.');
  }
  if (failure.schemaVersion !== 'forge-cross-layer-preparation-failure/v1' || failure.status !== 'failed'
    || failure.failedStage !== 'test-database-migration' || failure.taskId !== parent.taskId
    || failure.sessionId !== parent.sessionId || failure.parentStateDigest !== parent.stateDigest
    || failure.baseSourceCommit !== parent.sourceCommit
    || canonicalStringify(failure.acceptedArtifactDigests) !== canonicalStringify(parent.acceptedArtifacts)
    || !SHA256_PATTERN.test(failure.workspaceFingerprint ?? '')
    || !UUID_PATTERN.test(failure.executionId ?? '') || !UUID_PATTERN.test(failure.jobId ?? '')
    || !SOURCE_COMMIT_PATTERN.test(failure.candidateCommit ?? '') || !SOURCE_COMMIT_PATTERN.test(failure.candidateTree ?? '')
    || failure.acceptedPatchSha256 !== artifacts.get(phases[6].artifactKind).sourceFingerprint
    || !Number.isSafeInteger(failure.executionGeneration) || failure.executionGeneration <= parent.lastExecutionGeneration
    || !Number.isFinite(Date.parse(failure.startedAt)) || !Number.isFinite(Date.parse(failure.completedAt))
    || Date.parse(failure.startedAt) < Date.parse(parent.history.at(-1).completedAt)
    || Date.parse(failure.completedAt) < Date.parse(failure.startedAt)
    || !SHA256_PATTERN.test(failure.runnerEvidenceSha256 ?? '') || !SHA256_PATTERN.test(failure.sourceBindingSha256 ?? '')) {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Migration failure is not bound to the accepted parent and its actual preparation.');
  }
  for (const key of ['actorUserId', 'actorUsername', 'conversationId', 'rpcId', 'errorCode']) {
    boundedReviewText(failure[key], 512, `migration failure ${key}`);
  }
  const inheritedHistory = parent.history.filter(item => item.phaseIndex < 6);
  const kinds = phases.slice(0, 6).map(phase => phase.artifactKind);
  const artifactBytes = new Map();
  for (const kind of kinds) {
    const bytes = await boundedRegularFile(path.join(sourceArtifactsDirectory, `${kind}.json`), MAX_RESPONSE_BYTES, `accepted ${kind}`);
    if (validateForgeDeliveryPhaseArtifact(JSON.parse(bytes.toString('utf8'))).artifactDigest !== parent.acceptedArtifacts[kind]) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', 'An inherited artifact changed during access repair admission.');
    }
    artifactBytes.set(kind, bytes);
  }
  const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
  const combinedRequest = `${requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '')}\n\n${repairRequestText}`;
  const combinedBytes = Buffer.from(`${combinedRequest}\n`);
  if (combinedBytes.length > MAX_PROMPT_BYTES) fail('PHASE_CONTROLLER_INPUT_INVALID', 'Access repair feedback exceeds the prompt limit.');
  const { stateDigest: _parentDigest, ...payload } = parent;
  const next = { ...payload, currentPhaseId: 'access-wiring', currentPhaseIndex: 6,
    history: inheritedHistory, acceptedArtifacts: Object.fromEntries(kinds.map(kind => [kind, parent.acceptedArtifacts[kind]])),
    lastExecutionGeneration: inheritedHistory.at(-1).executionGeneration, revision: 1 + inheritedHistory.length * 2 };
  next.stateDigest = sha256(Buffer.from(canonicalStringify(next)));
  const state = validateForgeDeliveryPhaseState(next, catalog);
  const promptBytes = Buffer.from(`${buildForgeDeliveryPhasePrompt({ state, catalog, originalRequest: combinedRequest,
    upstreamArtifacts: requiredUpstreamArtifacts(accepted, phases[6]) })}\n`);
  if (promptBytes.length > MAX_PROMPT_BYTES) fail('PHASE_CONTROLLER_INPUT_INVALID', 'Access repair prompt exceeds the prompt limit.');
  const beforeBytes = await boundedRegularFile(path.join(path.dirname(sourceStateFile), 'phase-6-workspace-before.json'),
    MAX_PATCH_BYTES, 'original access workspace baseline');
  const receipt = { schemaVersion: 'forge-delivery-access-wiring-repair-continuation/v1', phaseId: 'access-wiring', phaseIndex: 6,
    sourceStateSha256: expectedSourceStateSha256, sourceStateDigest: parent.stateDigest, sourceCommit,
    catalogVersion: parent.catalogVersion, catalogDigest: parent.catalogDigest, taskId: parent.taskId, sessionId: parent.sessionId,
    parentLastExecutionGeneration: parent.lastExecutionGeneration, nextExecutionGenerationMinimum: failure.executionGeneration + 1,
    preparationExecutionId: failure.executionId, preparationExecutionGeneration: failure.executionGeneration, preparationRpcId: failure.rpcId,
    actorUserId: failure.actorUserId, actorUsername: failure.actorUsername, conversationId: failure.conversationId,
    failureEvidenceSha256: expectedFailureEvidenceSha256,
    failureEvidenceRelativePath: path.relative(path.dirname(sourceStateFile), failureEvidenceFile).replaceAll('\\', '/'),
    jobId: failure.jobId, workspaceFingerprint: failure.workspaceFingerprint,
    inheritedArtifactDigests: { ...state.acceptedArtifacts },
    inheritedAcceptedReceiptDigests: Object.fromEntries(acceptedHistory.slice(0, 6).map(item => [item.phaseId, item.receiptDigest])),
    parentAccessReceiptDigests: parent.history.filter(item => item.phaseIndex === 6).map(item => item.receiptDigest),
    stateDigest: state.stateDigest, promptSha256: sha256(promptBytes), originalRequestSha256: sha256(requestBytes),
    repairRequestSha256: sha256(Buffer.from(repairRequestText)), combinedRequestSha256: sha256(combinedBytes),
    phaseWorkspaceBeforeSha256: sha256(beforeBytes), inheritedStageCount: 6, newAcceptedStageCount: 0,
    modelStarted: false, parentStateUnchanged: true };
  return { catalog, parent, parentBytes, state, receipt, inheritedHistory, artifactBytes, promptBytes, combinedBytes, beforeBytes, failureBytes, failure };
}

function accessAcceptedCorrectionEvidenceName(state, correction, name) {
  if (correction.phaseId === 'backend') name = name.replace(/^权限接线阶段/u, '后端阶段');
  const first = state.history.find(item => item.schemaVersion === 'forge-delivery-access-accepted-correction/v1');
  return first?.receiptDigest === correction.receiptDigest ? name
    : `${name.slice(0, name.lastIndexOf('.'))}-${correction.acceptedReceiptDigest}${path.extname(name)}`;
}

export async function prepareForgeAccessAcceptedCorrection(args) {
  return withForgeDeliveryPhaseStateLock(args.sourceStateFile, async () => {
    const input = args.preparationExecution === undefined
      ? await accessWiringRepairInputs({ ...args, acceptedCorrection: true })
      : await accessWiringRuntimeRepairInputs({ ...args, acceptedCorrection: true });
    const { failure, parent, catalog } = input;
    const next = recordForgeAccessAcceptedCorrection({ state: parent, catalog, phaseId: args.repairPhaseId, binding: {
      acceptedSourceFingerprint: failure.acceptedPatchSha256, failureEvidenceSha256: sha256(input.failureBytes),
      ...(input.runtimeFailure ? { runtimeFailure: input.runtimeFailure } : {}),
      jobId: failure.jobId, executionId: failure.executionId, executionGeneration: failure.executionGeneration,
      rpcId: failure.rpcId, workspaceFingerprint: failure.workspaceFingerprint, candidateCommit: failure.candidateCommit,
      sourceStateSha256: args.expectedSourceStateSha256, repairRequestSha256: sha256(Buffer.from(args.repairRequestText)),
    } });
    const directory = path.dirname(args.sourceStateFile);
    const retain = async (name, bytes) => {
      const file = path.join(directory, accessAcceptedCorrectionEvidenceName(next, next.history.at(-1), name));
      try { await writeExclusive(file, bytes); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await boundedRegularFile(file, MAX_RESPONSE_BYTES, name)).equals(bytes)) {
          fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Accepted correction evidence changed.');
        }
      }
    };
    await retain('权限接线阶段-后验纠正原状态.json', input.parentBytes);
    await retain('权限接线阶段-后验纠正请求.txt', Buffer.from(args.repairRequestText));
    await retain(input.runtimeFailure ? '权限接线阶段-后验运行失败.json' : '权限接线阶段-后验迁移失败.json', input.failureBytes);
    if (input.runtimeFailure) {
      // Retain exact evidence before withdrawing stale current inputs.
      for (const name of ['runtime-evidence.json', 'runtime-input-receipt.json', 'runtime-reprobe.json']) {
        const bytes = await boundedRegularFile(path.join(directory, name), MAX_RESPONSE_BYTES, name, { trustedReview: true });
        if (bytes.toString('base64') !== input.retainedBytesBase64[name]) fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Runtime evidence changed before correction.');
      }
      for (const name of ['runtime-evidence.json', 'runtime-input-receipt.json', 'runtime-reprobe.json']) await unlink(path.join(directory, name));
    }
    const accepted = await loadAcceptedArtifacts({ state: next, catalog, artifactsDirectory: args.sourceArtifactsDirectory });
    const prompt = buildForgeDeliveryPhasePrompt({ state: next, catalog,
      originalRequest: input.combinedBytes.toString('utf8').replace(/(?:\r?\n)+$/u, ''),
      upstreamArtifacts: requiredUpstreamArtifacts(accepted, currentPhase(next, catalog)) });
    // Preserve original acceptance bytes; only the current projection and prompt advance.
    await writeAtomic(path.join(directory, 'current-prompt.md'), Buffer.from(`${prompt}\n`));
    await writeForgeDeliveryPhaseState(args.sourceStateFile, next, catalog);
    return { nextExecutionGenerationMinimum: failure.executionGeneration + 1 };
  });
}

// This child is the single bounded access repair linked to an unchanged accepted parent.
async function readAccessWiringMigrationRepairContinuation({ catalogFile, sourceStateFile, sourceArtifactsDirectory,
  sourceCommit, taskId, sessionId }) {
  const phaseDirectory = path.join(path.dirname(sourceStateFile), 'access-wiring-repair');
  const receiptFile = path.join(phaseDirectory, '权限接线阶段-关联修复凭据.json');
  if (await lstat(receiptFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) === null) return null;
  const receipt = await readJsonFile(receiptFile, MAX_RESPONSE_BYTES, 'access repair continuation', { trustedReview: true });
  if (receipt.taskId !== taskId || receipt.sessionId !== sessionId
    || typeof receipt.failureEvidenceRelativePath !== 'string') {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Access repair identity differs from the current task and session.');
  }
  const repairBytes = await boundedRegularFile(path.join(phaseDirectory, '权限接线阶段-修复请求原文.txt'), MAX_PROMPT_BYTES, 'access repair feedback');
  const expected = await accessWiringRepairInputs({ catalogFile, sourceStateFile, sourceArtifactsDirectory, sourceCommit,
    originalRequestFile: path.join(path.dirname(sourceStateFile), 'original-request.md'), outputDirectory: phaseDirectory,
    expectedSourceStateSha256: receipt.sourceStateSha256, repairRequestText: repairBytes.toString('utf8'),
    failureEvidenceFile: path.join(path.dirname(sourceStateFile), receipt.failureEvidenceRelativePath),
    expectedFailureEvidenceSha256: receipt.failureEvidenceSha256 });
  if (canonicalStringify(receipt) !== canonicalStringify(expected.receipt)) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Access repair continuation no longer matches its retained parent and failure.');
  }
  const current = await readForgeDeliveryPhaseState(path.join(phaseDirectory, 'state.json'), expected.catalog);
  if (current.sourceCommit !== sourceCommit || current.taskId !== taskId || current.sessionId !== sessionId
    || current.workflowId !== expected.parent.workflowId || current.caseFamily !== expected.parent.caseFamily
    || canonicalStringify(current.history.slice(0, expected.inheritedHistory.length)) !== canonicalStringify(expected.inheritedHistory)
    || Object.entries(expected.state.acceptedArtifacts).some(([kind, digest]) => current.acceptedArtifacts[kind] !== digest
      && !(kind === 'backend-implementation' && current.history.some(entry => entry.schemaVersion === 'forge-delivery-backend-accepted-correction/v1'
        && entry.artifactDigest === digest)))
    || current.history.slice(expected.inheritedHistory.length).some(item => item.executionGeneration < receipt.nextExecutionGenerationMinimum)
    || (current.activeAttempt !== null && current.activeAttempt.executionGeneration < receipt.nextExecutionGenerationMinimum)) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Access repair progress changed its inherited inputs or generation boundary.');
  }
  for (const [kind, bytes] of expected.artifactBytes) {
    if (!(await boundedRegularFile(path.join(phaseDirectory, 'artifacts', `${kind}.json`), MAX_RESPONSE_BYTES, `inherited ${kind}`)).equals(bytes)) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', 'An inherited access repair artifact changed.');
    }
  }
  if (!(await boundedRegularFile(path.join(phaseDirectory, 'phase-6-workspace-before.json'), MAX_PATCH_BYTES, 'access repair baseline')).equals(expected.beforeBytes)
    || !(await boundedRegularFile(path.join(phaseDirectory, '跨层准备失败凭据.json'), MAX_RESPONSE_BYTES, 'retained migration failure', { trustedReview: true })).equals(expected.failureBytes)) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Access repair baseline or failure evidence changed.');
  }
  return { phaseDirectory, continuation: Object.freeze(receipt) };
}

export async function readForgeAccessWiringRepairContinuation(args) {
  const original = await readAccessWiringMigrationRepairContinuation(args);
  if (original === null) return null;
  const repaired = await readAccessWiringRuntimeRepairContinuation({ catalogFile: args.catalogFile,
    sourceStateFile: path.join(original.phaseDirectory, 'state.json'), sourceCommit: args.sourceCommit,
    taskId: args.taskId, sessionId: args.sessionId });
  if (repaired === null) return original;
  const migration = await readAccessWiringMigrationRepairContinuation({ catalogFile: args.catalogFile,
    sourceStateFile: path.join(repaired.phaseDirectory, 'state.json'),
    sourceArtifactsDirectory: path.join(repaired.phaseDirectory, 'artifacts'), sourceCommit: args.sourceCommit,
    taskId: args.taskId, sessionId: args.sessionId });
  return migration ?? repaired;
}

async function accessWiringRuntimeRepairInputs({ catalogFile, sourceStateFile, expectedSourceStateSha256,
  sourceArtifactsDirectory, sourceCommit, originalRequestFile, outputDirectory, repairRequestText,
  preparationExecution, preparationTerminal, acceptedCorrection = false, repairPhaseId = 'access-wiring' }) {
  const backend = repairPhaseId === 'backend';
  if (!['access-wiring', 'backend'].includes(repairPhaseId) || (backend && !acceptedCorrection)) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Backend runtime repair requires accepted-correction authority.');
  }
  const directory = path.dirname(sourceStateFile);
  requiredId(expectedSourceStateSha256, SHA256_PATTERN, 'expectedSourceStateSha256');
  requiredId(sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  const acceptedParent = path.basename(path.dirname(directory)) === 'runtime-access-repair'
    && path.basename(path.dirname(path.dirname(directory))) === 'access-wiring-repair'
    && path.basename(path.dirname(path.dirname(path.dirname(directory)))) === 'phase-control';
  if (![sourceStateFile, sourceArtifactsDirectory, originalRequestFile, outputDirectory].every(file =>
    typeof file === 'string' && path.isAbsolute(file)) || path.basename(directory) !== 'access-wiring-repair'
    || (acceptedCorrection ? !acceptedParent : path.basename(path.dirname(directory)) !== 'phase-control')
    || sourceStateFile !== path.join(directory, 'state.json') || sourceArtifactsDirectory !== path.join(directory, 'artifacts')
    || originalRequestFile !== path.join(directory, 'original-request.md')
    || outputDirectory !== (acceptedCorrection ? directory : path.join(directory, 'runtime-access-repair'))) {
    fail('PHASE_CONTROLLER_PATH_INVALID', 'Runtime access repair requires its fixed accepted access parent and child.');
  }
  boundedReviewText(repairRequestText, MAX_PROMPT_BYTES, 'runtime access repair feedback');
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  const parentBytes = await boundedRegularFile(sourceStateFile, MAX_RESPONSE_BYTES, 'runtime repair parent');
  if (sha256(parentBytes) !== expectedSourceStateSha256) fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Runtime repair parent changed.');
  const parent = validateForgeDeliveryPhaseState(JSON.parse(parentBytes.toString('utf8')), catalog);
  const origin = await readAccessWiringMigrationRepairContinuation({ catalogFile,
    sourceStateFile: path.join(path.dirname(directory), 'state.json'),
    sourceArtifactsDirectory: path.join(path.dirname(directory), 'artifacts'), sourceCommit,
    taskId: parent.taskId, sessionId: parent.sessionId });
  if (origin?.phaseDirectory !== directory || parent.workflowId !== 'crud-production' || parent.status !== 'active'
    || parent.currentPhaseId !== 'cross-layer-acceptance' || parent.currentPhaseIndex !== 7
    || parent.activeAttempt === null || Object.keys(parent.acceptedArtifacts).length !== 7 || parent.sourceCommit !== sourceCommit) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Runtime access repair requires the current accepted child and its retained cross-layer attempt.');
  }
  const accepted = await loadAcceptedArtifacts({ state: parent, catalog, artifactsDirectory: sourceArtifactsDirectory });
  const phases = catalog.workflows.find(item => item.id === parent.workflowId).phases;
  const preparation = validateProtectedExecutionContext(preparationExecution);
  const terminal = preparationTerminal;
  const reprobe = await readForgeCrossLayerRuntimeReprobe({ stateFile: sourceStateFile, state: parent });
  const promptBytes = await boundedRegularFile(path.join(directory, 'current-prompt.md'), MAX_PROMPT_BYTES, 'retained runtime prompt');
  const bundle = await readPreparedForgeCrossLayerRuntimeEvidence({ stateFile: sourceStateFile, state: parent,
    promptText: promptBytes.toString('utf8') });
  const input = await readJsonFile(path.join(directory, 'runtime-input-receipt.json'), MAX_RESPONSE_BYTES, 'runtime input', { trustedReview: true });
  const binding = backend ? input.preparationBinding : preparation.preparationBinding;
  const deployment = bundle.evidence?.deployment;
  const database = bundle.evidence?.database;
  if (reprobe?.status !== 'imported' || (!backend && reprobe.stateDigest !== parent.stateDigest)
    || (backend ? preparation.crossLayerPreparation === true : preparation.crossLayerPreparation !== true) || preparation.authorityClass !== 'production-read-only'
    || preparation.testOnly !== false || preparation.actionCeiling !== 'read-only' || preparation.ownedPaths.length !== 0
    || preparation.taskId !== parent.taskId || preparation.dshSessionId !== parent.sessionId || preparation.sourceCommit !== sourceCommit
    || preparation.workflowId !== parent.workflowId || preparation.phaseId !== 'cross-layer-acceptance' || preparation.phaseIndex !== 7
    || preparation.phaseCatalogVersion !== parent.catalogVersion || preparation.phaseCatalogDigest !== parent.catalogDigest
    || ['actorUserId', 'actorUsername', 'conversationId'].some(key => preparation[key] !== origin.continuation[key])
    || (backend ? preparation.generation !== parent.activeAttempt.executionGeneration
      || preparation.generation <= reprobe.previousExecutionGeneration || preparation.rpcId !== parent.activeAttempt.rpcId
      || preparation.textDigest !== parent.activeAttempt.promptDigest
      : preparation.generation <= parent.activeAttempt.executionGeneration)
    || binding?.stateDigest !== (backend ? input.sourceStateDigest : parent.stateDigest) || binding.baseSourceCommit !== sourceCommit
    || binding.workspaceFingerprint !== reprobe.workspaceFingerprint
    || canonicalStringify(binding.acceptedArtifactDigests) !== canonicalStringify(parent.acceptedArtifacts)
    || canonicalStringify(input.preparationBinding) !== canonicalStringify(binding)
    || !terminal || ['executionId', 'generation', 'dshSessionId', 'rpcId', 'textDigest'].some(key => terminal[key] !== preparation[key])
    || terminal.terminalReason !== 'completed' || terminal.sessionRunning !== false
    || !Number.isSafeInteger(terminal.turn) || terminal.turn < 0 || !Number.isSafeInteger(terminal.requestSeq) || terminal.requestSeq < 0
    || !Number.isSafeInteger(terminal.terminalSeq) || terminal.terminalSeq <= terminal.requestSeq || !SHA256_PATTERN.test(terminal.terminalEventDigest ?? '')
    || bundle.manifestSha256 !== reprobe.replacementManifestSha256 || bundle.runtimeSource.commit !== reprobe.candidateCommit
    || bundle.runtimeSource.tree !== reprobe.candidateTree || bundle.subject.cumulativePatchSha256 !== reprobe.acceptedPatchSha256
    || deployment?.status !== 'success' || deployment.startup?.migrationValidated !== true || deployment.startup?.applicationStarted !== true
    || (acceptedCorrection
      ? bundle.evidence.api?.status !== 'failed' || !Array.isArray(bundle.evidence.api.checks) || !bundle.evidence.api.checks.some(check => check.status === 'failed')
      : database?.status !== 'failed' || !Array.isArray(database.checks) || !database.checks.some(check => check.status === 'failed'))
    || !UUID_PATTERN.test(deployment.observationId ?? '') || deployment.observationId !== reprobe.replacementObservationId
    || ['deployment', 'api', 'database', 'browser'].some(kind => {
      const document = bundle.evidence[kind];
      return !document || document.observationId !== deployment.observationId
        || document.executionId !== (backend ? deployment.executionId : preparation.executionId)
        || document.stateDigest !== (backend ? input.sourceStateDigest : parent.stateDigest) || document.taskId !== parent.taskId || document.baseSourceCommit !== sourceCommit
        || document.workspaceFingerprint !== binding.workspaceFingerprint || document.sourceCommit !== bundle.runtimeSource.commit
        || document.candidateTree !== bundle.runtimeSource.tree || document.acceptedPatchSha256 !== bundle.subject.cumulativePatchSha256;
    })) fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Runtime access repair requires the same completed preparation and imported failed candidate checks.');
  if (acceptedCorrection) {
    if (!backend) await sameExecutionRuntimeObservation({ stateFile: sourceStateFile, state: parent, reprobe,
      preparationExecution: preparation, promptFile: path.join(directory, 'current-prompt.md') });
    const access = accepted.find(artifact => artifact.artifactKind === (backend
      ? currentForgeRuntimeSourceArtifactKind(parent) : 'access-wiring-implementation'));
    if (access?.sourceFingerprint !== bundle.subject.cumulativePatchSha256) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', 'Failed API candidate differs from the accepted access artifact.');
    }
    const retainedBytesBase64 = {};
    for (const name of ['runtime-input-receipt.json', 'runtime-evidence.json', 'runtime-reprobe.json', 'current-prompt.md']) {
      retainedBytesBase64[name] = (await boundedRegularFile(path.join(directory, name),
        name.endsWith('.md') ? MAX_PROMPT_BYTES : MAX_RESPONSE_BYTES, name, { trustedReview: true })).toString('base64');
    }
    const failureBytes = jsonBytes({ schemaVersion: backend ? 'forge-delivery-backend-runtime-failure/v1' : 'forge-delivery-access-runtime-failure/v1',
      sourceStateSha256: expectedSourceStateSha256, parentStateDigest: parent.stateDigest,
      ...(backend ? { formalExecution: preparation } : { preparation }), terminal, bundle, retainedBytesBase64 });
    if (failureBytes.length > MAX_RESPONSE_BYTES) fail('PHASE_CONTROLLER_INPUT_INVALID', 'Retained runtime failure exceeds the evidence limit.');
    const request = (await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'runtime repair original request')).toString('utf8').replace(/(?:\r?\n)+$/u, '');
    const combinedBytes = Buffer.from(`${request}\n\n${repairRequestText}\n`);
    if (combinedBytes.length > MAX_PROMPT_BYTES) fail('PHASE_CONTROLLER_INPUT_INVALID', 'Runtime repair request exceeds the prompt limit.');
    return { catalog, parent, parentBytes, combinedBytes, failureBytes, retainedBytesBase64,
      runtimeFailure: { observationId: deployment.observationId, manifestSha256: bundle.manifestSha256,
        [backend ? 'formalTerminalSha256' : 'preparationTerminalSha256']: sha256(jsonBytes(terminal)) },
      failure: { acceptedPatchSha256: access.sourceFingerprint, jobId: null, executionId: preparation.executionId,
        executionGeneration: preparation.generation, rpcId: preparation.rpcId,
        workspaceFingerprint: binding.workspaceFingerprint, candidateCommit: bundle.runtimeSource.commit } };
  }
  const inheritedHistory = parent.history.filter(item => item.phaseIndex < 6);
  const kinds = phases.slice(0, 6).map(phase => phase.artifactKind);
  const artifactBytes = new Map();
  for (const kind of kinds) artifactBytes.set(kind,
    await boundedRegularFile(path.join(sourceArtifactsDirectory, `${kind}.json`), MAX_RESPONSE_BYTES, `inherited ${kind}`));
  const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'runtime repair original request');
  const combinedRequest = `${requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '')}\n\n${repairRequestText}`;
  const combinedBytes = Buffer.from(`${combinedRequest}\n`);
  if (combinedBytes.length > MAX_PROMPT_BYTES) fail('PHASE_CONTROLLER_INPUT_INVALID', 'Runtime access repair feedback exceeds the prompt limit.');
  const { stateDigest: _ignored, ...unsigned } = parent;
  const next = { ...unsigned, currentPhaseId: 'access-wiring', currentPhaseIndex: 6, activeAttempt: null,
    history: inheritedHistory, acceptedArtifacts: Object.fromEntries(kinds.map(kind => [kind, parent.acceptedArtifacts[kind]])),
    lastExecutionGeneration: inheritedHistory.at(-1).executionGeneration, revision: 1 + inheritedHistory.length * 2 };
  next.stateDigest = sha256(Buffer.from(canonicalStringify(next)));
  const state = validateForgeDeliveryPhaseState(next, catalog);
  const nextPromptBytes = Buffer.from(`${buildForgeDeliveryPhasePrompt({ state, catalog, originalRequest: combinedRequest,
    upstreamArtifacts: requiredUpstreamArtifacts(accepted, phases[6]) })}\n`);
  if (nextPromptBytes.length > MAX_PROMPT_BYTES) fail('PHASE_CONTROLLER_INPUT_INVALID', 'Runtime access repair prompt exceeds the prompt limit.');
  const beforeBytes = await boundedRegularFile(path.join(directory, 'phase-6-workspace-before.json'), MAX_PATCH_BYTES, 'retained access baseline');
  const runtimeSha256 = {};
  for (const name of ['runtime-input-receipt.json', 'runtime-evidence.json', 'runtime-reprobe.json', 'current-prompt.md']) {
    runtimeSha256[name] = sha256(await boundedRegularFile(path.join(directory, name), name.endsWith('.md') ? MAX_PROMPT_BYTES : MAX_RESPONSE_BYTES,
      `retained ${name}`, { trustedReview: true }));
  }
  const receipt = { schemaVersion: 'forge-delivery-access-wiring-runtime-repair-continuation/v1', phaseId: 'access-wiring', phaseIndex: 6,
    sourceStateSha256: expectedSourceStateSha256, sourceStateDigest: parent.stateDigest, sourceCommit,
    catalogVersion: parent.catalogVersion, catalogDigest: parent.catalogDigest, taskId: parent.taskId, sessionId: parent.sessionId,
    parentAttemptId: parent.activeAttempt.attemptId, parentLastExecutionGeneration: parent.lastExecutionGeneration,
    nextExecutionGenerationMinimum: preparation.generation + 1, preparationExecutionId: preparation.executionId,
    preparationExecutionGeneration: preparation.generation, preparationRpcId: preparation.rpcId,
    actorUserId: preparation.actorUserId, actorUsername: preparation.actorUsername, conversationId: preparation.conversationId,
    preparationExecutionSha256: sha256(jsonBytes(preparation)), preparationTerminalSha256: sha256(jsonBytes(terminal)),
    observationId: deployment.observationId, candidateCommit: bundle.runtimeSource.commit, candidateTree: bundle.runtimeSource.tree,
    workspaceFingerprint: binding.workspaceFingerprint, runtimeSha256, inheritedArtifactDigests: { ...state.acceptedArtifacts },
    inheritedAcceptedReceiptDigests: Object.fromEntries(inheritedHistory.filter(item => item.decision === 'accepted').map(item => [item.phaseId, item.receiptDigest])),
    stateDigest: state.stateDigest, promptSha256: sha256(nextPromptBytes), originalRequestSha256: sha256(requestBytes),
    repairRequestSha256: sha256(Buffer.from(repairRequestText)), combinedRequestSha256: sha256(combinedBytes),
    phaseWorkspaceBeforeSha256: sha256(beforeBytes), inheritedStageCount: 6, newAcceptedStageCount: 0,
    modelStarted: false, parentStateUnchanged: true };
  return { catalog, parent, parentBytes, state, receipt, artifactBytes, inheritedHistory, nextPromptBytes, combinedBytes, beforeBytes };
}

async function readAccessWiringRuntimeRepairContinuation({ catalogFile, sourceStateFile, sourceCommit, taskId, sessionId }) {
  const directory = path.dirname(sourceStateFile);
  const phaseDirectory = path.join(directory, 'runtime-access-repair');
  const receiptFile = path.join(phaseDirectory, '权限接线阶段-运行修复凭据.json');
  if (await lstat(receiptFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) === null) return null;
  const receipt = await readJsonFile(receiptFile, MAX_RESPONSE_BYTES, 'runtime access repair receipt', { trustedReview: true });
  const repairBytes = await boundedRegularFile(path.join(phaseDirectory, '权限接线阶段-修复请求原文.txt'), MAX_PROMPT_BYTES, 'runtime access repair request');
  const expected = await accessWiringRuntimeRepairInputs({ catalogFile, sourceStateFile, sourceCommit,
    expectedSourceStateSha256: receipt.sourceStateSha256, sourceArtifactsDirectory: path.join(directory, 'artifacts'),
    originalRequestFile: path.join(directory, 'original-request.md'), outputDirectory: phaseDirectory, repairRequestText: repairBytes.toString('utf8'),
    preparationExecution: await readJsonFile(path.join(phaseDirectory, 'preparation-execution.json'), MAX_RESPONSE_BYTES, 'retained preparation'),
    preparationTerminal: await readJsonFile(path.join(phaseDirectory, 'preparation-terminal.json'), MAX_RESPONSE_BYTES, 'retained preparation terminal') });
  if (receipt.taskId !== taskId || receipt.sessionId !== sessionId || canonicalStringify(receipt) !== canonicalStringify(expected.receipt)) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Runtime access repair no longer matches its unchanged parent and failed observation.');
  }
  const current = await readForgeDeliveryPhaseState(path.join(phaseDirectory, 'state.json'), expected.catalog);
  if (current.taskId !== taskId || current.sessionId !== sessionId || current.sourceCommit !== sourceCommit
    || current.workflowId !== expected.parent.workflowId || current.caseFamily !== expected.parent.caseFamily
    || canonicalStringify(current.history.slice(0, expected.inheritedHistory.length)) !== canonicalStringify(expected.inheritedHistory)
    || Object.entries(expected.state.acceptedArtifacts).some(([kind, digest]) => current.acceptedArtifacts[kind] !== digest)
    || current.history.slice(expected.inheritedHistory.length).some(item => item.executionGeneration < receipt.nextExecutionGenerationMinimum)
    || (current.activeAttempt !== null && current.activeAttempt.executionGeneration < receipt.nextExecutionGenerationMinimum)) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Runtime access repair changed inherited contracts or execution generation.');
  }
  for (const [kind, bytes] of expected.artifactBytes) {
    if (!(await boundedRegularFile(path.join(phaseDirectory, 'artifacts', `${kind}.json`), MAX_RESPONSE_BYTES, `inherited ${kind}`)).equals(bytes)) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', 'An inherited runtime access artifact changed.');
    }
  }
  if (!(await boundedRegularFile(path.join(phaseDirectory, 'original-request.md'), MAX_PROMPT_BYTES, 'combined runtime repair request')).equals(expected.combinedBytes)
    || !(await boundedRegularFile(path.join(phaseDirectory, 'phase-6-workspace-before.json'), MAX_PATCH_BYTES, 'runtime repair baseline')).equals(expected.beforeBytes)) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Runtime access repair changed its request or baseline.');
  }
  return { phaseDirectory, continuation: Object.freeze(receipt) };
}

export async function prepareForgeAccessWiringRuntimeRepairContinuation(args) {
  const input = await accessWiringRuntimeRepairInputs(args);
  const { outputDirectory, sourceStateFile } = args;
  const info = await lstat(outputDirectory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info !== null && (!info.isDirectory() || info.isSymbolicLink())) fail('PHASE_CONTROLLER_PATH_INVALID', 'Runtime access repair child must be an ordinary private directory.');
  const retain = async (name, bytes, limit) => {
    const file = path.join(outputDirectory, name);
    try { await writeExclusive(file, bytes); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await boundedRegularFile(file, limit, 'retained runtime access repair')).equals(bytes)) {
        fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Runtime access repair input changed across an idempotent replay.');
      }
    }
  };
  const receiptFile = path.join(outputDirectory, '权限接线阶段-运行修复凭据.json');
  if (await lstat(receiptFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) === null) {
    await retain('state.json', jsonBytes(input.state), MAX_RESPONSE_BYTES);
    await retain('current-prompt.md', input.nextPromptBytes, MAX_PROMPT_BYTES);
  }
  for (const [kind, bytes] of input.artifactBytes) await retain(`artifacts/${kind}.json`, bytes, MAX_RESPONSE_BYTES);
  await retain('original-request.md', input.combinedBytes, MAX_PROMPT_BYTES);
  await retain('权限接线阶段-修复请求原文.txt', Buffer.from(args.repairRequestText), MAX_PROMPT_BYTES);
  await retain('phase-6-workspace-before.json', input.beforeBytes, MAX_PATCH_BYTES);
  await retain('preparation-execution.json', jsonBytes(args.preparationExecution), MAX_RESPONSE_BYTES);
  await retain('preparation-terminal.json', jsonBytes(args.preparationTerminal), MAX_RESPONSE_BYTES);
  if (!(await boundedRegularFile(sourceStateFile, MAX_RESPONSE_BYTES, 'unchanged runtime access parent')).equals(input.parentBytes)) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Runtime access parent changed during repair admission.');
  }
  await writeOrVerifyReceipt(receiptFile, input.receipt);
  return (await readAccessWiringRuntimeRepairContinuation({ catalogFile: args.catalogFile, sourceStateFile,
    sourceCommit: args.sourceCommit, taskId: input.parent.taskId, sessionId: input.parent.sessionId })).continuation;
}

export async function prepareForgeAccessWiringRepairContinuation(args) {
  const input = await accessWiringRepairInputs(args);
  const { outputDirectory, sourceStateFile } = args;
  const information = await lstat(outputDirectory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (information !== null && (!information.isDirectory() || information.isSymbolicLink())) {
    fail('PHASE_CONTROLLER_PATH_INVALID', 'Access repair output must be an ordinary private directory.');
  }
  const retain = async (name, bytes, limit) => {
    const file = path.join(outputDirectory, name);
    try { await writeExclusive(file, bytes); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await boundedRegularFile(file, limit, 'retained access repair file')).equals(bytes)) {
        fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Access repair input changed across an idempotent replay.');
      }
    }
  };
  const receiptFile = path.join(outputDirectory, '权限接线阶段-关联修复凭据.json');
  if (await lstat(receiptFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) === null) {
    await retain('state.json', jsonBytes(input.state), MAX_RESPONSE_BYTES);
    await retain('current-prompt.md', input.promptBytes, MAX_PROMPT_BYTES);
  }
  for (const [kind, bytes] of input.artifactBytes) await retain(`artifacts/${kind}.json`, bytes, MAX_RESPONSE_BYTES);
  await retain('original-request.md', input.combinedBytes, MAX_PROMPT_BYTES);
  await retain('权限接线阶段-修复请求原文.txt', Buffer.from(args.repairRequestText), MAX_PROMPT_BYTES);
  await retain('phase-6-workspace-before.json', input.beforeBytes, MAX_PATCH_BYTES);
  await retain('跨层准备失败凭据.json', input.failureBytes, MAX_RESPONSE_BYTES);
  if (!(await boundedRegularFile(sourceStateFile, MAX_RESPONSE_BYTES, 'unchanged access repair parent')).equals(input.parentBytes)) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Accepted parent changed during access repair.');
  }
  await writeOrVerifyReceipt(receiptFile, input.receipt);
  return (await readForgeAccessWiringRepairContinuation({ catalogFile: args.catalogFile, sourceStateFile,
    sourceArtifactsDirectory: args.sourceArtifactsDirectory, sourceCommit: args.sourceCommit,
    taskId: input.parent.taskId, sessionId: input.parent.sessionId })).continuation;
}

export async function prepareForgeFrontendRepairContinuation({
  catalogFile, sourceStateFile, expectedSourceStateSha256, sourceArtifactsDirectory,
  sourceCommit, originalRequestFile, outputDirectory, repairRequestText,
}) {
  requiredId(expectedSourceStateSha256, SHA256_PATTERN, 'expectedSourceStateSha256');
  requiredId(sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  if (![sourceStateFile, sourceArtifactsDirectory, originalRequestFile, outputDirectory]
    .every((value) => typeof value === 'string' && path.isAbsolute(value))
    || outputDirectory === path.dirname(sourceStateFile)
    || sourceStateFile.startsWith(`${outputDirectory}${path.sep}`)
    || sourceArtifactsDirectory === outputDirectory
    || sourceArtifactsDirectory.startsWith(`${outputDirectory}${path.sep}`)) {
    fail('PHASE_CONTROLLER_PATH_INVALID', 'Frontend repair requires a separate continuation directory.');
  }
  if (typeof repairRequestText !== 'string' || repairRequestText.trim().length === 0
    || Buffer.byteLength(repairRequestText, 'utf8') > MAX_PROMPT_BYTES) {
    fail('PHASE_CONTROLLER_INPUT_INVALID', 'Frontend repair requires bounded user feedback.');
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  const sourceBytes = await boundedRegularFile(sourceStateFile, MAX_RESPONSE_BYTES, 'source frontend state');
  const assertParentUnchanged = async () => {
    if (sha256(await boundedRegularFile(sourceStateFile, MAX_RESPONSE_BYTES, 'source frontend state'))
      !== expectedSourceStateSha256) {
      fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Source frontend state changed during repair admission.');
    }
  };
  if (sha256(sourceBytes) !== expectedSourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Source frontend state differs from the pinned digest.');
  }
  const parent = validateForgeDeliveryPhaseState(JSON.parse(sourceBytes.toString('utf8')), catalog);
  const phase = currentPhase(parent, catalog);
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation'];
  const phaseNames = ['requirements', 'domain-contract', 'database', 'ui-design', 'backend'];
  const parentFailures = parent.history.filter((entry) => entry.phaseId === 'frontend');
  if (parent.schemaVersion !== 'forge-delivery-phase-state/v2' || parent.sourceCommit !== sourceCommit
    || parent.status !== 'blocked' || parent.currentPhaseId !== 'frontend' || parent.currentPhaseIndex !== 5
    || parent.activeAttempt !== null || parentFailures.length !== phase.maxAttempts
    || parentFailures.some((entry) => entry.schemaVersion !== 'forge-delivery-phase-receipt/v1'
      || entry.decision !== 'rejected')
    || parent.history.at(-1) !== parentFailures.at(-1)
    || canonicalStringify(Object.keys(parent.acceptedArtifacts).sort()) !== canonicalStringify([...kinds].sort())) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only an exhausted rejected frontend phase with five accepted upstream phases can repair.');
  }
  const accepted = await loadAcceptedArtifacts({ state: parent, catalog, artifactsDirectory: sourceArtifactsDirectory });
  const inheritedHistory = parent.history.filter((entry) => entry.phaseIndex < 5);
  const acceptedHistory = inheritedHistory.filter((entry) => entry.decision === 'accepted');
  const upstreamPhases = catalog.workflows.find((entry) => entry.id === parent.workflowId).phases.slice(0, 5);
  const artifacts = new Map(accepted.map((artifact) => [artifact.artifactKind, artifact]));
  if (accepted.length !== 5 || acceptedHistory.length !== 5 || upstreamPhases.some((upstreamPhase, index) => {
    const artifact = artifacts.get(kinds[index]);
    const receipt = acceptedHistory[index];
    const expectedUpstream = Object.fromEntries(upstreamPhase.requiresArtifacts.map((kind) => [kind, parent.acceptedArtifacts[kind]]));
    return upstreamPhase.id !== phaseNames[index] || upstreamPhase.artifactKind !== kinds[index]
      || receipt.phaseIndex !== index || receipt.phaseId !== upstreamPhase.id
      || receipt.artifactDigest !== parent.acceptedArtifacts[kinds[index]]
      || artifact?.phaseId !== receipt.phaseId || artifact.attemptId !== receipt.attemptId
      || artifact.artifactDigest !== receipt.artifactDigest || artifact.patchDigest !== receipt.patchDigest
      || artifact.unresolvedDecisions.length !== 0
      || upstreamPhase.requiresArtifacts.some((kind) => !kinds.slice(0, index).includes(kind))
      || canonicalStringify(artifact.upstreamArtifactDigests) !== canonicalStringify(expectedUpstream)
      || upstreamPhase.requiredPayloadKeys.some((key) => !Object.hasOwn(artifact.payload, key))
      || (upstreamPhase.patchScope === 'none' && (artifact.changedPaths.length !== 0
        || artifact.sourceFingerprint !== (index === 0 ? EMPTY_SHA256 : artifacts.get(kinds[index - 1]).sourceFingerprint)));
  })) {
    fail('PHASE_CONTROLLER_UPSTREAM_STALE', 'Inherited frontend inputs do not match their accepted phase and source history.');
  }
  const artifactBytes = new Map();
  for (const kind of kinds) {
    const bytes = await boundedRegularFile(path.join(sourceArtifactsDirectory, `${kind}.json`),
      MAX_RESPONSE_BYTES, `source accepted ${kind}`);
    if (validateForgeDeliveryPhaseArtifact(JSON.parse(bytes.toString('utf8'))).artifactDigest !== artifacts.get(kind).artifactDigest) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', `Inherited ${kind} changed during repair admission.`);
    }
    artifactBytes.set(kind, bytes);
  }
  const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
  const combinedRequest = `${requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '')}\n\n${repairRequestText}`;
  const combinedRequestBytes = Buffer.from(`${combinedRequest}\n`, 'utf8');
  if (combinedRequestBytes.length > MAX_PROMPT_BYTES) {
    fail('PHASE_CONTROLLER_INPUT_INVALID', 'Original request and repair feedback exceed the prompt input limit.');
  }
  const { stateDigest: _parentDigest, ...parentPayload } = parent;
  const next = { ...parentPayload, status: 'active', activeAttempt: null, history: inheritedHistory,
    lastExecutionGeneration: inheritedHistory.at(-1).executionGeneration,
    revision: 1 + inheritedHistory.length * 2 };
  next.stateDigest = sha256(Buffer.from(canonicalStringify(next), 'utf8'));
  const state = validateForgeDeliveryPhaseState(next, catalog);
  const promptBytes = Buffer.from(`${buildForgeDeliveryPhasePrompt({
    state, catalog, originalRequest: combinedRequest, upstreamArtifacts: requiredUpstreamArtifacts(accepted, phase),
  })}\n`, 'utf8');
  if (promptBytes.length > MAX_PROMPT_BYTES) {
    fail('PHASE_CONTROLLER_INPUT_INVALID', 'Frontend repair prompt exceeds the existing input limit.');
  }
  const receipt = Object.freeze({
    schemaVersion: 'forge-delivery-frontend-repair-continuation/v1', phaseId: 'frontend', phaseIndex: 5,
    sourceStateSha256: expectedSourceStateSha256, sourceStateDigest: parent.stateDigest,
    sourceCommit, catalogVersion: parent.catalogVersion, catalogDigest: parent.catalogDigest,
    taskId: parent.taskId, sessionId: parent.sessionId,
    parentLastExecutionGeneration: parent.lastExecutionGeneration,
    nextExecutionGenerationMinimum: parent.lastExecutionGeneration + 1,
    inheritedArtifactDigests: Object.fromEntries(kinds.map((kind) => [kind, parent.acceptedArtifacts[kind]])),
    inheritedAcceptedReceiptDigests: Object.fromEntries(acceptedHistory.map((entry) => [entry.phaseId, entry.receiptDigest])),
    parentFrontendFailureReceiptDigests: parentFailures.map((entry) => entry.receiptDigest),
    stateDigest: state.stateDigest, promptSha256: sha256(promptBytes),
    originalRequestSha256: sha256(requestBytes), repairRequestSha256: sha256(Buffer.from(repairRequestText, 'utf8')),
    combinedRequestSha256: sha256(combinedRequestBytes),
    inheritedStageCount: 5, newAcceptedStageCount: 0, modelStarted: false, parentStateUnchanged: true,
  });
  await assertParentUnchanged();
  const directory = await lstat(outputDirectory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (directory !== null && (!directory.isDirectory() || directory.isSymbolicLink())) {
    fail('PHASE_CONTROLLER_PATH_INVALID', 'Frontend repair output must be an ordinary directory.');
  }
  if (directory === null) await mkdir(outputDirectory, { mode: 0o700 });
  const writeOrVerify = async (filename, bytes, maximumBytes) => {
    try { await writeExclusive(filename, bytes); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await boundedRegularFile(filename, maximumBytes, 'retained frontend repair file')).equals(bytes)) {
        fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Frontend repair file changed across an idempotent replay.');
      }
    }
  };
  const receiptFile = path.join(outputDirectory, '前端阶段-关联修复凭据.json');
  const priorReceipt = await lstat(receiptFile).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (priorReceipt !== null) {
    await writeOrVerifyReceipt(receiptFile, receipt);
    const current = await readForgeDeliveryPhaseState(path.join(outputDirectory, 'state.json'), catalog);
    if (current.sourceCommit !== parent.sourceCommit || current.taskId !== parent.taskId || current.sessionId !== parent.sessionId
      || current.workflowId !== parent.workflowId || current.caseFamily !== parent.caseFamily
      || canonicalStringify(current.history.slice(0, inheritedHistory.length)) !== canonicalStringify(inheritedHistory)
      || kinds.some((kind) => current.acceptedArtifacts[kind] !== parent.acceptedArtifacts[kind])
      || current.history.slice(inheritedHistory.length).some((entry) => entry.executionGeneration < receipt.nextExecutionGenerationMinimum)
      || (current.activeAttempt !== null && current.activeAttempt.executionGeneration < receipt.nextExecutionGenerationMinimum)) {
      fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Frontend repair progress no longer matches its retained parent.');
    }
  } else {
    await writeOrVerify(path.join(outputDirectory, 'state.json'), jsonBytes(state), MAX_RESPONSE_BYTES);
    await writeOrVerify(path.join(outputDirectory, 'current-prompt.md'), promptBytes, MAX_PROMPT_BYTES);
  }
  for (const [kind, bytes] of artifactBytes) {
    await writeOrVerify(path.join(outputDirectory, 'artifacts', `${kind}.json`), bytes, MAX_RESPONSE_BYTES);
  }
  await writeOrVerify(path.join(outputDirectory, 'original-request.md'), combinedRequestBytes, MAX_PROMPT_BYTES);
  await writeOrVerify(path.join(outputDirectory, '前端阶段-修复请求原文.txt'), Buffer.from(repairRequestText, 'utf8'), MAX_PROMPT_BYTES);
  await assertParentUnchanged();
  await writeOrVerifyReceipt(receiptFile, receipt);
  return receipt;
}

export async function prepareForgeFrontendRetryContinuation({
  catalogFile, sourceCaseDirectory, bindingsFile, expectedBindingsSha256,
  sourceCommit, originalRequestFile, outputDirectory,
}) {
  requiredId(expectedBindingsSha256, SHA256_PATTERN, 'expectedBindingsSha256');
  requiredId(sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  if (![sourceCaseDirectory, outputDirectory].every((value) => typeof value === 'string' && path.isAbsolute(value))
    || realpathSync(sourceCaseDirectory) !== sourceCaseDirectory
    || outputDirectory === sourceCaseDirectory
    || outputDirectory.startsWith(`${sourceCaseDirectory}${path.sep}`)
    || sourceCaseDirectory.startsWith(`${outputDirectory}${path.sep}`)) {
    fail('PHASE_CONTROLLER_PATH_INVALID', 'Frontend retry requires a separate ordinary retained case path.');
  }
  const bindingsBytes = await boundedRegularFile(bindingsFile, MAX_RESPONSE_BYTES,
    'reviewed frontend retry bindings', { trustedReview: true });
  if (sha256(bindingsBytes) !== expectedBindingsSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Reviewed frontend retry bindings changed.');
  }
  const bindings = JSON.parse(bindingsBytes.toString('utf8'));
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation'];
  const phaseNames = ['requirements', 'domain-contract', 'database', 'ui-design', 'backend'];
  const evidenceFiles = ['model.stdout.txt', 'controller-preflight-receipt.json',
    'independent-semantic-review.json', 'before-snapshot.json', 'all-changed-paths.json',
    'phase-changed-paths.json', 'phase.patch', 'cumulative.patch'];
  exactKeys(bindings, ['schemaVersion', 'sourceStateSha256', 'originalRequestSha256',
    'artifactSha256', 'evidenceSha256', 'currentPromptSha256'], 'frontend retry bindings');
  exactKeys(bindings.artifactSha256, kinds, 'frontend retry accepted artifact hashes');
  exactKeys(bindings.evidenceSha256, evidenceFiles, 'frontend retry evidence hashes');
  if (bindings.schemaVersion !== 'forge-delivery-frontend-retry-bindings/v1'
    || ![bindings.sourceStateSha256, bindings.originalRequestSha256, bindings.currentPromptSha256,
      ...Object.values(bindings.artifactSha256), ...Object.values(bindings.evidenceSha256)]
      .every((digest) => SHA256_PATTERN.test(digest))) {
    fail('PHASE_CONTROLLER_INPUT_INVALID', 'Frontend retry hashes are invalid.');
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  const stateFile = path.join(sourceCaseDirectory, 'phase-control/state.json');
  const stateBytes = await boundedRegularFile(stateFile, MAX_RESPONSE_BYTES, 'retained frontend state');
  if (sha256(stateBytes) !== bindings.sourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Retained frontend state differs from reviewed bytes.');
  }
  const state = validateForgeDeliveryPhaseState(JSON.parse(stateBytes.toString('utf8')), catalog);
  const phase = currentPhase(state, catalog);
  const accepted = await loadAcceptedArtifacts({ state, catalog,
    artifactsDirectory: path.join(sourceCaseDirectory, 'phase-control/artifacts') });
  const acceptedHistory = state.history.filter((entry) => entry.decision === 'accepted');
  if (state.schemaVersion !== 'forge-delivery-phase-state/v2' || state.sourceCommit !== sourceCommit
    || state.caseFamily !== 'crud-complete' || state.status !== 'active'
    || state.currentPhaseId !== 'frontend' || state.currentPhaseIndex !== 5
    || phase.maxAttempts !== 2 || state.activeAttempt?.phaseId !== 'frontend'
    || state.activeAttempt.executionGeneration !== state.lastExecutionGeneration
    || state.history.some((entry) => entry.phaseId === 'frontend')
    || accepted.length !== 5 || acceptedHistory.length !== 5
    || acceptedHistory.some((entry, index) => entry.phaseIndex !== index
      || entry.phaseId !== phaseNames[index]
      || entry.artifactDigest !== state.acceptedArtifacts[kinds[index]])) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only active FE01 after five accepted phases can continue.');
  }
  const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
  if (sha256(requestBytes) !== bindings.originalRequestSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Original request differs from reviewed input.');
  }
  const promptFile = path.join(sourceCaseDirectory, 'phase-control/current-prompt.md');
  const promptBytes = await boundedRegularFile(promptFile, MAX_PROMPT_BYTES, 'retained frontend prompt');
  if (sha256(promptBytes) !== bindings.currentPromptSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Frontend prompt differs from reviewed bytes.');
  }
  const artifactBytes = new Map();
  for (const kind of kinds) {
    const bytes = await boundedRegularFile(path.join(sourceCaseDirectory, 'phase-control/artifacts', `${kind}.json`),
      MAX_RESPONSE_BYTES, `retained ${kind}`);
    if (sha256(bytes) !== bindings.artifactSha256[kind]) {
      fail('PHASE_CONTROLLER_UPSTREAM_STALE', `Retained ${kind} differs from reviewed bytes.`);
    }
    artifactBytes.set(kind, bytes);
  }
  const evidenceDirectory = path.join(sourceCaseDirectory, 'phases/06-frontend/attempts/01');
  const evidenceBytes = new Map();
  for (const relative of evidenceFiles) {
    const bytes = await boundedRegularFile(path.join(evidenceDirectory, relative),
      relative.endsWith('.patch') ? MAX_PATCH_BYTES : MAX_RESPONSE_BYTES,
      `retained frontend ${relative}`, { allowEmpty: relative.endsWith('.patch'),
        trustedReview: relative === 'independent-semantic-review.json' });
    if (sha256(bytes) !== bindings.evidenceSha256[relative]) {
      fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', `Retained frontend ${relative} differs from reviewed bytes.`);
    }
    evidenceBytes.set(relative, bytes);
  }
  const preflight = JSON.parse(evidenceBytes.get('controller-preflight-receipt.json').toString('utf8'));
  if (preflight.phasePatchDigest !== sha256(evidenceBytes.get('phase.patch'))
    || preflight.cumulativePatchDigest !== sha256(evidenceBytes.get('cumulative.patch'))
    || JSON.stringify(preflight.changedPaths)
      !== JSON.stringify(normalizedChangedPaths(JSON.parse(evidenceBytes.get('phase-changed-paths.json').toString('utf8'))))) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Frontend preflight does not bind retained patch observations.');
  }
  if (sha256(await boundedRegularFile(stateFile, MAX_RESPONSE_BYTES, 'retained frontend state'))
    !== bindings.sourceStateSha256) {
    fail('PHASE_CONTROLLER_SOURCE_STATE_MISMATCH', 'Retained frontend state changed during admission.');
  }
  const control = path.join(outputDirectory, 'phase-control');
  const attempt = path.join(outputDirectory, 'phases/06-frontend/attempts/01');
  await writeExclusive(path.join(control, 'state.json'), stateBytes);
  await writeExclusive(path.join(control, 'current-prompt.md'), promptBytes);
  for (const [kind, bytes] of artifactBytes) await writeExclusive(path.join(control, 'artifacts', `${kind}.json`), bytes);
  for (const [relative, bytes] of evidenceBytes) await writeExclusive(path.join(attempt, relative), bytes);
  const inspected = await inspectForgeDeliveryPhaseSemanticReview({ catalogFile,
    stateFile: path.join(control, 'state.json'), responseFile: path.join(attempt, 'model.stdout.txt'),
    preflightReceiptFile: path.join(attempt, 'controller-preflight-receipt.json'),
    semanticReviewFile: path.join(attempt, 'independent-semantic-review.json') });
  if (inspected.verdict !== 'reject' || inspected.phaseAttemptId !== state.activeAttempt.attemptId
    || inspected.candidateArtifactDigest !== preflight.candidateArtifactDigest) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Only the reviewed FE01 rejection can continue.');
  }
  const rejection = await rejectForgeDeliveryPhaseRun({ catalogFile,
    stateFile: path.join(control, 'state.json'), reasonCode: 'SEMANTIC_INDEPENDENT_REVIEW_REJECTED',
    receiptFile: path.join(attempt, 'controller', 'rejection-receipt.json') });
  const nextPromptFile = path.join(control, 'current-prompt.md');
  const retryReceiptFile = forgeDeliveryPhaseRetryPromptReceiptPath(nextPromptFile, rejection.attemptId);
  const retry = await createForgeDeliveryPhaseRetryPrompt({ catalogFile,
    stateFile: path.join(control, 'state.json'), artifactsDirectory: path.join(control, 'artifacts'),
    originalRequestFile, responseFile: path.join(attempt, 'model.stdout.txt'),
    preflightReceiptFile: path.join(attempt, 'controller-preflight-receipt.json'),
    semanticReviewFile: path.join(attempt, 'independent-semantic-review.json'),
    promptFile: nextPromptFile, receiptFile: retryReceiptFile });
  const next = await readForgeDeliveryPhaseState(path.join(control, 'state.json'), catalog);
  if (next.activeAttempt !== null || next.currentPhaseId !== 'frontend'
    || Object.keys(next.acceptedArtifacts).length !== 5 || retry.remainingAttempts !== 1
    || sha256(await boundedRegularFile(stateFile, MAX_RESPONSE_BYTES, 'retained frontend state'))
      !== bindings.sourceStateSha256) {
    fail('PHASE_CONTROLLER_CONTINUATION_DENIED', 'Frontend retry did not retain its original five accepted stages.');
  }
  const receipt = Object.freeze({ schemaVersion: 'forge-delivery-frontend-retry-continuation/v1',
    sourceStateSha256: bindings.sourceStateSha256, bindingsSha256: expectedBindingsSha256,
    sourceCommit, catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest,
    taskId: state.taskId, sessionId: state.sessionId,
    parentLastExecutionGeneration: state.lastExecutionGeneration,
    nextExecutionGenerationMinimum: rejection.executionGeneration + 1,
    inheritedArtifactDigests: Object.fromEntries(kinds.map((kind) => [kind, state.acceptedArtifacts[kind]])),
    rejectedAttemptId: rejection.attemptId, rejectedExecutionGeneration: rejection.executionGeneration,
    rejectionReceiptDigest: rejection.receiptDigest,
    responseSha256: inspected.responseSha256, candidateArtifactDigest: inspected.candidateArtifactDigest,
    preflightReceiptSha256: bindings.evidenceSha256['controller-preflight-receipt.json'],
    semanticReviewSha256: bindings.evidenceSha256['independent-semantic-review.json'],
    stateDigest: next.stateDigest,
    promptSha256: sha256(await boundedRegularFile(nextPromptFile, MAX_PROMPT_BYTES, 'frontend retry prompt')),
    retryPromptReceiptSha256: sha256(await boundedRegularFile(retryReceiptFile, MAX_RESPONSE_BYTES,
      'frontend retry prompt receipt')),
    retryPromptDigest: retry.retryPromptDigest,
    inheritedStageCount: 5, newAcceptedStageCount: 0, remainingAttempts: 1,
    newModelStarted: false, parentStateUnchanged: true });
  await writeExclusive(path.join(control, 'frontend-continuation-receipt.json'), jsonBytes(receipt));
  return receipt;
}

export async function preflightForgeDeliveryPhaseRun({
  catalogFile,
  stateFile,
  artifactsDirectory,
  responseFile,
  allChangedPathsFile,
  phaseChangedPathsFile,
  phasePatchFile,
  cumulativePatchFile,
  receiptFile,
  expectedAttemptId,
}) {
  const [{ catalog }, responseBytes, allChangedPathsValue, phaseChangedPathsValue,
    phasePatchBytes, cumulativePatchBytes] = await Promise.all([
    loadForgeDeliveryPhaseCatalog(catalogFile),
    boundedRegularFile(responseFile, MAX_RESPONSE_BYTES, 'model response'),
    readJsonFile(allChangedPathsFile, MAX_RESPONSE_BYTES, 'observed changed paths'),
    readJsonFile(phaseChangedPathsFile, MAX_RESPONSE_BYTES, 'phase changed paths'),
    boundedRegularFile(phasePatchFile, MAX_PATCH_BYTES, 'phase patch', { allowEmpty: true }),
    boundedRegularFile(cumulativePatchFile, MAX_PATCH_BYTES, 'cumulative patch', { allowEmpty: true }),
  ]);
  const response = responseBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  const allChangedPaths = normalizedChangedPaths(allChangedPathsValue);
  const phaseChangedPaths = normalizedChangedPaths(phaseChangedPathsValue);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    if (expectedAttemptId !== undefined && state.activeAttempt?.attemptId !== expectedAttemptId) {
      fail('PHASE_CONTROLLER_ATTEMPT_CHANGED', 'The captured conversation no longer belongs to the active phase attempt.');
    }
    const candidate = await evaluatePhaseCandidate({
      state,
      stateFile,
      catalog,
      artifactsDirectory,
      response,
      allChangedPaths,
      phaseChangedPaths,
      phasePatchBytes,
      cumulativePatchBytes,
    });
    if (candidate.artifact.unresolvedDecisions.length > 0) {
      fail('PHASE_CONTROLLER_BUSINESS_DECISION_REQUIRED', 'Unresolved business decisions prohibit Host Runner execution.');
    }
    const receipt = {
      schemaVersion: 'forge-delivery-phase-controller-preflight/v1',
      workflowId: state.workflowId,
      phaseId: candidate.phase.id,
      phaseIndex: candidate.phase.index,
      phaseAttemptId: state.activeAttempt.attemptId,
      candidateArtifactDigest: candidate.artifact.artifactDigest,
      phasePatchDigest: candidate.patchDigest,
      cumulativePatchDigest: candidate.cumulativePatchDigest,
      changedPaths: candidate.currentChangedPaths,
      hostVerificationProfiles: candidate.phase.hostVerificationProfiles,
      safeForOperatorHostVerification: true,
      stateAdvanced: false,
    };
    await writeExclusive(receiptFile, jsonBytes(receipt));
    return Object.freeze(receipt);
  });
}

export async function rejectForgeDeliveryPhaseRun({
  catalogFile,
  stateFile,
  reasonCode,
  receiptFile,
}) {
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const rejected = completeForgeDeliveryPhase({
      state,
      catalog,
      decision: 'rejected',
      reasonCode,
    });
    await writeForgeDeliveryPhaseState(stateFile, rejected.state, catalog);
    await writeExclusive(receiptFile, jsonBytes(rejected.receipt));
    return Object.freeze(rejected.receipt);
  });
}

export async function inspectForgeDeliveryPhaseSemanticReview({
  catalogFile, stateFile, responseFile, preflightReceiptFile, semanticReviewFile,
}) {
  const [{ catalog }, responseBytes, preflightBytes, reviewBytes] = await Promise.all([
    loadForgeDeliveryPhaseCatalog(catalogFile),
    boundedRegularFile(responseFile, MAX_RESPONSE_BYTES, 'model response'),
    boundedRegularFile(preflightReceiptFile, MAX_RESPONSE_BYTES, 'controller preflight receipt'),
    boundedRegularFile(semanticReviewFile, MAX_RESPONSE_BYTES, 'independent semantic review', { trustedReview: true }),
  ]);
  const preflight = JSON.parse(preflightBytes.toString('utf8'));
  const review = JSON.parse(reviewBytes.toString('utf8'));
  const state = await readForgeDeliveryPhaseState(stateFile, catalog);
  const phase = currentPhase(state, catalog);
  if (state.status !== 'active' || state.activeAttempt === null) {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Review requires the current active attempt.');
  }
  validateRetryPreflightReceipt(preflight, { state, phase, rejection: state.activeAttempt });
  const digest = recomputeRejectedCandidateDigest({
    state, phase, rejection: state.activeAttempt,
    response: responseBytes.toString('utf8').replace(/(?:\r?\n)+$/u, ''),
    preflightReceipt: preflight,
  });
  if (digest !== preflight.candidateArtifactDigest) {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Review preflight candidate differs from response bytes.');
  }
  validateIndependentSemanticReview(review, {
    phase, responseSha256: sha256(responseBytes), candidateArtifactDigest: digest,
  });
  return Object.freeze({ verdict: review.verdict, phaseId: phase.id,
    phaseAttemptId: state.activeAttempt.attemptId, candidateArtifactDigest: digest,
    responseSha256: sha256(responseBytes), semanticReviewSha256: sha256(reviewBytes) });
}

export async function createForgeDeliveryPhaseRetryPrompt({
  catalogFile,
  stateFile,
  artifactsDirectory,
  originalRequestFile,
  responseFile,
  preflightReceiptFile,
  semanticReviewFile,
  promptFile,
  receiptFile,
}) {
  const [{ catalog }, requestBytes, responseBytes, preflightBytes, reviewBytes, previousPromptBytes] = await Promise.all([
    loadForgeDeliveryPhaseCatalog(catalogFile),
    boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request'),
    boundedRegularFile(responseFile, MAX_RESPONSE_BYTES, 'rejected model response'),
    boundedRegularFile(preflightReceiptFile, MAX_RESPONSE_BYTES, 'controller preflight receipt'),
    boundedRegularFile(semanticReviewFile, MAX_RESPONSE_BYTES, 'independent semantic review', { trustedReview: true }),
    boundedRegularFile(promptFile, MAX_PROMPT_BYTES, 'current phase prompt'),
  ]);
  let preflightReceipt;
  let semanticReview;
  try {
    preflightReceipt = JSON.parse(preflightBytes.toString('utf8'));
    semanticReview = JSON.parse(reviewBytes.toString('utf8'));
  } catch {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Retry evidence is not valid JSON.');
  }
  const originalRequest = requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  const response = responseBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  const previousPrompt = previousPromptBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  const responseSha256 = sha256(responseBytes);
  const preflightReceiptSha256 = sha256(preflightBytes);
  const semanticReviewSha256 = sha256(reviewBytes);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const phase = currentPhase(state, catalog);
    const rejection = state.history.at(-1);
    const phaseAttempts = state.history.filter((entry) => (
      entry.schemaVersion === 'forge-delivery-phase-receipt/v1' && entry.phaseId === phase.id
    )).length;
    if (state.status !== 'active' || state.activeAttempt !== null || rejection?.decision !== 'rejected'
      || rejection.phaseId !== phase.id || typeof rejection.reasonCode !== 'string'
      || !rejection.reasonCode.startsWith('SEMANTIC_') || phaseAttempts !== 1
      || phaseAttempts >= phase.maxAttempts) {
      fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Only the latest rejected current phase with remaining budget can produce a retry prompt.');
    }
    validateRetryPreflightReceipt(preflightReceipt, { state, phase, rejection });
    const recomputedCandidateDigest = recomputeRejectedCandidateDigest({
      state,
      phase,
      rejection,
      response,
      preflightReceipt,
    });
    if (recomputedCandidateDigest !== preflightReceipt.candidateArtifactDigest) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Preflight candidate digest does not match the rejected response.');
    }
    validateIndependentSemanticReview(semanticReview, {
      phase,
      responseSha256,
      candidateArtifactDigest: preflightReceipt.candidateArtifactDigest,
    });
    if (semanticReview.verdict !== 'reject') {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Only a rejected review can authorize a retry prompt.');
    }
    const acceptedArtifacts = await loadAcceptedArtifacts({ state, catalog, artifactsDirectory });
    const upstreamArtifacts = requiredUpstreamArtifacts(acceptedArtifacts, phase);
    const basePrompt = buildForgeDeliveryPhasePrompt({
      state,
      catalog,
      originalRequest,
      upstreamArtifacts,
    });
    if (previousPrompt !== basePrompt) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Original request or current phase prompt changed after the rejected attempt.');
    }
    const prompt = buildRetryPrompt(basePrompt, {
      rejection,
      responseSha256,
      preflightReceiptSha256,
      semanticReviewSha256,
      review: semanticReview,
    });
    const promptBytes = Buffer.from(`${prompt}\n`, 'utf8');
    if (promptBytes.length > MAX_PROMPT_BYTES) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Retry prompt exceeds the protected prompt limit.');
    }
    const receipt = Object.freeze({
      schemaVersion: RETRY_PROMPT_RECEIPT_SCHEMA,
      issuer: 'forge-phase-controller',
      workflowId: state.workflowId,
      phaseId: phase.id,
      phaseIndex: phase.index,
      sourceCommit: state.sourceCommit,
      catalogVersion: state.catalogVersion,
      catalogDigest: state.catalogDigest,
      stateDigest: state.stateDigest,
      rejectedAttemptId: rejection.attemptId,
      rejectedExecutionGeneration: rejection.executionGeneration,
      rejectionReceiptDigest: rejection.receiptDigest,
      reasonCode: rejection.reasonCode,
      previousPromptDigest: sha256(Buffer.from(previousPrompt, 'utf8')),
      originalRequestSha256: sha256(requestBytes),
      responseSha256,
      candidateArtifactDigest: preflightReceipt.candidateArtifactDigest,
      preflightReceiptSha256,
      semanticReviewSha256,
      upstreamArtifactDigests: Object.fromEntries(upstreamArtifacts.map((artifact) => [
        artifact.artifactKind,
        artifact.artifactDigest,
      ])),
      retryPromptDigest: sha256(Buffer.from(prompt, 'utf8')),
      remainingAttempts: phase.maxAttempts - phaseAttempts,
      stateAdvanced: false,
    });
    if (typeof receiptFile !== 'string' || !path.isAbsolute(receiptFile)
      || path.resolve(receiptFile) !== forgeDeliveryPhaseRetryPromptReceiptPath(promptFile, rejection.attemptId)) {
      fail('PHASE_CONTROLLER_RETRY_OUTPUT_INVALID', 'Retry prompt receipt path is not bound to the rejected attempt.');
    }
    const existingReceipt = await lstat(receiptFile).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existingReceipt !== null) {
      fail('PHASE_CONTROLLER_RETRY_OUTPUT_EXISTS', 'Retry prompt receipt path must be unused.');
    }
    await writeAtomic(promptFile, promptBytes);
    await writeExclusive(receiptFile, jsonBytes(receipt));
    return receipt;
  });
}

export function validateForgeRequirementsOverloadEvidence({ state, execution, baseline, begin, proof, attempt = state.activeAttempt }) {
  validateForgeRequirementsOverloadProof({ execution, baseline, proof });
  if (state.currentPhaseId !== 'requirements' || state.currentPhaseIndex !== 0
    || state.taskId !== execution.taskId || state.sessionId !== execution.dshSessionId
    || state.sourceCommit !== execution.sourceCommit || state.workflowId !== execution.workflowId
    || state.catalogVersion !== execution.phaseCatalogVersion || state.catalogDigest !== execution.phaseCatalogDigest
    || attempt === null || attempt === undefined || begin?.schemaVersion !== 'forge-delivery-browser-phase-begin/v1'
    || begin.workflowId !== state.workflowId || begin.phaseId !== 'requirements' || begin.phaseIndex !== 0
    || begin.attempt?.attemptId !== attempt.attemptId || attempt.rpcId !== execution.rpcId
    || attempt.executionGeneration !== execution.generation || attempt.promptDigest !== execution.textDigest
    || begin.attempt.rpcId !== attempt.rpcId || begin.attempt.executionGeneration !== attempt.executionGeneration
    || begin.attempt.promptDigest !== attempt.promptDigest) {
    fail('PHASE_CAPTURE_IDENTITY_CONFLICT', 'Provider overload proof does not match the retained requirements attempt.');
  }
  return proof;
}

async function writeOrVerifyBackendFeedback(file, bytes) {
  const prior = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (prior === null) return writeExclusive(file, bytes);
  if (!(await boundedRegularFile(file, MAX_PROMPT_BYTES, 'backend feedback')).equals(bytes)) {
    fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Backend feedback changed.');
  }
}

export function isForgeBackendUnfinishedCandidate(proposal) {
  const payload = proposal?.payload;
  const failure = payload?.apiImplementation?.latestGovernance;
  return proposal?.phaseId === 'backend' && proposal.unresolvedDecisions?.length === 0
    && Array.isArray(payload?.redTests?.retained) && payload.redTests.retained.length > 0
    && payload.redTests.evidence?.currentCandidateTestsRun === false
    && failure?.status === 'failed' && Number.isSafeInteger(failure.blockingFindings) && failure.blockingFindings > 0
    && UUID_PATTERN.test(failure.receiptId ?? '');
}

export async function retryForgeBackendUnfinishedPhase({ catalogFile, stateFile, artifactsDirectory,
  originalRequestFile, promptFile, attemptDirectory, workspace, sourceCommit, sourceFingerprint,
  failedReceipt, continuationText }) {
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const phase = currentPhase(state, catalog);
    const attempt = state.activeAttempt;
    if (state.status !== 'active' || state.workflowId !== 'crud-production' || phase.id !== 'backend' || phase.index !== 4
      || attempt === null || sourceCommit !== state.sourceCommit || !SHA256_PATTERN.test(sourceFingerprint ?? '')
      || path.dirname(attemptDirectory) !== path.join(path.dirname(stateFile), 'browser-attempts')
      || typeof continuationText !== 'string' || !continuationText.trim() || hasGlobalReadOnlyIntent(continuationText)) {
      fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Only the original unfinished backend may consume its remaining attempts.');
    }
    const retainedFiles = {};
    const inputs = {};
    for (const name of ['execution.json', 'session-baseline.json', 'begin.json', '阶段终态采集.json', '模型最终回答.txt']) {
      const bytes = await boundedRegularFile(path.join(attemptDirectory, name), MAX_RESPONSE_BYTES, name);
      retainedFiles[name] = sha256(bytes);
      inputs[name] = name.endsWith('.txt') ? bytes.toString('utf8') : JSON.parse(bytes.toString('utf8'));
    }
    const execution = inputs['execution.json']; const baseline = inputs['session-baseline.json'];
    const begin = inputs['begin.json']; const capture = inputs['阶段终态采集.json']; const proof = capture.sessionProof;
    validateProtectedExecutionContext(execution);
    const identityFields = ['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
      'conversationId', 'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint', 'workflowId',
      'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'];
    if (execution.executionId !== path.basename(attemptDirectory) || execution.taskId !== state.taskId
      || execution.dshSessionId !== state.sessionId || execution.sourceCommit !== state.sourceCommit
      || execution.workflowId !== state.workflowId || execution.phaseId !== phase.id || execution.phaseIndex !== phase.index
      || execution.phaseCatalogVersion !== state.catalogVersion || execution.phaseCatalogDigest !== state.catalogDigest
      || execution.testOnly !== false || execution.authorityClass !== 'production-task-writer' || execution.actionCeiling !== 'workspace-write'
      || execution.rpcId !== attempt.rpcId || execution.generation !== attempt.executionGeneration
      || execution.textDigest !== attempt.promptDigest || canonicalStringify(begin.attempt) !== canonicalStringify(attempt)
      || proof?.schemaVersion !== 'forge-delivery-phase-browser-session-proof/v1'
      || baseline?.schemaVersion !== 'forge-delivery-phase-browser-session-baseline/v1'
      || identityFields.some(key => proof[key] !== execution[key] || baseline[key] !== execution[key])
      || proof.terminalReason !== 'completed' || proof.hostReceiptsDerived !== false || proof.sessionCwd !== '/workspace'
      || proof.baselineObservedSeq !== baseline.observedSeq || proof.requestSeq <= baseline.observedSeq
      || proof.assistantMessageSeq <= proof.requestSeq || proof.terminalSeq <= proof.assistantMessageSeq
      || !SHA256_PATTERN.test(proof.terminalEventDigest ?? '')
      || capture.modelResponse !== inputs['模型最终回答.txt'] || sha256(Buffer.from(capture.modelResponse)) !== proof.modelResponseSha256) {
      fail('PHASE_CAPTURE_IDENTITY_CONFLICT', 'Backend failure must bind the original protected completed turn.');
    }
    const proposal = parseForgeDeliveryPhaseProposal({ text: capture.modelResponse, phase });
    if (!isForgeBackendUnfinishedCandidate(proposal)) fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'No matching unfinished backend failure.');
    const failureId = proposal.payload.apiImplementation.latestGovernance.receiptId;
    validateHostRunReceipt(failedReceipt, { projectSlug: execution.projectSlug, taskId: state.taskId,
      profile: 'governance', receiptId: failureId, sourceFingerprint: failedReceipt?.source?.workspaceFingerprint });
    if (failedReceipt.status !== 'failed' || failedReceipt.truth.executionProven !== true
      || failedReceipt.truth.verificationProven !== false || failedReceipt.source.head !== state.sourceCommit
      || Date.parse(failedReceipt.execution.startedAt) < Date.parse(execution.issuedAt)) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'A real failed Host run is required; stale evidence cannot prove acceptance.');
    }
    const before = await readJsonFile(path.join(path.dirname(stateFile), 'phase-4-workspace-before.json'), MAX_RESPONSE_BYTES, 'backend baseline');
    const observed = await observeForgeDeliveryPhase({ workspace, baseCommit: state.sourceCommit, before });
    const accepted = await loadAcceptedArtifacts({ state, catalog, artifactsDirectory });
    const paths = observePhasePaths({ allChangedPaths: [...observed.allChangedPaths].sort(), phaseChangedPaths: [...observed.phaseChangedPaths].sort(), acceptedArtifacts: accepted, phase });
    if (!Array.isArray(proposal.payload.changedPaths) || paths.length === 0
      || canonicalStringify([...paths].sort()) !== canonicalStringify([...proposal.payload.changedPaths].sort())
      || paths.some(file => !phase.ownedPaths.some(owned => isForgeTaskOwnedPath(file, owned)) || Object.hasOwn(before.entries, file))) {
      fail('PHASE_CAPTURE_IDENTITY_CONFLICT', 'Backend retry cannot replace upstream files or expand the failed candidate scope.');
    }
    const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
    const request = requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
    const feedbackBytes = Buffer.from(continuationText, 'utf8');
    const evidence = { schemaVersion: 'forge-backend-unfinished-evidence/v1', attemptId: attempt.attemptId,
      executionGeneration: attempt.executionGeneration, executionId: execution.executionId, sourceCommit: state.sourceCommit,
      sourceFingerprint, snapshotDigest: observed.snapshot.snapshotDigest, changedPaths: paths,
      acceptedArtifacts: state.acceptedArtifacts, retainedFiles, failedHostReceipt: failedReceipt,
      reasonCode: BACKEND_UNFINISHED_REASON, hostReceiptProvesCurrentCandidatePassed: false };
    const evidenceBytes = jsonBytes(evidence);
    await writeOrVerifyReceipt(path.join(attemptDirectory, '后端阶段-失败续修证据.json'), evidence);
    await writeOrVerifyBackendFeedback(path.join(attemptDirectory, '后端阶段-失败续修反馈.txt'), feedbackBytes);
    const rejected = completeForgeDeliveryPhase({ state, catalog, decision: 'rejected', reasonCode: BACKEND_UNFINISHED_REASON });
    await writeOrVerifyReceipt(path.join(attemptDirectory, '后端阶段-失败续修拒绝凭据.json'), rejected.receipt);
    if (rejected.state.status === 'blocked') {
      await writeForgeDeliveryPhaseState(stateFile, rejected.state, catalog);
      return { status: 'exhausted', receipt: rejected.receipt };
    }
    const prompt = buildForgeDeliveryPhasePrompt({ state: rejected.state, catalog,
      originalRequest: `${request}\n\n${continuationText}`, upstreamArtifacts: requiredUpstreamArtifacts(accepted, phase) });
    const receipt = { schemaVersion: BACKEND_UNFINISHED_RETRY_SCHEMA, issuer: 'forge-phase-controller', workflowId: state.workflowId,
      phaseId: phase.id, phaseIndex: phase.index, sourceCommit: state.sourceCommit, catalogVersion: state.catalogVersion,
      catalogDigest: state.catalogDigest, stateDigest: rejected.state.stateDigest, rejectedAttemptId: attempt.attemptId,
      rejectedExecutionGeneration: attempt.executionGeneration, rejectionReceiptDigest: rejected.receipt.receiptDigest,
      reasonCode: BACKEND_UNFINISHED_REASON, executionId: execution.executionId, originalRequestSha256: sha256(requestBytes),
      failureEvidenceSha256: sha256(evidenceBytes), feedbackSha256: sha256(feedbackBytes), retryPromptDigest: sha256(Buffer.from(prompt)),
      remainingAttempts: phase.maxAttempts - rejected.state.history.filter(item => item.phaseId === phase.id).length, stateAdvanced: false };
    await writeOrVerifyReceipt(forgeDeliveryPhaseRetryPromptReceiptPath(promptFile, attempt.attemptId), receipt);
    await writeAtomic(promptFile, Buffer.from(`${prompt}\n`, 'utf8'));
    await writeForgeDeliveryPhaseState(stateFile, rejected.state, catalog);
    return { status: 'retry-ready', receipt };
  });
}

export async function retryForgeRequirementsOverloadPhase({
  catalogFile, stateFile, originalRequestFile, promptFile, attemptDirectory,
}) {
  if (path.dirname(attemptDirectory) !== path.join(path.dirname(stateFile), 'browser-attempts')) {
    fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Provider overload retry requires the original private browser attempt.');
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const phase = currentPhase(state, catalog);
    const files = { executionSha256: 'execution.json', baselineSha256: 'session-baseline.json',
      beginSha256: 'begin.json', providerFailureProofSha256: '需求阶段-供应方临时故障证明.json' };
    const inputs = {};
    const digests = {};
    for (const [key, name] of Object.entries(files)) {
      const bytes = await boundedRegularFile(path.join(attemptDirectory, name), MAX_RESPONSE_BYTES, name);
      inputs[key] = JSON.parse(bytes.toString('utf8')); digests[key] = sha256(bytes);
    }
    const execution = inputs.executionSha256;
    const last = state.history.at(-1);
    const replay = state.activeAttempt === null && last?.decision === 'rejected'
      && last.reasonCode === REQUIREMENTS_OVERLOAD_REASON && last.attemptId === inputs.beginSha256.attempt?.attemptId
      && last.executionGeneration === inputs.beginSha256.attempt?.executionGeneration;
    const attempt = replay ? inputs.beginSha256.attempt : state.activeAttempt;
    validateForgeRequirementsOverloadEvidence({ state, execution, baseline: inputs.baselineSha256,
      begin: inputs.beginSha256, proof: inputs.providerFailureProofSha256, attempt });
    if (path.basename(attemptDirectory) !== execution.executionId || (!replay && state.status !== 'active')
      || phase.id !== 'requirements' || phase.index !== 0 || phase.actionCeiling !== 'read-only'
      || phase.ownedPaths.length !== 0 || Object.keys(state.acceptedArtifacts).length !== 0) {
      fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Only the original readonly requirements may consume its remaining attempt budget.');
    }
    const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
    const promptBytes = await boundedRegularFile(promptFile, MAX_PROMPT_BYTES, 'current prompt');
    const prompt = promptBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
    const originalRequest = requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
    const promptState = idleBrowserStateProjection(state, catalog);
    if (digestDirectUserTextContent([{ type: 'text', text: prompt }]) !== attempt.promptDigest
      || prompt !== buildForgeDeliveryPhasePrompt({ state: promptState, catalog, originalRequest, upstreamArtifacts: [] })) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Provider overload retry must retain the original protected requirements prompt.');
    }
    const rejectionFile = path.join(attemptDirectory, '需求阶段-供应方临时故障拒绝凭据.json');
    const prior = await lstat(rejectionFile).then(
      () => readJsonFile(rejectionFile, MAX_RESPONSE_BYTES, 'retained provider overload rejection'),
      (error) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (prior !== null && (prior.attemptId !== attempt.attemptId || prior.executionGeneration !== attempt.executionGeneration
      || prior.reasonCode !== REQUIREMENTS_OVERLOAD_REASON)) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Retained provider rejection belongs to another attempt.');
    }
    const rejected = replay ? { state, receipt: last } : completeForgeDeliveryPhase({ state, catalog,
      decision: 'rejected', reasonCode: REQUIREMENTS_OVERLOAD_REASON, ...(prior === null ? {} : { now: prior.completedAt }) });
    await writeOrVerifyReceipt(rejectionFile, rejected.receipt);
    if (rejected.state.status === 'blocked') {
      if (!replay) await writeForgeDeliveryPhaseState(stateFile, rejected.state, catalog);
      return { status: 'exhausted', receipt: rejected.receipt };
    }
    const receipt = { schemaVersion: REQUIREMENTS_OVERLOAD_RETRY_SCHEMA, issuer: 'forge-phase-controller',
      workflowId: state.workflowId, phaseId: phase.id, phaseIndex: phase.index, sourceCommit: state.sourceCommit,
      catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest, stateDigest: rejected.state.stateDigest,
      rejectedAttemptId: attempt.attemptId, rejectedExecutionGeneration: attempt.executionGeneration,
      rejectionReceiptDigest: rejected.receipt.receiptDigest, reasonCode: REQUIREMENTS_OVERLOAD_REASON,
      executionId: execution.executionId, originalRequestSha256: sha256(requestBytes), ...digests,
      retryPromptDigest: sha256(Buffer.from(prompt, 'utf8')),
      remainingAttempts: phase.maxAttempts - rejected.state.history.filter((entry) => (
        entry.schemaVersion === 'forge-delivery-phase-receipt/v1' && entry.phaseId === phase.id)).length,
      stateAdvanced: false };
    await writeOrVerifyReceipt(forgeDeliveryPhaseRetryPromptReceiptPath(promptFile, attempt.attemptId), receipt);
    if (!replay) await writeForgeDeliveryPhaseState(stateFile, rejected.state, catalog);
    return { status: 'retry-ready', receipt };
  });
}

export function validateForgeFrontendUserAbortedEvidence(input) {
  return validateUserAbortedEvidence(input, 'frontend', 5, 'production-task-writer');
}

export function validateForgeDomainUserAbortedEvidence(input) {
  if (input.execution?.actionCeiling !== 'read-only' || input.execution?.ownedPaths?.length !== 0) {
    fail('PHASE_CAPTURE_IDENTITY_CONFLICT', 'Domain interruption must belong to a read-only execution.');
  }
  return validateUserAbortedEvidence(input, 'domain-contract', 1, 'production-read-only');
}

function validateUserAbortedEvidence({ state, execution, baseline, begin, proof, attempt = state.activeAttempt },
  phaseId, phaseIndex, authorityClass) {
  validateProtectedExecutionContext(execution);
  const identity = ['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint', 'workflowId',
    'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'];
  exactKeys(proof, ['schemaVersion', ...identity, 'baselineObservedSeq', 'requestSeq', 'terminalSeq',
    'terminalReason', 'toolCallCount', 'toolResultCount', 'toolResults', 'terminalEventDigest', 'sessionCwd',
    'sessionRunning', 'historyPages', 'historyEventCount', 'hostReceiptsDerived'], 'user-aborted session proof');
  if (proof.schemaVersion !== 'forge-delivery-phase-browser-interruption-proof/v1'
    || proof.terminalReason !== 'user-aborted' || proof.sessionRunning !== false || proof.hostReceiptsDerived !== false
    || identity.some((key) => proof[key] !== execution[key] || baseline?.[key] !== execution[key])
    || baseline?.schemaVersion !== 'forge-delivery-phase-browser-session-baseline/v1'
    || proof.sessionCwd !== '/workspace' || baseline.sessionCwd !== proof.sessionCwd
    || proof.baselineObservedSeq !== baseline.observedSeq || !Number.isSafeInteger(proof.baselineObservedSeq)
    || !Number.isSafeInteger(proof.requestSeq) || proof.requestSeq <= proof.baselineObservedSeq
    || !Number.isSafeInteger(proof.terminalSeq) || proof.terminalSeq <= proof.requestSeq
    || !SHA256_PATTERN.test(proof.terminalEventDigest ?? '')
    || !Number.isSafeInteger(proof.toolCallCount) || proof.toolCallCount < 0
    || proof.toolResultCount !== proof.toolCallCount || !Array.isArray(proof.toolResults)
    || proof.toolResults.length !== proof.toolCallCount
    || proof.toolResults.some((tool) => !['success', 'error'].includes(tool.status)
      || !Number.isSafeInteger(tool.resultSeq) || tool.resultSeq <= proof.requestSeq || tool.resultSeq >= proof.terminalSeq)
    || state.currentPhaseId !== phaseId || state.currentPhaseIndex !== phaseIndex
    || state.taskId !== execution.taskId || state.sessionId !== execution.dshSessionId
    || state.sourceCommit !== execution.sourceCommit || state.workflowId !== execution.workflowId
    || state.catalogVersion !== execution.phaseCatalogVersion || state.catalogDigest !== execution.phaseCatalogDigest
    || execution.phaseId !== phaseId || execution.phaseIndex !== phaseIndex || execution.testOnly !== false
    || execution.authorityClass !== authorityClass || attempt === null || attempt === undefined
    || begin?.schemaVersion !== 'forge-delivery-browser-phase-begin/v1'
    || begin.attempt?.attemptId !== attempt.attemptId || begin.workflowId !== state.workflowId
    || begin.phaseId !== phaseId || begin.phaseIndex !== phaseIndex
    || attempt.rpcId !== execution.rpcId || attempt.executionGeneration !== execution.generation
    || attempt.promptDigest !== execution.textDigest || begin.attempt.rpcId !== attempt.rpcId
    || begin.attempt.executionGeneration !== attempt.executionGeneration || begin.attempt.promptDigest !== attempt.promptDigest) {
    fail('PHASE_CAPTURE_IDENTITY_CONFLICT', 'User interruption proof does not match the retained phase attempt.');
  }
  return proof;
}

export function isForgeFrontendReadonlyRoleRecoveryCandidate({ execution, promptText }) {
  return execution?.phaseId === 'frontend' && execution.phaseIndex === 5
    && execution.authorityClass === 'production-task-writer' && execution.testOnly === false
    && execution.actionCeiling === 'workspace-write' && execution.contract?.actionCeiling === 'workspace-write'
    && typeof promptText === 'string' && /只读\s*角色/u.test(promptText)
    && digestDirectUserTextContent([{ type: 'text', text: promptText }]) === execution.textDigest
    && !hasGlobalReadOnlyIntent(promptText);
}

export function validateForgeAccessScopeDeniedEvidence({
  state, execution, baseline, begin, sessionProof, proof, catalog, attempt = state.activeAttempt,
}) {
  validateProtectedExecutionContext(execution);
  const identity = ['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint', 'workflowId',
    'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'];
  exactKeys(proof, ['schemaVersion', ...identity, 'baselineObservedSeq', 'requestSeq', 'terminalSeq',
    'terminalReason', 'terminalEventDigest', 'modelResponseSha256', 'sessionProofDigest', 'sessionCwd',
    'sessionRunning', 'toolCallCount', 'toolResultCount', 'denials', 'hostReceiptsDerived'], 'readonly-role denial proof');
  const phase = catalog.workflows.find(item => item.id === state.workflowId)?.phases[6];
  if (execution.phaseId !== 'access-wiring' || execution.phaseIndex !== 6
    || execution.actionCeiling !== 'workspace-write' || execution.authorityClass !== 'production-task-writer' || execution.testOnly !== false
    || !phase || execution.ownedPaths.length === 0
    || execution.ownedPaths.some(owned => !owned.includes('/src/test/java') || !phase.ownedPaths.some(root => isForgeTaskOwnedPath(owned, root)))
    || proof.schemaVersion !== 'forge-delivery-access-scope-denial-proof/v1'
    || sessionProof?.schemaVersion !== 'forge-delivery-phase-browser-session-proof/v1'
    || baseline?.schemaVersion !== 'forge-delivery-phase-browser-session-baseline/v1'
    || proof.terminalReason !== 'completed' || proof.sessionRunning !== false || proof.hostReceiptsDerived !== false
    || ['terminalReason', 'terminalSeq', 'terminalEventDigest', 'modelResponseSha256', 'requestSeq',
      'toolCallCount', 'toolResultCount', 'sessionCwd', 'hostReceiptsDerived']
      .some((key) => proof[key] !== sessionProof[key])
    || identity.some((key) => proof[key] !== execution[key] || baseline[key] !== execution[key] || sessionProof[key] !== execution[key])
    || proof.sessionProofDigest !== sha256(Buffer.from(JSON.stringify(sessionProof), 'utf8'))
    || proof.sessionCwd !== '/workspace' || baseline.sessionCwd !== proof.sessionCwd
    || proof.baselineObservedSeq !== baseline.observedSeq || proof.baselineObservedSeq !== sessionProof.baselineObservedSeq
    || !Number.isSafeInteger(proof.requestSeq) || proof.requestSeq <= proof.baselineObservedSeq
    || !Number.isSafeInteger(proof.terminalSeq) || proof.terminalSeq <= proof.requestSeq
    || !SHA256_PATTERN.test(proof.terminalEventDigest ?? '') || !SHA256_PATTERN.test(proof.modelResponseSha256 ?? '')
    || !Number.isSafeInteger(proof.toolCallCount) || proof.toolCallCount < 1 || proof.toolResultCount !== proof.toolCallCount
    || !Array.isArray(sessionProof.toolResults) || sessionProof.toolResults.length !== proof.toolCallCount
    || !Array.isArray(proof.denials) || proof.denials.length < 1 || proof.denials.length > proof.toolCallCount
    || new Set(proof.denials.map((entry) => entry.callId)).size !== proof.denials.length
    || proof.denials.some((entry) => {
      const paired = sessionProof.toolResults.find((tool) => tool.callId === entry.callId);
      return !paired || !['write', 'edit'].includes(String(entry.tool).toLowerCase())
        || entry.status !== 'error' || entry.denialCode !== 'OWNED_PATH_SCOPE_CONSTRAINT'
        || typeof entry.attemptedPath !== 'string'
        || !phase.ownedPaths.some(owned => isForgeTaskOwnedPath(entry.attemptedPath, owned))
        || execution.ownedPaths.some(owned => isForgeTaskOwnedPath(entry.attemptedPath, owned))
        || !SHA256_PATTERN.test(entry.resultTextSha256 ?? '')
        || !Number.isSafeInteger(entry.callSeq) || entry.callSeq <= proof.requestSeq
        || !Number.isSafeInteger(entry.resultSeq) || entry.resultSeq <= entry.callSeq || entry.resultSeq >= proof.terminalSeq
        || ['callId', 'callSeq', 'tool', 'resultSeq', 'status'].some((key) => paired[key] !== entry[key]);
    })
    || state.currentPhaseId !== 'access-wiring' || state.currentPhaseIndex !== 6
    || state.taskId !== execution.taskId || state.sessionId !== execution.dshSessionId
    || state.sourceCommit !== execution.sourceCommit || state.workflowId !== execution.workflowId
    || state.catalogVersion !== execution.phaseCatalogVersion || state.catalogDigest !== execution.phaseCatalogDigest
    || attempt === null || attempt === undefined || begin?.schemaVersion !== 'forge-delivery-browser-phase-begin/v1'
    || begin.attempt?.attemptId !== attempt.attemptId || begin.workflowId !== state.workflowId
    || begin.phaseId !== 'access-wiring' || begin.phaseIndex !== 6 || attempt.rpcId !== execution.rpcId
    || attempt.executionGeneration !== execution.generation || attempt.promptDigest !== execution.textDigest
    || begin.attempt.rpcId !== attempt.rpcId || begin.attempt.executionGeneration !== attempt.executionGeneration
    || begin.attempt.promptDigest !== attempt.promptDigest) {
    fail('PHASE_ACCESS_SCOPE_EVIDENCE_INVALID', 'Owned-path denial is not bound to this narrowed runtime access execution.');
  }
  return proof;
}

export function validateForgeFrontendReadonlyRoleEvidence({
  state, execution, baseline, begin, sessionProof, proof, promptText, attempt = state.activeAttempt,
}) {
  validateProtectedExecutionContext(execution);
  const identity = ['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint', 'workflowId',
    'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'];
  exactKeys(proof, ['schemaVersion', ...identity, 'baselineObservedSeq', 'requestSeq', 'terminalSeq',
    'terminalReason', 'terminalEventDigest', 'modelResponseSha256', 'sessionProofDigest', 'sessionCwd',
    'sessionRunning', 'toolCallCount', 'toolResultCount', 'denials', 'hostReceiptsDerived'], 'readonly-role denial proof');
  if (!isForgeFrontendReadonlyRoleRecoveryCandidate({ execution, promptText })
    || proof.schemaVersion !== 'forge-delivery-frontend-readonly-denial-proof/v1'
    || sessionProof?.schemaVersion !== 'forge-delivery-phase-browser-session-proof/v1'
    || baseline?.schemaVersion !== 'forge-delivery-phase-browser-session-baseline/v1'
    || proof.terminalReason !== 'completed' || proof.sessionRunning !== false || proof.hostReceiptsDerived !== false
    || ['terminalReason', 'terminalSeq', 'terminalEventDigest', 'modelResponseSha256', 'requestSeq',
      'toolCallCount', 'toolResultCount', 'sessionCwd', 'hostReceiptsDerived']
      .some((key) => proof[key] !== sessionProof[key])
    || identity.some((key) => proof[key] !== execution[key] || baseline[key] !== execution[key] || sessionProof[key] !== execution[key])
    || proof.sessionProofDigest !== sha256(Buffer.from(JSON.stringify(sessionProof), 'utf8'))
    || proof.sessionCwd !== '/workspace' || baseline.sessionCwd !== proof.sessionCwd
    || proof.baselineObservedSeq !== baseline.observedSeq || proof.baselineObservedSeq !== sessionProof.baselineObservedSeq
    || !Number.isSafeInteger(proof.requestSeq) || proof.requestSeq <= proof.baselineObservedSeq
    || !Number.isSafeInteger(proof.terminalSeq) || proof.terminalSeq <= proof.requestSeq
    || !SHA256_PATTERN.test(proof.terminalEventDigest ?? '') || !SHA256_PATTERN.test(proof.modelResponseSha256 ?? '')
    || !Number.isSafeInteger(proof.toolCallCount) || proof.toolCallCount < 1 || proof.toolResultCount !== proof.toolCallCount
    || !Array.isArray(sessionProof.toolResults) || sessionProof.toolResults.length !== proof.toolCallCount
    || !Array.isArray(proof.denials) || proof.denials.length < 1 || proof.denials.length > proof.toolCallCount
    || new Set(proof.denials.map((entry) => entry.callId)).size !== proof.denials.length
    || proof.denials.some((entry) => {
      const paired = sessionProof.toolResults.find((tool) => tool.callId === entry.callId);
      return !paired || !['write', 'edit'].includes(String(entry.tool).toLowerCase())
        || entry.status !== 'error' || entry.denialCode !== 'GLOBAL_READ_ONLY_CONSTRAINT'
        || !SHA256_PATTERN.test(entry.resultTextSha256 ?? '')
        || !Number.isSafeInteger(entry.callSeq) || entry.callSeq <= proof.requestSeq
        || !Number.isSafeInteger(entry.resultSeq) || entry.resultSeq <= entry.callSeq || entry.resultSeq >= proof.terminalSeq
        || ['callId', 'callSeq', 'tool', 'resultSeq', 'status'].some((key) => paired[key] !== entry[key]);
    })
    || state.currentPhaseId !== 'frontend' || state.currentPhaseIndex !== 5
    || state.taskId !== execution.taskId || state.sessionId !== execution.dshSessionId
    || state.sourceCommit !== execution.sourceCommit || state.workflowId !== execution.workflowId
    || state.catalogVersion !== execution.phaseCatalogVersion || state.catalogDigest !== execution.phaseCatalogDigest
    || attempt === null || attempt === undefined || begin?.schemaVersion !== 'forge-delivery-browser-phase-begin/v1'
    || begin.attempt?.attemptId !== attempt.attemptId || begin.workflowId !== state.workflowId
    || begin.phaseId !== 'frontend' || begin.phaseIndex !== 5 || attempt.rpcId !== execution.rpcId
    || attempt.executionGeneration !== execution.generation || attempt.promptDigest !== execution.textDigest
    || begin.attempt.rpcId !== attempt.rpcId || begin.attempt.executionGeneration !== attempt.executionGeneration
    || begin.attempt.promptDigest !== attempt.promptDigest) {
    fail('PHASE_READONLY_ROLE_EVIDENCE_INVALID', 'Readonly-role denial is not bound to this writable frontend execution.');
  }
  return proof;
}

export async function retryForgeFrontendReadonlyRolePhase({
  catalogFile, stateFile, artifactsDirectory, originalRequestFile, promptFile, attemptDirectory, repairRequestText,
}) {
  if (typeof repairRequestText !== 'string' || repairRequestText.trim().length === 0 || repairRequestText.includes('\0')
    || Buffer.byteLength(repairRequestText, 'utf8') > MAX_PROMPT_BYTES
    || path.basename(path.dirname(stateFile)) !== 'frontend-repair'
    || path.dirname(attemptDirectory) !== path.join(path.dirname(stateFile), 'browser-attempts')) {
    fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Readonly-role recovery requires the retained linked frontend and bounded feedback.');
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const phase = currentPhase(state, catalog);
    const inputs = {};
    const digests = {};
    for (const [key, name] of Object.entries({ executionSha256: 'execution.json', baselineSha256: 'session-baseline.json',
      beginSha256: 'begin.json', sessionProofSha256: '会话终态证明.json', denialProofSha256: '前端阶段-只读误拒证明.json' })) {
      const bytes = await boundedRegularFile(path.join(attemptDirectory, name), MAX_RESPONSE_BYTES, name);
      inputs[key] = JSON.parse(bytes.toString('utf8')); digests[key] = sha256(bytes);
    }
    const execution = inputs.executionSha256;
    const last = state.history.at(-1);
    const replay = state.activeAttempt === null && last?.schemaVersion === READONLY_ROLE_RECOVERY_SCHEMA
      && last.attemptId === inputs.beginSha256.attempt?.attemptId && last.executionGeneration === execution.generation;
    const attempt = replay ? inputs.beginSha256.attempt : state.activeAttempt;
    const oldPromptFile = path.join(attemptDirectory, '前端阶段-误拒前提示原文.md');
    const oldInfo = await lstat(oldPromptFile).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
    const previousBytes = await boundedRegularFile(oldInfo === null ? promptFile : oldPromptFile, MAX_PROMPT_BYTES, 'retained prompt');
    const previousPrompt = previousBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
    validateForgeFrontendReadonlyRoleEvidence({ state, execution, baseline: inputs.baselineSha256,
      begin: inputs.beginSha256, sessionProof: inputs.sessionProofSha256, proof: inputs.denialProofSha256,
      promptText: previousPrompt, attempt });
    const continuation = await readJsonFile(path.join(path.dirname(stateFile), '前端阶段-关联修复凭据.json'),
      MAX_RESPONSE_BYTES, 'frontend repair continuation');
    const accepted = await loadAcceptedArtifacts({ state, catalog, artifactsDirectory });
    if (path.basename(attemptDirectory) !== execution.executionId || state.status !== 'active'
      || continuation.schemaVersion !== 'forge-delivery-frontend-repair-continuation/v1'
      || continuation.taskId !== state.taskId || continuation.sessionId !== state.sessionId
      || continuation.sourceCommit !== state.sourceCommit || continuation.catalogDigest !== state.catalogDigest
      || continuation.inheritedStageCount !== 5 || accepted.length !== 5
      || Object.entries(continuation.inheritedArtifactDigests).some(([kind, digest]) => state.acceptedArtifacts[kind] !== digest)) {
      fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Readonly-role recovery must preserve the existing frontend and five upstream artifacts.');
    }
    const recoveryFile = path.join(attemptDirectory, '前端阶段-平台误拒恢复凭据.json');
    const prior = await lstat(recoveryFile).then(() => readJsonFile(recoveryFile, MAX_RESPONSE_BYTES, 'readonly-role recovery'),
      (error) => { if (error.code !== 'ENOENT') throw error; return null; });
    const recovered = replay ? { state, receipt: last } : recordForgeReadonlyRoleRecovery({
      state, catalog, operationId: execution.executionId, failureEvidenceDigest: digests.denialProofSha256,
      frozenStateFileDigest: sha256(await boundedRegularFile(stateFile, MAX_RESPONSE_BYTES, 'phase state')),
      ...(prior === null ? {} : { now: prior.failedAt }),
    });
    const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
    const upstreamArtifacts = requiredUpstreamArtifacts(accepted, phase);
    const prompt = buildForgeDeliveryPhasePrompt({ state: recovered.state, catalog,
      originalRequest: `${requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '')}\n\n${repairRequestText}`, upstreamArtifacts });
    const promptBytes = Buffer.from(`${prompt}\n`, 'utf8');
    if (promptBytes.length > MAX_PROMPT_BYTES) fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Retry input exceeds the existing prompt limit.');
    const receipt = { schemaVersion: READONLY_ROLE_RETRY_SCHEMA, issuer: 'forge-phase-controller',
      workflowId: state.workflowId, phaseId: phase.id, phaseIndex: phase.index, sourceCommit: state.sourceCommit,
      catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest, stateDigest: recovered.state.stateDigest,
      rejectedAttemptId: attempt.attemptId, rejectedExecutionGeneration: attempt.executionGeneration,
      recoveryReceiptDigest: recovered.receipt.receiptDigest, executionId: execution.executionId,
      previousPromptDigest: sha256(Buffer.from(previousPrompt, 'utf8')), originalRequestSha256: sha256(requestBytes),
      ...digests, feedbackSha256: sha256(Buffer.from(repairRequestText, 'utf8')),
      upstreamArtifactDigests: Object.fromEntries(upstreamArtifacts.map((artifact) => [artifact.artifactKind, artifact.artifactDigest])),
      retryPromptDigest: sha256(Buffer.from(prompt, 'utf8')),
      remainingAttempts: phase.maxAttempts - recovered.state.history.filter((entry) => entry.phaseId === phase.id
        && entry.schemaVersion === 'forge-delivery-phase-receipt/v1').length, stateAdvanced: false };
    const retain = async (file, bytes) => {
      try { await writeExclusive(file, bytes); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await boundedRegularFile(file, MAX_RESPONSE_BYTES, 'retained readonly-role input')).equals(bytes)) {
          fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Retained readonly-role recovery inputs changed.');
        }
      }
    };
    await retain(oldPromptFile, previousBytes);
    await retain(path.join(attemptDirectory, '前端阶段-平台故障续修说明.txt'), Buffer.from(repairRequestText, 'utf8'));
    await retain(recoveryFile, jsonBytes(recovered.receipt));
    await retain(forgeDeliveryPhaseRetryPromptReceiptPath(promptFile, attempt.attemptId), jsonBytes(receipt));
    await writeAtomic(promptFile, promptBytes);
    if (!replay) await writeForgeDeliveryPhaseState(stateFile, recovered.state, catalog);
    return { status: 'retry-ready', receipt };
  });
}

export async function retryForgeAccessWiringScopeDeniedPhase({
  catalogFile, stateFile, artifactsDirectory, originalRequestFile, promptFile, attemptDirectory, repairRequestText, sourceFingerprint,
}) {
  if (typeof repairRequestText !== 'string' || repairRequestText.trim().length === 0 || repairRequestText.includes('\0')
    || Buffer.byteLength(repairRequestText, 'utf8') > MAX_PROMPT_BYTES
    || path.basename(path.dirname(stateFile)) !== 'runtime-access-repair'
    || path.basename(path.dirname(path.dirname(stateFile))) !== 'access-wiring-repair'
    || path.dirname(attemptDirectory) !== path.join(path.dirname(stateFile), 'browser-attempts')) {
    fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Access-scope retry requires the existing linked runtime access phase and bounded feedback.');
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const phase = currentPhase(state, catalog);
    const files = { executionSha256: 'execution.json', baselineSha256: 'session-baseline.json',
      beginSha256: 'begin.json', sessionProofSha256: '会话终态证明.json', denialProofSha256: '权限阶段-范围误拒证明.json' };
    const inputs = {};
    const digests = {};
    for (const [key, name] of Object.entries(files)) {
      const bytes = await boundedRegularFile(path.join(attemptDirectory, name), MAX_RESPONSE_BYTES, name);
      inputs[key] = JSON.parse(bytes.toString('utf8')); digests[key] = sha256(bytes);
    }
    const execution = inputs.executionSha256;
    const last = state.history.at(-1);
    const replay = state.activeAttempt === null && last?.decision === 'rejected'
      && last.reasonCode === ACCESS_SCOPE_REASON && last.attemptId === inputs.beginSha256.attempt?.attemptId
      && last.executionGeneration === inputs.beginSha256.attempt?.executionGeneration;
    const attempt = replay ? inputs.beginSha256.attempt : state.activeAttempt;
    validateForgeAccessScopeDeniedEvidence({ state, execution, baseline: inputs.baselineSha256,
      begin: inputs.beginSha256, sessionProof: inputs.sessionProofSha256, proof: inputs.denialProofSha256, catalog, attempt });
    const continuation = await readJsonFile(path.join(path.dirname(stateFile), '权限接线阶段-运行修复凭据.json'),
      MAX_RESPONSE_BYTES, 'frontend repair continuation');
    const accepted = await loadAcceptedArtifacts({ state, catalog, artifactsDirectory });
    if (path.basename(attemptDirectory) !== execution.executionId || (!replay && state.status !== 'active')
      || continuation.schemaVersion !== 'forge-delivery-access-wiring-runtime-repair-continuation/v1'
      || continuation.taskId !== state.taskId || continuation.sessionId !== state.sessionId
      || continuation.sourceCommit !== state.sourceCommit || continuation.catalogDigest !== state.catalogDigest
      || continuation.inheritedStageCount !== 6 || accepted.length !== 6
      || sourceFingerprint !== execution.workspaceFingerprint
      || inputs.sessionProofSha256.toolResults.some(tool => /^(?:write|edit)$/iu.test(tool.tool) && tool.status !== 'error')
      || Object.entries(continuation.inheritedArtifactDigests).some(([kind, digest]) => state.acceptedArtifacts[kind] !== digest)) {
      fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Only the retained linked runtime access phase may consume its existing attempt budget.');
    }
    const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
    const oldPromptFile = path.join(attemptDirectory, '权限阶段-误拒前提示原文.md');
    const feedbackFile = path.join(attemptDirectory, '权限阶段-范围续修说明.txt');
    const previousBytes = await lstat(oldPromptFile).then(
      () => boundedRegularFile(oldPromptFile, MAX_PROMPT_BYTES, 'retained prompt'),
      (error) => { if (error.code !== 'ENOENT') throw error;
        return boundedRegularFile(promptFile, MAX_PROMPT_BYTES, 'current prompt'); });
    const previousPrompt = previousBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
    if (digestDirectUserTextContent([{ type: 'text', text: previousPrompt }]) !== attempt.promptDigest) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Scope-denied attempt prompt differs from its protected digest.');
    }
    const rejectionFile = path.join(attemptDirectory, '权限阶段-范围误拒凭据.json');
    const priorRejection = await lstat(rejectionFile).then(
      () => readJsonFile(rejectionFile, MAX_RESPONSE_BYTES, 'retained access-scope rejection'),
      (error) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (priorRejection !== null && (priorRejection.attemptId !== attempt.attemptId
      || priorRejection.executionGeneration !== attempt.executionGeneration || priorRejection.reasonCode !== ACCESS_SCOPE_REASON)) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Retained rejection belongs to another attempt.');
    }
    const rejected = replay ? { state, receipt: last } : completeForgeDeliveryPhase({
      state, catalog, decision: 'rejected', reasonCode: ACCESS_SCOPE_REASON,
      ...(priorRejection === null ? {} : { now: priorRejection.completedAt }) });
    const writeRetained = async (file, bytes) => {
      try { await writeExclusive(file, bytes); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await boundedRegularFile(file, MAX_PROMPT_BYTES, 'retained retry input')).equals(bytes)) {
          fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Retained retry input differs from this request.');
        }
      }
    };
    await writeRetained(oldPromptFile, previousBytes);
    await writeRetained(feedbackFile, Buffer.from(repairRequestText, 'utf8'));
    await writeOrVerifyReceipt(rejectionFile, rejected.receipt);
    if (rejected.state.status === 'blocked') {
      if (!replay) await writeForgeDeliveryPhaseState(stateFile, rejected.state, catalog);
      return { status: 'exhausted', receipt: rejected.receipt };
    }
    const upstreamArtifacts = requiredUpstreamArtifacts(accepted, phase);
    const originalRequest = `${requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '')}\n\n${repairRequestText}`;
    const prompt = buildForgeDeliveryPhasePrompt({ state: rejected.state, catalog, originalRequest, upstreamArtifacts });
    const promptBytes = Buffer.from(`${prompt}\n`, 'utf8');
    if (promptBytes.length > MAX_PROMPT_BYTES) fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Retry input exceeds the existing prompt limit.');
    const receipt = { schemaVersion: ACCESS_SCOPE_RETRY_SCHEMA, issuer: 'forge-phase-controller',
      workflowId: state.workflowId, phaseId: phase.id, phaseIndex: phase.index, sourceCommit: state.sourceCommit,
      catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest, stateDigest: rejected.state.stateDigest,
      rejectedAttemptId: attempt.attemptId, rejectedExecutionGeneration: attempt.executionGeneration,
      rejectionReceiptDigest: rejected.receipt.receiptDigest, reasonCode: ACCESS_SCOPE_REASON, executionId: execution.executionId,
      previousPromptDigest: sha256(Buffer.from(previousPrompt, 'utf8')), originalRequestSha256: sha256(requestBytes),
      ...digests, zeroDeltaFingerprint: sourceFingerprint, feedbackSha256: sha256(Buffer.from(repairRequestText, 'utf8')),
      upstreamArtifactDigests: Object.fromEntries(upstreamArtifacts.map((artifact) => [artifact.artifactKind, artifact.artifactDigest])),
      retryPromptDigest: sha256(Buffer.from(prompt, 'utf8')),
      remainingAttempts: phase.maxAttempts - rejected.state.history.filter((entry) => entry.phaseId === phase.id).length,
      stateAdvanced: false };
    await writeOrVerifyReceipt(forgeDeliveryPhaseRetryPromptReceiptPath(promptFile, attempt.attemptId), receipt);
    await writeAtomic(promptFile, promptBytes);
    if (!replay) await writeForgeDeliveryPhaseState(stateFile, rejected.state, catalog);
    return { status: 'retry-ready', receipt };
  });
}

export async function retryForgeFrontendUserAbortedPhase({
  catalogFile, stateFile, artifactsDirectory, originalRequestFile, promptFile, attemptDirectory, repairRequestText,
}) {
  if (typeof repairRequestText !== 'string' || repairRequestText.trim().length === 0 || repairRequestText.includes('\0')
    || Buffer.byteLength(repairRequestText, 'utf8') > MAX_PROMPT_BYTES
    || path.basename(path.dirname(stateFile)) !== 'frontend-repair'
    || path.dirname(attemptDirectory) !== path.join(path.dirname(stateFile), 'browser-attempts')) {
    fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'User-abort retry requires the existing linked frontend and bounded feedback.');
  }
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const phase = currentPhase(state, catalog);
    const files = { executionSha256: 'execution.json', baselineSha256: 'session-baseline.json',
      beginSha256: 'begin.json', interruptionProofSha256: '会话中止证明.json' };
    const inputs = {};
    const digests = {};
    for (const [key, name] of Object.entries(files)) {
      const bytes = await boundedRegularFile(path.join(attemptDirectory, name), MAX_RESPONSE_BYTES, name);
      inputs[key] = JSON.parse(bytes.toString('utf8')); digests[key] = sha256(bytes);
    }
    const execution = inputs.executionSha256;
    const last = state.history.at(-1);
    const replay = state.activeAttempt === null && last?.decision === 'rejected'
      && last.reasonCode === USER_ABORT_REASON && last.attemptId === inputs.beginSha256.attempt?.attemptId
      && last.executionGeneration === inputs.beginSha256.attempt?.executionGeneration;
    const attempt = replay ? inputs.beginSha256.attempt : state.activeAttempt;
    validateForgeFrontendUserAbortedEvidence({ state, execution, baseline: inputs.baselineSha256,
      begin: inputs.beginSha256, proof: inputs.interruptionProofSha256, attempt });
    const continuation = await readJsonFile(path.join(path.dirname(stateFile), '前端阶段-关联修复凭据.json'),
      MAX_RESPONSE_BYTES, 'frontend repair continuation');
    const accepted = await loadAcceptedArtifacts({ state, catalog, artifactsDirectory });
    if (path.basename(attemptDirectory) !== execution.executionId || (!replay && state.status !== 'active')
      || continuation.schemaVersion !== 'forge-delivery-frontend-repair-continuation/v1'
      || continuation.taskId !== state.taskId || continuation.sessionId !== state.sessionId
      || continuation.sourceCommit !== state.sourceCommit || continuation.catalogDigest !== state.catalogDigest
      || continuation.inheritedStageCount !== 5 || accepted.length !== 5
      || Object.entries(continuation.inheritedArtifactDigests).some(([kind, digest]) => state.acceptedArtifacts[kind] !== digest)) {
      fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Only the retained linked frontend may consume its existing attempt budget.');
    }
    const requestBytes = await boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request');
    const oldPromptFile = path.join(attemptDirectory, '前端阶段-中止前提示原文.md');
    const feedbackFile = path.join(attemptDirectory, '前端阶段-重试补充说明.txt');
    const previousBytes = await lstat(oldPromptFile).then(
      () => boundedRegularFile(oldPromptFile, MAX_PROMPT_BYTES, 'retained prompt'),
      (error) => { if (error.code !== 'ENOENT') throw error;
        return boundedRegularFile(promptFile, MAX_PROMPT_BYTES, 'current prompt'); });
    const previousPrompt = previousBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
    if (digestDirectUserTextContent([{ type: 'text', text: previousPrompt }]) !== attempt.promptDigest) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Interrupted attempt prompt differs from its protected digest.');
    }
    const rejectionFile = path.join(attemptDirectory, '前端阶段-用户中止拒绝凭据.json');
    const priorRejection = await lstat(rejectionFile).then(
      () => readJsonFile(rejectionFile, MAX_RESPONSE_BYTES, 'retained user-abort rejection'),
      (error) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (priorRejection !== null && (priorRejection.attemptId !== attempt.attemptId
      || priorRejection.executionGeneration !== attempt.executionGeneration || priorRejection.reasonCode !== USER_ABORT_REASON)) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Retained rejection belongs to another attempt.');
    }
    const rejected = replay ? { state, receipt: last } : completeForgeDeliveryPhase({
      state, catalog, decision: 'rejected', reasonCode: USER_ABORT_REASON,
      ...(priorRejection === null ? {} : { now: priorRejection.completedAt }) });
    const writeRetained = async (file, bytes) => {
      try { await writeExclusive(file, bytes); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await boundedRegularFile(file, MAX_PROMPT_BYTES, 'retained retry input')).equals(bytes)) {
          fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Retained retry input differs from this request.');
        }
      }
    };
    await writeRetained(oldPromptFile, previousBytes);
    await writeRetained(feedbackFile, Buffer.from(repairRequestText, 'utf8'));
    await writeOrVerifyReceipt(rejectionFile, rejected.receipt);
    if (rejected.state.status === 'blocked') {
      if (!replay) await writeForgeDeliveryPhaseState(stateFile, rejected.state, catalog);
      return { status: 'exhausted', receipt: rejected.receipt };
    }
    const upstreamArtifacts = requiredUpstreamArtifacts(accepted, phase);
    const originalRequest = `${requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '')}\n\n${repairRequestText}`;
    const prompt = buildForgeDeliveryPhasePrompt({ state: rejected.state, catalog, originalRequest, upstreamArtifacts });
    const promptBytes = Buffer.from(`${prompt}\n`, 'utf8');
    if (promptBytes.length > MAX_PROMPT_BYTES) fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Retry input exceeds the existing prompt limit.');
    const receipt = { schemaVersion: USER_ABORT_RETRY_SCHEMA, issuer: 'forge-phase-controller',
      workflowId: state.workflowId, phaseId: phase.id, phaseIndex: phase.index, sourceCommit: state.sourceCommit,
      catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest, stateDigest: rejected.state.stateDigest,
      rejectedAttemptId: attempt.attemptId, rejectedExecutionGeneration: attempt.executionGeneration,
      rejectionReceiptDigest: rejected.receipt.receiptDigest, reasonCode: USER_ABORT_REASON, executionId: execution.executionId,
      previousPromptDigest: sha256(Buffer.from(previousPrompt, 'utf8')), originalRequestSha256: sha256(requestBytes),
      ...digests, feedbackSha256: sha256(Buffer.from(repairRequestText, 'utf8')),
      upstreamArtifactDigests: Object.fromEntries(upstreamArtifacts.map((artifact) => [artifact.artifactKind, artifact.artifactDigest])),
      retryPromptDigest: sha256(Buffer.from(prompt, 'utf8')),
      remainingAttempts: phase.maxAttempts - rejected.state.history.filter((entry) => entry.phaseId === phase.id).length,
      stateAdvanced: false };
    await writeOrVerifyReceipt(forgeDeliveryPhaseRetryPromptReceiptPath(promptFile, attempt.attemptId), receipt);
    await writeAtomic(promptFile, promptBytes);
    if (!replay) await writeForgeDeliveryPhaseState(stateFile, rejected.state, catalog);
    return { status: 'retry-ready', receipt };
  });
}

export async function createForgeDeliveryPhaseFormatRetryPrompt({
  catalogFile,
  stateFile,
  artifactsDirectory,
  originalRequestFile,
  responseFile,
  allChangedPathsFile,
  phaseChangedPathsFile,
  phasePatchFile,
  cumulativePatchFile,
  promptFile,
  rejectionReceiptFile,
  repairRequestText,
}) {
  if (repairRequestText !== undefined && (typeof repairRequestText !== 'string'
    || repairRequestText.trim().length === 0 || repairRequestText.includes('\0')
    || Buffer.byteLength(repairRequestText, 'utf8') > MAX_PROMPT_BYTES)) {
    fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Format retry requires bounded user feedback.');
  }
  const [{ catalog }, requestBytes, responseBytes, allChangedPathsBytes, phaseChangedPathsBytes,
    phasePatchBytes, cumulativePatchBytes, previousPromptBytes] = await Promise.all([
    loadForgeDeliveryPhaseCatalog(catalogFile),
    boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request'),
    boundedRegularFile(responseFile, MAX_RESPONSE_BYTES, 'format-invalid model response'),
    boundedRegularFile(allChangedPathsFile, MAX_RESPONSE_BYTES, 'observed changed paths'),
    boundedRegularFile(phaseChangedPathsFile, MAX_RESPONSE_BYTES, 'phase changed paths'),
    boundedRegularFile(phasePatchFile, MAX_PATCH_BYTES, 'phase patch', { allowEmpty: true }),
    boundedRegularFile(cumulativePatchFile, MAX_PATCH_BYTES, 'cumulative patch', { allowEmpty: true }),
    boundedRegularFile(promptFile, MAX_PROMPT_BYTES, 'current phase prompt'),
  ]);
  let allChangedPathsValue;
  let phaseChangedPathsValue;
  try {
    allChangedPathsValue = JSON.parse(allChangedPathsBytes.toString('utf8'));
    phaseChangedPathsValue = JSON.parse(phaseChangedPathsBytes.toString('utf8'));
  } catch {
    fail('PHASE_CONTROLLER_INPUT_INVALID', 'Format retry observations are not valid JSON.');
  }
  const allChangedPaths = normalizedChangedPaths(allChangedPathsValue);
  const phaseChangedPaths = normalizedChangedPaths(phaseChangedPathsValue);
  const originalRequest = requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  const response = responseBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  const previousPrompt = previousPromptBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const phase = currentPhase(state, catalog);
    const attempt = state.activeAttempt;
    const priorAttempts = state.history.filter((entry) => (
      entry.schemaVersion === 'forge-delivery-phase-receipt/v1' && entry.phaseId === phase.id
    )).length;
    if (state.status !== 'active' || attempt === null || priorAttempts !== 0 || phase.maxAttempts < 2) {
      fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Only a first active phase attempt with remaining budget can format-retry.');
    }
    const acceptedArtifacts = await loadAcceptedArtifacts({ state, catalog, artifactsDirectory });
    const currentChangedPaths = observePhasePaths({
      allChangedPaths, phaseChangedPaths, acceptedArtifacts, phase,
    });
    if (currentChangedPaths.some((candidate) => !phase.ownedPaths.some((owner) => (
      candidate === owner || candidate.startsWith(`${owner}/`)
    )))) {
      fail('PHASE_PATH_DENIED', 'Format retry cannot include a path outside the current phase owner.');
    }
    if ((phase.patchScope === 'none' && phasePatchBytes.length !== 0)
      || (phase.patchScope === 'phase' && phasePatchBytes.length === 0)) {
      fail('PHASE_CONTROLLER_MUTATION_DENIED', 'Format retry phase patch does not match phase mutation authority.');
    }
    assertPhaseFileClosure(phase, currentChangedPaths);
    let shapeIssue;
    let phaseProposal;
    try {
      await evaluatePhaseCandidate({
        state, stateFile, catalog, artifactsDirectory, response, allChangedPaths, phaseChangedPaths,
        phasePatchBytes, cumulativePatchBytes,
      });
    } catch (error) {
      if (error?.code === 'PHASE_RESPONSE_INVALID'
        && ['unexpected-payload-keys', 'invalid-proposal-json', 'missing-proposal-block'].includes(error.payloadShapeIssue?.kind)) {
        shapeIssue = error.payloadShapeIssue;
        phaseProposal = error.phaseProposal;
      } else {
        throw error;
      }
    }
    const invalidJson = shapeIssue?.kind === 'invalid-proposal-json';
    const missingBlock = shapeIssue?.kind === 'missing-proposal-block';
    const untrustedProposal = invalidJson || missingBlock;
    if (!untrustedProposal && (shapeIssue === undefined
      || JSON.stringify(shapeIssue.requiredPayloadKeys) !== JSON.stringify(phase.requiredPayloadKeys)
      || !Array.isArray(shapeIssue.unexpectedKeys) || shapeIssue.unexpectedKeys.length < 1
      || shapeIssue.unexpectedKeys.length > 16
      || shapeIssue.unexpectedKeys.some((key) => typeof key !== 'string'
        || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) || phase.requiredPayloadKeys.includes(key))
      || new Set(shapeIssue.unexpectedKeys).size !== shapeIssue.unexpectedKeys.length)) {
      fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Response is not an eligible extra-key format failure.');
    }
    // An absent or syntax-invalid artifact supplies no trusted proposal fields. The replacement
    // must pass the normal proposal checks before any candidate or Host work exists.
    if (!untrustedProposal && (!phaseProposal || !Array.isArray(phaseProposal.unresolvedDecisions))) {
      fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Format retry requires the original unresolved decision structure.');
    }
    if (!untrustedProposal && phase.sourceMutation && (!Array.isArray(phaseProposal.payload?.changedPaths)
      || JSON.stringify([...phaseProposal.payload.changedPaths].sort()) !== JSON.stringify(currentChangedPaths))) {
      fail('PHASE_CONTROLLER_RETRY_NOT_ALLOWED', 'Model-declared changedPaths differ from the observed phase paths.');
    }
    const reasonCode = missingBlock ? MISSING_FORMAT_REJECTION_REASON : invalidJson ? JSON_FORMAT_REJECTION_REASON : FORMAT_REJECTION_REASON;
    const unexpectedKeys = untrustedProposal ? [] : shapeIssue.unexpectedKeys;
    const rejected = completeForgeDeliveryPhase({
      state, catalog, decision: 'rejected', reasonCode,
    });
    const upstreamArtifacts = requiredUpstreamArtifacts(acceptedArtifacts, phase);
    const basePrompt = buildForgeDeliveryPhasePrompt({
      state: rejected.state, catalog, originalRequest, upstreamArtifacts,
    });
    if (previousPrompt !== basePrompt
      || attempt.promptDigest !== digestDirectUserTextContent([{ type: 'text', text: basePrompt }])) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Current prompt changed after the format-invalid attempt.');
    }
    const receiptFile = forgeDeliveryPhaseRetryPromptReceiptPath(promptFile, attempt.attemptId);
    if (await lstat(receiptFile).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) {
      fail('PHASE_CONTROLLER_RETRY_OUTPUT_EXISTS', 'Format retry receipt path must be unused.');
    }
    const feedback = {
      rejectedAttemptId: attempt.attemptId,
      rejectedExecutionGeneration: attempt.executionGeneration,
      rejectionReceiptDigest: rejected.receipt.receiptDigest,
      reasonCode,
      responseSha256: sha256(responseBytes),
      unexpectedKeys,
      requiredPayloadKeys: phase.requiredPayloadKeys,
      ...(!untrustedProposal && phaseProposal.unresolvedDecisions.length > 0
        ? { previousUnresolvedDecisions: phaseProposal.unresolvedDecisions } : {}),
      ...(repairRequestText === undefined ? {} : { userRepairRequest: repairRequestText }),
    };
    const prompt = [basePrompt, '', 'REJECTED FORMAT FEEDBACK (machine-owned, evidence-bound):',
      JSON.stringify(feedback, null, 2), '',
      'The previous response was rejected during preflight; it is not an accepted artifact.',
      ...(invalidJson ? [
        'The artifact block could not be parsed as JSON. Regenerate the current phase contract from the original request, current phase authority and accepted upstream artifacts above. Escape double quotes, backslashes and control characters inside JSON strings. No field or business decision from the malformed artifact has been accepted.',
      ] : []),
      ...(missingBlock ? [
        'The response contained no phase artifact block. Regenerate the current phase contract from the original request, current phase authority and accepted upstream artifacts above. No field or business decision from the missing artifact has been accepted.',
      ] : []),
      'Return the complete phase response: a concise business-facing explanation followed by exactly one complete replacement artifact. Its payload must contain exactly requiredPayloadKeys and no extra keys.',
      'Preserve valid business content and current phase source edits. Do not claim Host verification or proceed to a later phase.',
    ].join('\n');
    const promptBytes = Buffer.from(`${prompt}\n`, 'utf8');
    if (promptBytes.length > MAX_PROMPT_BYTES) {
      fail('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', 'Format retry prompt exceeds the protected prompt limit.');
    }
    const receipt = Object.freeze({
      schemaVersion: FORMAT_RETRY_PROMPT_RECEIPT_SCHEMA,
      issuer: 'forge-phase-controller',
      workflowId: state.workflowId,
      phaseId: phase.id,
      phaseIndex: phase.index,
      sourceCommit: state.sourceCommit,
      catalogVersion: state.catalogVersion,
      catalogDigest: state.catalogDigest,
      stateDigest: rejected.state.stateDigest,
      rejectedAttemptId: attempt.attemptId,
      rejectedExecutionGeneration: attempt.executionGeneration,
      rejectionReceiptDigest: rejected.receipt.receiptDigest,
      reasonCode,
      previousPromptDigest: sha256(Buffer.from(previousPrompt, 'utf8')),
      originalRequestSha256: sha256(requestBytes),
      responseSha256: sha256(responseBytes),
      unexpectedKeys,
      requiredPayloadKeys: phase.requiredPayloadKeys,
      allChangedPathsSha256: sha256(allChangedPathsBytes),
      phaseChangedPathsSha256: sha256(phaseChangedPathsBytes),
      phasePatchSha256: sha256(phasePatchBytes),
      cumulativePatchSha256: sha256(cumulativePatchBytes),
      upstreamArtifactDigests: Object.fromEntries(upstreamArtifacts.map((artifact) => [
        artifact.artifactKind, artifact.artifactDigest,
      ])),
      retryPromptDigest: sha256(Buffer.from(prompt, 'utf8')),
      remainingAttempts: phase.maxAttempts - 1,
      stateAdvanced: false,
    });
    await writeForgeDeliveryPhaseState(stateFile, rejected.state, catalog);
    await writeExclusive(rejectionReceiptFile, jsonBytes(rejected.receipt));
    await writeAtomic(promptFile, promptBytes);
    await writeExclusive(receiptFile, jsonBytes(receipt));
    return receipt;
  });
}

export async function recoverForgeDatabaseStaleWriteRun({
  catalogFile,
  stateFile,
  technicalFailureEvidenceFile,
  expectedTechnicalFailureEvidenceSha256,
  writerRecoveryTraceFile,
  expectedWriterRecoveryTraceSha256,
  operationId,
  receiptFile,
  now = new Date().toISOString(),
}) {
  requiredId(operationId, UUID_PATTERN, 'operationId');
  const [{ catalog }, evidenceInput, traceInput] = await Promise.all([
    loadForgeDeliveryPhaseCatalog(catalogFile),
    readPinnedJson(
      technicalFailureEvidenceFile,
      expectedTechnicalFailureEvidenceSha256,
      'technical failure evidence',
    ),
    readPinnedJson(
      writerRecoveryTraceFile,
      expectedWriterRecoveryTraceSha256,
      'writer recovery trace',
    ),
  ]);
  const evidence = evidenceInput.value;
  const trace = traceInput.value;
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const stateBytes = await boundedRegularFile(stateFile, MAX_RESPONSE_BYTES, 'phase state');
    let state;
    try {
      state = validateForgeDeliveryPhaseState(JSON.parse(stateBytes.toString('utf8')), catalog);
    } catch (error) {
      if (error?.code) throw error;
      fail('PHASE_CONTROLLER_STATE_INVALID', 'Phase state is not valid JSON.');
    }
    const phase = currentPhase(state, catalog);
    const existing = state.history.find((entry) => (
      entry.schemaVersion === STALE_WRITE_RECOVERY_SCHEMA && entry.operationId === operationId
    ));
    if (state.status !== 'active' || state.currentPhaseId !== 'database'
      || (existing === undefined && state.activeAttempt === null)
      || (existing !== undefined && state.activeAttempt !== null)) {
      fail('PHASE_CONTROLLER_STALE_WRITE_RECOVERY_DENIED', 'Only the exact frozen active database attempt can be recovered.');
    }
    const attempt = existing === undefined ? state.activeAttempt : {
      attemptId: existing.attemptId,
      executionGeneration: existing.executionGeneration,
      rpcId: existing.rpcId,
      promptDigest: existing.promptDigest,
    };
    const frozenStateFileDigest = existing?.frozenStateFileDigest ?? sha256(stateBytes);
    validatePinnedStaleWriteEvidence(evidence, {
      state,
      attempt,
      traceDigest: expectedWriterRecoveryTraceSha256,
      stateFileDigest: frozenStateFileDigest,
    });
    validatePinnedStaleWriteTrace(trace, state, attempt, phase);
    const bindings = {
      frozenStateFileDigest,
      failureEvidenceDigest: expectedTechnicalFailureEvidenceSha256,
      writerRecoveryTraceDigest: expectedWriterRecoveryTraceSha256,
    };
    if (existing !== undefined) {
      if (Object.entries(bindings).some(([key, value]) => existing[key] !== value)) {
        fail('PHASE_CONTROLLER_STALE_WRITE_REPLAY_MISMATCH', 'Recovery evidence changed across an idempotent replay.');
      }
      await writeOrVerifyReceipt(receiptFile, existing);
      return Object.freeze(existing);
    }
    const priorReceipt = await lstat(receiptFile).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (priorReceipt !== null) {
      fail('PHASE_CONTROLLER_STALE_WRITE_REPLAY_MISMATCH', 'A new recovery requires an unused receipt path.');
    }
    const recovered = recordForgeStaleWriteRecovery({
      state,
      catalog,
      operationId,
      ...bindings,
      now,
    });
    await writeForgeDeliveryPhaseState(stateFile, recovered.state, catalog);
    await writeExclusive(receiptFile, jsonBytes(recovered.receipt));
    return Object.freeze(recovered.receipt);
  });
}

export async function finalizeForgeDeliveryPhaseRun({
  catalogFile,
  stateFile,
  artifactsDirectory,
  originalRequestFile,
  responseFile,
  allChangedPathsFile,
  phaseChangedPathsFile,
  phasePatchFile,
  cumulativePatchFile,
  hostReceiptsFile,
  outputDirectory,
  nextPromptFile,
  expectedAttemptId,
}) {
  const [{ catalog }, requestBytes, responseBytes, allChangedPathsValue, phaseChangedPathsValue, hostReceipts,
    phasePatchBytes, cumulativePatchBytes] = await Promise.all([
    loadForgeDeliveryPhaseCatalog(catalogFile),
    boundedRegularFile(originalRequestFile, MAX_PROMPT_BYTES, 'original request'),
    boundedRegularFile(responseFile, MAX_RESPONSE_BYTES, 'model response'),
    readJsonFile(allChangedPathsFile, MAX_RESPONSE_BYTES, 'observed changed paths'),
    readJsonFile(phaseChangedPathsFile, MAX_RESPONSE_BYTES, 'phase changed paths'),
    readJsonFile(hostReceiptsFile, MAX_RESPONSE_BYTES, 'host receipts', { allowEmpty: false }),
    boundedRegularFile(phasePatchFile, MAX_PATCH_BYTES, 'phase patch', { allowEmpty: true }),
    boundedRegularFile(cumulativePatchFile, MAX_PATCH_BYTES, 'cumulative patch', { allowEmpty: true }),
  ]);
  const originalRequest = requestBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  const response = responseBytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  const allChangedPaths = normalizedChangedPaths(allChangedPathsValue);
  const phaseChangedPaths = normalizedChangedPaths(phaseChangedPathsValue);
  return withForgeDeliveryPhaseStateLock(stateFile, async () => {
    const state = await readForgeDeliveryPhaseState(stateFile, catalog);
    if (expectedAttemptId !== undefined && state.activeAttempt?.attemptId !== expectedAttemptId) {
      fail('PHASE_CONTROLLER_ATTEMPT_CHANGED', 'The captured conversation no longer belongs to the active phase attempt.');
    }
    const candidate = await evaluatePhaseCandidate({
      state,
      stateFile,
      catalog,
      artifactsDirectory,
      response,
      allChangedPaths,
      phaseChangedPaths,
      phasePatchBytes,
      cumulativePatchBytes,
    });
    const { phase, acceptedArtifacts, proposal, artifact, patchDigest, cumulativePatchDigest, runtimeEvidence } = candidate;
    let runtimeEvidenceReference = null;
    if (runtimeEvidence !== null) {
      const runtimeBytes = jsonBytes(runtimeEvidence);
      runtimeEvidenceReference = { path: '../runtime-evidence.json', sha256: sha256(runtimeBytes),
        manifestSha256: runtimeEvidence.manifestSha256, sourceCommit: runtimeEvidence.runtimeSource.commit };
    }
    const humanResponse = extractForgeDeliveryPhaseHumanResponse({ text: response });
    if (artifact.unresolvedDecisions.length > 0) {
      const blocked = completeForgeDeliveryPhase({
        state,
        catalog,
        decision: 'blocked',
        reasonCode: 'BUSINESS_DECISION_REQUIRED',
      });
      if (runtimeEvidence !== null) {
        await writeExclusive(path.join(outputDirectory, 'runtime-evidence.json'), jsonBytes(runtimeEvidence));
      }
      await writeForgePhaseWorkPackage({
        directory: path.join(outputDirectory, 'work-package'),
        state,
        phase,
        proposal,
        artifact: null,
        receipt: blocked.receipt,
        hostReceipts: [],
        requestDigest: sha256(Buffer.from(originalRequest, 'utf8')),
        catalogVersion: catalog.catalogVersion,
        phaseCount: catalog.workflows.find((entry) => entry.id === state.workflowId).phases.length,
        workflowStatus: blocked.state.status,
        nextPhaseId: null,
        humanResponse,
        runtimeEvidenceReference,
      });
      await writeForgeDeliveryPhaseState(stateFile, blocked.state, catalog);
      await writeExclusive(path.join(outputDirectory, 'proposal.json'), jsonBytes(proposal));
      await writeExclusive(path.join(outputDirectory, 'phase-receipt.json'), jsonBytes(blocked.receipt));
      fail('PHASE_CONTROLLER_BUSINESS_DECISION_REQUIRED', 'Unresolved business decisions blocked the workflow.');
    }
    const completed = completeForgeDeliveryPhase({
      state,
      catalog,
      decision: 'accepted',
      artifact,
      hostReceipts,
      hostVerificationReuse: Array.isArray(hostReceipts) && hostReceipts.length === 0 ? candidate.hostVerificationReuse : null,
    });
    if (runtimeEvidence !== null) {
      await writeExclusive(path.join(outputDirectory, 'runtime-evidence.json'), jsonBytes(runtimeEvidence));
    }
    const workPackage = await writeForgePhaseWorkPackage({
      directory: path.join(outputDirectory, 'work-package'),
      state,
      phase,
      proposal,
      artifact,
      receipt: completed.receipt,
      hostReceipts,
      requestDigest: sha256(Buffer.from(originalRequest, 'utf8')),
      catalogVersion: catalog.catalogVersion,
      phaseCount: catalog.workflows.find((entry) => entry.id === state.workflowId).phases.length,
      workflowStatus: completed.state.status,
      nextPhaseId: completed.state.status === 'active' ? completed.state.currentPhaseId : null,
      humanResponse,
      runtimeEvidenceReference,
    });
    const acceptedCorrection = currentForgeAccessAcceptedCorrection(state) !== null;
    await writeExclusive(path.join(artifactsDirectory, acceptedCorrection
      ? `${artifact.artifactKind}-${artifact.artifactDigest}.json` : `${artifact.artifactKind}.json`), jsonBytes(artifact));
    await writeExclusive(path.join(outputDirectory, 'proposal.json'), jsonBytes(proposal));
    await writeExclusive(path.join(outputDirectory, 'phase-artifact.json'), jsonBytes(artifact));
    await writeExclusive(path.join(outputDirectory, 'phase-receipt.json'), jsonBytes(completed.receipt));
    await writeForgeDeliveryPhaseState(stateFile, completed.state, catalog);
    let nextPromptDigest = null;
    let nextPromptPendingReason = null;
    if (completed.state.status === 'active') {
      const nextPhase = currentPhase(completed.state, catalog);
      const allAcceptedArtifacts = [...acceptedArtifacts, artifact];
      if (nextPhase.id === 'cross-layer-acceptance') {
        nextPromptPendingReason = 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED';
        await writeAtomic(nextPromptFile, Buffer.from('Controller is awaiting source-bound deployment, API, browser and database evidence. No executable cross-layer prompt has been prepared.\n', 'utf8'));
      } else {
        const prompt = buildForgeDeliveryPhasePrompt({
          state: completed.state, catalog, originalRequest,
          upstreamArtifacts: requiredUpstreamArtifacts(allAcceptedArtifacts, nextPhase),
        });
        await writeAtomic(nextPromptFile, Buffer.from(`${prompt}\n`, 'utf8'));
        nextPromptDigest = sha256(Buffer.from(prompt, 'utf8'));
      }
    }
    const result = {
      schemaVersion: 'forge-delivery-phase-controller-finalize/v1',
      workflowId: completed.state.workflowId,
      acceptedPhaseId: phase.id,
      acceptedPhaseIndex: phase.index,
      phaseArtifactDigest: artifact.artifactDigest,
      phasePatchDigest: patchDigest,
      cumulativePatchDigest,
      stateDigest: completed.state.stateDigest,
      workflowStatus: completed.state.status,
      nextPhaseId: completed.state.status === 'active' ? completed.state.currentPhaseId : null,
      nextPromptDigest,
      ...(nextPromptPendingReason === null ? {} : { nextPromptPendingReason }),
      workPackageDigest: workPackage.manifest.packageDigest,
      workPackageManifest: 'work-package/manifest.json',
    };
    await writeExclusive(path.join(outputDirectory, 'controller-result.json'), jsonBytes(result));
    return Object.freeze(result);
  });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail('PHASE_CONTROLLER_ARGUMENT_INVALID', 'Arguments must be --name value pairs.');
    const name = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (Object.hasOwn(values, name)) fail('PHASE_CONTROLLER_ARGUMENT_INVALID', `Duplicate argument ${key}.`);
    values[name] = value;
  }
  return values;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.command === 'issue-production-task-grant') {
    exactKeys(options, [
      'command', 'specFile', 'grantFile', 'receiptFile',
    ], 'issue production task grant arguments');
    const issued = await issueProductionTaskGrant(options);
    return issued.receipt;
  }
  if (options.command === 'initialize') {
    exactKeys(options, [
      'command', 'catalogFile', 'workflowId', 'caseFamily', 'taskId', 'sessionId', 'sourceCommit',
      'originalRequestFile', 'stateFile', 'artifactsDirectory', 'promptFile', 'receiptFile',
    ], 'initialize arguments');
    const receipt = await initializeForgeDeliveryPhaseRun(options);
    await writeExclusive(options.receiptFile, jsonBytes(receipt));
    return receipt;
  }
  if (options.command === 'prepare-database-continuation') {
    exactKeys(options, [
      'command', 'catalogFile', 'sourceStateFile', 'expectedSourceStateSha256',
      'sourceArtifactsDirectory', 'sourceCommit', 'originalRequestFile', 'outputDirectory',
    ], 'prepare database continuation arguments');
    return prepareForgeDatabaseContinuation(options);
  }
  if (options.command === 'prepare-backend-finalized-continuation') {
    exactKeys(options, [
      'command', 'catalogFile', 'sourceCaseDirectory', 'bindingsFile', 'expectedBindingsSha256',
      'sourceCommit', 'originalRequestFile', 'outputDirectory',
    ], 'prepare backend finalized continuation arguments');
    return prepareForgeBackendFinalizedContinuation(options);
  }
  if (options.command === 'prepare-access-wiring-continuation') {
    exactKeys(options, [
      'command', 'catalogFile', 'sourceCaseDirectory', 'bindingsFile', 'expectedBindingsSha256',
      'sourceCommit', 'originalRequestFile', 'outputDirectory',
    ], 'prepare access wiring continuation arguments');
    return prepareForgeAccessWiringContinuation(options);
  }
  if (options.command === 'prepare-cross-layer-continuation') {
    exactKeys(options, [
      'command', 'catalogFile', 'sourceCaseDirectory', 'bindingsFile', 'expectedBindingsSha256',
      'sourceCommit', 'originalRequestFile', 'outputDirectory',
    ], 'prepare cross layer continuation arguments');
    return prepareForgeCrossLayerContinuation(options);
  }
  if (options.command === 'prepare-cross-layer-runtime-prompt') {
    exactKeys(options, ['command', 'catalogFile', 'stateFile', 'artifactsDirectory',
      'originalRequestFile', 'runtimeEvidenceDirectory', 'expectedRuntimeManifestSha256',
      'sourceRepository', 'promptFile'], 'prepare cross layer runtime prompt arguments');
    return prepareForgeCrossLayerRuntimePrompt(options);
  }
  if (options.command === 'prepare-frontend-retry-continuation') {
    exactKeys(options, [
      'command', 'catalogFile', 'sourceCaseDirectory', 'bindingsFile', 'expectedBindingsSha256',
      'sourceCommit', 'originalRequestFile', 'outputDirectory',
    ], 'prepare frontend retry continuation arguments');
    return prepareForgeFrontendRetryContinuation(options);
  }
  if (options.command === 'finalize') {
    exactKeys(options, [
      'command', 'catalogFile', 'stateFile', 'artifactsDirectory', 'originalRequestFile',
      'responseFile', 'allChangedPathsFile', 'phaseChangedPathsFile', 'phasePatchFile', 'cumulativePatchFile',
      'hostReceiptsFile', 'outputDirectory', 'nextPromptFile', 'receiptFile',
    ], 'finalize arguments');
    const receipt = await finalizeForgeDeliveryPhaseRun(options);
    await writeExclusive(options.receiptFile, jsonBytes(receipt));
    return receipt;
  }
  if (options.command === 'preflight') {
    exactKeys(options, [
      'command', 'catalogFile', 'stateFile', 'artifactsDirectory', 'responseFile',
      'allChangedPathsFile', 'phaseChangedPathsFile', 'phasePatchFile', 'cumulativePatchFile', 'receiptFile',
    ], 'preflight arguments');
    return preflightForgeDeliveryPhaseRun(options);
  }
  if (options.command === 'reject') {
    exactKeys(options, [
      'command', 'catalogFile', 'stateFile', 'reasonCode', 'receiptFile',
    ], 'reject arguments');
    return rejectForgeDeliveryPhaseRun(options);
  }
  if (options.command === 'inspect-semantic-review') {
    exactKeys(options, [
      'command', 'catalogFile', 'stateFile', 'responseFile',
      'preflightReceiptFile', 'semanticReviewFile',
    ], 'inspect semantic review arguments');
    return inspectForgeDeliveryPhaseSemanticReview(options);
  }
  if (options.command === 'retry-prompt') {
    exactKeys(options, [
      'command', 'catalogFile', 'stateFile', 'artifactsDirectory', 'originalRequestFile',
      'responseFile', 'preflightReceiptFile', 'semanticReviewFile', 'promptFile', 'receiptFile',
    ], 'retry prompt arguments');
    return createForgeDeliveryPhaseRetryPrompt(options);
  }
  if (options.command === 'format-retry-prompt') {
    exactKeys(options, [
      'command', 'catalogFile', 'stateFile', 'artifactsDirectory', 'originalRequestFile',
      'responseFile', 'allChangedPathsFile', 'phaseChangedPathsFile', 'phasePatchFile',
      'cumulativePatchFile', 'promptFile', 'rejectionReceiptFile',
    ], 'format retry prompt arguments');
    return createForgeDeliveryPhaseFormatRetryPrompt(options);
  }
  if (options.command === 'recover-database-stale-write') {
    exactKeys(options, [
      'command', 'catalogFile', 'stateFile', 'technicalFailureEvidenceFile',
      'expectedTechnicalFailureEvidenceSha256', 'writerRecoveryTraceFile',
      'expectedWriterRecoveryTraceSha256', 'operationId', 'receiptFile',
    ], 'recover database stale-write arguments');
    return recoverForgeDatabaseStaleWriteRun(options);
  }
  fail(
    'PHASE_CONTROLLER_ARGUMENT_INVALID',
    'Command must be issue-production-task-grant, initialize, prepare-database-continuation, prepare-backend-finalized-continuation, prepare-access-wiring-continuation, prepare-cross-layer-continuation, prepare-frontend-retry-continuation, preflight, inspect-semantic-review, finalize, reject, retry-prompt, format-retry-prompt, or recover-database-stale-write.',
  );
}

function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return path.resolve(realpathSync(path.resolve(process.argv[1]))) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main(process.argv.slice(2))
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`forge phase controller: ${error.code ?? 'ERROR'}: ${error.message}\n`);
      process.exitCode = 1;
    });
}
