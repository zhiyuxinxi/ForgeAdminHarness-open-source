import assert from 'node:assert/strict';
import test from 'node:test';
import { projectDeliverySnapshot, deliverySnapshotDigest } from '../docker/harness/delivery-center-projection.mjs';
import { validateDeliverySnapshot } from '../docker/harness/delivery-center-store.mjs';

const NOW = '2026-10-07T03:00:00.000Z';
const PROJECT = { projectSlug: 'menu-example', projectName: '菜单示例', observedAt: NOW };
const seal = (value, key) => ({ ...value, [key]: deliverySnapshotDigest(value) });
function artifact(artifactKind, phaseId, payload) {
  return seal({ schemaVersion: 'forge-delivery-phase-artifact/v1', workflowId: 'crud-production',
    artifactKind, phaseId, sourceFingerprint: 'b'.repeat(64), payload }, 'artifactDigest');
}
function project(artifacts) {
  const state = seal({ schemaVersion: 'forge-delivery-phase-state/v2', taskId: 'task-menu', workflowId: 'crud-production',
    sessionId: 'session-menu', sourceCommit: 'a'.repeat(40), status: 'active', currentPhaseId: 'backend',
    createdAt: NOW, updatedAt: NOW,
    acceptedArtifacts: Object.fromEntries(artifacts.map(item => [item.artifactKind, item.artifactDigest])),
    history: artifacts.map(item => ({ phaseId: item.phaseId, artifactDigest: item.artifactDigest, decision: 'accepted', completedAt: NOW })),
  }, 'stateDigest');
  return projectDeliverySnapshot({ ...PROJECT, records: [{ state, artifacts, depth: 0, isCurrent: true }] });
}

test('matching accepted single-page routes bind the explicit parent chain and retain grouped UI fields', () => {
  const req = artifact('requirements-contract', 'requirements', {
    useCases: [{ id: 'UC-01', name: '查看名录', businessOutcome: '查看本组织有效档案', trigger: '从名录页面进入', mainFlow: '按条件查询并打开详情' }],
    permissionMatrix: { businessPage: { pageName: '合作方名录', route: '/business/partners', parentResource: { name: '业务应用', parentChain: '应用中心 → 业务应用' } } },
  });
  const uiPayload = {
    pageMode: { pageType: 'standard-crud', route: '/business/partners', menuComponent: 'business/partners', parentMenu: { name: '业务应用', parentChain: '应用中心 → 业务应用' } },
    fields: { searchFields: [{ name: 'name', label: '名称' }], tableColumns: [{ field: 'name', label: '名称' }], editFields: [{ field: 'code', required: true }] },
    actions: { toolbarActions: [{ name: '新增' }], rowActions: [{ name: '查看' }] },
  };
  const ui = artifact('ui-interaction-contract', 'ui-design', uiPayload);
  const snapshot = project([req, ui]);
  assert.equal(snapshot.menus.length, 3);
  assert.deepEqual(snapshot.requirements[0].menuPath, ['应用中心', '业务应用', '合作方名录']);
  assert.equal(snapshot.requirements[0].page, '合作方名录');
  assert.match(snapshot.requirements[0].description, /查看本组织有效档案\n触发条件：从名录页面进入\n主要流程：按条件查询并打开详情/u);
  assert.equal(snapshot.requirements[0].fields.find(group => group.name === 'searchFields').items[0].label, '名称');
  assert.equal(snapshot.requirements[0].fields.find(group => group.name === 'editFields').items[0].required, true);
  assert.equal(snapshot.requirements[0].actions.find(group => group.name === 'rowActions').items[0].name, '查看');
  assert.equal(snapshot.requirements[0].stageStatus['ui-design'], 'accepted');
  assert.equal(snapshot.coverage.unmappedRequirements, 0);
  validateDeliverySnapshot(snapshot);

  const mismatchedRoute = artifact('ui-interaction-contract', 'ui-design', { ...uiPayload, pageMode: { ...uiPayload.pageMode, route: '/unrelated' } });
  const unbound = project([req, mismatchedRoute]);
  assert.deepEqual(unbound.requirements[0].menuPath, ['未分类需求']);
  assert.equal(unbound.requirements[0].fields.length, 0);
  assert.equal(unbound.requirements[0].stageStatus['ui-design'], undefined);
});

