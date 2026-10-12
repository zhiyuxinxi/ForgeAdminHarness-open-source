import assert from 'node:assert/strict';
import crypto, { generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compileProtectedAcceptanceSpec, createConversationManager, createProtectedRoleDecisionClient } from '../docker/harness/conversation-manager.mjs';
import { snapshotForgeDeliveryWorkspace } from '../docker/harness/forge-delivery-phase-workspace-observer.mjs';
import { verifyAcceptanceEvidenceReceipt } from '../docker/harness/forge-acceptance-aggregator.mjs';
import { prepareConversationTaskExecution } from '../docker/harness/forge-conversation-task-preparation.mjs';
import {
  classifyPinnedDshPromptBody,
  prepareProtectedExecutionContext,
  readCurrentProtectedExecutionContextForTask,
  readProtectedExecutionContext,
} from '../docker/harness/forge-execution-context.mjs';
import { ProtectedAcceptanceService, createProtectedAcceptanceServers, isForgeConversationTaskContinuation } from '../docker/harness/forge-protected-acceptance-service.mjs';
import { validateTaskspaceAction } from '../docker/harness/taskspace-policy.mjs';
import { createProductionTaskGrant } from '../docker/harness/forge-production-task-grant.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';

const NOW = Date.parse('2026-09-14T11:00:00.000Z');
const HEAD = '1'.repeat(40);
const ACTOR_USER_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_PATH = path.resolve('docker/harness/forge-execution-policy.json');

const ownedPaths = Object.freeze([
  'forge-admin-ui/src/views/security/index.vue',
  'forge-server/db/migration/V1.0.200__add_security_menu.sql',
  'forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/security/SecurityMenuMigrationTest.java',
]);

const writerScopes = Object.freeze([
  { taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] },
  { taskProfile: 'migration', ownedPaths: ['forge-server/db/migration'] },
  {
    taskProfile: 'backend',
    ownedPaths: ['forge-server/forge-business/forge-business-core/src/test/java'],
  },
]);

function privatePem() {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
}

function lookup(context) {
  return Object.fromEntries([
    'projectSlug', 'taskId', 'conversationId', 'actorUserId',
    'dshSessionId', 'rpcId', 'textDigest',
  ].map((key) => [key, context[key]]));
}

async function fixture(t, promptText = '仅在导航栏创建安保模块即可，放至领导引领力后面', capabilities = {}) {
  const fixtureNow = capabilities.now ?? NOW;
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-conversation-task-integration-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const taskMetadata = {
    schemaVersion: 2,
    projectSlug: 'forge-project',
    taskId: 'task-integration',
    actorUserId: ACTOR_USER_ID,
    actorId: 'lyl',
    conversationId: 'conversation-integration',
    status: 'active',
    accessMode: 'conversation',
  };
  const workspace = path.join(projectRoot, 'taskspaces', taskMetadata.taskId, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'PROJECT_CONTEXT.md'), 'Existing menu implementation and ordering.\n');
  await writeFile(path.join(workspace, 'SOURCE_STATE.txt'), 'source-v1\n');
  if (capabilities.gitWorkspace) {
    const git = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true });
    git(['init', '--quiet']);
    git(['config', 'user.name', 'Role Preview Test']);
    git(['config', 'user.email', 'role-preview@example.invalid']);
    git(['add', '.']); git(['commit', '--quiet', '-m', 'fixture']);
    taskMetadata.baseCommit = git(['rev-parse', 'HEAD']).trim();
  }

  let serviceNow = fixtureNow;
  const service = new ProtectedAcceptanceService({
    config: {
      schemaVersion: 1,
      serviceType: 'forge-protected-acceptance-service/v1',
      projectSlug: taskMetadata.projectSlug,
      policyId: 'forge-project-acceptance',
      stateRoot: path.join(projectRoot, 'acceptance-state'),
      contractTtlSeconds: 900,
      conversationTaskPreparation: true,
      ...(capabilities.roleDecisions ? { roleDecisionTaskIds: [taskMetadata.taskId] } : {}),
      conversationWriterScopes: structuredClone(writerScopes),
      allowedVerificationProfiles: [
        'governance', 'backend-module-test', 'backend-test-class', 'frontend-admin-lint', 'frontend-admin-test',
        'frontend-admin-typecheck', 'frontend-admin-build', 'changed-safe', 'full-regression',
      ],
      trustWindow: {
        issuedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
      keys: {
        platform: { keyId: 'platform-key' },
        governance: { keyId: 'governance-key', subjectId: 'governance-engine-1' },
        verification: { keyId: 'verification-key', subjectId: 'verification-runner-1' },
        semanticReview: { keyId: 'semantic-key', subjectId: 'semantic-reviewer-1' },
        verdict: { keyId: 'verdict-key' },
      },
    },
    platformKeyPem: privatePem(),
    governanceKeyPem: privatePem(),
    verificationKeyPem: privatePem(),
    semanticKeyPem: privatePem(),
    verdictKeyPem: privatePem(),
    clock: () => new Date(serviceNow),
  });

  const requestFor = (text, rpcId) => ({
    ...classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'session.prompt',
      payload: {
        sessionId: 'session-integration',
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
    })), 'session.prompt'),
    actorUserId: taskMetadata.actorUserId,
    actorUsername: taskMetadata.actorId,
    conversationId: taskMetadata.conversationId,
    requestId: `request-${rpcId}`,
  });
  const inspectSource = async () => {
    if (capabilities.gitWorkspace) {
      const snapshot = await snapshotForgeDeliveryWorkspace({ workspace, baseCommit: taskMetadata.baseCommit });
      return { head: taskMetadata.baseCommit, fingerprint: snapshot.snapshotDigest };
    }
    const values = await Promise.all([
      readFile(path.join(workspace, 'PROJECT_CONTEXT.md')),
      readFile(path.join(workspace, 'SOURCE_STATE.txt')),
    ]);
    return {
      head: HEAD,
      fingerprint: crypto.createHash('sha256').update(Buffer.concat(values)).digest('hex'),
    };
  };
  const source = await inspectSource();
  const initialRequest = requestFor(promptText, 'rpc-create');
  const initialContext = await prepareProtectedExecutionContext({
    projectRoot,
    projectSlug: taskMetadata.projectSlug,
    taskMetadata,
    request: initialRequest,
    policyPath: POLICY_PATH,
    now: fixtureNow,
  });
  const issueAuthority = (context, text, overrides = {}) => service.issueExecutionAuthority({
    projectSlug: context.projectSlug,
    taskId: context.taskId,
    actorUserId: context.actorUserId,
    actorUsername: context.actorUsername,
    conversationId: context.conversationId,
    dshSessionId: context.dshSessionId,
    route: context.route,
    rpcId: context.rpcId,
    promptText: text,
    promptTextDigest: context.textDigest,
    source: overrides.source ?? source,
    workspaceWriteAuthorized: true,
    authorizedActionCeiling: overrides.authorizedActionCeiling ?? capabilities.authorizedActionCeiling ?? 'workspace-write',
    conversationTaskPreparationSupported: true,
    ...(capabilities.independentReviewSuspensionSupported === true ? { independentReviewSuspensionSupported: true } : {}),
    ...(capabilities.changedVerificationSupported === true ? { changedVerificationSupported: true } : {}),
    ...(capabilities.focusedBackendVerificationSupported === true ? { focusedBackendVerificationSupported: true } : {}),
    ...(capabilities.ordinaryFinalVerificationSupported === true ? { ordinaryFinalVerificationSupported: true } : {}),
    ...(overrides.conversationContractContinuationSupported === undefined ? {} : {
      conversationContractContinuationSupported: overrides.conversationContractContinuationSupported,
    }),
  });
  await issueAuthority(initialContext, promptText);

  const referenceText = await readFile(path.join(workspace, 'PROJECT_CONTEXT.md'));
  const proposal = {
    goal: '在领导引领力后增加安保模块，并提供可正常进入的落地页。',
    ownedPaths: [...ownedPaths],
    taskProfiles: ['frontend-admin'],
    references: [{
      path: 'PROJECT_CONTEXT.md',
      sha256: crypto.createHash('sha256').update(referenceText).digest('hex'),
    }],
  };
  const taskRequest = (context, operation = 'propose') => validateTaskspaceAction({
    action: 'prepare-task',
    operation,
    lookup: lookup(context),
    expectedExecutionId: context.executionId,
    expectedGeneration: context.generation,
    promptText: context.rpcId === initialContext.rpcId ? promptText : context.promptText,
    ...(operation === 'propose' ? { proposal } : {}),
  });
  const prepare = (context, operation = 'propose', overrides = {}) =>
    prepareConversationTaskExecution({
      projectRoot,
      taskMetadata,
      workspace,
      request: overrides.request ?? taskRequest(context, operation),
      inspectSource: overrides.inspectSource ?? inspectSource,
      authorizeProposal: overrides.authorizeProposal ?? ((input) => service.prepareConversationTask(input)),
      policyPath: POLICY_PATH,
      now: fixtureNow,
    });

  return {
    projectRoot,
    taskMetadata,
    workspace,
    service,
    source,
    proposal,
    initialRequest,
    initialContext,
    requestFor,
    inspectSource,
    issueAuthority,
    taskRequest,
    prepare,
    setServiceNow(value) { serviceNow = value; },
  };
}

test('ordinary preparation and continuation retain role decisions from the protected grant', async (t) => {
  const value = await fixture(t);
  const canonical = compileForgeTaskExecutionContract({ prompt: value.initialRequest.promptText, actionCeiling: 'workspace-write',
    ownedPaths: [...ownedPaths], taskProfiles: ['frontend-admin', 'migration', 'backend'] });
  const roleGrantDecisions = [{ path: ownedPaths[1], roleKeys: ['safety_reader'],
    fileSha256: 'a'.repeat(64), statementSha256: 'b'.repeat(64) }];
  const issued = createProductionTaskGrant({ now: NOW, roleGrantDecisions, spec: {
    schemaVersion: 1, projectSlug: value.taskMetadata.projectSlug, taskId: value.taskMetadata.taskId,
    actorUserId: value.taskMetadata.actorUserId, actorUsername: value.taskMetadata.actorId,
    conversationId: value.taskMetadata.conversationId, dshSessionId: value.initialContext.dshSessionId,
    promptText: value.initialRequest.promptText, sourceCommit: value.source.head,
    workspaceFingerprint: value.source.fingerprint, ownedPaths: canonical.ownedPaths,
    taskProfiles: canonical.taskProfiles, ttlSeconds: 900,
  } });
  await value.service.writeProductionTaskGrant(issued.grant);
  const prepared = await value.prepare(value.initialContext);
  assert.deepEqual(prepared.context.contract.roleGrantDecisions, roleGrantDecisions);
  const scope = JSON.parse(await readFile(path.join(value.projectRoot, 'acceptance-state',
    'conversation-task-scopes', `${value.taskMetadata.taskId}.json`), 'utf8'));
  assert.deepEqual(scope.roleGrantDecisions, roleGrantDecisions);

  const next = value.requestFor('继续当前任务。', 'rpc-continue-roles');
  const result = await value.issueAuthority({ ...prepared.context, rpcId: next.rpcId,
    textDigest: next.textDigest }, next.promptText);
  assert.deepEqual(result.trustedPolicyInput.taskAuthority.contract.roleGrantDecisions, roleGrantDecisions);
  const renewed = await value.service.readProductionTaskGrant(value.taskMetadata.taskId);
  assert.deepEqual(renewed.taskContract.roleGrantDecisions, roleGrantDecisions);
  const continued = await prepareProtectedExecutionContext({ projectRoot: value.projectRoot,
    projectSlug: value.taskMetadata.projectSlug, taskMetadata: value.taskMetadata, request: next,
    policyPath: POLICY_PATH, now: NOW, trustedPolicyInput: result.trustedPolicyInput });
  assert.deepEqual(continued.contract.roleGrantDecisions, roleGrantDecisions);
});

