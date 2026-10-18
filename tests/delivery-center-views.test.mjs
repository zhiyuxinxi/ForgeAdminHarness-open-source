import assert from 'node:assert/strict';
import test from 'node:test';
import { DeliveryCenterStore } from '../docker/harness/delivery-center-store.mjs';
import { generateExplicitRelationshipDiagram } from '../docker/harness/delivery-center-diagrams.mjs';
import { deliveryQuery, deliveryResponse } from '../docker/harness/delivery-center-http.mjs';
import { HEADER_KEYS, buildSubview, deliverySummary, requirementMatrix, matrixIdentityCounts, semanticMatch } from '../docker/harness/delivery-center-views.mjs';

const snapshotDigest = 'a'.repeat(64);

test('permission report subviews retain grouped source declarations without allowing authorization or production', () => {
  const source={taskId:'task-one',pointer:'/roleVisibilityContract',digest:'a'.repeat(64)};
  const contract={id:'contract-one',kind:'permission',name:'权限合同',revision:'contract-r1',recordType:'permission-contract',sourceTopic:'roleVisibilityContract',sources:[source],details:{
    APPLICANT:{displayNameZh:'申请人',canPerform:['submit'],dataScope:'OWN'},
    FIRE_MANAGEMENT:{displayNameZh:'消防管理岗位',canSee:['equipment']},
    taskHandlerRoles:{roleKeys:Array.from({length:12},(_,index)=>`ROLE_${index}`),canAct:['assigned task'],dataScope:'ASSIGNED'},
    denyRules:['no wildcard']}};
  const matrix=buildSubview('permission-matrix',[contract]);
  assert.equal(matrix.length,3);assert.equal(matrix[2].roleKeys.length,12);assert.match(matrix[2].subjectType,/角色组/);
  assert.deepEqual(matrix.map(row=>row.subject),['申请人','消防管理岗位','taskHandlerRoles']);
  for(const row of matrix){assert.equal(row.operation,null);assert.equal(row.decision,undefined);assert.equal(row.cells.length,1);assert.equal(row.cells[0].decision,null);assert.deepEqual(row.parentRef,{kind:'permission',id:'contract-one',revision:'contract-r1'});assert.equal(row.cells[0].ruleRef.localId,row.localId);assert.deepEqual(row.sources,[source]);}
  const implementation={id:'implementation-one',kind:'permission',name:'权限执行报告',revision:'implementation-r2',recordType:'permission-enforcement',sourceTopic:'permissionEnforcement',sources:[{...source,pointer:'/permissionEnforcement'}],details:{endpointRule:'Every endpoint binds its accepted permission',trustedContext:'TenantContextHolder and SessionHelper',dataScopes:{MANAGER:'AUTHORIZED'},assignedTaskRules:['persisted assignee']}};
  const rows=buildSubview('permission-evidence',[implementation]);assert.equal(rows.length,1);
  assert.equal(rows[0].locationType,'阶段实现声明');assert.equal(rows[0].target,implementation.details.endpointRule);assert.equal(rows[0].configuration,implementation.details.trustedContext);
  assert.equal(rows[0].localId,null);assert.deepEqual(rows[0].parentRef,{kind:'permission',id:'implementation-one',revision:'implementation-r2'});assert.equal(rows[0].sources[0].pointer,'/permissionEnforcement');
  for(const field of ['implementation','publication','verification'])assert.equal(rows[0][field],null);
  assert.match(rows[0].recordMeaning,/阶段产物中的声明/);assert.deepEqual(buildSubview('permission-evidence',[contract]),[]);
});

test('stage permission groups and receipt declarations preserve exact sources without inferred execution', () => {
  const parent = { id:'permission-source', kind:'permission', name:'权限来源', revision:'source-r1', recordType:'permission-contract', sourceTopic:'roleVisibilityContract', status:'recorded', sourcePhaseStatus:'accepted', sources:[{pointer:'/roleVisibilityContract'}], details:{
    APPLICANT:{displayNameZh:'申请人',canPerform:['submit own'],canSee:['own applications'],canAct:['assigned'],dataScope:'OWN'},
    taskHandlerRoles:{roleKeys:Array.from({length:12},(_,i)=>`ROLE_${i}`),canPerform:['matching assigned task'],dataScope:'ASSIGNED_TASKS'},
    BROKEN:{displayNameZh:'\ufffd\ufffd原名',canSee:['read']},denyRules:['no wildcard'] } };
  const rules=buildSubview('permission-rules',[parent]);
  assert.equal(rules.length,3);assert.equal(rules[0].subject,'申请人');assert.deepEqual(rules[0].canSee,['own applications']);assert.deepEqual(rules[0].canAct,['assigned']);
  assert.equal(rules[1].roleKeys.length,12);assert.match(rules[1].subjectType,/角色组/);assert.deepEqual(rules[1].denialConditions,['no wildcard']);
  assert.match(rules[2].sourceNameNote,/源名称异常/);assert.equal(rules[2].subject,'\ufffd\ufffd原名');
  assert.deepEqual(rules[1].parentRef,{kind:'permission',id:'permission-source',revision:'source-r1'});assert.equal(rules[1].localId,'/details/taskHandlerRoles');assert.equal(rules[1].decision,undefined);
  const enforcement={...parent,recordType:'permission-enforcement',details:{dataScopes:{'role/a':'OWN'},failClosedRules:['deny cross tenant'],assignedTaskRules:['persisted assignee']}};
  const scopes=buildSubview('permission-rules',[enforcement]);assert.equal(scopes[0].localId,'/details/dataScopes/role~1a');assert.deepEqual(scopes[0].taskConditions,['persisted assignee']);
  const report={id:'evidence',kind:'test',name:'后端测试原文',revision:'test-r1',recordType:'test-evidence-report',sourceTopic:'redTests',status:'recorded',sourcePhaseStatus:'accepted',sources:[{pointer:'/redTests'}],details:{
    receipts:[{profile:'compile',receiptId:'receipt-a',status:'passed',executed:3,passed:2,failed:0,skipped:1,reuse:'unchanged source'}],
    governance:{profile:'governance',receiptId:'receipt-b',status:'failed',truth:{releaseProven:false}},
    runtimeEvidenceReused:{receiptId:'receipt-c',notRevalidatedThisTurn:true},
    focusedTests:[{path:'Test.java',coverage:['approval']}],notYetProven:['live acceptance']}};
  const executions=buildSubview('test-executions',[report]);assert.equal(executions.length,3);
  assert.equal(executions[0].executionCounts,'3 / 2 / 0 / 1');assert.match(executions[0].executionKind,/非本次执行/);
  assert.equal(executions[1].executionStatus,'failed');assert.equal(executions[1].localId,'/details/governance');assert.equal(executions[1].parentRef.revision,'test-r1');
  assert.equal(executions[2].executionStatus,null);assert.equal(executions[2].profile,null);assert.match(executions[2].executionKind,/历史回执引用/);
  for(const item of executions){assert.match(item.recordMeaning,/未经本中心单独复核/);assert.equal(item.testedCommit,undefined);assert.equal(item.functionRefs,undefined);assert.equal(item.verification,undefined);}
  assert.deepEqual(buildSubview('test-cases',[report]),[]);assert.deepEqual(buildSubview('acceptance',[report]),[]);
  assert.equal(parent.details.taskHandlerRoles.roleKeys.length,12);assert.equal(report.details.focusedTests.length,1);
  assert.ok(HEADER_KEYS.includes('sourceTopic'));assert.ok(HEADER_KEYS.includes('sourcePhaseStatus'));
});

