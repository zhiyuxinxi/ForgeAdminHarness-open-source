import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  observeForgeDeliveryPhase,
  snapshotForgeDeliveryWorkspace,
  validateForgeDeliveryWorkspaceSnapshot,
} from '../docker/harness/forge-delivery-phase-workspace-observer.mjs';

const execFile = promisify(execFileCallback);
const observerSourcePath = path.resolve('docker/harness/forge-delivery-phase-workspace-observer.mjs');

async function git(root, ...args) {
  return execFile('git', ['-C', root, ...args], { windowsHide: true });
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-phase-observer-'));
  await git(root, 'init');
  await git(root, 'config', 'user.name', 'Forge Test');
  await git(root, 'config', 'user.email', 'forge-test@example.invalid');
  await writeFile(path.join(root, 'README.md'), 'baseline\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-m', 'baseline');
  const { stdout } = await git(root, 'rev-parse', 'HEAD');
  return { root, commit: stdout.trim() };
}

test('observer derives exact per-phase and cumulative paths including untracked files', async () => {
  const { root, commit } = await repository();
  const before = await snapshotForgeDeliveryWorkspace({ workspace: root, baseCommit: commit });
  assert.deepEqual(before.changedPaths, []);

  const databasePath = 'forge-server/db/migration/V1__employee.sql';
  await mkdir(path.join(root, path.dirname(databasePath)), { recursive: true });
  await writeFile(path.join(root, databasePath), 'create table employee(id bigint);\n');
  const database = await observeForgeDeliveryPhase({ workspace: root, baseCommit: commit, before });
  assert.deepEqual(database.phaseChangedPaths, [databasePath]);
  assert.deepEqual(database.allChangedPaths, [databasePath]);
  assert.match(database.phasePatch.toString('utf8'), /V1__employee\.sql/u);
  assert.equal(database.phasePatchDigest, database.cumulativePatchDigest);

  const backendPath = 'forge-server/forge-admin-server/src/main/Employee.java';
  await mkdir(path.join(root, path.dirname(backendPath)), { recursive: true });
  await writeFile(path.join(root, backendPath), 'class Employee {}\n');
  await writeFile(path.join(root, databasePath), 'create table employee(id bigint, tenant_id bigint);\n');
  const backend = await observeForgeDeliveryPhase({
    workspace: root,
    baseCommit: commit,
    before: database.snapshot,
  });
  assert.deepEqual(backend.phaseChangedPaths, [databasePath, backendPath].sort());
  assert.deepEqual(backend.allChangedPaths, [databasePath, backendPath].sort());
  assert.notEqual(backend.phasePatchDigest, database.phasePatchDigest);
});

test('observer detects deletion of an already modified tracked file', async () => {
  const { root, commit } = await repository();
  await writeFile(path.join(root, 'README.md'), 'first phase\n');
  const before = await snapshotForgeDeliveryWorkspace({ workspace: root, baseCommit: commit });
  await writeFile(path.join(root, 'README.md'), 'second phase\n');
  const observation = await observeForgeDeliveryPhase({ workspace: root, baseCommit: commit, before });
  assert.deepEqual(observation.phaseChangedPaths, ['README.md']);
  assert.deepEqual(observation.allChangedPaths, ['README.md']);
  assert.match(observation.phasePatch.toString('utf8'), /second phase/u);
});

test('phase-origin snapshot is content-addressed and a retry reuses it instead of hiding rejected changes', async () => {
  const { root, commit } = await repository();
  const evidence = await mkdtemp(path.join(os.tmpdir(), 'forge-phase-origin-'));
  const originFile = path.join(evidence, 'origin-snapshot.json');
  const first = JSON.parse((await execFile(process.execPath, [
    observerSourcePath,
    'snapshot',
    '--workspace', root,
    '--base-commit', commit,
    '--output', originFile,
  ])).stdout);
  assert.equal(first.reused, false);

  const rejectedPath = 'forge-server/db/migration/V1__rejected_but_retained.sql';
  await mkdir(path.join(root, path.dirname(rejectedPath)), { recursive: true });
  await writeFile(path.join(root, rejectedPath), 'create table retained(id bigint);\n');
  const retry = JSON.parse((await execFile(process.execPath, [
    observerSourcePath,
    'snapshot',
    '--workspace', root,
    '--base-commit', commit,
    '--output', originFile,
  ])).stdout);
  assert.equal(retry.reused, true);
  assert.equal(retry.snapshotDigest, first.snapshotDigest);

  const retryPath = 'forge-server/db/migration/V2__retry.sql';
  await writeFile(path.join(root, retryPath), 'create table retry(id bigint);\n');
  const origin = JSON.parse(await readFile(originFile, 'utf8'));
  const observation = await observeForgeDeliveryPhase({
    workspace: root,
    baseCommit: commit,
    before: origin,
  });
  assert.deepEqual(observation.phaseChangedPaths, [rejectedPath, retryPath].sort());
  assert.deepEqual(observation.allChangedPaths, [rejectedPath, retryPath].sort());
});

test('snapshot validation rejects forged identity and cumulative-boundary fields', async () => {
  const { root, commit } = await repository();
  const snapshot = await snapshotForgeDeliveryWorkspace({ workspace: root, baseCommit: commit });
  assert.doesNotThrow(() => validateForgeDeliveryWorkspaceSnapshot(snapshot));
  for (const mutate of [
    (value) => { value.snapshotDigest = '0'.repeat(64); },
    (value) => { value.cumulativePatchDigest = '1'.repeat(64); },
    (value) => { value.changedPaths.push('forged.txt'); },
  ]) {
    const forged = structuredClone(snapshot);
    mutate(forged);
    assert.throws(
      () => validateForgeDeliveryWorkspaceSnapshot(forged),
      (error) => error.code === 'PHASE_OBSERVER_SNAPSHOT_INVALID',
    );
  }
});

test('snapshot accepts an explicitly reviewed HEAD while its default still requires the base HEAD', async () => {
  const { root, commit: baseCommit } = await repository();
  await writeFile(path.join(root, 'README.md'), 'reviewed runtime\n');
  await git(root, 'add', 'README.md');
  await git(root, 'commit', '-m', 'reviewed runtime');
  const { stdout } = await git(root, 'rev-parse', 'HEAD');
  const reviewedCommit = stdout.trim();

  const snapshot = await snapshotForgeDeliveryWorkspace({
    workspace: root,
    baseCommit,
    expectedHead: reviewedCommit,
  });
  assert.equal(snapshot.baseCommit, baseCommit);
  assert.deepEqual(snapshot.changedPaths, ['README.md']);

  await assert.rejects(
    snapshotForgeDeliveryWorkspace({ workspace: root, baseCommit }),
    (error) => error.code === 'PHASE_OBSERVER_SOURCE_DRIFT',
  );
});

test('observer evidence is group-readable for the capability-dropped controller boundary', async () => {
  const source = await readFile(observerSourcePath, 'utf8');
  assert.match(source, /open\(file, 'wx', 0o640\)/u);
  assert.doesNotMatch(source, /open\(file, 'wx', 0o6(?:04|06|14|16|24|26|34|36|44|46|54|56|64|66|74|76)\)/u);
});
