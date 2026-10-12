import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { deliveryResponse } from '../docker/harness/delivery-center-http.mjs';
import { deliveryTabs } from '../docker/harness/conversation-gateway/delivery-center-views.js';
import { projectDeliverySnapshot } from '../docker/harness/delivery-center-projection.mjs';
import {
  DeliveryCenterStore,
  createDeliveryCenterPool,
  escapeDeliveryLike,
  readDeliveryCenterDatabaseConfig,
  validateDeliverySnapshot,
} from '../docker/harness/delivery-center-store.mjs';

function fixture(projectSlug = 'delivery-test') {
  const requirement = { id: 'function-one', menuId: 'menu-child', menuPath: ['消防管理', '设备台账'], page: '设备台账',
    name: '设备查询', description: '支持名称及100%状态_精确筛选', fields: [{ name: '设备名称', required: true }],
    actions: [{ name: '查询' }], rules: ['名称允许中文'], permissions: ['业务系统中的查看规则'],
    batchIds: ['batch-one', 'batch-two'], stageStatus: { requirements: 'accepted', frontend: 'unknown' },
    status: 'specified', sources: [{ batchId: 'batch-one', stageId: 'stage-one', digest: 'a'.repeat(64), label: '已接受需求' },
      { batchId: 'batch-two', stageId: null, digest: null, label: '补充来源' }], revision: 1 };
  return { schemaVersion: 1, project: { slug: projectSlug, name: '需求与交付测试项目' }, observedAt: '2026-10-07T10:00:00.000Z',
    batches: [{ id: 'batch-one', name: '第一批', createdAt: null }, { id: 'batch-two', name: '第二批', createdAt: null }],
    menus: [{ id: 'menu-root', parentId: null, name: '消防管理', path: ['消防管理'] },
      { id: 'menu-child', parentId: 'menu-root', name: '设备台账', path: ['消防管理', '设备台账'] }],
    requirements: [requirement], stages: [{ id: 'stage-one', batchId: 'batch-one', phaseId: 'requirements', name: '需求',
      status: 'accepted', digest: 'a'.repeat(64), summary: '第一版', details: {}, createdAt: null, isCurrent: true }],
    releases: [{ id: 'release-one', version: '1.0.0', commit: 'c'.repeat(40), environment: 'production', status: 'success',
      releasedAt: '2026-09-20T10:00:00.000Z', requirementIds: [requirement.id, 'unrecorded-function'],
      requirementSnapshots: [structuredClone(requirement)], artifactIds: ['artifact-one'] }],
    artifacts: [{ id: 'artifact-one', releaseId: 'release-one', stageId: null, type: 'image', digest: 'sha256:' + 'd'.repeat(64) }],
    coverage: { privateConversationsExcluded: true, requirementSnapshotStatus: 'partial' } };
}

function fakePool(executor = async () => [[], []]) {
  const calls = [];
  const connection = {
    async execute(sql, parameters = []) { calls.push({ operation: 'execute', sql, parameters }); return executor(sql, parameters); },
    async beginTransaction() { calls.push({ operation: 'begin' }); },
    async commit() { calls.push({ operation: 'commit' }); },
    async rollback() { calls.push({ operation: 'rollback' }); },
    release() { calls.push({ operation: 'release' }); },
  };
  return { calls, execute: connection.execute.bind(connection), getConnection: async () => connection, end: async () => {} };
}

