import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { readCompletePinnedDshSessionHistory } from './forge-recover-headless-execution.mjs';
import {
  digestDirectUserTextContent,
  validateProtectedExecutionContext,
} from './forge-execution-context.mjs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_ID_PATTERN = /^[^\0\r\n]{1,1024}$/u;
const PHASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const BASELINE_SCHEMA = 'forge-delivery-phase-browser-session-baseline/v1';
const PROOF_SCHEMA = 'forge-delivery-phase-browser-session-proof/v1';
const INTERRUPTION_PROOF_SCHEMA = 'forge-delivery-phase-browser-interruption-proof/v1';
const READONLY_DENIAL_PROOF_SCHEMA = 'forge-delivery-frontend-readonly-denial-proof/v1';
const ACCESS_SCOPE_DENIAL_PROOF_SCHEMA = 'forge-delivery-access-scope-denial-proof/v1';
const REQUIREMENTS_OVERLOAD_SCHEMA = 'forge-delivery-requirements-provider-overload-proof/v1';
const REQUIREMENTS_OVERLOAD_MESSAGE = 'Codex error: Our servers are currently overloaded. Please try again later.';
const ACCESS_CONTEXT_FAILURE_SCHEMA = 'forge-delivery-access-context-failure-proof/v1';
const ACCESS_PROVIDER_FAILURE_SCHEMA = 'forge-delivery-phase-provider-failure-proof/v1';
const ACCESS_CONTEXT_FAILURE_MESSAGE = 'Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.';
const ACCESS_COMPACTION_TIMEOUT_MESSAGE = 'pi-ai stream idle timeout after 300000ms';
const READONLY_DENIAL = 'FORGE_PHASE_BUDGET_GUARD_V1: the protected contract or current prompt constrains this execution to read-only; natural-language write intent cannot raise the ceiling.';
const ACCESS_SCOPE_DENIAL = "FORGE_PHASE_BUDGET_GUARD_V1: source mutation is outside the protected contract's repository-relative owned paths and fails closed";
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_RESPONSE_BYTES = 2 * 1024 * 1024;

export class ForgeDeliveryBrowserSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeDeliveryBrowserSessionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeDeliveryBrowserSessionError(code, message);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalEventDigest(events) {
  const hash = crypto.createHash('sha256');
  for (const event of events) hash.update(`${JSON.stringify(event)}\n`);
  return hash.digest('hex');
}

function executionIdentity(execution) {
  try {
    validateProtectedExecutionContext(execution);
  } catch {
    fail('BROWSER_SESSION_EXECUTION_INVALID', 'Manager execution identity is incomplete or invalid.');
  }
  if (!['production-read-only', 'production-task-writer'].includes(execution.authorityClass)
    || execution.testOnly !== false
    || execution.route !== 'session.prompt' || execution.classification !== 'claimable-text'
    || execution.mode !== 'queue' || !SAFE_ID_PATTERN.test(execution.executionId ?? '')
    || !Number.isSafeInteger(execution.generation) || execution.generation < 1
    || !SAFE_ID_PATTERN.test(execution.projectSlug ?? '')
    || !SAFE_ID_PATTERN.test(execution.taskId ?? '')
    || !SAFE_ID_PATTERN.test(execution.actorUserId ?? '')
    || !SAFE_ID_PATTERN.test(execution.actorUsername ?? '')
    || !SAFE_ID_PATTERN.test(execution.conversationId ?? '')
    || !SAFE_ID_PATTERN.test(execution.dshSessionId ?? '')
    || !SAFE_ID_PATTERN.test(execution.rpcId ?? '')
    || !COMMIT_PATTERN.test(execution.sourceCommit ?? '')
    || (execution.authorityClass === 'production-read-only' && execution.workspaceFingerprint !== null)
    || (execution.authorityClass === 'production-task-writer'
      && !SHA256_PATTERN.test(execution.workspaceFingerprint ?? ''))
    || !SAFE_ID_PATTERN.test(execution.workflowId ?? '')
    || !PHASE_ID_PATTERN.test(execution.phaseId ?? '')
    || !Number.isSafeInteger(execution.phaseIndex) || execution.phaseIndex < 0
    || !SAFE_ID_PATTERN.test(execution.phaseCatalogVersion ?? '')
    || !SHA256_PATTERN.test(execution.phaseCatalogDigest ?? '')
    || !SHA256_PATTERN.test(execution.contractId ?? '')
    || !SHA256_PATTERN.test(execution.textDigest ?? '')) {
    fail('BROWSER_SESSION_EXECUTION_INVALID', 'Manager execution identity is incomplete or invalid.');
  }
  return Object.freeze({
    executionId: execution.executionId,
    generation: execution.generation,
    projectSlug: execution.projectSlug,
    taskId: execution.taskId,
    actorUserId: execution.actorUserId,
    actorUsername: execution.actorUsername,
    conversationId: execution.conversationId,
    dshSessionId: execution.dshSessionId,
    rpcId: execution.rpcId,
    sourceCommit: execution.sourceCommit,
    workspaceFingerprint: execution.workspaceFingerprint,
    workflowId: execution.workflowId,
    phaseId: execution.phaseId,
    phaseIndex: execution.phaseIndex,
    phaseCatalogVersion: execution.phaseCatalogVersion,
    phaseCatalogDigest: execution.phaseCatalogDigest,
    contractId: execution.contractId,
    textDigest: execution.textDigest,
  });
}

function eventRpcId(event) {
  if (event?.type !== 'user/message') return undefined;
  const message = event.data?.message && typeof event.data.message === 'object'
    ? event.data.message : event.data;
  return message?.source?.kind === 'user' && typeof message.source.rpcId === 'string'
    ? message.source.rpcId : undefined;
}

function isHumanUserMessage(event) {
  if (event?.type !== 'user/message') return false;
  const message = event.data?.message && typeof event.data.message === 'object'
    ? event.data.message : event.data;
  return message?.source?.kind === 'user';
}

function directUserContent(event) {
  const message = event?.data?.message && typeof event.data.message === 'object'
    ? event.data.message : event.data;
  return message?.content;
}

function validateHistory(history, identity) {
  if (history === null || typeof history !== 'object' || !Array.isArray(history.events)
    || !Number.isSafeInteger(history.pages) || history.pages < 1
    || history.eventCount !== history.events.length
    || history.session?.sessionId !== identity.dshSessionId
    || typeof history.session?.cwd !== 'string' || history.session.cwd.length < 1
    || history.session?.running !== false
    || typeof history.session?.blank !== 'boolean') {
    fail('BROWSER_SESSION_HISTORY_INVALID', 'Complete idle DSH history is invalid or belongs to another session.');
  }
  let previous = -1;
  for (const event of history.events) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)
      || !Number.isSafeInteger(event.seq) || event.seq < 0 || event.seq <= previous
      || typeof event.type !== 'string' || event.type.length < 1) {
      fail('BROWSER_SESSION_HISTORY_INVALID', 'Complete DSH history is malformed or unordered.');
    }
    previous = event.seq;
  }
  return history;
}

