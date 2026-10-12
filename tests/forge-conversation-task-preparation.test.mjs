import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ProtectedAcceptanceService,
  createProtectedAcceptanceServers,
  isForgeConversationTaskContinuation,
} from '../docker/harness/forge-protected-acceptance-service.mjs';
import {
  createConversationManager,
} from '../docker/harness/conversation-manager.mjs';
import { prepareConversationTaskExecution } from '../docker/harness/forge-conversation-task-preparation.mjs';
import { validatePrepareTaskResult } from '../docker/harness/forge-prepare-task.mjs';
import {
  classifyPinnedDshPromptBody,
  digestDirectUserTextContent,
  prepareProtectedExecutionContext,
  readProtectedExecutionContext,
} from '../docker/harness/forge-execution-context.mjs';
import { ForgeExecutionStore } from '../docker/harness/forge-execution-store.mjs';
import { installPhaseBudgetGuard, closeoutBlockers } from '../docker/harness/forge-phase-budget-guard.mjs';
import { validateTaskspaceAction } from '../docker/harness/taskspace-policy.mjs';
import { VERIFY_PROFILE_NAMES } from '../docker/harness/verify-policy.mjs';
import { canonicalSha256 } from '../docker/harness/forge-acceptance-aggregator.mjs';
import { backendTestSelectorsForContract, deriveBackendTestBindings, validateForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';

const START = new Date('2026-09-14T08:00:00.000Z');
const HEAD = 'a'.repeat(40);
const FINGERPRINT = 'b'.repeat(64);
const ACTOR_USER_ID = '11111111-1111-4111-8111-111111111111';
const EXECUTION_ID = '22222222-2222-4222-8222-222222222222';
const HASH = 'c'.repeat(64);
const POLICY_PATH = path.resolve('docker/harness/forge-execution-policy.json');

const taskPaths = Object.freeze({
  page: 'forge-admin-ui/src/views/security/index.vue',
  migration: 'forge-server/db/migration/V1.0.200__add_security_menu.sql',
  test: 'forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/security/SecurityMenuMigrationTest.java',
});

const writerScopes = Object.freeze([
  { taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] },
  { taskProfile: 'migration', ownedPaths: ['forge-server/db/migration'] },
  {
    taskProfile: 'backend',
    ownedPaths: ['forge-server/forge-business/forge-business-core/src/test/java'],
  },
]);

test('actual task preparation carries verified Maven bytes into the random-port HTTP integration class contract', async (t) => {
  const app = 'forge-server/app', production = 'forge-server/plugins/rules';
  const testPath = `${app}/src/test/java/example/RuleIntegrationTest.java`;
  const ownedPaths = [`${production}/src/main/java/example/RuleService.java`, testPath,
    `${app}/src/test/resources/rules/spec.md`].sort();
  const f = await fixture({ scopes: [{ taskProfile: 'backend', ownedPaths }] });
  t.after(() => f.cleanup());
  const promptText = '修复规则接口并运行指定集成测试。';
  const issue = issueInput(promptText, { changedVerificationSupported: true, focusedBackendVerificationSupported: true });
  await f.service.issueExecutionAuthority(issue);
  const taskMetadata = { schemaVersion: 2, projectSlug: 'forge-project', taskId: 'task-001', actorUserId: ACTOR_USER_ID,
    actorId: 'lyl', conversationId: 'conversation-001', status: 'active', accessMode: 'conversation' };
  const workspace = path.join(f.root, 'taskspaces', taskMetadata.taskId, 'workspace');
  const sources = {
    [`${production}/src/main/java/example/RuleService.java`]: 'package example; public class RuleService {}',
    [`${app}/src/test/resources/rules/spec.md`]: '# Existing rule update acceptance\n',
    [testPath]: 'package example; import org.junit.jupiter.api.Test; import org.springframework.boot.test.context.SpringBootTest; @SpringBootTest(classes = Application.class, webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT) class RuleIntegrationTest { @Test void update() {} }',
    [`${app}/pom.xml`]: '<project><groupId>example</groupId><artifactId>app</artifactId><dependencies><dependency><groupId>example</groupId><artifactId>rules</artifactId></dependency></dependencies></project>',
    [`${production}/pom.xml`]: '<project><groupId>example</groupId><artifactId>rules</artifactId></project>',
  };
  for (const [file, content] of Object.entries(sources)) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), content);
  }
  const context = await prepareProtectedExecutionContext({ projectRoot: f.root, projectSlug: taskMetadata.projectSlug,
    taskMetadata, request: { ...classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request',
      rpcId: issue.rpcId, method: 'session.prompt', payload: { sessionId: 'session-001', mode: 'queue',
        content: [{ type: 'text', text: promptText }] } })), 'session.prompt'), actorUserId: ACTOR_USER_ID,
      actorUsername: 'lyl', conversationId: 'conversation-001', requestId: 'request-integration' },
    policyPath: POLICY_PATH, now: START.getTime() });
  const lookup = Object.fromEntries(['projectSlug', 'taskId', 'conversationId', 'actorUserId', 'dshSessionId', 'rpcId', 'textDigest']
    .map(key => [key, context[key]]));
  const prepared = await prepareConversationTaskExecution({ projectRoot: f.root, taskMetadata, workspace,
    request: validateTaskspaceAction({ action: 'prepare-task', operation: 'propose', lookup,
      expectedExecutionId: context.executionId, expectedGeneration: context.generation, promptText,
      proposal: { goal: promptText, ownedPaths, taskProfiles: ['backend'], references: Object.entries(sources)
        .map(([file, content]) => ({ path: file, sha256: createHash('sha256').update(content).digest('hex') })) } }),
    inspectSource: async () => ({ head: HEAD, fingerprint: FINGERPRINT }),
    authorizeProposal: async input => {
      const binding = input.backendTestBindings?.[0];
      assert.ok(binding, 'Actual preparation must include hashed Maven sources');
      for (const change of [{ testPomSha256: '0'.repeat(64) },
        { moduleDependencies: [{ ...binding.moduleDependencies[0], pomSha256: '0'.repeat(64) }] }]) {
        await assert.rejects(f.service.prepareConversationTask({ ...input, backendTestBindings: [{ ...binding, ...change }] }),
          { code: 'CONVERSATION_TEST_BINDING_REFERENCE_INVALID' });
      }
      return f.service.prepareConversationTask(input);
    }, policyPath: POLICY_PATH, now: START.getTime() });
  assert.equal(prepared.status, 'prepared');
  const record = JSON.parse(await readFile(path.join(f.root, 'state/tasks/task-001.json'), 'utf8'));
  assert.deepEqual(record.taskContract.requiredVerificationProfiles, ['governance', 'backend-test-class']);
  assert.deepEqual(backendTestSelectorsForContract(record.taskContract), {
    modules: [app, production], tests: ['example.RuleIntegrationTest'],
  });
  assert.deepEqual(record.taskContract.ownedPaths, ownedPaths);
  assert.equal(record.taskContract.backendTestBindings[0].testPomSha256,
    createHash('sha256').update(sources[`${app}/pom.xml`]).digest('hex'));
});

function privatePem() {
  return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
}

async function fixture({ enabled = true, scopes = writerScopes, currentExecutionAuthority, semanticScopes } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-conversation-task-preparation-'));
  let now = START.getTime();
  const config = {
    schemaVersion: 1,
    serviceType: 'forge-protected-acceptance-service/v1',
    projectSlug: 'forge-project',
    policyId: 'forge-project-acceptance',
    stateRoot: path.join(root, 'state'),
    contractTtlSeconds: 900,
    conversationTaskPreparation: enabled,
    conversationWriterScopes: structuredClone(scopes),
    ...(semanticScopes === undefined ? {} : { conversationSemanticResourceScopes: structuredClone(semanticScopes) }),
    allowedVerificationProfiles: [...VERIFY_PROFILE_NAMES],
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
  };
  const service = new ProtectedAcceptanceService({
    config,
    platformKeyPem: privatePem(),
    governanceKeyPem: privatePem(),
    verificationKeyPem: privatePem(),
    semanticKeyPem: privatePem(),
    verdictKeyPem: privatePem(),
    clock: () => new Date(now),
    ...(currentExecutionAuthority ? { currentExecutionAuthority } : {}),
  });
  return {
    root,
    service,
    setNow(value) { now = value; },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

function promptDigest(promptText) {
  return digestDirectUserTextContent([{ type: 'text', text: promptText }]);
}

function issueInput(promptText, overrides = {}) {
  return {
    projectSlug: 'forge-project',
    taskId: 'task-001',
    actorUserId: ACTOR_USER_ID,
    actorUsername: 'lyl',
    conversationId: 'conversation-001',
    dshSessionId: 'session-001',
    route: 'session.prompt',
    rpcId: 'rpc-001',
    promptText,
    promptTextDigest: promptDigest(promptText),
    source: { head: HEAD, fingerprint: FINGERPRINT },
    workspaceWriteAuthorized: true,
    authorizedActionCeiling: 'workspace-write',
    conversationTaskPreparationSupported: true,
    ...overrides,
  };
}

function prepareInput(issue, operation = 'inspect', overrides = {}) {
  const {
    route: _route,
    workspaceWriteAuthorized: _workspaceWriteAuthorized,
    authorizedActionCeiling: _authorizedActionCeiling,
    conversationTaskPreparationSupported: _conversationTaskPreparationSupported,
    conversationFormatMaintenanceSupported: _conversationFormatMaintenanceSupported,
    ...identity
  } = issue;
  return {
    operation,
    ...identity,
    expectedExecutionId: EXECUTION_ID,
    expectedGeneration: 1,
    ...(operation === 'propose' ? { proposal: taskProposal() } : {}),
    ...overrides,
  };
}

function taskProposal(overrides = {}) {
  return {
    goal: '在领导引领力后增加安保模块，并提供可正常进入的落地页。',
    ownedPaths: [taskPaths.page, taskPaths.migration, taskPaths.test],
    taskProfiles: ['frontend-admin'],
    references: [{ path: 'docs/architecture.md', sha256: HASH }],
    ...overrides,
  };
}

function hostAdmissionReceipt({ fingerprint, issuedAt = START } = {}) {
  const executables = Object.fromEntries(
    ['forgeGovernance', 'git', 'java', 'maven', 'node', 'pnpm'].map((name) => [name, {
      configuredPath: `/opt/forge-tools/${name}`,
      resolvedPath: `/opt/forge-tools/${name}`,
      bytes: 100,
      modifiedMs: 1,
      version: `${name} 1.0.0`,
    }]),
  );
  return {
    schemaVersion: 2,
    receiptType: 'forge-verify/host-execution-admission',
    admissionId: randomUUID(),
    projectSlug: 'forge-project',
    taskId: 'task-001',
    outcome: 'ready',
    reasonCode: null,
    profiles: ['governance'],
    source: {
      head: HEAD,
      workspaceFingerprint: fingerprint,
      dependencyManifestFingerprint: 'd'.repeat(64),
    },
    runner: { bootId: randomUUID(), revision: 'ordinary-task-binding-test' },
    profileCatalogVersion: '2026.09.03.3',
    profilePolicyDigest: '4'.repeat(64),
    toolchain: {
      javaHome: '/opt/forge-tools/java-home',
      executables,
      digest: '5'.repeat(64),
    },
    truth: {
      executionProven: false,
      verificationProven: false,
      semanticCorrectnessProven: false,
      databaseIntegrationProven: false,
      releaseProven: false,
    },
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
  };
}

function candidateBinding(context) {
  return {
    projectSlug: context.projectSlug,
    taskId: context.taskId,
    actorUserId: context.actorUserId,
    actorUsername: context.actorUsername,
    conversationId: context.conversationId,
    dshSessionId: context.dshSessionId,
    executionId: context.executionId,
    generation: context.generation,
    rpcId: context.rpcId,
    contractId: context.contractId,
    authorityClass: context.authorityClass,
    actionCeiling: context.actionCeiling,
    sourceCommit: context.sourceCommit,
    authorityWorkspaceFingerprint: context.workspaceFingerprint,
    productionAuthorityId: context.productionAuthorityId,
    productionAuthorityDigest: context.productionAuthorityDigest,
    controllerGrantDigest: context.controllerGrantDigest,
  };
}

async function expectCode(code, promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, code);
    return true;
  });
}

test('trusted preparation derives read-only JUnit helper bindings from actual referenced files', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const modulePath = 'forge-server/forge-business/forge-business-core';
  const helper = `${modulePath}/src/test/java/example/RemarkFixture.java`;
  const validation = `${modulePath}/src/test/java/example/RemarkValidation.java`;
  const files = new Map([
    [helper, 'package example; public class RemarkFixture {}'],
    [validation, 'package example; import org.junit.jupiter.api.Test; class RemarkValidation { @Test void verifies() { new RemarkFixture(); } }'],
  ]);
  const issue = issueInput('继续', { independentReviewSuspensionSupported: true, changedVerificationSupported: true,
    focusedBackendVerificationSupported: true, ordinaryFinalVerificationSupported: true,
    conversationContractContinuationSupported: true });
  await value.service.issueExecutionAuthority(issue);
  const taskMetadata = { schemaVersion: 2, projectSlug: issue.projectSlug, taskId: issue.taskId,
    actorUserId: ACTOR_USER_ID, actorId: 'lyl', conversationId: issue.conversationId, status: 'active', accessMode: 'conversation' };
  const workspace = path.join(value.root, 'taskspaces', issue.taskId, 'workspace');
  for (const [relative, content] of files) {
    await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await writeFile(path.join(workspace, relative), content);
  }
  const originalRequest = { ...classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request',
    rpcId: issue.rpcId, method: 'session.prompt', payload: { sessionId: issue.dshSessionId, mode: 'queue',
      content: [{ type: 'text', text: issue.promptText }] } })), 'session.prompt'),
    actorUserId: ACTOR_USER_ID, actorUsername: 'lyl', conversationId: issue.conversationId, requestId: 'request-helper-binding' };
  const context = await prepareProtectedExecutionContext({ projectRoot: value.root, projectSlug: issue.projectSlug,
    taskMetadata, request: originalRequest, policyPath: POLICY_PATH, now: START.getTime() });
  const action = { action: 'prepare-task', operation: 'propose',
    lookup: Object.fromEntries(['projectSlug', 'taskId', 'conversationId', 'actorUserId', 'dshSessionId', 'rpcId', 'textDigest']
      .map(key => [key, context[key]])), expectedExecutionId: context.executionId, expectedGeneration: context.generation,
    promptText: issue.promptText, proposal: { goal: '修复后端测试夹具长度约束，仅运行实际关联的验证类。',
      ownedPaths: [helper], taskProfiles: ['backend'], references: [...files].map(([file, content]) =>
        ({ path: file, sha256: createHash('sha256').update(content).digest('hex') })) } };
  assert.throws(() => validateTaskspaceAction({ ...action, backendTestBindings: [] }),
    'The model-facing request must not accept operator-supplied test mappings.');
  let trustedInput;
  const result = await prepareConversationTaskExecution({ projectRoot: value.root, taskMetadata, workspace,
    request: validateTaskspaceAction(action), inspectSource: async () => ({ head: HEAD, fingerprint: FINGERPRINT }),
    authorizeProposal: input => { trustedInput = input; return value.service.prepareConversationTask(input); },
    policyPath: POLICY_PATH, now: START.getTime() });
  assert.equal(result.status, 'prepared');
  assert.equal(trustedInput.backendTestBindings[0].testPath, validation);
  const record = await value.service.readRecord(issue.taskId);
  const grant = await value.service.readProductionTaskGrant(issue.taskId);
  assert.equal(record.taskContract.contractId, result.context.contractId);
  assert.deepEqual(grant.taskContract.backendTestBindings, trustedInput.backendTestBindings);
  assert.deepEqual(backendTestSelectorsForContract(record.taskContract), {
    modules: [modulePath], tests: ['example.RemarkValidation'],
  });
  assert.deepEqual(record.taskContract.ownedPaths, [helper], 'Read-only test evidence does not expand write scope.');
  const continued = await value.service.issueExecutionAuthority({ ...issue, rpcId: 'rpc-helper-continued' });
  const renewedGrant = await value.service.readProductionTaskGrant(issue.taskId);
  assert.equal(continued.authority.contractId, record.taskContract.contractId);
  assert.deepEqual(renewedGrant.taskContract.backendTestBindings, trustedInput.backendTestBindings);
});

