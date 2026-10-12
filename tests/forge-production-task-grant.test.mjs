import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { digestDirectUserTextContent } from '../docker/harness/forge-execution-context.mjs';
import {
  createProductionTaskGrant,
  ProductionTaskGrantError,
  issueProductionTaskGrant,
  productionTaskGrantDigest,
  productionTaskGrantFile,
  productionTaskGrantRecordDigest,
  rebindProductionTaskGrantAfterIntegration,
  renewProductionTaskGrant,
  sealProductionTaskGrantClaim,
  validateProductionTaskGrant,
  validateProductionTaskGrantRecord,
} from '../docker/harness/forge-production-task-grant.mjs';
import { sourceTransitionCanonicalDigest } from '../docker/harness/taskspace-policy.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';

const execute = promisify(execFile);
const NOW = Date.parse('2026-09-10T04:00:00.000Z');
const PROMPT = '事故事件管理中事故事件调查菜单页面去掉待办调查、进行中、已完成、全部调查的tab页形式筛选功能';

function spec(overrides = {}) {
  return {
    schemaVersion: 1,
    projectSlug: 'forge-base',
    taskId: 'c-cc0713efbd23bf8c60fd5d00',
    actorUserId: '123e4567-e89b-42d3-a456-426614174000',
    actorUsername: 'liuhc',
    conversationId: '92d8c45a-3dc6-449b-8d5f-06e7b75a0bf0',
    dshSessionId: 'session-ccb499ad-daab-4edf-8745-453ed3e5f32c',
    promptText: PROMPT,
    sourceCommit: '1'.repeat(40),
    workspaceFingerprint: '2'.repeat(64),
    ownedPaths: ['forge-admin-ui/src/views/accident'],
    taskProfiles: ['frontend-admin'],
    ttlSeconds: 300,
    ...overrides,
  };
}

