#!/usr/bin/env node

import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const PROJECTION_SCHEMA = 'forge-harness-session-projection/v1';
const REMOTE_PATH_PATTERN = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/@\s]+@[^:\s]+:)/i;
const MAX_SUMMARY_CHARS = 800;
const MAX_SCRUB_FILE_BYTES = 512 * 1024 * 1024;
const MAX_PROXY_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_PROXY_TOTAL_REQUEST_BYTES = MAX_PROXY_REQUEST_BYTES * 128;
const MAX_PROXY_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_PROXY_OUTPUT_TOKENS = 65_536;
const MIN_PROXY_REQUESTS = 1;
const MAX_PROXY_REQUESTS = 256;
const VERIFY_RUN_STATUSES = new Set(['passed', 'failed', 'timed-out', 'failed-zero-tests']);
const VERIFY_PROFILES = new Set([
  'governance', 'backend-red-test', 'frontend-red-test',
  'backend-module-compile', 'backend-module-test', 'backend-test-class',
  'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build', 'frontend-h5-build',
  'changed-safe', 'full-regression',
]);
const FIXED_PROXY_CREDENTIAL_PLACEHOLDER = 'forge-eval-proxy-placeholder';
const FIXED_PROXY_UPSTREAMS = Object.freeze({
  'deepseek-official': new URL('https://api.deepseek.com/chat/completions'),
  kimi: new URL('https://api.moonshot.cn/v1/chat/completions'),
});
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function usage() {
  return [
    'Usage:',
    '  node analyze-forge-harness-session.mjs project --input FILE --output FILE',
    '  node analyze-forge-harness-session.mjs project --input-root DIR --output FILE',
    '  node analyze-forge-harness-session.mjs evaluate-behavior --suite FILE --case-id ID --projection FILE --model-stdout FILE --model-supervision FILE --static-gate FILE --workspace-patch FILE --model-timeout-seconds N --output FILE',
    '  node analyze-forge-harness-session.mjs scrub-secret --root DIR --secret-file FILE --report FILE',
    '  node analyze-forge-harness-session.mjs credential-proxy --secret-file FILE --max-requests 1..128 --expected-provider PROVIDER --expected-model MODEL --max-output-tokens N --max-request-bytes N --max-total-request-bytes N',
    '  node analyze-forge-harness-session.mjs prove-dsh-config --input FILE --stderr FILE --container-inspect FILE --expected-image-id ID --expected-patch-source FILE --expected-provider PROVIDER --expected-model MODEL --expected-placeholder-env-name NAME --expected-placeholder-env-value VALUE --expected-base-url URL --expected-api-key-env NAME --output FILE',
    '  node analyze-forge-harness-session.mjs prove-agent-presets --input FILE --stderr FILE --container-inspect FILE --expected-image-id ID --output FILE',
    '  docker container inspect MODEL PROXY | node analyze-forge-harness-session.mjs project-container-boundary --model-name NAME --proxy-name NAME --model-image-id ID --proxy-image-id ID --model-network NAME --proxy-egress-network NAME --secret-file FILE --proxy-secret-source FILE --external-skills-source DIRECTORY --external-skills-destination DIRECTORY --output FILE',
    '  docker network inspect INTERNAL EGRESS | node analyze-forge-harness-session.mjs project-network-boundary --model-name NAME --proxy-name NAME --broker-name NAME --model-network NAME --proxy-egress-network NAME --run-token TOKEN --output FILE',
  ].join('\n');
}

function fail(message) {
  const error = new Error(message);
  error.code = 'FORGE_HARNESS_ANALYZER_INPUT';
  throw error;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') return { command: 'help' };
  if (!['project', 'evaluate-behavior', 'scrub-secret', 'credential-proxy', 'prove-dsh-config', 'prove-agent-presets', 'project-container-boundary', 'project-network-boundary'].includes(command)) {
    fail(`Unknown command: ${command}`);
  }
  const values = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) fail(`Unexpected positional argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`Missing value for ${flag}`);
    if (Object.hasOwn(values, flag)) fail(`Duplicate option: ${flag}`);
    values[flag] = value;
    index += 1;
  }
  return values;
}

function rejectRemotePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} is required.`);
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) fail(`${label} contains forbidden control characters.`);
  if (value.startsWith('//') || value.startsWith('\\\\')) fail(`${label} must not use a network-share path.`);
  if (REMOTE_PATH_PATTERN.test(value)) fail(`${label} must be a local filesystem path, not a URI or remote-shell target.`);
}

function checkedExistingPath(value, label, expectedKind) {
  rejectRemotePath(value, label);
  if (!existsSync(value)) fail(`${label} does not exist.`);
  const before = lstatSync(value);
  if (before.isSymbolicLink()) fail(`${label} must not be a symbolic link.`);
  const canonical = realpathSync(value);
  const info = statSync(canonical);
  if (expectedKind === 'file' && !info.isFile()) fail(`${label} must be a regular file.`);
  if (expectedKind === 'directory' && !info.isDirectory()) fail(`${label} must be a directory.`);
  return canonical;
}

function localizeDockerDesktopBindSource(value, label) {
  if (process.platform !== 'win32') return value;
  const normalized = String(value).replaceAll('\\', '/');
  const match = /^(?:\/run\/desktop\/mnt\/host|\/host_mnt)\/([A-Za-z])\/(.+)$/.exec(normalized);
  if (!match) return value;
  const segments = match[2].split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    fail(`${label} contains an unsafe Docker Desktop host path.`);
  }
  return `${match[1].toUpperCase()}:/${segments.join('/')}`;
}

function checkedOutputPath(value, label) {
  rejectRemotePath(value, label);
  const absolute = resolve(value);
  const parent = checkedExistingPath(dirname(absolute), `${label} parent`, 'directory');
  const candidate = join(parent, basename(absolute));
  if (existsSync(candidate)) fail(`${label} already exists; refusing to overwrite evidence.`);
  return candidate;
}

export function redactText(input) {
  let value = String(input ?? '');
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer [REDACTED]');
  value = value.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]');
  value = value.replace(/\b(?:api[-_]?key|authorization|cookie|credential|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, (match) => {
    const separator = match.includes('=') ? '=' : ':';
    return `${match.split(/[:=]/, 1)[0]}${separator}[REDACTED]`;
  });
  return value;
}

function safeScalar(value, maxChars = MAX_SUMMARY_CHARS) {
  if (value === undefined || value === null) return undefined;
  const redacted = redactText(value);
  return redacted.length <= maxChars ? redacted : `${redacted.slice(0, maxChars)}…[TRUNCATED]`;
}

function safeError(error) {
  if (!error || typeof error !== 'object') return undefined;
  const output = {};
  for (const key of ['name', 'code', 'message']) {
    if (error[key] !== undefined) output[key] = safeScalar(error[key], 400);
  }
  return Object.keys(output).length === 0 ? undefined : output;
}

function contentReceipt(value) {
  if (value === undefined) return undefined;
  const text = redactText(typeof value === 'string' ? value : JSON.stringify(value));
  return {
    redactedBytes: Buffer.byteLength(text),
    redactedSha256: createHash('sha256').update(text).digest('hex'),
  };
}

function parseToolArguments(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : { value };
  } catch {
    return { value };
  }
}

function canonicalTool(name) {
  const normalized = String(name ?? '').trim().toLowerCase();
  if (normalized === 'skill' || normalized.endsWith('/skill') || normalized.includes('tool-skill')) return 'skill';
  if (['write', 'write_file', 'write-file'].includes(normalized)) return 'write';
  if (['edit', 'str_replace_editor', 'str-replace-editor', 'apply_patch'].includes(normalized)) return 'edit';
  if (['bash', 'shell', 'exec', 'exec_command'].includes(normalized)) return 'bash';
  if (normalized === 'grep') return 'grep';
  if (normalized === 'glob') return 'glob';
  if (normalized === 'read' || normalized === 'read_file' || normalized === 'read-file') return 'read';
  return undefined;
}

function firstDefined(object, keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined) return object[key];
  }
  return undefined;
}

function safeWorkspacePath(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const redacted = redactText(value).replaceAll('\\', '/');
  if (redacted === '/workspace') return '.';
  if (redacted.startsWith('/workspace/')) {
    const relativePath = redacted.slice('/workspace/'.length);
    if (relativePath.split('/').includes('..')) return '[PATH_TRAVERSAL_REDACTED]';
    return safeScalar(relativePath, 600);
  }
  if (isAbsolute(redacted) || /^[A-Za-z]:\//.test(redacted)) return '[ABSOLUTE_PATH_REDACTED]';
  if (redacted.split('/').includes('..')) return '[PATH_TRAVERSAL_REDACTED]';
  return safeScalar(redacted, 600);
}

function projectToolArguments(kind, rawArguments) {
  const args = parseToolArguments(rawArguments);
  if (kind === 'skill') {
    return { skill: safeScalar(firstDefined(args, ['skill', 'name', 'skillName', 'path']), 300) };
  }
  if (kind === 'write') {
    return {
      path: safeWorkspacePath(firstDefined(args, ['path', 'file', 'filePath', 'file_path'])),
      content: contentReceipt(firstDefined(args, ['content', 'text', 'data'])),
    };
  }
  if (kind === 'edit') {
    return {
      path: safeWorkspacePath(firstDefined(args, ['path', 'file', 'filePath', 'file_path'])),
      operation: safeScalar(firstDefined(args, ['operation', 'command']), 100),
      before: contentReceipt(firstDefined(args, ['old_string', 'oldString', 'before', 'search'])),
      after: contentReceipt(firstDefined(args, ['new_string', 'newString', 'after', 'replace', 'patch'])),
    };
  }
  if (kind === 'grep') {
    return {
      pattern: safeScalar(firstDefined(args, ['pattern', 'query', 'regex']), 600),
      path: safeWorkspacePath(firstDefined(args, ['path', 'file', 'filePath', 'file_path'])),
      include: safeScalar(firstDefined(args, ['include', 'glob']), 300),
    };
  }
  if (kind === 'glob') {
    return {
      pattern: safeScalar(firstDefined(args, ['pattern', 'glob']), 600),
      path: safeWorkspacePath(firstDefined(args, ['path', 'root']), 600),
    };
  }
  if (kind === 'read') {
    return {
      path: safeWorkspacePath(firstDefined(args, ['path', 'file', 'filePath', 'file_path'])),
      offset: Number.isSafeInteger(args.offset) ? args.offset : undefined,
      limit: Number.isSafeInteger(args.limit) ? args.limit : undefined,
    };
  }
  const command = firstDefined(args, ['command', 'cmd', 'script', 'value']);
  const argv = Array.isArray(firstDefined(args, ['argv', 'args']))
    ? firstDefined(args, ['argv', 'args']).map((item) => safeScalar(item, 500))
    : undefined;
  return {
    command: command === undefined ? undefined : safeScalar(command, 2400),
    argv,
  };
}

function toolResultCallId(data) {
  const message = data?.message && typeof data.message === 'object' ? data.message : {};
  const resultBlock = Array.isArray(message.content)
    ? message.content.find((block) => block?.type === 'tool-result')
    : undefined;
  return firstDefined(data, ['callId', 'call_id'])
    ?? firstDefined(message, ['callId', 'call_id'])
    ?? firstDefined(message.source, ['callId', 'call_id'])
    ?? firstDefined(resultBlock, ['toolCallId', 'tool_call_id']);
}

function projectedMutationCall(event) {
  if (event?.kind === 'write-call') return true;
  if (event?.kind !== 'edit-call') return false;
  const tool = String(event.tool ?? '').trim().toLowerCase();
  const operation = String(event.arguments?.operation ?? '').trim().toLowerCase();
  return !(['str_replace_editor', 'str-replace-editor'].includes(tool) && operation === 'view');
}

function projectedForgeVerifyRunReceipt(rawText) {
  const normalized = String(rawText ?? '')
    .replace(/\r\n/gu, '\n')
    .replace(/\n?\[exit code:\s*0\]\s*$/iu, '')
    .trim();
  if (!normalized.startsWith('{') || !normalized.endsWith('}')) return undefined;
  let receipt;
  try {
    receipt = JSON.parse(normalized);
  } catch {
    return undefined;
  }
  if (receipt?.receiptType !== 'forge-verify/run') return undefined;
  const status = typeof receipt.status === 'string' ? receipt.status : undefined;
  const profile = typeof receipt.request?.profile === 'string' ? receipt.request.profile : undefined;
  const admissionId = typeof receipt.request?.admissionId === 'string'
    ? receipt.request.admissionId : undefined;
  const verificationProven = typeof receipt.truth?.verificationProven === 'boolean'
    ? receipt.truth.verificationProven : undefined;
  const valid = typeof receipt.receiptId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f-]{27,55}$/u.test(receipt.receiptId)
    && VERIFY_RUN_STATUSES.has(status)
    && typeof receipt.source?.workspaceFingerprint === 'string'
    && /^[0-9a-f]{64}$/u.test(receipt.source.workspaceFingerprint)
    && VERIFY_PROFILES.has(profile)
    && typeof admissionId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f-]{27,55}$/u.test(admissionId)
    && typeof verificationProven === 'boolean'
    && (status === 'passed') === verificationProven;
  return { valid, status, profile, admissionId, verificationProven };
}

function projectedForgeVerifyAdmissionReceipt(rawText) {
  const normalized = String(rawText ?? '')
    .replace(/\r\n/gu, '\n')
    .replace(/\n?\[exit code:\s*0\]\s*$/iu, '')
    .trim();
  if (!normalized.startsWith('{') || !normalized.endsWith('}')) return undefined;
  let receipt;
  try {
    receipt = JSON.parse(normalized);
  } catch {
    return undefined;
  }
  if (receipt?.receiptType !== 'forge-verify/execution-admission') return undefined;
  const outcome = typeof receipt.outcome === 'string' ? receipt.outcome : undefined;
  const profiles = Array.isArray(receipt.profiles) ? receipt.profiles : undefined;
  const valid = receipt.schemaVersion === 1
    && ['ready', 'cache_miss', 'cache_invalid', 'executor_unavailable'].includes(outcome)
    && Array.isArray(profiles) && profiles.length > 0
    && profiles.every((profile) => VERIFY_PROFILES.has(profile))
    && new Set(profiles).size === profiles.length
    && typeof receipt.source?.dependencyManifestFingerprint === 'string'
    && /^[0-9a-f]{64}$/u.test(receipt.source.dependencyManifestFingerprint)
    && (outcome === 'ready'
      ? typeof receipt.admissionId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f-]{27,55}$/u.test(receipt.admissionId)
        && receipt.cache?.compatible === true
        && receipt.executor?.proven === true
        && typeof receipt.expiresAt === 'string'
      : receipt.admissionId === null && typeof receipt.reasonCode === 'string');
  return { valid, outcome, profiles, admissionId: receipt.admissionId, expiresAt: receipt.expiresAt };
}

