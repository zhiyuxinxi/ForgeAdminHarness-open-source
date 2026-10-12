#!/usr/bin/env node

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIN_SECRET_BYTES = 1;
export const MAX_SECRET_BYTES = 16 * 1024;

const SAFE_MESSAGES = Object.freeze({
  SNAPSHOT_USAGE: 'Invalid command arguments.',
  SNAPSHOT_SOURCE_INVALID: `Source must be a regular file between ${MIN_SECRET_BYTES} and ${MAX_SECRET_BYTES} bytes.`,
  SNAPSHOT_SOURCE_CHANGED: 'Source changed while the snapshot was being read.',
  SNAPSHOT_DESTINATION_EXISTS: 'Destination already exists; snapshot was not written.',
  SNAPSHOT_DESTINATION_INVALID: 'Destination could not be created safely.',
  SNAPSHOT_IO_FAILED: 'Local secret snapshot could not be completed safely.',
});

class SnapshotError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.SNAPSHOT_IO_FAILED);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

function fail(code) {
  throw new SnapshotError(code);
}

function usage() {
  return 'Usage: node snapshot-local-secret.mjs (--source FILE | --generate-bytes N) --destination FILE';
}

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true };

  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--source', '--generate-bytes', '--destination'].includes(flag) || value === undefined || value.length === 0) {
      fail('SNAPSHOT_USAGE');
    }
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) fail('SNAPSHOT_USAGE');
    options[name] = value;
  }

  const generationBytes = options['generate-bytes'];
  if (!options.destination
    || (Boolean(options.source) === Boolean(generationBytes))
    || Object.keys(options).length !== 2
    || (generationBytes !== undefined && (!/^[1-9][0-9]*$/u.test(generationBytes)
      || Number(generationBytes) < MIN_SECRET_BYTES || Number(generationBytes) > MAX_SECRET_BYTES))) {
    fail('SNAPSHOT_USAGE');
  }
  return options;
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
  const leftValues = metadataFingerprint(left);
  const rightValues = metadataFingerprint(right);
  return leftValues.every((value, index) => value === rightValues[index]);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.rdev === right.rdev
    && left.nlink === right.nlink;
}

function isAdmissibleSource(stat) {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.size >= BigInt(MIN_SECRET_BYTES)
    && stat.size <= BigInt(MAX_SECRET_BYTES);
}

function sourceOpenFlags() {
  // O_NOFOLLOW is required wherever Node exposes the host primitive. Node on
  // Windows does not expose it, so the path/FD identity checks below fail
  // closed if a reparse-point swap is observed before or after either read.
  return fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
}

function destinationOpenFlags() {
  return fsConstants.O_WRONLY
    | fsConstants.O_CREAT
    | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
}

async function readExact(handle, size) {
  const result = Buffer.alloc(size);
  let offset = 0;
  try {
    while (offset < size) {
      const { bytesRead } = await handle.read(result, offset, size - offset, offset);
      if (bytesRead === 0) fail('SNAPSHOT_SOURCE_CHANGED');
      offset += bytesRead;
    }

    const trailingByte = Buffer.alloc(1);
    try {
      const { bytesRead } = await handle.read(trailingByte, 0, 1, size);
      if (bytesRead !== 0) fail('SNAPSHOT_SOURCE_CHANGED');
    } finally {
      trailingByte.fill(0);
    }
    return result;
  } catch (error) {
    result.fill(0);
    throw error;
  }
}

async function stablePathStat(source, failureCode = 'SNAPSHOT_SOURCE_INVALID') {
  try {
    return await lstat(source, { bigint: true });
  } catch {
    fail(failureCode);
  }
}

