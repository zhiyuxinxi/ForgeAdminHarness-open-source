import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const MUTATIONS = new Set(['write', 'edit', 'remove_file', 'copy_file']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const IDENTITY = ['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest', 'executionId'];
const ACQUIRED_KEYS = ['schemaVersion', 'status', 'permitId', 'executionId', 'generation', 'contractId', 'callId', 'toolName', 'filePath', 'ownedPaths', 'expiresAt'];
const SETTLE_BUSY_DELAYS_MS = [25, 50];
const SETTLEMENT_CAUSE_CODES = new Set(['EXECUTION_STATE_BUSY', 'WRITER_SCOPE_TIMEOUT', 'WRITER_SCOPE_RESPONSE_INVALID',
  'WRITER_SCOPE_RESPONSE_LIMIT', 'WRITER_SCOPE_BROKER_REJECTED', 'WRITER_SCOPE_PERMIT_MISMATCH', 'WRITER_SCOPE_PERMIT_RECOVERED',
  'TASKSPACE_AUTHENTICATION_FAILED', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);

function fail(code, message, cause) {
  throw Object.assign(new Error(`${code}: ${message}`, cause === undefined ? {} : { cause }), { code });
}

function boundedString(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function relativePath(value, allowWorkspace = false) {
  if (!boundedString(value, 1024) || value.includes('\\') || value.includes(':')) {
    fail('WRITER_SCOPE_PATH_INVALID', 'A bounded, unambiguous repository-relative file_path is required.');
  }
  let result = value;
  if (allowWorkspace && result.startsWith('/workspace/')) result = result.slice('/workspace/'.length);
  if (allowWorkspace && result.startsWith('./')) result = result.slice(2);
  if (result.length > 512 || result !== result.normalize('NFC') || result.startsWith('/')
    || result.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('WRITER_SCOPE_PATH_INVALID', 'Use a canonical NFC relative path of at most 512 characters without empty or traversal segments.');
  }
  return result;
}

function mutationPath(exec) {
  let args = exec?.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { fail('WRITER_SCOPE_ARGUMENTS_INVALID', 'Tool arguments must be valid JSON.'); }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.hasOwn(args, 'path') || Object.hasOwn(args, 'file')) {
    fail('WRITER_SCOPE_ARGUMENTS_INVALID', 'A single native file_path parameter is required.');
  }
  return relativePath(args.file_path, true);
}

function ownedPaths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    fail('WRITER_SCOPE_CONTEXT_INVALID', 'The trusted contract must contain bounded ownedPaths.');
  }
  const result = value.map(item => relativePath(item)).sort();
  if (new Set(result.map(item => item.toLowerCase())).size !== result.length) {
    fail('WRITER_SCOPE_CONTEXT_INVALID', 'Trusted ownedPaths must be unique.');
  }
  return result;
}

function requestBinding(context, exec, filePath) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    fail('WRITER_SCOPE_CONTEXT_REQUIRED', 'A trusted execution context is required before mutation.');
  }
  const binding = {};
  for (const key of IDENTITY) {
    if (!boundedString(context[key], key === 'dshSessionId' ? 1024 : 256)) {
      fail('WRITER_SCOPE_CONTEXT_INVALID', `Trusted ${key} is missing or invalid.`);
    }
    binding[key] = context[key];
  }
  if (!UUID.test(context.actorUserId) || !HASH.test(context.textDigest)
    || !Number.isSafeInteger(context.generation) || context.generation < 0
    || !HASH.test(context.contract?.contractId ?? '')
    || (context.contractId !== undefined && context.contractId !== context.contract.contractId)) {
    fail('WRITER_SCOPE_CONTEXT_INVALID', 'Trusted execution generation, digest or contract identity is invalid.');
  }
  if (!MUTATIONS.has(exec?.name) || !boundedString(exec.callId)
    || exec.agent?.session?.id !== context.dshSessionId) {
    fail('WRITER_SCOPE_EXECUTION_INVALID', 'The tool call must belong to the trusted DSH session.');
  }
  const target = relativePath(filePath);
  if (target !== mutationPath(exec)) fail('WRITER_SCOPE_PATH_MISMATCH', 'The requested path differs from the native file_path.');
  const scope = ownedPaths(context.contract.ownedPaths);
  if (!scope.some(owner => target === owner || target.startsWith(`${owner}/`))) {
    fail('WRITER_SCOPE_OUTSIDE_CONTRACT', 'The native target is outside the trusted ownedPaths.');
  }
  return { binding: { ...binding, generation: context.generation, contractId: context.contract.contractId,
    callId: exec.callId, toolName: exec.name, filePath: target }, scope };
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
}

