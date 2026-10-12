import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  validateVerificationContract,
  validateVerifyAction,
  verificationCommand,
  resolveFrontendTestFilters,
  frontendTestScopeFilters,
  VERIFY_PROFILE_NAMES,
} from '../docker/harness/verify-policy.mjs';
import {
  createVerificationRunnerServer,
  createVerificationSourceObserverServer,
  defaultProtectedAcceptanceIssuerClient,
  isTestProfile,
  inventoryWorkspace,
  VerificationRunner,
  verifyCachePack,
} from '../docker/harness/verification-runner.mjs';
import { readCacheCompatibilityImplementation } from '../docker/harness/verification-cache-tool.mjs';

test('source observer projects activity only for the requested task after observation', async t => {
  const activeByTask = new Map([['task-other', { jobId: 'other-job' }]]);
  let activateDuringObservation = false;
  const runner = { projectSlug: 'validation-project', activeByTask,
    source: async taskId => {
      if (activateDuringObservation) activeByTask.set(taskId, { jobId: 'current-job' });
      return { inventory: { head: 'a'.repeat(40), workspaceFingerprint: 'b'.repeat(64) } };
    } };
  const server = createVerificationSourceObserverServer(runner);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const observe = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/source`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'task-current' }) });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  };
  const idle = await observe(); assert.deepEqual(idle.taskActivity, { active: false });
  activateDuringObservation = true;
  const active = await observe(); assert.deepEqual(active.taskActivity, { active: true });
  assert.deepEqual(active.source, idle.source);
  assert.equal(active.taskId, 'task-current');
  activateDuringObservation = false; activeByTask.delete('task-current');
  assert.deepEqual((await observe()).taskActivity, { active: false });
  assert.equal(activeByTask.has('task-other'), true);
});
import {
  MAVEN_VERIFICATION_ARGS,
  MAVEN_VERIFICATION_ENV_ARG,
  MAVEN_VERIFICATION_EXEC_PATH,
  readMavenVerificationPolicy,
} from '../docker/harness/maven-verification-policy.mjs';

const execFileAsync = promisify(execFile);
const forgeVerifyClient = fileURLToPath(new URL('../docker/harness/forge-verify', import.meta.url));
const verificationCacheTool = fileURLToPath(new URL('../docker/harness/verification-cache-tool.mjs', import.meta.url));
const IMAGE = `forge-delivery/deepseek-harness@sha256:${'a'.repeat(64)}`;
const NODE_BASE_IMAGE = `node:24-bookworm-slim@sha256:${'b'.repeat(64)}`;
const MAVEN_BASE_IMAGE = `maven:3.9.16-eclipse-temurin-17@sha256:${'c'.repeat(64)}`;

const LINT_FORMAT_ARGS = [
  '--rule', 'style/quotes: off',
  '--rule', 'style/arrow-parens: off',
  '--rule', 'style/max-statements-per-line: off',
  '--rule', 'vue/singleline-html-element-content-newline: off',
  '--rule', 'vue/component-name-in-template-casing: off',
  '--rule', 'vue/html-self-closing: off',
  '--rule', 'perfectionist/sort-imports: off',
  '--rule', 'format/prettier: off',
  '--rule', 'unocss/order-attributify: off',
  '--rule', 'antfu/if-newline: off',
  '--rule', 'antfu/consistent-list-newline: off',
  '--rule', 'antfu/curly: off',
];

test('acceptance issuer client exposes a bounded current-authority action without issuer details', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-issuer-error-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\forge-issuer-error-${crypto.randomUUID()}`
    : path.join(root, 'issuer.sock');
  const sentinel = 'secret-token-must-not-escape';
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the request body */ }
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: false,
      error: { code: 'ACCEPTANCE_CANDIDATE_BINDING_MISMATCH', message: `private issuer detail: ${sentinel}` },
    }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  await assert.rejects(
    defaultProtectedAcceptanceIssuerClient(socketPath, '/v1/candidate-bindings', {}, { attempts: 1 }),
    (error) => {
      assert.equal(error.code, 'ACCEPTANCE_CANDIDATE_BINDING_MISMATCH');
      assert.equal(error.retryable, false);
      assert.match(error.message, /候选.*授权不匹配/u);
      assert.match(error.recommendedAction, /已有续接路径/u);
      assert.doesNotMatch(`${error.message}\n${error.recommendedAction ?? ''}`, new RegExp(sentinel, 'u'));
      return true;
    },
  );
});

test('standalone review CLI sends only the current contract and cannot supply a verdict or start a release', async (t) => {
  const help = (await execFileAsync(process.execPath, [forgeVerifyClient, '--help'])).stdout;
  assert.match(help, /review requests independent semantic review required by the current contract/u);
  assert.match(help, /Use run --reuse-receipt for receipt revalidation, with the original profile\/selectors and current admission/u);
  assert.match(help, /Backend receipt reuse across frontend changes does not make an old governance or frontend receipt current/u);
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-review-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = path.join(root, 'token'); await writeFile(token, 'a'.repeat(48));
  const requests = [];
  const rejection = { code: 'VERIFY_REVIEW_NOT_READY', message: '独立语义审查前提未满足（REVIEW_SCOPE_UNSUPPORTED）；此次 review 不是已有测试回执复核。',
    retryable: false, recommendedAction: 'Use forge-verify run --reuse-receipt with the original profile/selectors and current admission; invalidated governance checks still need current scoped verification.' };
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(409, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: rejection }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, FORGE_TASKSPACE_TOKEN_FILE: token, FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}` };
  const id = '1'.repeat(64);
  await assert.rejects(execFileAsync(process.execPath, [forgeVerifyClient, 'review', '--contract-id', id], { env }), error => {
    assert.deepEqual(JSON.parse(error.stderr), { ok: false, error: rejection }); return true;
  });
  assert.deepEqual(requests, [{ action: 'verify-review', acceptanceContractId: id }]);
  for (const args of [[], ['--contract-id', 'bad'], ['--contract-id', id, '--profile', 'governance'],
    ['--contract-id', id, '--contract-id', id], ['--contract-id', id, '--reviewer-id', 'self'],
    ['--contract-id', id, '--decision', 'approved']]) {
    await assert.rejects(execFileAsync(process.execPath, [forgeVerifyClient, 'review', ...args], { env }));
  }
  assert.equal(requests.length, 1, 'Invalid review input never reaches the broker');
});

test('forge-verify transmits diagnostics and exact full or selected frontend request shapes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-diagnostics-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = path.join(root, 'token');
  await writeFile(token, 'a'.repeat(48));
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result: { logs: { excerpt: 'failed assertion' } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, FORGE_TASKSPACE_TOKEN_FILE: token, FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}` };
  const receiptId = '123e4567-e89b-12d3-a456-426614174000';
  for (const args of [
    ['run', '--profile', 'frontend-admin-lint', '--admission-id', receiptId, '--idempotency-key', 'lint-full-cli-1'],
    ['run', '--profile', 'frontend-admin-lint', '--file', 'forge-admin-ui/src/views/example/index.vue', '--file', 'forge-admin-ui/src/api/example.ts', '--admission-id', receiptId, '--idempotency-key', 'lint-selected-cli-1'],
    ['run', '--profile', 'frontend-admin-test', '--admission-id', receiptId, '--idempotency-key', 'test-full-cli-1'],
    ['run', '--profile', 'frontend-admin-test', '--test-file', 'forge-admin-ui/src/views/example/Example.spec.ts', '--test-file', 'forge-admin-ui/tests/example.test.ts', '--admission-id', receiptId, '--idempotency-key', 'test-selected-cli-1'],
    ['receipt', '--receipt-id', receiptId],
    ['run', '--profile', 'frontend-admin-build', '--admission-id', receiptId, '--idempotency-key', 'reuse-build-cli-1', '--reuse-receipt', receiptId],
  ]) {
    const output = await execFileAsync(process.execPath, [forgeVerifyClient, ...args], { env });
    assert.equal(JSON.parse(output.stdout).logs.excerpt, 'failed assertion');
    assert.equal(requests.at(-1).includeDiagnostics, true);
  }
  assert.deepEqual(requests.slice(0, 4).map((request) => request.selectors), [
    {},
    { files: ['forge-admin-ui/src/views/example/index.vue', 'forge-admin-ui/src/api/example.ts'] },
    {},
    { testFiles: ['forge-admin-ui/src/views/example/Example.spec.ts', 'forge-admin-ui/tests/example.test.ts'] },
  ]);
  assert.equal(requests.at(-1).action, 'verify-run');
  assert.equal(requests.at(-1).receiptId, receiptId);
  assert.equal(Object.hasOwn(requests[0], 'receiptId'), false);
  for (const value of requests) {
    const validated = validateVerifyAction({ ...value, action: value.action.slice('verify-'.length) });
    assert.equal(validated.includeDiagnostics, true);
    const { includeDiagnostics, ...legacy } = value;
    assert.equal(Object.hasOwn(validateVerifyAction({ ...legacy, action: legacy.action.slice('verify-'.length) }), 'includeDiagnostics'), false);
    assert.throws(() => validateVerifyAction({ ...value, action: value.action.slice('verify-'.length), includeDiagnostics: false }), /includeDiagnostics/u);
  }
  assert.throws(() => validateVerifyAction({ action: 'status', jobId: receiptId, includeDiagnostics: true }), /unsupported field/u);
  await execFileAsync(process.execPath, [forgeVerifyClient, 'run', '--profile', 'full-regression',
    '--admission-id', receiptId, '--idempotency-key', 'background-cli-one', '--execution-mode', 'background'], { env });
  assert.deepEqual(requests.at(-1), { action: 'verify-run', profile: 'full-regression', selectors: {},
    admissionId: receiptId, idempotencyKey: 'background-cli-one', executionMode: 'background', includeDiagnostics: true });
  await execFileAsync(process.execPath, [forgeVerifyClient, 'run', '--profile', 'frontend-admin-test',
    '--test-file', 'forge-admin-ui/src/views/example/Example.spec.ts', '--admission-id', receiptId,
    '--idempotency-key', 'background-test-cli-one', '--execution-mode', 'background'], { env });
  assert.deepEqual(requests.at(-1), { action: 'verify-run', profile: 'frontend-admin-test',
    selectors: { testFiles: ['forge-admin-ui/src/views/example/Example.spec.ts'] }, admissionId: receiptId,
    idempotencyKey: 'background-test-cli-one', executionMode: 'background', includeDiagnostics: true });
  assert.throws(() => validateVerifyAction({ ...requests.at(-1), action: 'run', receiptId }), /without receipt reuse/u);
  for (const profile of ['backend-module-compile', 'backend-module-test', 'backend-test-class']) {
    const exact = profile === 'backend-test-class';
    await execFileAsync(process.execPath, [forgeVerifyClient, 'run', '--profile', profile,
      '--module', 'forge-server/example', ...(exact ? ['--test', 'ExampleTest#behavior'] : []),
      '--admission-id', receiptId, '--idempotency-key', `background-${profile}`], { env });
    const submitted = requests.at(-1);
    assert.equal(submitted.executionMode, 'background');
    assert.deepEqual(submitted.selectors, { modules: ['forge-server/example'],
      ...(exact ? { tests: ['ExampleTest#behavior'] } : {}) });
    assert.equal(validateVerifyAction({ ...submitted, action: 'run' }).profile, profile);
  }
  const beforeInvalid = requests.length;
  await assert.rejects(execFileAsync(process.execPath, [forgeVerifyClient, 'run', '--profile', 'backend-module-test',
    '--module', 'forge-server/example', '--test', 'ExampleTest', '--admission-id', receiptId,
    '--idempotency-key', 'invalid-module-selector'], { env }), /use backend-test-class/u);
  assert.equal(requests.length, beforeInvalid, 'an invalid selector never starts execution');
  await execFileAsync(process.execPath, [forgeVerifyClient, 'status', '--job-id', receiptId, '--wait-seconds', '60'], { env });
  assert.deepEqual(requests.at(-1), { action: 'verify-status', jobId: receiptId, waitSeconds: 60 });
  for (const waitSeconds of [0, 61, 1.5, '60']) {
    assert.throws(() => validateVerifyAction({ action: 'status', jobId: receiptId, waitSeconds }), /waitSeconds/u);
  }
});

test('forge-verify reuses the original frontend receipt selectors when none are supplied', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-reuse-selectors-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = path.join(root, 'token');
  await writeFile(token, 'a'.repeat(48));
  const receiptId = '123e4567-e89b-12d3-a456-426614174000';
  const requests = [];
  let original;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result: body.action === 'verify-receipt' ? original : body }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, FORGE_TASKSPACE_TOKEN_FILE: token,
    FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}` };
  const run = (profile, extra = []) => execFileAsync(process.execPath, [forgeVerifyClient,
    'run', '--profile', profile, '--admission-id', receiptId, '--idempotency-key', 'reuse-selected-cli',
    '--reuse-receipt', receiptId, ...extra], { env });
  for (const [profile, selectors] of [
    ['frontend-admin-test', { testFiles: ['forge-admin-ui/src/utils/__tests__/boolean-label.spec.js'] }],
    ['frontend-admin-lint', { files: ['forge-admin-ui/src/utils/boolean-label.js'] }],
    ['frontend-admin-test', {}],
  ]) {
    original = { receiptId, status: 'passed', request: { profile, selectors } };
    requests.length = 0;
    const result = JSON.parse((await run(profile)).stdout);
    assert.deepEqual(requests.map((request) => request.action), ['verify-receipt', 'verify-run']);
    assert.deepEqual(result.selectors, selectors);
    assert.equal(result.receiptId, receiptId);
    assert.equal(result.executionMode, undefined, 'receipt reuse never becomes a new background test');
  }
  requests.length = 0;
  const explicit = JSON.parse((await run('frontend-admin-test', ['--test-file', 'forge-admin-ui/src/other.spec.js'])).stdout);
  assert.deepEqual(requests.map((request) => request.action), ['verify-run']);
  assert.deepEqual(explicit.selectors, { testFiles: ['forge-admin-ui/src/other.spec.js'] },
    'explicit selectors reach the Host unchanged for its canonical comparison');
  for (const invalid of [
    { receiptId: '123e4567-e89b-12d3-a456-426614174001', status: 'passed', request: { profile: 'frontend-admin-test', selectors: {} } },
    { receiptId, status: 'passed', request: { profile: 'frontend-admin-lint', selectors: {} } },
    { receiptId, status: 'failed', request: { profile: 'frontend-admin-test', selectors: {} } },
    { receiptId, status: 'passed', request: { profile: 'frontend-admin-test', selectors: { testFiles: ['../outside.spec.js'] } } },
  ]) {
    original = invalid;
    requests.length = 0;
    await assert.rejects(run('frontend-admin-test'));
    assert.deepEqual(requests.map((request) => request.action), ['verify-receipt'], 'invalid lookup never starts a run');
  }
});

test('forge-verify keeps initial failure details visible through native result pruning', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-pruned-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = path.join(root, 'token');
  await writeFile(token, 'a'.repeat(48));
  const receiptId = '123e4567-e89b-12d3-a456-426614174000';
  const errors = [56, 67, 72, 77].map((line) => `[ERROR] [JOB_WORKSPACE]/SecurityDefenseController.java:[${line},24] annotation values must be of the form 'name=value'`).join('\n');
  let receipt = { receiptType: 'forge-verify/host-run', receiptId, status: 'failed',
    toolchain: { retainedMetadata: 'metadata '.repeat(700) },
    logs: { path: '/retained/original.log', sha256: 'a'.repeat(64),
      excerpt: `===== FORGE HOST FAILURE DIAGNOSTICS (UNTRUSTED) =====\n${'retained head/tail\n'.repeat(300)}\nMaven initial compiler errors:\n${errors}\n${'later cascading errors\n'.repeat(300)}===== END FORGE HOST FAILURE DIAGNOSTICS (UNTRUSTED) =====` },
    truth: { executionProven: true, verificationProven: false }, freshness: 'stale' };
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result: receipt }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, FORGE_TASKSPACE_TOKEN_FILE: token, FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}` };
  const output = (await execFileAsync(process.execPath, [forgeVerifyClient, 'receipt', '--receipt-id', receiptId], { env })).stdout;
  const projected = JSON.parse(output);
  const nativePruned = output.slice(0, 4096) + '\n[pruned]\n' + output.slice(-1024);
  for (const line of [56, 67, 72, 77]) assert.ok(nativePruned.includes(`SecurityDefenseController.java:[${line},24]`), `first compiler error ${line} survives pruning`);
  assert.equal(projected.failureDiagnostics.status, 'failed');
  assert.equal(projected.failureDiagnostics.untrusted, true);
  assert.ok(projected.failureDiagnostics.excerpt.length <= 2048);
  delete projected.failureDiagnostics;
  assert.deepEqual(projected, receipt, 'the original receipt content and failed truth remain unchanged');
  assert.equal(requests[0].includeDiagnostics, true);
  receipt = { ...receipt, status: 'passed', truth: { executionProven: true, verificationProven: true } };
  assert.deepEqual(JSON.parse((await execFileAsync(process.execPath, [forgeVerifyClient, 'receipt', '--receipt-id', receiptId], { env })).stdout), receipt);
});

