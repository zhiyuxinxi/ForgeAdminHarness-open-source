import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseDeliveryDocumentDefinitions, deliveryDocumentDiagnostic } from './delivery-center-document-source.mjs';
import { validateSourceTransition } from './taskspace-policy.mjs';

const HASH = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const ID = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const LIMITS = Object.freeze({ files: 64, blobBytes: 2 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024, packetBytes: 8 * 1024 * 1024, collectionMs: 15000, commandMs: 5000 });
const failure = code => Object.assign(new Error(code), { code });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const serialise = value => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
const documentPath = value => typeof value === 'string' && value.startsWith('code-copilot/changes/')
  && value.endsWith('.md') && !/[\u0000-\u001f\\]/u.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

function git(root, args, deadline, maxBytes = 8192) {
  return new Promise((resolve, reject) => {
    const timeout = Math.min(LIMITS.commandMs, deadline - Date.now());
    if (timeout <= 0) { reject(failure('CHECKPOINT_DOCUMENT_TIMEOUT')); return; }
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
    const child = spawn('git', ['-c', `safe.directory=${root}`, '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.fsmonitor=false', '-C', root, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0; let error = null;
    const stop = code => { error ??= failure(code); child.kill(); };
    const timer = setTimeout(() => stop('CHECKPOINT_DOCUMENT_TIMEOUT'), timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop('CHECKPOINT_DOCUMENT_LIMIT'); else chunks.push(chunk);
    });
    child.stderr.on('data', () => {});
    child.on('error', () => { error ??= failure('CHECKPOINT_DOCUMENT_GIT_UNAVAILABLE'); });
    child.on('close', code => {
      clearTimeout(timer);
      if (error || code !== 0) reject(error ?? failure('CHECKPOINT_DOCUMENT_GIT_UNAVAILABLE'));
      else resolve(Buffer.concat(chunks));
    });
  });
}

async function trustedDirectory(root, taskId) {
  if (!path.isAbsolute(root)) throw failure('CHECKPOINT_DOCUMENT_PATH_UNSAFE');
  // Broker stateRoot is already trusted. Each new child must remain a real directory.
  let current = path.resolve(root);
  const rootInfo = await lstat(current);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw failure('CHECKPOINT_DOCUMENT_PATH_UNSAFE');
  const trustedRoot = await realpath(current);
  for (const segment of ['delivery-phases', '.committed-documents', taskId]) {
    current = path.join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()
      || !(await realpath(current)).startsWith(`${trustedRoot}${path.sep}`)) throw failure('CHECKPOINT_DOCUMENT_PATH_UNSAFE');
  }
  return current;
}

async function existingPacket(filename) {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > LIMITS.packetBytes) throw failure('CHECKPOINT_DOCUMENT_EXISTING_INVALID');
    const bytes = await readFile(filename);
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error.code?.startsWith('CHECKPOINT_DOCUMENT_') ? error : failure('CHECKPOINT_DOCUMENT_EXISTING_INVALID');
  }
}

