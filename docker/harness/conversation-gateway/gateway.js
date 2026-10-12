const state = {
  session: null,
  projects: [],
  selectedProjectSlug: null,
  conversations: [],
  materials: [],
  materialIntake: [],
  materialCategories: [],
  materialAccessMode: 'reviewed',
  nextOffset: null,
  renameId: null,
  confirmAction: null,
  usersRefreshPending: false,
  membershipUser: null,
  conversationLoading: false,
  provisioningTimer: null,
  provisioningLoading: false,
  conversationScope: 'own',
  outputConversation: null,
  outputOffset: 0,
  outputHasMore: false,
  outputLoading: false,
  outputGeneration: 0,
  outputRequests: new Set(),
  outputPreviewRequest: null,
  releaseStatusController: null,
  releaseStatusTimer: null,
  releaseStatusGeneration: 0,
};

const roleLabels = { admin: '管理员', member: '成员', auditor: '审计员' };
const statusLabels = { active: '运行中', stopped: '已停止', closed: '已关闭', provisioning: '创建中', failed: '创建失败' };
const outputStatusLabels = { running: '进行中', completed: '已完成', failed: '失败', stopped: '已停止', empty: '空会话' };
const projectKindLabels = { foundation: '基础项目', delivery: '交付项目', replica: '项目副本' };
const materialCategoryLabels = { business: '业务资料', 'standards/ui': 'UI 规范', reference: '参考资料' };

function element(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type) node.type = options.type;
  if (options.title) node.title = options.title;
  for (const child of children) node.append(child);
  return node;
}

function setMessage(target, message) {
  target.textContent = message;
  target.hidden = message.length === 0;
}

let toastTimer;
function toast(message) {
  const target = document.querySelector('#toast');
  target.textContent = message;
  target.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { target.hidden = true; }, 3500);
}

function dateLabel(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? '—' : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(parsed);
}

