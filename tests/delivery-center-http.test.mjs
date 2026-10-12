import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConversationStateStore, createConversationGateway } from '../docker/harness/conversation-gateway.mjs';
import { csvCell, deliveryQuery, deliveryResponse } from '../docker/harness/delivery-center-http.mjs';
import { readDeliveryDatabaseConfig } from '../docker/harness/delivery-center-config.mjs';

const fixtureRequirement = { id: 'req-1', menuPath: ['消防管理', '设备管理', '设备台账'], page: '设备台账',
  name: '=HYPERLINK("https://example.invalid")', description: '设备编号、状态和有效期', fields: [{ name: '设备编号', required: true }],
  rules: ['到期提醒'], permissions: ['设备管理员可维护'], actions: ['查询'], batchIds: ['batch-a', 'batch-b'], status: 'unknown', sources: [] };

function req(port, pathname, { method = 'GET', cookie, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({ host: '127.0.0.1', port, path: pathname, method,
      headers: { host: '127.0.0.1:13080', ...(method === 'GET' ? {} : { origin: 'http://127.0.0.1:13080' }),
        ...(cookie ? { cookie } : {}), ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}), ...headers } }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, text,
          value: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
      });
    });
    request.on('error', reject); request.end(bytes);
  });
}

function cookies(response) { return (response.headers['set-cookie'] ?? []).map((value) => value.split(';')[0]).join('; '); }
async function login(port, username, password) {
  const pre = await req(port, '/forge-gateway/api/auth-context');
  const result = await req(port, '/forge-gateway/api/login', { method: 'POST', cookie: cookies(pre),
    headers: { 'x-forge-csrf-token': pre.value.csrfToken }, body: { username, password } });
  assert.equal(result.status, 200); return cookies(result);
}

test('delivery query rejects ambiguous filters and CSV neutralizes spreadsheet formulas', () => {
  assert.throws(() => deliveryQuery(new URLSearchParams('project=demo-project&project=other-project')));
  assert.throws(() => deliveryQuery(new URLSearchParams('project=demo-project&pageSize=500')));
  assert.throws(() => deliveryQuery(new URLSearchParams('project=demo-project&menuId=../secret')));
  assert.deepEqual(deliveryQuery(new URLSearchParams('project=demo-project&q=消防&page=2')).filters, { q: '消防', page: 2, pageSize: 50 });
  for (const input of ['=1+1', '  @SUM(A1)', '\tformula', '-1+1', '+cmd']) assert.ok(csvCell(input).startsWith('"\''));
  assert.equal(csvCell('正常,"字段"'), '"正常,""字段"""');
});

