import assert from 'node:assert/strict';
import test from 'node:test';
import { deliveryAssetVersions, listDeliveryAssets, getDeliveryAsset, deliveryAssetCounts, deliveryMenuDescendants } from '../docker/harness/delivery-center-assets.mjs';
import { DeliveryCenterStore, validateDeliverySnapshot } from '../docker/harness/delivery-center-store.mjs';
import { deliveryResponse, deliveryQuery } from '../docker/harness/delivery-center-http.mjs';
import { parseDeliveryDocumentDefinitions } from '../docker/harness/delivery-center-document-source.mjs';
import { projectDeliverySnapshot } from '../docker/harness/delivery-center-projection.mjs';

const menus = [{ id: '100', name: '业务管理', parentId: null, path: ['业务管理'] },
  { id: '101', name: '作业人员', parentId: '100', path: ['业务管理', '作业人员'] },
  { id: '102', name: '培训管理', parentId: '100', path: ['业务管理', '培训管理'] }];

test('source revision labels remain exact across document projection validation and HTTP queries', async () => {
  const label = 'V1.0.183/V1.0.196';
  const assetId = 'leadership.permission.module-rbac';
  const functionId = 'fixture.function.permission-review';
  const snapshotFor = revision => {
    const record = { name: '领导引领力页面与接口权限', description: '来源中明确标注的修订',
      deliveryCenter: { schemaVersion: 1, id: assetId, kind: 'permission', revision, nature: 'design',
        menuRefs: [{ kind: 'menu', id: 'forge-base:menu:10276', revision: null }],
        functionRefs: [{ kind: 'function', id: functionId, revision: label }], adoption: { state: 'unknown' } } };
    const documents = parseDeliveryDocumentDefinitions(`\`\`\`json delivery-center\n${JSON.stringify(record)}\n\`\`\``, {
      path: 'code-copilot/changes/revision-label-fixture/spec.md', commit: 'a'.repeat(40),
      contentDigest: 'b'.repeat(64), batchId: 'checkpoint-fixture', isCurrent: false,
      sourceScope: 'taskspace-checkpoint', committedAt: '2026-10-08T16:16:42.177Z' });
    return projectDeliverySnapshot({ projectSlug: 'forge-base', projectName: '示例客户',
      observedAt: '2026-10-08T16:20:00Z', checkpointDocuments: { documents, batches: [], gaps: [], coverage: {} } });
  };
  const original = snapshotFor(label);
  const snapshot = validateDeliverySnapshot(original);
  assert.equal(snapshot.artifacts[0].payload.revision, label);
  assert.equal(snapshot.artifacts[0].payload.adoption.state, 'unknown');
  assert.deepEqual(original, snapshotFor(label), 'Validation must not rewrite the source revision or source records.');
  const current = validateDeliverySnapshot(snapshotFor('later-revision'));
  const versions = deliveryAssetVersions([...snapshot.artifacts, ...current.artifacts].map(data => ({ data })),
    { currentAssetVersionIds: current.artifacts.map(item => item.id) });
  const store = {
    getAsset: async (_project, id, filters) => getDeliveryAsset({ versions, assetId: id, filters }),
    listAssets: async (_project, filters) => listDeliveryAssets({ versions, filters }),
  };
  const request = (route, filters) => deliveryResponse({ method: 'GET', store,
    url: new URL(`http://local/forge-gateway/api/delivery/${route}?${new URLSearchParams({ project: 'forge-base', ...filters })}`) });
  const detail = await request(`assets/${assetId}`, { revision: label });
  assert.equal(detail.body.item.revision, label);
  assert.equal(detail.body.item.isCurrent, false, 'An explicit revision must not return the current revision.');
  const linked = await request('assets', { kind: 'permission', functionId, functionRevision: label });
  assert.equal(linked.body.total, 1);
  assert.equal(linked.body.items[0].functionRefs[0].revision, label);
  assert.equal((await request('assets', { functionId, functionRevision: 'missing/revision' })).body.total, 0);
  await assert.rejects(request(`assets/${assetId}`, { revision: 'missing/revision' }), { code: 'DELIVERY_NOT_FOUND' });

  const longest = 'r'.repeat(191);
  const bounded = structuredClone(snapshot); bounded.artifacts[0].payload.revision = longest;
  validateDeliverySnapshot(bounded);
  assert.equal(deliveryQuery(new URLSearchParams({ project: 'forge-base', revision: longest, functionId, functionRevision: longest })).filters.functionRevision, longest);
  for (const invalid of ['', 'r'.repeat(192), 'x\u0000y', 'x\ty', 'x\ny', 'x\u007fy', 17, null, {}, []]) {
    const bad = structuredClone(snapshot); bad.artifacts[0].payload.revision = invalid;
    assert.throws(() => validateDeliverySnapshot(bad), { code: 'DELIVERY_INPUT_INVALID' });
    if (typeof invalid === 'string') for (const key of ['revision', 'functionRevision']) {
      assert.throws(() => deliveryQuery(new URLSearchParams({ project: 'forge-base', functionId, [key]: invalid })), { code: 'DELIVERY_INVALID_QUERY' });
    }
  }
  assert.throws(() => deliveryQuery(new URLSearchParams({ project: 'forge-base', functionRevision: label })), { code: 'DELIVERY_INVALID_QUERY' });
  for (const key of ['recordId', 'menuId', 'functionId']) {
    assert.throws(() => deliveryQuery(new URLSearchParams({ project: 'forge-base', [key]: 'invalid/id' })), { code: 'DELIVERY_INVALID_QUERY' });
  }
  const badId = structuredClone(snapshot); badId.artifacts[0].payload.assetId = 'invalid/id';
  assert.throws(() => validateDeliverySnapshot(badId), { code: 'DELIVERY_INPUT_INVALID' });
});