function identityMatches(baseline, identity) {
  return Object.keys(identity).every((key) => baseline[key] === identity[key]);
}

export async function prepareForgeDeliveryBrowserSessionBaseline({
  execution,
  port,
  expectedCwd,
  readHistory = readCompletePinnedDshSessionHistory,
}) {
  const identity = executionIdentity(execution);
  const history = validateHistory(await readHistory({
    port,
    sessionId: identity.dshSessionId,
    rpcId: identity.rpcId,
    textDigest: identity.textDigest,
    expectedCwd,
  }), identity);
  if (history.events.some((event) => eventRpcId(event) === identity.rpcId)) {
    fail('BROWSER_SESSION_RPC_REPLAY', 'The execution RPC already exists in the private session baseline.');
  }
  return Object.freeze({
    schemaVersion: BASELINE_SCHEMA,
    ...identity,
    eventCount: history.events.length,
    observedSeq: history.events.at(-1)?.seq ?? 0,
    eventDigest: canonicalEventDigest(history.events),
    sessionCwd: history.session.cwd,
  });
}

function validateBaseline(baseline, identity) {
  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)
    || baseline.schemaVersion !== BASELINE_SCHEMA || !identityMatches(baseline, identity)
    || !Number.isSafeInteger(baseline.eventCount) || baseline.eventCount < 0
    || !Number.isSafeInteger(baseline.observedSeq) || baseline.observedSeq < 0
    || !SHA256_PATTERN.test(baseline.eventDigest ?? '')
    || typeof baseline.sessionCwd !== 'string' || baseline.sessionCwd.length < 1) {
    fail('BROWSER_SESSION_BASELINE_INVALID', 'Private browser session baseline does not match the Manager execution.');
  }
}

