import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ConversationStateStore, createConversationGateway } from '../docker/harness/conversation-gateway.mjs';

function request(port, method, pathname, { cookie, csrf, body, range } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { host: '127.0.0.1:13080', ...(method === 'GET' ? {} : { origin: 'http://127.0.0.1:13080' }),
      ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-forge-csrf-token': csrf } : {}), ...(range ? { range } : {}),
      ...(encoded ? { 'content-type': 'application/json', 'content-length': encoded.length } : {}) };
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        const buffer = Buffer.concat(chunks); let value; try { value = JSON.parse(buffer); } catch { value = undefined; }
        resolve({ status: response.statusCode, headers: response.headers, buffer, value });
      });
    }); req.on('error', reject); req.end(encoded);
  });
}
const cookies = response => (response.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
async function fixture(client) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-production-gateway-'));
  const store = new ConversationStateStore({ stateRoot: root }); await store.initialize();
  const password = /^password=(.+)$/m.exec(await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8'))[1];
  await store.mutate(state => { state.users[0].mustChangePassword = false; });
  const fence = path.join(root, 'fence.json'); await writeFile(fence, JSON.stringify({ schemaVersion: 1, state: 'committed', epoch: 'production-ui-test' }));
  const projects = [{ slug: 'project-alpha', displayName: '项目甲' }, { slug: 'project-beta', displayName: '项目乙' }];
  const gateway = await createConversationGateway({ store, productionClient: client, projectDirectory: { list: async () => projects, get: async slug => projects.find(project => project.slug === slug) },
    managerForProject: async () => ({ health: async () => ({ ok: true }) }), staticRoot: path.resolve('docker/harness/conversation-gateway'),
    publicOrigin: 'http://127.0.0.1:13080/', bindAddress: '127.0.0.1', maintenanceFencePath: fence, operatorToken: 'o'.repeat(64) });
  await new Promise(resolve => gateway.publicServer.listen(0, '127.0.0.1', resolve)); const port = gateway.publicServer.address().port;
  const preauth = await request(port, 'GET', '/forge-gateway/api/auth-context');
  const login = await request(port, 'POST', '/forge-gateway/api/login', { cookie: cookies(preauth), csrf: preauth.value.csrfToken, body: { username: 'admin', password } });
  assert.equal(login.status, 200); const cookie = cookies(login); const session = await request(port, 'GET', '/forge-gateway/api/session', { cookie });
  return { port, store, cookie, csrf: session.value.csrfToken, user: session.value.user,
    close: async () => { await new Promise(resolve => gateway.publicServer.close(resolve)); await rm(root, { recursive: true, force: true }); } };
}

test('acceptance credentials require a current project member and CSRF and are never cacheable', async () => {
  const calls = [];
  const f = await fixture({ request: async value => {
    calls.push(value);
    return { item: { accountId: 'review-admin', username: 'reviewer', password: 'fixture-only-secret', revision: 2 } };
  } });
  const url = '/forge-gateway/api/production/jobs/job-1/handover/credentials';
  const body = { project: 'project-alpha', accountId: 'review-admin', expectedRevision: 2, expectedManifestSha256: 'a'.repeat(64) };
  try {
    assert.equal((await request(f.port, 'POST', url, { body })).status, 401);
    assert.equal((await request(f.port, 'POST', url, { cookie: f.cookie, body })).status, 403);
    await f.store.mutate(state => { state.users[0].role = 'member'; state.memberships.push({ userId: f.user.id, projectSlug: 'project-alpha', access: 'member' }); });
    assert.equal((await request(f.port, 'POST', url, { cookie: f.cookie, csrf: f.csrf, body: { ...body, project: 'project-beta' } })).status, 403);
    assert.equal(calls.length, 0);
    const response = await request(f.port, 'POST', url, { cookie: f.cookie, csrf: f.csrf, body });
    assert.equal(response.status, 200);
    assert.match(response.headers['cache-control'], /no-store/);
    assert.equal(response.value.item.password, 'fixture-only-secret');
    assert.equal(calls[0].actor.id, f.user.id);
    await f.store.mutate(state => { state.memberships = []; });
    assert.equal((await request(f.port, 'POST', url, { cookie: f.cookie, csrf: f.csrf, body })).status, 403);
    assert.equal(calls.length, 1);
  } finally { await f.close(); }
});

test('production gateway authenticates, checks membership and CSRF, and only injects the signed-in actor', async () => {
  const calls = []; const f = await fixture({ request: async value => { calls.push(value); return { items: [] }; } });
  const url = '/forge-gateway/api/production/releases';
  try {
    assert.equal((await request(f.port, 'GET', `${url}?project=project-alpha`)).status, 401);
    assert.equal((await request(f.port, 'POST', url, { cookie: f.cookie, body: { project: 'project-alpha' } })).status, 403);
    assert.equal((await request(f.port, 'POST', url, { cookie: f.cookie, csrf: f.csrf, body: { project: 'project-alpha', actor: { id: 'forged' } } })).status, 400);
    assert.equal((await request(f.port, 'GET', `${url}?project=project-alpha&project=project-beta`, { cookie: f.cookie })).status, 400);
    await f.store.mutate(state => { state.users[0].role = 'member'; state.memberships.push({ userId: f.user.id, projectSlug: 'project-alpha', access: 'member' }); });
    assert.equal((await request(f.port, 'GET', `${url}?project=project-beta`, { cookie: f.cookie })).status, 403);
    assert.equal(calls.length, 0);
    const body = { project: 'project-alpha', candidateId: 'candidate-1', title: '生产版', idempotencyKey: 'create-1' };
    assert.equal((await request(f.port, 'POST', url, { cookie: f.cookie, csrf: f.csrf, body })).status, 200);
    assert.deepEqual(calls[0].body, body); assert.equal(calls[0].actor.id, f.user.id); assert.equal(calls[0].actor.username, 'admin');
    assert.equal(calls[0].path, url);
    await f.store.mutate(state => { state.users[0].mustChangePassword = true; });
    assert.equal((await request(f.port, 'GET', `${url}?project=project-alpha`, { cookie: f.cookie })).status, 403);
  } finally { await f.close(); }
});

test('production download streams Range bytes behind project access and preserves service refusals', async () => {
  const calls = []; const f = await fixture({ download: async value => {
    calls.push(value); if (value.path.includes('blocked')) throw Object.assign(new Error('尚未通过人工验收。'), { code: 'PRODUCTION_NOT_READY', status: 409 });
    return { status: 206, headers: { 'content-type': 'application/octet-stream', 'content-length': '3', 'content-range': 'bytes 0-2/6', 'accept-ranges': 'bytes', 'content-disposition': 'attachment; filename="production.tar"', 'x-private-path': '/do-not-expose' }, stream: Readable.from([Buffer.from('abc')]) };
  } });
  try {
    const url = '/forge-gateway/api/production/jobs/job-1/download?project=project-alpha&file=bundle';
    assert.equal((await request(f.port, 'GET', url)).status, 401);
    await f.store.mutate(state => { state.users[0].role = 'member'; state.memberships.push({ userId: f.user.id, projectSlug: 'project-alpha', access: 'member' }); });
    assert.equal((await request(f.port, 'GET', url.replace('project-alpha', 'project-beta'), { cookie: f.cookie })).status, 403);
    assert.equal(calls.length, 0);
    const result = await request(f.port, 'GET', url, { cookie: f.cookie, range: 'bytes=0-2' });
    assert.equal(result.status, 206); assert.equal(result.buffer.toString(), 'abc'); assert.equal(result.headers['content-range'], 'bytes 0-2/6'); assert.equal(result.headers['x-private-path'], undefined);
    assert.deepEqual(calls[0], { path: url, range: 'bytes=0-2' });
    const blocked = await request(f.port, 'GET', url.replace('job-1', 'blocked'), { cookie: f.cookie }); assert.equal(blocked.status, 409); assert.equal(blocked.value.code, 'PRODUCTION_NOT_READY');
    const page = await request(f.port, 'GET', '/forge-gateway/production-delivery', { cookie: f.cookie }); assert.equal(page.status, 200); assert.match(page.buffer.toString(), /生产发布包与上线/);
  } finally { await f.close(); }
});

test('row export keeps source and delivery data bound to the authenticated project and actor', async () => {
  const calls = []; const f = await fixture({ request: async value => { calls.push(value); return { item: { id: 'job-export-1' } }; } });
  const url = '/forge-gateway/api/production/exports';
  const body = { project: 'project-alpha', candidateId: 'candidate-1', sourceArtifactId: 'artifact-1',
    mode: 'initial', architecture: 'amd64', delivery: { recipient: '实施负责人', projectName: '客户一期', purpose: '首次交付' }, idempotencyKey: 'export-1' };
  try {
    await f.store.mutate(state => { state.users[0].role = 'member'; state.memberships.push({ userId: f.user.id, projectSlug: 'project-alpha', access: 'member' }); });
    assert.equal((await request(f.port, 'POST', url, { cookie: f.cookie, body })).status, 403);
    assert.equal((await request(f.port, 'POST', url, { cookie: f.cookie, csrf: f.csrf, body: { ...body, project: 'project-beta' } })).status, 403);
    assert.equal((await request(f.port, 'POST', url, { cookie: f.cookie, csrf: f.csrf, body: { ...body, actor: { id: 'forged' } } })).status, 400);
    assert.equal((await request(f.port, 'GET', '/forge-gateway/api/production/capacity?project=project-beta', { cookie: f.cookie })).status, 403);
    assert.equal(calls.length, 0);
    const result = await request(f.port, 'POST', url, { cookie: f.cookie, csrf: f.csrf, body });
    assert.equal(result.status, 200); assert.equal(result.value.item.id, 'job-export-1');
    assert.deepEqual(calls[0].body, body); assert.equal(calls[0].actor.id, f.user.id); assert.equal(calls[0].path, url);
    const panel = await request(f.port, 'GET', '/forge-gateway/assets/production-delivery-panel.html', { cookie: f.cookie });
    assert.equal(panel.status, 200); assert.match(panel.headers['content-type'], /^text\/html/);
    assert.match(panel.buffer.toString(), /production-release-list/);
    assert.doesNotMatch(panel.buffer.toString(), /<script\b/i);
  } finally { await f.close(); }
});