function byteLabel(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function randomIdempotencyKey() {
  if (typeof crypto.randomUUID === 'function') return `conversation:${crypto.randomUUID()}`;
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `conversation:${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

async function api(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers ?? {}) };
  if (options.method && options.method !== 'GET') headers['x-forge-csrf-token'] = state.session.csrfToken;
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) {
    window.location.assign('/forge-gateway/login');
    throw new Error('登录已失效。');
  }
  const value = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.message ?? '操作失败。');
    error.code = value.code;
    error.status = response.status;
    throw error;
  }
  return value;
}

function button(label, className, handler) {
  const node = element('button', { className, text: label, type: 'button' });
  node.addEventListener('click', handler);
  return node;
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (!dialog.open) dialog.showModal();
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog.open) dialog.close();
}

function statusBadge(status) {
  return element('span', { className: `status-badge ${status}`, text: statusLabels[status] ?? status });
}

function isOwnConversation(conversation) {
  return conversation.owner === undefined || conversation.owner?.id === state.session?.user?.id;
}

function outputFileUrl(conversation, snapshot, file, download = false) {
  const base = `/forge-gateway/api/conversations/${encodeURIComponent(conversation.id)}/outputs/${encodeURIComponent(snapshot.sessionId)}/${encodeURIComponent(snapshot.snapshotId)}/${encodeURIComponent(file.name)}`;
  return download ? `${base}?download=1` : base;
}

function phaseOutputFileUrl(conversation, packageItem, file, download = false) {
  const base = `/forge-gateway/api/conversations/${encodeURIComponent(conversation.id)}/phase-outputs/${encodeURIComponent(packageItem.packageId)}/${encodeURIComponent(file.name)}`;
  return download ? `${base}?download=1` : base;
}

function fileLabel(file, key, fallback = '') {
  return typeof file[key] === 'string' && file[key].trim() ? file[key] : fallback;
}

function outputCurrent(conversation, generation) {
  return state.outputConversation?.id === conversation.id && state.outputGeneration === generation;
}

function cancelOutputRequests() {
  state.outputGeneration += 1;
  for (const controller of state.outputRequests) controller.abort();
  state.outputRequests.clear();
  state.outputPreviewRequest = null;
  state.outputLoading = false;
}

async function outputRequest(path, { preview = false, controller = new AbortController() } = {}) {
  state.outputRequests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    if (!preview) return await api(path, { signal: controller.signal });
    const response = await fetch(path, { headers: { accept: 'text/plain' }, signal: controller.signal });
    if (response.status === 401) { window.location.assign('/forge-gateway/login'); throw new Error('登录已失效。'); }
    if (!response.ok) throw new Error(response.status === 403 ? '无权查看此文件。' : response.status === 404 ? '文件已不存在，请刷新列表。' : '文件读取失败，请重试。');
    if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('文件超过 2 MB，请下载查看完整内容。');
    const chunks = [];
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('文件超过 2 MB，请下载查看完整内容。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return await new Blob(chunks).text();
  } finally {
    clearTimeout(timeout);
    state.outputRequests.delete(controller);
  }
}

async function previewOutputFile(conversation, snapshot, file, urlFor = outputFileUrl) {
  const generation = state.outputGeneration;
  state.outputPreviewRequest?.abort();
  const controller = new AbortController();
  state.outputPreviewRequest = controller;
  const preview = document.querySelector('#output-preview');
  preview.textContent = '正在读取文件…';
  document.querySelector('#output-preview-title').textContent = fileLabel(file, 'displayName', file.name);
  const download = document.querySelector('#output-download-link');
  download.href = urlFor(conversation, snapshot, file, true);
  download.setAttribute('download', fileLabel(file, 'downloadName', file.name));
  download.setAttribute('aria-label', `下载 ${fileLabel(file, 'displayName', file.name)}`);
  document.querySelector('#output-preview-panel').hidden = false;
  preview.focus();
  if (file.bytes > 2 * 1024 * 1024) { preview.textContent = '文件超过 2 MB，请下载查看完整内容。'; return; }
  if (!/^(text\/|application\/(?:json|x-ndjson)(?:;|$))/.test(file.mediaType)) { preview.textContent = '此文件不支持文本预览，请下载查看。'; return; }
  try {
    const text = await outputRequest(urlFor(conversation, snapshot, file), { preview: true, controller });
    if (outputCurrent(conversation, generation) && state.outputPreviewRequest === controller) preview.textContent = text;
  } catch (error) {
    if (outputCurrent(conversation, generation) && state.outputPreviewRequest === controller) {
      preview.textContent = error.name === 'AbortError' ? '读取超时，请重新预览或下载文件。' : error.message;
    }
  }
}

function outputFileRow(conversation, snapshot, file, urlFor = outputFileUrl) {
  const name = fileLabel(file, 'displayName', file.name);
  const primary = file.primary === true || (urlFor === phaseOutputFileUrl && /^01-result\./.test(file.name));
  const info = element('div', { className: 'output-file-info' }, [
    element('div', { className: 'output-file-name', text: name }),
    element('div', { className: 'muted output-file-meta', text: [fileLabel(file, 'phaseLabel'), fileLabel(file, 'usageLabel'), byteLabel(file.bytes)].filter(Boolean).join(' · ') }),
  ]);
  if (primary) info.prepend(element('strong', { className: 'output-primary-label', text: '先看这份' }));
  if (fileLabel(file, 'usageHint')) info.append(element('p', { className: 'output-file-hint', text: file.usageHint }));
  const preview = button('预览', 'secondary-button', () => previewOutputFile(conversation, snapshot, file, urlFor));
  preview.setAttribute('aria-label', `预览 ${name}`);
  const download = element('a', { className: 'secondary-button button-link', text: '下载' });
  download.href = urlFor(conversation, snapshot, file, true);
  download.setAttribute('download', fileLabel(file, 'downloadName', name));
  download.setAttribute('aria-label', `下载 ${name}`);
  return element('li', { className: `output-file${primary ? ' output-file-primary' : ''}` }, [info,
    element('span', { className: 'row-actions' }, [preview, download])]);
}

function outputVersionDetails(label, identities) {
  return element('details', { className: 'output-version-details muted' }, [
    element('summary', { text: `${label} · 版本详情` }), ...identities.map((text) => element('div', { text })),
  ]);
}

async function loadPhaseOutputs(conversation = state.outputConversation) {
  if (!conversation) return;
  const generation = state.outputGeneration;
  const retry = document.querySelector('#phase-output-retry');
  retry.disabled = true;
  document.querySelector('#phase-output-loading').hidden = false;
  document.querySelector('#phase-output-empty').hidden = true;
  setMessage(document.querySelector('#phase-output-error'), '');
  try {
    const value = await outputRequest(`/forge-gateway/api/conversations/${encodeURIComponent(conversation.id)}/phase-outputs`);
    if (!outputCurrent(conversation, generation)) return;
    if (value.unavailable) throw new Error(fileLabel(value.unavailable, 'message', '阶段成果暂不可用，请重新加载。'));
    if (!Array.isArray(value.items)) throw new Error('阶段成果列表格式异常，请重新加载。');
    const list = document.querySelector('#phase-output-list');
    list.replaceChildren();
    const stages = new Map();
    for (const packageItem of [...value.items].sort((a, b) => a.phaseIndex - b.phaseIndex)) {
      if (!Array.isArray(packageItem.files)) throw new Error('阶段成果文件列表格式异常，请重新加载。');
      let stage = stages.get(packageItem.phaseId);
      if (!stage) {
        stage = element('section', { className: 'phase-output-stage' }, [element('h4', {
          text: fileLabel(packageItem, 'phaseLabel', `阶段 ${packageItem.phaseIndex}`),
        })]);
        stages.set(packageItem.phaseId, stage);
        list.append(stage);
      }
      const files = element('ul', { className: 'output-files' }, packageItem.files.map((file) => outputFileRow(conversation, packageItem, file, phaseOutputFileUrl)));
      const decision = packageItem.decision === 'accepted' ? '阶段已通过' : packageItem.decision === 'blocked' ? '阶段未通过' : '阶段待确认';
      stage.append(element('article', { className: 'output-snapshot phase-output-package' }, [
        element('div', { className: 'output-snapshot-heading' }, [element('strong', { text: fileLabel(packageItem, 'versionLabel', '已保存版本') }),
          element('span', { className: 'output-decision', text: decision })]),
        outputVersionDetails(dateLabel(packageItem.createdAt), [`成果编号：${packageItem.packageId}`]), files,
      ]));
    }
    document.querySelector('#phase-output-empty').hidden = value.items.length !== 0;
  } catch (error) {
    if (outputCurrent(conversation, generation)) setMessage(document.querySelector('#phase-output-error'),
      error.name === 'AbortError' ? '阶段成果读取超时，请重新加载。' : error.status === 404 ? '此对话的阶段成果暂不可用，或你无权查看。' : error.message);
  } finally {
    if (outputCurrent(conversation, generation)) { document.querySelector('#phase-output-loading').hidden = true; retry.disabled = false; }
  }
}

async function showConversationOutputs(conversation) {
  cancelOutputRequests();
  state.outputConversation = conversation;
  document.querySelector('#conversation-browser').hidden = true;
  document.querySelector('#conversation-output-panel').hidden = false;
  document.querySelector('#output-title').textContent = `${conversation.title} · 对话文件`;
  document.querySelector('#output-owner-note').textContent = conversation.owner
    ? `所属用户：${conversation.owner.displayName}（${conversation.owner.username}）`
    : '仅显示当前账号拥有的对话归档。';
  document.querySelector('#output-loading').hidden = false;
  document.querySelector('#output-empty').hidden = true;
  document.querySelector('#output-preview-panel').hidden = true;
  document.querySelector('#output-list').replaceChildren();
  document.querySelector('#phase-output-list').replaceChildren();
  state.outputOffset = 0;
  state.outputHasMore = false;
  setMessage(document.querySelector('#output-error'), '');
  document.querySelector('#output-title').focus();
  await Promise.all([loadPhaseOutputs(conversation), loadConversationOutputPage(conversation)]);
}

async function loadConversationOutputPage(conversation = state.outputConversation) {
  if (conversation === null || state.outputLoading) return;
  const generation = state.outputGeneration;
  state.outputLoading = true;
  document.querySelector('#output-more-button').disabled = true;
  try {
    const value = await outputRequest(`/forge-gateway/api/conversations/${encodeURIComponent(conversation.id)}/outputs?offset=${state.outputOffset}&limit=20`);
    if (!outputCurrent(conversation, generation)) return;
    state.outputOffset += value.items.length;
    state.outputHasMore = value.hasMore;
    document.querySelector('#output-empty').hidden = state.outputOffset !== 0;
    const list = document.querySelector('#output-list');
    for (const snapshot of value.items) {
      const files = element('ul', { className: 'output-files' }, snapshot.files.map((file) => outputFileRow(conversation, snapshot, file)));
      list.append(element('article', { className: 'output-snapshot' }, [
        element('div', { className: 'output-snapshot-heading' }, [
          element('strong', { text: '聊天记录与附件' }),
          element('span', { className: 'muted', text: `${outputStatusLabels[snapshot.status] ?? snapshot.status} · ${dateLabel(snapshot.createdAt)}` }),
        ]), outputVersionDetails(fileLabel(snapshot.files[0] || {}, 'versionLabel', `版本 ${String(snapshot.snapshotId).slice(0, 8)}`),
          [`会话编号：${snapshot.sessionId}`, `完整记录编号：${snapshot.snapshotId}`]), files,
      ]));
    }
  } catch (error) {
    if (outputCurrent(conversation, generation)) setMessage(document.querySelector('#output-error'), error.name === 'AbortError' ? '聊天归档读取超时，请返回列表后重试。' : error.message);
  } finally {
    if (outputCurrent(conversation, generation)) {
      state.outputLoading = false;
      document.querySelector('#output-loading').hidden = true;
      const more = document.querySelector('#output-more-button');
      more.hidden = !state.outputHasMore;
      more.disabled = false;
    }
  }
}

function closeConversationOutputs() {
  cancelOutputRequests();
  const wasVisible = !document.querySelector('#conversation-output-panel').hidden;
  state.outputConversation = null;
  state.outputLoading = false;
  document.querySelector('#conversation-output-panel').hidden = true;
  document.querySelector('#conversation-browser').hidden = false;
  if (wasVisible) document.querySelector('#conversations-title').focus();
}

const releaseStageLabels = {
  preflight: '发布预检', 'candidate-validation': '候选验证', 'candidate-preflight': '候选预检',
  'candidate-build': '构建候选', 'candidate-prepared': '候选已验证，尚未发布',
  'candidate-reused': '复用已验证候选', 'promote-candidate': '集成已验证候选',
  'controlled-release': '准备部署', 'test-database-plan': '检查测试数据库',
  'test-database-snapshot': '保存测试数据库快照', 'test-database-restore': '恢复测试数据库',
  'test-database-orphan-cleanup': '清理测试数据库临时资源', 'test-database-migration': '验证迁移与候选启动',
  'publish-configuration': '准备发布配置', 'application-deployment': '部署应用',
  'application-smoke': '检查服务健康', 'application-rollback': '恢复上一版本',
  'application-rollback-failed': '恢复上一版本失败', 'application-rollback-verified': '上一版本已恢复',
  complete: '发布完成', failed: '执行失败', 'runner-restart-recovery': '执行已中断',
  checkpoint: '保存草稿', integrate: '集成代码', unknown: '阶段暂不可确认',
};

function stopReleaseStatus() {
  state.releaseStatusGeneration += 1;
  clearTimeout(state.releaseStatusTimer);
  state.releaseStatusTimer = null;
  state.releaseStatusController?.abort();
  state.releaseStatusController = null;
}

function renderReleaseStatus(value) {
  const heading = document.querySelector('#release-status-heading');
  const details = document.querySelector('#release-status-details');
  const note = document.querySelector('#release-status-note');
  details.replaceChildren();
  if (!value || value.availability === 'unknown') {
    heading.textContent = '发布状态暂不可确认';
    note.textContent = '连接或执行状态尚未确认，不能据此判断发布完成或项目空闲。请稍后刷新。';
    return;
  }
  const operation = value.operation;
  const labels = { running: '正在发布', success: '最近一次发布成功', failed: '最近一次发布失败',
    interrupted: '最近一次发布中断', prepared: '候选已验证，尚未发布', unknown: '发布状态暂不可确认' };
  heading.textContent = !operation ? '当前没有发布任务'
    : operation.action === 'checkpoint' ? '正在保存草稿，尚未发布'
      : operation.action === 'integrate' ? '正在集成代码，尚未发布' : labels[operation.status] ?? labels.unknown;
  const add = (name, content) => {
    details.append(element('div', {}, [element('dt', { text: name }), element('dd', { text: content || '—' })]));
  };
  if (operation) {
    add('发起人', operation.owner ? `${operation.owner.displayName}（${operation.owner.username}）${operation.owner.isSelf ? ' · 我' : ''}` : '未记录');
    add('工作舱', operation.taskId);
    add('当前阶段', releaseStageLabels[operation.stage] ?? releaseStageLabels.unknown);
    if (operation.failedStage) add('失败阶段', releaseStageLabels[operation.failedStage] ?? releaseStageLabels.unknown);
    add('版本 / 提交', operation.version ?? operation.commit?.slice(0, 12));
    add('发布服务', operation.services.join('、'));
    add('开始时间', dateLabel(operation.startedAt));
    const end = Date.parse(operation.completedAt ?? value.observedAt);
    const elapsed = Math.max(0, Math.floor((end - Date.parse(operation.startedAt)) / 1000));
    add('已用时间', Number.isFinite(elapsed) ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒` : '—');
    add('阶段更新时间', dateLabel(operation.updatedAt));
  }
  add('最近查询', dateLabel(value.observedAt));
  note.textContent = value.availability === 'partial' ? '发布请求仍在处理，但详细阶段暂不可确认。请勿重复提交。'
    : operation?.errorSummary ?? (value.occupied
      ? operation?.owner?.isSelf ? '你的请求已受理。请等待当前操作完成，不要重复提交。'
        : '其他同事正在操作。你的发布没有自动排队；请等待其结束后，在原对话重新预检并提交。'
      : '当前没有发布占用。需要发布时，请在原对话预检；如集成版本变化，先处理必要的同步和验证。');
}

