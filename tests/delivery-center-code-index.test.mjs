import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildDeliveryCodeAssets } from '../scripts/delivery-center-code-index.mjs';
const commit = 'a'.repeat(40);
const file = (path, content) => ({ path, content, sha256: createHash('sha256').update(content).digest('hex') });
const menus = [{ id: 'root', name: '相关方', resourceType: 1 }, { id: 'workers', name: '作业人员', parentId: 'root', component: 'workers/index', path: '/workers', resourceType: 2 }, { id: 'workers-copy', name: '人员台账', parentId: 'root', component: 'workers/copy', resourceType: 2 }];
const files = [
  file('ui/src/views/workers/index.vue', `<template><WorkerPage page-key="workers" /></template><script setup>import WorkerPage from './WorkerPage.vue'</script>`),
  file('ui/src/views/workers/copy.vue', `<template><WorkerPage page-key="workers" /></template><script setup>import WorkerPage from './WorkerPage.vue'</script>`),
  file('ui/src/views/workers/WorkerPage.vue', `<template><n-card><n-form-item :label="L('姓名')"><n-input v-model:value="form.name" /></n-form-item><n-button @click="save">{{ L('保存') }}</n-button><AiCrudPage :api-config="api" :edit-schema="fields" :columns="columns" /></n-card></template><script setup>
import { workerApi, workerFields, workerColumns } from './contract'
const api = computed(() => workerApi(props.pageKey))
const fields = computed(() => workerFields())
const columns = computed(() => workerColumns())
</script>`),
  file('ui/src/views/workers/contract.js', `export function workerApi(pageKey) {
 const segment = pageKey === 'special-workers' ? 'workers' : pageKey
 const base = \`/business/\${segment}\`
 return { list: \`get@\${base}/page\`, add: \`post@\${base}/add\` }
}
export function workerFields() { return [{field:'name',label:'姓名',type:'input',rules:[{required:true,message:'必填'}]}] }
export function workerColumns() { return [{prop:'name',label:'人员姓名'},{prop:'orgId',label:'组织编号'}] }
export function unrelatedFields() { return [{field:'salary',label:'未调用的工资字段'}] }`),
  file('server/worker/controller/WorkerController.java', `package worker.controller;
import worker.service.WorkerService;
import worker.entity.Worker;
@RestController
@RequestMapping("/business/workers")
public class WorkerController {
 private final WorkerService service;
 /** 分页查询作业人员 */
 @GetMapping("/page")
 public List<Worker> page() { return service.list(); }
 /** 登记作业人员 */
 @PostMapping("/add")
 public void add(@RequestBody Worker worker) { service.add(worker); }
}`),
  file('server/worker/service/WorkerService.java', `package worker.service;
import worker.entity.Worker;
public interface WorkerService { List<Worker> list(); void add(Worker worker); }`),
  file('server/worker/entity/Worker.java', `package worker.entity;
import worker.entity.BaseEntity;
/** 作业人员实体 */
@TableName("business_worker")
public class Worker extends BaseEntity {
 /** 主键 */
 @TableId("id")
 private Long id;
 /** 人员姓名 */
 @TableField("worker_name")
 private String name;
 /** 所属组织编号，不声明外键关系 */
 private Long orgId;
}`),
  file('server/worker/entity/BaseEntity.java', `package worker.entity;
public class BaseEntity {
 /** 创建时间 */
 private LocalDateTime createTime;
 /** 修改人 */
 private String updateBy;
}`),
  file('server/worker/entity/UnrelatedWorker.java', `package worker.entity;
@TableName("unrelated_worker")
public class UnrelatedWorker { private Long workerId; }`),
];
const build = () => buildDeliveryCodeAssets({ projectSlug: 'forge-base', sourceCommit: commit, files, menus, recordedAt: '2026-10-07T01:00:00Z' });