function asset(versionId, options = {}) {
  return { data: { id: versionId, kind: 'specification-asset', stageId: options.stageId ?? null, releaseId: null,
    payload: { assetId: options.assetId ?? 'entity-person', kind: options.kind ?? 'entity', name: options.name ?? '人员', description: '跨菜单共享人员',
      menuIds: options.menuIds ?? ['101', '102'], menuPaths: [], batchIds: options.batchIds ?? ['batch-old'], revision: options.revision ?? versionId,
      sourceRevision: options.sourceRevision ?? 'commit-1', recordedAt: options.recordedAt ?? '2026-10-01T00:00:00Z', status: 'implementation-observed', certainty: 'implementation-derived',
      sources: [{ sourcePath: 'domain/Person.java', commit: 'a'.repeat(40) }], details: { fields: [{ name: options.fieldName ?? 'name' }] }, relations: [], commits: ['a'.repeat(40)], releaseIds: options.releaseIds ?? [], diagram: null } },
    stage_current: options.stageCurrent ?? null };
}

test('collected checkpoint objects are visible by menu without promoting or flattening branch revisions', () => {
  const checkpoint = (id, taskId, options = {}) => {
    const row = asset(id, { revision: 'v1', ...options });
    Object.assign(row.data.payload, { sourceScope: 'taskspace-checkpoint', adoption: { state: 'unknown' },
      sources: [{ sourceScope: 'taskspace-checkpoint', taskId, batchId: row.data.payload.batchIds[0] }] });
    return row;
  };
  const rows = [asset('formal'), checkpoint('branch-a-old', 'task-a'),
    checkpoint('branch-a-new', 'task-a', { recordedAt: '2026-10-03T00:00:00Z', batchIds: ['batch-new'] }),
    checkpoint('branch-z', 'task-z', { recordedAt: '2026-10-09T00:00:00Z', batchIds: ['batch-z'] }),
    checkpoint('second-object', 'task-z', { assetId: 'entity-second', batchIds: ['batch-z'] })];
  const original = structuredClone(rows);
  const versions = deliveryAssetVersions(rows, { currentAssetVersionIds: ['formal'] });
  const listed = listDeliveryAssets({ versions, menus, filters: { menuId: '101', projection: 'summary' } });
  assert.equal(listed.total, 2); assert.equal(deliveryAssetCounts(versions).entity, 2);
  const person = listed.items.find(item => item.assetId === 'entity-person');
  assert.equal(person.versionId, 'formal'); assert.equal(person.readingSelection.basis, 'current-definition');
  assert.deepEqual(person.readingSelection.candidates.map(item => item.versionId), ['branch-a-new', 'branch-z']);
  assert.equal(person.readingSelection.candidateCount, 2);
  assert.ok(person.readingSelection.candidates.every(item => !item.details && !item.isCurrent));
  const drafts = versions.filter(item => !item.isCurrent);
  const preview = getDeliveryAsset({ versions: drafts, menus, assetId: 'entity-person', filters: { detailMode: 'single' } });
  assert.equal(preview.versionId, 'branch-a-new', 'Another branch being newer must not elect it.');
  assert.equal(preview.readingSelection.basis, 'checkpoint-preview'); assert.equal(preview.isCurrent, false);
  assert.equal(preview.adoption.state, 'unknown'); assert.equal(preview.revisions.length, 3);
  assert.equal(getDeliveryAsset({ versions, assetId: 'entity-person', filters: { revision: 'branch-z' } }).versionId, 'branch-z');
  const historical = listDeliveryAssets({ versions, menus, filters: { batchId: 'batch-new' } });
  assert.deepEqual(historical.items.map(item => item.versionId), ['branch-a-new']);
  assert.equal(historical.items[0].readingSelection, undefined);
  assert.equal(listDeliveryAssets({ versions, menus, filters: { releaseId: 'unknown' } }).total, 0);
  assert.deepEqual(rows, original, 'Reading must not rewrite checkpoint, adoption or source facts.');
});

