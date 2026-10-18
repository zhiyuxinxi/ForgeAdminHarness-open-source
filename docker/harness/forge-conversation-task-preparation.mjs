import crypto from 'node:crypto';
import path from 'node:path';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import {
  digestDirectUserTextContent,
  prepareProtectedExecutionContext,
  readCurrentProtectedExecutionContextForTask,
  readProtectedExecutionContext,
} from './forge-execution-context.mjs';
import { canonicalStringify, deriveBackendTestBindings } from './forge-task-execution-contract.mjs';
import { isForgeCredentialHandlingSourcePath } from './forge-conversation-task-proposal.mjs';
import { taskspaceError } from './taskspace-policy.mjs';

const queues = new Map();
const digest = (value) => crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
const lookupKeys = ['projectSlug', 'taskId', 'conversationId', 'actorUserId', 'dshSessionId', 'rpcId', 'textDigest'];

async function readOptional(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function preserve(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(file, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (digest(await readOptional(file)) !== digest(value)) {
      throw taskspaceError('CONVERSATION_TASK_HISTORY_CONFLICT', '已有任务准备记录与本次提案不一致。');
    }
  }
}

async function verifyReferences(workspace, proposal, projectRoot) {
  if (!Array.isArray(proposal?.references) || proposal.references.length < 1 || proposal.references.length > 64) {
    throw taskspaceError('CONVERSATION_TASK_REFERENCE_REQUIRED', '请提供实际读取的相关代码文件作为任务范围依据。');
  }
  const root = await realpath(workspace);
  const verifiedSources = [];
  for (const reference of proposal.references) {
    const relative = reference?.path;
    if (typeof relative !== 'string' || relative.length > 512 || relative !== relative.normalize('NFC')
      || /[\\:\u0000-\u001f\u007f]/u.test(relative)
      || relative.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
      || /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.netrc)(?:\/|$)/u.test(relative)
      || (/(?:^|\/)(?:[^/]*(?:secret|credential|private[-_.]?key)[^/]*|id_(?:rsa|ed25519))(?:\/|$)/iu.test(relative)
        && !isForgeCredentialHandlingSourcePath(relative))
      || !/^[0-9a-f]{64}$/u.test(reference?.sha256 ?? '')) {
      throw taskspaceError('CONVERSATION_TASK_REFERENCE_INVALID', '任务依据必须是当前仓库内的普通文件及其真实摘要。');
    }
    // Harness sees this platform-owned file through a read-only bind mount;
    // the repository copy is only a placeholder and is not its source.
    const target = relative === 'PROJECT_CONTEXT.md'
      ? path.join(await realpath(projectRoot), 'governance', 'PROJECT_CONTEXT.md')
      : path.join(root, ...relative.split('/'));
    const resolved = await realpath(target).catch(() => null);
    const info = await lstat(target).catch(() => null);
    if (resolved !== target || !info?.isFile() || info.isSymbolicLink() || info.nlink !== 1
      || info.size > 8 * 1024 * 1024) {
      throw taskspaceError('CONVERSATION_TASK_REFERENCE_INVALID', '任务依据文件不存在、发生跳转或超出读取范围。');
    }
    const bytes = await readFile(target);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== reference.sha256) {
      throw taskspaceError('CONVERSATION_TASK_REFERENCE_CHANGED', '相关代码已经变化，请重新读取后再准备任务。');
    }
    const testSource = relative.includes('/src/test/java/') && relative.endsWith('.java');
    const modulePom = /^forge-server(?:\/[A-Za-z0-9_.-]+)*\/pom\.xml$/u.test(relative);
    if ((testSource || modulePom) && bytes.length <= 1024 * 1024) {
      verifiedSources.push({ path: relative, sha256: actual, content: bytes.toString('utf8') });
    } else {
      verifiedSources.push({ path: relative, sha256: actual });
    }
  }
  return verifiedSources;
}

function originalRequest(context, promptText) {
  const fields = ['schemaVersion', 'route', 'classification', 'rpcId', 'dshSessionId', 'mode',
    'bodyDigest', 'textDigest', 'bodyBytes', 'requestId', 'actorUserId', 'actorUsername', 'conversationId'];
  return { ...Object.fromEntries(fields.map((key) => [key, context[key]])), promptText, imageCount: 0 };
}

