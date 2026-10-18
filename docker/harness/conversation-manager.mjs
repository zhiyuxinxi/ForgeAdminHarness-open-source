import { createConversationIntentResolver } from './forge-conversation-intent.mjs';
import { loadRuntimeVersions, publicRuntimeVersion, resolveRuntimeVersion, RuntimeVersionError } from './harness-runtime-versions.mjs';
import { routeRuntimeManagerRequest } from './runtime-manager-routing.mjs';
import { createManagerConversationIntentInterpreter } from './forge-conversation-intent-model.mjs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink,
} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { readProjectReleaseStatus } from './project-release-status.mjs';
import { hasActiveForgeTaskWriter } from './forge-writer-scope-lease.mjs';
import { fileURLToPath } from 'node:url';
import { createConversationOutputStore } from './conversation-output-store.mjs';
import { isExecutionRenewalAuthorityRequest } from './conversation-gateway.mjs';
import { createPhaseWorkPackageFiles, PhaseWorkPackageFilesError } from './phase-work-package-files.mjs';

import {
  timingSafeTextEqual,
  validateConversationId,
  validateTaskId,
} from './conversation-policy.mjs';
import { createProjectMaterialStore, ProjectMaterialError } from './project-materials.mjs';
import {
  ProtectedExecutionError,
  classifyPinnedDshPromptBody,
  digestDirectUserTextContent,
  hasDirectControlledPreparationIntent,
  hasGlobalReadOnlyIntent,
  isDatabasePhaseWriter,
  isRenewableWorkflowPhaseWriter,
  MAX_CLAIMABLE_PROMPT_BYTES,
  prepareProtectedExecutionContext,
  readCurrentProtectedExecutionContextForTask,
  validateProtectedExecutionContext,
} from './forge-execution-context.mjs';
import {
  prepareForgeDeliveryBrowserPhase,
  prepareForgeCrossLayerPreparation,
  prepareForgeCrossLayerRuntimeReprobe,
  readForgeCrossLayerRuntimeReprobe,
  isForgeFrontendLeasePauseProposal,
  isForgeAccessWiringLeasePauseProposal,
  prepareForgeRequirementsClarification,
  prepareForgeDomainUserAbortContinuation,
  prepareForgeDomainCandidateCorrection,
  prepareForgeDatabaseLeaseContinuation,
  validateForgeDomainUserAbortedEvidence,
  beginForgeDeliveryBrowserPhase,
  preflightForgeDeliveryPhaseRun,
  inspectForgeCrossLayerHostVerificationReuse,
  readForgeCompletedApiContract,
  finalizeForgeDeliveryPhaseRun,
  rejectForgeDeliveryPhaseRun,
  prepareForgeFrontendRepairContinuation,
  prepareForgeAccessWiringRepairContinuation,
  prepareForgeAccessAcceptedCorrection,
  prepareForgeAccessWiringRuntimeRepairContinuation,
  readForgeAccessWiringRepairContinuation,
  validateForgeFrontendUserAbortedEvidence,
  retryForgeFrontendUserAbortedPhase,
  validateForgeRequirementsOverloadEvidence,
  retryForgeRequirementsOverloadPhase,
  retryForgeBackendUnfinishedPhase,
  retryForgeAccessWiringScopeDeniedPhase,
  isForgeBackendUnfinishedCandidate,
  isForgeFrontendReadonlyRoleRecoveryCandidate,
  retryForgeFrontendReadonlyRolePhase,
  createForgeDeliveryPhaseFormatRetryPrompt,
} from './forge-delivery-phase-controller.mjs';
import {
  loadForgeDeliveryPhaseCatalog,
  currentForgeAccessAcceptedCorrection,
  readForgeDeliveryPhaseState,
  withForgeDeliveryPhaseStateLock,
} from './forge-delivery-phase-runtime.mjs';
import { observeForgeDeliveryPhase, snapshotForgeDeliveryWorkspace } from './forge-delivery-phase-workspace-observer.mjs';
import { parseForgeDeliveryPhaseProposal } from './forge-delivery-phase-response.mjs';
import { validateForgeAccessContextFailureProof, validateForgeAccessProviderFailureProof } from './forge-delivery-phase-browser-session.mjs';
import { collectForgePhaseHostReceipts, readForgePhaseHostReceipt } from './forge-delivery-phase-host-receipts.mjs';
import { isForgeAccessWiringLeaseContinuation, isForgeFrontendLeaseContinuation, isForgeBackendLeaseContinuation, isForgeBackendEvidenceContinuation, isForgeBackendPhaseCompletion, isForgeFrontendPhaseCompletion, isForgeAccessWiringPhaseCompletion, isForgeCrossLayerPhaseCompletion, isForgeAccessWiringMigrationRepairContinuation, isForgeDatabaseEvidenceContinuation, isForgeDatabaseLeaseContinuation, isForgeConversationTaskContinuation, isForgeConversationRepairContinuation, isForgeDomainContractContinuation, isForgeDomainCandidateCorrection, isForgeDomainAcceptanceContinuation } from './forge-protected-acceptance-service.mjs';
import { isForgeCrossLayerPreparationContinuation, isForgeCrossLayerRuntimeReprobeContinuation, isForgeAccessWiringRuntimeRepairContinuation, isForgeBackendRuntimeRepairContinuation } from './forge-protected-acceptance-service.mjs';
import { previewGovernanceRoleGrants } from './forge-governance.mjs';
import {
  taskspaceSupportsProtectedExecution,
  validateActorUserId,
  validateSourceTransition,
  validateTaskspaceMetadata,
} from './taskspace-policy.mjs';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_EXECUTION_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_PHASE_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_EXECUTION_PREPARE_BYTES = 4 * MAX_CLAIMABLE_PROMPT_BYTES + 64 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const PROTECTED_CAPABILITY_TIMEOUT_MS = 5_000;
const SOURCE_OBSERVATION_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_SOURCE_TRANSITION_BYTES = 64 * 1024;
const ACTOR_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const CONTROL_FAILURE_RULES = Object.freeze([
  ['CONTROL_DEPENDENCY_UNREADABLE', ['control dependencies are not readable']],
  ['PROJECT_INCOMPLETE', ['project is missing or incomplete']],
  ['TASKSPACE_COMPOSE_UNAVAILABLE', ['taskspace compose template is unavailable']],
  ['PORT_REGISTRY_UNAVAILABLE', ['taskspace port registry is unavailable']],
  ['REGISTRY_LOCK_UNWRITABLE', ['taskspace registry lock is not writable']],
  ['DELIVERY_OWNER_UNRESOLVABLE', [
    'delivery owner does not exist',
    'delivery owner numeric identity is unavailable',
    'delivery owner name and numeric uid do not match',
  ]],
  ['ACTOR_USER_ID_INVALID', ['actor user id is invalid']],
  ['ACTOR_ID_INVALID', ['actor id is invalid']],
  ['CONVERSATION_ID_INVALID', ['conversation id is invalid']],
  ['ACCESS_MODE_INVALID', ['taskspace access mode must be']],
  ['INTEGRATION_WORKSPACE_DIRTY', ['canonical integration workspace is dirty']],
  ['TASKSPACE_NETWORK_UNAVAILABLE', ['project taskspace network is unavailable']],
  ['TASKSPACE_BROKER_UNHEALTHY', ['project taskspace broker is not healthy']],
  ['TASKSPACE_ALREADY_EXISTS', ['taskspace already exists']],
  ['TASKSPACE_PORT_EXHAUSTED', ['no free taskspace port remains']],
  ['TASKSPACE_PORT_CONFLICT', ['taskspace port is already allocated or listening']],
  ['TASKSPACE_STAGING_CONFLICT', ['taskspace staging directory already exists']],
  ['EXTERNAL_SKILL_BUNDLE_INVALID', ['external skill', 'active external skill']],
  ['GOVERNANCE_CONTEXT_FAILED', ['taskspace governance context could not be']],
  ['MAINTENANCE_FENCE_INVALID', ['taskspace maintenance', 'taskspace mutation fence']],
  ['DOCKER_ADDRESS_POOL_EXHAUSTED', ['all predefined address pools have been fully subnetted']],
  ['TASKSPACE_RECOVERY_FAILED', ['taskspace provisioning recovery failed']],
  ['DOCKER_UNAVAILABLE', ['docker daemon is not accessible']],
  ['DOCKER_COMPOSE_UNAVAILABLE', ['docker compose v2+ is required']],
  ['CONTROL_DEPENDENCY_MISSING', ['required command is missing']],
  ['TASKSPACE_PROVISIONING_FAILED', ['taskspace provisioning failed']],
]);

class ManagerError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function readPrivatePhaseBytes(file, maximumBytes = MAX_EXECUTION_REQUEST_BYTES) {
  const info = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info === null) return null;
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximumBytes
    || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw new ManagerError('PHASE_PRIVATE_RECORD_INVALID', '阶段执行记录不可用。', 503);
  }
  return readFile(file);
}

async function readPrivatePhaseJson(file, maximumBytes = MAX_EXECUTION_REQUEST_BYTES) {
  const bytes = await readPrivatePhaseBytes(file, maximumBytes);
  return bytes === null ? null : JSON.parse(bytes.toString('utf8'));
}

async function writePrivatePhaseJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

export function inspectForgeCrossLayerPreparationTerminal({ execution, history }) {
  const invalid = () => {
    throw Object.assign(new Error('The current preparation RPC has no unique recoverable native terminal.'),
      { code: 'PHASE_PREPARATION_TERMINAL_INVALID' });
  };
  if (history?.session?.sessionId !== execution.dshSessionId || history.session.cwd !== '/workspace'
    || history.session.running !== false || !Array.isArray(history.events)
    || history.eventCount !== history.events.length || !Number.isSafeInteger(history.pages) || history.pages < 1) invalid();
  const events = history.events;
  if (events.some((event, index) => !Number.isSafeInteger(event?.seq) || event.seq < 0
    || (index > 0 && event.seq <= events[index - 1].seq))) invalid();
  const userMessage = event => event?.type === 'user/message'
    ? (event.data?.message ?? event.data) : null;
  const matches = events.map((event, index) => ({ event, index }))
    .filter(({ event }) => userMessage(event)?.source?.kind === 'user'
      && userMessage(event).source.rpcId === execution.rpcId);
  if (matches.length !== 1) invalid();
  const { event: request, index: requestIndex } = matches[0];
  if (digestDirectUserTextContent(userMessage(request).content) !== execution.textDigest) invalid();
  let startIndex = requestIndex - 1;
  while (startIndex >= 0 && events[startIndex].type !== 'turn/start') startIndex -= 1;
  const endIndex = events.findIndex((event, index) => index > requestIndex && event.type === 'turn/end');
  if (startIndex < 0 || endIndex < 0) invalid();
  const turn = events[startIndex].data?.turn;
  const terminal = events[endIndex];
  const turnEvents = events.slice(startIndex + 1, endIndex);
  const toolCallCount = turnEvents.filter(event => event.type === 'tool/call').length;
  const isCompactedOldResult = (event, index) => {
    const previous = events[startIndex + index];
    const shadowed = previous?.data?.shadowedSeqs;
    const message = event.data?.message;
    return event.seq < request.seq && Number.isSafeInteger(event.data?.turn)
      && event.data.turn >= 0 && event.data.turn < turn
      && previous?.type === 'compaction/prune' && previous.seq + 1 === event.seq
      && Array.isArray(shadowed) && shadowed.length === 1 && Number.isSafeInteger(shadowed[0])
      && shadowed[0] >= 0 && shadowed[0] < events[startIndex].seq
      && previous.data.shadowedRange?.start === shadowed[0] && previous.data.shadowedRange?.end === shadowed[0]
      && message?.source?.kind === 'tool' && typeof message.source.callId === 'string' && message.source.callId.length > 0
      && Array.isArray(message.content) && message.content.length === 1
      && message.content[0]?.type === 'tool-result' && message.content[0].toolCallId === message.source.callId;
  };
  const toolResultCount = turnEvents.filter((event, index) => event.type === 'tool/result'
    && !isCompactedOldResult(event, index)).length;
  const terminalReason = terminal.data?.reason?.kind;
  const terminalErrorCode = terminal.data?.reason?.error?.code;
  const unusedProviderError = terminalReason === 'error' && terminalErrorCode === 'PI_AI_ERROR'
    && toolCallCount === 0 && toolResultCount === 0;
  if (!Number.isSafeInteger(turn) || turn < 0 || terminal.data?.turn !== turn
    || (request.data?.turn !== undefined && request.data.turn !== turn)
    || (terminalReason !== 'completed' && !unusedProviderError)
    || turnEvents.some(event => ['turn/start', 'turn/end'].includes(event.type)
      || (userMessage(event)?.source?.kind === 'user' && event !== request))
    || events.slice(endIndex + 1).some(event => ['turn/start', 'turn/end', 'assistant/message', 'tool/call', 'tool/result'].includes(event.type)
      || userMessage(event)?.source?.kind === 'user')) invalid();
  return Object.freeze({ executionId: execution.executionId, generation: execution.generation,
    dshSessionId: execution.dshSessionId, rpcId: execution.rpcId, textDigest: execution.textDigest,
    requestSeq: request.seq, terminalSeq: terminal.seq, turn, terminalReason, sessionRunning: false,
    ...(unusedProviderError ? { terminalErrorCode, toolCallCount, toolResultCount } : {}),
    terminalEventDigest: crypto.createHash('sha256').update(JSON.stringify(terminal)).digest('hex') });
}

export async function readForgeCrossLayerPreparationTerminal({ execution, call }) {
  const invalid = () => {
    throw Object.assign(new Error('The complete current preparation turn is unavailable.'),
      { code: 'PHASE_PREPARATION_TERMINAL_INVALID' });
  };
  const session = async () => {
    const result = await call({ method: 'session.list', payload: {} });
    const matches = result.value?.items?.filter(item => item?.sessionId === execution.dshSessionId);
    if (!Array.isArray(matches) || matches.length !== 1) invalid();
    const item = matches[0];
    if (item.running === true) throw Object.assign(new Error('Preparation is still running.'), { code: 'RECOVERY_SESSION_NOT_IDLE' });
    if (item.running !== false || item.cwd !== '/workspace' || item.blank !== false
      || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0) invalid();
    return { sessionId: item.sessionId, cwd: item.cwd, blank: item.blank, running: item.running, updatedAt: item.updatedAt };
  };
  const before = await session();
  const bySequence = new Map(); let beforeSeq;
  for (let pages = 1; pages <= 8; pages += 1) {
    const result = await call({ method: 'session.history', maxBytes: 16 * 1024 * 1024,
      payload: { sessionId: execution.dshSessionId, maxMessages: 12, ...(beforeSeq === undefined ? {} : { beforeSeq }) } });
    if (!Array.isArray(result.value?.events) || typeof result.value.hasMore !== 'boolean') invalid();
    let minimum;
    for (const wrapper of result.value.events) {
      const event = wrapper?.event;
      if (!Number.isSafeInteger(event?.seq) || event.seq < 0 || typeof event.type !== 'string'
        || bySequence.has(event.seq) || (beforeSeq !== undefined && event.seq >= beforeSeq)) invalid();
      bySequence.set(event.seq, event);
      minimum = minimum === undefined ? event.seq : Math.min(minimum, event.seq);
    }
    if (minimum === undefined) invalid();
    const events = [...bySequence.values()].sort((left, right) => left.seq - right.seq);
    const requests = events.map((event, index) => ({ event, index })).filter(({ event }) => {
      const message = event.data?.message ?? event.data;
      return event.type === 'user/message' && message?.source?.kind === 'user' && message.source.rpcId === execution.rpcId;
    });
    if (requests.length > 1) invalid();
    if (requests.length === 1 && events.slice(0, requests[0].index).some(event => event.type === 'turn/start')) {
      // This page completes the requested turn. Older turns are irrelevant;
      // hasMore may truthfully remain true and is not an acceptance obligation.
      const after = await session();
      if (JSON.stringify(before) !== JSON.stringify(after)) invalid();
      return inspectForgeCrossLayerPreparationTerminal({ execution,
        history: { events, pages, eventCount: events.length, session: after } });
    }
    if (result.value.hasMore !== true) invalid();
    beforeSeq = minimum;
  }
  invalid();
}

function capturePromptSessionActivity({ projectSlug, taskId }) {
  // The task has its own native server. Read that server, never a project-wide
  // busy flag; a different task's conversation cannot block this prompt.
  const script = `import { callPinnedDsh } from '/usr/local/lib/forge-recover-headless-execution.mjs';
const port = Number(process.env.HARNESS_INTERNAL_PORT ?? '3080');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port');
const result = await callPinnedDsh({ port, method: 'session.list', payload: {} });
const items = result.value?.items;
if (!Array.isArray(items) || items.some(item => typeof item?.running !== 'boolean')) throw new Error('sessions');
process.stdout.write(JSON.stringify({ running: items.some(item => item.running) }));`;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', `forge-${projectSlug}-task-${taskId}-harness-1`,
      'node', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks = []; let bytes = 0; let settled = false;
    const unavailable = () => new ManagerError('CONVERSATION_ACTIVITY_UNAVAILABLE', '暂时无法确认上一轮执行状态，本次请求尚未进入模型。', 503);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(unavailable()); }, 10_000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 1024) { child.kill('SIGTERM'); finish(unavailable()); } else chunks.push(chunk); });
    child.on('error', () => finish(unavailable()));
    child.on('close', code => {
      if (code !== 0) return finish(unavailable());
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof result.running !== 'boolean') throw new Error('sessions');
        finish(null, result);
      } catch { finish(unavailable()); }
    });
  });
}

function captureCrossLayerPreparationTerminal({ projectSlug, taskId, execution }) {
  // Run the already installed native reader in the fixed task Harness. Only the
  // bound terminal proof crosses stdout; full history and model text stay there.
  const script = `import crypto from 'node:crypto';
import { callPinnedDsh } from '/usr/local/lib/forge-recover-headless-execution.mjs';
import { digestDirectUserTextContent, validateProtectedExecutionContext } from '/usr/local/lib/forge-execution-context.mjs';
${inspectForgeCrossLayerPreparationTerminal.toString()}
${readForgeCrossLayerPreparationTerminal.toString()}
const deadline = setTimeout(() => { process.stderr.write('forge preparation terminal: TIMEOUT'); process.exit(1); }, 55_000);
try {
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 1048576) throw new Error('input'); }
  const execution = JSON.parse(input); validateProtectedExecutionContext(execution);
  const rawPort = process.env.HARNESS_INTERNAL_PORT ?? '3080';
  if (!/^[1-9][0-9]{0,4}$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('port');
  const proof = await readForgeCrossLayerPreparationTerminal({ execution, call: input => callPinnedDsh({ ...input, port: Number(rawPort) }) });
  process.stdout.write(JSON.stringify(proof));
} catch (error) { process.stderr.write('forge preparation terminal: ' + (error.code ?? 'UNAVAILABLE')); process.exitCode = 1; }
finally { clearTimeout(deadline); }`;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', `forge-${projectSlug}-task-${taskId}-harness-1`,
      'node', '--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks = []; const diagnostics = []; let bytes = 0; let diagnosticBytes = 0; let settled = false;
    const unavailable = () => new ManagerError('PHASE_PREPARATION_TERMINAL_UNAVAILABLE', '暂时无法证明上一轮运行准备已经结束，尚未启动新执行。', 503);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(unavailable()); }, 60_000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) { child.kill('SIGTERM'); finish(unavailable()); } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes <= 4096) diagnostics.push(chunk); });
    child.on('error', () => finish(unavailable())); child.stdin.on('error', () => finish(unavailable()));
    child.on('close', code => {
      if (code !== 0) {
        if (Buffer.concat(diagnostics).toString('utf8').includes('RECOVERY_SESSION_NOT_IDLE')) {
          return finish(new ManagerError('PHASE_CONVERSATION_STILL_RUNNING', '上一轮运行准备仍在执行，请等它结束后继续。', 409));
        }
        return finish(unavailable());
      }
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(unavailable()); }
    });
    child.stdin.end(JSON.stringify(execution));
  });
}

function captureBrowserPhaseSession({ projectSlug, taskId, execution, baseline, sessionProof, allowUserAborted }, action = 'baseline') {
  // Fixed image entry point, fixed task container, input over stdin. This does
  // not expose a command or a Docker capability to the model or the browser.
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'exec', '-i', `forge-${projectSlug}-task-${taskId}-harness-1`,
      'node', '/usr/local/lib/forge-delivery-phase-browser-session.mjs', action,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    const diagnostics = [];
    let diagnosticBytes = 0;
    let bytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const unavailable = () => action === 'baseline'
      ? new ManagerError('PHASE_SESSION_BASELINE_UNAVAILABLE', '无法确认当前对话已空闲，阶段尚未发送给模型。', 503)
      : new ManagerError('PHASE_SESSION_CAPTURE_UNAVAILABLE', '暂时无法确认对话终态，阶段状态未改变。', 503);
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(unavailable()); }, 60_000);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > (action === 'capture' ? MAX_PHASE_CAPTURE_BYTES : MAX_EXECUTION_REQUEST_BYTES)) {
        child.kill('SIGTERM'); finish(unavailable());
      }
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes <= MAX_COMMAND_OUTPUT_BYTES) diagnostics.push(chunk);
    });
    child.on('error', () => finish(unavailable()));
    child.stdin.on('error', () => finish(unavailable()));
    child.on('close', (code) => {
      if (code !== 0) {
        const diagnostic = Buffer.concat(diagnostics).toString('utf8');
        const collectorCode = /^forge browser phase session: (BROWSER_SESSION_[A-Z_]+):/u.exec(diagnostic)?.[1];
        if (action === 'capture' && collectorCode === 'BROWSER_SESSION_TURN_UNFINISHED') {
          return finish(new ManagerError(collectorCode, '当前对话尚未完成，阶段状态未改变。', 202));
        }
        const error = unavailable();
        if (action === 'capture' && collectorCode) error.details = { collectorCode };
        return finish(error);
      }
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(unavailable()); }
    });
    child.stdin.end(JSON.stringify(['inspect-readonly-denial', 'inspect-access-scope-denial'].includes(action) ? { execution, baseline, sessionProof }
      : action === 'capture'
        ? { execution, baseline, ...(allowUserAborted === true ? { allowUserAborted: true } : {}) } : { execution }));
  });
}

async function writeOrVerifyPrivatePhaseBytes(file, bytes) {
  const info = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info !== null) {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size !== bytes.length
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      || !(await readFile(file)).equals(bytes)) {
      throw new ManagerError('PHASE_CAPTURE_RECORD_CONFLICT', '已保存的终态证据不一致，原文件未覆盖。', 409);
    }
    return;
  }
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

function classifyControlFailureDiagnostic(diagnostic) {
  if (typeof diagnostic !== 'string' || diagnostic.trim() === '') {
    return 'UNCLASSIFIED_CONTROL_FAILURE';
  }
  const normalized = diagnostic.toLowerCase();
  return CONTROL_FAILURE_RULES.find(([, fragments]) => fragments.some((fragment) => normalized.includes(fragment)))?.[0]
    ?? 'UNCLASSIFIED_CONTROL_FAILURE';
}

function controlFailureFields(error) {
  if (!(error instanceof ManagerError) || !['CONTROL_FAILED', 'CONTROL_TIMEOUT'].includes(error.code)) return {};
  const diagnostic = typeof error.details?.diagnostic === 'string' ? error.details.diagnostic : '';
  const exitCode = Number.isSafeInteger(error.details?.code)
    && error.details.code >= 0 && error.details.code <= 255
    ? error.details.code
    : undefined;
  const signal = typeof error.details?.signal === 'string' && /^SIG[A-Z0-9]+$/u.test(error.details.signal)
    ? error.details.signal
    : undefined;
  return {
    controlReasonCode: classifyControlFailureDiagnostic(diagnostic),
    ...(exitCode === undefined ? {} : { controlExitCode: exitCode }),
    ...(signal === undefined ? {} : { controlSignal: signal }),
  };
}