test('checkpoint lineage menu removal cannot revive old revisions while another bound branch remains visible', () => {
  const checkpoint = (id, taskId, menuIds, recordedAt) => {
    const row = asset(id, { menuIds, recordedAt });
    Object.assign(row.data.payload, { sourceScope: 'taskspace-checkpoint',
      sources: [{ sourceScope: 'taskspace-checkpoint', taskId }] });
    return row;
  };
  const old = checkpoint('same-task-old', 'task-a', ['101'], '2026-10-01T00:00:00Z');
  const current = checkpoint('same-task-new', 'task-a', ['102'], '2026-10-02T00:00:00Z');
  const query = rows => listDeliveryAssets({ versions: deliveryAssetVersions(rows), menus, filters: { menuId: '101', menuScope: 'self' } });
  assert.equal(query([old, current]).total, 0, 'A removed menu binding must not fall back to the old checkpoint.');
  const other = checkpoint('other-branch-bound', 'task-z', ['101'], '2026-09-30T00:00:00Z');
  const result = query([old, current, other]);
  assert.equal(result.total, 1); assert.equal(result.items[0].versionId, 'other-branch-bound');
  assert.deepEqual(result.items[0].readingSelection.candidates.map(item => item.versionId), ['other-branch-bound']);
  assert.equal(result.items[0].isCurrent, false);
});

test('collected overview counts checkpoint identities using one bounded scalar read', async () => {
  const calls = [];
  const pool = { async execute(sql) {
    calls.push(sql);
    if (sql.startsWith('SELECT slug, name, observed_at, coverage')) return [[{ slug: 'forge-base', coverage: {} }]];
    if (sql.includes('COUNT(*)')) return [[{ total: 0 }]];
    assert.match(sql, /payload.sourceScope/u); assert.doesNotMatch(sql, /SELECT a\.data\b/u);
    return [[{ id: 'a', asset_id: 'one', asset_kind: 'entity', source_scope: 'taskspace-checkpoint' },
      { id: 'b', asset_id: 'one', asset_kind: 'entity', source_scope: 'taskspace-checkpoint' },
      { id: 'c', asset_id: 'two', asset_kind: 'table', source_scope: 'taskspace-checkpoint' }]];
  }, getConnection() {} };
  const result = await new DeliveryCenterStore({ pool }).overview('forge-base');
  assert.equal(result.assetCounts.entity, 1); assert.equal(result.assetCounts.table, 1);
  assert.equal(calls.filter(sql => sql.includes('FROM delivery_center_artifacts a')).length, 1);
});

test('explicit packet heads and accepted stage heads select current versions without turning latest observations into heads', () => {
  const rows = [asset('person-v1'), asset('person-v2', { recordedAt: '2026-10-02T00:00:00Z', fieldName: 'fullName' }),
    asset('person-unselected-newer', { recordedAt: '2026-10-07T00:00:00Z' }),
    asset('page-old', { assetId: 'page-one', kind: 'page', stageId: 'old-stage', stageCurrent: 0 }),
    asset('page-current', { assetId: 'page-one', kind: 'page', stageId: 'current-stage', stageCurrent: 1 })];
  const versions = deliveryAssetVersions(rows, { currentAssetVersionIds: ['person-v2'] });
  assert.deepEqual(listDeliveryAssets({ versions, menus }).items.map(item => item.versionId).sort(), ['page-current', 'person-v2']);
  assert.equal(deliveryAssetCounts(versions).entity, 1);
  assert.equal(deliveryAssetCounts(versions).page, 1);
  const detail = getDeliveryAsset({ versions, menus, assetId: 'entity-person' });
  assert.equal(detail.versionId, 'person-v2'); assert.equal(detail.revisions.length, 3);
  assert.equal(detail.revisions.find(item => item.versionId === 'person-v1').details.fields[0].name, 'name');
  assert.equal(detail.details.fields[0].name, 'fullName');
  assert.deepEqual(detail.usedByMenus.map(menu => menu.id), ['101', '102']);
  assert.equal(getDeliveryAsset({ versions, menus, assetId: 'entity-person', filters: { revision: 'person-v1' } }).isCurrent, false);
});

