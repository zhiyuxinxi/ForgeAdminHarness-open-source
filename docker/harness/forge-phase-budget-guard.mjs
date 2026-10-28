import { admittedVerificationProfile } from './forge-backend-source-quality.mjs';
import { BROWSER_READ_ACTIONS, closeBrowserSession, reconcileBrowserAuthority } from './forge-browser.mjs';
import { directDevelopmentEnabled, directDevelopmentPath, withDirectToolPolicy } from './forge-direct-development.mjs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  CONTROLLED_RELEASE_COMMAND_MAX_LENGTH,
  controlledEvidenceReceipt,
  controlledEvidenceCommandHint,
  parseControlledEvidenceCommand,
  parseControlledDeliveryCommand,
  parseControlledGovernanceInspectionCommand,
  parseControlledVerificationInspectionCommand,
  parseControlledReleaseInspectionCommand,
  parseControlledReleasePreparationCommand,
  parseControlledReleaseMutationCommand,
} from './forge-controlled-command.mjs';
import {
  isForgeChangeRecordPath,
  isForgeTaskOwnedPath,
  validateForgeTaskExecutionContract,
} from './forge-task-execution-contract.mjs';
import { canonicalSha256 } from './forge-acceptance-aggregator.mjs';
import { validateSourceTransition } from './taskspace-policy.mjs';
import { protectedCompletionProjectionReady, resolveProtectedCompletionFromBroker } from './forge-completion-claim-guard.mjs';
import {
  PROTECTED_EXECUTION_SCHEMA_VERSION,
  digestDirectUserTextContent,
  hasGlobalReadOnlyIntent,
  isRenewableWorkflowPhaseWriter,
  validateProtectedExecutionContext,
} from './forge-execution-context.mjs';
import { executionSha256, sealExecutionReceipt } from './forge-execution-state.mjs';
import { createBrokerWriterScopeLeaseClient, installForgeWriterScopeLease } from './forge-writer-scope-client.mjs';
import { BUSINESS_DATA_PREVIEW_TOOL, createBrokerBusinessDataPreviewClient, registerBusinessDataPreviewTool,
  createBrokerBusinessDataApplyClient, registerBusinessDataApplyTool } from './forge-business-data-preview.mjs';
import { BUSINESS_DATA_APPLY_TOOL, hasDirectBusinessDataIntent } from './forge-business-data-consumption.mjs';
import { MANAGED_FILE_TOOL } from './forge-managed-files.mjs';
import { createManagedFileClient, registerManagedFileTool } from './forge-managed-file-tool.mjs';
import { detectExecutionProgress } from './forge-progress-detector.mjs';
import {
  PREPARE_TASK_ACTION,
  PREPARE_TASK_TOOL_NAME,
  createBrokerPrepareTaskClient,
  registerPrepareTaskTool,
  validatePrepareTaskResult,
} from './forge-prepare-task.mjs';

const PHASE_GUARD_MARKER = 'FORGE_PHASE_BUDGET_GUARD_V1';
const TEST_FIRST_NEXT_STEP = '业务行为变化请先写真实回归测试并验证失败；若仅修已有 lint/格式且保持行为不变，请让用户在原对话新一轮明确此限制，再通过 prepare_task 准备精确文件范围；不得自行豁免或伪造 RED。';
const ORDINARY_RESPONSE_CONTRACT = 'ORDINARY RESPONSE CONTRACT (presentation only; never an admission or refusal): The user is a business stakeholder. Reply in the user\'s main language, normally in 1-3 short paragraphs or a short list only when needed. Lead with the concrete business outcome and impact, then only the actually relevant next step. Do not force headings or default to technical IDs, hashes, original commands, receipt tables, or repeated internal contracts; provide relevant technical evidence only for troubleshooting or when the user asks. Preserve machine facts and evidence, but do not describe historical evidence as newly verified this turn or conflate code inspection, deployment, and business acceptance. Mention only actually relevant unfinished work; do not repeatedly pile on UAT or rollback disclaimers or invent an online change or assigned role. This presentation contract never changes execution permission, admission, evidence, or acceptance and creates no refusal, secondary review, or automatic rewriting.';
const ORDINARY_CONFIRMATION_GUIDANCE = 'Confirmation entry: ask_user_question selections are business input, not a signed execution or release grant. If the requested action still lacks user authorization, obtain that confirmation through a direct user chat message, then use prepare_task and the resulting protected action ceiling; do not promise that a question option alone upgrades read-only authority. Do not repeat confirmation or require a separate release confirmation when the original direct request already authorized that action and scope. No special wording is required, and this guidance grants no permission.';
const inject = Object.freeze(['tools', 'systemPrompt']);
const DEFAULT_MAX_STEPS = 80;
const MAX_MUTATIONS_WITHOUT_AUDIT = 5;
const MAX_REPAIR_MUTATIONS = 5;
const MAX_CLOSEOUT_CORRECTIONS = 1;
const MAX_TOTAL_MUTATIONS = 20;
const DEFAULT_EXECUTION_CONTEXT_TTL_MS = 30 * 60 * 1000;
const MAX_EXECUTION_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const TEST_SHADOW_CANDIDATE_WRITE_MODE = 'candidate-only-v1';
const PRODUCTION_ADMISSION_CEILINGS = new Set([
  'workspace-write',
  'git-checkpoint',
  'release',
]);

const PHASES = Object.freeze({
  ROUTE: 'ROUTE',
  DISCOVER: 'DISCOVER',
  IMPLEMENT: 'IMPLEMENT',
  VERIFY: 'VERIFY',
  REPAIR: 'REPAIR',
  CLOSEOUT: 'CLOSEOUT',
});

const MUTATION_TOOLS = new Set(['copy_file', 'edit', 'remove_file', 'write']);
// The pinned providers enforce the calling session. Planning and questions do
// not mutate workspace source and never count as verification evidence.
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls', 'find', 'skill', 'job_output', 'job_list', BUSINESS_DATA_PREVIEW_TOOL]);
const KNOWN_TOOL_NAMES = new Set([
  ...MUTATION_TOOLS, ...READ_TOOLS, 'todo_write', 'ask_user_question',
  'bash', 'browser', 'str_replace_editor', PREPARE_TASK_TOOL_NAME, BUSINESS_DATA_APPLY_TOOL, MANAGED_FILE_TOOL,
]);
const DOMAIN_SKILL_EXCLUSIONS = new Set([
  'forge-task-router',
  'forge-task-contract',
  'forge-evidence-truth',
]);
const REQUIRED_SOURCE_MUTATION_SKILLS = Object.freeze([
  'forge-change-design',
  'forge-testing-observability',
]);
const RED_TEST_PROFILES = new Set([
  'backend-red-test',
  'frontend-red-test',
]);
const STALE_CREATE_STAGES = new Set(['read', 'read-reserved', 'write', 'write-reserved']);
const STALE_CREATE_STOPS = new Set([
  'NO_MACHINE_OBSERVABLE_PROGRESS', 'REPEATED_ACTION_RESULT_NO_PROGRESS',
]);

