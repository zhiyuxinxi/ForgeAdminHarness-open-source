import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import test from 'node:test';
import { ConversationStateStore, createConversationGateway } from '../docker/harness/conversation-gateway.mjs';

const staticRoot = path.resolve('docker/harness/conversation-gateway');
const vendorRoot = path.join(staticRoot, 'mermaid');

test('pinned Mermaid browser distribution retains integrity, license and all local module imports', async () => {
  const manifest = JSON.parse(await readFile(path.join(vendorRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.name, 'mermaid');
  assert.equal(manifest.version, '12.1.0');
  assert.equal(manifest.license, 'MIT');
  assert.match(manifest.integrity, /^sha512-/);
  assert.ok(manifest.files.LICENSE);
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const bytes = await readFile(path.join(vendorRoot, relative));
    assert.equal(bytes.length, expected.bytes, relative);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected.sha256, relative);
    if (!relative.endsWith('.mjs')) continue;
    const source = bytes.toString('utf8');
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)) {
      const imported = match[1];
      if (!imported.endsWith('.mjs')) continue;
      assert.ok(imported.startsWith('./') || imported.startsWith('../'), `${relative}: remote module ${imported}`);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), imported));
      assert.ok(manifest.files[resolved], `${relative}: missing ${resolved}`);
    }
  }
});

test('Gateway serves same-origin Mermaid entry and chunks without exposing arbitrary files or weakening CSP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-vendor-'));
  const store = new ConversationStateStore({ stateRoot: root });
  await store.initialize();
  const fence = path.join(root, 'fence.json');
  await writeFile(fence, JSON.stringify({ schemaVersion: 1, state: 'committed', epoch: 'vendor-test' }));
  const gateway = await createConversationGateway({ store, manager: { health: async () => ({ ok: true }) },
    staticRoot, publicOrigin: 'http://127.0.0.1:13080/', bindAddress: '127.0.0.1', projectSlug: 'forge-base',
    operatorToken: 'o'.repeat(64), maintenanceFencePath: fence });
  await new Promise(resolve => gateway.publicServer.listen(0, '127.0.0.1', resolve));
  const port = gateway.publicServer.address().port;
  function get(target) {
    return new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port, path: target, headers: { host: '127.0.0.1:13080' } }, response => {
        const chunks = []; response.on('data', data => chunks.push(data));
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
      }); request.on('error', reject);
    });
  }
  try {
    const manifest = JSON.parse(await readFile(path.join(vendorRoot, 'manifest.json'), 'utf8'));
    const chunk = Object.keys(manifest.files).find(name => name.startsWith('chunks/'));
    for (const file of ['mermaid.esm.min.mjs', chunk]) {
      const response = await get(`/forge-gateway/assets/mermaid/${file}`);
      assert.equal(response.status, 200);
      assert.match(response.headers['content-type'], /text\/javascript/);
      assert.equal(crypto.createHash('sha256').update(response.bytes).digest('hex'), manifest.files[file].sha256);
      assert.ok(!response.headers['content-security-policy'].includes('unsafe-inline'));
      assert.ok(!response.headers['content-security-policy'].includes('unsafe-eval'));
    }
    for (const file of ['manifest.json', 'LICENSE', '..%2f..%2fdelivery-center-config.mjs']) {
      assert.notEqual((await get(`/forge-gateway/assets/mermaid/${file}`)).status, 200);
    }
    const views = await get('/forge-gateway/assets/delivery-center-views.js');
    assert.equal(views.status, 200);
    assert.match(views.headers['content-type'], /text\/javascript/);
    assert.equal(crypto.createHash('sha256').update(views.bytes).digest('hex'),
      crypto.createHash('sha256').update(await readFile(path.join(staticRoot, 'delivery-center-views.js'))).digest('hex'));
    assert.ok(!views.headers['content-security-policy'].includes('unsafe-inline'));
    assert.ok(!views.headers['content-security-policy'].includes('unsafe-eval'));
    assert.notEqual((await get('/forge-gateway/assets/delivery-center-semantics.mjs')).status, 200);
  } finally {
    gateway.destroyTrackedConnections();
    await new Promise(resolve => gateway.publicServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