async function refreshReleaseStatus() {
  const slug = state.selectedProjectSlug;
  if (!slug || state.releaseStatusController || document.hidden) return;
  clearTimeout(state.releaseStatusTimer);
  const generation = state.releaseStatusGeneration;
  const controller = new AbortController();
  state.releaseStatusController = controller;
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const value = await api(`/forge-gateway/api/project-release-status?project=${encodeURIComponent(slug)}`, { signal: controller.signal, cache: 'no-store' });
    if (generation === state.releaseStatusGeneration) renderReleaseStatus(value);
  } catch {
    if (generation === state.releaseStatusGeneration) renderReleaseStatus(null);
  } finally {
    clearTimeout(timeout);
    if (state.releaseStatusController === controller) state.releaseStatusController = null;
    if (generation === state.releaseStatusGeneration && state.selectedProjectSlug === slug) {
      state.releaseStatusTimer = setTimeout(refreshReleaseStatus, 5000);
    }
  }
}

function selectedProject() {
  return state.projects.find((project) => project.slug === state.selectedProjectSlug);
}

function renderProjectChecklist(targetId, selectedSlugs = []) {
  const target = document.querySelector(targetId);
  target.replaceChildren();
  const selected = new Set(selectedSlugs);
  for (const project of state.projects) {
    const input = element('input', { type: 'checkbox' });
    input.value = project.slug;
    input.checked = selected.has(project.slug);
    const copy = element('span', {}, [
      element('strong', { text: project.displayName }),
      element('small', { text: project.slug }),
    ]);
    target.append(element('label', { className: 'project-check' }, [input, copy]));
  }
}

