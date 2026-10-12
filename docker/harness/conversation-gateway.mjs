import crypto from 'node:crypto';
import { publicReleaseOperation } from './project-release-status.mjs';
import { deliveryResponse, DeliveryCenterError } from './delivery-center-http.mjs';
import { createDeliveryCenterClient } from './delivery-center-service.mjs';
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONVERSATION_STATE_SCHEMA_VERSION,
  CSRF_COOKIE,
  PREAUTH_COOKIE,
  ROLES,
  SESSION_COOKIE,
  can,
  cookieValue,
  hashPassword,
  newTaskId,
  normalizeConversationTitle,
  normalizeDisplayName,
  normalizeUsername,
  publicConversation,
  publicUser,
  randomToken,
  timingSafeTextEqual,
  tokenHash,
  validateConversationId,
  validateIdempotencyKey,
  validatePassword,
  validateRole,
  verifyPassword,
} from './conversation-policy.mjs';
import { RegistryProjectDirectory } from './project-directory.mjs';
import {
  MAX_CLAIMABLE_PROMPT_BYTES,
  classifyPinnedDshPromptBody,
} from './forge-execution-context.mjs';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_MANAGER_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EXECUTION_PREPARE_BYTES = (4 * MAX_CLAIMABLE_PROMPT_BYTES) + (64 * 1024);
const MAX_EXECUTION_PROMPT_BYTES = 1024 * 1024;
const MAX_EXECUTION_SOURCE_BODY_BYTES = 512 * 1024 * 1024;
const EXECUTION_PROMPT_ROUTES = new Set(['session.prompt', 'subagent.prompt']);
const EXECUTION_CLASSIFICATIONS = new Set([
  'claimable-text',
  'read-only-image',
  'read-only-oversized',
  'read-only-subagent',
  'read-only-unknown',
]);
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const PREAUTH_MAX_AGE_SECONDS = 10 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const SESSION_COOKIE_MAX_AGE_SECONDS = Math.floor(SESSION_ABSOLUTE_MS / 1000);
const MAINTENANCE_FENCE_SCHEMA_VERSION = 1;
const MAINTENANCE_FENCE_MAX_BYTES = 4096;
const MAINTENANCE_FENCE_EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAINTENANCE_CONNECTION_GRACE_MS = 250;
const STATIC_FILES = Object.freeze({
  '/forge-gateway/assets/gateway.css': ['gateway.css', 'text/css; charset=utf-8'],
  '/forge-gateway/assets/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/forge-gateway/assets/change-password.js': ['change-password.js', 'text/javascript; charset=utf-8'],
  '/forge-gateway/assets/gateway.js': ['gateway.js', 'text/javascript; charset=utf-8'],
  '/forge-gateway/assets/delivery-center.js': ['delivery-center.js', 'text/javascript; charset=utf-8'],
  '/forge-gateway/assets/delivery-center-views.js': ['delivery-center-views.js', 'text/javascript; charset=utf-8'],
  '/forge-gateway/assets/delivery-center.css': ['delivery-center.css', 'text/css; charset=utf-8'],
  '/forge-gateway/assets/platform-value.js': ['platform-value.js', 'text/javascript; charset=utf-8'],
  '/forge-gateway/assets/platform-value.css': ['platform-value.css', 'text/css; charset=utf-8'],
  '/forge-gateway/assets/platform-catalog.json': ['platform-catalog.json', 'application/json; charset=utf-8'],
  '/forge-gateway/assets/platform-updates.json': ['platform-updates.json', 'application/json; charset=utf-8'],
});
const PAGE_FILES = Object.freeze({
  '/forge-gateway/login': 'login.html',
  '/forge-gateway/change-password': 'change-password.html',
  '/forge-gateway/forbidden': 'forbidden.html',
  '/forge-gateway/': 'index.html',
  '/forge-gateway/delivery-center': 'delivery-center.html',
  '/forge-gateway/platform-value': 'platform-value.html',
});
const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
});