async function fixture(t, value = spec()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-production-task-grant-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const specFile = path.join(root, 'spec.json');
  const grantFile = path.join(root, 'state', 'production-task-grants', `${value.taskId ?? 'task'}.json`);
  const receiptFile = path.join(root, 'receipts', 'grant-receipt.json');
  await writeFile(specFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return { root, specFile, grantFile, receiptFile };
}

function rotatedReceiptFile(files, suffix) {
  return path.join(files.root, 'receipts', `grant-receipt-${suffix}.json`);
}

async function historyRecords(files) {
  const historyDirectory = path.join(files.root, 'state', 'production-task-grants-history');
  const names = await readdir(historyDirectory);
  return Promise.all(names.map(async (name) => ({
    name,
    record: JSON.parse(await readFile(path.join(historyDirectory, name), 'utf8')),
    file: path.join(historyDirectory, name),
  })));
}

function expectCode(code) {
  return (error) => {
    assert.ok(error instanceof ProductionTaskGrantError);
    assert.equal(error.code, code);
    return true;
  };
}

test('protected role decisions survive grant validation and bound continuation but cannot enter a public specification', () => {
  const input = spec({ promptText: '新增设备菜单角色授权', ownedPaths: ['forge-server/db/migration/V2__roles.sql'], taskProfiles: ['migration'] });
  input.taskProfiles = compileForgeTaskExecutionContract({ prompt: input.promptText,
    ownedPaths: input.ownedPaths, actionCeiling: 'workspace-write' }).taskProfiles;
  const roleGrantDecisions = [{ path: input.ownedPaths[0], roleKeys: ['admin'], fileSha256: 'a'.repeat(64), statementSha256: 'b'.repeat(64) }];
  const issued = createProductionTaskGrant({ spec: input, now: NOW, roleGrantDecisions });
  assert.deepEqual(validateProductionTaskGrant(issued.grant, NOW).taskContract.roleGrantDecisions, roleGrantDecisions);
  const continued = createProductionTaskGrant({ spec: input, now: NOW + 1000, continuationContract: issued.grant.taskContract, roleGrantDecisions });
  assert.equal(continued.grant.taskContract.contractId, issued.grant.taskContract.contractId);
  assert.throws(() => createProductionTaskGrant({ spec: { ...input, roleGrantDecisions }, now: NOW }),
    error => error instanceof ProductionTaskGrantError);
  assert.throws(() => createProductionTaskGrant({ spec: input, now: NOW,
    continuationContract: issued.grant.taskContract, roleGrantDecisions: [] }),
    error => error.code === 'PRODUCTION_TASK_GRANT_SCOPE_INVALID');
});

test('semantic grant resources bind the protected issuer and symmetric continuation without public injection', () => {
  const semanticResources = [{ type: 'table', key: 'security' }];
  const issued = createProductionTaskGrant({ spec: spec(), now: NOW, semanticResources });
  assert.deepEqual(validateProductionTaskGrant(issued.grant, NOW).taskContract.semanticResources, semanticResources);
  const same = createProductionTaskGrant({ spec: spec(), now: NOW, semanticResources,
    continuationContract: issued.grant.taskContract });
  assert.equal(same.grant.taskContract.contractId, issued.grant.taskContract.contractId);
  const legacy = createProductionTaskGrant({ spec: spec(), now: NOW });
  for (const options of [
    { continuationContract: issued.grant.taskContract },
    { semanticResources, continuationContract: legacy.grant.taskContract },
    { semanticResources: [{ type: 'table', key: 'other' }], continuationContract: issued.grant.taskContract },
  ]) assert.throws(() => createProductionTaskGrant({ spec: spec(), now: NOW, ...options }),
    error => error.code === 'PRODUCTION_TASK_GRANT_SCOPE_INVALID');
  assert.throws(() => createProductionTaskGrant({ spec: spec({ semanticResources }), now: NOW }),
    error => error instanceof ProductionTaskGrantError);
});

test('object and file issuers produce grants accepted by the same schema', async (t) => {
  const objectIssued = createProductionTaskGrant({ spec: spec(), now: NOW });
  const files = await fixture(t);
  const fileIssued = await issueProductionTaskGrant({ ...files, now: NOW });

  for (const issued of [objectIssued, fileIssued]) {
    assert.deepEqual(validateProductionTaskGrant(issued.grant, NOW), issued.grant);
    assert.deepEqual(Object.keys(issued.grant), Object.keys(objectIssued.grant));
    assert.deepEqual(Object.keys(issued.receipt), Object.keys(objectIssued.receipt));
    assert.deepEqual(Object.keys(issued.receipt.scope), Object.keys(objectIssued.receipt.scope));
    assert.equal(issued.receipt.grantDigest, issued.grant.grantDigest);
    assert.equal(issued.receipt.contractId, issued.grant.taskContract.contractId);
    assert.ok(Object.isFrozen(issued));
    assert.ok(Object.isFrozen(issued.grant));
    assert.ok(Object.isFrozen(issued.receipt.scope));
  }
});

test('object issuer rejects invalid TTL and non-canonical scope', () => {
  assert.throws(
    () => createProductionTaskGrant({ spec: spec({ ttlSeconds: 59 }), now: NOW }),
    expectCode('PRODUCTION_TASK_GRANT_SCHEMA_INVALID'),
  );
  assert.throws(
    () => createProductionTaskGrant({ spec: spec({ taskProfiles: ['backend'] }), now: NOW }),
    expectCode('PRODUCTION_TASK_GRANT_SCOPE_INVALID'),
  );
});

test('omitted action ceiling keeps the legacy workspace-write default', () => {
  const legacySpec = spec();
  assert.equal(Object.hasOwn(legacySpec, 'actionCeiling'), false);

  const { grant, receipt } = createProductionTaskGrant({ spec: legacySpec, now: NOW });

  assert.equal(grant.actionCeiling, 'workspace-write');
  assert.equal(grant.taskContract.actionCeiling, 'workspace-write');
  assert.equal(receipt.scope.actionCeiling, 'workspace-write');
});

test('explicit production action ceilings bind the grant, contract, receipt, and validation roundtrip', () => {
  for (const actionCeiling of ['workspace-write', 'git-checkpoint', 'release']) {
    const issued = createProductionTaskGrant({
      spec: spec({ actionCeiling }),
      now: NOW,
    });
    const roundtripped = JSON.parse(JSON.stringify(issued.grant));

    assert.equal(issued.grant.actionCeiling, actionCeiling);
    assert.equal(issued.grant.taskContract.actionCeiling, actionCeiling);
    assert.equal(issued.receipt.scope.actionCeiling, actionCeiling);
    assert.deepEqual(validateProductionTaskGrant(roundtripped, NOW), issued.grant);
  }
});

test('rejects read-only, null, and unknown production action ceilings', () => {
  for (const actionCeiling of ['read-only', 'unknown', null]) {
    assert.throws(
      () => createProductionTaskGrant({ spec: spec({ actionCeiling }), now: NOW }),
      expectCode('PRODUCTION_TASK_GRANT_SCHEMA_INVALID'),
    );
  }
});

test('rejects a grant action ceiling changed without matching contract and digests', () => {
  const { grant } = createProductionTaskGrant({ spec: spec(), now: NOW });
  const tampered = JSON.parse(JSON.stringify(grant));
  tampered.actionCeiling = 'release';

  assert.throws(
    () => validateProductionTaskGrant(tampered, NOW),
    expectCode('PRODUCTION_TASK_GRANT_SCOPE_INVALID'),
  );
});

test('expired inspection reports historical scope while normal validation rejects authority', () => {
  const { grant } = createProductionTaskGrant({ spec: spec(), now: NOW });
  const observedAt = NOW + 300_000;

  assert.throws(
    () => validateProductionTaskGrant(grant, observedAt),
    expectCode('PRODUCTION_TASK_GRANT_EXPIRED'),
  );
  const inspected = validateProductionTaskGrantRecord(
    grant,
    observedAt,
    { allowExpired: true },
  );
  assert.equal(inspected.expired, true);
  assert.deepEqual(inspected.grant, grant);
  assert.ok(Object.isFrozen(inspected.grant));
});

test('checkpoint renewal changes only a claimed grant source with an exact same-content transition', () => {
  const { grant } = createProductionTaskGrant({ spec: spec({ actionCeiling: 'release' }), now: NOW });
  const claimed = sealProductionTaskGrantClaim(grant, {
    claimId: '123e4567-e89b-42d3-a456-426614174010', rpcId: 'rpc-checkpoint-renewal',
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174011',
    productionAuthorityDigest: '3'.repeat(64), claimedAt: new Date(NOW + 1).toISOString(),
  }, NOW + 1);
  const payload = {
    schemaVersion: 1, operationId: '123e4567-e89b-42d3-a456-426614174012',
    task: Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
      'dshSessionId'].map((key) => [key, claimed[key]])),
    from: { head: claimed.sourceCommit, fingerprint: '4'.repeat(64) },
    to: { head: '5'.repeat(40), fingerprint: '4'.repeat(64) },
    canonicalHead: claimed.sourceCommit, phase: 'checkpointed',
    sourceAuthority: { executionId: '123e4567-e89b-42d3-a456-426614174013', generation: 1,
      contractId: claimed.taskContract.contractId, productionAuthorityDigest: claimed.claim.productionAuthorityDigest,
      controllerGrantDigest: claimed.grantDigest, actionCeiling: claimed.actionCeiling,
      issuedAt: claimed.issuedAt, expiresAt: claimed.expiresAt },
    digestAlgorithm: 'sha256', digestEncoding: 'canonical-json-v1',
  };
  const seal = (value) => { const { digest: _digest, ...body } = value;
    return { ...body, digest: sourceTransitionCanonicalDigest(body) }; };
  const sourceTransition = seal(payload);
  const renewed = renewProductionTaskGrant(claimed, sourceTransition.to, NOW + 2, { sourceTransition });
  assert.equal(renewed.sourceCommit, sourceTransition.to.head);
  assert.equal(renewed.workspaceFingerprint, sourceTransition.to.fingerprint);
  assert.equal(renewed.taskContract.contractId, claimed.taskContract.contractId);
  assert.equal(renewed.promptTextDigest, claimed.promptTextDigest);
  assert.equal(renewed.actionCeiling, claimed.actionCeiling);
  assert.deepEqual(renewed.ownedPaths, claimed.ownedPaths);
  assert.equal(renewed.claim, null);
  assert.notEqual(renewed.grantDigest, claimed.grantDigest);
  assert.equal(claimed.sourceCommit, grant.sourceCommit);
  assert.throws(() => renewProductionTaskGrant(claimed, sourceTransition.to, NOW + 2),
    expectCode('PRODUCTION_TASK_RENEWAL_DENIED'));
  for (const mutation of [
    (value) => { value.phase = 'integrated'; },
    (value) => { value.from.fingerprint = '6'.repeat(64); },
    (value) => { value.from.head = '6'.repeat(40); },
    (value) => { value.task.conversationId = 'different-conversation'; },
    (value) => { value.sourceAuthority.controllerGrantDigest = '6'.repeat(64); },
  ]) {
    const changed = structuredClone(sourceTransition); mutation(changed);
    assert.throws(() => renewProductionTaskGrant(claimed, sourceTransition.to, NOW + 2,
      { sourceTransition: seal(changed) }), expectCode('PRODUCTION_TASK_RENEWAL_DENIED'));
  }
  assert.equal(renewProductionTaskGrant(claimed,
    { head: claimed.sourceCommit, fingerprint: '7'.repeat(64) }, NOW + 2).sourceCommit, claimed.sourceCommit);
});

