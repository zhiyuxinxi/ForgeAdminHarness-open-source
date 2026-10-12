import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cancelProtectedHeadlessRecoveryBeforeIngress,
  executeProtectedHeadlessRecovery,
  executeProtectedHeadlessRecoveryWithFailureReceipt,
  readCompletePinnedDshSession,
  readCompletePinnedDshSessionHistory,
  readPinnedDshConversationHistory,
  reconcileCompletePinnedDshSession,
  reconcileProtectedHeadlessRecovery,
  verifyProtectedRecoveryMaintenance,
  waitForProtectedExecutionConsumption,
} from '../docker/harness/forge-recover-headless-execution.mjs';
import { sha256 } from '../docker/harness/forge-execution-context.mjs';

const sessionId = '948840e7-2ba5-4f40-9c07-8028630665e8';
const targetRpcId = '556e0879-a0e0-4e3a-9f36-f8d8057fc760';
const operationId = '11111111-1111-4111-8111-111111111111';
const textDigest = 'a'.repeat(64);
const taskId = 'skills-canary-20260903';
const executionId = '22222222-2222-4222-8222-222222222222';
const claimId = '33333333-3333-4333-8333-333333333333';
const phaseAttemptId = '78577957-286b-42d4-abf4-4203263481c9';
const contractId = 'c'.repeat(64);

test('execution consumption wait covers delayed guard pickup beyond the old five-second poll budget', async () => {
  let calls = 0;
  const result = await waitForProtectedExecutionConsumption({
    projectRoot: '/eval-project',
    taskId,
    operationId,
    executionId,
    claimId,
    generation: 28,
    contractId,
    phaseAttemptId,
    sleep: async () => {},
    readStatus: async () => {
      calls += 1;
      return calls < 25
        ? {
            consumed: false,
            lifecycleStatus: 'ingress-forwarded',
            recoveryStatus: 'ingress-forwarded',
            consumedAt: null,
          }
        : {
            consumed: true,
            lifecycleStatus: 'consumed',
            recoveryStatus: 'consumed',
            consumedAt: '2026-09-05T00:00:10.000Z',
          };
    },
  });
  assert.equal(calls, 25);
  assert.equal(result.consumed, true);
  assert.equal(result.exactIdentity, true);
});
const sourceCommit = '49f07da8dd2fe3bb0f928e9c4bd48aa77194a076';
const maintenanceEpoch = `recovery-${operationId}`;

function exactPermittedRecoveryStatus(overrides = {}) {
  return {
    revision: 17,
    taskId,
    operationId,
    executionId,
    claimId,
    generation: 28,
    contractId,
    phaseAttemptId,
    consumed: false,
    consumedAt: null,
    lifecycleStatus: 'prepared',
    recoveryStatus: 'permitted',
    recoveryReadbackSeq: null,
    recoveryReadbackDigest: null,
    terminalTombstone: null,
    ...overrides,
  };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function respond(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': bytes.length,
  });
  response.end(bytes);
}

function runtimeAbsolutePath(file) {
  if (process.platform !== 'win32') return file;
  const root = path.parse(file).root;
  return `/${path.relative(root, file).replaceAll('\\', '/')}`;
}

