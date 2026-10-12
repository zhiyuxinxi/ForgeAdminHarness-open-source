import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConversationStateStore, createConversationGateway } from '../docker/harness/conversation-gateway.mjs';

const staticRoot = path.resolve('docker/harness/conversation-gateway');
const readJson = async (name) => JSON.parse(await readFile(path.join(staticRoot, name), 'utf8'));
const nonempty = (value) => assert.ok(typeof value === 'string' && value.trim().length > 0);

test('published explanations keep meaningful scope, roles, status and update links', async () => {
  const catalog = await readJson('platform-catalog.json');
  const updates = await readJson('platform-updates.json');
  const roles = new Set(catalog.roles.map((role) => role.id));
  const features = catalog.categories.flatMap((category) => category.groups.flatMap((group) => group.features));
  const ids = new Set(features.map((feature) => feature.id));
  assert.equal(catalog.journey.length, 6, 'the main explanation covers the six construction topics');
  for (const story of catalog.journey) {
    ['title', 'period', 'problem', 'example', 'result'].forEach((key) => nonempty(story[key]));
    assert.ok(story.changes.length && story.featureIds.length);
    story.featureIds.forEach((id) => assert.ok(ids.has(id), `unresolved explanation link ${id}`));
  }
  assert.equal(ids.size, features.length, 'every capability has one stable identity');
  assert.equal(catalog.phases.length, 8, 'the actual eight development stages stay distinct from publication');
  for (const role of catalog.roles) ['title', 'need', 'value', 'responsibility'].forEach((key) => nonempty(role[key]));
  for (const feature of features) {
    ['id', 'title', 'summary', 'before', 'after', 'since'].forEach((key) => nonempty(feature[key]));
    assert.ok(['available', 'partial', 'in-progress'].includes(feature.status));
    assert.ok(feature.benefits.length && feature.limitations.length && feature.roles.length);
    feature.benefits.forEach(nonempty); feature.limitations.forEach(nonempty);
    feature.roles.forEach((role) => assert.ok(roles.has(role), `unknown role ${role}`));
  }
  const toolIds = catalog.tools.map((tool) => tool.id);
  assert.equal(new Set(toolIds).size, toolIds.length, 'do not count one packaged tool more than once');
  catalog.tools.forEach((tool) => assert.ok(['tool', 'service', 'template'].includes(tool.kind)));
  const updateIds = updates.updates.map((update) => update.id);
  assert.equal(new Set(updateIds).size, updateIds.length);
  for (const update of updates.updates) {
    assert.match(update.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(update.date <= updates.asOf, 'a future plan must not appear as a past release');
    assert.ok(['released', 'partial', 'in-progress'].includes(update.status));
    ['title', 'before', 'after', 'benefit', 'scope'].forEach((key) => nonempty(update[key]));
    update.featureIds.forEach((id) => assert.ok(ids.has(id), `unresolved capability ${id}`));
    update.roles.forEach((role) => assert.ok(roles.has(role)));
  }
});

test('the platform explanation and data use the existing real authentication boundary', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-platform-value-'));
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const password = /^password=(.+)$/m.exec(await readFile(path.join(root, 'bootstrap-admin-password'), 'utf8'))[1];
  const fence = path.join(root, 'fence.json');
  await writeFile(fence, JSON.stringify({ schemaVersion: 1, state: 'committed', epoch: 'platform-value' }));
  const gateway = await createConversationGateway({ store, manager: {}, staticRoot,
    publicOrigin: 'http://127.0.0.1:13080/', bindAddress: '127.0.0.1', projectSlug: 'validation-project',
    maintenanceFencePath: fence, operatorToken: 'o'.repeat(64) });
  await new Promise((resolve) => gateway.publicServer.listen(0, '127.0.0.1', resolve));
  const port = gateway.publicServer.address().port;
  const request = (route, { cookie, csrf, body } = {}) => new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const headers = { host: '127.0.0.1:13080', connection: 'close' };
    if (cookie) headers.cookie = cookie;
    if (body) Object.assign(headers, { origin: 'http://127.0.0.1:13080', 'content-type': 'application/json', 'x-forge-csrf-token': csrf });
    const req = http.request({ host: '127.0.0.1', port, path: route, method: body ? 'POST' : 'GET', headers }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(payload);
  });
  const cookies = (result) => result.headers['set-cookie'].map((value) => value.split(';', 1)[0]).join('; ');
  try {
    const anonymous = await request('/forge-gateway/platform-value');
    assert.equal(anonymous.status, 302);
    assert.equal(anonymous.headers.location, '/forge-gateway/login');
    for (const name of ['platform-catalog.json', 'platform-updates.json']) assert.equal((await request('/forge-gateway/assets/' + name)).status, 401);
    const auth = await request('/forge-gateway/api/auth-context');
    const signed = await request('/forge-gateway/api/login', { cookie: cookies(auth), csrf: JSON.parse(auth.body).csrfToken, body: { username: 'admin', password } });
    const cookie = cookies(signed);
    assert.equal((await request('/forge-gateway/platform-value', { cookie })).headers.location, '/forge-gateway/change-password');
    assert.equal((await request('/forge-gateway/assets/platform-catalog.json', { cookie })).status, 403);
    await store.mutate((state) => { state.users.find((user) => user.username === 'admin').mustChangePassword = false; });
    for (const [route, file] of [['/forge-gateway/platform-value', 'platform-value.html'], ...['platform-value.js', 'platform-value.css', 'platform-catalog.json', 'platform-updates.json'].map((file) => ['/forge-gateway/assets/' + file, file])]) {
      const response = await request(route, { cookie });
      assert.equal(response.status, 200, route);
      assert.equal(response.body, await readFile(path.join(staticRoot, file), 'utf8'));
      assert.match(response.headers['content-security-policy'], /script-src 'self'/);
      assert.ok(['no-cache', 'no-store'].includes(response.headers['cache-control']));
    }
  } finally {
    gateway.publicServer.closeAllConnections();
    await new Promise((resolve) => gateway.publicServer.close(resolve));
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});