test('integrated renewal preserves the original prompt, contract and TTL while rebinding a claimed release', () => {
  const { grant } = createProductionTaskGrant({ spec: spec({ actionCeiling: 'release' }), now: NOW });
  const claimed = sealProductionTaskGrantClaim(grant, {
    claimId: '123e4567-e89b-42d3-a456-426614174010', rpcId: 'rpc-integrated-renewal',
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174011',
    productionAuthorityDigest: '3'.repeat(64), claimedAt: new Date(NOW + 1).toISOString(),
  }, NOW + 1);
  const seal = (value) => { const { digest: _digest, ...body } = value;
    return { ...body, digest: sourceTransitionCanonicalDigest(body) }; };
  const sourceTransition = seal({
    schemaVersion: 1, operationId: '123e4567-e89b-42d3-a456-426614174012',
    task: Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
      'dshSessionId'].map((key) => [key, claimed[key]])),
    // The actual edited candidate may be newer than the original grant's workspace fingerprint.
    from: { head: claimed.sourceCommit, fingerprint: '4'.repeat(64) },
    to: { head: '5'.repeat(40), fingerprint: '6'.repeat(64) },
    canonicalHead: '7'.repeat(40), phase: 'integrated',
    sourceAuthority: { executionId: '123e4567-e89b-42d3-a456-426614174013', generation: 1,
      contractId: claimed.taskContract.contractId, productionAuthorityDigest: claimed.claim.productionAuthorityDigest,
      controllerGrantDigest: claimed.grantDigest, actionCeiling: claimed.actionCeiling,
      issuedAt: claimed.issuedAt, expiresAt: claimed.expiresAt },
    digestAlgorithm: 'sha256', digestEncoding: 'canonical-json-v1',
  });
  const rebound = rebindProductionTaskGrantAfterIntegration(claimed, sourceTransition.to, NOW + 2, { sourceTransition });
  assert.equal(rebound.sourceCommit, sourceTransition.to.head);
  assert.equal(rebound.workspaceFingerprint, sourceTransition.to.fingerprint);
  assert.equal(rebound.promptTextDigest, claimed.promptTextDigest);
  assert.deepEqual(rebound.taskContract, claimed.taskContract);
  assert.deepEqual(rebound.ownedPaths, claimed.ownedPaths);
  assert.equal(rebound.actionCeiling, 'release');
  assert.equal(Date.parse(rebound.expiresAt) - Date.parse(rebound.issuedAt),
    Date.parse(claimed.expiresAt) - Date.parse(claimed.issuedAt));
  assert.notEqual(rebound.grantId, claimed.grantId);
  assert.notEqual(rebound.grantDigest, claimed.grantDigest);
  assert.equal(rebound.claim, null);
  assert.equal(claimed.sourceCommit, grant.sourceCommit);
  const reclaimed = sealProductionTaskGrantClaim(rebound, {
    ...claimed.claim, claimId: '123e4567-e89b-42d3-a456-426614174014',
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174015',
    productionAuthorityDigest: '8'.repeat(64), claimedAt: new Date(NOW + 3).toISOString(),
  }, NOW + 3);
  assert.notEqual(reclaimed.claim.productionAuthorityDigest, claimed.claim.productionAuthorityDigest);
  assert.equal(reclaimed.claim.rpcId, claimed.claim.rpcId);
  assert.throws(() => rebindProductionTaskGrantAfterIntegration(claimed, sourceTransition.to, NOW + 2),
    expectCode('PRODUCTION_TASK_RENEWAL_DENIED'));
  for (const mutation of [
    (value) => { value.phase = 'checkpointed'; },
    (value) => { value.phase = 'conflict-open'; },
    (value) => { value.from.head = '8'.repeat(40); },
    (value) => { value.task.actorUserId = '123e4567-e89b-42d3-a456-426614174016'; },
    (value) => { value.sourceAuthority.controllerGrantDigest = '8'.repeat(64); },
    (value) => { value.sourceAuthority.productionAuthorityDigest = '8'.repeat(64); },
    (value) => { value.sourceAuthority.actionCeiling = 'workspace-write'; },
  ]) {
    const changed = structuredClone(sourceTransition); mutation(changed);
    assert.throws(() => rebindProductionTaskGrantAfterIntegration(claimed, sourceTransition.to, NOW + 2,
      { sourceTransition: seal(changed) }), expectCode('PRODUCTION_TASK_RENEWAL_DENIED'));
  }
});

