#!/usr/bin/env node
// Operator-only issuance. Never register this entrypoint as a Harness tool.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueForgeBusinessDataApprovalAttestation } from '../docker/harness/forge-business-data-approval.mjs';

const OPTIONS = new Map([
  ['--preview-file', 'previewFile'], ['--issuer-config', 'issuerConfig'],
  ['--out', 'outputFile'], ['--expires-at', 'expiresAt'],
]);

function reject(code, message) { const error = new Error(message); error.code = code; throw error; }

// Same SID/Get-Acl checks as snapshot-local-secret.mjs. Paths are JSON on stdin;
// no caller text is inserted into the fixed PowerShell program.
const WINDOWS_FILE_CHECK = String.raw`& {
  $ErrorActionPreference = 'Stop'
  try {
    $InputEncoding = [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $item = Get-Item -LiteralPath $request.file -Force
    if ($item -isnot [IO.FileInfo]) { exit 20 }
    $cursor = $item
    while ($null -ne $cursor) {
      if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 21 }
      if ($cursor -is [IO.FileInfo]) { $cursor = $cursor.Directory } else { $cursor = $cursor.Parent }
    }
    if ($request.secret) {
      $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $acl = Get-Acl -LiteralPath $request.file
      if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { exit 22 }
      $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
      $hasRead = $false
      foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
          if ($allowed -notcontains $rule.IdentityReference.Value) { exit 23 }
          if (($rule.IdentityReference.Value -eq $sid) -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData)) { $hasRead = $true }
        }
      }
      if (-not $hasRead) { exit 24 }
    }
    [Console]::Out.Write('ok')
  } catch { exit 25 }
}`;

function checkWindowsFile(file, secret) {
  const checked = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_FILE_CHECK,
  ], {
    input: JSON.stringify({ file, secret }), encoding: 'utf8', windowsHide: true,
    timeout: 10000, maxBuffer: 4096,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
  });
  if (checked.error || checked.status !== 0 || checked.stdout !== 'ok') reject('FILE_UNSAFE', 'Windows input ownership, ACL or file identity is unsafe.');
}

function samePath(left, right) { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }

export function parseBusinessDataApprovalIssuerArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = OPTIONS.get(argv[index]); const value = argv[index + 1];
    if (!name || Object.hasOwn(values, name) || typeof value !== 'string' || !value || value.startsWith('--') || value.includes('\0')) {
      reject('ARGUMENT_INVALID', 'Use each supported option once with one nonempty value.');
    }
    values[name] = value;
  }
  for (const name of ['previewFile', 'issuerConfig', 'outputFile']) {
    if (!values[name] || !path.isAbsolute(values[name])) reject('ARGUMENT_INVALID', 'Preview, issuer configuration and output require absolute paths.');
    values[name] = path.normalize(values[name]);
  }
  if (samePath(values.previewFile, values.outputFile) || samePath(values.issuerConfig, values.outputFile)) reject('ARGUMENT_INVALID', 'Output must be a new separate attestation file.');
  if (values.expiresAt !== undefined) {
    const time = Date.parse(values.expiresAt);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== values.expiresAt) reject('ARGUMENT_INVALID', 'Expiry must be an ISO timestamp with milliseconds.');
  }
  return Object.freeze(values);
}

async function readRegularFile(file, maximumBytes, secret) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || !samePath(await realpath(file), file)) reject('FILE_UNSAFE', 'Input must be an absolute path without symbolic links.');
  if (process.platform === 'win32') checkWindowsFile(file, secret);
  const expected = await lstat(file);
  if (!expected.isFile() || expected.nlink !== 1 || expected.size > maximumBytes
      || (secret && process.platform === 'linux' && (expected.uid !== process.geteuid() || (expected.mode & 0o7777) !== 0o600))) {
    reject('FILE_UNSAFE', 'Protected configuration and key must be owned regular files with mode 0600.');
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size
        || actual.uid !== expected.uid || actual.mode !== expected.mode || actual.nlink !== expected.nlink) {
      reject('FILE_UNSAFE', 'Input changed while it was opened.');
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
    }
    const after = await handle.stat();
    if (bytes !== actual.size || bytes > maximumBytes || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs) {
      reject('FILE_UNSAFE', 'Input changed during its bounded read.');
    }
    return buffer.subarray(0, bytes);
  } finally { await handle.close(); }
}

function parseObject(raw, description) {
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { reject('INPUT_INVALID', `${description} must be valid JSON.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('INPUT_INVALID', `${description} must be a JSON object.`);
  return value;
}

export async function issueBusinessDataApprovalFromFiles(argv) {
  const options = parseBusinessDataApprovalIssuerArguments(argv);
  if (!['linux', 'win32'].includes(process.platform) || (process.platform === 'linux' && typeof process.geteuid !== 'function')) {
    reject('PLATFORM_UNSUPPORTED', 'Approval issuance requires Linux mode checks or Windows SID and ACL checks.');
  }
  const config = parseObject(await readRegularFile(options.issuerConfig, 16 * 1024, true), 'Protected issuer configuration');
  const fields = ['privateKeyFile', 'subjectId', 'keyId', 'role'];
  if (Object.keys(config).length !== fields.length || Object.keys(config).some((key) => !fields.includes(key))
      || typeof config.privateKeyFile !== 'string' || !path.isAbsolute(config.privateKeyFile)) {
    reject('INPUT_INVALID', 'Protected issuer configuration has unsupported or missing fields.');
  }
  const privateKeyFile = path.normalize(config.privateKeyFile);
  if (samePath(options.outputFile, privateKeyFile)) reject('ARGUMENT_INVALID', 'Output must not replace the protected private key.');
  const preview = parseObject(await readRegularFile(options.previewFile, 256 * 1024, false), 'Saved preview');
  if (!preview.request || typeof preview.request !== 'object' || Array.isArray(preview.request)) reject('INPUT_INVALID', 'Saved preview must contain its sealed request.');
  const privateKey = await readRegularFile(privateKeyFile, 16 * 1024, true);
  let attestation;
  try {
    attestation = issueForgeBusinessDataApprovalAttestation({
      request: preview.request, approvalId: randomUUID(), expiresAt: options.expiresAt ?? preview.request.expiresAt,
    }, {
      issuer: { subjectId: config.subjectId, keyId: config.keyId, role: config.role },
      privateKey, observedAt: new Date().toISOString(),
    });
  } finally { privateKey.fill(0); }
  const parent = path.dirname(options.outputFile);
  if (!samePath(await realpath(parent), parent) || !(await lstat(parent)).isDirectory()) reject('FILE_UNSAFE', 'Output parent must be an existing directory without symbolic links.');
  const output = Buffer.from(JSON.stringify(attestation, null, 2) + '\n', 'utf8');
  const handle = await open(options.outputFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (process.platform === 'linux') await handle.chmod(0o600);
    await handle.writeFile(output);
    await handle.sync();
  } finally { await handle.close(); }
  return Object.freeze({ outputPath: options.outputFile, sha256: createHash('sha256').update(output).digest('hex'), requestDigest: attestation.requestDigest, approvalId: attestation.approvalId });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  issueBusinessDataApprovalFromFiles(process.argv.slice(2)).then(
    (result) => { process.stdout.write(JSON.stringify(result) + '\n'); },
    (error) => {
      const code = /^[A-Z_]{1,80}$/u.test(error?.code ?? '') ? error.code : 'ISSUANCE_FAILED';
      process.stderr.write(JSON.stringify({ error: code, message: 'Approval issuance failed; no caller-provided identity or key was accepted.' }) + '\n');
      process.exitCode = 1;
    },
  );
}
