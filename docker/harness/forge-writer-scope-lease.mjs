import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { withExecutionStateLock } from './forge-execution-context.mjs';
import { forgeLeasePathsOverlap, forgeSemanticResourcesOverlap, normalizeForgeSemanticResources } from './forge-semantic-resource-lease.mjs';
import { normalizeForgeTaskOwnedPaths } from './forge-task-execution-contract.mjs';
import { ACTOR_USER_ID_PATTERN, CONVERSATION_ID_PATTERN, TASKSPACE_ID_PATTERN } from './taskspace-policy.mjs';

const IDENTITY = ['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest', 'executionId', 'generation', 'contractId'];
const CALL = ['callId', 'toolName', 'filePath'];
const OWNER = ['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'executionId', 'generation', 'contractId'];
const TASK_OWNER = ['projectSlug', 'taskId', 'actorUserId', 'conversationId'];
const QUIESCENCE_KEYS = ['schemaVersion', 'containerId', 'startedAt', 'finishedAt', 'removed', 'fenceEpoch', 'evidenceSha256', 'toolResult', 'revokedThroughGeneration'];
const UUID = ACTOR_USER_ID_PATTERN;
const DIGEST = /^[0-9a-f]{64}$/u;
const TOOLS = new Set(['write', 'edit', 'remove_file', 'copy_file']);
const MAX_SETTLED_PER_GENERATION = 4096;
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const writerTransactions = new Map();

function fail(code, message) {
  throw Object.assign(new Error(message), { name: 'ForgeWriterScopeLeaseError', code, statusCode: 409 });
}
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    fail('WRITER_SCOPE_SCHEMA_INVALID', `${label} has unsupported or missing fields.`);
  }
}
function text(value, maximum = 256) { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value); }
function same(left, right, keys) { return keys.every((key) => left[key] === right[key]); }
function canonicalPath(value) { return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value); }
async function withWriterScopeTransaction(statePath, operation) {
  const key = canonicalPath(statePath);
  const previous = writerTransactions.get(key) ?? Promise.resolve();
  let finished;
  const current = new Promise(resolve => { finished = resolve; });
  writerTransactions.set(key, current);
  await previous;
  try {
    // The Broker's own short transactions must not race its nonblocking OS
    // lock. Keep that lock for exclusion with other processes; tool bodies
    // remain outside this queue and every operation still runs exactly once.
    return await withExecutionStateLock(statePath, operation);
  } finally {
    if (writerTransactions.get(key) === current) writerTransactions.delete(key);
    finished();
  }
}
function samePath(left, right) { return canonicalPath(left) === canonicalPath(right); }
function inside(parent, child) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function containerTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0, 19) === value.slice(0, 19);
}
function validateQuiescence(proof, record, recoveredAt) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
      || Object.keys(proof).length !== QUIESCENCE_KEYS.length || Object.keys(proof).some(key => !QUIESCENCE_KEYS.includes(key))
      || proof.schemaVersion !== 1 || !DIGEST.test(proof.containerId ?? '') || proof.removed !== true
      || !containerTimestamp(proof.startedAt) || !containerTimestamp(proof.finishedAt)
      || Date.parse(proof.startedAt) > Date.parse(record.issuedAt)
      || Date.parse(proof.finishedAt) < Date.parse(record.issuedAt) || Date.parse(proof.finishedAt) > recoveredAt
      || typeof proof.fenceEpoch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(proof.fenceEpoch)
      || !DIGEST.test(proof.evidenceSha256 ?? '') || proof.toolResult !== 'unknown'
      || !Number.isSafeInteger(proof.revokedThroughGeneration) || proof.revokedThroughGeneration < record.generation) {
    fail('WRITER_SCOPE_RECOVERY_PROOF_INVALID', 'Recovery requires exact trusted removed-container evidence and must preserve the unknown tool result.');
  }
  return Object.freeze(Object.fromEntries(QUIESCENCE_KEYS.map(key => [key, proof[key]])));
}
function freezeRecord(value) {
  for (const item of Object.values(value)) if (item && typeof item === 'object') freezeRecord(item);
  return Object.freeze(value);
}
function recoveredGenerationFloor(state, owner) {
  return (state.recovered ?? []).filter(record => same(record, owner, TASK_OWNER))
    .reduce((floor, record) => Math.max(floor, record.proof.revokedThroughGeneration), 0);
}
function validAuthorityBinding(value) {
  return (value.authorityClass === 'production-task-writer' && value.testOnly === false && DIGEST.test(value.workspaceFingerprint ?? ''))
    || (value.authorityClass === 'test-shadow-writer' && value.testOnly === true && value.workspaceFingerprint === null);
}
function normalizedPaths(value) {
  try {
    const normalized = normalizeForgeTaskOwnedPaths(value);
    if (value.some((entry) => !normalized.includes(entry))) throw new Error('Noncanonical path');
    return normalized;
  } catch { fail('WRITER_SCOPE_PATH_INVALID', 'Writer paths must be ordinary relative paths without traversal or aliases.'); }
}
function semanticResources(value, errorCode) {
  if (!Array.isArray(value)) fail(errorCode, 'Semantic resources must be an explicit array.');
  if (value.length === 0) return [];
  try { return normalizeForgeSemanticResources(value); }
  catch { fail(errorCode, 'Semantic resources must have valid canonical identities.'); }
}
function validateCall(value) {
  if (!['projectSlug', 'taskId'].every((key) => typeof value[key] === 'string' && TASKSPACE_ID_PATTERN.test(value[key]))
      || typeof value.conversationId !== 'string' || !CONVERSATION_ID_PATTERN.test(value.conversationId)
      || !UUID.test(value.actorUserId ?? '') || !UUID.test(value.executionId ?? '')
      || !text(value.dshSessionId, 1024) || !text(value.rpcId) || !text(value.callId)
      || !DIGEST.test(value.textDigest ?? '') || !DIGEST.test(value.contractId ?? '')
      || !Number.isSafeInteger(value.generation) || value.generation < 1 || !TOOLS.has(value.toolName)) {
    fail('WRITER_SCOPE_SCHEMA_INVALID', 'Writer request identity or tool is invalid.');
  }
  return normalizedPaths([value.filePath])[0];
}
function validateRecord(record, status) {
  const hasResources = Object.hasOwn(record ?? {}, 'semanticResources');
  exact(record, [...IDENTITY, ...CALL, 'permitId', 'ownedPaths', ...(hasResources ? ['semanticResources'] : []), 'sourceCommit', 'workspaceFingerprint', 'authorityClass', 'testOnly', 'issuedAt', 'expiresAt', 'status', ...(status === 'settled' ? ['settledAt'] : []), ...(status === 'recovered' ? ['recoveredAt', 'proof'] : [])], 'writer lease record');
  if (hasResources && JSON.stringify(semanticResources(record.semanticResources, 'WRITER_SCOPE_STATE_INVALID')) !== JSON.stringify(record.semanticResources)) {
    fail('WRITER_SCOPE_STATE_INVALID', 'Stored semantic resources are not canonical.');
  }
  const filePath = validateCall(record);
  const scopes = normalizedPaths(record.ownedPaths);
  if (record.status !== status || !UUID.test(record.permitId ?? '') || filePath !== record.filePath
      || !scopes.some((scope) => filePath === scope || filePath.startsWith(`${scope}/`))
      || !/^[0-9a-f]{40}$/u.test(record.sourceCommit ?? '') || !validAuthorityBinding(record)
      || !timestamp(record.issuedAt) || !timestamp(record.expiresAt) || Date.parse(record.expiresAt) <= Date.parse(record.issuedAt)
      || (status === 'settled' && !timestamp(record.settledAt))
      || (status === 'recovered' && !timestamp(record.recoveredAt))) {
    fail('WRITER_SCOPE_STATE_INVALID', 'Stored writer lease is invalid.');
  }
  if (status === 'recovered') validateQuiescence(record.proof, record, Date.parse(record.recoveredAt));
}
function validateState(value, projectSlug) {
  exact(value, ['schemaVersion', 'projectSlug', 'active', 'settled', ...(value?.schemaVersion === 2 ? ['recovered'] : [])], 'writer lease state');
  if (![1, 2].includes(value.schemaVersion) || value.projectSlug !== projectSlug || !Array.isArray(value.active) || !Array.isArray(value.settled)
      || (value.schemaVersion === 2 && !Array.isArray(value.recovered))) {
    fail('WRITER_SCOPE_STATE_INVALID', 'Writer lease state belongs to another project or has an invalid shape.');
  }
  const permits = new Set();
  const calls = new Set();
  for (const [status, records] of [['in-flight', value.active], ['settled', value.settled], ['recovered', value.recovered ?? []]]) {
    for (const record of records) {
      validateRecord(record, status);
      const call = JSON.stringify([...OWNER, 'callId'].map((key) => record[key]));
      if (record.projectSlug !== projectSlug || permits.has(record.permitId) || calls.has(call)) fail('WRITER_SCOPE_STATE_INVALID', 'Writer lease state contains duplicate or foreign records.');
      permits.add(record.permitId); calls.add(call);
    }
  }
  if (value.active.some(record => record.generation <= recoveredGenerationFloor(value, record))) {
    fail('WRITER_SCOPE_STATE_INVALID', 'An active writer lease belongs to a recovered generation.');
  }
  return value;
}

