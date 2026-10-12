(() => {
  'use strict';
  if (window.__forgePromptQueueInstalled) return;
  window.__forgePromptQueueInstalled = true;
  const originalFetch = window.fetch.bind(window);
  const sessions = new Map();
  const pending = new Map(), listeners = new Map();

  function notify(sessionId) {
    const request = pending.get(sessionId)?.values().next().value;
    const state = request ? { phase: request.phase, seconds: Math.floor((Date.now() - request.started) / 1000),
      cancel: request.phase === 'waiting' ? () => request.controller.abort(new Error('已取消等待，本条消息尚未发送，正在执行的任务不受影响。')) : null } : null;
    for (const listener of listeners.get(sessionId) ?? []) listener(state);
  }
  window.__forgeSubscribePromptQueue = (sessionId, listener) => {
    if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
    listeners.get(sessionId).add(listener); notify(sessionId);
    return () => { const set = listeners.get(sessionId); set?.delete(listener); if (!set?.size) listeners.delete(sessionId); };
  };

  async function readSessions(signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('查询当前执行状态超时，本条消息尚未发送，请稍后重试。')), 30000);
    try {
      if (signal.aborted) abort();
      const rpcId = crypto.randomUUID();
      const response = await originalFetch('/api/session.list', {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'session.list', payload: {} }),
      });
      const result = await response.json();
      if (!response.ok || result.rpcId !== rpcId || result.result?.ok !== true) {
        throw new Error('无法确认当前对话是否已结束，后续消息尚未发送。');
      }
      return result.result.value?.items;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }

  function afterPrior(prior, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      prior.catch(() => {}).then(() => { signal.removeEventListener('abort', abort); resolve(); });
    });
  }

  function wait(signal) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Request aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, 1000);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  }

  // Called by the pinned native sessions.prompt entry, before callUnary creates
  // its transport timeout. Waiting inside fetch consumes that timeout instead.
  window.__forgeQueuePrompt = function (payload, signal, dispatch) {
    if (payload?.mode !== 'queue' || typeof payload.sessionId !== 'string') return dispatch();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason ?? new DOMException('Request aborted', 'AbortError'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const request = { sessionId: payload.sessionId, controller, signal: controller.signal, phase: 'waiting', started: Date.now() };
    if (!pending.has(request.sessionId)) pending.set(request.sessionId, new Set());
    pending.get(request.sessionId).add(request); notify(request.sessionId);
    const prior = sessions.get(request.sessionId) ?? Promise.resolve();
    const next = afterPrior(prior, request.signal).then(async () => {
      // Bind protected authority only when this queued browser message can run.
      // Preparing it during a preceding edit replaces that edit's execution
      // identity and captures a source fingerprint that is already obsolete.
      for (;;) {
        if (request.signal?.aborted) throw request.signal.reason ?? new DOMException('Request aborted', 'AbortError');
        const items = await readSessions(request.signal);
        if (request.signal.aborted) throw request.signal.reason;
        const session = items?.find(item => item.sessionId === request.sessionId);
        if (!session || session.running !== true) {
          request.phase = 'submitting'; notify(request.sessionId);
          const dispatched = await dispatch();
          const error = dispatched?.result?.ok === false ? dispatched.result.error : null;
          // This fixed native reason guarantees the request was not accepted.
          // A timeout, unknown error, or accepted prompt must never be replayed.
          if (error?.code !== 'agent-busy'
            || error.details?.reason !== 'CONVERSATION_EXECUTION_BUSY_NOT_ACCEPTED') return dispatched;
        }
        request.phase = 'waiting'; notify(request.sessionId);
        await wait(request.signal);
      }
    });
    // Cancelling a follower must not let later messages overtake its pending head.
    const tail = Promise.allSettled([prior, next]);
    sessions.set(request.sessionId, tail);
    void next.finally(() => {
      signal?.removeEventListener('abort', abort);
      const requests = pending.get(request.sessionId); requests?.delete(request);
      if (!requests?.size) pending.delete(request.sessionId);
      notify(request.sessionId);
    }).catch(() => {});
    void tail.then(() => { if (sessions.get(request.sessionId) === tail) sessions.delete(request.sessionId); });
    return next;
  };
})();
