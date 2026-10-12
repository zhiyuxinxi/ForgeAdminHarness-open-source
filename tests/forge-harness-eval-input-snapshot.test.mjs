import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testRoot, '..');
const helperPath = path.join(repoRoot, 'scripts', 'snapshot-forge-harness-eval-inputs.mjs');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function withTemporaryRoot(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-eval-input-snapshot-'));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createSyntheticInputs(root, overrides = {}) {
  const inputRoot = path.join(root, 'synthetic-inputs');
  const promptsRoot = path.join(inputRoot, 'prompts');
  await mkdir(promptsRoot, { recursive: true });
  const patch = Buffer.from('id: synthetic-headless-patch\n', 'utf8');
  const executionPolicy = Buffer.from('{"schemaVersion":1,"policyMode":"test-shadow"}\n', 'utf8');
  const promptA = Buffer.from('Synthetic prompt A: no credentials.\n', 'utf8');
  const promptB = Buffer.from('Synthetic prompt B: validate the closure.\n', 'utf8');
  const analyzer = Buffer.from('#!/usr/bin/env node\nprocess.exitCode = 0;\n', 'utf8');
  await writeFile(path.join(inputRoot, 'headless.patch.yml'), patch, { mode: 0o600 });
  await writeFile(path.join(inputRoot, 'execution-policy.json'), executionPolicy, { mode: 0o600 });
  await writeFile(path.join(promptsRoot, 'alpha.v1.md'), promptA, { mode: 0o600 });
  await writeFile(path.join(promptsRoot, 'beta.v1.md'), promptB, { mode: 0o600 });
  const analyzerPath = path.join(root, 'synthetic-analyzer.mjs');
  await writeFile(analyzerPath, analyzer, { mode: 0o600 });

  const suite = {
    schemaVersion: 1,
    suiteVersion: 'synthetic.1',
    source: { project: 'Synthetic Forge', version: 'v0', commit: '1'.repeat(40) },
    dsh: {
      patch: 'headless.patch.yml',
      patchSha256: sha256(patch),
      executionPolicy: 'execution-policy.json',
      executionPolicySha256: sha256(executionPolicy),
      modelContract: {
        upstreamOrigin: 'https://example.invalid',
        requestModel: 'synthetic-model',
        maxOutputTokensPerRequest: 1024,
      },
    },
    cases: [
      { id: 'alpha', prompt: 'prompts/alpha.v1.md', promptSha256: sha256(promptA) },
      { id: 'beta', prompt: 'prompts/beta.v1.md', promptSha256: sha256(promptB) },
    ],
    ...overrides,
  };
  const suiteBytes = Buffer.from(`${JSON.stringify(suite, null, 2)}\n`, 'utf8');
  const suitePath = path.join(inputRoot, 'suite.json');
  await writeFile(suitePath, suiteBytes, { mode: 0o600 });
  return {
    analyzer,
    analyzerPath,
    analyzerSha256: sha256(analyzer),
    inputRoot,
    promptA,
    suite,
    suiteBytes,
    suitePath,
    suiteSha256: sha256(suiteBytes),
  };
}

function runCreate(inputs, destination, anchors = {}) {
  return spawnSync(process.execPath, [
    helperPath,
    'create',
    '--suite', inputs.suitePath,
    '--suite-sha256', anchors.suiteSha256 ?? inputs.suiteSha256,
    '--analyzer', inputs.analyzerPath,
    '--analyzer-sha256', anchors.analyzerSha256 ?? inputs.analyzerSha256,
    '--destination', destination,
  ], { encoding: 'utf8' });
}

function runVerify(inputs, snapshot, anchors = {}) {
  return spawnSync(process.execPath, [
    helperPath,
    'verify',
    '--snapshot', snapshot,
    '--suite-sha256', anchors.suiteSha256 ?? inputs.suiteSha256,
    '--analyzer-sha256', anchors.analyzerSha256 ?? inputs.analyzerSha256,
  ], { encoding: 'utf8' });
}