async function createReconciliationFixture() {
  const prefix = process.platform === 'win32'
    ? path.join(path.parse(process.cwd()).root, 'forge-recovery-reconcile-')
    : path.join(os.tmpdir(), 'forge-recovery-reconcile-');
  const root = await mkdtemp(prefix);
  const evidenceDirectory = path.join(root, 'evidence');
  const fenceFile = path.join(root, 'proxy-fence.json');
  await mkdir(evidenceDirectory);
  await writeFile(fenceFile, `${JSON.stringify({
    schemaVersion: 1,
    state: 'maintenance',
    epoch: maintenanceEpoch,
  })}\n`);
  const proxy = await listen((_request, response) => respond(response, 503, {
    ok: false,
    status: 'maintenance',
    code: 'TASKSPACE_MAINTENANCE',
    epoch: maintenanceEpoch,
    drain: {
      mode: 'connection-tracked',
      activeTcpConnections: 0,
      activeHttpRequests: 0,
      activeUpgradeConnections: 0,
      drained: true,
    },
  }));
  const environment = {
    FORGE_EVAL_PROJECT_ROOT: '/eval-project',
    FORGE_EVAL_PHASE_ID: 'backend',
    FORGE_EVAL_SOURCE_COMMIT: sourceCommit,
    FORGE_TASKSPACE_ID: taskId,
    FORGE_PROTECTED_HEADLESS_SESSION_ID: sessionId,
    FORGE_PROTECTED_HEADLESS_RPC_ID: targetRpcId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_OPERATION_ID: operationId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EVIDENCE_DIRECTORY: runtimeAbsolutePath(evidenceDirectory),
    FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_FENCE_FILE: runtimeAbsolutePath(fenceFile),
    FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_EPOCH: maintenanceEpoch,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_SESSION_CWD: '/workspace',
    FORGE_PROTECTED_HEADLESS_RECOVERY_PROXY_PORT: String(proxy.port),
    FORGE_PROTECTED_HEADLESS_RECOVERY_DSH_PORT: '3080',
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_ID: executionId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CLAIM_ID: claimId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PHASE_ATTEMPT_ID: phaseAttemptId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CONTRACT_ID: contractId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_GENERATION: '28',
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_BASELINE_SEQ: '231872',
  };
  const intent = {
    schemaVersion: 'forge-protected-headless-recovery-intent/v1',
    operationId,
    taskId,
    sessionId,
    rpcId: targetRpcId,
    promptDigest: textDigest,
    expectedBaselineSeq: 231872,
    readbackDigest: 'b'.repeat(64),
    executionId,
    claimId,
    generation: 28,
    contractId,
    phaseAttemptId,
    maintenanceEpoch,
    recordedAt: '2026-09-05T00:00:00.000Z',
    invariant: 'This durable intent is written before ingress forwarding; its existence forbids automatic prompt resend.',
  };
  await writeFile(
    path.join(evidenceDirectory, `submission-intent-${operationId}.json`),
    `${JSON.stringify(intent, null, 2)}\n`,
  );
  return {
    root,
    evidenceDirectory,
    environment,
    loadPromptRequest: async ({ sessionId: actualSessionId, rpcId: actualRpcId }) => {
      assert.equal(actualSessionId, sessionId);
      assert.equal(actualRpcId, targetRpcId);
      return { body: Buffer.from('{}'), classified: { textDigest } };
    },
    close: async () => {
      await proxy.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function assertExactStatusReadInput(actual) {
  assert.deepEqual(actual, {
    projectRoot: '/eval-project',
    taskId,
    operationId,
    executionId,
    claimId,
    generation: 28,
    contractId,
    phaseAttemptId,
  });
}

test('helper content-addresses an exact pre-claim failure without exposing its message', async () => {
  const fixture = await createReconciliationFixture();
  const descriptorSha256 = 'd'.repeat(64);
  const failure = Object.assign(new Error('private validation detail must not enter evidence'), {
    code: 'RECOVERY_BASELINE_DRIFT',
  });
  try {
    await rm(path.join(fixture.evidenceDirectory, `submission-intent-${operationId}.json`));
    const result = await executeProtectedHeadlessRecoveryWithFailureReceipt({
      environment: {
        ...fixture.environment,
        FORGE_PROTECTED_HEADLESS_RECOVERY_DESCRIPTOR_SHA256: descriptorSha256,
        FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PROMPT_DIGEST: textDigest,
        FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_STATE_SHA256: 'e'.repeat(64),
      },
      executeRecovery: async () => { throw failure; },
      readStatus: async (actual) => {
        assertExactStatusReadInput(actual);
        return exactPermittedRecoveryStatus();
      },
      clock: () => Date.parse('2026-09-05T00:00:07.000Z'),
    });
    assert.equal(result.receipt.schemaVersion, 'forge-protected-headless-pre-ingress-failure/v1');
    assert.equal(result.receipt.status, 'pre-ingress-failed');
    assert.equal(result.receipt.descriptorSha256, descriptorSha256);
    assert.deepEqual(result.receipt.failure, {
      code: 'RECOVERY_BASELINE_DRIFT', structured: true,
    });
    assert.equal(result.receipt.durableIntent, null);
    assert.equal(result.receipt.executionStatus.revision, 17);
    assert.equal(result.receipt.proofScope.brokerExecutionContextClaimed, false);
    assert.equal(result.receipt.proofScope.durableIntentWritten, false);
    assert.equal(result.receipt.proofScope.ingressForwarded, false);
    assert.equal(result.receipt.proofScope.modelRequestSubmitted, false);
    assert.equal(result.receipt.safeToRestoreUserIngress, true);
    assert.equal(result.receipt.automaticRetryAuthorized, false);
    const receiptBytes = await readFile(result.artifact.file);
    assert.equal(result.artifact.sha256, sha256(receiptBytes));
    assert.equal(
      path.basename(result.artifact.file),
      `recovery-${operationId}-${result.artifact.sha256}.json`,
    );
    assert.equal(receiptBytes.includes(Buffer.from(failure.message)), false);
  } finally {
    await fixture.close();
  }
});

test('helper proves a deterministic failure before permit from an unchanged descriptor-bound state', async () => {
  const fixture = await createReconciliationFixture();
  const projectRoot = path.join(fixture.root, 'project');
  const stateDirectory = path.join(projectRoot, 'taskspaces', '.broker', 'executions');
  const stateFile = path.join(stateDirectory, `${taskId}.json`);
  const state = {
    schemaVersion: 3,
    revision: 28,
    generation: 28,
    taskId,
    lifecycle: { status: 'prepared', consumedAt: null },
    recovery: null,
    tombstones: [],
    current: {
      taskId,
      executionId,
      claimId,
      generation: 28,
      contractId,
      rpcId: targetRpcId,
      dshSessionId: sessionId,
      textDigest,
      sourceCommit,
      phaseId: 'backend',
      testOnly: true,
      authorityClass: 'test-shadow-writer',
    },
  };
  const stateBytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
  const failure = Object.assign(new Error('historical catalog rejected before permit'), {
    code: 'PHASE_CATALOG_CONTRACT_MISMATCH',
  });
  try {
    await rm(path.join(fixture.evidenceDirectory, `submission-intent-${operationId}.json`));
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(stateFile, stateBytes);
    const result = await executeProtectedHeadlessRecoveryWithFailureReceipt({
      environment: {
        ...fixture.environment,
        FORGE_EVAL_PROJECT_ROOT: runtimeAbsolutePath(projectRoot),
        FORGE_PROTECTED_HEADLESS_RECOVERY_DESCRIPTOR_SHA256: 'd'.repeat(64),
        FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PROMPT_DIGEST: textDigest,
        FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_STATE_SHA256: sha256(stateBytes),
      },
      executeRecovery: async () => { throw failure; },
      readStatus: async () => {
        const error = new Error('operation-scoped recovery status does not exist');
        error.code = 'EXECUTION_RECOVERY_STATUS_MISMATCH';
        throw error;
      },
      clock: () => Date.parse('2026-09-05T00:00:07.500Z'),
    });
    assert.equal(result.receipt.status, 'pre-ingress-failed');
    assert.equal(result.receipt.preIngressState, 'unpermitted-state-unchanged');
    assert.equal(result.receipt.failure.code, 'PHASE_CATALOG_CONTRACT_MISMATCH');
    assert.equal(result.receipt.executionStatus.recoveryStatus, null);
    assert.equal(result.receipt.executionStatus.descriptorExecutionStateUnchanged, true);
    assert.equal(result.receipt.executionStatus.executionStateSha256, sha256(stateBytes));
    assert.equal(result.receipt.proofScope.brokerRecoveryPermitIssued, false);
  } finally {
    await fixture.close();
  }
});

test('helper refuses a pre-ingress failure receipt after any intent, claim, or forward evidence', async () => {
  const fixture = await createReconciliationFixture();
  const environment = {
    ...fixture.environment,
    FORGE_PROTECTED_HEADLESS_RECOVERY_DESCRIPTOR_SHA256: 'd'.repeat(64),
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PROMPT_DIGEST: textDigest,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_STATE_SHA256: 'e'.repeat(64),
  };
  const failure = Object.assign(new Error('deterministic validation failed'), {
    code: 'RECOVERY_BASELINE_DRIFT',
  });
  const execute = (readStatus) => executeProtectedHeadlessRecoveryWithFailureReceipt({
    environment,
    executeRecovery: async () => { throw failure; },
    readStatus,
    clock: () => Date.parse('2026-09-05T00:00:08.000Z'),
  });
  try {
    let statusCalls = 0;
    await assert.rejects(
      () => execute(async () => { statusCalls += 1; return exactPermittedRecoveryStatus(); }),
      (error) => error === failure,
    );
    assert.equal(statusCalls, 0);
    await rm(path.join(fixture.evidenceDirectory, `submission-intent-${operationId}.json`));

    for (const unsafeStatus of [
      exactPermittedRecoveryStatus({
        lifecycleStatus: 'submission-attempted',
        recoveryStatus: 'submission-attempted',
        recoveryReadbackSeq: 231872,
        recoveryReadbackDigest: 'b'.repeat(64),
      }),
      exactPermittedRecoveryStatus({
        lifecycleStatus: 'submission-attempted',
        recoveryStatus: 'ingress-forwarded',
        recoveryReadbackSeq: 231872,
        recoveryReadbackDigest: 'b'.repeat(64),
      }),
      exactPermittedRecoveryStatus({
        lifecycleStatus: 'consumed',
        recoveryStatus: 'consumed',
        consumed: true,
        consumedAt: '2026-09-05T00:00:08.000Z',
        recoveryReadbackSeq: 231872,
        recoveryReadbackDigest: 'b'.repeat(64),
      }),
    ]) {
      await assert.rejects(() => execute(async () => unsafeStatus), (error) => error === failure);
    }
    assert.deepEqual(
      (await readdir(fixture.evidenceDirectory)).filter((name) => name.startsWith('recovery-')),
      [],
    );
  } finally {
    await fixture.close();
  }
});

test('complete pinned DSH readback paginates to the beginning and proves the target RPC absent', async () => {
  const calls = [];
  const fixture = await listen(async (request, response) => {
    const envelope = await requestBody(request);
    calls.push([envelope.method, envelope.payload.beforeSeq ?? null]);
    if (envelope.method === 'session.list') {
      respond(response, 200, {
        type: 'server-response', rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: { items: [{ sessionId, running: false, blank: false, cwd: '/workspace', updatedAt: 10 }] },
        },
      });
      return;
    }
    const older = envelope.payload.beforeSeq !== undefined;
    const events = older ? [
      { event: { seq: 1, type: 'turn/start', data: {} } },
      { event: { seq: 2, type: 'user/message', data: { source: { rpcId: 'older-rpc' } } } },
      { event: { seq: 3, type: 'turn/end', data: {} } },
    ] : [
      { event: { seq: 10, type: 'turn/start', data: {} } },
      { event: { seq: 11, type: 'user/message', data: { message: { source: { rpcId: 'newer-rpc' } } } } },
      { event: { seq: 12, type: 'turn/end', data: {} } },
    ];
    respond(response, 200, {
      type: 'server-response', rpcId: envelope.rpcId,
      result: { ok: true, value: { events, hasMore: !older } },
    });
  });
  try {
    const result = await readCompletePinnedDshSession({
      port: fixture.port, sessionId, rpcId: targetRpcId, textDigest, expectedCwd: '/workspace',
    });
    assert.equal(result.pages, 2);
    assert.equal(result.eventCount, 6);
    assert.equal(result.readback.observedSeq, 12);
    assert.equal(result.readback.requestObserved, false);
    assert.equal(result.readback.turnOpen, false);
    assert.deepEqual(calls.map((entry) => entry[0]), [
      'session.list', 'session.history', 'session.history', 'session.list',
    ]);
    assert.deepEqual(calls.filter((entry) => entry[0] === 'session.history').map((entry) => entry[1]), [null, 10]);
  } finally {
    await fixture.close();
  }
});

test('private phase history reads 1301 messages without weakening recovery pagination or protected history boundaries', async () => {
  const messages = Array.from({ length: 1301 }, (_, index) => ({
    event: { seq: index + 1, type: 'user/message', data: { text: `Historical message ${index + 1}` } },
  }));
  const historyCalls = [];
  let sessionReads = 0;
  let mode = 'complete';
  const fixture = await listen(async (request, response) => {
    const envelope = await requestBody(request);
    let value;
    if (envelope.method === 'session.list') {
      sessionReads += 1;
      value = { items: [{ sessionId, running: false, blank: false, cwd: '/workspace', updatedAt: 10 }] };
      if (mode === 'wrong-session') value.items[0].sessionId = 'other-session';
      if (mode === 'wrong-cwd') value.items[0].cwd = '/other-workspace';
      if (mode === 'running') value.items[0].running = true;
      if (mode === 'identity-drift' && sessionReads > 1) value.items[0].updatedAt = 11;
    } else {
      historyCalls.push(envelope.payload);
      const eligible = messages.filter(({ event }) => envelope.payload.beforeSeq === undefined
        || event.seq < envelope.payload.beforeSeq);
      const events = eligible.slice(-envelope.payload.maxMessages);
      value = { events, hasMore: eligible.length > events.length };
      if (mode === 'page-limit') {
        value = { events: [{ event: { seq: 1000 - historyCalls.length, type: 'user/message', data: {} } }], hasMore: true };
      }
      if (mode === 'overlap' && historyCalls.length === 2) {
        value = { events: [messages.at(-1)], hasMore: true };
      }
      if (mode === 'missing-page' && historyCalls.length === 2) value = { events: [], hasMore: true };
    }
    respond(response, 200, {
      type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value },
    });
  });
  try {
    const readPrivate = () => readCompletePinnedDshSessionHistory({
      port: fixture.port, sessionId, rpcId: targetRpcId, textDigest, expectedCwd: '/workspace',
    });
    const privateHistory = await readPrivate();
    assert.equal(privateHistory.pages, 14);
    assert.equal(privateHistory.eventCount, 1301);
    assert.deepEqual(privateHistory.events, messages.map(({ event }) => event));
    assert.equal(historyCalls.length, 14);
    assert.ok(historyCalls.every((payload) => payload.maxMessages === 100));
    assert.equal(historyCalls[0].beforeSeq, undefined);
    assert.equal(historyCalls.at(-1).beforeSeq, 2);
    assert.equal(sessionReads, 2);

    historyCalls.length = 0;
    sessionReads = 0;
    await assert.rejects(() => readCompletePinnedDshSession({
      port: fixture.port, sessionId, rpcId: targetRpcId, textDigest, expectedCwd: '/workspace',
    }), { code: 'RECOVERY_SESSION_HISTORY_INCOMPLETE' });
    assert.equal(historyCalls.length, 256);
    assert.ok(historyCalls.every((payload) => payload.maxMessages === 5));
    assert.equal(sessionReads, 1);

    historyCalls.length = 0;
    sessionReads = 0;
    const result = await readPinnedDshConversationHistory({ port: fixture.port, sessionId });
    assert.equal(result.pages, 14);
    assert.equal(result.eventCount, 1301);
    assert.deepEqual(result.events, messages.map(({ event }) => event));
    assert.equal(historyCalls.length, 14);
    assert.ok(historyCalls.every((payload) => payload.maxMessages === 100));
    assert.equal(historyCalls[0].beforeSeq, undefined);
    assert.equal(historyCalls.at(-1).beforeSeq, 2);
    assert.equal(sessionReads, 2);

    for (const [rejectedMode, code, pages] of [
      ['page-limit', 'RECOVERY_SESSION_HISTORY_INCOMPLETE', 256],
      ['overlap', 'RECOVERY_SESSION_HISTORY_INVALID', 2],
      ['missing-page', 'RECOVERY_SESSION_HISTORY_INVALID', 2],
      ['wrong-session', 'RECOVERY_SESSION_IDENTITY_MISMATCH', 0],
      ['wrong-cwd', 'RECOVERY_SESSION_IDENTITY_MISMATCH', 0],
      ['running', 'RECOVERY_SESSION_NOT_IDLE', 0],
      ['identity-drift', 'RECOVERY_SESSION_IDENTITY_DRIFT', 14],
    ]) {
      mode = rejectedMode;
      historyCalls.length = 0;
      sessionReads = 0;
      await assert.rejects(readPrivate, { code }, rejectedMode);
      assert.equal(historyCalls.length, pages, rejectedMode);
      assert.ok(historyCalls.every((payload) => payload.maxMessages === 100), rejectedMode);
    }
  } finally {
    await fixture.close();
  }
});

test('conversation archive pagination rejects a missing continuation page', async () => {
  let historyCalls = 0;
  const fixture = await listen(async (request, response) => {
    const envelope = await requestBody(request);
    let value;
    if (envelope.method === 'session.list') {
      value = { items: [{ sessionId, running: false, blank: false, cwd: '/workspace', updatedAt: 10 }] };
    } else {
      historyCalls += 1;
      value = {
        events: historyCalls === 1
          ? [{ event: { seq: 200, type: 'user/message', data: { text: 'Recent message' } } }]
          : [],
        hasMore: true,
      };
    }
    respond(response, 200, {
      type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value },
    });
  });
  try {
    await assert.rejects(() => readPinnedDshConversationHistory({ port: fixture.port, sessionId }), {
      code: 'RECOVERY_SESSION_HISTORY_INVALID',
      message: 'Pinned DSH session history cursor did not advance.',
    });
    assert.equal(historyCalls, 2);
  } finally {
    await fixture.close();
  }
});