test('ordinary preparation cannot erase an explicit empty protected role policy', async (t) => {
  const value = await fixture(t);
  const canonical = compileForgeTaskExecutionContract({ prompt: value.initialRequest.promptText, actionCeiling: 'workspace-write',
    ownedPaths: [...ownedPaths], taskProfiles: ['frontend-admin', 'migration', 'backend'] });
  const issued = createProductionTaskGrant({ now: NOW, roleGrantDecisions: [], spec: {
    schemaVersion: 1, projectSlug: value.taskMetadata.projectSlug, taskId: value.taskMetadata.taskId,
    actorUserId: value.taskMetadata.actorUserId, actorUsername: value.taskMetadata.actorId,
    conversationId: value.taskMetadata.conversationId, dshSessionId: value.initialContext.dshSessionId,
    promptText: value.initialRequest.promptText, sourceCommit: value.source.head,
    workspaceFingerprint: value.source.fingerprint, ownedPaths: canonical.ownedPaths,
    taskProfiles: canonical.taskProfiles, ttlSeconds: 900,
  } });
  await value.service.writeProductionTaskGrant(issued.grant);
  const prepared = await value.prepare(value.initialContext);
  assert.deepEqual(prepared.context.contract.roleGrantDecisions, []);
  const injected = structuredClone(value.taskRequest(prepared.context));
  injected.proposal.roleGrantDecisions = [{ path: ownedPaths[1], roleKeys: ['admin'],
    fileSha256: 'a'.repeat(64), statementSha256: 'b'.repeat(64) }];
  await assert.rejects(value.prepare(prepared.context, 'propose', {
    request: validateTaskspaceAction(injected),
  }), { code: 'CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID' });
});

test('protected role confirmation reads the actual SQL through Manager and consumes one authenticated decision', async (t) => {
  const now = Date.now();
  const value = await fixture(t, undefined, { now, gitWorkspace: true, roleDecisions: true });
  const prepared = await value.prepare(value.initialContext);
  assert.deepEqual(prepared.context.contract.roleGrantDecisions, []);
  const metadata = { ...value.taskMetadata, branch: `task/lyl/${value.taskMetadata.taskId}`,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    accessTokenHash: '0'.repeat(64), harnessPort: 23001, lastCandidate: null, lastRelease: null };
  await writeFile(path.join(value.projectRoot, 'taskspaces', metadata.taskId, 'metadata.json'), JSON.stringify(metadata));
  const sqlPath = path.join(value.workspace, ownedPaths[1]);
  const sql = "INSERT INTO sys_role_resource (role_id, resource_id) SELECT r.id, 123 FROM sys_role r WHERE r.role_key = 'safety_reader' AND r.role_status = 1 AND r.del_flag = 0;\n";
  await mkdir(path.dirname(sqlPath), { recursive: true });
  await writeFile(sqlPath, sql);
  const sourceAfterSql = await value.inspectSource();
  const acceptance = createProtectedAcceptanceServers(value.service);
  const controlSocket = process.platform === 'win32' ? `\\\\.\\pipe\\forge-role-${crypto.randomUUID()}`
    : path.join(value.projectRoot, 'role-control.sock');
  await new Promise((resolve, reject) => { acceptance.control.once('error', reject); acceptance.control.listen(controlSocket, resolve); });
  await new Promise((resolve, reject) => { acceptance.scope.once('error', reject); acceptance.scope.listen(0, '127.0.0.1', resolve); });
  const intakeRoot = path.join(value.projectRoot, 'intake');
  await mkdir(intakeRoot);
  const token = 'm'.repeat(64);
  let mutateAfter = 0;
  const manager = createConversationManager({ projectRoot: value.projectRoot, projectSlug: metadata.projectSlug,
    intakeRoot, controlScript: path.join(value.projectRoot, 'unused-control.sh'), managerToken: token,
    auditPath: path.join(value.projectRoot, 'manager-audit.jsonl'),
    acceptanceControlClient: async () => { throw new Error('role decisions must not issue acceptance receipts'); },
    roleDecisionClient: createProtectedRoleDecisionClient(controlSocket),
    sourceObservationClient: async () => {
      if (mutateAfter > 0 && --mutateAfter === 0) await writeFile(sqlPath, sql.replace('safety_reader', 'admin'));
      const source = await value.inspectSource();
      return { schemaVersion: 1, observationType: 'forge-verify/source', projectSlug: metadata.projectSlug,
        taskId: metadata.taskId, source: { ...source, snapshotSha256: source.fingerprint } };
    },
    runControl: async () => { throw new Error('role confirmation must not start or stop workers'); },
  });
  await new Promise((resolve, reject) => { manager.once('error', reject); manager.listen(0, '127.0.0.1', resolve); });
  const post = async (body, bearer = token) => {
    const response = await fetch(`http://127.0.0.1:${manager.address().port}/v1/taskspaces/${metadata.taskId}/role-decisions`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'preview', projectSlug: metadata.projectSlug, taskId: metadata.taskId,
        actorUserId: metadata.actorUserId, actorUsername: metadata.actorId, conversationId: metadata.conversationId, ...body }),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    const scopeResponse = await fetch(`http://127.0.0.1:${acceptance.scope.address().port}/v1/conversation-roles`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(scopeResponse.status, 404, 'model-facing scope socket must not issue user role decisions');
    assert.notEqual((await post({}, 'x'.repeat(64))).status, 200);
    assert.equal((await post({ actorUserId: '22222222-2222-4222-8222-222222222222' })).status, 403);
    assert.equal((await post({ grants: [] })).status, 422, 'client cannot supply SQL/roles');
    const preview = await post({});
    assert.equal(preview.status, 200, JSON.stringify(preview.value));
    assert.equal(preview.value.grants.length, 1);
    assert.deepEqual(preview.value.grants[0].roleKeys, ['safety_reader']);
    assert.equal(preview.value.grants[0].fileSha256, crypto.createHash('sha256').update(sql).digest('hex'));
    assert.equal(preview.value.approvable, true);
    const confirmation = { operation: 'confirm', previewId: preview.value.previewId, previewDigest: preview.value.previewDigest };
    value.setServiceNow(now + 600_001);
    assert.equal((await post(confirmation)).value.code, 'ROLE_PREVIEW_STALE');
    value.setServiceNow(now);
    await writeFile(sqlPath, sql.replace('safety_reader', 'admin'));
    assert.equal((await post(confirmation)).status, 409, 'changed SQL cannot use the old preview');
    await writeFile(sqlPath, sql);
    mutateAfter = 2;
    assert.equal((await post({})).value.code, 'ROLE_PREVIEW_SOURCE_CHANGED');
    await writeFile(sqlPath, sql.replace("r.role_key = 'safety_reader'", "r.role_key LIKE 'safety%'"));
    const opaque = await post({});
    assert.equal(opaque.status, 200, JSON.stringify(opaque.value));
    assert.equal(opaque.value.approvable, false);
    assert.equal((await post({ operation: 'confirm', previewId: opaque.value.previewId,
      previewDigest: opaque.value.previewDigest })).value.code, 'ROLE_RECIPIENTS_UNRESOLVED');
    await writeFile(sqlPath, sql);
    const latest = await post({});
    assert.equal(latest.status, 200, JSON.stringify(latest.value));
    const confirmBody = { operation: 'confirm', previewId: latest.value.previewId, previewDigest: latest.value.previewDigest };
    const confirmed = await post(confirmBody);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.value));
    assert.deepEqual(confirmed.value.roleGrantDecisions[0].roleKeys, ['safety_reader']);
    assert.equal((await post(confirmBody)).status, 409, 'confirmation is single use');
    const next = value.requestFor('继续当前任务。', 'rpc-confirmed-roles');
    const authority = await value.issueAuthority({ ...prepared.context, rpcId: next.rpcId,
      textDigest: next.textDigest }, next.promptText, { source: sourceAfterSql });
    const decisions = authority.trustedPolicyInput.taskAuthority.contract.roleGrantDecisions;
    assert.deepEqual(decisions, confirmed.value.roleGrantDecisions);
    const checkRoles = roleGrantDecisions => {
      const result = spawnSync(process.execPath, [path.resolve('docker/harness/forge-governance'), 'audit',
        '--root', value.workspace, '--base', metadata.baseCommit, '--format', 'json', '--role-grant-policy',
        JSON.stringify({ contractId: authority.authority.contractId, decisions: roleGrantDecisions })], { encoding: 'utf8', windowsHide: true });
      assert.ok(result.stdout, result.stderr);
      return JSON.parse(result.stdout).findings.filter(item => item.ruleId === 'PERMISSION-ROLE-001');
    };
    assert.ok(checkRoles([]).length > 0, 'checker must reject omitted roles');
    assert.equal(checkRoles(decisions).length, 0, 'checker must consume the exact approved SQL binding');
  } finally {
    await Promise.all([manager, acceptance.control, acceptance.scope].map(server => new Promise(resolve => {
      server.close(resolve); server.closeAllConnections?.();
    })));
  }
});