test('forge-verify rejects unsupported, unsafe, duplicate, over-limit, and mixed frontend selectors before transport', async () => {
  const base = ['run', '--admission-id', '123e4567-e89b-12d3-a456-426614174000'];
  const invalidArgv = [
    [...base, '--profile', 'governance', '--idempotency-key', 'background-wrong-profile', '--execution-mode', 'background'],
    ['status', '--job-id', base[2], '--wait-seconds', '61'],
    ['status', '--job-id', base[2], '--wait-seconds', '1.5'],
    ['receipt', '--receipt-id', base[2], '--wait-seconds', '60'],
    [...base, '--profile', 'governance', '--idempotency-key', 'reuse-invalid-cli-1', '--reuse-receipt', 'not-a-uuid'],
    [...base, '--profile', 'governance', '--idempotency-key', 'reuse-duplicate-cli-1', '--reuse-receipt', base[2], '--reuse-receipt', base[2]],
    ['receipt', '--receipt-id', base[2], '--reuse-receipt', base[2]],
    [...base, '--profile', 'frontend-red-test', '--test-file', 'forge-admin-ui/src/a.spec.ts', '--idempotency-key', 'reuse-red-cli-1', '--reuse-receipt', base[2]],
    [...base, '--profile', 'governance', '--idempotency-key', 'reuse-ambiguous-cli-1', '--receipt-id', base[2]],
    [...base, '--profile', 'frontend-admin-lint', '--file', 'forge-admin-ui/src/../escape.ts', '--idempotency-key', 'lint-traversal-cli-1'],
    [...base, '--profile', 'frontend-admin-lint', '--file', 'other-ui/src/example.ts', '--idempotency-key', 'lint-path-cli-1'],
    [...base, '--profile', 'frontend-admin-lint', '--file', 'forge-admin-ui/src/example.css', '--idempotency-key', 'lint-suffix-cli-1'],
    [...base, '--profile', 'frontend-admin-lint', '--file', 'forge-admin-ui/src/example.ts', '--file', 'forge-admin-ui/src/example.ts', '--idempotency-key', 'lint-duplicate-cli-1'],
    [...base, '--profile', 'frontend-admin-test', '--test-file', 'forge-admin-ui/src/example.ts', '--idempotency-key', 'test-suffix-cli-1'],
    [...base, '--profile', 'frontend-red-test', '--test-file', 'forge-admin-ui/src/a.spec.ts', '--test-file', 'forge-admin-ui/src/b.spec.ts', '--idempotency-key', 'red-wide-cli-1'],
    [...base, '--profile', 'frontend-admin-build', '--file', 'forge-admin-ui/src/example.ts', '--idempotency-key', 'build-selector-cli-1'],
    [...base, '--profile', 'frontend-admin-lint', '--file', 'forge-admin-ui/src/example.ts', '--test-file', 'forge-admin-ui/src/example.test.ts', '--idempotency-key', 'mixed-selector-cli-1'],
    [...base, '--profile', 'frontend-admin-lint', ...Array.from({ length: 33 }, (_, index) => ['--file', `forge-admin-ui/src/generated/file-${index}.ts`]).flat(), '--idempotency-key', 'lint-over-limit-cli-1'],
  ];
  for (const args of invalidArgv) {
    await assert.rejects(() => execFileAsync(process.execPath, [forgeVerifyClient, ...args]), /forge-verify:/u);
  }
});

test('native completion watcher only observes an existing Host job and leaves receipt proof to its typed reader', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-watch-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = path.join(root, 'token');
  await writeFile(token, 'a'.repeat(48));
  const id = '123e4567-e89b-12d3-a456-426614174000';
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result: { jobId: id, receiptId: id,
      active: requests.length === 1, status: requests.length === 1 ? 'accepted' : 'failed',
      truth: { executionProven: false, verificationProven: false, releaseProven: false } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, FORGE_TASKSPACE_TOKEN_FILE: token,
    FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}` };
  const output = await execFileAsync(process.execPath, [forgeVerifyClient, 'watch', '--job-id', id], { env });
  const terminal = JSON.parse(output.stdout);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.observerStatus, 'finished');
  assert.equal(terminal.truth.verificationProven, false);
  assert.equal(terminal.nextAction, `forge-verify receipt --receipt-id ${id}`);
  assert.deepEqual(requests, Array.from({ length: 2 }, () => ({ action: 'verify-status', jobId: id, waitSeconds: 60 })));
  await assert.rejects(execFileAsync(process.execPath, [forgeVerifyClient, 'watch', '--job-id', '../outside'], { env }), /jobId.*invalid/u);
  assert.equal(requests.length, 2);
});
test('legacy runner rejects explicit receipt reuse before preparing execution', async () => {
  const runner = Object.create(VerificationRunner.prototype);
  runner.assertSandboxAvailable = async () => assert.fail('receipt reuse must not start legacy execution');
  await assert.rejects(() => runner.run('task-one', {
    action: 'run', profile: 'governance', selectors: {},
    idempotencyKey: 'legacy-reuse-1',
    admissionId: '123e4567-e89b-12d3-a456-426614174099',
    receiptId: '123e4567-e89b-12d3-a456-426614174000',
  }), { code: 'VERIFY_RECEIPT_REUSE_UNSUPPORTED' });
});

test('legacy runner refuses background submission instead of silently executing synchronously', async () => {
  const runner = Object.create(VerificationRunner.prototype);
  runner.assertSandboxAvailable = () => assert.fail('unsupported submission must not start execution');
  await assert.rejects(runner.run('task-one', { action: 'run', profile: 'full-regression', selectors: {},
    admissionId: '123e4567-e89b-12d3-a456-426614174000', idempotencyKey: 'background-legacy-one',
    executionMode: 'background' }), { code: 'VERIFY_BACKGROUND_UNSUPPORTED' });
});
const CACHE_WARM_COMMANDS = [
  ['env', MAVEN_VERIFICATION_ENV_ARG, MAVEN_VERIFICATION_EXEC_PATH, 'mvn', ...MAVEN_VERIFICATION_ARGS, '--no-transfer-progress', '-f', '/workspace/forge-server/pom.xml', '-Dmaven.repo.local=/warm/m2/repository', '-Penable-tests', '-DskipTests', 'dependency:go-offline'],
  ['pnpm', '--dir', '/workspace/forge-admin-ui', 'fetch', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/warm/pnpm/store', '--virtual-store-dir', '/warm/scratch/forge-admin-virtual-store', '--modules-dir', '/warm/scratch/forge-admin-node_modules'],
  ['pnpm', '--dir', '/workspace/forge-h5-ui', 'fetch', '--frozen-lockfile', '--ignore-scripts', '--store-dir', '/warm/pnpm/store', '--virtual-store-dir', '/warm/scratch/forge-h5-virtual-store', '--modules-dir', '/warm/scratch/forge-h5-node_modules'],
];
const CACHE_PRODUCER_TOPOLOGY = {
  schemaVersion: 'forge-verification-cache-producer-topology/v8',
  executorUser: '1000:1000',
  rootFilesystem: 'read-only',
  networkPolicy: 'enabled-only-for-fixed-warm-commands',
  pnpmLifecyclePolicy: { argv: '--ignore-scripts', logGate: 'no-lifecycle-execution-lines' },
  sourceMount: { destination: '/workspace', access: 'read-only' },
  warmWorkspaceMount: {
    destination: '/warm',
    access: 'read-write',
    publishAllowlist: ['m2/repository/', 'pnpm/store/'],
    disposablePaths: ['scratch/'],
    resumableBinding: 'compatibility-digest+dependency-fingerprint+acquisition-policy+source-head+base-images',
    scratchRemovedBeforePublish: true,
    scratchLifecycle: 'fresh-per-warm-attempt',
  },
  pnpmStoreSanitization: {
    removedPaths: ['pnpm/store/v11/projects/'],
    afterRemovalNodePolicy: 'ordinary-files-and-directories-only',
  },
  stageMaterialization: {
    include: ['m2/', 'pnpm/'],
    symlinkDereference: false,
    hardLinkPreservation: false,
    warmRetainedUntilFinalVerify: true,
  },
  ephemeralTmpfs: [
    { destination: '/tmp', options: 'rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700' },
  ],
  ephemeralEnvironment: {
    XDG_CACHE_HOME: '/warm/scratch/xdg-cache',
    MAVEN_OPTS: '-Djansi.tmpdir=/tmp/forge-maven-jansi',
  },
  mavenEphemeralState: {
    path: '/tmp/forge-maven-jansi',
    mode: '0700',
    lifecycle: 'fresh-per-command-and-container-ephemeral',
    sourceAndHomeWrites: 'forbidden',
  },
  hardening: { capDrop: 'ALL', noNewPrivileges: true },
};

function contract(projectSlug, root) {
  return {
    schemaVersion: 1,
    projectSlug,
    runnerRevision: 'vpn-forge-delivery-toolkit-60',
    toolchainImage: IMAGE,
    cacheRoot: path.join(root, 'cache-packs').replaceAll('\\', '/'),
    stateRoot: path.join(root, 'state').replaceAll('\\', '/'),
    profiles: [
      'governance', 'backend-red-test', 'frontend-red-test', 'backend-module-compile', 'backend-module-test', 'backend-test-class',
      'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build', 'frontend-h5-build', 'changed-safe', 'full-regression',
    ],
    limits: { maxFiles: 10_000, maxBytes: 128 * 1024 * 1024, maxLogBytes: 1024 * 1024, defaultTimeoutSeconds: 60 },
  };
}

test('forge-verify exposes a machine-readable profile catalog and typed capability errors', async () => {
  const catalog = JSON.parse((await execFileAsync(process.execPath, [forgeVerifyClient, 'profiles', '--format', 'json'])).stdout);
  assert.equal(catalog.schemaVersion, 'forge-verification-profile-catalog/v1');
  assert.deepEqual(catalog.profiles, [
    'governance', 'backend-red-test', 'frontend-red-test', 'backend-module-compile', 'backend-module-test', 'backend-test-class',
    'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build', 'frontend-h5-build',
    'changed-safe', 'full-regression',
  ]);
  await assert.rejects(
    () => execFileAsync(process.execPath, [forgeVerifyClient, 'capability', '--profile', 'unknown']),
    (error) => /VERIFY_PROFILE_UNKNOWN/u.test(error.stderr) && /allowedProfiles=/u.test(error.stderr),
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [forgeVerifyClient, 'capability', '--profile', 'backend-module-test'], {
      env: { ...process.env, FORGE_TASKSPACE_TOKEN_FILE: path.join(os.tmpdir(), `missing-token-${crypto.randomUUID()}`) },
    }),
    (error) => /VERIFY_CAPABILITY_UNAVAILABLE/u.test(error.stderr),
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [forgeVerifyClient, 'run', '--profile', 'frontend-admin-test'], {
      env: { ...process.env, FORGE_TASKSPACE_TOKEN_FILE: path.join(os.tmpdir(), `missing-token-${crypto.randomUUID()}`) },
    }),
    (error) => /run requires an explicit --idempotency-key/u.test(error.stderr),
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [forgeVerifyClient, 'admit',
      '--profile', 'backend-module-test', '--profile', 'governance']),
    (error) => /VERIFY_PROFILE_ORDER_INVALID/u.test(error.stderr),
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [forgeVerifyClient, 'run',
      '--profile', 'frontend-admin-test', '--idempotency-key', 'explicit-key-0001'], {
      env: { ...process.env, FORGE_TASKSPACE_TOKEN_FILE: path.join(os.tmpdir(), `missing-token-${crypto.randomUUID()}`) },
    }),
    (error) => /run requires an explicit --admission-id/u.test(error.stderr),
  );
});

test('forge-verify loads verify-policy from the sibling lib directory after bin installation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-installed-layout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const lib = path.join(root, 'lib');
  await mkdir(bin);
  await mkdir(lib);
  const installedClient = path.join(bin, 'forge-verify');
  await copyFile(forgeVerifyClient, installedClient);
  await copyFile(
    fileURLToPath(new URL('../docker/harness/verify-policy.mjs', import.meta.url)),
    path.join(lib, 'verify-policy.mjs'),
  );
  await copyFile(
    fileURLToPath(new URL('../docker/harness/maven-verification-policy.mjs', import.meta.url)),
    path.join(lib, 'maven-verification-policy.mjs'),
  );

  const output = await execFileAsync(process.execPath, [installedClient, 'profiles', '--format', 'json']);
  const catalog = JSON.parse(output.stdout);
  assert.equal(catalog.schemaVersion, 'forge-verification-profile-catalog/v1');
  assert.ok(catalog.profiles.includes('frontend-admin-lint'));
});

test('cache publisher refuses to create a manifest without both immutable executor base images', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [verificationCacheTool, 'publish',
      '--workspace', '/workspace', '--contract', '/contract.json',
      '--staging', '/staging', '--fingerprint', '0'.repeat(64)]),
    /arguments are incomplete/u,
  );
});

async function git(cwd, ...args) {
  return execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function createTaskspace(root, taskId = 'task-verify') {
  const workspace = path.join(root, 'taskspaces', taskId, 'workspace');
  await mkdir(path.join(workspace, 'forge-server', 'forge-business', 'forge-business-core'), { recursive: true });
  await writeFile(path.join(workspace, 'pom.xml'), '<project/>\n');
  await writeFile(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(path.join(workspace, 'forge-server', 'pom.xml'), '<project/>\n');
  await writeFile(path.join(workspace, 'forge-server', 'forge-business', 'forge-business-core', 'pom.xml'), '<project/>\n');
  await writeFile(path.join(workspace, 'README.md'), 'baseline\n');
  await git(workspace, 'init', '-q');
  await git(workspace, 'config', 'user.name', 'Verification Test');
  await git(workspace, 'config', 'user.email', 'verify@example.invalid');
  await git(workspace, 'add', '.');
  await git(workspace, 'commit', '-qm', 'baseline');
  const baseCommit = (await git(workspace, 'rev-parse', 'HEAD')).stdout.trim();
  const timestamp = new Date().toISOString();
  await writeFile(path.join(root, 'taskspaces', taskId, 'metadata.json'), JSON.stringify({
    schemaVersion: 1, projectSlug: 'forge-base', taskId, actorId: 'actor-one',
    conversationId: `conversation-${taskId}`, branch: `task/actor-one/${taskId}`, baseCommit,
    status: 'active', createdAt: timestamp, updatedAt: timestamp,
    accessTokenHash: 'a'.repeat(64), harnessPort: 30001, accessMode: 'conversation',
  }));
  return workspace;
}

test('frontend typecheck plans use every trusted changed root without a whole-project fallback', async (t) => {
  const roots = ['forge-admin-ui/src/changed.vue', 'forge-admin-ui/tests/changed.ts'];
  const plan = verificationCommand('frontend-admin-typecheck', {}, '1'.repeat(40), undefined, undefined, undefined, roots);
  assert.deepEqual(plan.steps.at(-1), { cwd: '/workspace', argv: [
    'node', '/usr/local/lib/frontend-typecheck.mjs', '--project', 'forge-admin-ui', '--files', JSON.stringify(roots),
  ] });
  assert.throws(() => verificationCommand('frontend-admin-typecheck', {}, '1'.repeat(40), undefined, undefined, undefined, []),
    { code: 'VERIFY_TYPECHECK_EMPTY_SCOPE' });
  assert.throws(() => verificationCommand('frontend-admin-typecheck', {}, '1'.repeat(40), undefined, undefined, undefined,
    ['forge-admin-ui/../outside.ts']), { code: 'VERIFY_SOURCE_INVALID' });
  const { resolveFrontendTypecheckFiles } = await import('../docker/harness/verify-policy.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-typecheck-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await createTaskspace(root);
  for (const name of ['src/unchanged.vue', 'src/changed.vue', 'src/deleted.ts']) {
    const file = path.join(workspace, 'forge-admin-ui', name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '<template>baseline</template>\n');
  }
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-qm', 'typecheck baseline');
  const reviewBase = (await git(workspace, 'rev-parse', 'HEAD')).stdout.trim();
  await writeFile(path.join(workspace, roots[0]), '<template>changed</template>\n');
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-qm', 'task checkpoint');
  for (const name of ['tests/changed.ts', 'src/untracked.js', 'scripts/check.ts']) {
    const file = path.join(workspace, 'forge-admin-ui', name);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'export const value = 1;\n');
  }
  await rm(path.join(workspace, 'forge-admin-ui/src/deleted.ts'));
  const source = { reviewBase, inventory: await inventoryWorkspace(workspace, contract('forge-base', root).limits),
    readGit: async argv => ({ ...(await git(workspace, ...argv)), exitCode: 0 }) };
  assert.deepEqual(await resolveFrontendTypecheckFiles(source), [
    'forge-admin-ui/scripts/check.ts', 'forge-admin-ui/src/changed.vue', 'forge-admin-ui/src/untracked.js', 'forge-admin-ui/tests/changed.ts',
  ]);
  await assert.rejects(resolveFrontendTypecheckFiles({ ...source,
    readGit: async () => ({ exitCode: 0, stdout: '', truncated: true }) }), { code: 'VERIFY_SOURCE_GIT_FAILED' });
});

test('frontend candidate filters use real task changes before dependency analysis without whole-project fallback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-frontend-test-filters-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await createTaskspace(root);
  const files = [
    'forge-admin-ui/src/untouched/Component.vue',
    'forge-admin-ui/src/page/page.vue',
    'forge-admin-ui/src/removed/component.vue',
  ];
  for (const file of files) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), '<template>baseline</template>\n');
  }
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-qm', 'baseline components');
  const reviewBase = (await git(workspace, 'rev-parse', 'HEAD')).stdout.trim();
  const source = async () => ({ reviewBase, inventory: await inventoryWorkspace(workspace, contract('forge-base', root).limits),
    readGit: async argv => ({ ...(await git(workspace, ...argv)), exitCode: 0 }) });
  assert.deepEqual(await resolveFrontendTestFilters(await source()), []);
  assert.deepEqual(frontendTestScopeFilters([]), ['__forge_no_changed_frontend_tests__/']);
  await writeFile(path.join(workspace, files[1]), '<template>committed change</template>\n');
  await git(workspace, 'add', '.'); await git(workspace, 'commit', '-qm', 'task change');
  await rm(path.join(workspace, files[2]));
  for (const file of ['forge-admin-ui/src/dirty/value.js', 'forge-admin-ui/tests/added.test.js', 'forge-admin-ui/src/page/page.test.js']) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), '// task change\n');
  }
  const filters = await resolveFrontendTestFilters(await source());
  assert.deepEqual(filters, ['src/dirty/', 'src/page/', 'src/removed/', 'tests/added.test.js']);
  const plan = verificationCommand('frontend-admin-test', {}, reviewBase, undefined, reviewBase, filters);
  assert.deepEqual(plan.steps.at(-1).argv.slice(2, 6), filters);
  assert.throws(() => frontendTestScopeFilters(['src/../']), /protected changed-file scope/u);
});

async function cacheCompatibility(source) {
  const mavenAcquisitionPolicy = await readMavenVerificationPolicy();
  const descriptor = {
    schemaVersion: 'forge-verification-cache-compatibility/v2',
    cacheManifestSchemaVersion: 3,
    dependencyManifestFingerprint: source.dependencyManifestFingerprint,
    implementation: await readCacheCompatibilityImplementation(),
    executorToolchainImages: { node: NODE_BASE_IMAGE, maven: MAVEN_BASE_IMAGE },
    mavenAcquisitionPolicy: mavenAcquisitionPolicy.descriptor,
    mavenAcquisitionPolicyDigest: mavenAcquisitionPolicy.digest,
    warmCommands: CACHE_WARM_COMMANDS,
    producerTopology: CACHE_PRODUCER_TOPOLOGY,
    packageManagerVersions: {
      node: process.version,
      corepack: '0.34.6',
      pnpm: '11.24.0',
      maven: 'Apache Maven 3.9.16',
      java: 'openjdk version "17.0.16"',
    },
  };
  return {
    descriptor,
    digest: crypto.createHash('sha256').update(JSON.stringify(descriptor), 'utf8').digest('hex'),
  };
}

async function makeTreeReadOnly(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await makeTreeReadOnly(child);
    else await chmod(child, 0o444);
  }
  await chmod(root, 0o555);
}

async function publishCachePack(cacheRoot, source, currentContract) {
  const fingerprint = source.dependencyManifestFingerprint;
  const pack = path.join(cacheRoot, fingerprint);
  const relative = 'm2/repository/example/example.jar';
  const content = Buffer.from('immutable-cache-fixture\n');
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  await mkdir(path.dirname(path.join(pack, relative)), { recursive: true });
  await writeFile(path.join(pack, relative), content);
  const packDigest = crypto.createHash('sha256')
    .update(relative).update('\0').update(sha256).update('\0').update(String(content.length)).update('\0')
    .digest('hex');
  const acquisitionPolicy = await readMavenVerificationPolicy();
  const compatibility = await cacheCompatibility(source);
  await writeFile(path.join(pack, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 3,
    complete: true,
    projectSlug: currentContract.projectSlug,
    dependencyManifestFingerprint: fingerprint,
    dependencyManifestFiles: source.dependencyManifestFiles,
    toolchainImage: currentContract.toolchainImage,
    runnerRevision: currentContract.runnerRevision,
    acquisition: { maven: acquisitionPolicy.descriptor },
    cacheCompatibilityDigest: compatibility.digest,
    cacheCompatibility: compatibility.descriptor,
    packDigest,
    files: [{ path: relative, sha256, bytes: content.length }],
  }, null, 2)}\n`);
  await makeTreeReadOnly(pack);
  return { pack, packDigest };
}

