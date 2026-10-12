import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import { validateTaskId } from './conversation-policy.mjs';
import { validateTaskspaceMetadata } from './taskspace-policy.mjs';
import { validateForgePhaseWorkPackageDirectory } from './forge-phase-work-package.mjs';
import { phaseWorkPackagePresentation } from './output-file-presentation.mjs';
import { canonicalStringify } from './forge-task-execution-contract.mjs';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_ATTEMPTS = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DOCUMENTS = ['00-input.md', '01-result.md', '02-process.md', '03-verification.md', '04-handoff.md', '05-memory-candidate.md'];

export class PhaseWorkPackageFilesError extends Error {
  constructor(code, message, status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function requireSource(condition) {
  if (!condition) throw new PhaseWorkPackageFilesError('PHASE_OUTPUT_SOURCE_INVALID', '阶段文件的来源绑定不完整或不一致。');
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = (info) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map((key) => info[key]).join(':');

async function ordinaryDirectory(directory) {
  // Check each ancestor: a safe leaf must not hide a redirected TaskSpace or broker root.
  const parent = path.dirname(directory);
  if (parent !== directory) await ordinaryDirectory(parent);
  const info = await lstat(directory);
  requireSource(info.isDirectory() && !info.isSymbolicLink());
}

async function readBoundFile(file, maxBytes = MAX_FILE_BYTES) {
  await ordinaryDirectory(path.dirname(file));
  const before = await lstat(file);
  requireSource(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
    && before.size > 0 && before.size <= maxBytes);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    requireSource(identity(before) === identity(opened));
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    requireSource(length === opened.size && identity(opened) === identity(await handle.stat())
      && identity(opened) === identity(await lstat(file)));
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

async function readJson(file) {
  try { return JSON.parse((await readBoundFile(file, 2 * 1024 * 1024)).toString('utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof PhaseWorkPackageFilesError) throw error;
    throw new PhaseWorkPackageFilesError('PHASE_OUTPUT_SOURCE_INVALID', '阶段文件的来源记录不可读取。');
  }
}

function pagination(offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new PhaseWorkPackageFilesError('INVALID_PHASE_OUTPUT_PAGE', '阶段文件分页参数不合法。', 400);
  }
}

function unavailable(code, message, offset, limit) {
  return { items: [], offset, limit, hasMore: false, unavailable: { code, message } };
}

export function createPhaseWorkPackageFiles({ taskspacesRoot, projectSlug, taskMetadata }) {
  const taskId = validateTaskId(taskMetadata?.taskId);
  validateTaskspaceMetadata(taskMetadata, projectSlug);
  const root = path.resolve(taskspacesRoot);
  const control = path.join(root, '.broker', 'delivery-phases', taskId, 'phase-control');
  const attemptsRoot = path.join(control, 'browser-attempts');

  const readAttempt = async (executionId, attemptsDirectory, continuation) => {
    const directory = path.join(attemptsDirectory, executionId);
    const output = path.join(directory, 'controller');
    const packageDirectory = path.join(output, 'work-package');
    // This is the existing browser Controller output path, never a caller-supplied directory.
    if (await lstat(packageDirectory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)) === null) return null;
    const execution = await readJson(path.join(directory, 'execution.json'));
    const begun = await readJson(path.join(directory, 'begin.json'));
    const receipt = await readJson(path.join(output, 'phase-receipt.json'))
      .catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (receipt === null) return null; // Finalize writes the sealed package before its receipt.
    requireSource(execution.executionId === executionId && execution.projectSlug === projectSlug
      && execution.taskId === taskId && execution.conversationId === taskMetadata.conversationId
      && execution.actorUserId === taskMetadata.actorUserId && execution.actorUsername === taskMetadata.actorId
      && execution.testOnly === false && execution.route === 'session.prompt'
      && ['production-read-only', 'production-task-writer'].includes(execution.authorityClass)
      && Number.isSafeInteger(execution.generation) && execution.generation > 0);
    if (continuation !== null) {
      requireSource(execution.dshSessionId === continuation.sessionId
        && execution.generation >= continuation.nextExecutionGenerationMinimum
        && execution.phaseIndex >= continuation.phaseIndex);
    }
    const attempt = begun.attempt;
    requireSource(begun.schemaVersion === 'forge-delivery-browser-phase-begin/v1'
      && begun.workflowId === execution.workflowId && begun.phaseId === execution.phaseId
      && begun.phaseIndex === execution.phaseIndex && attempt?.phaseId === begun.phaseId
      && attempt.phaseIndex === begun.phaseIndex && attempt.executionGeneration === execution.generation
      && attempt.rpcId === execution.rpcId && attempt.promptDigest === execution.promptDigest
      && UUID.test(attempt.attemptId ?? ''));
    requireSource(receipt.schemaVersion === 'forge-delivery-phase-receipt/v1'
      && receipt.issuer === 'forge-phase-controller' && receipt.workflowId === begun.workflowId
      && receipt.phaseId === begun.phaseId && receipt.phaseIndex === begun.phaseIndex
      && receipt.attemptId === attempt.attemptId && receipt.executionGeneration === execution.generation
      && ['accepted', 'blocked'].includes(receipt.decision));
    const { receiptDigest, ...receiptPayload } = receipt;
    requireSource(sha256(Buffer.from(canonicalStringify(receiptPayload), 'utf8')) === receiptDigest);
    // Bound every read before invoking the existing sealed package consumer.
    const originals = new Map();
    for (const name of ['manifest.json', ...DOCUMENTS]) {
      originals.set(name, await readBoundFile(path.join(packageDirectory, name)));
    }
    let manifest;
    try {
      manifest = await validateForgePhaseWorkPackageDirectory(packageDirectory, {
        taskId, workflowId: begun.workflowId, phaseId: begun.phaseId, phaseIndex: begun.phaseIndex,
        attemptId: attempt.attemptId, controllerReceiptDigest: receipt.receiptDigest,
        decision: receipt.decision, createdAt: receipt.completedAt,
      });
    } catch {
      throw new PhaseWorkPackageFilesError('PHASE_OUTPUT_PACKAGE_INVALID', '阶段文件封存校验失败。');
    }
    requireSource(manifest.canonicalArtifactDigest === receipt.artifactDigest
      && manifest.patchDigest === receipt.patchDigest
      && JSON.stringify(manifest.hostReceiptDigests) === JSON.stringify(receipt.hostReceiptDigests));
    if (continuation !== null) {
      requireSource(manifest.sourceCommit === continuation.sourceCommit
        && manifest.catalogVersion === continuation.catalogVersion);
    }
    if (receipt.decision === 'accepted') {
      const result = await readJson(path.join(output, 'controller-result.json'))
        .catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (result === null) return null;
      requireSource(result.schemaVersion === 'forge-delivery-phase-controller-finalize/v1'
        && result.workflowId === manifest.workflowId && result.acceptedPhaseId === manifest.phaseId
        && result.acceptedPhaseIndex === manifest.phaseIndex
        && result.workPackageDigest === manifest.packageDigest && result.workPackageManifest === 'work-package/manifest.json'
        && result.phaseArtifactDigest === manifest.canonicalArtifactDigest);
    }
    for (const document of manifest.documents) {
      const bytes = originals.get(document.path);
      requireSource(bytes.length === document.bytes && sha256(bytes) === document.sha256);
    }
    requireSource(originals.get('manifest.json').equals(await readBoundFile(path.join(packageDirectory, 'manifest.json'))));
    return { manifest, documents: originals };
  };

  const load = async (requestedPackage, requestedName) => {
    if (taskMetadata.schemaVersion !== 2 || taskMetadata.accessMode !== 'conversation') return null;
    requireSource(taskMetadata.projectSlug === projectSlug && ['active', 'stopped', 'closed'].includes(taskMetadata.status));
    const current = await readJson(path.join(root, taskId, 'metadata.json'));
    requireSource(['schemaVersion', 'projectSlug', 'taskId', 'conversationId', 'actorId', 'actorUserId', 'accessMode']
      .every((key) => current[key] === taskMetadata[key]));
    const roots = [{ directory: attemptsRoot, continuation: null }];
    const repairDirectory = path.join(control, 'frontend-repair');
    const continuation = await readJson(path.join(repairDirectory, '前端阶段-关联修复凭据.json'))
      .catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (continuation !== null) {
      const parentBytes = await readBoundFile(path.join(control, 'state.json'), 2 * 1024 * 1024);
      const parent = JSON.parse(parentBytes.toString('utf8'));
      requireSource(continuation.schemaVersion === 'forge-delivery-frontend-repair-continuation/v1'
        && continuation.phaseId === 'frontend' && continuation.phaseIndex === 5
        && continuation.taskId === taskId && parent.taskId === taskId
        && typeof continuation.sessionId === 'string' && continuation.sessionId.length > 0
        && continuation.sessionId === parent.sessionId
        && continuation.sourceStateSha256 === sha256(parentBytes)
        && continuation.sourceStateDigest === parent.stateDigest
        && continuation.sourceCommit === parent.sourceCommit
        && continuation.catalogDigest === parent.catalogDigest && continuation.catalogVersion === parent.catalogVersion
        && Number.isSafeInteger(continuation.parentLastExecutionGeneration)
        && continuation.parentLastExecutionGeneration === parent.lastExecutionGeneration
        && continuation.nextExecutionGenerationMinimum === parent.lastExecutionGeneration + 1);
      roots.push({ directory: path.join(repairDirectory, 'browser-attempts'), continuation });
    }
    const results = [];
    let count = 0;
    for (const source of roots) {
      try { await ordinaryDirectory(source.directory); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for await (const entry of await opendir(source.directory)) {
        count += 1;
        if (count > MAX_ATTEMPTS) {
          throw new PhaseWorkPackageFilesError('PHASE_OUTPUT_INDEX_TOO_LARGE', '阶段执行记录超过单次读取上限，未截断历史记录。', 413);
        }
        if (!UUID.test(entry.name)) continue;
        requireSource(entry.isDirectory() && !entry.isSymbolicLink());
        const item = await readAttempt(entry.name, source.directory, source.continuation);
        if (item !== null) results.push({ manifest: item.manifest,
          ...(item.manifest.packageDigest === requestedPackage ? { buffer: item.documents.get(requestedName) } : {}) });
      }
    }
    return results.sort((left, right) => right.manifest.createdAt.localeCompare(left.manifest.createdAt)
      || left.manifest.packageDigest.localeCompare(right.manifest.packageDigest));
  };

  return {
    async list({ offset = 0, limit = 20 } = {}) {
      pagination(offset, limit);
      const packages = await load();
      if (packages === null) return unavailable('PHASE_OUTPUTS_UNBOUND', '此工作舱没有可核对的独立对话阶段来源。', offset, limit);
      if (packages.length === 0) return unavailable('PHASE_OUTPUTS_NOT_YET_AVAILABLE', '当前对话还没有已封存的阶段文件。', offset, limit);
      return {
        items: packages.slice(offset, offset + limit).map(({ manifest }) => ({
          packageId: manifest.packageDigest, phaseId: manifest.phaseId, phaseIndex: manifest.phaseIndex,
          decision: manifest.decision, createdAt: manifest.createdAt, ...phaseWorkPackagePresentation(manifest),
        })),
        offset, limit, hasMore: offset + limit < packages.length,
      };
    },
    async read({ packageId, name }) {
      if (!SHA256.test(packageId ?? '') || !DOCUMENTS.includes(name)) {
        throw new PhaseWorkPackageFilesError('INVALID_PHASE_OUTPUT_PATH', '阶段文件路径不合法。', 400);
      }
      const packages = await load(packageId, name);
      const item = packages?.find(({ manifest }) => manifest.packageDigest === packageId);
      if (item === undefined) throw new PhaseWorkPackageFilesError('PHASE_OUTPUT_NOT_FOUND', '阶段文件不存在或不属于当前对话。', 404);
      const file = phaseWorkPackagePresentation(item.manifest).files.find((entry) => entry.name === name);
      return { ...file, buffer: item.buffer };
    },
  };
}
