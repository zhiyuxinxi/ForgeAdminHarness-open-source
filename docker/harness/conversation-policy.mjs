import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const CONVERSATION_STATE_SCHEMA_VERSION = 2;
export const SESSION_COOKIE = 'forge_gateway_session';
export const CSRF_COOKIE = 'forge_gateway_csrf';
export const PREAUTH_COOKIE = 'forge_gateway_preauth';
export const GATEWAY_COOKIE_NAMES = new Set([
  SESSION_COOKIE,
  CSRF_COOKIE,
  PREAUTH_COOKIE,
]);

export const ROLES = Object.freeze(['admin', 'member', 'auditor']);

const ROLE_PERMISSIONS = Object.freeze({
  admin: new Set([
    'conversation:create',
    'conversation:open-own',
    'workspace:write-own',
    'git:checkpoint-own',
    'release:own',
    'conversation:rename-own',
    'conversation:stop-own',
    'material:read-shared',
    'material:review',
    'system:read',
    'user:manage',
    'audit:read',
  ]),
  member: new Set([
    'conversation:create',
    'conversation:open-own',
    'workspace:write-own',
    'git:checkpoint-own',
    'release:own',
    'conversation:rename-own',
    'conversation:stop-own',
    'material:read-shared',
    'system:read',
  ]),
  auditor: new Set([
    'system:read',
    'audit:read',
  ]),
});

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function can(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) === true;
}

export function normalizeUsername(value) {
  if (typeof value !== 'string') throw new Error('用户名必须是字符串。');
  const normalized = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new Error('用户名必须为 3-64 位小写字母、数字、点、下划线或连字符。');
  }
  return normalized;
}

export function normalizeDisplayName(value) {
  return normalizeHumanText(value, '显示名称', 1, 80);
}

export function normalizeConversationTitle(value) {
  return normalizeHumanText(value, '对话名称', 1, 100);
}

function normalizeHumanText(value, label, minimum, maximum) {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串。`);
  const normalized = value.trim().replace(/\s+/gu, ' ');
  const length = Array.from(normalized).length;
  if (length < minimum || length > maximum || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new Error(`${label}长度必须为 ${minimum}-${maximum} 个字符，且不能包含控制字符。`);
  }
  return normalized;
}

export function validateRole(value) {
  if (!ROLES.includes(value)) throw new Error('角色必须是 admin、member 或 auditor。');
  return value;
}

export function validateTaskId(value) {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    throw new Error('TaskSpace 标识不合法。');
  }
  return value;
}

export function validateConversationId(value) {
  if (typeof value !== 'string' || !CONVERSATION_ID_PATTERN.test(value)) {
    throw new Error('对话标识不合法。');
  }
  return value;
}

export function validateIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Error('缺少合法的幂等键。');
  }
  return value;
}

export function validatePassword(value, username = '') {
  if (typeof value !== 'string') throw new Error('密码必须是字符串。');
  const length = Array.from(value).length;
  if (length < 14 || length > 256) throw new Error('密码长度必须为 14-256 个字符。');
  if (value.trim().length === 0 || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error('密码不能只包含空白或控制字符。');
  }
  if (username && value.toLowerCase().includes(username.toLowerCase())) {
    throw new Error('密码不能包含用户名。');
  }
  return value;
}

export async function hashPassword(password) {
  validatePassword(password);
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    Buffer.from(derived).toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (salt.length !== 16 || expected.length !== SCRYPT_KEY_BYTES) return false;
  const actual = Buffer.from(await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  }));
  return crypto.timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 128) {
    throw new Error('随机凭据长度不合法。');
  }
  return crypto.randomBytes(bytes).toString('base64url');
}

export function tokenHash(value) {
  if (typeof value !== 'string') return '';
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function timingSafeTextEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function cookieValue(header, name) {
  if (typeof header !== 'string') return undefined;
  for (const item of header.split(';')) {
    const delimiter = item.indexOf('=');
    if (delimiter < 1 || item.slice(0, delimiter).trim() !== name) continue;
    const value = item.slice(delimiter + 1).trim();
    return /^[A-Za-z0-9_-]{16,512}$/.test(value) ? value : undefined;
  }
  return undefined;
}

export function stripGatewayCookies(header) {
  if (typeof header !== 'string') return undefined;
  const retained = header
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => {
      const delimiter = entry.indexOf('=');
      if (delimiter < 1) return false;
      const name = entry.slice(0, delimiter).trim();
      return !GATEWAY_COOKIE_NAMES.has(name) && !name.startsWith('forge_gateway_');
    });
  return retained.length === 0 ? undefined : retained.join('; ');
}

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword === true,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function publicConversation(conversation) {
  return {
    id: conversation.id,
    taskId: conversation.taskId,
    projectSlug: conversation.projectSlug,
    title: conversation.title,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastOpenedAt: conversation.lastOpenedAt ?? null,
    lastError: conversation.lastError ?? null,
    kind: conversation.conversationKind === 'legacy-session' ? 'legacy-session' : 'taskspace',
  };
}

export function newTaskId() {
  return `c-${crypto.randomBytes(12).toString('hex')}`;
}