function toolCallId(event) {
  const value = event?.data?.callId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toolResultCallId(event) {
  const message = event?.data?.message && typeof event.data.message === 'object'
    ? event.data.message : {};
  const value = message.source?.callId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function assistantText(event) {
  const message = event?.data?.message && typeof event.data.message === 'object'
    ? event.data.message : event.data;
  if (message?.role !== 'assistant' || !Array.isArray(message.content)) return undefined;
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function completionClaimCorrection(segment, execution, latestText, latestSeq) {
  if (!isAccessWriterExecution(execution)) return null;
  const start = '<forge-phase-artifact>'; const end = '</forge-phase-artifact>';
  if (latestText.includes(start) || latestText.includes(end)) return null;
  const answers = segment.filter(event => event.type === 'assistant/message');
  const marked = answers.filter(event => {
    const text = assistantText(event);
    return typeof text === 'string' && (text.includes(start) || text.includes(end));
  });
  if (marked.length !== 1) return null;
  const original = marked[0]; const text = assistantText(original);
  const first = text.indexOf(start); const last = text.indexOf(end);
  if (first < 0 || last <= first || text.indexOf(start, first + 1) !== -1 || text.indexOf(end, last + 1) !== -1) return null;
  const block = text.slice(first, last + end.length);
  let proposal;
  try { proposal = JSON.parse(text.slice(first + start.length, last)); } catch { return null; }
  if (proposal?.schemaVersion !== 'forge-delivery-phase-proposal/v1' || proposal.phaseId !== execution.phaseId) return null;
  const guardEvents = []; let awaitingAnswer = false; let lastAnswer = original.seq;
  for (const event of segment.slice(segment.indexOf(original) + 1)) {
    if (event.type === 'user/message') {
      const message = event.data?.message ?? event.data;
      if (awaitingAnswer || message?.role !== 'user' || message.source?.kind !== 'plugin'
        || message.source.plugin !== 'forge-completion-claim-guard' || message.source.rpcId !== undefined
        || !Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== 'text'
        || !/^FORGE_COMPLETION_CLAIM_GUARD_V1: Your latest assistant response contains a broad completion claim \("[^"\r\n]{1,160}"\) while the same response reports failed, blocked, unexecuted, or unverified required evidence\. Do not repeat the broad completion claim\. Reissue a corrected final status that separates implemented candidate work from executed proof, lists every bounded blocker, and does not call the task completed, passed, verified, accepted, or fully delivered\.$/u.test(message.content[0].text ?? '')) return null;
      guardEvents.push(event); awaitingAnswer = true;
    } else if (event.type === 'assistant/message') {
      if (!awaitingAnswer || event.data?.turn !== original.data?.turn || !assistantText(event)) return null;
      awaitingAnswer = false; lastAnswer = event.seq;
    } else if (!['assistant/chunk', 'step/start', 'step/end', 'agent/inbox/spliced', 'turn/end'].includes(event.type)) return null;
  }
  if (guardEvents.length === 0 || awaitingAnswer || lastAnswer !== latestSeq) return null;
  return { modelResponse: `${latestText}\n\n${block}`, proof: {
    schemaVersion: 'forge-delivery-completion-claim-correction/v1',
    artifactMessageSeq: original.seq, artifactMessageSha256: sha256(Buffer.from(text, 'utf8')),
    artifactBlockSha256: sha256(Buffer.from(block, 'utf8')),
    latestAssistantMessageSeq: latestSeq, latestAssistantMessageSha256: sha256(Buffer.from(latestText, 'utf8')),
    guardMessageSeqs: guardEvents.map(event => event.seq), guardEventsDigest: canonicalEventDigest(guardEvents),
  } };
}

function toolDataWithoutPrunedContent(event) {
  const data = event?.data;
  const message = data?.message;
  const block = message?.content?.[0];
  if (event?.type !== 'tool/result'
    || !Number.isSafeInteger(data?.turn) || data.turn < 0
    || !Number.isSafeInteger(data?.step) || data.step < 0
    || !SAFE_ID_PATTERN.test(message?.id ?? '') || message?.role !== 'user'
    || message?.source?.kind !== 'tool' || toolResultCallId(event) === undefined
    || !Array.isArray(message.content) || message.content.length !== 1
    || block?.type !== 'tool-result' || !Array.isArray(block.content)) {
    fail('BROWSER_SESSION_TOOL_EVIDENCE_INVALID', 'A pruned tool result or its source is malformed.');
  }
  return { ...data, message: { ...message, content: [{ ...block, content: null }] } };
}

function inspectPrunedToolResults(prefix, segment, turn) {
  const priorResults = new Map(prefix.filter((event) => event.type === 'tool/result')
    .map((event) => [event.seq, event]));
  const prunedResultSeqs = new Set();
  const shadowedSeqs = new Set();
  for (let index = 0; index < segment.length; index += 1) {
    const event = segment[index];
    if (event.type === 'compaction/prune') {
      const replacement = segment[index + 1];
      const operation = replacement?.surfaceOp;
      const sourceSeq = operation?.start;
      const source = priorResults.get(sourceSeq);
      const range = event.data?.shadowedRange;
      const citations = replacement?.sourceEventSeqs;
      const pricedSeqs = event.data?.shadowedSeqs;
      if (replacement?.type !== 'tool/result' || replacement.seq !== event.seq + 1
        || operation?.op !== 'replace' || !Number.isSafeInteger(sourceSeq) || sourceSeq < 0
        || operation.end !== sourceSeq || source === undefined || source.seq >= event.seq
        || shadowedSeqs.has(sourceSeq)
        || (source.seq < segment[0].seq ? source.data?.turn >= turn : source.data?.turn !== turn)
        || range?.start !== sourceSeq || range?.end !== sourceSeq
        || !Array.isArray(citations) || citations.length !== 1 || citations[0] !== sourceSeq
        || !Array.isArray(pricedSeqs) || pricedSeqs.length !== 1 || pricedSeqs[0] !== sourceSeq
        || !Number.isSafeInteger(event.data?.shadowedTokenCount) || event.data.shadowedTokenCount < 0
        || !isDeepStrictEqual(toolDataWithoutPrunedContent(source), toolDataWithoutPrunedContent(replacement))) {
        fail('BROWSER_SESSION_TOOL_EVIDENCE_INVALID', 'A browser tool-result prune does not match its exact prior result.');
      }
      // Native DSH retains the source turn and call identity when replacing content.
      // Keep the raw events in the terminal digest; this is not another execution.
      prunedResultSeqs.add(replacement.seq);
      shadowedSeqs.add(sourceSeq);
    } else if (event.type === 'tool/result') {
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append' && !prunedResultSeqs.has(event.seq)) {
        fail('BROWSER_SESSION_TOOL_EVIDENCE_INVALID', 'A browser tool-result replacement has no matching prune.');
      }
      priorResults.set(event.seq, event);
    }
  }
  return prunedResultSeqs;
}

function isReadonlyRequirementsExecution(execution) {
  return execution.phaseId === 'requirements' && execution.phaseIndex === 0
    && execution.authorityClass === 'production-read-only' && execution.actionCeiling === 'read-only'
    && execution.contract?.actionCeiling === 'read-only'
    && Array.isArray(execution.ownedPaths) && execution.ownedPaths.length === 0
    && Array.isArray(execution.contract.ownedPaths) && execution.contract.ownedPaths.length === 0;
}

function requirementsOverloadEvidence(segment) {
  const reason = segment.at(-1)?.data?.reason;
  const error = reason?.error;
  if (reason?.kind !== 'error' || error?.code !== 'PI_AI_ERROR' || error.message !== REQUIREMENTS_OVERLOAD_MESSAGE
    || segment.some((event) => event.type === 'assistant/message' || /^(?:tool\/|tool-)/u.test(event.type))) return null;
  const chunks = segment.filter((event) => event.type === 'assistant/chunk').map((event) => event.data?.chunk);
  const usages = chunks.filter((chunk) => chunk?.type === 'usage');
  const finishes = chunks.filter((chunk) => chunk?.type === 'finish');
  if (usages.length !== 1 || finishes.length !== 1 || chunks.length !== 2
    || usages[0].usage?.inputTokens !== 0 || usages[0].usage?.outputTokens !== 0
    || Object.values(usages[0].usage).some((value) => value !== 0)
    || finishes[0].reason?.kind !== 'error' || finishes[0].reason.failure?.code !== error.code
    || finishes[0].reason.failure?.message !== error.message) return null;
  return Object.freeze({ code: error.code, message: error.message });
}

export function validateForgeRequirementsOverloadProof({ execution, baseline, proof }) {
  const identity = executionIdentity(execution);
  validateBaseline(baseline, identity);
  const keys = ['schemaVersion', ...Object.keys(identity), 'baselineObservedSeq', 'requestSeq', 'terminalSeq',
    'terminalReason', 'error', 'inputTokens', 'outputTokens', 'toolCallCount', 'toolResultCount',
    'terminalEventDigest', 'sessionCwd', 'sessionRunning', 'historyPages', 'historyEventCount', 'hostReceiptsDerived'];
  if (!isReadonlyRequirementsExecution(execution) || proof === null || typeof proof !== 'object'
    || JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(keys.sort())
    || proof.schemaVersion !== REQUIREMENTS_OVERLOAD_SCHEMA
    || Object.keys(identity).some((key) => proof[key] !== identity[key])
    || proof.terminalReason !== 'requirements-provider-overload' || proof.error?.code !== 'PI_AI_ERROR'
    || proof.error.message !== REQUIREMENTS_OVERLOAD_MESSAGE
    || Object.keys(proof.error).sort().join(',') !== 'code,message'
    || proof.inputTokens !== 0 || proof.outputTokens !== 0 || proof.toolCallCount !== 0 || proof.toolResultCount !== 0
    || proof.sessionRunning !== false || proof.hostReceiptsDerived !== false
    || proof.sessionCwd !== baseline.sessionCwd || proof.baselineObservedSeq !== baseline.observedSeq
    || !Number.isSafeInteger(proof.requestSeq) || proof.requestSeq <= baseline.observedSeq
    || !Number.isSafeInteger(proof.terminalSeq) || proof.terminalSeq <= proof.requestSeq
    || !SHA256_PATTERN.test(proof.terminalEventDigest ?? '')
    || !Number.isSafeInteger(proof.historyPages) || proof.historyPages < 1
    || !Number.isSafeInteger(proof.historyEventCount) || proof.historyEventCount <= baseline.eventCount) {
    fail('BROWSER_SESSION_OVERLOAD_PROOF_INVALID', 'Provider failure proof is not the retained zero-output readonly requirements turn.');
  }
  return proof;
}

function isAccessWriterExecution(execution) {
  return execution.workflowId === 'crud-production' && execution.phaseId === 'access-wiring'
    && execution.phaseIndex === 6 && execution.authorityClass === 'production-task-writer'
    && execution.actionCeiling === 'workspace-write' && execution.contract?.actionCeiling === 'workspace-write';
}

function accessProviderFailureEvidence(segment, prunedResultSeqs, request) {
  const terminal = segment.at(-1);
  const reason = terminal?.data?.reason;
  const error = reason?.error;
  if (reason?.kind !== 'error' || error?.code !== 'PI_AI_ERROR'
    || typeof error.message !== 'string' || error.message.trim().length === 0
    || Buffer.byteLength(error.message, 'utf8') > 8192
    || Object.keys(error).sort().join(',') !== 'code,message') return null;
  const tools = segment.filter(event => ['tool/call', 'tool/result'].includes(event.type) && !prunedResultSeqs.has(event.seq));
  if (!tools.some(event => event.type === 'tool/call')
    || tools.some(event => event.seq <= request.seq || event.seq >= terminal.seq)) return null;
  return Object.freeze({ code: error.code, message: error.message });
}

export function validateForgeAccessProviderFailureProof({ execution, baseline, proof }) {
  const identity = executionIdentity(execution);
  validateBaseline(baseline, identity);
  const keys = ['schemaVersion', ...Object.keys(identity), 'baselineObservedSeq', 'requestSeq', 'terminalSeq',
    'terminalReason', 'error', 'toolCallCount', 'toolResultCount', 'terminalEventDigest',
    'sessionCwd', 'sessionRunning', 'historyPages', 'historyEventCount', 'hostReceiptsDerived'];
  if (!isAccessWriterExecution(execution) || proof === null || typeof proof !== 'object' || Array.isArray(proof)
    || JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(keys.sort())
    || proof.schemaVersion !== ACCESS_PROVIDER_FAILURE_SCHEMA
    || Object.keys(identity).some(key => proof[key] !== identity[key])
    || proof.terminalReason !== 'error' || proof.error?.code !== 'PI_AI_ERROR'
    || typeof proof.error.message !== 'string' || proof.error.message.trim().length === 0
    || Buffer.byteLength(proof.error.message, 'utf8') > 8192 || Object.keys(proof.error).sort().join(',') !== 'code,message'
    || !Number.isSafeInteger(proof.toolCallCount) || proof.toolCallCount < 1
    || proof.toolResultCount !== proof.toolCallCount
    || proof.sessionRunning !== false || proof.hostReceiptsDerived !== false
    || proof.sessionCwd !== baseline.sessionCwd || proof.baselineObservedSeq !== baseline.observedSeq
    || !Number.isSafeInteger(proof.requestSeq) || proof.requestSeq <= baseline.observedSeq
    || !Number.isSafeInteger(proof.terminalSeq) || proof.terminalSeq <= proof.requestSeq
    || !SHA256_PATTERN.test(proof.terminalEventDigest ?? '')
    || !Number.isSafeInteger(proof.historyPages) || proof.historyPages < 1
    || !Number.isSafeInteger(proof.historyEventCount) || proof.historyEventCount <= baseline.eventCount) {
    fail('BROWSER_SESSION_PROVIDER_FAILURE_PROOF_INVALID', 'Provider failure proof is not the retained access writer turn with completed tool calls.');
  }
  return proof;
}

function accessContextFailureEvidence(segment, prunedResultSeqs, request) {
  const terminal = segment.at(-1);
  const reason = terminal?.data?.reason;
  const error = reason?.error;
  if (reason?.kind !== 'error' || error?.code !== 'CONTEXT_WINDOW_EXCEEDED'
    || error.message !== ACCESS_CONTEXT_FAILURE_MESSAGE
    || segment.some((event) => event.type === 'assistant/message'
      || (/^(?:tool\/|tool-)/u.test(event.type) && !prunedResultSeqs.has(event.seq)))) return null;
  const chunks = segment.filter((event) => event.type === 'assistant/chunk');
  if (chunks.length !== 2 || chunks[0].data?.chunk?.type !== 'usage'
    || chunks[1].data?.chunk?.type !== 'finish') return null;
  const usage = chunks[0].data.chunk.usage;
  const finish = chunks[1].data.chunk.reason;
  if (usage?.inputTokens !== 0 || usage?.outputTokens !== 0
    || Object.values(usage).some((value) => value !== 0)
    || chunks[0].seq <= request.seq || finish?.kind !== 'error'
    || finish.failure?.code !== error.code || finish.failure?.message !== error.message) return null;
  if (segment.some((event) => event.type.startsWith('compaction/')
    && !['compaction/start', 'compaction/end', 'compaction/prune'].includes(event.type))) return null;
  const failures = segment.filter((event) => ['compaction/start', 'compaction/end'].includes(event.type));
  if (failures.length !== 4 || failures.some((event, index) => event.type !== (index % 2 === 0 ? 'compaction/start' : 'compaction/end')
    || event.data?.turn !== terminal.data.turn)) return null;
  for (const index of [0, 2]) {
    if (!SAFE_ID_PATTERN.test(failures[index].data?.compactionId ?? '')
      || failures[index].data.compactionId !== failures[index + 1].data?.compactionId) return null;
  }
  if (failures[0].data.compactionId === failures[2].data.compactionId
    || failures[1].data.error !== ACCESS_COMPACTION_TIMEOUT_MESSAGE || failures[1].seq >= request.seq
    || failures[2].seq <= chunks[1].seq || failures[3].seq >= terminal.seq
    || failures[3].data.error !== error.message) return null;
  return Object.freeze({ error: Object.freeze({ code: error.code, message: error.message }),
    compactionFailureDigest: canonicalEventDigest(failures) });
}

export function validateForgeAccessContextFailureProof({ execution, baseline, proof }) {
  const identity = executionIdentity(execution);
  validateBaseline(baseline, identity);
  const keys = ['schemaVersion', ...Object.keys(identity), 'baselineObservedSeq', 'requestSeq', 'terminalSeq',
    'terminalReason', 'error', 'inputTokens', 'outputTokens', 'toolCallCount', 'toolResultCount',
    'compactionFailureDigest', 'terminalEventDigest', 'sessionCwd', 'sessionRunning', 'historyPages',
    'historyEventCount', 'hostReceiptsDerived'];
  if (!isAccessWriterExecution(execution) || proof === null || typeof proof !== 'object' || Array.isArray(proof)
    || JSON.stringify(Object.keys(proof).sort()) !== JSON.stringify(keys.sort())
    || proof.schemaVersion !== ACCESS_CONTEXT_FAILURE_SCHEMA
    || Object.keys(identity).some((key) => proof[key] !== identity[key])
    || proof.terminalReason !== 'context-failure' || proof.error?.code !== 'CONTEXT_WINDOW_EXCEEDED'
    || proof.error.message !== ACCESS_CONTEXT_FAILURE_MESSAGE || Object.keys(proof.error).sort().join(',') !== 'code,message'
    || proof.inputTokens !== 0 || proof.outputTokens !== 0 || proof.toolCallCount !== 0 || proof.toolResultCount !== 0
    || proof.sessionRunning !== false || proof.hostReceiptsDerived !== false
    || proof.sessionCwd !== baseline.sessionCwd || proof.baselineObservedSeq !== baseline.observedSeq
    || !Number.isSafeInteger(proof.requestSeq) || proof.requestSeq <= baseline.observedSeq
    || !Number.isSafeInteger(proof.terminalSeq) || proof.terminalSeq <= proof.requestSeq
    || !SHA256_PATTERN.test(proof.compactionFailureDigest ?? '') || !SHA256_PATTERN.test(proof.terminalEventDigest ?? '')
    || !Number.isSafeInteger(proof.historyPages) || proof.historyPages < 1
    || !Number.isSafeInteger(proof.historyEventCount) || proof.historyEventCount <= baseline.eventCount) {
    fail('BROWSER_SESSION_CONTEXT_FAILURE_PROOF_INVALID', 'Context failure proof is not the retained zero-output access writer turn.');
  }
  return proof;
}

function terminalSegment(events, baseline, identity, allowUserAborted, allowRequirementsOverload = false, allowAccessContextFailure = false, allowAccessProviderFailure = false) {
  const prefix = events.slice(0, baseline.eventCount);
  if (prefix.length !== baseline.eventCount
    || (prefix.at(-1)?.seq ?? 0) !== baseline.observedSeq
    || canonicalEventDigest(prefix) !== baseline.eventDigest) {
    fail('BROWSER_SESSION_BASELINE_DRIFT', 'Complete DSH history no longer contains the exact private baseline.');
  }
  const appended = events.slice(baseline.eventCount);
  const requestIndexes = appended
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => eventRpcId(event) === identity.rpcId);
  if (requestIndexes.length !== 1) {
    fail('BROWSER_SESSION_RPC_MISMATCH', 'Complete DSH history does not contain exactly one matching execution RPC.');
  }
  const requestIndex = requestIndexes[0].index;
  let requestTextDigest;
  try {
    requestTextDigest = digestDirectUserTextContent(directUserContent(requestIndexes[0].event));
  } catch {
    fail('BROWSER_SESSION_REQUEST_INVALID', 'The matching execution RPC has invalid direct user content.');
  }
  if (requestTextDigest !== identity.textDigest) {
    fail('BROWSER_SESSION_REQUEST_DIGEST_MISMATCH', 'The matching execution RPC text differs from the Manager execution.');
  }
  const startIndexes = appended
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'turn/start');
  const endIndexes = appended
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'turn/end');
  if (endIndexes.length === 0) {
    fail('BROWSER_SESSION_TURN_UNFINISHED', 'The matching browser turn has not completed.');
  }
  const targetStarts = startIndexes.filter(({ index }) => index < endIndexes[0].index);
  if (targetStarts.length !== 1
    || startIndexes[0].index >= requestIndex || endIndexes[0].index <= requestIndex
    || !Number.isSafeInteger(startIndexes[0].event.data?.turn) || startIndexes[0].event.data.turn < 0) {
    fail('BROWSER_SESSION_INTERLEAVED_TURN', 'Another turn preceded the execution RPC after the private baseline.');
  }
  const startIndex = startIndexes[0].index;
  const endIndex = endIndexes[0].index;
  const turn = startIndexes[0].event.data.turn;
  const segment = appended.slice(startIndex, endIndex + 1);
  const beforeTurn = appended.slice(0, startIndex);
  const trailing = appended.slice(endIndex + 1);
  // Manager may recover this immutable execution after a later conversation.
  // Only complete, separate later turns may follow; none enters this proof.
  let laterTurn = null;
  let lastTurn = turn;
  let laterHumanMessages = 0;
  const invalidTrailing = trailing.some((event) => {
    if (event.type === 'turn/start') {
      if (laterTurn !== null || !Number.isSafeInteger(event.data?.turn) || event.data.turn <= lastTurn) return true;
      laterTurn = event.data.turn;
      laterHumanMessages = 0;
      return false;
    }
    if (!['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end',
      'agent/error', 'agent-error', 'agent/end', 'session/end'].includes(event.type)) return false;
    if (laterTurn === null || (event.data?.turn !== undefined && event.data.turn !== laterTurn)) return true;
    if (isHumanUserMessage(event) && (++laterHumanMessages !== 1 || eventRpcId(event) === undefined)) return true;
    if (event.type === 'turn/end') {
      if (event.data?.turn !== laterTurn || laterHumanMessages !== 1 || event.data?.reason?.kind !== 'completed') return true;
      lastTurn = laterTurn;
      laterTurn = null;
    }
    return false;
  });
  const humanMessages = segment.filter(isHumanUserMessage);
  if (humanMessages.length !== 1 || humanMessages[0] !== requestIndexes[0].event
    || beforeTurn.some((event) => isHumanUserMessage(event) || [
      'assistant/message', 'tool/call', 'tool/result', 'turn/end',
      'agent/error', 'agent-error', 'agent/end', 'session/end',
    ].includes(event.type))
    || invalidTrailing || laterTurn !== null) {
    fail('BROWSER_SESSION_INTERLEAVED_TURN', 'The matching browser turn is interleaved with another turn.');
  }
  if (segment.some((event) => ['agent/error', 'agent-error', 'agent/end', 'session/end'].includes(event.type))) {
    fail('BROWSER_SESSION_TURN_ERROR', 'The matching browser turn ended with an agent or session error.');
  }
  const prunedResultSeqs = inspectPrunedToolResults(prefix, segment, turn);
  if (segment.some((event) => event.data?.turn !== undefined && event.data.turn !== turn
    && !prunedResultSeqs.has(event.seq))) {
    fail('BROWSER_SESSION_INTERLEAVED_TURN', 'The matching browser turn identity changed before completion.');
  }
  const terminal = segment.at(-1);
  const userAborted = allowUserAborted === true && terminal.data?.reason?.kind === 'aborted'
    && terminal.data.reason.reason?.kind === 'user';
  const providerOverload = allowRequirementsOverload ? requirementsOverloadEvidence(segment) : null;
  const contextFailure = allowAccessContextFailure ? accessContextFailureEvidence(segment, prunedResultSeqs, requestIndexes[0].event) : null;
  const accessProviderFailure = allowAccessProviderFailure ? accessProviderFailureEvidence(segment, prunedResultSeqs, requestIndexes[0].event) : null;
  if (terminal.data?.reason?.kind !== 'completed' && !userAborted && providerOverload === null && contextFailure === null && accessProviderFailure === null) {
    fail('BROWSER_SESSION_TURN_ERROR', 'The matching browser turn did not end as completed.');
  }
  return { segment, request: requestIndexes[0].event, terminal, prunedResultSeqs, providerOverload, contextFailure, accessProviderFailure };
}

