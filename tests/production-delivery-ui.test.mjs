import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
const source = await readFile(new URL('../docker/harness/conversation-gateway/production-delivery.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../docker/harness/conversation-gateway/production-delivery.html', import.meta.url), 'utf8');
const panelMarkup = await readFile(new URL('../docker/harness/conversation-gateway/production-delivery-panel.html', import.meta.url), 'utf8');
function fixture({ embedded = true, cryptoProvider = { randomUUID: () => 'unique-key' } } = {}) {
  const ids = new Map();
  class Element extends EventTarget {
    constructor(tag, value) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {}; this.ownText = value || ''; this.value = ''; this.hidden = false; this.open = false; }
    set id(value) { this._id = value; ids.set(value, this); } get id() { return this._id; }
    set textContent(value) { this.ownText = String(value); this.children = []; } get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    append(...children) { this.children.push(...children); } replaceChildren(...children) { this.children = children; this.ownText = ''; if (this.tagName === 'SELECT') this.value = children[0]?.value || ''; }
    setAttribute(name, value) { this.attributes[name] = String(value); } add(option) { this.append(option); } get options() { return this.children; }
    querySelectorAll(selector) { return walk(this).filter(element => selector === 'button[type="submit"]' && element.tagName === 'BUTTON' && element.type === 'submit'); }
    scrollIntoView() {} showModal() { this.open = true; } close() { this.open = false; } reset() { this.resetCalled = true; }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
  }
  const walk = element => [element, ...element.children.flatMap(walk)];
  for (const match of (markup + panelMarkup).matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) { const element = new Element(match[1]); element.id = match[2]; }
  const document = { getElementById: id => ids.get(id), createElement: tag => new Element(tag), hidden: false };
  const requests = []; const created = []; const timers = new Map(); let timerId = 0;
  const context = vm.createContext({ document, root: { querySelector: selector => ids.get(selector.slice(1)) }, embedded, session: { csrfToken: 'csrf' }, onArtifacts() {}, onExportCreated: async result => created.push(result), Node: Element, Option: class extends Element { constructor(label, value) { super('option', label); this.value = value; } },
    URL, URLSearchParams, Intl, Date, console, setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id), crypto: cryptoProvider,
    window: { location: { origin: 'https://platform.test', href: 'https://platform.test/forge-gateway/production-delivery?project=project-alpha', assign() {} }, history: { replaceState() {} }, addEventListener() {}, confirm: () => true },
    fetch: async (url, options) => { requests.push({ url: String(url), options }); return { ok: true, json: async () => ({ items: [] }) }; } });
  // Exercise the same scoped implementation with a small DOM fixture; no browser or real mutation.
  vm.runInContext(source.slice(source.indexOf('\n') + 1, source.indexOf('\nbindEvents();')), context);
  const run = value => vm.runInContext(value, context); run("state.project='project-alpha';state.active=true;");
  return { run, requests, created, timers, get: id => ids.get(id), walk, setFetch: handler => { context.fetch = handler; } };
}
const job = { id: 'job-1', mode: 'initial', architecture: 'amd64', status: 'awaiting-acceptance', environment: { id: 'env-1', url: 'https://validation.test/', status: 'running' }, manifestSha256: 'a'.repeat(64), validation: { status: 'passed', checks: [] }, artifacts: [{ key: 'bundle', name: 'bundle.tar', size: 123, sha256: 'b'.repeat(64) }], stages: [] };
const accepted = { ...job, status: 'ready', acceptance: { decision: 'accepted' }, baselineAvailable: true };
const candidate = { id: 'candidate-a', version: 'v2', commit: 'abc', available: true, architectures: ['amd64'], sourceArtifacts: [{ id: 'exact-image-id', service: 'admin', imageDigest: 'sha256:abc' }] };
const response = value => ({ ok: true, json: async () => value });
const handover = { schemaVersion: 1, project: 'project-alpha', jobId: 'job-1', manifestSha256: 'a'.repeat(64), revision: 3, status: 'ready', missingItems: [], accounts: [{ id: 'account-1', username: 'verifier', role: '验收员', tenant: '示例客户', organization: '项目组', loginNotes: '首次登录需改密', credentialMode: 'password', credentialInstructions: '', hasPassword: true }], prerequisites: ['准备独立浏览器'], checks: [{ action: '进入菜单', expected: '显示授权菜单' }], limitations: ['尚未覆盖生产外部网络'], documents: [{ key: 'operation-guide', available: true }, { key: 'deployment-guide', available: true }] };
function showHandover(f, item = handover) { f.run(`state.detail={item:{id:'release-1'},jobs:[${JSON.stringify(job)}]};state.focusJobId='job-1';state.handovers.set('job-1',${JSON.stringify(item)});renderJobs();`); }
const flush = () => new Promise(resolve => setImmediate(resolve));
function labeledControl(f, root, label) { return f.walk(root).find(element => element.tagName === 'LABEL' && element.children[0]?.textContent === label)?.children[1]; }

