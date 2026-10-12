import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  appendFile,
  link,
  mkdir,
  open,
  readdir,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { documentLimits, extractProjectDocument } from './document-extractor.mjs';
import { createConversationOutputStore, ConversationOutputStoreError } from './conversation-output-store.mjs';
import {
  isPrototypeArchive,
  preparePrototypeArchive,
  prototypeLimits,
} from './prototype-archive.mjs';

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_BATCH_FILES = 20;
const DEFAULT_MAX_BATCH_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_PROJECT_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_FILENAME_BYTES = 200;
const BATCH_PATTERN = /^[0-9a-z][0-9a-z-]{7,63}$/i;
const PROJECT_SLUG_PATTERN = /^[a-z][a-z0-9-]{2,31}$/;
const TASKSPACE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
const ACTOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;
const UPLOAD_SCOPE_TYPES = new Set(['project-intake', 'taskspace-private']);

class UploadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function validateAuditScope(value) {
  if (value === null || typeof value !== 'object'
    || !UPLOAD_SCOPE_TYPES.has(value.scopeType)
    || typeof value.projectSlug !== 'string'
    || !PROJECT_SLUG_PATTERN.test(value.projectSlug)) {
    throw new Error('upload audit scope is invalid');
  }
  const optional = (field, pattern) => value[field] === undefined || value[field] === null
    || (typeof value[field] === 'string' && pattern.test(value[field]));
  if (!optional('taskspaceId', TASKSPACE_ID_PATTERN)
    || !optional('actorId', ACTOR_ID_PATTERN)
    || !optional('conversationId', CONVERSATION_ID_PATTERN)) {
    throw new Error('upload audit identity is invalid');
  }
  if (value.scopeType === 'taskspace-private'
    && (value.taskspaceId == null || value.actorId == null || value.conversationId == null)) {
    throw new Error('taskspace upload audit identity is incomplete');
  }
  return Object.freeze({
    scopeType: value.scopeType,
    projectSlug: value.projectSlug,
    taskspaceId: value.taskspaceId ?? null,
    actorId: value.actorId ?? null,
    conversationId: value.conversationId ?? null,
  });
}

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': body.length,
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function tokensEqual(received, expected) {
  if (typeof received !== 'string') return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length
    && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export function sanitizeFilename(value) {
  if (typeof value !== 'string') {
    throw new UploadError(400, 'INVALID_FILENAME', '文件名无效。');
  }
  const leaf = value.normalize('NFC').split(/[\\/]/).at(-1) ?? '';
  let safe = leaf
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  if (safe === '' || safe === '.' || safe === '..') {
    throw new UploadError(400, 'INVALID_FILENAME', '文件名无效。');
  }

  while (Buffer.byteLength(safe) > MAX_FILENAME_BYTES) {
    safe = Array.from(safe).slice(0, -1).join('').replace(/[. ]+$/g, '');
  }
  if (safe === '') {
    throw new UploadError(400, 'INVALID_FILENAME', '文件名过长或无效。');
  }
  return safe;
}

async function directoryUsage(root, ignoredName) {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ignoredName) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) total += await directoryUsage(entryPath, ignoredName);
    else if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

async function batchUsage(batchDirectory) {
  try {
    const entries = await readdir(batchDirectory, { withFileTypes: true });
    let bytes = 0;
    let files = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.extracted.md')) continue;
      files += 1;
      bytes += (await stat(path.join(batchDirectory, entry.name))).size;
    }
    return { bytes, files };
  } catch (error) {
    if (error.code === 'ENOENT') return { bytes: 0, files: 0 };
    throw error;
  }
}

async function stageBuffer(stagingRoot, value) {
  const stagingPath = path.join(stagingRoot, `${randomUUID()}.document.part`);
  const output = await open(stagingPath, 'wx', 0o600);
  try {
    await output.writeFile(value);
    await output.sync();
  } finally {
    await output.close();
  }
  return stagingPath;
}

