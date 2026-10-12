import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryAssetVersions, listDeliveryAssets } from '../docker/harness/delivery-center-assets.mjs';
import { DeliveryCenterStore } from '../docker/harness/delivery-center-store.mjs';
import { deliveryQuery, deliveryResponse } from '../docker/harness/delivery-center-http.mjs';
import { deliverySummary } from '../docker/harness/delivery-center-views.mjs';

test('menu reference summaries bound current-menu evidence and preserve exact detail identity', () => {
  const sources = Array.from({ length: 100 }, (_, index) => ({ type: 'code-snapshot', path: `server/Entity${index}.java`,
    commit: 'a'.repeat(40), sha256: 'b'.repeat(64), menuIds: index < 8 ? ['selected', 'other'] : ['other'],
    via: [{ path: 'server/Service.java', implementation: 'x'.repeat(1000) }] }));
  const bindings = Array.from({ length: 20 }, (_, index) => ({ pagePath: 'views/page.vue', componentPath: 'components/common/Picker.vue',
    endpointId: `api-${index}`, method: 'GET', path: `/list/${index}`, sources: [sources[0], sources[1], sources[2]] }));
  const item = { id: 'asset-one', assetId: 'asset-one', kind: 'entity', revision: 'source-r2', versionId: 'exact-version-r2',
    menuIds: Array.from({ length: 50 }, (_, index) => `menu-${index}`), menuPaths: [['unrelated', 'menu']],
    usedByMenus: Array.from({ length: 50 }, (_, index) => ({ id: `menu-${index}`, details: 'x'.repeat(1000) })), sources,
    details: { fields: ['full-definition'] }, revisions: [{ versionId: 'original-r1', sources }],
    menuReference: { classification: 'shared-component', purpose: null, menuIds: ['selected'], bindings: [...bindings, bindings[0]], limitations: ['静态引用'] } };
  const before = JSON.stringify(item), summary = deliverySummary(item);
  assert.equal(summary.sources.length, 4); assert.equal(summary.sourceCount, 100); assert.equal(summary.sourcesHasMore, true);
  assert.equal(summary.sources[0].path, 'server/Entity0.java'); assert.equal(summary.sources[0].via, undefined);
  assert.deepEqual(summary.menuIds, ['selected']); assert.equal(summary.menuCount, 50);
  assert.equal(summary.usedByMenus, undefined); assert.equal(summary.usedByMenuCount, 50);
  assert.equal(summary.menuPaths, undefined); assert.equal(summary.revisions, undefined);
  assert.equal(summary.menuReference.bindingCount, 20); assert.equal(summary.menuReference.bindings.length, 4);
  assert.equal(summary.menuReference.bindingsHasMore, true);
  assert.equal(summary.menuReference.bindings[0].sources.length, 2);
  for (const field of ['id', 'assetId', 'revision', 'versionId']) assert.equal(summary[field], item[field]);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 12000);
  assert.equal(JSON.stringify(item), before, 'full detail and historical sources remain untouched');
});

test('compacted menu source memberships retain exact endpoint grouping and historical revisions', () => {
  const commit = 'a'.repeat(40), menuId = 'menu-one';
  const root = 'forge-admin-ui/src/views/accident/report.vue';
  const component = 'forge-admin-ui/src/components/common/UserSelectModal.vue';
  const source = { type: 'code-snapshot', path: 'server/User.java', commit, endpointId: 'api-user', menuIds: [menuId, 'menu-other'] };
  const current = { id: 'user', assetId: 'user', kind: 'entity', name: 'User', versionId: 'new-metadata', revision: 'new-metadata',
    isCurrent: true, menuIds: [menuId, 'menu-other'], sources: [source] };
  const historical = { ...current, versionId: 'original', revision: 'original', isCurrent: false, sources: [] };
  const menus = [{ id: menuId, name: '事故上报', path: ['事故上报'] }];
  const page = { menuIds: [menuId], sources: [{ path: root, commit }], details: { component: 'accident/report',
    relatedComponents: [component], apiBindings: [{ assetId: 'api-user', method: 'GET', path: '/system/user/page', source: { path: component, commit } }] } };
  const args = { versions: [historical, current], menus, referencePages: [page], filters: { kind: 'entity', menuId } };
  const main = listDeliveryAssets(args), shared = listDeliveryAssets({ ...args, filters: { ...args.filters, referenceGroup: 'shared' } });
  assert.equal(main.total, 0); assert.equal(main.sharedReferences.total, 1);
  assert.equal(shared.total, 1); assert.equal(shared.items[0].versionId, 'new-metadata');
  assert.deepEqual(shared.items[0].menuReference.bindings[0].sources[1].menuIds, [menuId, 'menu-other']);
  const missing = { ...current, sources: [{ ...source, menuIds: ['menu-other'] }] };
  assert.equal(listDeliveryAssets({ ...args, versions: [missing] }).items[0].menuReference.classification, 'unknown');
  assert.deepEqual(historical.sources, []); assert.equal(historical.revision, 'original');
});