test('selected entity details derive sourced has-many identity diagrams without replacing ER or resolving target revisions', async () => {
  const source = { path: 'db/plan.sql', commit: 'unknown', locator: 'lines 54-61' };
  const entity = { id: 'plan-r1', kind: 'specification-asset', historical: true,
    payload: { assetId: 'plan.entity.dept-plan', kind: 'entity', name: '部门年度计划', revision: 'r1',
      recordedAt: '2026-10-07T00:00:00Z', menuIds: ['workers'], batchIds: ['iteration-one'],
      sources: [source], relations: [], details: { attributes: Array.from({ length: 9 }, (_, i) => ({ name: `field${i}` })),
        relationships: ['plan-item', 'approval-flow', 'plan-history'].map((name, i) => ({ type: 'has-many',
          targetRef: { kind: 'entity', id: `plan.entity.${name}`, revision: null },
          conditions: ['plan_type + plan_level + plan_id + version', 'parent_type=plan_hw/plan_sw + parent_id', 'plan_type + plan_id'][i], sources: [{ ...source, locator: `lines ${i + 1}-${i + 2}` }] })) },
      diagram: { type: 'erDiagram', source: 'erDiagram\n  PLAN {\n    string field0\n  }', sourceRefs: [source], notes: '原属性图保持' } } };
  const latest = structuredClone(entity); latest.id = 'plan-r2'; latest.historical = false;
  latest.payload.revision = 'r2'; latest.payload.recordedAt = '2026-10-09T00:00:00Z'; latest.payload.details.relationships = [];
  const target = structuredClone(latest); target.id = 'target-latest'; target.payload.assetId = 'plan.entity.plan-item';
  target.payload.details.attributes = [{ name: 'LATEST_TARGET_MUST_NOT_LOAD' }];
  const data = dataset(0); data.artifacts = [entity, latest, target]; const original = JSON.stringify(data);
  const { store, calls } = fakeStore(data);
  const response = await deliveryResponse({ method: 'GET',
    url: new URL('http://local/forge-gateway/api/delivery/assets/plan.entity.dept-plan?project=forge-base&revision=r1&detailMode=single'), store });
  const detail = response.body.item;
  assert.equal(detail.revision, 'r1'); assert.deepEqual(detail.diagram, entity.payload.diagram);
  assert.deepEqual(detail.details, entity.payload.details); assert.equal(detail.details.attributes.length, 9);
  assert.equal(detail.relationshipDiagram.type, 'flowchart');
  assert.equal((detail.relationshipDiagram.source.match(/R0 -->/gu) ?? []).length, 3);
  for (const relation of entity.payload.details.relationships) {
    assert.ok(detail.relationshipDiagram.source.includes(relation.targetRef.id));
    assert.ok(detail.relationshipDiagram.source.includes(relation.conditions));
    assert.ok(detail.relationshipDiagram.sourceRefs.some(row => row.locator === relation.sources[0].locator));
  }
  assert.match(detail.relationshipDiagram.source, /目标修订未明确/u);
  assert.match(detail.relationshipDiagram.notes, /不确定双方完整基数或最小数量/u);
  assert.doesNotMatch(detail.relationshipDiagram.source, /LATEST_TARGET|\|\|--|\}o--|1:N/u);
  assert.equal(calls.some(call => call.sql?.includes('a.id IN') && call.parameters.includes('target-latest')), false);
  assert.equal(JSON.stringify(data), original, 'read-time projection never mutates stored evidence');
  assert.equal((await store.getAsset('forge-base', entity.payload.assetId, { revision: 'r2', detailMode: 'single' })).relationshipDiagram, undefined);
  entity.payload.diagram = { type: 'flowchart', source: 'flowchart LR\n  A-->B', notes: '原自定义图' };
  assert.deepEqual((await store.getAsset('forge-base', entity.payload.assetId, { revision: 'r1', detailMode: 'single' })).diagram, entity.payload.diagram);
  assert.equal(generateExplicitRelationshipDiagram({ ...entity.payload, details: { relationships: [{ type: 'has-many', targetRef: { kind: 'entity', id: 'no-source' } }] } }), null);
  const bounded = structuredClone(entity.payload); bounded.details.relationships[0].conditions = '"\nclick X href https://example.invalid;'.repeat(100);
  const graph = generateExplicitRelationshipDiagram(bounded);
  assert.ok(graph.source.length < 30000); assert.equal(graph.source.split('\n').length, 8);
  assert.equal(generateExplicitRelationshipDiagram({ ...entity.payload, details: { relationships: Array(61).fill(entity.payload.details.relationships[0]) } }), null);
});

