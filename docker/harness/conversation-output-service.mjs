import http from 'node:http';
import {
  listPinnedDshConversationSessions, readPinnedDshConversationHistory,
} from './forge-recover-headless-execution.mjs';
import { ConversationOutputError, projectConversationOutput } from './conversation-output-projection.mjs';

const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RESPONSE_LIMIT = 8 * 1024 * 1024;

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8',
    'content-length': body.length, 'x-content-type-options': 'nosniff' });
  response.end(body);
}

function uploadJson(target, method, pathname, value) {
  const body = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: target.host, port: target.port, path: pathname, method,
      headers: { 'x-forge-upload-token': target.token, 'content-type': 'application/json',
        ...(body === undefined ? {} : { 'content-length': body.length }) }, timeout: 60_000 }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) res.destroy(new Error('OUTPUT_RESPONSE_TOO_LARGE'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        let result;
        try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { reject(new ConversationOutputError('OUTPUT_SERVICE_UNAVAILABLE', '对话文件服务暂不可用。', 502)); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new ConversationOutputError(/^OUTPUT_[A-Z_]+$|^PROJECT_QUOTA_EXCEEDED$/u.test(result.code) ? result.code : 'OUTPUT_SAVE_FAILED',
            '对话文件尚未保存，请检查空间或稍后重试；原对话仍保留。', res.statusCode));
        } else resolve(result);
      });
    });
    req.on('timeout', () => req.destroy(new Error('OUTPUT_SERVICE_TIMEOUT')));
    req.on('error', reject);
    req.end(body);
  });
}

