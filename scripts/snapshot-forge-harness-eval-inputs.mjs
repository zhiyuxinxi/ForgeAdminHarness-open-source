#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCK_SCHEMA = 'forge-harness-eval-input-lock/v1';
const MAX_SUITE_BYTES = 1024 * 1024;
const MAX_ANALYZER_BYTES = 8 * 1024 * 1024;
const MAX_CLOSURE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CLOSURE_BYTES = 32 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WINDOWS_RESERVED_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const SAFE_MESSAGES = Object.freeze({
  EVAL_SNAPSHOT_USAGE: 'Invalid command arguments.',
  EVAL_SNAPSHOT_INPUT_INVALID: 'Evaluation input is invalid or changed while being read.',
  EVAL_SNAPSHOT_ANCHOR_MISMATCH: 'Evaluation input digest does not match its fixed anchor.',
  EVAL_SNAPSHOT_DESTINATION_EXISTS: 'Snapshot destination already exists.',
  EVAL_SNAPSHOT_DESTINATION_INVALID: 'Snapshot destination could not be created safely.',
  EVAL_SNAPSHOT_VERIFY_FAILED: 'Snapshot is invalid or has been modified.',
  EVAL_SNAPSHOT_IO_FAILED: 'Evaluation input snapshot could not be completed safely.',
});

class EvalSnapshotError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.EVAL_SNAPSHOT_IO_FAILED);
    this.name = 'EvalSnapshotError';
    this.code = code;
  }
}

function fail(code) {
  throw new EvalSnapshotError(code);
}

function usage() {
  return [
    'Usage:',
    '  node snapshot-forge-harness-eval-inputs.mjs create --suite FILE --suite-sha256 HEX --analyzer FILE --analyzer-sha256 HEX --destination DIR',
    '  node snapshot-forge-harness-eval-inputs.mjs verify --snapshot DIR --suite-sha256 HEX --analyzer-sha256 HEX',
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0];
  if (argv.length === 1 && (command === '--help' || command === '-h')) return { command: 'help' };
  if (!['create', 'verify'].includes(command)) fail('EVAL_SNAPSHOT_USAGE');

  const values = { command };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--') || value === undefined || value.length === 0) {
      fail('EVAL_SNAPSHOT_USAGE');
    }
    const name = flag.slice(2);
    if (Object.hasOwn(values, name)) fail('EVAL_SNAPSHOT_USAGE');
    values[name] = value;
  }

  const expected = command === 'create'
    ? ['analyzer', 'analyzer-sha256', 'destination', 'suite', 'suite-sha256']
    : ['analyzer-sha256', 'snapshot', 'suite-sha256'];
  const actual = Object.keys(values).filter((name) => name !== 'command').sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    fail('EVAL_SNAPSHOT_USAGE');
  }
  if (!SHA256_PATTERN.test(values['suite-sha256']) || !SHA256_PATTERN.test(values['analyzer-sha256'])) {
    fail('EVAL_SNAPSHOT_USAGE');
  }
  return values;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function comparePortablePath(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function metadataFingerprint(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.rdev,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ];
}

function sameMetadata(left, right) {
  const rightValues = metadataFingerprint(right);
  return metadataFingerprint(left).every((value, index) => value === rightValues[index]);
}

function readFlags() {
  return fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
}

function writeFlags() {
  return fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
}

