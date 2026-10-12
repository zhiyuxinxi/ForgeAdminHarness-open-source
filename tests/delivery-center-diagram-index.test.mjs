import assert from 'node:assert/strict';
import test from 'node:test';
import { generateExplicitDiagrams, extractExplicitFlowChains, extractNamedEntityRelations, enrichDeliveryPacketDiagrams } from '../scripts/delivery-center-diagram-index.mjs';
import { generateExplicitRelationshipDiagram } from '../docker/harness/delivery-center-diagrams.mjs';

const source = { kind: 'git-document', sourcePath: 'changes/example/spec.md', sourceCommit: 'a'.repeat(40), line: 12 };
const base = { assetId: 'entity-person', kind: 'entity', name: '人员', description: '', menuIds: ['100'], menuPaths: [['人员管理']],
  batchIds: ['batch-1'], sourceRevision: 'a'.repeat(40), recordedAt: '2026-10-07T00:00:00Z', status: 'documented', certainty: 'explicit',
  sources: [source], relations: [], commits: [], releaseIds: [], diagram: null, revision: 'before', details: {} };

test('explicit reference diagrams retain sourced target identity and array conditions without inventing cardinality', () => {
  const relationSource = { path: 'service/Example.java', commit: 'b'.repeat(40), lines: '12-18' };
  const reference = { type: 'references', from: { kind: 'entity', id: base.assetId, revision: null },
    targetRef: { kind: 'entity', id: 'entity-source', revision: null }, sources: [relationSource],
    conditions: ['sourceId 可空', '同租户且未删除', '服务层限制一个来源对应零或一个记录；物理基数未知'] };
  const selected = { ...base, details: { relationships: [reference], attributes: [{ name: 'orgId' }] } };
  const original = JSON.stringify(selected);
  const diagram = generateExplicitRelationshipDiagram(selected);
  assert.equal(diagram.type, 'flowchart');
  assert.match(diagram.source, /R0\["人员 \(entity-person\) \/ before"\]/u);
  assert.match(diagram.source, /R1\["entity-source \/ 目标修订未明确"\]/u);
  assert.match(diagram.source, /R0 -->\|"引用（references） \/ sourceId 可空；同租户且未删除；服务层限制一个来源对应零或一个记录；物理基数未知"\| R1/u);
  assert.deepEqual(diagram.sourceRefs, [source, relationSource]);
  assert.match(diagram.notes, /1条引用关系（references）/u);
  assert.match(diagram.notes, /不推断基数或最小数量/u);
  assert.match(diagram.notes, /目标修订未明确，不加载目标最新版属性/u);
  assert.doesNotMatch(diagram.source + diagram.notes, /has-many|orgId|\|\|--|\}o--/u);
  assert.equal(JSON.stringify(selected), original, 'read-time diagram preserves the original record');

  const mixed = generateExplicitRelationshipDiagram({ ...selected, details: { relationships: [reference,
    { ...reference, targetRef: { ...reference.targetRef, revision: 'historical-r1' }, conditions: '指定历史身份' },
    { ...reference, type: 'has-many', targetRef: { kind: 'entity', id: 'entity-child', revision: 'child-r1' }, conditions: 'parent_id' },
    { ...reference, targetRef: { kind: 'entity', id: 'missing-source', revision: null }, sources: [] },
    { ...reference, targetRef: { kind: 'table', id: 'not-an-entity', revision: null } },
    { ...reference, type: 'unknown-type', targetRef: { kind: 'entity', id: 'unknown-relation', revision: null } },
  ] } });
  assert.equal((mixed.source.match(/R0 -->/gu) ?? []).length, 3);
  assert.match(mixed.source, /entity-source \/ historical-r1/u);
  assert.match(mixed.source, /has-many \/ parent_id/u);
  assert.match(mixed.notes, /1条 has-many 关系/u);
  assert.match(mixed.notes, /2条引用关系（references）/u);
  assert.doesNotMatch(mixed.source, /missing-source|not-an-entity|unknown-relation/u);
  assert.equal(generateExplicitRelationshipDiagram({ ...selected,
    details: { relationships: [{ ...reference, sources: [] }] } }), null);
  assert.equal(generateExplicitRelationshipDiagram({ ...selected,
    details: { relationships: Array(61).fill(reference) } }), null);
});

test('entity diagrams show explicit attributes without inventing a relation from an ID field', () => {
  const entity = { ...base, details: { attributes: [{ name: 'deptId', dataType: 'Long', description: '部门编号', source }, { name: 'name', dataType: 'String', description: '姓名', source }] } };
  const [projected] = generateExplicitDiagrams([entity]);
  assert.equal(projected.diagram.type, 'erDiagram');
  assert.match(projected.diagram.source, /Long deptId/);
  assert.doesNotMatch(projected.diagram.source, /--|\.\./);
  assert.match(projected.details.diagramNotes, /没有提供可绘制的关系与基数/);
  assert.equal(entity.diagram, null);
});

