import crypto from 'node:crypto';
import path from 'node:path';
import { conversationFilePresentation } from './output-file-presentation.mjs';
import {
  lstat, mkdir, open, readFile, readdir, realpath, rename, rm,
} from 'node:fs/promises';

const SNAPSHOT_SCHEMA = 'forge-conversation-output/v1';
const MANIFEST_SCHEMA = 'forge-conversation-output-manifest/v1';
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SAFE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,191}\.(?:md|txt|json|html|sql)$/iu;
const MEDIA = /^(?:text\/(?:plain|markdown|html|x-sql)(?:;\s*charset=utf-8)?|application\/json(?:;\s*charset=utf-8)?)$/iu;
const RESERVED = new Set(['conversation.md', 'conversation.json', 'manifest.json']);
const STAT_KEYS = ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'];

export class ConversationOutputStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConversationOutputStoreError';
    this.code = code;
  }
}

function fail(code, message) { throw new ConversationOutputStoreError(code, message); }
function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sameStat(left, right) { return STAT_KEYS.every((key) => left[key] === right[key]); }
function cleanPublicPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.includes('\\')) {
    fail('OUTPUT_CONFIG_INVALID', 'publicPath is invalid.');
  }
  return value.replace(/\/+$/u, '') || '/';
}
function validateScope(scope) {
  const keys = ['scopeType', 'projectSlug', 'taskspaceId', 'actorId', 'conversationId'];
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).sort().join('|') !== keys.sort().join('|')
    || scope.scopeType !== 'taskspace-private'
    || keys.slice(1).some((key) => typeof scope[key] !== 'string' || scope[key].length < 1 || scope[key].length > 256
      || /[\0\r\n]/u.test(scope[key]))) {
    fail('OUTPUT_SCOPE_INVALID', 'A complete taskspace-private server scope is required.');
  }
  return Object.freeze({ ...scope });
}
function validateSnapshot(snapshot) {
  const keys = ['schemaVersion', 'sessionId', 'status', 'firstSeq', 'lastSeq', 'eventCount', 'eventDigest', 'entries', 'files'];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || Object.keys(snapshot).sort().join('|') !== keys.sort().join('|')
    || snapshot.schemaVersion !== SNAPSHOT_SCHEMA || !SESSION.test(snapshot.sessionId)
    || !['running', 'completed', 'failed', 'stopped', 'empty'].includes(snapshot.status)
    || !Number.isSafeInteger(snapshot.firstSeq) || !Number.isSafeInteger(snapshot.lastSeq)
    || !Number.isSafeInteger(snapshot.eventCount) || snapshot.eventCount < 0
    || typeof snapshot.eventDigest !== 'string' || !DIGEST.test(snapshot.eventDigest)
    || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.files)) {
    fail('OUTPUT_SNAPSHOT_INVALID', 'Conversation output snapshot is invalid.');
  }
  if (snapshot.entries.length > snapshot.eventCount
    || (snapshot.eventCount === 0 ? snapshot.firstSeq !== 0 || snapshot.lastSeq !== 0
      : snapshot.firstSeq > snapshot.lastSeq)) fail('OUTPUT_SNAPSHOT_INVALID', 'Snapshot sequence metadata is inconsistent.');
  let previous = -1;
  for (const entry of snapshot.entries) {
    const allowed = new Set(['seq', 'type', 'turn', 'role', 'text', 'toolName', 'callId', 'status']);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).some((key) => !allowed.has(key))
      || !Number.isSafeInteger(entry.seq) || entry.seq < 0 || entry.seq <= previous
      || typeof entry.type !== 'string' || entry.type.length < 1 || entry.type.length > 128
      || (Object.hasOwn(entry, 'turn') && !((typeof entry.turn === 'string' && !/\0/u.test(entry.turn))
        || (Number.isSafeInteger(entry.turn) && entry.turn >= 0)))
      || ['role', 'text', 'toolName', 'callId', 'status'].some((key) => (
        Object.hasOwn(entry, key) && (typeof entry[key] !== 'string' || /\0/u.test(entry[key]))))) {
      fail('OUTPUT_SNAPSHOT_INVALID', 'Snapshot entry is invalid.');
    }
    previous = entry.seq;
  }
  if (snapshot.entries.length > 0
    && (snapshot.entries[0].seq < snapshot.firstSeq || snapshot.entries.at(-1).seq > snapshot.lastSeq)) {
    fail('OUTPUT_SNAPSHOT_INVALID', 'Snapshot entry range is inconsistent.');
  }
  const names = new Set();
  for (const file of snapshot.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).sort().join('|') !== 'content|mediaType|name'
      || typeof file.name !== 'string' || !SAFE_NAME.test(file.name) || RESERVED.has(file.name.toLowerCase())
      || names.has(file.name) || typeof file.mediaType !== 'string' || !MEDIA.test(file.mediaType)
      || typeof file.content !== 'string' || file.content.includes('\0')) {
      fail('OUTPUT_FILE_INVALID', 'Snapshot file is invalid, duplicated, or reserved.');
    }
    names.add(file.name);
  }
  return snapshot;
}

