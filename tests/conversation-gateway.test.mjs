import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ConversationStateStore,
  createConversationGateway,
  createManagerClient,
  readConversationGatewayRuntimeConfig,
} from '../docker/harness/conversation-gateway.mjs';
import { classifyPinnedDshPromptBody } from '../docker/harness/forge-execution-context.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, method, pathname, { cookie = undefined, csrf = undefined, body = undefined, internal = false, headers: extraHeaders = {} } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { ...(internal ? {} : { host: '127.0.0.1:13080' }), ...extraHeaders };
    if (!internal && method !== 'GET') headers.origin = 'http://127.0.0.1:13080';
    if (cookie) headers.cookie = cookie;
    if (csrf) headers['x-forge-csrf-token'] = csrf;
    if (encoded) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = encoded.length;
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          headers: response.headers,
          value: raw.length === 0 ? {} : JSON.parse(raw),
        });
      });
    });
    req.on('error', reject);
    req.end(encoded);
  });
}

function requestRaw(port, pathname, { cookie } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathname,
      headers: { host: '127.0.0.1:13080', ...(cookie ? { cookie } : {}) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, buffer: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

function cookieHeader(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie];
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

async function signIn(publicPort, username, password, returnTask = undefined) {
  const context = await request(publicPort, 'GET', '/forge-gateway/api/auth-context');
  assert.equal(context.status, 200, JSON.stringify(context.value));
  assert.ok(context.headers['set-cookie']);
  const preauthCookie = cookieHeader(context.headers['set-cookie']);
  const login = await request(publicPort, 'POST', '/forge-gateway/api/login', {
    cookie: preauthCookie,
    csrf: context.value.csrfToken,
    body: { username, password, returnTask },
  });
  assert.ok(login.headers['set-cookie'], JSON.stringify(login.value));
  return { response: login, cookie: cookieHeader(login.headers['set-cookie']) };
}

async function session(publicPort, cookie) {
  return request(publicPort, 'GET', '/forge-gateway/api/session', { cookie });
}

async function committedFence(root, epoch) {
  const fencePath = path.join(root, 'gateway-fence.json');
  await writeFile(fencePath, `${JSON.stringify({ schemaVersion: 1, state: 'committed', epoch })}\n`);
  return fencePath;
}

test('runtime selection is project-authorized, pinned across retries and exposed from the managed TaskSpace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-gateway-runtime-'));
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const password = /^password=(.+)$/m.exec(await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8'))[1];
  await store.mutate((state) => { state.users[0].mustChangePassword = false; });
  const versions = ['stable', 'enhanced'].map((channel, index) => ({ channel,
    label: index === 0 ? '稳定版' : '增强试验版', sourceBranch: index === 0 ? 'codex/env-3212-ai' : 'main',
    sourceCommit: String(index + 1).repeat(40), harnessImage: `forge/harness@sha256:${String(index + 1).repeat(64)}`,
    versionId: String(index + 1).repeat(64), available: true }));
  let catalogReads = 0;
  let available = true;
  let failNext = false;
  let wrongVersion = false;
  const calls = [];
  const managed = new Map();
  const publicVersion = (version) => { const { available: _available, ...result } = version; return result; };
  const manager = {
    runtimeVersions: async () => { catalogReads += 1; return { defaultChannel: 'stable', versions: versions.map((entry) => ({ ...entry, available })) }; },
    create: async (input) => {
      calls.push(input);
      if (failNext) { failNext = false; throw new Error('temporary create failure'); }
      const selected = versions.find((entry) => entry.channel === input.runtimeChannel);
      const taskspace = { schemaVersion: 2, ...input, status: 'active', harnessPort: 25000,
        protectedExecutionEligible: true, ...(selected ? { runtimeVersion: publicVersion(wrongVersion ? versions[1] : selected) } : {}) };
      managed.set(input.taskId, taskspace);
      return { taskspace };
    },
    start: async (taskId) => ({ taskspace: managed.get(taskId) }),
  };
  const projects = ['allowed-project', 'other-project'].map((slug) => ({ slug, displayName: slug }));
  const servers = await createConversationGateway({ store, managerForProject: async () => manager,
    projectDirectory: { list: async () => projects, get: async (slug) => projects.find((entry) => entry.slug === slug) },
    staticRoot: path.resolve('docker/harness/conversation-gateway'), publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1', operatorToken: 'o'.repeat(64), maintenanceFencePath: await committedFence(root, 'runtime-selection') });
  const port = await listen(servers.publicServer);
  t.after(async () => { await close(servers.publicServer); await rm(root, { recursive: true, force: true }); });
  const login = await signIn(port, 'admin', password);
  const authenticated = await session(port, login.cookie);
  await store.mutate((state) => {
    state.users[0].role = 'member';
    state.memberships.push({ userId: state.users[0].id, projectSlug: 'allowed-project', access: 'member' });
  });
  const opts = { cookie: login.cookie, csrf: authenticated.value.csrfToken };
  const route = '/forge-gateway/api/runtime-versions?project=';
  assert.equal((await request(port, 'GET', `${route}allowed-project`)).status, 401);
  assert.equal((await request(port, 'GET', `${route}other-project`, opts)).status, 403);
  assert.equal(catalogReads, 0, 'unauthorized callers never reach a project Manager');
  const catalog = await request(port, 'GET', `${route}allowed-project`, opts);
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.value, { defaultChannel: 'stable', versions });
  const create = (channel, key) => request(port, 'POST', '/forge-gateway/api/conversations', {
    ...opts, headers: { 'idempotency-key': key }, body: { title: '版本验证', projectSlug: 'allowed-project',
      ...(channel === undefined ? {} : { runtimeChannel: channel }) },
  });
  assert.equal((await create('other', 'runtime:invalid:0001')).value.code, 'INVALID_RUNTIME_CHANNEL');
  available = false;
  assert.equal((await create('stable', 'runtime:unavailable:001')).value.code, 'RUNTIME_VERSION_UNAVAILABLE');
  assert.equal(calls.length, 0);
  available = true;
  const stable = await create('stable', 'runtime:stable:00001');
  const enhanced = await create('enhanced', 'runtime:enhanced:001');
  assert.equal(stable.status, 201, JSON.stringify(stable.value));
  assert.equal(enhanced.status, 201, JSON.stringify(enhanced.value));
  assert.equal(stable.value.conversation.runtimeVersion.sourceBranch, 'codex/env-3212-ai');
  assert.equal(enhanced.value.conversation.runtimeVersion.sourceBranch, 'main');
  assert.deepEqual(calls.map(({ runtimeChannel, runtimeVersionId }) => [runtimeChannel, runtimeVersionId]),
    versions.map((version) => [version.channel, version.versionId]));
  assert.equal((await create('enhanced', 'runtime:stable:00001')).value.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await create(undefined, 'runtime:stable:00001')).value.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(calls.length, 2);
  const readsBeforeReplay = catalogReads;
  available = false;
  assert.equal((await create('stable', 'runtime:stable:00001')).status, 201);
  assert.equal(catalogReads, readsBeforeReplay, 'completed replay uses the original pinned result');
  available = true;
  failNext = true;
  assert.equal((await create('stable', 'runtime:retry:00001')).status, 503);
  const failed = await store.read((state) => state.conversations.find((entry) => entry.status === 'failed'));
  assert.equal(failed.runtimeVersion.versionId, versions[0].versionId);
  available = false;
  const readsBeforeRetry = catalogReads;
  assert.equal((await create('stable', 'runtime:retry:00001')).status, 201);
  assert.equal(catalogReads, readsBeforeRetry, 'failed retry never replaces the saved version from a newer catalog');
  assert.deepEqual(calls.at(-1), calls.at(-2), 'retry keeps TaskSpace identity and exact version');
  available = true;
  failNext = true;
  await create('enhanced', 'runtime:open:retry01');
  const openFailed = await store.read((state) => state.conversations.find((entry) => entry.status === 'failed'));
  const retryOpened = await request(port, 'POST', `/forge-gateway/api/conversations/${openFailed.id}/open`, { ...opts, body: {} });
  assert.equal(retryOpened.status, 200, JSON.stringify(retryOpened.value));
  assert.deepEqual(calls.at(-1), calls.at(-2), 'open retry also carries the saved version');
  wrongVersion = true;
  assert.equal((await create('stable', 'runtime:mismatch:01')).value.code, 'RUNTIME_VERSION_CONFLICT');
  wrongVersion = false;
  manager.runtimeVersions = async () => ({ defaultChannel: null, versions: [] });
  const noCatalog = await request(port, 'GET', `${route}allowed-project`, opts);
  assert.equal(noCatalog.status, 200);
  assert.deepEqual(noCatalog.value, { defaultChannel: null, versions: [], legacy: true });
  assert.equal((await create('stable', 'runtime:notinstalled:01')).value.code, 'RUNTIME_VERSION_UNAVAILABLE');
  manager.runtimeVersions = async () => ({ defaultChannel: null, versions: [versions[0]] });
  assert.equal((await request(port, 'GET', `${route}allowed-project`, opts)).value.code, 'RUNTIME_VERSIONS_UNAVAILABLE');
  delete manager.runtimeVersions;
  assert.equal((await request(port, 'GET', `${route}allowed-project`, opts)).value.code, 'RUNTIME_VERSIONS_UNAVAILABLE');
  assert.equal((await create('stable', 'runtime:missing:001')).value.code, 'RUNTIME_VERSIONS_UNAVAILABLE');
  const legacy = await create(undefined, 'runtime:legacy:0001');
  assert.equal(legacy.status, 201, JSON.stringify(legacy.value));
  assert.equal(legacy.value.conversation.runtimeVersion, null);
  assert.equal(calls.at(-1).runtimeChannel, undefined, 'legacy API calls retain compatibility');
  const listed = await request(port, 'GET', '/forge-gateway/api/conversations?project=allowed-project&offset=3', opts);
  assert.ok(listed.value.items.some((entry) => entry.runtimeVersion?.versionId === versions[0].versionId));
});

test('Manager client requests the runtime catalog over its authenticated transport', async () => {
  let observed;
  const client = createManagerClient({ baseUrl: 'http://127.0.0.1:10000', token: 't'.repeat(64),
    fetchImpl: async (url, options) => { observed = { url: String(url), ...options }; return Response.json({ versions: [], defaultChannel: 'stable' }); } });
  await client.runtimeVersions();
  assert.equal(observed.url, 'http://127.0.0.1:10000/v1/runtime-versions');
  assert.equal(observed.method, 'GET');
  assert.equal(observed.headers.authorization, `Bearer ${'t'.repeat(64)}`);
});

for (const transport of ['HTTP', 'socket']) {
  test(`execution prepare disconnect cancels the Manager ${transport} request and the next prepare succeeds`, { timeout: 10_000 }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-gateway-prepare-cancel-'));
    const store = new ConversationStateStore({ stateRoot: root });
    await store.initialize();
    const password = /^password=(.+)$/m.exec(await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8'))[1];
    await store.mutate((state) => {
      const user = state.users.find((item) => item.username === 'admin');
      user.mustChangePassword = false;
      state.conversations.push({ id: 'conversation-prepare-cancel', projectSlug: 'validation-project',
        taskId: 'task-prepare-cancel', ownerUserId: user.id, title: '取消过期准备', status: 'active', port: 24000,
        createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z' });
    });
    let prepareCalls = 0;
    let notifyPending;
    let notifyDisconnected;
    const pending = new Promise((resolve) => { notifyPending = resolve; });
    const disconnected = new Promise((resolve) => { notifyDisconnected = resolve; });
    const managerServer = http.createServer((incoming, outgoing) => {
      incoming.resume();
      incoming.once('end', () => {
        assert.equal(incoming.url, '/v1/taskspaces/task-prepare-cancel/executions/prepare');
        prepareCalls += 1;
        if (prepareCalls === 1) {
          outgoing.once('close', () => notifyDisconnected({ writableEnded: outgoing.writableEnded }));
          notifyPending();
        } else {
          outgoing.writeHead(200, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ ok: true, execution: { executionId: 'next-execution', generation: 1 } }));
        }
      });
    });
    let managerOptions;
    if (transport === 'HTTP') {
      managerOptions = { baseUrl: `http://127.0.0.1:${await listen(managerServer)}` };
    } else {
      const socketPath = process.platform === 'win32'
        ? `\\\\.\\pipe\\forge-prepare-${crypto.randomUUID()}` : path.join(root, 'manager.sock');
      await new Promise((resolve, reject) => {
        managerServer.once('error', reject);
        managerServer.listen(socketPath, resolve);
      });
      managerOptions = { socketPath };
    }
    const manager = createManagerClient({ ...managerOptions, token: 'm'.repeat(64), timeoutMs: 5_000 });
    const servers = await createConversationGateway({ store, manager,
      staticRoot: path.resolve('docker/harness/conversation-gateway'), publicOrigin: 'http://127.0.0.1:13080/',
      bindAddress: '127.0.0.1', projectSlug: 'validation-project', operatorToken: 'o'.repeat(64),
      maintenanceFencePath: await committedFence(root, `prepare-cancel-${transport}`) });
    const publicPort = await listen(servers.publicServer);
    const internalPort = await listen(servers.internalServer);
    let abandoned;
    try {
      const alreadyCancelled = new AbortController();
      alreadyCancelled.abort();
      await assert.rejects(manager.prepareExecution({ taskId: 'task-prepare-cancel' }, { signal: alreadyCancelled.signal }),
        { name: 'AbortError' });
      assert.equal(prepareCalls, 0, 'an expired request must never reach Manager');
      const login = await signIn(publicPort, 'admin', password);
      const body = { schemaVersion: 1, route: 'session.prompt', classification: 'claimable-text',
        rpcId: 'rpc:prepare:1', dshSessionId: 'session:prepare:1', mode: 'queue',
        bodyDigest: 'a'.repeat(64), textDigest: 'b'.repeat(64), promptText: '修复分页',
        bodyBytes: 128, imageCount: 0, requestId: 'request:prepare:abandoned' };
      const headers = { cookie: login.cookie, 'x-forge-taskspace-id': 'task-prepare-cancel',
        'x-forge-browser-host': '127.0.0.1:24000', 'x-forge-browser-origin': 'http://127.0.0.1:24000',
        'x-forge-browser-sec-fetch-site': 'same-origin' };
      const encoded = Buffer.from(JSON.stringify(body));
      abandoned = http.request({ host: '127.0.0.1', port: internalPort, method: 'POST',
        path: '/internal/taskspace-execution-prepare', headers: { ...headers,
          'content-type': 'application/json', 'content-length': encoded.length } });
      abandoned.on('error', () => {});
      abandoned.end(encoded);
      await pending;
      abandoned.destroy();
      assert.deepEqual(await disconnected, { writableEnded: false }, 'Manager must observe the closed prepare connection');
      const next = await request(internalPort, 'POST', '/internal/taskspace-execution-prepare', {
        internal: true, headers, body: { ...body, requestId: 'request:prepare:next', rpcId: 'rpc:prepare:2' },
      });
      assert.equal(next.status, 200, JSON.stringify(next.value));
      assert.equal(next.value.execution.executionId, 'next-execution');
      assert.equal(prepareCalls, 2, 'cancellation must not retry prepare in the background');
      const prepares = (await readFile(path.join(root, 'audit.jsonl'), 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line)).filter((entry) => entry.action === 'execution.prepare');
      assert.deepEqual(prepares.map(({ requestId, result }) => ({ requestId, result })),
        [{ requestId: 'request:prepare:next', result: 'success' }], 'the abandoned prepare cannot be reported as successful');
    } finally {
      abandoned?.destroy();
      for (const server of [servers.publicServer, servers.internalServer, managerServer]) server.closeAllConnections();
      await Promise.all([close(servers.publicServer), close(servers.internalServer), close(managerServer)]);
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('closed conversations reject user open, retry and stop before Manager calls and retain archives', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-gateway-closed-'));
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const password = /^password=(.+)$/m.exec(await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8'))[1];
  await store.mutate((state) => {
    const user = state.users.find((item) => item.username === 'admin'); user.mustChangePassword = false;
    for (const id of ['closed-old', 'closed-failed']) state.conversations.push({
      id, projectSlug: 'validation-project', taskId: `task-${id}`, ownerUserId: user.id,
      title: '历史工作舱', status: 'closed', port: 23001,
      lastError: id === 'closed-failed' ? 'CONTROL_FAILED' : null,
      createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:00Z',
    });
  });
  const calls = []; const bytes = Buffer.from('保留原始历史\n');
  const manager = {
    health: async () => ({ ok: true }),
    create: async () => { calls.push('create'); throw new Error('closed retry reached Manager'); },
    start: async () => { calls.push('start'); throw new Error('closed open reached Manager'); },
    stop: async () => { calls.push('stop'); throw new Error('closed stop reached Manager'); },
    outputs: async () => ({ ok: true, items: [{ sessionId: 'old-session', snapshotId: 'a'.repeat(64), files: [] }], hasMore: false }),
    output: async (_task, _session, _snapshot, name) => ({ ok: true, name, mediaType: 'text/markdown',
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, base64: bytes.toString('base64') }),
  };
  const servers = await createConversationGateway({ store, manager,
    staticRoot: path.resolve('docker/harness/conversation-gateway'), publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1', projectSlug: 'validation-project', operatorToken: 'o'.repeat(64),
    maintenanceFencePath: await committedFence(root, 'closed-test') });
  const port = await listen(servers.publicServer);
  try {
    const login = await signIn(port, 'admin', password);
    const csrf = (await session(port, login.cookie)).value.csrfToken;
    const before = await store.read((state) => structuredClone(state.conversations));
    for (const id of ['closed-old', 'closed-failed']) {
      for (const operation of ['open', 'stop', 'open']) {
        const response = await request(port, 'POST', `/forge-gateway/api/conversations/${id}/${operation}`,
          { cookie: login.cookie, csrf, body: {} });
        assert.equal(response.status, 409, JSON.stringify(response.value));
        assert.equal(response.value.code, 'TASKSPACE_CLOSED');
      }
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(await store.read((state) => state.conversations), before);
    const list = await request(port, 'GET', '/forge-gateway/api/conversations/closed-old/outputs', { cookie: login.cookie });
    assert.equal(list.status, 200);
    const file = await requestRaw(port, `/forge-gateway/api/conversations/closed-old/outputs/old-session/${'a'.repeat(64)}/conversation.md`, { cookie: login.cookie });
    assert.equal(file.status, 200); assert.deepEqual(file.buffer, bytes);
  } finally {
    await close(servers.publicServer); await rm(root, { recursive: true, force: true });
  }
});

test('a Manager deadline stays pending and status resolves the same owned TaskSpace without recreating it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-gateway-pending-'));
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const bootstrap = await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8');
  const password = /^password=(.+)$/m.exec(bootstrap)[1];
  await store.mutate((state) => { state.users.find((user) => user.username === 'admin').mustChangePassword = false; });
  let identity; let creates = 0; let statusReads = 0; let observed = 'missing';
  const manager = createManagerClient({ baseUrl: 'http://127.0.0.1:1', token: 'm'.repeat(64), timeoutMs: 20,
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') {
        creates += 1; identity = JSON.parse(options.body);
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
      }
      statusReads += 1;
      if (observed === 'missing') return Response.json({ code: 'TASKSPACE_NOT_FOUND' }, { status: 404 });
      return Response.json({ taskspace: { ...identity, schemaVersion: 2,
        actorUserId: observed === 'wrong-owner' ? crypto.randomUUID() : identity.actorUserId,
        status: observed === 'wrong-owner' ? 'active' : observed,
        protectedExecutionEligible: ['active', 'wrong-owner'].includes(observed), harnessPort: 23001 } });
    } });
  const servers = await createConversationGateway({ store, manager,
    staticRoot: path.resolve('docker/harness/conversation-gateway'), publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1', projectSlug: 'validation-project',
    maintenanceFencePath: await committedFence(root, 'pending-create'), operatorToken: 'o'.repeat(64) });
  const port = await listen(servers.publicServer); const internalPort = await listen(servers.internalServer);
  try {
    const login = await signIn(port, 'admin', password);
    const auth = await session(port, login.cookie);
    const options = { cookie: login.cookie, csrf: auth.value.csrfToken, body: { title: '慢速创建' },
      headers: { 'idempotency-key': 'conversation:pending:0001' } };
    const first = await request(port, 'POST', '/forge-gateway/api/conversations', options);
    assert.equal(first.status, 202); assert.equal(first.value.conversation.status, 'provisioning');
    const id = first.value.conversation.id;
    const statusPath = `/forge-gateway/api/conversations/${id}/status`;
    const replay = await request(port, 'POST', '/forge-gateway/api/conversations', options);
    assert.equal(replay.value.conversation.id, id); assert.equal(creates, 1);
    assert.equal((await request(port, 'GET', statusPath, { cookie: login.cookie })).value.conversation.status, 'provisioning');
    observed = 'provisioning';
    assert.equal((await request(port, 'GET', statusPath, { cookie: login.cookie })).value.conversation.status, 'provisioning');
    observed = 'wrong-owner';
    assert.equal((await request(port, 'GET', statusPath, { cookie: login.cookie })).value.code, 'TASKSPACE_IDENTITY_CONFLICT');
    observed = 'active';
    const ready = await request(port, 'GET', statusPath, { cookie: login.cookie });
    assert.equal(ready.value.conversation.id, id); assert.equal(ready.value.conversation.taskId, identity.taskId);
    assert.equal(ready.value.conversation.status, 'active'); assert.equal(ready.value.conversation.lastError, null);
    assert.equal(creates, 1);
    await store.mutate((state) => { const entry = state.conversations.find((item) => item.id === id);
      entry.status = 'failed'; entry.lastError = 'MANAGER_TIMEOUT'; });
    observed = 'provisioning-failed';
    const failed = await request(port, 'GET', statusPath, { cookie: login.cookie });
    assert.equal(failed.value.conversation.status, 'failed');
    assert.equal(failed.value.conversation.lastError, 'TASKSPACE_PROVISIONING_FAILED');
    observed = 'active';
    const recovered = await request(port, 'GET', statusPath, { cookie: login.cookie });
    assert.equal(recovered.value.conversation.status, 'active');
    assert.equal(recovered.value.conversation.lastError, null);
    const markFailed = async (lastError = 'TASKSPACE_PROVISIONING_FAILED') => store.mutate((state) => {
      const entry = state.conversations.find((item) => item.id === id);
      entry.status = 'failed'; entry.lastError = lastError;
    });
    const authorize = (cookie = login.cookie, headers = {}) => request(internalPort, 'POST', '/internal/taskspace-authorize', {
      internal: true, cookie, headers: { 'x-forge-taskspace-id': identity.taskId,
        'x-forge-browser-host': '127.0.0.1:23001', 'x-forge-browser-origin': 'http://127.0.0.1:23001',
        'x-forge-browser-sec-fetch-site': 'same-origin', ...headers },
    });
    await markFailed();
    const readsBeforeDenied = statusReads;
    assert.equal((await authorize('')).status, 409);
    assert.equal((await authorize(login.cookie, { 'x-forge-project-slug': 'other-project' })).status, 409);
    assert.equal((await authorize(login.cookie, { 'x-forge-browser-host': '127.0.0.1:23002' })).status, 409);
    assert.equal((await authorize(login.cookie, { 'x-forge-browser-origin': 'http://other.invalid' })).status, 409);
    assert.equal(statusReads, readsBeforeDenied);
    observed = 'provisioning-failed';
    assert.equal((await authorize()).status, 409);
    assert.equal((await store.read((state) => state.conversations.find((item) => item.id === id))).status, 'failed');
    observed = 'closed';
    assert.equal((await authorize()).value.code, 'TASKSPACE_STATUS_INVALID');
    observed = 'wrong-owner';
    assert.equal((await authorize()).value.code, 'TASKSPACE_IDENTITY_CONFLICT');
    assert.equal((await store.read((state) => state.conversations.find((item) => item.id === id))).status, 'failed');
    observed = 'active';
    assert.equal((await authorize()).status, 204);
    await markFailed('CONTROL_TIMEOUT');
    assert.equal((await authorize()).status, 204);
    await store.mutate((state) => { state.conversations.find((item) => item.id === id).status = 'closed'; });
    const readsBeforeClosed = statusReads;
    assert.equal((await authorize()).status, 409);
    assert.equal(statusReads, readsBeforeClosed);
    assert.equal(creates, 1);
    await markFailed();
    await store.mutate((state) => { state.conversations.find((item) => item.id === id).ownerUserId = crypto.randomUUID(); });
    assert.equal((await request(port, 'GET', statusPath, { cookie: login.cookie })).status, 403);
    const readsBeforeForeign = statusReads;
    assert.equal((await authorize()).status, 409);
    assert.equal(statusReads, readsBeforeForeign);
  } finally {
    await close(servers.publicServer); await close(servers.internalServer);
    await rm(root, { recursive: true, force: true });
  }
});

test('role decisions require fresh owner login and CSRF and never accept client roles or identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-role-gateway-'));
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const password = /^password=(.+)$/m.exec(await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8'))[1];
  await store.mutate(state => {
    const admin = state.users.find(user => user.username === 'admin');
    admin.mustChangePassword = false;
    state.users.push({ ...admin, id: crypto.randomUUID(), username: 'another_admin', displayName: 'Other Admin' });
  });
  const decisions = [];
  const manager = {
    health: async () => ({ ok: true }),
    create: async ({ taskId, actorId, actorUserId, conversationId }) => ({ taskspace: {
      schemaVersion: 2, taskId, actorId, actorUserId, conversationId, accessMode: 'conversation',
      status: 'active', harnessPort: 23001, protectedExecutionEligible: true,
    } }),
    roleDecision: async value => { decisions.push(value); return { status: value.operation === 'confirm' ? 'confirmed' : 'needs-confirmation',
      previewId: '11111111-1111-4111-8111-111111111111', previewDigest: `sha256:${'a'.repeat(64)}`, grants: [], approvable: false }; },
  };
  const servers = await createConversationGateway({ store, manager,
    staticRoot: path.resolve('docker/harness/conversation-gateway'), publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1', projectSlug: 'validation-project',
    maintenanceFencePath: await committedFence(root, 'role-preview'), operatorToken: 'o'.repeat(64) });
  const port = await listen(servers.publicServer);
  await listen(servers.internalServer);
  try {
    const owner = await signIn(port, 'admin', password);
    const auth = await session(port, owner.cookie);
    const created = await request(port, 'POST', '/forge-gateway/api/conversations', {
      cookie: owner.cookie, csrf: auth.value.csrfToken, body: { title: '角色授权预览' },
      headers: { 'idempotency-key': 'conversation:role:0001' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.value));
    const endpoint = `/forge-gateway/api/conversations/${created.value.conversation.id}/role-decisions`;
    const ownerRequest = { cookie: owner.cookie, csrf: auth.value.csrfToken, body: { operation: 'preview' } };
    assert.notEqual((await request(port, 'POST', endpoint, { body: { operation: 'preview' } })).status, 200);
    assert.equal((await request(port, 'POST', endpoint, { ...ownerRequest, csrf: 'invalid' })).status, 403);
    for (const injection of [{ actorUserId: crypto.randomUUID() }, { roleKeys: ['admin'] }, { grants: [] }]) {
      assert.equal((await request(port, 'POST', endpoint, { ...ownerRequest, body: { operation: 'preview', ...injection } })).status, 422);
    }
    const other = await signIn(port, 'another_admin', password);
    const otherAuth = await session(port, other.cookie);
    assert.equal((await request(port, 'POST', endpoint, { cookie: other.cookie, csrf: otherAuth.value.csrfToken,
      body: { operation: 'preview' } })).status, 403, 'another administrator cannot confirm this conversation');
    assert.equal(decisions.length, 0);
    const preview = await request(port, 'POST', endpoint, ownerRequest);
    assert.equal(preview.status, 200, JSON.stringify(preview.value));
    const confirmed = await request(port, 'POST', endpoint, { ...ownerRequest, body: { operation: 'confirm',
      previewId: preview.value.previewId, previewDigest: preview.value.previewDigest } });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.value));
    assert.equal(decisions.length, 2);
    assert.equal(decisions[0].actorUserId, auth.value.user.id);
    assert.equal(decisions[0].actorUsername, 'admin');
    assert.equal(decisions[0].taskId, created.value.conversation.taskId);
    await store.mutate(state => { state.users.find(user => user.username === 'admin').role = 'auditor'; });
    assert.equal((await request(port, 'POST', endpoint, ownerRequest)).status, 403, 'permission is re-read for every decision');
    assert.equal(decisions.length, 2);
  } finally {
    await Promise.all([close(servers.publicServer), close(servers.internalServer)]);
    await rm(root, { recursive: true, force: true });
  }
});

