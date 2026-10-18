import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { generateExplicitDiagrams, withFlowDiagramNavigation } from '../docker/harness/delivery-center-diagrams.mjs';
import { buildSubview } from '../docker/harness/delivery-center-views.mjs';

const source = await readFile(new URL('../docker/harness/conversation-gateway/delivery-center.js', import.meta.url), 'utf8');
const viewSource = await readFile(new URL('../docker/harness/conversation-gateway/delivery-center-views.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../docker/harness/conversation-gateway/delivery-center.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../docker/harness/conversation-gateway/delivery-center.css', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const walk = element => [element, ...element.children.flatMap(walk)];
const visibleWalk = element => element.hidden ? [] : [element, ...element.children.flatMap(visibleWalk)];
function fixture(t, search = '?project=forge-base&tab=requirements') {
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.ownText = ''; this.hidden = false; this.value = ''; this.dataset = {}; this.open = false; }
    set textContent(value) { this.ownText = String(value); this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_value) { throw new Error('unsafe HTML injection'); }
    append(...elements) { this.children.push(...elements); }
    replaceChildren(...elements) { this.children = elements; this.ownText = ''; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    focus() { document.activeElement = this; }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatchEvent(new Event('close')); }
  }
  const nodes = new Map([...markup.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(([html, tag, id]) => {
    const element = new Element(tag); element.id = id; element.hidden = /\bhidden\b/.test(html); return [id, element];
  }));
  const tabs = [...markup.matchAll(/data-delivery-tab="([^"]+)"/g)].map(([, name]) => { const element = new Element('button'); element.dataset.deliveryTab = name; return element; });
  const document = { getElementById: id => nodes.get(id) || [...nodes.values()].flatMap(walk).find(element=>element.id===id), querySelectorAll: selector => selector === '[data-delivery-tab]' ? tabs : [], createElement: tag => new Element(tag), activeElement: null };
  const requests = []; const navigations = []; const productionCalls = []; let productionOptions; const timers = new Map(); let timerId = 0;
  const window = new EventTarget(); window.location = { search, pathname: '/forge-gateway/delivery-center', assign: path => navigations.push(path) };
  window.history = { pushState(_a, _b, url) { window.location.search = url.slice(url.indexOf('?')); }, replaceState(_a, _b, url) { window.location.search = url.slice(url.indexOf('?')); } };
  const context = vm.createContext({ document, window, URL, URLSearchParams, AbortController, Intl, Date, console, encodeURIComponent,
    setTimeout: (callback, ms) => { const id = ++timerId; timers.set(id, { callback, ms }); return id; }, clearTimeout: id => timers.delete(id),
    mountProductionDelivery: async (_root, options) => { productionOptions = options; return { setProject: async project => productionCalls.push(['project', project]), setActive: active => productionCalls.push(['active', active]), openExport: async item => productionCalls.push(['export', item]), openJob: async (release, job) => productionCalls.push(['job', release, job]), refresh: async () => productionCalls.push(['refresh']) }; },
    fetch: (url, options = {}) => new Promise(resolve => requests.push({ url, options, resolve })),
  });
  vm.runInContext(viewSource.replace(/^export /gm,'')+'\n'+source.slice(0, source.lastIndexOf('\nbindEvents();')).replace(/^import .*;\r?\n/gm,''), context);
  const run = code => vm.runInContext(code, context); run('bindEvents(); renderControls();');
  t.after(() => run('state.projectRequest?.abort();state.listRequest?.abort();artifactExportRequest?.abort();state.sharedReferenceRequest?.abort();closeDetail();clearTimeout(state.searchTimer);'));
  return { run, requests, navigations, productionCalls, productionCreated: () => productionOptions.onExportCreated(), tabs, nodes, timers, window, get: id => document.getElementById(id),
    async reply(index, value, status = 200) { requests[index].resolve(new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })); await tick(); },
    async fireSearch() { for (const [id, timer] of [...timers.entries()].filter(([, item]) => item.ms === 300)) { timers.delete(id); timer.callback(); } await tick(); },
  };
}
const menus = [{ id: 'one', name: '安全管理', path: ['安全管理'] }, { id: 'two', parentId: 'one', name: '风险管理', path: ['安全管理', '风险管理'] }, { id: 'three', parentId: 'two', name: '风险登记', path: ['安全管理', '风险管理', '风险登记'] }].map(item=>({...item,origin:'business-added'}));
const requirement = { id: 'req-one', menuId: 'three', menuPath: ['安全管理', '风险管理', '风险登记'], name: '新增风险点', description: '按业务要求登记', status: 'recorded', stageStatus: { requirements: 'accepted', backend: 'unverified' }, fields: [{ name: '风险名称', required: true }], actions: ['保存'], rules: ['名称必填'], permissions: ['风险登记'], sources: [{ batchId: 'batch-one', stageId: 'stage-one', digest: 'abc', label: '需求讨论' }], revision: 1 };

test('permission enforcement reading keeps the actual three source declarations separate and preserves the older shape', async t => {
  const parent = { assetId: 'asset-b37c2731cddd6162f241ad590f7960cf', kind: 'permission', name: '后端 · permissionEnforcement',
    revision: '9f6a00ce31333abbef8aa5412f1060d5d01188cf25e5e188311799516abfe6d8', recordType: 'permission-enforcement', sourceTopic: 'permissionEnforcement', sourcePhaseStatus: 'historical',
    sources: [{ taskId: 'c-0e254375986948ea7b361297', pointer: '/permissionEnforcement' }], details: {
      trustedFields: 'Tenant, registrar and updater identities remain sourced from trusted session context; the stock command does not accept tenantId, registrarUserId or updateBy from the client.',
      tenantAndScope: 'The repair does not bypass tenant or data-scope checks. stock(...) still calls spareDetail(spareId) before mutation, so non-existent, cross-tenant or out-of-scope spare parts fail before inventory changes.',
      serverPermissions: 'No permission annotations or access resources were changed in this backend repair. Existing fire spare-part list/add/edit/remove/stockIn/stockOut/export permissions remain the enforcement surface.',
    } };
  const before = JSON.stringify(parent); const [row] = buildSubview('permission-evidence', [parent]);
  for (const key of ['trustedFields', 'tenantAndScope', 'serverPermissions']) assert.equal(row[key], parent.details[key]);
  assert.equal(row.endpointRule, null); assert.equal(row.trustedContext, null);
  for (const key of ['implementation', 'publication', 'verification']) assert.equal(row[key], null);
  assert.equal(row.ruleRef.id, parent.assetId); assert.equal(row.ruleRef.revision, parent.revision);
  const f = fixture(t, '?project=forge-base&tab=permission-evidence&batchId=batch-228f2b518c1b93f9285e5dc511d1f58d');
  f.run(`renderRows(${JSON.stringify([row])})`);
  assert.deepEqual(f.get('delivery-table-head').children[0].children.map(cell => cell.textContent),
    ['来源声明','依据类型','权限 / 接口原文声明','可信身份原文声明','租户 / 范围原文声明','资料状态','操作']);
  const cells = f.get('delivery-table-body').children[0].children;
  assert.equal(cells[0].textContent, parent.name); assert.equal(cells[1].textContent, '阶段实现声明');
  for (const [index, key] of [[2,'serverPermissions'],[3,'trustedFields'],[4,'tenantAndScope']]) {
    assert.ok(cells[index].textContent.startsWith(parent.details[key].slice(0, 50)));
    assert.ok(cells[index].textContent.length <= 111); assert.notEqual(cells[index].textContent, parent.details[key]);
  }
  assert.match(cells[5].textContent, /阶段产物中的声明/);
  walk(cells[0]).find(element => element.tagName === 'BUTTON').click();
  assert.equal(f.requests.length, 1); assert.equal(new URL(f.requests[0].url, 'http://example').searchParams.get('revision'), parent.revision);
  await f.reply(0, { item: parent });
  const detail = f.get('delivery-detail-body').textContent;
  for (const label of ['可信身份字段原文声明','租户与数据范围原文声明','服务端权限原文声明']) assert.ok(detail.includes(label));
  for (const statement of Object.values(parent.details)) assert.ok(detail.includes(statement), 'full original statement remains in the exact detail');
  assert.match(detail, /非本次验证证明/); assert.equal(JSON.stringify(parent), before);
  const [old] = buildSubview('permission-evidence', [{ ...parent, details: { endpointRule: 'Original endpoint binding declaration', trustedContext: 'Original trusted context declaration' } }]);
  f.run(`renderRows(${JSON.stringify([old])})`);
  const legacy = f.get('delivery-table-body').children[0].children;
  assert.equal(legacy[2].textContent, 'Original endpoint binding declaration'); assert.equal(legacy[3].textContent, 'Original trusted context declaration');
  assert.equal(legacy[4].textContent, '未记录'); assert.equal(old.serverPermissions, null); assert.equal(old.trustedFields, null);
});

test('sourced flow diagram nodes locate the selected revision and keep unknown or unsafe nodes inactive', async t => {
  const sourceRef = { sourcePath: 'changes/sample/spec.md', sourceCommit: 'a'.repeat(40), line: 12 };
  const storedTask = { assetId: 'plan.process.reporting-task-generation', kind: 'task', name: '填报配置生成部门计划任务',
    revision: 'ec281df072d30502fa2126d842d7fda10f5649f3ba36f2c5ca54e3e7810ee333', sourceRevision: '7382c1514646876fc68fef2d96284090b2a98f2d', diagram: null,
    sources: [{ sourcePath: 'code-copilot/changes/delivery-center-history-plan/spec.md', sourceRevision: '7382c1514646876fc68fef2d96284090b2a98f2d', line: 805 }],
    details: { steps: [
      { name: '读取配置', result: '取得计划类型、年度、单位、截止日期、部门分配' }, { name: '校验部门分配', result: '空分配时报错' },
      { name: '生成部门计划', result: 'planType=hw 写 t_hw_dept_plan；planType=sw 写 t_sw_dept_plan；初始 version=V0、status=pending' },
      { name: '回写生成ID', result: '写入 generated_record_ids' },
    ] } };
  const storedTaskJson = JSON.stringify(storedTask); const taskReading = withFlowDiagramNavigation(storedTask);
  assert.equal(JSON.stringify(storedTask), storedTaskJson); assert.equal(taskReading.revision, storedTask.revision);
  assert.equal(taskReading.diagram.type, 'flowchart'); assert.match(taskReading.diagram.source, /N0 --> N1\n  N1 --> N2\n  N2 --> N3/);
  assert.deepEqual(taskReading.diagram.nodeTargets.map(value => value.localId), ['/details/steps/0','/details/steps/1','/details/steps/2','/details/steps/3']);
  assert.equal(withFlowDiagramNavigation({ ...storedTask, sources: [] }).diagram, null);
  assert.equal(withFlowDiagramNavigation({ ...storedTask, kind: 'table' }).diagram, null);
  assert.equal(withFlowDiagramNavigation({ ...storedTask, details: {} }).diagram, null);
  const [original] = generateExplicitDiagrams([{ assetId: 'scene-sample', kind: 'scene', name: '申请办理', revision: 'scene-r2', menuIds: ['three'], sources: [sourceRef],
    details: { steps: [{ id: 'submit', name: '提交申请', objectRef: { kind: 'entity', id: 'application', revision: 'entity-r3', name: '申请对象' } }, { id: 'review', name: '审核申请' }] } }]);
  const originalJson = JSON.stringify(original);
  const selected = withFlowDiagramNavigation(original);
  assert.deepEqual(selected.diagram.nodeTargets.map(({ nodeId, localId }) => ({ nodeId, localId })), [
    { nodeId: 'N0', localId: '/details/steps/0' }, { nodeId: 'N1', localId: '/details/steps/1' },
  ]);
  assert.equal(JSON.stringify(original), originalJson); assert.equal(selected.revision, 'scene-r2');
  assert.equal(selected.diagram.source, original.diagram.source);
  const unbound = withFlowDiagramNavigation({ ...original, diagram: { ...original.diagram, source: original.diagram.source + '\n N9["来源未明确"]', nodeTargets: [{ nodeId: 'N9', localId: '/details/steps/0' }] } });
  assert.equal(unbound.diagram.nodeTargets, undefined, 'stored or mismatching diagram links are never trusted');
  const [partlySourced] = generateExplicitDiagrams([{ ...original, sources: [], diagram: null, details: { steps: [{ id: 'a', name: '有来源步骤', source: sourceRef }, { id: 'b', name: '未明确步骤来源' }] } }]);
  assert.deepEqual(withFlowDiagramNavigation(partlySourced).diagram.nodeTargets.map(value => value.nodeId), ['N0']);
  const [ambiguous] = generateExplicitDiagrams([{ ...original, diagram: null, details: { steps: [{ id: 'a', name: '第一条' }, { id: 'a', name: '第二条' }, { id: 'b', name: '结束' }] } }]);
  assert.deepEqual(withFlowDiagramNavigation(ambiguous).diagram.nodeTargets.map(value => value.nodeId), ['N1'], 'duplicate step identities cannot guess one row');
  const [transition] = generateExplicitDiagrams([{ ...original, diagram: null, details: { transitions: [{ from: '草稿', to: '已提交', object: { kind: 'entity', id: 'application', revision: 'entity-r3' } }] } }]);
  assert.deepEqual(withFlowDiagramNavigation(transition).diagram.nodeTargets.map(value => value.localId), ['/details/transitions/0', '/details/transitions/0']);

  const f = fixture(t, '?project=forge-base&tab=scenes&menuId=three&batchId=iteration-two');
  // Native DOMParser is a browser primitive; this fixture supplies its detached geometry tree.
  // No SVG markup is ever inserted into the active document (fixture.innerHTML throws).
  f.run(`globalThis.DOMParser = class {
    parseFromString(svg, type) {
      if (type !== 'image/svg+xml' || svg !== '<svg data-fixture="flow-geometry"/>') throw new Error('unexpected renderer output');
      const root = { localName: 'svg', getAttribute: key => key === 'viewBox' ? '0 0 200 100' : null };
      const groups = ['N0','N1','N99'].map((id,index) => {
        const group = { parentNode: root, getAttribute: key => key === 'id' ? (index === 0 ? 'delivery-diagram-5-' : '') + 'flowchart-' + id + '-' + index : key === 'transform' ? 'translate(60,' + (20 + index * 30) + ')' : null };
        const rect = { parentNode: group, getAttribute: key => ({ x:'-40', y:'-10', width:'80', height:'20' })[key] ?? null };
        group.querySelector = selector => selector === 'rect' ? rect : null; return group;
      });
      root.querySelectorAll = selector => selector === 'g.node' ? groups : [];
      return { documentElement: root, querySelector: () => null };
    }
  };let diagramRenderCalls=0;diagramRenderer=async()=>({render:async()=>{diagramRenderCalls++;return {svg:'<svg data-fixture="flow-geometry"/>'}}});
  state.menus=${JSON.stringify(menus)};state.currentDetail={type:'assets',item:${JSON.stringify(selected)},view:{}};
  $('delivery-detail').showModal();renderDetail('assets',state.currentDetail.item);`);
  await tick();
  const buttons = walk(f.get('delivery-detail-body')).filter(element => element.attributes['data-diagram-node']);
  assert.equal(buttons.length, 2); assert.equal(buttons[0].attributes['data-diagram-node'], 'N0');
  assert.equal(buttons[0].attributes.style, undefined, 'strict CSP must not receive an inline style attribute');
  assert.deepEqual(buttons[0].style, { left: '10%', top: '10%', width: '40%', height: '20%' });
  assert.equal(buttons[0].attributes['aria-label'], '查看图中节点：提交申请');
  const before = f.window.location.search; buttons[0].click();
  assert.equal(f.run(`document.activeElement === state.detailAnchors.get('/details/steps/0')`), true);
  assert.equal(f.run('state.currentDetail.localId'), '/details/steps/0');
  assert.equal(f.run('state.currentDetail.item.revision'), 'scene-r2'); assert.equal(f.window.location.search, before);
  assert.equal(f.requests.length, 0, 'node navigation stays within the selected definition');
  const row = f.run(`state.detailAnchors.get('/details/steps/0')`);
  assert.match(row.textContent, /申请对象/); assert.match(row.className, /delivery-focused-record/);
  for (const directive of ['click N0 "https://example.org"', 'N0 href "javascript:alert(1)"', '%%{init: {securityLevel: "loose"}}%%']) {
    f.run(`appendDiagram($('delivery-detail-body'),${JSON.stringify({ ...selected.diagram, source: selected.diagram.source + '\n' + directive })})`);
  }
  await tick(); assert.equal(f.run('diagramRenderCalls'), 1); assert.match(f.get('delivery-detail-body').textContent, /不符合安全展示格式/);
  const reference = walk(row).find(element => element.tagName === 'BUTTON' && element.textContent.includes('申请对象'));
  assert.ok(reference); reference.click();
  assert.equal(f.requests.length, 1);
  const query = new URL(f.requests[0].url, 'http://example').searchParams;
  assert.equal(query.get('revision'), 'entity-r3'); assert.equal(query.get('menuId'), 'three'); assert.equal(query.get('batchId'), 'iteration-two');
  buttons[1].click(); assert.notEqual(f.run('state.currentDetail?.localId'), '/details/steps/1', 'stale diagram buttons do not act on another detail');
});

test('shared component references stay folded, paginate separately and preserve mixed or unknown main rows', async t => {
  const f=fixture(t,'?project=forge-base&tab=entities&menuId=three');
  f.run('loadList()');
  const main=[{assetId:'core',kind:'entity',name:'事故记录',revision:'r1'},
    {assetId:'mixed',kind:'entity',name:'混合来源对象',revision:'r1',menuReference:{classification:'mixed'}},
    {assetId:'unknown',kind:'entity',name:'用途未明确对象',revision:'r1',menuReference:{classification:'unknown'}}];
  await f.reply(0,{items:main,total:3,sharedReferences:{total:21}});
  const root=f.get('delivery-shared-references');
  assert.equal(root.open,false);assert.match(root.textContent,/共享组件引用（21）/u);
  assert.equal(f.requests.length,1,'Folded references must not load their records or bodies.');
  assert.match(f.get('delivery-table-body').textContent,/事故记录/u);assert.match(f.get('delivery-table-body').textContent,/混合来源对象/u);assert.match(f.get('delivery-table-body').textContent,/用途未明确对象/u);
  f.run('state.sharedReferenceRoot.open=true;state.sharedReferenceRoot.ontoggle();');
  const query=new URL(f.requests[1].url,'http://local').searchParams;
  assert.equal(query.get('referenceGroup'),'shared');assert.equal(query.get('menuId'),'three');assert.equal(query.get('kind'),'entity');assert.equal(query.get('page'),'1');assert.equal(query.get('pageSize'),'20');
  const shared={assetId:'user',kind:'entity',name:'用户',revision:'v1',versionId:'user-version',menuReference:{classification:'shared-component',purpose:'人员选择 <img src=x>',bindings:[{pagePath:'views/accident/report.vue',componentPath:'components/UserPicker.vue',method:'GET',path:'/system/user/page',sources:[{path:'components/UserPicker.vue',line:234,commit:'a'.repeat(40)}]}],limitations:['未确认业务采用或数据库读写']}};
  await f.reply(1,{items:[shared],total:21});
  assert.match(root.textContent,/人员选择 <img src=x>/u);assert.match(root.textContent,/components\/UserPicker.vue:234/u);assert.match(root.textContent,/未确认业务采用或数据库读写/u);
  assert.ok(!walk(root).some(element=>element.tagName==='IMG'));
  walk(root).find(element=>element.tagName==='BUTTON'&&element.textContent==='下一页共享引用').click();
  assert.equal(new URL(f.requests[2].url,'http://local').searchParams.get('page'),'2');assert.equal(f.run('state.page'),1);
  await f.reply(2,{items:[shared],total:21});
  walk(root).find(element=>element.tagName==='BUTTON'&&element.textContent==='查看对象与来源').click();
  assert.equal(new URL(f.requests[3].url,'http://local').searchParams.get('revision'),'user-version');
  assert.equal(new URL(f.requests[3].url,'http://local').searchParams.get('referenceGroup'),null);
  await f.reply(3,{item:shared});
});

test('shared component late responses cannot overwrite a changed menu or erase the primary empty state', async t => {
  const f=fixture(t,'?project=forge-base&tab=database&menuId=three');
  f.run('loadList()');await f.reply(0,{items:[],total:0,sharedReferences:{total:2}});
  assert.match(f.get('delivery-empty-help').textContent,/共享组件引用在下方/u);
  f.run('state.sharedReferenceRoot.open=true;state.sharedReferenceRoot.ontoggle();');
  f.run("state.menuId='two';loadList();");
  assert.equal(f.requests[1].options.signal.aborted,true);
  await f.reply(2,{items:[{assetId:'new',kind:'table',name:'新菜单表',revision:'r1'}],total:1,sharedReferences:{total:0}});
  await f.reply(1,{items:[{assetId:'old',kind:'table',name:'旧菜单共享表'}],total:2});
  assert.equal(f.get('delivery-shared-references').hidden,true);
  assert.match(f.get('delivery-table-body').textContent,/新菜单表/u);assert.doesNotMatch(f.get('delivery-table-body').textContent,/旧菜单共享表/u);
});

test('collected asset previews keep equal revision labels distinct and open exact branch bodies', async t => {
  const f = fixture(t, '?project=forge-base&tab=entities');
  const item = { id: 'accident', assetId: 'accident', kind: 'entity', name: '事故事件', revision: 'v1',
    versionId: 'version-a', sourceScope: 'taskspace-checkpoint', isCurrent: false, adoption: { state: 'unknown' },
    sources: [{ taskId: 'task-a', batchId: 'batch-a' }], details: {},
    readingSelection: { basis: 'checkpoint-preview', candidateCount: 2 }, revisionsHasMore: false,
    revisions: [{ revision: 'v1', versionId: 'version-a', sources: [{ taskId: 'task-a' }] },
      { revision: 'v1', versionId: 'version-z', sources: [{ taskId: 'task-z' }] }] };
  f.run(`renderRows([${JSON.stringify(item)}]); renderDetail('assets',${JSON.stringify(item)});`);
  assert.match(f.get('delivery-table-body').textContent, /工作舱资料预览/u);
  assert.match(f.get('delivery-detail-context').textContent, /已收录需求与设计/u);
  const selector = f.get('delivery-collected-revision');
  assert.deepEqual(selector.children.map(option => option.value), ['version-a', 'version-z']);
  selector.value = 'version-z';
  walk(f.get('delivery-detail-body')).find(element => element.tagName === 'BUTTON' && element.textContent === '读取这份修订').click();
  assert.equal(new URL(f.requests[0].url, 'http://local').searchParams.get('revision'), 'version-z');
  await f.reply(0, { item: { ...item, versionId: 'version-z', sources: [{ taskId: 'task-z' }] } });
  assert.equal(f.run('state.currentDetail.item.versionId'), 'version-z');
  assert.equal(f.run('state.focusRevision'), 'version-z');
  assert.equal(f.requests.length, 1, 'No batch preselection or eager body reads.');
});

test('stage declarations expose receipt limits and exact detail anchors as safe text', t => {
  const f=fixture(t,'?project=forge-base&tab=test-executions');
  const report={id:'report',assetId:'report',kind:'test',name:'阶段测试声明',revision:'r1',recordType:'test-evidence-report',sourceTopic:'redTests',sourcePhaseStatus:'accepted',status:'recorded',sources:[],details:{
    receipts:[{profile:'backend-module-test',status:'passed',receiptId:'<img src=x>',executed:2,passed:1,failed:0,skipped:1}],
    runtimeEvidenceReused:{receiptId:'old',notRevalidatedThisTurn:true},focusedTests:[{path:'Test.java',coverage:['covers approval']}],notYetProven:['production']}};
  f.run(`renderDetail('assets',${JSON.stringify(report)})`);
  const body=f.get('delivery-detail-body');assert.match(body.textContent,/来源阶段状态/);assert.match(body.textContent,/回执未经本中心单独复核/);
  assert.match(body.textContent,/历史运行证据引用（非本次执行）/);assert.match(body.textContent,/测试覆盖说明（非执行记录）/);
  assert.equal(f.run("state.detailAnchors.has('/details/receipts/0')"),true);assert.equal(f.run("state.detailAnchors.has('/details/runtimeEvidenceReused')"),true);
  assert.match(body.textContent,/<img src=x>/);assert.equal(walk(body).some(el=>el.tagName==='IMG'),false);assert.equal(f.requests.length,0);
  assert.match(f.run("deliveryTabs['test-executions'].note || deliveryTabs['test-executions'].description || JSON.stringify(deliveryTabs['test-executions'])"),/未经本中心单独复核/);
  const permission={...report,id:'perm',assetId:'perm',kind:'permission',recordType:'permission-contract',sourceTopic:'roleVisibilityContract',details:{taskHandlerRoles:{roleKeys:['ONE','TWO'],canPerform:['assigned only']},denyRules:['deny unassigned']}};
  f.run(`renderDetail('assets',${JSON.stringify(permission)})`);assert.equal(f.run("state.detailAnchors.has('/details/taskHandlerRoles')"),true);assert.match(body.textContent,/assigned only/);assert.match(body.textContent,/拒绝条件/);assert.equal(f.requests.length,0);
});

