import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ConversationStateStore,
  createConversationGateway,
  readConversationGatewayMaintenanceFence,
} from '../docker/harness/conversation-gateway.mjs';

const OPERATOR_TOKEN = 'm'.repeat(64);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(port, method, pathname, { authorization = undefined, cookie = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: '127.0.0.1:13080' };
    if (method !== 'GET' && method !== 'HEAD') headers.origin = 'http://127.0.0.1:13080';
    if (authorization !== undefined) headers.authorization = authorization;
    if (cookie !== undefined) headers.cookie = cookie;
    const outgoing = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          headers: response.headers,
          value: raw === '' ? {} : JSON.parse(raw),
        });
      });
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function atomicFenceWrite(fencePath, value) {
  const temporary = `${fencePath}.next`;
  const content = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, fencePath);
}

function runNodeProgram(program) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['-e', program], (error) => resolve(error?.code ?? 0));
  });
}

function upgradeRequest(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    socket.once('error', reject);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', finish);
    socket.once('close', finish);
    socket.once('connect', () => {
      socket.write([
        'GET /forge-gateway/ws HTTP/1.1',
        'Host: 127.0.0.1:13080',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: Zm9yZ2UtdGVzdC1rZXk=',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
  });
}

function requestOnConnectedSocket(socket, pathname) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    socket.once('error', reject);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('end', finish);
    socket.once('close', finish);
    socket.write([
      `GET ${pathname} HTTP/1.1`,
      'Host: 127.0.0.1:13080',
      'Connection: close',
      '',
      '',
    ].join('\r\n'));
  });
}

test('control-plane Compose mounts the host fence directory read-only for atomic inode replacement', async () => {
  const compose = await readFile(path.resolve('templates/conversation-control-plane/compose.yaml'), 'utf8');
  assert.match(
    compose,
    /CONVERSATION_GATEWAY_MAINTENANCE_FENCE_FILE:\s*\/run\/forge-maintenance\/gateway-fence\.json/,
  );
  assert.match(
    compose,
    /\$\{CONVERSATION_CONTROL_PLANE_ROOT:\?[^}]+\}\/maintenance:\/run\/forge-maintenance:ro/,
  );
  assert.doesNotMatch(compose, /gateway-fence\.json:\/run\/forge-maintenance\/gateway-fence\.json/);
});

test('Compose healthcheck treats maintenance as live but rejects ambiguous or broken health responses', async () => {
  const compose = await readFile(path.resolve('templates/conversation-control-plane/compose.yaml'), 'utf8');
  const programMatch = /healthcheck:\s*\r?\n\s+test:\s*\["CMD", "node", "-e", "([^"\r\n]+)"\]/.exec(compose);
  assert.ok(programMatch, 'the exact Node healthcheck program must remain statically inspectable');

  let reply = { status: 200, value: { ok: true, status: 'open', epoch: 'healthcheck-1' } };
  const server = http.createServer((request, response) => {
    const body = Buffer.from(JSON.stringify(reply.value));
    response.writeHead(reply.status, {
      'content-length': body.length,
      'content-type': 'application/json',
    });
    response.end(body);
  });
  const port = await listen(server);
  const program = programMatch[1].replace('127.0.0.1:3080', `127.0.0.1:${port}`);
  try {
    assert.equal(await runNodeProgram(program), 0, 'open response must be healthy');

    reply = {
      status: 503,
      value: { ok: false, status: 'maintenance', code: 'GATEWAY_MAINTENANCE', reason: 'FENCE_MAINTENANCE' },
    };
    assert.equal(await runNodeProgram(program), 0, 'recognized maintenance response must be healthy');

    reply = { status: 503, value: { ok: false, status: 'maintenance', code: 'UNRELATED_FAILURE' } };
    assert.equal(await runNodeProgram(program), 1, 'an unrelated 503 must fail health');

    reply = { status: 200, value: { ok: true, status: 'maintenance' } };
    assert.equal(await runNodeProgram(program), 1, 'an ambiguous 200 must fail health');

    reply = { status: 503, value: 'not-the-maintenance-contract' };
    assert.equal(await runNodeProgram(program), 1, 'an invalid JSON shape must fail health');
  } finally {
    await close(server);
  }
});

