import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createVerificationRunnerServer, defaultProtectedAcceptanceIssuerClient } from '../docker/harness/verification-runner.mjs';
import { createTaskspaceBrokerServer, defaultVerificationClient, TaskspaceBroker } from '../docker/harness/taskspace-broker.mjs';

const execFileAsync = promisify(execFile);
const client = fileURLToPath(new URL('../docker/harness/forge-verify', import.meta.url));
const receiptId = '123e4567-e89b-12d3-a456-426614174000';
const secret = 'private-token-and-source-must-not-escape';
const socketName = (root, name) => process.platform === 'win32'
  ? `\\\\.\\pipe\\forge-feedback-${name}-${crypto.randomUUID()}` : path.join(root, `${name}.sock`);
async function listen(server, ...address) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(...address, resolve); });
}
function close(server) { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

test('CLI explains repository-relative module paths before contacting the Broker', async () => {
  await assert.rejects(execFileAsync(process.execPath, [client, 'run', '--profile', 'backend-module-test',
    '--module', 'forge-business/forge-business-core', '--admission-id', receiptId,
    '--idempotency-key', 'module-path-feedback'], {
    env: { ...process.env, FORGE_TASKSPACE_BROKER_URL: 'http://127.0.0.1:1',
      FORGE_TASKSPACE_TOKEN_FILE: path.join(os.tmpdir(), 'nonexistent-module-feedback-token') },
  }), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /repository-relative path starting with forge-server\//u);
    assert.match(error.stderr, /forge-server\/forge-business\/forge-business-core/u);
    assert.doesNotMatch(error.stderr, /ECONNREFUSED|ENOENT/u);
    return true;
  });
});

