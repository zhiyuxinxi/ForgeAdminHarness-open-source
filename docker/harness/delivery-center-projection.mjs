import crypto from 'node:crypto';
import path from 'node:path';
import { lstat, readdir, realpath, open } from 'node:fs/promises';
import { sanitizeDeliveryDetail, projectDeliveryStageAssets, mergeDeliveryHistoryPackets } from './delivery-center-asset-projection.mjs';
import { deliveryCenterMetadata, projectDeliverySemanticRecords } from './delivery-center-semantics.mjs';
import { collectCommittedDeliveryDocuments } from './delivery-center-document-source.mjs';
import { collectCheckpointDeliveryDocuments } from './delivery-center-checkpoint-source.mjs';

// This is a read model. It never writes Controller state, business artifacts or
// acceptance receipts, and does not read chat history or original requests.
export const DELIVERY_PHASES = Object.freeze([
  ['requirements', 'requirements-contract', '需求'],
  ['domain-contract', 'domain-api-contract', '领域与 API 合同'],
  ['database', 'database-implementation', '数据库'],
  ['ui-design', 'ui-interaction-contract', 'UI 设计'],
  ['backend', 'backend-implementation', '后端'],
  ['frontend', 'frontend-implementation', '前端'],
  ['access-wiring', 'access-wiring-implementation', '权限接线'],
  ['cross-layer-acceptance', 'cross-layer-acceptance', '跨层验收'],
]);
const PHASE_BY_KIND = new Map(DELIVERY_PHASES.map(row => [row[1], row]));
const PHASE_BY_ID = new Map(DELIVERY_PHASES.map(row => [row[0], row]));
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u;
const PROJECT_SLUG = /^[a-z][a-z0-9-]{2,31}$/u;
const TASK = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const REPAIRS = new Map([
  ['access-wiring-repair', '权限接线阶段-关联修复凭据.json'],
  ['runtime-access-repair', '权限接线阶段-运行修复凭据.json'],
  ['frontend-repair', '前端阶段-关联修复凭据.json'],
]);
const LIMITS = { jsonBytes: 8 * 1024 * 1024, auditBytes: 64 * 1024 * 1024,
  totalBytes: 192 * 1024 * 1024, tasks: 2000, artifacts: 128, depth: 6, nodes: 30000 };
const PRIVATE_KEY = /(?:password|passwd|secret|token|credential|authorization|cookie|privatekey|approvalref|rollbackenv|connectionstring|privatechat|rawchat)/iu;
const PRIVATE_VALUE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+|\bBearer\s+[A-Za-z0-9_.-]{8,}|\bsk-[a-zA-Z0-9_-]{12,}|\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@)/iu;
const TOPICS = new Set(['actors', 'useCases', 'businessRules', 'acceptanceCriteria', 'nonGoals', 'dataOwnership',
  'permissionMatrix', 'requirementTrace', 'businessEntities', 'commands', 'queries', 'apiContracts', 'permissionCodes',
  'dictionaries', 'validationRules', 'concurrencyRules', 'migrationVersion', 'tables', 'indexes',
  'tenantAuditDeleteContract', 'dictionaryExcelSeed', 'migrationTest', 'pageMode', 'canonicalOwners', 'fields',
  'actions', 'states', 'responsiveRules', 'accessibilityRules', 'apiBindings', 'permissionBindings', 'redTests',
  'apiImplementation', 'persistenceOutcomeHandling', 'permissionEnforcement', 'canonicalComponentOwners',
  'apiAdapter', 'pageImplementation', 'longIdContract', 'interactionStates', 'menuSeed', 'buttonSeed',
  'apiResourceSeed', 'roleVisibilityContract', 'permissionCoherence', 'requirementCoverage',
  'tenantAuditDeleteEvidence', 'apiUiCoherence', 'longIdEvidence', 'testEvidence', 'runtimeEvidenceDigest',
  'semanticReview', 'cannotClaim', 'requirements', 'features', 'menus', 'pages', 'requirementMatrix', 'productionOwners', 'changedPaths']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(canonical(value))).digest('hex');
