import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  MAX_SECRET_BYTES,
  generateLocalSecret,
  snapshotLocalSecret,
} from '../scripts/snapshot-local-secret.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testRoot, '..');
const helperPath = path.join(repoRoot, 'scripts', 'snapshot-local-secret.mjs');

test('generated bearer secrets use the same exclusive protected destination contract', async () => {
  await withTemporaryRoot(async (root) => {
    const destination = path.join(root, 'generated.snapshot');
    await generateLocalSecret({ bytes: 32, destination });
    const value = await readFile(destination, 'utf8');
    assert.match(value, /^[0-9a-f]{64}\n$/u);
    if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
    await assert.rejects(generateLocalSecret({ bytes: 32, destination }));
  });
});

function runHelper(source, destination) {
  return spawnSync(process.execPath, [
    helperPath,
    '--source', source,
    '--destination', destination,
  ], { encoding: 'utf8' });
}

function inspectWindowsPrivateAcl(target) {
  const script = String.raw`& {
    $ErrorActionPreference = 'Stop'
    $targetPath = $env:FORGE_SECRET_SNAPSHOT_TARGET
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = Get-Acl -LiteralPath $targetPath
    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    $validRule = $rules.Count -eq 1 -and -not $rules[0].IsInherited -and $rules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $rules[0].IdentityReference.Value -eq $sid.Value -and (($rules[0].FileSystemRights -band $fullControl) -eq $fullControl)
    [Console]::Out.Write((@{ protected = $acl.AreAccessRulesProtected; ownerMatches = $ownerSid -eq $sid.Value; validRule = $validRule } | ConvertTo-Json -Compress))
  }`;
  const env = Object.assign(
    Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
    { FORGE_SECRET_SNAPSHOT_TARGET: target },
  );
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertNoDisclosure(result, sensitiveValues) {
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  for (const value of sensitiveValues) assert.doesNotMatch(combined, new RegExp(escapeRegex(value)));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function withTemporaryRoot(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-secret-snapshot-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('CLI creates an exclusive byte-for-byte snapshot without disclosing content or paths', async () => {
  await withTemporaryRoot(async (root) => {
    const source = path.join(root, 'source.fixture');
    const destination = path.join(root, 'snapshot.fixture');
    const syntheticSecret = 'synthetic-fixture-value-7f4d2a\n';
    await writeFile(source, syntheticSecret, { mode: 0o600 });

    const result = runHelper(source, destination);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(await readFile(destination, 'utf8'), syntheticSecret);
    assert.equal((await lstat(destination)).isSymbolicLink(), false);
    assert.equal((await stat(destination)).isFile(), true);
    if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o7777, 0o600);
    else assert.deepEqual(inspectWindowsPrivateAcl(destination), {
      protected: true,
      ownerMatches: true,
      validRule: true,
    });
    assertNoDisclosure(result, [syntheticSecret.trim(), source, destination]);
  });
});

test('CLI rejects a symbolic-link source and never creates the destination', async (t) => {
  await withTemporaryRoot(async (root) => {
    const target = path.join(root, 'target.fixture');
    const source = path.join(root, 'source-link.fixture');
    const destination = path.join(root, 'snapshot.fixture');
    const syntheticSecret = 'synthetic-symlink-fixture';
    await writeFile(target, syntheticSecret, { mode: 0o600 });
    try {
      await symlink(target, source, 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('Creating file symlinks is not permitted by this Windows host.');
        return;
      }
      throw error;
    }

    const result = runHelper(source, destination);

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(destination), false);
    assertNoDisclosure(result, [syntheticSecret, source, target, destination]);
  });
});

test('CLI refuses to overwrite an existing destination and preserves its bytes', async () => {
  await withTemporaryRoot(async (root) => {
    const source = path.join(root, 'source.fixture');
    const destination = path.join(root, 'snapshot.fixture');
    const syntheticSecret = 'synthetic-source-fixture';
    const sentinel = 'preexisting-destination-sentinel';
    await writeFile(source, syntheticSecret, { mode: 0o600 });
    await writeFile(destination, sentinel, { mode: 0o600 });

    const result = runHelper(source, destination);

    assert.notEqual(result.status, 0);
    assert.equal(await readFile(destination, 'utf8'), sentinel);
    assertNoDisclosure(result, [syntheticSecret, sentinel, source, destination]);
  });
});

test('CLI rejects empty and oversized sources before creating a destination', async (t) => {
  await withTemporaryRoot(async (root) => {
    for (const fixture of [
      { name: 'empty', content: Buffer.alloc(0) },
      { name: 'oversized', content: Buffer.alloc(MAX_SECRET_BYTES + 1, 0x61) },
    ]) {
      await t.test(fixture.name, async () => {
        const source = path.join(root, `${fixture.name}.fixture`);
        const destination = path.join(root, `${fixture.name}.snapshot`);
        await writeFile(source, fixture.content, { mode: 0o600 });

        const result = runHelper(source, destination);

        assert.notEqual(result.status, 0);
        assert.equal(existsSync(destination), false);
        assertNoDisclosure(result, [source, destination]);
      });
    }
  });
});

test('inclusive source-size boundaries of 1 and 16384 bytes are accepted', async (t) => {
  await withTemporaryRoot(async (root) => {
    for (const size of [1, MAX_SECRET_BYTES]) {
      await t.test(`${size} bytes`, async () => {
        const source = path.join(root, `boundary-${size}.fixture`);
        const destination = path.join(root, `boundary-${size}.snapshot`);
        const content = Buffer.alloc(size, 0x62);
        await writeFile(source, content, { mode: 0o600 });

        await snapshotLocalSecret({ source, destination });

        assert.equal((await stat(destination)).size, size);
        assert.deepEqual(await readFile(destination), content);
      });
    }
  });
});

test('stable-source checks reject detectable metadata and identity changes between FD reads', async (t) => {
  await t.test('same-inode, same-length content mutation', async () => {
    await withTemporaryRoot(async (root) => {
      const source = path.join(root, 'source.fixture');
      const destination = path.join(root, 'snapshot.fixture');
      await writeFile(source, 'fixture-before-value', { mode: 0o600 });

      await assert.rejects(
        snapshotLocalSecret({ source, destination }, {
          afterFirstRead: async () => writeFile(source, 'fixture-after-value!', { mode: 0o600 }),
        }),
        (error) => error?.code === 'SNAPSHOT_SOURCE_CHANGED',
      );
      assert.equal(existsSync(destination), false);
    });
  });

  await t.test('path identity replacement', async () => {
    await withTemporaryRoot(async (root) => {
      const source = path.join(root, 'source.fixture');
      const displaced = path.join(root, 'source-displaced.fixture');
      const destination = path.join(root, 'snapshot.fixture');
      await writeFile(source, 'fixture-stable-value', { mode: 0o600 });

      await assert.rejects(
        snapshotLocalSecret({ source, destination }, {
          afterFirstRead: async () => {
            await rename(source, displaced);
            await writeFile(source, 'fixture-stable-value', { mode: 0o600 });
          },
        }),
        (error) => error?.code === 'SNAPSHOT_SOURCE_CHANGED',
      );
      assert.equal(existsSync(destination), false);
    });
  });
});
