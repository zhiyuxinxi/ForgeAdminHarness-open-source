import { mountProductionDelivery } from './production-delivery.js';
import { deliveryTabs, subviews, enumNames, detailSchemas } from './delivery-center-views.js';
const kindTabs = { menu: 'menus', requirement: 'requirements', function: 'overview', scene: 'scenes', entity: 'entities', table: 'database', page: 'pages', api: 'backend', permission: 'permissions', test: 'acceptance', rule: 'rules', task: 'tasks', dictionary: 'dictionaries', release: 'releases', artifact: 'artifacts', stage: 'stages', batch: 'batches' };
const phaseNames = { requirements: '需求', 'domain-contract': '领域与 API 合同', database: '数据库', 'ui-design': 'UI 设计', backend: '后端实现', frontend: '前端实现', 'access-wiring': '权限接线', 'cross-layer-acceptance': '跨层验收' };
const statusNames = { unknown: '未验证', pending: '待处理', draft: '草案', recorded: '已收录', captured: '已收录', unverified: '未验证', not_started: '未开始', in_progress: '进行中', implemented: '已实现', verified: '已验证', accepted: '已通过', passed: '已通过', completed: '已完成', partial: '部分完成', blocked: '受阻', failed: '未通过', rejected: '未通过', prepared: '候选已准备', staged: '待发布', deployed: '已部署', published: '已发布', released: '已发布', succeeded: '执行成功', success: '执行成功', superseded: '已有更新版本', archived: '已归档', current: '当前记录', historical: '历史记录', candidate: '候选版本' };
const fieldNames = { id: '编号', name: '名称', label: '名称', title: '标题', description: '说明', summary: '摘要', page: '页面', menuId: '菜单编号', menuPath: '菜单路径', type: '类型', dataType: '数据类型', required: '必填', defaultValue: '默认值', value: '内容', key: '字段', code: '编码', field: '字段', fieldName: '字段名称', validation: '校验规则', options: '选项', status: '状态', phaseId: '阶段', batchId: '批次编号', stageId: '成果编号', digest: '内容摘要', sourceDigest: '来源摘要', createdAt: '形成时间', updatedAt: '更新时间', releasedAt: '发布时间', revision: '修订号', version: '版本', commit: '代码提交', frontendCommit: '前端提交', backendCommit: '后端提交', environment: '目标环境', source: '来源', sourceType: '来源类型', sourceLabel: '来源说明', sourceConversationId: '来源对话编号', conversationId: '对话编号', isCurrent: '是否当前成果', requirementIds: '关联需求编号', artifactIds: '关联制品编号', releaseId: '发布编号', releaseIds: '关联发布编号', bytes: '字节数', size: '大小', mediaType: '文件类型', image: '镜像', imageDigest: '镜像摘要', tag: '标签', ref: '引用', path: '相对位置', permission: '权限', result: '结果', notes: '说明', method: '操作方式', rule: '规则', condition: '条件', expected: '预期结果', actual: '实际结果', content: '内容', format: '格式', endpoint: '接口', detail: '详情', reason: '原因' };
Object.assign(statusNames, { documented: '已有需求依据', conflict: '需求存在差异', 'in-progress': '进行中', 'not-recorded': '未收录', interrupted: '已中断', ready: '可查看' });
Object.assign(fieldNames, { taskId: '交付任务编号', sessionId: '来源对话编号', sourceCommit: '来源提交', reference: '制品引用', fields: '页面字段', actions: '页面操作', rules: '业务规则', permissions: '权限要求', actors: '业务角色', useCases: '业务场景', businessRules: '业务规则', acceptanceCriteria: '验收标准', nonGoals: '不包含的范围', dataOwnership: '数据归属', permissionMatrix: '权限矩阵', requirementTrace: '需求追踪', businessEntities: '业务对象', commands: '业务操作', queries: '查询', apiContracts: '接口合同', permissionCodes: '权限编码', dictionaries: '业务字典', validationRules: '校验规则', concurrencyRules: '并发规则', migrationVersion: '数据版本', tables: '数据表', indexes: '索引', tenantAuditDeleteContract: '租户、审计与删除规则', dictionaryExcelSeed: '字典初始数据', migrationTest: '数据变更验证', pageMode: '页面类型', canonicalOwners: '共用组件', states: '页面状态', responsiveRules: '窄屏适配规则', accessibilityRules: '可访问性规则', apiBindings: '接口关联', permissionBindings: '权限关联', redTests: '问题复现测试', apiImplementation: '接口实现', persistenceOutcomeHandling: '保存结果处理', permissionEnforcement: '权限落实', canonicalComponentOwners: '共用组件', apiAdapter: '接口适配', pageImplementation: '页面实现', longIdContract: '编号精度规则', interactionStates: '交互状态', menuSeed: '菜单初始数据', buttonSeed: '按钮初始数据', apiResourceSeed: '接口资源初始数据', roleVisibilityContract: '角色可见性规则', permissionCoherence: '权限一致性', requirementCoverage: '需求覆盖情况', tenantAuditDeleteEvidence: '租户、审计与删除证据', apiUiCoherence: '接口与页面一致性', longIdEvidence: '编号精度验证', testEvidence: '测试证据', runtimeEvidenceDigest: '运行证据摘要', semanticReview: '业务语义复核', cannotClaim: '尚不能确认的事项', requirements: '需求', features: '功能点', menus: '菜单', pages: '页面', requirementMatrix: '需求矩阵', requirement: '需求', criterion: '标准', contract: '规则', outcome: '结果', businessResult: '业务结果', wireType: '传输类型', editType: '输入类型', search: '查询条件', column: '列表列', maxLength: '最大长度', minLength: '最小长度', nullable: '允许为空', primaryKey: '主键', note: '说明', scope: '范围', dataScope: '数据范围', roleKey: '角色编码', roleName: '角色名称', roles: '角色', businessRoles: '业务角色', capabilities: '业务能力', operations: '操作', perms: '权限', route: '页面路由', pageName: '页面名称', parentId: '上级编号', resourceName: '资源名称', resourceType: '资源类型', component: '组件', sort: '顺序', buttons: '按钮', definitions: '定义', entities: '业务对象', endpoints: '接口', owners: '归属', children: '下级', items: '明细', matrix: '矩阵', feature: '功能点', functionName: '功能名称', featureId: '功能编号', requirementId: '需求编号', loading: '加载状态', empty: '空状态', error: '错误状态', readonly: '只读状态', busy: '处理中', permissionMissing: '缺少权限', keyboard: '键盘操作', narrow: '窄屏', searchFields: '查询字段', columnProps: '列表字段', editFields: '表单字段', authoritativeInputs: '确认依据', correctedInterpretations: '已修正的理解', externalDependencies: '外部依赖', nextStageGate: '下一阶段条件', references: '关联资料' });
Object.assign(fieldNames, { assetId: '记录编号', kind: '内容类型', menuIds: '关联菜单', menuPaths: '菜单路径', batchIds: '需求批次', recordedAt: '收录时间', sourceRevision: '来源版本', certainty: '依据状态', details: '详细说明', relations: '业务关联', commits: '代码提交', revisions: '历史版本', sourceRefs: '来源依据', targetId: '关联记录', targetKind: '关联类型', cardinality: '关系数量', usedByMenus: '使用菜单', logicalRelations: '业务逻辑关系', relationships: '实体关系', attributes: '业务属性', properties: '业务属性', businessMeaning: '业务含义', workflow: '业务流程', workflowUsed: '涉及流程', usesWorkflow: '涉及流程', taskEngine: '任务引擎', taskEngineUsed: '使用任务引擎', usesTaskEngine: '使用任务引擎', steps: '处理步骤', trigger: '触发条件', triggers: '触发条件', preconditions: '前置条件', postconditions: '完成条件', transitions: '状态流转', exceptions: '异常处理', entity: '业务实体', entityId: '业务实体编号', entityIds: '业务实体', entityMappings: '实体映射', fieldMappings: '字段映射', technicalFields: '技术补充字段', businessFields: '业务字段', layout: '页面布局', layoutType: '布局类型', blocks: '布局区块', regions: '页面区域', sections: '页面区块', navigation: '页面跳转', jumps: '页面跳转', frontend: '前端实现', backend: '后端实现', listColumns: '列表内容', queryFields: '查询条件', formFields: '表单字段', request: '请求内容', response: '返回内容', requestFields: '请求字段', responseFields: '返回字段', input: '输入', output: '输出', calls: '接口调用', dependencies: '依赖', internalCalls: '内部模块调用', externalCalls: '外部系统调用', calledBy: '被哪些模块调用', owner: '所属模块', module: '业务模块', system: '系统', target: '调用目标', url: '地址', resource: '权限资源', expectedResult: '预期结果', actualResult: '实际结果', evidence: '证据', execution: '执行结果', values: '字典值', changedFields: '变更字段', changeDescription: '变更说明', changeSummary: '变更说明', deprecated: '已停用', sourceId: '来源编号', sourcePath: '来源相对位置', isTechnical: '技术补充字段', length: '长度', unique: '唯一约束', references: '关联依据', from: '起点', to: '终点' });
Object.assign(statusNames, { explicit: '明确记录', inferred: '推测待确认', ambiguous: '待确认', 'source-backed': '有来源依据', 'not-recorded': '未收录', planned: '已有设计', 'not-executed': '未执行', 'implementation-observed': '已观察到实现定义', 'implementation-derived': '来自代码快照' });
Object.assign(statusNames, { documented: '已有需求依据', 'schema-observed': '已读取数据库结构', 'configuration-enabled': '配置已启用', 'configuration-disabled': '配置已停用', enabled: '配置已启用', disabled: '配置已停用' });
Object.assign(fieldNames, { granularity: '记录粒度', originalDocument: '原始文档位置', resourceType: '菜单节点类型', sourceParentId: '来源配置上级编号', hierarchyNote: '菜单层级说明', visible: '业务系统中是否显示', implementationVerified: '实现是否已验证', physicalForeignKeysRead: '是否已读取物理外键', definitionType: '定义来源类型', roleBindings: '角色授权关联' });
Object.assign(fieldNames,{businessPurpose:'业务用途',purpose:'用途',contextId:'所属业务范围',contextName:'所属业务范围',responsibility:'业务职责',goal:'业务目标',conditions:'适用条件',nature:'资料性质',origin:'来源',businessChange:'业务改造情况',runtimeConfiguration:'运行配置情况',enabled:'启用状态',directoryStatus:'目录范围',users:'使用人员',input:'主要输入',outcome:'业务结果',provider:'提供模块',behaviorType:'行为类型',processingMode:'处理方式',completionCondition:'业务完成条件',parentPage:'上级页面',section:'来源章节',line:'来源行',availability:'原文可用性',occurredAt:'来源发生时间',formedAt:'资料形成时间',adoption:'采用决定',startedAt:'开始时间',finishedAt:'结束时间',initiator:'发起人',scopeBinding:'范围依据',baseline:'可信基线',changeSummary:'业务变化摘要'});
Object.assign(fieldNames,{observableResult:'可观察结果',boundaries:'业务边界',knownLimitations:'已知限制'});
const $ = id => document.getElementById(id);
const filterKeys = ['menuScope', 'menuBinding', 'origin', 'businessChange', 'adoption', 'nature', 'recordType', 'directoryScope', 'functionId', 'functionRevision', 'isCurrent'];
const state = { ...readLocation(), session: null, projects: [], menus: [], overview: {}, menuQuery: '', expandedMenus: new Set(), searchExpandedMenus: new Set(), menuExpansionQuery: '', menuExpansionScope: '', menusReady: false, total: 0, loading: false, listRequest: null, projectRequest: null, detailRequest: null, searchTimer: null, composing: false, diagramSequence: 0, columnPreferences: new Map(), listItems: [], listScope: null, detailTrail: [], currentDetail: null, detailAnchors: new Map(), pickerRequest: null, exportRequest: null, viewHistory: new Map(), detailCache: new Map(), readingContext: null };

