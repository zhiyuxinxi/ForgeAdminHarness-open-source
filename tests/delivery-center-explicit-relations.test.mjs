import assert from 'node:assert/strict';
import test from 'node:test';
import { withExplicitRelationDetails } from '../docker/harness/delivery-center-assets.mjs';
import { DeliveryCenterStore } from '../docker/harness/delivery-center-store.mjs';

const source = { path: 'mapper/AccidentInvestigateMapper.xml', lines: '5-90', commit: 'a'.repeat(40) };
const root = { kind: 'entity', id: 'accident.entity.investigation', revision: null };
const report = { kind: 'entity', id: 'accident.entity.report', revision: null };
const table = { kind: 'table', id: 'accident.table.investigation', revision: null };
const reference = { id: 'investigation-report', type: 'references', from: root, to: report,
  conditions: ['reportId 可空；数据库层未见外键或唯一约束，物理基数保持未知'], sources: [source], revision: null };
const stored = { id: 'investigation-storage', type: 'stored-in', from: root, to: table,
  conditions: ['一条调查档案存储为 t_accident_investigate 一行'], sources: [source], revision: null };
function entity() {
  return { kind: 'entity', assetId: root.id, id: root.id, name: '事故调查档案', revision: 'spec-r1', versionId: 'selected-v1',
    adoption: { state: 'unknown' }, isCurrent: false, relations: [reference, stored], sources: [source],
    details: { attributes: [
      { name: 'reportId', storageColumn: 'report_id', businessMeaning: '可空的来源上报 ID；不是数据库外键' },
      { name: 'tab1-tab6', storageColumns: ['tab1', 'tab2', 'tab3', 'tab4', 'tab5', 'tab6'], businessMeaning: '六阶段状态' },
      { name: 'witnesses/interviews/otherEvidence/evidence', storageColumns: ['witnesses', 'interviews', 'other_evidence', 'evidence'], storageFormat: 'json', businessMeaning: '证据分区分别保存' },
      { name: 'unmapped', businessMeaning: '没有明确存储字段' },
    ] } };
}

test('selected accident detail projects explicit relationships and grouped storage fields without resolving targets or rewriting history', async () => {
  const selected = entity();
  const newer = { ...entity(), revision: 'spec-r2', versionId: 'newer-v2', details: { attributes: [] }, relations: [] };
  const artifact = (item, time) => ({ data: { id: item.versionId, kind: 'specification-asset', stageId: null, releaseId: null,
    payload: { ...item, menuIds: ['10144'], menuPaths: [], batchIds: ['checkpoint'], recordedAt: time, releaseIds: [] } } });
  const rows = [artifact(selected, '2026-10-08T00:00:00Z'), artifact(newer, '2026-10-09T00:00:00Z')];
  const before = structuredClone(rows); const calls = [];
  const pool = { async execute(sql, parameters) {
    calls.push({ sql, parameters }); assert.match(sql, /^SELECT /u);
    if (sql.includes('SELECT coverage')) return [[{ coverage: { currentAssetVersionIds: ['newer-v2'] } }]];
    if (sql.includes('FROM delivery_center_menus')) return [[]];
    if (sql.includes('FROM delivery_center_artifacts a')) return [rows];
    throw new Error(`unexpected query: ${sql}`);
  }, getConnection() {} };
  const detail = await new DeliveryCenterStore({ pool }).getAsset('forge-base', root.id, { revision: 'selected-v1' });
  assert.equal(detail.versionId, 'selected-v1'); assert.equal(detail.revision, 'spec-r1'); assert.equal(detail.isCurrent, false);
  assert.deepEqual(detail.adoption, { state: 'unknown' });
  assert.deepEqual(detail.details.relationships, [{ ...reference, name: 'references', targetRef: report }]);
  assert.equal(detail.details.relationships[0].cardinality, undefined);
  assert.equal(detail.details.relationships[0].physicalForeignKey, undefined);
  const mappings = detail.details.modelMappings;
  assert.equal(mappings.length, 4, 'One object mapping plus three explicit attribute groups.');
  assert.deepEqual(mappings[0].entity, root); assert.deepEqual(mappings[0].table, table);
  assert.equal(mappings[1].businessAttribute, 'reportId'); assert.equal(mappings[1].field, 'report_id');
  assert.deepEqual(mappings[2].field, ['tab1', 'tab2', 'tab3', 'tab4', 'tab5', 'tab6']);
  assert.equal(mappings[2].businessAttribute, 'tab1-tab6');
  assert.equal(mappings[3].businessAttribute, 'witnesses/interviews/otherEvidence/evidence');
  assert.deepEqual(mappings[3].field, ['witnesses', 'interviews', 'other_evidence', 'evidence']);
  assert.equal(mappings[3].storageMode, 'json');
  assert.ok(mappings.every(row => row.sources.length && row.table.revision === null));
  assert.deepEqual(rows, before, 'Persisted inputs and historical payloads remain byte-equivalent objects.');
  assert.equal(detail.revisions.find(row => row.versionId === 'selected-v1').details.relationships, undefined);
  assert.equal(calls.some(call => call.parameters?.includes(report.id) || call.parameters?.includes(table.id)), false,
    'Unknown relation target revisions must not be replaced with a latest-target query.');
  assert.deepEqual(withExplicitRelationDetails(detail), detail, 'The read projection is idempotent.');
});

test('detail projection retains supplied rows and refuses unsourced, foreign-root and ambiguous table-field associations', () => {
  const current = entity();
  const existingRelationship = { ...reference, name: '原有关系说明' };
  const existingMapping = { businessAttribute: 'original', field: 'original_column', sources: [source] };
  current.details.relationships = [existingRelationship]; current.details.modelMappings = [existingMapping];
  current.relations.push({ ...reference, id: 'foreign', from: { ...root, id: 'other.entity' } },
    { ...reference, id: 'other-revision', from: { ...root, revision: 'spec-r0' } },
    { ...reference, id: 'unsourced', sources: [] },
    { ...reference, id: 'empty-source', sources: [{}] },
    { ...stored, id: 'other-table', to: { ...table, id: 'another.table' } });
  const before = structuredClone(current);
  const projected = withExplicitRelationDetails(current);
  assert.deepEqual(projected.details.relationships, [existingRelationship]);
  assert.equal(projected.details.modelMappings.length, 3);
  assert.deepEqual(projected.details.modelMappings[0], existingMapping);
  assert.ok(projected.details.modelMappings.slice(1).every(row => row.field === undefined),
    'Multiple stored-in targets preserve object relations without guessing field ownership.');
  assert.deepEqual(current, before);
  const ambiguousRevision = entity();
  ambiguousRevision.relations.push({ ...stored, id: 'same-table-different-revision', to: { ...table, revision: 'table-r2' } });
  assert.ok(withExplicitRelationDetails(ambiguousRevision).details.modelMappings.every(row => row.field === undefined));
  const noRelations = entity(); noRelations.relations = [];
  assert.equal(withExplicitRelationDetails(noRelations), noRelations, 'Attribute declarations alone do not imply a table.');
});
