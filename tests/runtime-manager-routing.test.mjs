import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationManager } from '../docker/harness/conversation-manager.mjs';
import { normalizeRuntimeVersion, RUNTIME_ENVIRONMENT_KEYS } from '../docker/harness/harness-runtime-versions.mjs';

const token = 'm'.repeat(64);
const projectSlug = 'runtime-project';
const actorUserId = '11111111-1111-4111-8111-111111111111';
const listen = (server, address = 0) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(address, ...(typeof address === 'number' ? ['127.0.0.1'] : []), () => resolve(server.address()));
});
const close = (server) => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
function request(address, method, pathname, body, authorization = token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const outgoing = http.request({ ...(typeof address === 'string' ? { socketPath: address } : { host: '127.0.0.1', port: address.port }),
      method, path: pathname, headers: { ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } }, incoming => {
      const chunks = []; incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.on('error', reject); outgoing.end(payload);
  });
}
function version(root, channel = 'stable', sourceCommit = 'a'.repeat(40)) {
  const base = path.join(root, 'runtime-versions', channel, sourceCommit.slice(0, 8));
  return normalizeRuntimeVersion({ channel, sourceBranch: channel === 'stable' ? 'codex/env-3212-ai' : 'main', sourceCommit,
    harnessImage: `sha256:${'b'.repeat(64)}`, skillBundleRoot: path.join(base, 'skills'), skillBundleSha256: 'c'.repeat(64),
    managerSocket: path.join(base, 'manager.sock'), brokerUrl: `http://taskspace-broker-${channel}:3100`,
    environment: Object.fromEntries(RUNTIME_ENVIRONMENT_KEYS.map(key => [key, key === 'FORGE_DEVELOPMENT_MODE' ? 'direct' : 'false'])) }, root);
}
const createBody = (taskId, runtime) => ({ taskId, actorId: 'alice', actorUserId,
  conversationId: `conversation:${taskId}`, accessMode: 'conversation',
  ...(runtime ? { runtimeChannel: runtime.channel, runtimeVersionId: runtime.versionId } : {}) });
function metadata(taskId, runtime, status = 'active') {
  const { runtimeChannel: _channel, runtimeVersionId: _id, ...identity } = createBody(taskId);
  return { schemaVersion: 2, projectSlug, ...identity, branch: `task/alice/${taskId}`, baseCommit: 'd'.repeat(40),
    status, harnessPort: 23001, accessTokenHash: '0'.repeat(64), lastCandidate: null, lastRelease: null,
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
    ...(runtime ? { runtimeVersion: runtime } : {}) };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frr-'));
  const stable = version(root), enhanced = version(root, 'enhanced');
  await mkdir(path.join(root, 'ops'));
  await mkdir(path.join(root, 'intake'));
  const controlScript = path.join(root, 'taskspacectl.sh');
  await writeFile(controlScript, '# fixture\n');
  const catalogPath = path.join(root, 'ops', 'harness-runtime-versions.json');
  const catalog = async versions => writeFile(catalogPath, JSON.stringify({ schemaVersion: 1, defaultChannel: 'stable', versions }));
  await catalog([stable, enhanced]);
  const save = async value => {
    const directory = path.join(root, 'taskspaces', value.taskId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'metadata.json'), JSON.stringify(value));
  };
  const load = async taskId => JSON.parse(await readFile(path.join(root, 'taskspaces', taskId, 'metadata.json'), 'utf8'));
  const calls = [], servers = [];
  const server = async (runtime = null, overrides = {}) => {
    const instance = createConversationManager({ projectRoot: root, projectSlug, managerToken: token, controlScript,
      intakeRoot: path.join(root, 'intake'), auditPath: path.join(root, 'ops', 'audit.jsonl'),
      runtimeChannel: runtime?.channel ?? null, runtimeVersionId: runtime?.versionId ?? null,
      runControl: async (_script, _slug, args) => {
        calls.push(args);
        if (args[0] === 'create') await save(metadata(args[args.indexOf('--task') + 1], runtime));
        else if (['recover', 'start', 'stop'].includes(args[0])) {
          const value = await load(args[1]); value.status = args[0] === 'stop' ? 'stopped' : 'active'; await save(value);
        }
        return { code: 0 };
      }, ...overrides });
    servers.push(instance);
    return { server: instance, address: await listen(instance) };
  };
  t.after(async () => { for (const instance of servers) await close(instance); await rm(root, { recursive: true, force: true }); });
  return { root, stable, enhanced, catalog, save, load, calls, server, servers };
}