function assertNoDisclosure(result, values) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  for (const value of values) assert.equal(output.includes(value), false);
}

async function listTree(root, prefix = '') {
  const output = [];
  for (const item of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) output.push(...await listTree(path.join(root, item.name), relative));
    else output.push(relative);
  }
  return output;
}

test('create produces a deterministic, permission-restricted, complete input closure', async () => {
  await withTemporaryRoot(async (root) => {
    const inputs = await createSyntheticInputs(root);
    const snapshotA = path.join(root, 'snapshot-a');
    const snapshotB = path.join(root, 'snapshot-b');

    const first = runCreate(inputs, snapshotA);
    const second = runCreate(inputs, snapshotB);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, '');
    assert.equal(first.stderr, '');
    const verified = runVerify(inputs, snapshotA);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(verified.stdout, '');
    assert.equal(verified.stderr, '');
    const expectedTree = [
      'analyzer.mjs',
      'input-lock.json',
      'suite/execution-policy.json',
      'suite/headless.patch.yml',
      'suite/prompts/alpha.v1.md',
      'suite/prompts/beta.v1.md',
      'suite/suite.json',
    ];
    assert.deepEqual(await listTree(snapshotA), expectedTree);
    assert.deepEqual(await listTree(snapshotB), expectedTree);
    assert.deepEqual(await readFile(path.join(snapshotA, 'input-lock.json')), await readFile(path.join(snapshotB, 'input-lock.json')));

    const lock = JSON.parse(await readFile(path.join(snapshotA, 'input-lock.json'), 'utf8'));
    assert.equal(lock.schemaVersion, 'forge-harness-eval-input-lock/v1');
    assert.equal(lock.suiteVersion, 'synthetic.1');
    assert.equal(lock.sourceCommit, '1'.repeat(40));
    assert.deepEqual(lock.modelContract, {
      maxOutputTokensPerRequest: 1024,
      requestModel: 'synthetic-model',
      upstreamOrigin: 'https://example.invalid',
    });
    assert.match(lock.closureDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(lock.entries.map((item) => item.path), expectedTree.filter((item) => item !== 'input-lock.json'));
    for (const item of lock.entries) {
      const bytes = await readFile(path.join(snapshotA, ...item.path.split('/')));
      assert.equal(item.bytes, bytes.length);
      assert.equal(item.sha256, sha256(bytes));
    }

    if (process.platform !== 'win32') {
      for (const directory of [snapshotA, path.join(snapshotA, 'suite'), path.join(snapshotA, 'suite', 'prompts')]) {
        assert.equal((await stat(directory)).mode & 0o7777, 0o700);
      }
      for (const file of expectedTree) assert.equal((await stat(path.join(snapshotA, ...file.split('/')))).mode & 0o7777, 0o400);
    }
  });
});

test('create requires fixed suite and analyzer anchors and never leaks input data on failure', async (t) => {
  await withTemporaryRoot(async (root) => {
    const inputs = await createSyntheticInputs(root);
    for (const mismatch of ['suite', 'analyzer']) {
      await t.test(mismatch, () => {
        const destination = path.join(root, `mismatch-${mismatch}`);
        const result = runCreate(inputs, destination, mismatch === 'suite'
          ? { suiteSha256: '0'.repeat(64) }
          : { analyzerSha256: '0'.repeat(64) });
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(destination), false);
        assertNoDisclosure(result, [inputs.suitePath, inputs.analyzerPath, inputs.promptA.toString('utf8').trim()]);
      });
    }
  });
});

