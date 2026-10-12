import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  captureForgeDeliveryBrowserPhaseTerminal,
  inspectForgeFrontendReadOnlyDenial,
  prepareForgeDeliveryBrowserSessionBaseline,
} from '../docker/harness/forge-delivery-phase-browser-session.mjs';
import { readCompletePinnedDshSessionHistory } from '../docker/harness/forge-recover-headless-execution.mjs';
import {
  classifyPinnedDshPromptBody,
  digestProductionTaskAuthorityBinding,
} from '../docker/harness/forge-execution-context.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';

const rpcId = '44444444-4444-4444-8444-444444444444';
const dshSessionId = 'session-browser-one';
const promptContent = [{ type: 'text', text: 'request' }];
const promptBody = Buffer.from(JSON.stringify({
  type: 'client-request', rpcId, method: 'session.prompt',
  payload: { sessionId: dshSessionId, mode: 'queue', content: promptContent },
}));
const classification = classifyPinnedDshPromptBody(promptBody, 'session.prompt');
const contract = compileForgeTaskExecutionContract({
  prompt: '只读审查需求阶段输出。',
  ownedPaths: [],
  actionCeiling: 'read-only',
  taskProfiles: ['requirements'],
});
const execution = Object.freeze({
  schemaVersion: 1,
  issuer: 'forge-conversation-gateway',
  audience: 'forge-phase-budget-guard',
  executionId: '11111111-1111-4111-8111-111111111111',
  claimId: '55555555-5555-4555-8555-555555555555',
  generation: 8,
  projectSlug: 'forge-project',
  taskId: 'crud-complete',
  actorUserId: '22222222-2222-4222-8222-222222222222',
  actorUsername: 'owner',
  conversationId: '33333333-3333-4333-8333-333333333333',
  route: classification.route,
  classification: classification.classification,
  rpcId,
  dshSessionId,
  mode: classification.mode,
  bodyDigest: classification.bodyDigest,
  textDigest: classification.textDigest,
  bodyBytes: classification.bodyBytes,
  promptDigest: classification.textDigest,
  policyVersion: 'forge-conversation-execution/v1',
  authorityClass: 'production-read-only',
  testOnly: false,
  sourceCommit: 'a'.repeat(40),
  workspaceFingerprint: null,
  caseFamily: 'crud-complete',
  productionAuthorityId: null,
  productionAuthorityDigest: null,
  controllerGrantDigest: null,
  workflowId: 'crud-complete',
  phaseId: 'requirements',
  phaseIndex: 0,
  phaseCatalogVersion: '2026.09.14.22',
  phaseCatalogDigest: 'c'.repeat(64),
  contractId: contract.contractId,
  contractDigest: contract.contractId,
  actionCeiling: contract.actionCeiling,
  ownedPaths: contract.ownedPaths,
  requiredProfiles: contract.requiredVerificationProfiles,
  contract,
  requestId: 'browser-request-one',
  issuedAt: '2026-09-14T00:00:00.000Z',
  expiresAt: '2026-09-14T00:10:00.000Z',
});

function productionWriterExecution() {
  const ownedPaths = ['forge-server/db/migration/V1.0.1__example.sql'];
  const writerContract = compileForgeTaskExecutionContract({
    prompt: '实现数据库迁移。', ownedPaths, actionCeiling: 'workspace-write', taskProfiles: ['migration'],
  });
  const productionAuthorityId = '66666666-6666-4666-8666-666666666666';
  const controllerGrantDigest = '7'.repeat(64);
  const workspaceFingerprint = '8'.repeat(64);
  const value = {
    ...execution,
    authorityClass: 'production-task-writer',
    workspaceFingerprint,
    productionAuthorityId,
    controllerGrantDigest,
    workflowId: 'crud-complete',
    phaseId: 'database',
    phaseIndex: 2,
    contractId: writerContract.contractId,
    contractDigest: writerContract.contractId,
    actionCeiling: writerContract.actionCeiling,
    ownedPaths: writerContract.ownedPaths,
    requiredProfiles: writerContract.requiredVerificationProfiles,
    contract: writerContract,
  };
  value.productionAuthorityDigest = digestProductionTaskAuthorityBinding({
    projectSlug: value.projectSlug,
    taskId: value.taskId,
    actorUserId: value.actorUserId,
    actorUsername: value.actorUsername,
    conversationId: value.conversationId,
    dshSessionId: value.dshSessionId,
    route: value.route,
    rpcId: value.rpcId,
    promptDigest: value.promptDigest,
    sourceCommit: value.sourceCommit,
    workspaceFingerprint,
    caseFamily: value.caseFamily,
    productionAuthorityId,
    controllerGrantDigest,
    contractId: writerContract.contractId,
    actionCeiling: writerContract.actionCeiling,
    ownedPaths: writerContract.ownedPaths,
  });
  return Object.freeze(value);
}

const session = Object.freeze({
  sessionId: execution.dshSessionId,
  cwd: '/workspace',
  blank: false,
  running: false,
  updatedAt: 10,
  identityDigest: 'f'.repeat(64),
});

const baselineEvents = Object.freeze([
  { seq: 1, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, type: 'user/message', data: { turn: 1, message: { source: { kind: 'user', rpcId: 'older-rpc' } } } },
  { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]);

function history(events, overrides = {}) {
  return {
    events,
    pages: 1,
    eventCount: events.length,
    session,
    ...overrides,
  };
}

function completedEvents() {
  return [
    ...baselineEvents,
    { seq: 4, type: 'turn/start', data: { turn: 2 } },
    { seq: 5, type: 'user/message', data: { turn: 2,
      message: { source: { kind: 'user', rpcId: execution.rpcId }, content: promptContent } } },
    { seq: 6, type: 'assistant/message', data: { turn: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } } },
    { seq: 7, type: 'tool/call', data: { turn: 2, callId: 'call-one', name: 'read', arguments: {} } },
    { seq: 8, type: 'tool/result', data: { turn: 2,
      message: { source: { callId: 'call-one' }, content: [{ type: 'tool-result', isError: false, content: [] }] } } },
    { seq: 9, type: 'assistant/message', data: { turn: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: 'final response' }] } } },
    { seq: 10, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];
}