test('issuer rejection reaches the real Runner and Broker HTTP consumers and CLI without losing safe feedback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-feedback-chain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const issuerSocket = socketName(root, 'issuer');
  const runnerSocket = socketName(root, 'runner');
  const token = 'a'.repeat(48);
  const tokenFile = path.join(root, 'token');
  await writeFile(tokenFile, token);
  let scenario;
  let requests = 0;
  let statusResult;
  const issuer = http.createServer(async (request, response) => {
    for await (const _ of request) { /* read only the test request */ }
    requests += 1;
    if (scenario.transportFailure) { request.socket.destroy(); return; }
    response.writeHead(scenario.httpStatus, { 'content-type': 'application/json' });
    response.end(scenario.rawBody ?? JSON.stringify({ ok: false, error: {
      code: scenario.issuerCode, message: secret, retryable: true,
      recommendedAction: `delete authorization ${secret}`, detail: { secret }, stack: secret,
      ...scenario.error,
    } }));
  });
  await listen(issuer, issuerSocket);
  t.after(() => close(issuer));
  // Only business execution is a fixture. Both transport serializers, the
  // Broker verification client and the CLI process are the actual consumers.
  const runner = createVerificationRunnerServer({
    execute: () => statusResult ?? defaultProtectedAcceptanceIssuerClient(issuerSocket, '/v1/verification', {}),
  });
  await listen(runner, runnerSocket);
  t.after(() => close(runner));
  const broker = createTaskspaceBrokerServer({ broker: {
    executeAuthenticated: (presentedToken, body) => {
      assert.equal(presentedToken, token);
      return defaultVerificationClient(runnerSocket, body);
    },
  } });
  await listen(broker, 0, '127.0.0.1');
  t.after(() => close(broker));
  const env = { ...process.env, FORGE_TASKSPACE_TOKEN_FILE: tokenFile,
    FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${broker.address().port}` };
  for (const entry of [
    { issuerCode: 'ACCEPTANCE_RUNNER_RECEIPT_INVALID', httpStatus: 422 },
    { issuerCode: 'ACCEPTANCE_CANDIDATE_BINDING_MISMATCH', httpStatus: 409 },
    { issuerCode: 'ACCEPTANCE_CANDIDATE_CONTRACT_EXPIRED', httpStatus: 409 },
    { issuerCode: 'ACCEPTANCE_CANDIDATE_ADMISSION_STALE', httpStatus: 409 },
    { issuerCode: 'ACCEPTANCE_CANDIDATE_BINDING_FORBIDDEN', httpStatus: 403 },
    { issuerCode: 'ACCEPTANCE_SOURCE_MISMATCH', httpStatus: 409, expected: 'VERIFY_ACCEPTANCE_SOURCE_MISMATCH' },
    { issuerCode: 'ACCEPTANCE_STATE_INVALID', httpStatus: 503, error: { retryable: false } },
    { issuerCode: 'UNREVIEWED_INTERNAL_CODE', httpStatus: 503, expected: 'VERIFY_ACCEPTANCE_ISSUER_REJECTED' },
    { issuerCode: { secret }, httpStatus: 422, expected: 'VERIFY_ACCEPTANCE_ISSUER_REJECTED' },
    { httpStatus: 503, rawBody: `not JSON ${secret}`, expected: 'VERIFY_ACCEPTANCE_ISSUER_INVALID' },
    { transportFailure: true, expected: 'VERIFY_ACCEPTANCE_ISSUER_UNAVAILABLE', retryable: true },
  ]) {
    await t.test(entry.expected ?? entry.issuerCode, async () => {
      scenario = entry;
      requests = 0;
      await assert.rejects(execFileAsync(process.execPath, [client, 'receipt', '--receipt-id', receiptId], { env }), (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        const result = JSON.parse(error.stderr);
        assert.equal(result.ok, false);
        assert.deepEqual(Object.keys(result.error).sort(), ['code', 'message', 'recommendedAction', 'retryable']);
        assert.equal(result.error.code, entry.expected ?? entry.issuerCode);
        assert.equal(result.error.retryable, entry.retryable === true);
        assert.equal(typeof result.error.recommendedAction, 'string');
        assert.match(result.error.recommendedAction, /保留|复核|核对|权限/u);
        assert.doesNotMatch(error.stderr, new RegExp(`${secret}|delete authorization|发送“继续”`, 'u'));
        return true;
      });
      assert.equal(requests, entry.transportFailure ? 2 : 1, 'only the existing transport retry budget applies');
    });
  }
  statusResult = { active: false, status: 'failed', jobId: receiptId, receiptId,
    error: { code: 'ACCEPTANCE_RUNNER_RECEIPT_INVALID', message: 'Receipt rejected.', retryable: false,
      recommendedAction: 'Preserve the original receipt.' } };
  const observed = JSON.parse((await execFileAsync(process.execPath, [client, 'watch', '--job-id', receiptId], { env })).stdout);
  assert.deepEqual(observed.error, statusResult.error, 'terminal job errors already survive the success-result path');
  assert.equal(observed.status, 'failed');
  assert.equal(observed.nextAction, `forge-verify status --job-id ${receiptId}`);
});

test('issuer schema field reasons are bounded and preserved with a safe missing-message fallback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-feedback-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = socketName(root, 'schema');
  let scenario;
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _ of request) { /* consume the private test request */ }
    requests += 1;
    response.writeHead(422, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: {
      code: scenario.code ?? 'ACCEPTANCE_SCHEMA_INVALID', message: scenario.message,
      detail: { originalRequest: secret }, stack: secret, recommendedAction: secret,
    } }));
  });
  await listen(server, socketPath);
  t.after(() => close(server));
  const fallback = '受保护验收请求格式无效。';
  for (const entry of [
    { message: 'verification request.taskId is invalid.', reason: 'verification request.taskId is invalid.' },
    { message: '  verification\r\nrequest\t has unsupported or missing fields.  ',
      reason: 'verification request has unsupported or missing fields.' },
    {},
    { message: { privateState: secret } },
    { message: `${'field'.repeat(50)} is invalid.` },
    { message: `verification request is invalid.\n${secret}` },
    { message: `verification request=${secret} is invalid.` },
    { message: 'verification request./private/state is invalid.' },
    { code: 'ACCEPTANCE_STATE_INVALID', message: 'verification request.taskId is invalid.',
      fallback: '受保护验收状态未通过完整性校验。' },
  ]) {
    scenario = entry;
    await assert.rejects(defaultProtectedAcceptanceIssuerClient(socketPath, '/v1/verification', { privateInput: secret }), (error) => {
      assert.equal(error.code, entry.code ?? 'ACCEPTANCE_SCHEMA_INVALID');
      assert.equal(error.message, entry.reason ? `${fallback} 受保护验收字段原因：${entry.reason}` : entry.fallback ?? fallback);
      assert.equal(error.retryable, false);
      assert.match(error.recommendedAction, /保留/u);
      assert.doesNotMatch(`${error.message} ${error.recommendedAction}`, new RegExp(`${secret}|[\\r\\n]`, 'u'));
      assert.ok(Buffer.byteLength(error.message) < 700, 'the existing Host diagnostic limit preserves the entire reason');
      return true;
    });
  }
  assert.equal(requests, 9, 'schema feedback does not retry a permanent refusal');
});

test('protected projection clients distinguish permanent refusal from actual transport failure without exposing private state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-feedback-projection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = socketName(root, 'projection');
  let scenario;
  let requests;
  const server = http.createServer(async (request, response) => {
    for await (const _ of request) { /* consume request */ }
    requests += 1;
    if (scenario.transportFailure) { request.socket.destroy(); return; }
    response.writeHead(scenario.httpStatus, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: {
      code: scenario.code, message: secret, retryable: true, recommendedAction: secret, detail: { secret },
    } }));
  });
  await listen(server, socketPath);
  t.after(() => close(server));
  const broker = new TaskspaceBroker({ projectRoot: root, projectSlug: 'forge-base', protectedCompletionSocket: socketPath });
  for (const [name, call, fallback] of [
    ['completion', () => broker.protectedCompletionClient({ taskId: 'task-one' }), 'PROTECTED_COMPLETION_UNAVAILABLE'],
    ['candidate-binding', () => broker.protectedCandidateBindingClient({ taskId: 'task-one' }), 'CANDIDATE_BINDING_UNAVAILABLE'],
  ]) {
    for (const entry of [
      { code: 'ACCEPTANCE_CANDIDATE_BINDING_UNAVAILABLE', httpStatus: 409 },
      { code: 'ACCEPTANCE_RECORD_NOT_FOUND', httpStatus: 404 },
      { code: 'ACCEPTANCE_STATE_INVALID', httpStatus: 503 },
      { code: 'ACCEPTANCE_SCHEMA_INVALID', httpStatus: 422 },
      { code: 'UNKNOWN_PRIVATE_DENIAL', httpStatus: 403, expected: fallback },
      { code: 'UNKNOWN_PRIVATE_CONFLICT', httpStatus: 409, expected: fallback },
      { transportFailure: true, expected: fallback },
    ]) {
      await t.test(`${name}: ${entry.code ?? 'transport'}`, async () => {
        scenario = entry;
        requests = 0;
        await assert.rejects(call(), (error) => {
          assert.equal(error.code, entry.expected ?? entry.code);
          assert.equal(error.retryable, entry.transportFailure === true);
          assert.equal(typeof error.recommendedAction, 'string');
          assert.doesNotMatch(`${error.message} ${error.recommendedAction}`, new RegExp(secret, 'u'));
          return true;
        });
        assert.equal(requests, 1, 'projection feedback adds no retry loop');
      });
    }
  }
});