test('gateway CLI consumes the exact Compose environment contract', () => {
  const value = readConversationGatewayRuntimeConfig({
    CONVERSATION_GATEWAY_STATE_ROOT: '/var/lib/forge-conversation',
    CONVERSATION_GATEWAY_STATIC_ROOT: '/usr/local/share/conversation-gateway',
    CONVERSATION_GATEWAY_PUBLIC_ORIGIN: 'http://192.0.2.10:13080/',
    CONVERSATION_GATEWAY_BIND_ADDRESS: '192.0.2.10',
    CONVERSATION_GATEWAY_PUBLIC_PORT: '3080',
    CONVERSATION_GATEWAY_INTERNAL_ADDRESS: '0.0.0.0',
    CONVERSATION_GATEWAY_INTERNAL_PORT: '3120',
    CONVERSATION_MANAGER_URL: 'http://conversation-manager:3110',
    CONVERSATION_MANAGER_TOKEN_FILE: '/run/forge-conversation/manager-token',
    CONVERSATION_OPERATOR_TOKEN_FILE: '/run/forge-conversation/operator-token',
    CONVERSATION_OPERATOR_SOCKET: '/run/forge-conversation/operator.sock',
    CONVERSATION_GATEWAY_MAINTENANCE_FENCE_FILE: '/run/forge-maintenance/gateway-fence.json',
    CONVERSATION_PROJECT_SLUG: 'validation-project',
    CONVERSATION_GATEWAY_COOKIE_SECURE: 'false',
  });
  assert.equal(value.publicOrigin, 'http://192.0.2.10:13080/');
  assert.equal(value.bindAddress, '192.0.2.10');
  assert.equal(value.publicPort, 3080);
  assert.equal(value.projectSlug, 'validation-project');
  assert.equal(value.maintenanceFencePath, '/run/forge-maintenance/gateway-fence.json');
  assert.equal(value.cookieSecure, false);
  assert.throws(() => readConversationGatewayRuntimeConfig({
    FORGE_BIND_ADDRESS: '192.0.2.10',
    CONVERSATION_GATEWAY_PORT: '3080',
    PROJECT_SLUG: 'validation-project',
  }), /environment is incomplete/);
});

