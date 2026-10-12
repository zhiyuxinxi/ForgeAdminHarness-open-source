import { createHash } from 'node:crypto';
import { generateExplicitDiagrams } from './delivery-center-diagrams.mjs';
import { DELIVERY_ASSET_KINDS, deliveryCenterMetadata, deliveryDefinitionSources, deliveryReference, deliverySemanticRows, selectDeliverySemanticRevision } from './delivery-center-semantics.mjs';

const PRIVATE_KEY = /(?:password|passwd|secret|token|credential|authorization|cookie|privatekey|approvalref|rollbackenv|connectionstring|privatechat|rawchat)/iu;
const PRIVATE_VALUE = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+|\bBearer\s+[A-Za-z0-9_.-]{8,}|\bsk-[a-zA-Z0-9_-]{12,}|\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@)/iu;
const KINDS = DELIVERY_ASSET_KINDS;
const COLLECTIONS = new Map(Object.entries({ useCases: 'scene', scenarios: 'scene', workflows: 'scene', processes: 'scene',
  businessEntities: 'entity', tables: 'table', pages: 'page', apiContracts: 'api', apiImplementation: 'api',
  permissionCodes: 'permission', permissionBindings: 'permission', buttonSeed: 'permission', apiResourceSeed: 'permission',
  acceptanceCriteria: 'test', redTests: 'test', testEvidence: 'test', businessRules: 'rule', validationRules: 'rule',
  concurrencyRules: 'rule', dictionaries: 'dictionary', scheduledTasks: 'task', backgroundTasks: 'task', taskDefinitions: 'task' }));
const REPORT_TOPICS = new Map([
  ['roleVisibilityContract', { kind: 'permission', recordType: 'permission-contract', nature: 'design' }],
  ['permissionEnforcement', { kind: 'permission', recordType: 'permission-enforcement', nature: 'implementation-observation' }],
  ...['redTests', 'testEvidence', 'permissionCoherence'].map(topic => [topic, { kind: 'test', recordType: 'test-evidence-report', nature: 'execution' }]),
]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value.trim() : '';
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const deliveryAssetDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const deliveryAssetId = (project, kind, key) => `asset-${deliveryAssetDigest([project, kind, key]).slice(0, 32)}`;
const first = (value, keys) => keys.map(key => string(value?.[key])).find(Boolean) ?? '';
const parts = value => Array.isArray(value) ? strings(value) : typeof value === 'string' ? value.split(/\s*(?:→|>|\/|\\|｜|\|)\s*/u).filter(Boolean) : [];

/** Named business topics may have arbitrary business keys. Do not lose relation or DTO fields. */
export function sanitizeDeliveryDetail(value, depth = 0) {
  if (depth > 64) throw Object.assign(new Error('DELIVERY_PROJECTION_LIMIT'), { code: 'PROJECTION_LIMIT' });
  if (typeof value === 'string') return PRIVATE_VALUE.test(value) ? '[敏感内容已隐藏]' : value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '');
  if (Array.isArray(value)) return value.map(item => sanitizeDeliveryDetail(item, depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEY.test(key))
    .map(([key, item]) => [key, sanitizeDeliveryDetail(item, depth + 1)]));
  return typeof value === 'number' || typeof value === 'boolean' || value === null ? value : null;
}

function rows(value, pointer) {
  if (Array.isArray(value)) return value.map((item, index) => ({ value: item, key: '', pointer: `${pointer}/${index}` }));
  if (typeof value === 'string') return value.trim() ? [{ value: { description: value }, key: '', pointer }] : [];
  if (!object(value)) return [];
  if (first(value, ['name', 'title', 'label', 'id', 'key', 'code', 'path', 'route', 'tableName', 'entityName', 'description'])) return [{ value, key: '', pointer }];
  return Object.entries(value).map(([key, item]) => ({ value: object(item) ? item : { description: item }, key, pointer: `${pointer}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}` }));
}

function diagram(value, source) {
  const raw = typeof value.diagram === 'string' ? value.diagram : string(value.diagram?.source) || string(value.mermaid);
  const normalized = raw.replace(/^```mermaid\s*/u, '').replace(/\s*```$/u, '').trim();
  const type = /^(?:flowchart|graph)\s/u.test(normalized) ? 'flowchart' : /^erDiagram\b/u.test(normalized) ? 'erDiagram' : null;
  return type ? { type, source: normalized, sourceRefs: [source] } : null;
}