test('issues an exclusive prompt-free production task grant bound to contract, source, and scope', async (t) => {
  const files = await fixture(t);
  const issued = await issueProductionTaskGrant({ ...files, now: NOW });
  const grantText = await readFile(files.grantFile, 'utf8');
  const receiptText = await readFile(files.receiptFile, 'utf8');
  const grant = JSON.parse(grantText);
  const receipt = JSON.parse(receiptText);

  assert.equal(grant.promptTextDigest, digestDirectUserTextContent([{ type: 'text', text: PROMPT }]));
  assert.ok(!grantText.includes(PROMPT));
  assert.ok(!receiptText.includes(PROMPT));
  assert.equal(grant.route, 'session.prompt');
  assert.equal(grant.caseFamily, 'maintenance');
  assert.equal(grant.actionCeiling, 'workspace-write');
  assert.deepEqual(grant.ownedPaths, ['forge-admin-ui/src/views/accident']);
  assert.deepEqual(grant.taskProfiles, ['frontend-admin']);
  assert.equal(grant.claim, null);
  assert.equal(grant.grantDigest, productionTaskGrantDigest(grant));
  assert.equal(grant.recordDigest, productionTaskGrantRecordDigest(grant));
  assert.deepEqual(validateProductionTaskGrant(grant, NOW), grant);
  assert.deepEqual(issued.grant, grant);

  assert.equal(receipt.grantId, grant.grantId);
  assert.equal(receipt.grantDigest, grant.grantDigest);
  assert.equal(receipt.contractId, grant.taskContract.contractId);
  assert.equal(receipt.promptTextDigest, grant.promptTextDigest);
  assert.deepEqual(receipt.source, {
    sourceCommit: grant.sourceCommit,
    workspaceFingerprint: grant.workspaceFingerprint,
  });
  assert.deepEqual(receipt.scope, {
    projectSlug: grant.projectSlug,
    taskId: grant.taskId,
    actorUserId: grant.actorUserId,
    actorUsername: grant.actorUsername,
    conversationId: grant.conversationId,
    dshSessionId: grant.dshSessionId,
    route: grant.route,
    caseFamily: grant.caseFamily,
    actionCeiling: grant.actionCeiling,
    ownedPaths: grant.ownedPaths,
    taskProfiles: grant.taskProfiles,
  });
  assert.equal(receipt.expiresAt, '2026-09-10T04:05:00.000Z');
  assert.deepEqual(issued.receipt, receipt);
  assert.ok(Object.isFrozen(issued));
  assert.ok(Object.isFrozen(issued.grant.taskContract));

  if (process.platform !== 'win32') {
    assert.equal((await stat(files.grantFile)).mode & 0o777, 0o600);
    assert.equal((await stat(files.receiptFile)).mode & 0o777, 0o600);
  }
  assert.equal(
    productionTaskGrantFile(path.join(files.root, 'state'), grant.taskId),
    files.grantFile,
  );
});

