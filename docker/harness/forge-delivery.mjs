import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  sealForgeChangeContract,
  createForgeChangeContractBinding,
  verifyForgeChangeContractBinding,
  evaluateForgeChangeContractDrift,
} from './forge-change-contract.mjs';

export const DELIVERY_SCHEMA_VERSION = 1;
export const CHANGE_STATES = Object.freeze([
  'scoped',
  'designed',
  'implementing',
  'implemented',
  'verifying',
  'evidence-recorded',
]);

const STATE_TRANSITIONS = Object.freeze({
  scoped: ['designed'],
  designed: ['implementing'],
  implementing: ['implemented'],
  implemented: ['verifying'],
  verifying: ['evidence-recorded'],
  'evidence-recorded': [],
});
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/u;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_HASHED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS_PER_CATEGORY = 2048;
const MAX_DELIVERY_STATE_BYTES = 64 * 1024 * 1024;
const CHANGE_LOCK_LEASE_MS = 15 * 60 * 1000;
const SAFE_GIT_SUBCOMMANDS = Object.freeze(new Set([
  'check-ignore',
  'ls-files',
  'rev-parse',
  'status',
  'symbolic-ref',
]));
const RECORD_KINDS = Object.freeze({
  change: 'forge-delivery-change',
  handoff: 'forge-delivery-handoff',
  verification: 'forge-delivery-verification',
});

export class DeliveryError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'DeliveryError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function deliveryError(code, message, details) {
  return new DeliveryError(code, message, details);
}

function assertObject(value, code, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw deliveryError(code, `${label} must be a JSON object.`);
  }
}

function assertExactKeys(value, expected, code, label) {
  assertObject(value, code, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw deliveryError(code, `${label} has an unsupported or incomplete schema.`);
  }
}

function validateIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw deliveryError(
      'INVALID_IDENTIFIER',
      `${label} must match ${IDENTIFIER_PATTERN} and cannot contain path separators or traversal segments.`,
    );
  }
  return value;
}

function validateIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw deliveryError('INVALID_IDEMPOTENCY_KEY', 'The idempotency key must be 8-128 safe ASCII characters.');
  }
  return value;
}

function validateObjective(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 4096 || /\0/u.test(value)) {
    throw deliveryError('INVALID_OBJECTIVE', 'The change objective must contain 1-4096 characters and no NUL byte.');
  }
  return value.trim();
}

function validateExpectedVersion(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw deliveryError('INVALID_EXPECTED_VERSION', 'expectedVersion must be a positive safe integer.');
  }
  return parsed;
}

function validateTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw deliveryError('INVALID_TIMESTAMP', `${label} must be a canonical UTC timestamp.`);
  }
  try {
    if (new Date(value).toISOString() !== value) throw new Error('timestamp mismatch');
  } catch {
    throw deliveryError('INVALID_TIMESTAMP', `${label} must be a valid canonical UTC timestamp.`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function coreRecord(record) {
  const { integrityHash: _integrityHash, ...core } = record;
  return core;
}

function sealRecord(record) {
  return { ...record, integrityHash: sha256(canonicalJson(record)) };
}

function assertRecordIntegrity(record, code, label) {
  if (typeof record.integrityHash !== 'string' || !/^[0-9a-f]{64}$/u.test(record.integrityHash)) {
    throw deliveryError(code, `${label} has no valid integrity hash.`);
  }
  const actual = sha256(canonicalJson(coreRecord(record)));
  if (actual !== record.integrityHash) throw deliveryError(code, `${label} integrity verification failed.`);
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateRelativePath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || path.isAbsolute(value)) {
    throw deliveryError('INVALID_RELATIVE_PATH', `${label} must be a bounded repository-relative path.`);
  }
  const segments = value.split(/[\\/]/u);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/u.test(segment))) {
    throw deliveryError('INVALID_RELATIVE_PATH', `${label} contains an empty, traversal, or invalid path segment.`);
  }
  return segments.join('/');
}

async function readBoundedJson(filePath, label) {
  const backupPath = `${filePath}.replace-backup`;
  const [fileMetadata, backupMetadata] = await Promise.all([
    lstat(filePath).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error))),
    lstat(backupPath).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error))),
  ]);
  if (backupMetadata !== null) {
    if (!backupMetadata.isFile() || backupMetadata.isSymbolicLink() || backupMetadata.size > MAX_JSON_BYTES) {
      throw deliveryError('ATOMIC_RECOVERY_REQUIRED', `${label} has an unsafe replacement backup.`);
    }
    if (fileMetadata !== null) {
      throw deliveryError('ATOMIC_RECOVERY_REQUIRED', `${label} has both current and replacement-backup files; both were preserved.`);
    }
    await rename(backupPath, filePath);
  }
  const metadata = (fileMetadata ?? await lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') throw deliveryError('RECORD_NOT_FOUND', `${label} does not exist.`);
    throw error;
  }));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JSON_BYTES) {
    throw deliveryError('UNSAFE_RECORD', `${label} must be a regular bounded JSON file, not a link or special file.`);
  }
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw deliveryError('INVALID_RECORD_JSON', `${label} is not valid JSON.`);
  }
}

