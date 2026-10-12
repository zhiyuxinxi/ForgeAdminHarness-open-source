import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import {
  createCredentialProxyContract,
  createCredentialProxyMeter,
  createCredentialProxyReceipt,
  createCredentialProxyRequestHandler,
  createRequestBudget,
} from '../scripts/analyze-forge-harness-session.mjs';

class SyntheticResponse {
  constructor() {
    this.headersSent = false;
    this.destroyed = false;
    this.statusCode = undefined;
    this.headers = {};
    this.chunks = [];
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
    this.headersSent = true;
  }

  write(value) {
    this.chunks.push(Buffer.from(value));
  }

  end(value) {
    if (value !== undefined) this.write(value);
    this.resolveDone();
  }

  destroy() {
    this.destroyed = true;
    this.resolveDone();
  }

  get body() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function syntheticRequest(body, {
  method = 'POST',
  url = '/chat/completions',
  contentType = 'application/json',
  contentLength,
  extraHeaders = {},
} = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const request = Readable.from([bytes]);
  request.method = method;
  request.url = url;
  request.headers = {
    'content-type': contentType,
    'content-length': String(contentLength ?? bytes.length),
    ...extraHeaders,
  };
  return request;
}

function upstreamRecorder() {
  const calls = [];
  const request = (url, options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.destroyed = false;
    outgoing.destroy = (error) => {
      outgoing.destroyed = true;
      if (error) queueMicrotask(() => outgoing.emit('error', error));
      queueMicrotask(() => outgoing.emit('close'));
    };
    outgoing.end = (body) => {
      calls.push({ url, options, body: Buffer.from(body) });
      const upstreamResponse = Readable.from([Buffer.from('{"ok":true}\n')]);
      upstreamResponse.statusCode = 200;
      upstreamResponse.headers = { 'content-type': 'application/json', connection: 'close' };
      callback(upstreamResponse);
      queueMicrotask(() => outgoing.emit('close'));
    };
    return outgoing;
  };
  return { calls, request };
}

async function invoke(handler, body, options) {
  const response = new SyntheticResponse();
  handler(syntheticRequest(body, options), response);
  await response.done;
  return response;
}

function makeHarness({
  maxRequests = 8,
  maxOutputTokens = 100,
  maxRequestBytes = 1024,
  maxTotalRequestBytes = 4096,
} = {}) {
  const contract = createCredentialProxyContract({
    expectedModel: 'deepseek-chat',
    maxOutputTokens,
    maxRequestBytes,
    maxTotalRequestBytes,
  });
  const budget = createRequestBudget(maxRequests);
  const meter = createCredentialProxyMeter(contract);
  const upstream = upstreamRecorder();
  const handler = createCredentialProxyRequestHandler(
    'synthetic-local-key', budget, upstream.request, new Set(), meter,
  );
  return { contract, budget, meter, upstream, handler };
}

test('the proxy fixes upstream identity, injects or clamps max_tokens, and rewrites Content-Length', async () => {
  const harness = makeHarness();
  const injected = await invoke(harness.handler, JSON.stringify({
    model: 'deepseek-chat', messages: [{ role: 'user', content: 'synthetic-a' }],
  }), { extraHeaders: { authorization: 'Bearer placeholder', 'transfer-encoding': 'chunked' } });
  const clamped = await invoke(harness.handler, JSON.stringify({
    model: 'deepseek-chat', max_tokens: 999, messages: [{ role: 'user', content: 'synthetic-b' }],
  }));

  assert.equal(injected.statusCode, 200);
  assert.equal(clamped.statusCode, 200);
  assert.equal(harness.upstream.calls.length, 2);
  for (const call of harness.upstream.calls) {
    assert.equal(call.url.origin, 'https://api.deepseek.com');
    assert.equal(call.url.pathname, '/chat/completions');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers.authorization, 'Bearer synthetic-local-key');
    assert.equal(call.options.headers['transfer-encoding'], undefined);
    assert.equal(call.options.headers['content-length'], String(call.body.length));
    assert.equal(call.options.headers['content-type'], 'application/json');
    assert.equal(JSON.parse(call.body).model, 'deepseek-chat');
    assert.equal(JSON.parse(call.body).max_tokens, 100);
  }
  assert.deepEqual(harness.budget.snapshot(), {
    maxRequests: 8, acceptedRequests: 2, rejectedByLimit: 0,
  });
  assert.deepEqual(harness.meter.snapshot(), {
    contract: {
      expectedModel: 'deepseek-chat', maxOutputTokens: 100,
      maxRequestBytes: 1024, maxTotalRequestBytes: 4096,
    },
    forwardedRequests: 2,
    forwardedRequestBytes: harness.upstream.calls.reduce((sum, call) => sum + call.body.length, 0),
    injectedMaxOutputTokens: 1,
    clampedMaxOutputTokens: 1,
    upstreamCreationFailures: 0,
    rejectedRequests: {
      route: 0, contentType: 0, requestBytes: 0, totalRequestBytes: 0,
      malformedJson: 0, modelContract: 0, invalidMaxOutputTokens: 0, clientStream: 0,
    },
    contractRejectedRequests: 0,
    byteLimitRejectedRequests: 0,
  });
});