async function stableReadFile(filePath, maximumBytes, failureCode) {
  let pathBefore;
  try {
    pathBefore = await lstat(filePath, { bigint: true });
  } catch {
    fail(failureCode);
  }
  if (!pathBefore.isFile()
    || pathBefore.isSymbolicLink()
    || pathBefore.size < 1n
    || pathBefore.size > BigInt(maximumBytes)) {
    fail(failureCode);
  }

  let handle;
  try {
    handle = await open(filePath, readFlags());
  } catch {
    fail(failureCode);
  }

  const bytes = Buffer.alloc(Number(pathBefore.size));
  try {
    const fdBefore = await handle.stat({ bigint: true });
    if (!fdBefore.isFile() || !sameMetadata(pathBefore, fdBefore)) fail(failureCode);

    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) fail(failureCode);
      offset += result.bytesRead;
    }
    const trailing = Buffer.alloc(1);
    try {
      if ((await handle.read(trailing, 0, 1, bytes.length)).bytesRead !== 0) fail(failureCode);
    } finally {
      trailing.fill(0);
    }

    const fdAfter = await handle.stat({ bigint: true });
    let pathAfter;
    try {
      pathAfter = await lstat(filePath, { bigint: true });
    } catch {
      fail(failureCode);
    }
    if (!sameMetadata(fdBefore, fdAfter) || !sameMetadata(fdBefore, pathAfter)) fail(failureCode);
    return bytes;
  } catch (error) {
    bytes.fill(0);
    if (error instanceof EvalSnapshotError) throw error;
    fail(failureCode);
  } finally {
    await handle.close().catch(() => {});
  }
}

function parseJson(bytes, failureCode) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(failureCode);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalizeJson(value, failureCode) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail(failureCode);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item, failureCode));
  if (!isPlainObject(value)) fail(failureCode);
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalizeJson(value[key], failureCode)]),
  );
}

function checkedRelativePath(value, failureCode) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\\')) fail(failureCode);
  const segments = value.split('/');
  if (segments.length === 0 || segments.some((segment) => (
    segment === '.'
    || segment === '..'
    || !SAFE_SEGMENT_PATTERN.test(segment)
    || WINDOWS_RESERVED_PATTERN.test(segment)
    || segment.endsWith('.')
    || segment.endsWith(' ')
  ))) fail(failureCode);
  return segments.join('/');
}

function checkedSuiteDescriptor(suite, failureCode) {
  if (!isPlainObject(suite)
    || typeof suite.suiteVersion !== 'string'
    || suite.suiteVersion.length < 1
    || suite.suiteVersion.length > 128
    || /[\u0000-\u001f\u007f]/.test(suite.suiteVersion)
    || !SOURCE_COMMIT_PATTERN.test(suite.source?.commit)
    || !isPlainObject(suite.dsh?.modelContract)
    || Object.keys(suite.dsh.modelContract).length === 0
    || !Array.isArray(suite.cases)
    || suite.cases.length === 0
    || suite.cases.length > 256) {
    fail(failureCode);
  }

  const modelContract = canonicalizeJson(suite.dsh.modelContract, failureCode);
  const declared = [{
    relativePath: checkedRelativePath(suite.dsh.patch, failureCode),
    expectedSha256: suite.dsh.patchSha256,
    kind: 'patch',
  }, {
    relativePath: checkedRelativePath(suite.dsh.executionPolicy, failureCode),
    expectedSha256: suite.dsh.executionPolicySha256,
    kind: 'execution-policy',
  }];
  for (const item of suite.cases) {
    if (!isPlainObject(item)) fail(failureCode);
    declared.push({
      relativePath: checkedRelativePath(item.prompt, failureCode),
      expectedSha256: item.promptSha256,
      kind: 'prompt',
    });
  }

  const seen = new Set(['suite.json']);
  for (const item of declared) {
    if (!SHA256_PATTERN.test(item.expectedSha256)) fail(failureCode);
    const portableIdentity = item.relativePath.toLowerCase();
    if (seen.has(portableIdentity)) fail(failureCode);
    seen.add(portableIdentity);
  }
  return {
    suiteVersion: suite.suiteVersion,
    sourceCommit: suite.source.commit,
    modelContract,
    declared,
  };
}

function isWithinRoot(root, candidate) {
  const delta = relative(root, candidate);
  return delta === '' || (!isAbsolute(delta) && delta !== '..' && !delta.startsWith(`..${sep}`));
}

