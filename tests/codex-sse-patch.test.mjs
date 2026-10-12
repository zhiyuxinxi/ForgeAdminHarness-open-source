import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setImmediate as nextEventLoop } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyPatch, patchCodexSse } from '../docker/harness/forge-codex-sse-patch.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.FORGE_TEST_NATIVE_RUNTIME || resolve(repository, 'tmp/runtime-deps-ci');
const packagePath = resolve(runtime, 'node_modules/@earendil-works/pi-ai/package.json');
const packageBytes = await readFile(packagePath);
const pkg = JSON.parse(packageBytes);
assert.equal(pkg.name, '@earendil-works/pi-ai');
assert.equal(pkg.version, '0.82.1');
const providerPath = join(dirname(packagePath), 'dist/api/openai-codex-responses.js');
const sourceBytes = await readFile(providerPath);
const source = sourceBytes.toString('utf8');
const patched = patchCodexSse(source);
if (process.env.FORGE_TEST_NATIVE_RUNTIME) {
  assert.equal(patched, source, 'the installed provider must already contain the complete patch');
}

async function actualProvider(t) {
  const temporary = await mkdtemp(join(os.tmpdir(), 'forge-codex-sse-provider-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  // Only relocate relative imports. All provider function bodies and its actual dependencies execute unchanged.
  const relocated = patched.replace(/from "(\.\.?\/[^"\n]+)"/gu, (_match, relative) =>
    `from ${JSON.stringify(pathToFileURL(resolve(dirname(providerPath), relative)).href)}`);
  const modulePath = join(temporary, 'provider.mjs');
  await writeFile(modulePath, relocated);
  return (await import(pathToFileURL(modulePath))).stream;
}

test('pinned Codex SSE patch installs on a copy, is idempotent and rejects drift without touching the shared package', async t => {
  const temporary = await mkdtemp(join(os.tmpdir(), 'forge-codex-sse-install-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = join(temporary, '@earendil-works/pi-ai');
  const file = join(directory, 'dist/api/openai-codex-responses.js');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(join(directory, 'package.json'), packageBytes);
  await writeFile(file, sourceBytes);
  assert.deepEqual(applyPatch(temporary), { patch: 'forge-codex-sse-v1', changed: source !== patched });
  assert.equal(await readFile(file, 'utf8'), patched);
  assert.deepEqual(applyPatch(temporary), { patch: 'forge-codex-sse-v1', changed: false });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ ...pkg, version: 'unknown' }));
  assert.throws(() => applyPatch(temporary), /Unsupported Codex provider package/);
  assert.equal(await readFile(file, 'utf8'), patched);
  assert.throws(() => patchCodexSse('unknown source'), /Unsupported/);
  assert.throws(() => patchCodexSse(source + source), /Unsupported|Incomplete/);
  assert.throws(() => patchCodexSse(patched.replace('boundary.index + boundary[0].length', 'boundary.index + 2')), /Incomplete/);
  assert.deepEqual(await readFile(providerPath), sourceBytes);
});

const fakeJwt = ['e30', Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'local-no-model-fixture' },
})).toString('base64'), 'fixture-not-a-signature'].join('.');
const expectedText = '分块读取完成';

