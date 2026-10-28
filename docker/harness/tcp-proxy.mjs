import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { stripGatewayCookies } from './conversation-policy.mjs';
import { createConversationOutputService } from './conversation-output-service.mjs';
import { readHarnessDirectoryScope } from './harness-directory-scope.mjs';
import { createWorkpodPromptQueue } from './conversation-message-queue-runtime.mjs';
import {
  MAX_CLAIMABLE_PROMPT_BYTES,
  classifyPinnedDshPromptBody,
  unparsedPromptAdvance,
} from './forge-execution-context.mjs';

const PRIVILEGED_API_MODES = new Set(['loopback-only', 'trusted-host']);
const MAX_HISTORY_REQUEST_BYTES = 1024 * 1024;
const MAX_HISTORY_PAGE_MESSAGES = 50;
const PROJECT_FILE_UPLOAD_ASSET_PATH = '/forge-assets/project-file-upload.js';
const CONVERSATION_OUTPUT_ASSET_PATH = '/forge-assets/conversation-output.js';
const DIRECTORY_SCOPE_ASSET_PATH = '/forge-assets/harness-directory-scope.js';
const HARNESS_ACCESS_COOKIE = 'forge_harness_access';
const MAINTENANCE_FENCE_SCHEMA_VERSION = 1;
const MAINTENANCE_FENCE_MAX_BYTES = 4096;
const MAINTENANCE_FENCE_EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAINTENANCE_CONNECTION_GRACE_MS = 250;
const UPSTREAM_STARTUP_RETRY_MS = 30_000;
const UPSTREAM_STARTUP_RETRY_DELAY_MS = 250;
// Gateway -> Manager may spend up to 120 seconds observing the authoritative
// source before it returns an execution context.  The outer proxy must not
// abandon that same request first and leave a prepared-but-unforwarded RPC.
const EXECUTION_PREPARE_TIMEOUT_MS = 125_000;
const MAX_EXECUTION_PREPARE_RESPONSE_BYTES = 2 * 1024 * 1024;
const WORKPOD_ACTION_HEADERS = ['x-forge-action-session-id', 'x-forge-action-as-of-seq'];

class WorkpodActionError extends Error {
  constructor(message = '当前对话已变化或仍在执行，本次按钮操作未发送。请查看最新结果后再操作。') {
    super(message);
  }
}

function workpodActionBinding(request, classified) {
  const [sessionId, sequence] = WORKPOD_ACTION_HEADERS.map(name => request.headers[name]);
  if (sessionId === undefined && sequence === undefined) return null;
  if (typeof sessionId !== 'string' || sessionId !== classified.dshSessionId
    || classified.route !== 'session.prompt' || classified.classification !== 'claimable-text'
    || classified.mode !== 'queue' || typeof sequence !== 'string' || !/^[1-9][0-9]{0,15}$/u.test(sequence)
    || !Number.isSafeInteger(Number(sequence))) throw new WorkpodActionError();
  return { sessionId, asOfSeq: Number(sequence) };
}

async function assertWorkpodActionCurrent(binding, { targetHost, targetPort, headers }) {
  if (!binding) return;
  const rpcId = crypto.randomUUID();
  const body = JSON.stringify({ type: 'client-request', rpcId, method: 'session.list', payload: {} });
  const requestHeaders = { ...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
  delete requestHeaders['transfer-encoding'];
  for (const name of WORKPOD_ACTION_HEADERS) delete requestHeaders[name];
  let value;
  try {
    value = await new Promise((resolve, reject) => {
      const call = http.request({ host: targetHost, port: targetPort, path: '/api/session.list',
        method: 'POST', headers: requestHeaders, timeout: 5000 }, response => {
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > MAX_EXECUTION_PREPARE_RESPONSE_BYTES) response.destroy(new Error('session observation exceeded limit'));
          else chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            if (response.statusCode !== 200) throw new Error('session observation unavailable');
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) { reject(error); }
        });
      });
      call.once('timeout', () => call.destroy(new Error('session observation timed out')));
      call.once('error', reject); call.end(body);
    });
  } catch { throw new WorkpodActionError('暂时无法核对当前对话，本次按钮操作未发送。请稍后查看结果再操作。'); }
  const session = value?.rpcId === rpcId && value.result?.ok === true
    ? value.result.value?.items?.find(item => item.sessionId === binding.sessionId) : null;
  if (!session || session.running !== false || session.projections?.asOfSeq !== binding.asOfSeq) throw new WorkpodActionError();
}

function rejectWorkpodAction(response, rpcId, error) {
  const body = JSON.stringify({ type: 'server-response', rpcId,
    result: { ok: false, error: { code: 'internal', message: error.message,
      details: { reason: 'WORKPOD_ACTION_NOT_ACCEPTED', requestAccepted: false, retryable: false } } } });
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body) }).end(body);
}

// Only these expected task-continuation failures are safe to explain at ingress.
// Keep upstream diagnostics and unrecognized failures out of the browser.
const CONTINUATION_FAILURE_MESSAGES = Object.freeze({
  CONVERSATION_EXECUTION_BUSY: '上一轮对话或工具仍在执行，这条消息尚未派发，将在上一轮结束后继续。',
  CONVERSATION_DISPATCH_UNCONFIRMED: '上一条消息的接收结果暂未确认，本条消息尚未派发。请先查看原对话结果；系统不会自动重发结果未知的请求。',
  CONVERSATION_INTENT_INVALID: '平台请求解释结果不一致，本次消息未进入业务执行。请保留原请求并联系平台维护人员，无需重复授权。',
  CONVERSATION_INTENT_UNAVAILABLE: '平台请求解释服务不可用，本次消息未进入业务执行。请保留原请求并联系平台维护人员，无需重复授权。',
  CONVERSATION_PREPARATION_UNAVAILABLE: '请求准备未能完成，本次消息尚未进入模型。输入已恢复，可以稍后重新提交；原有任务与结果已保留。',
  ACCEPTANCE_SOURCE_OBSERVER_UNAVAILABLE: '当前工作区状态暂时无法核验，本次请求尚未进入模型，也未执行修改。请稍后重试；若持续出现，请联系平台维护人员。',
  CONVERSATION_WRITE_SCOPE_REQUIRED: '当前没有与本会话和代码版本匹配的待执行任务。请说明要实施的页面、接口或模块；本次未启动执行。',
  CONVERSATION_WRITE_SCOPE_REVOKED: '原任务范围已不在项目当前允许修改的范围内。本次未执行，请先确认项目允许的任务范围。',
  CONVERSATION_ACTION_NOT_AUTHORIZED: '当前账号没有继续此任务所需的提交或发版权限。本次未执行。',
  CONVERSATION_REQUEST_EXPIRED: '这条请求的执行授权已过期。请重新发送“继续”获取当前授权；本次未执行。',
  CONVERSATION_REQUEST_REPLAY: '这条请求已被后续消息替代。请发送新的继续请求；本次未重复执行。',
  PHASE_TERMINAL_REPAIR_REQUIRED: '上一轮对话已结束，真实回答和变更已保存。当前候选需要关联修复，尚未通过阶段验收；原阶段及历史记录已保留，本次未启动新一轮执行。',
  PHASE_FRONTEND_REPAIR_AVAILABLE: '上一轮前端对话已结束，候选尚未通过验收。如需继续修复，请发送“继续修改”。平台会保留原失败和有效上游，在关联修复中继续。',
  PHASE_HOST_VERIFICATION_REQUIRED: '上一轮对话已结束，真实回答和变更已保存，候选预检通过；仍需宿主机验证及阶段验收。原阶段未推进，本次未启动新一轮执行。',
  PHASE_SEMANTIC_REVIEW_REQUIRED: '上一轮对话及真实宿主验证回执已保存并核验，仍待阶段验收。可发送只读请求核对结果与来源；当前阶段结果确认无误后，发送“继续完成”继续验收。原阶段未推进，本次未启动新一轮执行。',
  PHASE_CONVERSATION_STILL_RUNNING: '上一轮对话仍在执行，请等它结束后继续。原阶段未推进，本次未启动新一轮执行。',
  CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED: '权限接线已接受，跨层验收缺少绑定当前源码的部署、API、浏览器和数据库运行证据，尚未启动下一轮。',
});

class ConversationContinuationError extends Error {
  constructor(code, status, rpcId) {
    super(CONTINUATION_FAILURE_MESSAGES[code]);
    this.code = code;
    this.status = status;
    this.rpcId = rpcId;
  }
}