const readonlyDenialText = 'FORGE_PHASE_BUDGET_GUARD_V1: the protected contract or current prompt constrains this execution to read-only; natural-language write intent cannot raise the ceiling.';

function readonlyDenialEvents() {
  const events = completedEvents();
  events.find((event) => event.type === 'tool/call').data.name = 'Write';
  events.find((event) => event.type === 'tool/result').data.message.content = [
    { type: 'tool-result', isError: true, content: [{ type: 'text', text: readonlyDenialText }] },
  ];
  return events;
}

test('readonly denial inspection proves a paired Write or Edit failure and retains the original capture bytes', async () => {
  const writer = { ...productionWriterExecution(), phaseId: 'frontend', phaseIndex: 5 };
  const privateBaseline = await prepareForgeDeliveryBrowserSessionBaseline({
    execution: writer, port: 1, expectedCwd: '/workspace', readHistory: async () => history([...baselineEvents]),
  });
  for (const tool of ['Write', 'Edit']) {
    const events = readonlyDenialEvents();
    events.find((event) => event.type === 'tool/call').data.name = tool;
    const options = { execution: writer, baseline: privateBaseline, port: 1, expectedCwd: '/workspace',
      readHistory: async () => history(events) };
    const captured = await captureForgeDeliveryBrowserPhaseTerminal(options);
    const bytesBefore = JSON.stringify(captured);
    let reads = 0;
    const result = await inspectForgeFrontendReadOnlyDenial({ ...options, sessionProof: captured.sessionProof,
      readHistory: async () => { reads += 1; return history(events); } });
    assert.equal(reads, 1);
    assert.equal(result.status, 'readonly-denial-proven');
    assert.equal(result.proof.schemaVersion, 'forge-delivery-frontend-readonly-denial-proof/v1');
    assert.equal(result.proof.executionId, writer.executionId);
    assert.equal(result.proof.rpcId, writer.rpcId);
    assert.equal(result.proof.terminalEventDigest, captured.sessionProof.terminalEventDigest);
    assert.equal(result.proof.modelResponseSha256, captured.sessionProof.modelResponseSha256);
    assert.equal(result.proof.sessionProofDigest,
      crypto.createHash('sha256').update(JSON.stringify(captured.sessionProof)).digest('hex'));
    assert.equal(result.proof.sessionRunning, false);
    assert.equal(result.proof.hostReceiptsDerived, false);
    assert.deepEqual(result.proof.denials, [{ callId: 'call-one', callSeq: 7, tool,
      resultSeq: 8, status: 'error', denialCode: 'GLOBAL_READ_ONLY_CONSTRAINT',
      resultTextSha256: crypto.createHash('sha256').update(readonlyDenialText).digest('hex') }]);
    assert.equal(JSON.stringify(captured), bytesBefore);
    assert.equal(JSON.stringify(await captureForgeDeliveryBrowserPhaseTerminal(options)), bytesBefore);
    assert.equal(JSON.stringify(result).includes(readonlyDenialText), false);
    assert.equal(Object.hasOwn(result, 'modelResponse'), false);
  }
});

test('readonly denial inspection ignores model quotations, normal read results and other tool errors', async () => {
  const privateBaseline = await baseline();
  const variants = [
    (events) => { events.find((event) => event.type === 'tool/call').data.name = 'Read'; },
    (events) => { events.find((event) => event.type === 'tool/result').data.message.content[0].isError = false; },
    (events) => { events.find((event) => event.type === 'tool/result').data.message.content[0].isError = 'true'; },
    (events) => { events.find((event) => event.type === 'tool/result').data.message.content[0].content[0].text = 'Other failure';
      events.findLast((event) => event.type === 'assistant/message').data.message.content[0].text = readonlyDenialText; },
    (events) => { events.find((event) => event.type === 'tool/result').data.message.content[0].content[0].text = `Quoted error: ${readonlyDenialText}`; },
  ];
  for (const change of variants) {
    const events = readonlyDenialEvents(); change(events);
    const options = { execution, baseline: privateBaseline, port: 1, expectedCwd: '/workspace',
      readHistory: async () => history(events) };
    const captured = await captureForgeDeliveryBrowserPhaseTerminal(options);
    assert.deepEqual(await inspectForgeFrontendReadOnlyDenial({ ...options, sessionProof: captured.sessionProof }),
      { status: 'not-applicable' });
  }
});

test('readonly denial inspection permits later end-seed coverage without changing the retained turn proof', async () => {
  const privateBaseline = await baseline();
  const events = readonlyDenialEvents();
  const options = { execution, baseline: privateBaseline, port: 1, expectedCwd: '/workspace',
    readHistory: async () => history(events) };
  const captured = await captureForgeDeliveryBrowserPhaseTerminal(options);
  const originalBytes = JSON.stringify(captured.sessionProof);
  const appended = [...events, { seq: 11, type: 'session/end-seed', data: { lastTurn: 2 } }];
  const result = await inspectForgeFrontendReadOnlyDenial({ ...options, sessionProof: captured.sessionProof,
    readHistory: async () => history(appended, { pages: 2 }) });
  assert.equal(result.status, 'readonly-denial-proven');
  assert.equal(result.proof.terminalSeq, captured.sessionProof.terminalSeq);
  assert.equal(result.proof.terminalEventDigest, captured.sessionProof.terminalEventDigest);
  assert.equal(result.proof.sessionProofDigest, crypto.createHash('sha256').update(originalBytes).digest('hex'));
  assert.equal(JSON.stringify(captured.sessionProof), originalBytes);
  for (const coverage of [{ historyPages: 0 }, { historyEventCount: -1 },
    { historyPages: 3 }, { historyEventCount: 12 }]) {
    await assert.rejects(inspectForgeFrontendReadOnlyDenial({ ...options,
      sessionProof: { ...captured.sessionProof, ...coverage },
      readHistory: async () => history(appended, { pages: 2 }) }), { code: 'BROWSER_SESSION_PROOF_MISMATCH' });
  }
});