async function prepareUnlocked({ projectRoot, taskMetadata, workspace, request, inspectSource, authorizeProposal, policyPath, now }) {
  if (taskMetadata.status !== 'active' || taskMetadata.accessMode !== 'conversation') {
    throw taskspaceError('CONVERSATION_TASK_NOT_ACTIVE', '请在自己的活动工作舱中准备任务。');
  }
  const context = await readCurrentProtectedExecutionContextForTask({ projectRoot, taskMetadata, now });
  if (!lookupKeys.every((key) => context[key] === request.lookup[key])
    || digestDirectUserTextContent([{ type: 'text', text: request.promptText }]) !== context.textDigest) {
    throw taskspaceError('CONVERSATION_TASK_REQUEST_CHANGED', '任务准备未绑定当前用户的这条对话请求。');
  }
  if (context.workflowId !== null || context.testOnly || context.classification !== 'claimable-text') {
    throw taskspaceError('CONVERSATION_TASK_PHASE_DENIED', '当前受控阶段已有执行合同，不能通过普通任务工具改变范围。');
  }
  const requestDigest = digest({ operation: request.operation, lookup: request.lookup,
    expectedExecutionId: request.expectedExecutionId, expectedGeneration: request.expectedGeneration,
    ...(request.proposal === undefined ? {} : { proposal: request.proposal }) });
  const directory = path.join(projectRoot, 'taskspaces', '.broker', 'conversation-task-preparation',
    taskMetadata.taskId, request.expectedExecutionId);
  const resultFile = path.join(directory, 'result.json');
  const priorResult = await readOptional(resultFile);
  if (priorResult && request.operation === 'inspect') {
    const preparation = await readOptional(path.join(directory, 'proposal.json'));
    const origin = preparation?.context;
    const originalDigest = preparation && digest({ operation: 'propose', lookup: request.lookup,
      expectedExecutionId: request.expectedExecutionId, expectedGeneration: request.expectedGeneration,
      proposal: preparation.proposal });
    if (!origin || request.proposal !== undefined || priorResult.result?.status !== 'prepared'
      || origin.executionId !== request.expectedExecutionId || origin.generation !== request.expectedGeneration
      || priorResult.previousExecutionId !== origin.executionId || priorResult.previousGeneration !== origin.generation
      || ![...lookupKeys, 'actorUsername', 'requestId', 'bodyDigest'].every((key) => origin[key] === context[key])
      || preparation.requestDigest !== originalDigest || priorResult.requestDigest !== originalDigest
      || context.authorityClass !== 'production-task-writer' || context.generation !== origin.generation + 1
      || context.executionId === origin.executionId || digest(priorResult.context) !== digest(context)) {
      throw taskspaceError('CONVERSATION_TASK_PREPARATION_CHANGED', '已完成的任务准备结果不属于当前请求及其原执行上下文。');
    }
    const source = await inspectSource();
    if (digest(source) !== digest(preparation.source) || digest(source) !== digest(priorResult.source)) {
      throw taskspaceError('CONVERSATION_TASK_SOURCE_CHANGED', '任务准备后代码已经变化，不能恢复旧版本的准备结果。');
    }
    const current = await readCurrentProtectedExecutionContextForTask({ projectRoot, taskMetadata, now });
    if (digest(current) !== digest(priorResult.context)) {
      throw taskspaceError('CONVERSATION_TASK_EXECUTION_CHANGED', '当前对话已开始新的执行，请使用最新任务上下文。');
    }
    return { ...priorResult.result, context: current };
  }
  if (priorResult) {
    if (priorResult.requestDigest !== requestDigest || priorResult.context.executionId !== context.executionId
      || priorResult.context.generation !== context.generation) {
      throw taskspaceError('CONVERSATION_TASK_PREPARATION_CHANGED', '这条请求已准备过其他任务范围，请使用当前任务或明确的新需求。');
    }
    return { ...priorResult.result, context };
  }
  const priorPreparation = request.operation === 'propose'
    ? await readOptional(path.join(directory, 'proposal.json')) : null;
  const origin = priorPreparation?.context ?? context;
  if (priorPreparation && priorPreparation.requestDigest !== requestDigest) {
    throw taskspaceError('CONVERSATION_TASK_PREPARATION_CHANGED', '同一请求的任务范围提案已固定。');
  }
  if (origin.executionId !== request.expectedExecutionId || origin.generation !== request.expectedGeneration) {
    throw taskspaceError('CONVERSATION_TASK_EXECUTION_CHANGED', '当前对话已开始新的执行，请使用最新任务上下文。');
  }
  const recoveredPreparation = context.executionId !== origin.executionId;
  if (recoveredPreparation && (!priorPreparation || context.generation !== origin.generation + 1
    || context.authorityClass !== 'production-task-writer')) {
    throw taskspaceError('CONVERSATION_TASK_EXECUTION_CHANGED', '当前对话已开始新的执行，请使用最新任务上下文。');
  }
  const source = await inspectSource();
  if (!/^[0-9a-f]{40}$/u.test(source?.head ?? '') || !/^[0-9a-f]{64}$/u.test(source?.fingerprint ?? '')) {
    throw taskspaceError('CONVERSATION_TASK_SOURCE_UNAVAILABLE', '尚未取得当前代码版本，不能准备写入任务。');
  }
  if (priorPreparation && digest(priorPreparation.source) !== digest(source)) {
    throw taskspaceError('CONVERSATION_TASK_SOURCE_CHANGED', '任务准备期间代码已经变化，请基于当前代码重新提出需求。');
  }
  let backendTestBindings;
  if (request.operation === 'propose') {
    const references = await verifyReferences(workspace, request.proposal, projectRoot);
    if (Array.isArray(request.proposal?.ownedPaths)) {
      backendTestBindings = deriveBackendTestBindings(request.proposal.ownedPaths, references);
    }
  }
  const response = await authorizeProposal({
    operation: request.operation, projectSlug: context.projectSlug, taskId: context.taskId,
    actorUserId: context.actorUserId, actorUsername: context.actorUsername,
    conversationId: context.conversationId, dshSessionId: context.dshSessionId, rpcId: context.rpcId,
    promptText: request.promptText, promptTextDigest: context.textDigest, source,
    expectedExecutionId: origin.executionId, expectedGeneration: origin.generation,
    ...(request.proposal === undefined ? {} : { proposal: request.proposal }),
    ...(backendTestBindings === undefined ? {} : { backendTestBindings }),
  });
  const { authorityResult, proposalDigest: _proposalDigest, idempotent: _idempotent, ...publicResult } = response;
  if (!authorityResult?.trustedPolicyInput) return publicResult;
  if (request.operation !== 'propose' || response.status !== 'prepared'
    || authorityResult.trustedPolicyInput.profile !== 'production-controller'
    || !['workspace-write', 'git-checkpoint', 'release'].includes(authorityResult.authority?.actionCeiling)
    || authorityResult.trustedPolicyInput.taskAuthority?.actionCeiling !== authorityResult.authority.actionCeiling) {
    throw taskspaceError('CONVERSATION_TASK_AUTHORITY_INVALID', '任务准备服务返回了不匹配的执行授权。');
  }
  const afterSource = await inspectSource();
  if (digest(afterSource) !== digest(source)) {
    throw taskspaceError('CONVERSATION_TASK_SOURCE_CHANGED', '任务准备期间代码已经变化，本次授权不能用于旧版本。');
  }
  if (!recoveredPreparation && context.authorityClass === 'production-task-writer'
    && context.productionAuthorityDigest === authorityResult.trustedPolicyInput.productionAuthorityDigest) {
    const current = await readProtectedExecutionContext({ projectRoot, taskMetadata, lookup: request.lookup, now });
    if (current.executionId !== context.executionId || current.generation !== context.generation) {
      throw taskspaceError('CONVERSATION_TASK_EXECUTION_CHANGED', '当前对话已开始新的执行，请使用最新任务上下文。');
    }
    return { ...publicResult, context: current };
  }
  await preserve(path.join(directory, 'proposal.json'), {
    schemaVersion: 1, requestDigest, source, context: origin, proposal: request.proposal,
  });
  const prepared = recoveredPreparation ? context : await prepareProtectedExecutionContext({
    projectRoot, projectSlug: context.projectSlug, taskMetadata,
    request: originalRequest(origin, request.promptText), now, policyPath,
    trustedPolicyInput: authorityResult.trustedPolicyInput,
    expectedExecution: { executionId: origin.executionId, generation: origin.generation },
  });
  if (prepared.productionAuthorityDigest !== authorityResult.trustedPolicyInput.productionAuthorityDigest) {
    throw taskspaceError('CONVERSATION_TASK_AUTHORITY_INVALID', '任务准备结果与当前执行合同不一致。');
  }
  const consumed = await readProtectedExecutionContext({ projectRoot, taskMetadata,
    lookup: request.lookup, now });
  const result = { ...publicResult, status: 'prepared', context: consumed };
  await preserve(resultFile, { schemaVersion: 1, requestDigest, source, context: consumed,
    result: publicResult, previousExecutionId: origin.executionId, previousGeneration: origin.generation });
  return result;
}

export async function prepareConversationTaskExecution(options) {
  const key = path.join(options.projectRoot, options.taskMetadata.taskId);
  const previous = queues.get(key) ?? Promise.resolve();
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => barrier);
  queues.set(key, queued);
  await previous;
  try { return await prepareUnlocked({ now: Date.now(), ...options }); } finally {
    release();
    if (queues.get(key) === queued) queues.delete(key);
  }
}