async function selectProject(slug, { updateHistory = true } = {}) {
  const project = state.projects.find((entry) => entry.slug === slug);
  if (!project || !project.canEnter) return;
  closeConversationOutputs();
  stopReleaseStatus();
  state.selectedProjectSlug = slug;
  document.querySelector('#release-status-heading').textContent = '正在读取发布状态…';
  document.querySelector('#release-status-details').replaceChildren();
  document.querySelector('#release-status-note').textContent = '';
  refreshReleaseStatus();
  if (updateHistory) {
    const url = new URL(window.location.href);
    url.searchParams.set('project', slug);
    url.searchParams.delete('returnTask');
    url.searchParams.delete('phaseFiles');
    window.history.pushState({ project: slug }, '', url);
  }
  document.querySelector('#project-section').hidden = true;
  document.querySelector('#conversation-section').hidden = false;
  document.querySelector('#material-section').hidden = true;
  document.body.classList.add('conversation-focus');
  document.querySelector('#selected-project-name').textContent = project.displayName;
  document.querySelector('#selected-project-slug').textContent = project.slug;
  document.querySelector('#material-project-name').textContent = project.displayName;
  const forgeLink = document.querySelector('#forge-admin-link');
  if (project.forgeUiUrl) forgeLink.href = project.forgeUiUrl;
  else forgeLink.removeAttribute('href');
  forgeLink.hidden = !project.forgeUiUrl;
  document.querySelector('#project-delivery-link').hidden = project.slug !== 'forge-base';
  document.querySelector('#project-access-note').textContent = project.managerReady
    ? '你在此项目中新建的每个对话都会获得独立代码副本和 Harness 状态；发布仍由该项目的共享门禁串行处理。'
    : '该项目的工作舱管理服务暂不可用；现有目录仍可查看，创建、恢复和停止操作暂时禁用。';
  document.querySelector('#new-conversation-button').disabled = !project.managerReady;
  renderProjects();
  await loadConversations();
  if (updateHistory) document.querySelector('#conversations-title').focus();
}

function showProjectDirectory({ updateHistory = true } = {}) {
  closeConversationOutputs();
  stopReleaseStatus();
  state.selectedProjectSlug = null;
  state.conversations = [];
  state.nextOffset = null;
  document.querySelector('#project-section').hidden = false;
  document.querySelector('#conversation-section').hidden = true;
  document.querySelector('#material-section').hidden = true;
  document.body.classList.remove('conversation-focus');
  if (updateHistory) {
    const url = new URL(window.location.href);
    url.searchParams.delete('project');
    url.searchParams.delete('returnTask');
    window.history.pushState({ project: null }, '', url);
  }
  renderProjects();
  document.querySelector('#projects-title').focus();
}

function renderProjects() {
  const target = document.querySelector('#project-list');
  target.replaceChildren();
  document.querySelector('#project-loading').hidden = true;
  document.querySelector('#project-empty').hidden = state.projects.length !== 0;
  document.querySelector('#project-count').textContent = String(state.projects.length);
  for (const project of state.projects) {
    const metadata = element('div', { className: 'project-card-meta' }, [
      element('span', { className: 'project-kind', text: projectKindLabels[project.projectKind] ?? project.projectKind }),
      element('span', { className: `status-badge ${project.managerReady ? 'active' : 'stopped'}`, text: project.managerReady ? '执行面就绪' : '执行面不可用' }),
      element('span', { className: 'project-kind', text: `我的对话 ${project.ownConversationCount}` }),
    ]);
    const heading = element('div', {}, [
      element('h3', { text: project.displayName }),
      element('p', { text: project.slug }),
      metadata,
    ]);
    const access = element('p', {
      className: 'access-note',
      text: project.canEnter
        ? '已授权：可以进入此项目，并创建自己的独立对话。'
        : '未授权：项目可见，但不能进入或创建对话。请联系平台管理员。',
    });
    const actions = element('div', { className: 'project-card-actions' });
    const enter = button(project.slug === state.selectedProjectSlug ? '当前项目' : '进入项目', 'primary-button', () => {
      selectProject(project.slug).catch((error) => toast(error.message));
    });
    enter.disabled = !project.canEnter || project.slug === state.selectedProjectSlug;
    actions.append(enter);
    if (project.forgeUiUrl) {
      const link = element('a', { className: 'secondary-button button-link', text: '打开 Forge Admin' });
      link.href = project.forgeUiUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      actions.append(link);
    }
    if (project.slug === 'forge-base') {
      const deliveryLink = element('a', { className: 'secondary-button button-link', text: '需求与交付中心' });
      deliveryLink.href = '/forge-gateway/delivery-center?project=forge-base';
      actions.append(deliveryLink);
    }
    target.append(element('article', {
      className: `project-card${project.slug === state.selectedProjectSlug ? ' selected' : ''}${project.canEnter ? '' : ' restricted'}`,
    }, [heading, access, actions]));
  }
}

async function loadProjects() {
  const value = await api('/forge-gateway/api/projects');
  state.projects = value.items;
  renderProjects();
}

function materialAttributionLabel(item) {
  if (item.attribution?.status === 'attributed') {
    return item.attribution.actorId ? `对话上传 · ${item.attribution.actorId}` : '已记录上传身份';
  }
  if (item.attribution?.status === 'legacy-unattributed') return '历史记录，无法归属';
  return '未走上传审计';
}

function materialReadableLabel(readable) {
  if (readable?.status === 'ready' && readable.archiveType) {
    return `原型索引 · ${readable.pageCount} 页 · ${readable.path}`;
  }
  if (readable?.status === 'ready') return `AI 可读副本 · ${readable.path}`;
  if (readable?.status === 'native') return 'AI 可直接读取原文件';
  if (readable?.status) return `AI 预处理：${readable.status}${readable.code ? ` · ${readable.code}` : ''}`;
  return '';
}