async function checkedSourceClosurePath(suiteRoot, suiteRootReal, relativePath, failureCode) {
  let cursor = suiteRoot;
  for (const segment of relativePath.split('/')) {
    cursor = join(cursor, segment);
    let info;
    try {
      info = await lstat(cursor);
    } catch {
      fail(failureCode);
    }
    if (info.isSymbolicLink()) fail(failureCode);
  }
  let canonical;
  try {
    canonical = await realpath(cursor);
  } catch {
    fail(failureCode);
  }
  if (!isWithinRoot(suiteRootReal, canonical)) fail(failureCode);
  return cursor;
}

function entry(path, bytes) {
  return { path, sha256: sha256(bytes), bytes: bytes.length };
}

function buildLock(descriptor, entries) {
  const sortedEntries = [...entries].sort((left, right) => comparePortablePath(left.path, right.path));
  const closure = {
    suiteVersion: descriptor.suiteVersion,
    sourceCommit: descriptor.sourceCommit,
    modelContract: descriptor.modelContract,
    entries: sortedEntries,
  };
  return {
    schemaVersion: LOCK_SCHEMA,
    ...closure,
    closureDigest: sha256(Buffer.from(JSON.stringify(canonicalizeJson(closure, 'EVAL_SNAPSHOT_VERIFY_FAILED')), 'utf8')),
  };
}

