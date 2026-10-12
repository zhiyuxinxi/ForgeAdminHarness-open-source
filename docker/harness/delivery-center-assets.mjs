import { DeliveryCenterError, isDeliveryRevision } from './delivery-center-http.mjs';
import { semanticMatch, deliverySummary, historyMetadata } from './delivery-center-views.mjs';

export const DELIVERY_ASSET_KINDS = Object.freeze(['function', 'scene', 'entity', 'table', 'page', 'api', 'permission', 'test', 'rule', 'dictionary', 'task']);
const MAX_VERSIONS = 100;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const decode = value => typeof value === 'string' ? JSON.parse(value) : Buffer.isBuffer(value) ? JSON.parse(value.toString('utf8')) : value;
const array = value => Array.isArray(value) ? value : [];

export function validateSpecificationArtifact(artifact) {
  if (artifact.kind !== 'specification-asset') return;
  const item = artifact.payload;
  const invalid = () => { throw new DeliveryCenterError('DELIVERY_INPUT_INVALID', 'Specification asset is invalid.'); };
  if (!object(item) || !identifier.test(item.assetId ?? '') || !DELIVERY_ASSET_KINDS.includes(item.kind)
    || typeof item.name !== 'string' || !item.name || item.name.length > 512
    || !isDeliveryRevision(item.revision) || !object(item.details)) invalid();
  for (const key of ['menuIds', 'batchIds', 'releaseIds']) {
    if (!Array.isArray(item[key]) || item[key].some(id => typeof id !== 'string' || !identifier.test(id))) invalid();
  }
  if (!Array.isArray(item.menuPaths) || item.menuPaths.some(parts => !Array.isArray(parts) || parts.some(part => typeof part !== 'string'))
    || !Array.isArray(item.sources) || !Array.isArray(item.relations) || !Array.isArray(item.commits)) invalid();
  if (item.recordedAt != null && (typeof item.recordedAt !== 'string' || !Number.isFinite(Date.parse(item.recordedAt)))) invalid();
  if (Object.hasOwn(item, 'isCurrent') || Object.hasOwn(item, 'observedAt')) invalid();
}

function compareVersions(left, right) {
  const timestamp = value => Number.isFinite(Date.parse(value.recordedAt)) ? Date.parse(value.recordedAt) : 0;
  return timestamp(right) - timestamp(left) || String(right.versionId).localeCompare(String(left.versionId));
}

/** Current history-packet heads are explicit; observation time never elects one. */
export function deliveryAssetVersions(rows, coverage = {}) {
  const packetHeads = new Set(array(coverage.currentAssetVersionIds));
  const aliases = object(coverage.menuAliases) ? coverage.menuAliases : {};
  return rows.map(row => {
    const artifact = decode(row.data ?? row);
    if (artifact?.kind !== 'specification-asset' || !object(artifact.payload)) return null;
    const isCurrent = artifact.stageId ? row.stage_current === true || Number(row.stage_current) === 1 : packetHeads.has(artifact.id);
    return { ...artifact.payload, id: artifact.payload.assetId, versionId: artifact.id, stageId: artifact.stageId ?? null,
      resolvedMenuIds: array(artifact.payload.menuIds).map(id => aliases[id] ?? id),
      artifactReleaseId: artifact.releaseId ?? null, isCurrent,
      ...(row.search_match !== undefined ? { searchMatches: Boolean(Number(row.search_match)) } : {}) };
  }).filter(Boolean).sort(compareVersions);
}

export function deliveryMenuDescendants(menus, menuId) {
  const ids = new Set([String(menuId)]);
  const children = new Map();
  for (const menu of menus) {
    if (menu.parentId === null || menu.parentId === undefined) continue;
    const parent = String(menu.parentId);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(String(menu.id));
  }
  const queue = [...ids];
  // Each distinct ID is enqueued once, including malformed cycles/self-links.
  // Unlike repeated full scans, reverse-ordered deep trees remain linear.
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]) ?? []) if (!ids.has(child)) { ids.add(child); queue.push(child); }
  }
  return ids;
}

function selectedMenus(menus, menuId, menuScope) {
  return { ids: menuScope === 'self' ? new Set([String(menuId)]) : deliveryMenuDescendants(menus, menuId), root: menus.find(menu => String(menu.id) === String(menuId)), self: menuScope === 'self' };
}

function matchesMenu(item, selected) {
  if ([...array(item.menuIds), ...array(item.resolvedMenuIds)].some(id => selected.ids.has(String(id)))) return true;
  const prefix = selected.root?.path;
  return Array.isArray(prefix) && prefix.length > 0 && array(item.menuPaths).some(parts => (!selected.self || parts.length === prefix.length) && prefix.every((part, index) => parts[index] === part));
}