test('multi-page entry groups create every named menu without guessing feature pages or spilling grouped fields', () => {
  const req = artifact('requirements-contract', 'requirements', {
    useCases: [{ id: 'UC-01', name: '维护设施', outcome: '维护已有记录' }, { id: 'UC-02', name: '登记检查', outcome: '保存检查结果' },
      { id: 'UC-03', name: '查看审批', page: '审批管理', outcome: '查看明确指定页面' }],
  });
  const ui = artifact('ui-interaction-contract', 'ui-design', {
    pageMode: { entry: { group: '设施管理', pages: ['设施台账', '审批管理'] }, modes: { equipmentPage: '标准列表', approvalPage: '审批工作区' } },
    fields: { equipmentPage: { search: ['name 名称'], list: ['code 编号'], form: ['code 必填'], detailOnly: ['audit 审计信息'], password: 'do-not-show' },
      approvalPage: { form: ['comment 审批意见'] } },
  });
  const access = artifact('access-wiring-implementation', 'access-wiring', { menuSeed: { directory: { resourceName: '设施管理', path: '/equipment' }, pageCount: 2, components: ['equipment/list', 'equipment/approval'] } });
  const snapshot = project([req, ui, access]);
  assert.deepEqual(snapshot.menus.map(item => item.path.join(' / ')).sort(), ['设施管理', '设施管理 / 审批管理', '设施管理 / 设施台账'].sort());
  assert.equal(snapshot.requirements.length, 3);
  for (const row of snapshot.requirements.filter(item => item.name !== '查看审批')) {
    assert.deepEqual(row.menuPath, ['设施管理']); assert.equal(row.page, null); assert.deepEqual(row.fields, []);
    assert.equal(row.stageStatus['ui-design'], undefined);
  }
  const explicit = snapshot.requirements.find(item => item.name === '查看审批');
  assert.deepEqual(explicit.menuPath, ['设施管理', '审批管理']);
  assert.deepEqual(explicit.fields, []);
  const details = snapshot.stages.find(item => item.phaseId === 'ui-design' && item.isCurrent).details;
  assert.deepEqual(details.fields.equipmentPage.search, ['name 名称']);
  assert.deepEqual(details.fields.equipmentPage.detailOnly, ['audit 审计信息']);
  assert.equal(details.pageMode.modes.equipmentPage, '标准列表');
  assert.equal(details.pageMode.entry.group, '设施管理');
  assert.doesNotMatch(JSON.stringify(snapshot), /do-not-show/u);
  assert.equal(snapshot.coverage.unmappedRequirements, 0);
  validateDeliverySnapshot(snapshot);
});

test('explicit current menu definitions update the complete menu tree without requirement rows and never promote historical menus', () => {
  const old = artifact('access-wiring-implementation', 'access-wiring', { menuSeed: [{ id: 'OLD', resourceName: '已废弃旧菜单' }] });
  const current = artifact('access-wiring-implementation', 'access-wiring', { menuSeed: [
    { id: 'PAGE-B', parentId: 'ROOT-B', resourceName: '作业人员' },
    { id: 'ROOT-A', resourceName: '相关方' }, { id: 'ROOT-B', resourceName: '安全管理' },
    { id: 'PAGE-A', parentId: 'ROOT-A', resourceName: '作业人员' },
  ], menus: { EXTRA: { id: 'EXTRA', resourceName: '独立显式菜单' } } });
  const req = artifact('requirements-contract', 'requirements', { menus: { MATERIAL: { name: '材料管理', children: [{ name: '材料登记' }] } } });
  const ui = artifact('ui-interaction-contract', 'ui-design', { pageMode: { pageName: '证书管理', route: '/worker/certificates', parentMenu: { parentChain: '相关方 → 人员服务' } } });
  const value = project([old, current, req, ui]);
  assert.equal(value.requirements.length, 0);
  const paths = value.menus.map(menu => menu.path.join('/'));
  for (const expected of ['相关方/作业人员', '安全管理/作业人员', '独立显式菜单', '材料管理/材料登记', '相关方/人员服务/证书管理']) assert.ok(paths.includes(expected), expected);
  assert.ok(!paths.includes('已废弃旧菜单'));
  assert.equal(value.stages.find(stage => stage.digest === old.artifactDigest).isCurrent, false);
  const workers = value.menus.filter(menu => menu.name === '作业人员');
  assert.equal(workers.length, 2); assert.notEqual(workers[0].id, workers[1].id);
  assert.notEqual(workers[0].parentId, workers[1].parentId);
  const again = project([old, current, req, ui]);
  assert.deepEqual(again.menus, value.menus);
  validateDeliverySnapshot(value);
});