function serializeLock(lock) {
  return Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

async function loadCreateClosure(options) {
  const suiteBytes = await stableReadFile(options.suite, MAX_SUITE_BYTES, 'EVAL_SNAPSHOT_INPUT_INVALID');
  const analyzerBytes = await stableReadFile(options.analyzer, MAX_ANALYZER_BYTES, 'EVAL_SNAPSHOT_INPUT_INVALID');
  if (sha256(suiteBytes) !== options['suite-sha256'] || sha256(analyzerBytes) !== options['analyzer-sha256']) {
    fail('EVAL_SNAPSHOT_ANCHOR_MISMATCH');
  }

  const descriptor = checkedSuiteDescriptor(parseJson(suiteBytes, 'EVAL_SNAPSHOT_INPUT_INVALID'), 'EVAL_SNAPSHOT_INPUT_INVALID');
  const suiteRoot = dirname(resolve(options.suite));
  let suiteRootReal;
  try {
    suiteRootReal = await realpath(suiteRoot);
  } catch {
    fail('EVAL_SNAPSHOT_INPUT_INVALID');
  }

  const files = new Map([
    ['analyzer.mjs', analyzerBytes],
    ['suite/suite.json', suiteBytes],
  ]);
  let closureBytes = suiteBytes.length + analyzerBytes.length;
  for (const item of descriptor.declared) {
    const sourcePath = await checkedSourceClosurePath(
      suiteRoot,
      suiteRootReal,
      item.relativePath,
      'EVAL_SNAPSHOT_INPUT_INVALID',
    );
    const bytes = await stableReadFile(sourcePath, MAX_CLOSURE_FILE_BYTES, 'EVAL_SNAPSHOT_INPUT_INVALID');
    if (sha256(bytes) !== item.expectedSha256) fail('EVAL_SNAPSHOT_ANCHOR_MISMATCH');
    closureBytes += bytes.length;
    if (closureBytes > MAX_CLOSURE_BYTES) fail('EVAL_SNAPSHOT_INPUT_INVALID');
    files.set(`suite/${item.relativePath}`, bytes);
  }

  const entries = [...files].map(([path, bytes]) => entry(path, bytes));
  return { files, lock: buildLock(descriptor, entries) };
}

async function assertDirectory(directory, expectedMode, failureCode) {
  let info;
  try {
    info = await lstat(directory, { bigint: true });
  } catch {
    fail(failureCode);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(failureCode);
  if (process.platform !== 'win32' && (info.mode & 0o7777n) !== BigInt(expectedMode)) fail(failureCode);
}

async function createDirectory(directory, failureCode) {
  try {
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o700);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('EVAL_SNAPSHOT_DESTINATION_EXISTS');
    fail(failureCode);
  }
  await assertDirectory(directory, 0o700, failureCode);
}

async function writeExclusiveFile(filePath, bytes) {
  let handle;
  try {
    handle = await open(filePath, writeFlags(), 0o600);
  } catch {
    fail('EVAL_SNAPSHOT_DESTINATION_INVALID');
  }
  try {
    await handle.chmod(0o600);
    const protectedInfo = await handle.stat({ bigint: true });
    if (!protectedInfo.isFile()
      || protectedInfo.isSymbolicLink()
      || protectedInfo.nlink !== 1n
      || (process.platform !== 'win32' && (protectedInfo.mode & 0o7777n) !== 0o600n)) {
      fail('EVAL_SNAPSHOT_DESTINATION_INVALID');
    }
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (result.bytesWritten === 0) fail('EVAL_SNAPSHOT_IO_FAILED');
      offset += result.bytesWritten;
    }
    await handle.sync();
    if (process.platform !== 'win32') await handle.chmod(0o400);
    const finalInfo = await handle.stat({ bigint: true });
    if (finalInfo.size !== BigInt(bytes.length)
      || (process.platform !== 'win32' && (finalInfo.mode & 0o7777n) !== 0o400n)) {
      fail('EVAL_SNAPSHOT_DESTINATION_INVALID');
    }
  } catch (error) {
    await handle.truncate(0).catch(() => {});
    await handle.sync().catch(() => {});
    if (error instanceof EvalSnapshotError) throw error;
    fail('EVAL_SNAPSHOT_IO_FAILED');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function createSnapshot(options) {
  const closure = await loadCreateClosure(options);
  const destination = resolve(options.destination);
  await createDirectory(destination, 'EVAL_SNAPSHOT_DESTINATION_INVALID');

  const directories = new Set();
  for (const filePath of closure.files.keys()) {
    const segments = filePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  for (const directory of [...directories].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length;
    return depth || comparePortablePath(left, right);
  })) {
    await createDirectory(join(destination, ...directory.split('/')), 'EVAL_SNAPSHOT_DESTINATION_INVALID');
  }

  for (const [filePath, bytes] of [...closure.files].sort(([left], [right]) => comparePortablePath(left, right))) {
    await writeExclusiveFile(join(destination, ...filePath.split('/')), bytes);
  }
  await writeExclusiveFile(join(destination, 'input-lock.json'), serializeLock(closure.lock));
}

async function enumerateSnapshot(root, failureCode) {
  const files = [];
  const directories = [];
  const visit = async (directory, relativeDirectory = '') => {
    await assertDirectory(directory, 0o700, failureCode);
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch {
      fail(failureCode);
    }
    children.sort((left, right) => comparePortablePath(left.name, right.name));
    for (const child of children) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      checkedRelativePath(relativePath, failureCode);
      const absolutePath = join(directory, child.name);
      let info;
      try {
        info = await lstat(absolutePath, { bigint: true });
      } catch {
        fail(failureCode);
      }
      if (info.isSymbolicLink()) fail(failureCode);
      if (info.isDirectory()) {
        directories.push(relativePath);
        await visit(absolutePath, relativePath);
      }
      else if (info.isFile()) {
        if (process.platform !== 'win32' && (info.mode & 0o7777n) !== 0o400n) fail(failureCode);
        files.push(relativePath);
      } else fail(failureCode);
    }
  };
  await visit(root);
  return {
    directories: directories.sort(comparePortablePath),
    files: files.sort(comparePortablePath),
  };
}