async function hashRegularFile(projectRoot, relativeValue, { allowDeliveryState = false } = {}) {
  const relativePath = validateRelativePath(relativeValue, 'file path');
  const first = relativePath.split('/')[0];
  if (first === '.git' || (!allowDeliveryState && first === '.forge-delivery')) {
    throw deliveryError('FORBIDDEN_EVIDENCE_PATH', 'Git internals and delivery state cannot be used as source evidence.');
  }
  const candidate = path.resolve(projectRoot, ...relativePath.split('/'));
  if (!isPathInside(projectRoot, candidate)) throw deliveryError('PATH_OUTSIDE_PROJECT', 'Evidence path escaped the project root.');
  const metadata = await lstat(candidate).catch((error) => {
    if (error.code === 'ENOENT') throw deliveryError('EVIDENCE_FILE_NOT_FOUND', `Evidence file ${relativePath} does not exist.`);
    throw error;
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_HASHED_FILE_BYTES) {
    throw deliveryError('UNSAFE_EVIDENCE_FILE', `${relativePath} must be a regular file no larger than 64 MiB.`);
  }
  const resolved = await realpath(candidate);
  if (resolved !== candidate || !isPathInside(projectRoot, resolved)) {
    throw deliveryError('UNSAFE_EVIDENCE_FILE', `${relativePath} resolves through a link or outside the project.`);
  }
  const digest = createHash('sha256');
  await new Promise((resolve, reject) => {
    const input = createReadStream(candidate);
    input.on('data', (chunk) => digest.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  const after = await lstat(candidate);
  if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || !after.isFile()) {
    throw deliveryError('EVIDENCE_CHANGED_DURING_READ', `${relativePath} changed while it was hashed.`);
  }
  return { path: relativePath, bytes: metadata.size, sha256: digest.digest('hex') };
}

function gitPathEnvironmentValue() {
  const entry = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH');
  return entry?.[1] ?? '';
}

async function validatedGitExecutable(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
  const resolved = await realpath(candidate).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (resolved === null) return null;
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
  if (process.platform !== 'win32') {
    try {
      await access(resolved, fsConstants.X_OK);
    } catch (error) {
      if (['EACCES', 'EPERM'].includes(error.code)) return null;
      throw error;
    }
  }
  return resolved;
}

async function windowsMachineGitCandidate() {
  if (process.platform !== 'win32') return null;
  const registryExecutable = 'C:\\Windows\\System32\\reg.exe';
  const validatedRegistry = await validatedGitExecutable(registryExecutable);
  if (validatedRegistry === null) return null;
  const result = await new Promise((resolve) => {
    const child = spawn(validatedRegistry, ['query', 'HKLM\\SOFTWARE\\GitForWindows', '/v', 'InstallPath'], {
      env: { SystemRoot: 'C:\\Windows', windir: 'C:\\Windows' },
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const chunks = [];
    let bytes = 0;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= 64 * 1024) chunks.push(chunk);
    });
    child.once('error', () => resolve(null));
    child.once('close', (exitCode) => resolve(exitCode === 0 && bytes <= 64 * 1024
      ? Buffer.concat(chunks).toString('utf8')
      : null));
  });
  if (result === null) return null;
  const match = /^\s*InstallPath\s+REG_[A-Z0-9_]+\s+(.+?)\s*$/imu.exec(result);
  if (match === null || !path.win32.isAbsolute(match[1])) return null;
  return validatedGitExecutable(path.win32.join(match[1], 'cmd', 'git.exe'));
}

let gitExecutablePromise;

async function resolveGitExecutable() {
  const osCandidates = process.platform === 'win32'
    ? [
      await windowsMachineGitCandidate(),
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    ]
    : process.platform === 'darwin'
      ? ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']
      : ['/usr/bin/git', '/bin/git', '/usr/local/bin/git'];
  for (const candidate of osCandidates) {
    if (candidate === null) continue;
    const validated = await validatedGitExecutable(candidate);
    if (validated !== null) return validated;
  }

  const executableName = process.platform === 'win32' ? 'git.exe' : 'git';
  for (const rawEntry of gitPathEnvironmentValue().split(path.delimiter)) {
    const directory = rawEntry.trim();
    if (directory.length === 0 || !path.isAbsolute(directory)) continue;
    const validated = await validatedGitExecutable(path.join(directory, executableName));
    if (validated !== null) return validated;
  }
  throw deliveryError('FIXED_COMMAND_UNAVAILABLE', 'No trusted or strictly resolved Git executable is available.');
}

function fixedGitExecutable() {
  gitExecutablePromise ??= resolveGitExecutable();
  return gitExecutablePromise;
}

function hardenedGitEnvironment() {
  const environment = {};
  const gitNullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase();
    if (normalized.startsWith('GIT_') || ['PAGER', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'].includes(normalized)) continue;
    environment[key] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: gitNullDevice,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: gitNullDevice,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: '',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function assertSafeGitInvocation(args) {
  let commandIndex = 0;
  while (['-C', '-c'].includes(args[commandIndex])) {
    if (typeof args[commandIndex + 1] !== 'string') {
      throw deliveryError('UNSAFE_FIXED_COMMAND', 'The requested Git operation has an incomplete fixed global option.');
    }
    commandIndex += 2;
  }
  if (!SAFE_GIT_SUBCOMMANDS.has(args[commandIndex])) {
    throw deliveryError('UNSAFE_FIXED_COMMAND', 'The requested Git operation is outside the read-only allowlist.');
  }
}

async function runGit(args, { cwd, allowExitCodes = [0] } = {}) {
  assertSafeGitInvocation(args);
  const gitExecutable = await fixedGitExecutable();
  return new Promise((resolve, reject) => {
    const hardenedArgs = [
      '--no-pager',
      '--no-optional-locks',
      '--no-replace-objects',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'core.pager=',
      '-c', 'credential.helper=',
      '-c', 'diff.external=',
      '-c', 'maintenance.auto=false',
      '-c', 'gc.auto=0',
      ...args,
    ];
    const child = spawn(gitExecutable, hardenedArgs, {
      cwd,
      env: hardenedGitEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) child.kill('SIGKILL');
      else target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => reject(deliveryError('FIXED_COMMAND_UNAVAILABLE', `Git is unavailable: ${error.message}`)));
    child.once('close', (exitCode) => {
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        reject(deliveryError('FIXED_COMMAND_OUTPUT_LIMIT', 'Git output exceeded the 4 MiB limit.'));
        return;
      }
      const result = {
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (!allowExitCodes.includes(result.exitCode)) {
        reject(deliveryError('FIXED_COMMAND_FAILED', `Git failed with exit code ${result.exitCode}.`));
      } else resolve(result);
    });
  });
}

export async function discoverProjectRoot(cwd = process.cwd()) {
  const current = await realpath(path.resolve(cwd));
  const result = await runGit(['-C', current, 'rev-parse', '--show-toplevel']);
  const root = await realpath(result.stdout.trim());
  if (!isPathInside(root, current)) throw deliveryError('PROJECT_ROOT_MISMATCH', 'Current directory is outside the discovered Git root.');
  return root;
}

async function currentCommit(projectRoot) {
  const result = await runGit(['-C', projectRoot, 'rev-parse', '--verify', 'HEAD']);
  const commit = result.stdout.trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) throw deliveryError('INVALID_GIT_COMMIT', 'Git returned an unsupported commit identifier.');
  return commit;
}

async function assertDeliveryStateIgnored(projectRoot) {
  const tracked = await runGit(['-C', projectRoot, 'ls-files', '-z', '--', '.forge-delivery']);
  if (tracked.stdout.length > 0) {
    throw deliveryError('DELIVERY_STATE_TRACKED', '.forge-delivery contains tracked files; delivery state must remain outside candidate commits.');
  }
  const ignored = await runGit(
    ['-C', projectRoot, 'check-ignore', '--verbose', '--no-index', '--', '.forge-delivery/'],
    { allowExitCodes: [0, 1] },
  );
  if (ignored.exitCode !== 0) {
    throw deliveryError(
      'DELIVERY_STATE_NOT_IGNORED',
      '.forge-delivery/ is not ignored. The reviewed project template or upgrade must register it before change init.',
    );
  }
  const match = /^(.*):(\d+):([^\t]*)\t\.forge-delivery\/?\r?\n?$/u.exec(ignored.stdout);
  const gitPath = await runGit(['-C', projectRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  const expectedExclude = path.resolve(gitPath.stdout.trim());
  const actualSource = match === null ? null : path.resolve(projectRoot, match[1]);
  if (actualSource !== expectedExclude) {
    throw deliveryError(
      'DELIVERY_STATE_NOT_PRIVATELY_IGNORED',
      '.forge-delivery/ must be registered by the platform in this clone private .git/info/exclude; repository or global ignore rules are insufficient.',
    );
  }
  const excludeMetadata = await lstat(expectedExclude).catch(() => null);
  if (excludeMetadata === null || !excludeMetadata.isFile() || excludeMetadata.isSymbolicLink()
    || await realpath(expectedExclude) !== expectedExclude) {
    throw deliveryError('UNSAFE_DELIVERY_EXCLUDE', 'The clone-private .git/info/exclude path is unsafe.');
  }
}

async function ensureSecureDirectory(directoryPath) {
  await mkdir(directoryPath, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const metadata = await lstat(directoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw deliveryError('UNSAFE_STATE_DIRECTORY', `${directoryPath} must be a real directory.`);
  }
  if (await realpath(directoryPath) !== directoryPath) {
    throw deliveryError('UNSAFE_STATE_DIRECTORY', `${directoryPath} cannot resolve through a symbolic link.`);
  }
  await chmod(directoryPath, 0o700).catch(() => {});
}

async function atomicWriteJson(filePath, value, { createOnly = false } = {}) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  const backupPath = `${filePath}.replace-backup`;
  let handle;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_JSON_BYTES) {
    throw deliveryError('DELIVERY_STATE_CAPACITY', `${path.basename(filePath)} exceeds the bounded record size.`);
  }
  try {
    const backupMetadata = await lstat(backupPath).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (backupMetadata !== null) {
      const currentMetadata = await lstat(filePath).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
      if (!backupMetadata.isFile() || backupMetadata.isSymbolicLink() || currentMetadata !== null) {
        throw deliveryError('ATOMIC_RECOVERY_REQUIRED', `${path.basename(filePath)} has an ambiguous replacement backup.`);
      }
      await rename(backupPath, filePath);
    }
    if (createOnly) {
      await lstat(filePath).then(() => {
        throw deliveryError('RECORD_ALREADY_EXISTS', `${path.basename(filePath)} already exists.`);
      }).catch((error) => {
        if (error instanceof DeliveryError) throw error;
        if (error.code !== 'ENOENT') throw error;
      });
    }
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.chmod(0o600).catch(() => {});
    await handle.close();
    handle = undefined;
    if (createOnly) {
      try {
        await link(temporaryPath, filePath);
        await unlink(temporaryPath);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw deliveryError('RECORD_ALREADY_EXISTS', `${path.basename(filePath)} already exists.`);
        }
        throw error;
      }
    } else try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      await lstat(backupPath).then(() => {
        throw deliveryError('ATOMIC_RECOVERY_REQUIRED', `${path.basename(filePath)} has an unresolved replacement backup.`);
      }).catch((backupError) => {
        if (backupError instanceof DeliveryError) throw backupError;
        if (backupError.code !== 'ENOENT') throw backupError;
      });
      await rename(filePath, backupPath);
      try {
        await rename(temporaryPath, filePath);
        await rm(backupPath, { force: true });
      } catch (replacementError) {
        await rename(backupPath, filePath).catch(() => {});
        throw replacementError;
      }
    }
    await chmod(filePath, 0o600).catch(() => {});
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function validateChangeRecord(record, expectedId) {
  assertExactKeys(record, [
    'schemaVersion', 'kind', 'changeId', 'objective', 'objectiveSha256', 'state', 'version',
    'baseCommit', 'createdAt', 'updatedAt', 'history', 'recordedEvidence', 'integrityHash',
  ], 'INVALID_CHANGE_RECORD', 'Change record');
  if (record.schemaVersion !== DELIVERY_SCHEMA_VERSION || record.kind !== RECORD_KINDS.change) {
    throw deliveryError('INVALID_CHANGE_RECORD', 'Unsupported change record schema or kind.');
  }
  assertRecordIntegrity(record, 'CHANGE_TAMPERED', 'Change record');
  validateIdentifier(record.changeId, 'changeId');
  if (record.changeId !== expectedId || !CHANGE_STATES.includes(record.state) || !Number.isSafeInteger(record.version) || record.version < 1) {
    throw deliveryError('INVALID_CHANGE_RECORD', 'Change identity, state, or version is invalid.');
  }
  if (validateObjective(record.objective) !== record.objective || sha256(record.objective) !== record.objectiveSha256) {
    throw deliveryError('INVALID_CHANGE_RECORD', 'Change objective hash is invalid.');
  }
  if (!COMMIT_PATTERN.test(record.baseCommit) || !Array.isArray(record.history) || record.history.length !== record.version) {
    throw deliveryError('INVALID_CHANGE_RECORD', 'Change history or base commit is invalid.');
  }
  validateTimestamp(record.createdAt, 'createdAt');
  validateTimestamp(record.updatedAt, 'updatedAt');
  let previousState = null;
  const seenIdempotencyKeys = new Set();
  for (let index = 0; index < record.history.length; index += 1) {
    const entry = record.history[index];
    assertExactKeys(entry, [
      'event', 'from', 'to', 'fromVersion', 'toVersion', 'idempotencyKey', 'requestHash', 'commit', 'at', 'evidence',
    ], 'INVALID_CHANGE_RECORD', 'Change history entry');
    if (!['init', 'transition'].includes(entry.event) || !CHANGE_STATES.includes(entry.to)
      || !Number.isSafeInteger(entry.fromVersion) || !Number.isSafeInteger(entry.toVersion)
      || entry.fromVersion !== index || entry.toVersion !== index + 1 || !COMMIT_PATTERN.test(entry.commit)
      || !/^[0-9a-f]{64}$/u.test(entry.requestHash) || !Array.isArray(entry.evidence)) {
      throw deliveryError('INVALID_CHANGE_RECORD', 'Change history sequence or binding is invalid.');
    }
    validateIdempotencyKey(entry.idempotencyKey);
    validateTimestamp(entry.at, 'history.at');
    if (seenIdempotencyKeys.has(entry.idempotencyKey)) {
      throw deliveryError('INVALID_CHANGE_RECORD', 'Change history contains a duplicate idempotency key.');
    }
    seenIdempotencyKeys.add(entry.idempotencyKey);
    if (index === 0) {
      if (entry.event !== 'init' || entry.from !== null || entry.to !== 'scoped' || entry.commit !== record.baseCommit) {
        throw deliveryError('INVALID_CHANGE_RECORD', 'Change init history is invalid.');
      }
    } else if (entry.event !== 'transition' || entry.from !== previousState || !STATE_TRANSITIONS[entry.from]?.includes(entry.to)) {
      throw deliveryError('INVALID_CHANGE_RECORD', 'Change transition history is invalid.');
    }
    for (const evidence of entry.evidence) {
      assertExactKeys(evidence, ['verificationId', 'integrityHash'], 'INVALID_CHANGE_RECORD', 'Transition evidence');
      validateIdentifier(evidence.verificationId, 'verificationId');
      if (!/^[0-9a-f]{64}$/u.test(evidence.integrityHash)) {
        throw deliveryError('INVALID_CHANGE_RECORD', 'Transition evidence hash is invalid.');
      }
    }
    if ((entry.to === 'evidence-recorded') !== (entry.evidence.length > 0)) {
      throw deliveryError('INVALID_CHANGE_RECORD', 'Only the evidence-recorded transition can contain self-recorded evidence, and it must contain evidence.');
    }
    previousState = entry.to;
  }
  const finalEntry = record.history.at(-1);
  if (previousState !== record.state || record.createdAt !== record.history[0].at || record.updatedAt !== finalEntry.at) {
    throw deliveryError('INVALID_CHANGE_RECORD', 'Change summary does not match its history.');
  }
  if (record.state === 'evidence-recorded') {
    assertExactKeys(record.recordedEvidence, ['commit', 'at', 'records'], 'INVALID_CHANGE_RECORD', 'recordedEvidence');
    if (record.recordedEvidence.commit !== finalEntry.commit || record.recordedEvidence.at !== finalEntry.at
      || canonicalJson(record.recordedEvidence.records) !== canonicalJson(finalEntry.evidence)) {
      throw deliveryError('INVALID_CHANGE_RECORD', 'recordedEvidence does not match the evidence-recorded transition.');
    }
  } else if (record.recordedEvidence !== null) {
    throw deliveryError('INVALID_CHANGE_RECORD', 'Changes before evidence-recorded cannot contain recordedEvidence.');
  }
  return record;
}

function validateHandoffRecord(record, expectedId) {
  assertExactKeys(record, [
    'schemaVersion', 'kind', 'handoffId', 'changeId', 'changeVersion', 'changeState', 'commit',
    'sources', 'requestHash', 'createdAt', 'integrityHash',
  ], 'INVALID_HANDOFF_RECORD', 'Handoff record');
  if (record.schemaVersion !== DELIVERY_SCHEMA_VERSION || record.kind !== RECORD_KINDS.handoff) {
    throw deliveryError('INVALID_HANDOFF_RECORD', 'Unsupported handoff record schema or kind.');
  }
  assertRecordIntegrity(record, 'HANDOFF_TAMPERED', 'Handoff record');
  validateIdentifier(record.handoffId, 'handoffId');
  validateIdentifier(record.changeId, 'changeId');
  if (record.handoffId !== expectedId || !Number.isSafeInteger(record.changeVersion) || record.changeVersion < 1
    || !CHANGE_STATES.includes(record.changeState) || !COMMIT_PATTERN.test(record.commit) || !Array.isArray(record.sources)
    || record.sources.length < 1 || record.sources.length > 64 || !/^[0-9a-f]{64}$/u.test(record.requestHash)) {
    throw deliveryError('INVALID_HANDOFF_RECORD', 'Handoff binding fields are invalid.');
  }
  for (const source of record.sources) {
    assertExactKeys(source, ['path', 'bytes', 'sha256'], 'INVALID_HANDOFF_RECORD', 'Handoff source');
    validateRelativePath(source.path, 'handoff source');
    if (!Number.isSafeInteger(source.bytes) || source.bytes < 0 || !/^[0-9a-f]{64}$/u.test(source.sha256)) {
      throw deliveryError('INVALID_HANDOFF_RECORD', 'Handoff source metadata is invalid.');
    }
  }
  validateTimestamp(record.createdAt, 'handoff.createdAt');
  const sortedSources = [...record.sources].sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalJson(sortedSources) !== canonicalJson(record.sources)
    || new Set(record.sources.map((source) => source.path)).size !== record.sources.length
    || record.requestHash !== sha256(canonicalJson({
      changeId: record.changeId,
      changeVersion: record.changeVersion,
      changeState: record.changeState,
      commit: record.commit,
      sources: record.sources,
    }))) {
    throw deliveryError('INVALID_HANDOFF_RECORD', 'Handoff source order, uniqueness, or request hash is invalid.');
  }
  return record;
}

function validateVerificationRecord(record, expectedId) {
  assertExactKeys(record, [
    'schemaVersion', 'kind', 'verificationId', 'changeId', 'changeVersion', 'changeState', 'commit',
    'argv', 'exitCode', 'log', 'authority', 'requestHash', 'recordedAt', 'integrityHash',
  ], 'INVALID_VERIFICATION_RECORD', 'Verification record');
  if (record.schemaVersion !== DELIVERY_SCHEMA_VERSION || record.kind !== RECORD_KINDS.verification) {
    throw deliveryError('INVALID_VERIFICATION_RECORD', 'Unsupported verification record schema or kind.');
  }
  assertRecordIntegrity(record, 'VERIFICATION_TAMPERED', 'Verification record');
  validateIdentifier(record.verificationId, 'verificationId');
  validateIdentifier(record.changeId, 'changeId');
  if (record.verificationId !== expectedId || record.changeState !== 'verifying'
    || !Number.isSafeInteger(record.changeVersion) || record.changeVersion < 1 || !COMMIT_PATTERN.test(record.commit)
    || !Array.isArray(record.argv) || !Number.isSafeInteger(record.exitCode)
    || record.authority !== 'self-recorded-local' || !/^[0-9a-f]{64}$/u.test(record.requestHash)) {
    throw deliveryError('INVALID_VERIFICATION_RECORD', 'Verification binding fields are invalid.');
  }
  validateArgv(record.argv);
  assertExactKeys(record.log, ['path', 'bytes', 'sha256'], 'INVALID_VERIFICATION_RECORD', 'Verification log');
  validateRelativePath(record.log.path, 'verification log');
  if (!Number.isSafeInteger(record.log.bytes) || record.log.bytes < 1 || !/^[0-9a-f]{64}$/u.test(record.log.sha256)) {
    throw deliveryError('INVALID_VERIFICATION_RECORD', 'Verification log metadata is invalid.');
  }
  validateTimestamp(record.recordedAt, 'verification.recordedAt');
  if (record.requestHash !== sha256(canonicalJson({
    changeId: record.changeId,
    changeVersion: record.changeVersion,
    changeState: record.changeState,
    commit: record.commit,
    argv: record.argv,
    exitCode: record.exitCode,
    log: record.log,
  }))) {
    throw deliveryError('INVALID_VERIFICATION_RECORD', 'Verification request hash is invalid.');
  }
  return record;
}

function validateArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64) {
    throw deliveryError('INVALID_VERIFICATION_ARGV', 'argv must be a JSON array with 1-64 entries.');
  }
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length < 1 || argument.length > 1024 || /[\0\r\n]/u.test(argument)) {
      throw deliveryError('INVALID_VERIFICATION_ARGV', 'argv entries must be bounded single-line strings.');
    }
  }
  const secretOption = /^(?:--?|\/)(?:password|passwd|api[-_]?key|authorization|cookie|private[-_]?key|access[-_]?token|refresh[-_]?token)(?:=|:|$)/iu;
  const secretHeader = /^(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*\S+/iu;
  const compactPassword = /^(?:-p[^\s-].*|\/p:\S+)/u;
  const authScheme = /^(?:bearer|basic)\s+\S+/iu;
  if (argv.some((argument) => secretOption.test(argument))
    || argv.some((argument) => secretHeader.test(argument) || compactPassword.test(argument) || authScheme.test(argument))
    || argv.some((argument) => /:\/\/[^/\s:@]+:[^/\s@]+@/u.test(argument))) {
    throw deliveryError('SECRET_LIKE_ARGV', 'Verification argv appears to contain or request secret-bearing values.');
  }
  return argv;
}

function classifyWorktreePath(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/').toLowerCase();
  if (normalized === '.forge-delivery' || normalized.startsWith('.forge-delivery/')) return 'delivery-state';
  if (/(^|\/)(db\/migration|migrations?|flyway)(\/|$)/u.test(normalized) || normalized.endsWith('.sql')) return 'migration';
  if (/(^|\/)(tests?|__tests__)(\/|$)/u.test(normalized) || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(normalized)) return 'test';
  if (normalized.startsWith('docs/') || /\.(md|mdx|adoc|rst)$/u.test(normalized)) return 'documentation';
  if (/(^|\/)(config|ops)(\/|$)/u.test(normalized) || /\.(ya?ml|toml|properties|env)$/u.test(normalized)) return 'configuration';
  return 'source';
}

function parsePorcelainStatus(output) {
  const chunks = output.split('\0');
  if (chunks.at(-1) === '') chunks.pop();
  const entries = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const raw = chunks[index];
    if (raw.length < 4 || raw[2] !== ' ') throw deliveryError('INVALID_GIT_STATUS', 'Git returned malformed porcelain status.');
    const code = raw.slice(0, 2);
    const relativePath = validateRelativePath(raw.slice(3), 'Git status path');
    let originalPath;
    if (/[RC]/u.test(code)) {
      index += 1;
      if (index >= chunks.length) throw deliveryError('INVALID_GIT_STATUS', 'Git rename status is incomplete.');
      originalPath = validateRelativePath(chunks[index], 'Git original path');
    }
    const conflicted = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(code);
    entries.push({
      path: relativePath,
      ...(originalPath === undefined ? {} : { originalPath }),
      code,
      staged: code[0] !== ' ' && code[0] !== '?' && code[0] !== '!',
      unstaged: code[1] !== ' ' && code[1] !== '?' && code[1] !== '!',
      untracked: code === '??',
      conflicted,
      category: classifyWorktreePath(relativePath),
    });
  }
  return entries;
}

