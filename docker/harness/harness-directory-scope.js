(() => {
  if (document.querySelector('[data-forge-directory-style]')) return;
  const style = document.createElement('style');
  style.dataset.forgeDirectoryStyle = 'true';
  style.textContent = `
    .forge-directory-scope { margin: 8px 12px; border: 1px solid var(--dsw-alias-border-1, #8885); border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 12px; }
    .forge-directory-scope summary { cursor: pointer; overflow-wrap: anywhere; }
    .forge-directory-scope summary strong { margin-right: 10px; }
    .forge-directory-scope table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .forge-directory-scope th, .forge-directory-scope td { text-align: left; padding: 6px; vertical-align: top; border-bottom: 1px solid #8883; overflow-wrap: anywhere; }
    .forge-directory-scope code { white-space: normal; overflow-wrap: anywhere; }
    .forge-directory-scope p { margin: 8px 0 0; line-height: 1.5; opacity: .8; }
    .forge-directory-scope__table { overflow-x: auto; }
  `;
  document.head.append(style);
  let pending;
  let snapshot;
  let failure = false;
  let scheduled = false;

  function node(tag, text) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function render(panel) {
    const summary = panel.querySelector('summary');
    summary.replaceChildren(node('strong', '可操作目录 · 只读展示'));
    const content = panel.querySelector('[data-forge-directory-content]');
    content.replaceChildren();
    if (!snapshot) {
      summary.append(node('span', failure ? '目录信息暂不可用' : '正在读取实际权限…'));
      if (failure) content.append(node('p', '未能读取服务端目录信息。重新展开可重试，当前不会假定任何额外目录已获授权。'));
      return;
    }
    const directories = Array.isArray(snapshot.directories) ? snapshot.directories : [];
    const current = directories.find((entry) => entry.default);
    summary.append(node('span', current
      ? `${current.name} ${current.path} · ${current.access === 'read-write' ? '按任务授权读写' : '只读'} · 共 ${directories.length} 个目录`
      : `共 ${directories.length} 个目录，默认代码目录未挂载`));
    const table = node('table');
    const head = node('tr');
    for (const title of ['用途', 'Harness 内路径', '权限', '服务器目录 / FTP 关联']) head.append(node('th', title));
    const thead = node('thead'); thead.append(head); table.append(thead);
    const tbody = node('tbody');
    for (const entry of directories) {
      const row = node('tr');
      row.append(node('td', entry.name));
      const location = node('td'); location.append(node('code', entry.path)); row.append(location);
      row.append(node('td', entry.scope === 'explicit-task'
        ? `本次指名后${entry.access === 'read-write' ? '读写' : '只读'}`
        : entry.access === 'read-write' ? '按任务授权读写' : '只读'));
      const source = node('td'); source.append(node('code', entry.sourcePath || '未提供'));
      if (entry.association) source.append(node('p', entry.association));
      if (entry.exclusions?.length) source.append(node('p', `保护范围：${entry.exclusions.join('、')}`));
      row.append(source); tbody.append(row);
    }
    table.append(tbody); content.append(table, node('p', snapshot.notice));
    if (snapshot.managedDirectoryStatus === 'unavailable') content.append(node('p', '额外文件目录信息暂不可用，不能据此判断其授权范围。'));
  }

  function renderAll() {
    for (const panel of document.querySelectorAll('[data-forge-directory-scope]')) render(panel);
  }

  async function refresh() {
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetch('/forge-directories', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
        const result = await response.json();
        if (!response.ok || result.ok !== true || result.editable !== false) throw new Error('directory scope unavailable');
        snapshot = result; failure = false;
      } catch { snapshot = undefined; failure = true; }
      finally { pending = undefined; renderAll(); }
    })();
    return pending;
  }

  function mount() {
    scheduled = false;
    const card = document.querySelector('[data-composer-card="true"]');
    if (!(card instanceof HTMLElement) || card.querySelector('[data-forge-directory-scope]')) return;
    const panel = node('details');
    panel.className = 'forge-directory-scope'; panel.dataset.forgeDirectoryScope = 'true';
    panel.setAttribute('aria-label', '当前 Harness 可操作目录，只读');
    const content = node('div'); content.dataset.forgeDirectoryContent = 'true'; content.className = 'forge-directory-scope__table';
    panel.append(node('summary'), content);
    panel.addEventListener('toggle', () => { if (panel.open) void refresh(); });
    card.prepend(panel);
    render(panel);
    void refresh();
  }
  new MutationObserver(() => {
    if (!scheduled) { scheduled = true; requestAnimationFrame(mount); }
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('focus', () => { if (document.querySelector('[data-forge-directory-scope]')) void refresh(); });
  mount();
})();