test('owned migration SQL binds only its verified JUnit source through normal preparation', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const sql = 'forge-server/db/migration/V2__display_labels.sql';
  const modulePath = 'forge-server/forge-business/forge-business-core';
  const testPath = `${modulePath}/src/test/java/example/DisplayMigrationTest.java`;
  const java = 'package example; import org.junit.jupiter.api.Test; import java.nio.file.Files; import java.nio.file.Path; class DisplayMigrationTest { @Test void labels() throws Exception { String sql = Files.readString(Path.of("db/migration/V2__display_labels.sql")); org.junit.jupiter.api.Assertions.assertTrue(sql.contains("UPDATE")); } }';
  const files = new Map([[sql, 'UPDATE display_labels SET english = NULL;'], [testPath, java]]);
  const ownedPaths = [sql, testPath].sort();
  const refs = [...files].map(([file, content]) => ({ path: file, sha256: createHash('sha256').update(content).digest('hex'), content }));
  assert.equal(deriveBackendTestBindings(ownedPaths, refs.filter(r => r.path !== sql)), undefined);
  for (const content of [java.replace('@Test ', ''), java.replace('V2__display_labels.sql', 'V9__unrelated.sql'),
    java.replace('Files.readString(Path.of("db/migration/V2__display_labels.sql"))', '"unused" /* db/migration/V2__display_labels.sql */')]) {
    assert.equal(deriveBackendTestBindings(ownedPaths, [refs[0], { path: testPath, content,
      sha256: createHash('sha256').update(content).digest('hex') }]), undefined);
  }
  const indirect = java.replace('class DisplayMigrationTest {', 'class DisplayMigrationTest { static final String MIGRATION = "db/migration/V2__display_labels.sql"; static String readMigration(String name) throws Exception { return Files.readString(Path.of(name)); }')
    .replace('Files.readString(Path.of("db/migration/V2__display_labels.sql"))', 'readMigration(MIGRATION)');
  assert.equal(deriveBackendTestBindings(ownedPaths, [refs[0], { path: testPath, content: indirect,
    sha256: createHash('sha256').update(indirect).digest('hex') }])[0].test, 'example.DisplayMigrationTest');
  assert.equal(deriveBackendTestBindings([...ownedPaths, 'forge-server/db/migration/V3__unreferenced.sql'], refs), undefined);
  const issue = issueInput('修改固定显示迁移及对应契约测试。', { independentReviewSuspensionSupported: true,
    changedVerificationSupported: true, focusedBackendVerificationSupported: true, ordinaryFinalVerificationSupported: true });
  await value.service.issueExecutionAuthority(issue);
  const taskMetadata = { schemaVersion: 2, projectSlug: issue.projectSlug, taskId: issue.taskId,
    actorUserId: ACTOR_USER_ID, actorId: 'lyl', conversationId: issue.conversationId, status: 'active', accessMode: 'conversation' };
  const workspace = path.join(value.root, 'taskspaces', issue.taskId, 'workspace');
  for (const [relative, content] of files) {
    await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await writeFile(path.join(workspace, relative), content);
  }
  const context = await prepareProtectedExecutionContext({ projectRoot: value.root, projectSlug: issue.projectSlug,
    taskMetadata, request: { ...classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request',
      rpcId: issue.rpcId, method: 'session.prompt', payload: { sessionId: issue.dshSessionId, mode: 'queue',
        content: [{ type: 'text', text: issue.promptText }] } })), 'session.prompt'),
      actorUserId: ACTOR_USER_ID, actorUsername: 'lyl', conversationId: issue.conversationId, requestId: 'migration-binding' },
    policyPath: POLICY_PATH, now: START.getTime() });
  const action = { action: 'prepare-task', operation: 'propose',
    lookup: Object.fromEntries(['projectSlug', 'taskId', 'conversationId', 'actorUserId', 'dshSessionId', 'rpcId', 'textDigest'].map(k => [k, context[k]])),
    expectedExecutionId: context.executionId, expectedGeneration: context.generation, promptText: issue.promptText,
    proposal: { goal: issue.promptText, ownedPaths, taskProfiles: ['migration', 'backend'],
      references: refs.map(({ path, sha256 }) => ({ path, sha256 })) } };
  assert.throws(() => validateTaskspaceAction({ ...action, backendTestBindings: [] }));
  let trustedInput;
  const execute = () => prepareConversationTaskExecution({ projectRoot: value.root, taskMetadata, workspace,
    request: validateTaskspaceAction(action), inspectSource: async () => ({ head: HEAD, fingerprint: FINGERPRINT }),
    authorizeProposal: input => { trustedInput = input; return value.service.prepareConversationTask(input); },
    policyPath: POLICY_PATH, now: START.getTime() });
  await writeFile(path.join(workspace, sql), 'changed SQL');
  await assert.rejects(execute(), { code: 'CONVERSATION_TASK_REFERENCE_CHANGED' });
  await writeFile(path.join(workspace, sql), files.get(sql));
  const result = await execute();
  assert.equal(result.status, 'prepared');
  assert.deepEqual(trustedInput.backendTestBindings, [{ module: modulePath, test: 'example.DisplayMigrationTest',
    testPath, testSha256: refs[1].sha256, coveredPaths: ownedPaths }]);
  const record = await value.service.readRecord(issue.taskId);
  assert.ok(record.taskContract.requiredVerificationProfiles.includes('backend-test-class'));
  assert.ok(!record.taskContract.requiredVerificationProfiles.includes('backend-module-test'));
  validateForgeTaskExecutionContract(JSON.parse(JSON.stringify(record.taskContract)));
  assert.deepEqual(backendTestSelectorsForContract(record.taskContract), { modules: [modulePath], tests: ['example.DisplayMigrationTest'] });
  assert.throws(() => validateForgeTaskExecutionContract({ ...record.taskContract,
    backendTestBindings: [{ ...trustedInput.backendTestBindings[0], coveredPaths: [testPath, 'forge-server/db/migration/V3__outside.sql'] }] }));
});

test('inspect recovers only the completed preparation for its exact original request and unchanged source', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const issue = issueInput('修复安保模块页面并验证。');
  await value.service.issueExecutionAuthority(issue);
  const taskMetadata = { schemaVersion: 2, projectSlug: issue.projectSlug, taskId: issue.taskId,
    actorUserId: ACTOR_USER_ID, actorId: 'lyl', conversationId: issue.conversationId,
    status: 'active', accessMode: 'conversation' };
  const workspace = path.join(value.root, 'taskspaces', issue.taskId, 'workspace');
  const reference = 'docs/architecture.md';
  const content = '# Existing security page\n';
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await writeFile(path.join(workspace, reference), content);
  const nativeRequest = (rpcId) => ({ ...classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
    type: 'client-request', rpcId, method: 'session.prompt', payload: {
      sessionId: issue.dshSessionId, mode: 'queue', content: [{ type: 'text', text: issue.promptText }],
    },
  })), 'session.prompt'), actorUserId: ACTOR_USER_ID, actorUsername: 'lyl',
  conversationId: issue.conversationId, requestId: 'late-prepare' });
  const origin = await prepareProtectedExecutionContext({ projectRoot: value.root,
    projectSlug: issue.projectSlug, taskMetadata, request: nativeRequest(issue.rpcId),
    policyPath: POLICY_PATH, now: START.getTime() });
  const lookup = Object.fromEntries(['projectSlug', 'taskId', 'conversationId', 'actorUserId',
    'dshSessionId', 'rpcId', 'textDigest'].map((key) => [key, origin[key]]));
  const inspect = { action: 'prepare-task', operation: 'inspect', lookup,
    expectedExecutionId: origin.executionId, expectedGeneration: origin.generation, promptText: issue.promptText };
  const propose = { ...inspect, operation: 'propose', proposal: { goal: issue.promptText,
    ownedPaths: [taskPaths.page], taskProfiles: ['frontend-admin'],
    references: [{ path: reference, sha256: createHash('sha256').update(content).digest('hex') }] } };
  let authorizeCalls = 0;
  let releasePreparation;
  let enteredPreparation;
  const entered = new Promise((resolve) => { enteredPreparation = resolve; });
  const release = new Promise((resolve) => { releasePreparation = resolve; });
  let source = { head: HEAD, fingerprint: FINGERPRINT };
  const execute = (request, overrides = {}) => prepareConversationTaskExecution({
    projectRoot: value.root, taskMetadata, workspace, request: validateTaskspaceAction(request),
    inspectSource: async () => source,
    authorizeProposal: async (input) => {
      authorizeCalls += 1;
      enteredPreparation();
      await release;
      return value.service.prepareConversationTask(input);
    },
    policyPath: POLICY_PATH, now: START.getTime(), ...overrides,
  });
  const lostResponse = execute(propose);
  await entered;
  // The original client has stopped waiting; inspect is already queued behind preparation.
  const waitingInspection = execute(inspect);
  releasePreparation();
  const prepared = await lostResponse;
  const recovered = await waitingInspection;
  assert.deepEqual(recovered, prepared);
  assert.equal(recovered.status, 'prepared');
  assert.equal(recovered.context.generation, origin.generation + 1);
  assert.notEqual(recovered.context.executionId, origin.executionId);
  assert.equal(authorizeCalls, 1, 'Inspect must return the existing result without repeating authorization or propose.');
  const resultFile = path.join(value.root, 'taskspaces', '.broker', 'conversation-task-preparation',
    issue.taskId, origin.executionId, 'result.json');
  const executionFile = path.join(value.root, 'taskspaces', '.broker', 'executions', `${issue.taskId}.json`);
  const saved = await Promise.all([resultFile, executionFile].map((file) => readFile(file)));
  assert.deepEqual(await execute(inspect), prepared);
  assert.deepEqual(await Promise.all([resultFile, executionFile].map((file) => readFile(file))), saved);
  for (const [key, different] of [['rpcId', 'rpc-other'], ['dshSessionId', 'session-other'],
    ['actorUserId', '33333333-3333-4333-8333-333333333333'], ['taskId', 'task-other'],
    ['conversationId', 'conversation-other']]) {
    await assert.rejects(execute({ ...inspect, lookup: { ...lookup, [key]: different } }),
      { code: 'CONVERSATION_TASK_REQUEST_CHANGED' });
  }
  await assert.rejects(execute({ ...inspect, expectedGeneration: origin.generation + 1 }),
    { code: 'CONVERSATION_TASK_PREPARATION_CHANGED' });
  await assert.rejects(execute({ ...propose, proposal: { ...propose.proposal, goal: '另一项页面修改。' } }),
    { code: 'CONVERSATION_TASK_PREPARATION_CHANGED' });
  source = { head: HEAD, fingerprint: 'd'.repeat(64) };
  await assert.rejects(execute(inspect), { code: 'CONVERSATION_TASK_SOURCE_CHANGED' });
  source = { head: HEAD, fingerprint: FINGERPRINT };
  const changedResult = JSON.parse(saved[0]);
  changedResult.context.executionId = randomUUID();
  await writeFile(resultFile, JSON.stringify(changedResult));
  await assert.rejects(execute(inspect), { code: 'CONVERSATION_TASK_PREPARATION_CHANGED' });
  await writeFile(resultFile, saved[0]);
  await assert.rejects(execute(inspect, { inspectSource: async () => {
    await prepareProtectedExecutionContext({ projectRoot: value.root, projectSlug: issue.projectSlug,
      taskMetadata, request: nativeRequest('rpc-new-turn'), policyPath: POLICY_PATH, now: START.getTime() });
    return source;
  } }), { code: 'CONVERSATION_TASK_EXECUTION_CHANGED' });
  await assert.rejects(execute(inspect), { code: 'CONVERSATION_TASK_REQUEST_CHANGED' });
  assert.equal(authorizeCalls, 1);
});

test('an unclassified Chinese creation request prepares an exact page, menu migration, and test grant', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const issue = issueInput('仅在导航栏创建安保模块即可，放至领导引领力后面');

  assert.deepEqual(await value.service.issueExecutionAuthority(issue), {
    authority: null,
    trustedPolicyInput: null,
    idempotent: false,
  });
  const storedRequest = JSON.parse(await readFile(path.join(
    value.root,
    'state/conversation-task-requests/task-001.json',
  ), 'utf8'));
  assert.equal(storedRequest.writableEligible, true);
  assert.equal(storedRequest.authorizedActionCeiling, 'workspace-write');
  assert.ok(!Object.hasOwn(storedRequest, 'promptText'));
  assert.ok(!JSON.stringify(storedRequest).includes(issue.promptText));

  const inspected = await value.service.prepareConversationTask(prepareInput(issue));
  assert.equal(inspected.status, 'inspected');
  assert.equal(inspected.currentTask, null);
  assert.deepEqual(inspected.availableScopes, writerScopes);

  const prepared = await value.service.prepareConversationTask(prepareInput(issue, 'propose'));
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.currentTask.goal, taskProposal().goal);
  assert.deepEqual(prepared.authorityResult.trustedPolicyInput.taskAuthority.ownedPaths,
    [taskPaths.page, taskPaths.test, taskPaths.migration].sort());
  assert.equal(prepared.authorityResult.trustedPolicyInput.profile, 'production-controller');
  assert.equal(prepared.authorityResult.trustedPolicyInput.taskAuthority.actionCeiling, 'workspace-write');
  assert.ok(prepared.authorityResult.trustedPolicyInput.taskAuthority.taskProfiles.includes('frontend-admin'));
  assert.ok(prepared.authorityResult.trustedPolicyInput.taskAuthority.taskProfiles.includes('migration'));
  assert.ok(prepared.authorityResult.trustedPolicyInput.taskAuthority.taskProfiles.includes('database'));
  assert.ok(prepared.authorityResult.trustedPolicyInput.taskAuthority.taskProfiles.includes('backend'));
});

test('recorded backend-only proposal binds backend checks through preparation and continuation despite page context', async (t) => {
  const sample = JSON.parse(await readFile(new URL('./fixtures/forge-backend-page-context-proposal.json', import.meta.url), 'utf8'));
  const value = await fixture({ scopes: sample.writerScopes });
  t.after(() => value.cleanup());
  const issue = issueInput(sample.promptText);
  await value.service.issueExecutionAuthority(issue);
  const prepared = await value.service.prepareConversationTask(prepareInput(issue, 'propose', { proposal: sample.proposal }));
  // The recorded prompt first asks for clarification; preserve that boundary.
  assert.equal(prepared.status, 'needs-confirmation');
  assert.deepEqual(prepared.currentTask.ownedPaths, [...sample.proposal.ownedPaths].sort());
  assert.deepEqual(prepared.currentTask.taskProfiles, ['database', 'backend']);
  const continued = await value.service.issueExecutionAuthority(issueInput('确认执行', { rpcId: 'rpc-002' }));
  assert.deepEqual(continued.authority.taskProfiles, ['database', 'backend']);
  assert.deepEqual(continued.authority.ownedPaths, [...sample.proposal.ownedPaths].sort());
  const grant = JSON.parse(await readFile(path.join(value.root, 'state/production-task-grants/task-001.json'), 'utf8'));
  assert.deepEqual(grant.taskContract.requiredVerificationProfiles, ['governance', 'backend-module-test']);
});

test('frontend do-not-touch proposal keeps issuer and execution requirements free of unrelated backend checks', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const issue = issueInput('本轮请直接完成前端工具函数和相关单元测试。只改工具函数及其测试，不接页面、不动后端和数据库，不提交、不发版。');
  await value.service.issueExecutionAuthority(issue);
  const proposal = {
    goal: '实现事故查询关键词归一化纯函数及其单元测试',
    ownedPaths: [
      'forge-admin-ui/src/views/accident/incident-query-utils.js',
      'forge-admin-ui/src/views/accident/__tests__/incident-query-utils.spec.js',
    ],
    taskProfiles: ['frontend-admin'],
    references: taskProposal().references,
  };
  const prepared = await value.service.prepareConversationTask(prepareInput(issue, 'propose', { proposal }));
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.currentTask.taskProfiles, ['frontend-admin']);
  assert.deepEqual(prepared.authorityResult.trustedPolicyInput.taskAuthority.taskProfiles, ['frontend-admin']);
  const grant = await value.service.readProductionTaskGrant('task-001');
  assert.deepEqual(grant.taskContract.taskProfiles, ['frontend-admin']);
  // This fixture retains legacy frontend capabilities; the negation fix must
  // remove unrelated backend work without changing those capability settings.
  assert.ok(!grant.taskContract.requiredVerificationProfiles.includes('backend-module-test'));
  assert.ok(grant.taskContract.requiredVerificationProfiles.includes('frontend-admin-lint'));
  assert.ok(grant.taskContract.requiredVerificationProfiles.includes('frontend-admin-test'));
  assert.ok(!grant.taskContract.requiredObligations.includes('transaction-index-and-query-review'));
});

test('legacy automatic writer preparation respects an explicit backend-only boundary despite page context', async (t) => {
  const value = await fixture({ enabled: false });
  t.after(() => value.cleanup());
  const input = issueInput('修复页面调用的后端逻辑，本次仅修改后端。', { conversationTaskPreparationSupported: false });
  const issued = await value.service.issueExecutionAuthority(input);
  assert.deepEqual(issued.authority.taskProfiles, ['backend']);
  assert.deepEqual(issued.authority.ownedPaths, writerScopes.find((scope) => scope.taskProfile === 'backend').ownedPaths);
  const grant = await value.service.readProductionTaskGrant(input.taskId);
  assert.deepEqual(grant.taskContract.taskProfiles, ['backend']);
  assert.deepEqual(grant.taskContract.requiredVerificationProfiles, ['governance', 'backend-module-test']);
});

