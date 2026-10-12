import crypto from 'node:crypto';
import http from 'node:http';
import { realpathSync } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  abandonClaimedProtectedExecutionRecovery,
  claimProtectedExecutionRecovery,
  forwardClaimedProtectedExecutionRecovery,
  readProtectedExecutionRecoveryStatus,
  sha256,
} from './forge-execution-context.mjs';
import {
  loadProtectedHeadlessPromptRequest,
  prepareHeadlessExecutionFromEnvironment,
} from './forge-prepare-headless-execution.mjs';
import { inspectForgeProtectedRecoveryReadback } from './forge-protected-session-mode.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const DSH_ID_PATTERN = /^[^\0\r\n]{1,1024}$/u;
const RPC_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAINTENANCE_EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
const SESSION_CWD_PATTERN = /^\/[^\0\r\n]{0,4095}$/u;
const MAX_MAINTENANCE_BYTES = 4096;
const MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
const MAX_EXECUTION_STATE_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_HISTORY_EVENTS = 1_000_000;
const MAX_HISTORY_PAGES = 256;
const HISTORY_PAGE_MESSAGES = 5;
const CONTROL_TIMEOUT_MS = 30_000;
const PROMPT_ACCEPT_TIMEOUT_MS = 60_000;
const EXECUTION_CONSUMPTION_POLL_MS = 250;
const EXECUTION_CONSUMPTION_ATTEMPTS = Math.ceil(
  PROMPT_ACCEPT_TIMEOUT_MS / EXECUTION_CONSUMPTION_POLL_MS,
) + 1;

export class ProtectedHeadlessRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtectedHeadlessRecoveryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProtectedHeadlessRecoveryError(code, message);
}

function requiredEnvironment(environment, name, pattern) {
  const value = environment[name];
  if (typeof value !== 'string' || !pattern.test(value)) fail('RECOVERY_INPUT_INVALID', `${name} is invalid.`);
  return value;
}