function inspectTools(segment, prunedResultSeqs) {
  const pending = new Map();
  const results = [];
  let callCount = 0;
  let resultCount = 0;
  for (const event of segment) {
    if (event.type === 'tool/call') {
      const callId = toolCallId(event);
      if (callId === undefined || pending.has(callId)) {
        fail('BROWSER_SESSION_TOOL_EVIDENCE_INVALID', 'The browser turn contains an invalid or duplicate tool call.');
      }
      pending.set(callId, { callId, callSeq: event.seq,
        tool: typeof event.data?.name === 'string' ? event.data.name : null });
      callCount += 1;
    } else if (event.type === 'tool/result') {
      if (prunedResultSeqs.has(event.seq)) continue;
      const callId = toolResultCallId(event);
      const call = callId === undefined ? undefined : pending.get(callId);
      if (call === undefined) {
        fail('BROWSER_SESSION_TOOL_EVIDENCE_INVALID', 'The browser turn contains an unmatched tool result.');
      }
      pending.delete(callId);
      const message = event.data?.message && typeof event.data.message === 'object'
        ? event.data.message : {};
      const resultBlock = Array.isArray(message.content)
        ? message.content.find((block) => block?.type === 'tool-result') : undefined;
      const isError = Boolean(resultBlock?.isError ?? message.isError ?? event.data?.isError ?? event.data?.error);
      results.push(Object.freeze({ ...call, resultSeq: event.seq, status: isError ? 'error' : 'success' }));
      resultCount += 1;
    }
  }
  if (pending.size > 0) fail('BROWSER_SESSION_TOOL_UNFINISHED', 'The browser turn contains an unfinished tool call.');
  return { callCount, resultCount, results: Object.freeze(results) };
}