test('readonly denial inspection refuses a changed retained proof, wrong RPC and unpaired tool result', async () => {
  const privateBaseline = await baseline();
  const events = readonlyDenialEvents();
  const options = { execution, baseline: privateBaseline, port: 1, expectedCwd: '/workspace',
    readHistory: async () => history(events) };
  const captured = await captureForgeDeliveryBrowserPhaseTerminal(options);
  await assert.rejects(inspectForgeFrontendReadOnlyDenial({ ...options,
    sessionProof: { ...captured.sessionProof, terminalEventDigest: '0'.repeat(64) } }),
  { code: 'BROWSER_SESSION_PROOF_MISMATCH' });
  const wrongRpc = structuredClone(events);
  wrongRpc.find((event) => event.type === 'user/message' && event.seq === 5).data.message.source.rpcId = 'wrong-rpc';
  await assert.rejects(inspectForgeFrontendReadOnlyDenial({ ...options, sessionProof: captured.sessionProof,
    readHistory: async () => history(wrongRpc) }), { code: 'BROWSER_SESSION_RPC_MISMATCH' });
  const unpaired = structuredClone(events);
  unpaired.find((event) => event.type === 'tool/result').data.message.source.callId = 'unmatched';
  await assert.rejects(inspectForgeFrontendReadOnlyDenial({ ...options, sessionProof: captured.sessionProof,
    readHistory: async () => history(unpaired) }), { code: 'BROWSER_SESSION_TOOL_EVIDENCE_INVALID' });
  const changedResult = structuredClone(events);
  changedResult.find((event) => event.type === 'tool/result').data.message.content[0].content[0].text = 'another error';
  await assert.rejects(inspectForgeFrontendReadOnlyDenial({ ...options, sessionProof: captured.sessionProof,
    readHistory: async () => history(changedResult) }), { code: 'BROWSER_SESSION_PROOF_MISMATCH' });
});