test('real Acceptance preparation upgrades one readonly generation to an exact writer and repeats idempotently', async (t) => {
  const value = await fixture(t);
  assert.equal(value.initialContext.authorityClass, 'production-read-only');
  let acceptanceCalls = 0;
  const authorizeProposal = async (input) => {
    acceptanceCalls += 1;
    return value.service.prepareConversationTask(input);
  };

  const prepared = await value.prepare(value.initialContext, 'propose', { authorizeProposal });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.context.authorityClass, 'production-task-writer');
  assert.equal(prepared.context.generation, value.initialContext.generation + 1);
  assert.deepEqual(prepared.context.ownedPaths, [...ownedPaths].sort());
  assert.ok(prepared.context.contract.taskProfiles.includes('frontend-admin'));
  assert.ok(prepared.context.contract.taskProfiles.includes('migration'));
  assert.ok(prepared.context.contract.taskProfiles.includes('database'));
  assert.ok(prepared.context.contract.taskProfiles.includes('backend'));
  assert.deepEqual(prepared.context.contract.taskProfiles, prepared.currentTask.taskProfiles);

  const repeated = await value.prepare(value.initialContext, 'propose', { authorizeProposal });
  assert.equal(repeated.status, 'prepared');
  assert.equal(repeated.context.executionId, prepared.context.executionId);
  assert.equal(repeated.context.generation, prepared.context.generation);
  assert.equal(acceptanceCalls, 1);
});

test('focused backend capability reaches preparation, grant, execution and acceptance without requiring module tests', async (t) => {
  for (const supported of [false, true]) {
    const value = await fixture(t, '修改这一个后端测试类，只检查对应的测试类。', {
      changedVerificationSupported: true, focusedBackendVerificationSupported: supported,
    });
    value.proposal.goal = '修复当前后端测试类的错误断言';
    value.proposal.ownedPaths = [ownedPaths[2]];
    value.proposal.taskProfiles = ['backend'];
    const prepared = await value.prepare(value.initialContext);
    assert.equal(prepared.status, 'prepared');
    const grant = await value.service.readProductionTaskGrant(value.taskMetadata.taskId);
    const record = await value.service.readRecord(value.taskMetadata.taskId);
    const consumed = await readProtectedExecutionContext({ projectRoot: value.projectRoot,
      taskMetadata: value.taskMetadata, lookup: lookup(value.initialContext), now: NOW });
    for (const contract of [prepared.context.contract, grant.taskContract, record.taskContract, consumed.contract]) {
      assert.deepEqual(contract.requiredVerificationProfiles,
        ['governance', supported ? 'backend-test-class' : 'backend-module-test']);
      assert.equal(contract.contractId, prepared.context.contractId);
    }
    assert.deepEqual(record.acceptanceContract.requiredProfiles, [supported ? 'backend-test-class' : 'backend-module-test']);
    assert.equal(record.receipts.length, 0, 'preparation does not manufacture verification results');
  }
});

test('cumulative release recovery reaches the actual execution and acceptance consumers in one request', async (t) => {
  const value = await fixture(t, '修改事故调查页面', { authorizedActionCeiling: 'release' });
  const firstPaths = ['forge-admin-ui/src/views/accident/investigate.vue',
    'forge-admin-ui/src/views/accident/__tests__/investigate-field-label-contract.spec.js'];
  const secondPaths = ['forge-admin-ui/src/views/accident/ledger.vue',
    'forge-admin-ui/src/views/accident/__tests__/ledger-stage-tabs-contract.spec.js'];
  value.proposal.ownedPaths = firstPaths;
  await value.prepare(value.initialContext);
  const prepareRound = async (promptText, rpcId, paths) => {
    const request = value.requestFor(promptText, rpcId);
    const authority = await value.issueAuthority({
      ...value.initialContext, rpcId: request.rpcId, textDigest: request.textDigest,
    }, promptText);
    const context = await prepareProtectedExecutionContext({ projectRoot: value.projectRoot,
      projectSlug: value.taskMetadata.projectSlug, taskMetadata: value.taskMetadata,
      request, policyPath: POLICY_PATH, now: NOW,
      ...(authority.trustedPolicyInput ? { trustedPolicyInput: authority.trustedPolicyInput } : {}) });
    const taskRequest = validateTaskspaceAction({ action: 'prepare-task', operation: 'propose',
      lookup: lookup(context), expectedExecutionId: context.executionId, expectedGeneration: context.generation,
      promptText, proposal: { ...value.proposal, ownedPaths: paths } });
    const prepared = await value.prepare(context, 'propose', { request: taskRequest });
    return { authority, prepared, context, taskRequest };
  };
  await prepareRound('事故台账页面也需要修改', 'rpc-ledger', secondPaths);
  const combined = [...firstPaths, ...secondPaths].sort();
  const release = await prepareRound('发版', 'rpc-release-both', combined);
  assert.deepEqual(release.authority.authority.ownedPaths, [...secondPaths].sort());
  assert.equal(release.prepared.status, 'prepared');
  const consumed = await readProtectedExecutionContext({ projectRoot: value.projectRoot,
    taskMetadata: value.taskMetadata, lookup: lookup(release.context), now: NOW });
  const grant = await value.service.readProductionTaskGrant(value.taskMetadata.taskId);
  const accepted = await value.service.readRecord(value.taskMetadata.taskId);
  for (const contract of [consumed.contract, grant.taskContract, accepted.taskContract]) {
    assert.deepEqual(contract.ownedPaths, combined);
    assert.equal(contract.actionCeiling, 'release');
    assert.equal(contract.contractId, release.prepared.context.contractId);
  }
  assert.deepEqual(consumed.ownedPaths, combined);
  assert.deepEqual(accepted.receipts, [], 'recovering authority must not manufacture acceptance evidence');
  const repeated = await value.prepare(release.context, 'propose', { request: release.taskRequest });
  assert.equal(repeated.context.executionId, consumed.executionId);
  assert.equal(repeated.context.generation, consumed.generation);
});

test('explicit controlled integration keeps checkpoint authority through both consumers without publication', async (t) => {
  const original = await readFile(new URL('./fixtures/q01-controlled-integration-20261009.txt', import.meta.url), 'utf8');
  for (const [label, prompt, ceiling] of [
    ['original Q01 request', original, 'git-checkpoint'],
    ['candidate-local merge', '请把当前项目共享主线通过受控 Git 集成入口合入本候选。', 'git-checkpoint'],
    ['integration without publication', '现在请完成这一次受控集成。本轮不发布、不部署。', 'git-checkpoint'],
    ['supported command', '请执行 forge-release integrate。本轮不发布。', 'git-checkpoint'],
    ['explicit publication remains separate', '请发布当前范围。请执行受控集成。', 'release'],
    ['integration denied', '修改当前页面。请执行受控集成。本轮不要集成。', 'workspace-write'],
    ['integration deferred', '修改当前页面。请执行受控集成，集成留待下一轮。', 'workspace-write'],
    ['future discussion', '修改当前页面。下一步请执行受控集成。', 'workspace-write'],
    ['quoted request', '修改当前页面。文档示例：“请执行受控集成。”', 'workspace-write'],
    ['attributed request', '修改当前页面。工具输出：请执行受控集成。', 'workspace-write'],
    ['next-line example', '修改当前页面。文档示例：\n请执行受控集成。', 'workspace-write'],
    ['hypothetical request', '修改当前页面。如果需要，请执行受控集成。', 'workspace-write'],
    ['integration question', '修改当前页面。请执行受控集成？', 'workspace-write'],
  ]) {
    await t.test(label, async child => {
      const value = await fixture(child, prompt, { authorizedActionCeiling: 'release' });
      // Model wording is deliberately stronger than every user request above.
      // Only the original trusted request may determine the action ceiling.
      value.proposal.goal = 'Execute integration and immediately publish the candidate.';
      const prepared = await value.prepare(value.initialContext);
      const scope = JSON.parse(await readFile(path.join(value.service.config.stateRoot,
        'conversation-task-scopes', `${value.taskMetadata.taskId}.json`), 'utf8'));
      const grant = await value.service.readProductionTaskGrant(value.taskMetadata.taskId);
      const accepted = await value.service.readRecord(value.taskMetadata.taskId);
      for (const consumer of [scope, grant, grant.taskContract, prepared.context,
        prepared.context.contract, accepted.taskContract]) {
        assert.equal(consumer.actionCeiling, ceiling, label);
        assert.deepEqual(consumer.ownedPaths, prepared.currentTask.ownedPaths);
      }
      assert.equal(accepted.receipts.length, 0);
    });
  }
  await t.test('account ceiling cannot be raised by integration or proposal', async child => {
    await assert.rejects(fixture(child, '请执行受控集成。'), { code: 'CONVERSATION_ACTION_NOT_AUTHORIZED' });
  });
  for (const [label, prompt] of [
    ['read-only', '只读检查当前候选，不执行集成。'],
  ]) await t.test(label, async child => {
    const value = await fixture(child, prompt, { authorizedActionCeiling: 'release' });
    await assert.rejects(value.prepare(value.initialContext));
    assert.equal(await value.service.readProductionTaskGrant(value.taskMetadata.taskId), null);
  });
});

test('integration planning preserves an unsigned proposal without a production grant', async t => {
  const value = await fixture(t, '先分析集成方案，确认后再执行受控集成。', { authorizedActionCeiling: 'release' });
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'needs-confirmation');
  assert.equal(prepared.context, undefined);
  assert.equal(await value.service.readProductionTaskGrant(value.taskMetadata.taskId), null);
});

test('later repeated-action integration denial cannot grant checkpoint or release', async t => {
  for (const deniedAction of ['不要再执行', '不要继续执行']) {
    await t.test(deniedAction, async child => {
      const value = await fixture(child, `请执行受控集成。本轮${deniedAction}受控集成。`,
        { authorizedActionCeiling: 'release' });
      value.proposal.goal = 'Execute integration and publish the current candidate.';
      const prepared = await value.prepare(value.initialContext);
      const grant = await value.service.readProductionTaskGrant(value.taskMetadata.taskId);
      for (const ceiling of [prepared.context?.actionCeiling, grant?.actionCeiling]) {
        assert.notEqual(ceiling, 'git-checkpoint');
        assert.notEqual(ceiling, 'release');
      }
    });
  }
});

