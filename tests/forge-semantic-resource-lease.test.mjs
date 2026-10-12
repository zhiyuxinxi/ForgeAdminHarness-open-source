import assert from 'node:assert/strict';
import test from 'node:test';
import fixture from './fixtures/forge-semantic-resource-lease/valid.json' with { type: 'json' };
import {
  ForgeSemanticLeaseError,
  acquireForgeSemanticResourceLease,
  createForgeSemanticLeaseRegistry,
  forgeSemanticResourcesOverlap,
  normalizeForgeSemanticResources,
  releaseForgeSemanticResourceLease,
  renewForgeSemanticResourceLease,
} from '../docker/harness/forge-semantic-resource-lease.mjs';

function registry() { return createForgeSemanticLeaseRegistry(structuredClone(fixture.registry)); }
function request() { return structuredClone(fixture.acquire); }
function expectCode(code, callback) { assert.throws(callback, (error) => { assert.ok(error instanceof ForgeSemanticLeaseError); assert.equal(error.code, code); return true; }); }

test('semantic resources: explicit new identities normalize without interpreting source paths', () => {
  const input = [{ type: 'ui-component', key: 'admin/OrderForm' },
    { type: 'table-column', key: 'Public.Orders#Status' },
    { type: 'migration-version', key: 'order-db@V20261002_01' }];
  const before = structuredClone(input);
  const normalized = normalizeForgeSemanticResources(input);
  assert.deepEqual(normalized, [
    { type: 'migration-version', key: 'order-db@V20261002_01' },
    { type: 'table-column', key: 'public.orders#status' },
    { type: 'ui-component', key: 'admin/OrderForm' },
  ]);
  assert.deepEqual(input, before);
  assert.ok(Object.isFrozen(normalized) && normalized.every(Object.isFrozen));
  for (const resource of normalized.filter(item => item.type !== 'table-column')) {
    assert.equal(forgeSemanticResourcesOverlap([resource], [{ ...resource }]), true);
    assert.equal(forgeSemanticResourcesOverlap([resource], [{ ...resource, key: `${resource.key}Other` }]), false);
  }
});

test('semantic resources: whole tables conflict with their columns, while different columns remain independent', () => {
  const table = [{ type: 'table', key: 'PUBLIC.ORDERS' }];
  const column = [{ type: 'table-column', key: 'public.orders#status' }];
  assert.equal(forgeSemanticResourcesOverlap(table, column), true);
  assert.equal(forgeSemanticResourcesOverlap(column, table), true);
  assert.equal(forgeSemanticResourcesOverlap(column, [{ type: 'table-column', key: 'Public.Orders#Status' }]), true);
  assert.equal(forgeSemanticResourcesOverlap(column, [{ type: 'table-column', key: 'public.orders#owner' }]), false);
  assert.equal(forgeSemanticResourcesOverlap(table, [{ type: 'table-column', key: 'public.orders_archive#status' }]), false);
  assert.equal(forgeSemanticResourcesOverlap([], column), false);
  assert.equal(forgeSemanticResourcesOverlap(table, []), false);
  const first = acquireForgeSemanticResourceLease(registry(), { ...request(), resources: table });
  expectCode('SEMANTIC_RESOURCE_CONFLICT', () => acquireForgeSemanticResourceLease(first.registry, {
    ...separateResourceRequest(['another/column.sql']), resources: column,
  }));
  assert.equal(first.writerAuthorized, false);
});

test('semantic resources: bounds, malformed identities, duplicate aliases and unknown fields fail closed', () => {
  const invalid = [[], null, Array.from({ length: 257 }, (_, index) => ({ type: 'table', key: `table_${index}` })),
    [{ type: 'table-column', key: 'orders.status' }], [{ type: 'table-column', key: '../orders#status' }],
    [{ type: 'migration-version', key: 'V1' }], [{ type: 'migration-version', key: `db@${'1'.repeat(254)}` }],
    [{ type: 'ui-component', key: 'src/views/Order.vue' }], [{ type: 'backend-module-contract', key: 'orders' }],
    [{ type: 'table', key: 'orders', extra: true }],
    [{ type: 'table-column', key: 'ORDERS#STATUS' }, { type: 'table-column', key: 'orders#status' }]];
  for (const value of invalid) assert.throws(() => normalizeForgeSemanticResources(value), ForgeSemanticLeaseError);
  assert.throws(() => forgeSemanticResourcesOverlap(undefined, []), ForgeSemanticLeaseError);
});