function pinnedProductionTraceEvents() {
  return [
    ...baselineEvents,
    { seq: 4, type: 'turn/start', data: { turn: 2 } },
    { seq: 5, type: 'agent/inbox/spliced', data: { source: 'queue' } },
    { seq: 6, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 7, type: 'user/message', data: {
      id: 'user-message-one', role: 'user', source: { kind: 'user', rpcId: execution.rpcId }, content: promptContent,
    } },
    { seq: 8, type: 'user/message', data: {
      id: 'agent-instructions', role: 'user', source: { kind: 'plugin' },
      content: [{ type: 'text', text: 'private agent instructions' }],
    } },
    { seq: 9, type: 'assistant/message', data: { turn: 2, id: 'assistant-working', role: 'assistant',
      content: [{ type: 'text', text: 'working' }] } },
    { seq: 10, type: 'tool/call', data: { turn: 2, callId: 'call-one', name: 'read', arguments: {} } },
    { seq: 11, type: 'tool/result', data: { turn: 2,
      message: { source: { callId: 'call-one' }, content: [{ type: 'tool-result', isError: false, content: [] }] } } },
    { seq: 12, type: 'step/start', data: { turn: 2, step: 2 } },
    { seq: 13, type: 'user/message', data: {
      id: 'skill-catalog', role: 'user', source: { kind: 'skill-catalog' },
      content: [{ type: 'text', text: 'private skill catalog' }],
    } },
    { seq: 14, type: 'assistant/message', data: { turn: 2, id: 'assistant-final', role: 'assistant',
      content: [{ type: 'text', text: 'final response' }] } },
    { seq: 15, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];
}

test('raw complete history export retains private assistant content behind the idle session boundary', async () => {
  const events = completedEvents();
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = envelope.method === 'session.list'
        ? { items: [{ sessionId: execution.dshSessionId, running: false, blank: false,
          cwd: '/workspace', updatedAt: 10 }] }
        : { events: events.map((event) => ({ event })), hasMore: false };
      const body = JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId,
        result: { ok: true, value } });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const raw = await readCompletePinnedDshSessionHistory({
      port: server.address().port,
      sessionId: execution.dshSessionId,
      rpcId: execution.rpcId,
      textDigest: execution.textDigest,
      expectedCwd: '/workspace',
    });
    assert.equal(raw.events.at(-2).data.message.content[0].text, 'final response');
    assert.equal(raw.session.running, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('raw complete history export permits an idle blank session before its first prompt', async () => {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = envelope.method === 'session.list'
        ? { items: [{ sessionId: execution.dshSessionId, running: false, blank: true,
          cwd: '/workspace', updatedAt: 1 }] }
        : { events: [], hasMore: false };
      const body = JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId,
        result: { ok: true, value } });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const raw = await readCompletePinnedDshSessionHistory({
      port: server.address().port,
      sessionId: execution.dshSessionId,
      rpcId: execution.rpcId,
      textDigest: execution.textDigest,
      expectedCwd: '/workspace',
    });
    assert.equal(raw.eventCount, 0);
    assert.equal(raw.session.blank, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('fixed browser session CLI reads execution from stdin and uses only the internal DSH port', async () => {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = envelope.method === 'session.list'
        ? { items: [{ sessionId: execution.dshSessionId, running: false, blank: false,
          cwd: '/workspace', updatedAt: 10 }] }
        : { events: baselineEvents.map((event) => ({ event })), hasMore: false };
      const body = JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId,
        result: { ok: true, value } });
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      response.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../docker/harness/forge-delivery-phase-browser-session.mjs', import.meta.url)),
      'baseline',
    ], {
      env: { ...process.env, HARNESS_INTERNAL_PORT: String(server.address().port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({ execution }));
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0, stderr);
    const value = JSON.parse(stdout);
    assert.equal(value.schemaVersion, 'forge-delivery-phase-browser-session-baseline/v1');
    assert.equal(value.rpcId, execution.rpcId);
    assert.equal(value.observedSeq, 3);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('readonly denial private CLI accepts only the retained proof input and uses the real history reader', async () => {
  const privateBaseline = await baseline();
  const events = readonlyDenialEvents();
  const captured = await captureForgeDeliveryBrowserPhaseTerminal({ execution, baseline: privateBaseline,
    port: 1, expectedCwd: '/workspace', readHistory: async () => history(events) });
  let requests = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests += 1;
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = envelope.method === 'session.list'
        ? { items: [{ sessionId: execution.dshSessionId, running: false, blank: false,
          cwd: '/workspace', updatedAt: 10 }] }
        : { events: events.map((event) => ({ event })), hasMore: false };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId,
        result: { ok: true, value } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const invoke = async (action, input) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../docker/harness/forge-delivery-phase-browser-session.mjs', import.meta.url)), action,
    ], { env: { ...process.env, HARNESS_INTERNAL_PORT: String(server.address().port) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    child.stdin.end(JSON.stringify(input));
    return { code: await closed, stdout, stderr };
  };
  try {
    const input = { execution, baseline: privateBaseline, sessionProof: captured.sessionProof };
    for (const [action, body] of [
      ['inspect-readonly-denial', { ...input, allowUserAborted: true }],
      ['inspect-readonly-denial', { execution, baseline: privateBaseline }],
      ['capture', input],
    ]) {
      const denied = await invoke(action, body);
      assert.equal(denied.code, 1);
      assert.match(denied.stderr, /BROWSER_SESSION_STDIN_INVALID/u);
    }
    assert.equal(requests, 0);
    const inspected = await invoke('inspect-readonly-denial', input);
    assert.equal(inspected.code, 0, inspected.stderr);
    const result = JSON.parse(inspected.stdout);
    assert.equal(result.status, 'readonly-denial-proven');
    assert.equal(result.proof.denials[0].callId, 'call-one');
    assert.equal(inspected.stdout.includes(readonlyDenialText), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

async function baseline() {
  return prepareForgeDeliveryBrowserSessionBaseline({
    execution,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history([...baselineEvents]),
  });
}

async function requirementsOverloadEvents() {
  const actual = JSON.parse(await readFile(new URL('./fixtures/requirements-provider-overload-events.json', import.meta.url), 'utf8'));
  return [...completedEvents().slice(0, 5), ...actual.map((event) => ({
    ...event, data: { ...event.data, turn: 2 },
  }))];
}

test('requirements overload captures the actual zero-output provider failure without a model response', async () => {
  const events = await requirementsOverloadEvents();
  const original = structuredClone(events);
  const result = await captureForgeDeliveryBrowserPhaseTerminal({ execution, baseline: await baseline(),
    port: 1, expectedCwd: '/workspace', readHistory: async () => history(events) });
  assert.deepEqual(Object.keys(result), ['providerFailureProof']);
  assert.equal(result.providerFailureProof.terminalReason, 'requirements-provider-overload');
  assert.equal(result.providerFailureProof.error.code, 'PI_AI_ERROR');
  assert.equal(result.providerFailureProof.inputTokens, 0);
  assert.equal(result.providerFailureProof.outputTokens, 0);
  assert.equal(result.providerFailureProof.toolCallCount, 0);
  assert.equal(result.providerFailureProof.toolResultCount, 0);
  assert.equal(result.providerFailureProof.executionId, execution.executionId);
  assert.deepEqual(events, original);
});

test('requirements overload refuses other errors, output, tools, missing usage and other phases', async (t) => {
  const cases = {
    authorization: (events) => { events.at(-1).data.reason.error.message = 'Unauthorized'; },
    ordinaryError: (events) => { events.at(-1).data.reason.error.code = 'INTERNAL_ERROR'; },
    nonzeroInput: (events) => { events[5].data.chunk.usage.inputTokens = 1; },
    nonzeroOutput: (events) => { events[5].data.chunk.usage.outputTokens = 1; },
    missingUsage: (events) => { events.splice(5, 1); },
    assistantOutput: (events) => { events.splice(5, 0, { seq: 6, type: 'assistant/message', data: { turn: 2,
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } } }); },
    toolSideEffect: (events) => { events.splice(5, 0, { seq: 6, type: 'tool/call', data: { turn: 2,
      callId: 'side-effect', name: 'bash', arguments: {} } }); },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const events = await requirementsOverloadEvents(); mutate(events);
    await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({ execution, baseline: await baseline(),
      port: 1, expectedCwd: '/workspace', readHistory: async () => history(events) }),
    (error) => error.code === 'BROWSER_SESSION_TURN_ERROR');
  });
  await t.test('readonly next phase', async () => {
    const other = { ...execution, phaseId: 'domain-contract', phaseIndex: 1 };
    const otherBaseline = await prepareForgeDeliveryBrowserSessionBaseline({ execution: other, port: 1,
      expectedCwd: '/workspace', readHistory: async () => history([...baselineEvents]) });
    await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({ execution: other, baseline: otherBaseline,
      port: 1, expectedCwd: '/workspace', readHistory: async () => history(await requirementsOverloadEvents()) }),
    (error) => error.code === 'BROWSER_SESSION_TURN_ERROR');
  });
});

test('browser phase terminal binds the Manager execution to one completed idle DSH turn', async () => {
  const captured = await captureForgeDeliveryBrowserPhaseTerminal({
    execution,
    baseline: await baseline(),
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history(completedEvents()),
  });
  assert.equal(captured.modelResponse, 'final response');
  assert.equal(captured.sessionProof.executionId, execution.executionId);
  assert.equal(captured.sessionProof.generation, execution.generation);
  assert.equal(captured.sessionProof.rpcId, execution.rpcId);
  assert.equal(captured.sessionProof.requestSeq, 5);
  assert.equal(captured.sessionProof.assistantMessageSeq, 9);
  assert.equal(captured.sessionProof.terminalSeq, 10);
  assert.equal(captured.sessionProof.toolCallCount, 1);
  assert.equal(captured.sessionProof.toolResultCount, 1);
  assert.deepEqual(captured.sessionProof.toolResults, [{
    callId: 'call-one', callSeq: 7, tool: 'read', resultSeq: 8, status: 'success',
  }]);
  assert.equal(captured.sessionProof.hostReceiptsDerived, false);
});

function userAbortedEvents() {
  const events = completedEvents().slice(0, 5);
  let seq = 6;
  for (let index = 0; index < 19; index += 1) {
    const callId = `aborted-turn-call-${index}`;
    events.push({ seq: seq++, type: 'tool/call', data: { turn: 2, callId, name: 'read', arguments: {} } });
    events.push({ seq: seq++, type: 'tool/result', data: { turn: 2,
      message: { source: { callId }, content: [{ type: 'tool-result', isError: index === 18, content: [] }] } } });
  }
  events.push({ seq, type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } } });
  return events;
}

test('user-aborted capture is opt-in and proves closure without manufacturing a final response', async () => {
  const privateBaseline = await baseline();
  const options = { execution, baseline: privateBaseline, port: 1, expectedCwd: '/workspace',
    readHistory: async () => history(userAbortedEvents()) };
  await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal(options), { code: 'BROWSER_SESSION_TURN_ERROR' });
  const result = await captureForgeDeliveryBrowserPhaseTerminal({ ...options, allowUserAborted: true });
  assert.deepEqual(Object.keys(result), ['interruptionProof']);
  const proof = result.interruptionProof;
  assert.equal(proof.schemaVersion, 'forge-delivery-phase-browser-interruption-proof/v1');
  for (const key of ['executionId', 'generation', 'rpcId', 'sourceCommit', 'taskId', 'dshSessionId',
    'workspaceFingerprint', 'phaseId', 'phaseCatalogDigest', 'contractId', 'textDigest']) {
    assert.equal(proof[key], execution[key]);
  }
  assert.equal(proof.baselineObservedSeq, 3);
  assert.equal(proof.requestSeq, 5);
  assert.equal(proof.terminalSeq, userAbortedEvents().at(-1).seq);
  assert.equal(proof.terminalReason, 'user-aborted');
  assert.equal(proof.sessionRunning, false);
  assert.equal(proof.toolCallCount, 19);
  assert.equal(proof.toolResultCount, 19);
  assert.equal(proof.toolResults.length, 19);
  assert.equal(proof.toolResults.at(-1).status, 'error');
  assert.equal(proof.hostReceiptsDerived, false);
  const digest = crypto.createHash('sha256');
  for (const event of userAbortedEvents().slice(baselineEvents.length)) digest.update(`${JSON.stringify(event)}\n`);
  assert.equal(proof.terminalEventDigest, digest.digest('hex'));
  for (const field of ['modelResponse', 'modelResponseSha256', 'assistantMessageSeq', 'sessionProof']) {
    assert.equal(Object.hasOwn(result, field), false);
    assert.equal(Object.hasOwn(proof, field), false);
  }
  const completed = { ...options, readHistory: async () => history(completedEvents()) };
  assert.deepEqual(await captureForgeDeliveryBrowserPhaseTerminal({ ...completed, allowUserAborted: true }),
    await captureForgeDeliveryBrowserPhaseTerminal(completed));
});

