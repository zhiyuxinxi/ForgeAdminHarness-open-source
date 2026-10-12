/** Read projections only. Missing definitions never become business verdicts. */
const array = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const BUSINESS_SUMMARY_KEYS = ['businessGoal', 'observableResult', 'boundaries', 'knownLimitations', 'businessResult', 'outcome'];
export const DELIVERY_VIEWS = Object.freeze({
  'menu-matrix': [], 'requirement-matrix': ['function'], 'requirements-sources': [],
  changes: ['*'], relations: ['entity'], definitions: ['entity', 'dictionary', 'rule'],
  processes: ['scene'], 'model-mappings': ['entity', 'table'], constraints: ['table'],
  'structure-changes': ['table'], 'page-implementations': ['page'], calls: ['api'],
  'permission-rules': ['permission'], 'permission-matrix': ['permission'], 'permission-evidence': ['permission'],
  acceptance: ['test'], 'test-cases': ['test'], 'test-executions': ['test'], issues: ['test'],
  'feature-delivery': ['function'], 'business-versions': [], 'release-attempts': [], environments: [], history: ['*'],
});
export const VIEW_DETAIL_KEYS = Object.freeze({
  relations: ['relationships', 'relations'], definitions: ['definitions', 'terms'],
  processes: ['processes'], 'model-mappings': ['modelMappings', 'mappings', 'entityMappings', 'relations'],
  constraints: ['constraints', 'indexes'], 'structure-changes': ['migrations', 'structureChanges'],
  'page-implementations': ['implementations'], calls: ['calls', 'dependencies', 'internalCalls', 'externalCalls'],
  'permission-rules': ['rules', 'permissionRules'], 'permission-matrix': ['rules', 'permissionRules'],
  'permission-evidence': ['evidence', 'implementationEvidence'], acceptance: ['acceptanceCriteria', 'criteria'],
  'test-cases': ['testCases', 'cases'], 'test-executions': ['executions', 'runs'], issues: ['issues', 'defects'],
  'feature-delivery': ['delivery', 'stageResults'], changes: ['semanticChanges'],
});
export function viewReadDetailKeys(view) {
  const observedFields = view === 'permission-rules' ? ['roles', 'permissionCodes', 'description', 'tenantScope']
    : view === 'permission-evidence' ? ['code', 'actions', 'roleBindings', 'definitionType', 'endpointRule', 'trustedContext', 'trustedFields', 'tenantAndScope', 'serverPermissions']
    : view === 'page-implementations' ? ['component', 'route'] : view === 'feature-delivery' ? BUSINESS_SUMMARY_KEYS : [];
  return [...(VIEW_DETAIL_KEYS[view] ?? []), ...observedFields];
}
export const HEADER_KEYS = Object.freeze(['assetId', 'kind', 'name', 'revision', 'sourceRevision', 'sourceScope', 'recordedAt',
  'status', 'certainty', 'menuIds', 'menuPaths', 'batchIds', 'releaseIds', 'sources', 'commits', 'recordType',
  'nature', 'contextId', 'origin', 'originSources', 'businessChange', 'adoption', 'functionRefs', 'menuRefs',
  'menuApplicability', 'supersedes', 'description', 'summary', 'purpose', 'sourceTopic', 'sourcePhaseStatus']);
const SUMMARY_DETAIL_KEYS = ['comment', 'purpose', 'businessMeaning', 'description', 'subject', 'operation', 'resource', 'conditions',
  ...BUSINESS_SUMMARY_KEYS,
  'trigger', 'goal', 'result', 'actor', 'actors', 'normalResult', 'owner', 'entity', 'table', 'route', 'layout', 'method', 'path', 'endpoint',
  'authentication', 'authorization', 'dataScope', 'expected', 'actual', 'environment', 'commit', 'evidence',
  'implementation', 'definition', 'version', 'scopeBinding', 'scope', 'status', 'required', 'nullable',
  'businessPurpose', 'contextName', 'responsibility', 'definitionType', 'latestBatch', 'lastBatch', 'requirementType',
  'processingMode', 'behaviorType', 'provider', 'menuUsage', 'usage', 'pageType', 'pageMode', 'parentPage', 'scenarioRefs',
  'subjectType', 'decision', 'preconditions', 'expectedResult', 'actualResult', 'executionStatus', 'verdict',
  'businessConfirmation', 'verification', 'publication', 'issueCount', 'entityCount', 'processCount', 'menuCount', 'usedByMenuCount'];