const NETWORK_COMMAND = /(?:^|[;&|()\s])(?:curl|wget|telnet|nc|ncat|Invoke-WebRequest|Invoke-RestMethod)(?:\s|$)/iu;
const SHELL_MUTATION = /(?:^|[;&|()\s])(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|install|truncate|patch)(?:\s|$)|(?:^|\s)(?:sed\s+-[^\r\n]*i|perl\s+-[^\r\n]*i)|\btee(?:\s|$)|\bgit\s+(?:add|commit|checkout|switch|reset|clean|merge|rebase|cherry-pick|tag|push)\b/iu;
const GIT_MUTATION = /\bgit\s+(?:add|commit|checkout|switch|reset|clean|merge|rebase|cherry-pick|tag|push)\b/iu;
const DEPENDENCY_COMMAND = /\b(?:mvn|mvnw|pnpm|npm|yarn|gradle|gradlew)\b/iu;
const VERIFICATION_COMMAND = /\b(?:mvn|mvnw|gradle|gradlew)\b[^\r\n]*(?:test|verify|check|compile|package)\b|\b(?:pnpm|npm|yarn)\b[^\r\n]*(?:test|build|lint|typecheck)\b|\b(?:vitest|jest|playwright)\b/iu;
const CONTROLLED_COMMAND_REFERENCE = /\bforge-governance\s+audit\b|\bforge-verify\b|\bforge-release\b|\bforge-delivery\b/iu;
const CONTROLLED_INTEGRATE_REFERENCE = /^(?:\/usr\/local\/bin\/)?forge-release\s+integrate(?:\s|$)/u;
const SHELL_COMPOSITION = /[\r\n;&|`<>]|\$\(|\$\{|\\\r?\n/u;
const CLOSEOUT_READ_COMMAND = /\bgit\s+(?:status|diff|show)\b/iu;
const DEPENDENCY_FAILURE = /(?:could not (?:resolve dependencies|transfer artifact)|failed to (?:collect dependencies|read artifact descriptor)|unknown host|name or service not known|temporary failure in name resolution|network is unreachable|connection (?:refused|timed out)|econnrefused|enetunreach|etimedout|err_pnpm_fetch|npm err!.*(?:network|fetch)|unable to access .*?:\/\/)/iu;
const CONTROLLED_VERIFICATION_BLOCKED = /(?:VERIFY_CAPABILITY_UNAVAILABLE|VERIFY_CACHE_(?:MISS|INVALID)|VERIFY_EXECUTOR_[A-Z_]+|VERIFY_RUNNER_SAFETY_HOLD|"outcome"\s*:\s*"(?:cache_(?:miss|invalid)|executor_unavailable)"|ENOENT[^\r\n]*broker-token|ECONNREFUSED[^\r\n]*taskspace-broker|verification capability token is invalid)/iu;
const EXPLICIT_TEST_FIRST_CONTRACT = /(?:\b(?:TDD|test[- ]first|RED\s*(?:→|->)\s*GREEN)\b|先写[^\r\n]{0,80}(?:失败|回归)[^\r\n]{0,40}测试|先[^\r\n]{0,60}测试[^\r\n]{0,40}再(?:做|修|改|实现))/iu;
const WRITE_INTENT = /\b(?:implement|fix|modify|change|add|create|delete|refactor|build)\b|修复|修改|新增|创建|删除|重构|改代码|写代码|(?:请|需要|要|开始|继续|直接)[^\r\n]{0,12}实现|实现[^\r\n]{0,12}(?:功能|需求|代码|修复|改动)/iu;
const FULL_DISK_CACHE_HUNT = /(?:\bfind\s+\/(?:\s|$)|\b(?:rg|grep)\b[^\r\n]*\s\/(?:\s|$)|\bls\s+-R\s+\/(?:\s|$)|Get-ChildItem\s+(?:[A-Za-z]:\\|\/)\s+[^\r\n]*-Recurse)/iu;
const MIRROR_HUNT = /\b(?:mirror|registry|repository)\b[^\r\n]*(?:settings\.xml|\.npmrc|sources\.list)|(?:settings\.xml|\.npmrc|sources\.list)[^\r\n]*\b(?:mirror|registry|repository)\b/iu;
const DEPENDENCY_MANIFEST_PATH = /(?:^|\/)(?:pom\.xml|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|package-lock\.json|yarn\.lock|gradle\.lockfile|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/iu;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function boundedStepBudget(value = DEFAULT_MAX_STEPS) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 8 && parsed <= 400 ? parsed : DEFAULT_MAX_STEPS;
}

function createInitialPhaseState({ turn = 0, maxSteps = DEFAULT_MAX_STEPS, suspendHeuristicStops = false } = {}) {
  return {
    turn,
    maxSteps: boundedStepBudget(maxSteps),
    suspendHeuristicStops: suspendHeuristicStops === true,
    currentStep: 0,
    phase: PHASES.ROUTE,
    sequence: 0,
    routerSequence: 0,
    domainSkillSequence: 0,
    evidenceSequence: 0,
    mutationCount: 0,
    mutationAttemptCount: 0,
    mutationSequence: 0,
    testMutationSequence: 0,
    productionMutationSequence: 0,
    tddRequired: false,
    mutationsSinceAudit: 0,
    verificationSequence: 0,
    completionVerificationSequence: 0,
    completionGateDigest: null,
    verificationProfileCapabilities: new Map(),
    verificationAdmission: undefined,
    verificationProfileAttempts: new Map(),
    verificationProfileReceipts: new Map(),
    verificationBackgroundJobs: new Map(),
    sourceTransitionJobs: new Map(),
    verificationObserver: undefined,
    verificationFailed: false,
    verificationBlocked: false,
    auditSequence: 0,
    auditSucceeded: false,
    dependencyFailureCount: 0,
    dependencyRetryReserved: false,
    dependencyRetryCallId: '',
    dependencyClosed: false,
    invokedSkills: new Set(),
    prompt: '',
    ownedPaths: new Set(),
    taskContract: undefined,
    taskIntent: undefined,
    repairAvailable: false,
    repairWindowUsed: false,
    repairVerificationFamily: '',
    repairMutationCount: 0,
    repairMutationReservations: new Set(),
    writerReservations: new Map(),
    settledWriterCalls: new Set(),
    staleCreate: undefined,
    lastReminderKey: '',
    lastReminderPolicy: '',
    lastReminderAdmissionId: '',
    lastReminderCompaction: undefined,
    stoppingIdentity: undefined,
    closeoutCorrections: 0,
    actionCeiling: 'read-only',
    actionCeilingLocked: false,
    promptReadOnlyConstraint: false,
    prepareTaskAvailable: false,
    executionContextStatus: 'unavailable',
    executionIdentity: undefined,
    executionContextExpiresAt: undefined,
    executionContextIssuedAt: undefined,
    executionContextGeneration: undefined,
    executionProjectSlug: undefined,
    executionActorUserId: undefined,
    executionConversationId: undefined,
    executionDshSessionId: undefined,
    executionRpcId: undefined,
    executionTextDigest: undefined,
    executionProjectionRequired: false,
    executionProjectionStatus: 'disabled',
    executionProjectionStore: undefined,
    executionProjectionSnapshot: undefined,
    executionProjectionErrorCode: undefined,
    executionProjectionTail: Promise.resolve(),
    executionProjectionWriterReservations: new Map(),
    executionAuthorityClass: undefined,
    protectedExecutionContextValidated: false,
    executionTestOnly: false,
    executionSourceCommit: undefined,
    executionWorkspaceFingerprint: undefined,
    previousCompletion: undefined,
    executionCaseFamily: undefined,
    testShadowCandidateWriteRequested: false,
    testShadowVerificationRunnerRevision: undefined,
    redGateEvidence: undefined,
    redGateAdapterRejection: undefined,
    turnStepBase: 0,
    lastObservedTurnStep: 0,
    admissionFailureCount: 0,
    admissionFailure: undefined,
    progressObservations: [],
    progressDecision: undefined,
    implementationSwitchRequired: false,
  };
}

function progressDigest(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function detectorPhase(phase) {
  if (phase === PHASES.IMPLEMENT) return 'IMPLEMENT_INCREMENT';
  if (phase === PHASES.VERIFY) return 'VERIFY_AFFECTED';
  if (phase === PHASES.ROUTE) return 'DISCOVER';
  return phase;
}

function evaluateProgress(state) {
  if (!state) return undefined;
  // Ordinary authorized implementation is bounded by its real execution lease,
  // scope and required evidence, not a fixed count of otherwise successful tools.
  const ordinaryImplementation = draftBeforeVerification(state) && state.mutationCount > 0;
  const requiredProgressKeys = state.taskContract
    ? state.taskContract.requiredSkills
      .filter((skill) => skill !== 'forge-evidence-truth')
      .map((skill) => `skill:${skill}`)
    : [];
  return detectExecutionProgress({
    phase: detectorPhase(state.phase),
    counters: {
      requests: state.currentStep,
      toolCalls: state.sequence,
      mutations: state.mutationAttemptCount,
    },
    limits: {
      requests: ordinaryImplementation ? 0 : state.maxSteps,
      toolCalls: ordinaryImplementation ? 0 : state.maxSteps * 2,
      mutations: state.suspendHeuristicStops ? 0 : MAX_TOTAL_MUTATIONS,
    },
    observations: state.progressObservations,
    requiredProgressKeys,
    reservedCloseoutRequests: ordinaryImplementation ? 0 : Math.max(2, Math.ceil(state.maxSteps * 0.1)),
    suspendHeuristicStops: state.suspendHeuristicStops === true,
  });
}

function isUnknownSideEffectExecution(exec) {
  if (typeof exec?.name !== 'string' || KNOWN_TOOL_NAMES.has(exec.name)) return false;
  return true;
}

// Build-time inventory projects the same admitted tool sets used by this guard.
// Argument-sensitive tools retain that boundary rather than claiming a single
// unconditional permission. This descriptor never grants execution authority.
function describeGovernedTool(name) {
  if (name === 'browser') return { admitted: true, classification: 'argument-dependent', sideEffectClasses: ['read-only', 'browser-interaction'] };
  if (isUnknownSideEffectExecution({ name })) return { admitted: false, classification: 'unclassified-denied', sideEffectClasses: [] };
  if (name === BUSINESS_DATA_APPLY_TOOL) return { admitted: true, classification: 'business-data-mutation', sideEffectClasses: ['business-data-write'] };
  if (name === MANAGED_FILE_TOOL) return { admitted: true, classification: 'argument-dependent', sideEffectClasses: ['read-only', 'brokered-state-change'] };
  if (MUTATION_TOOLS.has(name)) return { admitted: true, classification: 'workspace-mutation', sideEffectClasses: ['workspace-write'] };
  if (READ_TOOLS.has(name)) return { admitted: true, classification: 'read', sideEffectClasses: ['read-only'] };
  if (name === 'bash') return { admitted: true, classification: 'exact-controlled-argv', sideEffectClasses: ['read-only', 'bounded-derived-write', 'brokered-state-change', 'git-write', 'controlled-release'] };
  if (name === 'str_replace_editor') return { admitted: true, classification: 'argument-dependent', sideEffectClasses: ['read-only', 'workspace-write'] };
  return { admitted: true, classification: 'session-state', sideEffectClasses: ['brokered-state-change'] };
}

function isWriterExecution(exec) {
  return isMutationExecution(exec) || isBusinessDataMutationExecution(exec) || isUnknownSideEffectExecution(exec);
}

function isBusinessDataMutationExecution(exec) { return exec?.name === BUSINESS_DATA_APPLY_TOOL; }

function actionCeilingForPrompt(prompt) {
  if (typeof prompt !== 'string') return 'read-only';
  if (hasGlobalReadOnlyIntent(prompt)) return 'read-only';
  if (WRITE_INTENT.test(prompt)) return 'workspace-write';
  return 'read-only';
}

function promptAddsReadOnlyConstraint(prompt) {
  return hasGlobalReadOnlyIntent(prompt);
}

function isPlainControlledIntegrateReference(command) {
  return typeof command === 'string'
    && command.length <= CONTROLLED_RELEASE_COMMAND_MAX_LENGTH
    && !SHELL_COMPOSITION.test(command)
    && CONTROLLED_INTEGRATE_REFERENCE.test(command.trim());
}

function controlledIntegrateDiscoveryContract() {
  return 'Load or reload Skills forge-controlled-release and forge-taskspace-collaboration for the current supported integration flow, even when invokedSkills contains historical names. Read forge-release status once; it already includes fresh preflight taskspace, integration, sourceTransition and runner fields plus service status. The preflight references below mean this result; do not immediately call forge-release preflight again. Reuse this result within the same turn while candidate, canonical and integration state are unchanged; refresh status after actual edits, checkpoint, integrate, or a tool reports changed or stale state. Select the mode from current preflight.integration before considering whether canonical is included: conflict-open uses continue; source-saved-error with error.code TASKSPACE_INTEGRATION_DIRTY_LIMIT uses one recovery continue before any conflict edit, with a fresh release context already bound to the current saved HEAD and fingerprint; any other source-saved-error remains blocked. Use start only when no pending integration exists. Current source mapping for both modes: --expected-head = preflight.taskspace.head; --expected-fingerprint = preflight.taskspace.workspaceFingerprint; never use historical preflight.integration.to.head or preflight.integration.to.fingerprint. For start, --canonical-head = preflight.taskspace.canonicalHead. For continue, --canonical-head = preflight.integration.canonicalHead; retain this fixed pending target even if the project canonical has advanced. For start only, repeat --path once for every item in the complete preflight.taskspace.dirtyPaths list, or use zero --path flags when that list is empty. Exact start argv: forge-release integrate --mode start --expected-head <preflight.taskspace.head> --expected-fingerprint <preflight.taskspace.workspaceFingerprint> --canonical-head <preflight.taskspace.canonicalHead> [--path <dirtyPath-1> --path <dirtyPath-2> ...]. For continue only, repeat --path once for every item in current preflight.integration.conflictPaths; never pass the complete automatically merged dirty set. Exact continue argv: forge-release integrate --mode continue --operation-id <operationId> --expected-head <preflight.taskspace.head> --expected-fingerprint <preflight.taskspace.workspaceFingerprint> --canonical-head <preflight.integration.canonicalHead> --path <conflictPath-1> [--path <conflictPath-2> ...]. For continue, operationId must come from the current preflight.integration.operationId (the pending conflict integration) or the conflict-open result.operationId; never invent it. A continue result with recoveryOnly=true only restores the verified conflict-open baseline without editing or committing source and without a sourceTransition; resolve only its conflictPaths, run the required Host profile on the resulting fingerprint, then issue the ordinary continue from a fresh bound context.';
}

function normalizeProtectedExecutionContext(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('protected execution context is unavailable');
  }
  const protectedExecutionContextValidated = value.schemaVersion === PROTECTED_EXECUTION_SCHEMA_VERSION;
  if (protectedExecutionContextValidated) {
    validateProtectedExecutionContext(value, now);
  }
  const taskId = value.taskId;
  const executionId = value.executionId;
  const generation = value.generation;
  if (typeof taskId !== 'string' || !EXECUTION_ID.test(taskId)
    || typeof executionId !== 'string' || !EXECUTION_ID.test(executionId)
    || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('protected execution identity is invalid');
  }
  const contract = validateForgeTaskExecutionContract(value.contract);
  const expiresAtMs = value.expiresAt === undefined
    ? now + DEFAULT_EXECUTION_CONTEXT_TTL_MS
    : Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now
    || expiresAtMs - now > MAX_EXECUTION_CONTEXT_TTL_MS) {
    throw new Error('protected execution context lease is invalid');
  }
  return {
    taskId,
    executionId,
    generation,
    projectSlug: typeof value.projectSlug === 'string' ? value.projectSlug : undefined,
    actorUserId: typeof value.actorUserId === 'string' ? value.actorUserId : undefined,
    actorUsername: value.actorUsername,
    claimId: value.claimId,
    conversationId: typeof value.conversationId === 'string' ? value.conversationId : undefined,
    dshSessionId: typeof value.dshSessionId === 'string' ? value.dshSessionId : undefined,
    rpcId: typeof value.rpcId === 'string' ? value.rpcId : undefined,
    textDigest: typeof value.textDigest === 'string' ? value.textDigest : undefined,
    authorityClass: value.authorityClass,
    testOnly: value.testOnly,
    sourceCommit: value.sourceCommit,
    workspaceFingerprint: value.workspaceFingerprint,
    productionAuthorityDigest: value.productionAuthorityDigest,
    controllerGrantDigest: value.controllerGrantDigest,
    previousCompletion: value.previousCompletion,
    caseFamily: value.caseFamily,
    workflowId: value.workflowId,
    phaseId: value.phaseId,
    phaseIndex: value.phaseIndex,
    phaseCatalogVersion: value.phaseCatalogVersion,
    phaseCatalogDigest: value.phaseCatalogDigest,
    crossLayerPreparation: value.crossLayerPreparation,
    preparationBinding: value.preparationBinding,
    protectedExecutionContextValidated,
    contract,
    issuedAt: typeof value.issuedAt === 'string' ? value.issuedAt : undefined,
    expiresAt: new Date(expiresAtMs).toISOString(),
    key: `${taskId}\0${executionId}\0${contract.contractId}\0${generation}`,
  };
}

function bindProtectedExecutionContext(
  state,
  context,
  testShadowCandidateWriteRequested = false,
  testShadowVerificationRunnerRevision,
) {
  state.executionContextStatus = 'ready';
  state.executionIdentity = {
    taskId: context.taskId,
    executionId: context.executionId,
    contractId: context.contract.contractId,
  };
  state.executionContextGeneration = context.generation;
  state.executionProjectSlug = context.projectSlug;
  state.executionActorUserId = context.actorUserId;
  state.executionActorUsername = context.actorUsername;
  state.executionClaimId = context.claimId;
  state.executionConversationId = context.conversationId;
  state.executionDshSessionId = context.dshSessionId;
  state.executionRpcId = context.rpcId;
  state.executionTextDigest = context.textDigest;
  state.executionContextIssuedAt = context.issuedAt;
  state.executionContextExpiresAt = context.expiresAt;
  state.executionAuthorityClass = context.authorityClass;
  state.protectedExecutionContextValidated = context.protectedExecutionContextValidated === true;
  state.executionTestOnly = context.testOnly === true;
  state.executionSourceCommit = context.sourceCommit;
  state.executionWorkspaceFingerprint = context.workspaceFingerprint;
  state.executionProductionAuthorityDigest = context.productionAuthorityDigest;
  state.executionControllerGrantDigest = context.controllerGrantDigest;
  state.previousCompletion = context.previousCompletion;
  state.executionCaseFamily = context.caseFamily;
  state.executionWorkflowId = context.workflowId;
  state.executionPhaseId = context.phaseId;
  state.executionPhaseIndex = context.phaseIndex;
  state.executionPhaseCatalogVersion = context.phaseCatalogVersion;
  state.executionPhaseCatalogDigest = context.phaseCatalogDigest;
  state.executionCrossLayerPreparation = context.crossLayerPreparation === true;
  state.executionPreparationBinding = context.preparationBinding;
  state.testShadowCandidateWriteRequested = testShadowCandidateWriteRequested === true
    && context.protectedExecutionContextValidated === true
    && context.authorityClass === 'test-shadow-writer'
    && context.testOnly === true
    && typeof context.sourceCommit === 'string'
    && typeof context.caseFamily === 'string'
    && typeof testShadowVerificationRunnerRevision === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(testShadowVerificationRunnerRevision);
  state.testShadowVerificationRunnerRevision = state.testShadowCandidateWriteRequested
    ? testShadowVerificationRunnerRevision : undefined;
  state.taskContract = context.contract;
  state.taskIntent = context.contract;
  state.actionCeiling = context.contract.actionCeiling;
  state.actionCeilingLocked = true;
  state.tddRequired = state.tddRequired || context.contract.tddRequired;
  return state;
}

function projectionRoutingSkills(contract) {
  return [...contract.requiredSkills]
    .filter((skill) => skill !== 'forge-evidence-truth')
    .sort();
}

function draftBeforeVerification(state) {
  return state?.suspendHeuristicStops && productionWriterContextCurrent(state)
    && state.executionWorkflowId === null && ['workspace-write', 'git-checkpoint', 'release'].includes(state.actionCeiling)
    && !state.promptReadOnlyConstraint;
}

function projectionInitialStateInput(state) {
  const admission = state.verificationAdmission?.receipt;
  const readyAdmission = admission?.outcome === 'ready' ? admission : undefined;
  const projectSlug = readyAdmission?.projectSlug ?? state.executionProjectSlug;
  const createdAt = readyAdmission?.issuedAt ?? state.executionContextIssuedAt;
  const sourceFingerprint = readyAdmission?.source?.workspaceFingerprint
    ?? (draftBeforeVerification(state) ? state.executionWorkspaceFingerprint : undefined)
    ?? (state.actionCeiling === 'read-only' ? state.taskContract?.sourceFingerprint : undefined);
  if (!state.executionIdentity || !state.taskContract
    || !Number.isSafeInteger(state.executionContextGeneration)
    || state.executionContextGeneration < 1
    || typeof projectSlug !== 'string'
    || typeof createdAt !== 'string'
    || typeof sourceFingerprint !== 'string') return undefined;
  const requiredSkills = state.suspendHeuristicStops ? [] : projectionRoutingSkills(state.taskContract);
  const requiredProfiles = requiredVerificationProfiles(state.taskContract, state);
  const redProfiles = [...state.taskContract.requiredRedProfiles].sort();
  return {
    executionId: state.executionIdentity.executionId,
    projectSlug,
    taskId: state.executionIdentity.taskId,
    contractId: state.taskContract.contractId,
    registryDigest: executionSha256({
      contractId: state.taskContract.contractId,
      requiredSkills,
      requiredProfiles,
      redProfiles,
      criteria: [...state.taskContract.requiredObligations].sort(),
    }),
    actionCeiling: state.actionCeiling,
    // The signed contract still describes the historical requirements. Runtime
    // workflow suspension changes drafting order, never the final test evidence.
    tddRequired: !state.suspendHeuristicStops && state.tddRequired,
    draftBeforeVerification: draftBeforeVerification(state),
    requiredSkills,
    requiredProfiles,
    redProfiles,
    criteria: [...state.taskContract.requiredObligations].sort(),
    sourceFingerprint,
    createdAt,
  };
}

function projectionEventId(state, operation, payload) {
  return `phase-${executionSha256({
    executionId: state.executionIdentity.executionId,
    generation: state.executionContextGeneration,
    operation,
    payload,
  }).replace(/^sha256:/u, '').slice(0, 56)}`;
}

function projectionCheckpointPayload(state, reason) {
  const admission = state.verificationAdmission;
  return {
    stage: 'phase-guard-runtime',
    result: {
      reason,
      legacyPhase: state.phase,
      currentStep: state.currentStep,
      maxSteps: state.maxSteps,
      sequence: state.sequence,
      mutationCount: state.mutationCount,
      mutationAttemptCount: state.mutationAttemptCount,
      dependencyFailureCount: state.dependencyFailureCount,
      verificationBlocked: state.verificationBlocked,
      auditSucceeded: state.auditSucceeded,
      invokedSkills: [...state.invokedSkills].sort(),
      progressDecision: state.progressDecision ? {
        decision: state.progressDecision.decision,
        reasonCodes: [...state.progressDecision.reasonCodes],
      } : null,
      closeoutBlockers: closeoutBlockers(state),
      admission: admission ? {
        outcome: admission.outcome,
        admissionId: admission.admissionId ?? null,
        profiles: [...(admission.profiles ?? [])].sort(),
        reasonCode: admission.reasonCode ?? null,
        expiresAt: admission.expiresAt ?? null,
      } : null,
      redGateEvidence: state.redGateEvidence ? { ...state.redGateEvidence } : null,
      redGateAdapterRejection: state.redGateAdapterRejection ?? null,
      staleCreate: state.staleCreate ? { ...state.staleCreate } : null,
    },
  };
}

async function appendProjectionOperation(state, method, payload, observedAt) {
  const current = state.executionProjectionSnapshot;
  const eventId = projectionEventId(state, method, payload);
  state.executionProjectionSnapshot = await state.executionProjectionStore[method]({
    executionId: state.executionIdentity.executionId,
    expectedGeneration: state.executionContextGeneration,
    expectedRevision: current.revision,
    eventId,
    payload,
    recordedAt: observedAt,
  });
}

async function projectPhaseGuardStateNow(state, reason, now) {
  if (directDevelopmentEnabled(state?.taskContract)) return state;
  if (!state?.executionProjectionRequired) return state;
  const initialStateInput = projectionInitialStateInput(state);
  if (!initialStateInput) {
    state.executionProjectionStatus = 'pending';
    state.executionProjectionErrorCode = 'EXECUTION_PROJECTION_INPUT_PENDING';
    return state;
  }
  const observedAt = new Date(now).toISOString();
  if (!state.executionProjectionSnapshot) {
    state.executionProjectionSnapshot = await state.executionProjectionStore.create({
      generation: state.executionContextGeneration,
      initialStateInput,
    });
  }
  let reducerState = state.executionProjectionSnapshot.state;
  const routingComplete = reducerState.requiredSkills.every((skill) => state.invokedSkills.has(skill));
  if (reducerState.phase === 'ADMIT' && routingComplete) {
    const payload = {
      type: 'route.completed',
      observedSkills: [...reducerState.requiredSkills],
      observedAt,
    };
    await appendProjectionOperation(state, 'appendTransition', payload, observedAt);
    reducerState = state.executionProjectionSnapshot.state;
  }
  if (reducerState.phase === 'ROUTE') {
    const payload = { type: 'preflight.started', observedAt };
    await appendProjectionOperation(state, 'appendTransition', payload, observedAt);
    reducerState = state.executionProjectionSnapshot.state;
  }
  const admissionReceipt = state.verificationAdmission?.receipt;
  if (reducerState.phase === 'PREFLIGHT' && admissionReceipt?.outcome === 'ready'
    && admissionCurrent(state.verificationAdmission, reducerState.admissionProfiles, now)) {
    const payload = { type: 'preflight.completed', receipt: admissionReceipt, observedAt };
    await appendProjectionOperation(state, 'appendTransition', payload, observedAt);
  } else if (reducerState.phase === 'PREFLIGHT' && draftBeforeVerification(state)) {
    await appendProjectionOperation(state, 'appendTransition', { type: 'draft.started', observedAt }, observedAt);
  }
  const checkpoint = projectionCheckpointPayload(state, reason);
  await appendProjectionOperation(state, 'appendCheckpoint', checkpoint, observedAt);
  state.executionProjectionStatus = 'ready';
  state.executionProjectionErrorCode = undefined;
  return state;
}

function queueExecutionProjection(state, operation) {
  if (!state?.executionProjectionRequired) return state;
  const run = async () => {
    try {
      return await operation();
    } catch (error) {
      state.executionProjectionStatus = 'failed';
      state.executionProjectionErrorCode = typeof error?.code === 'string'
        ? error.code : 'EXECUTION_PROJECTION_FAILED';
      return state;
    }
  };
  state.executionProjectionTail = state.executionProjectionTail.then(run, run);
  return state.executionProjectionTail;
}

export async function projectPhaseGuardState(state, reason = 'runtime', now = Date.now()) {
  if (!state?.executionProjectionRequired) return state;
  return queueExecutionProjection(state, () => projectPhaseGuardStateNow(state, reason, now));
}

function projectionIncrementId(state) {
  return `inc-${executionSha256({
    executionId: state.executionIdentity.executionId,
    generation: state.executionContextGeneration,
    contractId: state.taskContract.contractId,
  }).replace(/^sha256:/u, '').slice(0, 48)}`;
}

function projectionReservationId(state, exec) {
  return `mut-${executionSha256({
    executionId: state.executionIdentity.executionId,
    generation: state.executionContextGeneration,
    callId: exec.callId,
    shape: writerAttemptShape(exec),
  }).replace(/^sha256:/u, '').slice(0, 48)}`;
}

async function prepareProjectedMutationNow(state, exec, now) {
  if (!state.executionProjectionRequired || !isMutationExecution(exec)) return state;
  let reducerState = state.executionProjectionSnapshot?.state;
  if (!reducerState) throw Object.assign(new Error('Execution projection state is missing.'), {
    code: 'EXECUTION_PROJECTION_NOT_READY',
  });
  const observedAt = new Date(now).toISOString();
  if (reducerState.phase === 'DISCOVER') {
    if (reducerState.tddRequired && !isTestMutation(exec)) {
      state.executionProjectionErrorCode = 'EXECUTION_RED_RECEIPT_REQUIRED';
      return state;
    }
    const payload = {
      type: 'discovery.completed',
      incrementId: projectionIncrementId(state),
      criteria: [...reducerState.openCriteria],
      ownedPaths: [...state.taskContract.ownedPaths],
      verificationProfiles: [...reducerState.requiredProfiles],
      observedAt,
    };
    await appendProjectionOperation(state, 'appendTransition', payload, observedAt);
    reducerState = state.executionProjectionSnapshot.state;
  }
  if (reducerState.phase === 'RED_GATE' && !isTestMutation(exec)) {
    state.executionProjectionErrorCode = 'EXECUTION_RED_RECEIPT_REQUIRED';
    return state;
  }
  if (!['RED_GATE', 'IMPLEMENT_INCREMENT', 'REPAIR'].includes(reducerState.phase)) {
    state.executionProjectionStatus = 'failed';
    state.executionProjectionErrorCode = 'EXECUTION_MUTATION_PHASE_INVALID';
    return state;
  }
  const reservationId = projectionReservationId(state, exec);
  const payload = { reservationId, dimension: 'mutations', amount: 1, observedAt };
  await appendProjectionOperation(state, 'appendBudgetReserve', payload, observedAt);
  reducerState = state.executionProjectionSnapshot.state;
  if (reducerState.terminalOutcome !== null) {
    state.executionProjectionStatus = 'stopped';
    state.executionProjectionErrorCode = reducerState.failure?.code ?? 'EXECUTION_BUDGET_EXHAUSTED';
    return state;
  }
  state.executionProjectionWriterReservations.set(exec.callId, reservationId);
  state.executionProjectionStatus = 'ready';
  state.executionProjectionErrorCode = undefined;
  return state;
}

async function prepareProjectedMutation(state, exec, now = Date.now()) {
  if (directDevelopmentEnabled(state?.taskContract)) return state;
  if (!state?.executionProjectionRequired || !isMutationExecution(exec)) return state;
  return queueExecutionProjection(state, () => prepareProjectedMutationNow(state, exec, now));
}

async function settleProjectedMutationNow(state, exec, succeeded, now) {
  const reservationId = state.executionProjectionWriterReservations.get(exec.callId);
  if (!reservationId) return state;
  const observedAt = new Date(now).toISOString();
  await appendProjectionOperation(
    state,
    succeeded ? 'appendBudgetCommit' : 'appendBudgetRelease',
    { reservationId },
    observedAt,
  );
  state.executionProjectionWriterReservations.delete(exec.callId);
  state.executionProjectionStatus = 'ready';
  state.executionProjectionErrorCode = undefined;
  return state;
}

async function settleProjectedMutation(state, exec, succeeded, now = Date.now()) {
  if (directDevelopmentEnabled(state?.taskContract)) return state;
  if (!state?.executionProjectionRequired || !isMutationExecution(exec)) return state;
  return queueExecutionProjection(state, () => settleProjectedMutationNow(state, exec, succeeded, now));
}

function exactStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function adaptVerifyRunToRedGateReceipt(state, exec, result) {
  const controlled = exec?.name === 'bash'
    ? controlledEvidenceReceipt(commandOf(exec), resultText(result)) : null;
  const command = controlled?.command;
  const receipt = controlled?.receipt;
  const reducerState = state?.executionProjectionSnapshot?.state;
  const selectedTests = command?.options?.['--test'];
  const selectedTestFiles = command?.options?.['--test-file'];
  const selectedModules = command?.options?.['--module'] ?? [];
  const redProfile = command?.options?.['--profile'];
  const selectedTargets = redProfile === 'frontend-red-test' ? selectedTestFiles : selectedTests;
  const results = receipt?.results;
  const steps = receipt?.execution?.steps;
  const truth = receipt?.truth;
  const redExpectation = receipt?.redExpectation;
  const containerRun = receipt?.schemaVersion === 1 && receipt?.receiptType === 'forge-verify/run';
  const hostRun = receipt?.schemaVersion === 2 && receipt?.receiptType === 'forge-verify/host-run';
  const requirements = {
    controlledRun: command?.executable === 'forge-verify' && command.action === 'run',
    testProfile: RED_TEST_PROFILES.has(redProfile),
    selectedTests: Array.isArray(selectedTargets) && selectedTargets.length === 1,
    failedRun: (containerRun || hostRun) && receipt.status === 'failed',
    identity: receipt?.projectSlug === reducerState?.projectSlug && receipt?.taskId === reducerState?.taskId,
    source: receipt?.source?.workspaceFingerprint === reducerState?.sourceFingerprint,
    admission: receipt?.request?.admissionId === reducerState?.admission?.admissionId,
    admissionProfile: reducerState?.admission?.profiles?.includes(command?.options?.['--profile']) === true,
    profile: receipt?.request?.profile === redProfile,
    testSelectors: redProfile === 'frontend-red-test'
      ? exactStringArray(receipt?.request?.selectors?.testFiles, selectedTestFiles)
      : exactStringArray(receipt?.request?.selectors?.tests, selectedTests),
    moduleSelectors: exactStringArray(receipt?.request?.selectors?.modules ?? [], selectedModules),
    testCounts: nonnegativeInteger(results?.executed) && results.executed >= 1
      && nonnegativeInteger(results?.failed) && results.failed >= 1
      && nonnegativeInteger(results?.passed) && nonnegativeInteger(results?.skipped)
      && results.passed + results.failed + results.skipped === results.executed,
    reports: Number.isSafeInteger(results?.reportFiles) && results.reportFiles >= 1
      && results.zeroTestsRejected === false,
    truth: truth?.executionProven === true && truth.verificationProven === false
      && truth.semanticCorrectnessProven === false && truth.databaseIntegrationProven === false
      && truth.releaseProven === false,
    isolated: containerRun ? receipt?.execution?.externalEgress === false
      : hostRun
        && receipt?.isolation?.mode === 'host-toolchain-isolated-taskspace'
        && receipt.isolation.globalUserConfigRead === false
        && receipt.isolation.arbitraryShell === false
        && receipt.isolation.requestControlledEnvironment === false
        && receipt.isolation.cleanupProven === true,
    steps: Array.isArray(steps) && steps.length > 0
      && steps.every((step) => step?.timedOut === false && step?.transportUncertain === false
        && step?.signal === null && step?.cleanup?.proven === true
        && (!hostRun || step?.processEnded === true))
      && steps.some((step) => Number.isSafeInteger(step?.exitCode) && step.exitCode !== 0),
    freshness: receipt?.freshness === undefined || receipt.freshness === 'current',
    redExpectation: redExpectation?.schemaVersion === 1
      && redExpectation.expectationType === 'selected-test-must-fail'
      && redExpectation.profile === redProfile
      && redExpectation.selectorsSha256 === receipt?.request?.selectorsSha256
      && redExpectation.matched === true
      && redExpectation.failureKind === 'test-report',
  };
  const rejected = Object.entries(requirements).find(([, satisfied]) => !satisfied)?.[0];
  if (rejected) {
    if (state) state.redGateAdapterRejection = `RED_ADAPTER_${rejected.replace(/([a-z])([A-Z])/gu, '$1_$2').toUpperCase()}`;
    return null;
  }
  state.redGateAdapterRejection = undefined;
  const sourceReceiptDigest = executionSha256(receipt);
  return {
    receipt: sealExecutionReceipt({
      receiptType: 'forge-execution/red-gate/v1',
      receiptId: receipt.receiptId,
      sourceFingerprint: reducerState.sourceFingerprint,
      sourceReceiptDigest,
      executedTests: results.executed,
      expectedFailureMatched: true,
      infrastructureFailure: false,
    }),
    sourceReceiptId: receipt.receiptId,
    sourceReceiptDigest,
  };
}

async function projectTypedRedReceiptNow(state, exec, result, now) {
  if (state.executionProjectionSnapshot?.state?.phase !== 'RED_GATE') return state;
  const adapted = adaptVerifyRunToRedGateReceipt(state, exec, result);
  if (!adapted) return state;
  const observedAt = new Date(now).toISOString();
  await appendProjectionOperation(state, 'appendTransition', {
    type: 'red.completed', receipt: adapted.receipt, observedAt,
  }, observedAt);
  state.redGateEvidence = {
    sourceReceiptId: adapted.sourceReceiptId,
    sourceReceiptDigest: adapted.sourceReceiptDigest,
    executedTests: adapted.receipt.executedTests,
  };
  state.executionProjectionStatus = 'ready';
  state.executionProjectionErrorCode = undefined;
  return state;
}

async function projectTypedRedReceipt(state, exec, result, now = Date.now()) {
  if (!state?.executionProjectionRequired) return state;
  return queueExecutionProjection(state, () => projectTypedRedReceiptNow(state, exec, result, now));
}

function normalizedArguments(exec) {
  const value = exec?.arguments;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function commandOf(exec) {
  if (exec?.name !== 'bash') return '';
  const command = normalizedArguments(exec).command;
  return typeof command === 'string' ? command : '';
}

function commandForMutationClassification(exec) {
  return commandOf(exec)
    .replace(/\b\d*>\s*(?:\/dev\/null|&\d+)\b/gu, '')
    .replace(/\b\d*<\s*\/dev\/null\b/gu, '');
}

function hasUnquotedOutputRedirection(command) {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '>' && command[index + 1] !== '&') return true;
  }
  return false;
}

function mutationPath(exec) {
  const args = normalizedArguments(exec);
  if (exec?.name === 'copy_file') {
    if (!hasExactKeys(args, ['file_path', 'source_path', 'source_sha256'])) return '';
    return typeof args.file_path === 'string' ? args.file_path : '';
  }
  if (exec?.name === 'remove_file') {
    if (!hasExactKeys(args, ['file_path'])) return '';
    return typeof args.file_path === 'string' ? args.file_path : '';
  }
  const supplied = ['path', 'file_path', 'file']
    .filter((name) => Object.hasOwn(args, name));
  if (supplied.length !== 1) return '';
  const value = args[supplied[0]];
  return typeof value === 'string' ? value : '';
}

function contractPathFromMutation(exec) {
  const raw = mutationPath(exec);
  if (!raw || raw.length > 1024 || raw !== raw.trim() || raw.includes('\0')
    || raw.includes('\\') || /[\u0000-\u001f\u007f]/u.test(raw)) return '';
  let value = raw.normalize('NFC');
  if (value.startsWith('/workspace/')) value = value.slice('/workspace/'.length);
  else if (value.startsWith('./')) value = value.slice(2);
  if (!value || value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.includes(':')) return '';
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return '';
  return value;
}

function candidateTaskContract(state, exec) {
  if (!state || state.executionContextStatus !== 'ready' || !state.taskContract
    || !isSourceMutation(exec) || exec?.name === 'bash') return undefined;
  const relativePath = contractPathFromMutation(exec);
  if (!relativePath) return undefined;
  if (directDevelopmentEnabled(state.taskContract)) return directDevelopmentPath(relativePath) ? state.taskContract : undefined;
  const owned = state.taskContract.ownedPaths.some((entry) => isForgeTaskOwnedPath(relativePath, entry));
  return owned ? state.taskContract : undefined;
}

function requestedSkill(exec) {
  if (exec?.name !== 'skill') return '';
  const args = normalizedArguments(exec);
  const value = args.skill ?? args.name;
  return typeof value === 'string' ? value : '';
}

function isMutationExecution(exec) {
  if (exec?.name === 'browser') return !BROWSER_READ_ACTIONS.has(normalizedArguments(exec).action);
  if (MUTATION_TOOLS.has(exec?.name)) return true;
  if (exec?.name === 'str_replace_editor') return normalizedArguments(exec).command !== 'view';
  if (exec?.name !== 'bash') return false;
  if (process.env.FORGE_DEVELOPMENT_MODE === 'direct') {
    const raw = commandOf(exec);
    if (!parseControlledEvidenceCommand(raw) && !parseControlledVerificationInspectionCommand(raw)
      && !parseControlledReleaseInspectionCommand(raw) && !parseControlledReleaseMutationCommand(raw)
      && !parseControlledReleasePreparationCommand(raw) && !parseControlledGovernanceInspectionCommand(raw)
      && !parseControlledDeliveryCommand(raw)) return true;
  }
  const command = commandForMutationClassification(exec);
  return SHELL_MUTATION.test(command) || hasUnquotedOutputRedirection(command);
}

function isSourceMutation(exec) {
  if (!isMutationExecution(exec)) return false;
  if (exec?.name === 'bash') return true;
  const path = mutationPath(exec);
  return isForgeChangeRecordPath(contractPathFromMutation(exec))
    || contractPathFromMutation(exec) === 'docker-forge-admin/Dockerfile.admin'
    || /(?:^|\/)(?:src\/|migrations?\/)|\.(?:java|kt|kts|groovy|xml|sql|js|jsx|ts|tsx|vue|svelte|css|scss|less|html|json|ya?ml|toml|properties|gradle|cs|go|rs|py|rb|php)$/iu.test(path);
}

function isTestMutation(exec) {
  if (!isSourceMutation(exec) || exec?.name === 'bash') return false;
  return /(?:^|\/)(?:src\/test|tests?|__tests__)(?:\/|$)|(?:\.spec|\.test)\.[^/]+$/iu.test(mutationPath(exec));
}

function isProductionSourceMutation(exec) {
  return isSourceMutation(exec)
    && !isTestMutation(exec)
    && !isForgeChangeRecordPath(contractPathFromMutation(exec));
}

function isReadExecution(exec) {
  if (exec?.name === 'browser') return BROWSER_READ_ACTIONS.has(normalizedArguments(exec).action);
  if (READ_TOOLS.has(exec?.name)) return true;
  if (exec?.name === 'str_replace_editor') return !isMutationExecution(exec);
  return exec?.name === 'bash'
    && !isMutationExecution(exec)
    && parseControlledDeliveryCommand(commandOf(exec))?.mutation !== true
    && parseControlledReleasePreparationCommand(commandOf(exec)) === null
    && parseControlledReleaseMutationCommand(commandOf(exec)) === null;
}

function isDependencyExecution(exec) {
  return exec?.name === 'bash' && DEPENDENCY_COMMAND.test(commandOf(exec));
}

function isVerificationExecution(exec) {
  return exec?.name === 'bash'
    && (parseControlledEvidenceCommand(commandOf(exec)) !== null || VERIFICATION_COMMAND.test(commandOf(exec)));
}

function isGovernanceExecution(exec) {
  return exec?.name === 'bash'
    && parseControlledEvidenceCommand(commandOf(exec))?.family === 'governance';
}

function verificationFamily(exec) {
  if (!isVerificationExecution(exec)) return '';
  const command = commandOf(exec);
  const controlled = parseControlledEvidenceCommand(command);
  if (controlled?.family === 'governance') return 'governance';
  if (controlled?.family.startsWith('forge-verify-')) return controlled.family;
  if (/\b(?:mvn|mvnw|gradle|gradlew)\b/iu.test(command)) return 'backend';
  if (/\b(?:pnpm|npm|yarn|vitest|jest|playwright)\b/iu.test(command)) return 'frontend';
  return 'verification';
}

function productionTaskWriterState(state) {
  return state?.executionContextStatus === 'ready'
    && state.protectedExecutionContextValidated === true
    && state.executionAuthorityClass === 'production-task-writer'
    && state.executionTestOnly === false;
}

function requiredVerificationProfiles(contract, state) {
  if (!contract) return [];
  const includeGovernance = productionTaskWriterState(state)
    && contract.requiredVerificationProfiles.includes('governance');
  return contract.requiredVerificationProfiles
    .filter((profile) => includeGovernance || profile !== 'governance')
    .sort();
}

function requiredExecutionProfiles(contract, state) {
  if (!contract) return [];
  const profiles = new Set([
    ...requiredVerificationProfiles(contract, state),
    ...contract.requiredRedProfiles,
  ]);
  // The backend delivery phase requires compilation as a Host receipt even
  // though the task contract's final verification profile is the module test.
  if (productionTaskWriterState(state) && state.actionCeiling === 'workspace-write'
    && state.executionWorkflowId === 'crud-production'
    && state.executionPhaseId === 'backend' && state.executionPhaseIndex === 4
    && profiles.has('backend-module-test')) {
    profiles.add('backend-module-compile');
  }
  // Permit focused diagnostics during ordinary implementation without adding
  // another required acceptance check to the signed contract.
  if (state?.suspendHeuristicStops && productionTaskWriterState(state)
    && state.executionWorkflowId === null && profiles.has('backend-module-test')) {
    profiles.add('backend-module-compile');
    profiles.add('backend-test-class');
  }
  const order = [
    'governance',
    'backend-red-test', 'frontend-red-test',
    'backend-module-compile', 'backend-module-test', 'backend-test-class',
    'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build',
    'frontend-h5-test', 'frontend-h5-build', 'changed-safe', 'full-regression',
  ];
  return order.filter((profile) => profiles.has(profile));
}

function sameOrderedValues(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((value, index) => value === sortedRight[index]);
}

function hasExactKeys(value, expectedKeys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && sameOrderedValues(Object.keys(value), expectedKeys);
}

function admissionCommand(profiles) {
  return `forge-verify admit ${profiles.map((profile) => `--profile ${profile}`).join(' ')}`.trim();
}

function admissionCurrent(admission, profiles, now = Date.now()) {
  return admission?.outcome === 'ready'
    && typeof admission.admissionId === 'string'
    && sameOrderedValues(admission.profiles, profiles)
    && typeof admission.expiresAt === 'string'
    && Date.parse(admission.expiresAt) > now;
}

function candidateWriteAdmissionCurrent(state) {
  const admission = state?.verificationAdmission;
  const receipt = admission?.receipt;
  const requiredProfiles = requiredExecutionProfiles(state?.taskContract, state);
  const falseProofs = [
    receipt?.executor?.proven,
    receipt?.executor?.dockerApiProven,
    receipt?.executor?.toolchainImageProven,
    receipt?.executor?.samePathBindProven,
    receipt?.executor?.stateWriteProven,
    receipt?.executor?.cleanupProven,
    receipt?.truth?.executionProven,
    receipt?.truth?.verificationProven,
    receipt?.truth?.semanticCorrectnessProven,
    receipt?.truth?.databaseIntegrationProven,
    receipt?.truth?.releaseProven,
  ];
  return state?.testShadowCandidateWriteRequested === true
    && state.protectedExecutionContextValidated === true
    && state.executionAuthorityClass === 'test-shadow-writer'
    && state.executionTestOnly === true
    && state.actionCeiling === 'workspace-write'
    && typeof state.executionSourceCommit === 'string'
    && typeof state.executionCaseFamily === 'string'
    && typeof state.testShadowVerificationRunnerRevision === 'string'
    && state.verificationBlocked === true
    && hasExactKeys(admission, ['sequence', 'outcome', 'profiles', 'reasonCode', 'receipt'])
    && Number.isSafeInteger(admission.sequence) && admission.sequence >= 0
    && admission?.outcome === 'cache_miss'
    && admission.reasonCode === 'VERIFY_CACHE_MISS'
    && sameOrderedValues(admission.profiles, requiredProfiles)
    && hasExactKeys(receipt, [
      'schemaVersion', 'receiptType', 'admissionId', 'projectSlug', 'taskId', 'runner',
      'profiles', 'source', 'cache', 'executor', 'issuedAt', 'expiresAt', 'outcome',
      'reasonCode', 'truth',
    ])
    && receipt.schemaVersion === 1
    && receipt.receiptType === 'forge-verify/execution-admission'
    && receipt?.outcome === 'cache_miss'
    && receipt.reasonCode === 'VERIFY_CACHE_MISS'
    && receipt.admissionId === null
    && receipt.projectSlug === state.executionProjectSlug
    && receipt.taskId === state.executionIdentity?.taskId
    && hasExactKeys(receipt.runner, ['bootId', 'revision'])
    && UUID.test(receipt.runner.bootId)
    && receipt.runner.revision === state.testShadowVerificationRunnerRevision
    && hasExactKeys(receipt.source, ['head', 'workspaceFingerprint', 'dependencyManifestFingerprint'])
    && receipt.source?.head === state.executionSourceCommit
    && /^[0-9a-f]{64}$/u.test(receipt.source.workspaceFingerprint)
    && /^[0-9a-f]{64}$/u.test(receipt.source.dependencyManifestFingerprint)
    && sameOrderedValues(receipt.profiles, requiredProfiles)
    && hasExactKeys(receipt.cache, ['mode', 'compatible'])
    && receipt.cache?.mode === 'project-scoped-immutable-pack'
    && receipt.cache?.compatible === false
    && hasExactKeys(receipt.executor, [
      'proven', 'dockerApiProven', 'toolchainImageProven', 'samePathBindProven',
      'stateWriteProven', 'cleanupProven',
    ])
    && hasExactKeys(receipt.truth, [
      'executionProven', 'verificationProven', 'semanticCorrectnessProven',
      'databaseIntegrationProven', 'releaseProven',
    ])
    && receipt.issuedAt === null
    && receipt.expiresAt === null
    && falseProofs.every((value) => value === false);
}

function brokerAdmissionCommand(profiles) {
  return admissionCommand(profiles);
}

export function createBrokerAdmissionClient({
  brokerUrl = process.env.FORGE_TASKSPACE_BROKER_URL,
  tokenFile = process.env.FORGE_TASKSPACE_TOKEN_FILE,
  timeoutMs = 15_000,
} = {}) {
  if (typeof brokerUrl !== 'string' || typeof tokenFile !== 'string') return undefined;
  const endpoint = new URL(brokerUrl);
  if (endpoint.protocol !== 'http:'
    || (!['taskspace-broker', 'taskspace-broker-stable', 'taskspace-broker-enhanced', '127.0.0.1', 'localhost'].includes(endpoint.hostname)
      && !/^taskspace-broker-(?:stable|enhanced)-r[1-9][0-9]{0,5}$/u.test(endpoint.hostname))
    || endpoint.username || endpoint.password || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
    throw new Error('FORGE_TASKSPACE_BROKER_URL must name the fixed internal Broker endpoint.');
  }
  if (!tokenFile.startsWith('/run/forge-taskspace/') || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new Error('Broker admission client configuration is invalid.');
  }
  return async (profiles) => {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (token.length < 32 || token.length > 256) throw new Error('TaskSpace verification capability token is invalid.');
    const payload = Buffer.from(JSON.stringify({ action: 'verify-admit', profiles }));
    const result = await new Promise((resolve, reject) => {
      const request = http.request({
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: '/v1/actions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          'x-forge-taskspace-token': token,
        },
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) response.destroy(new Error('Verification admission response exceeded its limit.'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if ((response.statusCode ?? 500) >= 400 || document.ok !== true) {
              reject(new Error(`${document.error?.code ?? 'VERIFY_ADMISSION_FAILED'}: ${document.error?.message ?? 'Admission failed.'}`));
            } else resolve(document.result);
          } catch (error) { reject(error); }
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error('VERIFY_ADMISSION_TIMEOUT: internal Broker admission timed out.')));
      request.once('error', reject);
      request.end(payload);
    });
    const command = brokerAdmissionCommand(profiles);
    const controlled = controlledEvidenceReceipt(command, JSON.stringify(result));
    if (controlled?.command?.action !== 'admit') throw new Error('VERIFY_ADMISSION_INVALID: Broker returned an invalid admission receipt.');
    return controlled.receipt;
  };
}

export function createBrokerExecutionContextResolver({
  brokerUrl = process.env.FORGE_TASKSPACE_BROKER_URL,
  tokenFile = process.env.FORGE_TASKSPACE_TOKEN_FILE,
  projectSlug = process.env.PROJECT_SLUG,
  taskId = process.env.FORGE_TASKSPACE_ID,
  conversationId = process.env.FORGE_TASKSPACE_CONVERSATION_ID,
  actorUserId = process.env.FORGE_TASKSPACE_ACTOR_USER_ID,
  timeoutMs = 5000,
  sourceTransitionTimeoutMs = 60_000,
} = {}) {
  if ([brokerUrl, tokenFile, projectSlug, taskId, conversationId, actorUserId]
    .some((value) => typeof value !== 'string' || value.length === 0)) return undefined;
  const endpoint = new URL(brokerUrl);
  if (endpoint.protocol !== 'http:'
    || (!['taskspace-broker', 'taskspace-broker-stable', 'taskspace-broker-enhanced', '127.0.0.1', 'localhost'].includes(endpoint.hostname)
      && !/^taskspace-broker-(?:stable|enhanced)-r[1-9][0-9]{0,5}$/u.test(endpoint.hostname))
    || endpoint.username || endpoint.password || (endpoint.pathname !== '/' && endpoint.pathname !== '')
    || !tokenFile.startsWith('/run/forge-taskspace/')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000
    || !Number.isSafeInteger(sourceTransitionTimeoutMs) || sourceTransitionTimeoutMs < timeoutMs
    || sourceTransitionTimeoutMs > 60_000) {
    throw new Error('Broker execution-context resolver configuration is invalid.');
  }
  const currentLookups = new WeakMap();
  return async ({ agent, decision, sourceTransition = null, renewal = null }) => {
    const direct = Array.isArray(decision?.messages)
      ? decision.messages.filter((message) => message?.source?.kind === 'user') : [];
    if (!agent || typeof agent.session?.id !== 'string') return undefined;
    let lookup = currentLookups.get(agent);
    if (direct.length > 0) {
      currentLookups.delete(agent);
      if (direct.length !== 1 || typeof direct[0].source?.rpcId !== 'string') return undefined;
      try {
        const content = direct[0].content;
        if (!Array.isArray(content) || content.some((part) => !['text', 'image'].includes(part?.type))) return undefined;
        const text = content.filter((part) => part.type === 'text');
        if (!text.some((part) => typeof part.text === 'string' && part.text.trim())) return undefined;
        // Match the Manager's direct-text digest. Attached images remain bound
        // by the authenticated request body and are not text authorization.
        lookup = { rpcId: direct[0].source.rpcId, textDigest: digestDirectUserTextContent(text),
          dshSessionId: agent.session.id };
      } catch { return undefined; }
    }
    if (!lookup || lookup.dshSessionId !== agent.session.id) return undefined;
    const renewingCurrentRequest = direct.length === 0 && renewal?.rpcId === lookup.rpcId
      && renewal?.dshSessionId === lookup.dshSessionId;
    const { rpcId, textDigest } = lookup;
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (token.length < 32 || token.length > 256) throw new Error('TaskSpace execution capability token is invalid.');
    const payload = Buffer.from(JSON.stringify({
      action: 'execution-context',
      projectSlug,
      taskId,
      conversationId,
      actorUserId,
      dshSessionId: agent.session.id,
      rpcId,
      textDigest,
    }));
    const result = await new Promise((resolve, reject) => {
      const request = http.request({
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: '/v1/actions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': payload.length,
          'x-forge-taskspace-token': token,
        },
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) response.destroy(new Error('Execution context response exceeded its limit.'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if ((response.statusCode ?? 500) >= 400 || document.ok !== true) {
              reject(new Error(`${document.error?.code ?? 'EXECUTION_CONTEXT_FAILED'}: ${document.error?.message ?? 'Execution context lookup failed.'}`));
            } else resolve(document.result);
          } catch (error) { reject(error); }
        });
      });
      // Signed lease renewal also inventories before and after reauthorization.
      // Only a remembered same-request renewal uses the longer window; first
      // lookups and unrelated ordinary reads keep their short deadline.
      const requestTimeoutMs = renewingCurrentRequest
        || ['checkpointed', 'integrated', 'review-base-advanced'].includes(sourceTransition?.phase)
        ? sourceTransitionTimeoutMs : timeoutMs;
      request.setTimeout(requestTimeoutMs, () => request.destroy(new Error('EXECUTION_CONTEXT_TIMEOUT: internal Broker lookup timed out.')));
      request.once('error', reject);
      request.end(payload);
    });
    validateProtectedExecutionContext(result, Date.now());
    if (result.projectSlug !== projectSlug || result.taskId !== taskId
      || result.conversationId !== conversationId || result.actorUserId !== actorUserId
      || result.dshSessionId !== agent.session.id || result.rpcId !== rpcId
      || result.textDigest !== textDigest || result.promptDigest !== textDigest
      || result.contractId !== result.contractDigest
      || result.contract.contractId !== result.contractId) {
      throw new Error('Protected execution context does not match the active DSH prompt.');
    }
    currentLookups.set(agent, lookup);
    return result;
  };
}

export async function refreshExecutionAdmission(
  state,
  admitExecution,
  now = Date.now(),
  executionContract = state?.taskIntent,
) {
  if (directDevelopmentEnabled(state?.taskContract)) return state;
  const productionCeiling = state?.executionAuthorityClass === 'production-task-writer'
    && state.protectedExecutionContextValidated === true
    && state.executionTestOnly === false
    && PRODUCTION_ADMISSION_CEILINGS.has(state.actionCeiling);
  const admissionCeiling = state?.actionCeiling === 'workspace-write' || productionCeiling;
  if (!state || !admissionCeiling || !state.taskIntent
    || state.executionContextStatus !== 'ready'
    || typeof admitExecution !== 'function' || state.verificationBlocked) return state;
  const profiles = requiredExecutionProfiles(executionContract, state);
  const sourceChangedSinceAdmission = state.verificationAdmission?.executionMode === 'host-toolchain'
    && state.mutationSequence > state.verificationAdmission.sequence;
  if (profiles.length === 0 || (!sourceChangedSinceAdmission
    && admissionCurrent(state.verificationAdmission, profiles, now + 30_000))) return state;
  // A successful write invalidates the Host lease's source binding. The trusted
  // runtime obtains a new lease; the model cannot reuse or refresh the old one.
  if (sourceChangedSinceAdmission) state.verificationAdmission = undefined;
  try {
    const receipt = await admitExecution(profiles);
    if (receipt.outcome !== 'ready') {
      state.verificationAdmission = {
        sequence: state.sequence,
        outcome: receipt.outcome,
        profiles: [...receipt.profiles],
        reasonCode: receipt.reasonCode,
        receipt,
      };
      state.verificationBlocked = true;
      state.admissionFailure = { code: receipt.reasonCode, retryable: false };
      return state;
    }
    state.verificationAdmission = {
      sequence: state.sequence,
      outcome: receipt.outcome,
      admissionId: receipt.admissionId,
      profiles: [...receipt.profiles],
      dependencyManifestFingerprint: receipt.source.dependencyManifestFingerprint,
      sourceWorkspaceFingerprint: receipt.source.workspaceFingerprint,
      expiresAt: receipt.expiresAt,
      receipt,
      ...(receipt.receiptType === 'forge-verify/host-execution-admission' ? {
        executionMode: 'host-toolchain',
        toolchainDigest: receipt.toolchain.digest,
        profilePolicyDigest: receipt.profilePolicyDigest,
      } : {
        executionMode: 'container-cache',
        cachePackDigest: receipt.cache.packDigest,
      }),
    };
    state.admissionFailureCount = 0;
    state.admissionFailure = undefined;
  } catch (error) {
    state.admissionFailureCount += 1;
    state.admissionFailure = {
      code: /TIMEOUT|ECONNRESET|ECONNREFUSED|EPIPE/iu.test(error?.message ?? '')
        ? 'CAPABILITY_TRANSIENT' : 'CAPABILITY_HARD',
      message: String(error?.message ?? 'execution admission failed').slice(0, 600),
      retryable: state.admissionFailureCount < 2,
    };
    if (state.admissionFailure.code === 'CAPABILITY_HARD' || state.admissionFailureCount >= 2) {
      state.verificationBlocked = true;
    }
  }
  return state;
}

function stepRatio(state) {
  return Math.min(1, Math.max(0, state.currentStep / state.maxSteps));
}

function phaseForState(state) {
  const hasCloseoutSubject = state.mutationCount > 0 || state.dependencyFailureCount > 0;
  if (hasCloseoutSubject && closeoutBlockers(state).length === 0) return PHASES.CLOSEOUT;
  if (state.repairAvailable) return PHASES.REPAIR;
  if (state.verificationSequence > state.mutationSequence && state.mutationCount > 0) return PHASES.VERIFY;
  if (state.mutationCount > 0) return PHASES.IMPLEMENT;
  if (state.routerSequence > 0) return PHASES.DISCOVER;
  return PHASES.ROUTE;
}

function advancePhase(state) {
  state.phase = phaseForState(state);
  return state;
}

function resultText(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function resultFailed(result) {
  if (!result || result.isError === true) return true;
  return /\[(?:exit code:\s*[1-9]\d*|timed out\b|killed by signal:)/iu.test(resultText(result))
    || /(?:^|\n)[A-Z][A-Z0-9_-]*EXIT:\s*[1-9]\d*\b/u.test(resultText(result))
    || /"ok"\s*:\s*false\b/u.test(resultText(result));
}

function successfulSourceTransition(state, exec, result) {
  if (resultFailed(result)) return null;
  try {
    let text = resultText(result).replace(/\r\n/gu, '\n');
    let commandText = commandOf(exec);
    if (exec?.name === 'job_output') {
      const job = state.sourceTransitionJobs.get(normalizedArguments(exec).job_id);
      if (!job || job.executionId !== state.executionIdentity?.executionId
        || job.generation !== state.executionContextGeneration || job.rpcId !== state.executionRpcId
        || job.contractId !== state.taskContract?.contractId
        || !/\n\[status: completed, exit code: 0\]\s*$/u.test(text)) return null;
      commandText = job.command;
      text = text.replace(/\n\[status: completed, exit code: 0\]\s*$/u, '').trim();
    } else if (exec?.name === 'bash') {
      text = text.replace(/\n?\[exit code:\s*0\]\s*$/iu, '').trim();
    } else return null;
    const command = parseControlledReleaseMutationCommand(commandText);
    if (!['checkpoint', 'integrate'].includes(command?.action)) return null;
    if (text.length > 2 * 1024 * 1024) return null;
    const response = JSON.parse(text);
    const checkpoint = response.result;
    if (command.action === 'integrate') {
      if (response.ok !== true || checkpoint?.operation !== 'integrate'
        || checkpoint.status !== 'integrated' || checkpoint.workspaceClean !== true
        || !['git-checkpoint', 'release'].includes(state.actionCeiling)) return null;
      // A clean integration can advance only the protected comparison base.
      // Host admission binds that base even when HEAD/content stay unchanged.
      // Refresh through the existing trusted resolver; never relax Host checks.
      if (checkpoint.sourceTransition === null) {
        const review = checkpoint.reviewBaseTransition;
        if (!review || !/^[0-9a-f]{40}$/u.test(review.from)
          || !/^[0-9a-f]{40}$/u.test(review.to) || review.from === review.to
          || !Number.isFinite(Date.parse(review.appliedAt))
          || typeof checkpoint.operationId !== 'string' || !checkpoint.operationId
          || checkpoint.operationId === state.lastReviewBaseTransitionOperationId
          || review.to !== checkpoint.canonicalHead
          || review.to !== command.options['--canonical-head']
          || checkpoint.head !== command.options['--expected-head']
          || checkpoint.head !== state.executionSourceCommit
          || checkpoint.workspaceFingerprint !== command.options['--expected-fingerprint']
          || checkpoint.workspaceFingerprint !== state.executionWorkspaceFingerprint
          || (command.options['--mode'] === 'continue'
            && checkpoint.operationId !== command.options['--operation-id'])) return null;
        return { phase: 'review-base-advanced', operationId: checkpoint.operationId,
          to: { head: checkpoint.head, fingerprint: checkpoint.workspaceFingerprint } };
      }
      const transition = validateSourceTransition(checkpoint.sourceTransition);
      const authority = transition.sourceAuthority;
      const task = transition.task;
      // Direct integrate can save this request's edits before merging. Its
      // pre-save tree need not have an optional Host admission; the exact
      // command, signed authority and Broker-owned transition still bind it.
      const directEditedIntegration = directDevelopmentEnabled(state.taskContract)
        && state.protectedExecutionContextValidated && state.executionAuthorityClass === 'production-task-writer'
        && state.executionWorkflowId === null && state.executionTestOnly === false;
      if (transition.phase !== 'integrated' || transition.from.head === transition.to.head
        || transition.from.head !== command.options['--expected-head']
        || transition.from.fingerprint !== command.options['--expected-fingerprint']
        || transition.from.head !== state.executionSourceCommit
        || (transition.from.fingerprint !== state.executionWorkspaceFingerprint
          && transition.from.fingerprint !== state.verificationAdmission?.receipt?.source?.workspaceFingerprint
          && !directEditedIntegration)
        || transition.to.head !== checkpoint.head || transition.to.fingerprint !== checkpoint.workspaceFingerprint
        || transition.canonicalHead !== checkpoint.canonicalHead
        || transition.canonicalHead !== command.options['--canonical-head']
        || transition.operationId !== checkpoint.operationId
        || (command.options['--mode'] === 'continue' && transition.operationId !== command.options['--operation-id'])
        || task.projectSlug !== state.executionProjectSlug || task.taskId !== state.executionIdentity?.taskId
        || task.actorUserId !== state.executionActorUserId || task.actorUsername !== state.executionActorUsername
        || task.conversationId !== state.executionConversationId || task.dshSessionId !== state.executionDshSessionId
        || authority.executionId !== state.executionIdentity?.executionId
        || authority.generation !== state.executionContextGeneration
        || authority.contractId !== state.taskContract?.contractId || authority.actionCeiling !== state.actionCeiling
        || authority.productionAuthorityDigest !== state.executionProductionAuthorityDigest
        || authority.controllerGrantDigest !== state.executionControllerGrantDigest
        || authority.issuedAt !== state.executionContextIssuedAt || authority.expiresAt !== state.executionContextExpiresAt) return null;
      return transition;
    }
    // A local checkpoint commits only its authorized paths. Other candidates
    // may remain dirty; the bound transition and refreshed authority still apply.
    if (response.ok !== true || checkpoint?.operation !== 'checkpoint'
      || checkpoint.status !== 'checkpointed' || typeof checkpoint.workspaceClean !== 'boolean') return null;
    const transition = validateSourceTransition(checkpoint.sourceTransition);
    if (transition.phase !== 'checkpointed' || transition.from.head === transition.to.head
      || transition.from.fingerprint !== transition.to.fingerprint
      || transition.from.head !== command.options['--expected-head']
      || transition.from.fingerprint !== command.options['--expected-fingerprint']
      || transition.from.head !== state.executionSourceCommit || checkpoint.beforeHead !== transition.from.head
      || checkpoint.commit !== transition.to.head || checkpoint.workspaceFingerprint !== transition.to.fingerprint
      || transition.task.taskId !== state.executionIdentity?.taskId
      || transition.sourceAuthority.executionId !== state.executionIdentity?.executionId
      || transition.sourceAuthority.generation !== state.executionContextGeneration
      || transition.sourceAuthority.contractId !== state.taskContract?.contractId) return null;
    return transition;
  } catch { return null; }
}

function dependencyFailureObserved(exec, result) {
  return isDependencyExecution(exec) && DEPENDENCY_FAILURE.test(resultText(result));
}

function controlledVerificationBlocked(exec, result) {
  return exec?.name === 'bash'
    && parseControlledEvidenceCommand(commandOf(exec))?.executable === 'forge-verify'
    && CONTROLLED_VERIFICATION_BLOCKED.test(resultText(result));
}

function writerAttemptShape(exec) {
  return JSON.stringify({
    name: exec?.name ?? '',
    arguments: normalizedArguments(exec),
  });
}

function staleCreateFsResult(exec, result, operation, code, detail) {
  const relativePath = contractPathFromMutation(exec);
  const exactText = `Error: cannot ${operation} "/workspace/${relativePath}": ${detail}`;
  return relativePath.length > 0
    && exec?.name === operation
    && result?.isError === true
    && result?.error?.info?.name === 'FsError'
    && result?.error?.info?.code === code
    && resultText(result) === exactText;
}

function staleCreateContextCurrent(state) {
  const binding = state?.staleCreate?.execution;
  return binding
    && state.executionContextStatus === 'ready'
    && Date.parse(state.executionContextExpiresAt) > Date.now()
    && binding.executionId === state.executionIdentity?.executionId
    && binding.contractId === state.taskContract?.contractId
    && binding.generation === state.executionContextGeneration
    && binding.admissionId === state.verificationAdmission?.admissionId;
}

function staleCreateOperation(state, exec) {
  const recovery = state?.staleCreate;
  if (!STALE_CREATE_STAGES.has(recovery?.stage) || !staleCreateContextCurrent(state)
    || typeof exec?.callId !== 'string' || exec.callId.length < 1 || exec.callId.length > 256
    || contractPathFromMutation(exec) !== recovery.path) return '';
  const kind = recovery.stage.startsWith('read') ? 'read' : 'write';
  if (exec.name !== kind || (kind === 'write' && typeof normalizedArguments(exec).content !== 'string')) return '';
  if (!recovery.stage.endsWith('reserved')) return kind;
  return recovery.reservation?.callId === exec.callId
    && recovery.reservation.shapeDigest === progressDigest(writerAttemptShape(exec)) ? kind : '';
}

function staleCreateStop(state) {
  return state?.progressDecision?.decision === 'STOP'
    && state.progressDecision.reasonCodes.length === 1
    && STALE_CREATE_STOPS.has(state.progressDecision.reasonCodes[0]);
}

function finishStaleCreate(state, stage, outcome) {
  if (!state?.staleCreate) return;
  state.staleCreate.stage = stage;
  state.staleCreate.outcome = outcome;
}

function admittedWriterFact(state, exec) {
  const reservation = state?.writerReservations?.get(exec?.callId);
  const shape = writerAttemptShape(exec);
  return reservation?.shape === shape && reservation.allowed === true ? {
    classifierVersion: 'typed-fs-stale-create/v1',
    callId: exec.callId,
    shapeDigest: progressDigest(shape),
    reservationObserved: true,
    allowedObserved: true,
  } : undefined;
}

function observeStaleCreate(state, exec, result, writerFact) {
  const recovery = state.staleCreate;
  if (STALE_CREATE_STAGES.has(recovery?.stage)) {
    if (!staleCreateOperation(state, exec) || recovery.reservation?.allowedObserved !== true) {
      finishStaleCreate(state, 'consumed', 'intervening-result');
    }
    else if (recovery.stage === 'read-reserved') {
      if (staleCreateFsResult(exec, result, 'read', 'FS_NOT_FOUND', 'not found')) {
        recovery.stage = 'write';
        recovery.resultDigests.read = progressDigest(resultText(result));
        recovery.reservation = null;
      } else finishStaleCreate(state, 'consumed', 'read-not-confirmed');
    } else if (recovery.stage === 'write-reserved') {
      recovery.resultDigests.retry = progressDigest(resultText(result));
      recovery.writerFacts.retry = writerFact ?? null;
      const outcome = !writerFact ? 'retry-fact-missing'
        : resultFailed(result) ? 'retry-failed' : 'retry-succeeded';
      finishStaleCreate(state, 'consumed', outcome);
    }
  }
  if (state.staleCreate || !writerFact
    || (state.executionProjectionRequired && state.executionProjectionStatus !== 'ready')
    || !staleCreateFsResult(
      exec, result, 'write', 'FS_STALE_VERSION',
      'file no longer exists — re-read the file, then retry',
    )) return;
  let contract;
  try { contract = candidateTaskContract(state, exec); } catch { contract = undefined; }
  if (!contract || typeof state.verificationAdmission?.admissionId !== 'string') return;
  state.staleCreate = {
    classifierVersion: 'typed-fs-stale-create/v1',
    stage: 'read',
    path: contractPathFromMutation(exec),
    originCallId: exec.callId,
    execution: {
      executionId: state.executionIdentity.executionId,
      contractId: contract.contractId,
      generation: state.executionContextGeneration,
      admissionId: state.verificationAdmission.admissionId,
    },
    resultDigests: { stale: progressDigest(resultText(result)), read: null, retry: null },
    writerFacts: { stale: writerFact, retry: null },
    reservation: null,
    outcome: null,
  };
}

function isPendingRoutedSkill(state, exec) {
  const skill = requestedSkill(exec);
  if (!skill || !state?.taskContract || skill === 'forge-evidence-truth') return false;
  return state.taskContract.requiredSkills.includes(skill) && !state.invokedSkills.has(skill);
}

function activeWriterReservations(state, exec) {
  if (!state?.writerReservations) return 0;
  return state.writerReservations.size - (state.writerReservations.has(exec?.callId) ? 1 : 0);
}

function permitsStoppedVerificationEvidence(state, controlledCommand) {
  if (controlledCommand?.executable === 'forge-verify'
    && ['status', 'watch', 'receipt'].includes(controlledCommand.action)) {
    return [...(state?.verificationBackgroundJobs?.values() ?? [])].some((job) =>
      controlledCommand.action !== 'receipt'
        ? job.jobId === controlledCommand.options['--job-id']
        : job.receiptId === controlledCommand.options['--receipt-id']);
  }
  if ((state?.mutationCount < 1 && !productionWriterContextCurrent(state))
    || controlledCommand?.executable !== 'forge-verify'
    || controlledCommand.action !== 'run') return false;
  const profile = controlledCommand.options['--profile'];
  if (!requiredExecutionProfiles(state?.taskContract, state).includes(profile)) return false;
  const lastAttempt = state.verificationProfileAttempts.get(profile);
  if (lastAttempt && lastAttempt.sequence >= state.mutationSequence) return false;
  if (state.implementationSwitchRequired
    && !['STOP', 'ESCALATE_AT_IMMUTABLE_BOUNDARY', 'RESERVE_CLOSEOUT'].includes(state.progressDecision?.decision)) return true;
  if (state.progressDecision?.decision === 'RESERVE_CLOSEOUT') return true;
  if (productionWriterContextCurrent(state)
    && ['STOP', 'ESCALATE_AT_IMMUTABLE_BOUNDARY'].includes(state.progressDecision?.decision)
    && state.progressDecision.reasonCodes.length === 1
    && state.progressDecision.reasonCodes[0] === 'DISCOVERY_GATE_INCOMPLETE') return true;
  return state.progressDecision?.decision === 'STOP'
    && state.progressDecision.reasonCodes.length === 1
    && ['NO_MACHINE_OBSERVABLE_PROGRESS', 'REPEATED_ACTION_RESULT_NO_PROGRESS', 'PHASE_BUDGET_EXHAUSTED']
      .includes(state.progressDecision.reasonCodes[0]);
}

function controlledReleasePreparationDenialReason(state, command, exec, now = Date.now()) {
  const marker = PHASE_GUARD_MARKER;
  const binding = state?.executionPreparationBinding;
  const contract = state?.taskContract;
  if (state?.executionContextStatus !== 'ready' || state.protectedExecutionContextValidated !== true
    || state.executionAuthorityClass !== 'production-read-only' || state.executionTestOnly !== false
    || state.executionCrossLayerPreparation !== true || state.executionWorkflowId !== 'crud-production'
    || state.executionPhaseId !== 'cross-layer-acceptance' || state.executionPhaseIndex !== 7
    || state.actionCeiling !== 'read-only' || contract?.actionCeiling !== 'read-only'
    || !Array.isArray(contract?.ownedPaths) || contract.ownedPaths.length !== 0
    || state.executionIdentity?.contractId !== contract?.contractId
    || state.taskIntent?.contractId !== contract?.contractId
    || typeof state.executionIdentity?.taskId !== 'string' || typeof state.executionIdentity?.executionId !== 'string'
    || typeof state.executionActorUserId !== 'string' || typeof state.executionConversationId !== 'string'
    || typeof state.executionRpcId !== 'string' || typeof state.executionDshSessionId !== 'string'
    || exec?.agent?.session?.id !== state.executionDshSessionId) {
    return `${marker}: controlled prepare requires the current protected cross-layer preparation context and session; ordinary or formal read-only phases cannot prepare a candidate`;
  }
  if (!Number.isFinite(Date.parse(state.executionContextExpiresAt)) || Date.parse(state.executionContextExpiresAt) <= now) {
    return `${marker}: controlled prepare requires an unexpired protected preparation lease`;
  }
  const digests = binding?.acceptedArtifactDigests;
  if (!binding || !/^[0-9a-f]{64}$/u.test(binding.stateDigest ?? '')
    || !digests || Array.isArray(digests) || Object.keys(digests).length !== 7
    || Object.values(digests).some(value => typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value))
    || !/^[0-9a-f]{40}$/u.test(binding.baseSourceCommit ?? '')
    || !/^[0-9a-f]{64}$/u.test(binding.workspaceFingerprint ?? '')
    || command.options['--expected-head'] !== binding.baseSourceCommit
    || command.options['--expected-fingerprint'] !== binding.workspaceFingerprint) {
    return `${marker}: controlled prepare must bind the seven accepted stages and exact protected source HEAD and workspace fingerprint`;
  }
  if (normalizedArguments(exec).workdir !== undefined && !['.', '/workspace'].includes(normalizedArguments(exec).workdir)) {
    return `${marker}: controlled prepare must use the current /workspace root`;
  }
  if (state.executionProjectionRequired && (state.executionProjectionStatus !== 'ready'
    || state.executionProjectionSnapshot?.state?.terminalOutcome !== null)) {
    return `${marker}: stopped or unavailable execution projection cannot dispatch controlled prepare`;
  }
  return undefined;
}

function controlledReleaseMutationDenialReason(state, command, now = Date.now()) {
  const marker = PHASE_GUARD_MARKER;
  const requiredSkill = command.action === 'checkpoint'
    || (command.action === 'integrate' && state?.actionCeiling === 'git-checkpoint')
    ? 'forge-git-checkpoint' : 'forge-controlled-release';
  if (!state || state.executionContextStatus !== 'ready'
    || state.protectedExecutionContextValidated !== true
    || state.executionAuthorityClass !== 'production-task-writer'
    || state.executionTestOnly !== false) {
    return `${marker}: controlled ${command.action} requires a validated ready production-task-writer context`;
  }
  if (typeof state.executionContextExpiresAt !== 'string'
    || Date.parse(state.executionContextExpiresAt) <= now) {
    state.executionContextStatus = 'expired';
    return `${marker}: the protected execution context lease expired; controlled ${command.action} requires a newly signed context`;
  }
  const contract = state.taskContract;
  const identity = state.executionIdentity;
  if (!contract || !state.taskIntent || !identity
    || identity.contractId !== contract.contractId
    || state.taskIntent.contractId !== contract.contractId
    || state.actionCeiling !== contract.actionCeiling
    || typeof identity.taskId !== 'string'
    || typeof identity.executionId !== 'string') {
    return `${marker}: controlled ${command.action} requires the current matching contract and task/execution identity`;
  }
  const hostCandidateFingerprint = command.action === 'integrate'
    && command.options['--expected-fingerprint'] !== state.executionWorkspaceFingerprint
    && state.verificationAdmission?.executionMode === 'host-toolchain'
    && state.verificationAdmission.sequence >= state.mutationSequence
    && admissionCurrent(state.verificationAdmission, requiredExecutionProfiles(contract, state), now)
    && state.verificationAdmission.receipt?.projectSlug === state.executionProjectSlug
    && state.verificationAdmission.receipt?.taskId === identity.taskId
    && state.verificationAdmission.receipt?.source?.head === state.executionSourceCommit
    && state.verificationAdmission.receipt?.source?.workspaceFingerprint
      === command.options['--expected-fingerprint'];
  if (command.action === 'integrate'
    && (command.options['--expected-head'] !== state.executionSourceCommit
      || (command.options['--expected-fingerprint'] !== state.executionWorkspaceFingerprint
        && !hostCandidateFingerprint && !directDevelopmentEnabled(contract)))) {
    return `${marker}: controlled integrate must bind the exact current protected source HEAD and workspace fingerprint`;
  }
  if (state.promptReadOnlyConstraint) {
    return `${marker}: the current prompt constrains this execution to read-only and cannot authorize controlled ${command.action}`;
  }
  const ceilingAllowsAction = command.action === 'release'
    ? state.actionCeiling === 'release'
    : ['git-checkpoint', 'release'].includes(state.actionCeiling);
  if (!ceilingAllowsAction) {
    const confirmationNextStep = !directDevelopmentEnabled(contract) && state.actionCeiling === 'workspace-write'
      && prepareTaskDenialReason(state, {
        name: PREPARE_TASK_TOOL_NAME,
        arguments: { operation: 'inspect' },
      }, now) === undefined
      ? (command.action !== 'release'
        ? ' 本轮只有代码写入权限；本地提交及任务内源码同步需要 git-checkpoint 权限，无须发布授权。若当前请求已明确授权这些操作，先通过 prepare_task inspect/propose 按原范围刷新；只有缺少授权时，才请用户在原对话下一轮确认当前范围的本地提交或同步。平台会重新校验账号权限、身份、范围和源码；只有实际取得当前合同后才能继续。不得自行提权或替用户确认。'
        : ' 本轮只有代码写入权限；若当前请求已明确授权发布，先通过 prepare_task inspect/propose 按原范围刷新；只有缺少发布授权时，才请用户在原对话下一轮明确确认发布当前范围。平台会重新校验账号权限、身份、范围和源码；只有实际取得当前发布合同及必需验收后才能继续。不得自行提权或替用户确认。')
      : '';
    return `${marker}: controlled ${command.action} exceeds the protected contract ceiling ${state.actionCeiling}.${confirmationNextStep}`;
  }
  if (!directDevelopmentEnabled(contract) && !state.suspendHeuristicStops && !state.invokedSkills.has(requiredSkill)) {
    return `${marker}: invoke ${requiredSkill} successfully before controlled ${command.action}`;
  }
  if (state.executionProjectionRequired && !directDevelopmentEnabled(contract)) {
    if (state.executionProjectionStatus !== 'ready') {
      return `${marker}: protected execution reducer projection is unavailable (${state.executionProjectionErrorCode ?? 'EXECUTION_PROJECTION_NOT_READY'}); controlled ${command.action} fails closed`;
    }
    const terminalOutcome = state.executionProjectionSnapshot?.state?.terminalOutcome;
    if (terminalOutcome !== null && terminalOutcome !== undefined) {
      return `${marker}: protected execution reducer stopped as ${terminalOutcome}; controlled ${command.action} fails closed`;
    }
  }
  return undefined;
}

function closeoutReleaseContractCurrent(state, now = Date.now()) {
  const contract = state?.taskContract;
  return state?.phase === PHASES.CLOSEOUT
    && productionTaskWriterState(state)
    && Date.parse(state.executionContextExpiresAt) > now
    && state.promptReadOnlyConstraint !== true
    && ['git-checkpoint', 'release'].includes(state.actionCeiling)
    && contract?.actionCeiling === state.actionCeiling
    && contract.contractId === state.executionIdentity?.contractId
    && contract.contractId === state.taskIntent?.contractId;
}

function closeoutReleaseSkillAllowed(state, exec, now = Date.now()) {
  if (!closeoutReleaseContractCurrent(state, now)) return false;
  const skill = requestedSkill(exec);
  if (!state.taskContract.requiredSkills.includes(skill)) return false;
  return skill === 'forge-git-checkpoint'
    || (skill === 'forge-controlled-release' && state.actionCeiling === 'release');
}

function prepareTaskDenialReason(state, exec, now = Date.now()) {
  if (exec?.name !== PREPARE_TASK_TOOL_NAME) return undefined;
  const operation = normalizedArguments(exec).operation;
  if (!['inspect', 'propose'].includes(operation)) {
    return `${PHASE_GUARD_MARKER}: prepare_task requires the typed inspect or propose operation`;
  }
  if (!state || state.executionContextStatus !== 'ready'
    || state.protectedExecutionContextValidated !== true || !state.executionIdentity
    || typeof state.executionContextExpiresAt !== 'string'
    || Date.parse(state.executionContextExpiresAt) <= now) {
    return `${PHASE_GUARD_MARKER}: prepare_task requires the current validated protected execution context`;
  }
  if (state.executionTestOnly === true
    || (state.executionWorkflowId !== null && state.executionWorkflowId !== undefined)
    || !['production-read-only', 'production-task-writer'].includes(state.executionAuthorityClass)) {
    return `${PHASE_GUARD_MARKER}: prepare_task is available only for ordinary conversations, never a governed delivery phase`;
  }
  if (operation === 'propose' && state.promptReadOnlyConstraint) {
    return `${PHASE_GUARD_MARKER}: the direct user prompt explicitly requires read-only work; prepare_task may inspect but cannot propose write scope`;
  }
  if (operation === 'propose' && state.executionAuthorityClass === 'production-task-writer'
    && (state.mutationCount > 0 || state.mutationSequence > 0) && !directDevelopmentEnabled(state.taskContract)) {
    return `${PHASE_GUARD_MARKER}: prepare_task cannot replace a scoped writer contract after source mutation`;
  }
  return undefined;
}

function controlledDeliveryDenialReason(state, command, exec, now = Date.now()) {
  if (command.action === 'help') return undefined;
  const marker = PHASE_GUARD_MARKER;
  // The CLI resolves its Git root from cwd. A caller cannot select another mount.
  const workdir = normalizedArguments(exec).workdir;
  if (workdir !== undefined && !['.', '/workspace'].includes(workdir)) {
    return `${marker}: forge-delivery must use the current /workspace root`;
  }
  if (!state || state.executionContextStatus !== 'ready'
    || state.protectedExecutionContextValidated !== true
    || !state.executionIdentity
    || !Number.isFinite(Date.parse(state.executionContextExpiresAt))
    || Date.parse(state.executionContextExpiresAt) <= now) {
    return `${marker}: forge-delivery requires the current validated protected task context`;
  }
  const contract = state.taskContract;
  if (command.options['--source']?.some((source) => !contract?.ownedPaths.some((owned) => isForgeTaskOwnedPath(source, owned)))) {
    return `${marker}: forge-delivery handoff/contract sources must stay inside the current task owned paths`;
  }
  if (!command.mutation) return undefined;
  if (state.promptReadOnlyConstraint || state.executionAuthorityClass !== 'production-task-writer'
    || state.executionTestOnly !== false || !contract || !state.taskIntent
    || state.executionIdentity.contractId !== contract.contractId
    || state.taskIntent.contractId !== contract.contractId
    || state.actionCeiling !== contract.actionCeiling
    || !['workspace-write', 'git-checkpoint', 'release'].includes(state.actionCeiling)) {
    return `${marker}: forge-delivery state writes require the current matching scoped writer contract; use prepare_task inspect/propose for the already authorized task, without requesting repeated user confirmation`;
  }
  if (state.executionProjectionRequired && (state.executionProjectionStatus !== 'ready'
    || state.executionProjectionSnapshot?.state?.terminalOutcome !== null)) {
    return `${marker}: forge-delivery state writes require a ready nonterminal protected execution projection`;
  }
  return undefined;
}

function directToolExecutionEnabled(state) {
  // Ordinary analysis has a signed production-read-only context, without the
  // development contract marker. It still uses the deployment's direct tools,
  // with the same identity/expiry checks and an immutable workspace mount.
  return directDevelopmentEnabled(state?.taskContract)
    || (process.env.FORGE_DEVELOPMENT_MODE === 'direct'
      && state?.executionAuthorityClass === 'production-read-only'
      && state?.actionCeiling === 'read-only' && state?.taskContract?.actionCeiling === 'read-only');
}

function directBrowserAuthority(state) {
  if (!directToolExecutionEnabled(state) || !state.protectedExecutionContextValidated || state.executionContextStatus !== 'ready') return undefined;
  return { mode: state.promptReadOnlyConstraint || state.actionCeiling === 'read-only' ? 'read-only' : 'workspace-write',
    workspaceRoot: '/workspace', taskKey: JSON.stringify([state.executionIdentity?.taskId, state.taskContract?.contractId]),
    expiresAt: state.executionContextExpiresAt };
}

function toolDenialReason(state, exec) {
  const marker = PHASE_GUARD_MARKER;
  if (exec?.name === 'browser' && exec?.signal?.aborted) return `${marker}: the current browser request is stopped; browser execution is not authorized`;
  if (exec?.name === 'browser' && !directToolExecutionEnabled(state)) return `${marker}: browser requires the current authenticated direct-development context`;
  if (exec?.name === PREPARE_TASK_TOOL_NAME) return prepareTaskDenialReason(state, exec);
  const command = commandOf(exec);
  const controlledCommand = exec?.name === 'bash' ? parseControlledEvidenceCommand(command) : null;
  const controlledVerificationInspection = exec?.name === 'bash'
    ? parseControlledVerificationInspectionCommand(command) : null;
  const controlledDelivery = exec?.name === 'bash' ? parseControlledDeliveryCommand(command) : null;
  const controlledGovernanceInspection = exec?.name === 'bash'
    ? parseControlledGovernanceInspectionCommand(command) : null;
  const controlledReleaseInspection = exec?.name === 'bash'
    ? parseControlledReleaseInspectionCommand(command) : null;
  const controlledReleasePreparation = exec?.name === 'bash'
    ? parseControlledReleasePreparationCommand(command) : null;
  const controlledReleaseMutation = exec?.name === 'bash'
    ? parseControlledReleaseMutationCommand(command) : null;
  // Session bookkeeping and clarification do not consume a workspace lease.
  // Saving may invalidate the source binding before the agent closes its todo.
  if (directDevelopmentEnabled(state?.taskContract)
    && ['todo_write', 'ask_user_question'].includes(exec?.name)) return undefined;
  if (directToolExecutionEnabled(state)
    && (MUTATION_TOOLS.has(exec?.name) || READ_TOOLS.has(exec?.name) || exec?.name === 'bash' || exec?.name === 'browser'
      || ['skill', 'todo_write', 'ask_user_question'].includes(exec?.name))) {
    // A completed save/integration invalidates write bindings while they are
    // refreshed. Reading ordinary source does not consume that write binding.
    const readingDuringSourceRefresh = ['read', 'grep', 'glob', 'ls', 'find'].includes(exec?.name)
      && state.executionContextStatus === 'unavailable' && state.pendingSourceTransition != null;
    if (state.executionContextStatus === 'unavailable' && !readingDuringSourceRefresh) {
      return `${marker}: current request authorization context is unavailable (${state.executionContextFailureCode ?? 'EXECUTION_CONTEXT_UNAVAILABLE'}); this is not evidence of lease expiry. The platform must restore this request binding; do not ask the user to repeat an already authorized task.`;
    }
    if (!state.protectedExecutionContextValidated || (state.executionContextStatus !== 'ready' && !readingDuringSourceRefresh)
      || !['production-task-writer', 'production-read-only'].includes(state.executionAuthorityClass) || state.executionTestOnly !== false
      || !state.executionIdentity || !Number.isFinite(Date.parse(state.executionContextExpiresAt))
      || Date.parse(state.executionContextExpiresAt) <= Date.now()) {
      return `${marker}: direct development requires the current unexpired authenticated TaskSpace context${state.executionContextFailureCode ? ` (${state.executionContextFailureCode})` : ''}`;
    }
    if (controlledReleaseInspection || controlledVerificationInspection || controlledGovernanceInspection) return undefined;
    const ordinaryShell = exec?.name === 'bash' && !controlledReleaseMutation && !controlledReleasePreparation
      && !controlledCommand && !controlledDelivery;
    const shellReadOnly = ordinaryShell && (state.promptReadOnlyConstraint || state.actionCeiling === 'read-only');
    const changing = MUTATION_TOOLS.has(exec?.name) || (exec?.name === 'bash' && !shellReadOnly)
      || (exec?.name === 'browser' && isMutationExecution(exec));
    if (changing && (state.promptReadOnlyConstraint || state.actionCeiling === 'read-only'
      || exec?.signal?.aborted)) {
      return `${marker}: the current user request is read-only or stopped; development execution is not authorized`;
    }
    if (changing && (state.executionAuthorityClass !== 'production-task-writer'
      || !['workspace-write', 'git-checkpoint', 'release'].includes(state.actionCeiling))) {
      return `${marker}: current TaskSpace account authority does not allow development writes`;
    }
    if (MUTATION_TOOLS.has(exec?.name) && !directDevelopmentPath(contractPathFromMutation(exec))) {
      return `${marker}: platform, Git, credential and outside-workspace paths remain protected`;
    }
    if (exec?.name === 'bash') {
      // Git metadata writes are rejected by the worker's read-only mount.
      // Matching command text here also rejects quoted examples and scripts.
      if (controlledReleaseMutation) return controlledReleaseMutationDenialReason(state, controlledReleaseMutation);
      if (controlledReleasePreparation) return controlledReleasePreparationDenialReason(state, controlledReleasePreparation, exec);
      if (CONTROLLED_COMMAND_REFERENCE.test(command) && !controlledCommand && !controlledVerificationInspection
        && !controlledReleaseInspection && !controlledGovernanceInspection && !controlledDelivery) {
        if (isPlainControlledIntegrateReference(command)) {
          return `${marker}: controlled integrate command was not executed: invalid or missing required arguments. --mode, --expected-head, --expected-fingerprint and --canonical-head are required; continue also requires --operation-id. ${controlledIntegrateDiscoveryContract()} Correct the arguments within the existing authorization and continue; do not repeat the unchanged command or request user confirmation merely for this syntax error. No permission or gate bypass is available`;
        }
        const hint = controlledEvidenceCommandHint(command);
        return hint ? `${marker}:${hint}`
          : `${marker}: protected platform clients still require one exact argv without shell composition`;
      }
      if (!controlledCommand && !controlledVerificationInspection && !controlledReleaseInspection
        && !controlledGovernanceInspection && !controlledDelivery && !process.env.FORGE_TOOL_WORKER_SOCKET) {
        return `${marker}: direct development commands require the isolated tool worker`;
      }
    }
    if (changing && (typeof exec?.callId !== 'string' || state.settledWriterCalls.has(exec.callId))) {
      return `${marker}: development calls require a fresh stable native call id`;
    }
    return undefined;
  }
  const typedVerificationRun = controlledCommand?.executable === 'forge-verify'
    && controlledCommand.action === 'run';
  const stoppedVerificationEvidence = permitsStoppedVerificationEvidence(state, controlledCommand);
  const staleOperation = staleCreateOperation(state, exec);
  if (STALE_CREATE_STAGES.has(state?.staleCreate?.stage) && !staleOperation) {
    return `${marker}: stale-create recovery permits only the next same-path read or one same-path write retry`;
  }
  if (state?.implementationSwitchRequired && !isMutationExecution(exec) && staleOperation !== 'read') {
    const evidenceSkill = requestedSkill(exec) === 'forge-evidence-truth';
    const routedSkill = isPendingRoutedSkill(state, exec);
    const closeoutCommand = exec?.name === 'bash'
      && (isGovernanceExecution(exec) || stoppedVerificationEvidence || CLOSEOUT_READ_COMMAND.test(command)
        || controlledReleaseMutation !== null);
    if (!evidenceSkill && !routedSkill && !closeoutCommand) {
      return `${marker}: ${state.progressDecision?.reasonCodes?.join(', ') || 'DISCOVERY_STAGNATION'}; ordinary discovery is closed; this is a progress restriction, not a missing Git/release authorization. Invoke missing routed Skills, run missing typed verification, or use the contract-authorized controlled checkpoint/release path; do not edit solely to unlock progress`;
    }
  }
  if (state?.progressDecision
    && !isMutationExecution(exec)
    && ['STOP', 'ESCALATE_AT_IMMUTABLE_BOUNDARY', 'RESERVE_CLOSEOUT'].includes(state.progressDecision.decision)) {
    const evidenceSkill = requestedSkill(exec) === 'forge-evidence-truth';
    const closeoutCommand = exec?.name === 'bash'
      && (isGovernanceExecution(exec) || stoppedVerificationEvidence
        || CLOSEOUT_READ_COMMAND.test(command));
    if (!evidenceSkill && !closeoutCommand && !(staleOperation === 'read' && staleCreateStop(state))) {
      return `${marker}: ${state.progressDecision.reasonCodes.join(', ')}; ordinary discovery and mutation are closed, preserve the current immutable evidence and issue a truthful bounded closeout`;
    }
  }
  if (isUnknownSideEffectExecution(exec)) {
    return `${marker}: unclassified tool ${String(exec?.name ?? '<missing>')} is treated as side-effecting and denied until a protected tool policy adapter declares it safe`;
  }
  if (exec?.name === 'bash' && GIT_MUTATION.test(command)) {
    return `${marker}: direct Git mutation exceeds the workspace-write task contract; use the separately authorized Forge checkpoint/release capability`;
  }
  if (exec?.name === 'bash' && CONTROLLED_COMMAND_REFERENCE.test(command)
    && parseControlledEvidenceCommand(command) === null
    && controlledGovernanceInspection === null
    && controlledVerificationInspection === null
    && controlledReleaseInspection === null
    && controlledReleasePreparation === null
    && controlledReleaseMutation === null
    && controlledDelivery === null) {
    if (isPlainControlledIntegrateReference(command)) {
      if (!state?.suspendHeuristicStops && state?.phase === PHASES.CLOSEOUT) {
        return `${marker}: FINAL_ONLY is active after final audit and forge-evidence-truth; no further tool calls are allowed`;
      }
      if (state && !state.suspendHeuristicStops && stepRatio(state) >= 0.9) {
        return `${marker}: 90 percent of the step budget is consumed; only typed final governance/verification evidence, forge-evidence-truth, and the final status remain`;
      }
      return `${marker}: controlled integrate has an invalid or missing required argv shape; ${controlledIntegrateDiscoveryContract()} No permission or gate bypass is available`;
    }
    return `${marker}: governance, verification, and release-inspection commands must use one exact reviewed argv shape with no shell composition, redirection, environment override, or mutable base reference${controlledEvidenceCommandHint(command)}`;
  }
  if (exec?.name === 'bash' && NETWORK_COMMAND.test(command)) {
    return `${marker}: direct network probes are forbidden; use the bounded platform verification capability or report a dependency blocker`;
  }
  if (state?.dependencyFailureCount > 0 && exec?.name === 'bash'
    && (FULL_DISK_CACHE_HUNT.test(command) || MIRROR_HUNT.test(command))) {
    return `${marker}: dependency failure already observed; mirror hunts and whole-disk cache searches are forbidden`;
  }
  if (isDependencyExecution(exec) && state?.dependencyClosed) {
    return `${marker}: the single dependency retry was consumed; stop retrying and close with a bounded blocker`;
  }
  if (isDependencyExecution(exec) && state?.dependencyRetryReserved
    && state.dependencyRetryCallId !== exec?.callId) {
    return `${marker}: the single dependency retry is already in flight; parallel or repeated dependency retries are forbidden`;
  }
  if (state?.taskIntent && controlledCommand?.executable === 'forge-verify'
    && controlledCommand.action === 'admit') {
    return `${marker}: batch execution admission is issued only by the trusted runtime; use the injected current admission id and do not probe or refresh it from the model`;
  }
  if (state?.verificationBlocked && exec?.name === 'bash'
    && controlledCommand?.executable === 'forge-verify'
    && !['status', 'watch', 'receipt'].includes(controlledCommand.action)) {
    return `${marker}: the controlled verification capability is unavailable for new execution; do not retry execution. Existing task jobs remain readable through forge-verify status and receipt; preserve the job and report the typed blocker without resubmitting it`;
  }
  if (controlledReleasePreparation) {
    const denial = controlledReleasePreparationDenialReason(state, controlledReleasePreparation, exec);
    if (denial) return denial;
  }
  if (controlledReleaseMutation) {
    if (state?.actionCeiling === 'read-only') {
      const preparationNextStep = ordinaryReadOnlyTaskPreparationEligible(state, {
        prepareTaskAvailable: state.prepareTaskAvailable,
      })
        ? ' 普通实施任务请先 prepare_task inspect，按需有界读取实际范围，再 prepare_task propose；实际权限以上游签发合同为准，status prepared 本身不等于 release 权限。'
        : '';
      return `${marker}: controlled ${controlledReleaseMutation.action} exceeds the protected contract ceiling read-only.${preparationNextStep}`;
    }
    const denial = controlledReleaseMutationDenialReason(state, controlledReleaseMutation);
    if (denial) return denial;
  }
  if (exec?.name === 'bash' && parseControlledEvidenceCommand(command) === null
    && controlledGovernanceInspection === null
    && controlledVerificationInspection === null
    && controlledReleaseInspection === null
    && controlledReleasePreparation === null
    && controlledReleaseMutation === null
    && controlledDelivery === null) {
    return `${marker}: arbitrary shell execution is outside the typed task protocol; use read/grep/glob/edit/write/remove_file for repository work and only exact forge-governance, forge-verify, forge-release or forge-delivery commands under their reviewed task authority`;
  }
  if (controlledDelivery !== null) {
    const denial = controlledDeliveryDenialReason(state, controlledDelivery, exec);
    if (denial) return denial;
  }
  if (state && controlledCommand?.executable === 'forge-verify' && controlledCommand.action === 'run') {
    const requestedProfile = controlledCommand.options['--profile'];
    const admission = state.verificationAdmission;
    if (!admissionCurrent(admission, admission?.profiles ?? [])) {
      if (ordinaryReadOnlyTaskPreparationEligible(state, { prepareTaskAvailable: state.prepareTaskAvailable })) {
        return `${marker}: current request has not prepared its task scope, so verification cannot use a prior turn's admission id. Continue in this conversation with prepare_task inspect, then prepare_task propose for the existing authorized scope. The trusted runtime will issue the current admission after scoped preparation; use that injected id. Do not ask the user to repeat authorization or rerun integration merely to obtain admission. Actual permissions remain those of the newly issued protected context.`;
      }
      return `${marker}: a current ready batch execution admission is required before verification run`;
    }
    if (controlledCommand.options['--admission-id'] !== admission.admissionId
      || !admittedVerificationProfile(requestedProfile, admission.profiles)) {
      const next = admittedVerificationProfile(requestedProfile, admission.profiles)
        ? 'This command was not executed; correct only --admission-id and continue this pending check.'
        : 'The requested profile is outside this admission; continue the required pending checks using only the listed profiles, without expanding scope.';
      return `${marker}: verification run must use the current batch admission id and one of its exact profiles. Current admissionId: ${admission.admissionId}. Allowed profiles: ${admission.profiles.join(', ')}. ${next} Do not rerun passed checks or ask the user to refresh admission or repeat authorization. The current ready admission already exists; do not call internal admission or re-prepare the task merely for this rejected command.`;
    }
  }
  if (!state?.suspendHeuristicStops && state?.phase === PHASES.CLOSEOUT) {
    if (controlledReleaseMutation !== null
      || (controlledReleaseInspection !== null && closeoutReleaseContractCurrent(state))
      || closeoutReleaseSkillAllowed(state, exec)) return undefined;
    return `${marker}: FINAL_ONLY is active after final audit and forge-evidence-truth; no further tool calls are allowed`;
  }
  if (state && !state.suspendHeuristicStops && stepRatio(state) >= 0.9) {
    const evidenceSkill = requestedSkill(exec) === 'forge-evidence-truth';
    const closeoutCommand = exec?.name === 'bash'
      && (isGovernanceExecution(exec) || typedVerificationRun || stoppedVerificationEvidence || CLOSEOUT_READ_COMMAND.test(command));
    const discoveryTool = isReadExecution(exec) && exec?.name !== 'bash' && exec?.name !== 'skill';
    const lateSkill = exec?.name === 'skill' && !evidenceSkill;
    const lateShell = exec?.name === 'bash' && !closeoutCommand;
    if (discoveryTool || lateSkill || lateShell) {
      return `${marker}: 90 percent of the step budget is consumed; only typed final governance/verification evidence, forge-evidence-truth, and the final status remain`;
    }
  }
  if (isBusinessDataMutationExecution(exec)) {
    if (!state?.protectedExecutionContextValidated || state.executionContextStatus !== 'ready'
      || !state.taskContract || !state.executionIdentity
      || !Number.isFinite(Date.parse(state.executionContextExpiresAt)) || Date.parse(state.executionContextExpiresAt) <= Date.now()) {
      return `${marker}: business-data mutation requires a current protected task and execution; the typed approval never replaces this binding`;
    }
    // The semantic deployment checks this exact operation against the AS-owned
    // current request at the Broker; tool arguments cannot supply user intent.
    if (process.env.FORGE_SEMANTIC_INTENT_ENABLED !== 'true'
      && !hasDirectBusinessDataIntent(state.prompt, normalizedArguments(exec).operation)) {
      return `${marker}: this data operation requires a current direct user instruction; code-write authority cannot authorize data changes`;
    }
    if (state.executionProjectionRequired && (state.executionProjectionStatus !== 'ready'
      || state.executionProjectionSnapshot?.state?.terminalOutcome !== null)) {
      return `${marker}: stopped or unavailable execution projection cannot dispatch a data mutation`;
    }
    if (typeof exec?.callId !== 'string' || !/^[^\p{Cc}]{1,256}$/u.test(exec.callId)) {
      return `${marker}: business-data mutation requires its stable native call id`;
    }
    // Approval consumption, replay rejection and cancellation are enforced in
    // the business database transaction. Workspace file leases and code RED
    // gates cannot grant data authority and are not data transaction locks.
    return undefined;
  }
  if (exec?.name === MANAGED_FILE_TOOL) {
    if (normalizedArguments(exec).operation === 'targets') return undefined;
    if (!state?.protectedExecutionContextValidated || state.executionContextStatus !== 'ready'
      || !state.taskContract || !state.executionIdentity || Date.parse(state.executionContextExpiresAt) <= Date.now()) {
      return `${marker}: registered server files require the current protected request; the AS checks the user's explicit directory instruction and account permission`;
    }
    return undefined;
  }
  if (!isMutationExecution(exec)) return undefined;
  if (!state) return `${marker}: phase state unavailable; write-capable calls fail closed`;
  if (state.executionContextStatus !== 'ready' || !state.taskContract || !state.executionIdentity) {
    return `${marker}: a protected Task Execution Contract and stable task/execution identity are required; natural-language write intent cannot authorize mutation`;
  }
  if (typeof state.executionContextExpiresAt !== 'string'
    || Date.parse(state.executionContextExpiresAt) <= Date.now()) {
    state.executionContextStatus = 'expired';
    return `${marker}: the protected execution context lease expired; mutation requires a newly signed lease or explicit new generation, never an implicit turn reset`;
  }
  if (state.promptReadOnlyConstraint || state.actionCeiling === 'read-only') {
    const preparationNextStep = ordinaryReadOnlyTaskPreparationEligible(
      state,
      { prepareTaskAvailable: state.prepareTaskAvailable },
    )
      ? ' For an implementation request, use prepare_task inspect, bounded repository reads, then prepare_task propose; write only after status prepared supplies the scoped writer context. Do not propose for a pure question.'
      : '';
    return `${marker}: the protected contract or current prompt constrains this execution to read-only; natural-language write intent cannot raise the ceiling.${preparationNextStep}`;
  }
  if (state.executionProjectionRequired && state.executionProjectionStatus !== 'ready') {
    return `${marker}: protected execution reducer projection is unavailable (${state.executionProjectionErrorCode ?? 'EXECUTION_PROJECTION_NOT_READY'}); write-capable calls fail closed`;
  }
  if (state.executionProjectionRequired) {
    const reducerState = state.executionProjectionSnapshot?.state;
    if (reducerState?.terminalOutcome !== null) {
      return `${marker}: protected execution reducer stopped as ${reducerState.terminalOutcome}; write-capable calls fail closed`;
    }
    if (!state.suspendHeuristicStops && isProductionSourceMutation(exec)
      && reducerState?.tddRequired
      && !['IMPLEMENT_INCREMENT', 'REPAIR'].includes(reducerState.phase)) {
      return `${marker}: a current typed failing-test receipt is required before production-source mutation; test-file creation or model narration does not close RED_GATE。${TEST_FIRST_NEXT_STEP}`;
    }
  }
  if (typeof exec?.callId !== 'string' || exec.callId.length < 1 || exec.callId.length > 256) {
    return `${marker}: write-capable calls require a stable call id for atomic reservation`;
  }
  if (state.settledWriterCalls.has(exec.callId)) {
    return `${marker}: write-capable call id was already settled and cannot be replayed`;
  }
  if (state.verificationBlocked && !candidateWriteAdmissionCurrent(state) && !draftBeforeVerification(state)) {
    return `${marker}: the required batch execution capability is unavailable; stop before mutation and close with the typed platform blocker`;
  }
  if (exec?.name === 'bash') {
    return `${marker}: shell-based workspace mutation has no typed owned path and fails closed; use structured edit/write/remove_file tools so the Task Execution Contract can classify the exact path`;
  }
  const ratio = stepRatio(state);
  if (!state.suspendHeuristicStops && state.routerSequence === 0) return `${marker}: invoke forge-task-router successfully before the first mutation`;
  let contract;
  try {
    contract = candidateTaskContract(state, exec);
  } catch (error) {
    return `${marker}: Task Execution Contract rejected this mutation (${error?.code ?? 'CONTRACT_INVALID'}: ${error?.message ?? 'unknown contract error'})`;
  }
  if (!contract) return `${marker}: source mutation is outside the protected contract's repository-relative owned paths and fails closed`;
  if (DEPENDENCY_MANIFEST_PATH.test(contractPathFromMutation(exec)) && !draftBeforeVerification(state)) {
    return `${marker}: dependency-manifest mutation requires a separately prepared candidate-cache admission; the current source-bound admission cannot authorize an unprepared dependency graph`;
  }
  const requiredBeforeMutation = contract.requiredSkills.filter((skill) => skill !== 'forge-evidence-truth');
  const missingContractSkills = requiredBeforeMutation.filter((skill) => !state.invokedSkills.has(skill));
  if (!state.suspendHeuristicStops && missingContractSkills.length > 0) {
    return `${marker}: Task Execution Contract ${contract.contractId.slice(0, 12)} requires exact Skills before this mutation: ${missingContractSkills.join(', ')}`;
  }
  if (!state.suspendHeuristicStops && state.domainSkillSequence === 0) return `${marker}: invoke every exact routed Forge domain Skill successfully before the first mutation`;
  const requiredProfiles = requiredExecutionProfiles(contract, state);
  if (!admissionCurrent(state.verificationAdmission, requiredProfiles)
    && !candidateWriteAdmissionCurrent(state) && !draftBeforeVerification(state)) {
    return `${marker}: preflight requires one current batch execution admission before mutation: ${admissionCommand(requiredProfiles)}`;
  }
  if (!state.suspendHeuristicStops && isSourceMutation(exec)) {
    const missing = REQUIRED_SOURCE_MUTATION_SKILLS.filter((skill) => !state.invokedSkills.has(skill));
    if (missing.length > 0) return `${marker}: invoke the routed source-change Skills before mutation: ${missing.join(', ')}`;
  }
  if (!state.suspendHeuristicStops && (state.tddRequired || contract.tddRequired)
    && isProductionSourceMutation(exec) && state.testMutationSequence === 0) {
    return `${marker}: this task has an explicit test-first contract; create the focused regression test before the first production-source mutation。${TEST_FIRST_NEXT_STEP}`;
  }
  if (!state.suspendHeuristicStops && state.mutationCount === 0 && ratio >= 0.5) {
    return `${marker}: the first mutation deadline has passed; close with a bounded status instead of starting implementation late`;
  }
  const sameRepairReservation = state.repairMutationReservations.has(exec?.callId);
  const repairMutationTotal = state.repairMutationCount + state.repairMutationReservations.size
    - (sameRepairReservation ? 1 : 0);
  if (!state.suspendHeuristicStops && state.repairAvailable && repairMutationTotal >= MAX_REPAIR_MUTATIONS) {
    return `${marker}: the bounded REPAIR mutation limit is exhausted; re-run the failed verification and close truthfully`;
  }
  const inFlightWriters = activeWriterReservations(state, exec);
  if (!state.suspendHeuristicStops && state.mutationCount + inFlightWriters >= MAX_TOTAL_MUTATIONS) {
    return `${marker}: the bounded writer mutation limit is exhausted or fully reserved by in-flight calls`;
  }
  if (!state.suspendHeuristicStops && state.mutationsSinceAudit + inFlightWriters >= MAX_MUTATIONS_WITHOUT_AUDIT) {
    return `${marker}: run the narrowest forge-governance audit before another mutation`;
  }
  if (!state.suspendHeuristicStops && ratio >= 0.75) {
    if (!state.repairAvailable) {
      return `${marker}: the final 25 percent is reserved for verification and closeout; mutations require the single bounded REPAIR window opened by a failed verification`;
    }
  }
  if (!state.suspendHeuristicStops && state.phase === PHASES.CLOSEOUT) {
    return `${marker}: closeout evidence was already collected; a new mutation requires a new turn`;
  }
  if (state.progressDecision
    && ['STOP', 'ESCALATE_AT_IMMUTABLE_BOUNDARY', 'RESERVE_CLOSEOUT'].includes(state.progressDecision.decision)) {
    if (!(staleOperation === 'write' && staleCreateStop(state))) {
      return `${marker}: ${state.progressDecision.reasonCodes.join(', ')}; ordinary mutation is closed, preserve the current immutable evidence and issue a truthful bounded closeout`;
    }
  }
  return undefined;
}