function publicErrorDetails(error, requestId) {
  if (!['CONTROL_FAILED', 'CONTROL_TIMEOUT'].includes(error.code)) return error.details;
  const fields = controlFailureFields(error);
  return {
    requestId,
    reasonCode: fields.controlReasonCode,
    ...(fields.controlExitCode === undefined ? {} : { exitCode: fields.controlExitCode }),
    ...(fields.controlSignal === undefined ? {} : { signal: fields.controlSignal }),
  };
}

function fileIdentity(information) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']
    .map((key) => information[key]);
}

function sameFileIdentity(left, right) {
  return JSON.stringify(fileIdentity(left)) === JSON.stringify(fileIdentity(right));
}

export async function readBrokerSourceTransition({ projectRoot, taskId }) {
  validateTaskId(taskId);
  const taskspacesRoot = path.resolve(projectRoot, 'taskspaces');
  const sourceTransitionRoot = path.resolve(taskspacesRoot, '.broker', 'source-transitions');
  const file = path.resolve(sourceTransitionRoot, `${taskId}.json`);
  if (!file.startsWith(`${sourceTransitionRoot}${path.sep}`)) {
    throw new ManagerError('SOURCE_TRANSITION_INVALID', '源码迁移事实路径越界。', 503);
  }
  const before = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw new ManagerError('SOURCE_TRANSITION_UNAVAILABLE', '源码迁移事实不可读取。', 503);
  });
  if (before === null) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size < 2 || before.size > MAX_SOURCE_TRANSITION_BYTES) {
    throw new ManagerError('SOURCE_TRANSITION_INVALID', '源码迁移事实不是受限普通文件。', 503);
  }
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(before, opened)) {
      throw new ManagerError('SOURCE_TRANSITION_UNSTABLE', '源码迁移事实打开时发生变化。', 503);
    }
    const bytes = await handle.readFile();
    const final = await handle.stat();
    const after = await lstat(file);
    if (bytes.length !== opened.size || !sameFileIdentity(opened, final)
      || !sameFileIdentity(final, after)) {
      throw new ManagerError('SOURCE_TRANSITION_UNSTABLE', '源码迁移事实读取时发生变化。', 503);
    }
    return validateSourceTransition(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error instanceof ManagerError) throw error;
    throw new ManagerError('SOURCE_TRANSITION_INVALID', '源码迁移事实无效。', 503);
  } finally {
    await handle?.close();
  }
}

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': body.length,
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function readJson(request, maxBytes = MAX_REQUEST_BYTES) {
  if (Object.hasOwn(request, 'runtimeParsedBody')) return request.runtimeParsedBody;
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maxBytes) {
      throw new ManagerError('REQUEST_TOO_LARGE', '请求体超过限制。', 413);
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    request.runtimeParsedBody = value;
    return value;
  } catch {
    throw new ManagerError('INVALID_JSON', '请求体不是合法 JSON。', 400);
  }
}

async function postUnixJson(
  socketPath,
  pathname,
  body,
  unavailableCode,
  timeoutMs = PROTECTED_CAPABILITY_TIMEOUT_MS,
) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_EXECUTION_REQUEST_BYTES) request.destroy(new Error('protected response too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || value?.ok !== true || !value.result) {
            reject(new ManagerError(
              value?.error?.code ?? unavailableCode,
              '受保护验收能力拒绝了平台请求。',
              (response.statusCode ?? 500) >= 500 ? 503 : 409,
            ));
            return;
          }
          resolve(value.result);
        } catch (error) {
          reject(error instanceof ManagerError ? error : new ManagerError(unavailableCode, '受保护验收响应无效。', 503));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('protected capability timeout')));
    request.on('error', () => reject(new ManagerError(unavailableCode, '受保护验收能力不可用。', 503)));
    request.end(payload);
  });
}

export function createProtectedAcceptanceControlClient(socketPath) {
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new Error('protected acceptance control socket is required');
  }
  return (body) => postUnixJson(
    socketPath, '/v1/contracts', body, 'ACCEPTANCE_CONTROL_UNAVAILABLE',
  );
}

export function createExecutionRenewalAuthorityClient(socketPath, token) {
  return (body) => new Promise((resolve, reject) => {
    const unavailable = () => new ManagerError('EXECUTION_RENEWAL_AUTHORITY_UNAVAILABLE', '当前账户授权查询暂不可用。', 503, { retryable: true });
    if (typeof socketPath !== 'string' || socketPath.length === 0 || typeof token !== 'string' || token.length < 32) {
      reject(unavailable());
      return;
    }
    const payload = Buffer.from(JSON.stringify(body));
    const request = http.request({ socketPath, method: 'POST',
      path: '/internal/taskspace-execution-renewal-authority',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': payload.length },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) request.destroy(new Error('authority response too large'));
        else chunks.push(chunk);
      });
      response.on('error', () => { clearTimeout(timer); reject(unavailable()); });
      response.on('end', () => {
        clearTimeout(timer);
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200) {
            reject([403, 409].includes(response.statusCode)
              ? new ManagerError('EXECUTION_RENEWAL_AUTHORITY_DENIED', '当前账户授权已失效或执行身份不匹配。', response.statusCode)
              : unavailable());
          } else resolve(value);
        } catch { reject(unavailable()); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('authority query timeout')), PROTECTED_CAPABILITY_TIMEOUT_MS);
    request.on('error', () => { clearTimeout(timer); reject(unavailable()); });
    request.end(payload);
  });
}

export function createProtectedExecutionAuthorityClient(socketPath) {
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new Error('protected acceptance control socket is required');
  }
  return (body) => postUnixJson(
    socketPath, '/v1/execution-authority', body, 'EXECUTION_AUTHORITY_UNAVAILABLE',
  );
}

export function createProtectedRoleDecisionClient(socketPath) {
  if (typeof socketPath !== 'string' || socketPath.length === 0) throw new Error('protected acceptance control socket is required');
  return async body => {
    try { return await postUnixJson(socketPath, '/v1/conversation-roles', body, 'ROLE_DECISION_UNAVAILABLE'); }
    catch (error) {
      const message = {
        ROLE_PREVIEW_STALE: '任务、源码或角色预览已变化或确认已使用，请重新预览。',
        ROLE_PREVIEW_REQUIRED: '请先预览本次角色授权。',
        ROLE_DECISION_SCOPE_CHANGED: '当前任务已变化，请在原对话重新准备后再预览角色。',
        ROLE_DECISION_NOT_ENABLED: '当前任务尚未启用角色确认。',
        ROLE_RECIPIENTS_UNRESOLVED: '无法确定全部角色，请先在原对话修正候选 SQL。',
      }[error.code];
      if (message && error instanceof ManagerError) throw new ManagerError(error.code, message, error.status);
      throw error;
    }
  };
}

export function createVerificationSourceObservationClient(socketPath) {
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new Error('verification source socket is required');
  }
  return (body) => postUnixJson(
    socketPath,
    '/v1/source',
    body,
    'ACCEPTANCE_SOURCE_OBSERVER_UNAVAILABLE',
    SOURCE_OBSERVATION_TIMEOUT_MS,
  );
}

export function compileProtectedAcceptanceSpec(contract) {
  if (contract.developmentMode === 'direct') return { requiredDimensions: [], requiredObligations: [] };
  const verificationProfiles = contract.requiredVerificationProfiles.filter((profile) => profile !== 'governance');
  const scopedUtility = Object.hasOwn(contract, 'suspendedReviewObligations') && contract.tddRequired === false
    && contract.taskProfiles.includes('frontend-admin')
    && !contract.requiredObligations.some(id => /(?:test-first|browser|responsive|loading|busy)/u.test(id));
  const finalVerificationProfile = scopedUtility
    ? verificationProfiles.find(profile => /(?:-test|-test-class)$/u.test(profile)) ?? verificationProfiles[0]
    : verificationProfiles[0];
  const workflowTestProfile = verificationProfiles.find(profile => /(?:-test|-test-class)$/u.test(profile));
  const obligations = contract.requiredObligations.map((id) => {
    if (['workflow-state-transition-tests', 'idempotent-workflow-callbacks'].includes(id)
      && workflowTestProfile !== undefined) {
      return { id, dimension: 'execution', evidenceType: 'verification', profile: workflowTestProfile };
    }
    if (/(?:test|verification|browser|responsive|loading|busy)/u.test(id.toLowerCase())
      && verificationProfiles.length > 0) {
      return { id, dimension: 'execution', evidenceType: 'verification',
        profile: id === 'final-verification' ? finalVerificationProfile : verificationProfiles[0] };
    }
    if (id === 'spec-and-quality-review' || /(?:owner|crud|dictionary|api-error|workflow-state)/u.test(id.toLowerCase())) {
      return { id, dimension: 'semantic', evidenceType: 'semantic-review', profile: null };
    }
    return { id, dimension: 'implemented', evidenceType: 'governance', profile: null };
  });
  const dimensions = ['implemented'];
  if (obligations.some((item) => item.dimension === 'execution')) dimensions.push('execution');
  if (obligations.some((item) => item.dimension === 'semantic')) dimensions.push('semantic');
  return { requiredDimensions: dimensions, requiredObligations: obligations };
}

function validateActorId(value) {
  if (typeof value !== 'string' || !ACTOR_PATTERN.test(value)) {
    throw new ManagerError('INVALID_ACTOR_ID', '人员标识不合法。', 400);
  }
  return value;
}

function publicMetadata(metadata) {
  return {
    schemaVersion: metadata.schemaVersion,
    taskId: metadata.taskId,
    actorId: metadata.actorId,
    actorUserId: metadata.actorUserId ?? null,
    conversationId: metadata.conversationId,
    accessMode: metadata.accessMode ?? 'token',
    status: metadata.status,
    harnessPort: metadata.harnessPort,
    baseCommit: metadata.baseCommit,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    protectedExecutionEligible: taskspaceSupportsProtectedExecution(metadata),
    ...(metadata.runtimeVersion ? { runtimeVersion: publicRuntimeVersion(metadata.runtimeVersion) } : {}),
  };
}

function createBoundedTailBuffer(maxBytes) {
  const buffer = Buffer.allocUnsafe(maxBytes);
  let length = 0;
  let writeOffset = 0;
  return {
    append(chunk) {
      const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (source.length >= maxBytes) {
        source.copy(buffer, 0, source.length - maxBytes);
        length = maxBytes;
        writeOffset = 0;
        return;
      }
      const firstLength = Math.min(source.length, maxBytes - writeOffset);
      source.copy(buffer, writeOffset, 0, firstLength);
      if (firstLength < source.length) source.copy(buffer, 0, firstLength);
      writeOffset = (writeOffset + source.length) % maxBytes;
      length = Math.min(maxBytes, length + source.length);
    },
    value() {
      if (length === 0) return Buffer.alloc(0);
      if (length < maxBytes) return Buffer.from(buffer.subarray(0, length));
      if (writeOffset === 0) return Buffer.from(buffer);
      return Buffer.concat([
        buffer.subarray(writeOffset),
        buffer.subarray(0, writeOffset),
      ], maxBytes);
    },
  };
}

async function defaultRunControl(controlScript, projectSlug, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [controlScript, projectSlug, ...args], {
      detached: process.platform !== 'win32',
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Lifecycle commands can be verbose; retain their final diagnostics instead of initial progress.
    const stdout = createBoundedTailBuffer(MAX_COMMAND_OUTPUT_BYTES);
    const stderr = createBoundedTailBuffer(MAX_COMMAND_OUTPUT_BYTES);
    child.stdout.on('data', (chunk) => stdout.append(chunk));
    child.stderr.on('data', (chunk) => stderr.append(chunk));
    child.once('error', reject);
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      reject(new ManagerError('CONTROL_TIMEOUT', 'TaskSpace 控制操作超时。', 504, {
        diagnostic: stderr.value().toString('utf8').slice(-4000),
      }));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      const result = {
        code,
        signal,
        stdout: stdout.value().toString('utf8'),
        stderr: stderr.value().toString('utf8'),
      };
      resolve(result);
    });
  });
}