export async function captureForgeDeliveryBrowserPhaseTerminal({
  execution,
  baseline,
  port,
  expectedCwd,
  readHistory = readCompletePinnedDshSessionHistory,
  allowUserAborted,
}) {
  if (allowUserAborted !== undefined && allowUserAborted !== true) {
    fail('BROWSER_SESSION_ARGUMENT_INVALID', 'User-aborted capture must be explicitly enabled with true.');
  }
  const identity = executionIdentity(execution);
  validateBaseline(baseline, identity);
  const history = validateHistory(await readHistory({
    port,
    sessionId: identity.dshSessionId,
    rpcId: identity.rpcId,
    textDigest: identity.textDigest,
    expectedCwd,
  }), identity);
  if (history.session.cwd !== baseline.sessionCwd) {
    fail('BROWSER_SESSION_IDENTITY_DRIFT', 'The DSH session identity differs from the private baseline.');
  }
  const { segment, request, terminal, prunedResultSeqs, providerOverload, contextFailure, accessProviderFailure } = terminalSegment(
    history.events, baseline, identity, allowUserAborted, isReadonlyRequirementsExecution(execution), isAccessWriterExecution(execution), isAccessWriterExecution(execution));
  const tools = inspectTools(segment, prunedResultSeqs);
  if (accessProviderFailure !== null) {
    const proof = Object.freeze({ schemaVersion: ACCESS_PROVIDER_FAILURE_SCHEMA, ...identity,
      baselineObservedSeq: baseline.observedSeq, requestSeq: request.seq, terminalSeq: terminal.seq,
      terminalReason: 'error', error: accessProviderFailure,
      toolCallCount: tools.callCount, toolResultCount: tools.resultCount,
      terminalEventDigest: canonicalEventDigest(segment), sessionCwd: history.session.cwd, sessionRunning: false,
      historyPages: history.pages, historyEventCount: history.eventCount, hostReceiptsDerived: false });
    validateForgeAccessProviderFailureProof({ execution, baseline, proof });
    return Object.freeze({ providerFailureProof: proof });
  }
  if (contextFailure !== null) {
    const proof = Object.freeze({ schemaVersion: ACCESS_CONTEXT_FAILURE_SCHEMA, ...identity,
      baselineObservedSeq: baseline.observedSeq, requestSeq: request.seq, terminalSeq: terminal.seq,
      terminalReason: 'context-failure', error: contextFailure.error,
      inputTokens: 0, outputTokens: 0, toolCallCount: tools.callCount, toolResultCount: tools.resultCount,
      compactionFailureDigest: contextFailure.compactionFailureDigest,
      terminalEventDigest: canonicalEventDigest(segment), sessionCwd: history.session.cwd, sessionRunning: false,
      historyPages: history.pages, historyEventCount: history.eventCount, hostReceiptsDerived: false });
    validateForgeAccessContextFailureProof({ execution, baseline, proof });
    return Object.freeze({ contextFailureProof: proof });
  }
  if (providerOverload !== null) {
    const proof = Object.freeze({ schemaVersion: REQUIREMENTS_OVERLOAD_SCHEMA, ...identity,
      baselineObservedSeq: baseline.observedSeq, requestSeq: request.seq, terminalSeq: terminal.seq,
      terminalReason: 'requirements-provider-overload', error: providerOverload,
      inputTokens: 0, outputTokens: 0, toolCallCount: tools.callCount, toolResultCount: tools.resultCount,
      terminalEventDigest: canonicalEventDigest(segment), sessionCwd: history.session.cwd, sessionRunning: false,
      historyPages: history.pages, historyEventCount: history.eventCount, hostReceiptsDerived: false });
    validateForgeRequirementsOverloadProof({ execution, baseline, proof });
    return Object.freeze({ providerFailureProof: proof });
  }
  if (terminal.data.reason.kind === 'aborted') {
    return Object.freeze({
      interruptionProof: Object.freeze({
        schemaVersion: INTERRUPTION_PROOF_SCHEMA,
        ...identity,
        baselineObservedSeq: baseline.observedSeq,
        requestSeq: request.seq,
        terminalSeq: terminal.seq,
        terminalReason: 'user-aborted',
        toolCallCount: tools.callCount,
        toolResultCount: tools.resultCount,
        toolResults: tools.results,
        terminalEventDigest: canonicalEventDigest(segment),
        sessionCwd: history.session.cwd,
        sessionRunning: false,
        historyPages: history.pages,
        historyEventCount: history.eventCount,
        hostReceiptsDerived: false,
      }),
    });
  }
  let modelResponse = '';
  let assistantMessageSeq = null;
  for (const event of segment) {
    if (event.type !== 'assistant/message') continue;
    const text = assistantText(event);
    if (text === undefined) {
      fail('BROWSER_SESSION_ASSISTANT_INVALID', 'The browser turn contains a malformed assistant message.');
    }
    if (text !== '') {
      modelResponse = text;
      assistantMessageSeq = event.seq;
    }
  }
  if (modelResponse.length === 0 || assistantMessageSeq === null) {
    fail('BROWSER_SESSION_ASSISTANT_MISSING', 'The completed browser turn has no assistant response text.');
  }
  const claimCorrection = completionClaimCorrection(segment, execution, modelResponse, assistantMessageSeq);
  if (claimCorrection !== null) modelResponse = claimCorrection.modelResponse;
  if (Buffer.byteLength(modelResponse, 'utf8') > MAX_MODEL_RESPONSE_BYTES) {
    fail('BROWSER_SESSION_RESPONSE_OVERSIZED', 'The browser assistant response exceeds the Controller limit.');
  }
  return Object.freeze({
    modelResponse,
    sessionProof: Object.freeze({
      schemaVersion: PROOF_SCHEMA,
      ...identity,
      baselineObservedSeq: baseline.observedSeq,
      requestSeq: request.seq,
      assistantMessageSeq,
      terminalSeq: terminal.seq,
      terminalReason: 'completed',
      toolCallCount: tools.callCount,
      toolResultCount: tools.resultCount,
      toolResults: tools.results,
      modelResponseSha256: sha256(Buffer.from(modelResponse, 'utf8')),
      terminalEventDigest: canonicalEventDigest(segment),
      sessionCwd: history.session.cwd,
      historyPages: history.pages,
      historyEventCount: history.eventCount,
      hostReceiptsDerived: false,
      ...(claimCorrection === null ? {} : { completionClaimCorrection: claimCorrection.proof }),
    }),
  });
}