export function summaryDetailKeys() { return [...SUMMARY_DETAIL_KEYS]; }
export function recordNature(item) { return item.nature ?? 'unknown'; }
export function requirementType(item) {
  if (item.recordType) return item.recordType;
  return item.granularity === 'specification-section' || item.details?.granularity === 'specification-section' ? 'source-section' : 'unknown';
}
export function menuBinding(item) {
  if (item.menuApplicability === 'none') return 'none';
  return item.menuId || array(item.menuIds).length || array(item.menuRefs).length || array(item.menuPaths).length ? 'linked' : 'unknown';
}
function matchedFunctionRefs(item, filters) {
  return array(item.functionRefs).filter(ref => ref?.kind === 'function' && ref.id === filters.functionId
    && (!filters.functionRevision || ref.revision === filters.functionRevision));
}
export function withFunctionAssociation(item, filters) {
  if (!filters.functionId) return item;
  return { ...item, functionAssociation: { id: filters.functionId, revision: filters.functionRevision ?? null,
    binding: filters.functionRevision ? 'exact-revision' : 'identity-only', refs: matchedFunctionRefs(item, filters) } };
}
export function semanticMatch(item, filters = {}) {
  if (filters.functionId && !matchedFunctionRefs(item, filters).length) return false;
  if (filters.nature && recordNature(item) !== filters.nature) return false;
  if (filters.status && (item.status ?? 'unknown') !== filters.status) return false;
  if (filters.origin && (item.origin ?? 'unknown') !== filters.origin) return false;
  if (filters.businessChange && (item.businessChange ?? 'unknown') !== filters.businessChange) return false;
  if (filters.adoption && (typeof item.adoption === 'string' ? item.adoption : item.adoption?.state ?? 'unknown') !== filters.adoption) return false;
  if (filters.recordType && requirementType(item) !== filters.recordType) return false;
  return !filters.menuBinding || filters.menuBinding === 'any' || menuBinding(item) === filters.menuBinding;
}
export function deliverySummary(item) {
  const { details, revisions, diagram, raw, content, body, searchMatches, documentedChanges, ...head } = item;
  const result = { ...head, nature: recordNature(item) };
  if (Array.isArray(item.documentedChangePreview)) result.documentedChangePreview = item.documentedChangePreview.slice(0, 3)
    .map(({ id, revision, name }) => ({ id, revision, name: typeof name === 'string' ? name.slice(0, 96) : '' }));
  for (const key of ['description', 'summary', 'purpose', ...BUSINESS_SUMMARY_KEYS]) {
    if (typeof result[key] === 'string') result[key] = result[key].slice(0, 240);
    else if (Array.isArray(result[key])) result[key] = result[key].slice(0, 5);
  }
  if (object(details)) result.details = Object.fromEntries(SUMMARY_DETAIL_KEYS.filter(key => details[key] !== undefined)
    .map(key => [key, typeof details[key] === 'string' ? details[key].slice(0, 240) : Array.isArray(details[key]) ? details[key].slice(0, 5) : details[key]]));
  // Sources are navigable evidence; complete excerpts live in the single revision.
  if (['entity', 'table'].includes(item.kind) && object(item.menuReference)) {
    // Menu lists carry bounded reference previews. The exact version detail
    // retains every original source, dependency chain and historical revision.
    const reference = item.menuReference;
    const selected = new Set(array(reference.menuIds));
    const sourcePreview = source => object(source) ? Object.fromEntries([
      'type', 'kind', 'path', 'sourcePath', 'line', 'commit', 'sha256', 'digest', 'stageId', 'batchId', 'pointer', 'label',
    ].filter(key => ['string', 'number'].includes(typeof source[key])).map(key => [key, source[key]])) : {};
    const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
    const scoped = array(item.sources).filter(source => object(source)
      && [...array(source.menuIds), source.menuId].some(id => selected.has(id)));
    const previews = unique((scoped.length ? scoped : array(item.sources)).map(sourcePreview));
    result.sourceCount = array(item.sources).length;
    result.sources = previews.slice(0, 4);
    result.sourcesHasMore = previews.length > result.sources.length || scoped.length < array(item.sources).length;
    result.menuCount = array(item.menuIds).length;
    result.menuIds = [...selected].slice(0, 4);
    result.resolvedMenuIds = result.menuIds;
    delete result.menuPaths;
    if (Array.isArray(item.usedByMenus)) result.usedByMenuCount = item.usedByMenus.length;
    delete result.usedByMenus;
    const bindings = unique(array(reference.bindings).map(binding => ({
      pagePath: binding.pagePath, componentPath: binding.componentPath, endpointId: binding.endpointId,
      method: binding.method, path: binding.path,
      sources: unique(array(binding.sources).map(sourcePreview)).slice(0, 2),
    })));
    result.menuReference = { ...reference, menuIds: result.menuIds, bindingCount: bindings.length,
      bindings: bindings.slice(0, 4), bindingsHasMore: bindings.length > 4 };
  } else result.sources = array(item.sources).map(source => { if (!object(source)) return source; const { content, text, excerpt, ...metadata } = source; return metadata; });
  if (Array.isArray(result.relations)) result.relationCount = result.relations.length;
  delete result.relations;
  for (const key of ['fields', 'actions', 'rules', 'permissions', 'acceptanceCriteria']) {
    if (Array.isArray(result[key])) { result[`${key}Count`] = result[key].length; delete result[key]; }
  }
  return result;
}
export function historyMetadata(item) {
  return { id: item.id ?? item.assetId, revision: item.revision ?? null, versionId: item.versionId ?? item.digest ?? null,
    recordedAt: item.recordedAt ?? null, nature: recordNature(item), status: item.status ?? null,
    sourceRevision: item.sourceRevision ?? null, changeSummary: item.changeSummary ?? null,
    sources: deliverySummary({ sources: item.sources }).sources };
}
export function recordRef(item, kind = item.kind) {
  return { kind, id: item.id ?? item.assetId, revision: item.revision ?? null };
}
function childRow(parent, child, key, index) {
  const value = object(child) ? child : { description: String(child) };
  const localId = value.localId ?? `/${key}/${index}`;
  return { ...value, id: value.id ?? `${parent.id}:${localId}`, name: value.name ?? value.title ?? value.label ?? null,
    recordType: value.recordType ?? key, nature: value.nature ?? recordNature(parent), revision: value.revision ?? null,
    parentRef: recordRef(parent), localId, menuIds: parent.menuIds ?? [], menuPaths: parent.menuPaths ?? [],
    sources: value.sources ?? parent.sources ?? [] };
}
function legacyImplementationObservation(view, parent, details) {
  const sources = array(parent.sources);
  const common = { id: `${parent.id}:${view}:observation`, name: parent.name, nature: 'implementation-observation',
    revision: parent.revision ?? null, parentRef: recordRef(parent), localId: null,
    menuIds: parent.menuIds ?? [], menuPaths: parent.menuPaths ?? [],
    implementation: null, publication: null, verification: null };
  if (view === 'permission-evidence' && parent.kind === 'permission' && typeof details.code === 'string' && details.code.trim()
    && sources.some(source => source?.kind === 'menu-configuration')) {
    return { ...common, recordType: 'resource-registration-observation', ruleRef: null, decision: null,
      locationType: 'menu-configuration', target: details.code, code: details.code,
      actions: details.actions ?? null, roleBindings: details.roleBindings ?? null, definitionType: details.definitionType ?? null,
      configuration: { code: details.code, actions: details.actions ?? null, roleBindings: details.roleBindings ?? null, definitionType: details.definitionType ?? null },
      observationMeaning: '资源登记观察；未据此确定角色授权规则、允许或拒绝。',
      sources: sources.filter(source => source?.kind === 'menu-configuration') };
  }
  const codeSources = sources.filter(source => source?.type === 'code-snapshot' && typeof source.path === 'string' && source.path
    && /^[a-f0-9]{40}$/u.test(source.commit ?? '') && /^[a-f0-9]{64}$/u.test(source.sha256 ?? ''));
  if (view === 'page-implementations' && parent.kind === 'page' && typeof details.component === 'string' && details.component.trim() && codeSources.length) {
    return { ...common, recordType: 'code-implementation-observation', pageRef: recordRef(parent), component: details.component,
      route: typeof details.route === 'string' && /^\/(?!\/)/u.test(details.route) ? details.route : null,
      reportedRoute: details.route ?? null, usage: '源码实现关联观察', commits: [...new Set(codeSources.map(source => source.commit))],
      observationMeaning: '源码快照中的组件关联；未据此确定需求采用、交互验证或发布。', sources: codeSources };
  }
  return null;
}
function permissionSourceSummary(view, parent, details) {
  if (view !== 'permission-rules' || parent.kind !== 'permission' || recordNature(parent) !== 'design'
    || ![details.roles, details.permissionCodes].some(value => array(value).length)
      && ![details.description, details.tenantScope, parent.description].some(value => typeof value === 'string' && value.trim())) return null;
  return { ...deliverySummary(parent), parentRef: recordRef(parent), localId: null,
    recordMeaning: '权限设计资料（未展开为授权规则）',
    description: (details.description ?? parent.description ?? '').slice(0, 240),
    roles: array(details.roles), permissionCodes: array(details.permissionCodes), tenantScope: details.tenantScope ?? null,
    decision: null, implementation: null, publication: null, verification: null };
}
function stageDeclarationRows(view, parent, details) {
  const pointer = key => String(key).replace(/~/gu, '~0').replace(/\//gu, '~1');
  const row = (value, path) => ({ ...value, id: `${parent.id ?? parent.assetId}:${path}`, parentRef: recordRef(parent), localId: path,
    revision: parent.revision, menuIds: parent.menuIds ?? [], menuPaths: parent.menuPaths ?? [], sources: parent.sources ?? [],
    sourceTopic: parent.sourceTopic, sourceRecord: parent.name, nature: recordNature(parent),
    recordMeaning: '阶段产物中的声明；回执未经本中心单独复核。' });
  if (['permission-rules', 'permission-matrix'].includes(view) && parent.recordType === 'permission-contract') {
    const declarations = Array.isArray(details.roles) && details.roles.some(object)
      ? details.roles.flatMap((value, index) => object(value) && typeof value.roleKey === 'string' && value.roleKey.trim()
        ? [[value.roleKey, value, `/details/roles/${index}`]] : [])
      : Object.entries(details).filter(([key, value]) => key !== 'roleSeedPolicy' && object(value)
        && ['canPerform','canSee','canAct','dataScope','roleKeys'].some(key => value[key] !== undefined))
        .map(([key, value]) => [key, value, `/details/${pointer(key)}`]);
    return declarations.map(([key, value, localId]) => {
        const displayName = value.displayNameZh ?? value.displayName ?? key;
        return { ...row({ name: displayName, subject: displayName, subjectKey: key, subjectType: array(value.roleKeys).length ? '角色组（未展开逐角色授权）' : '命名角色',
          roleKeys: value.roleKeys, canPerform: value.canPerform, canSee: value.canSee ?? value.visibleCapabilities, canAct: value.canAct,
          dataScope: typeof value.dataScope === 'number' ? null : value.dataScope,
          denialConditions: details.denyRules ?? null, taskConditions: value.conditions ?? value.taskConditions ?? null,
          sourceNameNote: typeof displayName === 'string' && /\ufffd|锟斤拷|\?{2,}/u.test(displayName) ? '源名称异常，保留原文；未推定中文名称。' : null }, localId),
          status: parent.status, sourcePhaseStatus: parent.sourcePhaseStatus, isCurrent: parent.isCurrent,
          recordMeaning: parent.sourcePhaseStatus === 'historical' ? '历史阶段产物中的声明；未证明当前授权或执行。'
            : '阶段产物中的声明；回执未经本中心单独复核。' };
      });
  }
  if (view === 'permission-evidence' && parent.recordType === 'permission-enforcement') {
    return [row({ name: parent.name, ruleRef: recordRef(parent), locationType: '阶段实现声明',
      target: details.endpointRule ?? null, configuration: details.trustedContext ?? null,
       endpointRule: details.endpointRule ?? null, trustedContext: details.trustedContext ?? null,
       trustedFields: details.trustedFields ?? null, tenantAndScope: details.tenantAndScope ?? null,
       serverPermissions: details.serverPermissions ?? null,
      implementation: null, publication: null, verification: null,
    }, null)];
  }
  if (view === 'permission-rules' && parent.recordType === 'permission-enforcement') {
    return Object.entries(object(details.dataScopes) ? details.dataScopes : {}).map(([key, scope]) => row({
      name: key, subject: key, subjectType: '实现声明中的范围主体', dataScope: scope,
      denialConditions: details.failClosedRules ?? null, taskConditions: details.assignedTaskRules ?? null,
    }, `/details/dataScopes/${pointer(key)}`));
  }
  if (view === 'test-executions' && parent.recordType === 'test-evidence-report') {
    const result = [];
    const historical = parent.sourcePhaseStatus === 'historical';
    const emit = (value, path, name, reused = false) => {
      if (!object(value) || typeof value.receiptId !== 'string' || !value.receiptId) return;
      const status = typeof value.status === 'string' ? value.status : value.recordedStatus;
      if (!reused && !(typeof value.profile === 'string' && typeof status === 'string')) return;
      result.push({ ...row({ name, profile: value.profile ?? null, executionStatus: reused ? null : status,
        executed: value.executed ?? null, passed: value.passed ?? null, failed: value.failed ?? null, skipped: value.skipped ?? null,
        executionCounts: ['executed','passed','failed','skipped'].map(key => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : '未记录').join(' / '),
        receiptId: value.receiptId, sourcePhaseStatus: parent.sourcePhaseStatus,
        executionKind: historical ? '历史阶段执行声明，非本次验证证明' : reused || value.reuse || value.notRevalidatedThisTurn === true ? '历史回执引用，非本次执行证明' : '原产物执行声明',
        limitations: [value.reuse, value.notRevalidatedThisTurn === true ? '原文标明本轮未复验' : null,
          details.notYetProven, details.notRunInThisPhase, value.truth, value.truthBoundary,
          value.advisoriesOrRequiresRetained, details.evidenceBinding].filter(value => value !== null && value !== undefined),
      }, path), ...(historical ? { recordMeaning: '历史阶段产物中的声明；非本次验证证明，回执未经本中心单独复核。' } : {}) });
    };
    for (const key of ['receipts', 'verificationReceipts', 'directVerification']) {
      array(details[key]).forEach((value, index) => emit(value, `/details/${key}/${index}`, value?.profile ?? '回执声明'));
    }
    for (const [key, value] of Object.entries(details)) {
      if (key === 'runtimeEvidenceReused') emit(value, `/details/${pointer(key)}`, key, true);
      else if (key !== 'receipts') emit(value, `/details/${pointer(key)}`, key);
    }
    return result;
  }
  return null;
}
export function buildSubview(view, assets = []) {
  const rows = [];
  for (const parent of assets) {
    const details = parent.details ?? {};
    const declarations = stageDeclarationRows(view, parent, details);
    if (declarations) { rows.push(...declarations); continue; }
    const keys = VIEW_DETAIL_KEYS[view] ?? [];
    let found = false;
    for (const key of keys) {
      const values = key === 'semanticChanges' ? parent.semanticChanges ?? details[key]
        : key === 'relationships' ? details[key] : details[key];
      for (const [index, child] of array(values).entries()) {
        if (view === 'relations' && (child?.type === 'maps-to-table' || ['table', 'page', 'api'].includes(child?.to?.kind ?? child?.targetKind))) continue;
        if (view === 'model-mappings' && key === 'relations' && child?.type !== 'maps-to-table'
          && !['table', 'entity'].includes(child?.to?.kind ?? child?.targetKind)) continue;
        const row = childRow(parent, child, `details/${key}`, index);
        rows.push(view === 'permission-rules' ? { ...row, recordMeaning: '结构化权限规则' } : row); found = true;
      }
    }
    if (view === 'relations' || view === 'model-mappings') for (const [index, relation] of array(parent.relations).entries()) {
      const targetKind = relation.to?.kind ?? relation.targetKind;
      const mapping = relation.type === 'maps-to-table' || (parent.kind === 'entity' && targetKind === 'table') || (parent.kind === 'table' && targetKind === 'entity');
      if (view === 'relations' && (mapping || (targetKind && targetKind !== 'entity'))) continue;
      if (view === 'model-mappings' && !mapping) continue;
      rows.push(childRow(parent, relation, 'relations', index)); found = true;
    }
    const type = parent.recordType;
    const standalone = (view === 'processes' && type === 'process') || (view === 'definitions' && ['entity', 'dictionary', 'rule'].includes(parent.kind))
      || (view === 'acceptance' && type === 'acceptance') || (view === 'test-cases' && type === 'test-case')
      || (view === 'test-executions' && type === 'test-execution') || (view === 'issues' && type === 'issue')
      || (view === 'feature-delivery' && parent.kind === 'function');
    if (!found && standalone) {
      const row = { ...deliverySummary(parent), ...details, parentRef: recordRef(parent), localId: null };
      rows.push(view === 'feature-delivery' ? deliverySummary(row) : row);
    }
    if (!found) {
      const observation = permissionSourceSummary(view, parent, details) ?? legacyImplementationObservation(view, parent, details);
      if (observation) rows.push(observation);
    }
  }
  if (view === 'permission-matrix') return rows.map(row => ({ ...row,
    subject: row.subject ?? row.role ?? null, operation: row.operation ?? row.action ?? null,
    resource: row.resource ?? row.target ?? null, dataScope: row.dataScope ?? null,
    cells: [{ decision: row.decision ?? row.effect ?? null, conditions: row.conditions ?? null,
      ruleRef: { ...row.parentRef, localId: row.localId } }] }));
  return rows;
}
export function paginateView(items, filters = {}) {
  let selected = items.filter(item => semanticMatch(item, filters));
  if (filters.q) { const needle = filters.q.normalize('NFC').toLocaleLowerCase(); selected = selected.filter(item => JSON.stringify(item).normalize('NFC').toLocaleLowerCase().includes(needle)); }
  const page = filters.page ?? 1; const pageSize = filters.pageSize ?? 50;
  return { items: selected.slice((page - 1) * pageSize, page * pageSize), total: selected.length, page, pageSize };
}
/** One explicitly recorded applicability per row, never menu x function guessing. */
export function requirementMatrix(requirements, functions = [], menus = [], referencedVersions = functions) {
  const functionMap = new Map();
  for (const fn of referencedVersions) {
    const key = JSON.stringify([fn.id, String(fn.revision)]);
    if (!functionMap.has(key)) functionMap.set(key, []);
    if (!functionMap.get(key).some(item => item.versionId === fn.versionId)) functionMap.get(key).push(fn);
  }
  const menuMap = new Map(menus.map(item => [item.id, item]));
  const menuPaths = item => {
    const ids = [...new Set([item.menuId, ...array(item.menuIds)].filter(Boolean))];
    const sourcePaths = (array(item.menuPaths).length ? item.menuPaths : array(item.menuPath).length ? [item.menuPath] : [])
      .filter(parts => Array.isArray(parts) && parts.length && parts.every(part => typeof part === 'string' && part));
    const recorded = ids.map(id => menuMap.get(id)?.path);
    const directoryComplete = ids.length > 0 && recorded.every(parts => Array.isArray(parts) && parts.length);
    // The caller supplies only the selected scope's directory. Do not infer a
    // parent from a leaf label or borrow today's directory for historical rows.
    const paths = directoryComplete ? recorded : sourcePaths;
    const hierarchy = directoryComplete ? paths : paths.filter(parts => parts.length > 1);
    return { menuId: ids.length === 1 ? ids[0] : null, menuIds: ids,
      menuPath: paths.length === 1 ? paths[0] : [], menuPaths: paths, menuHierarchyPaths: hierarchy,
      sourceMenuPaths: sourcePaths, menuPathBinding: directoryComplete ? 'scope-directory' : paths.length ? 'source-path' : 'unknown',
      menuHierarchyUnconfirmed: hierarchy.length !== paths.length || !paths.length };
  };
  const requirementName = item => {
    if (typeof item.name === 'string' && item.name.trim() && item.name !== item.id && item.name !== item.assetId) return item.name;
    const body = [item.statement, item.details?.statement, item.description].find(value => typeof value === 'string' && value.trim());
    if (!body) return null;
    const excerpt = body.replace(/\s+/gu, ' ').trim();
    return excerpt.length > 110 ? `${excerpt.slice(0, 110)}…` : excerpt;
  };
  const used = new Set(); const rows = [];
  for (const requirement of requirements) {
    if (requirementType(requirement) !== 'requirement') continue;
    const refs = array(requirement.functionRefs);
    const bindings = refs.length ? refs : [null];
    for (const ref of bindings) {
      const candidates = ref?.revision != null ? functionMap.get(JSON.stringify([ref.id, String(ref.revision)])) ?? [] : [];
      const fn = candidates.length === 1 ? candidates[0] : null;
      if (fn) used.add(fn.id);
      const menu = menuPaths(requirement); const menuId = menu.menuId;
      const name = requirementName(requirement);
      rows.push({ id: `${requirement.id}:${requirement.revision ?? 'unknown'}:${ref?.id ?? 'unbound'}:${ref?.revision ?? 'unknown'}`, rowType: fn && menuId ? 'complete' : ref ? 'partial' : 'unbound',
        name, requirementRef: { ...recordRef(requirement, 'requirement'), name }, requirementName: name,
        functionRef: ref, functionName: fn?.name ?? null, ...menu,
        description: requirement.description ?? null, adoption: requirement.adoption ?? null, status: requirement.status ?? null,
        requirementType: requirement.requirementType ?? requirement.details?.requirementType ?? null,
        conditions: requirement.conditions ?? requirement.applicableConditions ?? requirement.details?.conditions ?? null,
        batchIds: requirement.batchIds ?? [], nature: recordNature(requirement),
        implementation: requirement.implementation ?? requirement.details?.implementation ?? null,
        implementationEvidence: requirement.implementationEvidence ?? requirement.details?.implementationEvidence ?? null,
        verification: requirement.verification ?? requirement.details?.verification ?? null,
        verificationEvidence: requirement.verificationEvidence ?? requirement.details?.verificationEvidence ?? null,
        publication: requirement.publication ?? requirement.details?.publication ?? null,
        publicationEvidence: requirement.publicationEvidence ?? requirement.details?.publicationEvidence ?? null,
        fields: requirement.fields ?? null, actions: requirement.actions ?? null, rules: requirement.rules ?? null,
        permissions: requirement.permissions ?? null, acceptanceCriteria: requirement.acceptanceCriteria ?? null,
        details: requirement.details ?? null,
        parentRef: recordRef(requirement, 'requirement'), revision: requirement.revision ?? null, sources: requirement.sources ?? [],
        bindingStatus: ref && !fn ? 'target-revision-unresolved' : menuId ? 'recorded' : 'menu-binding-unresolved' });
    }
  }
  for (const fn of functions) if (!used.has(fn.id)) rows.push({ id: `function:${fn.id}`, rowType: 'function-only', name: fn.name,
    functionRef: recordRef(fn), functionName: fn.name, requirementRef: null, requirementName: null,
    ...menuPaths(fn), parentRef: recordRef(fn), revision: fn.revision, sources: fn.sources ?? [] });
  return rows.map(row => ({ ...row, missingEvidence: [
    !row.requirementRef && '需求关联未收录', !row.functionRef && '功能关联未收录',
    !row.menuIds?.length && '菜单适用关系未明确',
    row.menuHierarchyUnconfirmed && '完整菜单层级未确认，原路径按已收录内容保留',
    row.requirementRef && !row.requirementType && '要求类型未明确',
    row.requirementRef && row.conditions == null && '适用条件未记录',
    row.requirementRef && !row.adoption && '采用依据未收录',
    !row.sources?.length && '来源定位未收录',
    !row.implementation && !row.implementationEvidence && '实现依据未收录',
    !row.verification && !row.verificationEvidence && '验证依据未收录',
    !row.publication && !row.publicationEvidence && '发布依据未收录',
  ].filter(Boolean) }));
}
export function matrixIdentityCounts(rows) {
  return { relationRows: rows.length, requirementIdentities: new Set(rows.map(row => row.requirementRef?.id).filter(Boolean)).size,
    functionIdentities: new Set(rows.map(row => row.functionRef?.id).filter(Boolean)).size };
}