async function directory(directoryPath, create = false) {
  if (create) await mkdir(directoryPath, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directoryPath);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directoryPath), directoryPath)) {
    fail('WRITER_SCOPE_PATH_INVALID', 'Writer lease directory must be canonical and cannot be a symlink.');
  }
}
function ordinaryStateFile(info, rootRecoveryOwner) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_STATE_BYTES
      || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0
        || info.uid !== (rootRecoveryOwner ? rootRecoveryOwner.uid : process.getuid())))
      || (rootRecoveryOwner && (info.gid !== rootRecoveryOwner.gid || (info.mode & 0o777) !== 0o600))) {
    fail('WRITER_SCOPE_STATE_INVALID', 'Writer lease state must be an owner-only ordinary file.');
  }
}
async function readState(statePath, projectSlug, rootRecoveryOwner) {
  let before;
  try { before = await lstat(statePath); } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, projectSlug, active: [], settled: [] };
    throw error;
  }
  ordinaryStateFile(before, rootRecoveryOwner);
  const handle = await open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (before.dev !== opened.dev || before.ino !== opened.ino) fail('WRITER_SCOPE_STATE_INVALID', 'Writer lease state changed while opening.');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_STATE_BYTES) fail('WRITER_SCOPE_STATE_INVALID', 'Writer lease state is oversized.');
    let state;
    try { state = JSON.parse(bytes.toString('utf8')); } catch { fail('WRITER_SCOPE_STATE_INVALID', 'Writer lease state is not valid JSON.'); }
    return validateState(state, projectSlug);
  } finally { await handle.close(); }
}
async function writeState(statePath, state, rootRecoveryOwner) {
  const bytes = Buffer.from(`${JSON.stringify(state)}\n`);
  if (bytes.length > MAX_STATE_BYTES) fail('WRITER_SCOPE_STATE_INVALID', 'Writer lease state is oversized.');
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    if (rootRecoveryOwner) {
      await handle.chown(rootRecoveryOwner.uid, rootRecoveryOwner.gid);
      await handle.chmod(0o600);
    }
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, statePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

// A prompt must not replace the context of an outstanding tool. Expired permits
// remain in flight until their original settlement or reviewed recovery.
export async function hasActiveForgeTaskWriter({ projectRoot, projectSlug, taskId }) {
  if (!TASKSPACE_ID_PATTERN.test(projectSlug ?? '') || !TASKSPACE_ID_PATTERN.test(taskId ?? '')) {
    fail('WRITER_SCOPE_SCHEMA_INVALID', 'Writer activity requires a project and task identity.');
  }
  const state = await readState(path.join(projectRoot, 'taskspaces', '.broker', 'writer-scope-leases.json'), projectSlug);
  return state.active.some(record => record.taskId === taskId);
}
async function validateWorkspaceTarget(workspace, filePath) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) fail('WRITER_SCOPE_PATH_INVALID', 'Workspace must be absolute.');
  await directory(workspace);
  let current = workspace;
  const segments = filePath.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (info.isSymbolicLink() || !inside(workspace, await realpath(current)) || !samePath(await realpath(current), current)
        || (i < segments.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      fail('WRITER_SCOPE_PATH_INVALID', 'Writer target or an existing ancestor is not an ordinary in-workspace path.');
    }
  }
}