test('version Manager consumes cached create JSON and rejects wrong versions; default Manager keeps legacy tasks', async t => {
  const f = await fixture(t);
  const bound = await f.server(f.stable), legacy = await f.server();
  assert.equal((await request(legacy.address, 'GET', '/v1/runtime-versions', undefined, null)).status, 401);
  assert.equal((await request(legacy.address, 'GET', '/v1/runtime-versions')).value.versions.length, 2);
  assert.equal((await request(bound.address, 'POST', '/v1/taskspaces', createBody('task-one', f.stable), null)).status, 401);
  assert.equal(f.calls.length, 0);
  const created = await request(bound.address, 'POST', '/v1/taskspaces', createBody('task-one', f.stable));
  assert.equal(created.status, 200, JSON.stringify(created.value));
  assert.equal(created.value.taskspace.runtimeVersion.versionId, f.stable.versionId);
  assert.ok(f.calls[0].includes('--runtime-channel'));
  assert.equal((await request(bound.address, 'GET', '/v1/taskspaces/task-one')).value.taskspace.runtimeVersion.versionId, f.stable.versionId);
  assert.equal((await request(bound.address, 'POST', '/v1/taskspaces/task-one/stop', {})).value.taskspace.status, 'stopped');
  assert.equal((await request(bound.address, 'POST', '/v1/taskspaces/task-one/start', {})).value.taskspace.status, 'active');
  assert.equal((await request(bound.address, 'POST', '/v1/taskspaces', createBody('task-other', f.enhanced))).value.code, 'RUNTIME_VERSION_MISMATCH');
  const otherRevision = await f.server({ ...f.stable, versionId: 'e'.repeat(64) });
  assert.equal((await request(otherRevision.address, 'GET', '/v1/taskspaces/task-one')).value.code, 'RUNTIME_VERSION_MISMATCH');
  const old = await request(legacy.address, 'POST', '/v1/taskspaces', createBody('task-old'));
  assert.equal(old.status, 200, JSON.stringify(old.value));
  assert.equal(old.value.taskspace.runtimeVersion, undefined);
  assert.equal((await request(legacy.address, 'GET', '/v1/taskspaces/task-old')).status, 200);
  assert.equal((await request(bound.address, 'GET', '/v1/taskspaces/task-old')).value.code, 'RUNTIME_VERSION_MISMATCH');
  assert.equal((await request(bound.address, 'POST', '/v1/execution-renewal-authority', {})).value.code, 'EXECUTION_RENEWAL_AUTHORITY_DENIED');
});

test('existing create and recover stay pinned after catalog advances while new stale selections fail', async t => {
  const f = await fixture(t), bound = await f.server(f.stable);
  await f.save(metadata('task-active', f.stable));
  await f.save(metadata('task-failed', f.stable, 'provisioning-failed'));
  const newer = version(f.root, 'stable', 'e'.repeat(40));
  await f.catalog([newer, f.enhanced]);
  const replay = await request(bound.address, 'POST', '/v1/taskspaces', createBody('task-active', f.stable));
  assert.equal(replay.status, 200, JSON.stringify(replay.value));
  assert.equal(replay.value.taskspace.runtimeVersion.versionId, f.stable.versionId);
  assert.equal(f.calls.length, 0);
  const recovered = await request(bound.address, 'POST', '/v1/taskspaces', createBody('task-failed', f.stable));
  assert.equal(recovered.status, 200, JSON.stringify(recovered.value));
  assert.equal(recovered.value.taskspace.runtimeVersion.versionId, f.stable.versionId);
  assert.deepEqual(f.calls, [['recover', 'task-failed']]);
  assert.equal((await request(bound.address, 'POST', '/v1/taskspaces', createBody('task-new', f.stable))).value.code, 'RUNTIME_VERSION_CHANGED');
  assert.equal((await request(bound.address, 'POST', '/v1/taskspaces', createBody('task-active', newer))).value.code, 'RUNTIME_VERSION_CHANGED');
});

