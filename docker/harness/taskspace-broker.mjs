import { SOURCE_QUALITY_PROFILE } from './forge-backend-source-quality.mjs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareForgeCrossLayerCandidate } from './forge-cross-layer-preparation.mjs';
import { prepareForgeCrossLayerPreparation, readForgeAccessWiringRepairContinuation, readForgeDeliveryAcceptedArtifact } from './forge-delivery-phase-controller.mjs';
import { createProjectReleaseStatusServer, projectReleaseSnapshot, publicReleaseOperation } from './project-release-status.mjs';
import { freezeDeliveryReleaseSnapshot } from './delivery-center-release-snapshot.mjs';
import { captureDeliveryCheckpointDocuments } from './delivery-center-checkpoint-documents.mjs';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  COMMIT_PATTERN,
  MAX_PREPARE_TASK_BODY_BYTES,
  hashTaskspaceToken,
  taskspaceError,
  tokenHashMatches,
  validateSourceTransition,
  validateTaskspaceAction,
  validateTaskspaceMetadata,
} from './taskspace-policy.mjs';
import {
  MAX_EXECUTION_STATE_BYTES,
  assertAdmittedProductionRelease,
  readCurrentProtectedExecutionContextForTask,
  readProtectedExecutionContext,
  validateProtectedExecutionContext,
} from './forge-execution-context.mjs';
import { protectedCompletionProjectionReady } from './forge-completion-claim-guard.mjs';
import { prepareConversationTaskExecution } from './forge-conversation-task-preparation.mjs';
import { executeForgeWriterScopeLease } from './forge-writer-scope-lease.mjs';
import { executeForgeBusinessDataPreview } from './forge-business-data-preview.mjs';
import { createFixedBusinessDataConsumer, executeForgeBusinessDataConsumption } from './forge-business-data-consumption.mjs';
import { isForgeCredentialHandlingSourcePath } from './forge-conversation-task-proposal.mjs';
import { inventoryWorkspace } from './verification-runner.mjs';
import { validateVerificationContract } from './verify-policy.mjs';
import { validateHostVerificationContract } from './host-verify-policy.mjs';
import { loadManagedFileTargets, managedFileTargetList, executeManagedFileOperation } from './forge-managed-files.mjs';
import { backendTestSelectorsForOwnedPaths, isForgeTaskOwnedPath, isForgeDirectDevelopmentContract } from './forge-task-execution-contract.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;
const MAX_INTEGRATION_RECOVERY_GIT_KIB = 8 * 1024 * 1024;
const DEFAULT_VERIFICATION_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const GIT_REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const GIT_REMOTE_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CHECKPOINT_SECRET_PATH = /(?:^|\/)(?:\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|[^/]*(?:secret|credential|private[-_.]?key)[^/]*)/iu;

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const inheritedEnvironment = { ...process.env };
    if (options.cleanGitEnvironment === true) {
      for (const name of Object.keys(inheritedEnvironment)) {
        if (name.startsWith('GIT_')) delete inheritedEnvironment[name];
      }
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...inheritedEnvironment, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_OUTPUT) {
        child.kill('SIGKILL');
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (bytes > MAX_COMMAND_OUTPUT) {
        reject(taskspaceError('COMMAND_OUTPUT_LIMIT', 'TaskSpace command output exceeded its limit.'));
      } else if (code !== 0) {
        const error = taskspaceError('COMMAND_FAILED', `${command} failed with exit code ${code}.`);
        error.output = output;
        error.errorOutput = errorOutput;
        reject(error);
      } else {
        resolve({ output, errorOutput });
      }
    });
  });
}

function isGitMetadataPermissionFailure(error) {
  const detail = `${error?.message ?? ''}\n${error?.errorOutput ?? ''}`;
  return error?.code === 'COMMAND_FAILED'
    && /(index file open failed|unable to create .*index\.lock|insufficient permission|permission denied)/iu.test(detail);
}

async function atomicJson(filePath, value, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' });
  await chmod(temporaryPath, mode);
  await rename(temporaryPath, filePath);
}

function publicError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'TASKSPACE_OPERATION_FAILED',
    message: typeof error?.message === 'string' ? error.message.slice(0, 1000) : 'TaskSpace operation failed.',
    retryable: error?.retryable === true,
    ...(typeof error?.recommendedAction === 'string'
      ? { recommendedAction: error.recommendedAction.slice(0, 1000) }
      : {}),
    ...(error?.integration && typeof error.integration === 'object'
      ? { integration: error.integration }
      : {}),
    ...(['same-task', 'other-task', 'unknown'].includes(error?.releaseOwner)
      ? { releaseOwner: error.releaseOwner, operationId: error.operationId ?? null } : {}),
  };
}

async function readCandidateValidationStateSnapshot(projectRoot, taskId) {
  const statePath = path.join(projectRoot, 'taskspaces', '.broker', 'executions', `${taskId}.json`);
  let before;
  try {
    before = await lstat(statePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw taskspaceError('EXECUTION_CONTEXT_UNAVAILABLE', 'No protected execution context has been prepared for this TaskSpace.');
    }
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size < 2
    || before.size > MAX_EXECUTION_STATE_BYTES) {
    throw taskspaceError('EXECUTION_STATE_INVALID', 'Protected execution state file is invalid.');
  }
  const bytes = await readFile(statePath);
  const after = await lstat(statePath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
    throw taskspaceError(
      'CANDIDATE_VALIDATION_STATE_CHANGED',
      'Protected execution state changed while candidate validation identity was being resolved.',
      { retryable: true },
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw taskspaceError('EXECUTION_STATE_INVALID', 'Protected execution state is not valid JSON.');
  }
  return { bytes, value };
}

async function readCandidateValidationBindingForTask({ projectRoot, taskMetadata }) {
  const before = await readCandidateValidationStateSnapshot(projectRoot, taskMetadata.taskId);
  const issuedAtMs = Date.parse(before.value?.current?.issuedAt);
  if (!Number.isFinite(issuedAtMs)) {
    throw taskspaceError('EXECUTION_STATE_INVALID', 'Protected execution state timestamp is invalid.');
  }
  // This historical instant is used only by this read-only projection. The
  // normal execution-context reader still applies the real clock to every
  // generation and mutation authority check.
  const context = await readCurrentProtectedExecutionContextForTask({
    projectRoot,
    taskMetadata,
    now: issuedAtMs,
  });
  const after = await readCandidateValidationStateSnapshot(projectRoot, taskMetadata.taskId);
  if (!before.bytes.equals(after.bytes)) {
    throw taskspaceError(
      'CANDIDATE_VALIDATION_STATE_CHANGED',
      'Protected execution state changed while candidate validation identity was being resolved.',
      { retryable: true },
    );
  }
  if (context.projectSlug !== taskMetadata.projectSlug || context.taskId !== taskMetadata.taskId
    || context.actorUserId !== taskMetadata.actorUserId || context.actorUsername !== taskMetadata.actorId
    || context.conversationId !== taskMetadata.conversationId) {
    throw taskspaceError(
      'EXECUTION_CONTEXT_MISMATCH',
      'Protected execution context does not match the authenticated TaskSpace.',
    );
  }
  if (after.value?.lifecycle?.status !== 'consumed') {
    throw taskspaceError(
      'CANDIDATE_VALIDATION_NOT_READY',
      'Candidate validation requires a consumed protected execution; it cannot authorize generation or mutation.',
    );
  }
  const candidateValidationProfiles = [
    ...context.requiredProfiles,
    ...context.contract.requiredRedProfiles.filter((profile) => !context.requiredProfiles.includes(profile)),
  ];
  return Object.freeze({
    projectSlug: context.projectSlug,
    taskId: context.taskId,
    actorUserId: context.actorUserId,
    actorUsername: context.actorUsername,
    conversationId: context.conversationId,
    executionId: context.executionId,
    generation: context.generation,
    contractId: context.contractId,
    requiredProfiles: Object.freeze(candidateValidationProfiles),
    directDevelopment: isForgeDirectDevelopmentContract(context.contract),
    ...(context.authorityClass === 'production-task-writer' ? {
      candidateBinding: Object.freeze({
        projectSlug: context.projectSlug,
        taskId: context.taskId,
        actorUserId: context.actorUserId,
        actorUsername: context.actorUsername,
        conversationId: context.conversationId,
        dshSessionId: context.dshSessionId,
        executionId: context.executionId,
        generation: context.generation,
        rpcId: context.rpcId,
        contractId: context.contractId,
        authorityClass: context.authorityClass,
        actionCeiling: context.actionCeiling,
        sourceCommit: context.sourceCommit,
        authorityWorkspaceFingerprint: context.workspaceFingerprint,
        productionAuthorityId: context.productionAuthorityId,
        productionAuthorityDigest: context.productionAuthorityDigest,
        controllerGrantDigest: context.controllerGrantDigest,
      }),
    } : {}),
  });
}

async function readProductionExecutionContextForTask({ projectRoot, taskMetadata, action }) {
  const before = await readCandidateValidationStateSnapshot(projectRoot, taskMetadata.taskId);
  const context = await readCurrentProtectedExecutionContextForTask({ projectRoot, taskMetadata });
  const after = await readCandidateValidationStateSnapshot(projectRoot, taskMetadata.taskId);
  if (!before.bytes.equals(after.bytes)) {
    throw taskspaceError(
      'TASKSPACE_AUTHORITY_CHANGED',
      'Protected production authority changed while the operation was being authorized.',
      { retryable: true },
    );
  }
  if (after.value?.lifecycle?.status !== 'consumed') {
    throw taskspaceError(
      'TASKSPACE_PRODUCTION_AUTHORITY_NOT_CONSUMED',
      'The current protected production authority has not been consumed by the authenticated TaskSpace.',
    );
  }
  if (context.authorityClass !== 'production-task-writer' || context.testOnly !== false) {
    throw taskspaceError(
      'TASKSPACE_PRODUCTION_AUTHORITY_REQUIRED',
      'This operation requires current non-test production-task-writer authority.',
    );
  }
  const allowed = action === 'release'
    ? context.actionCeiling === 'release'
    : ['git-checkpoint', 'release'].includes(context.actionCeiling);
  if (!allowed) {
    throw taskspaceError(
      'TASKSPACE_ACTION_CEILING_DENIED',
      `Protected production authority does not permit ${action}.`,
    );
  }
  return context;
}

function normalizedSha256(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.startsWith('sha256:') ? value.slice(7) : value;
  return SHA256_PATTERN.test(normalized) ? normalized : null;
}

function samePaths(left, right) {
  if (left.length !== right.length) return false;
  const expected = [...left].sort();
  return [...right].sort().every((entry, index) => entry === expected[index]);
}

function exactObjectKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function sameInventoryFilesAfterExactStaging(before, after, checkpointPaths) {
  const checkpointPathSet = new Set(checkpointPaths);
  const expected = before.files.filter((item) => (
    item.deleted !== true || !checkpointPathSet.has(item.relative)
  ));
  if (expected.length !== after.files.length) return false;
  return expected.every((item, index) => {
    const current = after.files[index];
    return current?.relative === item.relative
      && current.deleted === item.deleted
      && current.bytes === item.bytes
      && current.sha256 === item.sha256;
  });
}

function parseNulPaths(output) {
  return output.split('\0').filter(Boolean);
}

function parsePorcelainPaths(output, { rejectDuplicates = false } = {}) {
  const fields = output.split('\0');
  const paths = [];
  for (let index = 0; index < fields.length && fields[index] !== ''; index += 1) {
    const entry = fields[index];
    if (entry.length < 4 || entry[2] !== ' ') {
      throw taskspaceError('TASKSPACE_GIT_STATUS_INVALID', 'Git returned an invalid checkpoint status entry.');
    }
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status.includes('R') || status.includes('C')) {
      index += 1;
      if (index >= fields.length || fields[index] === '') {
        throw taskspaceError('TASKSPACE_GIT_STATUS_INVALID', 'Git returned an incomplete rename status entry.');
      }
      paths.push(fields[index]);
    }
  }
  if (rejectDuplicates && new Set(paths).size !== paths.length) {
    throw taskspaceError('TASKSPACE_SOURCE_PROJECTION_INVALID', 'Git status returned duplicate source paths.');
  }
  return [...new Set(paths)];
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sourceTransitionRecord(payload) {
  const digestPayload = {
    ...payload,
    digestAlgorithm: 'sha256',
    digestEncoding: 'canonical-json-v1',
  };
  return { ...digestPayload, digest: sha256Text(canonicalJson(digestPayload)) };
}

function acceptanceNotReady(message = 'Current protected acceptance is not ready for release.', openObligations = [], backendSelectors = null) {
  const missing = openObligations.filter((id) => typeof id === 'string'
    && /^(?:contract|verification|crud|shared-owner):[a-z0-9][a-z0-9-]{0,95}$/u.test(id)).slice(0, 12);
  const semanticReviewMissing = missing.includes('contract:api-error-and-auth-contract');
  const coverage = backendSelectors === null ? ''
    : `backend-test-class 需要一份覆盖当前完整选择器组合的通过回执：${JSON.stringify(backendSelectors)}。局部 passed 只证明所选测试成功，不等于该义务已闭合；不同局部回执不会自动合并。先复核已有完整组合回执，没有时只运行上述组合。`;
  const recovery = `先读取受保护验收状态，按当前实际未闭合项处理；已有通过结果优先用 forge-verify run --reuse-receipt 按当前合同正式复核，仅补缺失或失效的检查，不重跑全部检查。${coverage}`;
  return taskspaceError('TASKSPACE_ACCEPTANCE_NOT_READY',
    `${message}${missing.length === 0 ? '' : ` Unclosed obligations: ${missing.join(', ')}.`}`, {
    recommendedAction: semanticReviewMissing
      ? `${recovery}${missing.length > 1 ? '当前还缺其他义务，并非仅缺独审。' : ''}独立的 API 错误与鉴权合同审查不能由重复治理或技术测试替代；其余义务满足后，使用既有受控发布入口触发受支持的独立审查。只有明确报告审查能力不可用时才修复平台配置；不得自报通过或修改验收台账。`
      : `${recovery}同时核对服务可用性及候选绑定，不要通过重复确认发布绕过真实缺项。`,
  });
}

function validateReleaseProjection(projection, context, inventory, now = Date.now()) {
  if (!protectedCompletionProjectionReady(projection)) {
    // Diagnostic details are useful only when the protected response still
    // identifies this candidate. They never make a blocked projection ready.
    const { gateDigest, ...payload } = projection ?? {};
    const ledger = projection?.ledgerSummary;
    const current = projection?.gateType === 'forge-protected-completion-gate/v1'
      && normalizedSha256(gateDigest) === sha256Text(canonicalJson(payload))
      && ledger?.taskContractId === context.contractId
      && normalizedSha256(projection.sourceFingerprint) === inventory.workspaceFingerprint
      && normalizedSha256(ledger.sourceFingerprint) === inventory.workspaceFingerprint;
    const expired = current && Array.isArray(projection.blockers)
      && projection.blockers.some((item) => item?.code === 'ACCEPTANCE_CONTRACT_EXPIRED')
      && projection.blockers.every((item) => [
        'ACCEPTANCE_CONTRACT_EXPIRED', 'SIGNED_RECEIPT_INVALID', 'LEDGER_CLOSURE_PROVENANCE_INVALID',
      ].includes(item?.code));
    if (expired) {
      // This permits formal recovery only; it never accepts expired or invalid evidence.
      throw taskspaceError('TASKSPACE_ACCEPTANCE_REVALIDATION_REQUIRED',
        '当前候选的验收合同已过期，尚不能发布；需要按当前授权正式复核。', {
          retryable: true,
          recommendedAction: '保留 prepared 候选、原作业及已有回执；沿原任务的当前权限续期与 Host 准入路径，使用 forge-verify run --reuse-receipt 按当前合同正式复核可复用回执，再续发同一候选。不要求用户重复确认，不重建候选或重跑已有有效检查；真实缺项、无效证据或授权撤销仍须处理。',
        });
    }
    const open = current && Array.isArray(ledger.open) ? ledger.open : [];
    const backendSelectors = open.includes('verification:backend-test-class')
      ? (projection.backendTestSelectors ?? backendTestSelectorsForOwnedPaths(context.ownedPaths)) : null;
    throw acceptanceNotReady(undefined, open, backendSelectors);
  }
  const evaluatedAt = Date.parse(projection.evaluatedAt);
  if (!Number.isFinite(evaluatedAt)
    || new Date(evaluatedAt).toISOString() !== projection.evaluatedAt
    || evaluatedAt > now) {
    throw acceptanceNotReady('Protected acceptance has an invalid or stale evaluation time.');
  }
  const ledger = projection.ledgerSummary;
  if (ledger?.summaryType !== 'forge-obligation-ledger-summary/v1'
    || ledger.taskContractId !== context.contractId
    || normalizedSha256(projection.sourceFingerprint) !== inventory.workspaceFingerprint
    || normalizedSha256(ledger.sourceFingerprint) !== inventory.workspaceFingerprint
    || normalizedSha256(projection.gateDigest) === null
    || normalizedSha256(projection.ledgerDigest) === null
    || normalizedSha256(projection.ledgerDigest) !== normalizedSha256(ledger.ledgerDigest)
    || normalizedSha256(projection.ledgerSummaryDigest) === null
    || normalizedSha256(projection.ledgerSummaryDigest) !== normalizedSha256(ledger.summaryDigest)) {
    throw acceptanceNotReady('Protected acceptance is not bound to the current task contract and source fingerprint.');
  }
  return { gateDigest: projection.gateDigest, evaluatedAt: projection.evaluatedAt };
}

async function defaultReleaseClient(socketPath, requestBody, timeoutMs = undefined) {
  const payload = Buffer.from(JSON.stringify(requestBody));
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: '/v1/actions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_COMMAND_OUTPUT) response.destroy(new Error('Release response exceeded its limit.'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if ((response.statusCode ?? 500) >= 400 || parsed.ok !== true) {
            const exposed = parsed.error ?? {};
            reject(taskspaceError(
              exposed.code ?? 'CONTROLLED_RELEASE_FAILED',
              exposed.message ?? 'Controlled release failed.',
              {
                retryable: exposed.retryable === true,
                recommendedAction: exposed.recommendedAction,
              },
            ));
            return;
          }
          resolve(parsed.result);
        } catch (error) {
          reject(taskspaceError('RELEASE_RESPONSE_INVALID', `Release response is invalid: ${error.message}`));
        }
      });
    });
    request.once('error', reject);
    if (timeoutMs !== undefined) request.setTimeout(timeoutMs, () => request.destroy(new Error('Release status timed out.')));
    request.end(payload);
  });
}

export async function defaultVerificationClient(socketPath, requestBody, options = {}) {
  const payload = Buffer.from(JSON.stringify(requestBody));
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(taskspaceError('VERIFY_RUNNER_CANCELLED', 'Controlled verification request was cancelled.', { retryable: true }));
      return;
    }
    const request = http.request({
      socketPath,
      path: '/v1/actions',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_COMMAND_OUTPUT) response.destroy(new Error('Verification response exceeded its limit.'));
        else chunks.push(chunk);
      });
      response.once('error', (error) => {
        cleanup();
        reject(error);
      });
      response.once('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if ((response.statusCode ?? 500) >= 400 || parsed.ok !== true) {
            const exposed = parsed.error ?? {};
            reject(taskspaceError(
              exposed.code ?? 'CONTROLLED_VERIFICATION_FAILED',
              exposed.message ?? 'Controlled verification failed.',
              {
                retryable: exposed.retryable === true,
                recommendedAction: exposed.recommendedAction,
              },
            ));
            cleanup();
            return;
          }
          cleanup();
          resolve(parsed.result);
        } catch (error) {
          cleanup();
          reject(taskspaceError('VERIFY_RESPONSE_INVALID', `Verification response is invalid: ${error.message}`));
        }
      });
    });
    const abort = () => request.destroy(taskspaceError(
      'VERIFY_RUNNER_CANCELLED',
      'Controlled verification request was cancelled.',
      { retryable: true },
    ));
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    options.signal?.addEventListener('abort', abort, { once: true });
    request.setTimeout(options.timeoutMs ?? DEFAULT_VERIFICATION_REQUEST_TIMEOUT_MS, () => {
      request.destroy(taskspaceError(
        'VERIFY_RUNNER_TIMEOUT',
        'Controlled verification Runner exceeded its bounded response deadline.',
        { retryable: true },
      ));
    });
    request.once('error', (error) => {
      cleanup();
      reject(error);
    });
    request.end(payload);
  });
}

export async function defaultProtectedCompletionClient(socketPath, requestBody) {
  return defaultProtectedResolverClient(socketPath, '/v1/projection', requestBody, 'completion');
}

