import test from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../docker/harness/release-policy.mjs';

test('runtime probe v2 binds ordered CRUD references to protected scope and preserves v1', () => {
  const ref = name => ({ $capture: name });
  const browser = { status: 'not-executed', reason: 'owner-excluded' };
  const plan = {
    schemaVersion: 2,
    api: [
      { id: 'create', method: 'POST', path: '/probe-fixture/items', identity: 'ordinary_a', body: { label: 'isolated fixture' },
        expectedStatus: 200, jsonAssertions: [{ path: ['code'], equals: 200 }], captures: [{ name: 'createdId', path: ['data', 'id'] }] },
      { id: 'read', method: 'GET', path: '/probe-fixture/items/{id}', identity: 'ordinary_a', pathParameters: { id: ref('createdId') },
        query: { selectedId: ref('createdId'), page: 1 }, expectedStatus: 200, jsonAssertions: [{ path: ['data', 'id'], equals: ref('createdId') }] },
      { id: 'denyOtherIdentity', method: 'GET', path: '/probe-fixture/items/{id}', identity: 'ordinary_b', pathParameters: { id: ref('createdId') },
        expectedStatus: 403, jsonAssertions: [{ path: ['code'], equals: 403 }] },
      { id: 'update', method: 'PATCH', path: '/probe-fixture/items/{id}', identity: 'ordinary_a', pathParameters: { id: ref('createdId') },
        body: { nested: { id: ref('createdId'), values: [true, null] } }, expectedStatus: 200, jsonAssertions: [] },
      { id: 'delete', method: 'DELETE', path: '/probe-fixture/items/{id}', identity: 'ordinary_a', pathParameters: { id: ref('createdId') },
        expectedStatus: 200, jsonAssertions: [] },
      { id: 'deleted', method: 'GET', path: '/probe-fixture/items/{id}', identity: 'ordinary_a', pathParameters: { id: ref('createdId') },
        expectedStatus: 404, jsonAssertions: [] },
    ],
    database: [{ id: 'readRemaining', table: 'probe_fixture_items', columns: ['id'], where: [{ column: 'id', equals: ref('createdId') }], limit: 1, expectedRows: 0 }],
    browser,
  };
  assert.deepEqual(policy.validateRuntimeProbePlan(plan), plan);
  const scope = { artifactSha256: 'a'.repeat(64), endpoints: [
    { method: 'POST', path: '/probe-fixture/items' }, { method: 'GET', path: '/probe-fixture/items/{id}' },
    { method: 'PATCH', path: '/probe-fixture/items/{id}' }, { method: 'DELETE', path: '/probe-fixture/items/{id}' },
  ] };
  assert.deepEqual(policy.validateRuntimeProbeScope(scope, plan), scope);
  const rejectPlan = mutate => { const changed = structuredClone(plan); mutate(changed); assert.throws(() => policy.validateRuntimeProbePlan(changed)); };
  rejectPlan(p => { p.schemaVersion = 3; });
  rejectPlan(p => { delete p.api[0].identity; });
  rejectPlan(p => { p.api[0].identity = '../admin'; });
  rejectPlan(p => { p.api[1].body = {}; });
  rejectPlan(p => { p.api[0].headers = { Authorization: 'not-allowed' }; });
  rejectPlan(p => { p.api[0].body.id = ref('createdId'); });
  rejectPlan(p => { p.api[0].jsonAssertions[0].equals = ref('createdId'); });
  rejectPlan(p => { p.api[1].captures = [{ name: 'createdId', path: ['data', 'id'] }]; });
  rejectPlan(p => { p.api[1].query.id = ref('notCreated'); });
  rejectPlan(p => { p.api[1].pathParameters.id = { $capture: 'createdId', extra: true }; });
  rejectPlan(p => { delete p.api[1].pathParameters; });
  rejectPlan(p => { p.api[1].pathParameters.extra = 1; });
  rejectPlan(p => { p.api[0].body = JSON.parse('{"__proto__":{"polluted":true}}'); });
  rejectPlan(p => { p.api[0].body = { inherited: Object.create({ hidden: true }) }; });
  rejectPlan(p => { p.api[1].query = JSON.parse('{"constructor":1}'); });
  rejectPlan(p => { p.api[0].captures[0].path = ['data', 'constructor']; });
  for (const secret of ['accessToken', 'passwordHash', 'Authorization', 'session_key', 'clientSecret', 'cookies']) {
    rejectPlan(p => { p.api[0].captures[0].path = ['data', secret]; });
  }
  for (const endpoint of ['https://outside.invalid/items', '//outside.invalid/items', '/x?target=x', '/x#fragment', '/x/../items', '/%2e%2e/items', '/x\\items', '/x/{id}/suffix{id}']) {
    rejectPlan(p => { p.api[0].path = endpoint; });
  }
  rejectPlan(p => { p.database[0].where[0].equals = ref('unknown'); });
  rejectPlan(p => { p.database[0].table = 'items; DELETE FROM items'; });
  rejectPlan(p => { p.database[0].sql = 'SELECT * FROM items'; });
  rejectPlan(p => { let value = 1; for (let i = 0; i < 10; i++) value = { nested: value }; p.api[0].body = value; });
  rejectPlan(p => { p.api[0].body = { values: Array(65).fill(1) }; });
  rejectPlan(p => { p.api[0].body = { values: Array(30).fill('x'.repeat(2048)) }; });
  rejectPlan(p => { p.api[0].body = { value: Infinity }; });
  rejectPlan(p => { p.api[0].captures[0].name = '__proto__'; });
  const bounded = { schemaVersion: 2, api: Array.from({ length: 64 }, (_, i) => ({ id: `probe${i}`, method: 'GET', path: '/probe-fixture/read', expectedStatus: 200, jsonAssertions: [] })), database: [], browser };
  assert.deepEqual(policy.validateRuntimeProbePlan(bounded), bounded);
  assert.throws(() => policy.validateRuntimeProbePlan({ ...bounded, api: [...bounded.api, { ...bounded.api[0], id: 'probe65' }] }));
  assert.throws(() => policy.validateRuntimeProbePlan({ ...plan, database: Array.from({ length: 17 }, (_, i) => ({ ...plan.database[0], id: `db${i}` })) }));
  assert.throws(() => policy.validateRuntimeProbeScope({ ...scope, artifactSha256: 'unbound' }, plan));
  assert.throws(() => policy.validateRuntimeProbeScope({ ...scope, endpoints: scope.endpoints.filter(p => p.method !== 'PATCH') }, plan));
  assert.throws(() => policy.validateRuntimeProbeScope({ ...scope, endpoints: [{ method: 'GET', path: '/probe-fixture/items/*' }] }, plan));
  assert.throws(() => policy.validateRuntimeProbeScope({ ...scope, token: 'forbidden' }, plan));
  const projectRoot = '/srv/forge-delivery/projects/demo-project';
  const contract = {
    schemaVersion: 3, projectSlug: 'demo-project', composeProjectName: 'forge-demo-project', projectRoot, workspaceRoot: `${projectRoot}/workspace`,
    infrastructure: {
      mysql: { mode: 'shared-external', host: 'mysql.internal', port: 3306, database: 'forge_demo_project', testDatabase: 'forge_demo_project_test', provisioningAllowed: false },
      redis: { mode: 'shared-external', host: 'redis.internal', port: 6379, database: 2, testDatabase: 15, provisioningAllowed: false },
    },
    release: {
      fixedComposeFile: `${projectRoot}/ops/compose.yaml`,
      allowedComposeServices: ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui', 'release-runner', 'taskspace-broker', 'conversation-manager', 'protected-acceptance', 'verification-runner'],
      allowedReleaseServices: ['forge-admin', 'forge-app', 'forge-flow', 'forge-ui'],
      protectedFiles: ['Dockerfile.admin', 'Dockerfile.app', 'Dockerfile.flow', 'Dockerfile.ui', 'application-datasource.yml', 'docker-compose.yml', 'nginx.conf']
        .map((name, i) => ({ relativePath: `docker-forge-admin/${name}`, sha256: String(i + 1).repeat(64) })),
      databaseProvisioningAllowed: false, workspaceComposeAllowed: false,
      testDatabaseLifecycle: { mode: 'snapshot-restore-on-failure', backupRequired: true, restoreOnFailure: true, fullReplaySupported: false,
        operatorImage: `mysql:8.0@sha256:${'a'.repeat(64)}`, backupRoot: `${projectRoot}/backups/test-database-snapshots`, recoveryStateFile: `${projectRoot}/ops/test-database-recovery.json` },
    },
  };
  const request = {
    action: 'prepare', services: ['forge-admin', 'forge-ui'], approvalRef: 'protected-fixture',
    provenance: { source: 'taskspace', taskId: 'c-fixture', actorId: 'fixture-actor', conversationId: 'fixture-conversation', candidateCommit: 'a'.repeat(40) },
    runtimePreparation: { taskId: 'c-fixture', executionId: '11111111-1111-4111-8111-111111111111', stateDigest: 'b'.repeat(64), baseSourceCommit: 'c'.repeat(40), workspaceFingerprint: 'd'.repeat(64), acceptedPatchSha256: 'e'.repeat(64), candidateTree: 'f'.repeat(40), probePlan: plan, apiScope: scope },
  };
  assert.deepEqual(policy.validateReleaseRequest(request, contract).runtimePreparation.apiScope, scope);
  const missingScope = structuredClone(request); delete missingScope.runtimePreparation.apiScope;
  assert.throws(() => policy.validateReleaseRequest(missingScope, contract));
  const narrowedScope = structuredClone(request); narrowedScope.runtimePreparation.apiScope.endpoints.pop();
  assert.throws(() => policy.validateReleaseRequest(narrowedScope, contract));
  const v1 = { schemaVersion: 1, api: [{ id: 'existing', method: 'GET', path: '/probe-fixture/read?page=1', expectedStatus: 401, jsonAssertions: [{ path: ['code'], equals: 401 }] }], database: [], browser };
  assert.deepEqual(policy.validateRuntimeProbePlan(v1), v1);
  missingScope.runtimePreparation.probePlan = v1;
  assert.deepEqual(policy.validateReleaseRequest(missingScope, contract).runtimePreparation.probePlan, v1);
  for (const extra of [{ identity: 'ordinary_a' }, { captures: [] }, { body: {} }]) {
    const changed = structuredClone(v1); Object.assign(changed.api[0], extra); assert.throws(() => policy.validateRuntimeProbePlan(changed));
  }
  const fixturePlan = { ...structuredClone(plan), identityFixtures: [
    { identity: 'ordinary_a', orgId: '123', roleKeys: ['ITEM_WRITER'] },
    { identity: 'ordinary_b', orgId: '9223372036854775807', roleKeys: [] },
  ] };
  const identityScope = { artifactSha256: '9'.repeat(64), roleKeys: ['ITEM_WRITER', 'ITEM_READER'] };
  assert.deepEqual(policy.validateRuntimeProbePlan(fixturePlan), fixturePlan);
  assert.deepEqual(policy.validateRuntimeIdentityScope(identityScope, fixturePlan), identityScope);
  const fixtureRequest = structuredClone(request);
  fixtureRequest.runtimePreparation.probePlan = fixturePlan;
  fixtureRequest.runtimePreparation.identityScope = identityScope;
  assert.deepEqual(policy.validateReleaseRequest(fixtureRequest, contract).runtimePreparation.identityScope, identityScope);
  const noIdentityScope = structuredClone(fixtureRequest); delete noIdentityScope.runtimePreparation.identityScope;
  assert.throws(() => policy.validateReleaseRequest(noIdentityScope, contract));
  const noApiScope = structuredClone(fixtureRequest); delete noApiScope.runtimePreparation.apiScope;
  assert.throws(() => policy.validateReleaseRequest(noApiScope, contract));
  assert.throws(() => policy.validateReleaseRequest({ ...request,
    runtimePreparation: { ...request.runtimePreparation, identityScope } }, contract));
  const rejectFixture = mutate => {
    const changed = structuredClone(fixturePlan); mutate(changed);
    assert.throws(() => policy.validateRuntimeProbePlan(changed));
  };
  for (const orgId of ['0', '-1', '01', '1.5', '9223372036854775808', 123, '1;DELETE']) {
    rejectFixture(p => { p.identityFixtures[0].orgId = orgId; });
  }
  rejectFixture(p => { p.identityFixtures[0].identity = 'unreferenced'; });
  rejectFixture(p => { p.identityFixtures.push(structuredClone(p.identityFixtures[0])); });
  rejectFixture(p => { p.identityFixtures = Array(17).fill(p.identityFixtures[0]); });
  rejectFixture(p => { p.identityFixtures[0].roleKeys = ['ITEM_WRITER', 'ITEM_WRITER']; });
  rejectFixture(p => { p.identityFixtures[0].roleKeys = Array.from({ length: 17 }, (_, i) => `ROLE_${i}`); });
  rejectFixture(p => { p.identityFixtures[0].roleKeys = ['*']; });
  rejectFixture(p => { p.identityFixtures[0].roleKeys = [{ key: 'ITEM_WRITER' }]; });
  for (const key of ['userId', 'tenantId', 'password', 'sql', 'orgIds']) {
    rejectFixture(p => { p.identityFixtures[0][key] = 'forbidden'; });
  }
  rejectFixture(p => { p.identityScope = identityScope; });
  assert.throws(() => policy.validateRuntimeIdentityScope({ ...identityScope, roleKeys: ['ITEM_READER'] }, fixturePlan));
  assert.throws(() => policy.validateRuntimeIdentityScope({ ...identityScope, artifactSha256: 'unbound' }, fixturePlan));
  assert.throws(() => policy.validateRuntimeIdentityScope({ ...identityScope, roleKeys: ['ITEM_WRITER', 'ITEM_WRITER'] }, fixturePlan));
  assert.throws(() => policy.validateRuntimeIdentityScope({ ...identityScope, tenantId: '1' }, fixturePlan));
  assert.throws(() => policy.validateRuntimeIdentityScope(identityScope, v1));
  assert.throws(() => policy.validateRuntimeProbePlan({ ...v1, identityFixtures: [] }));
  assert.deepEqual(policy.validateRuntimeProbePlan({ ...plan, identityFixtures: [] }).identityFixtures, []);
  const capabilities = policy.getRuntimeProbeCapabilities();
  assert.deepEqual(capabilities.versions[2].planOptionalFields, ['identityFixtures']);
  assert.deepEqual(capabilities.versions[2].identityFixtures.fields, ['identity', 'orgId', 'roleKeys']);
  assert.equal(capabilities.versions[2].identityFixtures.maximum, 16);
  assert.equal(capabilities.versions[2].identityFixtures.maximumRoles, 16);
  assert.equal(capabilities.versions[2].identityFixtures.organizationsPerIdentity, 1);
  assert.equal(capabilities.versions[2].identityScopePlanFieldAllowed, false);
  assert.equal(capabilities.versions[2].identityScopeLocation, 'runtimePreparation.identityScope');
  assert.equal(capabilities.versions[2].limits.api, 64);
  assert.equal(capabilities.versions[2].apiScopeRequired, true);
  assert.deepEqual(capabilities.versions[2].reference, { $capture: 'previousCaptureName' });
  assert.ok(!JSON.stringify(capabilities).includes('ordinary_a'));
});