function processResult(overrides = {}) {
  const stdout = overrides.stdout ?? '';
  const stderr = overrides.stderr ?? '';
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr,
    bytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
    truncated: false,
    ...overrides,
  };
}

test('workspace inventory admits only its exact mounted path as a command-scoped safe Git directory', async () => {
  const calls = [];
  const command = async (executable, args, options) => {
    calls.push({ executable, args, options });
    if (args.includes('rev-parse')) return processResult({ stdout: `${'a'.repeat(40)}\n` });
    if (args.includes('ls-files')) return processResult({ stdout: '' });
    return processResult({ exitCode: 1, stderr: 'unexpected command' });
  };
  const workspace = path.resolve('mounted-eval-workspace');
  await inventoryWorkspace(workspace, contract('safe-dir', os.tmpdir()).limits, command);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.executable, 'git');
    assert.deepEqual(call.args.slice(0, 4), ['-C', workspace, '-c', `safe.directory=${workspace}`]);
    assert.equal(call.args.some((value) => value === 'safe.directory=*'), false);
    assert.equal(call.options.cleanGitEnvironment, true);
  }
});

function dockerLifecycle(options = {}) {
  const calls = [];
  const containers = new Map();
  let sequence = 0;
  return {
    calls,
    async command(args) {
      calls.push(args);
      if (args[0] === 'create') {
        if (options.createResult !== undefined) return processResult(options.createResult);
        sequence += 1;
        const id = sequence.toString(16).padStart(64, '0');
        const name = args[args.indexOf('--name') + 1];
        const labels = {};
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] !== '--label') continue;
          const separator = args[index + 1].indexOf('=');
          labels[args[index + 1].slice(0, separator)] = args[index + 1].slice(separator + 1);
        }
        containers.set(id, {
          id,
          name,
          labels,
          createArgs: args,
          state: { Running: false, ExitCode: 0, Status: 'created' },
          started: false,
        });
        return processResult({ stdout: `${id}\n` });
      }
      if (args[0] === 'inspect') {
        const container = containers.get(args.at(-1));
        if (!container) return processResult({ exitCode: 1, stderr: 'No such container\n' });
        if (container.started && options.completedInspectResult !== undefined) {
          return processResult(options.completedInspectResult);
        }
        const labels = options.ownershipMismatch === true
          ? { ...container.labels, 'io.forge.verification.owner': 'not-the-runner' }
          : container.labels;
        return processResult({ stdout: `${JSON.stringify([{
          Id: container.id,
          Name: `/${container.name}`,
          Config: { Labels: labels },
          State: container.state,
        }])}\n` });
      }
      if (args[0] === 'start') {
        const container = containers.get(args.at(-1));
        assert.ok(container, 'start must use the created container ID');
        container.started = true;
        if (options.onStart !== undefined) await options.onStart(container);
        const result = processResult(options.startResult ?? { stdout: 'PASS\n' });
        container.state = {
          Running: result.timedOut === true,
          ExitCode: Number.isInteger(result.exitCode) ? result.exitCode : 137,
          Status: result.timedOut === true ? 'running' : 'exited',
        };
        return result;
      }
      if (args[0] === 'rm') {
        const result = processResult(options.removeResult);
        if (result.exitCode === 0 && result.timedOut !== true && result.signal === null) containers.delete(args.at(-1));
        return result;
      }
      if (args[0] === 'ps') {
        if (options.proofResult !== undefined) return processResult(options.proofResult);
        const requested = args[args.indexOf('--filter') + 1].slice('id='.length);
        return processResult({ stdout: containers.has(requested) ? `${requested}\n` : '' });
      }
      throw new Error(`unexpected Docker command: ${args.join(' ')}`);
    },
  };
}

async function readyAdmission(runner, taskId, profiles, lifecycle) {
  const receipt = await runner.admit(taskId, profiles);
  assert.equal(receipt.outcome, 'ready');
  assert.match(receipt.admissionId, /^[0-9a-f-]{36}$/u);
  assert.equal(receipt.taskId, taskId);
  assert.deepEqual(receipt.profiles, profiles);
  if (lifecycle) lifecycle.calls.length = 0;
  return receipt;
}

test('verify policy accepts typed profiles and rejects arbitrary command surfaces', () => {
  const root = '/srv/forge-delivery/projects/forge-base/verification';
  assert.equal(validateVerificationContract(contract('forge-base', root), 'forge-base').toolchainImage, IMAGE);
  assert.throws(
    () => validateVerifyAction({ action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'valid-key-123', command: 'curl evil' }),
    /unsupported field/u,
  );
  assert.deepEqual(validateVerifyAction({
    action: 'admit', profiles: ['governance', 'backend-module-test', 'full-regression'],
  }).profiles, ['governance', 'backend-module-test', 'full-regression']);
  assert.throws(
    () => validateVerifyAction({ action: 'admit', profiles: ['full-regression', 'governance'] }),
    /catalog order/u,
  );
  assert.throws(
    () => validateVerifyAction({ action: 'run', profile: 'backend-module-test', selectors: { modules: ['../escape'] }, idempotencyKey: 'valid-key-123' }),
    /modules is invalid/u,
  );
  const command = verificationCommand(
    'backend-test-class',
    { modules: ['forge-server/forge-business/forge-business-core'], tests: ['ExampleTest#works'] },
    '1'.repeat(40),
  );
  assert.deepEqual(command.steps[0].argv, [
    'mvn', '--strict-checksums', '--settings', '/usr/local/lib/maven-verification-settings.xml', '-Dmaven.repo.local=/verify-cache/m2/repository', '-o', '-Pdev,enable-tests', '-pl', 'forge-business/forge-business-core', '-am',
    '-Dforge.compiler.skip=false', '-Dforge.tests.skip=false',
    '-Dtest=ExampleTest#works', '-Dsurefire.failIfNoSpecifiedTests=false', 'test',
  ]);
  assert.equal(JSON.stringify(command).includes('curl'), false);
  for (const profile of ['backend-red-test', 'backend-module-compile', 'backend-module-test', 'backend-test-class', 'full-regression']) {
    const selectors = profile === 'full-regression' ? {} : {
      modules: ['forge-server/forge-admin-server'],
      ...(['backend-red-test', 'backend-test-class'].includes(profile) ? { tests: ['ExampleTest#works'] } : {}),
    };
    const backend = verificationCommand(profile, selectors, '1'.repeat(40));
    assert.deepEqual(backend.steps[0].argv.filter(arg => arg.startsWith('-P')), ['-Pdev,enable-tests']);
    assert.ok(backend.steps[0].argv.includes('-Dforge.compiler.skip=false'));
    assert.ok(backend.steps[0].argv.includes('-Dforge.tests.skip=false'));
    assert.equal(backend.steps[0].argv.includes('-DskipTests'), profile === 'backend-module-compile');
  }
  const backendRed = verificationCommand(
    'backend-red-test',
    { modules: ['forge-server/forge-business/forge-business-core'], tests: ['ExampleTest#works'] },
    '1'.repeat(40),
  );
  assert.ok(backendRed.steps[0].argv.includes('-Dtest=ExampleTest#works'));
  assert.ok(backendRed.steps[0].argv.includes('-Dsurefire.failIfNoSpecifiedTests=false'));
  assert.equal(backendRed.steps[0].argv.includes('-Dsurefire.failIfNoSpecifiedTests=true'), false);
  assert.throws(() => validateVerifyAction({
    action: 'run', profile: 'backend-red-test',
    selectors: {
      modules: ['forge-server/forge-business/forge-business-core'],
      tests: ['ExampleTest', 'OtherTest'],
    },
    idempotencyKey: 'valid-key-123', admissionId: '123e4567-e89b-12d3-a456-426614174099',
  }), /from 1 to 1/u);
  assert.throws(() => validateVerifyAction({
    action: 'run', profile: 'backend-red-test',
    selectors: {
      modules: ['forge-server/forge-business/forge-business-core', 'forge-server/forge-framework/core'],
      tests: ['ExampleTest'],
    },
    idempotencyKey: 'valid-key-123', admissionId: '123e4567-e89b-12d3-a456-426614174099',
  }), /from 1 to 1/u);
  const frontendRed = verificationCommand(
    'frontend-red-test',
    { testFiles: ['forge-admin-ui/src/views/example/Example.spec.ts'] },
    '1'.repeat(40),
  );
  assert.deepEqual(frontendRed.steps[1], {
    cwd: '/workspace/forge-admin-ui',
    argv: ['pnpm', 'test', '--', '--run', 'src/views/example/Example.spec.ts', '--reporter=json', '--outputFile=/workspace/test-results-admin-red.json'],
  });
  assert.throws(() => verificationCommand(
    'frontend-red-test', { testFiles: ['../escape.spec.ts'] }, '1'.repeat(40),
  ), /testFiles is invalid/u);
  const frontend = verificationCommand('frontend-admin-test', {}, '1'.repeat(40));
  assert.deepEqual(frontend.steps[1], {
    cwd: '/workspace/forge-admin-ui',
    argv: ['pnpm', 'test', `--changed=${'1'.repeat(40)}`, '--passWithNoTests', '--reporter=json', '--outputFile=/workspace/test-results-admin.json'],
  });
  const lint = verificationCommand('frontend-admin-lint', {}, '1'.repeat(40),
    ['forge-admin-ui/src/changed.vue'], '1'.repeat(40));
  assert.deepEqual(lint.steps, [
    {
      cwd: '/workspace',
      argv: ['corepack', 'pnpm', '--dir', 'forge-admin-ui', 'install', '--offline', '--frozen-lockfile', '--store-dir', '/verify-cache/pnpm/store'],
    },
    {
      cwd: '/workspace/forge-admin-ui',
      argv: ['pnpm', 'exec', 'eslint', 'src/changed.vue', '--max-warnings=0', ...LINT_FORMAT_ARGS],
    },
  ]);
  const focusedLint = verificationCommand('frontend-admin-lint', {
    files: [
      'forge-admin-ui/src/views/supplier-profile/index.vue',
      'forge-admin-ui/src/views/supplier-profile/supplier-profile-contract.js',
    ],
  }, '1'.repeat(40), [
    'forge-admin-ui/src/views/supplier-profile/index.vue',
    'forge-admin-ui/src/views/supplier-profile/supplier-profile-contract.js',
  ], '1'.repeat(40));
  assert.deepEqual(focusedLint.steps[1].argv, [
    'pnpm', 'exec', 'eslint',
    'src/views/supplier-profile/index.vue',
    'src/views/supplier-profile/supplier-profile-contract.js',
    '--max-warnings=0',
    ...LINT_FORMAT_ARGS,
  ]);
  const focusedTest = verificationCommand('frontend-admin-test', {
    testFiles: ['forge-admin-ui/src/views/supplier-profile/__tests__/supplier-profile-contract.test.js'],
  }, '1'.repeat(40));
  assert.deepEqual(focusedTest.steps[1].argv, [
    'pnpm', 'test',
    'src/views/supplier-profile/__tests__/supplier-profile-contract.test.js',
    '--reporter=json', '--outputFile=/workspace/test-results-admin.json',
  ]);
  assert.throws(() => verificationCommand('frontend-admin-test', {
    testFiles: ['forge-admin-ui/src/../escape.test.js'],
  }, '1'.repeat(40)), /unsafe path segment/u);
  const typecheck = verificationCommand('frontend-admin-typecheck', {}, '1'.repeat(40), undefined, undefined, undefined,
    ['forge-admin-ui/src/example.ts']);
  assert.deepEqual(typecheck.steps, [
    {
      cwd: '/workspace',
      argv: ['corepack', 'pnpm', '--dir', 'forge-admin-ui', 'install', '--offline', '--frozen-lockfile', '--store-dir', '/verify-cache/pnpm/store'],
    },
    {
      cwd: '/workspace',
      argv: ['node', '/usr/local/lib/frontend-typecheck.mjs', '--project', 'forge-admin-ui', '--files', '["forge-admin-ui/src/example.ts"]'],
    },
  ]);
  assert.equal(isTestProfile('frontend-admin-lint'), false);
  assert.equal(isTestProfile('frontend-admin-typecheck'), false);
  assert.equal(isTestProfile('frontend-admin-test'), true);
  assert.throws(
    () => validateVerifyAction({
      action: 'run', profile: 'frontend-admin-lint',
      selectors: { modules: ['forge-server/forge-business/forge-business-core'] },
      idempotencyKey: 'valid-key-123',
    }),
    /unsupported field/u,
  );
  assert.ok(verificationCommand('full-regression', {}, '1'.repeat(40)).steps[0].argv.includes('-Pdev,enable-tests'));
});