test('import-only shared tables do not become menu usage; explicit references retain dependency evidence', () => {
  const input = [
    file('ui/src/views/fixture.vue', `<script setup>request.get('/fixture/list')</script>`),
    file('server/fixture/controller/FixtureController.java', `package fixture.controller;
import fixture.service.WorkerService;
import fixture.entity.Worker;
@RestController @RequestMapping("/fixture")
public class FixtureController {
 private WorkerService service;
 @GetMapping("/list") public List<Worker> list() { return service.list(); }
}`),
    file('server/fixture/service/WorkerService.java', `package fixture.service;
import fixture.entity.SysOrg;
import fixture.entity.Worker;
import fixture.service.SharedService;
public class WorkerService {
 private SharedService shared;
 // SysOrg is merely imported; mentioning SysOrg here is not a use.
 private String note = "SysOrg";
 public List<Worker> list() { shared.lookup(); return List.of(); }
}`),
    file('server/fixture/service/SharedService.java', `package fixture.service;
import fixture.entity.Lookup;
public class SharedService { public Lookup lookup() { return new Lookup(); } }`),
    ...[['Worker','worker'],['SysOrg','sys_org'],['Lookup','shared_lookup']].map(([name,table])=>file(`server/fixture/entity/${name}.java`, `package fixture.entity;
@TableName("${table}") public class ${name} { private Long id; }`)),
  ];
  const assets = buildDeliveryCodeAssets({ projectSlug:'forge-base',sourceCommit:commit,files:input,
    menus:[{id:'fixture-one',name:'Fixture one',component:'fixture'},{id:'fixture-two',name:'Fixture two',component:'fixture'}],recordedAt:'2026-10-09T00:00:00Z' });
  const find = name => assets.find(item=>item.assetId===`forge-base:table:${name}`);
  assert.deepEqual(find('sys_org').menuIds, []);
  assert.deepEqual(find('worker').menuIds, ['fixture-one','fixture-two']);
  assert.deepEqual(find('shared_lookup').menuIds, ['fixture-one','fixture-two']);
  const direct = find('worker').sources.find(item=>item.menuId==='fixture-one');
  assert.equal(direct.referenceKind,'direct-source-reference');assert.equal(direct.dependencyDepth,1);
  const indirect = find('shared_lookup').sources.find(item=>item.menuId==='fixture-one');
  assert.equal(indirect.referenceKind,'indirect-source-dependency');assert.equal(indirect.dependencyDepth,3);
  assert.deepEqual(indirect.via.map(item=>item.toType),['fixture.service.WorkerService','fixture.service.SharedService','fixture.entity.Lookup']);
  assert.ok(indirect.via.every(item=>item.type==='code-snapshot'&&item.commit===commit&&Number.isInteger(item.line)));
  assert.match(indirect.limitation,/不证明运行调用/);
  assert.equal(find('shared_lookup').sources.filter(item=>item.endpointId===indirect.endpointId&&item.menuId==='fixture-two').length,1,'cached endpoint keeps the second menu provenance');
  const api=assets.find(item=>item.kind==='api'&&item.details.path==='/fixture/list');
  assert.equal(api.relations.find(item=>item.targetId==='forge-base:entity:fixture.entity.Lookup').source.dependencyDepth,3);
  assert.equal(find('shared_lookup').adoption,undefined);assert.deepEqual(find('shared_lookup').releaseIds,[]);
});

test('literal component props connect wrapper, direct component and explicitly called schema/API functions', () => {
  const assets = build(); const pages = assets.filter(item => item.kind === 'page'); assert.equal(pages.length, 2);
  const page = pages.find(item => item.menuIds.includes('workers'));
  assert.ok(page.details.formFields.some(item => item.name === 'name' && item.required === true));
  assert.ok(page.details.listColumns.some(item => item.name === 'orgId' && item.label === '组织编号'));
  assert.ok(page.details.actions.some(item => item.name === '保存')); assert.ok(page.details.blocks.some(item => item.name === 'n-card'));
  assert.equal(page.details.formFields.some(item => item.name === 'salary'), false);
  assert.deepEqual(page.details.apiBindings.map(item => `${item.method} ${item.path}`).sort(), ['GET /business/workers/page', 'POST /business/workers/add']);
  assert.ok(page.sources.some(item => item.path.endsWith('contract.js')));
});