test('legacy direct URL keeps the shared panel and returns to production within the center', async () => {
  const f = fixture({ embedded: false }); await f.run("chooseProject('foundation-32148')");
  for (const id of ['production-back', 'production-brand']) {
    const url = new URL(f.get(id).href, 'https://platform.test'); assert.equal(url.pathname, '/forge-gateway/delivery-center');
    assert.equal(url.searchParams.get('project'), 'foundation-32148'); assert.equal(url.searchParams.get('tab'), 'production');
  }
  assert.match(markup, /production-standalone/); assert.match(source, /assets\/production-delivery-panel\.html/);
  assert.doesNotMatch(panelMarkup, /<script|<iframe/); assert.match(panelMarkup, /生产包和历史基线永久保存/);
});

test('automatic success retains explicit human acceptance and offers only an explicit stop without signing or downloading', () => {
  const f = fixture(); f.run(`state.detail={jobs:[${JSON.stringify({ ...job, environmentSlotOccupied: true })}]};renderJobs();`);
  const elements = f.walk(f.get('production-jobs')); assert.equal(f.requests.length, 0);
  assert.ok(elements.some(element => element.tagName === 'A' && element.textContent === '打开验证环境'));
  assert.ok(elements.some(element => element.tagName === 'BUTTON' && element.textContent === '提交人工验收结论'));
  assert.equal(elements.some(element => element.tagName === 'A' && element.href?.includes('/download')), false);
  assert.equal(elements.some(element => element.tagName === 'BUTTON' && element.textContent === '停止验证环境'), true);
  assert.equal(f.get('decision-job-1').value, ''); assert.equal(f.get('notes-job-1').required, true);
});

test('stopped unaccepted jobs retain the result but hide acceptance, visit and download controls', () => {
  const f = fixture();
  f.run(`state.detail={jobs:[${JSON.stringify({ ...job, environmentStoppedAt: '2026-10-21T01:00:00Z', environmentSlotOccupied: false, environment: { ...job.environment, status: 'stopped' } })}]};renderJobs();`);
  const elements = f.walk(f.get('production-jobs'));
  assert.match(f.get('production-jobs').textContent, /环境已停止，尚未完成人工验收.*自动验证结果已保留.*重新创建验证任务/);
  assert.equal(elements.some(element => element.tagName === 'FORM'), false);
  assert.equal(elements.some(element => element.tagName === 'A'), false);
  assert.equal(elements.some(element => element.tagName === 'BUTTON' && element.textContent === '停止验证环境'), false);
  assert.equal(f.requests.length, 0);
});

test('active validation stages do not offer an explicit stop or acceptance', () => {
  for (const status of ['queued', 'preparing', 'restoring', 'upgrading', 'verifying']) {
    const f = fixture(); f.run(`state.detail={jobs:[${JSON.stringify({ ...job, status, environmentSlotOccupied: true })}]};renderJobs();`);
    const elements = f.walk(f.get('production-jobs'));
    assert.equal(elements.some(element => element.tagName === 'FORM'), false);
    assert.equal(elements.some(element => element.tagName === 'BUTTON' && element.textContent === '停止验证环境'), false);
  }
});

test('failed occupied job can be explicitly stopped even before an environment identity exists', () => {
  const f = fixture(); f.run(`state.detail={jobs:[${JSON.stringify({ ...job, status: 'failed', environment: null, environmentSlotOccupied: true })}]};renderJobs();`);
  assert.equal(f.walk(f.get('production-jobs')).filter(el => el.tagName === 'BUTTON' && el.textContent === '停止验证环境').length, 1);
  assert.equal(f.requests.length, 0);
});

test('an unavailable standalone requested project is not silently replaced', async () => {
  const f = fixture({ embedded: false });
  f.run("state.project='';fetch=async url=>({ok:true,json:async()=>String(url).endsWith('/api/session')?{user:{username:'member',role:'member'},csrfToken:'csrf'}:String(url).endsWith('/api/projects')?{items:[{slug:'project-beta',canEnter:true}]}:{items:[]}})");
  await f.run('initialize()'); assert.equal(f.run('state.project'), '');
  assert.match(f.get('production-back').href, /project=project-alpha&tab=production/);
  await f.run("chooseProject('project-beta')"); assert.equal(f.run('state.project'), 'project-beta');
});

