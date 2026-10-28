export function createProductionDelivery(root, { session = null, embedded = false, onExportCreated = async () => {}, onArtifacts = project => window.location.assign(`/forge-gateway/delivery-center?${new URLSearchParams({ project, tab: 'artifacts' })}`) } = {}) {
const API = '/forge-gateway/api/production';
const $ = id => root.querySelector(`#${id}`);
const state = { project: '', session, projects: [], releases: [], targets: [], detail: null, detailRequest: 0, targetId: '', view: 'packages', epoch: 0, timer: null, polling: false, drafts: new Map(), keys: new WeakMap(), receiptSource: 'manual', active: !embedded, focusJobId: '', exportSource: null, exportRequest: 0, capacity: null };
state.handovers = new Map(); state.handoverErrors = new Map(); state.secretEpoch = 0; state.secretCleanups = new Set();
const labels = { queued: '等待生成', preparing: '生成材料', restoring: '恢复历史系统', upgrading: '执行真实升级', verifying: '自动验证中', 'awaiting-acceptance': '等待人工验收', ready: '可交付下载', rejected: '人工验收未通过', failed: '执行失败', interrupted: '执行中断', success: '成功', passed: '通过', accepted: '已确认通过', partial: '部分完成', running: '运行中', available: '可访问', stopped: '已停止', pending: '待处理', 'not-required': '本次无需执行', 'not-run': '尚未执行', initial: '全量包', upgrade: '增量包' };
const activeStatuses = new Set(['queued', 'preparing', 'restoring', 'upgrading', 'verifying']);
const evidenceLabels = { 'freeze-fixed-materials': '固定本次交付材料', 'archive-exact-images': '归档固定版本镜像', 'restore-and-start-historical-package': '恢复并启动历史系统', 'historical-application-healthy': '历史系统启动检查通过', 'empty-environment-installation': '执行空环境首次安装', 'target-package-healthy': '目标版本运行检查通过', 'awaiting-human-acceptance': '等待人工访问验收', failed: '本次执行失败', 'frozen-material-digests': '交付材料校验一致', 'fixed-image-architecture': '镜像版本及目标架构核对', 'historical-start-and-real-upgrade': '历史系统启动及真实增量升级', 'empty-database-initial-installation': '空数据库初始化及首次运行', 'target-http-health': '目标版本访问检查', 'recoverable-database-redis-files-baseline': '数据库、缓存与文件恢复基线已保存', 'Business acceptance requires a human decision.': '业务功能仍需人员访问验证并确认。', 'External production database credentials, network and permissions are not exercised by isolated validation.': '独立环境验证不包含生产现场的数据库账号、网络和权限条件。' };
const files = [['bundle', '完整发布包'], ['sql', '数据库脚本'], ['deployment-guide', '部署升级手册'], ['operation-guide', '操作手册'], ['manifest', '材料清单'], ['verification', '验证报告']];
const text = value => value == null || value === '' ? '未记录' : String(value);
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录';
const arch = value => ({ amd64: 'x86_64 / AMD64', arm64: 'ARM64' })[value] || text(value);
function node(tag, value, className) { const element = document.createElement(tag); if (value !== undefined) element.textContent = value; if (className) element.className = className; return element; }
function button(title, handler, className = 'secondary-button') { const element = node('button', title, className); element.type = 'button'; element.addEventListener('click', handler); return element; }
function badge(status) { const element = node('span', labels[status] || text(status), 'production-badge'); element.dataset.status = status || 'unknown'; return element; }
function notice(message, error = false, id = 'production-message') { const element = $(id); element.textContent = message; element.className = error ? 'form-message error' : 'form-message'; }
function safeEnvironmentUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } }
function ready(job) { return job.status === 'ready' && job.acceptance?.decision === 'accepted' && /^[a-f0-9]{64}$/i.test(job.manifestSha256 || ''); }
function jobsOf(release) { return Array.isArray(release.jobs) ? release.jobs.filter(job => job && typeof job === 'object') : []; }
function allReadyJobs() { return state.releases.flatMap(release => jobsOf(release).filter(ready).map(job => ({ release, job }))); }
function packageName(release, job) { const title = release.title || release.version || release.id; return `${date(job.createdAt)} · ${title.length > 48 ? title.slice(0, 48) + '…' : title} · ${text(job.delivery?.recipient)} · ${arch(job.architecture)} · ${job.id.slice(-8)}`; }
function randomIdempotencyKey() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function idempotency(form, body) { const signature = JSON.stringify({ project: state.project, ...body }); const saved = state.keys.get(form); if (saved?.signature === signature) return saved.key; const key = randomIdempotencyKey(); state.keys.set(form, { signature, key }); return key; }
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const epoch = state.epoch; const url = new URL(raw ? path : `${API}${path}`, window.location.origin);
  if (!raw && method === 'GET') url.searchParams.set('project', state.project);
  const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'content-type': 'application/json', 'x-forge-csrf-token': state.session?.csrfToken || '' } : {}, ...(body ? { body: JSON.stringify({ ...body, project: state.project }) } : {}) });
  const value = await response.json().catch(() => ({}));
  if (epoch !== state.epoch) { const error = new Error('项目已切换，忽略原项目响应。'); error.name = 'AbortError'; throw error; }
  if (!response.ok) { if (response.status === 401) window.location.assign('/forge-gateway/login'); throw new Error(value.message || `操作未完成（${response.status}）`); }
  return value;
}
async function submit(form, operation, messageId = 'production-message') {
  if (form.dataset.busy === 'true') return;
  const epoch = state.epoch; form.dataset.busy = 'true'; const controls = Array.from(form.querySelectorAll('button[type="submit"]')); controls.forEach(control => { control.disabled = true; });
  try { notice('正在处理…', false, messageId); await operation(); }
  catch (error) { if (epoch === state.epoch && error.name !== 'AbortError') notice(error.message, true, messageId); }
  finally { if (epoch === state.epoch) { form.dataset.busy = 'false'; controls.forEach(control => { control.disabled = false; }); } }
}
function table(headings, rows) {
  const wrapper = node('div', undefined, 'production-table-wrap'); wrapper.tabIndex = 0;
  const element = node('table', undefined, 'production-table'); const head = node('thead'); const row = node('tr');
  headings.forEach(title => { const cell = node('th', title); cell.scope = 'col'; row.append(cell); }); head.append(row);
  const body = node('tbody'); rows.forEach(cells => { const tr = node('tr'); cells.forEach(value => { const td = node('td'); td.append(value instanceof Node ? value : node('span', text(value))); tr.append(td); }); body.append(tr); });
  element.append(head, body); wrapper.append(element); return wrapper;
}
function actorName(actor) { return actor && typeof actor === 'object' ? actor.displayName || actor.username || actor.id || '未记录' : text(actor); }
function exportRows() { return state.releases.flatMap(release => jobsOf(release).map(job => ({ release, job }))); }
function renderReleases() {
  const filter = $('production-search').value.trim().toLocaleLowerCase();
  const mode = $('production-filter-mode').value; const from = $('production-filter-from').value; const to = $('production-filter-to').value;
  const rows = exportRows().filter(({ release, job }) => {
    const createdDate = job.createdAt ? localDateValue(job.createdAt).slice(0, 10) : '';
    return (!mode || job.mode === mode) && (!(from || to) || createdDate && (!from || createdDate >= from) && (!to || createdDate <= to)) && [release.title, release.version, release.commit, job.id, actorName(job.createdBy), job.createdBy?.username, job.delivery?.recipient, job.delivery?.projectName, job.delivery?.purpose].some(value => String(value || '').toLocaleLowerCase().includes(filter));
  }).sort((a, b) => String(b.job.createdAt || '').localeCompare(String(a.job.createdAt || '')));
  const list = $('production-release-list');
  if (!rows.length) { list.replaceChildren(node('p', filter || mode || from || to ? '没有匹配的生产包，请调整筛选条件。' : '还没有生产包导出记录。请在“发布包与制品”的镜像行点击“导出生产包”。', 'production-empty')); return; }
  const content = table(['生产包', '导出人 / 时间', '交付对象 / 项目', '验证状态 / 环境', '操作'], rows.map(({ release, job }) => {
    const source = node('div'); const title = node('strong', release.title || release.version || '生产发布包', 'production-package-title'); title.title = title.textContent;
    source.append(title, node('small', labels[job.mode] || text(job.mode)));
    const actor = node('div', actorName(job.createdBy)); actor.append(node('small', date(job.createdAt), 'production-export-date'));
    const delivery = node('div', text(job.delivery?.recipient)); delivery.append(node('small', `项目：${text(job.delivery?.projectName)}`));
    const env = node('div'); env.append(badge(job.status), node('small', `环境：${labels[job.environment?.status] || '尚未建立'}`)); const url = safeEnvironmentUrl(job.environment?.url);
    if (url && !['stopped', 'removed', 'failed'].includes(job.environment?.status)) { const link = node('a', '访问验证环境', 'text-button'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; env.append(link); }
    return [source, actor, delivery, env, button('详情与交付', () => openRelease(release.id, job.id))];
  })); content.className += ' production-package-table'; list.replaceChildren(content);
}
function baselineChoices() { return allReadyJobs().filter(({ job }) => job.mode === 'initial' && job.architecture === $('production-architecture').value && job.baselineAvailable === true); }
function renderBaseOptions() {
  const selected = $('production-base').value; const choices = baselineChoices();
  const select = $('production-base'); select.replaceChildren(new Option('请选择历史全量包', ''));
  choices.forEach(({ release, job }) => select.add(new Option(packageName(release, job), job.id)));
  if (choices.some(({ job }) => job.id === selected)) select.value = selected;
  $('production-upgrade-option').disabled = !choices.length;
  if (!choices.length) $('production-mode').value = 'initial';
  const initialJobs = exportRows().filter(({ job }) => job.mode === 'initial');
  const conditions = [];
  if (initialJobs.some(({ job }) => !ready(job))) conditions.push('须完成验证并人工验收通过');
  if (initialJobs.some(({ job }) => job.architecture !== $('production-architecture').value)) conditions.push('须与所选架构一致');
  if (initialJobs.some(({ job }) => job.baselineAvailable !== true)) conditions.push('须保留完整的历史恢复材料');
  $('production-base-help').textContent = choices.length ? `有 ${choices.length} 份可选历史全量包，增量升级需手动指定基线。` : initialJobs.length ? `已有全量包尚未满足增量起点条件：${conditions.join('；')}。` : '尚未导出过全量包，请先导出全量包。';
  $('production-base-field').hidden = $('production-mode').value !== 'upgrade'; select.required = ! $('production-base-field').hidden;
  updateExportAvailability();
}
function updateExportAvailability() {
  $('production-export-submit').disabled = !state.exportSource || !state.exportSource.candidate.available || !state.capacity || state.capacity.available < 1 || !state.exportSource.candidate.architectures?.includes($('production-architecture').value) || ($('production-mode').value === 'upgrade' && !baselineChoices().length) || $('production-create-form').dataset.busy === 'true';
}
function renderCapacity() {
  const container = $('production-capacity'); container.replaceChildren();
  if (!state.capacity) { container.append(node('span', '验证环境容量尚未读取，请重新打开导出窗口。')); return; }
  if (state.capacity.available > 0) { container.append(node('span', '有可用验证环境名额。提交后将为本次生产包创建独立环境。')); return; }
  container.append(node('span', '当前验证环境名额已占用，暂不能新建。请由人员明确停止不再使用的验证环境；未验收的任务停止后不能再提交验收。系统不会自动停用或覆盖。'));
  for (const item of state.capacity.items || []) container.append(button('查看占用记录', async () => { $('production-create-dialog').close(); await onExportCreated(); setActive(true); await openRelease(item.releaseId, item.jobId); }));
}
function jobMeta(job) {
  const element = node('div', undefined, 'production-meta');
  for (const [key, value] of [['导出人', actorName(job.createdBy)], ['生成时间', date(job.createdAt)], ['交付给谁', text(job.delivery?.recipient)], ['用于哪个项目', text(job.delivery?.projectName)], ['环境与用途', text(job.delivery?.purpose)], ['验证方式', labels[job.mode] || job.mode], ['服务器架构', arch(job.architecture)], ['历史基线', job.baseJobId || '全新环境'], ['验证环境', labels[job.environment?.status] || '尚未建立'], ['记录编号', job.id]]) element.append(node('p', `${key}：${value}`));
  return element;
}
function clearHandoverSecrets() { state.secretEpoch += 1; for (const clear of state.secretCleanups) clear(); }
function boundHandover(job) {
  const item = state.handovers.get(job.id);
  return item?.project === state.project && item.jobId === job.id && item.manifestSha256 === job.manifestSha256 ? item : null;
}
async function loadHandovers() {
  const requestId = state.detailRequest; const detail = state.detail; const epoch = state.epoch;
  state.handovers.clear(); state.handoverErrors.clear();
  await Promise.all((detail?.jobs || []).filter(job => job.manifestSha256 && (!state.focusJobId || state.focusJobId === job.id)).map(async job => {
    try {
      const result = await api(`/jobs/${encodeURIComponent(job.id)}/handover`);
      if (epoch !== state.epoch || requestId !== state.detailRequest || detail !== state.detail) return;
      const item = result.item;
      if (item?.project !== state.project || item.jobId !== job.id || item.manifestSha256 !== job.manifestSha256) throw new Error('交接清单与当前生产包不一致，请刷新后重试。');
      state.handovers.set(job.id, item);
    } catch (error) { if (epoch === state.epoch && requestId === state.detailRequest && detail === state.detail) state.handoverErrors.set(job.id, error.message); }
  }));
}
function handoverBinding(job, item) { return { expectedManifestSha256: job.manifestSha256, expectedRevision: item.revision }; }
function renderHandoverPassword(container, job, item, account) {
  const field = node('input'); field.type = 'password'; field.readOnly = true; field.autocomplete = 'off'; field.placeholder = '密码未读取'; field.setAttribute('aria-label', `${account.username} 的验收密码`);
  let timer = null; let pending = false;
  const clear = () => { clearTimeout(timer); field.value = ''; field.type = 'password'; control.textContent = '查看验收密码'; control.setAttribute('aria-pressed', 'false'); };
  const message = node('p', '', 'field-help'); message.setAttribute('role', 'status');
  const control = button('查看验收密码', async () => {
    if (pending) return;
    if (field.value) { clear(); return; }
    const secretEpoch = state.secretEpoch; pending = true; control.disabled = true; message.textContent = '正在受控读取密码…';
    try {
      const result = await api(`/jobs/${encodeURIComponent(job.id)}/handover/credentials`, { method: 'POST', body: { ...handoverBinding(job, item), accountId: account.id } });
      if (secretEpoch !== state.secretEpoch || boundHandover(job) !== item || !state.active) return;
      if (result.item?.accountId !== account.id || result.item.revision !== item.revision || typeof result.item.password !== 'string') throw new Error('凭据版本已变化，请刷新清单后重新查看。');
      field.value = result.item.password; result.item.password = ''; field.type = 'text'; control.textContent = '隐藏验收密码'; control.setAttribute('aria-pressed', 'true'); message.textContent = '密码将在 30 秒后清空，离开或刷新也会立即清空。';
      timer = setTimeout(clear, 30000);
    } catch (error) { if (secretEpoch === state.secretEpoch) { clear(); message.textContent = '密码未能读取，请刷新清单后重试。'; } }
    finally { pending = false; control.disabled = false; }
  });
  control.setAttribute('aria-pressed', 'false'); state.secretCleanups.add(clear);
  const row = node('div', undefined, 'production-secret'); row.append(field, control); container.append(row, message);
}
function handoverField(container, label, value = '', type = 'text') {
  const wrapper = node('label', undefined, 'production-field'); const input = node(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type; else input.rows = 3;
  input.value = value; input.maxLength = 4000; wrapper.append(node('span', label), input); container.append(wrapper); return input;
}
function editHandover(host, job, item, close) {
  const form = node('form', undefined, 'production-form production-handover-editor'); form.noValidate = true;
  form.append(node('p', '这里只记录现有验收账号，不会创建账号或修改业务密码。未修改的已保存密码可留空。刷新或关闭会清空新输入的密码。', 'production-wide field-help'));
  const accountsHost = node('div', undefined, 'production-wide production-handover-rows'); const accounts = [];
  const addAccount = (account = {}) => {
    const row = node('fieldset', undefined, 'production-handover-row'); row.append(node('legend', '验收账号'));
    const inputs = {}; for (const [key, label] of [['username', '账号'], ['role', '角色'], ['tenant', '租户'], ['organization', '组织'], ['loginNotes', '登录说明']]) inputs[key] = handoverField(row, label, account[key] || '');
    const modeLabel = node('label', undefined, 'production-field'); const mode = node('select'); mode.add(new Option('记录验收密码', 'password')); mode.add(new Option('从外部领取凭据', 'external')); mode.value = account.credentialMode || 'password'; modeLabel.append(node('span', '凭据方式'), mode); row.append(modeLabel);
    const password = handoverField(row, account.hasPassword ? '更新密码（留空保留）' : '验收密码', '', 'password'); password.autocomplete = 'new-password';
    const instructions = handoverField(row, '外部凭据领取说明', account.credentialInstructions || '', 'textarea');
    const updateMode = () => { password.disabled = mode.value !== 'password'; instructions.disabled = mode.value !== 'external'; if (password.disabled) password.value = ''; };
    mode.addEventListener('change', updateMode); updateMode(); state.secretCleanups.add(() => { password.value = ''; });
    const record = { row, account, inputs, mode, password, instructions, removed: false }; accounts.push(record);
    row.append(button('移除此账号', () => { record.removed = true; password.value = ''; row.hidden = true; })); accountsHost.append(row);
  };
  (item.accounts || []).forEach(addAccount); if (!accounts.length) addAccount();
  form.append(accountsHost, button('添加验收账号', () => addAccount()));
  const prerequisites = handoverField(form, '验收前提（每行一项）', (item.prerequisites || []).join('\n'), 'textarea');
  const checksHost = node('div', undefined, 'production-wide production-handover-rows'); const checks = [];
  const addCheck = (check = {}) => { const row = node('fieldset', undefined, 'production-handover-row'); row.append(node('legend', '验收步骤')); const action = handoverField(row, '操作步骤', check.action || '', 'textarea'); const expected = handoverField(row, '预期结果', check.expected || '', 'textarea'); const record = { action, expected, removed: false }; checks.push(record); row.append(button('移除此步骤', () => { record.removed = true; row.hidden = true; })); checksHost.append(row); };
  (item.checks || []).forEach(addCheck); if (!checks.length) addCheck(); form.append(checksHost, button('添加验收步骤', () => addCheck()));
  const limitations = handoverField(form, '限制与未覆盖项（每行一项，无则填写“无已知限制”）', (item.limitations || []).join('\n'), 'textarea');
  const message = node('p', '', 'form-message production-wide'); message.id = `handover-message-${job.id}`; message.setAttribute('role', 'status');
  const save = node('button', '保存验收交接清单', 'primary-button'); save.type = 'submit'; const cancel = button('取消编辑', () => { clearHandoverSecrets(); close(); });
  form.append(save, cancel, message);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (form.dataset.busy === 'true') return;
    const lines = input => input.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const body = { ...handoverBinding(job, item), accounts: accounts.filter(record => !record.removed).map(({ account, inputs, mode, password, instructions }) => ({ ...(account.id ? { id: account.id } : {}), ...Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()])), credentialMode: mode.value, credentialInstructions: instructions.value.trim(), ...(mode.value === 'password' && password.value ? { password: password.value } : {}) })), prerequisites: lines(prerequisites), checks: checks.filter(record => !record.removed).map(({ action, expected }) => ({ action: action.value.trim(), expected: expected.value.trim() })), limitations: lines(limitations) };
    form.dataset.busy = 'true'; save.disabled = true; cancel.disabled = true; message.textContent = '正在保存…'; const epoch = state.epoch; const requestId = state.detailRequest;
    // Credentials are transient request values, never added to drafts, keys or storage.
    const saving = api(`/jobs/${encodeURIComponent(job.id)}/handover`, { method: 'POST', body });
    body.accounts.forEach(account => { delete account.password; }); accounts.forEach(record => { record.password.value = ''; });
    saving.then(result => { if (epoch !== state.epoch || requestId !== state.detailRequest) return; const updated = result.item; if (updated?.project !== state.project || updated.jobId !== job.id || updated.manifestSha256 !== job.manifestSha256) throw new Error('清单绑定不一致'); clearHandoverSecrets(); state.handovers.set(job.id, updated); renderJobs(); notice('验收交接清单已保存，请按清单完成实际验收。'); }).catch(() => { if (epoch === state.epoch && requestId === state.detailRequest) message.textContent = '清单未保存。请核对必填项；已保存密码可留空，新密码请重新输入。若其他人已更新清单，请刷新后再编辑。'; }).finally(() => { form.dataset.busy = 'false'; save.disabled = false; cancel.disabled = false; });
  });
  host.replaceChildren(form);
}
function renderHandover(container, job) {
  if (!job.manifestSha256) return;
  const section = node('section', undefined, 'production-handover'); section.append(node('h4', '验收交接清单'));
  const item = boundHandover(job);
  if (!item) { section.append(node('p', state.handoverErrors.get(job.id) || '清单尚未读取。请刷新记录，读取本包验收交接材料；缺少清单时仍可登记拒绝。', 'production-notice')); container.append(section); return; }
  const handoverStatus = job.acceptance?.decision === 'accepted' ? '清单已绑定人工验收结论' : job.acceptance ? '已有人工验收结论，请结合结论查看清单' : item.status === 'ready' ? '验收材料已齐备，尚需人员确认' : '交接材料待补齐';
  section.append(node('p', `清单版本：${item.revision || '尚未补录'} · ${handoverStatus}`, 'section-help'));
  if (job.environmentStoppedAt || job.environment?.status === 'stopped') section.append(node('p', '验证环境已停止，交接资料保留。', 'production-notice'));
  const documents = node('div', undefined, 'production-downloads');
  for (const [key, title] of [['operation-guide', '操作手册'], ['deployment-guide', '部署升级手册']]) {
    const document = item.documents?.find(value => value.key === key);
    if (document?.available) { const link = node('a', `阅读${title}`, 'secondary-button'); link.href = `${API}/jobs/${encodeURIComponent(job.id)}/download?${new URLSearchParams({ project: state.project, file: key })}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; documents.append(link); }
    else documents.append(node('span', `${title}尚未提供`, 'field-help'));
  }
  if (item.status === 'ready') { const link = node('a', '下载交接清单（不含密码）', 'secondary-button'); link.href = `${API}/jobs/${encodeURIComponent(job.id)}/download?${new URLSearchParams({ project: state.project, file: 'handover' })}`; documents.append(link); }
  section.append(documents);
  if (item.missingItems?.length) { const missing = node('ul', undefined, 'production-handover-missing'); for (const value of item.missingItems) missing.append(node('li', value)); section.append(node('p', '以下材料未齐备，暂不能通过验收：'), missing); }
  for (const account of item.accounts || []) {
    const row = node('div', undefined, 'production-handover-account'); row.append(node('h5', `验收账号：${text(account.username)}`));
    for (const [label, value] of [['角色', account.role], ['租户', account.tenant], ['组织', account.organization], ['登录说明', account.loginNotes]]) row.append(node('p', `${label}：${text(value)}`));
    if (account.credentialMode === 'external') row.append(node('p', `凭据领取：${text(account.credentialInstructions)}`));
    else if (account.hasPassword) renderHandoverPassword(row, job, item, account); else row.append(node('p', '尚未补录验收密码。', 'field-help'));
    section.append(row);
  }
  if (!item.accounts?.length) section.append(node('p', '尚未提供验收账号、角色与所属范围。', 'field-help'));
  for (const [title, values] of [['验收前提', item.prerequisites], ['限制与未覆盖项', item.limitations]]) { section.append(node('h5', title)); const list = node('ul'); for (const value of values || []) list.append(node('li', value)); section.append(list.children.length ? list : node('p', '尚未填写', 'field-help')); }
  section.append(node('h5', '验收步骤与预期结果'));
  const steps = node('ol'); for (const check of item.checks || []) { const entry = node('li'); entry.append(node('p', `操作：${text(check.action)}`), node('p', `预期：${text(check.expected)}`)); steps.append(entry); } section.append(steps.children.length ? steps : node('p', '尚未填写验收步骤。', 'field-help'));
  if (job.status === 'awaiting-acceptance') { const host = node('div'); const edit = button('编辑验收交接清单', () => { clearHandoverSecrets(); edit.hidden = true; editHandover(host, job, item, () => { host.replaceChildren(); edit.hidden = false; edit.focus?.(); }); }); section.append(edit, host); }
  container.append(section);
}
function renderAcceptance(container, job) {
  if (job.acceptance) { container.append(node('p', `人工验收：${labels[job.acceptance.decision] || job.acceptance.decision} · ${job.acceptance.actor?.displayName || job.acceptance.actor?.username || text(job.acceptance.actor)} · ${date(job.acceptance.at)}`)); if (job.acceptance.notes) container.append(node('p', job.acceptance.notes, 'section-help')); }
  if (job.status !== 'awaiting-acceptance') return;
  if (job.environmentStoppedAt || job.environment?.status === 'stopped') { container.append(node('p', '验证环境已停止，尚未完成人工验收。本次材料和自动验证结果已保留；如需人工验收，请重新创建验证任务。', 'production-notice')); return; }
  const form = node('form', undefined, 'production-form'); const draft = state.drafts.get(job.id) || { decision: '', notes: '', checked: false };
  const handover = boundHandover(job); const canAccept = handover?.status === 'ready' && handover.revision > 0;
  const decisionField = node('div', undefined, 'production-field'); const decisionLabel = node('label', '人工验收结论'); const decision = node('select'); decision.id = `decision-${job.id}`; decisionLabel.htmlFor = decision.id; decision.required = true;
  for (const [value, label] of [['', '请选择人工验收结论'], ['accepted', '已验证，通过'], ['rejected', '未通过，需要处理']]) { const option = new Option(label, value); option.disabled = value === 'accepted' && !canAccept; decision.add(option); } decision.value = draft.decision === 'accepted' && !canAccept ? '' : draft.decision; decisionField.append(decisionLabel, decision);
  if (!canAccept) decisionField.append(node('p', '请先补齐并保存验收交接清单，才能选择通过。拒绝不受清单缺项影响。', 'field-help'));
  const notesField = node('div', undefined, 'production-field'); const notesLabel = node('label', '验收说明'); const notes = node('textarea'); notes.id = `notes-${job.id}`; notesLabel.htmlFor = notes.id; notes.rows = 2; notes.maxLength = 4000; notes.required = true; notes.value = draft.notes; notesField.append(notesLabel, notes);
  const confirmation = node('label', undefined, 'production-confirmation production-wide'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.required = true; checkbox.checked = draft.checked; confirmation.append(checkbox, node('span', '我已检查本次验证环境及对应交付材料，确认以上结论。自动检查结果不会代替我的确认。'));
  const save = () => state.drafts.set(job.id, { decision: decision.value, notes: notes.value, checked: checkbox.checked }); [decision, notes, checkbox].forEach(control => control.addEventListener('input', save));
  const submitButton = node('button', '提交人工验收结论', 'primary-button'); submitButton.type = 'submit';
  const message = node('p', undefined, 'form-message production-wide'); message.id = `acceptance-message-${job.id}`; message.setAttribute('role', 'status');
  form.append(decisionField, notesField, confirmation, submitButton, message);
  form.addEventListener('submit', event => { event.preventDefault(); submit(form, async () => {
    if (decision.value === 'accepted' && !canAccept) throw new Error('验收交接清单尚未齐备，请补齐后再通过验收。');
    if (!['accepted', 'rejected'].includes(decision.value) || !notes.value.trim() || !checkbox.checked) throw new Error('请选择验收结论、填写说明并确认已检查本次材料。');
    await api(`/jobs/${encodeURIComponent(job.id)}/acceptance`, { method: 'POST', body: { decision: decision.value, notes: notes.value.trim(), expectedManifestSha256: job.manifestSha256, ...(decision.value === 'accepted' ? { expectedHandoverRevision: handover.revision } : {}) } }); state.drafts.delete(job.id); await refreshData(); notice('人工验收结论已保存。');
  }, message.id); });
  container.append(form);
}
function renderJobs() {
  clearHandoverSecrets(); state.secretCleanups.clear();
  const container = $('production-jobs'); const jobs = (state.detail?.jobs || []).filter(job => !state.focusJobId || job.id === state.focusJobId);
  if (!jobs.length) { container.replaceChildren(node('p', '当前导出记录尚未读取到交付材料，请刷新记录。', 'production-empty')); return; }
  const cards = jobs.map((job, index) => {
    const card = node('article', undefined, 'production-job'); card.dataset.jobId = job.id;
    const heading = node('div', undefined, 'production-job-heading'); heading.append(node('h3', `${labels[job.mode] || job.mode} · ${arch(job.architecture)} · 第 ${index + 1} 次记录`), badge(job.status)); card.append(heading, jobMeta(job));
    if (job.error) card.append(node('p', /[\u3400-\u9fff]/.test(job.error.message || '') ? job.error.message : '本次生成或验证未完成，请查看下方执行记录及失败原因。', 'production-error'));
    const url = safeEnvironmentUrl(job.environment?.url); const actions = node('div', undefined, 'production-actions');
    if (url && !job.environmentStoppedAt && !['stopped', 'removed', 'failed'].includes(job.environment?.status)) { const link = node('a', '打开验证环境', 'primary-button'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link); }
    if (['awaiting-acceptance', 'ready', 'rejected', 'failed', 'interrupted'].includes(job.status) && !job.environmentStoppedAt && job.environmentSlotOccupied === true) actions.append(button('停止验证环境', async event => {
      if (!window.confirm(`停止后验证地址将不可访问。${job.status === 'awaiting-acceptance' ? '本次任务将保持未完成人工验收，不能再提交验收结论；需要验收时须创建新任务。' : ''}生产包、历史基线和验证材料将永久保留。确认停止这个验证环境？`)) return;
      const control = event.currentTarget; control.disabled = true;
      try { await api(`/jobs/${encodeURIComponent(job.id)}/stop`, { method: 'POST', body: {} }); await refreshData(); notice('验证环境已停止，永久归档材料仍然保留。'); } catch (error) { notice(error.message, true); } finally { control.disabled = false; }
    }));
    if (actions.children.length) card.append(actions);
    const validation = job.validation; card.append(node('p', `自动验证：${labels[validation?.status] || '尚未完成'}`, 'section-help'));
    if (validation?.limitations?.length) card.append(node('p', `验证范围说明：${Array.isArray(validation.limitations) ? validation.limitations.map(value => evidenceLabels[value] || value).join('；') : validation.limitations}`, 'production-notice'));
    if (validation?.checks?.length) { const details = node('details'); details.append(node('summary', '查看自动检查结果')); const checks = node('ul', undefined, 'production-log'); for (const check of validation.checks) checks.append(node('li', typeof check === 'string' ? evidenceLabels[check] || check : `${evidenceLabels[check.name || check.id] || check.name || check.id || '检查'}：${labels[check.status] || check.status || (check.passed === true ? '通过' : '未记录')} ${check.message || check.detail || ''}`)); details.append(checks); card.append(details); }
    renderHandover(card, job); renderAcceptance(card, job);
    if (ready(job)) {
      const downloads = node('div', undefined, 'production-downloads'); const available = new Set((job.artifacts || []).map(artifact => artifact.key));
      for (const [file, title] of files) { if (!available.has(file)) continue; const link = node('a', `下载${title}`, 'secondary-button'); link.href = `${API}/jobs/${encodeURIComponent(job.id)}/download?${new URLSearchParams({ project: state.project, file })}`; link.setAttribute('download', ''); downloads.append(link); }
      card.append(node('p', '已通过人工验收，可离线交付。下载后仍需由运维执行上线，并登记实际结果。', 'section-help'), downloads);
    } else card.append(node('p', '完成真实环境验证并由人员确认通过后，才能下载正式生产交付材料。', 'field-help'));
    const details = node('details'); details.append(node('summary', `执行记录与材料清单（${(job.stages || []).length} 条执行记录）`));
    details.append(node('p', `来源提交：${text(state.detail.item?.commit)}`, 'production-hash'), node('p', `来源镜像：${text(job.sourceArtifact?.service)} · ${text(job.sourceArtifact?.imageDigest)}`, 'production-hash'));
    const log = node('ol', undefined, 'production-log'); for (const stage of job.stages || []) { const entry = node('li'); const name = stage.name || stage.stage || stage.id; entry.append(node('small', date(stage.at || stage.createdAt || stage.startedAt)), node('span', `${evidenceLabels[name] || name || '执行步骤'} · ${labels[stage.status] || stage.status || '已记录'}${stage.message ? ` · ${stage.message}` : ''}`)); log.append(entry); } details.append(log);
    if (job.error) details.append(node('p', `失败原因：${job.error.message || job.error.code || '尚未记录'}`, 'production-error'));
    if (job.manifestSha256) details.append(node('p', `本次材料校验值：${job.manifestSha256}`, 'production-hash'));
    if (job.artifacts?.length) details.append(table(['文件', '大小', '校验值'], job.artifacts.map(artifact => [artifact.name, `${Number(artifact.size || 0).toLocaleString('zh-CN')} 字节`, node('span', text(artifact.sha256), 'production-hash')])));
    card.append(details); return card;
  });
  container.replaceChildren(...cards.reverse());
}
async function openRelease(id, jobId = '') {
  clearHandoverSecrets(); state.handovers.clear(); state.handoverErrors.clear();
  const epoch = state.epoch; const requestId = ++state.detailRequest;
  try { const result = await api(`/releases/${encodeURIComponent(id)}`); if (epoch !== state.epoch || requestId !== state.detailRequest) return;
    state.detail = result; state.focusJobId = jobId; selectView('packages'); $('production-detail').hidden = false; $('production-detail-title').textContent = result.item.title || result.item.version || id;
    $('production-detail-summary').textContent = `版本 ${text(result.item.version)} · 确定时间 ${date(result.item.createdAt)} · 永久保存${result.item.notes ? ` · ${result.item.notes}` : ''}`;
    renderJobs(); await loadHandovers(); if (epoch !== state.epoch || requestId !== state.detailRequest) return; renderJobs(); schedulePoll(); $('production-detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); return true;
  } catch (error) { if (epoch === state.epoch) notice(error.message, true); return false; }
}
async function refreshDetail() {
  clearHandoverSecrets(); if (!state.detail) return; const id = state.detail.item.id; const epoch = state.epoch; const requestId = ++state.detailRequest; const result = await api(`/releases/${encodeURIComponent(id)}`);
  if (epoch !== state.epoch || state.detail?.item.id !== id || requestId !== state.detailRequest) return; state.detail = result; await loadHandovers(); if (epoch === state.epoch && requestId === state.detailRequest) renderJobs();
}
function setActive(active) { state.active = Boolean(active); $('production-surface').hidden = !state.active; if (state.active) schedulePoll(); else { clearHandoverSecrets(); clearTimeout(state.timer); } }
function schedulePoll() {
  clearTimeout(state.timer);
  if (!state.project || !state.active || !exportRows().some(({ job }) => activeStatuses.has(job.status))) return;
  state.timer = setTimeout(async () => {
    if (!state.active) return;
    if (document.hidden || state.polling) { schedulePoll(); return; }
    const epoch = state.epoch; state.polling = true;
    try { await refreshData(); }
    catch (error) { if (epoch === state.epoch) notice(`进度暂时无法刷新：${error.message}。已有任务不会重新创建。`, true); }
    finally { state.polling = false; schedulePoll(); }
  }, 5000);
}
function renderTargets() {
  const select = $('production-target-select'); select.replaceChildren(new Option('请选择交付对象', ''));
  state.targets.forEach(target => select.add(new Option(target.name, target.id)));
  if (state.targets.some(target => target.id === state.targetId)) select.value = state.targetId; else state.targetId = '';
  const selected = $('production-deployment-job').value; const jobs = $('production-deployment-job'); jobs.replaceChildren(new Option('请选择已验收生产包', ''));
  allReadyJobs().forEach(({ release, job }) => jobs.add(new Option(packageName(release, job), job.id)));
  if (Array.from(jobs.options).some(option => option.value === selected)) jobs.value = selected;
  $('production-deployment-form').hidden = !state.targetId;
  if (!state.targetId) { $('production-target-current').textContent = state.targets.length ? '请选择客户或生产环境，查看实际上线记录。' : '尚无交付对象。请先添加客户或生产环境。'; $('production-deployments').replaceChildren(); }
}
async function loadDeployments() {
  const targetId = state.targetId; const epoch = state.epoch; if (!targetId) { renderTargets(); return; }
  $('production-target-current').textContent = '正在读取当前交付对象的上线记录…';
  $('production-deployments').replaceChildren(); $('production-deployment-form').hidden = true;
  try { const result = await api(`/deployments?${new URLSearchParams({ targetId })}`); if (epoch !== state.epoch || targetId !== state.targetId) return;
    const records = (result.items || []).slice().sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    const successful = records.find(record => ['success', 'not-required'].includes(record.databaseStatus) && record.applicationStatus === 'success');
    const release = successful && state.releases.find(item => item.id === successful.releaseId);
    $('production-target-current').textContent = successful ? `最近一次完整成功登记：${release?.title || successful.releaseId} · ${date(successful.occurredAt)}。${records[0] !== successful ? '之后还有未完整成功的操作，请结合下方记录核对当前现场状态。' : '这是人员回传的上线结果。'}` : '尚未登记完整成功的生产上线结果。';
    $('production-deployment-form').hidden = false;
    $('production-deployments').replaceChildren(records.length ? table(['实际操作时间', '生产包', '数据库', '应用', '说明'], records.map(record => {
      const name = state.releases.find(item => item.id === record.releaseId)?.title || record.releaseId; const info = node('div', name); info.append(node('small', record.jobId));
      return [date(record.occurredAt), info, badge(record.databaseStatus), badge(record.applicationStatus), record.notes || '未填写'];
    })) : node('p', '暂无上线记录。首次安装、升级成功或部分失败都应按实际情况登记。', 'production-empty'));
  } catch (error) {
    if (epoch !== state.epoch || targetId !== state.targetId) return;
    $('production-target-current').textContent = '当前交付对象的上线记录未能读取。';
    $('production-deployments').replaceChildren(node('p', '请点击“刷新记录”重试，未读取到记录不代表没有上线历史。', 'production-empty'));
    notice(error.message, true);
  }
}
async function refreshData() {
  clearHandoverSecrets();
  const epoch = state.epoch; const [releases, targets] = await Promise.all([api('/releases'), api('/targets')]); if (epoch !== state.epoch) return;
  state.releases = releases.items || []; state.targets = targets.items || []; renderReleases(); renderTargets();
  if (state.detail) await refreshDetail(); if (state.targetId) await loadDeployments();
}
async function chooseProject(project) {
  clearHandoverSecrets(); state.handovers.clear(); state.handoverErrors.clear();
  state.epoch += 1; state.exportRequest += 1; state.project = project; state.releases = []; state.targets = []; state.detail = null; state.focusJobId = ''; state.targetId = ''; state.exportSource = null; state.capacity = null; state.drafts.clear(); clearTimeout(state.timer);
  $('production-create-dialog').close();
  for (const id of ['production-create-form', 'production-target-form', 'production-deployment-form']) { const form = $(id); form.reset(); form.dataset.busy = 'false'; form.querySelectorAll('button[type="submit"]').forEach(control => { control.disabled = false; }); }
  $('production-occurred-at').value = localDateValue();
  $('production-detail').hidden = true; $('production-project').value = project; $('production-release-list').replaceChildren(node('p', project ? '正在读取生产发布包…' : '请先选择项目。', 'production-empty'));
  if (!embedded) {
    const centerHref = `/forge-gateway/delivery-center?${new URLSearchParams({ project, tab: 'production' })}`;
    document.getElementById('production-back').href = centerHref; document.getElementById('production-brand').href = centerHref;
    const url = new URL(window.location.href); url.searchParams.set('project', project); window.history.replaceState({}, '', url);
  }
  notice(''); renderTargets(); if (!project) return;
  const epoch = state.epoch;
  try { await refreshData(); if (epoch === state.epoch) schedulePoll(); } catch (error) { if (epoch !== state.epoch) return; notice(error.message, true); $('production-release-list').replaceChildren(node('p', '生产包列表未能读取，请点击“刷新记录”重试。', 'production-empty')); }
}
function selectView(view) { if (view !== 'packages') clearHandoverSecrets(); state.view = view; $('production-packages').hidden = view !== 'packages'; $('production-targets').hidden = view !== 'targets'; $('production-detail').hidden = view !== 'packages' || !state.detail; $('production-packages-tab').setAttribute('aria-pressed', String(view === 'packages')); $('production-targets-tab').setAttribute('aria-pressed', String(view === 'targets')); if (view === 'targets' && state.targetId) loadDeployments(); }
async function openExport(artifact) {
  clearHandoverSecrets();
  const epoch = state.epoch; const requestId = ++state.exportRequest; state.exportSource = null; state.capacity = null;
  $('production-create-form').reset(); $('production-mode').value = 'initial'; $('production-base-field').hidden = true; $('production-upgrade-option').disabled = true;
  const select = $('production-architecture'); select.replaceChildren(new Option('正在读取可用架构…', '')); select.disabled = true; select.setAttribute('aria-busy', 'true');
  $('production-base').replaceChildren(new Option('请选择历史全量包', '')); $('production-base').required = false; $('production-base-help').textContent = '正在核对历史全量包…';
  $('production-export-source').textContent = `选中制品：${text(artifact?.name)}`;
  $('production-export-technical').textContent = `镜像摘要：${text(artifact?.digest || artifact?.imageDigest)}`;
  $('production-create-dialog').showModal(); notice('正在核对选中镜像的版本和验证环境名额…', false, 'production-create-message'); updateExportAvailability();
  $('production-capacity').textContent = '正在读取验证环境名额…';
  try {
    const [candidates, releases, capacity] = await Promise.all([api('/candidates'), api('/releases'), api('/capacity')]);
    if (epoch !== state.epoch || requestId !== state.exportRequest) return;
    state.releases = releases.items || []; state.capacity = capacity;
    const matches = (candidates.items || []).flatMap(candidate => (candidate.sourceArtifacts || []).filter(source => source.id === artifact?.id).map(source => ({ candidate, artifact: source })));
    if (matches.length !== 1) throw new Error('该镜像尚未关联到唯一的可交付测试版本，请核对发布记录后再导出。');
    state.exportSource = matches[0]; const { candidate, artifact: source } = state.exportSource;
    $('production-export-source').textContent = `选中 ${text(source.service)} 镜像，提交 ${text(candidate.commit).slice(0, 12)}；将生成该版本整套服务的发布包。`;
    $('production-export-technical').textContent = `来源版本：${candidate.version || candidate.id}；镜像摘要：${text(source.imageDigest)}；提交：${text(candidate.commit)}`;
    select.replaceChildren(new Option(candidate.architectures?.length ? '请选择目标架构' : '暂无可用架构', '')); select.disabled = !candidate.architectures?.length;
    (candidate.architectures || []).forEach(value => select.add(new Option(arch(value), value))); if (candidate.architectures?.length === 1) select.value = candidate.architectures[0];
    renderBaseOptions(); renderCapacity(); renderReleases();
    notice(candidate.available === false ? candidate.unavailableReason || '该版本材料尚不完整，暂不能导出。' : '请填写交付对象、项目和环境用途，再确认生成。', candidate.available === false, 'production-create-message');
  } catch (error) { if (epoch === state.epoch && requestId === state.exportRequest) {
    state.exportSource = null; select.replaceChildren(new Option('架构读取失败，请重新打开重试', '')); select.disabled = true;
    $('production-base-help').textContent = '版本信息未能读取，暂不能选择历史全量包。';
    notice(error.message, true, 'production-create-message'); renderCapacity();
  } }
  finally { if (epoch === state.epoch && requestId === state.exportRequest) { select.setAttribute('aria-busy', 'false'); updateExportAvailability(); } }
}
async function submitExport(form) {
  const epoch = state.epoch; const source = state.exportSource;
  if (!source || source.candidate.available === false) throw new Error('选中镜像尚无可交付的已测试版本。');
  if (!state.capacity || state.capacity.available < 1) throw new Error('验证环境名额已占用，请先处理已有验证记录。');
  const body = { candidateId: source.candidate.id, sourceArtifactId: source.artifact.id, mode: $('production-mode').value, architecture: $('production-architecture').value, delivery: { recipient: $('production-recipient').value.trim(), projectName: $('production-delivery-project').value.trim(), purpose: $('production-purpose').value.trim() } };
  if (!source.candidate.architectures?.includes(body.architecture)) throw new Error('请选择该版本可验证的目标架构。');
  if (Object.values(body.delivery).some(value => !value)) throw new Error('请完整填写交付给谁、用于哪个项目以及环境用途。');
  if (body.mode === 'upgrade') { body.baseJobId = $('production-base').value; if (!baselineChoices().some(({ job }) => job.id === body.baseJobId)) throw new Error('请选择同架构、已验收且恢复材料完整的历史全量包。'); }
  const key = idempotency(form, body); const intent = state.keys.get(form);
  const result = intent.result || await api('/exports', { method: 'POST', body: { ...body, idempotencyKey: key } });
  intent.result = result;
  if (epoch !== state.epoch) return;
  const receipt = `生产包导出任务已创建：${result.item.id}。`;
  $('production-create-dialog').close(); notice(receipt);
  try {
    await onExportCreated(result); if (epoch !== state.epoch) return;
    setActive(true); selectView('packages'); notice(receipt);
    await refreshData(); if (epoch !== state.epoch) return;
    const opened = await openRelease(result.release.id, result.item.id); if (epoch !== state.epoch) return;
    if (!opened) throw new Error('任务详情暂时无法读取。');
    state.keys.delete(form); notice(`${receipt}可在本页查看进度和验证地址。`);
  } catch (error) {
    if (epoch !== state.epoch) return;
    setActive(true); selectView('packages');
    notice(`${receipt}记录暂时未能刷新：${error.message} 请点击“刷新记录”查看已有任务，无需重新导出。`, true);
  }
}
function localDateValue(value) { const instant = value ? new Date(value) : new Date(); return Number.isFinite(instant.getTime()) ? new Date(instant.getTime() - instant.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''; }
function closeDetail() { clearHandoverSecrets(); state.detailRequest += 1; state.detail = null; state.focusJobId = ''; state.handovers.clear(); state.handoverErrors.clear(); $('production-detail').hidden = true; }
function bindEvents() {
  $('production-project').addEventListener('change', () => chooseProject($('production-project').value));
  $('production-packages-tab').addEventListener('click', () => selectView('packages')); $('production-targets-tab').addEventListener('click', () => selectView('targets'));
  $('production-search').addEventListener('input', renderReleases); $('production-mode').addEventListener('change', renderBaseOptions); $('production-architecture').addEventListener('change', renderBaseOptions);
  for (const id of ['production-filter-mode', 'production-filter-from', 'production-filter-to']) $(id).addEventListener('change', renderReleases);
  $('production-refresh').addEventListener('click', async event => { event.currentTarget.disabled = true; try { await refreshData(); notice('记录已刷新。'); } catch (error) { notice(error.message, true); } finally { $('production-refresh').disabled = false; } });
  $('production-artifacts-open').addEventListener('click', () => onArtifacts(state.project));
  $('production-create-close').addEventListener('click', () => { state.exportRequest += 1; $('production-create-dialog').close(); });
  $('production-create-cancel').addEventListener('click', () => { state.exportRequest += 1; $('production-create-dialog').close(); });
  $('production-create-dialog').addEventListener('cancel', () => { state.exportRequest += 1; });
  $('production-detail-close').addEventListener('click', closeDetail);
  $('production-create-form').addEventListener('submit', event => { event.preventDefault(); submit(event.currentTarget, () => submitExport(event.currentTarget), 'production-create-message').finally(updateExportAvailability); });
  $('production-target-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; submit(form, async () => {
    const body = { name: $('production-target-name').value.trim(), description: $('production-target-description').value.trim() }; const result = await api('/targets', { method: 'POST', body: { ...body, idempotencyKey: idempotency(form, body) } }); state.targetId = result.item.id; form.reset(); state.keys.delete(form); await refreshData(); notice('交付对象已添加，可登记实际上线结果。');
  }); });
  $('production-target-select').addEventListener('change', () => { state.targetId = $('production-target-select').value; state.receiptSource = 'manual'; $('production-deployment-form').reset(); $('production-occurred-at').value = localDateValue(); loadDeployments(); });
  $('production-deployment-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; submit(form, async () => {
    const selected = allReadyJobs().find(({ job }) => job.id === $('production-deployment-job').value); if (!state.targetId || !selected) throw new Error('请选择交付对象和实际使用的已验收生产包。');
    const occurredAt = new Date($('production-occurred-at').value); if (!Number.isFinite(occurredAt.getTime())) throw new Error('请填写实际操作时间。');
    const body = { targetId: state.targetId, releaseId: selected.release.id, jobId: selected.job.id, occurredAt: occurredAt.toISOString(), databaseStatus: $('production-database-status').value, applicationStatus: $('production-application-status').value, notes: $('production-deployment-notes').value.trim(), source: state.receiptSource };
    await api('/deployments', { method: 'POST', body: { ...body, idempotencyKey: idempotency(form, body) } }); state.keys.delete(form); state.receiptSource = 'manual'; form.reset(); $('production-occurred-at').value = localDateValue(); await loadDeployments(); notice('已按实际数据库和应用结果保存上线记录。');
  }); });
  $('production-receipt-file').addEventListener('change', async event => {
    const epoch = state.epoch;
    try { const file = event.target.files?.[0]; if (!file) return; if (file.size > 65536) throw new Error('结果文件过大，请使用不超过 64 KB 的 JSON 文件。'); const value = JSON.parse(await file.text()); if (epoch !== state.epoch) return;
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.project !== state.project) throw new Error('结果文件不属于当前项目或格式无效。');
      const selected = allReadyJobs().find(({ release, job }) => job.id === value.jobId && release.id === value.releaseId);
      if (selected && value.manifestSha256 !== selected.job.manifestSha256) throw new Error('结果文件的材料校验值与所选生产包不一致。');
      if (!selected || value.targetId !== state.targetId || !['success', 'failed', 'partial', 'not-required'].includes(value.databaseStatus) || !['success', 'failed', 'not-run'].includes(value.applicationStatus) || typeof value.occurredAt !== 'string' || !localDateValue(value.occurredAt)) throw new Error('请核对结果文件中的交付对象、生产包、操作时间和执行结果。');
      $('production-deployment-job').value = value.jobId; $('production-occurred-at').value = localDateValue(value.occurredAt); $('production-database-status').value = value.databaseStatus; $('production-application-status').value = value.applicationStatus; $('production-deployment-notes').value = typeof value.notes === 'string' ? value.notes.slice(0, 4000) : ''; state.receiptSource = 'imported'; notice('结果文件已填入表单，请核对后点击“保存上线记录”。');
    } catch (error) { if (epoch !== state.epoch) return; notice(error instanceof SyntaxError ? '结果文件不是有效的 JSON，请检查文件内容。' : error.message, true); }
  });
  window.addEventListener('pagehide', () => { clearHandoverSecrets(); clearTimeout(state.timer); });
  document.addEventListener?.('visibilitychange', () => { if (document.hidden) clearHandoverSecrets(); });
}
async function initialize() {
  $('production-occurred-at').value = localDateValue();
  try { state.session = await api('/forge-gateway/api/session', { raw: true }); document.getElementById('production-user').textContent = state.session.user.displayName || state.session.user.username;
    const projects = await api('/forge-gateway/api/projects', { raw: true }); state.projects = (projects.items || []).filter(project => project.canEnter === true || state.session.user.role === 'admin'); const select = $('production-project'); select.replaceChildren();
    state.projects.forEach(project => select.add(new Option(project.displayName || project.slug, project.slug))); select.disabled = !state.projects.length;
    if (!state.projects.length) { notice('当前账号没有可管理生产交付的项目，请联系平台管理员。', true); return; }
    const requested = new URL(window.location.href).searchParams.get('project');
    if (requested && !state.projects.some(project => project.slug === requested)) {
      const centerHref = `/forge-gateway/delivery-center?${new URLSearchParams({ project: requested, tab: 'production' })}`;
      document.getElementById('production-back').href = centerHref; document.getElementById('production-brand').href = centerHref;
      notice('当前账号不能管理这个项目的生产交付，请返回发布包与制品，或选择有权限的项目。', true);
      select.value = ''; return;
    }
    await chooseProject(requested || state.projects[0].slug);
  } catch (error) { notice(error.message, true); }
}
bindEvents(); $('production-project-field').hidden = embedded; $('production-refresh').hidden = embedded; $('production-occurred-at').value = localDateValue(); setActive(!embedded);
return { setProject: project => project === state.project ? Promise.resolve() : chooseProject(project), setActive, openExport, openJob: openRelease, refresh: refreshData, initializeStandalone: initialize };
}

export async function mountProductionDelivery(root, options = {}) {
  const response = await fetch('/forge-gateway/assets/production-delivery-panel.html', { credentials: 'same-origin', cache: 'no-cache' });
  if (!response.ok) throw new Error('生产交付页面未能加载，请刷新后重试。');
  // Trusted, same-origin static markup; all record values are rendered using textContent.
  root.innerHTML = await response.text();
  return createProductionDelivery(root, options);
}
const standalone = document.getElementById('production-standalone');
if (standalone) mountProductionDelivery(standalone).then(panel => panel.initializeStandalone()).catch(error => { standalone.textContent = error.message; });
