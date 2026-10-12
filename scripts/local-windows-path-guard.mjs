import { spawnSync } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

function pathFailure(code, message) { const error = new Error(message); error.code = code; throw error; }

function syntacticallyLocal(value, label, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f,]/u.test(value)
    || /^(?:\\\\|\/\/|\\[?.]\\|\\\?\?\\|\\\\[?.]\\|\/\/[?.]\/)/u.test(value)
    || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/u.test(value))) {
    pathFailure(code, `${label} is not one absolute local Windows path.`);
  }
  return value;
}

function powershellExecutable(code) {
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\[^\u0000-\u001f\u007f]+$/u.test(systemRoot)) {
    pathFailure(code, 'SystemRoot is unavailable for the local-drive/reparse check.');
  }
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const localDriveCache = new Map();

function probeWindowsPath(resolved, label, code) {
  if (process.platform !== 'win32') return;
  const driveRoot = path.parse(resolved).root.toLowerCase();
  if (localDriveCache.get(driveRoot) === true) return;
  const script = [
    '$ErrorActionPreference="Stop"',
    '$drive=[IO.DriveInfo]::new($env:FORGE_PATH_PROBE_ROOT)',
    '[int]$drive.DriveType',
  ].join(';');
  const result = spawnSync(powershellExecutable(code), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], {
    encoding: 'utf8', shell: false, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, PATH: '', FORGE_PATH_PROBE_ROOT: driveRoot },
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== '3') pathFailure(code, `${label} is on a remote or non-fixed drive.`);
  localDriveCache.set(driveRoot, true);
}

export async function assertLocalOrdinaryPath(value, label, type = 'file', code = 'LOCAL_PATH_INVALID') {
  syntacticallyLocal(value, label, code);
  const supplied = await lstat(value).catch(() => pathFailure(code, `${label} does not exist.`));
  if (supplied.isSymbolicLink() || (type === 'file' ? !supplied.isFile() || supplied.nlink !== 1 : !supplied.isDirectory())) {
    pathFailure(code, `${label} is not one ordinary ${type}.`);
  }
  const resolved = syntacticallyLocal(await realpath(value), `${label} resolved path`, code);
  if (path.resolve(value).toLowerCase() !== path.resolve(resolved).toLowerCase()) {
    pathFailure(code, `${label} traverses a symbolic-link, junction, or other reparse boundary.`);
  }
  const metadata = await lstat(resolved);
  if (metadata.isSymbolicLink() || (type === 'file' ? !metadata.isFile() || metadata.nlink !== 1 : !metadata.isDirectory())) {
    pathFailure(code, `${label} changed after canonicalization.`);
  }
  probeWindowsPath(resolved, label, code);
  return resolved;
}

export async function assertLocalOutputPath(value, label = 'output', code = 'LOCAL_PATH_INVALID') {
  syntacticallyLocal(value, label, code);
  const parent = await assertLocalOrdinaryPath(path.dirname(value), `${label} parent`, 'directory', code);
  const output = syntacticallyLocal(path.join(parent, path.basename(value)), `${label} resolved path`, code);
  try { await lstat(output); pathFailure(`${code}_EXISTS`, `${label} already exists.`); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return output;
}

export async function prepareLocalDirectory(value, label, code = 'LOCAL_PATH_INVALID') {
  syntacticallyLocal(value, label, code);
  try { return await assertLocalOrdinaryPath(value, label, 'directory', code); } catch (error) {
    if (error?.message !== `${label} does not exist.`) throw error;
  }
  const parent = await assertLocalOrdinaryPath(path.dirname(value), `${label} parent`, 'directory', code);
  const candidate = syntacticallyLocal(path.join(parent, path.basename(value)), `${label} resolved path`, code);
  await mkdir(candidate, { recursive: false, mode: 0o700 });
  return await assertLocalOrdinaryPath(candidate, label, 'directory', code);
}