function renderMaterials() {
  const materialList = document.querySelector('#material-list');
  materialList.replaceChildren();
  document.querySelector('#material-loading').hidden = true;
  document.querySelector('#material-count').textContent = String(state.materials.length);
  document.querySelector('#material-empty').hidden = state.materials.length !== 0;
  document.querySelector('#material-table').hidden = state.materials.length === 0;
  for (const item of state.materials) {
    const fileCell = element('td', {}, [
      element('strong', { text: item.filename }),
      element('div', { className: 'muted material-path', text: item.path }),
      ...(item.readable ? [element('div', { className: 'muted material-path', text: materialReadableLabel(item.readable) })] : []),
    ]);
    const governance = item.governanceStatus === 'approved'
      ? `${item.approvedBy ?? '管理员'} · ${dateLabel(item.approvedAt)}`
      : '共享区手工文件，缺少治理记录';
    materialList.append(element('tr', {}, [
      fileCell,
      element('td', { text: materialCategoryLabels[item.category] ?? item.category }),
      element('td', { text: byteLabel(item.bytes) }),
      element('td', { text: governance }),
    ]));
  }

  const directMode = state.materialAccessMode === 'direct';
  document.querySelector('#material-mode-help').textContent = directMode
    ? '当前项目为 SFTP 目录直读模式：完整文件夹上传后，同项目 AI 可从只读 /project-ftp-inputs/<文件夹> 直接读取，无需管理员批准。需要理解 Axure/HTML 目录时，让 AI 先运行 forge-prototype-index 建立安全索引；可选审核区保留但不是前置步骤。'
    : '当前项目为审核共享模式：SFTP 原始目录不会直接暴露给 TaskSpace，管理员批准后的资料从只读 /project-shared-inputs 读取。';
  const isAdmin = state.session.user.role === 'admin';
  document.querySelector('#material-review-panel').hidden = !isAdmin || directMode;
  if (!isAdmin || directMode) return;
  const intakeList = document.querySelector('#material-intake-list');
  intakeList.replaceChildren();
  document.querySelector('#material-intake-count').textContent = String(state.materialIntake.length);
  document.querySelector('#material-intake-empty').hidden = state.materialIntake.length !== 0;
  document.querySelector('#material-intake-table').hidden = state.materialIntake.length === 0;
  for (const item of state.materialIntake) {
    const category = element('select');
    category.setAttribute('aria-label', `选择 ${item.filename} 的共享分类`);
    for (const option of state.materialCategories) {
      const node = element('option', { text: option.label });
      node.value = option.value;
      if (option.value === 'reference') node.selected = true;
      category.append(node);
    }
    const approve = button('批准共享', 'primary-button', () => confirmOperation(
      '批准项目共享资料',
      `批准“${item.filename}”后，同一项目的所有对话都能只读访问它。PDF/Office/前端原型会生成受限 AI 可读副本；原始文件仍保留在隔离区，不会移动或删除。`,
      async () => {
        const value = await api('/forge-gateway/api/materials/promote', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectSlug: state.selectedProjectSlug,
            sourcePath: item.path,
            expectedSha256: item.sha256,
            category: category.value,
          }),
        });
        await loadMaterials();
        const readable = value.material?.readable;
        if (readable?.status === 'ready' && readable.archiveType) {
          toast(`资料已批准，已识别 ${readable.pageCount} 个原型页面并生成 AI 索引。`);
        } else if (readable?.status === 'failed') {
          toast(`资料已批准，但 AI 预处理失败：${readable.code ?? '未知错误'}。`);
        } else {
          toast(value.idempotent ? '该资料已在项目共享区，无需重复复制。' : '资料已批准并复制到项目共享区。');
        }
      },
      false,
    ));
    intakeList.append(element('tr', {}, [
      element('td', {}, [
        element('strong', { text: item.filename }),
        element('div', { className: 'muted material-path', text: item.path }),
        element('div', { className: 'muted', text: byteLabel(item.bytes) }),
        ...(item.readableStatus ? [element('div', { className: 'muted', text: `上传侧预处理：${item.readableStatus}` })] : []),
      ]),
      element('td', { text: materialAttributionLabel(item) }),
      element('td', {}, [category]),
      element('td', {}, [approve]),
    ]));
  }
}

async function loadMaterials() {
  if (!state.selectedProjectSlug) return;
  document.querySelector('#material-loading').hidden = false;
  document.querySelector('#material-retry-button').hidden = true;
  setMessage(document.querySelector('#material-error'), '');
  try {
    const materials = [];
    const intake = [];
    let offset = 0;
    let value;
    do {
      value = await api(`/forge-gateway/api/materials?project=${encodeURIComponent(state.selectedProjectSlug)}&offset=${offset}&limit=500`);
      materials.push(...value.accepted.items);
      intake.push(...value.intake.items);
      offset = value.nextOffset;
    } while (offset !== null);
    state.materials = materials;
    state.materialIntake = intake;
    state.materialCategories = value.categories;
    state.materialAccessMode = value.accessMode ?? 'reviewed';
    renderMaterials();
  } catch (error) {
    state.materials = [];
    state.materialIntake = [];
    state.materialAccessMode = 'reviewed';
    document.querySelector('#material-loading').hidden = true;
    document.querySelector('#material-empty').hidden = true;
    document.querySelector('#material-table').hidden = true;
    document.querySelector('#material-review-panel').hidden = true;
    setMessage(document.querySelector('#material-error'), error.message);
    document.querySelector('#material-retry-button').hidden = false;
  }
}

