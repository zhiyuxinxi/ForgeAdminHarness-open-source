import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyPatch, patchDeepSeekProgressTimeout } from '../docker/harness/forge-deepseek-progress-timeout-patch.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.FORGE_TEST_NATIVE_RUNTIME || resolve(repository, 'tmp/runtime-deps-ci');
const directory = resolve(runtime, 'node_modules/@deepseek-ai/dsh-llm-deepseek');
const packageBytes = await readFile(join(directory, 'package.json'));
const pkg = JSON.parse(packageBytes);
assert.equal(pkg.name, '@deepseek-ai/dsh-llm-deepseek');
assert.equal(pkg.version, '0.1.1-rc.2');
const adapterPath = join(directory, 'lib/index.js');
const source = await readFile(adapterPath, 'utf8');
const patched = patchDeepSeekProgressTimeout(source);
if (process.env.FORGE_TEST_INSTALLED_DEEPSEEK_PROGRESS_PATCH === '1') {
  assert.equal(patched, source, 'the installed adapter must already contain the complete patch');
}

async function temporaryDirectory(t) {
  const temporary = await mkdtemp(join(os.tmpdir(), 'forge-deepseek-progress-'));
  t.after(async () => {
    assert.ok(resolve(temporary).startsWith(resolve(os.tmpdir()) + sep));
    assert.ok(basename(temporary).startsWith('forge-deepseek-progress-'));
    await rm(temporary, { recursive: true, force: true });
  });
  return temporary;
}

async function actualAdapterModule(t) {
  const temporary = await temporaryDirectory(t);
  // Run the actual patched adapter with its pinned native dependencies; do not rewrite any import or method.
  await symlink(resolve(runtime, 'node_modules'), join(temporary, 'node_modules'), 'junction');
  const file = join(temporary, 'adapter.mjs');
  await writeFile(file, patched);
  return import(pathToFileURL(file));
}

function deferred() {
  let fulfill;
  const promise = new Promise(resolve => { fulfill = resolve; });
  return { promise, resolve: fulfill };
}