test('runtime probe capabilities distinguish protected scope from model plan and specify JSON path arrays', () => {
  const capabilities = policy.getRuntimeProbeCapabilities();
  const v2 = capabilities.versions[2];
  assert.deepEqual(capabilities.planFields, ['schemaVersion', 'api', 'database', 'browser']);
  assert.equal(v2.apiScopePlanFieldAllowed, false);
  assert.equal(v2.apiScopeInjectedBy, 'Broker');
  assert.equal(v2.apiScopeLocation, 'runtimePreparation.apiScope');
  assert.equal(v2.jsonPath.format, 'component-array');
  assert.deepEqual(v2.jsonPath.appliesTo, ['jsonAssertions[].path', 'captures[].path']);

  const plan = {
    schemaVersion: 2,
    api: [{ id: 'readItem', method: 'GET', path: '/probe-fixture/items', identity: 'ordinary_reader',
      expectedStatus: 200, jsonAssertions: [{ path: structuredClone(v2.jsonPath.examples.assertion), equals: 200 }],
      captures: [{ name: 'itemId', path: structuredClone(v2.jsonPath.examples.capture) }] }],
    database: [], browser: structuredClone(capabilities.browser),
  };
  assert.deepEqual(Object.keys(plan).sort(), [...capabilities.planFields].sort());
  assert.deepEqual(plan.api[0].jsonAssertions[0].path, ['code']);
  assert.deepEqual(plan.api[0].captures[0].path, ['data', 'id']);
  assert.deepEqual(policy.validateRuntimeProbePlan(plan), plan);
  const scope = { artifactSha256: 'a'.repeat(64), endpoints: [{ method: 'GET', path: '/probe-fixture/items' }] };
  assert.deepEqual(policy.validateRuntimeProbeScope(scope, plan), scope);

  assert.throws(() => policy.validateRuntimeProbePlan({ ...plan, apiScope: scope }),
    /must not include apiScope.*Broker.*runtimePreparation\.apiScope.*Remove apiScope/u);
  for (const field of ['jsonAssertions', 'captures']) {
    const invalid = structuredClone(plan);
    invalid.api[0][field][0].path = field === 'jsonAssertions' ? '$.code' : '$.data.id';
    assert.throws(() => policy.validateRuntimeProbePlan(invalid), /Runtime JSON path is invalid/u);
  }
  assert.throws(() => policy.validateRuntimeProbeScope({ ...scope, endpoints: [] }, plan), /outside the protected domain contract/u);
});