async function openConversation(conversation) {
  if (isProvisioning(conversation)) {
    await refreshProvisioningConversations();
    return;
  }
  const workerWindow = window.open('about:blank', '_blank');
  if (workerWindow) workerWindow.opener = null;
  try {
    const value = await api(`/forge-gateway/api/conversations/${encodeURIComponent(conversation.id)}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    updateConversation(value.conversation);
    if (workerWindow) workerWindow.location.replace(value.url);
    else window.location.assign(value.url);
  } catch (error) {
    if (workerWindow) workerWindow.close();
    toast(error.message);
  }
}

function updateConversation(value) {
  const index = state.conversations.findIndex((entry) => entry.id === value.id);
  if (index === -1) {
    state.conversations.unshift(value);
    const project = state.projects.find((entry) => entry.slug === value.projectSlug);
    if (project) project.ownConversationCount += 1;
  }
  else state.conversations[index] = value;
  state.conversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  renderConversations();
  renderProjects();
}

function isProvisioning(conversation) {
  return conversation.status === 'provisioning'
    || (conversation.status === 'failed' && conversation.lastError === 'MANAGER_TIMEOUT');
}

function scheduleProvisioningRefresh() {
  clearTimeout(state.provisioningTimer);
  state.provisioningTimer = null;
  if (!state.provisioningLoading && state.conversations.some((entry) => isOwnConversation(entry)
    && entry.projectSlug === state.selectedProjectSlug && isProvisioning(entry))) {
    state.provisioningTimer = setTimeout(refreshProvisioningConversations, 5000);
  }
}

async function refreshProvisioningConversations() {
  if (state.provisioningLoading) return;
  state.provisioningLoading = true;
  clearTimeout(state.provisioningTimer);
  const projectSlug = state.selectedProjectSlug;
  try {
    for (const entry of state.conversations.filter((item) => isOwnConversation(item)
      && item.projectSlug === projectSlug && isProvisioning(item))) {
      if (state.selectedProjectSlug !== projectSlug) break;
      try {
        const value = await api(`/forge-gateway/api/conversations/${encodeURIComponent(entry.id)}/status`);
        if (state.selectedProjectSlug === projectSlug && state.conversations.some((item) => item.id === entry.id)) {
          updateConversation({ ...entry, ...value.conversation });
        }
      } catch { /* Keep the pending state until the Manager supplies a real result. */ }
    }
  } finally {
    state.provisioningLoading = false;
    scheduleProvisioningRefresh();
  }
}

function confirmOperation(title, message, action, dangerous = true) {
  document.querySelector('#confirm-title').textContent = title;
  document.querySelector('#confirm-message').textContent = message;
  setMessage(document.querySelector('#confirm-error'), '');
  const confirmButton = document.querySelector('#confirm-button');
  confirmButton.className = dangerous ? 'danger-button' : 'primary-button';
  state.confirmAction = action;
  openDialog('confirm-dialog');
}

async function confirmConversationRoles(conversation) {
  const endpoint = `/forge-gateway/api/conversations/${conversation.id}/role-decisions`;
  const post = body => api(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const preview = await post({ operation: 'preview' });
    if (preview.grants.length === 0) { toast('当前任务没有待确认的角色授权 SQL。'); return; }
    if (!preview.approvable) { toast('候选 SQL 中的角色无法明确识别，请先在原对话修正后重新预览。'); return; }
    const message = preview.grants.map(item => `文件：${item.path}，第 ${item.line} 行\n授予角色：${item.roleKeys.join('、')}\n${item.statement};`).join('\n\n');
    confirmOperation('确认角色授权', `请核对以下角色及授权 SQL。确认只对当前候选生效；如需改角色，请先回到原对话修改。\n\n${message}`,
      async () => {
        const result = await post({ operation: 'confirm', previewId: preview.previewId, previewDigest: preview.previewDigest });
        toast(result.message);
      });
  } catch (error) { toast(error.message); }
}

function renderConversations() {
  const list = document.querySelector('#conversation-list');
  list.replaceChildren();
  document.querySelector('#conversation-loading').hidden = true;
  document.querySelector('#conversation-empty').hidden = state.conversations.length !== 0;
  document.querySelector('#all-conversations-toggle').disabled = state.conversationLoading;
  for (const conversation of state.conversations) {
    const title = element('h3', { text: conversation.title });
    const isLegacySession = conversation.kind === 'legacy-session';
    const metadata = element('div', { className: 'conversation-meta' }, [
      statusBadge(isProvisioning(conversation) ? 'provisioning' : conversation.status),
      element('span', { text: `最近更新 ${dateLabel(conversation.updatedAt)}` }),
      element('span', { text: isLegacySession ? '迁移前历史对话' : `工作舱 ${conversation.taskId}` }),
    ]);
    if (conversation.owner) metadata.append(element('span', { text: `所属用户 ${conversation.owner.displayName}（${conversation.owner.username}）` }));
    if (isProvisioning(conversation)) metadata.append(element('span', { text: '正在确认创建结果，请勿重复新建。' }));
    else if (conversation.lastError) metadata.append(element('span', { text: `错误：${conversation.lastError}` }));
    const details = element('div', {}, [title, metadata]);
    const actions = element('div', { className: 'row-actions' });
    actions.append(button('查看文件', 'secondary-button', () => showConversationOutputs(conversation)));
    if (!isOwnConversation(conversation)) {
      list.append(element('article', { className: 'conversation-row' }, [details, actions]));
      continue;
    }
    if (conversation.status !== 'closed') {
      actions.append(button(
        isLegacySession
          ? (conversation.status === 'stopped' ? '恢复并打开历史对话' : '打开历史对话')
          : isProvisioning(conversation) ? '检查创建状态'
            : conversation.status === 'stopped' ? '恢复并打开' : conversation.status === 'failed' ? '重试创建' : '打开 Harness',
        'primary-button',
        () => openConversation(conversation),
      ));
    }
    if (!isLegacySession) {
      actions.append(button('重命名', 'secondary-button', () => {
        state.renameId = conversation.id;
        document.querySelector('#rename-title').value = conversation.title;
        setMessage(document.querySelector('#rename-error'), '');
        openDialog('rename-dialog');
        document.querySelector('#rename-title').focus();
      }));
    }
    if (conversation.status === 'active') {
      if (!isLegacySession && ['admin', 'member'].includes(state.session.user.role)) {
        actions.append(button('确认角色授权', 'secondary-button', () => confirmConversationRoles(conversation)));
      }
      actions.append(button('停止', 'secondary-button', () => confirmOperation(
        '停止对话工作舱',
        `停止“${conversation.title}”后，代码、上传文件和 Harness 对话状态都会保留，之后可以恢复。`,
        async () => {
          const value = await api(`/forge-gateway/api/conversations/${conversation.id}/stop`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          });
          for (const related of value.relatedConversations ?? [value.conversation]) updateConversation(related);
          toast('对话工作舱已停止，数据保持不变。');
        },
      )));
    }
    list.append(element('article', { className: 'conversation-row' }, [details, actions]));
  }
  const more = document.querySelector('#load-more-button');
  more.hidden = state.nextOffset === null;
  more.disabled = state.conversationLoading;
  more.textContent = state.conversationLoading ? '正在加载…' : '加载更多';
  scheduleProvisioningRefresh();
}

async function loadConversations({ append = false, findTask = undefined, findConversation = undefined } = {}) {
  if (!state.selectedProjectSlug || state.conversationLoading) return;
  state.conversationLoading = true;
  renderConversations();
  try {
    let offset = append ? state.nextOffset ?? 0 : 0;
    if (!append) state.conversations = [];
    do {
      const value = await api(`/forge-gateway/api/conversations?project=${encodeURIComponent(state.selectedProjectSlug)}&offset=${offset}${state.conversationScope === 'all' ? '&scope=all' : ''}`);
      const known = new Set(state.conversations.map((entry) => entry.id));
      state.conversations.push(...value.items.filter((entry) => !known.has(entry.id)));
      state.nextOffset = value.nextOffset;
      offset = value.nextOffset;
      if (findConversation !== undefined) {
        if (state.conversations.some((entry) => entry.id === findConversation)) break;
      } else if (findTask === undefined || state.conversations.some((entry) => entry.taskId === findTask)) break;
    } while (offset !== null);
    if (findTask !== undefined) {
      const target = state.conversations.find((entry) => entry.taskId === findTask);
      window.history.replaceState({ project: state.selectedProjectSlug }, '', `/forge-gateway/?project=${encodeURIComponent(state.selectedProjectSlug)}`);
      if (target) await openConversation(target);
      else toast('当前账号无权打开请求的对话，或该对话已不存在。');
    }
  } finally {
    state.conversationLoading = false;
    renderConversations();
  }
}

async function openRequestedPhaseFiles(conversationId) {
  if (!state.conversations.some((entry) => entry.id === conversationId) && state.nextOffset !== null) {
    await loadConversations({ append: true, findConversation: conversationId });
  }
  const target = state.conversations.find((entry) => entry.id === conversationId);
  if (!target) {
    setMessage(document.querySelector('#system-warning'), '当前账号没有可查看的对应对话，或该对话已不存在。');
    return;
  }
  await showConversationOutputs(target);
}

function showCredential(username, password) {
  document.querySelector('#credential-value').textContent = `用户名：${username}\n临时密码：${password}`;
  state.usersRefreshPending = true;
  openDialog('credential-dialog');
}

function openMembershipDialog(user) {
  state.membershipUser = user;
  document.querySelector('#membership-user-label').textContent = user.role === 'admin'
    ? `${user.displayName} 是平台管理员，默认可以进入全部项目。`
    : `为 ${user.displayName} 选择允许进入并创建独立对话的项目。`;
  renderProjectChecklist('#membership-projects', user.projectSlugs);
  for (const input of document.querySelectorAll('#membership-projects input')) input.disabled = user.role === 'admin';
  document.querySelector('#membership-submit').disabled = user.role === 'admin';
  setMessage(document.querySelector('#membership-error'), '');
  openDialog('membership-dialog');
}

function renderUsers(users) {
  const target = document.querySelector('#user-list');
  target.replaceChildren();
  for (const user of users) {
    const isCurrentUser = user.id === state.session.user.id;
    const usernameLabel = isCurrentUser ? `${user.username} · 当前账号` : user.username;
    const name = element('td', {}, [element('strong', { text: user.displayName }), element('div', { className: 'muted', text: usernameLabel })]);
    const role = element('td', { text: roleLabels[user.role] ?? user.role });
    const projectNames = user.role === 'admin'
      ? '全部项目（平台管理员）'
      : user.projectSlugs.map((slug) => state.projects.find((project) => project.slug === slug)?.displayName ?? slug).join('、') || '未授权项目';
    const projects = element('td', { text: projectNames });
    const status = element('td', {}, [statusBadge(user.status)]);
    const actions = element('td');
    if (user.role !== 'admin') actions.append(button('项目权限', 'secondary-button', () => openMembershipDialog(user)));
    if (isCurrentUser) {
      actions.append(button('修改自己的密码', 'secondary-button', () => {
        window.location.assign('/forge-gateway/change-password');
      }));
    } else {
      actions.append(button('重置密码', 'secondary-button', () => confirmOperation(
        '重置人员密码',
        `重置 ${user.displayName} 的密码会立即撤销该账号全部会话，并生成一次性临时密码。`,
        async () => {
          const value = await api(`/forge-gateway/api/admin/users/${user.id}/reset-password`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
          });
          showCredential(value.user.username, value.temporaryPassword);
        },
      )));
    }
    const nextStatus = user.status === 'active' ? 'disabled' : 'active';
    actions.append(button(user.status === 'active' ? '停用' : '启用', user.status === 'active' ? 'danger-button' : 'secondary-button', () => confirmOperation(
      user.status === 'active' ? '停用人员账号' : '启用人员账号',
      user.status === 'active'
        ? `停用 ${user.displayName} 会立即撤销全部会话并阻断其所有对话工作舱。数据不会删除。`
        : `启用 ${user.displayName} 后，该人员可以继续访问自己原有的对话。`,
      async () => {
        await api(`/forge-gateway/api/admin/users/${user.id}/status`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: nextStatus }),
        });
        await loadUsers();
        toast(user.status === 'active' ? '账号已停用，已有会话立即失效。' : '账号已启用。');
      },
    )));
    target.append(element('tr', {}, [name, role, projects, status, actions]));
  }
}

async function loadUsers() {
  const value = await api('/forge-gateway/api/admin/users');
  renderUsers(value.users);
}

async function loadAudit() {
  const value = await api('/forge-gateway/api/audit?limit=100');
  const target = document.querySelector('#audit-list');
  target.replaceChildren();
  for (const event of value.events) {
    target.append(element('tr', {}, [
      element('td', { text: dateLabel(event.at) }),
      element('td', { text: event.actor ?? '—' }),
      element('td', { text: event.action ?? '—' }),
      element('td', { text: event.targetId ?? '—' }),
      element('td', { text: event.result === 'success' ? '成功' : event.result === 'denied' ? '拒绝' : '失败' }),
    ]));
  }
}

for (const closeButton of document.querySelectorAll('[data-close-dialog]')) {
  closeButton.addEventListener('click', () => closeDialog(closeButton.dataset.closeDialog));
}

document.querySelector('#new-conversation-button').addEventListener('click', () => {
  document.querySelector('#conversation-form').reset();
  setMessage(document.querySelector('#conversation-error'), '');
  openDialog('conversation-dialog');
  document.querySelector('#conversation-title').focus();
});

document.querySelector('#conversation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = document.querySelector('#conversation-title').value.trim();
  const errorBox = document.querySelector('#conversation-error');
  if (!title) { setMessage(errorBox, '请输入对话名称。'); return; }
  const submit = document.querySelector('#conversation-submit');
  submit.disabled = true;
  submit.textContent = '正在创建独立工作舱…';
  try {
    const value = await api('/forge-gateway/api/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomIdempotencyKey() },
      body: JSON.stringify({ title, projectSlug: state.selectedProjectSlug }),
    });
    updateConversation(value.conversation);
    closeDialog('conversation-dialog');
    toast(isProvisioning(value.conversation) ? '工作舱仍在创建，列表会自动更新，请勿重复新建。' : '独立对话工作舱已创建。');
  } catch (error) {
    setMessage(errorBox, error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = '创建工作舱';
  }
});

document.querySelector('#rename-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = document.querySelector('#rename-title').value.trim();
  const errorBox = document.querySelector('#rename-error');
  if (!title) { setMessage(errorBox, '请输入新名称。'); return; }
  try {
    const value = await api(`/forge-gateway/api/conversations/${state.renameId}/rename`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }),
    });
    updateConversation(value.conversation);
    closeDialog('rename-dialog');
    toast('对话名称已更新。');
  } catch (error) {
    setMessage(errorBox, error.message);
  }
});

document.querySelector('#confirm-button').addEventListener('click', async () => {
  const confirmButton = document.querySelector('#confirm-button');
  const errorBox = document.querySelector('#confirm-error');
  confirmButton.disabled = true;
  try {
    await state.confirmAction?.();
    closeDialog('confirm-dialog');
  } catch (error) {
    setMessage(errorBox, error.message);
  } finally {
    confirmButton.disabled = false;
  }
});

document.querySelector('#new-user-button').addEventListener('click', () => {
  document.querySelector('#user-form').reset();
  renderProjectChecklist('#new-user-projects');
  setMessage(document.querySelector('#user-error'), '');
  openDialog('user-dialog');
  document.querySelector('#new-username').focus();
});

document.querySelector('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = document.querySelector('#new-username').value.trim();
  const displayName = document.querySelector('#new-display-name').value.trim();
  const role = document.querySelector('#new-role').value;
  const projectSlugs = [...document.querySelectorAll('#new-user-projects input:checked')].map((input) => input.value);
  const errorBox = document.querySelector('#user-error');
  if (!username || !displayName) { setMessage(errorBox, '请填写用户名和显示名称。'); return; }
  try {
    const value = await api('/forge-gateway/api/admin/users', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, displayName, role, projectSlugs }),
    });
    closeDialog('user-dialog');
    showCredential(value.user.username, value.temporaryPassword);
  } catch (error) {
    setMessage(errorBox, error.message);
  }
});

document.querySelector('#membership-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.membershipUser || state.membershipUser.role === 'admin') return;
  const projectSlugs = [...document.querySelectorAll('#membership-projects input:checked')].map((input) => input.value);
  const submit = document.querySelector('#membership-submit');
  const errorBox = document.querySelector('#membership-error');
  submit.disabled = true;
  submit.textContent = '正在保存…';
  try {
    await api(`/forge-gateway/api/admin/users/${state.membershipUser.id}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectSlugs }),
    });
    closeDialog('membership-dialog');
    await loadUsers();
    toast('项目权限已更新；被撤销的工作舱访问会立即阻断。');
  } catch (error) {
    setMessage(errorBox, error.message);
  } finally {
    submit.disabled = false;
    submit.textContent = '保存项目权限';
  }
});