function rejectConversationContinuation(response, error) {
  // The pinned DSH client discards non-2xx bodies. A successful transport with
  // result.ok=false displays its normal prompt error; no prompt reaches DSH.
  const queued = error.code === 'CONVERSATION_EXECUTION_BUSY' && error.status === 409;
  const body = JSON.stringify({
    type: 'server-response',
    rpcId: error.rpcId,
    result: { ok: false, error: { code: queued ? 'agent-busy' : 'internal', message: error.message,
      details: queued ? { reason: 'CONVERSATION_EXECUTION_BUSY_NOT_ACCEPTED', retryable: true, requestAccepted: false }
        : error.code === 'CONVERSATION_PREPARATION_UNAVAILABLE'
          ? { reason: error.code, retryable: true, requestAccepted: false } : {} } },
  });
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}
const projectFileUploadScript = readFileSync(
  new URL('./project-file-upload.js', import.meta.url),
  'utf8',
);
const conversationOutputScript = readFileSync(new URL('./conversation-output.js', import.meta.url), 'utf8');
const directoryScopeScript = readFileSync(new URL('./harness-directory-scope.js', import.meta.url), 'utf8');
const conversationPromptQueueScript = readFileSync(new URL('./conversation-prompt-queue.js', import.meta.url), 'utf8');

// Keep this list aligned with the pinned DSH release's PRIVILEGED_METHODS.
// Unknown future privileged methods fail closed until the pinned upgrade is
// reviewed and this list is updated deliberately.
export const PRIVILEGED_METHODS = new Set([
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
]);

// crypto.randomUUID is a secure-context API in Chromium. Harness uses it in the
// workspace picker, but this platform is intentionally accessed over a private
// VPN by IP and plain HTTP. Inject the smallest possible compatibility shim
// before Harness loads any of its own scripts.
const insecureHttpCompatibilityScript = `<script data-forge-harness-compat="random-uuid">
(() => {
  const cryptoObject = globalThis.crypto;
  if (!cryptoObject || typeof cryptoObject.randomUUID === 'function') return;

  const randomUUID = () => {
    const bytes = new Uint8Array(16);
    if (typeof cryptoObject.getRandomValues === 'function') {
      cryptoObject.getRandomValues(bytes);
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256);
      }
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
    return [
      hex.slice(0, 4).join(''),
      hex.slice(4, 6).join(''),
      hex.slice(6, 8).join(''),
      hex.slice(8, 10).join(''),
      hex.slice(10).join(''),
    ].join('-');
  };

  Object.defineProperty(cryptoObject, 'randomUUID', {
    configurable: true,
    value: randomUUID,
  });
})();
</script>`;

// The pinned Harness UI already implements cursor pagination and preserves the
// scroll anchor after loadOlder(). This adapter turns its visible fallback
// button into infinite upward scrolling without coupling to minified React
// internals. Only trusted user scroll events can trigger one request per pass;
// the user must move away from the threshold before another page is armed.
const historyAutoLoadCompatibilityScript = `<script data-forge-harness-compat="history-auto-load">
(() => {
  const triggerThreshold = 160;
  const rearmThreshold = triggerThreshold * 2;
  const stateByScroller = new WeakMap();

  const findLoadOlderButton = (scroller) => Array.from(scroller.querySelectorAll('button')).find((button) => (
    !button.disabled
    && button.getClientRects().length > 0
    && /加载更早|上一个问题/.test(button.textContent?.replace(/\\s+/g, '') ?? '')
  ));

  document.addEventListener('scroll', (event) => {
    if (!event.isTrusted || !(event.target instanceof HTMLElement)) return;
    const scroller = event.target;
    if (scroller.scrollHeight <= scroller.clientHeight) return;

    let state = stateByScroller.get(scroller);
    if (state === undefined) {
      state = { armed: true, pending: false };
      stateByScroller.set(scroller, state);
    }
    // Landing on a question is one navigation, not another reader scroll/page.
    if (Date.now() < (globalThis.__forgeHistoryNavigationUntil ?? 0)) {
      state.armed = false;
      return;
    }
    if (scroller.scrollTop > rearmThreshold) {
      state.armed = true;
      return;
    }
    if (scroller.scrollTop > triggerThreshold || !state.armed || state.pending) return;

    const button = findLoadOlderButton(scroller);
    if (button === undefined) return;
    state.armed = false;
    state.pending = true;
    button.click();
    globalThis.setTimeout(() => {
      state.pending = false;
    }, 1500);
  }, true);
})();
</script>`;

const projectFileUploadCompatibilityScript = `<script data-forge-harness-compat="prompt-queue">${conversationPromptQueueScript}</script><script defer data-forge-harness-compat="project-file-upload" src="${PROJECT_FILE_UPLOAD_ASSET_PATH}"></script><script defer data-forge-harness-compat="conversation-output" src="${CONVERSATION_OUTPUT_ASSET_PATH}"></script><script defer data-forge-harness-compat="directory-scope" src="${DIRECTORY_SCOPE_ASSET_PATH}"></script>`;

// Recovered legacy sessions share one immutable archive TaskSpace. The Gateway
// supplies an authenticated, validated session id in the TaskSpace URL; persist
// it before the pinned Harness bundle restores its current-session snapshot.
const legacySessionSelectionCompatibilityScript = `<script data-forge-harness-compat="legacy-session-selection">
(() => {
  const parameters = new URLSearchParams(globalThis.location.search);
  const sessionId = parameters.get('forgeSession');
  if (sessionId === null || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) return;
  try {
    globalThis.localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }));
    parameters.delete('forgeSession');
    const query = parameters.toString();
    const nextUrl = globalThis.location.pathname
      + (query.length === 0 ? '' : '?' + query)
      + globalThis.location.hash;
    globalThis.history.replaceState(globalThis.history.state, '', nextUrl);
  } catch {}
})();
</script>`;

function closedMaintenanceFence(state, reason, epoch = undefined) {
  return Object.freeze({ open: false, state, reason, ...(epoch === undefined ? {} : { epoch }) });
}

export async function readHarnessMaintenanceFence(fencePath) {
  if (typeof fencePath !== 'string' || !path.isAbsolute(fencePath)) {
    return closedMaintenanceFence('invalid', 'FENCE_PATH_INVALID');
  }
  let information;
  try {
    information = await lstat(fencePath);
  } catch (error) {
    return error.code === 'ENOENT'
      ? closedMaintenanceFence('missing', 'FENCE_MISSING')
      : closedMaintenanceFence('unreadable', 'FENCE_UNREADABLE');
  }
  if (!information.isFile() || information.isSymbolicLink()
    || information.size < 1 || information.size > MAINTENANCE_FENCE_MAX_BYTES) {
    return closedMaintenanceFence('invalid', 'FENCE_INVALID');
  }
  let value;
  try {
    value = JSON.parse(await readFile(fencePath, 'utf8'));
  } catch {
    return closedMaintenanceFence('invalid', 'FENCE_INVALID');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'epoch,schemaVersion,state'
    || value.schemaVersion !== MAINTENANCE_FENCE_SCHEMA_VERSION
    || typeof value.epoch !== 'string'
    || !MAINTENANCE_FENCE_EPOCH_PATTERN.test(value.epoch)
    || !['maintenance', 'committed'].includes(value.state)) {
    return closedMaintenanceFence('invalid', 'FENCE_INVALID');
  }
  if (value.state !== 'committed') {
    return closedMaintenanceFence('maintenance', 'FENCE_MAINTENANCE', value.epoch);
  }
  return Object.freeze({ open: true, state: 'committed', epoch: value.epoch });
}

function writeProxyError(response, error) {
  console.error(`Harness HTTP proxy upstream failed: ${error.message}`);
  if (!response.headersSent) {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
  }
  response.end('Harness upstream is unavailable');
}

