import { createHash } from 'node:crypto';

// Optional metadata inside an existing phase payload. This module never authors
// business meaning, changes Controller state, or promotes stage acceptance.
export const DELIVERY_ASSET_KINDS = new Set(['function', 'scene', 'entity', 'table', 'page', 'api', 'permission', 'test', 'rule', 'dictionary', 'task']);
const KINDS = new Set(['menu', 'requirement', ...DELIVERY_ASSET_KINDS]);
const NATURES = new Set(['original', 'interpretation', 'design', 'implementation-observation', 'execution', 'historical-compilation', 'unknown']);
const ORIGINS = new Set(['baseline', 'base-upgrade', 'business-added', 'unknown']);
const ADOPTIONS = new Set(['adopted', 'proposed', 'withdrawn', 'superseded', 'unknown']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value.trim() : '';
const list = value => Array.isArray(value) ? value : [];
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** Read aliases from preserved bodies without rewriting frozen source records. */
export function deliveryDisplayRecord(value) {
  if (!object(value) || !object(value.details)) return value;
  if (value.kind === 'requirement' && !text(value.description) && text(value.details.statement)) {
    return { ...value, description: value.details.statement };
  }
  if (value.kind === 'page' && text(value.details.pageName)
    && !['name', 'label', 'title'].some(key => text(value.details[key]))
    && (!text(value.name) || text(value.name).endsWith(' · page'))) {
    return { ...value, name: text(value.details.pageName) };
  }
  return value;
}

export function deliveryReference(value) {
  if (!object(value) || !text(value.kind) || !text(value.id)) return null;
  return { kind: text(value.kind), id: text(value.id), revision: text(value.revision) || null,
    ...(text(value.localId) ? { localId: text(value.localId) } : {}) };
}

export function deliveryCenterMetadata(value) {
  if (!object(value?.deliveryCenter)) return null;
  const input = value.deliveryCenter;
  if (input.schemaVersion !== 1 || !KINDS.has(input.kind) || !text(input.id)) return null;
  const body = { ...value }; delete body.deliveryCenter;
  const revision = text(input.revision) || digest({ kind: input.kind, body, contextId: text(input.contextId) || null });
  const self = { kind: input.kind, id: text(input.id), revision };
  const sources = list(input.sources).filter(object);
  const adoptionInput = object(input.adoption) ? input.adoption : {};
  const adoptionSources = list(adoptionInput.sources).filter(object);
  const reportedState = ADOPTIONS.has(adoptionInput.state) ? adoptionInput.state : 'unknown';
  // A claim without its decision source remains readable, but cannot choose the
  // effective requirement. The enclosing accepted stage is not that source.
  const adoption = { ...adoptionInput,
    state: ['adopted', 'withdrawn', 'superseded'].includes(reportedState) && !adoptionSources.length ? 'unknown' : reportedState,
    sources: adoptionSources,
    supersedes: list(adoptionInput.supersedes ?? input.supersedes).map(deliveryReference).filter(Boolean) };
  if (adoption.state !== reportedState) adoption.reportedState = reportedState;
  const relations = list(input.relations).filter(object).map(relation => {
    const to = deliveryReference(relation.to) ?? deliveryReference({ kind: relation.targetKind, id: relation.targetId, revision: relation.targetRevision });
    if (!to || !text(relation.type)) return null;
    return { ...relation, id: text(relation.id) || null, revision: text(relation.revision) || null,
      type: text(relation.type), from: deliveryReference(relation.from) ?? self, to,
      conditions: relation.conditions ?? null, sources: list(relation.sources).filter(object),
      // Retain the old reader's aliases while preserving the precise reference.
      targetKind: to.kind, targetId: to.id, targetRevision: to.revision };
  }).filter(Boolean);
  const originSources = list(input.originSources).filter(object);
  return { schemaVersion: 1, ...self, recordType: text(input.recordType) || (['menu', 'requirement', 'function'].includes(input.kind) ? input.kind : 'unknown'),
    nature: NATURES.has(input.nature) ? input.nature : 'unknown', contextId: text(input.contextId) || null,
    sources, adoption, relations, functionRefs: list(input.functionRefs).map(deliveryReference).filter(Boolean),
    menuRefs: list(input.menuRefs).map(deliveryReference).filter(ref => ref?.kind === 'menu'),
    menuApplicability: input.menuApplicability === 'none' ? 'none' : 'unknown',
    origin: ORIGINS.has(input.origin) && (input.origin === 'unknown' || originSources.length) ? input.origin : 'unknown', originSources,
    businessChange: ['modified', 'unchanged'].includes(input.businessChange) ? input.businessChange : 'unknown',
    ...(deliveryReference(input.parentRef) ? { parentRef: deliveryReference(input.parentRef) } : {}),
    ...(input.scope !== undefined ? { scope: input.scope } : {}) };
}

export function deliverySemanticRows(value) {
  const result = []; let visited = 0;
  const walk = (item, pointer, depth) => {
    if (++visited > 30000 || depth > 64) throw Object.assign(new Error('DELIVERY_PROJECTION_LIMIT'), { code: 'PROJECTION_LIMIT' });
    if (Array.isArray(item)) { item.forEach((child, index) => walk(child, `${pointer}/${index}`, depth + 1)); return; }
    if (!object(item)) return;
    const metadata = deliveryCenterMetadata(item);
    if (metadata) result.push({ value: item, metadata, pointer });
    for (const [key, child] of Object.entries(item)) {
      // These are references and provenance, not nested business definitions.
      if (['deliveryCenter', 'sources', 'relations', 'references', 'evidence'].includes(key)) continue;
      if (object(child) || Array.isArray(child)) walk(child, `${pointer}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`, depth + 1);
    }
  };
  walk(value, '', 0);
  return result;
}

export function selectDeliverySemanticRevision(versions) {
  const key = value => `${value.id}\0${value.revision}`;
  const authoritative = versions.filter(value => ['adopted', 'withdrawn', 'superseded'].includes(value.adoption?.state)
    && value.adoption.sources?.length);
  const replaced = new Set(authoritative.flatMap(value => value.adoption.supersedes ?? [])
    .filter(ref => ref.revision).map(ref => `${ref.id}\0${ref.revision}`));
  const active = authoritative.filter(value => !replaced.has(key(value)));
  const distinct = [...new Map(active.map(value => [key(value), value])).values()];
  if (distinct.length === 1) return { value: distinct[0], selection: 'explicit-decision' };
  // Ordering only makes the document preview deterministic; it is not adoption.
  const ordered = [...versions].sort((a, b) => `${a.revision}\0${a.sourceRevision}`.localeCompare(`${b.revision}\0${b.sourceRevision}`));
  return { value: ordered[0], selection: distinct.length > 1 ? 'unresolved' : 'documented-only' };
}

const businessRows = value => Array.isArray(value) ? value : object(value)
  ? Object.entries(value).map(([name, entry]) => object(entry) ? { name, ...entry } : { name, description: entry }) : [];
const menuPath = value => Array.isArray(value) ? value.filter(part => typeof part === 'string' && part.trim()) : [];

/** Source carriers are not Controller stages. Checkpoint batches identify only
 * a committed source; neither kind of document creates phase acceptance. */
export function deliveryDefinitionSources(snapshot, documents = []) {
  const batches = new Map(snapshot.batches.map(value => [value.id, value]));
  const stages = snapshot.stages.filter(stage => stage.digest && object(stage.details)).map(stage => {
    const batch = batches.get(stage.batchId);
    return { details: stage.details, stageId: stage.id, batchId: stage.batchId, phaseId: stage.phaseId,
      status: stage.status, name: stage.name, sourceRevision: stage.digest, recordedAt: stage.createdAt ?? null,
      commits: [], source: { stageId: stage.id, batchId: stage.batchId, digest: stage.digest,
        taskId: batch?.taskId ?? null, sessionId: batch?.sessionId ?? null, label: stage.name } };
  });
  return [...stages, ...documents.map(document => ({ details: { records: document.records }, stageId: null,
    batchId: document.sourceScope === 'taskspace-checkpoint' ? document.batchId : null,
    sourceScope: document.sourceScope ?? null, phaseId: null, status: 'documented', name: document.path,
    sourceRevision: document.commit, recordedAt: document.committedAt, commits: [document.commit],
    documentCurrent: document.sourceScope !== 'taskspace-checkpoint' && document.isCurrent === true,
    source: { kind: 'committed-document', sourcePath: document.path, commit: document.commit,
      blob: document.blob, digest: document.contentDigest, line: document.line, fenceLine: document.fenceLine,
      ...(document.sourceScope === 'taskspace-checkpoint' ? { sourceScope: document.sourceScope,
        batchId: document.batchId, taskId: document.taskId, conversationId: document.conversationId,
        sessionId: document.dshSessionId, dshSessionId: document.dshSessionId,
        sourceTree: document.sourceTree, sourceTransitionDigest: document.sourceTransitionDigest,
        envelopePath: document.envelopePath, envelopeDigest: document.envelopeDigest } : {}) } }))];
}

/** Add explicitly identified definitions, including drafts, without accepting them. */
export function projectDeliverySemanticRecords(snapshot, documents = []) {
  const menus = new Map(snapshot.menus.map(value => [value.id, value]));
  const requirements = new Map(snapshot.requirements.map(value => [value.id, value]));
  const groups = new Map();
  for (const origin of deliveryDefinitionSources(snapshot, documents)) {
    for (const row of deliverySemanticRows(origin.details)) {
      const meta = row.metadata;
      if (!['menu', 'requirement'].includes(meta.kind)) continue;
      const body = { ...row.value }; delete body.deliveryCenter;
      const source = { ...origin.source, pointer: row.pointer };
      const value = { ...meta, name: text(body.name ?? body.title ?? body.label ?? body.resourceName) || meta.id,
        description: text(body.description ?? body.requirement ?? body.summary ?? body.statement), details: body,
        sourceRevision: origin.sourceRevision, recordedAt: origin.recordedAt, sourceRecordedAt: origin.recordedAt, sources: [source, ...meta.sources],
        commits: origin.commits, batchIds: origin.batchId ? [origin.batchId] : [], stageId: origin.stageId,
        stageStatus: origin.phaseId ? { [origin.phaseId]: origin.status } : {}, status: 'documented',
        menuIds: meta.menuApplicability === 'none' ? [] : meta.menuRefs.map(ref => ref.id),
        menuPath: meta.menuApplicability === 'none' ? [] : menuPath(body.menuPath),
        fields: businessRows(body.fields), actions: businessRows(body.actions), rules: businessRows(body.rules ?? body.businessRules),
        permissions: businessRows(body.permissions), page: text(body.page ?? body.pageName) || null,
        ...(origin.sourceScope === 'taskspace-checkpoint' ? { sourceScope: origin.sourceScope, isCurrent: false } : {}) };
      const groupKey = `${meta.kind}\0${meta.id}`;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(value);
    }
  }
  const choose = versions => {
    const selected = selectDeliverySemanticRevision(versions);
    const value = { ...selected.value, adoptionSelection: selected.selection,
      sources: [...new Map(versions.flatMap(row => row.sources).map(source => [digest(source), source])).values()],
      batchIds: [...new Set(versions.flatMap(row => row.batchIds))],
      variants: versions.map(row => ({ ...row })) };
    if (selected.selection === 'unresolved') value.adoption = { state: 'unknown', sources: [], supersedes: [] };
    return value;
  };
  for (const versions of groups.values()) {
    if (versions[0].kind !== 'menu') continue;
    const scoped = versions.filter(row => row.sourceScope === 'taskspace-checkpoint');
    const integrated = versions.filter(row => row.sourceScope !== 'taskspace-checkpoint');
    const value = choose(integrated.length ? integrated : versions);
    const parentRef = value.parentRef ?? deliveryReference(value.details.parentRef);
    const explicitPath = menuPath(value.details.menuPath ?? value.details.path);
    const parentId = parentRef?.id ?? (text(value.details.parentId) || null);
    const definition = { ...value, path: explicitPath.length ? explicitPath : [value.name],
      parentId: parentId || null, parentRef: parentRef ?? null,
      route: text(value.details.route), hierarchyStatus: explicitPath.length ? 'explicit' : 'unknown' };
    const previous = menus.get(value.id);
    if (scoped.length && !integrated.length && previous) {
      // Local definitions remain inspectable, but cannot rename/move a menu
      // already selected by the integrated source or its runtime observation.
      const history = [...(previous.variants ?? [previous]), ...versions];
      menus.set(value.id, { ...previous,
        variants: [...new Map(history.map(row => [digest(row), row])).values()],
        batchIds: [...new Set([...(previous.batchIds ?? []), ...versions.flatMap(row => row.batchIds)])] });
    } else menus.set(value.id, definition);
  }
  // A missing parent remains an unresolved reference, never a fabricated node.
  for (const menu of menus.values()) if (menu.parentId && !menus.has(menu.parentId)) {
    menu.parentRef ??= { kind: 'menu', id: menu.parentId, revision: null };
    menu.parentId = null; menu.hierarchyStatus = 'unknown';
  }
  snapshot.requirementVersions ??= [];
  for (const versions of groups.values()) {
    if (versions[0].kind !== 'requirement') continue;
    for (const value of versions) {
      const knownMenus = value.menuIds.map(id => menus.get(id)).filter(Boolean);
      value.menuId = knownMenus[0]?.id ?? null;
      value.menuPaths = knownMenus.map(menu => menu.path);
      if (!value.menuPath.length && knownMenus.length) value.menuPath = knownMenus[0].path;
      value.granularity = value.recordType === 'requirement' ? 'independent-requirement' : value.recordType;
      snapshot.requirementVersions.push({ ...value });
    }
    const integrated = versions.filter(row => row.sourceScope !== 'taskspace-checkpoint');
    if (integrated.length) {
      const value = choose(integrated);
      requirements.set(value.id, value);
    }
  }
  snapshot.menus = [...menus.values()]; snapshot.requirements = [...requirements.values()];
  return snapshot;
}
