import http from 'node:http';
import crypto from 'node:crypto';
import { createConversationMessageQueue } from './conversation-message-queue.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

// Calls only the already bound native loopback server. Browser credentials never
// enter native headers, queue files, or user-visible receipts.
export function callQueueNative({ targetHost, targetPort }, method, payload, envelope) {
  const requestBody = Buffer.from(JSON.stringify(envelope ?? {
    type: 'client-request', rpcId: crypto.randomUUID(), method, payload,
  }));
  const expected = JSON.parse(requestBody.toString('utf8')).rpcId;
  return new Promise((resolve, reject) => {
    const request = http.request({ host: targetHost, port: targetPort,
      path: `/api/${method}`, method: 'POST', timeout: 30_000,
      headers: { host: `${targetHost}:${targetPort}`, 'content-type': 'application/json',
        'content-length': requestBody.length } }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) response.destroy(new Error('Native queue observation exceeded limit'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => {
        try {
          const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || rpc.type !== 'server-response' || rpc.rpcId !== expected
            || typeof rpc.result?.ok !== 'boolean') throw new Error('Native queue response identity unavailable');
          resolve(rpc.result);
        } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('Native queue request timed out')));
    request.end(requestBody);
  });
}

export function createWorkpodPromptQueue({ statePath, targetHost, targetPort, authorize,
  prepare, isOpen, acquire, confirmed, classify, pollMs = 1000 }) {
  let attachedHeaders = null;
  let historyScan = null;
  let stoppedObservation = null;
  const native = (method, payload, envelope) => callQueueNative({ targetHost, targetPort }, method, payload, envelope);
  const sessions = async () => {
    const result = await native('session.list', {});
    const items = result.ok === true ? result.value?.items : null;
    if (!Array.isArray(items) || items.some(item => typeof item.running !== 'boolean')) {
      throw new Error('当前会话状态暂时无法确认，已排队消息保留。');
    }
    return items;
  };
  const observe = async entry => {
    const items = await sessions();
    const busy = items.some(item => item.running);
    if (!entry) return { busy };
    const current = items.find(item => item.sessionId === entry.sessionId);
    if (!current) return { busy, evidence: { accepted: false } };
    // An accepted running request needs no repeated full history scans.
    if (entry.status === 'running' && current.running) {
      stoppedObservation = null;
      return { busy, evidence: { accepted: true } };
    }
    // Long turns can exceed one bounded history read. Retain the cursor and
    // only identity/terminal events across ticks, rather than rereading the same
    // newest pages forever. No message text or tool output is retained here.
    if (historyScan?.id !== entry.id) historyScan = { id: entry.id, events: [], beforeSeq: undefined, latestSeq: 0 };
    const events = historyScan.events;
    let beforeSeq = historyScan.beforeSeq;
    for (let page = 0; page < 12; page += 1) {
      const result = await native('session.history', { sessionId: entry.sessionId, maxMessages: 50,
        ...(beforeSeq === undefined ? {} : { beforeSeq }) });
      if (!result.ok || !Array.isArray(result.value?.events)) throw new Error('队列执行结果暂时无法核对。');
      const batch = result.value.events.map(row => row.event ?? row);
      for (const event of batch) if (Number.isSafeInteger(event.seq)) historyScan.latestSeq = Math.max(historyScan.latestSeq, event.seq);
      events.push(...batch.filter(event => ['user/message', 'turn/start', 'turn/end'].includes(event.type)).map(event => ({
        type: event.type, seq: event.seq, data: { source: event.data?.source, turn: event.data?.turn, reason: event.data?.reason },
      })));
      if (batch.some(event => event.type === 'user/message' && event.data?.source?.kind === 'user'
        && event.data.source.rpcId === entry.id) || !result.value.hasMore) break;
      const minimum = Math.min(...batch.map(event => event.seq));
      if (!Number.isSafeInteger(minimum) || minimum < 1 || (beforeSeq !== undefined && minimum >= beforeSeq)) break;
      beforeSeq = minimum;
      historyScan.beforeSeq = beforeSeq;
    }
    events.sort((a, b) => a.seq - b.seq);
    const original = events.find(event => event.type === 'user/message'
      && event.data?.source?.kind === 'user' && event.data.source.rpcId === entry.id);
    if (!original) return { busy, evidence: { accepted: false } };
    confirmed?.(entry);
    const nextUser = events.find(event => event.seq > original.seq && event.type === 'user/message'
      && event.data?.source?.kind === 'user' && event.data.source.rpcId !== entry.id);
    const terminal = events.find(event => event.seq > original.seq && event.type === 'turn/end'
      && (!nextUser || event.seq < nextUser.seq));
    const latestSeq = historyScan.latestSeq;
    historyScan = null;
    if (!terminal) {
      // A native stop/restart can leave an accepted turn without turn/end.
      // Confirm the exact request and stable idle history on separate polls;
      // never report success or replay the stopped request. Dispatch retains
      // its existing authorization and live writer/busy checks.
      if (entry.status === 'running' && !current.running) {
        const confirmedIdle = (await sessions()).find(item => item.sessionId === entry.sessionId)?.running === false;
        if (confirmedIdle && stoppedObservation?.id === entry.id && stoppedObservation.latestSeq === latestSeq) {
          stoppedObservation = null;
          return { busy, evidence: { accepted: true, terminal: 'cancelled' } };
        }
        stoppedObservation = confirmedIdle ? { id: entry.id, latestSeq } : null;
      } else stoppedObservation = null;
      return { busy, evidence: { accepted: true } };
    }
    stoppedObservation = null;
    const reason = terminal.data?.reason?.kind;
    return { busy, evidence: { accepted: true,
      terminal: reason === 'completed' ? 'completed' : ['cancelled', 'canceled', 'interrupted', 'aborted', 'stopped'].includes(reason) ? 'cancelled' : 'failed',
      message: reason === 'completed' ? undefined : '本条执行未完成，同一对话后续消息已暂停。' } };
  };
  const queue = createConversationMessageQueue({ statePath, pollMs, observe,
    canDispatch: async () => attachedHeaders !== null && await isOpen(),
    dispatch: async entry => {
      const request = { headers: { ...attachedHeaders } };
      const authorization = await authorize(request);
      if (!authorization.allowed) {
        attachedHeaders = null;
        return { status: 'busy', message: '请重新打开工作舱，登录后继续已保存的队列。' };
      }
      const release = acquire(entry);
      if (!release) return { status: 'busy' };
      let dispatched = false;
      try {
        const body = Buffer.from(JSON.stringify(entry.body));
        const classified = classify(body, 'session.prompt');
        const prepared = await prepare(request, classified, body);
        if (!await isOpen(true)) return { status: 'busy' };
        // This boundary is intentionally after current authorization and source
        // preparation. Any error from here may have reached native: never replay.
        dispatched = true;
        const result = await native('session.prompt', entry.body.payload,
          prepared ? JSON.parse(prepared.toString('utf8')) : entry.body);
        if (result.ok) { release('accepted'); return { status: 'accepted' }; }
        release('rejected');
        if (result.error?.code === 'agent-busy'
          && result.error.details?.reason === 'CONVERSATION_EXECUTION_BUSY_NOT_ACCEPTED') return { status: 'busy' };
        return { status: 'failed', message: '原生会话未接纳这条消息，请查看该对话后再继续。' };
      } catch (error) {
        if (dispatched) {
          release('unconfirmed');
          return { status: 'uncertain', message: '执行接收结果待确认，队列已暂停；系统不会自动重发。' };
        }
        if (error.code === 'CONVERSATION_EXECUTION_BUSY') return { status: 'busy' };
        return { status: 'failed', message: error.name === 'ConversationContinuationError'
          ? error.message : '本条执行准备失败，尚未发送给模型，同一对话后续消息已暂停。' };
      } finally { if (!dispatched) release('rejected'); }
    },
  });
  return {
    ...queue,
    attach(request) {
      // Volatile login proof only. Reopening an authenticated page reattaches
      // after proxy restart; queued content survives without persisting cookies.
      attachedHeaders = Object.fromEntries(['cookie', 'host', 'origin', 'sec-fetch-site']
        .filter(key => typeof request.headers[key] === 'string').map(key => [key, request.headers[key]]));
      void queue.tick().catch(() => {});
    },
    async snapshot() { return { ...(await queue.list()), waitingForAuthorization: attachedHeaders === null }; },
    async enqueueInput(input) {
      if (!input || !ID.test(input.id ?? '') || !ID.test(input.sessionId ?? '') || !Array.isArray(input.content)) {
        throw Object.assign(new Error('消息标识或内容无效。'), { statusCode: 400 });
      }
      const body = { type: 'client-request', rpcId: input.id, method: 'session.prompt', payload: {
        sessionId: input.sessionId, mode: 'queue', content: input.content,
        ...(typeof input.clientTimeZone === 'string' ? { clientTimeZone: input.clientTimeZone } : {}),
      } };
      const classified = classify(Buffer.from(JSON.stringify(body)), 'session.prompt');
      if (classified.classification !== 'claimable-text' || classified.rpcId !== input.id
        || classified.dshSessionId !== input.sessionId) {
        throw Object.assign(new Error('消息格式不受支持，尚未入队。'), { statusCode: 400 });
      }
      if (!(await sessions()).some(item => item.sessionId === input.sessionId)) {
        throw Object.assign(new Error('当前工作舱中不存在这个对话。'), { statusCode: 404 });
      }
      return queue.enqueue({ id: input.id, sessionId: input.sessionId, body });
    },
  };
}