test('prepared production ceilings follow only the trusted user request and account authority through both consumers', async (t) => {
  const realContinuationPrompt = `继续原来领导目标任务和待办页面的需求。本轮只收尾现有前端改动，完成适用的必要检查，并提交、发布当前已授权范围；不要扩展新功能。我确认继续，并授权本轮提交和受控发布，无需为已确认的同一范围再问一次。

平台修复已更新。请通过现有 prepare_task 重新核对并准备准确的前端范围，执行端与验收端应对应同一合同。已有通过的检查和回执，只要源码和适用范围匹配，先走原有复核/复用路径；仅补缺失或实际变化影响的检查。本轮不重复后端测试，不新增后端改动。真实新增或改动违规需要修复后继续，历史问题如实区分，不伪造通过。

继续使用当前 GPT-5.6 模型，通过 Harness 工具完成。暂不做浏览器、截图或图像验收。后台作业只观察并回收同一作业的终态，不重复提交。最后报告实际执行、验收和发布结果；耗时以工具时间为准，没有测量依据就写未知。`;
  for (const [label, prompt, expected] of [
    ['release', '修复当前事故页面字段并发布。', 'release'],
    ['observed edit then release', '事故事件貂蝉页面，事故标题改成RCA标题，如没有数据不显示即可，事故编号改成编号，事故等级改为等级，修改后直接发版', 'release'],
    ['observed edit release', '并不是无数据无数据时隐藏 RCA标题，而是RCA标题字段下没有数据不显示，不要显示(未填写标题)，修改发版', 'release'],
    ['observed authorized release continuation', '继续完成原来这六个文件的任务，保持当前实现，直接完成此前已授权的发布。', 'release'],
    ['authorized release continuation quoted', '修复当前页面。日志显示：“直接完成此前已授权的发布”。', 'workspace-write'],
    ['authorized release continuation attributed', '修复当前页面。工具输出：直接完成此前已授权的发布。', 'workspace-write'],
    ['authorized release continuation question', '继续当前任务，直接完成此前已授权的发布？', 'workspace-write'],
    ['authorized release continuation restricted', '继续当前任务，直接完成此前已授权的发布。但暂不发布。', 'workspace-write'],
    ['edit release label', '修改发版按钮的文案。', 'workspace-write'],
    ['edit release quoted', '修复当前页面。日志显示：“修改后直接发版”。', 'workspace-write'],
    ['edit release attributed', '修复当前页面。工具输出：修改后直接发版。', 'workspace-write'],
    ['edit release question', '修复当前页面，修改后直接发版？', 'workspace-write'],
    ['edit release deferred', '修复当前页面，修改后直接发版，发布留待下一轮。', 'workspace-write'],
    ['edit release restricted', '修复当前页面，修改发版，但不要发布。', 'workspace-write'],
    ['checkpoint', '提交代码：修复当前事故页面字段。', 'git-checkpoint'],
    ['edit', '修复当前事故页面字段。', 'workspace-write'],
    ['view-details behavior', '查看详情显示当前状态的tab页', 'workspace-write'],
    ['negative', '修复当前事故页面字段，暂不发布。', 'workspace-write'],
    ['quoted', '修复当前事故页面字段。日志显示：“发布”。', 'workspace-write'],
    ['live explicit authorization', realContinuationPrompt, 'release'],
    ['explicit current authorization', '修复当前页面。我授权本轮受控发布。', 'release'],
    ['quoted authorization', '修复当前页面。日志显示：“我确认继续，并授权本轮提交和受控发布”。', 'workspace-write'],
    ['attributed authorization', '修复当前页面。工具输出：我确认继续，并授权本轮提交和受控发布。', 'workspace-write'],
    ['authorization question', '修复当前页面。我授权本轮提交和受控发布是否合适？', 'workspace-write'],
    ['authorization withheld', '修复当前页面。我授权本轮提交和受控发布，但暂不发布。', 'workspace-write'],
    ['authorization deferred', '修复当前页面。我授权本轮提交和受控发布，发布留待下一轮。', 'workspace-write'],
  ]) {
    await t.test(label, async (subtest) => {
      const value = await fixture(subtest, prompt, { authorizedActionCeiling: 'release' });
      const prepared = await value.prepare(value.initialContext);
      assert.equal(prepared.status, 'prepared');
      const grant = await value.service.readProductionTaskGrant(value.taskMetadata.taskId);
      const scope = JSON.parse(await readFile(path.join(value.service.config.stateRoot,
        'conversation-task-scopes', `${value.taskMetadata.taskId}.json`), 'utf8'));
      const accepted = await value.service.readRecord(value.taskMetadata.taskId);
      for (const consumer of [scope, grant, grant.taskContract, prepared.context, prepared.context.contract, accepted.taskContract]) {
        assert.equal(consumer.actionCeiling, expected, label);
        assert.deepEqual(consumer.ownedPaths, prepared.currentTask.ownedPaths);
      }
      assert.equal(accepted.taskContract.contractId, prepared.context.contractId);
      assert.equal(grant.taskContract.contractId, prepared.context.contractId);
      assert.equal(accepted.receipts.length, 0, 'Permission to publish is not evidence that publishing passed');
      const repeated = await value.prepare(value.initialContext);
      assert.equal(repeated.context.executionId, prepared.context.executionId);
    });
  }
  await t.test('account without release cannot issue a release grant', async (subtest) => {
    const value = await fixture(subtest, '修复当前事故页面字段并发布。');
    await assert.rejects(value.prepare(value.initialContext), { code: 'CONVERSATION_ACTION_NOT_AUTHORIZED' });
    assert.equal(await value.service.readProductionTaskGrant(value.taskMetadata.taskId), null);
  });
  await t.test('observed edit release cannot exceed account authority', async (subtest) => {
    const value = await fixture(subtest, '修复当前页面，修改后直接发版。');
    await assert.rejects(value.prepare(value.initialContext), { code: 'CONVERSATION_ACTION_NOT_AUTHORIZED' });
    assert.equal(await value.service.readProductionTaskGrant(value.taskMetadata.taskId), null);
  });
  await t.test('explicit authorization cannot exceed account authority', async (subtest) => {
    const value = await fixture(subtest, realContinuationPrompt);
    await assert.rejects(value.prepare(value.initialContext), { code: 'CONVERSATION_ACTION_NOT_AUTHORIZED' });
    assert.equal(await value.service.readProductionTaskGrant(value.taskMetadata.taskId), null);
  });
  await t.test('model proposal cannot assign its own ceiling', async (subtest) => {
    const value = await fixture(subtest, '修复当前事故页面字段。', { authorizedActionCeiling: 'release' });
    value.proposal.actionCeiling = 'release';
    await assert.rejects(value.prepare(value.initialContext), { code: 'CONVERSATION_TASK_PROPOSAL_SCHEMA_INVALID' });
    assert.equal(await value.service.readProductionTaskGrant(value.taskMetadata.taskId), null);
  });
  await t.test('preparation rejects a ceiling mismatch between signed authority and trusted context input', async (subtest) => {
    const value = await fixture(subtest, '修复当前事故页面字段并发布。', { authorizedActionCeiling: 'release' });
    await assert.rejects(value.prepare(value.initialContext, 'propose', {
      authorizeProposal: async (input) => {
        const result = await value.service.prepareConversationTask(input);
        result.authorityResult.trustedPolicyInput.taskAuthority.actionCeiling = 'workspace-write';
        return result;
      },
    }), { code: 'CONVERSATION_TASK_AUTHORITY_INVALID' });
    const current = await readCurrentProtectedExecutionContextForTask({
      projectRoot: value.projectRoot, taskMetadata: value.taskMetadata, now: NOW,
    });
    assert.equal(current.authorityClass, 'production-read-only');
  });
});

test('preparation and acceptance agree on credential-handling source references', async (t) => {
  const source = 'forge-server/forge-framework/forge-plugin-parent/forge-plugin-system/src/test/java/com/mdframe/forge/plugin/system/security/ClientCredentialSurfaceContractTest.java';
  const text = 'final class ClientCredentialSurfaceContractTest {}\n';
  for (const [reference, allowed] of [
    [source, true],
    [source.replace('ClientCredentialSurfaceContractTest.java', 'SysUserPasswordControllerTest.java'), true],
    [source.replace('/security/', '/credentials/'), false],
    [source.replace('ClientCredentialSurfaceContractTest.java', 'client-credentials.json'), false],
  ]) {
    await t.test(reference, async (subtest) => {
      const value = await fixture(subtest);
      await mkdir(path.dirname(path.join(value.workspace, reference)), { recursive: true });
      await writeFile(path.join(value.workspace, reference), text);
      value.proposal.references = [{ path: reference, sha256: crypto.createHash('sha256').update(text).digest('hex') }];
      if (!allowed) {
        await assert.rejects(value.prepare(value.initialContext), { code: 'CONVERSATION_TASK_REFERENCE_INVALID' });
        assert.equal(await value.service.readProductionTaskGrant(value.taskMetadata.taskId), null);
        return;
      }
      const prepared = await value.prepare(value.initialContext);
      assert.equal(prepared.status, 'prepared');
      assert.deepEqual(prepared.context.ownedPaths, [...value.proposal.ownedPaths].sort());
    });
  }
});

test('literal Vue route references require real matching bytes and remain exact in the issued execution', async (t) => {
  const route = 'forge-admin-ui/src/views/accident/report-form/[type].vue';
  const text = '<template><div>Existing report form</div></template>\n';
  for (const state of ['present', 'missing', 'changed']) {
    await t.test(state, async (subtest) => {
      const value = await fixture(subtest, '修复已有事故表单的字段显示。');
      if (state !== 'missing') {
        await mkdir(path.dirname(path.join(value.workspace, route)), { recursive: true });
        await writeFile(path.join(value.workspace, route), state === 'present' ? text : text + '<!-- changed -->\n');
      }
      value.proposal.goal = '修复已有事故表单的字段显示。';
      value.proposal.ownedPaths = [route];
      value.proposal.references = [{ path: route, sha256: crypto.createHash('sha256').update(text).digest('hex') }];
      if (state !== 'present') {
        await assert.rejects(value.prepare(value.initialContext), {
          code: state === 'missing' ? 'CONVERSATION_TASK_REFERENCE_INVALID' : 'CONVERSATION_TASK_REFERENCE_CHANGED',
        });
        assert.equal(await value.service.readProductionTaskGrant('task-integration'), null);
        return;
      }
      const prepared = await value.prepare(value.initialContext);
      assert.equal(prepared.status, 'prepared');
      assert.deepEqual(prepared.currentTask.ownedPaths, [route]);
      assert.deepEqual(prepared.context.ownedPaths, [route]);
      const record = await value.service.readRecord(value.taskMetadata.taskId);
      assert.deepEqual(record.taskContract.ownedPaths, [route]);
      assert.equal(record.taskContract.contractId, prepared.context.contractId);
      assert.deepEqual(record.taskContract.taskProfiles, prepared.context.contract.taskProfiles);
      assert.equal(record.receipts.length, 0, 'Preparing a literal route cannot invent acceptance evidence');
    });
  }
});

test('a question-shaped creation request can propose exact files without receiving an automatic grant', async (t) => {
  const value = await fixture(t, '能不能帮我在导航栏创建安保模块，放到领导引领力后面？');
  const beforeProposal = await value.service.readProductionTaskGrant('task-integration');
  assert.equal(beforeProposal, null);

  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.context.authorityClass, 'production-task-writer');
  assert.deepEqual(prepared.context.ownedPaths, [...ownedPaths].sort());
  assert.deepEqual(prepared.context.contract.taskProfiles,
    prepared.currentTask.taskProfiles,
    'Acceptance-issued task profiles must be the profiles loaded by the new context');
});