function conversationTaskResolverError(value) {
  const exposed = value?.error;
  if (value?.ok !== false || exposed === null || typeof exposed !== 'object' || Array.isArray(exposed)
    || typeof exposed.code !== 'string' || !/^[A-Z][A-Z0-9_]{2,95}$/u.test(exposed.code)) {
    return taskspaceError('CONVERSATION_TASK_RESPONSE_INVALID', '普通任务准备服务返回了无效响应。');
  }
  const managedFileMessages = {
    MANAGED_FILE_SCHEMA: '受控文件参数不符合约定；请使用工具声明的目标、操作与相对文件路径。',
    MANAGED_FILE_PATH: '文件路径不被允许；请使用已登记目录内的普通相对文件路径。',
    MANAGED_FILE_CONFIG: '受控文件目录登记配置无效；请反馈平台维护人员核对原登记。',
    MANAGED_FILE_AUTHORITY: '当前账号或请求与受控目录操作授权不匹配；请核对原请求及目标权限，不要自动扩大授权。',
    MANAGED_FILE_EXPLICIT_REQUEST_REQUIRED: '当前请求未绑定该目录及操作；请核对本轮明确指定的服务器目录、文件和操作，不要沿用其他请求授权。',
  };
  if (Object.hasOwn(managedFileMessages, exposed.code)) {
    return taskspaceError(exposed.code, managedFileMessages[exposed.code], { retryable: false,
      recommendedAction: managedFileMessages[exposed.code] });
  }
  const conflict = exposed.code === 'CONVERSATION_TASK_PROPOSAL_CONFLICT';
  const scopeDenied = exposed.code === 'CONVERSATION_TASK_SCOPE_DENIED';
  const sourceChanged = exposed.code === 'CONVERSATION_TASK_SOURCE_CHANGED';
  const expired = exposed.code === 'CONVERSATION_TASK_REQUEST_EXPIRED';
  if (exposed.code === 'CONVERSATION_EXECUTION_AUTHORITY_UNAVAILABLE' && exposed.retryable === true) {
    return taskspaceError(exposed.code, '当前账号权限核验暂时不可用，原任务与请求保留。', {
      retryable: true,
      recommendedAction: '待平台权限核验服务恢复后续接同一请求；不要重放用户消息、重新准备范围或扩大重试预算。',
    });
  }
  return taskspaceError(exposed.code,
    scopeDenied ? '本次提案与当前任务授权或项目允许的文件范围不匹配。先用 prepare_task inspect 核对当前任务及 availableScopes；新需求应准备自己的范围，不能沿用上一任务的发布授权扩大范围。'
      : conflict ? '本轮请求已绑定任务范围，不能用不同提案覆盖。请在原对话的新一轮明确提出修订后的目标和范围，再准备任务。'
      : sourceChanged ? '本轮请求绑定的源码已经变化，当前提案不能继续使用。请在原对话的新一轮基于当前代码说明目标和范围。'
        : expired ? '本轮普通任务准备请求已过期。请在原对话的新一轮确认当前任务后继续。' : '普通任务准备被上游服务拒绝，请核对返回的错误码。',
    {
      retryable: false,
      recommendedAction: scopeDenied
        ? '核对当前用户需求、当前任务和实际允许的文件范围；不得扩大授权、重复重放被拒提案或把旧任务的READY当作新任务已完成。'
        : conflict
        ? '保留本轮绑定，请用户在新一轮对话中确认修订范围；不要覆盖授权或重放本轮请求。'
        : sourceChanged || expired
          ? '请用户在原对话的新一轮确认当前源码和任务范围后再准备任务。'
          : '请核对原对话的身份、权限和任务范围后反馈具体阻断；不要自动修改授权或重放请求。',
    });
}

async function defaultProtectedResolverClient(socketPath, route, requestBody, capability) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(requestBody));
    const request = http.request({
      socketPath,
      path: route,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          request.destroy(taskspaceError('PROTECTED_COMPLETION_RESPONSE_INVALID', 'Protected completion response exceeded its limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || value?.ok !== true || value.result === null
            || typeof value.result !== 'object' || Array.isArray(value.result)) {
            if (capability === 'conversation-task') throw conversationTaskResolverError(value);
            const rejection = new Map([
              ['ACCEPTANCE_CANDIDATE_BINDING_UNAVAILABLE', '当前任务尚无Host绑定的候选授权；核对当前任务与admission，沿已有准备和复核路径继续。'],
              ['ACCEPTANCE_RECORD_NOT_FOUND', '当前任务缺少受保护验收记录；核对同一任务的准备状态，保留已有结果。'],
              ['ACCEPTANCE_STATE_INVALID', '受保护验收状态完整性校验失败；保留证据，由平台修复具体状态问题。'],
              ['ACCEPTANCE_SCHEMA_INVALID', '受保护验收查询格式无效；由平台修复查询，不要重复执行业务检查。'],
            ]).get(value?.error?.code);
            throw taskspaceError(
              rejection ? value.error.code
                : capability === 'completion' ? 'PROTECTED_COMPLETION_UNAVAILABLE' : 'CANDIDATE_BINDING_UNAVAILABLE',
              capability === 'completion'
                ? 'Protected completion projection was rejected.'
                : 'Protected candidate binding projection was rejected.',
              { retryable: false, recommendedAction: rejection
                ?? '保留当前任务和结果，核对受保护查询拒绝；不能凭重试扩大权限或重复验证。' },
            );
          }
          resolve(value.result);
        } catch (error) {
          reject(error?.code ? error : taskspaceError(
            capability === 'conversation-task' ? 'CONVERSATION_TASK_RESPONSE_INVALID'
              : capability === 'completion' ? 'PROTECTED_COMPLETION_RESPONSE_INVALID' : 'CANDIDATE_BINDING_RESPONSE_INVALID',
            capability === 'conversation-task' ? '普通任务准备服务返回了无效响应。' : capability === 'completion'
              ? 'Protected completion response is invalid.'
              : 'Protected candidate binding response is invalid.',
          ));
        }
      });
    });
    request.once('error', (error) => reject((capability === 'conversation-task' && error?.code)
      || error?.code === 'PROTECTED_COMPLETION_RESPONSE_INVALID' ? error : taskspaceError(
      capability === 'completion' ? 'PROTECTED_COMPLETION_UNAVAILABLE' : 'CANDIDATE_BINDING_UNAVAILABLE',
      capability === 'completion'
        ? 'Protected completion resolver is unavailable.'
        : 'Protected candidate binding resolver is unavailable.',
      { retryable: true, recommendedAction: '服务恢复后重新读取同一任务的受保护状态；保留已有作业和回执，不重新执行检查。' },
    )));
    request.end(payload);
  });
}