function acquiredPermit(value, binding, scope, requireUnexpired = true) {
  if (!exactKeys(value, ACQUIRED_KEYS) || value.schemaVersion !== 1 || value.status !== 'acquired'
    || !UUID.test(value.permitId ?? '') || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.expiresAt))
    || (requireUnexpired && Date.parse(value.expiresAt) <= Date.now())
    || !['executionId', 'generation', 'contractId', 'callId', 'toolName', 'filePath'].every(key => value[key] === binding[key])
    || !isDeepStrictEqual(ownedPaths(value.ownedPaths), scope)) {
    fail('WRITER_SCOPE_RESPONSE_INVALID', 'The acquired permit is not bound to this exact execution, call and scope; the body was not authorized.');
  }
  return Object.freeze({ ...value, ownedPaths: Object.freeze([...value.ownedPaths]) });
}

function settledReceipt(value, permit, callId) {
  if (!exactKeys(value, ['schemaVersion', 'status', 'permitId', 'callId'])
    || value.schemaVersion !== 1 || value.status !== 'settled'
    || value.permitId !== permit.permitId || value.callId !== callId) {
    fail('WRITER_SCOPE_RESPONSE_INVALID', 'The settlement receipt does not match the acquired permit and call.');
  }
  return Object.freeze({ ...value });
}

export function createBrokerWriterScopeLeaseClient({
  brokerUrl = process.env.FORGE_TASKSPACE_BROKER_URL,
  tokenFile = process.env.FORGE_TASKSPACE_TOKEN_FILE,
  timeoutMs = 5000,
  readTokenFile = readFile,
} = {}) {
  if (typeof brokerUrl !== 'string' || typeof tokenFile !== 'string') return undefined;
  const endpoint = new URL(brokerUrl);
  if (endpoint.protocol !== 'http:' || !['taskspace-broker', '127.0.0.1', 'localhost'].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/'
    || !tokenFile.startsWith('/run/forge-taskspace/') || path.posix.normalize(tokenFile) !== tokenFile
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000
    || typeof readTokenFile !== 'function') {
    fail('WRITER_SCOPE_CLIENT_CONFIG_INVALID', 'Use the fixed internal Broker and its taskspace capability token file.');
  }
  return async (operation, { context, exec, filePath, permit } = {}) => {
    if (!['acquire', 'settle'].includes(operation)) fail('WRITER_SCOPE_OPERATION_INVALID', 'Only acquire and settle are supported.');
    const { binding, scope } = requestBinding(context, exec, filePath);
    if (operation === 'settle') acquiredPermit(permit, binding, scope, false);
    const token = (await readTokenFile(tokenFile, 'utf8')).trim();
    if (token.length < 32 || token.length > 256 || /[\r\n]/u.test(token)) {
      fail('WRITER_SCOPE_TOKEN_INVALID', 'TaskSpace capability token is invalid.');
    }
    const send = async (wireOperation, selectedPermitId) => {
      // Project a fixed wire shape. Neither model arguments nor context extras
      // can add action names, extra paths or authority fields to this request.
      const payload = Buffer.from(JSON.stringify({ action: 'writer-scope-lease', operation: wireOperation, ...binding,
        permitId: selectedPermitId }));
      const operationDeadline = performance.now() + timeoutMs;
      const timedOut = () => Object.assign(new Error('Writer scope Broker request timed out; do not automatically retry the mutation.'),
        { code: 'WRITER_SCOPE_TIMEOUT' });
      const requestOnce = () => new Promise((resolve, reject) => {
        let deadline;
        const request = http.request({ hostname: endpoint.hostname, port: endpoint.port, method: 'POST', path: '/v1/actions',
          headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-forge-taskspace-token': token } }, response => {
          const chunks = [];
          let bytes = 0;
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > 64 * 1024) response.destroy(Object.assign(new Error('Writer scope response exceeded its limit.'), { code: 'WRITER_SCOPE_RESPONSE_LIMIT' }));
            else chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => {
            try {
              const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300 || document.ok !== true) {
                fail(document.error?.code ?? 'WRITER_SCOPE_BROKER_REJECTED', document.error?.message ?? 'Broker rejected the writer scope operation.');
              }
              resolve(document.result);
            } catch (error) { reject(error); }
          });
        });
        deadline = setTimeout(() => request.destroy(timedOut()), Math.max(1, operationDeadline - performance.now()));
        request.once('close', () => clearTimeout(deadline));
        request.once('error', reject);
        // Do not attach exec.signal: if cancellation races with acquisition,
        // receive the permit first so the around-hook can settle it safely.
        request.end(payload);
      });
      let result;
      for (let attempt = 0; ; attempt++) {
        if (performance.now() >= operationDeadline) throw timedOut();
        try { result = await requestOnce(); break; } catch (error) {
          // Only a rejected lock acquisition is safe to retry. Reuse the exact
          // settlement payload; never repeat acquisition or the mutation body.
          if (!['settle', 'cancel-acquire'].includes(wireOperation) || error?.code !== 'EXECUTION_STATE_BUSY' || attempt >= SETTLE_BUSY_DELAYS_MS.length) throw error;
          const delay = SETTLE_BUSY_DELAYS_MS[attempt];
          if (performance.now() + delay >= operationDeadline) throw timedOut();
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      return result;
    };
    if (operation === 'settle') return settledReceipt(await send('settle', permit.permitId), permit, binding.callId);
    // Pin the capability before the HTTP await. If acquisition is uncertain,
    // no tool body has run and this exact call can be cancelled even if its
    // response was lost or the original request reaches the Broker later.
    const permitId = randomUUID();
    try {
      const acquired = acquiredPermit(await send('acquire', permitId), binding, scope, false);
      if (acquired.permitId !== permitId) fail('WRITER_SCOPE_RESPONSE_INVALID', 'The Broker returned a different acquisition capability.');
      return acquired;
    } catch (acquireError) {
      // The state-lock rejection happens before the Broker can write a permit.
      if (acquireError?.code === 'EXECUTION_STATE_BUSY') throw acquireError;
      try {
        const cancelled = await send('cancel-acquire', permitId);
        if (!exactKeys(cancelled, ['schemaVersion', 'status', 'permitId', 'callId'])
            || cancelled.schemaVersion !== 1 || cancelled.status !== 'acquisition-cancelled'
            || cancelled.permitId !== permitId || cancelled.callId !== binding.callId) {
          fail('WRITER_SCOPE_RESPONSE_INVALID', 'Acquisition cancellation did not match the exact permit and call.');
        }
      } catch (cancelError) {
        const cancellationCauseCode = SETTLEMENT_CAUSE_CODES.has(cancelError?.code) ? cancelError.code : 'UNKNOWN';
        throw Object.assign(new Error(`WRITER_SCOPE_ACQUIRE_UNCONFIRMED: The tool body did not start, but cancellation of its uncertain acquisition was not confirmed (cause=${cancellationCauseCode}). Do not automatically replay the tool.`,
          { cause: new AggregateError([acquireError, cancelError], 'Acquisition and cancellation both failed.') }),
        { code: 'WRITER_SCOPE_ACQUIRE_UNCONFIRMED', cancellationCauseCode, bodyStarted: false, permitId, callId: binding.callId });
      }
      throw Object.assign(acquireError, { acquisitionCancelled: true, bodyStarted: false, permitId, callId: binding.callId });
    }
  };
}