test('download entry requires accepted ready material and only exposes actual known files', () => {
  const f = fixture(); f.run(`state.detail={jobs:[${JSON.stringify(accepted)}]};renderJobs();`);
  const links = f.walk(f.get('production-jobs')).filter(element => element.tagName === 'A' && element.href?.includes('/download'));
  assert.equal(links.length, 1); assert.match(links[0].href, /project=project-alpha&file=bundle/);
  assert.equal(f.run(`ready(${JSON.stringify({ ...accepted, acceptance: null })})`), false);
  assert.equal(f.run("safeEnvironmentUrl('javascript:alert(1)')"), null); assert.equal(f.run("safeEnvironmentUrl('https://user:secret@example.test')"), null);
});

test('upgrade offers all eligible historical full packages, never upgrade, wrong architecture or missing baseline', () => {
  const f = fixture(); f.run(`state.releases=[{id:'release-a',title:'旧生产版',jobs:[${JSON.stringify(accepted)},${JSON.stringify({ ...accepted, id: 'upgrade-job', mode: 'upgrade' })},${JSON.stringify({ ...accepted, id: 'arm-job', architecture: 'arm64' })},${JSON.stringify({ ...accepted, id: 'missing-baseline', baselineAvailable: false })}]},{id:'release-older',jobs:[${JSON.stringify({ ...accepted, id: 'older-full' })}]}];`);
  f.get('production-mode').value = 'upgrade'; f.get('production-architecture').value = 'amd64'; f.run('renderBaseOptions()');
  assert.deepEqual(f.get('production-base').options.map(option => option.value), ['', 'job-1', 'older-full']); assert.equal(f.get('production-base').required, true);
  assert.equal(f.get('production-upgrade-option').disabled, false);
});

test('no full package disables incremental with different wording from an unaccepted existing full package', () => {
  const f = fixture(); f.get('production-architecture').value = 'amd64'; f.get('production-mode').value = 'upgrade'; f.run('renderBaseOptions()');
  assert.equal(f.get('production-upgrade-option').disabled, true); assert.equal(f.get('production-mode').value, 'initial');
  assert.match(f.get('production-base-help').textContent, /尚未导出过全量包/);
  f.run(`state.releases=[{id:'r',jobs:[${JSON.stringify(job)}]}];renderBaseOptions()`);
  assert.match(f.get('production-base-help').textContent, /已有全量包尚未满足增量起点条件.*人工验收/);
  assert.doesNotMatch(f.get('production-base-help').textContent, /尚未导出过/);
});

test('each export is a list row and missing historic metadata remains unrecorded', () => {
  const f = fixture(); f.run(`state.releases=[{id:'r',version:'v1',jobs:[${JSON.stringify({ ...job, createdBy: { displayName: '真实操作人' } })},${JSON.stringify({ ...accepted, id: 'job-2', delivery: { recipient: '客户甲', projectName: '建设项目', purpose: '现场生产' } })}]},{id:'empty',jobs:[]}];renderReleases()`);
  const rows = f.walk(f.get('production-release-list')).filter(el => el.tagName === 'TR'); assert.equal(rows.length, 3);
  assert.match(rows[1].textContent, /真实操作人.*未记录/); assert.match(rows[2].textContent, /客户甲.*建设项目/);
  assert.match(f.run("jobMeta(state.releases[0].jobs[1]).textContent"), /现场生产/);
});

test('production filters combine mode, actor and inclusive local export dates without inventing historic dates', () => {
  const f = fixture(); f.run(`state.releases=[{id:'r',title:'交付包',jobs:[
    {...${JSON.stringify(job)},id:'full-old',createdAt:'2026-10-03T12:00:00',createdBy:{displayName:'甲',username:'alice'}},
    {...${JSON.stringify(job)},id:'upgrade-new',mode:'upgrade',createdAt:'2026-10-07T12:00:00',createdBy:{displayName:'乙',username:'bob'}},
    {...${JSON.stringify(job)},id:'unknown',createdBy:{displayName:'乙'}}]}]`);
  f.get('production-filter-mode').value = 'upgrade'; f.get('production-search').value = 'bob';
  f.get('production-filter-from').value = '2026-10-07'; f.get('production-filter-to').value = '2026-10-07'; f.run('renderReleases()');
  assert.equal(f.walk(f.get('production-release-list')).filter(el => el.tagName === 'TR').length, 2);
  assert.match(f.get('production-release-list').textContent, /增量包.*乙/);
  f.get('production-filter-mode').value = 'initial'; f.run('renderReleases()'); assert.match(f.get('production-release-list').textContent, /没有匹配/);
  f.get('production-search').value = ''; f.get('production-filter-from').value = ''; f.get('production-filter-to').value = ''; f.run('renderReleases()');
  assert.equal(f.walk(f.get('production-release-list')).filter(el => el.tagName === 'TR').length, 3);
});