test('successful control cannot report creation when actual metadata omitted the selected version', async t => {
  const f = await fixture(t);
  const bound = await f.server(f.stable, { runControl: async () => { await f.save(metadata('task-unbound')); return { code: 0 }; } });
  const result = await request(bound.address, 'POST', '/v1/taskspaces', createBody('task-unbound', f.stable));
  assert.equal(result.status, 409);
  assert.equal(result.value.code, 'RUNTIME_VERSION_CHANGED');
});

test('default Manager forwards status, stop, prepare and renewal to the immutable socket, and propagates cancellation',
  { skip: process.platform === 'win32' ? 'requires the deployed Linux Unix socket transport' : false, timeout: 10000 }, async t => {
    const f = await fixture(t), seen = [];
    let signalStarted, signalDisconnected;
    const started = new Promise(resolve => { signalStarted = resolve; });
    const disconnected = new Promise(resolve => { signalDisconnected = resolve; });
    const upstream = http.createServer(async (incoming, outgoing) => {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ path: incoming.url, authorization: incoming.headers.authorization, body });
      if (incoming.url.endsWith('/executions/prepare') && JSON.parse(body).cancel === true) {
        outgoing.once('close', signalDisconnected); signalStarted(); return;
      }
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ ok: true, observed: seen.at(-1) }));
    });
    await mkdir(path.dirname(f.stable.managerSocket), { recursive: true });
    await listen(upstream, f.stable.managerSocket); f.servers.push(upstream);
    await f.save(metadata('task-bound', f.stable));
    const ordinary = await f.server();
    const defaultSocket = path.join(f.root, 'default.sock');
    await close(ordinary.server); await listen(ordinary.server, defaultSocket);
    const initial = await request(defaultSocket, 'POST', '/v1/taskspaces', createBody('task-new', f.stable));
    assert.equal(initial.status, 200, JSON.stringify(initial.value));
    assert.equal(initial.value.observed.body, JSON.stringify(createBody('task-new', f.stable)));
    assert.equal((await request(defaultSocket, 'GET', '/v1/taskspaces/task-bound', undefined, null)).status, 401);
    assert.equal(seen.length, 1, 'unauthenticated traffic must not reach the version socket');
    await f.catalog([version(f.root, 'stable', 'e'.repeat(40)), f.enhanced]);
    for (const [method, endpoint, body] of [
      ['GET', '/v1/taskspaces/task-bound', undefined],
      ['POST', '/v1/taskspaces/task-bound/stop', {}],
      ['POST', '/v1/taskspaces/task-bound/executions/prepare', { taskId: 'task-bound', promptText: '保留原版本' }],
      ['POST', '/v1/execution-renewal-authority', { taskId: 'task-bound', projectSlug }],
      ['POST', '/v1/taskspaces', createBody('task-bound', f.stable)],
    ]) {
      const result = await request(defaultSocket, method, endpoint, body);
      assert.equal(result.status, 200, JSON.stringify(result.value));
      assert.equal(result.value.observed.path, endpoint);
      assert.equal(result.value.observed.authorization, `Bearer ${token}`);
      assert.equal(result.value.observed.body, body === undefined ? '' : JSON.stringify(body));
    }
    assert.equal((await request(defaultSocket, 'POST', '/v1/taskspaces', createBody('task-bound', f.enhanced))).value.code, 'RUNTIME_VERSION_CHANGED');
    const body = Buffer.from(JSON.stringify({ cancel: true }));
    const abandoned = http.request({ socketPath: defaultSocket, method: 'POST', path: '/v1/taskspaces/task-bound/executions/prepare',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': body.length } });
    abandoned.on('error', () => {}); abandoned.end(body);
    await started; abandoned.destroy(); await disconnected;
    assert.equal(seen.length, 7);
    await close(upstream);
    const unavailable = await request(defaultSocket, 'GET', '/v1/taskspaces/task-bound');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.value.code, 'RUNTIME_MANAGER_UNAVAILABLE');
  });