test('accepts one exact claim while preserving the immutable grant digest', async (t) => {
  const files = await fixture(t);
  const { grant } = await issueProductionTaskGrant({ ...files, now: NOW });
  const claimed = sealProductionTaskGrantClaim(grant, {
    claimId: '123e4567-e89b-42d3-a456-426614174010',
    rpcId: 'rpc-production-task-1',
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174011',
    productionAuthorityDigest: '3'.repeat(64),
    claimedAt: '2026-09-10T04:00:01.000Z',
  }, NOW + 1000);

  assert.equal(claimed.grantDigest, grant.grantDigest);
  assert.notEqual(claimed.recordDigest, grant.recordDigest);
  assert.deepEqual(validateProductionTaskGrant(claimed, NOW + 1000), claimed);
  assert.throws(
    () => sealProductionTaskGrantClaim(claimed, claimed.claim, NOW + 1000),
    expectCode('PRODUCTION_TASK_GRANT_ALREADY_CLAIMED'),
  );

  const lateClaim = { ...claimed.claim, claimedAt: claimed.expiresAt };
  assert.throws(
    () => sealProductionTaskGrantClaim(grant, lateClaim, NOW + 1000),
    expectCode('PRODUCTION_TASK_GRANT_CLAIM_INVALID'),
  );
});