function toolResultStatus(data, kind) {
  const message = data?.message && typeof data.message === 'object' ? data.message : {};
  const resultBlock = Array.isArray(message.content)
    ? message.content.find((block) => block?.type === 'tool-result')
    : undefined;
  const content = Array.isArray(resultBlock?.content)
    ? resultBlock.content
    : Array.isArray(message.content) ? message.content : [];
  const isError = Boolean(resultBlock?.isError ?? message.isError ?? data?.isError ?? data?.error);
  const output = {
    status: isError ? 'error' : 'success',
    error: safeError(data?.error ?? message?.error),
  };
  const textBlocks = content
    .filter((block) => block && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text);
  if (textBlocks.length > 0) {
    const rawText = textBlocks.join('\n');
    if (kind === 'bash') {
      const shellExitMatches = [...rawText.matchAll(/\[exit code:\s*(\d+)\]/giu)];
      const pipelineMatches = [...rawText.matchAll(/\bPIPESTATUS=(?:["']?)([0-9]+(?:\s+[0-9]+)*)(?:["']?)/gu)];
      const shellExit = shellExitMatches.at(-1);
      const pipeline = pipelineMatches.at(-1);
      if (shellExit) output.commandExitCode = Number.parseInt(shellExit[1], 10);
      if (pipeline) output.pipelineExitCodes = pipeline[1].trim().split(/\s+/u).map((value) => Number.parseInt(value, 10));
      output.commandFailed = output.status === 'error'
        || (output.commandExitCode !== undefined && output.commandExitCode !== 0)
        || output.pipelineExitCodes?.some((value) => value !== 0) === true;
      output.dependencyFailureSignature = output.commandFailed === true
        && /(?:could not (?:transfer artifact|resolve)|unknown host|network is unreachable|temporary failure in name resolution|econn(?:refused|reset)|err_pnpm_fetch|enotfound|download(?:ing)? from[^\r\n]*(?:maven|repository))/iu.test(rawText);
      const forgeVerifyRunReceipt = projectedForgeVerifyRunReceipt(rawText);
      if (forgeVerifyRunReceipt !== undefined) output.forgeVerifyRunReceipt = forgeVerifyRunReceipt;
      const forgeVerifyAdmissionReceipt = projectedForgeVerifyAdmissionReceipt(rawText);
      if (forgeVerifyAdmissionReceipt !== undefined) output.forgeVerifyAdmissionReceipt = forgeVerifyAdmissionReceipt;
    }
    output.summary = safeScalar(rawText, kind === 'bash' ? MAX_SUMMARY_CHARS : 400);
  }
  return output;
}

function providerModelFromEvent(event) {
  if (event.type === 'request/context') {
    return { provider: event.data?.provider, model: event.data?.model, source: 'request/context' };
  }
  if (event.type === 'request/header') {
    const config = event.data?.header?.config;
    return { provider: config?.provider, model: config?.model, source: 'request/header' };
  }
  if (event.type === 'assistant/message') {
    const message = event.data?.message;
    const source = message?.model ?? message?.source ?? event.data?.modelSource;
    return {
      provider: source?.provider ?? message?.provider ?? event.data?.provider,
      model: source?.model ?? message?.model ?? event.data?.model,
      source: 'assistant/message',
    };
  }
  return undefined;
}

function safeReason(reason) {
  if (typeof reason === 'string') return { kind: safeScalar(reason, 200) };
  if (!reason || typeof reason !== 'object') return undefined;
  return {
    kind: safeScalar(reason.kind ?? reason.reason, 200),
    code: safeScalar(reason.code ?? reason.error?.code, 200),
    message: safeScalar(reason.message ?? reason.error?.message, 500),
  };
}

function projectAssistantMessage(event, message, base, afterCompletionCorrection) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const textParts = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
  const toolCallCount = content.filter((block) => block?.type === 'tool-call').length;
  return {
    ...base,
    kind: 'assistant-message',
    turn: event.data?.turn ?? message?.turn,
    messageId: safeScalar(message?.id, 300),
    contentKinds: content.map((block) => safeScalar(block?.type, 100)).filter(Boolean),
    textBlockCount: textParts.length,
    toolCallCount,
    text: contentReceipt(textParts.join('')),
    afterCompletionCorrection,
  };
}

export function projectSessionEvents(events, sourceFile = 'session.jsonl') {
  const output = [];
  const calls = new Map();
  const completionCorrections = [];
  for (const event of events) {
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue;
    const base = {
      sourceFile,
      seq: Number.isInteger(event.seq) ? event.seq : undefined,
      time: Number.isFinite(event.time) ? event.time : undefined,
      eventType: event.type,
    };
    const model = providerModelFromEvent(event);
    if (model?.provider || model?.model) {
      output.push({
        ...base,
        kind: 'provider-model',
        source: model.source,
        provider: safeScalar(model.provider, 200),
        model: safeScalar(model.model, 300),
      });
    }
    if (event.type === 'step/start') {
      output.push({
        ...base,
        kind: 'step-start',
        turn: Number.isSafeInteger(event.data?.turn) ? event.data.turn : undefined,
        step: Number.isSafeInteger(event.data?.step) ? event.data.step : undefined,
      });
      continue;
    }
    if (event.type === 'tool/call') {
      const toolKind = canonicalTool(event.data?.name);
      if (!toolKind) continue;
      const callId = safeScalar(event.data?.callId, 300);
      if (callId) calls.set(callId, toolKind);
      output.push({
        ...base,
        kind: `${toolKind}-call`,
        callId,
        tool: safeScalar(event.data?.name, 200),
        arguments: projectToolArguments(toolKind, event.data?.arguments),
      });
      continue;
    }
    if (event.type === 'user/message') {
      const message = event.data?.message && typeof event.data.message === 'object'
        ? event.data.message
        : event.data;
      if (message?.source?.kind === 'plugin'
          && message.source.plugin === 'forge-completion-claim-guard') {
        const correction = {
          turn: event.data?.turn ?? message?.turn,
          correctionSeq: base.seq,
          correctionTime: base.time,
          postCorrectionAssistantMessageSeq: undefined,
          postCorrectionTurnEndSeq: undefined,
        };
        completionCorrections.push(correction);
        output.push({
          ...base,
          kind: 'completion-claim-correction',
          source: 'forge-completion-claim-guard',
          turn: correction.turn,
        });
      } else if (message?.source?.kind === 'plugin'
          && message.source.plugin === 'forge-phase-budget-guard'
          && message.source.form === 'correction') {
        output.push({
          ...base,
          kind: 'closeout-freshness-correction',
          source: 'forge-phase-budget-guard',
          turn: event.data?.turn ?? message?.turn,
        });
      }
      continue;
    }
    if (event.type === 'assistant/message') {
      const message = event.data?.message && typeof event.data.message === 'object'
        ? event.data.message
        : event.data;
      if (message?.role !== 'assistant') continue;
      const turn = event.data?.turn ?? message?.turn;
      const activeCorrection = [...completionCorrections].reverse().find((item) => (
        item.correctionSeq !== undefined
        && base.seq !== undefined
        && base.seq > item.correctionSeq
        && (item.turn === undefined || turn === undefined || item.turn === turn)
        && item.postCorrectionAssistantMessageSeq === undefined
      ));
      if (activeCorrection) activeCorrection.postCorrectionAssistantMessageSeq = base.seq;
      output.push(projectAssistantMessage(event, message, base, Boolean(activeCorrection)));
      continue;
    }
    if (event.type === 'tool/result') {
      const callId = safeScalar(toolResultCallId(event.data), 300);
      const toolKind = callId ? calls.get(callId) : undefined;
      if (!toolKind) continue;
      output.push({
        ...base,
        kind: `${toolKind}-result`,
        callId,
        ...toolResultStatus(event.data, toolKind),
      });
      continue;
    }
    if (event.type === 'turn/end') {
      const turn = event.data?.turn;
      for (const correction of completionCorrections) {
        if (correction.correctionSeq !== undefined
            && base.seq !== undefined
            && base.seq > correction.correctionSeq
            && (correction.turn === undefined || turn === undefined || correction.turn === turn)
            && correction.postCorrectionTurnEndSeq === undefined) {
          correction.postCorrectionTurnEndSeq = base.seq;
        }
      }
      output.push({ ...base, kind: 'turn-end', turn: event.data?.turn, reason: safeReason(event.data?.reason) });
      continue;
    }
    if (event.type === 'session/end' || event.type === 'agent/end') {
      output.push({ ...base, kind: 'agent-end', reason: safeReason(event.data?.reason ?? event.data) });
      continue;
    }
    if (event.type === 'agent/error' || event.type === 'agent-error') {
      output.push({ ...base, kind: 'agent-error', error: safeError(event.data?.error ?? event.error ?? event.data) });
    }
  }
  for (const correction of completionCorrections) {
    output.push({
      kind: 'completion-claim-correction-summary',
      sourceFile,
      turn: correction.turn,
      correctionSeq: correction.correctionSeq,
      correctionTime: correction.correctionTime,
      postCorrectionAssistantMessageSeq: correction.postCorrectionAssistantMessageSeq,
      postCorrectionAssistantMessageObserved: correction.postCorrectionAssistantMessageSeq !== undefined,
      postCorrectionTurnEndSeq: correction.postCorrectionTurnEndSeq,
      turnEndedAfterCorrection: correction.postCorrectionTurnEndSeq !== undefined,
      semanticConflictChecked: false,
    });
  }
  return output;
}

function projectedCommand(event) {
  const command = typeof event?.arguments?.command === 'string' ? event.arguments.command : '';
  const argv = Array.isArray(event?.arguments?.argv) ? event.arguments.argv.join(' ') : '';
  return `${command}${command && argv ? ' ' : ''}${argv}`;
}

function sameStringArrays(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function forgeVerifyRunCommandIdentity(event) {
  const command = projectedCommand(event);
  if (typeof command !== 'string' || command.length === 0 || command.length > 8192
    || /[\r\n;&|`<>]|\$\(|\$\{|\\\r?\n/u.test(command)) return undefined;
  const tokens = command.trim().split(/\s+/u);
  if (!['forge-verify', '/usr/local/bin/forge-verify'].includes(tokens.shift())
    || tokens.shift() !== 'run' || tokens.length === 0 || tokens.length % 2 !== 0) return undefined;
  let profile;
  let admissionId;
  let idempotencyKey;
  const singletonOptions = new Set();
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (!['--profile', '--module', '--test', '--idempotency-key', '--admission-id'].includes(option)
      || typeof value !== 'string' || value.length === 0) return undefined;
    if (['--profile', '--admission-id', '--idempotency-key'].includes(option)) {
      if (singletonOptions.has(option)) return undefined;
      singletonOptions.add(option);
    }
    if (option === '--profile') {
      if (profile !== undefined || !VERIFY_PROFILES.has(value)) return undefined;
      profile = value;
    } else if (option === '--admission-id') admissionId = value;
    else if (option === '--idempotency-key') idempotencyKey = value;
  }
  if (profile === undefined
    || typeof admissionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f-]{27,55}$/u.test(admissionId)
    || typeof idempotencyKey !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)) return undefined;
  return { profile, admissionId };
}

function forgeVerifyAdmissionCommandProfiles(event) {
  const command = projectedCommand(event);
  if (typeof command !== 'string' || command.length === 0 || command.length > 8192
    || /[\r\n;&|`<>]|\$\(|\$\{|\\\r?\n/u.test(command)) return undefined;
  const tokens = command.trim().split(/\s+/u);
  if (!['forge-verify', '/usr/local/bin/forge-verify'].includes(tokens.shift())
    || tokens.shift() !== 'admit' || tokens.length === 0 || tokens.length % 2 !== 0) return undefined;
  const profiles = [];
  for (let index = 0; index < tokens.length; index += 2) {
    if (tokens[index] !== '--profile' || !VERIFY_PROFILES.has(tokens[index + 1])) return undefined;
    profiles.push(tokens[index + 1]);
  }
  return new Set(profiles).size === profiles.length ? profiles : undefined;
}

function projectedSearchCommand(event) {
  if (event?.kind === 'grep-call') {
    return `grep ${event.arguments?.pattern ?? ''} ${event.arguments?.path ?? event.arguments?.include ?? ''}`.trim();
  }
  return projectedCommand(event);
}

function containsSearchInvocation(event) {
  if (event?.kind === 'grep-call') return true;
  return /(?:^|(?:&&|\|\||;)\s*)(?:[^\s;&|]*\/)?(?:rg|grep|find)\b/iu.test(projectedCommand(event));
}

function projectedResultSucceeded(result) {
  return result?.status === 'success' && result?.commandFailed !== true;
}

function completionReasonIsCompleted(event) {
  return event?.kind === 'turn-end' && event?.reason?.kind === 'completed';
}

function compileContractPattern(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 600) {
    throw new TypeError(`${label} must be a non-empty pattern of at most 600 characters.`);
  }
  try {
    return new RegExp(value, 'iu');
  } catch {
    throw new TypeError(`${label} must be a valid regular expression.`);
  }
}

function parseWorkspacePatch(workspacePatch) {
  const files = [];
  let current;
  for (const line of String(workspacePatch ?? '').split(/\r?\n/u)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (header) {
      current = {
        path: safeWorkspacePath(header[2]) ?? '[INVALID_PATH_REDACTED]',
        previousPath: safeWorkspacePath(header[1]) ?? '[INVALID_PATH_REDACTED]',
        isNew: false,
        addedLines: [],
        removedLines: [],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode ')) current.isNew = true;
    else if (line.startsWith('+') && !line.startsWith('+++')) current.addedLines.push(line.slice(1));
    else if (line.startsWith('-') && !line.startsWith('---')) current.removedLines.push(line.slice(1));
  }
  return files;
}

function isTestPath(path) {
  return /(?:^|\/)(?:src\/test|tests?|__tests__)(?:\/|$)|(?:\.spec|\.test)\.[^/]+$/iu.test(path);
}

function sourceFiles(files) {
  return files.filter((file) => !isTestPath(file.path));
}

function matchingFiles(files, pattern) {
  return files.filter((file) => pattern.test(file.path));
}

function addedText(files) {
  return files.flatMap((file) => file.addedLines).join('\n');
}

function executableAddedText(file) {
  return file.addedLines.filter((line) => {
    const value = line.trim();
    return value.length > 0 && !/^(?:\/\/|\/\*|\*|<!--|-->)/u.test(value);
  }).join('\n');
}

function extractProductionPaths(text) {
  const paths = new Set();
  const pattern = /(?:^|[\s"'(])((?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.(?:java|kt|xml|sql|vue|tsx?|jsx?|mjs|json|ya?ml))(?::\d+)?/gmu;
  for (const match of String(text ?? '').matchAll(pattern)) {
    const path = match[1].replaceAll('\\', '/');
    if (!isTestPath(path)) paths.add(path);
  }
  return [...paths].sort();
}

function permissionTokens(files) {
  const tokens = new Set();
  const pattern = /["']([a-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+){2,})["']/gu;
  for (const match of addedText(files).matchAll(pattern)) tokens.add(match[1]);
  return tokens;
}

function sharedOwnerDecision(files) {
  const production = sourceFiles(files);
  const utilityFiles = production.filter((file) => (
    /forge-starter-[^/]+\/src\/main\/(?:java|kotlin)\/.+\/(?:util|utils)\//iu.test(file.path)
  ));
  if (utilityFiles.some((file) => file.isNew)) return 'extract';
  if (utilityFiles.length > 0) return 'reuse';
  if (production.some((file) => /(?:^|\/)PageQuery\.(?:java|kt)$/u.test(file.path))) return 'keep-local';
  return undefined;
}

function evaluateMandatoryObligation(obligation, facts) {
  const evidence = { sources: ['final-workspace-patch', 'successful-projection-events'] };
  const successfulSearches = facts.successfulBashCalls.filter((event) => {
    return containsSearchInvocation(event)
      && (facts.firstMutationIndex === undefined || event.evaluationIndex < facts.firstMutationIndex);
  });
  const searchResultText = successfulSearches.map((event) => facts.resultsByCallId.get(event.callId)?.summary ?? '').join('\n');
  const production = sourceFiles(facts.files);
  const tests = facts.files.filter((file) => isTestPath(file.path));
  const allAdded = addedText(facts.files);
  const pass = (satisfied, observed = {}) => ({
    id: obligation.id,
    predicate: obligation.predicate,
    appliesTo: obligation.appliesTo,
    satisfied,
    evidence: { ...evidence, ...observed },
  });
  switch (obligation.predicate) {
    case 'owner-search': {
      const commandPattern = compileContractPattern(obligation.commandPattern, `${obligation.id}.commandPattern`);
      const resultPattern = compileContractPattern(obligation.resultPattern, `${obligation.id}.resultPattern`);
      const matching = successfulSearches.filter((event) => commandPattern.test(projectedSearchCommand(event))
        && resultPattern.test(facts.resultsByCallId.get(event.callId)?.summary ?? ''));
      return pass(matching.length > 0, { successfulMatchingSearchCount: matching.length, beforeFirstMutation: true });
    }
    case 'shared-owner-consumers-or-keep-local': {
      if (!Number.isSafeInteger(obligation.minimumConsumers) || obligation.minimumConsumers < 2) {
        throw new TypeError(`${obligation.id}.minimumConsumers must be an integer of at least 2.`);
      }
      const decision = sharedOwnerDecision(facts.files);
      const consumerPaths = extractProductionPaths(searchResultText)
        .filter((path) => !/(?:^|\/)PageQuery\.(?:java|kt)$/u.test(path));
      return pass(decision === 'keep-local' || consumerPaths.length >= obligation.minimumConsumers, {
        observedDecision: decision, distinctNonTestConsumerPaths: consumerPaths,
      });
    }
    case 'dependency-direction': {
      const decision = sharedOwnerDecision(facts.files);
      const dependencyInspection = successfulSearches.some((event) => (
        /(?:pom\.xml|build\.gradle|settings\.gradle|package\.json)/iu.test(projectedCommand(event))
      ));
      const starterFiles = production.filter((file) => /forge-starter-[^/]+\/src\/main\//iu.test(file.path));
      const reverseBusinessImport = /\b(?:import|implementation|api)\b[^\r\n]*(?:\.business\.|\.admin\.|forge-business|forge-admin-server)/iu
        .test(addedText(starterFiles));
      return pass(decision === 'keep-local' || dependencyInspection && !reverseBusinessImport, {
        observedDecision: decision, dependencyInspection, reverseBusinessImport,
      });
    }
    case 'shared-owner-decision': {
      const decision = sharedOwnerDecision(facts.files);
      return pass(['reuse', 'extract', 'keep-local'].includes(decision), { observedDecision: decision });
    }
    case 'consumer-tests': {
      if (!Number.isSafeInteger(obligation.minimumTestFiles) || obligation.minimumTestFiles < 1) {
        throw new TypeError(`${obligation.id}.minimumTestFiles must be a positive integer.`);
      }
      const matching = tests.filter((file) => /PageQuery|pagination|page/iu.test(`${file.path}\n${file.addedLines.join('\n')}`));
      return pass(matching.length >= obligation.minimumTestFiles, { matchingTestPaths: matching.map((file) => file.path) });
    }
    case 'pagination-boundary': {
      const owner = production.filter((file) => /(?:^|\/)PageQuery\.(?:java|kt)$/u.test(file.path));
      const ownerAdded = addedText(owner);
      const testAdded = addedText(tests);
      const staticPaginationSatisfied = facts.staticGateReceipt?.ok === true
        && !(facts.staticGateReceipt?.findings ?? []).some((finding) => /^BE-PAGE-/u.test(finding?.ruleId ?? ''));
      const normalizedLowerBoundInDiff = /(?:<=\s*0|Math\.max\s*\(\s*1\s*,)/u.test(ownerAdded);
      const normalizedUpperBoundInDiff = /(?:100|MAX_PAGE_SIZE)/u.test(ownerAdded)
        && /(?:Math\.min|>\s*(?:100|MAX_PAGE_SIZE)|minOf)/u.test(ownerAdded);
      const toPageCovered = /toPage\s*\(/u.test(`${ownerAdded}\n${testAdded}`);
      const boundaryMatrix = [/null/iu, /(?:^|\D)0(?:\D|$)/u, /-1/u, /100/u, /101/u, /Integer\.MAX_VALUE/u]
        .every((pattern) => pattern.test(testAdded));
      const getterBoundaryContract = boundaryMatrix
        && /getPageNum\s*\(/u.test(testAdded)
        && /getPageSize\s*\(/u.test(testAdded);
      const normalizedLowerBound = normalizedLowerBoundInDiff || staticPaginationSatisfied || getterBoundaryContract;
      const normalizedUpperBound = normalizedUpperBoundInDiff || staticPaginationSatisfied || getterBoundaryContract;
      const normalizedBoundsSource = normalizedLowerBoundInDiff && normalizedUpperBoundInDiff
        ? 'final-workspace-patch'
        : staticPaginationSatisfied ? 'static-governance-receipt' : 'final-workspace-test-contract';
      return pass(owner.length > 0 && normalizedLowerBound && normalizedUpperBound && toPageCovered && boundaryMatrix, {
        ownerPaths: owner.map((file) => file.path), normalizedLowerBound, normalizedUpperBound,
        normalizedBoundsSource,
        toPageCovered, boundaryMatrix,
      });
    }
    case 'cross-layer-component-api': {
      const layers = {
        migration: matchingFiles(facts.files, /(?:^|\/)db\/migration\/.+\.sql$/iu),
        backendController: matchingFiles(production, /(?:^|\/)controller\/.+Controller\.java$/u),
        apiAdapter: matchingFiles(production, /forge-admin-ui\/src\/api\/.+\.(?:js|ts)$/iu),
        frontendComponent: matchingFiles(production, /forge-admin-ui\/src\/(?:views|pages)\/.+\.(?:vue|tsx?|jsx?)$/iu)
          .filter((file) => /AiCrudPage/u.test(file.addedLines.join('\n'))),
      };
      return pass(Object.values(layers).every((files) => files.length > 0), {
        layers: Object.fromEntries(Object.entries(layers).map(([name, files]) => [name, files.map((file) => file.path)])),
      });
    }
    case 'permission-coherence': {
      if (!Number.isSafeInteger(obligation.minimumSharedPermissions) || obligation.minimumSharedPermissions < 1) {
        throw new TypeError(`${obligation.id}.minimumSharedPermissions must be a positive integer.`);
      }
      const backend = production.filter((file) => /(?:^|\/)controller\/.+Controller\.java$/u);
      const frontend = production.filter((file) => /forge-admin-ui\/src\/(?:api|views|pages)\//iu.test(file.path));
      const backendPermissions = permissionTokens(backend);
      const frontendPermissions = permissionTokens(frontend);
      const shared = [...backendPermissions].filter((token) => frontendPermissions.has(token)).sort();
      const annotationPresent = /@SaCheckPermission\s*\(/u.test(addedText(backend));
      return pass(annotationPresent && shared.length >= obligation.minimumSharedPermissions, {
        backendPermissions: [...backendPermissions].sort(), frontendPermissions: [...frontendPermissions].sort(),
        sharedPermissions: shared, annotationPresent,
      });
    }
    case 'tenant-boundary': {
      if (!Array.isArray(obligation.requiredColumns) || obligation.requiredColumns.length === 0
        || obligation.requiredColumns.some((column) => typeof column !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(column))
        || new Set(obligation.requiredColumns).size !== obligation.requiredColumns.length) {
        throw new TypeError(`${obligation.id}.requiredColumns must be a unique non-empty SQL identifier list.`);
      }
      const migrations = matchingFiles(facts.files, /(?:^|\/)db\/migration\/.+\.sql$/iu);
      const migrationText = addedText(migrations);
      const requiredColumns = obligation.requiredColumns.filter((column) => new RegExp(`\\b${column}\\b`, 'iu').test(migrationText));
      const entities = production.filter((file) => /(?:^|\/)(?:domain|entity)\/.+\.java$/iu.test(file.path));
      const tenantOwnerReused = /extends\s+TenantEntity\b/u.test(addedText(entities));
      const dtoFiles = production.filter((file) => /(?:DTO|Command|Query)\.java$/u.test(file.path));
      const clientTenantField = /\btenantId\b/u.test(addedText(dtoFiles));
      const constantTenantFallback = /\btenantId\b\s*(?:=|\()\s*(?:1\b|["'](?:default|fixed|tenant-?1)["'])/iu.test(allAdded);
      return pass(requiredColumns.length === obligation.requiredColumns.length && tenantOwnerReused
        && !clientTenantField && !constantTenantFallback, {
        migrationPaths: migrations.map((file) => file.path), requiredColumnsPresent: requiredColumns,
        tenantOwnerReused, clientTenantField, constantTenantFallback,
      });
    }
    case 'long-id-string-contract': {
      const backend = production.filter((file) => /\.java$/u.test(file.path));
      const frontend = production.filter((file) => /forge-admin-ui\/src\/.+\.(?:vue|tsx?|jsx?)$/iu.test(file.path));
      const backendLong = /\bLong\s+(?:id|[A-Za-z0-9]+Id)\b/u.test(addedText(backend));
      const frontendText = addedText(frontend);
      const stringEvidence = /(?:\bid\s*:\s*string\b|@param\s*\{string\}[^\r\n]*\bid\b|\bString\s*\(\s*(?:id|[^)]*\.id)\s*\)|:[A-Za-z0-9_-]*id\b)/iu.test(frontendText);
      const numberCoercion = /\bNumber\s*\(\s*(?:id|[^)]*\.id)\s*\)/u.test(frontendText);
      return pass(backendLong && stringEvidence && !numberCoercion, { backendLong, stringEvidence, numberCoercion });
    }
    case 'cross-layer-tests': {
      const backendTests = tests.filter((file) => /\.(?:java|kt)$/u.test(file.path));
      const frontendTests = tests.filter((file) => /forge-admin-ui\/.+\.(?:spec|test)\.(?:js|ts|jsx|tsx)$/iu.test(file.path));
      return pass(backendTests.length > 0 && frontendTests.length > 0, {
        backendTestPaths: backendTests.map((file) => file.path), frontendTestPaths: frontendTests.map((file) => file.path),
      });
    }
    case 'frontend-aicrudpage-api-reuse': {
      const views = production.filter((file) => /forge-admin-ui\/src\/(?:views|pages)\/.+\.(?:vue|tsx?|jsx?)$/iu.test(file.path));
      const apiAdapters = production.filter((file) => /forge-admin-ui\/src\/api\/.+\.(?:js|ts)$/iu.test(file.path));
      const correlatedViews = views.flatMap((view) => {
        const text = executableAddedText(view);
        const importedOwners = [...text.matchAll(/\bfrom\s+["']@\/api\/([A-Za-z0-9_./-]+)["']/gu)]
          .map((match) => match[1]);
        const matchingAdapters = apiAdapters.filter((adapter) => importedOwners.some((owner) => (
          adapter.path === `forge-admin-ui/src/api/${owner}.js`
          || adapter.path === `forge-admin-ui/src/api/${owner}.ts`
          || adapter.path === `forge-admin-ui/src/api/${owner}/index.js`
          || adapter.path === `forge-admin-ui/src/api/${owner}/index.ts`
        )));
        const aiCrudPageReused = /<AiCrudPage\b/u.test(text);
        const apiConfigBound = /(?:[:]?api-config|:apiConfig)\s*=/u.test(text);
        return aiCrudPageReused && apiConfigBound && matchingAdapters.length > 0
          ? [{ path: view.path, importedOwners, matchingAdapterPaths: matchingAdapters.map((file) => file.path) }]
          : [];
      });
      return pass(correlatedViews.length > 0, {
        viewPaths: views.map((file) => file.path), apiAdapterPaths: apiAdapters.map((file) => file.path),
        correlatedViews, patchEvidenceOnly: true,
      });
    }
    case 'frontend-post-safe-api-contract': {
      if (!Array.isArray(obligation.requiredOperations) || obligation.requiredOperations.length === 0
        || obligation.requiredOperations.some((operation) => typeof operation !== 'string'
          || !/^[A-Za-z][A-Za-z0-9]*$/u.test(operation))
        || new Set(obligation.requiredOperations).size !== obligation.requiredOperations.length
        || !Number.isSafeInteger(obligation.minimumIdEndpoints) || obligation.minimumIdEndpoints < 1) {
        throw new TypeError(`${obligation.id} must declare unique requiredOperations and a positive minimumIdEndpoints.`);
      }
      const apiAdapters = production.filter((file) => /forge-admin-ui\/src\/api\/.+\.(?:js|ts)$/iu.test(file.path));
      const adapterContracts = apiAdapters.map((file) => {
        const text = executableAddedText(file);
        const postEndpoints = [...text.matchAll(/(?:["'`])post@([^"'`\s]+)(?:["'`])/giu)].map((match) => match[1]);
        const observedOperations = obligation.requiredOperations.filter((operation) => new RegExp(
          `\\b${operation}\\s*:\\s*["']post@[^"'\\s]*/${operation}(?:/:id)?(?:[?#][^"'\\s]*)?["']`, 'u',
        ).test(text));
        const idEndpoints = postEndpoints.filter((endpoint) => /\/:id(?:$|[?#])/u.test(endpoint));
        const unsafeMethods = /(?:["'`])(?:put|delete)@\//iu.test(text)
          || /\brequest\.(?:put|delete)\s*\(/iu.test(text);
        return { path: file.path, postEndpoints, observedOperations, idEndpointCount: idEndpoints.length, unsafeMethods };
      });
      const matching = adapterContracts.filter((contract) => contract.observedOperations.length === obligation.requiredOperations.length
        && contract.idEndpointCount >= obligation.minimumIdEndpoints && !contract.unsafeMethods);
      return pass(matching.length > 0, {
        apiAdapterPaths: apiAdapters.map((file) => file.path), adapterContracts,
        matchingAdapterPaths: matching.map((contract) => contract.path), patchEvidenceOnly: true,
      });
    }
    case 'frontend-pagination-rows-total-contract': {
      const apiAdapters = production.filter((file) => /forge-admin-ui\/src\/api\/.+\.(?:js|ts)$/iu.test(file.path));
      const views = production.filter((file) => /forge-admin-ui\/src\/(?:views|pages)\/.+\.(?:vue|tsx?|jsx?)$/iu.test(file.path));
      const fields = ['pageNum', 'pageSize', 'rows', 'total'];
      const matchingAdapters = apiAdapters.filter((file) => fields.every((field) => new RegExp(`\\b${field}\\b`, 'u').test(executableAddedText(file))));
      const matchingViews = views.filter((file) => /<AiCrudPage\b/u.test(executableAddedText(file))
        && /(?:[:]?api-config|:apiConfig)\s*=/u.test(executableAddedText(file)));
      const frontendText = [...apiAdapters, ...views].map(executableAddedText).join('\n');
      const browserSidePagination = /\.(?:slice|splice)\s*\([^\r\n]*(?:pageNum|pageSize)/u.test(frontendText);
      return pass(matchingAdapters.length > 0 && matchingViews.length > 0 && !browserSidePagination, {
        apiAdapterPaths: apiAdapters.map((file) => file.path), viewPaths: views.map((file) => file.path),
        matchingAdapterPaths: matchingAdapters.map((file) => file.path), matchingViewPaths: matchingViews.map((file) => file.path),
        browserSidePagination, patchEvidenceOnly: true,
      });
    }
    case 'frontend-long-id-string-contract': {
      const frontend = production.filter((file) => /forge-admin-ui\/src\/.+\.(?:vue|tsx?|jsx?)$/iu.test(file.path));
      const frontendTests = tests.filter((file) => /forge-admin-ui\/.+\.(?:spec|test)\.(?:js|ts|jsx|tsx)$/iu.test(file.path));
      const frontendText = frontend.map(executableAddedText).join('\n');
      const testText = frontendTests.map(executableAddedText).join('\n');
      const stringTypeEvidence = /\b(?:id|[A-Za-z0-9]+Id)\??\s*:\s*string\b/u.test(frontendText);
      const stringConversionEvidence = /\bString\s*\(\s*(?:id|[^)]*\.id)\s*\)/u.test(frontendText);
      const unsafeCoercion = /(?:\bNumber|\bparseInt|\bparseFloat)\s*\(\s*(?:id|[^)]*\.id)\s*\)|(?:^|[^+])\+\s*(?:id|[A-Za-z0-9_$?.]+\.id)\b/mu.test(frontendText);
      const unsafeIntegerFixture = /(?:900719925474099[3-9]|9(?:0[1-9]|[1-9][0-9])\d{13,}|9223372036854775807)/u.test(testText)
        && /\bexpect\s*\(/u.test(testText);
      return pass(frontend.length > 0 && frontendTests.length > 0 && stringTypeEvidence
        && stringConversionEvidence && unsafeIntegerFixture && !unsafeCoercion, {
        frontendPaths: frontend.map((file) => file.path), testPaths: frontendTests.map((file) => file.path),
        stringTypeEvidence, stringConversionEvidence, unsafeIntegerFixture,
        unsafeCoercion, patchEvidenceOnly: true,
      });
    }
    case 'frontend-permission-state-contract': {
      if (!Array.isArray(obligation.requiredStates) || obligation.requiredStates.length === 0
        || obligation.requiredStates.some((state) => typeof state !== 'string'
          || !['loading', 'empty', 'error', 'disabled', 'permission-denied'].includes(state))
        || new Set(obligation.requiredStates).size !== obligation.requiredStates.length) {
        throw new TypeError(`${obligation.id}.requiredStates must be a unique supported frontend state list.`);
      }
      const views = production.filter((file) => /forge-admin-ui\/src\/(?:views|pages)\/.+\.(?:vue|tsx?|jsx?)$/iu.test(file.path));
      const frontendTests = tests.filter((file) => /forge-admin-ui\/.+\.(?:spec|test)\.(?:js|ts|jsx|tsx)$/iu.test(file.path));
      const viewText = views.map(executableAddedText).join('\n');
      const testText = frontendTests.map(executableAddedText).join('\n');
      const statePatterns = new Map([
        ['loading', /\bloading\b/iu],
        ['empty', /\bempty\b|<n-empty\b|空状态|空数据/iu],
        ['error', /\berror\b|错误态|请求失败/iu],
        ['disabled', /\bdisabled\b|\bbusy\b|\bpending\b/iu],
        ['permission-denied', /permissionDenied|permission-denied|\bforbidden\b|无权限|权限拒绝/iu],
      ]);
      const observedViewStates = obligation.requiredStates.filter((state) => statePatterns.get(state).test(viewText));
      const observedTestStates = obligation.requiredStates.filter((state) => statePatterns.get(state).test(testText));
      const permissions = [...permissionTokens(views)].sort();
      const permissionGuard = /v-hasPermi\b|hasPermission\s*\(|\bpermission(?:s|Denied)?\b/iu.test(viewText);
      return pass(views.length > 0 && frontendTests.length > 0 && permissions.length > 0
        && permissionGuard && /\bexpect\s*\(/u.test(testText)
        && observedViewStates.length === obligation.requiredStates.length
        && observedTestStates.length === obligation.requiredStates.length, {
        viewPaths: views.map((file) => file.path), testPaths: frontendTests.map((file) => file.path),
        permissions, permissionGuard, observedViewStates, observedTestStates, patchEvidenceOnly: true,
      });
    }
    case 'frontend-contract-tests': {
      const frontendTests = tests.filter((file) => /forge-admin-ui\/.+\.(?:spec|test)\.(?:js|ts|jsx|tsx)$/iu.test(file.path));
      const testText = frontendTests.map(executableAddedText).join('\n');
      const assertionCount = [...testText.matchAll(/\bexpect\s*\(/gu)].length;
      const contractSignals = {
        productionImport: /\bfrom\s+["'](?:@\/api\/|\.\.?\/.+(?:views|pages|api)\/)/u.test(testText),
        postIdEndpoint: /post@[^\r\n"'`]*\/:id/u.test(testText),
        pagination: /\bpageNum\b/u.test(testText) && /\bpageSize\b/u.test(testText),
        response: /\brows\b/u.test(testText) && /\btotal\b/u.test(testText),
        longId: /(?:900719925474099[3-9]|9223372036854775807)/u.test(testText),
        permission: /permission|v-hasPermi|无权限|权限拒绝/iu.test(testText),
        interactionStates: /\bloading\b/iu.test(testText) && /\bempty\b|空状态|空数据/iu.test(testText)
          && /\berror\b|错误态|请求失败/iu.test(testText)
          && /\bdisabled\b|\bbusy\b|\bpending\b/iu.test(testText),
      };
      return pass(frontendTests.length > 0 && assertionCount >= 4 && Object.values(contractSignals).every(Boolean), {
        testPaths: frontendTests.map((file) => file.path), assertionCount, contractSignals,
        patchEvidenceOnly: true, runtimeExecutionProven: false,
        note: 'A final patch can prove that focused tests were added, but cannot prove test, typecheck, lint, or production-build execution.',
      });
    }
    default:
      throw new TypeError(`Unsupported mandatory obligation predicate: ${obligation.predicate}`);
  }
}

export function evaluateBehaviorContract({
  suite,
  caseId,
  projectionEvents,
  modelStdout,
  modelSupervision,
  modelExitCode,
  staticGateReceipt,
  workspacePatch,
  modelTimeoutSeconds,
}) {
  const caseContract = suite?.cases?.find((item) => item.id === caseId);
  if (!caseContract) throw new TypeError('case contract is missing from the suite.');
  const requiredSkills = caseContract.expectedTrace?.skillCallsAll;
  if (!Array.isArray(requiredSkills) || requiredSkills.length === 0
    || requiredSkills.some((skill) => typeof skill !== 'string' || skill.length === 0)
    || new Set(requiredSkills).size !== requiredSkills.length
    || caseContract.expectedTrace?.skillCallsAny !== undefined) {
    throw new TypeError('case expectedTrace must declare a unique non-empty skillCallsAll contract.');
  }
  const mandatoryObligations = caseContract.mandatoryObligations;
  if (!Array.isArray(mandatoryObligations) || mandatoryObligations.length === 0
    || mandatoryObligations.some((obligation) => !obligation || typeof obligation !== 'object'
      || typeof obligation.id !== 'string' || obligation.id.length === 0
      || typeof obligation.predicate !== 'string' || obligation.predicate.length === 0
      || !Array.isArray(obligation.appliesTo) || obligation.appliesTo.length === 0
      || obligation.appliesTo.some((value) => !['implemented-candidate', 'bounded-blocked'].includes(value)))
    || new Set(mandatoryObligations.map((obligation) => obligation.id)).size !== mandatoryObligations.length) {
    throw new TypeError('case mandatoryObligations must declare unique structured obligations with explicit applicability.');
  }
  const verificationEvidenceContract = caseContract.verificationEvidence;
  const supportedVerificationEvidence = new Set([
    'frontend-tests', 'typescript-typecheck', 'frontend-lint', 'frontend-production-build',
  ]);
  if (verificationEvidenceContract !== undefined && (
    !Array.isArray(verificationEvidenceContract.requiredAll)
      || verificationEvidenceContract.requiredAll.length === 0
      || verificationEvidenceContract.requiredAll.some((kind) => !supportedVerificationEvidence.has(kind))
      || new Set(verificationEvidenceContract.requiredAll).size !== verificationEvidenceContract.requiredAll.length
      || verificationEvidenceContract.patchAloneProvesExecution !== false
  )) {
    throw new TypeError('case verificationEvidence must declare unique supported evidence kinds and keep patchAloneProvesExecution false.');
  }
  if (!Number.isSafeInteger(modelTimeoutSeconds) || modelTimeoutSeconds < 1) {
    throw new TypeError('modelTimeoutSeconds must be a positive integer.');
  }
  if (!Array.isArray(projectionEvents)) throw new TypeError('projectionEvents must be an array.');
  const indexed = projectionEvents.map((event, index) => ({ ...event, evaluationIndex: index }));
  const phaseStepBudget = suite.dsh?.executionBoundary?.phaseStepBudget;
  if (!Number.isSafeInteger(phaseStepBudget) || phaseStepBudget < 8 || phaseStepBudget > 400) {
    throw new TypeError('suite executionBoundary.phaseStepBudget must be an integer from 8 to 400.');
  }
  const resultsByCallId = new Map(indexed
    .filter((event) => /-result$/u.test(event.kind ?? '') && typeof event.callId === 'string')
    .map((event) => [event.callId, event]));
  const successfulSkillCalls = indexed.filter((event) => event.kind === 'skill-call'
    && projectedResultSucceeded(resultsByCallId.get(event.callId)));
  const invokedSkills = [...new Set(successfulSkillCalls
    .map((event) => event.arguments?.skill)
    .filter((skill) => typeof skill === 'string'))].sort();
  const successfulMutationCalls = indexed.filter((event) => projectedMutationCall(event)
    && projectedResultSucceeded(resultsByCallId.get(event.callId)));
  const actualSourceMutation = typeof workspacePatch === 'string' && workspacePatch.trim().length > 0;
  const patchFiles = parseWorkspacePatch(workspacePatch);
  const successfulMutationPaths = [...new Set(successfulMutationCalls
    .map((event) => event.arguments?.path)
    .filter((path) => typeof path === 'string' && !path.startsWith('[')))].sort();
  const mutationProjectionMatchesFinalDiff = patchFiles.some((file) => successfulMutationPaths.includes(file.path));
  const firstMutation = successfulMutationCalls.at(0);
  const lastMutation = successfulMutationCalls.at(-1);
  const firstTestMutation = successfulMutationCalls.find((event) => isTestPath(event.arguments?.path ?? ''));
  const firstProductionMutation = successfulMutationCalls.find((event) => !isTestPath(event.arguments?.path ?? ''));
  const tddRequired = (staticGateReceipt?.obligations ?? []).some((obligation) => obligation?.ruleId === 'QUALITY-TDD-001');
  const testFirstSatisfied = !tddRequired || firstProductionMutation === undefined
    || firstTestMutation !== undefined && firstTestMutation.evaluationIndex < firstProductionMutation.evaluationIndex;
  const firstObservedTime = indexed.filter((event) => Number.isFinite(event.time))
    .reduce((minimum, event) => Math.min(minimum, event.time), Number.POSITIVE_INFINITY);
  const stepStarts = indexed.filter((event) => event.kind === 'step-start' && Number.isSafeInteger(event.step));
  const stepForEvent = (target) => target === undefined ? undefined
    : stepStarts.findLast((event) => event.evaluationIndex <= target.evaluationIndex)?.step;
  const firstMutationStep = stepForEvent(firstMutation);
  const lastMutationStep = stepForEvent(lastMutation);
  const mutationBudgetBasis = stepStarts.length > 0 ? 'runtime-step' : 'legacy-wall-clock-fixture';
  const firstMutationBudgetRatio = firstMutation === undefined ? undefined
    : firstMutationStep !== undefined ? Math.max(0, firstMutationStep / phaseStepBudget)
      : !Number.isFinite(firstObservedTime) ? undefined
        : Math.max(0, (firstMutation.time - firstObservedTime) / (modelTimeoutSeconds * 1000));
  const lastMutationBudgetRatio = lastMutation === undefined ? undefined
    : lastMutationStep !== undefined ? Math.max(0, lastMutationStep / phaseStepBudget)
      : !Number.isFinite(firstObservedTime) ? undefined
        : Math.max(0, (lastMutation.time - firstObservedTime) / (modelTimeoutSeconds * 1000));
  const domainSkills = requiredSkills.filter((skill) => skill !== 'forge-evidence-truth');
  const successfulSkillIndex = new Map(successfulSkillCalls.map((event) => [event.arguments.skill, event.evaluationIndex]));
  const domainSkillsBeforeFirstMutation = firstMutation === undefined
    ? domainSkills.every((skill) => successfulSkillIndex.has(skill))
    : domainSkills.every((skill) => (successfulSkillIndex.get(skill) ?? Number.POSITIVE_INFINITY) < firstMutation.evaluationIndex);
  const requiredSkillsSatisfied = requiredSkills.every((skill) => successfulSkillIndex.has(skill));
  const bashCalls = indexed.filter((event) => event.kind === 'bash-call');
  const governancePattern = /(?:^|[;&|\s])(?:[^\s;&|]*\/)?forge-governance\s+audit\b/u;
  const controlledVerificationPattern = /(?:^|[;&|\s])(?:[^\s;&|]*\/)?forge-verify\s+(?:admit|capability|run)\b/iu;
  const verificationPattern = /(?:^|[;&|\s])(?:[^\s;&|]*\/)?(?:mvn|mvnw|pnpm|npm|yarn|gradle|gradlew)\b[^\r\n]*(?:test|verify|check|build|compile)/iu;
  const dependencyPattern = /(?:^|[;&|\s])(?:[^\s;&|]*\/)?(?:mvn|mvnw|pnpm|npm|yarn|gradle|gradlew)\b/iu;
  const networkProbePattern = /(?:^|[;&|\s])(?:[^\s;&|]*\/)?(?:curl|wget|nc|ncat|telnet)\b/iu;
  const governanceCalls = bashCalls.filter((event) => governancePattern.test(projectedCommand(event)));
  const verificationCalls = bashCalls.filter((event) => {
    const command = projectedCommand(event);
    return verificationPattern.test(command) || controlledVerificationPattern.test(command);
  });
  const verificationExecutionCalls = verificationCalls.filter((event) => (
    forgeVerifyRunCommandIdentity(event) !== undefined
      || verificationPattern.test(projectedCommand(event))
  ));
  const admissionCalls = bashCalls.filter((event) => forgeVerifyAdmissionCommandProfiles(event) !== undefined);
  const admissionObservations = admissionCalls.map((event) => {
    const commandProfiles = forgeVerifyAdmissionCommandProfiles(event);
    const receipt = resultsByCallId.get(event.callId)?.forgeVerifyAdmissionReceipt;
    return {
      evaluationIndex: event.evaluationIndex,
      profiles: commandProfiles,
      receiptValid: receipt?.valid === true
        && sameStringArrays(receipt.profiles, commandProfiles),
      outcome: receipt?.outcome,
      admissionId: receipt?.admissionId,
    };
  });
  const readyAdmissionBeforeFirstMutation = admissionObservations.findLast((item) =>
    item.receiptValid === true && item.outcome === 'ready'
      && (firstMutation === undefined || item.evaluationIndex < firstMutation.evaluationIndex));
  const blockedAdmissionBeforeFirstMutation = admissionObservations.findLast((item) =>
    item.receiptValid === true && item.outcome !== 'ready'
      && (firstMutation === undefined || item.evaluationIndex < firstMutation.evaluationIndex));
  const dependencyCalls = bashCalls.filter((event) => dependencyPattern.test(projectedCommand(event)));
  const dependencyFailures = dependencyCalls.filter((event) => {
    const result = resultsByCallId.get(event.callId);
    return result?.commandFailed === true && result?.dependencyFailureSignature === true;
  });
  const firstDependencyFailure = dependencyFailures.at(0);
  const dependencyRetryCountAfterFirstFailure = firstDependencyFailure === undefined ? 0
    : dependencyCalls.filter((event) => event.evaluationIndex > firstDependencyFailure.evaluationIndex).length;
  const afterLastMutation = (event) => lastMutation !== undefined && event.evaluationIndex > lastMutation.evaluationIndex;
  const governanceAfterLastMutationCalls = governanceCalls.filter(afterLastMutation);
  const verificationAfterLastMutationCalls = verificationExecutionCalls.filter(afterLastMutation);
  const latestGovernance = governanceAfterLastMutationCalls.at(-1);
  const latestVerification = verificationAfterLastMutationCalls.at(-1);
  const governanceAfterLastMutation = latestGovernance !== undefined;
  const governanceAfterLastMutationSucceeded = latestGovernance !== undefined
    && projectedResultSucceeded(resultsByCallId.get(latestGovernance.callId));
  const verificationAfterLastMutation = latestVerification !== undefined;
  const controlledVerificationBlocked = (event, result) => controlledVerificationPattern.test(projectedCommand(event))
    && /(?:VERIFY_CAPABILITY_UNAVAILABLE|VERIFY_CACHE_(?:MISS|INVALID)|VERIFY_EXECUTOR_[A-Z_]+|VERIFY_RUNNER_SAFETY_HOLD|"outcome"\s*:\s*"(?:cache_(?:miss|invalid)|executor_unavailable)"|controlled verification capability is unavailable|ENOENT[^\r\n]*broker-token|ECONNREFUSED[^\r\n]*taskspace-broker|verification capability token is invalid)/iu
      .test(result?.summary ?? '');
  const verificationAfterLastMutationSucceeded = latestVerification !== undefined
    && (() => {
      const result = resultsByCallId.get(latestVerification.callId);
      const commandIdentity = forgeVerifyRunCommandIdentity(latestVerification);
      if (commandIdentity === undefined) {
        return projectedResultSucceeded(result)
          && !controlledVerificationBlocked(latestVerification, result);
      }
      const receipt = result?.forgeVerifyRunReceipt;
      return projectedResultSucceeded(result)
        && receipt?.valid === true
        && receipt.profile === commandIdentity.profile
        && receipt.admissionId === commandIdentity.admissionId
        && receipt.status === 'passed'
        && receipt.verificationProven === true
        && !controlledVerificationBlocked(latestVerification, result);
    })();
  const controlledVerificationBlockerObserved = verificationCalls.some(
    (event) => controlledVerificationBlocked(event, resultsByCallId.get(event.callId)),
  );
  const finalEvidenceBoundary = Math.max(
    latestGovernance?.evaluationIndex ?? -1,
    latestVerification?.evaluationIndex ?? -1,
    lastMutation?.evaluationIndex ?? -1,
  );
  const evidenceTruthCalls = successfulSkillCalls.filter((event) => event.arguments?.skill === 'forge-evidence-truth');
  const evidenceTruthAfterFinalVerification = evidenceTruthCalls.some(
    (event) => event.evaluationIndex > finalEvidenceBoundary,
  );
  const finalAnswerPresent = typeof modelStdout === 'string' && modelStdout.trim().length > 0
    && indexed.some(completionReasonIsCompleted);
  const truthfulBlockedFinal = finalAnswerPresent
    && /(?:阻塞|受阻|未验证|尚未验证|无法验证|未完成|blocked|unverified|not\s+(?:complete|completed|verified)|unable\s+to\s+verify)/iu.test(modelStdout);
  const modelCompleted = modelSupervision?.timedOut === false
    && modelSupervision?.status === 'completed'
    && Number(modelExitCode) === 0
    && indexed.every((event) => event.kind !== 'agent-error')
    && indexed.some(completionReasonIsCompleted);
  const staticFindings = Array.isArray(staticGateReceipt?.findings) ? staticGateReceipt.findings : [];
  const verificationReceiptOnlyGovernanceBlock = staticGateReceipt?.ok === false
    && staticGateReceipt?.executionProven === true
    && staticFindings.length > 0
    && staticFindings.every((finding) => finding?.ruleId === 'BE-PAGE-002');
  const emptyDiffScopeBlockOnly = staticGateReceipt?.ok === false
    && staticFindings.length === 1 && staticFindings[0]?.ruleId === 'GOV-SCOPE-001';
  const implementedCandidate = actualSourceMutation && successfulMutationCalls.length > 0;
  const boundedBlockedOutcome = !actualSourceMutation && successfulMutationCalls.length === 0
    && truthfulBlockedFinal
    && (firstDependencyFailure !== undefined || controlledVerificationBlockerObserved)
    && emptyDiffScopeBlockOnly;
  const outcome = implementedCandidate ? 'implemented-candidate'
    : boundedBlockedOutcome ? 'bounded-blocked' : 'incomplete';
  const completionClaimCorrectionCount = indexed
    .filter((event) => event.kind === 'completion-claim-correction').length;
  const closeoutFreshnessCorrectionCount = indexed
    .filter((event) => event.kind === 'closeout-freshness-correction').length;
  const prematureFinalOnlyResults = indexed.filter((event) => /-result$/u.test(event.kind ?? '')
    && /FORGE_PHASE_BUDGET_GUARD_V1:[^\r\n]*FINAL_ONLY[^\r\n]*no further tool calls are allowed/iu
      .test(event.summary ?? ''));
  const phaseGuardPrematureCloseout = successfulMutationCalls.length === 0
    && evidenceTruthCalls.length > 0
    && prematureFinalOnlyResults.length > 0;
  const platformDefectObserved = phaseGuardPrematureCloseout
    || indexed.some((event) => event.kind === 'agent-error')
    || ['platform-error', 'runner-error', 'launch-failed', 'container-error'].includes(modelSupervision?.status)
    || modelSupervision?.platformError === true;
  const failureDomain = phaseGuardPrematureCloseout ? 'platform-protocol'
    : platformDefectObserved ? 'platform-runtime'
      : controlledVerificationBlockerObserved ? 'platform-capability'
        : !implementedCandidate ? 'model-agent'
          : 'candidate-execution';
  const candidateOutcome = implementedCandidate ? 'implemented-candidate'
    : boundedBlockedOutcome ? 'bounded-blocked' : undefined;
  const obligationResults = mandatoryObligations.map((obligation) => {
    if (!candidateOutcome || !obligation.appliesTo.includes(candidateOutcome)) {
      return {
        id: obligation.id, predicate: obligation.predicate, appliesTo: obligation.appliesTo,
        satisfied: true, notApplicable: true,
        evidence: { sources: ['final-workspace-patch', 'successful-projection-events'] },
      };
    }
    return evaluateMandatoryObligation(obligation, {
      files: patchFiles,
      successfulBashCalls: indexed.filter((event) => ['bash-call', 'grep-call'].includes(event.kind)
        && projectedResultSucceeded(resultsByCallId.get(event.callId))),
      resultsByCallId,
      firstMutationIndex: firstMutation?.evaluationIndex,
      staticGateReceipt,
    });
  });
  const applicableObligationResults = obligationResults.filter((result) => result.notApplicable !== true);
  const mandatoryObligationsSatisfied = applicableObligationResults.every((result) => result.satisfied);
  const latestVerificationResult = latestVerification === undefined ? undefined : resultsByCallId.get(latestVerification.callId);
  const latestTypedVerificationCommandIdentity = latestVerification === undefined
    ? undefined : forgeVerifyRunCommandIdentity(latestVerification);
  const latestTypedVerificationCommandProfile = latestTypedVerificationCommandIdentity?.profile;
  const latestTypedVerificationReceipt = latestVerificationResult?.forgeVerifyRunReceipt;
  const latestTypedVerificationReceiptValid = latestTypedVerificationCommandIdentity === undefined
    ? undefined
    : latestTypedVerificationReceipt?.valid === true
      && latestTypedVerificationReceipt.profile === latestTypedVerificationCommandIdentity.profile
      && latestTypedVerificationReceipt.admissionId === latestTypedVerificationCommandIdentity.admissionId;
  const successfulTypedVerificationProfiles = new Set(verificationAfterLastMutationCalls.flatMap((event) => {
    const identity = forgeVerifyRunCommandIdentity(event);
    const result = resultsByCallId.get(event.callId);
    const receipt = result?.forgeVerifyRunReceipt;
    return identity !== undefined && projectedResultSucceeded(result)
      && receipt?.valid === true && receipt.profile === identity.profile
      && receipt.admissionId === identity.admissionId && receipt.status === 'passed'
      && receipt.verificationProven === true ? [identity.profile] : [];
  }));
  const verificationEvidenceResults = (verificationEvidenceContract?.requiredAll ?? []).map((kind) => {
    const profileByKind = {
      'frontend-tests': 'frontend-admin-test',
      'typescript-typecheck': 'frontend-admin-typecheck',
      'frontend-lint': 'frontend-admin-lint',
      'frontend-production-build': 'frontend-admin-build',
    };
    const profile = profileByKind[kind];
    const satisfied = successfulTypedVerificationProfiles.has(profile);
    return {
      kind,
      satisfied,
      source: 'valid-post-mutation-forge-verify-receipt',
      profile,
      patchAloneProvesExecution: false,
    };
  });
  const verificationEvidenceSatisfied = verificationEvidenceResults.every((item) => item.satisfied);
  const verificationDependencyBlocked = controlledVerificationBlockerObserved || latestVerification !== undefined && (
    latestVerificationResult?.commandFailed === true && latestVerificationResult?.dependencyFailureSignature === true
    || controlledVerificationBlocked(latestVerification, latestVerificationResult)
  );
  const governanceEvidenceAcceptable = governanceAfterLastMutation && (
    governanceAfterLastMutationSucceeded
    || verificationDependencyBlocked && verificationReceiptOnlyGovernanceBlock
  );
  const verificationEvidenceAcceptable = verificationAfterLastMutation || verificationDependencyBlocked;
  const directNetworkProbeAttempted = bashCalls.some((event) => networkProbePattern.test(projectedCommand(event)));
  const invalidControlledCommandAttempts = bashCalls.filter((event) => {
    const command = projectedCommand(event);
    const result = resultsByCallId.get(event.callId);
    return /(?:^|[;&|\s])(?:[^\s;&|]*\/)?(?:forge-governance|forge-verify)\b/iu.test(command)
      && /FORGE_PHASE_BUDGET_GUARD_V1:[^\r\n]*(?:exact reviewed argv shape|outside the task-intent contract|requires exact Skills before capability checks)/iu
        .test(result?.summary ?? '');
  });
  const candidateExecutionContractSatisfied = modelCompleted && mutationProjectionMatchesFinalDiff
    && firstMutationBudgetRatio !== undefined && firstMutationBudgetRatio <= 0.5
    && lastMutationBudgetRatio !== undefined && lastMutationBudgetRatio <= 0.75
    && requiredSkillsSatisfied && domainSkillsBeforeFirstMutation
    && testFirstSatisfied
    && governanceEvidenceAcceptable
    && evidenceTruthAfterFinalVerification && finalAnswerPresent
    && !directNetworkProbeAttempted && dependencyRetryCountAfterFirstFailure <= 1
    && completionClaimCorrectionCount === 0;
  let classification;
  if (platformDefectObserved) classification = 'run-invalid/platform-defect';
  else if (boundedBlockedOutcome) classification = 'bounded-blocked';
  else if (!implementedCandidate) classification = 'failed';
  else if (!mandatoryObligationsSatisfied) classification = 'implemented-candidate/obligations-unmet';
  else if (!candidateExecutionContractSatisfied) classification = 'implemented-candidate/execution-contract-unmet';
  else if (!verificationEvidenceSatisfied) classification = 'implemented-candidate/verification-evidence-unmet';
  else if (verificationDependencyBlocked && verificationReceiptOnlyGovernanceBlock) classification = 'implemented-candidate/verification-blocked';
  else if (staticGateReceipt?.ok !== true) classification = 'implemented-candidate/governance-blocked';
  else if (verificationAfterLastMutationSucceeded) classification = 'implemented-candidate/locally-verified';
  else if (verificationDependencyBlocked) classification = 'implemented-candidate/verification-blocked';
  else if (verificationAfterLastMutation) classification = 'implemented-candidate/verification-failed';
  else classification = 'implemented-candidate/static-only';
  const failures = [
    [modelCompleted, 'model-did-not-complete-with-zero-exit'],
    [implementedCandidate || boundedBlockedOutcome, 'neither-implementation-nor-bounded-blocker'],
    [!actualSourceMutation || successfulMutationCalls.length > 0, 'source-change-without-successful-mutation-tool'],
    [!implementedCandidate || mutationProjectionMatchesFinalDiff, 'mutation-projection-does-not-match-final-diff'],
    [!implementedCandidate || firstMutationBudgetRatio !== undefined && firstMutationBudgetRatio <= 0.5, 'first-mutation-after-half-budget'],
    [!implementedCandidate || lastMutationBudgetRatio !== undefined && lastMutationBudgetRatio <= 0.75, 'last-mutation-consumed-closeout-budget'],
    [requiredSkillsSatisfied, 'required-skills-missing-or-failed'],
    [!implementedCandidate || domainSkillsBeforeFirstMutation, 'domain-skills-not-completed-before-mutation'],
    [!implementedCandidate || testFirstSatisfied, 'test-first-order-not-satisfied'],
    [!implementedCandidate || governanceAfterLastMutation, 'no-governance-audit-after-last-mutation'],
    [!implementedCandidate || governanceEvidenceAcceptable, 'final-governance-audit-failed'],
    [!implementedCandidate || verificationAfterLastMutation || verificationDependencyBlocked, 'no-verification-after-last-mutation'],
    [evidenceTruthAfterFinalVerification, 'evidence-truth-not-after-final-evidence'],
    [finalAnswerPresent, 'final-answer-missing'],
    [bashCalls.every((event) => !networkProbePattern.test(projectedCommand(event))), 'direct-network-probe-attempted'],
    [dependencyRetryCountAfterFirstFailure <= 1, 'dependency-retry-budget-exceeded'],
    [completionClaimCorrectionCount === 0, 'completion-claim-correction-required'],
    [implementedCandidate ? staticGateReceipt?.ok === true
      || verificationDependencyBlocked && verificationReceiptOnlyGovernanceBlock
      : !boundedBlockedOutcome || emptyDiffScopeBlockOnly, 'static-governance-blocked'],
    [!implementedCandidate || mandatoryObligationsSatisfied, 'mandatory-obligations-unsatisfied'],
    [!implementedCandidate || verificationEvidenceSatisfied, 'required-verification-evidence-missing'],
  ].filter(([passed]) => !passed).map(([, reason]) => reason);
  for (const obligation of applicableObligationResults.filter((result) => !result.satisfied)) {
    failures.push(`mandatory-obligation:${obligation.id}`);
  }
  const agentProtocolFailures = [
    [requiredSkillsSatisfied, 'required-skills-missing-or-failed'],
    [!directNetworkProbeAttempted, 'direct-network-probe-attempted'],
    [dependencyRetryCountAfterFirstFailure <= 1, 'dependency-retry-budget-exceeded'],
    [completionClaimCorrectionCount === 0, 'completion-claim-correction-required'],
    [invalidControlledCommandAttempts.length === 0, 'invalid-controlled-command-attempted'],
  ].filter(([passed]) => !passed).map(([, reason]) => reason);
  return {
    schemaVersion: 'forge-harness-behavior-contract-evaluation/v1',
    outcome,
    classification,
    observations: {
      requiredSkills: [...requiredSkills].sort(), invokedSkills, requiredSkillsSatisfied,
      domainSkillsBeforeFirstMutation, successfulMutationCallCount: successfulMutationCalls.length,
      tddRequired, testFirstSatisfied,
      successfulMutationPaths, actualSourceMutation, mutationProjectionMatchesFinalDiff,
      firstMutationBudgetRatio, lastMutationBudgetRatio,
      firstMutationStep, lastMutationStep, phaseStepBudget, mutationBudgetBasis,
      boundedExplorationThreshold: 0.5, closeoutReservationThreshold: 0.75,
      governanceAfterLastMutation, governanceAfterLastMutationSucceeded,
      verificationAfterLastMutation, verificationAfterLastMutationSucceeded,
      evidenceTruthAfterFinalVerification, finalAnswerPresent, truthfulBlockedFinal,
      directNetworkProbeAttempted,
      dependencyFailureObserved: firstDependencyFailure !== undefined,
      dependencyRetryCountAfterFirstFailure,
      boundedDependencyRetrySatisfied: dependencyRetryCountAfterFirstFailure <= 1,
      completionClaimCorrectionCount,
      closeoutFreshnessCorrectionCount,
      recoveredAfterCloseoutCorrection: closeoutFreshnessCorrectionCount > 0 && modelCompleted && evidenceTruthAfterFinalVerification,
      modelCompletedWithZeroExit: modelCompleted,
      emptyDiffScopeBlockOnly,
      platformDefectObserved,
      phaseGuardPrematureCloseout,
      failureDomain,
      workspacePatchSha256: createHash('sha256').update(String(workspacePatch ?? '')).digest('hex'),
      changedPaths: patchFiles.map((file) => file.path),
      mandatoryObligationsSatisfied,
      obligationResults,
      verificationDependencyBlocked,
      latestTypedVerificationCommandProfile,
      latestTypedVerificationReceiptValid,
      batchAdmissionReadyBeforeFirstMutation: readyAdmissionBeforeFirstMutation !== undefined,
      batchAdmissionBlockedBeforeFirstMutation: blockedAdmissionBeforeFirstMutation !== undefined,
      admissionObservations,
      verificationReceiptOnlyGovernanceBlock,
      governanceEvidenceAcceptable,
      verificationEvidenceAcceptable,
      verificationEvidenceSatisfied,
      verificationEvidenceResults,
      candidateExecutionContractSatisfied,
      invalidControlledCommandAttemptCount: invalidControlledCommandAttempts.length,
    },
    platformEvaluation: {
      status: platformDefectObserved ? 'invalid-platform-run'
        : boundedBlockedOutcome && failureDomain === 'platform-capability' ? 'safe-bounded-platform-blocker'
          : 'platform-path-completed',
      failureDomain,
      safetyBoundaryPreserved: !actualSourceMutation || successfulMutationCalls.length > 0,
    },
    agentProtocolEvaluation: {
      status: agentProtocolFailures.length === 0 ? 'protocol-compliant' : 'protocol-noncompliance-observed',
      failures: agentProtocolFailures,
      taskCapabilityAssessed: !boundedBlockedOutcome,
      qualificationDenominator: boundedBlockedOutcome ? 'excluded-platform-blocker' : 'eligible',
    },
    machineEvaluation: {
      status: failures.length === 0 ? 'trace-contract-satisfied' : 'trace-contract-failed',
      failures,
      semanticCorrectnessProven: false,
      note: 'This deterministic result covers ordered trace, final-diff structural obligations, and execution-contract evidence only; it never proves domain semantics.',
    },
  };
}

function evaluateBehaviorCommand(options) {
  const required = [
    '--suite', '--case-id', '--projection', '--model-stdout', '--model-supervision',
    '--static-gate', '--workspace-patch', '--model-timeout-seconds', '--output',
  ];
  if (required.some((name) => options[name] === undefined)
    || Object.keys(options).some((name) => name !== 'command' && !required.includes(name))) {
    fail('evaluate-behavior requires the exact documented options.');
  }
  const readJson = (name) => JSON.parse(readFileSync(checkedExistingPath(options[name], name, 'file'), 'utf8'));
  const projection = readFileSync(checkedExistingPath(options['--projection'], '--projection', 'file'), 'utf8')
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  const modelSupervision = readJson('--model-supervision');
  if (!Number.isSafeInteger(modelSupervision?.containerExitCode)
    || modelSupervision.containerExitCode < 0 || modelSupervision.containerExitCode > 255) {
    fail('--model-supervision.containerExitCode must be an integer from 0 to 255.');
  }
  const receipt = evaluateBehaviorContract({
    suite: readJson('--suite'),
    caseId: options['--case-id'],
    projectionEvents: projection,
    modelStdout: readFileSync(checkedExistingPath(options['--model-stdout'], '--model-stdout', 'file'), 'utf8'),
    modelSupervision,
    modelExitCode: modelSupervision.containerExitCode,
    staticGateReceipt: readJson('--static-gate'),
    workspacePatch: readFileSync(checkedExistingPath(options['--workspace-patch'], '--workspace-patch', 'file'), 'utf8'),
    modelTimeoutSeconds: boundedInteger(options['--model-timeout-seconds'], '--model-timeout-seconds', 1, 86_400),
  });
  writeFileSync(checkedOutputPath(options['--output'], '--output'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

function collectSessionFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      const info = lstatSync(target);
      if (info.isSymbolicLink()) fail('Input roots must not contain symbolic links.');
      if (info.isDirectory()) walk(target);
      else if (info.isFile() && entry.name === 'session.jsonl') files.push(target);
    }
  };
  walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function readEvents(file) {
  const events = [];
  const parseErrors = [];
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      parseErrors.push({ line: lineNumber, kind: 'parse-error', error: 'invalid-jsonl-record' });
    }
  }
  return { events, parseErrors };
}

async function projectCommand(options) {
  const hasInput = options['--input'] !== undefined;
  const hasRoot = options['--input-root'] !== undefined;
  if (hasInput === hasRoot) fail('project requires exactly one of --input or --input-root.');
  if (!options['--output']) fail('project requires --output.');
  const output = checkedOutputPath(options['--output'], '--output');
  let root;
  let files;
  if (hasInput) {
    const input = checkedExistingPath(options['--input'], '--input', 'file');
    root = dirname(input);
    files = [input];
  } else {
    root = checkedExistingPath(options['--input-root'], '--input-root', 'directory');
    files = collectSessionFiles(root);
    if (files.length === 0) fail('--input-root must contain at least one session.jsonl file.');
  }
  // Validate the complete input set before creating a temporary output. The
  // second read below closes the mutation window: a record that becomes
  // malformed after this preflight still aborts and removes the temporary.
  for (const file of files) {
    const { parseErrors } = await readEvents(file);
    if (parseErrors.length > 0) fail('Session JSONL contains one or more invalid records.');
  }
  const temporary = join(dirname(output), `.${basename(output)}.${process.pid}.tmp`);
  if (existsSync(temporary)) fail('Temporary projection path already exists.');
  const stream = createWriteStream(temporary, { encoding: 'utf8', flags: 'wx', mode: 0o600 });
  const write = (record) => stream.write(`${JSON.stringify(record)}\n`);
  const counts = {};
  try {
    write({ schemaVersion: PROJECTION_SCHEMA, kind: 'projection-header', sourceCount: files.length });
    for (const file of files) {
      const sourceFile = files.length === 1 && hasInput ? basename(file) : relative(root, file).split(sep).join('/');
      const { events, parseErrors } = await readEvents(file);
      if (parseErrors.length > 0) fail('Session JSONL changed or contains one or more invalid records.');
      const projected = projectSessionEvents(events, sourceFile);
      for (const record of projected) {
        counts[record.kind] = (counts[record.kind] ?? 0) + 1;
        write(record);
      }
    }
    write({ schemaVersion: PROJECTION_SCHEMA, kind: 'projection-footer', counts });
    await new Promise((resolvePromise, rejectPromise) => {
      stream.once('error', rejectPromise);
      stream.end(resolvePromise);
    });
    renameSync(temporary, output);
  } catch (error) {
    stream.destroy();
    rmSync(temporary, { force: true });
    throw error;
  }
  return { output, sourceCount: files.length, counts };
}

function bufferReplaceAll(source, needle, replacement) {
  if (needle.length === 0) return { buffer: source, count: 0 };
  const chunks = [];
  let cursor = 0;
  let count = 0;
  while (cursor < source.length) {
    const found = source.indexOf(needle, cursor);
    if (found < 0) break;
    chunks.push(source.subarray(cursor, found), replacement);
    cursor = found + needle.length;
    count += 1;
  }
  if (count === 0) return { buffer: source, count: 0 };
  chunks.push(source.subarray(cursor));
  return { buffer: Buffer.concat(chunks), count };
}

function collectRegularFiles(root, excluded) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      const info = lstatSync(target);
      if (info.isSymbolicLink()) fail('Evidence roots must not contain symbolic links.');
      if (info.isDirectory()) walk(target);
      else if (info.isFile() && target !== excluded) files.push(target);
    }
  };
  walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function scrubSecretCommand(options) {
  if (!options['--root'] || !options['--secret-file'] || !options['--report']) {
    fail('scrub-secret requires --root, --secret-file, and --report.');
  }
  const root = checkedExistingPath(options['--root'], '--root', 'directory');
  const secretFile = checkedExistingPath(options['--secret-file'], '--secret-file', 'file');
  const report = checkedOutputPath(options['--report'], '--report');
  const rootPrefix = `${root}${sep}`;
  if (secretFile === root || secretFile.startsWith(rootPrefix)) {
    fail('--secret-file must be outside --root.');
  }
  if (report !== root && !report.startsWith(rootPrefix)) fail('--report must be inside --root.');
  const rawSecret = readFileSync(secretFile);
  const trimmedSecret = Buffer.from(rawSecret.toString('utf8').replace(/[\r\n]+$/g, ''), 'utf8');
  const variants = [rawSecret, trimmedSecret]
    .filter((item) => item.length > 0)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.equals(item)) === index)
    .sort((left, right) => right.length - left.length);
  if (variants.length === 0) fail('The mounted local model key file is empty.');
  const replacement = Buffer.from('[REDACTED_LOCAL_MODEL_KEY]', 'utf8');
  const files = collectRegularFiles(root, report);
  const redacted = [];
  let replacementCount = 0;
  for (const file of files) {
    const info = statSync(file);
    if (info.size > MAX_SCRUB_FILE_BYTES) fail('An evidence artifact exceeds the bounded secret-scrub size.');
    let value = readFileSync(file);
    let fileCount = 0;
    for (const variant of variants) {
      const result = bufferReplaceAll(value, variant, replacement);
      value = result.buffer;
      fileCount += result.count;
    }
    if (fileCount > 0) {
      const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.scrub`);
      if (existsSync(temporary)) fail('A bounded secret-scrub temporary file already exists.');
      writeFileSync(temporary, value, { flag: 'wx', mode: info.mode & 0o777 });
      renameSync(temporary, file);
      redacted.push(relative(root, file).split(sep).join('/'));
      replacementCount += fileCount;
    }
  }
  const verificationFiles = collectRegularFiles(root, report);
  const retained = [];
  for (const file of verificationFiles) {
    const info = statSync(file);
    if (info.size > MAX_SCRUB_FILE_BYTES) fail('An evidence artifact exceeds the bounded secret-rescan size.');
    const value = readFileSync(file);
    if (variants.some((variant) => value.includes(variant))) retained.push(file);
  }
  if (retained.length > 0) fail(`Secret scrub verification failed for ${retained.length} artifact(s).`);
  const payload = {
    schemaVersion: 'forge-harness-secret-scrub/v1',
    filesChecked: files.length,
    filesRechecked: verificationFiles.length,
    filesRedacted: redacted,
    replacementCount,
    secretRetained: false,
  };
  writeFileSync(report, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return payload;
}

function requireExactOptions(options, required) {
  const allowed = new Set(['command', ...required]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) fail(`Unexpected option for ${options.command}: ${key}`);
  }
  for (const key of required) {
    if (!options[key]) fail(`${options.command} requires ${key}.`);
  }
}

function exactEnvironmentValue(environment, name, expectedValue) {
  if (!Array.isArray(environment) || environment.some((entry) => typeof entry !== 'string')) {
    fail('Container Config.Env must be a complete string array.');
  }
  const prefix = `${name}=`;
  const matches = environment.filter((entry) => entry.startsWith(prefix));
  if (matches.length !== 1 || matches[0].slice(prefix.length) !== expectedValue) {
    fail(`Container environment contract mismatch for ${name}.`);
  }
}

function dumpConfigBlocks(text) {
  const blocks = new Map();
  let current;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^- id: ([A-Za-z0-9][A-Za-z0-9._/-]*)$/);
    if (match) {
      current = { id: match[1], lines: [line] };
      if (blocks.has(current.id)) fail(`DSH dump-config contains duplicate plugin id: ${current.id}.`);
      blocks.set(current.id, current);
    } else if (current) current.lines.push(line);
  }
  return blocks;
}

function requireExactBlockLine(blocks, id, expectedLine) {
  const block = blocks.get(id);
  if (!block) fail(`DSH dump-config is missing plugin id: ${id}.`);
  if (block.lines.filter((line) => line === expectedLine).length !== 1) {
    fail(`DSH dump-config contract mismatch for ${id}: ${expectedLine.trim()}.`);
  }
  return block;
}

function proveDshConfigCommand(options) {
  const required = [
    '--input', '--stderr', '--container-inspect', '--expected-image-id', '--expected-patch-source',
    '--expected-provider', '--expected-model', '--expected-placeholder-env-name',
    '--expected-placeholder-env-value', '--expected-base-url', '--expected-api-key-env', '--output',
  ];
  requireExactOptions(options, required);
  if (!/^sha256:[0-9a-f]{64}$/.test(options['--expected-image-id'])) {
    fail('--expected-image-id must be an immutable Docker image ID.');
  }
  for (const key of ['--expected-provider', '--expected-model', '--expected-placeholder-env-name', '--expected-api-key-env']) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(options[key])) fail(`${key} is not a safe contract value.`);
  }
  if (options['--expected-placeholder-env-value'] !== FIXED_PROXY_CREDENTIAL_PLACEHOLDER) {
    fail('The dump-config admission placeholder must equal the fixed non-secret value.');
  }
  if (options['--expected-base-url'] !== 'http://credential-proxy:8080') {
    fail('The dump-config admission base URL must equal the fixed credential-proxy origin.');
  }
  const input = checkedExistingPath(options['--input'], '--input', 'file');
  const stderr = checkedExistingPath(options['--stderr'], '--stderr', 'file');
  const inspectFile = checkedExistingPath(options['--container-inspect'], '--container-inspect', 'file');
  const expectedPatchSource = checkedExistingPath(options['--expected-patch-source'], '--expected-patch-source', 'file');
  const output = checkedOutputPath(options['--output'], '--output');
  const inputInfo = statSync(input);
  const stderrInfo = statSync(stderr);
  if (inputInfo.size < 1 || inputInfo.size > 4 * 1024 * 1024) fail('DSH dump-config stdout exceeds its bounded evidence size.');
  if (stderrInfo.size !== 0) fail('DSH dump-config emitted stderr; admission fails closed.');
  const text = readFileSync(input, 'utf8');
  if (text.includes('\0') || !text.endsWith('\n')) fail('DSH dump-config stdout is not canonical line-oriented text.');
  const blocks = dumpConfigBlocks(text);
  const provider = options['--expected-provider'];
  const model = options['--expected-model'];
  requireExactBlockLine(blocks, 'agent-default-model', `    provider: ${provider}`);
  requireExactBlockLine(blocks, 'agent-default-model', `    model: ${model}`);
  requireExactBlockLine(blocks, 'approval', '    policy: never');
  requireExactBlockLine(blocks, 'permission', '    defaultPreset: forge-eval-workspace-write-never');
  requireExactBlockLine(blocks, 'permission', '      forge-eval-workspace-write-never:');
  requireExactBlockLine(blocks, 'permission', '        sandbox: workspace-write');
  requireExactBlockLine(blocks, 'permission', '        approval: never');
  requireExactBlockLine(
    blocks,
    'headless-runner',
    "  name: '@deepseek-ai/dsh-headless'",
  );
  requireExactBlockLine(blocks, 'headless-runner', '  disabled: true');
  requireExactBlockLine(
    blocks,
    'forge-protected-headless-runner',
    '  name: file:///usr/local/lib/forge-protected-headless-runner.mjs',
  );
  requireExactBlockLine(
    blocks,
    'forge-protected-headless-runner',
    '    task: !!js ctx.headlessStartup.task',
  );
  requireExactBlockLine(blocks, 'sandbox-policy', "    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'");
  requireExactBlockLine(blocks, 'sandbox-policy', '    workspaceRoot: !!js process.cwd()');
  requireExactBlockLine(blocks, 'web-search-deepseek', '  disabled: true');
  requireExactBlockLine(blocks, 'tool-web', '  disabled: true');
  if (provider === 'deepseek-official') {
    requireExactBlockLine(blocks, 'llm-deepseek', `    baseURL: ${options['--expected-base-url']}`);
    requireExactBlockLine(blocks, 'llm-deepseek', `    apiKeyEnv: ${options['--expected-api-key-env']}`);
  } else if (provider === 'kimi') {
    requireExactBlockLine(blocks, 'llm-pi-ai', '      kimi:');
    requireExactBlockLine(blocks, 'llm-pi-ai', `        baseURL: ${options['--expected-base-url']}`);
    requireExactBlockLine(blocks, 'llm-pi-ai', `        apiKeyEnv: ${options['--expected-api-key-env']}`);
  } else {
    fail('The dump-config admission provider is not a reviewed fixed provider.');
  }
  const systemPromptBlock = blocks.get('system-prompt');
  const systemPromptText = systemPromptBlock?.lines.join('\n') ?? '';
  const normalizedSystemPromptText = systemPromptText.replace(/\s+/gu, ' ').trim();
  if (!normalizedSystemPromptText.includes('FORGE_HARNESS_GOVERNANCE_V1')
    || !normalizedSystemPromptText.includes('Invoke forge-task-contract, forge-task-router')
    || !normalizedSystemPromptText.includes('invoke forge-evidence-truth')
    || !normalizedSystemPromptText.includes('forbids claiming completed')) {
    fail('DSH system prompt does not contain the immutable Forge governance and evidence-claim floor.');
  }

  let inspections;
  try {
    inspections = JSON.parse(readFileSync(inspectFile, 'utf8'));
  } catch {
    fail('DSH dump-config container inspection is invalid JSON.');
  }
  if (!Array.isArray(inspections) || inspections.length !== 1) {
    fail('DSH dump-config admission requires exactly one container inspection.');
  }
  const container = inspections[0];
  if (container?.Image !== options['--expected-image-id'] || container?.State?.Running !== false
    || container?.State?.ExitCode !== 0) {
    fail('DSH dump-config container image or terminal-state contract mismatch.');
  }
  if (container?.Config?.User !== '1000:1000' || container?.Config?.WorkingDir !== '/workspace'
    || JSON.stringify(container?.Config?.Entrypoint) !== JSON.stringify(['/usr/local/bin/dsh'])
    || JSON.stringify(container?.Config?.Cmd) !== JSON.stringify([
      '--profile', 'headless', '--patch', '/eval/headless-audit.patch.yml', '--dump-config',
    ])) {
    fail('DSH dump-config container command identity mismatch.');
  }
  exactEnvironmentValue(container.Config.Env, 'DSH_PERMISSION_MODE', 'workspace-write');
  exactEnvironmentValue(container.Config.Env, 'DSH_TELEMETRY_MODE', 'DISABLED');
  exactEnvironmentValue(
    container.Config.Env,
    options['--expected-placeholder-env-name'],
    options['--expected-placeholder-env-value'],
  );
  if (container.Config.Env.some((entry) => entry.startsWith('DEEPSEEK_API_KEY='))) {
    fail('DSH dump-config container must not receive the real-key environment name.');
  }
  const host = container?.HostConfig;
  if (host?.NetworkMode !== 'none' || host?.ReadonlyRootfs !== true || host?.Privileged !== false
    || !Array.isArray(host?.CapDrop) || JSON.stringify([...host.CapDrop].sort()) !== JSON.stringify(['ALL'])
    || (Array.isArray(host?.CapAdd) && host.CapAdd.length > 0)
    || !Array.isArray(host?.SecurityOpt) || JSON.stringify([...host.SecurityOpt].sort()) !== JSON.stringify(['no-new-privileges:true'])
    || Object.keys(host?.PortBindings ?? {}).length !== 0) {
    fail('DSH dump-config container isolation contract mismatch.');
  }
  const tmpfs = host?.Tmpfs;
  if (!tmpfs || typeof tmpfs !== 'object' || Array.isArray(tmpfs)
    || JSON.stringify(Object.keys(tmpfs).sort()) !== JSON.stringify(['/home/node/.dsh', '/tmp'])) {
    fail('DSH dump-config temporary-filesystem closure mismatch.');
  }
  for (const destination of ['/home/node/.dsh', '/tmp']) {
    const tokens = new Set(String(tmpfs[destination]).split(','));
    for (const token of ['rw', 'nosuid', 'nodev', 'noexec', 'uid=1000', 'gid=1000', 'mode=0700']) {
      if (!tokens.has(token)) fail(`DSH dump-config tmpfs contract mismatch: ${destination}.`);
    }
  }
  if (!Array.isArray(container?.Mounts) || container.Mounts.length !== 1) {
    fail('DSH dump-config admission must have exactly one patch bind mount.');
  }
  const patchMount = container.Mounts[0];
  if (patchMount?.Type !== 'bind' || patchMount?.Destination !== '/eval/headless-audit.patch.yml'
    || patchMount?.RW !== false
    || checkedExistingPath(patchMount?.Source, 'dump-config patch mount Source', 'file') !== expectedPatchSource) {
    fail('DSH dump-config patch mount identity mismatch.');
  }
  if (container.Mounts.some((mount) => mount?.Destination === '/var/run/docker.sock')) {
    fail('Docker socket mounts are forbidden in dump-config admission.');
  }
  const receipt = {
    schemaVersion: 'forge-harness-dsh-config-admission/v1',
    candidateImageId: options['--expected-image-id'],
    command: {
      entrypoint: '/usr/local/bin/dsh',
      argv: ['--profile', 'headless', '--patch', '/eval/headless-audit.patch.yml', '--dump-config'],
      exitCode: 0,
    },
    isolation: {
      networkMode: 'none', readOnlyRootFilesystem: true, capDrop: ['ALL'],
      noNewPrivileges: true, privileged: false, publishedPorts: false,
      patchSnapshotMountedReadOnly: true, dockerSocketMounted: false,
    },
    effectiveContract: {
      agentProvider: provider,
      agentModel: model,
      approvalPolicy: 'never',
      permissionDefaultPreset: 'forge-eval-workspace-write-never',
      permissionPresetSandbox: 'workspace-write',
      permissionPresetApproval: 'never',
      sandboxModeEnvironment: 'workspace-write',
      sandboxConfigExpressionDefault: 'workspace-write',
      sandboxWorkspaceRootExpression: 'process.cwd()',
      webSearchDisabled: true,
      webToolDisabled: true,
      llmBaseUrl: options['--expected-base-url'],
      llmApiKeyEnv: options['--expected-api-key-env'],
      forgeGovernanceSystemInstruction: 'FORGE_HARNESS_GOVERNANCE_V1',
      forgeEvidenceTruthRequiredBeforeCompletionClaim: true,
      nonSecretPlaceholderEnvironmentInjected: true,
      realCredentialAvailable: false,
      protectedHeadlessRunner: 'file:///usr/local/lib/forge-protected-headless-runner.mjs',
      disabledUpstreamHeadlessRunnerId: 'headless-runner',
      activeProtectedHeadlessRunnerId: 'forge-protected-headless-runner',
    },
    sourceEvidence: {
      stdoutSha256: createHash('sha256').update(readFileSync(input)).digest('hex'),
      stdoutBytes: inputInfo.size,
      stderrSha256: createHash('sha256').update(readFileSync(stderr)).digest('hex'),
      stderrBytes: stderrInfo.size,
      containerInspectSha256: createHash('sha256').update(readFileSync(inspectFile)).digest('hex'),
      containerInspectBytes: statSync(inspectFile).size,
    },
  };
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return receipt;
}

const AGENT_PRESET_ADMISSION_COMMAND = 'set -eu; node /usr/local/lib/forge-agent-preset-policy.mjs verify --root /opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh/config/agent-presets; cat /usr/local/share/forge-image-build/agent-preset-prompt-contract.json';

function proveAgentPresetsCommand(options) {
  const required = ['--input', '--stderr', '--container-inspect', '--expected-image-id', '--output'];
  requireExactOptions(options, required);
  if (!/^sha256:[0-9a-f]{64}$/.test(options['--expected-image-id'])) {
    fail('--expected-image-id must be an immutable Docker image ID.');
  }
  const input = checkedExistingPath(options['--input'], '--input', 'file');
  const stderr = checkedExistingPath(options['--stderr'], '--stderr', 'file');
  const inspectFile = checkedExistingPath(options['--container-inspect'], '--container-inspect', 'file');
  const output = checkedOutputPath(options['--output'], '--output');
  const inputInfo = statSync(input);
  const stderrInfo = statSync(stderr);
  if (inputInfo.size < 1 || inputInfo.size > 1024 * 1024) fail('Agent-preset admission stdout exceeds its bounded evidence size.');
  if (stderrInfo.size !== 0) fail('Agent-preset admission emitted stderr; admission fails closed.');
  const text = readFileSync(input, 'utf8');
  if (text.includes('\0') || !text.endsWith('\n')) fail('Agent-preset admission stdout is not canonical line-oriented text.');
  const lines = text.trimEnd().split(/\r?\n/u);
  if (lines.length !== 2) fail('Agent-preset admission must contain exactly two JSON receipts.');
  let policy;
  let promptContract;
  try {
    [policy, promptContract] = lines.map((line) => JSON.parse(line));
  } catch {
    fail('Agent-preset admission receipts are not valid JSON.');
  }
  const expectedPresets = ['standard'];
  const requiredStandardTools = ['bash', 'edit', 'glob', 'grep', 'read', 'skill', 'write'];
  if (policy?.ok !== true || policy?.schemaVersion !== 'forge-agent-preset-governance/v1'
    || JSON.stringify(policy.allowedPresets) !== JSON.stringify(expectedPresets)
    || policy.includeUserRoot !== false
    || !Array.isArray(policy.presets)
    || JSON.stringify(policy.presets.map((item) => item?.preset)) !== JSON.stringify(expectedPresets)) {
    fail('Agent-preset filesystem policy receipt mismatch.');
  }
  for (const item of policy.presets) {
    if (!/^[0-9a-f]{64}$/.test(item?.sha256) || !Number.isSafeInteger(item?.bytes) || item.bytes < 1) {
      fail(`Agent-preset filesystem receipt is invalid: ${item?.preset ?? 'unknown'}.`);
    }
  }
  if (promptContract?.ok !== true
    || promptContract?.schemaVersion !== 'forge-agent-preset-prompt-contract/v1'
    || promptContract.defaultPreset !== 'standard'
    || promptContract.authorablePresetRoot !== false
    || !Array.isArray(promptContract.presets)
    || JSON.stringify(promptContract.presets.map((item) => item?.id)) !== JSON.stringify(expectedPresets)) {
    fail('Agent-preset assembled-prompt receipt mismatch.');
  }
  for (const item of promptContract.presets) {
    if (item?.governanceMarkersPresent !== true || !Array.isArray(item.sectionNames)
      || !item.sectionNames.includes('deployment:persona') || new Set(item.sectionNames).size !== item.sectionNames.length
      || !Array.isArray(item.modelFacingTools) || new Set(item.modelFacingTools).size !== item.modelFacingTools.length) {
      fail(`Agent-preset assembled-prompt evidence is invalid: ${item?.id ?? 'unknown'}.`);
    }
    if (item.id === 'standard'
      && (item.skillAccessMode !== 'native-skill-tool'
        || requiredStandardTools.some((tool) => !item.modelFacingTools.includes(tool)))) {
      fail('Standard preset does not expose the complete typed task protocol tool surface.');
    }
  }

  let inspections;
  try {
    inspections = JSON.parse(readFileSync(inspectFile, 'utf8'));
  } catch {
    fail('Agent-preset admission container inspection is invalid JSON.');
  }
  if (!Array.isArray(inspections) || inspections.length !== 1) {
    fail('Agent-preset admission requires exactly one container inspection.');
  }
  const container = inspections[0];
  if (container?.Image !== options['--expected-image-id'] || container?.State?.Running !== false
    || container?.State?.ExitCode !== 0) {
    fail('Agent-preset admission container image or terminal-state contract mismatch.');
  }
  if (container?.Config?.User !== '1000:1000' || container?.Config?.WorkingDir !== '/workspace'
    || JSON.stringify(container?.Config?.Entrypoint) !== JSON.stringify(['/bin/sh'])
    || JSON.stringify(container?.Config?.Cmd) !== JSON.stringify(['-lc', AGENT_PRESET_ADMISSION_COMMAND])) {
    fail('Agent-preset admission container command identity mismatch.');
  }
  const host = container?.HostConfig;
  if (host?.NetworkMode !== 'none' || host?.ReadonlyRootfs !== true || host?.Privileged !== false
    || !Array.isArray(host?.CapDrop) || JSON.stringify([...host.CapDrop].sort()) !== JSON.stringify(['ALL'])
    || (Array.isArray(host?.CapAdd) && host.CapAdd.length > 0)
    || !Array.isArray(host?.SecurityOpt) || JSON.stringify([...host.SecurityOpt].sort()) !== JSON.stringify(['no-new-privileges:true'])
    || Object.keys(host?.PortBindings ?? {}).length !== 0
    || !Array.isArray(container?.Mounts) || container.Mounts.length !== 0) {
    fail('Agent-preset admission isolation contract mismatch.');
  }
  const receipt = {
    schemaVersion: 'forge-harness-agent-preset-admission/v1',
    candidateImageId: options['--expected-image-id'],
    command: { entrypoint: '/bin/sh', argv: ['-lc', AGENT_PRESET_ADMISSION_COMMAND], exitCode: 0 },
    isolation: {
      networkMode: 'none', readOnlyRootFilesystem: true, capDrop: ['ALL'],
      noNewPrivileges: true, privileged: false, publishedPorts: false,
      mounts: false, dockerSocketMounted: false,
    },
    effectiveContract: {
      allowedPresets: expectedPresets,
      defaultPreset: 'standard',
      userPresetRootEnabled: false,
      promptAssemblyGovernanceGuarded: true,
      standardSkillAccessMode: 'native-skill-tool',
      standardRequiredTools: requiredStandardTools,
    },
    presetPolicy: policy,
    promptContract,
    sourceEvidence: {
      stdoutSha256: createHash('sha256').update(readFileSync(input)).digest('hex'),
      stdoutBytes: inputInfo.size,
      stderrSha256: createHash('sha256').update(readFileSync(stderr)).digest('hex'),
      stderrBytes: stderrInfo.size,
      containerInspectSha256: createHash('sha256').update(readFileSync(inspectFile)).digest('hex'),
      containerInspectBytes: statSync(inspectFile).size,
    },
  };
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return receipt;
}

function projectContainerBoundaryCommand(options) {
  const required = [
    '--model-name', '--proxy-name', '--model-image-id', '--proxy-image-id',
    '--model-network', '--proxy-egress-network', '--secret-file', '--proxy-secret-source',
    '--external-skills-source', '--external-skills-destination', '--output',
  ];
  requireExactOptions(options, required);
  if (options['--model-name'] === options['--proxy-name']) fail('Model and proxy container names must be distinct.');
  const output = checkedOutputPath(options['--output'], '--output');
  const secretFile = checkedExistingPath(options['--secret-file'], '--secret-file', 'file');
  const proxySecretSource = checkedExistingPath(
    options['--proxy-secret-source'], '--proxy-secret-source', 'file',
  );
  if (secretFile !== proxySecretSource) {
    fail('--secret-file and --proxy-secret-source must resolve to the same snapshot file.');
  }
  const externalSkillsSource = checkedExistingPath(
    options['--external-skills-source'], '--external-skills-source', 'directory',
  );
  const externalSkillsDestination = options['--external-skills-destination'];
  if (typeof externalSkillsDestination !== 'string'
    || !externalSkillsDestination.startsWith('/')
    || externalSkillsDestination.includes('\0')
    || externalSkillsDestination === '/'
    || externalSkillsDestination.includes('/../')
    || externalSkillsDestination.endsWith('/..')) {
    fail('--external-skills-destination must be one absolute normalized container directory.');
  }
  const secret = readFileSync(secretFile, 'utf8').replace(/[\r\n]+$/g, '');
  if (secret.length === 0 || Buffer.byteLength(secret) > 16_384 || !/^[\x21-\x7e]+$/.test(secret)) {
    fail('The mounted local model key has an invalid file format.');
  }
  if (secret === FIXED_PROXY_CREDENTIAL_PLACEHOLDER) {
    fail('The mounted local model key must not equal the fixed proxy credential placeholder.');
  }
  const containers = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(containers)) fail('Container inspection input must be a JSON array.');
  if (containers.length !== 2) fail('Container inspection input must contain exactly the expected two containers.');
  const containerNames = containers.map((container) => String(container?.Name ?? '').replace(/^\//, ''));
  if (containerNames.some((name) => name.length === 0) || new Set(containerNames).size !== containerNames.length) {
    fail('Container inspection names must be non-empty and unique.');
  }
  const expectedNames = [options['--model-name'], options['--proxy-name']].sort();
  if (JSON.stringify([...containerNames].sort()) !== JSON.stringify(expectedNames)) {
    fail('Container inspection input must contain exactly the expected model and proxy containers.');
  }
  const modelContainer = containers[containerNames.indexOf(options['--model-name'])];
  const proxyContainer = containers[containerNames.indexOf(options['--proxy-name'])];
  if (modelContainer?.Image !== options['--model-image-id']
    || proxyContainer?.Image !== options['--proxy-image-id']) {
    fail('Container image identity boundary mismatch.');
  }
  if (modelContainer?.State?.Running !== false || proxyContainer?.State?.Running !== true) {
    fail('Runtime boundary must be inspected after proxy readiness and before model start.');
  }
  for (const container of containers) {
    if (!Array.isArray(container?.Config?.Env)
      || container.Config.Env.some((entry) => typeof entry !== 'string')) {
      fail('Container Config.Env must be a complete string array.');
    }
    if (container.Config.Env.some((entry) => {
      const separator = entry.indexOf('=');
      return entry === secret || (separator >= 0 && entry.slice(separator + 1) === secret);
    })) fail('A container environment value exactly matches the mounted local model key.');
    if (!Array.isArray(container?.Mounts)) fail('Container Mounts must be a complete array.');
    for (const [index, mount] of container.Mounts.entries()) {
      if (!mount || typeof mount !== 'object' || Array.isArray(mount)
        || typeof mount.Type !== 'string' || mount.Type.length === 0
        || typeof mount.Destination !== 'string' || mount.Destination.length === 0
        || typeof mount.RW !== 'boolean') {
        fail(`Container Mounts[${index}] is incomplete.`);
      }
      if (mount.Type === 'bind' && (typeof mount.Source !== 'string' || mount.Source.length === 0)) {
        fail(`Container bind Mounts[${index}] must include Source.`);
      }
    }
  }
  const canonicalMountSource = (mount, containerName, index) => {
    if (mount.Type === 'bind') {
      const label = `${containerName} bind Mounts[${index}].Source`;
      return checkedExistingPath(
        localizeDockerDesktopBindSource(mount.Source, label), label, undefined,
      );
    }
    // A non-bind mount cannot legitimately expose the host snapshot. Still
    // canonicalize an existing Source value so a forged/ambiguous inspection
    // cannot hide a second reference to the same snapshot behind another type.
    if (typeof mount.Source === 'string' && mount.Source.length > 0 && existsSync(mount.Source)) {
      return realpathSync(mount.Source);
    }
    return undefined;
  };
  const project = (container) => ({
    name: String(container?.Name ?? '').replace(/^\//, ''),
    imageId: container?.Image,
    running: container?.State?.Running === true,
    readOnlyRootFilesystem: container?.HostConfig?.ReadonlyRootfs === true,
    capDrop: container?.HostConfig?.CapDrop ?? [],
    securityOpt: container?.HostConfig?.SecurityOpt ?? [],
    publishedPorts: container?.HostConfig?.PortBindings ?? {},
    networks: Object.keys(container?.NetworkSettings?.Networks ?? {}).sort(),
    mounts: container.Mounts.map((mount, index) => ({
      type: mount.Type,
      destination: mount.Destination,
      readOnly: mount.RW === false,
      sourceMatchesExpectedSecretSnapshot:
        canonicalMountSource(mount, String(container.Name ?? ''), index) === proxySecretSource,
      sourceMatchesExpectedExternalSkills:
        canonicalMountSource(mount, String(container.Name ?? ''), index) === externalSkillsSource,
    })),
    environmentNames: (container?.Config?.Env ?? []).map((entry) => String(entry).split('=', 1)[0]).sort(),
    dshBundledSkillDirectory: (container?.Config?.Env ?? [])
      .find((entry) => String(entry).startsWith('DSH_BUNDLED_SKILL_DIR='))?.slice('DSH_BUNDLED_SKILL_DIR='.length) ?? null,
  });
  const model = project(modelContainer);
  const proxy = project(proxyContainer);
  if (JSON.stringify(model.networks) !== JSON.stringify([options['--model-network']])) {
    fail('Model must attach only to its internal case network.');
  }
  if (JSON.stringify(proxy.networks) !== JSON.stringify([
    options['--model-network'], options['--proxy-egress-network'],
  ].sort())) fail('Proxy must attach to the internal and egress networks.');
  const secretDestination = '/run/secrets/model-api-key';
  const secretRelatedMount = (mount) => (
    mount.destination === secretDestination || mount.sourceMatchesExpectedSecretSnapshot
  );
  if (model.mounts.some(secretRelatedMount)) {
    fail('Model must have zero mounts at the secret destination or from the expected secret snapshot source.');
  }
  const proxySecretRelatedMounts = proxy.mounts.filter(secretRelatedMount);
  const exactProxySecretMounts = proxySecretRelatedMounts.filter((mount) => (
    mount.type === 'bind'
      && mount.destination === secretDestination
      && mount.readOnly
      && mount.sourceMatchesExpectedSecretSnapshot
  ));
  if (proxySecretRelatedMounts.length !== 1 || exactProxySecretMounts.length !== 1) {
    fail('Proxy must have exactly one read-only bind from the expected secret snapshot source to the fixed secret destination, with no duplicate source or destination mount.');
  }
  const externalSkillRelatedMount = (mount) => (
    mount.destination === externalSkillsDestination || mount.sourceMatchesExpectedExternalSkills
  );
  const modelExternalSkillMounts = model.mounts.filter(externalSkillRelatedMount);
  const exactModelExternalSkillMounts = modelExternalSkillMounts.filter((mount) => (
    mount.type === 'bind'
      && mount.destination === externalSkillsDestination
      && mount.readOnly
      && mount.sourceMatchesExpectedExternalSkills
  ));
  if (modelExternalSkillMounts.length !== 1 || exactModelExternalSkillMounts.length !== 1
    || proxy.mounts.some(externalSkillRelatedMount)
    || model.dshBundledSkillDirectory !== externalSkillsDestination
    || proxy.dshBundledSkillDirectory !== null) {
    fail('Model must have exactly one reviewed read-only external Skill bind and select it through DSH_BUNDLED_SKILL_DIR; proxy access is forbidden.');
  }
  if (!model.mounts.some((mount) => mount.destination === '/workspace' && !mount.readOnly)
    || !model.mounts.some((mount) => mount.destination === '/workspace/.git' && mount.readOnly)) {
    fail('Model workspace/baseline Git mount boundary mismatch.');
  }
  if ([model, proxy].some((container) => !container.readOnlyRootFilesystem
    || !container.capDrop.includes('ALL')
    || !container.securityOpt.includes('no-new-privileges:true'))) {
    fail('Container privilege boundary mismatch.');
  }
  if ([model, proxy].some((container) => container.mounts.some((mount) => mount.destination === '/var/run/docker.sock'))) {
    fail('Docker socket mounts are forbidden.');
  }
  if (model.environmentNames.includes('DEEPSEEK_API_KEY') || proxy.environmentNames.includes('DEEPSEEK_API_KEY')) {
    fail('Real key environment name is forbidden.');
  }
  if (Object.keys(model.publishedPorts).length > 0 || Object.keys(proxy.publishedPorts).length > 0) fail('Published ports are forbidden.');
  writeFileSync(output, `${JSON.stringify({
    schemaVersion: 'forge-harness-runtime-boundary/v1', model, proxy,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function projectNetworkBoundaryCommand(options) {
  const required = [
    '--model-name', '--proxy-name', '--broker-name', '--model-network', '--proxy-egress-network', '--run-token', '--output',
  ];
  requireExactOptions(options, required);
  const output = checkedOutputPath(options['--output'], '--output');
  const networks = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(networks)) fail('Network inspection input must be a JSON array.');
  if (networks.length !== 2) fail('Network inspection input must contain exactly the expected two networks.');
  const networkNames = networks.map((network) => network?.Name);
  const networkIds = networks.map((network) => network?.Id);
  if (networkNames.some((name) => typeof name !== 'string' || name.length === 0)
    || new Set(networkNames).size !== networkNames.length) {
    fail('Network inspection names must be non-empty and unique.');
  }
  if (networkIds.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(networkIds).size !== networkIds.length) {
    fail('Network inspection IDs must be non-empty and unique.');
  }
  const expectedNetworkNames = [options['--model-network'], options['--proxy-egress-network']].sort();
  if (JSON.stringify([...networkNames].sort()) !== JSON.stringify(expectedNetworkNames)) {
    fail('Network inspection input must contain exactly the expected internal and egress networks.');
  }
  const peerNamesByNetwork = new Map();
  for (const network of networks) {
    if (!network.Containers || typeof network.Containers !== 'object' || Array.isArray(network.Containers)) {
      fail('Each network Containers field must be an object.');
    }
    const peers = Object.values(network.Containers).map((container) => container?.Name);
    if (peers.some((name) => typeof name !== 'string' || name.trim().length === 0)) {
      fail('Every network peer must have a non-empty Name.');
    }
    if (new Set(peers).size !== peers.length) fail('Network peer names must be unique within each network.');
    peerNamesByNetwork.set(network.Name, peers.sort());
  }
  const projected = networks.map((network) => ({
    name: network.Name,
    id: network.Id,
    driver: network.Driver,
    internal: network.Internal === true,
    labels: Object.fromEntries(Object.entries(network.Labels ?? {}).filter(([key]) => key === 'com.forge.hbe.run')),
    peers: peerNamesByNetwork.get(network.Name),
  }));
  const model = projected.find((network) => network.name === options['--model-network']);
  const egress = projected.find((network) => network.name === options['--proxy-egress-network']);
  if (!model?.internal || egress?.internal !== false || model.driver !== 'bridge' || egress.driver !== 'bridge') {
    fail('Network internal/egress boundary mismatch.');
  }
  if (model.labels['com.forge.hbe.run'] !== options['--run-token']
    || egress.labels['com.forge.hbe.run'] !== options['--run-token']) {
    fail('Network ownership label mismatch.');
  }
  // Docker does not publish a created-but-not-started container as a network
  // peer. The separate container projection binds the stopped model to only
  // this internal network; this pre-start snapshot must contain the ready
  // proxy and capability Broker, while only the proxy may reach egress.
  if (JSON.stringify(model.peers) !== JSON.stringify([
    options['--broker-name'], options['--proxy-name'],
  ].sort())
    || JSON.stringify(egress.peers) !== JSON.stringify([options['--proxy-name']])) {
    fail('Network peer isolation mismatch.');
  }
  writeFileSync(output, `${JSON.stringify({
    schemaVersion: 'forge-harness-network-boundary/v1',
    observationPhase: 'proxy-and-broker-ready-before-model-start',
    configuredStoppedModel: options['--model-name'],
    configuredCapabilityBroker: options['--broker-name'],
    networks: projected,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

export function credentialProxyHeaders(headers, secret) {
  const output = {};
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (name === 'authorization' || name === 'host' || HOP_BY_HOP_HEADERS.has(name)) continue;
    if (rawValue !== undefined) output[name] = rawValue;
  }
  output.authorization = `Bearer ${secret}`;
  return output;
}

export function boundedInteger(value, label, minimum, maximum) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

export function createRequestBudget(maxRequests) {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < MIN_PROXY_REQUESTS || maxRequests > MAX_PROXY_REQUESTS) {
    throw new RangeError(`maxRequests must be an integer from ${MIN_PROXY_REQUESTS} to ${MAX_PROXY_REQUESTS}.`);
  }
  let acceptedRequests = 0;
  let rejectedByLimit = 0;
  return Object.freeze({
    reserve() {
      if (acceptedRequests >= maxRequests) {
        rejectedByLimit += 1;
        return false;
      }
      acceptedRequests += 1;
      return true;
    },
    snapshot() {
      return { maxRequests, acceptedRequests, rejectedByLimit };
    },
  });
}

function requireSafePositiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

export function createCredentialProxyContract({
  expectedModel,
  maxOutputTokens,
  maxRequestBytes,
  maxTotalRequestBytes,
} = {}) {
  if (typeof expectedModel !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(expectedModel)) {
    throw new TypeError('expectedModel must be a safe non-empty model identifier.');
  }
  const contract = {
    expectedModel,
    maxOutputTokens: requireSafePositiveInteger(
      maxOutputTokens, 'maxOutputTokens', MAX_PROXY_OUTPUT_TOKENS,
    ),
    maxRequestBytes: requireSafePositiveInteger(
      maxRequestBytes, 'maxRequestBytes', MAX_PROXY_REQUEST_BYTES,
    ),
    maxTotalRequestBytes: requireSafePositiveInteger(
      maxTotalRequestBytes, 'maxTotalRequestBytes', MAX_PROXY_TOTAL_REQUEST_BYTES,
    ),
  };
  return Object.freeze(contract);
}

export function createCredentialProxyMeter(contractInput) {
  const contract = Object.isFrozen(contractInput)
    ? createCredentialProxyContract(contractInput)
    : createCredentialProxyContract({ ...contractInput });
  let forwardedRequests = 0;
  let forwardedRequestBytes = 0;
  let injectedMaxOutputTokens = 0;
  let clampedMaxOutputTokens = 0;
  let upstreamCreationFailures = 0;
  const rejected = {
    route: 0,
    contentType: 0,
    requestBytes: 0,
    totalRequestBytes: 0,
    malformedJson: 0,
    modelContract: 0,
    invalidMaxOutputTokens: 0,
    clientStream: 0,
  };
  const rejectionNames = new Set(Object.keys(rejected));

  return Object.freeze({
    contract,
    canForwardBytes(bytes) {
      requireSafePositiveInteger(bytes, 'forwarded request bytes', contract.maxRequestBytes);
      return forwardedRequestBytes + bytes <= contract.maxTotalRequestBytes;
    },
    recordForward(bytes, { injected = false, clamped = false } = {}) {
      requireSafePositiveInteger(bytes, 'forwarded request bytes', contract.maxRequestBytes);
      if (forwardedRequestBytes + bytes > contract.maxTotalRequestBytes) {
        throw new RangeError('forwarded request bytes exceed the configured cumulative limit.');
      }
      forwardedRequests += 1;
      forwardedRequestBytes += bytes;
      if (injected) injectedMaxOutputTokens += 1;
      if (clamped) clampedMaxOutputTokens += 1;
    },
    recordRejection(reason) {
      if (!rejectionNames.has(reason)) throw new TypeError('unknown credential-proxy rejection reason.');
      rejected[reason] += 1;
    },
    recordUpstreamCreationFailure() {
      upstreamCreationFailures += 1;
    },
    snapshot() {
      return {
        contract: { ...contract },
        forwardedRequests,
        forwardedRequestBytes,
        injectedMaxOutputTokens,
        clampedMaxOutputTokens,
        upstreamCreationFailures,
        rejectedRequests: { ...rejected },
        contractRejectedRequests: rejected.malformedJson + rejected.modelContract
          + rejected.invalidMaxOutputTokens,
        byteLimitRejectedRequests: rejected.requestBytes + rejected.totalRequestBytes,
      };
    },
  });
}

export function createCredentialProxyReceipt(event, budget, meter) {
  if (!['ready', 'stopped'].includes(event)) throw new TypeError('unsupported credential-proxy receipt event.');
  if (!budget || typeof budget.snapshot !== 'function') throw new TypeError('request budget snapshot is required.');
  if (!meter || typeof meter.snapshot !== 'function') throw new TypeError('credential-proxy meter snapshot is required.');
  return {
    event,
    ...(event === 'ready' ? { ready: true, port: 8080 } : {}),
    ...(event === 'stopped' ? { stopped: true } : {}),
    service: 'forge-credential-proxy',
    ...budget.snapshot(),
    ...meter.snapshot(),
  };
}

function fixedProxyError(response, statusCode, code) {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }
  response.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify({ error: { code } })}\n`);
}

export function createCredentialProxyRequestHandler(
  secret, budget, requestUpstream = https.request, activeUpstreamRequests = new Set(), meterOrContract,
  upstreamUrl = FIXED_PROXY_UPSTREAMS['deepseek-official'],
) {
  if (typeof secret !== 'string' || secret.length === 0) throw new TypeError('secret is required.');
  if (!budget || typeof budget.reserve !== 'function') throw new TypeError('request budget is required.');
  if (typeof requestUpstream !== 'function') throw new TypeError('requestUpstream must be a function.');
  if (!(upstreamUrl instanceof URL)
    || !Object.values(FIXED_PROXY_UPSTREAMS).some((value) => value.href === upstreamUrl.href)) {
    throw new TypeError('upstreamUrl must equal a reviewed fixed provider route.');
  }
  if (!activeUpstreamRequests || typeof activeUpstreamRequests.add !== 'function'
    || typeof activeUpstreamRequests.delete !== 'function') {
    throw new TypeError('activeUpstreamRequests must be a Set-like collection.');
  }
  const meter = meterOrContract?.contract && typeof meterOrContract.recordForward === 'function'
    ? meterOrContract
    : createCredentialProxyMeter(meterOrContract ?? {
      expectedModel: 'deepseek-chat',
      maxOutputTokens: 8_192,
      maxRequestBytes: MAX_PROXY_REQUEST_BYTES,
      maxTotalRequestBytes: MAX_PROXY_TOTAL_REQUEST_BYTES,
    });

  const rejectAndDrain = (request, response, statusCode, code, reason) => {
    meter.recordRejection(reason);
    fixedProxyError(response, statusCode, code);
    if (typeof request.resume === 'function') request.resume();
  };

  return (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://credential-proxy.invalid');
    if (request.method === 'GET' && requestUrl.pathname === '/__forge_health' && requestUrl.search === '') {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }
    if (request.method !== 'POST' || requestUrl.pathname !== '/chat/completions' || requestUrl.search !== '') {
      rejectAndDrain(request, response, 404, 'FORGE_PROXY_ROUTE_REJECTED', 'route');
      return;
    }
    const contentType = String(request.headers['content-type'] ?? '').toLowerCase();
    const contentEncoding = String(request.headers['content-encoding'] ?? 'identity').toLowerCase();
    if (!contentType.startsWith('application/json') || contentEncoding !== 'identity') {
      rejectAndDrain(request, response, 415, 'FORGE_PROXY_CONTENT_TYPE_REJECTED', 'contentType');
      return;
    }
    const rawDeclaredLength = request.headers['content-length'];
    let declaredLength;
    if (rawDeclaredLength !== undefined) {
      const serializedLength = Array.isArray(rawDeclaredLength) ? '' : String(rawDeclaredLength);
      if (!/^(?:0|[1-9][0-9]*)$/.test(serializedLength)
        || !Number.isSafeInteger(Number(serializedLength))) {
        rejectAndDrain(request, response, 400, 'FORGE_PROXY_CONTENT_LENGTH_REJECTED', 'requestBytes');
        return;
      }
      declaredLength = Number(serializedLength);
      if (declaredLength > meter.contract.maxRequestBytes) {
        rejectAndDrain(request, response, 413, 'FORGE_PROXY_REQUEST_TOO_LARGE', 'requestBytes');
        return;
      }
    }
    const budgetBefore = typeof budget.snapshot === 'function' ? budget.snapshot() : undefined;
    if (budgetBefore && budgetBefore.acceptedRequests >= budgetBefore.maxRequests) {
      budget.reserve();
      fixedProxyError(response, 429, 'FORGE_PROXY_REQUEST_LIMIT_EXCEEDED');
      if (typeof request.resume === 'function') request.resume();
      return;
    }
    const chunks = [];
    let requestBytes = 0;
    let requestRejected = false;
    request.on('data', (chunk) => {
      if (requestRejected) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      requestBytes += value.length;
      if (requestBytes > meter.contract.maxRequestBytes) {
        requestRejected = true;
        meter.recordRejection('requestBytes');
        fixedProxyError(response, 413, 'FORGE_PROXY_REQUEST_TOO_LARGE');
        if (typeof request.resume === 'function') request.resume();
        return;
      }
      chunks.push(value);
    });
    request.on('error', () => {
      if (requestRejected) return;
      requestRejected = true;
      meter.recordRejection('clientStream');
      if (typeof response.destroy === 'function') response.destroy();
    });
    request.on('end', () => {
      if (requestRejected) return;
      if (declaredLength !== undefined && declaredLength !== requestBytes) {
        rejectAndDrain(request, response, 400, 'FORGE_PROXY_CONTENT_LENGTH_MISMATCH', 'requestBytes');
        return;
      }
      let payload;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        payload = JSON.parse(text);
      } catch {
        rejectAndDrain(request, response, 400, 'FORGE_PROXY_JSON_REJECTED', 'malformedJson');
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        rejectAndDrain(request, response, 422, 'FORGE_PROXY_JSON_OBJECT_REQUIRED', 'malformedJson');
        return;
      }
      if (payload.model !== meter.contract.expectedModel) {
        rejectAndDrain(request, response, 422, 'FORGE_PROXY_MODEL_REJECTED', 'modelContract');
        return;
      }
      let injected = false;
      let clamped = false;
      if (!Object.hasOwn(payload, 'max_tokens')) {
        payload.max_tokens = meter.contract.maxOutputTokens;
        injected = true;
      } else if (!Number.isSafeInteger(payload.max_tokens) || payload.max_tokens < 1) {
        rejectAndDrain(request, response, 422, 'FORGE_PROXY_MAX_TOKENS_REJECTED', 'invalidMaxOutputTokens');
        return;
      } else if (payload.max_tokens > meter.contract.maxOutputTokens) {
        payload.max_tokens = meter.contract.maxOutputTokens;
        clamped = true;
      }
      const forwardedBody = Buffer.from(JSON.stringify(payload), 'utf8');
      if (forwardedBody.length > meter.contract.maxRequestBytes) {
        rejectAndDrain(request, response, 413, 'FORGE_PROXY_REWRITTEN_REQUEST_TOO_LARGE', 'requestBytes');
        return;
      }
      if (!meter.canForwardBytes(forwardedBody.length)) {
        rejectAndDrain(request, response, 429, 'FORGE_PROXY_TOTAL_REQUEST_BYTES_EXCEEDED', 'totalRequestBytes');
        return;
      }
      if (!budget.reserve()) {
        fixedProxyError(response, 429, 'FORGE_PROXY_REQUEST_LIMIT_EXCEEDED');
        return;
      }
      meter.recordForward(forwardedBody.length, { injected, clamped });

      const upstreamHeaders = credentialProxyHeaders(request.headers, secret);
      delete upstreamHeaders['content-encoding'];
      upstreamHeaders['content-type'] = 'application/json';
      upstreamHeaders['content-length'] = String(forwardedBody.length);
      let upstreamRequest;
      try {
        upstreamRequest = requestUpstream(upstreamUrl, {
          method: 'POST',
          headers: upstreamHeaders,
          timeout: 600_000,
        }, (upstreamResponse) => {
          const responseHeaders = {};
          for (const [rawName, rawValue] of Object.entries(upstreamResponse.headers)) {
            const name = rawName.toLowerCase();
            if (!HOP_BY_HOP_HEADERS.has(name) && rawValue !== undefined) responseHeaders[name] = rawValue;
          }
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          let responseBytes = 0;
          upstreamResponse.on('data', (chunk) => {
            responseBytes += chunk.length;
            if (responseBytes > MAX_PROXY_RESPONSE_BYTES) {
              upstreamResponse.destroy();
              response.destroy();
              return;
            }
            response.write(chunk);
          });
          upstreamResponse.on('end', () => {
            if (!response.destroyed) response.end();
          });
          upstreamResponse.on('error', () => fixedProxyError(response, 502, 'FORGE_PROXY_UPSTREAM_STREAM_FAILED'));
        });
      } catch {
        meter.recordUpstreamCreationFailure();
        fixedProxyError(response, 502, 'FORGE_PROXY_UPSTREAM_FAILED');
        return;
      }
      activeUpstreamRequests.add(upstreamRequest);
      upstreamRequest.once('close', () => activeUpstreamRequests.delete(upstreamRequest));
      upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('upstream timeout')));
      upstreamRequest.on('error', () => fixedProxyError(response, 502, 'FORGE_PROXY_UPSTREAM_FAILED'));
      upstreamRequest.end(forwardedBody);
    });
  };
}

async function credentialProxyCommand(options, io) {
  if (!options['--secret-file'] || !options['--max-requests']) {
    fail('credential-proxy requires --secret-file and --max-requests.');
  }
  const allowedOptions = [
    'command', '--secret-file', '--max-requests', '--expected-provider', '--expected-model', '--max-output-tokens',
    '--max-request-bytes', '--max-total-request-bytes',
  ];
  if (Object.keys(options).some((key) => !allowedOptions.includes(key))) {
    fail('credential-proxy does not accept a configurable host, port, or upstream.');
  }
  const secretFile = checkedExistingPath(options['--secret-file'], '--secret-file', 'file');
  const secret = readFileSync(secretFile, 'utf8').replace(/[\r\n]+$/g, '');
  if (secret.length === 0 || Buffer.byteLength(secret) > 16_384 || !/^[\x21-\x7e]+$/.test(secret)) {
    fail('The mounted local model key has an invalid file format.');
  }
  const maxRequests = boundedInteger(
    options['--max-requests'], '--max-requests', MIN_PROXY_REQUESTS, MAX_PROXY_REQUESTS,
  );
  for (const required of [
    '--expected-provider', '--expected-model', '--max-output-tokens', '--max-request-bytes', '--max-total-request-bytes',
  ]) {
    if (!options[required]) fail(`credential-proxy requires ${required}.`);
  }
  let contract;
  const upstreamUrl = FIXED_PROXY_UPSTREAMS[options['--expected-provider']];
  if (!upstreamUrl) fail('credential-proxy requires a reviewed fixed --expected-provider.');
  try {
    contract = createCredentialProxyContract({
      expectedModel: options['--expected-model'],
      maxOutputTokens: boundedInteger(
        options['--max-output-tokens'], '--max-output-tokens', 1, MAX_PROXY_OUTPUT_TOKENS,
      ),
      maxRequestBytes: boundedInteger(
        options['--max-request-bytes'], '--max-request-bytes', 1, MAX_PROXY_REQUEST_BYTES,
      ),
      maxTotalRequestBytes: boundedInteger(
        options['--max-total-request-bytes'], '--max-total-request-bytes', 1,
        MAX_PROXY_TOTAL_REQUEST_BYTES,
      ),
    });
  } catch (error) {
    fail(error.message);
  }
  const budget = createRequestBudget(maxRequests);
  const meter = createCredentialProxyMeter(contract);
  const activeUpstreamRequests = new Set();

  const server = http.createServer(createCredentialProxyRequestHandler(
    secret, budget, https.request, activeUpstreamRequests, meter, upstreamUrl,
  ));
  server.on('clientError', (_error, socket) => socket.destroy());

  await new Promise((resolvePromise, rejectPromise) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      for (const upstreamRequest of activeUpstreamRequests) {
        upstreamRequest.destroy(new Error('credential proxy is stopping'));
      }
      server.close(() => {
        io.stdout.write(`${JSON.stringify(createCredentialProxyReceipt('stopped', budget, meter))}\n`);
        resolvePromise();
      });
      server.closeAllConnections();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    server.once('error', rejectPromise);
    server.listen(8080, '0.0.0.0', () => {
      io.stdout.write(`${JSON.stringify(createCredentialProxyReceipt('ready', budget, meter))}\n`);
    });
  });
}

export async function main(argv = process.argv.slice(2), io = process) {
  try {
    const options = parseArgs(argv);
    if (options.command === 'help') {
      io.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.command === 'project') await projectCommand(options);
    else if (options.command === 'evaluate-behavior') evaluateBehaviorCommand(options);
    else if (options.command === 'scrub-secret') scrubSecretCommand(options);
    else if (options.command === 'prove-dsh-config') proveDshConfigCommand(options);
    else if (options.command === 'prove-agent-presets') proveAgentPresetsCommand(options);
    else if (options.command === 'project-container-boundary') projectContainerBoundaryCommand(options);
    else if (options.command === 'project-network-boundary') projectNetworkBoundaryCommand(options);
    else await credentialProxyCommand(options, io);
    return 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: error?.code ?? 'FORGE_HARNESS_ANALYZER_FAILED',
        message: safeScalar(error?.message ?? 'Session analysis failed.', 600),
      },
    })}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) process.exitCode = await main();