test('all authenticated roles read the same whole delivery matrix without membership; writes and private conversations remain protected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-delivery-http-'));
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const password = /^password=(.+)$/m.exec(await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8'))[1];
  await store.mutate((state) => {
    const admin = state.users[0]; admin.mustChangePassword = false;
    for (const role of ['member', 'auditor']) state.users.push({ ...admin, id: crypto.randomUUID(), username: `reader-${role}`, displayName: role, role });
    state.memberships = [];
    state.conversations.push({ id: 'private-conversation', projectSlug: 'demo-project', ownerUserId: admin.id,
      taskId: 'private-task', title: '私人对话', status: 'stopped', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  });
  const maintenanceFencePath = path.join(root, 'fence.json');
  await writeFile(maintenanceFencePath, JSON.stringify({ schemaVersion: 1, state: 'committed', epoch: 'delivery-test' }));
  const calls = [];
  const deliveryStore = {
    listProjects: async () => [{ slug: 'demo-project', name: '完整项目' }],
    listMenus: async () => [{ id: 'menu-1', path: ['消防管理'], name: '消防管理', parentId: null }],
    listRequirements: async (_project, filters) => { calls.push(filters); return { items: [fixtureRequirement], total: 1, page: 1, pageSize: 50 }; },
    getRequirement: async (_project, _id, filters) => ({ ...fixtureRequirement, revision: filters.releaseId ? 'historical' : 'current' }),
    listAssets: async (project) => {
      if (project !== 'demo-project') throw Object.assign(new Error('Delivery service rejected the request.'), { code: 'DELIVERY_NOT_FOUND', status: 404 });
      return { items: [{ assetId: 'shared-entity', kind: 'entity', name: '共享人员', menuIds: ['menu-1'] }], total: 1, page: 1, pageSize: 50 };
    },
    exportRequirements: async (_project, filters) => { calls.push(filters); return [fixtureRequirement, { ...fixtureRequirement, id: 'req-2', name: '查询' }]; },
  };
  const servers = await createConversationGateway({ store, deliveryStore, manager: { health: async () => ({ ok: true }) },
    staticRoot: path.resolve('docker/harness/conversation-gateway'), publicOrigin: 'http://127.0.0.1:13080/',
    bindAddress: '127.0.0.1', projectSlug: 'demo-project', operatorToken: 'o'.repeat(64), maintenanceFencePath });
  await new Promise((resolve) => servers.publicServer.listen(0, '127.0.0.1', resolve));
  const port = servers.publicServer.address().port;
  try {
    assert.equal((await req(port, '/forge-gateway/api/delivery/projects')).status, 401);
    const anonymousPage = await req(port, '/forge-gateway/delivery-center');
    assert.equal(anonymousPage.status, 302);
    const results = [];
    for (const username of ['admin', 'reader-member', 'reader-auditor']) {
      const cookie = await login(port, username, password);
      const response = await req(port, '/forge-gateway/api/delivery/requirements?project=demo-project', { cookie });
      assert.equal(response.status, 200); results.push(response.value);
      assert.equal((await req(port, '/forge-gateway/api/delivery/projects', { cookie })).value.items.length, 1);
      assert.equal((await req(port, '/forge-gateway/delivery-center', { cookie })).status, 200);
      assert.equal((await req(port, '/forge-gateway/api/delivery/assets?project=demo-project&kind=entity', { cookie })).value.items[0].assetId, 'shared-entity');
      if (username === 'admin') {
        const excluded = await req(port, '/forge-gateway/api/delivery/assets?project=other-project&kind=entity', { cookie });
        assert.equal(excluded.status, 404);
        assert.equal(excluded.value.code, 'DELIVERY_NOT_FOUND');
      }
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal((await req(port, '/forge-gateway/api/delivery/requirements?project=demo-project', { method, cookie, body: {} })).status, 405);
      }
      if (username !== 'admin') assert.equal((await req(port, '/forge-gateway/api/conversations/private-conversation/outputs', { cookie })).status, 403);
      const historical = await req(port, '/forge-gateway/api/delivery/requirements/req-1?project=demo-project&releaseId=release-1', { cookie });
      assert.equal(historical.value.item.revision, 'historical');
      const exported = await req(port, '/forge-gateway/api/delivery/export?project=demo-project&q=%E6%B6%88%E9%98%B2', { cookie });
      assert.equal(exported.status, 200); assert.equal(exported.headers['x-export-row-count'], '2');
      assert.ok(exported.text.startsWith('\uFEFF')); assert.ok(exported.text.includes("'=HYPERLINK"));
      assert.ok(exported.text.includes('设备编号')); assert.equal(exported.text.trim().split('\r\n').length, 3);
    }
    assert.deepEqual(results[0], results[1]); assert.deepEqual(results[1], results[2]);
    assert.equal(calls.at(-1).q, '消防');
  } finally {
    servers.destroyTrackedConnections();
    await new Promise((resolve) => servers.publicServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('unconfigured delivery database is explicitly unavailable without manufacturing an empty successful dataset', async () => {
  await assert.rejects(deliveryResponse({ method: 'GET', url: new URL('http://local/forge-gateway/api/delivery/projects') }), { code: 'DELIVERY_UNAVAILABLE', status: 503 });
});

test('private database configuration refuses TLS bypass and unapproved configuration fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-delivery-config-'));
  const filename = path.join(root, 'database.json');
  const config = { host: '127.0.0.1', user: 'reader', password: 'test-fixture-only', database: 'delivery_test' };
  try {
    await writeFile(filename, JSON.stringify(config), { mode: 0o600 });
    assert.equal((await readDeliveryDatabaseConfig(filename)).port, 3306);
    await writeFile(filename, JSON.stringify({ ...config, ssl: { rejectUnauthorized: false } }));
    await assert.rejects(readDeliveryDatabaseConfig(filename), /TLS_INVALID/);
    await writeFile(filename, JSON.stringify({ ...config, multipleStatements: true }));
    await assert.rejects(readDeliveryDatabaseConfig(filename), /CONFIG_INVALID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
