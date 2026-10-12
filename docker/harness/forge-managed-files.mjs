import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const MANAGED_FILES_ACTION = 'managed-files';
export const MANAGED_FILE_TOOL = 'managed_file';
export const MANAGED_FILE_LIMIT = 256 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const ACTOR = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const OPS = ['read', 'write', 'remove', 'restore'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const seal = value => sha(JSON.stringify(value));
export class ManagedFileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function managedFileError(code, message) { throw new ManagedFileError(code, message); }
const fail = managedFileError;
function exact(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).some(key => !keys.includes(key))) fail('MANAGED_FILE_SCHEMA', 'Unsupported managed-file fields.');
}

export function managedFileRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value !== value.normalize('NFC')
    || value !== value.trim() || /[\\:%*?\[\]{}\u0000-\u001f\u007f]/u.test(value)
    || value.split('/').some(part => !part || part.startsWith('.'))
    || /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]*(?:secret|credential|private[-_.]?key)[^/]*)(?:$|\/)/iu.test(value)
    || /\.(?:pem|key|p12|pfx|db|sqlite|sqlite3)$/iu.test(value)) {
    fail('MANAGED_FILE_PATH', 'Use an ordinary relative file path; hidden, credential and database files are excluded.');
  }
  return value;
}

export function validateManagedFileTargets(value, projectSlug) {
  exact(value, ['schemaVersion', 'projectSlug', 'targets']);
  if (value.schemaVersion !== 1 || value.projectSlug !== projectSlug || !ID.test(projectSlug)
    || !Array.isArray(value.targets) || value.targets.length > 32) fail('MANAGED_FILE_CONFIG', 'Invalid project target configuration.');
  const ids = new Set();
  const targets = value.targets.map(target => {
    exact(target, ['targetId', 'name', 'transport', 'serverDirectory', 'readActorIds', 'writeActorIds', 'expectedDevice', 'expectedInode']);
    if (!ID.test(target.targetId) || ids.has(target.targetId) || typeof target.name !== 'string'
      || !target.name.trim() || target.name.length > 120 || /[\p{Cc}]/u.test(target.name)
      || target.transport !== 'local' || typeof target.serverDirectory !== 'string'
      || !/^\/(?:srv|data|mnt)\/[^/]/u.test(target.serverDirectory)
      || path.posix.normalize(target.serverDirectory) !== target.serverDirectory
      || target.serverDirectory.endsWith('/') || /[\\:\p{Cc}]/u.test(target.serverDirectory)
      || target.serverDirectory.split('/').some(part => part.startsWith('.'))
      || !Number.isSafeInteger(target.expectedDevice) || target.expectedDevice < 0
      || !Number.isSafeInteger(target.expectedInode) || target.expectedInode < 1
      || (/^\/srv\/forge-delivery(?:\/|$)/u.test(target.serverDirectory)
        && target.serverDirectory !== `/srv/forge-delivery/file-gateway/data/${projectSlug}`
        && !target.serverDirectory.startsWith(`/srv/forge-delivery/file-gateway/data/${projectSlug}/`))) {
      fail('MANAGED_FILE_CONFIG', 'Only explicit ordinary local data directories may be registered; platform/system roots are excluded.');
    }
    for (const key of ['readActorIds', 'writeActorIds']) {
      if (!Array.isArray(target[key]) || target[key].length > 256 || target[key].some(id => !ACTOR.test(id))
        || new Set(target[key]).size !== target[key].length) fail('MANAGED_FILE_CONFIG', 'Targets require explicit unique account IDs.');
    }
    if (target.writeActorIds.some(id => !target.readActorIds.includes(id))) fail('MANAGED_FILE_CONFIG', 'Writers must also have read permission.');
    ids.add(target.targetId);
    return { ...target, readActorIds: [...target.readActorIds].sort(), writeActorIds: [...target.writeActorIds].sort() };
  }).sort((a, b) => a.targetId.localeCompare(b.targetId));
  return { schemaVersion: 1, projectSlug, targets };
}