test('complete pinned DSH readback rejects an already submitted target RPC', async () => {
  const fixture = await listen(async (request, response) => {
    const envelope = await requestBody(request);
    const value = envelope.method === 'session.list'
      ? { items: [{ sessionId, running: false, blank: false, cwd: '/workspace', updatedAt: 10 }] }
      : {
          events: [{
            event: { seq: 7, type: 'user/message', data: { source: { rpcId: targetRpcId } } },
          }],
          hasMore: false,
        };
    respond(response, 200, {
      type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value },
    });
  });
  try {
    await assert.rejects(
      () => readCompletePinnedDshSession({
        port: fixture.port, sessionId, rpcId: targetRpcId, textDigest, expectedCwd: '/workspace',
      }),
      /already present/u,
    );
  } finally {
    await fixture.close();
  }
});

test('complete post-submit reconciliation finds the target RPC outside a recent window', async () => {
  const fixture = await listen(async (request, response) => {
    const envelope = await requestBody(request);
    if (envelope.method === 'session.list') {
      respond(response, 200, {
        type: 'server-response', rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: { items: [{ sessionId, running: true, blank: false, cwd: '/workspace', updatedAt: 12 }] },
        },
      });
      return;
    }
    const older = envelope.payload.beforeSeq !== undefined;
    const events = older ? [{
      event: { seq: 7, type: 'user/message', data: { source: { rpcId: targetRpcId } } },
    }] : Array.from({ length: 6 }, (_, index) => ({
      event: { seq: 20 + index, type: index === 5 ? 'turn/end' : 'assistant/message', data: {} },
    }));
    respond(response, 200, {
      type: 'server-response', rpcId: envelope.rpcId,
      result: { ok: true, value: { events, hasMore: !older } },
    });
  });
  try {
    const result = await reconcileCompletePinnedDshSession({
      port: fixture.port,
      sessionId,
      rpcId: targetRpcId,
      textDigest,
      expectedCwd: '/workspace',
    });
    assert.equal(result.historyComplete, true);
    assert.equal(result.requestObserved, true);
    assert.equal(result.pages, 2);
    assert.equal(result.eventCount, 7);
  } finally {
    await fixture.close();
  }
});