function portEnvironment(environment, name, fallback = undefined) {
  const value = environment[name] ?? fallback;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/u.test(value)) {
    fail('RECOVERY_INPUT_INVALID', `${name} is invalid.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed > 65535) fail('RECOVERY_INPUT_INVALID', `${name} is invalid.`);
  return parsed;
}

function integerEnvironment(environment, name) {
  const value = requiredEnvironment(environment, name, /^[0-9]{1,15}$/u);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail('RECOVERY_INPUT_INVALID', `${name} is invalid.`);
  return parsed;
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail('RECOVERY_EVIDENCE_INVALID', `${label} has an invalid shape.`);
  }
}

async function readBoundedJson(file, maxBytes, label) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    fail('RECOVERY_INPUT_INVALID', `${label} path must be absolute.`);
  }
  const information = await lstat(file).catch(() => undefined);
  if (information === undefined || !information.isFile() || information.isSymbolicLink()
    || information.size < 1 || information.size > maxBytes) {
    fail('RECOVERY_EVIDENCE_INVALID', `${label} must be a bounded ordinary file.`);
  }
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    fail('RECOVERY_EVIDENCE_INVALID', `${label} is not valid JSON.`);
  }
}

async function assertEvidenceDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    fail('RECOVERY_INPUT_INVALID', 'Recovery evidence directory must be absolute.');
  }
  const information = await lstat(directory).catch(() => undefined);
  if (information === undefined || !information.isDirectory() || information.isSymbolicLink()) {
    fail('RECOVERY_EVIDENCE_INVALID', 'Recovery evidence directory must already exist as an ordinary directory.');
  }
  const resolved = await realpath(directory);
  if (resolved !== path.resolve(directory)) {
    fail('RECOVERY_EVIDENCE_INVALID', 'Recovery evidence directory must not traverse aliases.');
  }
  return resolved;
}

async function writeExclusive(file, bytes) {
  const handle = await open(file, 'wx', 0o600).catch((error) => {
    if (error?.code === 'EEXIST') {
      fail('RECOVERY_REPLAY_BLOCKED', 'A durable submission intent already exists; reconcile by readback only.');
    }
    throw error;
  });
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== 'win32') {
    const directoryHandle = await open(path.dirname(file), 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }
}

async function persistOrReuseSubmissionIntent(file, proposedIntent) {
  const proposedBytes = jsonBytes(proposedIntent);
  try {
    await writeExclusive(file, proposedBytes);
    return Object.freeze({ bytes: proposedBytes, reused: false });
  } catch (error) {
    if (error?.code !== 'RECOVERY_REPLAY_BLOCKED') throw error;
  }
  const before = await lstat(file).catch(() => undefined);
  if (before === undefined || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 1 || before.size > MAX_CONTROL_RESPONSE_BYTES) {
    fail('RECOVERY_EVIDENCE_INVALID', 'Existing durable recovery intent is not a bounded ordinary file.');
  }
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs) {
    fail('RECOVERY_EVIDENCE_INVALID', 'Existing durable recovery intent changed while it was read.');
  }
  let existing;
  try { existing = JSON.parse(bytes.toString('utf8')); } catch {
    fail('RECOVERY_EVIDENCE_INVALID', 'Existing durable recovery intent is invalid JSON.');
  }
  exactKeys(existing, Object.keys(proposedIntent), 'durable recovery intent');
  const existingRecordedAt = Date.parse(existing.recordedAt);
  const comparable = { ...existing, recordedAt: proposedIntent.recordedAt };
  if (!Number.isFinite(existingRecordedAt)
    || JSON.stringify(comparable) !== JSON.stringify(proposedIntent)) {
    fail('RECOVERY_REPLAY_BLOCKED', 'Existing durable recovery intent does not match this exact operation.');
  }
  return Object.freeze({ bytes, reused: true });
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeContentAddressedReceipt(directory, operationId, value) {
  const bytes = jsonBytes(value);
  const digest = sha256(bytes);
  const file = path.join(directory, `recovery-${operationId}-${digest}.json`);
  try {
    await writeExclusive(file, bytes);
  } catch (error) {
    if (error?.code !== 'RECOVERY_REPLAY_BLOCKED') throw error;
    const existing = await readFile(file).catch(() => undefined);
    if (existing === undefined || !existing.equals(bytes)) throw error;
  }
  return Object.freeze({ file, sha256: digest, bytes: bytes.length });
}

function rawHttpRequest({ port, requestPath, method = 'POST', body = undefined, maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value = undefined) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      agent: false,
      headers: {
        accept: 'application/json',
        connection: 'close',
        ...(body === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': body.length,
        }),
      },
    }, (response) => {
      const declared = Number.parseInt(response.headers['content-length'] ?? '', 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        finish(new ProtectedHeadlessRecoveryError(
          'RECOVERY_RESPONSE_OVERSIZED',
          'Pinned DSH response exceeded the fixed byte limit.',
        ));
        return;
      }
      let received = 0;
      const chunks = [];
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          response.destroy();
          finish(new ProtectedHeadlessRecoveryError(
            'RECOVERY_RESPONSE_OVERSIZED',
            'Pinned DSH response exceeded the fixed byte limit.',
          ));
          return;
        }
        chunks.push(chunk);
      });
      response.once('end', () => finish(undefined, {
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks),
      }));
      response.once('error', (error) => finish(error));
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new ProtectedHeadlessRecoveryError(
        'RECOVERY_REQUEST_TIMEOUT',
        'Pinned DSH request exceeded the fixed deadline.',
      ));
    });
    request.once('error', (error) => finish(error));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function parseJsonResponse(response, label) {
  let value;
  try {
    value = JSON.parse(response.body.toString('utf8'));
  } catch {
    fail('RECOVERY_DSH_RESPONSE_INVALID', `${label} did not return valid JSON.`);
  }
  return value;
}

function validateServerResponse(response, rpcId, label) {
  const envelope = parseJsonResponse(response, label);
  if (response.status !== 200 || envelope?.type !== 'server-response'
    || envelope.rpcId !== rpcId || envelope.result?.ok !== true
    || !Object.hasOwn(envelope.result, 'value')) {
    fail('RECOVERY_DSH_RESPONSE_INVALID', `${label} did not return the exact successful server response.`);
  }
  return envelope.result.value;
}

export async function callPinnedDsh({
  port,
  method,
  payload,
  rpcId = crypto.randomUUID(),
  maxBytes = MAX_CONTROL_RESPONSE_BYTES,
  timeoutMs = CONTROL_TIMEOUT_MS,
}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535
    || typeof method !== 'string' || !/^[a-z]+\.[a-z]+$/u.test(method)
    || payload === null || typeof payload !== 'object' || Array.isArray(payload)
    || typeof rpcId !== 'string' || !RPC_ID_PATTERN.test(rpcId)) {
    fail('RECOVERY_INPUT_INVALID', 'Pinned DSH call is invalid.');
  }
  const body = Buffer.from(JSON.stringify({ type: 'client-request', rpcId, method, payload }));
  const response = await rawHttpRequest({
    port,
    requestPath: `/api/${method}`,
    body,
    maxBytes,
    timeoutMs,
  });
  return Object.freeze({ rpcId, httpStatus: response.status, value: validateServerResponse(response, rpcId, method) });
}

function sessionItem(value, sessionId, expectedCwd, requireIdle, requireNonBlank = true) {
  if (!Array.isArray(value?.items)) fail('RECOVERY_SESSION_LIST_INVALID', 'Pinned DSH session list is invalid.');
  const matches = value.items.filter((item) => item?.sessionId === sessionId);
  if (matches.length !== 1) {
    fail('RECOVERY_SESSION_IDENTITY_MISMATCH', 'The exact pinned DSH session is missing or duplicated.');
  }
  const item = matches[0];
  if (item.cwd !== expectedCwd || (requireNonBlank && item.blank !== false)
    || typeof item.blank !== 'boolean' || typeof item.running !== 'boolean'
    || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0) {
    fail('RECOVERY_SESSION_IDENTITY_MISMATCH', 'The pinned DSH session identity does not match the expected workspace.');
  }
  if (requireIdle && item.running !== false) {
    fail('RECOVERY_SESSION_NOT_IDLE', 'The exact pinned DSH session is still running.');
  }
  return Object.freeze({
    sessionId: item.sessionId,
    cwd: item.cwd,
    blank: item.blank,
    running: item.running,
    updatedAt: item.updatedAt,
    identityDigest: sha256(Buffer.from(JSON.stringify([
      item.sessionId, item.cwd, item.blank,
    ]), 'utf8')),
  });
}

function eventRpcId(event) {
  if (event?.type !== 'user/message' || event.data === null || typeof event.data !== 'object') return undefined;
  const message = event.data.message && typeof event.data.message === 'object'
    ? event.data.message : event.data;
  return typeof message.source?.rpcId === 'string' ? message.source.rpcId : undefined;
}

function summarizeEvent(wrapper) {
  const event = wrapper?.event;
  if (event === null || typeof event !== 'object' || !Number.isSafeInteger(event.seq)
    || event.seq < 0 || typeof event.type !== 'string' || event.type.length < 1) {
    fail('RECOVERY_SESSION_HISTORY_INVALID', 'Pinned DSH session history contains a malformed event.');
  }
  const sourceRpcId = eventRpcId(event);
  return Object.freeze({
    seq: event.seq,
    type: event.type,
    ...(sourceRpcId === undefined ? {} : { data: { source: { rpcId: sourceRpcId } } }),
  });
}

function rawEvent(wrapper) {
  const event = wrapper?.event;
  if (event === null || typeof event !== 'object' || Array.isArray(event)
    || !Number.isSafeInteger(event.seq) || event.seq < 0
    || typeof event.type !== 'string' || event.type.length < 1) {
    fail('RECOVERY_SESSION_HISTORY_INVALID', 'Pinned DSH session history contains a malformed event.');
  }
  return structuredClone(event);
}

async function readPinnedSession(port, sessionId, expectedCwd, requireIdle, requireNonBlank = true) {
  const result = await callPinnedDsh({ port, method: 'session.list', payload: {} });
  return sessionItem(result.value, sessionId, expectedCwd, requireIdle, requireNonBlank);
}

async function readCompletePinnedDshHistory({
  port,
  sessionId,
  rpcId,
  textDigest,
  expectedCwd,
  requireIdle,
  retainContent = false,
  requireNonBlank = true,
  requireExecutionIdentity = true,
  pageMessages = HISTORY_PAGE_MESSAGES,
}) {
  if (!DSH_ID_PATTERN.test(sessionId ?? '') || !SESSION_CWD_PATTERN.test(expectedCwd ?? '')
    || (requireExecutionIdentity && (!RPC_ID_PATTERN.test(rpcId ?? '') || !SHA256_PATTERN.test(textDigest ?? '')))) {
    fail('RECOVERY_INPUT_INVALID', 'Pinned DSH readback identity is invalid.');
  }
  const sessionBefore = await readPinnedSession(port, sessionId, expectedCwd, requireIdle, requireNonBlank);
  const bySequence = new Map();
  let beforeSeq;
  let pages = 0;
  let complete = false;
  while (pages < MAX_HISTORY_PAGES) {
    const payload = {
      sessionId,
      maxMessages: pageMessages,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    };
    const result = await callPinnedDsh({
      port,
      method: 'session.history',
      payload,
      maxBytes: MAX_HISTORY_RESPONSE_BYTES,
    });
    const history = result.value;
    if (!Array.isArray(history?.events) || typeof history.hasMore !== 'boolean') {
      fail('RECOVERY_SESSION_HISTORY_INVALID', 'Pinned DSH session history page is invalid.');
    }
    pages += 1;
    let minimum;
    for (const wrapper of history.events) {
      const event = retainContent ? rawEvent(wrapper) : summarizeEvent(wrapper);
      if (bySequence.has(event.seq)) {
        fail('RECOVERY_SESSION_HISTORY_INVALID', 'Pinned DSH session history pages overlap.');
      }
      bySequence.set(event.seq, event);
      minimum = minimum === undefined ? event.seq : Math.min(minimum, event.seq);
      if (bySequence.size > MAX_HISTORY_EVENTS) {
        fail('RECOVERY_SESSION_HISTORY_OVERSIZED', 'Pinned DSH session history exceeded the fixed event limit.');
      }
    }
    if (!history.hasMore) {
      complete = true;
      break;
    }
    if (!Number.isSafeInteger(minimum) || minimum < 1
      || (beforeSeq !== undefined && minimum >= beforeSeq)) {
      fail('RECOVERY_SESSION_HISTORY_INVALID', 'Pinned DSH session history cursor did not advance.');
    }
    beforeSeq = minimum;
  }
  if (!complete) fail('RECOVERY_SESSION_HISTORY_INCOMPLETE', 'Pinned DSH session history exceeded the page limit.');
  const sessionAfter = await readPinnedSession(port, sessionId, expectedCwd, requireIdle, requireNonBlank);
  if (sessionBefore.identityDigest !== sessionAfter.identityDigest
    || (requireIdle && sessionBefore.updatedAt !== sessionAfter.updatedAt)) {
    fail('RECOVERY_SESSION_IDENTITY_DRIFT', 'The pinned DSH session identity changed during history readback.');
  }
  const events = [...bySequence.values()].sort((left, right) => left.seq - right.seq);
  return Object.freeze({
    events: Object.freeze(events),
    pages,
    eventCount: events.length,
    session: sessionAfter,
  });
}

// This is the root-private, content-bearing counterpart to the recovery
// projection below. Callers must keep the returned events inside a protected
// evidence boundary; browser-facing and audit projections should continue to
// use the redacted/summarized interfaces.
export async function readCompletePinnedDshSessionHistory({
  port, sessionId, rpcId, textDigest, expectedCwd,
}) {
  return readCompletePinnedDshHistory({
    port, sessionId, rpcId, textDigest, expectedCwd, requireIdle: true,
    retainContent: true, requireNonBlank: false, pageMessages: 100,
  });
}

// Conversation exports are observations, not execution/acceptance proofs. The
// first page fixes the upper sequence boundary while older pages are collected;
// a running session may append later events without changing that snapshot.
export async function readPinnedDshConversationHistory({ port, sessionId, expectedCwd = '/workspace' }) {
  return readCompletePinnedDshHistory({
    port, sessionId, expectedCwd, requireIdle: false, retainContent: true,
    requireNonBlank: false, requireExecutionIdentity: false, pageMessages: 100,
  });
}

export async function listPinnedDshConversationSessions({ port, expectedCwd = '/workspace' }) {
  const result = await callPinnedDsh({ port, method: 'session.list', payload: {} });
  if (!Array.isArray(result.value?.items)) fail('RECOVERY_SESSION_LIST_INVALID', 'Pinned DSH session list is invalid.');
  return result.value.items.filter((item) => item?.cwd === expectedCwd && item.blank === false)
    .map((item) => sessionItem(result.value, item.sessionId, expectedCwd, false));
}

export async function readCompletePinnedDshSession({ port, sessionId, rpcId, textDigest, expectedCwd }) {
  const history = await readCompletePinnedDshHistory({
    port, sessionId, rpcId, textDigest, expectedCwd, requireIdle: true,
  });
  const { events } = history;
  const observedSeq = events.length === 0 ? 0 : events.at(-1).seq;
  const readback = inspectForgeProtectedRecoveryReadback({
    events,
    sessionId,
    rpcId,
    textDigest,
    observedSeq,
    sessionObserved: true,
    historyComplete: true,
  });
  return Object.freeze({
    readback,
    pages: history.pages,
    eventCount: history.eventCount,
    session: history.session,
  });
}

function inspectEvents(events, rpcId, expectedBaselineSeq = undefined) {
  let observedSeq = 0;
  let lastTurnStart = -1;
  let lastTurnEnd = -1;
  let requestObserved = false;
  const digest = crypto.createHash('sha256');
  const baselineDigest = crypto.createHash('sha256');
  let baselineObservedSeq = 0;
  for (const event of events) {
    observedSeq = Math.max(observedSeq, event.seq);
    if (event.type === 'turn/start') lastTurnStart = Math.max(lastTurnStart, event.seq);
    if (event.type === 'turn/end') lastTurnEnd = Math.max(lastTurnEnd, event.seq);
    if (eventRpcId(event) === rpcId) requestObserved = true;
    const line = `${JSON.stringify([event.seq, event.type, eventRpcId(event) ?? null])}\n`;
    digest.update(line);
    if (expectedBaselineSeq !== undefined && event.seq <= expectedBaselineSeq) {
      baselineDigest.update(line);
      baselineObservedSeq = event.seq;
    }
  }
  return Object.freeze({
    requestObserved,
    observedSeq,
    turnOpen: lastTurnStart > lastTurnEnd,
    eventDigest: digest.digest('hex'),
    baselineObservedSeq: expectedBaselineSeq === undefined ? null : baselineObservedSeq,
    baselineEventDigest: expectedBaselineSeq === undefined ? null : baselineDigest.digest('hex'),
  });
}

export async function observeRecentPinnedDshRpc({ port, sessionId, rpcId }) {
  const result = await callPinnedDsh({
    port,
    method: 'session.history',
    payload: { sessionId, maxMessages: 5 },
    maxBytes: MAX_HISTORY_RESPONSE_BYTES,
  });
  if (!Array.isArray(result.value?.events) || typeof result.value.hasMore !== 'boolean') {
    fail('RECOVERY_SESSION_HISTORY_INVALID', 'Pinned DSH recent history is invalid.');
  }
  return inspectEvents(result.value.events.map(summarizeEvent), rpcId);
}

export async function reconcileCompletePinnedDshSession({
  port, sessionId, rpcId, textDigest, expectedCwd,
  expectedBaselineSeq = undefined,
  expectedBaselineDigest = undefined,
}) {
  if ((expectedBaselineSeq === undefined) !== (expectedBaselineDigest === undefined)
    || (expectedBaselineSeq !== undefined
      && (!Number.isSafeInteger(expectedBaselineSeq) || expectedBaselineSeq < 0
        || !SHA256_PATTERN.test(expectedBaselineDigest ?? '')))) {
    fail('RECOVERY_INPUT_INVALID', 'Pinned DSH baseline continuity identity is invalid.');
  }
  const history = await readCompletePinnedDshHistory({
    port, sessionId, rpcId, textDigest, expectedCwd, requireIdle: false,
  });
  const inspected = inspectEvents(history.events, rpcId, expectedBaselineSeq);
  if (expectedBaselineSeq !== undefined
    && (inspected.baselineObservedSeq !== expectedBaselineSeq
      || inspected.baselineEventDigest !== expectedBaselineDigest)) {
    fail('RECOVERY_SESSION_BASELINE_DRIFT', 'Pinned DSH history no longer contains the exact recovery baseline prefix.');
  }
  return Object.freeze({
    ...inspected,
    pages: history.pages,
    eventCount: history.eventCount,
    historyComplete: true,
    session: history.session,
  });
}

export async function verifyProtectedRecoveryMaintenance({ fenceFile, epoch, proxyPort }) {
  if (!MAINTENANCE_EPOCH_PATTERN.test(epoch ?? '')) fail('RECOVERY_INPUT_INVALID', 'Maintenance epoch is invalid.');
  const fence = await readBoundedJson(fenceFile, MAX_MAINTENANCE_BYTES, 'maintenance fence');
  exactKeys(fence, ['schemaVersion', 'state', 'epoch'], 'maintenance fence');
  if (fence.schemaVersion !== 1 || fence.state !== 'maintenance' || fence.epoch !== epoch) {
    fail('RECOVERY_MAINTENANCE_MISMATCH', 'The recovery helper does not own the active maintenance fence.');
  }
  const response = await rawHttpRequest({
    port: proxyPort,
    requestPath: '/forge-maintenance/healthz',
    method: 'GET',
    maxBytes: MAX_CONTROL_RESPONSE_BYTES,
    timeoutMs: CONTROL_TIMEOUT_MS,
  });
  const health = parseJsonResponse(response, 'maintenance health');
  if (response.status !== 503 || health?.ok !== false || health.status !== 'maintenance'
    || health.code !== 'TASKSPACE_MAINTENANCE' || health.epoch !== epoch
    || health.drain?.mode !== 'connection-tracked' || health.drain.drained !== true
    || health.drain.activeTcpConnections !== 0 || health.drain.activeHttpRequests !== 0
    || health.drain.activeUpgradeConnections !== 0) {
    fail('RECOVERY_MAINTENANCE_NOT_DRAINED', 'The Harness proxy maintenance fence is not fully drained.');
  }
  return Object.freeze({ epoch, drained: true, mode: 'connection-tracked' });
}

async function postExactPrompt({ port, body, rpcId }) {
  const response = await rawHttpRequest({
    port,
    requestPath: '/api/session.prompt',
    body,
    maxBytes: MAX_CONTROL_RESPONSE_BYTES,
    timeoutMs: PROMPT_ACCEPT_TIMEOUT_MS,
  });
  const value = validateServerResponse(response, rpcId, 'session.prompt');
  if (value?.accepted !== true) {
    fail('RECOVERY_PROMPT_NOT_ACCEPTED', 'Pinned DSH did not accept the exact recovered prompt.');
  }
  return Object.freeze({ httpStatus: response.status, accepted: true, rpcIdMatched: true });
}

async function boundedPostReadback({ port, sessionId, rpcId, textDigest, expectedCwd, sleep }) {
  let last = Object.freeze({ requestObserved: false, observedSeq: 0, turnOpen: false });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      last = await reconcileCompletePinnedDshSession({
        port, sessionId, rpcId, textDigest, expectedCwd,
      });
      if (last.requestObserved) return Object.freeze({ ...last, attempts: attempt });
    } catch (error) {
      last = Object.freeze({
        requestObserved: false,
        observedSeq: 0,
        turnOpen: false,
        errorCode: error?.code ?? 'RECOVERY_POST_READBACK_FAILED',
      });
    }
    if (attempt < 5) await sleep(500);
  }
  return Object.freeze({ ...last, attempts: 5 });
}

export async function waitForProtectedExecutionConsumption({
  readStatus = readProtectedExecutionRecoveryStatus,
  projectRoot,
  taskId,
  operationId,
  executionId,
  claimId,
  generation,
  contractId,
  phaseAttemptId,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = EXECUTION_CONSUMPTION_ATTEMPTS,
}) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      last = await readStatus({
        projectRoot,
        taskId,
        operationId,
        executionId,
        claimId,
        generation,
        contractId,
        phaseAttemptId,
      });
      if (last?.consumed === true && last.lifecycleStatus === 'consumed'
        && last.recoveryStatus === 'consumed' && typeof last.consumedAt === 'string') {
        return Object.freeze({ ...last, attempts: attempt, exactIdentity: true });
      }
    } catch (error) {
      last = {
        consumed: false,
        lifecycleStatus: null,
        recoveryStatus: null,
        consumedAt: null,
        errorCode: typeof error?.code === 'string' ? error.code : 'RECOVERY_CONSUMPTION_READ_FAILED',
      };
      if (error?.code === 'EXECUTION_RECOVERY_STATUS_MISMATCH') {
        return Object.freeze({ ...last, attempts: attempt, exactIdentity: false });
      }
    }
    if (attempt < attempts) await sleep(EXECUTION_CONSUMPTION_POLL_MS);
  }
  return Object.freeze({
    ...(last ?? {
      consumed: false, lifecycleStatus: null, recoveryStatus: null, consumedAt: null,
    }),
    attempts,
    exactIdentity: last?.errorCode !== 'EXECUTION_RECOVERY_STATUS_MISMATCH',
  });
}

export async function executeProtectedHeadlessRecovery({
  environment = process.env,
  prepareExecution = prepareHeadlessExecutionFromEnvironment,
  loadPromptRequest = loadProtectedHeadlessPromptRequest,
  readCompleteSession = readCompletePinnedDshSession,
  claimExecution = claimProtectedExecutionRecovery,
  forwardExecution = forwardClaimedProtectedExecutionRecovery,
  verifyMaintenance = verifyProtectedRecoveryMaintenance,
  submitPrompt = postExactPrompt,
  observeSubmittedRpc = boundedPostReadback,
  observeExecutionConsumption = waitForProtectedExecutionConsumption,
  clock = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const startedAt = new Date(clock()).toISOString();
  const projectRoot = requiredEnvironment(environment, 'FORGE_EVAL_PROJECT_ROOT', /^\/[^\0\r\n]+$/u);
  const taskId = requiredEnvironment(environment, 'FORGE_TASKSPACE_ID', TASK_ID_PATTERN);
  const sessionId = requiredEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_SESSION_ID', DSH_ID_PATTERN);
  const rpcId = requiredEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_RPC_ID', RPC_ID_PATTERN);
  const operationId = requiredEnvironment(
    environment,
    'FORGE_PROTECTED_HEADLESS_RECOVERY_OPERATION_ID',
    UUID_PATTERN,
  );
  const expectedBaselineSeq = integerEnvironment(
    environment,
    'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_BASELINE_SEQ',
  );
  const evidenceDirectory = await assertEvidenceDirectory(requiredEnvironment(
    environment,
    'FORGE_PROTECTED_HEADLESS_RECOVERY_EVIDENCE_DIRECTORY',
    /^[^\0\r\n]+$/u,
  ));
  const fenceFile = requiredEnvironment(
    environment,
    'FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_FENCE_FILE',
    /^[^\0\r\n]+$/u,
  );
  const maintenanceEpoch = requiredEnvironment(
    environment,
    'FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_EPOCH',
    MAINTENANCE_EPOCH_PATTERN,
  );
  if (maintenanceEpoch !== `recovery-${operationId}`) {
    fail('RECOVERY_MAINTENANCE_MISMATCH', 'Maintenance epoch must be bound to the exact recovery operation.');
  }
  const expectedSessionCwd = requiredEnvironment(
    environment,
    'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_SESSION_CWD',
    SESSION_CWD_PATTERN,
  );
  const proxyPort = portEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_PROXY_PORT');
  const dshPort = portEnvironment(
    environment,
    'FORGE_PROTECTED_HEADLESS_RECOVERY_DSH_PORT',
    environment.HARNESS_INTERNAL_PORT ?? '3080',
  );
  if (dshPort !== 3080) fail('RECOVERY_INPUT_INVALID', 'Pinned DSH recovery requires the fixed loopback port 3080.');

  const promptRequest = await loadPromptRequest({ environment, sessionId, rpcId });
  const textDigest = promptRequest.classified.textDigest;
  const maintenance = await verifyMaintenance({ fenceFile, epoch: maintenanceEpoch, proxyPort });
  const first = await readCompleteSession({
    port: dshPort, sessionId, rpcId, textDigest, expectedCwd: expectedSessionCwd,
  });
  if (first.readback.observedSeq !== expectedBaselineSeq) {
    fail('RECOVERY_BASELINE_DRIFT', 'The pinned DSH session baseline sequence drifted before recovery.');
  }

  const permit = await prepareExecution(environment);
  if (permit?.receiptType !== 'forge-protected-execution/test-shadow-recovery-permit'
    || permit.taskId !== taskId || permit.recovery?.operationId !== operationId
    || !['permitted', 'submission-attempted', 'ingress-forwarded'].includes(permit.recovery.status)
    || permit.recovery.contextIdentityChanged !== false
    || permit.recovery.phaseStateChanged !== false) {
    fail('RECOVERY_PERMIT_INVALID', 'The protected recovery permit receipt is invalid.');
  }
  if (permit.recovery.status === 'ingress-forwarded') {
    fail(
      'RECOVERY_REPLAY_BLOCKED',
      'Ingress was already forwarded for this operation; only complete session-history reconciliation is allowed.',
    );
  }
  const claimed = await claimExecution({
    projectRoot,
    taskId,
    operationId,
    readback: first.readback,
    now: clock(),
  });
  const second = await readCompleteSession({
    port: dshPort, sessionId, rpcId, textDigest, expectedCwd: expectedSessionCwd,
  });
  if (second.readback.observedSeq !== expectedBaselineSeq
    || second.readback.observedSeq !== first.readback.observedSeq
    || second.readback.eventDigest !== first.readback.eventDigest
    || second.session?.identityDigest !== first.session?.identityDigest) {
    fail('RECOVERY_SECOND_READBACK_DRIFT', 'The pinned DSH session changed between claim and ingress.');
  }
  await verifyMaintenance({ fenceFile, epoch: maintenanceEpoch, proxyPort });

  const intent = {
    schemaVersion: 'forge-protected-headless-recovery-intent/v1',
    operationId,
    taskId,
    sessionId,
    rpcId,
    promptDigest: textDigest,
    expectedBaselineSeq,
    readbackDigest: first.readback.eventDigest,
    executionId: claimed.executionId,
    claimId: claimed.claimId,
    generation: claimed.generation,
    contractId: claimed.contractId,
    phaseAttemptId: permit.phaseAttemptId,
    maintenanceEpoch,
    recordedAt: new Date(clock()).toISOString(),
    invariant: 'This durable intent is written before ingress forwarding; its existence forbids automatic prompt resend.',
  };
  const intentFile = path.join(evidenceDirectory, `submission-intent-${operationId}.json`);
  const persistedIntent = await persistOrReuseSubmissionIntent(intentFile, intent);
  const intentSha256 = sha256(persistedIntent.bytes);

  const forwarded = await forwardExecution({
    projectRoot,
    taskId,
    operationId,
    readback: second.readback,
    now: clock(),
  });
  if (forwarded.recoveryIngressAuthorized !== true || forwarded.idempotent !== false) {
    fail(
      'RECOVERY_REPLAY_BLOCKED',
      'Another recovery runner already won ingress forwarding; prompt resend is forbidden.',
    );
  }
  await verifyMaintenance({ fenceFile, epoch: maintenanceEpoch, proxyPort });
  let submission;
  let submissionError = null;
  try {
    submission = await submitPrompt({ port: dshPort, body: promptRequest.body, rpcId });
  } catch (error) {
    submissionError = {
      code: typeof error?.code === 'string' ? error.code : 'RECOVERY_PROMPT_RESULT_AMBIGUOUS',
      message: typeof error?.message === 'string' ? error.message.slice(0, 512) : 'Prompt result is ambiguous.',
    };
    submission = { httpStatus: null, accepted: false, rpcIdMatched: false };
  }
  const postReadback = await observeSubmittedRpc({
    port: dshPort,
    sessionId,
    rpcId,
    textDigest,
    expectedCwd: expectedSessionCwd,
    sleep,
  });
  const executionConsumption = await observeExecutionConsumption({
    projectRoot,
    taskId,
    operationId,
    executionId: forwarded.executionId,
    claimId: forwarded.claimId,
    generation: forwarded.generation,
    contractId: forwarded.contractId,
    phaseAttemptId: permit.phaseAttemptId,
    sleep,
  });
  const consumed = executionConsumption.consumed === true
    && executionConsumption.exactIdentity === true;
  const accepted = submission.accepted === true && consumed;
  const observed = (postReadback.requestObserved === true || consumed) && consumed;
  const status = accepted ? 'accepted' : observed ? 'submitted-observed' : 'ambiguous-no-resend';
  const completedAt = new Date(clock()).toISOString();
  const receipt = {
    schemaVersion: 'forge-protected-headless-recovery/v1',
    status,
    startedAt,
    completedAt,
    operationId,
    taskId,
    sessionId,
    rpcId,
    promptDigest: textDigest,
    phaseAttemptId: permit.phaseAttemptId,
    phaseId: permit.phaseId,
    executionId: forwarded.executionId,
    claimId: forwarded.claimId,
    generation: forwarded.generation,
    contractId: forwarded.contractId,
    sourceCommit: permit.sourceCommit,
    maintenance,
    firstReadback: {
      observedSeq: first.readback.observedSeq,
      eventDigest: first.readback.eventDigest,
      eventCount: first.eventCount,
      pages: first.pages,
      requestObserved: false,
      turnOpen: false,
      sessionIdentityDigest: first.session?.identityDigest ?? null,
      sessionCwd: first.session?.cwd ?? expectedSessionCwd,
    },
    secondReadback: {
      observedSeq: second.readback.observedSeq,
      eventDigest: second.readback.eventDigest,
      eventCount: second.eventCount,
      pages: second.pages,
      requestObserved: false,
      turnOpen: false,
      sessionIdentityDigest: second.session?.identityDigest ?? null,
      sessionCwd: second.session?.cwd ?? expectedSessionCwd,
    },
    durableIntent: {
      file: path.basename(intentFile),
      sha256: intentSha256,
      writtenBeforeIngress: true,
      reusedBeforeForward: persistedIntent.reused,
      automaticResendForbidden: true,
    },
    ingress: {
      forwarded: forwarded.recoveryIngressAuthorized === true,
      idempotent: forwarded.idempotent === true,
    },
    submission,
    submissionError,
    postReadback,
    executionConsumption,
    proofScope: {
      brokerExecutionContextConsumed: consumed,
      phaseGuardBound: false,
      classification: 'broker-execution-context-consumed',
    },
    cannotClaim: [
      'phase guard binding or protected execution projection completed',
      'backend phase accepted',
      'A9 complete',
      'crud-complete complete',
      'three positive scenarios complete',
      '88 capabilities covered',
      'mission complete',
    ],
  };
  const artifact = await writeContentAddressedReceipt(evidenceDirectory, operationId, receipt);
  return Object.freeze({ receipt, artifact });
}

function exactUnclaimedRecoveryStatus(status, expected) {
  return status?.taskId === expected.taskId
    && status.operationId === expected.operationId
    && status.executionId === expected.executionId
    && status.claimId === expected.claimId
    && status.generation === expected.generation
    && status.contractId === expected.contractId
    && status.phaseAttemptId === expected.phaseAttemptId
    && Number.isSafeInteger(status.revision) && status.revision >= 0
    && ['prepared', 'legacy-unverified'].includes(status.lifecycleStatus)
    && status.recoveryStatus === 'permitted'
    && status.consumed === false && status.consumedAt === null
    && status.recoveryReadbackSeq === null && status.recoveryReadbackDigest === null
    && status.terminalTombstone === null;
}

async function readDescriptorBoundUnpermittedState(projectRoot, expectedStateSha256, expected) {
  const stateFile = path.join(
    projectRoot, 'taskspaces', '.broker', 'executions', `${expected.taskId}.json`,
  );
  const resolved = await realpath(stateFile).catch(() => undefined);
  const before = await lstat(stateFile).catch(() => undefined);
  if (resolved !== path.resolve(stateFile) || before === undefined
    || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 2 || before.size > MAX_EXECUTION_STATE_BYTES) return null;
  const bytes = await readFile(stateFile);
  const after = await lstat(stateFile).catch(() => undefined);
  if (after === undefined || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeMs !== after.mtimeMs
    || sha256(bytes) !== expectedStateSha256) return null;
  let state;
  try { state = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  const current = state?.current;
  const legacy = state?.schemaVersion === 1;
  const lifecycleStatus = legacy ? 'legacy-unverified' : state?.lifecycle?.status;
  const recovery = legacy ? null : state?.recovery;
  const tombstones = legacy || state.schemaVersion === 2 ? [] : state?.tombstones;
  if (![1, 2, 3].includes(state?.schemaVersion)
    || !Number.isSafeInteger(state.revision) || state.revision < 1
    || state.taskId !== expected.taskId || state.generation !== expected.generation
    || !['prepared', 'legacy-unverified'].includes(lifecycleStatus)
    || (!legacy && state.lifecycle?.consumedAt !== null)
    || recovery !== null || !Array.isArray(tombstones)
    || tombstones.some((entry) => entry?.operationId === expected.operationId
      || entry?.executionId === expected.executionId)
    || current?.taskId !== expected.taskId
    || current.executionId !== expected.executionId || current.claimId !== expected.claimId
    || current.generation !== expected.generation || current.contractId !== expected.contractId
    || current.rpcId !== expected.rpcId || current.dshSessionId !== expected.sessionId
    || current.textDigest !== expected.promptDigest || current.sourceCommit !== expected.sourceCommit
    || current.phaseId !== expected.phaseId || current.testOnly !== true
    || current.authorityClass !== 'test-shadow-writer') return null;
  return Object.freeze({
    revision: state.revision,
    taskId: expected.taskId,
    operationId: expected.operationId,
    executionId: expected.executionId,
    claimId: expected.claimId,
    generation: expected.generation,
    contractId: expected.contractId,
    phaseAttemptId: expected.phaseAttemptId,
    lifecycleStatus,
    recoveryStatus: null,
    consumed: false,
    consumedAt: null,
    recoveryReadbackSeq: null,
    recoveryReadbackDigest: null,
    terminalTombstone: null,
    exactIdentity: true,
    descriptorExecutionStateUnchanged: true,
    executionStateSha256: expectedStateSha256,
  });
}

async function recordProvablePreIngressFailure({ environment, error, readStatus, clock }) {
  if (!(error instanceof Error)) throw error;
  const projectRoot = requiredEnvironment(environment, 'FORGE_EVAL_PROJECT_ROOT', /^\/[\s\S]{1,4095}$/u);
  const taskId = requiredEnvironment(environment, 'FORGE_TASKSPACE_ID', TASK_ID_PATTERN);
  const operationId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_OPERATION_ID', UUID_PATTERN,
  );
  const sessionId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_SESSION_ID', DSH_ID_PATTERN,
  );
  const rpcId = requiredEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_RPC_ID', RPC_ID_PATTERN);
  const descriptorSha256 = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_DESCRIPTOR_SHA256', SHA256_PATTERN,
  );
  const promptDigest = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PROMPT_DIGEST', SHA256_PATTERN,
  );
  const expectedExecutionStateSha256 = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_STATE_SHA256', SHA256_PATTERN,
  );
  const phaseAttemptId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PHASE_ATTEMPT_ID', UUID_PATTERN,
  );
  const phaseId = requiredEnvironment(environment, 'FORGE_EVAL_PHASE_ID', TASK_ID_PATTERN);
  const executionId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_ID', UUID_PATTERN,
  );
  const claimId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CLAIM_ID', UUID_PATTERN,
  );
  const generation = integerEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_GENERATION',
  );
  if (generation < 1) fail('RECOVERY_INPUT_INVALID', 'Recovery generation is invalid.');
  const contractId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CONTRACT_ID', SHA256_PATTERN,
  );
  const sourceCommit = requiredEnvironment(
    environment, 'FORGE_EVAL_SOURCE_COMMIT', /^[0-9a-f]{40}$/u,
  );
  const maintenanceEpoch = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_EPOCH', MAINTENANCE_EPOCH_PATTERN,
  );
  if (maintenanceEpoch !== `recovery-${operationId}`) {
    fail('RECOVERY_MAINTENANCE_MISMATCH', 'Maintenance epoch must be bound to the exact recovery operation.');
  }
  const evidenceDirectory = await assertEvidenceDirectory(requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EVIDENCE_DIRECTORY', /^[^\0\r\n]+$/u,
  ));
  await assertNoDurableSubmissionIntent(evidenceDirectory, operationId);

  const expected = {
    taskId, operationId, executionId, claimId, generation, contractId, phaseAttemptId,
    sessionId, rpcId, promptDigest, sourceCommit, phaseId,
  };
  let status;
  try {
    const observed = await readStatus({
      projectRoot, taskId, operationId, executionId, claimId, generation, contractId, phaseAttemptId,
    });
    if (exactUnclaimedRecoveryStatus(observed, expected)) {
      status = Object.freeze({
        ...observed,
        exactIdentity: true,
        descriptorExecutionStateUnchanged: false,
        executionStateSha256: null,
      });
    }
  } catch {
    // A failure before permit issuance cannot be read through the operation-scoped status API.
  }
  const preIngressState = status === undefined
    ? 'unpermitted-state-unchanged'
    : 'permitted-unclaimed';
  status ??= await readDescriptorBoundUnpermittedState(
    projectRoot, expectedExecutionStateSha256, expected,
  );
  if (status === null || status === undefined) {
    fail(
      'RECOVERY_PRE_INGRESS_FAILURE_UNPROVEN',
      'The helper failure did not leave an exact unpermitted or unclaimed Broker recovery state.',
    );
  }
  await assertNoDurableSubmissionIntent(evidenceDirectory, operationId);

  const failureCode = typeof error.code === 'string' && FAILURE_CODE_PATTERN.test(error.code)
    ? error.code
    : 'RECOVERY_PRE_INGRESS_VALIDATION_FAILED';
  const receipt = {
    schemaVersion: 'forge-protected-headless-pre-ingress-failure/v1',
    status: 'pre-ingress-failed',
    completedAt: new Date(clock()).toISOString(),
    operationId,
    descriptorSha256,
    taskId,
    sessionId,
    rpcId,
    promptDigest,
    phaseAttemptId,
    phaseId,
    executionId,
    claimId,
    generation,
    contractId,
    sourceCommit,
    maintenanceEpoch,
    failure: {
      code: failureCode,
      structured: failureCode !== 'RECOVERY_PRE_INGRESS_VALIDATION_FAILED',
    },
    durableIntent: null,
    preIngressState,
    executionStatus: {
      revision: status.revision,
      taskId,
      operationId,
      executionId,
      claimId,
      generation,
      contractId,
      phaseAttemptId,
      lifecycleStatus: status.lifecycleStatus,
      recoveryStatus: status.recoveryStatus,
      consumed: false,
      consumedAt: null,
      recoveryReadbackSeq: null,
      recoveryReadbackDigest: null,
      terminalTombstone: null,
      exactIdentity: true,
      descriptorExecutionStateUnchanged: status.descriptorExecutionStateUnchanged,
      executionStateSha256: status.executionStateSha256,
    },
    proofScope: {
      brokerRecoveryPermitIssued: preIngressState === 'permitted-unclaimed',
      brokerExecutionContextClaimed: false,
      durableIntentWritten: false,
      ingressForwarded: false,
      modelRequestSubmitted: false,
      classification: 'exact-unclaimed-pre-ingress-helper-failure',
    },
    safeToRestoreUserIngress: true,
    automaticRetryAuthorized: false,
    cannotClaim: [
      'a durable submission intent was written',
      'the Broker recovery context was claimed',
      'ingress was forwarded',
      'a model request was submitted',
      'automatic retry is safe',
    ],
  };
  const artifact = await writeContentAddressedReceipt(evidenceDirectory, operationId, receipt);
  return Object.freeze({ receipt, artifact });
}

export async function executeProtectedHeadlessRecoveryWithFailureReceipt({
  environment = process.env,
  executeRecovery = executeProtectedHeadlessRecovery,
  readStatus = readProtectedExecutionRecoveryStatus,
  clock = () => Date.now(),
} = {}) {
  try {
    return await executeRecovery({ environment, clock });
  } catch (error) {
    try {
      return await recordProvablePreIngressFailure({ environment, error, readStatus, clock });
    } catch {
      throw error;
    }
  }
}

export async function reconcileProtectedHeadlessRecovery({
  environment = process.env,
  loadPromptRequest = loadProtectedHeadlessPromptRequest,
  readCompleteSession = reconcileCompletePinnedDshSession,
  readStatus = readProtectedExecutionRecoveryStatus,
  abandonExecution = abandonClaimedProtectedExecutionRecovery,
  clock = Date.now,
} = {}) {
  const projectRoot = requiredEnvironment(environment, 'FORGE_EVAL_PROJECT_ROOT', /^\/[\s\S]{1,4095}$/u);
  const taskId = requiredEnvironment(environment, 'FORGE_TASKSPACE_ID', TASK_ID_PATTERN);
  const operationId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_OPERATION_ID', UUID_PATTERN,
  );
  const sessionId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_SESSION_ID', DSH_ID_PATTERN,
  );
  const rpcId = requiredEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_RPC_ID', RPC_ID_PATTERN);
  const expectedSessionCwd = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_SESSION_CWD', SESSION_CWD_PATTERN,
  );
  const maintenanceEpoch = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_EPOCH', MAINTENANCE_EPOCH_PATTERN,
  );
  const fenceFile = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_FENCE_FILE', /^\/[\s\S]{1,4095}$/u,
  );
  const evidenceDirectory = await assertEvidenceDirectory(requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EVIDENCE_DIRECTORY', /^\/[\s\S]{1,4095}$/u,
  ));
  const dshPort = portEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_DSH_PORT');
  const proxyPort = portEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_PROXY_PORT');
  const executionId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_ID', UUID_PATTERN,
  );
  const claimId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CLAIM_ID', UUID_PATTERN,
  );
  const phaseAttemptId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PHASE_ATTEMPT_ID', UUID_PATTERN,
  );
  const contractId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CONTRACT_ID', SHA256_PATTERN,
  );
  const generation = integerEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_GENERATION',
  );
  const expectedBaselineSeq = integerEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_BASELINE_SEQ',
  );
  const promptRequest = await loadPromptRequest({ environment, sessionId, rpcId });
  const textDigest = promptRequest.classified.textDigest;
  const maintenance = await verifyProtectedRecoveryMaintenance({
    fenceFile, epoch: maintenanceEpoch, proxyPort,
  });
  const intentFile = path.join(evidenceDirectory, `submission-intent-${operationId}.json`);
  const intent = await readBoundedJson(intentFile, MAX_CONTROL_RESPONSE_BYTES, 'durable recovery intent');
  exactKeys(intent, [
    'schemaVersion', 'operationId', 'taskId', 'sessionId', 'rpcId', 'promptDigest',
    'expectedBaselineSeq', 'readbackDigest', 'executionId', 'claimId', 'generation',
    'contractId', 'phaseAttemptId', 'maintenanceEpoch', 'recordedAt', 'invariant',
  ], 'durable recovery intent');
  if (intent.schemaVersion !== 'forge-protected-headless-recovery-intent/v1'
    || intent.operationId !== operationId || intent.taskId !== taskId
    || intent.sessionId !== sessionId || intent.rpcId !== rpcId
    || intent.promptDigest !== textDigest || intent.expectedBaselineSeq !== expectedBaselineSeq
    || !SHA256_PATTERN.test(intent.readbackDigest ?? '') || intent.executionId !== executionId
    || intent.claimId !== claimId || intent.generation !== generation
    || intent.contractId !== contractId || intent.phaseAttemptId !== phaseAttemptId
    || intent.maintenanceEpoch !== maintenanceEpoch) {
    fail('RECOVERY_RECONCILIATION_IDENTITY_DRIFT', 'Durable recovery intent does not match the exact operation.');
  }
  let executionConsumption;
  try {
    executionConsumption = Object.freeze({
      ...(await readStatus({
        projectRoot, taskId, operationId, executionId, claimId, generation, contractId, phaseAttemptId,
      })),
      exactIdentity: true,
    });
  } catch (error) {
    fail(
      'RECOVERY_RECONCILIATION_IDENTITY_DRIFT',
      `Exact protected execution status could not be proven (${error?.code ?? 'RECOVERY_CONSUMPTION_READ_FAILED'}).`,
    );
  }
  if (executionConsumption.recoveryReadbackSeq !== expectedBaselineSeq
    || executionConsumption.recoveryReadbackDigest !== intent.readbackDigest) {
    fail(
      'RECOVERY_RECONCILIATION_IDENTITY_DRIFT',
      'Protected execution recovery baseline does not match the durable recovery intent.',
    );
  }
  const consumed = executionConsumption.consumed === true
    && executionConsumption.lifecycleStatus === 'consumed'
    && executionConsumption.recoveryStatus === 'consumed'
    && executionConsumption.exactIdentity === true;
  const terminalTombstone = executionConsumption.terminalTombstone;
  const alreadyAbandoned = executionConsumption.lifecycleStatus === 'abandoned'
    && executionConsumption.recoveryStatus === 'abandoned'
    && executionConsumption.exactIdentity === true
    && terminalTombstone?.operationId === operationId
    && terminalTombstone?.phaseAttemptId === phaseAttemptId
    && terminalTombstone?.executionId === executionId
    && terminalTombstone?.claimId === claimId
    && terminalTombstone?.generation === generation
    && terminalTombstone?.contractId === contractId
    && terminalTombstone?.rpcId === rpcId
    && terminalTombstone?.dshSessionId === sessionId
    && terminalTombstone?.textDigest === textDigest
    && terminalTombstone?.reason === 'stable-idle-unconsumed-no-resend'
    && Number.isSafeInteger(terminalTombstone?.observedSeq)
    && SHA256_PATTERN.test(terminalTombstone?.eventDigest ?? '');
  let readback;
  let executionTerminalization = null;
  if (consumed) {
    // Exact Broker consumption is the definitive one-shot ingress boundary. The
    // model turn may legitimately still be running, so do not keep user ingress
    // closed waiting for a DSH turn/end event merely to enrich the receipt.
    readback = Object.freeze({
      historyComplete: false,
      requestObserved: false,
      turnOpen: null,
      session: null,
      skippedBecauseExactConsumptionIsDefinitive: true,
    });
  } else if (alreadyAbandoned) {
    readback = Object.freeze({
      historyComplete: true,
      requestObserved: terminalTombstone.requestObserved === true,
      observedSeq: terminalTombstone.observedSeq,
      eventDigest: terminalTombstone.eventDigest,
      turnOpen: false,
      pages: null,
      eventCount: null,
      session: { sessionId, running: false, cwd: expectedSessionCwd },
      reconstructedFromTerminalTombstone: true,
    });
    executionTerminalization = Object.freeze({
      lifecycleStatus: 'abandoned',
      recoveryStatus: 'abandoned',
      exactIdentity: true,
      idempotent: true,
      tombstone: terminalTombstone,
    });
  } else {
    if (![
      ['submission-attempted', 'submission-attempted'],
      ['ingress-forwarded', 'ingress-forwarded'],
    ].some(([lifecycle, recovery]) => (
      executionConsumption.lifecycleStatus === lifecycle
      && executionConsumption.recoveryStatus === recovery
    ))) {
      fail(
        'RECOVERY_RECONCILIATION_STATE_INVALID',
        'Exact protected execution state is not an unconsumed submitted recovery.',
      );
    }
    readback = await readCompleteSession({
      port: dshPort, sessionId, rpcId, textDigest, expectedCwd: expectedSessionCwd,
      expectedBaselineSeq,
      expectedBaselineDigest: intent.readbackDigest,
    });
    if (readback.historyComplete !== true || readback.turnOpen !== false
      || readback.session?.running !== false || readback.session?.sessionId !== sessionId
      || !Number.isSafeInteger(readback.observedSeq) || readback.observedSeq < 0
      || !SHA256_PATTERN.test(readback.eventDigest ?? '')) {
      fail('RECOVERY_RECONCILIATION_NOT_STABLE', 'Pinned DSH session has not reached a stable idle boundary.');
    }
    const terminalizedAt = clock();
    executionTerminalization = await abandonExecution({
      projectRoot,
      taskId,
      operationId,
      executionId,
      claimId,
      generation,
      contractId,
      phaseAttemptId,
      readback: {
        sessionId,
        rpcId,
        textDigest,
        observedSeq: readback.observedSeq,
        eventDigest: readback.eventDigest,
        baselineSeq: readback.baselineObservedSeq,
        baselineDigest: readback.baselineEventDigest,
        historyComplete: true,
        requestObserved: readback.requestObserved === true,
        turnOpen: false,
        sessionRunning: false,
        observedAt: new Date(terminalizedAt).toISOString(),
      },
      now: terminalizedAt,
    });
    if (executionTerminalization?.lifecycleStatus !== 'abandoned'
      || executionTerminalization?.recoveryStatus !== 'abandoned'
      || executionTerminalization?.exactIdentity !== true
      || executionTerminalization?.tombstone?.operationId !== operationId
      || executionTerminalization?.tombstone?.executionId !== executionId
      || executionTerminalization?.tombstone?.rpcId !== rpcId) {
      fail(
        'RECOVERY_RECONCILIATION_TERMINALIZATION_FAILED',
        'Unconsumed recovery did not form an exact permanent no-resend tombstone.',
      );
    }
  }
  const status = consumed
    ? 'submitted-observed'
    : readback.requestObserved === true ? 'observed-unconsumed' : 'not-observed-no-resend';
  const intentBytes = await readFile(intentFile);
  const receipt = {
    schemaVersion: 'forge-protected-headless-reconciliation/v2',
    status,
    completedAt: new Date(clock()).toISOString(),
    operationId,
    taskId,
    sessionId,
    rpcId,
    promptDigest: textDigest,
    phaseAttemptId,
    phaseId: requiredEnvironment(environment, 'FORGE_EVAL_PHASE_ID', TASK_ID_PATTERN),
    executionId,
    claimId,
    generation,
    contractId,
    sourceCommit: requiredEnvironment(environment, 'FORGE_EVAL_SOURCE_COMMIT', /^[0-9a-f]{40}$/u),
    maintenance,
    durableIntent: {
      file: path.basename(intentFile),
      sha256: sha256(intentBytes),
      automaticResendForbidden: true,
    },
    readback,
    executionConsumption,
    executionTerminalization,
    proofScope: {
      brokerExecutionContextConsumed: consumed,
      phaseGuardBound: false,
      classification: consumed
        ? 'broker-execution-context-consumed'
        : 'broker-execution-context-abandoned-after-stable-idle',
    },
    safeToRestoreUserIngress: true,
    safeToResend: false,
    cannotClaim: [
      'phase guard binding or protected execution projection completed',
      'backend phase accepted',
      'automatic prompt resend is safe',
    ],
  };
  const artifact = await writeContentAddressedReceipt(evidenceDirectory, operationId, receipt);
  return Object.freeze({ receipt, artifact });
}

async function assertNoDurableSubmissionIntent(evidenceDirectory, operationId) {
  const intentFile = path.join(evidenceDirectory, `submission-intent-${operationId}.json`);
  const information = await lstat(intentFile).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    fail('RECOVERY_RECONCILIATION_IDENTITY_DRIFT', 'Durable recovery intent could not be inspected safely.');
  });
  if (information !== undefined) {
    fail(
      'RECOVERY_PRE_INGRESS_CANCELLATION_BLOCKED',
      'A durable submission intent exists; pre-ingress cancellation is forbidden.',
    );
  }
  return true;
}

export async function cancelProtectedHeadlessRecoveryBeforeIngress({
  environment = process.env,
  loadPromptRequest = loadProtectedHeadlessPromptRequest,
  readCompleteSession = reconcileCompletePinnedDshSession,
  readStatus = readProtectedExecutionRecoveryStatus,
  abandonExecution = abandonClaimedProtectedExecutionRecovery,
  clock = Date.now,
} = {}) {
  const projectRoot = requiredEnvironment(environment, 'FORGE_EVAL_PROJECT_ROOT', /^\/[\s\S]{1,4095}$/u);
  const taskId = requiredEnvironment(environment, 'FORGE_TASKSPACE_ID', TASK_ID_PATTERN);
  const operationId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_OPERATION_ID', UUID_PATTERN,
  );
  const sessionId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_SESSION_ID', DSH_ID_PATTERN,
  );
  const rpcId = requiredEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_RPC_ID', RPC_ID_PATTERN);
  const expectedSessionCwd = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_SESSION_CWD', SESSION_CWD_PATTERN,
  );
  const maintenanceEpoch = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_EPOCH', MAINTENANCE_EPOCH_PATTERN,
  );
  const fenceFile = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_FENCE_FILE', /^\/[\s\S]{1,4095}$/u,
  );
  const evidenceDirectory = await assertEvidenceDirectory(requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EVIDENCE_DIRECTORY', /^\/[\s\S]{1,4095}$/u,
  ));
  const dshPort = portEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_DSH_PORT');
  const proxyPort = portEnvironment(environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_PROXY_PORT');
  const executionId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_ID', UUID_PATTERN,
  );
  const claimId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CLAIM_ID', UUID_PATTERN,
  );
  const phaseAttemptId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PHASE_ATTEMPT_ID', UUID_PATTERN,
  );
  const contractId = requiredEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CONTRACT_ID', SHA256_PATTERN,
  );
  const generation = integerEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_GENERATION',
  );
  const expectedBaselineSeq = integerEnvironment(
    environment, 'FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_BASELINE_SEQ',
  );
  const promptRequest = await loadPromptRequest({ environment, sessionId, rpcId });
  const textDigest = promptRequest.classified.textDigest;
  const maintenance = await verifyProtectedRecoveryMaintenance({
    fenceFile, epoch: maintenanceEpoch, proxyPort,
  });
  await assertNoDurableSubmissionIntent(evidenceDirectory, operationId);

  let executionStatus;
  try {
    executionStatus = Object.freeze({
      ...(await readStatus({
        projectRoot, taskId, operationId, executionId, claimId, generation, contractId, phaseAttemptId,
      })),
      exactIdentity: true,
    });
  } catch (error) {
    fail(
      'RECOVERY_RECONCILIATION_IDENTITY_DRIFT',
      `Exact protected execution status could not be proven (${error?.code ?? 'RECOVERY_CONSUMPTION_READ_FAILED'}).`,
    );
  }

  const tombstone = executionStatus.terminalTombstone;
  const alreadyCancelled = executionStatus.lifecycleStatus === 'abandoned'
    && executionStatus.recoveryStatus === 'abandoned'
    && tombstone?.operationId === operationId
    && tombstone?.phaseAttemptId === phaseAttemptId
    && tombstone?.executionId === executionId
    && tombstone?.claimId === claimId
    && tombstone?.generation === generation
    && tombstone?.contractId === contractId
    && tombstone?.rpcId === rpcId
    && tombstone?.dshSessionId === sessionId
    && tombstone?.textDigest === textDigest
    && tombstone?.reason === 'stable-idle-pre-ingress-cancelled-no-resend'
    && tombstone?.requestObserved === false
    && Number.isSafeInteger(tombstone?.observedSeq)
    && SHA256_PATTERN.test(tombstone?.eventDigest ?? '');

  let readback;
  let executionTerminalization;
  let preIngressState;
  if (alreadyCancelled) {
    if (executionStatus.recoveryReadbackSeq !== null
      && (executionStatus.recoveryReadbackSeq !== expectedBaselineSeq
        || !SHA256_PATTERN.test(executionStatus.recoveryReadbackDigest ?? ''))) {
      fail('RECOVERY_RECONCILIATION_IDENTITY_DRIFT', 'Cancelled recovery baseline identity drifted.');
    }
    preIngressState = executionStatus.recoveryReadbackSeq === null ? 'permitted' : 'submission-attempted';
    readback = Object.freeze({
      historyComplete: true,
      requestObserved: false,
      observedSeq: tombstone.observedSeq,
      eventDigest: tombstone.eventDigest,
      baselineObservedSeq: executionStatus.recoveryReadbackSeq,
      baselineEventDigest: executionStatus.recoveryReadbackDigest,
      turnOpen: false,
      pages: null,
      eventCount: null,
      session: { sessionId, running: false, cwd: expectedSessionCwd },
      reconstructedFromTerminalTombstone: true,
    });
    executionTerminalization = Object.freeze({
      lifecycleStatus: 'abandoned',
      recoveryStatus: 'abandoned',
      exactIdentity: true,
      idempotent: true,
      tombstone,
    });
  } else {
    const permitted = ['prepared', 'legacy-unverified'].includes(executionStatus.lifecycleStatus)
      && executionStatus.recoveryStatus === 'permitted'
      && executionStatus.recoveryReadbackSeq === null
      && executionStatus.recoveryReadbackDigest === null;
    const claimed = executionStatus.lifecycleStatus === 'submission-attempted'
      && executionStatus.recoveryStatus === 'submission-attempted'
      && executionStatus.recoveryReadbackSeq === expectedBaselineSeq
      && SHA256_PATTERN.test(executionStatus.recoveryReadbackDigest ?? '');
    if (!permitted && !claimed) {
      fail(
        'RECOVERY_PRE_INGRESS_CANCELLATION_BLOCKED',
        'Exact protected execution state is not cancellable before ingress.',
      );
    }
    preIngressState = permitted ? 'permitted' : 'submission-attempted';
    readback = await readCompleteSession({
      port: dshPort,
      sessionId,
      rpcId,
      textDigest,
      expectedCwd: expectedSessionCwd,
      ...(claimed ? {
        expectedBaselineSeq,
        expectedBaselineDigest: executionStatus.recoveryReadbackDigest,
      } : {}),
    });
    if (readback.historyComplete !== true || readback.requestObserved !== false
      || readback.turnOpen !== false || readback.session?.running !== false
      || readback.session?.sessionId !== sessionId
      || !Number.isSafeInteger(readback.observedSeq) || readback.observedSeq < 0
      || !SHA256_PATTERN.test(readback.eventDigest ?? '')
      || (permitted && readback.observedSeq !== expectedBaselineSeq)
      || (claimed && (readback.baselineObservedSeq !== expectedBaselineSeq
        || readback.baselineEventDigest !== executionStatus.recoveryReadbackDigest))) {
      fail(
        'RECOVERY_PRE_INGRESS_CANCELLATION_NOT_STABLE',
        'Pinned DSH session does not prove an exact stable pre-ingress boundary.',
      );
    }
    await assertNoDurableSubmissionIntent(evidenceDirectory, operationId);
    const terminalizedAt = clock();
    executionTerminalization = await abandonExecution({
      projectRoot,
      taskId,
      operationId,
      executionId,
      claimId,
      generation,
      contractId,
      phaseAttemptId,
      reason: 'stable-idle-pre-ingress-cancelled-no-resend',
      readback: {
        sessionId,
        rpcId,
        textDigest,
        observedSeq: readback.observedSeq,
        eventDigest: readback.eventDigest,
        baselineSeq: claimed ? expectedBaselineSeq : null,
        baselineDigest: claimed ? executionStatus.recoveryReadbackDigest : null,
        historyComplete: true,
        requestObserved: false,
        turnOpen: false,
        sessionRunning: false,
        observedAt: new Date(terminalizedAt).toISOString(),
      },
      now: terminalizedAt,
    });
    if (executionTerminalization?.lifecycleStatus !== 'abandoned'
      || executionTerminalization?.recoveryStatus !== 'abandoned'
      || executionTerminalization?.exactIdentity !== true
      || executionTerminalization?.tombstone?.reason
        !== 'stable-idle-pre-ingress-cancelled-no-resend'
      || executionTerminalization?.tombstone?.requestObserved !== false) {
      fail(
        'RECOVERY_RECONCILIATION_TERMINALIZATION_FAILED',
        'Pre-ingress recovery did not form an exact permanent no-resend tombstone.',
      );
    }
  }

  const receipt = {
    schemaVersion: 'forge-protected-headless-pre-ingress-cancellation/v1',
    status: 'not-observed-no-resend',
    completedAt: new Date(clock()).toISOString(),
    operationId,
    taskId,
    sessionId,
    rpcId,
    promptDigest: textDigest,
    phaseAttemptId,
    phaseId: requiredEnvironment(environment, 'FORGE_EVAL_PHASE_ID', TASK_ID_PATTERN),
    executionId,
    claimId,
    generation,
    contractId,
    sourceCommit: requiredEnvironment(environment, 'FORGE_EVAL_SOURCE_COMMIT', /^[0-9a-f]{40}$/u),
    maintenance,
    durableIntent: null,
    preIngressState,
    readback,
    executionStatus,
    executionTerminalization,
    proofScope: {
      brokerExecutionContextConsumed: false,
      ingressForwarded: false,
      phaseGuardBound: false,
      classification: 'broker-execution-context-abandoned-before-ingress',
    },
    safeToRestoreUserIngress: true,
    safeToResend: false,
    cannotClaim: [
      'the protected prompt reached ingress',
      'phase guard binding or protected execution projection completed',
      'backend phase accepted',
      'automatic prompt resend is safe',
    ],
  };
  const artifact = await writeContentAddressedReceipt(evidenceDirectory, operationId, receipt);
  return Object.freeze({ receipt, artifact });
}

function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return path.resolve(realpathSync(path.resolve(process.argv[1]))) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const action = process.env.FORGE_PROTECTED_HEADLESS_RECOVERY_ACTION ?? 'execute';
  const operation = action === 'execute'
    ? executeProtectedHeadlessRecoveryWithFailureReceipt
    : action === 'reconcile'
      ? reconcileProtectedHeadlessRecovery
      : action === 'cancel-pre-ingress'
        ? cancelProtectedHeadlessRecoveryBeforeIngress
      : null;
  (operation === null
    ? Promise.reject(new ProtectedHeadlessRecoveryError('RECOVERY_INPUT_INVALID', 'Recovery action is invalid.'))
    : operation())
    .then(({ receipt, artifact }) => {
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 'forge-protected-headless-recovery-cli/v1',
        status: receipt.status,
        receiptFile: path.basename(artifact.file),
        receiptSha256: artifact.sha256,
        receiptBytes: artifact.bytes,
      })}\n`);
      if (![
        'accepted', 'submitted-observed', 'observed-unconsumed', 'not-observed-no-resend',
        'pre-ingress-failed',
      ]
        .includes(receipt.status)) process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`protected headless execution recovery failed [${error?.code ?? 'RECOVERY_FAILED'}]: ${error.message}\n`);
      process.exitCode = 1;
    });
}