// Operators install this existing-ops JSON as root:root, non-writable, read-only
// in AS and Broker. Neither the model nor Broker has a configuration write API.
export function loadManagedFileTargets(projectSlug, configFile = process.env.FORGE_MANAGED_FILE_TARGETS_FILE) {
  if (!configFile) return validateManagedFileTargets({ schemaVersion: 1, projectSlug, targets: [] }, projectSlug);
  if (configFile !== '/etc/forge-managed-files/targets.json') fail('MANAGED_FILE_CONFIG', 'Use the fixed protected config mount.');
  const fd = openSync(configFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || (before.mode & 0o022) !== 0
      || before.size > 64 * 1024 || realpathSync(configFile) !== configFile) fail('MANAGED_FILE_CONFIG', 'The target registry must be a protected regular operator file.');
    const bytes = readFileSync(fd);
    if (!same(before, fstatSync(fd))) fail('MANAGED_FILE_CONFIG', 'Target registry changed while reading.');
    return validateManagedFileTargets(JSON.parse(bytes), projectSlug);
  } finally { closeSync(fd); }
}

export function managedFileTargetList(config, actorUserId) {
  return { ok: true, targets: config.targets.filter(target => target.readActorIds.includes(actorUserId)).map(target => ({
    targetId: target.targetId, name: target.name, transport: 'local', server: 'current-host',
    serverDirectory: target.serverDirectory, toolPath: `managed_file:${target.targetId}/`,
    read: true, write: target.writeActorIds.includes(actorUserId), scope: 'explicit-task', requiresExplicitRequest: true,
  })) };
}