test('workspace deletion changes content once and preserves its fingerprint across staging and commit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-deletion-'));
  t.after(async () => { await makeTreeOwnerWritable(root); await rm(root, { recursive: true, force: true }); });
  const workspace = await createTaskspace(root);
  const limits = contract('forge-base', root).limits;
  const before = await inventoryWorkspace(workspace, limits);
  await rm(path.join(workspace, 'README.md'));
  const deleted = await inventoryWorkspace(workspace, limits);
  assert.notEqual(deleted.workspaceFingerprint, before.workspaceFingerprint, 'actual deletion must change the source');
  assert.equal(deleted.files.find(item => item.relative === 'README.md').deleted, true, 'snapshot still needs the deletion');
  await git(workspace, 'add', '--', 'README.md');
  const staged = await inventoryWorkspace(workspace, limits);
  assert.equal(staged.workspaceFingerprint, deleted.workspaceFingerprint, 'index bookkeeping cannot alter candidate content');
  await git(workspace, 'commit', '-qm', 'withdraw draft');
  const committed = await inventoryWorkspace(workspace, limits);
  assert.notEqual(committed.head, deleted.head);
  assert.equal(committed.workspaceFingerprint, deleted.workspaceFingerprint, 'same-content checkpoint must permit bound reuse');
  assert.equal(committed.dependencyManifestFingerprint, before.dependencyManifestFingerprint);
  assert.equal(committed.files.some(item => item.relative === 'README.md'), false);
  await writeFile(path.join(workspace, 'README.md'), 'restored different content\n');
  assert.notEqual((await inventoryWorkspace(workspace, limits)).workspaceFingerprint, committed.workspaceFingerprint);
});

test('workspace fingerprint binds tracked and untracked content and rejects linked source', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-inventory-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root);
  const limits = contract('forge-base', root).limits;
  const first = await inventoryWorkspace(workspace, limits);
  assert.deepEqual(first.dependencyManifestFiles.map((entry) => entry.path), [
    'forge-server/forge-business/forge-business-core/pom.xml',
    'forge-server/pom.xml',
    'pnpm-lock.yaml',
    'pom.xml',
  ]);
  assert.ok(first.dependencyManifestFiles.every((entry) => /^[0-9a-f]{64}$/u.test(entry.sha256)));
  await writeFile(path.join(workspace, 'README.md'), 'changed\n');
  await writeFile(path.join(workspace, 'untracked.txt'), 'new\n');
  const second = await inventoryWorkspace(workspace, limits);
  assert.notEqual(second.workspaceFingerprint, first.workspaceFingerprint);
  assert.equal(second.dependencyManifestFingerprint, first.dependencyManifestFingerprint);
  assert.equal(second.fileCount, first.fileCount + 1);

  try {
    await symlink(path.join(workspace, 'README.md'), path.join(workspace, 'linked.txt'));
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('Windows symbolic-link privilege is unavailable');
      return;
    }
    throw error;
  }
  await assert.rejects(() => inventoryWorkspace(workspace, limits), /linked file/u);
});

test('workspace inventory deduplicates real unmerged index stages without changing source identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-unmerged-inventory-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root);
  const limits = contract('forge-base', root).limits;
  const clean = await inventoryWorkspace(workspace, limits);
  await git(workspace, 'checkout', '-qb', 'local-change');
  await writeFile(path.join(workspace, 'README.md'), 'local\n');
  await git(workspace, 'commit', '-qam', 'local change');
  const localHead = (await git(workspace, 'rev-parse', 'HEAD')).stdout.trim();
  await git(workspace, 'checkout', '-qb', 'canonical-change', 'HEAD^');
  await writeFile(path.join(workspace, 'README.md'), 'canonical\n');
  await git(workspace, 'commit', '-qam', 'canonical change');
  const canonicalHead = (await git(workspace, 'rev-parse', 'HEAD')).stdout.trim();
  await git(workspace, 'checkout', '-q', 'local-change');
  await assert.rejects(git(workspace, 'merge', '--no-edit', canonicalHead));

  const unmerged = await inventoryWorkspace(workspace, limits);
  const repeated = await inventoryWorkspace(workspace, { ...limits, maxFiles: clean.fileCount });
  assert.equal(unmerged.head, localHead);
  assert.equal(unmerged.fileCount, clean.fileCount);
  assert.deepEqual(unmerged.files.map((item) => item.relative), clean.files.map((item) => item.relative));
  assert.match(unmerged.workspaceFingerprint, /^[0-9a-f]{64}$/u);
  assert.notEqual(unmerged.workspaceFingerprint, clean.workspaceFingerprint);
  assert.equal(repeated.head, unmerged.head);
  assert.equal(repeated.workspaceFingerprint, unmerged.workspaceFingerprint);
  assert.deepEqual(repeated.files, unmerged.files);
  await assert.rejects(
    inventoryWorkspace(workspace, { ...limits, maxFiles: clean.fileCount - 1 }),
    (error) => error.code === 'VERIFY_SOURCE_LIMIT',
  );
});

test('cache packs are content addressed, exact-tree verified, and fail closed on drift', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-cache-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const currentContract = contract('forge-base', root);
  const workspace = await createTaskspace(root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  const fingerprint = source.dependencyManifestFingerprint;
  const published = await publishCachePack(root, source, currentContract);
  const ready = await verifyCachePack(root, fingerprint, currentContract, source.dependencyManifestFiles);
  assert.equal(ready.outcome, 'ready');
  assert.equal(ready.packDigest, published.packDigest);
  const driftFile = path.join(published.pack, 'm2', 'repository', 'example', 'example.jar');
  await chmod(driftFile, 0o644);
  await writeFile(driftFile, 'drift\n');
  await chmod(driftFile, 0o444);
  await assert.rejects(
    () => verifyCachePack(root, fingerprint, currentContract, source.dependencyManifestFiles),
    /differs from its manifest/u,
  );
  const missingSource = { dependencyManifestFingerprint: crypto.createHash('sha256').digest('hex'), dependencyManifestFiles: [] };
  assert.equal((await verifyCachePack(
    root,
    missingSource.dependencyManifestFingerprint,
    currentContract,
    missingSource.dependencyManifestFiles,
  )).outcome, 'cache_miss');
});

test('cache identity is project-scoped and exactly bound to the sorted current dependency inventory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-cache-identity-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const currentContract = contract('forge-base', root);
  const workspace = await createTaskspace(root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  assert.deepEqual(source.dependencyManifestFiles.map((entry) => entry.path), [
    'forge-server/forge-business/forge-business-core/pom.xml',
    'forge-server/pom.xml',
    'pnpm-lock.yaml',
    'pom.xml',
  ]);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);

  const nestedLock = 'forge-admin-ui/packages/attachment-tools/pnpm-lock.yaml';
  const nestedPath = path.join(workspace, nestedLock);
  await mkdir(path.dirname(nestedPath), { recursive: true });
  await writeFile(nestedPath, 'lockfileVersion: 9\n');
  await git(workspace, 'add', nestedLock);
  const added = await inventoryWorkspace(workspace, currentContract.limits);
  assert.deepEqual(added.dependencyManifestFiles.map(entry => entry.path),
    [...source.dependencyManifestFiles.map(entry => entry.path), nestedLock].sort());
  assert.notEqual(added.dependencyManifestFingerprint, source.dependencyManifestFingerprint);
  assert.equal((await verifyCachePack(currentContract.cacheRoot, added.dependencyManifestFingerprint,
    currentContract, added.dependencyManifestFiles)).outcome, 'cache_miss');
  await assert.rejects(() => verifyCachePack(currentContract.cacheRoot, source.dependencyManifestFingerprint,
    currentContract, added.dependencyManifestFiles), /does not match its fingerprint/u);
  await writeFile(nestedPath, 'lockfileVersion: 9\nsettings: {}\n');
  const changed = await inventoryWorkspace(workspace, currentContract.limits);
  assert.notEqual(changed.dependencyManifestFingerprint, added.dependencyManifestFingerprint);
  await rm(nestedPath);
  const deleted = await inventoryWorkspace(workspace, currentContract.limits);
  assert.equal(deleted.files.find(entry => entry.relative === nestedLock).deleted, true);
  assert.notEqual(deleted.dependencyManifestFingerprint, changed.dependencyManifestFingerprint);
  assert.equal(deleted.dependencyManifestFingerprint, source.dependencyManifestFingerprint);

  await assert.rejects(
    () => verifyCachePack(
      currentContract.cacheRoot,
      source.dependencyManifestFingerprint,
      { ...currentContract, projectSlug: 'another-project' },
      source.dependencyManifestFiles,
    ),
    /manifest contract is invalid/u,
  );
  await assert.rejects(
    () => verifyCachePack(
      currentContract.cacheRoot,
      source.dependencyManifestFingerprint,
      currentContract,
      [...source.dependencyManifestFiles].reverse(),
    ),
    /not deterministically sorted/u,
  );
  await assert.rejects(
    () => verifyCachePack(
      currentContract.cacheRoot,
      source.dependencyManifestFingerprint,
      currentContract,
      source.dependencyManifestFiles.map((entry, index) => (index === 0 ? { ...entry, sha256: 'f'.repeat(64) } : entry)),
    ),
    /does not match its fingerprint/u,
  );

  const manifestFile = path.join(
    currentContract.cacheRoot,
    source.dependencyManifestFingerprint,
    'manifest.json',
  );
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  delete manifest.dependencyManifestFiles;
  await chmod(manifestFile, 0o644);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await chmod(manifestFile, 0o444);
  await assert.rejects(
    () => verifyCachePack(
      currentContract.cacheRoot,
      source.dependencyManifestFingerprint,
      currentContract,
      source.dependencyManifestFiles,
    ),
    /manifest contract is invalid/u,
  );
});

test('operator cache publisher binds the immutable pack to current dependency manifests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-publish-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root);
  const currentContract = contract('forge-base', root);
  const contractFile = path.join(root, 'contract.json');
  const staging = path.join(root, 'staging');
  await mkdir(path.join(staging, 'm2', 'repository', 'example'), { recursive: true });
  await mkdir(path.join(staging, 'm2', 'repository', 'artifact'), { recursive: true });
  await mkdir(path.join(staging, 'pnpm', 'store', 'v3'), { recursive: true });
  await writeFile(path.join(staging, 'm2', 'repository', 'example', 'dependency.jar'), 'jar\n');
  await writeFile(path.join(staging, 'm2', 'repository', 'artifact', 'content.jar'), 'nested\n');
  await writeFile(path.join(staging, 'm2', 'repository', 'artifact-z.jar'), 'sibling\n');
  await writeFile(path.join(staging, 'pnpm', 'store', 'v3', 'index.json'), '{}\n');
  await writeFile(contractFile, `${JSON.stringify(currentContract)}\n`);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  const tool = path.resolve('docker/harness/verification-cache-tool.mjs');
  const toolEnvironment = { ...process.env, PATH: await fakeToolchainPath(root) };
  const fingerprintReceipt = JSON.parse((await execFileAsync(process.execPath, [tool, 'fingerprint',
    '--workspace', workspace,
    '--contract', contractFile,
  ], { encoding: 'utf8', env: toolEnvironment })).stdout);
  assert.equal(fingerprintReceipt.sourceHead, source.head);
  assert.equal(fingerprintReceipt.workspaceFingerprint, source.workspaceFingerprint);
  assert.equal(fingerprintReceipt.dependencyManifestFingerprint, source.dependencyManifestFingerprint);
  assert.deepEqual(fingerprintReceipt.dependencyManifestFiles, source.dependencyManifestFiles);
  await execFileAsync(process.execPath, [tool, 'publish',
    '--workspace', workspace,
    '--contract', contractFile,
    '--staging', staging,
    '--fingerprint', source.dependencyManifestFingerprint,
    '--node-base-image', NODE_BASE_IMAGE,
    '--maven-base-image', MAVEN_BASE_IMAGE,
  ], { encoding: 'utf8', env: toolEnvironment });
  const manifest = JSON.parse(await readFile(path.join(staging, 'manifest.json'), 'utf8'));
  const acquisitionPolicy = await readMavenVerificationPolicy();
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.complete, true);
  assert.equal(manifest.projectSlug, currentContract.projectSlug);
  assert.equal(manifest.dependencyManifestFingerprint, source.dependencyManifestFingerprint);
  assert.deepEqual(manifest.dependencyManifestFiles, source.dependencyManifestFiles);
  assert.deepEqual(manifest.acquisition, { maven: acquisitionPolicy.descriptor });
  assert.equal(manifest.cacheCompatibility.schemaVersion, 'forge-verification-cache-compatibility/v2');
  assert.equal(manifest.cacheCompatibility.producerTopology.schemaVersion, 'forge-verification-cache-producer-topology/v8');
  assert.match(manifest.cacheCompatibilityDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(manifest.files.map((entry) => entry.path), [
    'm2/repository/artifact-z.jar',
    'm2/repository/artifact/content.jar',
    'm2/repository/example/dependency.jar',
    'pnpm/store/v3/index.json',
  ]);
  const canonicalPackHash = crypto.createHash('sha256');
  for (const entry of manifest.files) {
    canonicalPackHash.update(entry.path).update('\0').update(entry.sha256).update('\0').update(String(entry.bytes)).update('\0');
  }
  assert.equal(manifest.packDigest, canonicalPackHash.digest('hex'));
  await mkdir(currentContract.cacheRoot, { recursive: true });
  const finalPack = path.join(currentContract.cacheRoot, source.dependencyManifestFingerprint);
  await rename(staging, finalPack);
  await makeTreeReadOnly(finalPack);
  const verifyReceipt = JSON.parse((await execFileAsync(process.execPath, [tool, 'verify',
    '--workspace', workspace,
    '--contract', contractFile,
    '--fingerprint', source.dependencyManifestFingerprint,
  ], { encoding: 'utf8', env: toolEnvironment })).stdout);
  assert.equal(verifyReceipt.outcome, 'ready');
  assert.equal((await verifyCachePack(
    currentContract.cacheRoot,
    source.dependencyManifestFingerprint,
    currentContract,
    source.dependencyManifestFiles,
  )).outcome, 'ready');
  const reversedManifest = structuredClone(manifest);
  reversedManifest.files.reverse();
  const manifestFile = path.join(finalPack, 'manifest.json');
  await chmod(manifestFile, 0o644);
  await writeFile(manifestFile, `${JSON.stringify(reversedManifest, null, 2)}\n`);
  await chmod(manifestFile, 0o444);
  await assert.rejects(
    () => verifyCachePack(
      currentContract.cacheRoot,
      source.dependencyManifestFingerprint,
      currentContract,
      source.dependencyManifestFiles,
    ),
    /canonical path order/u,
  );
  await chmod(manifestFile, 0o644);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await chmod(manifestFile, 0o444);
  await assert.rejects(
    () => verifyCachePack(
      currentContract.cacheRoot,
      source.dependencyManifestFingerprint,
      { ...currentContract, runnerRevision: 'different-runner-revision' },
      source.dependencyManifestFiles,
    ),
    /manifest contract is invalid/u,
  );
  await writeFile(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n');
  await assert.rejects(
    () => execFileAsync(process.execPath, [tool, 'verify',
      '--workspace', workspace,
      '--contract', contractFile,
      '--fingerprint', source.dependencyManifestFingerprint,
    ], { encoding: 'utf8', env: toolEnvironment }),
    /Current dependency manifests do not match/u,
  );
  await assert.rejects(
    () => execFileAsync(process.execPath, [tool, 'publish',
      '--workspace', workspace,
      '--contract', contractFile,
      '--staging', finalPack,
      '--fingerprint', source.dependencyManifestFingerprint,
      '--node-base-image', NODE_BASE_IMAGE,
      '--maven-base-image', MAVEN_BASE_IMAGE,
    ], { encoding: 'utf8', env: toolEnvironment }),
    /Dependency manifests changed/u,
  );
});