export function installForgeWriterScopeLease(ctx, { resolveContext, client } = {}) {
  return ctx.on('tools/execute', async (exec, next) => {
    if (!MUTATIONS.has(exec?.name)) return next();
    if (typeof client !== 'function' || typeof resolveContext !== 'function') {
      fail('WRITER_SCOPE_UNAVAILABLE', 'Mutation requires the trusted Broker writer scope client and context resolver.');
    }
    const filePath = mutationPath(exec);
    const context = await resolveContext(exec);
    const { binding, scope } = requestBinding(context, exec, filePath);
    // Retain one immutable identity across the await/body/settlement lifetime.
    const pinnedContext = Object.freeze({ ...Object.fromEntries(IDENTITY.map(key => [key, binding[key]])),
      generation: binding.generation, contractId: binding.contractId,
      contract: Object.freeze({ contractId: binding.contractId, ownedPaths: Object.freeze([...scope]) }) });
    const leaseExec = Object.freeze({ name: exec.name, callId: exec.callId,
      agent: { session: { id: binding.dshSessionId } }, arguments: Object.freeze({ file_path: filePath }) });
    exec.signal?.throwIfAborted();
    const permit = acquiredPermit(await client('acquire', { context: pinnedContext, exec: leaseExec, filePath }), binding, scope, false);
    let bodyStarted = false;
    let bodyError;
    try {
      if (Date.parse(permit.expiresAt) <= Date.now()) {
        fail('WRITER_SCOPE_PERMIT_EXPIRED', 'The acquired permit expired before the body started; settle it without replaying the mutation.');
      }
      exec.signal?.throwIfAborted();
      bodyStarted = true;
      return await next();
    } catch (error) {
      bodyError = error;
      throw error;
    } finally {
      try {
        const settled = await client('settle', { context: pinnedContext, exec: leaseExec, filePath, permit });
        settledReceipt(settled, permit, binding.callId);
      } catch (settleError) {
        const settlementCauseCode = SETTLEMENT_CAUSE_CODES.has(settleError?.code) ? settleError.code : 'UNKNOWN';
        const error = new Error(`WRITER_SCOPE_SETTLE_UNCONFIRMED: The tool body may already have executed, but lease settlement was not confirmed (cause=${settlementCauseCode}). Do not automatically replay the tool.`,
          { cause: bodyError === undefined ? settleError : new AggregateError([bodyError, settleError], 'Tool execution and lease settlement both failed.') });
        Object.assign(error, { code: 'WRITER_SCOPE_SETTLE_UNCONFIRMED', settlementCauseCode, bodyStarted, permitId: permit.permitId, callId: binding.callId });
        throw error;
      }
    }
  });
}