export async function executeForgeWriterScopeLease({ projectRoot, taskMetadata, workspace, request, readContext, now = Date.now() }) {
  const operation = request?.operation;
  const suppliedPermit = operation !== 'acquire' || Object.hasOwn(request, 'permitId');
  exact(request, ['action', 'operation', ...IDENTITY, ...CALL, ...(suppliedPermit ? ['permitId'] : [])], 'writer scope request');
  if (request.action !== 'writer-scope-lease' || !['acquire', 'settle', 'cancel-acquire'].includes(operation)
      || !Number.isFinite(now) || (suppliedPermit && !UUID.test(request.permitId ?? ''))) {
    fail('WRITER_SCOPE_SCHEMA_INVALID', 'Writer scope action, operation, permit or clock is invalid.');
  }
  const filePath = validateCall(request);
  const identity = Object.fromEntries(IDENTITY.map((key) => [key, request[key]]));
  const call = { ...identity, callId: request.callId, toolName: request.toolName, filePath };
  if (!taskMetadata || !same(taskMetadata, request, ['projectSlug', 'taskId', 'actorUserId', 'conversationId'])) {
    fail('WRITER_SCOPE_IDENTITY_MISMATCH', 'Writer request differs from the authenticated TaskSpace owner.');
  }
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) fail('WRITER_SCOPE_PATH_INVALID', 'Project root must be absolute.');
  await directory(projectRoot);
  await directory(path.join(projectRoot, 'taskspaces'), true);
  const stateRoot = path.join(projectRoot, 'taskspaces', '.broker');
  await directory(stateRoot, true);
  const statePath = path.join(stateRoot, 'writer-scope-leases.json');
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || inside(workspace, statePath)) fail('WRITER_SCOPE_PATH_INVALID', 'Protected writer lease state cannot be in the workspace.');
  return withWriterScopeTransaction(statePath, async () => {
    const state = await readState(statePath, request.projectSlug);
    const existing = [...state.active, ...state.settled, ...(state.recovered ?? [])].find((item) => item.permitId === request.permitId);
    if (existing && !same(existing, call, [...IDENTITY, ...CALL])) {
      fail('WRITER_SCOPE_PERMIT_MISMATCH', 'The acquisition capability belongs to another execution or call.');
    }
    if (operation === 'settle' || (operation === 'cancel-acquire' && existing)) {
      const record = existing;
      const status = operation === 'settle' ? 'settled' : 'acquisition-cancelled';
      if (!record || !same(record, call, [...IDENTITY, ...CALL])) {
        fail('WRITER_SCOPE_PERMIT_MISMATCH', 'Settlement requires the exact original permit, execution and call identity.');
      }
      if (record.status === 'recovered') {
        fail('WRITER_SCOPE_PERMIT_RECOVERED', 'A recovered permit cannot be reported as normal tool settlement or replayed.');
      }
      if (record.status === 'settled') return Object.freeze({ schemaVersion: 1, status, permitId: record.permitId, callId: record.callId });
      state.active = state.active.filter((item) => item.permitId !== record.permitId);
      state.settled.push({ ...record, status: 'settled', settledAt: new Date(now).toISOString() });
      await writeState(statePath, state);
      return Object.freeze({ schemaVersion: 1, status, permitId: record.permitId, callId: record.callId });
    }
    if (typeof readContext !== 'function') fail('WRITER_SCOPE_CONTEXT_INVALID', 'Current protected writer context is required.');
    const context = await readContext();
    if (!context || !same(context, request, IDENTITY) || taskMetadata.status !== 'active'
        || !validAuthorityBinding(context)
        || (context.authorityClass === 'production-task-writer'
          ? !['workspace-write', 'git-checkpoint', 'release'].includes(context.actionCeiling) : context.actionCeiling !== 'workspace-write')
        || context.contract?.actionCeiling !== context.actionCeiling || context.contract?.contractId !== context.contractId
        || !Array.isArray(context.contract?.ownedPaths)
        || !/^[0-9a-f]{40}$/u.test(context.sourceCommit ?? '')
        || !timestamp(context.issuedAt) || !timestamp(context.expiresAt)
        || Date.parse(context.issuedAt) > now || Date.parse(context.expiresAt) <= now
        || JSON.stringify(context.ownedPaths) !== JSON.stringify(context.contract.ownedPaths)) {
      fail('WRITER_SCOPE_CONTEXT_INVALID', 'Writer lease requires a matching current unexpired protected writer context.');
    }
    if (context.generation <= recoveredGenerationFloor(state, context)) {
      fail('WRITER_SCOPE_GENERATION_RECOVERED', 'This TaskSpace generation was recovered after writer death; a newer protected generation is required.');
    }
    const ownedPaths = [...context.contract.ownedPaths];
    // Resource declarations come only from the freshly read protected contract, never the wire request.
    const resources = Object.hasOwn(context.contract, 'semanticResources')
      ? semanticResources(context.contract.semanticResources, 'WRITER_SCOPE_CONTEXT_INVALID') : [];
    const scopes = normalizedPaths(ownedPaths);
    if (!scopes.some((scope) => filePath === scope || filePath.startsWith(`${scope}/`))) {
      fail('WRITER_SCOPE_PATH_DENIED', 'Writer target is outside the current protected ownedPaths.');
    }
    await validateWorkspaceTarget(workspace, filePath);
    // Only a newer trusted generation invalidates old settled calls. Never prune active leases or use TTL to take them over.
    state.settled = state.settled.filter((item) => !same(item, context, ['taskId', 'actorUserId', 'conversationId']) || item.generation >= context.generation);
    if ([...state.active, ...state.settled].some((item) => same(item, call, [...OWNER, 'callId']))) {
      fail('WRITER_SCOPE_CALL_REPLAY', 'This execution call already acquired a writer permit.');
    }
    const generationRecords = [...state.active, ...state.settled].filter((item) => same(item, context, ['taskId', 'actorUserId', 'conversationId', 'generation']));
    if (generationRecords.length >= MAX_SETTLED_PER_GENERATION) fail('WRITER_SCOPE_CALL_LIMIT', 'This execution generation has exhausted its bounded writer call records.');
    const record = { ...call, permitId: request.permitId ?? randomUUID(), ownedPaths, semanticResources: resources, sourceCommit: context.sourceCommit,
      workspaceFingerprint: context.workspaceFingerprint, authorityClass: context.authorityClass, testOnly: context.testOnly,
      issuedAt: new Date(now).toISOString(), expiresAt: context.expiresAt, status: 'in-flight' };
    if (operation === 'cancel-acquire') {
      // The caller pinned this capability before requesting acquisition. Keep
      // its terminal call record even when cancellation wins the transaction,
      // so a delayed acquire cannot create a writer after the body was refused.
      state.settled.push({ ...record, status: 'settled', settledAt: new Date(now).toISOString() });
      await writeState(statePath, state);
      return Object.freeze({ schemaVersion: 1, status: 'acquisition-cancelled', permitId: record.permitId, callId: record.callId });
    }
    const conflict = state.active.find((item) => !same(item, call, OWNER)
      && normalizedPaths(item.ownedPaths).some((owned) => scopes.some((scope) => forgeLeasePathsOverlap(owned, scope))));
    if (conflict) fail('PATH_RESOURCE_CONFLICT', 'Another execution still owns an overlapping in-flight writer scope. Expiry alone does not release it.');
    const otherOwners = state.active.filter((item) => !same(item, call, OWNER));
    if (resources.length > 0 && otherOwners.some((item) => !Object.hasOwn(item, 'semanticResources'))) {
      fail('SEMANTIC_SCOPE_UNCLASSIFIED', 'An earlier in-flight writer has no classified semantic scope and must settle before a semantic writer can acquire.');
    }
    if (resources.length > 0 && otherOwners.some((item) => forgeSemanticResourcesOverlap(resources, item.semanticResources))) {
      fail('SEMANTIC_RESOURCE_CONFLICT', 'Another execution still owns an overlapping in-flight semantic resource. Expiry alone does not release it.');
    }
    state.active.push(record);
    await writeState(statePath, state);
    return Object.freeze({ schemaVersion: 1, status: 'acquired', permitId: record.permitId, executionId: record.executionId,
      generation: record.generation, contractId: record.contractId, callId: record.callId, toolName: record.toolName,
      filePath: record.filePath, ownedPaths: Object.freeze([...ownedPaths]), expiresAt: record.expiresAt });
  });
}