test('an upgraded workpod prepares and loads its suspended-review contract through the original conversation path', async (t) => {
  const value = await fixture(t, undefined, { independentReviewSuspensionSupported: true });
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.context.authorityClass, 'production-task-writer');
  assert.deepEqual(prepared.context.ownedPaths, [...ownedPaths].sort());
  assert.ok(prepared.context.contract.suspendedReviewObligations.includes('api-error-and-auth-contract'));
  assert.equal(prepared.context.contract.requiredObligations.includes('api-error-and-auth-contract'), false);
  assert.ok(prepared.context.contract.requiredVerificationProfiles.includes('backend-module-test'));
  const record = await value.service.readRecord(value.taskMetadata.taskId);
  assert.equal(record.taskContract.contractId, prepared.context.contractId);
  assert.deepEqual(record.taskContract, prepared.context.contract);
  assert.equal(record.receipts.length, 0, 'Preparing a task cannot manufacture acceptance evidence');
});

test('ordinary utility obligations match the Manager and automatic issuer without UI or test-first gates', async (t) => {
  const value = await fixture(t, '修改布尔值显示工具及对应测试，修改后直接发版，不接入页面。', {
    independentReviewSuspensionSupported: true, changedVerificationSupported: true, ordinaryFinalVerificationSupported: true,
    authorizedActionCeiling: 'release',
  });
  const paths = ['forge-admin-ui/src/utils/boolean-label.js', 'forge-admin-ui/src/utils/__tests__/boolean-label.spec.js'];
  Object.assign(value.proposal, { goal: '修改布尔值显示工具及对应测试，修改后直接发版，不接入页面。',
    ownedPaths: paths, taskProfiles: ['frontend-admin'] });
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const record = await value.service.readRecord(value.taskMetadata.taskId);
  assert.deepEqual(record.taskContract, prepared.context.contract);
  assert.deepEqual(record.taskContract.requiredVerificationProfiles, ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
  for (const id of ['test-first', 'loading-empty-error-and-busy-states', 'responsive-keyboard-and-browser-review']) {
    assert.equal(record.taskContract.requiredObligations.includes(id), false, id);
  }
  const managerSpec = compileProtectedAcceptanceSpec(record.taskContract);
  assert.deepEqual(record.acceptanceContract.requiredObligations, managerSpec.requiredObligations);
  assert.deepEqual(record.acceptanceContract.requiredDimensions, managerSpec.requiredDimensions);
  assert.deepEqual(managerSpec.requiredObligations.find(item => item.id === 'final-verification'), {
    id: 'final-verification', dimension: 'execution', evidenceType: 'verification', profile: 'frontend-admin-test',
  });
  assert.equal(record.receipts.length, 0, 'Preparing a scoped contract must not manufacture passed checks');
});

test('an older workpod receives its compatible contract without changing scoped final checks', async (t) => {
  const value = await fixture(t, '修复事故事件页面并发版。', {
    independentReviewSuspensionSupported: true, changedVerificationSupported: true, authorizedActionCeiling: 'release',
  });
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const record = await value.service.readRecord(value.taskMetadata.taskId);
  assert.deepEqual(record.taskContract, prepared.context.contract);
  assert.equal(record.taskContract.actionCeiling, 'release');
  assert.equal(record.taskContract.tddRequired, true, 'old validators still require the complete legacy contract');
  assert.ok(record.taskContract.requiredRedProfiles.length > 0);
  assert.ok(!record.taskContract.requiredVerificationProfiles.includes('frontend-admin-build'));
  assert.ok(record.taskContract.suspendedReviewObligations.includes('api-error-and-auth-contract'));
  assert.equal(record.receipts.length, 0);
});

test('a corrected old-workpod capability replaces a previously incompatible grant on the next direct request', async (t) => {
  const text = '修复事故事件页面并发版。';
  const capabilities = { independentReviewSuspensionSupported: true, changedVerificationSupported: true,
    ordinaryFinalVerificationSupported: true, authorizedActionCeiling: 'release' };
  const value = await fixture(t, text, capabilities);
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.context.contract.tddRequired, false);
  capabilities.ordinaryFinalVerificationSupported = false;
  const request = value.requestFor(text, 'rpc-after-capability-repair');
  const authority = await value.issueAuthority({ ...prepared.context, rpcId: request.rpcId,
    textDigest: request.textDigest }, text);
  assert.equal(authority.authority, null, 'the next direct task still uses the supported preparation path');
  const context = await prepareProtectedExecutionContext({ projectRoot: value.projectRoot,
    projectSlug: value.taskMetadata.projectSlug, taskMetadata: value.taskMetadata, request,
    policyPath: POLICY_PATH, now: NOW });
  const recovered = await value.prepare({ ...context, promptText: text });
  assert.equal(recovered.context.actionCeiling, 'release');
  const grant = await value.service.readProductionTaskGrant(value.taskMetadata.taskId);
  assert.equal(grant.taskContract.tddRequired, true);
  assert.ok(grant.taskContract.requiredRedProfiles.length > 0);
});

test('a pure question proposal waits for confirmation, then an explicit execution uses the saved scope', async (t) => {
  const value = await fixture(t, '为什么这样安排？');
  const pending = await value.prepare(value.initialContext);
  assert.equal(pending.status, 'needs-confirmation');
  assert.equal(pending.currentTask.goal, value.proposal.goal);
  assert.deepEqual(pending.currentTask.ownedPaths, [...ownedPaths].sort());
  assert.equal(await value.service.readProductionTaskGrant('task-integration'), null,
    'a model proposal without confirmed implementation intent must not issue a grant');

  await readProtectedExecutionContext({
    projectRoot: value.projectRoot,
    taskMetadata: value.taskMetadata,
    lookup: lookup(value.initialContext),
    now: NOW,
  });
  const executionText = '执行';
  const executionRequest = value.requestFor(executionText, 'rpc-confirm-question-proposal');
  const executionAuthority = await value.issueAuthority({
    ...value.initialContext,
    rpcId: executionRequest.rpcId,
    textDigest: executionRequest.textDigest,
  }, executionText);
  assert.ok(executionAuthority.trustedPolicyInput);
  assert.deepEqual(executionAuthority.trustedPolicyInput.taskAuthority.ownedPaths,
    pending.currentTask.ownedPaths);

  const writer = await prepareProtectedExecutionContext({
    projectRoot: value.projectRoot,
    projectSlug: value.taskMetadata.projectSlug,
    taskMetadata: value.taskMetadata,
    request: executionRequest,
    policyPath: POLICY_PATH,
    now: NOW,
    trustedPolicyInput: executionAuthority.trustedPolicyInput,
  });
  assert.equal(writer.authorityClass, 'production-task-writer');
  assert.deepEqual(writer.ownedPaths, pending.currentTask.ownedPaths);
  assert.deepEqual(writer.contract.taskProfiles, pending.currentTask.taskProfiles);
});

test('metadata initialization followed by status read prepares a matching writer context', async (t) => {
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-cas-concurrent-resume-prompt.md', import.meta.url), 'utf8');
  const value = await fixture(t, prompt);
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const current = await readCurrentProtectedExecutionContextForTask({
    projectRoot: value.projectRoot,
    taskMetadata: value.taskMetadata,
    now: NOW,
  });
  assert.equal(current.authorityClass, 'production-task-writer');
  assert.equal(current.rpcId, value.initialContext.rpcId);
  assert.equal(current.textDigest, value.initialContext.textDigest);
  assert.equal(current.contract.contractId, prepared.context.contractId);
});

test('authorized implementation with bounded source reads preserves the original request through preparation', async (t) => {
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-workflow-keep-version-implementation-prompt.md', import.meta.url), 'utf8');
  const value = await fixture(t, prompt);
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const current = await readCurrentProtectedExecutionContextForTask({
    projectRoot: value.projectRoot,
    taskMetadata: value.taskMetadata,
    now: NOW,
  });
  assert.equal(current.authorityClass, 'production-task-writer');
  assert.equal(current.rpcId, value.initialContext.rpcId);
  assert.equal(current.textDigest, value.initialContext.textDigest);
  assert.equal(current.contract.contractId, prepared.context.contractId);
});

test('direct owner authorization with a fixture reference preserves bound preparation', async (t) => {
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-workflow-authoritative-bootstrap-prompt.md', import.meta.url), 'utf8');
  const value = await fixture(t, prompt);
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const current = await readCurrentProtectedExecutionContextForTask({
    projectRoot: value.projectRoot, taskMetadata: value.taskMetadata, now: NOW,
  });
  assert.equal(current.authorityClass, 'production-task-writer');
  assert.equal(current.rpcId, value.initialContext.rpcId);
  assert.equal(current.textDigest, value.initialContext.textDigest);
  assert.equal(current.contract.contractId, prepared.context.contractId);
});

test('read-only reference headings preserve the complete persistence fault repair request', async (t) => {
  for (const promptPath of ['coverage-optlock-persistence-fault-prompt.md', 'coverage-optlock-persistence-test-prompt.md']) {
    const prompt = await readFile(new URL(`../docs/long-tasks/acceptance-20260929/${promptPath}`, import.meta.url), 'utf8');
    const value = await fixture(t, prompt);
    const prepared = await value.prepare(value.initialContext);
    assert.equal(prepared.status, 'prepared');
    const current = await readCurrentProtectedExecutionContextForTask({
      projectRoot: value.projectRoot, taskMetadata: value.taskMetadata, now: NOW,
    });
    assert.equal(current.authorityClass, 'production-task-writer');
    assert.equal(current.rpcId, value.initialContext.rpcId);
    assert.equal(current.textDigest, value.initialContext.textDigest);
    assert.equal(current.contract.contractId, prepared.context.contractId);
  }
});

test('bounded RBAC edit authorization and read-only citations preserve writer preparation', async (t) => {
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-api-rbac-rejected-edit-recovery-prompt.md', import.meta.url), 'utf8');
  const value = await fixture(t, prompt);
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const current = await readCurrentProtectedExecutionContextForTask({
    projectRoot: value.projectRoot, taskMetadata: value.taskMetadata, now: NOW,
  });
  assert.equal(current.authorityClass, 'production-task-writer');
  assert.equal(current.rpcId, value.initialContext.rpcId);
  assert.equal(current.textDigest, value.initialContext.textDigest);
  assert.equal(current.contract.contractId, prepared.context.contractId);
});

test('source-only crypto correction preserves the exact original request through protected preparation', async (t) => {
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-workflow-http-crypto-source-correction-prompt.md', import.meta.url), 'utf8');
  const value = await fixture(t, prompt);
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const current = await readCurrentProtectedExecutionContextForTask({
    projectRoot: value.projectRoot, taskMetadata: value.taskMetadata, now: NOW,
  });
  assert.equal(current.authorityClass, 'production-task-writer');
  assert.equal(current.rpcId, value.initialContext.rpcId);
  assert.equal(current.textDigest, value.initialContext.textDigest);
  assert.equal(current.contract.contractId, prepared.context.contractId);
});