function releasedVersions(versions, release) {
  // A requirement list alone cannot imply asset scope. The existing validated
  // release receipt also freezes exact stage digests and their task identity.
  if (!release || release.status !== 'success' || release.scopeBinding === 'unknown') return [];
  const evidence = release.scopeBindingEvidence;
  const digests = release.scopeBinding === 'frozen-explicit-snapshot' && evidence?.scope === 'validated-task-delivery'
    && evidence.taskId === release.taskId && evidence.commit === release.commit
    ? new Set(Object.values(evidence.acceptedArtifactDigests ?? {}).filter(value => /^[a-f0-9]{64}$/.test(value))) : new Set();
  return versions.filter(item => item.artifactReleaseId === release.id || array(item.releaseIds).includes(release.id)
    || (item.stageId && digests.has(item.sourceRevision) && array(item.sources).some(source => source.taskId === release.taskId && source.digest === item.sourceRevision)));
}

function chooseHeads(versions) {
  const heads = new Map();
  for (const version of [...versions].sort(compareVersions)) if (!heads.has(version.assetId)) heads.set(version.assetId, version);
  return [...heads.values()];
}

const checkpoint = item => item.sourceScope === 'taskspace-checkpoint';
const visibleByDefault = item => item.isCurrent || checkpoint(item);
const candidateLineage = item => {
  const source = array(item.sources).find(value => value?.sourceScope === 'taskspace-checkpoint') ?? {};
  return source.taskId || source.conversationId || source.sessionId || item.versionId;
};

/** A reading preview is not an adoption decision. Retain separate workpod
 * branches; chronology only orders checkpoints from the same source task. */
function collectedHeads(versions, menuSelection = null) {
  const groups = new Map();
  for (const item of versions.filter(visibleByDefault)) {
    if (!groups.has(item.assetId)) groups.set(item.assetId, []);
    groups.get(item.assetId).push(item);
  }
  return [...groups.values()].map(group => {
    const candidates = new Map();
    for (const item of [...group].sort(compareVersions)) if (checkpoint(item) && !candidates.has(candidateLineage(item))) candidates.set(candidateLineage(item), item);
    // Cross-branch ordering only stabilizes the preview, never elects a final definition.
    // Resolve each lineage before checking menu bindings: removing a binding
    // in its newest checkpoint must not resurrect an older branch revision.
    const inMenu = item => !menuSelection || Boolean(menuSelection.root && matchesMenu(item, menuSelection));
    const branches = [...candidates.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => item).filter(inMenu);
    const selected = chooseHeads(group.filter(item => item.isCurrent)).find(inMenu) ?? branches[0];
    if (!branches.length) return selected;
    return { ...selected, readingSelection: { basis: selected.isCurrent ? 'current-definition' : 'checkpoint-preview',
      candidateCount: branches.length, candidates: branches.slice(0, 20).map(item => ({ ...historyMetadata(item),
        sourceScope: item.sourceScope, batchIds: item.batchIds, isCurrent: item.isCurrent })), candidatesHasMore: branches.length > 20 } };
  }).filter(Boolean);
}

export function groupsDeliveryMenuReferences(filters = {}) {
  return Boolean(filters.menuId && !filters.batchId && !filters.releaseId && ['entity', 'table'].includes(filters.kind));
}

function menuReferenceIndex(pages) {
  const index = new Map();
  for (const page of pages) {
    const component = page.details?.component?.replace(/^\/+|\.vue$/gu, '');
    const root = array(page.sources).find(source => component &&
      [ `/src/views/${component}.vue`, `/src/views/${component}/index.vue` ].some(suffix => source.path?.endsWith(suffix)));
    for (const menuId of array(page.menuIds)) for (const binding of array(page.details?.apiBindings)) {
      const source = binding.source;
      if (!binding.assetId || !source?.commit) continue;
      const key = JSON.stringify([menuId, binding.assetId, source.commit]);
      if (!index.has(key)) index.set(key, []);
      const componentPath = source.path;
      const direct = root?.commit === source.commit && root.path === componentPath;
      const shared = root?.commit === source.commit && array(page.details?.relatedComponents).includes(componentPath)
        && /\/src\/components\/common\//u.test(componentPath ?? '');
      index.get(key).push({ classification: direct ? 'direct-page' : shared ? 'shared-component' : 'unknown',
        pagePath: root?.path ?? null, componentPath: componentPath ?? null,
        endpointId: binding.assetId, method: binding.method ?? null, path: binding.path ?? null, sources: [source] });
    }
  }
  return index;
}