function reserveAllowedAttempt(state, exec) {
  if (!state) return state;
  if (isMutationExecution(exec)) {
    if (typeof exec?.callId !== 'string' || exec.callId.length < 1 || exec.callId.length > 256) {
      throw new Error('write-capable calls require a stable reservation id');
    }
    const shape = writerAttemptShape(exec);
    const existing = state.writerReservations.get(exec.callId);
    if (existing !== undefined && existing.shape !== shape) {
      throw new Error('write-capable call id changed shape after reservation');
    }
    if (existing === undefined) {
      state.writerReservations.set(exec.callId, {
        callId: exec.callId,
        shape,
        allowed: false,
        reservedAt: new Date().toISOString(),
      });
    }
  }
  if (isDependencyExecution(exec) && state.dependencyFailureCount > 0 && !state.dependencyRetryReserved) {
    state.dependencyRetryReserved = true;
    state.dependencyRetryCallId = exec.callId ?? '';
  }
  if (isMutationExecution(exec) && state.repairAvailable && exec.callId) {
    state.repairMutationReservations.add(exec.callId);
  }
  return state;
}

function settleWriterAttempt(state, exec) {
  if (!state || !isMutationExecution(exec) || typeof exec?.callId !== 'string') return true;
  if (state.settledWriterCalls.has(exec.callId)) return false;
  state.writerReservations.delete(exec.callId);
  state.settledWriterCalls.add(exec.callId);
  return true;
}