test('maintenance fence is strict and fails closed for missing, malformed, and non-committed content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-gateway-fence-schema-'));
  const fencePath = path.join(root, 'gateway-fence.json');
  try {
    assert.deepEqual(await readConversationGatewayMaintenanceFence(fencePath), {
      open: false,
      state: 'missing',
      reason: 'FENCE_MISSING',
    });

    await atomicFenceWrite(fencePath, '{broken-json');
    assert.equal((await readConversationGatewayMaintenanceFence(fencePath)).reason, 'FENCE_INVALID');

    await atomicFenceWrite(fencePath, { schemaVersion: 1, state: 'open', epoch: 'schema-test-1' });
    assert.equal((await readConversationGatewayMaintenanceFence(fencePath)).reason, 'FENCE_INVALID');

    await atomicFenceWrite(fencePath, {
      schemaVersion: 1,
      state: 'committed',
      epoch: 'schema-test-2',
      comment: 'extra fields are not part of the fence contract',
    });
    assert.equal((await readConversationGatewayMaintenanceFence(fencePath)).reason, 'FENCE_INVALID');

    await atomicFenceWrite(fencePath, { schemaVersion: 1, state: 'maintenance', epoch: 'schema-test-3' });
    assert.deepEqual(await readConversationGatewayMaintenanceFence(fencePath), {
      open: false,
      state: 'maintenance',
      reason: 'FENCE_MAINTENANCE',
      epoch: 'schema-test-3',
    });

    await atomicFenceWrite(fencePath, { schemaVersion: 1, state: 'committed', epoch: 'schema-test-4' });
    assert.deepEqual(await readConversationGatewayMaintenanceFence(fencePath), {
      open: true,
      state: 'committed',
      epoch: 'schema-test-4',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public, authorization, and operator traffic stay closed until one committed epoch is atomically visible', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-gateway-fence-runtime-'));
  const fencePath = path.join(root, 'gateway-fence.json');
  const store = new ConversationStateStore({ stateRoot: path.join(root, 'state') });
  await store.initialize();
  const gatewayOptions = {
    store,
    manager: {
      health: async () => ({ ok: true }),
      create: async () => { throw new Error('manager create must not run in this test'); },
      start: async () => { throw new Error('manager start must not run in this test'); },
      stop: async () => { throw new Error('manager stop must not run in this test'); },
    },
    staticRoot: path.resolve('docker/harness/conversation-gateway'),
    publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1',
    projectSlug: 'maintenance-test',
    maintenanceFencePath: fencePath,
    operatorToken: OPERATOR_TOKEN,
  };
  const servers = await createConversationGateway(gatewayOptions);
  const publicPort = await listen(servers.publicServer);
  const internalPort = await listen(servers.internalServer);
  const operatorPort = await listen(servers.operatorServer);
  try {
    const missing = await request(publicPort, 'GET', '/healthz');
    assert.equal(missing.status, 503);
    assert.equal(missing.value.code, 'GATEWAY_MAINTENANCE');
    assert.equal(missing.value.reason, 'FENCE_MISSING');
    assert.equal(missing.headers['retry-after'], '5');
    assert.equal((await request(publicPort, 'GET', '/forge-gateway/api/auth-context')).status, 503);
    assert.equal((await request(internalPort, 'POST', '/internal/taskspace-authorize')).status, 503);
    assert.equal((await request(operatorPort, 'GET', '/v1/users', {
      authorization: `Bearer ${OPERATOR_TOKEN}`,
    })).status, 503);

    const idleTcpSocket = net.createConnection({ host: '127.0.0.1', port: publicPort });
    await once(idleTcpSocket, 'connect');
    const idleTcpClosed = once(idleTcpSocket, 'close');
    await atomicFenceWrite(fencePath, { schemaVersion: 1, state: 'maintenance', epoch: 'cutover-100' });
    for (const port of [publicPort, internalPort, operatorPort]) {
      const health = await request(port, 'GET', '/healthz');
      assert.equal(health.status, 503);
      assert.equal(health.value.status, 'maintenance');
      assert.equal(health.value.reason, 'FENCE_MAINTENANCE');
      assert.equal(health.value.epoch, 'cutover-100');
      assert.deepEqual(health.value.drain, {
        mode: 'connection-tracked',
        activeTcpConnections: 0,
        activeHttpRequests: 0,
        activeUpgradeConnections: 0,
        drained: true,
      });
      assert.equal(health.headers.connection, 'close');
    }
    await idleTcpClosed;
    const postDrainSocket = net.createConnection({ host: '127.0.0.1', port: publicPort });
    await once(postDrainSocket, 'connect');
    await once(postDrainSocket, 'close');
    const rejectedUpgrade = await upgradeRequest(publicPort);
    assert.match(rejectedUpgrade, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
    assert.match(rejectedUpgrade, /"code":"GATEWAY_MAINTENANCE"/);
    assert.equal((await request(publicPort, 'POST', '/forge-gateway/api/login')).status, 503);

    await atomicFenceWrite(fencePath, '{"schemaVersion":1,"state":"committed"');
    const invalid = await request(publicPort, 'GET', '/healthz');
    assert.equal(invalid.status, 503);
    assert.equal(invalid.value.reason, 'FENCE_INVALID');

    const crossingDrainBoundary = net.createConnection({ host: '127.0.0.1', port: publicPort });
    await once(crossingDrainBoundary, 'connect');
    await atomicFenceWrite(fencePath, { schemaVersion: 1, state: 'committed', epoch: 'cutover-100' });
    const crossingResponse = await requestOnConnectedSocket(crossingDrainBoundary, '/healthz');
    assert.match(crossingResponse, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
    assert.match(crossingResponse, /"reason":"DRAIN_CONNECTION_REJECTED"/);
    for (const port of [publicPort, internalPort, operatorPort]) {
      const health = await request(port, 'GET', '/healthz');
      assert.equal(health.status, 200);
      assert.deepEqual(health.value, { ok: true, status: 'open', epoch: 'cutover-100' });
    }
    assert.equal((await request(publicPort, 'GET', '/forge-gateway/api/auth-context')).status, 200);
    assert.equal((await request(publicPort, 'POST', '/forge-gateway/api/login')).status, 403);
    assert.equal((await request(internalPort, 'POST', '/internal/taskspace-authorize')).status, 403);
    assert.equal((await request(operatorPort, 'GET', '/v1/users', {
      authorization: `Bearer ${OPERATOR_TOKEN}`,
    })).status, 200);

    await atomicFenceWrite(fencePath, { schemaVersion: 1, state: 'maintenance', epoch: 'cutover-101' });
    assert.equal((await request(publicPort, 'GET', '/forge-gateway/api/auth-context')).status, 503);

    await Promise.all([close(servers.publicServer), close(servers.internalServer), close(servers.operatorServer)]);
    const restarted = await createConversationGateway(gatewayOptions);
    const restartedPublicPort = await listen(restarted.publicServer);
    try {
      const afterRestart = await request(restartedPublicPort, 'GET', '/healthz');
      assert.equal(afterRestart.status, 503);
      assert.equal(afterRestart.value.reason, 'FENCE_MAINTENANCE');
      assert.equal(afterRestart.value.epoch, 'cutover-101');

      await atomicFenceWrite(fencePath, { schemaVersion: 1, state: 'committed', epoch: 'cutover-101' });
      const restartBoundary = await request(restartedPublicPort, 'GET', '/healthz');
      assert.equal(restartBoundary.status, 503);
      assert.equal(restartBoundary.value.reason, 'DRAIN_CONNECTION_REJECTED');
      assert.equal((await request(restartedPublicPort, 'GET', '/healthz')).status, 200);

      const shutdownSocket = net.createConnection({ host: '127.0.0.1', port: restartedPublicPort });
      await once(shutdownSocket, 'connect');
      const shutdownSocketClosed = once(shutdownSocket, 'close');
      restarted.destroyTrackedConnections();
      await shutdownSocketClosed;
    } finally {
      await close(restarted.publicServer);
    }
  } finally {
    await Promise.all([close(servers.publicServer), close(servers.internalServer), close(servers.operatorServer)]);
    await rm(root, { recursive: true, force: true });
  }
});

test('maintenance health cannot report drained while an admitted HTTP request is still active', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-gateway-active-drain-'));
  const fencePath = path.join(root, 'gateway-fence.json');
  await atomicFenceWrite(fencePath, { schemaVersion: 1, state: 'committed', epoch: 'active-drain-1' });
  const store = new ConversationStateStore({ stateRoot: path.join(root, 'state') });
  await store.initialize();
  const originalRead = store.read.bind(store);
  let releaseRead;
  let markReadStarted;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readRelease = new Promise((resolve) => { releaseRead = resolve; });
  let blockNextRead = true;
  store.read = async (...arguments_) => {
    if (blockNextRead) {
      blockNextRead = false;
      markReadStarted();
      await readRelease;
    }
    return originalRead(...arguments_);
  };
  const servers = await createConversationGateway({
    store,
    manager: {
      health: async () => ({ ok: true }),
      create: async () => { throw new Error('manager create must not run in this test'); },
      start: async () => { throw new Error('manager start must not run in this test'); },
      stop: async () => { throw new Error('manager stop must not run in this test'); },
    },
    staticRoot: path.resolve('docker/harness/conversation-gateway'),
    publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1',
    projectSlug: 'active-drain-test',
    maintenanceFencePath: fencePath,
    operatorToken: OPERATOR_TOKEN,
  });
  const publicPort = await listen(servers.publicServer);
  const activeRequest = request(publicPort, 'GET', '/', {
    cookie: 'forge_gateway_session=active-drain-probe',
  });
  try {
    await readStarted;
    await atomicFenceWrite(fencePath, { schemaVersion: 1, state: 'maintenance', epoch: 'active-drain-1' });
    const draining = await request(publicPort, 'GET', '/healthz');
    assert.equal(draining.status, 503);
    assert.equal(draining.value.drain.mode, 'connection-tracked');
    assert.equal(draining.value.drain.activeHttpRequests, 1);
    assert.equal(draining.value.drain.activeTcpConnections, 1);
    assert.equal(draining.value.drain.drained, false);

    releaseRead();
    assert.equal((await activeRequest).status, 302);
    const drained = await request(publicPort, 'GET', '/healthz');
    assert.equal(drained.value.drain.activeHttpRequests, 0);
    assert.equal(drained.value.drain.activeTcpConnections, 0);
    assert.equal(drained.value.drain.drained, true);
  } finally {
    releaseRead();
    await activeRequest.catch(() => {});
    await close(servers.publicServer);
    await rm(root, { recursive: true, force: true });
  }
});