test('platform gateway runtime requires a registry and scoped capability root instead of one project manager', () => {
  const value = readConversationGatewayRuntimeConfig({
    CONVERSATION_GATEWAY_STATE_ROOT: '/var/lib/forge-conversation',
    CONVERSATION_GATEWAY_PUBLIC_ORIGIN: 'http://192.0.2.10:13080/',
    CONVERSATION_GATEWAY_BIND_ADDRESS: '192.0.2.10',
    CONVERSATION_GATEWAY_PUBLIC_PORT: '3080',
    CONVERSATION_GATEWAY_INTERNAL_SOCKET: '/run/forge-conversation-auth/authorize.sock',
    CONVERSATION_PROJECT_REGISTRY_FILE: '/etc/forge/projects.tsv',
    CONVERSATION_PROJECT_CAPABILITY_ROOT: '/run/forge-projects',
    CONVERSATION_OPERATOR_TOKEN_FILE: '/run/forge-conversation/operator-token',
    CONVERSATION_OPERATOR_SOCKET: '/run/forge-conversation/operator.sock',
    CONVERSATION_GATEWAY_MAINTENANCE_FENCE_FILE: '/run/forge-maintenance/gateway-fence.json',
  });
  assert.equal(value.platformMode, true);
  assert.equal(value.projectSlug, undefined);
  assert.equal(value.projectCapabilityRoot, '/run/forge-projects');
  assert.equal(value.internalSocket, '/run/forge-conversation-auth/authorize.sock');
  assert.throws(() => readConversationGatewayRuntimeConfig({
    CONVERSATION_GATEWAY_STATE_ROOT: '/var/lib/forge-conversation',
    CONVERSATION_GATEWAY_PUBLIC_ORIGIN: 'http://192.0.2.10:13080/',
    CONVERSATION_GATEWAY_BIND_ADDRESS: '192.0.2.10',
    CONVERSATION_GATEWAY_PUBLIC_PORT: '3080',
    CONVERSATION_GATEWAY_INTERNAL_PORT: '3120',
    CONVERSATION_PROJECT_REGISTRY_FILE: '/etc/forge/projects.tsv',
    CONVERSATION_PROJECT_CAPABILITY_ROOT: '/run/forge-projects',
    CONVERSATION_OPERATOR_TOKEN_FILE: '/run/forge-conversation/operator-token',
    CONVERSATION_OPERATOR_SOCKET: '/run/forge-conversation/operator.sock',
    CONVERSATION_GATEWAY_MAINTENANCE_FENCE_FILE: '/run/forge-maintenance/gateway-fence.json',
  }), /authorization transport is incomplete/);
});