function classifyMenuReference(item, selected, index) {
  const ids = array(item.menuIds).filter(id => selected.ids.has(String(id)));
  const sourceMenus = source => [...array(source.menuIds), source.menuId].filter(Boolean);
  const evidence = array(item.sources).filter(source => sourceMenus(source).some(id => ids.includes(id)));
  const bindings = []; let incomplete = !ids.length;
  for (const id of ids) if (!evidence.some(source => sourceMenus(source).includes(id))) incomplete = true;
  for (const source of evidence) for (const menuId of sourceMenus(source).filter(id => ids.includes(id))) {
    const matches = index.get(JSON.stringify([menuId, source.endpointId, source.commit])) ?? [];
    if (!matches.length) incomplete = true;
    for (const match of matches) {
      // Bind the endpoint dependency and component call to the same fixed source.
      const metadata = Object.fromEntries(['type', 'path', 'commit', 'sha256', 'digest', 'line', 'menuId', 'menuIds', 'endpointId', 'referenceKind']
        .filter(key => source[key] !== undefined).map(key => [key, source[key]]));
      bindings.push({ ...match, sources: [...match.sources, metadata] });
    }
  }
  const direct = bindings.some(binding => binding.classification === 'direct-page');
  const explicit = array(item.menuRefs).some(ref => ref?.kind === 'menu' && selected.ids.has(String(ref.id)));
  const shared = !incomplete && bindings.length && bindings.every(binding => binding.classification === 'shared-component');
  const classification = explicit ? 'explicit-business' : direct ? 'direct-page' : shared ? 'shared-component' : 'unknown';
  return { ...item, menuReference: { classification, purpose: null, menuIds: ids,
    bindings: [...new Map(bindings.map(({ classification: ignored, ...binding }) => [JSON.stringify(binding), binding])).values()],
    limitations: [classification === 'unknown' ? '用途待明确：现有来源不足以区分该菜单的直接使用与共享组件引用。'
      : '静态源码引用，不证明运行调用、数据库读写、菜单直接维护、业务采用或发布。'] } };
}

export function listDeliveryAssets({ versions, menus = [], filters = {}, release = null, referencePages = [] }) {
  const page = filters.page ?? 1; const pageSize = filters.pageSize ?? 50;
  const selected = filters.menuId ? selectedMenus(menus, filters.menuId, filters.menuScope) : null;
  let candidates = filters.releaseId ? releasedVersions(versions, release) : versions;
  if (filters.batchId) candidates = candidates.filter(item => array(item.batchIds).includes(filters.batchId));
  const collected = !filters.batchId && !filters.releaseId;
  let items = collected ? collectedHeads(candidates, selected) : chooseHeads(candidates);
  if (filters.kind) items = items.filter(item => item.kind === filters.kind);
  items = items.filter(item => semanticMatch(item, filters));
  if (selected) items = selected.root ? items.filter(item => matchesMenu(item, selected)) : [];
  if (filters.q) {
    const needle = filters.q.normalize('NFC').toLocaleLowerCase();
    items = items.filter(item => item.searchMatches === true || JSON.stringify(item).normalize('NFC').toLocaleLowerCase().includes(needle));
  }
  let sharedReferences;
  if (groupsDeliveryMenuReferences(filters)) {
    const index = menuReferenceIndex(referencePages);
    items = items.map(item => classifyMenuReference(item, selected, index));
    sharedReferences = { total: items.filter(item => item.menuReference.classification === 'shared-component').length };
    items = items.filter(item => (item.menuReference.classification === 'shared-component') === (filters.referenceGroup === 'shared'));
  }
  items.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN') || a.assetId.localeCompare(b.assetId));
  return { items: items.slice((page - 1) * pageSize, page * pageSize).map(item => filters.projection === 'summary' ? deliverySummary(item) : item), total: items.length, page, pageSize,
    ...(sharedReferences ? { sharedReferences } : {}),
    ...(filters.releaseId ? { scopeBinding: candidates.length ? 'explicit-asset-binding' : 'unknown' } : {}) };
}