function deferred() {
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

async function fixture(delimiter, { omitTerminal = false, holdTerminal = false } = {}) {
  const headersConsumed = deferred();
  const finishBody = deferred();
  const connections = new Set();
  const requests = [];
  const failures = [];
  const frames = [
    { type: 'response.created', response: { id: 'resp_local_fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_fixture', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: expectedText },
  ];
  const terminal = { type: 'response.completed', response: { id: 'resp_local_fixture', status: 'completed', output: [] } };
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    request.resume();
    (async () => {
      await once(request, 'end');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.flushHeaders();
      await headersConsumed.promise;
      for (const event of frames) {
        const bytes = Buffer.from('data: ' + JSON.stringify(event) + delimiter + delimiter);
        const chinese = bytes.indexOf(Buffer.from(expectedText));
        // The two writes split a UTF-8 sequence or the final CRLF pair across HTTP chunks.
        const split = chinese >= 0 ? chinese + 1 : bytes.length - 1;
        response.write(bytes.subarray(0, split));
        await nextEventLoop();
        response.write(bytes.subarray(split));
        await nextEventLoop();
      }
      if (holdTerminal) await finishBody.promise;
      if (!omitTerminal) response.write('data: ' + JSON.stringify(terminal) + delimiter + delimiter);
      response.end();
    })().catch(error => { failures.push(error); response.destroy(error); });
  });
  server.on('connection', socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const model = {
    id: 'local-no-model-fixture', provider: 'openai-codex', api: 'openai-codex-responses',
    baseUrl, reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  return {
    requests,
    async consume(stream, { signal = AbortSignal.timeout(5000), onDelta } = {}) {
      const events = [];
      for await (const event of stream(model, { messages: [], systemPrompt: 'Local transport fixture.' }, {
        apiKey: fakeJwt, transport: 'sse', sessionId: 'local-fixed-transport-session', maxRetries: 0,
        signal, onResponse() { headersConsumed.resolve(); },
      })) {
        events.push(event);
        if (event.type === 'text_delta') onDelta?.(event);
      }
      assert.equal(failures.length, 0, failures[0]?.stack);
      return { events, terminal: events.at(-1) };
    },
    async closeIdlePeer() {
      assert.ok(connections.size > 0);
      const peers = [...connections];
      const closed = peers.map(socket => once(socket, 'close'));
      for (const socket of peers) socket.end();
      await Promise.all(closed);
    },
    async close() {
      headersConsumed.resolve();
      finishBody.resolve();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function assertCompleted(result) {
  assert.equal(result.terminal?.type, 'done', result.terminal?.error?.errorMessage);
  assert.equal(result.terminal.message.stopReason, 'stop');
  assert.equal(result.terminal.message.content.filter(value => value.type === 'text').map(value => value.text).join(''), expectedText);
}

test('actual Codex provider preserves chunked UTF8 and resumes after the peer closes an idle HTTP connection', { timeout: 10000 }, async t => {
  const stream = await actualProvider(t);
  const peer = await fixture('\n');
  t.after(() => peer.close());
  assertCompleted(await peer.consume(stream));
  await peer.closeIdlePeer();
  assertCompleted(await peer.consume(stream));
  assert.deepEqual(peer.requests, Array.from({ length: 2 }, () => ({ method: 'POST', url: '/codex/responses' })));
});

test('actual Codex provider accepts CRLF SSE boundaries split across HTTP chunks', { timeout: 10000 }, async t => {
  const stream = await actualProvider(t);
  const peer = await fixture('\r\n');
  t.after(() => peer.close());
  assertCompleted(await peer.consume(stream));
  assert.equal(peer.requests.length, 1);
});

test('actual Codex provider preserves abort while a chunked response awaits its terminal event', { timeout: 10000 }, async t => {
  const stream = await actualProvider(t);
  const peer = await fixture('\r\n', { holdTerminal: true });
  t.after(() => peer.close());
  const controller = new AbortController();
  const result = await peer.consume(stream, { signal: controller.signal, onDelta() { controller.abort(); } });
  assert.equal(result.terminal.type, 'error');
  assert.equal(result.terminal.reason, 'aborted');
  assert.equal(peer.requests.length, 1);
});

test('actual Codex provider rejects a CRLF stream that ends without the required terminal event', { timeout: 10000 }, async t => {
  const stream = await actualProvider(t);
  const peer = await fixture('\r\n', { omitTerminal: true });
  t.after(() => peer.close());
  const result = await peer.consume(stream);
  assert.equal(result.terminal.type, 'error');
  assert.equal(result.terminal.reason, 'error');
  assert.match(result.terminal.error.errorMessage, /stream ended before a terminal response event/u);
  assert.equal(peer.requests.length, 1);
});