function dataset(count = 260) {
  const menus = [{ id: 'root', name: '相关方', path: ['相关方'], parentId: null }, { id: 'workers', name: '作业人员', path: ['相关方', '作业人员'], parentId: 'root' }];
  const artifacts = Array.from({ length: count }, (_, i) => ({ id: `api-v-${i}`, kind: 'specification-asset', stageId: null,
    payload: { assetId: `api-${i}`, kind: 'api', name: `接口 ${i}`, revision: 'r1', recordedAt: '2026-10-07T00:00:00Z',
      menuIds: ['workers'], menuPaths: [['相关方', '作业人员']], sources: [], batchIds: ['iteration-one'], releaseIds: [],
      nature: 'implementation-observation', details: { body: 'x'.repeat(8000), calls: Array.from({ length: 4 }, (_, j) => ({ id: `call-${i}-${j}`, name: `调用 ${i} ${j}`, method: 'GET', target: `/org/${i}/${j}`, mode: j % 2 ? 'async' : 'sync' })) } } }));
  return { menus, artifacts, requirements: [], releases: [] };
}
function fakeStore(data = dataset()) {
  const calls = [];
  const execute = async (sql, parameters = []) => {
    calls.push({ sql, parameters });
    if (sql.startsWith('SET TRANSACTION')) return [[]];
    if (sql.includes('SELECT snapshot_digest')) return [[{ snapshot_digest: snapshotDigest, observed_at: '2026-10-07T01:00:00Z' }]];
    if (sql.includes('SELECT coverage')) return [[{ coverage: { currentAssetVersionIds: data.artifacts.filter(a => !a.historical).map(a => a.id) } }]];
    if (sql.includes('delivery_center_menus')) return [data.menus.map(item => ({ data: item, is_current: 1 }))];
    if (sql.includes('delivery_center_requirement_versions') && data.requirementVersions) return [data.requirementVersions.map(item => ({ data: item }))];
    if (sql.includes('delivery_center_requirements r')) return [data.requirements.map(item => ({ data: item }))];
    if (sql.includes('delivery_center_release_requirements')) return [sql.startsWith('SELECT DISTINCT')
      ? (data.releaseRequirements ?? []).map(item => ({ menu_path: item.menuPath }))
      : (data.releaseRequirements ?? []).map(item => ({ data: item }))];
    if (sql.includes('delivery_center_releases')) return [data.releases.map(item => ({ data: item }))];
    if (sql.includes('delivery_center_artifacts a')) {
      let items = data.artifacts;
      if (sql.includes('a.id IN')) {
        items = items.filter(item => parameters.slice(1).includes(item.id));
        if (!sql.startsWith('SELECT a.data')) return [items.map(item => ({ data: { id: item.id, payload: { details: Object.fromEntries(Object.entries(item.payload.details).filter(([key]) => sql.includes(`$.payload.details.${key}'`))), ...(sql.includes("'$.payload.relations'") ? { relations: item.payload.relations } : {}) } } }))];
      } else {
        if (sql.includes("'$.payload.assetId')) = ?")) items = items.filter(item => item.payload.assetId === parameters[1]);
        if (sql.includes("'$.payload.kind')) = ?")) items = items.filter(item => item.payload.kind === parameters[1]);
        if (sql.startsWith('SELECT DISTINCT') && sql.includes("JSON_CONTAINS(JSON_EXTRACT(a.data, '$.payload.functionRefs')")) {
          const ref = JSON.parse(parameters.at(-1));
          const ids = new Set(items.filter(item => item.payload.functionRefs?.some(value => Object.entries(ref).every(([key, valueAtKey]) => value[key] === valueAtKey))).map(item => item.payload.assetId));
          return [[...ids].map(asset_id => ({ asset_id }))];
        }
        if (sql.includes("JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.payload.assetId')) IN (")) items = items.filter(item => parameters.includes(item.payload.assetId));
        return [items.map(item => ({ data: { ...item, payload: Object.fromEntries(HEADER_KEYS.filter(key => item.payload[key] !== undefined).map(key => [key, item.payload[key]])) }, stage_current: 0 }))];
      }
      return [items.map(item => ({ data: item }))];
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const connection = { execute, beginTransaction: async () => calls.push({ event: 'begin' }), commit: async () => calls.push({ event: 'commit' }), rollback: async () => calls.push({ event: 'rollback' }), release: () => calls.push({ event: 'release' }) };
  return { store: new DeliveryCenterStore({ pool: { execute, getConnection: async () => connection } }), calls };
}

test('function association reads retain unknown link revisions and bounded business summaries through the list contract', async () => {
  const functionId = 'budget.function.budget-ledger-maintenance'; const data = dataset(3);
  data.artifacts.forEach((item, index) => {
    item.payload.functionRefs = [{ kind: 'function', id: index === 2 ? 'other-function' : functionId, revision: index === 0 ? null : 'definition-r1' }];
    item.payload.details.businessGoal = '真实资料中的业务目标。'.repeat(40);
    item.payload.details.observableResult = '原文可见结果';
    item.payload.details.boundaries = Array.from({ length: 7 }, (_, i) => `原文边界${i}`);
    item.payload.details.knownLimitations = ['未明确关联定义修订'];
  });
  const { store, calls } = fakeStore(data);
  const url = suffix => new URL(`http://local/forge-gateway/api/delivery/${suffix}`);
  const query = `project=forge-base&kind=api&projection=summary&menuId=workers&menuScope=self&batchId=iteration-one&functionId=${functionId}&pageSize=1`;
  const first = (await deliveryResponse({ method: 'GET', url: url(`assets?${query}`), store })).body;
  assert.equal(first.total, 2); assert.equal(first.items.length, 1);
  assert.equal(first.scope.filters.functionId, functionId);
  assert.equal(first.items[0].revision, 'r1');
  assert.deepEqual(first.items[0].functionAssociation, { id: functionId, revision: null, binding: 'identity-only', refs: [{ kind: 'function', id: functionId, revision: null }] });
  assert.equal(first.items[0].details.businessGoal.length, 240);
  assert.equal(first.items[0].details.observableResult, '原文可见结果');
  assert.equal(first.items[0].details.boundaries.length, 5);
  assert.deepEqual(first.items[0].details.knownLimitations, ['未明确关联定义修订']);
  const exact = (await deliveryResponse({ method: 'GET', url: url(`assets?${query}&functionRevision=definition-r1`), store })).body;
  assert.equal(exact.total, 1); assert.equal(exact.items[0].assetId, 'api-1');
  assert.equal(exact.items[0].functionAssociation.binding, 'exact-revision');
  assert.equal(exact.items[0].functionAssociation.refs[0].revision, 'definition-r1');
  assert.equal(exact.items[0].revision, 'r1');
  assert.ok(calls.filter(call => call.sql?.includes('a.id IN')).every(call => call.parameters.length === 2));
  const queryCalls = calls.filter(call => call.sql?.includes('a.stage_id IS NULL'));
  assert.ok(queryCalls.every(call => !call.sql.includes('IN (SELECT') && !call.sql.includes('JSON_CONTAINS') && !call.sql.includes(functionId)));
  const candidates = calls.filter(call => call.sql?.startsWith('SELECT DISTINCT'));
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(call => call.sql.includes("JSON_CONTAINS(JSON_EXTRACT(a.data, '$.payload.functionRefs'), CAST(? AS JSON)) LIMIT 10001") && !call.sql.includes(functionId)));
  assert.throws(() => deliveryQuery(new URLSearchParams('project=forge-base&functionRevision=definition-r1')), { code: 'DELIVERY_INVALID_QUERY' });
  await assert.rejects(deliveryResponse({ method: 'GET', url: url(`views?project=forge-base&view=calls&functionId=${functionId}`), store }), { code: 'DELIVERY_INVALID_QUERY' });
  const functionData = dataset(1); functionData.artifacts[0].payload.kind = 'function';
  functionData.artifacts[0].payload.details = { businessGoal: '已有业务目标'.repeat(100), observableResult: '已有可见结果', boundaries: ['范围一'], knownLimitations: ['未接入外部系统'] };
  const overview = await fakeStore(functionData).store.listView('forge-base', { view: 'feature-delivery', projection: 'summary' });
  assert.equal(overview.items[0].businessGoal.length, 240);
  assert.equal(overview.items[0].observableResult, '已有可见结果');
});

test('function association filters the selected scoped revision without resurrecting an older linked asset', async () => {
  const functionId = 'function-withdrawn-from-new-revision'; const data = dataset(1);
  const old = data.artifacts[0]; old.releaseId = 'release-old';
  old.payload.functionRefs = [{ kind: 'function', id: functionId, revision: null }];
  const latest = structuredClone(old); latest.id = 'api-v-latest'; latest.releaseId = null;
  latest.payload.revision = 'r2'; latest.payload.recordedAt = '2026-10-08T00:00:00Z'; latest.payload.functionRefs = [];
  data.artifacts.push(latest); data.releases.push({ id: 'release-old', status: 'success', scopeBinding: 'explicit' });
  const { store, calls } = fakeStore(data);
  for (const scope of [{}, { batchId: 'iteration-one' }]) {
    const result = await store.listAssets('forge-base', { ...scope, kind: 'api', functionId, projection: 'summary' });
    assert.equal(result.total, 0, 'the latest scoped revision removed this function reference');
  }
  assert.equal(calls.filter(call => call.sql?.includes('a.id IN')).length, 0, 'discarded candidates never load bodies');
  const released = await store.listAssets('forge-base', { releaseId: 'release-old', kind: 'api', functionId, projection: 'summary' });
  assert.equal(released.total, 1); assert.equal(released.items[0].versionId, old.id);
  assert.equal(released.items[0].revision, 'r1'); assert.equal(released.items[0].functionAssociation.refs[0].revision, null);
});

test('new query contract validates views, directory and independent menu semantics without inventing defaults', () => {
  const { filters } = deliveryQuery(new URLSearchParams('project=forge-base&view=calls&menuScope=self&menuBinding=unknown&origin=baseline&businessChange=modified&directoryScope=historical&projection=summary&detailMode=single&nature=design'));
  assert.equal(filters.view, 'calls'); assert.equal(filters.menuScope, 'self'); assert.equal(filters.directoryScope, 'historical');
  assert.throws(() => deliveryQuery(new URLSearchParams('project=forge-base&view=anything')), { code: 'DELIVERY_INVALID_QUERY' });
  assert.equal(semanticMatch({}, { menuBinding: 'none' }), false);
  assert.equal(semanticMatch({ menuApplicability: 'none' }, { menuBinding: 'none' }), true);
  assert.equal(semanticMatch({}, { businessChange: 'unchanged' }), false);
  assert.equal(filters.nature, 'design'); assert.equal(semanticMatch({}, { nature: 'design' }), false);
  assert.equal(semanticMatch({}, { nature: 'unknown' }), true);
});

test('subviews filter and page the complete parent scope with only needed collections read', async () => {
  const { store, calls } = fakeStore(dataset(600));
  const result = await store.listView('forge-base', { view: 'calls', menuId: 'root', menuScope: 'descendants', page: 12, pageSize: 100 });
  assert.equal(result.total, 2400); assert.equal(result.items.length, 100);
  assert.ok(result.items.every(item => item.parentRef.revision === 'r1' && item.localId.startsWith('/details/calls/')));
  assert.equal(result.scope.snapshotDigest, snapshotDigest);
  const search = await store.listView('forge-base', { view: 'calls', q: '/org/599/3', pageSize: 10 });
  assert.equal(search.total, 1); assert.equal(search.items[0].id, 'call-599-3');
  const own = await store.listView('forge-base', { view: 'calls', menuId: 'root', menuScope: 'self' });
  assert.equal(own.total, 0);
  assert.equal(calls.some(call => call.sql?.startsWith('SELECT a.data')), false);
  assert.equal(calls.some(call => call.sql?.includes("'$.payload.details.body'")), false);
  assert.equal(calls.filter(call => call.event === 'begin').length, 3);
  assert.equal(calls.filter(call => call.event === 'commit').length, 3);
});

test('summary uses bounded page bodies and single details expose only metadata history', async () => {
  const data = dataset(205); const old = structuredClone(data.artifacts[0]); old.id = 'old-api'; old.payload.revision = 'r0'; old.historical = true; data.artifacts.push(old);
  const { store, calls } = fakeStore(data);
  const result = await store.listAssets('forge-base', { kind: 'api', projection: 'summary', page: 1, pageSize: 20 });
  assert.equal(result.total, 205); assert.equal(result.items.length, 20);
  assert.ok(result.items.every(item => item.details.body === undefined && item.details.calls === undefined));
  assert.equal(calls.find(call => call.sql?.includes('a.id IN')).parameters.length, 21);
  const detail = await store.getAsset('forge-base', 'api-0', { revision: 'r0', detailMode: 'single' });
  assert.equal(detail.details.body.length, 8000); assert.equal(detail.revisions.length, 2);
  assert.ok(detail.revisions.every(item => item.details === undefined));
  assert.equal(await store.getAsset('forge-base', 'api-0', { revision: 'missing', detailMode: 'single' }), null);
});

test('matrix follows exact references, leaves unresolved versions partial and keeps sections out of requirements', () => {
  const requirements = [{ id: 'req-a', name: '准入', revision: 'q1', recordType: 'requirement', menuId: 'workers', functionRefs: [{ kind: 'function', id: 'f-a', revision: 'f1' }] },
    { id: 'req-b', name: '归档', revision: 'q2', recordType: 'requirement', functionRefs: [{ kind: 'function', id: 'f-a', revision: 'missing' }] },
    { id: 'chapter', granularity: 'specification-section', name: '原说明章节' }];
  const rows = requirementMatrix(requirements, [{ id: 'f-a', kind: 'function', name: '审核', revision: 'f1' }, { id: 'f-b', kind: 'function', name: '通知', revision: 'f1' }]);
  assert.deepEqual(rows.map(item => item.rowType), ['complete', 'partial', 'function-only']);
  assert.equal(rows[1].functionName, null); assert.equal(rows[1].bindingStatus, 'target-revision-unresolved');
  assert.deepEqual(matrixIdentityCounts(rows), { relationRows: 3, requirementIdentities: 2, functionIdentities: 2 });
});

test('matrix and CSV prefer same-scope menu paths and readable source names without filling historical gaps', async () => {
  const menuId='forge-base:menu:10442';const requirementId='budget.requirement.non-negative-budget';
  const statement='预算金额不得为负数。';const data=dataset(0);
  data.menus=[{id:'leader',name:'领导引领力',path:['领导引领力'],parentId:null},
    {id:'investment',name:'EHSS投入',path:['领导引领力','EHSS投入'],parentId:'leader'},
    {id:menuId,name:'预算和使用',path:['领导引领力','EHSS投入','预算和使用'],parentId:'investment'},
    {id:'unrelated',name:'预算和使用',path:['另一业务','预算和使用'],parentId:'another'}];
  const requirement={id:requirementId,name:requirementId,recordType:'requirement',revision:'requirement-r1',menuId,menuIds:[menuId],
    menuPath:['预算和使用'],menuPaths:[['预算和使用']],description:statement,details:{statement},adoption:null,batchIds:['old-batch']};
  data.requirements=[requirement];data.requirementVersions=[{...requirement,revision:'historical-r0'}];
  data.releases=[{id:'old-release',scopeBinding:'frozen-explicit-snapshot',requirementSnapshots:[]}];
  data.releaseRequirements=[{...requirement,revision:'release-r0',menuPath:['历史集团','原投入','预算和使用'],menuPaths:[]}];
  const original=JSON.stringify(data);const {store}=fakeStore(data);
  const base={view:'requirement-matrix',pageSize:20};
  const current=await store.listView('forge-base',base);const row=current.items[0];
  assert.deepEqual(row.menuPath,['领导引领力','EHSS投入','预算和使用']);assert.deepEqual(row.sourceMenuPaths,[['预算和使用']]);assert.equal(row.menuPathBinding,'scope-directory');
  assert.equal(row.requirementName,statement);assert.equal(row.requirementRef.name,statement);assert.equal(row.requirementRef.id,requirementId);assert.equal(row.requirementRef.revision,'requirement-r1');assert.equal(row.adoption,null);
  const csv=async suffix=>(await deliveryResponse({method:'GET',url:new URL(`http://local/forge-gateway/api/delivery/export?project=forge-base&view=requirement-matrix${suffix}`),store})).csv;
  const currentCsv=await csv('');assert.ok(currentCsv.includes('"unbound","领导引领力","EHSS投入","预算和使用"'));assert.ok(currentCsv.includes(`"${statement}","${statement}"`));
  const historical=await store.listView('forge-base',{...base,batchId:'old-batch'});assert.deepEqual(historical.items[0].menuPath,['预算和使用']);assert.deepEqual(historical.items[0].menuHierarchyPaths,[]);assert.equal(historical.items[0].revision,'historical-r0');
  const batchCsv=await csv('&batchId=old-batch');assert.ok(batchCsv.includes(`"unbound","","","","${menuId}","预算和使用"`));assert.doesNotMatch(batchCsv,/领导引领力|EHSS投入/);assert.match(batchCsv,/完整菜单层级未确认/);
  const release=await store.listView('forge-base',{...base,releaseId:'old-release'});assert.deepEqual(release.items[0].menuPath,['历史集团','原投入','预算和使用']);assert.equal(release.items[0].revision,'release-r0');
  const releaseCsv=await csv('&releaseId=old-release');assert.ok(releaseCsv.includes('"unbound","历史集团","原投入","预算和使用"'));assert.doesNotMatch(releaseCsv,/领导引领力|EHSS投入/);
  assert.equal(JSON.stringify(data),original);
  const functionOnly=requirementMatrix([],[{id:'budget-function',name:'预算维护',revision:'f1',menuIds:[menuId],menuPaths:[['预算和使用']]}],data.menus);
  assert.deepEqual(functionOnly[0].menuPath,['领导引领力','EHSS投入','预算和使用']);
  const longBody='原文已有的业务限制。'.repeat(30);const long=requirementMatrix([{...requirement,description:longBody,details:{statement:longBody}}])[0];assert.equal(long.requirementName.length,111);assert.equal(long.description,longBody);
  const unrelated=requirementMatrix([{...requirement,menuId:'unmapped',menuIds:['unmapped']}],[],data.menus)[0];assert.deepEqual(unrelated.menuHierarchyPaths,[]);assert.deepEqual(unrelated.menuPath,['预算和使用']);
});

test('matrix export reads the same complete scope and rejects a changed observation token', async () => {
  const data = dataset(0);
  data.requirements = Array.from({ length: 83 }, (_, index) => ({ id: `req-${index}`, name: `要求 ${index}`, revision: 'r1', recordType: 'requirement' }));
  const completeBody = '完整业务正文，包含条件和异常处理。'.repeat(200);
  Object.assign(data.requirements[0], { description: completeBody, requirementType: '业务规则', conditions: '证件有效且申请已批准',
    menuId: 'workers', menuPath: ['相关方', '作业人员'], implementation: { status: 'observed' }, implementationEvidence: [{ commit: 'c'.repeat(40) }],
    verification: { verdict: 'passed', scope: '本项断言' }, verificationEvidence: [{ runId: 'run-one' }],
    publication: { state: 'unknown' }, publicationEvidence: null, batchIds: ['batch-one'], details: { exception: '失败保留草稿' } });
  const { store, calls } = fakeStore(data);
  const page = await store.listView('forge-base', { view: 'requirement-matrix', page: 2, pageSize: 20 });
  assert.equal(page.total, 83); assert.equal(page.items.length, 20);
  const exported = await store.exportView('forge-base', { view: 'requirement-matrix', page: 2, pageSize: 20, snapshotDigest: page.scope.snapshotDigest });
  assert.equal(exported.items.length, 83); assert.equal(exported.counts.requirementIdentities, 83);
  await assert.rejects(store.exportView('forge-base', { view: 'requirement-matrix', snapshotDigest: 'b'.repeat(64) }), { code: 'DELIVERY_SCOPE_CHANGED' });
  assert.equal(calls.filter(call => call.event === 'rollback').length, 1);
  const response = await deliveryResponse({ method: 'GET', url: new URL('http://local/forge-gateway/api/delivery/export?project=forge-base&view=requirement-matrix'), store });
  assert.equal(response.count, 83); assert.match(response.csv, /需求编号/); assert.equal(response.csv.split('\r\n').length, 85);
  assert.ok(response.csv.includes(completeBody)); assert.match(response.csv, /完整历史菜单路径/); assert.match(response.csv, /相关方 \/ 作业人员/);
  assert.match(response.csv, /实现依据/); assert.match(response.csv, /验证结论/); assert.match(response.csv, /发布依据/);
  assert.ok(response.csv.includes('c'.repeat(40))); assert.match(response.csv, /run-one/); assert.match(response.csv, /失败保留草稿/);
  assert.ok(response.csv.includes(snapshotDigest)); assert.match(response.csv, /2026-10-07T01:00:00Z/); assert.match(response.csv, /forge-base/);
});

test('permission design summaries remain visible in their batch without inventing or duplicating authorization rules', async () => {
  const data = dataset(0);
  const roles = ['admin', 'deptMgr', 'superMgr', 'ehssTech', 'ehssMgr', 'ccInspector', 'dept', 'hse', 'leader'];
  const permissionCodes = Array.from({ length: 9 }, (_, index) => `business:module:api:operation${index}`);
  const summary = { assetId: 'module.permission.design', kind: 'permission', name: '页面与接口权限设计',
    revision: 'V1.0.183/V1.0.196', recordType: 'rbac-design', nature: 'design',
    menuIds: ['workers'], menuPaths: [], batchIds: ['checkpoint-one'], recordedAt: '2026-10-09T00:16:38+08:00',
    sources: [{ kind: 'committed-document', commit: 'a'.repeat(40), sourcePath: 'changes/history/spec.md' }],
    details: { roles, permissionCodes, description: '迁移表达授权设计，不证明生产执行或角色实际有效。', tenantScope: '迁移种子 tenant_id=1，运行未验证。' } };
  const structured = { ...summary, assetId: 'module.permission.rule', name: '明确规则', details: { ...summary.details,
    rules: [{ id: 'explicit-rule', subject: '审核岗', operation: '审核', resource: '申请', decision: 'allow' }] } };
  data.artifacts = [summary, structured].map((payload, index) => ({ id: `permission-version-${index}`, kind: 'specification-asset', historical: true, payload }));
  const { store } = fakeStore(data);
  const filters = { menuId: 'workers', menuScope: 'descendants', batchId: 'checkpoint-one' };
  const result = await store.listView('forge-base', { ...filters, view: 'permission-rules' });
  assert.equal(result.total, 2);
  const row = result.items.find(item => item.parentRef.id === summary.assetId);
  assert.deepEqual(row.roles, roles); assert.deepEqual(row.permissionCodes, permissionCodes);
  assert.equal(row.description, summary.details.description); assert.equal(row.tenantScope, summary.details.tenantScope);
  assert.equal(row.recordMeaning, '权限设计资料（未展开为授权规则）'); assert.equal(row.nature, 'design');
  assert.deepEqual(row.parentRef, { kind: 'permission', id: summary.assetId, revision: summary.revision });
  assert.equal(row.localId, null); assert.deepEqual(row.sources, summary.sources);
  for (const field of ['decision', 'implementation', 'publication', 'verification']) assert.equal(row[field], null);
  assert.equal(result.items.filter(item => item.parentRef.id === structured.assetId).length, 1);
  assert.equal(result.items.find(item => item.id === 'explicit-rule').decision, 'allow');
  const matrix = await store.listView('forge-base', { ...filters, view: 'permission-matrix' });
  assert.equal(matrix.total, 1); assert.equal(matrix.items[0].cells.length, 1);
  assert.equal((await store.listView('forge-base', { ...filters, view: 'permission-rules', batchId: 'other-checkpoint' })).total, 0);
  const detail = await store.getAsset('forge-base', summary.assetId, { ...filters, revision: summary.revision, detailMode: 'single' });
  assert.deepEqual(detail.details.roles, roles); assert.equal(detail.revision, summary.revision);
  const { readFile } = await import('node:fs/promises');
  const uiSource = await readFile(new URL('../docker/harness/conversation-gateway/delivery-center-views.js', import.meta.url), 'utf8');
  const { deliveryTabs, detailSchemas } = await import(`data:text/javascript;base64,${Buffer.from(uiSource).toString('base64')}`);
  const columns = deliveryTabs.permissions.columns;
  assert.ok(columns.some(column => column.identity && column.key.split('|').includes('name')));
  assert.deepEqual(columns.filter(column => !column.optional).map(column => column.key),
    ['subject|role|name', 'canSee', 'canPerform|operation|action', 'dataScope', 'recordMeaning', 'sources']);
  for (const key of ['description', 'roles|roleKeys', 'subjectType', 'object|objectRef', 'canAct', 'denialConditions', 'taskConditions|conditions|preconditions', 'decision']) {
    assert.ok(columns.some(column => column.key === key && column.optional));
  }
  const roleColumns = detailSchemas.permission.find(section => section.keys === 'roles').columns;
  assert.deepEqual(roleColumns.map(column => column.key),
    ['displayNameZh|displayName|name|role|description|roleKey', 'roleKey', 'dataScope', 'visibleCapabilities|canSee']);
  assert.match(deliveryTabs.permissions.help, /可见能力不代表可执行操作/);
  assert.match(deliveryTabs.permissions.help, /未说明的具体业务边界保持未知/);
});

test('permission matrix groups all rules by subject before pagination without inventing denials', async () => {
  const data = dataset(0);
  data.artifacts = [{ id: 'permission-v1', kind: 'specification-asset', payload: { assetId: 'permission-a', kind: 'permission', name: '作业人员权限', revision: 'r1', menuIds: [], menuPaths: [], sources: [], details: {
    rules: [{ subjectId: 'r-a', subject: '审核岗', operation: '审核', resource: '申请', decision: 'allow', conditions: '本人机构' },
      { subjectId: 'r-a', subject: '审核岗', operation: '删除', resource: '申请', decision: 'deny' },
      { subjectId: 'r-b', subject: '申报岗', operation: '提交', resource: '申请' }] } } }];
  const { store } = fakeStore(data);
  const result = await store.listView('forge-base', { view: 'permission-matrix', pageSize: 1 });
  assert.equal(result.total, 2); assert.equal(result.columns.length, 3); assert.equal(result.items[0].cells.length, 2);
  const page2 = await store.listView('forge-base', { view: 'permission-matrix', page: 2, pageSize: 1 });
  assert.equal(page2.items[0].cells[0].decision, null);
});

test('unknown legacy rows remain source material and summary does not leak full long text', () => {
  const item = deliverySummary({ name: '说明', description: '长'.repeat(5000), details: { body: '巨量', purpose: '用途' }, fields: [{ name: '姓名' }], sources: [{ path: 'x.md', excerpt: '原文'.repeat(1000) }] });
  assert.equal(item.description.length, 240); assert.equal(item.nature, 'unknown'); assert.equal(item.fieldsCount, 1); assert.equal(item.fields, undefined);
  assert.equal(item.sources[0].excerpt, undefined);
  assert.deepEqual(buildSubview('test-executions', [{ id: 'old', kind: 'test', details: { description: '预期 3/3' } }]), []);
});

test('physical table mappings do not masquerade as relationships between business objects', () => {
  const entity = { id: 'worker', kind: 'entity', revision: 'r1', relations: [
    { type: 'maps-to-table', to: { kind: 'table', id: 'worker-table', revision: 't1' } },
    { type: 'belongs-to', to: { kind: 'entity', id: 'organization', revision: 'o1' } },
  ] };
  assert.deepEqual(buildSubview('relations', [entity]).map(row => row.type), ['belongs-to']);
  assert.deepEqual(buildSubview('model-mappings', [entity]).map(row => row.type), ['maps-to-table']);
});

test('iteration requirement lists read recorded revisions instead of the current requirement body', async () => {
  const calls = []; const old = { id: 'req-one', name: '旧要求', revision: 'r1', recordType: 'requirement', batchIds: ['old-batch'] };
  const execute = async (sql, parameters = []) => {
    calls.push({ sql, parameters });
    if (sql.startsWith('SET TRANSACTION')) return [[]];
    if (sql.includes('SELECT snapshot_digest')) return [[{ snapshot_digest: snapshotDigest }]];
    if (sql.includes('COUNT(*)')) return [[{ total: 1 }]];
    if (sql.includes('FROM delivery_center_requirement_versions)')) return [[{ data: old }]];
    throw new Error(`Unexpected query: ${sql}`);
  };
  const connection = { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
  const store = new DeliveryCenterStore({ pool: { execute, getConnection: async () => connection } });
  const result = await store.listRequirements('forge-base', { batchId: 'old-batch', projection: 'summary' });
  assert.equal(result.items[0].name, '旧要求'); assert.equal(result.rowMeaning, 'recorded-revisions');
  assert.ok(calls.some(call => call.sql.includes("JSON_CONTAINS(r.data, JSON_QUOTE(?), '$.batchIds')") && call.parameters.includes('old-batch')));
  assert.equal(calls.some(call => call.sql.includes('delivery_center_requirements r')), false);
});

test('legacy permission registrations and page source links remain observations with exact parent references', async () => {
  const data = dataset(0);
  const permission = { assetId: 'permission-observed', kind: 'permission', name: '人员查看资源', revision: 'p1',
    menuIds: ['workers'], menuPaths: [['相关方', '作业人员']], sources: [{ kind: 'menu-configuration', resourceId: '531' }],
    details: { code: 'party:worker:view', actions: ['view'], roleBindings: [{ roleId: 'admin', source: 'resource-registration' }], definitionType: 'resource-registration' } };
  const page = { assetId: 'page-observed', kind: 'page', name: '作业人员', revision: 'v1', menuIds: ['workers'], menuPaths: [['相关方', '作业人员']],
    sources: [{ type: 'code-snapshot', path: 'src/views/party/worker.vue', commit: 'b'.repeat(40), sha256: 'c'.repeat(64) }],
    details: { component: 'party/worker', route: ['相关方', '作业人员'] } };
  data.artifacts = [permission, page].map((payload, index) => ({ id: `observation-${index}`, kind: 'specification-asset', payload }));
  const { store } = fakeStore(data);
  const permissions = await store.listView('forge-base', { view: 'permission-evidence' });
  assert.equal(permissions.total, 1);
  const permissionRow = permissions.items[0];
  assert.deepEqual(permissionRow.parentRef, { kind: 'permission', id: permission.assetId, revision: 'p1' });
  assert.equal(permissionRow.recordType, 'resource-registration-observation'); assert.equal(permissionRow.ruleRef, null); assert.equal(permissionRow.decision, null);
  assert.deepEqual(permissionRow.configuration.roleBindings, permission.details.roleBindings);
  assert.equal((await store.listView('forge-base', { view: 'permission-rules' })).total, 0);
  assert.equal((await store.listView('forge-base', { view: 'permission-matrix' })).total, 0);
  const pages = await store.listView('forge-base', { view: 'page-implementations' });
  assert.equal(pages.total, 1);
  const pageRow = pages.items[0];
  assert.deepEqual(pageRow.parentRef, { kind: 'page', id: page.assetId, revision: 'v1' });
  assert.equal(pageRow.component, 'party/worker'); assert.equal(pageRow.route, null); assert.deepEqual(pageRow.reportedRoute, ['相关方', '作业人员']);
  assert.equal(pageRow.recordType, 'code-implementation-observation'); assert.equal(pageRow.publication, null); assert.equal(pageRow.verification, null); assert.equal(pageRow.implementation, null);
  assert.equal(pageRow.sources[0].sha256, 'c'.repeat(64)); assert.deepEqual(pageRow.commits, ['b'.repeat(40)]);
  const explicitPermission = { ...permission, id: permission.assetId, details: { ...permission.details, evidence: [{ id: 'explicit-permission', name: '已记录落实依据' }] } };
  const explicitPage = { ...page, id: page.assetId, details: { ...page.details, implementations: [{ id: 'explicit-page', component: 'exact/component' }] } };
  assert.deepEqual(buildSubview('permission-evidence', [explicitPermission]).map(row => row.id), ['explicit-permission']);
  assert.deepEqual(buildSubview('page-implementations', [explicitPage]).map(row => row.id), ['explicit-page']);
  assert.deepEqual(buildSubview('permission-evidence', [{ ...permission, id: permission.assetId, sources: [] }]), []);
  assert.deepEqual(buildSubview('page-implementations', [{ ...page, id: page.assetId, sources: [{ type: 'code-snapshot', path: 'unbound.vue' }] }]), []);
});


test('historical stage report variants preserve original receipts limits and exact detail anchors', async () => {
  // Source: stage-report-selected-details-20261009.txt, two actual selected historical reports.
  const reports = [
  {
    "id": "asset-75013db0424b1a91099324abf8ddcc75",
    "kind": "test",
    "name": "后端 · redTests",
    "revision": "98d7f85f9d31ade985f825e32bcabdb21713eb1144f93f702e80037489603ea7",
    "recordType": "test-evidence-report",
    "nature": "execution",
    "sourceTopic": "redTests",
    "sourcePhaseStatus": "historical",
    "sources": [
      {
        "label": "后端",
        "digest": "c5c47025eee44b9848c801be7a7082643ee071cd0ac87987f662da7012985161",
        "taskId": "c-0e254375986948ea7b361297",
        "batchId": "batch-228f2b518c1b93f9285e5dc511d1f58d",
        "pointer": "/redTests",
        "stageId": "stage-b998309e9108cf59637b3947da7602eb",
        "sessionId": "session-1faee0dc-2df0-5cb6-bf56-0a557e135bbe"
      }
    ],
    "details": {
      "scope": "Focused backend regression for the fire spare-part stock mutation issue discovered during runtime acceptance.",
      "notRunInThisPhase": [
        "Runtime stock add/detail/stock-in/stock-out replay was not executed in this backend artifact correction turn.",
        "Cross-layer acceptance, changed-safe, full-regression, browser verification, checkpoint and release remain outside this bounded backend phase artifact correction."
      ],
      "regressionCoverage": [
        "stockInAcceptsInitialZeroVersionAndPersistsTransaction verifies stock-in accepts version=0, calls the optimistic stock update, inserts one stock transaction only after update success, and returns the advanced inventory/version data.",
        "stockRejectsNegativeVersionWithoutChangingInventory verifies negative version fails validation and does not call changeStock or insertStockTransaction.",
        "stockInWithStaleVersionReportsConflictAndDoesNotWriteTransaction verifies affected-row=0 on version mismatch is surfaced as FIRE_VERSION_CONFLICT and no stock transaction is written."
      ],
      "verificationReceipts": [
        {
          "profile": "governance",
          "freshness": "current",
          "receiptId": "7325da5c-161c-4211-a356-1040d59b16ed",
          "logSummary": "PASS Forge governance 2026.09.20.2: 22 files, 0 blocking findings, 0 unchanged legacy findings retained.",
          "truthBoundary": {
            "releaseProven": false,
            "executionProven": true,
            "verificationProven": true,
            "databaseIntegrationProven": false,
            "semanticCorrectnessProven": false
          },
          "recordedStatus": "passed",
          "blockingFindings": 0,
          "executionExitCode": 0,
          "workspaceFingerprint": "11e7d33b9124de130eaf97dd0b3b7d36a387e7982d08791817cdb32f455b6343",
          "advisoriesOrRequiresRetained": [
            "FLOW-001 remains advisory for approval Flowable binding/BPMN/business process identity artifacts outside this scoped stock fix.",
            "PERMISSION-001, BE-RELIABILITY-001 and OBS-001 remain reviewed-contract obligations for broader delivery closeout; they are not newly closed by this backend stock fix."
          ]
        },
        {
          "module": "forge-server/forge-business/forge-business-core",
          "profile": "backend-module-compile",
          "freshness": "current",
          "receiptId": "0dd9aabb-bc3c-4c54-9843-9772cc7b5e79",
          "recordedStatus": "passed",
          "workspaceFingerprint": "11e7d33b9124de130eaf97dd0b3b7d36a387e7982d08791817cdb32f455b6343"
        },
        {
          "failed": 0,
          "module": "forge-server/forge-business/forge-business-core",
          "passed": 1581,
          "profile": "backend-module-test",
          "skipped": 0,
          "executed": 1581,
          "freshness": "current",
          "receiptId": "b323392b-db67-404f-920a-39c1ee12255c",
          "recordedStatus": "passed",
          "workspaceFingerprint": "11e7d33b9124de130eaf97dd0b3b7d36a387e7982d08791817cdb32f455b6343"
        }
      ],
      "diagnosisVerifiedBySource": "The stock endpoint previously parsed the optimistic-lock version through the positive business-ID validator, so a valid newly-created spare-part version of 0 was rejected with FIRE_VALIDATION_FAILED before inventory mutation. Actual field rejection was confirmed against the stock request contract and FireManagementService source rather than inferred only from the runtime error text."
    }
  },
  {
    "id": "asset-5c6d5425fb70ce2d4dbcb5d36089c171",
    "kind": "test",
    "name": "权限接线 · permissionCoherence",
    "revision": "a7ac3463a190f86fdc75d67314415a396b5fd095ad3db8de3e35da32f4349826",
    "recordType": "test-evidence-report",
    "nature": "execution",
    "sourceTopic": "permissionCoherence",
    "sourcePhaseStatus": "historical",
    "sources": [
      {
        "label": "权限接线",
        "digest": "56fafcd76cc2fe459a87a095cac4d1914fca17e5fe2c6182928e469c6553a545",
        "taskId": "c-0e254375986948ea7b361297",
        "batchId": "batch-228f2b518c1b93f9285e5dc511d1f58d",
        "pointer": "/permissionCoherence",
        "stageId": "stage-18d2b122cbefdfa72cbb756a113d2939",
        "sessionId": "session-1faee0dc-2df0-5cb6-bf56-0a557e135bbe"
      }
    ],
    "details": {
      "scope": "access-wiring",
      "notYetProven": [
        "修后候选数据库 prepare has not yet been completed.",
        "Spare-part runtime add/getById/stock-in/stock-out/transaction inventory checks have not yet been completed.",
        "Cross-layer acceptance and release are not performed in this phase artifact correction."
      ],
      "resourceTypes": {
        "api": "resource_type=4 exact method+path resources",
        "menu": "resource_type=1 fire directory and resource_type=2 fire pages",
        "button": "resource_type=3 page action resources"
      },
      "directVerification": [
        {
          "scope": "current source containing V1.0.20261013 and access-wiring migration contract test correction",
          "status": "passed",
          "profile": "governance",
          "freshness": "current",
          "receiptId": "5faeeeca-7465-455b-a3f0-35b05e24103f",
          "blockingFindings": 0
        },
        {
          "scope": "forge-server/forge-business/forge-business-core",
          "failed": 0,
          "passed": 1578,
          "status": "passed",
          "profile": "backend-module-test",
          "skipped": 0,
          "executed": 1578,
          "freshness": "current",
          "receiptId": "ccaae4fe-3a8b-46da-bf97-3152c4936394"
        }
      ],
      "repairHistoryPreserved": [
        "Original duplicate-key migration failure on V1.0.20261010 is preserved; that already-authored migration remains checksum-preserved.",
        "Forward repair V1.0.20261012 prepares API-aware uniqueness, restores exact fire API resources, creates explicit fire business roles, grants resources, and keeps user membership environment-specific.",
        "Runtime observation 66468b61-53b6-474b-bc4e-7a24562e2492 showed spare add failed with business message 编码规则不存在: FIRE_SPARE_WORK_ORDER; V1.0.20261013 repairs only that missing numbering rule."
      ]
    }
  }
];
  const before = JSON.stringify(reports);
  const groups = reports.map(report => buildSubview('test-executions', [report]));
  assert.deepEqual(groups.map(rows => rows.length), [3, 2]);
  const { readFile } = await import('node:fs/promises');
  const ui = await readFile(new URL('../docker/harness/conversation-gateway/delivery-center.js', import.meta.url), 'utf8');
  const start = ui.indexOf('  const stageDeclaration =');
  const end = ui.indexOf("  if(kind==='test'&&!stageDeclaration)", start);
  assert.ok(start >= 0 && end > start);
  const render = new Function('item', 'body', 'detailSection', 'state', ui.slice(start, end));
  for (const [index, report] of reports.entries()) {
    const key = index === 0 ? 'verificationReceipts' : 'directVerification';
    const state = {detailAnchors: new Map()};
    render(report, {append() {}}, (title, value) => ({title, value}), state);
    for (const [position, row] of groups[index].entries()) {
      const original = report.details[key][position];
      assert.equal(row.receiptId, original.receiptId);
      assert.equal(row.executionStatus, original.status ?? original.recordedStatus);
      assert.equal(row.localId, '/details/' + key + '/' + position);
      assert.deepEqual(row.parentRef, {kind: 'test', id: report.id, revision: report.revision});
      assert.deepEqual(state.detailAnchors.get(row.localId).value, original);
      assert.equal(row.sourcePhaseStatus, 'historical');
      assert.match(row.executionKind, /历史阶段.*非本次验证/);
      assert.match(row.recordMeaning, /历史阶段.*未经本中心单独复核/);
      assert.equal(row.verification, undefined);
      assert.ok(row.limitations.includes(report.details.notRunInThisPhase ?? report.details.notYetProven));
    }
  }
  assert.ok(groups[0][0].limitations.includes(reports[0].details.verificationReceipts[0].truthBoundary));
  assert.ok(groups[0][0].limitations.includes(reports[0].details.verificationReceipts[0].advisoriesOrRequiresRetained));
  assert.equal(groups[0][2].executionCounts, '1581 / 1581 / 0 / 0');
  assert.equal(groups[1][1].executionCounts, '1578 / 1578 / 0 / 0');
  assert.equal(JSON.stringify(reports), before);
  const precedence = structuredClone(reports[0]);
  precedence.details.verificationReceipts[0].status = 'failed';
  assert.equal(buildSubview('test-executions', [precedence])[0].executionStatus, 'failed');
});

test('historical roleVisibilityContract role arrays keep exact business rows without promoting seed policies or authorization', () => {
  // Exact shape and declared values from permission-original-source-20261009.json; no business fixture is authored here.
  const parent = {"id":"asset-7b9103fe144a2a5bf89d864fcb18279c","kind":"permission","name":"权限接线 · roleVisibilityContract","revision":"612333cf015564631e5089725cf230b12d5c0fbd7d3820c79aadde707abee229","recordType":"permission-contract","sourceTopic":"roleVisibilityContract","status":"recorded","sourcePhaseStatus":"historical","isCurrent":false,"sources":[{"label":"权限接线","digest":"56fafcd76cc2fe459a87a095cac4d1914fca17e5fe2c6182928e469c6553a545","taskId":"c-0e254375986948ea7b361297","batchId":"batch-228f2b518c1b93f9285e5dc511d1f58d","pointer":"/roleVisibilityContract","stageId":"stage-18d2b122cbefdfa72cbb756a113d2939","sessionId":"session-1faee0dc-2df0-5cb6-bf56-0a557e135bbe"}]};
  parent.details = {
    roles: [
      {"roleKey":"FIRE_MANAGEMENT","dataScope":"AUTHORIZED_ORG_ZONE_DEVICE","displayNameZh":"消防管理岗位","visibleCapabilities":["全部设施、检测维保记录、检查项、报告和备件权限","business:fireEquipment:attachment","business:fireAlarm:list","business:fireMap:list"]},
      {"roleKey":"APPLICANT","dataScope":"OWN_DRAFTS and OWN_APPLICATIONS","displayNameZh":"申请人","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:apply","business:fireWaterApproval:list","business:fireWaterApproval:apply","business:fireIsolationApproval:list","business:fireIsolationApproval:apply"]},
      {"roleKey":"MAINTENANCE_UNIT_INSPECTOR","dataScope":"ASSIGNED_TASKS","displayNameZh":"检测人（维保单位）","visibleCapabilities":["business:fireInspection:list","business:fireInspection:signMaintainer"]},
      {"roleKey":"FIRE_MANAGEMENT_SIGNER","dataScope":"ASSIGNED_TASKS","displayNameZh":"消防管理人（装置、部）","visibleCapabilities":["business:fireInspection:list","business:fireInspection:signFireManager"]},
      {"roleKey":"EQUIPMENT_MANAGEMENT_AUDITOR","dataScope":"ASSIGNED_TASKS","displayNameZh":"审核人（设备管理部）","visibleCapabilities":["business:fireInspection:list","business:fireInspection:audit"]},
      {"roleKey":"DEVICE_MANAGER_APPROVER","dataScope":"ASSIGNED_TASKS","displayNameZh":"装置经理","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:approve","business:fireIsolationApproval:list","business:fireIsolationApproval:approve"]},
      {"roleKey":"EHSS_FIRE_SPECIALIST_APPROVER","dataScope":"ASSIGNED_TASKS","displayNameZh":"EHSS部消气防专业","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:approve"]},
      {"roleKey":"EHSS_TRAFFIC_SPECIALIST_APPROVER","dataScope":"ASSIGNED_TASKS","displayNameZh":"EHSS部治安交通专业","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:approve"]},
      {"roleKey":"FIRE_BRIGADE_APPROVER","dataScope":"ASSIGNED_TASKS","displayNameZh":"消防队","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:approve"]},
      {"roleKey":"EHSS_DEPARTMENT_APPROVER","dataScope":"ASSIGNED_TASKS","displayNameZh":"EHSS部","visibleCapabilities":["business:fireWaterApproval:list","business:fireWaterApproval:approve","business:fireIsolationApproval:list","business:fireIsolationApproval:approve"]},
      {"roleKey":"OPERATIONS_DEPARTMENT_APPROVER","dataScope":"ASSIGNED_TASKS","displayNameZh":"运营部","visibleCapabilities":["business:fireWaterApproval:list","business:fireWaterApproval:approve","business:fireIsolationApproval:list","business:fireIsolationApproval:approve"]},
      {"roleKey":"EHSS_DEPARTMENT_MANAGER_APPROVER","dataScope":"ASSIGNED_TASKS","displayNameZh":"EHSS部门经理","visibleCapabilities":["business:fireWaterApproval:list","business:fireWaterApproval:approve","business:fireIsolationApproval:list","business:fireIsolationApproval:approve"]},
      {"roleKey":"OPERATIONS_GENERAL_MANAGER_APPROVER","dataScope":"ASSIGNED_TASKS","displayNameZh":"运营部门总经理","visibleCapabilities":["business:fireWaterApproval:list","business:fireWaterApproval:approve","business:fireIsolationApproval:list","business:fireIsolationApproval:approve"]},
      {"roleKey":"PRODUCTION_DISPATCHER","dataScope":"ASSIGNED_TASKS","displayNameZh":"生产调度","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:dispatch","business:fireWaterApproval:list","business:fireWaterApproval:dispatch","business:fireIsolationApproval:list","business:fireIsolationApproval:dispatch"]},
    ],
    tenantId: 1,
    denyRules: ["No-role and ordinary users receive no fire page, button or API access from this wiring.","UI visibility does not replace backend @SaCheckPermission and exact API-resource authorization.","Task handlers and approval actors can act only on assigned current tasks.","This FIRE_SPARE_WORK_ORDER repair does not add roles, broaden permissions or bind users."],
    roleSeedPolicy: {"isSystem":1,"roleType":3,"dataScope":3,"roleStatus":1,"userBinding":"No production user-to-role membership is seeded; protected test identity binding remains environment-specific.","orgScopeType":2,"orgApplicability":"Active fire business roles are associated with active tenant organizations through sys_role_org."},
    excludedUserPageRoles: ["EXTERNAL_FIRE_ALARM_SYSTEM","DCS_SYSTEM"],
  };
  const original = structuredClone(parent);
  const rows = buildSubview('permission-rules', [parent]);
  assert.equal(rows.length, 14);
  assert.equal(rows[0].subject, '消防管理岗位');
  assert.equal(rows[1].subject, '申请人');
  assert.equal(rows[1].subjectKey, 'APPLICANT');
  assert.equal(rows[1].dataScope, 'OWN_DRAFTS and OWN_APPLICATIONS');
  assert.equal(rows[2].dataScope, 'ASSIGNED_TASKS');
  assert.ok(rows.every(row => row.subjectKey !== 'roleSeedPolicy'));
  for (const [index, row] of rows.entries()) {
    assert.deepEqual(row.parentRef, { kind: 'permission', id: parent.id, revision: parent.revision });
    assert.equal(row.revision, parent.revision);
    assert.equal(row.localId, `/details/roles/${index}`);
    assert.deepEqual(row.canSee, parent.details.roles[index].visibleCapabilities);
    assert.equal(row.canPerform, undefined); assert.equal(row.canAct, undefined);
    assert.equal(row.decision, undefined); assert.equal(row.verification, undefined);
    assert.deepEqual(row.denialConditions, parent.details.denyRules);
    assert.deepEqual(row.sources, parent.sources);
    assert.equal(row.sourcePhaseStatus, 'historical'); assert.equal(row.status, 'recorded');
    assert.equal(row.isCurrent, false); assert.match(row.recordMeaning, /历史阶段.*未证明当前授权或执行/u);
  }
  assert.deepEqual(parent, original);
  const numericScope = structuredClone(parent); numericScope.details.roles[0].dataScope = 3;
  assert.equal(buildSubview('permission-rules', [numericScope])[0].dataScope, null, 'Undefined numeric scope codes are not business range meanings.');
  assert.equal(numericScope.details.roles[0].dataScope, 3);
});