export function createConversationManager(options) {
  const developmentMode = options.developmentMode ?? process.env.FORGE_DEVELOPMENT_MODE ?? 'controlled';
  if (!['controlled', 'direct'].includes(developmentMode)) throw new Error('Invalid development mode.');
  const {
    projectRoot,
    projectSlug,
    intakeRoot,
    controlScript,
    managerToken,
    auditPath,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    runtimeChannel = process.env.FORGE_RUNTIME_CHANNEL || null,
    runtimeVersionId = process.env.FORGE_RUNTIME_VERSION_ID || null,
    runControl = defaultRunControl,
    materialPreprocessor,
    materialAccessMode = 'reviewed',
    documentLimits,
    prototypeLimits,
    acceptanceControlClient = null,
    executionAuthorityClient = null,
    roleDecisionClient = null,
    executionRenewalAuthorityClient = null,
    sourceObservationClient = null,
    promptSessionReader = capturePromptSessionActivity,
    sourceTransitionReader = readBrokerSourceTransition,
    phaseCatalogFile = process.env.CONVERSATION_PHASE_CATALOG_FILE,
    phaseSessionBaseline = captureBrowserPhaseSession,
    phaseSessionCapture = (input) => captureBrowserPhaseSession(input, 'capture'),
    preparationSessionTerminal = captureCrossLayerPreparationTerminal,
    phaseSessionReadonlyDenial = (input) => captureBrowserPhaseSession(input, 'inspect-readonly-denial'),
    phaseSessionAccessScopeDenial = (input) => captureBrowserPhaseSession(input, 'inspect-access-scope-denial'),
    phaseHostReceiptReader = readForgePhaseHostReceipt,
    projectReleaseStatusReader = readProjectReleaseStatus,
    crossLayerMigrationFailureReader = (socket, input) => postUnixJson(socket,
      '/cross-layer-migration-failure', input, 'CROSS_LAYER_MIGRATION_FAILURE_UNAVAILABLE'),
  } = options;

  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new Error('projectRoot must be an absolute path');
  }
  if (typeof projectSlug !== 'string' || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(projectSlug)) {
    throw new Error('projectSlug is invalid');
  }
  if (typeof intakeRoot !== 'string' || !path.isAbsolute(intakeRoot)) {
    throw new Error('intakeRoot must be an absolute path');
  }
  if (!['direct', 'reviewed'].includes(materialAccessMode)) {
    throw new Error('materialAccessMode must be direct or reviewed');
  }
  if (typeof controlScript !== 'string' || !path.isAbsolute(controlScript)) {
    throw new Error('controlScript must be an absolute path');
  }
  if (typeof managerToken !== 'string' || managerToken.length < 32) {
    throw new Error('managerToken must contain at least 32 characters');
  }
  if (typeof auditPath !== 'string' || !path.isAbsolute(auditPath)) {
    throw new Error('auditPath must be an absolute path');
  }
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1000 || commandTimeoutMs > 900000) {
    throw new Error('commandTimeoutMs is invalid');
  }
  if ((acceptanceControlClient === null) !== (sourceObservationClient === null)
    || (acceptanceControlClient !== null && (typeof acceptanceControlClient !== 'function' || typeof sourceObservationClient !== 'function'))) {
    throw new Error('protected acceptance clients must be configured together');
  }
  if (executionAuthorityClient !== null && typeof executionAuthorityClient !== 'function') {
    throw new Error('protected execution authority client is invalid');
  }
  if (executionAuthorityClient !== null && sourceObservationClient === null) {
    throw new Error('protected execution authority requires the source observer');
  }
  if (roleDecisionClient !== null && (typeof roleDecisionClient !== 'function' || sourceObservationClient === null)) {
    throw new Error('protected role decisions require the source observer');
  }
  if (typeof sourceTransitionReader !== 'function') {
    throw new Error('sourceTransitionReader is invalid');
  }
  if ((phaseCatalogFile !== undefined && (typeof phaseCatalogFile !== 'string' || !path.isAbsolute(phaseCatalogFile)))
    || typeof phaseSessionBaseline !== 'function'
    || typeof phaseSessionCapture !== 'function'
    || typeof preparationSessionTerminal !== 'function'
    || typeof phaseSessionReadonlyDenial !== 'function'
    || typeof phaseSessionAccessScopeDenial !== 'function'
    || typeof phaseHostReceiptReader !== 'function') throw new Error('browser phase dependencies are invalid');

  const taskspacesRoot = path.resolve(projectRoot, 'taskspaces');
  const materials = createProjectMaterialStore({
    projectRoot,
    projectSlug,
    intakeRoot,
    materialPreprocessor,
    documentLimits,
    prototypeLimits,
  });
  let operationQueue = Promise.resolve();
  const taskQueues = new Map();

  const validateControlValue = (validator, value, code, message) => {
    try {
      return validator(value);
    } catch {
      throw new ManagerError(code, message, 400);
    }
  };

  const enqueueTask = (taskId, operation) => {
    const run = (taskQueues.get(taskId) ?? Promise.resolve()).then(operation);
    const settled = run.catch(() => {});
    taskQueues.set(taskId, settled);
    void settled.then(() => {
      if (taskQueues.get(taskId) === settled) taskQueues.delete(taskId);
    });
    return run;
  };
  // Reserve the task first; lifecycle allocation still keeps its project-wide order.
  const enqueue = (taskId, operation) => enqueueTask(taskId, () => {
    const run = operationQueue.then(operation, operation);
    operationQueue = run.catch(() => {});
    return run;
  });

  const provisioningTasks = new Set();
  const runProvisioning = async (taskId, args) => {
    provisioningTasks.add(taskId);
    try { return await execute(args); }
    finally { provisioningTasks.delete(taskId); }
  };

  const semanticIntentEnabled = options.semanticIntentEnabled ?? process.env.FORGE_SEMANTIC_INTENT_ENABLED === 'true';
  const resolveConversationIntent = options.resolveConversationIntent ?? (semanticIntentEnabled
    ? createConversationIntentResolver({stateRoot:path.join(projectRoot, 'ops', 'conversation-intent'),
      interpret:createManagerConversationIntentInterpreter()}) : null);

  const metadataPath = (taskId) => {
    validateControlValue(validateTaskId, taskId, 'INVALID_TASK_ID', 'TaskSpace 标识不合法。');
    const candidate = path.resolve(taskspacesRoot, taskId, 'metadata.json');
    if (!candidate.startsWith(`${taskspacesRoot}${path.sep}`)) {
      throw new ManagerError('INVALID_TASK_ID', 'TaskSpace 标识越界。', 400);
    }
    return candidate;
  };

  const readMetadata = async (taskId) => {
    let raw;
    try {
      raw = await readFile(metadataPath(taskId), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') throw new ManagerError('TASKSPACE_NOT_FOUND', 'TaskSpace 不存在。', 404);
      throw error;
    }
    let metadata;
    try {
      metadata = JSON.parse(raw);
    } catch {
      throw new ManagerError('TASKSPACE_STATE_INVALID', 'TaskSpace 元数据损坏。', 503);
    }
    try {
      validateTaskspaceMetadata(metadata, projectSlug);
    } catch {
      throw new ManagerError('TASKSPACE_STATE_INVALID', 'TaskSpace 元数据损坏或身份不一致。', 503);
    }
    if (metadata.taskId !== taskId) {
      throw new ManagerError('TASKSPACE_STATE_INVALID', 'TaskSpace 元数据身份不一致。', 503);
    }
    return metadata;
  };

  const metadataIfPresent = async (taskId) => {
    try {
      return await readMetadata(taskId);
    } catch (error) {
      if (error instanceof ManagerError && error.code === 'TASKSPACE_NOT_FOUND') return undefined;
      throw error;
    }
  };

  const browserPhaseFiles = (directory) => ({
    catalogFile: phaseCatalogFile,
    stateFile: path.join(directory, 'state.json'),
    artifactsDirectory: path.join(directory, 'artifacts'),
    originalRequestFile: path.join(directory, 'original-request.md'),
    promptFile: path.join(directory, 'current-prompt.md'),
  });

  const resolveBrowserPhase = async ({ taskId, sessionId, sourceCommit, repairRequestText }) => {
    const parentDirectory = path.join(taskspacesRoot, '.broker', 'delivery-phases', taskId, 'phase-control');
    const accessLink = await readPrivatePhaseJson(path.join(parentDirectory, 'access-wiring-repair', '权限接线阶段-关联修复凭据.json'));
    if (accessLink !== null) {
      const parent = await readPrivatePhaseJson(path.join(parentDirectory, 'state.json'));
      const repair = await readForgeAccessWiringRepairContinuation({ catalogFile: phaseCatalogFile,
        sourceStateFile: path.join(parentDirectory, 'state.json'), sourceArtifactsDirectory: path.join(parentDirectory, 'artifacts'),
        sourceCommit: parent?.sourceCommit, taskId, sessionId: sessionId ?? parent?.sessionId });
      if (sourceCommit !== undefined && sourceCommit !== parent?.sourceCommit) {
        const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
        const current = await readForgeDeliveryPhaseState(path.join(repair.phaseDirectory, 'state.json'), catalog);
        if (current.status !== 'completed') {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '未完成关联修复的源码基线不得改变。', 409);
        }
      }
      return { ...repair, phaseFiles: browserPhaseFiles(repair.phaseDirectory) };
    }
    const directory = path.join(parentDirectory, 'frontend-repair');
    const receipt = await readPrivatePhaseJson(path.join(directory, '前端阶段-关联修复凭据.json'));
    if (receipt === null && repairRequestText === undefined) {
      return { phaseDirectory: parentDirectory, phaseFiles: browserPhaseFiles(parentDirectory), continuation: null };
    }
    for (const checked of [parentDirectory, ...(receipt === null ? [] : [directory])]) {
      const info = await lstat(checked);
      if (!info.isDirectory() || info.isSymbolicLink()
        || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
        throw new ManagerError('PHASE_PRIVATE_RECORD_INVALID', '关联修复目录不可用。', 503);
      }
    }
    const parentBytes = await readPrivatePhaseBytes(path.join(parentDirectory, 'state.json'));
    const parent = parentBytes === null ? null : JSON.parse(parentBytes.toString('utf8'));
    if (parent?.taskId !== taskId || (sessionId !== undefined && parent.sessionId !== sessionId)
      || (sourceCommit !== undefined && parent.sourceCommit !== sourceCommit)) {
      throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '关联修复与原任务、会话或源码不一致。', 409);
    }
    const savedRequest = repairRequestText === undefined
      ? await readPrivatePhaseBytes(path.join(directory, '前端阶段-修复请求原文.txt')) : null;
    const beforeName = 'phase-5-workspace-before.json';
    const before = await readPrivatePhaseBytes(path.join(parentDirectory, beforeName));
    if (before === null) throw new ManagerError('PHASE_PRIVATE_RECORD_INVALID', '原前端阶段工作区基线不可用。', 503);
    if (repairRequestText !== undefined) {
      await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()
        || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
        throw new ManagerError('PHASE_PRIVATE_RECORD_INVALID', '关联修复目录不可用。', 503);
      }
      await writeOrVerifyPrivatePhaseBytes(path.join(directory, beforeName), before);
    } else {
      const copied = await readPrivatePhaseBytes(path.join(directory, beforeName));
      if (copied === null || !copied.equals(before)) {
        throw new ManagerError('PHASE_CAPTURE_RECORD_CONFLICT', '关联修复的前端工作区基线与原阶段不一致。', 409);
      }
    }
    const continuation = await prepareForgeFrontendRepairContinuation({
      catalogFile: phaseCatalogFile, sourceStateFile: path.join(parentDirectory, 'state.json'),
      expectedSourceStateSha256: crypto.createHash('sha256').update(parentBytes).digest('hex'),
      sourceArtifactsDirectory: path.join(parentDirectory, 'artifacts'), sourceCommit: parent.sourceCommit,
      originalRequestFile: path.join(parentDirectory, 'original-request.md'), outputDirectory: directory,
      repairRequestText: repairRequestText ?? savedRequest?.toString('utf8'),
    });
    return { phaseDirectory: directory, phaseFiles: browserPhaseFiles(directory), continuation };
  };

  const capturePhaseTerminal = async (body) => {
    const fields = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'executionId'];
    if (body === null || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== fields.length || fields.some((field) => !Object.hasOwn(body, field))
      || body.projectSlug !== projectSlug
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(body.executionId ?? '')) {
      throw new ManagerError('PHASE_CAPTURE_REQUEST_INVALID', '终态采集请求只能包含当前任务、用户、会话和执行身份。', 422);
    }
    const taskId = validateControlValue(validateTaskId, body.taskId, 'INVALID_TASK_ID', 'TaskSpace 标识不合法。');
    const metadata = await readMetadata(taskId);
    if (metadata.schemaVersion !== 2 || metadata.status !== 'active' || metadata.accessMode !== 'conversation'
      || metadata.actorUserId !== body.actorUserId || metadata.actorId !== body.actorUsername
      || metadata.conversationId !== body.conversationId) {
      throw new ManagerError('TASKSPACE_IDENTITY_CONFLICT', '终态采集必须来自当前活动工作舱的所属用户和会话。', 409);
    }
    if (phaseCatalogFile === undefined) {
      throw new ManagerError('PHASE_CONTROLLER_UNAVAILABLE', '当前业务阶段的受控输入不可用。', 503);
    }
    const { phaseDirectory, continuation } = await resolveBrowserPhase({ taskId });
    const attemptsDirectory = path.join(phaseDirectory, 'browser-attempts');
    const attemptDirectory = path.join(attemptsDirectory, body.executionId);
    for (const directory of [phaseDirectory, attemptsDirectory, attemptDirectory]) {
      const info = await lstat(directory).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (info === null || !info.isDirectory() || info.isSymbolicLink()
        || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
        throw new ManagerError('PHASE_PRIVATE_RECORD_INVALID', '阶段执行目录不可用。', 503);
      }
    }
    const stateFile = path.join(phaseDirectory, 'state.json');
    const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
    return withForgeDeliveryPhaseStateLock(stateFile, async () => {
      const state = await readForgeDeliveryPhaseState(stateFile, catalog);
      const [execution, baseline, begin] = await Promise.all([
        readPrivatePhaseJson(path.join(attemptDirectory, 'execution.json')),
        readPrivatePhaseJson(path.join(attemptDirectory, 'session-baseline.json')),
        readPrivatePhaseJson(path.join(attemptDirectory, 'begin.json')),
      ]);
      try { validateProtectedExecutionContext(execution); }
      catch { throw new ManagerError('PHASE_PRIVATE_RECORD_INVALID', '阶段执行记录不可用。', 503); }
      const identityFields = [
        'executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
        'conversationId', 'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint',
        'workflowId', 'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest',
      ];
      const attempt = state.activeAttempt;
      if (fields.some((field) => execution[field] !== body[field])
        || !['production-read-only', 'production-task-writer'].includes(execution.authorityClass)
        || execution.testOnly !== false || execution.route !== 'session.prompt'
        || execution.mode !== 'queue' || execution.classification !== 'claimable-text'
        || baseline?.schemaVersion !== 'forge-delivery-phase-browser-session-baseline/v1'
        || identityFields.some((field) => baseline[field] !== execution[field])
        || baseline.sessionCwd !== '/workspace' || !Number.isSafeInteger(baseline.observedSeq)
        || begin?.schemaVersion !== 'forge-delivery-browser-phase-begin/v1'
        || state.status !== 'active' || attempt === null
        || state.taskId !== taskId || state.sessionId !== execution.dshSessionId
        || state.workflowId !== execution.workflowId || state.currentPhaseId !== execution.phaseId
        || state.currentPhaseIndex !== execution.phaseIndex
        || state.catalogVersion !== execution.phaseCatalogVersion || state.catalogDigest !== execution.phaseCatalogDigest
        || begin.workflowId !== state.workflowId || begin.phaseId !== state.currentPhaseId
        || begin.phaseIndex !== state.currentPhaseIndex || begin.attempt?.attemptId !== attempt.attemptId
        || attempt.rpcId !== execution.rpcId || attempt.executionGeneration !== execution.generation
        || attempt.promptDigest !== execution.textDigest
        || begin.attempt.rpcId !== attempt.rpcId || begin.attempt.executionGeneration !== attempt.executionGeneration
        || begin.attempt.promptDigest !== attempt.promptDigest) {
        throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '终态采集与当前阶段、会话或执行身份不一致。', 409);
      }
      const captureFile = path.join(attemptDirectory, '阶段终态采集.json');
      const sessionProofFile = path.join(attemptDirectory, '会话终态证明.json');
      const responseFile = path.join(attemptDirectory, '模型最终回答.txt');
      let capture = await readPrivatePhaseJson(captureFile, MAX_PHASE_CAPTURE_BYTES);
      const idempotent = capture !== null;
      if (capture === null) {
        try { capture = await phaseSessionCapture({ projectSlug, taskId, execution, baseline,
          ...((continuation !== null && execution.phaseId === 'frontend')
            || (continuation === null && execution.phaseId === 'domain-contract' && execution.phaseIndex === 1
              && execution.authorityClass === 'production-read-only' && execution.actionCeiling === 'read-only'
              && execution.ownedPaths.length === 0) ? { allowUserAborted: true } : {}) }); }
        catch (error) {
          if (error?.code === 'BROWSER_SESSION_TURN_UNFINISHED') {
            return { status: 'pending', executionId: execution.executionId, phaseAttemptId: attempt.attemptId,
              phaseId: execution.phaseId, generation: execution.generation, code: error.code };
          }
          if (error instanceof ManagerError) throw error;
          throw new ManagerError('PHASE_SESSION_CAPTURE_UNAVAILABLE', '暂时无法确认对话终态，阶段状态未改变。', 503);
        }
      }
      if (capture?.contextFailureProof !== undefined) {
        if (Object.keys(capture).join(',') !== 'contextFailureProof' || continuation === null) {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '上下文故障证明只能绑定当前关联权限补证执行。', 409);
        }
        try { validateForgeAccessContextFailureProof({ execution, baseline, proof: capture.contextFailureProof }); }
        catch { throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '上下文故障证明与当前权限执行不一致，阶段未改变。', 409); }
        const bytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`, 'utf8');
        if (bytes.length > MAX_PHASE_CAPTURE_BYTES) throw new ManagerError('PHASE_SESSION_CAPTURE_UNAVAILABLE', '故障证据超过保存上限。', 503);
        const contextFailureProofFile = path.join(attemptDirectory, '权限阶段-上下文故障证明.json');
        await writeOrVerifyPrivatePhaseBytes(captureFile, bytes);
        await writeOrVerifyPrivatePhaseBytes(contextFailureProofFile, Buffer.from(`${JSON.stringify(capture.contextFailureProof, null, 2)}\n`, 'utf8'));
        return { status: 'context-failed', capture, captureFile, contextFailureProofFile,
          phaseDirectory, attemptDirectory, execution, begin, state, idempotent };
      }
      if (capture?.providerFailureProof !== undefined) {
        if (Object.keys(capture).join(',') !== 'providerFailureProof') {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '供应方故障证明不能混入阶段产物。', 409);
        }
        const accessFailure = execution.phaseId === 'access-wiring' && execution.phaseIndex === 6;
        try {
          if (accessFailure) {
            if (currentForgeAccessAcceptedCorrection(state) === null) throw new Error('Missing current accepted correction');
            validateForgeAccessProviderFailureProof({ execution, baseline, proof: capture.providerFailureProof });
          } else validateForgeRequirementsOverloadEvidence({ state, execution, baseline, begin, proof: capture.providerFailureProof });
        }
        catch { throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '供应方故障证明未绑定当前阶段执行，阶段未改变。', 409); }
        const bytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`, 'utf8');
        if (bytes.length > MAX_PHASE_CAPTURE_BYTES) throw new ManagerError('PHASE_SESSION_CAPTURE_UNAVAILABLE', '故障证据超过保存上限。', 503);
        const providerFailureProofFile = path.join(attemptDirectory, accessFailure ? '权限阶段-供应方故障证明.json' : '需求阶段-供应方临时故障证明.json');
        await writeOrVerifyPrivatePhaseBytes(captureFile, bytes);
        await writeOrVerifyPrivatePhaseBytes(providerFailureProofFile,
          Buffer.from(`${JSON.stringify(capture.providerFailureProof, null, 2)}\n`, 'utf8'));
        let providerDraft = null;
        if (accessFailure) {
          const before = await readPrivatePhaseJson(path.join(phaseDirectory, 'phase-6-workspace-before.json'));
          const observed = await observeForgeDeliveryPhase({ workspace: path.join(taskspacesRoot, taskId, 'workspace'),
            baseCommit: state.sourceCommit, before });
          for (const [name, value] of [
            ['累计变更文件.json', Buffer.from(`${JSON.stringify(observed.allChangedPaths)}\n`)],
            ['本阶段变更文件.json', Buffer.from(`${JSON.stringify(observed.phaseChangedPaths)}\n`)],
            ['本阶段实际变更.patch', observed.phasePatch], ['累计实际变更.patch', observed.cumulativePatch],
          ]) await writeOrVerifyPrivatePhaseBytes(path.join(attemptDirectory, name), value);
          providerDraft = { snapshotDigest: observed.snapshot.snapshotDigest, changedPaths: observed.phaseChangedPaths };
          await writeOrVerifyPrivatePhaseBytes(path.join(attemptDirectory, '供应方故障候选绑定.json'),
            Buffer.from(`${JSON.stringify(providerDraft)}\n`));
        }
        return { status: 'provider-failed', capture, captureFile, providerFailureProofFile, providerDraft,
          phaseDirectory, attemptDirectory, execution, begin, state, idempotent };
      }
      if (capture?.interruptionProof !== undefined) {
        const domainInterruption = continuation === null && execution.phaseId === 'domain-contract' && execution.phaseIndex === 1;
        if ((!domainInterruption && continuation === null) || Object.keys(capture).join(',') !== 'interruptionProof') {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '中止证明只能用于当前只读领域合同或已关联的前端修复阶段。', 409);
        }
        try {
          const validateInterruption = domainInterruption ? validateForgeDomainUserAbortedEvidence : validateForgeFrontendUserAbortedEvidence;
          validateInterruption({ state, execution, baseline, begin, proof: capture.interruptionProof });
        }
        catch { throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '中止证明未绑定当前真实执行，阶段未改变。', 409); }
        const bytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`, 'utf8');
        if (bytes.length > MAX_PHASE_CAPTURE_BYTES) throw new ManagerError('PHASE_SESSION_CAPTURE_UNAVAILABLE', '中止证据超过保存上限。', 503);
        const interruptionProofFile = path.join(attemptDirectory, '会话中止证明.json');
        await writeOrVerifyPrivatePhaseBytes(captureFile, bytes);
        await writeOrVerifyPrivatePhaseBytes(interruptionProofFile,
          Buffer.from(`${JSON.stringify(capture.interruptionProof, null, 2)}\n`, 'utf8'));
        return { status: 'interrupted', capture, captureFile, interruptionProofFile,
          phaseDirectory, attemptDirectory, execution, begin, state, idempotent };
      }
      const proof = capture?.sessionProof;
      if (capture === null || typeof capture !== 'object' || Array.isArray(capture)
        || Object.keys(capture).sort().join(',') !== 'modelResponse,sessionProof'
        || typeof capture.modelResponse !== 'string' || capture.modelResponse.length === 0
        || Buffer.byteLength(capture.modelResponse, 'utf8') > MAX_EXECUTION_REQUEST_BYTES
        || proof?.schemaVersion !== 'forge-delivery-phase-browser-session-proof/v1'
        || identityFields.some((field) => proof[field] !== execution[field])
        || proof.baselineObservedSeq !== baseline.observedSeq || proof.sessionCwd !== baseline.sessionCwd
        || proof.terminalReason !== 'completed' || proof.hostReceiptsDerived !== false
        || !Number.isSafeInteger(proof.requestSeq) || proof.requestSeq <= baseline.observedSeq
        || !Number.isSafeInteger(proof.assistantMessageSeq) || proof.assistantMessageSeq <= proof.requestSeq
        || !Number.isSafeInteger(proof.terminalSeq) || proof.terminalSeq <= proof.assistantMessageSeq
        || !/^[a-f0-9]{64}$/u.test(proof.terminalEventDigest ?? '')
        || proof.modelResponseSha256 !== crypto.createHash('sha256').update(capture.modelResponse, 'utf8').digest('hex')) {
        throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '采集结果未绑定当前真实会话终态，阶段状态未改变。', 409);
      }
      const captureBytes = Buffer.from(`${JSON.stringify(capture, null, 2)}\n`, 'utf8');
      if (captureBytes.length > MAX_PHASE_CAPTURE_BYTES) {
        throw new ManagerError('PHASE_SESSION_CAPTURE_UNAVAILABLE', '终态证据超过保存上限，阶段状态未改变。', 503);
      }
      await writeOrVerifyPrivatePhaseBytes(captureFile, captureBytes);
      await writeOrVerifyPrivatePhaseBytes(sessionProofFile, Buffer.from(`${JSON.stringify(proof, null, 2)}\n`, 'utf8'));
      await writeOrVerifyPrivatePhaseBytes(responseFile, Buffer.from(capture.modelResponse, 'utf8'));
      const captured = { status: 'captured', capture, captureFile, sessionProofFile, responseFile,
        phaseDirectory, attemptDirectory, execution, begin, state, idempotent };
      // Correct only a cached last-message loss caused by this turn's completion-claim
      // notices. Original capture and failed assessment remain immutable evidence.
      if (!idempotent || execution.phaseId !== 'access-wiring' || execution.phaseIndex !== 6
        || execution.authorityClass !== 'production-task-writer' || execution.actionCeiling !== 'workspace-write'
        || capture.modelResponse.includes('<forge-phase-artifact>') || capture.modelResponse.includes('</forge-phase-artifact>')) return captured;
      const oldAssessmentFile = path.join(attemptDirectory, '阶段候选检查结果.json');
      const oldAssessment = await readPrivatePhaseJson(oldAssessmentFile);
      if (oldAssessment?.status !== 'needs-attention' || oldAssessment.code !== 'PHASE_RESPONSE_INVALID'
        || oldAssessment.stateAdvanced !== false || oldAssessment.phaseId !== execution.phaseId
        || oldAssessment.phaseAttemptId !== attempt.attemptId || oldAssessment.modelResponseSha256 !== proof.modelResponseSha256) return captured;
      const corrected = await phaseSessionCapture({ projectSlug, taskId, execution, baseline });
      const nextProof = corrected?.sessionProof; const correction = nextProof?.completionClaimCorrection;
      if (correction === undefined) return captured;
      const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
      const block = corrected.modelResponse?.slice(capture.modelResponse.length + 2);
      if (Object.keys(corrected).sort().join(',') !== 'modelResponse,sessionProof'
        || correction.schemaVersion !== 'forge-delivery-completion-claim-correction/v1'
        || identityFields.some(field => nextProof[field] !== execution[field])
        || ['schemaVersion', 'baselineObservedSeq', 'requestSeq', 'assistantMessageSeq', 'terminalSeq',
          'terminalReason', 'terminalEventDigest', 'sessionCwd', 'hostReceiptsDerived', 'toolCallCount', 'toolResultCount']
          .some(field => nextProof[field] !== proof[field])
        || JSON.stringify(nextProof.toolResults) !== JSON.stringify(proof.toolResults)
        || correction.latestAssistantMessageSeq !== proof.assistantMessageSeq
        || correction.latestAssistantMessageSha256 !== proof.modelResponseSha256
        || !Number.isSafeInteger(correction.artifactMessageSeq) || correction.artifactMessageSeq <= proof.requestSeq
        || correction.artifactMessageSeq >= proof.assistantMessageSeq
        || !/^[a-f0-9]{64}$/u.test(correction.artifactMessageSha256 ?? '')
        || !/^[a-f0-9]{64}$/u.test(correction.guardEventsDigest ?? '')
        || !Array.isArray(correction.guardMessageSeqs) || correction.guardMessageSeqs.length === 0
        || correction.guardMessageSeqs.some((seq, index, all) => !Number.isSafeInteger(seq)
          || seq <= (index === 0 ? correction.artifactMessageSeq : all[index - 1]) || seq >= proof.assistantMessageSeq)
        || typeof corrected.modelResponse !== 'string' || !corrected.modelResponse.startsWith(`${capture.modelResponse}\n\n`)
        || !block?.startsWith('<forge-phase-artifact>') || !block.endsWith('</forge-phase-artifact>')
        || correction.artifactBlockSha256 !== digest(block)
        || nextProof.modelResponseSha256 !== digest(corrected.modelResponse)
        || Buffer.byteLength(corrected.modelResponse, 'utf8') > MAX_EXECUTION_REQUEST_BYTES) {
        throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '完成说明补正未绑定原执行的唯一产物和真实最终回答。', 409);
      }
      const before = await readPrivatePhaseJson(path.join(phaseDirectory, 'phase-6-workspace-before.json'));
      const observed = await observeForgeDeliveryPhase({ workspace: path.join(taskspacesRoot, taskId, 'workspace'), baseCommit: state.sourceCommit, before });
      for (const [name, bytes] of [
        ['累计变更文件.json', Buffer.from(`${JSON.stringify(observed.allChangedPaths)}\n`)],
        ['本阶段变更文件.json', Buffer.from(`${JSON.stringify(observed.phaseChangedPaths)}\n`)],
        ['本阶段实际变更.patch', observed.phasePatch], ['累计实际变更.patch', observed.cumulativePatch],
      ]) {
        if (!(await readFile(path.join(attemptDirectory, name))).equals(bytes)) {
          throw new ManagerError('PHASE_CAPTURE_RECORD_CONFLICT', '当前源码已不同于原缺块采集候选，不能补正其回答。', 409);
        }
      }
      if (await readPrivatePhaseJson(path.join(attemptDirectory, '阶段候选预检凭据.json')) !== null
        && await readPrivatePhaseJson(path.join(attemptDirectory, '完成说明纠正-采集补正凭据.json')) === null) {
        throw new ManagerError('PHASE_CAPTURE_RECORD_CONFLICT', '已有候选预检不能被完成说明补正替换。', 409);
      }
      const correctedBytes = Buffer.from(`${JSON.stringify(corrected, null, 2)}\n`);
      if (correctedBytes.length > MAX_PHASE_CAPTURE_BYTES) throw new ManagerError('PHASE_SESSION_CAPTURE_UNAVAILABLE', '补正采集超过保存上限。', 503);
      const correctedCaptureFile = path.join(attemptDirectory, '完成说明纠正-阶段终态采集.json');
      const correctedProofFile = path.join(attemptDirectory, '完成说明纠正-会话终态证明.json');
      const correctedResponseFile = path.join(attemptDirectory, '完成说明纠正-模型回答.txt');
      const originals = {};
      for (const file of [captureFile, sessionProofFile, responseFile, oldAssessmentFile]) originals[path.basename(file)] = digest(await readFile(file));
      await writeOrVerifyPrivatePhaseBytes(path.join(attemptDirectory, '完成说明纠正-采集补正凭据.json'), Buffer.from(`${JSON.stringify({
        schemaVersion: 'forge-delivery-completion-claim-capture-correction/v1', executionId: execution.executionId,
        phaseAttemptId: attempt.attemptId, originals, correctedCaptureSha256: digest(correctedBytes),
        cumulativePatchSha256: observed.cumulativePatchDigest, phasePatchSha256: observed.phasePatchDigest,
        terminalEventDigest: proof.terminalEventDigest, stateAdvanced: false,
      }, null, 2)}\n`));
      await writeOrVerifyPrivatePhaseBytes(correctedCaptureFile, correctedBytes);
      await writeOrVerifyPrivatePhaseBytes(correctedProofFile, Buffer.from(`${JSON.stringify(nextProof, null, 2)}\n`));
      await writeOrVerifyPrivatePhaseBytes(correctedResponseFile, Buffer.from(corrected.modelResponse));
      return { ...captured, capture: corrected, captureFile: correctedCaptureFile, sessionProofFile: correctedProofFile,
        responseFile: correctedResponseFile, assessmentFile: path.join(attemptDirectory, '完成说明纠正-阶段候选检查结果.json') };
    });
  };

  const assessCapturedPhase = async (captured) => {
    if (captured.status !== 'captured') return null;
    const { phaseDirectory, attemptDirectory, execution, begin, state, responseFile } = captured;
    const assessmentFile = captured.assessmentFile ?? path.join(attemptDirectory, '阶段候选检查结果.json');
    const existing = await readPrivatePhaseJson(assessmentFile);
    const identity = { phaseId: execution.phaseId, phaseAttemptId: begin.attempt.attemptId,
      modelResponseSha256: captured.capture.sessionProof.modelResponseSha256 };
    if (existing !== null) {
      if (Object.entries(identity).some(([key, value]) => existing[key] !== value)
        || !['preflight-ready', 'needs-attention'].includes(existing.status) || existing.stateAdvanced !== false) {
        throw new ManagerError('PHASE_CAPTURE_RECORD_CONFLICT', '已保存的阶段检查结果与原对话不一致。', 409);
      }
      return existing;
    }
    const before = await readPrivatePhaseJson(path.join(phaseDirectory, `phase-${execution.phaseIndex}-workspace-before.json`));
    const observed = await observeForgeDeliveryPhase({
      workspace: path.join(taskspacesRoot, execution.taskId, 'workspace'), baseCommit: state.sourceCommit, before,
    });
    const files = {
      allChangedPathsFile: path.join(attemptDirectory, '累计变更文件.json'),
      phaseChangedPathsFile: path.join(attemptDirectory, '本阶段变更文件.json'),
      phasePatchFile: path.join(attemptDirectory, '本阶段实际变更.patch'),
      cumulativePatchFile: path.join(attemptDirectory, '累计实际变更.patch'),
    };
    for (const [file, value] of [
      [files.allChangedPathsFile, Buffer.from(`${JSON.stringify(observed.allChangedPaths)}\n`)],
      [files.phaseChangedPathsFile, Buffer.from(`${JSON.stringify(observed.phaseChangedPaths)}\n`)],
      [files.phasePatchFile, observed.phasePatch], [files.cumulativePatchFile, observed.cumulativePatch],
    ]) await writeOrVerifyPrivatePhaseBytes(file, value);
    const receiptFile = path.join(attemptDirectory, '阶段候选预检凭据.json');
    let preflight = await readPrivatePhaseJson(receiptFile);
    const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
    const phase = catalog.workflows.find((item) => item.id === state.workflowId)?.phases[execution.phaseIndex];
    const expectedPatchDigest = phase?.patchScope === 'none' ? null
      : phase?.patchScope === 'phase' ? observed.phasePatchDigest : observed.cumulativePatchDigest;
    let assessment;
    try {
      if (preflight === null) preflight = await preflightForgeDeliveryPhaseRun({
        ...files, catalogFile: phaseCatalogFile, stateFile: path.join(phaseDirectory, 'state.json'),
        artifactsDirectory: path.join(phaseDirectory, 'artifacts'), responseFile, receiptFile,
        expectedAttemptId: identity.phaseAttemptId,
      });
      if (preflight.phaseAttemptId !== identity.phaseAttemptId || preflight.phaseId !== identity.phaseId
        || preflight.phasePatchDigest !== expectedPatchDigest
        || preflight.cumulativePatchDigest !== observed.cumulativePatchDigest || preflight.stateAdvanced !== false) {
        throw new ManagerError('PHASE_CAPTURE_RECORD_CONFLICT', '阶段预检凭据与本次真实变更不一致。', 409);
      }
      assessment = { ...identity, status: 'preflight-ready', code: 'PHASE_HOST_VERIFICATION_REQUIRED',
        stateAdvanced: false, hostVerificationProfiles: preflight.hostVerificationProfiles };
    } catch (error) {
      if (error instanceof ManagerError || !/^PHASE_[A-Z_]+$/u.test(error?.code ?? '')) throw error;
      if (!['PHASE_RESPONSE_INVALID', 'PHASE_CONTROLLER_MUTATION_DENIED', 'PHASE_CONTROLLER_ZERO_CHANGE',
        'PHASE_CONTROLLER_BUSINESS_DECISION_REQUIRED'].includes(error.code)) {
        throw new ManagerError(error.code, `阶段检查暂未完成：${error.code}。未保存候选结论，阶段状态未改变。`, 503);
      }
      assessment = { ...identity, status: 'needs-attention', code: error.code, stateAdvanced: false };
    }
    await writePrivatePhaseJson(assessmentFile, assessment);
    return assessment;
  };

  const assessCapturedHostReceipts = async (captured, assessment) => {
    if (assessment?.status !== 'preflight-ready' || sourceObservationClient === null) return assessment;
    const { phaseDirectory, attemptDirectory, execution, state, responseFile } = captured;
    const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
    const phase = catalog.workflows.find((item) => item.id === state.workflowId)?.phases[execution.phaseIndex];
    const readonlyContract = ((phase?.id === 'requirements' && phase.index === 0)
      || (phase?.id === 'domain-contract' && phase.index === 1)
      || (phase?.id === 'ui-design' && phase.index === 3))
      && phase.actionCeiling === 'read-only' && phase.sourceMutation === false
      && phase.ownedPaths.length === 0 && phase.hostVerificationProfiles.length === 0;
    if (assessment.hostVerificationProfiles.length === 0 && !readonlyContract) return assessment;
    const response = await readFile(responseFile);
    if (crypto.createHash('sha256').update(response).digest('hex') !== assessment.modelResponseSha256) {
      throw new ManagerError('PHASE_CAPTURE_RECORD_CONFLICT', '已保存的回答与原对话终态不一致。', 409);
    }
    const proposal = parseForgeDeliveryPhaseProposal({ text: response.toString('utf8'), phase });
    const observeSource = async () => {
      const observation = await sourceObservationClient({ taskId: execution.taskId });
      if (observation?.schemaVersion !== 1 || observation.observationType !== 'forge-verify/source'
        || observation.projectSlug !== projectSlug || observation.taskId !== execution.taskId
        || observation.source?.head !== state.sourceCommit
        || !/^[0-9a-f]{64}$/u.test(observation.source?.fingerprint ?? '')
        || observation.source.snapshotSha256 !== observation.source.fingerprint) {
        throw new ManagerError('ACCEPTANCE_SOURCE_OBSERVATION_INVALID', '无法将宿主验证回执绑定到当前阶段源码。', 503);
      }
      return observation.source;
    };
    const sourceBefore = await observeSource();
    const before = await readPrivatePhaseJson(path.join(phaseDirectory, `phase-${execution.phaseIndex}-workspace-before.json`));
    const observed = await observeForgeDeliveryPhase({
      workspace: path.join(taskspacesRoot, execution.taskId, 'workspace'), baseCommit: state.sourceCommit, before,
    });
    const preflight = await readPrivatePhaseJson(path.join(attemptDirectory, '阶段候选预检凭据.json'));
    const phasePatchDigest = phase.patchScope === 'none' ? null
      : phase.patchScope === 'phase' ? observed.phasePatchDigest : observed.cumulativePatchDigest;
    if (preflight?.phaseAttemptId !== assessment.phaseAttemptId || preflight.phaseId !== assessment.phaseId
      || preflight.phasePatchDigest !== phasePatchDigest
      || preflight.cumulativePatchDigest !== observed.cumulativePatchDigest
      || JSON.stringify(preflight.hostVerificationProfiles) !== JSON.stringify(phase.hostVerificationProfiles)) {
      throw new ManagerError('PHASE_CAPTURE_RECORD_CONFLICT', '当前工作区已不同于终态采集的候选，不能复用其验证回执。', 409);
    }
    if (readonlyContract) {
      // An empty catalog obligation is not a passed Host run. Preserve the
      // original capture/assessment while reporting its current acceptance readiness.
      return { ...assessment, code: 'PHASE_ACCEPTANCE_REQUIRED',
        hostVerification: { status: 'not-required', profiles: [] } };
    }
    const verified = await collectForgePhaseHostReceipts({
      projectSlug, taskId: execution.taskId, sourceFingerprint: sourceBefore.fingerprint,
      sourceCommit: state.sourceCommit, patchDigest: observed.cumulativePatchDigest,
      phaseChangedPaths: observed.phaseChangedPaths, phaseId: phase.id,
      profiles: preflight.hostVerificationProfiles, proposal, receiptReader: phaseHostReceiptReader,
    });
    if (verified.status !== 'verified') {
      if (phase.id === 'cross-layer-acceptance' && phase.index === 7
        && !verified.failures.some(failure => verified.missingProfiles.includes(failure.profile))) {
        const reused = await inspectForgeCrossLayerHostVerificationReuse({
          state, catalog, stateFile: path.join(phaseDirectory, 'state.json'),
          artifactsDirectory: path.join(phaseDirectory, 'artifacts'), response: response.toString('utf8'),
          allChangedPaths: observed.allChangedPaths, phaseChangedPaths: observed.phaseChangedPaths,
          phasePatchBytes: observed.phasePatch, cumulativePatchBytes: observed.cumulativePatch,
        });
        if (reused.hostVerificationReuse !== null) {
          const sourceAfter = await observeSource();
          if (reused.candidateArtifactDigest !== preflight.candidateArtifactDigest
            || sourceAfter.fingerprint !== sourceBefore.fingerprint || sourceAfter.head !== sourceBefore.head) {
            throw new ManagerError('PHASE_CAPTURE_RECORD_CONFLICT', '复用上游验证期间候选或源码发生变化，阶段状态未改变。', 409);
          }
          await writeOrVerifyPrivatePhaseBytes(path.join(attemptDirectory, '阶段宿主验证回执.json'), Buffer.from('[]\n'));
          await writeOrVerifyPrivatePhaseBytes(path.join(attemptDirectory, '阶段宿主验证复用.json'), Buffer.from(`${JSON.stringify({
            phaseAttemptId: assessment.phaseAttemptId, modelResponseSha256: assessment.modelResponseSha256,
            source: sourceAfter, cumulativePatchDigest: observed.cumulativePatchDigest,
            status: 'reused-upstream', newHostReceipts: [], notExecutedProfiles: preflight.hostVerificationProfiles,
            hostVerificationReuse: reused.hostVerificationReuse, stateAdvanced: false,
          })}\n`));
          return { ...assessment, code: 'PHASE_ACCEPTANCE_REQUIRED', hostVerification: {
            status: 'reused-upstream', profiles: [], notExecutedProfiles: preflight.hostVerificationProfiles,
          } };
        }
      }
      return { ...assessment, hostVerification: {
        status: 'required', missingProfiles: verified.missingProfiles, failures: verified.failures,
      } };
    }
    const sourceAfter = await observeSource();
    if (sourceAfter.fingerprint !== sourceBefore.fingerprint || sourceAfter.head !== sourceBefore.head) {
      throw new ManagerError('PHASE_CAPTURE_RECORD_CONFLICT', '读取宿主验证回执期间源码发生变化，阶段状态未改变。', 409);
    }
    // Preserve the original preflight result. Native Host source fingerprints
    // and Controller patch digests are connected by these two real observations,
    // never by copying a model's claimed status or treating the hashes as equal.
    for (const receipt of verified.nativeReceipts) {
      await writeOrVerifyPrivatePhaseBytes(path.join(attemptDirectory, `宿主验证回执-${receipt.receiptId}.json`),
        Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`));
    }
    await writeOrVerifyPrivatePhaseBytes(path.join(attemptDirectory, '阶段宿主验证回执.json'),
      Buffer.from(`${JSON.stringify(verified.receipts)}\n`));
    await writeOrVerifyPrivatePhaseBytes(path.join(attemptDirectory, '阶段宿主验证绑定.json'), Buffer.from(`${JSON.stringify({
      phaseAttemptId: assessment.phaseAttemptId, modelResponseSha256: assessment.modelResponseSha256,
      source: sourceAfter, phasePatchDigest, cumulativePatchDigest: observed.cumulativePatchDigest,
      hostReceipts: verified.receipts, stateAdvanced: false,
    })}\n`));
    return { ...assessment, code: 'PHASE_SEMANTIC_REVIEW_REQUIRED', hostVerification: {
      status: 'verified', profiles: preflight.hostVerificationProfiles,
    } };
  };

  const findActiveBrowserExecution = async ({ taskId, phaseFiles, phaseState }) => {
    const attempt = phaseState.activeAttempt;
    const matchesAttempt = (execution) => execution?.rpcId === attempt.rpcId
      && execution?.generation === attempt.executionGeneration;
    const stored = await readPrivatePhaseJson(path.join(taskspacesRoot, '.broker', 'executions', `${taskId}.json`));
    if (matchesAttempt(stored?.current)) return stored.current;
    // A later read-only conversation may replace the execution index. The
    // immutable browser attempt still binds the original business execution.
    const directory = path.join(path.dirname(phaseFiles.stateFile), 'browser-attempts');
    const info = await lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info === null || !info.isDirectory() || info.isSymbolicLink()
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw new ManagerError('PHASE_PRIVATE_RECORD_INVALID', '原阶段的私有执行目录不可用。', 503);
    }
    const matches = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(entry.name)) continue;
      const attemptDirectory = path.join(directory, entry.name);
      const begin = await readPrivatePhaseJson(path.join(attemptDirectory, 'begin.json'));
      if (begin?.attempt?.attemptId !== attempt.attemptId) continue;
      const execution = await readPrivatePhaseJson(path.join(attemptDirectory, 'execution.json'));
      if (begin.attempt.executionGeneration !== attempt.executionGeneration
        || begin.attempt.rpcId !== attempt.rpcId) continue;
      if (!matchesAttempt(execution) || execution.executionId !== entry.name) {
        throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '原阶段的执行身份与私有记录不一致。', 409);
      }
      matches.push(execution);
    }
    if (matches.length !== 1) {
      throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '无法唯一确认原阶段的执行记录，阶段未改变。', 409);
    }
    return matches[0];
  };

  const completedWorkflowContinuation = async ({ taskId, prepareRequest, phaseFiles,
    observedSourceCommit, observedSourceFingerprint, workspaceWriteAuthorized }) => {
    const input = { ...phaseFiles, taskId, sessionId: prepareRequest.dshSessionId,
      sourceCommit: observedSourceCommit, workspaceFingerprint: observedSourceFingerprint,
      workspace: path.join(taskspacesRoot, taskId, 'workspace') };
    if (workspaceWriteAuthorized !== true && hasGlobalReadOnlyIntent(prepareRequest.promptText)) {
      const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseFiles.catalogFile);
      const state = await readForgeDeliveryPhaseState(phaseFiles.stateFile, catalog);
      if (state.status !== 'completed' || state.activeAttempt !== null
        || state.taskId !== taskId || state.sessionId !== prepareRequest.dshSessionId) {
        throw new ManagerError('PHASE_CONTROLLER_COMPLETED_IDENTITY_MISMATCH', '只读续聊需要原已完成任务和会话。', 409);
      }
      // A read-only conversation does not reuse the accepted API contract or
      // claim its old source is current. The issuer still receives no write ceiling.
      return { workflowCompleted: true };
    }
    if (workspaceWriteAuthorized === true && hasDirectControlledPreparationIntent(prepareRequest.promptText)
      && isForgeCrossLayerPreparationContinuation(prepareRequest.promptText,
      { workflowId: 'crud-production', phaseId: 'cross-layer-acceptance', phaseIndex: 7, actionCeiling: 'read-only' })) {
      return { browserPhase: await prepareForgeCrossLayerPreparation({ ...input,
        rpcId: prepareRequest.rpcId, promptText: prepareRequest.promptText }) };
    }
    try {
      return { workflowCompleted: true, completedApiContract: await readForgeCompletedApiContract(input) };
    } catch (error) {
      if (error?.code !== 'PHASE_CONTROLLER_COMPLETED_SOURCE_MISMATCH'
        || workspaceWriteAuthorized !== true) throw error;
      const identity = { projectSlug, taskId, actorUserId: prepareRequest.actorUserId,
        actorUsername: prepareRequest.actorUsername, conversationId: prepareRequest.conversationId,
        dshSessionId: prepareRequest.dshSessionId };
      let ordinaryContinuation = false;
      if (isForgeConversationTaskContinuation(prepareRequest.promptText)) {
        let writer;
        try {
          writer = await readCurrentProtectedExecutionContextForTask({ projectRoot,
            taskMetadata: await readMetadata(taskId), allowExpiredForRenewal: true });
        } catch { /* The protected transition below remains the initial repair path. */ }
        if (writer?.workflowId === null && writer.phaseId === null && writer.phaseIndex === null
          && writer.sourceCommit === observedSourceCommit
          && Object.entries(identity).every(([key, value]) => writer[key] === value)) {
          const current = await snapshotForgeDeliveryWorkspace({ workspace: input.workspace,
            baseCommit: observedSourceCommit });
          ordinaryContinuation = current.changedPaths.every(candidate => writer.ownedPaths
            .some(owned => candidate === owned || candidate.startsWith(`${owned}/`)));
        }
      }
      if (!ordinaryContinuation) {
        if (!isForgeConversationRepairContinuation(prepareRequest.promptText)) throw error;
        const candidate = await sourceTransitionReader({ projectRoot, taskId });
        let transition;
        try { transition = validateSourceTransition(candidate); } catch { throw error; }
        if (!['checkpointed', 'integrated'].includes(transition.phase)
          || transition.sourceAuthority.actionCeiling !== 'release'
          || transition.from.head === transition.to.head
          || (transition.phase === 'checkpointed' && transition.from.fingerprint !== transition.to.fingerprint)
          || Object.entries(identity).some(([key, value]) => transition.task[key] !== value)
          || transition.to.head !== observedSourceCommit || transition.to.fingerprint !== observedSourceFingerprint) throw error;
      }
      // A consumed ordinary writer may legitimately change its starting fingerprint
      // within its owned paths. Keep the completed contracts, then obtain a fresh
      // ordinary authority for the observed source; do not renew the historical grant.
      const projection = await prepareForgeCrossLayerPreparation({ ...input,
        rpcId: prepareRequest.rpcId, promptText: prepareRequest.promptText });
      const current = await sourceObservationClient({ taskId });
      if (current?.source?.head !== observedSourceCommit
        || current.source.fingerprint !== observedSourceFingerprint) throw error;
      return { workflowCompleted: true, completedApiContract: projection.acceptedApiContract };
    }
  };

  const inspectPreviousBrowserPhase = async ({ taskId, prepareRequest, phaseFiles,
    allowFrontendRepair = false, allowFrontendUserAbortRetry = false, allowPhaseComplete = false,
    allowAccessWiringFormatRetry = false, allowRequirementsOverloadRetry = false, observedSourceCommit, observedSourceFingerprint,
    workspaceWriteAuthorized = false }) => {
    const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
    const phaseState = await readForgeDeliveryPhaseState(phaseFiles.stateFile, catalog);
    if (phaseState.status === 'completed') {
      return completedWorkflowContinuation({ taskId, prepareRequest, phaseFiles,
        observedSourceCommit, observedSourceFingerprint, workspaceWriteAuthorized });
    }
    if (['requirements', 'domain-contract', 'database'].includes(phaseState.currentPhaseId) && phaseState.currentPhaseIndex <= 2
      && (phaseState.taskId !== taskId || phaseState.sessionId !== prepareRequest.dshSessionId
        || phaseState.sourceCommit !== observedSourceCommit)) {
      throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '只读合同阶段续接与原任务、会话或源码不一致，原尝试未改变。', 409);
    }
    if (allowFrontendUserAbortRetry && phaseState.status === 'blocked') {
      throw new ManagerError('PHASE_TERMINAL_REPAIR_REQUIRED', '当前关联前端阶段的原尝试次数已用尽，失败证据已保留。', 409);
    }
    if (phaseState.activeAttempt === null || phaseState.activeAttempt.rpcId === prepareRequest.rpcId) return;
    // This is a read of the previous execution, not a renewal of its authority.
    // Terminal evidence remains collectable after the execution lease expires.
    const previous = await findActiveBrowserExecution({ taskId, phaseFiles, phaseState });
    const captured = await capturePhaseTerminal({ projectSlug, taskId,
      actorUserId: prepareRequest.actorUserId, actorUsername: prepareRequest.actorUsername,
      conversationId: prepareRequest.conversationId, executionId: previous.executionId });
    if (captured.status === 'pending') {
      throw new ManagerError('PHASE_CONVERSATION_STILL_RUNNING', '上一轮对话仍在执行，请等它结束后继续。', 409);
    }
    if (captured.status === 'context-failed') {
      if (workspaceWriteAuthorized !== true
        || !isForgeAccessWiringLeaseContinuation(prepareRequest.promptText, captured.execution)
        || observedSourceCommit !== captured.execution.sourceCommit
        || observedSourceFingerprint !== captured.execution.workspaceFingerprint) {
        throw new ManagerError('PHASE_TERMINAL_REPAIR_REQUIRED', '原上下文故障已留证；仅可沿当前未改变的权限候选继续补齐验证。', 409);
      }
      await prepareForgeDatabaseLeaseContinuation({ ...phaseFiles, taskId, sourceCommit: observedSourceCommit,
        sessionId: prepareRequest.dshSessionId, rpcId: prepareRequest.rpcId,
        previousExecutionId: previous.executionId, continuationText: prepareRequest.promptText,
        evidenceCorrection: true, contextRecovery: true });
      return;
    }
    if (captured.status === 'provider-failed') {
      if (captured.execution.phaseId === 'access-wiring' && captured.execution.phaseIndex === 6) {
        if (workspaceWriteAuthorized !== true || currentForgeAccessAcceptedCorrection(phaseState) === null
          || !isForgeAccessWiringLeaseContinuation(prepareRequest.promptText, captured.execution)
          || observedSourceCommit !== captured.execution.sourceCommit || captured.providerDraft === null
          || captured.providerDraft.changedPaths.some(candidate => !captured.execution.ownedPaths.some(owned => candidate === owned || candidate.startsWith(`${owned}/`)))) {
          throw new ManagerError('PHASE_TERMINAL_REPAIR_REQUIRED', '供应方错误及已有变更已保留；需要明确继续当前权限修复及有效写授权，不能据错误确认通过。', 409);
        }
        const latest = await sourceObservationClient({ taskId });
        if (latest?.schemaVersion !== 1 || latest.observationType !== 'forge-verify/source'
          || latest.projectSlug !== projectSlug || latest.taskId !== taskId || latest.source?.head !== observedSourceCommit
          || latest.source.fingerprint !== observedSourceFingerprint || latest.source.snapshotSha256 !== observedSourceFingerprint) {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '故障续修必须绑定当前实际源码。', 409);
        }
        await prepareForgeDatabaseLeaseContinuation({ ...phaseFiles, taskId, sourceCommit: observedSourceCommit,
          sessionId: prepareRequest.dshSessionId, rpcId: prepareRequest.rpcId, previousExecutionId: previous.executionId,
          continuationText: prepareRequest.promptText, evidenceCorrection: true, providerRecovery: true,
          draftSource: { sourceCommit: observedSourceCommit, workspaceFingerprint: observedSourceFingerprint, ...captured.providerDraft } });
        return;
      }
      if (!allowRequirementsOverloadRetry) {
        throw new ManagerError('PHASE_TERMINAL_REPAIR_REQUIRED', '供应方临时故障已留证，阶段未改变；可在原对话继续当前需求阶段。', 409);
      }
      const retry = await retryForgeRequirementsOverloadPhase({ ...phaseFiles, attemptDirectory: captured.attemptDirectory });
      if (retry.status === 'exhausted') {
        throw new ManagerError('PHASE_TERMINAL_REPAIR_REQUIRED', '当前需求阶段原有尝试次数已用尽，供应方故障及拒绝证据已保留。', 409);
      }
      return;
    }
    if (captured.status === 'interrupted') {
      if (phaseState.currentPhaseId === 'domain-contract' && phaseState.currentPhaseIndex === 1
        && isForgeDomainContractContinuation(prepareRequest.promptText, captured.execution)) {
        const before = await readPrivatePhaseJson(path.join(captured.phaseDirectory, 'phase-1-workspace-before.json'));
        const observed = await observeForgeDeliveryPhase({ workspace: path.join(taskspacesRoot, taskId, 'workspace'),
          baseCommit: phaseState.sourceCommit, before });
        if (observed.allChangedPaths.length !== 0 || observed.phaseChangedPaths.length !== 0) {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '只读领域合同续接不能携带源码变化，原尝试未改变。', 409);
        }
        await prepareForgeDomainUserAbortContinuation({ ...phaseFiles, taskId,
          sourceCommit: observedSourceCommit, sessionId: prepareRequest.dshSessionId, rpcId: prepareRequest.rpcId,
          previousExecutionId: previous.executionId, continuationText: prepareRequest.promptText });
        return;
      }
      if (!allowFrontendUserAbortRetry || workspaceWriteAuthorized !== true) {
        throw new ManagerError('PHASE_TERMINAL_REPAIR_REQUIRED', '上一轮已由用户中止，证明已保存；请在原对话明确“继续修改”并补充所需资料。', 409);
      }
      const retry = await retryForgeFrontendUserAbortedPhase({ ...phaseFiles,
        attemptDirectory: captured.attemptDirectory, repairRequestText: prepareRequest.promptText });
      if (retry.status === 'exhausted') {
        throw new ManagerError('PHASE_TERMINAL_REPAIR_REQUIRED', '当前关联前端阶段的原尝试次数已用尽，中止及拒绝证据已保留。', 409);
      }
      return;
    }
    if (workspaceWriteAuthorized === true && captured.status === 'captured'
      && phaseState.currentPhaseId === 'access-wiring' && phaseState.currentPhaseIndex === 6
      && path.basename(path.dirname(phaseFiles.stateFile)) === 'runtime-access-repair'
      && (isForgeConversationRepairContinuation(prepareRequest.promptText)
        || isForgeAccessWiringRuntimeRepairContinuation(prepareRequest.promptText, captured.execution))) {
      const baseline = await readPrivatePhaseJson(path.join(captured.attemptDirectory, 'session-baseline.json'));
      const denialFile = path.join(captured.attemptDirectory, '权限阶段-范围误拒证明.json');
      let proof = await readPrivatePhaseJson(denialFile);
      if (proof === null) {
        const inspected = await phaseSessionAccessScopeDenial({ projectSlug, taskId, execution: captured.execution,
          baseline, sessionProof: captured.capture.sessionProof });
        if (inspected?.status === 'access-scope-denial-proven') proof = inspected.proof;
        else if (inspected?.status !== 'not-applicable') {
          throw new ManagerError('PHASE_SESSION_CAPTURE_UNAVAILABLE', '无法确认原权限阶段写入范围误拒，原阶段保留。', 503);
        }
      }
      if (proof !== null && proof !== undefined) {
        await writeOrVerifyPrivatePhaseBytes(denialFile, Buffer.from(`${JSON.stringify(proof, null, 2)}\n`, 'utf8'));
        const retry = await retryForgeAccessWiringScopeDeniedPhase({ ...phaseFiles,
          attemptDirectory: captured.attemptDirectory, repairRequestText: prepareRequest.promptText,
          sourceFingerprint: observedSourceFingerprint });
        if (retry.status === 'exhausted') throw new ManagerError('PHASE_TERMINAL_REPAIR_REQUIRED', '原权限阶段尝试预算已用尽，失败证明保留。', 409);
        return;
      }
    }
    if (allowFrontendUserAbortRetry && workspaceWriteAuthorized === true
      && path.basename(path.dirname(phaseFiles.stateFile)) === 'frontend-repair') {
      const retainedPrompt = await readPrivatePhaseBytes(path.join(captured.attemptDirectory, '前端阶段-误拒前提示原文.md'));
      const promptBytes = retainedPrompt ?? await readPrivatePhaseBytes(phaseFiles.promptFile);
      const promptText = promptBytes?.toString('utf8').replace(/(?:\r?\n)+$/u, '');
      if (isForgeFrontendReadonlyRoleRecoveryCandidate({ execution: captured.execution, promptText })) {
        const baseline = await readPrivatePhaseJson(path.join(captured.attemptDirectory, 'session-baseline.json'));
        const denialFile = path.join(captured.attemptDirectory, '前端阶段-只读误拒证明.json');
        let proof = await readPrivatePhaseJson(denialFile);
        if (proof === null) {
          const inspected = await phaseSessionReadonlyDenial({ projectSlug, taskId, execution: captured.execution,
            baseline, sessionProof: captured.capture.sessionProof });
          if (inspected?.status === 'readonly-denial-proven') proof = inspected.proof;
          else if (inspected?.status !== 'not-applicable') {
            throw new ManagerError('PHASE_SESSION_CAPTURE_UNAVAILABLE', '无法确认本轮具体拒写原因，阶段状态未改变。', 503);
          }
        }
        if (proof !== null && proof !== undefined) {
          await writeOrVerifyPrivatePhaseBytes(denialFile, Buffer.from(`${JSON.stringify(proof, null, 2)}\n`, 'utf8'));
          await retryForgeFrontendReadonlyRolePhase({ ...phaseFiles, attemptDirectory: captured.attemptDirectory,
            repairRequestText: prepareRequest.promptText });
          return;
        }
      }
    }
    if (captured.status === 'captured' && isRenewableWorkflowPhaseWriter(captured.execution)
      && Date.parse(captured.execution.expiresAt) <= Date.now() && workspaceWriteAuthorized === true
      && (isForgeDatabaseLeaseContinuation(prepareRequest.promptText, captured.execution)
        || isForgeBackendLeaseContinuation(prepareRequest.promptText, captured.execution)
        || isForgeFrontendLeaseContinuation(prepareRequest.promptText, captured.execution)
        || isForgeAccessWiringLeaseContinuation(prepareRequest.promptText, captured.execution))) {
      const phase = catalog.workflows.find(item => item.id === phaseState.workflowId).phases[captured.execution.phaseIndex];
      const backend = phase.id === 'backend' && phase.index === 4;
      const frontend = phase.id === 'frontend' && phase.index === 5;
      const accessWiring = phase.id === 'access-wiring' && phase.index === 6;
      const implementation = backend || frontend || accessWiring;
      let proposal;
      try { proposal = parseForgeDeliveryPhaseProposal({ text: captured.capture.modelResponse, phase }); }
      catch (error) {
        if (!(accessWiring && allowAccessWiringFormatRetry === true
          && error?.code === 'PHASE_RESPONSE_INVALID' && error.payloadShapeIssue?.kind === 'missing-proposal-block')) throw error;
        // The explicit access format retry below records the failure against the
        // original budget; a missing artifact cannot prove a resumable lease draft.
      }
      const failedDraft = accessWiring ? isForgeAccessWiringLeasePauseProposal(proposal)
        : frontend ? isForgeFrontendLeasePauseProposal(proposal)
        : backend ? proposal.payload.redTests?.status === 'not_created'
        && proposal.payload.redTests.verification?.status === 'failed_before_execution'
        && proposal.payload.redTests.verification.executionProven === false
        && proposal.payload.redTests.verification.errorCode === 'ACCEPTANCE_CANDIDATE_BINDING_MISMATCH'
        : proposal.payload.migrationVersion?.status === 'written_not_applied'
        && proposal.payload.migrationVersion.liveDatabaseApplied === false
        && proposal.payload.migrationTest?.latestModuleRun?.status === 'failed'
        && Number.isSafeInteger(proposal.payload.migrationTest.latestModuleRun.failed)
        && proposal.payload.migrationTest.latestModuleRun.failed > 0;
      if (failedDraft || (!implementation && proposal.payload.migrationVersion?.status === 'not_written')) {
        if (!failedDraft && observedSourceFingerprint !== captured.execution.workspaceFingerprint) {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '租约恢复与原数据库源码指纹不一致。', 409);
        }
        const before = await readPrivatePhaseJson(path.join(captured.phaseDirectory, `phase-${captured.execution.phaseIndex}-workspace-before.json`));
        const observed = await observeForgeDeliveryPhase({ workspace: path.join(taskspacesRoot, taskId, 'workspace'),
          baseCommit: phaseState.sourceCommit, before });
        let draftSource;
        if (failedDraft) {
          const paths = proposal.payload.changedPaths;
          const inScope = candidate => captured.execution.ownedPaths.some(owned => candidate === owned || candidate.startsWith(`${owned}/`));
          if (!Array.isArray(paths) || paths.length === 0
            || JSON.stringify([...paths].sort()) !== JSON.stringify([...observed.phaseChangedPaths].sort())
            || (!implementation && observed.allChangedPaths.some(candidate => !inScope(candidate)))
            || observed.phaseChangedPaths.some(candidate => !inScope(candidate))
            || (implementation && observed.phaseChangedPaths.some(candidate => Object.hasOwn(before.entries, candidate)))) {
            throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '已写数据库候选与实际阶段变更或原授权范围不一致。', 409);
          }
          const latest = await sourceObservationClient({ taskId });
          if (latest?.schemaVersion !== 1 || latest.observationType !== 'forge-verify/source'
            || latest.projectSlug !== projectSlug || latest.taskId !== taskId
            || latest.source?.head !== observedSourceCommit || latest.source.fingerprint !== observedSourceFingerprint
            || latest.source.snapshotSha256 !== observedSourceFingerprint) {
            throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '数据库草稿在续接观察期间发生变化。', 409);
          }
          draftSource = { sourceCommit: observedSourceCommit, workspaceFingerprint: observedSourceFingerprint,
            snapshotDigest: observed.snapshot.snapshotDigest, changedPaths: observed.phaseChangedPaths };
        } else if (observed.allChangedPaths.length !== 0 || observed.phaseChangedPaths.length !== 0) {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '租约暂停恢复要求原数据库候选尚未写入，源码变化必须保留在原阶段处理。', 409);
        }
        for (const [name, paths] of [['累计变更文件.json', observed.allChangedPaths], ['本阶段变更文件.json', observed.phaseChangedPaths]]) {
          await writeOrVerifyPrivatePhaseBytes(path.join(captured.attemptDirectory, name), Buffer.from(`${JSON.stringify(paths)}\n`, 'utf8'));
        }
        await prepareForgeDatabaseLeaseContinuation({ ...phaseFiles, taskId, sourceCommit: observedSourceCommit,
          sessionId: prepareRequest.dshSessionId, rpcId: prepareRequest.rpcId,
          previousExecutionId: previous.executionId, continuationText: prepareRequest.promptText,
          ...(draftSource === undefined ? {} : { draftSource }) });
        return;
      }
    }
    if (captured.status === 'captured' && phaseState.currentPhaseId === 'backend' && phaseState.currentPhaseIndex === 4
      && workspaceWriteAuthorized === true && isForgeBackendLeaseContinuation(prepareRequest.promptText, captured.execution)) {
      const phase = catalog.workflows.find(item => item.id === phaseState.workflowId).phases[4];
      const proposal = parseForgeDeliveryPhaseProposal({ text: captured.capture.modelResponse, phase });
      if (isForgeBackendUnfinishedCandidate(proposal)) {
        if (phaseState.taskId !== taskId || phaseState.sessionId !== prepareRequest.dshSessionId
          || phaseState.sourceCommit !== observedSourceCommit) {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '后端续修与原任务、会话或源码HEAD不一致。', 409);
        }
        const failedReceipt = await phaseHostReceiptReader({ projectSlug, taskId,
          receiptId: proposal.payload.apiImplementation.latestGovernance.receiptId });
        const latest = await sourceObservationClient({ taskId });
        if (latest?.source?.head !== observedSourceCommit || latest.source.fingerprint !== observedSourceFingerprint
          || latest.source.snapshotSha256 !== observedSourceFingerprint) {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '后端候选在续修观察期间发生变化。', 409);
        }
        const retry = await retryForgeBackendUnfinishedPhase({ ...phaseFiles, attemptDirectory: captured.attemptDirectory,
          workspace: path.join(taskspacesRoot, taskId, 'workspace'), sourceCommit: observedSourceCommit,
          sourceFingerprint: observedSourceFingerprint, failedReceipt, continuationText: prepareRequest.promptText });
        if (retry.status === 'exhausted') throw new ManagerError('PHASE_TERMINAL_REPAIR_REQUIRED',
          '后端阶段原尝试次数已用尽，真实失败、源码及上游已保留；本次未启动新执行。', 409);
        return;
      }
    }
    if (captured.status === 'captured' && phaseState.currentPhaseId === 'cross-layer-acceptance'
      && phaseState.currentPhaseIndex === 7) {
      const reprobe = await readForgeCrossLayerRuntimeReprobe({ stateFile: phaseFiles.stateFile, state: phaseState });
      if (reprobe?.status === 'imported' && captured.execution.executionId === reprobe.previousExecutionId
        && phaseState.activeAttempt.attemptId === reprobe.attemptId
        && phaseState.activeAttempt.executionGeneration === reprobe.previousExecutionGeneration) return;
    }
    if (captured.status === 'captured' && workspaceWriteAuthorized === true
      && isForgeCrossLayerRuntimeReprobeContinuation(prepareRequest.promptText, captured.execution)) {
      let preparationExecution; let preparationTerminal;
      const reprobe = await readForgeCrossLayerRuntimeReprobe({ stateFile: phaseFiles.stateFile, state: phaseState });
      if (reprobe?.status === 'pending' && reprobe.rpcId !== prepareRequest.rpcId) {
        const executionFile = path.join(taskspacesRoot, '.broker', 'executions', `${taskId}.json`);
        const stored = await readPrivatePhaseJson(executionFile);
        preparationExecution = stored?.current;
        if (preparationExecution === undefined) throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '当前运行准备执行记录不可用。', 409);
        validateProtectedExecutionContext(preparationExecution);
        if (preparationExecution.crossLayerPreparation !== true
          || preparationExecution.authorityClass !== 'production-read-only' || preparationExecution.actionCeiling !== 'read-only'
          || preparationExecution.ownedPaths.length !== 0 || preparationExecution.sourceCommit !== observedSourceCommit
          || preparationExecution.preparationBinding?.workspaceFingerprint !== observedSourceFingerprint
          || ['actorUserId', 'actorUsername', 'conversationId', 'dshSessionId'].some(key => preparationExecution[key] !== prepareRequest[key])
          || preparationExecution.taskId !== taskId || preparationExecution.projectSlug !== projectSlug) {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '运行准备续接与当前用户、会话或源码不一致。', 409);
        }
        try { preparationTerminal = await preparationSessionTerminal({ projectSlug, taskId, execution: preparationExecution }); }
        catch (error) {
          if (error instanceof ManagerError) throw error;
          throw new ManagerError(error?.code === 'RECOVERY_SESSION_NOT_IDLE' ? 'PHASE_CONVERSATION_STILL_RUNNING' : 'PHASE_PREPARATION_TERMINAL_UNAVAILABLE',
            '上一轮运行准备的当前终态尚未得到确认，尚未启动新执行。', 409);
        }
        const after = await readPrivatePhaseJson(executionFile);
        if (JSON.stringify(after?.current) !== JSON.stringify(preparationExecution)) {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '采集运行准备终态期间当前执行已改变，尚未启动新执行。', 409);
        }
      }
      const browserPhase = await prepareForgeCrossLayerRuntimeReprobe({ ...phaseFiles,
        sourceCommit: observedSourceCommit, workspaceFingerprint: observedSourceFingerprint, taskId,
        sessionId: prepareRequest.dshSessionId, rpcId: prepareRequest.rpcId,
        promptText: prepareRequest.promptText, attemptDirectory: captured.attemptDirectory,
        ...(preparationExecution === undefined ? {} : { preparationExecution, preparationTerminal }) });
      return { browserPhase };
    }
    const assessment = await assessCapturedHostReceipts(captured, await assessCapturedPhase(captured));
    const backendEvidenceCorrection = phaseState.currentPhaseId === 'backend' && phaseState.currentPhaseIndex === 4
      && isForgeBackendEvidenceContinuation(prepareRequest.promptText, captured.execution);
    const frontendEvidenceCorrection = phaseState.currentPhaseId === 'frontend' && phaseState.currentPhaseIndex === 5
      && isForgeFrontendLeaseContinuation(prepareRequest.promptText, captured.execution);
    const accessEvidenceCorrection = phaseState.currentPhaseId === 'access-wiring' && phaseState.currentPhaseIndex === 6
      && [path.join(taskspacesRoot, '.broker', 'delivery-phases', taskId, 'phase-control', 'access-wiring-repair', 'runtime-access-repair'),
        path.join(taskspacesRoot, '.broker', 'delivery-phases', taskId, 'phase-control', 'access-wiring-repair', 'runtime-access-repair', 'access-wiring-repair')]
        .includes(path.dirname(phaseFiles.stateFile))
      && isForgeAccessWiringLeaseContinuation(prepareRequest.promptText, captured.execution);
    const implementationEvidenceCorrection = backendEvidenceCorrection || frontendEvidenceCorrection || accessEvidenceCorrection;
    const backendAcceptedCorrection = backendEvidenceCorrection
      && currentForgeAccessAcceptedCorrection(phaseState)?.phaseId === 'backend'
      && currentForgeAccessAcceptedCorrection(phaseState)?.attemptId === phaseState.activeAttempt?.attemptId;
    let phasePathsCorrection = false;
    if (accessEvidenceCorrection && assessment.status === 'needs-attention' && assessment.code === 'PHASE_RESPONSE_INVALID'
      && currentForgeAccessAcceptedCorrection(phaseState) !== null) {
      const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
      const phase = catalog.workflows.find(item => item.id === phaseState.workflowId).phases[6];
      try {
        const proposal = parseForgeDeliveryPhaseProposal({ text: captured.capture.modelResponse, phase });
        const declared = proposal.payload.changedPaths;
        const observed = await readPrivatePhaseJson(path.join(captured.attemptDirectory, '本阶段变更文件.json'));
        phasePathsCorrection = Array.isArray(declared) && Array.isArray(observed) && declared.length > 0
          && declared.length < observed.length && new Set(declared).size === declared.length
          && declared.every(candidate => typeof candidate === 'string' && observed.includes(candidate))
          && proposal.unresolvedDecisions.length === 0;
      } catch (error) { if (error?.code !== 'PHASE_RESPONSE_INVALID') throw error; }
    }
    if (((isDatabasePhaseWriter(captured.execution)
      && isForgeDatabaseEvidenceContinuation(prepareRequest.promptText, captured.execution)) || implementationEvidenceCorrection)
      && workspaceWriteAuthorized === true
      && ((assessment.status === 'preflight-ready' && assessment.hostVerification?.status === 'required') || phasePathsCorrection)
      ) {
      const before = await readPrivatePhaseJson(path.join(captured.phaseDirectory, `phase-${phaseState.currentPhaseIndex}-workspace-before.json`));
      const observed = await observeForgeDeliveryPhase({ workspace: path.join(taskspacesRoot, taskId, 'workspace'),
        baseCommit: phaseState.sourceCommit, before });
      const preflight = await readPrivatePhaseJson(path.join(captured.attemptDirectory, '阶段候选预检凭据.json'));
      const latest = await sourceObservationClient({ taskId });
      if (phasePathsCorrection) {
        for (const [name, bytes] of [
          ['本阶段变更文件.json', Buffer.from(`${JSON.stringify(observed.phaseChangedPaths)}\n`)],
          ['累计变更文件.json', Buffer.from(`${JSON.stringify(observed.allChangedPaths)}\n`)],
          ['本阶段实际变更.patch', observed.phasePatch], ['累计实际变更.patch', observed.cumulativePatch],
        ]) if (!(await readFile(path.join(captured.attemptDirectory, name))).equals(bytes)) {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '路径声明补正必须保留原采集候选源码。', 409);
        }
      }
      if ((phasePathsCorrection ? preflight !== null
        : observed.phasePatchDigest !== preflight.phasePatchDigest || observed.cumulativePatchDigest !== preflight.cumulativePatchDigest)
        || (implementationEvidenceCorrection ? observed.phaseChangedPaths : observed.allChangedPaths)
          .some(candidate => !captured.execution.ownedPaths.some(owned => candidate === owned || candidate.startsWith(`${owned}/`)))
        || (implementationEvidenceCorrection && !accessEvidenceCorrection && !backendAcceptedCorrection
          && observed.phaseChangedPaths.some(candidate => Object.hasOwn(before.entries, candidate)))
        || latest?.schemaVersion !== 1 || latest.observationType !== 'forge-verify/source'
        || latest.projectSlug !== projectSlug || latest.taskId !== taskId || latest.source?.head !== observedSourceCommit
        || latest.source.fingerprint !== observedSourceFingerprint || latest.source.snapshotSha256 !== observedSourceFingerprint) {
        throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '阶段补证必须绑定原候选的实际源码与授权路径，保持已接受的上游。', 409);
      }
      await prepareForgeDatabaseLeaseContinuation({ ...phaseFiles, taskId, sourceCommit: observedSourceCommit,
        sessionId: prepareRequest.dshSessionId, rpcId: prepareRequest.rpcId, previousExecutionId: previous.executionId,
        continuationText: prepareRequest.promptText, evidenceCorrection: true, phasePathsCorrection,
        draftSource: { sourceCommit: observedSourceCommit, workspaceFingerprint: observedSourceFingerprint,
          snapshotDigest: observed.snapshot.snapshotDigest, changedPaths: observed.phaseChangedPaths } });
      return;
    }
    if (assessment.status === 'needs-attention') {
      if (phaseState.currentPhaseId === 'requirements' && phaseState.currentPhaseIndex === 0
        && assessment.code === 'PHASE_CONTROLLER_BUSINESS_DECISION_REQUIRED') {
        const before = await readPrivatePhaseJson(path.join(captured.phaseDirectory, 'phase-0-workspace-before.json'));
        const observed = await observeForgeDeliveryPhase({ workspace: path.join(taskspacesRoot, taskId, 'workspace'),
          baseCommit: phaseState.sourceCommit, before });
        if (observed.allChangedPaths.length !== 0 || observed.phaseChangedPaths.length !== 0) {
          throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '需求阶段补充说明不能携带源码变化，原候选和尝试未改变。', 409);
        }
        await prepareForgeRequirementsClarification({ ...phaseFiles, taskId,
          sourceCommit: observedSourceCommit, sessionId: prepareRequest.dshSessionId, rpcId: prepareRequest.rpcId,
          previousExecutionId: previous.executionId, clarificationText: prepareRequest.promptText });
        return;
      }
      if (allowAccessWiringFormatRetry && workspaceWriteAuthorized === true
        && phaseState.currentPhaseId === 'access-wiring' && phaseState.currentPhaseIndex === 6
        && assessment.code === 'PHASE_RESPONSE_INVALID') {
        try {
          await createForgeDeliveryPhaseFormatRetryPrompt({
            ...phaseFiles,
            responseFile: captured.responseFile,
            allChangedPathsFile: path.join(captured.attemptDirectory, '累计变更文件.json'),
            phaseChangedPathsFile: path.join(captured.attemptDirectory, '本阶段变更文件.json'),
            phasePatchFile: path.join(captured.attemptDirectory, '本阶段实际变更.patch'),
            cumulativePatchFile: path.join(captured.attemptDirectory, '累计实际变更.patch'),
            rejectionReceiptFile: path.join(captured.attemptDirectory, '权限接线阶段-格式修复失败凭据.json'),
            repairRequestText: prepareRequest.promptText,
          });
        } catch (error) {
          if (error?.code !== 'PHASE_CONTROLLER_RETRY_NOT_ALLOWED') throw error;
          throw new ManagerError('PHASE_TERMINAL_REPAIR_REQUIRED',
            '当前权限接线候选不满足原剩余次数内的格式修复条件，原回答和失败证据已保留，本次未启动新执行。', 409);
        }
        return;
      }
      const phase = catalog.workflows.find((item) => item.id === phaseState.workflowId)?.phases[5];
      const failures = phaseState.history.filter((item) => item.phaseId === 'frontend');
      const frontendRepairAvailable = workspaceWriteAuthorized === true
        && ['PHASE_RESPONSE_INVALID', 'PHASE_CONTROLLER_MUTATION_DENIED', 'PHASE_CONTROLLER_ZERO_CHANGE',
          'PHASE_CONTROLLER_BUSINESS_DECISION_REQUIRED'].includes(assessment.code)
        && path.basename(path.dirname(phaseFiles.stateFile)) === 'phase-control'
        && phaseState.currentPhaseId === 'frontend' && phaseState.currentPhaseIndex === 5
        && failures.length + 1 === phase?.maxAttempts && failures.every((item) => item.decision === 'rejected');
      if (frontendRepairAvailable && allowFrontendRepair) {
        await rejectForgeDeliveryPhaseRun({ ...phaseFiles, reasonCode: assessment.code,
          receiptFile: path.join(captured.attemptDirectory, '前端阶段-原尝试失败凭据.json') });
        return true;
      }
      throw new ManagerError(frontendRepairAvailable ? 'PHASE_FRONTEND_REPAIR_AVAILABLE' : 'PHASE_TERMINAL_REPAIR_REQUIRED',
        `上一轮对话已结束，真实回答和变更已保存。阶段检查需要处理：${assessment.code}。原阶段及历史记录已保留。`, 409);
    }
    const acceptancePhase = catalog.workflows.find(item => item.id === phaseState.workflowId)?.phases[phaseState.currentPhaseIndex];
    const readonlyContractReady = ((acceptancePhase?.id === 'requirements' && acceptancePhase.index === 0)
      || (acceptancePhase?.id === 'domain-contract' && acceptancePhase.index === 1)
      || (acceptancePhase?.id === 'ui-design' && acceptancePhase.index === 3))
      && acceptancePhase.id === phaseState.currentPhaseId && acceptancePhase.index === phaseState.currentPhaseIndex
      && acceptancePhase.actionCeiling === 'read-only' && acceptancePhase.sourceMutation === false
      && acceptancePhase.ownedPaths.length === 0 && acceptancePhase.hostVerificationProfiles.length === 0
      && assessment.hostVerification?.status === 'not-required';
    const implementedPhaseReady = ((phaseState.currentPhaseId === 'database' && phaseState.currentPhaseIndex === 2)
      || (phaseState.currentPhaseId === 'backend' && phaseState.currentPhaseIndex === 4)
      || (phaseState.currentPhaseId === 'frontend' && phaseState.currentPhaseIndex === 5)
      || (phaseState.currentPhaseId === 'access-wiring' && phaseState.currentPhaseIndex === 6)
      || (phaseState.currentPhaseId === 'cross-layer-acceptance' && phaseState.currentPhaseIndex === 7))
      && (assessment.hostVerification?.status === 'verified'
        || (phaseState.currentPhaseId === 'cross-layer-acceptance' && phaseState.currentPhaseIndex === 7
          && assessment.hostVerification?.status === 'reused-upstream'));
    if (readonlyContractReady && assessment.status === 'preflight-ready'
      && isForgeDomainCandidateCorrection(prepareRequest.promptText, captured.execution)) {
      const before = await readPrivatePhaseJson(path.join(captured.phaseDirectory, 'phase-1-workspace-before.json'));
      const observed = await observeForgeDeliveryPhase({ workspace: path.join(taskspacesRoot, taskId, 'workspace'),
        baseCommit: phaseState.sourceCommit, before });
      if (observed.allChangedPaths.length !== 0 || observed.phaseChangedPaths.length !== 0) {
        throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '只读领域合同纠正不能携带源码变化，原候选和尝试未改变。', 409);
      }
      await prepareForgeDomainCandidateCorrection({ ...phaseFiles, taskId,
        sourceCommit: observedSourceCommit, sessionId: prepareRequest.dshSessionId, rpcId: prepareRequest.rpcId,
        previousExecutionId: previous.executionId, continuationText: prepareRequest.promptText });
      return;
    }
    const domainAcceptance = isForgeDomainAcceptanceContinuation(prepareRequest.promptText, captured.execution);
    const backendAcceptance = captured.execution.phaseId === 'backend' && captured.execution.phaseIndex === 4
      && isForgeBackendPhaseCompletion(prepareRequest.promptText, captured.execution);
    const frontendAcceptance = captured.execution.phaseId === 'frontend' && captured.execution.phaseIndex === 5
      && isForgeFrontendPhaseCompletion(prepareRequest.promptText, captured.execution);
    const accessAcceptance = captured.execution.phaseId === 'access-wiring' && captured.execution.phaseIndex === 6
      && isForgeAccessWiringPhaseCompletion(prepareRequest.promptText, captured.execution);
    const crossLayerAcceptance = isForgeCrossLayerPhaseCompletion(prepareRequest.promptText, captured.execution);
    if ((allowPhaseComplete || domainAcceptance || backendAcceptance || frontendAcceptance || accessAcceptance || crossLayerAcceptance) && workspaceWriteAuthorized === true
      && (readonlyContractReady || implementedPhaseReady) && assessment.status === 'preflight-ready') {
      if (readonlyContractReady) {
        await writeOrVerifyPrivatePhaseBytes(path.join(captured.attemptDirectory, '阶段宿主验证回执.json'), Buffer.from('[]\n'));
      }
      const result = await finalizeForgeDeliveryPhaseRun({
        ...phaseFiles,
        responseFile: captured.responseFile,
        allChangedPathsFile: path.join(captured.attemptDirectory, '累计变更文件.json'),
        phaseChangedPathsFile: path.join(captured.attemptDirectory, '本阶段变更文件.json'),
        phasePatchFile: path.join(captured.attemptDirectory, '本阶段实际变更.patch'),
        cumulativePatchFile: path.join(captured.attemptDirectory, '累计实际变更.patch'),
        hostReceiptsFile: path.join(captured.attemptDirectory, '阶段宿主验证回执.json'),
        outputDirectory: path.join(captured.attemptDirectory, 'controller'),
        nextPromptFile: phaseFiles.promptFile,
        expectedAttemptId: captured.begin.attempt.attemptId,
      });
      if (result.acceptedPhaseId !== captured.execution.phaseId
        || result.acceptedPhaseIndex !== captured.execution.phaseIndex) {
        throw new ManagerError('PHASE_CAPTURE_RECORD_CONFLICT', '阶段接受结果与原对话阶段不一致。', 409);
      }
      if (result.workflowStatus === 'completed') return completedWorkflowContinuation({ taskId, prepareRequest, phaseFiles,
        observedSourceCommit, observedSourceFingerprint, workspaceWriteAuthorized });
      if (currentForgeAccessAcceptedCorrection(phaseState)?.phaseId === 'backend') {
        return { browserPhase: await prepareForgeCrossLayerPreparation({ ...phaseFiles,
          sourceCommit: observedSourceCommit, workspaceFingerprint: observedSourceFingerprint, taskId,
          sessionId: prepareRequest.dshSessionId, rpcId: prepareRequest.rpcId, promptText: prepareRequest.promptText }) };
      }
      return;
    }
    if (readonlyContractReady) {
      throw new ManagerError('PHASE_ACCEPTANCE_REQUIRED',
        '当前只读合同候选已预检通过，本阶段没有宿主执行义务。阶段尚未接受；确认候选后可在原对话继续完成。', 409);
    }
    if (assessment.hostVerification?.status === 'reused-upstream') {
      throw new ManagerError('PHASE_ACCEPTANCE_REQUIRED',
        '本轮跨层未修改已接受源码，已绑定复用上游验证；三个默认宿主检查本轮未重跑。仍待当前跨层结果验收，可在原对话确认完成。', 409);
    }
    throw new ManagerError(assessment.code, assessment.hostVerification?.status === 'verified'
      ? '上一轮对话及真实宿主验证回执已保存并核验，仍待阶段验收。可发送只读请求核对结果与来源；当前阶段结果确认无误后，发送“继续完成”继续验收。'
      : '上一轮对话已结束，真实回答和变更已保存，候选预检通过；仍需有效宿主机验证回执及阶段验收，当前阶段尚未通过。', 409);
  };

  const taskRuntimeCapabilities = async (taskId) => {
    const file = path.join(path.dirname(metadataPath(taskId)), 'task.env');
    const before = await lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const absent = { conversationTaskPreparationSupported: false, conversationFormatMaintenanceSupported: false,
      conversationContractContinuationSupported: false, independentReviewSuspensionSupported: false, changedVerificationSupported: false,
      focusedBackendVerificationSupported: false, ordinaryFinalVerificationSupported: false };
    if (before === null) return absent;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024) {
      throw new ManagerError('TASKSPACE_RUNTIME_INVALID', '工作舱运行配置不可读取。', 503);
    }
    const raw = await readFile(file, 'utf8');
    if (!sameFileIdentity(before, await lstat(file))) {
      throw new ManagerError('TASKSPACE_RUNTIME_CHANGED', '工作舱运行配置正在更新，请稍后继续。', 409);
    }
    const lines = raw.split(/\r?\n/u);
    const supported = (name) => {
      const markers = lines.filter((line) => line.startsWith(`${name}=`));
      if (markers.length === 0) return false;
      if (markers.length !== 1 || ![`${name}=true`, `${name}=false`].includes(markers[0])) {
        throw new ManagerError('TASKSPACE_RUNTIME_INVALID', '工作舱任务工具版本配置无效。', 503);
      }
      return markers[0] === `${name}=true`;
    };
    return {
      conversationTaskPreparationSupported: supported('FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED'),
      conversationFormatMaintenanceSupported: supported('FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED'),
      conversationContractContinuationSupported: supported('FORGE_CONVERSATION_CONTRACT_CONTINUATION_SUPPORTED'),
      independentReviewSuspensionSupported: supported('FORGE_INDEPENDENT_REVIEW_SUSPENSION_SUPPORTED'),
      changedVerificationSupported: supported('FORGE_CHANGED_VERIFICATION_SUPPORTED'),
      focusedBackendVerificationSupported: supported('FORGE_FOCUSED_BACKEND_VERIFICATION_SUPPORTED'),
      ordinaryFinalVerificationSupported: supported('FORGE_ORDINARY_FINAL_VERIFICATION_SUPPORTED'),
    };
  };

  const execute = async (args) => {
    const result = await runControl(controlScript, projectSlug, args, commandTimeoutMs);
    if (result?.code === 0) return result;
    throw new ManagerError(
      'CONTROL_FAILED',
      'TaskSpace 控制操作失败。',
      502,
      {
        code: result?.code ?? null,
        signal: result?.signal ?? null,
        diagnostic: typeof result?.stderr === 'string' ? result.stderr.slice(-4000) : '',
      },
    );
  };

  const appendAudit = async (entry) => {
    await mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      projectSlug,
      ...entry,
    })}\n`;
    await appendFile(auditPath, line, { encoding: 'utf8', mode: 0o600 });
  };

  const authorize = (request) => {
    const value = request.headers.authorization;
    if (typeof value !== 'string' || !value.startsWith('Bearer ')
      || !timingSafeTextEqual(value.slice('Bearer '.length), managerToken)) {
      throw new ManagerError('UNAUTHORIZED', '未授权。', 401);
    }
  };

  const server = http.createServer(async (request, response) => {
    const requestId = typeof request.headers['x-request-id'] === 'string'
      ? request.headers['x-request-id'].slice(0, 128)
      : crypto.randomUUID();
    const parsed = new URL(request.url ?? '/', 'http://conversation-manager.invalid');
    let auditAction;
    let auditTaskId;
    try {
      if (request.method === 'GET' && parsed.pathname === '/healthz') {
        await stat(controlScript);
        await execute(['preflight']);
        await materials.initialize();
        json(response, 200, { ok: true, projectSlug });
        return;
      }
      if (request.method === 'POST' && parsed.pathname === '/v1/execution-renewal-authority') {
        if (typeof server.address() !== 'string') {
          throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_DENIED', '执行续期授权查询仅允许项目内部连接。', 403);
        }
        if (await routeRuntimeManagerRequest({ request, response, projectRoot, runtimeChannel,
          runtimeVersionId, readBody: readJson, readMetadata, managerToken })) return;
        const input = await readJson(request);
        if (!isExecutionRenewalAuthorityRequest(input) || input.projectSlug !== projectSlug) {
          throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '执行续期身份与当前项目不匹配。', 409);
        }
        let taskMetadata;
        let context;
        const current = async () => readCurrentProtectedExecutionContextForTask({
          projectRoot, taskMetadata, allowExpiredForRenewal: true,
        });
        try {
          taskMetadata = await readMetadata(input.taskId);
          context = await current();
        } catch (error) {
          throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '当前受保护执行身份不可用于续期。',
            error?.status >= 500 ? 503 : 409);
        }
        const identity = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
          'dshSessionId', 'rpcId', 'contractId', 'actionCeiling'];
        if (taskMetadata.status !== 'active' || taskMetadata.accessMode !== 'conversation'
          || !identity.every((key) => input[key] === context[key])) {
          throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '执行续期身份与当前受保护任务不匹配。', 409);
        }
        const databasePhaseAuthority = async () => {
          if (!isRenewableWorkflowPhaseWriter(context)) return undefined;
          const { phaseDirectory } = await resolveBrowserPhase({ taskId: input.taskId });
          const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
          const state = await readForgeDeliveryPhaseState(path.join(phaseDirectory, 'state.json'), catalog);
          const phase = catalog.workflows.find(item => item.id === state.workflowId)?.phases[state.currentPhaseIndex];
          const attempt = state.activeAttempt;
          if (state.status !== 'active' || state.currentPhaseId !== context.phaseId || state.currentPhaseIndex !== context.phaseIndex
            || state.taskId !== context.taskId || state.sessionId !== context.dshSessionId
            || state.sourceCommit !== context.sourceCommit || state.workflowId !== context.workflowId
            || state.catalogVersion !== context.phaseCatalogVersion || state.catalogDigest !== context.phaseCatalogDigest
            || attempt?.rpcId !== context.rpcId || attempt?.executionGeneration !== context.generation
            || attempt?.promptDigest !== context.promptDigest || attempt?.phaseId !== context.phaseId
            || phase?.actionCeiling !== context.actionCeiling
            || JSON.stringify([...phase.ownedPaths].sort()) !== JSON.stringify([...context.ownedPaths].sort())
            || JSON.stringify(phase.contractVerificationProfiles) !== JSON.stringify(context.requiredProfiles)) {
            throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '数据库续期不再匹配当前阶段、尝试或授权范围。', 409);
          }
          // A writer's original baseline remains the execution identity. Its current
          // draft is a separate observed fact and must stay within this DB phase.
          const observeDraftSource = async () => {
            if (typeof sourceObservationClient !== 'function') {
              throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_UNAVAILABLE', '数据库续期的当前源码观察暂不可用。', 503);
            }
            const value = await sourceObservationClient({ taskId: context.taskId });
            if (value?.schemaVersion !== 1 || value.observationType !== 'forge-verify/source'
              || value.projectSlug !== projectSlug || value.taskId !== context.taskId
              || value.source?.head !== context.sourceCommit
              || !/^[0-9a-f]{64}$/u.test(value.source?.fingerprint ?? '')
              || value.source.snapshotSha256 !== value.source.fingerprint) {
              throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '数据库续期未绑定当前真实源码及原HEAD。', 409);
            }
            return { head: value.source.head, fingerprint: value.source.fingerprint };
          };
          const draftBefore = await observeDraftSource();
          const before = await readPrivatePhaseJson(path.join(phaseDirectory, `phase-${context.phaseIndex}-workspace-before.json`));
          const observed = await observeForgeDeliveryPhase({ workspace: path.join(taskspacesRoot, context.taskId, 'workspace'),
            baseCommit: context.sourceCommit, before });
          if ((context.phaseId !== 'database' ? observed.phaseChangedPaths : [...observed.allChangedPaths, ...observed.phaseChangedPaths]).some(candidate =>
            !context.ownedPaths.some(owned => candidate === owned || candidate.startsWith(`${owned}/`)))
            || (context.phaseId !== 'database' && observed.phaseChangedPaths.some(candidate => Object.hasOwn(before.entries, candidate)))) {
            throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '当前草稿包含数据库阶段授权范围之外的变化。', 409);
          }
          const draftAfter = await observeDraftSource();
          if (JSON.stringify(draftBefore) !== JSON.stringify(draftAfter)) {
            throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '数据库续期观察期间源码发生变化。', 409);
          }
          return { workflowId: state.workflowId, phaseId: phase.id, phaseIndex: state.currentPhaseIndex,
            catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest, stateDigest: state.stateDigest,
            attemptId: attempt.attemptId, executionId: context.executionId, generation: context.generation,
            sourceCommit: context.sourceCommit, workspaceFingerprint: context.workspaceFingerprint,
            ownedPaths: phase.ownedPaths, taskProfiles: phase.taskProfiles,
            draftSource: { ...draftAfter, changedPaths: context.phaseId !== 'database' ? observed.phaseChangedPaths : observed.allChangedPaths } };
        };
        const phaseAuthority = await databasePhaseAuthority();
        if (typeof executionRenewalAuthorityClient !== 'function') {
          throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_UNAVAILABLE', '当前账户授权查询暂不可用。', 503, { retryable: true });
        }
        let result;
        try { result = await executionRenewalAuthorityClient(input); } catch (error) {
          if (error instanceof ManagerError) throw error;
          throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_UNAVAILABLE', '当前账户授权查询暂不可用。', 503, { retryable: true });
        }
        const { authorizedActionCeiling, checkedAt, ...echo } = result ?? {};
        const ceilings = ['workspace-write', 'git-checkpoint', 'release'];
        if (!isExecutionRenewalAuthorityRequest(echo) || !Object.keys(input).every((key) => echo[key] === input[key])
          || !ceilings.includes(authorizedActionCeiling)
          || ceilings.indexOf(input.actionCeiling) > ceilings.indexOf(authorizedActionCeiling)
          || typeof checkedAt !== 'string' || !Number.isFinite(Date.parse(checkedAt))
          || new Date(checkedAt).toISOString() !== checkedAt || Math.abs(Date.now() - Date.parse(checkedAt)) > 30_000) {
          throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '当前账户授权响应未绑定本次执行。', 409);
        }
        let after;
        try { taskMetadata = await readMetadata(input.taskId); after = await current(); } catch {
          throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '授权查询期间受保护执行发生变化。', 409);
        }
        if (taskMetadata.status !== 'active' || taskMetadata.accessMode !== 'conversation'
          || ![...identity, 'executionId', 'generation', 'sourceCommit', 'workspaceFingerprint', 'productionAuthorityDigest']
          .every((key) => after[key] === context[key])) {
          throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '授权查询期间受保护执行发生变化。', 409);
        }
        if (JSON.stringify(await databasePhaseAuthority()) !== JSON.stringify(phaseAuthority)) {
          throw new ManagerError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '授权查询期间数据库阶段已经变化。', 409);
        }
        json(response, 200, { ...result, ...(phaseAuthority === undefined ? {} : { phaseAuthority }) });
        return;
      }
      authorize(request);
      if (await routeRuntimeManagerRequest({ request, response, projectRoot, runtimeChannel,
        runtimeVersionId, readBody: readJson, readMetadata, managerToken })) return;

      if (request.method === 'GET' && parsed.pathname === '/v1/runtime-versions') {
        const catalog = await loadRuntimeVersions(path.join(projectRoot, 'ops', 'harness-runtime-versions.json'));
        json(response, 200, { ok: true, defaultChannel: catalog.defaultChannel,
          versions: catalog.versions.map(publicRuntimeVersion) });
        return;
      }

      if (request.method === 'GET' && parsed.pathname === '/v1/project-release-status') {
        let status;
        try {
          status = await projectReleaseStatusReader(path.join(projectRoot, 'taskspaces', '.broker', 'project-status.sock'));
          if (status.projectSlug !== projectSlug) throw new Error('Project scope mismatch.');
        } catch {
          throw new ManagerError('PROJECT_RELEASE_STATUS_UNAVAILABLE', '发布状态暂不可确认，请稍后刷新。', 503);
        }
        json(response, 200, { ok: true, status });
        return;
      }

      const phaseOutputMatch = /^\/v1\/taskspaces\/([a-z0-9-]+)\/phase-outputs(?:\/([a-f0-9]{64})\/([^/]+))?$/u.exec(parsed.pathname);
      if (request.method === 'GET' && phaseOutputMatch !== null) {
        const taskMetadata = await readMetadata(phaseOutputMatch[1]);
        const phaseFiles = createPhaseWorkPackageFiles({ taskspacesRoot, projectSlug, taskMetadata });
        if (phaseOutputMatch[2] === undefined) {
          const offset = Number(parsed.searchParams.get('offset') ?? '0');
          const limit = Number(parsed.searchParams.get('limit') ?? '20');
          json(response, 200, { ok: true, ...(await phaseFiles.list({ offset, limit })) });
        } else {
          let name;
          try { name = decodeURIComponent(phaseOutputMatch[3]); } catch {
            throw new ManagerError('INVALID_PHASE_OUTPUT_PATH', '阶段文件路径不合法。', 400);
          }
          const item = await phaseFiles.read({ packageId: phaseOutputMatch[2], name });
          json(response, 200, { ok: true, name: item.name, displayName: item.displayName,
            downloadName: item.downloadName, mediaType: item.mediaType, sha256: item.sha256,
            bytes: item.buffer.length, base64: item.buffer.toString('base64') });
        }
        return;
      }

      const outputListMatch = /^\/v1\/taskspaces\/([a-z0-9-]+)\/outputs$/u.exec(parsed.pathname);
      if (request.method === 'GET' && outputListMatch !== null) {
        const taskId = validateControlValue(validateTaskId, outputListMatch[1], 'INVALID_TASK_ID', 'TaskSpace 标识不合法。');
        const metadata = await readMetadata(taskId);
        if (metadata.projectSlug !== projectSlug || !['active', 'stopped', 'closed'].includes(metadata.status)) {
          throw new ManagerError('TASKSPACE_OUTPUTS_UNAVAILABLE', '对话归档不可用。', 409);
        }
        const outputStore = createConversationOutputStore({
          root: path.join(taskspacesRoot, taskId, 'uploads'),
          scope: { scopeType: 'taskspace-private', projectSlug, taskspaceId: taskId,
            actorId: metadata.actorId, conversationId: metadata.conversationId },
        });
        const sessionId = parsed.searchParams.get('sessionId') ?? undefined;
        const offset = Number.parseInt(parsed.searchParams.get('offset') ?? '0', 10);
        const limit = Number.parseInt(parsed.searchParams.get('limit') ?? '20', 10);
        json(response, 200, { ok: true, ...(await outputStore.list({ sessionId, offset, limit })) });
        return;
      }
      const outputReadMatch = /^\/v1\/taskspaces\/([a-z0-9-]+)\/outputs\/([^/]+)\/([a-f0-9]{64})\/([^/]+)$/u.exec(parsed.pathname);
      if (request.method === 'GET' && outputReadMatch !== null) {
        const taskId = validateControlValue(validateTaskId, outputReadMatch[1], 'INVALID_TASK_ID', 'TaskSpace 标识不合法。');
        const metadata = await readMetadata(taskId);
        if (metadata.projectSlug !== projectSlug || !['active', 'stopped', 'closed'].includes(metadata.status)) {
          throw new ManagerError('TASKSPACE_OUTPUTS_UNAVAILABLE', '对话归档不可用。', 409);
        }
        const outputStore = createConversationOutputStore({ root: path.join(taskspacesRoot, taskId, 'uploads'),
          scope: { scopeType: 'taskspace-private', projectSlug, taskspaceId: taskId,
            actorId: metadata.actorId, conversationId: metadata.conversationId }, maxBytes: MAX_OUTPUT_FILE_BYTES });
        let sessionId; let name;
        try { sessionId = decodeURIComponent(outputReadMatch[2]); name = decodeURIComponent(outputReadMatch[4]); } catch {
          throw new ManagerError('INVALID_OUTPUT_PATH', '归档路径不合法。', 400);
        }
        const item = await outputStore.read({ sessionId, snapshotId: outputReadMatch[3], name });
        if (item.buffer.length > MAX_OUTPUT_FILE_BYTES) throw new ManagerError('OUTPUT_FILE_TOO_LARGE', '归档文件超过读取上限。', 413);
        json(response, 200, { ok: true, name: item.name, mediaType: item.mediaType, sha256: item.sha256,
          ...Object.fromEntries(['displayName', 'downloadName', 'phaseLabel', 'usageLabel', 'usageHint', 'versionLabel', 'primary']
            .filter((key) => item[key] !== undefined).map((key) => [key, item[key]])),
          bytes: item.buffer.length, base64: item.buffer.toString('base64') });
        return;
      }

      if (request.method === 'GET' && parsed.pathname === '/v1/materials') {
        const includeIntake = parsed.searchParams.get('includeIntake') === 'true';
        const offset = Number.parseInt(parsed.searchParams.get('offset') ?? '0', 10);
        const limit = Number.parseInt(parsed.searchParams.get('limit') ?? '200', 10);
        json(response, 200, {
          ok: true,
          accessMode: materialAccessMode,
          ...(await materials.list({ includeIntake, offset, limit })),
        });
        return;
      }

      if (request.method === 'POST' && parsed.pathname === '/v1/materials/promote') {
        const body = await readJson(request);
        const result = await materials.promote(body);
        await appendAudit({
          requestId,
          action: 'material.promote',
          actorId: body.actorId,
          sourcePath: body.sourcePath,
          targetPath: result.material.path,
          result: result.idempotent ? 'idempotent' : 'success',
        });
        json(response, 200, { ok: true, ...result });
        return;
      }

      if (request.method === 'POST' && parsed.pathname === '/v1/taskspaces') {
        const body = await readJson(request);
        const runtime = body.runtimeChannel === undefined ? undefined : request.runtimeResolvedVersion
          ?? await resolveRuntimeVersion(path.join(projectRoot, 'ops', 'harness-runtime-versions.json'), body.runtimeChannel, body.runtimeVersionId);
        const taskId = validateControlValue(validateTaskId, body.taskId, 'INVALID_TASK_ID', 'TaskSpace 标识不合法。');
        auditAction = 'create';
        auditTaskId = taskId;
        const actorId = validateActorId(body.actorId);
        const actorUserId = validateControlValue(
          validateActorUserId,
          body.actorUserId,
          'INVALID_ACTOR_USER_ID',
          '平台人员标识不合法。',
        );
        const conversationId = validateControlValue(
          validateConversationId,
          body.conversationId,
          'INVALID_CONVERSATION_ID',
          '对话标识不合法。',
        );
        if (body.accessMode !== 'conversation') {
          throw new ManagerError('INVALID_ACCESS_MODE', '自动会话只能使用 conversation 访问模式。', 400);
        }
        const requireMatchingIdentity = (candidate) => {
          if (runtime && candidate.runtimeVersion?.versionId !== runtime.versionId) {
            throw new ManagerError('RUNTIME_VERSION_CHANGED', '工作舱的实际运行版本与所选版本不一致。', 409);
          }
          if (candidate.schemaVersion !== 2) {
            throw new ManagerError(
              'TASKSPACE_IDENTITY_SCHEMA_CONFLICT',
              '旧版 TaskSpace 元数据仅可兼容读取，不能建立受保护执行身份。',
              409,
            );
          }
          if (candidate.actorId !== actorId
            || candidate.actorUserId !== actorUserId
            || candidate.conversationId !== conversationId
            || (candidate.accessMode ?? 'token') !== 'conversation') {
            throw new ManagerError('TASKSPACE_IDENTITY_CONFLICT', 'TaskSpace 已被其他身份占用。', 409);
          }
        };
        const metadata = await enqueue(taskId, async () => {
          const existing = await metadataIfPresent(taskId);
          if (existing !== undefined) {
            requireMatchingIdentity(existing);
            if (existing.status === 'active' || existing.status === 'stopped') return existing;
            if (existing.status === 'closed') {
              throw new ManagerError('TASKSPACE_CLOSED', '已关闭的 TaskSpace 不能恢复。', 409);
            }
            if (existing.status !== 'provisioning-failed') {
              throw new ManagerError('TASKSPACE_CREATE_STATE_CONFLICT', 'TaskSpace 当前状态不允许继续创建。', 409);
            }
            auditAction = 'recover';
            await runProvisioning(taskId, ['recover', taskId]);
            const recovered = await readMetadata(taskId);
            requireMatchingIdentity(recovered);
            if (recovered.status !== 'active') {
              throw new ManagerError(
                'TASKSPACE_RECOVERY_INCOMPLETE',
                'TaskSpace 恢复命令未形成 active 状态。',
                502,
              );
            }
            return recovered;
          }
          await runProvisioning(taskId, [
            'create',
            '--task', taskId,
            '--actor', actorId,
            '--actor-user-id', actorUserId,
            '--conversation', conversationId,
            '--access-mode', 'conversation',
            ...(runtime ? ['--runtime-channel', runtime.channel, '--runtime-version-id', runtime.versionId] : []),
          ]);
          const created = await readMetadata(taskId);
          requireMatchingIdentity(created);
          return created;
        });
        await appendAudit({ requestId, action: auditAction, taskId, result: 'success' });
        json(response, 200, { ok: true, taskspace: publicMetadata(metadata) });
        return;
      }

      const phaseCaptureMatch = /^\/v1\/taskspaces\/([a-z0-9-]+)\/phase-terminal\/capture$/u.exec(parsed.pathname);
      if (phaseCaptureMatch !== null && request.method === 'POST') {
        auditAction = 'phase.terminal.capture';
        auditTaskId = phaseCaptureMatch[1];
        const body = await readJson(request, MAX_REQUEST_BYTES);
        if (body?.taskId !== phaseCaptureMatch[1]) {
          throw new ManagerError('TASKSPACE_IDENTITY_CONFLICT', '终态采集请求的 TaskSpace 身份不一致。', 409);
        }
        const result = await enqueue(phaseCaptureMatch[1], async () => {
          const captured = await capturePhaseTerminal(body);
          return { ...captured, assessment: await assessCapturedHostReceipts(captured, await assessCapturedPhase(captured)) };
        });
        const summary = result.status === 'pending' ? result : {
          status: result.status,
          executionId: result.execution.executionId,
          phaseAttemptId: result.begin.attempt.attemptId,
          phaseId: result.execution.phaseId,
          generation: result.execution.generation,
          idempotent: result.idempotent,
          ...(result.status === 'context-failed' ? {
            terminalReason: result.capture.contextFailureProof.terminalReason,
            terminalEventDigest: result.capture.contextFailureProof.terminalEventDigest,
            errorCode: result.capture.contextFailureProof.error.code,
            stateAdvanced: false,
          } : result.status === 'provider-failed' ? {
            terminalReason: result.capture.providerFailureProof.terminalReason,
            terminalEventDigest: result.capture.providerFailureProof.terminalEventDigest,
            errorCode: result.capture.providerFailureProof.error.code,
            stateAdvanced: false,
          } : result.status === 'interrupted' ? {
            terminalReason: result.capture.interruptionProof.terminalReason,
            terminalEventDigest: result.capture.interruptionProof.terminalEventDigest,
          } : {
            modelResponseSha256: result.capture.sessionProof.modelResponseSha256,
            terminalEventDigest: result.capture.sessionProof.terminalEventDigest,
            assessment: result.assessment,
          }),
        };
        await appendAudit({ requestId, action: auditAction, taskId: auditTaskId,
          executionId: summary.executionId, result: summary.status });
        json(response, summary.status === 'pending' ? 202 : 200, { ok: true, ...summary });
        return;
      }

      const roleDecisionMatch = /^\/v1\/taskspaces\/([a-z0-9-]+)\/role-decisions$/u.exec(parsed.pathname);
      if (roleDecisionMatch !== null && request.method === 'POST') {
        const taskId = validateTaskId(roleDecisionMatch[1]);
        const body = await readJson(request, MAX_EXECUTION_PREPARE_BYTES);
        const keys = ['operation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
          ...(body.operation === 'confirm' ? ['previewId', 'previewDigest'] : [])];
        if (!['preview', 'confirm'].includes(body.operation)
          || Object.keys(body).sort().join() !== keys.sort().join()
          || body.taskId !== taskId || body.projectSlug !== projectSlug) {
          throw new ManagerError('ROLE_DECISION_INVALID', '角色确认请求不合法。', 422);
        }
        if (roleDecisionClient === null) throw new ManagerError('ROLE_DECISION_UNAVAILABLE', '角色确认入口尚未就绪。', 503);
        const result = await enqueue(taskId, async () => {
          const metadata = await readMetadata(taskId);
          if (metadata.status !== 'active' || metadata.accessMode !== 'conversation'
            || metadata.actorUserId !== body.actorUserId || metadata.actorId !== body.actorUsername
            || metadata.conversationId !== body.conversationId) {
            throw new ManagerError('TASKSPACE_IDENTITY_CONFLICT', '角色确认只能来自当前工作舱所属用户。', 403);
          }
          const readExecution = async taskMetadata => {
            try { return await readCurrentProtectedExecutionContextForTask({ projectRoot, taskMetadata }); }
            catch (error) {
              if (!(error instanceof ProtectedExecutionError)) throw error;
              throw new ManagerError('ROLE_DECISION_SCOPE_REQUIRED', '当前任务授权已变化或过期，请先在原对话重新准备。', 409);
            }
          };
          const execution = await readExecution(metadata);
          if (execution.authorityClass !== 'production-task-writer') {
            throw new ManagerError('ROLE_DECISION_SCOPE_REQUIRED', '请先在原对话准备本次代码任务。', 409);
          }
          const observe = async () => {
            const value = await sourceObservationClient({ taskId });
            if (value?.schemaVersion !== 1 || value.observationType !== 'forge-verify/source'
              || value.projectSlug !== projectSlug || value.taskId !== taskId
              || !/^[0-9a-f]{40}$/u.test(value.source?.head ?? '')
              || !/^[0-9a-f]{64}$/u.test(value.source?.fingerprint ?? '')
              || value.source.snapshotSha256 !== value.source.fingerprint) {
              throw new ManagerError('ACCEPTANCE_SOURCE_OBSERVATION_INVALID', '受控源码观测结果无效。', 503);
            }
            return { head: value.source.head, fingerprint: value.source.fingerprint };
          };
          const before = await observe();
          const grants = await previewGovernanceRoleGrants({ root: path.join(taskspacesRoot, taskId, 'workspace'),
            base: metadata.baseCommit, sourceHead: before.head, contractId: execution.contractId, ownedPaths: execution.ownedPaths })
            .catch(() => { throw new ManagerError('ROLE_PREVIEW_UNAVAILABLE', '无法安全读取当前 SQL 候选，请在原对话核对源码后重新预览。', 409); });
          const after = await observe();
          const current = await readExecution(await readMetadata(taskId));
          if (JSON.stringify(before) !== JSON.stringify(after) || current.executionId !== execution.executionId
            || current.generation !== execution.generation || current.contractId !== execution.contractId) {
            throw new ManagerError('ROLE_PREVIEW_SOURCE_CHANGED', '预览期间任务或源码已变化，请重新预览。', 409);
          }
          return roleDecisionClient({ ...body, dshSessionId: execution.dshSessionId,
            executionId: execution.executionId, generation: execution.generation,
            contractId: execution.contractId, source: after, grants });
        });
        await appendAudit({ requestId, action: `conversation.roles.${body.operation}`, taskId,
          previewId: result.previewId, result: result.status });
        json(response, 200, result);
        return;
      }

      const executionMatch = /^\/v1\/taskspaces\/([a-z0-9-]+)\/executions\/prepare$/u.exec(parsed.pathname);
      if (executionMatch !== null && request.method === 'POST') {
        const taskId = validateControlValue(
          validateTaskId,
          executionMatch[1],
          'INVALID_TASK_ID',
          'TaskSpace 标识不合法。',
        );
        const body = await readJson(request, MAX_EXECUTION_PREPARE_BYTES);
        if (body.taskId !== taskId || body.projectSlug !== projectSlug) {
          throw new ManagerError('TASKSPACE_IDENTITY_CONFLICT', '受保护执行请求的项目或 TaskSpace 身份不一致。', 409);
        }
        if (Object.hasOwn(body, 'workspaceWriteAuthorized') && typeof body.workspaceWriteAuthorized !== 'boolean') {
          throw new ManagerError('EXECUTION_WRITE_AUTHORIZATION_INVALID', '工作舱写权限必须由可信入口提供。', 422);
        }
        if (Object.hasOwn(body, 'conversationIntent') || Object.hasOwn(body, 'conversationTaskPreparationSupported')
          || Object.hasOwn(body, 'conversationFormatMaintenanceSupported')
          || Object.hasOwn(body, 'conversationContractContinuationSupported')
          || Object.hasOwn(body, 'independentReviewSuspensionSupported')
          || Object.hasOwn(body, 'changedVerificationSupported')
          || Object.hasOwn(body, 'focusedBackendVerificationSupported')
          || Object.hasOwn(body, 'ordinaryFinalVerificationSupported')) {
          throw new ManagerError('EXECUTION_RUNTIME_CAPABILITY_INVALID', '工作舱工具能力由受控运行配置确定。', 422);
        }
        if (Object.hasOwn(body, 'authorizedActionCeiling')
          && (!['workspace-write', 'git-checkpoint', 'release'].includes(body.authorizedActionCeiling)
            || body.workspaceWriteAuthorized !== true)) {
          throw new ManagerError('EXECUTION_WRITE_AUTHORIZATION_INVALID', '提交和发版权限必须来自当前用户的可信入口。', 422);
        }
        const { taskId: _taskId, projectSlug: _projectSlug,
          workspaceWriteAuthorized: roleWorkspaceWriteAuthorized, authorizedActionCeiling: roleActionCeiling,
          promptBody, ...originalPrepareRequest } = body;
        let explicitReadOnly = false;
        if (typeof promptBody === 'string' && originalPrepareRequest.route === 'session.prompt') {
          const actualInput = classifyPinnedDshPromptBody(Buffer.from(promptBody, 'utf8'), originalPrepareRequest.route);
          if (Object.keys(actualInput).some((key) => actualInput[key] !== originalPrepareRequest[key])) {
            throw new ManagerError('PHASE_BROWSER_REQUEST_MISMATCH', '当前对话请求与受控记录不一致。', 409);
          }
          explicitReadOnly = !semanticIntentEnabled && actualInput.classification === 'claimable-text'
            && hasGlobalReadOnlyIntent(originalPrepareRequest.promptText);
        }
        // Role authority is an upper bound. Only the verified direct user text
        // may lower this turn; generated Controller templates are not inspected.
        let workspaceWriteAuthorized = explicitReadOnly ? false : roleWorkspaceWriteAuthorized;
        let authorizedActionCeiling = explicitReadOnly ? undefined : roleActionCeiling;
        let conversationIntent;
        let prepareRequest = originalPrepareRequest;
        let forwardBody;
        let execution;
        const assertPrepareConnected = () => {
          if (request.aborted || response.destroyed || response.writableEnded) {
            throw new ManagerError('EXECUTION_PREPARE_CANCELLED', '执行准备请求已断开，已停止后续准备。', 409);
          }
        };
        try {
          execution = await enqueueTask(taskId, async () => {
            assertPrepareConnected();
            const taskMetadata = await readMetadata(taskId);
            if ((roleWorkspaceWriteAuthorized === true || semanticIntentEnabled) && (taskMetadata.schemaVersion !== 2
              || taskMetadata.status !== 'active' || taskMetadata.accessMode !== 'conversation'
              || taskMetadata.actorUserId !== prepareRequest.actorUserId
              || taskMetadata.actorId !== prepareRequest.actorUsername
              || taskMetadata.conversationId !== prepareRequest.conversationId)) {
              throw new ManagerError('TASKSPACE_IDENTITY_CONFLICT', '写入授权请求必须来自当前活动工作舱的所属用户和会话。', 409);
            }
            const queuedPrompt = prepareRequest.route === 'session.prompt' && prepareRequest.mode === 'queue';
            const rejectBusy = () => {
              throw new ManagerError('CONVERSATION_EXECUTION_BUSY', '上一轮对话或工具仍在执行，本次请求尚未进入模型；结束后可继续发送。', 409,
                { retryable: true, requestAccepted: false });
            };
            const checkPromptActivity = async () => {
              if (!queuedPrompt) return;
              const session = await promptSessionReader({ projectSlug, taskId });
              if (typeof session?.running !== 'boolean') {
                throw new ManagerError('CONVERSATION_ACTIVITY_UNAVAILABLE', '暂时无法确认上一轮执行状态，本次请求尚未进入模型。', 503);
              }
              if (session.running || await hasActiveForgeTaskWriter({ projectRoot, projectSlug, taskId })) rejectBusy();
            };
            await checkPromptActivity();
            if (semanticIntentEnabled && prepareRequest.classification === 'claimable-text') {
              if (typeof promptBody !== 'string' || developmentMode !== 'direct') {
                throw new ManagerError('CONVERSATION_INTENT_CONFIG_INVALID', '自然语言入口需要完整用户原文和已启用的精简模式。', 503);
              }
              try { conversationIntent = await resolveConversationIntent({projectSlug,taskId,...prepareRequest}); }
              catch (error) {
                const code = ['CONVERSATION_INTENT_INVALID','CONVERSATION_INTENT_UNAVAILABLE'].includes(error?.code)
                  ? error.code : 'CONVERSATION_INTENT_UNAVAILABLE';
                throw new ManagerError(code, '平台未能判定本轮用户意图，本次请求尚未执行；原任务和已完成结果保留。', 503);
              }
              explicitReadOnly = !conversationIntent.resolved.writable;
              // Account authority remains independent of the semantic decision.
              workspaceWriteAuthorized = roleWorkspaceWriteAuthorized;
              authorizedActionCeiling = roleActionCeiling;
              assertPrepareConnected();
            }
            let observation = null;
            if (acceptanceControlClient !== null) {
              observation = await sourceObservationClient({ taskId });
              if (queuedPrompt) {
                if (typeof observation?.taskActivity?.active !== 'boolean') {
                  throw new ManagerError('CONVERSATION_ACTIVITY_UNAVAILABLE', '暂时无法确认当前工作舱工具状态，本次请求尚未进入模型。', 503);
                }
                if (observation.taskActivity.active) rejectBusy();
                // Source observation may take time. Recheck immediately before
                // authorizing a replacement; other tasks' lifecycle work cannot delay it.
                await checkPromptActivity();
              }
              if (observation?.schemaVersion !== 1 || observation.observationType !== 'forge-verify/source'
                || observation.projectSlug !== projectSlug || observation.taskId !== taskId
                || observation.source?.snapshotSha256 !== observation.source?.fingerprint) {
                throw new ManagerError('ACCEPTANCE_SOURCE_OBSERVATION_INVALID', '受控源码观测结果无效。', 503);
              }
            }
            assertPrepareConnected();
            let phaseDirectory = path.join(taskspacesRoot, '.broker', 'delivery-phases', taskId, 'phase-control');
            // Direct development preserves historical phase files without routing
            // new messages through their workflow or manufacturing completion.
            const phaseDirectoryInfo = developmentMode === 'direct' ? null : await lstat(phaseDirectory).catch((error) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
            let browserPhase;
            let completedApiContract;
            let phaseFiles;
            let repairContinuation;
            // A question must not replace a failed requirements execution with a
            // fresh read-only model turn. Retain the actual failure for an explicit continuation.
            if (phaseDirectoryInfo?.isDirectory() && !phaseDirectoryInfo.isSymbolicLink()
              && explicitReadOnly && phaseCatalogFile !== undefined && observation !== null) {
              const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
              const requirementsFiles = { stateFile: path.join(phaseDirectory, 'state.json') };
              const requirementsState = await readForgeDeliveryPhaseState(requirementsFiles.stateFile, catalog);
              if (requirementsState.currentPhaseId === 'requirements' && requirementsState.currentPhaseIndex === 0
                && requirementsState.status === 'active' && requirementsState.activeAttempt !== null
                && requirementsState.activeAttempt.rpcId !== prepareRequest.rpcId) {
                if (requirementsState.taskId !== taskId || requirementsState.sessionId !== prepareRequest.dshSessionId
                  || requirementsState.sourceCommit !== observation.source.head) {
                  throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '需求阶段查询与原任务、会话或源码不一致。', 409);
                }
                const previous = await findActiveBrowserExecution({ taskId, phaseFiles: requirementsFiles, phaseState: requirementsState });
                const captured = await capturePhaseTerminal({ projectSlug, taskId, actorUserId: prepareRequest.actorUserId,
                  actorUsername: prepareRequest.actorUsername, conversationId: prepareRequest.conversationId,
                  executionId: previous.executionId });
                if (captured.status === 'provider-failed') {
                  throw new ManagerError('PHASE_TERMINAL_REPAIR_REQUIRED', '供应方临时故障已留证，本次查询未启动新执行；可在原对话继续当前需求阶段。', 409);
                }
              }
            }
            phaseRouting: if (phaseDirectoryInfo !== null && !explicitReadOnly) {
              if (!phaseDirectoryInfo.isDirectory() || phaseDirectoryInfo.isSymbolicLink()
                || (process.platform !== 'win32' && (phaseDirectoryInfo.mode & 0o077) !== 0)
                || phaseCatalogFile === undefined || observation === null || executionAuthorityClient === null) {
                throw new ManagerError('PHASE_CONTROLLER_UNAVAILABLE', '当前业务阶段的受控输入不可用，尚未启动模型。', 503);
              }
              if (typeof promptBody !== 'string' || prepareRequest.route !== 'session.prompt'
                || prepareRequest.classification !== 'claimable-text' || prepareRequest.mode !== 'queue') {
                throw new ManagerError('PHASE_BROWSER_REQUEST_REQUIRED', '当前业务阶段需要由原对话发送一条完整文本请求。', 409);
              }
              const actualInput = classifyPinnedDshPromptBody(Buffer.from(promptBody, 'utf8'), prepareRequest.route);
              if (Object.keys(actualInput).some((key) => actualInput[key] !== prepareRequest[key])) {
                throw new ManagerError('PHASE_BROWSER_REQUEST_MISMATCH', '当前对话请求与受控记录不一致。', 409);
              }
              const explicitRepair = isForgeConversationRepairContinuation(originalPrepareRequest.promptText);
              const explicitComplete = /^继续完成[。！!\s]*$/u.test(originalPrepareRequest.promptText.trim())
                && isForgeConversationTaskContinuation(originalPrepareRequest.promptText);
              if (explicitRepair && workspaceWriteAuthorized !== true) {
                throw new ManagerError('PHASE_USER_SCOPE_REQUIRED', '继续修改需要原对话的工作区写入授权。', 409);
              }
              let resolved = await resolveBrowserPhase({ taskId, sessionId: prepareRequest.dshSessionId,
                sourceCommit: observation.source.head });
              phaseFiles = resolved.phaseFiles;
              const acceptedRuntimeDirectory = path.join(taskspacesRoot, '.broker', 'delivery-phases', taskId,
                'phase-control', 'access-wiring-repair', 'runtime-access-repair', 'access-wiring-repair');
              if (resolved.continuation !== null && [path.join(taskspacesRoot,
                '.broker', 'delivery-phases', taskId, 'phase-control', 'access-wiring-repair'), acceptedRuntimeDirectory].includes(resolved.phaseDirectory)) {
                const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
                const parent = await readForgeDeliveryPhaseState(phaseFiles.stateFile, catalog);
                const backendRuntimeRepair = resolved.phaseDirectory === acceptedRuntimeDirectory
                  && isForgeBackendRuntimeRepairContinuation(originalPrepareRequest.promptText,
                    { workflowId: parent.workflowId, phaseId: parent.currentPhaseId, phaseIndex: parent.currentPhaseIndex, actionCeiling: 'read-only' });
                const runtimeRepair = backendRuntimeRepair || isForgeAccessWiringRuntimeRepairContinuation(originalPrepareRequest.promptText,
                  { workflowId: parent.workflowId, phaseId: parent.currentPhaseId,
                    phaseIndex: parent.currentPhaseIndex, actionCeiling: 'read-only' });
                if (runtimeRepair && parent.currentPhaseIndex === 7 && parent.activeAttempt !== null) {
                  if (workspaceWriteAuthorized !== true) throw new ManagerError('PHASE_USER_SCOPE_REQUIRED', '运行权限修复需要原对话的工作区写入授权。', 409);
                  const executionFile = path.join(taskspacesRoot, '.broker', 'executions', `${taskId}.json`);
                  const stored = await readPrivatePhaseJson(executionFile);
                  const preparationExecution = stored?.current;
                  if (preparationExecution === undefined) throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '当前运行准备执行记录不可用。', 409);
                  validateProtectedExecutionContext(preparationExecution);
                  const backendReprobe = backendRuntimeRepair
                    ? await readForgeCrossLayerRuntimeReprobe({ stateFile: phaseFiles.stateFile, state: parent }) : null;
                  if (parent.taskId !== taskId || parent.sessionId !== prepareRequest.dshSessionId
                    || parent.sourceCommit !== observation.source.head
                    || (backendRuntimeRepair ? preparationExecution.crossLayerPreparation === true
                      || preparationExecution.phaseId !== 'cross-layer-acceptance' || preparationExecution.phaseIndex !== 7
                      || preparationExecution.generation !== parent.activeAttempt.executionGeneration
                      || preparationExecution.rpcId !== parent.activeAttempt.rpcId
                      || preparationExecution.textDigest !== parent.activeAttempt.promptDigest
                      : preparationExecution.crossLayerPreparation !== true)
                    || preparationExecution.authorityClass !== 'production-read-only' || preparationExecution.actionCeiling !== 'read-only'
                    || preparationExecution.ownedPaths.length !== 0 || preparationExecution.sourceCommit !== observation.source.head
                    || (backendRuntimeRepair ? backendReprobe?.workspaceFingerprint : preparationExecution.preparationBinding?.workspaceFingerprint) !== observation.source.fingerprint
                    || ['actorUserId', 'actorUsername', 'conversationId', 'dshSessionId'].some(key => preparationExecution[key] !== prepareRequest[key])
                    || preparationExecution.taskId !== taskId || preparationExecution.projectSlug !== projectSlug) {
                    throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '运行权限修复与当前用户、会话或源码不一致。', 409);
                  }
                  let preparationTerminal;
                  try { preparationTerminal = await preparationSessionTerminal({ projectSlug, taskId, execution: preparationExecution }); }
                  catch (error) {
                    if (error instanceof ManagerError) throw error;
                    throw new ManagerError(error?.code === 'RECOVERY_SESSION_NOT_IDLE' ? 'PHASE_CONVERSATION_STILL_RUNNING' : 'PHASE_PREPARATION_TERMINAL_UNAVAILABLE',
                      '上一轮运行检查的当前终态尚未得到确认，尚未启动权限修复。', 409);
                  }
                  const after = await readPrivatePhaseJson(executionFile);
                  if (JSON.stringify(after?.current) !== JSON.stringify(preparationExecution)) {
                    throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '采集运行检查终态期间当前执行已改变，尚未启动权限修复。', 409);
                  }
                  const parentBytes = await readPrivatePhaseBytes(phaseFiles.stateFile);
                  const correctAccepted = resolved.phaseDirectory === acceptedRuntimeDirectory;
                  const prepareRuntimeRepair = correctAccepted ? prepareForgeAccessAcceptedCorrection : prepareForgeAccessWiringRuntimeRepairContinuation;
                  await prepareRuntimeRepair({ catalogFile: phaseCatalogFile,
                    sourceStateFile: phaseFiles.stateFile, expectedSourceStateSha256: crypto.createHash('sha256').update(parentBytes).digest('hex'),
                    sourceArtifactsDirectory: phaseFiles.artifactsDirectory, sourceCommit: observation.source.head,
                    originalRequestFile: phaseFiles.originalRequestFile, outputDirectory: correctAccepted
                      ? resolved.phaseDirectory : path.join(resolved.phaseDirectory, 'runtime-access-repair'),
                    repairRequestText: originalPrepareRequest.promptText, preparationExecution, preparationTerminal,
                    ...(backendRuntimeRepair ? { repairPhaseId: 'backend' } : {}) });
                  resolved = await resolveBrowserPhase({ taskId, sessionId: prepareRequest.dshSessionId, sourceCommit: observation.source.head });
                  phaseFiles = resolved.phaseFiles;
                }
              }
              const migrationRepair = isForgeAccessWiringMigrationRepairContinuation(originalPrepareRequest.promptText,
                { workflowId: 'crud-production', phaseId: 'cross-layer-acceptance', phaseIndex: 7, actionCeiling: 'read-only' });
              const acceptedAccessCorrection = resolved.phaseDirectory === path.join(taskspacesRoot,
                '.broker', 'delivery-phases', taskId, 'phase-control', 'access-wiring-repair', 'runtime-access-repair', 'access-wiring-repair');
              if (migrationRepair && (resolved.continuation === null || resolved.phaseDirectory === path.join(taskspacesRoot,
                '.broker', 'delivery-phases', taskId, 'phase-control', 'access-wiring-repair', 'runtime-access-repair') || acceptedAccessCorrection)) {
                if (workspaceWriteAuthorized !== true) throw new ManagerError('PHASE_USER_SCOPE_REQUIRED', '权限迁移修复需要原对话的工作区写入授权。', 409);
                const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
                const parent = await readForgeDeliveryPhaseState(phaseFiles.stateFile, catalog);
                if (parent.workflowId === 'crud-production' && parent.status === 'active' && parent.currentPhaseIndex === 7
                  && parent.currentPhaseId === 'cross-layer-acceptance' && parent.activeAttempt === null) {
                  const input = { taskId, actorUserId: prepareRequest.actorUserId, actorUsername: prepareRequest.actorUsername,
                    conversationId: prepareRequest.conversationId, dshSessionId: prepareRequest.dshSessionId,
                    expectedHead: observation.source.head, expectedFingerprint: observation.source.fingerprint };
                  const evidence = await crossLayerMigrationFailureReader(path.join(taskspacesRoot, '.broker', 'project-status.sock'), input);
                  const failure = evidence?.failure;
                  if (evidence?.status !== 'failed-migration-bound' || !failure
                    || Object.entries({ taskId, actorUserId: input.actorUserId, actorUsername: input.actorUsername,
                      conversationId: input.conversationId, sessionId: input.dshSessionId,
                      baseSourceCommit: input.expectedHead, workspaceFingerprint: input.expectedFingerprint,
                      parentStateDigest: parent.stateDigest }).some(([key, value]) => failure[key] !== value)) {
                    throw new ManagerError('PHASE_CONTROLLER_RETRY_EVIDENCE_INVALID', '迁移失败凭据未绑定当前任务、身份或候选。', 409);
                  }
                  const parentBytes = await readPrivatePhaseBytes(phaseFiles.stateFile);
                  const prepareRepair = acceptedAccessCorrection ? prepareForgeAccessAcceptedCorrection : prepareForgeAccessWiringRepairContinuation;
                  await prepareRepair({ catalogFile: phaseCatalogFile,
                    sourceStateFile: phaseFiles.stateFile, expectedSourceStateSha256: crypto.createHash('sha256').update(parentBytes).digest('hex'),
                    sourceArtifactsDirectory: phaseFiles.artifactsDirectory, sourceCommit: observation.source.head,
                    originalRequestFile: phaseFiles.originalRequestFile, outputDirectory: acceptedAccessCorrection
                      ? resolved.phaseDirectory : path.join(resolved.phaseDirectory, 'access-wiring-repair'),
                    repairRequestText: originalPrepareRequest.promptText,
                    failureEvidenceFile: evidence.failureEvidenceFile, expectedFailureEvidenceSha256: evidence.expectedFailureEvidenceSha256 });
                  resolved = await resolveBrowserPhase({ taskId, sessionId: prepareRequest.dshSessionId, sourceCommit: observation.source.head });
                  phaseFiles = resolved.phaseFiles;
                }
              }
              if (explicitRepair && resolved.continuation === null) {
                const { catalog } = await loadForgeDeliveryPhaseCatalog(phaseCatalogFile);
                const parent = await readForgeDeliveryPhaseState(phaseFiles.stateFile, catalog);
                if (parent.taskId !== taskId || parent.sessionId !== prepareRequest.dshSessionId
                  || (parent.status !== 'completed' && parent.sourceCommit !== observation.source.head)) {
                  throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '关联修复与原任务、会话或源码不一致。', 409);
                }
                // A previous request may already have canonically rejected the parent before child creation.
                if (parent.status === 'blocked' && parent.currentPhaseId === 'frontend'
                  && parent.currentPhaseIndex === 5 && ['PHASE_RESPONSE_INVALID', 'PHASE_CONTROLLER_MUTATION_DENIED',
                    'PHASE_CONTROLLER_ZERO_CHANGE', 'PHASE_CONTROLLER_BUSINESS_DECISION_REQUIRED'].includes(parent.history.at(-1)?.reasonCode)) {
                  resolved = await resolveBrowserPhase({ taskId, sessionId: prepareRequest.dshSessionId,
                    sourceCommit: observation.source.head, repairRequestText: originalPrepareRequest.promptText });
                }
              }
              if (resolved.continuation === null) {
                const rejected = await inspectPreviousBrowserPhase({ taskId, prepareRequest, phaseFiles,
                  allowFrontendRepair: explicitRepair, allowPhaseComplete: explicitComplete,
                  allowRequirementsOverloadRetry: isForgeConversationTaskContinuation(originalPrepareRequest.promptText)
                    && !hasGlobalReadOnlyIntent(originalPrepareRequest.promptText),
                  observedSourceCommit: observation.source.head, observedSourceFingerprint: observation.source.fingerprint,
                  allowAccessWiringFormatRetry: explicitRepair, workspaceWriteAuthorized });
                if (rejected?.browserPhase !== undefined) browserPhase = rejected.browserPhase;
                if (rejected?.workflowCompleted === true) {
                  completedApiContract = rejected.completedApiContract;
                  break phaseRouting;
                }
                if (rejected === true) resolved = await resolveBrowserPhase({ taskId,
                  sessionId: prepareRequest.dshSessionId, sourceCommit: observation.source.head,
                  repairRequestText: originalPrepareRequest.promptText });
              } else {
                const previousPhase = await inspectPreviousBrowserPhase({ taskId, prepareRequest, phaseFiles: resolved.phaseFiles,
                  allowFrontendUserAbortRetry: explicitRepair, allowPhaseComplete: explicitComplete,
                  observedSourceCommit: observation.source.head, observedSourceFingerprint: observation.source.fingerprint,
                  allowAccessWiringFormatRetry: explicitRepair, workspaceWriteAuthorized });
                if (previousPhase?.browserPhase !== undefined) browserPhase = previousPhase.browserPhase;
                if (previousPhase?.workflowCompleted === true) {
                  completedApiContract = previousPhase.completedApiContract;
                  break phaseRouting;
                }
              }
              phaseDirectory = resolved.phaseDirectory;
              phaseFiles = resolved.phaseFiles;
              repairContinuation = resolved.continuation;
              try {
                browserPhase ??= await prepareForgeDeliveryBrowserPhase({
                  ...phaseFiles, sourceCommit: observation.source.head, taskId,
                  sessionId: prepareRequest.dshSessionId, rpcId: prepareRequest.rpcId,
                });
              } catch (error) {
                const preparationPhase = { workflowId: 'crud-production', phaseId: 'cross-layer-acceptance', phaseIndex: 7, actionCeiling: 'read-only' };
                if (error?.code !== 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED' || workspaceWriteAuthorized !== true
                  || !(isForgeAccessWiringPhaseCompletion(originalPrepareRequest.promptText, preparationPhase)
                    || isForgeCrossLayerPreparationContinuation(originalPrepareRequest.promptText, preparationPhase)
                    || isForgeCrossLayerRuntimeReprobeContinuation(originalPrepareRequest.promptText, preparationPhase))) throw error;
                browserPhase = await prepareForgeCrossLayerPreparation({ ...phaseFiles,
                  sourceCommit: observation.source.head, workspaceFingerprint: observation.source.fingerprint, taskId,
                  sessionId: prepareRequest.dshSessionId, rpcId: prepareRequest.rpcId, promptText: originalPrepareRequest.promptText });
              }
              if (browserPhase.runtimeWorkspaceFingerprint !== undefined
                && browserPhase.runtimeWorkspaceFingerprint !== observation.source.fingerprint) {
                throw new ManagerError('PHASE_CONTROLLER_RUNTIME_EVIDENCE_MISMATCH', '跨层运行证据未绑定当前源码。', 409);
              }
              const envelope = JSON.parse(promptBody);
              envelope.payload.content = [{ type: 'text', text: browserPhase.promptText }];
              forwardBody = JSON.stringify(envelope);
              prepareRequest = {
                ...originalPrepareRequest,
                ...classifyPinnedDshPromptBody(Buffer.from(forwardBody, 'utf8'), 'session.prompt'),
              };
              if (prepareRequest.classification !== 'claimable-text') {
                throw new ManagerError('PHASE_BROWSER_PROMPT_INVALID', '阶段合同无法作为当前对话输入。', 409);
              }
            }
            let trustedPolicyInput;
            let previousCompletion;
            if (executionAuthorityClient !== null && prepareRequest.classification === 'claimable-text') {
              let sourceTransition;
              if (!explicitReadOnly && (conversationIntent ? conversationIntent.resolved.continuation : isForgeConversationTaskContinuation(originalPrepareRequest.promptText))) {
                const candidate = await sourceTransitionReader({ projectRoot, taskId });
                if (candidate !== null && candidate !== undefined) {
                  let validated;
                  try {
                    validated = validateSourceTransition(candidate);
                  } catch {
                    throw new ManagerError('SOURCE_TRANSITION_INVALID', '源码迁移事实无效。', 503);
                  }
                  if (validated.to.head === observation?.source?.head
                    && validated.to.fingerprint === observation?.source?.fingerprint) {
                    sourceTransition = validated;
                  }
                }
              }
              const runtimeCapabilities = await taskRuntimeCapabilities(taskId);
              assertPrepareConnected();
              const authority = await executionAuthorityClient({
                projectSlug,
                taskId,
                actorUserId: prepareRequest.actorUserId,
                actorUsername: prepareRequest.actorUsername,
                conversationId: prepareRequest.conversationId,
                dshSessionId: prepareRequest.dshSessionId,
                route: prepareRequest.route,
                rpcId: prepareRequest.rpcId,
                promptText: prepareRequest.promptText,
                promptTextDigest: prepareRequest.textDigest,
                ...(workspaceWriteAuthorized === undefined ? {} : { workspaceWriteAuthorized }),
                ...Object.fromEntries(Object.entries(runtimeCapabilities)
                  .filter(([, supported]) => supported === true)),
                ...(authorizedActionCeiling === undefined ? {} : { authorizedActionCeiling }),
                ...(conversationIntent === undefined ? {} : { conversationIntent }),
                source: {
                  head: observation?.source?.head,
                  fingerprint: observation?.source?.fingerprint,
                },
                ...(sourceTransition === undefined ? {} : { sourceTransition }),
                ...(completedApiContract === undefined ? {} : { completedApiContract }),
                ...(browserPhase === undefined ? {} : { controllerPhase: {
                  originalPromptText: originalPrepareRequest.promptText,
                  originalPromptTextDigest: originalPrepareRequest.textDigest,
                  phaseAuthority: browserPhase.phaseAuthority,
                  ...(browserPhase.acceptedApiContract === undefined ? {} : { acceptedApiContract: browserPhase.acceptedApiContract }),
                } }),
              });
              if (authority?.trustedPolicyInput !== null && authority?.trustedPolicyInput !== undefined) {
                trustedPolicyInput = authority.trustedPolicyInput;
              }
              if (authority?.previousCompletion !== undefined) {
                const completion = authority.previousCompletion;
                if (authority.authority !== null || authority.trustedPolicyInput !== null
                  || completion?.projectSlug !== projectSlug || completion?.taskId !== taskId
                  || completion?.actorUserId !== prepareRequest.actorUserId
                  || completion?.actorUsername !== prepareRequest.actorUsername
                  || completion?.conversationId !== prepareRequest.conversationId
                  || completion?.dshSessionId !== prepareRequest.dshSessionId
                  || completion?.sourceCommit !== observation?.source?.head
                  || completion?.workspaceFingerprint !== observation?.source?.fingerprint) {
                  throw new ManagerError('ACCEPTANCE_PREVIOUS_COMPLETION_INVALID', '历史代码验收事实未绑定当前受控源码与请求身份。', 503);
                }
                previousCompletion = completion;
              }
            }
            assertPrepareConnected();
            const prepared = await prepareProtectedExecutionContext({
              projectRoot,
              projectSlug,
              taskMetadata,
              request: prepareRequest,
              trustedReleaseCancellation: ['pause', 'cancel'].includes(conversationIntent?.decision?.kind),
              trustedPolicyInput,
              previousCompletion,
              ...(browserPhase === undefined ? {} : { trustedPhase: {
                sourceCommit: observation.source.head, caseFamily: browserPhase.caseFamily,
                phaseAuthority: browserPhase.phaseAuthority,
                ...(browserPhase.crossLayerPreparation === true ? { crossLayerPreparation: true, preparationBinding: browserPhase.preparationBinding } : {}),
              } }),
            });
            assertPrepareConnected();
            if (repairContinuation !== null && repairContinuation !== undefined
              && prepared.generation < repairContinuation.nextExecutionGenerationMinimum) {
              throw new ManagerError('PHASE_CAPTURE_IDENTITY_CONFLICT', '关联修复执行代次未接续原阶段，尚未启动模型。', 409);
            }
            if (acceptanceControlClient !== null && previousCompletion === undefined
              && prepared.authorityClass !== 'production-read-only') {
              const acceptance = await acceptanceControlClient({
                taskId,
                authorId: prepared.actorUserId,
                taskContract: prepared.contract,
                acceptanceSpec: compileProtectedAcceptanceSpec(prepared.contract),
                source: { head: observation.source.head, fingerprint: observation.source.fingerprint },
                ...(prepared.authorityClass === 'production-task-writer' ? {
                  executionAuthority: {
                    rpcId: prepared.rpcId,
                    productionAuthorityId: prepared.productionAuthorityId,
                    productionAuthorityDigest: prepared.productionAuthorityDigest,
                    controllerGrantDigest: prepared.controllerGrantDigest,
                  },
                } : {}),
              });
              assertPrepareConnected();
              if (acceptance?.acceptanceContract?.contractId !== prepared.contractId) {
                throw new ManagerError('ACCEPTANCE_CONTRACT_BINDING_INVALID', '验收合同未绑定当前执行合同。', 503);
              }
            }
            if (browserPhase !== undefined && browserPhase.crossLayerPreparation !== true) {
              const { idempotent: _idempotent, refreshed: _refreshed, ...protectedExecution } = prepared;
              const attemptDirectory = path.join(phaseDirectory, 'browser-attempts', prepared.executionId);
              const baselineFile = path.join(attemptDirectory, 'session-baseline.json');
              let baseline = await readPrivatePhaseJson(baselineFile);
              assertPrepareConnected();
              if (baseline === null) {
                baseline = await phaseSessionBaseline({ projectSlug, taskId, execution: protectedExecution });
                assertPrepareConnected();
                await writePrivatePhaseJson(baselineFile, baseline);
              }
              const beforeFile = path.join(phaseDirectory, `phase-${browserPhase.phaseIndex}-workspace-before.json`);
              if (await readPrivatePhaseJson(beforeFile) === null) {
                assertPrepareConnected();
                const before = await snapshotForgeDeliveryWorkspace({
                  workspace: path.join(taskspacesRoot, taskId, 'workspace'),
                  baseCommit: browserPhase.sourceCommit,
                  expectedHead: browserPhase.executionSourceCommit,
                });
                assertPrepareConnected();
                await writePrivatePhaseJson(beforeFile, before);
              }
              assertPrepareConnected();
              const begun = await beginForgeDeliveryBrowserPhase({ ...phaseFiles, prepared: browserPhase, execution: protectedExecution });
              const executionFile = path.join(attemptDirectory, 'execution.json');
              if (await readPrivatePhaseJson(executionFile) === null) {
                assertPrepareConnected();
                await writePrivatePhaseJson(executionFile, protectedExecution);
              }
              const beginFile = path.join(attemptDirectory, 'begin.json');
              if (await readPrivatePhaseJson(beginFile) === null) {
                assertPrepareConnected();
                await writePrivatePhaseJson(beginFile, begun);
              }
            }
            return prepared;
          });
        } catch (error) {
          if (error instanceof ProtectedExecutionError) {
            throw new ManagerError(error.code, error.message, error.status);
          }
          if (error?.code === 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED') {
            throw new ManagerError(error.code,
              '权限接线已接受，跨层验收缺少绑定当前源码的部署、API、浏览器和数据库运行证据，尚未启动下一轮。', 409);
          }
          if (/^PHASE_CONTROLLER_[A-Z_]+$/u.test(error?.code ?? '')) {
            throw new ManagerError(error.code, '当前对话与业务阶段的合同或源码状态不一致，阶段尚未启动。', 409);
          }
          throw error;
        }
        assertPrepareConnected();
        await appendAudit({
          requestId: prepareRequest.requestId,
          action: 'execution.prepare',
          taskId,
          generation: execution.generation,
          executionId: execution.executionId,
          result: execution.idempotent ? 'idempotent' : 'success',
        });
        json(response, 200, { ok: true, execution, ...(forwardBody === undefined ? {} : { forwardBody }) });
        return;
      }

      const match = /^\/v1\/taskspaces\/([a-z0-9-]+)(?:\/(start|stop))?$/.exec(parsed.pathname);
      if (match !== null && request.method === 'GET' && match[2] === undefined) {
        const metadata = await readMetadata(match[1]);
        // taskspacectl retains a failure-safe marker until create completes.
        // While that exact command is running it is not a terminal failure.
        if (provisioningTasks.has(match[1])) metadata.status = 'provisioning';
        json(response, 200, { ok: true, taskspace: publicMetadata(metadata) });
        return;
      }
      if (match !== null && request.method === 'POST' && (match[2] === 'start' || match[2] === 'stop')) {
        const taskId = validateControlValue(validateTaskId, match[1], 'INVALID_TASK_ID', 'TaskSpace 标识不合法。');
        const action = match[2];
        auditAction = action;
        auditTaskId = taskId;
        const metadata = await enqueue(taskId, async () => {
          const before = await readMetadata(taskId);
          if ((before.accessMode ?? 'token') !== 'conversation') {
            throw new ManagerError('ACCESS_MODE_MISMATCH', '该 TaskSpace 不受会话网关管理。', 409);
          }
          if (before.status === 'closed') {
            throw new ManagerError('TASKSPACE_CLOSED', '已关闭的 TaskSpace 不再接受启动或停止操作。', 409);
          }
          if (action === 'stop' && before.status === 'stopped') return before;
          await execute([action, taskId]);
          return readMetadata(taskId);
        });
        await appendAudit({ requestId, action, taskId, result: 'success' });
        json(response, 200, { ok: true, taskspace: publicMetadata(metadata) });
        return;
      }

      throw new ManagerError('NOT_FOUND', '接口不存在。', 404);
    } catch (error) {
      const known = error instanceof ManagerError
        ? error
        : error instanceof ProjectMaterialError || error instanceof PhaseWorkPackageFilesError || error instanceof RuntimeVersionError
          || (/^CONVERSATION_(?:INTENT_(?:INVALID|UNAVAILABLE|BINDING_INVALID|REQUIRED)|ACTIVITY_UNAVAILABLE)$/u.test(error?.code ?? '')
            && Number.isInteger(error.status) && error.status >= 400 && error.status < 600)
          ? new ManagerError(error.code, error.message, error.status, error.details)
          : new ManagerError('INTERNAL_ERROR', '会话管理服务发生内部错误。', 500);
      try {
        await appendAudit({
          requestId,
          action: auditAction ?? `${request.method ?? 'UNKNOWN'} ${parsed.pathname}`,
          ...(auditTaskId === undefined ? {} : { taskId: auditTaskId }),
          result: 'failed',
          code: known.code,
          ...controlFailureFields(known),
        });
      } catch (auditError) {
        console.error(`Conversation manager audit failed: ${auditError.message}`);
      }
      if (!(error instanceof ManagerError) && !(error instanceof ProjectMaterialError)
        && !(error instanceof PhaseWorkPackageFilesError)) console.error(error);
      const details = publicErrorDetails(known, requestId);
      json(response, known.status, {
        ok: false,
        code: known.code,
        message: known.message,
        ...(details === undefined ? {} : { details }),
      });
    }
  });

  return server;
}

async function startFromCommandLine() {
  const projectRoot = process.env.CONVERSATION_PROJECT_ROOT;
  const projectSlug = process.env.CONVERSATION_PROJECT_SLUG;
  const intakeRoot = process.env.CONVERSATION_PROJECT_INTAKE_ROOT;
  const materialAccessMode = process.env.CONVERSATION_PROJECT_MATERIAL_ACCESS_MODE ?? 'reviewed';
  const controlScript = process.env.CONVERSATION_TASKSPACE_CONTROL;
  const tokenFile = process.env.CONVERSATION_MANAGER_TOKEN_FILE;
  const auditPath = process.env.CONVERSATION_MANAGER_AUDIT_PATH;
  const address = process.env.CONVERSATION_MANAGER_ADDRESS ?? '0.0.0.0';
  const port = Number.parseInt(process.env.CONVERSATION_MANAGER_PORT ?? '3110', 10);
  const socketPath = process.env.CONVERSATION_MANAGER_SOCKET;
  const acceptanceControlSocket = process.env.PROTECTED_ACCEPTANCE_CONTROL_SOCKET;
  const verificationSourceSocket = process.env.VERIFICATION_SOURCE_SOCKET;
  if (!projectRoot || !projectSlug || !intakeRoot || !controlScript || !tokenFile || !auditPath
    || !acceptanceControlSocket || !verificationSourceSocket
    || (socketPath === undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
    || (socketPath !== undefined && !path.isAbsolute(socketPath))) {
    throw new Error('Conversation manager environment is incomplete.');
  }
  const managerToken = (await readFile(tokenFile, 'utf8')).trim();
  const server = createConversationManager({
    projectRoot,
    projectSlug,
    intakeRoot,
    materialAccessMode,
    controlScript,
    managerToken,
    auditPath,
    acceptanceControlClient: createProtectedAcceptanceControlClient(acceptanceControlSocket),
    executionAuthorityClient: createProtectedExecutionAuthorityClient(acceptanceControlSocket),
    roleDecisionClient: createProtectedRoleDecisionClient(acceptanceControlSocket),
    executionRenewalAuthorityClient: createExecutionRenewalAuthorityClient(
      process.env.FORGE_CONVERSATION_GATEWAY_AUTHORITY_SOCKET_FILE, managerToken,
    ),
    sourceObservationClient: createVerificationSourceObservationClient(verificationSourceSocket),
    documentLimits: {
      maxOutputBytes: process.env.HARNESS_DOCUMENT_MAX_OUTPUT_BYTES,
      maxPdfPages: process.env.HARNESS_DOCUMENT_MAX_PDF_PAGES,
      maxSourceBytes: process.env.HARNESS_DOCUMENT_MAX_SOURCE_BYTES,
      maxSpreadsheetColumns: process.env.HARNESS_DOCUMENT_MAX_SPREADSHEET_COLUMNS,
      maxSpreadsheetRows: process.env.HARNESS_DOCUMENT_MAX_SPREADSHEET_ROWS,
    },
    prototypeLimits: {
      maxArchiveBytes: process.env.HARNESS_PROTOTYPE_MAX_ARCHIVE_BYTES,
      maxCompressionRatio: process.env.HARNESS_PROTOTYPE_MAX_COMPRESSION_RATIO,
      maxDepth: process.env.HARNESS_PROTOTYPE_MAX_DEPTH,
      maxEntries: process.env.HARNESS_PROTOTYPE_MAX_ENTRIES,
      maxFileBytes: process.env.HARNESS_PROTOTYPE_MAX_FILE_BYTES,
      maxHtmlAnalysisBytes: process.env.HARNESS_PROTOTYPE_MAX_HTML_ANALYSIS_BYTES,
      maxPages: process.env.HARNESS_PROTOTYPE_MAX_PAGES,
      maxPathBytes: process.env.HARNESS_PROTOTYPE_MAX_PATH_BYTES,
      maxSummaryBytes: process.env.HARNESS_PROTOTYPE_MAX_SUMMARY_BYTES,
      maxUncompressedBytes: process.env.HARNESS_PROTOTYPE_MAX_UNCOMPRESSED_BYTES,
    },
  });
  server.on('error', (error) => {
    console.error(`Conversation manager failed: ${error.message}`);
    process.exit(1);
  });
  if (socketPath !== undefined) {
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    await unlink(socketPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    server.listen(socketPath, async () => {
      await chmod(socketPath, 0o660);
      console.log(`Conversation manager listening on ${socketPath} for ${projectSlug}.`);
    });
  } else {
    server.listen(port, address, () => {
      console.log(`Conversation manager listening on ${address}:${port} for ${projectSlug}.`);
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  startFromCommandLine().catch((error) => {
    console.error(`Conversation manager configuration failed: ${error.message}`);
    process.exit(2);
  });
}