function observeToolResult(state, exec, result, writerFact) {
  state.sequence += 1;
  const sequence = state.sequence;
  const failed = resultFailed(result);
  if (!directDevelopmentEnabled(state.taskContract)) observeStaleCreate(state, exec, result, writerFact);
  const skill = requestedSkill(exec);
  if (skill && !failed) {
    state.invokedSkills.add(skill);
    if (skill === 'forge-task-router') state.routerSequence = sequence;
    else if (skill === 'forge-evidence-truth') state.evidenceSequence = sequence;
    else if (skill.startsWith('forge-') && !DOMAIN_SKILL_EXCLUSIONS.has(skill)) state.domainSkillSequence = sequence;
  }
  if (isMutationExecution(exec)) {
    state.mutationAttemptCount += 1;
    const repairMutation = state.repairMutationReservations.delete(exec.callId);
    if (!failed) {
      state.implementationSwitchRequired = false;
      if (isSourceMutation(exec) && exec?.name !== 'bash') {
        const relativePath = contractPathFromMutation(exec);
        if (relativePath) state.ownedPaths.add(relativePath);
      }
      state.mutationCount += 1;
      state.mutationSequence = sequence;
      state.mutationsSinceAudit += 1;
      state.auditSucceeded = false;
      if (repairMutation) state.repairMutationCount += 1;
      if (isTestMutation(exec)) state.testMutationSequence = sequence;
      else if (isProductionSourceMutation(exec)) state.productionMutationSequence = sequence;
    }
  }
  const observerCommand = exec?.name === 'bash' && normalizedArguments(exec).run_in_background === true
    ? parseControlledEvidenceCommand(commandOf(exec)) : null;
  const nativeObserverStarted = !failed && observerCommand?.action === 'watch'
    ? /^started background job (bash-[1-9]\d*)$/u.exec(resultText(result).trim()) : null;
  const integrationCommand = exec?.name === 'bash' && normalizedArguments(exec).run_in_background === true
    ? parseControlledReleaseMutationCommand(commandOf(exec)) : null;
  const nativeIntegrationStarted = !failed && ['checkpoint', 'integrate'].includes(integrationCommand?.action)
    ? /^started background job (bash-[1-9]\d*)$/u.exec(resultText(result).trim()) : null;
  if (nativeIntegrationStarted) {
    // Only the native acknowledgement binds later job_output to this admitted
    // command and execution. Its text alone is not a completed source transition.
    state.sourceTransitionJobs.set(nativeIntegrationStarted[1], {
      command: commandOf(exec), executionId: state.executionIdentity?.executionId,
      generation: state.executionContextGeneration, rpcId: state.executionRpcId,
      contractId: state.taskContract?.contractId,
    });
  }
  if (nativeObserverStarted) {
    // Native bash confirms only its observer process. Keep it distinct from
    // the Host job and do not clear failures or manufacture verification proof.
    state.verificationObserver = { jobId: observerCommand.options['--job-id'],
      nativeJobId: nativeObserverStarted[1], status: 'running' };
  }
  if (isVerificationExecution(exec) && !nativeObserverStarted) {
    const family = verificationFamily(exec);
    const controlled = parseControlledEvidenceCommand(commandOf(exec));
    const controlledReceipt = controlled
      ? controlledEvidenceReceipt(commandOf(exec), resultText(result))
      : undefined;
    if (!failed && controlled?.action === 'status' && controlledReceipt?.receipt?.active === false
      && controlledReceipt.receipt.jobId === state.verificationObserver?.jobId) {
      state.verificationObserver.status = 'finished';
    }
    const backgroundSubmission = controlled?.action === 'run'
      && controlledReceipt?.receipt?.receiptType === 'forge-verify/host-job';
    if (backgroundSubmission) {
      state.verificationBackgroundJobs.set(controlledReceipt.receipt.jobId, {
        jobId: controlledReceipt.receipt.jobId, receiptId: controlledReceipt.receipt.receiptId,
        profile: controlled.options['--profile'], admissionId: controlled.options['--admission-id'],
      });
    }
    const backgroundReceipt = controlled?.action === 'receipt'
      && controlledReceipt?.receipt?.receiptType === 'forge-verify/host-run'
      && [...state.verificationBackgroundJobs.values()].some((job) =>
        job.receiptId === controlledReceipt.receipt.receiptId
        && job.profile === controlledReceipt.receipt.request?.profile
        && job.admissionId === controlledReceipt.receipt.request?.admissionId
        && job.admissionId === state.verificationAdmission?.admissionId);
    const malformedControlledReceipt = controlled !== null && controlledReceipt === null
      && !controlledVerificationBlocked(exec, result);
    const typedRedGateFailure = controlled?.executable === 'forge-verify'
      && controlled.action === 'run'
      && controlledReceipt?.receipt?.receiptId === state.redGateEvidence?.sourceReceiptId;
    const typedRunSourceFailed = controlled?.executable === 'forge-verify'
      && ((controlled.action === 'run' && !backgroundSubmission) || backgroundReceipt)
      && controlledReceipt !== null
      && controlledReceipt?.receipt?.status !== 'passed'
      && controlledReceipt?.receipt?.truth?.verificationProven === false
      && !typedRedGateFailure;
    const governanceSourceFailed = controlled?.family === 'governance'
      && controlledReceipt !== null
      && controlledReceipt?.receipt?.ok === false;
    const untypedSourceFailed = controlled === null && failed;
    const sourceVerificationFailed = typedRunSourceFailed
      || governanceSourceFailed
      || untypedSourceFailed;
    // A valid optional diagnostic keeps its own failed receipt and findings;
    // it must not replace the mandatory verification state or consume repair.
    const optionalSourceQuality = controlled?.action === 'run'
      && controlled.options['--profile'] === 'backend-source-quality'
      && controlledReceipt?.receipt?.sourceQuality !== undefined;
    const effectiveFailed = failed || malformedControlledReceipt || typedRunSourceFailed;
    const verificationBlocked = controlledVerificationBlocked(exec, result);
    if (!optionalSourceQuality) {
      state.verificationSequence = sequence;
      state.verificationFailed = failed || verificationBlocked
        || malformedControlledReceipt || typedRunSourceFailed;
      if (verificationBlocked) state.verificationBlocked = true;
    }
    const productionHostGovernance = productionTaskWriterState(state)
      && controlled?.executable === 'forge-verify'
      && controlled.action === 'run'
      && controlled.options['--profile'] === 'governance';
    if (isGovernanceExecution(exec) || productionHostGovernance) {
      state.auditSequence = sequence;
      state.auditSucceeded = !failed && !malformedControlledReceipt
        && (productionHostGovernance
          ? controlledReceipt?.receipt?.status === 'passed'
            && controlledReceipt.receipt.truth?.verificationProven === true
          : controlledReceipt?.receipt?.ok === true);
      state.mutationsSinceAudit = 0;
    }
    if (controlled?.executable === 'forge-verify'
      && ['capability', 'run'].includes(controlled.action)
      && typeof controlled.options['--profile'] === 'string') {
      state.verificationProfileAttempts.set(controlled.options['--profile'], { sequence });
    }
    if (controlled?.executable === 'forge-verify'
      && controlled.action === 'capability'
      && typeof controlled.options['--profile'] === 'string') {
      state.verificationProfileCapabilities.set(controlled.options['--profile'], {
        sequence,
        outcome: controlledReceipt?.receipt?.outcome ?? (verificationBlocked ? 'blocked' : 'invalid'),
        receiptId: controlledReceipt?.receipt?.receiptId,
      });
    }
    if (controlled?.executable === 'forge-verify' && controlled.action === 'admit') {
      const receipt = controlledReceipt?.receipt;
      if (receipt?.outcome === 'ready') {
        state.verificationAdmission = {
          sequence,
          outcome: receipt.outcome,
          admissionId: receipt.admissionId,
          profiles: [...receipt.profiles],
          dependencyManifestFingerprint: receipt.source.dependencyManifestFingerprint,
          expiresAt: receipt.expiresAt,
          ...(receipt.receiptType === 'forge-verify/host-execution-admission' ? {
            executionMode: 'host-toolchain',
            toolchainDigest: receipt.toolchain.digest,
            profilePolicyDigest: receipt.profilePolicyDigest,
          } : {
            executionMode: 'container-cache',
            cachePackDigest: receipt.cache.packDigest,
          }),
        };
      } else if (receipt) {
        state.verificationAdmission = {
          sequence,
          outcome: receipt.outcome,
          profiles: [...receipt.profiles],
          reasonCode: receipt.reasonCode,
        };
        state.verificationBlocked = true;
      }
    }
    if (controlled?.executable === 'forge-verify'
      && (controlled.action === 'run' || backgroundReceipt)
      && controlledReceipt?.receipt?.status === 'passed'
      && controlledReceipt.receipt.truth?.verificationProven === true
      && !effectiveFailed) {
      state.verificationProfileReceipts.set(controlledReceipt.receipt.request.profile, {
        sequence,
        receiptId: controlledReceipt.receipt.receiptId,
      });
    }
    const closesRepairWindow = state.repairAvailable && family === state.repairVerificationFamily;
    if (closesRepairWindow) state.repairAvailable = false;
    if (sourceVerificationFailed && !optionalSourceQuality && state.mutationCount > 0
      && !dependencyFailureObserved(exec, result)
      && !verificationBlocked) {
      if (!state.repairWindowUsed) {
        state.repairWindowUsed = true;
        state.repairAvailable = true;
        state.repairVerificationFamily = family;
        state.repairMutationCount = 0;
        state.repairMutationReservations.clear();
      }
    }
    if (!effectiveFailed && closesRepairWindow) state.repairAvailable = false;
  }
  if (dependencyFailureObserved(exec, result)) {
    state.dependencyFailureCount += 1;
    state.dependencyClosed = state.dependencyRetryReserved || state.dependencyFailureCount >= 2;
    state.repairAvailable = false;
  }
  const text = resultText(result);
  const progressKeys = [];
  if (skill && !failed) progressKeys.push(`skill:${skill}`);
  if (isReadExecution(exec) && !failed && text.length > 0) {
    progressKeys.push(`source-fact:${progressDigest(text)}`);
  }
  if (isMutationExecution(exec) && !failed) {
    const relativePath = contractPathFromMutation(exec);
    if (relativePath) progressKeys.push(`mutation:${progressDigest(writerAttemptShape(exec))}`);
  }
  if (state.auditSucceeded) progressKeys.push('governance:passed');
  for (const [profile, receipt] of state.verificationProfileReceipts) {
    if (receipt.sequence === sequence) progressKeys.push(`verification:${profile}`);
  }
  state.progressObservations.push({
    requestOrdinal: state.currentStep,
    toolCallOrdinal: sequence,
    progressKeys: [...new Set(progressKeys)].sort(),
    actionDigest: progressDigest(writerAttemptShape(exec)),
    resultDigest: progressDigest(text),
    dependencyBlocked: dependencyFailureObserved(exec, result) || controlledVerificationBlocked(exec, result),
    capabilityProbe: isDependencyExecution(exec)
      || parseControlledEvidenceCommand(commandOf(exec))?.action === 'capability',
    safetyViolation: false,
  });
  if (state.progressObservations.length > 512) state.progressObservations.shift();
  advancePhase(state);
  state.progressDecision = evaluateProgress(state);
  if (state.progressDecision?.decision === 'SWITCH_TO_IMPLEMENT') {
    state.implementationSwitchRequired = true;
  }
  return state;
}