async function peer(t, script) {
  const requests = [];
  const errors = [];
  const server = http.createServer(async (request, response) => {
    const closed = deferred();
    const timers = new Set();
    response.on('close', () => {
      for (const timer of timers) { clearInterval(timer); clearTimeout(timer); }
      closed.resolve();
    });
    try {
      const body = [];
      for await (const bytes of request) body.push(bytes);
      const record = { body: JSON.parse(Buffer.concat(body).toString()), closed: closed.promise };
      requests.push(record);
      const io = {
        headers() { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); },
        data(delta, finish_reason) { response.write(`data: ${JSON.stringify({ choices: [{ delta, ...(finish_reason ? { finish_reason } : {}) }] })}\n\n`); },
        raw(value) { response.write(value); },
        finish() { response.end('data: [DONE]\n\n'); },
        end() { response.end(); },
        after(ms, fn) { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
        every(ms, fn) { const timer = setInterval(fn, ms); timers.add(timer); return timer; },
        response,
      };
      script(io);
    } catch (error) { errors.push(error); response.destroy(error); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.equal(errors.length, 0, errors[0]?.stack);
  });
  return { requests, baseURL: `http://127.0.0.1:${server.address().port}` };
}

function adapterFor(module, fixture, progressMs = 180, idleMs = 1000) {
  return new module.DeepSeekAdapter({
    options: () => module.resolveAdapterOptions({ baseURL: fixture.baseURL, streamProgressTimeoutMs: progressMs, streamIdleTimeoutMs: idleMs }),
    resolveApiKey: async () => 'fixture-not-a-secret',
    resolveUserId: () => 'local-progress-timeout',
    resolveFiles: () => ({}),
  });
}

function options(signal = AbortSignal.timeout(2500)) {
  return { provider: 'deepseek-official', model: 'deepseek-v4-flash', signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Local transport fixture.' }] }] };
}

async function collect(adapter, { signal, onChunk } = {}) {
  const chunks = [];
  let failure;
  try {
    for await (const chunk of adapter.stream(options(signal))) { chunks.push(chunk); await onChunk?.(chunk); }
  } catch (error) { failure = error; }
  return { chunks, failure };
}

async function assertNoProgress(adapter, fixture) {
  const result = await collect(adapter);
  assert.equal(result.failure?.code, 'DEEPSEEK_NO_PROGRESS', result.failure?.stack);
  assert.match(result.failure.message, /未返回有效内容.*原会话和已完成的工具结果保留/u);
  assert.equal(fixture.requests.length, 1, 'the adapter itself does not retry a request or tool');
  await Promise.race([fixture.requests[0].closed, delay(800).then(() => { throw new Error('timed-out HTTP body was not cancelled'); })]);
  return result;
}

test('pinned DeepSeek patch installs idempotently and rejects package, anchor and partial-patch drift', async t => {
  const temporary = await temporaryDirectory(t);
  const target = join(temporary, '@deepseek-ai/dsh-llm-deepseek');
  const file = join(target, 'lib/index.js');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(join(target, 'package.json'), packageBytes);
  await writeFile(file, source);
  assert.deepEqual(applyPatch(temporary), { patch: 'forge-deepseek-progress-timeout-v1', changed: source !== patched });
  assert.equal(await readFile(file, 'utf8'), patched);
  assert.equal(applyPatch(temporary).changed, false);
  await writeFile(join(target, 'package.json'), JSON.stringify({ ...pkg, version: 'unknown' }));
  assert.throws(() => applyPatch(temporary), /Unsupported DeepSeek adapter package/);
  assert.equal(await readFile(file, 'utf8'), patched);
  assert.throws(() => patchDeepSeekProgressTimeout('unknown source'), /Unsupported/);
  assert.throws(() => patchDeepSeekProgressTimeout(source + source), /Unsupported|Incomplete/);
  assert.throws(() => patchDeepSeekProgressTimeout(patched.replace('generation progress excludes SSE heartbeats', 'changed marker text')), /Incomplete/);
  assert.equal(await readFile(adapterPath, 'utf8'), source, 'the shared runtime was not modified');
});

test('DeepSeek progress timeout defaults to 120 seconds and remains a validated separate setting', async t => {
  const module = await actualAdapterModule(t);
  assert.equal(module.resolveAdapterOptions({}).streamProgressTimeoutMs, 120000);
  assert.equal(module.resolveAdapterOptions({}).streamIdleTimeoutMs, 300000);
  assert.equal(module.resolveAdapterOptions({ streamProgressTimeoutMs: 321 }).streamProgressTimeoutMs, 321);
  for (const value of [0, -1, NaN, Infinity, 2147483648]) assert.throws(() => module.resolveAdapterOptions({ streamProgressTimeoutMs: value }), /streamProgressTimeoutMs/);
});

test('actual DeepSeek adapter bounds heartbeat-only generation and cancels its HTTP body', { timeout: 5000 }, async t => {
  const module = await actualAdapterModule(t);
  const fixture = await peer(t, io => { io.headers(); io.every(25, () => io.raw(': keepalive\n\n')); });
  await assertNoProgress(adapterFor(module, fixture), fixture);
});

test('actual DeepSeek adapter bounds silent headers and silent response body', { timeout: 7000 }, async t => {
  const module = await actualAdapterModule(t);
  for (const headers of [false, true]) await t.test(headers ? 'silent body' : 'no HTTP response headers', async sub => {
    const fixture = await peer(sub, io => { if (headers) io.headers(); });
    await assertNoProgress(adapterFor(module, fixture), fixture);
  });
});

test('empty reasoning, metadata and empty tool arguments cannot replenish the progress budget', { timeout: 5000 }, async t => {
  const module = await actualAdapterModule(t);
  const fixture = await peer(t, io => {
    io.headers();
    io.every(25, () => io.data({ role: 'assistant', content: '', reasoning_content: '', tool_calls: [{ index: 0, id: 'empty-tool', function: { name: 'fixture', arguments: '' } }] }));
  });
  const result = await assertNoProgress(adapterFor(module, fixture), fixture);
  assert.ok(result.chunks.some(chunk => chunk.type === 'tool-call-delta'), 'empty chunks must be consumed without resetting the budget');
});

test('sustained text, reasoning and tool-argument output each survive beyond the idle interval', { timeout: 10000 }, async t => {
  const module = await actualAdapterModule(t);
  for (const kind of ['text', 'reasoning', 'tool']) await t.test(kind, async sub => {
    const fixture = await peer(sub, io => {
      io.headers();
      for (let index = 0; index < 10; index++) io.after(40 + index * 60, () => {
        io.data(kind === 'text' ? { content: '字' } : kind === 'reasoning' ? { reasoning_content: '思' } :
          { tool_calls: [{ index: 0, id: 'continued-tool', function: { name: 'fixture', arguments: index === 0 ? '{"text":"' : index === 9 ? '"}' : 'a' } }] });
      });
      io.after(620, () => { io.data({}, kind === 'tool' ? 'tool_calls' : 'stop'); io.finish(); });
    });
    const result = await collect(adapterFor(module, fixture, 250));
    assert.equal(result.failure, undefined, result.failure?.stack);
    assert.equal(result.chunks.at(-1)?.type, 'finish');
    assert.equal(result.chunks.at(-1)?.reason.kind, kind === 'tool' ? 'tool-calls' : 'stop');
    assert.equal(result.chunks.filter(chunk => chunk.type === (kind === 'tool' ? 'tool-call-delta' : `${kind}-delta`)).length, 10);
    assert.equal(fixture.requests.length, 1);
  });
});

test('consumer processing time is excluded and iterator return aborts a held HTTP response', { timeout: 5000 }, async t => {
  const module = await actualAdapterModule(t);
  const fixture = await peer(t, io => {
    io.headers(); io.data({ content: '已到达' });
    io.after(30, () => { io.data({ content: '仍有效' }); io.finish(); });
  });
  let paused = false;
  const result = await collect(adapterFor(module, fixture, 100), { onChunk: async chunk => {
    if (!paused && chunk.type === 'text-delta') { paused = true; await delay(250); }
  } });
  assert.equal(result.failure, undefined, result.failure?.stack);
  assert.equal(result.chunks.at(-1)?.reason.kind, 'stop');

  const held = await peer(t, io => { io.headers(); io.data({ content: '提前停止' }); io.every(25, () => io.raw(': keepalive\n\n')); });
  for await (const chunk of adapterFor(module, held).stream(options())) if (chunk.type === 'text-delta') break;
  await Promise.race([held.requests[0].closed, delay(800).then(() => { throw new Error('iterator return did not close HTTP body'); })]);
});

test('caller cancellation stays ABORTED and disposes pending body reads', { timeout: 5000 }, async t => {
  const module = await actualAdapterModule(t);
  const controller = new AbortController();
  const fixture = await peer(t, io => {
    io.headers(); io.every(20, () => io.raw(': keepalive\n\n')); io.after(60, () => controller.abort('caller cancelled'));
  });
  const result = await collect(adapterFor(module, fixture, 400), { signal: controller.signal });
  assert.equal(result.failure?.code, 'ABORTED');
  await fixture.requests[0].closed;
});

test('completion, malformed SSE, missing DONE and HTTP errors retain native classifications', { timeout: 8000 }, async t => {
  const module = await actualAdapterModule(t);
  const cases = [
    ['completion', io => { io.headers(); io.data({ content: '完成' }, 'stop'); io.finish(); }, undefined],
    ['malformed', io => { io.headers(); io.raw('data: {invalid\n\n'); }, 'MALFORMED_RESPONSE'],
    ['missing DONE', io => { io.headers(); io.data({ content: '中断' }); io.end(); }, 'STREAM_CLOSED'],
    ['HTTP 503', io => { io.response.writeHead(503); io.response.end('{"error":{"message":"fixture unavailable"}}'); }, 'SERVER'],
  ];
  for (const [name, script, code] of cases) await t.test(name, async sub => {
    const fixture = await peer(sub, script);
    const result = await collect(adapterFor(module, fixture));
    assert.equal(result.failure?.code, code, result.failure?.stack);
    if (!code) assert.equal(result.chunks.at(-1)?.reason.kind, 'stop');
    assert.equal(fixture.requests.length, 1);
  });
});

test('adapter wrapper preserves upload activity and starts the content budget only for chat generation', { timeout: 5000 }, async t => {
  const module = await actualAdapterModule(t);
  const adapter = adapterFor(module, { baseURL: 'http://unused.local' }, 70, 150);
  let disposed = false;
  // Model the existing attachment-preparation callback seam; no image store or remote upload is changed.
  adapter.request = async function* (_options, signal, _connection, _key, _user, _attachments, onActivity) {
    try {
      onActivity('preparation');
      for (let index = 0; index < 4; index++) { await delay(50, undefined, { signal }); onActivity(); }
      onActivity('generation');
      await delay(20, undefined, { signal });
      yield { type: 'text-delta', index: 0, text: '准备完成' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } finally { disposed = true; }
  };
  const result = await collect(adapter);
  assert.equal(result.failure, undefined, result.failure?.stack);
  assert.equal(result.chunks.at(-1)?.reason.kind, 'stop');
  assert.equal(disposed, true);
});