async function readStableSource(source, hooks) {
  const pathBefore = await stablePathStat(source);
  if (!isAdmissibleSource(pathBefore)) fail('SNAPSHOT_SOURCE_INVALID');

  let handle;
  try {
    handle = await open(source, sourceOpenFlags());
  } catch {
    fail('SNAPSHOT_SOURCE_INVALID');
  }

  let firstRead;
  let secondRead;
  try {
    const fdBefore = await handle.stat({ bigint: true });
    if (!isAdmissibleSource(fdBefore) || !sameMetadata(pathBefore, fdBefore)) {
      fail('SNAPSHOT_SOURCE_CHANGED');
    }

    const size = Number(fdBefore.size);
    firstRead = await readExact(handle, size);
    if (hooks?.afterFirstRead) await hooks.afterFirstRead();

    const fdBetween = await handle.stat({ bigint: true });
    const pathBetween = await stablePathStat(source, 'SNAPSHOT_SOURCE_CHANGED');
    if (!sameMetadata(fdBefore, fdBetween) || !sameMetadata(fdBefore, pathBetween)) {
      fail('SNAPSHOT_SOURCE_CHANGED');
    }

    secondRead = await readExact(handle, size);
    const fdAfter = await handle.stat({ bigint: true });
    const pathAfter = await stablePathStat(source, 'SNAPSHOT_SOURCE_CHANGED');
    if (!sameMetadata(fdBefore, fdAfter)
      || !sameMetadata(fdBefore, pathAfter)
      || !timingSafeEqual(firstRead, secondRead)) {
      fail('SNAPSHOT_SOURCE_CHANGED');
    }

    secondRead.fill(0);
    secondRead = undefined;
    return firstRead;
  } catch (error) {
    firstRead?.fill(0);
    secondRead?.fill(0);
    if (error instanceof SnapshotError) throw error;
    fail('SNAPSHOT_IO_FAILED');
  } finally {
    await handle.close().catch(() => {});
  }
}

async function writeAll(handle, content) {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
    if (bytesWritten === 0) fail('SNAPSHOT_IO_FAILED');
    offset += bytesWritten;
  }
}

function windowsPowerShellEnvironment(extra = {}) {
  return Object.assign(
    Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
    extra,
  );
}