// Called only while AS remembers the authenticated Manager request. The tool
// never supplies this intent or a prompt; references cannot become grants.
export function managedFileIntentForPrompt(prompt, config, actorUserId) {
  if (typeof prompt !== 'string') return [];
  const plain = prompt.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, value => ' '.repeat(value.length))
    .replace(/`([^`\r\n]*)`/gu, (all, content) => content.startsWith('/') && !/\s/u.test(content) ? ` ${content} ` : ' '.repeat(all.length))
    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu, value => ' '.repeat(value.length))
    .replace(/^\s*>.*$/gmu, value => ' '.repeat(value.length));
  const readOnly = /(?:本次|本轮|这次)?(?:只读|仅分析|只分析|只查看)|(?:不要|禁止|不得|不允许)\s*(?:做任何)?(?:写入|修改|创建|删除|恢复)(?:任何)?(?:文件|内容)/u.test(plain);
  const grants = [];
  const sentences = [...plain.matchAll(/[^。；;！？!?\r\n]+(?:[。；;！？!?]|$)/gu)];
  const excluded = sentence => /(?:不要|禁止|不得|不许|暂不|先不|不能|无需|不必|不允许|不授权|假如|如果|假设|示例|引用|原话|例如|日志|文档说|工具输出|能否|是否|怎么|如何|仅分析|先分析|上一轮|上次|以前|之前|曾经|已经授权|只读)/u.test(sentence) || /[？?]/u.test(sentence);
  for (const target of config.targets) {
    if (!target.readActorIds.includes(actorUserId)) continue;
    for (const [position, match] of sentences.entries()) {
      let sentence = match[0];
      let continuedFile = '';
      const previous = sentences[position - 1]?.[0] ?? '';
      // Only an immediately adjacent, explicit singular directory reference may
      // carry its target forward; the following sentence must supply the action.
      if (!sentence.includes(target.serverDirectory)
        && /^\s*(?:请)?(?:只)?在(?:这个|该)(?:已授权)?(?:服务器)?目录(?:内|里|中|下)/u.test(sentence)
        && !excluded(previous) && !excluded(sentence)
        && !/(?:吗|么)[。\s]*$/u.test(previous)
        && !/(?:引用|示例|文档|日志|工具输出)[^\r\n]*[：:]\s*\r?\n\s*$/u.test(plain.slice(0, sentences[position - 1]?.index ?? 0).split(/[。；;！？!?]/u).at(-1) ?? '')
        && !readOnly && /目录/u.test(previous)
        && (previous.match(/\/[^\s`，,。；;！？!?）)]+/gu) ?? []).length === 1
        && previous.match(/\/[^\s`，,。；;！？!?）)]+/u)?.[0] === target.serverDirectory
        && !/[/`“”‘’「」『』"']/u.test(sentence)
        && !/[`“”‘’「」『』"'>]/u.test(prompt.slice(sentences[position - 1]?.index ?? 0, match.index + match[0].length))) {
        const file = sentence.match(/(?:临时)?文件\s+([A-Za-z0-9][A-Za-z0-9._-]*)/u)?.[1];
        if (file) {
          try { continuedFile = managedFileRelativePath(file); sentence = `${target.serverDirectory} ${sentence}`; } catch { /* no authority */ }
        }
      }
      const preceding = plain.slice(0, match.index).split(/[。；;！？!?]/u).at(-1) ?? '';
      if (/[？?]/u.test(sentence) || /(?:不要|禁止|不得|不许|暂不|先不|不能|无需|不必|不允许|不授权|假如|如果|假设|示例|引用|原话|例如|日志|文档说|工具输出|能否|是否|怎么|如何|仅分析|先分析|上一轮|上次|以前|之前|曾经|已经授权)/u.test(sentence)
        || /(?:吗|么)[。\s]*$/u.test(sentence)
        || /(?:引用|示例|文档|日志|工具输出)[^\r\n]*[：:]\s*\r?\n\s*$/u.test(preceding)
        || !/(?:创建|新建|写入|修改|更新|维护|保存|制作|生成|删除|移除|恢复|还原|读取|查看|阅读|打开)/u.test(sentence)) continue;
      const index = sentence.indexOf(target.serverDirectory);
      if (index < 0 || (index > 0 && /[A-Za-z0-9_./~%-]/u.test(sentence[index - 1]))) continue;
      const following = sentence.slice(index + target.serverDirectory.length);
      if (following && !/^[\/\s`，,。；;）)里中下内的]/u.test(following)) continue;
      const suffix = following.match(/^\/([^\s`，,。；;！？!?）)]+)/u)?.[1];
      let relativePath = continuedFile;
      if (suffix) { try { relativePath = managedFileRelativePath(suffix); } catch { continue; } }
      const operations = ['read'];
      if (!readOnly && target.writeActorIds.includes(actorUserId)) {
        if (/(?:创建|新建|写入|修改|更新|维护|保存|制作|生成)/u.test(sentence)) operations.push('write');
        if (/(?:删除|移除)/u.test(sentence)) operations.push('remove');
        if (/(?:恢复|还原)/u.test(sentence)) operations.push('restore');
      }
      grants.push({ targetId: target.targetId, relativePath, operations, configDigest: seal(config) });
    }
  }
  return grants;
}

export function authorizeManagedFileRequest({ input, record, config, now = Date.now() }) {
  exact(input, ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'rpcId', 'promptTextDigest', 'targetId', 'operation', 'relativePath']);
  if (!record || ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'rpcId', 'promptTextDigest'].some(key => input[key] !== record[key])
    || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= now
    || typeof record.workspaceWriteAuthorized !== 'boolean'
    || !['read-only', 'workspace-write', 'git-checkpoint', 'release'].includes(record.authorizedActionCeiling)
    || (input.operation !== 'read' && (record.workspaceWriteAuthorized !== true
      || !['workspace-write', 'git-checkpoint', 'release'].includes(record.authorizedActionCeiling)))) {
    fail('MANAGED_FILE_AUTHORITY', 'A current protected account/request binding is required.');
  }
  const target = config.targets.find(candidate => candidate.targetId === input.targetId);
  if (!target?.readActorIds.includes(input.actorUserId) || !OPS.includes(input.operation)
    || (input.operation !== 'read' && !target.writeActorIds.includes(input.actorUserId))) fail('MANAGED_FILE_AUTHORITY', 'This account has no permission for the target operation.');
  const relativePath = managedFileRelativePath(input.relativePath);
  const grant = record.managedFileIntent?.find(item => item.targetId === target.targetId && item.configDigest === seal(config)
    && item.operations.includes(input.operation) && (!item.relativePath || relativePath === item.relativePath));
  if (!grant) fail('MANAGED_FILE_EXPLICIT_REQUEST_REQUIRED', 'This direct user request must explicitly name the configured server directory and operation.');
  return { targetId: target.targetId, configDigest: seal(config), operation: input.operation, relativePath,
    actorUserId: input.actorUserId, rpcId: input.rpcId, expiresAt: record.expiresAt };
}

export function validateManagedFileArguments(args) {
  const keys = args?.operation === 'targets' ? ['operation'] : ['operation', 'targetId', 'relativePath',
    ...(args?.operation === 'write' ? ['content', 'expectedVersion'] : []),
    ...(args?.operation === 'remove' ? ['expectedVersion'] : []),
    ...(args?.operation === 'restore' ? ['expectedVersion', 'revisionId'] : [])];
  exact(args, keys);
  if (args.operation === 'targets') return { operation: 'targets' };
  if (!OPS.includes(args.operation) || !ID.test(args.targetId)) fail('MANAGED_FILE_SCHEMA', 'Unsupported target or operation.');
  managedFileRelativePath(args.relativePath);
  if (args.operation !== 'read' && args.expectedVersion !== 'absent' && !/^[a-f0-9]{64}$/u.test(args.expectedVersion ?? '')) fail('MANAGED_FILE_VERSION', 'Read the current version before a mutation; absent is required for creation.');
  if (args.operation === 'write' && (typeof args.content !== 'string' || Buffer.byteLength(args.content) > MANAGED_FILE_LIMIT || /\0/u.test(args.content))) fail('MANAGED_FILE_SIZE', 'Only bounded UTF-8 text files are supported.');
  if (args.operation === 'restore' && !ACTOR.test(args.revisionId ?? '')) fail('MANAGED_FILE_SCHEMA', 'Use the exact returned revision ID.');
  return { ...args };
}

function same(a, b) { return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].every(key => a[key] === b[key]); }
function regular(fd) {
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1 || info.size > MANAGED_FILE_LIMIT || (info.mode & 0o111)) fail('MANAGED_FILE_TYPE', 'Only bounded ordinary, non-executable, single-link text files are supported.');
  const bytes = readFileSync(fd);
  if (!same(info, fstatSync(fd))) fail('MANAGED_FILE_STALE', 'The file changed while reading.');
  const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (content.includes('\0')) fail('MANAGED_FILE_TYPE', 'Binary files are excluded.');
  return { bytes, info, content, version: seal({ sha256: sha(bytes), dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }) };
}

// Targets are mounted only in Broker at this fixed per-ID location. Opening
// each parent through a retained fd prevents symlink/parent-switch escape.
export function executeManagedFileOperation({ args, authorization, config, stateRoot }) {
  args = validateManagedFileArguments(args);
  if (process.platform !== 'linux') fail('MANAGED_FILE_PLATFORM', 'Managed server files require the Linux Broker.');
  if (!authorization || authorization.configDigest !== seal(config) || authorization.targetId !== args.targetId
    || authorization.relativePath !== args.relativePath || authorization.operation !== args.operation
    || Date.parse(authorization.expiresAt) <= Date.now()) fail('MANAGED_FILE_AUTHORITY', 'Current AS authorization is required.');
  const handles = [];
  const root = `/run/forge-managed-files/targets/${args.targetId}`;
  const backupRoot = path.join(stateRoot, 'managed-files', args.targetId);
  let lock;
  let lockOwned = false;
  try {
    if (realpathSync(root) !== root) fail('MANAGED_FILE_PATH', 'The target mount must not be an alias.');
    let parent = root;
    const parts = args.relativePath.split('/');
    for (const part of ['', ...parts.slice(0, -1)]) {
      if (part) parent = `/proc/self/fd/${handles.at(-1)}/${part}`;
      handles.push(openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
    }
    const registered = config.targets.find(item => item.targetId === args.targetId);
    const mounted = fstatSync(handles[0]);
    if (!registered || mounted.dev !== registered.expectedDevice || mounted.ino !== registered.expectedInode) {
      fail('MANAGED_FILE_MOUNT_MISMATCH', 'The mounted directory does not match the operator-registered host directory.');
    }
    const checkParents = () => {
      for (let index = 0; index < parts.length; index += 1) {
        const expected = index === 0 ? root : `${root}/${parts.slice(0, index).join('/')}`;
        const actual = realpathSync(`/proc/self/fd/${handles[index]}`);
        if (actual !== expected) fail('MANAGED_FILE_STALE', 'A parent directory moved outside its registered location.');
      }
    };
    checkParents();
    const target = `/proc/self/fd/${handles.at(-1)}/${parts.at(-1)}`;
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
    if (realpathSync(backupRoot) !== backupRoot) fail('MANAGED_FILE_PATH', 'The protected backup root must not be aliased.');
    lock = path.join(backupRoot, `${sha(Buffer.from(args.relativePath))}.lock`);
    try { mkdirSync(lock, { mode: 0o700 }); lockOwned = true; } catch (error) { if (error.code === 'EEXIST') fail('MANAGED_FILE_BUSY', 'This file has another in-flight operation.'); throw error; }
    let existing = null;
    try {
      const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      handles.push(fd); existing = regular(fd);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (args.operation === 'read') return { targetId: args.targetId, relativePath: args.relativePath,
      exists: existing !== null, version: existing?.version ?? 'absent', content: existing?.content ?? null };
    if ((existing?.version ?? 'absent') !== args.expectedVersion) fail('MANAGED_FILE_STALE', 'The current file differs from the version read.');
    let replacement = args.operation === 'write' ? Buffer.from(args.content) : null;
    if (args.operation === 'restore') {
      const recordPath = path.join(backupRoot, `${args.revisionId}.json`);
      const saved = lstatSync(recordPath);
      if (!saved.isFile() || saved.isSymbolicLink() || saved.nlink !== 1 || saved.size > MANAGED_FILE_LIMIT * 2) fail('MANAGED_FILE_BACKUP', 'Invalid protected revision.');
      const revision = JSON.parse(readFileSync(recordPath, 'utf8'));
      if (revision.targetId !== args.targetId || revision.relativePath !== args.relativePath || revision.actorUserId !== authorization.actorUserId) fail('MANAGED_FILE_BACKUP', 'The revision belongs to another target, file or account.');
      replacement = revision.previous === null ? null : Buffer.from(revision.previous, 'base64');
      if (replacement && sha(replacement) !== revision.previousSha256) fail('MANAGED_FILE_BACKUP', 'The saved revision is corrupt.');
    }
    const revisionId = randomUUID();
    const backup = { targetId: args.targetId, relativePath: args.relativePath, actorUserId: authorization.actorUserId,
      rpcId: authorization.rpcId, operation: args.operation, previousVersion: existing?.version ?? 'absent',
      previous: existing?.bytes.toString('base64') ?? null, previousSha256: existing ? sha(existing.bytes) : null };
    writeFileSync(path.join(backupRoot, `${revisionId}.json`), `${JSON.stringify(backup)}\n`, { flag: 'wx', mode: 0o600 });
    // Stage beside the destination so link is atomic and never overwrites a
    // concurrent file. Retain the original before any replacement or removal.
    const staged = `/proc/self/fd/${handles[parts.length - 1]}/.forge-managed-${revisionId}`;
    const displaced = `${staged}.original`;
    let moved = false;
    try {
      if (replacement !== null) writeFileSync(staged, replacement, { flag: 'wx', mode: existing ? existing.info.mode & 0o666 : 0o644 });
      checkParents();
      if (existing) {
        if (!same(existing.info, lstatSync(target))) fail('MANAGED_FILE_STALE', 'File identity changed before saving.');
        renameSync(target, displaced); moved = true;
        const movedInfo = lstatSync(displaced);
        if (!movedInfo.isFile() || movedInfo.isSymbolicLink() || movedInfo.dev !== existing.info.dev || movedInfo.ino !== existing.info.ino
          || movedInfo.size !== existing.info.size || movedInfo.mtimeMs !== existing.info.mtimeMs || movedInfo.nlink !== 1) fail('MANAGED_FILE_STALE', 'A concurrent replacement was retained without overwriting it.');
      }
      if (replacement !== null) linkSync(staged, target);
      if (moved) { unlinkSync(displaced); moved = false; }
    } catch (error) {
      if (moved) {
        try { linkSync(displaced, target); unlinkSync(displaced); moved = false; }
        catch { error.recoveryPath = `.forge-managed-${revisionId}.original`; }
      }
      throw error;
    } finally { try { unlinkSync(staged); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    let version = 'absent';
    if (replacement !== null) { const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW); handles.push(fd); version = regular(fd).version; }
    return { targetId: args.targetId, relativePath: args.relativePath, operation: args.operation, version, revisionId, recoverable: true };
  } finally {
    if (lockOwned) { try { rmdirSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    for (const fd of handles.reverse()) closeSync(fd);
  }
}