export async function inspectForgeFrontendReadOnlyDenial({
  execution,
  baseline,
  sessionProof,
  port,
  expectedCwd,
  readHistory = readCompletePinnedDshSessionHistory,
}) {
  const identity = executionIdentity(execution);
  validateBaseline(baseline, identity);
  const history = validateHistory(await readHistory({
    port, sessionId: identity.dshSessionId, rpcId: identity.rpcId,
    textDigest: identity.textDigest, expectedCwd,
  }), identity);
  const captured = await captureForgeDeliveryBrowserPhaseTerminal({
    execution, baseline, port, expectedCwd, readHistory: async () => history,
  });
  const { historyPages: retainedPages, historyEventCount: retainedCount, ...retainedTurn } = sessionProof ?? {};
  const { historyPages: currentPages, historyEventCount: currentCount, ...currentTurn } = captured.sessionProof;
  if (!Number.isSafeInteger(retainedPages) || retainedPages < 1
    || !Number.isSafeInteger(retainedCount) || retainedCount < 0
    || !Number.isSafeInteger(currentPages) || currentPages < retainedPages
    || !Number.isSafeInteger(currentCount) || currentCount < retainedCount
    || !isDeepStrictEqual(retainedTurn, currentTurn)) {
    fail('BROWSER_SESSION_PROOF_MISMATCH', 'Read-only denial inspection differs from the retained completed session proof.');
  }
  const { segment } = terminalSegment(history.events, baseline, identity);
  const eventsBySeq = new Map(segment.map((event) => [event.seq, event]));
  const denials = [];
  for (const result of captured.sessionProof.toolResults) {
    if (!/^(?:write|edit)$/iu.test(result.tool ?? '') || result.status !== 'error') continue;
    const event = eventsBySeq.get(result.resultSeq);
    const message = event.data?.message && typeof event.data.message === 'object' ? event.data.message : {};
    const resultBlock = Array.isArray(message.content)
      ? message.content.find((block) => block?.type === 'tool-result') : undefined;
    if ((resultBlock?.isError ?? message.isError ?? event.data?.isError) !== true) continue;
    const content = resultBlock?.content ?? message.content ?? event.data?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text).join('\n') : '';
    if (![READONLY_DENIAL, `Error: ${READONLY_DENIAL}`].includes(text.trim())) continue;
    denials.push(Object.freeze({ ...result, denialCode: 'GLOBAL_READ_ONLY_CONSTRAINT',
      resultTextSha256: sha256(Buffer.from(text, 'utf8')) }));
  }
  if (denials.length === 0) return Object.freeze({ status: 'not-applicable' });
  return Object.freeze({
    status: 'readonly-denial-proven',
    proof: Object.freeze({
      schemaVersion: READONLY_DENIAL_PROOF_SCHEMA,
      ...identity,
      baselineObservedSeq: sessionProof.baselineObservedSeq,
      requestSeq: sessionProof.requestSeq,
      terminalSeq: sessionProof.terminalSeq,
      terminalReason: 'completed',
      terminalEventDigest: sessionProof.terminalEventDigest,
      modelResponseSha256: sessionProof.modelResponseSha256,
      sessionProofDigest: sha256(Buffer.from(JSON.stringify(sessionProof), 'utf8')),
      sessionCwd: history.session.cwd,
      sessionRunning: false,
      toolCallCount: sessionProof.toolCallCount,
      toolResultCount: sessionProof.toolResultCount,
      denials: Object.freeze(denials),
      hostReceiptsDerived: false,
    }),
  });
}

