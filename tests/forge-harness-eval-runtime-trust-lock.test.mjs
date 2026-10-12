import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const verifier = path.join(repoRoot, 'scripts', 'verify-forge-harness-eval-runtime-lock.mjs');
const lockRelative = 'tests/fixtures/forge-harness-behavior-evals/runtime-trust-lock.json';
const lockPath = path.join(repoRoot, ...lockRelative.split('/'));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function runnerSha256(root = repoRoot) {
  return sha256(await readFile(path.join(root, 'scripts', 'run-local-forge-harness-evals.sh')));
}

function verify(root, lock, runnerSha) {
  return spawnSync(process.execPath, [
    verifier,
    'verify',
    '--repository-root', root,
    '--lock', lock,
    '--expected-runner-sha256', runnerSha,
  ], { encoding: 'utf8', windowsHide: true });
}

async function copyLockedRuntime() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-hbe-runtime-lock-'));
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  for (const entry of lock.entries) {
    const source = path.join(repoRoot, ...entry.path.split('/'));
    const target = path.join(temporaryRoot, ...entry.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  const targetLock = path.join(temporaryRoot, ...lockRelative.split('/'));
  await mkdir(path.dirname(targetLock), { recursive: true });
  await copyFile(lockPath, targetLock);
  return { temporaryRoot, targetLock, lock };
}

test('the tracked runtime package lock verifies the exact paid-eval runtime closure', async () => {
  const result = verify(repoRoot, lockPath, await runnerSha256());
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.schemaVersion, 'forge-harness-eval-runtime-trust-receipt/v1');
  assert.equal(receipt.packageId, 'forge-admin-harness/forge-harness-behavior-eval-runtime');
  assert.equal(receipt.packageVersion, '2026.09.14.3');
  assert.equal(receipt.entryCount, 91);
  assert.equal(receipt.contentAddressed, true);
  assert.equal(receipt.gitCommitIdentityProven, false);
  assert.equal(receipt.signedAttestation, false);
  assert.equal(receipt.sameHostMaliciousTamperingExcluded, false);
  assert.match(receipt.lockSha256, /^[0-9a-f]{64}$/);
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  for (const relative of [
    'docker/harness/forge-production-task-grant.mjs',
    'tests/forge-production-task-grant.test.mjs',
  ]) {
    const entry = lock.entries.find((item) => item.path === relative);
    const bytes = await readFile(path.join(repoRoot, ...relative.split('/')));
    assert.equal(entry?.sha256, sha256(bytes));
    assert.equal(entry?.bytes, bytes.length);
  }
});

test('the runtime package lock rejects changed trusted content', async () => {
  const fixture = await copyLockedRuntime();
  try {
    const analyzer = path.join(fixture.temporaryRoot, 'scripts', 'analyze-forge-harness-session.mjs');
    await writeFile(analyzer, `${await readFile(analyzer, 'utf8')}\n// unexpected drift\n`);
    const result = verify(fixture.temporaryRoot, fixture.targetLock, await runnerSha256(fixture.temporaryRoot));
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Runtime trust content does not match the external lock.\n');
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

for (const mutation of ['missing', 'duplicate', 'extra']) {
  test(`the runtime package lock rejects a ${mutation} inventory entry`, async () => {
    const fixture = await copyLockedRuntime();
    try {
      if (mutation === 'missing') fixture.lock.entries.pop();
      if (mutation === 'duplicate') fixture.lock.entries.push({ ...fixture.lock.entries[0] });
      if (mutation === 'extra') fixture.lock.entries.push({
        path: 'scripts/not-admitted.mjs', sha256: '0'.repeat(64), bytes: 1,
      });
      await writeFile(fixture.targetLock, `${JSON.stringify(fixture.lock, null, 2)}\n`);
      const result = verify(fixture.temporaryRoot, fixture.targetLock, await runnerSha256(fixture.temporaryRoot));
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'Runtime trust lock is invalid or changed while being read.\n');
    } finally {
      await rm(fixture.temporaryRoot, { recursive: true, force: true });
    }
  });
}

test('the runtime package lock rejects an independently supplied runner digest', async () => {
  const result = verify(repoRoot, lockPath, '0'.repeat(64));
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'Runtime trust content does not match the external lock.\n');
});

test('the runtime package lock rejects a symlinked lock file when the host permits symlinks', async (t) => {
  const fixture = await copyLockedRuntime();
  try {
    const realLock = `${fixture.targetLock}.real`;
    await copyFile(fixture.targetLock, realLock);
    await rm(fixture.targetLock);
    try {
      await symlink(realLock, fixture.targetLock, 'file');
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        t.skip('Windows symbolic-link privilege is unavailable');
        return;
      }
      throw error;
    }
    const result = verify(fixture.temporaryRoot, fixture.targetLock, await runnerSha256(fixture.temporaryRoot));
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Runtime trust lock is invalid or changed while being read.\n');
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});
