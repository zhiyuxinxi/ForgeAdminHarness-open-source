import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUploadServer } from '../docker/harness/upload-server.mjs';
import { createHarnessProxy } from '../docker/harness/tcp-proxy.mjs';
import { createConversationOutputService, phaseFilesUrlForConversation } from '../docker/harness/conversation-output-service.mjs';
import { readCompletePinnedDshSession } from '../docker/harness/forge-recover-headless-execution.mjs';

const SESSION = 'session-archive-test';
const TOKEN = 'u'.repeat(64);
const ACCESS = 'a'.repeat(64);
const HOST = 'archive.example.test:20800';
const scope = { scopeType: 'taskspace-private', projectSlug: 'archive-test', taskspaceId: 'c-archive-test',
  actorId: 'owner-archive', conversationId: 'conversation-archive' };
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
function request(port, pathname, { method = 'GET', body, headers = {}, authenticated = true } = {}) {
  return new Promise((resolve, reject) => {
    const buffer = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: {
      host: HOST, ...(authenticated ? { cookie: `forge_harness_access=${ACCESS}` } : {}),
      ...(buffer ? { 'content-type': 'application/json', 'content-length': buffer.length } : {}), ...headers,
    } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes,
          json: () => JSON.parse(bytes.toString('utf8')), text: () => bytes.toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject); req.end(buffer);
  });
}
async function fixture({ maxProjectBytes = 1024 * 1024, privateScope = true, allowedSessionIds, phaseFilesContext } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-output-service-'));
  const fencePath = path.join(root, 'fence.json');
  await writeFile(fencePath, JSON.stringify({ schemaVersion: 1, state: 'committed', epoch: 'archive-test' }));
  const state = { updatedAt: 1, running: false, events: [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '保存本轮方案' }] } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已整理。\n```json\n{"menu":"安保"}\n```\n```html\n<script>neverExecute()</script>\n```' }] } } },
    { seq: 4, type: 'tool/call', data: { callId: 'call-one', name: 'Read', arguments: '{"password":"sensitive-value"}' } },
    { seq: 5, type: 'tool/result', data: { message: { source: { callId: 'call-one' }, content: [{ type: 'tool-result', isError: true,
      content: [{ type: 'text', text: `失败 token=${TOKEN}` }] }] } } },
    { seq: 6, type: 'turn/end', data: { reason: { kind: 'error', message: '真实失败仍保留' } } },
  ], historyCalls: 0 };
  const dsh = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let value;
    if (input.method === 'session.list') value = { items: [{ sessionId: SESSION, cwd: '/workspace', blank: false,
      updatedAt: state.updatedAt, running: state.running }] };
    else if (input.method === 'session.history') {
      state.historyCalls += 1;
      const eligible = state.events.filter((event) => input.payload.beforeSeq === undefined || event.seq < input.payload.beforeSeq);
      value = { events: eligible.slice(-2).map((event) => ({ event })), hasMore: eligible.length > 2 };
    } else throw new Error(`unexpected DSH method ${input.method}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', rpcId: input.rpcId, result: { ok: true, value } }));
  });
  const dshPort = await listen(dsh);
  const upload = await createUploadServer({ uploadRoot: path.join(root, 'uploads'), token: TOKEN, maxProjectBytes,
    auditScope: privateScope ? scope : { scopeType: 'project-intake', projectSlug: 'archive-test' } });
  const uploadPort = await listen(upload);
  const uploadTarget = { host: '127.0.0.1', port: uploadPort, token: TOKEN };
  const proxy = createHarnessProxy({ targetHost: '127.0.0.1', targetPort: dshPort, trustedAuthority: HOST,
    maintenanceFencePath: fencePath, ...(allowedSessionIds === undefined ? { accessToken: ACCESS } : {
      accessAuthorizer: { url: 'http://gateway.test/authorize', projectSlug: scope.projectSlug, taskspaceId: scope.taskspaceId,
        ...phaseFilesContext,
        fetchImpl: async () => ({ status: 204, headers: { get: (name) => name === 'x-forge-output-session-ids' ? JSON.stringify(allowedSessionIds) : null } }) },
    }), uploadTarget, outputArchiveIntervalMs: 600_000 });
  const proxyPort = await listen(proxy);
  const service = createConversationOutputService({ port: dshPort, uploadTarget });
  return { root, state, proxyPort, uploadPort, dshPort, service, async close() {
    service.stop();
    for (const server of [proxy, upload, dsh]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(root, { recursive: true, force: true });
  } };
}

test('authenticated proxy exports real paginated DSH inputs, replies and failures, then downloads exact safe bytes', async () => {
  const current = await fixture();
  try {
    const saved = await request(current.proxyPort, '/forge-output/snapshots', { method: 'POST', body: { sessionId: SESSION } });
    assert.equal(saved.status, 200, saved.text());
    const archive = saved.json().archive;
    assert.equal(archive.status, 'failed');
    assert.equal(archive.eventCount, 6);
    assert.equal(current.state.historyCalls, 3);
    assert.deepEqual(archive.scope, scope);
    const projectionRead = await request(current.proxyPort, `/forge-output/files/${SESSION}/${archive.snapshotId}/conversation.json`);
    assert.equal(projectionRead.json().entries.find((entry) => entry.seq === 2).role, 'user');
    const md = archive.files.find((file) => file.name === 'conversation.md');
    const url = `/forge-output/files/${SESSION}/${archive.snapshotId}/conversation.md?download=1`;
    const download = await request(current.proxyPort, url);
    assert.equal(download.status, 200);
    assert.equal(digest(download.bytes), md.sha256);
    assert.match(download.text(), /保存本轮方案/);
    assert.match(download.text(), /真实失败仍保留/);
    assert.doesNotMatch(download.text(), /sensitive-value|u{64}/);
    assert.match(download.headers['content-disposition'], /^attachment;/);
    const html = archive.files.find((file) => file.name.endsWith('.html'));
    const htmlRead = await request(current.proxyPort, `/forge-output/files/${SESSION}/${archive.snapshotId}/${html.name}`);
    assert.match(htmlRead.headers['content-type'], /^text\/plain/);
    assert.match(htmlRead.headers['content-security-policy'], /sandbox/);
    assert.equal(htmlRead.headers['x-content-type-options'], 'nosniff');
    const list = await request(current.proxyPort, `/forge-output/snapshots?sessionId=${SESSION}&offset=0&limit=20`);
    assert.equal(list.json().items.length, 1);
    assert.ok(list.json().items[0].files.some((file) => file.name === 'manifest.json'));
    assert.deepEqual(await readdir(path.join(current.root, 'uploads')), ['.forge-upload-staging', '.upload-audit.jsonl', 'outputs']);
  } finally { await current.close(); }
});

test('phase file entry uses the configured Gateway conversation, with no credentials or login parameters', async () => {
  const context = { loginUrl: 'https://gateway.example:13080/forge-gateway/login?returnTask=private#login',
    projectSlug: scope.projectSlug, conversationId: scope.conversationId };
  const expected = 'https://gateway.example:13080/forge-gateway/?project=archive-test&phaseFiles=conversation-archive';
  assert.equal(phaseFilesUrlForConversation(context), expected);
  for (const loginUrl of ['javascript:alert(1)', '/login', 'https://user:password@gateway.example/']) {
    assert.equal(phaseFilesUrlForConversation({ ...context, loginUrl }), undefined);
  }
  assert.equal(phaseFilesUrlForConversation({ ...context, conversationId: '../other' }), undefined);
  assert.equal(phaseFilesUrlForConversation(), undefined);
  const current = await fixture({ allowedSessionIds: [SESSION], phaseFilesContext: context });
  try {
    const list = await request(current.proxyPort, `/forge-output/snapshots?sessionId=${SESSION}`);
    assert.equal(list.status, 200, list.text());
    assert.equal(list.json().phaseFilesUrl, expected);
    assert.equal(current.state.historyCalls, 0, 'viewing the entry does not read or run the model');
  } finally { await current.close(); }
});

test('browser cannot forge snapshots through either public route or bypass authentication/origin', async () => {
  const current = await fixture();
  try {
    for (const pathname of ['/forge-output/snapshots', '/forge-upload/outputs']) {
      const result = await request(current.proxyPort, pathname, { method: 'POST', body: { sessionId: SESSION, entries: [{ text: 'fake' }] } });
      assert.ok([400, 404].includes(result.status));
    }
    const anonymous = await request(current.proxyPort, `/forge-output/snapshots?sessionId=${SESSION}`, { authenticated: false });
    assert.equal(anonymous.status, 403);
    const crossOrigin = await request(current.proxyPort, '/forge-output/snapshots', { method: 'POST', body: { sessionId: SESSION }, headers: { origin: 'http://outside.invalid' } });
    assert.equal(crossOrigin.status, 403);
    const direct = await request(current.uploadPort, '/outputs', { method: 'POST', body: {} });
    assert.equal(direct.status, 403);
    assert.equal(current.state.historyCalls, 0);
  } finally { await current.close(); }
});

test('idle automatic archiving reuses unchanged boundaries and keeps stopped/intermediate records', async () => {
  const current = await fixture();
  try {
    current.state.running = true;
    current.state.events = current.state.events.slice(0, 5);
    await current.service.captureIdleSessions();
    assert.equal(current.state.historyCalls, 0);
    const running = await current.service.save(SESSION);
    assert.equal(running.archive.status, 'running');
    current.state.running = false;
    current.state.updatedAt += 1;
    current.state.events.push({ seq: 6, type: 'turn/end', data: { reason: { kind: 'aborted' } } });
    await current.service.captureIdleSessions();
    const calls = current.state.historyCalls;
    await current.service.captureIdleSessions();
    assert.equal(current.state.historyCalls, calls);
    const list = await request(current.proxyPort, `/forge-output/snapshots?sessionId=${SESSION}`);
    assert.deepEqual(new Set(list.json().items.map((item) => item.status)), new Set(['running', 'stopped']));
    const original = await readFile(path.join(current.root, 'uploads', 'outputs', SESSION, running.archive.snapshotId, 'conversation.json'), 'utf8');
    assert.equal(JSON.parse(original).status, 'running');
  } finally { await current.close(); }
});

test('quota failure leaves no successful archive and project-shared intake cannot create personal outputs', async () => {
  const current = await fixture({ maxProjectBytes: 500 });
  try {
    const result = await request(current.proxyPort, '/forge-output/snapshots', { method: 'POST', body: { sessionId: SESSION } });
    assert.equal(result.status, 507);
    assert.equal(result.json().code, 'PROJECT_QUOTA_EXCEEDED');
    const list = await request(current.proxyPort, `/forge-output/snapshots?sessionId=${SESSION}`);
    assert.equal(list.json().items.length, 0);
    assert.equal(list.json().automatic.status, 'failed');
  } finally { await current.close(); }
  const shared = await fixture({ privateScope: false });
  try {
    const result = await request(shared.proxyPort, '/forge-output/snapshots', { method: 'POST', body: { sessionId: SESSION } });
    assert.equal(result.status, 503);
    assert.equal(shared.state.historyCalls, 0);
  } finally { await shared.close(); }
});

test('download refuses modified archive members and the acceptance reader still requires execution identity', async () => {
  const current = await fixture();
  try {
    await assert.rejects(readCompletePinnedDshSession({ port: current.dshPort, sessionId: SESSION, expectedCwd: '/workspace' }), { code: 'RECOVERY_INPUT_INVALID' });
    const saved = await current.service.save(SESSION);
    await writeFile(path.join(current.root, 'uploads', 'outputs', SESSION, saved.archive.snapshotId, 'conversation.md'), 'modified');
    const result = await request(current.proxyPort, `/forge-output/files/${SESSION}/${saved.archive.snapshotId}/conversation.md`);
    assert.equal(result.status, 409);
    assert.doesNotMatch(result.text(), /modified/);
    const unsafe = await request(current.proxyPort, `/forge-output/files/${SESSION}/${saved.archive.snapshotId}/%2e%2e%2fsecret.txt`);
    assert.equal(unsafe.status, 400);
  } finally { await current.close(); }
});

test('legacy output routes consume the server session allowlist, including deny-all, on every operation', async () => {
  for (const allowedSessionIds of [[], ['session-other-owner']]) {
    const current = await fixture({ allowedSessionIds });
    try {
      const saved = await current.service.save(SESSION);
      const historyCalls = current.state.historyCalls;
      const reads = [
        ['/forge-output/snapshots', { method: 'POST', body: { sessionId: SESSION } }],
        [`/forge-output/snapshots?sessionId=${SESSION}`, {}],
        [`/forge-output/files/${SESSION}/${saved.archive.snapshotId}/conversation.md`, {}],
      ];
      for (const [url, options] of reads) {
        const result = await request(current.proxyPort, url, { ...options, headers: { 'x-forge-output-session-ids': JSON.stringify([SESSION]) } });
        assert.equal(result.status, 403);
      }
      assert.equal(current.state.historyCalls, historyCalls);
    } finally { await current.close(); }
  }
  const owner = await fixture({ allowedSessionIds: [SESSION] });
  try {
    const result = await request(owner.proxyPort, '/forge-output/snapshots', { method: 'POST', body: { sessionId: SESSION } });
    assert.equal(result.status, 200);
  } finally { await owner.close(); }
});