document.querySelector('#copy-credential-button').addEventListener('click', async () => {
  const value = document.querySelector('#credential-value').textContent;
  if (!navigator.clipboard) { toast('当前浏览器不允许自动复制，请手动选择密码。'); return; }
  try { await navigator.clipboard.writeText(value); toast('临时凭据已复制。'); }
  catch { toast('复制失败，请手动选择密码。'); }
});

document.querySelector('#credential-dialog').addEventListener('close', () => {
  if (!state.usersRefreshPending) return;
  state.usersRefreshPending = false;
  loadUsers().catch((error) => toast(`人员列表刷新失败：${error.message}`));
});

document.querySelector('#load-more-button').addEventListener('click', () => loadConversations({ append: true }).catch((error) => toast(error.message)));
document.querySelector('#switch-project-button').addEventListener('click', () => showProjectDirectory());
document.querySelector('#close-output-button').addEventListener('click', closeConversationOutputs);
document.querySelector('#output-more-button').addEventListener('click', () => loadConversationOutputPage().catch((error) => toast(error.message)));
document.querySelector('#phase-output-retry').addEventListener('click', () => loadPhaseOutputs());
document.querySelector('#all-conversations-toggle').addEventListener('change', (event) => {
  state.conversationScope = event.currentTarget.checked ? 'all' : 'own';
  state.nextOffset = null;
  closeConversationOutputs();
  loadConversations().catch((error) => toast(error.message));
});
document.querySelector('#material-retry-button').addEventListener('click', () => loadMaterials());

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    const value = await api('/forge-gateway/api/logout', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    window.location.assign(value.redirect);
  } catch (error) { toast(error.message); }
});