async function safeDirectory(directory, code = 'OUTPUT_STORAGE_UNSAFE') {
  const info = await lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) fail(code, 'Output storage directory is unsafe.');
  return info;
}
async function safeRead(file, maximum) {
  const before = await lstat(file).catch(() => fail('OUTPUT_MEMBER_MISSING', 'Output member is missing.'));
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) {
    fail('OUTPUT_MEMBER_UNSAFE', 'Output member is unsafe.');
  }
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!sameStat(before, opened)) fail('OUTPUT_MEMBER_CHANGED', 'Output member changed while opening.');
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (!sameStat(opened, after) || !sameStat(after, await lstat(file))) fail('OUTPUT_MEMBER_CHANGED', 'Output member changed while reading.');
    return buffer;
  } finally { await handle.close(); }
}
function metadata(name, mediaType, buffer, modelPath) {
  return Object.freeze({ name, mediaType, bytes: buffer.length, sha256: sha(buffer), modelPath });
}
function projection(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion, sessionId: snapshot.sessionId, status: snapshot.status,
    firstSeq: snapshot.firstSeq, lastSeq: snapshot.lastSeq, eventCount: snapshot.eventCount,
    eventDigest: snapshot.eventDigest, entries: snapshot.entries,
  };
}
function markdown(snapshot) {
  const statuses = { running: '进行中', completed: '已结束', failed: '失败', stopped: '已停止', empty: '暂无内容', pending: '未完成' };
  const roles = { user: '用户输入', assistant: 'AI 输出', context: '参考上下文' };
  const lines = ['# 对话记录', '', `会话：${snapshot.sessionId}`, `状态：${statuses[snapshot.status] ?? snapshot.status}`, '',
    '本记录保留输入、输出与工具结果；不代表业务验收通过。', ''];
  for (const entry of snapshot.entries) {
    const label = roles[entry.role] ?? (entry.toolName ? '工具调用' : entry.type === 'tool/result' ? '工具结果' : '执行记录');
    lines.push(`## ${label}${entry.turn === undefined ? '' : ` · 第 ${entry.turn} 轮`}`, '', `记录编号：${entry.seq}`);
    if (entry.toolName) lines.push(`工具：${entry.toolName}`);
    if (entry.status) lines.push(`状态：${statuses[entry.status] ?? entry.status}`);
    if (entry.text !== undefined) lines.push('', entry.text);
    lines.push('');
  }
  return Buffer.from(`${lines.join('\n').replace(/\n+$/u, '')}\n`, 'utf8');
}