test('user-aborted capture retains idle, identity, error and complete-tool boundaries', async () => {
  const privateBaseline = await baseline();
  const aborted = userAbortedEvents();
  const options = { execution, baseline: privateBaseline, port: 1, expectedCwd: '/workspace', allowUserAborted: true };
  for (const value of [false, null, 'true', 1]) {
    await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({ ...options, allowUserAborted: value,
      readHistory: async () => { throw new Error('invalid opt-in must fail before history access'); } }),
    { code: 'BROWSER_SESSION_ARGUMENT_INVALID' });
  }
  const cases = [
    [history(aborted, { session: { ...session, running: true } }), 'BROWSER_SESSION_HISTORY_INVALID'],
    [history(aborted, { session: { ...session, sessionId: 'other-session' } }), 'BROWSER_SESSION_HISTORY_INVALID'],
    [history(aborted.filter((event) => event.seq !== 7)), 'BROWSER_SESSION_TOOL_UNFINISHED'],
    [history(aborted.map((event) => event.seq === 7 ? { ...event, data: { turn: 2,
      message: { source: { callId: 'not-called' }, content: [] } } } : event)), 'BROWSER_SESSION_TOOL_EVIDENCE_INVALID'],
    [history(aborted.map((event) => event.seq === 5 ? { ...event, data: { turn: 2,
      message: { source: { kind: 'user', rpcId: 'another-rpc' }, content: promptContent } } } : event)), 'BROWSER_SESSION_RPC_MISMATCH'],
    [history(aborted.map((event) => event.seq === 3 ? { ...event, data: { ...event.data, changed: true } } : event)), 'BROWSER_SESSION_BASELINE_DRIFT'],
  ];
  for (const kind of ['agent/error', 'agent-error', 'agent/end', 'session/end']) {
    cases.push([history(aborted.map((event) => event.seq === 6 ? { ...event, type: kind } : event)), 'BROWSER_SESSION_TURN_ERROR']);
  }
  for (const reason of [{ kind: 'error' }, { kind: 'aborted' },
    { kind: 'aborted', reason: { kind: 'hook' } }, { kind: 'unknown', reason: { kind: 'user' } }]) {
    cases.push([history(aborted.map((event) => event.type === 'turn/end' && event.seq > 3
      ? { ...event, data: { ...event.data, reason } } : event)), 'BROWSER_SESSION_TURN_ERROR']);
  }
  for (const [readback, code] of cases) {
    await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({ ...options, readHistory: async () => readback }), { code });
  }
});