export function getDeliveryAsset({ versions, menus = [], assetId, filters = {}, release = null }) {
  let candidates = versions.filter(item => item.assetId === assetId);
  if (filters.releaseId) candidates = releasedVersions(candidates, release);
  if (filters.batchId) candidates = candidates.filter(item => array(item.batchIds).includes(filters.batchId));
  candidates.sort(compareVersions);
  const collected = !filters.batchId && !filters.releaseId ? collectedHeads(candidates)[0] : null;
  const selected = filters.revision !== undefined
    ? candidates.find(item => item.versionId === filters.revision) ?? candidates.find(item => String(item.revision) === String(filters.revision))
    : filters.batchId || filters.releaseId ? candidates[0] : collected;
  if (!selected) return null;
  const referenced = new Set([...array(selected.menuIds), ...array(selected.resolvedMenuIds)].map(String));
  const paths = array(selected.menuPaths).map(parts => JSON.stringify(parts));
  const usedByMenus = menus.filter(menu => referenced.has(String(menu.id)) || paths.includes(JSON.stringify(menu.path)))
    .map(menu => ({ id: menu.id, name: menu.name, path: menu.path }));
  const revisions = candidates.slice(0, MAX_VERSIONS).map(item => ({ ...item }));
  if (!revisions.some(item => item.versionId === selected.versionId)) revisions[revisions.length - 1] = { ...selected };
  return { ...selected, ...(collected?.readingSelection ? { readingSelection: { ...collected.readingSelection,
    basis: selected.isCurrent ? 'current-definition' : checkpoint(selected) ? 'checkpoint-preview' : 'historical-revision' } } : {}),
    usedByMenus, revisions: filters.detailMode === 'single' ? revisions.map(historyMetadata) : revisions, revisionsHasMore: candidates.length > MAX_VERSIONS,
    ...(filters.releaseId ? { releaseId: filters.releaseId, scopeBinding: 'explicit-asset-binding' } : {}) };
}

/** Read-only detail projection of relationships explicitly recorded on this
 * selected revision. It never resolves another asset or promotes a revision. */
export function withExplicitRelationDetails(item) {
  if (item?.kind !== 'entity' || !object(item.details)) return item;
  const rootId = item.assetId ?? item.id;
  const ref = value => object(value) && typeof value.id === 'string' && value.id && typeof value.kind === 'string';
  const relations = array(item.relations).filter(relation => object(relation) && ref(relation.from) && ref(relation.to)
    && relation.from.kind === item.kind && relation.from.id === rootId
    && (relation.from.revision == null || relation.from.revision === item.revision)
    && array(relation.sources).some(source => object(source) && Object.keys(source).length));
  const relationships = relations.filter(relation => relation.to.kind === 'entity' && ['references', 'has-many'].includes(relation.type))
    .map(relation => ({ ...relation, targetRef: { ...relation.to }, name: relation.name ?? relation.label ?? relation.type }));
  const storage = relations.filter(relation => relation.type === 'stored-in' && relation.to.kind === 'table');
  const modelMappings = storage.map(relation => ({ ...relation, entity: { ...relation.from }, table: { ...relation.to } }));
  // Different table revisions are also distinct targets. A field declaration
  // without its own table binding cannot be distributed across those targets.
  const targets = new Set(storage.map(relation => JSON.stringify([relation.to.id, relation.to.revision ?? null])));
  if (targets.size === 1) {
    const relation = storage[0];
    for (const attribute of array(item.details.attributes).filter(object)) {
      const column = typeof attribute.storageColumn === 'string' && attribute.storageColumn.trim() ? attribute.storageColumn : null;
      const columns = array(attribute.storageColumns);
      if ((!column && !columns.length) || (columns.length && columns.some(value => typeof value !== 'string' || !value.trim()))) continue;
      if (typeof attribute.name !== 'string' || !attribute.name.trim()) continue;
      // Keep grouped attributes and columns together: no positional pairing or
      // cardinality, foreign-key, nullability or adoption inference is made.
      modelMappings.push({ ...attribute, businessAttribute: attribute.name, entityRef: { ...relation.from }, table: { ...relation.to },
        field: columns.length ? columns : column, storageMode: attribute.storageFormat ?? null,
        conditions: relation.conditions, description: attribute.businessMeaning ?? attribute.description ?? null,
        sources: [...relation.sources, ...array(attribute.sources)], relationId: relation.id ?? null });
    }
  }
  const append = (existing, projected) => {
    if (existing !== undefined && !Array.isArray(existing)) return existing;
    const rows = [...array(existing)];
    const exact = new Set(rows.map(row => JSON.stringify(row)));
    const ids = new Set(rows.filter(object).map(row => row.id).filter(Boolean));
    for (const row of projected) if (!exact.has(JSON.stringify(row)) && !(row.id && ids.has(row.id))) {
      rows.push(row); exact.add(JSON.stringify(row)); if (row.id) ids.add(row.id);
    }
    return rows;
  };
  if (!relationships.length && !modelMappings.length) return item;
  const details = { ...item.details };
  if (relationships.length) details.relationships = append(details.relationships ?? details.logicalRelations, relationships);
  if (modelMappings.length) details.modelMappings = append(details.modelMappings ?? details.tableMappings ?? details.tables ?? details.entityMappings ?? details.fieldMappings, modelMappings);
  return { ...item, details };
}

export function deliveryAssetCounts(versions) {
  const counts = Object.fromEntries(DELIVERY_ASSET_KINDS.map(kind => [kind, 0]));
  for (const item of chooseHeads(versions.filter(visibleByDefault))) if (Object.hasOwn(counts, item.kind)) counts[item.kind] += 1;
  return counts;
}