async function fakeToolchainPath(root) {
  const bin = path.join(root, 'fake-toolchain-bin');
  await mkdir(bin);
  for (const [name, output] of [
    ['corepack', '0.34.6'],
    ['pnpm', '11.24.0'],
    ['mvn', 'Apache Maven 3.9.16\nJava version: 17.0.16'],
    ['java', 'openjdk version "17.0.16"'],
  ]) {
    if (process.platform === 'win32') {
      await writeFile(path.join(bin, `${name}.cmd`), `@echo off\r\necho ${output.replaceAll('\n', '\r\necho ')}\r\n`);
    } else {
      const executable = path.join(bin, name);
      await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${output.replaceAll("'", "'\\''")}'\n`);
      await chmod(executable, 0o755);
    }
  }
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

async function makeTreeOwnerWritable(root) {
  await chmod(root, 0o700).catch(() => {});
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await makeTreeOwnerWritable(child);
    else await chmod(child, 0o600).catch(() => {});
  }
}

test('cache compatibility is stable across governance-only image identity changes and closes over dependencies and executor bases', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-cache-compat-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root);
  const firstContract = contract('forge-base', root);
  const secondContract = {
    ...firstContract,
    runnerRevision: 'vpn-forge-delivery-toolkit-999',
    toolchainImage: `sha256:${'b'.repeat(64)}`,
  };
  const firstContractFile = path.join(root, 'contract-first.json');
  const secondContractFile = path.join(root, 'contract-second.json');
  await writeFile(firstContractFile, `${JSON.stringify(firstContract)}\n`);
  await writeFile(secondContractFile, `${JSON.stringify(secondContract)}\n`);
  const tool = path.resolve('docker/harness/verification-cache-tool.mjs');
  const nodeBase = `node:24@sha256:${'c'.repeat(64)}`;
  const mavenBase = `maven:3.9@sha256:${'d'.repeat(64)}`;
  const env = { ...process.env, PATH: await fakeToolchainPath(root) };
  const compatibility = async (contractFile, nodeImage = nodeBase) => JSON.parse((await execFileAsync(process.execPath, [
    tool, 'compatibility', '--workspace', workspace, '--contract', contractFile,
    '--node-base-image', nodeImage, '--maven-base-image', mavenBase,
  ], { encoding: 'utf8', env })).stdout);
  const first = await compatibility(firstContractFile);
  const governanceOnly = await compatibility(secondContractFile);
  assert.equal(first.cacheCompatibilityDigest, governanceOnly.cacheCompatibilityDigest);
  assert.equal(first.cacheCompatibility.dependencyManifestFingerprint, governanceOnly.cacheCompatibility.dependencyManifestFingerprint);
  assert.deepEqual(first.cacheCompatibility.executorToolchainImages, { node: nodeBase, maven: mavenBase });
  assert.equal(first.cacheCompatibility.schemaVersion, 'forge-verification-cache-compatibility/v2');
  assert.equal(first.cacheCompatibility.cacheManifestSchemaVersion, 3);
  assert.equal(first.cacheCompatibility.mavenAcquisitionPolicy.strictChecksums, true);
  assert.equal(first.cacheCompatibility.mavenAcquisitionPolicy.credentials, 'forbidden');
  assert.match(first.cacheCompatibility.mavenAcquisitionPolicyDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(first.cacheCompatibility.warmCommands[0].slice(0, 5), [
    'env', 'MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi', '/usr/local/bin/maven-verification-exec', 'mvn', '--strict-checksums',
  ]);
  assert.deepEqual(first.cacheCompatibility.warmCommands.map((entry) => entry[0]), ['env', 'pnpm', 'pnpm']);
  assert.equal(first.cacheCompatibility.warmCommands[1].includes('--ignore-scripts'), true);
  assert.equal(first.cacheCompatibility.warmCommands[2].includes('--ignore-scripts'), true);
  assert.deepEqual(first.cacheCompatibility.warmCommands[1].slice(-4), [
    '--virtual-store-dir', '/warm/scratch/forge-admin-virtual-store', '--modules-dir', '/warm/scratch/forge-admin-node_modules',
  ]);
  assert.deepEqual(first.cacheCompatibility.warmCommands[2].slice(-4), [
    '--virtual-store-dir', '/warm/scratch/forge-h5-virtual-store', '--modules-dir', '/warm/scratch/forge-h5-node_modules',
  ]);
  assert.deepEqual(first.cacheCompatibility.producerTopology, {
    schemaVersion: 'forge-verification-cache-producer-topology/v8',
    executorUser: '1000:1000',
    rootFilesystem: 'read-only',
    networkPolicy: 'enabled-only-for-fixed-warm-commands',
    pnpmLifecyclePolicy: { argv: '--ignore-scripts', logGate: 'no-lifecycle-execution-lines' },
    sourceMount: { destination: '/workspace', access: 'read-only' },
    warmWorkspaceMount: {
      destination: '/warm',
      access: 'read-write',
      publishAllowlist: ['m2/repository/', 'pnpm/store/'],
      disposablePaths: ['scratch/'],
      resumableBinding: 'compatibility-digest+dependency-fingerprint+acquisition-policy+source-head+base-images',
      scratchRemovedBeforePublish: true,
      scratchLifecycle: 'fresh-per-warm-attempt',
    },
    pnpmStoreSanitization: {
      removedPaths: ['pnpm/store/v11/projects/'],
      afterRemovalNodePolicy: 'ordinary-files-and-directories-only',
    },
    stageMaterialization: {
      include: ['m2/', 'pnpm/'],
      symlinkDereference: false,
      hardLinkPreservation: false,
      warmRetainedUntilFinalVerify: true,
    },
    ephemeralTmpfs: [
      { destination: '/tmp', options: 'rw,exec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700' },
    ],
    ephemeralEnvironment: {
      XDG_CACHE_HOME: '/warm/scratch/xdg-cache',
      MAVEN_OPTS: '-Djansi.tmpdir=/tmp/forge-maven-jansi',
    },
    mavenEphemeralState: {
      path: '/tmp/forge-maven-jansi',
      mode: '0700',
      lifecycle: 'fresh-per-command-and-container-ephemeral',
      sourceAndHomeWrites: 'forbidden',
    },
    hardening: { capDrop: 'ALL', noNewPrivileges: true },
  });
  const legacyV7Descriptor = structuredClone(first.cacheCompatibility);
  legacyV7Descriptor.producerTopology.schemaVersion = 'forge-verification-cache-producer-topology/v7';
  delete legacyV7Descriptor.producerTopology.pnpmStoreSanitization;
  delete legacyV7Descriptor.producerTopology.stageMaterialization;
  assert.notEqual(
    first.cacheCompatibilityDigest,
    crypto.createHash('sha256').update(JSON.stringify(legacyV7Descriptor), 'utf8').digest('hex'),
  );
  assert.match(first.cacheCompatibility.packageManagerVersions.maven, /Maven 3\.9\.16/u);
  assert.deepEqual(first.cacheCompatibility.implementation.map((entry) => entry.path), [
    'verification-cache-tool.mjs', 'verification-runner.mjs', 'verify-policy.mjs',
    'maven-verification-policy.mjs', 'maven-verification-settings.xml', 'maven-verification-exec.sh',
  ]);
  const changedBase = await compatibility(secondContractFile, `node:24@sha256:${'e'.repeat(64)}`);
  assert.notEqual(first.cacheCompatibilityDigest, changedBase.cacheCompatibilityDigest);
  await writeFile(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n');
  const changedDependency = await compatibility(secondContractFile);
  assert.notEqual(first.cacheCompatibilityDigest, changedDependency.cacheCompatibilityDigest);

  const copiedToolRoot = path.join(root, 'copied-cache-tool');
  await mkdir(copiedToolRoot);
  for (const name of [
    'verification-cache-tool.mjs', 'verification-runner.mjs', 'verify-policy.mjs', 'taskspace-policy.mjs',
    'maven-verification-policy.mjs', 'maven-verification-settings.xml', 'maven-verification-exec.sh',
  ]) {
    await copyFile(path.resolve('docker/harness', name), path.join(copiedToolRoot, name));
  }
  const copiedTool = path.join(copiedToolRoot, 'verification-cache-tool.mjs');
  const beforeSettingsDrift = JSON.parse((await execFileAsync(process.execPath, [
    copiedTool, 'compatibility', '--workspace', workspace, '--contract', secondContractFile,
    '--node-base-image', nodeBase, '--maven-base-image', mavenBase,
  ], { encoding: 'utf8', env })).stdout);
  const copiedSettings = path.join(copiedToolRoot, 'maven-verification-settings.xml');
  await writeFile(copiedSettings, `${await readFile(copiedSettings, 'utf8')}\n<!-- reviewed-policy-drift -->\n`);
  const afterSettingsDrift = JSON.parse((await execFileAsync(process.execPath, [
    copiedTool, 'compatibility', '--workspace', workspace, '--contract', secondContractFile,
    '--node-base-image', nodeBase, '--maven-base-image', mavenBase,
  ], { encoding: 'utf8', env })).stdout);
  assert.notEqual(beforeSettingsDrift.cacheCompatibilityDigest, afterSettingsDrift.cacheCompatibilityDigest);
  assert.notEqual(
    beforeSettingsDrift.cacheCompatibility.mavenAcquisitionPolicy.settingsSha256,
    afterSettingsDrift.cacheCompatibility.mavenAcquisitionPolicy.settingsSha256,
  );
});

test('cache verification rejects legacy schema packs without the acquisition contract', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-cache-legacy-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root);
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  const published = await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const manifestFile = path.join(published.pack, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  delete manifest.acquisition;
  manifest.schemaVersion = 2;
  await chmod(manifestFile, 0o644);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  await chmod(manifestFile, 0o444);
  await assert.rejects(
    () => verifyCachePack(
      currentContract.cacheRoot,
      source.dependencyManifestFingerprint,
      currentContract,
      source.dependencyManifestFiles,
    ),
    /manifest contract is invalid/u,
  );
});

test('cache verification rejects missing, legacy, and tampered compatibility closures', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-cache-compat-invalid-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root);
  const sourceContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, sourceContract.limits);
  const cases = [
    ['missing', (manifest) => {
      delete manifest.cacheCompatibility;
      delete manifest.cacheCompatibilityDigest;
    }],
    ['legacy-schema', (manifest) => {
      manifest.cacheCompatibility.schemaVersion = 'forge-verification-cache-compatibility/v1';
      manifest.cacheCompatibilityDigest = crypto.createHash('sha256')
        .update(JSON.stringify(manifest.cacheCompatibility), 'utf8').digest('hex');
    }],
    ['dependency-fingerprint', (manifest) => {
      manifest.cacheCompatibility.dependencyManifestFingerprint = 'f'.repeat(64);
      manifest.cacheCompatibilityDigest = crypto.createHash('sha256')
        .update(JSON.stringify(manifest.cacheCompatibility), 'utf8').digest('hex');
    }],
    ['maven-policy', (manifest) => {
      manifest.cacheCompatibility.mavenAcquisitionPolicy.strictChecksums = false;
      manifest.cacheCompatibilityDigest = crypto.createHash('sha256')
        .update(JSON.stringify(manifest.cacheCompatibility), 'utf8').digest('hex');
    }],
    ['producer-topology-legacy-v7', (manifest) => {
      manifest.cacheCompatibility.producerTopology.schemaVersion = 'forge-verification-cache-producer-topology/v7';
      delete manifest.cacheCompatibility.producerTopology.pnpmStoreSanitization;
      delete manifest.cacheCompatibility.producerTopology.stageMaterialization;
      manifest.cacheCompatibilityDigest = crypto.createHash('sha256')
        .update(JSON.stringify(manifest.cacheCompatibility), 'utf8').digest('hex');
    }],
    ['producer-topology-missing-pnpm-store-sanitization', (manifest) => {
      delete manifest.cacheCompatibility.producerTopology.pnpmStoreSanitization;
      manifest.cacheCompatibilityDigest = crypto.createHash('sha256')
        .update(JSON.stringify(manifest.cacheCompatibility), 'utf8').digest('hex');
    }],
    ['producer-topology-missing-stage-materialization', (manifest) => {
      delete manifest.cacheCompatibility.producerTopology.stageMaterialization;
      manifest.cacheCompatibilityDigest = crypto.createHash('sha256')
        .update(JSON.stringify(manifest.cacheCompatibility), 'utf8').digest('hex');
    }],
    ['digest', (manifest) => {
      manifest.cacheCompatibilityDigest = '0'.repeat(64);
    }],
  ];
  for (const [name, mutate] of cases) {
    const currentContract = { ...sourceContract, cacheRoot: path.join(root, `cache-${name}`).replaceAll('\\', '/') };
    const published = await publishCachePack(currentContract.cacheRoot, source, currentContract);
    const manifestFile = path.join(published.pack, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    mutate(manifest);
    await chmod(manifestFile, 0o644);
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    await chmod(manifestFile, 0o444);
    await assert.rejects(
      () => verifyCachePack(
        currentContract.cacheRoot,
        source.dependencyManifestFingerprint,
        currentContract,
        source.dependencyManifestFiles,
      ),
      /compatibility/u,
      name,
    );
  }
});

test('cache verification rejects a writable pack root, directory, manifest, or content file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-cache-writable-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root);
  const sourceContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, sourceContract.limits);
  const cases = [
    ['root', (pack) => pack],
    ['directory', (pack) => path.join(pack, 'm2', 'repository')],
    ['manifest', (pack) => path.join(pack, 'manifest.json')],
    ['file', (pack) => path.join(pack, 'm2', 'repository', 'example', 'example.jar')],
  ];
  for (const [name, target] of cases) {
    const currentContract = { ...sourceContract, cacheRoot: path.join(root, `cache-${name}`).replaceAll('\\', '/') };
    const published = await publishCachePack(currentContract.cacheRoot, source, currentContract);
    await chmod(target(published.pack), name === 'root' || name === 'directory' ? 0o755 : 0o644);
    await assert.rejects(
      () => verifyCachePack(
        currentContract.cacheRoot,
        source.dependencyManifestFingerprint,
        currentContract,
        source.dependencyManifestFiles,
      ),
      /read-only|writable/u,
      name,
    );
  }
});