test('review preparation preserves the original request with a read-only file digest fact', async (t) => {
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-dual-review-recovery-prepare-prompt.md', import.meta.url), 'utf8');
  const value = await fixture(t, prompt);
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const current = await readCurrentProtectedExecutionContextForTask({
    projectRoot: value.projectRoot, taskMetadata: value.taskMetadata, now: NOW,
  });
  assert.equal(current.authorityClass, 'production-task-writer');
  assert.equal(current.rpcId, value.initialContext.rpcId);
  assert.equal(current.textDigest, value.initialContext.textDigest);
  assert.equal(current.contract.contractId, prepared.context.contractId);
});

test('a file digest fact alone cannot authorize preparation or override explicit read-only limits', async (t) => {
  const fact = `只读需求文件 docs/contract.json 的 SHA256 仍为 ${'a'.repeat(64)}`;
  for (const prompt of [fact, `继续完成当前修复。${fact}。不要修改任何文件。`]) {
    const value = await fixture(t, prompt);
    if (prompt === fact) {
      const pending = await value.prepare(value.initialContext);
      assert.equal(pending.status, 'needs-confirmation');
      assert.equal(await value.service.readProductionTaskGrant(value.taskMetadata.taskId), null);
    } else {
      await assert.rejects(value.prepare(value.initialContext), { code: 'CONVERSATION_TASK_READ_ONLY' });
    }
    const current = await readCurrentProtectedExecutionContextForTask({
      projectRoot: value.projectRoot, taskMetadata: value.taskMetadata, now: NOW,
    });
    assert.equal(current.authorityClass, 'production-read-only');
    assert.equal(current.generation, value.initialContext.generation);
  }
});

test('a named read-only reference preserves the complete optlock implementation request', async (t) => {
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-optlock-permission-resume-after-preparation-prompt.md', import.meta.url), 'utf8');
  const value = await fixture(t, prompt);
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const current = await readCurrentProtectedExecutionContextForTask({
    projectRoot: value.projectRoot, taskMetadata: value.taskMetadata, now: NOW,
  });
  assert.equal(current.authorityClass, 'production-task-writer');
  assert.equal(current.rpcId, value.initialContext.rpcId);
  assert.equal(current.textDigest, value.initialContext.textDigest);
  assert.equal(current.contract.contractId, prepared.context.contractId);
});

test('authorized prepare then repair with named source reads preserves bound query request', async (t) => {
  const prompt = await readFile(new URL('../docs/long-tasks/acceptance-20260929/coverage-controlled-query-deterministic-test-prompt.md', import.meta.url), 'utf8');
  const value = await fixture(t, prompt);
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const current = await readCurrentProtectedExecutionContextForTask({
    projectRoot: value.projectRoot, taskMetadata: value.taskMetadata, now: NOW,
  });
  assert.equal(current.authorityClass, 'production-task-writer');
  assert.equal(current.rpcId, value.initialContext.rpcId);
  assert.equal(current.textDigest, value.initialContext.textDigest);
  assert.equal(current.contract.contractId, prepared.context.contractId);
});

test('an explicit read-only original request is rejected before any writer context is created', async (t) => {
  const value = await fixture(t, '只读检查安保导航现状，不要修改任何文件');
  await assert.rejects(
    value.prepare(value.initialContext),
    { code: 'CONVERSATION_TASK_READ_ONLY' },
  );
  const current = await readCurrentProtectedExecutionContextForTask({
    projectRoot: value.projectRoot,
    taskMetadata: value.taskMetadata,
    now: NOW,
  });
  assert.equal(current.executionId, value.initialContext.executionId);
  assert.equal(current.generation, value.initialContext.generation);
  assert.equal(current.authorityClass, 'production-read-only');
});

test('explicit clearance confirmation resumes only the saved bound scope without granting release', async (t) => {
  const unprepared = await fixture(t, '为什么这样安排？');
  const unpreparedText = '确认放行，继续执行';
  const unpreparedRequest = unprepared.requestFor(unpreparedText, 'rpc-clearance-unprepared');
  const noScope = await unprepared.issueAuthority({
    ...unprepared.initialContext, rpcId: unpreparedRequest.rpcId, textDigest: unpreparedRequest.textDigest,
  }, unpreparedText, { authorizedActionCeiling: 'release' });
  assert.equal(noScope.authority, null);
  assert.equal(await unprepared.service.readProductionTaskGrant('task-integration'), null);

  const value = await fixture(t, '为什么这样安排？');
  const pending = await value.prepare(value.initialContext);
  assert.equal(pending.status, 'needs-confirmation');
  const contextFor = (text, rpcId, overrides = {}) => {
    const request = value.requestFor(text, rpcId);
    return { ...value.initialContext, rpcId, textDigest: request.textDigest, ...overrides };
  };
  for (const [index, text] of [
    '确认放行', '放行', '是否确认放行，继续执行？',
    '“确认放行，继续执行”', '确认放行，继续执行？',
  ].entries()) {
    assert.equal(isForgeConversationTaskContinuation(text), false, text);
    const result = await value.issueAuthority(contextFor(text, `rpc-clearance-negative-${index}`), text,
      { authorizedActionCeiling: 'release' });
    assert.equal(result.authority, null, text);
    assert.equal(await value.service.readProductionTaskGrant('task-integration'), null);
  }

  const text = '确认放行，继续执行';
  for (const [label, changes, options] of [
    ['actor', { actorUserId: '22222222-2222-4222-8222-222222222222' }, {}],
    ['conversation', { conversationId: 'another-conversation' }, {}],
    ['session', { dshSessionId: 'another-session' }, {}],
    ['source', {}, { source: { ...value.source, head: '2'.repeat(40) } }],
  ]) {
    await assert.rejects(value.issueAuthority(contextFor(text, `rpc-clearance-wrong-${label}`, changes), text,
      { authorizedActionCeiling: 'release', ...options }), { code: 'CONVERSATION_WRITE_SCOPE_REQUIRED' }, label);
    assert.equal(await value.service.readProductionTaskGrant('task-integration'), null);
  }

  await readProtectedExecutionContext({
    projectRoot: value.projectRoot, taskMetadata: value.taskMetadata,
    lookup: lookup(value.initialContext), now: NOW,
  });
  for (const [index, confirmedText] of [text, '确认放行, 继续执行。'].entries()) {
    assert.equal(isForgeConversationTaskContinuation(confirmedText), true);
    const request = value.requestFor(confirmedText, `rpc-clearance-confirm-${index}`);
    const authority = await value.issueAuthority(contextFor(confirmedText, request.rpcId), confirmedText,
      { authorizedActionCeiling: 'release' });
    assert.ok(authority.trustedPolicyInput);
    assert.equal(authority.authority.actionCeiling, 'workspace-write');
    assert.deepEqual(authority.authority.ownedPaths, pending.currentTask.ownedPaths);
    const writer = await prepareProtectedExecutionContext({
      projectRoot: value.projectRoot, projectSlug: value.taskMetadata.projectSlug,
      taskMetadata: value.taskMetadata, request, policyPath: POLICY_PATH, now: NOW,
      trustedPolicyInput: authority.trustedPolicyInput,
    });
    assert.equal(writer.authorityClass, 'production-task-writer');
    assert.equal(writer.actionCeiling, 'workspace-write');
    assert.deepEqual(writer.ownedPaths, pending.currentTask.ownedPaths);
    assert.deepEqual(writer.contract.taskProfiles, pending.currentTask.taskProfiles);
    assert.equal(writer.contractId, authority.authority.contractId);
  }
});

test('a question between preparation and continuation preserves the exact task scope', async (t) => {
  const value = await fixture(t);
  const prepared = await value.prepare(value.initialContext);

  const questionText = '为什么这样安排？';
  const questionRequest = value.requestFor(questionText, 'rpc-question');
  const questionContext = await prepareProtectedExecutionContext({
    projectRoot: value.projectRoot,
    projectSlug: value.taskMetadata.projectSlug,
    taskMetadata: value.taskMetadata,
    request: questionRequest,
    policyPath: POLICY_PATH,
    now: NOW,
  });
  const grantBeforeQuestion = await value.service.readProductionTaskGrant('task-integration', {
    allowExpired: true,
  });
  const questionAuthority = await value.issueAuthority(questionContext, questionText);
  assert.equal(questionAuthority.authority, null);
  const grantAfterQuestion = await value.service.readProductionTaskGrant('task-integration', {
    allowExpired: true,
  });
  assert.equal(grantAfterQuestion.grantId, grantBeforeQuestion.grantId,
    'a normal question must not automatically rotate or issue a grant');
  assert.equal(grantAfterQuestion.recordDigest, grantBeforeQuestion.recordDigest);
  const inspected = await prepareConversationTaskExecution({
    projectRoot: value.projectRoot,
    taskMetadata: value.taskMetadata,
    workspace: value.workspace,
    request: validateTaskspaceAction({
      action: 'prepare-task',
      operation: 'inspect',
      lookup: lookup(questionContext),
      expectedExecutionId: questionContext.executionId,
      expectedGeneration: questionContext.generation,
      promptText: questionText,
    }),
    inspectSource: value.inspectSource,
    authorizeProposal: (input) => value.service.prepareConversationTask(input),
    policyPath: POLICY_PATH,
    now: NOW,
  });
  assert.equal(inspected.status, 'inspected');
  assert.equal(inspected.currentTask.goal, prepared.currentTask.goal);
  assert.deepEqual(inspected.currentTask.ownedPaths, prepared.currentTask.ownedPaths);
  await readProtectedExecutionContext({
    projectRoot: value.projectRoot,
    taskMetadata: value.taskMetadata,
    lookup: lookup(questionContext),
    now: NOW,
  });

  const continueText = '继续执行';
  const continueRequest = value.requestFor(continueText, 'rpc-continue');
  const continuationAuthority = await value.issueAuthority({
    ...questionContext,
    rpcId: continueRequest.rpcId,
    textDigest: continueRequest.textDigest,
  }, continueText);
  assert.ok(continuationAuthority.trustedPolicyInput);
  const continuationContext = await prepareProtectedExecutionContext({
    projectRoot: value.projectRoot,
    projectSlug: value.taskMetadata.projectSlug,
    taskMetadata: value.taskMetadata,
    request: continueRequest,
    policyPath: POLICY_PATH,
    now: NOW,
    trustedPolicyInput: continuationAuthority.trustedPolicyInput,
  });
  assert.equal(continuationContext.authorityClass, 'production-task-writer');
  assert.deepEqual(continuationContext.ownedPaths, prepared.currentTask.ownedPaths);

  const currentTask = await value.service.prepareConversationTask({
    operation: 'inspect',
    projectSlug: continuationContext.projectSlug,
    taskId: continuationContext.taskId,
    actorUserId: continuationContext.actorUserId,
    actorUsername: continuationContext.actorUsername,
    conversationId: continuationContext.conversationId,
    dshSessionId: continuationContext.dshSessionId,
    rpcId: continuationContext.rpcId,
    promptText: continueText,
    promptTextDigest: continuationContext.textDigest,
    source: value.source,
    expectedExecutionId: continuationContext.executionId,
    expectedGeneration: continuationContext.generation,
  });
  assert.equal(currentTask.currentTask.goal, prepared.currentTask.goal);
});