test('stage report views preserve dynamic source keys in scoped batched SQL while summaries stay narrow', async () => {
  const asset = (id, kind, recordType, details) => ({ id:`version-${id}`, kind:'specification-asset',stageId:'stage-one',payload:{assetId:id,kind,recordType,name:id,revision:`${id}-r1`,sourceTopic:id,sourcePhaseStatus:'accepted',status:'recorded',menuIds:[],menuPaths:[],batchIds:[],sources:[],details} });
  const originals=[asset('roles','permission','permission-contract',{CUSTOM_APPLICANT:{displayNameZh:'申请人',canPerform:['submit own'],dataScope:'OWN'},taskHandlerRoles:{roleKeys:['ONE','TWO'],canAct:['assigned']},denyRules:['no wildcard']}),
    asset('enforcement','permission','permission-enforcement',{dataScopes:{CUSTOM_HANDLER:'ASSIGNED'},assignedTaskRules:['persisted assignee']}),
    asset('report','test','test-evidence-report',{namedBackendCheck:{profile:'backend-module-test',receiptId:'receipt-1',status:'passed',executed:9,passed:8,failed:0,skipped:1},focusedTests:[{path:'source-test'}]}),
    asset('ordinary','permission','permission',{PRIVATE_DYNAMIC:{mustNotLeak:true}})];
  const delivered=[];
  const pool=fakePool(async(sql,parameters)=>{
    if(sql.includes('SELECT coverage'))return [[{coverage:{}}],[]];
    if(sql.includes('delivery_center_artifacts a')&&sql.includes('ORDER BY a.id'))return [originals.map(original=>{
      const {details,...payload}=original.payload;return {stage_current:1,data:{...original,payload}};
    }),[]];
    if(sql.includes('delivery_center_artifacts a')&&sql.includes('a.id IN')){
      const full=sql.includes('THEN JSON_EXTRACT(a.data, \'$.payload.details\')');
      const keys=[...sql.matchAll(/JSON_EXTRACT\(a.data, '\$\.payload\.details\.([^']+)'\)/g)].map(match=>match[1]);
      const rows=originals.filter(item=>parameters.includes(item.id)).map(item=>({data:{id:item.id,payload:{details:full&&['permission-contract','permission-enforcement','test-evidence-report'].includes(item.payload.recordType)?structuredClone(item.payload.details):Object.fromEntries(keys.filter(key=>Object.hasOwn(item.payload.details,key)).map(key=>[key,item.payload.details[key]]))}}}));
      delivered.push({sql,parameters,rows});return [rows,[]];
    }
    return [[],[]];
  });
  const store=new DeliveryCenterStore({pool});
  const allowed=['permission-rules','permission-matrix','permission-evidence','test-executions','test-cases'];
  for(const view of [...allowed,'acceptance','issues']){
    const before=delivered.length;const result=await store.listView('delivery-test',{view});
    assert.equal(delivered.length-before,1,`${view} must batch bodies once, not per asset`);
    const query=delivered.at(-1);assert.equal(query.sql.includes('THEN JSON_EXTRACT'),allowed.includes(view));
    assert.ok(query.parameters.length>1);assert.match(query.sql,/a\.id IN \(/);
    if(allowed.includes(view)){
      assert.match(query.sql,/'permission-contract', 'permission-enforcement', 'test-evidence-report'/);
      for(const row of query.rows){const original=originals.find(item=>item.id===row.data.id);if(original.payload.recordType!=='permission')assert.deepEqual(row.data.payload.details,original.payload.details);else assert.equal(row.data.payload.details.PRIVATE_DYNAMIC,undefined);}
    }
    if(view==='permission-rules'){assert.equal(result.items.length,3);assert.ok(result.items.some(item=>item.subject==='申请人'));assert.ok(result.items.some(item=>item.localId==='/details/dataScopes/CUSTOM_HANDLER'));}
    if(view==='test-executions'){assert.equal(result.items.length,1);assert.equal(result.items[0].receiptId,'receipt-1');assert.equal(result.items[0].parentRef.revision,'report-r1');assert.equal(result.items[0].localId,'/details/namedBackendCheck');assert.equal(result.items[0].executionCounts,'9 / 8 / 0 / 1');}
  }
  const before=delivered.length;const summary=await store.listAssets('delivery-test',{projection:'summary'});
  assert.equal(delivered.length-before,1);assert.doesNotMatch(delivered.at(-1).sql,/THEN JSON_EXTRACT/);
  assert.equal(summary.items.find(item=>item.assetId==='roles').details.CUSTOM_APPLICANT,undefined);
  assert.equal(summary.items.find(item=>item.assetId==='report').details.namedBackendCheck,undefined);
  const columns=deliveryTabs.permissions.columns;assert.equal(columns.filter(column=>column.key==='recordMeaning').length,1);assert.ok(columns.some(column=>column.key==='roles|roleKeys'&&column.label==='组内角色'));
  assert.ok(columns.find(column=>column.key==='denialConditions').label.includes('原报告共同'));
  assert.ok(columns.find(column=>column.key==='taskConditions|conditions|preconditions').label.includes('原报告共同'));
  const executions=deliveryTabs['test-executions'].columns;assert.equal(executions.find(column=>column.key==='profile|caseRef|testCase|name').format,'ref');
  for(const key of ['evidence','verdict'])assert.equal(executions.find(column=>column.key===key).optional,true);
});

test('delivery snapshots preserve unknowns and reject duplicate current entities before any database access', async () => {
  const input = fixture();
  const validated = validateDeliverySnapshot(input);
  assert.equal(validated.stages[0].createdAt, null);
  assert.equal(validated.requirements[0].stageStatus.frontend, 'unknown');
  assert.notEqual(validated, input);
  const duplicate = fixture(); duplicate.requirements.push(structuredClone(duplicate.requirements[0]));
  const pool = fakePool();
  await assert.rejects(new DeliveryCenterStore({ pool }).importSnapshot(duplicate), { code: 'DELIVERY_INPUT_INVALID' });
  assert.deepEqual(pool.calls, []);
  const invalidStage = fixture(); invalidStage.stages[0].isCurrent = 'true';
  assert.throws(() => validateDeliverySnapshot(invalidStage), { code: 'DELIVERY_INPUT_INVALID' });
});

test('function association requirements constrain current historical and release SQL without selecting unknown target revisions', async () => {
  const functionId = 'budget.function.budget-ledger-maintenance';
  const requirement = { ...fixture().requirements[0], revision: 'requirement-r2', functionRefs: [{ kind: 'function', id: functionId, revision: null }] };
  for (const extra of ['', '&batchId=batch-one', '&releaseId=release-one']) {
    const pool = fakePool(async sql => sql.includes('COUNT(*)') ? [[{ total: 1 }], []]
      : sql.includes('delivery_center_requirements') || sql.includes('delivery_center_requirement_versions') || sql.includes('delivery_center_release_requirements')
        ? [[{ data: requirement }], []] : [[], []]);
    const store = new DeliveryCenterStore({ pool });
    const url = new URL(`http://local/forge-gateway/api/delivery/requirements?project=delivery-test&projection=summary&page=2&pageSize=3&functionId=${functionId}${extra}`);
    const { body } = await deliveryResponse({ method: 'GET', url, store });
    assert.equal(body.items[0].revision, 'requirement-r2');
    assert.deepEqual(body.items[0].functionAssociation, { id: functionId, revision: null, binding: 'identity-only', refs: requirement.functionRefs });
    assert.equal(body.scope.filters.functionId, functionId);
    const column = extra.includes('releaseId') ? 'r.snapshot' : 'r.data';
    const queries = pool.calls.filter(call => call.sql?.includes('JSON_CONTAINS') && call.sql.includes('$.functionRefs'));
    assert.equal(queries.length, 2);
    for (const call of queries) {
      assert.ok(call.sql.includes(`JSON_CONTAINS(JSON_EXTRACT(${column}, '$.functionRefs'), CAST(? AS JSON))`));
      assert.ok(call.parameters.includes(JSON.stringify({ kind: 'function', id: functionId })));
      assert.ok(!call.sql.includes(functionId));
    }
    assert.deepEqual(queries.find(call => call.sql.includes('LIMIT ? OFFSET ?')).parameters.slice(-2), [3, 3]);
    const exactFilters = { functionId, functionRevision: 'definition-r1', ...(extra.includes('releaseId') ? { releaseId: 'release-one' } : extra ? { batchId: 'batch-one', _definitionScope: true } : {}) };
    await store.exportRequirements('delivery-test', exactFilters);
    const exported = pool.calls.find(call => call.sql?.includes('LIMIT 100001'));
    assert.ok(exported.parameters.includes(JSON.stringify({ kind: 'function', id: functionId, revision: 'definition-r1' })));
    assert.ok(exported.sql.includes(`JSON_EXTRACT(${column}, '$.functionRefs')`));
  }
});

test('legacy statement search uses the same bounded escaped filter for current historical and released requirements', async () => {
  for (const filters of [{}, { batchId: 'batch-one', _definitionScope: true }, { releaseId: 'release-one' }]) {
    const pool = fakePool(async sql => sql.includes('COUNT(*)') ? [[{ total: 0 }], []] : [[], []]);
    const store = new DeliveryCenterStore({ pool });
    await store.listRequirements('delivery-test', { ...filters, q: 'fileId%_!', page: 2, pageSize: 7 });
    await store.exportRequirements('delivery-test', { ...filters, q: 'fileId%_!' });
    const column = filters.releaseId ? 'r.snapshot' : 'r.data';
    const queries = pool.calls.filter(call => call.sql?.includes('FROM ') && call.sql.includes('r.search_text LIKE'));
    assert.equal(queries.length, 3);
    for (const call of queries) {
      assert.ok(call.sql.includes(`COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.description')), 'null'), '') = ''`));
      assert.ok(call.sql.includes(`JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.details.statement')) LIKE ? ESCAPE '!'`));
      assert.equal(call.parameters.filter(value => value === '%fileId!%!_!!%').length, 2);
      assert.ok(!call.sql.includes('fileId'));
    }
    assert.deepEqual(queries.find(call => call.sql.includes('LIMIT ? OFFSET ?')).parameters.slice(-2), [7, 7]);
    assert.ok(queries.find(call => call.sql.includes('LIMIT 100001')));
    assert.ok(queries.every(call => filters.releaseId ? call.sql.includes('delivery_center_release_requirements')
      : filters.batchId ? call.sql.includes('delivery_center_requirement_versions') : call.sql.includes('r.is_current = TRUE')));
    await assert.rejects(store.listRequirements('delivery-test', { q: 'x'.repeat(257) }), { code: 'DELIVERY_INPUT_INVALID' });
  }
});

test('delivery query binds search and filter values, escapes LIKE wildcards, and includes descendant menus', async () => {
  const pool = fakePool(async (sql) => sql.includes('COUNT(*)') ? [[{ total: 1 }], []]
    : sql.includes('delivery_center_menus') ? [fixture().menus.map((data) => ({ data })), []]
      : [[{ data: JSON.stringify(fixture().requirements[0]) }], []]);
  const store = new DeliveryCenterStore({ pool });
  const q = "100%状态_! ' OR 1=1 --";
  const result = await store.listRequirements('delivery-test', { q, menuId: 'menu-root', batchId: 'batch-one', page: 2, pageSize: 20 });
  assert.equal(result.total, 1); assert.equal(result.page, 2); assert.equal(result.items[0].name, '设备查询');
  const count = pool.calls.find((call) => call.sql?.includes('COUNT(*)'));
  assert.ok(!count.sql.includes(q));
  assert.ok(count.sql.includes("ESCAPE '!'") && count.sql.includes('r.menu_id IN (?, ?)'));
  assert.deepEqual(count.parameters, ['delivery-test', 'menu-root', 'menu-child', JSON.stringify(['menu-root', 'menu-child']), 'batch-one', `%${escapeDeliveryLike(q)}%`, `%${escapeDeliveryLike(q)}%`]);
  assert.match(count.sql, /JSON_OVERLAPS\(JSON_EXTRACT\(r.data, '\$\.menuIds'\)/u);
  assert.equal(escapeDeliveryLike('%_!\\'), '!%!_!!\\');
  await assert.rejects(store.listRequirements('delivery-test', { pageSize: 201 }), { code: 'DELIVERY_INPUT_INVALID' });
});

test('historical menu trees and descendant exports use frozen paths even without menu ids or current menus', async () => {
  const frozen = { ...fixture().requirements[0], menuId: undefined, menuPath: ['旧版消防', '已撤销台账'] };
  const pool = fakePool(async (sql) => sql.startsWith('SELECT DISTINCT')
    ? [[{ menu_path: JSON.stringify(frozen.menuPath) }], []]
    : sql.includes('COUNT(*)') ? [[{ total: 1 }], []] : [[{ data: frozen }], []]);
  const store = new DeliveryCenterStore({ pool });
  const menus = await store.listMenus('delivery-test', { releaseId: 'release-one' });
  const parent = menus.find((menu) => menu.parentId === null);
  assert.equal(parent.name, '旧版消防');
  assert.equal(menus.find((menu) => menu.parentId === parent.id).name, '已撤销台账');
  const filters = { releaseId: 'release-one', menuId: parent.id };
  assert.equal((await store.listRequirements('delivery-test', filters)).total, 1);
  assert.equal((await store.exportRequirements('delivery-test', filters))[0].menuId, undefined);
  assert.ok(pool.calls.every((call) => !call.sql?.includes('FROM delivery_center_menus')));
  const query = pool.calls.find((call) => call.sql?.includes('COUNT(*)'));
  assert.ok(query.sql.includes("JSON_EXTRACT(r.snapshot, '$.menuPath[0]') = CAST(? AS JSON)"));
  assert.deepEqual(query.parameters, ['delivery-test', 'release-one', JSON.stringify('旧版消防')]);
  await store.listRequirements('delivery-test', { ...filters, menuId: 'nonexistent' });
  assert.ok(pool.calls.some((call) => call.sql?.includes('1 = 0')));
});

test('failed import rolls back the project update and releases its connection', async () => {
  const pool = fakePool(async (sql) => {
    if (sql.startsWith('SELECT snapshot_digest')) return [[{ snapshot_digest: '' }], []];
    if (sql.startsWith('INSERT INTO delivery_center_requirements')) throw new Error('injected write failure');
    return [[], []];
  });
  await assert.rejects(new DeliveryCenterStore({ pool }).importSnapshot(fixture()), /injected write failure/u);
  assert.equal(pool.calls.filter((call) => call.operation === 'rollback').length, 1);
  assert.equal(pool.calls.filter((call) => call.operation === 'commit').length, 0);
  assert.equal(pool.calls.at(-1).operation, 'release');
});

test('release requirement details read only frozen release snapshots and all tabs apply search', async () => {
  const pool = fakePool(async (sql) => sql.includes('COUNT(*)') ? [[{ total: 1 }], []] : [[{ data: { id: 'function-one', name: '历史功能' } }], []]);
  const store = new DeliveryCenterStore({ pool });
  const historical = await store.getRequirement('delivery-test', 'function-one', { releaseId: 'release-one' });
  assert.equal(historical.name, '历史功能'); assert.equal(historical.isCurrent, false);
  assert.match(pool.calls[0].sql, /FROM delivery_center_release_requirements/u);
  assert.deepEqual(pool.calls[0].parameters, ['delivery-test', 'release-one', 'function-one']);
  for (const method of ['listBatches', 'listStages', 'listReleases', 'listArtifacts']) {
    await store[method]('delivery-test', { q: '状态_100%', ...(method === 'listBatches' ? { batchId: 'batch-two' } : {}) });
    const query = pool.calls.at(-1);
    assert.match(query.sql, /CAST\(data AS CHAR CHARACTER SET utf8mb4\) LIKE \? ESCAPE '!'/u);
    assert.ok(query.parameters.includes('%状态!_100!%%'));
    if (method === 'listBatches') { assert.match(query.sql, / AND id = \?/u); assert.ok(query.parameters.includes('batch-two')); }
  }
});

test('stage lists separate current history, keep task order and batch-read task identities without full payloads', async () => {
  const snapshots = [
    { id: 'stage-one', batchId: 'batch-one', phaseId: 'requirements', summary: '需求历史说明', digest: 'a'.repeat(64), details: { original: 'large-contract'.repeat(1000) } },
    { id: 'stage-two', batchId: 'batch-one', phaseId: 'backend', taskId: 'original-task', summary: '后端说明', digest: 'b'.repeat(64), details: { original: 'backend contract' } },
    { id: 'stage-three', batchId: 'batch-missing', phaseId: 'requirements', summary: '来源缺失', digest: null, details: {} },
  ];
  const pool = fakePool(async (sql, parameters) => {
    if (sql.includes('COUNT(*)')) return [[{ total: 3 }], []];
    if (sql.includes('FROM delivery_center_stages')) {
      assert.match(sql, /JSON_REMOVE\(data, '\$\.details'\) AS data, is_current, content_digest/u);
      assert.match(sql, /ORDER BY batch_id, CASE phase_id WHEN 'requirements' THEN 0/u);
      const phases = ['requirements','domain-contract','database','ui-design','backend','frontend','access-wiring','cross-layer-acceptance'];
      phases.forEach((phase, index) => assert.ok(sql.includes(`WHEN '${phase}' THEN ${index}`)));
      assert.match(sql, /created_at DESC, content_digest, id LIMIT \? OFFSET \?/u);
      return [snapshots.map((item, index) => ({ data: Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'details')), content_digest: String(index + 1).repeat(64), is_current: parameters[1] ? 1 : 0 })), []];
    }
    if (sql.includes('FROM delivery_center_batches')) {
      assert.deepEqual(parameters, ['delivery-test', 'batch-one', 'batch-missing']);
      assert.match(sql, /project_slug = \? AND id IN \(\?,\?\)/u);
      return [[{ id: 'batch-one', task_id: 'batch-recorded-task' }], []];
    }
    if (sql.includes('FROM delivery_center_projects')) return [[{ snapshot_digest: 'f'.repeat(64), observed_at: '2026-10-09T00:00:00Z' }], []];
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const store = new DeliveryCenterStore({ pool });
  for (const filters of [{ projection: 'summary' }, { projection: 'summary', isCurrent: 'false' }]) {
    const start = pool.calls.length;
    const result = await store.listStages('delivery-test', filters);
    assert.equal(result.items[0].taskId, 'batch-recorded-task');
    assert.equal(result.items[1].taskId, 'original-task');
    assert.equal(result.items[2].taskId, undefined);
    assert.ok(result.items.every(item => item.isCurrent === (filters.isCurrent !== 'false')));
    assert.equal(result.items[0].revision, '1'.repeat(64));
    assert.equal(result.items[0].digest, 'a'.repeat(64));
    assert.equal(result.items[0].summary, '需求历史说明');
    assert.ok(result.items.every(item => !('details' in item) && !('sessionId' in item) && !('artifactCount' in item) && !('acceptance' in item)));
    const calls = pool.calls.slice(start).filter(call => call.operation === 'execute');
    assert.equal(calls.filter(call => call.sql.includes('FROM delivery_center_batches')).length, 1);
    assert.ok(calls.filter(call => call.sql.includes('FROM delivery_center_stages')).every(call => call.sql.includes('is_current = ?') && call.parameters[1] === (filters.isCurrent !== 'false')));
  }
  assert.equal(snapshots[0].taskId, undefined, 'read enrichment must not mutate the stored source');
});

test('stage detail reads the exact stored snapshot without selecting another revision or copying a current session', async () => {
  const first = { id: 'same-stage', batchId: 'batch-one', digest: 'a'.repeat(64), summary: '旧说明', details: { contract: 'original payload' } };
  const second = { ...first, summary: '新说明', details: { contract: 'changed payload' } };
  const pool = fakePool(async (sql, parameters) => {
    assert.match(sql, /s\.project_slug = \? AND s\.id = \? AND s\.content_digest = \?/u);
    assert.match(sql, /b\.project_slug = s\.project_slug AND b\.id = s\.batch_id/u);
    assert.deepEqual(parameters.slice(0, 2), ['delivery-test', 'same-stage']);
    if (parameters.length === 4) {
      assert.match(sql, /AND s\.batch_id = \?/u);
      if (parameters[3] !== 'batch-one') return [[], []];
    }
    const source = parameters[2] === '1'.repeat(64) ? first : parameters[2] === '2'.repeat(64) ? second : null;
    return [source ? [{ data: source, content_digest: parameters[2], is_current: source === second ? 1 : 0, batch_task_id: 'original-task' }] : [], []];
  });
  const store = new DeliveryCenterStore({ pool });
  assert.equal(await store.getStage('delivery-test', 'same-stage'), null);
  assert.equal(pool.calls.length, 0);
  const old = await store.getStage('delivery-test', 'same-stage', { revision: '1'.repeat(64) });
  assert.deepEqual(old.details, first.details); assert.equal(old.summary, '旧说明'); assert.equal(old.isCurrent, false);
  assert.equal(old.revision, '1'.repeat(64)); assert.equal(old.digest, 'a'.repeat(64)); assert.equal(old.taskId, 'original-task');
  assert.equal(old.sessionId, undefined); assert.equal(first.taskId, undefined);
  assert.deepEqual((await store.getStage('delivery-test', 'same-stage', { revision: '2'.repeat(64) })).details, second.details);
  assert.equal(await store.getStage('delivery-test', 'same-stage', { revision: '3'.repeat(64) }), null);
  assert.equal(await store.getStage('delivery-test', 'same-stage', { revision: '1'.repeat(64), batchId: 'another-batch' }), null);
  assert.deepEqual((await store.getStage('delivery-test', 'same-stage', { revision: '1'.repeat(64), batchId: 'batch-one', isCurrent: true })).details, first.details);
});

test('release scope annotation adds a bound snapshot once, preserves old facts and rejects later changes transactionally', async () => {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  const previous = { ...fixture().releases[0], jobId: 'runner-job-one', taskId: 'fire-task',
    requirementIds: [], requirementSnapshots: [], scopeBinding: 'unknown' };
  const kinds = ['requirements-contract', 'domain-api-contract', 'database-implementation', 'ui-interaction-contract',
    'backend-implementation', 'frontend-implementation', 'access-wiring-implementation', 'cross-layer-acceptance'];
  const next = { ...structuredClone(previous), scopeBinding: 'frozen-explicit-snapshot', scope: 'validated-task-delivery',
    scopeBindingReason: null, requirementIds: ['function-one'], requirementSnapshots: [fixture().requirements[0]],
    scopeBindingEvidence: { projectSlug: 'delivery-test', taskId: previous.taskId, commit: previous.commit,
      runnerJobId: previous.jobId, sourceFingerprint: '1'.repeat(64), acceptanceGateDigest: '2'.repeat(64),
      stateDigest: '3'.repeat(64), snapshotDigest: '4'.repeat(64), baseSourceCommit: '6'.repeat(40),
      phasePatchDigest: '7'.repeat(64), scope: 'validated-task-delivery',
      acceptedArtifactDigests: Object.fromEntries(kinds.map((kind) => [kind, '5'.repeat(64)])) } };
  let stored = { content_digest: hash(previous), data: JSON.stringify(previous) };
  let rows = []; let checkpoint; let failSnapshotInsert = false;
  const pool = fakePool(async (sql, parameters) => {
    if (sql.startsWith('SELECT snapshot_digest')) return [[{ snapshot_digest: '' }], []];
    if (sql.startsWith('SELECT content_digest, data FROM delivery_center_releases')) return [[structuredClone(stored)], []];
    if (sql.startsWith('SELECT COUNT(*) AS total FROM delivery_center_release_requirements')) return [[{ total: rows.length }], []];
    if (sql.startsWith('UPDATE delivery_center_releases SET')) {
      assert.equal(parameters[4], stored.content_digest);
      stored = { content_digest: parameters[0], data: parameters[1] };
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith('INSERT INTO delivery_center_release_requirements')) {
      if (failSnapshotInsert) throw new Error('injected frozen row failure');
      rows.push(JSON.parse(parameters[5]));
    }
    return [[], []];
  });
  const baseConnection = pool.getConnection;
  pool.getConnection = async () => {
    const connection = await baseConnection();
    return { ...connection,
      async beginTransaction() { checkpoint = structuredClone({ stored, rows }); await connection.beginTransaction(); },
      async rollback() { ({ stored, rows } = checkpoint); await connection.rollback(); },
    };
  };
  const store = new DeliveryCenterStore({ pool });
  const snapshot = (release) => ({ ...fixture(), batches: [], menus: [], requirements: [], stages: [], artifacts: [], releases: [release] });
  await store.importSnapshot(snapshot({ ...previous, scope: 'unknown', scopeBindingReason: 'NO_VALIDATED_TASK_SNAPSHOT', scopeBindingEvidence: null }));
  assert.deepEqual(JSON.parse(stored.data), previous, 'unknown metadata normalization must retain the original record');
  await store.importSnapshot(snapshot({ ...previous, scope: 'unknown', scopeBindingReason: 'PHASE_DELIVERY_NOT_COMPLETED', scopeBindingEvidence: null }));
  assert.deepEqual(JSON.parse(stored.data), previous, 'a later unbound explanation must not rewrite original release facts or block the project');
  assert.equal(pool.calls.filter((call) => call.sql?.startsWith('UPDATE delivery_center_releases SET')).length, 0);
  await store.importSnapshot(snapshot(next));
  const supplemented = structuredClone({ stored, rows });
  assert.deepEqual(JSON.parse(stored.data).annotationHistory, [{ kind: 'scope-binding-added', observedAt: fixture().observedAt,
    previousContentDigest: hash(previous), previousRelease: previous }]);
  assert.equal(stored.content_digest, hash(next));
  assert.deepEqual(rows, next.requirementSnapshots);
  await store.importSnapshot({ ...snapshot(next), observedAt: '2026-10-07T11:00:00.000Z' });
  assert.deepEqual({ stored, rows }, supplemented, 'repeated producer input must not append another annotation');
  const revisedFrozen = structuredClone(next); revisedFrozen.requirementSnapshots[0].description = 'a later definition';
  await assert.rejects(store.importSnapshot(snapshot(revisedFrozen)), { code: 'DELIVERY_RELEASE_IMMUTABLE', status: 409 });
  assert.deepEqual({ stored, rows }, supplemented);
  for (const change of [
    (value) => { value.version = 'different-version'; },
    (value) => { value.artifactIds = ['different-image']; },
    (value) => { value.scopeBindingEvidence.runnerJobId = 'unrelated-job'; },
    (value) => { value.scopeBindingEvidence.baseSourceCommit = 'not-a-commit'; },
    (value) => { delete value.scopeBindingEvidence.phasePatchDigest; },
    (value) => { delete value.scopeBindingEvidence.acceptedArtifactDigests['database-implementation']; },
    (value) => { value.requirementIds = ['different-function']; },
  ]) {
    stored = { content_digest: hash(previous), data: JSON.stringify(previous) }; rows = [];
    const invalid = structuredClone(next); change(invalid);
    await assert.rejects(store.importSnapshot(snapshot(invalid)), { code: 'DELIVERY_RELEASE_IMMUTABLE', status: 409 });
    assert.deepEqual(JSON.parse(stored.data), previous); assert.deepEqual(rows, []);
  }
  failSnapshotInsert = true;
  await assert.rejects(store.importSnapshot(snapshot(next)), /injected frozen row failure/u);
  assert.deepEqual(JSON.parse(stored.data), previous, 'the release update must roll back when frozen rows cannot be saved');
  assert.deepEqual(rows, []);
  const forged = { ...next, annotationHistory: [{ previousRelease: previous }] };
  await assert.rejects(store.importSnapshot(snapshot(forged)), { code: 'DELIVERY_INPUT_INVALID' });
});

test('release documentation from the checkpoint projection appends independently and preserves missing revisions without changing frozen facts', async () => {
  const project = { projectSlug: 'delivery-test', projectName: 'Platform fixture', observedAt: fixture().observedAt };
  const event = { type: 'controlled-release', projectSlug: project.projectSlug, jobId: 'job-docs', status: 'success',
    commit: 'c'.repeat(40), completedAt: project.observedAt, provenance: { taskId: 'task-docs' } };
  const empty = projectDeliverySnapshot({ ...project, releases: [event] }).releases[0];
  const document = revision => ({ path: 'code-copilot/changes/platform-fixture/spec.md', commit: 'd'.repeat(40),
    sourceScope: 'taskspace-checkpoint', batchId: 'checkpoint-docs', taskId: 'task-docs', committedAt: project.observedAt,
    records: [{ name: 'Recorded release explanation', description: `Preserved source ${revision}`, deliveryCenter: {
      schemaVersion: 1, kind: 'requirement', id: 'fixture:release-change', revision, recordType: 'release-change',
      nature: 'historical-compilation', sources: [{ kind: 'git', commit: event.commit }], relations: [{
        type: 'describes-release-change', to: { kind: 'release', id: empty.id, revision: event.commit },
        sources: [{ kind: 'git', commit: event.commit }] }] } }] });
  const projected = revisions => projectDeliverySnapshot({ ...project, releases: [event], checkpointDocuments: {
    batches: [], gaps: [], coverage: {}, documents: revisions.map(document) } }).releases[0];
  const documentationKeys = ['documentedChanges', 'documentedChangeCount', 'documentedChangePreview', 'scopeBindingDiagnostic'];
  for (const bound of [false, true]) {
    const previous = structuredClone(empty); for (const key of documentationKeys) delete previous[key];
    if (bound) Object.assign(previous, { scopeBinding: 'frozen-explicit-snapshot', scope: 'validated-task-delivery',
      scopeBindingReason: null, scopeBindingEvidence: { scope: 'validated-task-delivery', snapshotDigest: 'e'.repeat(64) },
      requirementIds: ['function-one'], requirementSnapshots: [fixture().requirements[0]] });
    let stored = { content_digest: '0'.repeat(64), data: JSON.stringify(previous) }; let saved; let updates = 0; let featureWrites = 0;
    const frozenBindings = structuredClone(previous.requirementSnapshots);
    const pool = fakePool(async (sql, parameters) => {
      if (sql.startsWith('SELECT snapshot_digest')) return [[{ snapshot_digest: '' }], []];
      if (sql.startsWith('SELECT content_digest, data FROM delivery_center_releases')) return [[structuredClone(stored)], []];
      if (sql.startsWith('UPDATE delivery_center_releases SET')) {
        assert.equal(parameters[4], stored.content_digest); updates++;
        stored = { content_digest: parameters[0], data: parameters[1] }; return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('delivery_center_release_requirements')) { featureWrites++; throw new Error('Documentation must not touch frozen bindings.'); }
      return [[], []];
    });
    const connection = await pool.getConnection();
    pool.getConnection = async () => ({ ...connection, async beginTransaction() { saved = structuredClone(stored); },
      async rollback() { stored = saved; } });
    const store = new DeliveryCenterStore({ pool });
    const input = revisions => {
      const emitted = projected(revisions);
      return { ...previous, ...Object.fromEntries(documentationKeys.map(key => [key, emitted[key]])),
        scopeBindingDiagnostic: revisions.length ? 'PHASE_DELIVERY_NOT_COMPLETED' : null };
    };
    const snapshot = release => ({ ...fixture(), batches: [], menus: [], requirements: [], stages: [], artifacts: [], releases: [release] });
    await store.importSnapshot(snapshot(input([])));
    assert.equal(updates, 0, 'Empty new fields are canonically equivalent to omitted legacy fields.');
    const first = input(['explanation-r1']);
    assert.equal(first.documentedChanges[0].sources[0].kind, 'committed-document');
    assert.equal(first.documentedChanges[0].sources[0].pointer, '/records/0');
    assert.equal(first.documentedChanges[0].provenance.sourceScope, 'taskspace-checkpoint');
    await store.importSnapshot(snapshot(first));
    const firstStored = structuredClone(stored);
    assert.equal(JSON.parse(stored.data).annotationHistory.length, 1);
    await store.importSnapshot(snapshot(first));
    await store.importSnapshot(snapshot(input([])));
    assert.deepEqual(stored, firstStored, 'Repeated or temporarily missing explanations preserve the exact previous record.');
    await store.importSnapshot(snapshot(input(['explanation-r2'])));
    const updated = JSON.parse(stored.data); const stableStored = structuredClone(stored);
    assert.equal(updates, 2); assert.equal(updated.documentedChangeCount, 2);
    assert.deepEqual(updated.documentedChanges.map(row => row.revision), ['explanation-r1', 'explanation-r2']);
    assert.equal(updated.documentedChangePreview.length, 2); assert.equal(updated.annotationHistory.length, 2);
    for (const key of ['commit', 'status', 'scope', 'scopeBinding', 'scopeBindingEvidence', 'requirementIds', 'requirementSnapshots', 'artifactIds']) {
      assert.deepEqual(updated[key], previous[key], key);
    }
    for (const mutate of [
      value => { value.status = 'failed'; },
      value => { value.artifactIds = ['different-image']; },
      value => { value.requirementIds = ['forged-feature']; },
      value => { value.scopeBindingEvidence = { snapshotDigest: 'f'.repeat(64) }; },
      value => { value.documentedChanges[0].description = 'Overwritten source revision'; },
      value => { value.commit = 'f'.repeat(40); for (const source of value.documentedChanges[0].sources) if (source.kind === 'git') source.commit = value.commit; },
    ]) {
      const invalid = input(['explanation-r1']); mutate(invalid);
      await assert.rejects(store.importSnapshot(snapshot(invalid)), { code: 'DELIVERY_RELEASE_IMMUTABLE' });
      assert.deepEqual(stored, stableStored);
    }
    assert.equal(featureWrites, 0); assert.deepEqual(previous.requirementSnapshots, frozenBindings);
  }
});

test('exports ignore UI pagination and keep query plus menu selection in one repeatable-read transaction', async () => {
  const pool = fakePool(async (sql) => sql.includes('delivery_center_menus') ? [fixture().menus.map((data) => ({ data })), []]
    : sql.startsWith('SELECT r.') ? [Array.from({ length: 3 }, (_, index) => ({ data: { id: `item-${index}` } })), []] : [[], []]);
  const result = await new DeliveryCenterStore({ pool }).exportRequirements('delivery-test', { menuId: 'menu-root', page: 999, pageSize: 1 });
  assert.equal(result.length, 3);
  assert.equal(pool.calls[0].sql, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  assert.equal(pool.calls[1].operation, 'begin');
  const select = pool.calls.find((call) => call.sql?.startsWith('SELECT r.'));
  assert.ok(select.sql.endsWith('LIMIT 100001'));
  assert.deepEqual(select.parameters, ['delivery-test', 'menu-root', 'menu-child', JSON.stringify(['menu-root', 'menu-child'])]);
  assert.deepEqual(pool.calls.slice(-2).map((call) => call.operation), ['commit', 'release']);
});

test('project directory avoids MySQL JSON filesort and exposes business coverage without large internal indexes', async () => {
  const coverage = { currentAssetVersionIds: Array.from({ length: 5000 }, (_, index) => `spec-${String(index).padStart(64, '0')}`), menuAliases: { old: '100' }, availability: 'ready' };
  assert.ok(Buffer.byteLength(JSON.stringify(coverage)) > 350000);
  const pool = fakePool(async sql => {
    if (/ORDER BY/iu.test(sql)) throw Object.assign(new Error('Out of sort memory'), { code: 'ER_OUT_OF_SORTMEMORY', errno: 1038 });
    assert.match(sql, /FROM delivery_center_projects LIMIT 10001$/u);
    return [[
      { slug: 'project-z', name: '示例客户', observed_at: '2026-10-07T01:00:00Z', coverage: JSON.stringify(coverage) },
      { slug: 'project-b', name: 'Alpha', observed_at: '2026-10-07T02:00:00Z', coverage: {} },
      { slug: 'project-a', name: 'Alpha', observed_at: '2026-10-07T03:00:00Z', coverage: {} },
    ], []];
  });
  const result = await new DeliveryCenterStore({ pool }).listProjects();
  assert.deepEqual(result.map(item => item.slug), ['project-a', 'project-b', 'project-z']);
  assert.deepEqual(result[2], { slug: 'project-z', name: '示例客户', observedAt: '2026-10-07T01:00:00Z', coverage: { availability: 'ready' } });
  assert.equal(coverage.currentAssetVersionIds.length, 5000);
  assert.deepEqual(coverage.menuAliases, { old: '100' });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1000);
  assert.equal(pool.calls.length, 1);
});

test('oversized lists and exports report explicit bounds rather than truncating silently', async () => {
  const listPool = fakePool(async () => [Array.from({ length: 10001 }, () => ({ data: {} })), []]);
  const listStore = new DeliveryCenterStore({ pool: listPool });
  await assert.rejects(listStore.listProjects(), { code: 'DELIVERY_RESULT_LIMIT', status: 413 });
  await assert.rejects(listStore.listMenus('delivery-test'), { code: 'DELIVERY_RESULT_LIMIT', status: 413 });
  const exportPool = fakePool(async (sql) => sql.startsWith('SELECT r.') ? [Array.from({ length: 100001 }, () => ({ data: {} })), []] : [[], []]);
  await assert.rejects(new DeliveryCenterStore({ pool: exportPool }).exportRequirements('delivery-test'), { code: 'DELIVERY_EXPORT_TOO_LARGE', status: 422 });
  assert.deepEqual(exportPool.calls.slice(-2).map((call) => call.operation), ['rollback', 'release']);
});

const mysqlConfigFile = process.env.DELIVERY_CENTER_TEST_DATABASE_CONFIG_FILE ?? process.env.DELIVERY_CENTER_TEST_MYSQL_CONFIG_FILE;
test('real MySQL: idempotent imports, shared source links, historic release snapshots and rollback',
  { skip: !mysqlConfigFile && 'Set DELIVERY_CENTER_TEST_DATABASE_CONFIG_FILE to a private dedicated *_test database configuration.' }, async () => {
    const config = await readDeliveryCenterDatabaseConfig(mysqlConfigFile);
    assert.match(config.database, /_test$/u, 'Integration tests require an explicitly dedicated *_test database.');
    const pool = createDeliveryCenterPool(config);
    const store = new DeliveryCenterStore({ pool });
    const projectSlug = `delivery-${randomBytes(6).toString('hex')}`;
    try {
      await store.initialize(); await store.initialize();
      const original = fixture(projectSlug);
      assert.equal((await store.importSnapshot(original)).changed, true);
      const repeated = { ...structuredClone(original), observedAt: '2026-10-07T11:00:00.000Z' };
      assert.equal((await store.importSnapshot(repeated)).changed, false);
      assert.equal((await store.listRequirements(projectSlug, { menuId: 'menu-root' })).total, 1);
      assert.equal((await store.listRequirements(projectSlug, { batchId: 'batch-two', q: '100%状态_' })).total, 1);
      assert.equal((await store.listRequirements(projectSlug, { q: "' OR 1=1 --" })).total, 0);
      const [[sources]] = await pool.execute('SELECT COUNT(*) AS total FROM delivery_center_requirement_sources WHERE project_slug = ?', [projectSlug]);
      assert.equal(Number(sources.total), 2);
      const changed = structuredClone(repeated);
      changed.requirements[0].name = '已修改的当前功能'; changed.requirements[0].revision = 2;
      changed.stages[0] = { ...changed.stages[0], id: 'stage-two', digest: 'b'.repeat(64), summary: '第二版' };
      changed.observedAt = '2026-10-07T12:00:00.000Z';
      await store.importSnapshot(changed);
      assert.equal((await store.getRequirement(projectSlug, 'function-one')).name, '已修改的当前功能');
      assert.equal((await store.getRequirement(projectSlug, 'function-one')).revisions.length, 2);
      const stages = await store.listStages(projectSlug);
      assert.equal(stages.total, 1); assert.equal(stages.items[0].id, 'stage-two'); assert.equal(stages.items[0].isCurrent, true);
      const historicalStages = await store.listStages(projectSlug, { isCurrent: false });
      assert.equal(historicalStages.total, 1); assert.equal(historicalStages.items[0].id, 'stage-one'); assert.equal(historicalStages.items[0].isCurrent, false);
      const historic = await store.exportRequirements(projectSlug, { releaseId: 'release-one', pageSize: 1 });
      assert.equal(historic.length, 2);
      assert.equal(historic.find((entry) => entry.id === 'function-one').name, '设备查询');
      assert.equal(historic.find((entry) => entry.id === 'unrecorded-function').historicalSnapshotAvailable, false);
      assert.equal((await store.getRequirement(projectSlug, 'function-one', { releaseId: 'release-one' })).name, '设备查询');
      assert.equal((await store.getRequirement(projectSlug, 'unrecorded-function', { releaseId: 'release-one' })).historicalSnapshotAvailable, false);
      assert.equal((await store.listBatches(projectSlug, { q: '第二', batchId: 'batch-two' })).total, 1);
      assert.equal((await store.listStages(projectSlug, { q: '第二版' })).total, 1);
      assert.equal((await store.listReleases(projectSlug, { q: '1.0.0' })).total, 1);
      assert.equal((await store.listArtifacts(projectSlug, { q: 'not-a-real-artifact' })).total, 0);
      assert.equal((await store.getRelease(projectSlug, 'release-one')).commit, 'c'.repeat(40));
      const rejected = structuredClone(changed); rejected.requirements[0].name = 'must-roll-back'; rejected.releases[0].version = 'overwritten';
      await assert.rejects(store.importSnapshot(rejected), { code: 'DELIVERY_RELEASE_IMMUTABLE' });
      assert.equal((await store.getRequirement(projectSlug, 'function-one')).name, '已修改的当前功能');
      assert.equal((await store.overview(projectSlug)).counts.requirements, 1);
      assert.equal((await store.listArtifacts(projectSlug, { releaseId: 'release-one' })).total, 1);
      assert.equal((await store.listBatches(projectSlug)).total, 2);
      assert.ok((await store.listProjects()).some((entry) => entry.slug === projectSlug));
    } finally {
      // Delete only rows belonging to this test's unpredictable project slug.
      for (const table of ['requirement_sources', 'requirement_batches', 'requirement_versions', 'release_requirements',
        'requirements', 'menus', 'batches', 'stages', 'artifacts', 'releases', 'projects']) {
        await pool.execute(`DELETE FROM delivery_center_${table} WHERE ${table === 'projects' ? 'slug' : 'project_slug'} = ?`, [projectSlug]).catch(() => {});
      }
      await store.close();
    }
  });


test('snapshot import bounds heap while preserving canonical JSON bytes and unchanged imports', async (context) => {
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const input = fixture();
  input.coverage.edge = { '10': '十', '2': '二', '01': '零一', z: undefined,
    values: [undefined, NaN, -0, '中文', '\ud800'], date: new Date('2026-10-09T00:00:00Z') };
  input.extra = [,{ toJSON(key) { return { key, value: 'test' }; } }];
  const validated = validateDeliverySnapshot(input);
  assert.deepEqual(validated.coverage.edge, JSON.parse(JSON.stringify(input.coverage.edge)));
  assert.deepEqual(validated.extra, [null, { key: '1', value: 'test' }]);
  assert.notEqual(validated.coverage.edge, input.coverage.edge);
  const expected = createHash('sha256').update(JSON.stringify(canonical({ ...validated, observedAt: undefined }))).digest('hex');
  const pool = fakePool(async (sql) => sql.startsWith('SELECT snapshot_digest') ? [[{ snapshot_digest: expected }], []] : [[], []]);
  const receipt = await new DeliveryCenterStore({ pool }).importSnapshot(input);
  assert.equal(receipt.changed, false);
  assert.equal(pool.calls.find(call => call.sql?.startsWith('INSERT IGNORE INTO delivery_center_projects')).parameters[3], '');
  assert.equal(pool.calls.find(call => call.sql?.startsWith('UPDATE delivery_center_projects')).parameters[2], expected);
  assert.equal(pool.calls.some(call => /INSERT.*delivery_center_artifacts/.test(call.sql ?? '')), false);
  const cyclic = fixture(); cyclic.extra = [cyclic];
  assert.throws(() => validateDeliverySnapshot(cyclic), { code: 'DELIVERY_INPUT_INVALID' });
  const bigint = fixture(); bigint.extra = [1n];
  assert.throws(() => validateDeliverySnapshot(bigint), { code: 'DELIVERY_INPUT_INVALID' });
  // Exact root/key/bracket/comma accounting at the existing 64 MiB limit, with bounded items.
  const boundary = fixture(); boundary.extra = Array.from({ length: 63 }, () => 'x'.repeat(1024 * 1024));
  const remaining = 64 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(boundary)) - 3;
  boundary.extra.push('x'.repeat(remaining));
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), 64 * 1024 * 1024);
  assert.doesNotThrow(() => validateDeliverySnapshot(boundary));
  boundary.extra[boundary.extra.length - 1] += 'x';
  assert.throws(() => validateDeliverySnapshot(boundary), { code: 'DELIVERY_INPUT_INVALID' });
  boundary.extra = [];
  const packet = process.env.DELIVERY_MEMORY_PACKET;
  if (!packet) { context.diagnostic('Fixed packet heap check requires DELIVERY_MEMORY_PACKET; JSON/hash/size assertions completed.'); return; }
  const { spawn } = await import('node:child_process');
  const script = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { createHash } from 'node:crypto';
    import { getHeapStatistics } from 'node:v8';
    import { DeliveryCenterStore, validateDeliverySnapshot } from ${JSON.stringify(new URL('../docker/harness/delivery-center-store.mjs', import.meta.url).href)};
    import { projectDeliverySnapshot } from ${JSON.stringify(new URL('../docker/harness/delivery-center-projection.mjs', import.meta.url).href)};
    const canonical = ${canonical.toString()};
    // Reference uses the previous canonicalizer only on bounded top-level members/items.
    // Concatenated JSON bytes are the original whole-snapshot canonical serialization.
    function reference(snapshot) {
      const normalized = validateDeliverySnapshot(snapshot); const hash = createHash('sha256');
      hash.update('{'); let first = true;
      const keys = Object.keys(Object.fromEntries(Object.keys(normalized).sort().map(k => [k, null])));
      for (const key of keys) {
        if (key === 'observedAt' || normalized[key] === undefined) continue;
        if (!first) hash.update(','); first = false; hash.update(JSON.stringify(key)); hash.update(':');
        const value = normalized[key];
        if (Array.isArray(value)) { hash.update('['); value.forEach((item, i) => { if (i) hash.update(','); hash.update(JSON.stringify(canonical(item))); }); hash.update(']'); }
        else hash.update(JSON.stringify(canonical(value)));
      }
      hash.update('}'); return hash.digest('hex');
    }
    function project() {
      const bytes = readFileSync(process.env.DELIVERY_MEMORY_PACKET);
      assert.equal(bytes.length, 50984099);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), '937ba777cbccf2b8e9276862e1419406175741566591bdd2396ecc167d035f0b');
      const packet = JSON.parse(bytes.toString('utf8'));
      return projectDeliverySnapshot({ projectSlug: packet.projectSlug, projectName: 'memory-bound source validation', historyPackets: [packet], observedAt: '2026-10-09T00:00:00.000Z' });
    }
    const rounds = [];
    for (let round = 1; round <= 2; round++) {
      const snapshot = project(); const afterProjection = process.memoryUsage().heapUsed;
      const expected = reference(snapshot); let writes = 0; let observed;
      const connection = { async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async execute(sql, params) {
          if (sql.startsWith('SELECT snapshot_digest')) return [[{ snapshot_digest: expected }], []];
          if (sql.startsWith('UPDATE delivery_center_projects')) observed = params[2];
          if (!sql.includes('delivery_center_projects')) writes++;
          return [[], []];
        } };
      const result = await new DeliveryCenterStore({ pool: { getConnection: async () => connection, execute: connection.execute } }).importSnapshot(snapshot);
      assert.equal(result.changed, false); assert.equal(observed, expected); assert.equal(writes, 0);
      rounds.push({ round, digest: observed, sampledHeapBytes: Math.max(afterProjection, process.memoryUsage().heapUsed), cumulativePeakRssKiB: process.resourceUsage().maxRSS, counts: result.counts });
    }
    assert.equal(rounds[0].digest, rounds[1].digest);
    console.log(JSON.stringify({ packetBytes: 50984099, packetSha256: '937ba777cbccf2b8e9276862e1419406175741566591bdd2396ecc167d035f0b', maxOldSpaceMiB: 256, heapLimitBytes: getHeapStatistics().heap_size_limit, rounds, businessWrites: 0 }));
  `;
  const child = spawn(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errorOutput = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errorOutput += data; });
  const outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(outcome.code, 0, `Bounded original-packet consumer failed: ${outcome.signal ?? ''} ${errorOutput.slice(-2000)}`);
  const result = JSON.parse(output.trim()); assert.equal(result.rounds.length, 2);
  context.diagnostic(JSON.stringify(result));
});