test('overview collection issues page locally with safe source locations and unchanged filters', t => {
  const f = fixture(t, '?project=forge-base&tab=requirements&menuId=three&batchId=batch-one&page=3');
  const before = f.run('JSON.stringify(readLocation())'); const url = f.window.location.search;
  const gaps = Array.from({ length: 41 }, (_, index) => ({ label: `问题 ${index + 1}` }));
  gaps[0] = { label: '<img src=x onerror=alert(1)>', sourceCommit: 'a'.repeat(40), sourcePath: 'docs/<script>.md', fenceLine: 10, line: 11, reason: 'invalid-metadata', recordIndex: 0, recovery: 'source-correction-required', recoveryMessage: '请在原对话核对该提交的文档定义；修正后正常提交。' };
  gaps[1] = { label: '历史格式失败', captureCode: 'COMMITTED_DOCUMENT_INVALID_JSON' };
  gaps[2] = '旧字符串问题';
  f.run(`renderOverview(${JSON.stringify({ coverage: { availability: 'partial', gaps } })})`);
  assert.equal(f.get('delivery-issues').hidden, false); assert.equal(f.get('delivery-issues').open, false);
  assert.equal(f.get('delivery-issues-summary').textContent, '收录问题（41）');
  assert.equal(f.get('delivery-issues-body').children.length, 20);
  const cells = f.get('delivery-issues-body').children[0].children;
  assert.match(cells[0].textContent, /<img src=x onerror=alert\(1\)>.*文档元数据无效/);
  assert.equal(cells[1].textContent, 'a'.repeat(40));
  assert.match(cells[2].textContent, /docs\/<script>\.md.*文档块起始行 10.*内容起始行 11.*第 1 条记录/);
  assert.equal(cells[3].textContent, gaps[0].recoveryMessage);
  const old = f.get('delivery-issues-body').children[1].children;
  assert.equal(old[1].textContent, '未记录'); assert.equal(old[2].textContent, '文件未记录块位置未记录');
  assert.match(old[3].textContent, /原对话核对文档格式/);
  assert.equal(f.get('delivery-issues-body').children[2].children[3].textContent, '处理方式未记录');
  assert.equal(f.get('delivery-issues-body').children[2].children[0].textContent, '旧字符串问题');
  assert.equal(walk(f.get('delivery-issues-body')).some(el => ['IMG','SCRIPT','BUTTON'].includes(el.tagName)), false);
  assert.doesNotMatch(f.get('delivery-coverage').textContent, /历史格式失败|问题 3|onerror/);
  f.get('delivery-issues').open = true;
  const click = label => walk(f.get('delivery-issues-pagination')).find(el => el.tagName === 'BUTTON' && el.textContent === label).click();
  click('下一页'); assert.equal(f.get('delivery-issues-body').children.length, 20); assert.match(f.get('delivery-issues-body').children[0].textContent, /^问题 21/);
  click('下一页'); assert.equal(f.get('delivery-issues-body').children.length, 1); assert.match(f.get('delivery-issues-pagination').textContent, /第 3 \/ 3 页/);
  click('下一页'); assert.equal(f.get('delivery-issues-body').children.length, 1);
  click('上一页'); assert.equal(f.get('delivery-issues-body').children.length, 20); assert.equal(f.get('delivery-issues').open, true);
  assert.equal(f.requests.length, 0); assert.equal(f.window.location.search, url);
  assert.equal(f.run('JSON.stringify(readLocation())'), before); assert.equal(f.run('state.page'), 3); assert.equal(f.run('state.menuId'), 'three'); assert.equal(f.run('state.batchId'), 'batch-one');
  f.run('renderOverview({})'); assert.equal(f.get('delivery-issues').hidden, true); assert.equal(f.get('delivery-issues').open, false); assert.equal(f.get('delivery-issues-body').children.length, 0);
});

test('menu checkpoint materials are discoverable without extra reads and preserve the selected batch and menu', async t => {
  const variant = { sourceScope: 'taskspace-checkpoint', isCurrent: false, batchIds: ['checkpoint-one'], sourceRevision: 'a'.repeat(40), sourceRecordedAt: '2026-10-08T10:00:00Z' };
  const scopedMenus = menus.map(item => item.id === 'three' ? { ...item, batchIds: ['legacy-one','checkpoint-one'], variants: [{ batchIds: ['legacy-one'] }, variant, { ...variant }] } : item);
  const f = fixture(t, '?project=forge-base&tab=requirements&menuId=three&adoption=adopted&nature=design');
  f.run(`state.menus=${JSON.stringify(scopedMenus)};state.menusReady=true;renderControls()`);
  assert.equal(f.requests.length,0);assert.equal(f.run('state.batchId'),'');
  assert.equal(f.get('delivery-checkpoint-batch').children.length,1);
  assert.match(f.get('delivery-scope-controls').textContent,/已收录的工作舱资料 · 1 个批次/);
  assert.match(f.get('delivery-scope-controls').textContent,/未作为项目当前定义展示/);
  assert.match(f.get('delivery-scope-controls').textContent,/采用、验收和发布仍需各自依据/);
  const loading = f.run('loadList()'); await f.reply(0,{items:[],total:0}); await loading;
  assert.match(f.get('delivery-empty-title').textContent,/该菜单另有已收录的工作舱资料/);
  const choose = label => walk(f.get('delivery-scope-controls')).find(element=>element.tagName==='BUTTON'&&element.textContent===label).click();
  choose('查看要求');
  assert.equal(f.requests.length,4); // One ordinary scope reload: list, menu directory and overview.
  let query = new URL(f.requests[1].url,'http://example').searchParams;
  assert.equal(query.get('batchId'),'checkpoint-one');assert.equal(query.get('menuId'),'three');
  assert.equal(query.has('adoption'),false);assert.equal(query.has('nature'),false);
  const scopedRequirement = {...requirement,revision:'req-checkpoint',batchIds:['checkpoint-one']};
  await f.reply(1,{items:[scopedRequirement],total:1});await f.reply(2,{items:scopedMenus});await f.reply(3,{});
  assert.match(f.get('delivery-table-body').textContent,/新增风险点/);
  assert.equal(new URLSearchParams(f.window.location.search).get('batchId'),'checkpoint-one');
  choose('查看功能');query=new URL(f.requests[4].url,'http://example').searchParams;
  assert.equal(query.get('view'),'feature-delivery');assert.equal(query.get('batchId'),'checkpoint-one');assert.equal(query.get('menuId'),'three');
  await f.reply(4,{items:[{assetId:'function-one',kind:'function',name:'风险登记',revision:'function-checkpoint'}],total:1});
  choose('查看页面');query=new URL(f.requests[5].url,'http://example').searchParams;
  assert.equal(query.get('kind'),'page');assert.equal(query.get('batchId'),'checkpoint-one');assert.equal(query.get('menuId'),'three');
  await f.reply(5,{items:[{assetId:'page-one',kind:'page',name:'登记页面',revision:'page-checkpoint'}],total:1});
  assert.match(f.get('delivery-table-body').textContent,/登记页面/);
  f.run("state.tab='batches';renderRows([{id:'checkpoint-one',name:'风险登记 · 工作舱提交'}])");
  walk(f.get('delivery-table-body')).find(element=>element.tagName==='BUTTON'&&element.textContent==='查看资料').click();
  assert.equal(f.run('state.tab'),'requirements');query=new URL(f.requests[6].url,'http://example').searchParams;
  assert.equal(query.get('batchId'),'checkpoint-one');assert.equal(query.get('menuId'),'three');assert.equal(query.has('view'),false);
  await f.reply(6,{items:[scopedRequirement],total:1});assert.equal(f.requests.length,7);

  // A parent collects existing descendant references once; a self-only scope does not.
  f.run("state.menuId='one';state.menuScope='self';renderControls()");assert.equal(f.get('delivery-checkpoint-batch'),undefined);
  f.run("state.menuScope='descendants';renderControls()");assert.equal(f.get('delivery-checkpoint-batch').children.length,1);
  f.run("state.releaseId='release-one';renderControls()");assert.equal(f.get('delivery-checkpoint-batch'),undefined);
  assert.equal(f.requests.length,7);

  const detail = fixture(t,'?project=forge-base&tab=menus&menuId=three');
  detail.run(`state.menus=${JSON.stringify(scopedMenus)};showDetail('menus',state.menus[2])`);
  assert.match(detail.get('delivery-detail-body').textContent,/已收录的工作舱资料/);
  assert.ok(detail.get('delivery-detail-checkpoint-batch'));
  assert.equal(detail.requests.length,1); // Existing current-function read only.
  await detail.reply(0,{items:[],total:0});
});

test('active conditions remain removable and a module switch cannot keep hidden adoption filters',async t=>{
  const f=fixture(t,'?project=forge-base&tab=requirements&menuId=three&adoption=adopted&nature=historical-compilation&q=金额');
  assert.match(f.get('delivery-filters').textContent,/采用情况：已明确采用/);
  assert.match(f.get('delivery-filters').textContent,/资料性质：后来整理/);
  f.run("navigateModule('pages')");
  const request=new URL(f.requests[0].url,'http://example');
  assert.equal(request.searchParams.has('adoption'),false);assert.equal(request.searchParams.get('menuId'),'three');
  assert.equal(f.run('state.adoption'),'');assert.doesNotMatch(f.get('delivery-filters').textContent,/采用情况：/);
  await f.reply(0,{items:[],total:0});
  walk(f.get('delivery-filters')).find(element=>element.getAttribute('aria-label')==='清除资料性质筛选').click();
  assert.equal(new URL(f.requests[1].url,'http://example').searchParams.has('nature'),false);
  assert.equal(f.run('state.menuId'),'three');await f.reply(1,{items:[],total:0});
  assert.ok(walk(f.get('delivery-filter-fields')).some(element=>element.id==='delivery-menu-binding'));
  const direct=fixture(t,'?project=forge-base&tab=pages&adoption=adopted');assert.equal(direct.run('queryFor().has("adoption")'),false);
});

test('menu overview reads only its first function page and restores related paging and folds after drill-down',async t=>{
  const f=fixture(t,'?project=forge-base&tab=menus&menuId=three');f.run(`state.menus=${JSON.stringify(menus)};showDetail('menus',state.menus[2])`);
  assert.equal(f.requests.length,1);let query=new URL(f.requests[0].url,'http://example').searchParams;
  assert.equal(query.get('view'),'feature-delivery');assert.equal(query.get('pageSize'),'20');assert.equal(query.get('page'),'1');assert.equal(query.get('menuId'),'three');
  const firstSections=f.get('delivery-detail-body').children.filter(element=>element.tagName==='SECTION'||element.tagName==='DETAILS');
  assert.equal(firstSections[0].children[0].textContent,'菜单业务用途与边界');assert.equal(firstSections[1].children[0].textContent,'当前功能清单');
  assert.equal(firstSections[2].tagName,'DETAILS');assert.equal(firstSections[2].open,false);
  await f.reply(0,{items:[{assetId:'f1',kind:'function',name:'登记风险',revision:'f1-v1'}],total:21});
  walk(f.get('delivery-detail-body')).find(element=>element.tagName==='BUTTON'&&element.textContent==='下一页关联').click();
  query=new URL(f.requests[1].url,'http://example').searchParams;assert.equal(query.get('page'),'2');
  await f.reply(1,{items:[{assetId:'f2',kind:'function',name:'复核风险',revision:'f2-v3'}],total:21});
  const disclosure=walk(f.get('delivery-detail-body')).find(element=>element.tagName==='DETAILS'&&element.textContent.includes('菜单原配置'));disclosure.open=true;f.get('delivery-detail').scrollTop=360;
  walk(f.get('delivery-detail-body')).find(element=>element.tagName==='BUTTON'&&element.textContent==='沿此功能核对').click();
  assert.equal(new URL(f.requests[2].url,'http://example').searchParams.get('revision'),'f2-v3');
  await f.reply(2,{item:{assetId:'f2',kind:'function',name:'复核风险',revision:'f2-v3',details:{goal:'复核登记内容'}}});
  f.get('delivery-detail-previous').click();assert.equal(f.requests.length,3);assert.equal(f.get('delivery-detail').scrollTop,360);
  assert.match(f.get('delivery-detail-body').textContent,/复核风险/);assert.ok(walk(f.get('delivery-detail-body')).some(element=>element.tagName==='BUTTON'&&element.textContent==='上一页关联'));
  assert.ok(walk(f.get('delivery-detail-body')).some(element=>element.tagName==='DETAILS'&&element.textContent.includes('菜单原配置')&&element.open));
  assert.ok(walk(f.get('delivery-detail-body')).some(element=>element.tagName==='BUTTON'&&element.textContent==='读取页面与前端'));assert.equal(f.requests.length,3);
});

test('function reading filters supported modules by declared identity and preserves exact record revisions',async t=>{
  const f=fixture(t,'?project=forge-base&tab=overview&menuId=three&batchId=batch-one');
  f.run("showDetail('assets',{assetId:'budget-function',kind:'function',revision:'function-v2'})");
  await f.reply(0,{item:{assetId:'budget-function',kind:'function',name:'录入预算金额',revision:'function-v2',details:{pageRefs:[{kind:'page',id:'budget-page',name:'预算页面',revision:'page-v4'},{kind:'page',id:'unknown-page',name:'修订未明页面',revision:null}]}}});
  f.run("navigateModule('pages')");await f.reply(1,{items:[],total:0});
  assert.equal(new URL(f.requests[1].url,'http://example').searchParams.get('functionId'),'budget-function');
  assert.equal(new URL(f.requests[1].url,'http://example').searchParams.has('functionRevision'),false);
  assert.match(f.get('delivery-filters').textContent,/正在核对功能：录入预算金额/);
  const links=walk(f.get('delivery-filters'));assert.equal(links.some(element=>element.tagName==='BUTTON'&&element.textContent.includes('修订未明页面')),false);
  links.find(element=>element.tagName==='BUTTON'&&element.textContent==='预算页面').click();
  const query=new URL(f.requests[2].url,'http://example').searchParams;
  assert.equal(query.get('revision'),'page-v4');assert.equal(query.get('batchId'),'batch-one');assert.equal(query.get('menuId'),'three');
  assert.equal(query.has('functionId'),false);assert.equal(query.has('functionRevision'),false);
  await f.reply(2,{item:{assetId:'budget-page',kind:'page',name:'预算页面',revision:'page-v4',details:{formFields:[{name:'amount',required:true}]}}});
  assert.match(f.get('delivery-detail-body').textContent,/正在核对功能：录入预算金额/);
  f.run("navigateModule('backend')");await f.reply(3,{items:[],total:0});
  assert.match(f.get('delivery-filters').textContent,/按资料中已收录的功能引用筛选/);assert.equal(f.requests.length,4);
  assert.equal(new URL(f.requests[3].url,'http://example').searchParams.get('functionId'),'budget-function');
  f.run("navigate({menuId:'two'})");assert.equal(f.run('state.readingContext'),null);assert.equal(f.run('state.functionId'),'');await f.reply(4,{items:[],total:0});
  f.run("state.readingContext={item:{kind:'function',assetId:'budget-function',name:'录入预算金额',revision:'function-v2'},refs:[]};navigate({releaseId:'release-one'})");assert.equal(f.run('state.readingContext'),null);
});

test('budget reverse references expose actual page and requirement records without inventing target revisions',async t=>{
  const f=fixture(t,'?project=forge-base&tab=overview&menuId=forge-base:menu:10442');
  const functionId='budget.function.budget-ledger-maintenance';
  const feature={assetId:functionId,kind:'function',name:'预算台账维护',revision:'function-v1',details:{businessGoal:'按单位、年度、费用科目维护预算金额、备注和附件。',observableResult:'用户可查询、新增、查看、编辑、删除预算记录。',boundaries:['不新增菜单']}};
  f.run(`showDetail('assets',${JSON.stringify(feature)})`);await f.reply(0,{item:feature});assert.equal(f.requests.length,1);
  const choose=label=>walk(f.get('delivery-detail-body')).find(element=>element.tagName==='BUTTON'&&element.textContent===label);
  choose('关联页面').click();let query=new URL(f.requests[1].url,'http://example').searchParams;
  assert.equal(query.get('functionId'),functionId);assert.equal(query.get('kind'),'page');assert.equal(query.get('menuId'),'forge-base:menu:10442');assert.equal(query.get('pageSize'),'20');assert.equal(query.has('functionRevision'),false);
  const association={id:functionId,revision:null,binding:'identity-only',refs:[{kind:'function',id:functionId,revision:null}]};
  const page={assetId:'budget.page.fee-budget',kind:'page',name:'预算和使用页面',revision:'page-v3',menuIds:['forge-base:menu:10442'],menuPaths:[],functionAssociation:association,details:{formFields:[{name:'amount',label:'预算金额',required:true}]},sources:[{path:'code-copilot/changes/ehss-budget-usage/spec.md',lines:'22,27-28,37-38',evidence:'抓取、同步数据、模拟 ERP 抓取'}]};
  await f.reply(1,{items:[page],total:1});assert.match(f.get('delivery-detail-body').textContent,/关联修订未指定/);
  choose('查看这条记录').click();query=new URL(f.requests[2].url,'http://example').searchParams;
  assert.equal(query.get('revision'),'page-v3');assert.equal(query.has('functionId'),false);assert.equal(query.has('functionRevision'),false);
  await f.reply(2,{item:page});assert.match(f.get('delivery-detail-body').textContent,/22,27-28,37-38/);assert.match(f.get('delivery-detail-body').textContent,/依据说明（不代替原文摘录）抓取、同步数据、模拟 ERP 抓取/);
  assert.match(f.get('delivery-detail-body').textContent,/未收录可共享原意摘录/);assert.match(f.get('delivery-detail-body').textContent,/预算金额/);
  f.get('delivery-detail-previous').click();assert.equal(f.requests.length,3);assert.match(f.get('delivery-detail-body').textContent,/预算和使用页面/);
  choose('关联要求').click();query=new URL(f.requests[3].url,'http://example').searchParams;assert.equal(query.get('functionId'),functionId);assert.equal(query.get('recordType'),'requirement');
  const requirement={id:'budget.requirement.non-negative-budget',name:'budget.requirement.non-negative-budget',kind:'requirement',revision:'requirement-v2',details:{statement:'预算金额不得为负数。'},functionAssociation:association};
  await f.reply(3,{items:[requirement],total:1});const associationSection=walk(f.get('delivery-detail-body')).find(element=>element.tagName==='SECTION'&&element.children[0]?.textContent==='与此功能有关的资料');
  assert.match(associationSection.textContent,/预算金额不得为负数。/);assert.doesNotMatch(associationSection.textContent,/budget.requirement.non-negative-budget/);
  choose('在需求与迭代中查看').click();query=new URL(f.requests[4].url,'http://example').searchParams;assert.equal(query.get('functionId'),functionId);
  await f.reply(4,{items:[requirement],total:1});assert.equal(f.get('delivery-table-body').children[0].children[0].textContent,'预算金额不得为负数。');assert.match(f.get('delivery-table-head').textContent,/关联功能修订/);
  walk(f.get('delivery-filters')).find(element=>element.getAttribute('aria-label')==='清除关联功能筛选').click();assert.equal(f.run('state.readingContext'),null);assert.equal(new URL(f.requests[5].url,'http://example').searchParams.has('functionId'),false);await f.reply(5,{items:[],total:0});
  f.run(`state.readingContext={item:${JSON.stringify(feature)},refs:[]};navigateModule('calls')`);assert.equal(new URL(f.requests[6].url,'http://example').searchParams.has('functionId'),false);await f.reply(6,{items:[],total:0});assert.match(f.get('delivery-filters').textContent,/本视图未按功能筛选/);
});

test('an unversioned API reference offers explicit recorded revision choices without selecting latest',async t=>{
  const f=fixture(t,'?project=forge-base&tab=pages&menuId=forge-base:menu:10442&functionId=budget.function.budget-ledger-maintenance');
  f.run("openReference({kind:'api',id:'budget.api.post-add',revision:null,name:'新增预算接口'})");
  assert.equal(f.requests.length,0);assert.match(f.get('delivery-detail-body').textContent,/目标修订未明确，未打开最新版替代/);
  walk(f.get('delivery-detail-body')).find(element=>element.tagName==='BUTTON'&&element.textContent==='读取已收录修订').click();
  let query=new URL(f.requests[0].url,'http://example').searchParams;assert.equal(query.get('view'),'history');assert.equal(query.get('recordId'),'budget.api.post-add');assert.equal(query.has('functionId'),false);assert.equal(query.has('revision'),false);
  await f.reply(0,{items:[{revision:'api-old-v1',recordedAt:'2026-10-01T00:00:00Z'},{revision:'api-new-v2',recordedAt:'2026-10-02T00:00:00Z'}],total:2});assert.equal(f.requests.length,1);
  walk(f.get('delivery-detail-body')).find(element=>element.tagName==='BUTTON'&&element.textContent==='查看修订 api-old-v1').click();query=new URL(f.requests[1].url,'http://example').searchParams;assert.equal(query.get('revision'),'api-old-v1');assert.equal(query.has('functionId'),false);assert.equal(query.has('functionRevision'),false);
  await f.reply(1,{item:{assetId:'budget.api.post-add',kind:'api',name:'新增预算接口',revision:'api-old-v1',details:{method:'POST',path:'/lead/fee/add'}}});assert.match(f.get('delivery-detail-body').textContent,/\/lead\/fee\/add/);
});

test('function filter URL restoration and correction text keep association and selected record revisions distinct',async t=>{
  const f=fixture(t,'?project=forge-base&tab=pages&menuId=forge-base:menu:10442&functionId=budget.function.budget-ledger-maintenance');
  f.run('loadList()');let query=new URL(f.requests[0].url,'http://example').searchParams;
  assert.equal(query.get('functionId'),'budget.function.budget-ledger-maintenance');assert.equal(query.has('functionRevision'),false);
  await f.reply(0,{items:[],total:0});f.run('saveLocation(true)');const restored=f.run('readLocation()');assert.equal(restored.functionId,'budget.function.budget-ledger-maintenance');assert.equal(restored.functionRevision,'');
  f.run("state.readingContext={item:{assetId:'budget.function.budget-ledger-maintenance',kind:'function',revision:'function-viewed-v4'},refs:[]}");
  const text=f.run("correctionText({assetId:'budget.page.fee-budget',kind:'page',name:'预算和使用页面',revision:'page-own-v3',sources:[{path:'spec.md',lines:'22,27-28'}]})");
  assert.match(text,/功能筛选：budget.function.budget-ledger-maintenance；按功能身份查询，关联修订未指定/);assert.match(text,/已查看功能定义：budget.function.budget-ledger-maintenance @ function-viewed-v4（阅读定位，不替代关联修订）/);assert.match(text,/"revision":"page-own-v3"/);assert.match(text,/行 22,27-28/);
  const exact=fixture(t,'?project=forge-base&tab=requirements&functionId=budget.function.budget-ledger-maintenance&functionRevision=declared-v2');exact.run('loadList()');query=new URL(exact.requests[0].url,'http://example').searchParams;assert.equal(query.get('functionRevision'),'declared-v2');await exact.reply(0,{items:[],total:0});
  assert.match(exact.run("correctionText({id:'req-one',kind:'requirement',revision:'requirement-own-v9'})"),/明确引用修订 declared-v2/);
  f.run("navigateModule('backend')");await f.reply(1,{message:'读取失败'},500);assert.equal(f.requests.length,2);assert.equal(f.get('delivery-list-error').hidden,false);assert.match(f.get('delivery-error-message').textContent,/读取失败/);assert.equal([...f.timers.values()].some(timer=>timer.ms!==300&&timer.ms!==20000),false);
});