// Literal action buttons remain disabled when JavaScript fails to load. Enable
// them only after every handler above has been attached.
for (const actionButton of document.querySelectorAll('button[type="button"][disabled]')) {
  actionButton.disabled = false;
}

async function initialize() {
  state.session = await api('/forge-gateway/api/session');
  const user = state.session.user;
  document.querySelector('#display-name').textContent = user.displayName;
  document.querySelector('#username').textContent = user.username;
  document.querySelector('#role-badge').textContent = roleLabels[user.role] ?? user.role;
  document.querySelector('#all-conversations-control').hidden = user.role !== 'admin';
  await loadProjects();
  const canUseConversations = user.role === 'admin' || user.role === 'member';
  if (canUseConversations) {
    const parameters = new URLSearchParams(window.location.search);
    const requestedProject = parameters.get('project');
    const returnTask = parameters.get('returnTask');
    const phaseFiles = parameters.get('phaseFiles');
    const project = state.projects.find((entry) => entry.slug === requestedProject && entry.canEnter);
    if (project) {
      if (phaseFiles && user.role === 'admin') {
        state.conversationScope = 'all';
        document.querySelector('#all-conversations-toggle').checked = true;
      }
      await selectProject(project.slug, { updateHistory: false });
      if (phaseFiles) {
        await openRequestedPhaseFiles(phaseFiles);
      } else if (returnTask && /^[a-z0-9][a-z0-9-]{1,47}$/.test(returnTask)) {
        const target = state.conversations.find((entry) => entry.taskId === returnTask);
        window.history.replaceState({ project: project.slug }, '', `/forge-gateway/?project=${encodeURIComponent(project.slug)}`);
        if (target) await openConversation(target);
        else toast('当前账号无权打开请求的对话，或该对话已不存在。');
      }
    } else if (phaseFiles) {
      setMessage(document.querySelector('#system-warning'), '当前账号无权进入对应项目，无法查看请求的阶段成果。');
    }
  }
  if (user.role === 'admin') {
    document.querySelector('#user-admin-section').hidden = false;
    await loadUsers();
  }
  if (user.role === 'admin' || user.role === 'auditor') {
    document.querySelector('#audit-section').hidden = false;
    await loadAudit();
  }
}

document.querySelector('#release-refresh-button').addEventListener('click', refreshReleaseStatus);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopReleaseStatus(); renderReleaseStatus(null); }
  else refreshReleaseStatus();
});
window.addEventListener('offline', () => { stopReleaseStatus(); renderReleaseStatus(null); });
window.addEventListener('online', refreshReleaseStatus);

window.addEventListener('popstate', () => {
  const slug = new URLSearchParams(window.location.search).get('project');
  if (!slug) {
    showProjectDirectory({ updateHistory: false });
    return;
  }
  selectProject(slug, { updateHistory: false }).catch((error) => toast(error.message));
});

initialize().catch((error) => {
  setMessage(document.querySelector('#system-warning'), error.message ?? '隔离台加载失败，请刷新页面。');
});