function operatorOwnsPhaseAcceptance(state, now = Date.now()) {
  return state?.executionContextStatus === 'ready'
    && state.protectedExecutionContextValidated === true
    && state.executionAuthorityClass === 'test-shadow-writer'
    && state.executionTestOnly === true
    && Date.parse(state.executionContextExpiresAt) > now
    && state.executionWorkflowId === 'crud-production'
    && typeof state.executionPhaseId === 'string' && state.executionPhaseId.length > 0
    && Number.isSafeInteger(state.executionPhaseIndex) && state.executionPhaseIndex >= 0
    && typeof state.executionPhaseCatalogVersion === 'string' && state.executionPhaseCatalogVersion.length > 0
    && typeof state.executionPhaseCatalogDigest === 'string' && state.executionPhaseCatalogDigest.length > 0
    && state.executionIdentity?.contractId === state.taskContract?.contractId
    && typeof state.executionIdentity?.contractId === 'string';
}

function closeoutBlockers(state) {
  if (!state || (state.mutationCount === 0 && state.dependencyFailureCount === 0)) return [];
  const blockers = [];
  if (state.mutationCount > 0 && state.auditSequence < state.mutationSequence) blockers.push('final-governance-audit-missing');
  if (state.taskContract && !candidateWriteAdmissionCurrent(state)) {
    for (const profile of state.taskContract.requiredVerificationProfiles) {
      if (profile === 'governance' && !productionTaskWriterState(state)) continue;
      const receipt = state.verificationProfileReceipts.get(profile);
      const attempt = state.verificationProfileAttempts.get(profile);
      if ((!receipt || receipt.sequence < state.mutationSequence)
        && (!attempt || attempt.sequence < state.mutationSequence)) {
        blockers.push(`typed-verification-profile-missing:${profile}`);
      }
    }
  }
  const evidenceBoundary = Math.max(state.mutationSequence, state.verificationSequence);
  if (!state.suspendHeuristicStops && state.evidenceSequence <= evidenceBoundary) blockers.push('forge-evidence-truth-missing-after-final-evidence');
  return blockers;
}