test('feature-on continuation bootstraps readonly preparation without a grant or from an exact legacy blank scope', async (t) => {
  const [empty, legacy, permission] = await Promise.all([fixture(), fixture(), fixture()]);
  t.after(async () => Promise.all([empty.cleanup(), legacy.cleanup(), permission.cleanup()]));

  const promptText = '继续';
  const rpcId = 'rpc-bootstrap-continuation';
  const issue = issueInput(promptText, { rpcId });
  assert.deepEqual(await empty.service.issueExecutionAuthority(issue), {
    authority: null,
    trustedPolicyInput: null,
    idempotent: false,
  });
  const storedRequest = JSON.parse(await readFile(path.join(
    empty.root,
    'state/conversation-task-requests/task-001.json',
  ), 'utf8'));
  assert.equal(storedRequest.rpcId, rpcId);
  assert.equal(storedRequest.writableEligible, true);

  const taskMetadata = {
    schemaVersion: 2,
    projectSlug: 'forge-project',
    taskId: 'task-001',
    actorUserId: ACTOR_USER_ID,
    actorId: 'lyl',
    conversationId: 'conversation-001',
    status: 'active',
    accessMode: 'conversation',
  };
  const workspace = path.join(empty.root, 'taskspaces', taskMetadata.taskId, 'workspace');
  const referencePath = 'docs/architecture.md';
  const reference = 'Existing navigation, menu migration, and security module structure.\n';
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await writeFile(path.join(workspace, referencePath), reference);
  const request = {
    ...classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'session.prompt',
      payload: { sessionId: 'session-001', mode: 'queue', content: [{ type: 'text', text: promptText }] },
    })), 'session.prompt'),
    actorUserId: ACTOR_USER_ID,
    actorUsername: 'lyl',
    conversationId: 'conversation-001',
    requestId: 'request-bootstrap-continuation',
  };
  const readonly = await prepareProtectedExecutionContext({
    projectRoot: empty.root,
    projectSlug: taskMetadata.projectSlug,
    taskMetadata,
    request,
    policyPath: POLICY_PATH,
    now: START.getTime(),
  });
  assert.equal(readonly.authorityClass, 'production-read-only');
  assert.equal(readonly.actionCeiling, 'read-only');
  assert.deepEqual(readonly.ownedPaths, []);

  const lookup = Object.fromEntries([
    'projectSlug', 'taskId', 'conversationId', 'actorUserId', 'dshSessionId', 'rpcId', 'textDigest',
  ].map((key) => [key, readonly[key]]));
  const proposal = taskProposal({
    references: [{ path: referencePath, sha256: createHash('sha256').update(reference).digest('hex') }],
  });
  const prepared = await prepareConversationTaskExecution({
    projectRoot: empty.root,
    taskMetadata,
    workspace,
    request: validateTaskspaceAction({
      action: 'prepare-task',
      operation: 'propose',
      lookup,
      expectedExecutionId: readonly.executionId,
      expectedGeneration: readonly.generation,
      promptText,
      proposal,
    }),
    inspectSource: async () => ({ head: HEAD, fingerprint: FINGERPRINT }),
    authorizeProposal: (input) => empty.service.prepareConversationTask(input),
    policyPath: POLICY_PATH,
    now: START.getTime(),
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.context.authorityClass, 'production-task-writer');
  assert.equal(prepared.context.generation, readonly.generation + 1);
  assert.notEqual(prepared.context.executionId, readonly.executionId);
  assert.deepEqual(prepared.context.ownedPaths, [...proposal.ownedPaths].sort());
  const acceptanceRecord = JSON.parse(await readFile(path.join(
    empty.root,
    'state/tasks/task-001.json',
  ), 'utf8'));
  assert.equal(acceptanceRecord.taskContract.contractId, prepared.context.contractId);
  assert.equal(acceptanceRecord.acceptanceContract.candidate.authorId, ACTOR_USER_ID);
  assert.deepEqual(acceptanceRecord.acceptanceContract.candidate.source, {
    head: HEAD,
    fingerprint: FINGERPRINT,
  });

  const admittedFingerprint = 'e'.repeat(64);
  const bound = await empty.service.bindCandidate({
    taskId: taskMetadata.taskId,
    contractId: prepared.context.contractId,
    candidateBinding: candidateBinding(prepared.context),
    admissionReceipt: hostAdmissionReceipt({ fingerprint: admittedFingerprint }),
  });
  assert.equal(bound.acceptanceContract.contractId, prepared.context.contractId);
  assert.equal(bound.acceptanceContract.candidate.source.fingerprint, admittedFingerprint);

  const oldQuestion = issueInput('安保模块当前放在哪里', {
    rpcId: 'rpc-legacy-readonly',
    conversationTaskPreparationSupported: false,
  });
  assert.equal((await legacy.service.issueExecutionAuthority(oldQuestion)).authority, null);
  const oldScope = JSON.parse(await readFile(path.join(
    legacy.root,
    'state/conversation-task-scopes/task-001.json',
  ), 'utf8'));
  assert.equal(oldScope.implementationRequested, false);
  assert.equal(oldScope.grantId, null);
  assert.deepEqual(oldScope.ownedPaths, []);
  assert.deepEqual(oldScope.taskProfiles, []);
  assert.equal(Object.hasOwn(oldScope, 'goal'), false);
  const legacyContinuation = issueInput('继续', { rpcId: 'rpc-legacy-continuation' });
  assert.equal((await legacy.service.issueExecutionAuthority(legacyContinuation)).authority, null);
  await expectCode('CONVERSATION_WRITE_SCOPE_REQUIRED', legacy.service.issueExecutionAuthority(issueInput('继续', {
    rpcId: 'rpc-legacy-source-mismatch',
    source: { head: 'd'.repeat(40), fingerprint: FINGERPRINT },
  })));

  const permissionContinuation = issueInput('执行权限', { rpcId: 'rpc-permission-bootstrap' });
  assert.equal((await permission.service.issueExecutionAuthority(permissionContinuation)).authority, null);
  const permissionRequest = JSON.parse(await readFile(path.join(
    permission.root,
    'state/conversation-task-requests/task-001.json',
  ), 'utf8'));
  assert.equal(permissionRequest.rpcId, permissionContinuation.rpcId);
  assert.equal(permissionRequest.writableEligible, false);
});

test('readonly and missing server capability cannot produce a prepared writer', async (t) => {
  const readonly = await fixture();
  const denied = await fixture();
  t.after(async () => { await readonly.cleanup(); await denied.cleanup(); });

  const readonlyIssue = issueInput('只读查看安保模块现状，不要修改', { rpcId: 'rpc-readonly' });
  await readonly.service.issueExecutionAuthority(readonlyIssue);
  assert.equal((await readonly.service.prepareConversationTask(prepareInput(readonlyIssue))).status, 'inspected');
  await expectCode(
    'CONVERSATION_TASK_READ_ONLY',
    readonly.service.prepareConversationTask(prepareInput(readonlyIssue, 'propose')),
  );

  const noCapability = issueInput('创建安保模块', {
    rpcId: 'rpc-no-capability',
    workspaceWriteAuthorized: false,
    authorizedActionCeiling: undefined,
  });
  delete noCapability.authorizedActionCeiling;
  await denied.service.issueExecutionAuthority(noCapability);
  await expectCode(
    'CONVERSATION_TASK_REQUEST_REQUIRED',
    denied.service.prepareConversationTask(prepareInput(noCapability)),
  );
});

test('semantic policy reaches prepared grant, authority, and unchanged continuation through trusted scope union', async (t) => {
  const resource = { type: 'table', key: 'security' };
  const semanticScopes = [
    { ownedPaths: [taskPaths.page], resources: [resource] },
    { ownedPaths: ['forge-server/db/migration'], resources: [resource] },
    { ownedPaths: ['forge-admin-ui/src/views/security-other'], resources: [{ type: 'table', key: 'unrelated' }] },
  ];
  const value = await fixture({ semanticScopes }); t.after(() => value.cleanup());
  const original = issueInput('创建安保模块', { rpcId: 'rpc-semantic-original' });
  await value.service.issueExecutionAuthority(original);
  const prepared = await value.service.prepareConversationTask(prepareInput(original, 'propose'));
  assert.equal(prepared.status, 'prepared');
  const grant = await value.service.readProductionTaskGrant('task-001');
  assert.deepEqual(grant.taskContract.semanticResources, [resource]);
  const record = await value.service.readRecord('task-001');
  assert.equal(record.taskContract.contractId, grant.taskContract.contractId);
  assert.deepEqual(record.taskContract.semanticResources, [resource]);
  const continued = await value.service.issueExecutionAuthority(issueInput('继续当前任务', {
    rpcId: 'rpc-semantic-continue', conversationContractContinuationSupported: true,
  }));
  assert.ok(continued.authority);
  const next = await value.service.readProductionTaskGrant('task-001');
  assert.deepEqual(next.taskContract.semanticResources, [resource]);
  assert.equal(next.taskContract.contractId, grant.taskContract.contractId);
});

test('semantic policy parent scopes include declared descendants while absent and empty policies keep legacy digest', async (t) => {
  const resource = { type: 'ui-component', key: 'admin/SecurityCard' };
  const value = await fixture({ semanticScopes: [{ ownedPaths: [taskPaths.page], resources: [resource] }] });
  t.after(() => value.cleanup());
  const issue = issueInput('修改前端页面', { rpcId: 'rpc-semantic-parent', conversationTaskPreparationSupported: false });
  const issued = await value.service.issueExecutionAuthority(issue);
  assert.ok(issued.authority);
  assert.deepEqual(issued.trustedPolicyInput.taskAuthority.contract.semanticResources, [resource]);
  assert.deepEqual((await value.service.readProductionTaskGrant('task-001')).taskContract.semanticResources, [resource]);
  for (const semanticScopes of [undefined, []]) {
    const legacy = await fixture({ semanticScopes }); t.after(() => legacy.cleanup());
    await legacy.service.issueExecutionAuthority(issueInput('创建安保模块'));
    const request = JSON.parse(await readFile(path.join(legacy.root, 'state/conversation-task-requests/task-001.json'), 'utf8'));
    assert.equal(request.writerScopesDigest, canonicalSha256(writerScopes));
    await legacy.service.prepareConversationTask(prepareInput(issueInput('创建安保模块'), 'propose'));
    assert.equal(Object.hasOwn((await legacy.service.readProductionTaskGrant('task-001')).taskContract, 'semanticResources'), false);
  }
});

test('semantic policy changes revoke stale proposals renewal and claim instead of borrowing old claims', async (t) => {
  const initialScopes = [{ ownedPaths: [taskPaths.page], resources: [{ type: 'table', key: 'security' }] }];
  const value = await fixture({ semanticScopes: initialScopes }); t.after(() => value.cleanup());
  const issue = issueInput('创建安保模块');
  await value.service.issueExecutionAuthority(issue);
  await value.service.prepareConversationTask(prepareInput(issue, 'propose'));
  const grant = await value.service.readProductionTaskGrant('task-001');
  for (const semanticScopes of [[], [{ ...initialScopes[0], resources: [{ type: 'table', key: 'other' }] }]]) {
    value.service.config.conversationSemanticResourceScopes = semanticScopes;
    await expectCode('CONVERSATION_TASK_POLICY_CHANGED', value.service.prepareConversationTask(prepareInput(issue)));
    const renewal = Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'rpcId', 'promptTextDigest', 'source'].map(key => [key, issue[key]]));
    await expectCode('CONVERSATION_EXECUTION_RENEWAL_DENIED', value.service.renewConversationExecution({ ...renewal, contractId: grant.taskContract.contractId }));
    const { workspaceWriteAuthorized, conversationTaskPreparationSupported, authorizedActionCeiling, ...claim } = issue;
    await expectCode('EXECUTION_AUTHORITY_CONTRACT_MISMATCH', value.service.issueExecutionAuthority(claim));
  }
});

test('semantic policy rejects model resource injection and noncanonical or unauthorized config mappings', async (t) => {
  const value = await fixture(); t.after(() => value.cleanup());
  const issue = issueInput('创建安保模块'); await value.service.issueExecutionAuthority(issue);
  await assert.rejects(value.service.prepareConversationTask(prepareInput(issue, 'propose', {
    proposal: taskProposal({ semanticResources: [{ type: 'table', key: 'security' }] }),
  })));
  const policies = [
    [{ ownedPaths: ['outside/file.txt'], resources: [{ type: 'table', key: 'security' }] }],
    [{ ownedPaths: [taskPaths.page], resources: [{ type: 'table', key: 'SECURITY' }] }],
    [{ ownedPaths: [taskPaths.page], resources: [] }],
    [{ ownedPaths: [taskPaths.page], resources: [{ type: 'table', key: 'security' }], extra: true }],
  ];
  for (const conversationSemanticResourceScopes of policies) {
    assert.throws(() => new ProtectedAcceptanceService({ config: { ...value.service.config, conversationSemanticResourceScopes },
      platformKeyPem: privatePem(), governanceKeyPem: privatePem(), verificationKeyPem: privatePem(),
      semanticKeyPem: privatePem(), verdictKeyPem: privatePem(), clock: () => START }),
    error => error.code === 'ACCEPTANCE_CONFIG_INVALID' || error.code === 'ACCEPTANCE_SCHEMA_INVALID');
  }
});

test('same-request prepared scope remains inspectable after an owned write without refreshing authority', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const page = path.join(value.root, 'workspace', taskPaths.page);
  await mkdir(path.dirname(page), { recursive: true });
  await writeFile(page, '<template>Existing page</template>\n');
  const source = async () => ({ head: HEAD, fingerprint: createHash('sha256').update(await readFile(page)).digest('hex') });
  const issue = issueInput('修复安保模块页面并验证。', { source: await source() });
  await value.service.issueExecutionAuthority(issue);
  const prepared = await value.service.prepareConversationTask(prepareInput(issue, 'propose', {
    proposal: taskProposal({ ownedPaths: [taskPaths.page] }),
  }));
  const records = ['conversation-task-requests', 'conversation-task-scopes'].map((directory) =>
    path.join(value.root, 'state', directory, `${issue.taskId}.json`));
  records.push(value.service.recordFile(issue.taskId));
  const saved = await Promise.all(records.map((file) => readFile(file)));
  const grant = await value.service.readProductionTaskGrant(issue.taskId);

  await writeFile(page, '<template>Updated page</template>\n');
  const changedSource = await source();
  assert.notEqual(changedSource.fingerprint, issue.source.fingerprint);
  const inspected = await value.service.prepareConversationTask(prepareInput(issue, 'inspect', { source: changedSource }));
  assert.deepEqual(validatePrepareTaskResult(inspected), inspected);
  assert.equal(inspected.status, 'inspected');
  assert.deepEqual(inspected.currentTask, prepared.currentTask);
  assert.match(inspected.summary, /工作区源码已变化/u);
  assert.match(inspected.summary, /未刷新执行授权/u);
  assert.deepEqual(Object.keys(inspected).sort(), ['availableScopes', 'currentTask', 'status', 'summary']);
  assert.deepEqual(await Promise.all(records.map((file) => readFile(file))), saved);
  assert.deepEqual(await value.service.readProductionTaskGrant(issue.taskId), grant);
  assert.equal(grant.workspaceFingerprint, issue.source.fingerprint);

  await expectCode('CONVERSATION_TASK_SOURCE_CHANGED', value.service.prepareConversationTask(
    prepareInput(issue, 'propose', { source: changedSource, proposal: taskProposal({ ownedPaths: [taskPaths.page] }) }),
  ));
  await expectCode('CONVERSATION_TASK_SOURCE_CHANGED', value.service.prepareConversationTask(
    prepareInput(issue, 'inspect', { source: { ...changedSource, head: 'd'.repeat(40) } }),
  ));
  await expectCode('CONVERSATION_TASK_REQUEST_MISMATCH', value.service.prepareConversationTask(
    prepareInput(issue, 'inspect', { source: changedSource, rpcId: 'rpc-other' }),
  ));
  assert.deepEqual(await Promise.all(records.map((file) => readFile(file))), saved);
  assert.deepEqual(await value.service.readProductionTaskGrant(issue.taskId), grant);
});

test('changed-source inspect cannot use an unprepared or previous-request scope', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const issue = issueInput('修复安保模块页面并验证。');
  const changedSource = { head: HEAD, fingerprint: 'd'.repeat(64) };
  await value.service.issueExecutionAuthority(issue);
  await expectCode('CONVERSATION_TASK_SOURCE_CHANGED', value.service.prepareConversationTask(
    prepareInput(issue, 'inspect', { source: changedSource }),
  ));
  await value.service.prepareConversationTask(prepareInput(issue, 'propose'));
  const next = issueInput('继续修复安保模块页面并验证。', { rpcId: 'rpc-next' });
  await value.service.issueExecutionAuthority(next);
  await expectCode('CONVERSATION_TASK_SOURCE_CHANGED', value.service.prepareConversationTask(
    prepareInput(next, 'inspect', { source: changedSource }),
  ));
});

test('stale source, writer policy, RPC, and user identity are rejected against server-owned eligibility', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const issue = issueInput('创建安保模块');
  await value.service.issueExecutionAuthority(issue);

  await expectCode('CONVERSATION_TASK_SOURCE_CHANGED', value.service.prepareConversationTask(
    prepareInput(issue, 'inspect', { source: { head: 'd'.repeat(40), fingerprint: FINGERPRINT } }),
  ));
  await expectCode('CONVERSATION_TASK_REQUEST_MISMATCH', value.service.prepareConversationTask(
    prepareInput(issue, 'inspect', { rpcId: 'rpc-other' }),
  ));
  await expectCode('CONVERSATION_TASK_REQUEST_MISMATCH', value.service.prepareConversationTask(
    prepareInput(issue, 'inspect', { actorUserId: '33333333-3333-4333-8333-333333333333' }),
  ));

  value.service.config.conversationWriterScopes[0].ownedPaths = ['forge-admin-ui/src/views/other'];
  await expectCode('CONVERSATION_TASK_POLICY_CHANGED', value.service.prepareConversationTask(
    prepareInput(issue),
  ));
});

test('expired eligibility and a different proposal on the same RPC fail closed', async (t) => {
  const expired = await fixture();
  const conflict = await fixture();
  t.after(async () => { await expired.cleanup(); await conflict.cleanup(); });
  const expiredIssue = issueInput('创建安保模块', { rpcId: 'rpc-expired' });
  await expired.service.issueExecutionAuthority(expiredIssue);
  expired.setNow(START.getTime() + 901_000);
  await expectCode('CONVERSATION_TASK_REQUEST_EXPIRED', expired.service.prepareConversationTask(
    prepareInput(expiredIssue),
  ));

  const issue = issueInput('创建安保模块', { rpcId: 'rpc-conflict' });
  await conflict.service.issueExecutionAuthority(issue);
  await conflict.service.prepareConversationTask(prepareInput(issue, 'propose'));
  await expectCode('CONVERSATION_TASK_PROPOSAL_CONFLICT', conflict.service.prepareConversationTask(
    prepareInput(issue, 'propose', { proposal: taskProposal({ goal: '改成其他安保目标。' }) }),
  ));
});

test('same RPC, proposal digest, and source return the same claimed authority idempotently', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const issue = issueInput('创建安保模块', { rpcId: 'rpc-idempotent' });
  await value.service.issueExecutionAuthority(issue);
  const request = prepareInput(issue, 'propose');
  const first = await value.service.prepareConversationTask(request);
  const second = await value.service.prepareConversationTask(request);

  assert.equal(first.authorityResult.idempotent, false);
  assert.equal(second.authorityResult.idempotent, true);
  assert.equal(second.proposalDigest, first.proposalDigest);
  assert.equal(second.authorityResult.authority.authorityId,
    first.authorityResult.authority.authorityId);
});