// Operator adapter only. This export is deliberately not a writer-scope wire
// operation: the trusted callback observes the dead container under the same
// state lock, while its caller owns the lifecycle lock and durable task fence.
export async function recoverForgeWriterScopeLease({
  projectRoot, taskMetadata, workspace, permitId, expectedExecutionId,
  expectedGeneration, verifyQuiescence, now = Date.now(),
}) {
  if (!UUID.test(permitId ?? '') || !UUID.test(expectedExecutionId ?? '')
      || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1
      || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    fail('WRITER_SCOPE_RECOVERY_INVALID', 'Recovery requires the exact permit, execution, generation and clock.');
  }
  if (typeof verifyQuiescence !== 'function') {
    fail('WRITER_SCOPE_RECOVERY_PROOF_REQUIRED', 'A trusted live quiescence verifier is required; expiry is not death evidence.');
  }
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)
      || typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
    fail('WRITER_SCOPE_PATH_INVALID', 'Recovery requires absolute protected project and workspace paths.');
  }
  if (!taskMetadata || !['projectSlug', 'taskId'].every(key => typeof taskMetadata[key] === 'string' && TASKSPACE_ID_PATTERN.test(taskMetadata[key]))
      || !UUID.test(taskMetadata.actorUserId ?? '') || typeof taskMetadata.conversationId !== 'string'
      || !CONVERSATION_ID_PATTERN.test(taskMetadata.conversationId)) {
    fail('WRITER_SCOPE_IDENTITY_MISMATCH', 'Recovery requires the complete authenticated TaskSpace identity.');
  }
  if (!samePath(workspace, path.join(projectRoot, 'taskspaces', taskMetadata.taskId, 'workspace'))) {
    fail('WRITER_SCOPE_PATH_INVALID', 'Recovery workspace does not belong to the exact TaskSpace.');
  }
  await directory(projectRoot);
  await directory(path.join(projectRoot, 'taskspaces'));
  const stateRoot = path.join(projectRoot, 'taskspaces', '.broker');
  await directory(stateRoot);
  await directory(workspace);
  const statePath = path.join(stateRoot, 'writer-scope-leases.json');
  let rootRecoveryOwner;
  if (process.platform === 'linux' && process.geteuid() === 0) {
    const original = await lstat(statePath);
    rootRecoveryOwner = Object.freeze({ uid: original.uid, gid: original.gid });
    ordinaryStateFile(original, rootRecoveryOwner);
  }
  return withExecutionStateLock(statePath, async () => {
    const state = await readState(statePath, taskMetadata.projectSlug, rootRecoveryOwner);
    const record = [...state.active, ...state.settled, ...(state.recovered ?? [])].find(item => item.permitId === permitId);
    if (!record || !same(record, taskMetadata, TASK_OWNER)
        || record.executionId !== expectedExecutionId || record.generation !== expectedGeneration) {
      fail('WRITER_SCOPE_PERMIT_MISMATCH', 'Recovery identity differs from the exact original writer permit.');
    }
    if (record.status === 'settled') {
      fail('WRITER_SCOPE_RECOVERY_NOT_ACTIVE', 'A normally settled tool cannot be relabeled as a recovered dead writer.');
    }
    if (record.status === 'in-flight' && state.active.some(item => item.permitId !== permitId && same(item, record, TASK_OWNER))) {
      fail('WRITER_SCOPE_RECOVERY_MULTIPLE_ACTIVE', 'Another permit for this TaskSpace is still active; exact single-permit recovery cannot release it.');
    }
    const verified = await verifyQuiescence(freezeRecord(structuredClone(record)));
    const proof = validateQuiescence(verified, record, now);
    if (record.status === 'recovered') {
      if (!same(record.proof, proof, QUIESCENCE_KEYS)) {
        fail('WRITER_SCOPE_RECOVERY_PROOF_MISMATCH', 'Repeated recovery must retain the original exact death evidence and generation floor.');
      }
      return freezeRecord({ schemaVersion: 2, status: 'recovered', permitId, executionId: record.executionId,
        generation: record.generation, recoveredAt: record.recoveredAt, proof: structuredClone(record.proof), idempotent: true });
    }
    const recovered = { ...record, status: 'recovered', recoveredAt: new Date(now).toISOString(), proof };
    const next = { ...state, schemaVersion: 2,
      active: state.active.filter(item => item.permitId !== permitId), recovered: [...(state.recovered ?? []), recovered] };
    validateState(next, taskMetadata.projectSlug);
    await writeState(statePath, next, rootRecoveryOwner);
    return freezeRecord({ schemaVersion: 2, status: 'recovered', permitId, executionId: record.executionId,
      generation: record.generation, recoveredAt: recovered.recoveredAt, proof: structuredClone(proof), idempotent: false });
  }, rootRecoveryOwner);
}