test('trusted continuation retains only identical requirements and cannot be injected through a public spec', () => {
  const first = createProductionTaskGrant({ spec: spec(), now: NOW });
  const currentSpec = spec({ promptText: '继续，完成当前改动的必要验证。' });
  const continued = createProductionTaskGrant({ spec: currentSpec, now: NOW + 1000,
    continuationContract: first.grant.taskContract });
  assert.equal(continued.grant.taskContract.contractId, first.grant.taskContract.contractId);
  assert.notEqual(continued.grant.promptTextDigest, first.grant.promptTextDigest);
  assert.notEqual(continued.grant.grantDigest, first.grant.grantDigest);
  assert.deepEqual(validateProductionTaskGrant(continued.grant, NOW + 1000), continued.grant);
  assert.throws(() => createProductionTaskGrant({ spec: { ...currentSpec,
    continuationContract: first.grant.taskContract }, now: NOW }), expectCode('PRODUCTION_TASK_GRANT_SCHEMA_INVALID'));
  for (const changed of [
    { actionCeiling: 'release' },
    { ownedPaths: ['forge-admin-ui/src/views/other'] },
    { taskProfiles: ['crud', 'dictionary', 'frontend-admin'] },
  ]) {
    assert.throws(() => createProductionTaskGrant({ spec: { ...currentSpec, ...changed }, now: NOW,
      continuationContract: first.grant.taskContract }), expectCode('PRODUCTION_TASK_GRANT_SCOPE_INVALID'));
  }
});

test('rejects traversal, invalid TTL, unknown fields, and non-canonical task scope', async (t) => {
  const cases = [
    {
      name: 'traversal',
      value: spec({ ownedPaths: ['forge-admin-ui/src/views/accident/../secret.vue'] }),
      code: 'PRODUCTION_TASK_GRANT_SCHEMA_INVALID',
    },
    {
      name: 'ttl',
      value: spec({ ttlSeconds: 59 }),
      code: 'PRODUCTION_TASK_GRANT_SCHEMA_INVALID',
    },
    {
      name: 'unknown-field',
      value: { ...spec(), allowAnyWorkspaceWrite: true },
      code: 'PRODUCTION_TASK_GRANT_SCHEMA_INVALID',
    },
    {
      name: 'scope-widening',
      value: spec({ taskProfiles: ['backend'] }),
      code: 'PRODUCTION_TASK_GRANT_SCOPE_INVALID',
    },
  ];
  for (const invalid of cases) {
    await t.test(invalid.name, async (subtest) => {
      const files = await fixture(subtest, invalid.value);
      await assert.rejects(
        issueProductionTaskGrant({ ...files, now: NOW }),
        expectCode(invalid.code),
      );
    });
  }
});

test('rejects an active unclaimed grant without overwriting it', async (t) => {
  const files = await fixture(t);
  const first = await issueProductionTaskGrant({ ...files, now: NOW });
  const original = await readFile(files.grantFile, 'utf8');

  await assert.rejects(
    issueProductionTaskGrant({
      ...files,
      receiptFile: rotatedReceiptFile(files, 'active'),
      now: NOW + 1000,
    }),
    expectCode('PRODUCTION_TASK_GRANT_OUTPUT_EXISTS'),
  );
  assert.equal(await readFile(files.grantFile, 'utf8'), original);
  assert.equal(JSON.parse(original).grantId, first.grant.grantId);
  await assert.rejects(
    readdir(path.join(files.root, 'state', 'production-task-grants-history')),
    { code: 'ENOENT' },
  );
});