test('update intent and ordinary verification/release continuations retain the prepared scope and respect permissions', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const original = issueInput('更新安保模块页面标题', { rpcId: 'rpc-update' });
  await value.service.issueExecutionAuthority(original);
  const prepared = await value.service.prepareConversationTask(prepareInput(original, 'propose'));
  assert.equal(prepared.status, 'prepared');
  const prompts = ['继续验证', '重新验证当前改动', '继续测试本次任务', '确认发布', '继续发布', '前端发版'];
  for (const [index, promptText] of prompts.entries()) {
    assert.equal(isForgeConversationTaskContinuation(promptText), true, promptText);
    const input = issueInput(promptText, { rpcId: `rpc-common-${index}`, authorizedActionCeiling: 'release' });
    const continued = await value.service.issueExecutionAuthority(input);
    assert.ok(continued.authority, promptText);
    assert.deepEqual(continued.trustedPolicyInput.taskAuthority.ownedPaths, prepared.currentTask.ownedPaths);
    assert.equal(continued.trustedPolicyInput.taskAuthority.actionCeiling, index < 3 ? 'workspace-write' : 'release');
    assert.equal((await value.service.prepareConversationTask(prepareInput(input))).currentTask.goal, prepared.currentTask.goal);
  }
  await expectCode('CONVERSATION_ACTION_NOT_AUTHORIZED', value.service.issueExecutionAuthority(issueInput('确认发布', {
    rpcId: 'rpc-common-denied', authorizedActionCeiling: 'workspace-write',
  })));
  for (const text of ['确认发布？', '不要发布', '日志显示：“确认发布”', '继续发布新模块', '继续验证另外一个页面']) {
    assert.equal(isForgeConversationTaskContinuation(text), false, text);
  }
});

test('an explicit modification and release request keeps authenticated release authority through task preparation', async (t) => {
  const prompt = '从刚才被拒绝的验证步骤继续，完成已经确认的单人调查委任书修改和发版。保留已完成的改动和仍有效的检查结果。';
  for (const [index, text] of [prompt, prompt.replace('修改和发版', '修改以及发布'), prompt.replace('修改和发版', '修改、发布')].entries()) {
    const value = await fixture();
    t.after(() => value.cleanup());
    const input = issueInput(text, { rpcId: `rpc-modification-release-${index}`, authorizedActionCeiling: 'release' });
    await value.service.issueExecutionAuthority(input);
    const prepared = await value.service.prepareConversationTask(prepareInput(input, 'propose'));
    assert.equal(prepared.authorityResult.authority.actionCeiling, 'release', text);
    assert.equal(prepared.authorityResult.trustedPolicyInput.taskAuthority.actionCeiling, 'release', text);
  }
  const denied = await fixture();
  t.after(() => denied.cleanup());
  const input = issueInput(prompt, { rpcId: 'rpc-modification-release-account-denied', authorizedActionCeiling: 'workspace-write' });
  await expectCode('CONVERSATION_ACTION_NOT_AUTHORIZED', denied.service.issueExecutionAuthority(input));
});

test('coordinated release wording keeps quotations questions restrictions and UI nouns unprivileged', async (t) => {
  for (const [index, text] of [
    '修改页面名称和发布状态字段。',
    '完成页面修改和发版按钮调整。',
    '文档写着：“完成已经确认的单人调查委任书修改和发版”。修改页面标题。',
    '完成已经确认的单人调查委任书修改和发版？',
    '完成已经确认的单人调查委任书修改和发版。先不要发布。',
  ].entries()) {
    const value = await fixture();
    t.after(() => value.cleanup());
    const input = issueInput(text, { rpcId: `rpc-release-wording-boundary-${index}`, authorizedActionCeiling: 'release' });
    const issued = await value.service.issueExecutionAuthority(input);
    assert.notEqual(issued.authority?.actionCeiling, 'release', text);
    if (issued.request?.writableEligible !== false) {
      const prepared = await value.service.prepareConversationTask(prepareInput(input, 'propose'));
      assert.notEqual(prepared.authorityResult?.authority?.actionCeiling, 'release', text);
    }
  }
});

test('coordinated execute and release continuation retains the current task and release authority', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const original = issueInput('更新安保模块页面标题', { rpcId: 'rpc-coordinated-original' });
  await value.service.issueExecutionAuthority(original);
  const prepared = await value.service.prepareConversationTask(prepareInput(original, 'propose'));
  for (const [index, prompt] of [
    '继续执行和发布当前已授权任务。沿用原任务范围，从已完成的受控提交接着做，不重复修改或提交这两文件。',
    '继续执行并发布当前已授权的任务。请领取已有测试结果，不重复测试。',
  ].entries()) {
    assert.equal(isForgeConversationTaskContinuation(prompt), true, prompt);
    const input = issueInput(prompt, { rpcId: `rpc-coordinated-${index}`, authorizedActionCeiling: 'release' });
    const result = await value.service.issueExecutionAuthority(input);
    assert.equal(result.trustedPolicyInput.taskAuthority.actionCeiling, 'release');
    assert.deepEqual(result.trustedPolicyInput.taskAuthority.ownedPaths, prepared.currentTask.ownedPaths);
    const inspected = await value.service.prepareConversationTask(prepareInput(input));
    assert.equal(inspected.currentTask.goal, prepared.currentTask.goal);
  }
  await expectCode('CONVERSATION_ACTION_NOT_AUTHORIZED', value.service.issueExecutionAuthority(issueInput(
    '继续执行和发布当前已授权任务。', { rpcId: 'rpc-coordinated-denied', authorizedActionCeiling: 'workspace-write' },
  )));
  for (const prompt of [
    '继续执行和发布当前已授权任务？',
    '继续执行和发布当前已授权任务。暂不发布，只做检查。',
    '日志显示：“继续执行和发布当前已授权任务”。',
    '继续执行和发布当前已授权任务。另外新增一个页面。',
  ]) assert.equal(isForgeConversationTaskContinuation(prompt), false, prompt);
});

test('confirmation after an unprepared new request cannot inherit the older release task', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const oldRequest = issueInput('修改前端标题', { rpcId: 'old-title-change', authorizedActionCeiling: 'release' });
  await value.service.issueExecutionAuthority(oldRequest);
  const old = await value.service.prepareConversationTask(prepareInput(oldRequest, 'propose', {
    proposal: taskProposal({ goal: '修改前端页面标题', ownedPaths: [taskPaths.page], taskProfiles: ['frontend-admin'] }),
  }));
  assert.equal(old.authorityResult.authority.actionCeiling, 'workspace-write');
  const oldRelease = await value.service.issueExecutionAuthority(issueInput('确认发布', {
    rpcId: 'old-title-release', authorizedActionCeiling: 'release',
  }));
  assert.equal(oldRelease.authority.actionCeiling, 'release');
  const next = issueInput('单人调查也需要委任书，内容参考截图，样式布局参考团队调查委任书', {
    rpcId: 'new-appointment-request', authorizedActionCeiling: 'release',
  });
  assert.equal((await value.service.issueExecutionAuthority(next)).authority, null);
  const confirm = issueInput('执行', { rpcId: 'confirm-new-appointment', authorizedActionCeiling: 'release' });
  const first = await value.service.issueExecutionAuthority(confirm);
  assert.equal(first.authority, null, 'do not restore the old release grant before preparing the new scope');
  assert.equal((await value.service.issueExecutionAuthority(confirm)).authority, null, 'same RPC must stay consistent');
  const current = await value.service.prepareConversationTask(prepareInput(confirm, 'propose', {
    proposal: taskProposal({ goal: '单人调查增加委任书并同步前后端测试',
      ownedPaths: [taskPaths.page, taskPaths.test], taskProfiles: ['frontend-admin', 'backend'] }),
  }));
  assert.equal(current.status, 'prepared');
  assert.equal(current.authorityResult.authority.actionCeiling, 'workspace-write');
  assert.deepEqual(current.currentTask.ownedPaths, [taskPaths.page, taskPaths.test].sort());
  const continued = await value.service.issueExecutionAuthority(issueInput('继续', {
    rpcId: 'continue-new-appointment', authorizedActionCeiling: 'release',
  }));
  assert.equal(continued.authority.actionCeiling, 'workspace-write');
  assert.deepEqual(continued.trustedPolicyInput.taskAuthority.ownedPaths, current.currentTask.ownedPaths);

  const recordedScopeRequest = `请继续修改当前任务。本轮明确修复消防办理人查询的组织岗位缺口，并撤回上一轮会话角色兜底；不要发布当前兜底候选。

当前实际证据是FireManagementMapper.xml第86行selectRoleUsers只查sys_user_role，但底座组织岗位通过sys_user_org_role表达。平台runtime identities已按org1写入实际组织岗位关联并真实登录；post17同已发布镜像运行时仍无法解析签字用户77。上一轮Mapper写入被旧ownedPaths拒绝，所以改了Service会话fallback。角色集合与组织集合分开存在不能证明该角色就属于该任务组织，isAdmin直接放行也不能代替对应办理岗位；不能用此方式迁就文件范围限制。

本轮必要且授权的精确文件为：
- forge-server/forge-business/forge-business-core/src/main/resources/mapper/business/FireManagementMapper.xml
- forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/fire/service/FireManagementService.java（撤回刚加入的currentUserHasInspectionRole兜底，保留上轮允许多个合法岗位人员的修复）
- forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/fire/service/FireManagementServiceTest.java（撤回兜底测试，修改直接相关用例）
若需要一个直接验证真实Mapper组织查询的测试类，由你选定一个精确相邻测试路径并在提案写明，不修改其它业务模块。

先用现有prepare_task inspect取得工具实际合同，再propose本轮具体goal/ownedPaths/taskProfiles/references，获得实际授权后修改。inspect本身不会扩路径；若提案被旧scope冲突拒绝，保存完整错误、当前scope和必要文件，然后停止，不再绕到其它文件实现替代方案，由平台侧解决该直接阻塞。不得降低权限隔离或手工制造上下文授权。

由你依据真实底座角色模型实现组织岗位与租户岗位的正确查询，维护租户、角色组织绑定、有效用户/岗位及组织范围。覆盖当前合法组织岗位、角色仅在别的组织时拒绝、原多成员合法处理；只做足以验证此根因的最小直接测试。上一轮job b2f85871-3680-4808-9bec-a6f80de54904可能仍在后台，只收其结果为旧候选记录，不冒充本轮新修复通过。不要重跑八阶段、88或已通过其它业务。此轮完成修复和必要定向测试即可，待真实结果后走原受控集成发布。
`;
  const modulePath = 'forge-server/forge-business/forge-business-core';
  const servicePath = `${modulePath}/src/main/java/com/mdframe/forge/business/core/fire/service/FireManagementService.java`;
  const serviceTestPath = `${modulePath}/src/test/java/com/mdframe/forge/business/core/fire/service/FireManagementServiceTest.java`;
  const mapperPath = `${modulePath}/src/main/resources/mapper/business/FireManagementMapper.xml`;
  const mapperTestPath = `${modulePath}/src/test/java/com/mdframe/forge/business/core/fire/mapper/FireManagementMapperContractTest.java`;
  const newPaths = [servicePath, serviceTestPath, mapperPath, mapperTestPath].sort();
  for (const [index, text] of [recordedScopeRequest,
    '请继续修改当前任务。请重新准备当前任务的文件范围，修复后端接口并补充直接测试；本轮不要发布。',
  ].entries()) {
    const fresh = await fixture({ scopes: [{ taskProfile: 'backend', ownedPaths: [`${modulePath}/src`] }] });
    t.after(() => fresh.cleanup());
    const original = issueInput('修复后端签字版本检查并补充直接测试。', { rpcId: `old-scope-${index}` });
    await fresh.service.issueExecutionAuthority(original);
    await fresh.service.prepareConversationTask(prepareInput(original, 'propose', {
      proposal: taskProposal({ goal: '修复新建检测记录初始版本为零时的签字校验。',
        ownedPaths: [servicePath, serviceTestPath], taskProfiles: ['backend'] }),
    }));
    await fresh.service.issueExecutionAuthority(issueInput('确认发布', {
      rpcId: `old-scope-release-${index}`, authorizedActionCeiling: 'release',
    }));
    const scopeFile = path.join(fresh.root, 'state/conversation-task-scopes/task-001.json');
    const priorScopeBytes = await readFile(scopeFile, 'utf8');
    const priorGrant = await fresh.service.readProductionTaskGrant('task-001');
    const proposal = taskProposal({ goal: '修复组织岗位办理人查询并撤回会话兜底，补充直接测试。',
      ownedPaths: newPaths, taskProfiles: ['backend'] });

    if (index === 0) {
      const denied = issueInput(text, { rpcId: 'scope-without-write', workspaceWriteAuthorized: false });
      delete denied.authorizedActionCeiling;
      assert.equal((await fresh.service.issueExecutionAuthority(denied)).authority, null);
      await expectCode('CONVERSATION_TASK_REQUEST_MISMATCH', fresh.service.prepareConversationTask(
        prepareInput(denied, 'propose', { proposal })));
      const readOnly = issueInput(`本轮只读分析，不修改代码。\n${text}`, { rpcId: 'scope-read-only' });
      assert.equal((await fresh.service.issueExecutionAuthority(readOnly)).authority, null);
      await expectCode('CONVERSATION_TASK_READ_ONLY', fresh.service.prepareConversationTask(
        prepareInput(readOnly, 'propose', { proposal })));
      assert.equal(await readFile(scopeFile, 'utf8'), priorScopeBytes);
      assert.deepEqual(await fresh.service.readProductionTaskGrant('task-001'), priorGrant);
    }

    const request = issueInput(text, { rpcId: `prepare-new-scope-${index}`, authorizedActionCeiling: 'release' });
    assert.equal((await fresh.service.issueExecutionAuthority(request)).authority, null,
      'An explicit new file scope must reach propose without inheriting the old release grant.');
    assert.equal((await fresh.service.issueExecutionAuthority(request)).authority, null);
    assert.equal(await readFile(scopeFile, 'utf8'), priorScopeBytes, 'Keep the old scope and RPC unchanged before propose.');
    assert.deepEqual(await fresh.service.readProductionTaskGrant('task-001'), priorGrant);
    const inspected = await fresh.service.prepareConversationTask(prepareInput(request));
    assert.deepEqual(inspected.currentTask.ownedPaths, [servicePath, serviceTestPath].sort());
    if (index === 0) {
      await expectCode('CONVERSATION_TASK_SCOPE_DENIED', fresh.service.prepareConversationTask(
        prepareInput(request, 'propose', { proposal: { ...proposal,
          ownedPaths: [...newPaths, 'forge-server/other/src/main/java/example/OtherService.java'] } })));
      assert.equal(await readFile(scopeFile, 'utf8'), priorScopeBytes);
      assert.deepEqual(await fresh.service.readProductionTaskGrant('task-001'), priorGrant);
    }
    const result = await fresh.service.prepareConversationTask(prepareInput(request, 'propose', { proposal }));
    assert.equal(result.status, 'prepared');
    assert.equal(result.authorityResult.authority.actionCeiling, 'workspace-write');
    assert.deepEqual(result.currentTask.ownedPaths, newPaths);
    assert.deepEqual(result.authorityResult.authority.ownedPaths, newPaths);
    const preparedScopeBytes = await readFile(scopeFile, 'utf8');
    const preparedGrant = await fresh.service.readProductionTaskGrant('task-001');
    assert.equal(JSON.parse(preparedScopeBytes).rpcId, request.rpcId);
    const repeated = await fresh.service.prepareConversationTask(prepareInput(request, 'propose', { proposal }));
    assert.equal(repeated.authorityResult.authority.authorityId, result.authorityResult.authority.authorityId);
    await expectCode('CONVERSATION_TASK_PROPOSAL_CONFLICT', fresh.service.prepareConversationTask(
      prepareInput(request, 'propose', { proposal: { ...proposal,
        ownedPaths: [...newPaths, `${modulePath}/src/test/java/example/ExtraTest.java`] } })));
    assert.equal(await readFile(scopeFile, 'utf8'), preparedScopeBytes);
    assert.deepEqual(await fresh.service.readProductionTaskGrant('task-001'), preparedGrant);
  }
});

test('desired-behavior questions and quoted screenshots cannot authorize implementation', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  for (const [index, prompt] of [
    '单人调查也需要委任书吗？',
    '是否单人调查也需要委任书',
    '截图文字是“单人调查也需要委任书”',
    '只读分析：单人调查也需要委任书',
  ].entries()) {
    const request = issueInput(prompt, { rpcId: `image-reference-question-${index}` });
    assert.equal((await value.service.issueExecutionAuthority(request)).authority, null);
    const stored = JSON.parse(await readFile(path.join(value.root, 'state/conversation-task-requests/task-001.json'), 'utf8'));
    assert.equal(stored.writableEligible, false, prompt);
  }
});

test('questions retain the task without a grant, while permission wording and continuation reuse its exact scope', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const original = issueInput('创建安保模块', { rpcId: 'rpc-original' });
  await value.service.issueExecutionAuthority(original);
  const prepared = await value.service.prepareConversationTask(prepareInput(original, 'propose'));

  const question = issueInput('怎么查看这个模块的入口？', { rpcId: 'rpc-question' });
  const questionResult = await value.service.issueExecutionAuthority(question);
  assert.equal(questionResult.authority, null);
  const questionInspection = await value.service.prepareConversationTask(prepareInput(question));
  assert.equal(questionInspection.currentTask.goal, prepared.currentTask.goal);
  assert.deepEqual(questionInspection.currentTask.ownedPaths, prepared.currentTask.ownedPaths);

  const permission = issueInput('执行权限', { rpcId: 'rpc-permission' });
  const permissionResult = await value.service.issueExecutionAuthority(permission);
  assert.ok(permissionResult.authority);
  assert.deepEqual(permissionResult.trustedPolicyInput.taskAuthority.ownedPaths,
    prepared.currentTask.ownedPaths);
  const permissionInspection = await value.service.prepareConversationTask(prepareInput(permission));
  assert.equal(permissionInspection.currentTask.goal, prepared.currentTask.goal);

  const continuation = issueInput('继续执行', { rpcId: 'rpc-continue' });
  const continued = await value.service.issueExecutionAuthority(continuation);
  assert.ok(continued.authority);
  assert.deepEqual(continued.trustedPolicyInput.taskAuthority.ownedPaths,
    prepared.currentTask.ownedPaths);
  const inspected = await value.service.prepareConversationTask(prepareInput(continuation));
  assert.equal(inspected.currentTask.goal, prepared.currentTask.goal);
});