export class ForgeDeliveryStore {
  constructor(projectRoot, { now = () => new Date().toISOString() } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.stateRoot = path.join(this.projectRoot, '.forge-delivery');
    this.now = now;
  }

  recordPath(category, identifier) {
    validateIdentifier(identifier, `${category} identifier`);
    return path.join(this.stateRoot, category, `${identifier}.json`);
  }

  async ensureWritableState() {
    for (const directory of [
      this.stateRoot,
      path.join(this.stateRoot, 'changes'),
      path.join(this.stateRoot, 'handoffs'),
      path.join(this.stateRoot, 'contracts'),
      path.join(this.stateRoot, 'verifications'),
      path.join(this.stateRoot, 'locks'),
    ]) await ensureSecureDirectory(directory);
  }

  async assertStateCapacity(category, value, { replacingPath } = {}) {
    const categories = ['changes', 'handoffs', 'verifications', 'contracts'];
    if (!categories.includes(category)) throw deliveryError('INVALID_STATE_CATEGORY', 'Delivery state category is invalid.');
    let totalBytes = 0;
    let categoryCount = 0;
    for (const candidate of categories) {
      const directory = path.join(this.stateRoot, candidate);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const recordPath = path.join(directory, entry.name);
        if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json')) {
          throw deliveryError('UNSAFE_STATE_DIRECTORY', `${candidate} contains a non-record entry.`);
        }
        const metadata = await lstat(recordPath);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_JSON_BYTES) {
          throw deliveryError('UNSAFE_STATE_DIRECTORY', `${candidate} contains an unsafe or oversized record.`);
        }
        if (candidate === category) categoryCount += 1;
        if (recordPath !== replacingPath) totalBytes += metadata.size;
      }
    }
    if (!replacingPath && categoryCount >= MAX_RECORDS_PER_CATEGORY) {
      throw deliveryError('DELIVERY_STATE_CAPACITY', `${category} reached its ${MAX_RECORDS_PER_CATEGORY}-record retention bound.`);
    }
    const newBytes = Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    if (newBytes > MAX_JSON_BYTES || totalBytes + newBytes > MAX_DELIVERY_STATE_BYTES) {
      throw deliveryError('DELIVERY_STATE_CAPACITY', 'Delivery records reached their bounded local capacity; archive them through a reviewed project workflow before retrying.');
    }
  }

  async assertReadableStateDirectory(category) {
    const stateMetadata = await lstat(this.stateRoot).catch((error) => {
      if (error.code === 'ENOENT') throw deliveryError('DELIVERY_STATE_NOT_INITIALIZED', 'No .forge-delivery state exists in this project.');
      throw error;
    });
    if (!stateMetadata.isDirectory() || stateMetadata.isSymbolicLink() || await realpath(this.stateRoot) !== this.stateRoot) {
      throw deliveryError('UNSAFE_STATE_DIRECTORY', '.forge-delivery must be a real project-local directory.');
    }
    const directory = path.join(this.stateRoot, category);
    const metadata = await lstat(directory).catch((error) => {
      if (error.code === 'ENOENT') throw deliveryError('RECORD_NOT_FOUND', `No ${category} records exist.`);
      throw error;
    });
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory) {
      throw deliveryError('UNSAFE_STATE_DIRECTORY', `${category} state directory is unsafe.`);
    }
  }

  async withChangeLock(changeId, operation) {
    validateIdentifier(changeId, 'changeId');
    await assertDeliveryStateIgnored(this.projectRoot);
    await this.ensureWritableState();
    // All mutations share one lock so category-capacity scans and their writes
    // form one cross-process transaction, including operations on other changes.
    const lockPath = path.join(this.stateRoot, 'locks', 'global-state.lock');
    const nonce = randomUUID();
    let handle;
    const acquire = async () => {
      try {
        handle = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = await readBoundedJson(lockPath, 'Change lock').catch(() => null);
        const lockMetadata = await lstat(lockPath);
        let sameHostDead = false;
        if (owner?.hostname === os.hostname() && Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
            throw deliveryError('CHANGE_LOCKED', 'Forge delivery state is already being updated.');
          } catch (processError) {
            if (processError instanceof DeliveryError) throw processError;
            if (processError.code === 'ESRCH') sameHostDead = true;
            else throw deliveryError('CHANGE_LOCKED', 'Forge delivery state owner cannot be proven dead.');
          }
        }
        const nowMs = Date.parse(this.now());
        const ownerMs = Date.parse(owner?.at ?? '');
        const lockMs = Number.isFinite(ownerMs) ? ownerMs : lockMetadata.mtimeMs;
        if (!sameHostDead) {
          if (!Number.isFinite(nowMs) || nowMs - lockMs < CHANGE_LOCK_LEASE_MS) {
            throw deliveryError('CHANGE_LOCKED', 'Forge delivery state is already being updated.');
          }
          if (owner?.hostname !== os.hostname()) {
            throw deliveryError(
              'STALE_CHANGE_LOCK_REVIEW_REQUIRED',
              'An expired lock from another host cannot be auto-reclaimed without a fencing authority.',
            );
          }
        }
        await unlink(lockPath);
        handle = await open(lockPath, 'wx', 0o600);
      }
      await handle.writeFile(`${JSON.stringify({
        schemaVersion: 1, pid: process.pid, hostname: os.hostname(), changeId, nonce, at: this.now(),
      })}\n`);
      await handle.sync();
      await handle.close();
      handle = undefined;
    };
    await acquire();
    try {
      return await operation();
    } finally {
      if (handle !== undefined) await handle.close().catch(() => {});
      const owner = await readBoundedJson(lockPath, 'Change lock').catch(() => null);
      if (owner?.nonce === nonce) await unlink(lockPath).catch(() => {});
    }
  }

  async readChange(changeId) {
    validateIdentifier(changeId, 'changeId');
    await this.assertReadableStateDirectory('changes');
    return validateChangeRecord(await readBoundedJson(this.recordPath('changes', changeId), 'Change record'), changeId);
  }

  async initChange({ changeId, objective, idempotencyKey }) {
    validateIdentifier(changeId, 'changeId');
    const normalizedObjective = validateObjective(objective);
    validateIdempotencyKey(idempotencyKey);
    return this.withChangeLock(changeId, async () => {
      const commit = await currentCommit(this.projectRoot);
      const requestHash = sha256(canonicalJson({ action: 'change.init', changeId, objective: normalizedObjective }));
      const recordPath = this.recordPath('changes', changeId);
      const existing = await readBoundedJson(recordPath, 'Change record').catch((error) => {
        if (error.code === 'RECORD_NOT_FOUND') return null;
        throw error;
      });
      if (existing !== null) {
        const change = validateChangeRecord(existing, changeId);
        const first = change.history[0];
        if (first?.idempotencyKey === idempotencyKey && first?.requestHash === requestHash) {
          return { idempotent: true, change };
        }
        if (first?.idempotencyKey === idempotencyKey) {
          throw deliveryError('IDEMPOTENCY_CONFLICT', 'The init idempotency key was reused with a different objective.');
        }
        throw deliveryError('CHANGE_ALREADY_EXISTS', `Change ${changeId} already exists.`);
      }
      const at = this.now();
      const change = sealRecord({
        schemaVersion: DELIVERY_SCHEMA_VERSION,
        kind: RECORD_KINDS.change,
        changeId,
        objective: normalizedObjective,
        objectiveSha256: sha256(normalizedObjective),
        state: 'scoped',
        version: 1,
        baseCommit: commit,
        createdAt: at,
        updatedAt: at,
        history: [{
          event: 'init', from: null, to: 'scoped', fromVersion: 0, toVersion: 1,
          idempotencyKey, requestHash, commit, at, evidence: [],
        }],
        recordedEvidence: null,
      });
      validateChangeRecord(change, changeId);
      await this.assertStateCapacity('changes', change);
      await atomicWriteJson(recordPath, change, { createOnly: true });
      return { idempotent: false, change };
    });
  }

  async statusChange(changeId) {
    return { change: await this.readChange(changeId) };
  }

  async transitionChange({ changeId, to, expectedVersion, idempotencyKey, verificationIds = [] }) {
    validateIdentifier(changeId, 'changeId');
    if (!CHANGE_STATES.includes(to)) throw deliveryError('INVALID_CHANGE_STATE', `Unsupported target state: ${to}.`);
    const expected = validateExpectedVersion(expectedVersion);
    validateIdempotencyKey(idempotencyKey);
    const evidenceIds = [...new Set(verificationIds.map((value) => validateIdentifier(value, 'verificationId')))].sort();
    return this.withChangeLock(changeId, async () => {
      const change = await this.readChange(changeId);
      const requestHash = sha256(canonicalJson({
        action: 'change.transition', changeId, to, expectedVersion: expected, verificationIds: evidenceIds,
      }));
      const replay = change.history.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (replay !== undefined) {
        if (replay.requestHash !== requestHash) {
          throw deliveryError('IDEMPOTENCY_CONFLICT', 'The transition idempotency key was reused with a different request.');
        }
        return { idempotent: true, change };
      }
      if (change.version !== expected) {
        throw deliveryError('VERSION_CONFLICT', `Expected change version ${expected}, but current version is ${change.version}.`, {
          expectedVersion: expected,
          currentVersion: change.version,
        });
      }
      if (!STATE_TRANSITIONS[change.state].includes(to)) {
        throw deliveryError('ILLEGAL_STATE_TRANSITION', `Change cannot transition from ${change.state} to ${to}.`);
      }
      const commit = await currentCommit(this.projectRoot);
      let evidence = [];
      if (to === 'evidence-recorded') {
        if (evidenceIds.length < 1) {
          throw deliveryError('VERIFICATION_EVIDENCE_REQUIRED', 'Transition to evidence-recorded requires at least one structured self-recorded verification artifact.');
        }
        evidence = await Promise.all(evidenceIds.map(async (verificationId) => {
          const checked = await this.checkVerification(verificationId, { expectedChangeVersion: change.version });
          if (!checked.recordedExitCodeZero) throw deliveryError('VERIFICATION_FAILED', `Verification ${verificationId} recorded a non-zero exit code.`);
          return { verificationId, integrityHash: checked.record.integrityHash };
        }));
      } else if (evidenceIds.length > 0) {
        throw deliveryError('UNEXPECTED_VERIFICATION_EVIDENCE', 'Verification records are accepted only for transition to evidence-recorded.');
      }
      const at = this.now();
      const nextVersion = change.version + 1;
      const next = sealRecord({
        ...coreRecord(change),
        state: to,
        version: nextVersion,
        updatedAt: at,
        history: [...change.history, {
          event: 'transition', from: change.state, to, fromVersion: change.version, toVersion: nextVersion,
          idempotencyKey, requestHash, commit, at, evidence,
        }],
        recordedEvidence: to === 'evidence-recorded' ? { commit, at, records: evidence } : change.recordedEvidence,
      });
      validateChangeRecord(next, changeId);
      const changePath = this.recordPath('changes', changeId);
      await this.assertStateCapacity('changes', next, { replacingPath: changePath });
      await atomicWriteJson(changePath, next);
      return { idempotent: false, change: next };
    });
  }

  async createHandoff({ handoffId, changeId, sourcePaths }) {
    validateIdentifier(handoffId, 'handoffId');
    validateIdentifier(changeId, 'changeId');
    if (!Array.isArray(sourcePaths) || sourcePaths.length < 1 || sourcePaths.length > 64) {
      throw deliveryError('INVALID_HANDOFF_SOURCES', 'Handoff create requires 1-64 source files.');
    }
    return this.withChangeLock(changeId, async () => {
      const change = await this.readChange(changeId);
      const commit = await currentCommit(this.projectRoot);
      const normalizedSourcePaths = [...new Set(sourcePaths.map((value) => validateRelativePath(value, 'handoff source')))];
      const sources = await Promise.all(normalizedSourcePaths.map((value) => hashRegularFile(this.projectRoot, value)));
      sources.sort((left, right) => left.path.localeCompare(right.path));
      const requestHash = sha256(canonicalJson({ changeId, changeVersion: change.version, changeState: change.state, commit, sources }));
      const recordPath = this.recordPath('handoffs', handoffId);
      const existing = await readBoundedJson(recordPath, 'Handoff record').catch((error) => {
        if (error.code === 'RECORD_NOT_FOUND') return null;
        throw error;
      });
      if (existing !== null) {
        const handoff = validateHandoffRecord(existing, handoffId);
        if (handoff.requestHash === requestHash) return { idempotent: true, handoff };
        throw deliveryError('HANDOFF_ALREADY_EXISTS', `Handoff ${handoffId} already exists with different bindings.`);
      }
      const handoff = sealRecord({
        schemaVersion: DELIVERY_SCHEMA_VERSION,
        kind: RECORD_KINDS.handoff,
        handoffId,
        changeId,
        changeVersion: change.version,
        changeState: change.state,
        commit,
        sources,
        requestHash,
        createdAt: this.now(),
      });
      validateHandoffRecord(handoff, handoffId);
      await this.assertStateCapacity('handoffs', handoff);
      await atomicWriteJson(recordPath, handoff, { createOnly: true });
      return { idempotent: false, handoff };
    });
  }

  async readHandoff(handoffId) {
    validateIdentifier(handoffId, 'handoffId');
    await this.assertReadableStateDirectory('handoffs');
    return validateHandoffRecord(await readBoundedJson(this.recordPath('handoffs', handoffId), 'Handoff record'), handoffId);
  }

  async verifyHandoff(handoffId) {
    const handoff = await this.readHandoff(handoffId);
    const change = await this.readChange(handoff.changeId);
    if (change.version !== handoff.changeVersion || change.state !== handoff.changeState) {
      throw deliveryError('STALE_HANDOFF_STATE', `Handoff ${handoffId} is bound to change version ${handoff.changeVersion}/${handoff.changeState}.`);
    }
    const commit = await currentCommit(this.projectRoot);
    if (commit !== handoff.commit) throw deliveryError('STALE_HANDOFF_COMMIT', `Handoff ${handoffId} is bound to a different commit.`);
    for (const expected of handoff.sources) {
      const actual = await hashRegularFile(this.projectRoot, expected.path);
      if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        throw deliveryError('HANDOFF_SOURCE_TAMPERED', `Handoff source ${expected.path} no longer matches its recorded hash.`);
      }
    }
    return { recordIntegrityValid: true, handoff };
  }

  async inspectContract(sourcePath) {
    const source = await hashRegularFile(this.projectRoot, sourcePath);
    if (source.bytes > MAX_JSON_BYTES) throw deliveryError('CONTRACT_TOO_LARGE', 'Contract input exceeds 2 MiB.');
    const bytes = await readFile(path.join(this.projectRoot, source.path));
    if (sha256(bytes) !== source.sha256) throw deliveryError('EVIDENCE_CHANGED_DURING_READ', 'Contract source changed during read.');
    let input;
    try { input = JSON.parse(bytes.toString('utf8')); }
    catch { throw deliveryError('INVALID_CONTRACT_JSON', 'Contract source must be valid JSON.'); }
    assertExactKeys(input, ['schemaVersion', 'contractType', 'contractId', 'projectSlug', 'revision', 'what', 'how', 'tasks'], 'INVALID_CONTRACT_INPUT', 'Contract input');
    const head = await currentCommit(this.projectRoot);
    try {
      // Source identity is computed by the CLI, never copied from caller claims.
      // Normalize collections before hashing so formatting/order do not drift.
      const initial = sealForgeChangeContract({ ...input, source: { head, fingerprint: `sha256:${'0'.repeat(64)}` } });
      const { source: _source, integrity: _integrity, layerDigests: _layers, ...normalized } = initial;
      const fingerprint = `sha256:${sha256(canonicalJson(normalized))}`;
      return { sourcePath: source.path, contract: sealForgeChangeContract({ ...normalized, source: { head, fingerprint } }), executionProved: false };
    } catch (error) { throw deliveryError(error.code ?? 'INVALID_CONTRACT_INPUT', error.message); }
  }

  validateContractRecord(record, bindingId) {
    assertExactKeys(record, ['schemaVersion', 'kind', 'bindingId', 'sourcePath', 'contract', 'binding', 'createdAt', 'integrityHash'], 'INVALID_CONTRACT_RECORD', 'Contract binding record');
    if (record.schemaVersion !== 1 || record.kind !== 'forge-delivery-contract-binding' || record.bindingId !== bindingId) {
      throw deliveryError('INVALID_CONTRACT_RECORD', 'Contract binding identity or schema is invalid.');
    }
    validateRelativePath(record.sourcePath, 'Contract source');
    validateTimestamp(record.createdAt, 'Contract binding createdAt');
    assertRecordIntegrity(record, 'INVALID_CONTRACT_RECORD', 'Contract binding');
    try {
      if (record.binding.bindingId !== bindingId || !verifyForgeChangeContractBinding(record.contract, record.binding).valid) throw new Error('Baseline binding mismatch.');
    } catch { throw deliveryError('INVALID_CONTRACT_RECORD', 'Stored contract or downstream binding is invalid.'); }
    return record;
  }

  async bindContract({ sourcePath, bindingId, purpose }) {
    validateIdentifier(bindingId, 'bindingId');
    if (!['implementation', 'review', 'verification'].includes(purpose)) throw deliveryError('INVALID_CONTRACT_PURPOSE', 'Unknown downstream binding purpose.');
    return this.withChangeLock(bindingId, async () => {
      const current = await this.inspectContract(sourcePath);
      const binding = createForgeChangeContractBinding(current.contract, { bindingId, purpose });
      const file = this.recordPath('contracts', bindingId);
      const existing = await readBoundedJson(file, 'Contract binding').catch(error => { if (error.code === 'RECORD_NOT_FOUND') return null; throw error; });
      if (existing !== null) {
        const record = this.validateContractRecord(existing, bindingId);
        if (record.sourcePath !== current.sourcePath || canonicalJson(record.binding) !== canonicalJson(binding)) throw deliveryError('CONTRACT_BINDING_ALREADY_EXISTS', 'Existing binding has different source or contract; preserve it and use a new ID.');
        return { idempotent: true, record, executionProved: false };
      }
      const record = sealRecord({ schemaVersion: 1, kind: 'forge-delivery-contract-binding', bindingId,
        sourcePath: current.sourcePath, contract: current.contract, binding, createdAt: this.now() });
      this.validateContractRecord(record, bindingId);
      await this.assertStateCapacity('contracts', record);
      await atomicWriteJson(file, record, { createOnly: true });
      return { idempotent: false, record, executionProved: false };
    });
  }

  async verifyContract({ sourcePath, bindingId }) {
    validateIdentifier(bindingId, 'bindingId');
    await this.assertReadableStateDirectory('contracts');
    const record = this.validateContractRecord(await readBoundedJson(this.recordPath('contracts', bindingId), 'Contract binding'), bindingId);
    const current = await this.inspectContract(sourcePath);
    if (record.sourcePath !== current.sourcePath) throw deliveryError('CONTRACT_SOURCE_MISMATCH', 'Binding belongs to a different source path.');
    const drift = evaluateForgeChangeContractDrift(record.contract, current.contract);
    const verification = verifyForgeChangeContractBinding(current.contract, record.binding);
    if (!verification.valid) throw deliveryError('STALE_CONTRACT_BINDING', 'Contract changed; preserve old binding and regenerate downstream work before continuing.', { drift, verification, executionProved: false });
    return { recordIntegrityValid: true, drift, verification, record, executionProved: false };
  }

  async recordVerification({ verificationId, changeId, argv, exitCode, logPath }) {
    validateIdentifier(verificationId, 'verificationId');
    validateIdentifier(changeId, 'changeId');
    validateArgv(argv);
    const normalizedExitCode = Number(exitCode);
    if (!Number.isSafeInteger(normalizedExitCode) || normalizedExitCode < 0 || normalizedExitCode > 255) {
      throw deliveryError('INVALID_EXIT_CODE', 'Verification exit code must be an integer from 0 through 255.');
    }
    return this.withChangeLock(changeId, async () => {
      const change = await this.readChange(changeId);
      if (change.state !== 'verifying') {
        throw deliveryError('CHANGE_NOT_VERIFYING', 'Verification records can be created only while the change is in verifying state.');
      }
      const commit = await currentCommit(this.projectRoot);
      const log = await hashRegularFile(this.projectRoot, logPath, { allowDeliveryState: true });
      if (log.bytes < 1) throw deliveryError('EMPTY_VERIFICATION_LOG', 'A verification log must be non-empty.');
      const requestHash = sha256(canonicalJson({
        changeId, changeVersion: change.version, changeState: change.state, commit, argv, exitCode: normalizedExitCode, log,
      }));
      const recordPath = this.recordPath('verifications', verificationId);
      const existing = await readBoundedJson(recordPath, 'Verification record').catch((error) => {
        if (error.code === 'RECORD_NOT_FOUND') return null;
        throw error;
      });
      if (existing !== null) {
        const record = validateVerificationRecord(existing, verificationId);
        if (record.requestHash === requestHash) return {
          idempotent: true,
          recordedExitCodeZero: record.exitCode === 0,
          executionProven: false,
          verificationProven: false,
          record,
        };
        throw deliveryError('VERIFICATION_ALREADY_EXISTS', `Verification ${verificationId} already exists with different bindings.`);
      }
      const record = sealRecord({
        schemaVersion: DELIVERY_SCHEMA_VERSION,
        kind: RECORD_KINDS.verification,
        verificationId,
        changeId,
        changeVersion: change.version,
        changeState: change.state,
        commit,
        argv: [...argv],
        exitCode: normalizedExitCode,
        log,
        authority: 'self-recorded-local',
        requestHash,
        recordedAt: this.now(),
      });
      validateVerificationRecord(record, verificationId);
      await this.assertStateCapacity('verifications', record);
      await atomicWriteJson(recordPath, record, { createOnly: true });
      return {
        idempotent: false,
        recordedExitCodeZero: record.exitCode === 0,
        executionProven: false,
        verificationProven: false,
        record,
      };
    });
  }

  async readVerification(verificationId) {
    validateIdentifier(verificationId, 'verificationId');
    await this.assertReadableStateDirectory('verifications');
    return validateVerificationRecord(
      await readBoundedJson(this.recordPath('verifications', verificationId), 'Verification record'),
      verificationId,
    );
  }

  async checkVerification(verificationId, { expectedChangeVersion } = {}) {
    const record = await this.readVerification(verificationId);
    const change = await this.readChange(record.changeId);
    const commit = await currentCommit(this.projectRoot);
    if (commit !== record.commit) throw deliveryError('STALE_VERIFICATION_COMMIT', `Verification ${verificationId} is bound to another commit.`);
    const actualLog = await hashRegularFile(this.projectRoot, record.log.path, { allowDeliveryState: true });
    if (actualLog.bytes !== record.log.bytes || actualLog.sha256 !== record.log.sha256) {
      throw deliveryError('VERIFICATION_LOG_TAMPERED', `Verification log ${record.log.path} no longer matches its recorded hash.`);
    }
    if (expectedChangeVersion !== undefined && record.changeVersion !== expectedChangeVersion) {
      throw deliveryError('STALE_VERIFICATION_STATE', `Verification ${verificationId} is not bound to expected change version ${expectedChangeVersion}.`);
    }
    const consumed = change.recordedEvidence?.commit === record.commit
      && Array.isArray(change.recordedEvidence?.records)
      && change.recordedEvidence.records.some((entry) => (
        entry.verificationId === verificationId && entry.integrityHash === record.integrityHash
      ));
    if (change.version !== record.changeVersion && !consumed) {
      throw deliveryError('STALE_VERIFICATION_STATE', `Verification ${verificationId} is not bound to the current or consumed evidence-recorded state.`);
    }
    return {
      recordIntegrityValid: true,
      recordedExitCodeZero: record.exitCode === 0,
      authority: record.authority,
      executionProven: false,
      verificationProven: false,
      releaseProven: false,
      deploymentProven: false,
      consumedByEvidenceRecordedTransition: consumed,
      record,
    };
  }

  async verifyEvidence({ changeId, verificationIds }) {
    validateIdentifier(changeId, 'changeId');
    const ids = [...new Set((verificationIds ?? []).map((value) => validateIdentifier(value, 'verificationId')))].sort();
    if (ids.length < 1 || ids.length > 32) {
      throw deliveryError('STRUCTURED_EVIDENCE_REQUIRED', 'Evidence verification requires 1-32 structured verification record IDs; natural-language claims are not evidence.');
    }
    const change = await this.readChange(changeId);
    const checks = [];
    for (const verificationId of ids) {
      const checked = await this.checkVerification(verificationId);
      if (checked.record.changeId !== changeId) {
        throw deliveryError('EVIDENCE_CHANGE_MISMATCH', `Verification ${verificationId} belongs to another change.`);
      }
      if (!checked.recordedExitCodeZero) throw deliveryError('VERIFICATION_FAILED', `Verification ${verificationId} recorded exit code ${checked.record.exitCode}.`);
      checks.push({
        verificationId,
        integrityHash: checked.record.integrityHash,
        authority: checked.authority,
        executionProven: false,
        verificationProven: false,
        consumedByEvidenceRecordedTransition: checked.consumedByEvidenceRecordedTransition,
      });
    }
    return {
      recordIntegrityValid: true,
      proofType: 'self-recorded-artifact-integrity-only',
      authority: 'self-recorded-local',
      executionProven: false,
      verificationProven: false,
      releaseProven: false,
      deploymentProven: false,
      changeId,
      changeVersion: change.version,
      changeState: change.state,
      records: checks,
    };
  }

  async inspectWorktree() {
    const [commit, branchResult, statusResult] = await Promise.all([
      currentCommit(this.projectRoot),
      runGit(['-C', this.projectRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { allowExitCodes: [0, 1] }),
      runGit(['-C', this.projectRoot, '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    const entries = parsePorcelainStatus(statusResult.stdout);
    const counts = entries.reduce((result, entry) => {
      result[entry.category] = (result[entry.category] ?? 0) + 1;
      return result;
    }, {});
    return {
      projectRoot: '.',
      commit,
      branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() : null,
      detachedHead: branchResult.exitCode !== 0,
      clean: entries.length === 0,
      deliveryStateOnly: entries.length > 0 && entries.every((entry) => entry.category === 'delivery-state'),
      counts,
      entries,
    };
  }
}

function parseFlags(args, accepted) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!accepted.has(option)) throw deliveryError('UNKNOWN_OPTION', `Unknown option: ${option ?? '<missing>'}.`);
    if (value === undefined || value.startsWith('--')) throw deliveryError('OPTION_VALUE_REQUIRED', `${option} requires a value.`);
    const existing = values.get(option) ?? [];
    existing.push(value);
    values.set(option, existing);
  }
  return values;
}

function oneFlag(flags, name, { required = true } = {}) {
  const values = flags.get(name) ?? [];
  if (values.length > 1) throw deliveryError('DUPLICATE_OPTION', `${name} cannot be repeated.`);
  if (required && values.length !== 1) throw deliveryError('REQUIRED_OPTION', `${name} is required.`);
  return values[0];
}

function manyFlags(flags, name) {
  return flags.get(name) ?? [];
}

function parseArgvJson(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw deliveryError('INVALID_VERIFICATION_ARGV', '--argv-json must be valid JSON.'); }
  return validateArgv(parsed);
}