test('suite-declared patch and every prompt hash form a mandatory safe relative-path closure', async (t) => {
  await t.test('declared prompt hash mismatch', async () => {
    await withTemporaryRoot(async (root) => {
      const inputs = await createSyntheticInputs(root);
      const suite = JSON.parse(inputs.suiteBytes.toString('utf8'));
      suite.cases[0].promptSha256 = '0'.repeat(64);
      const bytes = Buffer.from(`${JSON.stringify(suite, null, 2)}\n`);
      await writeFile(inputs.suitePath, bytes, { mode: 0o600 });
      inputs.suiteSha256 = sha256(bytes);
      const destination = path.join(root, 'snapshot');

      const result = runCreate(inputs, destination);

      assert.notEqual(result.status, 0);
      assert.equal(existsSync(destination), false);
    });
  });

  await t.test('parent traversal in a prompt path', async () => {
    await withTemporaryRoot(async (root) => {
      const inputs = await createSyntheticInputs(root);
      const suite = JSON.parse(inputs.suiteBytes.toString('utf8'));
      suite.cases[0].prompt = '../outside.md';
      const bytes = Buffer.from(`${JSON.stringify(suite, null, 2)}\n`);
      await writeFile(inputs.suitePath, bytes, { mode: 0o600 });
      inputs.suiteSha256 = sha256(bytes);
      const destination = path.join(root, 'snapshot');

      const result = runCreate(inputs, destination);

      assert.notEqual(result.status, 0);
      assert.equal(existsSync(destination), false);
    });
  });
});

test('verify accepts the exact closure and rejects content, lock, anchor, and extra-node changes', async (t) => {
  for (const scenario of ['content', 'lock', 'anchor', 'extra-file', 'extra-directory']) {
    await t.test(scenario, async () => {
      await withTemporaryRoot(async (root) => {
        const inputs = await createSyntheticInputs(root);
        const snapshot = path.join(root, 'snapshot');
        assert.equal(runCreate(inputs, snapshot).status, 0);

        if (scenario === 'content') {
          const target = path.join(snapshot, 'suite', 'prompts', 'alpha.v1.md');
          await chmod(target, 0o600);
          await writeFile(target, 'modified synthetic prompt\n', { mode: 0o600 });
          if (process.platform !== 'win32') await chmod(target, 0o400);
        } else if (scenario === 'lock') {
          const target = path.join(snapshot, 'input-lock.json');
          await chmod(target, 0o600);
          const lock = JSON.parse(await readFile(target, 'utf8'));
          lock.closureDigest = '0'.repeat(64);
          await writeFile(target, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
          if (process.platform !== 'win32') await chmod(target, 0o400);
        } else if (scenario === 'extra-file') {
          const target = path.join(snapshot, 'extra.fixture');
          await writeFile(target, 'extra', { mode: 0o600 });
          if (process.platform !== 'win32') await chmod(target, 0o400);
        } else if (scenario === 'extra-directory') {
          await mkdir(path.join(snapshot, 'extra-directory'), { mode: 0o700 });
        }

        const result = runVerify(inputs, snapshot, scenario === 'anchor'
          ? { analyzerSha256: '0'.repeat(64) }
          : {});
        assert.notEqual(result.status, 0);
        assertNoDisclosure(result, [snapshot, inputs.promptA.toString('utf8').trim()]);
      });
    });
  }
});

test('verify rejects every symbolic link in the snapshot tree', async (t) => {
  await withTemporaryRoot(async (root) => {
    const inputs = await createSyntheticInputs(root);
    const snapshot = path.join(root, 'snapshot');
    assert.equal(runCreate(inputs, snapshot).status, 0);
    const link = path.join(snapshot, 'linked.fixture');
    try {
      await symlink(path.join(snapshot, 'analyzer.mjs'), link, 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('Creating file symlinks is not permitted by this Windows host.');
        return;
      }
      throw error;
    }

    const result = runVerify(inputs, snapshot);

    assert.notEqual(result.status, 0);
    assertNoDisclosure(result, [snapshot]);
  });
});

test('create refuses an existing destination directory', async () => {
  await withTemporaryRoot(async (root) => {
    const inputs = await createSyntheticInputs(root);
    const snapshot = path.join(root, 'snapshot');
    await mkdir(snapshot, { mode: 0o700 });

    const result = runCreate(inputs, snapshot);

    assert.notEqual(result.status, 0);
    assert.deepEqual(await readdir(snapshot), []);
    assertNoDisclosure(result, [snapshot, inputs.suitePath]);
  });
});
