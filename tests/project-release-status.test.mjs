import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createProjectReleaseStatusServer, readProjectReleaseStatus, projectReleaseSnapshot } from '../docker/harness/project-release-status.mjs';
import { TaskspaceBroker } from '../docker/harness/taskspace-broker.mjs';
import { createConversationManager } from '../docker/harness/conversation-manager.mjs';
import { ConversationStateStore, createConversationGateway, createManagerClient } from '../docker/harness/conversation-gateway.mjs';
import { hashPassword } from '../docker/harness/conversation-policy.mjs';

const startedAt = '2026-09-20T01:00:00.000Z';
const active = { operationId: 'op-current', action: 'release', taskId: 'c-alice', actorId: 'alice', startedAt };
const lastRelease = { ...active, status: 'running', stage: 'candidate-validation', commit: 'a'.repeat(40) };
const job = { jobId: 'job-current', status: 'running', stage: 'candidate-build', commit: 'a'.repeat(40),
  provenance: { taskId: 'c-alice', actorId: 'alice', candidateCommit: 'a'.repeat(40) },
  startedAt: '2026-09-20T01:00:01.000Z', updatedAt: '2026-09-20T01:00:02.000Z', services: ['forge-admin', 'forge-ui'], version: 'release-test' };
const snap = (input = {}) => projectReleaseSnapshot({ projectSlug: 'validation-project', active, lastRelease,
  runner: { active: true, lastJob: job }, ...input });

test('release status follows the current job and never leaks runner secrets or another candidate stage', () => {
  const result = snap({ runner: { active: true, lastJob: { ...job, diagnosticText: 'password=secret', env: 'private', services: ['forge-admin', 'mysql'] } } });
  assert.equal(result.operation.stage, 'candidate-build');
  assert.deepEqual(result.operation.services, ['forge-admin']);
  assert.doesNotMatch(JSON.stringify(result), /password|secret|private|mysql/);
  const previous = snap({ runner: { active: false, lastJob: { ...job, startedAt: '2026-09-19T01:00:00Z', stage: 'complete', status: 'success' } } });
  assert.equal(previous.operation.stage, 'candidate-validation');
  assert.equal(previous.operation.status, 'running');
  const otherTask = snap({ runner: { active: true, lastJob: { ...job, provenance: { taskId: 'c-bob' } } } });
  assert.equal(otherTask.operation.stage, 'candidate-validation');
});

test('preparation, promotion, draft saving and interrupted state are not successful deployment', () => {
  assert.equal(snap({ lastRelease: { ...lastRelease, stage: 'promote-candidate' },
    runner: { active: false, lastJob: { ...job, status: 'prepared', stage: 'candidate-prepared' } } }).operation.stage, 'promote-candidate');
  assert.equal(snap({ active: { ...active, action: 'checkpoint' } }).operation.action, 'checkpoint');
  assert.equal(snap({ active: null, runner: { active: false, lastJob: null } }).operation.status, 'interrupted');
  assert.equal(snap({ active: null, lastRelease: null, runner: { active: false, lastJob: { ...job, status: 'prepared' } } }).operation.status, 'prepared');
  const orphan = snap({ active: null, lock: { ...active, createdAt: startedAt }, runner: { active: false, lastJob: null } });
  assert.equal(orphan.availability, 'unknown');
  assert.equal(orphan.occupied, true);
  assert.equal(orphan.operation.status, 'unknown');
  assert.equal(snap({ active: null, runner: null }).occupied, null);
});

test('final broker success and failure are retained with safe, actionable diagnostics', () => {
  const success = snap({ active: null, runner: { active: false, lastJob: { ...job, status: 'success', stage: 'complete' } },
    lastRelease: { ...lastRelease, status: 'success', runnerJobId: job.jobId, completedAt: '2026-09-20T01:05:00Z' } });
  assert.equal(success.operation.status, 'success');
  assert.equal(success.operation.version, 'release-test');
  assert.equal(success.operation.stage, 'complete');
  const failed = snap({ active: null, runner: { active: false, lastJob: null }, lastRelease: { ...lastRelease, status: 'failed',
    error: { code: 'TASKSPACE_REBASE_REQUIRED', message: 'secret=private' } } });
  assert.match(failed.operation.errorSummary, /最新集成版本/);
  assert.doesNotMatch(JSON.stringify(failed), /secret|private/);
});

test('broker project status reads no source and does not remove an orphan release lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-release-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const broker = new TaskspaceBroker({ projectRoot: root, projectSlug: 'validation-project',
    releaseClient: async () => ({ active: false, lastJob: null }), command: () => assert.fail('status must not execute commands') });
  await mkdir(broker.releaseLockRoot, { recursive: true });
  const lock = JSON.stringify({ ...active, instanceId: 'old', createdAt: startedAt });
  await writeFile(broker.releaseLockOwnerFile, lock);
  const value = await broker.projectReleaseStatus();
  assert.equal(value.availability, 'unknown');
  assert.equal(await readFile(broker.releaseLockOwnerFile, 'utf8'), lock);
  broker.activeRelease = { ...active, action: 'integrate' };
  assert.equal((await broker.projectReleaseStatus()).operation.action, 'integrate');
});

