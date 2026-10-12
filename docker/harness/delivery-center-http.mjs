import { DELIVERY_VIEWS } from './delivery-center-views.mjs';
const PREFIX = '/forge-gateway/api/delivery/';
const PROJECT = /^[a-z][a-z0-9-]{2,31}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

export class DeliveryCenterError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.code = code; this.status = status;
  }
}

function invalid(message) { throw new DeliveryCenterError('DELIVERY_INVALID_QUERY', message); }

// A source revision is an opaque label, not an entity identifier.
export function isDeliveryRevision(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 191
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function deliveryQuery(parameters) {
  const filters = {};
  const allowed = new Set(['project', 'q', 'menuId', 'batchId', 'releaseId', 'page', 'pageSize', 'kind', 'revision',
    'menuScope', 'menuBinding', 'origin', 'businessChange', 'adoption', 'recordType', 'projection', 'detailMode', 'referenceGroup',
    'recordId', 'view', 'status', 'environment', 'isCurrent', 'stageId', 'phaseId', 'snapshotDigest', 'directoryScope', 'nature', 'functionId', 'functionRevision']);
  for (const key of parameters.keys()) {
    if (!allowed.has(key) || parameters.getAll(key).length !== 1) invalid('查询参数无效，请重新选择筛选条件。');
  }
  const project = parameters.get('project');
  if (!PROJECT.test(project ?? '')) invalid('请选择有效的项目。');
  for (const key of ['menuId', 'batchId', 'releaseId', 'recordId', 'stageId', 'phaseId', 'snapshotDigest', 'recordType', 'status', 'environment', 'functionId']) {
    const value = parameters.get(key);
    if (value !== null && value !== '') {
      if (!IDENTIFIER.test(value)) invalid('筛选条件无效。');
      filters[key] = value;
    }
  }
  for (const key of ['revision', 'functionRevision']) {
    const value = parameters.get(key);
    if (value !== null) {
      if (!isDeliveryRevision(value)) invalid('资产版本无效。');
      filters[key] = value;
    }
  }
  if (filters.functionRevision && !filters.functionId) invalid('指定关联功能修订时必须同时指定功能。');
  const q = parameters.get('q')?.trim();
  if (q && (q.length > 200 || /[\u0000-\u001f]/u.test(q))) invalid('搜索内容最多200个字符，不能包含控制字符。');
  if (q) filters.q = q;
  const kind = parameters.get('kind');
  if (kind !== null) {
    if (!['function', 'scene', 'entity', 'table', 'page', 'api', 'permission', 'test', 'rule', 'dictionary', 'task', 'requirement', 'menu'].includes(kind)) invalid('资产分类无效。');
    filters.kind = kind;
  }
  for (const [key, values] of Object.entries({ menuScope: ['self', 'descendants'], menuBinding: ['any', 'linked', 'none', 'unknown'],
    origin: ['baseline', 'base-upgrade', 'business-added', 'unknown'], businessChange: ['modified', 'unchanged', 'unknown'],
    adoption: ['adopted', 'proposed', 'withdrawn', 'superseded', 'unknown'], projection: ['summary'], detailMode: ['single'], referenceGroup: ['main', 'shared'],
    isCurrent: ['true', 'false'], nature: ['original', 'interpretation', 'design', 'implementation-observation', 'execution', 'historical-compilation', 'unknown'], directoryScope: ['current', 'historical', 'all'], view: Object.keys(DELIVERY_VIEWS) })) {
    const value = parameters.get(key);
    if (value !== null && value !== '') { if (!values.includes(value)) invalid('筛选值无效。'); filters[key] = value; }
  }
  for (const [key, fallback, limit] of [['page', 1, 100000], ['pageSize', 50, 200]]) {
    const raw = parameters.get(key);
    const value = raw === null ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > limit) invalid('分页参数无效。');
    filters[key] = value;
  }
  return { project, filters };
}