test('post-submit reconciliation requires the exact complete baseline prefix', async () => {
  const originalEvents = [
    { event: { seq: 1, type: 'turn/start', data: {} } },
    { event: { seq: 2, type: 'user/message', data: { source: { rpcId: 'baseline-rpc' } } } },
    { event: { seq: 3, type: 'turn/end', data: {} } },
    { event: { seq: 4, type: 'assistant/message', data: {} } },
  ];
  const baselineBytes = Buffer.from([
    `${JSON.stringify([1, 'turn/start', null])}\n`,
    `${JSON.stringify([2, 'user/message', 'baseline-rpc'])}\n`,
    `${JSON.stringify([3, 'turn/end', null])}\n`,
  ].join(''));
  const baselineDigest = sha256(baselineBytes);
  let events = originalEvents;
  const fixture = await listen(async (request, response) => {
    const envelope = await requestBody(request);
    const value = envelope.method === 'session.list'
      ? { items: [{ sessionId, running: false, blank: false, cwd: '/workspace', updatedAt: 10 }] }
      : { events, hasMore: false };
    respond(response, 200, {
      type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value },
    });
  });
  try {
    const exact = await reconcileCompletePinnedDshSession({
      port: fixture.port,
      sessionId,
      rpcId: targetRpcId,
      textDigest,
      expectedCwd: '/workspace',
      expectedBaselineSeq: 3,
      expectedBaselineDigest: baselineDigest,
    });
    assert.equal(exact.baselineObservedSeq, 3);
    assert.equal(exact.baselineEventDigest, baselineDigest);

    await assert.rejects(
      () => reconcileCompletePinnedDshSession({
        port: fixture.port,
        sessionId,
        rpcId: targetRpcId,
        textDigest,
        expectedCwd: '/workspace',
        expectedBaselineSeq: 3,
        expectedBaselineDigest: 'f'.repeat(64),
      }),
      (error) => error.code === 'RECOVERY_SESSION_BASELINE_DRIFT',
    );

    events = originalEvents.slice(1);
    await assert.rejects(
      () => reconcileCompletePinnedDshSession({
        port: fixture.port,
        sessionId,
        rpcId: targetRpcId,
        textDigest,
        expectedCwd: '/workspace',
        expectedBaselineSeq: 3,
        expectedBaselineDigest: baselineDigest,
      }),
      (error) => error.code === 'RECOVERY_SESSION_BASELINE_DRIFT',
    );
  } finally {
    await fixture.close();
  }
});