test('archives a claimed grant before issuing a replacement', async (t) => {
  const files = await fixture(t);
  const first = await issueProductionTaskGrant({ ...files, now: NOW });
  const claimed = sealProductionTaskGrantClaim(first.grant, {
    claimId: '123e4567-e89b-42d3-a456-426614174020',
    rpcId: 'rpc-production-task-rotation',
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174021',
    productionAuthorityDigest: '4'.repeat(64),
    claimedAt: '2026-09-10T04:00:01.000Z',
  }, NOW + 1000);
  await writeFile(files.grantFile, `${JSON.stringify(claimed, null, 2)}\n`, { mode: 0o600 });

  const rotated = await issueProductionTaskGrant({
    ...files,
    receiptFile: rotatedReceiptFile(files, 'claimed'),
    now: NOW + 2000,
  });
  const history = await historyRecords(files);

  assert.notEqual(rotated.grant.grantId, claimed.grantId);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].record, claimed);
  assert.equal(
    history[0].name,
    `${claimed.taskId}.${claimed.grantId}.${claimed.recordDigest}.json`,
  );
  if (process.platform !== 'win32') {
    assert.equal((await stat(history[0].file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(history[0].file))).mode & 0o777, 0o700);
  }
});

test('archives a complete valid expired grant before issuing a replacement', async (t) => {
  const files = await fixture(t);
  const first = await issueProductionTaskGrant({ ...files, now: NOW });
  const rotated = await issueProductionTaskGrant({
    ...files,
    receiptFile: rotatedReceiptFile(files, 'expired'),
    now: NOW + 300_000,
  });
  const history = await historyRecords(files);

  assert.notEqual(rotated.grant.grantId, first.grant.grantId);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].record, first.grant);
  assert.deepEqual(
    validateProductionTaskGrant(rotated.grant, NOW + 300_000),
    rotated.grant,
  );
});

test('rejects rotation when the existing grant belongs to another project', async (t) => {
  const files = await fixture(t);
  const first = await issueProductionTaskGrant({ ...files, now: NOW });
  await writeFile(
    files.specFile,
    `${JSON.stringify(spec({ projectSlug: 'another-project' }), null, 2)}\n`,
    { mode: 0o600 },
  );

  await assert.rejects(
    issueProductionTaskGrant({
      ...files,
      receiptFile: rotatedReceiptFile(files, 'identity-mismatch'),
      now: NOW + 300_000,
    }),
    expectCode('PRODUCTION_TASK_GRANT_IDENTITY_MISMATCH'),
  );
  assert.deepEqual(JSON.parse(await readFile(files.grantFile, 'utf8')), first.grant);
  await assert.rejects(
    readdir(path.join(files.root, 'state', 'production-task-grants-history')),
    { code: 'ENOENT' },
  );
});

test('rejects a tampered expired grant before expiry classification or rotation', async (t) => {
  const files = await fixture(t);
  const first = await issueProductionTaskGrant({ ...files, now: NOW });
  const tampered = { ...first.grant, sourceCommit: 'f'.repeat(40) };
  const tamperedText = `${JSON.stringify(tampered, null, 2)}\n`;
  await writeFile(files.grantFile, tamperedText, { mode: 0o600 });

  assert.throws(
    () => validateProductionTaskGrant(tampered, NOW + 300_000),
    expectCode('PRODUCTION_TASK_GRANT_INTEGRITY_INVALID'),
  );
  await assert.rejects(
    issueProductionTaskGrant({
      ...files,
      receiptFile: rotatedReceiptFile(files, 'tampered'),
      now: NOW + 300_000,
    }),
    expectCode('PRODUCTION_TASK_GRANT_INTEGRITY_INVALID'),
  );
  assert.equal(await readFile(files.grantFile, 'utf8'), tamperedText);
  await assert.rejects(
    readdir(path.join(files.root, 'state', 'production-task-grants-history')),
    { code: 'ENOENT' },
  );
});

test('Controller exposes issue-production-task-grant without creating an A9 workflow', async (t) => {
  const files = await fixture(t);
  const controller = path.resolve('docker/harness/forge-delivery-phase-controller.mjs');
  const { stdout, stderr } = await execute(process.execPath, [
    controller,
    'issue-production-task-grant',
    '--spec-file', files.specFile,
    '--grant-file', files.grantFile,
    '--receipt-file', files.receiptFile,
  ], {
    cwd: path.resolve('.'),
    env: process.env,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(stderr, '');
  const cliReceipt = JSON.parse(stdout);
  const storedReceipt = JSON.parse(await readFile(files.receiptFile, 'utf8'));
  assert.deepEqual(cliReceipt, storedReceipt);
  assert.equal(cliReceipt.recordType, 'forge-production-task-grant-receipt/v1');
  assert.ok(!stdout.includes(PROMPT));
});