test('explicit prior-task continuation with notes retains the existing scope and action ceiling', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const original = issueInput('创建安保模块', { rpcId: 'rpc-noted-original' });
  await value.service.issueExecutionAuthority(original);
  const prepared = await value.service.prepareConversationTask(prepareInput(original, 'propose'));
  await value.service.issueExecutionAuthority(issueInput('确认执行该范围并发布', {
    rpcId: 'rpc-noted-release', authorizedActionCeiling: 'release',
  }));

  const prompts = [
    '确认执行，继续原任务的验证和受控发布。先读取已经完成的构建回执，复用通过结果。',
    '继续当前任务。按此前确认的范围完成剩余检查。',
    '继续这个任务，保留已有结果，不要改代码来刷新准入。',
    '模型出口连接已修复，请继续完成原任务“将领导引领力任务推送到工作台待办并完成验证”。沿用我已授予的提交和受控发布授权，保留原范围、已集成候选和已通过结果。',
    '刚才这一轮在模型连接阶段失败，尚未执行业务工具。当前原工作舱连接已恢复，请继续上一轮已经明确的原任务、范围和提交及受控发布授权：准备本轮任务，复用已通过的治理、后端模块和三文件lint回执，只补前端测试及必要发布。不要重做集成、追加功能或要求重复确认；仍不做浏览器和图像验收。',
    '请继续上一轮已经明确的原任务。我确认继续，并授权本轮提交和受控发布。平台现在先限定本次改动目录/用例再分析影响，请补受影响测试并发布。',
  ];
  for (const [index, promptText] of prompts.entries()) {
    const continued = await value.service.issueExecutionAuthority(issueInput(promptText, {
      rpcId: `rpc-noted-continue-${index}`, authorizedActionCeiling: 'release',
    }));
    assert.ok(continued.authority, promptText);
    assert.equal(continued.trustedPolicyInput.taskAuthority.actionCeiling, 'release');
    assert.deepEqual(continued.trustedPolicyInput.taskAuthority.ownedPaths, prepared.currentTask.ownedPaths);
    assert.deepEqual(continued.trustedPolicyInput.taskAuthority.taskProfiles, prepared.currentTask.taskProfiles);
  }
  const grant = await value.service.readProductionTaskGrant('task-001');
  await expectCode('CONVERSATION_ACTION_NOT_AUTHORIZED', value.service.issueExecutionAuthority(issueInput(
    prompts[0], { rpcId: 'rpc-noted-ceiling-denied', authorizedActionCeiling: 'workspace-write' },
  )));
  await expectCode('CONVERSATION_WRITE_SCOPE_REQUIRED', value.service.issueExecutionAuthority(issueInput(
    prompts[0], { rpcId: 'rpc-noted-identity-denied', authorizedActionCeiling: 'release',
      actorUserId: '22222222-2222-4222-8222-222222222222' },
  )));
  assert.deepEqual(await value.service.readProductionTaskGrant('task-001'), grant);
});

test('prior-task wording cannot hide a question, explicit restriction or new scope', () => {
  for (const prompt of [
    '继续原任务，可以吗？',
    '确认执行。继续原任务，可以吗？',
    '日志显示：“继续原任务。”',
    '继续原任务。只读检查，不要修改代码。',
    '继续原任务。另外新增财务页面。',
    '继续原任务，同时新增财务页面。',
    '继续原任务。先不发布。',
    '继续原任务。先分析方案。',
    '继续原任务。取消任务。',
    '日志显示：“当前原工作舱连接已恢复，请继续原任务。”',
    '模型出口连接已修复，请继续原任务，可以吗？',
    '模型出口连接已修复，请继续原任务。先只分析，不要执行。',
    '模型出口连接已修复，请继续原任务。另外新增财务页面。',
  ]) assert.equal(isForgeConversationTaskContinuation(prompt), false, prompt);
});

test('repair proposal inside an already authorized continuation reuses its current contract without changing scope', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const original = issueInput('创建安保模块', { rpcId: 'rpc-covered-original' });
  await value.service.issueExecutionAuthority(original);
  const prepared = await value.service.prepareConversationTask(prepareInput(original, 'propose'));
  await value.service.issueExecutionAuthority(issueInput('确认执行该范围并发布', {
    rpcId: 'rpc-covered-release', authorizedActionCeiling: 'release',
  }));
  const continuation = issueInput('继续当前任务，修复刚才受控发布暴露的数据库迁移问题，并完成当前范围的受控发布。我确认继续，并授权本轮提交和受控发布；不新增业务功能。', {
    rpcId: 'rpc-covered-repair', authorizedActionCeiling: 'release',
  });
  const current = await value.service.issueExecutionAuthority(continuation);
  const grant = await value.service.readProductionTaskGrant('task-001');
  const record = await value.service.readRecord('task-001');
  const request = prepareInput(continuation, 'propose', { proposal: taskProposal({
    goal: '修复当前未发布迁移中的资源冲突。',
    ownedPaths: [taskPaths.migration, taskPaths.test], taskProfiles: ['migration', 'backend'],
  }) });
  const result = await value.service.prepareConversationTask(request);
  assert.equal(result.status, 'prepared');
  assert.match(result.summary, /已覆盖/);
  assert.deepEqual(result.currentTask, prepared.currentTask);
  assert.equal(result.authorityResult.authority.authorityId, current.authority.authorityId);
  assert.equal(result.authorityResult.authority.actionCeiling, 'release');
  assert.deepEqual(await value.service.readProductionTaskGrant('task-001'), grant);
  assert.deepEqual(await value.service.readRecord('task-001'), record);
  const repeated = await value.service.prepareConversationTask(request);
  assert.equal(repeated.authorityResult.authority.authorityId, current.authority.authorityId);

  await expectCode('CONVERSATION_TASK_SCOPE_DENIED', value.service.prepareConversationTask(
    prepareInput(continuation, 'propose', { proposal: taskProposal({
      goal: '修改未授权的另一份迁移。', ownedPaths: ['forge-server/db/migration/V1.0.201__other.sql'],
      taskProfiles: ['migration'],
    }) }),
  ));
  assert.deepEqual(await value.service.readProductionTaskGrant('task-001'), grant);
});

test('release preparation recovers exact prior work from the same conversation without admitting unrelated files', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const firstPaths = ['forge-admin-ui/src/views/accident/investigate.vue',
    'forge-admin-ui/src/views/accident/__tests__/investigate-field-label-contract.spec.js'];
  const secondPaths = ['forge-admin-ui/src/views/accident/ledger.vue',
    'forge-admin-ui/src/views/accident/__tests__/ledger-stage-tabs-contract.spec.js'];
  const first = issueInput('修改事故调查页面', { rpcId: 'rpc-investigate' });
  await value.service.issueExecutionAuthority(first);
  await value.service.prepareConversationTask(prepareInput(first, 'propose', { proposal: taskProposal({
    goal: '修改事故调查页面及其回归用例', ownedPaths: firstPaths,
  }) }));
  value.setNow(START.getTime() + 30 * 60_000);
  const second = issueInput('事故台账页面也需要修改', { rpcId: 'rpc-ledger' });
  await value.service.issueExecutionAuthority(second);
  await value.service.prepareConversationTask(prepareInput(second, 'propose', { proposal: taskProposal({
    goal: '修改事故台账页面及其回归用例', ownedPaths: secondPaths,
  }) }));
  const release = issueInput('发版', { rpcId: 'rpc-release-both', authorizedActionCeiling: 'release' });
  const initial = await value.service.issueExecutionAuthority(release);
  assert.deepEqual(initial.authority.ownedPaths, [...secondPaths].sort());
  const request = prepareInput(release, 'propose', { proposal: taskProposal({
    goal: '发布本会话已完成的事故调查和台账两批改动', ownedPaths: [...firstPaths, ...secondPaths],
  }) });
  const prepared = await value.service.prepareConversationTask(request);
  const expected = [...firstPaths, ...secondPaths].sort();
  assert.equal(prepared.status, 'prepared');
  assert.deepEqual(prepared.authorityResult.authority.ownedPaths, expected);
  assert.equal(prepared.authorityResult.authority.actionCeiling, 'release');
  assert.deepEqual((await value.service.readProductionTaskGrant('task-001')).taskContract.ownedPaths, expected);
  assert.deepEqual((await value.service.readRecord('task-001')).taskContract.ownedPaths, expected,
    'execution and acceptance consume the same recovered scope');
  assert.deepEqual((await value.service.prepareConversationTask(request)).authorityResult.authority,
    prepared.authorityResult.authority, 'repeating the recovered proposal keeps its authority');
  await expectCode('CONVERSATION_TASK_PROPOSAL_CONFLICT', value.service.prepareConversationTask({
    ...request, proposal: { ...request.proposal,
      ownedPaths: [...expected, 'forge-admin-ui/src/views/accident/unrelated.vue'] },
  }));
});

test('release recovery cannot borrow another identity, source, or an unlisted descendant from grant history', async (t) => {
  const priorPath = 'forge-admin-ui/src/views/accident/investigate.vue';
  const currentPath = 'forge-admin-ui/src/views/accident/ledger.vue';
  for (const [label, priorIdentity, priorPaths, proposedPath] of [
    ['another actor', { actorUserId: '33333333-3333-4333-8333-333333333333', actorUsername: 'other' }, [priorPath], priorPath],
    ['another session', { dshSessionId: 'session-other' }, [priorPath], priorPath],
    ['another source', { source: { head: 'd'.repeat(40), fingerprint: FINGERPRINT } }, [priorPath], priorPath],
    ['unlisted descendant', {}, ['forge-admin-ui/src/views/accident/investigation'],
      'forge-admin-ui/src/views/accident/investigation/unlisted.vue'],
  ]) {
    await t.test(label, async () => {
      const value = await fixture();
      try {
        const prior = issueInput('修改事故调查页面', { rpcId: 'rpc-prior', ...priorIdentity });
        await value.service.issueExecutionAuthority(prior);
        await value.service.prepareConversationTask(prepareInput(prior, 'propose', {
          proposal: taskProposal({ ownedPaths: priorPaths }),
        }));
        const current = issueInput('事故台账页面也需要修改', { rpcId: 'rpc-current' });
        await value.service.issueExecutionAuthority(current);
        await value.service.prepareConversationTask(prepareInput(current, 'propose', {
          proposal: taskProposal({ ownedPaths: [currentPath] }),
        }));
        const release = issueInput('发版', { rpcId: 'rpc-release', authorizedActionCeiling: 'release' });
        const authority = await value.service.issueExecutionAuthority(release);
        assert.deepEqual(authority.authority.ownedPaths, [currentPath]);
        const before = await value.service.readProductionTaskGrant('task-001');
        await expectCode('CONVERSATION_TASK_PROPOSAL_CONFLICT', value.service.prepareConversationTask(
          prepareInput(release, 'propose', { proposal: taskProposal({ ownedPaths: [currentPath, proposedPath] }) }),
        ));
        assert.deepEqual(await value.service.readProductionTaskGrant('task-001'), before);
      } finally {
        await value.cleanup();
      }
    });
  }
});

test('a direct current-task release continues only its exact prepared scope and authenticated action ceiling', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const original = issueInput('创建安保模块', { rpcId: 'rpc-release-original' });
  await value.service.issueExecutionAuthority(original);
  const prepared = await value.service.prepareConversationTask(prepareInput(original, 'propose'));
  const originalPaths = [...prepared.currentTask.ownedPaths];
  const originalProfiles = [...prepared.currentTask.taskProfiles];

  const releasePrompts = [
    ['rpc-current-task-release', '发布这次安保导航改动。先同步项目最新代码，保留当前改动，再完成必需检查。'],
    ['rpc-current-task-continue-release', '继续发布这次安保导航改动。'],
    ['rpc-current-task-confirm-release', '确认发布这个范围，继续执行。'],
    ['rpc-current-task-determine-release', '确定发布本次改动。'],
    ['rpc-current-task-agree-release', '同意发布当前任务。'],
  ];
  for (const [rpcId, releasePrompt] of releasePrompts) {
    const release = await value.service.issueExecutionAuthority(issueInput(releasePrompt, {
      rpcId, authorizedActionCeiling: 'release',
    }));
    assert.equal(release.trustedPolicyInput.taskAuthority.actionCeiling, 'release');
    assert.deepEqual(release.trustedPolicyInput.taskAuthority.ownedPaths, originalPaths);
    assert.deepEqual(release.trustedPolicyInput.taskAuthority.taskProfiles, originalProfiles);
  }

  const equivalent = await value.service.issueExecutionAuthority(issueInput(
    '提交当前安保导航变更，保留现有代码并完成必要检查。',
    { rpcId: 'rpc-current-task-checkpoint', authorizedActionCeiling: 'git-checkpoint' },
  ));
  assert.equal(equivalent.trustedPolicyInput.taskAuthority.actionCeiling, 'git-checkpoint');
  assert.deepEqual(equivalent.trustedPolicyInput.taskAuthority.ownedPaths, originalPaths);
  assert.deepEqual(equivalent.trustedPolicyInput.taskAuthority.taskProfiles, originalProfiles);

  const beforeRejected = await value.service.readProductionTaskGrant('task-001');
  await expectCode('CONVERSATION_ACTION_NOT_AUTHORIZED', value.service.issueExecutionAuthority(issueInput(
    releasePrompts[1][1],
    { rpcId: 'rpc-current-task-release-denied', authorizedActionCeiling: 'workspace-write' },
  )));
  assert.deepEqual(await value.service.readProductionTaskGrant('task-001'), beforeRejected);

  for (const [rpcId, promptText] of [
    ['rpc-new-task-release', '发布新的财务模块，完成必要检查。'],
    ['rpc-mixed-new-task-release', '发布本次安保导航改动。另外新增财务模块。'],
    ['rpc-readonly-release', '只读检查当前安保导航改动，不要发布。'],
    ['rpc-question-release', '如何发布当前安保导航改动？'],
    ['rpc-current-task-question', '发布当前安保导航改动，可以吗？'],
    ['rpc-prefixed-current-task-question', '继续发布这次安保导航改动，可以吗？'],
    ['rpc-attributed-release', '日志显示：“发布当前安保导航改动。”'],
    ['rpc-attributed-prefixed-release', '日志显示：“继续发布这次安保导航改动。”'],
    ['rpc-negated-prefixed-release', '不要继续发布这次安保导航改动。'],
  ]) {
    const result = await value.service.issueExecutionAuthority(issueInput(promptText, {
      rpcId, authorizedActionCeiling: 'release',
    }));
    assert.equal(result.authority, null, promptText);
    assert.deepEqual(await value.service.readProductionTaskGrant('task-001'), beforeRejected);
  }
  await expectCode('CONVERSATION_WRITE_SCOPE_REQUIRED', value.service.issueExecutionAuthority(issueInput(
    '继续发布这次安保导航改动。', {
      rpcId: 'rpc-current-task-release-wrong-identity',
      actorUserId: '22222222-2222-4222-8222-222222222222',
      authorizedActionCeiling: 'release',
    },
  )));
});

test('observed execution confirmations retain the prepared scope and record real write eligibility', async (t) => {
  for (const [index, promptText, actionCeiling] of [
    [0, '确认执行该范围并发布', 'release'],
    [1, '不需要反复确认，直接执行，我需要尽快看到页面变化', 'workspace-write'],
    [2, '继续 继续', 'workspace-write'],
    [3, '确认已保存的范围', 'workspace-write'],
    [4, '确认执行已保存的范围', 'workspace-write'],
    [5, '确认，厂区字段为大港和南港', 'workspace-write'],
    [6, '直接改动，然后发版，不要在反复确认，权限直接给到最高', 'release'],
  ]) {
    const value = await fixture();
    t.after(() => value.cleanup());
    const original = issueInput('创建安保模块', { rpcId: `rpc-observed-original-${index}` });
    await value.service.issueExecutionAuthority(original);
    const prepared = await value.service.prepareConversationTask(prepareInput(original, 'propose'));
    const input = issueInput(promptText, { rpcId: `rpc-observed-confirm-${index}`, authorizedActionCeiling: actionCeiling });
    const result = await value.service.issueExecutionAuthority(input);
    assert.ok(result.authority, promptText);
    assert.deepEqual(result.trustedPolicyInput.taskAuthority.ownedPaths, prepared.currentTask.ownedPaths);
    assert.equal(result.trustedPolicyInput.taskAuthority.actionCeiling, actionCeiling);
    const stored = JSON.parse(await readFile(path.join(value.root, 'state/conversation-task-requests/task-001.json'), 'utf8'));
    assert.equal(stored.writableEligible, true, promptText);
    assert.equal(stored.promptTextDigest, input.promptTextDigest);
  }
});