test('gateway persists a safe control reason while retaining the stable CONTROL_FAILED contract', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-gateway-control-failure-'));
  const maintenanceFencePath = await committedFence(root, 'control-failure-1');
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const bootstrap = await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8');
  const bootstrapPassword = /^password=(.+)$/m.exec(bootstrap)[1];
  const managerToken = 'm'.repeat(64);
  const secretMarker = 'token=must-not-cross-manager-boundary';
  let managerMode = 'control-failed';
  const managerServer = http.createServer((managerRequest, managerResponse) => {
    const requestChunks = [];
    managerRequest.on('data', (chunk) => requestChunks.push(chunk));
    managerRequest.once('end', () => {
      const requestBody = JSON.parse(Buffer.concat(requestChunks).toString('utf8'));
      const managerSucceeded = managerMode === 'invalid-status' || managerMode === 'active';
      const invalidStatus = managerMode === 'invalid-status';
      const value = managerSucceeded
        ? {
          ok: true,
          taskspace: {
            schemaVersion: 2,
            taskId: requestBody.taskId,
            actorId: requestBody.actorId,
            actorUserId: requestBody.actorUserId,
            conversationId: requestBody.conversationId,
            accessMode: 'conversation',
            status: invalidStatus ? 'provisioning-failed' : 'active',
            harnessPort: 23001,
            protectedExecutionEligible: !invalidStatus,
          },
        }
        : {
          ok: false,
          code: 'CONTROL_FAILED',
          message: 'TaskSpace 控制操作失败。',
          details: {
            reasonCode: 'INTEGRATION_WORKSPACE_DIRTY',
            requestId: 'manager-request-0001',
            exitCode: 23,
            diagnostic: secretMarker,
          },
        };
      const body = Buffer.from(JSON.stringify(value));
      managerResponse.writeHead(managerSucceeded ? 200 : 502, {
        'content-length': body.length,
        'content-type': 'application/json; charset=utf-8',
      });
      managerResponse.end(body);
    });
  });
  const managerPort = await listen(managerServer);
  const manager = createManagerClient({
    baseUrl: `http://127.0.0.1:${managerPort}`,
    token: managerToken,
    timeoutMs: 2_000,
  });
  const servers = await createConversationGateway({
    store,
    manager,
    staticRoot: path.resolve('docker/harness/conversation-gateway'),
    publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1',
    projectSlug: 'validation-project',
    maintenanceFencePath,
    operatorToken: 'o'.repeat(64),
  });
  const publicPort = await listen(servers.publicServer);
  await listen(servers.internalServer);
  try {
    const firstLogin = await signIn(publicPort, 'admin', bootstrapPassword);
    const firstSession = await session(publicPort, firstLogin.cookie);
    const changed = await request(publicPort, 'POST', '/forge-gateway/api/change-password', {
      cookie: firstLogin.cookie,
      csrf: firstSession.value.csrfToken,
      body: {
        currentPassword: bootstrapPassword,
        newPassword: 'Control-failure-passphrase-2026!',
        confirmPassword: 'Control-failure-passphrase-2026!',
      },
    });
    assert.equal(changed.status, 200);
    const adminCookie = cookieHeader(changed.headers['set-cookie']);
    const adminSession = await session(publicPort, adminCookie);
    const failed = await request(publicPort, 'POST', '/forge-gateway/api/conversations', {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: { title: '分类失败验证' },
      headers: { 'idempotency-key': 'conversation:control-failure:0001' },
    });
    assert.equal(failed.status, 502);
    assert.equal(failed.value.code, 'CONTROL_FAILED');
    assert.deepEqual(failed.value.details, {
      reasonCode: 'INTEGRATION_WORKSPACE_DIRTY',
      requestId: 'manager-request-0001',
      exitCode: 23,
    });
    assert.equal(JSON.stringify(failed.value).includes(secretMarker), false);

    const conversations = await request(publicPort, 'GET', '/forge-gateway/api/conversations', { cookie: adminCookie });
    assert.equal(conversations.status, 200);
    assert.equal(conversations.value.items.length, 1);
    assert.equal(conversations.value.items[0].status, 'failed');
    assert.equal(conversations.value.items[0].lastError, 'INTEGRATION_WORKSPACE_DIRTY');

    const auditRaw = await readFile(path.join(root, 'audit.jsonl'), 'utf8');
    const auditEntry = auditRaw.trim().split('\n')
      .map((line) => JSON.parse(line))
      .findLast((entry) => entry.action === 'conversation.create');
    assert.equal(auditEntry.result, 'failed');
    assert.equal(auditEntry.code, 'CONTROL_FAILED');
    assert.equal(auditEntry.controlReasonCode, 'INTEGRATION_WORKSPACE_DIRTY');
    assert.equal(auditEntry.managerRequestId, 'manager-request-0001');
    assert.equal(auditRaw.includes(secretMarker), false);
    assert.equal((await readFile(path.join(root, 'state.json'), 'utf8')).includes(secretMarker), false);

    managerMode = 'invalid-status';
    const invalidStatus = await request(publicPort, 'POST', '/forge-gateway/api/conversations', {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: { title: '分类失败验证' },
      headers: { 'idempotency-key': 'conversation:control-failure:0001' },
    });
    assert.equal(invalidStatus.status, 502);
    assert.equal(invalidStatus.value.code, 'TASKSPACE_STATUS_INVALID');
    const afterInvalidStatus = await request(publicPort, 'GET', '/forge-gateway/api/conversations', { cookie: adminCookie });
    assert.equal(afterInvalidStatus.value.items[0].status, 'failed');
    assert.equal(afterInvalidStatus.value.items[0].lastError, 'TASKSPACE_STATUS_INVALID');
    const finalAuditRaw = await readFile(path.join(root, 'audit.jsonl'), 'utf8');
    const invalidStatusAudit = finalAuditRaw.trim().split('\n')
      .map((line) => JSON.parse(line))
      .findLast((entry) => entry.action === 'conversation.create');
    assert.equal(invalidStatusAudit.result, 'failed');
    assert.equal(invalidStatusAudit.code, 'TASKSPACE_STATUS_INVALID');
    assert.equal(finalAuditRaw.includes(secretMarker), false);

    managerMode = 'active';
    const recovered = await request(
      publicPort,
      'POST',
      `/forge-gateway/api/conversations/${conversations.value.items[0].id}/open`,
      { cookie: adminCookie, csrf: adminSession.value.csrfToken, body: {} },
    );
    assert.equal(recovered.status, 200);
    assert.equal(recovered.value.conversation.status, 'active');
    assert.equal(recovered.value.conversation.lastError, null);
    const afterRecovery = await request(publicPort, 'GET', '/forge-gateway/api/conversations', { cookie: adminCookie });
    assert.equal(afterRecovery.value.items[0].status, 'active');
    assert.equal(afterRecovery.value.items[0].lastError, null);
  } finally {
    await close(servers.publicServer);
    await close(servers.internalServer);
    await close(managerServer);
    await rm(root, { recursive: true, force: true });
  }
});

test('ordinary owner conversations can reopen exact schema-v1 TaskSpaces but identity drift remains rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-gateway-schema-v1-'));
  const maintenanceFencePath = await committedFence(root, 'schema-v1-compatibility-1');
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const bootstrap = await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8');
  const bootstrapPassword = /^password=(.+)$/m.exec(bootstrap)[1];
  const manager = {
    health: async () => ({ ok: true }),
    create: async () => { throw new Error('schema-v1 compatibility must not create a replacement TaskSpace'); },
    start: async (taskId) => ({ taskspace: {
      schemaVersion: 1,
      taskId,
      actorId: 'admin',
      actorUserId: taskId === 'schema-v1-actor-drift' ? '11111111-1111-4111-8111-111111111111' : null,
      conversationId: taskId === 'schema-v1-conversation-drift' ? 'wrong-conversation' : `conversation-${taskId}`,
      accessMode: 'conversation',
      status: 'active',
      harnessPort: 24510,
      protectedExecutionEligible: false,
    } }),
    stop: async (taskId) => ({ taskspace: { taskId, status: 'stopped', harnessPort: 24510 } }),
  };
  const servers = await createConversationGateway({
    store,
    manager,
    staticRoot: path.resolve('docker/harness/conversation-gateway'),
    publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1',
    projectSlug: 'validation-project',
    maintenanceFencePath,
    operatorToken: 'v'.repeat(64),
  });
  const publicPort = await listen(servers.publicServer);
  await listen(servers.internalServer);
  try {
    const firstLogin = await signIn(publicPort, 'admin', bootstrapPassword);
    const firstSession = await session(publicPort, firstLogin.cookie);
    const changed = await request(publicPort, 'POST', '/forge-gateway/api/change-password', {
      cookie: firstLogin.cookie,
      csrf: firstSession.value.csrfToken,
      body: {
        currentPassword: bootstrapPassword,
        newPassword: 'Schema-v1-owner-passphrase-2026!',
        confirmPassword: 'Schema-v1-owner-passphrase-2026!',
      },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.value));
    const adminCookie = cookieHeader(changed.headers['set-cookie']);
    const adminSession = await session(publicPort, adminCookie);
    const taskIds = ['schema-v1-exact', 'schema-v1-conversation-drift', 'schema-v1-actor-drift'];
    await store.mutate((value) => {
      taskIds.forEach((taskId, index) => value.conversations.push({
        id: `conversation-${taskId}`,
        taskId,
        projectSlug: 'validation-project',
        ownerUserId: adminSession.value.user.id,
        title: `Schema v1 ${index + 1}`,
        status: 'stopped',
        port: 24510,
        createdAt: `2026-08-${String(25 + index).padStart(2, '0')}T00:00:00.000Z`,
        updatedAt: `2026-08-${String(25 + index).padStart(2, '0')}T00:00:00.000Z`,
        lastOpenedAt: null,
        lastError: null,
      }));
    });

    const exact = await request(publicPort, 'POST', '/forge-gateway/api/conversations/conversation-schema-v1-exact/open', {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: {},
    });
    assert.equal(exact.status, 200, JSON.stringify(exact.value));
    assert.equal(exact.value.conversation.status, 'active');

    for (const taskId of ['schema-v1-conversation-drift', 'schema-v1-actor-drift']) {
      const drifted = await request(publicPort, 'POST', `/forge-gateway/api/conversations/conversation-${taskId}/open`, {
        cookie: adminCookie,
        csrf: adminSession.value.csrfToken,
        body: {},
      });
      assert.equal(drifted.status, 502);
      assert.equal(drifted.value.code, 'TASKSPACE_IDENTITY_CONFLICT');
    }
  } finally {
    await close(servers.publicServer);
    await close(servers.internalServer);
    await rm(root, { recursive: true, force: true });
  }
});

