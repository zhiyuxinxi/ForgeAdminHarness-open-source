(() => {
  const API_ROOT = '/forge-output';
  const PAGE_SIZE = 20;
  const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
  const codePreviews = new WeakMap();
  let codePreviewId = 0;
  const statusLabels = { completed: '已完成', running: '进行中', failed: '失败', stopped: '已停止', empty: '空' };
  const requests = new Set();
  let sessionId = '';
  let generation = 0;
  let archives = [];
  let offset = 0;
  let hasMore = false;
  let listing = false;
  let saving = false;
  let previewGeneration = 0;
  let opener;
  let referenceClosing = false;
  let mountScheduled = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, action) {
    const node = element('button', 'forge-upload-button forge-output-action', text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  const style = element('style');
  style.dataset.forgeHarnessCompat = 'conversation-output';
  style.textContent = `
    .forge-output-dialog {
      background: var(--dsw-alias-bg-layer-1, #fff);
      border: 1px solid var(--dsw-alias-border-1, #d8e1e9);
      border-radius: 12px;
      color: inherit;
      font: inherit;
      margin: auto;
      max-height: calc(100dvh - 32px);
      max-width: calc(100vw - 32px);
      overflow: hidden;
      padding: 0;
      width: 760px;
    }
    .forge-output-dialog[open] { display: flex; flex-direction: column; }
    .forge-output-dialog::backdrop { background: rgba(0, 0, 0, .42); }
    .forge-output-header { border-bottom: 1px solid var(--dsw-alias-border-1, #d8e1e9); flex: none; padding: 18px; }
    .forge-output-heading, .forge-output-toolbar, .forge-output-file, .forge-output-actions {
      align-items: center; display: flex; flex-wrap: wrap; gap: 8px;
    }
    .forge-output-heading { justify-content: space-between; }
    .forge-output-heading h2 { font-size: 18px; font-weight: 600; margin: 0; }
    .forge-output-description, .forge-output-meta, .forge-output-status {
      color: var(--dsw-alias-fg-muted, #647386); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere;
    }
    .forge-output-description { margin: 8px 0; }
    .forge-output-status { margin: 8px 0 0; min-height: 1.6em; }
    .forge-output-status[data-tone="error"] { color: var(--dsw-alias-fg-error, #b44242); }
    .forge-output-action { justify-content: center; min-height: 34px; text-decoration: none; }
    .forge-output-save { min-width: 8.5em; }
    .forge-output-body { min-height: 0; overflow: auto; padding: 16px 18px; scrollbar-gutter: stable; }
    .forge-output-list, .forge-output-files { list-style: none; margin: 0; padding: 0; }
    .forge-output-record { border-bottom: 1px solid var(--dsw-alias-border-1, #d8e1e9); padding: 14px 0; }
    .forge-output-record:first-child { padding-top: 0; }
    .forge-output-record h3 { font-size: 14px; font-weight: 600; margin: 0 0 4px; overflow-wrap: anywhere; }
    .forge-output-file { justify-content: space-between; padding: 9px 0 0; }
    .forge-output-file-info { flex: 1 1 220px; min-width: 0; }
    .forge-output-filename { font-size: 13px; overflow-wrap: anywhere; }
    .forge-output-empty { color: var(--dsw-alias-fg-muted, #647386); font-size: 13px; margin: 18px 0; }
    .forge-output-preview { border-top: 1px solid var(--dsw-alias-border-1, #d8e1e9); margin-top: 16px; padding-top: 16px; }
    .forge-output-preview h3 { font-size: 14px; margin: 0; overflow-wrap: anywhere; }
    .forge-output-preview pre { font: 12px/1.7 ui-monospace, Consolas, monospace; overflow-wrap: anywhere; white-space: pre-wrap; }
    .forge-output-more { margin-top: 14px; }
    .forge-output-dialog [hidden] { display: none; }
    [data-chat-flow-kind="assistant-step"] .md-code-block[data-forge-code-collapsed="true"] pre {
      max-height: 16rem;
      overflow: auto;
      scrollbar-gutter: stable;
    }
    .forge-code-preview-actions {
      align-items: center; border-top: 1px solid var(--dsw-alias-border-l2, #d8e1e9);
      display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 12px;
    }
    .forge-code-preview-actions[hidden] { display: none; }
    @media print {
      [data-chat-flow-kind="assistant-step"] .md-code-block[data-forge-code-collapsed="true"] pre {
        max-height: none; overflow: visible;
      }
      .forge-code-preview-actions { display: none; }
    }
    @media (max-width: 620px) {
      .forge-output-header { padding: 12px; }
      .forge-output-body { padding: 12px; }
      .forge-output-action { min-height: 40px; }
    }
    @media (forced-colors: active) { .forge-output-dialog { border-color: CanvasText; } }
  `;
  document.head.append(style);

  const dialog = element('dialog', 'forge-output-dialog');
  dialog.id = 'forge-conversation-output-dialog';
  dialog.setAttribute('aria-labelledby', 'forge-conversation-output-title');
  dialog.setAttribute('aria-describedby', 'forge-conversation-output-description');
  const header = element('header', 'forge-output-header');
  const heading = element('div', 'forge-output-heading');
  const title = element('h2', '', '对话文件');
  title.id = 'forge-conversation-output-title';
  title.tabIndex = -1;
  const closeButton = button('关闭', () => dialog.close());
  closeButton.setAttribute('aria-label', '关闭对话文件');
  heading.append(title, closeButton);
  const description = element('p', 'forge-output-description', '回复结束或停止后自动归档；进行中也可保存当前记录。管理员可查阅对话输入、输出和归档文件。');
  description.id = 'forge-conversation-output-description';
  const sessionLabel = element('p', 'forge-output-meta');
  const toolbar = element('div', 'forge-output-toolbar');
  const saveButton = button('保存当前记录', saveSnapshot);
  saveButton.className += ' forge-output-save';
  const refreshButton = button('刷新', () => loadList(true));
  toolbar.append(saveButton, refreshButton);
  const phaseLink = element('a', 'forge-upload-button forge-output-action', '查看阶段成果');
  phaseLink.target = '_blank';
  phaseLink.rel = 'noopener noreferrer';
  phaseLink.hidden = true;
  const feedback = element('p', 'forge-output-status');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  header.append(heading, description, sessionLabel, toolbar, feedback);
  const body = element('div', 'forge-output-body');
  const list = element('ul', 'forge-output-list');
  list.setAttribute('aria-label', '当前对话的已保存记录');
  const empty = element('p', 'forge-output-empty');
  const moreButton = button('加载更多', () => loadList(false));
  moreButton.className += ' forge-output-more';
  moreButton.hidden = true;
  const preview = element('section', 'forge-output-preview');
  preview.hidden = true;
  preview.setAttribute('aria-label', '文件文本预览');
  body.append(list, empty, moreButton, preview);
  dialog.append(header, body);
  document.body.append(dialog);

  function validSegment(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 512
      && value !== '.' && value !== '..' && !/[\/\\\u0000-\u001f\u007f]/.test(value);
  }

  function fileLabel(file, key, fallback = '') {
    return typeof file[key] === 'string' && file[key].trim() ? file[key] : fallback;
  }

  function updatePhaseLink(value) {
    phaseLink.hidden = true;
    phaseLink.removeAttribute('href');
    phaseLink.remove();
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || !url.searchParams.get('project') || !url.searchParams.get('phaseFiles')) return;
      phaseLink.href = url.href;
      phaseLink.hidden = false;
      toolbar.append(phaseLink);
    } catch { /* Older servers do not advertise a phase file entry. */ }
  }

  function currentSession() {
    try {
      const value = JSON.parse(localStorage.getItem('dsh.sessions.current') || 'null')?.sessionId;
      return validSegment(value) ? value : '';
    } catch { return ''; }
  }

  function announce(message, error = false) {
    feedback.textContent = message;
    feedback.dataset.tone = error ? 'error' : 'info';
  }

  function cancelRequests() {
    generation += 1;
    previewGeneration += 1;
    for (const controller of requests) controller.abort();
    requests.clear();
    listing = false;
    saving = false;
  }

  function syncSession() {
    const next = currentSession();
    if (next === sessionId) return false;
    cancelRequests();
    sessionId = next;
    archives = [];
    offset = 0;
    hasMore = false;
    updatePhaseLink();
    preview.replaceChildren();
    preview.hidden = true;
    renderList();
    announce(next ? '当前对话已切换，请刷新查看记录。' : '请先打开一个对话。');
    return true;
  }

  function stillCurrent(stamp, id) {
    if (currentSession() !== sessionId) syncSession();
    return generation === stamp && sessionId === id && dialog.open;
  }

  function updateControls() {
    saveButton.disabled = !sessionId || saving || listing;
    refreshButton.disabled = !sessionId || saving || listing;
    moreButton.disabled = saving || listing;
    moreButton.hidden = !hasMore;
    saveButton.setAttribute('aria-busy', String(saving));
    list.setAttribute('aria-busy', String(listing));
    sessionLabel.textContent = sessionId ? `当前对话：${sessionId}` : '请先打开一个对话，再查看或保存记录。';
  }

  async function request(url, options = {}) {
    const controller = new AbortController();
    requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      if (!response.ok) {
        if (response.status === 401) throw new Error('登录已过期，请重新登录后再试。');
        if (response.status === 403) throw new Error('无权访问此对话的文件。');
        throw new Error(`请求失败（HTTP ${response.status}），请重试。`);
      }
      return options.preview ? await response.text() : await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时或已取消；可先刷新确认记录是否已保存。');
      if (error instanceof TypeError) throw new Error('连接失败，请检查网络后重试。');
      if (error instanceof SyntaxError) throw new Error('服务器响应格式异常，请刷新重试。');
      throw error;
    } finally {
      clearTimeout(timer);
      requests.delete(controller);
    }
  }

  function checkedArchive(archive, expectedSession) {
    if (!archive || archive.sessionId !== expectedSession || !validSegment(archive.snapshotId)
      || typeof archive.status !== 'string' || !Array.isArray(archive.files)
      || archive.files.some((file) => !validSegment(file?.name)
        || typeof file.mediaType !== 'string' || typeof file.modelPath !== 'string'
        || !file.modelPath.startsWith('/') || /[\u0000-\u001f\u007f]/.test(file.modelPath)
        || file.modelPath.length > 4096 || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) {
      throw new Error('文件列表格式异常，请刷新重试。');
    }
    return archive;
  }

  async function loadList(reset) {
    if (syncSession()) reset = true;
    updateControls();
    if (!sessionId || listing || saving) return;
    const stamp = generation;
    const id = sessionId;
    const pageOffset = reset ? 0 : offset;
    listing = true;
    updateControls();
    announce(reset ? '正在读取已保存记录…' : '正在加载更多记录…');
    try {
      const query = new URLSearchParams({ sessionId: id, offset: String(pageOffset), limit: String(PAGE_SIZE) });
      const payload = await request(`${API_ROOT}/snapshots?${query}`);
      if (!stillCurrent(stamp, id)) return;
      if (payload.ok !== true || !Array.isArray(payload.items) || payload.items.length > PAGE_SIZE
        || payload.offset !== pageOffset || payload.limit !== PAGE_SIZE || typeof payload.hasMore !== 'boolean'
        || (payload.hasMore && payload.items.length === 0)) throw new Error('文件列表格式异常，请刷新重试。');
      const items = payload.items.map((archive) => checkedArchive(archive, id));
      updatePhaseLink(payload.phaseFilesUrl);
      archives = [...new Map([...(reset ? [] : archives), ...items].map((archive) => [archive.snapshotId, archive])).values()];
      offset = pageOffset + items.length;
      hasMore = payload.hasMore;
      renderList();
      announce(archives.length ? `已显示 ${archives.length} 份记录。` : '尚未保存记录，可点击“保存当前记录”。');
      if (payload.automatic?.status === 'failed') announce('最近一次自动归档失败，原对话仍保留。请点击“保存当前记录”重试。', true);
    } catch (error) {
      if (stillCurrent(stamp, id)) announce(error.message, true);
    } finally {
      if (stillCurrent(stamp, id)) { listing = false; updateControls(); }
    }
  }

  async function saveSnapshot() {
    if (syncSession()) { await loadList(true); return; }
    if (!sessionId || saving || listing) return;
    const stamp = generation;
    const id = sessionId;
    saving = true;
    updateControls();
    announce('正在保存当前对话记录…');
    try {
      const payload = await request(`${API_ROOT}/snapshots`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }),
      });
      if (!stillCurrent(stamp, id)) return;
      if (payload.ok !== true) throw new Error('保存未成功，请刷新确认后重试。');
      const archive = checkedArchive(payload.archive, id);
      // A new snapshot changes offset paging. Reload before allowing another page.
      saving = false;
      await loadList(true);
      if (stillCurrent(stamp, id)) {
        if (feedback.dataset.tone === 'error') announce(`记录已保存；列表刷新未完成。${feedback.textContent}`, true);
        else announce(`记录已保存 · ${statusLabels[archive.status] || '状态未知'}。`);
      }
    } catch (error) {
      if (stillCurrent(stamp, id)) announce(error.message, true);
    } finally {
      if (stillCurrent(stamp, id)) { saving = false; updateControls(); }
    }
  }

  function fileUrl(archive, file) {
    return `${API_ROOT}/files/${[archive.sessionId, archive.snapshotId, file.name].map(encodeURIComponent).join('/')}`;
  }

  function fileActionCurrent(archive) {
    if (syncSession() || archive.sessionId !== sessionId) {
      announce('当前对话已切换，请刷新后再选择文件。');
      return false;
    }
    return true;
  }

  async function previewFile(archive, file, trigger) {
    if (!fileActionCurrent(archive)) return;
    const stamp = generation;
    const id = sessionId;
    const previewStamp = ++previewGeneration;
    preview.hidden = false;
    const row = element('div', 'forge-output-heading');
    const previewTitle = element('h3', '', `文本预览 · ${fileLabel(file, 'displayName', file.name)}`);
    previewTitle.tabIndex = -1;
    row.append(previewTitle, button('收起预览', () => {
      previewGeneration += 1;
      preview.hidden = true;
      if (trigger.isConnected) trigger.focus();
    }));
    const text = element('pre', '', '正在读取文件…');
    text.setAttribute('aria-live', 'polite');
    preview.replaceChildren(row, text);
    previewTitle.focus();
    if (file.bytes > PREVIEW_MAX_BYTES) {
      text.textContent = '文件超过 2 MB，请使用“下载”查看完整内容。';
      return;
    }
    if (!/^(text\/|application\/(?:json|x-ndjson)(?:;|$))/.test(file.mediaType)) {
      text.textContent = '此文件不支持文本预览，请下载查看。';
      return;
    }
    try {
      const content = await request(fileUrl(archive, file), { preview: true });
      if (stillCurrent(stamp, id) && previewStamp === previewGeneration) text.textContent = content;
    } catch (error) {
      if (stillCurrent(stamp, id) && previewStamp === previewGeneration) text.textContent = error.message;
    }
  }

  function referenceFile(archive, file) {
    if (!fileActionCurrent(archive)) return;
    const event = new CustomEvent('forge-conversation-output-reference', {
      cancelable: true, detail: { sessionId, modelPath: file.modelPath },
    });
    referenceClosing = true;
    dialog.close();
    if (document.dispatchEvent(event)) {
      referenceClosing = false;
      dialog.showModal();
      announce('输入框暂不可用，未插入引用。请关闭面板后重试。', true);
      title.focus();
    }
  }

  function renderList() {
    list.replaceChildren();
    for (const archive of archives) {
      const item = element('li', 'forge-output-record');
      const date = new Date(archive.createdAt);
      const dateLabel = Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hour12: false,
      }).format(date);
      item.append(element('h3', '', `${statusLabels[archive.status] || '状态未知'} · ${dateLabel}（北京时间）`));
      const shortVersion = /^[a-f0-9]{64}$/.test(archive.snapshotId) ? archive.snapshotId.slice(0, 8) : archive.snapshotId;
      const versionLabel = fileLabel(archive.files[0] || {}, 'versionLabel', `版本 ${shortVersion}`);
      const details = element('details', 'forge-output-meta');
      details.append(element('summary', '', `${versionLabel} · ${archive.files.length} 个文件 · 版本详情`),
        element('div', '', `完整记录编号：${archive.snapshotId}`));
      item.append(details);
      const files = element('ul', 'forge-output-files');
      for (const file of archive.files) {
        const row = element('li', 'forge-output-file');
        const info = element('div', 'forge-output-file-info');
        const name = fileLabel(file, 'displayName', file.name);
        info.append(element('div', 'forge-output-filename', `${name}${file.primary === true ? ' · 先看这份' : ''}`),
          element('div', 'forge-output-meta', [fileLabel(file, 'phaseLabel'), fileLabel(file, 'usageLabel'),
            `${file.bytes.toLocaleString('zh-CN')} 字节`].filter(Boolean).join(' · ')));
        if (fileLabel(file, 'usageHint')) info.append(element('div', 'forge-output-meta', file.usageHint));
        const actions = element('div', 'forge-output-actions');
        const previewButton = button('预览', () => previewFile(archive, file, previewButton));
        previewButton.setAttribute('aria-label', `预览 ${name}`);
        const download = element('a', 'forge-upload-button forge-output-action', '下载');
        download.href = `${fileUrl(archive, file)}?download=1`;
        download.download = fileLabel(file, 'downloadName', name);
        download.setAttribute('aria-label', `下载 ${name}`);
        download.addEventListener('click', (event) => { if (!fileActionCurrent(archive)) event.preventDefault(); });
        const reference = button('引用', () => referenceFile(archive, file));
        reference.setAttribute('aria-label', `引用 ${name}，插入输入框但不发送`);
        actions.append(previewButton, download, reference);
        row.append(info, actions);
        files.append(row);
      }
      item.append(files);
      list.append(item);
    }
    empty.hidden = archives.length > 0;
    empty.textContent = sessionId ? '当前对话暂无已保存记录。' : '打开对话后，可在这里查看和保存记录。';
    updateControls();
  }

  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    cancelRequests();
    if (!referenceClosing && opener?.isConnected) opener.focus();
    referenceClosing = false;
  });

  function openOutputPanel(trigger) {
    opener = trigger;
    syncSession();
    renderList();
    dialog.showModal();
    title.focus();
    loadList(true);
  }

  function mountCodePreviews() {
    // Pinned DSH 0.1.1-rc.2: assistant-step owns MarkdownText; CodeBlock owns
    // .md-code-block and its pre. Keep both React-owned nodes and copy text intact.
    for (const block of document.querySelectorAll('[data-chat-flow-kind="assistant-step"] .md-code-block')) {
      const pre = block.querySelector('pre');
      const content = pre?.textContent || '';
      const long = content.length > 2400 || content.split('\n', 18).length > 16;
      let state = codePreviews.get(block);
      if (!pre || !long) {
        delete block.dataset.forgeCodeCollapsed;
        if (state) state.controls.hidden = true;
        continue;
      }
      if (!state) {
        const controls = element('div', 'forge-code-preview-actions');
        const toggle = button('展开完整代码', () => {
          state.expanded = !state.expanded;
          block.dataset.forgeCodeCollapsed = String(!state.expanded);
          toggle.setAttribute('aria-expanded', String(state.expanded));
          toggle.textContent = state.expanded ? '收起长代码' : '展开完整代码';
        });
        const files = button('对话文件', () => openOutputPanel(files));
        files.setAttribute('aria-label', '打开当前对话文件，查看保存状态与完整记录');
        controls.append(toggle, files);
        state = { controls, toggle, expanded: false, id: `forge-code-preview-${++codePreviewId}` };
        codePreviews.set(block, state);
      }
      // Streaming/highlighting may replace pre while retaining the same code block.
      // Preserve the user's expansion choice and bind the control to the live pre.
      if (!pre.id) pre.id = state.id;
      state.toggle.setAttribute('aria-controls', pre.id);
      state.toggle.setAttribute('aria-expanded', String(state.expanded));
      block.dataset.forgeCodeCollapsed = String(!state.expanded);
      state.controls.hidden = false;
      if (!block.contains(state.controls)) block.append(state.controls);
    }
  }

  function mount() {
    mountScheduled = false;
    const slot = document.querySelector('[data-composer-card="true"] [data-slot="conversation.input.left"]');
    if (slot && !slot.querySelector('[data-forge-conversation-output-button]')) {
      const open = button('对话文件', () => openOutputPanel(open));
      open.dataset.forgeConversationOutputButton = 'true';
      open.setAttribute('aria-haspopup', 'dialog');
      open.setAttribute('aria-controls', dialog.id);
      slot.append(open);
    }
    mountCodePreviews();
    if (dialog.open && syncSession()) loadList(true);
  }

  const observer = new MutationObserver(() => {
    if (mountScheduled) return;
    mountScheduled = true;
    requestAnimationFrame(mount);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.addEventListener('storage', (event) => { if (event.key === 'dsh.sessions.current') mount(); });
  window.addEventListener('focus', mount);
  renderList();
  mount();
})();