test('runtime probe v2 bounds authenticated multipart and download projections within protected scope', () => {
  const plan = {
    schemaVersion: 2,
    api: [
      { id: 'context', method: 'GET', path: '/probe-fixture/context', identity: 'ordinary_reader',
        expectedStatus: 200, jsonAssertions: [], captures: [{ name: 'recordId', path: ['data', 'id'] }] },
      { id: 'upload', method: 'POST', path: '/probe-fixture/upload', identity: 'ordinary_writer',
        multipart: { fields: { recordId: { $capture: 'recordId' }, label: 'fixture', enabled: true, count: 1, optional: null },
          file: { fieldName: 'file', fileName: 'fixture.txt', contentType: 'text/plain', bytesBase64: Buffer.from('fixture').toString('base64') } },
        expectedStatus: 200, jsonAssertions: [{ path: ['code'], equals: 200 }] },
      { id: 'text', method: 'GET', path: '/probe-fixture/export-text', identity: 'ordinary_reader', download: { format: 'text' },
        expectedStatus: 200, jsonAssertions: [{ path: ['fileName'], equals: 'fixture.csv' }, { path: ['text'], equals: 'value\nfixture' }] },
      { id: 'sheet', method: 'POST', path: '/probe-fixture/export-sheet', identity: 'ordinary_reader',
        body: { recordId: { $capture: 'recordId' } }, download: { format: 'xlsx' },
        expectedStatus: 200, jsonAssertions: [{ path: ['rows', 0, 0], equals: 'value' }] },
    ],
    database: [], browser: { status: 'not-executed', reason: 'owner-excluded' },
  };
  const scope = { artifactSha256: 'a'.repeat(64), endpoints: plan.api.map(({ method, path }) => ({ method, path })) };
  assert.deepEqual(policy.validateRuntimeProbePlan(plan), plan);
  assert.deepEqual(policy.validateRuntimeProbeScope(scope, plan), scope);
  const maximum = structuredClone(plan);
  maximum.api[1].multipart.file.bytesBase64 = Buffer.alloc(16384, 1).toString('base64');
  maximum.api[1].multipart.fields.label = 'x'.repeat(4096);
  assert.deepEqual(policy.validateRuntimeProbePlan(maximum), maximum);
  const minimum = structuredClone(plan);
  minimum.api[1].multipart.file.bytesBase64 = 'YQ==';
  assert.deepEqual(policy.validateRuntimeProbePlan(minimum), minimum);
  const reject = mutate => { const invalid = structuredClone(plan); mutate(invalid); assert.throws(() => policy.validateRuntimeProbePlan(invalid)); };
  reject(p => { p.api[1].method = 'GET'; });
  reject(p => { p.api[1].method = 'PUT'; });
  reject(p => { delete p.api[1].identity; });
  reject(p => { delete p.api[2].identity; });
  reject(p => { p.api[1].body = {}; });
  reject(p => { p.api[1].download = { format: 'text' }; });
  reject(p => { p.api[2].download.format = 'binary'; });
  reject(p => { p.api[2].download.hostPath = '/tmp/export.csv'; });
  reject(p => { p.api[1].multipart.file.hostPath = '/tmp/upload.txt'; });
  reject(p => { p.api[1].multipart.extra = true; });
  reject(p => { delete p.api[1].multipart.fields; });
  reject(p => { delete p.api[2].jsonAssertions; });
  reject(p => { p.api[1].multipart.fields.recordId = { $capture: 'unknown' }; });
  reject(p => { p.api[1].multipart.fields.recordId = { $capture: 'recordId', extra: true }; });
  reject(p => { p.api[1].multipart.fields = JSON.parse('{"__proto__":"forbidden"}'); });
  reject(p => { p.api[1].multipart.fields.label = 'x'.repeat(4097); });
  reject(p => { p.api[1].multipart.fields.label = '字'.repeat(1366); });
  reject(p => { p.api[1].multipart.fields = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`field${i}`, i])); });
  reject(p => { p.api[1].multipart.fields.count = Infinity; });
  reject(p => { p.api[1].multipart.file.bytesBase64 = Buffer.alloc(16385).toString('base64'); });
  for (const encoded of ['', 'YQ', 'YQ=', 'YQ==\n', 'YR==', '!!!!', '/tmp/file.txt']) {
    reject(p => { p.api[1].multipart.file.bytesBase64 = encoded; });
  }
  for (const name of ['../fixture.txt', '/tmp/fixture.txt', 'C:\\tmp\\fixture.txt', '\\\\host\\fixture.txt', '..', 'line\nname', 'quote"name']) {
    reject(p => { p.api[1].multipart.file.fileName = name; });
    reject(p => { p.api[1].multipart.file.fieldName = name; });
  }
  for (const mime of ['text/plain\r\nX-Header: injected', 'text/plain; charset=utf-8', '../text', 'text/']) {
    reject(p => { p.api[1].multipart.file.contentType = mime; });
  }
  reject(p => { p.api[1].multipart.fields = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`field${i}`, 'x'.repeat(4096)])); });
  assert.throws(() => policy.validateRuntimeProbeScope({ ...scope, endpoints: scope.endpoints.filter(item => item.path !== '/probe-fixture/upload') }, plan), /outside the protected domain contract/u);
  assert.throws(() => policy.validateRuntimeProbeScope({ ...scope, endpoints: scope.endpoints.filter(item => item.path !== '/probe-fixture/export-sheet') }, plan), /outside the protected domain contract/u);
  const v2 = policy.getRuntimeProbeCapabilities().versions[2];
  assert.ok(v2.apiOptionalFields.includes('multipart') && v2.apiOptionalFields.includes('download'));
  assert.deepEqual(v2.multipart.fileFields, ['fieldName', 'fileName', 'contentType', 'bytesBase64']);
  assert.equal(v2.multipart.requiresIdentity, true);
  assert.equal(v2.multipart.maximumFiles, 1);
  assert.equal(v2.multipart.maximumFileBytes, 16384);
  assert.deepEqual(v2.multipart.mutuallyExclusiveWith, ['body', 'download']);
  assert.deepEqual(v2.download.formats, ['text', 'xlsx']);
  assert.deepEqual(v2.download.assertionProjection, ['contentType', 'fileName', 'byteLength', 'sha256']);
  assert.equal(v2.download.requiresIdentity, true);
  assert.equal(policy.getRuntimeProbeCapabilities().maxPlanBytes, 32768);
});
