import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_CLAIMABLE_PROMPT_BYTES,
  PROTECTED_EXECUTION_RECOVERY_MODE,
  classifyPinnedDshPromptBody,
  issueProtectedExecutionRecoveryPermit,
  prepareProtectedExecutionContext,
} from './forge-execution-context.mjs';
import {
  beginForgeDeliveryPhase,
  createForgeDeliveryPhaseState,
  loadForgeDeliveryPhaseCatalog,
  readForgeDeliveryPhaseState,
  resolveForgeDeliveryPhase,
  validateForgeDeliveryPhaseArtifact,
  withForgeDeliveryPhaseStateLock,
  writeForgeDeliveryPhaseState,
} from './forge-delivery-phase-runtime.mjs';
import {
  forgeDeliveryPhaseRetryPromptReceiptPath,
  readPreparedForgeCrossLayerRuntimeEvidence,
  validateForgeDeliveryPhaseRetryPromptReceipt,
} from './forge-delivery-phase-controller.mjs';
import { validateTaskspaceMetadata } from './taskspace-policy.mjs';

function requiredEnvironment(environment, name, pattern) {
  const value = environment[name];
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function optionalEnvironment(environment, name, pattern) {
  const value = environment[name];
  if (value === undefined || value === '') return undefined;
  if (!pattern.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function requiredPositiveIntegerEnvironment(environment, name) {
  const value = requiredEnvironment(environment, name, /^[1-9][0-9]{0,8}$/u);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is invalid.`);
  return parsed;
}

async function regularBoundedFile(file, maxBytes, label) {
  if (!path.isAbsolute(file)) throw new Error(`${label} path must be absolute.`);
  const information = await lstat(file);
  if (!information.isFile() || information.isSymbolicLink() || information.size < 1 || information.size > maxBytes) {
    throw new Error(`${label} must be a bounded regular file.`);
  }
  return readFile(file);
}

export async function loadProtectedHeadlessPromptRequest({
  environment = process.env,
  sessionId = requiredEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_SESSION_ID', /^[^\0\r\n]{1,1024}$/u),
  rpcId = requiredEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_RPC_ID', /^[^\0\r\n]{1,256}$/u),
  promptFile = requiredEnvironment(environment, 'FORGE_EVAL_PROMPT_FILE', /^\/[^\0\r\n]+$/u),
} = {}) {
  if (typeof sessionId !== 'string' || !/^[^\0\r\n]{1,1024}$/u.test(sessionId)
    || typeof rpcId !== 'string' || !/^[^\0\r\n]{1,256}$/u.test(rpcId)
    || typeof promptFile !== 'string' || !/^\/[^\0\r\n]+$/u.test(promptFile)) {
    throw new Error('Protected headless prompt identity is invalid.');
  }
  const promptBuffer = await regularBoundedFile(promptFile, MAX_CLAIMABLE_PROMPT_BYTES, 'prompt');
  const promptText = promptBuffer.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  if (promptText.length === 0 || Buffer.byteLength(promptText, 'utf8') > MAX_CLAIMABLE_PROMPT_BYTES) {
    throw new Error('Headless prompt is empty or oversized.');
  }
  const body = Buffer.from(JSON.stringify({
    type: 'client-request',
    rpcId,
    method: 'session.prompt',
    payload: { sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] },
  }));
  return Object.freeze({
    sessionId,
    rpcId,
    promptFile,
    promptFileSha256: crypto.createHash('sha256').update(promptBuffer).digest('hex'),
    promptText,
    body,
    classified: classifyPinnedDshPromptBody(body, 'session.prompt'),
  });
}

export function assertHeadlessTaskspaceOwner(information, effectiveUid) {
  if (!information || typeof information.isDirectory !== 'function'
    || !information.isDirectory() || information.isSymbolicLink()) {
    throw new Error('TaskSpace root must be an ordinary directory.');
  }
  if (Number.isSafeInteger(effectiveUid) && information.uid !== effectiveUid) {
    throw new Error(
      'Protected headless preparation must run as the TaskSpace owner so the non-root Broker can read its execution state.',
    );
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DATABASE_CONTINUATION_RECEIPT_KEYS = [
  'schemaVersion', 'phaseId', 'phaseIndex', 'sourceStateSha256', 'sourceStateDigest',
  'sourceCommit', 'catalogVersion', 'catalogDigest', 'taskId', 'sessionId',
  'parentLastExecutionGeneration', 'nextExecutionGenerationMinimum',
  'inheritedArtifactDigests', 'inheritedAcceptedReceiptDigests',
  'parentDatabaseFailureReceiptDigests', 'stateDigest', 'promptSha256',
  'inheritedStageCount', 'newAcceptedStageCount', 'modelStarted', 'parentStateUnchanged',
];
const BACKEND_CONTINUATION_RECEIPT_KEYS = [
  'schemaVersion', 'sourceStateSha256', 'bindingsSha256', 'sourceCommit', 'catalogVersion',
  'catalogDigest', 'taskId', 'sessionId', 'parentLastExecutionGeneration',
  'nextExecutionGenerationMinimum', 'inheritedArtifactDigests', 'backendArtifactDigest',
  'backendHostReceiptsSha256', 'cumulativePatchSha256', 'stateDigest', 'promptSha256',
  'inheritedStageCount', 'finalizedBackendStageCount', 'newModelStarted', 'parentStateUnchanged',
];
const ACCESS_WIRING_CONTINUATION_RECEIPT_KEYS = [
  'schemaVersion', 'sourceStateSha256', 'bindingsSha256', 'sourceCommit',
  'catalogVersion', 'catalogDigest', 'taskId', 'sessionId',
  'parentLastExecutionGeneration', 'nextExecutionGenerationMinimum',
  'inheritedArtifactDigests', 'stateDigest', 'promptSha256', 'cumulativePatchSha256',
  'inheritedStageCount', 'newAcceptedStageCount', 'newModelStarted', 'parentStateUnchanged',
];
const CROSS_LAYER_CONTINUATION_RECEIPT_KEYS = ACCESS_WIRING_CONTINUATION_RECEIPT_KEYS;

function sameKeys(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...expected].sort().join('\n');
}

export function validateDatabaseContinuationSeedReceipt({
  receipt, state, promptFileSha256, sourceCommit, taskId, sessionId,
}) {
  const kinds = ['requirements-contract', 'domain-api-contract'];
  const phases = ['requirements', 'domain-contract'];
  const accepted = state?.history?.filter((entry) => entry.decision === 'accepted') ?? [];
  if (!sameKeys(receipt, DATABASE_CONTINUATION_RECEIPT_KEYS)
    || receipt.schemaVersion !== 'forge-delivery-database-continuation/v1'
    || receipt.phaseId !== 'database' || receipt.phaseIndex !== 2
    || !SHA256_PATTERN.test(receipt.sourceStateSha256 ?? '')
    || !SHA256_PATTERN.test(receipt.sourceStateDigest ?? '')
    || receipt.sourceCommit !== sourceCommit || receipt.sourceCommit !== state?.sourceCommit
    || receipt.catalogVersion !== state?.catalogVersion || receipt.catalogDigest !== state?.catalogDigest
    || receipt.taskId !== taskId || receipt.taskId !== state?.taskId
    || receipt.sessionId !== sessionId || receipt.sessionId !== state?.sessionId
    || receipt.stateDigest !== state?.stateDigest || receipt.promptSha256 !== promptFileSha256
    || state?.status !== 'active' || state.currentPhaseId !== 'database'
    || state.currentPhaseIndex !== 2 || state.activeAttempt !== null
    || !sameKeys(state.acceptedArtifacts, kinds)
    || !sameKeys(receipt.inheritedArtifactDigests, kinds)
    || !sameKeys(receipt.inheritedAcceptedReceiptDigests, phases)
    || kinds.some((kind) => !SHA256_PATTERN.test(receipt.inheritedArtifactDigests[kind] ?? '')
      || receipt.inheritedArtifactDigests[kind] !== state.acceptedArtifacts[kind])
    || accepted.length !== 2
    || accepted.some((entry, index) => entry.phaseId !== phases[index]
      || entry.artifactDigest !== receipt.inheritedArtifactDigests[kinds[index]]
      || entry.receiptDigest !== receipt.inheritedAcceptedReceiptDigests[phases[index]])
    || !Array.isArray(receipt.parentDatabaseFailureReceiptDigests)
    || receipt.parentDatabaseFailureReceiptDigests.length < 1
    || receipt.parentDatabaseFailureReceiptDigests.some((digest) => !SHA256_PATTERN.test(digest))
    || new Set(receipt.parentDatabaseFailureReceiptDigests).size
      !== receipt.parentDatabaseFailureReceiptDigests.length
    || receipt.inheritedStageCount !== 2 || receipt.newAcceptedStageCount !== 0
    || receipt.modelStarted !== false || receipt.parentStateUnchanged !== true
    || !Number.isSafeInteger(receipt.parentLastExecutionGeneration)
    || receipt.parentLastExecutionGeneration < state.lastExecutionGeneration
    || !Number.isSafeInteger(receipt.nextExecutionGenerationMinimum)
    || receipt.nextExecutionGenerationMinimum !== receipt.parentLastExecutionGeneration + 1
    || receipt.nextExecutionGenerationMinimum <= state.lastExecutionGeneration) {
    throw new Error('Database continuation receipt does not bind this initial protected phase state and prompt.');
  }
  return receipt.nextExecutionGenerationMinimum;
}

export function validateBackendContinuationSeedReceipt({ receipt, state, promptFileSha256,
  sourceCommit, taskId, sessionId }) {
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation', 'ui-interaction-contract'];
  const expected = [...kinds, 'backend-implementation'];
  const accepted = state?.history?.filter((entry) => entry.decision === 'accepted') ?? [];
  if (!sameKeys(receipt, BACKEND_CONTINUATION_RECEIPT_KEYS)
    || receipt.schemaVersion !== 'forge-delivery-backend-finalize-continuation/v1'
    || ![receipt.sourceStateSha256, receipt.bindingsSha256, receipt.backendHostReceiptsSha256,
      receipt.cumulativePatchSha256].every((digest) => SHA256_PATTERN.test(digest ?? ''))
    || receipt.sourceCommit !== sourceCommit || receipt.sourceCommit !== state?.sourceCommit
    || receipt.catalogVersion !== state?.catalogVersion || receipt.catalogDigest !== state?.catalogDigest
    || receipt.taskId !== taskId || receipt.taskId !== state?.taskId
    || receipt.sessionId !== sessionId || receipt.sessionId !== state?.sessionId
    || receipt.stateDigest !== state?.stateDigest || receipt.promptSha256 !== promptFileSha256
    || state?.status !== 'active' || state.currentPhaseId !== 'frontend'
    || state.currentPhaseIndex !== 5 || state.activeAttempt !== null
    || !sameKeys(state.acceptedArtifacts, expected)
    || !sameKeys(receipt.inheritedArtifactDigests, kinds)
    || kinds.some((kind) => receipt.inheritedArtifactDigests[kind] !== state.acceptedArtifacts[kind])
    || receipt.backendArtifactDigest !== state.acceptedArtifacts['backend-implementation']
    || accepted.length !== 5 || accepted.some((entry, index) => entry.phaseIndex !== index
      || entry.artifactDigest !== state.acceptedArtifacts[expected[index]])
    || receipt.inheritedStageCount !== 4 || receipt.finalizedBackendStageCount !== 1
    || receipt.newModelStarted !== false || receipt.parentStateUnchanged !== true
    || !Number.isSafeInteger(receipt.parentLastExecutionGeneration)
    || receipt.parentLastExecutionGeneration !== state.lastExecutionGeneration
    || receipt.nextExecutionGenerationMinimum !== receipt.parentLastExecutionGeneration + 1) {
    throw new Error('Backend continuation receipt does not bind the accepted frontend seed state.');
  }
  return receipt.nextExecutionGenerationMinimum;
}

export function validateAccessWiringContinuationSeedReceipt({ receipt, state, promptFileSha256,
  sourceCommit, taskId, sessionId }) {
  const phases = ['requirements', 'domain-contract', 'database', 'ui-design', 'backend', 'frontend'];
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation', 'frontend-implementation'];
  const accepted = state?.history?.filter((entry) => entry.decision === 'accepted') ?? [];
  if (!sameKeys(receipt, ACCESS_WIRING_CONTINUATION_RECEIPT_KEYS)
    || receipt.schemaVersion !== 'forge-delivery-access-wiring-continuation/v1'
    || ![receipt.sourceStateSha256, receipt.bindingsSha256, receipt.cumulativePatchSha256]
      .every((value) => SHA256_PATTERN.test(value ?? ''))
    || receipt.sourceCommit !== sourceCommit || receipt.sourceCommit !== state?.sourceCommit
    || receipt.catalogVersion !== state?.catalogVersion || receipt.catalogDigest !== state?.catalogDigest
    || receipt.taskId !== taskId || receipt.taskId !== state?.taskId
    || receipt.sessionId !== sessionId || receipt.sessionId !== state?.sessionId
    || receipt.stateDigest !== state?.stateDigest || receipt.promptSha256 !== promptFileSha256
    || state?.status !== 'active' || state.currentPhaseId !== 'access-wiring'
    || state.currentPhaseIndex !== 6 || state.activeAttempt !== null
    || !sameKeys(state.acceptedArtifacts, kinds)
    || !sameKeys(receipt.inheritedArtifactDigests, kinds)
    || kinds.some((kind) => !SHA256_PATTERN.test(receipt.inheritedArtifactDigests[kind] ?? '')
      || receipt.inheritedArtifactDigests[kind] !== state.acceptedArtifacts[kind])
    || accepted.length !== 6
    || accepted.some((entry, index) => entry.phaseId !== phases[index]
      || entry.phaseIndex !== index || entry.artifactDigest !== receipt.inheritedArtifactDigests[kinds[index]])
    || receipt.inheritedStageCount !== 6 || receipt.newAcceptedStageCount !== 0
    || receipt.newModelStarted !== false || receipt.parentStateUnchanged !== true
    || !Number.isSafeInteger(receipt.parentLastExecutionGeneration)
    || receipt.parentLastExecutionGeneration !== state.lastExecutionGeneration
    || !Number.isSafeInteger(receipt.nextExecutionGenerationMinimum)
    || receipt.nextExecutionGenerationMinimum !== receipt.parentLastExecutionGeneration + 1) {
    throw new Error('Access-wiring continuation receipt does not bind the accepted initial phase state and prompt.');
  }
  return receipt.nextExecutionGenerationMinimum;
}

export function validateCrossLayerContinuationSeedReceipt({ receipt, state, promptFileSha256,
  sourceCommit, taskId, sessionId }) {
  const phases = ['requirements', 'domain-contract', 'database', 'ui-design', 'backend',
    'frontend', 'access-wiring'];
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation',
    'ui-interaction-contract', 'backend-implementation', 'frontend-implementation',
    'access-wiring-implementation'];
  const accepted = state?.history?.filter((entry) => entry.decision === 'accepted') ?? [];
  if (!sameKeys(receipt, CROSS_LAYER_CONTINUATION_RECEIPT_KEYS)
    || receipt.schemaVersion !== 'forge-delivery-cross-layer-continuation/v1'
    || ![receipt.sourceStateSha256, receipt.bindingsSha256, receipt.cumulativePatchSha256]
      .every((value) => SHA256_PATTERN.test(value ?? ''))
    || receipt.sourceCommit !== sourceCommit || receipt.sourceCommit !== state?.sourceCommit
    || receipt.catalogVersion !== state?.catalogVersion || receipt.catalogDigest !== state?.catalogDigest
    || receipt.taskId !== taskId || receipt.taskId !== state?.taskId
    || receipt.sessionId !== sessionId || receipt.sessionId !== state?.sessionId
    || receipt.stateDigest !== state?.stateDigest || receipt.promptSha256 !== promptFileSha256
    || state?.status !== 'active' || state.currentPhaseId !== 'cross-layer-acceptance'
    || state.currentPhaseIndex !== 7 || state.activeAttempt !== null
    || !sameKeys(state.acceptedArtifacts, kinds)
    || !sameKeys(receipt.inheritedArtifactDigests, kinds)
    || kinds.some((kind) => !SHA256_PATTERN.test(receipt.inheritedArtifactDigests[kind] ?? '')
      || receipt.inheritedArtifactDigests[kind] !== state.acceptedArtifacts[kind])
    || accepted.length !== 7
    || accepted.some((entry, index) => entry.phaseId !== phases[index]
      || entry.phaseIndex !== index || entry.artifactDigest !== receipt.inheritedArtifactDigests[kinds[index]])
    || receipt.inheritedStageCount !== 7 || receipt.newAcceptedStageCount !== 0
    || receipt.newModelStarted !== false || receipt.parentStateUnchanged !== true
    || !Number.isSafeInteger(receipt.parentLastExecutionGeneration)
    || receipt.parentLastExecutionGeneration !== state.lastExecutionGeneration
    || !Number.isSafeInteger(receipt.nextExecutionGenerationMinimum)
    || receipt.nextExecutionGenerationMinimum !== receipt.parentLastExecutionGeneration + 1) {
    throw new Error('Cross-layer continuation receipt does not bind the accepted initial phase state and prompt.');
  }
  return receipt.nextExecutionGenerationMinimum;
}

export async function prepareHeadlessExecutionFromEnvironment(environment = process.env) {
  const projectRoot = requiredEnvironment(environment, 'FORGE_EVAL_PROJECT_ROOT', /^\/[^\0\r\n]+$/u);
  const projectSlug = requiredEnvironment(environment, 'PROJECT_SLUG', /^[a-z0-9][a-z0-9-]{1,47}$/u);
  const taskId = requiredEnvironment(environment, 'FORGE_TASKSPACE_ID', /^[a-z0-9][a-z0-9-]{1,47}$/u);
  const actorUserId = requiredEnvironment(
    environment,
    'FORGE_TASKSPACE_ACTOR_USER_ID',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  const actorUsername = requiredEnvironment(environment, 'FORGE_TASKSPACE_ACTOR_ID', /^[a-z0-9][a-z0-9._-]{1,63}$/u);
  const conversationId = requiredEnvironment(environment, 'FORGE_TASKSPACE_CONVERSATION_ID', /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u);
  const sessionId = requiredEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_SESSION_ID', /^[^\0\r\n]{1,1024}$/u);
  const rpcId = requiredEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_RPC_ID', /^[^\0\r\n]{1,256}$/u);
  const sourceCommit = requiredEnvironment(environment, 'FORGE_EVAL_SOURCE_COMMIT', /^[0-9a-f]{40}$/u);
  const caseFamily = requiredEnvironment(environment, 'FORGE_EVAL_CASE_FAMILY', /^[a-z0-9][a-z0-9-]{1,63}$/u);
  const promptFile = requiredEnvironment(environment, 'FORGE_EVAL_PROMPT_FILE', /^\/[^\0\r\n]+$/u);
  const policyFile = requiredEnvironment(environment, 'FORGE_EXECUTION_POLICY_FILE', /^\/[^\0\r\n]+$/u);
  const phaseWorkflowId = optionalEnvironment(environment, 'FORGE_EVAL_PHASE_WORKFLOW_ID', /^[a-z0-9][a-z0-9-]{1,63}$/u);
  const phaseId = optionalEnvironment(environment, 'FORGE_EVAL_PHASE_ID', /^[a-z0-9][a-z0-9-]{1,63}$/u);
  const phaseCatalogFile = optionalEnvironment(environment, 'FORGE_EVAL_PHASE_CATALOG_FILE', /^\/[^\0\r\n]+$/u);
  const phaseStateFile = optionalEnvironment(environment, 'FORGE_EVAL_PHASE_STATE_FILE', /^\/[^\0\r\n]+$/u);
  const databaseContinuationReceiptFile = optionalEnvironment(
    environment,
    'FORGE_EVAL_DATABASE_CONTINUATION_RECEIPT_FILE',
    /^\/[^\0\r\n]+$/u,
  );
  const backendContinuationReceiptFile = optionalEnvironment(
    environment, 'FORGE_EVAL_BACKEND_CONTINUATION_RECEIPT_FILE', /^\/[^\0\r\n]+$/u,
  );
  const accessWiringContinuationReceiptFile = optionalEnvironment(
    environment, 'FORGE_EVAL_ACCESS_WIRING_CONTINUATION_RECEIPT_FILE', /^\/[^\0\r\n]+$/u,
  );
  const crossLayerContinuationReceiptFile = optionalEnvironment(
    environment, 'FORGE_EVAL_CROSS_LAYER_CONTINUATION_RECEIPT_FILE', /^\/[^\0\r\n]+$/u,
  );
  if ([databaseContinuationReceiptFile, backendContinuationReceiptFile,
    accessWiringContinuationReceiptFile, crossLayerContinuationReceiptFile]
    .filter((file) => file !== undefined).length > 1) {
    throw new Error('Only one fixed continuation seed may be selected.');
  }
  const recoveryMode = optionalEnvironment(
    environment,
    'FORGE_PROTECTED_HEADLESS_RECOVERY_MODE',
    /^expired-unsubmitted-exact-context-v1$/u,
  );
  const phaseValues = [phaseWorkflowId, phaseId, phaseCatalogFile, phaseStateFile];
  if (phaseValues.some((value) => value !== undefined) && phaseValues.some((value) => value === undefined)) {
    throw new Error('Phased headless execution requires workflow, phase, catalog and state together.');
  }
  if (environment.FORGE_PROTECTED_HEADLESS_RECOVERY_PROOF_FILE !== undefined) {
    throw new Error('External recovery proof files are unsupported; use the versioned exact-context recovery mode.');
  }
  const recoveryOnlyEnvironmentNames = [
    'FORGE_PROTECTED_HEADLESS_RECOVERY_OPERATION_ID',
    'FORGE_PROTECTED_HEADLESS_RECOVERY_AUTHORIZATION_REFERENCE',
    'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PHASE_ATTEMPT_ID',
    'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_ID',
    'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CLAIM_ID',
    'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_GENERATION',
    'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CONTRACT_ID',
  ];
  if (recoveryMode === undefined
    && recoveryOnlyEnvironmentNames.some((name) => environment[name] !== undefined)) {
    throw new Error('Recovery identity variables require the explicit exact-context recovery mode.');
  }
  if (recoveryMode !== undefined && phaseWorkflowId === undefined) {
    throw new Error('Expired execution recovery is available only for a phased test-shadow run.');
  }
  if (databaseContinuationReceiptFile !== undefined
    && (phaseWorkflowId === undefined || phaseId !== 'database' || recoveryMode !== undefined)) {
    throw new Error('Database continuation receipt is only for the first protected database phase preparation.');
  }
  const recovery = recoveryMode === undefined ? undefined : {
    mode: recoveryMode,
    operationId: requiredEnvironment(
      environment,
      'FORGE_PROTECTED_HEADLESS_RECOVERY_OPERATION_ID',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    ),
    authorizationReference: requiredEnvironment(
      environment,
      'FORGE_PROTECTED_HEADLESS_RECOVERY_AUTHORIZATION_REFERENCE',
      /^[^\0\r\n]{1,256}$/u,
    ),
    expectedPhaseAttemptId: requiredEnvironment(
      environment,
      'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PHASE_ATTEMPT_ID',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    ),
    expectedExecutionId: requiredEnvironment(
      environment,
      'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_ID',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    ),
    expectedClaimId: requiredEnvironment(
      environment,
      'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CLAIM_ID',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    ),
    expectedGeneration: requiredPositiveIntegerEnvironment(
      environment,
      'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_GENERATION',
    ),
    expectedContractId: requiredEnvironment(
      environment,
      'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CONTRACT_ID',
      /^[0-9a-f]{64}$/u,
    ),
  };
  await regularBoundedFile(policyFile, 1024 * 1024, 'execution policy');
  const promptRequest = await loadProtectedHeadlessPromptRequest({ environment, sessionId, rpcId, promptFile });
  const taskspaceRoot = path.join(projectRoot, 'taskspaces', taskId);
  assertHeadlessTaskspaceOwner(
    await lstat(taskspaceRoot),
    typeof process.getuid === 'function' ? process.getuid() : undefined,
  );
  const metadataFile = path.join(taskspaceRoot, 'metadata.json');
  const metadata = validateTaskspaceMetadata(
    JSON.parse((await regularBoundedFile(metadataFile, 1024 * 1024, 'TaskSpace metadata')).toString('utf8')),
    projectSlug,
  );
  if (metadata.actorUserId !== actorUserId || metadata.actorId !== actorUsername
    || metadata.conversationId !== conversationId || metadata.accessMode !== 'conversation'
    || metadata.status !== 'active') {
    throw new Error('Headless execution identity does not match TaskSpace metadata.');
  }
  const prepareExecution = (phaseAuthority, minimumGeneration) => prepareProtectedExecutionContext({
    projectRoot,
    projectSlug,
    taskMetadata: metadata,
    request: {
      ...promptRequest.classified,
      actorUserId,
      actorUsername,
      conversationId,
      requestId: `eval:${caseFamily}:${rpcId}`.slice(0, 128),
    },
    policyPath: policyFile,
    ...(minimumGeneration === undefined ? {} : { minimumGeneration }),
    trustedPolicyInput: {
      profile: 'test-shadow',
      sourceCommit,
      caseFamily,
      ...(phaseAuthority === undefined ? {} : { phaseAuthority }),
    },
  });
  let execution;
  let phaseAttempt = null;
  if (phaseWorkflowId === undefined) {
    execution = await prepareExecution(undefined);
  } else {
    const loaded = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
    const resolved = resolveForgeDeliveryPhase({
      catalog: loaded.catalog,
      workflowId: phaseWorkflowId,
      caseFamily,
      phaseId,
    });
    ({ execution, phaseAttempt } = await withForgeDeliveryPhaseStateLock(phaseStateFile, async () => {
      let state;
      try {
        state = await readForgeDeliveryPhaseState(phaseStateFile, loaded.catalog);
      } catch (error) {
        if (error?.code !== 'PHASE_STATE_INVALID') throw error;
        const existing = await lstat(phaseStateFile).catch((cause) => {
          if (cause.code === 'ENOENT') return undefined;
          throw cause;
        });
        if (existing !== undefined || phaseId !== resolved.phase.id || resolved.phase.index !== 0) throw error;
        state = createForgeDeliveryPhaseState({
          catalog: loaded.catalog,
          workflowId: phaseWorkflowId,
          caseFamily,
          taskId,
          sessionId,
          sourceCommit,
        });
        await writeForgeDeliveryPhaseState(phaseStateFile, state, loaded.catalog);
      }
      if (state.taskId !== taskId || state.sessionId !== sessionId || state.sourceCommit !== sourceCommit
        || state.caseFamily !== caseFamily || state.currentPhaseId !== phaseId || state.status !== 'active') {
        throw new Error('Headless phase state does not match the current TaskSpace execution.');
      }
      let minimumGeneration;
      if (phaseId === 'cross-layer-acceptance') {
        await readPreparedForgeCrossLayerRuntimeEvidence({ stateFile: phaseStateFile, state,
          promptText: promptRequest.promptText });
      }
      if (databaseContinuationReceiptFile !== undefined) {
        const information = await lstat(databaseContinuationReceiptFile);
        if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1
          || (process.platform !== 'win32' && ((information.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && information.uid !== process.getuid())))) {
          throw new Error('Database continuation receipt must be a private ordinary TaskSpace-owner file.');
        }
        let receipt;
        try {
          receipt = JSON.parse((await regularBoundedFile(
            databaseContinuationReceiptFile, 256 * 1024, 'database continuation receipt',
          )).toString('utf8'));
        } catch {
          throw new Error('Database continuation receipt is unreadable or invalid.');
        }
        minimumGeneration = validateDatabaseContinuationSeedReceipt({
          receipt, state, promptFileSha256: promptRequest.promptFileSha256,
          sourceCommit, taskId, sessionId,
        });
        if (crypto.createHash('sha256').update(await regularBoundedFile(
          promptFile, MAX_CLAIMABLE_PROMPT_BYTES, 'prompt',
        )).digest('hex') !== receipt.promptSha256) {
          throw new Error('Database continuation prompt changed during preparation.');
        }
      }
      if (backendContinuationReceiptFile !== undefined) {
        const information = await lstat(backendContinuationReceiptFile);
        if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1
          || (process.platform !== 'win32' && ((information.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && information.uid !== process.getuid())))) {
          throw new Error('Backend continuation receipt must be a private ordinary TaskSpace-owner file.');
        }
        const receipt = JSON.parse((await regularBoundedFile(backendContinuationReceiptFile,
          256 * 1024, 'backend continuation receipt')).toString('utf8'));
        minimumGeneration = validateBackendContinuationSeedReceipt({ receipt, state,
          promptFileSha256: promptRequest.promptFileSha256, sourceCommit, taskId, sessionId });
        if (crypto.createHash('sha256').update(await regularBoundedFile(
          promptFile, MAX_CLAIMABLE_PROMPT_BYTES, 'prompt')).digest('hex') !== receipt.promptSha256) {
          throw new Error('Backend continuation frontend prompt changed during preparation.');
        }
      }
      if (accessWiringContinuationReceiptFile !== undefined) {
        const controlDirectory = path.dirname(phaseStateFile);
        if (caseFamily !== 'crud-complete' || resolved.phase.id !== 'access-wiring'
          || resolved.phase.index !== 6 || path.basename(phaseStateFile) !== 'state.json'
          || accessWiringContinuationReceiptFile !== path.join(controlDirectory, 'access-wiring-continuation-receipt.json')
          || promptFile !== path.join(controlDirectory, 'current-prompt.md')) {
          throw new Error('Access-wiring continuation files do not match the fixed phase-control layout.');
        }
        const controlDirectoryInfo = await lstat(controlDirectory);
        const information = await lstat(accessWiringContinuationReceiptFile);
        if (!controlDirectoryInfo.isDirectory() || controlDirectoryInfo.isSymbolicLink()
          || !information.isFile() || information.isSymbolicLink() || information.nlink !== 1
          || (process.platform !== 'win32' && ((controlDirectoryInfo.mode & 0o077) !== 0
            || (information.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && (controlDirectoryInfo.uid !== process.getuid()
              || information.uid !== process.getuid()))))) {
          throw new Error('Access-wiring continuation receipt must be a private ordinary TaskSpace-owner file.');
        }
        let receipt;
        try {
          receipt = JSON.parse((await regularBoundedFile(accessWiringContinuationReceiptFile,
            256 * 1024, 'access-wiring continuation receipt')).toString('utf8'));
        } catch {
          throw new Error('Access-wiring continuation receipt is unreadable or invalid.');
        }
        minimumGeneration = validateAccessWiringContinuationSeedReceipt({ receipt, state,
          promptFileSha256: promptRequest.promptFileSha256, sourceCommit, taskId, sessionId });
        const artifactsDirectory = path.join(controlDirectory, 'artifacts');
        const artifactsDirectoryInfo = await lstat(artifactsDirectory);
        if (!artifactsDirectoryInfo.isDirectory() || artifactsDirectoryInfo.isSymbolicLink()
          || (process.platform !== 'win32' && ((artifactsDirectoryInfo.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && artifactsDirectoryInfo.uid !== process.getuid())))) {
          throw new Error('Access-wiring continuation artifacts must remain in a private ordinary directory.');
        }
        for (const [kind, expectedDigest] of Object.entries(receipt.inheritedArtifactDigests)) {
          const artifactFile = path.join(artifactsDirectory, `${kind}.json`);
          const artifactInfo = await lstat(artifactFile);
          if (!artifactInfo.isFile() || artifactInfo.isSymbolicLink() || artifactInfo.nlink !== 1
            || (process.platform !== 'win32' && ((artifactInfo.mode & 0o077) !== 0
              || (typeof process.getuid === 'function' && artifactInfo.uid !== process.getuid())))) {
            throw new Error(`Access-wiring continuation accepted artifact ${kind} is not private.`);
          }
          const artifact = validateForgeDeliveryPhaseArtifact(JSON.parse((await regularBoundedFile(
            artifactFile, 2 * 1024 * 1024, `accepted artifact ${kind}`,
          )).toString('utf8')));
          if (artifact.artifactKind !== kind || artifact.artifactDigest !== expectedDigest
            || artifact.workflowId !== state.workflowId) {
            throw new Error(`Access-wiring continuation accepted artifact ${kind} is stale.`);
          }
        }
        if (crypto.createHash('sha256').update(await regularBoundedFile(
          promptFile, MAX_CLAIMABLE_PROMPT_BYTES, 'prompt')).digest('hex') !== receipt.promptSha256) {
          throw new Error('Access-wiring continuation prompt changed during preparation.');
        }
      }
      if (crossLayerContinuationReceiptFile !== undefined) {
        const controlDirectory = path.dirname(phaseStateFile);
        if (caseFamily !== 'crud-complete' || resolved.phase.id !== 'cross-layer-acceptance'
          || resolved.phase.index !== 7 || path.basename(phaseStateFile) !== 'state.json'
          || crossLayerContinuationReceiptFile !== path.join(controlDirectory, 'cross-layer-continuation-receipt.json')
          || promptFile !== path.join(controlDirectory, 'current-prompt.md')) {
          throw new Error('Cross-layer continuation files do not match the fixed phase-control layout.');
        }
        const controlDirectoryInfo = await lstat(controlDirectory);
        const information = await lstat(crossLayerContinuationReceiptFile);
        if (!controlDirectoryInfo.isDirectory() || controlDirectoryInfo.isSymbolicLink()
          || !information.isFile() || information.isSymbolicLink() || information.nlink !== 1
          || (process.platform !== 'win32' && ((controlDirectoryInfo.mode & 0o077) !== 0
            || (information.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && (controlDirectoryInfo.uid !== process.getuid()
              || information.uid !== process.getuid()))))) {
          throw new Error('Cross-layer continuation receipt must be a private ordinary TaskSpace-owner file.');
        }
        let receipt;
        try {
          receipt = JSON.parse((await regularBoundedFile(crossLayerContinuationReceiptFile,
            256 * 1024, 'cross-layer continuation receipt')).toString('utf8'));
        } catch {
          throw new Error('Cross-layer continuation receipt is unreadable or invalid.');
        }
        minimumGeneration = validateCrossLayerContinuationSeedReceipt({ receipt, state,
          promptFileSha256: promptRequest.promptFileSha256, sourceCommit, taskId, sessionId });
        const artifactsDirectory = path.join(controlDirectory, 'artifacts');
        const artifactsDirectoryInfo = await lstat(artifactsDirectory);
        if (!artifactsDirectoryInfo.isDirectory() || artifactsDirectoryInfo.isSymbolicLink()
          || (process.platform !== 'win32' && ((artifactsDirectoryInfo.mode & 0o077) !== 0
            || (typeof process.getuid === 'function' && artifactsDirectoryInfo.uid !== process.getuid())))) {
          throw new Error('Cross-layer continuation artifacts must remain in a private ordinary directory.');
        }
        for (const [kind, expectedDigest] of Object.entries(receipt.inheritedArtifactDigests)) {
          const artifactFile = path.join(artifactsDirectory, `${kind}.json`);
          const artifactInfo = await lstat(artifactFile);
          if (!artifactInfo.isFile() || artifactInfo.isSymbolicLink() || artifactInfo.nlink !== 1
            || (process.platform !== 'win32' && ((artifactInfo.mode & 0o077) !== 0
              || (typeof process.getuid === 'function' && artifactInfo.uid !== process.getuid())))) {
            throw new Error(`Cross-layer continuation accepted artifact ${kind} is not private.`);
          }
          const artifact = validateForgeDeliveryPhaseArtifact(JSON.parse((await regularBoundedFile(
            artifactFile, 2 * 1024 * 1024, `accepted artifact ${kind}`,
          )).toString('utf8')));
          if (artifact.artifactKind !== kind || artifact.artifactDigest !== expectedDigest
            || artifact.workflowId !== state.workflowId) {
            throw new Error(`Cross-layer continuation accepted artifact ${kind} is stale.`);
          }
        }
        if (crypto.createHash('sha256').update(await regularBoundedFile(
          promptFile, MAX_CLAIMABLE_PROMPT_BYTES, 'prompt')).digest('hex') !== receipt.promptSha256) {
          throw new Error('Cross-layer continuation prompt changed during preparation.');
        }
      }
      if (recovery === undefined && state.history.at(-1)?.decision === 'rejected') {
        const retryReceiptFile = forgeDeliveryPhaseRetryPromptReceiptPath(
          promptFile,
          state.history.at(-1).attemptId,
        );
        let retryReceipt;
        try {
          retryReceipt = JSON.parse((await regularBoundedFile(
            retryReceiptFile,
            256 * 1024,
            'retry prompt receipt',
          )).toString('utf8'));
        } catch (error) {
          if (error?.code === 'PHASE_CONTROLLER_RETRY_RECEIPT_INVALID') throw error;
          throw new Error('Rejected phase retry requires its Controller-generated prompt receipt.');
        }
        const validatedRetry = validateForgeDeliveryPhaseRetryPromptReceipt({
          receipt: retryReceipt,
          state,
          catalog: loaded.catalog,
          promptDigest: crypto.createHash('sha256').update(promptRequest.promptText, 'utf8').digest('hex'),
        });
        if (minimumGeneration === undefined && caseFamily === 'crud-complete'
          && resolved.phase.id === 'frontend' && resolved.phase.index === 5
          && state.lastExecutionGeneration === validatedRetry.rejectedExecutionGeneration) {
          const protectedStateFile = path.join(projectRoot, 'taskspaces', '.broker', 'executions', `${taskId}.json`);
          const previous = await lstat(protectedStateFile).catch((error) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          });
          if (previous === undefined) {
            minimumGeneration = validatedRetry.rejectedExecutionGeneration + 1;
          }
        }
      }
      const phaseAuthority = {
        workflowId: resolved.workflowId,
        phaseId: resolved.phase.id,
        phaseIndex: resolved.phase.index,
        catalogVersion: resolved.catalogVersion,
        catalogDigest: resolved.catalogDigest,
        actionCeiling: resolved.phase.actionCeiling,
        ownedPaths: [...resolved.phase.ownedPaths].sort(),
        taskProfiles: resolved.phase.taskProfiles,
        requiredProfiles: resolved.phase.contractVerificationProfiles,
      };
      let nextState;
      let prepared;
      if (recovery !== undefined) {
        const active = state.activeAttempt;
        if (active === null || active.phaseId !== phaseId || active.rpcId !== rpcId
          || active.attemptId !== recovery.expectedPhaseAttemptId
          || active.executionGeneration !== recovery.expectedGeneration
          || active.sessionMode !== 'resume') {
          throw new Error('Recovery identity does not match the active resumed phase attempt.');
        }
        prepared = await issueProtectedExecutionRecoveryPermit({
          projectRoot,
          projectSlug,
          taskMetadata: metadata,
          request: {
            ...promptRequest.classified,
            actorUserId,
            actorUsername,
            conversationId,
            requestId: `eval:${caseFamily}:${rpcId}`.slice(0, 128),
          },
          phaseAttempt: {
            attemptId: active.attemptId,
            phaseId: active.phaseId,
            sessionMode: active.sessionMode,
            rpcId: active.rpcId,
            promptDigest: active.promptDigest,
            executionGeneration: active.executionGeneration,
          },
          recovery,
          policyPath: policyFile,
          trustedPolicyInput: {
            profile: 'test-shadow', sourceCommit, caseFamily, phaseAuthority,
          },
        });
        nextState = state;
      } else {
        prepared = await prepareExecution(phaseAuthority, minimumGeneration);
        nextState = beginForgeDeliveryPhase({
          state,
          catalog: loaded.catalog,
          phaseId,
          rpcId,
          promptDigest: prepared.promptDigest,
          executionGeneration: prepared.generation,
        });
        await writeForgeDeliveryPhaseState(phaseStateFile, nextState, loaded.catalog);
      }
      return { execution: prepared, phaseAttempt: nextState.activeAttempt };
    }));
  }
  return {
    schemaVersion: 1,
    receiptType: recovery === undefined
      ? 'forge-protected-execution/test-shadow-prepare'
      : 'forge-protected-execution/test-shadow-recovery-permit',
    testOnly: true,
    projectSlug,
    taskId,
    caseFamily,
    workflowId: execution.workflowId,
    phaseId: execution.phaseId,
    phaseIndex: execution.phaseIndex,
    phaseCatalogVersion: execution.phaseCatalogVersion,
    phaseCatalogDigest: execution.phaseCatalogDigest,
    phaseAttemptId: phaseAttempt?.attemptId ?? null,
    sessionMode: phaseAttempt?.sessionMode ?? 'create',
    sourceCommit,
    executionId: execution.executionId,
    claimId: execution.claimId,
    generation: execution.generation,
    contractId: execution.contractId,
    actionCeiling: execution.actionCeiling,
    ownedPaths: execution.ownedPaths,
    policyVersion: execution.policyVersion,
    ...(recovery === undefined ? {} : {
      recovery: {
        mode: PROTECTED_EXECUTION_RECOVERY_MODE,
        operationId: execution.recoveryPermit.operationId,
        status: execution.recoveryPermit.status,
        permitExpiresAt: execution.recoveryPermit.permitExpiresAt,
        authorizationReference: execution.recoveryPermit.authorizationReference,
        phaseStateChanged: false,
        contextIdentityChanged: false,
      },
    }),
  };
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
  prepareHeadlessExecutionFromEnvironment()
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`protected headless execution prepare failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