test('compound scope authorization prepares the approved files and release in the same user turn', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const sevenPaths = Array.from({ length: 7 }, (_, index) =>
    `forge-admin-ui/src/views/security/leadership-${index + 1}.vue`);
  const eightPaths = [...sevenPaths, taskPaths.test].sort();
  const original = issueInput('修复领导引领力页面。', { rpcId: 'compound-original' });
  await value.service.issueExecutionAuthority(original);
  await value.service.prepareConversationTask(prepareInput(original, 'propose', {
    proposal: taskProposal({ goal: '修复领导引领力页面', ownedPaths: sevenPaths }),
  }));
  for (const [index, promptText, ownedPaths] of [
    [0, '继续发布，并将本轮 7 个领导引领力相关文件纳入发布范围。', sevenPaths],
    [1, '确认按已登记方案，将本轮 7 个领导引领力文件建立检查点并继续发布', sevenPaths],
    [2, '同意纳入第 8 个测试文件并继续发布。', eightPaths],
    [3, '确认执行第 8 个测试文件修复并继续发布。', eightPaths],
    [4, '允许将当前修复路径加入范围，然后完成受控发布。', eightPaths],
  ]) {
    const input = issueInput(promptText, { rpcId: `compound-scope-${index}`, authorizedActionCeiling: 'release' });
    assert.equal(isForgeConversationTaskContinuation(promptText), false,
      'a named-file approval must compile its proposal instead of inheriting the old file list');
    assert.equal((await value.service.issueExecutionAuthority(input)).authority, null);
    const proposal = taskProposal({ goal: '修复领导引领力页面及直接测试并发布', ownedPaths });
    const request = prepareInput(input, 'propose', { proposal });
    const result = await value.service.prepareConversationTask(request);
    assert.equal(result.status, 'prepared', promptText);
    assert.equal(result.authorityResult.authority.actionCeiling, 'release', promptText);
    assert.equal(result.authorityResult.trustedPolicyInput.taskAuthority.actionCeiling, 'release');
    assert.deepEqual(result.currentTask.ownedPaths, ownedPaths);
    assert.deepEqual(result.authorityResult.trustedPolicyInput.taskAuthority.ownedPaths, ownedPaths);
    const stored = JSON.parse(await readFile(path.join(value.root, 'state/conversation-task-requests/task-001.json'), 'utf8'));
    assert.equal(stored.writableEligible, true);
    assert.equal(stored.promptTextDigest, input.promptTextDigest);
    if (index === 2) {
      const repeated = await value.service.prepareConversationTask(request);
      assert.equal(repeated.status, 'prepared');
      assert.equal(repeated.authorityResult.authority.authorityId, result.authorityResult.authority.authorityId);
    }
  }
  const continued = await value.service.issueExecutionAuthority(issueInput('继续', {
    rpcId: 'compound-after-registration', authorizedActionCeiling: 'release',
  }));
  assert.equal(continued.authority.actionCeiling, 'release');
  assert.deepEqual(continued.trustedPolicyInput.taskAuthority.ownedPaths, eightPaths);
});

test('compound execution confirmation consumes an existing plan without another registration confirmation', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const plan = issueInput('先给出安保页面修复方案，确认后再执行。', { rpcId: 'compound-plan' });
  await value.service.issueExecutionAuthority(plan);
  const prepared = await value.service.prepareConversationTask(prepareInput(plan, 'propose'));
  assert.equal(prepared.status, 'needs-confirmation');
  const confirmation = issueInput('确认执行并继续发布', {
    rpcId: 'compound-plan-confirmation', authorizedActionCeiling: 'release',
  });
  assert.equal(isForgeConversationTaskContinuation(confirmation.promptText), true);
  const result = await value.service.issueExecutionAuthority(confirmation);
  assert.equal(result.authority.actionCeiling, 'release');
  assert.deepEqual(result.trustedPolicyInput.taskAuthority.ownedPaths, prepared.currentTask.ownedPaths);
  const closeout = await value.service.issueExecutionAuthority(issueInput('确认执行并建立检查点，然后继续发布。', {
    rpcId: 'compound-plan-closeout', authorizedActionCeiling: 'release',
  }));
  assert.equal(closeout.authority.actionCeiling, 'release');
});

test('compound scope authorization preserves explicit decisions and configured authority boundaries', async (t) => {
  for (const [index, promptText] of [
    '同意纳入第 8 个测试文件并继续发布？',
    '日志显示：“同意纳入第 8 个测试文件并继续发布。”',
    '不要纳入第 8 个测试文件并继续发布。',
    '同意纳入第 8 个测试文件并继续发布。先不要发布。',
    '先给出第 8 个测试文件的修改方案，确认后再执行并继续发布。',
    '只读分析第 8 个测试文件，不修改。',
  ].entries()) {
    const value = await fixture();
    t.after(() => value.cleanup());
    const input = issueInput(promptText, { rpcId: `compound-boundary-${index}`, authorizedActionCeiling: 'release' });
    const result = await value.service.issueExecutionAuthority(input);
    assert.notEqual(result.authority?.actionCeiling, 'release', promptText);
    if (index < 5) {
      const prepared = await value.service.prepareConversationTask(prepareInput(input, 'propose'));
      assert.notEqual(prepared.authorityResult?.authority?.actionCeiling, 'release', promptText);
      if (index === 0 || index === 1 || index === 4) assert.equal(prepared.status, 'needs-confirmation');
    }
  }
  const value = await fixture({ scopes: [{ taskProfile: 'frontend-admin', ownedPaths: [taskPaths.page] }] });
  t.after(() => value.cleanup());
  const promptText = '同意纳入第 8 个测试文件并继续发布。';
  await expectCode('CONVERSATION_ACTION_NOT_AUTHORIZED', value.service.issueExecutionAuthority(issueInput(promptText)));
  const input = issueInput(promptText, { rpcId: 'compound-denied-path', authorizedActionCeiling: 'release' });
  await value.service.issueExecutionAuthority(input);
  await expectCode('CONVERSATION_TASK_SCOPE_DENIED', value.service.prepareConversationTask(prepareInput(input, 'propose', {
    proposal: taskProposal({ ownedPaths: ['forge-admin-ui/src/views/security/outside-approved-scope.vue'] }),
  })));
});

test('compound authorization never overrides a later bare release or checkpoint denial', async (t) => {
  let index = 0;
  for (const prefix of ['确认执行并继续发布', '同意纳入第 8 个测试文件并继续发布']) {
    for (const denial of ['本轮不发布。', '本轮不提交。']) {
      const value = await fixture();
      t.after(() => value.cleanup());
      const promptText = `${prefix}。${denial}`;
      const input = issueInput(promptText, { rpcId: `compound-bare-denial-${index++}`, authorizedActionCeiling: 'release' });
      assert.equal(isForgeConversationTaskContinuation(promptText), false, promptText);
      const issued = await value.service.issueExecutionAuthority(input);
      assert.notEqual(issued.authority?.actionCeiling, 'release', promptText);
      const prepared = await value.service.prepareConversationTask(prepareInput(input, 'propose'));
      assert.notEqual(prepared.authorityResult?.authority?.actionCeiling, 'release', promptText);
    }
  }
});

test('denying a planning round does not override a real plan-first or read-only instruction', async (t) => {
  for (const [index, promptText, expected] of [
    [0, '修复安保页面。当前不是方案评审轮，不需要等用户再次确认。', 'prepared'],
    [1, '先给安保页面修复方案。当前不是方案评审轮，不需要等用户再次确认。', 'needs-confirmation'],
    [2, '先给安保页面修复方案，确认后再执行。', 'needs-confirmation'],
    [3, '先分析安保页面问题，再修改。', 'needs-confirmation'],
    [4, '请先帮我分析安保页面问题，再修改。', 'needs-confirmation'],
    [5, '先对安保页面进行分析，再修改。', 'needs-confirmation'],
  ]) {
    const value = await fixture();
    t.after(() => value.cleanup());
    const input = issueInput(promptText, { rpcId: `rpc-observed-planning-${index}` });
    await value.service.issueExecutionAuthority(input);
    const result = await value.service.prepareConversationTask(prepareInput(input, 'propose'));
    assert.equal(result.status, expected, promptText);
  }
});

test('saved-scope and field-value confirmation cannot manufacture an absent task', async (t) => {
  for (const [index, promptText] of ['确认已保存的范围', '确认，厂区字段为大港和南港',
    '直接改动，然后发版，不要在反复确认，权限直接给到最高'].entries()) {
    const value = await fixture();
    t.after(() => value.cleanup());
    const input = issueInput(promptText, { rpcId: `rpc-missing-scope-${index}`, authorizedActionCeiling: 'release' });
    const result = await value.service.issueExecutionAuthority(input);
    assert.equal(result.authority, null);
    const inspected = await value.service.prepareConversationTask(prepareInput(input));
    assert.equal(inspected.currentTask, null);
  }
});

test('observed confirmation variants cannot authorize quoted, cancelled or unauthorized work', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const original = issueInput('创建安保模块', { rpcId: 'rpc-observed-boundary-original' });
  await value.service.issueExecutionAuthority(original);
  await value.service.prepareConversationTask(prepareInput(original, 'propose'));
  const before = await value.service.readProductionTaskGrant('task-001');
  for (const [index, promptText] of [
    '日志显示：“确认执行该范围并发布”。',
    '确认执行该范围并发布？',
    '不要确认执行该范围并发布。',
    '继续 取消',
    '只读检查，继续 继续。',
    '日志显示：“确认已保存的范围”。',
    '确认已保存的范围？',
    '不要确认已保存的范围。',
    '确认，厂区字段为大港和南港？',
    '直接改动，然后发版？',
    '只读检查，直接改动，然后发版。',
    '直接改动，然后发版，不要发布。',
  ].entries()) {
    const result = await value.service.issueExecutionAuthority(issueInput(promptText, {
      rpcId: `rpc-observed-negative-${index}`, authorizedActionCeiling: 'release',
    }));
    assert.equal(result.authority, null, promptText);
    assert.deepEqual(await value.service.readProductionTaskGrant('task-001'), before);
  }
  await expectCode('CONVERSATION_ACTION_NOT_AUTHORIZED', value.service.issueExecutionAuthority(issueInput(
    '确认执行该范围并发布', { rpcId: 'rpc-observed-ceiling', authorizedActionCeiling: 'workspace-write' },
  )));
  await expectCode('CONVERSATION_WRITE_SCOPE_REQUIRED', value.service.issueExecutionAuthority(issueInput(
    '继续 继续', { rpcId: 'rpc-observed-session', dshSessionId: 'session-other' },
  )));
  await expectCode('CONVERSATION_ACTION_NOT_AUTHORIZED', value.service.issueExecutionAuthority(issueInput(
    '直接改动，然后发版，不要在反复确认，权限直接给到最高',
    { rpcId: 'rpc-observed-highest-permission', authorizedActionCeiling: 'workspace-write' },
  )));
  await expectCode('CONVERSATION_WRITE_SCOPE_REQUIRED', value.service.issueExecutionAuthority(issueInput(
    '确认执行已保存的范围', { rpcId: 'rpc-saved-scope-other-session', dshSessionId: 'session-other' },
  )));
});

test('controlled release route wording continues the exact prepared scope with release authority', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const original = issueInput('创建安保模块', { rpcId: 'rpc-controlled-release-original' });
  await value.service.issueExecutionAuthority(original);
  const prepared = await value.service.prepareConversationTask(prepareInput(original, 'propose'));

  for (const [index, promptText] of [
    '走受控发版',
    '请走受控流程发布。',
    '通过受控入口部署',
    '按受控流程上线',
    '继续走受控发版',
  ].entries()) {
    const input = issueInput(promptText, {
      rpcId: `rpc-controlled-release-${index}`, authorizedActionCeiling: 'release',
    });
    const result = await value.service.issueExecutionAuthority(input);
    assert.ok(result.authority, promptText);
    assert.equal(result.trustedPolicyInput.taskAuthority.actionCeiling, 'release', promptText);
    assert.deepEqual(result.trustedPolicyInput.taskAuthority.ownedPaths, prepared.currentTask.ownedPaths);
    assert.deepEqual(result.trustedPolicyInput.taskAuthority.taskProfiles, prepared.currentTask.taskProfiles);
    const stored = JSON.parse(await readFile(path.join(
      value.root, 'state/conversation-task-requests/task-001.json',
    ), 'utf8'));
    assert.equal(stored.writableEligible, true, promptText);
    assert.equal(stored.promptTextDigest, input.promptTextDigest);
  }
});

test('controlled release route wording preserves question, attribution, scope and account boundaries', async (t) => {
  const value = await fixture();
  const empty = await fixture();
  t.after(async () => { await value.cleanup(); await empty.cleanup(); });
  const original = issueInput('创建安保模块', { rpcId: 'rpc-controlled-boundary-original' });
  await value.service.issueExecutionAuthority(original);
  await value.service.prepareConversationTask(prepareInput(original, 'propose'));
  const beforeRejected = await value.service.readProductionTaskGrant('task-001');

  for (const [index, promptText] of [
    '不要走受控发版',
    '先不通过受控入口发布',
    '只读检查，不要按受控流程部署',
    '如何走受控发版？',
    '走受控发版，可以吗？',
    '日志显示：“走受控发版。”',
    '引用：\n通过受控入口发布',
    '“按受控流程上线”',
  ].entries()) {
    const result = await value.service.issueExecutionAuthority(issueInput(promptText, {
      rpcId: `rpc-controlled-rejected-${index}`, authorizedActionCeiling: 'release',
    }));
    assert.equal(result.authority, null, promptText);
    assert.deepEqual(await value.service.readProductionTaskGrant('task-001'), beforeRejected);
  }
  for (const authorizedActionCeiling of ['workspace-write', 'git-checkpoint']) {
    await expectCode('CONVERSATION_ACTION_NOT_AUTHORIZED', value.service.issueExecutionAuthority(issueInput(
      '走受控发版', { rpcId: `rpc-controlled-ceiling-${authorizedActionCeiling}`, authorizedActionCeiling },
    )));
    assert.deepEqual(await value.service.readProductionTaskGrant('task-001'), beforeRejected);
  }
  const noWrite = issueInput('走受控发版', {
    rpcId: 'rpc-controlled-no-write', workspaceWriteAuthorized: false,
  });
  delete noWrite.authorizedActionCeiling;
  const denied = await value.service.issueExecutionAuthority(noWrite);
  assert.equal(denied.authority, null);
  await expectCode('CONVERSATION_WRITE_SCOPE_REQUIRED', value.service.issueExecutionAuthority(issueInput(
    '走受控发版', {
      rpcId: 'rpc-controlled-other-user',
      actorUserId: '22222222-2222-4222-8222-222222222222',
      authorizedActionCeiling: 'release',
    },
  )));
  assert.deepEqual(await value.service.readProductionTaskGrant('task-001'), beforeRejected);
  const unscoped = issueInput('走受控发版', {
    rpcId: 'rpc-controlled-no-scope', authorizedActionCeiling: 'release',
  });
  assert.equal((await empty.service.issueExecutionAuthority(unscoped)).authority, null);
  assert.equal((await empty.service.prepareConversationTask(prepareInput(unscoped))).currentTask, null);
});

test('explicit format maintenance keeps final checks and survives ordinary continue and controlled release', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const original = issueInput('仅修复当前安保页面已有的 lint 格式错误，保持业务行为不变。', {
    rpcId: 'rpc-format-maintenance-original',
    conversationFormatMaintenanceSupported: true,
  });
  await value.service.issueExecutionAuthority(original);
  const prepared = await value.service.prepareConversationTask(prepareInput(original, 'propose', {
    proposal: taskProposal({
      goal: '修复当前页面已报告的格式问题，并运行现有检查。',
      ownedPaths: [taskPaths.page],
      references: [{ path: taskPaths.page, sha256: HASH }],
    }),
  }));
  assert.equal(prepared.status, 'prepared');
  const firstGrant = await value.service.readProductionTaskGrant('task-001');
  assert.equal(firstGrant.taskContract.tddRequired, false);
  assert.deepEqual(firstGrant.taskContract.requiredRedProfiles, []);
  assert.deepEqual(firstGrant.taskContract.requiredVerificationProfiles, [
    'governance', 'frontend-admin-lint', 'frontend-admin-test',
    'frontend-admin-typecheck', 'frontend-admin-build', 'changed-safe', 'full-regression',
  ]);
  assert.ok(firstGrant.taskContract.requiredObligations.includes('security-negative-tests'));
  assert.ok(!firstGrant.taskContract.requiredObligations.includes('test-first'));

  for (const [index, promptText] of ['继续', '走受控发版'].entries()) {
    const result = await value.service.issueExecutionAuthority(issueInput(promptText, {
      rpcId: `rpc-format-maintenance-continue-${index}`, authorizedActionCeiling: 'release',
      conversationFormatMaintenanceSupported: true,
    }));
    assert.ok(result.authority, promptText);
    const grant = await value.service.readProductionTaskGrant('task-001');
    assert.equal(grant.taskContract.tddRequired, false, promptText);
    assert.deepEqual(grant.taskContract.ownedPaths, firstGrant.taskContract.ownedPaths);
    assert.deepEqual(grant.taskContract.requiredVerificationProfiles, firstGrant.taskContract.requiredVerificationProfiles);
    assert.equal(grant.actionCeiling, index === 0 ? 'workspace-write' : 'release');
  }
});

test('format maintenance uses the capability saved with the original RPC and defaults old requests to test-first', async (t) => {
  for (const supported of [undefined, false, true]) {
    const value = await fixture();
    t.after(() => value.cleanup());
    const issue = issueInput('仅修复已有 lint 格式问题，保持业务行为不变。', {
      ...(supported === undefined ? {} : { conversationFormatMaintenanceSupported: supported }),
    });
    await value.service.issueExecutionAuthority(issue);
    const saved = JSON.parse(await readFile(path.join(value.root, 'state/conversation-task-requests/task-001.json'), 'utf8'));
    assert.equal(saved.conversationFormatMaintenanceSupported, supported === true);
    await expectCode('CONVERSATION_TASK_REQUEST_CONFLICT', value.service.issueExecutionAuthority({
      ...issue, conversationFormatMaintenanceSupported: supported !== true,
    }));
    await expectCode('ACCEPTANCE_SCHEMA_INVALID', value.service.prepareConversationTask(prepareInput(issue, 'propose', {
      conversationFormatMaintenanceSupported: true,
    })));
    await value.service.prepareConversationTask(prepareInput(issue, 'propose', {
      proposal: taskProposal({ ownedPaths: [taskPaths.page], references: [{ path: taskPaths.page, sha256: HASH }] }),
    }));
    const grant = await value.service.readProductionTaskGrant('task-001');
    assert.equal(grant.taskContract.tddRequired, supported !== true);
    assert.equal(grant.taskProfiles.includes('frontend-format-maintenance'), supported === true);
  }
});