export function usageText() {
  return [
    'Usage:',
    '  forge-delivery change init --change <id> --objective <text> --idempotency-key <key>',
    '  forge-delivery change status --change <id>',
    '  forge-delivery change transition --change <id> --to <state> --expected-version <n> --idempotency-key <key> [--verification <id> ...]',
    '  forge-delivery handoff create --handoff <id> --change <id> --source <relative-file> [--source <relative-file> ...]',
    '  forge-delivery handoff verify --handoff <id>',
    '  forge-delivery contract inspect --source <relative-json>',
    '  forge-delivery contract bind --source <relative-json> --binding <id> --purpose <implementation|review|verification>',
    '  forge-delivery contract verify --source <relative-json> --binding <id>',
    '  forge-delivery worktree inspect',
    '  forge-delivery verify record --verification <id> --change <id> --argv-json <json-array> --exit-code <n> --log-file <relative-file>',
    '  forge-delivery verify check --verification <id>',
    '  forge-delivery evidence verify --change <id> --verification <id> [--verification <id> ...]',
    '',
    'This CLI never executes user commands, SQL, Docker, release, or deployment actions.',
    'It writes only ignored, project-local .forge-delivery state and never treats natural-language claims as evidence.',
    'Self-recorded argv, exit codes, and logs can reach only evidence-recorded; they never prove execution or verification.',
    'Contract files use forge-change/what-how-task schema without source; the CLI derives Git/source identity. Bindings record dependencies, never independent review or test execution proof.',
    'Contract JSON fields: schemaVersion=1, contractType="forge-change/what-how-task", contractId, projectSlug, revision>=1, what, how, tasks.',
    'what: objective, requirements[{requirementId,statement,acceptanceCriteria[]}], assumptions[]. how: decisions[{decisionId,statement,rationale}], risks[{riskId,statement,mitigation}].',
    'tasks: [{taskId,summary,dependsOn[],requirementIds[],decisionIds[],ownedPaths[]}]. IDs must reference existing entries; paths must be repository-relative. Do not supply source, layerDigests or integrity.',
    '',
  ].join('\n');
}

