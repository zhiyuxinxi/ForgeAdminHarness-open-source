import { createHash, randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import { prepareReadableMaterial } from './material-readable.mjs';

const MAX_AUDIT_BYTES = 16 * 1024 * 1024;
const MAX_LISTED_FILES = 2_000;
const MAX_MATERIAL_BYTES = 250 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const ACTOR_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export const MATERIAL_CATEGORIES = Object.freeze({
  business: '业务资料',
  'standards/ui': 'UI 规范',
  reference: '参考资料',
});

export class ProjectMaterialError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeRelativePath(value, code = 'INVALID_MATERIAL_PATH') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024
    || value.includes('\\') || value.startsWith('/') || value.includes('\u0000')) {
    throw new ProjectMaterialError(code, '资料路径不合法。');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new ProjectMaterialError(code, '资料路径不合法。');
  }
  return segments.join('/');
}

function resolveBelow(root, relative, code) {
  const normalized = normalizeRelativePath(relative, code);
  const candidate = path.resolve(root, ...normalized.split('/'));
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    throw new ProjectMaterialError(code, '资料路径越界。');
  }
  return { candidate, relative: normalized };
}

function auditRelativePath(value) {
  if (typeof value !== 'string') return undefined;
  const prefix = ['/project-inputs/', '/project-intake/'].find((candidate) => value.startsWith(candidate));
  const relative = prefix === undefined ? value : value.slice(prefix.length);
  try { return normalizeRelativePath(relative); } catch { return undefined; }
}

async function readJsonLines(filePath, { missing = [] } = {}) {
  let fileStat;
  try { fileStat = await lstat(filePath); } catch (error) {
    if (error.code === 'ENOENT') return missing;
    throw error;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new ProjectMaterialError('MATERIAL_AUDIT_INVALID', '资料审计文件类型不安全。', 503);
  }
  if (fileStat.size > MAX_AUDIT_BYTES) {
    throw new ProjectMaterialError('MATERIAL_AUDIT_TOO_LARGE', '资料审计文件超过安全读取限制。', 503);
  }
  const raw = await readFile(filePath, 'utf8');
  return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function listFiles(root) {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new ProjectMaterialError('MATERIAL_ROOT_INVALID', '资料目录类型不安全。', 503);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  const visit = async (directory, prefix = '') => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) {
        throw new ProjectMaterialError('MATERIAL_LIST_TOO_LARGE', '项目资料数量超过安全展示上限。', 503);
      }
      if (entry.name === '.forge-derived' || entry.name === '.forge-upload-staging' || entry.name === '.upload-audit.jsonl') continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(absolute, relative);
      else if (entry.isFile()) files.push({ absolute, relative });
    }
  };
  await visit(root);
  return files;
}