test('same semantic API, permission, or table conflicts even when owned paths differ', () => {
  const first = acquireForgeSemanticResourceLease(registry(), request());
  assert.equal(first.writerAuthorized, false);
  const second = request();
  second.expectedRevision = first.registry.revision;
  second.leaseId = '123e4567-e89b-42d3-a456-426614174202';
  second.taskId = 'task-menu-seed';
  second.actorUserId = '123e4567-e89b-42d3-a456-426614174203';
  second.ownedPaths = ['forge-server/db/migration/V99__menu.sql'];
  second.resources = [{ type: 'permission', key: 'business:order:edit' }];
  expectCode('SEMANTIC_RESOURCE_CONFLICT', () => acquireForgeSemanticResourceLease(first.registry, second));
});
test('API keys normalize method, braces, slashes, and trailing slash before conflict detection', () => {
  const firstRequest = request(); firstRequest.resources = [{ type: 'api', key: 'post /business//order/{id}/' }];
  const first = acquireForgeSemanticResourceLease(registry(), firstRequest);
  const second = request(); second.expectedRevision = 1; second.leaseId = '123e4567-e89b-42d3-a456-426614174204'; second.resources = [{ type: 'api', key: 'POST /business/order/:id' }];
  expectCode('SEMANTIC_RESOURCE_CONFLICT', () => acquireForgeSemanticResourceLease(first.registry, second));
});

test('non-overlapping semantic resources can coexist across separate paths', () => {
  const first = acquireForgeSemanticResourceLease(registry(), request());
  const second = request(); second.expectedRevision = 1; second.leaseId = '123e4567-e89b-42d3-a456-426614174205'; second.taskId = 'task-workflow'; second.actorUserId = '123e4567-e89b-42d3-a456-426614174206'; second.ownedPaths = ['forge-server/workflow/order.bpmn20.xml']; second.resources = [{ type: 'workflow', key: 'orderApproval' }];
  const result = acquireForgeSemanticResourceLease(first.registry, second);
  assert.equal(result.registry.leases.length, 2);
  assert.equal(result.cas.expectedRevision, 1);
  assert.equal(result.cas.nextRevision, 2);
});

function separateResourceRequest(ownedPaths) {
  return { ...request(), expectedRevision: 1, leaseId: '123e4567-e89b-42d3-a456-426614174205',
    taskId: 'task-other-path', actorUserId: '123e4567-e89b-42d3-a456-426614174206',
    ownedPaths, resources: [{ type: 'workflow', key: 'separateResource' }] };
}

test('same path and parent-child scopes conflict even with distinct semantic resources', () => {
  for (const [firstPath, secondPath] of [['a/b', 'a/b'], ['a', 'a/b'], ['a/b', 'a'], ['a/b/c', 'a/b']]) {
    const first = acquireForgeSemanticResourceLease(registry(), { ...request(), ownedPaths: [firstPath] });
    const before = structuredClone(first.registry);
    expectCode('PATH_RESOURCE_CONFLICT', () => acquireForgeSemanticResourceLease(first.registry, separateResourceRequest([secondPath])));
    assert.deepEqual(first.registry, before);
    assert.equal(first.writerAuthorized, false);
  }
});

test('path aliases normalize before storage and overlap comparison', () => {
  for (const alias of ['a//b', 'a/./b', 'a/b/', './a///./b//']) {
    for (const [firstPath, secondPath] of [[alias, 'a/b'], ['a/b', alias]]) {
      const first = acquireForgeSemanticResourceLease(registry(), { ...request(), ownedPaths: [firstPath] });
      assert.deepEqual(first.registry.leases[0].ownedPaths, ['a/b']);
      expectCode('PATH_RESOURCE_CONFLICT', () => acquireForgeSemanticResourceLease(first.registry, separateResourceRequest([secondPath])));
    }
  }
  const first = acquireForgeSemanticResourceLease(registry(), { ...request(), ownedPaths: ['a//b/'] });
  expectCode('PATH_RESOURCE_CONFLICT', () => acquireForgeSemanticResourceLease(first.registry, separateResourceRequest(['a/./b/c/'])));
});

