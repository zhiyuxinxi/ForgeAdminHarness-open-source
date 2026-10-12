import { createHash } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = value => Array.isArray(value) ? value : [];
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const safeLabel = value => String(value ?? '').replace(/<[^>]*>/gu, '').replace(/["<>\r\n\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim();
const safeWord = (value, fallback) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(String(value ?? '')) ? String(value) : fallback;
const uniqueSources = sources => [...new Map(sources.filter(object).map(source => [hash(source), source])).values()];
const sourceRefs = asset => uniqueSources(array(asset.sources));

/** Read-time identity relationships from the selected record; never resolve another revision. */
export function generateExplicitRelationshipDiagram(asset) {
  if (asset?.kind !== 'entity') return null;
  const relationships = array(asset.details?.relationships);
  if (!relationships.length || relationships.length > 60) return null;
  const rootId = asset.assetId ?? asset.id;
  if (typeof rootId !== 'string' || !rootId || rootId.length > 191) return null;
  const label = (value, maximum = 180) => {
    const clean = safeLabel(value).replace(/[\[\]{}|`;\\]/gu, ' ');
    return clean.length > maximum ? `${clean.slice(0, maximum - 1)}…` : clean;
  };
  const rootRevision = typeof asset.revision === 'string' ? asset.revision : null;
  const nodes = new Map([[JSON.stringify([rootId, rootRevision]), { id: 'R0',
    label: label(`${asset.name || rootId} (${rootId}) / ${rootRevision || '自身修订未明确'}`, 420) }]]);
  const edges = [], sources = sourceRefs(asset);
  let unknownRevision = false;
  for (const relationship of relationships) {
    const ref = relationship?.targetRef;
    const evidence = array(relationship?.sources).filter(object);
    if (!object(ref) || ref.kind !== 'entity' || typeof ref.id !== 'string' || !ref.id
      || ref.id.length > 191 || !['has-many', 'references'].includes(relationship.type) || !evidence.length
      || (ref.revision != null && (typeof ref.revision !== 'string' || !ref.revision || ref.revision.length > 191))) continue;
    const revision = ref.revision ?? null;
    const key = JSON.stringify([ref.id, revision]);
    if (!nodes.has(key)) {
      if (nodes.size >= 30) return null;
      nodes.set(key, { id: `R${nodes.size}`, label: label(`${typeof ref.name === 'string' ? `${ref.name} (${ref.id})` : ref.id} / ${revision || '目标修订未明确'}`, 420) });
    }
    unknownRevision ||= revision === null;
    const conditions = typeof relationship.conditions === 'string' ? relationship.conditions
      : array(relationship.conditions).filter(value => typeof value === 'string').join('；');
    const typeLabel = relationship.type === 'references' ? '引用（references）' : 'has-many';
    edges.push({ to: nodes.get(key).id, type: relationship.type, label: label(`${typeLabel}${conditions ? ` / ${conditions}` : ''}`, 800) });
    sources.push(...evidence);
  }
  if (!edges.length || sources.length > 180) return null;
  const source = ['flowchart LR', ...[...nodes.values()].map(node => `  ${node.id}["${node.label}"]`),
    ...edges.map(edge => `  R0 -->|"${edge.label}"| ${edge.to}`)].join('\n');
  if (source.length > 30000) return null;
  const hasManyCount = edges.filter(edge => edge.type === 'has-many').length;
  const referenceCount = edges.length - hasManyCount;
  const relationshipNotes = [
    ...(hasManyCount ? [`${hasManyCount}条 has-many 关系，只表达声明方向与多侧，不确定双方完整基数或最小数量。`] : []),
    ...(referenceCount ? [`${referenceCount}条引用关系（references），只表达声明的引用方向，不推断基数或最小数量。`] : []),
  ].join('');
  return { type: 'flowchart', source, sourceRefs: uniqueSources(sources),
    notes: `图中显示原文明确的${relationshipNotes}以上关系均不表示物理外键。${unknownRevision ? '目标修订未明确，不加载目标最新版属性。' : '目标仅按原文引用身份与修订显示，不加载其属性。'}图中文字有长度上限，完整条件与来源保留在关系详情。` };
}

function flowDiagram(asset, { navigation = false } = {}) {
  const steps = array(asset.details?.steps);
  const transitions = array(asset.details?.transitions);
  if (!steps.length && !transitions.length) return null;
  const nodes = new Map(), edges = [], sources = sourceRefs(asset);
  const hasSource = value => sourceRefs(asset).length > 0 || uniqueSources([...array(value?.sources), value?.source]).length > 0;
  const node = (key, name = key, target = null) => {
    const identifier = String(key ?? ''); const label = safeLabel(name);
    if (!identifier || !label || label.length > 180) return null;
    if (!nodes.has(identifier)) nodes.set(identifier, { id: `N${nodes.size}`, label, steps: new Map(), transitions: new Map() });
    const selected = nodes.get(identifier);
    if (target) selected[target.kind].set(target.localId, target);
    return selected.id;
  };
  for (const [index, step] of steps.entries()) {
    const value = typeof step === 'string' ? { id: index, name: step } : step;
    if (!object(value)) return null;
    node(value.id ?? value.key ?? index, value.name ?? value.label ?? value.description,
      { kind: 'steps', localId: `/details/steps/${index}`, sourced: hasSource(value) });
    if (value.source) sources.push(value.source);
  }
  if (transitions.length) {
    for (const [index, transition] of transitions.entries()) {
      if (!object(transition)) continue;
      const target = { kind: 'transitions', localId: `/details/transitions/${index}`, sourced: hasSource(transition) };
      const from = node(transition.from, transition.fromLabel ?? transition.from, target);
      const to = node(transition.to, transition.toLabel ?? transition.to, target);
      if (!from || !to) continue;
      edges.push({ from, to, label: safeLabel(transition.label ?? transition.condition ?? '') });
      if (transition.source) sources.push(transition.source);
    }
  } else {
    const values = [...nodes.values()];
    for (let index = 1; index < values.length; index++) edges.push({ from: values[index - 1].id, to: values[index].id, label: '' });
  }
  if (!edges.length || nodes.size > 120 || edges.length > 180 || sources.length === 0) return null;
  const source = ['flowchart TD', ...[...nodes.values()].map(item => `  ${item.id}["${item.label}"]`),
    ...edges.map(edge => `  ${edge.from} -->${edge.label ? `|"${edge.label}"|` : ''} ${edge.to}`)].join('\n');
  const nodeTargets = [...nodes.values()].flatMap(value => {
    const positions = value.steps.size ? value.steps : value.transitions;
    const [target] = positions.values();
    return positions.size === 1 && target.sourced ? [{ nodeId: value.id, localId: target.localId, label: value.label }] : [];
  });
  return source.length <= 30000 ? { type: 'flowchart', source, sourceRefs: uniqueSources(sources), ...(navigation ? { nodeTargets } : {}) } : null;
}

/** Transient reading projection: original diagram bytes and record revisions stay unchanged. */
export function withFlowDiagramNavigation(asset) {
  if (asset.diagram == null && ['scene', 'task'].includes(asset.kind)) {
    const generated = flowDiagram(asset, { navigation: true });
    return generated ? { ...asset, diagram: generated } : asset;
  }
  if (!object(asset.diagram)) return asset;
  const { nodeTargets: _untrusted, ...diagram } = asset.diagram;
  const generated = ['scene', 'task'].includes(asset.kind) && diagram.type === 'flowchart'
    ? flowDiagram(asset, { navigation: true }) : null;
  return { ...asset, diagram: { ...diagram,
    ...(generated?.source === diagram.source ? { nodeTargets: generated.nodeTargets } : {}) } };
}

// A named cardinality must come from a source. Attribute names such as *_id
// never contribute edges. Generic N only states a many side; minimum cardinality
// stays explicitly undocumented in the displayed source notes.
const CARDINALITY = new Map([
  ['1:1', '||--||'], ['一对一', '||--||'], ['1:N', '||--o{'], ['一对多', '||--o{'],
  ['N:1', '}o--||'], ['多对一', '}o--||'], ['N:N', '}o--o{'], ['多对多', '}o--o{'],
  ['ONE-TO-ONE', '||--||'], ['ONE-TO-MANY', '||--o{'], ['MANY-TO-ONE', '}o--||'], ['MANY-TO-MANY', '}o--o{'],
  ['1:0..*', '||--o{'], ['1:1..*', '||--|{'], ['0..*:0..*', '}o--o{'],
]);
function entityDiagram(asset, assetsById) {
  const entities = array(asset.details?.entities);
  const attributes = array(asset.details?.attributes);
  const root = { name: asset.name, attributes };
  const definitions = entities.length ? entities : [root];
  const logical = array(asset.details?.logicalRelations);
  const nodes = new Map(), edges = [], sources = sourceRefs(asset);
  const node = (key, definition) => {
    if (!key || !object(definition)) return null;
    if (!nodes.has(key)) nodes.set(key, { id: `E${nodes.size}`, definition });
    return nodes.get(key).id;
  };
  for (const definition of definitions) node(definition.id ?? definition.name, definition);
  for (const relation of [...logical, ...array(asset.relations)]) {
    if (!relation?.source || !CARDINALITY.has(String(relation.cardinality ?? '').toUpperCase()) && !CARDINALITY.has(relation.cardinality)) continue;
    const target = relation.targetId ? assetsById.get(relation.targetId) : null;
    if (relation.targetId && target?.kind !== 'entity') continue;
    const fromKey = relation.from ?? (entities.length ? null : asset.name);
    const toKey = relation.to ?? target?.name;
    const from = nodes.get(fromKey)?.id;
    const to = nodes.get(toKey)?.id ?? (target ? node(toKey, { name: target.name, attributes: array(target.details?.attributes) }) : null);
    if (!from || !to) continue;
    edges.push({ from, to, marker: CARDINALITY.get(String(relation.cardinality).toUpperCase()) ?? CARDINALITY.get(relation.cardinality),
      label: safeLabel(relation.label ?? relation.cardinality), cardinality: relation.cardinality });
    sources.push(relation.source);
  }
  if (!nodes.size || nodes.size > 30 || sources.length === 0 || (!edges.length && ![...nodes.values()].some(value => array(value.definition.attributes).length))) return null;
  const lines = ['erDiagram'];
  for (const { id, definition } of nodes.values()) {
    const fields = array(definition.attributes);
    if (fields.length > 150) return null;
    lines.push(`  ${id}["${safeLabel(definition.name)}"] {`);
    for (const [index, field] of fields.entries()) {
      if (!object(field)) continue;
      const type = safeWord(field.dataType ?? field.type, 'value');
      const name = safeWord(field.name ?? field.field, `attribute_${index + 1}`);
      const description = safeLabel(field.description ?? field.label ?? field.name);
      lines.push(`    ${type} ${name}${field.primaryKey === true ? ' PK' : ''}${description ? ` "${description}"` : ''}`);
      if (field.source) sources.push(field.source);
    }
    lines.push('  }');
  }
  for (const edge of edges) lines.push(`  ${edge.from} ${edge.marker} ${edge.to} : "${edge.label}"`);
  const source = lines.join('\n');
  if (source.length > 30000) return null;
  return { type: 'erDiagram', source, sourceRefs: uniqueSources(sources),
    notes: edges.length ? '关系方向及一/多类型来自原文；原文未约束的最小数量仍待明确，图示不表示数据库物理外键。'
      : '本图仅展示来源明确的实体属性；来源没有提供可绘制的关系与基数，不能据此判断实体没有业务关联。' };
}

/** Read-only projection of explicit structured steps and entity definitions. */
export function generateExplicitDiagrams(assets) {
  const byId = new Map(assets.map(asset => [asset.assetId, asset]));
  return assets.map(asset => {
    if (asset.diagram) return asset;
    const diagram = asset.kind === 'scene' ? flowDiagram(asset) : asset.kind === 'entity' ? entityDiagram(asset, byId) : null;
    return diagram ? { ...asset, diagram, details: { ...asset.details, ...(diagram.notes ? { diagramNotes: diagram.notes } : {}) } } : asset;
  });
}

export function extractExplicitFlowChains(text) {
  const chains = []; let fenced = false;
  for (const [lineIndex, raw] of String(text ?? '').split(/\r?\n/u).entries()) {
    if (/^\s*```/u.test(raw)) { fenced = !fenced; continue; }
    if (fenced || raw.trim().startsWith('|') || !raw.includes('→')) continue;
    const line = raw.replace(/^\s*(?:[-*>]\s*|\d+[.、]\s*)+/u, '').replace(/\*\*/gu, '').trim();
    const match = line.match(/^([^：:]{1,48}(?:流程|流转|状态机|动作|交互|路径)[^：:]{0,8})[：:]\s*(.+)$/u);
    if (!match || /开发|构建|迁移|排查|调试|测试|验证|执行顺序/u.test(match[1])) continue;
    const description = match[2].split('。')[0];
    for (const branch of description.split(/[；;，,]/u)) {
      const steps = branch.split('→').map(value => safeLabel(value.replace(/`/gu, '').trim())).filter(Boolean);
      if (steps.length < 2 || steps.length > 20 || steps.some(step => step.length > 150 || /(?:https?:|\/api\/|HTTP|SELECT\s|UPDATE\s)/iu.test(step))) continue;
      chains.push({ title: safeLabel(match[1]), steps, lineOffset: lineIndex + 1, quote: raw.trim() });
    }
  }
  return chains;
}

export function extractNamedEntityRelations(text) {
  const found = [];
  for (const [lineIndex, raw] of String(text ?? '').split(/\r?\n/u).entries()) {
    for (const match of raw.matchAll(/(?:^|[|；。])\s*(?:\d+[.、]\s*)?([^,，:：|;；。]{1,25}?)与([^,，:：|;；。]{1,25}?)(?:的|使用)(一对一|一对多|多对一|多对多)(?:关系|关联)/gu)) {
      found.push({ from: safeLabel(match[1]), to: safeLabel(match[2]), cardinality: match[3], lineOffset: lineIndex + 1, quote: raw.trim() });
    }
  }
  return found;
}

function withVersion(payload) {
  const { revision: ignored, ...base } = payload;
  const revised = { ...base, revision: hash(base) };
  return { id: `spec-${hash([revised.assetId, revised.revision])}`, kind: 'specification-asset', stageId: null, releaseId: null, payload: revised };
}

/** Enrich a candidate import packet; never edit its business source documents. */
export function enrichDeliveryPacketDiagrams(packet) {
  const current = new Set(array(packet.currentAssetVersionIds));
  const heads = new Set();
  const augmented = generateExplicitDiagrams(array(packet.assets).map(artifact => artifact.payload));
  const assets = array(packet.assets).map((artifact, index) => {
    const changed = augmented[index] !== artifact.payload;
    const next = changed ? { ...withVersion(augmented[index]), stageId: artifact.stageId ?? null, releaseId: artifact.releaseId ?? null } : artifact;
    if (current.has(artifact.id)) heads.add(next.id);
    return next;
  });
  const currentRequirements = new Set(array(packet.requirements).map(item => `${item.id}:${item.revision}`));
  const requirements = new Map([...array(packet.requirementVersions), ...array(packet.requirements)].map(item => [`${item.id}:${item.revision}`, item]));
  let flowChains = 0, sourceRelations = 0;
  for (const requirement of requirements.values()) {
    const section = requirement.originalDocument?.section ?? requirement.name?.split(' · ').at(-1) ?? '';
    const flows = /测试策略|代码现状|执行顺序/u.test(section) ? [] : extractExplicitFlowChains(requirement.description);
    const relations = extractNamedEntityRelations(requirement.description);
    if (!flows.length && !relations.length) continue;
    const base = { name: requirement.name, description: requirement.description, menuIds: requirement.menuIds ?? (requirement.menuId ? [requirement.menuId] : []),
      menuPaths: requirement.menuPaths ?? (requirement.menuPath?.length ? [requirement.menuPath] : []), batchIds: requirement.batchIds ?? [],
      sourceRevision: requirement.sourceCommit ?? requirement.revision, recordedAt: requirement.sourceRecordedAt ?? null,
      status: 'documented', certainty: 'explicit', sources: requirement.sources ?? [], commits: requirement.commits ?? [], releaseIds: [], relations: [], diagram: null };
    const source = (item) => ({ ...base.sources[0], sectionLine: item.lineOffset, quotedText: item.quote, label: '原需求章节中的明确关系或顺序' });
    if (flows.length) {
      // Separate source chains remain separate: merging repeated action labels
      // such as "提交" would invent paths between unrelated branches.
      const transitions = flows.flatMap((flow, branch) => flow.steps.slice(1).map((to, index) => ({ from: `chain-${branch}-${index}`, to: `chain-${branch}-${index + 1}`,
        fromLabel: flow.steps[index], toLabel: to, source: source(flow) })));
      const payload = generateExplicitDiagrams([{ ...base, assetId: `${requirement.id}:flow`, kind: 'scene',
        details: { definitionType: 'explicit-source-flow', transitions, flowChains: flows.map(flow => ({ title: flow.title, steps: flow.steps, source: source(flow) })) } }])[0];
      if (payload.diagram) { const artifact = withVersion(payload); assets.push(artifact); flowChains += flows.length;
        if (currentRequirements.has(`${requirement.id}:${requirement.revision}`)) heads.add(artifact.id); }
    }
    if (relations.length) {
      const names = [...new Set(relations.flatMap(relation => [relation.from, relation.to]))];
      const payload = generateExplicitDiagrams([{ ...base, assetId: `${requirement.id}:relations`, kind: 'entity',
        details: { definitionType: 'explicit-source-entity-relations', entities: names.map(name => ({ name, attributes: [] })),
          logicalRelations: relations.map(relation => ({ ...relation, label: relation.cardinality, source: source(relation) })) } }])[0];
      if (payload.diagram) { const artifact = withVersion(payload); assets.push(artifact); sourceRelations += relations.length;
        if (currentRequirements.has(`${requirement.id}:${requirement.revision}`)) heads.add(artifact.id); }
    }
  }
  const unique = [...new Map(assets.map(artifact => [artifact.id, artifact])).values()];
  return { ...packet, assets: unique, currentAssetVersionIds: [...heads], coverage: { ...packet.coverage,
    diagramProjection: { method: 'explicit-source-only', flowChains, sourceRelations,
      currentFlowDiagrams: unique.filter(item => heads.has(item.id) && item.payload.diagram?.type === 'flowchart').length,
      currentEntityDiagrams: unique.filter(item => heads.has(item.id) && item.payload.diagram?.type === 'erDiagram').length } } };
}