function accessScopeAttemptedPath(call) {
  let argumentsValue = call?.data?.arguments;
  if (typeof argumentsValue === 'string') {
    try { argumentsValue = JSON.parse(argumentsValue); } catch { return undefined; }
  }
  if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) return undefined;
  const keys = ['file_path', 'path'].filter((key) => Object.hasOwn(argumentsValue, key));
  if (keys.length === 0 || keys.some((key) => typeof argumentsValue[key] !== 'string')) return undefined;
  const requestedPath = argumentsValue[keys[0]];
  if (keys.some((key) => argumentsValue[key] !== requestedPath)
    || requestedPath.length < 1 || requestedPath.length > 4096
    || /[\x00-\x1f\x7f\\:?#]/u.test(requestedPath)) return undefined;
  const relative = requestedPath.startsWith('/workspace/') ? requestedPath.slice('/workspace/'.length)
    : requestedPath.startsWith('./') ? requestedPath.slice(2) : requestedPath;
  if (relative.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) return undefined;
  return relative;
}

export async function inspectForgeAccessScopeDenial({
  execution,
  baseline,
  sessionProof,
  port,
  expectedCwd,
  readHistory = readCompletePinnedDshSessionHistory,
}) {
  const identity = executionIdentity(execution);
  validateBaseline(baseline, identity);
  if (identity.workflowId !== 'crud-production' || identity.phaseId !== 'access-wiring' || identity.phaseIndex !== 6
    || execution.authorityClass !== 'production-task-writer' || execution.actionCeiling !== 'workspace-write') {
    return Object.freeze({ status: 'not-applicable' });
  }
  const history = validateHistory(await readHistory({
    port, sessionId: identity.dshSessionId, rpcId: identity.rpcId,
    textDigest: identity.textDigest, expectedCwd,
  }), identity);
  const captured = await captureForgeDeliveryBrowserPhaseTerminal({
    execution, baseline, port, expectedCwd, readHistory: async () => history,
  });
  const { historyPages: retainedPages, historyEventCount: retainedCount, ...retainedTurn } = sessionProof ?? {};
  const { historyPages: currentPages, historyEventCount: currentCount, ...currentTurn } = captured.sessionProof;
  if (!Number.isSafeInteger(retainedPages) || retainedPages < 1
    || !Number.isSafeInteger(retainedCount) || retainedCount < 0
    || !Number.isSafeInteger(currentPages) || currentPages < retainedPages
    || !Number.isSafeInteger(currentCount) || currentCount < retainedCount
    || !isDeepStrictEqual(retainedTurn, currentTurn)) {
    fail('BROWSER_SESSION_PROOF_MISMATCH', 'Access scope denial inspection differs from the retained completed session proof.');
  }
  const { segment } = terminalSegment(history.events, baseline, identity);
  const eventsBySeq = new Map(segment.map((event) => [event.seq, event]));
  const denials = [];
  for (const result of captured.sessionProof.toolResults) {
    if (!/^(?:write|edit)$/iu.test(result.tool ?? '') || result.status !== 'error') continue;
    const event = eventsBySeq.get(result.resultSeq);
    const message = event.data?.message && typeof event.data.message === 'object' ? event.data.message : {};
    const resultBlock = Array.isArray(message.content)
      ? message.content.find((block) => block?.type === 'tool-result') : undefined;
    if ((resultBlock?.isError ?? message.isError ?? event.data?.isError) !== true) continue;
    const content = resultBlock?.content ?? message.content ?? event.data?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text).join('\n') : '';
    if (![ACCESS_SCOPE_DENIAL, `Error: ${ACCESS_SCOPE_DENIAL}`].includes(text.trim())) continue;
    const attemptedPath = accessScopeAttemptedPath(eventsBySeq.get(result.callSeq));
    if (attemptedPath === undefined) continue;
    denials.push(Object.freeze({ ...result, denialCode: 'OWNED_PATH_SCOPE_CONSTRAINT', attemptedPath,
      resultTextSha256: sha256(Buffer.from(text, 'utf8')) }));
  }
  if (denials.length === 0) return Object.freeze({ status: 'not-applicable' });
  return Object.freeze({
    status: 'access-scope-denial-proven',
    proof: Object.freeze({
      schemaVersion: ACCESS_SCOPE_DENIAL_PROOF_SCHEMA,
      ...identity,
      baselineObservedSeq: sessionProof.baselineObservedSeq,
      requestSeq: sessionProof.requestSeq,
      terminalSeq: sessionProof.terminalSeq,
      terminalReason: 'completed',
      terminalEventDigest: sessionProof.terminalEventDigest,
      modelResponseSha256: sessionProof.modelResponseSha256,
      sessionProofDigest: sha256(Buffer.from(JSON.stringify(sessionProof), 'utf8')),
      sessionCwd: history.session.cwd,
      sessionRunning: false,
      toolCallCount: sessionProof.toolCallCount,
      toolResultCount: sessionProof.toolResultCount,
      denials: Object.freeze(denials),
      hostReceiptsDerived: false,
    }),
  });
}

