import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const { observeRelease } = createRequire(import.meta.url)('../docker/harness/forge-release');
const accepted = { operationId: '11111111-1111-4111-8111-111111111111', taskId: 'task-one', status: 'accepted' };
const success = { ...accepted, status: 'success', stage: 'complete', completedAt: '2026-10-12T10:00:00Z', commit: 'a'.repeat(40) };
const reply = operation => ({ statusCode: 200, responseBody: JSON.stringify({ ok: true, result: { release: { operation } } }) });

test('observer follows only the accepted task operation through progress to real success', async () => {
  const states = [{ ...accepted, status: 'running', stage: 'prepare' }, { ...accepted, status: 'running', stage: 'release' }, success];
  const requests = [], progress = [];
  const result = await observeRelease(accepted, async request => { requests.push(request); return reply(states.shift()); },
    { sleep: async () => {}, progress: value => progress.push(value) });
  assert.equal(result.ok, true);
  assert.equal(result.result.commit, success.commit);
  assert.equal(result.result.terminal, true);
  assert.equal(result.result.observerStatus, 'finished');
  assert.deepEqual(requests, Array(3).fill({ action: 'status', operationId: accepted.operationId }));
  assert.equal(progress.length, 3);
});

test('observer preserves failure and interruption and never treats unknown/foreign/incomplete status as success', async () => {
  for (const status of ['failed', 'interrupted']) {
    const result = await observeRelease(accepted, async () => reply({ ...accepted, status, errorCode: 'REAL_BUILD_ERROR' }));
    assert.equal(result.ok, false); assert.equal(result.result.terminal, true);
    assert.equal(result.result.errorCode, 'REAL_BUILD_ERROR');
  }
  for (const operation of [undefined, { ...success, taskId: 'other' }, { ...success, operationId: 'other' },
    { ...success, stage: 'build' }, { ...success, completedAt: null }, { ...accepted, status: 'unknown' }]) {
    const result = await observeRelease(accepted, async () => reply(operation));
    assert.equal(result.ok, false); assert.equal(result.result.terminal, false);
    assert.equal(result.result.operationId, accepted.operationId);
    assert.match(result.result.recommendedAction, /do not resubmit/u);
  }
});

test('timeout and transport failure keep the original ID without retrying or cancelling the release', async () => {
  let clock = 0, calls = 0;
  const result = await observeRelease(accepted, async request => {
    calls += 1; assert.equal(request.action, 'status'); return reply({ ...accepted, status: 'running' });
  }, { now: () => clock, sleep: async ms => { clock += ms; }, timeoutMs: 4, intervalMs: 2 });
  assert.equal(calls, 2); assert.equal(result.result.errorCode, 'RELEASE_OBSERVATION_TIMEOUT');
  const disconnected = await observeRelease(accepted, async () => { throw new Error('socket lost'); });
  assert.equal(disconnected.result.errorCode, 'RELEASE_OBSERVATION_DISCONNECTED');
  assert.equal(disconnected.result.operationId, accepted.operationId);
});

test('direct CLI submits one release, returns its terminal result, and retains old Broker compatibility', async t => {
  const root = await mkdtemp(join(tmpdir(), 'forge-release-observer-'));
  const token = join(root, 'token'); await writeFile(token, 'a'.repeat(64));
  const requests = []; let supported = true;
  const server = createServer(async (request, response) => {
    if (request.url === '/healthz') {
      requests.push('capability'); response.end(JSON.stringify({ capabilities: supported ? { releaseOperationTracking: 1 } : {} })); return;
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    response.end(body.action === 'status' ? reply(success).responseBody
      : JSON.stringify({ ok: true, result: supported ? accepted : success }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  for (const tracking of [true, false]) {
    supported = tracking; requests.length = 0;
    const child = spawn(process.execPath, [fileURLToPath(new URL('../docker/harness/forge-release', import.meta.url)), 'release', '--services', 'forge-ui'], {
      env: { ...process.env, FORGE_DEVELOPMENT_MODE: 'direct', FORGE_TASKSPACE_ID: '',
        FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}`, FORGE_TASKSPACE_TOKEN_FILE: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr); assert.equal(JSON.parse(stdout).result.status, 'success');
    assert.equal(requests.filter(value => value.action === 'release').length, 1);
    assert.equal(requests.length, tracking ? 3 : 2);
    if (tracking) assert.equal(JSON.parse(stdout).result.operationId, accepted.operationId);
  }
});
