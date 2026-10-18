import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskspaceBroker } from '../docker/harness/taskspace-broker.mjs';
import { hashTaskspaceToken } from '../docker/harness/taskspace-policy.mjs';
import { normalizeRuntimeVersion, RUNTIME_ENVIRONMENT_KEYS } from '../docker/harness/harness-runtime-versions.mjs';

async function fixture() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-broker-versions-'));
  const tasks = new Map();
  for (const [index, channel] of [null, 'stable', 'enhanced'].entries()) {
    const taskId = channel ?? 'legacy';
    const root = path.join(projectRoot, 'taskspaces', taskId);
    await mkdir(root, { recursive: true });
    const token = String(index + 1).repeat(64);
    const metadata = {
      schemaVersion: 2, projectSlug: 'forge-base', taskId, actorId: 'actor-a',
      actorUserId: '11111111-1111-4111-8111-111111111111', conversationId: `conversation-${taskId}`,
      branch: `task/actor-a/${taskId}`, baseCommit: 'a'.repeat(40), status: 'active',
      createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
      accessTokenHash: hashTaskspaceToken(token), harnessPort: 21000 + index, accessMode: 'conversation',
    };
    if (channel) metadata.runtimeVersion = normalizeRuntimeVersion({
      channel, sourceBranch: channel === 'stable' ? 'codex/env-3212-ai' : 'main',
      sourceCommit: 'a'.repeat(40), harnessImage: `sha256:${'b'.repeat(64)}`,
      skillBundleRoot: path.join(projectRoot, 'runtime-versions', channel, 'skills'),
      skillBundleSha256: 'c'.repeat(64),
      brokerUrl: `http://taskspace-broker-${channel}:3100`,
      managerSocket: path.join(projectRoot, 'runtime-versions', channel, 'manager', 'manager.sock'),
      environment: Object.fromEntries(RUNTIME_ENVIRONMENT_KEYS.map(key =>
        [key, key === 'FORGE_DEVELOPMENT_MODE' ? 'direct' : 'false'])),
    }, projectRoot);
    await writeFile(path.join(root, 'metadata.json'), JSON.stringify(metadata));
    tasks.set(channel, { token, metadata });
  }
  return { projectRoot, tasks };
}

test('version Broker tokens cannot cross between stable, enhanced and legacy endpoints', async () => {
  const { projectRoot, tasks } = await fixture();
  for (const channel of [null, 'stable', 'enhanced']) {
    const broker = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: channel });
    for (const [taskChannel, task] of tasks) {
      if (channel === taskChannel) assert.equal((await broker.taskForToken(task.token)).metadata.taskId, task.metadata.taskId);
      else await assert.rejects(broker.taskForToken(task.token), { code: 'TASKSPACE_AUTHENTICATION_FAILED' });
    }
  }
});

test('version Broker tokens require the configured immutable version within the same channel', async () => {
  const { projectRoot, tasks } = await fixture();
  for (const channel of ['stable', 'enhanced']) {
    const task = tasks.get(channel);
    const broker = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: channel,
      runtimeVersionId: task.metadata.runtimeVersion.versionId });
    assert.equal((await broker.taskForToken(task.token)).metadata.taskId, task.metadata.taskId);
    const otherVersion = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: channel,
      runtimeVersionId: 'f'.repeat(64) });
    await assert.rejects(otherVersion.taskForToken(task.token), { code: 'TASKSPACE_AUTHENTICATION_FAILED' });
  }
});

test('version Broker consumes the prepared service version ID while legacy remains unbound', async t => {
  const { projectRoot, tasks } = await fixture();
  const previousVersionId = process.env.FORGE_RUNTIME_VERSION_ID;
  t.after(() => {
    if (previousVersionId === undefined) delete process.env.FORGE_RUNTIME_VERSION_ID;
    else process.env.FORGE_RUNTIME_VERSION_ID = previousVersionId;
  });
  const task = tasks.get('stable');
  process.env.FORGE_RUNTIME_VERSION_ID = 'f'.repeat(64);
  const otherVersion = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: 'stable' });
  await assert.rejects(otherVersion.taskForToken(task.token), { code: 'TASKSPACE_AUTHENTICATION_FAILED' });
  process.env.FORGE_RUNTIME_VERSION_ID = task.metadata.runtimeVersion.versionId;
  const matching = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: 'stable' });
  assert.equal((await matching.taskForToken(task.token)).metadata.taskId, task.metadata.taskId);
  const legacy = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: null });
  assert.equal((await legacy.taskForToken(tasks.get(null).token)).metadata.taskId, 'legacy');
});