function proxyHarnessRequestWithStartupRetry(request, response, options, body, handoff, observeResponse) {
  const retryable = body === undefined
    && (request.method === 'GET' || request.method === 'HEAD')
    && request.headers['content-length'] === undefined
    && request.headers['transfer-encoding'] === undefined;
  const startedAt = Date.now();
  let activeRequest;
  let retryTimer;
  let cancelled = false;
  let upstreamConnected = false;
  let handoffSettled = false;
  const settleHandoff = (outcome) => {
    if (handoffSettled) return;
    handoffSettled = true;
    handoff?.settle(outcome);
  };

  const cancel = () => {
    // Once dispatch starts, a browser disconnect is not a native rejection.
    // Keep receiving the one original RPC; never cancel or replay it here.
    if (handoff !== undefined) return;
    cancelled = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    activeRequest?.destroy();
  };
  request.once('aborted', cancel);
  response.once('close', () => {
    if (!response.writableEnded) cancel();
  });

  const attempt = () => {
    retryTimer = undefined;
    if (cancelled || response.writableEnded || response.destroyed) {
      settleHandoff('not-dispatched');
      return;
    }
    activeRequest = http.request(
      options,
      (upstreamResponse) => {
        activeRequest = undefined;
        if (observeResponse !== undefined) {
          const chunks = [];
          let bytes = 0;
          upstreamResponse.on('data', chunk => {
            bytes += chunk.length;
            if (bytes <= MAX_EXECUTION_PREPARE_RESPONSE_BYTES) chunks.push(chunk);
          });
          upstreamResponse.once('end', () => {
            if (upstreamResponse.statusCode !== 200 || bytes > MAX_EXECUTION_PREPARE_RESPONSE_BYTES) return;
            try { observeResponse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch {}
          });
        }
        if (handoff !== undefined) {
          // Only a complete, correlated native RPC response proves admission or
          // rejection. A 502 page, truncated body or transport reset does not.
          const chunks = [];
          let bytes = 0;
          const drainDisconnected = () => {
            // pipe's own close listener unpipes/pauses after this listener.
            // Resume after that cleanup so a partial RPC still reaches end.
            if (!response.writableEnded) queueMicrotask(() => upstreamResponse.resume());
          };
          response.once('close', drainDisconnected);
          upstreamResponse.on('data', chunk => {
            bytes += chunk.length;
            if (bytes <= MAX_EXECUTION_PREPARE_RESPONSE_BYTES) chunks.push(chunk);
          });
          upstreamResponse.once('end', () => {
            response.off('close', drainDisconnected);
            let confirmed = false;
            const body = Buffer.concat(chunks).toString('utf8');
            try {
              const rpc = JSON.parse(body);
              confirmed = bytes <= MAX_EXECUTION_PREPARE_RESPONSE_BYTES
                && upstreamResponse.statusCode >= 200 && upstreamResponse.statusCode < 300
                && rpc.type === 'server-response' && rpc.rpcId === handoff.rpcId
                && (rpc.result?.ok === false || (rpc.result?.ok === true && typeof rpc.result.value?.accepted === 'boolean'));
            } catch {}
            // These two pinned carrier errors occur before native RPC dispatch.
            if ((upstreamResponse.statusCode === 400 && body === 'body is not JSON')
              || (upstreamResponse.statusCode === 415 && body === 'content type must be application/json')) confirmed = true;
            settleHandoff(confirmed ? 'confirmed' : 'unconfirmed');
          });
          upstreamResponse.once('error', () => settleHandoff('unconfirmed'));
          upstreamResponse.once('close', () => {
            if (!upstreamResponse.complete) settleHandoff('unconfirmed');
          });
          if (response.destroyed) upstreamResponse.resume();
          else pipeUpstreamResponse(request, response, upstreamResponse);
        } else pipeUpstreamResponse(request, response, upstreamResponse);
      },
    );
    activeRequest.once('socket', socket => {
      if (!socket.connecting) upstreamConnected = true;
      else socket.once('connect', () => { upstreamConnected = true; });
    });
    activeRequest.once('error', (error) => {
      activeRequest = undefined;
      if (retryable
        && error.code === 'ECONNREFUSED'
        && Date.now() - startedAt < UPSTREAM_STARTUP_RETRY_MS
        && !cancelled
        && !response.headersSent) {
        retryTimer = setTimeout(attempt, UPSTREAM_STARTUP_RETRY_DELAY_MS);
        return;
      }
      settleHandoff(upstreamConnected ? 'unconfirmed' : 'not-dispatched');
      if (!response.destroyed) writeProxyError(response, error);
    });
    if (retryable) activeRequest.end();
    else if (body === undefined) request.pipe(activeRequest);
    else activeRequest.end(body);
  };

  attempt();
}

function acceptsGzip(request) {
  const value = request.headers['accept-encoding'];
  if (typeof value !== 'string') return false;
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry === 'gzip' || (entry.startsWith('gzip;') && !entry.includes('q=0')));
}

function isCompressible(contentType) {
  return contentType.startsWith('text/')
    || contentType.includes('json')
    || contentType.includes('javascript')
    || contentType.includes('xml')
    || contentType.includes('svg');
}

function appendVary(existing, value) {
  const values = String(existing ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) values.push(value);
  return values.join(', ');
}

function pipeUpstreamResponse(request, response, upstreamResponse) {
  const contentType = String(upstreamResponse.headers['content-type'] ?? '').toLowerCase();
  if (request.url?.split('?')[0] === '/plugins/@deepseek-ai/dsh-client-connection/client.js'
    && upstreamResponse.statusCode === 200 && contentType.includes('javascript')) {
    const chunks = [];
    upstreamResponse.on('data', chunk => chunks.push(chunk));
    upstreamResponse.on('end', () => {
      const source = Buffer.concat(chunks).toString('utf8');
      // Queue admission belongs to the composer, not a fabricated native RPC.
      // Native callers retain the real session.prompt response and semantics.
      const body = source;
      const headers = { ...upstreamResponse.headers, 'cache-control': 'no-store' };
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
      delete headers.etag;
      headers['content-length'] = Buffer.byteLength(body);
      response.writeHead(upstreamResponse.statusCode, headers);
      response.end(body);
    });
    upstreamResponse.on('error', error => writeProxyError(response, error));
    return;
  }
  if (contentType.includes('text/html')) {
    const chunks = [];
    upstreamResponse.on('data', (chunk) => chunks.push(chunk));
    upstreamResponse.on('end', () => {
      const html = Buffer.concat(chunks).toString('utf8');
      const compatibilityScripts = `${legacySessionSelectionCompatibilityScript}${insecureHttpCompatibilityScript}${historyAutoLoadCompatibilityScript}${projectFileUploadCompatibilityScript}`;
      const body = html.includes('<head>')
        ? html.replace('<head>', `<head>${compatibilityScripts}`)
        : `${compatibilityScripts}${html}`;
      const headers = { ...upstreamResponse.headers };
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
      headers['content-length'] = Buffer.byteLength(body);
      response.writeHead(upstreamResponse.statusCode ?? 200, headers);
      response.end(body);
    });
    upstreamResponse.on('error', (error) => writeProxyError(response, error));
    return;
  }

  const shouldCompress = request.method !== 'HEAD'
    && upstreamResponse.statusCode !== 204
    && upstreamResponse.headers['content-encoding'] === undefined
    && acceptsGzip(request)
    && isCompressible(contentType);
  if (!shouldCompress) {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
    upstreamResponse.on('error', (error) => response.destroy(error));
    return;
  }

  const headers = { ...upstreamResponse.headers };
  delete headers['content-length'];
  delete headers['transfer-encoding'];
  delete headers.etag;
  headers['content-encoding'] = 'gzip';
  headers.vary = appendVary(headers.vary, 'Accept-Encoding');
  response.writeHead(upstreamResponse.statusCode ?? 502, headers);
  const gzip = createGzip({ level: 6 });
  gzip.on('error', (error) => response.destroy(error));
  upstreamResponse.on('error', (error) => response.destroy(error));
  upstreamResponse.pipe(gzip).pipe(response);
}

function capHistoryRequestBody(body, historyPageMessages) {
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (
      value?.type !== 'client-request'
      || value?.method !== 'session.history'
      || typeof value?.payload !== 'object'
      || value.payload === null
    ) return body;
    if (
      Number.isInteger(value.payload.maxMessages)
      && value.payload.maxMessages <= historyPageMessages
    ) return body;
    value.payload.maxMessages = historyPageMessages;
    return Buffer.from(JSON.stringify(value));
  } catch {
    return body;
  }
}

function parseAuthority(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== ''
    ) return undefined;
    return parsed.host;
  } catch {
    return undefined;
  }
}

function apiMethodOf(requestUrl) {
  const pathname = new URL(requestUrl ?? '/', 'http://harness.proxy.invalid').pathname;
  return pathname.startsWith('/api/') ? pathname.slice('/api/'.length) : undefined;
}

function isTrustedIngress(request, trustedAuthority) {
  const requestAuthority = parseAuthority(request.headers.host);
  if (requestAuthority === undefined || requestAuthority !== trustedAuthority) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;

  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (Array.isArray(origin)) return false;
  try {
    return new URL(origin).host === trustedAuthority;
  } catch {
    return false;
  }
}

function rejectHttp(response, status = 403, loginUrl = undefined, request = undefined) {
  const acceptsHtml = request?.method === 'GET'
    && String(request.headers.accept ?? '').toLowerCase().includes('text/html');
  if (status === 401 && acceptsHtml && typeof loginUrl === 'string') {
    response.writeHead(302, {
      'cache-control': 'no-store',
      'content-length': '0',
      location: loginUrl,
      'referrer-policy': 'no-referrer',
    });
    response.end();
    return;
  }
  const message = status === 401 ? 'authentication required'
    : status === 503 ? 'authorization unavailable'
      : 'forbidden';
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(message),
  });
  response.end(message);
}