test('release records disclose project scope while returning to requirements restores the real menu filter',async t=>{
  const f=fixture(t,'?project=forge-base&tab=releases&menuId=forge-base:menu:10442&menuScope=self&menuBinding=linked');
  f.run("state.menus=[{id:'forge-base:menu:10442',name:'预算和使用',path:['领导引领力','EHSS投入','预算和使用']}];renderControls()");
  for(const tab of ['releases','business-versions','environments']){
    f.run(`Object.assign(state,{tab:${JSON.stringify(tab)}});renderControls();loadList()`);
    const index=f.requests.length-1;const query=new URL(f.requests[index].url,'http://example').searchParams;
    for(const key of ['menuId','menuScope','menuBinding'])assert.equal(query.has(key),false,`${tab}:${key}`);
    assert.match(f.get('delivery-list-title').textContent,/项目/);assert.match(f.get('delivery-scope-note').textContent,/未按当前业务菜单筛选/);assert.match(f.get('delivery-filters').textContent,/导航菜单（不筛选发布）：领导引领力/);
    assert.doesNotMatch(f.get('delivery-filters').textContent,/层级：仅本节点|资料归属：已关联菜单/);
    assert.equal(walk(f.get('delivery-scope-controls')).some(element=>element.id==='delivery-menu-scope'),false);assert.equal(walk(f.get('delivery-filter-fields')).some(element=>element.id==='delivery-menu-binding'),false);
    await f.reply(index,{items:[],total:0});
  }
  f.run("saveLocation(true);navigateModule('requirements')");const index=f.requests.length-1;const query=new URL(f.requests[index].url,'http://example').searchParams;
  assert.equal(query.get('menuId'),'forge-base:menu:10442');assert.equal(query.get('menuScope'),'self');assert.equal(query.get('menuBinding'),'linked');
  assert.match(f.get('delivery-filters').textContent,/菜单：领导引领力/);assert.match(f.get('delivery-filters').textContent,/层级：仅本节点/);assert.doesNotMatch(f.get('delivery-filters').textContent,/导航菜单（不筛选发布）/);
  assert.doesNotMatch(f.get('delivery-scope-note').textContent,/未按当前业务菜单筛选/);await f.reply(index,{items:[],total:0});
});

test('related API summaries read existing purpose after an empty description without replacing valid false values',async t=>{
  const f=fixture(t,'?project=forge-base&tab=overview&menuId=forge-base:menu:10442');
  const feature={assetId:'budget.function.budget-ledger-maintenance',kind:'function',name:'预算台账维护',revision:'function-v1'};
  const api={assetId:'budget.api.post-add',kind:'api',name:'新增预算接口',revision:'api-v1',description:'',details:{purpose:'新增预算记录'}};
  const button=label=>walk(f.get('delivery-detail-body')).find(element=>element.tagName==='BUTTON'&&element.textContent===label);
  f.run(`showDetail('assets',${JSON.stringify(feature)})`);await f.reply(0,{item:feature});button('关联接口').click();await f.reply(1,{items:[api],total:1});
  const section=walk(f.get('delivery-detail-body')).find(element=>element.tagName==='SECTION'&&element.children[0]?.textContent==='与此功能有关的资料');
  assert.match(section.textContent,/新增预算记录/);assert.doesNotMatch(section.textContent,/用途未单独收录/);
  f.run("showDetail('menus',{id:'forge-base:menu:10442',name:'预算和使用'})");await f.reply(2,{items:[],total:0});button('读取后端接口与调用').click();await f.reply(3,{items:[api],total:1});
  const record=walk(f.get('delivery-detail-body')).find(element=>element.className==='delivery-related-record');assert.match(record.textContent,/新增预算记录/);assert.doesNotMatch(record.textContent,/用途未单独收录/);
  assert.equal(f.run("relatedMeaning({description:false,details:{purpose:'另一值'}},['description','purpose'])"),false);assert.equal(f.run("relatedMeaning({description:0,details:{purpose:'另一值'}},['description','purpose'])"),0);
});

test('an unfinished exact detail never enters the return cache as a complete definition',async t=>{
  const f=fixture(t,'?project=forge-base&tab=pages');
  f.run("showDetail('assets',{assetId:'page-pending',kind:'page',revision:'v1'})");
  f.run("dismissDetail();showDetail('assets',{assetId:'page-pending',kind:'page',revision:'v1'})");
  assert.equal(f.requests.length,2);assert.equal(f.requests[0].options.signal.aborted,true);
  await f.reply(0,{item:{assetId:'page-pending',kind:'page',name:'过期响应',revision:'v1'}});
  await f.reply(1,{item:{assetId:'page-pending',kind:'page',name:'完整定义',revision:'v1',details:{formFields:[{name:'金额'}]}}});
  assert.equal(f.get('delivery-detail-title').textContent,'完整定义');assert.match(f.get('delivery-detail-body').textContent,/金额/);
});

test('explicit evidence conclusions open their actual records and empty schema sections do not bury business facts',async t=>{
  const f=fixture(t,'?project=forge-base&tab=overview');
  const item={assetId:'function-one',kind:'function',name:'保存预算',revision:'v1',details:{goal:'保存已校验金额'},implementation:[{commit:'real-commit'}],verification:[{verdict:'failed',scope:'金额为空',actualResult:'保存被拒绝'}],publication:[]};
  f.run(`renderRows([${JSON.stringify(item)}]);renderDetail('assets',${JSON.stringify(item)})`);
  const row=f.get('delivery-table-body');assert.match(row.textContent,/有记录，结论未明确/);assert.match(row.textContent,/未通过/);assert.doesNotMatch(row.textContent,/已关联 1 项依据|已完成/);
  const body=f.get('delivery-detail-body');assert.match(body.textContent,/本条原文未单列：关联独立要求/);assert.match(body.textContent,/关联记录可通过关联查询反查/);assert.doesNotMatch(body.textContent,/尚未收录：/);
  assert.equal(walk(body).filter(element=>element.tagName==='SECTION'&&element.children[0]?.textContent==='关联独立要求').length,0);
  const facts=walk(body).find(element=>element.tagName==='SECTION'&&element.children[0]?.textContent==='采用、实现、验证与发布依据');
  walk(facts).find(element=>element.tagName==='BUTTON'&&element.textContent==='未通过').click();
  assert.equal(f.requests.length,0);assert.match(body.textContent,/金额为空.*保存被拒绝/);
  f.get('delivery-detail-previous').click();assert.equal(f.requests.length,0);assert.match(body.textContent,/保存已校验金额/);
  const nav=walk(body).find(element=>element.tagName==='NAV');walk(nav).find(element=>element.tagName==='BUTTON'&&element.textContent==='完整原文与技术资料').click();
  assert.equal(f.run('document.activeElement.tagName'),'DETAILS');assert.equal(f.run('document.activeElement.open'),true);
  assert.equal(f.run("evidenceSummary([{verdict:'passed'},{commit:'unclassified'}]).label"),'已通过；另有记录结论未明确');
  assert.equal(f.run("evidenceSummary([{status:'completed'}]).label"),'记录已结束，结果需核对');
});

test('page field tables retain recorded business meanings and limitations without inferring validation', t => {
  const f=fixture(t,'?project=forge-base&tab=pages');
  // Original rows from the read-only accident bridge index, not reconstructed UI text.
  const formFields=[
    {name:'reportType',businessMeaning:'路由类型'},
    {name:'dept/happenDate/happenTime/location/descr/immediateAction',businessMeaning:'当前空字符串载荷，无控件'},
    {name:'formData/files',businessMeaning:'当前空对象/数组，无控件'},
  ];
  // Synthetic rows exercise the same optional limitation columns; they are not business evidence.
  const item={assetId:'accident.page.report-form',kind:'page',name:'事故事件上报表单',details:{formFields,
    queryFields:[{name:'fixture-query',businessMeaning:'合成查询用途',knownLimitation:'合成查询限制'}],
    listColumns:[{name:'fixture-column',businessMeaning:'合成列表用途',knownLimitations:['合成列表限制']}],
  }};
  f.run(`renderDetail('assets',${JSON.stringify(item)})`);
  const tableRows=title=>{
    const section=walk(f.get('delivery-detail-body')).find(element=>element.tagName==='SECTION'&&element.children[0]?.textContent===title);
    const headings=walk(section).filter(element=>element.tagName==='TH').map(element=>element.textContent);
    const body=walk(section).find(element=>element.tagName==='TBODY');
    return body.children.map(row=>Object.fromEntries(row.children.map((cell,index)=>[headings[index],cell.textContent])));
  };
  const rows=tableRows('表单字段与校验');assert.equal(rows.length,3);
  for(let index=0;index<formFields.length;index+=1){
    assert.equal(rows[index]['字段名称'],formFields[index].name);
    assert.equal(rows[index]['业务含义 / 用途'],formFields[index].businessMeaning);
    for(const column of ['对应业务属性','输入方式','必填条件','可见条件','可编辑条件','校验规则','已知限制说明'])assert.equal(rows[index][column],'未记录');
  }
  assert.equal(tableRows('查询条件')[0]['业务含义'],'合成查询用途');
  assert.equal(tableRows('查询条件')[0]['已知限制说明'],'合成查询限制');
  assert.equal(tableRows('列表内容')[0]['业务含义'],'合成列表用途');
  assert.equal(tableRows('列表内容')[0]['已知限制说明'],'合成列表限制');
  assert.equal(f.requests.length,0);
});

test('all eleven modules have their required subviews and separate business columns', t => {
  const f=fixture(t);
  assert.deepEqual(f.tabs.map(tab=>tab.dataset.deliveryTab),['menus','requirements','entities','scenes','database','pages','backend','permissions','acceptance','overview','releases']);
  for(const [module,views] of Object.entries({menus:['menus','menu-matrix'],requirements:['requirements','requirement-matrix','batches','changes','sources'],entities:['entities','definitions','relations'],scenes:['scenes','processes','tasks'],database:['database','model-mappings','constraints','structure-changes'],pages:['pages','page-implementations'],backend:['backend','calls'],permissions:['permissions','permission-matrix','permission-evidence'],acceptance:['acceptance','test-cases','test-executions','issues','test-materials'],overview:['overview','stages','overview-changes','overview-issues'],releases:['releases','business-versions','artifacts','environments','production']})){
    f.run(`state.tab=${JSON.stringify(module)};renderControls()`);
    for(const view of views)assert.equal(f.run(`subviews[${JSON.stringify(module)}].includes(${JSON.stringify(view)})`),true);
    assert.ok(f.run(`deliveryTabs[${JSON.stringify(module)}].columns.length`)>=6,module);
  }
  f.run("state.tab='permissions';renderRows([])");
  assert.equal(f.get('delivery-table-head').textContent,'适用主体主体类型业务对象业务操作授权结论数据范围业务前提操作');
  f.run("state.tab='test-executions';renderRows([])");
  assert.match(f.get('delivery-table-head').textContent,/执行状态实际结果结果判定执行时间运行环境被测提交证据入口/);
});

test('menu source, modification, configuration, enabled and visible facts stay independent', async t=>{
  const f=fixture(t,'?project=forge-base&tab=menus');
  f.run(`state.menus=${JSON.stringify([{...menus[0],origin:'baseline',businessChange:'modified',runtimeConfiguration:'observed',enabled:false,visible:false},{...menus[1],origin:'baseline',businessChange:'unchanged'},{...menus[2],origin:undefined}])};state.menusReady=true;renderMenus();loadList()`);
  assert.deepEqual(JSON.parse(f.run('JSON.stringify(filteredMenus().map(item=>item.id))')),['one']);
  assert.match(f.get('delivery-table-body').textContent,/有明确业务改造.*已在运行配置中发现/);
  walk(f.get('delivery-quick-filters')).find(item=>item.tagName==='BUTTON'&&item.textContent==='待确认').click();
  assert.match(f.get('delivery-table-body').textContent,/风险登记/);assert.doesNotMatch(f.get('delivery-table-body').textContent,/安全管理/);
  walk(f.get('delivery-quick-filters')).find(item=>item.tagName==='BUTTON'&&item.textContent==='全部').click();
  assert.equal(f.run('filteredMenus().length'),3);assert.match(f.get('delivery-menu-tree').textContent,/安全管理.*风险管理.*风险登记/);
  f.run("state.menuId='one';state.menuScope='self'");assert.equal(f.run('filteredMenus().length'),1);
  f.run("state.menuScope='descendants'");assert.equal(f.run('filteredMenus().length'),3);
  f.run('renderDetail("menus",state.menus[0])');assert.match(f.get('delivery-detail-body').textContent,/初始底座已有.*有明确业务改造.*启用状态停用.*业务系统中是否显示隐藏/);
  await f.reply(0,{items:[],total:0});
  f.get('delivery-directory-scope').value='historical';f.get('delivery-directory-scope').dispatchEvent(new Event('change'));
  const url=new URL(f.requests[1].url,'http://example');assert.equal(url.searchParams.get('directoryScope'),'historical');
  await f.reply(1,{items:[]});await f.reply(2,{});
});

test('visible columns keep the identity and restore preferences without fetching or resetting pages',t=>{
  const f=fixture(t,'?project=forge-base&tab=backend&page=3');f.run('renderRows([{name:"登记人员",kind:"api",revision:"v1"}])');
  let options=walk(f.get('delivery-columns')).filter(element=>element.tagName==='LABEL');
  assert.equal(options.find(label=>label.textContent==='接口业务名称').children[0].disabled,true);
  const method=options.find(label=>label.textContent==='请求方式').children[0];assert.equal(method.checked,false);method.checked=true;method.dispatchEvent(new Event('change'));
  assert.match(f.get('delivery-table-head').textContent,/请求方式/);assert.equal(f.run('state.page'),3);assert.equal(f.requests.length,0);
  f.run("state.tab='pages';renderControls();state.tab='backend';renderControls();renderRows([])");assert.match(f.get('delivery-table-head').textContent,/请求方式/);
});

test('child row opens its exact parent revision and local field, and detail back reuses the prior object',async t=>{
  const f=fixture(t,'?project=forge-base&tab=page-implementations&menuId=three&batchId=b1&menuScope=self');
  f.run("openRecord({name:'表单实现',parentRef:{kind:'page',id:'page-one',revision:'page-old'},localId:'/details/formFields/0'})");
  const request=new URL(f.requests[0].url,'http://example');assert.match(request.pathname,/assets\/page-one$/);assert.equal(request.searchParams.get('revision'),'page-old');assert.equal(request.searchParams.get('detailMode'),'single');assert.equal(request.searchParams.get('batchId'),'b1');assert.equal(request.searchParams.get('menuScope'),'self');
  await f.reply(0,{item:{assetId:'page-one',kind:'page',name:'人员登记',revision:'page-old',details:{formFields:[{name:'姓名',required:true}]},relations:[{from:{kind:'page',id:'page-one',revision:'page-old'},to:{kind:'entity',id:'worker',revision:'entity-old',name:'人员定义'},type:'uses'}]}});
  assert.equal(f.run('document.activeElement.getAttribute("data-local-id")'),'formFields[0]');
  assert.match(f.window.location.search,/focusRevision=page-old/);assert.match(f.get('delivery-detail-body').textContent,/姓名/);
  walk(f.get('delivery-detail-body')).find(element=>element.tagName==='BUTTON'&&element.textContent==='人员定义').click();
  assert.equal(new URL(f.requests[1].url,'http://example').searchParams.get('revision'),'entity-old');
  await f.reply(1,{item:{assetId:'worker',kind:'entity',name:'人员定义',revision:'entity-old',details:{attributes:[{name:'姓名'}]}}});
  f.get('delivery-detail-previous').click();assert.equal(f.requests.length,2);assert.equal(f.get('delivery-detail-title').textContent,'人员登记');assert.equal(f.run('document.activeElement.getAttribute("data-local-id")'),'formFields[0]');
  f.run("openReference({kind:'entity',id:'unknown-version'})");assert.equal(f.requests.length,2);assert.match(f.get('delivery-detail-body').textContent,/目标修订未明确，未打开最新版替代/);
});

test('source excerpts, interpretation and adoption remain readable while private originals stay restricted',async t=>{
  const f=fixture(t,'?project=forge-base&tab=requirements&menuId=three&releaseId=r1');
  const value={...requirement,kind:'requirement',revision:'req-v3',description:'解释正文完整结尾',interpretation:'这是解释而非原文',adoption:{state:'proposed'},sources:[{sourcePath:'spec.md',section:'字段规则',line:12,revision:'src-v1',excerpt:'原意要求完整结尾',availability:'restricted',url:'https://private.invalid/thread'}]};
  f.run(`renderDetail('requirements',${JSON.stringify(value)})`);const body=f.get('delivery-detail-body');
  assert.match(body.textContent,/原意摘录.*原意要求完整结尾.*原件访问受限.*AI解释.*这是解释而非原文.*采用决定及依据/);
  assert.equal(walk(body).filter(element=>element.tagName==='A').length,0);assert.equal(f.requests.length,0);
  const input=walk(body).find(element=>element.tagName==='TEXTAREA');assert.equal(input.readOnly,true);assert.match(input.value,/发布 r1.*\n对象：新增风险点/);assert.match(input.value,/req-v3/);assert.match(input.value,/spec.md · 字段规则 · 行 12 · src-v1/);
  f.run('globalThis.copied=[];globalThis.navigator={clipboard:{writeText:async value=>copied.push(value)}}');
  walk(body).find(element=>element.tagName==='BUTTON'&&element.textContent==='复制纠偏上下文').click();await tick();assert.equal(f.run('copied.length'),1);assert.equal(f.requests.length,0);
});

test('documented release changes stay separate from validated scope and keep long explanations collapsed', t=>{
  const f=fixture(t,'?project=forge-base&tab=releases');
  const changes=Array.from({length:12},(_,index)=>({id:`change-${index}`,revision:`r${index}`,status:'documented',name:`业务变化 ${index+1}`,changeType:'added',menuNames:['事故管理'],before:`原有方式 ${'甲'.repeat(180)}`,after:{summary:`新增方式 ${'乙'.repeat(180)}`},description:`来源长说明 ${'丙'.repeat(300)}`,sources:[{path:'docs/release.md',line:80+index,commit:'b'.repeat(40)}],provenance:{recordRef:{kind:'requirement',id:`change-${index}`,revision:`r${index}`},nature:'historical-compilation',sourceCommit:'b'.repeat(40),sourcePath:'docs/release.md'}}));
  const release={id:'release-one',version:'本次发布',status:'success',commit:'a'.repeat(40),scopeBinding:'unknown',scopeBindingReason:'NO_VALIDATED_TASK_SNAPSHOT',scopeBindingDiagnostic:'PHASE_DELIVERY_NOT_COMPLETED',requirementSnapshots:[],documentedChanges:changes,documentedChangeCount:12};
  const listItem={...release,documentedChanges:undefined,documentedChangePreview:changes.slice(0,3).map(({id,revision,name})=>({id,revision,name}))};
  for(const tab of ['releases','business-versions']){
    f.run(`state.tab=${JSON.stringify(tab)};renderRows([${JSON.stringify(listItem)}]);`);
    const row=f.get('delivery-table-body').textContent;
    assert.match(row,/已记录 12 项：业务变化 1、业务变化 2等/);assert.doesNotMatch(row,/业务变化 3|共 3 项|原有方式|新增方式|来源长说明/);assert.ok(row.length<500);
  }
  f.run(`renderDetail('releases',${JSON.stringify(release)})`);
  const body=f.get('delivery-detail-body');const section=walk(body).find(element=>element.tagName==='SECTION'&&element.children[0]?.textContent==='已记录的业务变化说明');
  assert.ok(section);assert.match(section.textContent,/与已验证任务交付范围独立/);assert.match(section.textContent,/事后追溯/);
  assert.match(body.textContent,/完整发布范围尚无充分依据/);assert.match(body.textContent,/尚未形成完整阶段交付快照/);
  assert.equal(walk(body).some(element=>element.tagName==='SECTION'&&element.children[0]?.textContent==='有依据的功能范围'),false);
  const row=walk(section).find(element=>element.tagName==='TR'&&element.children[0]?.tagName==='TD');
  assert.equal(row.children[1].textContent,'新增');assert.equal(row.children[2].textContent,'事故管理');
  assert.ok(row.children[3].children[0].textContent.length<=90);assert.ok(row.children[4].children[0].textContent.length<=90);
  for(const cell of [row.children[3],row.children[4]]){const expansion=cell.children.find(element=>element.tagName==='DETAILS');assert.ok(expansion);assert.equal(expansion.open,false);}
  assert.match(row.children[6].textContent,/说明来源提交（非发布提交）/);
  assert.ok(walk(body).some(element=>element.tagName==='BUTTON'&&element.textContent==='查看本发布需求范围'));
  assert.ok(walk(body).some(element=>element.tagName==='BUTTON'&&element.textContent==='查看本发布制品'));
  const validated={...release,scope:'validated-task-delivery',scopeBinding:'partial',scopeBindingDiagnostic:null,requirementSnapshots:[{name:'原任务已绑定要求',revision:'validated-r1'}]};
  f.run(`renderDetail('releases',${JSON.stringify(validated)})`);
  const scope=walk(body).find(element=>element.tagName==='SECTION'&&element.children[0]?.textContent==='有依据的功能范围');
  assert.match(scope.textContent,/原任务已绑定要求/);assert.doesNotMatch(scope.textContent,/业务变化/);assert.match(body.textContent,/本次任务交付范围，不是全项目完整功能快照/);
  assert.equal(f.requests.length,0);
});

test('documented release source links open exact revisions outside frozen filters without changing list scope', async t=>{
  const f=fixture(t,'?project=forge-base&tab=releases&menuId=other-menu&releaseId=release-one');
  const changes=['r1','r2'].map(revision=>({id:'same-change',revision,status:'documented',name:'同一业务变化',before:'原流程',after:'调整流程',provenance:{recordRef:{kind:'requirement',id:'same-change',revision},nature:'historical-compilation',sourceCommit:'b'.repeat(40),sourcePath:'docs/release.md'}}));
  const release={id:'release-one',version:'历史发布',scopeBinding:'unknown',documentedChanges:changes,documentedChangeCount:2};
  f.run(`state.currentDetail={type:'releases',item:${JSON.stringify(release)}};renderDetail('releases',${JSON.stringify(release)})`);
  const originalUrl=f.window.location.search;
  const table=walk(f.get('delivery-detail-body')).find(element=>element.tagName==='SECTION'&&element.children[0]?.textContent==='已记录的业务变化说明');
  const rows=walk(table).filter(element=>element.tagName==='TR'&&element.children[0]?.tagName==='TD');
  assert.notEqual(rows[0].getAttribute('data-local-id'),rows[1].getAttribute('data-local-id'));
  const buttons=walk(table).filter(element=>element.tagName==='BUTTON'&&element.textContent.startsWith('查看说明修订'));
  assert.deepEqual(buttons.map(element=>element.textContent),['查看说明修订 r1','查看说明修订 r2']);
  buttons[1].click();
  let url=new URL(f.requests[0].url,'http://local');assert.match(url.pathname,/\/requirements\/same-change$/);assert.equal(url.searchParams.get('revision'),'r2');
  for(const key of ['menuId','menuScope','menuBinding','batchId','releaseId'])assert.equal(url.searchParams.has(key),false);
  await f.reply(0,{item:{id:'same-change',kind:'requirement',revision:'r2',name:'后续说明',recordType:'release-change',nature:'historical-compilation',description:'精确 r2 原文'}});
  assert.equal(f.run('state.currentDetail.item.revision'),'r2');assert.equal(f.run('state.menuId'),'other-menu');assert.equal(f.run('state.releaseId'),'release-one');assert.equal(f.window.location.search,originalUrl);
  assert.match(f.get('delivery-detail-context').textContent,/变化说明来源（独立于发布验证范围）/);
  buttons[0].click();url=new URL(f.requests[1].url,'http://local');assert.equal(url.searchParams.get('revision'),'r1');
  await f.reply(1,{item:{id:'same-change',kind:'requirement',revision:'r1',name:'原说明',recordType:'release-change',nature:'historical-compilation'}});
  assert.equal(f.run('state.currentDetail.item.revision'),'r1');assert.equal(f.window.location.search,originalUrl);assert.equal(f.requests.length,2);
});