function readLocation() {
  const query = new URLSearchParams(window.location.search);
  const filters = Object.fromEntries(filterKeys.map(key => [key, query.get(key) || (key === 'menuScope' ? 'descendants' : key === 'menuBinding' ? 'any' : '')]));
  return normalizeFilters({ ...filters, project: query.get('project') || '', tab: Object.hasOwn(deliveryTabs, query.get('tab')) ? query.get('tab') : 'menus', q: query.get('q') || '', menuId: query.get('menuId') || '', batchId: query.get('batchId') || '', releaseId: query.get('releaseId') || '', focusId: query.get('focusId') || '', focusKind: query.get('focusKind') || '', focusRevision: query.get('focusRevision') || '', localId: query.get('localId') || '', page: Math.max(1, Number.parseInt(query.get('page'), 10) || 1), pageSize: [20, 50, 100].includes(Number(query.get('pageSize'))) ? Number(query.get('pageSize')) : 20, menuPreset: query.get('menuPreset') || 'attention' });
}
function normalizeFilters(value) {
  value.isCurrent = value.tab === 'stages' ? (value.isCurrent === 'false' ? 'false' : 'true') : '';
  if (value.releaseId) value.batchId = '';
  const parent = deliveryTabs[value.tab]?.parent || value.tab;
  if (!['requirements','overview'].includes(parent)) value.adoption = '';
  if (parent !== 'menus') value.directoryScope = '';
  if (!supportsFunctionFilter(value.tab)) value.functionId = '';
  if (!value.functionId) value.functionRevision = '';
  return value;
}
function supportsFunctionFilter(tab){const definition=deliveryTabs[tab];return Boolean(definition&&!definition.view&&(definition.endpoint==='requirements'||definition.kind));}
function isProjectReleaseView(tab=state.tab){return ['releases','business-versions','artifacts','environments','production'].includes(tab);}
function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined && value !== null) element.textContent = String(value);
  if (className) element.className = className;
  return element;
}
function action(label, handler, className = 'secondary-button') {
  const element = node('button', label, className); element.type = 'button'; element.addEventListener('click', handler); return element;
}
function text(value, empty = '未记录') {
  if (value === undefined || value === null || value === '') return empty;
  if (Array.isArray(value)) return value.map(entry => text(entry, '')).filter(Boolean).join(' / ') || empty;
  if (typeof value === 'object') return Object.entries(value).map(([key, entry]) => `${fieldNames[key] || phaseNames[key] || key}：${text(entry, '—')}`).join('；') || empty;
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}
function status(value) { return statusNames[value] || text(value, '未验证'); }
function granularity(value) { return ({ 'specification-section': '规格文档章节', 'function-point': '功能点', feature: '功能点', requirement: '需求条目' })[value] || text(value, '需求条目'); }
function resourceType(value) { return ({ 1: '业务目录', 2: '业务菜单' })[value] || text(value); }
function environment(value) { return ({ production: '生产', staging: '预发布', test: '测试', development: '开发', unknown: '未确认' })[value] || text(value, '未确认'); }
function date(value) {
  if (!value) return '未记录'; const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '时间未确认' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(parsed);
}
function get(item, ...keys) {
  for (const key of keys.flatMap(value => String(value).split('|'))) {
    for (const root of [item, item?.details]) {
      const value = key.split('.').reduce((object, part) => object?.[part], root);
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}
function count(value) { return Array.isArray(value) ? `${value.length} 项` : value && typeof value === 'object' ? `${Object.keys(value).length} 项` : '未记录'; }
function menuLabel(item) { return text(item.menuPaths || item.menuPath || item.path || item.menuIds || item.menuId); }
function queryFor({ paginated = true, location = false } = {}) {
  const query = new URLSearchParams(); const definition = deliveryTabs[state.tab];
  if (state.project) query.set('project', state.project);
  if (state.q) query.set('q', state.q);
  const keys = ['menuId', 'batchId', 'releaseId', ...filterKeys];
  for (const key of keys) if (state[key]) query.set(key, state[key]);
  if (!location) {
    if(isProjectReleaseView())for(const key of ['menuId','menuScope','menuBinding'])query.delete(key);
    if (definition.kind) query.set('kind', definition.kind);
    if (definition.view) query.set('view', definition.view);
    if (definition.recordType && !state.recordType) query.set('recordType', definition.recordType);
    query.set('projection', 'summary');
  } else {
    for (const key of ['menuPreset', 'focusKind', 'focusId', 'focusRevision', 'localId']) if (state[key]) query.set(key, state[key]);
  }
  if (paginated) { query.set('page', state.page); query.set('pageSize', state.pageSize); }
  return query;
}
function saveLocation(replace = false) {
  const query = queryFor({ location: true }); query.set('tab', state.tab);
  window.history[replace ? 'replaceState' : 'pushState'](null, '', `${window.location.pathname}?${query}`);
}
async function api(path, { signal } = {}) {
  const controller = new AbortController(); const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  let timedOut = false; const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
  try {
    const response = await fetch(path, { headers: { accept: 'application/json' }, signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) { window.location.assign('/forge-gateway/login'); throw new Error('登录已失效，请重新登录。'); }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.message || `暂时无法读取记录（${response.status}），请重新加载。`);
    return value;
  } catch (error) { if (timedOut) throw new Error('读取超时，请检查网络后重新加载。'); throw error; }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}
function closeDetail({preserveTrail=false}={}) {
  state.detailRequest?.abort(); state.detailRequest = null; state.diagramSequence += 1;
  if ($('delivery-detail').open) $('delivery-detail').close();
  $('delivery-detail-body').replaceChildren();
  state.currentDetail=null;if(!preserveTrail)state.detailTrail=[];
}
function currentProjectName() {
  const project = state.projects.find(item => item.slug === state.project);
  return project?.displayName || project?.name || state.project;
}
function renderControls() {
  const tab = deliveryTabs[state.tab]; const parent = tab.parent || state.tab;
  $('delivery-project').value = state.project; $('delivery-search').value = state.q;
  const projectName = currentProjectName();
  const projectQuery = new URLSearchParams({ project: state.project });
  const projectHref = state.project ? `/forge-gateway/?${projectQuery}` : '/forge-gateway/';
  $('delivery-brand').href = projectHref; $('delivery-back').href = projectHref;
  $('delivery-brand').setAttribute('aria-label', projectName ? `返回${projectName}项目工作台` : '返回项目工作台');
  $('delivery-project-subtitle').textContent = `${projectName ? `${projectName} · ` : ''}业务功能与交付过程`;
  $('delivery-title').textContent = `${projectName ? `${projectName} · ` : ''}需求与交付中心`;
  $('delivery-menu-panel').hidden = isProjectReleaseView();
  $('delivery-context').hidden = isProjectReleaseView();
  $('delivery-reader-panel').hidden = state.tab === 'production';
  productionPanel?.setActive(state.tab === 'production');
  $('delivery-search-clear').hidden = !state.q; $('delivery-page-size').value = String(state.pageSize);
  $('delivery-list-title').textContent = tab.name; $('delivery-caption').textContent = tab.name;
  $('delivery-list-help').textContent = tab.help; $('delivery-search').placeholder = `搜索${tab.name}名称或说明`;
  document.title = `${tab.name} · ${projectName ? `${projectName} · ` : ''}需求与交付中心`;
  for (const button of document.querySelectorAll('[data-delivery-tab]')) button.setAttribute('aria-pressed', String(button.dataset.deliveryTab === parent));
  const subview = $('delivery-subviews'); subview.replaceChildren(); subview.hidden = !subviews[parent];
  for (const key of subviews[parent] || []) { const button = action(deliveryTabs[key].name, () => navigate({ tab: key, page: 1, q: '' })); button.setAttribute('aria-pressed', String(state.tab === key)); subview.append(button); }
  const selected = state.menus.find(item => item.id === state.menuId);
  $('delivery-context').textContent = state.menuId ? text(selected?.path || selected?.name || state.menuId) : '全部业务菜单';
  const notes = [];
  if(state.tab==='artifacts')notes.push('按项目版本和发布记录查看制品。生产发布包需完成独立环境验证和人工验收后下载；下载不代表生产已上线。');
  else if(isProjectReleaseView())notes.push('按当前项目查看版本与发布记录。发布范围以已有版本和制品关联为准，发布成功不代表已经在客户生产环境上线。');
  if (state.releaseId) notes.push('发布范围仅使用当时有依据的定义及修订；没有绑定的内容不以当前资料补齐。');
  else if (state.batchId) notes.push('迭代范围展示本次有据关联与变化，不代表该时点系统全部功能。');
  else notes.push('当前资料表示已收录的要求和观察，不等于当前生产环境具备全部内容。');
  if (!isProjectReleaseView()&&state.menuBinding === 'none') notes.push('正在查看明确不通过业务菜单进入的能力。');
  if (!isProjectReleaseView()&&state.menuBinding === 'unknown') notes.push('正在查看菜单归属尚待明确的资料，不将其判为未实现。');
  if (state.listScope?.scopeBinding === 'unknown') notes.push('所选历史范围尚未建立可靠关联。');
  $('delivery-scope-note').textContent = notes.join(' '); $('delivery-scope-note').hidden = !notes.length;
  $('delivery-overview-panel').hidden = state.tab !== 'overview';
  renderActiveFilters(selected);
  renderFilterControls(); renderColumnControls();
  $('delivery-export').hidden = state.tab !== 'requirement-matrix';
  $('delivery-export').disabled = state.loading || Boolean(state.exportRequest);
}
function renderActiveFilters(selected) {
  const root=$('delivery-filters');root.replaceChildren();const entries=[];
  const add=(key,label,value,reset='')=>{if(value)entries.push({key,label,value,reset});};
  if(state.tab!=='artifacts')add('menuId',isProjectReleaseView()?'导航菜单（不筛选发布）':'菜单',state.menuId?text(selected?.path||selected?.name||state.menuId):'');
  if(!isProjectReleaseView()&&state.menuId&&state.menuScope==='self')add('menuScope','层级','仅本节点','descendants');
  add('batchId','迭代',state.batchId);add('releaseId','发布',state.releaseId);add('q','搜索',state.q);
  add('functionId','关联功能',state.functionId?(state.readingContext?.item.assetId||state.readingContext?.item.id)===state.functionId?state.readingContext.item.name||state.functionId:state.functionId:'');
  add('functionRevision','关联功能修订',state.functionRevision);
  if(!isProjectReleaseView()&&state.menuBinding&&state.menuBinding!=='any')add('menuBinding','资料归属',({linked:'已关联菜单',none:'明确无菜单入口',unknown:'归属待明确'})[state.menuBinding],'any');
  for(const [key,label]of [['origin','来源'],['businessChange','业务改造'],['nature','资料性质'],['adoption','采用情况']])add(key,label,state[key]?enumNames[key]?.[state[key]]||state[key]:'');
  add('recordType','记录类型',state.recordType);
  if(state.directoryScope&&state.directoryScope!=='current')add('directoryScope','目录',state.directoryScope==='historical'?'历史已退出目录':'全部已收录目录','current');
  if(state.tab==='menus'&&state.menuPreset!=='all')add('menuPreset','菜单视图',({attention:'关注需求迭代',baseline:'原生底座',unknown:'待确认'})[state.menuPreset],'all');
  if(!entries.length)root.append(node('span','当前查看项目内全部记录','field-help'));
  for(const entry of entries){
    const chip=node('span',null,'delivery-filter-chip');chip.append(node('span',`${entry.label}：${entry.value}`));
    const clear=action('×',()=>{if(entry.key==='functionId')state.readingContext=null;navigate({[entry.key]:entry.reset,...(entry.key==='functionId'?{functionRevision:''}:{}),page:1});},'delivery-filter-chip-clear');clear.setAttribute('aria-label',`清除${entry.label}筛选`);chip.append(clear);root.append(chip);
  }
  if(state.tab==='menus'&&selected){const context=node('div',null,'delivery-reading-context');context.append(node('strong',text(selected.path||selected.name)),action('查看这个菜单的功能与变化',()=>showDetail('menus',selected)));root.append(context);}
  if(state.tab!=='artifacts')appendReadingContext(root);
}
function explicitReferences(item) {
  const refs=new Map();const seen=new Set();let visited=0;
  const visit=(value,depth=0)=>{
    if(!value||typeof value!=='object'||depth>8||seen.has(value)||++visited>1500)return;seen.add(value);
    if(value.kind&&value.id)refs.set(`${value.kind}:${value.id}:${value.revision||''}:${value.localId||''}`,value);
    if(value.targetKind&&value.targetId)visit({kind:value.targetKind,id:value.targetId,revision:value.targetRevision,name:value.label},depth+1);
    for(const [key,child]of Object.entries(value))if(!['sources','revisions','deliveryCenter'].includes(key))visit(child,depth+1);
  };
  visit(item);return [...refs.values()].filter(ref=>ref.id!==(item.assetId||item.id));
}
function rememberReadingContext(item) {
  if(item.kind==='function'&&item.revision)state.readingContext={item,refs:explicitReferences(item),menuId:state.menuId};
}
function extendReadingContext(parent,target){
  const context=state.readingContext;if(!context||!parent||!target.revision)return;
  const same=(left,right)=>left?.kind===right?.kind&&(left.id||left.assetId)===(right.id||right.assetId)&&left.revision===right.revision;
  if(!same(context.item,parent)&&!context.refs.some(ref=>same(ref,parent)))return;
  const ref=explicitReferences(parent).find(entry=>same(entry,target));
  if(ref&&!context.refs.some(entry=>same(entry,ref))&&context.refs.length<200)context.refs.push(ref);
}
function appendReadingContext(root) {
  const context=state.readingContext;if(!context)return;
  const section=node('div',null,'delivery-reading-context');section.append(node('strong',`正在核对功能：${context.item.name||context.item.assetId||context.item.id}`),node('span',revisionLabel(context.item),'field-help'));
  section.append(action('返回这个功能',()=>showDetail('assets',context.item,{push:true}),'text-button'));
  const parent=deliveryTabs[state.tab]?.parent||state.tab;
  const refs=context.refs.filter(ref=>(deliveryTabs[kindTabs[ref.kind]]?.parent||kindTabs[ref.kind])===parent);
  if(refs.length){section.append(node('span','此功能已有的关联：','field-help'));for(const ref of refs.slice(0,8))section.append(referenceButton(ref));if(refs.length>8)section.append(node('span','其余关联可在功能详情查看。','field-help'));}
  if(state.functionId)section.append(node('span',state.functionRevision?'下方按明确功能身份及指定引用修订筛选。':'下方按资料中已收录的功能引用筛选；关联修订未指定时，不代表绑定了当前功能修订。','field-help'));
  else if(parent!=='overview'&&parent!=='menus')section.append(node('span','本视图未按功能筛选。可从功能详情查阅有据关联，不能把下方全部菜单资料当作功能关联。','field-help'));
  section.append(action('结束本次功能阅读',()=>{state.readingContext=null;navigate({functionId:'',functionRevision:'',page:1});},'text-button'));root.append(section);
}
function selectControl(root, id, label, values, selected, onChange) {
  const wrapper = node('div', null, 'delivery-filter-field'); const title = node('label', label); title.setAttribute('for', id);
  const select = node('select'); select.id = id;
  for (const [value, name] of values) { const option = node('option', name); option.value = value; select.append(option); }
  select.value = selected || ''; select.addEventListener('change', () => onChange(select.value)); wrapper.append(title, select); root.append(wrapper); return select;
}
function menuCheckpointBatches(menuId = state.menuId) {
  if (!menuId || state.releaseId || isProjectReleaseView()) return [];
  const children = new Map();
  if (state.menuScope === 'descendants') for (const menu of state.menus) {
    if (!children.has(menu.parentId)) children.set(menu.parentId, []);
    children.get(menu.parentId).push(menu.id);
  }
  const selected = new Set([menuId]); const pending = [menuId];
  for (let index = 0; index < pending.length; index += 1) for (const id of children.get(pending[index]) || []) {
    if (!selected.has(id)) { selected.add(id); pending.push(id); }
  }
  const batches = new Map();
  for (const menu of state.menus) if (selected.has(menu.id)) {
    for (const variant of [menu, ...(Array.isArray(menu.variants) ? menu.variants : [])]) {
      if (variant.sourceScope !== 'taskspace-checkpoint') continue;
      for (const id of Array.isArray(variant.batchIds) ? variant.batchIds : []) if (id && !batches.has(id)) {
        batches.set(id, { id, name: menu.name, formedAt: variant.sourceRecordedAt || variant.recordedAt,
          commit: variant.sourceRevision || '' });
      }
    }
  }
  return [...batches.values()].sort((a,b) => String(b.formedAt || '').localeCompare(String(a.formedAt || '')) || a.id.localeCompare(b.id));
}
function openBatchMaterials(batchId, tab = 'requirements', menuId = state.menuId) {
  return navigate({tab,batchId,menuId,releaseId:'',page:1,q:'',menuBinding:'any',origin:'',businessChange:'',adoption:'',nature:'',recordType:'',functionId:'',functionRevision:''});
}
function appendCheckpointMaterials(root, menuId = state.menuId, controlId = 'delivery-checkpoint-batch') {
  const batches = menuCheckpointBatches(menuId); if (!batches.length) return;
  const section = node('section', null, 'delivery-detail-section');
  section.append(node('h3', `已收录的工作舱资料 · ${batches.length} 个批次`),
    node('p', '这些是工作舱已提交的过程定义，未作为项目当前定义展示。集成状态未核定；采用、验收和发布仍需各自依据，不能由提交推定。', 'field-help'));
  let selected = batches.some(item => item.id === state.batchId) ? state.batchId : batches[0].id;
  selectControl(section, controlId, '选择该菜单的工作舱批次', batches.map(item => [item.id,
    `${item.name || '工作舱提交'} · ${date(item.formedAt)}${item.commit ? ` · ${item.commit.slice(0,8)}` : ''}`]), selected, id => { selected = id; });
  const buttons = node('div', null, 'delivery-detail-actions');
  for (const [tab,label] of [['overview','查看功能'],['requirements','查看要求'],['pages','查看页面']]) {
    buttons.append(action(label, () => openBatchMaterials(selected,tab,menuId)));
  }
  section.append(buttons); root.append(section);
}
function renderFilterControls() {
  const scope = $('delivery-scope-controls'); scope.replaceChildren();
  if(state.tab==='stages')selectControl(scope,'delivery-stage-record-scope','阶段记录',[['true','当前阶段'],['false','历史记录']],state.isCurrent,value=>navigate({isCurrent:value,page:1}));
  selectControl(scope, 'delivery-range-mode', '查看范围', [['current',state.tab==='artifacts'?'全部发布包与制品':'已收录需求与设计'],['batch','指定迭代'],['release','指定发布'],['environment','环境版本（已观察）']], state.releaseId ? 'release' : state.batchId ? 'batch' : 'current', value => {
    if (value === 'current') { $('delivery-scope-picker').hidden = true; navigate({batchId:'',releaseId:'',page:1}); }
    else if (value === 'environment') { $('delivery-scope-picker').hidden = true; navigate({tab:'environments',page:1,q:''}); }
    else openScopePicker(value);
  });
  if(!isProjectReleaseView())selectControl(scope, 'delivery-menu-scope', '菜单层级范围', [['self','本节点'],['descendants','包含下级']], state.menuScope, value => navigate({menuScope:value,page:1}));
  appendCheckpointMaterials(scope);
  const filters = $('delivery-filter-fields'); filters.replaceChildren();
  if(!isProjectReleaseView())selectControl(filters, 'delivery-menu-binding', '资料归属', [['any','全部归属'],['linked','已关联菜单'],['none','明确无菜单入口'],['unknown','归属待明确']], state.menuBinding, value => navigate({menuBinding:value,menuId:value==='none'||value==='unknown'?'':state.menuId,page:1}));
  for (const [key, label] of [['origin','来源'],['businessChange','业务改造情况'],['nature','资料性质']]) {
    selectControl(filters, `delivery-filter-${key}`, label, [['','全部'],...Object.entries(enumNames[key])], state[key], value => navigate({[key]:value,page:1}));
  }
  const parent = deliveryTabs[state.tab].parent || state.tab;
  if (['requirements','overview'].includes(parent)) selectControl(filters,'delivery-filter-adoption','采用情况',[['','全部'],...Object.entries(enumNames.adoption)],state.adoption,value=>navigate({adoption:value,page:1}));
  if(parent==='menus')selectControl(filters,'delivery-directory-scope','目录范围',[['current','当前目录'],['historical','历史已退出目录'],['all','全部已收录目录']],state.directoryScope||'current',value=>navigate({directoryScope:value,page:1}));
  const quick = $('delivery-quick-filters'); quick.replaceChildren(); quick.hidden = state.tab !== 'menus';
  for (const [key,label] of [['attention','关注需求迭代'],['baseline','原生底座'],['unknown','待确认'],['all','全部']]) {
    const button = action(label,()=>navigate({menuPreset:key,origin:'',businessChange:'',page:1})); button.setAttribute('aria-pressed',String(state.menuPreset===key)); quick.append(button);
  }
}
async function openScopePicker(mode, query = '', page = 1) {
  state.pickerRequest?.abort(); const controller = new AbortController(); state.pickerRequest = controller;
  const root = $('delivery-scope-picker'); root.hidden = false; root.replaceChildren();
  const form = node('form'); form.noValidate = true; const label = node('label',mode==='batch'?'查找迭代批次':'查找发布记录');
  const input = node('input'); input.id='delivery-range-query'; input.type='search'; input.value=query; label.setAttribute('for',input.id);
  const submit = node('button','查找','secondary-button'); submit.type='submit'; form.append(label,input,submit);
  form.addEventListener('submit',event=>{event.preventDefault();openScopePicker(mode,input.value.trim(),1);}); root.append(form);
  const content = node('div'); content.append(node('p','正在读取可选范围…','field-help')); root.append(content);
  try {
    const params = new URLSearchParams({project:state.project,q:query,page:String(page),pageSize:'50',projection:'summary'});
    const result = await api(`/forge-gateway/api/delivery/${mode==='batch'?'batches':'releases'}?${params}`,{signal:controller.signal});
    if (controller.signal.aborted || state.pickerRequest!==controller) return; content.replaceChildren();
    const values = [['','请选择'],...(result.items||[]).map(item=>[item.id,item.name||item.version||item.id])];
    selectControl(content,'delivery-range-record',mode==='batch'?'迭代批次':'发布记录',values,'',id=>{
      if(!id)return; root.hidden=true; navigate({batchId:mode==='batch'?id:'',releaseId:mode==='release'?id:'',page:1});
    });
    if(!(result.items||[]).length)content.append(node('p','没有匹配记录，可调整名称再查询。','field-help'));
    const controls=node('div',null,'delivery-detail-actions');
    if(page>1)controls.append(action('上一页范围',()=>openScopePicker(mode,query,page-1)));
    if(page*50<result.total)controls.append(action('下一页范围',()=>openScopePicker(mode,query,page+1)));
    controls.append(action('取消选择',()=>{controller.abort();root.hidden=true;renderControls();}));content.append(controls);
  } catch(error) {if(!controller.signal.aborted)content.replaceChildren(node('p',error.message,'form-message error'),action('重新读取范围',()=>openScopePicker(mode,query,page)));}
}
function allColumns() {
  const columns=state.tab === 'permission-matrix' && state.matrixColumns?.length ? [...deliveryTabs[state.tab].columns,...state.matrixColumns.map(value=>({key:`matrix:${value.id}`,label:value.name||value.id,format:'matrix',operationId:value.id}))] : deliveryTabs[state.tab].columns;
  return state.functionId?[...columns,{key:'functionAssociation',label:'关联功能修订',format:'function-association'}]:columns;
}
function visibleColumns() {
  const columns = allColumns();
  const preference = state.columnPreferences.get(state.tab);
  return columns.filter(value=>value.identity || value.key==='functionAssociation' || (preference ? preference.has(value.key) : !value.optional));
}
function renderColumnControls() {
  const root=$('delivery-columns');root.replaceChildren();
  const columns=allColumns(); const visible=new Set(visibleColumns().map(value=>value.key));
  for(const column of columns){
    const label=node('label');const input=node('input');input.type='checkbox';input.checked=visible.has(column.key);input.disabled=Boolean(column.identity)||column.key==='functionAssociation';
    input.addEventListener('change',()=>{const selected=new Set(visibleColumns().map(value=>value.key));if(input.checked)selected.add(column.key);else selected.delete(column.key);state.columnPreferences.set(state.tab,selected);renderRows(state.listItems);});label.append(input,node('span',column.label));root.append(label);
  }
}
function expandSelectedMenuPath() {
  const byId = new Map(state.menus.map(item => [item.id, item])); const visited = new Set([state.menuId]);
  let current = byId.get(state.menuId);
  while (current?.parentId && byId.has(current.parentId) && !visited.has(current.parentId)) {
    visited.add(current.parentId); state.expandedMenus.add(current.parentId); current = byId.get(current.parentId);
  }
}
function menuExpansions() { return state.menuQuery.trim() ? state.searchExpandedMenus : state.expandedMenus; }
function renderMenus(focusToggleId) {
  const tree = $('delivery-menu-tree'); tree.replaceChildren();
  let focusToggle;
  const byId = new Map(state.menus.map(item => [item.id, item])); const children = new Map();
  const search = state.menuQuery.trim().toLocaleLowerCase('zh-CN'); const visible = new Set();
  for (const item of state.menus) if (!search || text([item.name, item.path], '').toLocaleLowerCase('zh-CN').includes(search)) {
    let current = item; const visited = new Set();
    while (current && !visited.has(current.id)) { visited.add(current.id); visible.add(current.id); current = byId.get(current.parentId); }
  }
  for (const item of state.menus) {
    if (!visible.has(item.id)) continue;
    const parent = item.parentId && byId.has(item.parentId) && item.parentId !== item.id ? item.parentId : '';
    if (!children.has(parent)) children.set(parent, []); children.get(parent).push(item);
  }
  if (state.menuExpansionQuery !== search) { state.searchExpandedMenus = new Set(visible); state.menuExpansionQuery = search; }
  const expanded = menuExpansions();
  const seen = new Set();
  const addItems = (items, parent) => {
    const list = node('ul', null, 'delivery-menu-list');
    for (const item of items) {
      if (seen.has(item.id)) continue; seen.add(item.id);
      const li = node('li'); const row = node('div', null, 'delivery-menu-row'); li.append(row);
      const descendants = (children.get(item.id) || []).filter(child => !seen.has(child.id));
      if (descendants.length) {
        const branchId = `delivery-menu-branch-${seen.size}`;
        const toggle = action(expanded.has(item.id) ? '▾' : '▸', () => { if (expanded.has(item.id)) expanded.delete(item.id); else expanded.add(item.id); renderMenus(item.id); }, 'delivery-menu-toggle');
        if (item.id === focusToggleId) focusToggle = toggle;
        toggle.setAttribute('aria-label', `${expanded.has(item.id) ? '收起' : '展开'}${text(item.name, item.id)}`);
        toggle.setAttribute('aria-expanded', String(expanded.has(item.id))); toggle.setAttribute('aria-controls', branchId); row.append(toggle);
        const branch = addItems(descendants, li); branch.id = branchId; branch.hidden = !expanded.has(item.id);
      } else { const spacer = node('span', '', 'delivery-menu-toggle-spacer'); spacer.setAttribute('aria-hidden', 'true'); row.append(spacer); }
      const button = action(text(item.name, item.id), () => navigate({ menuId: item.id, menuPreset: 'all', page: 1 }), 'delivery-menu-button');
      button.setAttribute('aria-current', String(state.menuId === item.id)); button.setAttribute('data-menu-select', item.id); row.append(button);
      list.append(li);
    }
    if (list.children.length) parent.append(list); return list;
  };
  addItems(children.get('') || [], tree); addItems(state.menus.filter(item => visible.has(item.id) && !seen.has(item.id)), tree);
  if (search && !visible.size) tree.append(node('p', '没有匹配的菜单，可缩短关键词。', 'field-help'));
  $('delivery-all-menus').setAttribute('aria-pressed', String(!state.menuId));
  $('delivery-menu-search-clear').hidden = !state.menuQuery;
  focusToggle?.focus();
}
function renderCollectionIssues(gaps) {
  const items = Array.isArray(gaps) ? gaps : [];
  const details = $('delivery-issues'); details.hidden = !items.length; details.open = false;
  $('delivery-issues-summary').textContent = `收录问题（${items.length}）`;
  const scalar = value => typeof value === 'string' && value.trim() ? value : '';
  const reasons = { 'invalid-json': 'JSON 格式无效', 'invalid-metadata': '文档元数据无效', 'unterminated-fence': '文档块未闭合' };
  let page = 1;
  function renderPage() {
    const body = $('delivery-issues-body'); body.replaceChildren();
    for (const entry of items.slice((page - 1) * 20, page * 20)) {
      const item = entry && typeof entry === 'object' ? entry : { label: scalar(entry) };
      const row = node('tr');
      const problem = node('td', scalar(item.label) || scalar(item.code) || '未记录');
      if (scalar(item.reason)) problem.append(node('p', reasons[item.reason] || item.reason, 'field-help'));
      const location = node('td', scalar(item.sourcePath) || '文件未记录');
      const positions = [];
      if (Number.isSafeInteger(item.fenceLine) && item.fenceLine > 0) positions.push(`文档块起始行 ${item.fenceLine}`);
      if (Number.isSafeInteger(item.line) && item.line > 0) positions.push(`内容起始行 ${item.line}`);
      if (item.reason === 'invalid-metadata' && Number.isSafeInteger(item.recordIndex) && item.recordIndex >= 0) positions.push(`第 ${item.recordIndex + 1} 条记录`);
      location.append(node('p', positions.join('；') || '块位置未记录', 'field-help'));
      const hint = scalar(item.recoveryMessage) || (item.recovery === 'source-correction-required' || item.captureCode === 'COMMITTED_DOCUMENT_INVALID_JSON'
        ? '请在原对话核对文档格式；修正后正常提交。'
        : item.recovery === 'cause-resolution-required' ? '请先核查采集失败原因；当前尚未确认恢复。' : '处理方式未记录');
      row.append(problem, node('td', scalar(item.sourceCommit) || '未记录'), location, node('td', hint)); body.append(row);
    }
    const pagination = $('delivery-issues-pagination'); pagination.replaceChildren(); pagination.hidden = items.length <= 20;
    if (items.length > 20) {
      const totalPages = Math.ceil(items.length / 20);
      const previous = action('上一页', () => { page--; renderPage(); }); previous.disabled = page === 1;
      const next = action('下一页', () => { page++; renderPage(); }); next.disabled = page === totalPages;
      const controls = node('div', null, 'delivery-page-controls'); controls.append(previous, next);
      pagination.append(node('p', `第 ${page} / ${totalPages} 页 · 共 ${items.length} 条收录问题`), controls);
    }
  }
  renderPage();
}
function renderOverview(value) {
  state.overview = value;
  const root = $('delivery-overview'); root.replaceChildren();
  const counts = { ...value.counts, ...value.assetCounts };
  for (const [key, label] of [['menus', '已收录菜单'], ['function', '独立功能定义'], ['requirements', '需求记录（含文档章节）'], ['entity', '模型与实现记录'], ['table', '数据表'], ['page', '页面记录'], ['api', '接口记录'], ['test', '测试资料记录'], ['batches', '迭代批次'], ['releases', '发布记录']]) {
    if (Number.isFinite(counts[key])) { const item = node('span', label); item.append(node('strong', counts[key])); root.append(item); }
  }
  const coverage = value.coverage; const notes = [];
  if (coverage?.availability === 'partial') notes.push('部分来源未能收录');
  if (coverage?.unmappedRequirements) notes.push(`${coverage.unmappedRequirements} 项需求尚未归类`);
  if (coverage?.conflicts) notes.push(`${coverage.conflicts} 项来源记录已有差异标记`);
  if (coverage?.unboundReleases) notes.push(`${coverage.unboundReleases} 次发布尚未绑定功能快照`);
  renderCollectionIssues(coverage?.gaps);
  $('delivery-coverage').textContent = '项目资料统计，不随当前菜单或迭代筛选。'+(typeof coverage === 'string' ? coverage : text(coverage?.message || coverage?.note || notes.join('；'), '缺少记录不能直接判断功能未实现，存在记录也不代表已通过验收或上线。'));
  $('delivery-observed').textContent = value.observedAt ? `记录观察时间：${date(value.observedAt)}` : '';
}
async function loadProject() {
  state.projectRequest?.abort(); state.listRequest?.abort(); resetSharedReferences(); closeDetail();
  const scope = `${state.project}:${state.releaseId}:${state.batchId}:${state.directoryScope}`;
  if (state.menuExpansionScope !== scope) { state.expandedMenus.clear(); state.searchExpandedMenus.clear(); state.menuExpansionQuery = ''; state.menuExpansionScope = scope; }
  state.menus = []; state.menusReady = false; renderMenus(); renderOverview({}); renderControls();
  $('delivery-project-retry').hidden = true;
  if (!state.project) { $('delivery-menu-status').textContent = '暂无可查看的项目。'; await loadList(); return; }
  const controller = new AbortController(); state.projectRequest = controller;
  $('delivery-menu-status').textContent = '正在读取业务菜单…';
  const menuQuery = new URLSearchParams({ project: state.project });
  for (const key of ['releaseId','batchId','directoryScope']) if(state[key])menuQuery.set(key,state[key]);
  const listing = state.tab === 'menus' ? null : loadList();
  const current = () => !controller.signal.aborted && state.projectRequest === controller;
  const menuLoading = api(`/forge-gateway/api/delivery/menus?${menuQuery}`, { signal: controller.signal }).then(value => {
    if (!current()) return;
    state.menus = value.items || []; state.menusReady = true; expandSelectedMenuPath(); state.menuExpansionQuery = ''; renderMenus();
    $('delivery-menu-status').textContent = state.menus.length ? `共 ${state.menus.length} 个菜单节点` : state.releaseId ? '该发布范围尚无已绑定的菜单。' : '尚无已收录的业务菜单。';
  }, error => {
    if (!current()) return;
    $('delivery-menu-status').textContent = error.message; $('delivery-project-retry').hidden = false;
  }).then(() => { if (current()) { renderControls(); if (state.tab === 'menus') return loadList(); } });
  const overviewQuery=new URLSearchParams(menuQuery);for(const key of ['menuId','menuScope','menuBinding'])if(state[key])overviewQuery.set(key,state[key]);
  const overviewLoading = api(`/forge-gateway/api/delivery/overview?${overviewQuery}`, { signal: controller.signal }).then(value => {
    if (current()) renderOverview(value);
  }, error => {
    if (!current()) return;
    $('delivery-coverage').textContent = `项目概览暂不可用：${error.message}`; $('delivery-project-retry').hidden = false;
  });
  await Promise.allSettled([menuLoading, overviewLoading, listing]);
}
function stageSummary(value) {
  if (!value || !Object.keys(value).length) return '暂无阶段结果';
  return Object.entries(value).map(([phase, result]) => `${phaseNames[phase] || phase}：${status(typeof result === 'object' ? result.status : result)}`).join('；');
}
function cell(value, className) { return node('td', text(value), className); }
const codeSourceNotice = '从该代码快照中的明确声明收录；不作为原始需求、验收通过或生产上线证明。';
function shortText(value, limit = 100, fallback = '未记录') {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return fallback;
  if (typeof value === 'boolean') return value ? '是' : '否';
  const clean = String(value).replace(/```[\s\S]*?```/g, '').split(/\r?\n/)
    .filter(line => !/^\s*(?:#{1,6}\s|>\s*(?:status|created|complexity|change):|\|?[\s:|-]+\|\s*$)/i.test(line))
    .join(' ').replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*|]/g, '').replace(/(?:^|\s)[->]\s+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean : fallback;
}
function itemCount(value) { return Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : value === null || value === undefined || value === '' ? null : 1; }
function countLabel(label, value) { const size = itemCount(value); return `${label} ${size === null ? '未记录' : size}`; }
function namesSummary(value) {
  const values = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  const names = values.slice(0, 2).map(entry => shortText(entry && typeof entry === 'object' ? entry.name || entry.label || entry.roleName || entry.title || entry.action : entry, 22, '名称未记录'));
  return names.length ? `${names.join('、')}${values.length > 2 ? `等，共 ${values.length} 项` : ''}` : '未记录';
}
function declaredUsage(value) { return typeof value === 'boolean' ? value ? '涉及' : '不涉及' : value == null || value === '' ? '未确认' : '已记录声明'; }
function summaryCell(value, secondary = '') {
  const result = node('td'); result.append(node('span', shortText(value), 'delivery-cell-text'));
  if (secondary) result.append(node('span', shortText(secondary, 70), 'delivery-cell-sub')); return result;
}
function menuCount(item) {
  const values = item.menuIds || (item.menuId ? [item.menuId] : item.menuPaths || (item.menuPath?.length ? [item.menuPath] : []));
  return new Set(values.map(value => Array.isArray(value) ? value.join('/') : value)).size;
}
function menuSummary(item) {
  const size = menuCount(item); if (!size) return '未绑定菜单';
  const first = item.menuPaths?.[0] || item.menuPath;
  const selected = state.menus.find(menu => (item.menuIds || [item.menuId]).includes(menu.id));
  const name = Array.isArray(first) ? first.filter(part => typeof part === 'string').slice(-2).join(' / ') : selected?.name;
  return name ? `${shortText(name, 45)}${size > 1 ? ` · 共 ${size} 个菜单` : ''}` : `已关联 ${size} 个菜单`;
}
function businessTitle(item) {
  const document = item.originalDocument || item.details?.sourceDocument;
  const title = document && typeof document === 'object' ? document.title : null;
  const raw = title || item.name || item.title || item.version;
  return shortText(raw, 85, '业务记录');
}
function businessSummary(item) {
  for (const value of [get(item, 'businessPurpose', 'purpose', 'businessMeaning', 'summary'), item.description]) {
    if (typeof value === 'string' && value.trim() && value !== codeSourceNotice) {
      const summary = shortText(value, 110, ''); if (summary && summary !== businessTitle(item)) return summary;
    }
  }
  return item.certainty === 'implementation-derived' ? '已收录实现声明，业务用途未单独描述' : '业务用途尚未单独描述';
}
function nameCell(item, { menu = true, secondary } = {}) {
  const value = node('td'); value.append(node('span', businessTitle(item), 'delivery-cell-primary'), node('span', businessSummary(item), 'delivery-cell-summary'));
  const context = secondary ?? (menu ? menuSummary(item) : ''); if (context) value.append(node('span', shortText(context, 75), 'delivery-cell-sub')); return value;
}
function assetCells(item) {
  const kind = deliveryTabs[state.tab].kind;
  if (kind === 'entity') {
    const entityRelations = (item.relations || []).filter(relation => relation.targetKind === 'entity');
    const tableRelations = (item.relations || []).filter(relation => relation.targetKind === 'table');
    const logicalCount = entityRelations.length || itemCount(get(item, 'logicalRelations', 'relationships')) || 0;
    return [summaryCell(countLabel(item.certainty === 'implementation-derived' ? '实现字段' : '业务属性', get(item, 'attributes', 'properties', 'fields')), `${countLabel('技术补充字段', get(item, 'technicalFields'))}；使用菜单 ${menuCount(item)}`), summaryCell(`${logicalCount ? `已记录实体关联 ${logicalCount}` : '实体关系未明确记录'}；表映射 ${tableRelations.length}`)];
  }
  if (kind === 'table') return [summaryCell(countLabel('字段总数', get(item, 'fields', 'columns')), countLabel('技术补充字段', get(item, 'technicalFields'))), summaryCell(countLabel('实体映射', get(item, 'entityMappings', 'entityIds')), `数据版本：${shortText(get(item, 'migrationVersion'), 35)}`)];
  if (kind === 'page') return [summaryCell(`${countLabel('表单', get(item, 'formFields', 'editFields', 'fields'))}；${countLabel('查询', get(item, 'queryFields', 'searchFields'))}；${countLabel('列表列', get(item, 'listColumns', 'columns'))}`), summaryCell(countLabel(item.certainty === 'implementation-derived' ? '源码操作声明' : '操作声明', get(item, 'actions', 'operations', 'buttons')), `${menuCount(item) > 1 ? '共用页面；菜单配置见详情 · ' : ''}${shortText(get(item, 'layout', 'layoutType', 'pageMode'), 35, '结构未记录')}`)];
  if (kind === 'api') return [summaryCell(shortText(get(item, 'method'), 12, '方法未记录'), shortText(get(item, 'path', 'endpoint', 'url'), 65, '接口位置未记录')), summaryCell(`${countLabel('内部调用', get(item, 'internalCalls'))}；${countLabel('外部调用', get(item, 'externalCalls'))}`)];
  if (kind === 'permission') return [summaryCell(`角色：${namesSummary(get(item, 'roles', 'roleBindings', 'roleName', 'roleKey'))}`, `操作：${namesSummary(get(item, 'actions', 'operations'))}`), summaryCell(get(item, 'dataScope', 'scope') == null ? '数据范围未记录' : shortText(get(item, 'dataScope', 'scope'), 80, '已记录范围定义，详见详情'))];
  if (kind === 'test') {
    const expected = get(item, 'expectedResult', 'expected', 'acceptanceCriteria'); const actual = get(item, 'actualResult', 'actual', 'result', 'execution');
    return [summaryCell(typeof expected === 'string' ? expected : namesSummary(expected), '预期内容不代表实际执行通过'), summaryCell(itemCount(actual) > 0 ? shortText(actual, 90, '已记录执行结果，详见详情') : '未记录执行结果', countLabel('验证依据', get(item, 'evidence', 'testEvidence')))];
  }
  if (kind === 'scene') return [summaryCell(`角色：${namesSummary(get(item, 'actors', 'roles'))}`, countLabel('业务步骤', get(item, 'steps'))), summaryCell(`流程：${declaredUsage(get(item, 'usesWorkflow', 'workflow'))}`, shortText(get(item, 'trigger', 'triggers'), 70, '触发条件未记录'))];
  if (kind === 'dictionary') return [summaryCell(countLabel('字典值', get(item, 'values', 'options', 'items'))), summaryCell(`使用菜单 ${menuCount(item)}`)];
  return [summaryCell(shortText(get(item, 'condition', 'trigger', 'triggers'), 100, '适用条件未记录')), summaryCell(namesSummary(get(item, 'rule', 'rules')))];
}
function renderRows(items) {
  if (state.tab === 'artifacts') items = items.map(item => ({ ...item, artifactVersionTime: item.artifactVersionTime || artifactVersionTime(item) })).sort((left, right) => {
    const leftTime = Date.parse(left.artifactVersionTime?.at); const rightTime = Date.parse(right.artifactVersionTime?.at);
    if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
    return Number.isFinite(rightTime) ? rightTime - leftTime : -1;
  });
  state.listItems=items; artifactExportCells = []; const columns=visibleColumns();
  const header = node('tr'); for (const column of [...columns,{label:'操作'}]) { const th = node('th', column.label); th.scope = 'col'; if(column.identity)th.className='delivery-identity-column'; header.append(th); }
  $('delivery-table-head').replaceChildren(header); const body = $('delivery-table-body'); body.replaceChildren();
  for (const item of items) {
    const row = node('tr'); const operations = node('td'); const buttons = node('div', null, 'delivery-row-actions'); operations.append(buttons);
    for(const column of columns){
      const td=node('td');if(column.identity)td.className='delivery-identity-column';
      if(column.format==='matrix'){
        const cells=(item.cells||[]).filter(value=>String(value.operationId||value.operation?.id||value.operation)===String(column.operationId));
        if(!cells.length)td.append(node('span','未明确','delivery-cell-text'));
        for(const entry of cells){const label=enumNames.authorization[entry.decision]||'未明确';td.append(entry.ruleRef?action(label,()=>openReference(entry.ruleRef),'text-button'):node('span',label));}
      } else if(column.format==='count-link'){
        const value=get(item,column.key);const total=typeof value==='number'?value:value?.total;
        td.append(Number.isFinite(total)?action(String(total),()=>navigateToAssociation(column.target,item),'text-button'):node('span','未建立可靠关联','delivery-cell-text'));
      } else {
        const value=get(item,column.key); const label=formatField(value,column,item);
        const refs=referenceValues(value);
        if(column.identity){td.append(action(label,()=>openRecord(item),'delivery-record-link'));if(item.readingSelection)td.append(node('span',collectedReadingLabel(item),'delivery-cell-sub'));}
        else if(column.format==='evidence'&&evidenceSummary(value).present)td.append(evidenceButton(value,column,item));
        else if(column.format==='ref'&&refs.length)for(const ref of refs.slice(0,2))td.append(referenceButton(ref));
        else td.append(node('span',label,column.format==='code'||column.format==='commit'?'delivery-cell-text delivery-cell-code':'delivery-cell-text'));
        if(column.format==='ref'&&refs.length>2)td.append(node('span',`共 ${refs.length} 项，详情查看完整关联`,'delivery-cell-sub'));
      }
      row.append(td);
    }
    buttons.append(action('查看详情',()=>openRecord(item)));
    if(state.tab==='artifacts' && item.type==='container-image') {
      buttons.append(action('导出生产包',()=>openProductionExport(item)));
      const summary = node('div', null, 'delivery-artifact-exports'); operations.append(summary); artifactExportCells.push({ id: item.id, element: summary }); renderArtifactExportSummary(item.id, summary);
    }
    if(state.tab==='batches')buttons.append(action('查看资料',()=>openBatchMaterials(item.id)));
    row.append(operations);body.append(row);
  }
}
function natureOf(item) { return item.nature || (item.certainty==='implementation-derived'?'implementation-observation':'unknown'); }
function primitiveBrief(value, fallback='未记录') {
  if(Array.isArray(value))return value.length?value.slice(0,2).map(entry=>primitiveBrief(entry,'未明确')).join('、')+(value.length>2?`（共 ${value.length} 项）`:''):fallback;
  if(value&&typeof value==='object')return shortText(value.name||value.label||value.title||value.description||value.summary||value.text||value.id,110,fallback);
  return shortText(value,110,fallback);
}
function relatedMeaning(item,keys){return keys.map(key=>get(item,key)).find(value=>value!==undefined&&value!==null&&(typeof value!=='string'||value.trim()!=='')&&(!Array.isArray(value)||value.length>0));}
function referenceValues(value) {return (Array.isArray(value)?value:[value]).filter(item=>item&&typeof item==='object'&&item.kind&&item.id);}
function formatMenu(value,item,column={}){
  const nonempty=entry=>entry!=null&&entry!==''&&(!Array.isArray(entry)||entry.length>0);
  const keys=[...String(column.key||'').split('|'),'menuPaths','menuPath','menuIds','menuId'];
  const selected=keys.map(key=>({key,value:get(item,key)})).find(entry=>nonempty(entry.value))||{value};
  if(!nonempty(selected.value))return '未明确菜单归属';
  const entries=Array.isArray(selected.value)&&!['menuPath','path'].includes(selected.key)?selected.value:[selected.value];
  const labels=entries.map(entry=>{
    if(Array.isArray(entry))return entry.join(' / ');
    const id=typeof entry==='object'?entry.id||entry.menuId:entry;const menu=state.menus.find(row=>row.id===id);
    return menu?text(menu.path?.length?menu.path:menu.name||id):primitiveBrief(entry);
  });
  return shortText(labels.slice(0,2).join('；'),110,'未明确菜单归属')+(labels.length>2?`（共 ${labels.length} 个菜单）`:'');
}
function evidenceSummary(value) {
  const rows=Array.isArray(value)?value:[value];const present=rows.filter(row=>row!=null&&row!==''&&(typeof row!=='object'||Object.keys(row).length));
  if(!present.length)return {present:false,label:'尚未关联依据'};
  const conclusions=new Set(['passed','failed','rejected','accepted','verified','implemented','partial','blocked','not-executed','not_executed','deployed','published','released','succeeded','success','completed']);
  const labels=[];let unknown=false;
  for(const row of present){
    const explicit=typeof row==='object'&&(row.verdict||row.conclusion);
    const candidates=typeof row==='string'?[row]:[row.verdict,row.conclusion,row.status,row.state,row.result?.verdict,row.result?.status];
    const known=candidates.find(entry=>typeof entry==='string'&&conclusions.has(entry));
    if(known)labels.push(known==='completed'?'记录已结束，结果需核对':statusNames[known]||'未执行');
    else if(typeof explicit==='string'&&explicit.trim()&&!['unknown','unverified','pending'].includes(explicit))labels.push(shortText(explicit,70));
    else unknown=true;
  }
  const known=[...new Set(labels)];return {present:true,label:known.length?`${known.slice(0,3).join('；')}${known.length>3?'；另有结论':''}${unknown?'；另有记录结论未明确':''}`:'有记录，结论未明确'};
}
function evidenceButton(value,column,item) {
  return action(evidenceSummary(value).label,()=>showDetail('evidence-record',{name:column.label,description:evidenceSummary(value).label,evidence:value,parentObject:{kind:item.kind||deliveryTabs[state.tab]?.kind||({requirements:'requirement',releases:'release'})[state.tab],id:item.assetId||item.id,revision:item.revision,name:item.name}},{push:true}),'text-button');
}
function formatField(value,column,item={}) {
  const format=column.format;
  if(format==='api-menu-usage'){
    const usages=get(item,'menuUsages');
    if(!Array.isArray(usages)||!usages.length)return primitiveBrief(value);
    if(!state.menuId)return '选择业务菜单查看使用关系';
    const selected=usages.filter(entry=>entry?.menuRef?.kind==='menu'&&entry.menuRef.id===state.menuId).map(entry=>entry.usage).filter(usage=>typeof usage==='string'&&usage.trim());
    return primitiveBrief(selected,'未记录当前菜单使用关系');
  }
  if(format==='release-change-summary'){
    const changes=Array.isArray(item.documentedChangePreview)?item.documentedChangePreview:[];
    const count=Number.isInteger(item.documentedChangeCount)?item.documentedChangeCount:changes.length;
    if(count>0)return `已记录 ${count} 项：${changes.length?`${namesSummary(changes.slice(0,2))}${count>2?'等':''}`:'详见发布详情'}`;
    return shortText(value,100,'尚未单独记录业务变化说明');
  }
  if(format==='documented-change-nature')return value==='historical-compilation'?'事后追溯':value==='implementation-observation'?'实现观察':enumNames.nature[value]||'资料性质未明确';
  if(format==='change-type')return ({added:'新增',add:'新增',new:'新增',modified:'调整',updated:'调整',changed:'调整',change:'调整',fixed:'修复',fix:'修复',removed:'移除',remove:'移除'})[value]||shortText(value,40);
  if(column.identity&&state.tab==='requirements')return businessRecordName(item,'requirement');
  if(format==='function-association')return functionAssociationLabel(item);
  if(format==='nature')return enumNames.nature[natureOf(item)]||primitiveBrief(value);
  if(enumNames[format])return enumNames[format][typeof value==='object'?value?.state:value]||enumNames[format].unknown||primitiveBrief(value,'未明确');
  if(format==='parent')return value?state.menus.find(menu=>menu.id===value)?.name||value:'根目录';
  if(format==='resourceType')return resourceType(value);
  if(format==='date')return date(value);
  if(format==='artifact-version-time')return value?.at ? `${date(value.at)}（${value.label}）` : value?.unavailable ? '来源时间未能读取' : '未记录';
  if(format==='environment')return environment(value);
  if(format==='phase')return phaseNames[value]||primitiveBrief(value);
  if(format==='stage-status')return value==='accepted'?'阶段已接受':value==null?'未记录':status(value);
  if(format==='status')return value==null?'未记录':status(typeof value==='object'?value.status||value.state:value);
  if(format==='revision')return value==null?'修订未明确':String(value).length>20?String(value).slice(0,12):String(value);
  if(format==='enabled')return value===true?'启用':value===false?'停用':item.status==='enabled'?'启用':item.status==='disabled'?'停用':'未记录';
  if(format==='visible')return value===true?'显示':value===false?'隐藏':'未记录';
  if(format==='boolean')return typeof value==='boolean'?value?'是':'否':'未记录';
  if(format==='count')return Number.isFinite(value)?String(value):'尚无可靠数量';
  if(format==='sources')return Array.isArray(value)&&value.length?`${value.length} 项来源，详情可定位`:'尚未关联来源';
  if(format==='evidence'){
    return evidenceSummary(value).label;
  }
  if(format==='commit')return Array.isArray(value)?value.slice(0,2).map(item=>primitiveBrief(item).slice(0,12)).join('、'):typeof value==='string'?value.slice(0,16):'未关联';
  if(format==='menu')return formatMenu(value,item,column);
  return primitiveBrief(value);
}
function referenceButton(ref) {
  const label=primitiveBrief(ref,'查看关联定义');
  if(!ref.revision&&!['menu','release'].includes(ref.kind)){
    const entry=node('span',null,'delivery-cell-text');entry.append(node('span',`${label}（目标修订未明确）`));
    if(ref.kind==='requirement'||deliveryTabs[kindTabs[ref.kind]]?.kind){const choose=action('查看已收录修订',()=>openReference(ref),'text-button');choose.setAttribute('aria-label',`查看${label}的已收录修订`);entry.append(choose);}return entry;
  }
  return action(label,()=>openReference(ref),'text-button');
}
function businessRecordName(item,kind=item.kind){
  const name=kind==='page'?get(item,'pageName','name','title'):item.name||item.title;
  if(kind==='requirement'&&(!name||name===item.id||name===item.assetId))return primitiveBrief(get(item,'statement','description'),'要求名称未单独收录');
  return text(name||item.version||item.id||item.assetId,'记录详情');
}
function functionAssociationLabel(item){
  const refs=item.functionAssociation?.refs;
  if(!Array.isArray(refs)||!refs.length)return '引用依据待核对';
  return refs.map(ref=>ref.revision?`资料声明引用 ${String(ref.revision).slice(0,12)}`:'关联修订未指定').filter((value,index,all)=>all.indexOf(value)===index).join('；');
}
function navigateToAssociation(target,item){
  const tabs={requirements:'requirements',functions:'overview',pages:'pages',processes:'processes',entities:'entities',tables:'database',apis:'backend',permissions:'permissions',acceptance:'acceptance',releases:'releases'};
  return navigate({tab:tabs[target]||'requirements',menuId:item.menuId||item.id,q:'',page:1});
}
function openRecord(item){
  if(item.parentRef)return openReference({...item.parentRef,localId:item.localId||item.parentRef.localId},{row:item});
  const definition=deliveryTabs[state.tab];
  if(definition.view&&!['release-attempts','business-versions','feature-delivery'].includes(definition.view))return showDetail('view-row',item);
  const type=definition.endpoint==='stages'?'stages':item.kind?'assets':definition.kind?'assets':definition.endpoint||state.tab;
  return showDetail(type,{...item,kind:type==='stages'?'stage':item.kind||definition.kind});
}
function updatePagination(items = []) {
  $('delivery-prev').disabled = state.loading || state.page <= 1 || !state.project;
  $('delivery-next').disabled = state.loading || state.page * state.pageSize >= state.total || !state.project;
  $('delivery-page-size').disabled = state.loading || !state.project;
  $('delivery-range').textContent = state.loading ? '正在查询…' : state.total ? `共 ${state.total} 条，当前 ${items.length ? (state.page - 1) * state.pageSize + 1 : 0}–${Math.min(state.page * state.pageSize, state.total)} 条 · 第 ${state.page} 页` : '共 0 条';
}
function filteredMenus() {
  const descendants = new Set(state.menuId ? [state.menuId] : state.menus.map(item => item.id));
  if(state.menuScope!=='self')for (let index = 0; index < state.menus.length; index += 1) { let changed = false; for (const item of state.menus) if (descendants.has(item.parentId) && !descendants.has(item.id)) { descendants.add(item.id); changed = true; } if (!changed) break; }
  const query = state.q.toLocaleLowerCase('zh-CN');
  return state.menus.filter(item => {
    if(!descendants.has(item.id)||state.menuBinding==='none')return false;
    if(state.origin&&(item.origin||'unknown')!==state.origin)return false;
    if(state.businessChange&&(item.businessChange||'unknown')!==state.businessChange)return false;
    if(state.nature&&natureOf(item)!==state.nature)return false;
    if(!state.origin&&!state.businessChange){
      if(state.menuPreset==='attention'&&item.origin!=='business-added'&&item.businessChange!=='modified')return false;
      if(state.menuPreset==='baseline'&&!['baseline','base-upgrade'].includes(item.origin))return false;
      if(state.menuPreset==='unknown'&&item.origin&&item.origin!=='unknown'&&item.businessChange&&item.businessChange!=='unknown')return false;
    }
    return !query||text([item.name,item.path,item.description],'').toLocaleLowerCase('zh-CN').includes(query);
  });
}
function resetSharedReferences(){
  state.sharedReferenceRequest?.abort();state.sharedReferenceRequest=null;state.sharedReferenceContext=null;
  if(state.sharedReferenceRoot){state.sharedReferenceRoot.hidden=true;state.sharedReferenceRoot.open=false;state.sharedReferenceRoot.replaceChildren();}
}
function renderSharedReferences(value){
  const total=Number(value.sharedReferences?.total);
  if(!state.menuId||state.batchId||state.releaseId||!['entities','database'].includes(state.tab)||!Number.isInteger(total)||total<=0)return;
  const root=state.sharedReferenceRoot||(state.sharedReferenceRoot=node('details',null,'delivery-detail-section'));
  if(!root.id){root.id='delivery-shared-references';$('delivery-results').append(root);}
  root.hidden=false;root.open=false;root.replaceChildren();
  const summary=node('summary',`共享组件引用（${total}）`);
  const note=node('p','以下资料通过本菜单引用的共享组件关联。源码依赖不表示本菜单维护这些对象，也不证明实际调用、数据库读写、业务采用或发布。','delivery-scope-note');
  const content=node('div');content.setAttribute('aria-live','polite');
  root.append(summary,note,content);
  const context={query:new URLSearchParams(queryFor()),root,content,total,page:0,loaded:false};
  context.query.set('referenceGroup','shared');context.query.set('projection','summary');context.query.set('pageSize','20');
  if(value.scope?.snapshotDigest)context.query.set('snapshotDigest',value.scope.snapshotDigest);
  state.sharedReferenceContext=context;
  root.ontoggle=()=>{if(root.open&&!context.loaded&&state.sharedReferenceContext===context)loadSharedReferences(context,1);};
}
async function loadSharedReferences(context,page){
  if(state.sharedReferenceContext!==context)return;
  state.sharedReferenceRequest?.abort();const controller=new AbortController();state.sharedReferenceRequest=controller;
  const active=()=>!controller.signal.aborted&&state.sharedReferenceContext===context&&state.sharedReferenceRequest===controller;
  context.content.replaceChildren(node('p','正在读取共享组件引用…','loading-row'));
  const query=new URLSearchParams(context.query);query.set('page',String(page));
  try{
    const value=await api(`/forge-gateway/api/delivery/assets?${query}`,{signal:controller.signal});if(!active())return;
    const items=value.items||[];context.loaded=true;context.page=page;context.total=Number(value.total)||0;
    const table=node('table');table.setAttribute('aria-label','共享组件引用');const head=node('thead');const titles=node('tr');
    for(const label of ['对象','本菜单引用用途','组件与接口依据','操作']){const th=node('th',label);th.scope='col';titles.append(th);}head.append(titles);table.append(head);
    const body=node('tbody');
    for(const item of items){
      const row=node('tr');const name=node('td');name.append(action(businessRecordName(item),()=>showDetail('assets',item),'delivery-record-link'));
      const reference=item.menuReference||{};const purpose=node('td',reference.purpose||'本菜单业务用途未单独明确；已收录共享组件的源码引用。');
      const evidence=node('td');
      for(const binding of reference.bindings||[]){
        const detail=node('details');detail.append(node('summary',`${binding.componentPath||'组件位置未明确'} · ${[binding.method,binding.path].filter(Boolean).join(' ')||'接口位置未明确'}`));
        if(binding.pagePath)detail.append(node('p',`页面来源：${binding.pagePath}`,'field-help'));
        for(const source of binding.sources||[]){const path=source.path||source.sourcePath;detail.append(node('p',`${path||source.label||'来源位置未明确'}${source.line?`:${source.line}`:''}${source.commit?` · 提交 ${String(source.commit).slice(0,12)}`:''}`,'field-help'));}
        evidence.append(detail);
      }
      if(!reference.bindings?.length)evidence.append(node('span','关联来源尚未返回，可进入对象详情核对。'));
      for(const limitation of reference.limitations||[])evidence.append(node('p',limitation,'field-help'));
      const operation=node('td');operation.append(action('查看对象与来源',()=>showDetail('assets',item)));row.append(name,purpose,evidence,operation);body.append(row);
    }
    table.append(body);const wrapper=node('div',null,'table-scroll');wrapper.append(table);
    const pagination=node('div',null,'delivery-pagination');const label=node('p',`共享引用共 ${context.total} 条 · 第 ${page} 页`,'field-help');
    const previous=action('上一页共享引用',()=>loadSharedReferences(context,page-1));previous.disabled=page<=1;
    const next=action('下一页共享引用',()=>loadSharedReferences(context,page+1));next.disabled=page*20>=context.total;
    pagination.append(label,previous,next);context.content.replaceChildren(items.length?wrapper:node('p','该范围的共享组件引用尚未返回。','field-help'),pagination);
  }catch(error){if(!active()||error.name==='AbortError')return;context.loaded=false;context.content.replaceChildren(node('p',error.message,'form-message error'),action('重新读取共享引用',()=>loadSharedReferences(context,page)));}
}
let artifactExportRequest = null;
let artifactExportState = { project: '', status: 'idle', rows: [] };
let artifactExportCells = [];
function renderArtifactExportSummary(id, element) {
  element.replaceChildren();
  if (artifactExportState.project !== state.project || ['idle', 'loading'].includes(artifactExportState.status)) { element.append(node('span', '正在读取生产导出记录…')); return; }
  if (artifactExportState.status === 'failed') { element.append(node('span', '生产导出记录未能读取，可刷新重试。')); return; }
  const rows = artifactExportState.rows.filter(({ job }) => job.sourceArtifact?.id === id).sort((a, b) => String(b.job.createdAt || '').localeCompare(String(a.job.createdAt || '')));
  if (!rows.length) { element.append(node('span', '本行暂无关联导出记录。')); return; }
  const full = rows.filter(({ job }) => job.mode === 'initial'); const latest = rows[0];
  const describe = job => `${job.createdBy?.displayName || job.createdBy?.username || job.createdBy?.id || '未记录操作人'} · ${date(job.createdAt)}`;
  element.append(node('strong', `已导出 ${rows.length} 次（全量 ${full.length} 次）`), node('span', `最近${latest.job.mode === 'initial' ? '全量' : latest.job.mode === 'upgrade' ? '增量' : ''}：${describe(latest.job)}`));
  if (full.length && full[0] !== latest) element.append(node('span', `最近全量：${describe(full[0].job)}`));
  element.append(action('查看导出记录', () => openArtifactExportRecord(latest.releaseId, latest.job.id), 'text-button'));
}
async function loadArtifactExports() {
  if (state.tab !== 'artifacts' || !state.project || !artifactExportCells.length) return;
  artifactExportRequest?.abort(); const controller = new AbortController(); artifactExportRequest = controller; const project = state.project;
  const current = () => !controller.signal.aborted && artifactExportRequest === controller && state.project === project && state.tab === 'artifacts';
  artifactExportState = { project, status: 'loading', rows: [] };
  try {
    const result = await api(`/forge-gateway/api/production/releases?${new URLSearchParams({ project })}`, { signal: controller.signal });
    if (!current()) return;
    artifactExportState = { project, status: 'ready', rows: (result.items || []).flatMap(release => (release.jobs || []).filter(job => job?.sourceArtifact?.id).map(job => ({ releaseId: release.id, job }))) };
  } catch (error) { if (!current()) return; artifactExportState = { project, status: 'failed', rows: [] }; }
  if (current()) for (const { id, element } of artifactExportCells) renderArtifactExportSummary(id, element);
}
async function openArtifactExportRecord(releaseId, jobId) {
  const project = state.project; await navigate({ tab: 'production', q: '', page: 1 });
  if (state.project === project && state.tab === 'production' && productionPanel) await productionPanel.openJob(releaseId, jobId);
}
let productionPanel = null;
let productionMount = null;
async function ensureProductionPanel() {
  if (!productionMount) productionMount = mountProductionDelivery($('delivery-production-panel'), {
    session: state.session, embedded: true,
    onExportCreated: () => navigate({ tab: 'production', q: '', page: 1 }),
    onArtifacts: () => navigate({ tab: 'artifacts', q: '', page: 1 }),
  }).then(panel => { productionPanel = panel; return panel; }).catch(error => { productionMount = null; throw error; });
  return productionMount;
}
async function openProductionExport(item) {
  const project = state.project;
  try { const panel = await ensureProductionPanel(); if (project !== state.project || state.tab !== 'artifacts') return; await panel.setProject(project); if (project !== state.project || state.tab !== 'artifacts') return; await panel.openExport(item); }
  catch (error) { if (project === state.project) { $('delivery-list-error').hidden = false; $('delivery-error-message').textContent = error.message; } }
}
function artifactReleaseIds(item) {
  return item.type === 'container-image' ? [...new Set([item.releaseId, ...(Array.isArray(item.releaseIds) ? item.releaseIds : [])].filter(id => typeof id === 'string' && id))] : [];
}
function artifactVersionTime(item, releases = new Map()) {
  const valid = value => typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value));
  const times = artifactReleaseIds(item).map(id => releases.get(id)).filter(Boolean).map(release => valid(release.releasedAt)
    ? { at: release.releasedAt, label: '来源发布结束' } : valid(release.startedAt) ? { at: release.startedAt, label: '来源发布开始' } : null).filter(Boolean);
  if (times.length) return times.sort((left, right) => Date.parse(right.at) - Date.parse(left.at))[0];
  for (const [key, label] of [['updatedAt', '记录更新时间'], ['recordedAt', '收录时间'], ['createdAt', '记录创建时间']]) if (valid(item[key])) return { at: item[key], label };
  return null;
}
async function loadArtifactVersionTimes(items, project, signal) {
  // Read only exact releases referenced by this page; artifacts are paginated by ID on the server.
  const ids = [...new Set(items.flatMap(artifactReleaseIds))];
  const results = await Promise.allSettled(ids.map(id => api(`/forge-gateway/api/delivery/releases/${encodeURIComponent(id)}?project=${encodeURIComponent(project)}`, { signal })));
  const releases = new Map(); const unavailable = new Set();
  results.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value.item?.id === ids[index]) releases.set(ids[index], result.value.item);
    else unavailable.add(ids[index]);
  });
  return items.map(item => ({ ...item, artifactVersionTime: artifactVersionTime(item, releases) || (artifactReleaseIds(item).some(id => unavailable.has(id)) ? { unavailable: true } : null) }));
}
async function loadList() {
  state.listRequest?.abort(); artifactExportRequest?.abort(); artifactExportState = { project: state.project, status: 'loading', rows: [] }; resetSharedReferences(); closeDetail();
  if (state.tab === 'production') {
    state.loading = false; const project = state.project;
    try { const panel = await ensureProductionPanel(); if (project !== state.project || state.tab !== 'production') return; await panel.setProject(project); if (project !== state.project || state.tab !== 'production') return; panel.setActive(true); }
    catch (error) { if (project === state.project && state.tab === 'production') { $('delivery-production-panel').textContent = error.message; productionMount = null; productionPanel = null; } }
    return;
  }
  const controller = new AbortController(); state.listRequest = controller;
  state.loading = Boolean(state.project); state.total = 0; state.listScope=null; $('delivery-export').disabled=true;
  $('delivery-list-error').hidden = true; $('delivery-table-wrap').hidden = true; $('delivery-empty').hidden = true;
  $('delivery-table-body').replaceChildren(); $('delivery-loading').hidden = !state.project;
  $('delivery-results').setAttribute('aria-busy', String(state.loading)); updatePagination();
  if (!state.project) { $('delivery-empty').hidden = false; $('delivery-empty-title').textContent = '暂无可查看的项目'; $('delivery-empty-help').textContent = '可查看的项目记录收录后，可在这里查看。'; $('delivery-results').setAttribute('aria-busy', 'false'); return; }
  try {
    let value;
    if (state.tab === 'menus') {
      if (!state.menusReady) throw new Error('业务菜单尚未读取成功，请重新加载菜单。');
      const items = filteredMenus(); value = { total: items.length, items: items.slice((state.page - 1) * state.pageSize, state.page * state.pageSize) };
    } else {
      const definition=deliveryTabs[state.tab];const endpoint = definition.view ? 'views' : definition.endpoint || (definition.kind ? 'assets' : state.tab);
      value = await api(`/forge-gateway/api/delivery/${endpoint}?${queryFor()}`, { signal: controller.signal });
      if (state.tab === 'artifacts' && !controller.signal.aborted && state.listRequest === controller) value = { ...value, items: await loadArtifactVersionTimes(value.items || [], state.project, controller.signal) };
    }
    if (controller.signal.aborted || state.listRequest !== controller) return;
    state.listScope={...(value.scope||{}),scopeBinding:value.scopeBinding||value.scope?.scopeBinding};
    state.matrixColumns=state.tab==='permission-matrix'?value.columns||[]:[];
    state.total = Number(value.total) || 0; const maxPage = Math.max(1, Math.ceil(state.total / state.pageSize));
    if (state.page > maxPage) { state.page = maxPage; saveLocation(true); await loadList(); return; }
    const items = value.items || []; renderRows(items); if (state.tab === 'artifacts') void loadArtifactExports(); renderControls(); renderSharedReferences(value); $('delivery-table-wrap').hidden = !items.length; $('delivery-empty').hidden = Boolean(items.length);
    const filtered = state.q || state.menuId || state.batchId || state.releaseId;
    $('delivery-empty-title').textContent = state.releaseId && value.scopeBinding === 'unknown' ? '该版本的业务范围尚未关联' : filtered ? '没有匹配的记录' : `暂无${deliveryTabs[state.tab].name}记录`;
    $('delivery-empty-help').textContent = state.releaseId ? '此处仅展示发布时已绑定的数据；不使用当前记录替代历史版本。' : state.tab==='menus'&&state.menuPreset==='attention' ? '当前未收录可明确归入需求新增或业务改造的菜单。可切换“待确认”或“全部”阅读完整目录；不代表没有业务功能。' : state.tab==='requirements' ? '该范围尚无已整理的独立要求。原有文档章节仍可在“来源资料”阅读，不能按章节数量凑功能或要求数量。' : filtered ? '该范围尚无已明确关联的记录。可选择其他菜单或清除筛选；没有记录不表示功能没有实现。' : '真实产物收录后会显示在这里；目前不能据此判断实现、验收或上线状态。';
    const emptyActions=$('delivery-empty-actions');emptyActions.replaceChildren();
    if(!items.length){
      const parent=deliveryTabs[state.tab].parent||state.tab;
      if(!state.batchId&&menuCheckpointBatches().length)$('delivery-empty-title').textContent='当前范围没有记录；该菜单另有已收录的工作舱资料，可从上方选择批次查看';
      if(parent==='requirements'||parent==='overview'){
        if(parent==='overview')$('delivery-empty-help').textContent='尚未整理为独立功能定义，可查看已经形成的来源资料。零条定义不等于系统没有功能，也不据文档章节推算完成数量。';
        emptyActions.append(action('查看当前范围来源资料',()=>navigate({tab:'sources',recordType:'',origin:'',businessChange:'',adoption:'',nature:'',page:1,q:''})),action('查看项目全部来源资料',()=>navigate({tab:'sources',menuId:'',batchId:'',releaseId:'',menuBinding:'any',origin:'',businessChange:'',adoption:'',nature:'',recordType:'',page:1,q:''})));
      }
      if(parent==='acceptance'&&state.tab!=='test-materials')emptyActions.append(action('查看原始测试资料',()=>navigate({tab:'test-materials',recordType:'',origin:'',businessChange:'',adoption:'',nature:'',page:1,q:''})));
      if(state.tab==='menus')emptyActions.append(action('查看全部菜单',()=>navigate({menuPreset:'all',origin:'',businessChange:'',page:1})));
      if(state.sharedReferenceContext){$('delivery-empty-title').textContent='当前菜单尚无其他对象资料';$('delivery-empty-help').textContent='已收录的共享组件引用在下方，可展开查看用途及来源；不代表本菜单没有业务功能。';}
    }
    state.loading = false; updatePagination(items);
    const saved=state.viewHistory.get(locationKey());if(saved)$('delivery-table-wrap').scrollTop=saved.scrollTop;
    const focusKey=`${state.focusKind}:${state.focusId}:${state.focusRevision}:${state.localId}`;
    if(state.focusId&&state.focusKind&&state.lastFocusKey!==focusKey){state.lastFocusKey=focusKey;openReference({kind:state.focusKind,id:state.focusId,revision:state.focusRevision||undefined,localId:state.localId||undefined},{replace:true});}
  } catch (error) {
    if (controller.signal.aborted || state.listRequest !== controller || error.name === 'AbortError') return;
    $('delivery-list-error').hidden = false; $('delivery-error-message').textContent = error.message; state.loading = false; updatePagination(); $('delivery-range').textContent = '记录未加载';
   } finally { if (state.listRequest === controller) { $('delivery-loading').hidden = true; $('delivery-results').setAttribute('aria-busy', 'false'); $('delivery-export').disabled=Boolean(state.exportRequest)||state.loading; } }
}
function detailCacheKey(type,item,projectSource=state.currentDetail?.projectSource===true){return JSON.stringify([state.project,state.menuId,state.menuScope,state.menuBinding,state.batchId,state.releaseId,type,item.assetId||item.id||'',type==='assets'?revisionIdentity(item):item.revision||'',projectSource]);}
function detailElements(root){return [root,...Array.from(root.children||[]).flatMap(detailElements)];}
function captureDetailView(){
  const current=state.currentDetail;if(!current)return;
  current.view ||= {related:new Map()};current.view.scrollTop=$('delivery-detail').scrollTop||0;
  current.view.openSections=detailElements($('delivery-detail-body')).filter(element=>element.tagName==='DETAILS'&&element.open).map(element=>element.id);
  if(current.loaded&&(current.item.revision||current.type==='menus')){
    const key=detailCacheKey(current.type,current.item);state.detailCache.delete(key);state.detailCache.set(key,current);
    if(state.detailCache.size>20)state.detailCache.delete(state.detailCache.keys().next().value);
  }
}
function revealDetailTarget(target){
  const find=(element,path=[])=>{if(element===target)return [...path,element];for(const child of element.children||[]){const result=find(child,[...path,element]);if(result)return result;}return null;};
  for(const element of find($('delivery-detail-body'))||[])if(element.tagName==='DETAILS')element.open=true;
  target.tabIndex=-1;target.focus();target.scrollIntoView?.({block:'start'});
}
function finishDetailSections(body){
  if(body.deliveryEmptySections?.length){const empty=node('p',`本条原文未单列：${[...new Set(body.deliveryEmptySections)].join('、')}。关联记录可通过关联查询反查，不能据此判断中心未收录或业务上不存在这些内容。`,'delivery-empty-sections field-help');body.append(empty);}
  if(body.deliveryRegionFieldSections?.length)body.append(node('p',`未单独拆分专用字段表：${[...new Set(body.deliveryRegionFieldSections)].join('、')}。已收录字段按原区块展示在“区域字段与规则”，不因未拆表判定这些资料缺失。`,'field-help'));
  const sections=Array.from(body.children).filter(element=>element.tagName==='SECTION'||element.tagName==='DETAILS');
  const nav=node('nav',null,'delivery-detail-nav');nav.setAttribute('aria-label','当前详情的阅读分区');
  sections.forEach((section,index)=>{
    const heading=Array.from(section.children).find(element=>element.tagName==='H3'||element.tagName==='SUMMARY');if(!heading)return;
    section.id=`delivery-detail-section-${index}`;section.tabIndex=-1;
    nav.append(action(heading.textContent,()=>revealDetailTarget(section),'text-button'));
  });
  detailElements(body).filter(element=>element.tagName==='DETAILS').forEach((element,index)=>{if(!element.id)element.id=`delivery-detail-fold-${index}`;});
  const children=Array.from(body.children);body.replaceChildren(children[0],nav,...children.slice(1));
  const view=state.currentDetail?.view;
  if(view){for(const element of detailElements(body))if(element.tagName==='DETAILS'&&view.openSections?.includes(element.id))element.open=true;$('delivery-detail').scrollTop=view.scrollTop||0;}
}
function detailSection(title, value) {
  const section = node('section', null, 'delivery-detail-section'); section.append(node('h3', title));
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || value === null || value === undefined || value === '') section.append(node('p', '未记录', 'section-help'));
  else for (const entry of values) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = node('dl', null, 'delivery-detail-record');
      for (const [key, field] of Object.entries(entry)) record.append(node('dt', fieldNames[key] || phaseNames[key] || key), node('dd', key === 'status' || key === 'certainty' ? status(field) : key === 'environment' ? environment(field) : /At$/.test(key) ? date(field) : text(field)));
      section.append(record);
    } else section.append(node('p', text(entry)));
  }
  return section;
}
function detailDisclosure(title, ...content) {
  const disclosure = node('details', null, 'delivery-detail-section'); disclosure.append(node('summary', title), ...content); return disclosure;
}
function records(value) {
  if (Array.isArray(value)) return value.map(entry => entry && typeof entry === 'object' ? entry : { description: entry });
  if (value && typeof value === 'object') return Object.entries(value).map(([name, entry]) => entry && typeof entry === 'object' ? { name, ...entry } : { name, description: entry });
  return value === undefined || value === null || value === '' ? [] : [{ description: value }];
}
function detailTable(title, value, columns) {
  const section = node('section', null, 'delivery-detail-section'); section.append(node('h3', title)); const rows = records(value);
  if (!rows.length) { section.append(node('p', '未记录', 'section-help')); return section; }
  const wrap = node('div', null, 'table-scroll delivery-detail-table'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', `${title}，可横向滚动`);
  const table = node('table'); const caption = node('caption', title, 'delivery-sr-only'); const head = node('thead'); const headings = node('tr'); const body = node('tbody');
  for (const [, label] of columns) { const th = node('th', label); th.scope = 'col'; headings.append(th); }
  head.append(headings);
  for (const item of rows) { const row = node('tr'); for (const [keys] of columns) row.append(cell(typeof keys === 'function' ? keys(item) : get(item, ...keys.split('|')))); body.append(row); }
  table.append(caption, head, body); wrap.append(table); section.append(wrap); return section;
}
const attributeColumns = [['name|fieldName|field|code', '属性 / 字段'], ['label|title|description|businessMeaning', '业务含义'], ['dataType|type', '类型'], ['required', '必填'], ['nullable', '允许为空'], ['validation|validationRules|rules|constraints', '约束与校验']];
const sourceColumns = [['label|sourceLabel|name|sourceType|type', '来源'], ['batchId|taskId', '需求批次 / 任务'], ['conversationId|sourceConversationId|sessionId', '对话'], ['sourcePath|path|ref|reference', '相对位置 / 引用'], ['sourceRevision|revision|commit|digest|sourceDigest', '版本 / 摘要']];
function appendRelatedMenus(body, item) {
  const raw = item.usedByMenus || item.menuIds || [];
  const section = node('section', null, 'delivery-detail-section'); section.append(node('h3', '被哪些业务菜单使用'));
  const actions = node('div', null, 'delivery-detail-actions');
  for (const entry of raw) {
    const id = typeof entry === 'string' ? entry : entry.id || entry.menuId;
    const menu = state.menus.find(value => value.id === id); const label = text(typeof entry === 'object' ? entry.path || entry.name || menu?.path || id : menu?.path || menu?.name || id);
    if (id) actions.append(action(label, () => navigate({ tab: kindTabs[item.kind] || 'requirements', menuId: id, q: '', page: 1 })));
  }
  if (!actions.children.length) section.append(node('p', '尚未建立菜单关联。', 'section-help')); else section.append(actions);
  body.append(section);
}
function appendRelations(body, item) {
  const relations=(item.relations||[]).map((relation,index)=>({...relation,localId:`/relations/${index}`,from:relation.from||{kind:item.kind,id:item.assetId||item.id,revision:item.revision,name:item.name},to:relation.to||{kind:relation.targetKind,id:relation.targetId,revision:relation.targetRevision,name:relation.label},conditions:relation.conditions, sources:relation.sources||relation.source}));
  appendSchemaTable(body,{...item,details:{relationships:relations}},{keys:'relationships',title:'关联记录与使用关系',columns:[{key:'from',label:'起点',format:'ref'},{key:'type',label:'关联类型'},{key:'to',label:'目标定义',format:'ref'},{key:'revision',label:'关系修订',format:'revision'},{key:'cardinality',label:'数量约束'},{key:'conditions',label:'适用条件'},{key:'sources',label:'来源依据',format:'sources'}]});
  if(relations.some(relation=>!relation.to?.revision))body.append(node('p','部分关联尚未明确目标修订。保留已知定位，不自动打开最新版替代。','field-help'));
}
function appendAssetDetails(body, item) {
  const kind=item.kind; const observed=natureOf(item)==='implementation-observation'||item.certainty==='implementation-derived';
  const definition={businessMeaning:get(item,'businessMeaning','definition'),businessPurpose:get(item,'businessPurpose','purpose'),contextId:get(item,'contextName','contextId'),responsibility:get(item,'responsibility'),goal:get(item,'goal','businessGoal'),conditions:get(item,'conditions','preconditions'),outcome:get(item,'outcome','businessResult')};
  if(kind==='function'){definition.observableResult=get(item,'observableResult','outcome','businessResult');delete definition.outcome;definition.boundaries=get(item,'boundaries','boundary');definition.knownLimitations=get(item,'knownLimitations');}
  if(kind==='scene'){definition['参与角色']=get(item,'actor','actors');definition['正常结果']=get(item,'normalResult');}
  const known=Object.fromEntries(Object.entries(definition).filter(([,value])=>value!==undefined&&value!==null&&value!==''));
  const overview=detailSection('业务定义',{...known,nature:enumNames.nature[natureOf(item)]});overview.className+=' delivery-detail-overview';
  if(!Object.keys(known).length)overview.append(node('p',shortText(get(item,'statement','description'),240,'业务含义尚未单独收录，以下仅按已有资料阅读。')));body.append(overview);
  if(kind==='entity')body.append(detailSection('来源描述（未确认业务含义）',get(item,'description')));
  if(kind==='table')body.append(detailSection('数据库原始注释',get(item,'comment')));
  if(kind==='requirement')body.append(detailSection('要求内容',get(item,'statement','description')));
  if(kind==='function')appendFunctionRelated(body,item);
  appendFacts(body,item);
  if(observed)body.append(node('p','此记录是实现观察。源码声明、类注释和组件能力不替代已采用的业务定义，也不证明验收通过或生产启用。','delivery-scope-note'));
  if(kind==='page'&&menuCount(item)>1)body.append(node('p','此记录来自共用页面。请分别核对共用声明与当前菜单的实际采用配置，不能将所有源码操作都归给当前菜单。','delivery-scope-note'));
  if(kind==='api')body.append(detailSection('接口定位与处理方式',{method:get(item,'method'),path:get(item,'path','endpoint'),provider:get(item,'providerModule','provider','owner','module'),behaviorType:get(item,'behaviorType'),processingMode:get(item,'handlingMethod','processingMode'),completionCondition:get(item,'completionCondition')}));
  if(kind==='api'&&get(item,'dependencyReview'))body.append(detailSection('依赖核对声明（来源原文）',{scope:get(item,'dependencyReview.scope'),conclusion:get(item,'dependencyReview.conclusion')}));
  if(kind==='page')body.append(detailSection('页面结构说明',{layout:get(item,'layout','layoutType'),pageMode:get(item,'pageType','pageMode'),parentPage:get(item,'parentPage')}));
  const stageDeclaration = ['permission-contract','permission-enforcement','test-evidence-report'].includes(item.recordType);
  if(stageDeclaration){
    body.append(detailSection('来源声明边界',{'来源主题':item.sourceTopic,'来源阶段状态':item.sourcePhaseStatus,'记录性质':item.sourcePhaseStatus==='historical'?'历史阶段产物中的声明；非本次验证证明，回执未经本中心单独复核。':'阶段产物中的声明；回执未经本中心单独复核。','适用限制':'未据此推定生产启用、业务验收通过或关联功能；历史回执引用不代表本轮执行。'}));
    const labels={receipts:'原文回执声明',verificationReceipts:'原文验证回执声明',directVerification:'原文直接验证声明',notRunInThisPhase:'原文列明本阶段未执行',runtimeEvidenceReused:'历史运行证据引用（非本次执行）',focusedTests:'测试覆盖说明（非执行记录）',dataScopes:'实现声明的数据范围',denyRules:'拒绝条件',failClosedRules:'拒绝与失败关闭条件',assignedTaskRules:'任务处理条件',notYetProven:'原文列明尚未证明',evidenceBinding:'原文证据绑定声明',trustedFields:'可信身份字段原文声明',tenantAndScope:'租户与数据范围原文声明',serverPermissions:'服务端权限原文声明',endpointRule:'接口约束原文声明',trustedContext:'可信上下文原文声明'};
    const pointer=key=>String(key).replace(/~/g,'~0').replace(/\//g,'~1');
    const append=(title,value,path)=>{const section=detailSection(title,value);section.tabIndex=-1;state.detailAnchors.set(path,section);body.append(section);};
    for(const [key,value]of Object.entries(item.details||{})){
      if(['receipts','verificationReceipts','directVerification'].includes(key)&&Array.isArray(value))value.forEach((receipt,index)=>append(`回执声明 · ${receipt?.profile||index+1}`,receipt,`/details/${key}/${index}`));
      else if(key==='dataScopes'&&value&&typeof value==='object'&&!Array.isArray(value))for(const [scope,meaning]of Object.entries(value))append(`数据范围 · ${scope}`,meaning,`/details/dataScopes/${pointer(scope)}`);
      else append(labels[key]||key,value,`/details/${pointer(key)}`);
    }
  }
  if(kind==='test'&&!stageDeclaration){
    body.append(detailSection('预期结果',get(item,'expectedResult','expected')));
    const actual=get(item,'actualResult','actual','result');body.append(detailSection('实际结果',itemCount(actual)>0?actual:'未关联执行结果。测试预期或资料中的通过数字不能替代真实执行。'));
  }
  for(const definition of detailSchemas[kind]||[])appendSchemaTable(body,item,definition,{observed});
  if(kind==='entity')body.append(node('p','业务关系不代表数据库设置了物理外键；没有收录关系证据，也不代表业务上不存在关系。','field-help'));
  appendRelations(body,item);appendRelatedMenus(body,item);appendRevisionComparison(body,item);
  if(item.diagram)appendDiagram(body,item.diagram);
  if(kind==='entity'&&item.relationshipDiagram)appendDiagram(body,item.relationshipDiagram,'业务对象关联图');
  appendSources(body,item);appendCorrection(body,item);
  body.append(detailDisclosure('完整原文与技术资料',detailSection('完整原文',item.description),detailSection('完整结构化记录',item.details),detailSection('技术标识',{assetId:item.assetId||item.id,revision:item.revision,sourceRevision:item.sourceRevision,recordedAt:item.recordedAt,commits:item.commits,releaseIds:item.releaseIds})));
}
function appendSchemaTable(body,item,definition,{observed=false}={}){
  const all=[];
  for(const key of definition.keys.split('|'))for(const [index,entry]of records(get(item,key)).entries()){
    if(!definition.nested)all.push({entry:{...entry,_recordRef:{kind:item.kind,id:item.assetId||item.id,revision:item.revision??null,name:item.name}},key,index});
    else for(const [childIndex,child]of records(get(entry,definition.nested)).entries()){
      all.push({entry:{...child,_parent:entry,_value:child,_detailPath:`/details/${key}/${index}/${definition.nested}/${childIndex}`},key:`${key}/${index}/${definition.nested}`,index:childIndex});
    }
  }
  let title=definition.title;let columns=definition.columns;
  if(item.kind==='entity'&&observed&&definition.keys.startsWith('attributes')){title='源码字段与原始注释';columns=columns.map(column=>column.label==='业务含义'?{...column,label:'源码原始注释（未确认业务含义）'}:column);}
  if(!all.length){
    if(item.kind==='page'&&body.deliveryRegionFieldsShown&&['查询条件','列表内容','表单字段与校验'].includes(title))(body.deliveryRegionFieldSections ||= []).push(title);
    else (body.deliveryEmptySections ||= []).push(title);
    return;
  }
  const regionFields=item.kind==='page'&&definition.keys==='regions'&&definition.nested==='fields';
  if(regionFields)body.deliveryRegionFieldsShown=true;
  const foldRegionFields=regionFields&&['queryFields','searchFields','search','listColumns','columnProps','columns','formFields','editFields','fields'].some(key=>records(get(item,key)).length>0);
  const section=node('section',null,'delivery-detail-section');section.append(node('h3',title));
  body.append(foldRegionFields?detailDisclosure('区域字段原文与所属区块',section):section);
  if(definition.keys==='documentedChanges')section.append(node('p','这些是已记录的业务变化说明，与已验证任务交付范围独立。事后追溯不代表发布当时冻结的需求、验收通过或全系统功能范围。','field-help'));
  const table=node('table');const head=node('thead');const headings=node('tr');const tbody=node('tbody');
  for(const column of columns){const th=node('th',column.label);th.scope='col';headings.append(th);}head.append(headings);
  for(const {entry,key,index}of all){const row=node('tr');row.tabIndex=-1;const rowId=definition.keys==='documentedChanges'?JSON.stringify([entry.id,entry.revision,entry.provenance?.sourceCommit,entry.provenance?.sourcePath]):entry.localId||entry.id||`${key}[${index}]`;row.setAttribute('data-local-id',rowId);
    for(const position of [rowId,`/details/${key}/${index}`,`${key}.${index}`,`${key}[${index}]`,`${key}:${index}`,`details.${key}.${index}`,`details.${key}[${index}]`])state.detailAnchors.set(String(position),row);
    for(const column of columns){const td=node('td');const value=get(entry,column.key);const refs=referenceValues(value);
      if(column.format==='ref'&&refs.length)for(const ref of refs)td.append(referenceButton(ref));
      else if(column.format==='expandable-text'){
        const full=text(value);const summary=shortText(full,90);
        td.append(node('span',summary));if(full!==summary)td.append(detailDisclosure('展开完整说明',detailSection(column.label,full)));
      }else if(column.format==='documented-change-source'){
        for(const ref of refs)td.append(referenceButton({...ref,name:`查看说明修订 ${ref.revision}`,documentedChangeSource:true}));
        td.append(detailDisclosure('说明与来源定位',detailSection('业务说明',entry.description),detailSection('说明来源提交（非发布提交）',entry.provenance?.sourceCommit),detailSection('说明来源文档',entry.provenance?.sourcePath),detailSection('来源定位',entry.sources)));
      }
      else td.textContent=['commit','revision','code','ref'].includes(column.format)?text(value):column.format?formatField(value,column,entry):text(value);row.append(td);
    }tbody.append(row);
  }
  table.append(head,tbody);const wrap=node('div',null,'table-scroll delivery-detail-table');wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label',`${title}，可横向滚动`);wrap.append(table);section.append(wrap);
}
function appendFacts(body,item){
  const section=node('section',null,'delivery-detail-section');section.append(node('h3','采用、实现、验证与发布依据'));
  const record=node('dl',null,'delivery-detail-record');
  section.append(record);
  for(const [key,label,format]of [['adoption','采用情况','adoption'],['implementation','实现依据','evidence'],['verification','验证结论','evidence'],['businessConfirmation','业务确认','evidence'],['publication','发布依据','evidence']]){
    const value=get(item,key);const result=node('dd');if(format==='evidence'&&evidenceSummary(value).present)result.append(evidenceButton(value,{label},item));else result.textContent=formatField(value,{format},item);record.append(node('dt',label),result);
    if(format==='adoption'&&value&&typeof value==='object')section.append(detailDisclosure(`${label}明细`,detailSection(label,value)));
  }section.append(node('p','缺少关联只表示当前资料尚不能说明该事实，不自动判定未实现、未测试或未上线。','field-help'));body.append(section);
}
function safeSourceUrl(value,{download=false}={}){
  if(typeof value!=='string'||!value)return null;
  try{const base=new URL(window.location.href||'https://workbench.invalid/forge-gateway/');const url=new URL(value,base);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
    if(download&&(url.origin!==base.origin||!url.pathname.startsWith('/forge-gateway/')))return null;
    return url.href;
  }catch{return null;}
}
function appendSources(body,item){
  const section=node('section',null,'delivery-detail-section');section.append(node('h3','共享业务依据与来源定位'));
  if(!(item.sources||[]).length)section.append(node('p','尚未关联来源。不能据此补造原文或采用决定。','field-help'));
  for(const source of item.sources||[]){
    const record=node('article',null,'delivery-source-record');record.append(detailSection(source.label||source.name||'来源资料',{path:source.sourcePath||source.path||source.locator,section:source.section,line:source.line??source.lines,conversationId:source.conversationId||source.sourceConversationId,revision:source.revision||source.sourceRevision||source.commit,availability:enumNames.availability[source.availability]||'原文可用性未确认',occurredAt:source.occurredAt,formedAt:source.formedAt,recordedAt:source.recordedAt}));
    if(source.evidence)record.append(detailSection('依据说明（不代替原文摘录）',source.evidence));
    record.append(detailSection('原意摘录',source.excerpt||source.originalExcerpt||source.quote||'未收录可共享原意摘录；以上仅为来源定位。'));
    const href=safeSourceUrl(source.url||source.href||source.conversationUrl);
    if(href&&source.availability==='available'){const link=node('a','打开可访问的来源','secondary-button');link.href=href;link.target='_blank';link.rel='noopener noreferrer';record.append(link);}
    if(source.availability==='restricted')record.append(node('p','原件访问受限。这里只展示已收录的共享业务材料，不公开完整私聊或无关上传。','field-help'));
    section.append(record);
  }
  section.append(detailSection('AI解释',get(item,'interpretation','interpretedMeaning')),detailSection('采用决定及依据',get(item,'adoption')));body.append(section);
}
function correctionText(item){
  const ref={kind:item.kind||state.currentDetail?.kind||state.currentDetail?.type,id:item.assetId||item.id,revision:item.revision,localId:state.currentDetail?.localId};
  const locators=(item.sources||[]).map(source=>[source.path||source.sourcePath||source.locator,source.section,(source.line??source.lines)?`行 ${source.line??source.lines}`:'',source.revision||source.commit].filter(Boolean).join(' · '));
  const functionContext=[];
  if(state.functionId)functionContext.push(`功能筛选：${state.functionId}；${state.functionRevision?`明确引用修订 ${state.functionRevision}`:'按功能身份查询，关联修订未指定，不代表绑定当前功能修订'}`);
  if(state.readingContext?.item){const feature=state.readingContext.item;functionContext.push(`已查看功能定义：${feature.assetId||feature.id} @ ${feature.revision||'未指定'}（阅读定位，不替代关联修订）`);}
  return [`项目：${currentProjectName()} / ${state.project}`,`当前菜单：${state.menuId||'项目范围'}`,`查看范围：${state.releaseId?`发布 ${state.releaseId}`:state.batchId?`迭代 ${state.batchId}`:'当前资料'}；${state.menuScope==='self'?'本节点':'包含下级'}`,...functionContext,`对象：${businessRecordName(item,item.kind)}`,`对象定位：${JSON.stringify(ref)}`,`来源定位：${locators.join('\n')||'尚未关联'}`,`当前解释：${text(get(item,'interpretation','businessMeaning','definition','statement','description'),'尚未记录')}`,'待纠正点：'].join('\n');
}
function appendCorrection(body,item){
  const section=node('section',null,'delivery-detail-section');section.append(node('h3','通过原有对话纠正'));
  section.append(node('p','复制当前对象、修订与来源定位，在原对话或关联整理对话中说明待纠正点。中心不会自动发送消息或修改业务内容。','field-help'));
  const input=node('textarea');input.readOnly=true;input.rows=7;input.value=correctionText(item);input.setAttribute('aria-label','可复制的纠偏上下文');
  const message=node('p','','field-help');message.setAttribute('role','status');
  const button=action('复制纠偏上下文',async()=>{try{if(typeof navigator==='undefined'||!navigator.clipboard?.writeText)throw new Error('unavailable');await navigator.clipboard.writeText(input.value);message.textContent='已复制，可粘贴到原有对话。';}catch{input.focus();input.select?.();message.textContent='当前环境不支持自动复制，已选中上下文，请手动复制。';}});
  section.append(input,button,message);body.append(section);
}
function revisionIdentity(value,parent=value){return String(parent.kind==='requirement'||(!parent.kind&&!parent.assetId&&!parent.versionId)?value.revision||'':value.versionId||value.revision||'');}
function collectedReadingLabel(item){return `${item.isCurrent?'当前定义':'工作舱资料预览'} · ${item.readingSelection.candidateCount} 份工作舱候选；采用及发布按各自依据核对`;}
function revisionValues(item) {
  const result = new Map();
  for (const value of [...(item.revisions || []), item]) if (value && value.revision !== undefined) result.set(revisionIdentity(value,item), value);
  return [...result.values()].sort((left, right) => {
    const leftTime = Date.parse(left.recordedAt || left.updatedAt || left.createdAt);
    const rightTime = Date.parse(right.recordedAt || right.updatedAt || right.createdAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
    return /^\d+$/.test(String(left.revision)) && /^\d+$/.test(String(right.revision)) ? Number(left.revision) - Number(right.revision) : 0;
  });
}
function revisionLabel(value) {
  return /^\d+$/.test(String(value.revision)) ? `第 ${value.revision} 版` : `修订 ${String(value.revision).slice(0, 12)}${value.isCurrent ? '（当前）' : ''}`;
}
function comparableFields(item) {
  const flat = new Map();
  function visit(value, path, depth = 0) {
    if (depth > 10 || flat.size >= 1500) { flat.set(path, text(value)); return; }
    if (Array.isArray(value)) {
      if (!value.length) flat.set(path, '未记录');
      value.forEach((entry, index) => visit(entry, `${path} / ${entry && typeof entry === 'object' ? entry.name || entry.fieldName || entry.id || index + 1 : index + 1}`, depth + 1)); return;
    }
    if (value && typeof value === 'object') {
      if (!Object.keys(value).length) flat.set(path, '未记录');
      for (const [key, child] of Object.entries(value)) visit(child, `${path} / ${fieldNames[key] || key}`, depth + 1); return;
    }
    flat.set(path, text(value));
  }
  for (const key of ['name', 'description', 'menuIds', 'fields', 'actions', 'rules', 'permissions', 'details', 'relations', 'status']) if (item[key] !== undefined) visit(item[key], fieldNames[key] || key);
  return flat;
}
function revisionDiff(before, after) {
  const left = comparableFields(before); const right = comparableFields(after); const result = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) if (left.get(key) !== right.get(key)) result.push({ field: key, change: !left.has(key) ? '新增' : !right.has(key) ? '移除' : '修改', before: left.get(key) || '未记录', after: right.get(key) || '未记录' });
  return result;
}
function detailQuery(revision){
  const query=new URLSearchParams({project:state.project,detailMode:'single'});
  if(!state.currentDetail?.projectSource)for(const key of ['menuId','menuScope','menuBinding','batchId','releaseId'])if(state[key])query.set(key,state[key]);
  if(state.tab==='artifacts')for(const key of ['menuId','menuScope','menuBinding'])query.delete(key);
  if(revision!==undefined&&revision!==null&&revision!=='')query.set('revision',String(revision));return query;
}
async function readRevision(item,revision,signal,acrossBatches=false){
  const type=item.kind==='requirement'||state.currentDetail?.type==='requirements'?'requirements':'assets';
  const query=detailQuery(revision);if(acrossBatches&&!query.has('releaseId'))query.delete('batchId');
  const value=await api(`/forge-gateway/api/delivery/${type}/${encodeURIComponent(item.assetId||item.id)}?${query}`,{signal});
  if(!value.item)throw new Error('该修订未收录，未使用最新版替代。');return value.item;
}
function appendRevisionComparison(body,item){
  let versions=revisionValues(item);const section=node('section',null,'delivery-detail-section');section.append(node('h3','历史记录与版本对比'));
  const history=node('div');const controls=node('div',null,'delivery-version-controls');const result=node('div');result.setAttribute('aria-live','polite');
  let historyPage=0;let acrossBatches=false;const controller=state.detailRequest;
  const scope=detailQuery();scope.delete('detailMode');const canReadAcrossBatches=scope.has('batchId')&&!scope.has('releaseId');
  const scopeNote=node('p',null,'field-help');
  const sourceBatches=value=>[...new Set([...(Array.isArray(value.batchIds)?value.batchIds:[]),...(value.sources||[]).map(source=>source.batchId)].filter(Boolean))].join('、')||'来源批次未记录';
  const refresh=()=>{
    history.replaceChildren();
    scopeNote.textContent=acrossBatches?'正在查看同一对象的跨批次修订，主页面的菜单与批次范围保持不变；这些修订不自动成为当前定义。':scope.has('releaseId')?'仅查看该发布已绑定的修订，不用其他修订补齐发布范围。':scope.has('batchId')?'仅查看当前批次包含的修订，其他批次尚未在此展开。':'查看此对象已收录的修订，不由收录时间推定采用或发布。';
    const rows=versions.map(value=>({version:revisionLabel(value),sourceBatch:sourceBatches(value),recordedAt:date(value.recordedAt),changeSummary:value.changeSummary||'未单独收录业务变化说明',nature:enumNames.nature[value.nature||'unknown']}));
    history.append(detailTable(acrossBatches?'本对象跨批次修订':'已收录修订',rows,[['version','修订'],['sourceBatch','来源批次'],['recordedAt','收录时间'],['changeSummary','已记录变化'],['nature','资料性质']]));
    controls.replaceChildren();
    if(versions.length<2){controls.append(node('p',scope.has('batchId')&&!acrossBatches?'当前批次已读取的修订不足两份；其他批次的修订不在此范围内。':'当前范围已读取的修订不足两份，尚不能进行版本对比。','field-help'));return;}
    const choiceLabel=version=>`${revisionLabel(version)}${version.versionId?` · ${version.versionId.slice(-8)}`:''}`;
    const before=selectControl(controls,'delivery-compare-before','修订一',versions.map(version=>[revisionIdentity(version,item),choiceLabel(version)]),revisionIdentity(versions.at(-2),item),()=>{});
    const after=selectControl(controls,'delivery-compare-after','修订二',versions.map(version=>[revisionIdentity(version,item),choiceLabel(version)]),revisionIdentity(versions.at(-1),item),()=>{});
    const compare=action('读取并比较这两版',async()=>{
      if(before.value===after.value){result.replaceChildren(node('p','请选择两个不同版本。','field-help'));return;}
      compare.disabled=true;result.replaceChildren(node('p','正在读取两份指定修订…','loading-row'));
      try{
        const loaded=await Promise.all([readRevision(item,before.value,controller?.signal,acrossBatches),readRevision(item,after.value,controller?.signal,acrossBatches)]);
        if(controller?.signal.aborted||state.detailRequest!==controller)return;
        const [oldValue,newValue]=loaded;result.replaceChildren();
        const changes=get(newValue,'semanticChanges');
        if(Array.isArray(changes)&&changes.length){result.append(node('p','以下是较新修订附带的变化记录；其原比较范围按来源核对，不视为所选两版的完整业务差异。','field-help'));appendSchemaTable(result,{details:{semanticChanges:changes}},{keys:'semanticChanges',title:'较新修订所附业务变化',columns:[{key:'target|name',label:'变更对象',format:'ref'},{key:'changeType|type',label:'变更类型'},{key:'before',label:'变更前'},{key:'after',label:'变更后'},{key:'reason',label:'变更原因'},{key:'sources',label:'采用依据',format:'sources'}]});}
        else result.append(node('p','这两版之间尚无已关联的业务变化说明。下方资料差异仅辅助核对，不能据此判断采用、实现或发布完成。','delivery-scope-note'));
        const difference=revisionDiff(oldValue,newValue);
        result.append(detailDisclosure('辅助查看资料字段差异',difference.length?detailTable('资料字段差异',difference,[['field','位置'],['change','资料变化'],['before',revisionLabel(oldValue)],['after',revisionLabel(newValue)]]):node('p','已收录字段未发现差异。','field-help')));
      }catch(error){if(!controller?.signal.aborted)result.replaceChildren(node('p',error.message,'form-message error'));}finally{compare.disabled=false;}
    });controls.append(compare);
  };
  const loadHistory=async(switchAcross=false)=>{
    const requestedAcross=acrossBatches||(switchAcross&&canReadAcrossBatches);const nextPage=requestedAcross!==acrossBatches?1:historyPage+1;
    more.disabled=true;crossBatch.disabled=true;result.replaceChildren(node('p','正在读取此对象的历史修订…','field-help'));
    try{const query=new URLSearchParams(scope);if(requestedAcross&&!query.has('releaseId'))query.delete('batchId');query.set('view','history');query.set('kind',item.kind||'requirement');query.set('recordId',item.assetId||item.id);query.set('page',String(nextPage));query.set('pageSize','50');
      const value=await api(`/forge-gateway/api/delivery/views?${query}`,{signal:controller?.signal});if(controller?.signal.aborted||state.detailRequest!==controller)return;
      const byRevision=new Map(versions.map(value=>[revisionIdentity(value,item),value]));for(const entry of value.items||[])byRevision.set(revisionIdentity(entry,item),entry);versions=revisionValues({...item,revisions:[...byRevision.values()]});historyPage=nextPage;acrossBatches=requestedAcross;refresh();result.replaceChildren();more.hidden=historyPage*50>=value.total;crossBatch.hidden=!canReadAcrossBatches||acrossBatches;
    }catch(error){if(!controller?.signal.aborted)result.replaceChildren(node('p',error.message,'form-message error'));}finally{more.disabled=false;crossBatch.disabled=false;}
  };
  const more=action('读取更多历史修订',()=>loadHistory());
  const crossBatch=action('查看此对象跨批次修订',()=>loadHistory(true));crossBatch.hidden=!canReadAcrossBatches;
  more.hidden=item.revisionsHasMore===false;refresh();section.append(scopeNote,history,controls,more,crossBatch,result);body.append(section);
}
let diagramLibrary;
async function diagramRenderer() {
  if (!diagramLibrary) diagramLibrary = import('/forge-gateway/assets/mermaid/mermaid.esm.min.mjs').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: 30000 }); return mermaid;
  }).catch(error => { diagramLibrary = null; throw error; });
  return diagramLibrary;
}
function safeDiagramSource(diagram) {
  const source = diagram?.source;
  if (!['flowchart', 'erDiagram'].includes(diagram?.type) || typeof source !== 'string' || !source.trim() || source.length > 30000) return false;
  if (!/^\s*(?:flowchart\s+(?:TB|TD|BT|RL|LR)|graph\s+(?:TB|TD|BT|RL|LR)|erDiagram)\b/.test(source)) return false;
  return !/(?:%%\{|^\s*---|\b(?:click|href)\b|^\s*callback\b|(?:https?|javascript|data):|url\s*\(|@\{|<\s*\/?[A-Za-z])/im.test(source);
}
function diagramNodePositions(svg, targets) {
  // Parse only the renderer's geometry; the SVG is never inserted as active markup.
  if (typeof DOMParser === 'undefined' || !Array.isArray(targets) || targets.length > 120) return [];
  try {
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const root = parsed.documentElement;
    if (root.localName !== 'svg' || parsed.querySelector('parsererror')) return [];
    const box = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return [];
    const known = new Map(targets.filter(target => /^N\d+$/.test(target.nodeId) && /^\/details\/(steps|transitions)\/\d+$/.test(target.localId)).map(target => [target.nodeId, target]));
    const positions = [];
    for (const group of root.querySelectorAll('g.node')) {
      const match = /^(?:delivery-diagram-\d+-)?flowchart-(N\d+)-\d+$/.exec(group.getAttribute('id') || '');
      const target = match && known.get(match[1]); const rect = group.querySelector('rect');
      if (!target || !rect) continue;
      let [x, y, width, height] = ['x', 'y', 'width', 'height'].map(key => Number(rect.getAttribute(key)));
      if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) continue;
      let valid = true;
      for (let element = rect; element && element !== root; element = element.parentNode) {
        const transform = element.getAttribute?.('transform'); if (!transform) continue;
        const translation = /^translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)$/.exec(transform);
        if (!translation || !Number.isFinite(Number(translation[1])) || !Number.isFinite(Number(translation[2] || 0))) { valid = false; break; }
        x += Number(translation[1]); y += Number(translation[2] || 0);
      }
      if (!valid || x < box[0] || y < box[1] || x + width > box[0] + box[2] || y + height > box[1] + box[3]) continue;
      positions.push({ ...target, left: (x - box[0]) / box[2] * 100, top: (y - box[1]) / box[3] * 100, width: width / box[2] * 100, height: height / box[3] * 100 });
    }
    return positions;
  } catch { return []; }
}
function appendDiagram(body, diagram, title = null) {
  const section = node('section', null, 'delivery-detail-section'); section.append(node('h3', title || (diagram.type === 'erDiagram' ? '业务实体关系图' : '业务流程图')));
  if(diagram.notes)section.append(node('p',text(diagram.notes),'field-help'));
  const display = node('div', '正在准备图示…', 'delivery-diagram'); display.tabIndex = 0; display.setAttribute('role', 'region'); display.setAttribute('aria-label', '业务关系图，可滚动查看');
  const disclosure = node('details'); disclosure.append(node('summary', '查看图示原文与来源'), node('pre', text(diagram.source), 'delivery-diagram-source'), detailSection('图示来源', diagram.sourceRefs)); section.append(display, disclosure); body.append(section);
  if (!safeDiagramSource(diagram)) { display.textContent = '图示内容不符合安全展示格式，请查看原文和关系表。'; return; }
  const renderId = `delivery-diagram-${++state.diagramSequence}`;
  const active = () => $('delivery-detail').open && Array.from(body.children).includes(section);
  const anchors = new Map(state.detailAnchors);
  diagramRenderer().then(renderer => {
    if (!active()) return null;
    return renderer.render(renderId, diagram.source);
  }).then(result => {
    if (!result || !active()) return;
    const { svg } = result;
    const picture = node('img'); picture.alt = title || (diagram.type === 'erDiagram' ? '业务实体及其逻辑关系，具体属性和关系见上方表格' : '业务处理流程，步骤和条件见上方记录');
    picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    picture.addEventListener('error', () => { if (active()) display.textContent = '图示暂时无法显示，原文和关系表仍可查看。'; }, { once: true });
    const canvas = node('div', null, 'delivery-diagram-canvas'); canvas.append(picture);
    let targetCount = 0;
    for (const position of diagramNodePositions(svg, diagram.nodeTargets)) {
      const target = anchors.get(position.localId); if (!target) continue;
      const button = action('', () => {
        if (!active() || state.detailAnchors.get(position.localId) !== target) return;
        target.className = 'delivery-focused-record';
        if (state.currentDetail) state.currentDetail.localId = position.localId;
        revealDetailTarget(target);
      }, 'delivery-diagram-node');
      button.setAttribute('aria-label', `查看图中节点：${position.label}`); button.title = `定位原修订中的步骤或状态记录：${position.label}`;
      // Numeric CSSOM assignments remain usable with the existing style-src 'self' policy.
      for (const property of ['left', 'top', 'width', 'height']) button.style[property] = `${position[property]}%`;
      button.setAttribute('data-diagram-node', position.nodeId); canvas.append(button); targetCount++;
    }
    if (targetCount) section.append(node('p', '点击图中有标记的节点，可定位本修订的原步骤或状态记录；对象、规则和菜单沿该记录中的明确引用查看。', 'field-help'));
    display.replaceChildren(canvas);
  }).catch(() => { if (active()) display.textContent = '图示渲染暂不可用，原文和关系表仍可查看。'; });
}
function renderDetail(type,item){
  if(!state.detailRequest)state.detailRequest=new AbortController();
  if(!state.currentDetail||state.currentDetail.item!==item)state.currentDetail={type,item,kind:item.kind,loaded:true,view:{related:new Map()}};
  state.currentDetail.view ||= {related:new Map()};
  const body=$('delivery-detail-body');body.replaceChildren();state.diagramSequence+=1;state.detailAnchors.clear();
  body.deliveryEmptySections=[];
  body.deliveryRegionFieldSections=[];body.deliveryRegionFieldsShown=false;
  const kind=item.kind||({requirements:'requirement',menus:'menu',releases:'release',artifacts:'artifact',stages:'stage',batches:'batch'})[type];
  $('delivery-detail-title').textContent=businessRecordName(item,kind);
  $('delivery-detail-context').textContent=`${deliveryTabs[kindTabs[kind]]?.name||'业务记录'} · ${state.currentDetail?.projectSource?'变化说明来源（独立于发布验证范围）':state.releaseId?`发布 ${state.releaseId}`:state.batchId?`迭代 ${state.batchId}`:'已收录需求与设计'} · ${item.revision?revisionLabel(item):'修订未明确'}`;
  if(type==='assets'&&item.readingSelection){
    const section=node('section',null,'delivery-detail-section');section.append(node('p',collectedReadingLabel(item),'delivery-scope-note'));
    const choices=revisionValues(item);const choose=selectControl(section,'delivery-collected-revision','查看已收录修订',choices.map(value=>[revisionIdentity(value),`${revisionLabel(value)} · ${(value.sources||[]).find(source=>source.taskId||source.batchId)?.taskId||(value.sources||[]).find(source=>source.batchId)?.batchId||value.versionId?.slice(-8)||'来源见详情'}`]),revisionIdentity(item),()=>{});
    section.append(action('读取这份修订',()=>{const selected=choices.find(value=>revisionIdentity(value)===choose.value);if(selected)showDetail('assets',{...selected,assetId:item.assetId||item.id,kind:item.kind,name:item.name},{push:true});}));body.append(section);
  }
  $('delivery-detail-previous').hidden=!state.detailTrail.length;
  if(type==='assets'||type==='requirements'){appendAssetDetails(body,{...item,kind});}
  else if(type==='menus'){
    const purpose=detailSection('菜单业务用途与边界',shortText(get(item,'businessPurpose','purpose','description'),300,'业务用途尚未单独收录。下面按已关联的功能阅读，不据配置名称补造业务说明。'));purpose.className+=' delivery-detail-overview';body.append(purpose);
    appendCheckpointMaterials(body,item.id,'delivery-detail-checkpoint-batch');
    const rows=records(get(item,'functions','features'));if(rows.length)appendSchemaTable(body,{details:{functions:rows}},{keys:'functions',title:'当前功能清单',columns:[{key:'name',label:'功能名称'},{key:'description|purpose',label:'业务说明'},{key:'pageRefs',label:'关联页面',format:'ref'},{key:'requirementRefs',label:'对应要求',format:'ref'}]});
    else appendLazyRelated(body,item,'当前功能清单','overview',{automatic:true});
    body.append(detailDisclosure('菜单来源与配置事实',detailSection('来源与配置',{origin:enumNames.origin[item.origin||'unknown'],businessChange:enumNames.businessChange[item.businessChange||'unknown'],runtimeConfiguration:enumNames.runtimeConfiguration[item.runtimeConfiguration||'unknown'],resourceType:resourceType(item.resourceType),enabled:formatField(item.enabled,{format:'enabled'},item),visible:formatField(item.visible,{format:'visible'},item),directoryStatus:item.directoryStatus||'目录状态未明确'}),detailSection('完整业务说明',{businessPurpose:get(item,'businessPurpose','purpose'),users:get(item,'users','actors'),input:get(item,'input'),outcome:get(item,'outcome','businessResult'),contextId:get(item,'contextId'),description:item.description})));
    const section=node('section',null,'delivery-detail-section');section.append(node('h3','关联资料明细'));
    for(const tab of ['requirements','entities','scenes','database','pages','backend','permissions','acceptance','releases'])appendLazyRelated(section,item,deliveryTabs[tab].name,tab);
    body.append(section);appendLazyRelated(body,item,'迭代沿革','changes');
    appendSources(body,item);appendCorrection(body,{...item,kind:'menu'});
    body.append(detailDisclosure('菜单原配置与层级依据',detailSection('原始配置',{id:item.id,menuPath:item.path,route:item.route,component:item.component,parentId:item.parentId,sourceParentId:item.sourceParentId,hierarchyNote:item.hierarchyNote,visible:item.visible,status:item.status}),detailSection('运行配置观察（不代表业务采用决定）',item.runtimeObservation)));
  }else if(type==='evidence-record'){
    body.append(detailSection('已记录的结论',item.description),detailSection('证据内容与适用范围',item.evidence));
    if(item.parentObject?.id){const section=node('section',null,'delivery-detail-section');section.append(node('h3','对应对象'),referenceButton(item.parentObject));body.append(section);}
    const refs=explicitReferences({evidence:item.evidence});if(refs.length){const section=node('section',null,'delivery-detail-section');section.append(node('h3','证据中已有的对象引用'));for(const ref of refs)section.append(referenceButton(ref));body.append(section);}
  }else if(type==='reference-choice'){
    appendReferenceChoices(body,item);
  }else if(type==='releases'){
    body.append(detailSection('发布尝试',{id:item.id,version:item.businessVersion||item.version,environment:environment(item.environment),status:item.status,startedAt:item.startedAt,finishedAt:item.finishedAt||item.releasedAt,initiator:item.initiator||item.actor,scope:item.scope,scopeBinding:enumNames.scopeBinding[item.scopeBinding||'unknown'],baseline:item.baseline,changeSummary:item.changeSummary}));
    if(item.scope==='validated-task-delivery')body.append(node('p','此记录是本次任务交付范围，不是全项目完整功能快照。','delivery-scope-note'));
    if(item.scopeBinding==='unknown'||!item.requirementSnapshots?.length&&!item.fullScope)body.append(node('p','完整发布范围尚无充分依据。不能用当前需求替代历史版本内容。','delivery-scope-note'));
    if(item.scopeBindingDiagnostic==='PHASE_DELIVERY_NOT_COMPLETED')body.append(node('p','对应任务尚未形成完整阶段交付快照，因此无法据此确认发布需求范围。已记录的变化说明不会补齐该验证依据。','delivery-scope-note'));
    for(const definition of detailSchemas.release)appendSchemaTable(body,item,definition);
    body.append(detailSection('已记录提交',{commit:item.commit,frontendCommit:item.frontendCommit,backendCommit:item.backendCommit}));
    const actions=node('div',null,'delivery-detail-actions');actions.append(action('查看本发布需求范围',()=>navigate({tab:'requirements',releaseId:item.id,batchId:'',page:1,q:''})),action('查看本发布制品',()=>navigate({tab:'artifacts',releaseId:item.id,batchId:'',page:1,q:''})));body.append(actions);
    appendSources(body,item);appendCorrection(body,{...item,kind:'release'});
    body.append(detailDisclosure('完整发布原记录',detailSection('原记录',item)));
  }else if(type==='stages'){
    body.append(detailSection('原任务阶段',{name:item.name||phaseNames[item.phaseId],phaseId:phaseNames[item.phaseId]||item.phaseId,taskId:item.taskId,batchId:item.batchId,status:item.status==='accepted'?'阶段已接受':item.status,scope:item.scope,createdAt:item.createdAt,isCurrent:item.isCurrent}),detailSection('业务说明',item.summary));
    body.append(detailTable('阶段产物',get(item,'artifacts'),[['name','产物名称'],['type','产物类型'],['description','内容说明'],['revision','对应版本'],['adoption','采用情况']]));
    appendSources(body,item);appendCorrection(body,{...item,kind:'stage'});body.append(detailDisclosure('完整阶段产物',detailSection('阶段记录技术标识',{recordSnapshotRevision:item.revision,artifactDigest:item.digest}),detailSection('原阶段内容',item.details)));
  }else{
    const columns=deliveryTabs[state.tab]?.columns||[];const record=node('dl',null,'delivery-detail-record');
    for(const column of columns){const value=get(item,column.key);record.append(node('dt',column.label),node('dd',column.format?formatField(value,column,item):text(value)));}
    body.append(record);
    if(type==='view-row'&&!item.parentRef)body.append(node('p','该记录尚未建立可定位的父对象及修订，以下保留已收录资料。','field-help'));
    appendSources(body,item);appendCorrection(body,{...item,kind});appendDownload(body,item);
    body.append(detailDisclosure('完整已收录内容',detailSection('原记录',item)));
  }
  finishDetailSections(body);
  if(state.readingContext){const reading=node('div');appendReadingContext(reading);body.replaceChildren(...Array.from(reading.children),...Array.from(body.children));}
  const localId=state.currentDetail?.localId;
  if(localId){const target=state.detailAnchors.get(String(localId));if(target){target.className='delivery-focused-record';if(!state.currentDetail.view.restored)revealDetailTarget(target);else target.focus({preventScroll:true});}else body.append(node('p',`已打开对应修订；尚未找到局部位置 ${localId}，未猜测其他字段。`,'delivery-scope-note'));}
}
function appendDownload(body,item){
  const href=safeSourceUrl(item.downloadUrl,{download:true});if(!href)return;
  const link=node('a','下载已收录发布包','secondary-button');link.href=href;link.download=item.fileName||'';body.append(link);
}
function appendLazyRelated(body,menu,title,tab,{automatic=false}={}){
  const section=node('section',null,'delivery-detail-section');section.append(node('h3',title));const content=node('div');const controller=state.detailRequest;
  const detail=state.currentDetail;const related=detail?.view?.related;
  const render=(result,page)=>{
    content.replaceChildren();
    if(!result.items?.length)content.append(node('p',tab==='overview'?'尚未整理为独立功能定义，可从来源资料阅读已经形成的业务内容。':'当前范围尚未建立该类关联，不能据此判断没有实现。','field-help'));
    for(const row of result.items||[]){const article=node('div',null,'delivery-related-record');const meaning=relatedMeaning(row,tab==='overview'?['businessGoal','goal','businessPurpose','purpose','description']:['description','purpose']);article.append(node('strong',row.name||row.title||row.id),node('p',primitiveBrief(meaning,'用途未单独收录'),'field-help'));
      article.append(action(tab==='overview'?'沿此功能核对':'查看对应记录',()=>{if(row.parentRef)return openReference({...row.parentRef,localId:row.localId},{row});if(row.kind)return openReference({kind:row.kind,id:row.assetId||row.id,revision:row.revision},{row});if(endpointForTab(tab)==='requirements')return openReference({kind:'requirement',id:row.id,revision:row.revision},{row});return showDetail(endpointForTab(tab),row,{push:true});},'text-button'));content.append(article);}
    const controls=node('div',null,'delivery-detail-actions');if(page>1)controls.append(action('上一页关联',()=>read(page-1)));if(page*20<result.total)controls.append(action('下一页关联',()=>read(page+1)));
    controls.append(action('在管理模块查看',()=>navigate({tab,menuId:menu.id,page:1,q:''})));if(tab==='overview'||tab==='requirements')controls.append(action('查看来源资料',()=>navigate({tab:'sources',menuId:menu.id,recordType:'',origin:'',businessChange:'',adoption:'',nature:'',page:1,q:''})));content.append(controls);
    button.hidden=true;
  };
  const read=async(page=1)=>{
    button.disabled=true;content.replaceChildren(node('p','正在读取关联资料…','loading-row'));
    try{const definition=deliveryTabs[tab];const query=detailQuery();query.delete('detailMode');query.set('menuId',menu.id);query.set('page',String(page));query.set('pageSize','20');query.set('projection','summary');
      if(definition.view)query.set('view',definition.view);if(definition.kind)query.set('kind',definition.kind);if(definition.recordType)query.set('recordType',definition.recordType);
      const endpoint=definition.view?'views':definition.endpoint||'assets';const result=await api(`/forge-gateway/api/delivery/${endpoint}?${query}`,{signal:controller?.signal});
      if(controller?.signal.aborted||state.detailRequest!==controller)return;
      related?.set(tab,{result,page});render(result,page);
    }catch(error){if(!controller?.signal.aborted){content.replaceChildren(node('p',error.message,'form-message error'));button.hidden=false;button.textContent=`重新读取${title}`;}}finally{button.disabled=false;}
  };
  const button=action(`读取${title}`,()=>read());section.append(button,content);body.append(section);
  const cached=related?.get(tab);if(cached)render(cached.result,cached.page);else if(automatic){button.hidden=true;read();}
}
function appendFunctionRelated(body,item){
  const section=node('section',null,'delivery-detail-section');section.append(node('h3','与此功能有关的资料'),node('p','按资料中明确记录的功能编号关联。关联修订未指定时，不等于绑定当前功能修订；可打开每条资料自身已收录的修订。','field-help'));
  const choices=[['requirement','关联要求','requirements'],['page','关联页面','pages'],['entity','关联业务对象','entities'],['table','关联数据表','database'],['api','关联接口','backend'],['scene','关联场景','scenes']];
  const tabs=node('div',null,'delivery-detail-actions');const content=node('div');content.setAttribute('aria-live','polite');section.append(tabs,content);body.append(section);
  const current=state.currentDetail;const cache=current.view.related;const controller=state.detailRequest;let pending=null;let selected='';
  const display=(choice,result,page)=>{
    selected=choice[0];for(const button of tabs.children)button.setAttribute('aria-pressed',String(button.dataset.kind===selected));content.replaceChildren();
    if(!result.items?.length)content.append(node('p','当前范围没有收录明确引用此功能的该类资料，不能据此判断业务未实现。','field-help'));
    else{const table=node('table');const head=node('thead');const header=node('tr');for(const label of ['业务记录','内容摘要','关联功能修订','该记录修订','查看']){const th=node('th',label);th.scope='col';header.append(th);}head.append(header);const rows=node('tbody');
      for(const row of result.items){const tr=node('tr');tr.append(node('td',businessRecordName(row,choice[0])),node('td',primitiveBrief(relatedMeaning(row,['businessGoal','statement','description','purpose']),'用途未单独收录')),node('td',functionAssociationLabel(row)),node('td',row.revision?String(row.revision).slice(0,12):'修订未明确'));const control=node('td');control.append(action('查看这条记录',()=>openReference({kind:choice[0],id:row.assetId||row.id,revision:row.revision,name:businessRecordName(row,choice[0])},{row}),'text-button'));tr.append(control);rows.append(tr);}table.append(head,rows);const wrap=node('div',null,'table-scroll delivery-detail-table');wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','功能关联资料，可横向滚动');wrap.append(table);content.append(wrap);}
    const controls=node('div',null,'delivery-detail-actions');if(page>1)controls.append(action('上一页关联资料',()=>read(choice,page-1)));if(page*20<result.total)controls.append(action('下一页关联资料',()=>read(choice,page+1)));
    controls.append(action(`在${deliveryTabs[choice[2]].name}中查看`,()=>navigate({tab:choice[2],functionId:item.assetId||item.id,functionRevision:'',q:'',page:1,recordType:'',origin:'',businessChange:'',adoption:'',nature:''})));content.append(controls);
  };
  const read=async(choice,page=1)=>{
    pending?.abort();pending=new AbortController();const request=pending;controller.signal.addEventListener('abort',()=>request.abort(),{once:true});content.replaceChildren(node('p','正在读取明确关联的资料…','loading-row'));
    const query=detailQuery();query.delete('detailMode');query.set('functionId',item.assetId||item.id);query.set('page',String(page));query.set('pageSize','20');query.set('projection','summary');if(choice[0]==='requirement')query.set('recordType','requirement');else query.set('kind',choice[0]);
    try{const result=await api(`/forge-gateway/api/delivery/${choice[0]==='requirement'?'requirements':'assets'}?${query}`,{signal:request.signal});if(request.signal.aborted||state.currentDetail!==current)return;cache.set('function-associations',{choice:choice[0],result,page});display(choice,result,page);}
    catch(error){if(!request.signal.aborted&&state.currentDetail===current)content.replaceChildren(node('p',error.message,'form-message error'),action('重新读取关联资料',()=>read(choice,page)));}
  };
  for(const choice of choices){const button=action(choice[1],()=>{const saved=cache.get('function-associations');if(saved?.choice===choice[0]){pending?.abort();display(choice,saved.result,saved.page);}else read(choice);});button.dataset.kind=choice[0];button.setAttribute('aria-pressed','false');tabs.append(button);}
  const saved=cache.get('function-associations');if(saved)display(choices.find(choice=>choice[0]===saved.choice),saved.result,saved.page);
}
function appendReferenceChoices(body,item){
  const ref=item.reference;body.append(detailSection('关联引用',item.description),node('p','下列修订仅供选择查看。选择某个已收录修订，不会把原引用补记为精确绑定。','field-help'));
  const content=node('div');const controller=state.detailRequest;const current=state.currentDetail;
  const read=async(page=1)=>{
    button.disabled=true;content.replaceChildren(node('p','正在读取已收录修订…','loading-row'));
    const query=detailQuery();query.delete('detailMode');query.set('view','history');query.set('kind',ref.kind);query.set('recordId',ref.id);query.set('page',String(page));query.set('pageSize','20');
    try{const result=await api(`/forge-gateway/api/delivery/views?${query}`,{signal:controller.signal});if(controller.signal.aborted||state.currentDetail!==current)return;content.replaceChildren();
      if(!result.items?.length)content.append(node('p','此范围尚未收录可选择的修订，未替换为其他对象。','field-help'));
      for(const revision of result.items||[]){const row=node('div',null,'delivery-related-record');row.append(node('p',`${revisionLabel(revision)} · ${date(revision.recordedAt)}`));if(revision.revision)row.append(action(`查看修订 ${String(revision.revision).slice(0,12)}`,()=>openReference({...ref,revision:revision.revision},{row:item}),'text-button'));content.append(row);}
      if(page>1)content.append(action('上一页修订',()=>read(page-1)));if(page*20<result.total)content.append(action('下一页修订',()=>read(page+1)));button.hidden=true;
    }catch(error){if(!controller.signal.aborted&&state.currentDetail===current)content.replaceChildren(node('p',error.message,'form-message error'));}finally{button.disabled=false;}
  };
  const button=action('读取已收录修订',()=>read());body.append(button,content);appendSources(body,item);
}
function endpointForTab(tab){const definition=deliveryTabs[tab];return definition.view?'views':definition.endpoint||'assets';}
async function openReference(ref,{row,replace=false}={}){
  if(!ref?.kind||!ref?.id)return showDetail('view-row',row||{name:'关联定位未明确'},{push:!replace});
  if(!ref.revision&&!['menu','release'].includes(ref.kind))return showDetail(ref.kind==='requirement'||deliveryTabs[kindTabs[ref.kind]]?.kind?'reference-choice':'view-row',{...row,id:ref.id,assetId:ref.id,kind:ref.kind,revision:null,name:row?.name||ref.name||ref.id,parentRef:null,description:'目标修订未明确，未打开最新版替代。',reference:ref},{push:!replace});
  const type=({menu:'menus',requirement:'requirements',release:'releases',stage:'stages',artifact:'artifacts',batch:'batches'})[ref.kind]||'assets';
  const initial=type==='menus'?state.menus.find(menu=>menu.id===ref.id)||{id:ref.id,name:ref.name,description:'此范围未收录该菜单节点。'}:{id:ref.id,assetId:type==='assets'?ref.id:undefined,kind:ref.kind,revision:ref.revision,name:ref.name||row?.name};
  return showDetail(type,initial,{localId:ref.localId,push:!replace,projectSource:ref.documentedChangeSource===true||state.currentDetail?.projectSource===true});
}
async function showDetail(type,initial,{localId,push=false,projectSource=false}={}){
  if(type==='stages'&&!initial.revision)return showDetail('view-row',{...initial,kind:'stage',description:'阶段记录快照修订未明确，未读取当前记录替代。'},{localId,push});
  if(type==='stages')initial={...initial,kind:'stage'};
  if(push)extendReadingContext(state.currentDetail?.item,initial);
  captureDetailView();const previous=state.currentDetail;if(push&&previous){state.detailTrail.push(previous);if(state.detailTrail.length>20)state.detailTrail.shift();}else if(!push)state.detailTrail=[];
  closeDetail({preserveTrail:true});const controller=new AbortController();state.detailRequest=controller;
  const cached=(initial.revision||type==='menus')?state.detailCache.get(detailCacheKey(type,initial,projectSource)):null;
  state.currentDetail={type,item:initial,kind:initial.kind,localId,projectSource,view:cached?.view||{related:new Map()}};
  $('delivery-detail-title').textContent=text(initial.name||initial.version||initial.id||initial.assetId,'记录详情');$('delivery-detail-context').textContent='';
  const dialog=$('delivery-detail');dialog.showModal();$('delivery-detail-close').focus();
  const finish=item=>{state.currentDetail={...state.currentDetail,type,item,kind:item.kind,localId,loaded:true};rememberReadingContext(item);if(!projectSource){state.focusKind=item.kind||({menus:'menu',requirements:'requirement',releases:'release'})[type]||'';state.focusId=item.assetId||item.id||'';state.focusRevision=type==='assets'?revisionIdentity(item):item.revision||'';state.localId=localId||'';saveLocation(true);}renderDetail(type,item);renderActiveFilters(state.menus.find(menu=>menu.id===state.menuId));};
  if(cached){cached.view.restored=true;finish(cached.item);return;}
  if(!['requirements','releases','assets','stages'].includes(type)){finish(initial);return;}
  $('delivery-detail-body').append(node('p','正在读取指定记录…','loading-row'));
  try{const value=await api(`/forge-gateway/api/delivery/${type}/${encodeURIComponent(initial.assetId||initial.id)}?${detailQuery(type==='assets'?revisionIdentity(initial):initial.revision)}`,{signal:controller.signal});
    if(controller.signal.aborted||state.detailRequest!==controller||!dialog.open)return;
    if(!value.item)throw new Error('该记录或修订尚未收录，未替换为其他版本。');
    if(type==='stages'&&value.item.revision!==initial.revision)throw new Error('阶段记录快照修订不匹配，未替换为其他版本。');
    finish(type==='stages'?{...value.item,kind:'stage'}:value.item);
  }catch(error){if(controller.signal.aborted||state.detailRequest!==controller||error.name==='AbortError')return;const message=node('p',error.message,'form-message error');message.setAttribute('role','alert');$('delivery-detail-body').replaceChildren(message,action('重新读取这条记录',()=>showDetail(type,initial,{localId,push:false,projectSource})));}
}
function previousDetail(){
  captureDetailView();const previous=state.detailTrail.pop();if(!previous)return;closeDetail({preserveTrail:true});state.detailRequest=new AbortController();state.currentDetail=previous;previous.view ||= {related:new Map()};previous.view.restored=true;$('delivery-detail').showModal();renderDetail(previous.type,previous.item);
  state.focusKind=previous.item.kind||previous.kind||'';state.focusId=previous.item.assetId||previous.item.id||'';state.focusRevision=previous.item.revision||'';state.localId=previous.localId||'';saveLocation(true);
}
function dismissDetail(){captureDetailView();closeDetail();Object.assign(state,{focusKind:'',focusId:'',focusRevision:'',localId:'',lastFocusKey:null});saveLocation(true);}
async function exportMatrix(){
  state.exportRequest?.abort();const controller=new AbortController();state.exportRequest=controller;const button=$('delivery-export');const message=$('delivery-export-status');button.disabled=true;message.hidden=false;message.textContent='正在导出当前范围内全部匹配结果…';
  const timeout=setTimeout(()=>controller.abort(),60000);
  try{const query=queryFor({paginated:false});query.delete('projection');query.set('view','requirement-matrix');if(state.listScope?.snapshotDigest)query.set('snapshotDigest',state.listScope.snapshotDigest);
    const response=await fetch(`/forge-gateway/api/delivery/export?${query}`,{credentials:'same-origin',signal:controller.signal,headers:{accept:'text/csv'}});
    if(response.status===401){window.location.assign('/forge-gateway/login');throw new Error('登录已失效。');}
    if(!response.ok){const value=await response.json().catch(()=>({}));throw new Error(value.message||`导出未完成（${response.status}），未下载部分结果。`);}
    if(!/text\/csv/i.test(response.headers.get('content-type')||''))throw new Error('服务器未返回CSV文件，未将其他响应当作成功导出。');
    const blob=await response.blob();if(controller.signal.aborted||state.exportRequest!==controller)return;const href=URL.createObjectURL(blob);const link=node('a');link.href=href;link.download=`${currentProjectName().replace(/[\\/:*?"<>|]/g,'_')}需求矩阵.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(href),1000);
    message.textContent='需求矩阵已生成下载。导出包含全部匹配结果及范围信息，不限当前页或可见列。';
   }catch(error){if(state.exportRequest===controller)message.textContent=error.name==='AbortError'?'导出已取消或超时，未声明完成。':error.message;}finally{clearTimeout(timeout);if(state.exportRequest===controller){state.exportRequest=null;button.disabled=state.loading;}}
}
function navigate(changes, { replace = false } = {}) {
  clearTimeout(state.searchTimer); state.searchTimer = null;
  captureDetailView();
  const projectChanged = changes.project !== undefined && changes.project !== state.project; const previousReleaseId = state.releaseId; const previousBatchId=state.batchId;const previousDirectory=state.directoryScope;
  const scopeChanged=projectChanged||['menuId','batchId','releaseId','menuBinding'].some(key=>Object.hasOwn(changes,key)&&changes[key]!==state[key]);
  const inheritedFunction=!scopeChanged&&changes.tab&&supportsFunctionFilter(changes.tab)?state.functionId||state.readingContext?.item?.assetId||state.readingContext?.item?.id||'':'';
  const next = normalizeFilters({ ...state, ...(projectChanged ? { menuId: '', batchId: '', releaseId: '', q: '', page: 1,origin:'',businessChange:'',adoption:'',nature:'',recordType:'',directoryScope:'',menuBinding:'any' } : {}), ...(scopeChanged?{functionId:'',functionRevision:'',readingContext:null}:{}), ...(inheritedFunction?{functionId:inheritedFunction}:{}), ...changes });
  if (['project', 'tab', 'menuId', 'batchId', 'releaseId', 'q', 'page', 'pageSize','menuPreset',...filterKeys].every(key => next[key] === state[key]) && !state.listRequest?.signal.aborted) { state.readingContext=next.readingContext;dismissDetail();renderControls();return; }
  const oldKey=locationKey();state.viewHistory.set(oldKey,{scrollTop:$('delivery-table-wrap').scrollTop||0,page:state.page,q:state.q});
  state.exportRequest?.abort();state.pickerRequest?.abort();$('delivery-scope-picker').hidden=true;
  Object.assign(next,{focusKind:'',focusId:'',focusRevision:'',localId:'',lastFocusKey:null});
  const menuChanged = next.menuId !== state.menuId;
  if(projectChanged||menuChanged||next.batchId!==state.batchId||next.releaseId!==state.releaseId||next.menuBinding!==state.menuBinding)next.readingContext=null;
  Object.assign(state, next); if (projectChanged) productionPanel?.setProject(state.project); if (menuChanged) expandSelectedMenuPath(); closeDetail(); renderControls(); renderMenus(); saveLocation(replace);
  return projectChanged || previousReleaseId !== state.releaseId ||previousBatchId!==state.batchId||previousDirectory!==state.directoryScope ? loadProject() : loadList();
}
function locationKey(tab=state.tab,functionId=state.functionId){return `${state.project}:${state.menuId}:${state.batchId}:${state.releaseId}:${functionId||''}:${state.functionRevision||''}:${tab}`;}
function navigateModule(tab){const functionId=supportsFunctionFilter(tab)?state.functionId||state.readingContext?.item?.assetId||state.readingContext?.item?.id||'':'';const saved=state.viewHistory.get(locationKey(tab,functionId));return navigate({tab,page:saved?.page||1,q:saved?.q||'',recordType:''});}
function commitSearch() { if (state.composing) return; return navigate({ q: $('delivery-search').value.trim(), page: 1 }, { replace: true }); }
function bindEvents() {
  $('delivery-project').addEventListener('change', () => navigate({ project: $('delivery-project').value }));
  for (const button of document.querySelectorAll('[data-delivery-tab]')) button.addEventListener('click', () => navigateModule(button.dataset.deliveryTab));
  $('delivery-all-menus').addEventListener('click', () => navigate({ menuId: '', page: 1 }));
  $('delivery-reset').addEventListener('click', () => navigate({ q: '', menuId: '', batchId: '', releaseId: '', page: 1,origin:'',businessChange:'',adoption:'',nature:'',recordType:'',directoryScope:'',menuBinding:'any',menuPreset:'all',functionId:'',functionRevision:'',readingContext:null }));
  $('delivery-prev').addEventListener('click', () => navigate({ page: Math.max(1, state.page - 1) }));
  $('delivery-next').addEventListener('click', () => navigate({ page: state.page + 1 }));
  $('delivery-page-size').addEventListener('change', () => navigate({ pageSize: Number($('delivery-page-size').value), page: 1 }));
  $('delivery-search-form').addEventListener('submit', event => { event.preventDefault(); commitSearch(); });
  $('delivery-search').addEventListener('compositionstart', () => { state.composing = true; clearTimeout(state.searchTimer); state.listRequest?.abort(); });
  $('delivery-search').addEventListener('compositionend', () => { state.composing = false; clearTimeout(state.searchTimer); state.searchTimer = setTimeout(commitSearch, 300); });
  $('delivery-search').addEventListener('input', event => {
    clearTimeout(state.searchTimer); $('delivery-search-clear').hidden = !$('delivery-search').value;
    if (state.composing || event.isComposing) return;
    state.listRequest?.abort(); if (!$('delivery-search').value) commitSearch(); else state.searchTimer = setTimeout(commitSearch, 300);
  });
  $('delivery-search-clear').addEventListener('click', () => { clearTimeout(state.searchTimer); state.composing = false; $('delivery-search').value = ''; commitSearch(); $('delivery-search').focus(); });
  $('delivery-menu-search').addEventListener('input', () => { state.menuQuery = $('delivery-menu-search').value; renderMenus(); });
  $('delivery-menu-search-clear').addEventListener('click', () => { state.menuQuery = ''; $('delivery-menu-search').value = ''; renderMenus(); $('delivery-menu-search').focus(); });
  $('delivery-expand-menus').addEventListener('click', () => { for (const item of state.menus) menuExpansions().add(item.id); renderMenus(); });
  $('delivery-collapse-menus').addEventListener('click', () => { menuExpansions().clear(); renderMenus(); });
  $('delivery-list-retry').addEventListener('click', loadList); $('delivery-project-retry').addEventListener('click', loadProject); $('delivery-refresh').addEventListener('click', () => state.tab === 'production' && productionPanel ? productionPanel.refresh().catch(error => { $('delivery-production-panel').querySelector('#production-message').textContent = error.message; }) : loadProject()); $('delivery-start-retry').addEventListener('click', initialize);
  $('delivery-detail-close').addEventListener('click', dismissDetail); $('delivery-detail-back').addEventListener('click', dismissDetail);
  $('delivery-detail-previous').addEventListener('click',previousDetail);$('delivery-export').addEventListener('click',exportMatrix);
  $('delivery-detail').addEventListener('cancel',()=>{Object.assign(state,{focusKind:'',focusId:'',focusRevision:'',localId:'',lastFocusKey:null});saveLocation(true);});
  $('delivery-detail').addEventListener('close', () => { if (!$('delivery-detail').open) { state.detailRequest?.abort(); state.detailRequest = null; state.diagramSequence += 1; } });
  window.addEventListener('popstate', () => { clearTimeout(state.searchTimer); Object.assign(state, readLocation()); productionPanel?.setProject(state.project); renderControls(); saveLocation(true); loadProject(); });
}
async function initialize() {
  $('delivery-start-error').hidden = true; $('delivery-start-retry').hidden = true;
  try {
    const session = await api('/forge-gateway/api/session'); state.session = session; $('delivery-user').textContent = session.user.displayName || session.user.username;
    const value = await api('/forge-gateway/api/delivery/projects');
    state.projects = (value.items || []).map(project => ({ ...project, slug: project.slug || project.id || project.projectKey })).filter(project => typeof project.slug === 'string' && project.slug);
    const select = $('delivery-project'); select.replaceChildren();
    for (const project of state.projects) { const option = node('option', project.displayName || project.name || project.slug); option.value = project.slug; select.append(option); }
    if (!state.projects.length) { const option = node('option', '暂无项目'); option.value = ''; select.append(option); }
    if (!state.projects.some(project => project.slug === state.project)) {
      Object.assign(state, { project: state.projects[0]?.slug || '', menuId: '', batchId: '', releaseId: '', q: '', page: 1, functionId: '', functionRevision: '', focusKind: '', focusId: '', focusRevision: '', localId: '', lastFocusKey: null });
    }
    select.disabled = state.projects.length < 2; renderControls(); saveLocation(true); await loadProject();
  } catch (error) { $('delivery-start-error').textContent = error.message; $('delivery-start-error').hidden = false; $('delivery-start-retry').hidden = false; }
}

bindEvents();
initialize();
