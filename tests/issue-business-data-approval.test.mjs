import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, unlink, rmdir, stat } from 'node:fs/promises';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { issueBusinessDataApprovalFromFiles, parseBusinessDataApprovalIssuerArguments } from '../scripts/issue-business-data-approval.mjs';

function args() {
  return ['--preview-file', path.resolve('preview.json'), '--issuer-config', path.resolve('issuer.json'), '--out', path.resolve('attestation.json')];
}

test('AUTHZ003 operator CLI accepts only file paths and optional bounded expiry syntax', () => {
  const parsed = parseBusinessDataApprovalIssuerArguments([...args(), '--expires-at', '2026-10-03T10:00:00.000Z']);
  assert.deepEqual(parsed, { previewFile: path.resolve('preview.json'), issuerConfig: path.resolve('issuer.json'), outputFile: path.resolve('attestation.json'), expiresAt: '2026-10-03T10:00:00.000Z' });
  assert.ok(Object.isFrozen(parsed));
  assert.equal(Object.hasOwn(parseBusinessDataApprovalIssuerArguments(args()), 'expiresAt'), false);
});

test('AUTHZ003 operator CLI rejects caller identities, keys, decisions, duplicate flags, ambiguous paths and clock overrides', () => {
  for (const invalid of [
    [], args().slice(0, -1), [...args(), '--issuer', 'caller'], [...args(), '--decision', 'approved'],
    [...args(), '--private-key', 'caller-key'], [...args(), '--public-key', 'caller-key'],
    [...args(), '--approved-at', '2026-10-03T10:00:00.000Z'], [...args(), '--observed-at', '2026-10-03T10:00:00.000Z'],
    [...args(), '--approval-id', 'caller-id'], [...args(), '--out', path.resolve('another.json')],
    [...args(), '--expires-at', '2026-10-03T10:00:00Z'], [...args(), '--expires-at', 'invalid'],
    ['--preview-file', 'relative.json', ...args().slice(2)],
    ['--preview-file', path.resolve('preview.json'), '--issuer-config', path.resolve('issuer.json'), '--out', path.resolve('preview.json')],
    ['--preview-file', path.resolve('preview.json'), '--issuer-config', path.resolve('issuer.json'), '--out', path.resolve('issuer.json')],
  ]) assert.throws(() => parseBusinessDataApprovalIssuerArguments(invalid), { code: 'ARGUMENT_INVALID' });
});

test('AUTHZ003 operator CLI rejects invalid invocation before touching files and prints no supplied values', () => {
  const script = fileURLToPath(new URL('../scripts/issue-business-data-approval.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, ...args(), '--private-key', 'DO_NOT_PRINT_PRIVATE_MATERIAL'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error, 'ARGUMENT_INVALID');
  assert.equal(result.stderr.includes('DO_NOT_PRINT_PRIVATE_MATERIAL'), false);
});

test('AUTHZ003 operator CLI checks real Windows owner and DACL before reading a configured key', { skip: process.platform !== 'win32' }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'forge-approval-cli-'));
  const previewFile = path.join(folder, 'preview.json');
  const issuerConfig = path.join(folder, 'issuer.json');
  const privateKeyFile = path.join(folder, 'private-key.pem');
  const outputFile = path.join(folder, 'attestation.json');
  const invocation = ['--preview-file', previewFile, '--issuer-config', issuerConfig, '--out', outputFile];
  const aclScript = String.raw`& {
    $ErrorActionPreference = 'Stop'
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    foreach ($file in $request.files) {
      $acl = [Security.AccessControl.FileSecurity]::new()
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true, $false)
      $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
      Set-Acl -LiteralPath $file -AclObject $acl
    }
  }`;
  const setAcl = (files) => {
    const result = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', aclScript], {
      input: JSON.stringify({ files }), encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
    });
    assert.equal(result.status, 0, `Temporary test ACL setup failed: ${String(result.stderr).slice(0, 1800)}`);
  };
  const setEveryoneRead = (file, enabled) => {
    const result = spawnSync('C:\\Windows\\System32\\icacls.exe', [file, ...(enabled ? ['/grant', '*S-1-1-0:(R)'] : ['/remove:g', '*S-1-1-0'])], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(result.status, 0, 'Temporary test DACL-only update failed.');
  };
  try {
    await writeFile(previewFile, JSON.stringify({ request: {} }));
    await writeFile(issuerConfig, JSON.stringify({ privateKeyFile, subjectId: 'protected-owner', keyId: 'test-key', role: 'business-data-approver' }));
    await writeFile(privateKeyFile, 'NOT_A_PRIVATE_KEY_NO_APPROVAL_CAN_BE_ISSUED');
    setAcl([issuerConfig, privateKeyFile]);
    // Reaching request validation proves both protected file checks succeeded.
    // No key pair or valid request is present and no approval is issued.
    await assert.rejects(issueBusinessDataApprovalFromFiles(invocation), { code: 'SCHEMA_INVALID' });
    setEveryoneRead(privateKeyFile, true);
    await assert.rejects(issueBusinessDataApprovalFromFiles(invocation), { code: 'FILE_UNSAFE' });
    setEveryoneRead(privateKeyFile, false);
    setEveryoneRead(issuerConfig, true);
    await assert.rejects(issueBusinessDataApprovalFromFiles(invocation), { code: 'FILE_UNSAFE' });
    await assert.rejects(stat(outputFile), { code: 'ENOENT' });
  } finally {
    for (const file of [previewFile, issuerConfig, privateKeyFile]) await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(folder);
  }
});
