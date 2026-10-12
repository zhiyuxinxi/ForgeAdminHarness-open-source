import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as preparation from '../docker/harness/forge-cross-layer-preparation.mjs';

test('runtime API scope preserves accepted literal and grouped endpoints without granting shorthand or caller expansion', () => {
  const artifact = { payload: { apiContracts: { endpoints: [
    { module: 'example', operations: [
      { method: 'GET', path: '/business/example/page' },
      { method: 'POST', path: '/business/example/remove/{id}' },
    ] },
    { module: 'grouped', operations: [
      { method: 'POST', relativePath: '/decide', exactPaths: ['/business/example-a/decide', '/business/example-b/decide'] },
    ] },
  ] } } };
  const bytes = Buffer.from(JSON.stringify(artifact) + '\n');
  const scope = preparation.deriveForgeRuntimeApiScope(bytes);
  assert.equal(scope.artifactSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(scope.endpoints, [
    { method: 'GET', path: '/business/example/page' },
    { method: 'POST', path: '/business/example/remove/{id}' },
    { method: 'POST', path: '/business/example-a/decide' },
    { method: 'POST', path: '/business/example-b/decide' },
  ]);
  const altered = Buffer.from(JSON.stringify(artifact));
  assert.notEqual(preparation.deriveForgeRuntimeApiScope(altered).artifactSha256, scope.artifactSha256);
  for (const operation of [
    { method: 'POST', relativePath: '/decide' },
    { method: 'POST', path: '/business/example/add', exactPaths: ['/business/other/add'] },
    { method: 'POST', exactPaths: [] },
    { method: 'POST', exactPaths: ['/business/example/add', 'https://elsewhere.invalid/write'] },
    { method: 'POST', path: '/business/example/../other' },
  ]) {
    const invalid = { payload: { apiContracts: { endpoints: [{ operations: [operation] }] } } };
    assert.throws(() => preparation.deriveForgeRuntimeApiScope(Buffer.from(JSON.stringify(invalid))));
  }
  assert.throws(() => preparation.deriveForgeRuntimeApiScope(Buffer.from('{}')));
  assert.throws(() => preparation.deriveForgeRuntimeApiScope(Buffer.from('{')));
  const visibility = { canSee: ['page'], canAct: ['read'], dataScope: 'ASSIGNED_TASKS' };
  const roleContract = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`MEMBER_${i}`, { ...visibility }]));
  roleContract.approvalRoles = { roles: Array.from({ length: 8 }, (_, i) => `APPROVER_${i}`), ...visibility };
  roleContract.denyRules = ['No production user-role membership is seeded.', 'No wildcard or administrator grant.'];
  roleContract.unrelated = { note: 'not a role', nested: { roles: ['DO_NOT_INFER'] } };
  const access = { artifactDigest: 'b'.repeat(64), payload: { roleVisibilityContract: roleContract } };
  const identityScope = preparation.deriveForgeRuntimeIdentityScope(access);
  assert.equal(identityScope.artifactSha256, access.artifactDigest);
  assert.deepEqual(identityScope.roleKeys, [...Array.from({ length: 6 }, (_, i) => `MEMBER_${i}`),
    ...Array.from({ length: 8 }, (_, i) => `APPROVER_${i}`)].sort());
  assert.ok(!identityScope.roleKeys.some(key => ['approvalRoles', 'denyRules', 'unrelated', 'DO_NOT_INFER'].includes(key)));
  assert.notEqual(preparation.deriveForgeRuntimeIdentityScope({ ...access, artifactDigest: 'c'.repeat(64) }).artifactSha256,
    identityScope.artifactSha256);
  for (const change of [
    contract => { contract.approvalRoles.roles = ['*']; },
    contract => { contract.approvalRoles.roles = ['APPROVER_0', 'APPROVER_0']; },
    contract => { contract.approvalRoles.roles = 'APPROVER_0'; },
    contract => { contract.MEMBER_0.canAct = 'read'; },
  ]) {
    const invalid = structuredClone(access); change(invalid.payload.roleVisibilityContract);
    assert.throws(() => preparation.deriveForgeRuntimeIdentityScope(invalid));
  }
  assert.throws(() => preparation.deriveForgeRuntimeIdentityScope({ ...access, artifactDigest: 'unbound' }));
  assert.throws(() => preparation.deriveForgeRuntimeIdentityScope({ artifactDigest: access.artifactDigest,
    payload: { roleVisibilityContract: { denyRules: [], nested: { arbitrary: { roles: ['UNKNOWN'] } } } } }));
  // Original83 declares explicit role records; the policy is metadata, not a role.
  const listedContract = {"tenantId":1,"roleSeedPolicy":{"roleType":3,"orgScopeType":2,"dataScope":3,"roleStatus":1,"isSystem":1,"orgApplicability":"Active fire business roles are associated with active tenant organizations through sys_role_org.","userBinding":"No production user-to-role membership is seeded; protected test identity binding remains environment-specific."},"roles":[{"roleKey":"FIRE_MANAGEMENT","displayNameZh":"消防管理岗位","visibleCapabilities":["全部设施、检测维保记录、检查项、报告和备件权限","business:fireEquipment:attachment","business:fireAlarm:list","business:fireMap:list"],"dataScope":"AUTHORIZED_ORG_ZONE_DEVICE"},{"roleKey":"APPLICANT","displayNameZh":"申请人","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:apply","business:fireWaterApproval:list","business:fireWaterApproval:apply","business:fireIsolationApproval:list","business:fireIsolationApproval:apply"],"dataScope":"OWN_DRAFTS and OWN_APPLICATIONS"},{"roleKey":"MAINTENANCE_UNIT_INSPECTOR","displayNameZh":"检测人（维保单位）","visibleCapabilities":["business:fireInspection:list","business:fireInspection:signMaintainer"],"dataScope":"ASSIGNED_TASKS"},{"roleKey":"FIRE_MANAGEMENT_SIGNER","displayNameZh":"消防管理人（装置、部）","visibleCapabilities":["business:fireInspection:list","business:fireInspection:signFireManager"],"dataScope":"ASSIGNED_TASKS"},{"roleKey":"EQUIPMENT_MANAGEMENT_AUDITOR","displayNameZh":"审核人（设备管理部）","visibleCapabilities":["business:fireInspection:list","business:fireInspection:audit"],"dataScope":"ASSIGNED_TASKS"},{"roleKey":"DEVICE_MANAGER_APPROVER","displayNameZh":"装置经理","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:approve","business:fireIsolationApproval:list","business:fireIsolationApproval:approve"],"dataScope":"ASSIGNED_TASKS"},{"roleKey":"EHSS_FIRE_SPECIALIST_APPROVER","displayNameZh":"EHSS部消气防专业","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:approve"],"dataScope":"ASSIGNED_TASKS"},{"roleKey":"EHSS_TRAFFIC_SPECIALIST_APPROVER","displayNameZh":"EHSS部治安交通专业","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:approve"],"dataScope":"ASSIGNED_TASKS"},{"roleKey":"FIRE_BRIGADE_APPROVER","displayNameZh":"消防队","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:approve"],"dataScope":"ASSIGNED_TASKS"},{"roleKey":"EHSS_DEPARTMENT_APPROVER","displayNameZh":"EHSS部","visibleCapabilities":["business:fireWaterApproval:list","business:fireWaterApproval:approve","business:fireIsolationApproval:list","business:fireIsolationApproval:approve"],"dataScope":"ASSIGNED_TASKS"},{"roleKey":"OPERATIONS_DEPARTMENT_APPROVER","displayNameZh":"运营部","visibleCapabilities":["business:fireWaterApproval:list","business:fireWaterApproval:approve","business:fireIsolationApproval:list","business:fireIsolationApproval:approve"],"dataScope":"ASSIGNED_TASKS"},{"roleKey":"EHSS_DEPARTMENT_MANAGER_APPROVER","displayNameZh":"EHSS部门经理","visibleCapabilities":["business:fireWaterApproval:list","business:fireWaterApproval:approve","business:fireIsolationApproval:list","business:fireIsolationApproval:approve"],"dataScope":"ASSIGNED_TASKS"},{"roleKey":"OPERATIONS_GENERAL_MANAGER_APPROVER","displayNameZh":"运营部门总经理","visibleCapabilities":["business:fireWaterApproval:list","business:fireWaterApproval:approve","business:fireIsolationApproval:list","business:fireIsolationApproval:approve"],"dataScope":"ASSIGNED_TASKS"},{"roleKey":"PRODUCTION_DISPATCHER","displayNameZh":"生产调度","visibleCapabilities":["business:fireOccupyApproval:list","business:fireOccupyApproval:dispatch","business:fireWaterApproval:list","business:fireWaterApproval:dispatch","business:fireIsolationApproval:list","business:fireIsolationApproval:dispatch"],"dataScope":"ASSIGNED_TASKS"}],"excludedUserPageRoles":["EXTERNAL_FIRE_ALARM_SYSTEM","DCS_SYSTEM"],"denyRules":["No-role and ordinary users receive no fire page, button or API access from this wiring.","UI visibility does not replace backend @SaCheckPermission and exact API-resource authorization.","Task handlers and approval actors can act only on assigned current tasks.","This FIRE_SPARE_WORK_ORDER repair does not add roles, broaden permissions or bind users."]};
  const listedAccess = { artifactDigest: access.artifactDigest, payload: { roleVisibilityContract: listedContract } };
  const listedScope = preparation.deriveForgeRuntimeIdentityScope(listedAccess);
  assert.deepEqual(listedScope.roleKeys, listedContract.roles.map(role => role.roleKey).sort());
  assert.equal(listedScope.roleKeys.length, 14);
  assert.equal(listedScope.artifactSha256, listedAccess.artifactDigest);
  const metadataOnly = structuredClone(listedAccess);
  metadataOnly.payload.roleVisibilityContract.roleSeedPolicy.roles = ['DO_NOT_GRANT_METADATA'];
  assert.deepEqual(preparation.deriveForgeRuntimeIdentityScope(metadataOnly), listedScope);
  delete metadataOnly.payload.roleVisibilityContract.roles;
  assert.throws(() => preparation.deriveForgeRuntimeIdentityScope(metadataOnly));
  for (const change of [
    value => { delete value.roles[0].roleKey; },
    value => { delete value.roles[0].visibleCapabilities; },
    value => { value.roles[0].visibleCapabilities = []; },
    value => { value.roles[0].visibleCapabilities = ['']; },
    value => { value.roles[0].visibleCapabilities = [1]; },
    value => { value.roles[0].dataScope = ' '; },
    value => { value.roles[0].dataScope = 3; },
    value => { value.roles[0].roleKey = '*'; },
    value => { value.roles[1].roleKey = value.roles[0].roleKey; },
    value => { value.roles = Array.from({ length: 257 }, (_, index) => ({ ...value.roles[0], roleKey: 'EXTRA_' + index })); },
  ]) {
    const invalid = structuredClone(listedAccess); change(invalid.payload.roleVisibilityContract);
    assert.throws(() => preparation.deriveForgeRuntimeIdentityScope(invalid));
  }
  assert.equal(bytes.toString(), JSON.stringify(artifact) + '\n');
});