test('malformed bodies, wrong models, and invalid max_tokens fail before upstream creation', async () => {
  const cases = [
    ['malformed-json', '{not-json', 400, 'malformedJson'],
    ['array-body', '[]', 422, 'malformedJson'],
    ['missing-model', JSON.stringify({ messages: [] }), 422, 'modelContract'],
    ['wrong-model', JSON.stringify({ model: 'deepseek-reasoner', messages: [] }), 422, 'modelContract'],
    ['zero-max-tokens', JSON.stringify({ model: 'deepseek-chat', max_tokens: 0, messages: [] }), 422, 'invalidMaxOutputTokens'],
    ['fractional-max-tokens', JSON.stringify({ model: 'deepseek-chat', max_tokens: 1.5, messages: [] }), 422, 'invalidMaxOutputTokens'],
    ['string-max-tokens', JSON.stringify({ model: 'deepseek-chat', max_tokens: '10', messages: [] }), 422, 'invalidMaxOutputTokens'],
  ];

  for (const [name, body, statusCode, counter] of cases) {
    const harness = makeHarness();
    const response = await invoke(harness.handler, body);
    assert.equal(response.statusCode, statusCode, name);
    assert.equal(harness.upstream.calls.length, 0, name);
    assert.equal(harness.budget.snapshot().acceptedRequests, 0, name);
    assert.equal(harness.meter.snapshot().rejectedRequests[counter], 1, name);
  }
});

test('per-request, cumulative-byte, and request-count limits all gate before upstream', async () => {
  const rawWithoutLimit = JSON.stringify({ model: 'deepseek-chat', messages: [] });
  const rewrittenWithLimit = Buffer.from(JSON.stringify({
    model: 'deepseek-chat', messages: [], max_tokens: 5,
  }));

  const rewrittenOverflow = makeHarness({
    maxOutputTokens: 5,
    maxRequestBytes: Buffer.byteLength(rawWithoutLimit),
    maxTotalRequestBytes: 4096,
  });
  const rewrittenResponse = await invoke(rewrittenOverflow.handler, rawWithoutLimit);
  assert.equal(rewrittenResponse.statusCode, 413);
  assert.equal(rewrittenOverflow.upstream.calls.length, 0);
  assert.equal(rewrittenOverflow.budget.snapshot().acceptedRequests, 0);
  assert.equal(rewrittenOverflow.meter.snapshot().rejectedRequests.requestBytes, 1);

  const cumulative = makeHarness({
    maxOutputTokens: 5,
    maxRequestBytes: 1024,
    maxTotalRequestBytes: rewrittenWithLimit.length,
  });
  assert.equal((await invoke(cumulative.handler, rawWithoutLimit)).statusCode, 200);
  assert.equal((await invoke(cumulative.handler, rawWithoutLimit)).statusCode, 429);
  assert.equal(cumulative.upstream.calls.length, 1);
  assert.equal(cumulative.budget.snapshot().acceptedRequests, 1);
  assert.equal(cumulative.meter.snapshot().rejectedRequests.totalRequestBytes, 1);

  const requestCount = makeHarness({ maxRequests: 1 });
  assert.equal((await invoke(requestCount.handler, rawWithoutLimit)).statusCode, 200);
  assert.equal((await invoke(requestCount.handler, rawWithoutLimit)).statusCode, 429);
  assert.equal(requestCount.upstream.calls.length, 1);
  assert.deepEqual(requestCount.budget.snapshot(), {
    maxRequests: 1, acceptedRequests: 1, rejectedByLimit: 1,
  });

  const declaredOverflow = makeHarness({ maxRequestBytes: 64 });
  const declaredResponse = await invoke(declaredOverflow.handler, '{}', { contentLength: 65 });
  assert.equal(declaredResponse.statusCode, 413);
  assert.equal(declaredOverflow.upstream.calls.length, 0);
  assert.equal(declaredOverflow.meter.snapshot().rejectedRequests.requestBytes, 1);
});

test('contract validation and receipts expose only bounded metadata and counters', () => {
  for (const expectedModel of ['', ' deepseek-chat', 'deepseek chat', 'deepseek-chat\nunsafe']) {
    assert.throws(() => createCredentialProxyContract({
      expectedModel, maxOutputTokens: 1, maxRequestBytes: 1, maxTotalRequestBytes: 1,
    }), /expectedModel/);
  }
  for (const [property, value] of [
    ['maxOutputTokens', 0],
    ['maxOutputTokens', 65_537],
    ['maxRequestBytes', 0],
    ['maxRequestBytes', (64 * 1024 * 1024) + 1],
    ['maxTotalRequestBytes', 0],
    ['maxTotalRequestBytes', (64 * 1024 * 1024 * 128) + 1],
  ]) {
    assert.throws(() => createCredentialProxyContract({
      expectedModel: 'deepseek-chat', maxOutputTokens: 1,
      maxRequestBytes: 1, maxTotalRequestBytes: 1, [property]: value,
    }), /must be an integer/);
  }

  const harness = makeHarness();
  for (const event of ['ready', 'stopped']) {
    const receipt = createCredentialProxyReceipt(event, harness.budget, harness.meter);
    assert.equal(receipt.event, event);
    assert.equal(receipt.service, 'forge-credential-proxy');
    assert.equal(receipt.contract.expectedModel, 'deepseek-chat');
    assert.equal(receipt.forwardedRequests, 0);
    assert.equal(receipt.ready, event === 'ready' ? true : undefined);
    assert.equal(receipt.stopped, event === 'stopped' ? true : undefined);
    assert.equal(receipt.port, event === 'ready' ? 8080 : undefined);
    const serialized = JSON.stringify(receipt);
    assert.doesNotMatch(serialized, /synthetic-local-key/);
    assert.doesNotMatch(serialized, /messages|authorization|requestBody/i);
  }
  assert.throws(
    () => createCredentialProxyReceipt('request', harness.budget, harness.meter),
    /unsupported credential-proxy receipt event/,
  );
});