async function capture({ stateRoot, repositoryRoot, sourceTransition, commit, tree, changedPaths, now }) {
  const transition = validateSourceTransition(sourceTransition);
  const identity = transition.task;
  if (transition.phase !== 'checkpointed' || transition.to.head !== commit || !HASH.test(commit)
    || !HASH.test(tree) || !ID.test(identity.taskId) || !Array.isArray(changedPaths)
    || changedPaths.some(item => typeof item !== 'string')) throw failure('CHECKPOINT_DOCUMENT_IDENTITY_INVALID');
  const paths = [...new Set(changedPaths.filter(documentPath))].sort();
  if (!paths.length) return { status: 'not-applicable', sourceCommit: commit, documentBlocks: 0 };
  if (paths.length > LIMITS.files) throw failure('CHECKPOINT_DOCUMENT_LIMIT');
  const deadline = Date.now() + LIMITS.collectionMs;
  const info = await lstat(repositoryRoot);
  if (!path.isAbsolute(repositoryRoot) || !info.isDirectory() || info.isSymbolicLink()) throw failure('CHECKPOINT_DOCUMENT_PATH_UNSAFE');
  const root = await realpath(repositoryRoot);
  const commitInfo = (await git(root, ['show', '-s', '--format=%H%n%T%n%cI', commit], deadline)).toString('utf8').trim().split(/\r?\n/u);
  if (commitInfo[0] !== commit || commitInfo[1] !== tree || !Number.isFinite(Date.parse(commitInfo[2]))) throw failure('CHECKPOINT_DOCUMENT_IDENTITY_INVALID');
  const documents = []; let totalBytes = 0;
  for (const relative of paths) {
    const entry = (await git(root, ['--literal-pathspecs', 'ls-tree', '-z', commit, '--', relative], deadline)).toString('utf8');
    if (!entry) continue; // A committed deletion has no new definition.
    const parsed = /^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/u.exec(entry);
    if (!parsed || parsed[3] !== relative) throw failure('CHECKPOINT_DOCUMENT_PATH_UNSAFE');
    const blob = parsed[2];
    const size = Number((await git(root, ['cat-file', '-s', blob], deadline)).toString('utf8').trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.blobBytes || totalBytes + size > LIMITS.totalBytes) throw failure('CHECKPOINT_DOCUMENT_LIMIT');
    const bytes = await git(root, ['cat-file', 'blob', blob], deadline, LIMITS.blobBytes);
    if (bytes.length !== size) throw failure('CHECKPOINT_DOCUMENT_GIT_UNAVAILABLE');
    totalBytes += bytes.length;
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    documents.push(...parseDeliveryDocumentDefinitions(content, {
      path: relative, blob, commit, committedAt: commitInfo[2], contentDigest: sha256(bytes),
    }).filter(document => document.records.length > 0));
  }
  if (!documents.length) return { status: 'not-applicable', sourceCommit: commit, documentBlocks: 0 };
  const directory = await trustedDirectory(stateRoot, identity.taskId);
  const filename = path.join(directory, `${commit}.json`);
  const prior = await existingPacket(filename);
  const capturedAt = prior?.value?.capturedAt ?? now();
  if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt))) throw failure('CHECKPOINT_DOCUMENT_EXISTING_INVALID');
  const envelope = { schemaVersion: 'forge-delivery-checkpoint-documents/v1', projectSlug: identity.projectSlug,
    taskId: identity.taskId, conversationId: identity.conversationId, dshSessionId: identity.dshSessionId,
    sourceCommit: commit, sourceTree: tree, sourceTransitionDigest: transition.digest, capturedAt, documents };
  const bytes = serialise(envelope);
  if (bytes.length > LIMITS.packetBytes) throw failure('CHECKPOINT_DOCUMENT_LIMIT');
  if (prior) {
    if (!bytes.equals(prior.bytes)) throw failure('CHECKPOINT_DOCUMENT_EXISTING_MISMATCH');
  } else {
    const temporary = path.join(directory, `.${commit}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      // An exclusive hard link publishes complete bytes without replacing an existing packet.
      try { await link(temporary, filename); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const raced = await existingPacket(filename);
        if (!raced || !bytes.equals(raced.bytes)) throw failure('CHECKPOINT_DOCUMENT_EXISTING_MISMATCH');
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return { status: 'captured', relativePath: `.committed-documents/${identity.taskId}/${commit}.json`,
    sha256: sha256(bytes), sourceCommit: commit, documentBlocks: documents.length };
}

/** Called only after Broker has verified and committed its exact authorized paths. */
export async function captureDeliveryCheckpointDocuments(options) {
  if (options.sourceTransition?.task?.projectSlug !== 'forge-base') {
    return { status: 'not-applicable', reason: 'project-not-enabled', sourceCommit: options.commit, documentBlocks: 0 };
  }
  try { return await capture({ ...options, now: options.now ?? (() => new Date().toISOString()) }); }
  catch (error) {
    const code = /^(?:CHECKPOINT_DOCUMENT_|COMMITTED_DOCUMENT_)[A-Z_]+$/u.test(error.code ?? '')
      ? error.code : 'CHECKPOINT_DOCUMENT_CAPTURE_FAILED';
    const diagnostic = deliveryDocumentDiagnostic(error);
    const sourceError = code === 'COMMITTED_DOCUMENT_INVALID_JSON';
    const explanation = { 'invalid-json': '共享资料块不是合法 JSON', 'invalid-metadata': '共享资料块的 deliveryCenter 元数据不合法或记录类型不受支持', 'unterminated-fence': '共享资料块的代码围栏没有闭合' };
    return { status: 'failed', code, sourceCommit: options.commit, ...diagnostic,
      recovery: sourceError ? 'source-correction-required' : 'cause-resolution-required',
      message: sourceError ? `提交已保存；${explanation[diagnostic.reason] ?? '已提交资料格式不合法'}，需修正资料并重新提交。重复采集原提交不能修复此错误。`
        : '提交已保存；过程资料采集未完成。需先排查并解除读取或存储等失败原因，再判断是否可按原提交恢复；不会自动重试。' };
  }
}