test('menu reference grouping selects revisions before bounded main and shared paging without guessing business use', async () => {
  const commit = 'a'.repeat(40);
  const root = 'forge-admin-ui/src/views/accident/report.vue';
  const component = 'forge-admin-ui/src/components/common/UserSelectModal.vue';
  const proof = path => ({ type: 'code-snapshot', path, commit, sha256: 'b'.repeat(64) });
  const menus = [{ id: 'menu', parentId: null, name: '事故上报', path: ['事故上报'] }];
  const dependency = endpointId => ({ ...proof('server/Entity.java'), menuId: 'menu', endpointId });
  const version = (id, options = {}) => ({ id, kind: 'specification-asset', stageId: null, payload: {
    assetId: id, kind: 'entity', name: id, revision: id, sourceRevision: commit,
    recordedAt: '2026-10-09T00:00:00Z', menuIds: ['menu'], menuPaths: [], batchIds: ['batch'],
    sources: [dependency('shared-api')], details: {}, ...options } });
  const originals = [
    version('shared-a'), version('shared-b', { kind: 'table' }),
    version('direct', { sources: [dependency('direct-api')] }),
    version('mixed', { sources: [dependency('shared-api'), dependency('direct-api')] }),
    version('unknown', { sources: [dependency('missing-api')] }),
    version('unproven', { sources: [dependency('unproven-component-api')] }),
    version('explicit', { menuRefs: [{ kind: 'menu', id: 'menu', revision: null }] }),
    version('changed-old', { assetId: 'changed', recordedAt: '2026-10-08T00:00:00Z' }),
    version('changed-current', { assetId: 'changed', sources: [dependency('direct-api')] }),
    version('page', { kind: 'page', sources: [proof(root)], details: {
      component: 'accident/report', relatedComponents: [component],
      apiBindings: [
        { assetId: 'shared-api', method: 'GET', path: '/system/user/page', source: proof(component) },
        { assetId: 'direct-api', method: 'POST', path: '/accident/add', source: proof(root) },
        { assetId: 'unproven-component-api', method: 'GET', path: '/other', source: proof('forge-admin-ui/src/components/common/Unrelated.vue') },
      ],
    } }),
  ];
  const coverage = { currentAssetVersionIds: originals.filter(item => item.id !== 'changed-old').map(item => item.id) };
  const versions = deliveryAssetVersions(originals, coverage);
  const pages = versions.filter(item => item.kind === 'page');
  const base = { kind: 'entity', menuId: 'menu', page: 1, pageSize: 2 };
  const read = filters => listDeliveryAssets({ versions, menus, referencePages: pages, filters: { ...base, ...filters } });
  const main = read();
  assert.equal(main.total, 6); assert.deepEqual(main.sharedReferences, { total: 1 });
  assert.equal(main.items.length, 2);
  const allMain = read({ pageSize: 20 }).items;
  assert.deepEqual(new Set(allMain.map(item => item.assetId)), new Set(['direct', 'mixed', 'unknown', 'unproven', 'explicit', 'changed']));
  assert.equal(allMain.find(item => item.assetId === 'changed').versionId, 'changed-current');
  assert.equal(allMain.find(item => item.assetId === 'unknown').menuReference.classification, 'unknown');
  assert.equal(allMain.find(item => item.assetId === 'explicit').menuReference.classification, 'explicit-business');
  const shared = read({ referenceGroup: 'shared', pageSize: 1 });
  assert.equal(shared.total, 1); assert.equal(shared.items[0].assetId, 'shared-a');
  assert.equal(shared.items[0].menuReference.purpose, null);
  assert.equal(shared.items[0].menuReference.bindings[0].componentPath, component);
  assert.equal(shared.items[0].menuReference.bindings[0].sources[1].endpointId, 'shared-api');
  assert.equal(read({ referenceGroup: 'shared', page: 2, pageSize: 1 }).items.length, 0);
  assert.equal(read({ kind: 'table', referenceGroup: 'shared' }).items[0].assetId, 'shared-b');
  assert.equal(read({ batchId: 'batch', referenceGroup: 'shared', pageSize: 20 }).total, 7);
  assert.equal(read({ menuId: undefined, referenceGroup: 'shared', pageSize: 20 }).total, 7);
  assert.equal(read({ q: 'direct' }).sharedReferences.total, 0);
  const stalePages = structuredClone(pages);
  stalePages[0].details.apiBindings[0].source.commit = 'c'.repeat(40);
  assert.equal(listDeliveryAssets({ versions, menus, referencePages: stalePages, filters: base }).sharedReferences.total, 0);

  const calls = [];
  const connection = { async execute(sql, parameters = []) {
    calls.push({ sql, parameters });
    if (sql.startsWith('SET TRANSACTION')) return [[]];
    if (sql.includes('SELECT coverage')) return [[{ coverage }]];
    if (sql.includes('SELECT snapshot_digest')) return [[{ snapshot_digest: 'd'.repeat(64), observed_at: '2026-10-09T00:00:00Z' }]];
    if (sql.includes('FROM delivery_center_menus')) return [menus.map(data => ({ data }))];
    if (sql.includes('FROM delivery_center_artifacts a')) {
      const rows = originals.filter(item => sql.includes('a.id IN') ? parameters.includes(item.id)
        : parameters.includes(item.payload.kind));
      return [rows.map(data => ({ data }))];
    }
    throw Error(`unexpected SQL: ${sql}`);
  }, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
  const store = new DeliveryCenterStore({ pool: { execute: connection.execute, getConnection: async () => connection } });
  const url = new URL('http://local/forge-gateway/api/delivery/assets?project=forge-base&kind=entity&menuId=menu&referenceGroup=shared&projection=summary&pageSize=1');
  assert.equal(deliveryQuery(url.searchParams).filters.referenceGroup, 'shared');
  const response = await deliveryResponse({ method: 'GET', url, store });
  assert.equal(response.body.total, 1);
  assert.equal(response.body.items[0].versionId, 'shared-a');
  assert.equal(response.body.items[0].menuReference.classification, 'shared-component');
  assert.equal(calls.filter(call => call.sql.includes('a.id IN')).length, 2, 'one bounded page body read and one selected result body read');
});