class GatewayError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function isoNow(clock) {
  return new Date(clock()).toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function closedMaintenanceFence(state, reason, epoch = undefined) {
  return Object.freeze({ open: false, state, reason, ...(epoch === undefined ? {} : { epoch }) });
}

/**
 * Read the host-owned maintenance fence for every request. The mounted parent
 * directory, rather than this file, must be bind-mounted so an atomic rename on
 * the host becomes visible inside the container.
 */
export async function readConversationGatewayMaintenanceFence(fencePath) {
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

function validateState(state) {
  if (state?.schemaVersion !== CONVERSATION_STATE_SCHEMA_VERSION
    || !Number.isInteger(state.revision)
    || !Array.isArray(state.users)
    || !Array.isArray(state.sessions)
    || !Array.isArray(state.conversations)
    || !Array.isArray(state.idempotency)
    || !Array.isArray(state.memberships)) {
    throw new Error('Conversation gateway state is invalid or unsupported.');
  }
}

function upgradeState(state, defaultProjectSlug) {
  if (state?.schemaVersion !== 1) return state;
  if (typeof defaultProjectSlug !== 'string' || !/^[a-z][a-z0-9-]{2,31}$/.test(defaultProjectSlug)) {
    throw new Error('A default project slug is required to upgrade conversation state schema v1.');
  }
  if (!Array.isArray(state.users) || !Array.isArray(state.sessions)
    || !Array.isArray(state.conversations) || !Array.isArray(state.idempotency)) {
    throw new Error('Conversation gateway state schema v1 is invalid.');
  }
  return {
    ...state,
    schemaVersion: CONVERSATION_STATE_SCHEMA_VERSION,
    memberships: state.users.map((user) => ({
      userId: user.id,
      projectSlug: defaultProjectSlug,
      access: user.role === 'auditor' ? 'audit' : 'member',
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })),
    conversations: state.conversations.map((conversation) => ({
      ...conversation,
      projectSlug: defaultProjectSlug,
    })),
    idempotency: state.idempotency.map((entry) => ({
      ...entry,
      projectSlug: defaultProjectSlug,
    })),
  };
}

export class ConversationStateStore {
  constructor({ stateRoot, clock = Date.now }) {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
      throw new Error('stateRoot must be an absolute path');
    }
    this.stateRoot = stateRoot;
    this.statePath = path.join(stateRoot, 'state.json');
    this.auditPath = path.join(stateRoot, 'audit.jsonl');
    this.bootstrapPath = path.join(stateRoot, 'bootstrap-admin-password');
    this.clock = clock;
    this.state = undefined;
    this.queue = Promise.resolve();
    this.auditQueue = Promise.resolve();
  }

  async initialize({ bootstrapUsername = 'admin', bootstrapDisplayName = '平台管理员', defaultProjectSlug = undefined } = {}) {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    await chmod(this.stateRoot, 0o700).catch(() => {});
    try {
      const raw = await readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw);
      const state = upgradeState(parsed, defaultProjectSlug);
      validateState(state);
      this.state = state;
      if (state !== parsed) await this.#persist(state);
      await chmod(this.statePath, 0o600).catch(() => {});
      return { bootstrapCreated: false };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const username = normalizeUsername(bootstrapUsername);
    const displayName = normalizeDisplayName(bootstrapDisplayName);
    const temporaryPassword = randomToken(24);
    const passwordHash = await hashPassword(temporaryPassword);
    const now = isoNow(this.clock);
    const user = {
      id: crypto.randomUUID(),
      username,
      displayName,
      role: 'admin',
      status: 'active',
      passwordHash,
      mustChangePassword: true,
      sessionVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.state = {
      schemaVersion: CONVERSATION_STATE_SCHEMA_VERSION,
      revision: 1,
      users: [user],
      sessions: [],
      conversations: [],
      idempotency: [],
      memberships: [],
    };
    await this.#persist(this.state);
    const bootstrapText = [
      'Forge Conversation Gateway one-time administrator credential',
      `username=${username}`,
      `password=${temporaryPassword}`,
      'The gateway removes this file after the administrator changes the password.',
      '',
    ].join('\n');
    await writeFile(this.bootstrapPath, bootstrapText, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { bootstrapCreated: true, username };
  }

  async #persist(state) {
    validateState(state);
    const temporary = `${this.statePath}.tmp.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.statePath);
    await chmod(this.statePath, 0o600).catch(() => {});
  }

  async read(reader = (value) => value) {
    if (this.state === undefined) throw new Error('Conversation state is not initialized.');
    await this.queue.catch(() => {});
    return reader(clone(this.state));
  }

  async mutate(mutator) {
    const operation = async () => {
      if (this.state === undefined) throw new Error('Conversation state is not initialized.');
      const draft = clone(this.state);
      this.#purgeExpired(draft);
      const result = await mutator(draft);
      draft.revision += 1;
      await this.#persist(draft);
      this.state = draft;
      return result;
    };
    const pending = this.queue.then(operation, operation);
    this.queue = pending.catch(() => {});
    return pending;
  }

  #purgeExpired(state) {
    const now = this.clock();
    state.sessions = state.sessions.filter((session) => (
      Date.parse(session.absoluteExpiresAt) > now
      && Date.parse(session.lastSeenAt) + SESSION_IDLE_MS > now
    ));
    state.idempotency = state.idempotency.filter((entry) => (
      Date.parse(entry.createdAt) + IDEMPOTENCY_RETENTION_MS > now
    ));
  }

  async appendAudit(entry) {
    const operation = async () => {
      const line = `${JSON.stringify({ at: isoNow(this.clock), ...entry })}\n`;
      await appendFile(this.auditPath, line, { encoding: 'utf8', mode: 0o600 });
      await chmod(this.auditPath, 0o600).catch(() => {});
    };
    const pending = this.auditQueue.then(operation, operation);
    this.auditQueue = pending.catch(() => {});
    return pending;
  }

  async readAudit(limit = 100) {
    const boundedLimit = Math.min(Math.max(Number.parseInt(String(limit), 10) || 100, 1), 500);
    let raw;
    try {
      const information = await stat(this.auditPath);
      const maximumBytes = 4 * 1024 * 1024;
      if (information.size <= maximumBytes) raw = await readFile(this.auditPath, 'utf8');
      else {
        const handle = await import('node:fs/promises').then(({ open }) => open(this.auditPath, 'r'));
        try {
          const buffer = Buffer.alloc(maximumBytes);
          await handle.read(buffer, 0, maximumBytes, information.size - maximumBytes);
          raw = buffer.toString('utf8');
          raw = raw.slice(raw.indexOf('\n') + 1);
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .slice(-boundedLimit)
      .reverse()
      .map((line) => {
        try { return JSON.parse(line); } catch { return undefined; }
      })
      .filter(Boolean);
  }

  async removeBootstrapCredential() {
    await unlink(this.bootstrapPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function responseHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function json(response, status, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, responseHeaders({
    'cache-control': 'no-store',
    'content-length': body.length,
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  }));
  response.end(body);
}

function empty(response, status, extraHeaders = {}) {
  response.writeHead(status, responseHeaders({
    'cache-control': 'no-store',
    'content-length': '0',
    ...extraHeaders,
  }));
  response.end();
}

function redirect(response, location, cookies = undefined) {
  empty(response, 302, {
    location,
    ...(cookies === undefined ? {} : { 'set-cookie': cookies }),
  });
}

async function readJson(request, maxBytes = MAX_REQUEST_BYTES) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > maxBytes) throw new GatewayError('REQUEST_TOO_LARGE', '请求体超过限制。', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GatewayError('INVALID_JSON', '请求体不是合法 JSON。', 400);
  }
}

function validateExecutionPrepareIngress(value) {
  const allowed = new Set([
    'schemaVersion', 'route', 'classification', 'rpcId', 'dshSessionId', 'mode',
    'bodyDigest', 'textDigest', 'promptText', 'promptBody', 'bodyBytes', 'imageCount', 'reason', 'requestId',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new GatewayError('INVALID_EXECUTION_PREPARE', '受保护执行准备请求字段不合法。', 400);
  }
  const bounded = (name, minimum, maximum, pattern = undefined, required = false) => {
    const field = value[name];
    if (field === undefined && !required) return undefined;
    if (typeof field !== 'string' || field.length < minimum || field.length > maximum
      || (pattern !== undefined && !pattern.test(field))) {
      throw new GatewayError('INVALID_EXECUTION_PREPARE', `受保护执行准备字段 ${name} 不合法。`, 400);
    }
    return field;
  };
  if (value.schemaVersion !== 1
    || !Number.isSafeInteger(value.bodyBytes)
    || value.bodyBytes < 0
    || value.bodyBytes > MAX_EXECUTION_SOURCE_BODY_BYTES) {
    throw new GatewayError('INVALID_EXECUTION_PREPARE', '受保护执行准备请求版本或字节数不合法。', 400);
  }
  const promptText = bounded('promptText', 0, MAX_EXECUTION_PROMPT_BYTES);
  if (promptText !== undefined && Buffer.byteLength(promptText, 'utf8') > MAX_EXECUTION_PROMPT_BYTES) {
    throw new GatewayError('INVALID_EXECUTION_PREPARE', '受保护执行准备文本超过限制。', 400);
  }
  const result = {
    schemaVersion: 1,
    route: bounded('route', 1, 256, /^[^\u0000-\u001f\u007f]+$/u, true),
    classification: bounded('classification', 1, 64, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, true),
    bodyBytes: value.bodyBytes,
    requestId: bounded('requestId', 8, 128, /^[A-Za-z0-9._:-]+$/u, true),
  };
  if (!EXECUTION_PROMPT_ROUTES.has(result.route)
    || !EXECUTION_CLASSIFICATIONS.has(result.classification)) {
    throw new GatewayError('INVALID_EXECUTION_PREPARE', '受保护执行准备路由或分类不合法。', 400);
  }
  const rpcId = bounded('rpcId', 1, 256, /^[^\0\r\n]+$/u);
  if (rpcId !== undefined) result.rpcId = rpcId;
  const dshSessionId = bounded('dshSessionId', 1, 1024, /^[^\0\r\n]+$/u);
  if (dshSessionId !== undefined) result.dshSessionId = dshSessionId;
  const mode = bounded('mode', 1, 64, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
  if (mode !== undefined) result.mode = mode;
  for (const name of ['bodyDigest', 'textDigest']) {
    const field = bounded(name, 64, 64, /^[0-9a-f]{64}$/u);
    if (field !== undefined) result[name] = field;
  }
  if (promptText !== undefined) result.promptText = promptText;
  if (value.imageCount !== undefined) {
    if (!Number.isSafeInteger(value.imageCount) || value.imageCount < 0 || value.imageCount > 20) {
      throw new GatewayError('INVALID_EXECUTION_PREPARE', '受保护执行准备图片计数不合法。', 400);
    }
    result.imageCount = value.imageCount;
  }
  const reason = bounded('reason', 1, 512, /^[^\u0000-\u001f\u007f]+$/u);
  if (reason !== undefined) result.reason = reason;
  if (value.promptBody !== undefined) {
    if (typeof value.promptBody !== 'string'
      || Buffer.byteLength(value.promptBody, 'utf8') > MAX_CLAIMABLE_PROMPT_BYTES) {
      throw new GatewayError('INVALID_EXECUTION_PREPARE', '受保护执行原始请求体不合法。', 400);
    }
    const promptBody = Buffer.from(value.promptBody, 'utf8');
    const classified = classifyPinnedDshPromptBody(promptBody, result.route);
    const compared = [
      'schemaVersion', 'route', 'classification', 'rpcId', 'dshSessionId', 'mode',
      'bodyDigest', 'textDigest', 'promptText', 'bodyBytes', 'imageCount', 'reason',
    ];
    if (compared.some((name) => classified[name] !== result[name])) {
      throw new GatewayError('INVALID_EXECUTION_PREPARE', '受保护执行原始请求体与分类结果不一致。', 400);
    }
    result.promptBody = value.promptBody;
  }
  return result;
}

function buildCookie(name, value, { maxAge, secure }) {
  return [
    `${name}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
    ...(maxAge === undefined ? [] : [`Max-Age=${maxAge}`]),
  ].join('; ');
}

function clearCookies(secure) {
  return [
    buildCookie(SESSION_COOKIE, 'deleted', { maxAge: 0, secure }),
    buildCookie(CSRF_COOKIE, 'deleted', { maxAge: 0, secure }),
  ];
}

function newSession(user, clock) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const nowMs = clock();
  const now = new Date(nowMs).toISOString();
  return {
    token,
    csrf,
    record: {
      tokenHash: tokenHash(token),
      csrfHash: tokenHash(csrf),
      userId: user.id,
      sessionVersion: user.sessionVersion,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(nowMs + SESSION_ABSOLUTE_MS).toISOString(),
    },
  };
}

function sessionCookies(session, secure) {
  return [
    buildCookie(SESSION_COOKIE, session.token, { maxAge: SESSION_COOKIE_MAX_AGE_SECONDS, secure }),
    buildCookie(CSRF_COOKIE, session.csrf, { maxAge: SESSION_COOKIE_MAX_AGE_SECONDS, secure }),
  ];
}

function remoteAddressOf(request) {
  return String(request.socket.remoteAddress ?? 'unknown').slice(0, 128);
}

function requestIdOf(request) {
  const header = request.headers['x-request-id'];
  return typeof header === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(header)
    ? header
    : crypto.randomUUID();
}

function requestIsSameOrigin(request, publicOrigin, publicAuthority, requireOrigin) {
  if (request.headers.host !== publicAuthority || request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return !requireOrigin;
  return typeof origin === 'string' && origin === publicOrigin;
}

function ensurePermission(user, permission) {
  if (!can(user.role, permission)) {
    throw new GatewayError('FORBIDDEN', '当前角色没有执行此操作的权限。', 403);
  }
}

function validateInput(validator, value, code = 'INVALID_INPUT') {
  try {
    return validator(value);
  } catch (error) {
    throw new GatewayError(code, error.message, 400);
  }
}

function managerError(error) {
  if (error instanceof GatewayError) return error;
  return new GatewayError('MANAGER_UNAVAILABLE', '独立工作舱管理服务暂不可用，请稍后重试。', 503);
}

function safeManagerFailureDetails(value) {
  if (value?.code !== 'CONTROL_FAILED' || value.details === null || typeof value.details !== 'object') {
    return undefined;
  }
  const reasonCode = typeof value.details.reasonCode === 'string'
    && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value.details.reasonCode)
    ? value.details.reasonCode
    : undefined;
  if (reasonCode === undefined) return undefined;
  const requestId = typeof value.details.requestId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.details.requestId)
    ? value.details.requestId
    : undefined;
  const exitCode = Number.isSafeInteger(value.details.exitCode)
    && value.details.exitCode >= 0 && value.details.exitCode <= 255
    ? value.details.exitCode
    : undefined;
  const signal = typeof value.details.signal === 'string' && /^SIG[A-Z0-9]+$/u.test(value.details.signal)
    ? value.details.signal
    : undefined;
  return {
    reasonCode,
    ...(requestId === undefined ? {} : { requestId }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function requireManagedTaskspaceIdentity(taskspace, conversation, user) {
  const isLegacyIdentity = taskspace?.schemaVersion === 1
    && taskspace.protectedExecutionEligible === false
    && taskspace.taskId === conversation.taskId
    && taskspace.actorId === user.username
    && taskspace.actorUserId === null
    && taskspace.accessMode === 'conversation';
  if (isLegacyIdentity) {
    if (conversation.conversationKind === 'legacy-session'
      || conversation.conversationKind === 'legacy-archive') return taskspace;
    if (conversation.ownerUserId === user.id
      && taskspace.conversationId === conversation.id) return taskspace;
  }
  const expectedProtectedExecutionEligibility = taskspace?.status === 'active';
  if (taskspace?.schemaVersion !== 2
    || taskspace.protectedExecutionEligible !== expectedProtectedExecutionEligibility
    || taskspace.taskId !== conversation.taskId
    || taskspace.actorId !== user.username
    || taskspace.actorUserId !== user.id
    || taskspace.conversationId !== conversation.id
    || taskspace.accessMode !== 'conversation') {
    throw new GatewayError(
      'TASKSPACE_IDENTITY_CONFLICT',
      '独立工作舱返回的人员或对话身份不一致。',
      502,
    );
  }
  return taskspace;
}

function requireManagedTaskspaceStatus(taskspace, allowedStatuses) {
  if (!allowedStatuses.includes(taskspace?.status)) {
    throw new GatewayError(
      'TASKSPACE_STATUS_INVALID',
      '独立工作舱未达到请求所需的运行状态。',
      502,
    );
  }
  return taskspace;
}

export function createManagerClient({ baseUrl = undefined, socketPath = undefined, token, timeoutMs = 120000, fetchImpl = fetch }) {
  const usesHttp = typeof baseUrl === 'string' && baseUrl.startsWith('http://');
  const usesSocket = typeof socketPath === 'string' && path.isAbsolute(socketPath);
  if (usesHttp === usesSocket) throw new Error('manager transport must use exactly one HTTP baseUrl or Unix socketPath');
  if (typeof token !== 'string' || token.length < 32) throw new Error('manager token is invalid');
  const call = async (method, pathname, body = undefined, maxResponseBytes = MAX_MANAGER_RESPONSE_BYTES, signal = undefined) => {
    signal?.throwIfAborted();
    if (usesSocket) {
      return new Promise((resolve, reject) => {
        const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const request = http.request({
          socketPath,
          path: pathname,
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            ...(encoded === undefined ? {} : {
              'content-type': 'application/json',
              'content-length': encoded.length,
            }),
          },
          timeout: timeoutMs,
          signal,
        }, (response) => {
          const chunks = [];
          let received = 0;
          response.on('data', (chunk) => {
            received += chunk.length;
            if (received <= maxResponseBytes) chunks.push(chunk);
          });
          response.on('end', () => {
            let value = {};
            try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
            if (received > maxResponseBytes) {
              reject(new GatewayError('MANAGER_RESPONSE_TOO_LARGE', '独立工作舱管理服务响应超过限制。', 502));
            } else if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
              reject(new GatewayError(
                value.code ?? 'MANAGER_FAILED',
                value.message ?? '独立工作舱管理失败。',
                response.statusCode >= 400 && response.statusCode < 600 ? response.statusCode : 502,
                safeManagerFailureDetails(value),
              ));
            } else resolve(value);
          });
        });
        request.once('timeout', () => request.destroy(new GatewayError('MANAGER_TIMEOUT', '独立工作舱管理服务响应超时。', 504)));
        request.once('error', reject);
        request.end(encoded);
      });
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(pathname, baseUrl), {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const value = await response.json().catch(() => ({}));
      signal?.throwIfAborted();
      if (!response.ok) throw new GatewayError(
        value.code ?? 'MANAGER_FAILED',
        value.message ?? '独立工作舱管理失败。',
        response.status >= 400 && response.status < 600 ? response.status : 502,
        safeManagerFailureDetails(value),
      );
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      if (controller.signal.aborted) throw new GatewayError('MANAGER_TIMEOUT', '独立工作舱管理服务响应超时。', 504);
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  };
  return {
    health: () => call('GET', '/healthz'),
    create: (value) => call('POST', '/v1/taskspaces', value),
    releaseStatus: () => call('GET', '/v1/project-release-status'),
    status: (taskId) => call('GET', `/v1/taskspaces/${encodeURIComponent(taskId)}`),
    start: (taskId) => call('POST', `/v1/taskspaces/${encodeURIComponent(taskId)}/start`, {}),
    stop: (taskId) => call('POST', `/v1/taskspaces/${encodeURIComponent(taskId)}/stop`, {}),
    materials: ({ includeIntake = false, offset = 0, limit = 200 } = {}) => {
      const query = new URLSearchParams({
        includeIntake: String(includeIntake),
        offset: String(offset),
        limit: String(limit),
      });
      return call('GET', `/v1/materials?${query}`);
    },
    promoteMaterial: (value) => call('POST', '/v1/materials/promote', value),
    prepareExecution: (value, { signal } = {}) => call(
      'POST',
      `/v1/taskspaces/${encodeURIComponent(value.taskId)}/executions/prepare`,
      value,
      MAX_MANAGER_RESPONSE_BYTES,
      signal,
    ),
    roleDecision: value => call('POST', `/v1/taskspaces/${encodeURIComponent(value.taskId)}/role-decisions`, value),
    outputs: (taskId, query = '') => call('GET', `/v1/taskspaces/${encodeURIComponent(taskId)}/outputs${query}`),
    phaseOutputs: (taskId, query = '') => call('GET', `/v1/taskspaces/${encodeURIComponent(taskId)}/phase-outputs${query}`),
    phaseOutput: (taskId, packageId, name) => call('GET',
      `/v1/taskspaces/${encodeURIComponent(taskId)}/phase-outputs/${encodeURIComponent(packageId)}/${encodeURIComponent(name)}`),
    output: (taskId, sessionId, snapshotId, name) => call('GET',
      `/v1/taskspaces/${encodeURIComponent(taskId)}/outputs/${encodeURIComponent(sessionId)}/${encodeURIComponent(snapshotId)}/${encodeURIComponent(name)}`,
      undefined, 70 * 1024 * 1024),
  };
}

export function isExecutionRenewalAuthorityRequest(value) {
  const keys = ['schemaVersion', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'contractId', 'actionCeiling'];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
    && value.schemaVersion === 1
    && keys.slice(1).every((key) => typeof value[key] === 'string')
    && /^[a-z0-9][a-z0-9-]{1,47}$/u.test(value.projectSlug)
    && /^[a-z0-9][a-z0-9-]{1,47}$/u.test(value.taskId)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.actorUserId)
    && /^[a-z0-9][a-z0-9._-]{1,63}$/u.test(value.actorUsername)
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(value.conversationId)
    && value.rpcId.length <= 256
    && ['dshSessionId', 'rpcId'].every((key) => typeof value[key] === 'string'
      && value[key].length > 0 && value[key].length <= 1024 && !/[\0\r\n]/u.test(value[key]))
    && /^[0-9a-f]{64}$/u.test(value.contractId)
    && ['workspace-write', 'git-checkpoint', 'release'].includes(value.actionCeiling);
}

export async function createConversationGateway(options) {
  const {
    store,
    deliveryStore,
    manager,
    managerForProject,
    managerTokenForProject = async (slug) => {
      if (typeof projectDirectory?.capabilityPaths !== 'function') throw new Error('Project capability is unavailable');
      return (await readFile(projectDirectory.capabilityPaths(slug).tokenPath, 'utf8')).trim();
    },
    projectDirectory,
    staticRoot,
    publicOrigin,
    bindAddress,
    projectSlug,
    maintenanceFencePath,
    cookieSecure = false,
    operatorToken,
    clock = Date.now,
  } = options;
  if (!(store instanceof ConversationStateStore)) throw new Error('store must be a ConversationStateStore');
  if (typeof staticRoot !== 'string' || !path.isAbsolute(staticRoot)) throw new Error('staticRoot must be absolute');
  if (typeof maintenanceFencePath !== 'string' || !path.isAbsolute(maintenanceFencePath)) {
    throw new Error('maintenanceFencePath must be absolute');
  }
  const parsedOrigin = new URL(publicOrigin);
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.pathname !== '/') {
    throw new Error('publicOrigin must be an HTTP(S) origin');
  }
  const canonicalPublicOrigin = parsedOrigin.origin;
  const publicAuthority = parsedOrigin.host;
  if (parsedOrigin.hostname !== bindAddress) throw new Error('publicOrigin host must match bindAddress');
  const legacyProject = typeof projectSlug === 'string' && /^[a-z][a-z0-9-]{2,31}$/.test(projectSlug)
    ? Object.freeze({ slug: projectSlug, displayName: projectSlug, uiPort: null, projectKind: 'delivery' })
    : undefined;
  if (projectDirectory === undefined && legacyProject === undefined) {
    throw new Error('projectDirectory or a legacy projectSlug is required');
  }
  if (projectDirectory !== undefined
    && (typeof projectDirectory.list !== 'function' || typeof projectDirectory.get !== 'function')) {
    throw new Error('projectDirectory is invalid');
  }
  if (managerForProject === undefined && manager === undefined) {
    throw new Error('managerForProject or a legacy manager is required');
  }
  if (typeof operatorToken !== 'string' || operatorToken.length < 32) {
    throw new Error('operatorToken is invalid');
  }

  const dummyPasswordHash = await hashPassword(randomToken(24));
  const loginFailures = new Map();
  const deniedAuditCooldown = new Map();
  const openSockets = new Set();
  const socketRequestCounts = new Map();
  const upgradeSockets = new Set();
  const socketsAcceptedDuringDrain = new WeakSet();
  let connectionDrainLatched = false;

  const trackServer = (server) => {
    server.on('connection', (socket) => {
      openSockets.add(socket);
      socketRequestCounts.set(socket, 0);
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
    server.on('upgrade', (request, socket) => {
      upgradeSockets.add(socket);
      socket.once('close', () => upgradeSockets.delete(socket));
      void readConversationGatewayMaintenanceFence(maintenanceFencePath).then((fence) => {
        const acceptedDuringDrain = socketsAcceptedDuringDrain.has(socket);
        if (fence.open) connectionDrainLatched = false;
        else {
          connectionDrainLatched = true;
          beginConnectionDrain(socket);
        }
        const rejectedForDrain = !fence.open || acceptedDuringDrain;
        const status = rejectedForDrain ? 503 : 426;
        const value = !rejectedForDrain
          ? { ok: false, code: 'UPGRADE_NOT_SUPPORTED' }
          : {
              ok: false,
              status: 'maintenance',
              code: 'GATEWAY_MAINTENANCE',
              reason: acceptedDuringDrain && fence.open ? 'DRAIN_CONNECTION_REJECTED' : fence.reason,
              state: acceptedDuringDrain && fence.open ? 'maintenance' : fence.state,
              ...(fence.epoch === undefined ? {} : { epoch: fence.epoch }),
            };
        const body = Buffer.from(JSON.stringify(value));
        socket.end([
          `HTTP/1.1 ${status} ${status === 426 ? 'Upgrade Required' : 'Service Unavailable'}`,
          'Connection: close',
          'Content-Type: application/json; charset=utf-8',
          `Content-Length: ${body.length}`,
          ...(fence.open ? [] : ['Retry-After: 5']),
          '',
          body.toString('utf8'),
        ].join('\r\n'));
      }).catch(() => socket.destroy());
    });
    return server;
  };

  const trackRequests = (handler) => async (request, response) => {
    const socket = request.socket;
    openSockets.add(socket);
    socketRequestCounts.set(socket, (socketRequestCounts.get(socket) ?? 0) + 1);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      const remaining = Math.max(0, (socketRequestCounts.get(socket) ?? 1) - 1);
      socketRequestCounts.set(socket, remaining);
    };
    response.once('finish', settle);
    response.once('close', settle);
    await handler(request, response);
    if (response.writableEnded) settle();
  };

  const beginConnectionDrain = (currentSocket) => {
    for (const socket of upgradeSockets) {
      if (socket !== currentSocket && !socket.destroyed) socket.destroy();
    }
    for (const socket of openSockets) {
      if (socket !== currentSocket && !socket.destroyed
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

  const destroyTrackedConnections = () => {
    for (const socket of upgradeSockets) {
      if (!socket.destroyed) socket.destroy();
    }
    for (const socket of openSockets) {
      if (!socket.destroyed) socket.destroy();
    }
  };

  const directory = projectDirectory ?? {
    list: async () => [legacyProject],
    get: async (slug) => slug === legacyProject.slug ? legacyProject : undefined,
  };
  const resolveManager = managerForProject ?? (async (slug) => {
    if (slug !== legacyProject.slug) throw new GatewayError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    return manager;
  });
  const audit = (entry) => store.appendAudit({
    projectSlug: entry.projectSlug ?? projectSlug ?? 'platform',
    ...entry,
  });

  const maintenanceResponse = (request, response, fence, { latch = true } = {}) => {
    if (latch) connectionDrainLatched = true;
    beginConnectionDrain(request.socket);
    json(response, 503, {
      ok: false,
      status: 'maintenance',
      code: 'GATEWAY_MAINTENANCE',
      reason: fence.reason,
      state: fence.state,
      ...(fence.epoch === undefined ? {} : { epoch: fence.epoch }),
      drain: connectionDrainStatus(request.socket),
    }, { connection: 'close', 'retry-after': '5' });
  };

  const admitRequest = async (request, response) => {
    const fence = await readConversationGatewayMaintenanceFence(maintenanceFencePath);
    if (fence.open && socketsAcceptedDuringDrain.has(request.socket)) {
      connectionDrainLatched = false;
      maintenanceResponse(request, response, closedMaintenanceFence(
        'maintenance',
        'DRAIN_CONNECTION_REJECTED',
        fence.epoch,
      ), { latch: false });
      return undefined;
    }
    if (!fence.open) {
      maintenanceResponse(request, response, fence);
      return undefined;
    }
    connectionDrainLatched = false;
    return fence;
  };

  const health = async (request, response) => {
    const fence = await admitRequest(request, response);
    if (fence !== undefined) json(response, 200, { ok: true, status: 'open', epoch: fence.epoch });
  };

  const membershipFor = (state, userId, scopedProjectSlug) => state.memberships.find((entry) => (
    entry.userId === userId && entry.projectSlug === scopedProjectSlug
  ));

  const canEnterProject = (state, user, scopedProjectSlug) => (
    user.role === 'admin' || membershipFor(state, user.id, scopedProjectSlug)?.access === 'member'
  );

  const requireProjectAccess = async (user, scopedProjectSlug) => {
    const project = await directory.get(scopedProjectSlug);
    if (project === undefined) throw new GatewayError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    const allowed = await store.read((state) => canEnterProject(state, user, scopedProjectSlug));
    if (!allowed) throw new GatewayError('PROJECT_FORBIDDEN', '你还没有进入该项目的权限，请联系平台管理员。', 403);
    return project;
  };

  const authenticateFromCookie = async (cookieHeader) => {
    const rawToken = cookieValue(cookieHeader, SESSION_COOKIE);
    if (rawToken === undefined) return undefined;
    const hash = tokenHash(rawToken);
    const now = clock();
    const result = await store.read((state) => {
      const session = state.sessions.find((entry) => entry.tokenHash === hash);
      if (session === undefined
        || Date.parse(session.absoluteExpiresAt) <= now
        || Date.parse(session.lastSeenAt) + SESSION_IDLE_MS <= now) return undefined;
      const user = state.users.find((entry) => entry.id === session.userId);
      if (user === undefined || user.status !== 'active' || user.sessionVersion !== session.sessionVersion) return undefined;
      return { session, user };
    });
    if (result === undefined) return undefined;
    if (now - Date.parse(result.session.lastSeenAt) >= SESSION_TOUCH_INTERVAL_MS) {
      await store.mutate((state) => {
        const session = state.sessions.find((entry) => entry.tokenHash === hash);
        if (session !== undefined) session.lastSeenAt = new Date(now).toISOString();
      });
    }
    return { tokenHash: hash, session: result.session, user: result.user };
  };

  const authenticate = (request) => authenticateFromCookie(request.headers.cookie);

  const requireAuthentication = async (request) => {
    const context = await authenticate(request);
    if (context === undefined) throw new GatewayError('AUTH_REQUIRED', '登录已失效，请重新登录。', 401);
    return context;
  };

  const requireCsrf = (request, context) => {
    const csrfCookie = cookieValue(request.headers.cookie, CSRF_COOKIE);
    const csrfHeader = request.headers['x-forge-csrf-token'];
    if (csrfCookie === undefined || typeof csrfHeader !== 'string'
      || !timingSafeTextEqual(csrfCookie, csrfHeader)
      || tokenHash(csrfCookie) !== context.session.csrfHash) {
      throw new GatewayError('CSRF_REJECTED', '请求安全校验失败，请刷新页面后重试。', 403);
    }
  };

  const createUser = async ({ username, displayName, role, projectSlugs = undefined }, actor) => {
    const normalizedUsername = validateInput(normalizeUsername, username, 'INVALID_USERNAME');
    const normalizedDisplayName = validateInput(normalizeDisplayName, displayName, 'INVALID_DISPLAY_NAME');
    const normalizedRole = validateInput(validateRole, role, 'INVALID_ROLE');
    const requestedProjects = projectSlugs === undefined && legacyProject !== undefined
      ? [legacyProject.slug]
      : projectSlugs;
    if (!Array.isArray(requestedProjects) || requestedProjects.some((slug) => typeof slug !== 'string')) {
      throw new GatewayError('INVALID_PROJECT_MEMBERSHIPS', '项目授权必须是项目标识列表。', 400);
    }
    const normalizedProjects = [...new Set(requestedProjects)];
    for (const slug of normalizedProjects) {
      if (await directory.get(slug) === undefined) {
        throw new GatewayError('PROJECT_NOT_FOUND', `项目 ${slug} 不存在。`, 404);
      }
    }
    const temporaryPassword = randomToken(18);
    const passwordHash = await hashPassword(temporaryPassword);
    const now = isoNow(clock);
    const user = {
      id: crypto.randomUUID(),
      username: normalizedUsername,
      displayName: normalizedDisplayName,
      role: normalizedRole,
      status: 'active',
      passwordHash,
      mustChangePassword: true,
      sessionVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    await store.mutate((state) => {
      if (state.users.some((entry) => entry.username === normalizedUsername)) {
        throw new GatewayError('USERNAME_EXISTS', '该用户名已存在。', 409);
      }
      state.users.push(user);
      for (const scopedProjectSlug of normalizedProjects) {
        state.memberships.push({
          userId: user.id,
          projectSlug: scopedProjectSlug,
          access: normalizedRole === 'auditor' ? 'audit' : 'member',
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    await audit({
      actor: actor.username,
      action: 'user.create',
      targetType: 'user',
      targetId: user.id,
      result: 'success',
    });
    return { user: { ...publicUser(user), projectSlugs: normalizedProjects }, temporaryPassword };
  };

  const resetUserPassword = async (userId, actor) => {
    const temporaryPassword = randomToken(18);
    const passwordHash = await hashPassword(temporaryPassword);
    const result = await store.mutate((state) => {
      const user = state.users.find((entry) => entry.id === userId);
      if (user === undefined) throw new GatewayError('USER_NOT_FOUND', '用户不存在。', 404);
      user.passwordHash = passwordHash;
      user.mustChangePassword = true;
      user.sessionVersion += 1;
      user.updatedAt = isoNow(clock);
      state.sessions = state.sessions.filter((entry) => entry.userId !== user.id);
      return publicUser(user);
    });
    await audit({ actor: actor.username, action: 'user.reset-password', targetType: 'user', targetId: userId, result: 'success' });
    return { user: result, temporaryPassword };
  };

  const setUserStatus = async (userId, statusValue, actor) => {
    if (!['active', 'disabled'].includes(statusValue)) {
      throw new GatewayError('INVALID_STATUS', '用户状态必须是 active 或 disabled。', 400);
    }
    const result = await store.mutate((state) => {
      const user = state.users.find((entry) => entry.id === userId);
      if (user === undefined) throw new GatewayError('USER_NOT_FOUND', '用户不存在。', 404);
      if (user.id === actor.id && statusValue === 'disabled') {
        throw new GatewayError('SELF_DISABLE_FORBIDDEN', '不能停用当前登录账号。', 409);
      }
      if (user.role === 'admin' && user.status === 'active' && statusValue === 'disabled') {
        const activeAdmins = state.users.filter((entry) => entry.role === 'admin' && entry.status === 'active');
        if (activeAdmins.length <= 1) throw new GatewayError('LAST_ADMIN', '不能停用最后一个可用管理员。', 409);
      }
      if (user.status !== statusValue) {
        user.status = statusValue;
        user.sessionVersion += 1;
        user.updatedAt = isoNow(clock);
        state.sessions = state.sessions.filter((entry) => entry.userId !== user.id);
      }
      return publicUser(user);
    });
    await audit({ actor: actor.username, action: `user.${statusValue}`, targetType: 'user', targetId: userId, result: 'success' });
    return result;
  };

  const setProjectMembership = async (userId, scopedProjectSlug, granted, actor) => {
    if (typeof granted !== 'boolean') {
      throw new GatewayError('INVALID_PROJECT_MEMBERSHIP', '项目授权状态必须是布尔值。', 400);
    }
    if (await directory.get(scopedProjectSlug) === undefined) {
      throw new GatewayError('PROJECT_NOT_FOUND', '项目不存在。', 404);
    }
    const result = await store.mutate((state) => {
      const user = state.users.find((entry) => entry.id === userId);
      if (user === undefined) throw new GatewayError('USER_NOT_FOUND', '用户不存在。', 404);
      const index = state.memberships.findIndex((entry) => (
        entry.userId === userId && entry.projectSlug === scopedProjectSlug
      ));
      if (granted && index === -1) {
        const now = isoNow(clock);
        state.memberships.push({
          userId,
          projectSlug: scopedProjectSlug,
          access: user.role === 'auditor' ? 'audit' : 'member',
          createdAt: now,
          updatedAt: now,
        });
      } else if (!granted && index !== -1) {
        state.memberships.splice(index, 1);
      }
      return {
        ...publicUser(user),
        projectSlugs: state.memberships
          .filter((entry) => entry.userId === userId && entry.access === 'member')
          .map((entry) => entry.projectSlug)
          .sort(),
      };
    });
    await audit({
      projectSlug: scopedProjectSlug,
      actor: actor.username,
      action: granted ? 'project.grant' : 'project.revoke',
      targetType: 'user',
      targetId: userId,
      result: 'success',
    });
    return result;
  };

  const replaceProjectMemberships = async (userId, projectSlugs, actor) => {
    if (!Array.isArray(projectSlugs) || projectSlugs.some((slug) => typeof slug !== 'string')) {
      throw new GatewayError('INVALID_PROJECT_MEMBERSHIPS', '项目授权必须是项目标识列表。', 400);
    }
    const normalized = [...new Set(projectSlugs)];
    for (const scopedProjectSlug of normalized) {
      if (await directory.get(scopedProjectSlug) === undefined) {
        throw new GatewayError('PROJECT_NOT_FOUND', `项目 ${scopedProjectSlug} 不存在。`, 404);
      }
    }
    const result = await store.mutate((state) => {
      const user = state.users.find((entry) => entry.id === userId);
      if (user === undefined) throw new GatewayError('USER_NOT_FOUND', '用户不存在。', 404);
      if (user.role === 'admin') {
        throw new GatewayError('PLATFORM_ADMIN_HAS_ALL_PROJECTS', '平台管理员默认拥有全部项目权限。', 409);
      }
      state.memberships = state.memberships.filter((entry) => entry.userId !== userId);
      const now = isoNow(clock);
      for (const scopedProjectSlug of normalized) {
        state.memberships.push({
          userId,
          projectSlug: scopedProjectSlug,
          access: user.role === 'auditor' ? 'audit' : 'member',
          createdAt: now,
          updatedAt: now,
        });
      }
      return { ...publicUser(user), projectSlugs: normalized.sort() };
    });
    await audit({
      actor: actor.username,
      action: 'project-memberships.replace',
      targetType: 'user',
      targetId: userId,
      result: 'success',
      projectCount: normalized.length,
    });
    return result;
  };

  const createConversation = async (context, scopedProjectSlug, title, idempotencyKey, requestId) => {
    ensurePermission(context.user, 'conversation:create');
    await requireProjectAccess(context.user, scopedProjectSlug);
    const scopedManager = await resolveManager(scopedProjectSlug);
    const normalizedTitle = validateInput(normalizeConversationTitle, title, 'INVALID_CONVERSATION_TITLE');
    const key = validateInput(validateIdempotencyKey, idempotencyKey, 'INVALID_IDEMPOTENCY_KEY');
    const staged = await store.mutate((state) => {
      const existingKey = state.idempotency.find((entry) => (
        entry.key === key && entry.userId === context.user.id && entry.operation === 'conversation.create'
        && entry.projectSlug === scopedProjectSlug
      ));
      if (existingKey !== undefined) {
        const existingConversation = state.conversations.find((entry) => entry.id === existingKey.resultId);
        if (existingConversation !== undefined) return { conversation: existingConversation, existing: true };
      }
      const now = isoNow(clock);
      const conversation = {
        id: crypto.randomUUID(),
        taskId: newTaskId(),
        projectSlug: scopedProjectSlug,
        ownerUserId: context.user.id,
        title: normalizedTitle,
        status: 'provisioning',
        port: null,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: null,
        lastError: null,
      };
      state.conversations.push(conversation);
      state.idempotency.push({
        key,
        userId: context.user.id,
        operation: 'conversation.create',
        projectSlug: scopedProjectSlug,
        resultId: conversation.id,
        createdAt: now,
      });
      return { conversation, existing: false };
    });
    // A process may stop after state is staged but before the manager returns.
    // Only terminally provisioned records are safe to replay without calling
    // the manager; provisioning and failed records deliberately retry the
    // manager's idempotent create contract.
    if (staged.existing && (['active', 'stopped'].includes(staged.conversation.status)
      || (staged.conversation.status === 'provisioning' && staged.conversation.lastError === 'MANAGER_TIMEOUT'))) {
      return staged.conversation;
    }
    try {
      const provisioned = await scopedManager.create({
        taskId: staged.conversation.taskId,
        actorId: context.user.username,
        actorUserId: context.user.id,
        conversationId: staged.conversation.id,
        accessMode: 'conversation',
      });
      requireManagedTaskspaceIdentity(provisioned.taskspace, staged.conversation, context.user);
      requireManagedTaskspaceStatus(provisioned.taskspace, ['active', 'stopped']);
      const ready = await store.mutate((state) => {
        const conversation = state.conversations.find((entry) => entry.id === staged.conversation.id);
        conversation.status = provisioned.taskspace.status === 'stopped' ? 'stopped' : 'active';
        conversation.port = provisioned.taskspace.harnessPort;
        conversation.updatedAt = isoNow(clock);
        conversation.lastError = null;
        return clone(conversation);
      });
      await audit({ projectSlug: scopedProjectSlug, actor: context.user.username, action: 'conversation.create', targetType: 'conversation', targetId: ready.id, result: 'success', requestId });
      return ready;
    } catch (error) {
      const known = managerError(error);
      if (known.code === 'MANAGER_TIMEOUT') {
        // A transport deadline does not cancel the Manager's create operation.
        const pending = await store.mutate((state) => {
          const conversation = state.conversations.find((entry) => entry.id === staged.conversation.id);
          if (conversation.status === 'provisioning') {
            conversation.lastError = known.code;
            conversation.updatedAt = isoNow(clock);
          }
          return clone(conversation);
        });
        await audit({ projectSlug: scopedProjectSlug, actor: context.user.username, action: 'conversation.create',
          targetType: 'conversation', targetId: pending.id, result: 'pending', code: known.code, requestId });
        return pending;
      }
      const controlReasonCode = known.code === 'CONTROL_FAILED' ? known.details?.reasonCode : undefined;
      await store.mutate((state) => {
        const conversation = state.conversations.find((entry) => entry.id === staged.conversation.id);
        conversation.status = 'failed';
        conversation.updatedAt = isoNow(clock);
        conversation.lastError = controlReasonCode ?? known.code;
      });
      await audit({
        projectSlug: scopedProjectSlug,
        actor: context.user.username,
        action: 'conversation.create',
        targetType: 'conversation',
        targetId: staged.conversation.id,
        result: 'failed',
        code: known.code,
        ...(controlReasonCode === undefined ? {} : { controlReasonCode }),
        ...(known.details?.requestId === undefined ? {} : { managerRequestId: known.details.requestId }),
        requestId,
      });
      throw known;
    }
  };

  const ownedConversation = async (user, conversationId, permission) => {
    ensurePermission(user, permission);
    const conversation = await store.read((state) => state.conversations.find((entry) => entry.id === conversationId));
    if (conversation === undefined) throw new GatewayError('CONVERSATION_NOT_FOUND', '对话不存在。', 404);
    if (conversation.ownerUserId !== user.id) throw new GatewayError('FORBIDDEN', '不能访问其他人员的对话。', 403);
    await requireProjectAccess(user, conversation.projectSlug);
    return conversation;
  };

  const readableConversation = async (user, conversationId) => {
    const conversation = await store.read((state) => state.conversations.find((entry) => entry.id === conversationId));
    if (conversation === undefined) throw new GatewayError('CONVERSATION_NOT_FOUND', '对话不存在。', 404);
    await requireProjectAccess(user, conversation.projectSlug);
    if (conversation.ownerUserId !== user.id && user.role !== 'admin') {
      throw new GatewayError('FORBIDDEN', '不能读取其他人员的对话归档。', 403);
    }
    return conversation;
  };

  const pendingProvisioningConversation = (entry) => entry.status === 'provisioning'
    || (entry.status === 'failed' && ['MANAGER_TIMEOUT', 'CONTROL_TIMEOUT', 'TASKSPACE_PROVISIONING_FAILED'].includes(entry.lastError));

  const refreshProvisioningConversation = async (context, conversationId) => {
    const conversation = await ownedConversation(context.user, conversationId, 'conversation:open-own');
    if (!pendingProvisioningConversation(conversation)) return conversation;
    let managed;
    try {
      managed = await (await resolveManager(conversation.projectSlug)).status(conversation.taskId);
    } catch (error) {
      if (error instanceof GatewayError && error.code === 'TASKSPACE_NOT_FOUND') return conversation;
      throw managerError(error);
    }
    requireManagedTaskspaceIdentity(managed.taskspace, conversation, context.user);
    requireManagedTaskspaceStatus(managed.taskspace, ['active', 'stopped', 'provisioning', 'provisioning-failed']);
    return store.mutate((state) => {
      const entry = state.conversations.find((item) => item.id === conversationId);
      // Do not overwrite a concurrent stop/open operation with an older observation.
      if (!pendingProvisioningConversation(entry)) return clone(entry);
      entry.status = managed.taskspace.status === 'provisioning-failed' ? 'failed' : managed.taskspace.status;
      entry.port = managed.taskspace.harnessPort ?? null;
      entry.lastError = entry.status === 'failed' ? 'TASKSPACE_PROVISIONING_FAILED'
        : entry.status === 'provisioning' ? 'MANAGER_TIMEOUT' : null;
      entry.updatedAt = isoNow(clock);
      return clone(entry);
    });
  };

  const openConversation = async (context, conversationId, requestId) => {
    const conversation = await ownedConversation(context.user, conversationId, 'conversation:open-own');
    if (conversation.status === 'closed') {
      throw new GatewayError('TASKSPACE_CLOSED', '已关闭的工作舱不能恢复，可继续查看历史产物。', 409);
    }
    const scopedManager = await resolveManager(conversation.projectSlug);
    let managed;
    try {
      if (conversation.status === 'provisioning' || conversation.status === 'failed') {
        managed = await scopedManager.create({
          taskId: conversation.taskId,
          actorId: context.user.username,
          actorUserId: context.user.id,
          conversationId: conversation.id,
          accessMode: 'conversation',
        });
      } else {
        managed = await scopedManager.start(conversation.taskId);
      }
      requireManagedTaskspaceIdentity(managed.taskspace, conversation, context.user);
      requireManagedTaskspaceStatus(managed.taskspace, ['active']);
    } catch (error) {
      const known = managerError(error);
      await audit({ projectSlug: conversation.projectSlug, actor: context.user.username, action: 'conversation.open', targetType: 'conversation', targetId: conversation.id, result: 'failed', code: known.code, requestId });
      throw known;
    }
    const updated = await store.mutate((state) => {
      const entry = state.conversations.find((item) => item.id === conversation.id);
      for (const item of state.conversations) {
        if (item.taskId !== conversation.taskId
          || item.projectSlug !== conversation.projectSlug
          || item.ownerUserId !== conversation.ownerUserId) continue;
        item.status = 'active';
        item.port = managed.taskspace.harnessPort;
        item.lastError = null;
      }
      entry.updatedAt = isoNow(clock);
      entry.lastOpenedAt = entry.updatedAt;
      return clone(entry);
    });
    await audit({ projectSlug: conversation.projectSlug, actor: context.user.username, action: 'conversation.open', targetType: 'conversation', targetId: conversation.id, result: 'success', requestId });
    const parameters = new URLSearchParams();
    if (conversation.conversationKind === 'legacy-session') {
      validateInput(validateConversationId, conversation.legacySessionId, 'INVALID_LEGACY_SESSION_ID');
      parameters.set('forgeSession', conversation.legacySessionId);
    }
    const query = parameters.size === 0 ? '' : `?${parameters}`;
    return { conversation: updated, url: `${parsedOrigin.protocol}//${bindAddress}:${updated.port}/${query}` };
  };

  const stopConversation = async (context, conversationId, requestId) => {
    const conversation = await ownedConversation(context.user, conversationId, 'conversation:stop-own');
    if (conversation.status === 'closed') {
      throw new GatewayError('TASKSPACE_CLOSED', '已关闭的工作舱不能再次停止，可继续查看历史产物。', 409);
    }
    const scopedManager = await resolveManager(conversation.projectSlug);
    try {
      await scopedManager.stop(conversation.taskId);
    } catch (error) {
      throw managerError(error);
    }
    const updated = await store.mutate((state) => {
      const entry = state.conversations.find((item) => item.id === conversation.id);
      entry.updatedAt = isoNow(clock);
      const related = [];
      for (const item of state.conversations) {
        if (item.taskId !== conversation.taskId
          || item.projectSlug !== conversation.projectSlug
          || item.ownerUserId !== conversation.ownerUserId) continue;
        item.status = 'stopped';
        item.lastError = null;
        if (item.hiddenFromList !== true) related.push(clone(item));
      }
      return { conversation: clone(entry), related };
    });
    await audit({ projectSlug: conversation.projectSlug, actor: context.user.username, action: 'conversation.stop', targetType: 'conversation', targetId: conversation.id, result: 'success', requestId });
    return updated;
  };

  const publicHandler = async (request, response) => {
    const requestId = requestIdOf(request);
    const parsed = new URL(request.url ?? '/', publicOrigin);
    if (cookieSecure) response.setHeader('cross-origin-opener-policy', 'same-origin');
    try {
      // Container health probes do not carry the public Host header. This
      // endpoint intentionally exposes no account or project state.
      if (request.method === 'GET' && parsed.pathname === '/healthz') {
        await health(request, response);
        return;
      }
      if (await admitRequest(request, response) === undefined) return;
      const sameOrigin = requestIsSameOrigin(request, canonicalPublicOrigin, publicAuthority, request.method !== 'GET' && request.method !== 'HEAD');
      if (!sameOrigin) throw new GatewayError('INGRESS_REJECTED', '请求来源不可信。', 403);
      if (request.method === 'GET' && parsed.pathname === '/favicon.ico') {
        empty(response, 204, { 'cache-control': 'public, max-age=86400' });
        return;
      }
      if (request.method === 'GET' && parsed.pathname === '/') {
        const context = await authenticate(request);
        redirect(response, context === undefined ? '/forge-gateway/login' : '/forge-gateway/');
        return;
      }
      const mermaidAsset = /^\/forge-gateway\/assets\/mermaid\/(?:mermaid\.esm\.min\.mjs|chunks\/mermaid\.esm\.min\/[A-Za-z0-9_-]+\.mjs)$/.test(parsed.pathname);
      const staticFile = STATIC_FILES[parsed.pathname]
        ?? (mermaidAsset ? [parsed.pathname.slice('/forge-gateway/assets/'.length), 'text/javascript; charset=utf-8'] : undefined);
      if (request.method === 'GET' && staticFile !== undefined) {
        if (['platform-catalog.json', 'platform-updates.json'].includes(staticFile[0])) {
          const context = await authenticate(request);
          if (context === undefined) throw new GatewayError('UNAUTHENTICATED', '请先登录后查看平台说明。', 401);
          if (context.user.mustChangePassword) throw new GatewayError('PASSWORD_CHANGE_REQUIRED', '请先完成密码修改。', 403);
        }
        const [filename, contentType] = staticFile;
        const body = await readFile(path.join(staticRoot, filename));
        response.writeHead(200, responseHeaders({
          'cache-control': 'no-cache',
          'content-length': body.length,
          'content-type': contentType,
        }));
        response.end(body);
        return;
      }
      if (request.method === 'GET' && PAGE_FILES[parsed.pathname] !== undefined) {
        const context = await authenticate(request);
        if (parsed.pathname === '/forge-gateway/login' && context !== undefined) {
          const returnTask = parsed.searchParams.get('returnTask');
          const returnProject = parsed.searchParams.get('project');
          const returnParameters = new URLSearchParams();
          if (typeof returnTask === 'string' && /^[a-z0-9][a-z0-9-]{1,47}$/.test(returnTask)) returnParameters.set('returnTask', returnTask);
          if (typeof returnProject === 'string' && /^[a-z][a-z0-9-]{2,31}$/.test(returnProject)) returnParameters.set('project', returnProject);
          const suffix = returnParameters.size === 0 ? '' : `?${returnParameters}`;
          redirect(response, context.user.mustChangePassword
            ? `/forge-gateway/change-password${suffix}`
            : `/forge-gateway/${suffix}`);
          return;
        }
        if (parsed.pathname !== '/forge-gateway/login' && context === undefined) {
          redirect(response, '/forge-gateway/login');
          return;
        }
        if (['/forge-gateway/', '/forge-gateway/delivery-center', '/forge-gateway/platform-value'].includes(parsed.pathname) && context?.user.mustChangePassword) {
          redirect(response, '/forge-gateway/change-password');
          return;
        }
        const body = await readFile(path.join(staticRoot, PAGE_FILES[parsed.pathname]));
        response.writeHead(200, responseHeaders({
          'cache-control': 'no-store',
          'content-length': body.length,
          'content-type': 'text/html; charset=utf-8',
        }));
        response.end(body);
        return;
      }

      if (request.method === 'GET' && parsed.pathname === '/forge-gateway/api/auth-context') {
        const context = await authenticate(request);
        let preauth = cookieValue(request.headers.cookie, PREAUTH_COOKIE);
        const headers = {};
        if (preauth === undefined) {
          preauth = randomToken(24);
          headers['set-cookie'] = buildCookie(PREAUTH_COOKIE, preauth, { maxAge: PREAUTH_MAX_AGE_SECONDS, secure: cookieSecure });
        }
        json(response, 200, {
          authenticated: context !== undefined,
          csrfToken: preauth,
          user: context === undefined ? null : publicUser(context.user),
        }, headers);
        return;
      }

      if (request.method === 'POST' && parsed.pathname === '/forge-gateway/api/login') {
        const preauthCookie = cookieValue(request.headers.cookie, PREAUTH_COOKIE);
        const preauthHeader = request.headers['x-forge-csrf-token'];
        if (preauthCookie === undefined || typeof preauthHeader !== 'string'
          || !timingSafeTextEqual(preauthCookie, preauthHeader)) {
          throw new GatewayError('CSRF_REJECTED', '登录安全校验失败，请刷新页面。', 403);
        }
        const body = await readJson(request);
        let username;
        try { username = normalizeUsername(body.username); } catch { username = ''; }
        const failureKey = `${remoteAddressOf(request)}:${username}`;
        const failures = (loginFailures.get(failureKey) ?? []).filter((at) => clock() - at < LOGIN_WINDOW_MS);
        if (failures.length >= LOGIN_MAX_FAILURES) {
          throw new GatewayError('LOGIN_RATE_LIMITED', '登录尝试过多，请 15 分钟后再试。', 429);
        }
        const user = await store.read((state) => state.users.find((entry) => entry.username === username));
        const valid = await verifyPassword(String(body.password ?? ''), user?.passwordHash ?? dummyPasswordHash);
        if (!valid || user === undefined || user.status !== 'active') {
          failures.push(clock());
          loginFailures.set(failureKey, failures);
          await audit({ actor: username || 'unknown', action: 'auth.login', targetType: 'session', targetId: null, result: 'failed', code: 'INVALID_CREDENTIALS', requestId, remoteAddress: remoteAddressOf(request) });
          throw new GatewayError('INVALID_CREDENTIALS', '用户名或密码不正确。', 401);
        }
        loginFailures.delete(failureKey);
        const session = newSession(user, clock);
        await store.mutate((state) => {
          state.sessions = state.sessions.filter((entry) => entry.userId !== user.id || Date.parse(entry.createdAt) > clock() - 30 * 24 * 60 * 60 * 1000);
          state.sessions.push(session.record);
        });
        await audit({ actor: user.username, action: 'auth.login', targetType: 'session', targetId: session.record.tokenHash.slice(0, 12), result: 'success', requestId, remoteAddress: remoteAddressOf(request) });
        const returnTask = typeof body.returnTask === 'string' && /^[a-z0-9][a-z0-9-]{1,47}$/.test(body.returnTask)
          ? body.returnTask
          : undefined;
        const returnProject = typeof body.returnProject === 'string' && /^[a-z][a-z0-9-]{2,31}$/.test(body.returnProject)
          ? body.returnProject
          : undefined;
        const returnParameters = new URLSearchParams();
        if (returnTask !== undefined) returnParameters.set('returnTask', returnTask);
        if (returnProject !== undefined) returnParameters.set('project', returnProject);
        const returnSuffix = returnParameters.size === 0 ? '' : `?${returnParameters}`;
        json(response, 200, {
          ok: true,
          redirect: user.mustChangePassword
            ? `/forge-gateway/change-password${returnSuffix}`
            : `/forge-gateway/${returnSuffix}`,
          user: publicUser(user),
        }, { 'set-cookie': sessionCookies(session, cookieSecure) });
        return;
      }

      if (request.method === 'GET' && parsed.pathname === '/forge-gateway/api/session') {
        const context = await requireAuthentication(request);
        const csrf = cookieValue(request.headers.cookie, CSRF_COOKIE);
        if (csrf === undefined || tokenHash(csrf) !== context.session.csrfHash) {
          throw new GatewayError('AUTH_REQUIRED', '登录状态不完整，请重新登录。', 401);
        }
        const projectCount = (await directory.list()).length;
        json(response, 200, {
          user: publicUser(context.user),
          csrfToken: csrf,
          system: { projectCount, unifiedProjectDirectory: projectDirectory !== undefined },
        });
        return;
      }

      if (request.method === 'POST' && parsed.pathname === '/forge-gateway/api/logout') {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        await store.mutate((state) => {
          state.sessions = state.sessions.filter((entry) => entry.tokenHash !== context.tokenHash);
        });
        await audit({ actor: context.user.username, action: 'auth.logout', targetType: 'session', targetId: context.tokenHash.slice(0, 12), result: 'success', requestId });
        json(response, 200, { ok: true, redirect: '/forge-gateway/login' }, { 'set-cookie': clearCookies(cookieSecure) });
        return;
      }

      if (request.method === 'POST' && parsed.pathname === '/forge-gateway/api/change-password') {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        const body = await readJson(request);
        const validCurrent = await verifyPassword(String(body.currentPassword ?? ''), context.user.passwordHash);
        if (!validCurrent) throw new GatewayError('CURRENT_PASSWORD_INVALID', '当前密码不正确。', 400);
        const nextPassword = validateInput(
          (value) => validatePassword(value, context.user.username),
          body.newPassword,
          'INVALID_PASSWORD',
        );
        if (nextPassword !== body.confirmPassword) throw new GatewayError('PASSWORD_MISMATCH', '两次输入的新密码不一致。', 400);
        const passwordHash = await hashPassword(nextPassword);
        let rotated;
        await store.mutate((state) => {
          const user = state.users.find((entry) => entry.id === context.user.id);
          user.passwordHash = passwordHash;
          user.mustChangePassword = false;
          user.sessionVersion += 1;
          user.updatedAt = isoNow(clock);
          state.sessions = state.sessions.filter((entry) => entry.userId !== user.id);
          rotated = newSession(user, clock);
          state.sessions.push(rotated.record);
        });
        if (context.user.username === 'admin') await store.removeBootstrapCredential();
        await audit({ actor: context.user.username, action: 'auth.change-password', targetType: 'user', targetId: context.user.id, result: 'success', requestId });
        const returnTask = typeof body.returnTask === 'string' && /^[a-z0-9][a-z0-9-]{1,47}$/.test(body.returnTask)
          ? body.returnTask
          : undefined;
        const returnProject = typeof body.returnProject === 'string' && /^[a-z][a-z0-9-]{2,31}$/.test(body.returnProject)
          ? body.returnProject
          : undefined;
        const returnParameters = new URLSearchParams();
        if (returnTask !== undefined) returnParameters.set('returnTask', returnTask);
        if (returnProject !== undefined) returnParameters.set('project', returnProject);
        const redirectPath = returnParameters.size === 0 ? '/forge-gateway/' : `/forge-gateway/?${returnParameters}`;
        json(response, 200, { ok: true, redirect: redirectPath }, { 'set-cookie': sessionCookies(rotated, cookieSecure) });
        return;
      }

      if (parsed.pathname.startsWith('/forge-gateway/api/delivery/')) {
        await requireAuthentication(request);
        try {
          const result = await deliveryResponse({ method: request.method, url: parsed, store: deliveryStore });
          if (result.csv !== undefined) {
            const body = Buffer.from(result.csv, 'utf8');
            response.writeHead(200, responseHeaders({
              'cache-control': 'no-store', 'content-type': 'text/csv; charset=utf-8',
              'content-disposition': `attachment; filename="${result.filename}"`,
              'content-length': body.length, 'x-export-row-count': String(result.count),
            }));
            response.end(body);
          } else json(response, 200, result.body);
        } catch (error) {
          if (error instanceof DeliveryCenterError) throw new GatewayError(error.code, error.message, error.status);
          const known = {
            DELIVERY_EXPORT_TOO_LARGE: [422, '导出结果过多，请缩小菜单或批次范围后重试。'],
            DELIVERY_LIST_TOO_LARGE: [413, '结果超过展示上限，请联系平台维护人员。'],
            DELIVERY_RESULT_LIMIT: [413, '结果超过展示上限，请缩小查询范围或联系平台维护人员。'],
            DELIVERY_PROJECT_NOT_FOUND: [404, '该项目尚未收录需求与交付资料。'],
            DELIVERY_NOT_FOUND: [404, '记录不存在或尚未收录。'],
          }[error.code];
          if (known) throw new GatewayError(error.code, known[1], known[0]);
          throw new GatewayError('DELIVERY_UNAVAILABLE', '需求与交付数据暂时无法读取，请稍后重试。', 503);
        }
        return;
      }

      if (request.method === 'GET' && parsed.pathname === '/forge-gateway/api/project-release-status') {
        const context = await requireAuthentication(request);
        const slug = parsed.searchParams.get('project');
        await requireProjectAccess(context.user, slug);
        const scopedManager = await resolveManager(slug);
        let status;
        try {
          ({ status } = await scopedManager.releaseStatus());
          if (status?.projectSlug !== slug || status.schemaVersion !== 1) throw new Error('Project scope mismatch.');
        } catch {
          throw new GatewayError('PROJECT_RELEASE_STATUS_UNAVAILABLE', '发布状态暂不可确认，请稍后刷新。', 503);
        }
        const operation = publicReleaseOperation(status.operation, { action: status.operation?.action });
        let owner = null;
        if (operation?.actorId) {
          owner = await store.read((state) => {
            const user = state.users.find((entry) => entry.username === operation.actorId);
            return { username: operation.actorId, displayName: user?.displayName ?? operation.actorId,
              isSelf: user?.id === context.user.id };
          });
        }
        json(response, 200, { ok: true, schemaVersion: 1, projectSlug: slug,
          observedAt: typeof status.observedAt === 'string' && Number.isFinite(Date.parse(status.observedAt)) ? new Date(status.observedAt).toISOString() : null,
          availability: ['ready', 'partial'].includes(status.availability) ? status.availability : 'unknown',
          occupied: typeof status.occupied === 'boolean' ? status.occupied : null,
          operation: operation ? { ...operation, owner } : null });
        return;
      }

      if (request.method === 'GET' && parsed.pathname === '/forge-gateway/api/projects') {
        const context = await requireAuthentication(request);
        const projects = await directory.list();
        const snapshot = await store.read((state) => ({
          memberships: state.memberships,
          conversations: state.conversations,
        }));
        const items = await Promise.all(projects.map(async (project) => {
          const canEnter = context.user.role === 'admin'
            || membershipFor(snapshot, context.user.id, project.slug)?.access === 'member';
          let managerReady = false;
          if (canEnter) {
            try { managerReady = (await resolveManager(project.slug).then((value) => value.health())).ok === true; } catch {}
          }
          return {
            slug: project.slug,
            displayName: project.displayName,
            projectKind: project.projectKind,
            createdAt: project.createdAt,
            forgeUiUrl: Number.isInteger(project.uiPort) ? `${parsedOrigin.protocol}//${bindAddress}:${project.uiPort}/forge/login` : null,
            canEnter,
            managerReady,
            ownConversationCount: snapshot.conversations.filter((entry) => (
              entry.projectSlug === project.slug
              && entry.ownerUserId === context.user.id
              && entry.hiddenFromList !== true
            )).length,
          };
        }));
        json(response, 200, { items, total: items.length });
        return;
      }

      if (request.method === 'GET' && parsed.pathname === '/forge-gateway/api/conversations') {
        const context = await requireAuthentication(request);
        const scopedProjectSlug = parsed.searchParams.get('project') ?? legacyProject?.slug;
        if (typeof scopedProjectSlug !== 'string') {
          throw new GatewayError('PROJECT_REQUIRED', '请先选择一个项目。', 400);
        }
        await requireProjectAccess(context.user, scopedProjectSlug);
        const requestedScope = parsed.searchParams.get('scope') ?? 'own';
        if (!['own', 'all'].includes(requestedScope) || (requestedScope === 'all' && context.user.role !== 'admin')) {
          throw new GatewayError('FORBIDDEN', '当前角色不能查看全部对话。', 403);
        }
        const offset = Math.max(0, Number.parseInt(parsed.searchParams.get('offset') ?? '0', 10) || 0);
        const limit = 3;
        const result = await store.read((state) => ({ rows: state.conversations
          .filter((entry) => (
            (requestedScope === 'all' || entry.ownerUserId === context.user.id)
            && entry.projectSlug === scopedProjectSlug
            && entry.hiddenFromList !== true
          ))
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), users: state.users }));
        const rows = result.rows;
        if (requestedScope === 'all') await audit({ projectSlug: scopedProjectSlug,
          actor: context.user.username, action: 'conversation.list-all', targetType: 'project', targetId: scopedProjectSlug,
          result: 'success', requestId });
        json(response, 200, {
          items: rows.slice(offset, offset + limit).map((entry) => ({ ...publicConversation(entry),
            ...(requestedScope === 'all' ? { owner: (() => { const owner = result.users.find((user) => user.id === entry.ownerUserId);
              return owner === undefined ? null : { id: owner.id, username: owner.username, displayName: owner.displayName }; })() } : {}) })),
          nextOffset: offset + limit < rows.length ? offset + limit : null,
          total: rows.length,
        });
        return;
      }

      const phaseOutputsMatch = /^\/forge-gateway\/api\/conversations\/([^/]+)\/phase-outputs$/u.exec(parsed.pathname);
      const phaseOutputMatch = /^\/forge-gateway\/api\/conversations\/([^/]+)\/phase-outputs\/([a-f0-9]{64})\/([^/]+)$/u.exec(parsed.pathname);
      if (request.method === 'GET' && (phaseOutputsMatch !== null || phaseOutputMatch !== null)) {
        const context = await requireAuthentication(request);
        const decodePhaseSegment = (value) => {
          let decoded;
          try { decoded = decodeURIComponent(value); } catch {
            throw new GatewayError('INVALID_OUTPUT_PATH', '阶段文件路径不合法。', 400);
          }
          if (decoded.includes('/') || decoded.includes('\\') || /[\0-\x1f\x7f]/u.test(decoded)) {
            throw new GatewayError('INVALID_OUTPUT_PATH', '阶段文件路径不合法。', 400);
          }
          return decoded;
        };
        const conversation = await readableConversation(context.user, validateInput(validateConversationId,
          decodePhaseSegment(phaseOutputsMatch?.[1] ?? phaseOutputMatch[1]), 'INVALID_CONVERSATION_ID'));
        // A shared legacy TaskSpace has no unique stage-to-conversation binding.
        if (conversation.conversationKind === 'legacy-session') {
          if (phaseOutputMatch !== null) throw new GatewayError('OUTPUT_NOT_FOUND', '此旧对话尚未关联阶段成果。', 404);
          json(response, 200, { ok: true, items: [], offset: 0, limit: 20, hasMore: false,
            unavailable: { code: 'PHASE_OUTPUTS_UNBOUND', message: '此旧对话尚未关联阶段成果，可查看下方对话记录。' } }); return;
        }
        const manager = await resolveManager(conversation.projectSlug);
        if (phaseOutputsMatch !== null) {
          const query = new URLSearchParams({ offset: parsed.searchParams.get('offset') ?? '0', limit: parsed.searchParams.get('limit') ?? '20' });
          const value = await manager.phaseOutputs(conversation.taskId, `?${query}`);
          if (context.user.role === 'admin' && conversation.ownerUserId !== context.user.id) await audit({ projectSlug: conversation.projectSlug,
            actor: context.user.username, action: 'conversation.phase-outputs.read', targetType: 'conversation', targetId: conversation.id, result: 'success', requestId });
          json(response, 200, value); return;
        }
        const value = await manager.phaseOutput(conversation.taskId, phaseOutputMatch[2], decodePhaseSegment(phaseOutputMatch[3]));
        const buffer = Buffer.from(value.base64, 'base64');
        if (buffer.length !== value.bytes || crypto.createHash('sha256').update(buffer).digest('hex') !== value.sha256) {
          throw new GatewayError('OUTPUT_FILE_INVALID', '阶段文件校验失败。', 502);
        }
        if (context.user.role === 'admin' && conversation.ownerUserId !== context.user.id) await audit({ projectSlug: conversation.projectSlug,
          actor: context.user.username, action: 'conversation.phase-output.read', targetType: 'conversation', targetId: conversation.id, result: 'success', requestId });
        response.writeHead(200, responseHeaders({ 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8',
          'content-length': buffer.length, 'content-disposition': `${parsed.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(value.downloadName ?? value.name)}`,
          'content-security-policy': "sandbox; default-src 'none'", 'x-content-type-options': 'nosniff' }));
        response.end(buffer); return;
      }

      const outputsMatch = /^\/forge-gateway\/api\/conversations\/([^/]+)\/outputs$/u.exec(parsed.pathname);
      const outputFileMatch = /^\/forge-gateway\/api\/conversations\/([^/]+)\/outputs\/([^/]+)\/([a-f0-9]{64})\/([^/]+)$/u.exec(parsed.pathname);
      if (request.method === 'GET' && (outputsMatch !== null || outputFileMatch !== null)) {
        const context = await requireAuthentication(request);
        const decodeOutputSegment = (value) => {
          let decoded;
          try { decoded = decodeURIComponent(value); } catch {
            throw new GatewayError('INVALID_OUTPUT_PATH', '归档路径不合法。', 400);
          }
          if (decoded.includes('/') || decoded.includes('\\') || /[\0-\x1f\x7f]/u.test(decoded)) {
            throw new GatewayError('INVALID_OUTPUT_PATH', '归档路径不合法。', 400);
          }
          return decoded;
        };
        const encodedConversationId = outputsMatch?.[1] ?? outputFileMatch[1];
        const conversation = await readableConversation(context.user,
          validateInput(validateConversationId, decodeOutputSegment(encodedConversationId), 'INVALID_CONVERSATION_ID'));
        const manager = await resolveManager(conversation.projectSlug);
        const legacySession = conversation.conversationKind === 'legacy-session' ? conversation.legacySessionId : undefined;
        if (outputsMatch !== null) {
          const requestedSession = parsed.searchParams.get('sessionId') ?? legacySession;
          if (legacySession !== undefined && requestedSession !== legacySession) throw new GatewayError('FORBIDDEN', '旧对话只能读取其绑定会话。', 403);
          const query = new URLSearchParams();
          if (requestedSession !== undefined) query.set('sessionId', requestedSession);
          query.set('offset', parsed.searchParams.get('offset') ?? '0'); query.set('limit', parsed.searchParams.get('limit') ?? '20');
          const value = await manager.outputs(conversation.taskId, `?${query}`);
          if (context.user.role === 'admin' && conversation.ownerUserId !== context.user.id) await audit({ projectSlug: conversation.projectSlug,
            actor: context.user.username, action: 'conversation.outputs.read', targetType: 'conversation', targetId: conversation.id, result: 'success', requestId });
          json(response, 200, value); return;
        }
        const sessionId = decodeOutputSegment(outputFileMatch[2]);
        if (legacySession !== undefined && sessionId !== legacySession) throw new GatewayError('FORBIDDEN', '旧对话只能读取其绑定会话。', 403);
        const value = await manager.output(conversation.taskId, sessionId, outputFileMatch[3], decodeOutputSegment(outputFileMatch[4]));
        const buffer = Buffer.from(value.base64, 'base64');
        if (buffer.length !== value.bytes || crypto.createHash('sha256').update(buffer).digest('hex') !== value.sha256) {
          throw new GatewayError('OUTPUT_FILE_INVALID', '归档文件校验失败。', 502);
        }
        if (context.user.role === 'admin' && conversation.ownerUserId !== context.user.id) await audit({ projectSlug: conversation.projectSlug,
          actor: context.user.username, action: 'conversation.output.read', targetType: 'conversation', targetId: conversation.id, result: 'success', requestId });
        const download = parsed.searchParams.get('download') === '1';
        response.writeHead(200, responseHeaders({ 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8',
          'content-length': buffer.length, 'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(value.downloadName ?? value.name)}`,
          'content-security-policy': "sandbox; default-src 'none'", 'x-content-type-options': 'nosniff' }));
        response.end(buffer); return;
      }

      if (request.method === 'GET' && parsed.pathname === '/forge-gateway/api/materials') {
        const context = await requireAuthentication(request);
        ensurePermission(context.user, 'material:read-shared');
        const scopedProjectSlug = parsed.searchParams.get('project') ?? legacyProject?.slug;
        if (typeof scopedProjectSlug !== 'string') {
          throw new GatewayError('PROJECT_REQUIRED', '请先选择一个项目。', 400);
        }
        await requireProjectAccess(context.user, scopedProjectSlug);
        const offset = Math.max(0, Number.parseInt(parsed.searchParams.get('offset') ?? '0', 10) || 0);
        const limit = Math.min(500, Math.max(1, Number.parseInt(parsed.searchParams.get('limit') ?? '200', 10) || 200));
        try {
          const value = await (await resolveManager(scopedProjectSlug)).materials({
            includeIntake: context.user.role === 'admin',
            offset,
            limit,
          });
          json(response, 200, {
            accessMode: value.accessMode,
            accepted: value.accepted,
            intake: context.user.role === 'admin' ? value.intake : { items: [], total: 0 },
            categories: value.categories,
            nextOffset: offset + limit < Math.max(
              value.accepted.total,
              context.user.role === 'admin' ? value.intake.total : 0,
            ) ? offset + limit : null,
          });
        } catch (error) {
          throw managerError(error);
        }
        return;
      }

      if (request.method === 'POST' && parsed.pathname === '/forge-gateway/api/materials/promote') {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        ensurePermission(context.user, 'material:review');
        const body = await readJson(request);
        const scopedProjectSlug = body.projectSlug ?? legacyProject?.slug;
        if (typeof scopedProjectSlug !== 'string') {
          throw new GatewayError('PROJECT_REQUIRED', '请先选择一个项目。', 400);
        }
        await requireProjectAccess(context.user, scopedProjectSlug);
        let result;
        try {
          result = await (await resolveManager(scopedProjectSlug)).promoteMaterial({
            actorId: context.user.id,
            actorUsername: context.user.username,
            category: body.category,
            expectedSha256: body.expectedSha256,
            requestId,
            sourcePath: body.sourcePath,
          });
        } catch (error) {
          throw managerError(error);
        }
        await audit({
          projectSlug: scopedProjectSlug,
          actor: context.user.username,
          action: 'material.promote',
          targetType: 'project-material',
          targetId: result.material.path,
          result: result.idempotent ? 'idempotent' : 'success',
          requestId,
        });
        json(response, 200, result);
        return;
      }

      if (request.method === 'POST' && parsed.pathname === '/forge-gateway/api/conversations') {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        const body = await readJson(request);
        const scopedProjectSlug = body.projectSlug ?? legacyProject?.slug;
        if (typeof scopedProjectSlug !== 'string') throw new GatewayError('PROJECT_REQUIRED', '请先选择一个项目。', 400);
        const conversation = await createConversation(context, scopedProjectSlug, body.title, request.headers['idempotency-key'], requestId);
        json(response, conversation.status === 'provisioning' ? 202 : 201, { conversation: publicConversation(conversation) });
        return;
      }

      const provisioningMatch = /^\/forge-gateway\/api\/conversations\/([^/]+)\/status$/.exec(parsed.pathname);
      if (request.method === 'GET' && provisioningMatch !== null) {
        const context = await requireAuthentication(request);
        const conversationId = validateInput(validateConversationId, provisioningMatch[1], 'INVALID_CONVERSATION_ID');
        const conversation = await refreshProvisioningConversation(context, conversationId);
        json(response, 200, { conversation: publicConversation(conversation) });
        return;
      }

      const roleDecisionMatch = /^\/forge-gateway\/api\/conversations\/([^/]+)\/role-decisions$/u.exec(parsed.pathname);
      if (request.method === 'POST' && roleDecisionMatch !== null) {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        const conversationId = validateInput(validateConversationId, roleDecisionMatch[1], 'INVALID_CONVERSATION_ID');
        const conversation = await ownedConversation(context.user, conversationId, 'workspace:write-own');
        const body = await readJson(request);
        const expected = ['operation', ...(body.operation === 'confirm' ? ['previewId', 'previewDigest'] : [])];
        if (!['preview', 'confirm'].includes(body.operation) || Object.keys(body).sort().join() !== expected.sort().join()) {
          throw new GatewayError('ROLE_DECISION_INVALID', '角色确认只接受当前预览标识。', 422);
        }
        if (conversation.status !== 'active') throw new GatewayError('CONVERSATION_NOT_ACTIVE', '请先打开当前对话。', 409);
        const result = await (await resolveManager(conversation.projectSlug)).roleDecision({
          ...body, projectSlug: conversation.projectSlug, taskId: conversation.taskId,
          actorUserId: context.user.id, actorUsername: context.user.username, conversationId,
        });
        await audit({ projectSlug: conversation.projectSlug, actor: context.user.username,
          action: `conversation.roles.${body.operation}`, targetType: 'conversation', targetId: conversationId,
          result: result.status, requestId });
        json(response, 200, result);
        return;
      }

      const conversationMatch = /^\/forge-gateway\/api\/conversations\/([^/]+)\/(open|stop|rename)$/.exec(parsed.pathname);
      if (conversationMatch !== null && request.method === 'POST') {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        let decodedConversationId;
        try {
          decodedConversationId = decodeURIComponent(conversationMatch[1]);
        } catch {
          throw new GatewayError('INVALID_CONVERSATION_ID', '对话标识不合法。', 400);
        }
        const conversationId = validateInput(validateConversationId, decodedConversationId, 'INVALID_CONVERSATION_ID');
        const action = conversationMatch[2];
        if (action === 'open') {
          const result = await openConversation(context, conversationId, requestId);
          json(response, 200, { conversation: publicConversation(result.conversation), url: result.url });
          return;
        }
        if (action === 'stop') {
          const result = await stopConversation(context, conversationId, requestId);
          json(response, 200, {
            conversation: publicConversation(result.conversation),
            relatedConversations: result.related.map(publicConversation),
          });
          return;
        }
        const existing = await ownedConversation(context.user, conversationId, 'conversation:rename-own');
        const body = await readJson(request);
        const title = validateInput(normalizeConversationTitle, body.title, 'INVALID_CONVERSATION_TITLE');
        const conversation = await store.mutate((state) => {
          const entry = state.conversations.find((item) => item.id === existing.id);
          entry.title = title;
          entry.updatedAt = isoNow(clock);
          return clone(entry);
        });
        await audit({ projectSlug: conversation.projectSlug, actor: context.user.username, action: 'conversation.rename', targetType: 'conversation', targetId: conversation.id, result: 'success', requestId });
        json(response, 200, { conversation: publicConversation(conversation) });
        return;
      }

      if (request.method === 'GET' && parsed.pathname === '/forge-gateway/api/admin/users') {
        const context = await requireAuthentication(request);
        ensurePermission(context.user, 'user:manage');
        const users = await store.read((state) => state.users.map((user) => ({
          ...publicUser(user),
          projectSlugs: state.memberships
            .filter((entry) => entry.userId === user.id && entry.access === 'member')
            .map((entry) => entry.projectSlug)
            .sort(),
        })).sort((a, b) => a.username.localeCompare(b.username)));
        json(response, 200, { users });
        return;
      }

      if (request.method === 'POST' && parsed.pathname === '/forge-gateway/api/admin/users') {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        ensurePermission(context.user, 'user:manage');
        const body = await readJson(request);
        const result = await createUser(body, context.user);
        json(response, 201, result);
        return;
      }

      const membershipReplaceMatch = /^\/forge-gateway\/api\/admin\/users\/([0-9a-f-]+)\/projects$/.exec(parsed.pathname);
      if (membershipReplaceMatch !== null && request.method === 'POST') {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        ensurePermission(context.user, 'user:manage');
        const body = await readJson(request);
        json(response, 200, {
          user: await replaceProjectMemberships(membershipReplaceMatch[1], body.projectSlugs, context.user),
        });
        return;
      }

      const membershipMatch = /^\/forge-gateway\/api\/admin\/users\/([0-9a-f-]+)\/projects\/([a-z][a-z0-9-]{2,31})$/.exec(parsed.pathname);
      if (membershipMatch !== null && request.method === 'POST') {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        ensurePermission(context.user, 'user:manage');
        const body = await readJson(request);
        json(response, 200, {
          user: await setProjectMembership(membershipMatch[1], membershipMatch[2], body.granted, context.user),
        });
        return;
      }

      const userMatch = /^\/forge-gateway\/api\/admin\/users\/([0-9a-f-]+)\/(status|reset-password)$/.exec(parsed.pathname);
      if (userMatch !== null && request.method === 'POST') {
        const context = await requireAuthentication(request);
        requireCsrf(request, context);
        ensurePermission(context.user, 'user:manage');
        if (userMatch[2] === 'reset-password') {
          if (userMatch[1] === context.user.id) {
            await audit({
              actor: context.user.username,
              action: 'user.reset-password',
              targetType: 'user',
              targetId: userMatch[1],
              result: 'denied',
              code: 'SELF_PASSWORD_RESET_NOT_ALLOWED',
              requestId,
            });
            throw new GatewayError(
              'SELF_PASSWORD_RESET_NOT_ALLOWED',
              '不能在人员列表中重置当前登录账号，请使用“修改自己的密码”。',
              409,
            );
          }
          json(response, 200, await resetUserPassword(userMatch[1], context.user));
          return;
        }
        const body = await readJson(request);
        json(response, 200, { user: await setUserStatus(userMatch[1], body.status, context.user) });
        return;
      }

      if (request.method === 'GET' && parsed.pathname === '/forge-gateway/api/audit') {
        const context = await requireAuthentication(request);
        ensurePermission(context.user, 'audit:read');
        json(response, 200, { events: await store.readAudit(parsed.searchParams.get('limit') ?? 100) });
        return;
      }

      throw new GatewayError('NOT_FOUND', '页面或接口不存在。', 404);
    } catch (error) {
      const known = error instanceof GatewayError
        ? error
        : new GatewayError('INTERNAL_ERROR', '会话入口发生内部错误。', 500);
      if (!(error instanceof GatewayError)) console.error(error);
      json(response, known.status, {
        ok: false,
        code: known.code,
        message: known.message,
        requestId,
        ...(known.details === undefined ? {} : { details: known.details }),
      }, known.status === 401 ? { 'set-cookie': clearCookies(cookieSecure) } : {});
    }
  };

  const authorizeTaskspaceRequest = async (request) => {
      const taskId = request.headers['x-forge-taskspace-id'];
      const requestedProjectSlug = request.headers['x-forge-project-slug'] ?? legacyProject?.slug;
      const browserHost = request.headers['x-forge-browser-host'];
      const browserOrigin = request.headers['x-forge-browser-origin'];
      const fetchSite = request.headers['x-forge-browser-sec-fetch-site'];
      if (typeof taskId !== 'string' || typeof requestedProjectSlug !== 'string' || typeof browserHost !== 'string'
        || fetchSite === 'cross-site' || request.headers.cookie?.length > 8192) {
        throw new GatewayError('FORBIDDEN', '访问被拒绝。', 403);
      }
      const conversations = await store.read((state) => state.conversations.filter((entry) => (
        entry.taskId === taskId && entry.projectSlug === requestedProjectSlug
      )));
      let activeConversation = conversations.find((entry) => (
        entry.status === 'active' && Number.isInteger(entry.port)
      ));
      let context;
      if (activeConversation === undefined) {
        context = await authenticateFromCookie(request.headers.cookie);
        const recoverable = context === undefined ? undefined : conversations.find((entry) => (
          entry.ownerUserId === context.user.id && pendingProvisioningConversation(entry)
          && Number.isInteger(entry.port) && browserHost === `${bindAddress}:${entry.port}`
          && (browserOrigin === undefined || browserOrigin === ''
            || browserOrigin === `${parsedOrigin.protocol}//${bindAddress}:${entry.port}`)
        ));
        if (recoverable !== undefined) {
          // A reviewed Manager recovery can finish after the Gateway recorded a timeout.
          // Reconcile that same owned record; opening the existing URL never creates or starts a worker.
          const refreshed = await refreshProvisioningConversation(context, recoverable.id);
          conversations[conversations.findIndex((entry) => entry.id === refreshed.id)] = refreshed;
          if (refreshed.status === 'active' && Number.isInteger(refreshed.port)) activeConversation = refreshed;
        }
      }
      if (activeConversation === undefined) {
        throw new GatewayError('CONVERSATION_UNAVAILABLE', '对话未运行。', 409);
      }
      const expectedAuthority = `${bindAddress}:${activeConversation.port}`;
      if (browserHost !== expectedAuthority
        || (browserOrigin !== undefined && browserOrigin !== '' && browserOrigin !== `${parsedOrigin.protocol}//${expectedAuthority}`)) {
        throw new GatewayError('FORBIDDEN', '访问来源不匹配。', 403);
      }
      context ??= await authenticateFromCookie(request.headers.cookie);
      if (context === undefined) {
        return {
          authenticated: false,
          loginUrl: `${publicOrigin}forge-gateway/login?returnTask=${encodeURIComponent(taskId)}&project=${encodeURIComponent(requestedProjectSlug)}`,
        };
      }
      const projectAllowed = await store.read((state) => canEnterProject(state, context.user, requestedProjectSlug));
      const ownedActiveConversation = conversations.find((entry) => (
        entry.ownerUserId === context.user.id
        && entry.status === 'active'
        && entry.port === activeConversation.port
      ));
      if (!can(context.user.role, 'conversation:open-own')
        || !projectAllowed
        || ownedActiveConversation === undefined) {
        const cooldownKey = `${context.user.id}:${taskId}`;
        if ((deniedAuditCooldown.get(cooldownKey) ?? 0) < clock() - 60000) {
          deniedAuditCooldown.set(cooldownKey, clock());
          await audit({ projectSlug: requestedProjectSlug, actor: context.user.username, action: 'taskspace.access', targetType: 'taskspace', targetId: taskId, result: 'denied' });
        }
        throw new GatewayError('FORBIDDEN', '不能访问其他人员的对话。', 403);
      }
      return {
        authenticated: true,
        context,
        conversation: ownedActiveConversation,
        projectSlug: requestedProjectSlug,
        taskId,
        ...(conversations.some((entry) => entry.conversationKind === 'legacy-session') ? {
          allowedOutputSessionIds: [...new Set(conversations
            .filter((entry) => entry.conversationKind === 'legacy-session'
              && entry.ownerUserId === context.user.id && entry.status === 'active'
              && typeof entry.legacySessionId === 'string')
            .map((entry) => validateInput(validateConversationId, entry.legacySessionId, 'INVALID_LEGACY_SESSION_ID')))].sort(),
        } : {}),
      };
  };

  const internalHandler = async (request, response) => {
    const prepareController = request.method === 'POST' && request.url === '/internal/taskspace-execution-prepare'
      ? new AbortController() : undefined;
    const cancelPrepare = () => {
      if (!response.writableEnded) prepareController.abort();
    };
    if (prepareController) response.once('close', cancelPrepare);
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        await health(request, response);
        return;
      }
      if (await admitRequest(request, response) === undefined) return;
      if (request.method === 'POST' && request.url === '/internal/taskspace-execution-renewal-authority') {
        if (typeof internalServer.address() !== 'string') {
          throw new GatewayError('EXECUTION_RENEWAL_AUTHORITY_DENIED', '执行续期授权查询仅允许项目内部连接。', 403);
        }
        const input = await readJson(request);
        if (!isExecutionRenewalAuthorityRequest(input)) {
          throw new GatewayError('EXECUTION_RENEWAL_AUTHORITY_MISMATCH', '执行续期身份无效。', 409);
        }
        if (await directory.get(input.projectSlug) === undefined) {
          throw new GatewayError('EXECUTION_RENEWAL_AUTHORITY_DENIED', '当前项目授权不可用。', 403);
        }
        const token = await managerTokenForProject(input.projectSlug);
        const bearer = request.headers.authorization;
        if (typeof token !== 'string' || token.length < 32 || typeof bearer !== 'string'
          || !bearer.startsWith('Bearer ') || !timingSafeTextEqual(bearer.slice(7), token)) {
          throw new GatewayError('EXECUTION_RENEWAL_AUTHORITY_DENIED', '项目内部身份认证失败。', 403);
        }
        const authorizedActionCeiling = await store.read((state) => {
          const user = state.users.find((entry) => entry.id === input.actorUserId
            && entry.username === input.actorUsername && entry.status === 'active');
          const conversation = state.conversations.find((entry) => entry.id === input.conversationId
            && entry.projectSlug === input.projectSlug && entry.taskId === input.taskId
            && entry.ownerUserId === input.actorUserId && entry.status === 'active');
          if (!user || !conversation || !canEnterProject(state, user, input.projectSlug)
            || !can(user.role, 'conversation:open-own') || !can(user.role, 'workspace:write-own')) return null;
          return can(user.role, 'release:own') ? 'release'
            : can(user.role, 'git:checkpoint-own') ? 'git-checkpoint' : 'workspace-write';
        });
        if (authorizedActionCeiling === null || ['workspace-write', 'git-checkpoint', 'release'].indexOf(input.actionCeiling)
          > ['workspace-write', 'git-checkpoint', 'release'].indexOf(authorizedActionCeiling)) {
          throw new GatewayError('EXECUTION_RENEWAL_AUTHORITY_DENIED', '当前账户、项目或对话不再允许该执行权限。', 403);
        }
        json(response, 200, { ...input, authorizedActionCeiling, checkedAt: new Date(clock()).toISOString() });
        return;
      }
      if (request.method !== 'POST'
        || !['/internal/taskspace-authorize', '/internal/taskspace-execution-prepare'].includes(request.url)) {
        throw new GatewayError('NOT_FOUND', '接口不存在。', 404);
      }
      const authorization = await authorizeTaskspaceRequest(request);
      if (!authorization.authenticated) {
        empty(response, 401, { 'x-forge-login-url': authorization.loginUrl });
        return;
      }
      if (request.url === '/internal/taskspace-authorize') {
        empty(response, 204, authorization.allowedOutputSessionIds === undefined ? {} : {
          'x-forge-output-session-ids': JSON.stringify(authorization.allowedOutputSessionIds),
        });
        return;
      }
      const ingress = validateExecutionPrepareIngress(await readJson(request, MAX_EXECUTION_PREPARE_BYTES));
      let result;
      try {
        const executionManager = await resolveManager(authorization.projectSlug);
        prepareController.signal.throwIfAborted();
        result = await executionManager.prepareExecution({
          ...ingress,
          projectSlug: authorization.projectSlug,
          taskId: authorization.taskId,
          conversationId: authorization.conversation.id,
          actorUserId: authorization.context.user.id,
          actorUsername: authorization.context.user.username,
          workspaceWriteAuthorized: can(authorization.context.user.role, 'workspace:write-own'),
          ...(can(authorization.context.user.role, 'workspace:write-own') ? {
            authorizedActionCeiling: can(authorization.context.user.role, 'release:own')
              ? 'release'
              : can(authorization.context.user.role, 'git:checkpoint-own')
                ? 'git-checkpoint' : 'workspace-write',
          } : {}),
        }, { signal: prepareController.signal });
        prepareController.signal.throwIfAborted();
      } catch (error) {
        throw managerError(error);
      }
      await audit({
        projectSlug: authorization.projectSlug,
        actor: authorization.context.user.username,
        action: 'execution.prepare',
        targetType: 'taskspace',
        targetId: authorization.taskId,
        result: 'success',
        requestId: ingress.requestId,
      });
      json(response, 200, result);
    } catch (error) {
      if (prepareController?.signal.aborted && response.destroyed) return;
      const known = error instanceof GatewayError
        ? error
        : new GatewayError('INTERNAL_ERROR', '访问授权服务不可用。', 503);
      if (!(error instanceof GatewayError)) console.error(error);
      json(response, known.status, { ok: false, code: known.code, message: known.message });
    } finally {
      if (prepareController) response.off('close', cancelPrepare);
    }
  };

  const operatorHandler = async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        await health(request, response);
        return;
      }
      if (await admitRequest(request, response) === undefined) return;
      const authorization = request.headers.authorization;
      if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')
        || !timingSafeTextEqual(authorization.slice(7), operatorToken)) {
        throw new GatewayError('UNAUTHORIZED', '未授权。', 401);
      }
      const actor = { id: 'operator', username: 'operator', role: 'admin' };
      if (request.method === 'GET' && request.url === '/v1/users') {
        const users = await store.read((state) => state.users.map((user) => ({
          ...publicUser(user),
          projectSlugs: state.memberships
            .filter((entry) => entry.userId === user.id && entry.access === 'member')
            .map((entry) => entry.projectSlug)
            .sort(),
        })).sort((a, b) => a.username.localeCompare(b.username)));
        json(response, 200, { users });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/users') {
        json(response, 201, await createUser(await readJson(request), actor));
        return;
      }
      const parsed = new URL(request.url ?? '/', 'http://operator.invalid');
      const memberships = /^\/v1\/users\/([0-9a-f-]+)\/projects$/.exec(parsed.pathname);
      if (request.method === 'POST' && memberships !== null) {
        json(response, 200, { user: await replaceProjectMemberships(memberships[1], (await readJson(request)).projectSlugs, actor) });
        return;
      }
      const match = /^\/v1\/users\/([0-9a-f-]+)\/(status|reset-password)$/.exec(parsed.pathname);
      if (request.method === 'POST' && match !== null) {
        if (match[2] === 'reset-password') json(response, 200, await resetUserPassword(match[1], actor));
        else json(response, 200, { user: await setUserStatus(match[1], (await readJson(request)).status, actor) });
        return;
      }
      throw new GatewayError('NOT_FOUND', '接口不存在。', 404);
    } catch (error) {
      const known = error instanceof GatewayError
        ? error
        : new GatewayError('INTERNAL_ERROR', '操作员接口发生内部错误。', 500);
      if (!(error instanceof GatewayError)) console.error(error);
      json(response, known.status, { ok: false, code: known.code, message: known.message });
    }
  };

  const internalServer = trackServer(http.createServer(trackRequests(internalHandler)));
  return {
    publicServer: trackServer(http.createServer(trackRequests(publicHandler))),
    internalServer,
    operatorServer: trackServer(http.createServer(trackRequests(operatorHandler))),
    destroyTrackedConnections,
  };
}

export function readConversationGatewayRuntimeConfig(environment = process.env) {
  const stateRoot = environment.CONVERSATION_GATEWAY_STATE_ROOT;
  const staticRoot = environment.CONVERSATION_GATEWAY_STATIC_ROOT ?? '/usr/local/share/conversation-gateway';
  const publicOrigin = environment.CONVERSATION_GATEWAY_PUBLIC_ORIGIN;
  const bindAddress = environment.CONVERSATION_GATEWAY_BIND_ADDRESS;
  const publicPort = Number.parseInt(environment.CONVERSATION_GATEWAY_PUBLIC_PORT ?? '', 10);
  const internalAddress = environment.CONVERSATION_GATEWAY_INTERNAL_ADDRESS ?? '0.0.0.0';
  const internalPort = Number.parseInt(environment.CONVERSATION_GATEWAY_INTERNAL_PORT ?? '3120', 10);
  const internalSocket = environment.CONVERSATION_GATEWAY_INTERNAL_SOCKET;
  const managerUrl = environment.CONVERSATION_MANAGER_URL;
  const managerTokenFile = environment.CONVERSATION_MANAGER_TOKEN_FILE;
  const projectRegistryFile = environment.CONVERSATION_PROJECT_REGISTRY_FILE;
  const projectCapabilityRoot = environment.CONVERSATION_PROJECT_CAPABILITY_ROOT;
  const operatorTokenFile = environment.CONVERSATION_OPERATOR_TOKEN_FILE;
  const operatorSocket = environment.CONVERSATION_OPERATOR_SOCKET;
  const projectSlug = environment.CONVERSATION_PROJECT_SLUG;
  const maintenanceFencePath = environment.CONVERSATION_GATEWAY_MAINTENANCE_FENCE_FILE;
  const cookieSecure = environment.CONVERSATION_GATEWAY_COOKIE_SECURE === 'true';
  const platformMode = Boolean(projectRegistryFile && projectCapabilityRoot);
  const legacyMode = Boolean(managerUrl && managerTokenFile && projectSlug);
  if (!stateRoot || !publicOrigin || !bindAddress
    || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535
    || !operatorTokenFile || !operatorSocket
    || typeof maintenanceFencePath !== 'string' || !path.isAbsolute(maintenanceFencePath)
    || platformMode === legacyMode) {
    throw new Error('Conversation gateway environment is incomplete.');
  }
  if ((platformMode && (typeof internalSocket !== 'string' || !path.isAbsolute(internalSocket)))
    || (legacyMode && (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535))) {
    throw new Error('Conversation gateway authorization transport is incomplete.');
  }
  return {
    stateRoot,
    staticRoot,
    publicOrigin,
    bindAddress,
    publicPort,
    internalAddress,
    internalPort,
    internalSocket,
    managerUrl,
    managerTokenFile,
    projectRegistryFile,
    projectCapabilityRoot,
    operatorTokenFile,
    operatorSocket,
    projectSlug,
    maintenanceFencePath,
    cookieSecure,
    platformMode,
  };
}

async function startFromCommandLine() {
  const {
    stateRoot,
    staticRoot,
    publicOrigin,
    bindAddress,
    publicPort,
    internalAddress,
    internalPort,
    internalSocket,
    managerUrl,
    managerTokenFile,
    projectRegistryFile,
    projectCapabilityRoot,
    operatorTokenFile,
    operatorSocket,
    projectSlug,
    maintenanceFencePath,
    cookieSecure,
    platformMode,
  } = readConversationGatewayRuntimeConfig();
  const operatorToken = (await readFile(operatorTokenFile, 'utf8')).trim();
  const store = new ConversationStateStore({ stateRoot });
  const initialized = await store.initialize({ defaultProjectSlug: platformMode ? undefined : projectSlug });
  let manager;
  let managerForProject;
  let managerTokenForProject;
  let projectDirectory;
  if (platformMode) {
    projectDirectory = new RegistryProjectDirectory({
      registryPath: projectRegistryFile,
      capabilityRoot: projectCapabilityRoot,
    });
    const managerClients = new Map();
    managerForProject = async (scopedProjectSlug) => {
      if (await projectDirectory.get(scopedProjectSlug) === undefined) {
        throw new GatewayError('PROJECT_NOT_FOUND', '项目不存在。', 404);
      }
      if (managerClients.has(scopedProjectSlug)) return managerClients.get(scopedProjectSlug);
      const { socketPath, tokenPath } = projectDirectory.capabilityPaths(scopedProjectSlug);
      const token = (await readFile(tokenPath, 'utf8')).trim();
      const client = createManagerClient({ socketPath, token });
      managerClients.set(scopedProjectSlug, client);
      return client;
    };
  } else {
    const managerToken = (await readFile(managerTokenFile, 'utf8')).trim();
    managerTokenForProject = async (slug) => {
      if (slug !== projectSlug) throw new Error('Project capability is unavailable');
      return managerToken;
    };
    manager = createManagerClient({ baseUrl: managerUrl, token: managerToken });
  }
  const servers = await createConversationGateway({
    store,
    deliveryStore: process.env.DELIVERY_CENTER_SOCKET
      ? createDeliveryCenterClient({ socketPath: process.env.DELIVERY_CENTER_SOCKET }) : undefined,
    manager,
    managerForProject,
    managerTokenForProject,
    projectDirectory,
    staticRoot,
    publicOrigin,
    bindAddress,
    projectSlug,
    maintenanceFencePath,
    cookieSecure,
    operatorToken,
  });
  for (const [server, label] of [
    [servers.publicServer, 'public'],
    [servers.internalServer, 'internal'],
    [servers.operatorServer, 'operator'],
  ]) {
    server.on('error', (error) => {
      console.error(`Conversation gateway ${label} server failed: ${error.message}`);
      process.exit(1);
    });
  }
  servers.publicServer.listen(publicPort, '0.0.0.0', () => {
    console.log(`Conversation gateway public entry listening on 0.0.0.0:${publicPort}.`);
  });
  if (platformMode) {
    await mkdir(path.dirname(internalSocket), { recursive: true, mode: 0o700 });
    await unlink(internalSocket).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    servers.internalServer.listen(internalSocket, async () => {
      await chmod(internalSocket, 0o660);
      console.log(`Conversation gateway authorization socket listening at ${internalSocket}.`);
    });
  } else {
    servers.internalServer.listen(internalPort, internalAddress, () => {
      console.log(`Conversation gateway authorization endpoint listening on ${internalAddress}:${internalPort}.`);
    });
  }
  await unlink(operatorSocket).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  servers.operatorServer.listen(operatorSocket, async () => {
    await chmod(operatorSocket, 0o660);
    console.log(`Conversation gateway operator socket listening at ${operatorSocket}.`);
  });
  if (initialized.bootstrapCreated) {
    console.log(`One-time administrator credential created at ${store.bootstrapPath}.`);
  }
  const shutdown = () => {
    let pending = 3;
    const done = () => { pending -= 1; if (pending === 0) process.exit(0); };
    servers.destroyTrackedConnections();
    servers.publicServer.close(done);
    servers.internalServer.close(done);
    servers.operatorServer.close(done);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
}

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  startFromCommandLine().catch((error) => {
    console.error(`Conversation gateway configuration failed: ${error.message}`);
    process.exit(2);
  });
}