test('artifact export resolves only exact source IDs and capacity prevents new work without stopping anything', async () => {
  const f = fixture(); const calls = [];
  f.setFetch(async url => { calls.push(String(url)); const path = new URL(url).pathname; return response(path.endsWith('/candidates') ? { items: [candidate] } : path.endsWith('/capacity') ? { limit: 1, occupied: 1, available: 0, items: [{ jobId: 'job-1', releaseId: 'r' }] } : { items: [] }); });
  await f.run("openExport({id:'exact-image-id',name:'镜像',digest:'sha256:abc'})");
  assert.equal(f.run('state.exportSource.candidate.id'), 'candidate-a'); assert.equal(f.get('production-export-submit').disabled, true);
  assert.match(f.get('production-capacity').textContent, /已占用.*不会自动停用或覆盖/);
  await assert.rejects(f.run("submitExport(document.getElementById('production-create-form'))"), /名额已占用/);
  await f.run("openExport({id:'wrong-image-id',digest:'sha256:abc'})"); assert.equal(f.run('state.exportSource'), null);
  assert.match(f.get('production-create-message').textContent, /尚未关联到唯一/); assert.equal(calls.some(url => url.includes('/stop')), false);
});

test('opening another export clears previous architecture and baseline options while loading', async () => {
  const f = fixture(); const pending = [];
  f.setFetch(async url => response(new URL(url).pathname.endsWith('/candidates') ? { items: [candidate] } : new URL(url).pathname.endsWith('/capacity') ? { available: 1 } : { items: [{ id: 'r', jobs: [accepted] }] }));
  await f.run("openExport({id:'exact-image-id'})");
  assert.equal(f.get('production-architecture').value, 'amd64');
  assert.equal(f.get('production-base').options.length, 2);
  f.setFetch(url => new Promise(resolve => pending.push({ url: String(url), resolve })));
  const opening = f.run("openExport({id:'exact-image-id'})");
  assert.deepEqual(f.get('production-architecture').options.map(option => option.value), ['']);
  assert.match(f.get('production-architecture').textContent, /正在读取/);
  assert.equal(f.get('production-architecture').disabled, true);
  assert.equal(f.get('production-architecture').attributes['aria-busy'], 'true');
  assert.deepEqual(f.get('production-base').options.map(option => option.value), ['']);
  assert.equal(f.get('production-base').required, false);
  assert.equal(f.get('production-export-submit').disabled, true);
  for (const request of pending) request.resolve(response(request.url.includes('/candidates') ? { items: [candidate] } : request.url.includes('/capacity') ? { available: 1 } : { items: [] }));
  await opening;
  assert.equal(f.get('production-architecture').disabled, false);
  assert.equal(f.get('production-architecture').attributes['aria-busy'], 'false');
  assert.equal(f.get('production-export-submit').disabled, false);
});

test('each failed export lookup ends loading, prevents stale submission and can recover on reopen', async t => {
  for (const failedEndpoint of ['/candidates', '/releases', '/capacity']) await t.test(failedEndpoint, async () => {
    const f = fixture(); let fail = false; const calls = [];
    f.setFetch(async (url, options) => {
      calls.push({ url: String(url), options }); const path = new URL(url).pathname;
      if (fail && path.endsWith(failedEndpoint)) return { ok: false, status: 404, json: async () => ({ code: 'PRODUCTION_PROJECT_NOT_FOUND', message: '该项目尚未配置生产交付' }) };
      return response(path.endsWith('/candidates') ? { items: [candidate] } : path.endsWith('/capacity') ? { available: 1 } : { items: [] });
    });
    await f.run("openExport({id:'exact-image-id'})"); fail = true;
    await f.run("openExport({id:'exact-image-id'})");
    assert.deepEqual(f.get('production-architecture').options.map(option => option.value), ['']);
    assert.match(f.get('production-architecture').textContent, /读取失败/);
    assert.equal(f.get('production-architecture').disabled, true);
    assert.equal(f.get('production-architecture').attributes['aria-busy'], 'false');
    assert.match(f.get('production-create-message').textContent, /尚未配置生产交付/);
    assert.doesNotMatch(f.get('production-capacity').textContent, /正在读取/);
    assert.equal(f.run('state.exportSource'), null);
    assert.equal(f.get('production-export-submit').disabled, true);
    await assert.rejects(f.run("submitExport(document.getElementById('production-create-form'))"), /尚无可交付/);
    assert.equal(calls.some(call => call.options?.method === 'POST'), false);
    fail = false; await f.run("openExport({id:'exact-image-id'})");
    assert.equal(f.get('production-architecture').value, 'amd64');
    assert.equal(f.get('production-architecture').disabled, false);
    assert.equal(f.get('production-export-submit').disabled, false);
    assert.doesNotMatch(f.get('production-create-message').textContent, /尚未配置|读取失败/);
  });
});