test('immutable release identifiers open their own attempt even when no separate definition revision exists',async t=>{
  const f=fixture(t,'?project=forge-base&tab=business-versions');
  f.run("openRecord({name:'九月生产版本',parentRef:{kind:'release',id:'release-20260920',revision:null}})");
  assert.match(f.requests[0].url,/\/releases\/release-20260920\?/);assert.equal(new URL(f.requests[0].url,'http://example').searchParams.has('revision'),false);
  await f.reply(0,{item:{id:'release-20260920',version:'九月生产版本',status:'failed',scopeBinding:'unknown',components:[{name:'前端',commit:'actual-front-commit'},{name:'后端',commit:'actual-back-commit'}],rollbacks:[{from:'九月生产版本',to:'旧版本',code:'已回退',database:'未确认'}]}});
  const body=f.get('delivery-detail-body');assert.match(body.textContent,/完整发布范围尚无充分依据/);
  const componentTable=walk(body).find(element=>element.tagName==='SECTION'&&element.children[0]?.textContent==='组件与实际制品');
  const values=walk(componentTable).filter(element=>element.tagName==='TD').map(element=>element.textContent);assert.ok(values.includes('actual-front-commit'));assert.ok(values.includes('actual-back-commit'));
  assert.match(body.textContent,/回滚依据.*代码回退.*数据库回退.*已回退.*未确认/);
  assert.equal(f.requests.length,1);
});

test('permission matrix preserves multiple rules, unknown cells and dynamic column selection',async t=>{
  const f=fixture(t,'?project=forge-base&tab=permission-matrix');const pending=f.run('loadList()');
  await f.reply(0,{columns:[{id:'save',name:'保存'},{id:'delete',name:'删除'}],items:[{id:'role-a',subject:'班组长',subjectType:'role',cells:[{operationId:'save',decision:'allow',ruleRef:{kind:'permission',id:'rule-a',revision:'old',localId:'/details/rules/0'}},{operationId:'save',decision:'conditional',ruleRef:{kind:'permission',id:'rule-b',revision:'v2'}}]}],total:1});await pending;
  assert.match(f.get('delivery-table-head').textContent,/主体主体类型保存删除操作/);assert.match(f.get('delivery-table-body').textContent,/允许条件允许未明确/);assert.doesNotMatch(f.get('delivery-table-body').textContent,/明确禁止/);
  const save=walk(f.get('delivery-columns')).find(element=>element.tagName==='LABEL'&&element.textContent==='保存');assert.ok(save);save.children[0].checked=false;save.children[0].dispatchEvent(new Event('change'));assert.doesNotMatch(f.get('delivery-table-head').textContent,/保存/);
  save.children[0].checked=true;save.children[0].dispatchEvent(new Event('change'));
  walk(f.get('delivery-table-body')).find(element=>element.tagName==='BUTTON'&&element.textContent==='允许').click();assert.equal(new URL(f.requests[1].url,'http://example').searchParams.get('revision'),'old');
  await f.reply(1,{item:{id:'rule-a',kind:'permission',name:'保存权限',revision:'old',details:{rules:[{subject:'班组长',operation:'保存'}]}}});
});

test('matrix export requests the entire selected scope and rejects non-CSV or explicit failures',async t=>{
  const f=fixture(t,'?project=forge-base&tab=requirement-matrix&menuId=three&menuScope=self&releaseId=r1&q=姓名&page=2&pageSize=50&adoption=adopted');
  f.run("state.listScope={snapshotDigest:'snapshot-one'}");const pending=f.run('exportMatrix()');
  const query=new URL(f.requests[0].url,'http://example').searchParams;
  assert.equal(query.get('view'),'requirement-matrix');assert.equal(query.get('snapshotDigest'),'snapshot-one');assert.equal(query.get('menuScope'),'self');assert.equal(query.get('adoption'),'adopted');assert.equal(query.get('releaseId'),'r1');assert.equal(query.get('q'),'姓名');assert.equal(query.has('page'),false);assert.equal(query.has('projection'),false);
  f.requests[0].resolve(new Response('菜单,功能,要求\n风险登记,登记风险,姓名必填',{headers:{'content-type':'text/csv;charset=utf-8'}}));await pending;
  assert.match(f.get('delivery-export-status').textContent,/已生成下载.*不限当前页或可见列/);assert.equal(f.run('state.exportRequest'),null);
  const error=f.run('exportMatrix()');await f.reply(1,{message:'导出范围过大，请缩小筛选'},413);await error;assert.equal(f.get('delivery-export-status').textContent,'导出范围过大，请缩小筛选');
  const wrong=f.run('exportMatrix()');await f.reply(2,{items:[]});await wrong;assert.match(f.get('delivery-export-status').textContent,/未返回CSV/);assert.doesNotMatch(f.get('delivery-export-status').textContent,/已生成/);
  const changed=f.run('exportMatrix()');await f.reply(3,{message:'资料范围已变化，请重新读取后导出',code:'DELIVERY_SCOPE_CHANGED'},409);await changed;assert.match(f.get('delivery-export-status').textContent,/资料范围已变化/);assert.doesNotMatch(f.get('delivery-export-status').textContent,/已生成/);
});

test('zero independent definitions and formal test records retain direct routes to existing source materials',async t=>{
  for(const tab of ['requirements','overview','acceptance']){
    const f=fixture(t,`?project=forge-base&tab=${tab}&menuId=three&adoption=adopted&origin=business-added`);const pending=f.run('loadList()');await f.reply(0,{items:[],total:0});await pending;
    const label=tab==='acceptance'?'查看原始测试资料':'查看当前范围来源资料';
    const button=walk(f.get('delivery-empty-actions')).find(element=>element.tagName==='BUTTON'&&element.textContent===label);assert.ok(button,tab);
    if(tab!=='acceptance')assert.match(f.get('delivery-empty-help').textContent,/尚无已整理|尚未整理为独立/);
    button.click();const query=new URL(f.requests[1].url,'http://example').searchParams;assert.equal(query.get('menuId'),'three');assert.equal(query.get('recordType'),null);
    if(tab==='acceptance')assert.equal(query.get('kind'),'test');else{assert.equal(query.get('view'),'requirements-sources');assert.equal(query.get('adoption'),null);assert.equal(query.get('origin'),null);}await f.reply(1,{items:[],total:0});
  }
});

test('default view retains every server-authorized project and preserves shared read access', async t => {
  const f = fixture(t, ''); const pending = f.run('initialize()');
  await f.reply(0, { user: { role: 'auditor', username: 'reader', displayName: '业务人员', projectMemberships: [] } });
  await f.reply(1, { items: [{ slug: 'forge-base', name: '示例客户', canEnter: false }, { slug: 'other', name: '其他项目', canEnter: true }] });
  await f.reply(2, { items: menus }); await f.reply(3, { counts: { requirements: 1 }, coverage: { message: '历史来源尚未全部收录' } }); await pending;
  assert.equal(f.get('delivery-project').children.length, 2); assert.equal(f.get('delivery-project').disabled, false);
  assert.deepEqual(f.get('delivery-project').children.map(option => option.value), ['forge-base', 'other']);
  assert.equal(f.get('delivery-project-subtitle').textContent, '示例客户 · 业务功能与交付过程');
  assert.equal(f.run('state.tab'), 'menus'); assert.match(f.get('delivery-table-body').textContent, /安全管理.*风险管理.*风险登记/);
  assert.match(f.get('delivery-coverage').textContent, /尚未全部收录/);
  assert.equal(f.tabs[0].dataset.deliveryTab, 'menus');
  assert.ok(f.requests.every(request => !request.options.method || request.options.method === 'GET'));
  assert.doesNotMatch(markup, /新增需求|删除需求|保存修改/);assert.match(markup,/delivery-export/);
});