test('two independent login sessions see only their own conversations and revocation is immediate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-conversation-gateway-'));
  const maintenanceFencePath = await committedFence(root, 'functional-legacy-1');
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const bootstrap = await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8');
  const bootstrapPassword = /^password=(.+)$/m.exec(bootstrap)[1];
  let nextPort = 24000;
  const executionPrepares = [];
  const archivedBody = Buffer.from('归档正文\n', 'utf8');
  let corruptArchivedDigest = false;
  const phaseReads = [];
  const manager = {
    health: async () => ({ ok: true }),
    create: async ({ taskId, actorId, actorUserId, conversationId }) => ({ taskspace: {
      schemaVersion: 2, taskId, actorId, actorUserId, conversationId, accessMode: 'conversation',
      status: 'active', harnessPort: nextPort++, protectedExecutionEligible: true,
    } }),
    start: async (taskId) => ({ taskspace: { taskId, status: 'active', harnessPort: 24000 } }),
    stop: async (taskId) => ({ taskspace: { taskId, status: 'stopped', harnessPort: 24000 } }),
    outputs: async (taskId, query) => ({ ok: true, items: [{ sessionId: 'session-archive-1', snapshotId: 'a'.repeat(64),
      status: 'completed', lastSeq: 2, createdAt: '2026-09-15T00:00:00.000Z', scope: { taskspaceId: taskId }, files: [] }],
      offset: 0, limit: 20, hasMore: false, query }),
    output: async (_taskId, _sessionId, _snapshotId, name) => ({ ok: true, name, mediaType: 'text/markdown',
      sha256: corruptArchivedDigest ? '0'.repeat(64) : crypto.createHash('sha256').update(archivedBody).digest('hex'),
      bytes: archivedBody.length, base64: archivedBody.toString('base64') }),
    phaseOutputs: async (taskId, query) => {
      phaseReads.push({ taskId, query });
      return { ok: true, items: [{ packageId: 'b'.repeat(64), phaseId: 'database', phaseIndex: 2,
        phaseLabel: '第03阶段 · 数据实现', decision: 'accepted', files: [] }], offset: 0, limit: 20, hasMore: false };
    },
    phaseOutput: async (taskId, packageId, name) => {
      phaseReads.push({ taskId, packageId, name });
      return { ok: true, name, downloadName: '03-数据实现_阶段结果_20260915-080000_bbbbbbbb.md',
        bytes: archivedBody.length, base64: archivedBody.toString('base64'),
        sha256: corruptArchivedDigest ? '0'.repeat(64) : crypto.createHash('sha256').update(archivedBody).digest('hex') };
    },
    prepareExecution: async (value) => {
      executionPrepares.push(value);
      return { ok: true, execution: { executionId: 'execution-one', generation: 1, taskId: value.taskId } };
    },
  };
  const servers = await createConversationGateway({
    store,
    manager,
    staticRoot: path.resolve('docker/harness/conversation-gateway'),
    publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1',
    projectSlug: 'validation-project',
    maintenanceFencePath,
    operatorToken: 'o'.repeat(64),
  });
  const publicPort = await listen(servers.publicServer);
  const internalPort = await listen(servers.internalServer);
  try {
    const favicon = await request(publicPort, 'GET', '/favicon.ico');
    assert.equal(favicon.status, 204);
    const firstAdminLogin = await signIn(publicPort, 'admin', bootstrapPassword);
    assert.equal(firstAdminLogin.response.status, 200);
    const firstAdminSession = await session(publicPort, firstAdminLogin.cookie);
    assert.equal(firstAdminSession.headers['cross-origin-opener-policy'], undefined);
    const changedAdmin = await request(publicPort, 'POST', '/forge-gateway/api/change-password', {
      cookie: firstAdminLogin.cookie,
      csrf: firstAdminSession.value.csrfToken,
      body: { currentPassword: bootstrapPassword, newPassword: 'Root-secure-passphrase-2026!', confirmPassword: 'Root-secure-passphrase-2026!' },
    });
    assert.equal(changedAdmin.status, 200);
    const adminCookie = cookieHeader(changedAdmin.headers['set-cookie']);
    const adminSession = await session(publicPort, adminCookie);

    const selfReset = await request(publicPort, 'POST', `/forge-gateway/api/admin/users/${adminSession.value.user.id}/reset-password`, {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: {},
    });
    assert.equal(selfReset.status, 409);
    assert.equal(selfReset.value.code, 'SELF_PASSWORD_RESET_NOT_ALLOWED');
    assert.equal((await session(publicPort, adminCookie)).status, 200);

    const memberCreated = await request(publicPort, 'POST', '/forge-gateway/api/admin/users', {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: { username: 'member-b', displayName: '成员 B', role: 'member' },
    });
    assert.equal(memberCreated.status, 201);
    const memberId = memberCreated.value.user.id;
    const memberFirstLogin = await signIn(publicPort, 'member-b', memberCreated.value.temporaryPassword);
    const memberFirstSession = await session(publicPort, memberFirstLogin.cookie);
    const changedMember = await request(publicPort, 'POST', '/forge-gateway/api/change-password', {
      cookie: memberFirstLogin.cookie,
      csrf: memberFirstSession.value.csrfToken,
      body: { currentPassword: memberCreated.value.temporaryPassword, newPassword: 'Member-secure-passphrase-2026!', confirmPassword: 'Member-secure-passphrase-2026!' },
    });
    const memberCookie = cookieHeader(changedMember.headers['set-cookie']);
    const memberSession = await session(publicPort, memberCookie);

    const adminConversation = await request(publicPort, 'POST', '/forge-gateway/api/conversations', {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: { title: '管理员自己的对话' },
    });
    // Add the idempotency key through a raw request retry below because it is
    // mandatory for all creation calls.
    assert.equal(adminConversation.status, 400);
    const createWithKey = async (cookie, csrf, title, key) => new Promise((resolve, reject) => {
      const encoded = Buffer.from(JSON.stringify({ title }));
      const req = http.request({ host: '127.0.0.1', port: publicPort, method: 'POST', path: '/forge-gateway/api/conversations', headers: {
        host: '127.0.0.1:13080', origin: 'http://127.0.0.1:13080', cookie,
        'x-forge-csrf-token': csrf, 'idempotency-key': key,
        'content-type': 'application/json', 'content-length': encoded.length,
      } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject); req.end(encoded);
    });
    const adminOwn = await createWithKey(adminCookie, adminSession.value.csrfToken, '管理员自己的对话', 'conversation:admin:00000001');
    const memberOwn = await createWithKey(memberCookie, memberSession.value.csrfToken, '成员自己的对话', 'conversation:member:00000001');
    assert.equal(adminOwn.status, 201);
    assert.equal(memberOwn.status, 201);

    const adminList = await request(publicPort, 'GET', '/forge-gateway/api/conversations', { cookie: adminCookie });
    const memberList = await request(publicPort, 'GET', '/forge-gateway/api/conversations', { cookie: memberCookie });
    assert.deepEqual(adminList.value.items.map((entry) => entry.id), [adminOwn.value.conversation.id]);
    assert.deepEqual(memberList.value.items.map((entry) => entry.id), [memberOwn.value.conversation.id]);

    const allConversations = await request(publicPort, 'GET', '/forge-gateway/api/conversations?scope=all', { cookie: adminCookie });
    assert.equal(allConversations.status, 200);
    assert.deepEqual(new Set(allConversations.value.items.map((entry) => entry.owner.username)), new Set(['admin', 'member-b']));
    assert.equal((await request(publicPort, 'GET', '/forge-gateway/api/conversations?scope=all', { cookie: memberCookie })).status, 403);
    assert.equal((await request(publicPort, 'GET', `/forge-gateway/api/conversations/${memberOwn.value.conversation.id}/outputs`)).status, 401);
    assert.equal((await request(publicPort, 'GET', `/forge-gateway/api/conversations/${adminOwn.value.conversation.id}/outputs`, { cookie: memberCookie })).status, 403);
    const adminArchive = await request(publicPort, 'GET', `/forge-gateway/api/conversations/${memberOwn.value.conversation.id}/outputs`, { cookie: adminCookie });
    assert.equal(adminArchive.status, 200);
    assert.equal(adminArchive.value.items[0].sessionId, 'session-archive-1');
    const archivePath = `/forge-gateway/api/conversations/${memberOwn.value.conversation.id}/outputs/session-archive-1/${'a'.repeat(64)}/conversation.md`;
    const archiveFile = await requestRaw(publicPort, archivePath, { cookie: memberCookie });
    assert.equal(archiveFile.status, 200);
    assert.deepEqual(archiveFile.buffer, archivedBody);
    assert.equal(archiveFile.headers['content-type'], 'text/plain; charset=utf-8');
    assert.match(archiveFile.headers['content-security-policy'], /sandbox/u);
    const download = await requestRaw(publicPort, `${archivePath}?download=1`, { cookie: adminCookie });
    assert.match(download.headers['content-disposition'], /^attachment;/u);
    corruptArchivedDigest = true;
    assert.equal((await request(publicPort, 'GET', archivePath, { cookie: memberCookie })).status, 502);
    corruptArchivedDigest = false;
    assert.equal((await request(publicPort, 'GET', `${archivePath.replace('session-archive-1', 'session-archive-1%2Fescape')}`, { cookie: memberCookie })).status, 400);

    const phasePath = `/forge-gateway/api/conversations/${memberOwn.value.conversation.id}/phase-outputs`;
    assert.equal((await request(publicPort, 'GET', phasePath)).status, 401);
    assert.equal((await request(publicPort, 'GET', phasePath.replace(memberOwn.value.conversation.id, adminOwn.value.conversation.id), { cookie: memberCookie })).status, 403);
    assert.equal(phaseReads.length, 0, 'unauthorized reads never reach Manager');
    const phaseList = await request(publicPort, 'GET', `${phasePath}?offset=0&limit=20`, { cookie: adminCookie });
    assert.equal(phaseList.status, 200);
    assert.equal(phaseList.value.items[0].phaseLabel, '第03阶段 · 数据实现');
    assert.equal(phaseReads[0].taskId, memberOwn.value.conversation.taskId);
    assert.equal(phaseReads[0].query, '?offset=0&limit=20');
    const phaseDownloadPath = `${phasePath}/${'b'.repeat(64)}/01-result.md`;
    const phaseDownload = await requestRaw(publicPort, `${phaseDownloadPath}?download=1`, { cookie: memberCookie });
    assert.equal(phaseDownload.status, 200);
    assert.deepEqual(phaseDownload.buffer, archivedBody);
    assert.equal(phaseReads[1].name, '01-result.md', 'the canonical path remains unchanged');
    assert.equal(decodeURIComponent(phaseDownload.headers['content-disposition']), "attachment; filename*=UTF-8''03-数据实现_阶段结果_20260915-080000_bbbbbbbb.md");
    assert.equal(phaseDownload.headers['x-content-type-options'], 'nosniff');
    assert.match(phaseDownload.headers['content-security-policy'], /sandbox/u);
    const phasePreview = await requestRaw(publicPort, phaseDownloadPath, { cookie: adminCookie });
    assert.equal(phasePreview.status, 200);
    assert.equal(phasePreview.headers['content-type'], 'text/plain; charset=utf-8');
    corruptArchivedDigest = true;
    assert.equal((await request(publicPort, 'GET', phaseDownloadPath, { cookie: memberCookie })).status, 502);
    corruptArchivedDigest = false;
    const readsBeforeUnsafe = phaseReads.length;
    assert.equal((await request(publicPort, 'GET', phaseDownloadPath.replace('01-result.md', '01-result.md%2Fescape'), { cookie: memberCookie })).status, 400);
    assert.equal(phaseReads.length, readsBeforeUnsafe);

    const crossOpen = await request(publicPort, 'POST', `/forge-gateway/api/conversations/${memberOwn.value.conversation.id}/open`, {
      cookie: adminCookie, csrf: adminSession.value.csrfToken, body: {},
    });
    assert.equal(crossOpen.status, 403);
    const crossStop = await request(publicPort, 'POST', `/forge-gateway/api/conversations/${memberOwn.value.conversation.id}/stop`, {
      cookie: adminCookie, csrf: adminSession.value.csrfToken, body: {},
    });
    assert.equal(crossStop.status, 403);

    const authorize = (conversation, cookie) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: internalPort, method: 'POST', path: '/internal/taskspace-authorize', headers: {
        cookie,
        'x-forge-taskspace-id': conversation.taskId,
        'x-forge-browser-host': `127.0.0.1:${conversation.status === 'active' ? (conversation.id === adminOwn.value.conversation.id ? 24000 : 24001) : 0}`,
        'x-forge-browser-origin': `http://127.0.0.1:${conversation.id === adminOwn.value.conversation.id ? 24000 : 24001}`,
        'x-forge-browser-sec-fetch-site': 'same-origin',
      } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(await authorize(adminOwn.value.conversation, adminCookie), 204);
    assert.equal(await authorize(adminOwn.value.conversation, memberCookie), 403);

    const executionPrepareBody = {
      schemaVersion: 1,
      route: 'session.prompt',
      classification: 'claimable-text',
      rpcId: 'rpc:admin:1',
      dshSessionId: 'session:admin:1',
      mode: 'queue',
      bodyDigest: 'a'.repeat(64),
      textDigest: 'b'.repeat(64),
      promptText: '修复分页',
      bodyBytes: 128,
      imageCount: 0,
      requestId: 'request:admin:0001',
    };
    const prepare = await request(internalPort, 'POST', '/internal/taskspace-execution-prepare', {
      internal: true,
      cookie: adminCookie,
      headers: {
        'x-forge-taskspace-id': adminOwn.value.conversation.taskId,
        'x-forge-browser-host': '127.0.0.1:24000',
        'x-forge-browser-origin': 'http://127.0.0.1:24000',
        'x-forge-browser-sec-fetch-site': 'same-origin',
      },
      body: executionPrepareBody,
    });
    assert.equal(prepare.status, 200, JSON.stringify(prepare.value));
    assert.equal(executionPrepares.length, 1);
    assert.equal(executionPrepares[0].actorUserId, adminSession.value.user.id);
    assert.equal(executionPrepares[0].actorUsername, 'admin');
    assert.equal(executionPrepares[0].workspaceWriteAuthorized, true);
    assert.equal(executionPrepares[0].conversationId, adminOwn.value.conversation.id);
    assert.equal(executionPrepares[0].taskId, adminOwn.value.conversation.taskId);
    assert.equal(executionPrepares[0].projectSlug, 'validation-project');
    assert.equal(executionPrepares[0].promptBody, undefined, 'legacy callers may omit the raw prompt body');

    const promptBody = JSON.stringify({
      type: 'client-request',
      rpcId: 'rpc:admin:raw-body',
      method: 'session.prompt',
      payload: {
        sessionId: 'session:admin:raw-body',
        mode: 'queue',
        content: [{ type: 'text', text: '修复分页' }],
      },
    });
    const classifiedPrompt = classifyPinnedDshPromptBody(Buffer.from(promptBody), 'session.prompt');
    const preparedRawBody = await request(internalPort, 'POST', '/internal/taskspace-execution-prepare', {
      internal: true,
      cookie: adminCookie,
      headers: {
        'x-forge-taskspace-id': adminOwn.value.conversation.taskId,
        'x-forge-browser-host': '127.0.0.1:24000',
        'x-forge-browser-origin': 'http://127.0.0.1:24000',
        'x-forge-browser-sec-fetch-site': 'same-origin',
      },
      body: { ...classifiedPrompt, promptBody, requestId: 'request:admin:raw-body' },
    });
    assert.equal(preparedRawBody.status, 200, JSON.stringify(preparedRawBody.value));
    assert.equal(executionPrepares.length, 2);
    assert.equal(executionPrepares[1].promptBody, promptBody);

    const mismatchedRawBody = await request(internalPort, 'POST', '/internal/taskspace-execution-prepare', {
      internal: true,
      cookie: adminCookie,
      headers: {
        'x-forge-taskspace-id': adminOwn.value.conversation.taskId,
        'x-forge-browser-host': '127.0.0.1:24000',
        'x-forge-browser-origin': 'http://127.0.0.1:24000',
        'x-forge-browser-sec-fetch-site': 'same-origin',
      },
      body: { ...classifiedPrompt, textDigest: '0'.repeat(64), promptBody, requestId: 'request:admin:raw-mismatch' },
    });
    assert.equal(mismatchedRawBody.status, 400);
    assert.equal(executionPrepares.length, 2, 'a raw body that conflicts with its classification never reaches Manager');
    const forgedPrepare = await request(internalPort, 'POST', '/internal/taskspace-execution-prepare', {
      internal: true,
      cookie: adminCookie,
      headers: {
        'x-forge-taskspace-id': adminOwn.value.conversation.taskId,
        'x-forge-browser-host': '127.0.0.1:24000',
        'x-forge-browser-origin': 'http://127.0.0.1:24000',
        'x-forge-browser-sec-fetch-site': 'same-origin',
      },
      body: { ...executionPrepareBody, actorUserId: memberId },
    });
    assert.equal(forgedPrepare.status, 400);
    assert.equal(executionPrepares.length, 2);
    const forgedWriteCapability = await request(internalPort, 'POST', '/internal/taskspace-execution-prepare', {
      internal: true, cookie: adminCookie,
      headers: {
        'x-forge-taskspace-id': adminOwn.value.conversation.taskId,
        'x-forge-browser-host': '127.0.0.1:24000',
        'x-forge-browser-origin': 'http://127.0.0.1:24000',
        'x-forge-browser-sec-fetch-site': 'same-origin',
      },
      body: { ...executionPrepareBody, workspaceWriteAuthorized: true },
    });
    assert.equal(forgedWriteCapability.status, 400);
    assert.equal(executionPrepares.length, 2, 'the browser cannot supply its own write capability');

    const disabled = await request(publicPort, 'POST', `/forge-gateway/api/admin/users/${memberId}/status`, {
      cookie: adminCookie, csrf: adminSession.value.csrfToken, body: { status: 'disabled' },
    });
    assert.equal(disabled.status, 200);
    assert.equal(await authorize(memberOwn.value.conversation, memberCookie), 401);
    const stoppedAdmin = await request(publicPort, 'POST', `/forge-gateway/api/conversations/${adminOwn.value.conversation.id}/stop`, {
      cookie: adminCookie, csrf: adminSession.value.csrfToken, body: {},
    });
    assert.equal(stoppedAdmin.status, 200);
    assert.equal((await request(publicPort, 'GET', `/forge-gateway/api/conversations/${adminOwn.value.conversation.id}/outputs`, { cookie: adminCookie })).status, 200);
  } finally {
    await close(servers.publicServer);
    await close(servers.internalServer);
    await rm(root, { recursive: true, force: true });
  }
});