test('user-aborted private capture CLI accepts only explicit true and returns the interruption shape', async () => {
  const privateBaseline = await baseline();
  let requests = 0;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests += 1;
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = envelope.method === 'session.list'
        ? { items: [{ sessionId: execution.dshSessionId, running: false, blank: false,
          cwd: '/workspace', updatedAt: 10 }] }
        : { events: userAbortedEvents().map((event) => ({ event })), hasMore: false };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const invoke = async (action, input) => {
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../docker/harness/forge-delivery-phase-browser-session.mjs', import.meta.url)), action,
    ], { env: { ...process.env, HARNESS_INTERNAL_PORT: String(server.address().port) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    child.stdin.end(JSON.stringify(input));
    return { code: await closed, stdout, stderr };
  };
  try {
    for (const flag of [false, 'true', null]) {
      const denied = await invoke('capture', { execution, baseline: privateBaseline, allowUserAborted: flag });
      assert.equal(denied.code, 1);
      assert.match(denied.stderr, /BROWSER_SESSION_STDIN_INVALID/u);
    }
    const baselineDenied = await invoke('baseline', { execution, allowUserAborted: true });
    assert.equal(baselineDenied.code, 1);
    assert.match(baselineDenied.stderr, /BROWSER_SESSION_STDIN_INVALID/u);
    assert.equal(requests, 0);
    const accepted = await invoke('capture', { execution, baseline: privateBaseline, allowUserAborted: true });
    assert.equal(accepted.code, 0, accepted.stderr);
    const value = JSON.parse(accepted.stdout);
    assert.deepEqual(Object.keys(value), ['interruptionProof']);
    assert.equal(value.interruptionProof.terminalReason, 'user-aborted');
    assert.equal(value.interruptionProof.toolCallCount, 19);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('browser phase terminal accepts the pinned production DSH injected-message sequence', async () => {
  const captured = await captureForgeDeliveryBrowserPhaseTerminal({
    execution,
    baseline: await baseline(),
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history(pinnedProductionTraceEvents()),
  });
  assert.equal(captured.modelResponse, 'final response');
  assert.equal(captured.sessionProof.requestSeq, 7);
  assert.equal(captured.sessionProof.terminalSeq, 15);
  assert.equal(captured.sessionProof.toolCallCount, 1);
});

test('browser phase terminal accepts the first prompt blank transition but binds stable session cwd and turn', async () => {
  const blankBaseline = await prepareForgeDeliveryBrowserSessionBaseline({
    execution,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history([], { session: { ...session, blank: true } }),
  });
  const captured = await captureForgeDeliveryBrowserPhaseTerminal({
    execution,
    baseline: blankBaseline,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history(completedEvents().slice(3), { session: { ...session, blank: false } }),
  });
  assert.equal(captured.modelResponse, 'final response');
  assert.equal(captured.sessionProof.sessionCwd, '/workspace');

  await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({
    execution,
    baseline: blankBaseline,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history(completedEvents().slice(4), { session: { ...session, blank: false } }),
  }), { code: 'BROWSER_SESSION_INTERLEAVED_TURN' });
  await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({
    execution,
    baseline: blankBaseline,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history(completedEvents().slice(3), {
      session: { ...session, cwd: '/other-workspace', blank: false },
    }),
  }), { code: 'BROWSER_SESSION_IDENTITY_DRIFT' });
});

test('browser phase terminal accepts a canonical production phase writer', async () => {
  const writer = productionWriterExecution();
  const writerBaseline = await prepareForgeDeliveryBrowserSessionBaseline({
    execution: writer,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history([...baselineEvents]),
  });
  const captured = await captureForgeDeliveryBrowserPhaseTerminal({
    execution: writer,
    baseline: writerBaseline,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history(completedEvents()),
  });
  assert.equal(captured.modelResponse, 'final response');
  assert.equal(captured.sessionProof.workspaceFingerprint, writer.workspaceFingerprint);
  assert.equal(captured.sessionProof.phaseId, 'database');
});

test('browser phase terminal rejects stale identity and session bindings', async () => {
  const privateBaseline = await baseline();
  await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({
    execution: { ...execution, sourceCommit: '9'.repeat(40) },
    baseline: privateBaseline,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history(completedEvents()),
  }), { code: 'BROWSER_SESSION_BASELINE_INVALID' });
  await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({
    execution,
    baseline: privateBaseline,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history(completedEvents(), {
      session: { ...session, sessionId: 'other-session' },
    }),
  }), { code: 'BROWSER_SESSION_HISTORY_INVALID' });
  await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({
    execution: { ...execution, authorityClass: 'test-shadow-writer', testOnly: true },
    baseline: privateBaseline,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history(completedEvents()),
  }), { code: 'BROWSER_SESSION_EXECUTION_INVALID' });
});

test('browser phase terminal rejects wrong, interleaved, unfinished and failed turns', async () => {
  const privateBaseline = await baseline();
  const cases = [
    {
      code: 'BROWSER_SESSION_RPC_MISMATCH',
      events: completedEvents().map((event) => event.seq === 5
        ? { ...event, data: { ...event.data, message: { source: { kind: 'user', rpcId: 'wrong-rpc' } } } } : event),
    },
    {
      code: 'BROWSER_SESSION_REQUEST_DIGEST_MISMATCH',
      events: completedEvents().map((event) => event.seq === 5
        ? { ...event, data: { ...event.data, message: {
          source: { kind: 'user', rpcId: execution.rpcId }, content: [{ type: 'text', text: 'different request' }],
        } } } : event),
    },
    {
      code: 'BROWSER_SESSION_INTERLEAVED_TURN',
      events: completedEvents().map((event) => event.seq === 8
        ? { seq: 8, type: 'user/message', data: { message: { source: { kind: 'user', rpcId: 'other-rpc' } } } }
        : event),
    },
    {
      code: 'BROWSER_SESSION_TURN_UNFINISHED',
      events: completedEvents().slice(0, -1),
    },
    {
      code: 'BROWSER_SESSION_TURN_ERROR',
      events: completedEvents().map((event) => event.seq === 10
        ? { ...event, data: { ...event.data, reason: { kind: 'error', error: { code: 'MODEL' } } } } : event),
    },
    {
      code: 'BROWSER_SESSION_TURN_ERROR',
      events: completedEvents().map((event) => event.seq === 9
        ? { seq: 9, type: 'agent/end', data: { reason: { kind: 'error' } } }
        : event),
    },
  ];
  for (const fixture of cases) {
    await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({
      execution,
      baseline: privateBaseline,
      port: 1,
      expectedCwd: '/workspace',
      readHistory: async () => history(fixture.events),
    }), { code: fixture.code });
  }
});

