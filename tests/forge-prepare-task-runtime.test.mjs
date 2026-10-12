import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createBrokerPrepareTaskClient,
  materializePrepareTaskArguments,
  registerPrepareTaskTool,
  validatePrepareTaskArguments,
  validatePrepareTaskResult,
} from '../docker/harness/forge-prepare-task.mjs';
import {
  createInitialPhaseState,
  installPhaseBudgetGuard,
  prepareTaskDenialReason,
} from '../docker/harness/forge-phase-budget-guard.mjs';
import {
  classifyPinnedDshPromptBody,
  digestProductionTaskAuthorityBinding,
  prepareProtectedExecutionContext,
} from '../docker/harness/forge-execution-context.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';

const base = '0123456789abcdef0123456789abcdef01234567';
const actorUserId = '123e4567-e89b-42d3-a456-426614174000';

test('prepare_task waits within its existing thirty-second bound and never retries an unconfirmed request', async (t) => {
  const tokenFile = '/run/forge-taskspace/prepare-deadline-test-token';
  const read = fs.promises.readFile;
  const tokenRead = t.mock.method(fs.promises, 'readFile', async (file, ...args) => (
    file === tokenFile ? 'synthetic-task-token-'.repeat(3) : read(file, ...args)
  ));
  syncBuiltinESMExports();
  t.after(() => { tokenRead.mock.restore(); syncBuiltinESMExports(); });
  const timeouts = [];
  const setTimeout = http.ClientRequest.prototype.setTimeout;
  t.mock.method(http.ClientRequest.prototype, 'setTimeout', function (milliseconds, callback) {
    timeouts.push({ milliseconds, request: this });
    return setTimeout.call(this, milliseconds, callback);
  });
  let arrival;
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    request.resume();
    request.once('end', () => arrival({ request, response }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const client = createBrokerPrepareTaskClient({
    brokerUrl: `http://127.0.0.1:${server.address().port}/`, tokenFile,
  });
  let accepted = new Promise((resolve) => { arrival = resolve; });
  let settled = false;
  const pending = client({ action: 'prepare-task' }).finally(() => { settled = true; });
  const first = await accepted;
  assert.equal(timeouts[0].milliseconds, 30_000, 'Preparation must not retain the obsolete ten-second cutoff.');
  assert.equal(settled, false, 'A dispatched request remains pending until the controlled HTTP response.');
  const prepared = { status: 'prepared', summary: 'Task preparation completed.', currentTask: null,
    availableScopes: [], context: { executionId: 'prepared-once', generation: 35 } };
  first.response.end(JSON.stringify({ ok: true, result: prepared }));
  assert.deepEqual(await pending, prepared);
  assert.equal(requests, 1);

  accepted = new Promise((resolve) => { arrival = resolve; });
  const expired = client({ action: 'prepare-task' });
  const rejected = assert.rejects(expired, /PREPARE_TASK_TIMEOUT: internal Broker request timed out/);
  const second = await accepted;
  assert.equal(timeouts[1].milliseconds, 30_000);
  const closed = new Promise((resolve) => second.response.once('close', resolve));
  // Trigger the actual request's timeout event instead of waiting thirty seconds.
  timeouts[1].request.emit('timeout');
  await rejected;
  await closed;
  assert.equal(requests, 2, 'An unknown result must not issue another prepare request.');
});

test('prepare_task available scopes consume the producer limit through the public inspect tool', async () => {
  for (const count of [69, 256]) {
    const ownedPaths = Array.from({ length: count }, (_, index) =>
      `forge-server/forge-business/forge-business-core/src/main/java/example/Display${String(index).padStart(3, '0')}.java`);
    const scope = compileForgeTaskExecutionContract({ prompt: 'Configured workspace source scope',
      actionCeiling: 'workspace-write', taskProfiles: ['backend'], ownedPaths });
    let definition;
    registerPrepareTaskTool({ tools: { register(value) { definition = value; } } }, (value) => value, async (args) => {
      assert.deepEqual(args, { operation: 'inspect' });
      return { status: 'inspected', summary: '当前可用写入范围。', currentTask: null,
        availableScopes: [{ taskProfile: 'backend', ownedPaths: scope.ownedPaths }] };
    });
    const result = await definition.execute({ operation: 'inspect' }, {});
    assert.equal(result.status, 'inspected');
    assert.deepEqual(result.availableScopes[0].ownedPaths, ownedPaths);
    assert.equal(Object.hasOwn(result, 'context'), false);
  }
});

test('prepare_task public inspect preserves the strict current-project scope marker', async () => {
  const marker = { taskProfile: 'project-files', scopeRoot: 'current-project', ownedPaths: [] };
  const legacy = { taskProfile: 'backend', ownedPaths: ['forge-server/src'] };
  let definition;
  registerPrepareTaskTool({ tools: { register(value) { definition = value; } } }, (value) => value, async (args) => {
    assert.deepEqual(args, { operation: 'inspect' });
    return { status: 'inspected', summary: '当前可用写入范围。', currentTask: null,
      availableScopes: [marker, legacy] };
  });
  const result = await definition.execute({ operation: 'inspect' }, {});
  assert.deepEqual(result.availableScopes, [marker, legacy]);
  assert.equal(Object.hasOwn(result, 'context'), false);
  assert.equal(Object.isFrozen(result.availableScopes[0].ownedPaths), true);
  const scopeProperties = definition.output.schema.properties.availableScopes.items.properties;
  for (const scope of result.availableScopes) {
    assert.deepEqual(Object.keys(scope).filter((key) => !Object.hasOwn(scopeProperties, key)), []);
  }
  assert.deepEqual(scopeProperties.scopeRoot.enum, ['current-project']);
});

test('prepare_task public inspect rejects malformed scope markers without broadening proposals', async () => {
  const marker = { taskProfile: 'project-files', scopeRoot: 'current-project', ownedPaths: [] };
  for (const scope of [
    { ...marker, scopeRoot: 'other-project' },
    { ...marker, scopeRoot: '/srv/data' },
    { ...marker, taskProfile: 'backend' },
    { ...marker, ownedPaths: ['index.html'] },
    { ...marker, ownedPaths: null },
    { taskProfile: 'project-files', scopeRoot: 'current-project' },
    { ...marker, extra: true },
    { taskProfile: 'project-files', ownedPaths: [] },
    { taskProfile: 'backend', ownedPaths: [] },
  ]) {
    let definition;
    registerPrepareTaskTool({ tools: { register(value) { definition = value; } } }, (value) => value, async () => ({
      status: 'inspected', summary: '当前可用写入范围。', currentTask: null, availableScopes: [scope],
    }));
    await assert.rejects(definition.execute({ operation: 'inspect' }, {}), { code: 'PREPARE_TASK_SCHEMA_INVALID' });
  }
  const proposal = { goal: '修改当前项目中的 HTML 文件。', taskProfiles: ['project-files'],
    ownedPaths: ['index.html'], references: ['README.md'] };
  assert.deepEqual(validatePrepareTaskArguments({ operation: 'propose', proposal }).proposal.ownedPaths, ['index.html']);
  for (const patch of [{ ownedPaths: [] }, { scopeRoot: 'current-project' }]) {
    assert.throws(() => validatePrepareTaskArguments({ operation: 'propose', proposal: { ...proposal, ...patch } }),
      { code: 'PREPARE_TASK_SCHEMA_INVALID' });
  }
});

test('prepare_task available scope bounds distinguish duplicates and preserve proposal limits', () => {
  const paths = (count) => Array.from({ length: count }, (_, index) => `forge-h5-ui/src/pages/page-${index}.vue`);
  const response = (ownedPaths) => ({ status: 'inspected', summary: '当前可用写入范围。', currentTask: null,
    availableScopes: [{ taskProfile: 'shared-owner', ownedPaths }] });
  const rejects = (operation, message) => assert.throws(operation,
    error => error.code === 'PREPARE_TASK_SCHEMA_INVALID' && error.message === message);
  rejects(() => validatePrepareTaskResult(response(paths(257))),
    'prepare_task available scope.ownedPaths must contain between 1 and 256 strings.');
  rejects(() => validatePrepareTaskResult(response([...paths(68), paths(1)[0]])),
    'prepare_task available scope.ownedPaths must contain unique strings.');
  rejects(() => validatePrepareTaskResult(response([''])),
    'prepare_task available scope.ownedPaths must contain non-empty strings.');
  const proposal = ownedPaths => ({ operation: 'propose', proposal: { goal: '实现移动端固定显示双语。',
    taskProfiles: ['shared-owner'], ownedPaths, references: ['forge-h5-ui/src/pages/page-0.vue'] } });
  assert.deepEqual(validatePrepareTaskArguments(proposal(paths(64))).proposal.ownedPaths, paths(64));
  rejects(() => validatePrepareTaskArguments(proposal(paths(65))),
    'prepare_task proposal.ownedPaths must contain between 1 and 64 strings.');
  rejects(() => validatePrepareTaskArguments(proposal([...paths(1), ...paths(1)])),
    'prepare_task proposal.ownedPaths must contain unique strings.');
});

test('dual review prepare tool hashes the selected reference and rejects unread or caller-supplied verdicts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-prepare-dual-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'forge-admin-ui'));
  const sourcePath = 'forge-admin-ui/review-contract.json';
  await writeFile(path.join(root, sourcePath), '{}');
  const args = { operation: 'propose', proposal: { goal: '修复当前页面并独立双评审',
    ownedPaths: ['forge-admin-ui/src/views/example.vue'], taskProfiles: ['frontend-admin'],
    references: [sourcePath], reviewContractSource: sourcePath } };
  const prepared = await materializePrepareTaskArguments(args, { workspaceRoot: root });
  assert.equal(prepared.proposal.reviewContractSource, sourcePath);
  assert.deepEqual(prepared.proposal.references, [{ path: sourcePath,
    sha256: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a' }]);
  for (const patch of [{ reviewContractSource: 'forge-admin-ui/unread.json' }, { specVerdict: 'pass' }, { reviewerId: 'self' }]) {
    await assert.rejects(materializePrepareTaskArguments({ ...args, proposal: { ...args.proposal, ...patch } }, { workspaceRoot: root }),
      { code: 'PREPARE_TASK_SCHEMA_INVALID' });
  }
});

function toolExec(operation, agent = undefined) {
  return { name: 'prepare_task', arguments: { operation }, agent, callId: `prepare-${operation}` };
}

function readyOrdinaryState(authorityClass = 'production-read-only') {
  const state = createInitialPhaseState({ maxSteps: 40 });
  state.executionContextStatus = 'ready';
  state.protectedExecutionContextValidated = true;
  state.executionIdentity = { taskId: 'task-one', executionId: 'execution-one', contractId: 'a'.repeat(64) };
  state.executionContextExpiresAt = new Date(Date.now() + 60_000).toISOString();
  state.executionAuthorityClass = authorityClass;
  state.executionTestOnly = false;
  state.executionWorkflowId = null;
  return state;
}

test('prepare_task hashes model-supplied reference paths at runtime and never exposes raw context', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-prepare-task-'));
  try {
    await writeFile(path.join(root, 'menu-utils.js'), 'export const menu = true;\n');
    const materialized = await materializePrepareTaskArguments({
      operation: 'propose',
      proposal: {
        goal: 'Create the security navigation module.',
        ownedPaths: ['forge-admin-ui/src'],
        taskProfiles: ['frontend-admin'],
        references: ['menu-utils.js'],
      },
    }, { workspaceRoot: root });
    assert.deepEqual(materialized.proposal.references, [{
      path: 'menu-utils.js',
      sha256: '5362c9965e6c3122262a208f6100047c5891f7eee77fa704b45715c094fe60ad',
    }]);
    await assert.rejects(
      materializePrepareTaskArguments({
        operation: 'propose',
        proposal: {
          goal: 'Escape', ownedPaths: ['forge-admin-ui/src'], taskProfiles: ['frontend-admin'], references: ['../outside'],
        },
      }, { workspaceRoot: root }),
      (error) => error.code === 'PREPARE_TASK_REFERENCE_INVALID',
    );

    let definition;
    registerPrepareTaskTool({ tools: { register(value) { definition = value; } } }, (value) => value, async (args) => {
      assert.equal(args.proposal.references[0].sha256.length, 64);
      return {
        status: 'prepared',
        summary: 'Prepared one bounded task.',
        currentTask: { goal: args.proposal.goal, ownedPaths: args.proposal.ownedPaths, taskProfiles: args.proposal.taskProfiles },
        availableScopes: [{ taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] }],
        context: { private: true },
      };
    }, { workspaceRoot: root });
    const output = await definition.execute({
      operation: 'propose',
      proposal: {
        goal: 'Create the security navigation module.',
        ownedPaths: ['forge-admin-ui/src'],
        taskProfiles: ['frontend-admin'],
        references: ['menu-utils.js'],
      },
    }, {});
    assert.equal(definition.name, 'prepare_task');
    assert.equal(output.status, 'prepared');
    assert.equal(Object.hasOwn(output, 'context'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prepare_task guard is ordinary-only and explicit read-only permits inspect but rejects propose', () => {
  const ordinary = readyOrdinaryState();
  assert.equal(prepareTaskDenialReason(ordinary, toolExec('inspect')), undefined);
  assert.equal(prepareTaskDenialReason(ordinary, toolExec('propose')), undefined);

  ordinary.promptReadOnlyConstraint = true;
  assert.equal(prepareTaskDenialReason(ordinary, toolExec('inspect')), undefined);
  assert.match(prepareTaskDenialReason(ordinary, toolExec('propose')), /explicitly requires read-only/u);

  const governed = readyOrdinaryState();
  governed.executionWorkflowId = 'crud-production';
  assert.match(prepareTaskDenialReason(governed, toolExec('inspect')), /ordinary conversations/u);

  const changedWriter = readyOrdinaryState('production-task-writer');
  changedWriter.mutationCount = 1;
  changedWriter.mutationSequence = 1;
  assert.match(prepareTaskDenialReason(changedWriter, toolExec('propose')), /after source mutation/u);
});

test('an empty tool-continuation step cannot erase the direct prompt read-only constraint', async () => {
  const handlers = new Map();
  const controller = installPhaseBudgetGuard({
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  }, (input) => ({ role: 'user', ...input }), {
    admitExecution: undefined,
    resolveExecutionContext: undefined,
    prepareTaskClient: undefined,
  });
  const agent = { session: { id: 'session-read-only', events: [] }, steer() {}, cancel() {} };
  const state = controller.stateFor(agent, 1);
  state.prompt = '只读检查当前实现';
  state.promptReadOnlyConstraint = true;

  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 2, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  );

  assert.equal(controller.states.get(agent).promptReadOnlyConstraint, true);
});

async function protectedTransitionFixture(root, actionCeiling = 'workspace-write') {
  const prompt = '仅在导航栏创建安保模块即可，放至领导引领力后面';
  const rpcId = '123e4567-e89b-42d3-a456-426614174111';
  const sessionId = 'session-one';
  const conversationId = 'conversation:prepare-task:001';
  const content = [{ type: 'text', text: prompt }];
  const request = {
    ...classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
      type: 'client-request', rpcId, method: 'session.prompt',
      payload: { sessionId, mode: 'queue', content },
    })), 'session.prompt'),
    requestId: 'request-prepare-task',
    actorUserId,
    actorUsername: 'alice',
    conversationId,
  };
  const metadata = {
    schemaVersion: 2,
    projectSlug: 'forge-project',
    taskId: 'task-one',
    actorId: 'alice',
    actorUserId,
    conversationId,
    accessMode: 'conversation',
    status: 'active',
  };
  const policyPath = path.resolve('docker/harness/forge-execution-policy.json');
  const initial = await prepareProtectedExecutionContext({
    projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata, request, policyPath,
  });
  const taskAuthority = {
    actionCeiling,
    ownedPaths: ['forge-admin-ui/src'],
    taskProfiles: ['frontend-admin'],
  };
  const contract = compileForgeTaskExecutionContract({ prompt, ...taskAuthority });
  const sourceFingerprint = 'b'.repeat(64);
  const productionAuthorityId = '123e4567-e89b-42d3-a456-426614174222';
  const controllerGrantDigest = 'c'.repeat(64);
  const trustedPolicyInput = {
    profile: 'production-controller',
    sourceCommit: base,
    workspaceFingerprint: sourceFingerprint,
    caseFamily: 'maintenance',
    productionAuthorityId,
    productionAuthorityDigest: digestProductionTaskAuthorityBinding({
      projectSlug: metadata.projectSlug,
      taskId: metadata.taskId,
      actorUserId,
      actorUsername: 'alice',
      conversationId,
      dshSessionId: request.dshSessionId,
      route: request.route,
      rpcId: request.rpcId,
      promptDigest: request.textDigest,
      sourceCommit: base,
      workspaceFingerprint: sourceFingerprint,
      caseFamily: 'maintenance',
      productionAuthorityId,
      controllerGrantDigest,
      contractId: contract.contractId,
      actionCeiling: taskAuthority.actionCeiling,
      ownedPaths: taskAuthority.ownedPaths,
    }),
    controllerGrantDigest,
    expectedContractId: contract.contractId,
    taskAuthority,
  };
  const prepared = await prepareProtectedExecutionContext({
    projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata, request, policyPath,
    trustedPolicyInput,
  });
  const strip = ({ idempotent: _idempotent, refreshed: _refreshed, ...context }) => context;
  return { prompt, content, request, metadata, initial: strip(initial), prepared: strip(prepared), contract };
}