test('project selection preserves the requested actual slug and updates center identity and production navigation', async t => {
  const f = fixture(t, '?project=demo-bilingual-phase2-32148'); const pending = f.run('initialize()');
  await f.reply(0, { user: { username: 'reader' } });
  await f.reply(1, { items: [{ slug: 'foundation-32148', displayName: '基础项目' }, { id: 'demo-bilingual-phase2-32148', name: '示例客户项目' }] });
  await f.reply(2, { items: [] }); await f.reply(3, { counts: {} }); await pending;
  assert.equal(f.run('state.project'), 'demo-bilingual-phase2-32148');
  assert.equal(f.get('delivery-project').value, 'demo-bilingual-phase2-32148');
  assert.equal(f.get('delivery-project-subtitle').textContent, '示例客户项目 · 业务功能与交付过程');
  assert.equal(f.get('delivery-title').textContent, '示例客户项目 · 需求与交付中心');
  assert.match(f.run('document.title'), /示例客户项目/);
  assert.equal(f.get('delivery-reader-panel').hidden, false);
  for (const request of f.requests.slice(2)) assert.equal(new URL(request.url, 'http://example').searchParams.get('project'), 'demo-bilingual-phase2-32148');
  f.get('delivery-project').value = 'foundation-32148'; f.get('delivery-project').dispatchEvent(new Event('change'));
  await f.reply(4, { items: [] }); await f.reply(5, { counts: {} });
  assert.equal(f.get('delivery-project-subtitle').textContent, '基础项目 · 业务功能与交付过程');
  for (const id of ['delivery-brand', 'delivery-back']) {
    assert.equal(new URL(f.get(id).href, 'http://example').searchParams.get('project'), 'foundation-32148');
  }
  assert.doesNotMatch(markup, /href="\/forge-gateway\/production-delivery/);
  assert.equal(new URLSearchParams(f.window.location.search).get('project'), 'foundation-32148');
});

test('unavailable project is never requested and empty server projects leave production navigation hidden', async t => {
  for (const items of [[{ projectKey: 'foundation-32148', name: '基础项目' }], []]) {
    const f = fixture(t, '?project=unknown&menuId=foreign&releaseId=old-release'); const pending = f.run('initialize()');
    await f.reply(0, { user: { username: 'reader' } }); await f.reply(1, { items });
    if (items.length) { await f.reply(2, { items: [] }); await f.reply(3, { counts: {} }); }
    await pending;
    assert.equal(f.run('state.project'), items.length ? 'foundation-32148' : '');
    assert.equal(f.run('state.menuId'), ''); assert.equal(f.run('state.releaseId'), '');
    assert.equal(f.get('delivery-reader-panel').hidden, false);
    assert.equal(f.get('delivery-project').disabled, true);
    assert.ok(f.requests.every(request => !request.url.includes('unknown') && !request.url.includes('old-release') && !request.url.includes('foreign')));
    if (!items.length) { assert.equal(f.requests.length, 2); assert.equal(f.get('delivery-back').href, '/forge-gateway/'); }
  }
});

test('artifacts own production navigation without menu filtering and restore menus on other views', async t => {
  const f = fixture(t, '?project=foundation-32148&tab=artifacts&menuId=three&menuScope=self&menuBinding=linked');
  for (const tab of ['releases', 'business-versions', 'artifacts', 'environments', 'production']) {
    f.run(`state.tab='${tab}';renderControls()`);
    assert.equal(f.get('delivery-menu-panel').hidden, true, tab); assert.equal(f.get('delivery-context').hidden, true, tab);
    for (const key of ['menuId', 'menuScope', 'menuBinding']) assert.equal(f.run(`queryFor().has('${key}')`), false, `${tab}:${key}`);
    assert.doesNotMatch(f.get('delivery-list-help').textContent + f.get('delivery-scope-note').textContent, /菜单只保留作阅读导航|当前菜单仅作导航/);
  }
  f.run("state.tab='artifacts';renderControls()");
  assert.equal(f.get('delivery-menu-panel').hidden, true); assert.equal(f.get('delivery-context').hidden, true);
  assert.equal(f.get('delivery-reader-panel').hidden, false);
  assert.equal(f.get('delivery-menu-scope'), undefined); assert.equal(f.get('delivery-menu-binding'), undefined);
  assert.doesNotMatch(f.get('delivery-filters').textContent, /菜单|层级|资料归属/);
  assert.doesNotMatch(f.get('delivery-scope-note').textContent, /菜单只保留作阅读导航/);
  assert.match(f.get('delivery-list-help').textContent, /导出生产包.*生产发布包与上线.*离线包/);
  const pending = f.run('loadList()');
  const query = new URL(f.requests[0].url, 'http://example').searchParams;
  for (const key of ['menuId', 'menuScope', 'menuBinding']) {
    assert.equal(query.has(key), false); assert.equal(f.run(`detailQuery().has('${key}')`), false);
  }
  await f.reply(0, { items: [], total: 0 }); await pending;
  const switched = f.run("navigate({tab:'requirements'})");
  assert.equal(f.get('delivery-menu-panel').hidden, false); assert.equal(f.get('delivery-context').hidden, false);
  assert.equal(f.get('delivery-reader-panel').hidden, false);
  assert.equal(new URL(f.requests[1].url, 'http://example').searchParams.get('menuId'), 'three');
  await f.reply(1, { items: [], total: 0 }); await switched;
  const navigation = markup.slice(markup.indexOf('<aside'), markup.indexOf('</aside>'));
  assert.doesNotMatch(navigation, /delivery-production-link/);
  assert.match(styles, /delivery-workspace-layout:has\(> \.delivery-sidebar\[hidden\]\)/);
});

test('choosing an unknown-origin menu reveals that node without overriding later explicit menu presets', t => {
  const f=fixture(t,'?project=forge-base&tab=menus');
  const item={id:'forge-base:menu:10442',name:'预算和使用',path:['环保管理','预算和使用'],origin:'unknown'};
  f.run(`state.menus=[${JSON.stringify(item)}];state.menusReady=true;renderMenus();loadList()`);
  assert.equal(f.run('state.menuPreset'),'attention');assert.equal(f.run('state.total'),0);
  walk(f.get('delivery-menu-tree')).find(element=>element.getAttribute('data-menu-select')===item.id).click();
  assert.equal(f.run('state.menuPreset'),'all');assert.equal(f.run('state.total'),1);assert.equal(f.run('state.menus[0].origin'),'unknown');
  assert.match(f.get('delivery-table-body').textContent,/预算和使用/);assert.match(f.get('delivery-context').textContent,/环保管理.*预算和使用/);
  let query=new URLSearchParams(f.window.location.search);assert.equal(query.get('menuId'),item.id);assert.equal(query.get('menuPreset'),'all');
  assert.doesNotMatch(f.get('delivery-filters').textContent,/关注需求迭代/);assert.equal(f.get('delivery-detail').open,false);assert.equal(f.requests.length,0);
  walk(f.get('delivery-quick-filters')).find(element=>element.tagName==='BUTTON'&&element.textContent==='原生底座').click();
  assert.equal(f.run('state.menuPreset'),'baseline');assert.equal(f.run('state.total'),0);assert.match(f.get('delivery-filters').textContent,/菜单视图：原生底座/);
  f.run('renderControls()');assert.equal(f.run('state.menuPreset'),'baseline');
  walk(f.get('delivery-filters')).find(element=>element.getAttribute('aria-label')==='清除菜单视图筛选').click();
  assert.equal(f.run('state.menuPreset'),'all');assert.equal(f.run('state.total'),1);
  walk(f.get('delivery-filters')).find(element=>element.getAttribute('aria-label')==='清除菜单筛选').click();
  query=new URLSearchParams(f.window.location.search);assert.equal(query.has('menuId'),false);assert.equal(query.get('menuPreset'),'all');
  assert.equal(f.get('delivery-context').textContent,'全部业务菜单');assert.equal(f.run('state.menus[0].origin'),'unknown');assert.equal(f.requests.length,0);
});

test('budget source goals results boundaries and menu identities stay readable without inventing adoption',async t=>{
  const f=fixture(t,'?project=forge-base&tab=pages');
  const menu={id:'forge-base:menu:10442',name:'预算和使用',path:['EHSS费用管理','预算和使用']};
  const page={assetId:'budget.page.fee-budget',kind:'page',name:'预算和使用页面',menuPaths:[],menuIds:[menu.id]};
  f.run(`state.menus=[${JSON.stringify(menu)}];renderRows([${JSON.stringify(page)}])`);
  assert.match(f.get('delivery-table-body').textContent,/EHSS费用管理.*预算和使用/);assert.doesNotMatch(f.get('delivery-table-body').textContent,/未明确菜单归属/);
  assert.equal(f.run("get({menuPaths:[],menuIds:['retained-id']},'menuPaths|menuIds').length"),0,'generic get semantics are preserved');
  const feature={assetId:'budget.function.budget-ledger-maintenance',kind:'function',name:'EHSS预算记录维护',revision:'budget-recorded-v1',adoption:{state:'unknown'},details:{businessGoal:'按单位、年度、费用科目维护预算金额、备注和附件，并在列表中查看预算与实际使用金额。',observableResult:'用户可查询、新增、查看、编辑、删除预算记录；新增时创建人和单位由当前登录上下文补齐，实际使用金额初始为0。',boundaries:['不新增独立 EHSS 模块','不接入真实 ERP','不新增菜单']}};
  f.run(`renderDetail('assets',${JSON.stringify(feature)})`);
  const overview=walk(f.get('delivery-detail-body')).find(element=>element.tagName==='SECTION'&&element.className.includes('delivery-detail-overview'));
  const labels=walk(overview).filter(element=>element.tagName==='DT').map(element=>element.textContent);
  assert.ok(labels.includes('业务目标'));assert.ok(labels.includes('可观察结果'));assert.ok(labels.includes('业务边界'));
  assert.match(overview.textContent,/实际使用金额初始为0/);assert.match(overview.textContent,/不接入真实 ERP/);
  assert.match(f.get('delivery-detail-body').textContent,/采用情况未明确/);assert.doesNotMatch(f.get('delivery-detail-body').textContent,/已明确采用|已完成/);
  f.run(`showDetail('menus',${JSON.stringify(menu)})`);assert.equal(f.requests.length,1);
  await f.reply(0,{items:[feature],total:1});
  const related=walk(f.get('delivery-detail-body')).find(element=>element.className==='delivery-related-record');
  assert.match(related.textContent,/按单位、年度、费用科目维护预算金额/);assert.doesNotMatch(related.textContent,/用途未单独收录/);
});

test('scene source participants and normal results survive summary and exact detail without inventing goals or initiators', async t => {
  const { deliverySummary, summaryDetailKeys } = await import('../docker/harness/delivery-center-views.mjs');
  const f = fixture(t, '?project=forge-base&tab=scenes');
  // Mechanical excerpt from plan spec at 7382c151, line 805, /records/4.
  const scene = {
    assetId:'plan.scene.config-generate-reporting-tasks', kind:'scene', name:'填报配置生成任务业务场景',
    revision:'98e3d260911c9f8096cb8f2fb3160ec1c48154eda6ad432aa8f9e38b52c7d653', nature:'implementation-observation',
    details:{actor:'有配置新增/生成权限的管理人员；具体业务岗位未知',preconditions:['配置包含计划类型、年度、单位','至少存在一个部门分配'],normalResult:'按部门分配生成 V0/pending 部门计划，生成 ID 写回配置 generatedRecordIds，页面提示生成数量。'},
    relations:[{type:'uses-process',to:{kind:'task',id:'plan.process.reporting-task-generation',revision:null},conditions:'点击生成任务或保存并生成任务时'}],
    adoption:{state:'unknown'}, sources:[{sourcePath:'code-copilot/changes/delivery-center-history-plan/spec.md',line:805,commit:'7382c1514646876fc68fef2d96284090b2a98f2d'}],
  };
  assert.ok(summaryDetailKeys().includes('actor')); assert.ok(summaryDetailKeys().includes('normalResult'));
  const summary = deliverySummary(scene);
  assert.equal(summary.details.actor,scene.details.actor); assert.equal(summary.details.normalResult,scene.details.normalResult);
  f.run('loadList()');
  const query = new URL(f.requests[0].url,'http://local').searchParams;
  assert.equal(query.get('kind'),'scene'); assert.equal(query.get('projection'),'summary');
  await f.reply(0,{items:[summary],total:1});
  const headings = walk(f.get('delivery-table-head')).filter(element=>element.tagName==='TH').map(element=>element.textContent);
  const row = Object.fromEntries(f.get('delivery-table-body').children[0].children.map((cell,index)=>[headings[index],cell.textContent]));
  assert.equal(row['参与角色'],scene.details.actor); assert.equal(row['正常结果'],scene.details.normalResult);
  assert.equal(row['业务目标'],'未记录'); assert.equal(row['发起角色'],'未记录'); assert.equal(row['触发条件'],'未记录');
  walk(f.get('delivery-table-body')).find(element=>element.tagName==='BUTTON'&&element.textContent==='查看详情').click();
  assert.equal(new URL(f.requests[1].url,'http://local').searchParams.get('revision'),scene.revision);
  await f.reply(1,{item:scene});
  const overview = () => walk(f.get('delivery-detail-body')).find(element=>element.tagName==='SECTION'&&element.className.includes('delivery-detail-overview'));
  const labels=walk(overview()).filter(element=>element.tagName==='DT').map(element=>element.textContent);
  assert.ok(labels.includes('参与角色')); assert.ok(labels.includes('正常结果')); assert.ok(!labels.includes('业务目标')); assert.ok(!labels.includes('发起人'));
  assert.ok(overview().textContent.includes(scene.details.actor)); assert.ok(overview().textContent.includes(scene.details.normalResult));
  assert.match(f.get('delivery-detail-body').textContent,/采用情况未明确/);
  assert.ok(walk(f.get('delivery-detail-body')).some(element=>element.tagName==='BUTTON'&&element.textContent==='查看已收录修订'));
  assert.equal(f.requests.length,2,'an unspecified process revision does not trigger a latest-version read');
  // Long-content rendering uses repeated source text only as a boundary fixture.
  const longScene={...scene,details:{...scene.details,normalResult:scene.details.normalResult.repeat(8)}};
  f.run(`renderRows([${JSON.stringify(deliverySummary(longScene))}]);renderDetail('assets',${JSON.stringify(longScene)})`);
  const resultCell=f.get('delivery-table-body').children[0].children[headings.indexOf('正常结果')];
  assert.ok(resultCell.textContent.length<=110); assert.ok(overview().textContent.includes(longScene.details.normalResult));
  // Compatibility fixture: the initiating role and participating roles are distinct facts.
  const pluralScene={...scene,initiator:'申请人',details:{...scene.details,actors:['配置管理人员','部门填报人员']}};
  delete pluralScene.details.actor;
  assert.ok(summaryDetailKeys().includes('actors'));
  const pluralSummary=deliverySummary(pluralScene);
  assert.deepEqual(pluralSummary.details.actors,pluralScene.details.actors);
  f.run(`renderRows([${JSON.stringify(pluralSummary)}]);renderDetail('assets',${JSON.stringify(pluralScene)})`);
  const pluralRow=Object.fromEntries(f.get('delivery-table-body').children[0].children.map((cell,index)=>[headings[index],cell.textContent]));
  assert.equal(pluralRow['发起角色'],'申请人'); assert.equal(pluralRow['参与角色'],'配置管理人员、部门填报人员');
  assert.ok(overview().textContent.includes('配置管理人员')); assert.ok(overview().textContent.includes('部门填报人员'));
  assert.ok(!overview().textContent.includes('申请人'),'the initiator is not used as a participant fallback');
});

test('matrix renders one hierarchical menu path and counts only separate paths', t => {
  const f=fixture(t,'?project=forge-base&tab=requirement-matrix');
  const path=['领导引领力','EHSS投入','预算和使用'];
  const render=row=>{f.run(`renderRows([${JSON.stringify({id:'matrix-budget',...row})}])`);return f.get('delivery-table-body').children[0].children[0].textContent;};
  assert.equal(render({menuPaths:[path],menuPath:path}),'领导引领力 / EHSS投入 / 预算和使用');
  assert.equal(render({menuPaths:[],menuPath:path}),'领导引领力 / EHSS投入 / 预算和使用');
  f.run(`state.menus=[${JSON.stringify({id:'budget-menu',path})}];state.releaseId='historical-release';`);
  assert.equal(render({menuId:'budget-menu',menuPath:['历史一级','历史二级','历史预算']}),'历史一级 / 历史二级 / 历史预算');
  assert.equal(render({menuPaths:[['甲','子菜单甲'],['乙','子菜单乙'],['丙','子菜单丙']]}),'甲 / 子菜单甲；乙 / 子菜单乙（共 3 个菜单）');
  assert.equal(render({menuPaths:[],menuIds:['budget-menu']}),'领导引领力 / EHSS投入 / 预算和使用');
  assert.equal(f.requests.length,0);
});

test('business tree preserves selected management module and a parent selection includes all descendant menus', async t => {
  const f = fixture(t, '?project=forge-base&tab=entities');
  f.run(`state.menus=${JSON.stringify(menus)};state.menusReady=true;renderMenus();`);
  walk(f.get('delivery-menu-tree')).find(item => item.tagName === 'BUTTON' && item.textContent === '风险管理').click();
  const query = new URL(f.requests[0].url, 'http://example').searchParams;
  assert.equal(query.get('kind'), 'entity'); assert.equal(query.get('menuId'), 'two'); assert.equal(f.run('state.tab'), 'entities');
  await f.reply(0, { items: [], total: 0 });
  f.run("state.tab='menus'; state.menuId='two'; loadList();");
  assert.match(f.get('delivery-table-body').textContent, /风险管理.*风险登记/);
  assert.equal(f.get('delivery-range').textContent.includes('共 2 条'), true);
  f.get('delivery-menu-search').value = '风险登记'; f.get('delivery-menu-search').dispatchEvent(new Event('input'));
  assert.match(f.get('delivery-menu-tree').textContent, /安全管理.*风险管理.*风险登记/);
  f.get('delivery-menu-search-clear').click(); assert.equal(f.get('delivery-menu-search-clear').hidden, true);
});

test('every typed management view sends its agreed asset kind while preserving menu and pagination', async t => {
  for (const [tab, kind] of Object.entries({ scenes: 'scene', entities: 'entity', database: 'table', pages: 'page', backend: 'api', permissions: 'permission', acceptance: 'test', rules: 'rule', dictionaries: 'dictionary', tasks: 'task' })) {
    const f = fixture(t, `?project=forge-base&tab=${tab}&menuId=three&pageSize=50&q=风险`); const pending = f.run('loadList()');
    const url = new URL(f.requests[0].url, 'http://example'); assert.equal(url.pathname, ['permissions','acceptance'].includes(tab)?'/forge-gateway/api/delivery/views':'/forge-gateway/api/delivery/assets');
    assert.equal(url.searchParams.get('kind'), kind); assert.equal(url.searchParams.get('menuId'), 'three'); assert.equal(url.searchParams.get('pageSize'), '50');
    await f.reply(0, { items: [], total: 0 }); await pending;
  }
});

test('feature delivery keeps menu scope while project statistics explicitly retain their project meaning', async t => {
  const f=fixture(t,'?project=forge-base&tab=overview&menuId=three');
  assert.equal(f.run('queryFor().get("menuId")'),'three');assert.equal(f.run('queryFor().get("view")'),'feature-delivery');
  f.run('renderOverview({counts:{requirements:1972},assetCounts:{function:0,entity:300}})');
  assert.match(f.get('delivery-coverage').textContent,/项目资料统计，不随当前菜单或迭代筛选/);
  assert.match(f.get('delivery-overview').textContent,/独立功能定义0.*需求记录（含文档章节）1972/);
  f.tabs.find(tab=>tab.dataset.deliveryTab==='backend').click();assert.equal(new URL(f.requests[0].url,'http://example').searchParams.get('menuId'),'three');await f.reply(0,{items:[],total:0});
});

test('business text remains inert and unrelated evidence states remain independent',t=>{
  const f=fixture(t);f.run(`renderRows([${JSON.stringify({...requirement,name:'<img src=x onerror=alert(1)>',recordType:'requirement'})}])`);
  assert.match(f.get('delivery-table-body').textContent,/<img src=x onerror=alert\(1\)>/);
  assert.equal(walk(f.get('delivery-table-body')).some(item=>item.tagName==='IMG'),false);
  assert.match(f.get('delivery-table-head').textContent,/采用情况实现依据验证结论发布依据/);
  assert.match(f.get('delivery-table-body').textContent,/采用情况未明确.*尚未关联依据/);
});

test('entity detail exposes attributes, logical relationships, table mapping, and shared-menu navigation', t => {
  const f = fixture(t, '?project=forge-base&tab=entities');
  f.run(`state.menus=${JSON.stringify(menus)};renderDetail('assets',${JSON.stringify({ assetId: 'entity-worker', kind: 'entity', name: '作业人员', description: '相关方人员', menuIds: ['two', 'three'], revision: 1, details: { attributes: [{ name: '身份证号', required: true, validation: '18位' }], relationships: [{ name: '归属组织', from: '作业人员', to: '组织', cardinality: '多对一' }], tables: ['worker_record'] }, relations: [{ type: 'uses', label: '组织信息', targetId: 'entity-org', targetKind: 'entity', targetRevision: 'org-v1' }] })});`);
  const body = f.get('delivery-detail-body'); assert.match(body.textContent, /身份证号.*18位.*归属组织.*多对一.*不代表数据库设置了物理外键.*worker_record/);
  assert.match(body.textContent, /被哪些业务菜单使用.*安全管理.*风险登记/);
  assert.ok(walk(body).some(item => item.tagName === 'BUTTON' && item.textContent === '组织信息'));
});

test('database and API detail retain technical fields and all independent interface dimensions', t => {
  const f = fixture(t);
  f.run(`renderDetail('assets',${JSON.stringify({ assetId: 'table-worker', kind: 'table', name: 'worker', revision: 1, details: { fields: [{ name: 'id', primaryKey: true, nullable: false }, { name: 'name', dataType: 'varchar', length: 80 }], technicalFields: [{ name: 'create_time', description: '创建时间' }], fieldMappings: [{ businessAttribute: '人员姓名', field: 'name' }] } })});`);
  assert.match(f.get('delivery-detail-body').textContent,/数据库字段.*数据库允许空值.*id/);assert.match(f.get('delivery-detail-body').textContent,/技术补充字段.*create_time.*创建时间/);
  f.run(`renderDetail('assets',${JSON.stringify({ assetId: 'api-worker', kind: 'api', name: '登记人员', revision: 1, details: { method: 'POST', path: '/workers', owner: '相关方', requestFields: [{ name: 'name', required: true }], responseFields: [{ name: 'id', dataType: 'string' }], internalCalls: [{ endpoint: '/orgs', module: '组织机构', purpose: '选择组织' }], externalCalls: [{ endpoint: '/identity', system: '身份核验', purpose: '核对身份' }] } })});`);
  assert.match(f.get('delivery-detail-body').textContent, /POST.*\/workers.*相关方.*请求字段.*返回字段.*内部模块调用.*组织机构.*外部系统调用.*身份核验/);
  // Actual 8f5a499a checkpoint API shape: backend-checkpoint-list-readonce-live02-20261009.json, items[0].
  const api = {assetId:'accident.api.investigation.page',kind:'api',name:'调查分页',revision:'6315a0a02bc7607ffa57d13861b2455ed19dc7deeb707560d1d96a7fdc852fc6',adoption:{state:'unknown'},details:{
    providerModule:'forge-business-core / accident.investigate（事故调查模块）',
    handlingMethod:'同步、只读、租户隔离的数据库分页查询；筛选条件在 Mapper XML 中拼接，排序固定为 update_time DESC、id DESC。',
    menuUsages:[
      {usage:'事故调查页面加载调查任务列表，并按当页记录计算待办、进行中、完成和超时数量。',source:'forge-admin-ui/src/views/accident/investigate.vue:1472-1488',menuRef:{id:'forge-base:menu:10164',kind:'menu',revision:null}},
      {usage:'当前事故事件台账页面以 tab=all 加载调查档案列表，并按当页记录计算上报、进行中和结案数量。',source:'forge-admin-ui/src/views/accident/ledger.vue:192-209',menuRef:{id:'forge-base:menu:10144',kind:'menu',revision:null}},
    ],
    calls:[{caller:'AccidentInvestigateServiceImpl.page',source:'AccidentInvestigateServiceImpl.java:75-78,889-897',purpose:'取得当前请求租户，约束调查数据范围。',trigger:'每次分页查询。',callType:'进程内上下文读取',targetModule:'forge-starter-tenant',failureImpact:'无租户时继续尝试会话租户；两处均无值则查询失败关闭。',targetCapability:'TenantContextHolder.getTenantId'}],
    dependencies:[{caller:'GET /business/accident/investigate/page',source:'AccidentInvestigateController.java:38-43',purpose:'限制调查分页读取权限。',trigger:'每次接口请求。',callType:'注解式请求拦截',targetModule:'Sa-Token/Forge 权限能力',failureImpact:'无权限时不进入查询。',targetCapability:'business:accidentInvestigate:api:page 权限检查'}],
    dependencyReview:{scope:'Controller.page → AccidentInvestigateServiceImpl.page → AccidentInvestigateMapper.selectInvestigatePage 及类级横切注解；同时核对事故调查页和事故台账页调用。',conclusion:'未发现 FlowClient、其他业务 Service、外部 HTTP/消息系统或其他业务表调用。Controller 调用自身 Service、Service 调用自身 Mapper 仅作为处理步骤，不登记为外部模块接口；旧 v1 接口和 t_accident_incident 仍以原独立记录保留。'},
  }};
  f.run(`state.tab='backend';state.menuId='forge-base:menu:10144';let apiReading=${JSON.stringify(api)};renderRows([apiReading]);`);
  const cell = label => {
    const headers=f.get('delivery-table-head').children[0].children;
    const index=headers.findIndex(header=>header.textContent===label);
    assert.ok(index>=0,label);return f.get('delivery-table-body').children[0].children[index].textContent;
  };
  assert.equal(cell('提供模块'),api.details.providerModule);
  assert.equal(cell('当前菜单使用关系'),api.details.menuUsages[1].usage);
  assert.equal(f.get('delivery-table-body').textContent.includes(api.details.menuUsages[0].usage),false);
  assert.equal(f.get('delivery-table-body').textContent.includes('ledger.vue'),false);
  f.run(`state.columnPreferences.set('backend',new Set(deliveryTabs.backend.columns.map(column=>column.key)));renderRows([apiReading]);`);
  assert.equal(cell('处理方式'),api.details.handlingMethod);
  f.run(`state.menuId='forge-base:menu:10164';renderRows([apiReading]);`);
  assert.equal(cell('当前菜单使用关系'),api.details.menuUsages[0].usage);
  f.run(`state.menuId='unrecorded-menu';renderRows([apiReading]);`);
  assert.equal(cell('当前菜单使用关系'),'未记录当前菜单使用关系');
  f.run(`state.menuId='';renderRows([apiReading]);`);
  assert.equal(cell('当前菜单使用关系'),'选择业务菜单查看使用关系');
  f.run(`renderRows([{kind:'api',name:'原字段接口',details:{owner:'相关方',processingMode:'同步',menuUsage:'登记人员'}}]);`);
  assert.equal(cell('提供模块'),'相关方');assert.equal(cell('处理方式'),'同步');assert.equal(cell('当前菜单使用关系'),'登记人员');
  f.run(`renderDetail('assets',apiReading);`);
  const detail = f.get('delivery-detail-body');
  assert.ok(detail.textContent.includes(api.details.providerModule));assert.ok(detail.textContent.includes(api.details.handlingMethod));
  for(const entry of api.details.menuUsages)for(const value of [entry.usage,entry.source])assert.ok(detail.textContent.includes(value));
  for(const entry of [...api.details.calls,...api.details.dependencies])for(const value of Object.values(entry))assert.ok(detail.textContent.includes(value));
  for(const value of Object.values(api.details.dependencyReview))assert.ok(detail.textContent.includes(value));
  const titles=walk(detail).filter(element=>element.tagName==='H3').map(element=>element.textContent);
  assert.ok(titles.includes('调用记录（来源原文）'));assert.ok(titles.includes('依赖记录（来源原文）'));
  assert.equal(titles.includes('内部模块调用'),false);assert.equal(titles.includes('外部系统调用'),false);
  assert.equal(f.run('apiReading.adoption.state'),'unknown');assert.equal(f.requests.length,0);
});

test('observed plan fields keep defaults, meanings and dictionaries in independent detail columns', t => {
  const f = fixture(t);
  // Values and shapes from the real 66bc5f28 plan-history capture; no businessFields inference.
  const fields = [
    { column:'version', type:'varchar(16)', nullable:false, default:'V0', businessMapping:'版本号（V0 待填写 / V1 起正式）' },
    { column:'status', type:'varchar(16)', nullable:false, default:'pending', dictionary:'biz_plan_status', businessMapping:'计划状态' },
    { column:'tenant_id', type:'bigint', nullable:false, default:'1', category:'technical', businessMapping:'租户ID' },
    { column:'del_flag', type:'bigint', nullable:false, defaultValue:'0', category:'technical', businessMapping:'逻辑删除标记' },
  ];
  const readTable = title => {
    const section = walk(f.get('delivery-detail-body')).find(item => item.tagName === 'SECTION' && item.children[0]?.textContent === title);
    assert.ok(section, `Missing detail section: ${title}`);
    const headings = walk(section).filter(item => item.tagName === 'TH').map(item => item.textContent);
    const rows = walk(section).filter(item => item.tagName === 'TR' && item.children.some(child => child.tagName === 'TD'))
      .map(row => Object.fromEntries(row.children.map((cell,index) => [headings[index],cell.textContent])));
    return { section, headings, rows };
  };
  f.run(`renderDetail('assets',${JSON.stringify({ assetId:'plan.table.t_hw_dept_plan',kind:'table',name:'t_hw_dept_plan',nature:'implementation-observation',details:{fields} })});`);
  const table = readTable('数据库字段');
  assert.equal(table.rows.length, fields.length);
  assert.equal(table.rows[0]['字段名'], 'version');
  assert.equal(table.rows[0]['字段含义'], fields[0].businessMapping);
  assert.equal(table.rows[0]['默认值'], 'V0');
  assert.equal(table.rows[0]['数据类型'], 'varchar(16)');
  assert.equal(table.rows[0]['对应业务属性'], '未记录');
  assert.equal(table.rows[0]['设计用途'], '未记录');
  assert.equal(table.rows[1]['默认值'], 'pending');
  assert.equal(table.rows[2]['字段名'], 'tenant_id');
  assert.equal(table.rows[2]['默认值'], '1');
  assert.equal(table.rows[3]['默认值'], '0');
  assert.doesNotMatch(table.section.textContent, /\[object Object\]/);

  const attribute = { name:'result',column:'result',label:'审批结果',type:'varchar(16)',required:false,dictionary:'biz_approval_result',businessMeaning:'approved/rejected/transferred/cc 或空待审批' };
  f.run(`renderDetail('assets',${JSON.stringify({ assetId:'plan.entity.approval-flow',kind:'entity',name:'审批流记录',nature:'implementation-observation',details:{attributes:[attribute]} })});`);
  const entity = readTable('源码字段与原始注释');
  assert.equal(entity.rows.length, 1);
  assert.equal(entity.rows[0]['属性名称'], 'result');
  assert.equal(entity.rows[0]['取值字典'], 'biz_approval_result');
  assert.equal(entity.rows[0]['源码原始注释（未确认业务含义）'], attribute.businessMeaning);
  assert.ok(!entity.headings.includes('数据类型') && !entity.headings.includes('默认值') && !entity.headings.includes('字段名'));
  assert.doesNotMatch(entity.section.textContent, /\[object Object\]/);
  assert.equal(f.requests.length, 0);
});

test('budget observations render named regions, individual API refs and existing business text without inference', t => {
  const f = fixture(t);
  // Mechanical excerpts from the real da3476b6 budget capture, kept independent of local output files.
  const sample = {"page":{"assetId":"budget.page.fee-budget","kind":"page","name":"code-copilot/changes/delivery-center-history-budget/spec.md · page","nature":"implementation-observation","details":{"pageName":"预算和使用页面","route":"/leadership/fee-budget","component":"forge-admin-ui/src/views/leadership/fee-budget.vue","regions":[{"name":"搜索区","purpose":"筛选预算记录","fields":[{"name":"unit","label":"单位名称","type":"select","required":false,"dictionarySource":"GET /business/leadership/feebudget/unitList","validation":"可清空，支持过滤"},{"name":"year","label":"年度","type":"select","required":false,"dictionarySource":"当前年前后2年本地计算","validation":"可清空"},{"name":"subject","label":"费用类别","type":"select","required":false,"dictionarySource":"GET /business/leadership/feebudget/subjectList","validation":"可清空，支持过滤"}]},{"name":"列表区","purpose":"展示预算记录和操作入口","fields":[{"name":"unit","label":"单位名称","type":"text","required":false},{"name":"year","label":"年度","type":"text","required":false},{"name":"subject","label":"费用科目","type":"text","required":false},{"name":"budget","label":"预算金额（元）","type":"decimal","required":false},{"name":"used","label":"实际使用金额（元）","type":"decimal","required":false,"trigger":"抓取链接"},{"name":"creator","label":"创建人","type":"text","required":false},{"name":"createTime","label":"创建时间","type":"datetime","required":false}]},{"name":"新增/编辑/查看弹窗","purpose":"维护单条预算记录","fields":[{"name":"unit","label":"单位名称","type":"disabled input","required":false,"dictionarySource":"创建人所在单位","validation":"页面展示带入创建人所在单位"},{"name":"year","label":"年度","type":"select","required":true,"dictionarySource":"当前年前后2年本地计算","validation":"提交时必须选择"},{"name":"subject","label":"费用科目","type":"select","required":true,"dictionarySource":"subjectList","validation":"提交时必须选择"},{"name":"budget","label":"预算金额（不含税）","type":"number","required":true,"validation":"min=0，precision=2，提交时不能为空且非负"},{"name":"used","label":"实际使用金额","type":"number","required":false,"validation":"新增禁用；查看禁用；编辑可显示并可同步"},{"name":"remark","label":"备注","type":"textarea","required":false},{"name":"attachment","label":"附件","type":"FileUpload","required":false,"validation":"limit=10，查看禁用"}]},{"name":"科目编号管理弹窗","purpose":"维护费用科目编号","fields":[{"name":"subject","label":"费用科目","type":"text","required":true,"dictionarySource":"subjectList"},{"name":"subjectCode","label":"科目编号","type":"input","required":false,"validation":"资料未说明编码规则"}]}],"actions":[{"name":"查询","trigger":"点击查询","result":"重置分页到第一页并加载列表","apiRefs":[{"kind":"api","id":"budget.api.get-page","revision":null}]},{"name":"重置","trigger":"点击重置","result":"清空单位和科目，年度恢复当前年后查询","apiRefs":[{"kind":"api","id":"budget.api.get-page","revision":null}]},{"name":"新增","trigger":"点击新增","result":"打开新增弹窗","apiRefs":[{"kind":"api","id":"budget.api.post-add","revision":null}]},{"name":"查看","trigger":"点击行内查看","result":"加载详情并以只读方式展示","apiRefs":[{"kind":"api","id":"budget.api.post-get-by-id","revision":null}]},{"name":"编辑","trigger":"点击行内编辑","result":"加载详情并保存修改","apiRefs":[{"kind":"api","id":"budget.api.post-get-by-id","revision":null},{"kind":"api","id":"budget.api.post-edit","revision":null}]},{"name":"删除","trigger":"点击行内删除","result":"调用删除接口后刷新列表","apiRefs":[{"kind":"api","id":"budget.api.post-remove-id","revision":null}]},{"name":"抓取","trigger":"点击实际使用金额列下方抓取","result":"同步 used 并刷新列表","apiRefs":[{"kind":"api","id":"budget.api.post-sync-id","revision":null}]},{"name":"同步数据","trigger":"编辑弹窗点击同步数据","result":"更新弹窗 used 值","apiRefs":[{"kind":"api","id":"budget.api.post-sync-id","revision":null}]},{"name":"科目编号管理","trigger":"点击工具栏按钮","result":"加载并保存科目编号","apiRefs":[{"kind":"api","id":"budget.api.get-subject-list","revision":null},{"kind":"api","id":"budget.api.post-subject-save","revision":null}]},{"name":"导出","trigger":"点击导出","result":"下载预算和使用 Excel","apiRefs":[{"kind":"api","id":"budget.api.post-export","revision":null}]}]}},"entity":{"assetId":"budget.entity.fee-budget","kind":"entity","name":"费用预算记录","nature":"implementation-observation","details":{"attributes":[{"name":"budget","meaning":"预算金额（元）","type":"BigDecimal","required":true,"validation":"非负","source":"FeeServiceImpl"}]}},"table":{"assetId":"budget.table.t-lead-fee-budget","kind":"table","name":"t_lead_fee_budget","nature":"implementation-observation","details":{"fields":[{"name":"budget","type":"decimal(18,2)","nullable":false,"default":"0","key":null,"businessMeaning":"预算金额（元）","businessAttribute":"budget"}]}},"requirement":{"id":"budget.requirement.non-negative-budget","name":"budget.requirement.non-negative-budget","description":"","nature":"implementation-observation","details":{"code":"REQ-BUDGET-004","statement":"预算金额不得为负数。","verification":"前端输入 min=0；后端新增/编辑校验 budget < 0 抛业务异常。"}}};
  const section = title => {
    const result = walk(f.get('delivery-detail-body')).find(item => item.tagName === 'SECTION' && item.children[0]?.textContent === title);
    assert.ok(result, `Missing detail section: ${title}`); return result;
  };
  const readTable = title => {
    const element = section(title);
    const headings = walk(element).filter(item => item.tagName === 'TH').map(item => item.textContent);
    return walk(element).filter(item => item.tagName === 'TR' && item.children.some(child => child.tagName === 'TD'))
      .map(row => Object.fromEntries(row.children.map((cell,index) => [headings[index],cell.textContent])));
  };
  f.run("state.tab='pages';renderRows(["+JSON.stringify(sample.page)+"]);renderDetail('assets',"+JSON.stringify(sample.page)+")");
  assert.match(f.get('delivery-table-body').textContent, /预算和使用页面/);
  assert.equal(f.get('delivery-detail-title').textContent, '预算和使用页面');
  const fields = readTable('区域字段与规则');
  assert.equal(fields.length, 19);
  assert.deepEqual(sample.page.details.regions.map(region => fields.filter(row => row['所属区块'] === region.name).length), [3,7,7,2]);
  assert.equal(fields.find(row => row['所属区块'] === '搜索区' && row['字段标识'] === 'year')['必填条件'], '否');
  const editYear = fields.find(row => row['所属区块'] === '新增/编辑/查看弹窗' && row['字段标识'] === 'year');
  assert.equal(editYear['必填条件'], '是');
  assert.equal(editYear['取值来源'], '当前年前后2年本地计算');
  assert.equal(editYear['校验规则'], '提交时必须选择');
  assert.equal(fields.find(row => row['所属区块'] === '科目编号管理弹窗' && row['字段标识'] === 'subjectCode')['校验规则'], '资料未说明编码规则');
  const empty=walk(f.get('delivery-detail-body')).find(element=>element.className?.includes('delivery-empty-sections'));
  assert.doesNotMatch(empty.textContent,/查询条件|列表内容|表单字段与校验/);
  assert.match(f.get('delivery-detail-body').textContent,/未单独拆分专用字段表：查询条件、列表内容、表单字段与校验/);
  assert.equal(walk(f.get('delivery-detail-body')).some(element=>element.tagName==='SECTION'&&['查询条件','表单字段与校验'].includes(element.children[0]?.textContent)),false);
  assert.equal(f.run("state.detailAnchors.has('/details/regions/2/fields/1')"), true);
  const calls = readTable('操作调用接口');
  assert.equal(calls.length, 12);
  const editCalls = calls.filter(row => row['页面操作'] === '编辑');
  assert.equal(editCalls.length, 2);
  assert.match(editCalls[0]['调用接口'], /budget\.api\.post-get-by-id/);
  assert.match(editCalls[1]['调用接口'], /budget\.api\.post-edit/);
  assert.ok(calls.every(row => row['调用接口'].includes('目标修订未明确')));
  assert.equal(f.run("state.detailAnchors.has('/details/actions/4/apiRefs/1')"), true);
  assert.doesNotMatch(section('区域字段与规则').textContent+section('操作调用接口').textContent, /\[object Object\]/);
  // Existing env-provider meaning is independent from a field identifier or display label.
  const providerField = { name:'supplierCode',meaning:'服务商编号',type:'text',required:false };
  f.run("renderDetail('assets',"+JSON.stringify({kind:'page',details:{regions:[{name:'搜索区',fields:[providerField]}]}})+")");
  const providerRow = readTable('区域字段与规则')[0];
  assert.equal(providerRow['业务含义'], '服务商编号');
  assert.equal(providerRow['字段标识'], 'supplierCode');
  assert.equal(providerRow['显示名称'], 'supplierCode');
  f.run("renderDetail('assets',"+JSON.stringify(sample.entity)+")");
  assert.equal(readTable('源码字段与原始注释')[0]['源码原始注释（未确认业务含义）'], '预算金额（元）');
  f.run("renderDetail('assets',"+JSON.stringify(sample.table)+")");
  assert.equal(readTable('数据库字段')[0]['字段含义'], '预算金额（元）');
  assert.equal(readTable('数据库字段')[0]['默认值'], '0');
  // Stress only text length; the repeated fixture does not create another business definition.
  const statement = sample.requirement.details.statement.repeat(30)+'原文完整末尾';
  sample.requirement.details.statement = statement;
  f.run("state.tab='requirements';renderRows(["+JSON.stringify(sample.requirement)+"])");
  const heads = walk(f.get('delivery-table-head')).filter(item => item.tagName === 'TH').map(item => item.textContent);
  const summary = f.get('delivery-table-body').children[0].children[heads.indexOf('要求内容')].textContent;
  assert.ok(summary.startsWith('预算金额不得为负数。') && summary.length <= 110);
  f.run("renderDetail('requirements',"+JSON.stringify(sample.requirement)+")");
  assert.equal(section('要求内容').textContent, '要求内容'+statement);
  assert.equal(f.requests.length, 0);
});

test('page region fields fold beside dedicated field tables while unique historical field access remains direct', t => {
  const f=fixture(t,'?project=forge-base&tab=pages');
  const page={assetId:'budget.page.fee-budget',kind:'page',name:'预算和使用页面',revision:'8b63398720c50380f8d501f366d66aa341f577aa687a5beee7652bfc197f7ad8',details:{
    regions:[{name:'搜索区',purpose:'筛选预算记录',fields:[{name:'year',label:'年度',required:false,validation:'可清空'}]},
      {name:'科目编号管理弹窗',purpose:'维护费用科目编号',fields:[{name:'subjectCode',label:'科目编号',validation:'资料未说明编码规则'}]}],
    queryFields:[{name:'year',label:'年度',businessMeaning:'按预算归属年度精确筛选'}],
    listColumns:[{name:'year',label:'年度',businessMeaning:'预算归属年度'}],
    formFields:[{name:'year',label:'年度',required:true,validation:'提交时必须选择'}],
  }};
  f.run(`renderDetail('assets',${JSON.stringify(page)})`);
  const body=f.get('delivery-detail-body');
  const directSection=title=>body.children.find(element=>element.tagName==='SECTION'&&element.children[0]?.textContent===title);
  const fold=body.children.find(element=>element.tagName==='DETAILS'&&element.children[0]?.textContent==='区域字段原文与所属区块');
  assert.ok(fold);assert.equal(fold.open,false);
  for(const title of ['页面区域','查询条件','列表内容','表单字段与校验'])assert.ok(directSection(title),title);
  assert.equal(directSection('区域字段与规则'),undefined);
  assert.match(directSection('页面区域').textContent,/搜索区.*筛选预算记录.*科目编号管理弹窗/);
  assert.match(directSection('表单字段与校验').textContent,/提交时必须选择/);
  assert.match(fold.textContent,/可清空.*科目编号.*资料未说明编码规则/);
  const regionRows=walk(fold).filter(element=>element.tagName==='TR'&&element.children.some(child=>child.tagName==='TD'));
  assert.equal(regionRows.length,2,'Every sourced region field stays available without name-based merging.');
  f.run("revealDetailTarget(state.detailAnchors.get('/details/regions/1/fields/0'))");
  assert.equal(fold.open,true,'An exact region-field reference opens its existing disclosure.');
  const historical={...page,details:{regions:page.details.regions,queryFields:[],listColumns:[],formFields:[]}};
  f.run(`renderDetail('assets',${JSON.stringify(historical)})`);
  assert.ok(directSection('区域字段与规则'),'Region-only history keeps its sole field table directly readable.');
  assert.equal(body.children.some(element=>element.tagName==='DETAILS'&&element.children[0]?.textContent==='区域字段原文与所属区块'),false);
  assert.equal(f.requests.length,0);
});

test('page details keep layout, required fields, queries, list contents, actions and navigation together', t => {
  const f = fixture(t);
  f.run(`renderDetail('assets',${JSON.stringify({ assetId: 'page-worker', kind: 'page', name: '人员列表', revision: 1, details: { layout: '左右结构', blocks: [{ name: '组织树', position: '左侧' }, { name: '人员表格', position: '右侧' }], formFields: [{ name: '姓名', required: true, validation: '不能为空' }], queryFields: [{ name: '单位' }], listColumns: [{ name: '工种' }], actions: [{ name: '新增', endpoint: '/workers' }], navigation: [{ from: '列表', to: '详情' }], frontend: '已生成页面代码' } })});`);
  assert.match(f.get('delivery-detail-body').textContent, /左右结构.*组织树.*人员表格.*姓名.*不能为空.*查询条件.*单位.*列表内容.*工种.*新增.*\/workers.*页面跳转.*详情.*已生成页面代码/);
});

test('revision comparison reads only two selected immutable revisions and distinguishes technical differences from business conclusions',async t=>{
  const f=fixture(t);const oldVersion={revision:'old',name:'人员',details:{fields:[{name:'姓名',required:false},{name:'旧字段'}]}};
  const current={assetId:'entity-worker',kind:'entity',revision:'new',name:'人员',details:{fields:[{name:'姓名',required:true},{name:'联系电话'}]},revisions:[{revision:'old',recordedAt:'2026-09-01T00:00:00Z'}],recordedAt:'2026-10-01T00:00:00Z'};
  f.run(`renderDetail('assets',${JSON.stringify(current)})`);assert.equal(f.requests.length,0);
  const button=walk(f.get('delivery-detail-body')).find(item=>item.tagName==='BUTTON'&&item.textContent==='读取并比较这两版');button.click();
  assert.equal(f.requests.length,2);assert.equal(new URL(f.requests[0].url,'http://example').searchParams.get('revision'),'old');assert.equal(new URL(f.requests[1].url,'http://example').searchParams.get('revision'),'new');
  await f.reply(0,{item:oldVersion});await f.reply(1,{item:current});
  assert.match(f.get('delivery-detail-body').textContent,/尚无已关联的业务变化说明.*资料字段差异.*姓名.*否.*是.*移除.*新增/);
  f.get('delivery-compare-before').value='new';button.click();assert.match(f.get('delivery-detail-body').textContent,/请选择两个不同版本/);assert.equal(f.requests.length,2);
});

test('explicit object history crosses batches only on demand and preserves frozen release comparisons',async t=>{
  const item={assetId:'accident.page.report-form',kind:'page',name:'上报表单',revision:'page-new',recordedAt:'2026-10-09T00:00:00Z',batchIds:['batch-new'],sources:[{batchId:'batch-new'}],revisionsHasMore:false,details:{formFields:[{name:'reportType',businessMeaning:'路由类型'}]}};
  const previous={revision:'page-old',recordedAt:'2026-10-08T00:00:00Z',sources:[{batchId:'batch-old'}]};
  const f=fixture(t,'?project=forge-base&tab=pages&menuId=three&menuScope=self&batchId=batch-new');
  f.run(`renderDetail('assets',${JSON.stringify(item)})`);assert.equal(f.requests.length,0);
  const body=f.get('delivery-detail-body');const originalUrl=f.window.location.search;
  assert.match(body.textContent,/当前批次已读取的修订不足两份；其他批次的修订不在此范围内/);
  assert.doesNotMatch(body.textContent,/目前仅收录一个版本/);
  visibleWalk(body).find(element=>element.tagName==='BUTTON'&&element.textContent==='查看此对象跨批次修订').click();
  assert.equal(f.requests.length,1);let query=new URL(f.requests[0].url,'http://example').searchParams;
  assert.equal(query.get('project'),'forge-base');assert.equal(query.get('view'),'history');assert.equal(query.get('kind'),'page');assert.equal(query.get('recordId'),item.assetId);
  assert.equal(query.get('page'),'1');assert.equal(query.get('pageSize'),'50');assert.equal(query.has('batchId'),false);assert.equal(query.has('releaseId'),false);
  assert.equal(query.get('menuId'),'three');assert.equal(query.get('menuScope'),'self');
  await f.reply(0,{items:[{revision:item.revision,recordedAt:item.recordedAt,sources:item.sources},previous],total:2});
  assert.equal(f.window.location.search,originalUrl);assert.equal(f.run('state.batchId'),'batch-new');assert.equal(f.run('state.menuId'),'three');assert.equal(f.run('state.releaseId'),'');
  assert.match(body.textContent,/本对象跨批次修订/);assert.match(body.textContent,/来源批次/);assert.match(body.textContent,/batch-old/);assert.match(body.textContent,/batch-new/);
  assert.match(body.textContent,/主页面的菜单与批次范围保持不变/);
  f.get('delivery-compare-before').value='page-old';f.get('delivery-compare-after').value='page-new';
  visibleWalk(body).find(element=>element.tagName==='BUTTON'&&element.textContent==='读取并比较这两版').click();
  assert.equal(f.requests.length,3);
  for(const [index,revision]of [[1,'page-old'],[2,'page-new']]){
    const url=new URL(f.requests[index].url,'http://example');query=url.searchParams;
    assert.equal(url.pathname,`/forge-gateway/api/delivery/assets/${item.assetId}`);
    assert.equal(query.get('revision'),revision);assert.equal(query.has('batchId'),false);assert.equal(query.get('menuId'),'three');
  }
  await f.reply(1,{item:{...item,...previous,details:{formFields:[{name:'reportType'}]}}});await f.reply(2,{item});
  assert.equal(f.window.location.search,originalUrl);assert.match(body.textContent,/资料字段差异/);

  const released=fixture(t,'?project=forge-base&tab=pages&menuId=three&releaseId=release-frozen');
  released.run(`renderDetail('assets',${JSON.stringify({...item,revisions:[previous]})})`);
  const releaseBody=released.get('delivery-detail-body');assert.equal(released.requests.length,0);
  assert.equal(visibleWalk(releaseBody).some(element=>element.tagName==='BUTTON'&&element.textContent==='查看此对象跨批次修订'),false);
  assert.match(releaseBody.textContent,/仅查看该发布已绑定的修订/);
  visibleWalk(releaseBody).find(element=>element.tagName==='BUTTON'&&element.textContent==='读取并比较这两版').click();
  for(const [index,revision]of [[0,'page-old'],[1,'page-new']]){
    query=new URL(released.requests[index].url,'http://example').searchParams;
    assert.equal(query.get('releaseId'),'release-frozen');assert.equal(query.get('revision'),revision);
  }
  await released.reply(0,{item:{...item,...previous}});await released.reply(1,{item});
  assert.equal(released.run('state.releaseId'),'release-frozen');assert.equal(released.requests.length,2);
});

test('Mermaid sources reject embedded actions, configuration and external resources while text remains readable', t => {
  const f = fixture(t);
  assert.equal(f.run(`safeDiagramSource(${JSON.stringify({ type: 'flowchart', source: 'flowchart TD\nA[申请] --> B[审批]' })})`), true);
  for (const suffix of ['\nclick A "https://example.org"', '\n%%{init: {securityLevel: "loose"}}%%', '\nA[<img src=x>]', '\nstyle A fill:url(https://example.org)', '\nA@{img: "https://example.org"}']) assert.equal(f.run(`safeDiagramSource(${JSON.stringify({ type: 'flowchart', source: 'flowchart TD\nA --> B' + suffix })})`), false);
  f.run(`appendDiagram($('delivery-detail-body'),${JSON.stringify({ type: 'flowchart', source: 'flowchart TD\nclick A callback', sourceRefs: ['原始流程'] })})`);
  assert.match(f.get('delivery-detail-body').textContent, /不符合安全展示格式.*click A callback.*原始流程/s);
});

test('Mermaid rendering creates an inert data image and late completion cannot reopen closed details', async t => {
  const f = fixture(t); f.run(String.raw`diagramRenderer=async()=>({render:async()=>({svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>流程</text></svg>'})});$('delivery-detail').showModal();appendDiagram($('delivery-detail-body'),{type:'flowchart',source:'flowchart TD\nA --> B'})`); await tick();
  const picture = walk(f.get('delivery-detail-body')).find(item => item.tagName === 'IMG'); assert.ok(picture); assert.match(picture.src, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.equal(walk(f.get('delivery-detail-body')).some(item => item.tagName === 'SVG'), false);
  f.run(String.raw`let finishDiagram; let closedDiagramCalls=0; diagramRenderer=()=>new Promise(resolve=>{finishDiagram=resolve}); appendDiagram($('delivery-detail-body'),{type:'flowchart',source:'flowchart TD\nA --> B'});closeDetail();finishDiagram({render:async()=>{closedDiagramCalls+=1;return {svg:'<svg/>'}}})`); await tick();
  assert.equal(f.get('delivery-detail-body').textContent, '');
  assert.equal(f.run('closedDiagramCalls'), 0);
});

test('IME search is debounced and clearing cancels stale responses', async t => {
  const f = fixture(t); const input = f.get('delivery-search'); input.dispatchEvent(new Event('compositionstart')); input.value = '风'; input.dispatchEvent(new Event('input')); await f.fireSearch(); assert.equal(f.requests.length, 0);
  input.value = '风险'; input.dispatchEvent(new Event('compositionend')); await f.fireSearch(); assert.equal(new URL(f.requests[0].url, 'http://example').searchParams.get('q'), '风险');
  f.get('delivery-search-clear').click(); assert.equal(f.requests[0].options.signal.aborted, true);
  await f.reply(1, { items: [{ ...requirement, name: '新结果' }], total: 1 }); await f.reply(0, { items: [{ ...requirement, name: '旧结果' }], total: 1 });
  assert.match(f.get('delivery-table-body').textContent, /新结果/); assert.doesNotMatch(f.get('delivery-table-body').textContent, /旧结果/); assert.equal(f.get('delivery-search-clear').hidden, true);
});

test('historical asset detail requests the frozen revision and does not substitute a current relation detail', async t => {
  const f = fixture(t, '?project=forge-base&tab=entities&releaseId=release-old'); const pending = f.run("showDetail('assets',{assetId:'entity-worker',kind:'entity',name:'人员',revision:2})");
  const url = new URL(f.requests[0].url, 'http://example'); assert.equal(url.searchParams.get('revision'), '2');
  await f.reply(0, { item: { assetId: 'entity-worker', kind: 'entity', name: '旧版本人员', revision: 2, details: {}, relations: [{ targetId: 'entity-org', targetKind: 'entity', label: '组织' }] } }); await pending;
  assert.equal(f.get('delivery-detail-title').textContent, '旧版本人员'); assert.equal(walk(f.get('delivery-detail-body')).some(item => item.tagName === 'BUTTON' && item.textContent === '查看组织'), false);
});

test('unknown release scope remains empty and release details retain immutable requirement snapshots', async t => {
  const f = fixture(t, '?project=forge-base&tab=entities&releaseId=release-old'); const pending = f.run('loadList()'); await f.reply(0, { items: [], total: 0, scopeBinding: 'unknown' }); await pending;
  assert.match(f.get('delivery-empty-title').textContent, /业务范围尚未关联/); assert.match(f.get('delivery-empty-help').textContent, /不使用当前记录替代/);
  f.run("renderDetail('releases',{id:'candidate',status:'prepared',requirementSnapshots:[]})"); assert.match(f.get('delivery-detail-body').textContent, /候选已准备.*不能用当前需求替代历史版本内容/);
  f.run("renderDetail('releases',{id:'release-one',status:'deployed',requirementSnapshots:[{name:'发布时的功能',revision:2}]})"); assert.match(f.get('delivery-detail-body').textContent, /有依据的功能范围功能 \/ 要求定义修订.*发布时的功能2/);
});

test('project changes cancel details and empty, failed, expired and out-of-range results stay distinct', async t => {
  const f = fixture(t); const detail = f.run("showDetail('requirements',{id:'req-one'})"); const switching = f.run("navigate({project:'other'})");
  assert.equal(f.requests[0].options.signal.aborted, true); await f.reply(0, { item: requirement }); await detail;
  await f.reply(1, { items: [], total: 0 }); await f.reply(2, { items: [] }); await f.reply(3, { counts: {} }); await switching; assert.equal(f.get('delivery-detail').open, false);
  const failed = f.run('loadList()'); await f.reply(4, { message: '数据库暂不可用' }, 503); await failed; assert.equal(f.get('delivery-empty').hidden, true); assert.match(f.get('delivery-error-message').textContent, /数据库暂不可用/);
  const expired = f.run('loadList()'); await f.reply(5, {}, 401); await expired; assert.deepEqual(f.navigations, ['/forge-gateway/login']);
  f.run('state.page=9'); const bounded = f.run('loadList()'); await f.reply(6, { items: [], total: 1 }); await f.reply(7, { items: [requirement], total: 1 }); await bounded;
  assert.match(f.get('delivery-range').textContent, /共 1 条.*第 1 页/);
});

test('two-level desktop layout reuses native read controls and local-only safe diagram loading', () => {
  assert.match(markup, /gateway\.css/); assert.match(markup, /delivery-navigation/); assert.match(markup, /delivery-workspace-layout/);
  assert.match(markup, /<dialog[^>]*aria-labelledby="delivery-detail-title"/); assert.match(markup, /<form[^>]*novalidate/);
  assert.match(styles, /var\(--blue-wash\)/); assert.match(styles, /max-width: 720px/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/i); assert.doesNotMatch(source, /\.innerHTML\s*=|\.outerHTML\s*=|\.insertAdjacentHTML\(/);
  assert.match(source, /import\('\/forge-gateway\/assets\/mermaid\/mermaid.esm.min.mjs'\)/); assert.match(source, /securityLevel: 'strict'/); assert.doesNotMatch(source, /bindFunctions\s*\(/);
});

test('digest revisions sort by recorded time and retain their exact revision query identity', async t => {
  const f = fixture(t, '?project=forge-base&tab=entities');
  const older = { revision: 'f'.repeat(64), recordedAt: '2026-09-01T00:00:00Z', name: '作业人员', details: { required: false } };
  const current = { assetId: 'entity-worker', kind: 'entity', revision: 'a'.repeat(64), recordedAt: '2026-10-01T00:00:00Z', name: '作业人员', details: { required: true }, isCurrent: true, revisions: [older] };
  f.run(`renderDetail('assets',${JSON.stringify(current)});`);
  const selectors = walk(f.get('delivery-detail-body')).filter(item => item.tagName === 'SELECT');
  assert.equal(selectors[0].value, older.revision); assert.equal(selectors[1].value, current.revision);
  assert.match(selectors[1].textContent, /修订 aaaaaaaaaaaa（当前）/); assert.doesNotMatch(selectors[1].textContent, /第 [a-f]{20}/);
  const pending = f.run(`showDetail('assets',${JSON.stringify({ assetId: current.assetId, revision: older.revision })})`);
  assert.equal(new URL(f.requests[0].url, 'http://example').searchParams.get('revision'), older.revision);
  await f.reply(0, { item: older }); await pending;
});
test('historical specification sections remain in the source view rather than independent requirement counts',t=>{
  const f=fixture(t,'?project=forge-base&tab=sources');
  f.run("renderOverview({counts:{requirements:1972}});renderRows([{id:'spec-one',name:'目标',description:'业务目标',recordType:'source-section',granularity:'specification-section'}]);renderDetail('requirements',{id:'spec-one',name:'目标',granularity:'specification-section',originalDocument:{path:'changes/example/spec.md',section:'目标',line:3},sources:[{path:'changes/example/spec.md',line:3}]})");
  assert.equal(f.run('queryFor().get("view")'),'requirements-sources');assert.match(f.get('delivery-overview').textContent,/需求记录（含文档章节）1972/);assert.doesNotMatch(f.get('delivery-overview').textContent,/需求功能点/);
  assert.match(f.get('delivery-detail-body').textContent,/changes\/example\/spec.md/);
  for(const [value,expected]of [['schema-observed','已读取数据库结构'],['configuration-enabled','配置已启用'],['configuration-disabled','配置已停用']])assert.equal(f.run(`status(${JSON.stringify(value)})`),expected);
});

test('menu source cycle and hidden configuration remain visible without claiming the original configuration was changed', t => {
  const f = fixture(t, '?project=forge-base&tab=menus');
  const menu = { id: 'forge-base:menu:9372', name: 'InOutHistory', path: ['InOutHistory'], parentId: null, sourceParentId: '9371', route: '/ai/crud-page/in_out_history', component: 'ai/crud-page', resourceType: 2, visible: false, status: 'disabled', hierarchyNote: '来源父级存在循环，当前以根节点展示，原配置未修改。' };
  f.run(`renderRows([${JSON.stringify(menu)}]);renderDetail('menus',${JSON.stringify(menu)});`);
  assert.match(f.get('delivery-table-body').textContent,/待核对/);
  assert.match(f.get('delivery-detail-body').textContent,/菜单节点类型业务菜单/);assert.match(f.get('delivery-detail-body').textContent,/页面路由\/ai\/crud-page\/in_out_history.*组件ai\/crud-page.*来源配置上级编号9371.*原配置未修改/);
});

test('ordinary CALLBACK words in ER labels remain readable while actual click callback instructions are rejected', t => {
  const f = fixture(t);
  const label = { type: 'erDiagram', source: 'erDiagram\n  Capability {\n    string name "企业协同能力绑定表 LOGIN/DIRECTORY/MESSAGE/TODO/CALLBACK"\n  }' };
  assert.equal(f.run(`safeDiagramSource(${JSON.stringify(label)})`), true);
  const instruction = { type: 'flowchart', source: 'flowchart TD\n A["CALLBACK 能力"] --> B[处理]\n click A callback' };
  assert.equal(f.run(`safeDiagramSource(${JSON.stringify(instruction)})`), false);
});

test('menus become usable before a slow overview finishes and remain visible when the overview fails', async t => {
  const f = fixture(t, '?project=forge-base&tab=menus'); const loading = f.run('loadProject()');
  assert.equal(f.requests.length, 2);
  await f.reply(0, { items: menus });
  assert.equal(f.run('state.menusReady'), true);
  assert.match(f.get('delivery-table-body').textContent, /安全管理.*风险管理.*风险登记/);
  assert.equal(f.get('delivery-results').getAttribute('aria-busy'), 'false');
  assert.equal(f.requests.length, 2);
  await f.reply(1, { message: '概览暂不可用' }, 503); await loading;
  assert.match(f.get('delivery-table-body').textContent, /风险登记/);
  assert.match(f.get('delivery-coverage').textContent, /概览暂不可用/);
});

test('unchanged navigation sends no duplicate request while switching and pagination reject stale responses', async t => {
  const f = fixture(t, '?project=forge-base&tab=entities');
  f.run(`state.menus=${JSON.stringify(menus)};state.menusReady=true;`);
  f.run("navigate({menuId:'one',page:1})"); f.run("navigate({menuId:'one',page:1})");
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.signal.aborted, false);
  f.run("navigate({menuId:'two',page:1})");
  assert.equal(f.requests.length, 2); assert.equal(f.requests[0].options.signal.aborted, true);
  const current = { assetId: 'current', kind: 'entity', name: '当前菜单实体', details: {} };
  await f.reply(1, { items: [current], total: 40 });
  await f.reply(0, { items: [{ ...current, name: '旧菜单实体' }], total: 1 });
  assert.match(f.get('delivery-table-body').textContent, /当前菜单实体/); assert.doesNotMatch(f.get('delivery-table-body').textContent, /旧菜单实体/);
  f.get('delivery-next').click();
  assert.equal(f.requests.length, 3);
  const query = new URL(f.requests[2].url, 'http://example').searchParams;
  assert.equal(query.get('page'), '2'); assert.equal(query.get('pageSize'), '20'); assert.equal(query.get('menuId'), 'two');
  assert.ok(f.requests.every(request => new URL(request.url, 'http://example').pathname.endsWith('/assets')));
  await f.reply(2, { items: [current], total: 40 });
  f.run('navigate({page:2})'); assert.equal(f.requests.length, 3);
  f.run("state.listRequest.abort();navigate({page:2})");
  assert.equal(f.requests.length, 4); await f.reply(3, { items: [current], total: 40 });
});

test('cyclic menu parents and entity references stay finite without automatic recursive requests', t => {
  const f = fixture(t, '?project=forge-base&tab=menus');
  const cyclic = [{ ...menus[0], parentId: 'two' }, menus[1], menus[2],
    { id: 'self', parentId: 'self', name: '自引用菜单' }, { id: 'orphan', parentId: 'missing', name: '保留菜单' }];
  f.run(`state.menus=${JSON.stringify(cyclic)};state.menusReady=true;renderMenus();`);
  assert.equal(walk(f.get('delivery-menu-tree')).filter(item => item.getAttribute('data-menu-select')).length, 5);
  f.run("state.menuId='one';loadList();");
  assert.equal(f.run('state.total'), 3); assert.equal(f.requests.length, 0);
  f.run("renderDetail('assets',{assetId:'a',name:'循环关系',kind:'entity',details:{},relations:[{targetId:'a',targetKind:'entity',label:'自身'},{targetId:'b',targetKind:'entity',label:'对象B'}]})");
  assert.equal(f.requests.length, 0);
  assert.match(f.get('delivery-detail-body').textContent, /自身.*对象B/);
});

test('menu expansion is independent from selection and paging, and search temporarily expands matching ancestors', t => {
  const f = fixture(t, '?project=forge-base&tab=entities&page=3');
  f.run(`state.menus=${JSON.stringify(menus)};state.menusReady=true;renderMenus();`);
  const visibleNames = () => visibleWalk(f.get('delivery-menu-tree')).filter(item => item.getAttribute('data-menu-select')).map(item => item.textContent);
  const toggle = label => walk(f.get('delivery-menu-tree')).find(item => item.getAttribute('aria-label') === label);
  assert.deepEqual(visibleNames(), ['安全管理']);
  toggle('展开安全管理').click(); assert.deepEqual(visibleNames(), ['安全管理', '风险管理']);
  assert.equal(f.run("document.activeElement.getAttribute('aria-label')"), '收起安全管理');
  assert.equal(f.requests.length, 0); assert.equal(f.run('state.page'), 3); assert.equal(f.run('state.menuId'), '');
  f.get('delivery-menu-search').value = '风险登记'; f.get('delivery-menu-search').dispatchEvent(new Event('input'));
  assert.deepEqual(visibleNames(), ['安全管理', '风险管理', '风险登记']);
  assert.equal(toggle('收起风险管理').getAttribute('aria-expanded'), 'true');
  f.get('delivery-menu-search-clear').click(); assert.deepEqual(visibleNames(), ['安全管理', '风险管理']);
  f.get('delivery-expand-menus').click(); assert.deepEqual(visibleNames(), ['安全管理', '风险管理', '风险登记']);
  f.get('delivery-collapse-menus').click(); assert.deepEqual(visibleNames(), ['安全管理']);
  assert.equal(f.requests.length, 0); assert.equal(f.run('state.page'), 3);
});

test('selected menu ancestors open on initial load and menu expansion does not leak to a different project', async t => {
  const f = fixture(t, '?project=forge-base&tab=menus&menuId=three'); const initial = f.run('loadProject()');
  await f.reply(0, { items: menus }); await f.reply(1, { counts: {} }); await initial;
  assert.deepEqual(visibleWalk(f.get('delivery-menu-tree')).filter(item => item.getAttribute('data-menu-select')).map(item => item.textContent), ['安全管理', '风险管理', '风险登记']);
  const switched = f.run("navigate({project:'other'})");
  await f.reply(2, { items: menus }); await f.reply(3, { counts: {} }); await switched;
  assert.equal(f.run('state.menuId'), '');
  assert.deepEqual(visibleWalk(f.get('delivery-menu-tree')).filter(item => item.getAttribute('data-menu-select')).map(item => item.textContent), ['安全管理']);
});

test('real source and test materials retain complete original content without being counted as executed business definitions',t=>{
  for(const [key,tab,type]of [['requirement','sources','requirements'],['test','test-materials','assets']]){
    const f=fixture(t,`?project=forge-base&tab=${tab}`);const sample=readabilitySamples[key];f.run(`renderRows([${JSON.stringify(sample)}]);renderDetail(${JSON.stringify(type)},${JSON.stringify(sample)});`);
    const row=f.get('delivery-table-body').children[0];const full=f.get('delivery-detail-body');assert.ok(row.textContent.length<1000);assert.ok(full.textContent.includes(sample.description.slice(-60)));assert.ok(walk(full).some(element=>element.tagName==='DETAILS'&&element.textContent.includes(sample.description.slice(-60))));
    if(key==='test')assert.match(full.textContent,/未关联执行结果.*测试预期或资料中的通过数字不能替代真实执行/);
  }
});

test('real Employee source comments stay implementation observations and table mapping is not relabeled as an entity relationship',t=>{
  const f=fixture(t,'?project=forge-base&tab=entities');const sample=readabilitySamples.entity;f.run(`renderRows([${JSON.stringify(sample)}]);renderDetail('assets',${JSON.stringify(sample)});`);
  const row=f.get('delivery-table-body').textContent;const details=f.get('delivery-detail-body').textContent;assert.ok(row.length<1000);assert.doesNotMatch(row,/业务属性 11|实体逻辑关联 1|forge-server\//);
  assert.match(details,/此记录是实现观察.*源码字段与原始注释.*源码原始注释（未确认业务含义）.*empName.*员工信息表实体类/);assert.match(details,/maps-to-table/);assert.ok(details.includes(sample.sources[0].path));assert.ok(details.includes(sample.details.attributes.at(-1).name));
});

test('independent business columns are not replaced with merged counts or recursive object dumps',t=>{
  const f=fixture(t,'?project=forge-base&tab=permissions');
  const item={id:'rule',name:'撤回申请',subject:'普通申请人',subjectType:'业务职责',object:'申请',operation:'撤回',decision:'conditional',dataScope:'本人提交',conditions:'待审核',revision:'r2'};
  f.run(`renderRows([${JSON.stringify(item)}]);`);const row=f.get('delivery-table-body').children[0];assert.equal(row.children.length,8);assert.equal(row.children[0].textContent,'普通申请人');assert.equal(row.children[3].textContent,'撤回');assert.equal(row.children[4].textContent,'条件允许');assert.equal(row.children[5].textContent,'本人提交');assert.equal(row.children[6].textContent,'待审核');
  f.run("state.tab='backend';renderRows([{name:'登记档案',details:{purpose:'保存档案',method:'POST',path:'/files',internalCalls:[{secret:'NOT_A_LIST_VALUE'}]}}])");assert.doesNotMatch(f.get('delivery-table-body').textContent,/NOT_A_LIST_VALUE|\[object Object\]/);
});

// Fixed, reduced records from the installed history packet; no inferred business definitions.
const readabilitySamples = {
  "requirement": {
    "id": "forge-base:requirement:04b6bcb20c27bb9c9dde23271795c373",
    "menuIds": [
      "forge-base:menu:9899",
      "forge-base:menu:9898",
      "forge-base:menu:10070",
      "forge-base:menu:10071"
    ],
    "menuPath": [
      "环保(示例客户)",
      "环保服务商",
      "服务商资质库"
    ],
    "name": "示例客户 H5 与固定显示元数据双语 · 已确认显示元数据",
    "description": "- 资源：示例客户APP、废物称重记录、服务商考察及其 3 个按钮、2 个新增 API 固定资源；另含 V1.0.160 明确授予移动端角色的服务商分页、称重新增及考察分页/详情/新增/修改 6 个既有 API 固定资源。\n- H5 导航：`/provider`、`/provider/env`、`/plan` 三个稳定目录，以及环保服务商 8 个页面和管理计划 4 个页面；V1.0.146 明确把完整菜单树授予 8 个示例客户角色，H5 首页代码会渲染返回菜单的 `resourceName/resourceNameEn`。\n- 字典：`ai_business_app_entry_mode/H5` 的“移动端页面”，`ai_business_app_mount_target/MOBILE` 的“移动端”。\n- 后续固定组已按最终树收口：一般固废/危废过程 14 个导航、领导引领力 32 个导航、安保管理 19 个导航；逻辑删除的旧领导力页面、安保概览/一张地图不更新。\n- V1.0.20261005 已覆盖的公共固定资源/字典直接复用，不在客户迁移重复写入。PC 固定按钮/API和版本控制内固定客户字典已纳入；仅保留无稳定 path/perms 的中间分组、由管理员维护且没有固定种子值的化学品/放射物目录、用户输入/业务记录及任何已有非空英文。不据空英文统计扩写。",
    "fields": [],
    "actions": [],
    "rules": [],
    "stageStatus": {},
    "status": "documented",
    "certainty": "explicit",
    "granularity": "specification-section",
    "originalDocument": {
      "path": "code-copilot/changes/customer-bilingual-mobile-metadata/spec.md",
      "title": "示例客户 H5 与固定显示元数据双语",
      "section": "已确认显示元数据",
      "line": 22
    }
  },
  "test": {
    "description": "| 检查 | 范围 | 期望 |\n|---|---|---|\n| governance | 当前十条准入路径的实际差异 | 无新增阻断 |\n| frontend-admin-lint | 事故前端范围 | 0 error / 0 warning |\n| frontend-admin-test | `accident-bilingual-display.test.js` | 3/3 通过、0 skipped |",
    "menuIds": [],
    "menuPaths": [],
    "status": "documented",
    "certainty": "explicit",
    "assetId": "forge-base:test:641777e39a1801975c95273499144d93",
    "kind": "test",
    "name": "事故 PC 固定文案双语漏项修复 — Test Spec · 本轮必要检查",
    "details": {
      "expectedResult": "| 检查 | 范围 | 期望 |\n|---|---|---|\n| governance | 当前十条准入路径的实际差异 | 无新增阻断 |\n| frontend-admin-lint | 事故前端范围 | 0 error / 0 warning |\n| frontend-admin-test | `accident-bilingual-display.test.js` | 3/3 通过、0 skipped |",
      "actualResult": null,
      "evidence": [],
      "sourceDocument": "code-copilot/changes/accident-bilingual-display-gap-fix/test-spec.md"
    }
  },
  "entity": {
    "description": "从该代码快照中的明确声明收录；不作为原始需求、验收通过或生产上线证明。",
    "menuIds": [
      "forge-base:menu:9616"
    ],
    "menuPaths": [
      [
        "应用中心",
        "应用工作台",
        "运行应用"
      ]
    ],
    "status": "implementation-observed",
    "certainty": "implementation-derived",
    "assetId": "forge-base:entity:com.mdframe.forge.employee.entity.Employee",
    "id": "forge-base:entity:com.mdframe.forge.employee.entity.Employee",
    "kind": "entity",
    "name": "员工信息表实体类",
    "details": {
      "attributes": [
        {
          "name": "empName",
          "description": "员工信息表实体类",
          "dataType": "String",
          "isTechnical": false
        },
        {
          "name": "empNo",
          "description": "员工信息表实体类",
          "dataType": "String",
          "isTechnical": false
        },
        {
          "name": "deptId",
          "description": "员工信息表实体类",
          "dataType": "Long",
          "isTechnical": false
        },
        {
          "name": "deptIdName",
          "description": "员工信息表实体类",
          "dataType": "String",
          "isTechnical": false
        },
        {
          "name": "position",
          "description": "员工信息表实体类",
          "dataType": "String",
          "isTechnical": false
        },
        {
          "name": "hireDate",
          "description": "员工信息表实体类",
          "dataType": "LocalDateTime",
          "isTechnical": false
        },
        {
          "name": "phone",
          "description": "员工信息表实体类",
          "dataType": "String",
          "isTechnical": false
        },
        {
          "name": "email",
          "description": "员工信息表实体类",
          "dataType": "String",
          "isTechnical": false
        },
        {
          "name": "status",
          "description": "员工信息表实体类",
          "dataType": "Integer",
          "isTechnical": false
        },
        {
          "name": "statusName",
          "description": "员工信息表实体类",
          "dataType": "String",
          "isTechnical": false
        },
        {
          "name": "delFlagName",
          "description": "员工信息表实体类",
          "dataType": "String",
          "isTechnical": false
        }
      ],
      "technicalFields": [
        {
          "name": "id",
          "description": "员工信息表实体类",
          "dataType": "Long",
          "isTechnical": true
        },
        {
          "name": "tenantId",
          "description": "员工信息表实体类",
          "dataType": "Long",
          "isTechnical": true
        },
        {
          "name": "createDept",
          "description": "员工信息表实体类",
          "dataType": "Long",
          "isTechnical": true
        },
        {
          "name": "delFlag",
          "description": "员工信息表实体类",
          "dataType": "Long",
          "isTechnical": true
        },
        {
          "name": "createBy",
          "description": "实体基类",
          "dataType": "Long",
          "isTechnical": true
        },
        {
          "name": "createTime",
          "description": "实体基类",
          "dataType": "LocalDateTime",
          "isTechnical": true
        },
        {
          "name": "updateBy",
          "description": "实体基类",
          "dataType": "Long",
          "isTechnical": true
        },
        {
          "name": "updateTime",
          "description": "实体基类",
          "dataType": "LocalDateTime",
          "isTechnical": true
        }
      ]
    },
    "relations": [
      {
        "type": "maps-to-table",
        "targetId": "forge-base:table:sys_employee",
        "targetKind": "table",
        "label": "sys_employee"
      }
    ],
    "sources": [
      {
        "type": "code-snapshot",
        "path": "forge-server/forge-admin-server/src/main/java/com/mdframe/forge/employee/entity/Employee.java",
        "sha256": "ef3679d27c35475a83553646b500cf887bd030da739b9315ef7fc7b5b4003a4a",
        "digest": "ef3679d27c35475a83553646b500cf887bd030da739b9315ef7fc7b5b4003a4a",
        "commit": "34b0710eeb38467b9a6138c40c74b4f04e1caf72",
        "sourceCommit": "34b0710eeb38467b9a6138c40c74b4f04e1caf72",
        "label": "当前提交的源码定义"
      }
    ]
  }
};


test('table source strings and entity descriptions remain readable without inventing business or execution facts', async t => {
  const { deliverySummary, summaryDetailKeys } = await import('../docker/harness/delivery-center-views.mjs');
  const f = fixture(t, '?project=forge-base&tab=database');
  // Source values observed through member01 in plan.table.t_plan_item and plan.entity.plan-item.
  const table = {kind:'table',assetId:'plan.table.t_plan_item',name:'t_plan_item',nature:'implementation-observation',details:{
    comment:'计划条目',constraints:['PRIMARY KEY(id)','KEY idx_plan_item_owner(tenant_id, plan_type, plan_level, plan_id)','KEY idx_plan_item_update_time(tenant_id, update_time)'],migrations:['V1.0.145 建表']}};
  assert.ok(summaryDetailKeys().includes('comment'));
  assert.equal(deliverySummary(table).details.comment,table.details.comment);
  f.run(`renderRows([${JSON.stringify(deliverySummary(table))}]);renderDetail('assets',${JSON.stringify(table)})`);
  const listRow = () => {
    const labels=walk(f.get('delivery-table-head')).filter(e=>e.tagName==='TH').map(e=>e.textContent);
    return Object.fromEntries(f.get('delivery-table-body').children[0].children.map((cell,i)=>[labels[i],cell.textContent]));
  };
  assert.equal(listRow()['数据库原始注释'],'计划条目'); assert.equal(listRow()['业务用途'],'未记录');
  const section = title => walk(f.get('delivery-detail-body')).find(e=>e.tagName==='SECTION'&&e.children[0]?.textContent===title);
  const rows = title => walk(section(title)).find(e=>e.tagName==='TBODY').children.map(row=>row.children.map(cell=>cell.textContent));
  assert.ok(section('数据库原始注释').textContent.includes('计划条目'));
  assert.deepEqual(rows('约束与原文').map(row=>row[0]),table.details.constraints);
  assert.ok(rows('约束与原文').every(row=>row[2]==='未记录'),'SQL is not promoted into a business rule');
  assert.equal(rows('迁移声明与执行记录')[0][0],'V1.0.145 建表');
  assert.notEqual(rows('迁移声明与执行记录')[0][4],'通过');
  const structured={...table,details:{...table.details,
    constraints:[...table.details.constraints,{name:'unique_owner',rule:'fixture business rule',databaseConstraint:'UNIQUE(owner_id)'}],
    migrations:[...table.details.migrations,{name:'V2.sql',environment:'test',status:'passed',executedAt:'2026-10-09T00:00:00Z'}]}};
  f.run(`renderDetail('assets',${JSON.stringify(structured)})`);
  assert.deepEqual(rows('约束与原文')[3].slice(0,5),['未记录','unique_owner','fixture business rule','未记录','UNIQUE(owner_id)']);
  assert.equal(rows('迁移声明与执行记录')[1][1],'V2.sql'); assert.equal(rows('迁移声明与执行记录')[1][3],'测试');
  const entity={kind:'entity',assetId:'plan.entity.plan-item',name:'计划条目',nature:'implementation-observation',description:'部门、厂级、公司级计划共用的废物明细条目；当前可观察页面主要用于部门计划编辑。'};
  f.run(`state.tab='entities';renderRows([${JSON.stringify(deliverySummary(entity))}]);renderDetail('assets',${JSON.stringify(entity)})`);
  assert.equal(listRow()['来源描述（未确认业务含义）'],entity.description); assert.equal(listRow()['业务含义'],'未记录');
  assert.ok(section('来源描述（未确认业务含义）').textContent.includes(entity.description));
  const longEntity={...entity,description:entity.description.repeat(12)};
  const longConstraint=table.details.constraints[1].repeat(8);
  const longTable={...table,details:{...table.details,comment:table.details.comment.repeat(150),constraints:[longConstraint]}};
  f.run(`renderDetail('assets',${JSON.stringify(longEntity)})`);
  assert.ok(section('来源描述（未确认业务含义）').textContent.includes(longEntity.description));
  f.run(`renderDetail('assets',${JSON.stringify(longTable)})`);
  assert.ok(section('数据库原始注释').textContent.includes(longTable.details.comment));
  assert.equal(rows('约束与原文')[0][0],longConstraint);
});


test('test and permission source strings remain readable without promoting historical reports or design into verified facts', t => {
  const f = fixture(t, '?project=forge-base&tab=test-materials');
  const plan = { kind: 'test', assetId: 'accident.test.module-plan', name: '事故模块增量验证计划', nature: 'historical-compilation', details: {
    testCases: ['Flyway占位符扫描', 'forge-business-core编译', '事故Vitest', '前端构建', '条件允许的迁移/API/流程联调'], executionState: 'not-run-this-round' } };
  const section = title => walk(f.get('delivery-detail-body')).find(e => e.tagName === 'SECTION' && e.children[0]?.textContent === title);
  const rows = title => walk(section(title)).find(e => e.tagName === 'TBODY').children.map(row => row.children.map(cell => cell.textContent));
  f.run(`renderDetail('assets',${JSON.stringify(plan)})`);
  assert.deepEqual(rows('测试用例').map(row => row[0]), plan.details.testCases);
  assert.ok(rows('测试用例').every(row => row.slice(1).every(cell => cell === '未记录')));
  assert.equal(rows('本轮执行状态（原文）')[0][0], 'not-run-this-round');
  assert.ok(section('实际结果').textContent.includes('未关联执行结果'));
  const structured = { ...plan, details: { ...plan.details, testCases: [...plan.details.testCases,
    { name: '明确用例', goal: '原验证目标', operation: '原操作', expectedResult: '原预期' }] } };
  f.run(`renderDetail('assets',${JSON.stringify(structured)})`);
  assert.deepEqual(rows('测试用例')[5], ['明确用例', '原验证目标', '未记录', '未记录', '未记录', '原操作', '原预期']);
  const historical = { kind: 'test', assetId: 'accident.test.historical-batches', name: '事故批次历史执行', nature: 'execution', details: {
    reportedResults: ['批次A：后端编译、eslint、11/11 Vitest、Vite构建被日志记为成功', '批次B/C/D：后端编译、eslint、12/12 Vitest、Vite构建被日志记为成功', '日志记录 release ID、迁移和部分接口200'],
    limitations: ['仅历史手写记录', '200不证明完整业务行为'] } };
  f.run(`renderDetail('assets',${JSON.stringify(historical)})`);
  assert.deepEqual(rows('历史报告原文（不代表本轮执行）').map(row => row[0]), historical.details.reportedResults);
  assert.deepEqual(rows('记录适用限制').map(row => row[0]), historical.details.limitations);
  assert.ok(section('实际结果').textContent.includes('未关联执行结果'));
  assert.ok(section('采用、实现、验证与发布依据').textContent.includes('尚未关联依据'));
  assert.equal(section('执行记录'), undefined);
  const permission = { kind: 'permission', assetId: 'leadership.permission.module-rbac', name: '领导引领力页面与接口权限', nature: 'design', details: {
    roles: ['admin', 'deptMgr', 'superMgr', 'ehssTech', 'ehssMgr', 'ccInspector', 'dept', 'hse', 'leader'],
    permissionCodes: ['business:leadership:actionplan:api:page', 'business:leadership:actionplan:api:save', 'business:leadership:targettask:api:page', 'business:leadership:targettask:api:save', 'business:leadership:orgchart:api:page', 'business:leadership:orgchart:api:save', 'business:leadership:taskexec:api:page', 'business:leadership:taskexec:api:tasks', 'business:leadership:taskexec:api:save'],
    tenantScope: '迁移种子 tenant_id=1；运行查询仍依赖租户拦截和 Mapper 条件，未做本轮动态验证。' } };
  f.run(`state.tab='permissions';renderDetail('assets',${JSON.stringify(permission)})`);
  assert.deepEqual(rows('资料列明角色').map(row => row[0]), permission.details.roles);
  assert.deepEqual(rows('资料列明权限码').map(row => row[0]), permission.details.permissionCodes);
  assert.equal(rows('资料中的租户范围说明')[0][0], permission.details.tenantScope);
  assert.equal(section('权限规则'), undefined); assert.equal(section('实际验证'), undefined);
});


test('collection itemAttributes keep four sourced children under page and entity parents without recursive or duplicate schemas', t => {
  const f = fixture(t, '?project=forge-base&tab=pages');
  const parent = {"name": "containers", "itemAttributes": [{"name": "containerType", "sources": [{"path": "forge-admin-ui/src/views/sampleco-app/weigh.vue", "lines": "165-170,541-543"}], "businessMeaning": "容器类型；对应 c.containerType。"}, {"name": "containerMaterial", "sources": [{"path": "forge-admin-ui/src/views/sampleco-app/weigh.vue", "lines": "172-175,541-544"}], "businessMeaning": "容器材质；对应 c.containerMaterial。"}, {"name": "containerQty", "sources": [{"path": "forge-admin-ui/src/views/sampleco-app/weigh.vue", "lines": "176-182,286-298,541-545"}], "businessMeaning": "容器数量；对应 c.containerQty，新重复项初值为 1。"}, {"name": "containerWeight", "sources": [{"path": "forge-admin-ui/src/views/sampleco-app/weigh.vue", "lines": "184-190,541-546"}], "businessMeaning": "单个容器重量；对应 c.containerWeight，页面标签标示为吨。"}], "businessMeaning": "危废容器重复项集合；每项按页面和提交载荷保留四个同名子属性，不拆成物理列。"};
  const title = '集合项子属性（不代表顶级属性或物理列）';
  const sections = () => walk(f.get('delivery-detail-body')).filter(e => e.tagName === 'SECTION');
  const section = name => sections().find(e => e.children[0]?.textContent === name);
  const rows = name => walk(section(name)).find(e => e.tagName === 'TBODY').children.map(row => row.children.map(cell => cell.textContent));
  // An additional nested item is outside this deliberately single-level schema.
  parent.itemAttributes[0].itemAttributes = [{ name: 'not-a-top-level-or-second-level-row' }];
  const original = JSON.stringify(parent);
  for (const [kind, key, topTitle] of [['page', 'formFields', '表单字段与校验'], ['entity', 'attributes', '业务属性']]) {
    const item = { kind, assetId: `fixture.${kind}.weighing`, name: '称重资料', nature: 'design', details: { [key]: [parent] } };
    f.run(`renderDetail('assets',${JSON.stringify(item)})`);
    assert.equal(rows(topTitle).length, 1); assert.equal(rows(topTitle)[0][0], 'containers');
    assert.equal(sections().filter(e => e.children[0]?.textContent === title).length, 1);
    const children = rows(title); assert.equal(children.length, 4);
    parent.itemAttributes.forEach((child, index) => {
      assert.equal(children[index][0], 'containers'); assert.equal(children[index][1], child.name);
      assert.equal(children[index][2], child.businessMeaning);
      const path = `/details/${key}/0/itemAttributes/${index}`;
      assert.equal(children[index][3], path);
      assert.ok(children[index][4].includes(child.sources[0].path)); assert.ok(children[index][4].includes(child.sources[0].lines));
      assert.ok(f.run(`state.detailAnchors.has(${JSON.stringify(path)})`));
    });
    assert.ok(children.every(row => !row.includes('not-a-top-level-or-second-level-row')));
    assert.equal(section('物理字段'), undefined);
  }
  assert.equal(JSON.stringify(parent), original);
});


test('entity and table relationship source refs and model mappings stay visible without inferred revisions or fields', async t => {
  const f = fixture(t, '?project=forge-base&tab=entities');
  const entity = {"kind": "entity", "assetId": "plan.entity.dept-plan", "name": "部门年度计划", "revision": "bf2a6e5f7406a085ac4ada9101923b6e8a6f60504f50aa83910e5132c659c80b", "details": {"relationships": [{"type": "has-many", "sources": [{"path": "forge-server/db/migration/V1.0.145__add_plan_management_module.sql", "commit": "unknown", "locator": "lines 54-61"}], "targetRef": {"id": "plan.entity.plan-item", "kind": "entity", "revision": null}, "conditions": "plan_type + plan_level + plan_id + version"}, {"type": "has-many", "sources": [{"path": "forge-server/db/migration/V1.0.145__add_plan_management_module.sql", "commit": "unknown", "locator": "lines 133-149"}], "targetRef": {"id": "plan.entity.approval-flow", "kind": "entity", "revision": null}, "conditions": "parent_type=plan_hw/plan_sw + parent_id"}, {"type": "has-many", "sources": [{"path": "forge-server/db/migration/V1.0.145__add_plan_management_module.sql", "commit": "unknown", "locator": "lines 178-196"}], "targetRef": {"id": "plan.entity.plan-history", "kind": "entity", "revision": null}, "conditions": "plan_type + plan_id"}], "modelMappings": [{"tableRef": {"id": "plan.table.t_hw_dept_plan", "kind": "table", "revision": null}, "condition": "planType=hw"}, {"tableRef": {"id": "plan.table.t_sw_dept_plan", "kind": "table", "revision": null}, "condition": "planType=sw"}]}};
  const section = title => walk(f.get('delivery-detail-body')).find(e => e.tagName === 'SECTION' && e.children[0]?.textContent === title);
  const rows = title => walk(section(title)).find(e => e.tagName === 'TBODY').children.map(row => row.children.map(cell => cell.textContent));
  f.run(`renderDetail('assets',${JSON.stringify(entity)})`);
  const relations = rows('对象逻辑关系'); assert.equal(relations.length, 3);
  entity.details.relationships.forEach((relation, index) => {
    assert.ok(relations[index][0].includes(entity.name)); assert.equal(relations[index][1], 'has-many');
    assert.ok(relations[index][2].includes(relation.targetRef.id)); assert.equal(relations[index][3], '未记录');
    assert.equal(relations[index][4], relation.conditions); assert.ok(relations[index][6].includes(relation.sources[0].path));
  });
  const mappings = rows('数据库保存映射'); assert.equal(mappings.length, 2);
  assert.ok(mappings[0][0].includes(entity.name)); assert.ok(mappings[0][1].includes('plan.table.t_hw_dept_plan'));
  assert.equal(mappings[0][2], '未记录'); assert.equal(mappings[0][3], '未记录');
  assert.deepEqual(mappings.map(row => row[4]), ['planType=hw', 'planType=sw']);
  const target = walk(section('数据库保存映射')).find(e => e.tagName === 'BUTTON' && e.getAttribute('aria-label')?.includes('plan.table.t_hw_dept_plan'));
  assert.ok(target); target.click(); await tick();
  assert.ok(f.get('delivery-detail-body').textContent.includes('目标修订未明确'));
  assert.ok(f.requests.every(request => !request.url.includes('/assets/')),'unknown target must not silently open latest asset');
  const table = { kind: 'table', assetId: 'plan.table.t_plan_item', name: 't_plan_item', revision: 'table-source-r1', details: {
    relationships: [{ type: 'has-many', targetRef: { kind: 'table', id: 'related.table', revision: null }, condition: 'source condition', sources: [{ path: 'migration.sql' }] }],
    modelMappings: [{ entityRef: { kind: 'entity', id: 'plan.entity.plan-item', revision: null }, tableRef: { kind: 'table', id: 'plan.table.t_plan_item', revision: null }, condition: 'source mapping condition' }] } };
  f.run(`renderDetail('assets',${JSON.stringify(table)})`);
  const tableRelations = rows('表逻辑关系')[0]; assert.ok(tableRelations[0].includes('t_plan_item')); assert.ok(tableRelations[2].includes('related.table'));
  assert.equal(tableRelations[5], 'has-many'); assert.equal(tableRelations[6], '未记录'); assert.equal(tableRelations[7], 'source condition'); assert.equal(tableRelations[8], '未记录');
  const tableMap = rows('业务模型映射')[0]; assert.ok(tableMap[0].includes('plan.entity.plan-item')); assert.ok(tableMap[2].includes('plan.table.t_plan_item'));
  assert.equal(tableMap[1], '未记录'); assert.equal(tableMap[3], '未记录'); assert.equal(tableMap[5], 'source mapping condition');
});


test('relationship diagrams coexist safely with attribute diagrams and release services remain source declarations', async t => {
  const f = fixture(t, '?project=forge-base&tab=entities');
  f.run(`let diagramCalls=[];diagramRenderer=async()=>({render:async(id,source)=>{diagramCalls.push({id,source});return {svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>diagram</text></svg>'}}});$('delivery-detail').showModal()`);
  const item = {kind:'entity',assetId:'entity-one',name:'对象',diagram:{type:'erDiagram',source:'erDiagram\n A { string id }'},relationshipDiagram:{type:'flowchart',source:'flowchart LR\n A --> B',sourceRefs:[{path:'migration.sql',locator:'lines 54-61'}],notes:'目标修订与完整基数未明确，不表示物理外键。'}};
  f.run(`renderDetail('assets',${JSON.stringify(item)})`); await tick();
  const sections = () => walk(f.get('delivery-detail-body')).filter(e=>e.tagName==='SECTION');
  const section = name => sections().find(e=>e.children[0]?.textContent===name);
  assert.ok(walk(section('业务实体关系图')).some(e=>e.tagName==='IMG'));
  const relationship = section('业务对象关联图'); assert.ok(walk(relationship).some(e=>e.tagName==='IMG'&&e.alt==='业务对象关联图'));
  assert.ok(relationship.textContent.includes(item.relationshipDiagram.notes)); assert.ok(relationship.textContent.includes('migration.sql')); assert.ok(relationship.textContent.includes('lines 54-61'));
  assert.equal(f.run('diagramCalls.length'),2); assert.equal(new Set(f.run('diagramCalls.map(value=>value.id)')).size,2);
  f.run(String.raw`appendDiagram($('delivery-detail-body'),{type:'flowchart',source:'flowchart LR\n click A "https://invalid.example"'},'拒绝不安全图')`);
  assert.ok(section('拒绝不安全图').textContent.includes('不符合安全')); assert.equal(f.run('diagramCalls.length'),2);
  f.run(String.raw`let pendingDiagram;let closedCalls=0;diagramRenderer=()=>new Promise(resolve=>{pendingDiagram=resolve});appendDiagram($('delivery-detail-body'),{type:'flowchart',source:'flowchart LR\n A --> B'});closeDetail();pendingDiagram({render:async()=>{closedCalls++;return {svg:'<svg/>'}}})`); await tick();
  assert.equal(f.run('closedCalls'),0);
  f.run(`renderDetail('releases',{id:'release-one',services:['admin','ui']})`);
  const services = section('本次发布组件（记录原文）');
  assert.deepEqual(walk(services).find(e=>e.tagName==='TBODY').children.map(row=>row.children[0].textContent),['admin','ui']);
  assert.equal(section('组件与实际制品'),undefined);
  assert.ok(section('发布尝试').textContent.includes('未确认'));
});


test('stage current and historical scope survives URL navigation and exposes source tasks and summaries without acceptance inflation', async t => {
  const f = fixture(t, '?project=forge-base&tab=stages&page=3');
  assert.equal(f.get('delivery-stage-record-scope').value, 'true');
  f.run('loadList()');
  assert.equal(new URL(f.requests[0].url,'http://local').searchParams.get('isCurrent'),'true');
  await f.reply(0,{items:[{id:'stage-a',phaseId:'requirements',status:'accepted',taskId:'task-original',summary:'原阶段业务说明',digest:'a'.repeat(64)}],total:60,page:3,pageSize:20});
  const headers = f.get('delivery-table-head').children[0].children.map(cell=>cell.textContent);
  const row = Object.fromEntries(f.get('delivery-table-body').children[0].children.map((cell,index)=>[headers[index],cell.textContent]));
  assert.equal(row['来源任务'],'task-original'); assert.equal(row['阶段说明'],'原阶段业务说明'); assert.equal(row['原始阶段状态'],'阶段已接受');
  assert.equal(headers.includes('已收录产物数'),false); assert.equal(headers.includes('阶段验收结论'),false); assert.ok(!Object.values(row).includes('a'.repeat(64)));
  const select = f.get('delivery-stage-record-scope'); select.value='false';select.dispatchEvent(new Event('change'));await tick();
  const query = new URL(f.requests.at(-1).url,'http://local').searchParams;
  assert.equal(query.get('isCurrent'),'false');assert.equal(query.get('page'),'1');
  assert.equal(new URLSearchParams(f.window.location.search).get('isCurrent'),'false');
  assert.equal(f.run('readLocation().isCurrent'),'false');
  await f.reply(f.requests.length-1,{items:[],total:0,page:1,pageSize:20});
  const restored = fixture(t,'?project=forge-base&tab=stages&isCurrent=false&page=2');
  assert.equal(restored.get('delivery-stage-record-scope').value,'false');
  const current = restored.get('delivery-stage-record-scope');current.value='true';current.dispatchEvent(new Event('change'));await tick();
  assert.equal(new URL(restored.requests.at(-1).url,'http://local').searchParams.get('isCurrent'),'true');
  assert.equal(new URLSearchParams(restored.window.location.search).get('page'),'1');
  restored.run("navigate({tab:'pages',page:1})");
  assert.equal(new URL(restored.requests.at(-1).url,'http://local').searchParams.has('isCurrent'),false);
  const detailFixture = fixture(t,'?project=forge-base&tab=stages&isCurrent=false');
  const snapshot = 'b'.repeat(64); const summary = {id:'stage-history',phaseId:'requirements',status:'accepted',revision:snapshot,summary:'摘要'};
  detailFixture.run(`openRecord(${JSON.stringify(summary)})`);
  const detailUrl = new URL(detailFixture.requests[0].url,'http://local');
  assert.equal(detailUrl.pathname,'/forge-gateway/api/delivery/stages/stage-history');assert.equal(detailUrl.searchParams.get('revision'),snapshot);
  const original = {...summary,taskId:'original-task',digest:'c'.repeat(64),details:{historicalSource:'准确历史原件'}};
  await detailFixture.reply(0,{item:original});
  assert.ok(detailFixture.get('delivery-detail-body').textContent.includes('准确历史原件'));assert.ok(detailFixture.get('delivery-detail-body').textContent.includes('阶段已接受'));
  assert.equal(new URLSearchParams(detailFixture.window.location.search).get('focusKind'),'stage');assert.equal(new URLSearchParams(detailFixture.window.location.search).get('focusRevision'),snapshot);
  detailFixture.run(`showDetail('stages',${JSON.stringify(summary)})`);await tick();assert.equal(detailFixture.requests.length,1,'same snapshot cache reused');
  detailFixture.run("showDetail('stages',{id:'missing-revision'})");await tick();assert.equal(detailFixture.requests.length,1,'missing revision does not select current record');
  detailFixture.run(`showDetail('stages',{...${JSON.stringify(summary)},revision:'d'.repeat(64)})`);
  assert.equal(new URL(detailFixture.requests[1].url,'http://local').searchParams.get('revision'),'d'.repeat(64));
  await detailFixture.reply(1,{item:original});assert.ok(detailFixture.get('delivery-detail-body').textContent.includes('快照修订不匹配'));
});


test('production is the fifth same-page release subview and does not call the reader for a fake view', async t => {
  const f = fixture(t, '?project=foundation-32148&tab=production&menuId=old');
  assert.deepEqual(Array.from(f.run('subviews.releases')), ['releases', 'business-versions', 'artifacts', 'environments', 'production']);
  await f.run('loadList()');
  assert.equal(f.get('delivery-reader-panel').hidden, true); assert.equal(f.get('delivery-menu-panel').hidden, true);
  assert.equal(f.get('delivery-context').hidden, true); assert.equal(f.requests.length, 0);
  assert.ok(f.productionCalls.some(call => call[0] === 'project' && call[1] === 'foundation-32148'));
  assert.ok(f.productionCalls.some(call => call[0] === 'active' && call[1] === true));
  assert.doesNotMatch(markup, /<iframe|href="\/forge-gateway\/production-delivery/);
});

test('only image rows open export with their exact artifact and success stays in the center production tab', async t => {
  const f = fixture(t, '?project=foundation-32148&tab=artifacts');
  f.run("renderRows([{id:'exact-image-id',type:'container-image',name:'服务镜像',digest:'sha256:abc'},{id:'log',type:'release-log',name:'日志'}])");
  const actions = walk(f.get('delivery-table-body')).filter(el => el.tagName === 'BUTTON' && el.textContent === '导出生产包');
  assert.equal(actions.length, 1); actions[0].click(); await tick();
  assert.equal(f.productionCalls.find(call => call[0] === 'export')[1].id, 'exact-image-id');
  assert.equal(f.navigations.length, 0); assert.equal(f.requests.length, 0);
  await f.productionCreated(); assert.equal(f.run('state.tab'), 'production');
  assert.equal(f.window.location.pathname, '/forge-gateway/delivery-center');
  assert.equal(new URLSearchParams(f.window.location.search).get('tab'), 'production');
});

test('changing project during production mount cannot open an old image export', async t => {
  const f = fixture(t, '?project=foundation-32148&tab=artifacts');
  f.run("let releaseMount; mountProductionDelivery=()=>new Promise(resolve=>releaseMount=resolve)");
  const pending = f.run("openProductionExport({id:'old-image',type:'container-image'})");
  f.run("state.project='other-project';releaseMount({setProject:async()=>{throw new Error('old project used')},openExport:async()=>{throw new Error('old image used')}})");
  await pending; assert.equal(f.requests.length, 0); assert.equal(f.navigations.length, 0);
});


test('artifact export summaries bind exact IDs, show full actor time, and open the same-page record', async t => {
  const f = fixture(t, '?project=foundation-32148&tab=artifacts'); const loading = f.run('loadList()');
  await f.reply(0, { items: [{ id: 'image-a', type: 'container-image', name: '镜像甲', digest: 'sha256:same' }, { id: 'image-b', type: 'container-image', name: '镜像乙', digest: 'sha256:same' }], total: 2 }); await loading;
  assert.equal(f.get('delivery-table-wrap').hidden, false); assert.match(f.get('delivery-table-body').textContent, /正在读取生产导出记录/);
  assert.equal(new URL(f.requests[1].url, 'http://example').pathname, '/forge-gateway/api/production/releases');
  assert.equal(new URL(f.requests[1].url, 'http://example').searchParams.get('project'), 'foundation-32148');
  await f.reply(1, { items: [{ id: 'release-a', jobs: [{ id: 'full', mode: 'initial', sourceArtifact: { id: 'image-a' }, createdBy: { displayName: '张实施' }, createdAt: '2026-10-15T01:00:00Z' }, { id: 'incremental', mode: 'upgrade', sourceArtifact: { id: 'image-a' }, createdBy: { displayName: '李运维' }, createdAt: '2026-10-15T02:00:00Z' }, { id: 'legacy', mode: 'initial', sourceArtifact: null, createdBy: { displayName: '不得猜关联' }, createdAt: '2026-10-15T03:00:00Z' }] }] });
  const rows = f.get('delivery-table-body').children;
  assert.match(rows[0].textContent, /已导出 2 次（全量 1 次）.*最近增量：李运维.*最近全量：张实施/s);
  assert.match(rows[0].textContent, /2026/); assert.doesNotMatch(rows[0].textContent, /不得猜关联/);
  assert.match(rows[1].textContent, /本行暂无关联导出记录/); assert.doesNotMatch(rows[1].textContent, /从未导出/);
  walk(rows[0]).find(el => el.tagName === 'BUTTON' && el.textContent === '查看导出记录').click(); await tick();
  assert.equal(f.run('state.tab'), 'production'); assert.ok(f.productionCalls.some(call => call[0] === 'job' && call[1] === 'release-a' && call[2] === 'incremental')); assert.equal(f.navigations.length, 0);
});

test('artifact history failure is nonblocking and late project responses never replace current summaries', async t => {
  const f = fixture(t, '?project=foundation-32148&tab=artifacts');
  f.run("renderRows([{id:'image-a',type:'container-image',name:'原制品'}])"); const failed = f.run('loadArtifactExports()');
  await f.reply(0, { message: '暂不可用' }, 503); await failed;
  assert.match(f.get('delivery-table-body').textContent, /原制品.*生产导出记录未能读取/s); assert.equal(f.get('delivery-list-error').hidden, true);
  const stale = f.run('loadArtifactExports()');
  f.run("state.project='other-project';artifactExportState={project:'other-project',status:'ready',rows:[]};renderRows([{id:'image-b',type:'container-image',name:'新项目制品'}])");
  await f.reply(1, { items: [{ id: 'old', jobs: [{ id: 'j', mode: 'initial', sourceArtifact: { id: 'image-b' }, createdBy: { displayName: '旧响应不应显示' } }] }] }); await stale;
  assert.match(f.get('delivery-table-body').textContent, /新项目制品.*本行暂无关联导出记录/s); assert.doesNotMatch(f.get('delivery-table-body').textContent, /旧响应不应显示/);
  f.run("state.tab='requirements'"); await f.run('loadArtifactExports()'); assert.equal(f.requests.length, 2);
});

test('artifact version dates use exact source releases and sort only the loaded page newest first', async t => {
  const f = fixture(t, '?project=foundation-32148&tab=artifacts'); const loading = f.run('loadList()');
  await f.reply(0, { items: [
    { id: 'old-image', type: 'container-image', name: '旧镜像', releaseId: 'old-release' },
    { id: 'unknown-image', type: 'container-image', name: '时间缺失镜像', version: '2099-01-01', commit: '2026123112345678901234567890123456789012', releaseId: 'unknown-release' },
    { id: 'new-image', type: 'container-image', name: '新镜像', releaseIds: ['new-release'] },
    { id: 'same-version-ui', type: 'container-image', name: '同版本前端', releaseId: 'new-release', releaseIds: ['new-release'] },
  ], total: 80 });
  assert.equal(f.requests.length, 4, 'only the three distinct referenced releases are fetched, not other artifact pages');
  for (const request of f.requests.slice(1)) assert.equal(new URL(request.url, 'http://example').searchParams.get('project'), 'foundation-32148');
  assert.equal(new URL(f.requests[1].url, 'http://example').pathname, '/forge-gateway/api/delivery/releases/old-release');
  await f.reply(1, { item: { id: 'old-release', releasedAt: '2026-10-12T01:00:00Z' } });
  await f.reply(2, { item: { id: 'unknown-release', commit: '20261231', version: '2099-01-01' } });
  await f.reply(3, { item: { id: 'new-release', startedAt: '2026-10-15T02:00:00Z' } }); await loading;
  const rows = f.get('delivery-table-body').children;
  assert.deepEqual(rows.map(row => row.children[0].textContent), ['新镜像', '同版本前端', '旧镜像', '时间缺失镜像']);
  assert.match(rows[0].children[3].textContent, /2026.*10.*15.*10:00.*来源发布开始/);
  assert.match(rows[2].children[3].textContent, /2026.*10.*12.*09:00.*来源发布结束/);
  assert.equal(rows[3].children[3].textContent, '未记录'); assert.equal(f.run('state.total'), 80);
  assert.match(f.run('deliveryTabs.artifacts.help'), /当前页/); assert.match(f.run('deliveryTabs.artifacts.help'), /不等于镜像构建时间/);
  assert.equal(f.requests.length, 5); assert.equal(new URL(f.requests[4].url, 'http://example').pathname, '/forge-gateway/api/production/releases');
});

test('artifact date fallback labels actual record updates and does not infer missing dates from tags', t => {
  const f = fixture(t, '?project=foundation-32148&tab=artifacts');
  f.run("renderRows([{id:'unknown',type:'container-image',name:'未知日期',version:'2099-12-31',commit:'20261231',createdAt:'bad-date'},{id:'recorded',type:'container-image',name:'已收录',recordedAt:'2026-10-12T00:00:00Z'},{id:'updated',type:'container-image',name:'已有更新时间',updatedAt:'2026-10-15T00:00:00Z'}])");
  const rows = f.get('delivery-table-body').children;
  assert.deepEqual(rows.map(row => row.children[0].textContent), ['已有更新时间', '已收录', '未知日期']);
  assert.match(rows[0].children[3].textContent, /记录更新时间/); assert.match(rows[1].children[3].textContent, /收录时间/);
  assert.equal(rows[2].children[3].textContent, '未记录');
});

test('artifact source time failure preserves the list and aborted project reads cannot replace new rows', async t => {
  const f = fixture(t, '?project=foundation-32148&tab=artifacts'); const loading = f.run('loadList()');
  await f.reply(0, { items: [{ id: 'image', type: 'container-image', name: '可继续导出', releaseId: 'release' }], total: 1 });
  await f.reply(1, { message: '暂不可用' }, 503); await loading;
  assert.equal(f.get('delivery-table-wrap').hidden, false); assert.equal(f.get('delivery-list-error').hidden, true);
  assert.match(f.get('delivery-table-body').textContent, /可继续导出.*来源时间未能读取.*导出生产包/s);
  const stale = f.run('loadList()');
  await f.reply(3, { items: [{ id: 'old-image', type: 'container-image', name: '旧项目镜像', releaseId: 'old-release' }], total: 1 });
  f.run("state.listRequest.abort();state.project='other-project';renderRows([{id:'new-image',type:'container-image',name:'新项目镜像'}])");
  await f.reply(4, { item: { id: 'old-release', releasedAt: '2026-10-15T00:00:00Z' } }); await stale;
  assert.match(f.get('delivery-table-body').textContent, /新项目镜像/); assert.doesNotMatch(f.get('delivery-table-body').textContent, /旧项目镜像|来源发布结束/);
});