function relationships(value, project, source) {
  const values = value.relations ?? value.relationships;
  if (!Array.isArray(values)) return [];
  return values.filter(object).map(item => {
    const targetKind = string(item.to?.kind) || first(item, ['targetKind', 'kind']) || 'entity';
    const targetKey = string(item.to?.id) || first(item, ['targetId', 'targetEntity', 'targetTable', 'target', 'entity', 'table']);
    if (!targetKey) return null;
    const targetId = string(item.to?.id) || string(item.targetId) || deliveryAssetId(project, targetKind, targetKey);
    return { ...sanitizeDeliveryDetail(item), type: first(item, ['type', 'relationType']) || 'references', targetId,
      targetKind, label: first(item, ['label', 'description', 'name']) || targetKey,
      cardinality: first(item, ['cardinality', 'multiplicity']) || null,
      id: string(item.id) || null, revision: string(item.revision) || null,
      to: deliveryReference(item.to) ?? { kind: targetKind, id: targetId, revision: string(item.targetRevision) || null },
      targetRevision: string(item.to?.revision) || string(item.targetRevision) || null,
      conditions: item.conditions ?? null, sources: Array.isArray(item.sources) ? sanitizeDeliveryDetail(item.sources) : [source], source };
  }).filter(Boolean);
}