export function phaseFilesUrlForConversation({ loginUrl, projectSlug, conversationId } = {}) {
  if (!/^[a-z][a-z0-9-]{2,31}$/u.test(projectSlug ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(conversationId ?? '')) return undefined;
  let url;
  try { url = new URL(loginUrl); } catch { return undefined; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
  url.pathname = '/forge-gateway/'; url.search = ''; url.hash = '';
  url.searchParams.set('project', projectSlug); url.searchParams.set('phaseFiles', conversationId);
  return url.href;
}

export function createConversationOutputService({ port, uploadTarget, secrets = [], intervalMs = 30_000, phaseFilesContext }) {
  const phaseFilesUrl = phaseFilesUrlForConversation(phaseFilesContext);
  const inFlight = new Map();
  const archivedRevision = new Map();
  const failures = new Map();
  let timer;
  let stopped = false;
  let enabled;

  async function available() {
    if (uploadTarget === undefined) return false;
    if (enabled === undefined) enabled = (await uploadJson(uploadTarget, 'GET', '/config')).conversationOutputs === true;
    return enabled;
  }

  async function save(sessionId) {
    if (!SESSION.test(sessionId ?? '')) throw new ConversationOutputError('OUTPUT_SESSION_INVALID', '请先选择要保存的对话。');
    if (!await available()) throw new ConversationOutputError('OUTPUT_UNAVAILABLE', '此工作舱尚未启用对话归档。', 503);
    if (inFlight.has(sessionId)) return inFlight.get(sessionId);
    const pending = (async () => {
      const history = await readPinnedDshConversationHistory({ port, sessionId });
      const snapshot = projectConversationOutput(history, { secrets: [...secrets, uploadTarget.token] });
      const result = await uploadJson(uploadTarget, 'POST', '/outputs', snapshot);
      failures.delete(sessionId);
      if (!history.session.running && snapshot.status !== 'running') archivedRevision.set(sessionId, history.session.updatedAt);
      return result;
    })();
    inFlight.set(sessionId, pending);
    try { return await pending; }
    catch (error) { failures.set(sessionId, error.code ?? 'OUTPUT_SAVE_FAILED'); throw error; }
    finally { inFlight.delete(sessionId); }
  }

  async function captureIdleSessions() {
    if (!await available()) return;
    const sessions = await listPinnedDshConversationSessions({ port });
    for (const session of sessions) {
      if (stopped) return;
      if (!session.running && archivedRevision.get(session.sessionId) !== session.updatedAt) {
        try { await save(session.sessionId); } catch { /* Report per-session failure through the file panel. */ }
      }
    }
  }

  function start() {
    if (timer !== undefined || uploadTarget === undefined) return;
    stopped = false;
    const tick = async () => {
      try { await captureIdleSessions(); } catch { /* A temporary service outage must not interrupt business execution. */ }
      if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref(); }
    };
    timer = setTimeout(tick, Math.min(intervalMs, 1000));
    timer.unref();
  }

  function stop() { stopped = true; clearTimeout(timer); timer = undefined; }

  async function handle(request, response, url, { allowedSessionIds } = {}) {
    const permitted = (sessionId) => allowedSessionIds === undefined
      || (Array.isArray(allowedSessionIds) && allowedSessionIds.includes(sessionId));
    try {
      if (!await available()) throw new ConversationOutputError('OUTPUT_UNAVAILABLE', '此工作舱尚未启用对话归档。', 503);
      if (url.pathname === '/forge-output/snapshots' && request.method === 'POST') {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 1024) throw new ConversationOutputError('OUTPUT_REQUEST_INVALID', '保存请求只能包含当前对话标识。', 413);
          chunks.push(chunk);
        }
        let input;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { throw new ConversationOutputError('OUTPUT_REQUEST_INVALID', '保存请求无效。'); }
        if (!input || Object.keys(input).join() !== 'sessionId' || !SESSION.test(input.sessionId ?? '')) {
          throw new ConversationOutputError('OUTPUT_REQUEST_INVALID', '保存请求只能包含当前对话标识。');
        }
        if (!permitted(input.sessionId)) {
          throw new ConversationOutputError('OUTPUT_FORBIDDEN', '没有查看此对话文件的权限。', 403);
        }
        json(response, 200, await save(input.sessionId));
        return;
      }
      if (url.pathname === '/forge-output/snapshots' && request.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        if (!SESSION.test(sessionId ?? '')) throw new ConversationOutputError('OUTPUT_SESSION_INVALID', '请先选择要查看的对话。');
        if (!permitted(sessionId)) throw new ConversationOutputError('OUTPUT_FORBIDDEN', '没有查看此对话文件的权限。', 403);
        const result = await uploadJson(uploadTarget, 'GET', `/outputs${url.search}`);
        json(response, 200, { ...result, ...(phaseFilesUrl === undefined ? {} : { phaseFilesUrl }), automatic: { status: failures.has(sessionId) ? 'failed' : 'enabled',
          ...(failures.has(sessionId) ? { code: failures.get(sessionId), message: '最近一次自动归档失败，原对话仍保留。请点击保存重试。' } : {}) } });
        return;
      }
      const file = /^\/forge-output\/files\/([^/]+)\/([a-f0-9]{64})\/([^/]+)$/u.exec(url.pathname);
      if (file !== null && request.method === 'GET') {
        let sessionId;
        try { sessionId = decodeURIComponent(file[1]); } catch { throw new ConversationOutputError('OUTPUT_PATH_INVALID', '文件地址无效。'); }
        if (!SESSION.test(sessionId) || !permitted(sessionId)) {
          throw new ConversationOutputError('OUTPUT_FORBIDDEN', '没有查看此对话文件的权限。', 403);
        }
        return { uploadPath: `/outputs/${file[1]}/${file[2]}/${file[3]}${url.search}` };
      }
      throw new ConversationOutputError('OUTPUT_NOT_FOUND', '对话文件接口不存在。', 404);
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) json(response, error instanceof ConversationOutputError ? error.status : 502,
        { ok: false, code: error instanceof ConversationOutputError ? error.code : 'OUTPUT_SAVE_FAILED',
          message: error instanceof ConversationOutputError ? error.message : '对话文件暂未保存或读取成功，原对话仍保留，请稍后重试。' });
    }
  }

  return Object.freeze({ handle, start, stop, save, captureIdleSessions });
}