async function verifySnapshot(options) {
  const snapshot = resolve(options.snapshot);
  await assertDirectory(snapshot, 0o700, 'EVAL_SNAPSHOT_VERIFY_FAILED');
  const actualTree = await enumerateSnapshot(snapshot, 'EVAL_SNAPSHOT_VERIFY_FAILED');
  const actualPaths = actualTree.files;

  const fixedPaths = ['analyzer.mjs', 'input-lock.json', 'suite/suite.json'];
  if (fixedPaths.some((path) => !actualPaths.includes(path))) fail('EVAL_SNAPSHOT_VERIFY_FAILED');

  const suiteBytes = await stableReadFile(
    join(snapshot, 'suite', 'suite.json'),
    MAX_SUITE_BYTES,
    'EVAL_SNAPSHOT_VERIFY_FAILED',
  );
  const analyzerBytes = await stableReadFile(
    join(snapshot, 'analyzer.mjs'),
    MAX_ANALYZER_BYTES,
    'EVAL_SNAPSHOT_VERIFY_FAILED',
  );
  if (sha256(suiteBytes) !== options['suite-sha256'] || sha256(analyzerBytes) !== options['analyzer-sha256']) {
    fail('EVAL_SNAPSHOT_VERIFY_FAILED');
  }

  const descriptor = checkedSuiteDescriptor(
    parseJson(suiteBytes, 'EVAL_SNAPSHOT_VERIFY_FAILED'),
    'EVAL_SNAPSHOT_VERIFY_FAILED',
  );
  const files = new Map([
    ['analyzer.mjs', analyzerBytes],
    ['suite/suite.json', suiteBytes],
  ]);
  let closureBytes = suiteBytes.length + analyzerBytes.length;
  for (const item of descriptor.declared) {
    const snapshotPath = `suite/${item.relativePath}`;
    const bytes = await stableReadFile(
      join(snapshot, ...snapshotPath.split('/')),
      MAX_CLOSURE_FILE_BYTES,
      'EVAL_SNAPSHOT_VERIFY_FAILED',
    );
    if (sha256(bytes) !== item.expectedSha256) fail('EVAL_SNAPSHOT_VERIFY_FAILED');
    closureBytes += bytes.length;
    if (closureBytes > MAX_CLOSURE_BYTES) fail('EVAL_SNAPSHOT_VERIFY_FAILED');
    files.set(snapshotPath, bytes);
  }

  const expectedPaths = [...files.keys(), 'input-lock.json'].sort(comparePortablePath);
  if (expectedPaths.length !== actualPaths.length
    || expectedPaths.some((path, index) => path !== actualPaths[index])) {
    fail('EVAL_SNAPSHOT_VERIFY_FAILED');
  }
  const expectedDirectories = new Set();
  for (const filePath of expectedPaths) {
    const segments = filePath.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join('/'));
    }
  }
  const sortedExpectedDirectories = [...expectedDirectories].sort(comparePortablePath);
  if (sortedExpectedDirectories.length !== actualTree.directories.length
    || sortedExpectedDirectories.some((path, index) => path !== actualTree.directories[index])) {
    fail('EVAL_SNAPSHOT_VERIFY_FAILED');
  }

  const expectedLock = buildLock(descriptor, [...files].map(([path, bytes]) => entry(path, bytes)));
  const lockBytes = await stableReadFile(
    join(snapshot, 'input-lock.json'),
    MAX_SUITE_BYTES,
    'EVAL_SNAPSHOT_VERIFY_FAILED',
  );
  const expectedLockBytes = serializeLock(expectedLock);
  if (!lockBytes.equals(expectedLockBytes)) fail('EVAL_SNAPSHOT_VERIFY_FAILED');
}

export async function main(argv = process.argv.slice(2), io = process) {
  try {
    const options = parseArgs(argv);
    if (options.command === 'help') {
      io.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.command === 'create') await createSnapshot(options);
    else await verifySnapshot(options);
    return 0;
  } catch (error) {
    const code = error instanceof EvalSnapshotError ? error.code : 'EVAL_SNAPSHOT_IO_FAILED';
    io.stderr.write(`${SAFE_MESSAGES[code]}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await main();