async function readStdinJson() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) fail('BROWSER_SESSION_STDIN_OVERSIZED', 'Browser session CLI input exceeds the fixed limit.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('BROWSER_SESSION_STDIN_INVALID', 'Browser session CLI input is not valid JSON.');
  }
}

function fixedInternalPort(environment) {
  const raw = environment.HARNESS_INTERNAL_PORT ?? '3080';
  if (!/^[1-9][0-9]{0,4}$/u.test(raw)) fail('BROWSER_SESSION_PORT_INVALID', 'HARNESS_INTERNAL_PORT is invalid.');
  const port = Number.parseInt(raw, 10);
  if (port > 65535) fail('BROWSER_SESSION_PORT_INVALID', 'HARNESS_INTERNAL_PORT is invalid.');
  return port;
}

async function main(argv) {
  if (argv.length !== 1 || !['baseline', 'capture', 'inspect-readonly-denial', 'inspect-access-scope-denial'].includes(argv[0])) {
    fail('BROWSER_SESSION_ARGUMENT_INVALID', 'Command must be exactly baseline, capture, inspect-readonly-denial or inspect-access-scope-denial.');
  }
  const input = await readStdinJson();
  const interruptionRequested = argv[0] === 'capture' && input !== null && typeof input === 'object'
    && Object.hasOwn(input, 'allowUserAborted');
  const expectedKeys = argv[0] === 'baseline' ? ['execution']
    : ['inspect-readonly-denial', 'inspect-access-scope-denial'].includes(argv[0]) ? ['baseline', 'execution', 'sessionProof']
      : [...(interruptionRequested ? ['allowUserAborted'] : []), 'baseline', 'execution'];
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(expectedKeys)
    || (interruptionRequested && input.allowUserAborted !== true)) {
    fail('BROWSER_SESSION_STDIN_INVALID', 'Browser session CLI input shape is invalid.');
  }
  const common = {
    execution: input.execution,
    port: fixedInternalPort(process.env),
    expectedCwd: '/workspace',
  };
  const result = argv[0] === 'baseline'
    ? await prepareForgeDeliveryBrowserSessionBaseline(common)
    : argv[0] === 'inspect-readonly-denial'
      ? await inspectForgeFrontendReadOnlyDenial({ ...common, baseline: input.baseline, sessionProof: input.sessionProof })
      : argv[0] === 'inspect-access-scope-denial'
        ? await inspectForgeAccessScopeDenial({ ...common, baseline: input.baseline, sessionProof: input.sessionProof })
        : await captureForgeDeliveryBrowserPhaseTerminal({ ...common, baseline: input.baseline,
          ...(interruptionRequested ? { allowUserAborted: true } : {}) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`forge browser phase session: ${error.code ?? 'ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