test('browser phase terminal rejects unfinished and unmatched tool evidence', async () => {
  const privateBaseline = await baseline();
  for (const [events, code] of [
    [completedEvents().filter((event) => event.seq !== 8), 'BROWSER_SESSION_TOOL_UNFINISHED'],
    [completedEvents().map((event) => event.seq === 8
      ? { ...event, data: { ...event.data, message: { source: { callId: 'other-call' }, content: [] } } }
      : event), 'BROWSER_SESSION_TOOL_EVIDENCE_INVALID'],
  ]) {
    await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({
      execution,
      baseline: privateBaseline,
      port: 1,
      expectedCwd: '/workspace',
      readHistory: async () => history(events),
    }), { code });
  }
});

test('browser phase terminal preserves its bound turn across complete later turns', async () => {
  const privateBaseline = await baseline();
  await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({
    execution,
    baseline: privateBaseline,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history(completedEvents().map((event) => event.seq === 2
      ? { ...event, data: { ...event.data, changed: true } } : event)),
  }), { code: 'BROWSER_SESSION_BASELINE_DRIFT' });
  const later = completedEvents().concat([
    { seq: 11, type: 'turn/start', data: { turn: 3 } },
    { seq: 12, type: 'user/message', data: { message: { source: { kind: 'user', rpcId: 'later-rpc' } } } },
  ]);
  await assert.rejects(captureForgeDeliveryBrowserPhaseTerminal({
    execution,
    baseline: privateBaseline,
    port: 1,
    expectedCwd: '/workspace',
    readHistory: async () => history(later),
  }), { code: 'BROWSER_SESSION_INTERLEAVED_TURN' });
  const completedLater = later.concat([
    { seq: 13, type: 'assistant/message', data: { turn: 3,
      message: { role: 'assistant', content: [{ type: 'text', text: 'later read-only response' }] } } },
    { seq: 14, type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
  ]);
  const original = structuredClone(completedLater);
  const capture = (events) => captureForgeDeliveryBrowserPhaseTerminal({ execution, baseline: privateBaseline,
    port: 1, expectedCwd: '/workspace', readHistory: async () => history(events) });
  const captured = await capture(completedLater);
  assert.equal(captured.modelResponse, 'final response');
  assert.equal(captured.sessionProof.requestSeq, 5);
  assert.equal(captured.sessionProof.assistantMessageSeq, 9);
  assert.equal(captured.sessionProof.terminalSeq, 10);
  assert.equal(captured.sessionProof.toolCallCount, 1);
  assert.equal(captured.sessionProof.terminalEventDigest, (await capture(completedEvents())).sessionProof.terminalEventDigest);
  assert.deepEqual(completedLater, original);
  const beforeTarget = [...baselineEvents, ...completedLater.slice(10), ...completedEvents().slice(3)]
    .map((event, index) => ({ ...event, seq: index + 1 }));
  const insideTarget = completedLater.slice();
  insideTarget.splice(6, 0, { type: 'user/message', data: { turn: 2,
    message: { source: { kind: 'user', rpcId: 'interleaved-rpc' } } } });
  for (const [events, code] of [
    [beforeTarget, 'BROWSER_SESSION_INTERLEAVED_TURN'],
    [insideTarget.map((event, index) => ({ ...event, seq: index + 1 })), 'BROWSER_SESSION_INTERLEAVED_TURN'],
    [completedLater.map(event => event.seq === 12 ? { ...event, data: { ...event.data,
      message: { source: { kind: 'user', rpcId: execution.rpcId }, content: promptContent } } } : event), 'BROWSER_SESSION_RPC_MISMATCH'],
    [completedLater.map(event => event.seq === 5 ? { ...event, data: { ...event.data,
      message: { source: { kind: 'user', rpcId: execution.rpcId }, content: [{ type: 'text', text: 'different request' }] } } } : event), 'BROWSER_SESSION_REQUEST_DIGEST_MISMATCH'],
    [completedLater.map(event => event.seq > 10 ? { ...event, data: { ...event.data, turn: 2 } } : event), 'BROWSER_SESSION_INTERLEAVED_TURN'],
  ]) await assert.rejects(capture(events), { code });
});

function prunedHistoryFixture() {
  const events = [];
  const append = (type, data, extra = {}) => {
    const event = { seq: events.length + 1, type, data, ...extra };
    events.push(event);
    return event;
  };
  const sources = [];
  // The gen11 trace prunes fourteen results from turns 1, 2, 4, 8 and 10.
  // Keep fixture content synthetic; preserve the pinned native event shape.
  for (const [turn, count] of [[1, 4], [2, 1], [4, 4], [8, 3], [10, 2]]) {
    append('turn/start', { turn });
    for (let step = 1; step <= count; step += 1) {
      const callId = `historical-${turn}-${step}`;
      append('tool/call', { turn, step, callId, name: 'read', arguments: '{}' });
      sources.push(append('tool/result', {
        turn, step, meta: { retained: true },
        message: { id: `message-${callId}`, role: 'user', source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', callId, isError: false,
            content: [{ type: 'text', text: 'synthetic original tool output' }] }] },
      }, { surfaceOp: 'append' }));
    }
    append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  const prefix = structuredClone(events);
  append('turn/start', { turn: 11 });
  append('user/message', { id: 'current-request', role: 'user',
    source: { kind: 'user', rpcId: execution.rpcId }, content: promptContent }, { surfaceOp: 'append' });
  const replacements = [];
  for (const source of sources) {
    const pair = prunePair(source, events.length + 1);
    events.push(...pair);
    replacements.push(pair[1]);
  }
  const currentCall = append('tool/call', { turn: 11, step: 1, callId: 'current-call', name: 'read', arguments: '{}' });
  const currentResult = append('tool/result', {
    turn: 11, step: 1,
    message: { id: 'current-result', role: 'user', source: { kind: 'tool', callId: 'current-call' },
      content: [{ type: 'tool-result', callId: 'current-call', isError: false,
        content: [{ type: 'text', text: 'current original result' }] }] },
  }, { surfaceOp: 'append' });
  append('assistant/message', { turn: 11, role: 'assistant', content: [{ type: 'text', text: 'current final response' }] });
  append('turn/end', { turn: 11, reason: { kind: 'completed' } });
  return { prefix, events, sources, replacements, currentCall, currentResult };
}

