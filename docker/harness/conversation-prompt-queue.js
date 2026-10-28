(() => {
  'use strict';
  if (window.__forgePromptQueueInstalled) return;
  window.__forgePromptQueueInstalled = true;
  const fetchQueue = window.fetch.bind(window);
  const listeners = new Map(), unsettled = new Map(), mutations = new Set();
  let snapshot = { items: [], pausedSessions: [], loading: true, error: '' };
  let timer, refreshFlight, revision = 0;

  function notify() {
    for (const [sessionId, subscribers] of listeners) {
      const state = { ...snapshot, sessionId, busyIds: [...mutations],
        refresh, cancel: id => mutate('/cancel', { id }, id),
        resume: id => mutate('/resume', { sessionId: id }, 'session:' + id) };
      for (const subscriber of subscribers) subscriber(state);
    }
  }
  async function request(path = '', body, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error('队列服务响应超时，请查看队列状态。')), 15000);
    try {
      const response = await fetchQueue('/forge-prompt-queue' + path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const value = await response.json();
      if (!response.ok || value?.ok !== true) {
        const message = value?.message ?? value?.error?.message;
        const error = new Error(typeof message === 'string' ? message : '队列操作未完成，请查看状态后重试。');
        error.status = response.status;
        error.rejected = response.status >= 400 && response.status < 500;
        throw error;
      }
      return value;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  function schedule() {
    clearTimeout(timer);
    if (listeners.size) timer = setTimeout(() => { timer = undefined; void refresh(); }, 2000);
  }
  function refresh() {
    if (refreshFlight) return refreshFlight;
    const ticket = revision;
    refreshFlight = request().then(value => {
      if (!Array.isArray(value.items) || !Array.isArray(value.pausedSessions)) throw new Error('队列状态暂时无法读取，请重试。');
      if (ticket === revision) snapshot = { ...value, loading: false, error: '', actionError: snapshot.actionError };
      return value;
    }).catch(error => {
      if (ticket === revision) snapshot = { ...snapshot, loading: false, error: error.message };
      return null;
    }).finally(() => { refreshFlight = null; notify(); schedule(); });
    return refreshFlight;
  }
  async function mutate(path, body, key) {
    if (mutations.has(key)) return;
    mutations.add(key); notify();
    try { await request(path, body); revision++; snapshot = { ...snapshot, actionError: '' }; }
    catch (error) { snapshot = { ...snapshot, actionError: error.message }; }
    finally {
      mutations.delete(key); notify();
      // Complete any older read before requesting the post-mutation state.
      if (refreshFlight) await refreshFlight;
      await refresh();
    }
  }
  window.__forgeSubscribePromptQueue = (sessionId, listener) => {
    if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
    listeners.get(sessionId).add(listener); notify(); void refresh();
    return () => {
      const subscribers = listeners.get(sessionId); subscribers?.delete(listener);
      if (!subscribers?.size) listeners.delete(sessionId);
      if (!listeners.size) clearTimeout(timer);
    };
  };
  // This returns a platform queue receipt, never a native session.prompt result.
  // The composer may release its draft only after durable server admission.
  window.__forgeEnqueuePrompt = async (payload, signal) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Request aborted', 'AbortError');
    const key = JSON.stringify(payload);
    const id = unsettled.get(key) ?? crypto.randomUUID();
    unsettled.set(key, id);
    let item;
    try {
      const value = await request('', { ...payload, id }, signal);
      if (value.queued !== true || value.item?.id !== id) throw new Error('入队结果暂未确认。');
      item = value.item;
    } catch (error) {
      if (error.rejected) { unsettled.delete(key); throw error; }
      // A lost response is not a safe reason to resend under a new identity.
      // Reconcile once; a user retry of the same draft retains this id.
      const value = await refresh();
      item = value?.items.find(entry => entry.id === id);
      if (!item) throw new Error('暂未确认消息是否入队，输入已保留。请先查看队列；再次发送同一条消息会核对原请求，不会重复入队。');
    }
    unsettled.delete(key); revision++;
    snapshot = { ...snapshot, loading: false, error: '', items: [...snapshot.items.filter(entry => entry.id !== id), item].sort((a, b) => a.sequence - b.sequence) };
    notify(); schedule();
    return item;
  };
  window.addEventListener?.('focus', () => { if (listeners.size) void refresh(); });
})();