function phaseReminderForState(state, { removeFileAvailable = false } = {}) {
  const ratio = stepRatio(state);
  const percent = Math.round(ratio * 100);
  const blockers = closeoutBlockers(state);
  if (state.implementationSwitchRequired) {
    const missingSkills = state.taskContract?.requiredSkills
      ?.filter((skill) => skill !== 'forge-evidence-truth' && !state.invokedSkills.has(skill)) ?? [];
    const nextAction = productionWriterContextCurrent(state)
      ? 'implement within the current contract, run its missing typed verification on the existing candidate, or use its authorized controlled checkpoint/release path after the required Skill; this progress restriction does not revoke the contract action ceiling, and does not require a source edit before submission; do not edit solely to unlock verification'
      : 'produce the first contract-bound structured mutation before any further discovery';
    return `${PHASE_GUARD_MARKER}: IMPLEMENT NOW (${state.progressDecision?.reasonCodes?.join(', ') || 'DISCOVERY_STAGNATION'}). Ordinary discovery is closed. Invoke only missing routed Skills${missingSkills.length > 0 ? ` (${missingSkills.join(', ')})` : ''}, then ${nextAction}; all Task Contract, TDD, owned-path, admission, safety, and budget gates remain active.`;
  }
  if (state.progressDecision
    && ['STOP', 'ESCALATE_AT_IMMUTABLE_BOUNDARY', 'RESERVE_CLOSEOUT'].includes(state.progressDecision.decision)) {
    return `${PHASE_GUARD_MARKER}: machine progress gate=${state.progressDecision.decision} (${state.progressDecision.reasonCodes.join(', ')}). Do not continue ordinary discovery or mutation. Preserve the current immutable evidence, state every cannot-claim boundary, and issue a truthful bounded closeout.`;
  }
  if (!state.suspendHeuristicStops && ratio >= 0.9) {
    return `${PHASE_GUARD_MARKER}: CLOSEOUT (${percent}% of step budget). Do not mutate. Invoke forge-evidence-truth after the final verification and issue a truthful bounded final status. Pending: ${blockers.join(', ') || 'none'}.`;
  }
  if (!state.suspendHeuristicStops && ratio >= 0.75) {
    return `${PHASE_GUARD_MARKER}: VERIFY/CLOSEOUT (${percent}% of step budget). Ordinary mutations and broad discovery are closed; run affected tests and the final governance audit. One bounded REPAIR window (at most ${MAX_REPAIR_MUTATIONS} mutations) is available only after a failed verification.`;
  }
  if (!state.suspendHeuristicStops && ratio >= 0.5 && state.mutationCount === 0) {
    return `${PHASE_GUARD_MARKER}: IMPLEMENT deadline missed (${percent}% of step budget). Do not begin implementation late; preserve evidence and report a bounded blocker.`;
  }
  if (!state.suspendHeuristicStops && ratio >= 0.25 && state.mutationCount === 0) {
    return `${PHASE_GUARD_MARKER}: DISCOVER is ending (${percent}% of step budget). Finish the owner/consumer and obligation checks and produce the first coherent source increment before 50%.`;
  }
  if (state.phase === PHASES.ROUTE) {
    const intentSkills = state.taskIntent?.requiredSkills
      ?.filter((skill) => skill !== 'forge-evidence-truth').join(', ');
    const intentProfiles = requiredExecutionProfiles(state.taskIntent, state).join(', ');
    const admissionFact = !state.verificationBlocked && state.verificationAdmission?.outcome === 'ready'
      ? ` Platform execution admission is ready; use admissionId ${state.verificationAdmission.admissionId} for every forge-verify run.`
      : state.verificationBlocked
        ? candidateWriteAdmissionCurrent(state)
          ? ' Platform verification is unavailable, but the trusted test-shadow runner admitted candidate-only writes in this isolated workspace. Produce a reviewable patch; do not retry verification execution, but use forge-verify status and receipt to observe existing task jobs without resubmitting them. State that execution, verification, semantic, database, completion, and release proof remain false.'
          : ` Platform execution admission is blocked (${state.verificationAdmission?.reasonCode ?? state.admissionFailure?.code ?? 'unknown'}); do not start new verification. ${draftBeforeVerification(state) ? 'The current scoped draft may continue; validation and release remain unavailable until actual checks succeed.' : 'Unadmitted writes remain unavailable.'} Use forge-verify status and receipt to observe existing task jobs; preserve in-flight work, do not resubmit, and report the actual result and admission blocker truthfully.`
        : '';
    const exactIntent = intentSkills && intentProfiles
      ? ` ${state.suspendHeuristicStops ? 'Suggested task Skills' : 'Exact preflight Skills'}: ${intentSkills}. Exact batch admission profiles: ${intentProfiles}.${admissionFact}`
      : '';
    const routeDirective = state.suspendHeuristicStops
      ? 'Use relevant task Skills as guidance. Fixed Skill order and test-first drafting order are suspended. Implement and add focused tests in the order useful for the user goal; no RED receipt is required before a scoped draft edit. Required final tests remain mandatory for integration and release, and historical failures remain failures. Mutation still requires the protected contract, owned paths and current authority. Do not call forge-verify admit or invent admission IDs; only the trusted runtime issues admission. This does not prohibit the supported prepare_task path within an explicitly authorized request.'
      : candidateWriteAdmissionCurrent(state)
      ? 'Invoke forge-task-router and every routed domain Skill before the first structured candidate write. The trusted test-shadow cache-miss receipt authorizes only a reviewable isolated patch; it does not authorize verification or completion.'
      : 'Invoke forge-task-router and every routed domain Skill, then consume the trusted runtime\'s ready batch execution admission before mutation. Do not call forge-verify admit or invent admission IDs; only the trusted runtime issues admission. This does not prohibit the supported prepare_task path within an explicitly authorized request.';
    const removalFact = removeFileAvailable
      ? ' The currently registered remove_file tool can withdraw one task-owned ordinary file: first read(file_path), then remove_file(file_path). A prior-turn conclusion that no deletion tool exists is not a current runtime fact. Existing action-ceiling, owned-path, admission, and verification checks still apply.'
      : '';
    return `${PHASE_GUARD_MARKER}: ROUTE/PREFLIGHT. ${routeDirective} Define obligations and the narrow verification plan.${exactIntent}${removalFact}`;
  }
  return state.suspendHeuristicStops
    ? `${PHASE_GUARD_MARKER}: ${state.phase}. Implement coherent increments; final governance and required verification remain necessary for final contract closeout. Honor the current explicit candidate-only or focused-check scope: report that bounded result and leave other final obligations open; do not start additional governance, module tests or unrelated repairs to close them. The fixed intermediate audit cadence is suspended.`
    : `${PHASE_GUARD_MARKER}: ${state.phase}. Keep discovery bounded, implement coherent increments, and audit before more than ${MAX_MUTATIONS_WITHOUT_AUDIT} mutation calls accumulate.`;
}

function productionWriterContextCurrent(state) {
  return state?.executionContextStatus === 'ready'
    && state.protectedExecutionContextValidated === true
    && state.executionAuthorityClass === 'production-task-writer'
    && state.executionTestOnly === false
    && Date.parse(state.executionContextExpiresAt) > Date.now();
}

function ordinaryReadOnlyTaskPreparationEligible(
  state,
  { prepareTaskAvailable = false } = {},
  now = Date.now(),
) {
  return prepareTaskAvailable === true
    && state?.executionAuthorityClass === 'production-read-only'
    && state.promptReadOnlyConstraint !== true
    && prepareTaskDenialReason(state, {
      name: PREPARE_TASK_TOOL_NAME,
      arguments: { operation: 'propose' },
    }, now) === undefined;
}

function normalizedSha256(value) {
  if (typeof value !== 'string') return null;
  const digest = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return /^[0-9a-f]{64}$/u.test(digest) ? digest : null;
}

function currentContractMissingProofFact(state, projection) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)) return '';
  const { gateDigest, ...payload } = projection;
  const expectedProjectionKeys = [
    'attestation', 'blockers', 'candidateDiffSha256', 'cannotClaim', 'evaluatedAt',
    'evaluationMode', 'gateDigest', 'gateType', 'ledgerDigest', 'ledgerSummary',
    'ledgerSummaryDigest', 'maximumTerminalOutcome', 'outcome', 'schemaVersion',
    'signedVerdictVerified', 'sourceFingerprint',
  ];
  const ledger = projection.ledgerSummary;
  const counts = ledger?.counts;
  const evaluatedAt = Date.parse(projection.evaluatedAt);
  const blockerCodes = Array.isArray(projection.blockers)
    ? projection.blockers.map((blocker) => blocker?.code) : [];
  const expectedBlockerCodes = ['INDEPENDENT_VERDICT_REQUIRED', 'OBLIGATION_LEDGER_OPEN'];
  const sourceFingerprint = normalizedSha256(projection.sourceFingerprint);
  const admissionSourceFingerprint = normalizedSha256(
    state?.verificationAdmission?.sourceWorkspaceFingerprint,
  );
  let gateDigestMatches = false;
  try {
    gateDigestMatches = gateDigest === canonicalSha256(payload);
  } catch {
    gateDigestMatches = false;
  }
  const valid = hasExactKeys(projection, expectedProjectionKeys)
    && gateDigestMatches
    && projection.schemaVersion === 1
    && projection.gateType === 'forge-protected-completion-gate/v1'
    && projection.evaluationMode === 'read-only-verifier'
    && projection.attestation === 'local-integrity-only; upstream-authentication-is-ed25519'
    && projection.outcome === 'BOUNDED_BLOCKED'
    && projection.maximumTerminalOutcome === 'BOUNDED_BLOCKED'
    && projection.signedVerdictVerified === false
    && Array.isArray(projection.cannotClaim)
    && projection.cannotClaim.every((claim) => typeof claim === 'string')
    && typeof projection.candidateDiffSha256 === 'string'
    && normalizedSha256(projection.candidateDiffSha256) !== null
    && normalizedSha256(projection.ledgerDigest) !== null
    && normalizedSha256(projection.ledgerSummaryDigest) !== null
    && Number.isFinite(evaluatedAt)
    && new Date(evaluatedAt).toISOString() === projection.evaluatedAt
    && ledger !== null && typeof ledger === 'object' && !Array.isArray(ledger)
    && ledger.summaryType === 'forge-obligation-ledger-summary/v1'
    && ledger.taskContractId === state?.taskContract?.contractId
    && normalizedSha256(ledger.sourceFingerprint) === admissionSourceFingerprint
    && normalizedSha256(ledger.ledgerDigest) === normalizedSha256(projection.ledgerDigest)
    && normalizedSha256(ledger.summaryDigest) === normalizedSha256(projection.ledgerSummaryDigest)
    && Number.isSafeInteger(counts?.total) && counts.total > 0
    && Number.isSafeInteger(counts?.open) && counts.open > 0
    && Number.isSafeInteger(counts?.closed) && counts.closed === 0
    && Number.isSafeInteger(counts?.stale) && counts.stale === 0
    && counts.total === counts.open
    && Array.isArray(ledger.open) && ledger.open.length === counts.open
    && Array.isArray(ledger.closed) && ledger.closed.length === 0
    && Array.isArray(ledger.stale) && ledger.stale.length === 0
    && Array.isArray(projection.blockers)
    && projection.blockers.every((blocker) => blocker !== null
      && typeof blocker === 'object' && !Array.isArray(blocker)
      && typeof blocker.code === 'string' && typeof blocker.detail === 'string')
    && blockerCodes.length === expectedBlockerCodes.length
    && sameOrderedValues(blockerCodes, expectedBlockerCodes)
    && sourceFingerprint !== null
    && sourceFingerprint === admissionSourceFingerprint;
  if (!valid) return '';
  const requiredProfiles = state.taskContract.requiredVerificationProfiles.join(', ');
  return ` Current protected completion projection for contractId ${state.taskContract.contractId}, sourceFingerprint sha256:${sourceFingerprint}, evaluatedAt ${projection.evaluatedAt} is BOUNDED_BLOCKED with signedVerdictVerified=false, ${counts.open} open/0 closed/0 stale obligations, and blockers INDEPENDENT_VERDICT_REQUIRED + OBLIGATION_LEDGER_OPEN. This is the current observation, not a permanent stop or a requirement to enable external model review. For authorized final contract closeout, use the supported receipt revalidation path for unchanged source and compatible evidence; run only missing or invalid required profiles with current admission ID ${state.verificationAdmission.admissionId}: ${requiredProfiles}. These final obligations remain open during intermediate work; do not expand an explicitly bounded candidate or diagnostic request merely to close them. A focused pass is not final contract acceptance. Historical receipts count only after current protected acceptance accepts their bindings. Do not edit code solely to refresh proof; do not treat unrelated UAT as a current code-contract prerequisite.`;
}

function currentContractCompletionFact(state, projection) {
  const sourceFingerprint = normalizedSha256(projection?.sourceFingerprint);
  const ledger = projection?.ledgerSummary;
  const counts = ledger?.counts;
  if (protectedCompletionProjectionReady(projection)
    && ledger?.taskContractId === state?.taskContract?.contractId
    && sourceFingerprint !== null
    && sourceFingerprint === normalizedSha256(state?.verificationAdmission?.sourceWorkspaceFingerprint)
    && Number.isSafeInteger(counts?.total) && counts.total > 0
    && counts.closed === counts.total && counts.stale === 0) {
    return ` Current protected completion projection for contractId ${state.taskContract.contractId}, sourceFingerprint sha256:${sourceFingerprint}, evaluatedAt ${projection.evaluatedAt} is READY with signedVerdictVerified=true and ${counts.closed}/${counts.total} obligations closed. This current bound observation supersedes earlier BOUNDED_BLOCKED notices for this candidate. It is not a new verification run or a release. Continue only the authorized remaining work; do not rerun accepted checks or request external model review merely because an earlier notice was blocked.`;
  }
  return currentContractMissingProofFact(state, projection);
}

function readOnlyAcceptanceStatusRequested(state, prompt) {
  // An ordinary implementation request also starts in a read-only preparation
  // context. Its background evidence must not turn it into a status question.
  const request = prompt.trim().match(/^[^。；;！？!?\r\n]*(?:[。；;！？!?]|$)/u)?.[0] ?? '';
  const observesStatus = /[？?]\s*$|^(?:(?:请|帮我)\s*)?(?:核对|查看|查询|检查|确认|报告|说明|告诉我)|^(?:please\s+)?(?:check|show|report|describe)\b/iu.test(request);
  return state?.executionContextStatus === 'ready'
    && state.protectedExecutionContextValidated === true
    && state.executionAuthorityClass === 'production-read-only'
    && state.executionTestOnly === false
    && Date.parse(state.executionContextExpiresAt) > Date.now()
    && observesStatus
    && /(?:当前|现在|目前|\bcurrent\b|\bnow\b)/iu.test(request)
    && /(?:验收|独审|阻塞|\bacceptance\b|\bblocked\b|\breview\b)/iu.test(request);
}

