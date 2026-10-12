import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoryPacket } from '../scripts/delivery-center-history-index.mjs';

test('historical source revisions, shared menu references and observed schema stay distinct', () => {
  const commit = 'a'.repeat(40), old = 'b'.repeat(40), file = 'code-copilot/changes/incident/spec.md';
  const current = '# 事故管理\n\n## 业务流程\n`forge-admin-ui/src/views/incident/report.vue`\n新规则\n```mermaid\nflowchart LR\n A[填写] --> B[审核]\n```';
  const packet = buildHistoryPacket({ projectSlug: 'forge-base', sourceCommit: commit, recordedAt: '2026-10-07T01:00:00Z',
    menuMetadata: { schema: 'business', items: [
      { id: '1', parentId: '0', name: '事故管理', resourceType: 1, status: 1 },
      { id: '2', parentId: '1', name: '上报', component: 'incident/report', resourceType: 2, status: 1 },
      { id: '3', parentId: '2', name: '提交', permission: 'report:submit', resourceType: 3, status: 1 } ] },
    schemaMetadata: { schema: 'business', tables: [{ name: 'incident', comment: '事故' }], columns: [
      { table: 'incident', name: 'id', type: 'bigint', nullable: 'NO', key: 'PRI' },
      { table: 'incident', name: 'title', type: 'varchar(100)', nullable: 'NO', comment: '事故标题' },
      { table: 'incident', name: 'created_at', type: 'datetime', nullable: 'YES' } ], indexes: [] },
    sourceCorpus: { files: [{ path: file, content: current, sha256: 'current' }] },
    documentHistory: { commits: [], documents: [
      { path: file, content: current, sha256: 'current', commit, committedAt: '2026-09-30T01:00:00Z' },
      { path: file, content: '# 事故管理\n\n## 业务流程\n旧规则', sha256: 'old', commit: old, committedAt: '2026-09-20T01:00:00Z' } ],
      audit: [{ commit, conversationId: 'conversation-1', taskId: 'task-1', status: 'success' }] } });
  assert.equal(packet.menus.length, 2);
  assert.equal(packet.requirements.length, 2);
  const requirement = packet.requirements.find(item => item.name.endsWith('业务流程'));
  assert.deepEqual(requirement.menuIds, ['forge-base:menu:1', 'forge-base:menu:2']);
  assert.equal(requirement.status, 'documented');
  assert.equal(requirement.granularity, 'specification-section');
  assert.equal(packet.requirementVersions.filter(item => item.id === requirement.id).length, 2);
  assert.equal(packet.batches.find(item => item.sourceCommit === commit).sessionId, 'conversation-1');
  const table = packet.assets.find(item => item.payload.kind === 'table').payload;
  assert.deepEqual(table.details.technicalFields, ['id', 'created_at']);
  assert.deepEqual(table.details.businessFields, ['title']);
  assert.equal(table.status, 'schema-observed');
  const diagram = packet.assets.find(item => item.payload.diagram)?.payload;
  assert.equal(diagram.diagram.type, 'flowchart');
  assert.deepEqual(diagram.releaseIds, []);
  assert.equal(diagram.recordedAt, '2026-09-30T01:00:00Z');
  const permission = packet.assets.find(item => item.payload.kind === 'permission').payload;
  assert.deepEqual(permission.menuIds, ['forge-base:menu:2']);
});

test('legacy parent cycle is visible without changing the source identity or losing menus', () => {
  const packet = buildHistoryPacket({ projectSlug: 'forge-base', sourceCommit: 'a'.repeat(40), recordedAt: '2026-10-07T00:00:00Z',
    menuMetadata: { items: [{ id: '1', parentId: '2', name: '一', resourceType: 1 }, { id: '2', parentId: '1', name: '二', resourceType: 2 }, { id: '3', parentId: '1', name: '三', resourceType: 2 }] },
    schemaMetadata: {}, sourceCorpus: {}, documentHistory: {} });
  assert.equal(packet.menus.length, 3);
  assert.equal(packet.menus[0].parentId, null);
  assert.equal(packet.menus[0].sourceParentId, '2');
  assert.match(packet.menus[0].hierarchyNote, /循环/);
  assert.deepEqual(packet.menus[2].path, ['一', '三']);
});