export const deliverySnapshotDigest = digest;
const entityId = (kind, ...parts) => `${kind}-${digest(parts).slice(0, 32)}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
function projectionLimit() { const error = new Error('DELIVERY_PROJECTION_LIMIT'); error.code = 'PROJECTION_LIMIT'; throw error; }
function text(value, maximum = Infinity) {
  if (typeof value !== 'string') return '';
  const clean = value.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').trim();
  if (clean.length > maximum) projectionLimit();
  return PRIVATE_VALUE.test(clean) ? '[敏感内容已隐藏]' : clean;
}
function first(value, keys) {
  for (const key of keys) if (typeof value?.[key] === 'string' && text(value[key])) return text(value[key]);
  return '';
}
function safeDetail(value, depth = 0) {
  return sanitizeDeliveryDetail(value, depth);
}
function list(value, dynamicFields = false) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(item => safeDetail(item, 0, dynamicFields)).filter(item => item !== null);
  if (object(value)) return Object.entries(value).filter(([key]) => !PRIVATE_KEY.test(key))
    .map(([key, item]) => Array.isArray(item) ? { name: text(key), items: safeDetail(item, 0, dynamicFields) }
      : object(item) ? { name: text(key), ...safeDetail(item, 0, dynamicFields) } : { name: text(key), description: text(item) })
    .filter(item => item.description || Object.keys(item).length > 1);
  return text(value) ? [text(value)] : [];
}
function pathParts(value) {
  if (Array.isArray(value)) return value.map(item => text(item, 160)).filter(Boolean);
  if (typeof value === 'string') return value.split(/\s*(?:→|>|\/|\\|｜|\|)\s*/u).map(item => text(item, 160)).filter(Boolean);
  return [];
}
function menuPath(row, inherited = []) {
  const explicit = pathParts(row.menuPath ?? row['菜单路径']);
  if (explicit.length) return explicit;
  const levels = ['一级菜单', '二级菜单', '三级菜单'].map(key => first(row, [key])).filter(Boolean);
  if (levels.length) return levels;
  if (Array.isArray(row.menu)) return pathParts(row.menu);
  if (typeof row.menu === 'string' && !row.menu.includes(':')) return pathParts(row.menu);
  return inherited;
}

function markdownRows(markdown) {
  if (typeof markdown !== 'string') return [];
  const lines = markdown.split(/\r?\n/u); const rows = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const split = line => line.trim().replace(/^\||\|$/gu, '').split(/(?<!\\)\|/u).map(cell => cell.trim().replace(/\\\|/gu, '|'));
    const header = split(lines[index]); const separator = split(lines[index + 1]);
    if (!header.some(cell => /^(?:一级菜单|二级菜单|三级菜单|菜单路径|功能点|功能名称|menuPath|feature|functionName)$/u.test(cell))
      || separator.length !== header.length || !separator.every(cell => /^:?-{3,}:?$/u.test(cell))) continue;
    for (index += 2; index < lines.length && lines[index].includes('|'); index += 1) {
      const cells = split(lines[index]);
      if (cells.length === header.length) rows.push(Object.fromEntries(header.map((key, column) => [key, cells[column]])));
    }
    index -= 1;
  }
  return rows;
}

function extractRequirements(payload) {
  const rows = []; let visited = 0;
  const walk = (value, context = {}, depth = 0) => {
    if (++visited > LIMITS.nodes || depth > 64) projectionLimit();
    if (typeof value === 'string') { for (const row of markdownRows(value)) walk(row, context, depth + 1); return; }
    if (Array.isArray(value)) { for (const row of value) walk(row, context, depth + 1); return; }
    if (!object(value)) return;
    // Both [{id, name, ...}] and {REQ_1: {name, ...}} are used in retained
    // documents. Only named requirement/menu collections admit keyed rows;
    // requirementTrace metadata must not become invented business functions.
    if (['requirements', 'features', 'useCases', 'menus', 'pages', 'requirementMatrix'].includes(context.topic)
      && !first(value, ['name', 'label', 'title', 'resourceName', 'functionName', 'feature', 'function', '功能点', '功能名称', 'requirement'])) {
      for (const [key, child] of Object.entries(value)) {
        if (PRIVATE_KEY.test(key) || !object(child)) continue;
        walk({ id: text(key, 160), ...child }, context, depth + 1);
      }
      return;
    }
    const ownPath = menuPath(value, context.menuPath ?? []);
    const kind = first(value, ['kind', 'type', 'resourceType']).toLowerCase();
    const nodeName = first(value, ['resourceName', 'name', 'label', 'title']);
    const isMenu = context.topic === 'menus' || kind === 'menu' || kind === 'directory';
    const nextPath = isMenu && nodeName ? [...ownPath, ...(ownPath.at(-1) === nodeName ? [] : [nodeName])] : ownPath;
    const page = first(value, ['page', 'pageName', '页面', '页面名称']) || context.page || '';
    const name = first(value, ['functionName', 'feature', 'function', '功能点', '功能名称'])
      || (!isMenu && ['requirements', 'features', 'useCases', 'requirementTrace', 'requirementMatrix', 'pages', 'pageImplementation'].includes(context.topic)
        ? first(value, ['name', 'title', 'label', 'requirement']) : '');
    if (name && !deliveryCenterMetadata(value)) rows.push({
      key: first(value, ['requirementId', 'featureId', '功能编号', 'id', 'key']), menuPath: nextPath, page,
      name, description: [first(value, ['description', 'requirement', 'outcome', 'businessOutcome', 'businessResult', 'summary', '需求说明', '说明']),
        first(value, ['trigger']) ? `触发条件：${text(value.trigger)}` : '', first(value, ['mainFlow']) ? `主要流程：${text(value.mainFlow)}` : ''].filter(Boolean).join('\n'),
      fields: list(value.fields ?? value['字段'], true), actions: list(value.actions ?? value.buttons ?? value['操作']),
      rules: list(value.rules ?? value.businessRules ?? value['业务规则']), permissions: list(value.permissions ?? value.permission ?? value['权限']),
      recordType: first(value, ['recordType']) || (context.topic === 'requirements' ? 'requirement' : 'unknown'),
      nature: first(value, ['nature']) || 'unknown',
    });
    for (const [key, child] of Object.entries(value)) {
      if (PRIVATE_KEY.test(key)) continue;
      if (['menus', 'pages', 'children', 'items', 'requirements', 'features', 'useCases', 'requirementTrace', 'requirementMatrix'].includes(key)) {
        walk(child, { menuPath: nextPath, page: context.topic === 'pages' ? nodeName || page : page,
          topic: ['children', 'items'].includes(key) ? context.topic : key }, depth + 1);
      } else if (typeof child === 'string' && TOPICS.has(key)) walk(child, { menuPath: nextPath, page, topic: key }, depth + 1);
    }
  };
  walk(payload);
  return rows;
}

function menuSeeds(payload) {
  const sources = [payload.menuSeed, payload.menus].filter(value => value !== undefined);
  const result = [];
  const nodes = new Map(); let visited = 0;
  const identity = value => first(value, ['id', 'resourceId', 'menuId', 'key']);
  const nodeName = value => first(value, ['resourceName', 'name', 'label', 'title']);
  const children = value => {
    if (nodeName(value)) return ['children', 'menus', 'items', 'pages'].flatMap(key => value[key] ? [value[key]] : []);
    return Object.entries(value).filter(([key, child]) => !PRIVATE_KEY.test(key) && (Array.isArray(child) || object(child)))
      .map(([, child]) => child);
  };
  const index = (value, depth = 0) => {
    if (++visited > LIMITS.nodes || depth > 64) projectionLimit();
    if (Array.isArray(value)) { value.forEach(item => index(item, depth + 1)); return; }
    if (!object(value)) return;
    if (identity(value) && nodeName(value)) nodes.set(identity(value), value);
    children(value).forEach(child => index(child, depth + 1));
  };
  sources.forEach(value => index(value));
  const resolve = (value, inherited = [], seen = new Set()) => {
    if (seen.has(value)) return [];
    const nextSeen = new Set(seen); nextSeen.add(value);
    const explicit = menuPath(value); if (explicit.length) return explicit;
    const chain = pathParts(value.parentChain ?? value.parent?.parentChain ?? value.parentResource?.parentChain ?? value.parentMenu?.parentChain);
    const parentId = first(value, ['parentId']); const parentNode = nodes.get(parentId);
    const parent = chain.length ? chain : parentNode ? resolve(parentNode, [], nextSeen)
      : inherited.length ? inherited : object(value.parent) ? [nodeName(value.parent)].filter(Boolean) : [];
    const name = nodeName(value);
    return [...parent, ...(name ? [name] : [])];
  };
  const walk = (value, inherited = [], depth = 0) => {
    if (++visited > LIMITS.nodes || depth > 64) projectionLimit();
    if (Array.isArray(value)) { value.forEach(item => walk(item, inherited)); return; }
    if (!object(value)) return;
    const name = nodeName(value);
    // A route is not a human menu hierarchy; opaque parent IDs are not names.
    const parts = resolve(value, inherited);
    if (parts.length && !deliveryCenterMetadata(value)) result.push({ path: parts, route: first(value, ['route', 'path']), name });
    const childParent = !name && object(value.directory) ? resolve(value.directory, inherited) : parts;
    for (const child of children(value)) walk(child, child === value.directory ? inherited : childParent, depth + 1);
  };
  sources.forEach(value => walk(value));
  const mode = payload.pageMode;
  if (object(mode) && first(mode, ['pageName', 'name', 'resourceName'])) {
    const parent = pathParts(mode.parentMenu?.parentChain ?? mode.parentChain);
    if (parent.length) result.push({ path: [...parent, first(mode, ['pageName', 'name', 'resourceName'])], route: first(mode, ['route', 'path']), name: first(mode, ['pageName', 'name', 'resourceName']) });
  }
  const entry = payload.pageMode?.entry;
  const group = pathParts(entry?.group);
  if (group.length) {
    result.push({ path: group, route: '', name: group.at(-1) });
    for (const page of Array.isArray(entry.pages) ? entry.pages : []) {
      const name = typeof page === 'string' ? text(page, 160) : first(page, ['name', 'pageName', 'resourceName']);
      if (name) result.push({ path: [...group, name], route: object(page) ? first(page, ['route', 'path']) : '', name });
    }
  }
  return result;
}

function acceptedPageBinding(requirementsPayload, uiPayload) {
  const businessPage = requirementsPayload?.permissionMatrix?.businessPage;
  const mode = uiPayload?.pageMode;
  if (!object(businessPage) || !object(mode)) return null;
  const route = first(mode, ['route']);
  const page = first(businessPage, ['pageName', 'name']);
  if (!route || route !== first(businessPage, ['route']) || !page || (Array.isArray(mode.entry?.pages) && mode.entry.pages.length > 1)) return null;
  const uiParent = pathParts(mode.parentMenu?.parentChain);
  const requirementParent = pathParts(businessPage.parentResource?.parentChain);
  if (uiParent.length && requirementParent.length && JSON.stringify(uiParent) !== JSON.stringify(requirementParent)) return null;
  const parent = uiParent.length ? uiParent : requirementParent;
  if (!parent.length) return null;
  return { path: [...parent, page], route, name: page };
}

function validDigest(value, key) {
  if (!object(value) || !SHA.test(value[key] ?? '')) return false;
  const { [key]: ignored, ...rest } = value;
  return value[key] === digest(rest);
}

function newSnapshot(projectSlug, projectName, observedAt) {
  if (!PROJECT_SLUG.test(projectSlug ?? '') || !date(observedAt)) throw new Error('DELIVERY_SOURCE_ARGUMENT_INVALID');
  return { schemaVersion: 1, project: { slug: projectSlug, name: text(projectName, 160) || projectSlug }, observedAt: date(observedAt),
    batches: [], menus: [], requirements: [], stages: [], releases: [], artifacts: [],
    coverage: { source: 'harness-phase-artifacts-and-release-audit', availability: 'ready', tasks: 0,
      acceptedStages: 0, unmappedRequirements: 0, conflicts: 0, unboundReleases: 0, gaps: [] } };
}

function projectDocumentedReleaseChanges(snapshot) {
  const releases = new Map(snapshot.releases.map(release => [release.id, release]));
  const menuNames = new Map();
  for (const menu of snapshot.menus) for (const version of menu.variants ?? [menu]) {
    if (!version.revision) continue;
    const key = JSON.stringify([version.id, version.revision]);
    if (!menuNames.has(key)) menuNames.set(key, new Set());
    if (version.name) menuNames.get(key).add(version.name);
  }
  const seen = new Map();
  for (const record of snapshot.requirementVersions ?? []) {
    if (record.kind !== 'requirement' || record.recordType !== 'release-change'
      || !['historical-compilation', 'implementation-observation'].includes(record.nature)) continue;
    const origin = record.sources?.[0];
    if (origin?.kind !== 'committed-document' || !COMMIT.test(record.sourceRevision ?? '')
      || origin.commit !== record.sourceRevision) continue;
    const matches = new Map();
    for (const relation of record.relations ?? []) {
      const release = releases.get(relation.to?.id);
      // An unversioned self-reference belongs to this exact recorded body;
      // it never selects a latest revision or relaxes another target binding.
      const fromRevision = relation.from?.revision ?? record.revision;
      if (relation.type !== 'describes-release-change' || relation.to?.kind !== 'release'
        || relation.from?.kind !== record.kind || relation.from?.id !== record.id || fromRevision !== record.revision
        || !release || !COMMIT.test(release.commit ?? '') || relation.to.revision !== release.commit
        || !(relation.sources ?? []).some(source => (source.kind === 'git' || source.type === 'git')
          && source.commit === release.commit)) continue;
      if (!matches.has(release.id)) matches.set(release.id, []);
      matches.get(release.id).push(...relation.sources);
    }
    for (const [releaseId, relationSources] of matches) {
      const release = releases.get(releaseId);
      const sources = [...new Map([...record.sources, ...relationSources].map(source => [digest(source), source])).values()];
      const change = { id: record.id, revision: record.revision, status: 'documented', name: record.name,
        description: record.description, changeType: text(record.details?.changeType),
        before: safeDetail(record.details?.before) ?? null, after: safeDetail(record.details?.after) ?? null,
        menuRefs: record.menuRefs ?? [], menuNames: [...new Set((record.menuRefs ?? []).flatMap(ref =>
          [...(menuNames.get(JSON.stringify([ref.id, ref.revision])) ?? [])]))], sources,
        provenance: { recordRef: { kind: record.kind, id: record.id, revision: record.revision }, nature: record.nature,
          sourceCommit: record.sourceRevision, sourceScope: record.sourceScope ?? 'source-commit', sourcePath: origin.sourcePath } };
      const key = digest(change);
      if (!seen.has(releaseId)) seen.set(releaseId, new Set());
      if (seen.get(releaseId).has(key)) continue;
      seen.get(releaseId).add(key);
      release.documentedChanges.push(change);
      if (release.documentedChanges.length > 10000) projectionLimit();
    }
  }
  for (const release of snapshot.releases) {
    release.documentedChanges.sort((a, b) => a.id.localeCompare(b.id) || a.revision.localeCompare(b.revision)
      || a.provenance.sourceCommit.localeCompare(b.provenance.sourceCommit));
    release.documentedChangeCount = release.documentedChanges.length;
    release.documentedChangePreview = release.documentedChanges.slice(0, 3)
      .map(({ id, revision, name }) => ({ id, revision, name: name.slice(0, 96) }));
  }
}

// Pure projection is exported to keep data interpretation independently testable.
function projectSnapshot({ projectSlug, projectName, records = [], releases = [], brokerAudits = [], historyPackets = [],
  documents = [], documentCoverage, checkpointDocuments = null, observedAt = new Date().toISOString(), gaps = [] }) {
  const result = newSnapshot(projectSlug, projectName, observedAt);
  result.coverage.gaps.push(...gaps);
  const menus = new Map(); const requirements = new Map(); const stages = new Map(); const artifacts = new Map();
  const taskRecords = new Map();
  const addMenu = parts => {
    let parentId = null;
    for (let index = 0; index < parts.length; index += 1) {
      const branch = parts.slice(0, index + 1); const id = entityId('menu', projectSlug, branch);
      if (!menus.has(id)) menus.set(id, { id, parentId, name: branch.at(-1), path: branch });
      parentId = id;
    }
    return parentId;
  };
  for (const record of records) {
    const state = record.state;
    if (!TASK.test(state?.taskId ?? '') || !['forge-delivery-phase-state/v1', 'forge-delivery-phase-state/v2'].includes(state.schemaVersion)
      || !validDigest(state, 'stateDigest')) {
      result.coverage.gaps.push({ code: 'STATE_DIGEST_INVALID', label: '阶段状态摘要不匹配，未导入其当前结果' }); continue;
    }
    if (!taskRecords.has(state.taskId)) taskRecords.set(state.taskId, []);
    taskRecords.get(state.taskId).push(record);
  }
  for (const [taskId, candidates] of taskRecords) {
    const selected = candidates.filter(item => item.isCurrent !== false).sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0))[0];
    const current = selected?.state; const batchId = entityId('batch', projectSlug, taskId);
    result.batches.push({ id: batchId, taskId, name: `需求批次 ${taskId}`, status: current?.status ?? 'unknown',
      createdAt: date(candidates[0].state.createdAt), updatedAt: date(current?.updatedAt),
      sessionId: text(current?.sessionId, 160) || null, sourceCommit: COMMIT.test(current?.sourceCommit ?? '') ? current.sourceCommit : null,
      stateDigest: current?.stateDigest ?? null, acceptedArtifactDigests: { ...(current?.acceptedArtifacts ?? {}) } });
    const acceptedByKind = new Map();
    for (const candidate of candidates) {
      for (const artifact of candidate.artifacts ?? []) {
        const phase = PHASE_BY_KIND.get(artifact.artifactKind);
        if (!phase || artifact.schemaVersion !== 'forge-delivery-phase-artifact/v1'
          || artifact.workflowId !== candidate.state.workflowId || artifact.phaseId !== phase[0]
          || !validDigest(artifact, 'artifactDigest') || !object(artifact.payload)) {
          result.coverage.gaps.push({ code: 'ARTIFACT_INVALID', batchId, label: '产物结构或摘要不匹配，未导入' }); continue;
        }
        const accepted = candidate === selected && current?.acceptedArtifacts?.[artifact.artifactKind] === artifact.artifactDigest;
        const history = (candidate.state.history ?? []).filter(item => item.artifactDigest === artifact.artifactDigest);
        const receipt = history.findLast(item => item.decision === 'accepted') ?? history.at(-1);
        const status = accepted ? 'accepted' : receipt?.decision === 'accepted' ? 'historical'
          : ['rejected', 'blocked'].includes(receipt?.decision) ? receipt.decision : 'draft';
        const id = entityId('stage', projectSlug, taskId, phase[0], artifact.artifactDigest);
        const stage = { id, batchId, phaseId: phase[0], name: phase[2], status, digest: artifact.artifactDigest,
          summary: `${phase[2]}${accepted ? '已接受' : status === 'historical' ? '历史结果' : status === 'draft' ? '待确认' : '未通过'}`,
          details: Object.fromEntries(Object.entries(artifact.payload).filter(([key]) => TOPICS.has(key)).map(([key, value]) => [key, safeDetail(value, 0, key === 'fields')])),
          createdAt: date(receipt?.completedAt), isCurrent: accepted, sourceFingerprint: SHA.test(artifact.sourceFingerprint ?? '') ? artifact.sourceFingerprint : null };
        const previous = stages.get(id);
        if (!previous?.isCurrent || accepted) stages.set(id, stage);
        if (accepted) acceptedByKind.set(artifact.artifactKind, { artifact, stage });
      }
    }
    for (const [phaseId, kind, name] of DELIVERY_PHASES) {
      if (acceptedByKind.has(kind)) continue;
      const active = current?.currentPhaseId === phaseId;
      const latest = (current?.history ?? []).filter(item => item.phaseId === phaseId).at(-1);
      const status = active ? current.activeAttempt ? 'in-progress' : current.status === 'blocked' ? 'blocked'
        : latest?.decision === 'rejected' ? 'rejected' : 'pending' : 'not-recorded';
      const id = entityId('stage', projectSlug, taskId, phaseId, current?.stateDigest ?? 'unknown');
      stages.set(id, { id, batchId, phaseId, name, status, digest: null, summary: `${name}：${status === 'not-recorded' ? '暂无结果记录' : '尚未接受'}`,
        details: {}, createdAt: date(latest?.completedAt), isCurrent: true });
      if (current?.acceptedArtifacts?.[kind]) result.coverage.gaps.push({ code: 'ACCEPTED_ARTIFACT_UNAVAILABLE', batchId, phaseId, label: '当前接受摘要对应的产物不可用' });
    }
    const ui = acceptedByKind.get('ui-interaction-contract');
    const requirementsArtifact = acceptedByKind.get('requirements-contract');
    const pageBinding = acceptedPageBinding(requirementsArtifact?.artifact.payload, ui?.artifact.payload);
    const seeds = [...acceptedByKind.values()].flatMap(({ artifact }) => menuSeeds(artifact.payload));
    if (pageBinding) seeds.push(pageBinding);
    for (const seed of seeds) addMenu(seed.path);
    const uniquePaths = [...new Map(seeds.map(seed => [JSON.stringify(seed.path), seed.path])).values()];
    const uiEntry = ui?.artifact.payload.pageMode?.entry;
    const groupPath = pathParts(uiEntry?.group);
    const entryPageNames = (Array.isArray(uiEntry?.pages) ? uiEntry.pages : []).map(page => typeof page === 'string' ? text(page) : first(page, ['name', 'pageName', 'resourceName'])).filter(Boolean);
    const explicitRows = [...acceptedByKind.values()].flatMap(({ artifact, stage }) => extractRequirements(artifact.payload).map(row => ({ ...row, stage })));
    // A single explicit page/route can bind its UI fields. Multi-page payloads
    // retain their stage details until an explicit page link is available.
    if (explicitRows.length === 0 && uniquePaths.length === 1) {
      const source = requirementsArtifact ?? ui ?? acceptedByKind.get('access-wiring-implementation');
      if (source) explicitRows.push({ key: '', menuPath: uniquePaths[0], page: uniquePaths[0].at(-1), name: uniquePaths[0].at(-1),
         description: '', fields: [], actions: [], rules: [], permissions: [], recordType: 'unknown', nature: 'unknown', stage: source.stage });
    }
    for (const row of explicitRows) {
      if (!row.menuPath.length && pageBinding && (!row.page || row.page === pageBinding.name)) {
        row.menuPath = [...pageBinding.path]; row.page = row.page || pageBinding.name;
      } else if (!row.menuPath.length && groupPath.length) {
        // The accepted group is explicit, but page order and page-key spelling
        // do not prove which page implements a particular use case.
        row.menuPath = row.page && entryPageNames.includes(row.page) ? [...groupPath, row.page] : [...groupPath];
      }
      const parts = row.menuPath; const menuId = parts.length ? addMenu(parts) : addMenu(['未分类需求']);
      const id = entityId('requirement', projectSlug, parts, row.page, row.key || row.name);
      const source = { batchId, stageId: row.stage.id, digest: row.stage.digest, label: `${taskId} · ${row.stage.name}` };
      const singlePage = (pageBinding && JSON.stringify(pageBinding.path) === JSON.stringify(parts)
        && (!row.page || row.page === pageBinding.name)) || (uniquePaths.length === 1 && JSON.stringify(uniquePaths[0]) === JSON.stringify(parts));
      const mappedUi = ui && (singlePage || (row.page && [ui.artifact.payload.pageName, ui.artifact.payload.page].includes(row.page)));
      const proposed = { name: text(row.name, 512), description: row.description,
        fields: row.fields.length ? row.fields : mappedUi ? list(ui.artifact.payload.fields, true) : [],
        actions: row.actions.length ? row.actions : mappedUi ? list(ui.artifact.payload.actions) : [],
        rules: row.rules, permissions: row.permissions.length ? row.permissions : mappedUi ? list(ui.artifact.payload.permissionBindings) : [] };
      if (!requirements.has(id)) requirements.set(id, { id, menuId, menuPath: parts.length ? parts : ['未分类需求'], page: text(row.page, 512) || null,
        ...proposed, recordType: row.recordType ?? 'unknown', nature: row.nature ?? 'unknown',
        batchIds: [], stageStatus: {}, status: 'documented', sources: [], revision: '', variants: [] });
      const item = requirements.get(id);
      if (!item.batchIds.includes(batchId)) item.batchIds.push(batchId);
      if (!item.sources.some(existing => existing.stageId === source.stageId)) item.sources.push(source);
      item.stageStatus[row.stage.phaseId] = 'accepted';
      if (mappedUi) {
        item.stageStatus['ui-design'] = 'accepted';
        if (!item.sources.some(existing => existing.stageId === ui.stage.id)) item.sources.push({ batchId, stageId: ui.stage.id, digest: ui.stage.digest, label: `${taskId} · UI 设计` });
      }
      // A task acceptance or release does not prove that every feature in the
      // task is implemented. Only the directly mapped source phase is marked.
      const variant = { ...proposed, batchId, stageId: source.stageId };
      if (!item.variants.some(existing => digest(existing) === digest(variant))) item.variants.push(variant);
      item.revision = digest(item.variants);
    }
  }
  result.menus = [...menus.values()]; result.requirements = [...requirements.values()]; result.stages = [...stages.values()];
  const releaseMap = new Map();
  for (const record of releases) {
    if (record.type !== 'controlled-release' || !['success', 'failed', 'interrupted'].includes(record.status)
      || !ID.test(record.jobId ?? '') || (record.projectSlug && record.projectSlug !== projectSlug)) continue;
    const id = entityId('release', projectSlug, record.jobId);
    const release = { id, version: ID.test(record.version ?? '') ? record.version : null,
      commit: COMMIT.test(record.commit ?? '') ? record.commit : null, environment: 'unknown', status: record.status,
      releasedAt: date(record.completedAt), startedAt: date(record.startedAt), jobId: record.jobId,
      taskId: TASK.test(record.provenance?.taskId ?? '') ? record.provenance.taskId : null,
      requirementIds: [], requirementSnapshots: [], artifactIds: [], scopeBinding: 'unknown', scope: 'unknown',
      scopeBindingReason: 'NO_VALIDATED_TASK_SNAPSHOT', scopeBindingEvidence: null, scopeBindingDiagnostic: null,
      documentedChanges: [], documentedChangeCount: 0,
      services: Array.isArray(record.services) ? record.services.filter(service => ['forge-admin', 'forge-ui', 'forge-app', 'forge-flow'].includes(service)) : [] };
    for (const service of release.services) {
      const image = record.images?.[service];
      if (!object(image) || !/^sha256:[a-f0-9]{64}$/u.test(image.id ?? '') || typeof image.image !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,255}$/u.test(image.image)) continue;
      const artifactId = entityId('artifact', projectSlug, record.jobId, service, image.id);
      artifacts.set(artifactId, { id: artifactId, releaseId: id, name: service, type: 'container-image', digest: image.id,
        reference: image.image, commit: release.commit, version: release.version });
      release.artifactIds.push(artifactId);
    }
    // Historical Controller sourceCommit is a base commit, not proof of the
    // released candidate. Only an explicit frozen feature binding is accepted.
    const auditBindings = brokerAudits.filter(audit => audit.type === 'taskspace-release' && audit.status === 'success'
      && audit.projectSlug === projectSlug && audit.runnerJobId === record.jobId && audit.commit === release.commit
      && audit.taskId === release.taskId && audit.deliveryCenterSnapshot !== undefined);
    const uniqueBindings = [...new Map(auditBindings.map(audit => [digest(audit.deliveryCenterSnapshot), audit.deliveryCenterSnapshot])).values()];
    const binding = uniqueBindings.length === 1 ? uniqueBindings[0] : record.deliveryCenterSnapshot;
    if (uniqueBindings.length > 1) result.coverage.gaps.push({ code: 'RELEASE_BINDING_CONFLICT', releaseId: id, label: '发布审计存在相互冲突的功能快照，未绑定功能范围' });
    if (uniqueBindings.length === 1 && object(binding) && binding.schemaVersion === 1 && binding.status === 'unknown'
      && binding.projectSlug === projectSlug && binding.taskId === release.taskId && binding.commit === release.commit
      && COMMIT.test(release.commit ?? '') && validDigest(binding, 'digest') && /^[A-Z][A-Z0-9_]{1,79}$/u.test(binding.reason ?? '')) {
      release.scopeBindingDiagnostic = binding.reason;
    }
    const validBinding = uniqueBindings.length <= 1 && record.status === 'success' && object(binding)
      && binding.schemaVersion === 1 && binding.status === 'bound' && binding.scope === 'validated-task-delivery'
      && binding.projectSlug === projectSlug && binding.taskId === release.taskId && binding.commit === release.commit
      && COMMIT.test(release.commit ?? '') && SHA.test(binding.sourceFingerprint ?? '') && SHA.test(binding.acceptanceGateDigest ?? '')
      && COMMIT.test(binding.baseSourceCommit ?? '') && SHA.test(binding.phasePatchDigest ?? '')
      && SHA.test(binding.stateDigest ?? '') && object(binding.acceptedArtifactDigests)
      && Object.keys(binding.acceptedArtifactDigests).length === DELIVERY_PHASES.length
      && DELIVERY_PHASES.every(([, kind]) => SHA.test(binding.acceptedArtifactDigests[kind] ?? ''))
      && validDigest(binding, 'digest') && Array.isArray(binding.requirements) && binding.requirements.length > 0
      && binding.requirements.every(row => object(row) && ID.test(row.id ?? ''))
      && new Set(binding.requirements.map(row => row.id)).size === binding.requirements.length;
    if (validBinding) {
      if (binding.requirements.length > 10000) projectionLimit();
      release.requirementSnapshots = binding.requirements.map(row => ({
        id: row.id, name: text(row.name), menuPath: pathParts(row.menuPath), page: text(row.page), description: text(row.description),
        fields: list(row.fields, true), actions: list(row.actions), rules: list(row.rules), permissions: list(row.permissions), revision: SHA.test(row.revision ?? '') ? row.revision : null,
      }));
      release.requirementIds = release.requirementSnapshots.map(row => row.id);
      release.scopeBinding = 'frozen-explicit-snapshot';
      release.scope = 'validated-task-delivery';
      release.scopeBindingReason = null;
      release.scopeBindingEvidence = { projectSlug, taskId: release.taskId, commit: release.commit, runnerJobId: release.jobId,
        sourceFingerprint: binding.sourceFingerprint, acceptanceGateDigest: binding.acceptanceGateDigest,
        baseSourceCommit: binding.baseSourceCommit, phasePatchDigest: binding.phasePatchDigest,
        stateDigest: binding.stateDigest, acceptedArtifactDigests: { ...binding.acceptedArtifactDigests },
        snapshotDigest: binding.digest, scope: 'validated-task-delivery' };
    }
    if (releaseMap.has(id) && digest(releaseMap.get(id)) !== digest(release)) {
      result.coverage.gaps.push({ code: 'RELEASE_RECORD_CONFLICT', releaseId: id, label: '同一发布作业有不同终态记录，保留首条并标记冲突' });
    } else releaseMap.set(id, release);
  }
  result.releases = [...releaseMap.values()];
  result.artifacts = [...artifacts.values()].map(artifact => ({ ...artifact,
    releaseIds: result.releases.filter(release => release.artifactIds.includes(artifact.id)).map(release => release.id).sort(),
  }));
  const definitions = documents.map(document => ({ ...document, records: sanitizeDeliveryDetail(document.records) }));
  projectDeliverySemanticRecords(result, definitions);
  result.artifacts.push(...projectDeliveryStageAssets(result, definitions));
  if (documentCoverage) result.coverage.committedDocuments = { ...documentCoverage };
  mergeDeliveryHistoryPackets(result, historyPackets);
  if (checkpointDocuments) {
    result.batches.push(...checkpointDocuments.batches);
    result.coverage.gaps.push(...checkpointDocuments.gaps);
    result.coverage.checkpointDocuments = { ...checkpointDocuments.coverage };
    const local = { ...result, stages: [] };
    const localDefinitions = checkpointDocuments.documents.map(document => ({ ...document,
      sourceScope: 'taskspace-checkpoint', isCurrent: false, records: sanitizeDeliveryDetail(document.records) }));
    projectDeliverySemanticRecords(local, localDefinitions);
    result.menus = local.menus;
    result.requirementVersions = local.requirementVersions;
    result.artifacts.push(...projectDeliveryStageAssets(local, localDefinitions));
  }
  projectDocumentedReleaseChanges(result);
  result.coverage.tasks = result.batches.length;
  result.coverage.acceptedStages = result.stages.filter(stage => stage.isCurrent && stage.status === 'accepted').length;
  result.coverage.unmappedRequirements = result.requirements.filter(item => item.menuPath[0] === '未分类需求'
    || (!item.menuId && item.menuApplicability !== 'none')).length;
  result.coverage.conflicts = result.requirements.filter(item => item.status === 'conflict').length;
  result.coverage.unboundReleases = result.releases.filter(item => item.scopeBinding === 'unknown').length;
  if (result.coverage.gaps.length || result.coverage.unmappedRequirements) result.coverage.availability = 'partial';
  for (const key of ['batches', 'menus', 'requirements', 'stages', 'releases', 'artifacts']) {
    if (result[key].length > 10000) projectionLimit();
    result[key].sort((a, b) => a.id.localeCompare(b.id));
  }
  return result;
}

export function projectDeliverySnapshot(options) {
  try { return projectSnapshot(options); }
  catch (error) {
    if (error.code !== 'PROJECTION_LIMIT') throw error;
    const snapshot = newSnapshot(options.projectSlug, options.projectName, options.observedAt ?? new Date().toISOString());
    snapshot.coverage.availability = 'partial';
    snapshot.coverage.gaps.push({ code: 'PROJECTION_LIMIT', label: '来源超过投影字段、节点或层级上限，未生成可替换完整快照的投影' });
    return snapshot;
  }
}

export async function collectDeliverySnapshot({ projectSlug, projectName, phaseRoot, releaseAuditPath, brokerAuditPath,
  historyPacketPaths = [], committedDocuments, taskIdFilter, observedAt = new Date().toISOString() }) {
  newSnapshot(projectSlug, projectName, observedAt);
  if ((phaseRoot !== null && !path.isAbsolute(phaseRoot ?? ''))
    || (releaseAuditPath !== undefined && releaseAuditPath !== null && !path.isAbsolute(releaseAuditPath))
    || (brokerAuditPath !== undefined && brokerAuditPath !== null && !path.isAbsolute(brokerAuditPath))
    || (taskIdFilter !== undefined && !TASK.test(taskIdFilter))
    || !Array.isArray(historyPacketPaths) || historyPacketPaths.length > 32
    || historyPacketPaths.some(file => typeof file !== 'string' || !path.isAbsolute(file))
    || (committedDocuments !== undefined && (typeof committedDocuments?.repositoryRoot !== 'string'
      || !path.isAbsolute(committedDocuments.repositoryRoot)))) throw new Error('DELIVERY_SOURCE_PATH_INVALID');
  const gaps = []; const records = []; const releases = []; const brokerAudits = []; const historyPackets = [];
  const checkpointAudits = []; let total = 0;
  const gap = (code, label, taskId) => { if (gaps.length < 1000) gaps.push({ code, label, ...(taskId ? { taskId } : {}) }); };
  const checkPath = async target => {
    const resolved = path.resolve(target); const root = path.parse(resolved).root;
    let cursor = root;
    for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('UNSAFE_SYMLINK');
    }
    return resolved;
  };
  const read = async (file, maximum = LIMITS.jsonBytes) => {
    await checkPath(file);
    const before = await lstat(file);
    if (!before.isFile() || before.size > maximum || total + before.size > LIMITS.totalBytes) throw new Error('SOURCE_SIZE_LIMIT');
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (info.ino !== before.ino || info.dev !== before.dev || info.size !== before.size) throw new Error('SOURCE_CHANGED');
      const buffer = Buffer.alloc(info.size + 1); let size = 0;
      while (size < buffer.length) { const part = await handle.read(buffer, size, buffer.length - size, size); if (!part.bytesRead) break; size += part.bytesRead; }
      const after = await handle.stat();
      if (size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('SOURCE_CHANGED');
      total += size; return buffer.subarray(0, size);
    } finally { await handle.close(); }
  };
  const readJson = async file => ({ bytes: await read(file) });
  const load = async file => { const saved = await readJson(file); return { ...saved, value: JSON.parse(saved.bytes.toString('utf8')) }; };
  let root;
  if (phaseRoot === null) gap('PHASE_SOURCE_NOT_CONFIGURED', '尚未收录阶段来源');
  else {
    try { await checkPath(phaseRoot); root = await realpath(phaseRoot); if (!(await lstat(root)).isDirectory()) throw new Error('SOURCE_DIRECTORY_INVALID'); }
    catch { throw new Error('DELIVERY_PHASE_SOURCE_UNAVAILABLE'); }
  }
  const scan = async (directory, taskId, depth, parent = null, linkName = null) => {
    if (depth > LIMITS.depth) { gap('REPAIR_DEPTH_LIMIT', '修复目录超过读取深度', taskId); return; }
    let saved;
    try { saved = await load(path.join(directory, 'state.json')); }
    catch (error) { gap(error.message === 'SOURCE_CHANGED' ? 'SOURCE_CHANGED' : 'STATE_UNAVAILABLE', '阶段状态读取失败', taskId); return; }
    const state = saved.value;
    if (state.taskId !== taskId || !validDigest(state, 'stateDigest') || !object(state.acceptedArtifacts) || !Array.isArray(state.history)) {
      gap('STATE_IDENTITY_OR_DIGEST_INVALID', '阶段状态身份或摘要不匹配', taskId); return;
    }
    let linked = true;
    if (parent) {
      try {
        const link = (await load(path.join(directory, linkName))).value;
        linked = link.taskId === taskId && link.sessionId === state.sessionId && state.sessionId === parent.state.sessionId
          && link.sourceStateDigest === parent.state.stateDigest && link.sourceStateSha256 === digest(parent.bytes)
          && link.sourceCommit === state.sourceCommit && state.sourceCommit === parent.state.sourceCommit
          && object(link.inheritedArtifactDigests) && Object.entries(link.inheritedArtifactDigests)
            .every(([kind, hash]) => parent.state.acceptedArtifacts[kind] === hash && state.acceptedArtifacts[kind] === hash);
      } catch { linked = false; }
      if (!linked) gap('REPAIR_LINK_UNVERIFIED', '修复来源未与父阶段绑定，仅保留历史结果', taskId);
    }
    const record = { state, artifacts: [], depth, isCurrent: linked && parent?.isCurrent !== false, bytes: saved.bytes };
    let entries = [];
    try { await checkPath(path.join(directory, 'artifacts')); entries = await readdir(path.join(directory, 'artifacts'), { withFileTypes: true }); }
    catch { gap('ARTIFACT_DIRECTORY_UNAVAILABLE', '阶段产物目录不可用', taskId); }
    const admitted = entries.filter(entry => /^[a-z][a-z0-9-]+\.json$/u.test(entry.name));
    if (admitted.length > LIMITS.artifacts) gap('ARTIFACT_COUNT_LIMIT', '单阶段目录产物超过读取上限', taskId);
    for (const entry of admitted.sort((a, b) => a.name.localeCompare(b.name)).slice(0, LIMITS.artifacts)) {
      try { const artifact = (await load(path.join(directory, 'artifacts', entry.name))).value; record.artifacts.push(artifact); }
      catch { gap('ARTIFACT_READ_FAILED', '产物读取失败或路径不安全', taskId); }
    }
    // Re-read only the inexpensive state bytes to avoid mixing a new state
    // digest with old artifacts while the original conversation is advancing.
    try { if (!saved.bytes.equals(await read(path.join(directory, 'state.json')))) { gap('SOURCE_CHANGED', '读取期间阶段发生变化，下次同步再纳入', taskId); return; } }
    catch { gap('SOURCE_CHANGED', '读取期间阶段状态不可用', taskId); return; }
    records.push(record);
    for (const [name, receiptName] of REPAIRS) {
      const child = path.join(directory, name);
      try { const info = await lstat(child); if (!info.isDirectory() || info.isSymbolicLink()) { gap('REPAIR_PATH_UNSAFE', '跳过不安全的修复目录', taskId); continue; } }
      catch (error) { if (error.code !== 'ENOENT') gap('REPAIR_PATH_UNAVAILABLE', '修复目录不可用', taskId); continue; }
      await scan(child, taskId, depth + 1, record, receiptName);
    }
  };
  if (root) {
    const entries = (await readdir(root, { withFileTypes: true })).filter(entry => TASK.test(entry.name)
      && (taskIdFilter === undefined || entry.name === taskIdFilter)).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > LIMITS.tasks) gap('TASK_COUNT_LIMIT', '任务目录超过读取上限');
    for (const entry of entries.slice(0, LIMITS.tasks)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) { gap('TASK_PATH_UNSAFE', '跳过不安全的任务目录', entry.name); continue; }
      await scan(path.join(root, entry.name, 'phase-control'), entry.name, 0);
    }
  }
  if (releaseAuditPath) {
    try {
      const lines = (await read(releaseAuditPath, LIMITS.auditBytes)).toString('utf8').split(/\r?\n/u);
      for (const line of lines) {
        if (!line.trim()) continue;
        try { releases.push(JSON.parse(line)); } catch { gap('RELEASE_AUDIT_INVALID_LINE', '发布历史含未完成或无效记录，已跳过该行'); }
      }
    } catch (error) { gap(error.code === 'ENOENT' ? 'RELEASE_SOURCE_MISSING' : 'RELEASE_SOURCE_UNAVAILABLE', '发布历史来源不可用'); }
  } else gap('RELEASE_SOURCE_NOT_CONFIGURED', '未配置发布历史来源');
  if (brokerAuditPath) {
    try {
      const lines = (await read(brokerAuditPath, LIMITS.auditBytes)).toString('utf8').split(/\r?\n/u);
      for (const line of lines) {
        if (!line.trim()) continue;
        try { const audit = JSON.parse(line); if (audit.type === 'taskspace-release') brokerAudits.push(audit);
          else if (audit.type === 'taskspace-checkpoint' && audit.deliveryCenterDocuments) checkpointAudits.push(audit); }
        catch { gap('BROKER_AUDIT_INVALID_LINE', '发布关联审计含未完成或无效记录，已跳过该行'); }
      }
    } catch { gap('BROKER_AUDIT_UNAVAILABLE', '发布关联审计不可用'); }
  }
  for (const filename of historyPacketPaths) {
    try { historyPackets.push(JSON.parse((await read(filename, LIMITS.auditBytes)).toString('utf8'))); }
    catch { gap('HISTORY_PACKET_UNAVAILABLE', '历史资料包不可用，保留此前完整投影'); }
  }
  const collected = committedDocuments ? await collectCommittedDeliveryDocuments({ projectSlug,
    repositoryRoot: committedDocuments.repositoryRoot }) : null;
  const checkpointDocuments = await collectCheckpointDeliveryDocuments({ projectSlug, phaseRoot: root,
    audits: checkpointAudits, read, taskIdFilter });
  return projectDeliverySnapshot({ projectSlug, projectName, records, releases, brokerAudits, historyPackets,
    documents: collected?.documents ?? [], documentCoverage: collected?.coverage, checkpointDocuments, observedAt, gaps });
}