export class TaskspaceBroker {
  constructor(options) {
    this.developmentMode = options.developmentMode ?? process.env.FORGE_DEVELOPMENT_MODE;
    this.runtimeChannel = options.runtimeChannel ?? process.env.FORGE_RUNTIME_CHANNEL ?? null;
    if (this.runtimeChannel !== null && !['stable', 'enhanced'].includes(this.runtimeChannel)) {
      throw new Error('TaskSpace Broker runtime channel is invalid.');
    }
    this.runtimeVersionId = this.runtimeChannel === null ? null
      : (options.runtimeVersionId ?? process.env.FORGE_RUNTIME_VERSION_ID) || null;
    this.projectRoot = path.resolve(options.projectRoot);
    this.projectSlug = options.projectSlug;
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(this.projectRoot, 'workspace'));
    this.taskspacesRoot = path.resolve(options.taskspacesRoot ?? path.join(this.projectRoot, 'taskspaces'));
    this.releaseSocket = options.releaseSocket ?? '/run/forge-release/runner.sock';
    this.verificationSocket = options.verificationSocket ?? '/run/forge-verify/runner.sock';
    this.protectedCompletionSocket = options.protectedCompletionSocket
      ?? process.env.PROTECTED_ACCEPTANCE_RESOLVER_SOCKET
      ?? '/run/forge-acceptance-resolver/resolver.sock';
    this.command = options.command ?? runCommand;
    this.businessDataConsumer = options.businessDataConsumer ?? createFixedBusinessDataConsumer();
    this.phaseCatalogFile = options.phaseCatalogFile ?? process.env.CONVERSATION_PHASE_CATALOG_FILE
      ?? fileURLToPath(new URL('./skills/forge-task-router/references/phase-profiles.json', import.meta.url));
    this.releaseClient = options.releaseClient ?? ((body) => defaultReleaseClient(this.releaseSocket, body));
    this.releaseStatusClient = options.releaseStatusClient ?? options.releaseClient
      ?? ((body) => defaultReleaseClient(this.releaseSocket, body, 4000));
    this.verificationClient = options.verificationClient
      ?? ((body, requestOptions) => defaultVerificationClient(this.verificationSocket, body, requestOptions));
    this.protectedCompletionClient = options.protectedCompletionClient
      ?? ((body) => defaultProtectedCompletionClient(this.protectedCompletionSocket, body));
    this.conversationTaskClient = options.conversationTaskClient
      ?? ((body) => defaultProtectedResolverClient(
        options.conversationTaskSocket ?? process.env.PROTECTED_ACCEPTANCE_SCOPE_SOCKET
          ?? '/run/forge-acceptance-scope/scope.sock',
        '/v1/conversation-task', body, 'conversation-task',
      ));
    this.executionRenewalClient = options.executionRenewalClient
      ?? ((body) => defaultProtectedResolverClient(
        options.conversationTaskSocket ?? process.env.PROTECTED_ACCEPTANCE_SCOPE_SOCKET
          ?? '/run/forge-acceptance-scope/scope.sock',
        '/v1/execution-renewal', body, 'conversation-task',
      ));
    this.protectedCandidateBindingClient = options.protectedCandidateBindingClient
      ?? ((body) => defaultProtectedResolverClient(
        this.protectedCompletionSocket, '/v1/candidate-binding', body, 'candidate-binding',
      ));
    this.managedFileClient = options.managedFileClient ?? ((body) => defaultProtectedResolverClient(
      options.conversationTaskSocket ?? process.env.PROTECTED_ACCEPTANCE_SCOPE_SOCKET ?? '/run/forge-acceptance-scope/scope.sock',
      '/v1/managed-file', body, 'conversation-task',
    ));
    this.managedFileTargets = options.managedFileTargets ?? (() => loadManagedFileTargets(this.projectSlug));
    this.businessDataIntentClient = options.businessDataIntentClient ?? ((body) => defaultProtectedResolverClient(
      options.conversationTaskSocket ?? process.env.PROTECTED_ACCEPTANCE_SCOPE_SOCKET ?? '/run/forge-acceptance-scope/scope.sock',
      '/v1/business-data-intent', body, 'conversation-task',
    ));
    this.verificationMode = options.verificationMode
      ?? process.env.TASKSPACE_VERIFICATION_MODE
      ?? 'container-toolchain';
    if (!['container-toolchain', 'host-toolchain'].includes(this.verificationMode)) {
      throw new Error('TaskSpace verification mode is invalid.');
    }
    this.verificationContractPath = path.resolve(options.verificationContractPath
      ?? process.env.TASKSPACE_VERIFICATION_CONTRACT
      ?? path.join(this.projectRoot, 'verification', this.verificationMode === 'host-toolchain'
        ? 'host-contract.json'
        : 'contract.json'));
    const environmentVerificationTimeout = process.env.TASKSPACE_VERIFICATION_REQUEST_TIMEOUT_MS;
    if (environmentVerificationTimeout !== undefined && !/^[1-9][0-9]*$/u.test(environmentVerificationTimeout)) {
      throw new Error('verification Runner request timeout environment value must be a positive integer.');
    }
    this.verificationTimeoutMs = options.verificationTimeoutMs
      ?? (environmentVerificationTimeout === undefined
        ? DEFAULT_VERIFICATION_REQUEST_TIMEOUT_MS
        : Number.parseInt(environmentVerificationTimeout, 10));
    if (!Number.isSafeInteger(this.verificationTimeoutMs)
      || this.verificationTimeoutMs < 1_000 || this.verificationTimeoutMs > 60 * 60 * 1000) {
      throw new Error('verification Runner request timeout must be from one second to one hour.');
    }
    this.activeRelease = null;
    this.backgroundReleases = new Set();
    this.taskOperationLocks = new Map();
    this.instanceId = options.instanceId ?? crypto.randomUUID();
    this.staleLockAfterMs = options.staleLockAfterMs ?? 2 * 60 * 1000;
    this.gitRemoteRequired = options.gitRemoteRequired
      ?? process.env.TASKSPACE_GIT_REMOTE_REQUIRED === 'true';
    this.gitRemoteReady = options.gitRemoteReady
      ?? process.env.TASKSPACE_GIT_REMOTE_READY === 'true';
    this.gitRemoteName = options.gitRemoteName ?? process.env.TASKSPACE_GIT_REMOTE_NAME ?? 'origin';
    this.gitRemoteBranch = options.gitRemoteBranch ?? process.env.TASKSPACE_GIT_REMOTE_BRANCH ?? '';
    this.gitSshCommand = options.gitSshCommand ?? process.env.TASKSPACE_GIT_SSH_COMMAND ?? '';
    this.stateRoot = path.join(this.taskspacesRoot, '.broker');
    this.statusSocket = options.statusSocket ?? process.env.TASKSPACE_BROKER_STATUS_SOCKET
      ?? path.join(this.stateRoot, this.runtimeChannel === null
        ? 'project-status.sock' : `project-status-${this.runtimeChannel}.sock`);
    if (!path.isAbsolute(this.statusSocket)) throw new Error('TaskSpace Broker status socket must be absolute.');
    this.releaseStateFile = path.join(this.stateRoot, 'release-state.json');
    this.auditFile = path.join(this.stateRoot, 'audit.jsonl');
    this.maintenanceFile = path.join(this.stateRoot, 'maintenance.json');
    this.releaseLockRoot = path.join(this.stateRoot, 'release.lock');
    this.releaseLockOwnerFile = path.join(this.releaseLockRoot, 'owner.json');
    this.integrationStateRoot = path.join(this.stateRoot, 'integrations');
    this.sourceTransitionRoot = path.join(this.stateRoot, 'source-transitions');
    this.integrationRecoveryRoot = path.join(this.stateRoot, 'integration-recovery');
  }

  async callVerification(requestBody) {
    const controller = new AbortController();
    let timeout;
    const deadline = new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(taskspaceError(
          'VERIFY_RUNNER_TIMEOUT',
          'Controlled verification Runner exceeded its bounded response deadline.',
          { retryable: true },
        ));
      }, this.verificationTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.verificationClient(requestBody, {
          signal: controller.signal,
          timeoutMs: this.verificationTimeoutMs,
        })),
        deadline,
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  taskRoot(taskId) {
    return path.join(this.taskspacesRoot, taskId);
  }

  async readTask(taskId) {
    const metadataPath = path.join(this.taskRoot(taskId), 'metadata.json');
    const metadata = validateTaskspaceMetadata(
      JSON.parse(await readFile(metadataPath, 'utf8')),
      this.projectSlug,
    );
    if (metadata.taskId !== taskId) throw new Error('TaskSpace path and metadata identity differ.');
    return { metadata, metadataPath, workspace: path.join(this.taskRoot(taskId), 'workspace') };
  }

  async writeTask(metadataPath, metadata) {
    const now = new Date().toISOString();
    await atomicJson(metadataPath, validateTaskspaceMetadata({ ...metadata, updatedAt: now }, this.projectSlug));
  }

  async writeIntegratedReviewBaseState(stateFile, completed) {
    await atomicJson(stateFile, completed);
  }

  async resumeIntegratedFinalization(task, request, completed) {
    const transition = completed?.reviewBaseTransition;
    if (completed?.schemaVersion !== 1 || completed.operationId !== request.operationId
      || completed.phase !== 'integrated' || completed.canonicalHead !== request.canonicalHead
      || !COMMIT_PATTERN.test(completed.to?.head ?? '')
      || !SHA256_PATTERN.test(completed.to?.fingerprint ?? '')
      || !COMMIT_PATTERN.test(transition?.from ?? '')
      || transition?.to !== completed.canonicalHead) {
      throw taskspaceError(
        'TASKSPACE_INTEGRATION_REVIEW_BASE_INVALID',
        'The completed integration cannot be resumed as the requested review-base transition.',
      );
    }
    const sameIdentity = completed.task?.projectSlug === task.metadata.projectSlug
      && completed.task?.taskId === task.metadata.taskId
      && completed.task?.actorUserId === task.metadata.actorUserId
      && completed.task?.actorUsername === task.metadata.actorId
      && completed.task?.conversationId === task.metadata.conversationId;
    if (!sameIdentity) {
      throw taskspaceError('TASKSPACE_INTEGRATION_IDENTITY_CHANGED', 'Completed integration identity changed before finalization.');
    }
    const [headResult, statusResult, canonicalHead, inventory, rawSourceTransition] = await Promise.all([
      this.checkpointGit(task.workspace, 'rev-parse', 'HEAD'),
      this.checkpointGit(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
      this.canonicalHead(),
      this.inventoryTaskspace(task),
      this.readBrokerState(this.sourceTransitionFile(task.metadata.taskId)),
    ]);
    const head = headResult.output.trim();
    if (head !== completed.to.head || request.expectedHead !== head || inventory.head !== head
      || inventory.workspaceFingerprint !== completed.to.fingerprint
      || request.expectedWorkspaceFingerprint !== inventory.workspaceFingerprint
      || statusResult.output !== '') {
      throw taskspaceError(
        'TASKSPACE_INTEGRATION_POSTCONDITION_FAILED',
        'Completed integration source or canonical state changed before review-base finalization.',
        { retryable: true },
      );
    }
    await this.assertIntegrationTargetAncestor(completed.canonicalHead, canonicalHead);
    await this.checkpointGit(task.workspace, 'merge-base', '--is-ancestor', completed.canonicalHead, head);
    let sourceTransition = null;
    if (rawSourceTransition !== null) {
      try {
        sourceTransition = validateSourceTransition(rawSourceTransition);
      } catch {
        throw taskspaceError('TASKSPACE_INTEGRATION_STATE_INVALID', 'Completed integration source transition is invalid.');
      }
      const expectedAuthority = completed.continuationAuthority ?? completed.sourceAuthority;
      if (sourceTransition.operationId !== completed.operationId
        || sourceTransition.phase !== 'integrated'
        || sourceTransition.canonicalHead !== completed.canonicalHead
        || JSON.stringify(sourceTransition.task) !== JSON.stringify(completed.task)
        || JSON.stringify(sourceTransition.to) !== JSON.stringify(completed.to)
        || JSON.stringify(sourceTransition.sourceAuthority) !== JSON.stringify(expectedAuthority)) {
        throw taskspaceError('TASKSPACE_INTEGRATION_STATE_INVALID', 'Completed integration source transition does not match its operation.');
      }
    } else if (JSON.stringify(completed.from) !== JSON.stringify(completed.to)) {
      throw taskspaceError('TASKSPACE_INTEGRATION_STATE_INVALID', 'Completed integration is missing its source transition.');
    }
    return {
      operationId: completed.operationId,
      operation: 'integrate',
      status: 'integrated',
      canonicalHead: completed.canonicalHead,
      savedSourceCommit: completed.savedSourceCommit ?? null,
      head,
      workspaceFingerprint: inventory.workspaceFingerprint,
      workspaceClean: true,
      sourceTransition,
    };
  }

  async finalizeIntegratedReviewBase(task, result) {
    if (result.status !== 'integrated') return result;
    const stateFile = this.integrationStateFile(task.metadata.taskId);
    const completed = await this.readBrokerState(stateFile);
    const transition = completed?.reviewBaseTransition;
    const appliedAtMs = Date.parse(transition?.appliedAt);
    const appliedAtValid = transition?.appliedAt === null
      || (typeof transition?.appliedAt === 'string' && Number.isFinite(appliedAtMs)
        && new Date(appliedAtMs).toISOString() === transition.appliedAt);
    if (completed?.schemaVersion !== 1 || completed.operationId !== result.operationId
      || completed.phase !== 'integrated' || completed.canonicalHead !== result.canonicalHead
      || !COMMIT_PATTERN.test(transition?.from ?? '') || transition?.to !== result.canonicalHead
      || !appliedAtValid) {
      throw taskspaceError(
        'TASKSPACE_INTEGRATION_REVIEW_BASE_INVALID',
        'The completed integration does not carry the expected protected review-base transition.',
      );
    }
    const current = await this.readTask(task.metadata.taskId);
    const sameIdentity = current.metadata.schemaVersion === task.metadata.schemaVersion
      && current.metadata.projectSlug === task.metadata.projectSlug
      && current.metadata.taskId === task.metadata.taskId
      && current.metadata.actorId === task.metadata.actorId
      && current.metadata.actorUserId === task.metadata.actorUserId
      && current.metadata.conversationId === task.metadata.conversationId
      && current.metadata.branch === task.metadata.branch;
    if (!sameIdentity || ![transition.from, transition.to].includes(current.metadata.baseCommit)
      || (transition.appliedAt !== null && current.metadata.baseCommit !== transition.to)) {
      throw taskspaceError(
        'TASKSPACE_INTEGRATION_REVIEW_BASE_CHANGED',
        'TaskSpace identity or review base changed before integration finalization.',
        { retryable: true },
      );
    }
    if (current.metadata.baseCommit === transition.from) {
      await this.writeTask(current.metadataPath, {
        ...current.metadata,
        baseCommit: transition.to,
      });
    }
    const updated = await this.readTask(task.metadata.taskId);
    if (updated.metadata.projectSlug !== current.metadata.projectSlug
      || updated.metadata.taskId !== current.metadata.taskId
      || updated.metadata.actorId !== current.metadata.actorId
      || updated.metadata.actorUserId !== current.metadata.actorUserId
      || updated.metadata.conversationId !== current.metadata.conversationId
      || updated.metadata.branch !== current.metadata.branch
      || updated.metadata.baseCommit !== transition.to) {
      throw taskspaceError(
        'TASKSPACE_INTEGRATION_REVIEW_BASE_UPDATE_FAILED',
        'TaskSpace review base did not remain bound to the integrated canonical commit.',
        { retryable: true },
      );
    }
    const appliedTransition = transition.appliedAt === null
      ? { ...transition, appliedAt: new Date().toISOString() }
      : transition;
    if (transition.appliedAt === null) {
      await this.writeIntegratedReviewBaseState(stateFile, {
        ...completed,
        reviewBaseTransition: appliedTransition,
        updatedAt: appliedTransition.appliedAt,
      });
    }
    const persisted = await this.readBrokerState(stateFile);
    if (persisted?.operationId !== result.operationId || persisted.phase !== 'integrated'
      || persisted.reviewBaseTransition?.from !== appliedTransition.from
      || persisted.reviewBaseTransition?.to !== appliedTransition.to
      || persisted.reviewBaseTransition?.appliedAt !== appliedTransition.appliedAt) {
      throw taskspaceError(
        'TASKSPACE_INTEGRATION_REVIEW_BASE_UPDATE_FAILED',
        'The applied review-base transition was not preserved in integration state.',
        { retryable: true },
      );
    }
    return { ...result, reviewBaseTransition: appliedTransition };
  }

  async taskForToken(token) {
    let actualHash;
    try {
      actualHash = hashTaskspaceToken(token);
    } catch {
      throw taskspaceError('TASKSPACE_AUTHENTICATION_FAILED', 'TaskSpace token is invalid.');
    }
    const entries = await readdir(this.taskspacesRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      try {
        const task = await this.readTask(entry.name);
        // A valid token never permits crossing into another platform version.
        // The legacy endpoint only owns tasks created before version selection.
        const taskChannel = task.metadata.runtimeVersion === undefined
          ? null : task.metadata.runtimeVersion?.channel;
        if (taskChannel === this.runtimeChannel
          && (this.runtimeVersionId === null || task.metadata.runtimeVersion?.versionId === this.runtimeVersionId)
          && tokenHashMatches(actualHash, task.metadata.accessTokenHash)) return task;
      } catch {
        // An invalid task directory is not accepted as an authentication source.
      }
    }
    throw taskspaceError('TASKSPACE_AUTHENTICATION_FAILED', 'TaskSpace token is invalid.');
  }

  async gitCommand(cwd, args, env = {}) {
    try {
      return await this.command('git', ['-C', cwd, ...args], { env });
    } catch (error) {
      if (path.resolve(cwd) === this.workspaceRoot && isGitMetadataPermissionFailure(error)) {
        throw taskspaceError(
          'TASKSPACE_INTEGRATION_GIT_METADATA_UNREADABLE',
          'The platform integration repository Git metadata is not readable and writable by the TaskSpace Broker.',
          {
            recommendedAction: 'Have the platform operator run the reviewed integration Git ownership upgrade; do not change /integration from the TaskSpace.',
          },
        );
      }
      throw error;
    }
  }

  async git(cwd, ...args) {
    return this.gitCommand(cwd, args);
  }

  async gitReadonly(cwd, ...args) {
    return this.gitCommand(cwd, args, { GIT_OPTIONAL_LOCKS: '0' });
  }

  async checkpointGit(cwd, ...args) {
    return this.command('git', [
      '-C', cwd,
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgSign=false',
      '-c', 'diff.external=',
      ...args,
    ], {
      cleanGitEnvironment: true,
      env: {
        GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '',
      },
    });
  }

  async remoteGit(...args) {
    return this.command('git', ['-C', this.workspaceRoot, ...args], {
      env: this.gitSshCommand.length > 0 ? { GIT_SSH_COMMAND: this.gitSshCommand } : {},
    });
  }

  async canonicalHead() {
    return (await this.gitReadonly(this.workspaceRoot, 'rev-parse', 'HEAD')).output.trim();
  }

  async assertIntegrationTargetAncestor(target, current) {
    if (target === current) return;
    // The newer canonical commit need not exist in this TaskSpace yet. Keep the
    // open merge's immutable target and prove ancestry in the canonical repo.
    try {
      await this.gitReadonly(this.workspaceRoot, 'merge-base', '--is-ancestor', target, current);
    } catch {
      throw taskspaceError('TASKSPACE_INTEGRATION_TARGET_CHANGED', 'Canonical is not a successor of the fixed integration target.');
    }
  }

  async integrationReadiness() {
    try {
      const [head, statusResult] = await Promise.all([
        this.canonicalHead(),
        this.gitReadonly(this.workspaceRoot, 'status', '--porcelain=v1', '--untracked-files=no'),
      ]);
      return {
        ok: COMMIT_PATTERN.test(head),
        head,
        workspaceClean: statusResult.output.trim().length === 0,
      };
    } catch (error) {
      return { ok: false, error: publicError(error) };
    }
  }

  async maintenanceState() {
    try {
      const value = JSON.parse(await readFile(this.maintenanceFile, 'utf8'));
      return {
        active: true,
        operationId: typeof value?.operationId === 'string' ? value.operationId.slice(0, 128) : 'unknown',
        startedAt: typeof value?.startedAt === 'string' ? value.startedAt.slice(0, 64) : undefined,
      };
    } catch (error) {
      if (error.code === 'ENOENT') return { active: false };
      return { active: true, operationId: 'invalid-maintenance-fence' };
    }
  }

  async inspectCandidate(task, { checkpointSafe = false } = {}) {
    if (!['active', 'stopped'].includes(task.metadata.status)) {
      throw taskspaceError('TASKSPACE_NOT_ACTIVE', 'TaskSpace is not active.');
    }
    const taskGit = checkpointSafe ? this.checkpointGit.bind(this) : this.gitReadonly.bind(this);
    const [statusResult, headResult, canonicalHead] = await Promise.all([
      taskGit(task.workspace, 'status', '--porcelain=v1', '--untracked-files=all'),
      taskGit(task.workspace, 'rev-parse', 'HEAD'),
      this.canonicalHead(),
    ]);
    const head = headResult.output.trim();
    if (!COMMIT_PATTERN.test(head) || !COMMIT_PATTERN.test(canonicalHead)) {
      throw taskspaceError('TASKSPACE_COMMIT_INVALID', 'TaskSpace or integration commit is invalid.');
    }
    await (checkpointSafe ? this.checkpointGit.bind(this) : this.git.bind(this))(
      task.workspace, 'fetch', '--no-tags', this.workspaceRoot, canonicalHead,
    );
    let includesCanonical = true;
    try {
      await taskGit(task.workspace, 'merge-base', '--is-ancestor', canonicalHead, head);
    } catch {
      includesCanonical = false;
    }
    return {
      projectSlug: this.projectSlug,
      taskId: task.metadata.taskId,
      actorId: task.metadata.actorId,
      conversationId: task.metadata.conversationId,
      baseCommit: task.metadata.baseCommit,
      canonicalHead,
      head,
      workspaceClean: statusResult.output.trim().length === 0,
      includesCanonical,
      releaseEligible: statusResult.output.trim().length === 0 && includesCanonical,
    };
  }

  async inspectCandidateSourceProjection(task, integration = null) {
    const beforeStatus = await this.gitReadonly(
      task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
    );
    const inventory = await this.inventoryTaskspace(task);
    const [afterStatus, afterHead] = await Promise.all([
      this.gitReadonly(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
      this.gitReadonly(task.workspace, 'rev-parse', 'HEAD'),
    ]);
    if (beforeStatus.output !== afterStatus.output || inventory.head !== afterHead.output.trim()) {
      throw taskspaceError(
        'TASKSPACE_SOURCE_PROJECTION_CHANGED',
        'TaskSpace source changed while the read-only candidate projection was being created.',
        { retryable: true },
      );
    }
    const dirtyPaths = parsePorcelainPaths(afterStatus.output, { rejectDuplicates: true });
    try {
      const continuation = integration?.phase === 'conflict-open'
        || (integration?.phase === 'source-saved-error'
          && integration?.error?.code === 'TASKSPACE_INTEGRATION_DIRTY_LIMIT');
      validateTaskspaceAction(continuation ? {
        action: 'integrate', mode: 'continue', operationId: integration.operationId,
        expectedHead: inventory.head, expectedWorkspaceFingerprint: inventory.workspaceFingerprint,
        canonicalHead: integration.canonicalHead, paths: integration.conflictPaths ?? [],
      } : {
        action: 'integrate', mode: 'start', expectedHead: inventory.head,
        expectedWorkspaceFingerprint: inventory.workspaceFingerprint,
        canonicalHead: inventory.head, paths: dirtyPaths,
      });
    } catch {
      throw taskspaceError(
        'TASKSPACE_SOURCE_PROJECTION_INVALID',
        'Current dirty paths cannot be represented safely by the controlled integrate contract.',
      );
    }
    return {
      workspaceFingerprint: inventory.workspaceFingerprint,
      dirtyPaths,
      sourceProjection: { available: true, missing: [] },
    };
  }

  async audit(record) {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    await appendFile(this.auditFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.auditFile, 0o600);
  }

  async diagnose() {
    let lastRelease = null;
    try {
      lastRelease = JSON.parse(await readFile(this.releaseStateFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const runner = await this.releaseClient({ action: 'diagnose' });
    return {
      active: this.activeRelease !== null,
      activeRelease: this.activeRelease,
      lastRelease,
      runner,
    };
  }

  async projectReleaseStatus() {
    const before = this.activeRelease?.operationId ?? null;
    const readOptional = async (file) => {
      try { return JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const [lastRelease, lock, runner] = await Promise.all([
      readOptional(this.releaseStateFile), readOptional(this.releaseLockOwnerFile),
      this.releaseStatusClient({ action: 'diagnose' }).catch(() => null),
    ]);
    if (before !== (this.activeRelease?.operationId ?? null)) {
      return { schemaVersion: 1, projectSlug: this.projectSlug, observedAt: new Date().toISOString(),
        availability: 'unknown', occupied: null, operation: null };
    }
    return projectReleaseSnapshot({ projectSlug: this.projectSlug, active: this.activeRelease, lastRelease, lock, runner });
  }

  async releaseObservation(task, operationId) {
    const current = await this.projectReleaseStatus();
    if (operationId === undefined) {
      const saved = task.metadata.lastRelease;
      return { ...current, ownership: current.operation?.taskId
        ? current.operation.taskId === task.metadata.taskId ? 'same-task' : 'other-task' : 'unknown',
      lastTaskRelease: saved ? publicReleaseOperation({ ...saved, taskId: task.metadata.taskId,
        stage: saved.status === 'success' ? 'complete' : saved.stage }) : null };
    }
    if (current.operation?.operationId === operationId && current.operation.taskId === task.metadata.taskId) return current;
    // A newer project operation must never stand in for the requested result.
    // Reuse the existing task's saved success if another TaskSpace advanced the
    // project-wide status. An unavailable/overwritten result remains unknown.
    const saved = task.metadata.lastRelease;
    if (saved?.operationId === operationId && saved.status === 'success') {
      return { ...current, availability: 'ready', operation: publicReleaseOperation({ ...saved,
        taskId: task.metadata.taskId, stage: 'complete' }) };
    }
    return { ...current, availability: 'unknown', operation: null, requestedOperationId: operationId };
  }

  startRelease(task, request) {
    let accepted;
    let rejected;
    const response = new Promise((resolve, reject) => { accepted = resolve; rejected = reject; });
    const running = this.release(task, request, accepted);
    this.backgroundReleases.add(running);
    running.then(() => this.backgroundReleases.delete(running), (error) => {
      this.backgroundReleases.delete(running);
      // Before admission this rejects the request. After admission the original
      // release catch has persisted its real failed terminal for status readers.
      rejected(error);
    });
    return response;
  }

  async waitForReleases() {
    await Promise.allSettled([...this.backgroundReleases]);
  }

  releaseInProgressError(task, owner = this.activeRelease) {
    const releaseOwner = typeof owner?.taskId === 'string' && task?.metadata?.taskId
      ? owner.taskId === task.metadata.taskId ? 'same-task' : 'other-task' : 'unknown';
    const operationId = publicReleaseOperation(owner)?.operationId ?? null;
    return Object.assign(taskspaceError(
      'TASKSPACE_RELEASE_IN_PROGRESS',
      releaseOwner === 'same-task' ? 'This TaskSpace already has a project operation in progress.'
        : releaseOwner === 'other-task' ? 'Another TaskSpace release is already running for this project.'
          : 'A project operation is already in progress; its owner is not established.',
      { retryable: true,
        recommendedAction: releaseOwner === 'same-task' && operationId
          ? `Observe the existing operation with forge-release status --operation-id ${operationId}; do not submit release again.`
          : 'Observe forge-release status for the existing project operation; do not resubmit or infer completion.' },
    ), { releaseOwner, operationId });
  }

  taskOperationLockFile(task) {
    return path.join(this.stateRoot, 'task-operation-locks', `${task.metadata.taskId}.lock`);
  }

  async acquireTaskOperationLock(operationId, task) {
    const file = this.taskOperationLockFile(task);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(file, 'a', 0o600);
    try {
      // flock inherits the same open-file description as this Broker fd.
      // Its short-lived process exits, but the Broker retains the lock until
      // handle.close() or process exit. Never unlink the shared lock inode.
      const code = await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'], {
          stdio: ['ignore', 'ignore', 'ignore', handle.fd],
        });
        child.once('error', reject);
        child.once('close', resolve);
      });
      if (code === 75) throw this.releaseInProgressError(task, this.taskOperationLocks.has(task.metadata.taskId)
        ? { ...this.taskOperationLocks.get(task.metadata.taskId), taskId: task.metadata.taskId } : null);
      if (code !== 0) throw taskspaceError('TASKSPACE_LOCK_UNAVAILABLE', 'TaskSpace file lock could not be acquired.');
      this.taskOperationLocks.set(task.metadata.taskId, { operationId, handle });
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async releaseTaskOperationLock(operationId, task) {
    const owned = this.taskOperationLocks.get(task.metadata.taskId);
    if (!owned || owned.operationId !== operationId) return;
    this.taskOperationLocks.delete(task.metadata.taskId);
    await owned.handle.close();
  }

  async assertCheckpointProjectLock(task) {
    const otherTaskOperation = (owner) => typeof owner?.operationId === 'string'
      && owner.operationId.length > 0
      && typeof owner.taskId === 'string' && owner.taskId.length > 0
      && owner.taskId !== task.metadata.taskId
      && ['release', 'prepare', 'integrate'].includes(owner.action);
    if (this.activeRelease !== null && !otherTaskOperation(this.activeRelease)) {
      throw this.releaseInProgressError(task);
    }
    try {
      const owner = JSON.parse(await readFile(this.releaseLockOwnerFile, 'utf8'));
      if (typeof owner?.instanceId !== 'string' || !owner.instanceId || !otherTaskOperation(owner)) {
        throw this.releaseInProgressError(task);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw this.releaseInProgressError(task);
      // A lock directory without its owner is an acquisition in progress or
      // an unknown external owner, never permission to bypass the lock.
      try { await stat(this.releaseLockRoot); } catch (statError) {
        if (statError.code === 'ENOENT') return;
        throw statError;
      }
      throw this.releaseInProgressError(task);
    }
  }

  async acquireReleaseLock(operationId, task, action = 'release') {
    // Publish the project lock before briefly acquiring the task lock.
    // Checkpoint takes its task lock before reading the project owner, so
    // either acquisition order excludes a same-task checkpoint.
    await this.acquireProjectReleaseLock(operationId, task, action);
    try {
      await this.acquireTaskOperationLock(operationId, task);
      await this.releaseTaskOperationLock(operationId, task);
    } catch (error) {
      await this.releaseReleaseLock(operationId, task).catch(() => undefined);
      throw error;
    }
  }

  async acquireProjectReleaseLock(operationId, task, action) {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await mkdir(this.releaseLockRoot, { mode: 0o700 });
        try {
          await atomicJson(this.releaseLockOwnerFile, {
            schemaVersion: 1,
            instanceId: this.instanceId,
            ...(this.runtimeChannel === null ? {} : { runtimeChannel: this.runtimeChannel }),
            ...(this.runtimeVersionId === null ? {} : { runtimeVersionId: this.runtimeVersionId }),
            operationId,
            action,
            taskId: task.metadata.taskId,
            actorId: task.metadata.actorId,
            createdAt: new Date().toISOString(),
          });
          return;
        } catch (error) {
          await rmdir(this.releaseLockRoot).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      let owner;
      let lockAge = 0;
      try {
        owner = JSON.parse(await readFile(this.releaseLockOwnerFile, 'utf8'));
        lockAge = Date.now() - Date.parse(owner.createdAt);
      } catch {
        const lockStat = await stat(this.releaseLockRoot);
        lockAge = Date.now() - lockStat.mtimeMs;
      }
      if (!Number.isFinite(lockAge) || lockAge < this.staleLockAfterMs) {
        throw this.releaseInProgressError(task, owner);
      }
      // Each runtime has its own Runner. Its idle response says nothing about
      // another runtime's job. Preserve that shared lock for its owning chain.
      const ownerChannel = owner?.runtimeChannel === undefined ? null : owner.runtimeChannel;
      const ownerVersionId = owner?.runtimeVersionId ?? null;
      if (!owner || ownerChannel !== this.runtimeChannel || ownerVersionId !== this.runtimeVersionId) {
        throw this.releaseInProgressError(task, owner);
      }
      const diagnosis = await this.releaseClient({ action: 'diagnose' }).catch(() => ({ active: true }));
      if (diagnosis?.active !== false) throw this.releaseInProgressError(task, owner);
      await this.audit({
        type: 'taskspace-release-lock-recovery',
        status: 'recovered-stale-lock',
        previousOwner: owner,
      });
      await unlink(this.releaseLockOwnerFile).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      await rmdir(this.releaseLockRoot).catch((rmdirError) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(rmdirError.code)) throw rmdirError;
      });
    }
    throw this.releaseInProgressError(task);
  }

  async releaseReleaseLock(operationId, task) {
    try {
      let owner;
      try {
        owner = JSON.parse(await readFile(this.releaseLockOwnerFile, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if (owner.instanceId !== this.instanceId || owner.operationId !== operationId) return;
      await unlink(this.releaseLockOwnerFile);
      await rmdir(this.releaseLockRoot);
    } finally {
      await this.releaseTaskOperationLock(operationId, task);
    }
  }

  async inventoryTaskspace(task) {
    let contract;
    try {
      const value = JSON.parse(await readFile(this.verificationContractPath, 'utf8'));
      contract = this.verificationMode === 'host-toolchain'
        ? validateHostVerificationContract(value, this.projectSlug)
        : validateVerificationContract(value, this.projectSlug);
    } catch (error) {
      throw taskspaceError(
        'TASKSPACE_VERIFICATION_CONTRACT_INVALID',
        `The reviewed verification inventory limits are unavailable: ${error.message}`,
      );
    }
    return inventoryWorkspace(task.workspace, contract.limits);
  }

  isDirectDevelopment(context) {
    return this.developmentMode === 'direct' && isForgeDirectDevelopmentContract(context?.contract);
  }

  async assertCheckpointPaths(task, paths, ownedPaths, context) {
    const workspaceReal = await realpath(task.workspace);
    for (const relative of paths) {
      if ((CHECKPOINT_SECRET_PATH.test(relative)
          && (!isForgeCredentialHandlingSourcePath(relative) || /private[-_.]?key/iu.test(relative)))
        || (this.isDirectDevelopment(context) && relative === 'PROJECT_CONTEXT.md')
        || (!this.isDirectDevelopment(context) && !ownedPaths.some((owned) => isForgeTaskOwnedPath(relative, owned)))) {
        throw taskspaceError(
          'TASKSPACE_CHECKPOINT_PATH_DENIED',
          'Checkpoint paths must be ordinary non-secret source paths inside the authorized TaskSpace; platform context remains protected.',
        );
      }
      let current = task.workspace;
      const segments = relative.split('/');
      for (const [index, segment] of segments.entries()) {
        current = path.join(current, segment);
        try {
          const item = await lstat(current);
          if (item.isSymbolicLink()) {
            throw taskspaceError('TASKSPACE_CHECKPOINT_PATH_DENIED', 'Checkpoint paths cannot traverse symbolic links.');
          }
          if (index < segments.length - 1 && !item.isDirectory()) {
            throw taskspaceError('TASKSPACE_CHECKPOINT_PATH_DENIED', 'Checkpoint path parents must be directories.');
          }
          if (index === segments.length - 1 && (!item.isFile() || item.nlink !== 1)) {
            throw taskspaceError('TASKSPACE_CHECKPOINT_PATH_DENIED', 'Checkpoint sources must be ordinary, unlinked files or tracked deletions.');
          }
        } catch (error) {
          if (error.code === 'ENOENT' && index === segments.length - 1) break;
          throw error;
        }
      }
      const parentReal = await realpath(path.dirname(current));
      if (parentReal !== workspaceReal && !parentReal.startsWith(`${workspaceReal}${path.sep}`)) {
        throw taskspaceError('TASKSPACE_CHECKPOINT_PATH_DENIED', 'Checkpoint path escaped the TaskSpace workspace.');
      }
    }
  }

  integrationStateFile(taskId) {
    return path.join(this.integrationStateRoot, `${taskId}.json`);
  }

  sourceTransitionFile(taskId) {
    return path.join(this.sourceTransitionRoot, `${taskId}.json`);
  }

  async readBrokerState(filePath) {
    try {
      const before = await lstat(filePath);
      if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > MAX_EXECUTION_STATE_BYTES) {
        throw taskspaceError('TASKSPACE_INTEGRATION_STATE_INVALID', 'Broker integration state is invalid.');
      }
      const bytes = await readFile(filePath);
      const after = await lstat(filePath);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
        throw taskspaceError('TASKSPACE_INTEGRATION_STATE_CHANGED', 'Broker integration state changed while it was being read.', { retryable: true });
      }
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error?.code?.startsWith?.('TASKSPACE_')) throw error;
      throw taskspaceError('TASKSPACE_INTEGRATION_STATE_INVALID', 'Broker integration state is invalid.');
    }
  }

  async integrationProjection(task) {
    const [integration, sourceTransition] = await Promise.all([
      this.readBrokerState(this.integrationStateFile(task.metadata.taskId)),
      this.readBrokerState(this.sourceTransitionFile(task.metadata.taskId)),
    ]);
    let projectedConflictPaths = integration?.conflictPaths ?? [];
    if (integration?.phase === 'source-saved-error'
      && integration?.error?.code === 'TASKSPACE_INTEGRATION_DIRTY_LIMIT') {
      projectedConflictPaths = parseNulPaths((await this.gitReadonly(
        task.workspace, 'diff', '--name-only', '--diff-filter=U', '-z', '--',
      )).output);
    }
    return {
      integration: integration === null ? null : {
        schemaVersion: integration.schemaVersion,
        operationId: integration.operationId,
        phase: integration.phase,
        canonicalHead: integration.canonicalHead,
        savedSourceCommit: integration.savedSourceCommit,
        conflictPaths: projectedConflictPaths,
        ...(integration.phase === 'source-saved-error' ? { error: integration.error } : {}),
        from: integration.from,
        to: integration.to,
      },
      sourceTransition,
    };
  }

  async gitOperationPathExists(cwd, name) {
    const gitPath = (await this.checkpointGit(cwd, 'rev-parse', '--git-path', name)).output.trim();
    try {
      await lstat(path.resolve(cwd, gitPath));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async assertNoGitOperation(task) {
    const states = await Promise.all([
      'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply',
    ].map(async (name) => [name, await this.gitOperationPathExists(task.workspace, name)]));
    const active = states.filter(([, exists]) => exists).map(([name]) => name);
    if (active.length > 0) {
      throw taskspaceError(
        'TASKSPACE_INTEGRATION_OPERATION_ACTIVE',
        `Integrate start requires no existing merge, rebase, cherry-pick, or revert state (${active.join(', ')}).`,
      );
    }
  }

  async exactStageAndCommit(task, request, context, before) {
    if (request.paths.length === 0) return {
      commit: before.head,
      tree: (await this.checkpointGit(task.workspace, 'rev-parse', 'HEAD^{tree}')).output.trim(),
      saved: false, inventory: before,
    };
    const beforeFiles = new Map(before.files.map((item) => [item.relative, item]));
    if (request.paths.some((relative) => !beforeFiles.has(relative))) {
      throw taskspaceError('TASKSPACE_INTEGRATION_SOURCE_INVALID', 'An integrate path is absent from the verified source inventory.');
    }
    await this.checkpointGit(task.workspace, 'add', '--', ...request.paths);
    const afterAdd = await this.inventoryTaskspace(task);
    const stagedAfterAdd = parseNulPaths((await this.checkpointGit(
      task.workspace, 'diff', '--cached', '--name-only', '--no-renames', '-z', '--',
    )).output);
    if (afterAdd.head !== before.head
      || !sameInventoryFilesAfterExactStaging(before, afterAdd, request.paths)
      || !samePaths(stagedAfterAdd, request.paths)) {
      throw taskspaceError('TASKSPACE_INTEGRATION_SOURCE_CHANGED', 'Integrate source or staged paths changed during exact staging.', { retryable: true });
    }
    const afterFiles = new Map(afterAdd.files.map((item) => [item.relative, item]));
    for (const relative of request.paths) {
      const verified = beforeFiles.get(relative);
      const current = afterFiles.get(relative);
      if (verified.deleted === true) {
        const indexed = (await this.checkpointGit(task.workspace, '--literal-pathspecs', 'ls-files', '--stage', '--', relative)).output.trim();
        if (indexed !== '') throw taskspaceError('TASKSPACE_INTEGRATION_INDEX_MISMATCH', 'A verified deletion was not represented exactly in the index.');
        continue;
      }
      if (current?.sha256 !== verified.sha256 || current.bytes !== verified.bytes) {
        throw taskspaceError('TASKSPACE_INTEGRATION_SOURCE_CHANGED', 'Integrate source bytes changed during staging.', { retryable: true });
      }
      const [sourceBlob, indexBlob] = await Promise.all([
        this.checkpointGit(task.workspace, 'hash-object', '--no-filters', '--', relative),
        this.checkpointGit(task.workspace, 'rev-parse', `:${relative}`),
      ]);
      if (sourceBlob.output.trim() !== indexBlob.output.trim()) {
        throw taskspaceError('TASKSPACE_INTEGRATION_INDEX_MISMATCH', 'The staged blob does not equal the verified source bytes.');
      }
    }
    await this.checkpointGit(task.workspace, 'commit', '--no-verify', '-m', 'Preserve TaskSpace source before canonical integration');
    const [commitResult, treeResult, statusResult, after] = await Promise.all([
      this.checkpointGit(task.workspace, 'rev-parse', 'HEAD'),
      this.checkpointGit(task.workspace, 'rev-parse', 'HEAD^{tree}'),
      this.checkpointGit(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
      this.inventoryTaskspace(task),
    ]);
    const commit = commitResult.output.trim();
    const tree = treeResult.output.trim();
    const parents = (await this.checkpointGit(task.workspace, 'rev-list', '--parents', '-n', '1', commit)).output.trim().split(' ');
    const committedPaths = parseNulPaths((await this.checkpointGit(
      task.workspace, 'diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', '-z', commit,
    )).output);
    if (!COMMIT_PATTERN.test(commit) || commit === before.head || !COMMIT_PATTERN.test(tree)
      || parents.length !== 2 || parents[1] !== before.head || statusResult.output !== ''
      || !samePaths(committedPaths, request.paths)
      || after.head !== commit || after.workspaceFingerprint !== afterAdd.workspaceFingerprint) {
      throw taskspaceError('TASKSPACE_INTEGRATION_SAVE_POSTCONDITION_FAILED', 'Saved source commit postconditions did not hold; repository state was preserved for inspection.');
    }
    return { commit, tree, saved: true, inventory: after, actionCeiling: context.actionCeiling };
  }

  integrationIdentity(task, context) {
    return {
      projectSlug: this.projectSlug,
      taskId: task.metadata.taskId,
      actorUserId: context.actorUserId,
      actorUsername: context.actorUsername,
      conversationId: context.conversationId,
      dshSessionId: context.dshSessionId,
    };
  }

  integrationAuthority(context) {
    return {
      executionId: context.executionId,
      generation: context.generation,
      contractId: context.contractId,
      productionAuthorityDigest: context.productionAuthorityDigest,
      controllerGrantDigest: context.controllerGrantDigest,
      actionCeiling: context.actionCeiling,
      issuedAt: context.issuedAt,
      expiresAt: context.expiresAt,
    };
  }

  validateContinuationCandidateBinding(projection, task, context, request, candidate) {
    const projectionKeys = [
      'schemaVersion', 'projectionType', 'taskId', 'contractId', 'candidate',
      'sourceAuthorityBinding', 'recordDigest',
    ];
    const bindingKeys = [
      'actionCeiling', 'actorUserId', 'actorUsername', 'authorityClass',
      'authorityWorkspaceFingerprint', 'contractId', 'controllerGrantDigest',
      'conversationId', 'dshSessionId', 'executionId', 'generation', 'productionAuthorityDigest',
      'productionAuthorityId', 'projectSlug', 'rpcId', 'sourceCommit', 'taskId',
    ];
    const source = projection?.candidate?.source;
    const binding = projection?.sourceAuthorityBinding;
    const exactIdentity = binding?.projectSlug === this.projectSlug
      && binding?.taskId === task.metadata.taskId
      && binding?.actorUserId === context.actorUserId
      && binding?.actorUsername === context.actorUsername
      && binding?.conversationId === context.conversationId
      && binding?.dshSessionId === context.dshSessionId;
    const exactAuthority = binding?.executionId === context.executionId
      && binding?.generation === context.generation
      && binding?.contractId === context.contractId
      && binding?.rpcId === context.rpcId
      && binding?.productionAuthorityId === context.productionAuthorityId
      && binding?.productionAuthorityDigest === context.productionAuthorityDigest
      && binding?.controllerGrantDigest === context.controllerGrantDigest
      && binding?.actionCeiling === context.actionCeiling
      && binding?.authorityClass === 'production-task-writer'
      && binding?.sourceCommit === context.sourceCommit
      && binding?.authorityWorkspaceFingerprint === context.workspaceFingerprint;
    const exactCandidate = source?.head === candidate.head
      && source?.head === request.expectedHead
      && source?.fingerprint === candidate.workspaceFingerprint
      && source?.fingerprint === request.expectedWorkspaceFingerprint;
    if (!exactObjectKeys(projection, projectionKeys)
      || projection.schemaVersion !== 1
      || projection.projectionType !== 'forge-candidate-authority-binding/v1'
      || projection.taskId !== task.metadata.taskId
      || projection.contractId !== context.contractId
      || !/^sha256:[a-f0-9]{64}$/u.test(projection.recordDigest)
      || !exactObjectKeys(projection.candidate, ['source'])
      || !exactObjectKeys(source, ['head', 'fingerprint'])
      || !exactObjectKeys(binding, bindingKeys)
      || !exactIdentity || !exactAuthority || !exactCandidate) {
      throw taskspaceError(
        'TASKSPACE_CONTINUATION_CANDIDATE_BINDING_MISMATCH',
        'The current Host-bound candidate does not match this continuation authority and source.',
      );
    }
  }

  async writeSourceTransition(task, operation, phase, { from, to, sourceAuthority }) {
    const record = sourceTransitionRecord({
      schemaVersion: 1,
      operationId: operation.operationId,
      task: operation.task,
      from,
      to,
      canonicalHead: operation.canonicalHead,
      phase,
      sourceAuthority,
    });
    await atomicJson(this.sourceTransitionFile(task.metadata.taskId), record);
    return record;
  }

  async recoveryGit(cwd, ...args) {
    return this.command('git', [
      '-C', cwd,
      '-c', 'user.name=Forge Integration Replay',
      '-c', 'user.email=forge-integration-replay@localhost',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgSign=false',
      '-c', 'diff.external=',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.file.allow=always',
      ...args,
    ], {
      cleanGitEnvironment: true,
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_EXTERNAL_DIFF: '',
      },
    });
  }

  async readLegacyPathDeniedIntegration(task, request, context) {
    // Old start failed after Git opened the merge but before the conflict record
    // was written. Only its own failed audit operation may enter immutable replay.
    const info = await lstat(this.auditFile).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info === null || !info.isFile() || info.isSymbolicLink()) return null;
    const file = await open(this.auditFile, 'r');
    let records;
    try {
      const offset = Math.max(0, info.size - 256 * 1024);
      const buffer = Buffer.alloc(info.size - offset);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (offset > 0) lines.shift();
      records = lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
    } finally { await file.close(); }
    const matches = records.filter((item) => item.type === 'taskspace-integrate'
      && item.status === 'failed' && item.mode === 'start' && item.action === 'integrate'
      && item.operationId === request.operationId && item.taskId === task.metadata.taskId
      && item.actorId === task.metadata.actorId && item.conversationId === task.metadata.conversationId
      && item.error?.code === 'TASKSPACE_CHECKPOINT_PATH_DENIED');
    if (matches.length !== 1) return null;
    const originalHead = (await this.checkpointGit(task.workspace, 'rev-parse', 'ORIG_HEAD')).output.trim();
    if (originalHead !== request.expectedHead) {
      throw taskspaceError('TASKSPACE_INTEGRATION_RECOVERY_MISMATCH', 'The unrecorded merge no longer has its original clean source HEAD.');
    }
    await this.checkpointGit(task.workspace, 'merge-base', '--is-ancestor', task.metadata.baseCommit, originalHead);
    return {
      schemaVersion: 1, operationId: request.operationId, phase: 'source-saved-error',
      task: this.integrationIdentity(task, context), canonicalHead: request.canonicalHead,
      from: { head: originalHead, fingerprint: context.workspaceFingerprint },
      savedSourceCommit: originalHead,
      savedSourceTree: (await this.checkpointGit(task.workspace, 'rev-parse', `${originalHead}^{tree}`)).output.trim(),
      sourceAuthority: this.integrationAuthority(context), error: matches[0].error,
      legacyAudit: matches[0], updatedAt: matches[0].at,
    };
  }

  async recoverDirtyLimitConflict(task, request, pending, context) {
    if (pending?.schemaVersion !== 1 || pending.phase !== 'source-saved-error'
      || !['TASKSPACE_INTEGRATION_DIRTY_LIMIT', 'TASKSPACE_CHECKPOINT_PATH_DENIED'].includes(pending.error?.code)
      || pending.operationId !== request.operationId) {
      throw taskspaceError('TASKSPACE_INTEGRATION_NOT_PENDING', 'The requested integration operation is not pending conflict resolution.');
    }
    const identity = this.integrationIdentity(task, context);
    if (JSON.stringify(identity) !== JSON.stringify(pending.task)) {
      throw taskspaceError('TASKSPACE_INTEGRATION_IDENTITY_CHANGED', 'Integration recovery authority does not match the originating TaskSpace identity.');
    }
    const rawTransition = await this.readBrokerState(this.sourceTransitionFile(task.metadata.taskId));
    let priorCheckpoint = null;
    if (rawTransition !== null) {
      try { priorCheckpoint = validateSourceTransition(rawTransition); } catch {
        throw taskspaceError('TASKSPACE_INTEGRATION_STATE_INVALID', 'Integration recovery found an invalid prior source transition.');
      }
      if (priorCheckpoint.phase !== 'checkpointed'
        || priorCheckpoint.operationId === pending.operationId
        || canonicalJson(priorCheckpoint.task) !== canonicalJson(identity)) {
        throw taskspaceError('TASKSPACE_INTEGRATION_STATE_INVALID', 'Integration recovery found an unrelated or active source transition.');
      }
    }
    const [headResult, treeResult, canonicalHead, mergeHead, beforeStatus, beforeIndex, beforeInventory] = await Promise.all([
      this.checkpointGit(task.workspace, 'rev-parse', 'HEAD'),
      this.checkpointGit(task.workspace, 'rev-parse', 'HEAD^{tree}'),
      this.canonicalHead(),
      this.checkpointGit(task.workspace, 'rev-parse', 'MERGE_HEAD'),
      this.checkpointGit(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
      this.checkpointGit(task.workspace, 'ls-files', '--stage', '-z'),
      this.inventoryTaskspace(task),
    ]);
    const head = headResult.output.trim();
    const merge = mergeHead.output.trim();
    if (head !== pending.savedSourceCommit || head !== request.expectedHead
      || context.sourceCommit !== head || treeResult.output.trim() !== pending.savedSourceTree
      || request.canonicalHead !== pending.canonicalHead
      || merge !== pending.canonicalHead || request.expectedWorkspaceFingerprint !== beforeInventory.workspaceFingerprint
      || context.workspaceFingerprint !== beforeInventory.workspaceFingerprint) {
      throw taskspaceError('TASKSPACE_INTEGRATION_RECOVERY_MISMATCH', 'Dirty-limit recovery no longer matches the protected saved source, target, or fresh authority.');
    }
    if (priorCheckpoint !== null) {
      const [originalHead, checkpointParents] = await Promise.all([
        this.checkpointGit(task.workspace, 'rev-parse', 'ORIG_HEAD'),
        this.checkpointGit(task.workspace, 'rev-list', '--parents', '-n', '1', head),
      ]);
      const parents = checkpointParents.output.trim().split(' ');
      // A completed checkpoint is historical provenance, not recovery authority.
      // Keep its record intact; the open merge must start at its exact result.
      if (priorCheckpoint.to.head !== head || pending.from?.head !== head
        || originalHead.output.trim() !== head || parents.length !== 2
        || parents[1] !== priorCheckpoint.from.head) {
        throw taskspaceError('TASKSPACE_INTEGRATION_STATE_INVALID', 'Prior checkpoint does not match the original clean integration source.');
      }
    }
    await this.assertIntegrationTargetAncestor(pending.canonicalHead, canonicalHead);
    if (head !== pending.from?.head) {
      const parents = (await this.checkpointGit(task.workspace, 'rev-list', '--parents', '-n', '1', head)).output.trim().split(' ');
      const savedPaths = parseNulPaths((await this.checkpointGit(
        task.workspace, 'diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', '-z', head,
      )).output);
      if (parents.length !== 2 || parents[1] !== pending.from?.head || savedPaths.length < 1 || savedPaths.length > 64) {
        throw taskspaceError('TASKSPACE_INTEGRATION_RECOVERY_MISMATCH', 'Saved source commit ancestry or bounded source paths are invalid.');
      }
      await this.assertCheckpointPaths(task, savedPaths, context.ownedPaths, context);
    }
    // Reject a still-unowned conflict before creating the preserved replay copy.
    await this.assertCheckpointPaths(task, request.paths, context.ownedPaths, context);
    const objectInventory = (await this.checkpointGit(task.workspace, 'count-objects', '-v')).output;
    const objectSizes = Object.fromEntries(objectInventory.trim().split('\n').map((line) => {
      const separator = line.indexOf(': ');
      return separator < 1 ? [line, Number.NaN] : [line.slice(0, separator), Number.parseInt(line.slice(separator + 2), 10)];
    }));
    const sizeKeys = ['size', 'size-pack', 'size-garbage'];
    if (sizeKeys.some((key) => !Number.isSafeInteger(objectSizes[key]) || objectSizes[key] < 0)) {
      throw taskspaceError('TASKSPACE_INTEGRATION_RECOVERY_LIMIT', 'The immutable Git replay source size is invalid.');
    }
    const repositoryKiB = sizeKeys.reduce((total, key) => total + objectSizes[key], 0);
    if (!Number.isSafeInteger(repositoryKiB)
      || repositoryKiB > MAX_INTEGRATION_RECOVERY_GIT_KIB) {
      throw taskspaceError('TASKSPACE_INTEGRATION_RECOVERY_LIMIT', 'The immutable Git replay source exceeds the bounded recovery repository size.');
    }

    const referenceName = `${task.metadata.taskId}-${pending.operationId}`;
    const referenceParent = path.join(this.integrationRecoveryRoot, referenceName);
    const referenceRepository = path.join(referenceParent, 'repository');
    await mkdir(this.integrationRecoveryRoot, { recursive: true, mode: 0o700 });
    try {
      await mkdir(referenceParent, { mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw taskspaceError('TASKSPACE_INTEGRATION_RECOVERY_REFERENCE_EXISTS', 'A preserved dirty-limit recovery reference already exists; automatic replay will not overwrite it.');
      }
      throw error;
    }
    await this.command('git', [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false',
      '-c', 'credential.helper=',
      '-c', 'protocol.allow=never',
      '-c', 'protocol.file.allow=always',
      'clone', '--no-hardlinks', '--no-checkout', '--', task.workspace, referenceRepository,
    ], {
      cleanGitEnvironment: true,
      env: {
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_EXTERNAL_DIFF: '',
      },
    });
    await this.recoveryGit(referenceRepository, 'checkout', '--detach', head);
    await this.recoveryGit(referenceRepository, 'merge', '--no-edit', pending.canonicalHead).catch(() => undefined);
    const [referenceHead, referenceMergeHead, referenceStatus, referenceIndex, referenceInventory] = await Promise.all([
      this.recoveryGit(referenceRepository, 'rev-parse', 'HEAD'),
      this.recoveryGit(referenceRepository, 'rev-parse', 'MERGE_HEAD'),
      this.recoveryGit(referenceRepository, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
      this.recoveryGit(referenceRepository, 'ls-files', '--stage', '-z'),
      inventoryWorkspace(referenceRepository, (this.verificationMode === 'host-toolchain'
        ? validateHostVerificationContract
        : validateVerificationContract)(JSON.parse(await readFile(this.verificationContractPath, 'utf8')), this.projectSlug).limits),
    ]);
    const conflictPaths = parseNulPaths((await this.recoveryGit(
      referenceRepository, 'diff', '--name-only', '--diff-filter=U', '-z', '--',
    )).output);
    const completeDirty = parsePorcelainPaths(referenceStatus.output);
    const replayMismatches = [
      ...(referenceHead.output.trim() === head ? [] : ['head']),
      ...(referenceMergeHead.output.trim() === pending.canonicalHead ? [] : ['merge-head']),
      ...(conflictPaths.length >= 1 && conflictPaths.length <= 64 ? [] : ['conflict-limit']),
      ...(referenceStatus.output === beforeStatus.output ? [] : ['status']),
      ...(referenceIndex.output === beforeIndex.output ? [] : ['index']),
      ...(samePaths(conflictPaths, request.paths) ? [] : ['requested-conflicts']),
    ];
    if (replayMismatches.length > 0) {
      throw taskspaceError('TASKSPACE_INTEGRATION_RECOVERY_REPLAY_MISMATCH', `The live open merge does not exactly match the isolated immutable replay (${replayMismatches.join(', ')}).`);
    }
    await this.assertCheckpointPaths(task, conflictPaths, context.ownedPaths, context);
    const currentFiles = new Map(beforeInventory.files.map((item) => [item.relative, item]));
    const referenceFiles = new Map(referenceInventory.files.map((item) => [item.relative, item]));
    if (completeDirty.some((relative) => {
      const live = currentFiles.get(relative);
      const replayed = referenceFiles.get(relative);
      return live?.deleted !== replayed?.deleted || live?.bytes !== replayed?.bytes || live?.sha256 !== replayed?.sha256;
    })) {
      throw taskspaceError('TASKSPACE_INTEGRATION_RECOVERY_REPLAY_MISMATCH', 'Live conflict or automatically merged worktree bytes differ from the isolated immutable replay.');
    }
    const stagedPaths = parseNulPaths((await this.recoveryGit(
      referenceRepository, 'diff', '--cached', '--name-only', '--no-renames', '-z', '--',
    )).output);
    const conflictSet = new Set(conflictPaths);
    const automaticStagedPaths = stagedPaths.filter((relative) => !conflictSet.has(relative));
    const automaticIndex = automaticStagedPaths.length === 0 ? '' : (await this.recoveryGit(
      referenceRepository, 'ls-files', '--stage', '-z', '--', ...automaticStagedPaths,
    )).output;
    const [afterHead, afterTree, afterCanonical, afterMerge, afterStatus, afterIndex, afterInventory] = await Promise.all([
      this.checkpointGit(task.workspace, 'rev-parse', 'HEAD'),
      this.checkpointGit(task.workspace, 'rev-parse', 'HEAD^{tree}'),
      this.canonicalHead(),
      this.checkpointGit(task.workspace, 'rev-parse', 'MERGE_HEAD'),
      this.checkpointGit(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
      this.checkpointGit(task.workspace, 'ls-files', '--stage', '-z'),
      this.inventoryTaskspace(task),
    ]);
    if (afterHead.output.trim() !== head || afterTree.output.trim() !== pending.savedSourceTree
      || afterMerge.output.trim() !== pending.canonicalHead
      || afterStatus.output !== beforeStatus.output || afterIndex.output !== beforeIndex.output
      || afterInventory.workspaceFingerprint !== beforeInventory.workspaceFingerprint) {
      throw taskspaceError('TASKSPACE_INTEGRATION_RECOVERY_CHANGED', 'Live source or canonical state changed during isolated recovery replay.', { retryable: true });
    }
    await this.assertIntegrationTargetAncestor(pending.canonicalHead, afterCanonical);
    const historical = {
      phase: pending.phase,
      error: pending.error,
      from: pending.from,
      sourceAuthority: pending.sourceAuthority,
      updatedAt: pending.updatedAt,
    };
    const recoveredAt = new Date().toISOString();
    const { error: historicalError, ...pendingWithoutActiveError } = pending;
    const recovered = {
      ...pendingWithoutActiveError,
      phase: 'conflict-open',
      task: identity,
      from: { head, fingerprint: beforeInventory.workspaceFingerprint },
      sourceAuthority: this.integrationAuthority(context),
      reviewBaseBeforeIntegration: task.metadata.baseCommit,
      conflictPaths,
      dirtyPaths: completeDirty,
      conflictFileSnapshots: conflictPaths.map((relative) => {
        const item = referenceFiles.get(relative);
        return { relative, deleted: item.deleted === true, bytes: item.bytes, ...(item.deleted === true ? {} : { sha256: item.sha256 }) };
      }),
      automaticStagedPaths,
      automaticIndexDigest: sha256Text(automaticIndex),
      to: { head, fingerprint: beforeInventory.workspaceFingerprint },
      recovery: {
        kind: pending.error.code === 'TASKSPACE_CHECKPOINT_PATH_DENIED'
          ? 'source-saved-path-denied-v1' : 'source-saved-dirty-limit-v1',
        historical: { ...historical, error: historicalError },
        referencePath: path.relative(this.projectRoot, referenceParent).split(path.sep).join('/'),
        recoveredAt,
      },
      updatedAt: recoveredAt,
    };
    await atomicJson(this.integrationStateFile(task.metadata.taskId), recovered);
    await this.audit({
      type: 'taskspace-integrate-recovery', status: 'conflict-baseline-restored',
      operationId: pending.operationId, taskId: task.metadata.taskId,
      actorId: task.metadata.actorId, conversationId: task.metadata.conversationId,
      savedSourceCommit: head, canonicalHead: pending.canonicalHead,
      dirtyPathCount: completeDirty.length, conflictPaths,
      referencePath: recovered.recovery.referencePath,
    });
    return {
      operationId: pending.operationId, operation: 'integrate', status: 'conflict-open',
      recoveryOnly: true, continuationRequired: true,
      canonicalHead: pending.canonicalHead, savedSourceCommit: head, head,
      workspaceFingerprint: beforeInventory.workspaceFingerprint, workspaceClean: false,
      conflictPaths, dirtyPaths: completeDirty, sourceTransition: null,
    };
  }

  async throwSourceSavedIntegrationError(task, operation, saved, error) {
    const exposed = publicError(error);
    const failed = {
      ...operation,
      phase: 'source-saved-error',
      savedSourceCommit: saved.commit,
      savedSourceTree: saved.tree,
      error: exposed,
      updatedAt: new Date().toISOString(),
    };
    await atomicJson(this.integrationStateFile(task.metadata.taskId), failed).catch(() => undefined);
    error.integration = {
      operationId: operation.operationId,
      phase: failed.phase,
      savedSourceCommit: saved.commit,
      canonicalHead: operation.canonicalHead,
    };
    throw error;
  }

  async startIntegration(task, request, operationId) {
    const context = await readProductionExecutionContextForTask({
      projectRoot: this.projectRoot, taskMetadata: task.metadata, action: 'integrate',
    });
    await this.assertNoGitOperation(task);
    const candidate = await this.inspectCandidate(task, { checkpointSafe: true });
    if (candidate.head !== request.expectedHead || context.sourceCommit !== request.expectedHead) {
      throw taskspaceError('TASKSPACE_INTEGRATION_HEAD_CHANGED', 'Integrate HEAD no longer matches the protected expected commit.', { retryable: true });
    }
    if (candidate.canonicalHead !== request.canonicalHead) {
      throw taskspaceError('TASKSPACE_INTEGRATION_TARGET_CHANGED', 'The canonical integration target changed before integrate started.', { retryable: true });
    }
    const staged = parseNulPaths((await this.checkpointGit(
      task.workspace, 'diff', '--cached', '--name-only', '-z', '--',
    )).output);
    if (staged.length !== 0) {
      throw taskspaceError('TASKSPACE_INTEGRATION_INDEX_NOT_EMPTY', 'Integrate start requires an empty Git index before exact source preservation.');
    }
    const dirty = parsePorcelainPaths((await this.checkpointGit(
      task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
    )).output);
    if (!samePaths(dirty, request.paths)) {
      throw taskspaceError('TASKSPACE_INTEGRATION_DIRTY_MISMATCH', `Complete Git dirty paths do not exactly match integrate paths (${JSON.stringify(dirty)}).`);
    }
    await this.assertCheckpointPaths(task, request.paths, context.ownedPaths, context);
    const before = await this.inventoryTaskspace(task);
    if (before.head !== request.expectedHead
      || before.workspaceFingerprint !== request.expectedWorkspaceFingerprint) {
      throw taskspaceError('TASKSPACE_INTEGRATION_FINGERPRINT_CHANGED', 'Integrate source fingerprint is stale.', { retryable: true });
    }
    if (request.expectedWorkspaceFingerprint !== context.workspaceFingerprint && !this.isDirectDevelopment(context)) {
      const projection = await this.protectedCandidateBindingClient({ taskId: task.metadata.taskId });
      this.validateContinuationCandidateBinding(projection, task, context, request, before);
    }
    const operation = {
      schemaVersion: 1,
      operationId,
      phase: 'starting',
      task: this.integrationIdentity(task, context),
      from: { head: request.expectedHead, fingerprint: request.expectedWorkspaceFingerprint },
      canonicalHead: request.canonicalHead,
      reviewBaseBeforeIntegration: task.metadata.baseCommit,
      sourceAuthority: this.integrationAuthority(context),
      startedAt: new Date().toISOString(),
    };
    let saved;
    try {
      saved = await this.exactStageAndCommit(task, request, context, before);
      operation.savedSourceCommit = saved.commit;
      operation.savedSourceTree = saved.tree;
      if (await this.canonicalHead() !== request.canonicalHead) {
        throw taskspaceError('TASKSPACE_INTEGRATION_TARGET_CHANGED', 'The canonical integration target changed after source preservation.');
      }
      await this.checkpointGit(task.workspace, 'merge', '--no-edit', request.canonicalHead);
    } catch (error) {
      if (saved === undefined) {
        const currentHead = (await this.checkpointGit(task.workspace, 'rev-parse', 'HEAD')).output.trim();
        if (currentHead === request.expectedHead) throw error;
        const parents = (await this.checkpointGit(task.workspace, 'rev-list', '--parents', '-n', '1', currentHead)).output.trim().split(' ');
        if (parents.length !== 2 || parents[1] !== request.expectedHead) throw error;
        saved = {
          commit: currentHead,
          tree: (await this.checkpointGit(task.workspace, 'rev-parse', 'HEAD^{tree}')).output.trim(),
          saved: true,
        };
        operation.savedSourceCommit = saved.commit;
        operation.savedSourceTree = saved.tree;
      }
      const mergeHead = await this.gitOperationPathExists(task.workspace, 'MERGE_HEAD')
        ? (await this.checkpointGit(task.workspace, 'rev-parse', 'MERGE_HEAD')).output.trim()
        : null;
      const conflictPaths = parseNulPaths((await this.checkpointGit(
        task.workspace, 'diff', '--name-only', '--diff-filter=U', '-z', '--',
      )).output);
      if (mergeHead === request.canonicalHead && conflictPaths.length > 0) {
        const completeDirty = parsePorcelainPaths((await this.checkpointGit(
          task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
        )).output);
        if (conflictPaths.length > 64) {
          error = taskspaceError('TASKSPACE_INTEGRATION_CONFLICT_LIMIT', 'The open merge exceeds the bounded 64-conflict continuation contract.');
        } else {
          const stagedPaths = parseNulPaths((await this.checkpointGit(
            task.workspace, 'diff', '--cached', '--name-only', '--no-renames', '-z', '--',
          )).output);
          const conflictSet = new Set(conflictPaths);
          const automaticStagedPaths = stagedPaths.filter((relative) => !conflictSet.has(relative));
          const automaticIndex = automaticStagedPaths.length === 0 ? '' : (await this.checkpointGit(
            task.workspace, 'ls-files', '--stage', '-z', '--', ...automaticStagedPaths,
          )).output;
          try {
            await this.assertCheckpointPaths(task, conflictPaths, context.ownedPaths, context);
          } catch (pathError) {
            return this.throwSourceSavedIntegrationError(task, operation, saved, pathError);
          }
          const current = await this.inventoryTaskspace(task);
          const currentFiles = new Map(current.files.map((item) => [item.relative, item]));
          const conflictFileSnapshots = conflictPaths.map((relative) => {
            const item = currentFiles.get(relative);
            if (item === undefined) {
              throw taskspaceError('TASKSPACE_INTEGRATION_SOURCE_INVALID', 'A conflict path is absent from the source inventory.');
            }
            return {
              relative,
              deleted: item.deleted === true,
              bytes: item.bytes,
              ...(item.deleted === true ? {} : { sha256: item.sha256 }),
            };
          });
          const pending = {
            ...operation,
            phase: 'conflict-open',
            savedSourceCommit: saved.commit,
            savedSourceTree: saved.tree,
            mergeHead,
            conflictPaths,
            dirtyPaths: completeDirty,
            conflictFileSnapshots,
            automaticStagedPaths,
            automaticIndexDigest: sha256Text(automaticIndex),
            to: { head: current.head, fingerprint: current.workspaceFingerprint },
            updatedAt: new Date().toISOString(),
          };
          await atomicJson(this.integrationStateFile(task.metadata.taskId), pending);
          const sourceTransition = await this.writeSourceTransition(task, pending, 'conflict-open', {
            from: pending.from,
            to: pending.to,
            sourceAuthority: pending.sourceAuthority,
          });
          return {
            operationId,
            operation: 'integrate',
            status: 'conflict-open',
            canonicalHead: request.canonicalHead,
            savedSourceCommit: saved.commit,
            head: current.head,
            workspaceFingerprint: current.workspaceFingerprint,
            workspaceClean: false,
            conflictPaths,
            dirtyPaths: completeDirty,
            sourceTransition,
          };
        }
      }
      return this.throwSourceSavedIntegrationError(task, operation, saved, error);
    }
    let integratedHead;
    let current;
    try {
      const [head, statusResult, inventory, currentCanonical] = await Promise.all([
        this.checkpointGit(task.workspace, 'rev-parse', 'HEAD'),
        this.checkpointGit(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
        this.inventoryTaskspace(task),
        this.canonicalHead(),
      ]);
      integratedHead = head.output.trim();
      current = inventory;
      await this.checkpointGit(task.workspace, 'merge-base', '--is-ancestor', request.canonicalHead, integratedHead);
      if (!COMMIT_PATTERN.test(integratedHead) || statusResult.output !== '' || current.head !== integratedHead
        || currentCanonical !== request.canonicalHead) {
        throw taskspaceError('TASKSPACE_INTEGRATION_POSTCONDITION_FAILED', 'Integrated repository postconditions did not hold; repository state was preserved for inspection.');
      }
    } catch (error) {
      return this.throwSourceSavedIntegrationError(task, operation, saved, error);
    }
    const completed = {
      ...operation,
      phase: 'integrated',
      savedSourceCommit: saved.commit,
      savedSourceTree: saved.tree,
      to: { head: integratedHead, fingerprint: current.workspaceFingerprint },
      reviewBaseTransition: {
        from: operation.reviewBaseBeforeIntegration,
        to: request.canonicalHead,
        appliedAt: null,
      },
      updatedAt: new Date().toISOString(),
    };
    await atomicJson(this.integrationStateFile(task.metadata.taskId), completed);
    const sourceTransition = integratedHead === request.expectedHead
      ? null
      : await this.writeSourceTransition(task, completed, 'integrated', {
        from: completed.from,
        to: completed.to,
        sourceAuthority: completed.sourceAuthority,
      });
    return {
      operationId,
      operation: 'integrate',
      status: 'integrated',
      canonicalHead: request.canonicalHead,
      savedSourceCommit: saved.saved ? saved.commit : null,
      head: integratedHead,
      workspaceFingerprint: current.workspaceFingerprint,
      workspaceClean: true,
      sourceTransition,
    };
  }

  async continueIntegration(task, request) {
    let pending = await this.readBrokerState(this.integrationStateFile(task.metadata.taskId));
    if (pending === null) {
      const context = await readProductionExecutionContextForTask({
        projectRoot: this.projectRoot, taskMetadata: task.metadata, action: 'integrate',
      });
      pending = await this.readLegacyPathDeniedIntegration(task, request, context);
    }
    if (pending?.schemaVersion === 1 && pending.operationId === request.operationId
      && pending.phase === 'integrated') {
      return this.resumeIntegratedFinalization(task, request, pending);
    }
    if (pending?.phase === 'source-saved-error'
      && ['TASKSPACE_INTEGRATION_DIRTY_LIMIT', 'TASKSPACE_CHECKPOINT_PATH_DENIED'].includes(pending?.error?.code)
      && pending?.operationId === request.operationId) {
      const context = await readProductionExecutionContextForTask({
        projectRoot: this.projectRoot, taskMetadata: task.metadata, action: 'integrate',
      });
      return this.recoverDirtyLimitConflict(task, request, pending, context);
    }
    if (pending?.schemaVersion !== 1 || pending.operationId !== request.operationId
      || pending.phase !== 'conflict-open') {
      throw taskspaceError('TASKSPACE_INTEGRATION_NOT_PENDING', 'The requested integration operation is not pending conflict resolution.');
    }
    const context = await readProductionExecutionContextForTask({
      projectRoot: this.projectRoot, taskMetadata: task.metadata, action: 'integrate',
    });
    const identity = this.integrationIdentity(task, context);
    if (JSON.stringify(identity) !== JSON.stringify(pending.task)) {
      throw taskspaceError('TASKSPACE_INTEGRATION_IDENTITY_CHANGED', 'Integration continuation authority does not match the originating TaskSpace identity.');
    }
    const [headResult, canonicalHead, mergeHead] = await Promise.all([
      this.checkpointGit(task.workspace, 'rev-parse', 'HEAD'),
      this.canonicalHead(),
      this.checkpointGit(task.workspace, 'rev-parse', 'MERGE_HEAD'),
    ]);
    const head = headResult.output.trim();
    if (head !== request.expectedHead || context.sourceCommit !== request.expectedHead
      || head !== pending.savedSourceCommit) {
      throw taskspaceError('TASKSPACE_INTEGRATION_HEAD_CHANGED', 'Integration continuation HEAD no longer matches the protected expected commit.', { retryable: true });
    }
    if (request.canonicalHead !== pending.canonicalHead
      || mergeHead.output.trim() !== pending.canonicalHead) {
      throw taskspaceError('TASKSPACE_INTEGRATION_TARGET_CHANGED', 'The fixed canonical integration target changed while conflicts were open.');
    }
    await this.assertIntegrationTargetAncestor(pending.canonicalHead, canonicalHead);
    const before = await this.inventoryTaskspace(task);
    if (before.head !== request.expectedHead
      || before.workspaceFingerprint !== request.expectedWorkspaceFingerprint) {
      throw taskspaceError('TASKSPACE_INTEGRATION_FINGERPRINT_CHANGED', 'Integration continuation fingerprint is stale.', { retryable: true });
    }
    if (request.expectedWorkspaceFingerprint !== context.workspaceFingerprint && !this.isDirectDevelopment(context)) {
      const projection = await this.protectedCandidateBindingClient({ taskId: task.metadata.taskId });
      this.validateContinuationCandidateBinding(projection, task, context, request, before);
    }
    const reviewBaseBeforeIntegration = pending.reviewBaseBeforeIntegration
      ?? pending.recovery?.historical?.from?.head;
    if (!COMMIT_PATTERN.test(reviewBaseBeforeIntegration ?? '')
      || task.metadata.baseCommit !== reviewBaseBeforeIntegration) {
      throw taskspaceError(
        'TASKSPACE_INTEGRATION_REVIEW_BASE_CHANGED',
        'TaskSpace review base changed while integration conflicts were open.',
        { retryable: true },
      );
    }
    const dirty = parsePorcelainPaths((await this.checkpointGit(
      task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
    )).output);
    if (!samePaths(pending.conflictPaths, request.paths)) {
      throw taskspaceError('TASKSPACE_INTEGRATION_CONFLICT_MISMATCH', 'Integrate continuation paths must exactly match the pending conflict paths.');
    }
    await this.assertCheckpointPaths(task, pending.conflictPaths, context.ownedPaths, context);
    const conflictSet = new Set(pending.conflictPaths);
    const unresolvedBeforeAdd = parseNulPaths((await this.checkpointGit(
      task.workspace, 'diff', '--name-only', '--diff-filter=U', '-z', '--',
    )).output);
    if (unresolvedBeforeAdd.some((relative) => !conflictSet.has(relative))) {
      throw taskspaceError('TASKSPACE_INTEGRATION_CONFLICT_CHANGED', 'Integration continuation contains a conflict outside the original conflict paths.');
    }
    const stagedPaths = parseNulPaths((await this.checkpointGit(
      task.workspace, 'diff', '--cached', '--name-only', '--no-renames', '-z', '--',
    )).output);
    const currentAutomaticPaths = stagedPaths.filter((relative) => !conflictSet.has(relative));
    if (!samePaths(currentAutomaticPaths, pending.automaticStagedPaths)) {
      throw taskspaceError('TASKSPACE_INTEGRATION_EXTRA_STAGED', 'Integration continuation contains extra or missing staged paths outside the original conflicts.');
    }
    const automaticIndex = currentAutomaticPaths.length === 0 ? '' : (await this.checkpointGit(
      task.workspace, 'ls-files', '--stage', '-z', '--', ...currentAutomaticPaths,
    )).output;
    if (sha256Text(automaticIndex) !== pending.automaticIndexDigest) {
      throw taskspaceError('TASKSPACE_INTEGRATION_AUTOMERGE_CHANGED', 'Automatically merged index content changed while conflicts were being resolved.');
    }
    const unstagedPaths = parseNulPaths((await this.checkpointGit(
      task.workspace, 'diff', '--name-only', '--no-renames', '-z', '--',
    )).output);
    const untrackedPaths = parseNulPaths((await this.checkpointGit(
      task.workspace, 'ls-files', '--others', '--exclude-standard', '-z', '--',
    )).output);
    if ([...unstagedPaths, ...untrackedPaths].some((relative) => !conflictSet.has(relative))) {
      throw taskspaceError('TASKSPACE_INTEGRATION_EXTRA_DIRTY', 'Integration continuation changed a path outside the original conflicts.');
    }
    if (stagedPaths.some((relative) => !conflictSet.has(relative)
      && !pending.automaticStagedPaths.includes(relative))) {
      throw taskspaceError('TASKSPACE_INTEGRATION_EXTRA_STAGED', 'Integration continuation staged a path outside the bounded merge result.');
    }
    if (!Array.isArray(pending.conflictFileSnapshots)
      || !samePaths(pending.conflictFileSnapshots.map((item) => item?.relative), pending.conflictPaths)
      || pending.conflictFileSnapshots.some((item) => item === null || typeof item !== 'object'
        || typeof item.deleted !== 'boolean' || !Number.isSafeInteger(item.bytes) || item.bytes < 0
        || (item.deleted === true && item.bytes !== 0)
        || (item.deleted === false && !SHA256_PATTERN.test(item.sha256)))) {
      throw taskspaceError('TASKSPACE_INTEGRATION_STATE_INVALID', 'Integration conflict source snapshots are invalid.');
    }
    if (!samePaths(dirty, pending.dirtyPaths ?? [])) {
      throw taskspaceError('TASKSPACE_INTEGRATION_DIRTY_MISMATCH', 'Complete Git dirty paths changed from the original conflict state.');
    }
    const beforeFiles = new Map(before.files.map((item) => [item.relative, item]));
    for (const snapshot of pending.conflictFileSnapshots) {
      const current = beforeFiles.get(snapshot.relative);
      const unchanged = snapshot.deleted === true
        ? current?.deleted === true
        : current?.deleted !== true && current?.bytes === snapshot.bytes && current?.sha256 === snapshot.sha256;
      if (unchanged) {
        throw taskspaceError('TASKSPACE_INTEGRATION_CONFLICT_UNCHANGED', 'A conflict path is unchanged from its original conflict snapshot.');
      }
    }
    await this.checkpointGit(task.workspace, 'add', '--all', '--', ...pending.conflictPaths);
    const afterAdd = await this.inventoryTaskspace(task);
    if (afterAdd.head !== before.head
      || !sameInventoryFilesAfterExactStaging(before, afterAdd, pending.conflictPaths)) {
      throw taskspaceError('TASKSPACE_INTEGRATION_SOURCE_CHANGED', 'Resolved conflict source changed during exact staging.', { retryable: true });
    }
    const unresolved = parseNulPaths((await this.checkpointGit(
      task.workspace, 'diff', '--name-only', '--diff-filter=U', '-z', '--',
    )).output);
    if (unresolved.length > 0) {
      throw taskspaceError('TASKSPACE_INTEGRATION_CONFLICT_UNRESOLVED', `Integration conflicts remain unresolved (${JSON.stringify(unresolved)}).`);
    }
    const stagedAfterAdd = parseNulPaths((await this.checkpointGit(
      task.workspace, 'diff', '--cached', '--name-only', '--no-renames', '-z', '--',
    )).output);
    const automaticAfterAdd = stagedAfterAdd.filter((relative) => !conflictSet.has(relative));
    if (!samePaths(automaticAfterAdd, pending.automaticStagedPaths)
      || stagedAfterAdd.some((relative) => !conflictSet.has(relative)
        && !pending.automaticStagedPaths.includes(relative))) {
      throw taskspaceError('TASKSPACE_INTEGRATION_EXTRA_STAGED', 'Exact conflict staging changed paths outside the bounded merge result.');
    }
    const automaticIndexAfterAdd = automaticAfterAdd.length === 0 ? '' : (await this.checkpointGit(
      task.workspace, 'ls-files', '--stage', '-z', '--', ...automaticAfterAdd,
    )).output;
    if (sha256Text(automaticIndexAfterAdd) !== pending.automaticIndexDigest) {
      throw taskspaceError('TASKSPACE_INTEGRATION_AUTOMERGE_CHANGED', 'Automatically merged index content changed during exact conflict staging.');
    }
    const [unstagedAfterAdd, untrackedAfterAdd] = await Promise.all([
      this.checkpointGit(task.workspace, 'diff', '--name-only', '--no-renames', '-z', '--'),
      this.checkpointGit(task.workspace, 'ls-files', '--others', '--exclude-standard', '-z', '--'),
    ]);
    if (unstagedAfterAdd.output !== '' || untrackedAfterAdd.output !== '') {
      throw taskspaceError('TASKSPACE_INTEGRATION_INDEX_MISMATCH', 'Resolved conflict worktree bytes were not staged exactly.');
    }
    for (const relative of pending.conflictPaths) {
      const indexed = (await this.checkpointGit(task.workspace, '--literal-pathspecs', 'ls-files', '--stage', '--', relative)).output.trim();
      if (indexed === '') {
        try {
          await lstat(path.join(task.workspace, relative));
          throw taskspaceError('TASKSPACE_INTEGRATION_INDEX_MISMATCH', 'A resolved deletion still exists in the worktree.');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        continue;
      }
      if (!/^[0-7]{6} [0-9a-f]{40} 0\t/u.test(indexed)) {
        throw taskspaceError('TASKSPACE_INTEGRATION_INDEX_MISMATCH', 'A resolved conflict does not have exactly one stage-zero index entry.');
      }
      const [sourceBlob, indexBlob] = await Promise.all([
        this.checkpointGit(task.workspace, 'hash-object', '--no-filters', '--', relative),
        this.checkpointGit(task.workspace, 'rev-parse', `:${relative}`),
      ]);
      if (sourceBlob.output.trim() !== indexBlob.output.trim()) {
        throw taskspaceError('TASKSPACE_INTEGRATION_INDEX_MISMATCH', 'Resolved conflict bytes do not equal the protected staged blob.');
      }
    }
    await this.assertIntegrationTargetAncestor(pending.canonicalHead, await this.canonicalHead());
    await this.checkpointGit(task.workspace, 'commit', '--no-verify', '--no-edit');
    const [commitResult, statusResult, after] = await Promise.all([
      this.checkpointGit(task.workspace, 'rev-parse', 'HEAD'),
      this.checkpointGit(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
      this.inventoryTaskspace(task),
    ]);
    const commit = commitResult.output.trim();
    const parents = (await this.checkpointGit(task.workspace, 'rev-list', '--parents', '-n', '1', commit)).output.trim().split(' ');
    if (!COMMIT_PATTERN.test(commit) || parents.length !== 3 || parents[1] !== pending.savedSourceCommit
      || parents[2] !== pending.canonicalHead || statusResult.output !== '' || after.head !== commit) {
      throw taskspaceError('TASKSPACE_INTEGRATION_POSTCONDITION_FAILED', 'Merge commit postconditions did not hold; repository state was preserved for inspection.');
    }
    const completed = {
      ...pending,
      phase: 'integrated',
      to: { head: commit, fingerprint: after.workspaceFingerprint },
      continuationAuthority: this.integrationAuthority(context),
      reviewBaseTransition: {
        from: reviewBaseBeforeIntegration,
        to: pending.canonicalHead,
        appliedAt: null,
      },
      updatedAt: new Date().toISOString(),
    };
    await atomicJson(this.integrationStateFile(task.metadata.taskId), completed);
    const sourceTransition = await this.writeSourceTransition(task, completed, 'integrated', {
      from: {
        head: request.expectedHead,
        fingerprint: request.expectedWorkspaceFingerprint,
      },
      to: completed.to,
      sourceAuthority: completed.continuationAuthority,
    });
    return {
      operationId: request.operationId,
      operation: 'integrate',
      status: 'integrated',
      canonicalHead: pending.canonicalHead,
      savedSourceCommit: pending.savedSourceCommit,
      head: commit,
      workspaceFingerprint: after.workspaceFingerprint,
      workspaceClean: true,
      sourceTransition,
    };
  }

  async integrate(task, request) {
    if (this.activeRelease !== null) throw this.releaseInProgressError(task);
    const operationId = request.mode === 'continue' ? request.operationId : crypto.randomUUID();
    try {
      await this.acquireReleaseLock(operationId, task, 'integrate');
    } catch (error) {
      if (error.integration === undefined) {
        const pending = await this.readBrokerState(this.integrationStateFile(task.metadata.taskId)).catch(() => null);
        if (pending?.operationId === operationId
          && (pending.phase === 'integrated' || pending.savedSourceCommit)) {
          error.integration = {
            operationId,
            phase: pending.phase,
            savedSourceCommit: pending.savedSourceCommit,
            canonicalHead: pending.canonicalHead,
          };
        }
      }
      await this.audit({
        type: 'taskspace-integrate', status: 'rejected', operationId, action: 'integrate', mode: request.mode,
        taskId: task.metadata.taskId, actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId, error: publicError(error),
      }).catch(() => undefined);
      throw error;
    }
    this.activeRelease = {
      operationId, operation: 'integrate', action: 'integrate', mode: request.mode,
      taskId: task.metadata.taskId, actorId: task.metadata.actorId, startedAt: new Date().toISOString(),
    };
    try {
      let result = request.mode === 'start'
        ? await this.startIntegration(task, request, operationId)
        : await this.continueIntegration(task, request);
      result = await this.finalizeIntegratedReviewBase(task, result);
      await this.audit({
        type: 'taskspace-integrate', status: 'success', integrateStatus: result.status,
        operationId, action: 'integrate', mode: request.mode,
        taskId: task.metadata.taskId, actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId,
        head: result.head, canonicalHead: result.canonicalHead,
        savedSourceCommit: result.savedSourceCommit, conflictPaths: result.conflictPaths,
        ...(result.reviewBaseTransition === undefined
          ? {}
          : { reviewBaseTransition: result.reviewBaseTransition }),
      });
      return result;
    } catch (error) {
      if (error.integration === undefined) {
        const pending = await this.readBrokerState(this.integrationStateFile(task.metadata.taskId)).catch(() => null);
        if (pending?.operationId === operationId
          && (pending.phase === 'integrated' || pending.savedSourceCommit)) {
          error.integration = {
            operationId,
            phase: pending.phase,
            savedSourceCommit: pending.savedSourceCommit,
            canonicalHead: pending.canonicalHead,
          };
        }
      }
      await this.audit({
        type: 'taskspace-integrate', status: 'failed', operationId, action: 'integrate', mode: request.mode,
        taskId: task.metadata.taskId, actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId, error: publicError(error),
      }).catch(() => undefined);
      throw error;
    } finally {
      if (this.activeRelease?.operationId === operationId) this.activeRelease = null;
      await this.releaseReleaseLock(operationId, task).catch(() => undefined);
    }
  }

  async checkpoint(task, request) {
    const operationId = crypto.randomUUID();
    let beforeHead = request.expectedHead;
    try {
      await this.acquireTaskOperationLock(operationId, task);
      await this.assertCheckpointProjectLock(task);
    } catch (error) {
      await this.releaseTaskOperationLock(operationId, task).catch(() => undefined);
      await this.audit({
        type: 'taskspace-checkpoint', status: 'rejected', operationId, action: 'checkpoint',
        taskId: task.metadata.taskId, actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId, error: publicError(error),
      }).catch(() => undefined);
      throw error;
    }
    try {
      const context = await readProductionExecutionContextForTask({
        projectRoot: this.projectRoot, taskMetadata: task.metadata, action: 'checkpoint',
      });
      const candidate = await this.inspectCandidate(task, { checkpointSafe: true });
      beforeHead = candidate.head;
      if (candidate.head !== request.expectedHead || context.sourceCommit !== request.expectedHead) {
        throw taskspaceError('TASKSPACE_CHECKPOINT_HEAD_CHANGED', 'Checkpoint HEAD no longer matches the protected expected commit.', { retryable: true });
      }
      // A checkpoint saves only this TaskSpace's owned source. Canonical
      // ancestry is a release prerequisite, not a prerequisite for local save.
      const staged = parseNulPaths((await this.checkpointGit(
        task.workspace, 'diff', '--cached', '--name-only', '-z', '--',
      )).output);
      if (staged.length !== 0) {
        throw taskspaceError('TASKSPACE_CHECKPOINT_INDEX_NOT_EMPTY', 'Checkpoint requires an empty Git index before staging exact paths.');
      }
      const dirty = parsePorcelainPaths((await this.checkpointGit(
        task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all',
      )).output);
      if (request.paths.some((relative) => !dirty.includes(relative))) {
        throw taskspaceError(
          'TASKSPACE_CHECKPOINT_DIRTY_MISMATCH',
          `Every checkpoint path must be an existing dirty path (${JSON.stringify(dirty)}).`,
        );
      }
      const remainingDirtyPaths = dirty.filter((relative) => !request.paths.includes(relative));
      await this.assertCheckpointPaths(task, request.paths, context.ownedPaths, context);
      const before = await this.inventoryTaskspace(task);
      if (before.head !== request.expectedHead
        || before.workspaceFingerprint !== request.expectedWorkspaceFingerprint) {
        throw taskspaceError('TASKSPACE_CHECKPOINT_FINGERPRINT_CHANGED', 'Checkpoint source fingerprint is stale.', { retryable: true });
      }
      if (request.expectedWorkspaceFingerprint !== context.workspaceFingerprint && !this.isDirectDevelopment(context)) {
        const projection = await this.protectedCandidateBindingClient({ taskId: task.metadata.taskId });
        this.validateContinuationCandidateBinding(projection, task, context, request, before);
      }
      const beforeFiles = new Map(before.files.map((item) => [item.relative, item]));
      if (request.paths.some((relative) => !beforeFiles.has(relative))) {
        throw taskspaceError('TASKSPACE_CHECKPOINT_SOURCE_INVALID', 'A checkpoint path is absent from the verified source inventory.');
      }

      await this.checkpointGit(task.workspace, 'add', '--', ...request.paths);
      const afterAdd = await this.inventoryTaskspace(task);
      const stagedAfterAdd = parseNulPaths((await this.checkpointGit(
        task.workspace, 'diff', '--cached', '--name-only', '--no-renames', '-z', '--',
      )).output);
      if (afterAdd.head !== before.head
        || !sameInventoryFilesAfterExactStaging(before, afterAdd, request.paths)
        || !samePaths(stagedAfterAdd, request.paths)) {
        throw taskspaceError('TASKSPACE_CHECKPOINT_SOURCE_CHANGED', 'Checkpoint source or staged paths changed during exact staging.', { retryable: true });
      }
      const afterFiles = new Map(afterAdd.files.map((item) => [item.relative, item]));
      for (const relative of request.paths) {
        const verified = beforeFiles.get(relative);
        const current = afterFiles.get(relative);
        if (verified.deleted === true) {
          const indexed = (await this.checkpointGit(task.workspace, '--literal-pathspecs', 'ls-files', '--stage', '--', relative)).output.trim();
          if (indexed !== '') throw taskspaceError('TASKSPACE_CHECKPOINT_INDEX_MISMATCH', 'A verified deletion was not represented exactly in the index.');
          continue;
        }
        if (current?.sha256 !== verified.sha256 || current.bytes !== verified.bytes) {
          throw taskspaceError('TASKSPACE_CHECKPOINT_SOURCE_CHANGED', 'Checkpoint source bytes changed during staging.', { retryable: true });
        }
        const [sourceBlob, indexBlob] = await Promise.all([
          this.checkpointGit(task.workspace, 'hash-object', '--no-filters', '--', relative),
          this.checkpointGit(task.workspace, 'rev-parse', `:${relative}`),
        ]);
        if (sourceBlob.output.trim() !== indexBlob.output.trim()) {
          throw taskspaceError('TASKSPACE_CHECKPOINT_INDEX_MISMATCH', 'The staged blob does not equal the verified source bytes.');
        }
      }

      await this.checkpointGit(task.workspace, 'commit', '--no-verify', '-m', request.message);
      const [commitResult, treeResult, statusResult, after] = await Promise.all([
        this.checkpointGit(task.workspace, 'rev-parse', 'HEAD'),
        this.checkpointGit(task.workspace, 'rev-parse', 'HEAD^{tree}'),
        this.checkpointGit(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
        this.inventoryTaskspace(task),
      ]);
      const commit = commitResult.output.trim();
      const parents = (await this.checkpointGit(task.workspace, 'rev-list', '--parents', '-n', '1', commit)).output.trim().split(' ');
      const committedPaths = parseNulPaths((await this.checkpointGit(
        task.workspace, 'diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', '-z', commit,
      )).output);
      const tree = treeResult.output.trim();
      if (!COMMIT_PATTERN.test(commit) || commit === beforeHead || parents.length !== 2
        || !COMMIT_PATTERN.test(tree)
        || parents[0] !== commit || parents[1] !== beforeHead
        || !samePaths(parsePorcelainPaths(statusResult.output), remainingDirtyPaths)
        || !samePaths(committedPaths, request.paths)
        || after.head !== commit || after.workspaceFingerprint !== afterAdd.workspaceFingerprint) {
        throw taskspaceError('TASKSPACE_CHECKPOINT_POSTCONDITION_FAILED', 'Checkpoint commit postconditions did not hold; repository state was preserved for inspection.');
      }
      const sourceTransition = await this.writeSourceTransition(task, {
        operationId,
        task: this.integrationIdentity(task, context),
        canonicalHead: candidate.canonicalHead,
      }, 'checkpointed', {
        from: { head: beforeHead, fingerprint: before.workspaceFingerprint },
        to: { head: commit, fingerprint: after.workspaceFingerprint },
        sourceAuthority: this.integrationAuthority(context),
      });
      const result = {
        operationId, operation: 'checkpoint', status: 'checkpointed',
        beforeHead, commit, tree, canonicalHead: candidate.canonicalHead,
        changedPaths: [...request.paths], workspaceFingerprint: after.workspaceFingerprint,
        workspaceClean: remainingDirtyPaths.length === 0, remainingDirtyPaths, sourceTransition,
      };
      result.deliveryCenterDocuments = await captureDeliveryCheckpointDocuments({
        stateRoot: this.stateRoot, repositoryRoot: task.workspace, sourceTransition,
        commit, tree, changedPaths: result.changedPaths,
      });
      await this.audit({
        type: 'taskspace-checkpoint', action: 'checkpoint',
        taskId: task.metadata.taskId, actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId, ...result,
        status: 'success', checkpointStatus: result.status,
      });
      return result;
    } catch (error) {
      await this.audit({
        type: 'taskspace-checkpoint', status: 'failed', operationId, action: 'checkpoint',
        taskId: task.metadata.taskId, actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId, beforeHead, error: publicError(error),
      }).catch(() => undefined);
      throw error;
    } finally {
      await this.releaseTaskOperationLock(operationId, task).catch(() => undefined);
    }
  }

  async promoteCandidate(task, candidate) {
    const ref = `refs/forge-taskspaces/${task.metadata.taskId}`;
    await this.git(this.workspaceRoot, 'fetch', '--no-tags', task.workspace, `${candidate.head}:${ref}`);
    const current = await this.canonicalHead();
    if (current !== candidate.canonicalHead) {
      throw taskspaceError(
        'TASKSPACE_RELEASE_BASE_CHANGED',
        'The integration workspace advanced while this TaskSpace release was being prepared.',
        { retryable: true, recommendedAction: 'Run preflight again, integrate the latest project commit, and retry.' },
      );
    }
    if (this.gitRemoteRequired) {
      const remoteConfigurationReady = this.gitRemoteReady
        && GIT_REMOTE_NAME_PATTERN.test(this.gitRemoteName)
        && GIT_REMOTE_BRANCH_PATTERN.test(this.gitRemoteBranch)
        && !this.gitRemoteBranch.includes('..')
        && !this.gitRemoteBranch.endsWith('/.')
        && !this.gitRemoteBranch.endsWith('/')
        && this.gitSshCommand.length > 0;
      if (!remoteConfigurationReady) {
        throw taskspaceError(
          'TASKSPACE_GIT_REMOTE_NOT_READY',
          'The project private Git remote is required but has not completed its reviewed attachment.',
          { recommendedAction: 'Ask the platform operator to attach and verify the project Git remote.' },
        );
      }
      let remoteHead;
      try {
        const remoteUrl = (await this.remoteGit('remote', 'get-url', this.gitRemoteName)).output.trim();
        if (remoteUrl.length === 0 || /:\/\/[^/@]+:[^/@]+@/.test(remoteUrl)) {
          throw new Error('The project Git remote is missing or embeds credentials.');
        }
        const before = await this.remoteGit(
          'ls-remote', this.gitRemoteName, `refs/heads/${this.gitRemoteBranch}`,
        );
        remoteHead = before.output.trim().split(/\s+/u)[0] ?? '';
        if (remoteHead !== current) {
          throw taskspaceError(
            'TASKSPACE_GIT_REMOTE_DIVERGED',
            'The private Git remote no longer matches the project integration HEAD.',
            { recommendedAction: 'Stop releases and have the platform operator reconcile the remote without force-pushing.' },
          );
        }
        await this.remoteGit(
          'push', this.gitRemoteName, `${candidate.head}:refs/heads/${this.gitRemoteBranch}`,
        );
        const after = await this.remoteGit(
          'ls-remote', this.gitRemoteName, `refs/heads/${this.gitRemoteBranch}`,
        );
        const pushedHead = after.output.trim().split(/\s+/u)[0] ?? '';
        if (pushedHead !== candidate.head) throw new Error('Remote HEAD verification failed after push.');
      } catch (error) {
        if (error?.code === 'TASKSPACE_GIT_REMOTE_DIVERGED') throw error;
        throw taskspaceError(
          'TASKSPACE_GIT_REMOTE_FAILED',
          'The candidate could not be durably fast-forwarded to the project private Git remote.',
          { retryable: true, recommendedAction: 'Check the project deploy key, pinned host key, network, and remote branch, then retry.' },
        );
      }
    }
    await this.git(this.workspaceRoot, 'merge', '--ff-only', candidate.head);
    const promoted = await this.canonicalHead();
    if (promoted !== candidate.head) throw new Error('Integration workspace did not advance to the candidate commit.');
  }

  async readCrossLayerMigrationFailure(request) {
    const deny = () => { throw taskspaceError('CROSS_LAYER_MIGRATION_FAILURE_UNAVAILABLE',
      'No current protected candidate migration failure matches this conversation and accepted source.'); };
    const keys = ['taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'expectedHead', 'expectedFingerprint'];
    if (!request || Object.keys(request).sort().join(',') !== keys.sort().join(',')
      || !/^[a-z0-9][a-z0-9-]{1,79}$/u.test(request.taskId ?? '')
      || !COMMIT_PATTERN.test(request.expectedHead ?? '') || !SHA256_PATTERN.test(request.expectedFingerprint ?? '')) deny();
    const task = await this.readTask(request.taskId);
    const identity = { actorUserId: task.metadata.actorUserId, actorUsername: task.metadata.actorId,
      conversationId: task.metadata.conversationId };
    if (task.metadata.status !== 'active' || task.metadata.accessMode !== 'conversation'
      || Object.entries(identity).some(([key, value]) => request[key] !== value)) deny();
    const saved = await readCandidateValidationStateSnapshot(this.projectRoot, request.taskId);
    // This reads a historical fact, including an expired lease; it does not renew
    // or grant any execution authority. The Manager must separately admit repair.
    const context = validateProtectedExecutionContext(saved.value.current);
    const binding = context.preparationBinding;
    if (saved.value.lifecycle?.status !== 'consumed' || saved.value.recovery !== null
      || context.projectSlug !== this.projectSlug || context.taskId !== request.taskId
      || Object.entries(identity).some(([key, value]) => context[key] !== value)
      || context.dshSessionId !== request.dshSessionId || context.crossLayerPreparation !== true
      || context.authorityClass !== 'production-read-only' || context.testOnly
      || context.phaseId !== 'cross-layer-acceptance' || context.phaseIndex !== 7
      || context.actionCeiling !== 'read-only' || context.ownedPaths.length !== 0
      || binding?.baseSourceCommit !== request.expectedHead || binding.workspaceFingerprint !== request.expectedFingerprint) deny();
    const parentDirectory = path.join(this.stateRoot, 'delivery-phases', request.taskId, 'phase-control');
    const resolveDirectory = async () => (await readForgeAccessWiringRepairContinuation({ catalogFile: this.phaseCatalogFile,
      sourceStateFile: path.join(parentDirectory, 'state.json'), sourceArtifactsDirectory: path.join(parentDirectory, 'artifacts'),
      sourceCommit: request.expectedHead, taskId: request.taskId, sessionId: request.dshSessionId }))?.phaseDirectory ?? parentDirectory;
    const directory = await resolveDirectory();
    const stateFile = path.join(directory, 'state.json');
    const stateBefore = await readFile(stateFile);
    const state = JSON.parse(stateBefore.toString('utf8'));
    const prepared = await prepareForgeCrossLayerPreparation({ catalogFile: this.phaseCatalogFile, stateFile,
      artifactsDirectory: path.join(directory, 'artifacts'), sourceCommit: request.expectedHead,
      workspaceFingerprint: request.expectedFingerprint, taskId: request.taskId,
      sessionId: request.dshSessionId, rpcId: context.rpcId, promptText: '' });
    const same = (left, right) => JSON.stringify(Object.entries(left ?? {}).sort()) === JSON.stringify(Object.entries(right ?? {}).sort());
    if (prepared.preparationBinding.stateDigest !== binding.stateDigest
      || !same(prepared.preparationBinding.acceptedArtifactDigests, binding.acceptedArtifactDigests)) deny();
    const source = await this.inventoryTaskspace(task);
    if (source.head !== request.expectedHead || source.workspaceFingerprint !== request.expectedFingerprint) deny();
    const runnerFact = (diagnosis) => {
      const job = diagnosis?.lastJob;
      const recovery = diagnosis?.testDatabaseRecovery;
      if (diagnosis?.active !== false || diagnosis.activeJobId !== null
        || job?.status !== 'failed' || job.failedStage !== 'test-database-migration'
        || !['MIGRATION_EXECUTION_FAILED', 'MIGRATION_HISTORY_FAILED'].includes(job.error?.code)
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(job.jobId ?? '')
        || !COMMIT_PATTERN.test(job.commit ?? '') || job.provenance?.source !== 'taskspace'
        || job.provenance.taskId !== request.taskId || job.provenance.actorId !== identity.actorUsername
        || job.provenance.conversationId !== identity.conversationId || job.provenance.candidateCommit !== job.commit
        || !Number.isFinite(Date.parse(job.startedAt)) || !Number.isFinite(Date.parse(job.completedAt))
        || Date.parse(job.startedAt) < Date.parse(context.issuedAt) || Date.parse(job.startedAt) > Date.parse(context.expiresAt)
        || Date.parse(job.completedAt) < Date.parse(job.startedAt)
        || recovery?.status !== 'restore-required' || recovery.lastAttempt?.jobId !== job.jobId
        || recovery.lastAttempt.commit !== job.commit || recovery.lastAttempt.status !== 'failed') deny();
      return { jobId: job.jobId, candidateCommit: job.commit, status: job.status, failedStage: job.failedStage,
        startedAt: job.startedAt, completedAt: job.completedAt, errorCode: job.error.code,
        provenance: job.provenance, recoveryStatus: recovery.status, recoveryAttempt: recovery.lastAttempt };
    };
    const fact = runnerFact(await this.releaseStatusClient({ action: 'diagnose' }));
    const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    const factDigest = digest(JSON.stringify(fact));
    const access = await readForgeDeliveryAcceptedArtifact({ state, artifactsDirectory: path.join(directory, 'artifacts'),
      artifactKind: 'access-wiring-implementation' });
    const root = path.join(directory, 'runtime-preparations');
    const candidates = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()
      && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(entry.name));
    if (candidates.length > 64) deny();
    let matched;
    for (const entry of candidates) {
      const preparationDirectory = path.join(root, entry.name);
      const repository = path.join(preparationDirectory, 'source.git');
      const evidenceDirectory = path.join(preparationDirectory, 'evidence');
      const patchFile = path.join(evidenceDirectory, 'accepted.patch');
      const paths = await Promise.all([preparationDirectory, repository, evidenceDirectory, patchFile].map(file => lstat(file)));
      if (paths.some(value => value.isSymbolicLink()) || paths.slice(0, 3).some(value => !value.isDirectory())
        || !paths[3].isFile() || paths[3].size > MAX_INTEGRATION_RECOVERY_GIT_KIB * 1024) deny();
      const patchSha256 = digest(await readFile(patchFile));
      if (patchSha256 !== access.sourceFingerprint) continue;
      let result;
      try { result = await this.gitReadonly(repository, 'show', '-s', '--format=%T%n%P%n%B', fact.candidateCommit); }
      catch { continue; }
      const [candidateTree, parent, ...message] = result.output.trim().split(/\r?\n/u);
      if (!COMMIT_PATTERN.test(candidateTree) || parent !== request.expectedHead
        || message.join('\n').trim() !== `Accepted cross-layer candidate ${binding.stateDigest}`) continue;
      // A retry can have left the same immutable candidate in more than one
      // private directory; all matching facts must agree, never pick user input.
      if (matched && matched.candidateTree !== candidateTree) deny();
      matched ??= { preparationDirectory, candidateTree, acceptedPatchSha256: patchSha256 };
    }
    if (!matched) deny();
    const after = await readCandidateValidationStateSnapshot(this.projectRoot, request.taskId);
    const live = await this.inventoryTaskspace(task);
    if (await resolveDirectory() !== directory || !saved.bytes.equals(after.bytes) || !stateBefore.equals(await readFile(stateFile))
      || live.head !== source.head || live.workspaceFingerprint !== source.workspaceFingerprint
      || digest(JSON.stringify(runnerFact(await this.releaseStatusClient({ action: 'diagnose' })))) !== factDigest) deny();
    const failure = { schemaVersion: 'forge-cross-layer-preparation-failure/v1', taskId: request.taskId,
      sessionId: context.dshSessionId, ...identity, executionId: context.executionId,
      executionGeneration: context.generation, rpcId: context.rpcId, parentStateDigest: binding.stateDigest,
      baseSourceCommit: request.expectedHead, workspaceFingerprint: request.expectedFingerprint,
      acceptedArtifactDigests: { ...binding.acceptedArtifactDigests }, jobId: fact.jobId,
      candidateCommit: fact.candidateCommit, ...matched, status: fact.status, failedStage: fact.failedStage,
      startedAt: fact.startedAt, completedAt: fact.completedAt, errorCode: fact.errorCode,
      runnerEvidenceSha256: factDigest, sourceBindingSha256: digest(saved.bytes) };
    const bytes = Buffer.from(`${JSON.stringify(failure, null, 2)}\n`);
    const failureEvidenceFile = path.join(matched.preparationDirectory, 'migration-failure.json');
    try { await writeFile(failureEvidenceFile, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(failureEvidenceFile);
      if (!info.isFile() || info.isSymbolicLink() || !bytes.equals(await readFile(failureEvidenceFile))) deny();
    }
    return { status: 'failed-migration-bound', failureEvidenceFile, expectedFailureEvidenceSha256: digest(bytes), failure };
  }

  async prepareCrossLayer(task, request) {
    if (this.activeRelease !== null) throw this.releaseInProgressError(task);
    const operationId = crypto.randomUUID();
    await this.acquireReleaseLock(operationId, task, 'prepare');
    try {
      const readContext = async () => {
        const before = await readCandidateValidationStateSnapshot(this.projectRoot, task.metadata.taskId);
        const context = await readCurrentProtectedExecutionContextForTask({ projectRoot: this.projectRoot, taskMetadata: task.metadata });
        const after = await readCandidateValidationStateSnapshot(this.projectRoot, task.metadata.taskId);
        if (!before.bytes.equals(after.bytes) || after.value.lifecycle.status !== 'consumed') {
          throw taskspaceError('CROSS_LAYER_PREPARATION_DENIED', 'Only the current consumed preparation may run.');
        }
        return context;
      };
      const context = await readContext();
      return await prepareForgeCrossLayerCandidate({ projectRoot: this.projectRoot, task, request, context,
        catalogFile: this.phaseCatalogFile, inspectSource: () => this.inventoryTaskspace(task), readContext,
        publishCandidate: async (repository, commit) => {
          await this.git(this.workspaceRoot, 'fetch', '--no-tags', repository,
            `${commit}:refs/forge-cross-layer/${task.metadata.taskId}/${context.executionId}`);
        }, releaseClient: this.releaseClient, readReleaseStatus: () => this.releaseStatusClient({ action: 'diagnose' }) });
    } finally { await this.releaseReleaseLock(operationId, task); }
  }

  async release(task, request, onAccepted = null) {
    if (this.activeRelease !== null) {
      const error = this.releaseInProgressError(task);
      await this.audit({
        type: 'taskspace-release',
        status: 'rejected',
        taskId: task.metadata.taskId,
        actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId,
        error: publicError(error),
        activeRelease: this.activeRelease,
      }).catch(() => undefined);
      throw error;
    }
    const operationId = crypto.randomUUID();
    try {
      await this.acquireReleaseLock(operationId, task);
    } catch (error) {
      await this.audit({
        type: 'taskspace-release',
        status: 'rejected',
        operationId,
        taskId: task.metadata.taskId,
        actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId,
        error: publicError(error),
      }).catch(() => undefined);
      throw error;
    }
    this.activeRelease = {
      operationId,
      operation: 'release',
      action: 'release',
      services: request.services,
      version: request.version,
      stage: 'preflight',
      taskId: task.metadata.taskId,
      actorId: task.metadata.actorId,
      startedAt: new Date().toISOString(),
    };
    let candidate;
    let acceptance;
    try {
      candidate = await this.inspectCandidate(task);
      if (!candidate.workspaceClean) {
        throw taskspaceError('TASKSPACE_DIRTY', 'Commit the intended TaskSpace changes before release.');
      }
      if (!candidate.includesCanonical) {
        throw taskspaceError(
          'TASKSPACE_REBASE_REQUIRED',
          'This TaskSpace does not include the latest integration commit.',
          {
            retryable: true,
            recommendedAction: 'Fetch /integration, rebase or merge the latest integration commit, resolve conflicts, test, and commit before retrying.',
          },
        );
      }
      const context = await readProductionExecutionContextForTask({
        projectRoot: this.projectRoot, taskMetadata: task.metadata, action: 'release',
      });
      if (context.sourceCommit !== candidate.head) {
        throw taskspaceError(
          'TASKSPACE_RELEASE_AUTHORITY_STALE',
          'Protected release authority is not bound to the current clean candidate HEAD.',
        );
      }
      const inventory = await this.inventoryTaskspace(task);
      if (inventory.head !== candidate.head) {
        throw taskspaceError('TASKSPACE_RELEASE_SOURCE_CHANGED', 'Candidate HEAD changed during protected release admission.', { retryable: true });
      }
      if (inventory.workspaceFingerprint !== context.workspaceFingerprint) {
        throw taskspaceError('TASKSPACE_RELEASE_AUTHORITY_STALE', 'Protected release authority is not bound to the current source fingerprint.');
      }
      const directDevelopment = this.isDirectDevelopment(context);
      let projection;
      if (!directDevelopment) {
        try {
          projection = await this.protectedCompletionClient({ taskId: task.metadata.taskId });
        } catch {
          throw acceptanceNotReady('Protected acceptance projection is missing or unavailable.');
        }
        if (normalizedSha256(projection?.gateDigest) !== null) {
          acceptance = { gateDigest: projection.gateDigest };
        }
        if (this.verificationMode === 'host-toolchain' && !protectedCompletionProjectionReady(projection)) {
          const { gateDigest, ...payload } = projection ?? {};
          const ledger = projection?.ledgerSummary;
          const reviewPending = projection?.gateType === 'forge-protected-completion-gate/v1'
            && normalizedSha256(gateDigest) === sha256Text(canonicalJson(payload))
            && ledger?.taskContractId === context.contractId
            && normalizedSha256(projection.sourceFingerprint) === inventory.workspaceFingerprint
            && normalizedSha256(ledger.sourceFingerprint) === inventory.workspaceFingerprint
            && ledger.open?.length === 1 && ledger.open[0] === 'contract:api-error-and-auth-contract';
          if (reviewPending) {
            const hostContract = validateHostVerificationContract(JSON.parse(await readFile(this.verificationContractPath, 'utf8')), this.projectSlug);
            if (hostContract.independentReview === 'api-error-and-auth-contract') {
              await this.callVerification({ action: 'semantic-review', taskId: task.metadata.taskId, acceptanceContractId: context.contractId });
              const after = await this.inventoryTaskspace(task);
              const authority = await readProductionExecutionContextForTask({ projectRoot: this.projectRoot, taskMetadata: task.metadata, action: 'release' });
              if (after.head !== inventory.head || after.workspaceFingerprint !== inventory.workspaceFingerprint
                || authority.contractId !== context.contractId || authority.sourceCommit !== candidate.head
                || authority.workspaceFingerprint !== inventory.workspaceFingerprint) {
                throw taskspaceError('TASKSPACE_RELEASE_AUTHORITY_STALE', '审查期间候选或发布授权发生变化；已保存审查结果，未晋升或发布。');
              }
              projection = await this.protectedCompletionClient({ taskId: task.metadata.taskId });
            }
          }
        }
        acceptance = validateReleaseProjection(projection, context, inventory);
      } else {
        // Direct development retains release authority and exact source identity,
        // without treating optional development checks as a publication contract.
        acceptance = { developmentMode: 'direct' };
      }
      const runnerRequest = {
        services: request.services, approvalRef: request.approvalRef,
        ...(request.version === undefined ? {} : { version: request.version }),
        provenance: {
          source: 'taskspace', taskId: task.metadata.taskId, actorId: task.metadata.actorId,
          conversationId: task.metadata.conversationId, candidateCommit: candidate.head,
          sourceBaseCommit: task.metadata.baseCommit,
        },
      };
      await atomicJson(this.releaseStateFile, {
        schemaVersion: 1, ...this.activeRelease, status: 'running', stage: 'candidate-validation',
        commit: candidate.head, acceptanceGateDigest: acceptance.gateDigest,
      });
      onAccepted?.({ operation: 'release', status: 'accepted', operationId, taskId: task.metadata.taskId,
        terminal: false, startedAt: this.activeRelease.startedAt,
        recommendedAction: `Observe forge-release status --operation-id ${operationId}; accepted is not published. Do not resubmit release.` });
      // Fetch only objects into a private ref. Neither the shared branch nor
      // its remote advances until the exact image has passed startup checks.
      await this.git(this.workspaceRoot, 'fetch', '--no-tags', task.workspace,
        candidate.head + ':refs/forge-taskspaces/' + task.metadata.taskId);
      const prepared = await this.releaseClient({ action: 'prepare', ...runnerRequest });
      if (prepared?.status !== 'prepared' || prepared.commit !== candidate.head
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(prepared.jobId ?? '')) {
        throw taskspaceError('TASKSPACE_CANDIDATE_NOT_PREPARED',
          'The exact candidate build and startup have not completed; no shared branch was advanced.');
      }
      const afterPreparation = await this.inventoryTaskspace(task);
      if (afterPreparation.head !== candidate.head
        || afterPreparation.workspaceFingerprint !== inventory.workspaceFingerprint) {
        throw taskspaceError('TASKSPACE_RELEASE_SOURCE_CHANGED',
          'Candidate source changed during startup validation; no shared branch was advanced.', { retryable: true });
      }
      if (directDevelopment) {
        const currentTask = await this.readTask(task.metadata.taskId);
        await assertAdmittedProductionRelease({
          projectRoot: this.projectRoot, taskMetadata: currentTask.metadata, context,
        });
      }
      const currentProjection = directDevelopment ? null
        : await this.protectedCompletionClient({ taskId: task.metadata.taskId });
      if (!directDevelopment) acceptance = validateReleaseProjection(currentProjection, context, afterPreparation);
      const deliveryCenterSnapshot = directDevelopment ? { status: 'not-required', developmentMode: 'direct' }
        : await freezeDeliveryReleaseSnapshot({ projectSlug: this.projectSlug,
        projectRoot: this.projectRoot, taskId: task.metadata.taskId, commit: candidate.head,
        sourceFingerprint: afterPreparation.workspaceFingerprint, contractId: context.contractId, protectedGate: currentProjection,
        workspace: task.workspace, inspectSource: () => this.inventoryTaskspace(task) });
      await atomicJson(this.releaseStateFile, {
        schemaVersion: 1,
        operationId,
        status: 'running',
        stage: 'promote-candidate',
        taskId: task.metadata.taskId,
        actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId,
        commit: candidate.head,
        acceptanceGateDigest: acceptance.gateDigest,
        startedAt: this.activeRelease.startedAt,
      });
      await this.promoteCandidate(task, candidate);
      await atomicJson(this.releaseStateFile, {
        schemaVersion: 1,
        operationId,
        status: 'running',
        stage: 'controlled-release',
        taskId: task.metadata.taskId,
        actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId,
        commit: candidate.head,
        acceptanceGateDigest: acceptance.gateDigest,
        startedAt: this.activeRelease.startedAt,
      });
      const result = await this.releaseClient({
        action: 'release', ...runnerRequest, preparedJobId: prepared.jobId,
      });
      const completedAt = new Date().toISOString();
      const lastRelease = {
        operationId,
        status: 'success',
        commit: candidate.head,
        completedAt,
        runnerJobId: result.jobId,
        acceptanceGateDigest: acceptance.gateDigest,
        services: result.services,
        ...(result.releaseApplied === false ? { releaseApplied: false, outcome: 'unchanged' } : {}),
      };
      await this.writeTask(task.metadataPath, {
        ...task.metadata,
        lastCandidate: { commit: candidate.head, submittedAt: completedAt },
        ...(result.releaseApplied === false ? {} : { lastRelease }),
      });
      await atomicJson(this.releaseStateFile, {
        schemaVersion: 1,
        ...this.activeRelease,
        ...lastRelease,
      });
      await this.audit({
        type: 'taskspace-release',
        status: 'success',
        operationId,
        taskId: task.metadata.taskId,
        actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId,
        commit: candidate.head,
        runnerJobId: result.jobId,
        acceptanceGateDigest: acceptance.gateDigest,
        projectSlug: this.projectSlug,
        deliveryCenterSnapshot,
        ...(result.releaseApplied === false ? { releaseApplied: false, outcome: 'unchanged' } : {}),
      });
      return { ...result, ...(directDevelopment ? { developmentMode: 'direct', developmentVerification: 'not-required' } : {}),
        taskspace: { ...candidate, operationId } };
    } catch (error) {
      const completedAt = new Date().toISOString();
      const exposed = publicError(error);
      await atomicJson(this.releaseStateFile, {
        schemaVersion: 1,
        ...this.activeRelease,
        status: 'failed',
        stage: 'failed',
        commit: candidate?.head,
        ...(acceptance?.gateDigest === undefined ? {} : { acceptanceGateDigest: acceptance.gateDigest }),
        completedAt,
        error: exposed,
      }).catch(() => undefined);
      await this.audit({
        type: 'taskspace-release',
        status: 'failed',
        operationId,
        taskId: task.metadata.taskId,
        actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId,
        commit: candidate?.head,
        ...(acceptance?.gateDigest === undefined ? {} : { acceptanceGateDigest: acceptance.gateDigest }),
        error: exposed,
      }).catch(() => undefined);
      throw error;
    } finally {
      if (this.activeRelease?.operationId === operationId) this.activeRelease = null;
      await this.releaseReleaseLock(operationId, task).catch(() => undefined);
    }
  }

  async executeForTask(task, rawRequest) {
    const request = validateTaskspaceAction(rawRequest);
    const maintenance = await this.maintenanceState();
    if (maintenance.active && !['contract', 'diagnose', 'logs', 'execution-context', 'protected-completion'].includes(request.action)
      && !(request.action === 'writer-scope-lease' && ['settle', 'cancel-acquire'].includes(request.operation))) {
      throw taskspaceError(
        'TASKSPACE_PLATFORM_MAINTENANCE',
        'The project capability Broker is in a reviewed platform maintenance window.',
        { retryable: true, recommendedAction: 'Keep working in the TaskSpace and retry the release or verification capability after platform maintenance completes.' },
      );
    }
    if (request.action === 'logs') {
      if (task.metadata.projectSlug !== this.projectSlug || task.metadata.status !== 'active') {
        throw taskspaceError('TASKSPACE_NOT_ACTIVE', 'Runtime logs require an active Harness in this project.');
      }
      // Authentication binds the project; runtime diagnostics do not require
      // release ownership, a protected write context, or a clean candidate.
      return this.releaseClient({ ...request, action: 'runtime-logs' });
    }
    if (request.action === 'contract') {
      const runnerContract = await this.releaseClient({ action: 'contract' });
      return {
        schemaVersion: 1,
        isolationMode: 'taskspace-clone-and-serialized-promotion',
        task: task.metadata,
        runnerContract,
      };
    }
    if (request.action === 'diagnose') return this.diagnose();
    if (request.action === 'plan') {
      const candidate = await this.inspectCandidate(task);
      if (!candidate.workspaceClean || !candidate.includesCanonical) return { status: 'source-not-ready', taskspace: candidate,
        reason: 'Save or integrate the intended candidate before calculating its immutable release inputs.' };
      await this.git(this.workspaceRoot, 'fetch', '--no-tags', task.workspace,
        candidate.head + ':refs/forge-taskspaces/' + task.metadata.taskId);
      return this.releaseClient({ action: 'plan', provenance: {
        source: 'taskspace', taskId: task.metadata.taskId, actorId: task.metadata.actorId,
        conversationId: task.metadata.conversationId, candidateCommit: candidate.head, sourceBaseCommit: task.metadata.baseCommit,
      } });
    }
    if (request.action === 'status' && request.operationId !== undefined) {
      return { release: await this.releaseObservation(task, request.operationId) };
    }
    if (request.action === 'managed-files') {
      const config = this.managedFileTargets();
      if (request.operation === 'targets') return managedFileTargetList(config, task.metadata.actorUserId);
      const context = await readProtectedExecutionContext({ projectRoot: this.projectRoot, taskMetadata: task.metadata, lookup: request.lookup });
      if (context.executionId !== request.expectedExecutionId || context.generation !== request.expectedGeneration
        || task.metadata.status !== 'active' || task.metadata.accessMode !== 'conversation' || context.testOnly) {
        throw taskspaceError('MANAGED_FILE_CONTEXT', 'Managed files require the current active conversation execution.');
      }
      const authorization = await this.managedFileClient({
        ...Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'rpcId'].map(key => [key, context[key]])),
        promptTextDigest: context.textDigest, targetId: request.targetId, operation: request.operation, relativePath: request.relativePath,
      });
      const current = await readProtectedExecutionContext({ projectRoot: this.projectRoot, taskMetadata: task.metadata, lookup: request.lookup });
      if (current.executionId !== context.executionId || current.generation !== context.generation) throw taskspaceError('MANAGED_FILE_CONTEXT', 'The conversation request changed.');
      const { action: _action, lookup: _lookup, expectedExecutionId: _id, expectedGeneration: _generation, ...args } = request;
      return executeManagedFileOperation({ args, authorization, config: this.managedFileTargets(), stateRoot: this.stateRoot });
    }
    if (request.action === 'execution-context') {
      const sourceTransition = await this.readBrokerState(this.sourceTransitionFile(task.metadata.taskId));
      return readProtectedExecutionContext({
        projectRoot: this.projectRoot,
        taskMetadata: task.metadata,
        lookup: request,
        sourceTransition,
        renew: async (context, checkpointTransition) => {
          const before = await this.inventoryTaskspace(task);
          if (checkpointTransition !== null && checkpointTransition !== undefined
            && (before.head !== checkpointTransition.to.head
              || before.workspaceFingerprint !== checkpointTransition.to.fingerprint)) {
            throw taskspaceError('EXECUTION_RENEWAL_SOURCE_CHANGED', '受控提交后的源码已变化，不能续用该提交的验证证据。');
          }
          if (checkpointTransition?.phase === 'integrated') {
            const completed = await this.readBrokerState(this.integrationStateFile(task.metadata.taskId));
            const result = await this.resumeIntegratedFinalization(task, {
              operationId: checkpointTransition.operationId, canonicalHead: checkpointTransition.canonicalHead,
              expectedHead: before.head, expectedWorkspaceFingerprint: before.workspaceFingerprint,
            }, completed);
            if (result.status !== 'integrated' || result.workspaceClean !== true
              || result.sourceTransition?.digest !== checkpointTransition.digest) {
              throw taskspaceError('EXECUTION_RENEWAL_SOURCE_CHANGED', '集成续接缺少当前已完成且干净的受控集成事实。');
            }
          }
          const result = await this.executionRenewalClient({
            projectSlug: context.projectSlug, taskId: context.taskId, actorUserId: context.actorUserId,
            actorUsername: context.actorUsername, conversationId: context.conversationId,
            dshSessionId: context.dshSessionId, rpcId: context.rpcId, promptTextDigest: context.textDigest,
            contractId: context.contractId, source: { head: before.head, fingerprint: before.workspaceFingerprint },
            ...(checkpointTransition === null || checkpointTransition === undefined ? {} : { sourceTransition: checkpointTransition }),
          });
          const after = await this.inventoryTaskspace(task);
          if (after.head !== before.head || after.workspaceFingerprint !== before.workspaceFingerprint) {
            throw taskspaceError('EXECUTION_RENEWAL_SOURCE_CHANGED', '续期期间源码发生变化，请重试当前任务。');
          }
          return result;
        },
      });
    }
    if (request.action === 'writer-scope-lease') {
      const lookup = Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'conversationId',
        'dshSessionId', 'rpcId', 'textDigest'].map((key) => [key, request[key]]));
      return executeForgeWriterScopeLease({
        projectRoot: this.projectRoot, taskMetadata: task.metadata, workspace: task.workspace, request,
        readContext: () => readProtectedExecutionContext({
          projectRoot: this.projectRoot, taskMetadata: task.metadata, lookup,
        }),
      });
    }
    if (request.action === 'business-data-apply') {
      return executeForgeBusinessDataConsumption({ request,
        ...(process.env.FORGE_SEMANTIC_INTENT_ENABLED === 'true'
          ? { authorizeIntent: this.businessDataIntentClient } : {}),
        readContext: async () => {
          const before = await readCandidateValidationStateSnapshot(this.projectRoot, task.metadata.taskId);
          const context = await readCurrentProtectedExecutionContextForTask({ projectRoot: this.projectRoot, taskMetadata: task.metadata });
          const after = await readCandidateValidationStateSnapshot(this.projectRoot, task.metadata.taskId);
          if (!before.bytes.equals(after.bytes) || after.value?.lifecycle?.status !== 'consumed'
            || task.metadata.status !== 'active' || task.metadata.accessMode !== 'conversation') {
            throw taskspaceError('DATA_APPLY_EXECUTION_INACTIVE', 'The task must be active and its consumed protected execution binding unchanged.');
          }
          return context;
        },
        inspectSource: async () => {
          const inventory = await this.inventoryTaskspace(task);
          return { head: inventory.head, fingerprint: inventory.workspaceFingerprint };
        },
        consume: this.businessDataConsumer,
      });
    }
    if (request.action === 'business-data-preview') {
      return executeForgeBusinessDataPreview({
        request,
        readContext: () => readProtectedExecutionContext({
          projectRoot: this.projectRoot, taskMetadata: task.metadata, lookup: request.lookup,
        }),
        inspectSource: async () => {
          const inventory = await this.inventoryTaskspace(task);
          return { head: inventory.head, fingerprint: inventory.workspaceFingerprint };
        },
      });
    }
    if (request.action === 'prepare-task') {
      return prepareConversationTaskExecution({
        projectRoot: this.projectRoot, taskMetadata: task.metadata, workspace: task.workspace, request,
        inspectSource: async () => {
          const inventory = await this.inventoryTaskspace(task);
          return { head: inventory.head, fingerprint: inventory.workspaceFingerprint };
        },
        authorizeProposal: this.conversationTaskClient,
      });
    }
    if (request.action === 'protected-completion') {
      return this.protectedCompletionClient({ taskId: task.metadata.taskId });
    }
    if (request.action === 'verify-review') {
      // Identity comes from the authenticated task; the Host resolves current
      // protected prerequisites, source binding and reviewer identity itself.
      return this.callVerification({ action: 'semantic-review', taskId: task.metadata.taskId,
        acceptanceContractId: request.acceptanceContractId });
    }
    if (request.action.startsWith('verify-')) {
      const candidateValidationBinding = request.action === 'verify-run'
        ? await readCandidateValidationBindingForTask({
          projectRoot: this.projectRoot,
          taskMetadata: task.metadata,
        })
        : null;
      if (candidateValidationBinding !== null
        && !(this.developmentMode === 'direct' && candidateValidationBinding.directDevelopment)
        && request.profile !== 'governance' && request.profile !== SOURCE_QUALITY_PROFILE
        && !candidateValidationBinding.requiredProfiles.includes(request.profile)
        && !(['backend-module-compile', 'backend-test-class'].includes(request.profile)
          && candidateValidationBinding.requiredProfiles.includes('backend-module-test'))) {
        throw taskspaceError(
          'CANDIDATE_VALIDATION_PROFILE_DENIED',
          'Candidate validation profile is outside the protected execution contract.',
        );
      }
      return this.callVerification({
        taskId: task.metadata.taskId,
        ...(candidateValidationBinding === null ? {} : {
          acceptanceContractId: candidateValidationBinding.contractId,
          ...(candidateValidationBinding.candidateBinding === undefined ? {} : {
            candidateBinding: candidateValidationBinding.candidateBinding,
          }),
        }),
        action: request.action.slice('verify-'.length),
        ...(request.profiles === undefined ? {} : { profiles: request.profiles }),
        ...(request.profile === undefined ? {} : { profile: request.profile }),
        ...(request.selectors === undefined ? {} : { selectors: request.selectors }),
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
        ...(request.admissionId === undefined ? {} : { admissionId: request.admissionId }),
        ...(request.executionMode === undefined || (this.developmentMode === 'direct'
          && candidateValidationBinding?.directDevelopment && this.verificationMode === 'container-toolchain')
          ? {} : { executionMode: request.executionMode }),
        ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
        ...(request.waitSeconds === undefined ? {} : { waitSeconds: request.waitSeconds }),
        ...(request.receiptId === undefined ? {} : { receiptId: request.receiptId }),
        ...(request.includeDiagnostics === true ? { includeDiagnostics: true } : {}),
      });
    }
    if (request.action === 'preflight' || request.action === 'status' || request.action === 'submit') {
      let candidate = await this.inspectCandidate(task);
      const integrationState = await this.integrationProjection(task);
      if (request.action === 'preflight' || request.action === 'status') {
        candidate = { ...candidate, ...await this.inspectCandidateSourceProjection(task, integrationState.integration) };
      }
      const runner = request.action === 'submit'
        ? undefined
        : await this.releaseClient({ action: request.action === 'status' ? 'status' : 'preflight' });
      if (request.action === 'submit' && candidate.workspaceClean) {
        await this.writeTask(task.metadataPath, {
          ...task.metadata,
          lastCandidate: { commit: candidate.head, submittedAt: new Date().toISOString() },
        });
      }
      return { taskspace: candidate, ...integrationState, ...(runner === undefined ? {} : { runner }),
        ...(request.action === 'status' ? { release: await this.releaseObservation(task) } : {}) };
    }
    if (request.action === 'prepare') return this.prepareCrossLayer(task, request);
    if (request.action === 'checkpoint') return this.checkpoint(task, request);
    if (request.action === 'integrate') return this.integrate(task, request);
    return request.executionMode === 'background' ? this.startRelease(task, request) : this.release(task, request);
  }

  async executeAuthenticated(token, rawRequest) {
    return this.executeForTask(await this.taskForToken(token), rawRequest);
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  // Retain the response socket on a bounded read rejection so callers receive 413.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_PREPARE_TASK_BODY_BYTES) {
      request.resume();
      throw taskspaceError('REQUEST_TOO_LARGE', 'TaskSpace request is too large.');
    }
    chunks.push(chunk);
  }
  if (bytes === 0) throw taskspaceError('REQUEST_REQUIRED', 'TaskSpace request body is required.');
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (bytes > MAX_BODY_BYTES && !['prepare-task', 'managed-files'].includes(value?.action)) {
    throw taskspaceError('REQUEST_TOO_LARGE', 'TaskSpace request is too large.');
  }
  return value;
}

function send(response, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

export function createTaskspaceBrokerServer(options) {
  const broker = options.broker;
  return http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        const [integration, maintenance] = await Promise.all([
          broker.integrationReadiness(),
          broker.maintenanceState(),
        ]);
        send(response, integration.ok ? 200 : 503, {
          ok: integration.ok,
          active: broker.activeRelease !== null,
          maintenance,
          integration,
          capabilities: { releaseOperationTracking: 1 },
        });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/actions') {
        send(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
        return;
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        send(response, 415, { ok: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'JSON is required.' } });
        return;
      }
      const token = request.headers['x-forge-taskspace-token'];
      if (typeof token !== 'string') {
        throw taskspaceError('TASKSPACE_AUTHENTICATION_FAILED', 'TaskSpace token is required.');
      }
      const result = await broker.executeAuthenticated(token, await readJsonBody(request));
      send(response, 200, { ok: true, result });
    } catch (error) {
      const exposed = publicError(error);
      const status = exposed.code === 'TASKSPACE_AUTHENTICATION_FAILED' ? 403
        : exposed.code === 'REQUEST_TOO_LARGE' ? 413
          : 422;
      send(response, status, { ok: false, error: exposed });
    }
  });
}

export function installTaskspaceBrokerShutdown(server, signalSource = process) {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    // Node's default signal handling does not terminate this container's PID 1.
    // Stop accepting work and let existing HTTP actions finish before exit.
    server.close();
  };
  signalSource.on('SIGTERM', shutdown);
  signalSource.on('SIGINT', shutdown);
  server.once('close', () => {
    signalSource.off('SIGTERM', shutdown);
    signalSource.off('SIGINT', shutdown);
  });
}

async function main() {
  const projectRoot = process.env.TASKSPACE_PROJECT_ROOT;
  const projectSlug = process.env.TASKSPACE_PROJECT_SLUG;
  const listenHost = process.env.TASKSPACE_BROKER_ADDRESS ?? '0.0.0.0';
  const listenPort = Number.parseInt(process.env.TASKSPACE_BROKER_PORT ?? '3100', 10);
  if (!projectRoot || !path.isAbsolute(projectRoot)) throw new Error('TASKSPACE_PROJECT_ROOT is required.');
  if (!projectSlug) throw new Error('TASKSPACE_PROJECT_SLUG is required.');
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error('TASKSPACE_BROKER_PORT is invalid.');
  }
  const broker = new TaskspaceBroker({ projectRoot, projectSlug });
  await mkdir(broker.taskspacesRoot, { recursive: true, mode: 0o700 });
  await stat(broker.workspaceRoot);
  const server = createTaskspaceBrokerServer({ broker });
  installTaskspaceBrokerShutdown(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, resolve);
  });
  try {
    const statusPath = broker.statusSocket;
    await mkdir(broker.stateRoot, { recursive: true, mode: 0o700 });
    const previous = await lstat(statusPath).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (previous && !previous.isSocket()) throw new Error('Project status path is not a socket.');
    if (previous) await unlink(statusPath);
    const statusServer = createProjectReleaseStatusServer(() => broker.projectReleaseStatus(),
      request => broker.readCrossLayerMigrationFailure(request));
    // Keep the existing status listener (and process) alive until the same
    // admitted release finishes after the command's HTTP response has ended.
    server.once('close', () => { void broker.waitForReleases().finally(() => statusServer.close()); });
    await new Promise((resolve, reject) => {
      statusServer.once('error', reject);
      statusServer.listen(statusPath, resolve);
    });
    await chmod(statusPath, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  process.stdout.write(`taskspace-broker listening on ${listenHost}:${listenPort} for ${projectSlug}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