test('stable database menu IDs, descendant trees and aliases filter shared definitions once', () => {
  const versions = deliveryAssetVersions([asset('person-v1', { menuIds: ['legacy-menu'] })],
    { currentAssetVersionIds: ['person-v1'], menuAliases: { 'legacy-menu': '101' } });
  for (const menuId of ['100', '101']) assert.equal(listDeliveryAssets({ versions, menus, filters: { menuId } }).total, 1);
  assert.equal(listDeliveryAssets({ versions, menus, filters: { menuId: '102' } }).total, 0);
  assert.equal(listDeliveryAssets({ versions, menus, filters: { menuId: 'missing' } }).total, 0);
  assert.equal(listDeliveryAssets({ versions, menus, filters: { kind: 'table' } }).total, 0);
  assert.equal(listDeliveryAssets({ versions, menus, filters: { q: '人员' } }).total, 1);
  assert.deepEqual(getDeliveryAsset({ versions, menus, assetId: 'entity-person' }).usedByMenus.map(menu => menu.id), ['101']);
});

test('menu descendant queries terminate for cycles and self-links and scan deep reverse trees once', () => {
  const cyclic = [{ id: 'a', parentId: 'c' }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }, { id: 'self', parentId: 'self' }];
  assert.deepEqual([...deliveryMenuDescendants(cyclic, 'a')], ['a', 'b', 'c']);
  assert.deepEqual([...deliveryMenuDescendants(cyclic, 'self')], ['self']);
  let parentReads = 0;
  const deep = Array.from({ length: 10000 }, (_, index) => ({ id: String(index), get parentId() { parentReads++; return index === 0 ? null : String(index - 1); } })).reverse();
  assert.equal(deliveryMenuDescendants(deep, '0').size, 10000);
  assert.ok(parentReads <= 30000, `The bounded tree was repeatedly rescanned (${parentReads} parent reads).`);
});

test('overview counts only scalar asset metadata while preserving explicit heads, shared identity and stage state', async () => {
  const calls = [];
  const coverage = { currentAssetVersionIds: ['person-v2', 'person-copy'], menuAliases: { old: '100' }, availability: 'ready' };
  const pool = { async execute(sql, parameters) {
    calls.push({ sql, parameters });
    if (sql.startsWith('SELECT slug, name, observed_at, coverage')) return [[{ slug: 'forge-base', name: '示例客户', observed_at: '2026-10-07T00:00:00Z', coverage }]];
    if (sql.includes('COUNT(*)')) return [[{ total: 1 }]];
    assert.doesNotMatch(sql, /SELECT a\.data\b/u);
    assert.match(sql, /JSON_UNQUOTE\(JSON_EXTRACT\(a.data, '\$\.payload.assetId'\)\) AS asset_id/u);
    assert.ok(sql.endsWith('LIMIT 10001'));
    return [[
      { id: 'person-v1', stage_id: null, asset_id: 'person', asset_kind: 'entity', recorded_at: '2026-10-01T00:00:00Z', stage_current: null },
      { id: 'person-v2', stage_id: null, asset_id: 'person', asset_kind: 'entity', recorded_at: '2026-10-02T00:00:00Z', stage_current: null },
      { id: 'person-copy', stage_id: null, asset_id: 'person', asset_kind: 'entity', recorded_at: '2026-10-03T00:00:00Z', stage_current: null },
      { id: 'page-old', stage_id: 'old-stage', asset_id: 'page', asset_kind: 'page', recorded_at: '2026-10-03T00:00:00Z', stage_current: 0 },
      { id: 'page-current', stage_id: 'new-stage', asset_id: 'page', asset_kind: 'page', recorded_at: '2026-10-04T00:00:00Z', stage_current: 1 },
    ]];
  }, getConnection() {}, async end() {} };
  const result = await new DeliveryCenterStore({ pool }).overview('forge-base');
  assert.equal(result.assetCounts.entity, 1); assert.equal(result.assetCounts.page, 1); assert.equal(result.assetCounts.table, 0);
  assert.deepEqual(result.coverage, { availability: 'ready' });
  assert.deepEqual(coverage.currentAssetVersionIds, ['person-v2', 'person-copy']);
  assert.deepEqual(coverage.menuAliases, { old: '100' });
  assert.equal(calls.filter(call => call.sql.includes('FROM delivery_center_artifacts a')).length, 1);
});