function readOnlyAcceptanceStatusFact(projection) {
  let facts = null;
  try {
    const { gateDigest, ...payload } = projection ?? {};
    if (gateDigest === canonicalSha256(payload)
      && projection.schemaVersion === 1
      && projection.gateType === 'forge-protected-completion-gate/v1'
      && projection.evaluationMode === 'read-only-verifier'
      && projection.attestation === 'local-integrity-only; upstream-authentication-is-ed25519'
      && ['READY', 'BOUNDED_BLOCKED'].includes(projection.outcome)
      && (projection.outcome !== 'READY' || protectedCompletionProjectionReady(projection))
      && typeof projection.signedVerdictVerified === 'boolean'
      && typeof projection.ledgerSummary?.taskContractId === 'string'
      && normalizedSha256(projection.sourceFingerprint) !== null
      && Number.isFinite(Date.parse(projection.evaluatedAt))
      && Array.isArray(projection.blockers)
      && projection.blockers.every(blocker => /^[A-Z][A-Z0-9_]{0,95}$/u.test(blocker?.code ?? ''))) {
      facts = JSON.stringify({ taskContractId: projection.ledgerSummary.taskContractId,
        sourceFingerprint: projection.sourceFingerprint, evaluatedAt: projection.evaluatedAt,
        outcome: projection.outcome, signedVerdictVerified: projection.signedVerdictVerified,
        blockerCodes: [...new Set(projection.blockers.map(blocker => blocker.code))] });
    }
  } catch { /* An unavailable observation is unknown, never a successful status. */ }
  return ` Current acceptance status requested: ${facts ?? 'current acceptance status could not be established; do not claim current READY or no blockers from earlier dialogue'}. This is a read-only observation and does not authorize a new check, renewal, code change or release. Historical passed tests remain historical passes; an expired acceptance lease does not mean those tests failed or that external model review is required. If the user explicitly requested receipt revalidation, use the existing prepare_task and receipt reuse path within that request; otherwise report the current status without forcing renewal. Do not rerun passed checks merely to answer a status question.`;
}

function reminderForState(state, protectedCompletionProjection = null, capabilities = undefined) {
  if (directToolExecutionEnabled(state) && state.executionContextStatus === 'unavailable') {
    return `${PHASE_GUARD_MARKER}: current request authorization context is unavailable (${state.executionContextFailureCode ?? 'EXECUTION_CONTEXT_UNAVAILABLE'}). Prior-turn authority does not authorize this turn. Report the platform binding failure, not an expired authorization or a request for repeated user approval.`;
  }
  if (directToolExecutionEnabled(state)) return `FORGE_DIRECT_DEVELOPMENT_V1: The current protected execution ceiling is ${state.actionCeiling}; this does not authorize every available action. Use the current native conversation and its full context to follow the user's actual request, including explicit read-only requests, pauses, prohibited saves and publication limits. Interpret plan selections and confirmations in that context without asking for repeated authorization. Work directly in this isolated TaskSpace. No task proposal, owned-file list, fixed phase, mandatory Skill order, RED-first rule or fixed verification list is required. Use the isolated worker for ordinary commands, scripts and Git history analysis; read-only requests use a read-only workspace. Choose checks for the actual change. Respect read-only and stop requests. Platform files, credentials, Git metadata and other workspaces remain protected. Git checkpoint/integration/release use the supported Forge clients and their actual authorization. A failed command is a real failure; repair and continue the same authorized task without repeating confirmation. Never claim unrun checks or an uncompleted release succeeded.`;
  const taskPreparationFact = ordinaryReadOnlyTaskPreparationEligible(state, capabilities)
    ? ' This is a validated ordinary read-only task-preparation context and prepare_task is available in this turn. For an implementation request or explicitly authorized receipt revalidation, call prepare_task with operation inspect, perform only the bounded repository reads needed to identify the exact scope, then call prepare_task with operation propose. For receipt revalidation, preserve unchanged source and reuse only evidence accepted under the new protected context; preparation alone is not acceptance. Do not propose for a pure question; answer it read-only. Write only after prepare_task returns status prepared and the protected context carries the resulting scoped writer authority. Historical Skills or prior read-only conclusions do not replace this current-turn sequence; prepare_task does not automatically authorize writes.'
    : '';
  const progressPolicyFact = state.suspendHeuristicStops
    ? ' No-progress, repeated-result, and fractional-step heuristic stops are suspended. This notice does not report a wall-clock deadline. Continue the next necessary contract-authorized action; do not end an unfinished task merely because you estimate insufficient time for the whole remaining workflow. For a long command, use the existing native background execution and collect that same job after its completion notice. Report time or budget exhaustion only when an actual runtime result establishes it; preserve that result and the supported continuation path. Real permissions, owned paths, admission, required verification, and hard resource limits remain active.'
    : '';
  const acceptanceStatusFact = capabilities?.readOnlyAcceptanceStatusRequested
    ? readOnlyAcceptanceStatusFact(protectedCompletionProjection) : '';
  const directive = `${phaseReminderForState(state, capabilities)}${taskPreparationFact}${progressPolicyFact}${acceptanceStatusFact}`;
  if (state?.previousCompletion) {
    const completion = state.previousCompletion;
    return `${directive} 同一候选已于 ${completion.acceptedAt} 完成合同范围代码验收（contractId ${completion.contractId}；sourceCommit ${completion.sourceCommit}；workspaceFingerprint ${completion.workspaceFingerprint}；recordDigest ${completion.recordDigest}；verdictDigest ${completion.verdictDigest}；gateDigest ${completion.gateDigest}）。这不是本轮新验证或新发布授权。当前没有新增实施指令，本轮只读说明结果/待办；不为刷新租约重跑，不自行改代码或提交发布。需要新的改动/重新验证/发版时请用户说明具体动作。`;
  }
  if (!productionWriterContextCurrent(state)
    || !/^[0-9a-f]{40}$/u.test(state.executionSourceCommit ?? '')) return directive;
  const authorityFact = ` Current protected task actionCeiling: ${state.actionCeiling}, contractId: ${state.taskContract.contractId}.`
    + (state.actionCeiling === 'release'
      ? ` The current user request authorizes controlled checkpoint and release, plus controlled integrate; a progress restriction is not a missing release grant. ${controlledIntegrateDiscoveryContract()} Controlled sync is not READY or released. A trusted same-content checkpoint can refresh authority in the same RPC and formally revalidate existing Host receipts. After a trusted completed integrate, continue in the same RPC only after the protected context advances to the integrated source and a new execution generation; obtain fresh admission and fresh acceptance for that source. Old-source checks cannot satisfy the integrated candidate. An arbitrary source change does not authorize continuation. Existing Broker verification and integration-version checks still apply.`
      : state.actionCeiling === 'git-checkpoint'
        ? ' The current user request authorizes controlled checkpoint; release still requires an explicit release request.'
        : ' This scope authorizes workspace changes and required checks; checkpoint or release requires an explicit request.');
  const admission = state.verificationAdmission;
  const verificationReady = !state.verificationBlocked
    && admissionCurrent(admission, requiredExecutionProfiles(state.taskContract, state));
  const admissionFact = verificationReady
    ? ` Current verification admissionId: ${admission.admissionId}. Use this current ID for every forge-verify run; an earlier source-bound ID is stale after a write. Run profiles sequentially with a distinct idempotency key per profile. Backend compilation, module tests and focused diagnostics, full-regression, frontend-admin-build and unfiltered frontend-admin-test default to Host background submission. Preserve the returned jobId. Start one forge-verify watch --job-id <jobId> using bash run_in_background: true; retain its native bash job ID. Harness will notify this session on completion. Continue independent reads or report pending status instead of repeatedly long-polling. On the native completion notice read job_output, then use forge-verify receipt for the terminal receiptId to collect actual proof. Use forge-verify status --job-id <jobId> without --wait-seconds for an immediate observation; on continuation observe that same job first. Do not mutate verification inputs while it is active, resubmit it, or treat accepted or a watcher exit as verification proof. A client wait limit is not the Host execution deadline.`
    : ' Current verification admission is unavailable; do not use an earlier admission ID for execution. Existing task jobs remain readable through forge-verify status and receipt; preserve the job and do not resubmit while active.';
  const governanceFact = verificationReady
    && admission.profiles.includes('governance')
    ? ` When governance is within the current requested verification scope, run forge-verify run --profile governance --admission-id ${admission.admissionId} --idempotency-key <distinct-key>; the Host binds the trusted governance base. Its availability does not add it to an explicitly bounded candidate or diagnostic request.`
    : '';
  const missingProofFact = verificationReady
    ? currentContractCompletionFact(state, protectedCompletionProjection) : '';
  return `${directive}${authorityFact}${admissionFact}${governanceFact}${missingProofFact}`;
}

function reminderKey(state) {
  const ratio = stepRatio(state);
  const band = ratio >= 0.9 ? '90' : ratio >= 0.75 ? '75' : ratio >= 0.5 ? '50' : ratio >= 0.25 ? '25' : '0';
  return `${state.phase}:${band}:${state.mutationCount > 0}:${state.dependencyClosed}:${state.prepareTaskAvailable === true}:${state.verificationBlocked}:${state.verificationAdmission?.admissionId ?? state.verificationAdmission?.outcome ?? state.admissionFailure?.code ?? 'none'}`;
}

async function modelFacingToolAvailable(ctx, agent, toolName) {
  if (!ctx?.systemPrompt || typeof ctx.systemPrompt.assemble !== 'function'
    || !agent || typeof toolName !== 'string' || toolName.length === 0) return false;
  try {
    const assembly = await ctx.systemPrompt.assemble({ scope: agent });
    return Array.isArray(assembly?.tools)
      && assembly.tools.some((tool) => tool?.name === toolName);
  } catch {
    return false;
  }
}

function latestAssistantIdentity(agent, turn) {
  const events = Array.isArray(agent?.session?.events) ? agent.session.events : [];
  const event = events.findLast((entry) => entry?.type === 'assistant/message' && entry.data?.turn === turn);
  return event?.data?.message?.id ?? event?.seq ?? event;
}

function deliveredCloseoutCorrectionCount(agent, turn) {
  const events = Array.isArray(agent?.session?.events) ? agent.session.events : [];
  return events.filter((event) => event?.type === 'user/message'
    && event.data?.turn === turn
    && event.data?.message?.source?.kind === 'plugin'
    && event.data?.message?.source?.plugin === 'forge-phase-budget-guard'
    && event.data?.message?.source?.form === 'correction').length;
}