function rejectUpgrade(socket, status = 403) {
  const reason = status === 401 ? 'Unauthorized'
    : status === 503 ? 'Service Unavailable'
      : 'Forbidden';
  const message = status === 401 ? 'authentication required'
    : status === 503 ? 'authorization unavailable'
      : 'forbidden';
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(message)}`,
    '',
    message,
  ].join('\r\n'));
}

function accessTokenMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function cookieValue(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const item of header.split(';')) {
    const delimiter = item.indexOf('=');
    if (delimiter < 1 || item.slice(0, delimiter).trim() !== name) continue;
    return item.slice(delimiter + 1).trim();
  }
  return undefined;
}

function hasHarnessAccess(request, accessToken) {
  if (accessToken === undefined) return true;
  const headerToken = request.headers['x-forge-harness-access-token'];
  if (typeof headerToken === 'string' && accessTokenMatches(headerToken, accessToken)) return true;
  return accessTokenMatches(cookieValue(request.headers.cookie, HARNESS_ACCESS_COOKIE), accessToken);
}

function stripHarnessAccessCredentials(headers) {
  const result = { ...headers };
  delete result['x-forge-harness-access-token'];
  if (typeof result.cookie === 'string') {
    const retained = result.cookie
      .split(';')
      .map((item) => item.trim())
      .filter((item) => item && item.split('=', 1)[0] !== HARNESS_ACCESS_COOKIE);
    const sanitized = stripGatewayCookies(retained.join('; '));
    if (sanitized === undefined) delete result.cookie;
    else result.cookie = sanitized;
  }
  return result;
}

async function authorizeConversationRequest(request, accessAuthorizer) {
  const headers = {
    'content-length': '0',
    cookie: String(request.headers.cookie ?? ''),
    'x-forge-browser-host': String(request.headers.host ?? ''),
    'x-forge-browser-origin': String(request.headers.origin ?? ''),
    'x-forge-browser-sec-fetch-site': String(request.headers['sec-fetch-site'] ?? ''),
    'x-forge-project-slug': accessAuthorizer.projectSlug,
    'x-forge-taskspace-id': accessAuthorizer.taskspaceId,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), accessAuthorizer.timeoutMs ?? 2500);
  try {
    const response = accessAuthorizer.socketPath === undefined
      ? await (accessAuthorizer.fetchImpl ?? fetch)(accessAuthorizer.url, {
          method: 'POST',
          headers,
          signal: controller.signal,
        })
      : await new Promise((resolve, reject) => {
          const authorizationRequest = http.request({
            socketPath: accessAuthorizer.socketPath,
            path: '/internal/taskspace-authorize',
            method: 'POST',
            headers,
            timeout: accessAuthorizer.timeoutMs ?? 2500,
          }, (authorizationResponse) => {
            authorizationResponse.resume();
            resolve({
              status: authorizationResponse.statusCode ?? 503,
              headers: { get: (name) => authorizationResponse.headers[name.toLowerCase()] ?? null },
            });
          });
          authorizationRequest.once('timeout', () => authorizationRequest.destroy(new Error('authorization timeout')));
          authorizationRequest.once('error', reject);
          authorizationRequest.end();
        });
    const outputSessionsHeader = response.headers.get('x-forge-output-session-ids');
    let allowedSessionIds;
    if (outputSessionsHeader !== null && outputSessionsHeader !== undefined) {
      if (typeof outputSessionsHeader !== 'string' || outputSessionsHeader.length > 16_384) throw new Error('invalid output authorization');
      allowedSessionIds = JSON.parse(outputSessionsHeader);
      if (!Array.isArray(allowedSessionIds) || allowedSessionIds.some((id) => typeof id !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id))) throw new Error('invalid output authorization');
    }
    return {
      allowed: response.status === 204,
      status: response.status === 401 || response.status === 403 ? response.status : response.status === 204 ? 204 : 503,
      loginUrl: response.headers.get('x-forge-login-url') ?? accessAuthorizer.loginUrl,
      ...(allowedSessionIds === undefined ? {} : { allowedSessionIds }),
    };
  } catch {
    return { allowed: false, status: 503, loginUrl: accessAuthorizer.loginUrl };
  } finally {
    clearTimeout(timer);
  }
}

function validatedForwardPromptBody(parsed, executionInput, originalBody) {
  const rewritten = parsed.forwardBody !== undefined;
  if (originalBody === undefined) {
    if (rewritten) throw new Error('execution prepare cannot rewrite an unparsed prompt body');
    return undefined;
  }
  if (!Buffer.isBuffer(originalBody)) throw new Error('execution prepare original body is invalid');
  if (rewritten && (typeof parsed.forwardBody !== 'string'
    || Buffer.byteLength(parsed.forwardBody, 'utf8') > MAX_CLAIMABLE_PROMPT_BYTES
    || executionInput.route !== 'session.prompt'
    || executionInput.classification !== 'claimable-text')) {
    throw new Error('execution prepare forward body is invalid');
  }
  const body = rewritten ? Buffer.from(parsed.forwardBody, 'utf8') : originalBody;
  const classified = classifyPinnedDshPromptBody(body, executionInput.route);
  const same = (left, right) => (left ?? null) === (right ?? null);
  if ((rewritten && (classified.classification !== 'claimable-text'
      || !same(classified.rpcId, executionInput.rpcId)
      || !same(classified.dshSessionId, executionInput.dshSessionId)
      || !same(classified.mode, executionInput.mode)))
    || !same(classified.route, parsed.execution?.route)
    || !same(classified.classification, parsed.execution?.classification)
    || !same(classified.rpcId, parsed.execution?.rpcId)
    || !same(classified.dshSessionId, parsed.execution?.dshSessionId)
    || !same(classified.mode, parsed.execution?.mode)
    || !same(classified.bodyDigest, parsed.execution?.bodyDigest)
    || !same(classified.textDigest, parsed.execution?.textDigest)
    || !same(classified.bodyBytes, parsed.execution?.bodyBytes)) {
    throw new Error('execution prepare forward body does not match its protected execution');
  }
  return body;
}

async function readBoundedFetchJson(response) {
  if (response.body === null || typeof response.body?.getReader !== 'function') {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_EXECUTION_PREPARE_RESPONSE_BYTES) {
      throw new Error('execution prepare response exceeded limit');
    }
    return JSON.parse(bytes.toString('utf8'));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_EXECUTION_PREPARE_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('execution prepare response exceeded limit');
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function prepareConversationExecution(request, accessAuthorizer, executionInput, originalBody = undefined, signal = undefined) {
  if (accessAuthorizer === undefined) return undefined;
  const promptBody = originalBody?.toString('utf8');
  const payload = Buffer.from(JSON.stringify({
    ...executionInput,
    ...(promptBody === undefined ? {} : { promptBody }),
    requestId: crypto.randomUUID(),
  }));
  const headers = {
    'content-type': 'application/json',
    'content-length': String(payload.length),
    cookie: String(request.headers.cookie ?? ''),
    'x-forge-browser-host': String(request.headers.host ?? ''),
    'x-forge-browser-origin': String(request.headers.origin ?? ''),
    'x-forge-browser-sec-fetch-site': String(request.headers['sec-fetch-site'] ?? ''),
    'x-forge-project-slug': accessAuthorizer.projectSlug,
    'x-forge-taskspace-id': accessAuthorizer.taskspaceId,
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeoutMs = Math.max(accessAuthorizer.timeoutMs ?? 2500, EXECUTION_PREPARE_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = accessAuthorizer.socketPath === undefined
      ? await (accessAuthorizer.fetchImpl ?? fetch)(
          new URL('/internal/taskspace-execution-prepare', accessAuthorizer.url),
          { method: 'POST', headers, body: payload, signal: controller.signal },
        )
      : await new Promise((resolve, reject) => {
          const internalRequest = http.request({
            socketPath: accessAuthorizer.socketPath,
            path: '/internal/taskspace-execution-prepare',
            method: 'POST',
            headers,
            timeout: timeoutMs,
            signal: controller.signal,
          }, (internalResponse) => {
            const chunks = [];
            let bytes = 0;
            internalResponse.on('data', (chunk) => {
              bytes += chunk.length;
              if (bytes > MAX_EXECUTION_PREPARE_RESPONSE_BYTES) internalResponse.destroy(new Error('execution prepare response exceeded limit'));
              else chunks.push(chunk);
            });
            internalResponse.once('error', reject);
            internalResponse.once('end', () => resolve({
              status: internalResponse.statusCode ?? 503,
              body: Buffer.concat(chunks),
            }));
          });
          internalRequest.once('timeout', () => internalRequest.destroy(new Error('execution prepare timeout')));
          internalRequest.once('error', reject);
          internalRequest.end(payload);
        });
    const status = result.status ?? result.statusCode;
    const parsed = Buffer.isBuffer(result.body)
      ? JSON.parse(result.body.toString('utf8')) : await readBoundedFetchJson(result);
    if (status < 200 || status >= 300) {
      if (status >= 500 && parsed?.ok === false
        && [undefined, 'MANAGER_TIMEOUT', 'MANAGER_UNAVAILABLE', 'MANAGER_FAILED', 'INTERNAL_ERROR'].includes(parsed.code)
        && executionInput.route === 'session.prompt' && executionInput.classification === 'claimable-text'
        && typeof executionInput.rpcId === 'string') {
        throw new ConversationContinuationError('CONVERSATION_PREPARATION_UNAVAILABLE', status, executionInput.rpcId);
      }
      if ((status === 403 || status === 409
        || (status === 503 && parsed?.code === 'ACCEPTANCE_SOURCE_OBSERVER_UNAVAILABLE')) && parsed?.ok === false
        && Object.hasOwn(CONTINUATION_FAILURE_MESSAGES, parsed?.code)
        && (parsed.code !== 'CONVERSATION_EXECUTION_BUSY' || status === 409)
        && executionInput.route === 'session.prompt'
        && executionInput.classification === 'claimable-text'
        && typeof executionInput.rpcId === 'string' && executionInput.rpcId.length > 0) {
        throw new ConversationContinuationError(parsed.code, status, executionInput.rpcId);
      }
      throw new Error(`execution prepare returned HTTP ${status}`);
    }
    if (parsed?.ok !== true || parsed.execution?.generation < 1) throw new Error('execution prepare response is invalid');
    return validatedForwardPromptBody(parsed, executionInput, originalBody);
  } catch (error) {
    // Preparation has not dispatched the native RPC. Only this stage can
    // truthfully release the submit latch after a transport timeout/failure.
    if (!(error instanceof ConversationContinuationError)
      && (controller.signal.aborted || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(error.code)
        || error.message === 'execution prepare timeout' || error.message === 'fetch failed')
      && executionInput.route === 'session.prompt' && executionInput.classification === 'claimable-text'
      && typeof executionInput.rpcId === 'string') {
      throw new ConversationContinuationError('CONVERSATION_PREPARATION_UNAVAILABLE', 503, executionInput.rpcId);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

async function authorizeHarnessRequest(request, accessToken, accessAuthorizer) {
  if (accessAuthorizer !== undefined) return authorizeConversationRequest(request, accessAuthorizer);
  return { allowed: hasHarnessAccess(request, accessToken), status: 403 };
}

function establishHarnessAccess(request, response, parsedUrl, accessToken, trustedIngress) {
  if (parsedUrl.pathname !== '/forge-access') return false;
  if (request.method !== 'GET' || !trustedIngress || accessToken === undefined
    || !accessTokenMatches(parsedUrl.searchParams.get('token'), accessToken)) {
    rejectHttp(response);
    return true;
  }
  response.writeHead(302, {
    'cache-control': 'no-store',
    'content-length': '0',
    location: '/',
    'referrer-policy': 'no-referrer',
    'set-cookie': `${HARNESS_ACCESS_COOKIE}=${accessToken}; HttpOnly; SameSite=Strict; Path=/`,
  });
  response.end();
  return true;
}

function privilegedUpstreamHeaders(request, targetHost, targetPort) {
  const headers = { ...request.headers };
  const authority = `${targetHost}:${targetPort}`;
  headers.host = authority;
  if (headers.origin !== undefined) headers.origin = `http://${authority}`;
  if (headers.referer !== undefined) headers.referer = `http://${authority}/`;
  delete headers.forwarded;
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];
  return headers;
}