const listen = (server, address = undefined) => new Promise((resolve, reject) => {
  server.once('error', reject);
  if (address) server.listen(address, () => resolve(address));
  else server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(resolve));

test('private status transport is bounded, read only, and reports lost service instead of replaying cached state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-status-ipc-'));
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\forge-status-${crypto.randomUUID()}` : path.join(root, 's.sock');
  const server = createProjectReleaseStatusServer(async () => snap());
  t.after(async () => { if (server.listening) await close(server); await rm(root, { recursive: true, force: true }); });
  await listen(server, socket);
  assert.equal((await readProjectReleaseStatus(socket)).operation.actorId, 'alice');
  const rejected = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method: 'POST', path: '/status' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(rejected, 404);
  await close(server);
  await assert.rejects(readProjectReleaseStatus(socket, 100));
});

test('two authenticated project members share status, while outsiders and revoked members cannot query it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-status-members-'));
  const managerToken = 'm'.repeat(64);
  let current = snap(); let available = true; let reads = 0;
  const managerServer = createConversationManager({ projectRoot: root, projectSlug: 'validation-project', intakeRoot: path.join(root, 'intake'),
    controlScript: path.join(root, 'control.sh'), managerToken, auditPath: path.join(root, 'manager-audit.jsonl'),
    projectReleaseStatusReader: async () => { reads++; if (!available) throw new Error('secret'); return current; },
    runControl: () => assert.fail('status must not run lifecycle operations') });
  const managerPort = await listen(managerServer);
  const store = new ConversationStateStore({ stateRoot: path.join(root, 'gateway') });
  await store.initialize();
  const passwordHash = await hashPassword('Status-test-passphrase-2026!');
  const now = new Date().toISOString();
  await store.mutate((state) => {
    for (const username of ['alice', 'bob', 'outsider']) {
      state.users.push({ id: username, username, displayName: `${username} <script>`, role: 'member', status: 'active', passwordHash,
        mustChangePassword: false, sessionVersion: 1, createdAt: now, updatedAt: now });
      if (username !== 'outsider') state.memberships.push({ userId: username, projectSlug: 'validation-project', access: 'member', createdAt: now, updatedAt: now });
    }
  });
  const fence = path.join(root, 'fence.json');
  await writeFile(fence, JSON.stringify({ schemaVersion: 1, state: 'committed', epoch: 'release-status-test' }));
  const gateway = await createConversationGateway({ store, manager: createManagerClient({ baseUrl: `http://127.0.0.1:${managerPort}`, token: managerToken }),
    staticRoot: path.resolve('docker/harness/conversation-gateway'), publicOrigin: 'http://127.0.0.1:13080/', bindAddress: '127.0.0.1',
    projectSlug: 'validation-project', maintenanceFencePath: fence, operatorToken: 'o'.repeat(64) });
  const port = await listen(gateway.publicServer);
  t.after(async () => { await close(gateway.publicServer); await close(managerServer); await rm(root, { recursive: true, force: true }); });
  const request = (pathname, cookie, body, csrf) => new Promise((resolve, reject) => {
    const encoded = body ? JSON.stringify(body) : undefined;
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: body ? 'POST' : 'GET', headers: {
      host: '127.0.0.1:13080', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json',
        'content-length': Buffer.byteLength(encoded), origin: 'http://127.0.0.1:13080', 'x-forge-csrf-token': csrf } : {}),
    } }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject); res.on('end', () => resolve({ code: res.statusCode,
        value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        cookie: (res.headers['set-cookie'] ?? []).map((v) => v.split(';')[0]).join('; ') }));
    });
    req.on('error', reject); req.end(encoded);
  });
  const login = async (username) => {
    const preauth = await request('/forge-gateway/api/auth-context');
    const signed = await request('/forge-gateway/api/login', preauth.cookie, { username, password: 'Status-test-passphrase-2026!' }, preauth.value.csrfToken);
    assert.equal(signed.code, 200, JSON.stringify(signed.value)); return signed.cookie;
  };
  const alice = await login('alice'); const bob = await login('bob'); const outsider = await login('outsider');
  const endpoint = '/forge-gateway/api/project-release-status?project=validation-project';
  assert.equal((await request(endpoint)).code, 401);
  const a = await request(endpoint, alice); const b = await request(endpoint, bob);
  assert.equal(a.code, 200, JSON.stringify(a.value)); assert.equal(b.code, 200);
  assert.equal(a.value.operation.owner.isSelf, true); assert.equal(b.value.operation.owner.isSelf, false);
  assert.equal(b.value.operation.taskId, 'c-alice'); assert.equal(b.value.operation.stage, 'candidate-build');
  const count = reads;
  assert.equal((await request(endpoint, outsider)).code, 403); assert.equal(reads, count);
  await store.mutate((state) => { state.memberships = state.memberships.filter((m) => m.userId !== 'bob'); });
  assert.equal((await request(endpoint, bob)).code, 403);
  current = { ...snap(), projectSlug: 'another-project' };
  assert.equal((await request(endpoint, alice)).code, 503);
  current = { ...snap(), secret: 'TOP_SECRET', operation: { ...snap().operation, diagnosticText: 'TOP_SECRET', rollbackEnv: '/private' } };
  assert.doesNotMatch(JSON.stringify((await request(endpoint, alice)).value), /TOP_SECRET|private/);
  available = false;
  assert.equal((await request(endpoint, alice)).code, 503);
});
