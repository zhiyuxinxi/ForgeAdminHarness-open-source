import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConversationStateStore, createConversationGateway } from '../docker/harness/conversation-gateway.mjs';
import { createConversationManager, createExecutionRenewalAuthorityClient } from '../docker/harness/conversation-manager.mjs';
import { classifyPinnedDshPromptBody, digestProductionTaskAuthorityBinding,
  prepareProtectedExecutionContext, readProtectedExecutionContext } from '../docker/harness/forge-execution-context.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
import { readCurrentExecutionRenewalAuthority } from '../docker/harness/forge-protected-acceptance-service.mjs';

function socketName(root, name) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\forge-renewal-${name}-${crypto.randomUUID()}` : path.join(root, `${name}.sock`);
}
async function listen(server, address) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, resolve); });
}
async function close(server) {
  if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function request(transport, route, body, token) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({ ...transport, method: 'POST', path: route,
      headers: { 'content-type': 'application/json', 'content-length': payload.length,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject); req.end(payload);
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-renewal-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectSlug = 'validation-project';
  const token = 'm'.repeat(64);
  const store = new ConversationStateStore({ stateRoot: path.join(root, 'gateway') });
  await store.initialize();
  const actorUserId = '11111111-1111-4111-8111-111111111111';
  const conversationId = 'renewal-conversation';
  const taskId = 'renewal-task';
  await store.mutate((state) => {
    state.users.push({ id: actorUserId, username: 'alice', role: 'member', status: 'active', sessionVersion: 1 });
    state.memberships.push({ userId: actorUserId, projectSlug, access: 'member' });
    state.conversations.push({ id: conversationId, taskId, projectSlug, ownerUserId: actorUserId, status: 'active', port: 23001 });
  });
  const fence = path.join(root, 'fence.json');
  await writeFile(fence, JSON.stringify({ schemaVersion: 1, state: 'committed', epoch: 'renewal-query' }));
  const tokenPath = path.join(root, 'manager-token');
  await writeFile(tokenPath, token);
  const gateway = await createConversationGateway({ store, manager: {}, projectSlug,
    projectDirectory: { list: async () => [{ slug: projectSlug }],
      get: async (slug) => slug === projectSlug ? { slug } : undefined,
      capabilityPaths: (slug) => { assert.equal(slug, projectSlug); return { tokenPath }; } },
    staticRoot: path.resolve('docker/harness/conversation-gateway'),
    publicOrigin: 'http://127.0.0.1:13080/', bindAddress: '127.0.0.1', maintenanceFencePath: fence,
    operatorToken: 'o'.repeat(64) });
  const gatewaySocket = socketName(root, 'gateway');
  await listen(gateway.internalServer, gatewaySocket);
  t.after(() => close(gateway.internalServer));

  const metadata = { schemaVersion: 2, projectSlug, taskId, actorId: 'alice', actorUserId,
    conversationId, branch: `task/alice/${taskId}`, accessMode: 'conversation', status: 'active',
    accessTokenHash: '0'.repeat(64), lastCandidate: null, lastRelease: null,
    harnessPort: 23001, baseCommit: 'a'.repeat(40), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const metadataPath = path.join(root, 'taskspaces', taskId, 'metadata.json');
  await mkdir(path.dirname(metadataPath), { recursive: true });
  await mkdir(path.join(root, 'ops'), { recursive: true });
  await mkdir(path.join(root, 'intake'), { recursive: true });
  await writeFile(metadataPath, JSON.stringify(metadata));
  const prompt = '修复当前页面并发布';
  const directRequest = { ...classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request',
    rpcId: 'renewal-rpc', method: 'session.prompt', payload: { sessionId: 'renewal-session', mode: 'queue',
      content: [{ type: 'text', text: prompt }] } })), 'session.prompt'),
    actorUserId, actorUsername: 'alice', conversationId, requestId: 'renewal-query-prepare' };
  const taskAuthority = { actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src/views/example.vue'], taskProfiles: ['frontend-admin'] };
  const contract = compileForgeTaskExecutionContract({ prompt, ...taskAuthority });
  const oldNow = Date.now() - 16 * 60_000;
  const sourceCommit = 'a'.repeat(40);
  const workspaceFingerprint = 'b'.repeat(64);
  const productionAuthorityId = crypto.randomUUID();
  const controllerGrantDigest = 'c'.repeat(64);
  const trustedPolicyInput = { profile: 'production-controller', sourceCommit, workspaceFingerprint, caseFamily: 'maintenance',
    productionAuthorityId, controllerGrantDigest, expectedContractId: contract.contractId, taskAuthority,
    productionAuthorityDigest: digestProductionTaskAuthorityBinding({ projectSlug, taskId, actorUserId, actorUsername: 'alice',
      conversationId, dshSessionId: directRequest.dshSessionId, route: directRequest.route, rpcId: directRequest.rpcId,
      promptDigest: directRequest.textDigest, sourceCommit, workspaceFingerprint, caseFamily: 'maintenance',
      productionAuthorityId, controllerGrantDigest, contractId: contract.contractId, actionCeiling: 'release', ownedPaths: taskAuthority.ownedPaths }) };
  const context = await prepareProtectedExecutionContext({ projectRoot: root, projectSlug, taskMetadata: metadata,
    request: directRequest, trustedPolicyInput, now: oldNow });
  const lookup = Object.fromEntries(['projectSlug', 'taskId', 'conversationId', 'actorUserId', 'dshSessionId', 'rpcId', 'textDigest']
    .map((key) => [key, context[key]]));
  await readProtectedExecutionContext({ projectRoot: root, taskMetadata: metadata, lookup, now: oldNow });
  const body = { schemaVersion: 1, ...Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'contractId', 'actionCeiling'].map((key) => [key, context[key]])) };
  const managerOptions = { projectRoot: root, projectSlug, intakeRoot: path.join(root, 'intake'),
    controlScript: path.join(root, 'control.sh'), managerToken: token, auditPath: path.join(root, 'ops', 'audit.jsonl'),
    executionRenewalAuthorityClient: createExecutionRenewalAuthorityClient(gatewaySocket, token) };
  const manager = createConversationManager(managerOptions);
  const managerSocket = socketName(root, 'manager');
  await listen(manager, managerSocket); t.after(() => close(manager));
  return { root, store, gateway, gatewaySocket, managerSocket, token, body, metadata, metadataPath, managerOptions };
}

test('renewal authority queries the current account through real Manager and Gateway Unix sockets without renewing execution', async (t) => {
  const f = await fixture(t);
  const statePath = path.join(f.root, 'taskspaces', '.broker', 'executions', `${f.body.taskId}.json`);
  const before = await readFile(statePath);
  const result = await readCurrentExecutionRenewalAuthority(f.managerSocket, f.body);
  const { checkedAt, authorizedActionCeiling, ...echo } = result;
  assert.deepEqual(echo, f.body); assert.equal(authorizedActionCeiling, 'release');
  assert.ok(Math.abs(Date.now() - Date.parse(checkedAt)) < 5000);
  assert.deepEqual(await readFile(statePath), before, 'a read-only authorization query must not renew the execution lease');
  const deniedControl = await request({ socketPath: f.managerSocket }, '/v1/taskspaces', {});
  assert.equal(deniedControl.status, 401, 'Unix query must not bypass other Manager Bearer routes');
});

test('renewal authority denies changed account, membership, conversation ownership and invalid service token', async (t) => {
  const f = await fixture(t);
  const call = () => request({ socketPath: f.managerSocket }, '/v1/execution-renewal-authority', f.body);
  for (const [field, bad, good] of [['status', 'disabled', 'active'], ['role', 'auditor', 'member']]) {
    await f.store.mutate((state) => { state.users.find((entry) => entry.id === f.body.actorUserId)[field] = bad; });
    assert.equal((await call()).status, 403, field);
    await assert.rejects(readCurrentExecutionRenewalAuthority(f.managerSocket, f.body), { code: 'CONVERSATION_EXECUTION_RENEWAL_DENIED' });
    await f.store.mutate((state) => { state.users.find((entry) => entry.id === f.body.actorUserId)[field] = good; });
  }
  await f.store.mutate((state) => { state.memberships = []; });
  assert.equal((await call()).status, 403, 'revoked project membership');
  await f.store.mutate((state) => { state.memberships.push({ userId: f.body.actorUserId, projectSlug: f.body.projectSlug, access: 'member' });
    state.conversations[0].ownerUserId = crypto.randomUUID(); });
  assert.equal((await call()).status, 403, 'wrong conversation owner');
  const wrongToken = await request({ socketPath: f.gatewaySocket }, '/internal/taskspace-execution-renewal-authority', f.body, 'x'.repeat(64));
  assert.equal(wrongToken.status, 403);
});

test('renewal authority rejects forged context fields and TCP entry even with the correct Manager token', async (t) => {
  const f = await fixture(t);
  for (const patch of [{ rpcId: 'another-rpc' }, { dshSessionId: 'another-session' }, { contractId: 'f'.repeat(64) },
    { actionCeiling: 'workspace-write' }, { projectSlug: 'another-project' }, { extra: true }]) {
    const result = await request({ socketPath: f.managerSocket }, '/v1/execution-renewal-authority', { ...f.body, ...patch });
    assert.equal(result.status, 409, JSON.stringify(patch));
  }
  const tcpManager = createConversationManager(f.managerOptions);
  await listen(tcpManager, { host: '127.0.0.1', port: 0 }); t.after(() => close(tcpManager));
  const result = await request({ host: '127.0.0.1', port: tcpManager.address().port }, '/v1/execution-renewal-authority', f.body, f.token);
  assert.equal(result.status, 403);
});

test('renewal authority returns recoverable unavailable when its current account service is unreachable', async (t) => {
  const f = await fixture(t);
  await close(f.gateway.internalServer);
  const result = await request({ socketPath: f.managerSocket }, '/v1/execution-renewal-authority', f.body);
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(result.body.code, 'EXECUTION_RENEWAL_AUTHORITY_UNAVAILABLE');
  assert.equal(result.body.details.retryable, true);
  await assert.rejects(readCurrentExecutionRenewalAuthority(f.managerSocket, f.body),
    { code: 'CONVERSATION_EXECUTION_AUTHORITY_UNAVAILABLE', retryable: true });
});