test('one platform login lists every project but server-side membership gates project conversations and TaskSpace access', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-platform-gateway-'));
  const maintenanceFencePath = await committedFence(root, 'functional-platform-1');
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const bootstrap = await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8');
  const bootstrapPassword = /^password=(.+)$/m.exec(bootstrap)[1];
  const projects = [
    { slug: 'project-alpha', displayName: '项目 Alpha', uiPort: 18100, projectKind: 'delivery', createdAt: '2026-08-28T10:00:00Z' },
    { slug: 'project-beta', displayName: '项目 Beta', uiPort: 18101, projectKind: 'replica', createdAt: '2026-08-28T11:00:00Z' },
  ];
  const materialPromotions = [];
  const managers = new Map(projects.map((project, index) => [project.slug, {
    health: async () => ({ ok: true }),
    create: async ({ taskId, actorId, actorUserId, conversationId }) => ({ taskspace: {
      schemaVersion: 2, taskId, actorId, actorUserId, conversationId, accessMode: 'conversation',
      status: 'active', harnessPort: 25000 + index, protectedExecutionEligible: true,
    } }),
    start: async (taskId) => ({ taskspace: { taskId, status: 'active', harnessPort: 25000 + index } }),
    stop: async (taskId) => ({ taskspace: { taskId, status: 'stopped', harnessPort: 25000 + index } }),
    materials: async ({ includeIntake }) => ({
      accepted: { items: [{ path: 'business/需求.md', filename: '需求.md', category: 'business', bytes: 12 }], total: 1 },
      intake: includeIntake
        ? { items: [{ path: 'incoming/2026-08-28/batch/待审.md', filename: '待审.md', sha256: 'a'.repeat(64) }], total: 501 }
        : { items: [], total: 0 },
      categories: [{ value: 'business', label: '业务资料' }],
    }),
    promoteMaterial: async (value) => {
      materialPromotions.push(value);
      return {
        idempotent: false,
        material: { path: 'business/待审.md', filename: '待审.md', category: 'business', sha256: value.expectedSha256, bytes: 10 },
      };
    },
  }]));
  const servers = await createConversationGateway({
    store,
    projectDirectory: {
      list: async () => projects,
      get: async (slug) => projects.find((project) => project.slug === slug),
    },
    managerForProject: async (slug) => managers.get(slug),
    staticRoot: path.resolve('docker/harness/conversation-gateway'),
    publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1',
    maintenanceFencePath,
    operatorToken: 'p'.repeat(64),
  });
  const publicPort = await listen(servers.publicServer);
  const internalPort = await listen(servers.internalServer);
  try {
    const firstAdmin = await signIn(publicPort, 'admin', bootstrapPassword);
    const firstSession = await session(publicPort, firstAdmin.cookie);
    const changedAdmin = await request(publicPort, 'POST', '/forge-gateway/api/change-password', {
      cookie: firstAdmin.cookie,
      csrf: firstSession.value.csrfToken,
      body: { currentPassword: bootstrapPassword, newPassword: 'Platform-secure-passphrase-2026!', confirmPassword: 'Platform-secure-passphrase-2026!' },
    });
    const adminCookie = cookieHeader(changedAdmin.headers['set-cookie']);
    const adminSession = await session(publicPort, adminCookie);
    const created = await request(publicPort, 'POST', '/forge-gateway/api/admin/users', {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: { username: 'project-user', displayName: '项目成员', role: 'member', projectSlugs: ['project-alpha'] },
    });
    const memberFirst = await signIn(publicPort, 'project-user', created.value.temporaryPassword);
    const memberFirstSession = await session(publicPort, memberFirst.cookie);
    const changedMember = await request(publicPort, 'POST', '/forge-gateway/api/change-password', {
      cookie: memberFirst.cookie,
      csrf: memberFirstSession.value.csrfToken,
      body: { currentPassword: created.value.temporaryPassword, newPassword: 'Project-member-passphrase-2026!', confirmPassword: 'Project-member-passphrase-2026!' },
    });
    const memberCookie = cookieHeader(changedMember.headers['set-cookie']);
    const memberSession = await session(publicPort, memberCookie);

    const catalog = await request(publicPort, 'GET', '/forge-gateway/api/projects', { cookie: memberCookie });
    assert.equal(catalog.value.total, 2);
    assert.deepEqual(catalog.value.items.map(({ slug, canEnter }) => ({ slug, canEnter })), [
      { slug: 'project-alpha', canEnter: true },
      { slug: 'project-beta', canEnter: false },
    ]);

    const memberMaterials = await request(publicPort, 'GET', '/forge-gateway/api/materials?project=project-alpha', { cookie: memberCookie });
    assert.equal(memberMaterials.status, 200);
    assert.equal(memberMaterials.value.accepted.total, 1);
    assert.equal(memberMaterials.value.intake.total, 0);
    const crossProjectMaterials = await request(publicPort, 'GET', '/forge-gateway/api/materials?project=project-beta', { cookie: memberCookie });
    assert.equal(crossProjectMaterials.status, 403);
    const memberPromotion = await request(publicPort, 'POST', '/forge-gateway/api/materials/promote', {
      cookie: memberCookie,
      csrf: memberSession.value.csrfToken,
      body: { projectSlug: 'project-alpha', sourcePath: 'incoming/x.md', expectedSha256: 'a'.repeat(64), category: 'business' },
    });
    assert.equal(memberPromotion.status, 403);

    const adminMaterials = await request(publicPort, 'GET', '/forge-gateway/api/materials?project=project-alpha', { cookie: adminCookie });
    assert.equal(adminMaterials.status, 200);
    assert.equal(adminMaterials.value.intake.total, 501);
    assert.equal(adminMaterials.value.nextOffset, 200);
    const approved = await request(publicPort, 'POST', '/forge-gateway/api/materials/promote', {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: {
        projectSlug: 'project-alpha',
        sourcePath: 'incoming/2026-08-28/batch/待审.md',
        expectedSha256: 'a'.repeat(64),
        category: 'business',
      },
    });
    assert.equal(approved.status, 200);
    assert.equal(materialPromotions.length, 1);
    assert.equal(materialPromotions[0].actorUsername, 'admin');

    const create = (projectSlug, key) => request(publicPort, 'POST', '/forge-gateway/api/conversations', {
      cookie: memberCookie,
      csrf: memberSession.value.csrfToken,
      headers: { 'idempotency-key': key },
      body: { title: `${projectSlug} 对话`, projectSlug },
    });
    const alpha = await create('project-alpha', 'conversation:project:alpha:01');
    assert.equal(alpha.status, 201, JSON.stringify(alpha.value));
    const betaDenied = await create('project-beta', 'conversation:project:beta:001');
    assert.equal(betaDenied.status, 403);
    assert.equal(betaDenied.value.code, 'PROJECT_FORBIDDEN');

    const grant = await request(publicPort, 'POST', `/forge-gateway/api/admin/users/${created.value.user.id}/projects`, {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: { projectSlugs: ['project-alpha', 'project-beta'] },
    });
    assert.equal(grant.status, 200);
    assert.deepEqual(grant.value.user.projectSlugs, ['project-alpha', 'project-beta']);
    assert.equal((await create('project-beta', 'conversation:project:beta:002')).status, 201);

    const revoke = await request(publicPort, 'POST', `/forge-gateway/api/admin/users/${created.value.user.id}/projects`, {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: { projectSlugs: ['project-beta'] },
    });
    assert.equal(revoke.status, 200);
    const directAfterRevoke = await request(internalPort, 'POST', '/internal/taskspace-authorize', {
      internal: true,
      cookie: memberCookie,
      headers: {
        'x-forge-project-slug': 'project-alpha',
        'x-forge-taskspace-id': alpha.value.conversation.taskId,
        'x-forge-browser-host': '127.0.0.1:25000',
        'x-forge-browser-origin': 'http://127.0.0.1:25000',
        'x-forge-browser-sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(directAfterRevoke.status, 403);
  } finally {
    await close(servers.publicServer);
    await close(servers.internalServer);
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy DSH sessions are peer conversations with exact selection, pagination, and shared TaskSpace lifecycle', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-legacy-conversations-'));
  const maintenanceFencePath = await committedFence(root, 'legacy-session-surface-1');
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const bootstrap = await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8');
  const bootstrapPassword = /^password=(.+)$/m.exec(bootstrap)[1];
  const managerCalls = [];
  const manager = {
    health: async () => ({ ok: true }),
    create: async () => { throw new Error('existing archive must not be recreated'); },
    start: async (taskId) => {
      managerCalls.push(['start', taskId]);
      return { taskspace: {
        schemaVersion: 1,
        taskId,
        actorId: 'admin',
        actorUserId: null,
        conversationId: 'legacy-shared-history-20260827',
        accessMode: 'conversation',
        status: 'active',
        harnessPort: 26027,
        protectedExecutionEligible: false,
      } };
    },
    stop: async (taskId) => {
      managerCalls.push(['stop', taskId]);
      return { taskspace: { taskId, status: 'stopped', harnessPort: 26027 } };
    },
  };
  const servers = await createConversationGateway({
    store,
    manager,
    staticRoot: path.resolve('docker/harness/conversation-gateway'),
    publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1',
    projectSlug: 'validation-project',
    maintenanceFencePath,
    operatorToken: 'l'.repeat(64),
  });
  const publicPort = await listen(servers.publicServer);
  const internalPort = await listen(servers.internalServer);
  try {
    const firstLogin = await signIn(publicPort, 'admin', bootstrapPassword);
    const firstSession = await session(publicPort, firstLogin.cookie);
    const changed = await request(publicPort, 'POST', '/forge-gateway/api/change-password', {
      cookie: firstLogin.cookie,
      csrf: firstSession.value.csrfToken,
      body: {
        currentPassword: bootstrapPassword,
        newPassword: 'Legacy-owner-passphrase-2026!',
        confirmPassword: 'Legacy-owner-passphrase-2026!',
      },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.value));
    const adminCookie = cookieHeader(changed.headers['set-cookie']);
    const adminSession = await session(publicPort, adminCookie);
    assert.equal(adminSession.status, 200, JSON.stringify(adminSession.value));
    const legacyMemberCreated = await request(publicPort, 'POST', '/forge-gateway/api/admin/users', {
      cookie: adminCookie, csrf: adminSession.value.csrfToken,
      body: { username: 'legacy-member', displayName: '历史成员', role: 'member' },
    });
    const legacyMemberFirstLogin = await signIn(publicPort, 'legacy-member', legacyMemberCreated.value.temporaryPassword);
    const legacyMemberFirstSession = await session(publicPort, legacyMemberFirstLogin.cookie);
    const legacyMemberChanged = await request(publicPort, 'POST', '/forge-gateway/api/change-password', {
      cookie: legacyMemberFirstLogin.cookie, csrf: legacyMemberFirstSession.value.csrfToken,
      body: { currentPassword: legacyMemberCreated.value.temporaryPassword,
        newPassword: 'Archive-reader-passphrase-2026!', confirmPassword: 'Archive-reader-passphrase-2026!' },
    });
    assert.equal(legacyMemberChanged.status, 200, JSON.stringify(legacyMemberChanged.value));
    const legacyMemberCookie = cookieHeader(legacyMemberChanged.headers['set-cookie']);
    const sessionRows = [
      ['session-056418e4-0c3c-6efa-e1f2-2c4a5841ba25', '周长庆-测试-危废功能开发'],
      ['session-fde2f11b-17cf-65c8-2657-12d458ac4a32', '周长庆-测试-APP功能'],
      ['cdaffb3d-54fb-451f-9a4f-09985642d2f1', '迁移前同级对话 A'],
      ['1758295e-f704-4a9b-a7bf-0687252f9b11', '迁移前同级对话 B'],
    ];
    await store.mutate((value) => {
      value.conversations.push({
        id: 'legacy-shared-history-20260827',
        taskId: 'legacy-history-20260827',
        projectSlug: 'validation-project',
        ownerUserId: adminSession.value.user.id,
        title: '历史对话归档（迁移前共享 Harness）',
        status: 'stopped',
        port: 26027,
        createdAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
        lastOpenedAt: null,
        lastError: null,
        hiddenFromList: true,
        conversationKind: 'legacy-archive',
      });
      sessionRows.forEach(([legacySessionId, title], index) => value.conversations.push({
        id: `legacy-session-20260827-${index + 1}`,
        taskId: 'legacy-history-20260827',
        projectSlug: 'validation-project',
        ownerUserId: adminSession.value.user.id,
        title,
        status: 'stopped',
        port: 26027,
        createdAt: `2026-08-${String(20 + index).padStart(2, '0')}T00:00:00.000Z`,
        updatedAt: `2026-08-${String(20 + index).padStart(2, '0')}T00:00:00.000Z`,
        lastOpenedAt: null,
        lastError: null,
        conversationKind: 'legacy-session',
        legacySessionId,
        legacyArchiveConversationId: 'legacy-shared-history-20260827',
      }));
      value.conversations.push({ id: 'legacy-session-other-owner', taskId: 'legacy-history-20260827',
        projectSlug: 'validation-project', ownerUserId: legacyMemberCreated.value.user.id, title: '另一人员的历史对话',
        status: 'active', port: 26027, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z',
        lastOpenedAt: null, lastError: null, conversationKind: 'legacy-session', legacySessionId: 'session-other-owner',
        legacyArchiveConversationId: 'legacy-shared-history-20260827' });
    });

    const projects = await request(publicPort, 'GET', '/forge-gateway/api/projects', { cookie: adminCookie });
    assert.equal(projects.value.items[0].ownConversationCount, 4);
    const firstPage = await request(publicPort, 'GET', '/forge-gateway/api/conversations?offset=0', { cookie: adminCookie });
    assert.equal(firstPage.status, 200);
    assert.equal(firstPage.value.items.length, 3);
    assert.equal(firstPage.value.nextOffset, 3);
    assert.equal(firstPage.value.total, 4);
    assert.ok(firstPage.value.items.every((entry) => entry.kind === 'legacy-session'));
    assert.ok(firstPage.value.items.every((entry) => entry.id !== 'legacy-shared-history-20260827'));
    const secondPage = await request(publicPort, 'GET', '/forge-gateway/api/conversations?offset=3', { cookie: adminCookie });
    assert.equal(secondPage.value.items.length, 1);
    assert.equal(secondPage.value.nextOffset, null);

    const opened = await request(publicPort, 'POST', '/forge-gateway/api/conversations/legacy-session-20260827-1/open', {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: {},
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.value));
    assert.equal(opened.value.url, 'http://127.0.0.1:26027/?forgeSession=session-056418e4-0c3c-6efa-e1f2-2c4a5841ba25');
    assert.deepEqual(managerCalls[0], ['start', 'legacy-history-20260827']);
    const activeGroup = await store.read((value) => value.conversations.filter((entry) => entry.taskId === 'legacy-history-20260827'));
    assert.ok(activeGroup.every((entry) => entry.status === 'active' && entry.port === 26027));

    const authorized = await request(internalPort, 'POST', '/internal/taskspace-authorize', {
      internal: true,
      cookie: adminCookie,
      headers: {
        'x-forge-taskspace-id': 'legacy-history-20260827',
        'x-forge-browser-host': '127.0.0.1:26027',
        'x-forge-browser-origin': 'http://127.0.0.1:26027',
        'x-forge-browser-sec-fetch-site': 'same-origin',
      },
    });
    assert.equal(authorized.status, 204);
    assert.deepEqual(JSON.parse(authorized.headers['x-forge-output-session-ids']), sessionRows.map(([sessionId]) => sessionId).sort());
    const memberAuthorized = await request(internalPort, 'POST', '/internal/taskspace-authorize', {
      internal: true, cookie: legacyMemberCookie,
      headers: { 'x-forge-taskspace-id': 'legacy-history-20260827', 'x-forge-browser-host': '127.0.0.1:26027',
        'x-forge-browser-origin': 'http://127.0.0.1:26027', 'x-forge-browser-sec-fetch-site': 'same-origin' },
    });
    assert.equal(memberAuthorized.status, 204);
    assert.deepEqual(JSON.parse(memberAuthorized.headers['x-forge-output-session-ids']), ['session-other-owner']);
    const disabledLegacyMember = await request(publicPort, 'POST', `/forge-gateway/api/admin/users/${legacyMemberCreated.value.user.id}/status`, {
      cookie: adminCookie, csrf: adminSession.value.csrfToken, body: { status: 'disabled' },
    });
    assert.equal(disabledLegacyMember.status, 200);
    assert.equal((await request(internalPort, 'POST', '/internal/taskspace-authorize', { internal: true, cookie: legacyMemberCookie,
      headers: { 'x-forge-taskspace-id': 'legacy-history-20260827', 'x-forge-browser-host': '127.0.0.1:26027',
        'x-forge-browser-origin': 'http://127.0.0.1:26027', 'x-forge-browser-sec-fetch-site': 'same-origin' } })).status, 401);
    await store.mutate((value) => { value.conversations = value.conversations.filter((entry) => entry.id !== 'legacy-session-other-owner'); });

    const stopped = await request(publicPort, 'POST', '/forge-gateway/api/conversations/legacy-session-20260827-2/stop', {
      cookie: adminCookie,
      csrf: adminSession.value.csrfToken,
      body: {},
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.value.relatedConversations.length, 4);
    assert.ok(stopped.value.relatedConversations.every((entry) => entry.status === 'stopped'));
    assert.deepEqual(managerCalls[1], ['stop', 'legacy-history-20260827']);
    const stoppedGroup = await store.read((value) => value.conversations.filter((entry) => entry.taskId === 'legacy-history-20260827'));
    assert.ok(stoppedGroup.every((entry) => entry.status === 'stopped'));
  } finally {
    await close(servers.publicServer);
    await close(servers.internalServer);
    await rm(root, { recursive: true, force: true });
  }
});

test('credential UI never refreshes users before the one-time password dialog closes', async () => {
  const source = await readFile(path.resolve('docker/harness/conversation-gateway/gateway.js'), 'utf8');
  assert.match(source, /isCurrentUser[\s\S]*修改自己的密码/);
  assert.match(source, /credential-dialog'\)\.addEventListener\('close'/);
  assert.match(source, /showCredential\(value\.user\.username, value\.temporaryPassword\);\n\s*},\n\s*\)\)\);/);
  assert.doesNotMatch(source, /showCredential\(value\.user\.username, value\.temporaryPassword\);\n\s*await loadUsers\(\)/);
});

