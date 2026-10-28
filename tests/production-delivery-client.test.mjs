import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProductionDeliveryClient } from '../docker/harness/production-delivery-client.mjs';

const prefix = '/forge-gateway/api/production/';
function transport(t, { timeout = false, status = 200, body = { ok: true } } = {}) {
  const calls = [];
  t.mock.method(http, 'request', (options, receive) => {
    const request = new EventEmitter(); const call = { options }; calls.push(call);
    request.setTimeout = (value, handler) => { call.timeout = value; call.onTimeout = handler; return request; };
    request.destroy = error => { call.destroyed = true; request.emit('error', error); };
    request.end = bytes => {
      call.body = bytes;
      queueMicrotask(() => {
        if (timeout) { call.onTimeout(); return; }
        const response = new EventEmitter(); response.statusCode = status;
        receive(response); response.emit('data', Buffer.from(JSON.stringify(body))); response.emit('end');
      });
    };
    return request;
  });
  return calls;
}

test('only the exact POST job stop route waits for the bounded worker; all other routes retain their timeout', async t => {
  const calls = transport(t);
  const client = createProductionDeliveryClient({ socketPath: path.resolve('production.sock') });
  const cases = [
    ['POST', 'jobs/job-123/stop', 3620000],
    ['POST', 'jobs/job-123/stop?project=project-a', 3620000],
    ['GET', 'jobs/job-123/stop', 20000],
    ['POST', 'jobs/job-123/stop-more', 20000],
    ['POST', 'jobs/job-123/stop/extra', 20000],
    ['POST', 'releases/job-123/stop', 20000],
    ['POST', 'jobs/job-123/acceptance', 20000],
    ['POST', 'exports', 20000],
    ['GET', 'capacity?project=project-a', 20000],
  ];
  for (const [method, route, expected] of cases) {
    await client.request({ method, path: prefix + route });
    assert.equal(calls.at(-1).timeout, expected, method + ' ' + route);
  }
  const configured = createProductionDeliveryClient({ socketPath: path.resolve('production.sock'), timeoutMs: 1250 });
  await configured.request({ path: prefix + 'releases?project=project-a' });
  assert.equal(calls.at(-1).timeout, 1250);
});

test('a real socket stop response can exceed the normal request timeout without retrying', async t => {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\forge-production-${randomUUID()}` : path.join(os.tmpdir(), `forge-production-${randomUUID()}.sock`);
  const calls = []; const timers = new Set();
  const server = http.createServer((request, response) => {
    calls.push({ method: request.method, path: request.url });
    const timer = setTimeout(() => { timers.delete(timer); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ item: { id: 'job-123', environment: { status: 'stopped' } } })); }, 100);
    timers.add(timer);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(async () => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const client = createProductionDeliveryClient({ socketPath, timeoutMs: 25 });
  const result = await client.request({ method: 'POST', path: prefix + 'jobs/job-123/stop', body: { project: 'project-a' } });
  assert.equal(result.item.environment.status, 'stopped');
  await assert.rejects(client.request({ method: 'GET', path: prefix + 'jobs/job-123/stop' }), { code: 'PRODUCTION_TIMEOUT', status: 503 });
  assert.deepEqual(calls, [{ method: 'POST', path: prefix + 'jobs/job-123/stop' }, { method: 'GET', path: prefix + 'jobs/job-123/stop' }]);
});

test('an exhausted stop deadline still rejects with the timeout error and never retries', async t => {
  const calls = transport(t, { timeout: true });
  const client = createProductionDeliveryClient({ socketPath: path.resolve('production.sock') });
  await assert.rejects(client.request({ method: 'POST', path: prefix + 'jobs/job-123/stop', body: { project: 'project-a' } }), { code: 'PRODUCTION_TIMEOUT', status: 503 });
  assert.equal(calls.length, 1); assert.equal(calls[0].destroyed, true);
});

test('stop worker rejection remains an error instead of becoming a successful stop', async t => {
  const calls = transport(t, { status: 409, body: { code: 'PRODUCTION_ENVIRONMENT_IN_USE', message: '验证执行期间不能停止验证环境。' } });
  const client = createProductionDeliveryClient({ socketPath: path.resolve('production.sock') });
  await assert.rejects(client.request({ method: 'POST', path: prefix + 'jobs/job-123/stop' }), { code: 'PRODUCTION_ENVIRONMENT_IN_USE', status: 409 });
  assert.equal(calls.length, 1);
});
