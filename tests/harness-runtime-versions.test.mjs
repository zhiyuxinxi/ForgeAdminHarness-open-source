import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { loadRuntimeVersions, resolveRuntimeVersion, normalizeRuntimeVersion, publicRuntimeVersion,
  RUNTIME_ENVIRONMENT_KEYS } from '../docker/harness/harness-runtime-versions.mjs';
import { routeRuntimeManagerRequest } from '../docker/harness/runtime-manager-routing.mjs';

function entry(root, channel = 'stable') {
  const base = path.join(root, 'runtime-versions', channel, 'release-1');
  return { channel, sourceBranch: channel === 'stable' ? '32.12' : 'main',
    sourceCommit: 'a'.repeat(40), harnessImage: `sha256:${'b'.repeat(64)}`,
    skillBundleRoot: path.join(base, 'skills'), skillBundleSha256: 'c'.repeat(64),
    managerSocket: path.join(base, 'manager', 'manager.sock'), brokerUrl: `http://taskspace-broker-${channel}:3100`,
    environment: Object.fromEntries(RUNTIME_ENVIRONMENT_KEYS.map(key => [key, key === 'FORGE_DEVELOPMENT_MODE' ? 'direct' : 'false'])) };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'ops'));
  const file = path.join(root, 'ops', 'harness-runtime-versions.json');
  const catalog = { schemaVersion: 1, defaultChannel: 'stable', versions: [entry(root), entry(root, 'enhanced')] };
  await writeFile(file, JSON.stringify(catalog));
  return { root, file, catalog };
}
test('installed channels have fixed branch, image, bundle and reproducible identity', async t => {
  const { file } = await fixture(t);
  const catalog = await loadRuntimeVersions(file);
  assert.equal(catalog.versions.length, 2);
  const stable = await resolveRuntimeVersion(file, 'stable');
  assert.equal(stable.versionId, catalog.versions[0].versionId);
  const visible = publicRuntimeVersion(stable);
  assert.equal(visible.sourceBranch, '32.12');
  assert.equal(visible.skillBundleRoot, undefined);
  assert.equal(visible.managerSocket, undefined);
});
test('renamed stable branch preserves existing legacy snapshots and their identity', async t => {
  const { root } = await fixture(t);
  const legacy = normalizeRuntimeVersion({ ...entry(root), sourceBranch: 'codex/env-3212-ai' }, root);
  assert.equal(legacy.sourceBranch, 'codex/env-3212-ai');
  assert.deepEqual(normalizeRuntimeVersion(legacy, root), legacy);
  const renamed = normalizeRuntimeVersion(entry(root), root);
  assert.equal(renamed.sourceBranch, '32.12');
  assert.notEqual(renamed.versionId, legacy.versionId);
  assert.throws(() => normalizeRuntimeVersion({ ...legacy, sourceBranch: '32.12' }, root),
    { code: 'RUNTIME_CATALOG_INVALID' });
});

test('changed catalog cannot silently replace a staged selection', async t => {
  const { file, catalog } = await fixture(t);
  const stable = await resolveRuntimeVersion(file, 'stable');
  catalog.versions[0].sourceCommit = 'd'.repeat(40);
  await writeFile(file, JSON.stringify(catalog));
  await assert.rejects(resolveRuntimeVersion(file, 'stable', stable.versionId), { code: 'RUNTIME_VERSION_CHANGED', status: 409 });
});
test('reject mutable images, crossed branches, outside paths, unsafe endpoints and environment injection', async t => {
  const { root } = await fixture(t);
  for (const patch of [{ harnessImage: 'harness:latest' }, { sourceBranch: 'main' },
    { skillBundleRoot: path.join(root, 'outside') }, { managerSocket: path.join(root, 'other', 'socket') },
    { brokerUrl: 'http://external.example:3100' }, { environment: { ...entry(root).environment, LD_PRELOAD: 'x' } },
    { environment: { ...entry(root).environment, FORGE_SEMANTIC_INTENT_ENABLED: 'true\nX=bad' } }]) {
    assert.throws(() => normalizeRuntimeVersion({ ...entry(root), ...patch }, root), { code: 'RUNTIME_CATALOG_INVALID' });
  }
});
test('missing catalog remains legacy-compatible but explicit selection fails', async t => {
  const { file } = await fixture(t);
  await rm(file);
  assert.deepEqual(await loadRuntimeVersions(file), { defaultChannel: null, versions: [] });
  await assert.rejects(resolveRuntimeVersion(file, 'stable'), { code: 'RUNTIME_VERSION_UNAVAILABLE' });
  await assert.rejects(resolveRuntimeVersion(file, 'other'), { code: 'INVALID_RUNTIME_CHANNEL' });
});
test('version manager admits only its bound task; legacy tasks stay with legacy service', async t => {
  const { root } = await fixture(t);
  const version = normalizeRuntimeVersion(entry(root), root);
  const input = { request: { url: '/v1/taskspaces/task-one/start', method: 'POST' }, response: {},
    projectRoot: root, runtimeChannel: 'stable', runtimeVersionId: version.versionId,
    readMetadata: async () => ({ runtimeVersion: version }), readBody: async () => ({}), managerToken: 'token' };
  assert.equal(await routeRuntimeManagerRequest(input), false);
  await assert.rejects(routeRuntimeManagerRequest({ ...input, runtimeChannel: 'enhanced' }), { code: 'RUNTIME_VERSION_MISMATCH' });
  await assert.rejects(routeRuntimeManagerRequest({ ...input, readMetadata: async () => ({}) }), { code: 'RUNTIME_VERSION_MISMATCH' });
  assert.equal(await routeRuntimeManagerRequest({ ...input, runtimeChannel: null, readMetadata: async () => ({}) }), false);
});
test('retry cannot change the channel or version of an existing task', async t => {
  const { root } = await fixture(t);
  const version = normalizeRuntimeVersion(entry(root), root);
  const input = { request: { url: '/v1/taskspaces', method: 'POST' }, response: {}, projectRoot: root,
    runtimeChannel: 'stable', readMetadata: async () => ({ runtimeVersion: version }),
    readBody: async () => ({ taskId: 'task-one', runtimeChannel: 'enhanced', runtimeVersionId: version.versionId }), managerToken: 'token' };
  await assert.rejects(routeRuntimeManagerRequest(input), { code: 'RUNTIME_VERSION_CHANGED' });
});