test('release continuation with changed wording preserves an unexpired contract and signed governance receipt', async (t) => {
  const value = await fixture(t);
  await value.prepare(value.initialContext);
  const firstText = '确认发布这个范围，继续执行。当前构建检查完成，请按既定范围处理。';
  const nextText = '确认发布这个范围，继续执行。按既定范围完成发布。';
  const releaseRound = async (promptText, rpcId, now) => {
    value.setServiceNow(now);
    const request = value.requestFor(promptText, rpcId);
    const authority = await value.issueAuthority({
      ...value.initialContext, rpcId: request.rpcId, textDigest: request.textDigest,
    }, promptText, {
      authorizedActionCeiling: 'release',
      conversationContractContinuationSupported: true,
    });
    const context = await prepareProtectedExecutionContext({
      projectRoot: value.projectRoot,
      projectSlug: value.taskMetadata.projectSlug,
      taskMetadata: value.taskMetadata,
      request,
      policyPath: POLICY_PATH,
      now,
      trustedPolicyInput: authority.trustedPolicyInput,
    });
    const acceptance = await value.service.issueContract({
      taskId: context.taskId,
      authorId: context.actorUserId,
      taskContract: context.contract,
      acceptanceSpec: compileProtectedAcceptanceSpec(context.contract),
      source: value.source,
      executionAuthority: {
        rpcId: context.rpcId,
        productionAuthorityId: authority.trustedPolicyInput.productionAuthorityId,
        productionAuthorityDigest: authority.trustedPolicyInput.productionAuthorityDigest,
        controllerGrantDigest: authority.trustedPolicyInput.controllerGrantDigest,
      },
    });
    const grant = await value.service.readProductionTaskGrant(context.taskId);
    assert.equal(context.authorityClass, 'production-task-writer');
    assert.equal(context.contract.actionCeiling, 'release');
    assert.equal(context.contract.contractId, grant.taskContract.contractId);
    assert.equal(grant.claim.rpcId, request.rpcId);
    assert.equal(grant.promptTextDigest, request.textDigest);
    return { request, authority, context, acceptance, grant };
  };

  const first = await releaseRound(firstText, 'rpc-release-build-explanation', NOW);
  // Runner facts are controlled test inputs; Acceptance itself signs and verifies the receipt.
  const runnerReceipt = {
    schemaVersion: 1,
    receiptType: 'forge-verify/run',
    receiptId: crypto.randomUUID(),
    jobId: crypto.randomUUID(),
    projectSlug: value.taskMetadata.projectSlug,
    taskId: value.taskMetadata.taskId,
    status: 'passed',
    source: {
      head: value.source.head,
      workspaceFingerprint: value.source.fingerprint,
      snapshotSha256: value.source.fingerprint,
    },
    request: { profile: 'governance' },
    execution: {
      steps: [{ exitCode: 0, timedOut: false, transportUncertain: false, cleanup: { proven: true } }],
      exitCode: 0,
      startedAt: new Date(NOW).toISOString(),
      finishedAt: new Date(NOW).toISOString(),
    },
    results: { executed: 1, passed: 1, failed: 0, skipped: 0 },
    logs: { sha256: crypto.createHash('sha256').update('governance fixture passed\n').digest('hex') },
    truth: { executionProven: true, verificationProven: true },
  };
  const issued = await value.service.issueGovernance({
    taskId: value.taskMetadata.taskId,
    contractId: first.context.contract.contractId,
    runnerReceipt,
  });
  const before = await value.service.readRecord(value.taskMetadata.taskId);
  assert.equal(before.receipts.length, 1);
  assert.equal(before.receipts[0].receipt.receiptId, issued.receiptId);
  assert.equal(verifyAcceptanceEvidenceReceipt({
    contract: before.acceptanceContract,
    trustPolicy: first.acceptance.trustPolicy,
    kind: 'governance',
    receipt: before.receipts[0].receipt,
    evaluatedAt: new Date(NOW).toISOString(),
  }).status, 'passed');

  const next = await releaseRound(nextText, 'rpc-release-only-explanation', NOW + 30_000);
  const after = await value.service.readRecord(value.taskMetadata.taskId);
  assert.ok(Date.parse(before.acceptanceContract.expiresAt) > NOW + 30_000);
  assert.deepEqual(await value.inspectSource(), value.source);
  assert.notEqual(next.request.rpcId, first.request.rpcId);
  assert.notEqual(next.request.textDigest, first.request.textDigest);
  assert.notEqual(next.grant.grantId, first.grant.grantId);
  assert.notEqual(next.grant.grantDigest, first.grant.grantDigest);
  assert.notEqual(next.grant.claim.claimId, first.grant.claim.claimId);
  assert.notEqual(next.authority.authority.authorityId, first.authority.authority.authorityId);
  assert.notEqual(next.authority.authority.productionAuthorityDigest, first.authority.authority.productionAuthorityDigest);
  assert.notEqual(next.context.executionId, first.context.executionId);
  assert.equal(next.context.generation, first.context.generation + 1);
  for (const key of ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
    'dshSessionId', 'sourceCommit', 'workspaceFingerprint', 'actionCeiling', 'ownedPaths', 'taskProfiles']) {
    assert.deepEqual(next.grant[key], first.grant[key], `${key} must stay bound to the same task`);
  }
  const semantics = ({ contractId, sourceFingerprint, ...contract }) => contract;
  assert.deepEqual(semantics(after.taskContract), semantics(before.taskContract));
  for (const key of ['candidate', 'requiredProfiles', 'requiredObligations', 'requiredDimensions']) {
    assert.deepEqual(after.acceptanceContract[key], before.acceptanceContract[key]);
  }
  t.diagnostic(JSON.stringify({
    before: { contractId: before.taskContract.contractId, sourceFingerprint: before.taskContract.sourceFingerprint,
      issuedAt: before.acceptanceContract.issuedAt, receipts: before.receipts.length },
    after: { contractId: after.taskContract.contractId, sourceFingerprint: after.taskContract.sourceFingerprint,
      issuedAt: after.acceptanceContract.issuedAt, receipts: after.receipts.length },
  }));
  assert.equal(after.taskContract.contractId, before.taskContract.contractId,
    'a new release explanation must not replace the unexpired task contract');
  assert.equal(after.taskContract.sourceFingerprint, before.taskContract.sourceFingerprint);
  assert.equal(after.acceptanceContract.issuedAt, before.acceptanceContract.issuedAt);
  assert.deepEqual(after.acceptanceContract, before.acceptanceContract);
  assert.deepEqual(after.receipts, before.receipts);
  assert.equal(after.ledger, before.ledger);

  await t.test('a pending proposal with a new goal and the same scope cannot inherit the old acceptance', async () => {
    const promptText = '先给事故报告页面的标题调整方案，确认后再执行。';
    const request = value.requestFor(promptText, 'rpc-new-goal-plan');
    const pendingAuthority = await value.issueAuthority({
      ...value.initialContext, rpcId: request.rpcId, textDigest: request.textDigest,
    }, promptText, { authorizedActionCeiling: 'release', conversationContractContinuationSupported: true });
    assert.equal(pendingAuthority.authority, null);
    const context = await prepareProtectedExecutionContext({
      projectRoot: value.projectRoot, projectSlug: value.taskMetadata.projectSlug,
      taskMetadata: value.taskMetadata, request, policyPath: POLICY_PATH, now: NOW + 30_000,
    });
    const pending = await prepareConversationTaskExecution({
      projectRoot: value.projectRoot, taskMetadata: value.taskMetadata, workspace: value.workspace,
      request: validateTaskspaceAction({ action: 'prepare-task', operation: 'propose', lookup: lookup(context),
        expectedExecutionId: context.executionId, expectedGeneration: context.generation, promptText,
        proposal: { ...value.proposal, goal: '将现有页面的标题改为事故报告，不再执行原来的安保模块目标。' },
      }),
      inspectSource: value.inspectSource,
      authorizeProposal: (input) => value.service.prepareConversationTask(input),
      policyPath: POLICY_PATH, now: NOW + 30_000,
    });
    assert.equal(pending.status, 'needs-confirmation');
    assert.notEqual(pending.currentTask.goal, value.proposal.goal);
    assert.deepEqual(pending.currentTask.ownedPaths, next.context.ownedPaths);
    assert.deepEqual(pending.currentTask.taskProfiles, next.context.contract.taskProfiles);
    assert.equal((await value.service.readProductionTaskGrant(context.taskId)).grantId, next.grant.grantId);
    assert.deepEqual((await value.service.readRecord(context.taskId)).receipts, before.receipts);

    await assert.rejects(releaseRound(firstText, 'rpc-new-goal-identical-confirmation', NOW + 60_000), {
      code: 'CONVERSATION_TASK_PROPOSAL_CONFLICT',
    });
    assert.equal((await value.service.readProductionTaskGrant(context.taskId)).grantId, next.grant.grantId);
    assert.deepEqual(await value.service.readRecord(context.taskId), after,
      'an identical confirmation must fail before changing the old grant or acceptance');
    const confirmed = await releaseRound('确认发布这个范围，继续执行。按当前事故报告标题调整方案执行发布。',
      'rpc-new-goal-confirm-release', NOW + 60_000);
    assert.notEqual(confirmed.context.contract.contractId, next.context.contract.contractId,
      'a new pending goal must not inherit the old task contract even with identical paths and profiles');
    assert.deepEqual(confirmed.context.ownedPaths, next.context.ownedPaths);
    assert.deepEqual(confirmed.context.contract.taskProfiles, next.context.contract.taskProfiles);
    assert.equal(confirmed.context.actionCeiling, next.context.actionCeiling);
    assert.deepEqual((await value.service.readRecord(context.taskId)).receipts, []);
  });
});