test('cache promotion re-hashes one read-only compatible pack and rebinds only a fresh copy', {
  skip: process.platform === 'win32' ? 'POSIX read-only mode evidence is unavailable on Windows.' : false,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-cache-promote-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root);
  const sourceContract = contract('forge-base', root);
  const targetContract = {
    ...sourceContract,
    runnerRevision: 'vpn-forge-delivery-toolkit-999',
    toolchainImage: `sha256:${'b'.repeat(64)}`,
  };
  const sourceContractFile = path.join(root, 'contract-source.json');
  const targetContractFile = path.join(root, 'contract-target.json');
  await writeFile(sourceContractFile, `${JSON.stringify(sourceContract)}\n`);
  await writeFile(targetContractFile, `${JSON.stringify(targetContract)}\n`);
  const source = await inventoryWorkspace(workspace, sourceContract.limits);
  const sourcePack = path.join(root, source.dependencyManifestFingerprint);
  await mkdir(path.join(sourcePack, 'm2', 'repository', 'example'), { recursive: true });
  await mkdir(path.join(sourcePack, 'm2', 'repository', 'artifact'), { recursive: true });
  await writeFile(path.join(sourcePack, 'm2', 'repository', 'example', 'dependency.jar'), 'jar\n');
  await writeFile(path.join(sourcePack, 'm2', 'repository', 'artifact', 'content.jar'), 'nested\n');
  await writeFile(path.join(sourcePack, 'm2', 'repository', 'artifact-z.jar'), 'sibling\n');
  const tool = path.resolve('docker/harness/verification-cache-tool.mjs');
  const nodeBase = `node:24@sha256:${'c'.repeat(64)}`;
  const mavenBase = `maven:3.9@sha256:${'d'.repeat(64)}`;
  const env = { ...process.env, PATH: await fakeToolchainPath(root) };
  await execFileAsync(process.execPath, [
    tool, 'publish', '--workspace', workspace, '--contract', sourceContractFile,
    '--staging', sourcePack, '--fingerprint', source.dependencyManifestFingerprint,
    '--node-base-image', nodeBase, '--maven-base-image', mavenBase,
  ], { encoding: 'utf8', env });
  const publishedManifest = JSON.parse(await readFile(path.join(sourcePack, 'manifest.json'), 'utf8'));
  assert.deepEqual(publishedManifest.files.map((entry) => entry.path), [
    'm2/repository/artifact-z.jar',
    'm2/repository/artifact/content.jar',
    'm2/repository/example/dependency.jar',
  ]);
  const currentCompatibility = JSON.parse((await execFileAsync(process.execPath, [
    tool, 'compatibility', '--workspace', workspace, '--contract', targetContractFile,
    '--node-base-image', nodeBase, '--maven-base-image', mavenBase,
  ], { encoding: 'utf8', env })).stdout);
  assert.deepEqual(publishedManifest.cacheCompatibility, currentCompatibility.cacheCompatibility);
  assert.equal(publishedManifest.cacheCompatibilityDigest, currentCompatibility.cacheCompatibilityDigest);
  const makeReadOnly = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await makeReadOnly(child);
      else await chmod(child, 0o444);
    }
    await chmod(directory, 0o555);
  };
  await makeReadOnly(sourcePack);
  const staging = path.join(root, 'promoted-staging');
  await mkdir(staging);
  const receipt = JSON.parse((await execFileAsync(process.execPath, [
    tool, 'promote', '--workspace', workspace, '--contract', targetContractFile,
    '--source-pack', sourcePack, '--staging', staging,
    '--fingerprint', source.dependencyManifestFingerprint,
    '--node-base-image', nodeBase, '--maven-base-image', mavenBase,
  ], { encoding: 'utf8', env })).stdout);
  assert.equal(receipt.dependencyManifestFingerprint, source.dependencyManifestFingerprint);
  const sourceManifest = JSON.parse(await readFile(path.join(sourcePack, 'manifest.json'), 'utf8'));
  const targetManifest = JSON.parse(await readFile(path.join(staging, 'manifest.json'), 'utf8'));
  assert.equal(targetManifest.toolchainImage, targetContract.toolchainImage);
  assert.equal(targetManifest.runnerRevision, targetContract.runnerRevision);
  assert.equal(targetManifest.promotedFromToolchainImage, sourceContract.toolchainImage);
  assert.equal(targetManifest.cacheCompatibilityDigest, sourceManifest.cacheCompatibilityDigest);
  assert.equal(targetManifest.packDigest, sourceManifest.packDigest);
  assert.equal(receipt.packDigest, sourceManifest.packDigest);
  assert.deepEqual(targetManifest.files, sourceManifest.files);
  assert.equal(await readFile(path.join(staging, 'm2', 'repository', 'example', 'dependency.jar'), 'utf8'), 'jar\n');

  const incompatibleStaging = path.join(root, 'incompatible-staging');
  await mkdir(incompatibleStaging);
  await assert.rejects(
    () => execFileAsync(process.execPath, [
      tool, 'promote', '--workspace', workspace, '--contract', targetContractFile,
      '--source-pack', sourcePack, '--staging', incompatibleStaging,
      '--fingerprint', source.dependencyManifestFingerprint,
      '--node-base-image', `node:24@sha256:${'e'.repeat(64)}`, '--maven-base-image', mavenBase,
    ], { encoding: 'utf8', env }),
    /not compatible/u,
  );
});

test('runner returns cache capability before execution and binds a passing receipt to the current source', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-run-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-verify';
  const workspace = await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  const lifecycle = dockerLifecycle({
    async onStart(container) {
      if (!container.createArgs.includes('-Dtest=ExampleTest')) return;
      const workspaceMount = container.createArgs.find((entry) => entry.includes('dst=/workspace') && !entry.includes('/.git'));
      const snapshotRoot = /src=([^,]+),dst=\/workspace/u.exec(workspaceMount)[1];
      const reportRoot = path.join(snapshotRoot, 'forge-server', 'forge-business', 'forge-business-core', 'target', 'surefire-reports');
      await mkdir(reportRoot, { recursive: true });
      await writeFile(path.join(reportRoot, 'TEST-ExampleTest.xml'), '<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>\n');
    },
    startResult: { stdout: 'BUILD SUCCESS\n' },
  });
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, bytes: result.stdout.length + result.stderr.length, truncated: false };
    }
    assert.equal(program, 'docker');
    return lifecycle.command(args);
  };
  const acceptanceSubmissions = [];
  const runner = new VerificationRunner({
    projectSlug: 'forge-base',
    taskspacesRoot: path.join(root, 'taskspaces'),
    contract: currentContract,
    command,
    acceptanceIssuerClient: async (route, body) => {
      acceptanceSubmissions.push({ route, body });
      return { receiptId: body.runnerReceipt.receiptId, status: body.runnerReceipt.status };
    },
  });
  const missing = await runner.capability(taskId, 'backend-test-class');
  assert.equal(missing.outcome, 'cache_miss');
  await publishCachePack(
    currentContract.cacheRoot,
    await inventoryWorkspace(workspace, currentContract.limits),
    currentContract,
  );
  const ready = await runner.capability(taskId, 'backend-test-class');
  assert.equal(ready.outcome, 'ready');
  assert.equal(ready.network.externalEgress, false);
  assert.deepEqual(ready.executor, {
    proven: true,
    dockerApiProven: true,
    toolchainImageProven: true,
    samePathBindProven: true,
    stateWriteProven: true,
    cleanupProven: true,
  });
  const probeCreate = lifecycle.calls.find((args) => args[0] === 'create');
  assert.ok(probeCreate.some((entry) => entry.includes('dst=/workspace,readonly')));
  assert.ok(probeCreate.some((entry) => entry.includes('dst=/verify-cache,readonly')));
  assert.deepEqual(lifecycle.calls.map((args) => args[0]), ['create', 'inspect', 'start', 'inspect', 'rm', 'ps']);
  const admission = await readyAdmission(runner, taskId, ['backend-test-class'], lifecycle);

  const acceptanceContractId = 'c'.repeat(64);
  const receipt = await runner.run(taskId, {
    action: 'run',
    profile: 'backend-test-class',
    selectors: { modules: ['forge-server/forge-business/forge-business-core'], tests: ['ExampleTest'] },
    idempotencyKey: 'verification-test-0001',
    admissionId: admission.admissionId,
  }, { acceptanceContractId });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.results.executed, 1);
  assert.equal(receipt.truth.verificationProven, true);
  assert.equal(receipt.truth.semanticCorrectnessProven, false);
  assert.equal(receipt.truth.databaseIntegrationProven, false);
  assert.equal(receipt.execution.externalEgress, false);
  const createCalls = lifecycle.calls.filter((args) => args[0] === 'create');
  assert.equal(createCalls.length, 1);
  assert.ok(createCalls.every((args) => args.includes('none') && args.includes('no-new-privileges:true')));
  assert.equal(createCalls[0].includes('--rm'), false);
  assert.ok(createCalls[0].includes('--entrypoint'));
  assert.ok(createCalls[0].includes('/usr/local/bin/maven-verification-exec'));
  assert.ok(createCalls[0].includes('MAVEN_OPTS=-Djansi.tmpdir=/tmp/forge-maven-jansi'));
  assert.ok(createCalls[0].includes('/tmp:rw,exec,nosuid,nodev,size=1g'));
  assert.equal(createCalls[0].some((entry) => /\/home\/node\/\.cache\/jansi|\/tmp\/jansi/u.test(entry)), false);
  assert.equal(receipt.execution.steps[0].cleanup.proven, true);
  assert.equal(acceptanceSubmissions.length, 1);
  assert.equal(acceptanceSubmissions[0].route, '/v1/verification');
  assert.equal(acceptanceSubmissions[0].body.contractId, acceptanceContractId);
  assert.equal(acceptanceSubmissions[0].body.runnerReceipt.receiptId, receipt.receiptId);
  const replay = await runner.run(taskId, {
    action: 'run',
    profile: 'backend-test-class',
    selectors: { modules: ['forge-server/forge-business/forge-business-core'], tests: ['ExampleTest'] },
    idempotencyKey: 'verification-test-0001',
    admissionId: admission.admissionId,
  }, { acceptanceContractId });
  assert.equal(replay.receiptId, receipt.receiptId);
  assert.equal(acceptanceSubmissions.length, 2, 'an uncertain caller retry must resubmit the same protected receipt idempotently');
  runner.acceptanceIssuerClient = async () => {
    const error = new Error('issuer unavailable');
    error.code = 'VERIFY_ACCEPTANCE_ISSUER_UNAVAILABLE';
    throw error;
  };
  await assert.rejects(
    () => runner.run(taskId, {
      action: 'run',
      profile: 'backend-test-class',
      selectors: { modules: ['forge-server/forge-business/forge-business-core'], tests: ['ExampleTest'] },
      idempotencyKey: 'verification-test-0001',
      admissionId: admission.admissionId,
    }, { acceptanceContractId }),
    (error) => error.code === 'VERIFY_ACCEPTANCE_ISSUER_UNAVAILABLE',
  );
  const lifecycleCommands = lifecycle.calls.map((args) => args[0]);
  assert.deepEqual(lifecycleCommands, ['create', 'inspect', 'start', 'inspect', 'rm', 'ps']);
  const containerId = receipt.execution.steps[0].cleanup.containerId;
  assert.equal(lifecycle.calls.find((args) => args[0] === 'start').at(-1), containerId);
  assert.equal(lifecycle.calls.find((args) => args[0] === 'rm').at(-1), containerId);
  const queried = await runner.receipt(taskId, receipt.receiptId);
  assert.equal(queried.freshness, 'current');
  await writeFile(path.join(workspace, 'README.md'), 'after receipt\n');
  assert.equal((await runner.receipt(taskId, receipt.receiptId)).freshness, 'stale');
  assert.match(await readFile(path.join(currentContract.stateRoot, 'receipts', taskId, `${receipt.receiptId}.json`), 'utf8'), /"verificationProven": true/u);
});

test('QUAL06 container backend outcomes follow reports without rewriting process facts', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-container-qual06-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-qual06';
  const workspace = await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  currentContract.profiles = [...VERIFY_PROFILE_NAMES];
  await publishCachePack(currentContract.cacheRoot, await inventoryWorkspace(workspace, currentContract.limits), currentContract);
  let scenario;
  const lifecycleOptions = {
    async onStart(container) {
      if (!scenario?.xml || !container.createArgs.includes('test')) return;
      const mount = container.createArgs.find(entry => entry.includes('dst=/workspace') && !entry.includes('/.git'));
      const snapshotRoot = /src=([^,]+),dst=\/workspace/u.exec(mount)[1];
      const reports = path.join(snapshotRoot, 'forge-server', 'target', 'surefire-reports');
      await mkdir(reports, { recursive: true });
      await writeFile(path.join(reports, 'TEST-ExampleTest.xml'), scenario.xml);
    },
  };
  const lifecycle = dockerLifecycle(lifecycleOptions);
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  const runner = new VerificationRunner({ projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command });
  const admission = await readyAdmission(runner, taskId, [
    'backend-red-test', 'backend-module-compile', 'backend-module-test', 'backend-test-class',
  ], lifecycle);
  const failed = '<testsuite tests="1" failures="1" errors="0" skipped="0"></testsuite>';
  const cases = [
    { name: 'passing with a skipped case', xml: '<testsuite tests="2" failures="0" errors="0" skipped="1"></testsuite>', status: 'passed', passed: 1, skipped: 1 },
    { name: 'module failure with exit zero', profile: 'backend-module-test', xml: failed, status: 'failed', failed: 1 },
    { name: 'test error with exit zero', xml: '<testsuite tests="1" failures="0" errors="1" skipped="0"></testsuite>', status: 'failed', failed: 1 },
    { name: 'missing report', status: 'failed-zero-tests' },
    { name: 'all cases skipped', xml: '<testsuite tests="2" failures="0" errors="0" skipped="2"></testsuite>', status: 'failed-zero-tests', skipped: 2 },
    { name: 'compile only', profile: 'backend-module-compile', status: 'passed' },
    { name: 'ignored red failure', profile: 'backend-red-test', xml: failed, status: 'failed', failed: 1, redMatched: false },
    { name: 'actual red failure', profile: 'backend-red-test', xml: failed, exitCode: 1, status: 'failed', failed: 1, redMatched: true },
  ];
  for (const [index, item] of cases.entries()) await t.test(item.name, async () => {
    scenario = item;
    lifecycleOptions.startResult = { exitCode: item.exitCode ?? 0 };
    const profile = item.profile ?? 'backend-test-class';
    const selectors = { modules: ['forge-server/forge-business/forge-business-core'],
      ...(['backend-test-class', 'backend-red-test'].includes(profile) ? { tests: ['ExampleTest#checks'] } : {}) };
    const receipt = await runner.run(taskId, { action: 'run', profile, selectors,
      idempotencyKey: `qual06-container-case-${index}`, admissionId: admission.admissionId });
    assert.equal(receipt.status, item.status);
    assert.equal(receipt.execution.exitCode, item.exitCode ?? 0);
    assert.equal(receipt.truth.verificationProven, item.status === 'passed');
    assert.equal(receipt.results.failed, item.failed ?? 0);
    assert.equal(receipt.results.passed, item.passed ?? 0);
    assert.equal(receipt.results.skipped, item.skipped ?? 0);
    if (item.redMatched !== undefined) assert.equal(receipt.redExpectation.matched, item.redMatched);
    if (item.failed) assert.match(receipt.logs.diagnosticSummary, /test report contains failed tests/u);
  });
});