function prunePair(source, seq) {
  const data = structuredClone(source.data);
  data.message.content[0].content = [{ type: 'text', text: 'synthetic pruned output' }];
  return [
    { seq, type: 'compaction/prune', data: {
      shadowedRange: { start: source.seq, end: source.seq }, shadowedSeqs: [source.seq], shadowedTokenCount: 25,
    } },
    { seq: seq + 1, type: 'tool/result', data,
      surfaceOp: { op: 'replace', start: source.seq, end: source.seq }, sourceEventSeqs: [source.seq] },
  ];
}

async function capturePrunedFixture(fixture) {
  const privateBaseline = await prepareForgeDeliveryBrowserSessionBaseline({
    execution, port: 1, expectedCwd: '/workspace', readHistory: async () => history(fixture.prefix),
  });
  return captureForgeDeliveryBrowserPhaseTerminal({
    execution, baseline: privateBaseline, port: 1, expectedCwd: '/workspace',
    readHistory: async () => history(fixture.events),
  });
}

test('browser phase terminal retains native historical prune replacements without counting them as executions', async () => {
  const fixture = prunedHistoryFixture();
  const captured = await capturePrunedFixture(fixture);
  assert.equal(captured.modelResponse, 'current final response');
  assert.equal(captured.sessionProof.toolCallCount, 1);
  assert.equal(captured.sessionProof.toolResultCount, 1);
  assert.equal(captured.sessionProof.toolResults[0].resultSeq, fixture.currentResult.seq);
  const hash = crypto.createHash('sha256');
  for (const event of fixture.events.slice(fixture.prefix.length)) hash.update(`${JSON.stringify(event)}\n`);
  assert.equal(captured.sessionProof.terminalEventDigest, hash.digest('hex'));
});

test('browser phase terminal counts an earlier current-turn result once when native pruning replaces its content', async () => {
  const fixture = prunedHistoryFixture();
  const resultIndex = fixture.events.indexOf(fixture.currentResult);
  const pair = prunePair(fixture.currentResult, fixture.currentResult.seq + 1);
  for (const event of fixture.events.slice(resultIndex + 1)) event.seq += 2;
  fixture.events.splice(resultIndex + 1, 0, ...pair);
  const captured = await capturePrunedFixture(fixture);
  assert.equal(captured.sessionProof.toolCallCount, 1);
  assert.equal(captured.sessionProof.toolResultCount, 1);
  assert.equal(captured.sessionProof.toolResults[0].resultSeq, fixture.currentResult.seq);
});

test('browser phase terminal rejects forged or incomplete native prune provenance', async (t) => {
  const cases = [
    ['missing prune', (fixture, replacement) => {
      fixture.events = fixture.events.filter((event) => event.seq !== replacement.seq - 1);
    }],
    ['source citation mismatch', (_fixture, replacement) => { replacement.sourceEventSeqs = [1]; }],
    ['source does not exist', (fixture, replacement) => {
      replacement.surfaceOp.start = 0;
      replacement.surfaceOp.end = 0;
      replacement.sourceEventSeqs = [0];
      const prune = fixture.events.find((event) => event.seq === replacement.seq - 1);
      prune.data.shadowedRange = { start: 0, end: 0 };
      prune.data.shadowedSeqs = [0];
    }],
    ['changed call identity', (_fixture, replacement) => { replacement.data.message.source.callId = 'current-call'; }],
    ['changed error result', (_fixture, replacement) => { replacement.data.message.content[0].isError = true; }],
    ['changed non-content metadata', (_fixture, replacement) => { replacement.data.meta.retained = false; }],
    ['additional message content', (_fixture, replacement) => {
      replacement.data.message.content.push({ type: 'text', text: 'unrelated additional content' });
    }],
    ['dangling prune', (fixture, replacement) => {
      fixture.events = fixture.events.filter((event) => event.seq !== replacement.seq);
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = prunedHistoryFixture();
      mutate(fixture, fixture.replacements[0]);
      await assert.rejects(capturePrunedFixture(fixture), { code: 'BROWSER_SESSION_TOOL_EVIDENCE_INVALID' });
    });
  }
});

test('browser phase terminal still rejects real cross-turn events alongside valid native pruning', async (t) => {
  for (const type of ['tool/call', 'tool/result', 'assistant/message']) {
    await t.test(type, async () => {
      const fixture = prunedHistoryFixture();
      const target = fixture.events.find((event) => event.seq > fixture.replacements.at(-1).seq && event.type === type);
      target.data.turn = 10;
      await assert.rejects(capturePrunedFixture(fixture), { code: 'BROWSER_SESSION_INTERLEAVED_TURN' });
    });
  }
});

test('browser phase terminal never lets a historical replacement complete a current pending call', async () => {
  const fixture = prunedHistoryFixture();
  fixture.currentCall.data.callId = fixture.sources[0].data.message.source.callId;
  fixture.events = fixture.events.filter((event) => event !== fixture.currentResult && event !== fixture.currentCall);
  fixture.events.splice(fixture.events.findIndex((event) => event.type === 'compaction/prune'), 0, fixture.currentCall);
  fixture.events.forEach((event, index) => { event.seq = index + 1; });
  await assert.rejects(capturePrunedFixture(fixture), { code: 'BROWSER_SESSION_TOOL_UNFINISHED' });
});

test('browser phase terminal rejects an unpaired current-turn replacement instead of treating it as a result', async () => {
  const fixture = prunedHistoryFixture();
  fixture.currentResult.surfaceOp = { op: 'replace', start: fixture.sources[0].seq, end: fixture.sources[0].seq };
  fixture.currentResult.sourceEventSeqs = [fixture.sources[0].seq];
  await assert.rejects(capturePrunedFixture(fixture), { code: 'BROWSER_SESSION_TOOL_EVIDENCE_INVALID' });
});