test('an existing request record without a format capability remains valid and cannot acquire the new profile', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const issue = issueInput('仅修复已有 lint 格式问题，保持业务行为不变。');
  await value.service.issueExecutionAuthority(issue);
  const file = path.join(value.root, 'state/conversation-task-requests/task-001.json');
  const oldRecord = JSON.parse(await readFile(file, 'utf8'));
  delete oldRecord.conversationFormatMaintenanceSupported;
  delete oldRecord.recordDigest;
  oldRecord.recordDigest = canonicalSha256(oldRecord);
  await writeFile(file, JSON.stringify(oldRecord));
  await value.service.issueExecutionAuthority(issue);
  await value.service.prepareConversationTask(prepareInput(issue, 'propose', {
    proposal: taskProposal({ ownedPaths: [taskPaths.page], references: [{ path: taskPaths.page, sha256: HASH }] }),
  }));
  assert.equal((await value.service.readProductionTaskGrant('task-001')).taskContract.tddRequired, true);
});

for (const uiPrompt of [null, '查看详情显示当前状态的tab页', '单人调查也需要委任书，内容参考截图，样式布局参考团队调查委任书']) test(`Manager records a new task request for ${uiPrompt ?? 'implementation with limited verification scope'}`, async (t) => {
  const value = await fixture();
  const taskId = 'task-001';
  const taskRoot = path.join(value.root, 'taskspaces', taskId);
  await mkdir(path.join(taskRoot, 'workspace'), { recursive: true });
  await mkdir(path.join(value.root, 'intake'));
  await writeFile(path.join(value.root, 'taskspacectl.sh'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(taskRoot, 'task.env'), 'FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED=true\n');
  await writeFile(path.join(taskRoot, 'metadata.json'), JSON.stringify({
    schemaVersion: 2, projectSlug: 'forge-project', taskId, actorId: 'lyl', actorUserId: ACTOR_USER_ID,
    conversationId: 'conversation-001', branch: 'task/lyl/task-001', accessMode: 'conversation',
    status: 'active', accessTokenHash: '0'.repeat(64), lastCandidate: null, lastRelease: null,
    harnessPort: 23001, baseCommit: HEAD, createdAt: START.toISOString(), updatedAt: START.toISOString(),
  }));
  await value.service.issueExecutionAuthority(issueInput('修改后端工具', { rpcId: 'rpc-prior-backend' }));
  const calls = [];
  const managerToken = 'm'.repeat(64);
  const manager = createConversationManager({
    projectRoot: value.root, projectSlug: 'forge-project', intakeRoot: path.join(value.root, 'intake'),
    controlScript: path.join(value.root, 'taskspacectl.sh'), managerToken,
    auditPath: path.join(value.root, 'manager-audit.jsonl'),
    runControl: async () => ({ code: 0, signal: null, stdout: '', stderr: '' }),
    acceptanceControlClient: (body) => value.service.issueContract(body),
    executionAuthorityClient: (body) => { calls.push(body); return value.service.issueExecutionAuthority(body); },
    sourceObservationClient: async () => ({ schemaVersion: 1, observationType: 'forge-verify/source',
      projectSlug: 'forge-project', taskId, source: { head: HEAD, fingerprint: FINGERPRINT, snapshotSha256: FINGERPRINT } }),
  });
  await listen(manager);
  t.after(async () => { await new Promise((resolve) => manager.close(resolve)); await value.cleanup(); });
  const promptText = uiPrompt ?? "把刚才后端的验收限制保留为已发现的问题，不再修改后端，不再重跑它的模块测试。\n\n现在在这个验证舱做一个独立的前端小需求：为 forge-admin-ui 增加一个无副作用的调查方式显示工具，TEAM 显示“团队调查”，SINGLE 显示“个人调查”，UNKNOWN、空值及其他未知输入显示“待确认”。由你选择符合项目现有习惯的位置和命名，并增加对应单元测试。\n\n只修改这个工具和它的测试，不接入页面或接口，不新增依赖，不改锁文件。不提交、不发布，也不需要产品页面视觉验收。请直接完成实施，只检查这次变更及直接影响的范围：lint、类型检查、相关测试及确有必要的构建。不要因为首次处理前端而扫描全项目。检查结束后核对平台是否认可对应结果；若旧后端状态或不相关全量检查阻塞了这个独立前端需求，明确报告原始错误及影响，不要扩大修改或反复重跑。";
  const promptBody = JSON.stringify({ type: 'client-request', rpcId: 'rpc-new-frontend', method: 'session.prompt',
    payload: { sessionId: 'session-001', mode: 'queue', content: [
      ...(uiPrompt?.includes('截图') ? [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }] : []),
      { type: 'text', text: promptText },
    ] } });
  const classified = classifyPinnedDshPromptBody(Buffer.from(promptBody), 'session.prompt');
  const response = await requestManagerJson(manager, managerToken, `/v1/taskspaces/${taskId}/executions/prepare`, {
    ...classified, promptBody, projectSlug: 'forge-project', taskId, actorUserId: ACTOR_USER_ID, actorUsername: 'lyl',
    conversationId: 'conversation-001', requestId: randomUUID(), workspaceWriteAuthorized: true,
  });
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.equal(calls.at(-1).workspaceWriteAuthorized, true);
  const stored = JSON.parse(await readFile(path.join(value.root, 'state/conversation-task-requests/task-001.json'), 'utf8'));
  assert.equal(stored.rpcId, 'rpc-new-frontend');
  assert.equal(stored.writableEligible, true);
  const inspected = await value.service.prepareConversationTask(prepareInput(issueInput(promptText, { rpcId: 'rpc-new-frontend' })));
  assert.equal(inspected.status, 'inspected');
});

test('Manager derives format capability only from task.env and rejects client claims and malformed bits', async (t) => {
  const value = await fixture();
  const taskId = 'task-001';
  const taskRoot = path.join(value.root, 'taskspaces', taskId);
  await mkdir(path.join(taskRoot, 'workspace'), { recursive: true });
  await mkdir(path.join(value.root, 'intake'));
  await writeFile(path.join(value.root, 'taskspacectl.sh'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(taskRoot, 'metadata.json'), JSON.stringify({
    schemaVersion: 2, projectSlug: 'forge-project', taskId, actorId: 'lyl', actorUserId: ACTOR_USER_ID,
    conversationId: 'conversation-001', branch: 'task/lyl/task-001', accessMode: 'conversation',
    status: 'active', accessTokenHash: '0'.repeat(64), lastCandidate: null, lastRelease: null,
    harnessPort: 23001, baseCommit: HEAD, createdAt: START.toISOString(), updatedAt: START.toISOString(),
  }));
  const calls = [];
  const managerToken = 'm'.repeat(64);
  const manager = createConversationManager({
    projectRoot: value.root, projectSlug: 'forge-project', intakeRoot: path.join(value.root, 'intake'),
    controlScript: path.join(value.root, 'taskspacectl.sh'), managerToken,
    auditPath: path.join(value.root, 'manager-audit.jsonl'),
    runControl: async () => ({ code: 0, signal: null, stdout: '', stderr: '' }),
    acceptanceControlClient: (body) => value.service.issueContract(body),
    executionAuthorityClient: async (body) => {
      calls.push(body);
      return { authority: null, trustedPolicyInput: null, idempotent: false };
    },
    sourceObservationClient: async () => ({ schemaVersion: 1, observationType: 'forge-verify/source',
      projectSlug: 'forge-project', taskId, source: { head: HEAD, fingerprint: FINGERPRINT, snapshotSha256: FINGERPRINT } }),
  });
  await listen(manager);
  t.after(async () => { await new Promise((resolve) => manager.close(resolve)); await value.cleanup(); });
  const request = (extra = {}) => {
    const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
      type: 'client-request', rpcId: randomUUID(), method: 'session.prompt',
      payload: { sessionId: 'session-001', mode: 'queue', content: [{ type: 'text', text: '仅修复已有 lint 格式问题，保持行为不变。' }] },
    })), 'session.prompt');
    return requestManagerJson(manager, managerToken, `/v1/taskspaces/${taskId}/executions/prepare`, {
      ...classified, projectSlug: 'forge-project', taskId, actorUserId: ACTOR_USER_ID, actorUsername: 'lyl',
      conversationId: 'conversation-001', requestId: randomUUID(), workspaceWriteAuthorized: true, ...extra,
    });
  };
  for (const supported of [undefined, false, true]) {
    await writeFile(path.join(taskRoot, 'task.env'), 'FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED=true\n'
      + (supported === undefined ? '' : `FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED=${supported}\n`));
    const response = await request();
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(calls.at(-1).conversationTaskPreparationSupported, true);
    assert.equal(Object.hasOwn(calls.at(-1), 'conversationFormatMaintenanceSupported'), supported === true);
    if (supported === true) assert.equal(calls.at(-1).conversationFormatMaintenanceSupported, true);
  }
  const beforeRejected = calls.length;
  const forged = await request({ conversationFormatMaintenanceSupported: true });
  assert.equal(forged.statusCode, 422);
  assert.equal(forged.body.code, 'EXECUTION_RUNTIME_CAPABILITY_INVALID');
  for (const suffix of ['=yes\n', '=true\nFORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED=false\n']) {
    await writeFile(path.join(taskRoot, 'task.env'), 'FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED=true\n'
      + `FORGE_CONVERSATION_FORMAT_MAINTENANCE_SUPPORTED${suffix}`);
    const malformed = await request();
    assert.equal(malformed.statusCode, 503);
    assert.equal(malformed.body.code, 'TASKSPACE_RUNTIME_INVALID');
  }
  assert.equal(calls.length, beforeRejected);
});

test('a plan stores an exact task scope without a grant until a later explicit confirmation', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const plan = issueInput('先给出安保导航方案，确认后再执行', { rpcId: 'rpc-plan' });
  await value.service.issueExecutionAuthority(plan);
  const planned = await value.service.prepareConversationTask(prepareInput(plan, 'propose'));
  assert.equal(planned.status, 'needs-confirmation');
  assert.equal(planned.currentTask.goal, taskProposal().goal);
  assert.equal(planned.authorityResult, undefined);

  const confirmation = issueInput('确认发布这个范围，继续执行。', {
    rpcId: 'rpc-plan-confirm', authorizedActionCeiling: 'release',
  });
  const confirmed = await value.service.issueExecutionAuthority(confirmation);
  assert.ok(confirmed.authority);
  assert.equal(confirmed.trustedPolicyInput.taskAuthority.actionCeiling, 'release');
  assert.deepEqual(confirmed.trustedPolicyInput.taskAuthority.ownedPaths,
    planned.currentTask.ownedPaths);
  const current = await value.service.prepareConversationTask(prepareInput(confirmation));
  assert.equal(current.currentTask.goal, planned.currentTask.goal);
});

test('a new continuation recovers an r77 prepared writer whose acceptance record is missing', async (t) => {
  const value = await fixture();
  const taskId = 'task-001';
  const conversationId = 'conversation-001';
  const dshSessionId = 'session-001';
  const workspace = path.join(value.root, 'taskspaces', taskId, 'workspace');
  const referencePath = 'docs/architecture.md';
  const reference = 'Existing navigation, menu migration, and security module structure.\n';
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await writeFile(path.join(workspace, referencePath), reference);
  await writeFile(path.join(value.root, 'taskspaces', taskId, 'metadata.json'), `${JSON.stringify({
    schemaVersion: 2,
    projectSlug: 'forge-project',
    taskId,
    actorId: 'lyl',
    actorUserId: ACTOR_USER_ID,
    conversationId,
    branch: 'task/lyl/task-001',
    accessMode: 'conversation',
    status: 'active',
    accessTokenHash: '0'.repeat(64),
    lastCandidate: null,
    lastRelease: null,
    harnessPort: 23001,
    baseCommit: HEAD,
    createdAt: START.toISOString(),
    updatedAt: START.toISOString(),
  })}\n`);
  await writeFile(path.join(value.root, 'taskspaces', taskId, 'task.env'),
    'FORGE_CONVERSATION_TASK_PREPARATION_SUPPORTED=true\n');

  const initialRpcId = 'rpc-r77-prepared';
  const initialPrompt = '继续';
  const initialIssue = issueInput(initialPrompt, { rpcId: initialRpcId });
  assert.equal((await value.service.issueExecutionAuthority(initialIssue)).authority, null);
  const initialRequest = {
    ...classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId: initialRpcId,
      method: 'session.prompt',
      payload: { sessionId: dshSessionId, mode: 'queue', content: [{ type: 'text', text: initialPrompt }] },
    })), 'session.prompt'),
    actorUserId: ACTOR_USER_ID,
    actorUsername: 'lyl',
    conversationId,
    requestId: 'request-r77-prepared',
  };
  const readonly = await prepareProtectedExecutionContext({
    projectRoot: value.root,
    projectSlug: 'forge-project',
    taskMetadata: {
      schemaVersion: 2, projectSlug: 'forge-project', taskId, actorUserId: ACTOR_USER_ID,
      actorId: 'lyl', conversationId, status: 'active', accessMode: 'conversation',
    },
    request: initialRequest,
    policyPath: POLICY_PATH,
    now: START.getTime(),
  });
  const lookup = Object.fromEntries([
    'projectSlug', 'taskId', 'conversationId', 'actorUserId', 'dshSessionId', 'rpcId', 'textDigest',
  ].map((key) => [key, readonly[key]]));
  const proposal = taskProposal({
    references: [{ path: referencePath, sha256: createHash('sha256').update(reference).digest('hex') }],
  });
  const prepared = await prepareConversationTaskExecution({
    projectRoot: value.root,
    taskMetadata: {
      schemaVersion: 2, projectSlug: 'forge-project', taskId, actorUserId: ACTOR_USER_ID,
      actorId: 'lyl', conversationId, status: 'active', accessMode: 'conversation',
    },
    workspace,
    request: validateTaskspaceAction({
      action: 'prepare-task', operation: 'propose', lookup,
      expectedExecutionId: readonly.executionId, expectedGeneration: readonly.generation,
      promptText: initialPrompt, proposal,
    }),
    inspectSource: async () => ({ head: HEAD, fingerprint: FINGERPRINT }),
    authorizeProposal: (input) => value.service.prepareConversationTask(input),
    policyPath: POLICY_PATH,
    now: START.getTime(),
  });
  const initialScope = JSON.parse(await readFile(path.join(
    value.root, 'state/conversation-task-scopes/task-001.json',
  ), 'utf8'));
  const acceptanceFile = path.join(value.root, 'state/tasks/task-001.json');
  await rm(acceptanceFile);

  for (const [relative, content] of [
    [taskPaths.page, '<template><main>Security guard</main></template>\n'],
    [taskPaths.migration, 'INSERT INTO sys_menu(name) VALUES (\'security-guard\');\n'],
    [taskPaths.test, 'final class SecurityMenuMigrationTest {}\n'],
  ]) {
    await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await writeFile(path.join(workspace, relative), content);
  }
  const changedFiles = proposal.ownedPaths.map((relative) => path.join(workspace, relative));
  const beforeRecovery = await Promise.all(changedFiles.map((file) => readFile(file)));
  const currentFingerprint = createHash('sha256').update(Buffer.concat(beforeRecovery)).digest('hex');

  const managerToken = 'm'.repeat(64);
  const manager = createConversationManager({
    projectRoot: value.root,
    projectSlug: 'forge-project',
    intakeRoot: path.join(value.root, 'intake'),
    controlScript: path.join(value.root, 'taskspacectl.sh'),
    managerToken,
    auditPath: path.join(value.root, 'manager-audit.jsonl'),
    runControl: async () => ({ code: 0, signal: null, stdout: '', stderr: '' }),
    acceptanceControlClient: (body) => value.service.issueContract(body),
    executionAuthorityClient: (body) => value.service.issueExecutionAuthority(body),
    sourceObservationClient: async () => ({
      schemaVersion: 1,
      observationType: 'forge-verify/source',
      projectSlug: 'forge-project',
      taskId,
      source: { head: HEAD, fingerprint: currentFingerprint, snapshotSha256: currentFingerprint },
    }),
  });
  await mkdir(path.join(value.root, 'intake'));
  await writeFile(path.join(value.root, 'taskspacectl.sh'), '#!/bin/sh\nexit 0\n');
  await listen(manager);
  t.after(async () => {
    await new Promise((resolve) => manager.close(resolve));
    await value.cleanup();
  });

  const nextRpcId = 'rpc-r78-recovery';
  const nextPrompt = '继续';
  const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
    type: 'client-request',
    rpcId: nextRpcId,
    method: 'session.prompt',
    payload: { sessionId: dshSessionId, mode: 'queue', content: [{ type: 'text', text: nextPrompt }] },
  })), 'session.prompt');
  const response = await requestManagerJson(manager, managerToken, `/v1/taskspaces/${taskId}/executions/prepare`, {
    ...classified,
    projectSlug: 'forge-project',
    taskId,
    actorUserId: ACTOR_USER_ID,
    actorUsername: 'lyl',
    conversationId,
    requestId: 'request-r78-recovery',
    workspaceWriteAuthorized: true,
  });
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  const recovered = response.body.execution;
  assert.equal(recovered.authorityClass, 'production-task-writer');
  assert.equal(recovered.generation, prepared.context.generation + 1);
  assert.equal(recovered.workspaceFingerprint, currentFingerprint);
  assert.deepEqual(recovered.ownedPaths, prepared.context.ownedPaths);
  assert.deepEqual(recovered.taskProfiles, prepared.context.taskProfiles);

  const recoveredScope = JSON.parse(await readFile(path.join(
    value.root, 'state/conversation-task-scopes/task-001.json',
  ), 'utf8'));
  assert.deepEqual(recoveredScope.ownedPaths, initialScope.ownedPaths);
  assert.deepEqual(recoveredScope.taskProfiles, initialScope.taskProfiles);
  assert.deepEqual(await Promise.all(changedFiles.map((file) => readFile(file))), beforeRecovery);
  const record = await value.service.readRecord(taskId);
  assert.equal(record.taskContract.contractId, recovered.contractId);
  assert.equal(record.acceptanceContract.candidate.authorId, ACTOR_USER_ID);
  assert.deepEqual(record.acceptanceContract.candidate.source, {
    head: HEAD,
    fingerprint: currentFingerprint,
  });

  await expectCode('ACCEPTANCE_CANDIDATE_BINDING_MISMATCH', value.service.bindCandidate({
    taskId,
    contractId: prepared.context.contractId,
    candidateBinding: candidateBinding(prepared.context),
    admissionReceipt: hostAdmissionReceipt({ fingerprint: currentFingerprint }),
  }));
  const rebound = await value.service.bindCandidate({
    taskId,
    contractId: recovered.contractId,
    candidateBinding: candidateBinding(recovered),
    admissionReceipt: hostAdmissionReceipt({ fingerprint: currentFingerprint }),
  });
  assert.equal(rebound.acceptanceContract.contractId, recovered.contractId);
  assert.equal(rebound.acceptanceContract.candidate.source.fingerprint, currentFingerprint);
});