async function hashFile(filePath) {
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new ProjectMaterialError('MATERIAL_SOURCE_INVALID', '资料来源不是普通文件。', 409);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { bytes: fileStat.size, sha256: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function copyVerified(sourcePath, stagingPath, expectedSha256) {
  const source = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const destination = await open(stagingPath, 'wx', 0o640);
  try {
    const sourceStat = await source.stat();
    if (!sourceStat.isFile() || sourceStat.size < 1 || sourceStat.size > MAX_MATERIAL_BYTES) {
      throw new ProjectMaterialError('MATERIAL_SOURCE_INVALID', '资料来源不是允许大小的普通文件。', 409);
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      await destination.write(chunk);
      position += bytesRead;
    }
    await destination.sync();
    const sha256 = digest.digest('hex');
    if (sha256 !== expectedSha256) {
      throw new ProjectMaterialError('MATERIAL_SOURCE_CHANGED', '原始资料已发生变化，请刷新后重新审核。', 409);
    }
    return { bytes: sourceStat.size, sha256 };
  } finally {
    await Promise.allSettled([source.close(), destination.close()]);
  }
}

function publicAttribution(record) {
  if (record === undefined) return { status: 'untracked' };
  if (record.schemaVersion === 2 && record.scope?.projectSlug) {
    return {
      status: 'attributed',
      projectSlug: record.scope.projectSlug,
      scopeType: record.scope.scopeType,
      taskspaceId: record.scope.taskspaceId ?? null,
      actorId: record.scope.actorId ?? null,
      conversationId: record.scope.conversationId ?? null,
    };
  }
  return { status: 'legacy-unattributed' };
}

function publicReadable(value) {
  if (value === undefined || value === null) return { format: '未知', status: 'unsupported' };
  const { derivedRoot: _derivedRoot, idempotent: _idempotent, ...result } = value;
  return result;
}

export function createProjectMaterialStore({
  projectRoot,
  projectSlug,
  intakeRoot,
  materialPreprocessor = prepareReadableMaterial,
  documentLimits,
  prototypeLimits,
}) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new Error('projectRoot must be absolute');
  if (typeof intakeRoot !== 'string' || !path.isAbsolute(intakeRoot)) throw new Error('intakeRoot must be absolute');
  if (typeof projectSlug !== 'string' || !/^[a-z][a-z0-9-]{2,31}$/.test(projectSlug)) throw new Error('projectSlug is invalid');

  const acceptedRoot = path.resolve(projectRoot, 'shared-inputs', 'accepted');
  const governanceRoot = path.resolve(projectRoot, 'shared-inputs', 'governance');
  const materialAuditPath = path.join(governanceRoot, 'material-events.jsonl');
  let queue = Promise.resolve();

  const initialize = async () => {
    await mkdir(acceptedRoot, { recursive: true, mode: 0o750 });
    await mkdir(governanceRoot, { recursive: true, mode: 0o700 });
    const [acceptedResolved, governanceResolved] = await Promise.all([realpath(acceptedRoot), realpath(governanceRoot)]);
    if (acceptedResolved !== acceptedRoot || governanceResolved !== governanceRoot) {
      throw new ProjectMaterialError('MATERIAL_ROOT_INVALID', '项目资料目录不能使用符号链接。', 503);
    }
  };

  const auditRecords = async () => {
    const uploads = await readJsonLines(path.join(intakeRoot, '.upload-audit.jsonl'));
    const byPath = new Map();
    for (const record of uploads) {
      const relative = auditRelativePath(record.path);
      if (relative !== undefined) byPath.set(relative, record);
    }
    return byPath;
  };

  const materialEvents = async () => readJsonLines(materialAuditPath);

  const appendMaterialEvent = async (entry) => {
    await initialize();
    await appendFile(materialAuditPath, `${JSON.stringify({
      schemaVersion: 1,
      at: new Date().toISOString(),
      projectSlug,
      ...entry,
    })}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(materialAuditPath, 0o600).catch(() => {});
  };

  const list = async ({ includeIntake = false, offset = 0, limit = 200 } = {}) => {
    await initialize();
    const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 200;
    const [acceptedFiles, events] = await Promise.all([listFiles(acceptedRoot), materialEvents()]);
    const promotedByDestination = new Map();
    const promotedSources = new Set();
    for (const event of events) {
      if (event.action !== 'material.promote' || event.result !== 'success') continue;
      if (typeof event.destination?.path === 'string') promotedByDestination.set(event.destination.path, event);
      if (typeof event.source?.path === 'string' && SHA256_PATTERN.test(event.source?.sha256 ?? '')) {
        promotedSources.add(`${event.source.path}\u0000${event.source.sha256}`);
      }
    }
    const accepted = [];
    for (const file of acceptedFiles) {
      const fingerprint = await hashFile(file.absolute);
      const event = promotedByDestination.get(file.relative);
      accepted.push({
        scope: 'project-shared',
        path: file.relative,
        filename: path.posix.basename(file.relative),
        category: file.relative.includes('/') ? file.relative.slice(0, file.relative.lastIndexOf('/')) : 'reference',
        bytes: fingerprint.bytes,
        sha256: fingerprint.sha256,
        approvedAt: event?.at ?? null,
        approvedBy: event?.actorUsername ?? null,
        governanceStatus: event === undefined ? 'untracked' : 'approved',
        readable: event?.destination?.readable ?? null,
        sourcePath: event?.source?.path ?? null,
      });
    }
    accepted.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN'));

    let intake = [];
    if (includeIntake) {
      const [intakeFiles, records] = await Promise.all([listFiles(intakeRoot), auditRecords()]);
      const readableCompanions = new Set([...records.values()].flatMap((record) => {
        const source = auditRelativePath(record.path);
        const readable = auditRelativePath(record.readable?.path);
        // Text/Markdown uploads are natively readable, so the readable path is
        // deliberately identical to the uploaded source. Only generated sidecars
        // (for example *.pdf.extracted.md) must be hidden from the review queue.
        return readable === undefined || readable === source ? [] : [readable];
      }));
      for (const file of intakeFiles) {
        if (readableCompanions.has(file.relative)) continue;
        const fingerprint = await hashFile(file.absolute);
        if (promotedSources.has(`${file.relative}\u0000${fingerprint.sha256}`)) continue;
        const record = records.get(file.relative);
        intake.push({
          scope: 'project-intake',
          path: file.relative,
          filename: path.posix.basename(file.relative),
          bytes: fingerprint.bytes,
          sha256: fingerprint.sha256,
          uploadedAt: record?.at ?? null,
          tracked: record !== undefined,
          attribution: publicAttribution(record),
          readableStatus: record?.readable?.status ?? null,
        });
      }
      intake.sort((left, right) => (right.uploadedAt ?? '').localeCompare(left.uploadedAt ?? '')
        || left.path.localeCompare(right.path, 'zh-CN'));
    }

    return {
      accepted: { items: accepted.slice(safeOffset, safeOffset + safeLimit), total: accepted.length },
      intake: { items: intake.slice(safeOffset, safeOffset + safeLimit), total: intake.length },
      categories: Object.entries(MATERIAL_CATEGORIES).map(([value, label]) => ({ value, label })),
    };
  };

  const promote = async (value) => {
    const operation = async () => {
      await initialize();
      const source = resolveBelow(intakeRoot, value.sourcePath, 'INVALID_MATERIAL_PATH');
      const category = typeof value.category === 'string' && MATERIAL_CATEGORIES[value.category]
        ? value.category
        : undefined;
      if (category === undefined) throw new ProjectMaterialError('INVALID_MATERIAL_CATEGORY', '请选择有效的资料分类。');
      if (typeof value.expectedSha256 !== 'string' || !SHA256_PATTERN.test(value.expectedSha256)) {
        throw new ProjectMaterialError('INVALID_MATERIAL_HASH', '资料校验值不合法。');
      }
      if (typeof value.actorId !== 'string' || !ACTOR_PATTERN.test(value.actorId)
        || typeof value.actorUsername !== 'string' || !ACTOR_PATTERN.test(value.actorUsername)) {
        throw new ProjectMaterialError('INVALID_MATERIAL_ACTOR', '审核人员身份不合法。');
      }
      if (typeof value.requestId !== 'string' || !REQUEST_ID_PATTERN.test(value.requestId)) {
        throw new ProjectMaterialError('INVALID_REQUEST_ID', '请求标识不合法。');
      }
      const sourceStat = await lstat(source.candidate).catch((error) => {
        if (error.code === 'ENOENT') throw new ProjectMaterialError('MATERIAL_NOT_FOUND', '原始资料不存在。', 404);
        throw error;
      });
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new ProjectMaterialError('MATERIAL_SOURCE_INVALID', '原始资料不是安全的普通文件。', 409);
      }
      const reviewedSource = await hashFile(source.candidate);
      if (reviewedSource.sha256 !== value.expectedSha256) {
        throw new ProjectMaterialError('MATERIAL_SOURCE_CHANGED', '原始资料已发生变化，请刷新后重新审核。', 409);
      }

      const destinationDirectory = path.resolve(acceptedRoot, ...category.split('/'));
      if (!destinationDirectory.startsWith(`${acceptedRoot}${path.sep}`)) {
        throw new ProjectMaterialError('INVALID_MATERIAL_CATEGORY', '资料分类越界。');
      }
      await mkdir(destinationDirectory, { recursive: true, mode: 0o750 });
      const resolvedDestinationDirectory = await realpath(destinationDirectory);
      if (resolvedDestinationDirectory !== destinationDirectory) {
        throw new ProjectMaterialError('MATERIAL_ROOT_INVALID', '共享资料分类目录不能使用符号链接。', 503);
      }
      const filename = path.posix.basename(source.relative);
      const destinationPath = path.join(destinationDirectory, filename);
      const destinationRelative = `${category}/${filename}`;
      const sourceLabel = `/project-shared-inputs/${destinationRelative}`;
      const publicDirectory = `/project-shared-inputs/${category}`;
      const prepareReadable = async (fingerprint) => {
        try {
          return await materialPreprocessor({
            destinationDirectory,
            documentLimits,
            filename,
            prototypeLimits,
            publicDirectory,
            sourceLabel,
            sourcePath: destinationPath,
            sourceSha256: fingerprint.sha256,
          });
        } catch (error) {
          return {
            code: error.code ?? 'MATERIAL_PREPROCESS_FAILED',
            format: path.extname(filename).toLowerCase() === '.zip' ? '前端 HTML ZIP' : '未知',
            status: 'failed',
          };
        }
      };
      try {
        const existing = await lstat(destinationPath);
        if (!existing.isFile() || existing.isSymbolicLink()) {
          throw new ProjectMaterialError('MATERIAL_DESTINATION_INVALID', '共享资料目标不是安全的普通文件。', 409);
        }
        const fingerprint = await hashFile(destinationPath);
        if (fingerprint.sha256 !== value.expectedSha256) {
          throw new ProjectMaterialError('MATERIAL_NAME_CONFLICT', '共享区已有同名但内容不同的资料，请先人工处理命名冲突。', 409);
        }
        const readable = await prepareReadable(fingerprint);
        if (readable.idempotent === false) {
          await appendMaterialEvent({
            action: 'material.derive',
            actorId: value.actorId,
            actorUsername: value.actorUsername,
            requestId: value.requestId,
            result: 'success',
            source: { scope: 'project-shared', path: destinationRelative, sha256: fingerprint.sha256 },
            destination: { scope: 'project-shared-derived', readable: publicReadable(readable) },
          });
        }
        return {
          idempotent: true,
          material: {
            scope: 'project-shared', path: destinationRelative, filename, category, ...fingerprint,
            readable: publicReadable(readable),
          },
        };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      const stagingPath = path.join(destinationDirectory, `.${filename}.${randomUUID()}.part`);
      let destinationCreated = false;
      let readable;
      try {
        const fingerprint = await copyVerified(source.candidate, stagingPath, value.expectedSha256);
        try {
          await link(stagingPath, destinationPath);
          destinationCreated = true;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existing = await hashFile(destinationPath);
          if (existing.sha256 !== value.expectedSha256) {
            throw new ProjectMaterialError('MATERIAL_NAME_CONFLICT', '共享区已有同名但内容不同的资料，请先人工处理命名冲突。', 409);
          }
        }
        await rm(stagingPath, { force: true });
        readable = await prepareReadable(fingerprint);
        const records = await auditRecords();
        const record = records.get(source.relative);
        await appendMaterialEvent({
          action: 'material.promote',
          actorId: value.actorId,
          actorUsername: value.actorUsername,
          requestId: value.requestId,
          result: 'success',
          source: {
            scope: 'project-intake',
            path: source.relative,
            sha256: fingerprint.sha256,
            attribution: publicAttribution(record),
          },
          destination: {
            scope: 'project-shared',
            path: destinationRelative,
            sha256: fingerprint.sha256,
            readable: publicReadable(readable),
          },
        });
        return {
          idempotent: false,
          material: {
            scope: 'project-shared', path: destinationRelative, filename, category, ...fingerprint,
            readable: publicReadable(readable),
          },
        };
      } catch (error) {
        if (destinationCreated) {
          await rm(destinationPath, { force: true }).catch(() => {});
          if (readable?.idempotent === false && readable.derivedRoot !== undefined) {
            await rm(readable.derivedRoot, { force: true, recursive: true }).catch(() => {});
          }
        }
        throw error;
      } finally {
        await rm(stagingPath, { force: true }).catch(() => {});
      }
    };
    const run = queue.then(operation, operation);
    queue = run.catch(() => {});
    return run;
  };

  return { acceptedRoot, governanceRoot, initialize, list, promote };
}