test('character prefixes and sibling paths are independent scopes', () => {
  for (const [firstPath, secondPath] of [['a', 'ab'], ['a/b', 'a/bc'], ['a/b', 'a/c']]) {
    const first = acquireForgeSemanticResourceLease(registry(), { ...request(), ownedPaths: [firstPath] });
    const result = acquireForgeSemanticResourceLease(first.registry, separateResourceRequest([secondPath]));
    assert.equal(result.registry.leases.length, 2);
    assert.equal(result.writerAuthorized, false);
  }
});

test('path normalization does not admit traversal, absolute, backslash or duplicate aliases', () => {
  for (const paths of [
    ['../a'], ['a/../b'], ['a//../b'], ['/a'], ['//a/b'], ['a\\b'], ['C:/a'],
    ['.'], ['./'], ['a/b', 'a//b'], ['a/b/', 'a/./b'],
  ]) {
    expectCode('SCHEMA_INVALID', () => acquireForgeSemanticResourceLease(registry(), { ...request(), ownedPaths: paths }));
  }
});

test('registry revision and lease version both use CAS', () => {
  const first = acquireForgeSemanticResourceLease(registry(), request());
  const staleAcquire = request(); staleAcquire.leaseId = '123e4567-e89b-42d3-a456-426614174207';
  expectCode('REGISTRY_CAS_CONFLICT', () => acquireForgeSemanticResourceLease(first.registry, staleAcquire));
  const renewed = renewForgeSemanticResourceLease(first.registry, { expectedRevision: 1, leaseId: request().leaseId, expectedLeaseVersion: 1, taskId: request().taskId, actorUserId: request().actorUserId, observedAt: '2026-09-01T00:05:00.000Z', expiresAt: '2026-09-01T00:15:00.000Z' });
  assert.equal(renewed.registry.leases[0].leaseVersion, 2);
  expectCode('LEASE_CAS_CONFLICT', () => renewForgeSemanticResourceLease(renewed.registry, { expectedRevision: 2, leaseId: request().leaseId, expectedLeaseVersion: 1, taskId: request().taskId, actorUserId: request().actorUserId, observedAt: '2026-09-01T00:06:00.000Z', expiresAt: '2026-09-01T00:16:00.000Z' }));
});

test('expired leases cannot renew and are pruned when another task acquires the resource', () => {
  const firstRequest = request(); firstRequest.expiresAt = '2026-09-01T00:05:00.000Z';
  const first = acquireForgeSemanticResourceLease(registry(), firstRequest);
  expectCode('LEASE_EXPIRED', () => renewForgeSemanticResourceLease(first.registry, { expectedRevision: 1, leaseId: firstRequest.leaseId, expectedLeaseVersion: 1, taskId: firstRequest.taskId, actorUserId: firstRequest.actorUserId, observedAt: '2026-09-01T00:05:00.000Z', expiresAt: '2026-09-01T00:10:00.000Z' }));
  const successor = request(); successor.expectedRevision = 1; successor.leaseId = '123e4567-e89b-42d3-a456-426614174208'; successor.taskId = 'task-successor'; successor.actorUserId = '123e4567-e89b-42d3-a456-426614174209'; successor.acquiredAt = '2026-09-01T00:06:00.000Z'; successor.expiresAt = '2026-09-01T00:12:00.000Z';
  const result = acquireForgeSemanticResourceLease(first.registry, successor);
  assert.deepEqual(result.registry.leases.map((item) => item.leaseId), [successor.leaseId]);
});

test('release is owner-bound and registry tampering fails closed', () => {
  const first = acquireForgeSemanticResourceLease(registry(), request());
  expectCode('LEASE_OWNER_MISMATCH', () => releaseForgeSemanticResourceLease(first.registry, { expectedRevision: 1, leaseId: request().leaseId, expectedLeaseVersion: 1, taskId: 'task-other', actorUserId: request().actorUserId }));
  const released = releaseForgeSemanticResourceLease(first.registry, { expectedRevision: 1, leaseId: request().leaseId, expectedLeaseVersion: 1, taskId: request().taskId, actorUserId: request().actorUserId });
  assert.deepEqual(released.registry.leases, []);
  const tampered = structuredClone(first.registry); tampered.leases[0].resources[0].key = 'POST /other';
  expectCode('REGISTRY_INTEGRITY_INVALID', () => acquireForgeSemanticResourceLease(tampered, { ...request(), expectedRevision: 1 }));
});