function serveProjectFileUploadAsset(response, script = projectFileUploadScript) {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(script),
    'content-type': 'text/javascript; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(script);
}

function proxyProjectFileUpload(request, response, uploadTarget, pathnameWithSearch) {
  const headers = {
    accept: request.headers.accept ?? 'application/json',
    host: `${uploadTarget.host}:${uploadTarget.port}`,
    'x-forge-upload-token': uploadTarget.token,
    'x-forwarded-for': request.socket.remoteAddress ?? 'unknown',
  };
  if (request.headers['content-type'] !== undefined) {
    headers['content-type'] = request.headers['content-type'];
  }
  if (request.headers['content-length'] !== undefined) {
    headers['content-length'] = request.headers['content-length'];
  }

  const upstreamRequest = http.request({
    host: uploadTarget.host,
    port: uploadTarget.port,
    method: request.method,
    path: pathnameWithSearch,
    headers,
  }, (upstreamResponse) => {
    const responseHeaders = {};
    for (const header of ['cache-control', 'content-length', 'content-type', 'x-content-type-options',
      'content-disposition', 'content-security-policy', 'x-content-sha256']) {
      if (upstreamResponse.headers[header] !== undefined) {
        responseHeaders[header] = upstreamResponse.headers[header];
      }
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
    upstreamResponse.pipe(response);
    upstreamResponse.on('error', (error) => response.destroy(error));
  });
  upstreamRequest.on('error', (error) => writeProxyError(response, error));
  request.on('aborted', () => upstreamRequest.destroy());
  request.pipe(upstreamRequest);
}

export function createHarnessProxy(options) {
  const {
    targetHost,
    targetPort,
    trustedAuthority,
    privilegedApiMode = 'loopback-only',
    historyPageMessages = 5,
    uploadTarget,
    accessToken,
    accessAuthorizer,
    maintenanceFencePath,
    directoryScopeReader = readHarnessDirectoryScope,
    promptQueueStatePath,
    promptQueuePollMs = 1000,
  } = options;
  // One proxy owns one TaskSpace's protected execution context. This covers
  // only ingress handoff; the existing client queue and Manager activity checks
  // continue to own waiting for model/tool completion.
  let promptIngress = null;
  const promptQueue = promptQueueStatePath === undefined ? null : createWorkpodPromptQueue({
    statePath: promptQueueStatePath, targetHost, targetPort, pollMs: promptQueuePollMs,
    classify: classifyPinnedDshPromptBody,
    authorize: request => authorizeHarnessRequest(request, accessToken, accessAuthorizer),
    prepare: (request, classified, body) => prepareConversationExecution(request, accessAuthorizer, classified, body),
    isOpen: async (ignoreIngress = false) => (ignoreIngress || promptIngress === null)
      && (await readHarnessMaintenanceFence(maintenanceFencePath)).open,
    acquire(entry) {
      if (promptIngress !== null) return null;
      const admission = { rpcId: entry.id, sessionId: entry.sessionId, state: 'inflight' };
      promptIngress = admission;
      return outcome => {
        if (promptIngress !== admission) return;
        if (outcome === 'unconfirmed') admission.state = 'unconfirmed';
        else promptIngress = null;
      };
    },
    confirmed(entry) { if (promptIngress?.rpcId === entry.id) promptIngress = null; },
  });
  // A corrupt/unavailable state file is reported by the authenticated endpoint;
  // it must never reset the queue or produce an unhandled startup rejection.
  void promptQueue?.ready.catch(() => {});

  const canonicalTrustedAuthority = parseAuthority(trustedAuthority);
  if (canonicalTrustedAuthority === undefined || canonicalTrustedAuthority !== trustedAuthority) {
    throw new Error('trusted-authority must be a canonical host:port authority');
  }
  if (!PRIVILEGED_API_MODES.has(privilegedApiMode)) {
    throw new Error(`unsupported privileged API mode: ${privilegedApiMode}`);
  }
  if (typeof maintenanceFencePath !== 'string' || !path.isAbsolute(maintenanceFencePath)) {
    throw new Error('maintenanceFencePath must be absolute');
  }
  if (
    !Number.isInteger(historyPageMessages)
    || historyPageMessages < 1
    || historyPageMessages > MAX_HISTORY_PAGE_MESSAGES
  ) {
    throw new Error(`history-page-messages must be an integer from 1 to ${MAX_HISTORY_PAGE_MESSAGES}`);
  }
  if (uploadTarget !== undefined && (
    typeof uploadTarget.host !== 'string'
    || uploadTarget.host.length === 0
    || !Number.isInteger(uploadTarget.port)
    || uploadTarget.port < 1
    || uploadTarget.port > 65535
    || typeof uploadTarget.token !== 'string'
    || uploadTarget.token.length < 32
  )) {
    throw new Error('upload target must include a host, port and token of at least 32 characters');
  }
  if (accessToken !== undefined
    && (typeof accessToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(accessToken))) {
    throw new Error('Harness access token must be 32 to 256 URL-safe characters');
  }
  if (accessToken !== undefined && accessAuthorizer !== undefined) {
    throw new Error('Harness token and conversation authorization modes are mutually exclusive');
  }
  const authorizerUsesUrl = accessAuthorizer !== undefined
    && typeof accessAuthorizer.url === 'string'
    && accessAuthorizer.url.startsWith('http://');
  const authorizerUsesSocket = accessAuthorizer !== undefined
    && typeof accessAuthorizer.socketPath === 'string'
    && path.isAbsolute(accessAuthorizer.socketPath);
  if (accessAuthorizer !== undefined && (
    authorizerUsesUrl === authorizerUsesSocket
    || typeof accessAuthorizer.projectSlug !== 'string'
    || !/^[a-z][a-z0-9-]{2,31}$/.test(accessAuthorizer.projectSlug)
    || typeof accessAuthorizer.taskspaceId !== 'string'
    || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(accessAuthorizer.taskspaceId)
    || (accessAuthorizer.loginUrl !== undefined && !/^https?:\/\//.test(accessAuthorizer.loginUrl))
  )) {
    throw new Error('conversation authorizer configuration is invalid');
  }

  const openSockets = new Set();
  const socketRequestCounts = new Map();
  const upgradeSockets = new Set();
  const socketsAcceptedDuringDrain = new WeakSet();
  let connectionDrainLatched = false;
  const outputService = createConversationOutputService({ port: targetPort, uploadTarget,
    phaseFilesContext: accessAuthorizer,
    secrets: [accessToken], intervalMs: options.outputArchiveIntervalMs ?? 30_000 });

  const beginConnectionDrain = (currentSocket) => {
    // Existing upgraded streams may carry an in-flight model response. They
    // remain counted until the client closes them; an upgrade times out rather
    // than silently killing that work. Idle keep-alive sockets can close now.
    for (const socket of openSockets) {
      if (socket !== currentSocket && !socket.destroyed
        && !upgradeSockets.has(socket)
        && (socketRequestCounts.get(socket) ?? 0) === 0) socket.destroy();
    }
  };

  const connectionDrainStatus = (currentSocket) => {
    let activeTcpConnections = 0;
    let activeHttpRequests = 0;
    let activeUpgradeConnections = 0;
    for (const socket of openSockets) {
      if (socket !== currentSocket && !socket.destroyed) activeTcpConnections += 1;
    }
    for (const [socket, count] of socketRequestCounts) {
      if (!socket.destroyed) activeHttpRequests += count;
    }
    activeHttpRequests = Math.max(0, activeHttpRequests - 1);
    for (const socket of upgradeSockets) {
      if (socket !== currentSocket && !socket.destroyed) activeUpgradeConnections += 1;
    }
    return Object.freeze({
      mode: 'connection-tracked',
      activeTcpConnections,
      activeHttpRequests,
      activeUpgradeConnections,
      drained: activeTcpConnections === 0
        && activeHttpRequests === 0
        && activeUpgradeConnections === 0,
    });
  };

  const writeMaintenanceResponse = (request, response, fence, { latch = true } = {}) => {
    if (latch) connectionDrainLatched = true;
    beginConnectionDrain(request.socket);
    const body = Buffer.from(JSON.stringify({
      ok: false,
      status: 'maintenance',
      code: 'TASKSPACE_MAINTENANCE',
      reason: fence.reason,
      state: fence.state,
      ...(fence.epoch === undefined ? {} : { epoch: fence.epoch }),
      drain: connectionDrainStatus(request.socket),
    }));
    response.writeHead(503, {
      'cache-control': 'no-store',
      connection: 'close',
      'content-length': body.length,
      'content-type': 'application/json; charset=utf-8',
      'retry-after': '5',
    });
    response.end(body);
  };

  const server = http.createServer(async (request, response) => {
    const socket = request.socket;
    openSockets.add(socket);
    socketRequestCounts.set(socket, (socketRequestCounts.get(socket) ?? 0) + 1);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      socketRequestCounts.set(socket, Math.max(0, (socketRequestCounts.get(socket) ?? 1) - 1));
    };
    response.once('finish', settle);
    response.once('close', settle);
    const parsedUrl = new URL(request.url ?? '/', 'http://harness.proxy.invalid');
    const fence = await readHarnessMaintenanceFence(maintenanceFencePath);
    if (parsedUrl.pathname === '/forge-maintenance/healthz') {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) {
        rejectHttp(response, 403, undefined, request);
      } else if (fence.open) {
        // Recovery probes must release the drain latch for future connections.
        // Sockets already accepted during maintenance stay in the rejection set.
        connectionDrainLatched = false;
        const body = Buffer.from(JSON.stringify({ ok: true, status: 'open', epoch: fence.epoch }));
        response.writeHead(200, {
          'cache-control': 'no-store',
          'content-length': body.length,
          'content-type': 'application/json; charset=utf-8',
        });
        response.end(body);
      } else {
        writeMaintenanceResponse(request, response, fence);
      }
      return;
    }
    if (fence.open && socketsAcceptedDuringDrain.has(request.socket)) {
      connectionDrainLatched = false;
      writeMaintenanceResponse(request, response, closedMaintenanceFence(
        'maintenance',
        'DRAIN_CONNECTION_REJECTED',
        fence.epoch,
      ), { latch: false });
      return;
    }
    if (!fence.open) {
      writeMaintenanceResponse(request, response, fence);
      return;
    }
    connectionDrainLatched = false;
    const method = apiMethodOf(request.url);
    const apiRequest = method !== undefined;
    const trustedIngress = isTrustedIngress(request, canonicalTrustedAuthority);
    if (establishHarnessAccess(request, response, parsedUrl, accessToken, trustedIngress)) return;
    if (!trustedIngress) {
      rejectHttp(response, 403, undefined, request);
      return;
    }
    request.pause();
    const authorization = await authorizeHarnessRequest(request, accessToken, accessAuthorizer);
    if (!authorization.allowed) {
      rejectHttp(response, authorization.status, authorization.loginUrl, request);
      return;
    }
    if (parsedUrl.pathname === '/forge-prompt-queue' || parsedUrl.pathname.startsWith('/forge-prompt-queue/')) {
      const jsonQueue = (status, value) => {
        if (response.destroyed || response.writableEnded) return;
        const body = Buffer.from(JSON.stringify(value));
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store', 'content-length': body.length }).end(body);
      };
      if (!promptQueue) {
        request.resume(); jsonQueue(503, { ok: false, message: '当前工作舱的消息队列尚未启用。' }); return;
      }
      try {
        await promptQueue.ready;
        promptQueue.attach(request);
        if (request.method === 'GET' && parsedUrl.pathname === '/forge-prompt-queue') {
          request.resume(); jsonQueue(200, { ok: true, ...(await promptQueue.snapshot()) }); return;
        }
        if (request.method !== 'POST' || !['/forge-prompt-queue', '/forge-prompt-queue/cancel', '/forge-prompt-queue/resume'].includes(parsedUrl.pathname)) {
          request.resume(); jsonQueue(405, { ok: false, message: '不支持的队列操作。' }); return;
        }
        const input = await new Promise((resolve, reject) => {
          const chunks = []; let bytes = 0;
          request.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > MAX_CLAIMABLE_PROMPT_BYTES) {
              reject(Object.assign(new Error('消息过大，尚未入队。'), { statusCode: 413 }));
            } else chunks.push(chunk);
          });
          request.once('aborted', () => reject(new Error('queue request aborted')));
          request.once('error', reject);
          request.once('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(Object.assign(new Error('消息格式无效。'), { statusCode: 400 })); }
          });
          request.resume();
        });
        if (parsedUrl.pathname === '/forge-prompt-queue') {
          const item = await promptQueue.enqueueInput(input);
          jsonQueue(202, { ok: true, queued: true, item });
        } else if (parsedUrl.pathname.endsWith('/cancel')) {
          const item = await promptQueue.cancel(input.id);
          jsonQueue(200, { ok: true, item });
        } else {
          await promptQueue.resume(input.sessionId);
          jsonQueue(200, { ok: true, ...(await promptQueue.snapshot()) });
        }
      } catch (error) {
        request.resume();
        const status = [400, 404, 409, 413].includes(error.statusCode) ? error.statusCode : 503;
        jsonQueue(status, { ok: false, code: error.code ?? 'PROMPT_QUEUE_UNAVAILABLE',
          message: status === 503 ? '队列操作暂未完成，已保存消息保留；请查看队列状态。' : error.message });
      }
      return;
    }
    if (parsedUrl.pathname === '/forge-directories') {
      request.resume();
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET', 'cache-control': 'no-store' });
        response.end();
        return;
      }
      try {
        const result = await directoryScopeReader();
        const body = Buffer.from(JSON.stringify(result));
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': body.length });
        response.end(body);
      } catch {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ ok: false, code: 'DIRECTORY_SCOPE_UNAVAILABLE' }));
      }
      return;
    }
    if ([PROJECT_FILE_UPLOAD_ASSET_PATH, CONVERSATION_OUTPUT_ASSET_PATH, DIRECTORY_SCOPE_ASSET_PATH].includes(parsedUrl.pathname)) {
      request.resume();
      if (request.method !== 'GET') rejectHttp(response);
      else serveProjectFileUploadAsset(response, parsedUrl.pathname === DIRECTORY_SCOPE_ASSET_PATH ? directoryScopeScript
        : parsedUrl.pathname === CONVERSATION_OUTPUT_ASSET_PATH ? conversationOutputScript : projectFileUploadScript);
      return;
    }
    if (parsedUrl.pathname === '/forge-output' || parsedUrl.pathname.startsWith('/forge-output/')) {
      const result = await outputService.handle(request, response, parsedUrl, authorization);
      if (result?.uploadPath) proxyProjectFileUpload(request, response, uploadTarget, result.uploadPath);
      request.resume();
      return;
    }
    if (parsedUrl.pathname === '/forge-upload' || parsedUrl.pathname.startsWith('/forge-upload/')) {
      request.resume();
      if (!trustedIngress) {
        rejectHttp(response);
        return;
      }
      if (uploadTarget === undefined) {
        jsonUnavailable(response);
        return;
      }
      // Only the server history reader may create an assistant archive. The
      // ordinary browser upload tunnel must never sign arbitrary snapshots.
      if (!['/forge-upload/config', '/forge-upload/files'].includes(parsedUrl.pathname)) {
        rejectHttp(response, 404, undefined, request);
        return;
      }
      const uploadPath = `${parsedUrl.pathname.slice('/forge-upload'.length) || '/'}${parsedUrl.search}`;
      proxyProjectFileUpload(request, response, uploadTarget, uploadPath);
      return;
    }
    if (apiRequest && !trustedIngress) {
      rejectHttp(response);
      return;
    }

    const bridgePrivilegedRequest = privilegedApiMode === 'trusted-host'
      && method !== undefined
      && PRIVILEGED_METHODS.has(method);
    const upstreamHeaders = stripHarnessAccessCredentials(bridgePrivilegedRequest
      ? privilegedUpstreamHeaders(request, targetHost, targetPort)
      : request.headers);
    upstreamHeaders['accept-encoding'] = 'identity';
    if (request.url?.split('?')[0] === '/plugins/@deepseek-ai/dsh-client-connection/client.js') {
      delete upstreamHeaders['if-none-match'];
      delete upstreamHeaders['if-modified-since'];
    }

    const forward = (body, handoff, observeResponse) => {
      const headers = { ...upstreamHeaders };
      for (const name of WORKPOD_ACTION_HEADERS) delete headers[name];
      if (body !== undefined) {
        delete headers['transfer-encoding'];
        headers['content-length'] = body.length;
      }
      proxyHarnessRequestWithStartupRetry(request, response, {
        host: targetHost,
        port: targetPort,
        method: request.method,
        path: request.url,
        headers,
      }, body, handoff, observeResponse);
    };

    const protectedPrompt = request.method === 'POST'
      && (method === 'session.prompt' || method === 'subagent.prompt');
    if (WORKPOD_ACTION_HEADERS.some(name => request.headers[name] !== undefined)
      && (!protectedPrompt || accessAuthorizer === undefined)) {
      rejectHttp(response, 400, undefined, request);
      return;
    }
    if (protectedPrompt && accessAuthorizer !== undefined) {
      const declaredLength = request.headers['content-length'];
      const parsedLength = typeof declaredLength === 'string' && /^[0-9]+$/u.test(declaredLength)
        ? Number.parseInt(declaredLength, 10) : undefined;
      if (parsedLength === undefined || !Number.isSafeInteger(parsedLength)
        || parsedLength > MAX_CLAIMABLE_PROMPT_BYTES) {
        if (WORKPOD_ACTION_HEADERS.some(name => request.headers[name] !== undefined)) {
          rejectHttp(response, 400, undefined, request);
          return;
        }
        if (promptIngress !== null) {
          rejectHttp(response, 503, undefined, request);
          return;
        }
        try {
          await prepareConversationExecution(request, accessAuthorizer, unparsedPromptAdvance(
            method,
            Number.isSafeInteger(parsedLength) ? parsedLength : 0,
            parsedLength === undefined ? 'PROMPT_LENGTH_UNAVAILABLE' : 'PROMPT_BODY_EXCEEDS_CLAIM_LIMIT',
          ));
        } catch {
          rejectHttp(response, 503, undefined, request);
          return;
        }
        // Never start a model turn after deliberately dropping its request
        // identity. Report a transport limit at ingress, not an expired lease.
        response.writeHead(413, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({
          ok: false, code: 'PROMPT_BODY_EXCEEDS_CLAIM_LIMIT',
          message: '本次消息和图片超过 32 MiB 请求上限，或请求缺少有效长度；消息未执行。这是请求大小或格式错误，不是授权过期。',
        }));
        request.resume();
        return;
      }

      const chunks = [];
      let receivedBytes = 0;
      let overflowed = false;
      request.on('data', (chunk) => {
        if (overflowed) return;
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_CLAIMABLE_PROMPT_BYTES) {
          overflowed = true;
          request.pause();
          if (promptIngress !== null) {
            rejectHttp(response, 413, undefined, request);
            request.destroy();
            return;
          }
          void prepareConversationExecution(request, accessAuthorizer, unparsedPromptAdvance(
            method,
            receivedBytes,
            'PROMPT_BODY_EXCEEDS_CLAIM_LIMIT',
          )).finally(() => {
            rejectHttp(response, 413, undefined, request);
            request.destroy();
          });
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', async () => {
        if (overflowed || response.writableEnded) return;
        const body = Buffer.concat(chunks);
        let admission;
        let dispatched = false;
        const preparation = new AbortController();
        const abortPreparation = () => { if (!dispatched) preparation.abort(); };
        response.once('close', abortPreparation);
        try {
          const classified = classifyPinnedDshPromptBody(body, method);
          let nativeRpcId = classified.rpcId ?? 'invalid-request';
          try {
            const envelope = JSON.parse(body.toString('utf8'));
            if (typeof envelope?.rpcId === 'string') nativeRpcId = envelope.rpcId;
          } catch {}
          const promptBody = body.toString('utf8');
          if (!Buffer.from(promptBody, 'utf8').equals(body)) throw new Error('prompt body is not valid UTF-8');
          const action = workpodActionBinding(request, classified);
          if (promptQueue && classified.route === 'session.prompt') {
            const snapshot = await promptQueue.list();
            const outstanding = snapshot.items.some(item => !['completed', 'failed', 'cancelled'].includes(item.status));
            if (outstanding && (classified.mode === 'queue' || snapshot.blocked?.status === 'uncertain')) {
              throw new ConversationContinuationError('CONVERSATION_EXECUTION_BUSY', 409, nativeRpcId);
            }
          }
          if (promptIngress !== null) {
            const code = promptIngress.state === 'unconfirmed'
              ? 'CONVERSATION_DISPATCH_UNCONFIRMED' : 'CONVERSATION_EXECUTION_BUSY';
            if (typeof classified.rpcId !== 'string') throw new Error('protected prompt handoff is occupied');
            throw new ConversationContinuationError(code, code === 'CONVERSATION_EXECUTION_BUSY' ? 409 : 503, classified.rpcId);
          }
          // Acquire synchronously before prepare's first await. No second
          // ingress can replace the prepared context before native admission.
          admission = { rpcId: nativeRpcId, sessionId: classified.dshSessionId, state: 'inflight' };
          promptIngress = admission;
          const observation = { targetHost, targetPort, headers: upstreamHeaders };
          await assertWorkpodActionCurrent(action, observation);
          preparation.signal.throwIfAborted();
          const forwardBody = await prepareConversationExecution(request, accessAuthorizer, classified, body, preparation.signal);
          // Recheck after protected preparation; a button must not wait through
          // another user turn and silently apply to that turn's candidate.
          // This is only freshness, never an execution or release grant.
          await assertWorkpodActionCurrent(action, observation);
          if (request.aborted || response.destroyed || preparation.signal.aborted) return;
          forward(forwardBody ?? body, { rpcId: nativeRpcId, settle(outcome) {
            if (promptIngress !== admission) return;
            if (outcome === 'unconfirmed') admission.state = 'unconfirmed';
            else promptIngress = null;
          } });
          dispatched = true;
        } catch (error) {
          if (!response.destroyed) {
            if (error instanceof WorkpodActionError) {
              const classified = classifyPinnedDshPromptBody(body, method);
              rejectWorkpodAction(response, classified.rpcId, error);
            } else if (error instanceof ConversationContinuationError) {
              if (error.code === 'CONVERSATION_EXECUTION_BUSY'
                && WORKPOD_ACTION_HEADERS.some(name => request.headers[name] !== undefined)) {
                rejectWorkpodAction(response, error.rpcId, new WorkpodActionError());
              } else rejectConversationContinuation(response, error);
            }
            else rejectHttp(response, 503, undefined, request);
          }
          return;
        } finally {
          response.off('close', abortPreparation);
          if (!dispatched && promptIngress === admission) promptIngress = null;
        }
      });
      request.resume();
      return;
    }

    if (method !== 'session.history' || request.method !== 'POST') {
      request.resume();
      forward();
      return;
    }

    const chunks = [];
    let receivedBytes = 0;
    request.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_HISTORY_REQUEST_BYTES) {
        rejectHttp(response);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (response.writableEnded) return;
      const body = capHistoryRequestBody(Buffer.concat(chunks), historyPageMessages);
      let observedAdmission, historyRpcId;
      try {
        const history = JSON.parse(body.toString('utf8'));
        if (promptIngress?.state === 'unconfirmed' && history.type === 'client-request'
          && history.method === 'session.history' && typeof history.rpcId === 'string'
          && history.payload?.sessionId === promptIngress.sessionId) {
          observedAdmission = promptIngress;
          historyRpcId = history.rpcId;
        }
      } catch {}
      forward(body, undefined, observedAdmission === undefined ? undefined : (rpc) => {
        // A durable original user event is written only after native pre-step.
        // Absence, idle status, a different session or a plugin message proves
        // nothing. Keep unknown outcomes blocked unless this positive evidence
        // lets the existing Manager activity checks safely take over.
        if (promptIngress !== observedAdmission || rpc.type !== 'server-response'
          || rpc.rpcId !== historyRpcId || rpc.result?.ok !== true
          || !Array.isArray(rpc.result.value?.events)) return;
        if (rpc.result.value.events.some(({ event }) => event?.type === 'user/message'
          && event.data?.source?.kind === 'user'
          && event.data.source.rpcId === observedAdmission.rpcId)) promptIngress = null;
      });
    });
    request.resume();
  });

  server.once('listening', () => outputService.start());
  server.once('close', () => outputService.stop());
  server.on('connection', (socket) => {
    openSockets.add(socket);
    if (!socketRequestCounts.has(socket)) socketRequestCounts.set(socket, 0);
    // A client can disappear while the HTTP parser or the asynchronous
    // conversation authorizer still owns the accepted socket.  Node does not
    // guarantee that every such socket error is consumed by the HTTP server;
    // an unhandled ETIMEDOUT previously terminated only this proxy child while
    // the DSH process (and therefore the container) stayed running.
    socket.on('error', () => {
      if (!socket.destroyed) socket.destroy();
    });
    let drainDeadline;
    if (connectionDrainLatched) {
      socketsAcceptedDuringDrain.add(socket);
      drainDeadline = setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
      }, MAINTENANCE_CONNECTION_GRACE_MS);
      drainDeadline.unref();
    }
    socket.once('close', () => {
      if (drainDeadline !== undefined) clearTimeout(drainDeadline);
      openSockets.delete(socket);
      socketRequestCounts.delete(socket);
      upgradeSockets.delete(socket);
    });
  });

  // Harness uses WebSocket upgrades for live session events. Validate the
  // public authority before preserving the original byte-stream behavior.
  server.on('close', () => { void promptQueue?.close(); });
  server.on('upgrade', (request, clientSocket, head) => {
    upgradeSockets.add(clientSocket);
    clientSocket.once('close', () => upgradeSockets.delete(clientSocket));
    clientSocket.pause();
    void readHarnessMaintenanceFence(maintenanceFencePath).then(async (fence) => {
      const acceptedDuringDrain = socketsAcceptedDuringDrain.has(clientSocket);
      if (!fence.open || acceptedDuringDrain) {
        if (!fence.open) connectionDrainLatched = true;
        beginConnectionDrain(clientSocket);
        const effectiveFence = acceptedDuringDrain && fence.open
          ? closedMaintenanceFence('maintenance', 'DRAIN_CONNECTION_REJECTED', fence.epoch)
          : fence;
        const body = Buffer.from(JSON.stringify({
          ok: false,
          status: 'maintenance',
          code: 'TASKSPACE_MAINTENANCE',
          reason: effectiveFence.reason,
          state: effectiveFence.state,
          ...(effectiveFence.epoch === undefined ? {} : { epoch: effectiveFence.epoch }),
        }));
        clientSocket.end([
          'HTTP/1.1 503 Service Unavailable',
          'Connection: close',
          'Content-Type: application/json; charset=utf-8',
          `Content-Length: ${body.length}`,
          'Retry-After: 5',
          '',
          body.toString('utf8'),
        ].join('\r\n'));
        return;
      }
      connectionDrainLatched = false;
      if (!isTrustedIngress(request, canonicalTrustedAuthority)) {
        rejectUpgrade(clientSocket);
        return;
      }
      const authorization = await authorizeHarnessRequest(request, accessToken, accessAuthorizer);
      if (!authorization.allowed) {
        rejectUpgrade(clientSocket, authorization.status);
        return;
      }
      const upstreamSocket = net.createConnection({ host: targetHost, port: targetPort });
    const closeBoth = () => {
      clientSocket.destroy();
      upstreamSocket.destroy();
    };
    clientSocket.on('error', closeBoth);
    upstreamSocket.on('error', closeBoth);

    upstreamSocket.on('connect', () => {
      const headerLines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (const [name, value] of Object.entries(request.headers)) {
        if (name === 'x-forge-harness-access-token') continue;
        if (name === 'cookie') {
          const sanitized = stripHarnessAccessCredentials({ cookie: value });
          if (sanitized.cookie !== undefined) headerLines.push(`${name}: ${sanitized.cookie}`);
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value) headerLines.push(`${name}: ${item}`);
        } else if (value !== undefined) {
          headerLines.push(`${name}: ${value}`);
        }
      }
      upstreamSocket.write(`${headerLines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
      clientSocket.resume();
    });
    }).catch(() => rejectUpgrade(clientSocket, 503));
  });

  return server;
}

function jsonUnavailable(response) {
  const body = Buffer.from(JSON.stringify({
    ok: false,
    code: 'UPLOAD_UNAVAILABLE',
    message: '项目文件上传服务暂不可用。',
  }));
  response.writeHead(503, {
    'cache-control': 'no-store',
    'content-length': body.length,
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function startFromCommandLine() {
  const [
    listenHost,
    listenPortValue,
    targetHost,
    targetPortValue,
    trustedAuthority,
    privilegedApiMode,
    historyPageMessagesValue,
  ] = process.argv.slice(2);
  const listenPort = Number.parseInt(listenPortValue, 10);
  const targetPort = Number.parseInt(targetPortValue, 10);
  const historyPageMessages = Number.parseInt(historyPageMessagesValue ?? '5', 10);
  const uploadPortValue = process.env.HARNESS_UPLOAD_PORT;
  const uploadTarget = process.env.HARNESS_UPLOAD_HOST === undefined
    && uploadPortValue === undefined
    && process.env.HARNESS_UPLOAD_TOKEN === undefined
    ? undefined
    : {
        host: process.env.HARNESS_UPLOAD_HOST,
        port: Number.parseInt(uploadPortValue ?? '', 10),
        token: process.env.HARNESS_UPLOAD_TOKEN,
      };
  const accessTokenFile = process.env.HARNESS_ACCESS_TOKEN_FILE;
  const accessMode = process.env.HARNESS_ACCESS_MODE ?? (accessTokenFile === undefined ? 'none' : 'token');
  // A token file may remain mounted for backwards-compatible TaskSpace layout,
  // but conversation mode never reads or accepts it as an authorization path.
  const accessToken = accessMode !== 'token' || accessTokenFile === undefined
    ? undefined
    : readFileSync(accessTokenFile, 'utf8').trim();
  const accessAuthorizer = accessMode !== 'conversation'
    ? undefined
    : {
        url: process.env.HARNESS_ACCESS_AUTHZ_URL,
        socketPath: process.env.HARNESS_ACCESS_AUTHZ_SOCKET,
        projectSlug: process.env.PROJECT_SLUG,
        taskspaceId: process.env.FORGE_TASKSPACE_ID,
        loginUrl: process.env.HARNESS_LOGIN_URL,
        conversationId: process.env.FORGE_TASKSPACE_CONVERSATION_ID,
      };
  if (!['none', 'token', 'conversation'].includes(accessMode)
    || (accessMode === 'token' && accessToken === undefined)
    || (accessMode === 'conversation' && accessToken !== undefined)) {
    console.error('Harness access mode configuration is invalid.');
    process.exit(2);
  }

  if (
    !listenHost
    || !targetHost
    || !Number.isInteger(listenPort)
    || !Number.isInteger(targetPort)
    || !trustedAuthority
  ) {
    console.error('Usage: tcp-proxy.mjs <listen-host> <listen-port> <target-host> <target-port> <trusted-authority> [loopback-only|trusted-host] [history-page-messages]');
    process.exit(2);
  }

  let server;
  try {
    server = createHarnessProxy({
      targetHost,
      targetPort,
      trustedAuthority,
      privilegedApiMode: privilegedApiMode ?? 'loopback-only',
      historyPageMessages,
      uploadTarget,
      accessToken,
      accessAuthorizer,
      maintenanceFencePath: process.env.HARNESS_MAINTENANCE_FENCE_FILE,
      ...(accessMode === 'conversation' ? {
        promptQueueStatePath: path.join(process.env.DSH_HOME ?? '/home/node/.dsh', 'forge-message-queue', 'state.json'),
      } : {}),
    });
  } catch (error) {
    console.error(`Harness HTTP compatibility proxy configuration failed: ${error.message}`);
    process.exit(2);
  }

  server.on('error', (error) => {
    console.error(`Harness HTTP compatibility proxy failed: ${error.message}`);
    process.exit(1);
  });
  server.listen(listenPort, listenHost, () => {
    console.log(
      `Harness HTTP compatibility proxy listening on ${listenHost}:${listenPort}; access mode=${accessMode}; privileged API mode=${privilegedApiMode ?? 'loopback-only'}; history page messages=${historyPageMessages}; project upload=${uploadTarget === undefined ? 'disabled' : 'enabled'}`,
    );
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  startFromCommandLine();
}