for (const actionCeiling of ['workspace-write', 'release']) test(`prepared ordinary task binds a strictly newer generation in the same DSH turn and refreshes admission (${actionCeiling})`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-prepare-transition-'));
  try {
    const fixture = await protectedTransitionFixture(root, actionCeiling);
    const handlers = new Map();
    const brokerRequests = [];
    let admissionCalls = 0;
    const controller = installPhaseBudgetGuard({
      on(name, handler) { handlers.set(name, handler); },
      tools: { guard() { return () => {}; } },
    }, (input) => ({ role: 'user', ...input }), {
      resolveExecutionContext: async () => structuredClone(fixture.initial),
      prepareTaskClient: async (request) => {
        brokerRequests.push(structuredClone(request));
        if (request.operation === 'inspect') {
          return {
            status: 'inspected',
            summary: 'Current bounded task.',
            currentTask: {
              goal: 'Create the security navigation module.',
              ownedPaths: fixture.contract.ownedPaths,
              taskProfiles: fixture.contract.taskProfiles,
            },
            availableScopes: [{ taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] }],
          };
        }
        return {
          status: 'prepared',
          summary: 'Prepared the bounded frontend task.',
          currentTask: {
            goal: 'Create the security navigation module.',
            ownedPaths: fixture.contract.ownedPaths,
            taskProfiles: fixture.contract.taskProfiles,
          },
          availableScopes: [{ taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] }],
          context: structuredClone(fixture.prepared),
        };
      },
      admitExecution: async (profiles) => {
        admissionCalls += 1;
        return {
          schemaVersion: 2,
          receiptType: 'forge-verify/host-execution-admission',
          outcome: 'ready',
          admissionId: '123e4567-e89b-42d3-a456-426614174333',
          profiles: [...profiles],
          source: { workspaceFingerprint: fixture.prepared.workspaceFingerprint, dependencyManifestFingerprint: 'd'.repeat(64) },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          toolchain: { digest: 'e'.repeat(64) },
          profilePolicyDigest: 'f'.repeat(64),
        };
      },
    });
    const agent = { session: { id: fixture.request.dshSessionId, events: [] }, steer() {}, cancel() {} };
    await handlers.get('agent/pre-step')(
      { agent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({
        kind: 'enter',
        messages: [{ role: 'user', source: { kind: 'user', rpcId: fixture.request.rpcId }, content: fixture.content }],
      }),
    );
    const originalState = controller.states.get(agent);
    const result = await controller.prepareTask({
      operation: 'propose',
      proposal: {
        goal: 'Create the security navigation module.',
        ownedPaths: fixture.contract.ownedPaths,
        taskProfiles: fixture.contract.taskProfiles,
        references: [{
          path: 'forge-admin-ui/src/utils/menu-utils.js',
          sha256: '1'.repeat(64),
        }],
      },
    }, { agent, name: 'prepare_task', callId: 'prepare-one' });

    assert.equal(result.status, 'prepared');
    const brokerRequest = brokerRequests[0];
    assert.equal(brokerRequest.action, 'prepare-task');
    assert.equal(brokerRequest.expectedGeneration, fixture.initial.generation);
    assert.equal(brokerRequest.expectedExecutionId, fixture.initial.executionId);
    assert.equal(brokerRequest.lookup.actorUserId, actorUserId);
    assert.equal(brokerRequest.lookup.rpcId, fixture.request.rpcId);
    assert.equal(brokerRequest.lookup.textDigest, fixture.request.textDigest);
    assert.equal(brokerRequest.promptText, fixture.prompt);
    assert.deepEqual(brokerRequest.proposal.references, [{
      path: 'forge-admin-ui/src/utils/menu-utils.js',
      sha256: '1'.repeat(64),
    }]);
    const current = controller.states.get(agent);
    assert.notEqual(current, originalState);
    assert.equal(current.executionContextGeneration, fixture.initial.generation + 1);
    assert.equal(current.executionAuthorityClass, 'production-task-writer');
    assert.equal(current.actionCeiling, actionCeiling);
    assert.equal(current.taskContract.actionCeiling, actionCeiling);
    assert.equal(current.verificationAdmission.outcome, 'ready');
    assert.equal(controller.executionStates.size, 2, 'the prior read-only generation remains separately recorded');

    const inspected = await controller.prepareTask(
      { operation: 'inspect' },
      { agent, name: 'prepare_task', callId: 'inspect-current' },
    );
    assert.equal(inspected.status, 'inspected');
    assert.equal(controller.states.get(agent), current);

    const repeated = await controller.prepareTask({
      operation: 'propose',
      proposal: structuredClone(brokerRequest.proposal),
    }, { agent, name: 'prepare_task', callId: 'prepare-repeat' });
    assert.equal(repeated.status, 'prepared');
    assert.equal(brokerRequests[2].expectedExecutionId, fixture.prepared.executionId);
    assert.equal(brokerRequests[2].expectedGeneration, fixture.prepared.generation);
    assert.equal(controller.states.get(agent), current);
    assert.equal(controller.executionStates.size, 2, 'idempotent replay does not create another generation state');
    assert.equal(admissionCalls, 1, 'the current Host admission is reused for the unchanged prepared context');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