test('version Broker listeners are separate while all versions keep one project release lock', async () => {
  const { projectRoot } = await fixture();
  const brokers = [null, 'stable', 'enhanced'].map(runtimeChannel =>
    new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel }));
  assert.equal(new Set(brokers.map(broker => broker.statusSocket)).size, 3);
  assert.equal(new Set(brokers.map(broker => broker.releaseLockRoot)).size, 1);
  assert.equal(brokers[0].statusSocket, path.join(projectRoot, 'taskspaces', '.broker', 'project-status.sock'));
  const explicit = path.join(projectRoot, 'runtime-versions', 'stable', 'status.sock');
  assert.equal(new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: 'stable', statusSocket: explicit }).statusSocket, explicit);
  assert.throws(() => new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: 'main' }), /runtime channel/);
  assert.throws(() => new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', statusSocket: 'relative.sock' }), /absolute/);
});

test('stale shared release locks are never recovered using a different runtime Runner', async () => {
  for (const [ownerChannel, requesterChannel] of [['stable', 'enhanced'], ['enhanced', 'stable'], [null, 'stable'], ['stable', null]]) {
    const { projectRoot, tasks } = await fixture();
    const owner = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: ownerChannel });
    await owner.acquireProjectReleaseLock('operation-owner', tasks.get(ownerChannel), 'release');
    const original = await readFile(owner.releaseLockOwnerFile, 'utf8');
    let diagnoses = 0;
    const peer = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: requesterChannel,
      staleLockAfterMs: 0, releaseClient: async () => { diagnoses++; return { active: false }; } });
    await assert.rejects(peer.acquireProjectReleaseLock('operation-peer', tasks.get(requesterChannel), 'release'),
      { code: 'TASKSPACE_RELEASE_IN_PROGRESS' });
    assert.equal(diagnoses, 0);
    assert.equal(await readFile(owner.releaseLockOwnerFile, 'utf8'), original);
  }
});

test('a same-version stale lock is recovered only after its bound Runner confirms idle', async () => {
  const { projectRoot, tasks } = await fixture();
  const task = tasks.get('stable');
  const runtimeVersionId = task.metadata.runtimeVersion.versionId;
  const owner = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: 'stable', runtimeVersionId });
  await owner.acquireProjectReleaseLock('operation-owner', task, 'release');
  assert.equal(JSON.parse(await readFile(owner.releaseLockOwnerFile, 'utf8')).runtimeChannel, 'stable');
  assert.equal(JSON.parse(await readFile(owner.releaseLockOwnerFile, 'utf8')).runtimeVersionId, runtimeVersionId);
  let active = true;
  const peer = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: 'stable', runtimeVersionId, staleLockAfterMs: 0,
    releaseClient: async request => { assert.equal(request.action, 'diagnose'); return { active }; } });
  await assert.rejects(peer.acquireProjectReleaseLock('operation-peer', task, 'release'), { code: 'TASKSPACE_RELEASE_IN_PROGRESS' });
  active = false;
  await peer.acquireProjectReleaseLock('operation-peer', task, 'release');
  const saved = JSON.parse(await readFile(peer.releaseLockOwnerFile, 'utf8'));
  assert.equal(saved.operationId, 'operation-peer');
  assert.equal(saved.runtimeChannel, 'stable');
  assert.equal(saved.runtimeVersionId, runtimeVersionId);
});

test('a version-bound Broker preserves same-channel stale locks with another or missing version ID', async () => {
  for (const ownerVersionId of ['f'.repeat(64), null]) {
    const { projectRoot, tasks } = await fixture();
    const task = tasks.get('stable');
    const owner = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: 'stable',
      runtimeVersionId: ownerVersionId });
    await owner.acquireProjectReleaseLock('operation-owner', task, 'release');
    const original = await readFile(owner.releaseLockOwnerFile, 'utf8');
    let diagnoses = 0;
    const peer = new TaskspaceBroker({ projectRoot, projectSlug: 'forge-base', runtimeChannel: 'stable',
      runtimeVersionId: task.metadata.runtimeVersion.versionId, staleLockAfterMs: 0,
      releaseClient: async () => { diagnoses++; return { active: false }; } });
    await assert.rejects(peer.acquireProjectReleaseLock('operation-peer', task, 'release'),
      { code: 'TASKSPACE_RELEASE_IN_PROGRESS' });
    assert.equal(diagnoses, 0);
    assert.equal(await readFile(owner.releaseLockOwnerFile, 'utf8'), original);
  }
});