/** Project existing stage content; this does not author business specifications or acceptance results. */
export function projectDeliveryStageAssets(snapshot, documents = []) {
  const result = []; const known = new Set();
  const currentIds = new Set(snapshot.coverage.currentAssetVersionIds ?? []);
  const menusByPath = new Map(snapshot.menus.map(menu => [JSON.stringify(menu.path), menu]));
  for (const stage of deliveryDefinitionSources(snapshot, documents)) {
    const source = stage.source;
    const stagePaths = [];
    const addPath = path => { if (path.length && !stagePaths.some(other => JSON.stringify(other) === JSON.stringify(path))) stagePaths.push(path); };
    addPath(parts(stage.details.pageMode?.entry?.group));
    const page = stage.details.permissionMatrix?.businessPage;
    if (page && first(page, ['pageName', 'name'])) addPath([...parts(page.parentResource?.parentChain), first(page, ['pageName', 'name'])]);
    for (const requirement of snapshot.requirements) if (stage.stageId && requirement.sources?.some(item => item.stageId === stage.stageId)) addPath(requirement.menuPath);
    const emittedPointers = new Set();
    const emit = (kind, row, topic, reportType) => {
      const value = object(row.value) ? row.value : { description: row.value };
      const metadata = deliveryCenterMetadata(value);
      const report = metadata ? null : reportType;
      if (metadata && !KINDS.has(metadata.kind)) return;
      if (emittedPointers.has(row.pointer)) return;
      emittedPointers.add(row.pointer);
      if (metadata) kind = metadata.kind;
      const method = first(value, ['method', 'httpMethod']).toUpperCase(); const endpoint = first(value, ['path', 'url', 'route']);
      const explicitKey = kind === 'api' && method && endpoint ? `${method} ${endpoint}`
        : kind === 'page' && endpoint ? endpoint : first(value, ['id', 'key', 'code', 'tableName', 'entityName', 'name', 'title']) || row.key;
      const key = report ? `${source.taskId ?? stage.batchId ?? stage.stageId}:${stage.phaseId}:${topic}` : explicitKey || `${source.taskId ?? stage.batchId}:${row.pointer}`;
      const name = first(value, ['name', 'label', 'title', 'pageName', 'tableName', 'entityName']) || row.key || (method && endpoint ? `${method} ${endpoint}` : `${stage.name} · ${topic}`);
      let menuPaths = Array.isArray(value.menuPaths) ? value.menuPaths.map(parts) : [];
      const path = parts(value.menuPath ?? value.menu); if (path.length) menuPaths.push(path);
      if (!metadata && !menuPaths.length && stagePaths.length === 1) menuPaths = [stagePaths[0]];
      if (metadata?.menuApplicability === 'none') menuPaths = [];
      const menuIds = metadata?.menuApplicability === 'none' ? [] : [...new Set([
        ...(metadata?.menuRefs.map(ref => ref.id) ?? []), ...strings(value.menuIds),
        ...menuPaths.map(path => menusByPath.get(JSON.stringify(path))?.id).filter(Boolean)])];
      const reference = { ...source, pointer: row.pointer };
      const details = sanitizeDeliveryDetail(value);
      const relations = metadata ? metadata.relations : relationships(value, snapshot.project.slug, reference);
      const definition = { kind, name, description: first(value, ['description', 'summary', 'businessOutcome', 'outcome', 'businessResult']), details, relations, diagram: diagram(value, reference) };
      const assetId = metadata?.id ?? deliveryAssetId(snapshot.project.slug, kind, key);
      const payload = { assetId, ...definition, menuIds, menuPaths, batchIds: stage.batchId ? [stage.batchId] : [],
        sourceRevision: stage.sourceRevision, recordedAt: stage.recordedAt,
        ...(stage.sourceScope === 'taskspace-checkpoint' ? { sourceScope: stage.sourceScope } : {}),
        status: report ? 'recorded' : stage.status === 'historical' ? 'accepted' : stage.status,
        ...(report ? { sourceTopic: topic, sourcePhaseStatus: stage.status } : {}),
        certainty: metadata || explicitKey ? 'explicit' : 'unconfirmed', sources: [reference, ...(metadata?.sources ?? [])], commits: stage.commits, releaseIds: [],
        ...(metadata ? { revision: metadata.revision, recordType: metadata.recordType, nature: metadata.nature,
          contextId: metadata.contextId, adoption: metadata.adoption, functionRefs: metadata.functionRefs,
          menuRefs: metadata.menuRefs, menuApplicability: metadata.menuApplicability,
          ...(metadata.scope !== undefined ? { scope: metadata.scope } : {}) }
          : { recordType: report?.recordType ?? (string(value.recordType) || 'unknown'), nature: report?.nature ?? (string(value.nature) || 'unknown') }) };
      result.push({ kind: 'specification-asset', stageId: stage.stageId, releaseId: null, payload,
        documentCurrent: stage.documentCurrent === true });
    };
    for (const [topic, value] of Object.entries(stage.details)) {
      if (REPORT_TOPICS.has(topic) && object(value)) emit(REPORT_TOPICS.get(topic).kind, { value, key: '', pointer: `/${topic}` }, topic, REPORT_TOPICS.get(topic));
      else if (COLLECTIONS.has(topic)) for (const row of rows(value, `/${topic}`)) emit(COLLECTIONS.get(topic), row, topic);
    }
    const mode = stage.details.pageMode;
    if (object(mode)) {
      const explicitPages = mode.entry?.pages;
      if (Array.isArray(explicitPages)) for (const [index, value] of explicitPages.entries()) {
        const pageValue = object(value) ? value : { name: value };
        const name = first(pageValue, ['name', 'pageName', 'resourceName']);
        const menuPath = name ? [...parts(mode.entry?.group), name] : [];
        emit('page', { value: { ...pageValue, menuPath, pageMode: pageValue }, key: name, pointer: `/pageMode/entry/pages/${index}` }, '页面');
      }
      else emit('page', { value: { ...mode, name: first(mode, ['pageName', 'name']) || first(page, ['pageName', 'name']) || first(mode, ['route']) || '页面设计',
        fields: stage.details.fields ?? [], actions: stage.details.actions ?? [], states: stage.details.states ?? {},
        apiBindings: stage.details.apiBindings ?? [], permissionBindings: stage.details.permissionBindings ?? [] }, key: '', pointer: '/pageMode' }, '页面');
    }
    if (stage.details.pageImplementation) for (const row of rows(stage.details.pageImplementation, '/pageImplementation')) emit('page', row, '页面实现');
    // Explicit definitions may live inside any existing payload topic. The
    // marker supplies the kind; collection names never guess a function.
    for (const row of deliverySemanticRows(stage.details)) if (KINDS.has(row.metadata.kind)) emit(row.metadata.kind, row, row.metadata.kind);
  }
  const groups = new Map();
  for (const artifact of result) {
    const key = artifact.stageId ?? `document:${artifact.payload.sourceRevision}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(artifact);
  }
  const projected = [];
  for (const group of groups.values()) {
    const payloads = generateExplicitDiagrams(group.map(artifact => artifact.payload));
    for (const [index, value] of payloads.entries()) {
      const definition = { kind: value.kind, name: value.name, description: value.description, details: value.details, relations: value.relations, diagram: value.diagram };
      const payload = { ...value, revision: value.revision || deliveryAssetDigest(definition) };
      const id = `asset-version-${deliveryAssetDigest({ assetId: payload.assetId, sourceRevision: payload.sourceRevision, pointer: payload.sources[0]?.pointer, payload }).slice(0, 40)}`;
      const { documentCurrent, ...artifact } = group[index];
      if (documentCurrent) currentIds.add(id);
      if (!known.has(id)) { known.add(id); projected.push({ ...artifact, id, payload }); }
    }
  }
  snapshot.coverage.currentAssetVersionIds = [...currentIds].sort();
  return projected;
}

/** Explicit host-provided history packets are data, never Controller receipts. */
export function mergeDeliveryHistoryPackets(snapshot, packets = []) {
  const byId = Object.fromEntries(['menus', 'batches', 'requirements', 'artifacts'].map(key => [key, new Map(snapshot[key].map(item => [item.id, item]))]));
  const aliases = new Map(); const byPath = new Map(snapshot.menus.map(item => [JSON.stringify(item.path), item.id]));
  const explicit = (value, kind) => value?.kind === kind && value.schemaVersion === 1;
  const variants = value => Array.isArray(value.variants) && value.variants.length ? value.variants : [value];
  const unique = values => [...new Map(values.map(value => [deliveryAssetDigest(value), value])).values()];
  const observations = new Map(snapshot.menus.flatMap(menu => object(menu.runtimeObservation)
    ? [[menu.id, menu.runtimeObservation]] : !explicit(menu, 'menu') ? [[menu.id, menu]] : []));
  const mergeDefinitions = (previous, incoming) => {
    const versions = unique([...variants(previous), ...variants(incoming)])
      .sort((a, b) => deliveryAssetDigest(a).localeCompare(deliveryAssetDigest(b)));
    const selected = selectDeliverySemanticRevision(versions);
    const value = { ...selected.value, adoptionSelection: selected.selection,
      sources: unique(versions.flatMap(row => row.sources ?? [])),
      batchIds: [...new Set(versions.flatMap(row => row.batchIds ?? []))].sort(), variants: versions };
    if (selected.selection === 'unresolved') value.adoption = { state: 'unknown', sources: [], supersedes: [] };
    if (value.kind === 'menu') {
      const path = value.path ?? value.details?.menuPath ?? value.details?.path;
      value.path = Array.isArray(path) && path.length ? path : [value.name];
      value.parentRef ??= deliveryReference(value.details?.parentRef);
      value.parentId = value.parentId ?? value.parentRef?.id ?? (string(value.details?.parentId) || null);
      value.route = string(value.route) || string(value.details?.route);
      value.hierarchyStatus = Array.isArray(path) && path.length ? 'explicit' : 'unknown';
      if (value.parentId && !byId.menus.has(value.parentId) && !packetMenuIds.has(value.parentId)) {
        value.parentRef ??= { kind: 'menu', id: value.parentId, revision: null };
        value.parentId = null; value.hierarchyStatus = 'unknown';
      }
    }
    return value;
  };
  const packetMenuIds = new Set(); const packetPathIds = new Map();
  for (const packet of packets) if (Array.isArray(packet?.menus)) for (const menu of packet.menus) {
    if (!object(menu)) continue;
    packetMenuIds.add(menu.id);
    const pathKey = JSON.stringify(menu.path);
    if (!packetPathIds.has(pathKey)) packetPathIds.set(pathKey, new Set());
    packetPathIds.get(pathKey).add(menu.id);
  }
  const currentIds = new Set(snapshot.coverage.currentAssetVersionIds ?? []);
  snapshot.requirementVersions ??= [];
  for (const packet of packets) {
    if (!object(packet) || packet.schemaVersion !== 1 || packet.projectSlug !== snapshot.project.slug
      || !object(packet.source) || !string(packet.source.revision) || !string(packet.source.kind)) throw new Error('DELIVERY_HISTORY_PACKET_INVALID');
    for (const key of ['menus', 'batches', 'requirements', 'requirementVersions', 'assets']) if (packet[key] !== undefined && (!Array.isArray(packet[key]) || packet[key].length > 20000)) throw new Error('DELIVERY_HISTORY_PACKET_INVALID');
    for (const menu of packet.menus ?? []) {
      if (!string(menu.id) || !string(menu.name) || !Array.isArray(menu.path) || !menu.path.length) throw new Error('DELIVERY_HISTORY_PACKET_INVALID');
      const pathKey = JSON.stringify(menu.path); const oldId = byPath.get(pathKey);
      if (oldId && oldId !== menu.id && byId.menus.get(oldId)?.kind !== 'menu'
        && !packetMenuIds.has(oldId) && packetPathIds.get(pathKey)?.size === 1) {
        aliases.set(oldId, menu.id); byId.menus.delete(oldId);
      }
      const incoming = sanitizeDeliveryDetail(menu); const previous = byId.menus.get(menu.id);
      let definition = explicit(previous, 'menu') ? previous : null;
      if (explicit(incoming, 'menu')) {
        definition = definition ? mergeDefinitions(definition, incoming) : incoming;
        if (!observations.has(menu.id) && object(incoming.runtimeObservation)) observations.set(menu.id, incoming.runtimeObservation);
      } else observations.set(menu.id, { ...incoming,
        sources: unique([...(Array.isArray(incoming.sources) ? incoming.sources : []), sanitizeDeliveryDetail(packet.source)]),
        sourceRevision: string(packet.sourceCommit) || packet.source.revision,
        recordedAt: incoming.recordedAt ?? packet.recordedAt ?? null });
      const observed = observations.get(menu.id);
      if (definition && observed) {
        const sources = unique([...(definition.sources ?? []), ...(observed.sources ?? [])]);
        const adopted = definition.adoption?.state === 'adopted' && definition.adoption.sources?.length
          && definition.adoptionSelection === 'explicit-decision';
        // A proposed rename or move is readable in details/variants. It must not
        // rename a known menu in the navigation before an explicit decision.
        byId.menus.set(menu.id, { ...observed, ...definition,
          ...(!adopted ? { name: observed.name, path: observed.path, parentId: observed.parentId ?? null,
            route: observed.route ?? '', hierarchyStatus: 'implementation-observation' } : {}), sources,
          runtimeObservation: observed });
      } else byId.menus.set(menu.id, definition ?? incoming);
      byPath.set(pathKey, menu.id);
    }
    for (const key of ['batches', 'requirements']) for (const item of packet[key] ?? []) {
      if (!string(item.id)) throw new Error('DELIVERY_HISTORY_PACKET_INVALID');
      const incoming = sanitizeDeliveryDetail(item); const previous = byId[key].get(item.id);
      if (key === 'requirements' && explicit(incoming, 'requirement') && (!previous || explicit(previous, 'requirement'))) {
        if (previous) snapshot.requirementVersions.push(...variants(previous));
        snapshot.requirementVersions.push(...variants(incoming));
        byId[key].set(item.id, previous ? mergeDefinitions(previous, incoming) : incoming);
      } else {
        if (previous && deliveryAssetDigest(previous) !== deliveryAssetDigest(item)) throw new Error('DELIVERY_HISTORY_ID_CONFLICT');
        byId[key].set(item.id, incoming);
      }
    }
    for (const item of packet.assets ?? []) {
      if (!string(item.id) || item.kind !== 'specification-asset' || !object(item.payload) || !KINDS.has(item.payload.kind)
        || !string(item.payload.assetId) || !string(item.payload.revision) || !string(item.payload.sourceRevision)
        || !Array.isArray(item.payload.sources) || !item.payload.sources.length) throw new Error('DELIVERY_HISTORY_PACKET_INVALID');
      if (byId.artifacts.has(item.id) && deliveryAssetDigest(byId.artifacts.get(item.id)) !== deliveryAssetDigest(item)) throw new Error('DELIVERY_HISTORY_ID_CONFLICT');
      byId.artifacts.set(item.id, sanitizeDeliveryDetail(item));
    }
    for (const item of packet.requirementVersions ?? []) snapshot.requirementVersions.push(sanitizeDeliveryDetail(item));
    for (const id of packet.currentAssetVersionIds ?? []) {
      if (!byId.artifacts.has(id)) throw new Error('DELIVERY_HISTORY_CURRENT_INVALID'); currentIds.add(id);
    }
  }
  const alias = id => aliases.get(id) ?? id;
  for (const menu of byId.menus.values()) if (menu.parentId) menu.parentId = alias(menu.parentId);
  for (const requirement of byId.requirements.values()) requirement.menuId = alias(requirement.menuId);
  // Stage payload IDs must remain stable across packet availability changes.
  // Queries resolve aliases through this explicit mapping instead of rewriting immutable artifacts.
  snapshot.coverage.menuAliases = Object.fromEntries(aliases);
  snapshot.coverage.currentAssetVersionIds = [...currentIds].sort();
  snapshot.requirementVersions = unique(snapshot.requirementVersions);
  for (const key of Object.keys(byId)) snapshot[key] = [...byId[key].values()].sort((a, b) => a.id.localeCompare(b.id));
  return snapshot;
}