test('single export POST preserves exact binding, delivery fields and CSRF then opens the created job in the host tab', async () => {
  const f = fixture(); const calls = []; const createdJob = { ...job, id: 'created-job' }; const release = { id: 'created-release', version: 'v2', jobs: [createdJob] };
  f.setFetch(async (url, options) => { calls.push({ url: String(url), options }); const path = new URL(url).pathname; return response(path.endsWith('/exports') ? { item: createdJob, release } : path.endsWith('/releases/created-release') ? { item: release, jobs: [createdJob] } : path.endsWith('/releases') ? { items: [release] } : { items: [] }); });
  f.run(`state.exportSource={candidate:${JSON.stringify(candidate)},artifact:${JSON.stringify(candidate.sourceArtifacts[0])}};state.capacity={available:1};`);
  for (const [id, value] of Object.entries({ 'production-mode': 'initial', 'production-architecture': 'amd64', 'production-recipient': '客户', 'production-delivery-project': '项目', 'production-purpose': '生产安装' })) f.get(id).value = value;
  await f.run("submitExport(document.getElementById('production-create-form'))");
  const posts = calls.filter(call => call.options?.method === 'POST'); assert.equal(posts.length, 1); assert.match(posts[0].url, /\/exports$/);
  const body = JSON.parse(posts[0].options.body); assert.deepEqual(body.delivery, { recipient: '客户', projectName: '项目', purpose: '生产安装' });
  assert.equal(body.sourceArtifactId, 'exact-image-id'); assert.equal(body.candidateId, 'candidate-a'); assert.equal(body.project, 'project-alpha'); assert.equal(Object.hasOwn(body, 'actor'), false);
  assert.equal(posts[0].options.headers['x-forge-csrf-token'], 'csrf'); assert.equal(f.created.length, 1); assert.equal(f.run('state.focusJobId'), 'created-job');
  assert.equal(f.run("const form={};idempotency(form,{title:'A'})===idempotency(form,{title:'A'})"), true);
});

test('project changes discard pending source lookup and close its export dialog', async () => {
  const f = fixture(); const pending = [];
  f.setFetch((url) => new Promise(resolve => pending.push({ url: String(url), resolve })));
  const opening = f.run("openExport({id:'exact-image-id'})"); const switching = f.run("chooseProject('project-beta')");
  for (const request of pending) request.resolve(response(request.url.includes('/candidates') ? { items: [candidate] } : request.url.includes('/capacity') ? { available: 1, items: [] } : { items: [] }));
  await Promise.all([opening, switching]); assert.equal(f.run('state.project'), 'project-beta'); assert.equal(f.run('state.exportSource'), null); assert.equal(f.get('production-create-dialog').open, false);
});

test('polling follows active list jobs without needing an open detail and stops when the tab leaves', () => {
  const f = fixture(); f.run(`state.releases=[{id:'r',jobs:[${JSON.stringify({ ...job, status: 'verifying' })}]}];state.detail=null;schedulePoll()`);
  assert.equal(f.timers.size, 1); f.run('setActive(false)'); assert.equal(f.timers.size, 0); assert.equal(f.get('production-surface').hidden, true);
});

test('stopping a validation environment refreshes both the list and detail without stale visit links', async () => {
  const f = fixture(); const running = { ...accepted, environmentSlotOccupied: true }; const stopped = { ...running, environmentSlotOccupied: false, environment: { ...running.environment, status: 'stopped' } };
  const release = { id: 'release-stop', jobs: [stopped] }; const calls = [];
  f.setFetch(async (url, options) => {
    calls.push({ url: String(url), options }); const path = new URL(url).pathname;
    return response(path.endsWith('/stop') ? { item: stopped } : path.endsWith('/releases/release-stop') ? { item: release, jobs: [stopped] } : path.endsWith('/releases') ? { items: [release] } : { items: [] });
  });
  f.run(`state.releases=[{id:'release-stop',jobs:[${JSON.stringify(running)}]}];state.detail={item:{id:'release-stop'},jobs:[${JSON.stringify(running)}]};renderReleases();renderJobs();`);
  f.walk(f.get('production-jobs')).find(element => element.tagName === 'BUTTON' && element.textContent === '停止验证环境').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
  assert.equal(f.run('state.releases[0].jobs[0].environment.status'), 'stopped');
  for (const id of ['production-release-list', 'production-jobs']) {
    const links = f.walk(f.get(id)).filter(element => element.tagName === 'A' && element.href === 'https://validation.test/');
    assert.equal(links.length, 0); assert.match(f.get(id).textContent, /已停止/);
  }
});