test('expired original eligibility and source drift both stop preparation without replacing readonly context', async (t) => {
  await t.test('eligibility expired', async (subtest) => {
    const value = await fixture(subtest);
    value.setServiceNow(NOW + 901_000);
    await assert.rejects(value.prepare(value.initialContext), {
      code: 'CONVERSATION_TASK_REQUEST_EXPIRED',
    });
    const current = await readCurrentProtectedExecutionContextForTask({
      projectRoot: value.projectRoot,
      taskMetadata: value.taskMetadata,
      now: NOW,
    });
    assert.equal(current.executionId, value.initialContext.executionId);
  });

  await t.test('fixture source changed', async (subtest) => {
    const value = await fixture(subtest);
    await writeFile(path.join(value.workspace, 'SOURCE_STATE.txt'), 'source-v2\n');
    await assert.rejects(value.prepare(value.initialContext), {
      code: 'CONVERSATION_TASK_SOURCE_CHANGED',
    });
    const current = await readCurrentProtectedExecutionContextForTask({
      projectRoot: value.projectRoot,
      taskMetadata: value.taskMetadata,
      now: NOW,
    });
    assert.equal(current.executionId, value.initialContext.executionId);
  });
});

test('scope correction rebinds an old frontend-owned backend-polluted task through a new real request and preserves history', async (t) => {
  const value = await fixture(t, '修复当前事故页面字段。');
  const frontendPath = 'forge-admin-ui/src/views/business/accident.vue';
  Object.assign(value.proposal, { goal: '修复当前事故页面字段。', ownedPaths: [frontendPath],
    taskProfiles: ['backend', 'frontend-admin'] });
  const oldPrepared = await value.prepare(value.initialContext);
  assert.equal(oldPrepared.status, 'prepared');
  assert.deepEqual(oldPrepared.context.contract.taskProfiles, ['backend', 'frontend-admin']);
  await readProtectedExecutionContext({ projectRoot: value.projectRoot, taskMetadata: value.taskMetadata,
    lookup: lookup(oldPrepared.context), now: NOW });
  const taskId = value.taskMetadata.taskId;
  const oldGrant = await value.service.readProductionTaskGrant(taskId);
  const oldRecord = await value.service.readRecord(taskId);
  const scopeFile = path.join(value.service.config.stateRoot, 'conversation-task-scopes', `${taskId}.json`);
  const oldScope = JSON.parse(await readFile(scopeFile, 'utf8'));

  const promptText = '本次仅修改当前前端页面字段，不改后端，不新增接口。';
  const request = value.requestFor(promptText, 'rpc-correct-frontend-only-scope');
  const readonlyContext = await prepareProtectedExecutionContext({ projectRoot: value.projectRoot,
    projectSlug: value.taskMetadata.projectSlug, taskMetadata: value.taskMetadata, request,
    policyPath: POLICY_PATH, now: NOW });
  const initialAuthority = await value.issueAuthority(readonlyContext, promptText);
  assert.equal(initialAuthority.authority, null, 'a new task request must use its own prepared proposal');
  const prepared = await prepareConversationTaskExecution({ projectRoot: value.projectRoot,
    taskMetadata: value.taskMetadata, workspace: value.workspace,
    request: validateTaskspaceAction({ action: 'prepare-task', operation: 'propose', lookup: lookup(readonlyContext),
      expectedExecutionId: readonlyContext.executionId, expectedGeneration: readonlyContext.generation,
      promptText, proposal: { ...value.proposal, taskProfiles: ['frontend-admin'] } }),
    inspectSource: value.inspectSource, authorizeProposal: (input) => value.service.prepareConversationTask(input),
    policyPath: POLICY_PATH, now: NOW });
  assert.equal(prepared.status, 'prepared');
  const grant = await value.service.readProductionTaskGrant(taskId);
  const accepted = await value.service.readRecord(taskId);
  const scope = JSON.parse(await readFile(scopeFile, 'utf8'));
  const expectedChecks = ['governance', 'frontend-admin-lint', 'frontend-admin-test',
    'frontend-admin-typecheck', 'frontend-admin-build'];
  for (const contract of [grant.taskContract, prepared.context.contract, accepted.taskContract]) {
    assert.deepEqual(contract.taskProfiles, ['frontend-admin']);
    assert.deepEqual(contract.requiredVerificationProfiles, expectedChecks);
    assert.deepEqual(contract.ownedPaths, [frontendPath]);
    assert.equal(contract.contractId, prepared.context.contractId);
  }
  assert.deepEqual(prepared.context.requiredProfiles, expectedChecks);
  assert.deepEqual(accepted.acceptanceContract.requiredProfiles, expectedChecks.filter((profile) => profile !== 'governance'));
  assert.deepEqual(scope.taskProfiles, ['frontend-admin']);
  assert.deepEqual(grant.taskProfiles, scope.taskProfiles);
  assert.notEqual(prepared.context.contractId, oldPrepared.context.contractId);
  assert.deepEqual(accepted.receipts, [], 'old acceptance evidence must not be relabeled for the corrected contract');

  const archivedGrant = JSON.parse(await readFile(path.join(value.service.config.stateRoot,
    'production-task-grants-history', `${taskId}.${oldGrant.grantId}.${oldGrant.recordDigest}.json`), 'utf8'));
  const archivedRecord = JSON.parse(await readFile(path.join(value.service.config.stateRoot,
    'tasks-history', `${taskId}.${oldRecord.recordDigest.replace(/^sha256:/u, '')}.json`), 'utf8'));
  const archivedScope = JSON.parse(await readFile(path.join(value.service.config.stateRoot,
    'conversation-task-scope-history', `${taskId}.${crypto.createHash('sha256').update(oldScope.rpcId).digest('hex')}.${oldScope.recordDigest}.json`), 'utf8'));
  assert.deepEqual(archivedGrant, oldGrant);
  assert.deepEqual(archivedRecord, oldRecord);
  assert.deepEqual(archivedScope, oldScope);
});

test('frontend utility backend context does not add backend checks in either execution or acceptance', async (t) => {
  const value = await fixture(t, '调整前端调查方式显示工具及测试。保留现有后端文件及问题记录。仅在 forge-admin-ui 中修改工具和测试，不接入页面或接口。');
  const frontendPaths = ['forge-admin-ui/src/utils/investigation-mode.js',
    'forge-admin-ui/src/utils/__tests__/investigation-mode.spec.js'];
  Object.assign(value.proposal, { goal: '调整调查方式显示工具及测试。',
    ownedPaths: frontendPaths, taskProfiles: ['frontend-admin'] });
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const grant = await value.service.readProductionTaskGrant(value.taskMetadata.taskId);
  const accepted = await value.service.readRecord(value.taskMetadata.taskId);
  for (const contract of [grant.taskContract, prepared.context.contract, accepted.taskContract]) {
    assert.deepEqual(contract.taskProfiles, ['frontend-admin']);
    assert.deepEqual(contract.ownedPaths, [...frontendPaths].sort());
    assert.ok(!contract.requiredVerificationProfiles.includes('backend-module-test'));
    assert.equal(contract.contractId, prepared.context.contractId);
  }
  assert.deepEqual(prepared.context.requiredProfiles, accepted.taskContract.requiredVerificationProfiles);
  assert.deepEqual(accepted.acceptanceContract.requiredProfiles,
    prepared.context.requiredProfiles.filter((profile) => profile !== 'governance'));
});

test('turn19 no-addition request keeps database obligations out of scope grant execution and acceptance', async (t) => {
  const promptText = '布尔值显示工具再补一个兼容并发版：字符串 true 和 false 忽略大小写、首尾空白，也分别显示“是”和“否”。原来的布尔值、空值和其他类型的显示保持现有规则。\n\n只修改这个工具和对应测试，不增加页面、后端或数据库内容。完成修改后先保存一个受控检查点，再连续完成必要的局部验证、受控集成和前端发布，并确认结果。整个范围和发布已授权，不需要我逐步回复继续；真正新增的业务决定才需要我确认。';
  const value = await fixture(t, promptText, { authorizedActionCeiling: 'release',
    changedVerificationSupported: true, ordinaryFinalVerificationSupported: true });
  const frontendPaths = ['forge-admin-ui/src/utils/boolean-label.js',
    'forge-admin-ui/src/utils/__tests__/boolean-label.spec.js'];
  Object.assign(value.proposal, { goal: '为布尔值显示工具补充字符串兼容和对应测试。',
    ownedPaths: frontendPaths, taskProfiles: ['frontend-admin'] });
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const scope = JSON.parse(await readFile(path.join(value.service.config.stateRoot,
    'conversation-task-scopes', `${value.taskMetadata.taskId}.json`), 'utf8'));
  const grant = await value.service.readProductionTaskGrant(value.taskMetadata.taskId);
  const accepted = await value.service.readRecord(value.taskMetadata.taskId);
  for (const state of [scope, grant, prepared.context.contract, accepted.taskContract]) {
    assert.deepEqual(state.taskProfiles, ['frontend-admin']);
    assert.deepEqual(state.ownedPaths, [...frontendPaths].sort());
  }
  for (const contract of [grant.taskContract, prepared.context.contract, accepted.taskContract]) {
    assert.deepEqual(contract.taskProfiles, ['frontend-admin']);
    assert.ok(!contract.requiredVerificationProfiles.includes('backend-module-test'));
    assert.ok(!contract.requiredObligations.includes('transaction-index-and-query-review'));
    assert.equal(contract.contractId, prepared.context.contractId);
  }
  assert.deepEqual(prepared.context.requiredProfiles, ['governance', 'frontend-admin-lint', 'frontend-admin-test']);
  assert.deepEqual(accepted.acceptanceContract.requiredProfiles, ['frontend-admin-lint', 'frontend-admin-test']);
  assert.ok(!accepted.acceptanceContract.requiredObligations.some(item => item.id === 'transaction-index-and-query-review'));
});

test('scope correction keeps real tenant permission obligations beside an environment permission explanation in both consumers', async (t) => {
  const value = await fixture(t, '平台已修复预装依赖目录读取权限。本次为当前前端页面增加租户权限校验。');
  Object.assign(value.proposal, { goal: '修复当前页面的租户权限校验。',
    ownedPaths: ['forge-admin-ui/src/views/business/accident.vue'], taskProfiles: ['frontend-admin'] });
  const prepared = await value.prepare(value.initialContext);
  assert.equal(prepared.status, 'prepared');
  const grant = await value.service.readProductionTaskGrant(value.taskMetadata.taskId);
  const accepted = await value.service.readRecord(value.taskMetadata.taskId);
  for (const contract of [grant.taskContract, prepared.context.contract, accepted.taskContract]) {
    assert.deepEqual(contract.taskProfiles, ['frontend-admin', 'security']);
    assert.ok(contract.requiredVerificationProfiles.includes('changed-safe'));
    assert.ok(contract.requiredVerificationProfiles.includes('full-regression'));
    assert.equal(contract.contractId, prepared.context.contractId);
    assert.deepEqual(contract.requiredVerificationProfiles, prepared.context.requiredProfiles);
  }
  assert.deepEqual(accepted.acceptanceContract.requiredProfiles,
    prepared.context.requiredProfiles.filter((profile) => profile !== 'governance'));
});