function createSerialGate() {
  let tail = Promise.resolve();
  return async (callback) => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  };
}

function splitFilename(filename) {
  const extension = path.extname(filename);
  const base = filename.slice(0, filename.length - extension.length);
  return { base, extension };
}

async function publishWithoutOverwrite(stagingPath, batchDirectory, filename) {
  const { base, extension } = splitFilename(filename);
  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const candidate = attempt === 1
      ? filename
      : `${base} (${attempt})${extension}`;
    const destination = path.join(batchDirectory, candidate);
    try {
      await link(stagingPath, destination);
      await unlink(stagingPath);
      return { destination, filename: candidate };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new UploadError(409, 'FILENAME_COLLISION', '同一批次中存在过多同名文件。');
}

function createQuotaGate(uploadRoot, stagingName, maxProjectBytes) {
  let reservedBytes = 0;
  let tail = Promise.resolve();

  async function locked(callback) {
    let release;
    const previous = tail;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  return {
    async reserve(bytes) {
      return locked(async () => {
        const usedBytes = await directoryUsage(uploadRoot, stagingName);
        if (usedBytes + reservedBytes + bytes > maxProjectBytes) return false;
        reservedBytes += bytes;
        return true;
      });
    },
    release(bytes) {
      reservedBytes = Math.max(0, reservedBytes - bytes);
    },
  };
}

async function receiveFile(request, stagingPath, maxFileBytes) {
  const digest = createHash('sha256');
  let receivedBytes = 0;
  const output = await open(stagingPath, 'wx', 0o600);
  try {
    for await (const chunk of request) {
      receivedBytes += chunk.length;
      if (receivedBytes > maxFileBytes) {
        request.resume();
        throw new UploadError(413, 'FILE_TOO_LARGE', '文件超过单文件大小限制。');
      }
      digest.update(chunk);
      await output.write(chunk);
    }
    await output.sync();
  } catch (error) {
    throw error;
  } finally {
    await output.close();
  }
  if (receivedBytes === 0) {
    throw new UploadError(400, 'EMPTY_FILE', '不能上传空文件。');
  }
  return { bytes: receivedBytes, sha256: digest.digest('hex') };
}

function safeClientAddress(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length <= 128) return forwarded;
  return request.socket.remoteAddress ?? 'unknown';
}

export async function createUploadServer(options) {
  const uploadRoot = path.resolve(options.uploadRoot);
  const publicPath = options.publicPath ?? '/project-inputs';
  const token = options.token;
  const maxFileBytes = parsePositiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 'maxFileBytes');
  const maxBatchFiles = parsePositiveInteger(options.maxBatchFiles, DEFAULT_MAX_BATCH_FILES, 'maxBatchFiles');
  const maxBatchBytes = parsePositiveInteger(options.maxBatchBytes, DEFAULT_MAX_BATCH_BYTES, 'maxBatchBytes');
  const maxProjectBytes = parsePositiveInteger(options.maxProjectBytes, DEFAULT_MAX_PROJECT_BYTES, 'maxProjectBytes');
  const extractionLimits = documentLimits(options.documentLimits);
  const documentExtractor = options.documentExtractor ?? extractProjectDocument;
  const archiveLimits = prototypeLimits(options.prototypeLimits);
  const prototypeProcessor = options.prototypeProcessor ?? preparePrototypeArchive;
  const auditScope = validateAuditScope(options.auditScope);
  if (!['/project-inputs', '/project-intake'].includes(publicPath)) {
    throw new Error('upload public path is invalid');
  }
  if (typeof token !== 'string' || token.length < 32) {
    throw new Error('upload token must contain at least 32 characters');
  }

  const stagingName = '.forge-upload-staging';
  const stagingRoot = path.join(uploadRoot, stagingName);
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const quotaGate = createQuotaGate(uploadRoot, stagingName, maxProjectBytes);
  const extractSerially = createSerialGate();
  const outputStoreOptions = { root: uploadRoot, publicPath, scope: auditScope };

  async function handleOutputs(request, response, url) {
    if (auditScope.scopeType !== 'taskspace-private') {
      throw new UploadError(403, 'OUTPUT_PRIVATE_SCOPE_REQUIRED', '对话文件只保存在个人工作舱内。');
    }
    let reserved = 0;
    const store = createConversationOutputStore({
      ...outputStoreOptions,
      reserveBytes: async (bytes) => {
        if (!await quotaGate.reserve(bytes)) throw new UploadError(507, 'PROJECT_QUOTA_EXCEEDED', '当前工作舱文件空间已满，请联系管理员。');
        reserved += bytes;
      },
      releaseBytes: async (bytes) => { quotaGate.release(bytes); reserved -= bytes; },
    });
    try {
      if (request.method === 'POST' && url.pathname === '/outputs') {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > DEFAULT_MAX_FILE_BYTES) throw new UploadError(413, 'OUTPUT_TOO_LARGE', '对话记录超过保存上限，原对话仍保留。');
          chunks.push(chunk);
        }
        let snapshot;
        try { snapshot = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new UploadError(400, 'OUTPUT_SNAPSHOT_INVALID', '对话记录格式无效。'); }
        const saved = await store.save(snapshot);
        await appendFile(path.join(uploadRoot, '.upload-audit.jsonl'), `${JSON.stringify({
          schemaVersion: 2, at: new Date().toISOString(), action: 'conversation.output.save',
          scope: auditScope, sessionId: saved.manifest.sessionId, snapshotId: saved.snapshotId,
          status: saved.manifest.status, idempotent: saved.idempotent,
        })}\n`, { encoding: 'utf8', mode: 0o640 });
        json(response, saved.idempotent ? 200 : 201, { ok: true, archive: saved.manifest });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/outputs') {
        const result = await store.list({
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          offset: Number(url.searchParams.get('offset') ?? 0),
          limit: Number(url.searchParams.get('limit') ?? 20),
        });
        json(response, 200, { ok: true, ...result });
        return;
      }
      const match = /^\/outputs\/([^/]+)\/([a-f0-9]{64})\/([^/]+)$/u.exec(url.pathname);
      if (request.method === 'GET' && match !== null) {
        let sessionId, name;
        try { sessionId = decodeURIComponent(match[1]); name = decodeURIComponent(match[3]); }
        catch { throw new UploadError(400, 'OUTPUT_PATH_INVALID', '对话文件地址无效。'); }
        const file = await store.read({ sessionId, snapshotId: match[2], name });
        response.writeHead(200, {
          'cache-control': 'no-store', 'content-length': file.buffer.length,
          'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; sandbox", 'x-content-sha256': file.sha256,
          'content-disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.downloadName ?? file.name)}`,
        });
        response.end(file.buffer);
        return;
      }
      throw new UploadError(404, 'OUTPUT_NOT_FOUND', '对话文件不存在。');
    } finally {
      // Reservations protect concurrent writes only. Published bytes are
      // already included by directoryUsage on the next quota check.
      if (reserved > 0) quotaGate.release(reserved);
    }
  }

  return http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://harness-upload.invalid');
      if (request.method === 'GET' && requestUrl.pathname === '/healthz') {
        json(response, 200, { ok: true });
        return;
      }
      if (!tokensEqual(request.headers['x-forge-upload-token'], token)) {
        json(response, 403, { ok: false, code: 'FORBIDDEN', message: '拒绝访问。' });
        return;
      }
      if (request.method === 'GET' && requestUrl.pathname === '/config') {
        json(response, 200, {
          ok: true,
          maxFileBytes,
          maxBatchFiles,
          maxBatchBytes,
          projectPath: publicPath,
          conversationOutputs: auditScope.scopeType === 'taskspace-private',
          readableFormats: [
            'md', 'txt', 'csv', 'json', 'yaml', 'xml', 'sql', 'log',
            'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'vue', 'svg',
            'pdf', 'docx', 'xlsx', 'zip（Axure/前端 HTML 原型包）', 'zip（MD/TXT 文档包）',
          ],
          documentMaxSourceBytes: extractionLimits.maxSourceBytes,
          prototypeMaxEntries: archiveLimits.maxEntries,
          prototypeMaxUncompressedBytes: archiveLimits.maxUncompressedBytes,
        });
        return;
      }
      if (requestUrl.pathname === '/outputs' || requestUrl.pathname.startsWith('/outputs/')) {
        await handleOutputs(request, response, requestUrl);
        return;
      }
      if (request.method !== 'POST' || requestUrl.pathname !== '/files') {
        json(response, 404, { ok: false, code: 'NOT_FOUND', message: '上传接口不存在。' });
        return;
      }

      const batch = requestUrl.searchParams.get('batch') ?? '';
      if (!BATCH_PATTERN.test(batch)) {
        throw new UploadError(400, 'INVALID_BATCH', '上传批次标识无效。');
      }
      const filename = sanitizeFilename(requestUrl.searchParams.get('name'));
      const contentLengthHeader = request.headers['content-length'];
      const declaredBytes = contentLengthHeader === undefined
        ? maxFileBytes
        : Number.parseInt(String(contentLengthHeader), 10);
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1) {
        throw new UploadError(400, 'INVALID_SIZE', '文件大小无效。');
      }
      if (declaredBytes > maxFileBytes) {
        throw new UploadError(413, 'FILE_TOO_LARGE', '文件超过单文件大小限制。');
      }

      const date = new Date().toISOString().slice(0, 10);
      const batchDirectory = path.join(uploadRoot, 'incoming', date, batch);
      const currentBatch = await batchUsage(batchDirectory);
      if (currentBatch.files >= maxBatchFiles) {
        throw new UploadError(409, 'BATCH_FILE_LIMIT', '本批次文件数量已达到上限。');
      }
      if (currentBatch.bytes + declaredBytes > maxBatchBytes) {
        throw new UploadError(413, 'BATCH_TOO_LARGE', '本批次文件总大小超过限制。');
      }
      if (!await quotaGate.reserve(declaredBytes)) {
        throw new UploadError(507, 'PROJECT_QUOTA_EXCEEDED', '当前项目上传空间已满，请联系管理员清理。');
      }

      const stagingPath = path.join(stagingRoot, `${randomUUID()}.part`);
      try {
        await mkdir(batchDirectory, { recursive: true, mode: 0o750 });
        const received = await receiveFile(request, stagingPath, maxFileBytes);
        if (currentBatch.bytes + received.bytes > maxBatchBytes) {
          await rm(stagingPath, { force: true });
          throw new UploadError(413, 'BATCH_TOO_LARGE', '本批次文件总大小超过限制。');
        }
        const published = await publishWithoutOverwrite(stagingPath, batchDirectory, filename);
        const relativePath = path.relative(uploadRoot, published.destination).split(path.sep).join('/');
        const modelPath = `${publicPath}/${relativePath}`;
        let readable = {
          format: '未知',
          path: modelPath,
          status: 'unsupported',
        };
        let readableDestination;
        try {
          if (isPrototypeArchive(published.filename)) {
            const archive = await extractSerially(() => prototypeProcessor({
              destinationDirectory: batchDirectory,
              limits: archiveLimits,
              publicDirectory: path.posix.dirname(modelPath),
              releaseBytes: quotaGate.release,
              reserveBytes: quotaGate.reserve,
              sourceLabel: modelPath,
              sourcePath: published.destination,
              sourceSha256: received.sha256,
            }));
            if (archive.status === 'ready') {
              readableDestination = archive.derivedRoot;
              readable = {
                archiveType: archive.archiveType,
                contentRoot: archive.contentRoot,
                derivedBytes: archive.derivedBytes,
                extractedFiles: archive.extractedFiles,
                format: archive.format,
                pageCount: archive.pageCount,
                path: archive.path,
                skippedFiles: archive.skippedFiles,
                status: 'ready',
              };
            } else {
              readable = { ...archive };
            }
          } else {
            const extraction = await extractSerially(() => documentExtractor({
              filename: published.filename,
              limits: extractionLimits,
              sourceLabel: modelPath,
              sourcePath: published.destination,
            }));
            if (extraction.status === 'native') {
              readable = {
                format: extraction.format,
                path: modelPath,
                status: 'native',
              };
            } else if (extraction.status === 'ready') {
              const extractedBytes = Buffer.byteLength(extraction.markdown, 'utf8');
              if (!await quotaGate.reserve(extractedBytes)) {
                readable = {
                  format: extraction.format,
                  maxProjectBytes,
                  status: 'quota-exceeded',
                };
              } else {
                let extractedStaging;
                try {
                  extractedStaging = await stageBuffer(stagingRoot, extraction.markdown);
                  const extractedName = `${published.filename}.extracted.md`;
                  const extracted = await publishWithoutOverwrite(extractedStaging, batchDirectory, extractedName);
                  readableDestination = extracted.destination;
                  const readableRelative = path.relative(uploadRoot, extracted.destination).split(path.sep).join('/');
                  readable = {
                    bytes: extractedBytes,
                    format: extraction.format,
                    path: `${publicPath}/${readableRelative}`,
                    status: 'ready',
                    truncated: extraction.truncated,
                  };
                } finally {
                  quotaGate.release(extractedBytes);
                  if (extractedStaging !== undefined) await rm(extractedStaging, { force: true });
                }
              }
            } else if (extraction.status === 'too-large') {
              readable = {
                format: extraction.format,
                maxSourceBytes: extraction.maxSourceBytes,
                sourceBytes: extraction.sourceBytes,
                status: 'too-large',
              };
            } else {
              readable = {
                format: extraction.format,
                status: extraction.status,
              };
            }
          }
        } catch (error) {
          console.warn(`Readable material preparation failed for ${published.filename}: ${error.message}`);
          readable = {
            code: error.code ?? (isPrototypeArchive(published.filename)
              ? 'PROTOTYPE_ARCHIVE_PARSE_FAILED'
              : 'DOCUMENT_PARSE_FAILED'),
            status: 'failed',
          };
        }
        const auditRecord = {
          schemaVersion: 2,
          at: new Date().toISOString(),
          batch,
          bytes: received.bytes,
          client: safeClientAddress(request),
          filename: published.filename,
          path: modelPath,
          readable,
          scope: auditScope,
          sha256: received.sha256,
        };
        try {
          await appendFile(
            path.join(uploadRoot, '.upload-audit.jsonl'),
            `${JSON.stringify(auditRecord)}\n`,
            { encoding: 'utf8', mode: 0o640 },
          );
        } catch (error) {
          await rm(published.destination, { force: true });
          if (readableDestination !== undefined) await rm(readableDestination, { force: true, recursive: true });
          throw error;
        }
        json(response, 201, { ok: true, file: auditRecord });
      } finally {
        quotaGate.release(declaredBytes);
        await rm(stagingPath, { force: true });
      }
    } catch (error) {
      if (response.writableEnded || response.destroyed) return;
      if (error instanceof UploadError) {
        json(response, error.status, { ok: false, code: error.code, message: error.message });
        return;
      }
      if (error instanceof ConversationOutputStoreError) {
        const status = error.code === 'OUTPUT_NOT_FOUND' ? 404 : error.code === 'OUTPUT_TOO_LARGE' ? 413
          : /INVALID$/u.test(error.code) ? 400 : 409;
        json(response, status, { ok: false, code: error.code, message: '对话文件未能通过完整性检查，未返回内容。' });
        return;
      }
      console.error(`Harness upload failed: ${error.message}`);
      json(response, 500, { ok: false, code: 'UPLOAD_FAILED', message: '文件上传失败，请重试。' });
    }
  });
}