test('maintenance admission requires the exact active epoch and a fully drained proxy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-recovery-maintenance-'));
  const fenceFile = path.join(root, 'proxy-fence.json');
  const epoch = 'recovery-11111111-1111-4111-8111-111111111111';
  await writeFile(fenceFile, `${JSON.stringify({ schemaVersion: 1, state: 'maintenance', epoch })}\n`);
  const fixture = await listen((_request, response) => respond(response, 503, {
    ok: false,
    status: 'maintenance',
    code: 'TASKSPACE_MAINTENANCE',
    epoch,
    drain: {
      mode: 'connection-tracked',
      activeTcpConnections: 0,
      activeHttpRequests: 0,
      activeUpgradeConnections: 0,
      drained: true,
    },
  }));
  try {
    assert.deepEqual(await verifyProtectedRecoveryMaintenance({
      fenceFile, epoch, proxyPort: fixture.port,
    }), { epoch, drained: true, mode: 'connection-tracked' });
    await assert.rejects(
      () => verifyProtectedRecoveryMaintenance({ fenceFile, epoch: 'different-epoch', proxyPort: fixture.port }),
      (error) => error.code === 'RECOVERY_MAINTENANCE_MISMATCH',
    );
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('reconciliation treats exact Broker consumption as definitive without waiting for DSH history', async () => {
  const fixture = await createReconciliationFixture();
  let historyCalls = 0;
  try {
    const result = await reconcileProtectedHeadlessRecovery({
      environment: fixture.environment,
      loadPromptRequest: fixture.loadPromptRequest,
      readStatus: async (actual) => {
        assertExactStatusReadInput(actual);
        return {
          consumed: true,
          lifecycleStatus: 'consumed',
          recoveryStatus: 'consumed',
          consumedAt: '2026-09-05T00:00:01.000Z',
          recoveryReadbackSeq: 231872,
          recoveryReadbackDigest: 'b'.repeat(64),
        };
      },
      readCompleteSession: async () => {
        historyCalls += 1;
        return {
          historyComplete: false,
          requestObserved: false,
          turnOpen: true,
          session: { running: true },
        };
      },
      clock: () => Date.parse('2026-09-05T00:00:02.000Z'),
    });

    assert.equal(historyCalls, 0);
    assert.equal(result.receipt.status, 'submitted-observed');
    assert.equal(result.receipt.executionConsumption.consumed, true);
    assert.equal(result.receipt.executionConsumption.exactIdentity, true);
    assert.deepEqual(result.receipt.readback, {
      historyComplete: false,
      requestObserved: false,
      turnOpen: null,
      session: null,
      skippedBecauseExactConsumptionIsDefinitive: true,
    });
    assert.deepEqual(result.receipt.proofScope, {
      brokerExecutionContextConsumed: true,
      phaseGuardBound: false,
      classification: 'broker-execution-context-consumed',
    });
    assert.equal(result.receipt.safeToRestoreUserIngress, true);
    assert.equal(result.receipt.safeToResend, false);
    assert.equal(result.receipt.durableIntent.automaticResendForbidden, true);
    assert.match(result.artifact.sha256, /^[0-9a-f]{64}$/u);
  } finally {
    await fixture.close();
  }
});

test('unconsumed reconciliation requires complete idle DSH history and preserves observed classifications', async () => {
  const fixture = await createReconciliationFixture();
  const readStatus = async (actual) => {
    assertExactStatusReadInput(actual);
    return {
      consumed: false,
      lifecycleStatus: 'ingress-forwarded',
      recoveryStatus: 'ingress-forwarded',
      consumedAt: null,
      recoveryReadbackSeq: 231872,
      recoveryReadbackDigest: 'b'.repeat(64),
    };
  };
  const reconcile = (readCompleteSession) => reconcileProtectedHeadlessRecovery({
    environment: fixture.environment,
    loadPromptRequest: fixture.loadPromptRequest,
    readStatus,
    readCompleteSession,
    abandonExecution: async (actual) => ({
      lifecycleStatus: 'abandoned',
      recoveryStatus: 'abandoned',
      exactIdentity: true,
      idempotent: false,
      tombstone: {
        operationId: actual.operationId,
        phaseAttemptId: actual.phaseAttemptId,
        executionId: actual.executionId,
        claimId: actual.claimId,
        generation: actual.generation,
        contractId: actual.contractId,
        rpcId: actual.readback.rpcId,
        dshSessionId: actual.readback.sessionId,
        textDigest: actual.readback.textDigest,
        abandonedAt: actual.readback.observedAt,
        reason: 'stable-idle-unconsumed-no-resend',
        requestObserved: actual.readback.requestObserved,
        observedSeq: actual.readback.observedSeq,
        eventDigest: actual.readback.eventDigest,
      },
    }),
    clock: () => Date.parse('2026-09-05T00:00:03.000Z'),
  });
  try {
    await assert.rejects(
      () => reconcile(async () => ({
        historyComplete: false,
        requestObserved: true,
        turnOpen: false,
        session: { running: false },
      })),
      (error) => error.code === 'RECOVERY_RECONCILIATION_NOT_STABLE',
    );
    await assert.rejects(
      () => reconcile(async () => ({
        historyComplete: true,
        requestObserved: true,
        turnOpen: false,
        session: { running: true },
      })),
      (error) => error.code === 'RECOVERY_RECONCILIATION_NOT_STABLE',
    );

    for (const [requestObserved, expectedStatus] of [
      [true, 'observed-unconsumed'],
      [false, 'not-observed-no-resend'],
    ]) {
      let historyCalls = 0;
      const result = await reconcile(async (actual) => {
        historyCalls += 1;
        assert.deepEqual(actual, {
          port: 3080,
          sessionId,
          rpcId: targetRpcId,
          textDigest,
          expectedCwd: '/workspace',
          expectedBaselineSeq: 231872,
          expectedBaselineDigest: 'b'.repeat(64),
        });
        return {
          historyComplete: true,
          requestObserved,
          observedSeq: 231900,
          eventDigest: 'e'.repeat(64),
          baselineObservedSeq: 231872,
          baselineEventDigest: 'b'.repeat(64),
          turnOpen: false,
          pages: 2,
          eventCount: 100,
          session: { sessionId, running: false, cwd: '/workspace' },
        };
      });
      assert.equal(historyCalls, 1);
      assert.equal(result.receipt.status, expectedStatus);
      assert.equal(result.receipt.executionConsumption.consumed, false);
      assert.equal(result.receipt.proofScope.brokerExecutionContextConsumed, false);
      assert.equal(
        result.receipt.proofScope.classification,
        'broker-execution-context-abandoned-after-stable-idle',
      );
      assert.equal(result.receipt.executionTerminalization.lifecycleStatus, 'abandoned');
      assert.equal(result.receipt.safeToRestoreUserIngress, true);
      assert.equal(result.receipt.safeToResend, false);
      assert.equal(result.receipt.durableIntent.automaticResendForbidden, true);
    }
  } finally {
    await fixture.close();
  }
});

test('reconciliation resumes from an exact abandoned tombstone after a crash before receipt write', async () => {
  const fixture = await createReconciliationFixture();
  let historyCalls = 0;
  let abandonCalls = 0;
  const abandonedAt = '2026-09-05T00:00:02.000Z';
  try {
    const result = await reconcileProtectedHeadlessRecovery({
      environment: fixture.environment,
      loadPromptRequest: fixture.loadPromptRequest,
      readStatus: async (actual) => {
        assertExactStatusReadInput(actual);
        return {
          consumed: false,
          lifecycleStatus: 'abandoned',
          recoveryStatus: 'abandoned',
          consumedAt: null,
          recoveryReadbackSeq: 231872,
          recoveryReadbackDigest: 'b'.repeat(64),
          terminalTombstone: {
            operationId,
            phaseAttemptId,
            executionId,
            claimId,
            generation: 28,
            contractId,
            rpcId: targetRpcId,
            dshSessionId: sessionId,
            textDigest,
            abandonedAt,
            reason: 'stable-idle-unconsumed-no-resend',
            requestObserved: false,
            observedSeq: 231900,
            eventDigest: 'e'.repeat(64),
          },
        };
      },
      readCompleteSession: async () => { historyCalls += 1; throw new Error('must not reread DSH'); },
      abandonExecution: async () => { abandonCalls += 1; throw new Error('must not terminalize twice'); },
      clock: () => Date.parse('2026-09-05T00:00:04.000Z'),
    });
    assert.equal(historyCalls, 0);
    assert.equal(abandonCalls, 0);
    assert.equal(result.receipt.status, 'not-observed-no-resend');
    assert.equal(result.receipt.executionTerminalization.idempotent, true);
    assert.equal(result.receipt.readback.reconstructedFromTerminalTombstone, true);
    assert.equal(result.receipt.safeToRestoreUserIngress, true);
  } finally {
    await fixture.close();
  }
});

test('reconciliation keeps maintenance when exact status identity is unavailable or drifted', async () => {
  const fixture = await createReconciliationFixture();
  try {
    for (const [readErrorCode, expectedReceiptErrorCode] of [
      ['EXECUTION_RECOVERY_STATUS_MISMATCH', 'EXECUTION_RECOVERY_STATUS_MISMATCH'],
      [undefined, 'RECOVERY_CONSUMPTION_READ_FAILED'],
    ]) {
      let historyCalls = 0;
      await assert.rejects(
        () => reconcileProtectedHeadlessRecovery({
          environment: fixture.environment,
          loadPromptRequest: fixture.loadPromptRequest,
          readStatus: async (actual) => {
            assertExactStatusReadInput(actual);
            const error = new Error('status read did not prove the exact protected execution');
            if (readErrorCode !== undefined) error.code = readErrorCode;
            throw error;
          },
          readCompleteSession: async () => {
            historyCalls += 1;
            return {
              historyComplete: true,
              requestObserved: true,
              observedSeq: 231900,
              eventDigest: 'e'.repeat(64),
              turnOpen: false,
              pages: 1,
              eventCount: 1,
              session: { sessionId, running: false, cwd: '/workspace' },
            };
          },
          clock: () => Date.parse('2026-09-05T00:00:04.000Z'),
        }),
        (error) => error.code === 'RECOVERY_RECONCILIATION_IDENTITY_DRIFT'
          && error.message.includes(expectedReceiptErrorCode),
      );
      assert.equal(historyCalls, 0);
    }
  } finally {
    await fixture.close();
  }
});

test('reconciliation binds the durable intent baseline to Broker state before reading DSH', async () => {
  const fixture = await createReconciliationFixture();
  let historyCalls = 0;
  try {
    await assert.rejects(
      () => reconcileProtectedHeadlessRecovery({
        environment: fixture.environment,
        loadPromptRequest: fixture.loadPromptRequest,
        readStatus: async (actual) => {
          assertExactStatusReadInput(actual);
          return {
            consumed: false,
            lifecycleStatus: 'ingress-forwarded',
            recoveryStatus: 'ingress-forwarded',
            consumedAt: null,
            recoveryReadbackSeq: 231872,
            recoveryReadbackDigest: 'f'.repeat(64),
          };
        },
        readCompleteSession: async () => {
          historyCalls += 1;
          throw new Error('must not read a session after baseline identity drift');
        },
      }),
      (error) => error.code === 'RECOVERY_RECONCILIATION_IDENTITY_DRIFT',
    );
    assert.equal(historyCalls, 0);
  } finally {
    await fixture.close();
  }
});

for (const cancellationCase of [
  {
    name: 'permitted recovery',
    lifecycleStatus: 'prepared',
    recoveryStatus: 'permitted',
    recoveryReadbackSeq: null,
    recoveryReadbackDigest: null,
    expectedReadArguments: {},
    expectedAbandonmentBaseline: { baselineSeq: null, baselineDigest: null },
  },
  {
    name: 'claimed recovery',
    lifecycleStatus: 'submission-attempted',
    recoveryStatus: 'submission-attempted',
    recoveryReadbackSeq: 231872,
    recoveryReadbackDigest: 'b'.repeat(64),
    expectedReadArguments: {
      expectedBaselineSeq: 231872,
      expectedBaselineDigest: 'b'.repeat(64),
    },
    expectedAbandonmentBaseline: {
      baselineSeq: 231872,
      baselineDigest: 'b'.repeat(64),
    },
  },
]) {
  test(`pre-ingress cancellation terminalizes one exact ${cancellationCase.name} without an intent`, async () => {
    const fixture = await createReconciliationFixture();
    await rm(path.join(fixture.evidenceDirectory, `submission-intent-${operationId}.json`));
    let abandonCalls = 0;
    try {
      const result = await cancelProtectedHeadlessRecoveryBeforeIngress({
        environment: fixture.environment,
        loadPromptRequest: fixture.loadPromptRequest,
        readStatus: async (actual) => {
          assertExactStatusReadInput(actual);
          return {
            taskId,
            operationId,
            executionId,
            claimId,
            generation: 28,
            contractId,
            phaseAttemptId,
            consumed: false,
            lifecycleStatus: cancellationCase.lifecycleStatus,
            recoveryStatus: cancellationCase.recoveryStatus,
            recoveryReadbackSeq: cancellationCase.recoveryReadbackSeq,
            recoveryReadbackDigest: cancellationCase.recoveryReadbackDigest,
            terminalTombstone: null,
          };
        },
        readCompleteSession: async (actual) => {
          assert.deepEqual(actual, {
            port: 3080,
            sessionId,
            rpcId: targetRpcId,
            textDigest,
            expectedCwd: '/workspace',
            ...cancellationCase.expectedReadArguments,
          });
          return {
            historyComplete: true,
            requestObserved: false,
            observedSeq: 231872,
            eventDigest: 'e'.repeat(64),
            baselineObservedSeq: cancellationCase.recoveryReadbackSeq,
            baselineEventDigest: cancellationCase.recoveryReadbackDigest,
            turnOpen: false,
            pages: 2,
            eventCount: 100,
            session: { sessionId, running: false, cwd: '/workspace' },
          };
        },
        abandonExecution: async (actual) => {
          abandonCalls += 1;
          assert.equal(actual.reason, 'stable-idle-pre-ingress-cancelled-no-resend');
          assert.deepEqual(
            {
              baselineSeq: actual.readback.baselineSeq,
              baselineDigest: actual.readback.baselineDigest,
            },
            cancellationCase.expectedAbandonmentBaseline,
          );
          return {
            lifecycleStatus: 'abandoned',
            recoveryStatus: 'abandoned',
            exactIdentity: true,
            idempotent: false,
            tombstone: {
              operationId,
              phaseAttemptId,
              executionId,
              claimId,
              generation: 28,
              contractId,
              rpcId: targetRpcId,
              dshSessionId: sessionId,
              textDigest,
              abandonedAt: actual.readback.observedAt,
              reason: actual.reason,
              requestObserved: false,
              observedSeq: actual.readback.observedSeq,
              eventDigest: actual.readback.eventDigest,
            },
          };
        },
        clock: () => Date.parse('2026-09-05T00:00:05.000Z'),
      });
      assert.equal(abandonCalls, 1);
      assert.equal(
        result.receipt.schemaVersion,
        'forge-protected-headless-pre-ingress-cancellation/v1',
      );
      assert.equal(result.receipt.durableIntent, null);
      assert.equal(result.receipt.preIngressState, cancellationCase.recoveryStatus);
      assert.equal(result.receipt.safeToRestoreUserIngress, true);
      assert.equal(result.receipt.safeToResend, false);
      assert.equal(
        result.receipt.proofScope.classification,
        'broker-execution-context-abandoned-before-ingress',
      );
    } finally {
      await fixture.close();
    }
  });
}

test('pre-ingress cancellation refuses any durable intent or observed target RPC', async () => {
  const fixture = await createReconciliationFixture();
  let statusCalls = 0;
  try {
    await assert.rejects(
      () => cancelProtectedHeadlessRecoveryBeforeIngress({
        environment: fixture.environment,
        loadPromptRequest: fixture.loadPromptRequest,
        readStatus: async () => { statusCalls += 1; throw new Error('must not read status'); },
      }),
      (error) => error.code === 'RECOVERY_PRE_INGRESS_CANCELLATION_BLOCKED',
    );
    assert.equal(statusCalls, 0);

    await rm(path.join(fixture.evidenceDirectory, `submission-intent-${operationId}.json`));
    await assert.rejects(
      () => cancelProtectedHeadlessRecoveryBeforeIngress({
        environment: fixture.environment,
        loadPromptRequest: fixture.loadPromptRequest,
        readStatus: async () => ({
          taskId,
          operationId,
          executionId,
          claimId,
          generation: 28,
          contractId,
          phaseAttemptId,
          consumed: false,
          lifecycleStatus: 'prepared',
          recoveryStatus: 'permitted',
          recoveryReadbackSeq: null,
          recoveryReadbackDigest: null,
          terminalTombstone: null,
        }),
        readCompleteSession: async () => ({
          historyComplete: true,
          requestObserved: true,
          observedSeq: 231872,
          eventDigest: 'e'.repeat(64),
          baselineObservedSeq: null,
          baselineEventDigest: null,
          turnOpen: false,
          pages: 1,
          eventCount: 1,
          session: { sessionId, running: false, cwd: '/workspace' },
        }),
      }),
      (error) => error.code === 'RECOVERY_PRE_INGRESS_CANCELLATION_NOT_STABLE',
    );
  } finally {
    await fixture.close();
  }
});

test('orchestrator writes a durable no-resend intent before one exact submission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-recovery-orchestrator-'));
  const evidenceDirectory = path.join(root, 'evidence');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(evidenceDirectory));
  const callOrder = [];
  const readback = Object.freeze({
    schemaVersion: 'forge-protected-session-readback/v1',
    sessionId,
    rpcId: targetRpcId,
    textDigest,
    observedSeq: 231872,
    eventDigest: 'b'.repeat(64),
    sessionObserved: true,
    historyComplete: true,
    requestObserved: false,
    turnOpen: false,
    observedAt: '2026-09-05T00:00:00.000Z',
  });
  const environment = {
    FORGE_EVAL_PROJECT_ROOT: '/eval-project',
    FORGE_TASKSPACE_ID: 'skills-canary-20260903',
    FORGE_PROTECTED_HEADLESS_SESSION_ID: sessionId,
    FORGE_PROTECTED_HEADLESS_RPC_ID: targetRpcId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_OPERATION_ID: operationId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_BASELINE_SEQ: '231872',
    FORGE_PROTECTED_HEADLESS_RECOVERY_EVIDENCE_DIRECTORY: evidenceDirectory,
    FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_FENCE_FILE: '/run/maintenance/proxy-fence.json',
    FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_EPOCH: `recovery-${operationId}`,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_SESSION_CWD: '/workspace',
    FORGE_PROTECTED_HEADLESS_RECOVERY_PROXY_PORT: '23080',
    FORGE_PROTECTED_HEADLESS_RECOVERY_DSH_PORT: '3080',
  };
  const baseDependencies = {
    environment,
    clock: () => Date.parse('2026-09-05T00:00:00.000Z'),
    sleep: async () => {},
    loadPromptRequest: async () => ({
      body: Buffer.from(JSON.stringify({
        type: 'client-request', rpcId: targetRpcId, method: 'session.prompt', payload: {},
      })),
      classified: { textDigest },
    }),
    verifyMaintenance: async () => {
      callOrder.push('maintenance');
      return { epoch: `recovery-${operationId}`, drained: true, mode: 'connection-tracked' };
    },
    readCompleteSession: async () => {
      callOrder.push('readback');
      return { readback, pages: 2, eventCount: 100 };
    },
    prepareExecution: async () => {
      callOrder.push('permit');
      return {
        receiptType: 'forge-protected-execution/test-shadow-recovery-permit',
        taskId: 'skills-canary-20260903',
        phaseAttemptId: '78577957-286b-42d4-abf4-4203263481c9',
        phaseId: 'backend',
        sourceCommit: '49f07da8dd2fe3bb0f928e9c4bd48aa77194a076',
        recovery: {
          operationId,
          status: 'permitted',
          contextIdentityChanged: false,
          phaseStateChanged: false,
        },
      };
    },
    claimExecution: async () => {
      callOrder.push('claim');
      return {
        executionId: '22222222-2222-4222-8222-222222222222',
        claimId: '33333333-3333-4333-8333-333333333333',
        generation: 28,
        contractId: 'c'.repeat(64),
      };
    },
    forwardExecution: async () => {
      callOrder.push('forward');
      const names = await readdir(evidenceDirectory);
      assert.equal(names.some((name) => name === `submission-intent-${operationId}.json`), true);
      return {
        executionId: '22222222-2222-4222-8222-222222222222',
        claimId: '33333333-3333-4333-8333-333333333333',
        generation: 28,
        contractId: 'c'.repeat(64),
        recoveryIngressAuthorized: true,
        idempotent: false,
      };
    },
    submitPrompt: async () => {
      callOrder.push('submit');
      return { httpStatus: 200, accepted: true, rpcIdMatched: true };
    },
    observeSubmittedRpc: async () => {
      callOrder.push('post-readback');
      return { requestObserved: true, observedSeq: 231873, turnOpen: true, attempts: 1 };
    },
    observeExecutionConsumption: async () => {
      callOrder.push('consumed');
      return {
        consumed: true,
        exactIdentity: true,
        lifecycleStatus: 'consumed',
        recoveryStatus: 'consumed',
        consumedAt: '2026-09-05T00:00:00.000Z',
        attempts: 1,
      };
    },
  };
  try {
    const result = await executeProtectedHeadlessRecovery(baseDependencies);
    assert.equal(result.receipt.status, 'accepted');
    assert.match(result.artifact.sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(callOrder, [
      'maintenance', 'readback', 'permit', 'claim', 'readback', 'maintenance',
      'forward', 'maintenance', 'submit', 'post-readback', 'consumed',
    ]);
    const intentBytes = await readFile(path.join(evidenceDirectory, `submission-intent-${operationId}.json`));
    assert.equal(result.receipt.durableIntent.sha256, sha256(intentBytes));
    const unconsumedEvidenceDirectory = path.join(root, 'unconsumed');
    await mkdir(unconsumedEvidenceDirectory);
    const unconsumed = await executeProtectedHeadlessRecovery({
      ...baseDependencies,
      environment: {
        ...environment,
        FORGE_PROTECTED_HEADLESS_RECOVERY_EVIDENCE_DIRECTORY: unconsumedEvidenceDirectory,
      },
      observeExecutionConsumption: async () => ({
        consumed: false,
        exactIdentity: true,
        lifecycleStatus: 'ingress-forwarded',
        recoveryStatus: 'ingress-forwarded',
        consumedAt: null,
        attempts: 20,
      }),
    });
    assert.equal(unconsumed.receipt.status, 'ambiguous-no-resend');
    assert.equal(unconsumed.receipt.executionConsumption.consumed, false);
    let replaySubmitCalls = 0;
    await assert.rejects(
      () => executeProtectedHeadlessRecovery({
        ...baseDependencies,
        forwardExecution: async () => ({
          recoveryIngressAuthorized: true,
          idempotent: true,
        }),
        submitPrompt: async () => { replaySubmitCalls += 1; return { accepted: true }; },
      }),
      (error) => error.code === 'RECOVERY_REPLAY_BLOCKED',
    );
    assert.equal(replaySubmitCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an exact existing intent can continue once from submission-attempted to pre-forward ingress', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-recovery-intent-continuation-'));
  const evidenceDirectory = path.join(root, 'evidence');
  await mkdir(evidenceDirectory);
  const readback = Object.freeze({
    schemaVersion: 'forge-protected-session-readback/v1',
    sessionId,
    rpcId: targetRpcId,
    textDigest,
    observedSeq: 231872,
    eventDigest: 'e'.repeat(64),
    sessionObserved: true,
    historyComplete: true,
    requestObserved: false,
    turnOpen: false,
    observedAt: '2026-09-05T00:00:00.000Z',
  });
  const environment = {
    FORGE_EVAL_PROJECT_ROOT: '/eval-project',
    FORGE_TASKSPACE_ID: taskId,
    FORGE_PROTECTED_HEADLESS_SESSION_ID: sessionId,
    FORGE_PROTECTED_HEADLESS_RPC_ID: targetRpcId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_OPERATION_ID: operationId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_BASELINE_SEQ: '231872',
    FORGE_PROTECTED_HEADLESS_RECOVERY_EVIDENCE_DIRECTORY: evidenceDirectory,
    FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_FENCE_FILE: '/run/maintenance/proxy-fence.json',
    FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_EPOCH: `recovery-${operationId}`,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_SESSION_CWD: '/workspace',
    FORGE_PROTECTED_HEADLESS_RECOVERY_PROXY_PORT: '23080',
    FORGE_PROTECTED_HEADLESS_RECOVERY_DSH_PORT: '3080',
  };
  let forwardCalls = 0;
  let submitCalls = 0;
  const dependencies = {
    environment,
    clock: () => Date.parse('2026-09-05T00:00:00.000Z'),
    sleep: async () => {},
    loadPromptRequest: async () => ({ body: Buffer.from('{}'), classified: { textDigest } }),
    verifyMaintenance: async () => ({
      epoch: `recovery-${operationId}`, drained: true, mode: 'connection-tracked',
    }),
    readCompleteSession: async () => ({ readback, pages: 1, eventCount: 10 }),
    prepareExecution: async () => ({
      receiptType: 'forge-protected-execution/test-shadow-recovery-permit',
      taskId,
      phaseAttemptId,
      phaseId: 'backend',
      sourceCommit: '49f07da8dd2fe3bb0f928e9c4bd48aa77194a076',
      recovery: {
        operationId,
        status: 'submission-attempted',
        contextIdentityChanged: false,
        phaseStateChanged: false,
      },
    }),
    claimExecution: async () => ({ executionId, claimId, generation: 28, contractId }),
    forwardExecution: async () => {
      forwardCalls += 1;
      if (forwardCalls === 1) throw new Error('simulated crash before forward');
      return {
        executionId,
        claimId,
        generation: 28,
        contractId,
        recoveryIngressAuthorized: true,
        idempotent: false,
      };
    },
    submitPrompt: async () => {
      submitCalls += 1;
      return { httpStatus: 200, accepted: true, rpcIdMatched: true };
    },
    observeSubmittedRpc: async () => ({
      requestObserved: true, observedSeq: 231873, turnOpen: true, attempts: 1,
    }),
    observeExecutionConsumption: async () => ({
      taskId,
      operationId,
      executionId,
      claimId,
      generation: 28,
      contractId,
      phaseAttemptId,
      consumed: true,
      exactIdentity: true,
      lifecycleStatus: 'consumed',
      recoveryStatus: 'consumed',
      consumedAt: '2026-09-05T00:00:01.000Z',
      attempts: 1,
    }),
  };
  try {
    await assert.rejects(
      () => executeProtectedHeadlessRecovery(dependencies),
      /simulated crash before forward/u,
    );
    const result = await executeProtectedHeadlessRecovery(dependencies);
    assert.equal(forwardCalls, 2);
    assert.equal(submitCalls, 1);
    assert.equal(result.receipt.status, 'accepted');
    assert.equal(result.receipt.durableIntent.reusedBeforeForward, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only the non-idempotent ingress winner may submit across distinct evidence directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-recovery-concurrent-'));
  const evidenceDirectories = [path.join(root, 'one'), path.join(root, 'two')];
  await Promise.all(evidenceDirectories.map((directory) => mkdir(directory)));
  const readback = Object.freeze({
    schemaVersion: 'forge-protected-session-readback/v1',
    sessionId,
    rpcId: targetRpcId,
    textDigest,
    observedSeq: 231872,
    eventDigest: 'd'.repeat(64),
    sessionObserved: true,
    historyComplete: true,
    requestObserved: false,
    turnOpen: false,
    observedAt: '2026-09-05T00:00:00.000Z',
  });
  let forwarded = false;
  let submissionCount = 0;
  const execute = (evidenceDirectory) => executeProtectedHeadlessRecovery({
    environment: {
      FORGE_EVAL_PROJECT_ROOT: '/eval-project',
      FORGE_TASKSPACE_ID: 'skills-canary-20260903',
      FORGE_PROTECTED_HEADLESS_SESSION_ID: sessionId,
      FORGE_PROTECTED_HEADLESS_RPC_ID: targetRpcId,
      FORGE_PROTECTED_HEADLESS_RECOVERY_OPERATION_ID: operationId,
      FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_BASELINE_SEQ: '231872',
      FORGE_PROTECTED_HEADLESS_RECOVERY_EVIDENCE_DIRECTORY: evidenceDirectory,
      FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_FENCE_FILE: '/run/maintenance/proxy-fence.json',
      FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_EPOCH: `recovery-${operationId}`,
      FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_SESSION_CWD: '/workspace',
      FORGE_PROTECTED_HEADLESS_RECOVERY_PROXY_PORT: '23080',
      FORGE_PROTECTED_HEADLESS_RECOVERY_DSH_PORT: '3080',
    },
    clock: () => Date.parse('2026-09-05T00:00:00.000Z'),
    sleep: async () => {},
    loadPromptRequest: async () => ({
      body: Buffer.from('{}'),
      classified: { textDigest },
    }),
    verifyMaintenance: async () => ({
      epoch: `recovery-${operationId}`, drained: true, mode: 'connection-tracked',
    }),
    readCompleteSession: async () => ({ readback, pages: 2, eventCount: 100 }),
    prepareExecution: async () => ({
      receiptType: 'forge-protected-execution/test-shadow-recovery-permit',
      taskId: 'skills-canary-20260903',
      phaseAttemptId: '78577957-286b-42d4-abf4-4203263481c9',
      phaseId: 'backend',
      sourceCommit: '49f07da8dd2fe3bb0f928e9c4bd48aa77194a076',
      recovery: {
        operationId,
        status: 'permitted',
        contextIdentityChanged: false,
        phaseStateChanged: false,
      },
    }),
    claimExecution: async () => ({
      executionId: '22222222-2222-4222-8222-222222222222',
      claimId: '33333333-3333-4333-8333-333333333333',
      generation: 28,
      contractId: 'c'.repeat(64),
    }),
    forwardExecution: async () => {
      if (forwarded) {
        return {
          recoveryIngressAuthorized: true,
          idempotent: true,
        };
      }
      forwarded = true;
      return {
        executionId: '22222222-2222-4222-8222-222222222222',
        claimId: '33333333-3333-4333-8333-333333333333',
        generation: 28,
        contractId: 'c'.repeat(64),
        recoveryIngressAuthorized: true,
        idempotent: false,
      };
    },
    submitPrompt: async () => {
      submissionCount += 1;
      return { httpStatus: 200, accepted: true, rpcIdMatched: true };
    },
    observeSubmittedRpc: async () => ({
      requestObserved: true, observedSeq: 231873, turnOpen: true, attempts: 1,
    }),
    observeExecutionConsumption: async () => ({
      consumed: true,
      exactIdentity: true,
      lifecycleStatus: 'consumed',
      recoveryStatus: 'consumed',
      consumedAt: '2026-09-05T00:00:00.000Z',
      attempts: 1,
    }),
  });
  try {
    const results = await Promise.allSettled(evidenceDirectories.map(execute));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected'
      && result.reason?.code === 'RECOVERY_REPLAY_BLOCKED').length, 1);
    assert.equal(submissionCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
