import { constants, createCipheriv, createDecipheriv, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';

// Protocol: the pinned candidate's login, crypto-config and crypto-interceptor clients.
// The caller owns candidate-origin pinning and plan authorization. No credentials or
// arbitrary headers are accepted by request(), and no request is automatically retried.
const MAX_BODY_BYTES = 1024 * 1024;
const REQUIRED_REPLAY_EXCLUDES = [
  '/auth/captcha', '/auth/captcha/**', '/auth/loginConfig', '/auth/tenant/options',
  '/auth/tenant/assets/**', '/social/callback', '/crypto/config', '/crypto/public-key', '/crypto/exchange',
];
const REQUIRED_CRYPTO_EXCLUDES = [...REQUIRED_REPLAY_EXCLUDES, '/auth/login', '/api/config/manage/crypto'];

class CandidateAuthError extends Error {
  constructor(code) { super(code); this.name = 'CandidateAuthError'; this.code = code; this.status = 'blocked'; }
}
function deny(code) { throw new CandidateAuthError(`CANDIDATE_AUTH_${code}`); }
function object(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function scalarId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 || Number.isSafeInteger(value); }
function exactKeys(value, allowed) { return object(value) && Object.keys(value).every(key => allowed.includes(key)); }
function boolean(value, fallback) {
  if ([true, 'true', 1, '1'].includes(value)) return true;
  if ([false, 'false', 0, '0'].includes(value)) return false;
  return fallback;
}
function paths(value, required) {
  if (value !== undefined && (!Array.isArray(value) || value.length > 128 || value.some(p => typeof p !== 'string' || p.length > 2048))) deny('CONFIG_INVALID');
  return [...new Set([...(value || []).map(p => p.trim()).filter(Boolean), ...required])];
}
function configuration(value) {
  if (!object(value)) deny('CONFIG_INVALID');
  const algorithm = String(value.algorithm || 'SM4').toUpperCase();
  if (!['SM4', 'AES'].includes(algorithm)) deny('ALGORITHM_UNSUPPORTED');
  return {
    enabled: boolean(value.enabled, true), enableApiCrypto: boolean(value.enableApiCrypto, true),
    enableDynamicKey: boolean(value.enableDynamicKey, true), algorithm,
    enableReplay: boolean(value.enableReplay ?? value.enableReplayProtection, false),
    excludePaths: paths(value.excludePaths, REQUIRED_CRYPTO_EXCLUDES), includePaths: paths(value.includePaths, []),
    replayExcludePaths: paths(value.replayExcludePaths, REQUIRED_REPLAY_EXCLUDES),
  };
}
function matches(path, pattern) {
  // Preserve the candidate's actual matcher rather than inventing a different route policy.
  try { return new RegExp(`^${pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`).test(path); }
  catch { deny('CONFIG_INVALID'); }
}
function validatePath(path) {
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/') || path.startsWith('//')
      || /[\\\s#\u0000-\u001f\u007f]/.test(path) || /%(?:00|0a|0d|2f|5c|2e|25)/i.test(path)) deny('PATH_INVALID');
  const parsed = new URL(path, 'http://candidate.invalid');
  if (parsed.origin !== 'http://candidate.invalid' || parsed.pathname !== path.split('?')[0]) deny('PATH_INVALID');
  return parsed.pathname;
}
function rsa(value, publicKey) {
  if (typeof publicKey !== 'string' || publicKey.length > 16384) deny('PUBLIC_KEY_INVALID');
  const pem = publicKey.includes('-----BEGIN') ? publicKey
    : `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
  try { return publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(value, 'utf8')).toString('base64'); }
  catch { deny('RSA_FAILED'); }
}
function crypt(value, key, algorithm, decrypt = false) {
  try {
    const cipher = (decrypt ? createDecipheriv : createCipheriv)(algorithm === 'SM4' ? 'sm4-ecb' : 'aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(value), cipher.final()]);
  } catch { deny(decrypt ? 'DECRYPT_FAILED' : 'ENCRYPT_FAILED'); }
}
function isBase64(value) {
  return typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value;
}
async function readBytes(response) {
  if (!response || !Number.isInteger(response.status)) deny('RESPONSE_INVALID');
  if (response.redirected || response.status >= 300 && response.status < 400) deny('REDIRECT_DENIED');
  if (Number(response.headers?.get('content-length')) > MAX_BODY_BYTES) deny('RESPONSE_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); deny('RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof CandidateAuthError) throw error;
    deny('RESPONSE_INVALID');
  } finally { reader.releaseLock(); }
}

async function readJson(response) {
  const bytes = await readBytes(response);
  if (!bytes.length) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { deny('RESPONSE_INVALID'); }
}

function multipartBody(value) {
  const safeKey = key => typeof key === 'string' && key.length > 0 && key.length <= 128
    && !['__proto__', 'prototype', 'constructor'].includes(key) && !/[\u0000-\u001f\u007f]/u.test(key);
  const plain = item => object(item) && [Object.prototype, null].includes(Object.getPrototypeOf(item));
  if (!plain(value) || !exactKeys(value, ['fields', 'file']) || !plain(value.fields) || !plain(value.file)
      || !exactKeys(value.file, ['fieldName', 'fileName', 'contentType', 'bytesBase64'])) deny('REQUEST_INVALID');
  const { fieldName, fileName, contentType, bytesBase64 } = value.file;
  const fields = Object.entries(value.fields);
  if (fields.length > 16 || fields.some(([name, field]) => !safeKey(name)
      || typeof field !== 'string' || Buffer.byteLength(field) > 4096)
      || [fieldName, fileName].some(name => !safeKey(name) || /^[.]{1,2}$/u.test(name) || /[\p{Cc}/\\:"]/u.test(name))
      || typeof contentType !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u.test(contentType)
      || typeof bytesBase64 !== 'string' || bytesBase64.length > 21848 || !isBase64(bytesBase64)) deny('REQUEST_INVALID');
  const bytes = Buffer.from(bytesBase64, 'base64');
  if (bytes.length > 16384) deny('REQUEST_TOO_LARGE');
  const form = new FormData();
  for (const [name, field] of fields) form.append(name, field);
  form.append(fieldName, new Blob([bytes], { type: contentType }), fileName);
  return form;
}

/** fetchCandidate(path, init) MUST pin the protected isolated candidate; never log init. */
export async function createForgeCandidateAuthenticatedSession({ fetchCandidate, credential, loginContext } = {}) {
  if (typeof fetchCandidate !== 'function' || !exactKeys(credential, ['username', 'password'])
      || typeof credential.username !== 'string' || !credential.username || credential.username.length > 256
      || typeof credential.password !== 'string' || !credential.password || credential.password.length > 4096
      || !exactKeys(loginContext, ['tenantId', 'userClient', 'appId']) || !scalarId(loginContext.tenantId)
      || ![loginContext.userClient, loginContext.appId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256)) deny('INPUT_INVALID');
  const context = { ...loginContext };
  const secrets = [credential.password];
  let token = ''; let key = null; let config = null; let closed = false;
  const remember = value => { if (value && !secrets.includes(value)) secrets.push(value); return value; };
  const close = () => { closed = true; token = ''; key?.fill(0); key = null; secrets.length = 0; credential = null; };
  const redact = value => {
    if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
    if (Array.isArray(value)) return value.map(redact);
    if (!object(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name,
      /(?:password|token|secret|sessionkey|encryptedkey|authorization|cookie)/i.test(name) ? '[REDACTED]' : redact(entry)]));
  };
  const exchange = async (path, method = 'GET', body, extraHeaders = {}, options = {}) => {
    validatePath(path);
    const headers = { Accept: 'application/json', 'Accept-Language': 'zh-CN', traceId: `${Date.now()}${randomBytes(4).toString('hex')}`, ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (config?.enabled && config.enableReplay && !config.replayExcludePaths.some(p => matches(path.split('?')[0], p))) {
      headers['X-Timestamp'] = String(Date.now()); headers['X-Nonce'] = randomUUID();
    }
    let payload;
    try { if (body !== undefined) payload = JSON.stringify(body); } catch { deny('REQUEST_INVALID'); }
    if (options.multipart !== undefined) payload = options.multipart;
    else if (payload !== undefined) {
      if (Buffer.byteLength(payload, 'utf8') > 32768) deny('REQUEST_TOO_LARGE');
      headers['Content-Type'] = 'application/json';
    }
    let response;
    try { response = await fetchCandidate(path, { method, headers, ...(payload === undefined ? {} : { body: payload }), redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) }); }
    catch { deny('TRANSPORT_FAILED'); }
    if (options.responseType === 'binary') {
      const bodyBytes = await readBytes(response);
      const header = name => {
        const value = response.headers?.get(name) ?? '';
        if (value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) deny('RESPONSE_INVALID');
        return redact(value);
      };
      return { httpStatus: response.status, bodyBytes, contentType: header('content-type'), contentDisposition: header('content-disposition') };
    }
    let data = await readJson(response);
    for (let depth = 0; depth < 2 && object(data) && data.algorithm && data.data; depth++) {
      if (!key || !['SM4', 'AES'].includes(data.algorithm) || !isBase64(data.data)) deny('DECRYPT_FAILED');
      try { data = JSON.parse(crypt(Buffer.from(data.data, 'base64'), key, data.algorithm, true).toString('utf8')); }
      catch { deny('DECRYPT_FAILED'); }
    }
    return { httpStatus: response.status, body: data };
  };
  const success = (result, code) => {
    if (result.httpStatus < 200 || result.httpStatus >= 300 || result.body?.code !== 200) deny(code);
    return result.body.data;
  };
  const refreshConfig = async () => { config = configuration(success(await exchange('/crypto/config'), 'CONFIG_UNAVAILABLE')); };
  const establishKey = async () => {
    if (!config.enabled || !config.enableApiCrypto) return;
    if (!config.enableDynamicKey) deny('STATIC_KEY_UNAVAILABLE');
    const publicKey = success(await exchange('/crypto/public-key'), 'PUBLIC_KEY_INVALID')?.publicKey;
    key?.fill(0); key = randomBytes(16);
    remember(key.toString('base64')); remember(key.toString('hex'));
    const encryptedKey = remember(rsa(key.toString('base64'), publicKey));
    success(await exchange('/crypto/exchange', 'POST', { encryptedKey }, { 'X-Session-Id': token }), 'KEY_EXCHANGE_FAILED');
  };
  const authorizedRequest = async ({ method, path, body, multipart, responseType }) => {
    // Explicit encrypted requests refresh real server configuration, matching the candidate client.
    await refreshConfig();
    const pathname = path.split('?')[0];
    const encrypted = config.enabled && config.enableApiCrypto && !config.excludePaths.some(p => matches(pathname, p))
      && (!config.includePaths.length || config.includePaths.some(p => matches(pathname, p)));
    if (multipart !== undefined && encrypted) deny('MULTIPART_CRYPTO_UNSUPPORTED');
    if (encrypted && !key) await establishKey();
    if (encrypted && body !== undefined) body = { data: crypt(Buffer.from(JSON.stringify(body)), key, config.algorithm).toString('base64'), algorithm: config.algorithm };
    return exchange(path, method, body, {}, { multipart, responseType });
  };
  try {
    const query = new URLSearchParams({ userClient: context.userClient, tenantId: String(context.tenantId) });
    const loginConfig = success(await exchange(`/auth/loginConfig?${query}`), 'LOGIN_CONFIG_UNAVAILABLE');
    if (!object(loginConfig)) deny('LOGIN_CONFIG_UNAVAILABLE');
    if (loginConfig.enableCaptcha !== false) deny('CHALLENGE_REQUIRED');
    await refreshConfig();
    let password = credential.password;
    if (loginConfig.enablePasswordEncryption !== false) {
      const publicKey = success(await exchange('/crypto/public-key'), 'PUBLIC_KEY_INVALID')?.publicKey;
      password = remember(rsa(password, publicKey));
    }
    const login = success(await exchange('/auth/login', 'POST', { username: credential.username, password,
      code: '', codeKey: '', phone: '', tenantId: context.tenantId, authType: 'password', userClient: context.userClient, appId: context.appId }), 'LOGIN_REJECTED');
    if (!object(login)) deny('LOGIN_REJECTED');
    if (login.forcePasswordChange === true || login.userInfo?.forcePasswordChange === true) deny('PASSWORD_CHANGE_REQUIRED');
    if (typeof (login.accessToken || login.token) !== 'string' || !(login.accessToken || login.token)) deny('CHALLENGE_REQUIRED');
    token = remember(login.accessToken || login.token);
    await establishKey();
    const user = login.userInfo || success(await authorizedRequest({ method: 'GET', path: '/auth/userInfo' }), 'IDENTITY_UNAVAILABLE');
    if (!object(user) || !scalarId(user.userId) || !scalarId(user.tenantId) || user.username !== credential.username
        || String(user.tenantId) !== String(context.tenantId)) deny('IDENTITY_MISMATCH');
    if (user.forcePasswordChange === true) deny('PASSWORD_CHANGE_REQUIRED');
    const roleKeys = user.roleKeys ?? []; const orgIds = user.orgIds ?? [];
    if (!Array.isArray(roleKeys) || roleKeys.length > 256 || !roleKeys.every(scalarId)
        || !Array.isArray(orgIds) || orgIds.length > 256 || !orgIds.every(scalarId)) deny('IDENTITY_UNAVAILABLE');
    const identity = Object.freeze({ userId: user.userId, tenantId: user.tenantId,
      roleKeys: Object.freeze([...roleKeys]), orgIds: Object.freeze([...orgIds]) });
    credential = null;
    return Object.freeze({ identity, close, async request(input) {
      if (closed) deny('SESSION_CLOSED');
      if (!exactKeys(input, ['method', 'path', 'body', 'multipart', 'responseType']) || !['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)
          || input.body !== undefined && (!object(input.body) && !Array.isArray(input.body))
          || input.responseType !== undefined && input.responseType !== 'binary'
          || input.multipart !== undefined && (input.method !== 'POST' || input.body !== undefined)
          || ['GET', 'HEAD'].includes(input.method) && input.body !== undefined) deny('REQUEST_INVALID');
      const pathname = validatePath(input.path);
      if (/^\/(?:auth|crypto)(?:\/|$)/.test(pathname) || pathname === '/api/config/manage/crypto') deny('PATH_RESERVED');
      const multipart = input.multipart === undefined ? undefined : multipartBody(input.multipart);
      try {
        const result = await authorizedRequest({ ...input, multipart });
        return input.responseType === 'binary' ? result : redact(result);
      }
      catch (error) { if (error instanceof CandidateAuthError) throw error; deny('REQUEST_FAILED'); }
    } });
  } catch (error) {
    close();
    if (error instanceof CandidateAuthError) throw error;
    deny('PROTOCOL_FAILED');
  }
}