async function startFromCommandLine() {
  const listenHost = process.env.HARNESS_UPLOAD_ADDRESS ?? '0.0.0.0';
  const listenPort = Number.parseInt(process.env.HARNESS_UPLOAD_PORT ?? '3090', 10);
  const uploadRoot = process.env.HARNESS_UPLOAD_ROOT ?? '/project-uploads';
  const token = process.env.HARNESS_UPLOAD_TOKEN;
  const server = await createUploadServer({
    uploadRoot,
    token,
    publicPath: process.env.HARNESS_UPLOAD_PUBLIC_PATH ?? '/project-inputs',
    auditScope: {
      scopeType: process.env.HARNESS_UPLOAD_SCOPE_TYPE,
      projectSlug: process.env.HARNESS_UPLOAD_PROJECT_SLUG,
      taskspaceId: process.env.HARNESS_UPLOAD_TASKSPACE_ID || null,
      actorId: process.env.HARNESS_UPLOAD_ACTOR_ID || null,
      conversationId: process.env.HARNESS_UPLOAD_CONVERSATION_ID || null,
    },
    maxFileBytes: process.env.HARNESS_UPLOAD_MAX_FILE_BYTES,
    maxBatchFiles: process.env.HARNESS_UPLOAD_MAX_BATCH_FILES,
    maxBatchBytes: process.env.HARNESS_UPLOAD_MAX_BATCH_BYTES,
    maxProjectBytes: process.env.HARNESS_UPLOAD_MAX_PROJECT_BYTES,
    documentLimits: {
      maxOutputBytes: process.env.HARNESS_DOCUMENT_MAX_OUTPUT_BYTES,
      maxPdfPages: process.env.HARNESS_DOCUMENT_MAX_PDF_PAGES,
      maxSourceBytes: process.env.HARNESS_DOCUMENT_MAX_SOURCE_BYTES,
      maxSpreadsheetColumns: process.env.HARNESS_DOCUMENT_MAX_SPREADSHEET_COLUMNS,
      maxSpreadsheetRows: process.env.HARNESS_DOCUMENT_MAX_SPREADSHEET_ROWS,
    },
    prototypeLimits: {
      maxArchiveBytes: process.env.HARNESS_PROTOTYPE_MAX_ARCHIVE_BYTES,
      maxCompressionRatio: process.env.HARNESS_PROTOTYPE_MAX_COMPRESSION_RATIO,
      maxDepth: process.env.HARNESS_PROTOTYPE_MAX_DEPTH,
      maxEntries: process.env.HARNESS_PROTOTYPE_MAX_ENTRIES,
      maxFileBytes: process.env.HARNESS_PROTOTYPE_MAX_FILE_BYTES,
      maxHtmlAnalysisBytes: process.env.HARNESS_PROTOTYPE_MAX_HTML_ANALYSIS_BYTES,
      maxPages: process.env.HARNESS_PROTOTYPE_MAX_PAGES,
      maxPathBytes: process.env.HARNESS_PROTOTYPE_MAX_PATH_BYTES,
      maxSummaryBytes: process.env.HARNESS_PROTOTYPE_MAX_SUMMARY_BYTES,
      maxUncompressedBytes: process.env.HARNESS_PROTOTYPE_MAX_UNCOMPRESSED_BYTES,
    },
  });
  server.on('error', (error) => {
    console.error(`Harness upload server failed: ${error.message}`);
    process.exit(1);
  });
  server.listen(listenPort, listenHost, () => {
    console.log(`Harness upload server listening on ${listenHost}:${listenPort}; root=${uploadRoot}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  startFromCommandLine().catch((error) => {
    console.error(`Harness upload server configuration failed: ${error.message}`);
    process.exit(2);
  });
}
