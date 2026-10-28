import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const ACTIVE = new Set(['preparing', 'running', 'uncertain']);
const STATUSES = new Set(['queued', ...ACTIVE, 'completed', 'failed', 'cancelled', 'paused']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const CREDENTIAL_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|secret)$/i;
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code, message) => Object.assign(new Error(message), { code });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function checkBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('QUEUE_INVALID_BODY', '消息内容必须是 JSON 对象。');
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (CREDENTIAL_KEY.test(key)) throw fail('QUEUE_SECRET_NOT_ALLOWED', '队列消息不能包含认证凭据字段。');
      visit(child);
    }
  };
  visit(value);
}

function binding(sessionId, body) {
  return createHash('sha256').update(canonical({ sessionId, body })).digest('hex');
}

function preview(body) {
  return (Array.isArray(body?.payload?.content) ? body.payload.content : [])
    .filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text).join('\n').slice(0, 240);
}

function publicEntry(entry) {
  const { body, digest, ...metadata } = entry;
  return { ...metadata, preview: preview(body) };
}

async function checkRegular(file, missing = false) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw fail('QUEUE_UNSAFE_PATH', '队列文件必须是独立的普通文件。');
    return info;
  } catch (error) {
    if (missing && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function privateDirectory(directory, create) {
  const root = path.parse(directory).root;
  let current = root;
  for (const component of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await mkdir(current, { mode: 0o700 }); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('QUEUE_UNSAFE_PATH', '队列目录不能经过符号链接。');
  }
  await chmod(directory, 0o700);
}

/** One instance per workpod. Authentication stays in the adapter, never in this file. */
export function createConversationMessageQueue({ statePath, observe, dispatch, canDispatch = () => true, pollMs = 1000, clock = () => new Date() }) {
  if (!statePath || typeof observe !== 'function' || typeof dispatch !== 'function') throw new TypeError('statePath, observe and dispatch are required');
  const file = path.resolve(statePath), directory = path.dirname(file);
  let state = { version: 1, nextSequence: 1, pausedSessions: [], entries: [] };
  let mutations = Promise.resolve(), worker = null, timer = null, closed = false, storageError = null;
  const now = () => new Date(clock()).toISOString();

  async function persist(candidate) {
    await privateDirectory(directory, false);
    await checkRegular(file, true);
    const temporary = path.join(directory, `.state-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(`${JSON.stringify(candidate)}\n`, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await checkRegular(file, true);
      await rename(temporary, file);
      if (process.platform !== 'win32') {
        const parent = await open(directory, constants.O_RDONLY);
        try { await parent.sync(); } finally { await parent.close(); }
      }
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  function validateStored(candidate) {
    if (candidate?.version !== 1 || !Number.isSafeInteger(candidate.nextSequence) || !Array.isArray(candidate.entries)
      || !Array.isArray(candidate.pausedSessions) || candidate.pausedSessions.some(id => typeof id !== 'string')) throw fail('QUEUE_INVALID_STATE', '队列存储格式无效，已停止派发。');
    const ids = new Set(), sequences = new Set();
    for (const entry of candidate.entries) {
      checkBody(entry.body);
      if (typeof entry.id !== 'string' || typeof entry.sessionId !== 'string' || !STATUSES.has(entry.status)
        || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || entry.sequence >= candidate.nextSequence
        || ids.has(entry.id) || sequences.has(entry.sequence) || entry.digest !== binding(entry.sessionId, entry.body)) throw fail('QUEUE_INVALID_STATE', '队列消息绑定无效，已停止派发。');
      ids.add(entry.id); sequences.add(entry.sequence);
    }
    if (candidate.entries.filter(entry => ACTIVE.has(entry.status)).length > 1) throw fail('QUEUE_INVALID_STATE', '队列存在多个执行者，已停止派发。');
    candidate.entries.sort((a, b) => a.sequence - b.sequence);
  }

  const ready = (async () => {
    await privateDirectory(directory, true);
    if (await checkRegular(file, true)) {
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try { state = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
      validateStored(state);
      await chmod(file, 0o600);
      for (const entry of state.entries) if (entry.status === 'preparing') {
        entry.status = 'uncertain'; entry.reason = '服务重启时消息正在派发；等待原请求的接纳或终态证据，不会重复发送。'; entry.updatedAt = now();
      }
    }
    await persist(state);
    schedule(0);
  })();

  function mutate(update) {
    const operation = mutations.then(async () => {
      await ready;
      if (storageError) throw storageError;
      const candidate = clone(state);
      const result = update(candidate);
      try { await persist(candidate); } catch (error) { storageError = error; throw error; }
      state = candidate;
      return result;
    });
    mutations = operation.catch(() => {});
    return operation;
  }

  function schedule(delay = pollMs) {
    if (closed || storageError) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void tick().catch(() => {}); }, Math.max(0, delay));
    timer.unref?.();
  }

  function pauseSession(candidate, sessionId) {
    if (!candidate.pausedSessions.includes(sessionId)) candidate.pausedSessions.push(sessionId);
    for (const entry of candidate.entries) if (entry.sessionId === sessionId && entry.status === 'queued') {
      entry.status = 'paused'; entry.reason = '本对话的前一条执行失败或停止，后续消息已保留，请确认后继续队列。'; entry.updatedAt = now();
    }
  }

  async function finishObserved(entry, observation) {
    const evidence = observation?.evidence;
    if (!evidence?.accepted) return;
    if (entry.status === 'running' && !TERMINAL.has(evidence.terminal)) return;
    await mutate(candidate => {
      const current = candidate.entries.find(item => item.id === entry.id);
      if (!current || !ACTIVE.has(current.status)) return;
      if (TERMINAL.has(evidence.terminal)) {
        current.status = evidence.terminal; current.completedAt = now();
        current.reason = evidence.terminal === 'completed' ? null : '原会话执行失败或已停止。';
        if (evidence.terminal !== 'completed') pauseSession(candidate, current.sessionId);
      } else {
        current.status = 'running'; current.startedAt ??= now(); current.reason = null;
      }
      current.updatedAt = now();
    });
  }

  async function runTick() {
    await ready;
    await mutations;
    if (closed || storageError) return;
    const active = state.entries.find(entry => ACTIVE.has(entry.status));
    if (active) {
      let observation;
      try { observation = await observe(clone(active)); } catch { return; }
      await finishObserved(active, observation);
      return;
    }
    if (!state.entries.some(entry => entry.status === 'queued')) return;
    let allowed, observation;
    try { allowed = await canDispatch(); if (allowed) observation = await observe(null); } catch { return; }
    if (!allowed || observation?.busy !== false || closed) return;
    const chosen = await mutate(candidate => {
      if (candidate.entries.some(entry => ACTIVE.has(entry.status))) return null;
      const entry = candidate.entries.find(item => item.status === 'queued' && !candidate.pausedSessions.includes(item.sessionId));
      if (!entry) return null;
      entry.status = 'preparing'; entry.updatedAt = now(); entry.reason = null;
      return clone(entry);
    });
    if (!chosen) return;
    let result;
    try { result = await dispatch(clone(chosen)); } catch { result = { status: 'uncertain' }; }
    await mutate(candidate => {
      const entry = candidate.entries.find(item => item.id === chosen.id);
      entry.updatedAt = now();
      if (result?.status === 'accepted') {
        entry.status = 'running'; entry.startedAt = now(); entry.reason = null;
      } else if (result?.status === 'busy') {
        entry.status = 'queued'; entry.reason = '工作舱正在执行其他请求，消息尚未发送。';
      } else if (result?.status === 'failed') {
        entry.status = 'failed'; entry.completedAt = now(); entry.reason = '消息准备或提交被明确拒绝，尚未接纳执行。';
        pauseSession(candidate, entry.sessionId);
      } else {
        entry.status = 'uncertain'; entry.reason = '无法确认原请求是否已接纳；等待原请求证据，不会重复发送。';
      }
    });
  }

  function tick() {
    clearTimeout(timer); timer = null;
    if (worker) return worker;
    worker = runTick().finally(() => { worker = null; schedule(); });
    return worker;
  }

  return {
    ready, tick,
    async enqueue({ id, sessionId, body }) {
      if (closed) throw fail('QUEUE_CLOSED', '消息队列已关闭。');
      if (typeof id !== 'string' || !id || id.length > 256 || typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) throw fail('QUEUE_INVALID_ID', '消息及会话标识无效。');
      const payload = clone(body);
      checkBody(payload);
      const digest = binding(sessionId, payload);
      const result = await mutate(candidate => {
        const existing = candidate.entries.find(entry => entry.id === id);
        if (existing) {
          if (existing.digest !== digest) throw fail('QUEUE_ID_CONFLICT', '同一消息标识已用于不同内容或会话。');
          return publicEntry(existing);
        }
        const timestamp = now(), paused = candidate.pausedSessions.includes(sessionId);
        const entry = { id, sessionId, body: payload, digest, sequence: candidate.nextSequence++, status: paused ? 'paused' : 'queued',
          createdAt: timestamp, updatedAt: timestamp, startedAt: null, completedAt: null,
          reason: paused ? '本对话队列已暂停，新消息已保留。' : null };
        candidate.entries.push(entry);
        return publicEntry(entry);
      });
      schedule(0);
      return result;
    },
    async list() {
      await ready; await mutations;
      const active = state.entries.find(entry => ACTIVE.has(entry.status));
      return { items: state.entries.map(publicEntry), pausedSessions: [...state.pausedSessions],
        blocked: storageError ? { id: null, status: 'storage-error', reason: '消息队列持久化失败，已停止派发。' }
          : active ? { id: active.id, status: active.status, reason: active.reason } : null };
    },
    async cancel(id) {
      return mutate(candidate => {
        const entry = candidate.entries.find(item => item.id === id);
        if (!entry) throw fail('QUEUE_NOT_FOUND', '未找到排队消息。');
        if (entry.status === 'cancelled') return publicEntry(entry);
        if (!['queued', 'paused'].includes(entry.status)) throw fail('QUEUE_NOT_CANCELLABLE', '只能取消尚未开始执行的消息。');
        entry.status = 'cancelled'; entry.updatedAt = now(); entry.completedAt = now(); entry.reason = '待执行消息已取消，未发送到会话。';
        return publicEntry(entry);
      });
    },
    async resume(sessionId) {
      const result = await mutate(candidate => {
        candidate.pausedSessions = candidate.pausedSessions.filter(id => id !== sessionId);
        for (const entry of candidate.entries) if (entry.sessionId === sessionId && entry.status === 'paused') {
          entry.status = 'queued'; entry.reason = null; entry.updatedAt = now();
        }
        return { sessionId, resumed: true };
      });
      schedule(0);
      return result;
    },
    async close() {
      closed = true; clearTimeout(timer);
      await ready; await worker; await mutations;
    },
  };
}