export async function executeCommand(argv, { cwd = process.cwd() } = {}) {
  const [group, action, ...args] = argv;
  if (group === undefined || group === '--help' || group === '-h' || action === '--help' || action === '-h') {
    return { help: usageText() };
  }
  const projectRoot = await discoverProjectRoot(cwd);
  const store = new ForgeDeliveryStore(projectRoot);
  if (group === 'change' && action === 'init') {
    const flags = parseFlags(args, new Set(['--change', '--objective', '--idempotency-key']));
    return store.initChange({
      changeId: oneFlag(flags, '--change'),
      objective: oneFlag(flags, '--objective'),
      idempotencyKey: oneFlag(flags, '--idempotency-key'),
    });
  }
  if (group === 'change' && action === 'status') {
    const flags = parseFlags(args, new Set(['--change']));
    return store.statusChange(oneFlag(flags, '--change'));
  }
  if (group === 'change' && action === 'transition') {
    const flags = parseFlags(args, new Set(['--change', '--to', '--expected-version', '--idempotency-key', '--verification']));
    return store.transitionChange({
      changeId: oneFlag(flags, '--change'),
      to: oneFlag(flags, '--to'),
      expectedVersion: oneFlag(flags, '--expected-version'),
      idempotencyKey: oneFlag(flags, '--idempotency-key'),
      verificationIds: manyFlags(flags, '--verification'),
    });
  }
  if (group === 'handoff' && action === 'create') {
    const flags = parseFlags(args, new Set(['--handoff', '--change', '--source']));
    return store.createHandoff({
      handoffId: oneFlag(flags, '--handoff'),
      changeId: oneFlag(flags, '--change'),
      sourcePaths: manyFlags(flags, '--source'),
    });
  }
  if (group === 'handoff' && action === 'verify') {
    const flags = parseFlags(args, new Set(['--handoff']));
    return store.verifyHandoff(oneFlag(flags, '--handoff'));
  }
  if (group === 'contract' && ['inspect', 'bind', 'verify'].includes(action)) {
    const accepted = action === 'inspect' ? ['--source'] : action === 'bind' ? ['--source', '--binding', '--purpose'] : ['--source', '--binding'];
    const flags = parseFlags(args, new Set(accepted));
    const sourcePath = oneFlag(flags, '--source');
    if (action === 'inspect') return store.inspectContract(sourcePath);
    const bindingId = oneFlag(flags, '--binding');
    if (action === 'bind') return store.bindContract({ sourcePath, bindingId, purpose: oneFlag(flags, '--purpose') });
    return store.verifyContract({ sourcePath, bindingId });
  }
  if (group === 'worktree' && action === 'inspect') {
    if (args.length > 0) throw deliveryError('UNKNOWN_OPTION', 'worktree inspect does not accept options.');
    return store.inspectWorktree();
  }
  if (group === 'verify' && action === 'record') {
    const flags = parseFlags(args, new Set(['--verification', '--change', '--argv-json', '--exit-code', '--log-file']));
    return store.recordVerification({
      verificationId: oneFlag(flags, '--verification'),
      changeId: oneFlag(flags, '--change'),
      argv: parseArgvJson(oneFlag(flags, '--argv-json')),
      exitCode: oneFlag(flags, '--exit-code'),
      logPath: oneFlag(flags, '--log-file'),
    });
  }
  if (group === 'verify' && action === 'check') {
    const flags = parseFlags(args, new Set(['--verification']));
    return store.checkVerification(oneFlag(flags, '--verification'));
  }
  if (group === 'evidence' && action === 'verify') {
    const flags = parseFlags(args, new Set(['--change', '--verification']));
    return store.verifyEvidence({
      changeId: oneFlag(flags, '--change'),
      verificationIds: manyFlags(flags, '--verification'),
    });
  }
  throw deliveryError('UNKNOWN_COMMAND', `Unknown command: ${group ?? ''} ${action ?? ''}.`);
}

function publicError(error) {
  return {
    code: error instanceof DeliveryError ? error.code : 'FORGE_DELIVERY_FAILED',
    message: typeof error?.message === 'string' ? error.message.slice(0, 1000) : 'Forge delivery operation failed.',
    ...(error instanceof DeliveryError && error.details !== undefined ? { details: error.details } : {}),
  };
}

export async function main(argv = process.argv.slice(2), io = process) {
  try {
    const result = await executeCommand(argv);
    if (result.help !== undefined) io.stdout.write(result.help);
    else io.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    if (result.recordedExitCodeZero === false) return 1;
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify({ ok: false, error: publicError(error) }, null, 2)}\n`);
    return error instanceof DeliveryError && ['UNKNOWN_COMMAND', 'UNKNOWN_OPTION', 'REQUIRED_OPTION', 'OPTION_VALUE_REQUIRED'].includes(error.code) ? 2 : 1;
  }
}