test('RED profiles emit a strict failure envelope and module-wide failures remain positive verification evidence only', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-red-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-red';
  const workspace = await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycleOptions = {
    async onStart(container) {
      if (!container.createArgs.includes('-Pdev,enable-tests')) return;
      const workspaceMount = container.createArgs.find((entry) => entry.includes('dst=/workspace') && !entry.includes('/.git'));
      const snapshotRoot = /src=([^,]+),dst=\/workspace/u.exec(workspaceMount)[1];
      const reportRoot = path.join(snapshotRoot, 'forge-server', 'forge-business', 'forge-business-core', 'target', 'surefire-reports');
      await mkdir(reportRoot, { recursive: true });
      await writeFile(path.join(reportRoot, 'TEST-ExampleTest.xml'), '<testsuite tests="1" failures="1" errors="0" skipped="0"></testsuite>\n');
    },
  };
  const lifecycle = dockerLifecycle(lifecycleOptions);
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command,
  });
  const admission = await readyAdmission(
    runner, taskId, ['backend-red-test', 'backend-module-test'], lifecycle,
  );
  lifecycleOptions.startResult = { exitCode: 1, stderr: 'TEST FAILURE\n' };

  const redReceipt = await runner.run(taskId, {
    action: 'run', profile: 'backend-red-test',
    selectors: { modules: ['forge-server/forge-business/forge-business-core'], tests: ['ExampleTest#failsFirst'] },
    idempotencyKey: 'red-exact-test-0001', admissionId: admission.admissionId,
  });
  assert.equal(redReceipt.status, 'failed');
  assert.equal(redReceipt.truth.verificationProven, false);
  assert.deepEqual(redReceipt.redExpectation, {
    schemaVersion: 1,
    expectationType: 'selected-test-must-fail',
    profile: 'backend-red-test',
    selectorsSha256: redReceipt.request.selectorsSha256,
    matched: true,
    failureKind: 'test-report',
  });

  const moduleReceipt = await runner.run(taskId, {
    action: 'run', profile: 'backend-module-test',
    selectors: { modules: ['forge-server/forge-business/forge-business-core'] },
    idempotencyKey: 'module-wide-failure-0001', admissionId: admission.admissionId,
  });
  assert.equal(moduleReceipt.status, 'failed');
  assert.equal(Object.hasOwn(moduleReceipt, 'redExpectation'), false);

  lifecycleOptions.onStart = undefined;
  lifecycleOptions.startResult = undefined;
  const staleTaskId = 'task-red-stale';
  const staleWorkspace = await createTaskspace(root, staleTaskId);
  const staleReportRoot = path.join(
    staleWorkspace, 'forge-server', 'forge-business', 'forge-business-core', 'target', 'surefire-reports',
  );
  await mkdir(staleReportRoot, { recursive: true });
  await writeFile(
    path.join(staleReportRoot, 'TEST-ExampleTest.xml'),
    '<testsuite tests="1" failures="1" errors="0" skipped="0"></testsuite>\n',
  );
  const staleAdmission = await readyAdmission(runner, staleTaskId, ['backend-red-test'], lifecycle);
  lifecycleOptions.startResult = { exitCode: 1, stderr: 'INFRASTRUCTURE FAILURE BEFORE TEST\n' };
  const staleReceipt = await runner.run(staleTaskId, {
    action: 'run', profile: 'backend-red-test',
    selectors: { modules: ['forge-server/forge-business/forge-business-core'], tests: ['ExampleTest#failsFirst'] },
    idempotencyKey: 'red-stale-report-0001', admissionId: staleAdmission.admissionId,
  });
  assert.equal(staleReceipt.status, 'failed');
  assert.equal(staleReceipt.results.zeroTestsRejected, false);
  assert.deepEqual(staleReceipt.redExpectation, {
    schemaVersion: 1,
    expectationType: 'selected-test-must-fail',
    profile: 'backend-red-test',
    selectorsSha256: staleReceipt.request.selectorsSha256,
    matched: false,
    failureKind: 'unmatched',
  });
});

test('frontend admin lint executes through the immutable pnpm cache without requiring a test count', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-lint-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-lint';
  const workspace = await createTaskspace(root, taskId);
  await mkdir(path.join(workspace, 'forge-admin-ui/src'), { recursive: true });
  await writeFile(path.join(workspace, 'forge-admin-ui/src/changed.vue'), '<template><div>changed</div></template>');
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle({ startResult: { stdout: 'LINT PASS\n' } });
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, bytes: result.stdout.length + result.stderr.length, truncated: false };
    }
    return lifecycle.command(args);
  };
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command,
  });
  const admission = await readyAdmission(runner, taskId, ['frontend-admin-lint'], lifecycle);
  const receipt = await runner.run(taskId, {
    action: 'run', profile: 'frontend-admin-lint', selectors: {}, idempotencyKey: 'frontend-lint-test-0001',
    admissionId: admission.admissionId,
  });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.results.executed, 0);
  assert.equal(receipt.results.zeroTestsRejected, false);
  assert.equal(receipt.truth.verificationProven, true);
  const createCalls = lifecycle.calls.filter((args) => args[0] === 'create');
  assert.equal(createCalls.length, 2);
  assert.ok(createCalls.every((args) => args.includes('none') && args.some((entry) => entry.includes('dst=/verify-cache'))));
  assert.deepEqual(receipt.execution.steps.map((step) => step.argv), [
    ['corepack', 'pnpm', '--dir', 'forge-admin-ui', 'install', '--offline', '--frozen-lockfile', '--store-dir', '/verify-cache/pnpm/store'],
    ['pnpm', 'exec', 'eslint', 'src/changed.vue', '--max-warnings=0', ...LINT_FORMAT_ARGS],
  ]);
});

test('container changed-file lint skips the initial empty scope and retains committed task changes', async (t) => {
  for (const scenario of ['initial-empty', 'committed-change']) {
    await t.test(scenario, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'forge-container-changed-lint-'));
      t.after(async () => { await makeTreeOwnerWritable(root); await rm(root, { recursive: true, force: true }); });
      const taskId = 'task-lint';
      const workspace = await createTaskspace(root, taskId);
      if (scenario === 'committed-change') {
        await mkdir(path.join(workspace, 'forge-admin-ui/src'), { recursive: true });
        await writeFile(path.join(workspace, 'forge-admin-ui/src/committed.js'), 'export const value = 1;\n');
        await git(workspace, 'add', '.');
        await git(workspace, 'commit', '-qm', 'current task source');
      }
      const currentContract = contract('forge-base', root);
      const source = await inventoryWorkspace(workspace, currentContract.limits);
      await publishCachePack(currentContract.cacheRoot, source, currentContract);
      const lifecycle = dockerLifecycle();
      const command = async (program, args, options = {}) => {
        if (program !== 'git') return lifecycle.command(args);
        const result = await execFileAsync(program, args, { cwd: options.cwd, encoding: 'utf8' });
        return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr,
          bytes: Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), truncated: false };
      };
      const runner = new VerificationRunner({ projectSlug: 'forge-base',
        taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command });
      const admission = await readyAdmission(runner, taskId, ['frontend-admin-lint'], lifecycle);
      const receipt = await runner.run(taskId, { action: 'run', profile: 'frontend-admin-lint', selectors: {},
        idempotencyKey: `changed-lint-${scenario}`, admissionId: admission.admissionId });
      assert.equal(receipt.status, 'passed');
      const steps = receipt.execution.steps.map((step) => step.argv);
      assert.ok(steps.every((argv) => !argv.includes('.')), 'default lint never scans the project root');
      if (scenario === 'initial-empty') {
        assert.equal(steps.length, 1);
        assert.deepEqual(steps[0].slice(0, 2), ['node', '-e']);
        assert.ok(!steps[0].includes('install') && !steps[0].includes('eslint'));
      } else {
        assert.deepEqual(steps[1], ['pnpm', 'exec', 'eslint', 'src/committed.js', '--max-warnings=0', ...LINT_FORMAT_ARGS]);
      }
    });
  }
});

test('cache compatibility alone cannot produce ready when the executor probe fails', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-capability-executor-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-capability';
  const workspace = await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle({ createResult: { exitCode: 125, stderr: 'No such image\n' } });
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command,
  });
  const capability = await runner.capability(taskId, 'backend-module-test');
  assert.equal(capability.outcome, 'executor_unavailable');
  assert.equal(capability.reasonCode, 'VERIFY_SANDBOX_CREATE_FAILED');
  assert.equal(capability.cache.compatible, true);
  assert.equal(capability.executor.proven, false);
  assert.deepEqual(lifecycle.calls.map((args) => args[0]), ['create']);
});

test('batch admission probes once, survives ordinary source edits, and rejects profile or dependency drift', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-admission-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-admission';
  const workspace = await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle();
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'),
    contract: currentContract, command, runnerBootId: '12345678-1234-1234-1234-123456789abc',
  });
  const admission = await runner.admit(taskId, ['governance', 'frontend-admin-lint', 'full-regression']);
  assert.equal(admission.outcome, 'ready');
  assert.equal(admission.runner.bootId, '12345678-1234-1234-1234-123456789abc');
  assert.equal(admission.runner.revision, currentContract.runnerRevision);
  assert.equal(admission.source.dependencyManifestFingerprint, source.dependencyManifestFingerprint);
  assert.equal(admission.cache.packDigest.length, 64);
  assert.ok(Date.parse(admission.expiresAt) > Date.parse(admission.issuedAt));
  assert.deepEqual(lifecycle.calls.map((args) => args[0]), ['create', 'inspect', 'start', 'inspect', 'rm', 'ps']);
  lifecycle.calls.length = 0;

  const narrowedAdmission = await runner.admit(taskId, ['frontend-admin-lint', 'full-regression']);
  assert.equal(narrowedAdmission.outcome, 'ready');
  assert.notEqual(narrowedAdmission.admissionId, admission.admissionId);
  assert.deepEqual(narrowedAdmission.profiles, ['frontend-admin-lint', 'full-regression']);
  assert.deepEqual(lifecycle.calls, [], 'a live task capability lease must not repeat the Docker executor probe');
  lifecycle.calls.length = 0;

  await assert.rejects(
    () => runner.run(taskId, {
      action: 'run', profile: 'frontend-admin-test', selectors: {},
      idempotencyKey: 'admission-profile-0001', admissionId: admission.admissionId,
    }),
    (error) => error.code === 'VERIFY_ADMISSION_PROFILE_MISMATCH',
  );
  await writeFile(path.join(workspace, 'README.md'), 'ordinary source mutation\n');
  const ordinary = await runner.run(taskId, {
    action: 'run', profile: 'governance', selectors: {},
    idempotencyKey: 'admission-source-0001', admissionId: admission.admissionId,
  });
  assert.equal(ordinary.status, 'passed');
  assert.equal(ordinary.request.admissionId, admission.admissionId);

  await writeFile(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n');
  await assert.rejects(
    () => runner.run(taskId, {
      action: 'run', profile: 'full-regression', selectors: {},
      idempotencyKey: 'admission-dependency-0001', admissionId: admission.admissionId,
    }),
    (error) => error.code === 'VERIFY_ADMISSION_DEPENDENCY_CHANGED',
  );
});

test('serial profiles reuse one verified immutable pack and one TaskSpace execution cache while drift fails closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-cache-reuse-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-cache-reuse';
  const workspace = await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  const published = await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle();
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  let fullVerifyCount = 0;
  let executionCachePrepareCount = 0;
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command,
    runnerBootId: '12345678-1234-1234-1234-123456789abc',
    verifyCachePack: async (...args) => {
      fullVerifyCount += 1;
      return verifyCachePack(...args);
    },
    copyCachePack: async (cache, destination) => {
      executionCachePrepareCount += 1;
      const relative = 'm2/repository/example/example.jar';
      await mkdir(path.join(destination, 'm2', 'repository', 'example'), { recursive: true });
      await copyFile(path.join(cache.packRoot, relative), path.join(destination, relative));
    },
  });
  const admission = await readyAdmission(runner, taskId, ['governance'], lifecycle);
  for (let index = 0; index < 15; index += 1) {
    const result = await runner.run(taskId, {
      action: 'run', profile: 'governance', selectors: {},
      idempotencyKey: `cache-reuse-${String(index).padStart(4, '0')}`,
      admissionId: admission.admissionId,
    });
    assert.equal(result.status, 'passed');
  }
  assert.equal(fullVerifyCount, 1, 'the immutable pack must be fully verified only at admission');
  assert.equal(executionCachePrepareCount, 1, 'the TaskSpace must prepare one writable cache for serial profiles');
  const cacheMounts = lifecycle.calls
    .filter((args) => args[0] === 'create')
    .map((args) => args[args.findIndex((value, index) => value === '--mount'
      && args[index + 1]?.includes('dst=/verify-cache')) + 1]);
  assert.equal(cacheMounts.length, 15);
  assert.ok(cacheMounts.every((mount) => mount.includes(`${path.join('execution-caches', taskId)}${path.sep}`)));
  assert.equal(cacheMounts.some((mount) => mount.includes(published.pack)), false, 'models must not receive the authority cache pack');

  const cacheFile = path.join(published.pack, 'm2', 'repository', 'example', 'example.jar');
  await chmod(cacheFile, 0o644);
  await writeFile(cacheFile, 'authority-pack-drift\n');
  await chmod(cacheFile, 0o444);
  await assert.rejects(
    () => runner.run(taskId, {
      action: 'run', profile: 'governance', selectors: {},
      idempotencyKey: 'cache-reuse-drift-0001', admissionId: admission.admissionId,
    }),
    (error) => error.code === 'VERIFY_ADMISSION_CACHE_CHANGED',
  );
  assert.equal(fullVerifyCount, 1, 'metadata drift must fail before another full pack read');
  assert.equal(executionCachePrepareCount, 1);
  assert.equal((await readFile(cacheFile, 'utf8')).trim(), 'authority-pack-drift');

  await chmod(cacheFile, 0o644);
  await writeFile(cacheFile, 'immutable-cache-fixture\n');
  await chmod(cacheFile, 0o444);
  const refreshedAdmission = await readyAdmission(runner, taskId, ['governance'], lifecycle);
  await writeFile(path.join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 10\n');
  await assert.rejects(
    () => runner.run(taskId, {
      action: 'run', profile: 'governance', selectors: {},
      idempotencyKey: 'cache-reuse-task-drift-0001', admissionId: refreshedAdmission.admissionId,
    }),
    (error) => error.code === 'VERIFY_ADMISSION_DEPENDENCY_CHANGED',
  );
});

test('concurrent profile admissions single-flight the immutable verification and TaskSpace cache preparation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-cache-flights-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-cache-flights';
  const workspace = await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle();
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  let fullVerifyCount = 0;
  let executionCachePrepareCount = 0;
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command,
    runnerBootId: '12345678-1234-1234-1234-123456789abc',
    verifyCachePack: async (...args) => {
      fullVerifyCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return verifyCachePack(...args);
    },
    copyCachePack: async (cache, destination) => {
      executionCachePrepareCount += 1;
      const relative = 'm2/repository/example/example.jar';
      await mkdir(path.join(destination, 'm2', 'repository', 'example'), { recursive: true });
      await copyFile(path.join(cache.packRoot, relative), path.join(destination, relative));
    },
  });
  const [governance, lint] = await Promise.all([
    runner.admit(taskId, ['governance']),
    runner.admit(taskId, ['frontend-admin-lint']),
  ]);
  assert.equal(governance.outcome, 'ready');
  assert.equal(lint.outcome, 'ready');
  assert.notEqual(governance.admissionId, lint.admissionId);
  assert.equal(fullVerifyCount, 1);
  assert.equal(executionCachePrepareCount, 1);
});

test('failed execution-cache copy leaves no ready root and clears its flight for a safe retry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-cache-copy-retry-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-cache-copy-retry';
  const runnerBootId = '12345678-1234-1234-1234-123456789abc';
  const workspace = await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  const published = await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle();
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  let fullVerifyCount = 0;
  let copyAttempts = 0;
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command, runnerBootId,
    verifyCachePack: async (...args) => {
      fullVerifyCount += 1;
      return verifyCachePack(...args);
    },
    copyCachePack: async (cache, destination) => {
      copyAttempts += 1;
      await mkdir(destination, { recursive: false });
      if (copyAttempts === 1) {
        await writeFile(path.join(destination, 'partial'), 'not-ready\n');
        throw new Error('simulated cache copy failure');
      }
      const relative = 'm2/repository/example/example.jar';
      await mkdir(path.join(destination, 'm2', 'repository', 'example'), { recursive: true });
      await copyFile(path.join(cache.packRoot, relative), path.join(destination, relative));
    },
  });
  const failed = await runner.admit(taskId, ['governance']);
  assert.equal(failed.outcome, 'executor_unavailable');
  const readyRoot = path.join(
    currentContract.stateRoot, 'execution-caches', taskId, runnerBootId,
    `${source.dependencyManifestFingerprint}-${published.packDigest}`,
  );
  await assert.rejects(() => lstat(readyRoot), (error) => error.code === 'ENOENT');
  const retried = await runner.admit(taskId, ['governance']);
  assert.equal(retried.outcome, 'ready');
  assert.equal(fullVerifyCount, 1);
  assert.equal(copyAttempts, 2);
  assert.equal((await lstat(readyRoot)).isDirectory(), true);
});