test('explicit entity cardinality and source are required before a relationship is drawn', () => {
  const entity = { ...base, details: { entities: [{ name: '应用', attributes: [] }, { name: '业务对象', attributes: [] }],
    logicalRelations: [{ from: '应用', to: '业务对象', cardinality: '多对多', label: '可复用', source }] } };
  const [projected] = generateExplicitDiagrams([entity]);
  assert.match(projected.diagram.source, /E0 }o--o\{ E1 : "可复用"/);
  assert.match(projected.details.diagramNotes, /最小数量仍待明确/);
  entity.details.logicalRelations[0].cardinality = null;
  assert.equal(generateExplicitDiagrams([entity])[0].diagram, null);
});

test('structured flow steps retain their source order and explicit conditional transitions', () => {
  const [linear] = generateExplicitDiagrams([{ ...base, kind: 'scene', details: { steps: ['提交', '审核', '完成'] } }]);
  assert.match(linear.diagram.source, /N0 --> N1\n  N1 --> N2/);
  const [branch] = generateExplicitDiagrams([{ ...base, kind: 'scene', details: { steps: [{ id: 'submit', name: '提交' }, { id: 'review', name: '审核' }],
    transitions: [{ from: 'review', to: 'submit', label: '驳回', source }] } }]);
  assert.match(branch.diagram.source, /N1 -->\|"驳回"\| N0/);
});

test('document chains preserve comma-separated rejection paths and ignore migrations and table mappings', () => {
  const chains = extractExplicitFlowChains('- 阶段流转：A→B→C→D；驳回：B/D 阶段→A（修改），D→C（选成员）。\n- 迁移流程：V1→V2\n| 数据关系 | user_id→user |');
  assert.deepEqual(chains.map(item => item.steps), [['A', 'B', 'C', 'D'], ['驳回：B/D 阶段', 'A（修改）'], ['D', 'C（选成员）']]);
  const relationships = extractNamedEntityRelations('| 应用对象关系 | 新增关联表 | 应用与可复用业务对象的多对多关系 |');
  assert.deepEqual(relationships.map(item => [item.from, item.to, item.cardinality]), [['应用', '可复用业务对象', '多对多']]);
  assert.deepEqual(extractNamedEntityRelations('| t_child | N:1 |'), []);
});

test('candidate packet enrichment updates immutable version IDs and current pointers without overwriting source objects', () => {
  const original = { id: 'entity-version-before', kind: 'specification-asset', stageId: null, releaseId: null,
    payload: { ...base, details: { attributes: [{ name: 'name', dataType: 'String', source }] } } };
  const req = { id: 'req-task', revision: 'v1', name: '目标任务 · 业务规则', menuId: '100', menuPath: ['人员管理'], batchIds: ['batch-1'],
    sources: [source], sourceCommit: 'a'.repeat(40), sourceRecordedAt: '2026-10-01T00:00:00Z',
    description: '- 任务状态机：进行中→提交→已完成；逾期→提交→已完成(逾期)。' };
  const packet = { assets: [original], currentAssetVersionIds: [original.id], requirements: [req], requirementVersions: [req], coverage: {} };
  const result = enrichDeliveryPacketDiagrams(packet);
  assert.equal(original.payload.diagram, null); assert.equal(original.id, 'entity-version-before');
  assert.equal(result.assets.length, 2); assert.equal(result.currentAssetVersionIds.length, 2);
  assert.ok(!result.currentAssetVersionIds.includes(original.id));
  assert.deepEqual(result, enrichDeliveryPacketDiagrams(packet));
  assert.deepEqual(result, enrichDeliveryPacketDiagrams(result));
  const flow = result.assets.find(item => item.payload.kind === 'scene');
  assert.equal((flow.payload.diagram.source.match(/\["提交"\]/g) ?? []).length, 2);
  assert.equal(flow.payload.diagram.sourceRefs[0].sourceCommit, req.sourceCommit);
  assert.equal(result.coverage.diagramProjection.currentFlowDiagrams, 1);
});

test('bundled Mermaid grammar accepts generated ER source without claiming browser rendering', async () => {
  const { default: mermaid } = await import('../docker/harness/conversation-gateway/mermaid/mermaid.esm.min.mjs');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  const assets = generateExplicitDiagrams([{ ...base, details: { attributes: [{ name: 'name', dataType: 'String', description: '姓名', source }] } }]);
  assert.ok(await mermaid.parse(assets[0].diagram.source));
});