test('exact endpoint and Java type references propagate menu usage to entities and their declared tables', () => {
  const assets = build(); const api = assets.find(item => item.kind === 'api' && item.details.path === '/business/workers/page');
  assert.equal(api.details.owner, 'worker.controller.WorkerController'); assert.deepEqual(api.menuIds.sort(), ['workers', 'workers-copy']);
  const entity = assets.find(item => item.assetId === 'forge-base:entity:worker.entity.Worker');
  assert.deepEqual(entity.menuIds.sort(), ['workers', 'workers-copy']); assert.equal(entity.details.logicalRelations.length, 0);
  assert.ok(entity.details.attributes.some(item => item.name === 'orgId')); assert.ok(entity.details.technicalFields.some(item => item.name === 'createTime' && item.inheritedFrom === 'worker.entity.BaseEntity'));
  const table = assets.find(item => item.assetId === 'forge-base:table:business_worker');
  assert.deepEqual(table.menuIds.sort(), ['workers', 'workers-copy']); assert.ok(entity.relations.some(item => item.targetId === table.assetId));
  assert.ok(table.details.fieldMappings.some(item => item.businessAttribute === 'name' && item.field === 'worker_name'));
  assert.equal(table.details.fields, undefined);
  const unrelated = assets.find(item => item.assetId === 'forge-base:entity:worker.entity.UnrelatedWorker'); assert.deepEqual(unrelated.menuIds, []);
});

test('source snapshots have stable identities, precise provenance, and no fabricated completion or release', () => {
  const first = build(); const second = buildDeliveryCodeAssets({ projectSlug: 'forge-base', sourceCommit: 'b'.repeat(40), files, menus, recordedAt: '2026-10-08T01:00:00Z' });
  assert.deepEqual(first.map(item => item.assetId), second.map(item => item.assetId));
  for (const asset of first) {
    assert.equal(asset.status, 'implementation-observed'); assert.equal(asset.certainty, 'implementation-derived'); assert.deepEqual(asset.commits, [commit]); assert.deepEqual(asset.releaseIds, []);
    for (const source of asset.sources) { const original = files.find(item => item.path === source.path); assert.ok(original); assert.equal(source.sha256, original.sha256); assert.equal(source.commit, commit); }
  }
});

test('unresolved computed endpoints and missing menu component files do not guess name-based bindings', () => {
  const input = [...files, file('ui/src/views/unresolved.vue', '<template><div /></template><script setup>const base=loadRuntimeValue(); request.get(`${base}/page`)</script>')];
  const assets = buildDeliveryCodeAssets({ projectSlug: 'forge-base', sourceCommit: commit, files: input, menus: [{ id: 'missing', name: '作业人员', component: 'missing-file' }, { id: 'unresolved', name: '未确认接口', component: 'unresolved' }], recordedAt: '2026-10-07T01:00:00Z' });
  assert.equal(assets.filter(item => item.kind === 'page').length, 1);
  assert.equal(assets.find(item => item.kind === 'page').details.apiBindings.length, 0);
  assert.ok(assets.filter(item => item.kind === 'entity').every(item => item.menuIds.length === 0));
});

test('partial string arguments and unresolved annotation constants are not promoted to complete routes', () => {
  const input = [file('ui/src/views/route.vue', `<template><div /></template><script setup>
request.get('/unsafe-prefix/' + runtimeId)
request.get('/known')
</script>`), file('server/UnknownController.java', `package worker;
@RestController
@RequestMapping(BASE_PATH)
public class UnknownController { @GetMapping("/known") public void known() {} }
`), file('server/KnownController.java', `package worker;
@RestController
@RequestMapping("/safe")
public class KnownController { @GetMapping(METHOD_PATH) public void uncertain() {} }
`)];
  const assets = buildDeliveryCodeAssets({ projectSlug: 'forge-base', sourceCommit: commit, files: input, menus: [{ id: 'route', name: '路由定义', component: 'route' }] });
  assert.deepEqual(assets.filter(item => item.kind === 'api').map(item => item.details.path), ['/known']);
});
test('large local function sets and reused menu components do not recursively expand irrelevant lexical bindings', { timeout: 1500 }, () => {
  const body = Array.from({ length: 240 }, (_, index) => `function unused${index}(value) { const local${index}='${index}'; return unused${(index+1)%240}(value) }`).join('\n');
  const reusedMenus = Array.from({ length: 20 }, (_, index) => ({ id: `menu-${index}`, name: `菜单${index}`, component: 'shared' }));
  const input = [file('ui/src/views/shared.vue', `<template><n-button @click="load">加载</n-button></template><script setup>${body}\nfunction load(){return request.get('/shared/page')}</script>`)];
  const assets = buildDeliveryCodeAssets({ projectSlug: 'forge-base', sourceCommit: commit, files: input, menus: reusedMenus });
  assert.equal(assets.filter(item => item.kind === 'page').length, 1);
  assert.equal(assets.find(item => item.kind === 'page').menuIds.length, 20);
  assert.equal(assets.find(item => item.kind === 'api').menuIds.length, 20);
});