test('successful frozen stage evidence selects the exact task revision without borrowing current assets', () => {
  const digest = 'a'.repeat(64), wrong = 'b'.repeat(64);
  const row = asset('frozen-api', { assetId: 'api-record', kind: 'api', sourceRevision: digest, stageId: 'historical-stage' });
  row.data.payload.sources = [{ taskId: 'task-a', digest }];
  const otherTask = structuredClone(row); otherTask.data.id = 'other-task'; otherTask.data.payload.assetId = 'api-other'; otherTask.data.payload.sources[0].taskId = 'task-b';
  const current = asset('current-api', { assetId: 'api-record', kind: 'api', sourceRevision: wrong, stageId: 'current-stage', stageCurrent: 1 });
  current.data.payload.sources = [{ taskId: 'task-a', digest: wrong }];
  const versions = deliveryAssetVersions([row, otherTask, current]);
  const release = { id: 'release-one', status: 'success', scopeBinding: 'frozen-explicit-snapshot', taskId: 'task-a', commit: 'c'.repeat(40),
    scopeBindingEvidence: { scope: 'validated-task-delivery', taskId: 'task-a', commit: 'c'.repeat(40), acceptedArtifactDigests: { api: digest } } };
  assert.deepEqual(listDeliveryAssets({ versions, menus, filters: { releaseId: release.id }, release }).items.map(item => item.versionId), ['frozen-api']);
  assert.equal(listDeliveryAssets({ versions, menus, filters: { releaseId: release.id }, release: { ...release, scopeBinding: 'unknown' } }).total, 0);
  assert.equal(listDeliveryAssets({ versions, menus, filters: { releaseId: release.id }, release: { ...release, commit: 'd'.repeat(40) } }).total, 0);
});

test('historical batch selection stays historical and unknown releases never read current assets', () => {
  const versions = deliveryAssetVersions([asset('person-old'), asset('person-current', { batchIds: ['batch-new'] })], { currentAssetVersionIds: ['person-current'] });
  const historic = listDeliveryAssets({ versions, menus, filters: { batchId: 'batch-old' } });
  assert.equal(historic.items[0].versionId, 'person-old'); assert.equal(historic.items[0].isCurrent, false);
  const release = { id: 'release-old', status: 'success', scopeBinding: 'unknown' };
  assert.deepEqual(listDeliveryAssets({ versions, menus, filters: { releaseId: release.id }, release }).items, []);
  assert.equal(getDeliveryAsset({ versions, menus, assetId: 'entity-person', filters: { releaseId: release.id }, release }), null);
  const bound = { ...release, scopeBinding: 'frozen-explicit-snapshot' };
  assert.equal(listDeliveryAssets({ versions, menus, filters: { releaseId: release.id }, release: bound }).scopeBinding, 'unknown');
  const explicit = deliveryAssetVersions([asset('person-released', { releaseIds: ['release-old'] })]);
  assert.equal(listDeliveryAssets({ versions: explicit, menus, filters: { releaseId: release.id }, release: bound }).total, 1);
});