test('feature-off keeps legacy authority behavior and rejects the new preparation operation', async (t) => {
  const value = await fixture({ enabled: false });
  t.after(() => value.cleanup());
  assert.deepEqual(
    Object.keys(createProtectedAcceptanceServers(value.service)),
    ['control', 'issuer', 'resolver'],
  );
  const issue = issueInput('安保模块当前放在哪里');
  const result = await value.service.issueExecutionAuthority(issue);
  assert.equal(result.authority, null);
  await assert.rejects(readFile(path.join(
    value.root,
    'state/conversation-task-requests/task-001.json',
  ), 'utf8'), { code: 'ENOENT' });
  await expectCode(
    'CONVERSATION_TASK_PREPARATION_DISABLED',
    value.service.prepareConversationTask(prepareInput(issue)),
  );
});

test('config-on keeps legacy writer behavior for runtimes without preparation support', async (t) => {
  const values = await Promise.all([fixture(), fixture()]);
  t.after(async () => Promise.all(values.map((value) => value.cleanup())));

  for (const [index, value] of values.entries()) {
    const issue = issueInput('修改前端管理页面', {
      rpcId: `rpc-legacy-${index}`,
      conversationTaskPreparationSupported: index === 0 ? false : undefined,
    });
    if (index === 1) delete issue.conversationTaskPreparationSupported;

    const result = await value.service.issueExecutionAuthority(issue);
    assert.ok(result.authority);
    assert.equal(result.trustedPolicyInput.profile, 'production-controller');
    assert.equal(result.trustedPolicyInput.taskAuthority.actionCeiling, 'workspace-write');
    assert.deepEqual(result.trustedPolicyInput.taskAuthority.ownedPaths, ['forge-admin-ui/src']);
    await assert.rejects(readFile(path.join(
      value.root,
      'state/conversation-task-requests/task-001.json',
    ), 'utf8'), { code: 'ENOENT' });
  }
});

function requestJson(server, route, body) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: route,
      headers: { 'content-type': 'application/json' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

function requestManagerJson(server, token, route, body) {
  const address = server.address();
  const encoded = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: route,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': encoded.length,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.on('error', reject);
    request.end(encoded);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

test('the scope server alone exposes POST /v1/conversation-task and resolver remains read-only', async (t) => {
  const value = await fixture();
  const servers = createProtectedAcceptanceServers(value.service);
  t.after(async () => {
    await Promise.all(Object.values(servers).map((server) =>
      new Promise((resolve) => server.close(resolve))));
    await value.cleanup();
  });
  await Promise.all([listen(servers.scope), listen(servers.resolver)]);
  const issue = issueInput('创建安保模块', { rpcId: `rpc-http-${randomUUID()}` });
  await value.service.issueExecutionAuthority(issue);

  const scopeResponse = await requestJson(servers.scope, '/v1/conversation-task', prepareInput(issue));
  assert.equal(scopeResponse.statusCode, 200);
  assert.equal(scopeResponse.body.result.status, 'inspected');
  const resolverResponse = await requestJson(servers.resolver, '/v1/conversation-task', prepareInput(issue));
  assert.equal(resolverResponse.statusCode, 404);
  assert.equal(resolverResponse.body.error.code, 'NOT_FOUND');
});

test('a freshly authorized release continuation reopens only its exact expired candidate window', async (t) => {
  const value = await fixture();
  t.after(() => value.cleanup());
  const original = issueInput('发布', { authorizedActionCeiling: 'release' });
  await value.service.issueExecutionAuthority(original);
  const prepared = await value.service.prepareConversationTask(prepareInput(original, 'propose'));
  const before = await value.service.readRecord(original.taskId);
  const bindingFor = (authority) => candidateBinding({ ...authority,
    authorityClass: 'production-task-writer', executionId: EXECUTION_ID, generation: 1,
    productionAuthorityId: authority.authorityId });
  const now = START.getTime() + 16 * 60_000;
  value.setNow(now);
  const admissionReceipt = hostAdmissionReceipt({ fingerprint: 'e'.repeat(64), issuedAt: new Date(now) });
  await assert.rejects(value.service.bindCandidate({ taskId: original.taskId, contractId: before.taskContract.contractId,
    candidateBinding: bindingFor(prepared.authorityResult.authority), admissionReceipt }),
  { code: 'ACCEPTANCE_CANDIDATE_BINDING_MISMATCH' });
  const fresh = await value.service.issueExecutionAuthority(issueInput('发布', {
    rpcId: 'rpc-fresh-release-after-expiry', authorizedActionCeiling: 'release',
  }));
  assert.equal(fresh.authority.actionCeiling, 'release');
  assert.equal(fresh.authority.contractId, before.taskContract.contractId);
  await value.service.bindCandidate({ taskId: original.taskId, contractId: before.taskContract.contractId,
    candidateBinding: bindingFor(fresh.authority), admissionReceipt });
  const after = await value.service.readRecord(original.taskId);
  assert.equal(after.taskContract.contractId, before.taskContract.contractId);
  assert.equal(after.taskContract.actionCeiling, 'release');
  assert.ok(Date.parse(after.acceptanceContract.expiresAt) > now);
  assert.deepEqual(after.acceptanceContract.candidate.source, { head: HEAD, fingerprint: 'e'.repeat(64) });
  assert.deepEqual(after.receipts, []);
  assert.equal(after.signedVerdict, null);
});

for (const actionCeiling of ['workspace-write', 'git-checkpoint', 'release']) test(`an expired active task renews only its current authorized ceiling (${actionCeiling})`, async (t) => {
  let runtimeNow = START.getTime();
  t.mock.method(Date, 'now', () => runtimeNow);
  const authorityRequests = [];
  let currentCeiling = actionCeiling;
  let authorityFailure;
  const value = await fixture({ currentExecutionAuthority: async (request) => {
    authorityRequests.push(request);
    if (authorityFailure instanceof Error) throw authorityFailure;
    if (authorityFailure) return { ...request, ...authorityFailure };
    return { ...request, authorizedActionCeiling: currentCeiling, checkedAt: new Date(runtimeNow).toISOString() };
  } });
  t.after(() => value.cleanup());
  const input = issueInput(actionCeiling === 'release' ? '修复安保页面并发布。'
    : actionCeiling === 'git-checkpoint' ? '提交代码：修复安保页面。' : '修复安保页面', { authorizedActionCeiling: actionCeiling });
  await value.service.issueExecutionAuthority(input);
  const prepared = await value.service.prepareConversationTask(prepareInput(input, 'propose'));
  const taskMetadata = { schemaVersion: 2, projectSlug: input.projectSlug, taskId: input.taskId,
    actorUserId: input.actorUserId, actorId: input.actorUsername, conversationId: input.conversationId,
    status: 'active', accessMode: 'conversation' };
  const request = { ...classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
    type: 'client-request', rpcId: input.rpcId, method: 'session.prompt',
    payload: { sessionId: input.dshSessionId, mode: 'queue', content: [{ type: 'text', text: input.promptText }] },
  })), 'session.prompt'), actorUserId: input.actorUserId, actorUsername: input.actorUsername,
    conversationId: input.conversationId, requestId: 'renewal-test-request' };
  const context = await prepareProtectedExecutionContext({ projectRoot: value.root,
    projectSlug: input.projectSlug, taskMetadata, request, policyPath: POLICY_PATH,
    trustedPolicyInput: prepared.authorityResult.trustedPolicyInput, now: START.getTime() });
  const lookup = Object.fromEntries(['projectSlug', 'taskId', 'conversationId', 'actorUserId',
    'dshSessionId', 'rpcId', 'textDigest'].map((key) => [key, context[key]]));
  let runtimeContext = await readProtectedExecutionContext({ projectRoot: value.root, taskMetadata, lookup, now: START.getTime() });
  const handlers = new Map();
  const contextRequests = [];
  const projectionStore = new ForgeExecutionStore({ root: path.join(value.root, 'execution-projection') });
  const controller = installPhaseBudgetGuard({ on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } } }, (message) => ({ role: 'user', ...message }), {
    executionStore: projectionStore,
    resolveExecutionContext: async (call) => {
      contextRequests.push(call.decision.messages);
      if (Date.parse(runtimeContext.expiresAt) <= runtimeNow) {
        runtimeContext = await readProtectedExecutionContext({ projectRoot: value.root, taskMetadata, lookup, now: runtimeNow,
          renew: () => value.service.renewConversationExecution(renewalInput) });
      }
      return runtimeContext;
    },
  });
  const agent = { session: { id: input.dshSessionId }, steer() {}, cancel() {} };
  await handlers.get('agent/pre-step')({ agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [{ source: { kind: 'user', rpcId: input.rpcId },
      content: [{ type: 'text', text: input.promptText }] }] }));
  const runtimeState = controller.states.get(agent);
  const draft = { name: 'edit', arguments: { path: taskPaths.page }, callId: 'already-saved-draft', agent };
  const draftDecision = await handlers.get('tools/pre-execute')(draft, async () => ({ kind: 'allow' }));
  assert.equal(draftDecision.kind, 'allow', draftDecision.reason);
  await handlers.get('tools/result')(draft, { output: 'saved', isError: false });
  const projection = await projectionStore.read(context.executionId);
  assert.equal(projection.state.admission, null);
  assert.equal(projection.state.phase, 'IMPLEMENT_INCREMENT');
  assert.equal(projection.state.budgets.used.mutations, 1);
  assert.ok(closeoutBlockers(runtimeState).length > 0);
  const outside = { ...draft, callId: 'outside-draft', arguments: { path: 'ops/project.env' } };
  assert.equal((await handlers.get('tools/pre-execute')(outside, async () => ({ kind: 'allow' }))).kind, 'deny');
  const recordBefore = await value.service.readRecord(input.taskId);
  const initialRenewalInput = { ...Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'promptTextDigest'].map((key) => [key, input[key]])),
    contractId: context.contractId, source: { ...input.source } };
  await value.service.renewConversationExecution(initialRenewalInput);
  assert.equal(authorityRequests.length, 0, 'an unchanged valid lease needs no current-account query');
  const now = START.getTime() + 16 * 60_000;
  value.setNow(now);
  runtimeNow = now;
  const renewalInput = { ...Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'actorUsername',
    'conversationId', 'dshSessionId', 'rpcId', 'promptTextDigest'].map((key) => [key, input[key]])),
    contractId: context.contractId, source: { head: HEAD, fingerprint: 'e'.repeat(64) } };
  for (const [key, bad] of [['rpcId', 'other-rpc'], ['actorUserId', '99999999-9999-4999-8999-999999999999'],
    ['dshSessionId', 'other-session'], ['contractId', 'f'.repeat(64)]]) {
    await assert.rejects(value.service.renewConversationExecution({ ...renewalInput, [key]: bad }),
      (error) => error.code === 'CONVERSATION_EXECUTION_RENEWAL_DENIED');
  }
  assert.equal(authorityRequests.length, 0, 'identity mismatches fail before querying current authority');
  if (actionCeiling === 'release') {
    const oldGrant = await value.service.readProductionTaskGrant(input.taskId, { allowExpired: true });
    for (const unavailable of [new Error('socket unavailable'),
      { authorizedActionCeiling: 'release', checkedAt: START.toISOString() },
      { authorizedActionCeiling: 'release', checkedAt: new Date(runtimeNow).toISOString(), rpcId: 'other-rpc' }]) {
      authorityFailure = unavailable;
      await assert.rejects(value.service.renewConversationExecution(renewalInput),
        { code: 'CONVERSATION_EXECUTION_AUTHORITY_UNAVAILABLE', retryable: true });
      assert.deepEqual(await value.service.readProductionTaskGrant(input.taskId, { allowExpired: true }), oldGrant);
    }
    authorityFailure = Object.assign(new Error('account revoked'), { statusCode: 403 });
    await assert.rejects(value.service.renewConversationExecution(renewalInput),
      { code: 'CONVERSATION_EXECUTION_RENEWAL_DENIED' });
    authorityFailure = undefined;
  }
  if (actionCeiling !== 'workspace-write') {
    currentCeiling = 'workspace-write';
    await assert.rejects(value.service.renewConversationExecution(renewalInput),
      { code: 'CONVERSATION_EXECUTION_RENEWAL_DENIED' });
    currentCeiling = actionCeiling;
  } else {
    currentCeiling = 'release'; // A higher current account ceiling must not elevate the old task.
  }
  const renewed = await readProtectedExecutionContext({ projectRoot: value.root, taskMetadata, lookup, now,
    renew: () => value.service.renewConversationExecution(renewalInput) });
  runtimeContext = renewed;
  await handlers.get('agent/pre-step')({ agent, turn: 1, step: 2, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }));
  assert.equal(contextRequests.length, 2);
  assert.deepEqual(contextRequests[1], []);
  assert.equal(controller.states.get(agent), runtimeState);
  assert.equal(runtimeState.mutationCount, 1);
  assert.ok(runtimeState.settledWriterCalls.has('already-saved-draft'));
  assert.equal(runtimeState.executionContextExpiresAt, renewed.expiresAt);
  assert.equal(renewed.executionId, context.executionId);
  assert.equal(renewed.generation, context.generation);
  assert.equal(renewed.contractId, context.contractId);
  assert.equal(renewed.rpcId, context.rpcId);
  assert.deepEqual(renewed.contract, context.contract);
  assert.equal(renewed.actionCeiling, actionCeiling);
  assert.equal(Date.parse(renewed.expiresAt) - Date.parse(renewed.issuedAt), 900_000);
  assert.equal(authorityRequests.at(-1).actionCeiling, actionCeiling);
  assert.equal(authorityRequests.at(-1).rpcId, context.rpcId);
  assert.equal(renewed.workspaceFingerprint, renewalInput.source.fingerprint);
  assert.ok(Date.parse(renewed.expiresAt) > now);
  assert.notEqual(renewed.productionAuthorityDigest, context.productionAuthorityDigest);
  assert.deepEqual(await value.service.readRecord(input.taskId), recordBefore);
  await value.service.bindCandidate({ taskId: input.taskId, contractId: renewed.contractId,
    candidateBinding: candidateBinding(renewed),
    admissionReceipt: hostAdmissionReceipt({ fingerprint: renewalInput.source.fingerprint, issuedAt: new Date(now) }) });
  const rebound = await value.service.readRecord(input.taskId);
  assert.equal(rebound.signedVerdict, null);
  assert.equal(rebound.receipts.length, 0);
  assert.deepEqual(rebound.acceptanceContract.candidate.source, renewalInput.source);
  assert.deepEqual(await value.service.renewConversationExecution(renewalInput),
    await value.service.renewConversationExecution(renewalInput));
  await assert.rejects(prepareProtectedExecutionContext({ projectRoot: value.root, projectSlug: input.projectSlug,
    taskMetadata, request, policyPath: POLICY_PATH, now,
    trustedPolicyInput: (await value.service.renewConversationExecution(renewalInput)).trustedPolicyInput }),
    (error) => error.code === 'EXECUTION_CONTEXT_REPLAY_REQUIRES_READBACK');
  if (actionCeiling === 'release') {
    runtimeNow += 16 * 60_000;
    value.setNow(runtimeNow);
    const beforeToolExpiry = runtimeState.executionContextExpiresAt;
    const releaseCall = { name: 'bash', arguments: { command: 'forge-release release --services forge-admin' },
      callId: 'release-after-model-thought-crossed-ttl', agent };
    const releaseDecision = await handlers.get('tools/pre-execute')(releaseCall, async () => ({ kind: 'allow' }));
    assert.ok(Date.parse(runtimeState.executionContextExpiresAt) > runtimeNow, JSON.stringify(releaseDecision));
    assert.notEqual(runtimeState.executionContextExpiresAt, beforeToolExpiry);
    assert.equal(runtimeState.actionCeiling, 'release');
    assert.equal(runtimeState.mutationCount, 1);
    assert.ok(closeoutBlockers(runtimeState).length > 0, 'renewal is not acceptance or completion');
  }
  await value.service.issueExecutionAuthority(issueInput('只读检查，暂停修改', { rpcId: 'rpc-cancel-renewal',
    source: renewalInput.source }));
  await assert.rejects(value.service.renewConversationExecution(renewalInput),
    (error) => error.code === 'CONVERSATION_EXECUTION_RENEWAL_DENIED');
});