test('hidden gateway controls remain absent even when component styles set display', async () => {
  const stylesheet = await readFile(path.resolve('docker/harness/conversation-gateway/gateway.css'), 'utf8');
  assert.match(stylesheet, /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
});

test('conversation pages expose three primary rows before loading more', async () => {
  const server = await readFile(path.resolve('docker/harness/conversation-gateway.mjs'), 'utf8');
  const source = await readFile(path.resolve('docker/harness/conversation-gateway/gateway.js'), 'utf8');
  assert.match(server, /const limit = 3;[\s\S]*nextOffset: offset \+ limit < rows\.length \? offset \+ limit : null/);
  assert.match(source, /more\.hidden = state\.nextOffset === null/);
  assert.match(source, /if \(!state\.selectedProjectSlug \|\| state\.conversationLoading\) return/);
  assert.match(source, /more\.disabled = state\.conversationLoading/);
  assert.match(source, /state\.conversations\.push\(\.\.\.value\.items\.filter/);
  assert.match(source, /isLegacySession \? '迁移前历史对话' : `工作舱 \$\{conversation\.taskId\}`/);
});

test('conversation archive UI keeps cross-owner administration read-only', async () => {
  const markup = await readFile(path.resolve('docker/harness/conversation-gateway/index.html'), 'utf8');
  const source = await readFile(path.resolve('docker/harness/conversation-gateway/gateway.js'), 'utf8');
  assert.match(markup, /id="all-conversations-control"[^>]*hidden/);
  assert.match(markup, /管理员可查阅对话输入、输出和归档文件/);
  assert.match(markup, /id="output-preview"[^>]*tabindex="0"/);
  assert.match(source, /all-conversations-control'\)\.hidden = user\.role !== 'admin'/);
  assert.match(source, /conversationScope === 'all' \? '&scope=all' : ''/);
  assert.match(source, /if \(!isOwnConversation\(conversation\)\) \{[\s\S]*continue;/);
  assert.match(source, /urlFor = outputFileUrl/);
  assert.match(source, /urlFor\(conversation, snapshot, file, true\)/);
  assert.match(source, /outputs\?offset=\$\{state\.outputOffset\}&limit=20/);
  assert.match(source, /output-more-button'\)\.addEventListener\('click'/);
  assert.match(source, /response\.status === 401[\s\S]*window\.location\.assign\('\/forge-gateway\/login'\)/);
});

test('material pages use a separately bounded Manager response and load every advertised page', async () => {
  const server = await readFile(path.resolve('docker/harness/conversation-gateway.mjs'), 'utf8');
  const source = await readFile(path.resolve('docker/harness/conversation-gateway/gateway.js'), 'utf8');
  assert.match(server, /const MAX_MANAGER_RESPONSE_BYTES = 2 \* 1024 \* 1024;/);
  assert.match(server, /received <= maxResponseBytes/);
  assert.match(server, /nextOffset: offset \+ limit < Math\.max\(/);
  assert.match(source, /do \{[\s\S]*offset=\$\{offset\}&limit=500[\s\S]*offset = value\.nextOffset;[\s\S]*\} while \(offset !== null\);/);
});

test('selecting a project promotes conversations and provides a project switch action', async () => {
  const markup = await readFile(path.resolve('docker/harness/conversation-gateway/index.html'), 'utf8');
  const source = await readFile(path.resolve('docker/harness/conversation-gateway/gateway.js'), 'utf8');
  const stylesheet = await readFile(path.resolve('docker/harness/conversation-gateway/gateway.css'), 'utf8');
  assert.match(markup, /id="switch-project-button"[^>]*>切换项目<\/button>/);
  assert.match(source, /document\.querySelector\('#project-section'\)\.hidden = true;[\s\S]*document\.querySelector\('#conversation-section'\)\.hidden = false;/);
  assert.match(source, /document\.querySelector\('#material-section'\)\.hidden = true;[\s\S]*document\.body\.classList\.add\('conversation-focus'\);/);
  assert.match(source, /await loadConversations\(\);/);
  assert.doesNotMatch(source, /Promise\.all\(\[[\s\S]*loadConversations\(\),[\s\S]*loadMaterials\(\)/);
  assert.match(stylesheet, /body\.conversation-focus #material-section[\s\S]*body\.conversation-focus #audit-section\s*\{\s*display:\s*none\s*!important;/);
  assert.match(source, /switch-project-button'\)\.addEventListener\('click', \(\) => showProjectDirectory\(\)\)/);
});
