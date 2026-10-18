import crypto from 'node:crypto';
import { validateVerifyAction } from './verify-policy.mjs';
import { normalizeForgeTaskOwnedPath } from './forge-task-execution-contract.mjs';
import { validateBusinessDataPreviewProposal } from './forge-business-data-approval.mjs';
import { validateBusinessDataApplyArguments } from './forge-business-data-consumption.mjs';
import { validateManagedFileArguments } from './forge-managed-files.mjs';

export const TASKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
export const ACTOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const ACTOR_USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
// prepare_task carries the original user request, including referenced materials.
// Match the existing protected-acceptance JSON budget only for this action.
export const MAX_PREPARE_TASK_BODY_BYTES = 2 * 1024 * 1024;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const REPOSITORY_PATH_PATTERN = /^[A-Za-z0-9_./@=,+#\[\]-]{1,512}$/u;
const CHECKPOINT_IGNORED_PATH_PARTS = new Set([
  '.git', '.forge-cache', 'node_modules', 'target', 'dist', 'build', 'coverage', '.pnpm-store',
]);
const DSH_SESSION_ID_PATTERN = /^[^\0\r\n]{1,1024}$/u;
const RPC_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;

function canonicalJsonV1(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonV1(value[key])}`).join(',')}}`;
}

export function sourceTransitionCanonicalDigest(value) {
  return crypto.createHash('sha256').update(canonicalJsonV1(value), 'utf8').digest('hex');
}

export function validateSourceTransition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Source transition must be an object.');
  }
  exactKeys(value, [
    'schemaVersion', 'operationId', 'task', 'from', 'to', 'canonicalHead', 'phase',
    'sourceAuthority', 'digestAlgorithm', 'digestEncoding', 'digest',
  ], 'Source transition');
  exactKeys(value.task, [
    'projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId',
  ], 'Source transition task');
  exactKeys(value.from, ['head', 'fingerprint'], 'Source transition from');
  exactKeys(value.to, ['head', 'fingerprint'], 'Source transition to');
  exactKeys(value.sourceAuthority, [
    'executionId', 'generation', 'contractId', 'productionAuthorityDigest',
    'controllerGrantDigest', 'actionCeiling', 'issuedAt', 'expiresAt',
  ], 'Source transition authority');
  if (value.schemaVersion !== 1) throw new Error('Source transition schemaVersion is invalid.');
  requiredString(value.operationId, ACTOR_USER_ID_PATTERN, 'Source transition operationId');
  requiredString(value.task.projectSlug, TASKSPACE_ID_PATTERN, 'Source transition projectSlug');
  requiredString(value.task.taskId, TASKSPACE_ID_PATTERN, 'Source transition taskId');
  validateActorUserId(value.task.actorUserId);
  requiredString(value.task.actorUsername, ACTOR_ID_PATTERN, 'Source transition actorUsername');
  requiredString(value.task.conversationId, CONVERSATION_ID_PATTERN, 'Source transition conversationId');
  requiredString(value.task.dshSessionId, DSH_SESSION_ID_PATTERN, 'Source transition dshSessionId');
  requiredString(value.from.head, COMMIT_PATTERN, 'Source transition from.head');
  requiredString(value.from.fingerprint, DIGEST_PATTERN, 'Source transition from.fingerprint');
  requiredString(value.to.head, COMMIT_PATTERN, 'Source transition to.head');
  requiredString(value.to.fingerprint, DIGEST_PATTERN, 'Source transition to.fingerprint');
  requiredString(value.canonicalHead, COMMIT_PATTERN, 'Source transition canonicalHead');
  if (!['conflict-open', 'integrated', 'checkpointed'].includes(value.phase)) throw new Error('Source transition phase is invalid.');
  requiredString(value.sourceAuthority.executionId, ACTOR_USER_ID_PATTERN, 'Source transition executionId');
  if (!Number.isSafeInteger(value.sourceAuthority.generation) || value.sourceAuthority.generation < 1) {
    throw new Error('Source transition generation is invalid.');
  }
  requiredString(value.sourceAuthority.contractId, DIGEST_PATTERN, 'Source transition contractId');
  requiredString(value.sourceAuthority.productionAuthorityDigest, DIGEST_PATTERN, 'Source transition productionAuthorityDigest');
  requiredString(value.sourceAuthority.controllerGrantDigest, DIGEST_PATTERN, 'Source transition controllerGrantDigest');
  const allowedActionCeilings = ['git-checkpoint', 'release'];
  if (!allowedActionCeilings.includes(value.sourceAuthority.actionCeiling)) {
    throw new Error('Source transition actionCeiling is invalid.');
  }
  const issuedAt = Date.parse(value.sourceAuthority.issuedAt);
  const expiresAt = Date.parse(value.sourceAuthority.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error('Source transition authority timestamps are invalid.');
  }
  if (value.digestAlgorithm !== 'sha256' || value.digestEncoding !== 'canonical-json-v1') {
    throw new Error('Source transition digest encoding is invalid.');
  }
  requiredString(value.digest, DIGEST_PATTERN, 'Source transition digest');
  const { digest, ...payload } = value;
  if (digest !== sourceTransitionCanonicalDigest(payload)) throw new Error('Source transition digest is invalid.');
  return value;
}

function exactKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
  }
}

function requiredString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function validateCheckpointPath(value) {
  requiredString(value, REPOSITORY_PATH_PATTERN, 'checkpoint path');
  const segments = value.split('/');
  const testSourcePrefix = /^forge-server\/(?:[^/]+\/)*src\/test\/(?:java|resources)\//u.exec(value);
  const testSourceDepth = testSourcePrefix ? testSourcePrefix[0].split('/').length - 1 : Infinity;
  if (value.startsWith('/') || segments.some((segment, index) => segment === ''
    || segment === '.'
    || segment === '..'
    || (CHECKPOINT_IGNORED_PATH_PARTS.has(segment)
      && !(segment === 'coverage' && index >= testSourceDepth && index < segments.length - 1)))) {
    throw new Error('checkpoint path must be a safe repository-relative source path.');
  }
  return value;
}

export function validateTaskspaceMetadata(value, expectedProjectSlug) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TaskSpace metadata must be an object.');
  }
  if (![1, 2].includes(value.schemaVersion)) throw new Error('Unsupported TaskSpace metadata schema.');
  exactKeys(value, [
    'schemaVersion',
    'projectSlug',
    'taskId',
    'actorId',
    ...(value.schemaVersion === 2 ? ['actorUserId', 'runtimeVersion'] : []),
    'conversationId',
    'branch',
    'baseCommit',
    'status',
    'createdAt',
    'updatedAt',
    'accessTokenHash',
    'harnessPort',
    'accessMode',
    'lastCandidate',
    'lastRelease',
  ], 'TaskSpace metadata');
  const projectSlug = requiredString(value.projectSlug, TASKSPACE_ID_PATTERN, 'projectSlug');
  if (expectedProjectSlug !== undefined && projectSlug !== expectedProjectSlug) {
    throw new Error('TaskSpace project does not match this broker.');
  }
  const taskId = requiredString(value.taskId, TASKSPACE_ID_PATTERN, 'taskId');
  const actorId = requiredString(value.actorId, ACTOR_ID_PATTERN, 'actorId');
  if (value.schemaVersion === 2) validateActorUserId(value.actorUserId);
  if (value.runtimeVersion !== undefined) {
    const runtime = value.runtimeVersion;
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) {
      throw new Error('TaskSpace runtime version must be an object.');
    }
    requiredString(runtime.channel, /^(?:stable|enhanced)$/u, 'runtimeVersion.channel');
    requiredString(runtime.versionId, DIGEST_PATTERN, 'runtimeVersion.versionId');
    requiredString(runtime.sourceCommit, COMMIT_PATTERN, 'runtimeVersion.sourceCommit');
    if (!(runtime.channel === 'stable' ? ['32.12', 'codex/env-3212-ai'] : ['main']).includes(runtime.sourceBranch)) {
      throw new Error('TaskSpace runtime branch does not match its channel.');
    }
  }
  const conversationId = requiredString(
    value.conversationId,
    CONVERSATION_ID_PATTERN,
    'conversationId',
  );
  if (typeof value.branch !== 'string' || value.branch !== `task/${actorId}/${taskId}`) {
    throw new Error('TaskSpace branch does not match its actor and task identity.');
  }
  requiredString(value.baseCommit, COMMIT_PATTERN, 'baseCommit');
  if (!['active', 'stopped', 'closed', 'provisioning-failed'].includes(value.status)) {
    throw new Error('TaskSpace status is invalid.');
  }
  if (!Number.isInteger(value.harnessPort) || value.harnessPort < 1 || value.harnessPort > 65535) {
    throw new Error('TaskSpace Harness port is invalid.');
  }
  if (value.accessMode !== undefined && !['token', 'conversation'].includes(value.accessMode)) {
    throw new Error('TaskSpace access mode is invalid.');
  }
  if (typeof value.accessTokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.accessTokenHash)) {
    throw new Error('TaskSpace access-token hash is invalid.');
  }
  for (const name of ['createdAt', 'updatedAt']) {
    if (typeof value[name] !== 'string' || Number.isNaN(Date.parse(value[name]))) {
      throw new Error(`TaskSpace ${name} is invalid.`);
    }
  }
  return value;
}

