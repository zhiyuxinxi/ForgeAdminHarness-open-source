// Inserted inside the pinned conversation plugin; uses its React and row renderer.
function ForgeQuestionHistory({ sessionId, historyRevision, loadQuestionHistory, jump }) {
  const [open, setOpen] = react.useState(false);
  const [state, setState] = react.useState({ items: [], total: null, cursor: null, busy: false, error: '', retry: false });
  const serial = react.useRef(0), container = react.useRef(null), trigger = react.useRef(null);
  const panelId = 'forge-question-history-' + sessionId;
  const close = (focus = false) => {
    serial.current++;
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  const load = async (cursor = null) => {
    const request = ++serial.current;
    setState(s => ({ ...s, ...(cursor == null ? { items: [], total: null, cursor: null } : {}), busy: true, error: '', retry: false }));
    try {
      const value = await loadQuestionHistory({ forgeView: 'questions', ...(cursor == null ? {} : { beforeSeq: cursor }) });
      if (request !== serial.current) return;
      const page = value.forgeQuestions;
      setState(s => ({ items: cursor == null ? page.items : [...s.items, ...page.items.filter(item => !s.items.some(existing => existing.seq === item.seq))],
        total: page.total, cursor: page.nextCursor, busy: false, error: '', retry: false }));
    } catch {
      if (request === serial.current) setState(s => ({ ...s, busy: false, error: '历史提问加载失败，请重试。', retry: true }));
    }
  };
  const select = async seq => {
    const request = ++serial.current;
    setState(s => ({ ...s, busy: true, error: '', retry: false }));
    try {
      await jump(seq);
      if (request === serial.current) close();
    } catch {
      if (request === serial.current) setState(s => ({ ...s, busy: false, error: '定位失败，请再次点击该提问。', retry: false }));
    }
  };
  react.useEffect(() => {
    if (open) load();
    return () => { serial.current++; };
  }, [open, sessionId, historyRevision]);
  react.useEffect(() => {
    if (!open) return;
    const outside = event => { if (!container.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return react_jsx_runtime.jsxs('div', { ref: container, className: 'forge-question-history',
    onKeyDown: event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(true); } }, children: [
    react_jsx_runtime.jsxs('button', { ref: trigger, type: 'button', className: 'forge-question-history-trigger',
      'aria-expanded': open, 'aria-controls': panelId, title: '查看当前对话的全部历史提问', onClick: () => open ? close() : setOpen(true), children: [
      react_jsx_runtime.jsxs('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true, children: [
        react_jsx_runtime.jsx('circle', { cx: 12, cy: 12, r: 9 }),
        react_jsx_runtime.jsx('path', { d: 'M12 7v5l3 2', strokeLinecap: 'round', strokeLinejoin: 'round' })
      ] }), '历史提问'
    ] }),
    open && react_jsx_runtime.jsxs('section', { id: panelId, className: 'forge-question-history-panel', role: 'region', 'aria-label': '当前对话的历史提问', children: [
      react_jsx_runtime.jsxs('div', { className: 'forge-question-history-heading', children: [
        react_jsx_runtime.jsx('strong', { children: state.total == null ? '历史提问' : `历史提问（${state.total}）` }),
        react_jsx_runtime.jsx('button', { type: 'button', 'aria-label': '关闭历史提问', onClick: () => close(true), children: '关闭' })
      ] }),
      react_jsx_runtime.jsxs('div', { className: 'forge-question-history-list', 'aria-busy': state.busy, children: [
        ...state.items.map((item, index) => react_jsx_runtime.jsxs('button', { type: 'button', className: 'forge-question-history-item', disabled: state.busy,
          'data-forge-history-seq': item.seq, title: item.text || '图片或附件消息', onClick: () => select(item.seq), children: [
          react_jsx_runtime.jsx('span', { className: 'forge-question-history-number', 'aria-hidden': true, children: state.total - index }),
          react_jsx_runtime.jsx('span', { className: 'forge-question-history-text', children: item.text || '图片或附件消息' })
        ] }, item.seq)),
        react_jsx_runtime.jsx('div', { className: 'forge-question-history-status', role: 'status', 'aria-live': 'polite', children: state.busy ? '正在加载…' : state.error || (!state.items.length ? '当前对话还没有提问。' : `已显示 ${state.items.length} / ${state.total} 条，最近提问在前`) }),
        state.retry && react_jsx_runtime.jsx('button', { type: 'button', onClick: () => load(state.cursor), children: '重试' }),
        !state.retry && state.cursor != null && react_jsx_runtime.jsx('button', { type: 'button', className: 'forge-question-history-more', disabled: state.busy,
          onClick: () => load(state.cursor), children: '加载更早提问' })
      ] })
    ] })
  ] });
}
function ForgeQuestionSearch({ sessionId, historyRevision, loadQuestionHistory, jump }) {
  const [query, setQuery] = react.useState('');
  const [composing, setComposing] = react.useState(false);
  const [state, setState] = react.useState({ items: [], busy: false, error: '', cursor: null });
  const serial = react.useRef(0), input = react.useRef(null);
  const search = async (text, cursor, append = false) => {
    const request = ++serial.current;
    if (!text.trim()) { setState({ items: [], busy: false, error: '', cursor: null }); return; }
    setState(s => ({ ...s, busy: true, error: '' }));
    try {
      const value = await loadQuestionHistory({ forgeView: 'search', query: text, ...(cursor == null ? {} : { beforeSeq: cursor }) });
      if (request !== serial.current) return;
      setState(s => ({ items: append ? [...s.items, ...value.forgeSearch.items] : value.forgeSearch.items,
        cursor: value.forgeSearch.nextCursor, busy: false, error: '' }));
    } catch { if (request === serial.current) setState(s => ({ ...s, busy: false, error: '搜索失败，请重试。' })); }
  };
  react.useEffect(() => {
    serial.current++;
    if (composing) return;
    const timer = setTimeout(() => search(query), 300);
    return () => { clearTimeout(timer); serial.current++; };
  }, [query, composing, sessionId]);
  const clear = (focus = true) => { serial.current++; setQuery(''); setState({ items: [], busy: false, error: '', cursor: null }); if (focus) input.current?.focus(); };
  return react_jsx_runtime.jsxs('div', { className: 'forge-question-search', children: [
    react_jsx_runtime.jsxs('div', { className: 'forge-question-toolbar', children: [react_jsx_runtime.jsxs('form', { noValidate: true, role: 'search', onSubmit: e => { e.preventDefault(); if (!composing) search(query); }, children: [
      react_jsx_runtime.jsx('label', { htmlFor: 'forge-question-search-' + sessionId, children: '搜索我的发言' }),
      react_jsx_runtime.jsx('input', { ref: input, id: 'forge-question-search-' + sessionId, type: 'search', value: query, maxLength: 500,
        placeholder: '输入关键词，查找当前对话', autoComplete: 'off', onChange: e => setQuery(e.target.value),
        onCompositionStart: () => setComposing(true), onCompositionEnd: () => setComposing(false),
        onKeyDown: e => { if (e.key === 'Escape') clear(); } }),
      query && react_jsx_runtime.jsx('button', { type: 'button', onClick: clear, 'aria-label': '清除搜索', children: '清除' }),
      react_jsx_runtime.jsx('button', { type: 'submit', disabled: composing || state.busy || !query.trim(), children: '搜索' })
    ] }), react_jsx_runtime.jsx(ForgeQuestionHistory, { sessionId, historyRevision, loadQuestionHistory, jump: async seq => { clear(false); await jump(seq); } }, sessionId)] }),
    query.trim() && react_jsx_runtime.jsxs('div', { className: 'forge-question-results', children: [
      react_jsx_runtime.jsx('div', { role: 'status', 'aria-live': 'polite', children: state.busy ? '正在搜索…' : state.error || (state.items.length ? `找到 ${state.items.length} 条发言` : '没有匹配的发言') }),
      state.error && react_jsx_runtime.jsx('button', { type: 'button', onClick: () => search(query), children: '重试' }),
      ...state.items.map(item => react_jsx_runtime.jsx('button', { type: 'button', disabled: state.busy, className: 'forge-question-result', 'data-forge-search-seq': item.seq,
        onClick: async () => { const ticket = ++serial.current; setState(s => ({ ...s, busy: true, error: '' })); try { await jump(item.seq); if (ticket === serial.current) clear(false); } catch { if (ticket === serial.current) setState(s => ({ ...s, busy: false, error: '定位失败，请重试。' })); } },
        children: item.text || '图片或附件消息' }, item.seq)),
      state.cursor != null && react_jsx_runtime.jsx('button', { type: 'button', disabled: state.busy, onClick: () => search(query, state.cursor, true), children: '更多搜索结果' })
    ] })
  ] });
}
function ForgeQuestionProcess({ question, hidden, renderNode, loadQuestionHistory }) {
  const [open, setOpen] = react.useState(false), [busy, setBusy] = react.useState(false), [error, setError] = react.useState('');
  const meta = question.data.forgeHistory;
  const load = async (more = false) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await loadQuestionHistory({ forgeView: 'details', questionSeq: question.data.seq,
      ...(more && meta?.nextDetailSeq != null ? { detailAfterSeq: meta.nextDetailSeq } : {}) }); }
    catch { setError('执行过程加载失败，请重试。'); }
    finally { setBusy(false); }
  };
  if (!hidden.length && !meta?.detailCount) return null;
  const count = Math.max(meta?.detailCount ?? 0, hidden.length);
  return react_jsx_runtime.jsxs('section', { className: 'forge-question-process', children: [
    react_jsx_runtime.jsx('button', { type: 'button', className: 'forge-question-toggle', 'aria-expanded': open,
      onClick: () => { setOpen(!open); if (!open && meta && !meta.loaded) load(); },
      children: `${open ? '▾' : '▸'} 执行过程（${count} 条）` }),
    open && react_jsx_runtime.jsxs('div', { className: 'forge-question-details', children: [
      busy && react_jsx_runtime.jsx('div', { role: 'status', children: '正在加载执行过程…' }),
      error && react_jsx_runtime.jsxs('div', { role: 'alert', children: [error, react_jsx_runtime.jsx('button', { type: 'button', onClick: () => load(meta?.loaded), children: '重试' })] }),
      ...hidden.map(renderNode),
      meta?.loaded && meta.nextDetailSeq != null && react_jsx_runtime.jsx('button', { type: 'button', disabled: busy, onClick: () => load(true), children: '加载更多执行过程' })
    ] })
  ] });
}
function forgeWorkpodPreparation(node) {
  const root = node?.kind === 'tool-call' ? node.data.root : null;
  if (root?.kind !== 'tool-result' || root.call?.name !== 'prepare_task' || root.isError) return null;
  for (const part of root.content ?? []) {
    if (part.type !== 'text' || typeof part.text !== 'string') continue;
    try { const value = JSON.parse(part.text); if (['prepared', 'needs-confirmation'].includes(value.status)) return value.status; } catch { /* Not a structured preparation result. */ }
  }
  return null;
}
function forgeWorkpodGroups(order, nodeStore) {
  const groups = []; let current;
  for (const key of order) {
    const node = nodeStore.get(key); if (!node) continue;
    if (node.kind === 'user' || node.kind === 'steering') { current = { question: node, nodes: [], hidden: [], visible: [], needsConfirmation: node.data.forgeHistory?.needsConfirmation === true }; groups.push(current); }
    else if (!current) groups.push({ standalone: key });
    else {
      current.nodes.push({ key, node });
      if (node.kind === 'turn-tail') current.tail = node;
      const preparation = forgeWorkpodPreparation(node);
      if (preparation) current.needsConfirmation = preparation === 'needs-confirmation';
    }
  }
  for (const group of groups) {
    if (group.standalone) continue;
    for (const { key, node } of group.nodes) {
      const visible = node === group.tail || (node.kind === 'turn-error' && node.data.turn === group.tail?.data.turn)
        || (node.kind === 'assistant-step' && node.data.finalNode?.seq != null && node.data.finalNode.seq === group.tail?.data.closing?.finalNode?.seq);
      (visible ? group.visible : group.hidden).push(key);
    }
  }
  return groups;
}
async function forgeSubmitWorkpodAction(target, action, { fetchImpl = globalThis.fetch, isCurrent = () => true, onSubmitting = () => {}, signal } = {}) {
  const messages = { confirm: '确认执行当前范围', release: '发版' };
  if (!messages[action] || typeof target.sessionId !== 'string' || !Number.isSafeInteger(target.questionSeq) || !Number.isSafeInteger(target.terminalSeq)) throw new Error('当前结果尚未就绪，请刷新后再操作。');
  const rpc = async (method, payload, headers = {}) => {
    if (!isCurrent() || signal?.aborted) {
      const error = new Error('当前对话或结果已变化，本次请求尚未发送，请在最新结果上操作。');
      error.requestAccepted = false; throw error;
    }
    const rpcId = crypto.randomUUID();
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    // Allow the proxy's correlated receipt first; a client timeout is unknown.
    const timer = setTimeout(() => controller.abort(new Error(method === 'session.prompt'
      ? '等待接纳结果超时，是否已执行尚未确认。' : '核对当前结果超时，本次请求尚未发送，请稍后重试。')), 150000);
    try {
      const response = await fetchImpl('/api/' + method, { method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }) });
      const value = await response.json();
      if (!response.ok || value.rpcId !== rpcId || value.result?.ok !== true) {
        const error = new Error(value.result?.error?.message || '无法确认当前请求状态，请刷新对话查看结果。');
        if (value.rpcId === rpcId && value.result?.ok === false && value.result.error?.details?.requestAccepted === false) error.requestAccepted = false;
        throw error;
      }
      return value.result.value;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  const history = await rpc('session.history', { sessionId: target.sessionId, forgeView: 'summary' });
  const events = (history.events ?? []).map(row => row.event);
  const questions = events.filter(event => event?.type === 'user/message' && (event.data.message ?? event.data).source?.kind === 'user' && event.surfaceOp?.kind !== 'replace');
  const question = questions.at(-1), terminal = events.filter(event => event?.type === 'turn/end').at(-1);
  if (question?.seq !== target.questionSeq || terminal?.seq !== target.terminalSeq || terminal.seq < question.seq) throw new Error('当前结果已更新，请在最新结果上操作。');
  const metadata = (question.data.message ?? question.data).forgeHistory;
  if (action === 'confirm' && metadata?.needsConfirmation !== true) throw new Error('当前任务无需再次确认，请查看最新结果。');
  if (action === 'release' && metadata?.needsConfirmation === true) throw new Error('请先确认当前执行范围。');
  const listing = await rpc('session.list', {});
  const session = listing.items?.find(item => item.sessionId === target.sessionId);
  const asOfSeq = session?.projections?.asOfSeq;
  if (!session || session.running !== false || !Number.isSafeInteger(asOfSeq) || asOfSeq < terminal.seq || history.projections?.asOfSeq !== asOfSeq) throw new Error('当前任务仍在执行或状态已变化，请刷新后再操作。');
  if (!isCurrent() || signal?.aborted) throw new Error('当前对话或结果已变化，请在最新结果上操作。');
  onSubmitting();
  const result = await rpc('session.prompt', { sessionId: target.sessionId, mode: 'queue', content: [{ type: 'text', text: messages[action] }] },
    { 'x-forge-action-session-id': target.sessionId, 'x-forge-action-as-of-seq': String(asOfSeq) });
  if (result?.accepted !== true) throw new Error('请求结果尚未确认，请刷新对话查看结果，不要重复提交。');
  return result;
}
function forgeWorkpodActionIdentity(sessionId, group, action) {
  return { sessionId, questionSeq: group.question.data.seq, terminalSeq: group.tail?.data.seq, action };
}
function forgeWorkpodActionStorageKey(identity) {
  return 'forge-workpod-action:v1:' + JSON.stringify(identity);
}
function forgeWorkpodStoredAction(identity) {
  try {
    return globalThis.sessionStorage.getItem(forgeWorkpodActionStorageKey(identity)) === null
      ? { locked: false, message: '' }
      : { locked: true, message: '本次操作已有提交记录，请查看对话中的实际结果，勿重复提交。' };
  } catch { return { locked: true, message: '无法读取本次操作记录，请先恢复浏览器会话存储。' }; }
}
function ForgeWorkpodActions({ sessionId, group, running, connectionReady }) {
  const [state, setState] = react.useState({ busy: false, locked: false, message: '' });
  const current = react.useRef(null), controller = react.useRef(null), latch = react.useRef(false);
  const signature = `${sessionId}:${group.question.data.seq}:${group.tail?.data.seq}`;
  const action = group.needsConfirmation ? 'confirm' : 'release';
  const actionIdentity = forgeWorkpodActionIdentity(sessionId, group, action);
  const saved = forgeWorkpodStoredAction(actionIdentity);
  current.current = signature;
  react.useEffect(() => () => { current.current = null; controller.current?.abort(); }, []);
  const submit = async action => {
    if (latch.current || running || !connectionReady || !group.tail || forgeWorkpodStoredAction(actionIdentity).locked) return;
    latch.current = true;
    const identity = signature, abort = new AbortController(); controller.current = abort;
    let submitted = false;
    setState({ busy: true, locked: false, message: '正在核对当前结果…' });
    try {
      await forgeSubmitWorkpodAction({ sessionId, questionSeq: group.question.data.seq, terminalSeq: group.tail.data.seq }, action,
        { signal: abort.signal, isCurrent: () => current.current === identity,
          onSubmitting: () => {
            try { globalThis.sessionStorage.setItem(forgeWorkpodActionStorageKey(actionIdentity), JSON.stringify(actionIdentity)); }
            catch { throw new Error('无法保存本次操作记录，请先恢复浏览器会话存储；请求尚未发送。'); }
            submitted = true;
            setState({ busy: true, locked: true, message: '正在提交，等待接纳结果，请勿重复操作…' });
          } });
      if (current.current === identity) setState({ busy: false, locked: true, message: '请求已提交，等待执行结果。' });
    } catch (error) {
      if (submitted && error.requestAccepted === false) {
        try { globalThis.sessionStorage.removeItem(forgeWorkpodActionStorageKey(actionIdentity)); submitted = false; }
        catch { /* Preserve the lock when its stored identity could not be removed. */ }
      }
      if (current.current === identity) setState({ busy: false, locked: submitted, message: submitted ? `${error.message} 请先查看对话中的实际结果，勿重复提交。` : error.message });
    } finally { if (!submitted) latch.current = false; }
  }
  return react_jsx_runtime.jsxs('section', { className: 'forge-workpod-actions', 'aria-label': '当前结果操作', children: [
    react_jsx_runtime.jsx('button', { type: 'button', disabled: state.busy || state.locked || saved.locked || running || !connectionReady || !group.tail,
      onClick: () => submit(action), children: group.needsConfirmation ? '确认执行当前范围' : '发版' }),
    (state.message || saved.message) && react_jsx_runtime.jsx('span', { role: 'status', 'aria-live': 'polite', children: state.message || saved.message })
  ] });
}
async function forgeSubmitQueuedSession(session, content, signal) {
  await globalThis.__forgeEnqueuePrompt({ sessionId: session.sessionId, content,
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, signal);
  // Queue admission engages the composer only. It does not create native
  // user/turn events, set running, or claim that session.prompt was accepted.
  const wasBlank = session.blankBit;
  session.promptAttempted = true;
  session.promptError = null;
  session.handleBlank(false);
  if (wasBlank) session.options.onEngaged?.(session);
  session.notifier.markDirty();
}
function ForgeConversationQueueLayout({ sessionId, useSessions, openSession, children }) {
  const [expanded, setExpanded] = react.useState(false);
  return react_jsx_runtime.jsx('div', { className: 'forge-conversation-layout', children:
    react_jsx_runtime.jsxs('div', { className: 'forge-conversation-columns', children: [
      react_jsx_runtime.jsx('div', { className: 'forge-conversation-main', children }),
      react_jsx_runtime.jsxs('aside', { className: 'forge-queue-sidebar', 'aria-label': '工作舱队列面板', 'data-expanded': expanded, children: [
        react_jsx_runtime.jsx('button', { type: 'button', className: 'forge-queue-toggle', 'aria-expanded': expanded,
          'aria-controls': 'forge-queue-sidebar-body', onClick: () => setExpanded(value => !value), children: expanded ? '收起消息队列' : '展开消息队列' }),
        react_jsx_runtime.jsx('div', { id: 'forge-queue-sidebar-body', className: 'forge-queue-sidebar-body', children:
          react_jsx_runtime.jsx(ForgePromptQueueStatus, { sessionId, useSessions,
            openSession: id => { openSession(id); setExpanded(false); } }) })
      ] })
    ] }) });
}
function ForgePromptQueueStatus({ sessionId, useSessions, openSession }) {
  const [state, setState] = react.useState(null);
  const sessionsById = useSessions(s => s.byId);
  react.useEffect(() => {
    setState(null);
    return globalThis.__forgeSubscribePromptQueue?.(sessionId, setState);
  }, [sessionId]);
  if (!state) return null;
  const active = state.items.filter(item => !['completed', 'cancelled'].includes(item.status));
  const rows = active.sort((a, b) => a.sequence - b.sequence);
  const sessionLabel = id => {
    const title = sessionsById[id]?.displayTitle || sessionsById[id]?.title || `对话 ${id.replace(/^session-/, '').slice(0, 8)}`;
    return id === sessionId ? `${title}（当前对话）` : title;
  };
  const labels = { queued: '已排队', preparing: '正在准备执行', running: '正在执行', completed: '已完成', failed: '执行失败', cancelled: '已取消', uncertain: '接收结果待确认', paused: '已暂停' };
  return react_jsx_runtime.jsxs('section', { className: 'forge-prompt-queue', 'aria-label': '工作舱消息队列', children: [
    react_jsx_runtime.jsxs('div', { className: 'forge-prompt-queue-heading', children: [
      react_jsx_runtime.jsx('strong', { children: '工作舱消息队列' }),
      react_jsx_runtime.jsx('span', { role: 'status', 'aria-live': 'polite', children: state.loading ? '正在读取…' : `${active.length} 条待处理` }),
      react_jsx_runtime.jsx('button', { type: 'button', onClick: () => state.refresh(), children: '刷新队列' })
    ] }),
    react_jsx_runtime.jsx('p', { className: 'forge-prompt-queue-help', children: '可以继续发送多条消息，AI 按消息入队顺序逐条处理。已完成或已取消的消息自动退出队列，回复保留在所属对话，较早的问题可用“历史提问”查看。取消排队不会停止当前执行。' }),
    state.error && react_jsx_runtime.jsx('p', { role: 'alert', children: state.error }),
    state.actionError && react_jsx_runtime.jsx('p', { role: 'alert', children: state.actionError }),
    state.waitingForAuthorization && react_jsx_runtime.jsx('p', { role: 'status', children: '队列已保存，正在重新核对执行权限。' }),
    ...state.pausedSessions.map(id => react_jsx_runtime.jsxs('div', { className: 'forge-prompt-queue-paused', children: [
      react_jsx_runtime.jsx('span', { children: `${sessionLabel(id)}的后续消息已暂停。请查看失败或待确认的结果，再恢复后续消息。` }),
      react_jsx_runtime.jsx('button', { type: 'button', disabled: state.busyIds.includes('session:' + id), onClick: () => state.resume(id), children: '恢复后续消息' })
    ] }, id)),
    !state.loading && !rows.length && react_jsx_runtime.jsx('p', { children: '当前没有排队消息。' }),
    rows.length > 0 && react_jsx_runtime.jsx('ol', { className: 'forge-prompt-queue-list', children: rows.map(item => {
      const paused = item.status === 'queued' && state.pausedSessions.includes(item.sessionId);
      const cancellable = ['queued', 'paused'].includes(item.status);
      const currentWaiting = item.sessionId === sessionId && ['queued', 'preparing'].includes(item.status);
      return react_jsx_runtime.jsxs('li', { 'data-forge-queue-id': item.id, 'data-forge-queue-status': paused ? 'paused' : item.status, children: [
        react_jsx_runtime.jsxs('div', { className: 'forge-prompt-queue-row-heading', children: [
          react_jsx_runtime.jsx('span', { children: `消息序号 ${item.sequence}` }),
          react_jsx_runtime.jsx('button', { type: 'button', className: 'forge-queue-conversation', disabled: !sessionsById[item.sessionId], onClick: () => openSession(item.sessionId), 'aria-label': `查看对话：${sessionLabel(item.sessionId)}`, children: sessionLabel(item.sessionId) }),
          react_jsx_runtime.jsx('strong', { children: paused ? '已暂停' : currentWaiting ? '已发送，等待 AI 处理' : labels[item.status] ?? '状态待确认' }),
          item.status === 'queued' && !paused && Number.isInteger(item.position) && react_jsx_runtime.jsx('span', { children: `前面还有 ${Math.max(0, item.position - 1)} 条` }),
          cancellable && react_jsx_runtime.jsx('button', { type: 'button', disabled: state.busyIds.includes(item.id), onClick: () => state.cancel(item.id), 'aria-label': `取消第 ${item.sequence} 条排队消息`, children: '取消排队' })
        ] }),
        react_jsx_runtime.jsx('p', { className: 'forge-prompt-queue-preview', children: item.preview || '图片或附件消息' }),
        item.message && react_jsx_runtime.jsx('p', { className: 'forge-prompt-queue-help', children: item.message }),
        item.status === 'uncertain' && react_jsx_runtime.jsx('p', { className: 'forge-prompt-queue-help', children: '系统未自动重发本条消息，请先核对所属对话中的实际结果。' })
      ] }, item.id);
    }) })
  ] });
}
function ForgeQuestionRows({ order, nodeStore, renderNode, loadQuestionHistory, sessionId, useSessions, openSession, running, connectionReady }) {
  const groups = forgeWorkpodGroups(order, nodeStore);
  return groups.map((group, index) => group.standalone ? renderNode(group.standalone) : react_jsx_runtime.jsxs(react.Fragment, { children: [
    renderNode(group.question.key),
    react_jsx_runtime.jsx(ForgeQuestionProcess, { ...group, renderNode, loadQuestionHistory }),
    ...group.visible.map(renderNode),
    index === groups.length - 1 && group.tail && react_jsx_runtime.jsx(ForgeWorkpodActions, { sessionId, group, running, connectionReady }, `${sessionId}:${group.question.data.seq}:${group.tail.data.seq}`)
  ] }, group.question.key));
}
if (!document.querySelector('style[data-forge-question-history]')) {
  const style = document.createElement('style'); style.dataset.forgeQuestionHistory = 'v1';
  style.textContent = `.forge-question-search{position:sticky;top:0;z-index:3;background:var(--dsw-alias-bg-base);padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);font:inherit;color:var(--dsw-alias-label-primary)}
  .forge-question-search form{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.forge-question-search input{flex:1;min-width:120px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit}
  .forge-question-search button,.forge-question-process button{font:inherit;color:inherit;cursor:pointer;background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px}.forge-question-search button:hover,.forge-question-process button:hover{background:var(--dsw-alias-bg-l1)}
  .forge-question-search button:focus-visible,.forge-question-process button:focus-visible,.forge-question-search input:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.forge-question-search button:disabled,.forge-question-process button:disabled{opacity:.5;cursor:default}
  .forge-question-results{max-height:35vh;overflow:auto;padding-top:8px}.forge-question-result{display:block;width:100%;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:6px}.forge-question-process{color:var(--dsw-alias-label-secondary);margin:4px 0 12px}.forge-question-details{border-left:1px solid var(--dsw-alias-border-l1);padding:12px 0 0 12px}.forge-question-process .forge-question-toggle{border:0;padding-left:0}
  .forge-question-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.forge-question-toolbar form{flex:1;min-width:0}.forge-question-history{position:relative;margin-left:auto}.forge-question-history-trigger{display:flex;align-items:center;gap:6px;white-space:nowrap}.forge-question-history-trigger[aria-expanded=true]{background:var(--dsw-alias-bg-l1)}
  .forge-question-history-panel{position:absolute;right:0;top:calc(100% + 8px);z-index:4;width:min(420px,calc(100vw - 48px));border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-base);box-shadow:0 8px 28px #0002;text-align:left}.forge-question-history-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px;border-bottom:1px solid var(--dsw-alias-border-l1)}.forge-question-history-heading strong{font-weight:600}.forge-question-history-list{max-height:min(55vh,480px);overflow:auto;overscroll-behavior:contain;padding:8px}
  .forge-question-history-list .forge-question-history-item{display:flex;align-items:baseline;gap:10px;width:100%;border:0;text-align:left;padding:10px 8px}.forge-question-history-number{flex:none;min-width:2ch;text-align:right;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}.forge-question-history-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.forge-question-history-status{padding:10px 8px;color:var(--dsw-alias-label-secondary);font-size:12px}.forge-question-history-more{width:100%}
  .forge-workpod-actions{display:flex;align-items:center;gap:12px;margin:12px 0}.forge-workpod-actions button{font:inherit;padding:8px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-l1);color:inherit;cursor:pointer}.forge-workpod-actions button:disabled{opacity:.5;cursor:default}.forge-workpod-actions button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.forge-workpod-actions span{color:var(--dsw-alias-label-secondary);font-size:13px}
  .forge-prompt-queue{margin:12px 0;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px}.forge-prompt-queue p{margin:6px 0}.forge-prompt-queue-heading,.forge-prompt-queue-row-heading,.forge-prompt-queue-paused{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.forge-prompt-queue-heading>button,.forge-prompt-queue-row-heading>button{margin-left:auto}.forge-prompt-queue-help{color:var(--dsw-alias-label-secondary)}.forge-prompt-queue-list{list-style:none;margin:10px 0 0;padding:0;max-height:320px;overflow:auto;scrollbar-gutter:stable}.forge-prompt-queue-list>li{padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}.forge-prompt-queue-preview{white-space:pre-wrap;overflow-wrap:anywhere}.forge-prompt-queue button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;background:var(--dsw-alias-bg-l1)}.forge-prompt-queue button:hover:not(:disabled){background:var(--dsw-alias-bg-l2,var(--dsw-alias-bg-l1))}.forge-prompt-queue button:active:not(:disabled){opacity:.8}.forge-prompt-queue button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.forge-prompt-queue button:disabled{opacity:.5;cursor:default}.forge-prompt-queue-paused{margin-top:10px;padding:8px;border-left:3px solid var(--dsw-alias-state-warn-primary,var(--dsw-alias-border-l1))}
  .forge-conversation-layout{container-type:inline-size;flex:1;min-width:0;min-height:0;height:100%;width:100%}.forge-conversation-columns{display:grid;grid-template-columns:minmax(0,1fr) 320px;height:100%;min-height:0;min-width:0}.forge-conversation-main{min-width:0;min-height:0;height:100%;overflow:hidden}.forge-queue-sidebar{display:flex;flex-direction:column;min-height:0;min-width:0;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}.forge-queue-sidebar-body{min-height:0;flex:1;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.forge-queue-sidebar .forge-prompt-queue{margin:0;padding:14px;border:0;border-radius:0}.forge-queue-sidebar .forge-prompt-queue-list{max-height:none;overflow:visible}.forge-queue-sidebar .forge-prompt-queue-row-heading>button{margin-left:0}.forge-prompt-queue button.forge-queue-conversation{flex-basis:100%;border:0;background:transparent;padding:0;text-align:left;color:var(--dsw-alias-label-primary);font-weight:600;white-space:normal;overflow-wrap:anywhere}.forge-prompt-queue button.forge-queue-conversation:hover:not(:disabled){text-decoration:underline;background:transparent}.forge-queue-toggle{display:none;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:0;padding:10px 16px;text-align:left;cursor:pointer}.forge-queue-toggle:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-3px}@container (max-width:800px){.forge-conversation-columns{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) auto}.forge-queue-sidebar{border-left:0;border-top:1px solid var(--dsw-alias-border-l1)}.forge-queue-toggle{display:block}.forge-queue-sidebar-body{display:none;max-height:min(40vh,320px)}.forge-queue-sidebar[data-expanded=true] .forge-queue-sidebar-body{display:block}}
  [data-forge-question-seq]{scroll-margin-top:80px}.forge-question-highlight{outline:2px solid var(--dsw-alias-border-l1);outline-offset:6px;border-radius:6px}@media(max-width:600px){.forge-question-search{padding:8px}.forge-question-search label{width:100%}.forge-question-search input{min-width:0;width:100%}}`;
  style.textContent += '.forge-queue-sidebar .forge-prompt-queue-preview{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:4;overflow:hidden}';
  document.head.append(style);
}