test('store asset queries bind values and return complete bounded revisions through HTTP', async () => {
  const rows = [asset('person-v1'), asset('person-v2', { recordedAt: '2026-10-02T00:00:00Z', fieldName: 'fullName' })];
  const calls = [];
  const pool = { async execute(sql, parameters) {
    calls.push({ sql, parameters });
    if (sql.includes('SELECT coverage')) return [[{ coverage: { currentAssetVersionIds: ['person-v2'] } }]];
    if (sql.includes('FROM delivery_center_artifacts a')) return [rows];
    if (sql.includes('FROM delivery_center_menus')) return [menus.map(data => ({ data }))];
    throw new Error(`unexpected SQL: ${sql}`);
  }, getConnection() {}, async end() {} };
  const store = new DeliveryCenterStore({ pool });
  const list = await deliveryResponse({ method: 'GET', url: new URL('http://local/forge-gateway/api/delivery/assets?project=forge-base&kind=entity&menuId=100'), store });
  assert.equal(list.body.total, 1); assert.equal(list.body.items[0].versionId, 'person-v2');
  const detail = await deliveryResponse({ method: 'GET', url: new URL('http://local/forge-gateway/api/delivery/assets/entity-person?project=forge-base&revision=person-v1'), store });
  assert.equal(detail.body.item.details.fields[0].name, 'name'); assert.equal(detail.body.item.revisions.length, 2);
  assert.ok(calls.some(call => call.sql.includes("'$.payload.assetId')) = ?") && call.parameters.includes('entity-person')));
  assert.ok(calls.some(call => call.sql.includes('s.is_current = TRUE')));
  await assert.rejects(deliveryResponse({ method: 'POST', url: new URL('http://local/forge-gateway/api/delivery/assets?project=forge-base'), store }), { code: 'DELIVERY_READ_ONLY' });
  assert.throws(() => deliveryQuery(new URLSearchParams('project=forge-base&kind=invalid')), { code: 'DELIVERY_INVALID_QUERY' });
  assert.throws(() => deliveryQuery(new URLSearchParams('project=forge-base&revision=a&revision=b')), { code: 'DELIVERY_INVALID_QUERY' });
});

test('asset versions are bounded explicitly and selected revision is retained in the comparison set', () => {
  const rows = Array.from({ length: 105 }, (_, index) => asset(`version-${index}`, { recordedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString() }));
  const versions = deliveryAssetVersions(rows, { currentAssetVersionIds: ['version-104'] });
  const detail = getDeliveryAsset({ versions, menus, assetId: 'entity-person', filters: { revision: 'version-0' } });
  assert.equal(detail.revisions.length, 100); assert.equal(detail.revisionsHasMore, true);
  assert.ok(detail.revisions.some(item => item.versionId === 'version-0'));
});

test('snapshot validation forbids mutable markers inside immutable asset payloads', () => {
  const snapshot = { schemaVersion: 1, project: { slug: 'forge-base', name: '示例客户' }, observedAt: '2026-10-07T00:00:00Z',
    coverage: { currentAssetVersionIds: ['person-v1'] }, menus: [], requirements: [], batches: [], stages: [], releases: [], artifacts: [asset('person-v1').data] };
  validateDeliverySnapshot(snapshot);
  snapshot.artifacts[0].payload.isCurrent = true;
  assert.throws(() => validateDeliverySnapshot(snapshot), { code: 'DELIVERY_INPUT_INVALID' });
});

test('historical requirement bodies are persisted with source time and exposed as full revision data', async () => {
  const requirement = { id: 'shared-requirement', menuId: '101', menuIds: ['101', '102'], menuPath: ['业务管理', '作业人员'], page: null,
    name: '人员校验规则', description: '新版规则', fields: [], actions: [], rules: [], permissions: [], sources: [], batchIds: [], stageStatus: {}, status: 'documented',
    revision: 'new', sourceRecordedAt: '2026-10-02T00:00:00.000Z' };
  const previous = { ...requirement, revision: 'old', description: '旧版规则', sourceRecordedAt: '2026-10-01T00:00:00.000Z' };
  const calls = [];
  const connection = { async execute(sql, parameters) {
    calls.push({ sql, parameters });
    if (sql.startsWith('SELECT snapshot_digest')) return [[{ snapshot_digest: '' }]];
    return [[]];
  }, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
  const store = new DeliveryCenterStore({ pool: { execute: connection.execute, getConnection: async () => connection, async end() {} } });
  await store.importSnapshot({ schemaVersion: 1, project: { slug: 'forge-base', name: '示例客户' }, observedAt: '2026-10-07T00:00:00Z', coverage: {},
    menus, batches: [], requirements: [requirement], requirementVersions: [previous], stages: [], releases: [], artifacts: [] });
  const writes = calls.filter(call => call.sql.startsWith('INSERT IGNORE INTO delivery_center_requirement_versions'));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].parameters[3], previous.sourceRecordedAt);
  assert.equal(JSON.parse(writes[1].parameters[4]).description, '旧版规则');
  const historicalPool = { async execute(sql) {
    if (sql.startsWith('SELECT data, is_current')) return [[]];
    return [[{ content_digest: 'd'.repeat(64), observed_at: previous.sourceRecordedAt, data: previous }]];
  }, getConnection() {}, async end() {} };
  const detail = await new DeliveryCenterStore({ pool: historicalPool }).getRequirement('forge-base', previous.id);
  assert.equal(detail.isCurrent, false); assert.equal(detail.revisions[0].description, '旧版规则');
});