export function validateActorUserId(value) {
  return requiredString(value, ACTOR_USER_ID_PATTERN, 'actorUserId');
}

export function taskspaceSupportsProtectedExecution(metadata) {
  return metadata?.schemaVersion === 2
    && typeof metadata.actorUserId === 'string'
    && ACTOR_USER_ID_PATTERN.test(metadata.actorUserId)
    && metadata.accessMode === 'conversation'
    && metadata.status === 'active';
}

export function validateTaskspaceAction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('TaskSpace action must be an object.');
  }
  const action = value.action;
  if (![
    'contract', 'diagnose', 'preflight', 'plan', 'status', 'logs', 'submit', 'release', 'checkpoint', 'integrate', 'prepare',
    'execution-context', 'prepare-task', 'writer-scope-lease', 'business-data-preview', 'business-data-apply',
    'protected-completion', 'managed-files',
    'verify-admit', 'verify-capability', 'verify-run', 'verify-status', 'verify-receipt', 'verify-review',
  ].includes(action)) {
    throw new Error('TaskSpace action is not allowed.');
  }
  if (action === 'logs') {
    exactKeys(value, ['action', 'services', 'tail', 'sinceSeconds'], 'Runtime logs');
    const tail = value.tail === undefined ? 200 : value.tail;
    if (!Number.isSafeInteger(tail) || tail < 1 || tail > 1000) {
      throw new Error('Runtime log tail must be an integer from 1 to 1000.');
    }
    if (value.services !== undefined && (!Array.isArray(value.services)
      || value.services.length < 1 || value.services.length > 4
      || new Set(value.services).size !== value.services.length
      || value.services.some(service => !['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'].includes(service)))) {
      throw new Error('Runtime log services must name unique project business services.');
    }
    if (value.sinceSeconds !== undefined && (!Number.isSafeInteger(value.sinceSeconds)
      || value.sinceSeconds < 1 || value.sinceSeconds > 86400)) {
      throw new Error('Runtime log sinceSeconds must be an integer from 1 to 86400.');
    }
    return { action, tail,
      ...(value.services === undefined ? {} : { services: [...value.services] }),
      ...(value.sinceSeconds === undefined ? {} : { sinceSeconds: value.sinceSeconds }) };
  }
  if (action === 'managed-files') {
    if (value.operation === 'targets') {
      exactKeys(value, ['action', 'operation'], 'Managed targets');
      return { action, ...validateManagedFileArguments({ operation: 'targets' }) };
    }
    const { action: _action, lookup: rawLookup, expectedExecutionId, expectedGeneration, ...args } = value;
    const { action: _lookupAction, ...lookup } = validateTaskspaceAction({ ...rawLookup, action: 'execution-context' });
    if (!lookup.dshSessionId || !lookup.rpcId || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) throw new Error('Managed files require the current protected request.');
    return { action, ...validateManagedFileArguments(args), lookup,
      expectedExecutionId: validateActorUserId(expectedExecutionId), expectedGeneration };
  }
  if (action.startsWith('verify-')) {
    const verifyAction = action.slice('verify-'.length);
    const validated = validateVerifyAction({ ...value, action: verifyAction });
    return { ...validated, action };
  }
  if (action === 'writer-scope-lease') {
    const suppliedPermit = value.operation !== 'acquire' || Object.hasOwn(value, 'permitId');
    exactKeys(value, ['action', 'operation', 'projectSlug', 'taskId', 'actorUserId', 'conversationId',
      'dshSessionId', 'rpcId', 'textDigest', 'executionId', 'generation', 'contractId',
      'callId', 'toolName', 'filePath', ...(suppliedPermit ? ['permitId'] : [])], 'Writer scope lease');
    if (!['acquire', 'settle', 'cancel-acquire'].includes(value.operation)) throw new Error('Writer scope operation is invalid.');
    const { action: _contextAction, ...lookup } = validateTaskspaceAction({
      action: 'execution-context', projectSlug: value.projectSlug, taskId: value.taskId,
      actorUserId: value.actorUserId, conversationId: value.conversationId,
      dshSessionId: requiredString(value.dshSessionId, DSH_SESSION_ID_PATTERN, 'dshSessionId'),
      rpcId: requiredString(value.rpcId, RPC_ID_PATTERN, 'rpcId'), textDigest: value.textDigest,
    });
    if (!Number.isSafeInteger(value.generation) || value.generation < 1
      || !['write', 'edit', 'remove_file', 'copy_file'].includes(value.toolName)) {
      throw new Error('Writer scope generation or tool is invalid.');
    }
    const filePath = normalizeForgeTaskOwnedPath(value.filePath);
    if (filePath !== value.filePath) {
      throw new Error('Writer scope path must be canonical and repository-relative.');
    }
    return { action, operation: value.operation, ...lookup,
      executionId: validateActorUserId(value.executionId), generation: value.generation,
      contractId: requiredString(value.contractId, DIGEST_PATTERN, 'contractId'),
      callId: requiredString(value.callId, /^[^\p{Cc}]{1,256}$/u, 'callId'),
      toolName: value.toolName, filePath,
      ...(suppliedPermit ? { permitId: validateActorUserId(value.permitId) } : {}),
    };
  }
  if (action === 'business-data-apply') {
    exactKeys(value, ['action', 'operation', 'request', 'attestation', 'proposal', 'lookup', 'expectedExecutionId', 'expectedGeneration', 'promptText', 'callId'], 'Business data apply');
    if (!value.lookup || Object.hasOwn(value.lookup, 'action')) throw new Error('Business data apply requires its exact protected execution lookup.');
    const { action: _lookupAction, ...lookup } = validateTaskspaceAction({ ...value.lookup, action: 'execution-context' });
    if (!lookup.dshSessionId || !lookup.rpcId || !Number.isSafeInteger(value.expectedGeneration) || value.expectedGeneration < 1
      || typeof value.promptText !== 'string' || Buffer.byteLength(value.promptText, 'utf8') < 1 || Buffer.byteLength(value.promptText, 'utf8') > 48 * 1024) {
      throw new Error('Business data apply requires the current bounded user request and execution identity.');
    }
    return { action, ...validateBusinessDataApplyArguments({ operation: value.operation, request: value.request, attestation: value.attestation, proposal: value.proposal }), lookup,
      expectedExecutionId: validateActorUserId(value.expectedExecutionId), expectedGeneration: value.expectedGeneration,
      promptText: value.promptText, callId: requiredString(value.callId, /^[^\p{Cc}]{1,256}$/u, 'callId') };
  }
  if (action === 'business-data-preview') {
    exactKeys(value, ['action', 'operation', 'proposal', 'lookup', 'expectedExecutionId', 'expectedGeneration', 'promptText', 'callId'], 'Business data preview');
    if (value.operation !== 'request' || !value.lookup || Object.hasOwn(value.lookup, 'action')) {
      throw new Error('Business data preview supports only a non-writing request.');
    }
    const { action: _lookupAction, ...lookup } = validateTaskspaceAction({ ...value.lookup, action: 'execution-context' });
    if (!lookup.dshSessionId || !lookup.rpcId || !Number.isSafeInteger(value.expectedGeneration)
      || value.expectedGeneration < 1 || typeof value.promptText !== 'string'
      || Buffer.byteLength(value.promptText, 'utf8') < 1 || Buffer.byteLength(value.promptText, 'utf8') > 48 * 1024) {
      throw new Error('Business data preview requires the current bounded user request and execution identity.');
    }
    return { action, operation: 'request', proposal: validateBusinessDataPreviewProposal(value.proposal), lookup,
      expectedExecutionId: validateActorUserId(value.expectedExecutionId), expectedGeneration: value.expectedGeneration,
      promptText: value.promptText, callId: requiredString(value.callId, /^[^\p{Cc}]{1,256}$/u, 'callId') };
  }
  if (action === 'prepare-task') {
    exactKeys(value, ['action', 'operation', 'lookup', 'expectedExecutionId', 'expectedGeneration', 'promptText',
      ...(Object.hasOwn(value, 'proposal') ? ['proposal'] : [])], 'Task preparation action');
    if (!['inspect', 'propose'].includes(value.operation)
      || (value.operation === 'propose') !== Object.hasOwn(value, 'proposal')) {
      throw new Error('Task preparation requires inspect or one explicit proposal.');
    }
    if (!value.lookup || typeof value.lookup !== 'object' || Array.isArray(value.lookup)
      || Object.hasOwn(value.lookup, 'action')) throw new Error('Task preparation lookup is invalid.');
    const { action: _lookupAction, ...lookup } = validateTaskspaceAction({ ...value.lookup, action: 'execution-context' });
    if (!lookup.dshSessionId || !lookup.rpcId || !Number.isSafeInteger(value.expectedGeneration)
      || value.expectedGeneration < 1 || typeof value.promptText !== 'string'
      || Buffer.byteLength(value.promptText, 'utf8') < 1 || Buffer.byteLength(value.promptText, 'utf8') > MAX_PREPARE_TASK_BODY_BYTES) {
      throw new Error('Task preparation requires a bounded original user request and execution identity.');
    }
    return { action, operation: value.operation, lookup,
      expectedExecutionId: validateActorUserId(value.expectedExecutionId),
      expectedGeneration: value.expectedGeneration, promptText: value.promptText,
      ...(value.operation === 'propose' ? { proposal: value.proposal } : {}) };
  }
  if (action === 'execution-context') {
    exactKeys(value, [
      'action',
      'projectSlug',
      'taskId',
      'conversationId',
      'actorUserId',
      'dshSessionId',
      'rpcId',
      'textDigest',
    ], 'TaskSpace execution-context action');
    const result = {
      action,
      projectSlug: requiredString(value.projectSlug, TASKSPACE_ID_PATTERN, 'projectSlug'),
      taskId: requiredString(value.taskId, TASKSPACE_ID_PATTERN, 'taskId'),
      conversationId: requiredString(value.conversationId, CONVERSATION_ID_PATTERN, 'conversationId'),
      actorUserId: validateActorUserId(value.actorUserId),
      textDigest: requiredString(value.textDigest, DIGEST_PATTERN, 'textDigest'),
    };
    if (value.dshSessionId !== undefined) {
      result.dshSessionId = requiredString(value.dshSessionId, DSH_SESSION_ID_PATTERN, 'dshSessionId');
    }
    if (value.rpcId !== undefined) {
      result.rpcId = requiredString(value.rpcId, RPC_ID_PATTERN, 'rpcId');
    }
    return result;
  }
  if (action === 'prepare') {
    exactKeys(value, ['action', 'expectedHead', 'expectedFingerprint', 'probePlan'], 'TaskSpace prepare action');
    if (!value.probePlan || typeof value.probePlan !== 'object' || Array.isArray(value.probePlan)
      || Buffer.byteLength(JSON.stringify(value.probePlan), 'utf8') > 32 * 1024) {
      throw new Error('prepare probePlan must be a JSON object of at most 32 KiB.');
    }
    // This is only a typed transport. Broker derives authority from the private
    // preparation context; Runner validates every structured probe before use.
    return { action, expectedHead: requiredString(value.expectedHead, COMMIT_PATTERN, 'expectedHead'),
      expectedFingerprint: requiredString(value.expectedFingerprint, DIGEST_PATTERN, 'expectedFingerprint'),
      probePlan: value.probePlan };
  }
  if (action === 'checkpoint') {
    exactKeys(value, [
      'action', 'paths', 'message', 'expectedHead', 'expectedWorkspaceFingerprint',
    ], 'TaskSpace checkpoint action');
    if (!Array.isArray(value.paths) || value.paths.length < 1) {
      throw new Error('checkpoint paths must contain at least one item.');
    }
    const paths = value.paths.map(validateCheckpointPath);
    if (new Set(paths).size !== paths.length) throw new Error('checkpoint paths must be unique.');
    if (typeof value.message !== 'string'
      || Buffer.byteLength(value.message, 'utf8') < 1
      || Buffer.byteLength(value.message, 'utf8') > 500
      || new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value.message, 'utf8')) !== value.message
      || /[\p{Cc}]/u.test(value.message)) {
      throw new Error('checkpoint message is invalid.');
    }
    return {
      action,
      paths,
      message: value.message,
      expectedHead: requiredString(value.expectedHead, COMMIT_PATTERN, 'expectedHead'),
      expectedWorkspaceFingerprint: requiredString(
        value.expectedWorkspaceFingerprint,
        DIGEST_PATTERN,
        'expectedWorkspaceFingerprint',
      ),
    };
  }
  if (action === 'integrate') {
    const mode = value.mode;
    if (!['start', 'continue'].includes(mode)) throw new Error('integrate mode is invalid.');
    exactKeys(value, [
      'action', 'mode', 'expectedHead', 'expectedWorkspaceFingerprint', 'canonicalHead', 'paths',
      ...(mode === 'continue' ? ['operationId'] : []),
    ], 'TaskSpace integrate action');
    if (!Array.isArray(value.paths)) {
      throw new Error('integrate paths must be an array.');
    }
    const paths = value.paths.map(validateCheckpointPath);
    if (new Set(paths).size !== paths.length) throw new Error('integrate paths must be unique.');
    return {
      action,
      mode,
      expectedHead: requiredString(value.expectedHead, COMMIT_PATTERN, 'expectedHead'),
      expectedWorkspaceFingerprint: requiredString(
        value.expectedWorkspaceFingerprint,
        DIGEST_PATTERN,
        'expectedWorkspaceFingerprint',
      ),
      canonicalHead: requiredString(value.canonicalHead, COMMIT_PATTERN, 'canonicalHead'),
      paths,
      ...(mode === 'continue'
        ? { operationId: requiredString(value.operationId, ACTOR_USER_ID_PATTERN, 'operationId') }
        : {}),
    };
  }
  const allowed = action === 'release'
    ? ['action', 'services', 'approvalRef', 'executionMode', ...(Object.hasOwn(value, 'version') ? ['version'] : [])]
    : action === 'status' ? ['action', 'operationId'] : ['action'];
  exactKeys(value, allowed, 'TaskSpace action');
  if (action === 'status' && value.operationId !== undefined) {
    return { action, operationId: requiredString(value.operationId, ACTOR_USER_ID_PATTERN, 'operationId') };
  }
  if (action !== 'release') return { action };
  if (value.executionMode !== undefined && value.executionMode !== 'background') {
    throw new Error('Release executionMode must be background when supplied.');
  }
  if (!Array.isArray(value.services) || value.services.length < 1) {
    throw new Error('At least one release service is required.');
  }
  const services = [...new Set(value.services)];
  if (services.length !== value.services.length) throw new Error('Release services must be unique.');
  for (const service of services) {
    if (!['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'].includes(service)) {
      throw new Error(`Release service is not allowed: ${service}`);
    }
  }
  if (typeof value.approvalRef !== 'string' || value.approvalRef.length < 3 || value.approvalRef.length > 160) {
    throw new Error('approvalRef is required and must be bounded.');
  }
  if (value.version !== undefined
    && (typeof value.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.version))) {
    throw new Error('Release version is invalid.');
  }
  return {
    action,
    services,
    approvalRef: value.approvalRef,
    ...(value.executionMode === undefined ? {} : { executionMode: value.executionMode }),
    ...(value.version === undefined ? {} : { version: value.version }),
  };
}

export function hashTaskspaceToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
    throw new Error('TaskSpace token is invalid.');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenHashMatches(actualHash, expectedHash) {
  if (!/^[0-9a-f]{64}$/.test(actualHash) || !/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  return crypto.timingSafeEqual(Buffer.from(actualHash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

export function taskspaceError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  if (options.retryable !== undefined) error.retryable = options.retryable;
  if (options.recommendedAction !== undefined) error.recommendedAction = options.recommendedAction;
  return error;
}