test('execution admission expires and cannot be replayed after its short lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-admission-expiry-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-expiry';
  const workspace = await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle();
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  let now = 1_000_000;
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract,
    command, admissionTtlMs: 30_000, now: () => now,
  });
  const admission = await readyAdmission(runner, taskId, ['governance'], lifecycle);
  now += 30_000;
  await assert.rejects(
    () => runner.run(taskId, {
      action: 'run', profile: 'governance', selectors: {},
      idempotencyKey: 'admission-expiry-0001', admissionId: admission.admissionId,
    }),
    (error) => error.code === 'VERIFY_ADMISSION_EXPIRED' && error.retryable === true,
  );
});

test('execution admission refreshes a capability at the critical TTL margin and rejects the old lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-admission-margin-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-margin';
  const workspace = await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle();
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  let now = 1_000_000;
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract,
    command, admissionTtlMs: 30_000, admissionRefreshMarginMs: 10_000,
    admissionMinUsableMs: 5_000, now: () => now,
  });
  const first = await readyAdmission(runner, taskId, ['governance'], lifecycle);
  now += 20_000;
  const refreshed = await runner.admit(taskId, ['governance']);
  assert.equal(refreshed.outcome, 'ready');
  assert.notEqual(refreshed.admissionId, first.admissionId);
  assert.equal(Date.parse(refreshed.expiresAt) - now, 30_000);
  assert.deepEqual(lifecycle.calls.map((args) => args[0]), ['create', 'inspect', 'start', 'inspect', 'rm', 'ps']);
  lifecycle.calls.length = 0;
  await assert.rejects(
    () => runner.run(taskId, {
      action: 'run', profile: 'governance', selectors: {},
      idempotencyKey: 'admission-margin-0001', admissionId: first.admissionId,
    }),
    (error) => error.code === 'VERIFY_ADMISSION_REFRESH_REQUIRED' && error.retryable === true,
  );
  assert.deepEqual(lifecycle.calls, []);
});

test('new execution admission fails closed when the clock leaves less than its minimum usable lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-admission-minimum-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskId = 'task-minimum';
  const workspace = await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle();
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  const moments = [1_000_000, 1_000_000, 1_026_000];
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract,
    command, admissionTtlMs: 30_000, admissionRefreshMarginMs: 10_000,
    admissionMinUsableMs: 5_000, now: () => moments.shift() ?? 1_026_000,
  });
  const receipt = await runner.admit(taskId, ['governance']);
  assert.equal(receipt.outcome, 'executor_unavailable');
  assert.equal(receipt.reasonCode, 'VERIFY_ADMISSION_LEASE_TOO_SHORT');
  assert.equal(receipt.admissionId, null);
  assert.equal(runner.admissions.size, 0);
  assert.equal(runner.admissionCapabilities.size, 0);
});

test('execution admission state is bounded and identical concurrent requests are single-flight', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-admission-bounds-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const taskIds = ['task-bound-a', 'task-bound-b', 'task-bound-c'];
  for (const taskId of taskIds) await createTaskspace(root, taskId);
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(path.join(root, 'taskspaces', taskIds[0], 'workspace'), currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle({ onStart: async () => new Promise((resolve) => setTimeout(resolve, 40)) });
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  let now = 1_000_000;
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract,
    command, now: () => now, maxAdmissions: 2, maxAdmissionCapabilities: 2,
  });
  const originalSource = runner.source.bind(runner);
  let sourceCalls = 0;
  let releaseSecondSource;
  const releaseSecondSourcePromise = new Promise((resolve) => { releaseSecondSource = resolve; });
  runner.source = async (...args) => {
    sourceCalls += 1;
    if (sourceCalls === 2) await releaseSecondSourcePromise;
    return originalSource(...args);
  };
  const firstAdmission = runner.admit(taskIds[0], ['governance']);
  const secondAdmission = runner.admit(taskIds[0], ['governance']);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    () => runner.admit(taskIds[0], ['governance'], { signal: cancelled.signal }),
    (error) => error.code === 'VERIFY_REQUEST_CANCELLED',
  );
  let concurrentOne;
  try {
    concurrentOne = await firstAdmission;
  } finally {
    releaseSecondSource();
  }
  const concurrentTwo = await secondAdmission;
  assert.equal(concurrentOne.admissionId, concurrentTwo.admissionId);
  assert.equal(sourceCalls, 1);
  assert.equal(lifecycle.calls.filter((args) => args[0] === 'create').length, 1);
  await writeFile(path.join(root, 'taskspaces', taskIds[0], 'workspace', 'README.md'), 'changed after admission\n');
  const changedSource = await runner.admit(taskIds[0], ['governance']);
  assert.notEqual(changedSource.admissionId, concurrentOne.admissionId);
  assert.notEqual(changedSource.source.workspaceFingerprint, concurrentOne.source.workspaceFingerprint);
  lifecycle.calls.length = 0;
  now += 1;
  await readyAdmission(runner, taskIds[1], ['governance'], lifecycle);
  now += 1;
  await readyAdmission(runner, taskIds[2], ['governance'], lifecycle);
  assert.equal(runner.admissions.size, 2);
  assert.equal(runner.admissionCapabilities.size, 2);
  assert.equal(runner.admissions.has(concurrentOne.admissionId), false);
  assert.equal(runner.admissionCapabilities.has(taskIds[0]), false);
});

test('Runner cancels an in-flight action when its controlling HTTP client disconnects', async (t) => {
  let observeAbort;
  const aborted = new Promise((resolve) => { observeAbort = resolve; });
  const runner = {
    async execute(raw, options) {
      assert.equal(raw.action, 'admit');
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          observeAbort();
          const error = new Error('cancelled');
          error.code = 'VERIFY_REQUEST_CANCELLED';
          reject(error);
        }, { once: true });
      });
    },
  };
  const server = createVerificationRunnerServer(runner);
  t.after(() => server.close());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const payload = Buffer.from(JSON.stringify({ taskId: 'task-cancel', action: 'admit', profiles: ['governance'] }));
  const request = http.request({
    host: '127.0.0.1', port: address.port, path: '/v1/actions', method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': payload.length },
  });
  request.on('error', () => {});
  request.end(payload);
  await new Promise((resolve) => setTimeout(resolve, 25));
  request.destroy();
  await Promise.race([
    aborted,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('Runner did not observe client cancellation.')), 1_000)),
  ]);
});

test('execution admission rejects cross-TaskSpace use, safety hold, and cache drift before execution', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-admission-guards-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root, 'task-admission-owner');
  await createTaskspace(root, 'task-admission-other');
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  const published = await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle();
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command,
  });
  const owned = await readyAdmission(runner, 'task-admission-owner', ['governance'], lifecycle);
  await assert.rejects(
    () => runner.run('task-admission-other', {
      action: 'run', profile: 'governance', selectors: {},
      idempotencyKey: 'admission-owner-0001', admissionId: owned.admissionId,
    }),
    (error) => error.code === 'VERIFY_ADMISSION_IDENTITY_MISMATCH',
  );
  assert.deepEqual(lifecycle.calls, []);

  const guarded = await readyAdmission(runner, 'task-admission-owner', ['governance'], lifecycle);
  runner.safetyHold = { schemaVersion: 1, code: 'VERIFY_SANDBOX_CLEANUP_UNPROVEN' };
  await assert.rejects(
    () => runner.run('task-admission-owner', {
      action: 'run', profile: 'governance', selectors: {},
      idempotencyKey: 'admission-hold-0001', admissionId: guarded.admissionId,
    }),
    (error) => error.code === 'VERIFY_RUNNER_SAFETY_HOLD',
  );
  assert.deepEqual(lifecycle.calls, []);

  runner.safetyHold = null;
  const mutatedCacheFile = path.join(published.pack, 'm2', 'repository', 'example', 'example.jar');
  await chmod(mutatedCacheFile, 0o644);
  await writeFile(mutatedCacheFile, 'mutated-cache\n');
  await chmod(mutatedCacheFile, 0o444);
  await assert.rejects(
    () => runner.run('task-admission-owner', {
      action: 'run', profile: 'governance', selectors: {},
      idempotencyKey: 'admission-cache-0001', admissionId: guarded.admissionId,
    }),
    (error) => error.code === 'VERIFY_ADMISSION_CACHE_CHANGED',
  );
  assert.deepEqual(lifecycle.calls, []);
});

test('runner reserves a TaskSpace before async preparation and isolates receipts by TaskSpace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-concurrency-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root, 'task-one');
  await createTaskspace(root, 'task-two');
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycle = dockerLifecycle();
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, bytes: result.stdout.length + result.stderr.length, truncated: false };
    }
    return lifecycle.command(args);
  };
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command,
  });
  const admission = await readyAdmission(runner, 'task-one', ['governance'], lifecycle);
  const first = runner.run('task-one', {
    action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'concurrency-test-0001',
    admissionId: admission.admissionId,
  });
  await assert.rejects(
    () => runner.run('task-one', {
      action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'concurrency-test-0002',
      admissionId: admission.admissionId,
    }),
    (error) => error.code === 'VERIFY_TASK_BUSY',
  );
  const receipt = await first;
  assert.equal(receipt.status, 'passed');
  await assert.rejects(
    () => runner.receipt('task-two', receipt.receiptId),
    (error) => error.code === 'VERIFY_RECEIPT_NOT_FOUND',
  );
});

test('timed-out sandbox execution returns a failed receipt when ID-bound cleanup is proven', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-timeout-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root, 'task-timeout');
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycleOptions = {};
  const lifecycle = dockerLifecycle(lifecycleOptions);
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, bytes: result.stdout.length + result.stderr.length, truncated: false };
    }
    return lifecycle.command(args);
  };
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command,
  });
  const admission = await readyAdmission(runner, 'task-timeout', ['governance'], lifecycle);
  lifecycleOptions.startResult = { exitCode: null, signal: 'SIGTERM', timedOut: true, stderr: 'timeout\n' };
  const receipt = await runner.run('task-timeout', {
    action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'timeout-test-0001',
    admissionId: admission.admissionId,
  });
  assert.equal(receipt.status, 'timed-out');
  assert.equal(receipt.truth.executionProven, true);
  assert.equal(receipt.truth.verificationProven, false);
  assert.equal(receipt.execution.steps[0].timedOut, true);
  assert.equal(receipt.execution.steps[0].transportUncertain, true);
  assert.equal(receipt.execution.steps[0].cleanup.proven, true);
  assert.deepEqual(lifecycle.calls.map((args) => args[0]), ['create', 'inspect', 'start', 'inspect', 'rm', 'ps']);
  await assert.rejects(
    () => readFile(path.join(currentContract.stateRoot, 'sandbox-safety-hold.json'), 'utf8'),
    (error) => error.code === 'ENOENT',
  );
  await assert.rejects(
    () => readFile(path.join(currentContract.stateRoot, 'jobs', `task-timeout-${receipt.jobId}`, 'workspace', 'README.md'), 'utf8'),
    (error) => error.code === 'ENOENT',
  );
});

test('sandbox name collision fails closed without deleting the colliding container', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-collision-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root, 'task-collision');
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycleOptions = {};
  const lifecycle = dockerLifecycle(lifecycleOptions);
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command,
  });
  const admission = await readyAdmission(runner, 'task-collision', ['governance'], lifecycle);
  lifecycleOptions.createResult = { exitCode: 125, stderr: 'Conflict. The container name is already in use.\n' };
  await assert.rejects(
    () => runner.run('task-collision', {
      action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'collision-test-0001',
      admissionId: admission.admissionId,
    }),
    (error) => error.code === 'VERIFY_SANDBOX_NAME_COLLISION',
  );
  assert.deepEqual(lifecycle.calls.map((args) => args[0]), ['create']);
  await assert.rejects(
    () => readFile(path.join(currentContract.stateRoot, 'sandbox-safety-hold.json'), 'utf8'),
    (error) => error.code === 'ENOENT',
  );
});

test('sandbox ownership mismatch is never deleted and places the Runner on safety hold', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-owner-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root, 'task-owner');
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycleOptions = {};
  const lifecycle = dockerLifecycle(lifecycleOptions);
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command,
  });
  const admission = await readyAdmission(runner, 'task-owner', ['governance'], lifecycle);
  lifecycleOptions.ownershipMismatch = true;
  await assert.rejects(
    () => runner.run('task-owner', {
      action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'owner-test-0001',
      admissionId: admission.admissionId,
    }),
    (error) => error.code === 'VERIFY_SANDBOX_CLEANUP_UNPROVEN',
  );
  assert.deepEqual(lifecycle.calls.map((args) => args[0]), ['create', 'inspect']);
  const hold = JSON.parse(await readFile(path.join(currentContract.stateRoot, 'sandbox-safety-hold.json'), 'utf8'));
  assert.equal(hold.reason, 'created-inspect-ownership-mismatch');
});

test('sandbox removal without an empty ID inventory is cleanup-unproven', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-verify-remove-proof-'));
  t.after(async () => {
    await makeTreeOwnerWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await createTaskspace(root, 'task-remove-proof');
  const currentContract = contract('forge-base', root);
  const source = await inventoryWorkspace(workspace, currentContract.limits);
  await publishCachePack(currentContract.cacheRoot, source, currentContract);
  const lifecycleOptions = {};
  const lifecycle = dockerLifecycle(lifecycleOptions);
  const command = async (program, args, options = {}) => {
    if (program === 'git') {
      const result = await execFileAsync(program, args, { cwd: options.cwd, env: { ...process.env, ...(options.env ?? {}) }, encoding: 'utf8' });
      return processResult({ stdout: result.stdout, stderr: result.stderr });
    }
    return lifecycle.command(args);
  };
  const runner = new VerificationRunner({
    projectSlug: 'forge-base', taskspacesRoot: path.join(root, 'taskspaces'), contract: currentContract, command,
  });
  const admission = await readyAdmission(runner, 'task-remove-proof', ['governance'], lifecycle);
  lifecycleOptions.proofResult = { stdout: `${'f'.repeat(64)}\n` };
  await assert.rejects(
    () => runner.run('task-remove-proof', {
      action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'remove-proof-test-0001',
      admissionId: admission.admissionId,
    }),
    (error) => error.code === 'VERIFY_SANDBOX_CLEANUP_UNPROVEN',
  );
  assert.deepEqual(lifecycle.calls.map((args) => args[0]), ['create', 'inspect', 'start', 'inspect', 'rm', 'ps']);
  const hold = JSON.parse(await readFile(path.join(currentContract.stateRoot, 'sandbox-safety-hold.json'), 'utf8'));
  assert.equal(hold.reason, 'remove-proof-failed');
});


test('H5 focused CLI transmits exact Node selectors and rejects empty unsafe mixed or over-limit requests', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-h5-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const token = path.join(root, 'token'); await writeFile(token, 'a'.repeat(48));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    requests.push(JSON.parse(Buffer.concat(chunks))); res.end(JSON.stringify({ ok: true, result: { status: 'observed' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ...process.env, FORGE_TASKSPACE_TOKEN_FILE: token, FORGE_TASKSPACE_BROKER_URL: `http://127.0.0.1:${server.address().port}` };
  const base = [forgeVerifyClient, 'run', '--profile', 'frontend-h5-test', '--admission-id', '123e4567-e89b-12d3-a456-426614174000', '--idempotency-key', 'h5-cli-case'];
  const file = 'forge-h5-ui/src/utils/__tests__/display.test.js';
  await execFileAsync(process.execPath, [...base, '--test-file', file], { env });
  assert.deepEqual(requests[0].selectors, { testFiles: [file] });
  assert.equal(requests[0].profile, 'frontend-h5-test');
  for (const args of [[], ['--test-file', file, '--test-file', file], ['--test-file', 'forge-admin-ui/src/display.test.js'],
    ['--test-file', 'forge-h5-ui/src/../display.test.js'], ['--test-file', 'forge-h5-ui/src/*.test.js'],
    ['--test-file', 'forge-h5-ui/src/display.test.ts'], ['--test-file', file, '--module', 'forge-server/module'],
    Array.from({length:33},(_,i)=>['--test-file',`forge-h5-ui/src/test${i}.test.js`]).flat()]) {
    await assert.rejects(execFileAsync(process.execPath, [...base, ...args], { env }));
  }
  assert.equal(requests.length, 1);
});