function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textValue).join('；');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function csvCell(value) {
  let text = textValue(value).replace(/\u0000/g, '');
  // Quoting alone does not prevent Excel/LibreOffice formula execution.
  if (/^[\s\uFEFF]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function requirementsCsv(items) {
  const headings = ['功能编号', '一级菜单', '二级菜单', '三级菜单', '完整菜单路径', '页面', '功能点', '需求说明',
    '字段', '操作', '业务规则', '业务权限', '需求批次', '功能状态', '阶段状态', '需求版本', '来源依据'];
  const rows = items.map((item) => {
    const menu = Array.isArray(item.menuPath) ? item.menuPath : [];
    return [item.id, menu[0], menu[1], menu[2], menu.join(' / '), item.page, item.name, item.description,
      item.fields, item.actions, item.rules, item.permissions, item.batchIds, item.status,
      item.stageStatus, item.revision, item.sources];
  });
  return '\uFEFF' + [headings, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Called only after Gateway authentication. No browser route can import or mutate. */
export async function deliveryResponse({ method, url, store }) {
  if (!url.pathname.startsWith(PREFIX)) return null;
  if (method !== 'GET') throw new DeliveryCenterError('DELIVERY_READ_ONLY', '需求与交付中心只支持查看和导出。', 405);
  if (!store) throw new DeliveryCenterError('DELIVERY_UNAVAILABLE', '需求与交付中心尚未连接数据库，请联系平台维护人员。', 503);
  const route = url.pathname.slice(PREFIX.length);
  if (route === 'projects') {
    if (url.searchParams.size) invalid('项目目录不接受筛选参数。');
    return { body: { items: await store.listProjects() } };
  }
  const { project, filters } = deliveryQuery(url.searchParams);
  if (filters.functionId && (!['assets', 'requirements', 'export'].includes(route) || filters.view)) invalid('此入口不支持按关联功能筛选，请打开需求或资产列表。');
  if (route === 'export') {
    if (filters.view === 'requirement-matrix') {
      const result = await store.exportView(project, filters);
      const headings = ['行类型', '一级菜单', '二级菜单', '三级菜单', '菜单编号', '完整历史菜单路径',
        '功能编号', '功能版本', '功能名称', '需求编号', '需求版本', '需求名称', '完整业务正文', '要求类型', '适用条件',
        '采用情况', '关联迭代', '来源定位', '资料性质', '字段', '操作', '业务规则', '业务权限', '验收标准', '其他业务定义',
        '实现情况', '实现依据', '验证结论', '验证依据', '发布情况', '发布依据', '关联依据状态', '未明确项说明',
        '查看范围', '项目', '选中菜单', '菜单范围', '所选迭代', '所选发布', '筛选条件', '资料快照', '资料观察时间'];
      const scope = result.scope ?? {};
      const exportItems = result.items.length ? result.items : [{ rowType: 'scope-only', missingEvidence: ['当前范围尚无已收录的独立要求或功能关联；不表示业务系统没有功能。'] }];
      const rows = exportItems.map(item => {
        const paths = item.menuPaths?.length ? item.menuPaths : item.menuPath?.length ? [item.menuPath] : [];
        const hierarchyPaths = Array.isArray(item.menuHierarchyPaths) ? item.menuHierarchyPaths : paths;
        const levels = [0, 1, 2].map(index => [...new Set(hierarchyPaths.map(parts => parts[index]).filter(Boolean))]);
        return [item.rowType, ...levels, item.menuIds, paths.map(parts => parts.join(' / ')),
          item.functionRef?.id, item.functionRef?.revision, item.functionName, item.requirementRef?.id, item.requirementRef?.revision,
          item.requirementName, item.description, item.requirementType, item.conditions, item.adoption, item.batchIds, item.sources, item.nature,
          item.fields, item.actions, item.rules, item.permissions, item.acceptanceCriteria, item.details,
          item.implementation, item.implementationEvidence, item.verification, item.verificationEvidence, item.publication, item.publicationEvidence,
          item.bindingStatus, item.missingEvidence, scope.mode, scope.project, scope.menuId, scope.menuScope, scope.batchId, scope.releaseId,
          scope.filters, scope.snapshotDigest, scope.observedAt];
      });
      return { csv: '\uFEFF' + [headings, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n',
        filename: `requirement-matrix-${project}.csv`, count: result.items.length, scope: result.scope, counts: result.counts };
    }
    const rows = await store.exportRequirements(project, filters);
    return { csv: requirementsCsv(rows), filename: `requirements-${project}.csv`, count: rows.length };
  }
  if (route === 'overview') return { body: await store.overview(project, filters) };
  if (route === 'views') return { body: await store.listView(project, filters) };
  if (route === 'menus') return { body: { items: await store.listMenus(project, filters) } };
  const methodName = {
    requirements: 'listRequirements', batches: 'listBatches', stages: 'listStages',
    releases: 'listReleases', artifacts: 'listArtifacts', assets: 'listAssets',
  }[route];
  if (methodName) return { body: await store[methodName](project, filters) };
  const detail = /^(requirements|releases|assets|stages)\/([^/]+)$/.exec(route);
  if (detail) {
    let id;
    try { id = decodeURIComponent(detail[2]); } catch { invalid('记录编号无效。'); }
    if (!IDENTIFIER.test(id)) invalid('记录编号无效。');
    const item = await store[{ requirements: 'getRequirement', releases: 'getRelease', assets: 'getAsset', stages: 'getStage' }[detail[1]]](project, id, filters);
    if (!item) throw new DeliveryCenterError('DELIVERY_NOT_FOUND', '记录不存在或尚未收录。', 404);
    return { body: { item } };
  }
  throw new DeliveryCenterError('DELIVERY_NOT_FOUND', '此查询入口不存在。', 404);
}