function enforceWindowsPrivateDacl(destination) {
  const sidResult = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  ], { encoding: 'utf8', windowsHide: true, env: windowsPowerShellEnvironment() });
  const sid = String(sidResult.stdout ?? '').trim();
  if (sidResult.error || sidResult.status !== 0 || !/^S-\d(?:-\d+)+$/.test(sid)) {
    fail('SNAPSHOT_DESTINATION_INVALID');
  }
  const applyResult = spawnSync('icacls.exe', [
    destination,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(F)`,
  ], { stdio: 'ignore', windowsHide: true });
  if (applyResult.error || applyResult.status !== 0) {
    fail('SNAPSHOT_DESTINATION_INVALID');
  }

  const script = String.raw`& {
    $ErrorActionPreference = 'Stop'
    $Target = $env:FORGE_SECRET_SNAPSHOT_TARGET
    $ExpectedSid = $env:FORGE_SECRET_SNAPSHOT_SID
    if ([string]::IsNullOrWhiteSpace($Target) -or [string]::IsNullOrWhiteSpace($ExpectedSid)) { exit 16 }
    $sid = [System.Security.Principal.SecurityIdentifier]::new($ExpectedSid)
    $actual = Get-Acl -LiteralPath $Target
    $ownerSid = $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if (-not $actual.AreAccessRulesProtected -or $ownerSid -ne $sid.Value) { exit 17 }
    $rules = @($actual.GetAccessRules(
      $true,
      $true,
      [System.Security.Principal.SecurityIdentifier]
    ))
    if ($rules.Count -ne 1) { exit 18 }
    $only = $rules[0]
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    $rightsMatch = (($only.FileSystemRights -band $fullControl) -eq $fullControl)
    if ($only.IsInherited -or $only.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $only.IdentityReference.Value -ne $sid.Value -or -not $rightsMatch) { exit 19 }
  }`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
    env: windowsPowerShellEnvironment({
      FORGE_SECRET_SNAPSHOT_TARGET: destination,
      FORGE_SECRET_SNAPSHOT_SID: sid,
    }),
  });
  if (result.error || result.status !== 0) {
    fail('SNAPSHOT_DESTINATION_INVALID');
  }
}

function enforceDestinationAccessControl(destination) {
  if (process.platform === 'win32') enforceWindowsPrivateDacl(destination);
}

async function createDestination(destination, content) {
  let handle;
  try {
    handle = await open(destination, destinationOpenFlags(), 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') fail('SNAPSHOT_DESTINATION_EXISTS');
    fail('SNAPSHOT_DESTINATION_INVALID');
  }

  try {
    let created = await handle.stat({ bigint: true });
    if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1n) {
      fail('SNAPSHOT_DESTINATION_INVALID');
    }

    // Apply the final mode before secret bytes are written. POSIX hosts are
    // checked for exact 0600 semantics. Windows receives a protected DACL
    // containing only the current user's SID before any secret bytes exist.
    await handle.chmod(0o600);
    created = await handle.stat({ bigint: true });
    if (process.platform !== 'win32' && (created.mode & 0o7777n) !== 0o600n) {
      fail('SNAPSHOT_DESTINATION_INVALID');
    }

    // Windows cannot replace a DACL on this file while Node retains the open
    // handle. Close the still-empty inode, protect it, then reopen and prove
    // the path still resolves to the exact O_EXCL-created identity before any
    // secret byte is written.
    if (process.platform === 'win32') {
      await handle.close();
      handle = undefined;
      enforceDestinationAccessControl(destination);
      try {
        handle = await open(destination, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0));
      } catch {
        fail('SNAPSHOT_DESTINATION_INVALID');
      }
      const reopened = await handle.stat({ bigint: true });
      const protectedPath = await stablePathStat(destination, 'SNAPSHOT_DESTINATION_INVALID');
      if (!reopened.isFile() || reopened.isSymbolicLink() || reopened.nlink !== 1n
        || !sameFileIdentity(created, reopened) || !sameMetadata(reopened, protectedPath)) {
        fail('SNAPSHOT_DESTINATION_INVALID');
      }
    }

    await writeAll(handle, content);
    await handle.sync();

    const fdAfter = await handle.stat({ bigint: true });
    let pathAfter;
    try {
      pathAfter = await lstat(destination, { bigint: true });
    } catch {
      fail('SNAPSHOT_DESTINATION_INVALID');
    }
    if (!fdAfter.isFile()
      || fdAfter.isSymbolicLink()
      || fdAfter.nlink !== 1n
      || fdAfter.size !== BigInt(content.length)
      || !sameMetadata(fdAfter, pathAfter)
      || (process.platform !== 'win32' && (fdAfter.mode & 0o7777n) !== 0o600n)) {
      fail('SNAPSHOT_DESTINATION_INVALID');
    }
  } catch (error) {
    // The file is already mode 0600 before any content write. If a later
    // check fails, erase the inode through the still-open descriptor rather
    // than unlinking a path that an attacker may have replaced.
    await handle?.truncate(0).catch(() => {});
    await handle?.sync().catch(() => {});
    if (error instanceof SnapshotError) throw error;
    fail('SNAPSHOT_IO_FAILED');
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Create an exclusive local snapshot. The optional hooks object exists only
 * to make source-race behavior deterministically testable; hooks receive no
 * file descriptor, path, metadata, or secret content.
 */
export async function snapshotLocalSecret({ source, destination }, hooks = undefined) {
  if (typeof source !== 'string' || typeof destination !== 'string' || source.length === 0 || destination.length === 0) {
    fail('SNAPSHOT_USAGE');
  }

  let content;
  try {
    content = await readStableSource(source, hooks);
    await createDestination(destination, content);
  } finally {
    content?.fill(0);
  }
}

export async function generateLocalSecret({ bytes, destination }) {
  if (!Number.isSafeInteger(bytes) || bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES
    || typeof destination !== 'string' || destination.length === 0) {
    fail('SNAPSHOT_USAGE');
  }
  let content;
  try {
    content = Buffer.from(`${randomBytes(bytes).toString('hex')}\n`, 'utf8');
    await createDestination(destination, content);
  } finally {
    content?.fill(0);
  }
}

export async function main(argv = process.argv.slice(2), io = process) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      io.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.source) await snapshotLocalSecret(options);
    else await generateLocalSecret({ bytes: Number(options['generate-bytes']), destination: options.destination });
    return 0;
  } catch (error) {
    const code = error instanceof SnapshotError ? error.code : 'SNAPSHOT_IO_FAILED';
    io.stderr.write(`${SAFE_MESSAGES[code]}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await main();