test('switching delivery target clears old history immediately and failed reads remain explicitly unknown', async () => {
  const f = fixture(); let resolveRead;
  f.get('production-target-current').textContent = '客户甲已经上线'; f.get('production-deployments').textContent = '客户甲上线历史';
  f.run("state.targetId='target-b'"); f.setFetch(() => new Promise(resolve => { resolveRead = resolve; }));
  const pending = f.run('loadDeployments()');
  assert.match(f.get('production-target-current').textContent, /正在读取当前交付对象/); assert.equal(f.get('production-deployments').textContent, '');
  assert.equal(f.get('production-deployment-form').hidden, true);
  resolveRead({ ok: false, status: 503, json: async () => ({ message: '记录服务暂不可用' }) }); await pending;
  assert.match(f.get('production-target-current').textContent, /当前交付对象.*未能读取/);
  assert.doesNotMatch(f.get('production-deployments').textContent, /客户甲|暂无上线记录/);
  assert.match(f.get('production-deployments').textContent, /未读取到记录不代表没有上线历史/);
});

test('a successful export keeps a visible receipt and reuses its result when later reads fail', async () => {
  const f = fixture(); const calls = []; const createdJob = { ...job, id: 'receipt-job' }; const release = { id: 'receipt-release', version: 'v2', jobs: [createdJob] }; let failReads = true;
  f.setFetch(async (url, options) => {
    calls.push({ url: String(url), options }); const path = new URL(url).pathname;
    if (path.endsWith('/exports')) return response({ item: createdJob, release });
    if (failReads) return { ok: false, status: 503, json: async () => ({ message: '记录读取暂不可用' }) };
    return response(path.endsWith('/releases/receipt-release') ? { item: release, jobs: [createdJob] } : path.endsWith('/releases') ? { items: [release] } : { items: [] });
  });
  f.run(`state.exportSource={candidate:${JSON.stringify(candidate)},artifact:${JSON.stringify(candidate.sourceArtifacts[0])}};state.capacity={available:1};`);
  for (const [id, value] of Object.entries({ 'production-mode': 'initial', 'production-architecture': 'amd64', 'production-recipient': '客户', 'production-delivery-project': '项目', 'production-purpose': '生产安装' })) f.get(id).value = value;
  f.get('production-create-dialog').open = true;
  await f.run("submitExport(document.getElementById('production-create-form'))");
  assert.equal(f.get('production-create-dialog').open, false); assert.equal(f.get('production-surface').hidden, false);
  assert.match(f.get('production-message').textContent, /已创建：receipt-job.*暂时未能刷新.*无需重新导出/);
  assert.equal(f.run("state.keys.get(document.getElementById('production-create-form')).result.item.id"), 'receipt-job');
  failReads = false; await f.run("submitExport(document.getElementById('production-create-form'))");
  assert.equal(calls.filter(call => call.options?.method === 'POST').length, 1);
  assert.equal(f.run('state.focusJobId'), 'receipt-job'); assert.match(f.get('production-message').textContent, /已创建：receipt-job.*可在本页查看/);
});