export function createConversationOutputStore({
  root, publicPath = '/project-inputs', scope, maxBytes = 50 * 1024 * 1024,
  reserveBytes = async () => {}, releaseBytes = async () => {},
}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || typeof reserveBytes !== 'function' || typeof releaseBytes !== 'function') fail('OUTPUT_CONFIG_INVALID', 'Output store configuration is invalid.');
  const fixedScope = validateScope(scope);
  const exposedRoot = cleanPublicPath(publicPath);
  const outputsRoot = path.join(root, 'outputs');

  async function initialize(create = false) {
    await safeDirectory(root);
    if (create) await mkdir(outputsRoot, { recursive: true, mode: 0o700 });
    else if (await lstat(outputsRoot).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)) === null) return false;
    await safeDirectory(outputsRoot);
    const resolvedRoot = await realpath(root);
    const resolvedOutputs = await realpath(outputsRoot);
    if (!resolvedOutputs.startsWith(`${resolvedRoot}${path.sep}`)) fail('OUTPUT_STORAGE_UNSAFE', 'Output root escapes storage root.');
    return true;
  }
  const modelPath = (sessionId, snapshotId, name) => `${exposedRoot}/outputs/${sessionId}/${snapshotId}/${name}`;

  async function loadManifest(sessionId, snapshotId) {
    if (!SESSION.test(sessionId) || !DIGEST.test(snapshotId)) fail('OUTPUT_PATH_INVALID', 'Output identity is invalid.');
    if (!await initialize()) fail('OUTPUT_NOT_FOUND', 'Output snapshot is not present.');
    await safeDirectory(path.join(outputsRoot, sessionId), 'OUTPUT_NOT_FOUND');
    const directory = path.join(outputsRoot, sessionId, snapshotId);
    await safeDirectory(directory, 'OUTPUT_NOT_FOUND');
    const bytes = await safeRead(path.join(directory, 'manifest.json'), maxBytes);
    let manifest;
    try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('OUTPUT_MANIFEST_INVALID', 'Output manifest is invalid.'); }
    if (manifest?.schemaVersion !== MANIFEST_SCHEMA || manifest.sessionId !== sessionId
      || manifest.snapshotId !== snapshotId || canonical(manifest.scope) !== canonical(fixedScope)
      || !Array.isArray(manifest.files)) fail('OUTPUT_SCOPE_MISMATCH', 'Output manifest identity or scope differs.');
    return { directory, manifest, bytes };
  }

  async function verifyMembers(directory, manifest) {
    const expected = [...manifest.files.map((file) => file.name), 'manifest.json'].sort();
    const actual = (await readdir(directory, { withFileTypes: true })).map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) fail('OUTPUT_MEMBER_UNSAFE', 'Output directory contains an unsafe member.');
      return entry.name;
    }).sort();
    if (canonical(actual) !== canonical(expected)) fail('OUTPUT_MANIFEST_DRIFT', 'Output directory differs from its manifest.');
    const buffers = new Map();
    const memberNames = new Set();
    for (const member of manifest.files) {
      if (!member || typeof member !== 'object' || Array.isArray(member)
        || Object.keys(member).sort().join('|') !== 'bytes|mediaType|modelPath|name|sha256'
        || (!SAFE_NAME.test(member.name) && !RESERVED.has(member.name)) || member.name === 'manifest.json'
        || memberNames.has(member.name) || !Number.isSafeInteger(member.bytes) || member.bytes < 0
        || !DIGEST.test(member.sha256) || !MEDIA.test(member.mediaType)) {
        fail('OUTPUT_MANIFEST_INVALID', 'Manifest member metadata is invalid.');
      }
      memberNames.add(member.name);
      const buffer = await safeRead(path.join(directory, member.name), maxBytes);
      if (buffer.length !== member.bytes || sha(buffer) !== member.sha256
        || member.modelPath !== modelPath(manifest.sessionId, manifest.snapshotId, member.name)) {
        fail('OUTPUT_MEMBER_DRIFT', 'Output member differs from its manifest.');
      }
      buffers.set(member.name, buffer);
    }
    if (!memberNames.has('conversation.md') || !memberNames.has('conversation.json')) {
      fail('OUTPUT_MANIFEST_INVALID', 'Generated conversation members are missing.');
    }
    let projected;
    try { projected = JSON.parse(buffers.get('conversation.json').toString('utf8')); }
    catch { fail('OUTPUT_MEMBER_DRIFT', 'Conversation JSON is invalid.'); }
    const customFiles = manifest.files.filter((member) => !RESERVED.has(member.name)).map((member) => ({
      name: member.name, mediaType: member.mediaType, content: buffers.get(member.name).toString('utf8'),
    }));
    const reconstructed = validateSnapshot({ ...projected, files: customFiles });
    if (sha(Buffer.from(canonical(reconstructed), 'utf8')) !== manifest.snapshotId
      || !buffers.get('conversation.md').equals(markdown(reconstructed))) {
      fail('OUTPUT_MEMBER_DRIFT', 'Output members do not bind the snapshot identity.');
    }
    if (['sessionId', 'status', 'firstSeq', 'lastSeq', 'eventCount', 'eventDigest']
      .some((key) => manifest[key] !== reconstructed[key])) {
      fail('OUTPUT_MANIFEST_DRIFT', 'Output manifest metadata differs from its snapshot.');
    }
  }

  async function save(rawSnapshot) {
    const snapshot = validateSnapshot(rawSnapshot);
    const snapshotBytes = Buffer.from(canonical(snapshot), 'utf8');
    if (snapshotBytes.length > maxBytes) fail('OUTPUT_TOO_LARGE', 'Conversation output exceeds its size limit.');
    const snapshotId = sha(snapshotBytes);
    await initialize(true);
    const sessionDirectory = path.join(outputsRoot, snapshot.sessionId);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    await safeDirectory(sessionDirectory);
    const finalDirectory = path.join(sessionDirectory, snapshotId);
    const existing = await lstat(finalDirectory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (existing !== null) {
      const loaded = await loadManifest(snapshot.sessionId, snapshotId);
      await verifyMembers(loaded.directory, loaded.manifest);
      return Object.freeze({ snapshotId, idempotent: true, manifest: loaded.manifest });
    }
    const stage = path.join(sessionDirectory, `.stage-${snapshotId}-${crypto.randomUUID()}`);
    let reserved = 0;
    let reservationHeld = false;
    try {
      const conversationJson = Buffer.from(`${JSON.stringify(projection(snapshot), null, 2)}\n`, 'utf8');
      const contents = [
        ['conversation.md', 'text/markdown; charset=utf-8', markdown(snapshot)],
        ['conversation.json', 'application/json; charset=utf-8', conversationJson],
        ...snapshot.files.map((file) => [file.name, file.mediaType, Buffer.from(file.content, 'utf8')]),
      ];
      const members = contents.map(([name, mediaType, buffer]) => (
        metadata(name, mediaType, buffer, modelPath(snapshot.sessionId, snapshotId, name))
      ));
      const manifest = {
        schemaVersion: MANIFEST_SCHEMA, snapshotId, sessionId: snapshot.sessionId, status: snapshot.status,
        firstSeq: snapshot.firstSeq, lastSeq: snapshot.lastSeq, eventCount: snapshot.eventCount,
        eventDigest: snapshot.eventDigest, createdAt: new Date().toISOString(), scope: fixedScope, files: members,
      };
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      reserved = contents.reduce((sum, [, , buffer]) => sum + buffer.length, manifestBytes.length);
      if (reserved > maxBytes) fail('OUTPUT_TOO_LARGE', 'Conversation output exceeds its size limit.');
      await reserveBytes(reserved);
      reservationHeld = true;
      await mkdir(stage, { mode: 0o700 });
      for (const [name, mediaType, buffer] of contents) {
        const handle = await open(path.join(stage, name), 'wx', 0o600);
        try { await handle.writeFile(buffer); await handle.sync(); } finally { await handle.close(); }
      }
      const manifestHandle = await open(path.join(stage, 'manifest.json'), 'wx', 0o600);
      try { await manifestHandle.writeFile(manifestBytes); await manifestHandle.sync(); } finally { await manifestHandle.close(); }
      try { await rename(stage, finalDirectory); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
        await rm(stage, { recursive: true, force: true });
        const loaded = await loadManifest(snapshot.sessionId, snapshotId);
        await verifyMembers(loaded.directory, loaded.manifest);
        await releaseBytes(reserved);
        reservationHeld = false;
        return Object.freeze({ snapshotId, idempotent: true, manifest: loaded.manifest });
      }
      return Object.freeze({ snapshotId, idempotent: false, manifest });
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      if (reservationHeld) await releaseBytes(reserved).catch(() => {});
      throw error;
    }
  }

  async function list({ sessionId, offset = 0, limit = 20 } = {}) {
    if (sessionId !== undefined && !SESSION.test(sessionId)) fail('OUTPUT_PATH_INVALID', 'Session identity is invalid.');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      fail('OUTPUT_PAGE_INVALID', 'Output page is invalid.');
    }
    if (!await initialize()) return Object.freeze({ items: [], offset, limit, hasMore: false });
    const sessions = sessionId === undefined
      ? (await readdir(outputsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && SESSION.test(entry.name)).map((entry) => entry.name)
      : [sessionId];
    const items = [];
    for (const currentSession of sessions) {
      const sessionDirectory = path.join(outputsRoot, currentSession);
      const exists = await lstat(sessionDirectory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (exists === null) continue;
      await safeDirectory(sessionDirectory);
      for (const entry of await readdir(sessionDirectory, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && /^\.stage-[a-f0-9]{64}-[a-f0-9-]{36}$/u.test(entry.name)) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink() || !DIGEST.test(entry.name)) fail('OUTPUT_STORAGE_UNSAFE', 'Output index contains an unsafe entry.');
        const loaded = await loadManifest(currentSession, entry.name);
        await verifyMembers(loaded.directory, loaded.manifest);
        items.push({ sessionId: currentSession, snapshotId: entry.name, status: loaded.manifest.status,
          lastSeq: loaded.manifest.lastSeq, createdAt: loaded.manifest.createdAt, scope: loaded.manifest.scope,
          files: [...loaded.manifest.files, metadata('manifest.json', 'application/json', loaded.bytes,
            modelPath(currentSession, entry.name, 'manifest.json'))]
            .map((file) => ({ ...file, ...conversationFilePresentation(file, loaded.manifest) })) });
      }
    }
    items.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.snapshotId.localeCompare(left.snapshotId));
    return Object.freeze({ items: items.slice(offset, offset + limit), offset, limit, hasMore: offset + limit < items.length });
  }

  async function read({ sessionId, snapshotId, name }) {
    if (typeof name !== 'string' || (!SAFE_NAME.test(name) && !RESERVED.has(name))) {
      fail('OUTPUT_PATH_INVALID', 'Output member name is invalid.');
    }
    const loaded = await loadManifest(sessionId, snapshotId);
    await verifyMembers(loaded.directory, loaded.manifest);
    if (name === 'manifest.json') return Object.freeze({ buffer: loaded.bytes,
      mediaType: 'application/json', name, sha256: sha(loaded.bytes),
      ...conversationFilePresentation({ name, mediaType: 'application/json' }, loaded.manifest) });
    const member = loaded.manifest.files.find((candidate) => candidate.name === name);
    if (member === undefined) fail('OUTPUT_NOT_FOUND', 'Output member is not present.');
    const buffer = await safeRead(path.join(loaded.directory, name), maxBytes);
    return Object.freeze({ buffer, mediaType: member.mediaType, name, sha256: member.sha256,
      ...conversationFilePresentation(member, loaded.manifest) });
  }

  return Object.freeze({ save, list, read });
}