function installPhaseBudgetGuard(ctx, createUserMessage, {
  maxSteps = process.env.FORGE_PHASE_STEP_BUDGET,
  suspendHeuristicStops = true,
  admitExecution = createBrokerAdmissionClient(),
  resolveExecutionContext = createBrokerExecutionContextResolver(),
  resolveProtectedCompletion = null,
  resolveModelFacingTool = null,
  prepareTaskClient = createBrokerPrepareTaskClient(),
  executionStore,
  testShadowCandidateWriteMode = process.env.FORGE_TEST_SHADOW_CANDIDATE_WRITE,
  testShadowVerificationRunnerRevision = process.env.FORGE_TEST_SHADOW_VERIFICATION_RUNNER_REVISION,
} = {}) {
  const states = new WeakMap();
  // Native goal/delegation tools exist, but do not yet carry the protected
  // task authority/side-effect adapter. Do not advertise an unusable capability
  // in these sessions; native/free scopes keep their normal tool surface.
  const unsupportedProtectedTools = new Set([
    'create_goal', 'get_goal', 'update_goal', 'subagent', 'subagent_fork',
    'send_message', 'interrupt_agent',
  ]);
  const unsupportedProtectedSections = new Set(['tool:goal', 'tool:subagent', 'tool:subagent_fork']);
  ctx.on('system-prompt/assemble', async (_assembly, { scope }, next) => {
    const assembly = await next();
    if (states.get(scope)?.protectedExecutionContextValidated !== true) return assembly;
    return {
      ...assembly,
      tools: assembly.tools.filter((tool) => !unsupportedProtectedTools.has(tool.name)),
      sections: assembly.sections.filter((section) => !unsupportedProtectedSections.has(section.name)),
    };
  });
  const sourceTransitionResults = new WeakMap();
  const contextRefreshAttempts = new WeakMap();
  const executionStates = new Map();
  const configuredMaxSteps = boundedStepBudget(maxSteps);
  const testShadowCandidateWriteRequested = testShadowCandidateWriteMode
    === TEST_SHADOW_CANDIDATE_WRITE_MODE;
  const stateFor = (agent, turn, executionContext, directPromptRequiresContext = false) => {
    let state = states.get(agent);
    if (executionContext) {
      state = executionStates.get(executionContext.key);
      if (!state) {
        state = bindProtectedExecutionContext(
          createInitialPhaseState({ turn: Number.isSafeInteger(turn) ? turn : 0, maxSteps: configuredMaxSteps, suspendHeuristicStops }),
          executionContext,
          testShadowCandidateWriteRequested,
          testShadowVerificationRunnerRevision,
        );
        executionStates.set(executionContext.key, state);
      } else if (state.executionContextStatus === 'expired'
        && Date.parse(executionContext.expiresAt) <= Date.parse(state.executionContextExpiresAt)) {
        // Only a freshly renewed trusted lease can revive the same execution.
        // Its counters, receipts and call reservations are retained.
      } else {
        bindProtectedExecutionContext(
          state,
          executionContext,
          testShadowCandidateWriteRequested,
          testShadowVerificationRunnerRevision,
        );
      }
      states.set(agent, state);
    } else if (!state) {
      state = createInitialPhaseState({ turn: Number.isSafeInteger(turn) ? turn : 0, maxSteps: configuredMaxSteps, suspendHeuristicStops });
      states.set(agent, state);
    } else if (directPromptRequiresContext && state.executionContextStatus === 'ready') {
      // Tool-driven continuation steps legitimately carry an empty claimed
      // message batch. They remain inside the current protected execution and
      // must not erase its identity. A newly claimed direct user prompt is a
      // new authority boundary, so failure to bind that prompt still revokes
      // the prior ready context and fails closed.
      state.executionContextStatus = 'unavailable';
    }
    if (executionStore) {
      state.executionProjectionRequired = true;
      state.executionProjectionStore = executionStore;
      if (state.executionProjectionStatus === 'disabled') state.executionProjectionStatus = 'pending';
    }
    const nextTurn = Number.isSafeInteger(turn) ? turn : state.turn;
    if (nextTurn !== state.turn) {
      state.turn = nextTurn;
      state.turnStepBase = state.currentStep;
      state.lastObservedTurnStep = 0;
      state.lastReminderKey = '';
      state.stoppingIdentity = undefined;
    }
    return state;
  };

  const refreshCurrentContext = async (agent, completedTransition = null, boundary = null) => {
    const current = agent ? states.get(agent) : undefined;
    const checkpoint = completedTransition ?? current?.pendingSourceTransition ?? null;
    const integrated = checkpoint?.phase === 'integrated';
    const database = checkpoint === null && isRenewableWorkflowPhaseWriter({ authorityClass: current?.executionAuthorityClass,
      testOnly: current?.executionTestOnly, workflowId: current?.executionWorkflowId,
      phaseId: current?.executionPhaseId, phaseIndex: current?.executionPhaseIndex,
      actionCeiling: current?.actionCeiling, ownedPaths: current?.taskContract?.ownedPaths });
    if ((!current?.suspendHeuristicStops && checkpoint === null && !database) || !current?.protectedExecutionContextValidated
      || current.executionAuthorityClass !== 'production-task-writer' || !['workspace-write', 'git-checkpoint', 'release'].includes(current.actionCeiling)
      || (current.executionWorkflowId !== null && !database) || current.executionTestOnly
      || (!['ready', 'expired'].includes(current.executionContextStatus) && checkpoint === null)
      || (checkpoint === null && Date.parse(current.executionContextExpiresAt) > Date.now() + 30_000)
      || typeof resolveExecutionContext !== 'function') return current;
    const turn = boundary?.turn ?? current.turn;
    const step = boundary?.step ?? current.lastObservedTurnStep;
    const key = JSON.stringify([current.executionIdentity, current.executionContextGeneration,
      current.executionRpcId, current.executionDshSessionId, current.executionSourceCommit,
      current.executionWorkspaceFingerprint, current.executionContextExpiresAt,
      checkpoint?.phase, checkpoint?.operationId, checkpoint?.to?.head, checkpoint?.to?.fingerprint, checkpoint?.digest]);
    const previous = contextRefreshAttempts.get(agent);
    if (previous?.key === key && (!previous.settled || (previous.turn === turn
      && previous.step === step
      && (!previous.succeeded || Date.parse(current.executionContextExpiresAt) > Date.now())))) return previous.promise;
    // Coalesce unchanged lookups within this model step. The next existing
    // step remains a recovery boundary after a transient failure.
    const attempt = { key, turn, step, settled: false, succeeded: false, promise: null };
    contextRefreshAttempts.set(agent, attempt);
    if (checkpoint !== null) {
      // Resume this completed source transition at an existing boundary after
      // a transport failure; never replay the checkpoint or integration.
      current.pendingSourceTransition = checkpoint;
      current.executionContextStatus = 'unavailable';
      current.verificationAdmission = undefined;
      current.completionGateDigest = undefined;
      current.completionVerificationSequence = current.verificationSequence - 1;
      current.lastReminderKey = '';
    }
    attempt.promise = (async () => { try {
      const renewed = normalizeProtectedExecutionContext(await resolveExecutionContext({
        agent, turn: current.turn, step: current.currentStep, decision: { kind: 'enter', messages: [] },
        sourceTransition: checkpoint,
        renewal: checkpoint === null ? { rpcId: current.executionRpcId, dshSessionId: current.executionDshSessionId } : null,
      }));
      const sameExecution = integrated
        ? renewed.executionId !== current.executionIdentity.executionId
          && renewed.claimId !== current.executionClaimId
          && renewed.generation === current.executionContextGeneration + 1
        : renewed.executionId === current.executionIdentity.executionId
          && renewed.generation === current.executionContextGeneration;
      if (!sameExecution
        || renewed.contract.contractId !== current.taskContract.contractId
        || renewed.rpcId !== current.executionRpcId
        || (database && (!isRenewableWorkflowPhaseWriter({ ...renewed, actionCeiling: renewed.contract.actionCeiling,
          ownedPaths: renewed.contract.ownedPaths }) || renewed.sourceCommit !== current.executionSourceCommit
          || renewed.workspaceFingerprint !== current.executionWorkspaceFingerprint))
        || (integrated && (!renewed.protectedExecutionContextValidated
          || renewed.projectSlug !== current.executionProjectSlug || renewed.taskId !== current.executionIdentity.taskId
          || renewed.actorUserId !== current.executionActorUserId || renewed.actorUsername !== current.executionActorUsername
          || renewed.conversationId !== current.executionConversationId || renewed.dshSessionId !== current.executionDshSessionId
          || renewed.textDigest !== current.executionTextDigest || renewed.authorityClass !== 'production-task-writer'
          || renewed.testOnly !== false || renewed.workflowId !== null
          || !['git-checkpoint', 'release'].includes(renewed.contract.actionCeiling)
          || renewed.contract.actionCeiling !== current.actionCeiling))
        || (checkpoint !== null && (renewed.sourceCommit !== checkpoint.to.head
          || renewed.workspaceFingerprint !== checkpoint.to.fingerprint))) {
        current.executionContextFailureCode = 'EXECUTION_CONTEXT_IDENTITY_MISMATCH';
        return current;
      }
      const refreshed = stateFor(agent, current.turn, renewed);
      refreshed.executionContextFailureCode = undefined;
      attempt.succeeded = true;
      if (integrated) {
        refreshed.prompt = current.prompt;
        refreshed.promptReadOnlyConstraint = current.promptReadOnlyConstraint;
        refreshed.completionVerificationSequence = -1;
      }
      if (checkpoint !== null) delete refreshed.pendingSourceTransition;
      if (checkpoint?.phase === 'review-base-advanced') {
        refreshed.lastReviewBaseTransitionOperationId = checkpoint.operationId;
      }
      return refreshed;
    } catch (error) {
      current.executionContextFailureCode = /^[A-Z][A-Z0-9_]{1,79}$/u.test(error?.code ?? '') ? error.code
        : /^([A-Z][A-Z0-9_]{1,79}):/u.exec(error?.message ?? '')?.[1] ?? 'EXECUTION_CONTEXT_RENEWAL_FAILED';
      return current;
    } finally { attempt.settled = true; } })();
    return attempt.promise;
  };

  const prepareTask = async (args, exec) => {
    const agent = exec?.agent;
    const state = agent ? states.get(agent) : undefined;
    const denial = prepareTaskDenialReason(state, { ...exec, name: PREPARE_TASK_TOOL_NAME, arguments: args });
    if (denial) throw Object.assign(new Error(denial), { code: 'PREPARE_TASK_DENIED' });
    if (typeof prepareTaskClient !== 'function') {
      throw Object.assign(new Error('The trusted prepare_task Broker client is unavailable.'), { code: 'PREPARE_TASK_UNAVAILABLE' });
    }
    if (typeof state.executionProjectSlug !== 'string' || typeof state.executionActorUserId !== 'string'
      || typeof state.executionConversationId !== 'string' || typeof state.executionDshSessionId !== 'string'
      || typeof state.executionRpcId !== 'string' || typeof state.executionTextDigest !== 'string'
      || agent?.session?.id !== state.executionDshSessionId || typeof state.prompt !== 'string'
      || state.prompt.trim().length === 0) {
      throw Object.assign(new Error('The current ordinary prompt identity is unavailable.'), { code: 'PREPARE_TASK_IDENTITY_UNAVAILABLE' });
    }
    const request = {
      action: PREPARE_TASK_ACTION,
      operation: args.operation,
      lookup: {
        projectSlug: state.executionProjectSlug,
        taskId: state.executionIdentity.taskId,
        conversationId: state.executionConversationId,
        actorUserId: state.executionActorUserId,
        dshSessionId: state.executionDshSessionId,
        rpcId: state.executionRpcId,
        textDigest: state.executionTextDigest,
      },
      expectedExecutionId: state.executionIdentity.executionId,
      expectedGeneration: state.executionContextGeneration,
      promptText: state.prompt,
      ...(args.operation === 'propose' ? { proposal: args.proposal } : {}),
    };
    const result = validatePrepareTaskResult(await prepareTaskClient(request));
    if (result.status !== 'prepared') return result;

    const nextContext = normalizeProtectedExecutionContext(result.context);
    const sameIdentity = nextContext.projectSlug === state.executionProjectSlug
      && nextContext.taskId === state.executionIdentity.taskId
      && nextContext.actorUserId === state.executionActorUserId
      && nextContext.conversationId === state.executionConversationId
      && nextContext.dshSessionId === state.executionDshSessionId
      && nextContext.rpcId === state.executionRpcId
      && nextContext.textDigest === state.executionTextDigest;
    if (!sameIdentity || nextContext.authorityClass !== 'production-task-writer'
      || nextContext.testOnly !== false
      || (nextContext.workflowId !== null && nextContext.workflowId !== undefined)
      || typeof nextContext.sourceCommit !== 'string'
      || typeof nextContext.workspaceFingerprint !== 'string'
      || (typeof state.executionSourceCommit === 'string' && nextContext.sourceCommit !== state.executionSourceCommit)
      || (typeof state.executionWorkspaceFingerprint === 'string'
        && nextContext.workspaceFingerprint !== state.executionWorkspaceFingerprint
        && !(directDevelopmentEnabled(state.taskContract) && directDevelopmentEnabled(nextContext.contract)))
      || !['workspace-write', 'git-checkpoint', 'release'].includes(nextContext.contract.actionCeiling)
      || result.currentTask === null
      || JSON.stringify(result.currentTask.ownedPaths) !== JSON.stringify(nextContext.contract.ownedPaths)
      || JSON.stringify(result.currentTask.taskProfiles) !== JSON.stringify(nextContext.contract.taskProfiles)) {
      throw Object.assign(new Error('The prepared task context does not match the current ordinary execution.'), { code: 'PREPARE_TASK_CONTEXT_MISMATCH' });
    }

    const advanced = nextContext.generation > state.executionContextGeneration;
    const idempotent = nextContext.generation === state.executionContextGeneration
      && nextContext.key === `${state.executionIdentity.taskId}\0${state.executionIdentity.executionId}\0${state.executionIdentity.contractId}\0${state.executionContextGeneration}`;
    if (!advanced && !idempotent) {
      throw Object.assign(new Error('prepare_task must advance the protected execution generation.'), { code: 'PREPARE_TASK_GENERATION_INVALID' });
    }

    let nextState = state;
    if (advanced) {
      nextState = stateFor(agent, state.turn, nextContext, false);
      nextState.prompt = state.prompt;
      nextState.promptReadOnlyConstraint = state.promptReadOnlyConstraint;
    }
    await refreshExecutionAdmission(nextState, admitExecution);
    const profiles = requiredExecutionProfiles(nextState.taskContract, nextState);
    if (!draftBeforeVerification(nextState) && (nextState.verificationBlocked
      || (profiles.length > 0 && !admissionCurrent(nextState.verificationAdmission, profiles)))) {
      const reason = nextState.verificationAdmission?.reasonCode
        ?? nextState.admissionFailure?.code ?? 'VERIFY_ADMISSION_UNAVAILABLE';
      throw Object.assign(new Error(`Prepared task execution admission failed (${reason}).`), { code: 'PREPARE_TASK_ADMISSION_FAILED' });
    }
    return result;
  };

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted) return decision;
    // Pinned Harness dispatches tools/result observers without awaiting them.
    // Do not publish a missing/stale admission while its completed source
    // transition is still refreshing the existing protected context.
    await sourceTransitionResults.get(agent);
    const directPromptRequiresContext = decision.messages
      .some((message) => message?.source?.kind === 'user');
    let executionContext;
    let executionContextFailureCode;
    if (directPromptRequiresContext && typeof resolveExecutionContext === 'function') {
      try {
        executionContext = normalizeProtectedExecutionContext(
          await resolveExecutionContext({ agent, turn, step, decision }),
        );
      } catch (error) {
        executionContextFailureCode = /^[A-Z][A-Z0-9_]{1,79}$/u.test(error?.code ?? '') ? error.code
          : /^([A-Z][A-Z0-9_]{1,79}):/u.exec(error?.message ?? '')?.[1] ?? 'EXECUTION_CONTEXT_BINDING_FAILED';
        executionContext = undefined;
      }
    }
    if (!directPromptRequiresContext) await refreshCurrentContext(agent, null, { turn, step });
    const state = stateFor(agent, turn, executionContext, directPromptRequiresContext);
    await reconcileBrowserAuthority(agent, directBrowserAuthority(state));
    if (directPromptRequiresContext) state.executionContextFailureCode = executionContext
      ? undefined : executionContextFailureCode ?? 'EXECUTION_CONTEXT_UNAVAILABLE';
    if (state.staleCreate?.stage?.endsWith('reserved')) {
      finishStaleCreate(state, 'cancelled', 'result-missing-before-next-step');
    }
    const directPromptText = decision.messages
      .filter((message) => message?.source?.kind === 'user')
      .flatMap((message) => message.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    if (directPromptText.trim().length > 0) {
      state.prompt = directPromptText;
      state.promptReadOnlyConstraint = process.env.FORGE_DEVELOPMENT_MODE === 'direct'
        ? state.actionCeiling === 'read-only' : promptAddsReadOnlyConstraint(directPromptText);
    }
    await refreshExecutionAdmission(state, admitExecution);
    let protectedCompletionProjection = null;
    const readOnlyStatusRequested = directPromptRequiresContext
      && readOnlyAcceptanceStatusRequested(state, directPromptText);
    if (!directDevelopmentEnabled(state.taskContract) && (directPromptRequiresContext || state.verificationSequence > state.completionVerificationSequence)
      && (productionWriterContextCurrent(state) || readOnlyStatusRequested)
      && !operatorOwnsPhaseAcceptance(state)
      && typeof resolveProtectedCompletion === 'function') {
      state.completionVerificationSequence = state.verificationSequence;
      try {
        protectedCompletionProjection = await resolveProtectedCompletion({ agent, turn });
        if (currentContractCompletionFact(state, protectedCompletionProjection)
          || (readOnlyStatusRequested && protectedCompletionProjection?.gateDigest)) {
          state.completionGateDigest = protectedCompletionProjection.gateDigest;
        }
      } catch {
        protectedCompletionProjection = null;
      }
    }
    if (EXPLICIT_TEST_FIRST_CONTRACT.test(directPromptText)) state.tddRequired = true;
    const observedTurnStep = Number.isSafeInteger(step) ? step : 0;
    state.lastObservedTurnStep = Math.max(state.lastObservedTurnStep, observedTurnStep);
    state.currentStep = Math.max(state.currentStep, state.turnStepBase + state.lastObservedTurnStep);
    advancePhase(state);
    state.progressDecision = evaluateProgress(state);
    await projectPhaseGuardState(state, 'agent.pre-step');
    const removeFileAvailable = state.phase === PHASES.ROUTE
      && typeof resolveModelFacingTool === 'function'
      && await resolveModelFacingTool({ agent, toolName: 'remove_file' });
    const prepareTaskAvailable = typeof resolveModelFacingTool === 'function'
      && await resolveModelFacingTool({ agent, toolName: PREPARE_TASK_TOOL_NAME });
    state.prepareTaskAvailable = prepareTaskAvailable;
    const key = `${reminderKey(state)}:${state.completionGateDigest ?? 'none'}`;
    const compaction = agent?.session?.events?.findLast((event) => event.type === 'compaction/summary');
    const compactionIdentity = compaction?.seq ?? compaction?.data?.compactionId ?? compaction;
    const sameCompaction = compactionIdentity === state.lastReminderCompaction;
    if (key === state.lastReminderKey && sameCompaction && !directPromptRequiresContext) return decision;
    state.lastReminderKey = key;
    const reminder = reminderForState(
      state,
      protectedCompletionProjection,
      { removeFileAvailable, prepareTaskAvailable, readOnlyAcceptanceStatusRequested: readOnlyStatusRequested },
    );
    const fullNotice = operatorOwnsPhaseAcceptance(state)
      ? reminder
      : `${reminder} ${ORDINARY_RESPONSE_CONTRACT}${directDevelopmentEnabled(state.taskContract) ? '' : ` ${ORDINARY_CONFIRMATION_GUIDANCE}`}`;
    const admission = state.verificationAdmission;
    const admissionId = productionWriterContextCurrent(state) && !state.verificationBlocked
      && admissionCurrent(admission, requiredExecutionProfiles(state.taskContract, state))
      ? admission.admissionId : '';
    // A write renews the source-bound ID, not the static policy. Keep every
    // authority/phase/completion change verbatim; only an ID-only update is terse.
    const policy = admissionId
      ? JSON.stringify([fullNotice.replaceAll(admissionId, '<current-admission-id>'), admission.profiles,
        state.taskContract?.contractId, state.actionCeiling, state.prompt])
      : '';
    const admissionOnly = admissionId && state.lastReminderAdmissionId
      && admissionId !== state.lastReminderAdmissionId && policy === state.lastReminderPolicy
      && sameCompaction && !directPromptRequiresContext;
    const notice = admissionOnly
      ? `${PHASE_GUARD_MARKER}: ${state.phase}. Current protected task actionCeiling: ${state.actionCeiling}, contractId: ${state.taskContract.contractId}. Current verification admissionId: ${admissionId}. This current-source ID replaces earlier admission IDs; use it for every forge-verify run. Previously supplied scope, verification, background-job and closeout rules remain in force.`
      : fullNotice;
    state.lastReminderPolicy = policy;
    state.lastReminderAdmissionId = admissionId;
    state.lastReminderCompaction = compactionIdentity;
    return {
      kind: 'enter',
      messages: [...decision.messages, createUserMessage({
        content: [{
          type: 'text',
          text: notice,
        }],
        source: { kind: 'plugin', plugin: 'forge-phase-budget-guard', form: 'notice' },
      })],
    };
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    let state;
    try { state = exec.agent ? states.get(exec.agent) : undefined; } catch { state = undefined; }
    const sourceReadAlreadyAllowed = ['read', 'grep', 'glob', 'ls', 'find'].includes(exec.name)
      && directDevelopmentEnabled(state?.taskContract) && toolDenialReason(state, exec) === undefined;
    const directAuthorityTool = directDevelopmentEnabled(state?.taskContract)
      && (READ_TOOLS.has(exec.name) || exec.name === 'bash' || exec.name === 'browser' || exec.name === 'skill');
    if (state && !sourceReadAlreadyAllowed && (directAuthorityTool || isMutationExecution(exec) || isBusinessDataMutationExecution(exec)
      || (exec.name === 'bash' && parseControlledReleaseMutationCommand(commandOf(exec)) !== null))) {
      state = await refreshCurrentContext(exec.agent);
    }
    await reconcileBrowserAuthority(exec.agent, directBrowserAuthority(state));
    let staleReservation;
    if (!directDevelopmentEnabled(state?.taskContract) && STALE_CREATE_STAGES.has(state?.staleCreate?.stage)) {
      if (state.staleCreate.stage.endsWith('reserved')) {
        return { kind: 'deny', reason: `${PHASE_GUARD_MARKER}: stale-create recovery already has one in-flight call` };
      }
      staleReservation = staleCreateOperation(state, exec);
      if (!staleReservation) {
        finishStaleCreate(state, 'consumed', 'unexpected-attempt');
        await projectPhaseGuardState(state, 'stale-create-consumed');
        return { kind: 'deny', reason: `${PHASE_GUARD_MARKER}: stale-create recovery permits only the next same-path read or one same-path write retry` };
      }
      const shapeDigest = progressDigest(writerAttemptShape(exec));
      state.staleCreate.stage = `${staleReservation}-reserved`;
      state.staleCreate.reservation = {
        reservationId: progressDigest(JSON.stringify({
          originCallId: state.staleCreate.originCallId,
          callId: exec.callId,
          shapeDigest,
          sequence: state.sequence,
        })),
        callId: exec.callId,
        shapeDigest,
        allowedObserved: false,
      };
    }
    const cancelStaleReservation = async (outcome) => {
      if (!staleReservation || !STALE_CREATE_STAGES.has(state?.staleCreate?.stage)) return;
      finishStaleCreate(state, 'cancelled', outcome);
      await projectPhaseGuardState(state, 'stale-create-cancelled');
    };
    const staleReservationCurrent = () => !staleReservation
      || (state.staleCreate?.stage === `${staleReservation}-reserved`
        && staleCreateOperation(state, exec) === staleReservation);
    const releaseMutation = async () => {
      if (!state || !isMutationExecution(exec)) return;
      state.writerReservations.delete(exec.callId);
      state.repairMutationReservations.delete(exec.callId);
      await settleProjectedMutation(state, exec, false);
    };
    let stalePreflightFailed = false;
    if (state && isSourceMutation(exec) && exec?.name !== 'bash' && typeof admitExecution === 'function') {
      try {
        const exactContract = candidateTaskContract(state, exec);
        if (exactContract) await refreshExecutionAdmission(state, admitExecution, Date.now(), exactContract);
      } catch {
        stalePreflightFailed = Boolean(staleReservation);
        // The normal policy path below reports the bounded fail-closed reason.
      }
    }
    if (state) await projectPhaseGuardState(state, 'tools.pre-execute');
    if (staleReservation && (!staleReservationCurrent() || stalePreflightFailed
      || (state.executionProjectionRequired && state.executionProjectionStatus !== 'ready'))) {
      await cancelStaleReservation('preflight-unavailable');
      return { kind: 'deny', reason: `${PHASE_GUARD_MARKER}: stale-create recovery preflight is unavailable` };
    }
    let reason = toolDenialReason(state, exec);
    if (reason) {
      await closeBrowserSession(exec.agent);
      await cancelStaleReservation('policy-denied');
      return { kind: 'deny', reason };
    }
    if (state && isMutationExecution(exec)) {
      await prepareProjectedMutation(state, exec);
      reason = staleReservationCurrent() ? toolDenialReason(state, exec)
        : `${PHASE_GUARD_MARKER}: stale-create recovery reservation is no longer current`;
      if (reason) {
        await releaseMutation();
        await cancelStaleReservation('mutation-projection-denied');
        return { kind: 'deny', reason };
      }
    }
    if (isMutationExecution(exec) && state?.writerReservations.has(exec.callId)) {
      await settleProjectedMutation(state, exec, false);
      await cancelStaleReservation('writer-already-reserved');
      return { kind: 'deny', reason: `${PHASE_GUARD_MARKER}: write-capable call id is already reserved by an in-flight execution` };
    }
    try {
      reserveAllowedAttempt(state, exec);
    } catch (error) {
      await releaseMutation();
      await cancelStaleReservation('writer-reservation-failed');
      return { kind: 'deny', reason: `${PHASE_GUARD_MARKER}: atomic writer reservation failed (${error instanceof Error ? error.message : 'unknown error'})` };
    }
    try {
      const downstream = await next();
      if (downstream.kind !== 'allow') await releaseMutation();
      if (downstream.kind !== 'allow') await cancelStaleReservation('downstream-denied');
      else {
        if (!staleReservationCurrent()) {
          await releaseMutation();
          return { kind: 'deny', reason: `${PHASE_GUARD_MARKER}: stale-create recovery reservation is no longer current` };
        }
        const writerReservation = state?.writerReservations.get(exec.callId);
        if (writerReservation) writerReservation.allowed = true;
        if (staleReservation) {
          state.staleCreate.reservation.allowedObserved = true;
          await projectPhaseGuardState(state, 'stale-create-allowed');
          if (!staleReservationCurrent()
            || (state.executionProjectionRequired && state.executionProjectionStatus !== 'ready')) {
            await releaseMutation();
            await cancelStaleReservation('allowed-projection-failed');
            return { kind: 'deny', reason: `${PHASE_GUARD_MARKER}: stale-create recovery projection failed closed` };
          }
        }
      }
      return downstream;
    } catch (error) {
      await releaseMutation();
      await cancelStaleReservation('downstream-failed');
      throw error;
    }
  });

  ctx.on('tools/execute', async (exec, next) => {
    const state = exec?.agent ? states.get(exec.agent) : undefined;
    if (!['bash', 'browser'].includes(exec?.name) || !directToolExecutionEnabled(state)) return next();
    const denial = toolDenialReason(state, exec);
    if (denial) { await closeBrowserSession(exec.agent); throw new Error(denial); }
    return withDirectToolPolicy(directBrowserAuthority(state), next);
  });

  ctx.tools.guard((exec) => {
    try {
      return toolDenialReason(exec.agent ? states.get(exec.agent) : undefined, exec);
    } catch (error) {
      if (!isWriterExecution(exec)) return undefined;
      return `${PHASE_GUARD_MARKER}: phase policy failed (${error instanceof Error ? error.message : 'unknown error'}); write-capable calls fail closed`;
    }
  });

  const observeResult = async (exec, result) => {
    if (!exec.agent) return;
    const state = states.get(exec.agent);
    if (!state) return;
    const mutation = isMutationExecution(exec);
    const writerFact = mutation ? admittedWriterFact(state, exec) : undefined;
    if (!settleWriterAttempt(state, exec)) return;
    if (mutation && !writerFact) return;
    if (!state.executionProjectionRequired || directDevelopmentEnabled(state.taskContract)) {
      observeToolResult(state, exec, result, writerFact);
      const checkpoint = successfulSourceTransition(state, exec, result);
      if (checkpoint !== null) await refreshCurrentContext(exec.agent, checkpoint);
      return;
    }
    await settleProjectedMutation(state, exec, !resultFailed(result));
    if (state.executionProjectionStatus !== 'failed') await projectTypedRedReceipt(state, exec, result);
    if (state.executionProjectionStatus === 'failed') {
      if (STALE_CREATE_STAGES.has(state.staleCreate?.stage)) {
        finishStaleCreate(state, 'cancelled', 'result-projection-failed');
      }
      observeToolResult(state, exec, result);
      return;
    }
    observeToolResult(state, exec, result, writerFact);
    await projectPhaseGuardState(state, 'tools.result');
    const checkpoint = successfulSourceTransition(state, exec, result);
    if (checkpoint !== null) await refreshCurrentContext(exec.agent, checkpoint);
    if (state.executionProjectionStatus === 'failed' && STALE_CREATE_STAGES.has(state.staleCreate?.stage)) {
      finishStaleCreate(state, 'cancelled', 'result-projection-failed');
    }
  };

  ctx.on('tools/result', (exec, result) => {
    const state = exec.agent ? states.get(exec.agent) : undefined;
    const transition = state ? successfulSourceTransition(state, exec, result) : null;
    const observed = observeResult(exec, result);
    if (transition !== null) {
      sourceTransitionResults.set(exec.agent, observed);
      const settled = () => {
        if (sourceTransitionResults.get(exec.agent) === observed) sourceTransitionResults.delete(exec.agent);
      };
      observed.then(settled, settled);
    }
    return observed;
  });

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const state = states.get(agent);
    if (state?.staleCreate?.stage?.endsWith('reserved')) {
      finishStaleCreate(state, 'cancelled', 'turn-stopped-before-result');
      void projectPhaseGuardState(state, 'stale-create-cancelled');
    }
    // A protected A9 turn submits a proposal. The operator runs Host profiles
    // and Controller acceptance after model exit; ending this turn proves neither.
    if (operatorOwnsPhaseAcceptance(state) || state?.suspendHeuristicStops) return;
    const blockers = closeoutBlockers(state);
    if (blockers.length === 0) return;
    const identity = latestAssistantIdentity(agent, turn);
    if (state.stoppingIdentity === identity) return;
    state.stoppingIdentity = identity;
    if (state.closeoutCorrections >= MAX_CLOSEOUT_CORRECTIONS) {
      agent.cancel({ kind: 'hook', reason: `${PHASE_GUARD_MARKER}: closeout obligations remained unsatisfied after one correction` });
      return;
    }
    state.closeoutCorrections += 1;
    agent.steer(createUserMessage({
      content: [{
        type: 'text',
        text: `${PHASE_GUARD_MARKER}: The turn cannot close yet. Resolve these machine-observed obligations: ${blockers.join(', ')}. Do not add ordinary implementation work. Run the missing final audit when required, invoke forge-evidence-truth after the final result, then issue a truthful bounded status.`,
      }],
      source: { kind: 'plugin', plugin: 'forge-phase-budget-guard', form: 'correction' },
    }));
  });

  const writerScopeContext = (exec) => {
    const state = exec?.agent && states.get(exec.agent);
    if (!state?.protectedExecutionContextValidated || state.executionContextStatus !== 'ready'
      || state.executionDshSessionId !== exec.agent.session?.id || !state.taskContract
      || Date.parse(state.executionContextExpiresAt) <= Date.now()) return null;
    return {
      projectSlug: state.executionProjectSlug, taskId: state.executionIdentity.taskId,
      actorUserId: state.executionActorUserId, conversationId: state.executionConversationId,
      dshSessionId: state.executionDshSessionId, rpcId: state.executionRpcId,
      textDigest: state.executionTextDigest, executionId: state.executionIdentity.executionId,
      generation: state.executionContextGeneration, contractId: state.taskContract.contractId,
      authorityClass: state.executionAuthorityClass, testOnly: state.executionTestOnly,
      actionCeiling: state.actionCeiling, contract: state.taskContract,
      sourceCommit: state.executionSourceCommit, workspaceFingerprint: state.executionWorkspaceFingerprint,
      issuedAt: state.executionContextIssuedAt, expiresAt: state.executionContextExpiresAt,
    };
  };
  const businessDataPreviewContext = (exec) => {
    const context = writerScopeContext(exec);
    return context ? { ...context, promptText: states.get(exec.agent).prompt } : null;
  };
  return { states, executionStates, stateFor, prepareTask, writerScopeContext, businessDataPreviewContext };
}

// Only the delivery store's lock/CAS transitions can overlap. This scheduling
// hint does not bypass tools/pre-execute or grant a writer context.
function isControlledDeliveryConcurrencySafe(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || args.run_in_background === true || args.sandbox_permissions !== undefined
    || args.justification !== undefined
    || (args.workdir !== undefined && !['.', '/workspace'].includes(args.workdir))) return false;
  if (Object.keys(args).some((key) => !['command', 'description', 'timeoutMs', 'workdir', 'run_in_background'].includes(key))) return false;
  const command = parseControlledDeliveryCommand(args.command);
  return command?.action === 'change.transition'
    && command.options['--to'] !== 'evidence-recorded'
    && command.options['--verification'] === undefined;
}

const deliveryConcurrencyWrappers = new WeakSet();
function installControlledDeliveryConcurrency(ctx) {
  const owned = [];
  const install = (agent) => {
    const tool = ctx.tools.get('bash', agent);
    if (!tool || deliveryConcurrencyWrappers.has(tool.isConcurrencySafe)) return;
    const previous = tool.isConcurrencySafe;
    const wrapper = (args) => previous?.call(tool, args) === true || isControlledDeliveryConcurrencySafe(args);
    deliveryConcurrencyWrappers.add(wrapper);
    tool.isConcurrencySafe = wrapper;
    owned.push({ tool, previous, wrapper });
  };
  install();
  const stop = ctx.on('tools/change', () => install());
  // Presets register model-facing tools in the agent scope. A global lookup
  // cannot see those definitions; prepare that same visible definition before
  // the loop classifies this step's tool calls.
  const stopStep = ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next();
    install(agent);
    return decision;
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    stopStep();
    for (const { tool, previous, wrapper } of owned) {
      if (tool.isConcurrencySafe !== wrapper) continue;
      if (previous === undefined) delete tool.isConcurrencySafe;
      else tool.isConcurrencySafe = previous;
    }
  };
  ctx.on('dispose', dispose);
  return dispose;
}

// Release waits for Broker/Runner's final result. Register that same command
// with native jobs after permission admission, so a foreground wait limit does
// not discard its result or leave the originating session without a wakeup.
function installControlledReleaseBackground(ctx, { environment = process.env } = {}) {
  return ctx.on('tools/execute', (exec, next) => {
    if (exec?.name === 'bash'
      && parseControlledReleaseMutationCommand(commandOf(exec))?.action === 'release') {
      // Direct-mode CLI observes one accepted operation for at most 15 minutes.
      // Keep that native job alive long enough to return its terminal/unknown result.
      if (environment.FORGE_DEVELOPMENT_MODE === 'direct') {
        exec.arguments = { ...exec.arguments, run_in_background: true, timeoutMs: 16 * 60 * 1000 };
      } else if (exec.arguments?.run_in_background !== true) {
        exec.arguments = { ...exec.arguments, run_in_background: true };
      }
    }
    return next();
  });
}

async function apply(ctx) {
  const { createUserMessage } = await import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-llm/lib/index.js');
  const { defineTool } = await import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  const controller = installPhaseBudgetGuard(ctx, createUserMessage, {
    resolveExecutionContext: createBrokerExecutionContextResolver(),
    resolveProtectedCompletion: resolveProtectedCompletionFromBroker,
    resolveModelFacingTool: ({ agent, toolName }) => modelFacingToolAvailable(ctx, agent, toolName),
  });
  registerPrepareTaskTool(ctx, defineTool, controller.prepareTask);
  registerManagedFileTool(ctx, defineTool, { resolveContext: controller.writerScopeContext, client: createManagedFileClient() });
  registerBusinessDataPreviewTool(ctx, defineTool, {
    resolveContext: controller.businessDataPreviewContext, client: createBrokerBusinessDataPreviewClient(),
  });
  registerBusinessDataApplyTool(ctx, defineTool, {
    resolveContext: controller.businessDataPreviewContext, client: createBrokerBusinessDataApplyClient(),
  });
  // Native pre-execute still owns permission and budget admission. This awaited
  // around-dispatch hook only holds project-wide path ownership through quiescence.
  installForgeWriterScopeLease(ctx, {
    resolveContext: controller.writerScopeContext, client: createBrokerWriterScopeLeaseClient(),
  });
  installControlledDeliveryConcurrency(ctx);
  installControlledReleaseBackground(ctx);
}

const name = 'forge-phase-budget-guard';

export {
  DEFAULT_MAX_STEPS,
  MAX_CLOSEOUT_CORRECTIONS,
  MAX_MUTATIONS_WITHOUT_AUDIT,
  MAX_REPAIR_MUTATIONS,
  PHASES,
  PHASE_GUARD_MARKER,
  REQUIRED_SOURCE_MUTATION_SKILLS,
  TEST_SHADOW_CANDIDATE_WRITE_MODE,
  advancePhase,
  actionCeilingForPrompt,
  apply,
  candidateWriteAdmissionCurrent,
  closeoutBlockers,
  createInitialPhaseState,
  dependencyFailureObserved,
  deliveredCloseoutCorrectionCount,
  installPhaseBudgetGuard,
  installControlledDeliveryConcurrency,
  installControlledReleaseBackground,
  isControlledDeliveryConcurrencySafe,
  describeGovernedTool,
  inject,
  isMutationExecution,
  isBusinessDataMutationExecution,
  modelFacingToolAvailable,
  isReadExecution,
  isSourceMutation,
  name,
  observeToolResult,
  phaseForState,
  prepareTaskDenialReason,
  reminderForState,
  reserveAllowedAttempt,
  resultFailed,
  stepRatio,
  toolDenialReason,
  verificationFamily,
};