test('HTTP export without randomUUID posts a secure UUIDv4 and preserves the same-intent receipt', async () => {
  const f = fixture({ cryptoProvider: { getRandomValues: values => webcrypto.getRandomValues(values) } });
  const posts = []; const createdJob = { ...job, id: 'http-job' }; const release = { id: 'http-release', jobs: [createdJob] }; let failReads = true;
  f.run("window.isSecureContext=false;window.location.origin='http://platform.test';");
  assert.equal(f.run('typeof crypto.randomUUID'), 'undefined');
  f.setFetch(async (url, options) => {
    const path = new URL(url).pathname;
    if (options.method === 'POST') posts.push(JSON.parse(options.body));
    if (!path.endsWith('/exports') && failReads) return { ok: false, status: 503, json: async () => ({ message: '记录暂不可用' }) };
    return response(path.endsWith('/exports') ? { item: createdJob, release } : path.endsWith('/releases/http-release') ? { item: release, jobs: [createdJob] } : path.endsWith('/releases') ? { items: [release] } : { items: [] });
  });
  f.run(`state.exportSource={candidate:${JSON.stringify(candidate)},artifact:${JSON.stringify(candidate.sourceArtifacts[0])}};state.capacity={available:1};`);
  for (const [id, value] of Object.entries({ 'production-mode': 'initial', 'production-architecture': 'amd64', 'production-recipient': '示例客户项目', 'production-delivery-project': '示例客户项目', 'production-purpose': '首次安装' })) f.get(id).value = value;
  await f.run("submitExport(document.getElementById('production-create-form'))");
  failReads = false; await f.run("submitExport(document.getElementById('production-create-form'))");
  assert.equal(posts.length, 1);
  assert.match(posts[0].idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(posts[0].delivery.recipient, '示例客户项目'); assert.equal(f.run('state.focusJobId'), 'http-job');
  assert.match(f.get('production-message').textContent, /已创建：http-job/);
});

test('handover shows manuals and account scope before acceptance; missing items disable acceptance but preserve rejection', async () => {
  const f = fixture(); showHandover(f, { ...handover, status: 'incomplete', missingItems: ['缺少验收前提'] });
  const elements = f.walk(f.get('production-jobs')); const content = f.get('production-jobs').textContent;
  for (const value of ['验收交接清单', '验收员', '租户：示例客户', '组织：项目组', '首次登录需改密', '进入菜单', '显示授权菜单', '尚未覆盖生产外部网络', '缺少验收前提']) assert.ok(content.includes(value));
  const links = elements.filter(element => element.tagName === 'A' && element.href?.includes('/download'));
  assert.equal(links.length, 2); assert.ok(links.every(link => /file=(operation-guide|deployment-guide)/.test(link.href)));
  assert.equal(f.requests.length, 0); const decision = f.get('decision-job-1');
  assert.equal(decision.options.find(option => option.value === 'accepted').disabled, true); assert.equal(decision.options.find(option => option.value === 'rejected').disabled, false);
  decision.value = 'rejected'; f.get('notes-job-1').value = '材料不完整'; elements.find(element => element.type === 'checkbox').checked = true;
  elements.find(element => element.tagName === 'FORM').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
  const post = f.requests.find(request => request.options.method === 'POST'); assert.match(post.url, /\/acceptance$/); const body = JSON.parse(post.options.body); assert.equal(body.decision, 'rejected'); assert.equal(body.expectedHandoverRevision, undefined);
});

test('accepted handover binds its actual revision and cannot be bypassed when missing', async () => {
  for (const complete of [true, false]) {
    const f = fixture(); showHandover(f, { ...handover, status: complete ? 'ready' : 'incomplete' });
    f.get('decision-job-1').value = 'accepted'; f.get('notes-job-1').value = '已实际核对'; const elements = f.walk(f.get('production-jobs')); elements.find(element => element.type === 'checkbox').checked = true;
    elements.find(element => element.tagName === 'FORM').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    const posts = f.requests.filter(request => request.options.method === 'POST'); assert.equal(posts.length, complete ? 1 : 0);
    if (complete) { const body = JSON.parse(posts[0].options.body); assert.equal(body.expectedHandoverRevision, 3); assert.equal(body.expectedManifestSha256, job.manifestSha256); }
    else assert.match(f.get('acceptance-message-job-1').textContent, /清单尚未齐备/);
  }
});

test('handover editor sends writable fields and transient password once, preserves saved password when unchanged', async () => {
  for (const newPassword of ['', 'one-use-secret']) {
    const f = fixture(); showHandover(f); f.walk(f.get('production-jobs')).find(element => element.textContent === '编辑验收交接清单').click();
    const form = f.walk(f.get('production-jobs')).find(element => element.className?.includes('production-handover-editor'));
    const password = labeledControl(f, form, '更新密码（留空保留）'); assert.equal(password.type, 'password'); assert.equal(password.value, ''); password.value = newPassword;
    labeledControl(f, form, '验收前提（每行一项）').value = '前提甲\n前提乙';
    const posts = []; f.setFetch(async (url, options) => { posts.push({ url: String(url), options }); return response({ item: { ...handover, revision: 4 } }); });
    form.dispatchEvent(new Event('submit', { cancelable: true })); form.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    assert.equal(posts.length, 1); const body = JSON.parse(posts[0].options.body); assert.deepEqual(body.prerequisites, ['前提甲', '前提乙']); assert.equal(body.expectedRevision, 3); assert.equal(body.accounts[0].hasPassword, undefined); assert.equal(body.accounts[0].password, newPassword || undefined); assert.equal(password.value, '');
    assert.equal(f.run("state.handovers.get('job-1').revision"), 4); assert.equal(f.run("JSON.stringify([...state.drafts.values()]).includes('one-use-secret')"), false);
  }
});

test('password is fetched only on explicit POST, never retained after hiding or timeout', async () => {
  const f = fixture(); showHandover(f); const elements = f.walk(f.get('production-jobs')); const password = elements.find(element => element.readOnly); const reveal = elements.find(element => element.tagName === 'BUTTON' && element.textContent === '查看验收密码');
  assert.equal(password.value, ''); assert.equal(password.type, 'password'); assert.equal(f.requests.length, 0);
  const calls = []; f.setFetch(async (url, options) => { calls.push({ url: String(url), options }); return response({ item: { accountId: 'account-1', username: 'verifier', password: 'transient-secret', revision: 3 } }); });
  reveal.click(); await flush(); assert.equal(password.value, 'transient-secret'); assert.equal(password.type, 'text'); assert.equal(calls[0].options.method, 'POST'); assert.match(calls[0].url, /\/handover\/credentials$/);
  const body = JSON.parse(calls[0].options.body); assert.equal(body.accountId, 'account-1'); assert.equal(body.expectedRevision, 3); assert.equal(calls[0].options.headers['x-forge-csrf-token'], 'csrf');
  reveal.click(); assert.equal(password.value, ''); assert.equal(calls.length, 1);
  reveal.click(); await flush(); for (const callback of [...f.timers.values()]) callback(); assert.equal(password.value, '');
  assert.equal(f.run("JSON.stringify([...state.handovers.values()]).includes('transient-secret')"), false);
});

test('refresh, close and tab leave clear passwords; delayed credential responses cannot reveal after leaving', async () => {
  for (const action of ['refreshData()', 'closeDetail()', 'setActive(false)', "selectView('targets')"]) for (const delayed of [false, true]) {
    const f = fixture(); showHandover(f); const elements = f.walk(f.get('production-jobs')); const password = elements.find(element => element.readOnly); const reveal = elements.find(element => element.tagName === 'BUTTON' && element.textContent === '查看验收密码'); let resolve;
    const credential = { item: { accountId: 'account-1', password: 'transient-secret', revision: 3 } };
    f.setFetch((url) => String(url).includes('/credentials') ? delayed ? new Promise(done => { resolve = done; }) : Promise.resolve(response(credential)) : Promise.resolve(response({ items: [], item: { id: 'release-1' }, jobs: [] })));
    reveal.click(); if (!delayed) { await flush(); assert.equal(password.value, 'transient-secret'); }
    await f.run(action); if (delayed) resolve(response(credential)); await flush(); assert.equal(password.value, '');
  }
});

test('handover loading rejects another package binding and a stopped environment never becomes a login link from snapshot data', async () => {
  const f = fixture(); f.setFetch(async url => response(String(url).includes('/handover') ? { item: { ...handover, jobId: 'another-job' } } : { item: { id: 'release-1' }, jobs: [job] }));
  await f.run("openRelease('release-1','job-1')"); assert.match(f.get('production-jobs').textContent, /交接清单与当前生产包不一致/); assert.equal(f.get('decision-job-1').options.find(option => option.value === 'accepted').disabled, true);
  showHandover(f, { ...handover, environment: { url: 'https://stale.test', status: 'running' } }); f.run("state.detail.jobs[0].environmentStoppedAt='2026-10-22T00:00:00Z';state.detail.jobs[0].environment.status='stopped';renderJobs()");
  assert.equal(f.walk(f.get('production-jobs')).some(element => element.tagName === 'A' && element.textContent === '打开验证环境'), false); assert.match(f.get('production-jobs').textContent, /验证环境已停止/);
});

test('historical handover state follows the actual acceptance and stopped environment', () => {
  const f = fixture(); showHandover(f);
  f.run("state.detail.jobs[0].acceptance={decision:'accepted'};state.detail.jobs[0].status='ready';renderJobs()");
  assert.match(f.get('production-jobs').textContent, /清单已绑定人工验收结论/); assert.doesNotMatch(f.get('production-jobs').textContent, /尚需人员确认/);
  f.run("state.detail.jobs[0].acceptance={decision:'rejected'};state.detail.jobs[0].status='rejected';renderJobs()");
  assert.match(f.get('production-jobs').textContent, /已有人工验收结论/); assert.doesNotMatch(f.get('production-jobs').textContent, /尚需人员确认/);
  f.run("state.detail.jobs[0].environmentStoppedAt='2026-10-22T00:00:00Z';state.detail.jobs[0].environment.status='stopped';renderJobs()");
  assert.match(f.get('production-jobs').textContent, /验证环境已停止，交接资料保留/);
});
