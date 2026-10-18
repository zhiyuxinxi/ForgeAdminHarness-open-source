import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SOURCE_QUALITY_BUNDLE_SHA256, sourceQualityPayload } from '../docker/harness/forge-backend-source-quality.mjs';
import { validateHostRunReceipt } from '../docker/harness/forge-host-verification-receipt.mjs';
import {
  PHASES,
  PHASE_GUARD_MARKER,
  MAX_MUTATIONS_WITHOUT_AUDIT,
  TEST_SHADOW_CANDIDATE_WRITE_MODE,
  actionCeilingForPrompt,
  adaptVerifyRunToRedGateReceipt,
  candidateWriteAdmissionCurrent,
  closeoutBlockers,
  createInitialPhaseState,
  inject,
  installPhaseBudgetGuard as installRuntimePhaseBudgetGuard,
  isMutationExecution,
  modelFacingToolAvailable,
  observeToolResult,
  projectPhaseGuardState,
  refreshExecutionAdmission,
  reminderForState,
  reserveAllowedAttempt,
  toolDenialReason,
} from '../docker/harness/forge-phase-budget-guard.mjs';
import { ForgeExecutionStore } from '../docker/harness/forge-execution-store.mjs';
import { resolveForgeDeliveryPhase } from '../docker/harness/forge-delivery-phase-runtime.mjs';
import {
  classifyPinnedDshPromptBody,
  digestProductionTaskAuthorityBinding,
  prepareProtectedExecutionContext,
} from '../docker/harness/forge-execution-context.mjs';
import { canonicalSha256 } from '../docker/harness/forge-acceptance-aggregator.mjs';
import { sourceTransitionCanonicalDigest } from '../docker/harness/taskspace-policy.mjs';
import {
  compileForgeTaskExecutionContract,
} from '../docker/harness/forge-task-execution-contract.mjs';

// Retain the historical enforcement cases as compatibility evidence.
const installPhaseBudgetGuard = (ctx, message, options = {}) => installRuntimePhaseBudgetGuard(
  ctx, message, { suspendHeuristicStops: false, ...options },
);

test('TODO-119 protected prompt hides unsupported goal and delegation tools without changing free scopes or execution guards', async () => {
  const handlers = new Map();
  const controller = installRuntimePhaseBudgetGuard({
    on(name, handler) { handlers.set(name, handler); }, tools: { guard() {} },
  }, value => value);
  const agent = {}, freeAgent = {};
  const state = controller.stateFor(agent, 1);
  Object.assign(state, { protectedExecutionContextValidated: true, executionContextStatus: 'ready' });
  controller.stateFor(freeAgent, 1);
  const denied = ['create_goal', 'get_goal', 'update_goal', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent'];
  const retained = ['read', 'skill', 'bash', 'prepare_task', 'job_output', 'job_list', 'write', 'some_unreviewed_tool'];
  const assembly = {
    tools: [...denied, ...retained].map(name => ({ name, parameters: {} })),
    sections: ['deployment:persona', 'tool:goal', 'tool:subagent', 'tool:subagent_fork', 'tool:read'].map(name => ({ name, text: name })),
    contexts: [{ name: 'existing', text: 'preserve context' }], variables: { identity: 'same' },
  };
  const downstream = { ...assembly, variables: { ...assembly.variables, downstream: 'preserved' } };
  const assemble = scope => handlers.get('system-prompt/assemble')(assembly, { scope }, async () => downstream);
  const protectedAssembly = await assemble(agent);
  assert.deepEqual(protectedAssembly.tools.map(tool => tool.name), retained);
  assert.deepEqual(protectedAssembly.sections.map(section => section.name), ['deployment:persona', 'tool:read']);
  assert.equal(protectedAssembly.contexts, downstream.contexts);
  assert.equal(protectedAssembly.variables, downstream.variables);
  assert.equal(assembly.tools.length, denied.length + retained.length);
  for (const name of denied) assert.match(toolDenialReason(state, { name, arguments: {} }), /unclassified tool/u);
  assert.match(toolDenialReason(state, { name: 'some_unreviewed_tool', arguments: {} }), /unclassified tool/u);
  assert.equal(await assemble(freeAgent), downstream);
  assert.equal(await assemble({}), downstream);
  assert.equal(await assemble(undefined), downstream);
  // A lease becoming unavailable must not re-advertise unsupported operations.
  state.executionContextStatus = 'unavailable';
  assert.deepEqual((await assemble(agent)).tools.map(tool => tool.name), retained);
});

test('release operation accepted is not verification or completion evidence', () => {
  const state = createInitialPhaseState({ suspendHeuristicStops: true });
  const before = { verificationSequence: state.verificationSequence, evidenceSequence: state.evidenceSequence,
    receiptCount: state.verificationProfileReceipts.size, phase: state.phase };
  observeToolResult(state, { name: 'bash', arguments: { command: 'forge-release release --services forge-ui' } }, {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, result: { operation: 'release', status: 'accepted', terminal: false,
      operationId: '11111111-1111-4111-8111-111111111111' } }) }],
  });
  assert.equal(state.verificationSequence, before.verificationSequence);
  assert.equal(state.evidenceSequence, before.evidenceSequence);
  assert.equal(state.verificationProfileReceipts.size, before.receiptCount);
  assert.equal(state.phase, before.phase);
  assert.equal(state.auditSucceeded, false);
});

test('writer scope projection is bound to the validated current agent session', () => {
  const controller = installRuntimePhaseBudgetGuard({ on() { return () => {}; }, tools: { guard() { return () => {}; } } }, (value) => value);
  const agent = { session: { id: 'session:writer' } };
  const exec = { agent };
  assert.equal(controller.writerScopeContext(exec), null);
  const state = controller.stateFor(agent, 1);
  const contract = { contractId: 'c'.repeat(64), ownedPaths: ['src'], actionCeiling: 'workspace-write' };
  Object.assign(state, {
    protectedExecutionContextValidated: true, executionContextStatus: 'ready',
    executionDshSessionId: agent.session.id, taskContract: contract,
    executionContextExpiresAt: new Date(Date.now() + 60000).toISOString(),
    executionIdentity: { taskId: 'task-a', executionId: '11111111-1111-4111-8111-111111111111' },
    executionContextGeneration: 2, executionProjectSlug: 'forge-base',
    executionActorUserId: '22222222-2222-4222-8222-222222222222', executionConversationId: 'conv:a',
    executionRpcId: 'rpc:a', executionTextDigest: 'd'.repeat(64),
    executionAuthorityClass: 'production-task-writer', executionTestOnly: false,
    actionCeiling: 'workspace-write', executionSourceCommit: 'a'.repeat(40),
    executionWorkspaceFingerprint: 'f'.repeat(64),
  });
  const projected = controller.writerScopeContext(exec);
  assert.equal(projected.contract, contract);
  assert.equal(projected.executionId, state.executionIdentity.executionId);
  assert.equal(projected.generation, 2);
  assert.equal(projected.rpcId, 'rpc:a');
  assert.equal(Object.hasOwn(projected, 'verificationAdmission'), false);
  assert.equal(controller.writerScopeContext({ agent: { session: agent.session } }), null);
  agent.session.id = 'session:other';
  assert.equal(controller.writerScopeContext(exec), null);
  agent.session.id = state.executionDshSessionId;
  state.protectedExecutionContextValidated = false;
  assert.equal(controller.writerScopeContext(exec), null);
  state.protectedExecutionContextValidated = true;
  state.executionContextStatus = 'unavailable';
  assert.equal(controller.writerScopeContext(exec), null);
});

test('runtime default suspends heuristic stops without granting write authority', async () => {
  const handlers = new Map();
  const agent = { session: { events: [] } };
  const controller = installRuntimePhaseBudgetGuard({
    on(name, handler) { handlers.set(name, handler); }, tools: { guard() { return () => {}; } },
  }, (value) => value);
  const state = controller.stateFor(agent, 1);
  assert.equal(state.suspendHeuristicStops, true);
  const read = exec('read', { path: 'forge-server/pom.xml' });
  for (let index = 0; index < 4; index += 1) observeToolResult(state, read, ok('same source'));
  assert.equal(state.progressDecision.decision, 'CONTINUE');
  assert.equal(state.implementationSwitchRequired, false);
  assert.equal(toolDenialReason(state, read), undefined);
  assert.match(toolDenialReason(state, exec('write', { path: 'forge-server/example/Test.java' })), /protected Task Execution Contract/u);
  assert.match(reminderForState(state), /heuristic.*suspended/u);
  const entered = await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 7, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  );
  const notice = entered.messages.at(-1).content[0].text;
  assert.match(notice, /does not report a wall-clock deadline/u);
  assert.match(notice, /do not end an unfinished task merely because you estimate insufficient time/u);
  assert.match(notice, /only when an actual runtime result establishes it/u);
  assert.doesNotMatch(notice, /remaining total budget/u);
  assert.match(toolDenialReason(state, exec('write', { path: 'forge-server/example/Test.java' })), /protected Task Execution Contract/u);
});

test('suspended progress heuristics allow repeated discovery and late authorized writes', () => {
  for (const step of [20, 30, 36, 39]) {
    const state = routedState({ suspendHeuristicStops: true });
    state.currentStep = step;
    const read = exec('read', { path: 'forge-server/pom.xml' });
    for (let index = 0; index < 4; index += 1) observeToolResult(state, read, ok('same source'));
    assert.equal(state.progressDecision.decision, 'CONTINUE');
    assert.equal(state.implementationSwitchRequired, false);
    assert.equal(toolDenialReason(state, read), undefined);
    assert.equal(toolDenialReason(state, exec('skill', { name: 'forge-backend-architecture' })), undefined);
    const write = exec('write', { path: 'forge-server/example/src/test/java/LateTest.java' });
    assert.equal(toolDenialReason(state, write), undefined);
    assert.doesNotMatch(reminderForState(state), /IMPLEMENT NOW|Do not mutate|deadline missed|discovery is closed|before 50%/u);
    state.actionCeiling = 'read-only';
    assert.match(toolDenialReason(state, write), /read-only/u);
    state.actionCeiling = 'workspace-write';
    assert.match(toolDenialReason(state, exec('write', { path: 'outside/OtherTest.java' })), /owned path|owned-path|rejected this mutation/u);
    state.executionContextExpiresAt = new Date(0).toISOString();
    assert.match(toolDenialReason(state, write), /lease expired/u);
  }
});

test('suspended drafting order permits production edits and retains resource exhaustion', () => {
  const state = routedState({ suspendHeuristicStops: true });
  const sourceWrite = exec('edit', { path: 'forge-server/example/src/main/java/Example.java' });
  assert.equal(toolDenialReason(state, sourceWrite), undefined);
  observeToolResult(state, sourceWrite, ok('authorized draft saved'));
  assert.ok(closeoutBlockers(state).includes('typed-verification-profile-missing:backend-module-test'));
  state.currentStep = state.maxSteps;
  const read = exec('read', { path: 'forge-server/pom.xml' });
  for (let index = 0; index < 4; index += 1) observeToolResult(state, read, ok('same source'));
  assert.ok(['STOP', 'ESCALATE_AT_IMMUTABLE_BOUNDARY'].includes(state.progressDecision.decision));
  assert.match(toolDenialReason(state, read), /PHASE_BUDGET_EXHAUSTED|DISCOVERY_GATE_INCOMPLETE/u);
  assert.match(reminderForState(state), /machine progress gate=/u);
});

test('ordinary authorized implementation continues beyond fixed counts while scope and evidence remain enforced', () => {
  const state = routedState({ suspendHeuristicStops: true });
  Object.assign(state, { protectedExecutionContextValidated: true, executionAuthorityClass: 'production-task-writer', executionTestOnly: false, executionWorkflowId: null });
  const write = exec('edit', { path: 'forge-server/example/src/main/java/Example.java' });
  observeToolResult(state, write, ok('authorized implementation'));
  state.currentStep = state.maxSteps + 1;
  state.sequence = state.maxSteps * 2 + 1;
  observeToolResult(state, write, ok('coherent continuation'));
  assert.equal(state.progressDecision.decision, 'CONTINUE');
  assert.equal(toolDenialReason(state, write), undefined);
  assert.ok(closeoutBlockers(state).includes('typed-verification-profile-missing:backend-module-test'));
  assert.match(toolDenialReason(state, exec('edit', { path: 'outside/Other.java' })), /owned path|owned-path|rejected this mutation/u);
  state.actionCeiling = 'read-only';
  assert.match(toolDenialReason(state, write), /read-only/u);
  state.actionCeiling = 'workspace-write';
  state.executionContextExpiresAt = new Date(0).toISOString();
  assert.match(toolDenialReason(state, write), /lease expired/u);
});

test('governed workflow retains its fixed count boundary', () => {
  const state = routedState({ suspendHeuristicStops: true });
  Object.assign(state, { protectedExecutionContextValidated: true, executionAuthorityClass: 'production-task-writer', executionTestOnly: false, executionWorkflowId: 'crud-production' });
  const write = exec('edit', { path: 'forge-server/example/src/main/java/Example.java' });
  observeToolResult(state, write, ok('draft'));
  state.currentStep = state.maxSteps;
  observeToolResult(state, exec('read', { path: 'forge-server/pom.xml' }), ok());
  assert.deepEqual(state.progressDecision.reasonCodes, ['PHASE_BUDGET_EXHAUSTED']);
});

test('suspended fixed audit cadence permits a sixth scoped edit but still requires final governance', () => {
  const state = routedState({ suspendHeuristicStops: true });
  for (let index = 1; index <= 6; index += 1) {
    const write = { ...exec('write', { path: `forge-server/example/src/test/java/Increment${index}Test.java` }), callId: `cadence-${index}` };
    assert.equal(toolDenialReason(state, write), undefined, `scoped mutation ${index}`);
    reserveAllowedAttempt(state, write);
    observeToolResult(state, write, ok(`test increment ${index}`));
  }
  assert.equal(state.mutationCount, 6);
  assert.equal(state.auditSucceeded, false);
  assert.ok(closeoutBlockers(state).includes('final-governance-audit-missing'));
  assert.doesNotMatch(reminderForState(state), /audit before more than 5/u);
  assert.match(toolDenialReason(state, exec('write', { path: 'outside/OtherTest.java' })), /owned path|owned-path|rejected this mutation/u);
});

test('suspended automatic final-only freeze permits scoped repair and invalidates old final evidence', () => {
  const state = routedState({ suspendHeuristicStops: true });
  observeToolResult(state, exec('write', { path: 'forge-server/example/src/test/java/RepairTest.java' }), ok());
  observeToolResult(state, exec('bash', { command: `forge-governance audit --root . --base ${base} --format json` }), ok(governanceReceipt()));
  observeToolResult(state, exec('bash', { command: `forge-verify run --profile backend-module-test --module forge-server/example --admission-id ${admissionId} --idempotency-key closeout-12345678` }), ok(verificationReceipt()));
  observeToolResult(state, exec('skill', { name: 'forge-evidence-truth' }), ok());
  assert.equal(state.phase, PHASES.CLOSEOUT);
  assert.deepEqual(closeoutBlockers(state), []);
  assert.equal(toolDenialReason(state, exec('read', { path: 'forge-server/example/src/test/java/RepairTest.java' })), undefined);
  const repair = { ...exec('edit', { path: 'forge-server/example/src/test/java/RepairTest.java' }), callId: 'late-scoped-repair' };
  assert.equal(toolDenialReason(state, repair), undefined);
  state.actionCeiling = 'read-only';
  assert.match(toolDenialReason(state, repair), /read-only/u);
  state.actionCeiling = 'workspace-write';
  state.executionProjectionRequired = true;
  state.executionProjectionStatus = 'ready';
  state.executionProjectionSnapshot = { state: { terminalOutcome: 'bounded-blocked' } };
  assert.match(toolDenialReason(state, repair), /protected execution reducer stopped/u);
  state.executionProjectionRequired = false;
  reserveAllowedAttempt(state, repair);
  observeToolResult(state, repair, ok('focused correction'));
  assert.equal(state.phase, PHASES.IMPLEMENT);
  assert.ok(closeoutBlockers(state).includes('final-governance-audit-missing'));
  assert.ok(closeoutBlockers(state).includes('typed-verification-profile-missing:backend-module-test'));
});

test('suspended drafting order retains current admission and owned paths without a RED prerequisite', () => {
  const state = createInitialPhaseState({ suspendHeuristicStops: true });
  authorizeWriterState(state);
  const testWrite = exec('write', { path: 'forge-server/example/src/test/java/ScopedTest.java' });
  assert.match(toolDenialReason(state, testWrite), /current batch execution admission/u);
  setReadyAdmission(state);
  assert.equal(toolDenialReason(state, testWrite), undefined);
  assert.equal(state.invokedSkills.size, 0, 'suspension must not fabricate Skill invocation');
  assert.equal(state.routerSequence, 0);
  assert.equal(toolDenialReason(state, exec('edit', { path: 'forge-server/example/src/main/java/Example.java' })), undefined);
  assert.match(toolDenialReason(state, exec('write', { path: 'outside/OtherTest.java' })), /owned path|owned-path|rejected this mutation/u);
  assert.match(reminderForState(state), /Skill.*guidance/u);
  assert.doesNotMatch(reminderForState(state), /Invoke forge-task-router and every routed domain Skill|Exact preflight Skills/u);
  observeToolResult(state, testWrite, ok());
  observeToolResult(state, exec('bash', { command: `forge-governance audit --root . --base ${base} --format json` }), ok(governanceReceipt()));
  observeToolResult(state, exec('bash', { command: `forge-verify run --profile backend-module-test --module forge-server/example --admission-id ${admissionId} --idempotency-key guided-12345678` }), ok(verificationReceipt()));
  assert.deepEqual(closeoutBlockers(state), [], 'actual checks suffice without a closing Skill invocation');
  assert.equal(state.invokedSkills.size, 0);
  state.auditSequence = 0;
  assert.ok(closeoutBlockers(state).includes('final-governance-audit-missing'));
  state.actionCeiling = 'read-only';
  assert.match(toolDenialReason(state, testWrite), /read-only/u);
});

test('suspended fixed edit counts permit coherent repair within the unchanged total tool budget', () => {
  const state = routedState({ suspendHeuristicStops: true });
  observeToolResult(state, exec('write', { path: 'forge-server/example/src/test/java/InitialTest.java' }), ok());
  observeToolResult(state, exec('bash', { command: `forge-verify run --profile backend-module-test --module forge-server/example --admission-id ${admissionId} --idempotency-key repair-count-12345678` }), ok(verificationReceipt('backend-module-test', 'failed')));
  assert.equal(state.repairAvailable, true);
  for (let index = 1; index <= 21; index += 1) {
    const repair = { ...exec('edit', { path: 'forge-server/example/src/test/java/InitialTest.java' }), callId: `repair-count-${index}` };
    assert.equal(toolDenialReason(state, repair), undefined, `repair mutation ${index}`);
    reserveAllowedAttempt(state, repair);
    observeToolResult(state, repair, ok(`coherent repair ${index}`));
  }
  assert.equal(state.mutationCount, 22);
  assert.equal(state.repairMutationCount, 21);
  assert.ok(closeoutBlockers(state).includes('final-governance-audit-missing'));
  state.sequence = state.maxSteps * 2;
  observeToolResult(state, exec('read', { path: 'forge-server/pom.xml' }), ok('budget boundary'));
  assert.deepEqual(state.progressDecision.reasonCodes, ['PHASE_BUDGET_EXHAUSTED']);
  assert.match(toolDenialReason(state, exec('edit', { path: 'forge-server/example/src/test/java/InitialTest.java' })), /PHASE_BUDGET_EXHAUSTED/u);
});

test('runtime plugin declares the tools service it uses', () => {
  assert.deepEqual(inject, ['tools', 'systemPrompt']);
  assert.equal(actionCeilingForPrompt('只读分析这个实现'), 'read-only');
  assert.equal(actionCeilingForPrompt('分析后修复这个实现'), 'workspace-write');
  assert.equal(actionCeilingForPrompt('修复事故调查页面前端常量。不要跑后端验证，本轮只改上述前端常量。'), 'workspace-write');
  assert.equal(actionCeilingForPrompt('修改事故调查页面，检查测试结果'), 'workspace-write');
  assert.equal(actionCeilingForPrompt('修复前端。检查现有类型声明。'), 'workspace-write');
  assert.equal(actionCeilingForPrompt('不要修改数据库迁移/后端，只改前端常量'), 'workspace-write');
  assert.equal(actionCeilingForPrompt('不要修改数据库迁移/后端，只改前端常量并修复页面'), 'workspace-write');
  assert.equal(actionCeilingForPrompt('修复页面，但不要改任何文件'), 'read-only');
  assert.equal(actionCeilingForPrompt('只给修复方案，不要修改代码'), 'read-only');
  assert.equal(actionCeilingForPrompt('分析这个模块'), 'read-only');
  assert.equal(actionCeilingForPrompt('Tell me about this repository'), 'read-only');
});

test('ROUTE notice describes controlled removal only when remove_file is model-visible', async () => {
  const state = createInitialPhaseState({ maxSteps: 80 });
  const visible = {
    systemPrompt: {
      async assemble({ scope }) {
        assert.equal(scope, agent);
        return { tools: [{ name: 'read' }, { name: 'remove_file' }] };
      },
    },
  };
  const agent = { session: { id: 'old-session' } };
  assert.equal(await modelFacingToolAvailable(visible, agent, 'remove_file'), true);
  assert.equal(await modelFacingToolAvailable({ systemPrompt: { async assemble() { return { tools: [{ name: 'read' }] }; } } }, agent, 'remove_file'), false);
  assert.match(
    reminderForState(state, null, { removeFileAvailable: true }),
    /first read\(file_path\), then remove_file\(file_path\).*prior-turn conclusion.*not a current runtime fact/u,
  );
  assert.doesNotMatch(reminderForState(state), /prior-turn conclusion.*deletion tool/u);

  state.actionCeiling = 'read-only';
  assert.match(
    toolDenialReason(state, exec('remove_file', { file_path: 'src/extra.js' })),
    /protected Task Execution Contract/u,
  );
});

for (const suspendHeuristicStops of [false, true]) test(`ordinary validated read-only continuation receives the visible prepare_task sequence and keeps writes denied (suspended=${suspendHeuristicStops})`, async () => {
  const handlers = new Map();
  const agent = { session: { id: 'session-historical-skills', events: [] }, steer() {}, cancel() {} };
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
    systemPrompt: {
      async assemble({ scope }) {
        assert.equal(scope, agent);
        return { tools: [{ name: 'read' }, { name: 'prepare_task' }, { name: 'write' }] };
      },
    },
  };
  const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
    suspendHeuristicStops,
    resolveModelFacingTool: ({ agent: scope, toolName }) => modelFacingToolAvailable(ctx, scope, toolName),
  });
  const state = controller.stateFor(agent, 1);
  const contract = compileForgeTaskExecutionContract({
    prompt: '继续创建安保模块。',
    ownedPaths: [],
    actionCeiling: 'read-only',
  });
  Object.assign(state, {
    executionContextStatus: 'ready',
    executionIdentity: { taskId: 'task-ordinary', executionId: 'execution-read-only', contractId: contract.contractId },
    executionContextExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    executionAuthorityClass: 'production-read-only',
    protectedExecutionContextValidated: true,
    executionTestOnly: false,
    executionWorkflowId: null,
    taskContract: contract,
    taskIntent: contract,
    actionCeiling: 'read-only',
  });
  state.invokedSkills.add('forge-task-contract');
  state.invokedSkills.add('forge-task-router');

  const entered = await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  );
  const notice = entered.messages.at(-1).content[0].text;
  assert.match(
    notice,
    /prepare_task with operation inspect.*bounded repository reads.*prepare_task with operation propose/u,
  );
  assert.match(notice, /Do not propose for a pure question; answer it read-only/u);
  assert.match(notice, /only after prepare_task returns status prepared/u);
  assert.match(notice, /Historical Skills or prior read-only conclusions do not replace this current-turn sequence/u);
  assert.match(notice, /explicitly authorized receipt revalidation/u);
  assert.doesNotMatch(notice, /never probe or refresh admission from the model/iu);
  assert.match(notice, /Do not call forge-verify admit or invent admission IDs/u);
  assert.equal(state.prepareTaskAvailable, true);

  const denial = toolDenialReason(
    state,
    exec('write', { path: 'forge-admin-ui/src/views/security/index.vue' }),
  );
  assert.match(denial, /constrains this execution to read-only/u);
  assert.match(denial, /prepare_task inspect.*bounded repository reads.*prepare_task propose/u);
  assert.match(denial, /only after status prepared supplies the scoped writer context/u);
});

test('prepare_task guidance is absent without a legal ordinary proposal boundary', () => {
  const state = createInitialPhaseState({ maxSteps: 80 });
  Object.assign(state, {
    executionContextStatus: 'ready',
    executionIdentity: { taskId: 'task-negative', executionId: 'execution-negative', contractId: 'contract-negative' },
    executionContextExpiresAt: new Date(Date.now() + 900_000).toISOString(),
    executionAuthorityClass: 'production-read-only',
    protectedExecutionContextValidated: true,
    executionTestOnly: false,
    executionWorkflowId: null,
    actionCeiling: 'read-only',
  });

  assert.doesNotMatch(reminderForState(state), /prepare_task with operation inspect/u);

  state.promptReadOnlyConstraint = true;
  assert.doesNotMatch(
    reminderForState(state, null, { prepareTaskAvailable: true }),
    /prepare_task with operation inspect/u,
  );
  state.prepareTaskAvailable = true;
  assert.doesNotMatch(
    toolDenialReason(state, exec('write', { path: 'forge-admin-ui/src/views/security/index.vue' })),
    /prepare_task inspect/u,
  );

  state.promptReadOnlyConstraint = false;
  state.executionAuthorityClass = 'test-shadow-writer';
  state.executionTestOnly = true;
  state.executionWorkflowId = 'crud-production';
  assert.doesNotMatch(
    reminderForState(state, null, { prepareTaskAvailable: true }),
    /prepare_task with operation inspect/u,
  );
});

test('phase guard admits exact read-only forge-release inspection and rejects release or shell composition', () => {
  const state = createInitialPhaseState({ maxSteps: 80 });
  state.actionCeiling = 'read-only';
  for (const action of ['contract', 'capability', 'preflight', 'status', 'diagnose']) {
    assert.equal(toolDenialReason(state, exec('bash', { command: `forge-release ${action}` })), undefined);
    assert.equal(
      toolDenialReason(state, exec('bash', { command: `/usr/local/bin/forge-release ${action}` })),
      undefined,
    );
  }
  assert.match(
    toolDenialReason(state, exec('bash', { command: 'forge-release release --services forge-admin' })),
    /protected contract ceiling read-only/u,
  );
  assert.match(
    toolDenialReason(state, exec('bash', { command: 'forge-release contract; id' })),
    /release-inspection commands must use one exact reviewed argv shape/u,
  );
});

test('ordinary controlled checkpoint guidance distinguishes task preparation from invalid argv', () => {
  const state = createInitialPhaseState({ maxSteps: 80 });
  authorizeWriterState(state, { actionCeiling: 'read-only', ownedPaths: [] });
  Object.assign(state, {
    executionAuthorityClass: 'production-read-only', protectedExecutionContextValidated: true,
    executionTestOnly: false, executionWorkflowId: null, prepareTaskAvailable: true,
  });
  const checkpoint = exec('bash', { command: `forge-release checkpoint --path forge-server/example --message-base64 Y2hlY2twb2ludA --expected-head ${base} --expected-fingerprint ${'b'.repeat(64)}` });
  const denial = toolDenialReason(state, checkpoint);
  assert.match(denial, /protected contract ceiling read-only/u);
  assert.doesNotMatch(denial, /exact reviewed argv shape/u);
  assert.match(denial, /prepare_task inspect.*prepare_task propose/u);
  assert.match(denial, /实际权限以上游签发合同为准.*prepared.*不等于.*release/u);
  assert.equal(state.actionCeiling, 'read-only');

  for (const restricted of [
    { ...state, prepareTaskAvailable: false },
    { ...state, promptReadOnlyConstraint: true },
    { ...state, executionWorkflowId: 'crud-production' },
    { ...state, protectedExecutionContextValidated: false },
  ]) {
    const blocked = toolDenialReason(restricted, checkpoint);
    assert.match(blocked, /protected contract ceiling read-only/u);
    assert.doesNotMatch(blocked, /prepare_task inspect|下一轮/u);
  }
  assert.match(toolDenialReason(state, exec('bash', { command: checkpoint.arguments.command + '; id' })),
    /exact reviewed argv shape/u);
});

test('ordinary verification without current scope points to preparation instead of an unrecoverable admission blocker', () => {
  const state = createInitialPhaseState({ maxSteps: 80 });
  authorizeWriterState(state, { actionCeiling: 'read-only', ownedPaths: [] });
  Object.assign(state, {
    executionAuthorityClass: 'production-read-only', protectedExecutionContextValidated: true,
    executionTestOnly: false, executionWorkflowId: null, prepareTaskAvailable: true,
  });
  const verification = exec('bash', { command: 'forge-verify run --profile governance --admission-id 11111111-1111-4111-8111-111111111111 --idempotency-key existing-task-governance' });
  const denial = toolDenialReason(state, verification);
  assert.match(denial, /current request has not prepared its task scope/u);
  assert.match(denial, /prepare_task inspect.*prepare_task propose/u);
  assert.match(denial, /Do not ask the user to repeat authorization or rerun integration/u);
  assert.equal(state.actionCeiling, 'read-only');
  assert.equal(state.verificationAdmission, undefined);
  for (const restricted of [
    { ...state, prepareTaskAvailable: false }, { ...state, promptReadOnlyConstraint: true },
    { ...state, executionWorkflowId: 'crud-production' }, { ...state, protectedExecutionContextValidated: false },
  ]) {
    const blocked = toolDenialReason(restricted, verification);
    assert.match(blocked, /current ready batch execution admission/u);
    assert.doesNotMatch(blocked, /prepare_task inspect|repeat authorization/u);
  }
});

test('ordinary controlled release confirmation guidance never raises the current writer ceiling', () => {
  const state = createInitialPhaseState({ maxSteps: 80 });
  authorizeWriterState(state, { actionCeiling: 'workspace-write' });
  Object.assign(state, {
    executionAuthorityClass: 'production-task-writer', protectedExecutionContextValidated: true,
    executionTestOnly: false, executionWorkflowId: null,
  });
  const checkpoint = exec('bash', { command: `forge-release checkpoint --path forge-server/example --message-base64 Y2hlY2twb2ludA --expected-head ${base} --expected-fingerprint ${'b'.repeat(64)}` });
  const denial = toolDenialReason(state, checkpoint);
  assert.match(denial, /exceeds the protected contract ceiling workspace-write/u);
  assert.match(denial, /用户.*原对话下一轮.*确认.*当前范围/u);
  assert.match(denial, /账号权限.*身份.*范围.*源码/u);
  assert.match(denial, /不得.*替用户确认/u);
  assert.match(denial, /本地提交/u);
  assert.doesNotMatch(denial, /确认发布|当前发布合同/u);
  const releaseDenial = toolDenialReason(state, exec('bash', { command: 'forge-release release --services forge-admin' }));
  assert.match(releaseDenial, /确认发布当前范围/u);
  assert.match(releaseDenial, /当前请求已明确授权发布.*prepare_task inspect\/propose 按原范围刷新/u);
  assert.match(releaseDenial, /只有缺少发布授权时，才请用户/u);
  assert.equal(state.actionCeiling, 'workspace-write');
  assert.equal(state.taskContract.actionCeiling, 'workspace-write');
  for (const restricted of [
    { ...state, promptReadOnlyConstraint: true },
    { ...state, executionWorkflowId: 'crud-production' },
    { ...state, protectedExecutionContextValidated: false },
  ]) {
    const blocked = toolDenialReason(restricted, checkpoint);
    assert.equal(typeof blocked, 'string');
    assert.doesNotMatch(blocked, /原对话下一轮/u);
  }
});

test('old release sessions receive the current recoverable integrate discovery contract', () => {
  const state = createInitialPhaseState({ turn: 248109, maxSteps: 80 });
  authorizeWriterState(state, { actionCeiling: 'release', generation: 34 });
  state.protectedExecutionContextValidated = true;
  state.executionAuthorityClass = 'production-task-writer';
  state.executionTestOnly = false;
  state.executionSourceCommit = base;
  state.executionWorkspaceFingerprint = 'b'.repeat(64);
  for (const historicalSkill of ['forge-controlled-release', 'forge-taskspace-collaboration']) {
    state.invokedSkills.add(historicalSkill);
  }

  const notice = reminderForState(state);
  assert.match(notice, /Load or reload Skills forge-controlled-release and forge-taskspace-collaboration/u);
  assert.match(notice, /even when invokedSkills contains historical names/u);
  assert.match(notice, /Read forge-release status once; it already includes fresh preflight/u);
  assert.match(notice, /refresh status after actual edits, checkpoint, integrate, or a tool reports changed or stale state/u);
  assert.match(notice, /--expected-head = preflight\.taskspace\.head/u);
  assert.match(notice, /--expected-fingerprint = preflight\.taskspace\.workspaceFingerprint/u);
  assert.match(notice, /--canonical-head = preflight\.taskspace\.canonicalHead/u);
  assert.match(notice, /zero --path flags when that list is empty/u);
  assert.match(notice, /integrate --mode start --expected-head <preflight\.taskspace\.head> --expected-fingerprint <preflight\.taskspace\.workspaceFingerprint> --canonical-head <preflight\.taskspace\.canonicalHead>/u);
  assert.match(notice, /integrate --mode continue --operation-id <operationId> --expected-head/u);
  assert.match(notice, /current preflight\.integration\.conflictPaths/u);
  assert.match(notice, /never pass the complete automatically merged dirty set/u);
  assert.match(notice, /recoveryOnly=true/u);
  assert.match(notice, /preflight\.integration\.operationId/u);
  assert.match(notice, /conflict-open result\.operationId/u);
});

test('invalid bare integrate points to read-only discovery and the strict recoverable argv shape', () => {
  const state = createInitialPhaseState({ maxSteps: 80 });
  const denial = toolDenialReason(state, exec('bash', { command: '/usr/local/bin/forge-release integrate' }));
  assert.match(denial, /invalid or missing required argv shape/u);
  assert.match(denial, /Read forge-release status once; it already includes fresh preflight/u);
  assert.doesNotMatch(denial, /forge-release status and forge-release preflight/u);
  assert.match(denial, /Load or reload Skills forge-controlled-release and forge-taskspace-collaboration/u);
  assert.match(denial, /--expected-head = preflight\.taskspace\.head/u);
  assert.match(denial, /--expected-fingerprint = preflight\.taskspace\.workspaceFingerprint/u);
  assert.match(denial, /--canonical-head = preflight\.taskspace\.canonicalHead/u);
  assert.match(denial, /repeat --path once for every item/u);
  assert.match(denial, /zero --path flags/u);
  assert.match(denial, /--mode continue --operation-id <operationId>/u);
  assert.match(denial, /No permission or gate bypass is available/u);

  assert.match(
    toolDenialReason(state, exec('bash', { command: 'forge-release integrate; id' })),
    /one exact reviewed argv shape with no shell composition/u,
  );
  state.phase = PHASES.CLOSEOUT;
  assert.match(toolDenialReason(state, exec('bash', { command: 'forge-release integrate' })), /FINAL_ONLY/u);
  state.phase = PHASES.DISCOVER;
  state.progressDecision = { decision: 'STOP', reasonCodes: ['NO_MACHINE_OBSERVABLE_PROGRESS'] };
  assert.match(toolDenialReason(state, exec('bash', { command: 'forge-release integrate' })), /truthful bounded closeout/u);
});

test('release consumer Skills publish the same exact start, continue, and conflict contracts', async () => {
  const skillPaths = [
    'docker/harness/skills/forge-controlled-release/SKILL.md',
    'docker/harness/skills/forge-taskspace-collaboration/SKILL.md',
  ];
  for (const skillPath of skillPaths) {
    const skill = await readFile(path.resolve(skillPath), 'utf8');
    assert.match(skill, /发布前读取一次 `forge-release status`/u);
    assert.match(skill, /不再紧接着调用 `forge-release preflight`/u);
    assert.match(skill, /--expected-head <preflight\.taskspace\.head> --expected-fingerprint <preflight\.taskspace\.workspaceFingerprint> --canonical-head <preflight\.taskspace\.canonicalHead>/u);
    assert.match(skill, /--mode continue --operation-id <current-preflight\.integration\.operationId-or-conflict-result\.operationId>/u);
    assert.match(skill, /完整 `preflight\.taskspace\.dirtyPaths`/u);
    assert.match(skill, /continue 的.*`--path`.*`preflight\.integration\.conflictPaths`/u);
    assert.match(skill, /不得传.*`preflight\.taskspace\.dirtyPaths`/u);
    assert.match(skill, /`recoveryOnly=true`/u);
    assert.match(skill, /零个 `--path`/u);
    assert.match(skill, /F0（`conflict-open`）→ Host-bound F1/u);
    assert.match(skill, /merge F2/u);
    assert.match(skill, /下一次正常续谈取得新 source 合同后/u);
    assert.match(skill, /不证明所有会话均已同步/u);
    assert.match(skill, /不得隐藏或自动接受 fresh\/new HEAD/u);
  }
});

test('delivery CLI is callable only under matching current task authority and never proves execution', () => {
  const state = createInitialPhaseState({ suspendHeuristicStops: true });
  const call = (command, workdir = '/workspace') => exec('bash', { command, workdir });
  const init = call('forge-delivery change init --change coverage-fsm --objective "状态推进验收" --idempotency-key coverage-init-01');
  const status = call('forge-delivery change status --change coverage-fsm');
  assert.equal(toolDenialReason(state, call('forge-delivery --help')), undefined);
  assert.match(toolDenialReason(state, status), /validated protected task context/u);
  authorizeWriterState(state);
  state.protectedExecutionContextValidated = true;
  state.executionAuthorityClass = 'production-task-writer';
  state.executionTestOnly = false;
  assert.equal(toolDenialReason(state, status), undefined);
  assert.equal(toolDenialReason(state, init), undefined);
  assert.equal(toolDenialReason(state, call('forge-delivery handoff create --handoff h --change coverage-fsm --source forge-server/example/Test.java')), undefined);
  assert.match(toolDenialReason(state, call('forge-delivery handoff create --handoff h --change coverage-fsm --source another-project/Test.java')), /current task owned paths/u);
  const bind = call('forge-delivery contract bind --source forge-server/example/Test.java --binding review-001 --purpose review');
  assert.equal(toolDenialReason(state, bind), undefined);
  assert.equal(toolDenialReason(state, call('forge-delivery contract inspect --source forge-server/example/Test.java')), undefined);
  assert.match(toolDenialReason(state, call('forge-delivery contract inspect --source another-project/spec.json')), /current task owned paths/u);
  assert.match(toolDenialReason({ ...state, promptReadOnlyConstraint: true }, bind), /scoped writer contract/u);
  assert.equal(toolDenialReason(state, call('forge-delivery change transition --change coverage-fsm --to designed --expected-version 1 --idempotency-key coverage-next-01')), undefined);
  assert.match(toolDenialReason(state, call(status.arguments.command, '/other/project')), /current \/workspace root/u);
  for (const patch of [
    { promptReadOnlyConstraint: true },
    { actionCeiling: 'read-only' },
    { protectedExecutionContextValidated: false },
    { taskIntent: { contractId: 'another' } },
    { executionIdentity: { ...state.executionIdentity, contractId: 'another' } },
    { executionAuthorityClass: 'test-shadow-writer', executionTestOnly: true },
    { executionContextExpiresAt: new Date(0).toISOString() },
    { executionContextExpiresAt: 'invalid' },
    { executionProjectionRequired: true, executionProjectionStatus: 'unavailable' },
    { executionProjectionRequired: true, executionProjectionStatus: 'ready', executionProjectionSnapshot: { state: { terminalOutcome: 'failed' } } },
  ]) assert.ok(toolDenialReason({ ...state, ...patch }, init), JSON.stringify(patch));
  assert.ok(toolDenialReason(state, call('forge-delivery verify record --verification fake --change coverage-fsm')));
  assert.ok(toolDenialReason(state, call(init.arguments.command + '; id')));
  const before = state.verificationProfileReceipts.size;
  observeToolResult(state, init, ok(JSON.stringify({ ok: true, executionProven: true, verificationProven: true })));
  observeToolResult(state, bind, ok(JSON.stringify({ ok: true, executionProved: false, record: { binding: { purpose: 'verification' } } })));
  assert.equal(state.verificationProfileReceipts.size, before);
});

test('phase guard routes only exact production checkpoint and release mutations at their protected ceilings', () => {
  const controlledState = (actionCeiling) => {
    const state = createInitialPhaseState({ turn: 1, maxSteps: 40 });
    authorizeWriterState(state, { actionCeiling, generation: 1 });
    state.protectedExecutionContextValidated = true;
    state.executionAuthorityClass = 'production-task-writer';
    state.executionTestOnly = false;
    observeToolResult(state, exec('skill', {
      name: actionCeiling === 'release' ? 'forge-controlled-release' : 'forge-git-checkpoint',
    }), ok());
    return state;
  };
  const checkpoint = exec('bash', { command: `forge-release checkpoint --path forge-server/example --path tests/example.test.mjs --message-base64 Y2hlY2twb2ludA --expected-head ${base} --expected-fingerprint ${'b'.repeat(64)}` });
  const release = exec('bash', { command: 'forge-release release --services forge-admin,forge-ui --version v1.2.3 --approval-ref acceptance-2026.09.11' });
  const integrate = exec('bash', { command: `forge-release integrate --mode start --expected-head ${base} --expected-fingerprint ${'b'.repeat(64)} --canonical-head ${'c'.repeat(40)} --path forge-server/example` });

  const checkpointState = controlledState('git-checkpoint');
  assert.equal(toolDenialReason(checkpointState, checkpoint), undefined);
  assert.equal(isMutationExecution(checkpoint), false, 'checkpoint is not an arbitrary workspace mutation');
  const beforeCheckpointMutations = checkpointState.mutationCount;
  observeToolResult(checkpointState, checkpoint, ok('broker checkpoint result'));
  assert.equal(checkpointState.mutationCount, beforeCheckpointMutations);
  assert.equal(checkpointState.writerReservations.size, 0);
  checkpointState.executionSourceCommit = base;
  checkpointState.executionWorkspaceFingerprint = 'b'.repeat(64);
  assert.equal(toolDenialReason(checkpointState, integrate), undefined, 'task-local sync uses checkpoint authority');
  assert.match(toolDenialReason(checkpointState, release), /exceeds the protected contract ceiling/u);

  const releaseState = controlledState('release');
  releaseState.executionSourceCommit = base;
  releaseState.executionWorkspaceFingerprint = 'b'.repeat(64);
  observeToolResult(releaseState, exec('skill', { name: 'forge-git-checkpoint' }), ok());
  assert.equal(toolDenialReason(releaseState, release), undefined);
  const backgroundRelease = exec('bash', {
    command: 'forge-release release --services forge-admin,forge-ui --version v1.2.3 --approval-ref acceptance-2026.09.11',
    run_in_background: true,
  });
  assert.equal(toolDenialReason(releaseState, backgroundRelease), undefined, 'native background release retains the same protected authorization');
  assert.match(toolDenialReason(controlledState('git-checkpoint'), backgroundRelease), /exceeds the protected contract ceiling/u);
  assert.equal(isMutationExecution(release), false, 'release is not an arbitrary workspace mutation');
  observeToolResult(releaseState, release, ok('broker release result'));
  assert.equal(releaseState.mutationCount, 0);
  assert.equal(releaseState.writerReservations.size, 0);
  assert.equal(toolDenialReason(releaseState, integrate), undefined);
  assert.equal(isMutationExecution(integrate), false, 'integrate is a controlled Broker mutation');

  const longPaths = Array.from({ length: 80 }, (_, index) => `--path forge-server/forge-business/forge-business-core/src/main/java/com/example/business/core/leadership/service/ModuleImplementation${index}.java`).join(' ');
  const longIntegrate = exec('bash', { command: `${integrate.arguments.command} ${longPaths}` });
  assert.ok(longIntegrate.arguments.command.length > 8192);
  assert.equal(toolDenialReason(releaseState, longIntegrate), undefined, 'complete deep module paths reach the Broker');
  const writeOnlyState = controlledState('workspace-write');
  writeOnlyState.executionSourceCommit = base;
  writeOnlyState.executionWorkspaceFingerprint = 'b'.repeat(64);
  assert.match(toolDenialReason(writeOnlyState, longIntegrate), /exceeds the protected contract ceiling/u);
  assert.ok(toolDenialReason(releaseState, exec('bash', { command: `${longIntegrate.arguments.command}; id` })));

  assert.equal(toolDenialReason(releaseState, checkpoint), undefined, 'release ceiling includes checkpoint');
  for (const command of [
    'forge-release checkpoint --path forge-server/example --message-base64 Y2hlY2twb2ludA --expected-head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --expected-fingerprint bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; id',
    'forge-release release --services forge-admin && id',
    'git add forge-server/example',
    'git commit -m checkpoint',
  ]) assert.ok(toolDenialReason(releaseState, exec('bash', { command })), command);
});

test('closed discovery keeps the authorized checkpoint path for an existing unedited candidate', () => {
  const state = createInitialPhaseState({ turn: 1, maxSteps: 80 });
  authorizeWriterState(state, { actionCeiling: 'release', generation: 1 });
  state.protectedExecutionContextValidated = true;
  state.executionAuthorityClass = 'production-task-writer';
  state.executionTestOnly = false;
  state.executionSourceCommit = base;
  state.executionWorkspaceFingerprint = 'b'.repeat(64);
  observeToolResult(state, exec('skill', { name: 'forge-git-checkpoint' }), ok());
  observeToolResult(state, exec('skill', { name: 'forge-controlled-release' }), ok());
  state.implementationSwitchRequired = true;
  state.progressDecision = { decision: 'SWITCH_TO_IMPLEMENT', reasonCodes: ['NO_MACHINE_OBSERVABLE_PROGRESS'] };
  const checkpoint = exec('bash', { command: `/usr/local/bin/forge-release checkpoint --path forge-server/example --message-base64 Y2hlY2twb2ludA --expected-head ${base} --expected-fingerprint ${'b'.repeat(64)}` });
  const release = exec('bash', { command: 'forge-release release --services forge-admin' });
  const integrate = exec('bash', { command: `forge-release integrate --mode start --expected-head ${base} --expected-fingerprint ${'b'.repeat(64)} --canonical-head ${'c'.repeat(40)}` });
  assert.equal(state.mutationCount, 0);
  assert.equal(toolDenialReason(state, checkpoint), undefined);
  assert.equal(toolDenialReason(state, release), undefined);
  assert.equal(toolDenialReason(state, integrate), undefined, 'strict integrate bypasses only the ordinary discovery restriction');
  assert.match(reminderForState(state), /does not require a source edit before submission/u);
  assert.match(reminderForState(state), /actionCeiling: release/u);
  assert.match(reminderForState(state), /authorizes controlled checkpoint and release/u);
  assert.match(reminderForState(state), /Controlled sync is not READY or released/u);
  assert.match(toolDenialReason(state, exec('grep', { pattern: 'unrelated', path: '.' })), /ordinary discovery is closed/u);
  state.progressDecision = { decision: 'STOP', reasonCodes: ['SAFETY_STOP'] };
  assert.match(toolDenialReason(state, checkpoint), /SAFETY_STOP/u);
  state.progressDecision = { decision: 'CONTINUE', reasonCodes: ['PROGRESS_WITHIN_BOUNDS'] };
  state.promptReadOnlyConstraint = true;
  assert.match(toolDenialReason(state, checkpoint), /current prompt constrains/u);
  state.promptReadOnlyConstraint = false;
  state.invokedSkills.delete('forge-git-checkpoint');
  assert.match(toolDenialReason(state, checkpoint), /forge-git-checkpoint/u);
});

test('controlled release mutations preserve context, identity, skill, safety, and budget refusals', () => {
  const checkpoint = exec('bash', { command: `forge-release checkpoint --path forge-server/example --message-base64 Y2hlY2twb2ludA --expected-head ${base} --expected-fingerprint ${'b'.repeat(64)}` });
  const release = exec('bash', { command: 'forge-release release --services forge-admin' });
  const integrate = exec('bash', { command: `forge-release integrate --mode start --expected-head ${base} --expected-fingerprint ${'b'.repeat(64)} --canonical-head ${'c'.repeat(40)}` });
  const stateFor = (actionCeiling = 'release') => {
    const state = createInitialPhaseState({ turn: 1, maxSteps: 40 });
    authorizeWriterState(state, { actionCeiling, generation: 1 });
    state.protectedExecutionContextValidated = true;
    state.executionAuthorityClass = 'production-task-writer';
    state.executionTestOnly = false;
    state.executionSourceCommit = base;
    state.executionWorkspaceFingerprint = 'b'.repeat(64);
    return state;
  };

  assert.match(toolDenialReason(stateFor('workspace-write'), checkpoint), /exceeds the protected contract ceiling/u);
  assert.match(toolDenialReason(stateFor('git-checkpoint'), release), /exceeds the protected contract ceiling/u);
  assert.match(toolDenialReason(stateFor('workspace-write'), integrate), /exceeds the protected contract ceiling/u);

  const readOnlyPrompt = stateFor();
  readOnlyPrompt.promptReadOnlyConstraint = true;
  assert.match(toolDenialReason(readOnlyPrompt, release), /current prompt constrains/u);
  assert.match(toolDenialReason(readOnlyPrompt, integrate), /current prompt constrains/u);

  const expired = stateFor();
  expired.executionContextExpiresAt = new Date(0).toISOString();
  assert.match(toolDenialReason(expired, release), /context lease expired/u);

  const unvalidated = stateFor();
  unvalidated.protectedExecutionContextValidated = false;
  assert.match(toolDenialReason(unvalidated, release), /validated ready production-task-writer/u);

  const unknownContext = stateFor();
  unknownContext.executionContextStatus = 'unavailable';
  assert.match(toolDenialReason(unknownContext, release), /validated ready production-task-writer/u);

  const shadow = stateFor();
  shadow.executionAuthorityClass = 'test-shadow-writer';
  shadow.executionTestOnly = true;
  assert.match(toolDenialReason(shadow, release), /production-task-writer/u);

  const mismatch = stateFor();
  mismatch.executionIdentity.contractId = 'sha256:wrong-contract';
  assert.match(toolDenialReason(mismatch, release), /matching contract/u);

  const missingSkill = stateFor();
  assert.match(toolDenialReason(missingSkill, release), /forge-controlled-release/u);
  assert.match(toolDenialReason(missingSkill, integrate), /forge-controlled-release/u);
  assert.match(toolDenialReason(stateFor('git-checkpoint'), checkpoint), /forge-git-checkpoint/u);

  const stopped = stateFor();
  observeToolResult(stopped, exec('skill', { name: 'forge-controlled-release' }), ok());
  stopped.progressDecision = { decision: 'STOP', reasonCodes: ['SAFETY_STOP'] };
  assert.match(toolDenialReason(stopped, release), /SAFETY_STOP/u);

  const terminal = stateFor();
  observeToolResult(terminal, exec('skill', { name: 'forge-controlled-release' }), ok());
  terminal.executionProjectionRequired = true;
  terminal.executionProjectionStatus = 'ready';
  terminal.executionProjectionSnapshot = { state: { terminalOutcome: 'SAFETY_STOP' } };
  assert.match(toolDenialReason(terminal, release), /reducer stopped as SAFETY_STOP/u);

  const closeout = stateFor();
  observeToolResult(closeout, exec('skill', { name: 'forge-controlled-release' }), ok());
  closeout.phase = PHASES.CLOSEOUT;
  assert.equal(toolDenialReason(closeout, release), undefined);

  const late = stateFor();
  observeToolResult(late, exec('skill', { name: 'forge-controlled-release' }), ok());
  late.currentStep = 36;
  assert.match(toolDenialReason(late, release), /90 percent/u);

  const wrongSource = stateFor();
  observeToolResult(wrongSource, exec('skill', { name: 'forge-controlled-release' }), ok());
  wrongSource.executionWorkspaceFingerprint = 'd'.repeat(64);
  assert.match(toolDenialReason(wrongSource, integrate), /exact current protected source HEAD and workspace fingerprint/u);

  for (const configure of [
    (state) => { state.progressDecision = { decision: 'STOP', reasonCodes: ['SAFETY_STOP'] }; },
    (state) => {
      state.executionProjectionRequired = true;
      state.executionProjectionStatus = 'ready';
      state.executionProjectionSnapshot = { state: { terminalOutcome: 'SAFETY_STOP' } };
    },
    (state) => { state.currentStep = 36; },
  ]) {
    const denied = stateFor();
    observeToolResult(denied, exec('skill', { name: 'forge-controlled-release' }), ok());
    configure(denied);
    assert.ok(toolDenialReason(denied, integrate));
  }
});

test('closeout permits only exact contract-authorized release delivery and its required Skill reloads', () => {
  const stateFor = (actionCeiling) => {
    const state = createInitialPhaseState({ turn: 1, maxSteps: 40 });
    authorizeWriterState(state, { actionCeiling, generation: 1 });
    state.protectedExecutionContextValidated = true;
    state.executionAuthorityClass = 'production-task-writer';
    state.executionTestOnly = false;
    state.executionSourceCommit = base;
    state.executionWorkspaceFingerprint = 'b'.repeat(64);
    return state;
  };
  const state = stateFor('release');
  observeToolResult(state, exec('skill', { name: 'forge-git-checkpoint' }), ok());
  observeToolResult(state, exec('skill', { name: 'forge-controlled-release' }), ok());
  state.phase = PHASES.CLOSEOUT;
  const checkpoint = exec('bash', { command: `forge-release checkpoint --path forge-server/example --message-base64 Y2hlY2twb2ludA --expected-head ${base} --expected-fingerprint ${'b'.repeat(64)}` });
  const release = exec('bash', { command: 'forge-release release --services forge-admin' });
  const integrate = exec('bash', { command: `forge-release integrate --mode start --expected-head ${base} --expected-fingerprint ${'b'.repeat(64)} --canonical-head ${'c'.repeat(40)}` });

  for (const action of ['contract', 'status', 'preflight', 'diagnose']) {
    assert.equal(toolDenialReason(state, exec('bash', { command: `forge-release ${action}` })), undefined);
  }
  assert.equal(toolDenialReason(state, checkpoint), undefined);
  assert.equal(toolDenialReason(state, release), undefined);
  assert.equal(toolDenialReason(state, integrate), undefined);
  assert.equal(toolDenialReason(state, exec('skill', { name: 'forge-git-checkpoint' })), undefined);
  assert.equal(toolDenialReason(state, exec('skill', { name: 'forge-controlled-release' })), undefined);

  for (const denied of [
    exec('read', { path: 'forge-server/example' }),
    exec('edit', { path: 'forge-server/example', old_string: 'a', new_string: 'b' }),
    exec('bash', { command: `forge-governance audit --root . --base ${base} --format json` }),
    exec('bash', { command: 'printf arbitrary' }),
    exec('skill', { name: 'forge-backend-architecture' }),
    exec('skill', { name: 'forge-evidence-truth' }),
    exec('bash', { command: 'forge-release status --verbose' }),
  ]) assert.ok(toolDenialReason(state, denied));

  const checkpointOnly = stateFor('git-checkpoint');
  checkpointOnly.phase = PHASES.CLOSEOUT;
  assert.equal(toolDenialReason(checkpointOnly, exec('bash', { command: 'forge-release status' })), undefined);
  assert.equal(toolDenialReason(checkpointOnly, exec('skill', { name: 'forge-git-checkpoint' })), undefined);
  assert.ok(toolDenialReason(checkpointOnly, exec('skill', { name: 'forge-controlled-release' })));
  const workspaceOnly = stateFor('workspace-write');
  workspaceOnly.phase = PHASES.CLOSEOUT;
  assert.ok(toolDenialReason(workspaceOnly, exec('bash', { command: 'forge-release status' })));
});

test('start and continue use the current Host-bound edited fingerprint while retaining immutable context authority', () => {
  const state = createInitialPhaseState({ turn: 1, maxSteps: 40 });
  authorizeWriterState(state, { actionCeiling: 'release', generation: 1 });
  state.protectedExecutionContextValidated = true;
  state.executionAuthorityClass = 'production-task-writer';
  state.executionTestOnly = false;
  state.executionProjectSlug = 'forge-project';
  state.executionSourceCommit = base;
  state.executionWorkspaceFingerprint = 'b'.repeat(64);
  state.mutationSequence = 2;
  observeToolResult(state, exec('skill', { name: 'forge-controlled-release' }), ok());
  const profiles = ['governance', ...state.taskContract.requiredRedProfiles,
    ...state.taskContract.requiredVerificationProfiles.filter((profile) => profile !== 'governance')];
  const receipt = hostAdmissionReceipt(profiles);
  receipt.source.workspaceFingerprint = 'c'.repeat(64);
  state.verificationAdmission = {
    sequence: state.mutationSequence, outcome: 'ready', admissionId: receipt.admissionId,
    profiles: [...receipt.profiles], dependencyManifestFingerprint: receipt.source.dependencyManifestFingerprint,
    sourceWorkspaceFingerprint: receipt.source.workspaceFingerprint, expiresAt: receipt.expiresAt,
    executionMode: 'host-toolchain', receipt,
  };
  const command = (mode, fingerprint = receipt.source.workspaceFingerprint, head = base) => exec('bash', {
    command: `forge-release integrate --mode ${mode} --expected-head ${head} --expected-fingerprint ${fingerprint} --canonical-head ${'d'.repeat(40)}${mode === 'continue' ? ' --operation-id 123e4567-e89b-42d3-a456-426614174000' : ''} --path forge-server/example`,
  });
  assert.equal(toolDenialReason(state, command('continue')), undefined);
  assert.equal(toolDenialReason(state, command('start')), undefined);
  assert.match(toolDenialReason(state, command('start', 'f'.repeat(64))), /exact current protected source/u);
  assert.match(toolDenialReason(state, command('continue', receipt.source.workspaceFingerprint, 'e'.repeat(40))), /exact current protected source/u);
  state.verificationAdmission.sequence = state.mutationSequence - 1;
  assert.match(toolDenialReason(state, command('start')), /exact current protected source/u);
  assert.match(toolDenialReason(state, command('continue')), /exact current protected source/u);
  state.verificationAdmission.sequence = state.mutationSequence;
  state.verificationAdmission.receipt = { ...receipt, taskId: 'other-task' };
  assert.match(toolDenialReason(state, command('start')), /exact current protected source/u);
  assert.match(toolDenialReason(state, command('continue')), /exact current protected source/u);
  state.verificationAdmission.receipt = receipt;
  state.verificationAdmission.expiresAt = new Date(0).toISOString();
  assert.match(toolDenialReason(state, command('start')), /exact current protected source/u);
  assert.match(toolDenialReason(state, command('continue')), /exact current protected source/u);
});

test('phase runtime closes repeated discovery but preserves one contract-bound implementation path', () => {
  const state = routedState({ maxSteps: 80 });
  state.currentStep = 9;
  const repeatedRead = exec('read', { path: 'forge-server/pom.xml' });
  observeToolResult(state, repeatedRead, ok('same source fact'));
  observeToolResult(state, repeatedRead, ok('same source fact'));
  assert.equal(state.progressDecision.decision, 'SWITCH_TO_IMPLEMENT');
  assert.deepEqual(state.progressDecision.reasonCodes, ['REPEATED_ACTION_RESULT_NO_PROGRESS']);
  assert.match(
    toolDenialReason(state, exec('grep', { pattern: 'PageQuery', path: '.' })),
    /REPEATED_ACTION_RESULT_NO_PROGRESS/u,
  );
  const testWrite = exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' });
  assert.equal(toolDenialReason(state, testWrite), undefined);
  observeToolResult(state, testWrite, ok('created focused failing regression'));
  assert.equal(state.implementationSwitchRequired, false);
  assert.equal(state.progressDecision.decision, 'CONTINUE');
});

test('implementation switch admits only missing routed skills or a fully authorized mutation', () => {
  const state = createInitialPhaseState({ maxSteps: 80 });
  authorizeWriterState(state);
  for (const skill of [
    'forge-task-contract',
    'forge-task-router',
    'forge-backend-architecture',
    'forge-change-design',
  ]) observeToolResult(state, exec('skill', { name: skill }), ok());
  setReadyAdmission(state);
  state.currentStep = 9;
  const repeatedRead = exec('read', { path: 'forge-server/pom.xml' });
  observeToolResult(state, repeatedRead, ok('same source fact'));
  observeToolResult(state, repeatedRead, ok('same source fact'));

  assert.equal(state.implementationSwitchRequired, true);
  assert.equal(
    toolDenialReason(state, exec('skill', { name: 'forge-testing-observability' })),
    undefined,
  );
  assert.match(
    toolDenialReason(state, exec('skill', { name: 'unrouted-general-advice' })),
    /ordinary discovery is closed/u,
  );
  assert.match(
    toolDenialReason(state, exec('read', { path: 'forge-server/another.java' })),
    /ordinary discovery is closed/u,
  );
  const testWrite = exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' });
  assert.match(toolDenialReason(state, testWrite), /requires exact Skills/u);

  observeToolResult(state, exec('skill', { name: 'forge-testing-observability' }), ok());
  assert.equal(state.implementationSwitchRequired, true, 'a routed Skill must not reopen discovery');
  assert.match(
    toolDenialReason(state, exec('read', { path: 'forge-server/another.java' })),
    /ordinary discovery is closed/u,
  );
  assert.equal(toolDenialReason(state, testWrite), undefined);
});

test('a failed structured mutation consumes the implementation switch and hard-stops repeated stagnation', () => {
  const state = routedState({ maxSteps: 80 });
  state.currentStep = 9;
  const repeatedRead = exec('read', { path: 'forge-server/pom.xml' });
  observeToolResult(state, repeatedRead, ok('same source fact'));
  observeToolResult(state, repeatedRead, ok('same source fact'));
  assert.equal(state.progressDecision.decision, 'SWITCH_TO_IMPLEMENT');

  const failedWrite = exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' });
  assert.equal(toolDenialReason(state, failedWrite), undefined);
  observeToolResult(state, failedWrite, failed('structured writer failed'));
  assert.equal(state.mutationCount, 0);
  assert.equal(state.mutationAttemptCount, 1);
  assert.equal(state.progressDecision.decision, 'STOP');
  assert.deepEqual(state.progressDecision.reasonCodes, ['REPEATED_ACTION_RESULT_NO_PROGRESS']);
  assert.match(
    toolDenialReason(state, exec('write', { path: 'forge-server/example/src/test/java/RetryTest.java' })),
    /ordinary mutation is closed/u,
  );
});

test('distinct successful edits to one file advance progress without letting repeats or failures forge it', () => {
  const state = routedState({ maxSteps: 80 });
  observeToolResult(
    state,
    exec('write', {
      path: 'forge-ui/src/views/investigate/investigate.test.ts',
      content: 'focused regression',
    }),
    ok('focused regression written'),
  );

  for (let index = 1; index <= 4; index += 1) {
    observeToolResult(
      state,
      exec('edit', {
        path: 'forge-ui/src/views/investigate/investigate.vue',
        oldText: `before-${index}`,
        newText: `after-${index}`,
      }),
      ok('edit applied'),
    );
    assert.equal(
      state.progressDecision.decision,
      'CONTINUE',
      `successful edit ${index} must contribute its distinct mutation shape`,
    );
  }

  const repeated = exec('edit', {
    path: 'forge-ui/src/views/investigate/repeated.vue',
    oldText: 'same-before',
    newText: 'same-after',
  });
  observeToolResult(state, repeated, ok('same edit applied'));
  observeToolResult(state, repeated, ok('same edit applied'));
  assert.equal(state.progressDecision.decision, 'STOP');
  assert.deepEqual(state.progressDecision.reasonCodes, ['REPEATED_ACTION_RESULT_NO_PROGRESS']);

  const failedState = routedState({ maxSteps: 80 });
  const failedEdit = exec('edit', {
    path: 'forge-ui/src/views/investigate/investigate.vue',
    oldText: 'missing-before',
    newText: 'unused-after',
  });
  for (let index = 0; index < 2; index += 1) {
    observeToolResult(failedState, failedEdit, failed('edit failed'));
  }
  assert.equal(failedState.mutationCount, 0);
  assert.equal(failedState.progressDecision.decision, 'STOP');
  assert.deepEqual(
    failedState.progressDecision.reasonCodes,
    ['REPEATED_ACTION_RESULT_NO_PROGRESS'],
  );
});

test('a progress stop still permits an exact admitted verification run to produce machine evidence', () => {
  const state = routedState({ maxSteps: 40 });
  const testWrite = exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' });
  const sourceWrite = exec('write', { path: 'forge-server/example/src/main/java/Example.java' });
  observeToolResult(state, testWrite, ok());
  observeToolResult(state, sourceWrite, ok());
  for (let index = 1; index <= 3; index += 1) {
    observeToolResult(
      state,
      exec('read', { path: `forge-server/example/missing-${index}.txt` }),
      failed(`missing-${index}`),
    );
  }
  assert.equal(state.progressDecision.decision, 'STOP');
  assert.deepEqual(state.progressDecision.reasonCodes, ['NO_MACHINE_OBSERVABLE_PROGRESS']);
  const verification = exec('bash', {
    command: `forge-verify run --profile backend-module-test --module forge-server/example --admission-id ${admissionId} --idempotency-key stopped-evidence-1234`,
  });

  assert.equal(toolDenialReason(state, verification), undefined);
  assert.match(
    toolDenialReason(state, exec('read', { path: 'forge-server/example/src/main/java/Example.java' })),
    /ordinary discovery and mutation are closed/u,
  );
  assert.match(
    toolDenialReason(state, exec('bash', {
      command: 'forge-verify run --profile backend-module-test --module forge-server/example --admission-id 223e4567-e89b-12d3-a456-426614174099 --idempotency-key stopped-wrong-1234',
    })),
    /current batch admission id/u,
  );

  state.verificationProfileAttempts.set('backend-module-test', { sequence: state.mutationSequence });
  assert.match(toolDenialReason(state, verification), /ordinary discovery and mutation are closed/u);

  state.verificationProfileAttempts.clear();
  state.progressDecision = { decision: 'STOP', reasonCodes: ['SAFETY_VIOLATION'] };
  assert.match(toolDenialReason(state, verification), /ordinary discovery and mutation are closed/u);
});

test('discovery exhaustion still admits missing current frontend evidence without reopening discovery or retries', () => {
  for (const mutationAttempts of [0, 1]) {
    // A source integration creates a new execution generation. Its old tool
    // attempts do not prove the final evidence required by the new candidate.
    const state = createInitialPhaseState({ maxSteps: 80, suspendHeuristicStops: true });
    authorizeWriterState(state, { prompt: '完成事故通报前端功能并验证', ownedPaths: ['forge-admin-ui/src'], generation: 1 });
    state.protectedExecutionContextValidated = true;
    state.executionAuthorityClass = 'production-task-writer';
    state.executionTestOnly = false;
    state.executionSourceCommit = base;
    state.currentStep = 80;
    state.mutationAttemptCount = mutationAttempts;
    setReadyAdmission(state, ['governance', 'frontend-red-test', 'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build']);
    observeToolResult(state, exec('read', { path: 'forge-admin-ui/package.json' }), ok('current candidate source'));
    assert.equal(state.progressDecision.decision, mutationAttempts === 0 ? 'ESCALATE_AT_IMMUTABLE_BOUNDARY' : 'STOP');
    assert.deepEqual(state.progressDecision.reasonCodes, ['DISCOVERY_GATE_INCOMPLETE']);
    const run = (profile, id = admissionId) => exec('bash', {
      command: `forge-verify run --profile ${profile} --admission-id ${id} --idempotency-key accident-final-${profile}`,
    });
    assert.equal(toolDenialReason(state, run('frontend-admin-lint')), undefined);
    assert.equal(toolDenialReason(state, run('frontend-admin-test')), undefined);
    assert.match(toolDenialReason(state, exec('read', { path: 'forge-admin-ui/package.json' })), /ordinary discovery and mutation are closed/u);
    assert.match(toolDenialReason(state, exec('write', { path: 'forge-admin-ui/src/new.ts' })), /ordinary mutation is closed/u);
    assert.match(toolDenialReason(state, run('frontend-admin-lint', '223e4567-e89b-12d3-a456-426614174099')), /current batch admission id/u);
    state.verificationProfileAttempts.set('frontend-admin-lint', { sequence: state.sequence });
    assert.match(toolDenialReason(state, run('frontend-admin-lint')), /ordinary discovery and mutation are closed/u);
    state.progressDecision.reasonCodes.push('SAFETY_VIOLATION');
    assert.match(toolDenialReason(state, run('frontend-admin-test')), /ordinary discovery and mutation are closed/u);
  }
});

test('budget exhaustion permits one missing controlled final verification without reopening work', () => {
  const state = createInitialPhaseState({ maxSteps: 80, suspendHeuristicStops: true });
  authorizeWriterState(state, { prompt: '修改调查页面并完成验证', ownedPaths: ['forge-admin-ui/src'] });
  state.protectedExecutionContextValidated = true;
  state.executionAuthorityClass = 'production-task-writer';
  state.executionTestOnly = false;
  state.executionSourceCommit = base;
  setReadyAdmission(state, ['governance', 'frontend-admin-test']);
  state.progressDecision = { decision: 'STOP', reasonCodes: ['PHASE_BUDGET_EXHAUSTED'] };
  const run = (profile, id = admissionId) => exec('bash', {
    command: `/usr/local/bin/forge-verify run --profile ${profile} --admission-id ${id} --idempotency-key leadership-final-${profile}`,
  });
  assert.equal(toolDenialReason(state, run('governance')), undefined);
  assert.equal(toolDenialReason(state, run('frontend-admin-test')), undefined);
  assert.match(toolDenialReason(state, exec('bash', { command: 'pnpm test' })), /ordinary discovery and mutation are closed/u);
  assert.match(toolDenialReason(state, run('governance', '223e4567-e89b-12d3-a456-426614174099')), /current batch admission id/u);
  state.progressDecision.reasonCodes.push('SAFETY_VIOLATION');
  assert.match(toolDenialReason(state, run('governance')), /ordinary discovery and mutation are closed/u);
  state.progressDecision.reasonCodes = ['PHASE_BUDGET_EXHAUSTED'];
  observeToolResult(state, run('governance'), failed('verification command failed'));
  state.progressDecision = { decision: 'STOP', reasonCodes: ['PHASE_BUDGET_EXHAUSTED'] };
  assert.match(toolDenialReason(state, run('governance')), /ordinary discovery and mutation are closed/u);
});

test('a production continuation verifies an existing candidate without an artificial first mutation', () => {
  const state = createInitialPhaseState({ maxSteps: 80 });
  authorizeWriterState(state, { prompt: '修改调查页面并完成验证', ownedPaths: ['forge-admin-ui/src'] });
  state.protectedExecutionContextValidated = true;
  state.executionAuthorityClass = 'production-task-writer';
  state.executionTestOnly = false;
  state.executionSourceCommit = base;
  setReadyAdmission(state, ['frontend-red-test', 'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build']);
  state.implementationSwitchRequired = true;
  state.progressDecision = { decision: 'SWITCH_TO_IMPLEMENT', reasonCodes: ['REPEATED_ACTION_RESULT_NO_PROGRESS'] };
  const run = (profile, id = admissionId) => exec('bash', {
    command: `forge-verify run --profile ${profile} --admission-id ${id} --idempotency-key continuation-${profile}`,
  });
  state.verificationProfileAttempts.set('frontend-admin-lint', { sequence: state.sequence });
  assert.equal(state.mutationCount, 0);
  assert.match(toolDenialReason(state, run('frontend-admin-lint')), /ordinary discovery is closed/u);
  assert.equal(toolDenialReason(state, run('frontend-admin-test')), undefined);
  assert.equal(toolDenialReason(state, run('frontend-admin-typecheck')), undefined);
  assert.match(reminderForState(state), /do not edit solely to unlock verification/u);
  assert.match(toolDenialReason(state, exec('bash', { command: 'pnpm test' })), /ordinary discovery is closed/u);
  assert.match(toolDenialReason(state, run('frontend-admin-test', '223e4567-e89b-12d3-a456-426614174099')), /current batch admission id/u);
  const staleAdmissionFeedback = toolDenialReason(state, run('frontend-admin-test', '223e4567-e89b-12d3-a456-426614174099'));
  assert.ok(staleAdmissionFeedback.includes(`Current admissionId: ${admissionId}`));
  assert.match(staleAdmissionFeedback, /correct only --admission-id/u);
  assert.match(staleAdmissionFeedback, /Do not rerun passed checks or ask the user/u);
  const expiresAt = state.verificationAdmission.expiresAt;
  state.verificationAdmission.expiresAt = new Date(0).toISOString();
  assert.match(toolDenialReason(state, run('frontend-admin-test')), /current ready batch execution admission/u);
  state.verificationAdmission.expiresAt = expiresAt;
  state.verificationAdmission.profiles.push('frontend-h5-build');
  assert.match(toolDenialReason(state, run('frontend-h5-build')), /ordinary discovery is closed/u);
  state.verificationAdmission.profiles = state.verificationAdmission.profiles.filter((profile) => profile !== 'frontend-admin-build');
  assert.match(toolDenialReason(state, run('frontend-admin-build')), /current batch admission id/u);
  const outsideProfileFeedback = toolDenialReason(state, run('frontend-admin-build'));
  assert.match(outsideProfileFeedback, /outside this admission/u);
  assert.doesNotMatch(outsideProfileFeedback, /correct only --admission-id/u);
  for (const change of [
    { protectedExecutionContextValidated: false },
    { executionAuthorityClass: 'test-shadow-writer' },
    { executionTestOnly: true },
    { executionContextExpiresAt: new Date(0).toISOString() },
  ]) assert.match(toolDenialReason({ ...state, ...change }, run('frontend-admin-test')), /ordinary discovery is closed/u);
  state.progressDecision = { decision: 'STOP', reasonCodes: ['SAFETY_VIOLATION'] };
  assert.match(toolDenialReason(state, run('frontend-admin-test')), /ordinary discovery is closed/u);
  state.progressDecision = { decision: 'STOP', reasonCodes: ['NO_MACHINE_OBSERVABLE_PROGRESS'] };
  assert.equal(toolDenialReason(state, run('frontend-admin-test')), undefined);
  observeToolResult(state, run('frontend-admin-test'), failed('verification command failed'));
  assert.match(toolDenialReason(state, run('frontend-admin-test')), /ordinary discovery.*closed/u);
  assert.equal(state.mutationCount, 0);
});

test('historical code acceptance binds to the read-only phase notice and preserves write denial', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-phase-historical-completion-'));
  const now = Date.now();
  const actorUserId = '123e4567-e89b-42d3-a456-426614174000';
  const metadata = {
    schemaVersion: 2, projectSlug: 'forge-project', taskId: 'task-historical', actorId: 'alice', actorUserId,
    conversationId: 'conversation:historical:001', accessMode: 'conversation', status: 'active',
  };
  const promptContent = [{ type: 'text', text: '继续执行。' }];
  const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
    type: 'client-request', rpcId: 'rpc:historical-phase', method: 'session.prompt',
    payload: { sessionId: 'session-historical', mode: 'queue', content: promptContent },
  })), 'session.prompt');
  const previousCompletion = {
    schemaVersion: 1, kind: 'historical-code-acceptance', projectSlug: metadata.projectSlug,
    taskId: metadata.taskId, actorUserId, actorUsername: 'alice', conversationId: metadata.conversationId,
    dshSessionId: 'session-historical', sourceCommit: 'a'.repeat(40), workspaceFingerprint: 'b'.repeat(64),
    contractId: 'c'.repeat(64), acceptedAt: new Date(now - 1_000).toISOString(),
    recordDigest: `sha256:${'d'.repeat(64)}`, verdictDigest: `sha256:${'e'.repeat(64)}`,
    gateDigest: `sha256:${'f'.repeat(64)}`,
  };
  try {
    const prepared = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: { ...classified, requestId: 'request-historical', actorUserId, actorUsername: 'alice', conversationId: metadata.conversationId },
      policyPath: path.resolve('docker/harness/forge-execution-policy.json'), previousCompletion, now,
    });
    const { idempotent: _idempotent, refreshed: _refreshed, ...context } = prepared;
    const handlers = new Map();
    const ctx = { on(name, handler) { handlers.set(name, handler); }, tools: { guard() { return () => {}; } } };
    const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
      resolveExecutionContext: async () => context,
    });
    const agent = { session: { events: [] }, steer() {}, cancel() {} };
    const decision = await handlers.get('agent/pre-step')(
      { agent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: promptContent }] }),
    );
    const notice = decision.messages.at(-1).content[0].text;
    assert.match(notice, /同一候选已于 .* 完成合同范围代码验收/u);
    assert.match(notice, new RegExp(previousCompletion.contractId, 'u'));
    assert.match(notice, new RegExp(previousCompletion.sourceCommit, 'u'));
    assert.match(notice, new RegExp(previousCompletion.recordDigest, 'u'));
    assert.match(notice, /这不是本轮新验证或新发布授权/u);
    assert.match(notice, /不为刷新租约重跑，不自行改代码或提交发布/u);
    assert.match(notice, /ORDINARY RESPONSE CONTRACT/u);
    assert.match(notice, /Lead with the concrete business outcome and impact/u);
    assert.match(notice, /do not describe historical evidence as newly verified this turn/u);
    assert.match(notice, /ask_user_question selections.*not a signed execution or release grant/u);
    assert.match(notice, /direct user chat message/u);
    assert.match(notice, /Do not repeat confirmation.*already authorized/u);
    const state = controller.stateFor(agent, 1);
    assert.deepEqual(state.previousCompletion, previousCompletion);
    assert.match(toolDenialReason(state, exec('write', { path: 'forge-admin-ui/src/views/accident/index.vue' })), /read-only/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit current acceptance questions receive live status without renewing or executing checks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-readonly-acceptance-'));
  const actorUserId = '123e4567-e89b-42d3-a456-426614174000';
  const metadata = { schemaVersion: 2, projectSlug: 'forge-project', taskId: 'task-status', actorId: 'alice', actorUserId,
    conversationId: 'conversation:status:001', accessMode: 'conversation', status: 'active' };
  const sourceFingerprint = 'b'.repeat(64);
  const expired = resignProtectedProjection({
    ...blockedCurrentContractProjection('previous-contract', sourceFingerprint),
    blockers: [{ code: 'ACCEPTANCE_CONTRACT_EXPIRED', detail: 'Acceptance lease expired.' }],
  });
  const ready = resignProtectedProjection({ ...expired, outcome: 'READY', maximumTerminalOutcome: 'COMPLETE',
    signedVerdictVerified: true, blockers: [], cannotClaim: [],
    ledgerSummary: { ...expired.ledgerSummary, counts: { total: 14, open: 0, closed: 14, stale: 0 }, open: [], closed: expired.ledgerSummary.open } });
  try {
    for (const [prompt, projection, expectedCalls, expectedText] of [
      ['请核对当前任务实际验收状态，还需要等独审吗？不改代码、不执行检查。', expired, 1, /ACCEPTANCE_CONTRACT_EXPIRED/u],
      ['当前验收状态怎样？', { ...expired, gateDigest: 'tampered' }, 1, /current acceptance status could not be established/u],
      ['当前验收状态怎样？', null, 1, /current acceptance status could not be established/u],
      ['目前验收是否通过？', ready, 1, /"outcome":"READY"/u],
      [await readFile('docs/long-tasks/acceptance-20260929/coverage-optlock-permission-fixture-repair-prompt.md', 'utf8'), expired, 0, null],
      [await readFile('docs/long-tasks/acceptance-20260929/coverage-optlock-run-current-candidate-prompt.md', 'utf8'), expired, 0, null],
      ['请修复当前验收阻塞，再执行相关测试。', expired, 0, null],
      ['请执行当前候选的测试并收取验收结果。', expired, 0, null],
      ['总结上次已经通过的测试结果。', expired, 0, null],
      ['什么是机器签名验收？', expired, 0, null],
    ]) {
      const content = [{ type: 'text', text: prompt }];
      const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request',
        rpcId: 'rpc:readonly-status', method: 'session.prompt', payload: { sessionId: 'session-status', mode: 'queue', content } })), 'session.prompt');
      const prepared = await prepareProtectedExecutionContext({ projectRoot: root, projectSlug: metadata.projectSlug,
        taskMetadata: metadata, request: { ...classified, requestId: `request-${expectedCalls}-${prompt.length}`, actorUserId,
          actorUsername: 'alice', conversationId: metadata.conversationId }, policyPath: path.resolve('docker/harness/forge-execution-policy.json') });
      const { idempotent: _idempotent, refreshed: _refreshed, ...context } = prepared;
      const handlers = new Map();
      let calls = 0;
      const controller = installPhaseBudgetGuard({ on(event, callback) { handlers.set(event, callback); }, tools: { guard() { return () => {}; } } },
        input => ({ role: 'user', ...input }), { resolveExecutionContext: async () => context,
          resolveProtectedCompletion: async () => { calls += 1; return projection; },
          admitExecution: async () => { assert.fail('a status question must not renew execution admission'); } });
      const agent = { session: { id: 'session-status', events: [] }, steer() {}, cancel() {} };
      const preStep = handlers.get('agent/pre-step');
      const entered = await preStep({ agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content }] }));
      assert.equal(calls, expectedCalls, prompt);
      const notice = entered.messages.at(-1).content[0].text;
      if (expectedText) {
        assert.match(notice, expectedText);
        assert.match(notice, /Historical passed tests remain historical passes/u);
        assert.match(notice, /does not authorize a new check, renewal, code change or release/u);
      } else {
        assert.doesNotMatch(notice, /Current acceptance status requested/u);
      }
      const state = controller.states.get(agent);
      assert.equal(state.actionCeiling, 'read-only');
      assert.match(toolDenialReason(state, exec('write', { path: 'forge-admin-ui/src/views/example.vue' })), /read-only/u);
      await preStep({ agent, turn: 1, step: 2, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
      assert.equal(calls, expectedCalls, 'unchanged continuation must not repeatedly query acceptance');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const exec = (name, args = {}, agent = undefined) => ({
  name,
  arguments: args,
  agent,
  callId: `${name}-call`,
  rootCallId: `${name}-call`,
  signal: new AbortController().signal,
});
const ok = (text = 'ok') => ({ isError: false, value: {}, content: [{ type: 'text', text }] });
const failed = (text) => ({
  isError: true,
  error: { message: text },
  content: [{ type: 'text', text }],
});
const base = 'a'.repeat(40);
const admissionId = '123e4567-e89b-12d3-a456-426614174099';
const governanceReceipt = (okValue = true, obligations = []) => JSON.stringify({
  ok: okValue,
  receiptDigest: `sha256:${'b'.repeat(64)}`,
  obligations,
});
const verificationReceipt = (
  profile = 'backend-module-test', status = 'passed', verificationProven = status === 'passed',
) => JSON.stringify({
  receiptType: 'forge-verify/run',
  receiptId: '123e4567-e89b-12d3-a456-426614174000',
  status,
  source: { workspaceFingerprint: 'c'.repeat(64) },
  request: { profile, admissionId, selectors: profile === 'backend-module-test' ? { modules: ['forge-server/example'] } : {} },
  truth: { verificationProven },
});
const strictFailingTestReceipt = ({
  profile = 'backend-module-test',
  modules,
  tests,
  testFiles,
} = {}) => {
  const resolvedModules = modules ?? (profile === 'frontend-red-test' ? undefined : ['forge-server/example']);
  const resolvedTests = tests ?? (['backend-red-test', 'backend-test-class'].includes(profile) ? ['ExampleTest'] : undefined);
  return JSON.stringify({
  schemaVersion: 1,
  receiptType: 'forge-verify/run',
  receiptId: '123e4567-e89b-12d3-a456-426614174077',
  jobId: '123e4567-e89b-12d3-a456-426614174078',
  projectSlug: 'forge-project',
  taskId: 'task-one',
  status: 'failed',
  source: {
    head: base,
    workspaceFingerprint: 'c'.repeat(64),
    dependencyManifestFingerprint: 'd'.repeat(64),
    snapshotSha256: 'c'.repeat(64),
    fileCount: 10,
    bytes: 1000,
  },
  request: {
    profile,
    selectors: {
      ...(resolvedModules === undefined ? {} : { modules: resolvedModules }),
      ...(resolvedTests === undefined ? {} : { tests: resolvedTests }),
      ...(testFiles === undefined ? {} : { testFiles }),
    },
    selectorsSha256: `sha256:${'1'.repeat(64)}`,
    idempotencyDigest: `sha256:${'2'.repeat(64)}`,
    admissionId,
  },
  redExpectation: {
    schemaVersion: 1,
    expectationType: 'selected-test-must-fail',
    profile,
    selectorsSha256: `sha256:${'1'.repeat(64)}`,
    matched: true,
    failureKind: 'test-report',
  },
  execution: {
    steps: [{
      argv: ['mvn', 'test'], cwd: '/workspace/forge-server', exitCode: 1,
      signal: null, timedOut: false, transportUncertain: false,
      cleanup: { proven: true, containerId: 'a'.repeat(64) },
    }],
    exitCode: 1,
    signal: null,
    startedAt: new Date(Date.now() - 500).toISOString(),
    finishedAt: new Date().toISOString(),
    externalEgress: false,
    toolchainImage: 'example@sha256:abc',
    cachePackDigest: `sha256:${'e'.repeat(64)}`,
  },
  results: {
    selected: null, executed: 1, passed: 0, failed: 1, skipped: 0,
    reportFiles: 1, zeroTestsRejected: false,
  },
  logs: {
    sha256: 'f'.repeat(64), bytes: 200, truncated: false,
    diagnosticSummary: 'The selected test failed.',
  },
  truth: {
    executionProven: true,
    verificationProven: false,
    semanticCorrectnessProven: false,
    databaseIntegrationProven: false,
    releaseProven: false,
  },
  });
};
const capabilityReceipt = (profile = 'backend-module-test', outcome = 'ready') => JSON.stringify({
  receiptType: 'forge-verify/capability',
  receiptId: '123e4567-e89b-12d3-a456-426614174001',
  profile,
  outcome,
});
const admissionReceipt = (profiles = ['backend-module-test'], outcome = 'ready') => JSON.stringify({
  schemaVersion: 1,
  receiptType: 'forge-verify/execution-admission',
  admissionId: outcome === 'ready' ? admissionId : null,
  projectSlug: 'forge-project',
  taskId: 'task-one',
  runner: { bootId: '123e4567-e89b-12d3-a456-426614174000', revision: 'vpn-forge-delivery-toolkit-72' },
  profiles,
  source: {
    head: base,
    workspaceFingerprint: 'c'.repeat(64),
    dependencyManifestFingerprint: 'd'.repeat(64),
  },
  cache: {
    mode: 'project-scoped-immutable-pack',
    compatible: outcome === 'ready',
    ...(outcome === 'ready' ? { packDigest: `sha256:${'e'.repeat(64)}` } : {}),
  },
  executor: {
    proven: outcome === 'ready',
    dockerApiProven: outcome === 'ready',
    toolchainImageProven: outcome === 'ready',
    samePathBindProven: outcome === 'ready',
    stateWriteProven: outcome === 'ready',
    cleanupProven: outcome === 'ready',
  },
  issuedAt: outcome === 'ready' ? new Date(Date.now() - 1_000).toISOString() : null,
  expiresAt: outcome === 'ready' ? new Date(Date.now() + 300_000).toISOString() : null,
  outcome,
  reasonCode: outcome === 'ready' ? null : 'VERIFY_CACHE_MISS',
  truth: {
    executionProven: false,
    verificationProven: false,
    semanticCorrectnessProven: false,
    databaseIntegrationProven: false,
    releaseProven: false,
  },
});

function hostToolchain() {
  const executables = {};
  for (const name of ['java', 'maven', 'node', 'pnpm', 'git', 'forgeGovernance']) {
    executables[name] = {
      configuredPath: `/opt/forge-tools/${name}`,
      resolvedPath: `/opt/forge-tools/${name}`,
      bytes: 100,
      modifiedMs: 1,
      version: `${name} 1.0.0`,
    };
  }
  return { javaHome: '/opt/forge-tools/java-home', executables, digest: '8'.repeat(64) };
}

function hostAdmissionReceipt(profiles) {
  return {
    schemaVersion: 2,
    receiptType: 'forge-verify/host-execution-admission',
    admissionId,
    projectSlug: 'forge-project',
    taskId: 'task-one',
    runner: { bootId: '123e4567-e89b-12d3-a456-426614174000', revision: 'vpn73-host-runner-2026.09.03.12' },
    profiles,
    source: {
      head: base,
      workspaceFingerprint: 'c'.repeat(64),
      dependencyManifestFingerprint: 'd'.repeat(64),
    },
    profileCatalogVersion: '2026.09.03.3',
    profilePolicyDigest: '7'.repeat(64),
    toolchain: hostToolchain(),
    issuedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    outcome: 'ready',
    reasonCode: null,
    truth: {
      executionProven: false,
      verificationProven: false,
      semanticCorrectnessProven: false,
      databaseIntegrationProven: false,
      releaseProven: false,
    },
  };
}

function blockedCurrentContractProjection(contractId, sourceFingerprint = 'c'.repeat(64)) {
  const ledgerPayload = {
    schemaVersion: 1,
    summaryType: 'forge-obligation-ledger-summary/v1',
    taskContractId: contractId,
    sourceFingerprint,
    generation: 2,
    ledgerDigest: '4'.repeat(64),
    counts: { total: 14, open: 14, closed: 0, stale: 0 },
    open: Array.from({ length: 14 }, (_, index) => ({ obligationId: `obligation-${index + 1}` })),
    closed: [],
    stale: [],
  };
  const ledgerSummary = { ...ledgerPayload, summaryDigest: canonicalSha256(ledgerPayload) };
  const payload = {
    schemaVersion: 1,
    gateType: 'forge-protected-completion-gate/v1',
    evaluationMode: 'read-only-verifier',
    ledgerDigest: ledgerSummary.ledgerDigest,
    ledgerSummaryDigest: ledgerSummary.summaryDigest,
    sourceFingerprint: `sha256:${sourceFingerprint}`,
    candidateDiffSha256: `sha256:${'5'.repeat(64)}`,
    evaluatedAt: '2026-09-11T08:00:00.000Z',
    signedVerdictVerified: false,
    outcome: 'BOUNDED_BLOCKED',
    maximumTerminalOutcome: 'BOUNDED_BLOCKED',
    cannotClaim: ['verified', 'accepted', 'complete'],
    blockers: [
      { code: 'INDEPENDENT_VERDICT_REQUIRED', detail: 'Current independent verdict is missing.' },
      { code: 'OBLIGATION_LEDGER_OPEN', detail: 'Current obligations remain open.' },
    ],
    ledgerSummary,
    attestation: 'local-integrity-only; upstream-authentication-is-ed25519',
  };
  return { ...payload, gateDigest: canonicalSha256(payload) };
}

function resignProtectedProjection(projection) {
  const { gateDigest: _gateDigest, ...payload } = projection;
  return { ...payload, gateDigest: canonicalSha256(payload) };
}

function strictHostFailingTestReceipt() {
  const receipt = JSON.parse(strictFailingTestReceipt({ profile: 'backend-red-test' }));
  receipt.schemaVersion = 2;
  receipt.receiptType = 'forge-verify/host-run';
  receipt.request.selectorsSha256 = '1'.repeat(64);
  receipt.request.idempotencyDigest = '2'.repeat(64);
  receipt.redExpectation.selectorsSha256 = receipt.request.selectorsSha256;
  receipt.policy = { profileCatalogVersion: '2026.09.03.3', profilePolicyDigest: '7'.repeat(64) };
  receipt.toolchain = hostToolchain();
  receipt.isolation = {
    mode: 'host-toolchain-isolated-taskspace',
    taskStateRoot: '/srv/forge/state/task-one',
    cacheRoot: '/srv/forge/state/task-one/cache',
    globalUserConfigRead: false,
    arbitraryShell: false,
    requestControlledEnvironment: false,
    cleanupProven: true,
  };
  receipt.execution = {
    steps: receipt.execution.steps.map((step) => ({
      executable: '/opt/forge-tools/maven',
      argv: step.argv,
      cwd: step.cwd,
      exitCode: step.exitCode,
      signal: step.signal,
      timedOut: step.timedOut,
      processEnded: true,
      transportUncertain: step.transportUncertain,
      cleanup: { proven: true },
    })),
    exitCode: receipt.execution.exitCode,
    signal: receipt.execution.signal,
    startedAt: receipt.execution.startedAt,
    finishedAt: receipt.execution.finishedAt,
  };
  delete receipt.results.selected;
  receipt.logs = {
    path: '/srv/forge/logs/red.log',
    sha256: 'f'.repeat(64),
    bytes: 200,
    truncated: false,
    redacted: false,
  };
  return JSON.stringify(receipt);
}

test('optional source quality findings stay failed without replacing required verification or spending repair', () => {
  const state = routedState({ suspendHeuristicStops: true });
  const selected = 'forge-server/example/src/main/java/Example.java';
  const command = `forge-verify run --profile backend-source-quality --file ${selected} --admission-id ${admissionId} --idempotency-key source-quality-001`;
  assert.equal(toolDenialReason(state, exec('bash', { command })), undefined);
  const receipt = JSON.parse(strictHostFailingTestReceipt());
  receipt.request.profile = 'backend-source-quality';
  receipt.request.selectors = { files: [selected] };
  delete receipt.redExpectation;
  Object.assign(receipt.results, { executed: 0, passed: 0, failed: 0, skipped: 0, reportFiles: 0 });
  receipt.sourceQuality = sourceQualityPayload({ schemaVersion: 1, mode: 'fast', status: 'findings',
    bundleSha256: SOURCE_QUALITY_BUNDLE_SHA256, files: [{ path: selected, sha256: 'd'.repeat(64) }],
    findings: [{ tool: 'pmd', rule: 'GodClass', reviewKind: 'structure', path: selected }], errors: [] }, 1);
  validateHostRunReceipt(receipt);
  state.mutationCount = 1;
  state.verificationFailed = false;
  state.verificationSequence = 123;
  observeToolResult(state, exec('bash', { command }), ok(JSON.stringify(receipt)));
  assert.equal(receipt.status, 'failed');
  assert.equal(state.verificationFailed, false);
  assert.equal(state.verificationSequence, 123);
  assert.equal(state.repairWindowUsed, false);
  assert.equal(state.verificationProfileReceipts.has('backend-source-quality'), false);
});

test('admission failure leaves bounded job and receipt observations available without granting execution', async () => {
  for (const message of ['VERIFY_EXECUTOR_PROBE_FAILED', 'VERIFY_ADMISSION_TIMEOUT: timed out']) {
    const state = routedState({ suspendHeuristicStops: true });
    state.verificationAdmission.expiresAt = new Date(0).toISOString();
    const failAdmission = async () => { throw new Error(message); };
    await refreshExecutionAdmission(state, failAdmission);
    if (!state.verificationBlocked) await refreshExecutionAdmission(state, failAdmission);
    assert.equal(state.verificationBlocked, true);
    // A failed refresh can leave the previous ready receipt in memory.
    state.verificationAdmission.expiresAt = new Date(Date.now() + 60_000).toISOString();
    state.executionSourceCommit = base;

    const status = `forge-verify status --job-id ${admissionId} --wait-seconds 60`;
    const receipt = `forge-verify receipt --receipt-id ${admissionId}`;
    assert.equal(toolDenialReason(state, exec('bash', { command: status })), undefined);
    assert.equal(toolDenialReason(state, exec('bash', { command: receipt })), undefined);
    assert.equal(state.verificationProfileReceipts.size, 0, 'read permission is not verification proof');
    assert.match(toolDenialReason(state, exec('bash', {
      command: `forge-verify run --profile backend-module-test --module forge-server/example --admission-id ${admissionId} --idempotency-key unavailable-observation`,
    })), /unavailable/u);
    assert.match(toolDenialReason(state, exec('bash', {
      command: `${status}; forge-verify run --profile full-regression`,
    })), /exact reviewed argv shape/u);

    state.phase = PHASES.ROUTE;
    const reminder = reminderForState(state);
    assert.match(reminder, /status.*receipt/u);
    assert.doesNotMatch(reminder, /admission is ready|Current verification admissionId:|Run forge-verify run|keep zero writes and close truthfully/u);
  }
});

test('background acknowledgement never closes proof; only its current Host receipt does, and stopped phases can retrieve it', () => {
  const state = routedState({ maxSteps: 80 });
  state.verificationAdmission.profiles.push('frontend-admin-build');
  const receipt = JSON.parse(strictHostFailingTestReceipt());
  receipt.request.profile = 'frontend-admin-build';
  receipt.request.selectors = {};
  delete receipt.redExpectation;
  receipt.status = 'passed';
  receipt.execution.exitCode = 0;
  for (const step of receipt.execution.steps) step.exitCode = 0;
  receipt.results.failed = 0;
  receipt.results.passed = receipt.results.executed;
  receipt.truth.verificationProven = true;
  receipt.freshness = 'current';
  const command = `forge-verify run --profile frontend-admin-build --admission-id ${admissionId} --idempotency-key background-guard-one --execution-mode background`;
  const ack = { schemaVersion: 1, receiptType: 'forge-verify/host-job', jobId: receipt.jobId, receiptId: receipt.receiptId,
    status: 'accepted', request: { profile: 'frontend-admin-build', admissionId, idempotencyKey: 'background-guard-one', selectors: {} },
    truth: { executionProven: false, verificationProven: false, releaseProven: false } };
  observeToolResult(state, exec('bash', { command }), ok(JSON.stringify(ack)));
  assert.equal(state.verificationFailed, false);
  assert.equal(state.verificationProfileReceipts.has('frontend-admin-build'), false);
  const sequenceBeforeWatch = state.verificationSequence;
  const watch = exec('bash', { command: `forge-verify watch --job-id ${receipt.jobId}`, run_in_background: true });
  observeToolResult(state, watch, ok('started background job bash-2'));
  assert.equal(state.verificationFailed, false, 'native observer startup is not a malformed acceptance receipt');
  assert.equal(state.verificationSequence, sequenceBeforeWatch, 'starting an observer does not execute verification');
  assert.deepEqual(state.verificationObserver, { jobId: receipt.jobId, nativeJobId: 'bash-2', status: 'running' });
  assert.equal(state.verificationProfileReceipts.has('frontend-admin-build'), false);
  observeToolResult(state, exec('job_output', { job_id: 'bash-2' }), ok('Tests passed. [status: completed]'));
  assert.equal(state.verificationProfileReceipts.has('frontend-admin-build'), false, 'native completion text is not Host proof');
  state.progressDecision = { decision: 'STOP', reasonCodes: ['REPEATED_ACTION_RESULT_NO_PROGRESS'] };
  const status = exec('bash', { command: `forge-verify status --job-id ${receipt.jobId} --wait-seconds 60` });
  const read = exec('bash', { command: `forge-verify receipt --receipt-id ${receipt.receiptId}` });
  assert.equal(toolDenialReason(state, status), undefined);
  assert.equal(toolDenialReason(state, read), undefined);
  assert.match(toolDenialReason(state, exec('bash', { command: `forge-verify status --job-id ${admissionId}` })), /closed/u);
  observeToolResult(state, status, ok(JSON.stringify({ active: false, jobId: receipt.jobId, status: 'passed' })));
  assert.equal(state.verificationObserver.status, 'finished');
  assert.equal(state.verificationProfileReceipts.has('frontend-admin-build'), false);
  observeToolResult(state, read, ok(JSON.stringify(receipt)));
  assert.equal(state.verificationProfileReceipts.has('frontend-admin-build'), true);
  const unrelated = routedState();
  observeToolResult(unrelated, read, ok(JSON.stringify(receipt)));
  assert.equal(unrelated.verificationProfileReceipts.has('frontend-admin-build'), false);
});

test('native watch startup preserves prior failures and only recognizes the exact successful background acknowledgement', () => {
  const command = `forge-verify watch --job-id ${admissionId}`;
  const state = routedState();
  state.verificationFailed = true;
  state.verificationBlocked = true;
  state.repairAvailable = true;
  const before = { admission: structuredClone(state.verificationAdmission), actionCeiling: state.actionCeiling,
    repairWindowUsed: state.repairWindowUsed, verificationSequence: state.verificationSequence };
  observeToolResult(state, exec('bash', { command, run_in_background: true }), ok('started background job bash-1'));
  assert.equal(state.verificationFailed, true, 'observation must not erase an earlier verification failure');
  assert.equal(state.verificationBlocked, true);
  assert.equal(state.repairAvailable, true);
  assert.deepEqual(state.verificationAdmission, before.admission);
  assert.equal(state.actionCeiling, before.actionCeiling);
  assert.equal(state.repairWindowUsed, before.repairWindowUsed);
  assert.equal(state.verificationSequence, before.verificationSequence);
  assert.equal(state.verificationProfileReceipts.size, 0);

  for (const [args, result] of [
    [{ command }, ok('started background job bash-1')],
    [{ command, run_in_background: false }, ok('started background job bash-1')],
    [{ command, run_in_background: true }, failed('started background job bash-1')],
    [{ command, run_in_background: true }, ok('started background job bash-1\n[exit code: 1]')],
    [{ command, run_in_background: true }, ok('started background job bash-1; tests passed')],
    [{ command, run_in_background: true }, ok('started background job made-up-id')],
    [{ command, run_in_background: true }, ok('arbitrary non-JSON result')],
    [{ command: `forge-verify receipt --receipt-id ${admissionId}`, run_in_background: true }, ok('started background job bash-1')],
  ]) {
    const invalid = routedState();
    observeToolResult(invalid, exec('bash', args), result);
    assert.equal(invalid.verificationFailed, true, JSON.stringify({ args, result }));
    assert.equal(invalid.verificationObserver, undefined);
    assert.equal(invalid.verificationProfileReceipts.size, 0);
  }
});

function setReadyAdmission(state, profiles = ['backend-red-test', 'backend-module-test']) {
  state.verificationAdmission = {
    sequence: state.sequence,
    outcome: 'ready',
    admissionId,
    profiles,
    dependencyManifestFingerprint: 'd'.repeat(64),
    cachePackDigest: `sha256:${'e'.repeat(64)}`,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  return state;
}

function authorizeWriterState(state, {
  prompt = '修复后端实现并先写回归测试。',
  ownedPaths = ['forge-server/example'],
  actionCeiling = 'workspace-write',
  taskProfiles,
  generation = 0,
} = {}) {
  const contract = compileForgeTaskExecutionContract({
    prompt,
    ownedPaths,
    actionCeiling,
    ...(taskProfiles === undefined ? {} : { taskProfiles }),
  });
  state.executionContextStatus = 'ready';
  state.executionIdentity = {
    taskId: 'task-one',
    executionId: 'execution-one',
    contractId: contract.contractId,
  };
  state.executionContextGeneration = generation;
  state.executionContextExpiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  state.taskContract = contract;
  state.taskIntent = contract;
  state.actionCeiling = contract.actionCeiling;
  state.actionCeilingLocked = true;
  state.tddRequired = contract.tddRequired;
  state.prompt = prompt;
  return state;
}

function routedState(input = {}) {
  const state = createInitialPhaseState({ turn: 1, maxSteps: 40, ...input });
  authorizeWriterState(state);
  observeToolResult(state, exec('skill', { name: 'forge-task-contract' }), ok());
  observeToolResult(state, exec('skill', { name: 'forge-task-router' }), ok());
  observeToolResult(state, exec('skill', { name: 'forge-backend-architecture' }), ok());
  observeToolResult(state, exec('skill', { name: 'forge-change-design' }), ok());
  observeToolResult(state, exec('skill', { name: 'forge-testing-observability' }), ok());
  setReadyAdmission(state);
  return state;
}

const stalePath = 'forge-server/example/src/test/java/StaleCreateTest.java';
const typedFsFailure = (operation, code, relativePath, detail, reportedPath = relativePath) => {
  const text = `Error: cannot ${operation} "/workspace/${reportedPath}": ${detail}`;
  return {
    isError: true,
    error: { message: text.slice('Error: '.length), info: { name: 'FsError', code } },
    content: [{ type: 'text', text }],
  };
};
const staleDeleted = (relativePath = stalePath, reportedPath = relativePath) => typedFsFailure(
  'write', 'FS_STALE_VERSION', relativePath,
  'file no longer exists — re-read the file, then retry', reportedPath,
);
const missingFile = (relativePath = stalePath, reportedPath = relativePath) => typedFsFailure(
  'read', 'FS_NOT_FOUND', relativePath, 'not found', reportedPath,
);

async function createStaleRecoveryRuntime(reasonCode) {
  const handlers = new Map();
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  };
  const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
    maxSteps: 40, admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
  });
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  const state = authorizeWriterState(controller.stateFor(agent, 1), { prompt: '修复后端实现' });
  setReadyAdmission(state);
  const runtime = { handlers, agent, state };
  for (const skill of state.taskContract.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
    await handlers.get('tools/result')(
      { ...exec('skill', { name: skill }, agent), callId: `stale-skill-${skill}` }, ok(),
    );
  }
  runtime.state.currentStep = 9;
  if (reasonCode === 'REPEATED_ACTION_RESULT_NO_PROGRESS') {
    for (const callId of ['repeat-one', 'repeat-two']) {
      observeToolResult(state, { ...exec('read', {
        path: 'forge-server/example/pom.xml',
      }, agent), callId }, ok('same source fact'));
    }
  } else {
    observeToolResult(state, exec('read', { path: 'forge-server/example/First.java' }, agent), failed('first read failed'));
    observeToolResult(state, exec('read', { path: 'forge-server/example/Second.java' }, agent), failed('second read failed'));
  }
  return runtime;
}

async function runRuntimeTool(runtime, tool, result) {
  const decision = await runtime.handlers.get('tools/pre-execute')(tool, async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'allow', decision.reason);
  await runtime.handlers.get('tools/result')(tool, result);
}

async function armStaleCreate(runtime, reportedPath = stalePath) {
  const tool = {
    ...exec('write', { path: stalePath, content: 'first candidate' }, runtime.agent),
    callId: `stale-origin-${reportedPath}`,
  };
  await runRuntimeTool(runtime, tool, staleDeleted(stalePath, reportedPath));
  return tool;
}

test('typed stale deletion permits one same-path read and recreate under only the two incident stops', async (t) => {
  for (const reasonCode of [
    'NO_MACHINE_OBSERVABLE_PROGRESS',
    'REPEATED_ACTION_RESULT_NO_PROGRESS',
  ]) await t.test(reasonCode, async () => {
    const runtime = await createStaleRecoveryRuntime(reasonCode);
    await armStaleCreate(runtime);
    assert.equal(runtime.state.progressDecision.decision, 'STOP');
    assert.deepEqual(runtime.state.progressDecision.reasonCodes, [reasonCode]);
    assert.equal(runtime.state.staleCreate.stage, 'read');
    assert.equal(runtime.state.staleCreate.classifierVersion, 'typed-fs-stale-create/v1');
    assert.equal(runtime.state.staleCreate.writerFacts.stale.reservationObserved, true);
    assert.equal(runtime.state.staleCreate.writerFacts.stale.allowedObserved, true);
    assert.match(runtime.state.staleCreate.resultDigests.stale, /^sha256:[0-9a-f]{64}$/u);

    const read = { ...exec('read', { path: stalePath }, runtime.agent), callId: 'stale-confirm-read' };
    await runRuntimeTool(runtime, read, missingFile());
    assert.equal(runtime.state.staleCreate.stage, 'write');
    assert.match(runtime.state.staleCreate.resultDigests.read, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(runtime.state.progressDecision.decision, 'STOP', 'the detector remains stopped');
    assert.deepEqual(runtime.state.progressDecision.reasonCodes, [reasonCode]);

    const retry = {
      ...exec('write', { path: stalePath, content: 'replacement candidate' }, runtime.agent),
      callId: 'stale-recreate-write',
    };
    await runRuntimeTool(runtime, retry, ok('created'));
    assert.equal(runtime.state.staleCreate.stage, 'consumed');
    assert.equal(runtime.state.staleCreate.outcome, 'retry-succeeded');
    assert.equal(runtime.state.staleCreate.writerFacts.retry.allowedObserved, true);
    assert.equal(runtime.state.mutationAttemptCount, 2);
    assert.equal(runtime.state.mutationCount, 1);
    assert.doesNotMatch(JSON.stringify(runtime.state.staleCreate), /(?:first|replacement) candidate/u);
  });
});

test('stale-create recovery rejects unreserved or path-mismatched evidence and consumes a wrong next call', async () => {
  const unreserved = await createStaleRecoveryRuntime('NO_MACHINE_OBSERVABLE_PROGRESS');
  await unreserved.handlers.get('tools/result')({
    ...exec('write', { path: stalePath, content: 'unreserved' }, unreserved.agent),
    callId: 'unreserved-stale',
  }, staleDeleted());
  assert.equal(unreserved.state.staleCreate, undefined);

  const mismatched = await createStaleRecoveryRuntime('NO_MACHINE_OBSERVABLE_PROGRESS');
  await armStaleCreate(mismatched, 'forge-server/example/src/test/java/Other.java');
  assert.equal(mismatched.state.staleCreate, undefined, 'the reported absolute path must match the exec path');

  const mismatchedRead = await createStaleRecoveryRuntime('NO_MACHINE_OBSERVABLE_PROGRESS');
  await armStaleCreate(mismatchedRead);
  await runRuntimeTool(mismatchedRead, {
    ...exec('read', { path: stalePath }, mismatchedRead.agent), callId: 'mismatched-read-result',
  }, missingFile(stalePath, 'forge-server/example/src/test/java/Other.java'));
  assert.equal(mismatchedRead.state.staleCreate.outcome, 'read-not-confirmed');

  const wrongNext = await createStaleRecoveryRuntime('NO_MACHINE_OBSERVABLE_PROGRESS');
  await armStaleCreate(wrongNext);
  const wrongRead = {
    ...exec('read', { path: 'forge-server/example/src/test/java/Other.java' }, wrongNext.agent),
    callId: 'wrong-next-read',
  };
  const denied = await wrongNext.handlers.get('tools/pre-execute')(
    wrongRead, async () => ({ kind: 'allow' }),
  );
  assert.equal(denied.kind, 'deny');
  assert.equal(wrongNext.state.staleCreate.stage, 'consumed');
  assert.equal(wrongNext.state.staleCreate.outcome, 'unexpected-attempt');
  const correctRead = { ...exec('read', { path: stalePath }, wrongNext.agent), callId: 'too-late-read' };
  assert.equal((await wrongNext.handlers.get('tools/pre-execute')(
    correctRead, async () => ({ kind: 'allow' }),
  )).kind, 'deny');
});

test('stale-create retry reservation is atomic, single-use, and cannot rearm from its result', async () => {
  const runtime = await createStaleRecoveryRuntime('NO_MACHINE_OBSERVABLE_PROGRESS');
  await armStaleCreate(runtime);
  await runRuntimeTool(runtime, {
    ...exec('read', { path: stalePath }, runtime.agent), callId: 'single-read',
  }, missingFile());

  let release;
  const first = {
    ...exec('write', { path: stalePath, content: 'first retry' }, runtime.agent),
    callId: 'single-retry',
  };
  const firstDecision = runtime.handlers.get('tools/pre-execute')(
    first, async () => new Promise((resolve) => { release = resolve; }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.state.staleCreate.stage, 'write-reserved');
  const parallel = {
    ...exec('write', { path: stalePath, content: 'parallel retry' }, runtime.agent),
    callId: 'parallel-retry',
  };
  const parallelDecision = await runtime.handlers.get('tools/pre-execute')(
    parallel, async () => ({ kind: 'allow' }),
  );
  assert.equal(parallelDecision.kind, 'deny');
  assert.equal(runtime.state.staleCreate.stage, 'write-reserved');
  release({ kind: 'allow' });
  assert.equal((await firstDecision).kind, 'allow');
  await runtime.handlers.get('tools/result')(first, staleDeleted());
  assert.equal(runtime.state.staleCreate.stage, 'consumed');
  assert.equal(runtime.state.staleCreate.outcome, 'retry-failed');

  const replay = {
    ...exec('write', { path: stalePath, content: 'third retry' }, runtime.agent),
    callId: 'third-retry',
  };
  const replayDecision = await runtime.handlers.get('tools/pre-execute')(
    replay, async () => ({ kind: 'allow' }),
  );
  assert.equal(replayDecision.kind, 'deny');
  assert.match(replayDecision.reason, /ordinary mutation is closed/u);
});

test('RED adapter accepts only an admitted exact test selector with executed non-infrastructure failures', () => {
  const state = {
    executionProjectionSnapshot: {
      state: {
        projectSlug: 'forge-project',
        taskId: 'task-one',
        sourceFingerprint: 'c'.repeat(64),
        admission: { admissionId, profiles: ['backend-red-test'] },
      },
    },
  };
  const command = exec('bash', {
    command: `forge-verify run --profile backend-red-test --module forge-server/example --test ExampleTest --idempotency-key red-test-0001 --admission-id ${admissionId}`,
  });
  const adapted = adaptVerifyRunToRedGateReceipt(
    state,
    command,
    ok(strictFailingTestReceipt({ profile: 'backend-red-test' })),
  );
  assert.equal(adapted.receipt.receiptType, 'forge-execution/red-gate/v1');
  assert.equal(adapted.receipt.executedTests, 1);
  assert.equal(adapted.receipt.expectedFailureMatched, true);
  assert.match(adapted.receipt.sourceReceiptDigest, /^sha256:[0-9a-f]{64}$/u);

  const hostState = structuredClone(state);
  const hostAdapted = adaptVerifyRunToRedGateReceipt(
    hostState,
    command,
    ok(strictHostFailingTestReceipt()),
  );
  assert.notEqual(hostAdapted, null, hostState.redGateAdapterRejection);
  assert.equal(hostAdapted.receipt.expectedFailureMatched, true);

  const unadmitted = structuredClone(state);
  unadmitted.executionProjectionSnapshot.state.admission.profiles = ['backend-module-test'];
  assert.equal(adaptVerifyRunToRedGateReceipt(
    unadmitted,
    command,
    ok(strictFailingTestReceipt({ profile: 'backend-red-test' })),
  ), null);
  assert.equal(unadmitted.redGateAdapterRejection, 'RED_ADAPTER_ADMISSION_PROFILE');

  const frontendState = structuredClone(state);
  frontendState.executionProjectionSnapshot.state.admission.profiles = ['frontend-red-test'];
  const frontendCommand = exec('bash', {
    command: `forge-verify run --profile frontend-red-test --test-file forge-admin-ui/src/views/example/Example.spec.ts --idempotency-key red-front-0001 --admission-id ${admissionId}`,
  });
  const frontendAdapted = adaptVerifyRunToRedGateReceipt(
    frontendState,
    frontendCommand,
    ok(strictFailingTestReceipt({
      profile: 'frontend-red-test', modules: undefined, tests: undefined,
      testFiles: ['forge-admin-ui/src/views/example/Example.spec.ts'],
    })),
  );
  assert.notEqual(frontendAdapted, null, frontendState.redGateAdapterRejection);
  assert.equal(frontendAdapted.receipt.expectedFailureMatched, true);

  const moduleWideState = structuredClone(state);
  moduleWideState.executionProjectionSnapshot.state.admission.profiles = [
    'backend-red-test', 'backend-module-test',
  ];
  const moduleWideCommand = exec('bash', {
    command: `forge-verify run --profile backend-module-test --module forge-server/example --idempotency-key red-module-0001 --admission-id ${admissionId}`,
  });
  assert.equal(adaptVerifyRunToRedGateReceipt(
    moduleWideState,
    moduleWideCommand,
    ok(strictFailingTestReceipt({ profile: 'backend-module-test' })),
  ), null);
  assert.equal(moduleWideState.redGateAdapterRejection, 'RED_ADAPTER_TEST_PROFILE');

  for (const [mutate, rejection] of [
    [(receipt) => { receipt.taskId = 'another-task'; }, 'RED_ADAPTER_IDENTITY'],
    [(receipt) => { receipt.source.workspaceFingerprint = '9'.repeat(64); }, 'RED_ADAPTER_SOURCE'],
    [(receipt) => { receipt.redExpectation.matched = false; }, 'RED_ADAPTER_RED_EXPECTATION'],
    [(receipt) => { receipt.execution.steps[0].timedOut = true; }, 'RED_ADAPTER_STEPS'],
  ]) {
    const rejectedState = structuredClone(state);
    const rejectedReceipt = JSON.parse(strictFailingTestReceipt({ profile: 'backend-red-test' }));
    mutate(rejectedReceipt);
    assert.equal(adaptVerifyRunToRedGateReceipt(
      rejectedState, command, ok(JSON.stringify(rejectedReceipt)),
    ), null);
    assert.equal(rejectedState.redGateAdapterRejection, rejection);
  }
});

test('task-intent preflight reserves batch admission issuance to the trusted runtime', () => {
  const state = createInitialPhaseState({ turn: 2, maxSteps: 40 });
  authorizeWriterState(state, {
    prompt: '修复后端共享分页 owner，并先写回归测试。',
    taskProfiles: ['backend'],
  });

  const guessed = exec('bash', { command: 'forge-verify admit --profile backend-module-compile' });
  assert.match(toolDenialReason(state, guessed), /issued only by the trusted runtime/u);
  for (const skill of state.taskIntent.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
    observeToolResult(state, exec('skill', { name: skill }), ok());
  }
  assert.match(toolDenialReason(state, guessed), /do not probe or refresh/u);
  assert.match(
    toolDenialReason(state, exec('bash', { command: 'forge-verify admit --profile backend-module-test --profile full-regression' })),
    /issued only by the trusted runtime/u,
  );
});

test('phase state advances only from successful final tool results and binds closeout to post-mutation evidence', () => {
  const state = createInitialPhaseState({ turn: 7, maxSteps: 40 });
  authorizeWriterState(state);
  state.currentStep = 2;
  observeToolResult(state, exec('skill', { name: 'forge-task-contract' }), ok());
  observeToolResult(state, exec('skill', { name: 'forge-task-router' }), ok());
  assert.equal(state.phase, PHASES.DISCOVER);
  observeToolResult(state, exec('skill', { name: 'forge-backend-architecture' }), ok());

  observeToolResult(state, exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }), ok());
  assert.equal(state.phase, PHASES.IMPLEMENT);
  assert.deepEqual(closeoutBlockers(state), [
    'final-governance-audit-missing',
    'typed-verification-profile-missing:backend-module-test',
    'forge-evidence-truth-missing-after-final-evidence',
  ]);

  observeToolResult(
    state,
    exec('bash', { command: `forge-governance audit --root . --base ${base} --format json` }),
    ok(governanceReceipt()),
  );
  assert.equal(state.phase, PHASES.VERIFY);
  assert.deepEqual(closeoutBlockers(state), [
    'typed-verification-profile-missing:backend-module-test',
    'forge-evidence-truth-missing-after-final-evidence',
  ]);

  observeToolResult(
    state,
    exec('bash', { command: `forge-verify run --profile backend-module-test --module forge-server/example --admission-id ${admissionId} --idempotency-key phase-12345678` }),
    ok(verificationReceipt()),
  );

  observeToolResult(state, exec('skill', { skill: 'forge-evidence-truth' }), ok());
  assert.equal(state.phase, PHASES.CLOSEOUT);
  assert.deepEqual(closeoutBlockers(state), []);
  assert.match(toolDenialReason(state, exec('bash', { command: `forge-governance audit --root . --base ${base} --format json` })), /FINAL_ONLY/u);
  assert.match(toolDenialReason(state, exec('read', { path: 'Example.java' })), /FINAL_ONLY/u);

  observeToolResult(state, exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }), failed('denied'));
  assert.equal(state.mutationCount, 1, 'failed mutation must not become an implementation fact');
});

test('loading evidence truth during routing cannot close an untouched task', () => {
  const state = createInitialPhaseState({ turn: 8, maxSteps: 40 });
  authorizeWriterState(state);
  observeToolResult(state, exec('skill', { name: 'forge-task-contract' }), ok());
  observeToolResult(state, exec('skill', { name: 'forge-task-router' }), ok());
  observeToolResult(state, exec('skill', { name: 'forge-evidence-truth' }), ok());

  assert.equal(state.phase, PHASES.DISCOVER);
  assert.equal(toolDenialReason(state, exec('glob', { pattern: '**/PageQuery.java' })), undefined);
  assert.equal(toolDenialReason(state, exec('read', { path: 'PROJECT_CONTEXT.md' })), undefined);

  observeToolResult(state, exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }), ok());
  assert.equal(state.phase, PHASES.IMPLEMENT);
  assert.ok(
    closeoutBlockers(state).includes('forge-evidence-truth-missing-after-final-evidence'),
    'the early Skill load must not satisfy final evidence freshness',
  );
});

test('prepared admin Dockerfile edits agree with exact source mutation scope', () => {
  const target = 'docker-forge-admin/Dockerfile.admin';
  const state = authorizeWriterState(createInitialPhaseState({ suspendHeuristicStops: true }), {
    prompt: '修复应用镜像打包文件。', ownedPaths: [target], taskProfiles: ['backend'],
  });
  setReadyAdmission(state);
  for (const file_path of [target, `./${target}`, `/workspace/${target}`]) {
    assert.equal(toolDenialReason(state, exec('edit', { file_path })), undefined, file_path);
  }
  for (const file_path of [
    'docker-forge-admin/Dockerfile.other', 'docker-forge-admin/.env',
    'docker-forge-admin', `${target}/child.java`,
    `docker-forge-admin/../${target}`, `/outside/${target}`,
  ]) {
    assert.match(toolDenialReason(state, exec('edit', { file_path })), /outside the protected contract/u, file_path);
  }
  const unowned = routedState({ suspendHeuristicStops: true });
  assert.match(toolDenialReason(unowned, exec('edit', { file_path: target })), /outside the protected contract/u);
  state.actionCeiling = 'read-only';
  assert.match(toolDenialReason(state, exec('edit', { file_path: target })), /read-only/u);
});

test('prepared standard change records agree with the mutation guard without granting other Markdown or RED proof', () => {
  const root = 'code-copilot/changes/customer-bilingual-mobile-metadata';
  const records = ['spec.md', 'tasks.md', 'test-spec.md', 'execution-log.md'].map(name => `${root}/${name}`);
  const state = authorizeWriterState(createInitialPhaseState({ suspendHeuristicStops: true }), {
    prompt: '实现移动端双语并记录本次变更与验证。',
    ownedPaths: ['forge-h5-ui/src/locales/labels.js', ...records], taskProfiles: ['shared-owner'],
  });
  setReadyAdmission(state, ['backend-red-test', ...state.taskContract.requiredVerificationProfiles.filter(profile => profile !== 'governance')]);
  for (const target of records) {
    for (const file_path of [target, `./${target}`, `/workspace/${target}`]) {
      assert.equal(toolDenialReason(state, exec('write', { file_path, content: '# Task record' })), undefined, file_path);
    }
    assert.match(toolDenialReason(state, exec('write', { file_path: `${target}/nested.java` })), /outside the protected contract/u);

    const strictState = routedState();
    authorizeWriterState(strictState, { ownedPaths: [target, 'forge-server/example'], taskProfiles: ['backend'] });
    const recordWrite = exec('write', { file_path: target, content: '# Task record' });
    assert.equal(toolDenialReason(strictState, recordWrite), undefined, 'records may precede production implementation');
    observeToolResult(strictState, recordWrite, ok('record saved'));
    assert.equal(strictState.testMutationSequence, 0, 'test-spec is a record, not a test execution or RED mutation');
    assert.match(toolDenialReason(strictState, exec('edit', { file_path: 'forge-server/example/src/main/java/Example.java' })), /explicit test-first contract/u);
  }
  for (const file_path of [`${root}/README.md`, `${root}/tasks.md.bak`, 'AGENTS.md', 'code-copilot/changes/another-task/tasks.md',
    `${root}/../customer-bilingual-mobile-metadata/tasks.md`, `/outside/${root}/tasks.md`]) {
    assert.match(toolDenialReason(state, exec('write', { file_path })), /outside the protected contract/u, file_path);
  }
  const unowned = authorizeWriterState(createInitialPhaseState({ suspendHeuristicStops: true }), {
    prompt: '实现移动端双语并记录设计。', ownedPaths: ['forge-h5-ui/src/locales/labels.js', records[0]], taskProfiles: ['shared-owner'],
  });
  setReadyAdmission(unowned, ['backend-red-test', ...unowned.taskContract.requiredVerificationProfiles.filter(profile => profile !== 'governance')]);
  assert.match(toolDenialReason(unowned, exec('write', { file_path: records[1] })), /outside the protected contract/u);
  state.actionCeiling = 'read-only';
  assert.match(toolDenialReason(state, exec('write', { file_path: records[1] })), /read-only/u);
});

test('mutation gate requires routed Skills, enforces first-mutation and final-quarter bounds, and fails closed without state', () => {
  const write = exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' });
  const state = createInitialPhaseState({ maxSteps: 40 });
  authorizeWriterState(state);
  state.currentStep = 3;
  assert.match(toolDenialReason(state, write), /forge-task-router/u);

  observeToolResult(state, exec('skill', { name: 'forge-task-router' }), ok());
  assert.match(toolDenialReason(state, write), /forge-task-contract/u);
  observeToolResult(state, exec('skill', { name: 'forge-task-contract' }), ok());
  assert.match(toolDenialReason(state, write), /forge-backend-architecture/u);
  observeToolResult(state, exec('skill', { name: 'forge-backend-architecture' }), ok());
  assert.match(toolDenialReason(state, write), /forge-change-design/u);
  observeToolResult(state, exec('skill', { name: 'forge-change-design' }), ok());
  observeToolResult(state, exec('skill', { name: 'forge-testing-observability' }), ok());
  assert.match(toolDenialReason(state, write), /current batch execution admission/u);
  setReadyAdmission(state);
  assert.equal(toolDenialReason(state, write), undefined);

  const productionFirst = exec('edit', { path: 'forge-server/example/src/main/java/ProductionFirst.java' });
  assert.match(toolDenialReason(state, productionFirst), /test-first contract/u);

  const testFirst = routedState();
  testFirst.tddRequired = true;
  const productionEdit = exec('edit', { path: 'forge-server/example/src/main/java/Example.java' });
  assert.match(toolDenialReason(testFirst, productionEdit), /explicit test-first contract/u);
  const testWrite = exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' });
  assert.equal(toolDenialReason(testFirst, testWrite), undefined);
  observeToolResult(testFirst, testWrite, ok());
  assert.equal(toolDenialReason(testFirst, productionEdit), undefined);

  const spec = 'code-copilot/changes/customer-qualification-archive/spec.md';
  const specFirst = routedState();
  authorizeWriterState(specFirst, {
    ownedPaths: [spec, 'forge-server/example'],
    taskProfiles: ['backend'],
  });
  const specWrite = exec('write', { path: spec });
  assert.equal(toolDenialReason(specFirst, specWrite), undefined,
    'the required design Spec may precede the RED test and production source');
  observeToolResult(specFirst, specWrite, ok());
  assert.equal(specFirst.testMutationSequence, 0, 'the Spec does not impersonate the required RED mutation');
  assert.match(toolDenialReason(specFirst, productionEdit), /explicit test-first contract/u);
  assert.match(
    toolDenialReason(specFirst, exec('write', { path: `${spec}/script.sh` })),
    /outside the protected contract/u,
  );
  assert.equal(toolDenialReason(specFirst, testWrite), undefined);
  observeToolResult(specFirst, testWrite, ok());
  assert.equal(toolDenialReason(specFirst, productionEdit), undefined);

  const late = routedState();
  late.currentStep = 20;
  assert.match(toolDenialReason(late, write), /first mutation deadline has passed/u);

  const finalQuarter = routedState();
  finalQuarter.currentStep = 30;
  observeToolResult(finalQuarter, exec('write', { path: 'forge-server/example/src/test/java/ExistingTest.java' }), ok());
  observeToolResult(finalQuarter, exec('edit', { path: 'forge-server/example/src/main/java/Existing.java' }), ok());
  assert.match(toolDenialReason(finalQuarter, write), /final 25 percent/u);
  const controlledTest = exec('bash', { command: `forge-verify run --profile backend-module-test --module forge-server/example --admission-id ${admissionId} --idempotency-key repair-12345678` });
  observeToolResult(finalQuarter, controlledTest, ok(verificationReceipt('backend-module-test', 'failed')));
  assert.equal(finalQuarter.phase, PHASES.REPAIR);
  assert.equal(toolDenialReason(finalQuarter, write), undefined);
  reserveAllowedAttempt(finalQuarter, write);
  assert.equal(toolDenialReason(finalQuarter, write), undefined, 'the monotonic guard must allow the same pre-reserved repair call');
  const parallelRepair = { ...write, callId: 'write-parallel' };
  assert.equal(toolDenialReason(finalQuarter, parallelRepair), undefined);
  observeToolResult(finalQuarter, write, ok());
  assert.equal(finalQuarter.repairMutationCount, 1);
  assert.equal(finalQuarter.repairAvailable, true);
  for (let index = 2; index <= 5; index += 1) {
    const repair = { ...write, callId: `write-${index}` };
    reserveAllowedAttempt(finalQuarter, repair);
    observeToolResult(finalQuarter, repair, ok());
  }
  finalQuarter.mutationsSinceAudit = 0;
  assert.match(toolDenialReason(finalQuarter, parallelRepair), /REPAIR mutation limit/u);

  observeToolResult(
    finalQuarter,
    exec('bash', { command: `forge-governance audit --root . --base ${base} --format json` }),
    ok(governanceReceipt()),
  );
  assert.equal(finalQuarter.repairAvailable, true, 'an incremental audit must not close a backend-test REPAIR window');
  observeToolResult(finalQuarter, controlledTest, ok(verificationReceipt('backend-module-test', 'failed')));
  assert.equal(finalQuarter.repairAvailable, false, 'a second failed verification must not open a second REPAIR window');

  assert.match(toolDenialReason(undefined, write), /fail closed/u);
  assert.equal(toolDenialReason(undefined, exec('read', { path: 'Example.java' })), undefined);
  assert.equal(toolDenialReason(undefined, exec('str_replace_editor', { command: 'view' })), undefined);
  assert.match(toolDenialReason(undefined, exec('str_replace_editor', { command: 'str_replace' })), /fail closed/u);

  const readOnly = routedState();
  readOnly.actionCeiling = 'read-only';
  assert.match(toolDenialReason(readOnly, write), /constrains this execution to read-only/u);

  const closeout = routedState();
  closeout.currentStep = 36;
  assert.match(toolDenialReason(closeout, exec('grep', { pattern: 'class' })), /90 percent/u);
  assert.match(toolDenialReason(closeout, exec('bash', { command: 'mvn test' })), /arbitrary shell/u);
  assert.match(toolDenialReason(closeout, exec('bash', { command: 'git diff --check' })), /arbitrary shell/u);
  assert.equal(toolDenialReason(closeout, exec('bash', { command: `forge-governance audit --root . --base ${base} --format json` })), undefined);
  assert.equal(toolDenialReason(closeout, exec('skill', { name: 'forge-evidence-truth' })), undefined);
});

test('typed run receipt truth opens one source REPAIR and rejects profile or truth mismatches', () => {
  for (const status of ['failed', 'timed-out', 'failed-zero-tests']) {
    const state = routedState();
    observeToolResult(state, exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }), ok());
    const run = exec('bash', {
      command: `forge-verify run --profile backend-module-test --module forge-server/example --admission-id ${admissionId} --idempotency-key ${status}-12345678`,
    });
    observeToolResult(state, run, ok(verificationReceipt('backend-module-test', status)));
    assert.equal(state.verificationFailed, true, status);
    assert.equal(state.repairAvailable, true, status);
    assert.equal(state.phase, PHASES.REPAIR, status);
    assert.equal(state.verificationProfileReceipts.has('backend-module-test'), false, status);

    observeToolResult(state, run, ok(verificationReceipt('backend-module-test', status)));
    assert.equal(state.repairAvailable, false, `${status} must not open a second REPAIR window`);
  }

  for (const invalidReceipt of [
    verificationReceipt('frontend-admin-test', 'failed'),
    verificationReceipt('backend-module-test', 'failed', true),
    verificationReceipt('backend-module-test', 'passed', false),
  ]) {
    const state = routedState();
    observeToolResult(state, exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }), ok());
    const run = exec('bash', {
      command: `forge-verify run --profile backend-module-test --module forge-server/example --admission-id ${admissionId} --idempotency-key invalid-12345678`,
    });
    observeToolResult(state, run, ok(invalidReceipt));
    assert.equal(state.verificationFailed, true);
    assert.equal(state.repairAvailable, false, 'untrusted receipt data cannot authorize source mutation');
    assert.equal(state.verificationProfileReceipts.has('backend-module-test'), false);
  }
});

test('evidence truth cannot seal closeout while a typed verification profile is still missing', () => {
  const state = routedState();
  const testWrite = exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' });
  observeToolResult(state, testWrite, ok());
  observeToolResult(state, exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }), ok());
  observeToolResult(
    state,
    exec('bash', { command: `forge-governance audit --root . --base ${base} --format json` }),
    ok(governanceReceipt()),
  );
  observeToolResult(state, exec('skill', { name: 'forge-evidence-truth' }), ok());

  assert.notEqual(state.phase, PHASES.CLOSEOUT);
  assert.ok(closeoutBlockers(state).includes('typed-verification-profile-missing:backend-module-test'));
  const verification = exec('bash', {
    command: `forge-verify run --profile backend-module-test --module forge-server/example --admission-id ${admissionId} --idempotency-key missing-profile-12345678`,
  });
  assert.equal(toolDenialReason(state, verification), undefined);
  observeToolResult(state, verification, ok(verificationReceipt()));
  assert.ok(closeoutBlockers(state).includes('forge-evidence-truth-missing-after-final-evidence'));
  observeToolResult(state, exec('skill', { name: 'forge-evidence-truth' }), ok());
  assert.equal(state.phase, PHASES.CLOSEOUT);
});

test('arbitrary shell fails closed and a typed verification blocker cannot be retried', () => {
  const state = routedState();
  state.currentStep = 10;
  for (const command of [
    './mvnw -pl forge-modules/forge-demo test',
    'git status --short',
    'node -e process.exit(0)',
    'python -c pass',
    'forge-governance catalog --format json',
  ]) assert.match(toolDenialReason(state, exec('bash', { command })), /arbitrary shell/u, command);
  assert.match(toolDenialReason(state, exec('bash', { command: 'find / -name repository' })), /arbitrary shell/u);
  assert.match(toolDenialReason(state, exec('bash', { command: 'grep mirror ~/.m2/settings.xml' })), /arbitrary shell/u);
  assert.match(toolDenialReason(state, exec('bash', { command: 'curl https://repo.example.test' })), /direct network/u);
  const capability = exec('bash', { command: 'forge-verify capability --profile backend-module-test' });
  assert.equal(toolDenialReason(state, capability), undefined);
  observeToolResult(state, capability, failed('VERIFY_CACHE_MISS'));
  assert.equal(state.verificationBlocked, true);
  assert.match(toolDenialReason(state, capability), /capability is unavailable/u);
});

test('a batch admission cache miss blocks the first mutation before any workspace write', () => {
  const state = createInitialPhaseState({ turn: 4, maxSteps: 40 });
  authorizeWriterState(state);
  for (const skill of [
    'forge-task-contract',
    'forge-task-router',
    'forge-backend-architecture',
    'forge-change-design',
    'forge-testing-observability',
  ]) observeToolResult(state, exec('skill', { name: skill }), ok());

  const capability = exec('bash', { command: 'forge-verify admit --profile backend-module-test' });
  observeToolResult(
    state,
    capability,
    ok(admissionReceipt(['backend-module-test'], 'cache_miss')),
  );

  const firstWrite = exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' });
  assert.equal(state.mutationCount, 0);
  assert.match(toolDenialReason(state, firstWrite), /capability is unavailable/u);
  assert.match(toolDenialReason(state, capability), /do not (?:probe|retry)/u);
});

test('candidate-only writes require an exact trusted test-shadow cache-miss receipt and retain every proof ceiling', async () => {
  const candidateState = async () => {
    const state = createInitialPhaseState({ turn: 4, maxSteps: 40 });
    authorizeWriterState(state);
    state.executionAuthorityClass = 'test-shadow-writer';
    state.protectedExecutionContextValidated = true;
    state.executionTestOnly = true;
    state.executionSourceCommit = base;
    state.executionCaseFamily = 'edge-pagination-shared-owner';
    state.executionProjectSlug = 'forge-project';
    state.testShadowCandidateWriteRequested = true;
    state.testShadowVerificationRunnerRevision = 'vpn-forge-delivery-toolkit-72';
    for (const skill of state.taskIntent.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
      observeToolResult(state, exec('skill', { name: skill }), ok());
    }
    await refreshExecutionAdmission(
      state,
      async (profiles) => JSON.parse(admissionReceipt(profiles, 'cache_miss')),
    );
    return state;
  };

  assert.equal(TEST_SHADOW_CANDIDATE_WRITE_MODE, 'candidate-only-v1');
  const state = await candidateState();
  assert.equal(state.verificationBlocked, true);
  assert.equal(candidateWriteAdmissionCurrent(state), true);
  for (const proof of [
    'executionProven', 'verificationProven', 'semanticCorrectnessProven',
    'databaseIntegrationProven', 'releaseProven',
  ]) assert.equal(state.verificationAdmission.receipt.truth[proof], false, proof);

  for (const [index, args] of [
    { path: 'forge-server/example/../../outside/src/test/java/EscapeTest.java' },
    { path: '/workspace/forge-server/example/../outside/src/test/java/EscapeTest.java' },
    { path: 'forge-server\\example\\..\\outside\\src\\test\\java\\EscapeTest.java' },
    { path: 'forge-server\\example\\src\\test\\java\\BackslashAliasTest.java' },
    { path: 'Forge-Server/example/src/test/java/CaseAliasTest.java' },
    { path: 'C:\\workspace\\forge-server\\example\\src\\test\\java\\EscapeTest.java' },
    { path: '\\\\server\\share\\forge-server\\example\\src\\test\\java\\EscapeTest.java' },
    {
      path: 'forge-server/example/src/test/java/OwnedTest.java',
      file_path: 'outside/src/test/java/EscapeTest.java',
    },
  ].entries()) {
    const attempt = {
      ...exec('write', args),
      callId: `unsafe-candidate-path-${index}`,
      rootCallId: `unsafe-candidate-path-${index}`,
    };
    assert.match(toolDenialReason(state, attempt), /outside the protected contract/u);
  }

  const testWrite = exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' });
  assert.equal(toolDenialReason(state, testWrite), undefined);
  observeToolResult(state, testWrite, ok());
  const sourceWrite = exec('edit', { path: 'forge-server/example/src/main/java/Example.java' });
  assert.equal(toolDenialReason(state, sourceWrite), undefined);
  assert.match(
    toolDenialReason(state, exec('write', { path: 'forge-server/other/Outside.java' })),
    /outside the protected contract/u,
  );
  assert.match(
    toolDenialReason(state, exec('write', { path: 'forge-server/example/pom.xml' })),
    /candidate-cache admission/u,
  );
  assert.match(
    toolDenialReason(state, exec('bash', {
      command: `forge-verify run --profile backend-module-test --module forge-server/example --admission-id ${admissionId} --idempotency-key candidate-only-1234`,
    })),
    /verification capability is unavailable/u,
  );

  const invalidStates = [];
  const noFlag = await candidateState();
  noFlag.testShadowCandidateWriteRequested = false;
  invalidStates.push(noFlag);
  const production = await candidateState();
  production.executionAuthorityClass = 'production-read-only';
  production.executionTestOnly = false;
  invalidStates.push(production);
  const wrongHead = await candidateState();
  wrongHead.verificationAdmission.receipt.source.head = '9'.repeat(40);
  invalidStates.push(wrongHead);
  const missingReceipt = await candidateState();
  missingReceipt.verificationAdmission.receipt = undefined;
  invalidStates.push(missingReceipt);
  const truthRaised = await candidateState();
  truthRaised.verificationAdmission.receipt.truth.verificationProven = true;
  invalidStates.push(truthRaised);
  const forgedCompletionTruth = await candidateState();
  forgedCompletionTruth.verificationAdmission.receipt.truth.completionProven = true;
  invalidStates.push(forgedCompletionTruth);
  const wrongRunner = await candidateState();
  wrongRunner.verificationAdmission.receipt.runner.revision = 'unexpected-runner';
  invalidStates.push(wrongRunner);
  const wrongSchema = await candidateState();
  wrongSchema.verificationAdmission.receipt.schemaVersion = 2;
  invalidStates.push(wrongSchema);
  const wrongReceiptType = await candidateState();
  wrongReceiptType.verificationAdmission.receipt.receiptType = 'forge-verify/capability';
  invalidStates.push(wrongReceiptType);
  const extraEnvelopeField = await candidateState();
  extraEnvelopeField.verificationAdmission.receipt.unreviewedAuthority = true;
  invalidStates.push(extraEnvelopeField);
  const legacyContext = await candidateState();
  legacyContext.protectedExecutionContextValidated = false;
  invalidStates.push(legacyContext);
  const invalidOutcome = await candidateState();
  invalidOutcome.verificationAdmission.outcome = 'cache_invalid';
  invalidOutcome.verificationAdmission.receipt.outcome = 'cache_invalid';
  invalidOutcome.verificationAdmission.reasonCode = 'VERIFY_CACHE_INVALID';
  invalidOutcome.verificationAdmission.receipt.reasonCode = 'VERIFY_CACHE_INVALID';
  invalidStates.push(invalidOutcome);
  for (const invalid of invalidStates) {
    assert.equal(candidateWriteAdmissionCurrent(invalid), false);
    assert.match(toolDenialReason(invalid, testWrite), /capability is unavailable/u);
  }

  observeToolResult(state, sourceWrite, ok());
  const candidateBlockers = closeoutBlockers(state);
  assert.ok(candidateBlockers.includes('final-governance-audit-missing'));
  assert.ok(candidateBlockers.includes('forge-evidence-truth-missing-after-final-evidence'));
  assert.equal(candidateBlockers.some((blocker) => blocker.startsWith('typed-verification-profile-missing:')), false);
});

test('candidate-only authority survives the real v1 protected-context binder but never a legacy resolver payload', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-phase-candidate-context-'));
  try {
    const sourceCommit = '908e13bdc08ec2cbb071d355a2c33a77c970bdd3';
    const promptContent = [{ type: 'text', text: '修复后端分页与共享 owner，并先写失败测试。' }];
    const rpcId = '123e4567-e89b-42d3-a456-426614174111';
    const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
      type: 'client-request', rpcId, method: 'session.prompt',
      payload: { sessionId: 'session-one', mode: 'queue', content: promptContent },
    })), 'session.prompt');
    const actorUserId = '123e4567-e89b-42d3-a456-426614174000';
    const metadata = {
      schemaVersion: 2,
      projectSlug: 'forge-project',
      taskId: 'task-one',
      actorId: 'alice',
      actorUserId,
      conversationId: 'conversation:candidate:001',
      accessMode: 'conversation',
      status: 'active',
    };
    const preparedContext = await prepareProtectedExecutionContext({
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request: {
        ...classified,
        requestId: 'request-one',
        actorUserId,
        actorUsername: 'alice',
        conversationId: metadata.conversationId,
      },
      policyPath: path.resolve('tests/fixtures/forge-harness-behavior-evals/execution-policy.test-shadow.json'),
      trustedPolicyInput: {
        profile: 'test-shadow',
        sourceCommit,
        caseFamily: 'edge-pagination-shared-owner',
      },
    });
    const { idempotent: _idempotent, refreshed: _refreshed, ...context } = preparedContext;

    const activate = async (resolvedContext) => {
      const handlers = new Map();
      let guard;
      const ctx = {
        on(name, handler) { handlers.set(name, handler); },
        tools: { guard(handler) { guard = handler; return () => {}; } },
      };
      const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
        maxSteps: 40,
        testShadowCandidateWriteMode: 'candidate-only-v1',
        testShadowVerificationRunnerRevision: 'vpn-forge-delivery-toolkit-72',
        resolveExecutionContext: async () => resolvedContext,
        admitExecution: async (profiles) => {
          const receipt = JSON.parse(admissionReceipt(profiles, 'cache_miss'));
          receipt.source.head = sourceCommit;
          return receipt;
        },
      });
      const agent = { session: { events: [] }, steer() {}, cancel() {} };
      await handlers.get('agent/pre-step')(
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: promptContent }] }),
      );
      return { controller, handlers, agent, guard };
    };

    const trusted = await activate(context);
    const trustedState = trusted.controller.states.get(trusted.agent);
    assert.equal(trustedState.protectedExecutionContextValidated, true);
    assert.equal(candidateWriteAdmissionCurrent(trustedState), true);
    for (const skill of trustedState.taskIntent.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
      await trusted.handlers.get('tools/result')(exec('skill', { name: skill }, trusted.agent), ok());
    }
    assert.equal(trusted.guard(exec('write', {
      path: 'forge-server/example/src/test/java/ExampleTest.java',
    }, trusted.agent)), undefined);

    const legacy = await activate({ ...context, schemaVersion: 0 });
    const legacyState = legacy.controller.states.get(legacy.agent);
    assert.equal(legacyState.protectedExecutionContextValidated, false);
    assert.equal(legacyState.testShadowCandidateWriteRequested, false);
    assert.equal(candidateWriteAdmissionCurrent(legacyState), false);
    assert.match(legacy.guard(exec('write', {
      path: 'forge-server/example/src/test/java/ExampleTest.java',
    }, legacy.agent)), /capability is unavailable/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability diagnostics cannot replace admission and admission identity, TTL, and dependency boundaries fail closed', () => {
  const firstWrite = exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' });
  const diagnosticOnly = routedState();
  diagnosticOnly.verificationAdmission = undefined;
  diagnosticOnly.verificationProfileCapabilities.set('backend-module-test', { outcome: 'ready', sequence: 1 });
  assert.match(toolDenialReason(diagnosticOnly, firstWrite), /batch execution admission/u);

  const expired = routedState();
  expired.verificationAdmission.expiresAt = new Date(Date.now() - 1).toISOString();
  assert.match(toolDenialReason(expired, firstWrite), /batch execution admission/u);

  const wrongAdmission = exec('bash', {
    command: 'forge-verify run --profile backend-module-test --module forge-server/example --admission-id 223e4567-e89b-12d3-a456-426614174099 --idempotency-key wrong-admission-1234',
  });
  assert.match(toolDenialReason(routedState(), wrongAdmission), /current batch admission id/u);

  const dependencyWrite = exec('write', { path: 'forge-server/example/pom.xml' });
  assert.match(toolDenialReason(routedState(), dependencyWrite), /candidate-cache admission/u);
});

test('trusted runtime admission runs before model work, reuses a healthy lease, and bounds transient retries', async () => {
  const state = createInitialPhaseState({ turn: 11, maxSteps: 40 });
  authorizeWriterState(state, { prompt: '修复后端分页并先写测试' });
  let calls = 0;
  await refreshExecutionAdmission(state, async (profiles) => {
    calls += 1;
    return JSON.parse(admissionReceipt(profiles));
  });
  assert.equal(calls, 1);

  const hostState = createInitialPhaseState({ turn: 13, maxSteps: 40 });
  authorizeWriterState(hostState, { prompt: '修复后端分页并先写测试' });
  await refreshExecutionAdmission(hostState, async (profiles) => hostAdmissionReceipt(profiles));
  assert.equal(hostState.verificationAdmission.executionMode, 'host-toolchain');
  assert.equal(hostState.verificationAdmission.toolchainDigest, '8'.repeat(64));
  assert.equal(Object.hasOwn(hostState.verificationAdmission, 'cachePackDigest'), false);
  await refreshExecutionAdmission(state, async () => {
    calls += 1;
    throw new Error('must not refresh a healthy lease');
  });
  assert.equal(calls, 1);

  const expandedContract = compileForgeTaskExecutionContract({
    prompt: '新增 Forge Admin 管理页面',
    ownedPaths: ['forge-admin-ui/src/views/order/index.vue'],
    actionCeiling: 'workspace-write',
  });
  await refreshExecutionAdmission(state, async (profiles) => {
    calls += 1;
    return JSON.parse(admissionReceipt(profiles));
  }, Date.now(), expandedContract);
  assert.equal(calls, 2, 'a changed-path contract expansion must refresh the trusted admission');
  assert.deepEqual(state.verificationAdmission.profiles, [
    'frontend-red-test',
    'frontend-admin-lint',
    'frontend-admin-test',
    'frontend-admin-typecheck',
    'frontend-admin-build',
  ]);
  assert.equal(state.verificationAdmission.outcome, 'ready');
  assert.equal(state.verificationAdmission.admissionId, admissionId);
  await refreshExecutionAdmission(state, async () => {
    calls += 1;
    throw new Error('must not refresh a healthy lease');
  }, Date.now(), expandedContract);
  assert.equal(calls, 2);

  const transient = createInitialPhaseState({ turn: 12, maxSteps: 40 });
  authorizeWriterState(transient, { prompt: state.prompt });
  const failAdmission = async () => { throw new Error('VERIFY_ADMISSION_TIMEOUT: timed out'); };
  await refreshExecutionAdmission(transient, failAdmission);
  assert.equal(transient.verificationBlocked, false);
  assert.equal(transient.admissionFailure.retryable, true);
  await refreshExecutionAdmission(transient, failAdmission);
  assert.equal(transient.verificationBlocked, true);
  assert.equal(transient.admissionFailure.retryable, false);
});

test('trusted backend phase admits its required compile profile without expanding other phase admissions', async () => {
  const makeState = (overrides = {}) => {
    const state = createInitialPhaseState({ turn: 1, maxSteps: 40, suspendHeuristicStops: true });
    authorizeWriterState(state, { taskProfiles: ['backend', 'security'] });
    Object.assign(state, {
      protectedExecutionContextValidated: true,
      executionAuthorityClass: 'production-task-writer', executionTestOnly: false,
      executionWorkflowId: 'crud-production', executionPhaseId: 'backend', executionPhaseIndex: 4,
      ...overrides,
    });
    return state;
  };
  const state = makeState();
  const originalContract = structuredClone(state.taskContract);
  await refreshExecutionAdmission(state, async (profiles) => hostAdmissionReceipt(profiles));
  assert.ok(state.verificationAdmission.profiles.includes('backend-module-compile'));
  assert.equal(state.verificationAdmission.profiles.includes('backend-test-class'), false);
  assert.deepEqual(state.taskContract, originalContract);
  const command = `forge-verify run --profile backend-module-compile --module forge-server/example --admission-id ${state.verificationAdmission.admissionId} --idempotency-key backend-phase-compile`;
  assert.equal(toolDenialReason(state, exec('bash', { command })), undefined);
  assert.equal(state.verificationProfileReceipts.has('backend-module-test'), false);
  for (const overrides of [
    { executionPhaseId: 'database', executionPhaseIndex: 2 },
    { executionPhaseId: 'frontend', executionPhaseIndex: 5 },
    { executionPhaseIndex: 3 },
    { executionWorkflowId: 'another-workflow' },
    { protectedExecutionContextValidated: false },
    { executionTestOnly: true },
    { executionAuthorityClass: 'test-shadow-writer' },
    { actionCeiling: 'read-only' },
    { executionWorkflowId: null, executionPhaseId: null, executionPhaseIndex: null,
      protectedExecutionContextValidated: false },
  ]) {
    const restricted = makeState(overrides);
    await refreshExecutionAdmission(restricted, async (profiles) => hostAdmissionReceipt(profiles));
    assert.equal(restricted.verificationAdmission?.profiles.includes('backend-module-compile') ?? false, false,
      JSON.stringify(overrides));
    assert.ok(toolDenialReason(restricted, exec('bash', { command })), JSON.stringify(overrides));
  }
});

test('ordinary backend implementation admits scoped compilation without claiming test acceptance', async () => {
  const state = routedState({ suspendHeuristicStops: true });
  state.protectedExecutionContextValidated = true;
  state.executionAuthorityClass = 'production-task-writer';
  state.executionTestOnly = false;
  state.executionWorkflowId = null;
  const required = [...state.taskContract.requiredVerificationProfiles];
  await refreshExecutionAdmission(state, async (profiles) => hostAdmissionReceipt(profiles));
  assert.ok(state.verificationAdmission.profiles.includes('backend-module-compile'));
  assert.deepEqual(state.taskContract.requiredVerificationProfiles, required);
  assert.equal(required.includes('backend-module-compile'), false);
  const command = `forge-verify run --profile backend-module-compile --module forge-server/example --admission-id ${state.verificationAdmission.admissionId} --idempotency-key scoped-compile`;
  assert.equal(toolDenialReason(state, exec('bash', { command })), undefined);
  assert.match(toolDenialReason(state, exec('bash', { command: command.replace(' --module forge-server/example', '') })), /--module/u);
  assert.match(toolDenialReason(state, exec('bash', { command: `${command} --test ExampleTest` })), /does not accept --test/u);
  assert.equal(state.verificationProfileReceipts.has('backend-module-test'), false);
});

test('ordinary backend implementation admits focused diagnostics without changing required acceptance', async () => {
  const state = routedState({ suspendHeuristicStops: true });
  state.protectedExecutionContextValidated = true;
  state.executionAuthorityClass = 'production-task-writer';
  state.executionTestOnly = false;
  state.executionWorkflowId = null;
  const required = [...state.taskContract.requiredVerificationProfiles];
  await refreshExecutionAdmission(state, async (profiles) => hostAdmissionReceipt(profiles));
  assert.ok(state.verificationAdmission.profiles.includes('backend-test-class'));
  assert.deepEqual(state.taskContract.requiredVerificationProfiles, required);
  assert.equal(required.includes('backend-test-class'), false);
  assert.match(reminderForState({ ...state, phase: PHASES.ROUTE }), /Exact batch admission profiles: governance, backend-red-test, backend-module-compile, backend-module-test, backend-test-class\./u);
  const command = `forge-verify run --profile backend-test-class --module forge-server/example --test ExampleTest --admission-id ${state.verificationAdmission.admissionId} --idempotency-key focused-backend`;
  assert.equal(toolDenialReason(state, exec('bash', { command })), undefined);
  const malformed = command.replace('backend-test-class', 'backend-module-test');
  assert.match(toolDenialReason(state, exec('bash', { command: malformed })), /Use backend-test-class/u);
  const missingSelectors = command.replace(' --module forge-server/example --test ExampleTest', '');
  for (const runInBackground of [true, false]) {
    const denial = toolDenialReason(state, exec('bash', { command: missingSelectors, run_in_background: runInBackground }));
    assert.match(denial, /--module.*--test/u);
    assert.match(denial, /not executed|did not execute/u);
  }
  assert.equal(toolDenialReason(state, exec('bash', { command })), undefined);
  assert.equal(state.verificationProfileReceipts.has('backend-module-test'), false);
  assert.match(reminderForState({ ...state, phase: PHASES.VERIFY }), /Honor the current explicit candidate-only or focused-check scope/u);
});

test('trusted runtime admission supports higher production ceilings but not higher test-shadow ceilings', async () => {
  for (const actionCeiling of ['git-checkpoint', 'release']) {
    const state = createInitialPhaseState({ turn: 14, maxSteps: 40 });
    authorizeWriterState(state, { actionCeiling, generation: 1 });
    state.protectedExecutionContextValidated = true;
    state.executionAuthorityClass = 'production-task-writer';
    state.executionTestOnly = false;
    let calls = 0;
    await refreshExecutionAdmission(state, async (profiles) => {
      calls += 1;
      return hostAdmissionReceipt(profiles);
    });
    assert.equal(calls, 1, `${actionCeiling} production context must obtain Host admission`);
    assert.equal(state.verificationAdmission.executionMode, 'host-toolchain');
    assert.deepEqual(state.verificationAdmission.profiles, [
      'governance', 'backend-red-test', 'backend-module-test',
    ]);
  }

  const shadow = createInitialPhaseState({ turn: 15, maxSteps: 40 });
  authorizeWriterState(shadow, { actionCeiling: 'git-checkpoint', generation: 1 });
  shadow.protectedExecutionContextValidated = true;
  shadow.executionAuthorityClass = 'test-shadow-writer';
  shadow.executionTestOnly = true;
  let shadowCalls = 0;
  await refreshExecutionAdmission(shadow, async () => {
    shadowCalls += 1;
    return hostAdmissionReceipt([]);
  });
  assert.equal(shadowCalls, 0, 'test-shadow admission remains workspace-write only');
  assert.equal(shadow.verificationAdmission, undefined);
});

test('production governance uses its exact admitted Host profile and closes both audit and typed receipt state', () => {
  const state = routedState({ maxSteps: 80 });
  state.protectedExecutionContextValidated = true;
  state.executionAuthorityClass = 'production-task-writer';
  state.executionTestOnly = false;
  state.verificationAdmission.profiles = ['governance', 'backend-red-test', 'backend-module-test'];
  observeToolResult(state, exec('edit', {
    path: 'forge-server/example/src/main/java/Example.java', oldText: 'before', newText: 'after',
  }), ok('source edited'));
  assert.ok(closeoutBlockers(state).includes('typed-verification-profile-missing:governance'));

  const governanceRun = exec('bash', {
    command: `forge-verify run --profile governance --admission-id ${admissionId} --idempotency-key production-governance-1234`,
  });
  assert.equal(toolDenialReason(state, governanceRun), undefined);
  observeToolResult(state, governanceRun, ok(verificationReceipt('governance')));
  assert.equal(state.auditSucceeded, true);
  assert.equal(state.auditSequence, state.verificationSequence);
  assert.equal(state.verificationProfileReceipts.has('governance'), true);
  assert.equal(closeoutBlockers(state).includes('final-governance-audit-missing'), false);
  assert.equal(closeoutBlockers(state).includes('typed-verification-profile-missing:governance'), false);

  state.verificationAdmission.profiles = ['backend-red-test', 'backend-module-test'];
  assert.match(toolDenialReason(state, governanceRun), /current batch admission id/u);

  const shadow = routedState({ maxSteps: 80 });
  shadow.protectedExecutionContextValidated = true;
  shadow.executionAuthorityClass = 'test-shadow-writer';
  shadow.executionTestOnly = true;
  assert.deepEqual(shadow.verificationAdmission.profiles, ['backend-red-test', 'backend-module-test']);
  assert.match(toolDenialReason(shadow, governanceRun), /current batch admission id/u);
});

test('production projection requires the same governance-inclusive profile closure as Host admission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-production-governance-projection-'));
  try {
    const state = createInitialPhaseState({ turn: 16, maxSteps: 80 });
    authorizeWriterState(state, { generation: 1 });
    state.protectedExecutionContextValidated = true;
    state.executionAuthorityClass = 'production-task-writer';
    state.executionTestOnly = false;
    state.executionProjectSlug = 'forge-project';
    state.executionContextIssuedAt = new Date(Date.now() - 1_000).toISOString();
    state.executionProjectionRequired = true;
    state.executionProjectionStore = new ForgeExecutionStore({ root });
    await refreshExecutionAdmission(state, async (profiles) => hostAdmissionReceipt(profiles));
    for (const skill of state.taskContract.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
      state.invokedSkills.add(skill);
    }
    await projectPhaseGuardState(state, 'production-governance-test');
    assert.equal(state.executionProjectionStatus, 'ready', state.executionProjectionErrorCode);
    const projected = state.executionProjectionSnapshot.state;
    assert.deepEqual(projected.requiredProfiles, ['backend-module-test', 'governance']);
    assert.deepEqual(projected.redProfiles, ['backend-red-test']);
    assert.deepEqual(projected.admissionProfiles, ['backend-module-test', 'backend-red-test', 'governance']);
    assert.deepEqual(projected.admission.profiles, ['governance', 'backend-red-test', 'backend-module-test']);
    assert.equal(projected.phase, 'DISCOVER');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const authorityClass of ['production-task-writer', 'test-shadow-writer']) {
  test(`${authorityClass} Host admission is renewed after successful writes and never reuses a stale lease on renewal failure`, async () => {
    const state = routedState({ maxSteps: 80 });
    state.executionAuthorityClass = authorityClass;
    state.protectedExecutionContextValidated = true;
    state.executionTestOnly = authorityClass === 'test-shadow-writer';
    state.verificationAdmission = undefined;
    let calls = 0;
    const admit = async (profiles) => {
      calls += 1;
      return { ...hostAdmissionReceipt(profiles),
        admissionId: `123e4567-e89b-12d3-a456-${String(calls).padStart(12, '0')}`,
        source: { ...hostAdmissionReceipt(profiles).source,
          workspaceFingerprint: String(calls).repeat(64) } };
    };
    await refreshExecutionAdmission(state, admit);
    const before = state.verificationAdmission.admissionId;
    observeToolResult(state, exec('write', {
      path: 'forge-server/example/src/test/java/ExampleTest.java', content: 'new regression',
    }), ok('test written'));
    await refreshExecutionAdmission(state, admit);
    assert.equal(calls, 2);
    assert.notEqual(state.verificationAdmission.admissionId, before);
    assert.equal(state.verificationAdmission.sequence, state.mutationSequence);
    assert.equal(state.verificationAdmission.sourceWorkspaceFingerprint, '2'.repeat(64));
    assert.deepEqual(state.verificationAdmission.profiles, authorityClass === 'production-task-writer'
      ? ['governance', 'backend-red-test', 'backend-module-test']
      : ['backend-red-test', 'backend-module-test']);
    await refreshExecutionAdmission(state, admit);
    assert.equal(calls, 2, 'unchanged source reuses the current lease');
    observeToolResult(state, exec('edit', {
      path: 'forge-server/example/src/main/java/Example.java', oldText: 'missing', newText: 'changed',
    }), failed('no edit applied'));
    await refreshExecutionAdmission(state, admit);
    assert.equal(calls, 2, 'a failed edit does not trigger admission renewal');

    observeToolResult(state, exec('edit', {
      path: 'forge-server/example/src/main/java/Example.java', oldText: 'before', newText: 'after',
    }), ok('source edited'));
    await refreshExecutionAdmission(state, async () => { throw new Error('VERIFY_ADMISSION_TIMEOUT'); });
    assert.equal(state.verificationAdmission, undefined, 'stale admission must not survive a failed refresh');
    assert.equal(state.admissionFailure.retryable, true);
    await refreshExecutionAdmission(state, admit);
    assert.equal(calls, 3);
    assert.equal(state.verificationAdmission.sourceWorkspaceFingerprint, '3'.repeat(64));
    assert.equal(state.mutationCount, 2, 'renewal does not reset progress or authorize extra writes');
  });
}

test('production notices route governance through the current Host admission without a model-selected base', () => {
  const state = routedState({ maxSteps: 80 });
  state.protectedExecutionContextValidated = true;
  state.executionAuthorityClass = 'production-task-writer';
  state.executionSourceCommit = base;
  state.executionTestOnly = false;
  state.verificationAdmission.profiles = ['governance', 'backend-red-test', 'backend-module-test'];
  state.phase = PHASES.IMPLEMENT;
  const first = reminderForState(state);
  assert.equal(first.includes('forge-governance audit'), false);
  assert.equal(first.includes(`--base ${base}`), false);
  assert.ok(first.includes(`forge-verify run --profile governance --admission-id ${admissionId}`));
  assert.ok(first.includes('the Host binds the trusted governance base'));
  assert.match(first, /When governance is within the current requested verification scope/u);
  assert.ok(first.includes(`Current verification admissionId: ${admissionId}`));
  assert.ok(first.includes('Run profiles sequentially'));
  assert.ok(first.includes('Backend compilation'));
  assert.ok(first.includes('without --wait-seconds'));
  assert.ok(first.includes('on continuation observe that same job first'));
  assert.equal(first.includes('bash timeoutMs=600000'), false);
  assert.equal(first.includes('--wait-seconds 60'), false);
  const renewedId = '223e4567-e89b-12d3-a456-426614174099';
  state.verificationAdmission.admissionId = renewedId;
  state.phase = PHASES.VERIFY;
  assert.ok(reminderForState(state).includes(`Current verification admissionId: ${renewedId}`));
  assert.equal(reminderForState(state).includes(admissionId), false);
  state.verificationAdmission = undefined;
  assert.match(reminderForState(state), /Current verification admission is unavailable/u);
  for (const change of [
    { protectedExecutionContextValidated: false },
    { executionAuthorityClass: 'test-shadow-writer', executionTestOnly: true },
    { executionAuthorityClass: 'production-read-only' },
    { executionContextExpiresAt: new Date(0).toISOString() },
    { executionContextExpiresAt: undefined },
    { executionSourceCommit: 'HEAD' },
    { executionContextStatus: 'unavailable' },
  ]) {
    const candidate = { ...state, ...change };
    assert.equal(reminderForState(candidate).includes('the Host binds the trusted governance base'), false);
  }
});

function admissionNoticeFixture() {
  const handlers = new Map();
  let admissions = 0;
  const controller = installRuntimePhaseBudgetGuard({
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  }, (input) => ({ role: 'user', ...input }), {
    admitExecution: async (profiles) => ({ ...hostAdmissionReceipt(profiles),
      admissionId: `123e4567-e89b-12d3-a456-${String(++admissions).padStart(12, '0')}` }),
    resolveExecutionContext: null,
  });
  const agent = { session: { events: [] } };
  const state = controller.stateFor(agent, 1);
  Object.assign(state, routedState({ maxSteps: 80, suspendHeuristicStops: true }), {
    protectedExecutionContextValidated: true, executionAuthorityClass: 'production-task-writer',
    executionTestOnly: false, executionSourceCommit: base, verificationAdmission: undefined,
  });
  const write = () => observeToolResult(state, exec('edit', {
    path: 'forge-server/example/src/main/java/Example.java', oldText: 'before', newText: 'after',
  }), ok('source edited'));
  write();
  let step = 0;
  const enter = async (messages = []) => {
    const result = await handlers.get('agent/pre-step')(
      { agent, turn: 1, step: ++step, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages }),
    );
    return result.messages.at(-1)?.content?.[0]?.text ?? '';
  };
  return { agent, state, write, enter };
}

test('admission-only renewal sends the current ID without repeating static rules or weakening tool guards', async () => {
  const { state, write, enter } = admissionNoticeFixture();
  const full = await enter();
  const originalId = state.verificationAdmission.admissionId;
  assert.match(full, /ORDINARY RESPONSE CONTRACT/u);
  write();
  const update = await enter();
  const currentId = state.verificationAdmission.admissionId;
  assert.notEqual(currentId, originalId);
  assert.match(update, /This current-source ID replaces earlier admission IDs/u);
  assert.ok(update.includes(currentId));
  assert.ok(update.includes(state.taskContract.contractId));
  assert.ok(update.includes(state.actionCeiling));
  assert.equal(update.includes(originalId), false);
  assert.doesNotMatch(update, /ORDINARY RESPONSE CONTRACT|Run profiles sequentially/u);
  assert.ok(update.length < full.length / 4, 'ID renewal must not republish the static policy');
  assert.match(toolDenialReason(state, exec('bash', {
    command: `forge-verify run --profile governance --admission-id ${originalId} --idempotency-key stale-source-id`,
  })), /current batch admission id/u);
  assert.equal(toolDenialReason(state, exec('bash', {
    command: `forge-verify run --profile governance --admission-id ${currentId} --idempotency-key current-source-id`,
  })), undefined);
  assert.match(toolDenialReason(state, exec('write', { path: 'ops/project.env' })), /owned|scope|contract/iu);
  assert.equal(await enter(), '', 'unchanged admission requires no additional notice');
});

test('admission-only renewal restores full rules after compaction even when the ID is unchanged', async () => {
  const { agent, state, write, enter } = admissionNoticeFixture();
  await enter();
  write();
  assert.match(await enter(), /This current-source ID replaces earlier admission IDs/u);
  const currentId = state.verificationAdmission.admissionId;
  agent.session.events.push({ type: 'compaction/summary', seq: 41, data: { compactionId: 'summary-one' } });
  const restored = await enter();
  assert.match(restored, /ORDINARY RESPONSE CONTRACT/u);
  assert.match(restored, /Run profiles sequentially/u);
  assert.ok(restored.includes(currentId));
  write();
  assert.match(await enter(), /This current-source ID replaces earlier admission IDs/u);
});

test('admission-only renewal retains full guidance when authority, scope or phase changes', async (t) => {
  for (const [name, change] of [
    ['authority', (state) => { state.actionCeiling = 'release'; }],
    ['contract scope', (state) => { state.taskContract = { ...state.taskContract, contractId: 'f'.repeat(64) }; }],
    ['phase', (state) => { state.verificationSequence = state.sequence + 100; }],
    ['user scope', (state) => { state.prompt = '只修当前后端文件，不执行额外验证'; }],
  ]) await t.test(name, async () => {
    const { state, write, enter } = admissionNoticeFixture();
    await enter();
    change(state);
    write();
    const notice = await enter();
    if (name === 'phase') assert.equal(state.phase, PHASES.VERIFY);
    assert.match(notice, /ORDINARY RESPONSE CONTRACT/u);
    assert.doesNotMatch(notice, /This current-source ID replaces earlier admission IDs/u);
    assert.ok(notice.includes(state.verificationAdmission.admissionId));
  });
});

test('successful tool result is followed by automatic Host renewal and a current-ID notice at the next model step', async () => {
  const handlers = new Map();
  const contract = compileForgeTaskExecutionContract({
    prompt: '修改调查页面并完成必要测试',
    ownedPaths: ['forge-admin-ui/src'],
    actionCeiling: 'workspace-write',
  });
  let calls = 0;
  const initialId = '123e4567-e89b-12d3-a456-426614174081';
  const mutationId = '123e4567-e89b-12d3-a456-426614174082';
  const nextId = '123e4567-e89b-12d3-a456-426614174083';
  const controller = installPhaseBudgetGuard({
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  }, (input) => ({ role: 'user', ...input }), {
    admitExecution: async (profiles) => ({ ...hostAdmissionReceipt(profiles),
      admissionId: [initialId, mutationId, nextId][calls++] }),
    resolveExecutionContext: async () => ({
      taskId: 'task-one', executionId: 'production-hook-renewal', generation: 1,
      authorityClass: 'production-task-writer', testOnly: false,
      sourceCommit: base, contract,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    }),
  });
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  const step = (index, messages) => handlers.get('agent/pre-step')(
    { agent, turn: 1, step: index, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages }),
  );
  await step(1, [{ role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '修改调查页面并完成必要测试' }] }]);
  const state = controller.states.get(agent);
  // Resolver transport validation is covered separately; this test exercises the hook sequence.
  state.protectedExecutionContextValidated = true;
  for (const name of contract.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
    await handlers.get('tools/result')(exec('skill', { name }, agent), ok());
  }
  const mutation = exec('write', {
    path: 'forge-admin-ui/src/views/accident/__tests__/investigate-tab-filter.test.js',
    content: 'focused regression',
  }, agent);
  const allowed = await handlers.get('tools/pre-execute')(mutation, async () => ({ kind: 'allow' }));
  assert.equal(allowed.kind, 'allow');
  await handlers.get('tools/result')(mutation, ok('test written'));
  assert.equal(calls, 2, 'validated production mutation preflight refreshes the incomplete initial lease');
  const entered = await step(2, []);
  assert.equal(calls, 3);
  const notice = entered.messages.flatMap((message) => message.content ?? []).map((block) => block.text ?? '').join('\n');
  assert.ok(notice.includes(nextId));
  assert.equal(notice.includes(initialId), false);
  assert.equal(notice.includes(`--base ${base}`), false);
  assert.ok(notice.includes(`forge-verify run --profile governance --admission-id ${nextId}`));
  assert.match(toolDenialReason(state, exec('bash', {
    command: `forge-verify run --profile frontend-admin-test --admission-id ${initialId} --idempotency-key prior-source-1234`,
  }, agent)), /current batch admission id/u);
  await step(3, []);
  assert.equal(calls, 3, 'a subsequent step without another write reuses the same lease');
});

async function checkpointGuardFixture(t, { integrated = false, edited = false, resolveBarrier, direct = false } = {}) {
  if (direct) {
    const mode = process.env.FORGE_DEVELOPMENT_MODE, socket = process.env.FORGE_TOOL_WORKER_SOCKET;
    process.env.FORGE_DEVELOPMENT_MODE = 'direct'; process.env.FORGE_TOOL_WORKER_SOCKET = '/run/forge-tool-worker/worker.sock';
    t.after(() => {
      mode === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = mode;
      socket === undefined ? delete process.env.FORGE_TOOL_WORKER_SOCKET : process.env.FORGE_TOOL_WORKER_SOCKET = socket;
    });
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-guard-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompt = '修改调查页面并验证发布。';
  const content = [{ type: 'text', text: prompt }];
  const actorUserId = '123e4567-e89b-42d3-a456-426614174000';
  const metadata = { schemaVersion: 2, projectSlug: 'forge-project', taskId: 'task-one', actorId: 'alice', actorUserId,
    conversationId: 'conversation:checkpoint:001', accessMode: 'conversation', status: 'active' };
  const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request',
    rpcId: 'rpc-checkpoint-guard', method: 'session.prompt',
    payload: { sessionId: 'session-one', mode: 'queue', content } })), 'session.prompt');
  const request = { ...classified, requestId: 'request-checkpoint', actorUserId,
    actorUsername: 'alice', conversationId: metadata.conversationId };
  const taskAuthority = { actionCeiling: 'release', ownedPaths: direct ? ['.'] : ['forge-admin-ui/src'],
    taskProfiles: direct ? ['project-files'] : ['frontend-admin'] };
  const contract = compileForgeTaskExecutionContract({ prompt, ...taskAuthority }, direct ? { developmentMode: 'direct' } : {});
  if (direct) taskAuthority.contract = contract;
  const binding = { projectSlug: metadata.projectSlug, taskId: metadata.taskId, actorUserId, actorUsername: 'alice',
    conversationId: metadata.conversationId, dshSessionId: classified.dshSessionId, route: classified.route,
    rpcId: classified.rpcId, promptDigest: classified.textDigest, sourceCommit: base, workspaceFingerprint: 'c'.repeat(64),
    caseFamily: 'maintenance', productionAuthorityId: '123e4567-e89b-42d3-a456-426614174226',
    controllerGrantDigest: '3'.repeat(64), contractId: contract.contractId, ...taskAuthority };
  const prepared = await prepareProtectedExecutionContext({ projectRoot: root, projectSlug: metadata.projectSlug,
    taskMetadata: metadata, request, policyPath: path.resolve('docker/harness/forge-execution-policy.json'),
    trustedPolicyInput: { profile: 'production-controller', sourceCommit: base, workspaceFingerprint: binding.workspaceFingerprint,
      caseFamily: binding.caseFamily, productionAuthorityId: binding.productionAuthorityId,
      productionAuthorityDigest: digestProductionTaskAuthorityBinding(binding), controllerGrantDigest: binding.controllerGrantDigest,
      expectedContractId: contract.contractId, taskAuthority } });
  const { idempotent: _idempotent, refreshed: _refreshed, ...context } = prepared;
  const nextContext = { ...context, sourceCommit: 'd'.repeat(40),
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174227', controllerGrantDigest: '4'.repeat(64) };
  if (integrated) Object.assign(nextContext, {
    executionId: '123e4567-e89b-42d3-a456-426614174229',
    claimId: '123e4567-e89b-42d3-a456-426614174230',
    generation: context.generation + 1, workspaceFingerprint: 'e'.repeat(64),
  });
  nextContext.productionAuthorityDigest = digestProductionTaskAuthorityBinding(nextContext);
  let resolvedContext = context;
  let calls = 0, admissions = 0, completions = 0;
  const handlers = new Map();
  const controller = installRuntimePhaseBudgetGuard({ on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } } }, (input) => ({ role: 'user', ...input }), {
    resolveExecutionContext: async (input) => {
      calls += 1;
      await resolveBarrier?.(calls, input);
      if (resolvedContext instanceof Error) throw resolvedContext;
      return structuredClone(resolvedContext);
    },
    resolveProtectedCompletion: async () => {
      completions += 1;
      return blockedCurrentContractProjection(contract.contractId, resolvedContext.workspaceFingerprint);
    },
    admitExecution: async (profiles) => {
      admissions += 1;
      const receipt = hostAdmissionReceipt(profiles);
      receipt.admissionId = admissions === 1 ? admissionId : '223e4567-e89b-12d3-a456-426614174099';
      receipt.source.head = resolvedContext.sourceCommit;
      receipt.source.workspaceFingerprint = edited && admissions === 1 ? 'f'.repeat(64) : resolvedContext.workspaceFingerprint;
      return receipt;
    },
  });
  const agent = { session: { id: classified.dshSessionId, events: [] }, steer() {}, cancel() {} };
  const step = (index, messages = []) => handlers.get('agent/pre-step')(
    { agent, turn: 1, step: index, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages }));
  await step(1, [{ role: 'user', source: { kind: 'user' }, content }]);
  const payload = { schemaVersion: 1, operationId: '123e4567-e89b-42d3-a456-426614174228',
    task: Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
      .map((key) => [key, context[key]])),
    from: { head: context.sourceCommit, fingerprint: edited ? 'f'.repeat(64) : context.workspaceFingerprint },
    to: { head: nextContext.sourceCommit, fingerprint: nextContext.workspaceFingerprint }, canonicalHead: base,
    phase: integrated ? 'integrated' : 'checkpointed', sourceAuthority: Object.fromEntries(['executionId', 'generation', 'contractId',
      'productionAuthorityDigest', 'controllerGrantDigest', 'actionCeiling', 'issuedAt', 'expiresAt']
      .map((key) => [key, context[key]])), digestAlgorithm: 'sha256', digestEncoding: 'canonical-json-v1' };
  const sourceTransition = { ...payload, digest: sourceTransitionCanonicalDigest(payload) };
  const result = { ok: true, result: integrated ? {
    operation: 'integrate', status: 'integrated', operationId: sourceTransition.operationId,
    canonicalHead: base, head: nextContext.sourceCommit, workspaceFingerprint: nextContext.workspaceFingerprint,
    workspaceClean: true, sourceTransition,
  } : { operation: 'checkpoint', status: 'checkpointed', beforeHead: base,
    commit: nextContext.sourceCommit, workspaceFingerprint: nextContext.workspaceFingerprint,
    workspaceClean: true, sourceTransition } };
  const checkpoint = exec('bash', { command: integrated
    ? `forge-release integrate --mode start --expected-head ${base} --expected-fingerprint ${payload.from.fingerprint} --canonical-head ${base}`
    : `forge-release checkpoint --path forge-admin-ui/src/checkpoint.ts --message-base64 Y2hlY2twb2ludA --expected-head ${base} --expected-fingerprint ${context.workspaceFingerprint}` }, agent);
  return { handlers, controller, agent, context, nextContext, checkpoint, result, step,
    calls: () => calls, admissions: () => admissions, completions: () => completions,
    setContext(value) { resolvedContext = value; } };
}

test('direct tool execution renews authority that expires after the model step', async (t) => {
  const value = await checkpointGuardFixture(t, { direct: true, resolveBarrier: async (calls, input) => {
    if (calls > 1) {
      assert.equal(input.sourceTransition, null);
      assert.deepEqual(input.renewal, { rpcId: 'rpc-checkpoint-guard', dshSessionId: 'session-one' });
    }
  } });
  for (const [name, args] of [['read', { path: 'forge-admin-ui/src/example.vue' }],
    ['job_output', { job_id: 'bash-9' }], ['job_list', {}],
    ['bash', { command: 'forge-release status' }], ['bash', { command: 'forge-verify admit --profile frontend-admin-test' }],
    ['skill', { name: 'forge-testing-observability' }]]) {
    const current = value.controller.states.get(value.agent);
    current.executionContextExpiresAt = new Date(Date.now() - 1).toISOString();
    const before = value.calls();
    const result = await value.handlers.get('tools/pre-execute')(exec(name, args, value.agent), async () => ({ kind: 'allow' }));
    assert.equal(value.calls(), before + 1, name);
    assert.equal(result.kind, 'allow', result.reason);
    assert.equal(value.controller.states.get(value.agent).executionRpcId, value.context.rpcId);
  }
});

test('direct tool renewal failure keeps expired authority denied', async (t) => {
  const value = await checkpointGuardFixture(t, { direct: true });
  const current = value.controller.states.get(value.agent);
  current.executionContextExpiresAt = new Date(Date.now() - 1).toISOString();
  value.setContext(new Error('trusted renewal unavailable'));
  let executed = false;
  const result = await value.handlers.get('tools/pre-execute')(exec('bash', { command: 'forge-release status' }, value.agent),
    async () => { executed = true; return { kind: 'allow' }; });
  assert.equal(result.kind, 'deny'); assert.match(result.reason, /unexpired/);
  assert.equal(executed, false);
});

test('scoped checkpoint refreshes protected source authority while reporting unrelated dirty candidates honestly', async (t) => {
  const value = await checkpointGuardFixture(t);
  value.result.result.workspaceClean = false;
  value.result.result.remainingDirtyPaths = ['forge-server/example/src/prior.java'];
  value.setContext(value.nextContext);
  await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result) + '\n[exit code: 0]'));
  const state = value.controller.states.get(value.agent);
  assert.equal(value.calls(), 2);
  assert.equal(state.executionSourceCommit, value.nextContext.sourceCommit);
  assert.equal(state.executionIdentity.executionId, value.context.executionId);
  assert.equal(state.verificationAdmission, undefined);
  assert.equal(state.completionGateDigest, undefined);
});

test('successful controlled checkpoint refreshes the same-RPC guard before its next verification and release', async (t) => {
  const value = await checkpointGuardFixture(t);
  assert.equal((await value.handlers.get('tools/pre-execute')(value.checkpoint, async () => ({ kind: 'allow' }))).kind, 'allow');
  value.setContext(value.nextContext);
  await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result) + '\n[exit code: 0]'));
  assert.equal(value.calls(), 2);
  const state = value.controller.states.get(value.agent);
  assert.equal(state.executionSourceCommit, value.nextContext.sourceCommit);
  assert.equal(state.executionIdentity.executionId, value.context.executionId);
  assert.equal(state.executionContextGeneration, value.context.generation);
  assert.equal(state.executionRpcId, value.context.rpcId);
  assert.equal(state.taskContract.contractId, value.context.contractId);
  assert.equal(state.verificationAdmission, undefined, 'the old HEAD admission must be replaced');
  assert.equal(state.completionGateDigest, undefined, 'old acceptance observations cannot survive the new candidate');
  assert.equal(value.completions(), 1);
  await value.step(2);
  assert.equal(value.calls(), 2, 'the next step does not poll an already refreshed context');
  assert.equal(value.admissions(), 2);
  assert.equal(value.completions(), 2);
  assert.equal(state.verificationAdmission.receipt.source.head, value.nextContext.sourceCommit);
  for (const command of [
    `forge-verify run --profile governance --admission-id ${state.verificationAdmission.admissionId} --idempotency-key checkpoint-governance`,
    'forge-release release --services forge-admin',
  ]) {
    const allowed = await value.handlers.get('tools/pre-execute')(exec('bash', { command }, value.agent), async () => {
      assert.equal(value.controller.states.get(value.agent).executionSourceCommit, value.nextContext.sourceCommit);
      return { kind: 'allow' };
    });
    assert.equal(allowed.kind, 'allow', allowed.reason);
  }
  assert.match(reminderForState(state), /same RPC/u);
  assert.doesNotMatch(reminderForState(state), /any new HEAD requires/u);
  await value.step(3);
  assert.equal(value.completions(), 2, 'unchanged source does not repeatedly poll completion');
});

test('next step awaits the unawaited checkpoint result observer before publishing current admission', async (t) => {
  let release;
  let resolving;
  const entered = new Promise((resolve) => { resolving = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const value = await checkpointGuardFixture(t, { resolveBarrier: async (calls) => {
    if (calls > 1) { resolving(); await barrier; }
  } });
  value.setContext(value.nextContext);
  // Pinned dsh-tools emits result observers without awaiting their promises.
  const result = value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result)));
  await entered;
  const next = value.step(2);
  await new Promise((resolve) => setImmediate(resolve));
  const callsBeforeRelease = value.calls();
  release();
  const [, decision] = await Promise.all([result, next]);
  assert.equal(callsBeforeRelease, 2, 'the next step joins the existing refresh instead of racing it');
  const state = value.controller.states.get(value.agent);
  assert.equal(state.executionSourceCommit, value.nextContext.sourceCommit);
  assert.equal(state.verificationAdmission.receipt.source.head, value.nextContext.sourceCommit);
  assert.equal(value.admissions(), 2);
  const notices = decision.messages.flatMap((message) => message.content ?? []).map((block) => block.text ?? '').join('\n');
  assert.ok(notices.includes(state.verificationAdmission.admissionId));
  assert.ok(!notices.includes(admissionId));
});

test('successful controlled integrate refreshes the same RPC into a new generation with fresh verification', async (t) => {
  const value = await checkpointGuardFixture(t, { integrated: true });
  const previous = value.controller.states.get(value.agent);
  previous.verificationProfileReceipts.set('frontend-admin-test', { receiptId: 'old-source-proof' });
  previous.completionGateDigest = 'f'.repeat(64);
  assert.equal((await value.handlers.get('tools/pre-execute')(value.checkpoint, async () => ({ kind: 'allow' }))).kind, 'allow');
  value.setContext(value.nextContext);
  await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result) + '\n[exit code: 0]'));
  assert.equal(value.calls(), 2);
  const state = value.controller.states.get(value.agent);
  assert.notEqual(state, previous);
  assert.equal(state.executionIdentity.executionId, value.nextContext.executionId);
  assert.equal(state.executionContextGeneration, value.context.generation + 1);
  assert.equal(state.executionSourceCommit, value.nextContext.sourceCommit);
  assert.equal(state.executionWorkspaceFingerprint, value.nextContext.workspaceFingerprint);
  assert.equal(state.executionRpcId, value.context.rpcId);
  assert.equal(state.executionTextDigest, value.context.textDigest);
  assert.equal(state.taskContract.contractId, value.context.contractId);
  assert.equal(state.actionCeiling, 'release');
  assert.equal(state.prompt, previous.prompt);
  assert.equal(state.verificationAdmission, undefined);
  assert.equal(state.completionGateDigest, null);
  assert.equal(state.verificationProfileReceipts.size, 0, 'old-source checks cannot satisfy the integrated candidate');
  await value.step(2);
  assert.equal(value.admissions(), 2);
  assert.equal(value.completions(), 2);
  assert.equal(state.verificationAdmission.receipt.source.head, value.nextContext.sourceCommit);
  assert.equal(state.verificationAdmission.receipt.source.workspaceFingerprint, value.nextContext.workspaceFingerprint);
  assert.equal(toolDenialReason(state, exec('bash', { command: `forge-verify run --profile governance --admission-id ${state.verificationAdmission.admissionId} --idempotency-key integrated-governance` }, value.agent)), undefined);
  assert.match(toolDenialReason(state, exec('bash', { command: `forge-verify run --profile governance --admission-id ${admissionId} --idempotency-key stale-governance` }, value.agent)), /admission/u);
  assert.match(reminderForState(state), /integrate.*same RPC.*fresh acceptance/u);
  assert.doesNotMatch(reminderForState(state), /integrate.*requires a new Controller-bound round/u);
  await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result)));
  await value.step(3);
  assert.equal(value.calls(), 2, 'duplicate result and normal next boundary do not replay integration or poll again');
  assert.equal(value.completions(), 2);
});

test('native background checkpoint completion refreshes the same execution before fresh admission', async (t) => {
  const value = await checkpointGuardFixture(t);
  const background = exec('bash', { ...value.checkpoint.arguments, timeoutMs: 1000, run_in_background: true }, value.agent);
  assert.equal((await value.handlers.get('tools/pre-execute')(background, async () => ({ kind: 'allow' }))).kind, 'allow');
  await value.handlers.get('tools/result')(background, ok('started background job bash-3'));
  assert.equal(value.calls(), 1);
  value.setContext(value.nextContext);
  await value.handlers.get('tools/result')(exec('job_output', { job_id: 'bash-3' }, value.agent),
    ok(JSON.stringify(value.result) + '\n[status: completed, exit code: 0]'));
  assert.equal(value.calls(), 2);
  const state = value.controller.states.get(value.agent);
  assert.equal(state.executionIdentity.executionId, value.context.executionId);
  assert.equal(state.executionContextGeneration, value.context.generation);
  assert.equal(state.executionRpcId, value.context.rpcId);
  assert.equal(state.executionSourceCommit, value.nextContext.sourceCommit);
  assert.equal(state.verificationAdmission, undefined);
  await value.step(2);
  assert.equal(value.admissions(), 2);
  assert.equal(state.verificationAdmission.receipt.source.head, value.nextContext.sourceCommit);
});

test('native background integrate completion refreshes the same RPC before fresh admission', async (t) => {
  let release;
  let resolving;
  const entered = new Promise((resolve) => { resolving = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const value = await checkpointGuardFixture(t, { integrated: true, resolveBarrier: async (calls) => {
    if (calls > 1) { resolving(); await barrier; }
  } });
  const background = exec('bash', { ...value.checkpoint.arguments, command: value.checkpoint.arguments.command,
    timeoutMs: 1000, run_in_background: true }, value.agent);
  assert.equal((await value.handlers.get('tools/pre-execute')(background, async () => ({ kind: 'allow' }))).kind, 'allow');
  await value.handlers.get('tools/result')(background, ok('started background job bash-3'));
  assert.equal(value.calls(), 1, 'the native acknowledgement is not completed integration');
  const output = exec('job_output', { job_id: 'bash-3' }, value.agent);
  const completed = ok(JSON.stringify(value.result) + '\n[status: completed, exit code: 0]');
  value.setContext(value.nextContext);
  const observed = value.handlers.get('tools/result')(output, completed);
  // The observer must actually begin renewal before waiting for its async resolver.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.calls(), 2);
  await entered;
  const next = value.step(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.admissions(), 1, 'the next step cannot publish old-source admission while renewal is pending');
  release();
  await Promise.all([observed, next]);
  const state = value.controller.states.get(value.agent);
  assert.equal(state.executionRpcId, value.context.rpcId);
  assert.equal(state.executionIdentity.executionId, value.nextContext.executionId);
  assert.equal(state.executionContextGeneration, value.context.generation + 1);
  assert.equal(state.verificationAdmission.receipt.source.head, value.nextContext.sourceCommit);
  assert.equal(state.verificationAdmission.receipt.source.workspaceFingerprint, value.nextContext.workspaceFingerprint);
  await value.handlers.get('tools/result')(output, completed);
  assert.equal(value.calls(), 2, 'a repeated job output cannot renew again');
});

test('review-base-only integration refreshes Host admission in the same protected turn', async (t) => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const value = await checkpointGuardFixture(t, { resolveBarrier: async (calls) => {
    if (calls > 1) await barrier;
  } });
  const canonical = 'b'.repeat(40);
  const command = `forge-release integrate --mode start --expected-head ${value.context.sourceCommit} --expected-fingerprint ${value.context.workspaceFingerprint} --canonical-head ${canonical}`;
  const call = exec('bash', { command, run_in_background: true }, value.agent);
  await value.handlers.get('tools/result')(call, ok('started background job bash-3'));
  const output = exec('job_output', { job_id: 'bash-3' }, value.agent);
  const result = ok(JSON.stringify({ ok: true, result: {
    operation: 'integrate', status: 'integrated', operationId: 'review-base-operation',
    head: value.context.sourceCommit, workspaceFingerprint: value.context.workspaceFingerprint,
    canonicalHead: canonical, workspaceClean: true, sourceTransition: null,
    reviewBaseTransition: { from: 'f'.repeat(40), to: canonical, appliedAt: new Date().toISOString() },
  } }) + '\n[status: completed, exit code: 0]');
  const observed = value.handlers.get('tools/result')(output, result);
  await new Promise((resolve) => setImmediate(resolve));
  const next = value.step(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(value.admissions(), 1, 'the next step waits for the trusted refresh');
  release();
  await Promise.all([observed, next]);
  const state = value.controller.states.get(value.agent);
  assert.equal(value.calls(), 2);
  assert.equal(value.admissions(), 2, 'comparison-base change replaces the Host lease');
  assert.equal(state.executionSourceCommit, value.context.sourceCommit);
  assert.equal(state.executionWorkspaceFingerprint, value.context.workspaceFingerprint);
  assert.equal(state.executionIdentity.executionId, value.context.executionId);
  assert.equal(state.executionContextGeneration, value.context.generation);
  assert.equal(state.executionRpcId, value.context.rpcId);
  assert.equal(state.taskContract.contractId, value.context.contractId);
  await value.handlers.get('tools/result')(output, result);
  await value.step(3);
  assert.equal(value.calls(), 2, 're-reading the completed job must not repeat refresh');
  assert.equal(value.admissions(), 2);
});

test('review-base refresh rejects unrelated failed or changed-source integration results', async (t) => {
  const value = await checkpointGuardFixture(t);
  const canonical = 'b'.repeat(40);
  const call = exec('bash', { command: `forge-release integrate --mode start --expected-head ${value.context.sourceCommit} --expected-fingerprint ${value.context.workspaceFingerprint} --canonical-head ${canonical}` }, value.agent);
  const body = { operation: 'integrate', status: 'integrated', operationId: 'review-base-operation',
    head: value.context.sourceCommit, workspaceFingerprint: value.context.workspaceFingerprint,
    canonicalHead: canonical, workspaceClean: true, sourceTransition: null,
    reviewBaseTransition: { from: 'f'.repeat(40), to: canonical, appliedAt: new Date().toISOString() } };
  for (const changed of [
    { head: 'e'.repeat(40) }, { workspaceFingerprint: 'e'.repeat(64) },
    { canonicalHead: 'e'.repeat(40) }, { workspaceClean: false }, { status: 'conflict-open' },
    { reviewBaseTransition: null }, { sourceTransition: undefined },
    { reviewBaseTransition: { ...body.reviewBaseTransition, to: 'e'.repeat(40) } },
    { reviewBaseTransition: { ...body.reviewBaseTransition, from: canonical } },
    { reviewBaseTransition: { ...body.reviewBaseTransition, appliedAt: 'invalid' } },
  ]) await value.handlers.get('tools/result')(call, ok(JSON.stringify({ ok: true, result: { ...body, ...changed } })));
  await value.handlers.get('tools/result')(call, failed(JSON.stringify({ ok: true, result: body })));
  await value.handlers.get('tools/result')(exec('bash', { command: 'echo integrated' }, value.agent), ok(JSON.stringify({ ok: true, result: body })));
  assert.equal(value.calls(), 1);
  assert.equal(value.admissions(), 1);
  await value.handlers.get('tools/result')(call, ok(JSON.stringify({ ok: true, result: body })));
  await value.step(2);
  assert.equal(value.calls(), 2);
  assert.equal(value.admissions(), 2);
});

test('native integrate output requires its own successful launch and completed matching job', async (t) => {
  const value = await checkpointGuardFixture(t, { integrated: true });
  value.setContext(value.nextContext);
  const command = value.checkpoint.arguments.command;
  const background = exec('bash', { command, run_in_background: true }, value.agent);
  const output = exec('job_output', { job_id: 'bash-3' }, value.agent);
  const json = JSON.stringify(value.result);
  const completed = ok(json + '\n[status: completed, exit code: 0]');
  await value.handlers.get('tools/result')(output, completed);
  for (const [call, result] of [
    [exec('bash', { command }, value.agent), ok('started background job bash-3')],
    [background, failed('started background job bash-3')],
    [exec('bash', { command: 'echo integrated', run_in_background: true }, value.agent), ok('started background job bash-3')],
  ]) {
    await value.handlers.get('tools/result')(call, result);
    await value.handlers.get('tools/result')(output, completed);
    assert.equal(value.calls(), 1);
  }
  assert.equal((await value.handlers.get('tools/pre-execute')(background, async () => ({ kind: 'allow' }))).kind, 'allow');
  await value.handlers.get('tools/result')(background, ok('started background job bash-3'));
  for (const [call, result] of [
    [exec('job_output', { job_id: 'bash-4' }, value.agent), completed],
    [output, ok(json)],
    [output, ok(json + '\n[status: running]')],
    [output, ok(json + '\n[status: completed, exit code: 1]')],
    [output, failed(json + '\n[status: completed, exit code: 0]')],
    [output, ok(JSON.stringify({ ...value.result, result: { ...value.result.result, workspaceClean: false } }) + '\n[status: completed, exit code: 0]')],
  ]) {
    await value.handlers.get('tools/result')(call, result);
    assert.equal(value.calls(), 1);
    assert.equal(value.controller.states.get(value.agent).executionSourceCommit, base);
  }
  await value.handlers.get('tools/result')(output, completed);
  assert.equal(value.calls(), 2);
});

test('edited start integration refreshes the same RPC from its Host-bound candidate', async (t) => {
  const value = await checkpointGuardFixture(t, { integrated: true, edited: true });
  const state = value.controller.states.get(value.agent);
  assert.notEqual(state.executionWorkspaceFingerprint, value.result.result.sourceTransition.from.fingerprint);
  assert.equal((await value.handlers.get('tools/pre-execute')(value.checkpoint, async () => ({ kind: 'allow' }))).kind, 'allow');
  value.setContext(value.nextContext);
  await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result)));
  assert.equal(value.calls(), 2);
  await value.step(2);
  const next = value.controller.states.get(value.agent);
  assert.equal(next.executionRpcId, value.context.rpcId);
  assert.equal(next.executionSourceCommit, value.nextContext.sourceCommit);
  assert.equal(next.verificationAdmission.receipt.source.workspaceFingerprint, value.nextContext.workspaceFingerprint);
});

test('direct edited integration advances authority without a Host binding and retains source identity checks', async (t) => {
  const value = await checkpointGuardFixture(t, { integrated: true, edited: true, direct: true });
  const before = value.controller.states.get(value.agent);
  assert.equal(before.verificationAdmission, undefined);
  assert.notEqual(before.executionWorkspaceFingerprint, value.result.result.sourceTransition.from.fingerprint);
  value.result.result.savedSourceCommit = 'a'.repeat(40);
  assert.equal((await value.handlers.get('tools/pre-execute')(value.checkpoint, async () => ({ kind: 'allow' }))).kind, 'allow');
  value.setContext(value.nextContext);
  for (const mutate of [
    r => { r.result.sourceTransition.from.head = 'f'.repeat(40); },
    r => { r.result.sourceTransition.from.fingerprint = 'a'.repeat(64); },
    r => { r.result.sourceTransition.sourceAuthority.executionId = '123e4567-e89b-42d3-a456-426614174999'; },
    r => { r.result.sourceTransition.sourceAuthority.generation += 1; },
    r => { r.result.sourceTransition.sourceAuthority.actionCeiling = 'git-checkpoint'; },
    r => { r.result.sourceTransition.task.actorUserId = '123e4567-e89b-42d3-a456-426614174999'; },
    r => { r.result.workspaceClean = false; },
  ]) {
    const changed = structuredClone(value.result);
    mutate(changed);
    changed.result.sourceTransition.digest = sourceTransitionCanonicalDigest(changed.result.sourceTransition);
    await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(changed)));
    assert.equal(value.calls(), 1);
  }
  await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result)));
  assert.equal(value.calls(), 2);
  const next = value.controller.states.get(value.agent);
  assert.equal(next.executionContextGeneration, value.context.generation + 1);
  assert.equal(next.executionRpcId, value.context.rpcId);
  assert.equal(next.executionSourceCommit, value.nextContext.sourceCommit);
  assert.equal(next.executionWorkspaceFingerprint, value.nextContext.workspaceFingerprint);
  assert.equal(next.verificationAdmission, undefined, 'renewal must not create optional Host verification');
  assert.equal(toolDenialReason(next, exec('bash', { command: 'forge-release release --services forge-admin' }, value.agent)), undefined);
});

test('edited integration without Host binding stays denied outside direct mode', async (t) => {
  const value = await checkpointGuardFixture(t, { integrated: true, edited: true });
  value.controller.states.get(value.agent).verificationAdmission = undefined;
  value.setContext(value.nextContext);
  await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result)));
  assert.equal(value.calls(), 1);
  assert.equal(value.controller.states.get(value.agent).executionSourceCommit, base);
});

test('integrate refresh requires the exact successful clean source transition and authority', async (t) => {
  const value = await checkpointGuardFixture(t, { integrated: true });
  value.setContext(value.nextContext);
  const rejected = [
    [value.checkpoint, failed(JSON.stringify(value.result))],
    [exec('bash', { command: 'echo integrated' }, value.agent), ok(JSON.stringify(value.result))],
  ];
  for (const change of [
    (r) => { r.ok = false; },
    (r) => { r.result.status = 'conflict-open'; },
    (r) => { r.result.workspaceClean = false; },
    (r) => { r.result.head = base; },
    (r) => { r.result.workspaceFingerprint = 'f'.repeat(64); },
    (r) => { r.result.canonicalHead = 'f'.repeat(40); },
    (r) => { r.result.operationId = '123e4567-e89b-42d3-a456-426614174999'; },
    (r) => { r.result.sourceTransition.from.head = 'f'.repeat(40); },
    (r) => { r.result.sourceTransition.from.fingerprint = 'f'.repeat(64); },
    (r) => { r.result.sourceTransition.task.taskId = 'task-two'; },
    (r) => { r.result.sourceTransition.task.actorUserId = '123e4567-e89b-42d3-a456-426614174999'; },
    (r) => { r.result.sourceTransition.sourceAuthority.executionId = '123e4567-e89b-42d3-a456-426614174999'; },
    (r) => { r.result.sourceTransition.sourceAuthority.generation += 1; },
    (r) => { r.result.sourceTransition.sourceAuthority.contractId = 'f'.repeat(64); },
    (r) => { r.result.sourceTransition.sourceAuthority.actionCeiling = 'git-checkpoint'; },
    (r) => { r.result.sourceTransition.sourceAuthority.productionAuthorityDigest = 'f'.repeat(64); },
    (r) => { r.result.sourceTransition.sourceAuthority.controllerGrantDigest = 'f'.repeat(64); },
  ]) {
    const response = structuredClone(value.result);
    change(response);
    response.result.sourceTransition.digest = sourceTransitionCanonicalDigest(response.result.sourceTransition);
    rejected.push([value.checkpoint, ok(JSON.stringify(response))]);
  }
  for (const [call, result] of rejected) await value.handlers.get('tools/result')(call, result);
  assert.equal(value.calls(), 1);
  assert.equal(value.controller.states.get(value.agent).executionSourceCommit, base);
});

test('integrate refresh rejects another RPC or source and requires a newly advanced execution', async (t) => {
  for (const change of [
    (c, original) => { c.executionId = original.executionId; },
    (c, original) => { c.generation = original.generation; },
    (c) => { c.generation += 1; },
    (c) => { c.rpcId = 'different-rpc'; },
    (c) => { c.textDigest = 'f'.repeat(64); c.promptDigest = c.textDigest; },
    (c) => { c.actorUserId = '123e4567-e89b-42d3-a456-426614174999'; },
    (c) => { c.sourceCommit = 'f'.repeat(40); },
    (c) => { c.workspaceFingerprint = 'f'.repeat(64); },
  ]) {
    const value = await checkpointGuardFixture(t, { integrated: true });
    const changed = structuredClone(value.nextContext);
    change(changed, value.context);
    changed.productionAuthorityDigest = digestProductionTaskAuthorityBinding(changed);
    value.setContext(changed);
    await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result)));
    const state = value.controller.states.get(value.agent);
    assert.equal(value.calls(), 2);
    assert.equal(state.executionIdentity.executionId, value.context.executionId);
    assert.equal(state.executionSourceCommit, base);
    assert.equal(state.executionContextStatus, 'unavailable');
    assert.equal(state.verificationAdmission, undefined);
  }
});

test('integrate refresh resumes a transient failure only at the next existing boundary', async (t) => {
  const value = await checkpointGuardFixture(t, { integrated: true });
  value.setContext(Object.assign(new Error('authority temporarily unavailable'), { statusCode: 503 }));
  await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result)));
  const oldState = value.controller.states.get(value.agent);
  assert.equal(value.calls(), 2);
  assert.equal(oldState.executionContextStatus, 'unavailable');
  assert.equal(oldState.verificationAdmission, undefined);
  assert.match(toolDenialReason(oldState, exec('bash', { command: 'forge-release release --services forge-admin' }, value.agent)), /validated ready production-task-writer/u);
  value.setContext(value.nextContext);
  await value.step(2);
  const state = value.controller.states.get(value.agent);
  assert.equal(value.calls(), 3);
  assert.notEqual(state, oldState);
  assert.equal(state.executionContextGeneration, value.context.generation + 1);
  assert.equal(state.executionSourceCommit, value.nextContext.sourceCommit);
  assert.equal(state.verificationProfileReceipts.size, 0);
  assert.equal(value.admissions(), 2);
  assert.equal(value.completions(), 2);
  await value.step(3);
  assert.equal(value.calls(), 3);
});

test('checkpoint refresh ignores failed results, ordinary text and other commands', async (t) => {
  const value = await checkpointGuardFixture(t);
  value.setContext(value.nextContext);
  for (const [call, result] of [
    [value.checkpoint, failed(JSON.stringify(value.result))],
    [value.checkpoint, ok('checkpointed successfully')],
    [exec('bash', { command: 'echo checkpoint' }, value.agent), ok(JSON.stringify(value.result))],
    [exec('bash', { command: 'forge-release release --services forge-admin' }, value.agent), ok(JSON.stringify(value.result))],
    [value.checkpoint, ok(JSON.stringify({ ...value.result, ok: false }))],
    [value.checkpoint, ok(JSON.stringify({ ok: true, result: { ...value.result.result, status: 'running' } }))],
  ]) await value.handlers.get('tools/result')(call, result);
  assert.equal(value.calls(), 1);
  assert.equal(value.controller.states.get(value.agent).executionSourceCommit, base);
});

test('checkpoint refresh cannot replace the current RPC with another protected request', async (t) => {
  const value = await checkpointGuardFixture(t);
  const changed = { ...value.nextContext, rpcId: 'different-rpc' };
  changed.productionAuthorityDigest = digestProductionTaskAuthorityBinding(changed);
  value.setContext(changed);
  await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result)));
  assert.equal(value.calls(), 2);
  const state = value.controller.states.get(value.agent);
  assert.equal(state.executionRpcId, value.context.rpcId);
  assert.equal(state.executionSourceCommit, base);
});

test('checkpoint refresh resumes a transient failure at the next existing step without replaying the commit', async (t) => {
  const value = await checkpointGuardFixture(t);
  value.setContext(Object.assign(new Error('authority temporarily unavailable'), { statusCode: 503 }));
  await value.handlers.get('tools/result')(value.checkpoint, ok(JSON.stringify(value.result)));
  const state = value.controller.states.get(value.agent);
  assert.equal(value.calls(), 2);
  assert.equal(state.pendingSourceTransition.digest, value.result.result.sourceTransition.digest);
  assert.equal(state.executionContextStatus, 'unavailable');
  assert.equal(state.verificationAdmission, undefined);
  assert.equal(state.completionGateDigest, undefined);
  assert.match(toolDenialReason(state, exec('bash', { command: 'forge-release release --services forge-admin' }, value.agent)),
    /validated ready production-task-writer/u);
  const sequence = state.sequence;
  value.setContext(value.nextContext);
  await value.step(2);
  assert.equal(value.calls(), 3);
  assert.equal(state.pendingSourceTransition, undefined);
  assert.equal(state.executionContextStatus, 'ready');
  assert.equal(state.executionSourceCommit, value.nextContext.sourceCommit);
  assert.equal(state.sequence, sequence, 'no checkpoint or verification result was replayed');
  assert.equal(value.admissions(), 2);
  assert.equal(value.completions(), 2);
});

test('direct production continuation observes current missing proof once and adds only a bound transient notice fact', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-phase-current-proof-'));
  try {
    const prompt = '继续执行事故调查页面修复并完成当前合同验证。';
    const content = [{ type: 'text', text: prompt }];
    const actorUserId = '123e4567-e89b-42d3-a456-426614174000';
    const metadata = {
      schemaVersion: 2,
      projectSlug: 'forge-project',
      taskId: 'task-one',
      actorId: 'alice',
      actorUserId,
      conversationId: 'conversation:current-proof:001',
      accessMode: 'conversation',
      status: 'active',
    };
    const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
      type: 'client-request',
      rpcId: '123e4567-e89b-42d3-a456-426614174111',
      method: 'session.prompt',
      payload: { sessionId: 'session-one', mode: 'queue', content },
    })), 'session.prompt');
    const request = {
      ...classified,
      requestId: 'request-current-proof',
      actorUserId,
      actorUsername: 'alice',
      conversationId: metadata.conversationId,
    };
    const taskAuthority = {
      actionCeiling: 'workspace-write',
      ownedPaths: ['forge-admin-ui/src/views/accident'],
      taskProfiles: ['frontend-admin'],
    };
    const contract = compileForgeTaskExecutionContract({ prompt, ...taskAuthority });
    const productionAuthorityId = '123e4567-e89b-42d3-a456-426614174226';
    const controllerGrantDigest = '3'.repeat(64);
    const sourceFingerprint = 'c'.repeat(64);
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
        conversationId: metadata.conversationId,
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
      projectRoot: root,
      projectSlug: metadata.projectSlug,
      taskMetadata: metadata,
      request,
      policyPath: path.resolve('docker/harness/forge-execution-policy.json'),
      trustedPolicyInput,
    });
    const { idempotent: _idempotent, refreshed: _refreshed, ...context } = prepared;
    const currentProjection = blockedCurrentContractProjection(contract.contractId, sourceFingerprint);

    const activate = async (resolver) => {
      const handlers = new Map();
      let completionCalls = 0;
      const controller = installPhaseBudgetGuard({
        on(name, handler) { handlers.set(name, handler); },
        tools: { guard() { return () => {}; } },
      }, (input) => ({ role: 'user', ...input }), {
        resolveExecutionContext: async () => structuredClone(context),
        admitExecution: async (profiles) => hostAdmissionReceipt(profiles),
        resolveProtectedCompletion: async (input) => {
          completionCalls += 1;
          return resolver(input);
        },
      });
      const agent = { session: { events: [] }, steer() {}, cancel() {} };
      const preStep = (step, messages) => handlers.get('agent/pre-step')(
        { agent, turn: 1, step, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages }),
      );
      const entered = await preStep(1, [{ role: 'user', source: { kind: 'user' }, content }]);
      const notice = entered.messages.flatMap((message) => message.content ?? [])
        .map((block) => block.text ?? '').join('\n');
      return { agent, controller, preStep, notice, completionCalls: () => completionCalls };
    };

    const valid = await activate(async () => structuredClone(currentProjection));
    assert.equal(valid.completionCalls(), 1);
    assert.match(valid.notice, /Current protected completion projection/u);
    assert.ok(valid.notice.includes(`contractId ${contract.contractId}`));
    assert.ok(valid.notice.includes(`sourceFingerprint sha256:${sourceFingerprint}`));
    assert.ok(valid.notice.includes(currentProjection.evaluatedAt));
    assert.match(valid.notice, /14 open\/0 closed\/0 stale/u);
    assert.match(valid.notice, /supported receipt revalidation path/u);
    assert.ok(valid.notice.includes(`current admission ID ${admissionId}`));
    assert.ok(valid.notice.includes(contract.requiredVerificationProfiles.join(', ')));
    const proofFact = valid.notice.slice(valid.notice.indexOf('Current protected completion projection'));
    assert.equal(proofFact.includes('frontend-red-test'), false,
      'the proof repair list comes from requiredVerificationProfiles, not admission profiles');
    assert.match(valid.notice, /Backend compilation, module tests and focused diagnostics, full-regression, frontend-admin-build and unfiltered frontend-admin-test default to Host background submission/u);
    assert.doesNotMatch(valid.notice, /--wait-seconds 60|bash timeoutMs=600000/u);
    assert.match(valid.notice, /run only missing or invalid required profiles/u);
    assert.match(valid.notice, /For authorized final contract closeout/u);
    assert.match(valid.notice, /do not expand an explicitly bounded candidate or diagnostic request/u);
    assert.match(valid.notice, /Do not edit code solely to refresh proof/u);
    assert.match(valid.notice, /do not treat unrelated UAT as a current code-contract prerequisite/u);

    const validState = valid.controller.states.get(valid.agent);
    validState.lastReminderKey = '';
    const continuation = await valid.preStep(2, []);
    const continuationNotice = continuation.messages.flatMap((message) => message.content ?? [])
      .map((block) => block.text ?? '').join('\n');
    assert.equal(valid.completionCalls(), 1, 'ordinary continuation steps do not poll completion');
    assert.equal(continuationNotice.includes('Current protected completion projection'), false,
      'the projection fact is not persisted or reused by a later notice');


    const readyLedgerPayload = {
      ...currentProjection.ledgerSummary,
      counts: { total: 14, open: 0, closed: 14, stale: 0 },
      open: [], closed: currentProjection.ledgerSummary.open,
    };
    delete readyLedgerPayload.summaryDigest;
    const readyLedger = { ...readyLedgerPayload, summaryDigest: canonicalSha256(readyLedgerPayload) };
    const readyProjection = resignProtectedProjection({
      ...currentProjection,
      ledgerSummary: readyLedger, ledgerSummaryDigest: readyLedger.summaryDigest,
      outcome: 'READY', maximumTerminalOutcome: 'COMPLETE', signedVerdictVerified: true,
      blockers: [], cannotClaim: [],
    });
    let observedProjection = currentProjection;
    const refreshed = await activate(async () => structuredClone(observedProjection));
    const refreshedState = refreshed.controller.states.get(refreshed.agent);
    observedProjection = readyProjection;
    observeToolResult(refreshedState, exec('bash', { command: 'npm test' }), ok('tests passed'));
    const readyStep = await refreshed.preStep(2, []);
    const readyNotice = readyStep.messages.flatMap((message) => message.content ?? [])
      .map((block) => block.text ?? '').join('\n');
    assert.equal(refreshed.completionCalls(), 2, 'verification results refresh the protected observation');
    assert.match(readyNotice, /is READY/u);
    assert.match(readyNotice, /supersedes earlier.*BOUNDED_BLOCKED/u);
    assert.match(readyNotice, /not a new verification run or a release/u);
    await refreshed.preStep(3, []);
    assert.equal(refreshed.completionCalls(), 2, 'unchanged evidence does not poll the Broker');
    for (const staleReady of [
      { ...readyProjection, gateDigest: 'bad-digest' },
      resignProtectedProjection({ ...readyProjection, signedVerdictVerified: false }),
      resignProtectedProjection({ ...readyProjection, sourceFingerprint: 'sha256:' + '0'.repeat(64) }),
      resignProtectedProjection({ ...readyProjection,
        ledgerSummary: { ...readyLedger, taskContractId: 'old-contract' } }),
    ]) {
      observedProjection = staleReady;
      observeToolResult(refreshedState, exec('bash', { command: 'npm test' }), ok('READY'));
      const rejected = await refreshed.preStep(4, []);
      assert.equal(rejected.messages.some((message) => (message.content ?? [])
        .some((block) => block.text?.includes('is READY'))), false,
      'tool text or a stale projection cannot grant current readiness');
    }

    const invalidProjections = [
      null,
      resignProtectedProjection({ ...currentProjection, blockers: null }),
      resignProtectedProjection({ ...currentProjection, blockers: {} }),
      resignProtectedProjection({ ...currentProjection, blockers: 'INDEPENDENT_VERDICT_REQUIRED' }),
      { ...currentProjection, gateDigest: `sha256:${'0'.repeat(64)}` },
      resignProtectedProjection({ ...currentProjection, sourceFingerprint: `sha256:${'0'.repeat(64)}` }),
      resignProtectedProjection({
        ...currentProjection,
        ledgerSummary: { ...currentProjection.ledgerSummary, taskContractId: 'old-contract' },
      }),
    ];
    for (const projection of invalidProjections) {
      const invalid = await activate(async () => projection);
      assert.equal(invalid.completionCalls(), 1);
      assert.equal(invalid.notice.includes('Current protected completion projection'), false);
    }
    const failed = await activate(async () => { throw new Error('protected completion unavailable'); });
    assert.equal(failed.completionCalls(), 1);
    assert.equal(failed.notice.includes('Current protected completion projection'), false);

    for (const contextChange of [
      { authorityClass: 'production-read-only' },
      { authorityClass: 'test-shadow-writer', testOnly: true },
      {
        authorityClass: 'test-shadow-writer', testOnly: true,
        workflowId: 'crud-production', phaseId: 'database', phaseIndex: 0,
        phaseCatalogVersion: 'test', phaseCatalogDigest: '1'.repeat(64),
      },
    ]) {
      const handlers = new Map();
      let calls = 0;
      installPhaseBudgetGuard({
        on(name, handler) { handlers.set(name, handler); },
        tools: { guard() { return () => {}; } },
      }, (input) => ({ role: 'user', ...input }), {
        resolveExecutionContext: async () => ({ ...context, ...contextChange, schemaVersion: 0 }),
        admitExecution: async (profiles) => hostAdmissionReceipt(profiles),
        resolveProtectedCompletion: async () => { calls += 1; return currentProjection; },
      });
      const agent = { session: { events: [] }, steer() {}, cancel() {} };
      const entered = await handlers.get('agent/pre-step')(
        { agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content }] }),
      );
      assert.equal(calls, 0);
      const notice = entered.messages.flatMap((message) => message.content ?? [])
        .map((block) => block.text ?? '').join('\n');
      assert.equal(notice.includes('Current protected completion projection'), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime admits the exact protected contract and never expands it from a model mutation path', async () => {
  const handlers = new Map();
  const admittedProfiles = [];
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  };
  const controller = installPhaseBudgetGuard(
    ctx,
    (input) => ({ id: `plugin-${Math.random()}`, role: 'user', ...input }),
    {
      maxSteps: 40,
      admitExecution: async (profiles) => {
        admittedProfiles.push([...profiles]);
        return JSON.parse(admissionReceipt(profiles));
      },
      resolveExecutionContext: async () => ({
        taskId: 'task-one',
        executionId: 'execution-protected-contract',
        generation: 0,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        contract: compileForgeTaskExecutionContract({
          prompt: '修复后端分页',
          ownedPaths: ['forge-server/example'],
          actionCeiling: 'workspace-write',
        }),
      }),
    },
  );
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  const directPrompt = {
    id: 'prompt-exact-contract',
    role: 'user',
    content: [{ type: 'text', text: '修复后端分页' }],
    source: { kind: 'user' },
  };
  await handlers.get('agent/pre-step')(
    { agent, turn: 14, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [directPrompt] }),
  );
  assert.deepEqual(admittedProfiles, [['backend-red-test', 'backend-module-test']]);
  const protectedState = controller.states.get(agent);
  for (const skill of protectedState.taskContract.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
    handlers.get('tools/result')({ ...exec('skill', { name: skill }, agent), callId: `protected-${skill}` }, ok());
  }

  const frontendMutation = exec('write', { path: 'forge-admin-ui/src/views/order/index.vue' }, agent);
  const decision = await handlers.get('tools/pre-execute')(frontendMutation, async () => ({ kind: 'allow' }));
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /outside the protected contract/u);
  assert.equal(admittedProfiles.length, 1, 'a model-proposed path must not expand protected profiles');
  assert.deepEqual(controller.states.get(agent).verificationAdmission.profiles, ['backend-red-test', 'backend-module-test']);
});

test('business read-only role descriptions preserve writer scope without raising genuine read-only ceilings', async () => {
  const roleDescription = '只读角色在此不出现任何可提交的编辑入口"';
  for (const { text, actionCeiling, promptReadOnly, denied } of [
    { text: `继续修改后端分页。${roleDescription}`, actionCeiling: 'workspace-write', promptReadOnly: false, denied: false },
    { text: `只读分析后端分页。${roleDescription}`, actionCeiling: 'workspace-write', promptReadOnly: true, denied: true },
    { text: `继续修改后端分页。${roleDescription}`, actionCeiling: 'read-only', promptReadOnly: false, denied: true },
  ]) {
    const handlers = new Map();
    const controller = installPhaseBudgetGuard({
      on(name, handler) { handlers.set(name, handler); },
      tools: { guard() { return () => {}; } },
    }, (input) => ({ role: 'user', ...input }), {
      maxSteps: 40,
      admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
      resolveExecutionContext: async () => ({
        taskId: 'task-role-description',
        executionId: 'execution-role-description',
        generation: 0,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        contract: compileForgeTaskExecutionContract({
          prompt: '修复后端分页',
          ownedPaths: ['forge-server/example'],
          actionCeiling,
        }),
      }),
    });
    const agent = { session: { events: [] }, steer() {}, cancel() {} };
    await handlers.get('agent/pre-step')(
      { agent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [{
        role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
      }] }),
    );
    const state = controller.states.get(agent);
    assert.equal(state.promptReadOnlyConstraint, promptReadOnly, text);
    assert.equal(state.actionCeiling, actionCeiling, 'prompt classification must not raise the protected ceiling');
    for (const skill of state.taskContract.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
      handlers.get('tools/result')({ ...exec('skill', { name: skill }, agent), callId: `role-${skill}` }, ok());
    }
    const decision = await handlers.get('tools/pre-execute')(
      exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' }, agent),
      async () => ({ kind: 'allow' }),
    );
    assert.equal(decision.kind, denied ? 'deny' : 'allow', decision.reason);
    if (denied) assert.match(decision.reason, /constrains this execution to read-only/u);
  }
});

test('health field annotations allow ordinary preparation while explicit turn read-only remains denied', async () => {
  const original = await readFile(new URL('./fixtures/health-exposure-posts-implementation-prompt.txt', import.meta.url), 'utf8');
  for (const [text, restricted] of [[original, false], [`${original}\n本轮只读分析，不修改代码。`, true]]) {
    const handlers = new Map();
    const controller = installPhaseBudgetGuard({
      on(name, handler) { handlers.set(name, handler); },
      tools: { guard() { return () => {}; } },
    }, (input) => ({ role: 'user', ...input }), {
      admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
      resolveExecutionContext: async () => ({
        taskId: 'task-health-annotations', executionId: 'execution-health-annotations', generation: 0,
        authorityClass: 'production-read-only', testOnly: false,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        contract: compileForgeTaskExecutionContract({ prompt: '先准备当前受控任务', ownedPaths: [], actionCeiling: 'read-only' }),
      }),
    });
    const agent = { session: { events: [] }, steer() {}, cancel() {} };
    await handlers.get('agent/pre-step')({ agent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }] }));
    const state = controller.states.get(agent);
    assert.equal(state.promptReadOnlyConstraint, restricted);
    assert.equal(state.actionCeiling, 'read-only', 'allowing preparation does not grant a writer');
    // The resolver fixture above omits the full signed context schema; the
    // preparation hook receives this flag after the unchanged context validator.
    state.protectedExecutionContextValidated = true;
    const decision = await handlers.get('tools/pre-execute')(
      exec('prepare_task', { operation: 'propose' }, agent), async () => ({ kind: 'allow' }));
    assert.equal(decision.kind, restricted ? 'deny' : 'allow', decision.reason);
    if (restricted) assert.match(decision.reason, /direct user prompt explicitly requires read-only/u);
  }
});

test('natural-language write intent cannot elevate a turn without a protected execution context', async () => {
  const handlers = new Map();
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  };
  installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
    maxSteps: 40,
    admitExecution: async () => { throw new Error('admission must not run without protected context'); },
  });
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({
      kind: 'enter',
      messages: [{
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '直接修改后端代码并完成测试' }],
      }],
    }),
  );
  const denied = await handlers.get('tools/pre-execute')(
    exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' }, agent),
    async () => ({ kind: 'allow' }),
  );
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /protected Task Execution Contract/u);
  assert.match(
    toolDenialReason(undefined, { ...exec('mcp_read_catalog', {}, agent), sideEffectClass: 'read-only' }),
    /unclassified tool/u,
  );
  assert.match(
    toolDenialReason(undefined, exec('mcp_update_database', {}, agent)),
    /unclassified tool/u,
  );
  const promptConstrained = routedState();
  promptConstrained.promptReadOnlyConstraint = true;
  assert.match(
    toolDenialReason(promptConstrained, exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' })),
    /current prompt constrains this execution to read-only/u,
  );
});

test('native background output stays observable without granting write or verification authority', () => {
  const readOnly = routedState({ suspendHeuristicStops: true });
  readOnly.actionCeiling = 'read-only';
  readOnly.promptReadOnlyConstraint = true;
  const expired = routedState({ suspendHeuristicStops: true });
  expired.executionContextExpiresAt = new Date(0).toISOString();
  expired.verificationBlocked = true;
  for (const state of [undefined, readOnly, expired]) {
    for (const args of [{ job_id: 'bash-1' }, { job_id: 'bash-1', wait: true, timeout_ms: 120000 }]) {
      assert.equal(toolDenialReason(state, exec('job_output', args)), undefined);
    }
    assert.match(toolDenialReason(state, exec('job_kill', { job_id: 'bash-1' })), /unclassified tool/u);
  }
  const mutations = expired.mutationCount;
  const verificationAttempts = expired.verificationProfileAttempts.size;
  observeToolResult(expired, exec('job_output', { job_id: 'bash-1' }), ok('Tests passed. [status: completed]'));
  assert.equal(expired.mutationCount, mutations);
  assert.equal(expired.verificationProfileAttempts.size, verificationAttempts);
  assert.equal(expired.verificationBlocked, true);
  assert.match(toolDenialReason(expired, exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' })), /lease expired/u);
});

test('native session tools stay available without changing draft or acceptance authority', async () => {
  const handlers = new Map();
  const controller = installRuntimePhaseBudgetGuard({
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  }, (value) => value);
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  const state = controller.stateFor(agent, 1);
  state.verificationBlocked = true;
  for (const name of ['todo_write', 'ask_user_question', 'job_list', 'job_output']) {
    const call = exec(name, {}, agent);
    assert.equal(isMutationExecution(call), false);
    assert.equal(toolDenialReason(state, call), undefined);
    const denied = await handlers.get('tools/pre-execute')(call, async () => ({
      kind: 'deny', reason: 'native provider rejects another session',
    }));
    assert.equal(denied.kind, 'deny');
    observeToolResult(state, call, ok('completed, all checks passed'));
  }
  assert.equal(state.mutationCount, 0);
  assert.equal(state.verificationProfileReceipts.size, 0);
  assert.equal(state.verificationBlocked, true);
  assert.match(toolDenialReason(state, exec('job_kill', { job_id: 'bash-1' }, agent)), /unclassified/u);
  assert.match(toolDenialReason(state, exec('unknown_write', {}, agent)), /unclassified/u);
});

test('an unfinished draft may end its conversation turn without a forced verification loop', () => {
  const handlers = new Map();
  const steered = [];
  const cancelled = [];
  const agent = { session: { events: [] }, steer(value) { steered.push(value); }, cancel(value) { cancelled.push(value); } };
  const controller = installRuntimePhaseBudgetGuard({
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  }, (value) => value);
  const state = controller.stateFor(agent, 1);
  authorizeWriterState(state);
  setReadyAdmission(state);
  observeToolResult(state, exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }, agent), ok());
  const missing = closeoutBlockers(state);
  assert.ok(missing.includes('final-governance-audit-missing'));
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    agent.session.events.push({ type: 'assistant/message', seq: sequence, data: { turn: 1,
      message: { id: `draft-${sequence}`, role: 'assistant', content: [{ type: 'text', text: '草稿已保存，验证尚未完成。' }] } } });
    handlers.get('agent/turn-stopping')({ agent, turn: 1 });
  }
  assert.deepEqual(steered, []);
  assert.deepEqual(cancelled, []);
  assert.deepEqual(closeoutBlockers(state), missing, 'ending a turn must not satisfy release requirements');
});

test('native background output still delegates to downstream tool authorization', async () => {
  const handlers = new Map();
  installRuntimePhaseBudgetGuard({
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  }, (value) => value);
  const denied = { kind: 'deny', reason: 'job belongs to another session' };
  let delegated = 0;
  const result = await handlers.get('tools/pre-execute')(
    exec('job_output', { job_id: 'bash-1' }, { session: { events: [] } }),
    async () => { delegated += 1; return denied; },
  );
  assert.equal(delegated, 1);
  assert.deepEqual(result, denied);
});

test('copy_file uses existing destination authority, admission, reservation and mutation accounting', async () => {
  const handlers = new Map();
  const controller = installPhaseBudgetGuard({
    on(name, handler) { handlers.set(name, handler); }, tools: { guard() { return () => {}; } },
  }, (input) => ({ role: 'user', ...input }), {
    maxSteps: 40, admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
  });
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  const state = authorizeWriterState(controller.stateFor(agent, 1), {
    prompt: '恢复现有后端测试源码', ownedPaths: ['forge-server/example'],
  });
  setReadyAdmission(state);
  for (const skill of state.taskContract.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
    await handlers.get('tools/result')({ ...exec('skill', { name: skill }, agent), callId: `copy-skill-${skill}` }, ok());
  }
  const args = { file_path: 'forge-server/example/src/test/java/ExistingTest.java',
    source_path: '/project-inputs/incoming/batch/original.txt', source_sha256: 'a'.repeat(64) };
  const copy = { ...exec('copy_file', args, agent), callId: 'copy-original-test' };
  assert.equal(isMutationExecution(copy), true);
  assert.equal(toolDenialReason(state, copy), undefined);
  assert.equal((await handlers.get('tools/pre-execute')(copy, async () => ({ kind: 'allow' }))).kind, 'allow');
  assert.equal(state.writerReservations.has(copy.callId), true);
  await handlers.get('tools/result')(copy, ok('copied exact reference bytes'));
  assert.equal(state.writerReservations.size, 0);
  assert.equal(state.mutationCount, 1);
  assert.equal(state.testMutationSequence, state.mutationSequence);
  assert.equal(state.ownedPaths.has(args.file_path), true);
  assert.equal((await handlers.get('tools/pre-execute')(copy, async () => ({ kind: 'allow' }))).kind, 'deny');
  const ro = routedState(); ro.actionCeiling = 'read-only';
  assert.match(toolDenialReason(ro, exec('copy_file', args)), /read-only/u);
  assert.match(toolDenialReason(routedState(), exec('copy_file', { ...args, file_path: 'forge-server/other/Test.java' })), /outside the protected contract/u);
  const stale = routedState(); stale.verificationAdmission.expiresAt = new Date(0).toISOString();
  assert.match(toolDenialReason(stale, exec('copy_file', args)), /current batch execution admission/u);
  assert.ok(toolDenialReason(routedState(), exec('copy_file', { ...args, content: 'extra payload' })));
});

test('remove_file uses the existing owned-path admission, reservation, and result-observation mutation path', async () => {
  const handlers = new Map();
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  };
  const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
    maxSteps: 40,
    admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
  });
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  const state = authorizeWriterState(controller.stateFor(agent, 1), {
    prompt: '删除已废弃的后端源文件',
    ownedPaths: ['forge-server/example'],
  });
  setReadyAdmission(state);
  for (const skill of state.taskContract.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
    await handlers.get('tools/result')(
      { ...exec('skill', { name: skill }, agent), callId: `remove-skill-${skill}` }, ok(),
    );
  }

  const removal = {
    ...exec('remove_file', {
      file_path: 'forge-server/example/src/test/java/ObsoleteTest.java',
    }, agent),
    callId: 'remove-obsolete-test',
  };
  assert.equal(isMutationExecution(removal), true);
  assert.equal(toolDenialReason(state, removal), undefined);
  const decision = await handlers.get('tools/pre-execute')(
    removal, async () => ({ kind: 'allow' }),
  );
  assert.equal(decision.kind, 'allow', decision.reason);
  assert.equal(state.writerReservations.has(removal.callId), true);
  await handlers.get('tools/result')(removal, ok('file removed'));
  assert.equal(state.writerReservations.size, 0);
  assert.equal(state.settledWriterCalls.has(removal.callId), true);
  assert.equal(state.mutationAttemptCount, 1);
  assert.equal(state.mutationCount, 1);
  assert.equal(state.testMutationSequence, state.mutationSequence);
  assert.equal(state.ownedPaths.has('forge-server/example/src/test/java/ObsoleteTest.java'), true);

  const productionRemoval = {
    ...exec('remove_file', {
      file_path: 'forge-server/example/src/main/java/Obsolete.java',
    }, agent),
    callId: 'remove-obsolete-source',
  };
  assert.equal(toolDenialReason(state, productionRemoval), undefined,
    'the existing test classification permits production mutation only after the test mutation');
  assert.equal((await handlers.get('tools/pre-execute')(
    productionRemoval, async () => ({ kind: 'allow' }),
  )).kind, 'allow');
  await handlers.get('tools/result')(productionRemoval, ok('source file removed'));
  assert.equal(state.mutationAttemptCount, 2);
  assert.equal(state.mutationCount, 2);
  assert.equal(state.productionMutationSequence, state.mutationSequence);
  assert.equal(state.ownedPaths.has('forge-server/example/src/main/java/Obsolete.java'), true);

  const replay = await handlers.get('tools/pre-execute')(
    productionRemoval, async () => ({ kind: 'allow' }),
  );
  assert.equal(replay.kind, 'deny');
  assert.match(replay.reason, /already settled/u);

  const readOnly = routedState();
  readOnly.actionCeiling = 'read-only';
  assert.match(toolDenialReason(readOnly, {
    ...removal, agent: undefined, callId: 'remove-read-only', rootCallId: 'remove-read-only',
  }), /read-only/u);

  const unowned = routedState();
  assert.match(toolDenialReason(unowned, {
    ...removal,
    arguments: { file_path: 'forge-server/other/src/main/java/Foreign.java' },
    agent: undefined,
    callId: 'remove-unowned',
    rootCallId: 'remove-unowned',
  }), /outside the protected contract/u);

  const staleAdmission = routedState();
  staleAdmission.verificationAdmission.expiresAt = new Date(0).toISOString();
  assert.match(toolDenialReason(staleAdmission, {
    ...removal, agent: undefined, callId: 'remove-stale-admission', rootCallId: 'remove-stale-admission',
  }), /current batch execution admission/u);

  const protectedManifest = routedState();
  assert.match(toolDenialReason(protectedManifest, {
    ...removal,
    arguments: { file_path: 'forge-server/example/pom.xml' },
    agent: undefined,
    callId: 'remove-dependency-manifest',
    rootCallId: 'remove-dependency-manifest',
  }), /candidate-cache admission/u);

  const wrongArguments = routedState();
  assert.match(toolDenialReason(wrongArguments, {
    ...removal,
    arguments: { path: 'forge-server/example/src/main/java/Obsolete.java' },
    agent: undefined,
    callId: 'remove-wrong-arguments',
    rootCallId: 'remove-wrong-arguments',
  }), /outside the protected contract/u);
});

test('writer reservations are atomic before downstream allow and block parallel audit-window overflow', async () => {
  const handlers = new Map();
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  };
  const contract = compileForgeTaskExecutionContract({
    prompt: '修复后端并先写回归测试',
    ownedPaths: ['forge-server/example'],
    actionCeiling: 'workspace-write',
  });
  const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
    maxSteps: 40,
    admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
    resolveExecutionContext: async () => ({
      taskId: 'task-one', executionId: 'execution-concurrent', generation: 0, contract,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  });
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修复后端' }] }] }),
  );
  const state = controller.states.get(agent);
  for (const skill of contract.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
    handlers.get('tools/result')({ ...exec('skill', { name: skill }, agent), callId: `skill-${skill}` }, ok());
  }
  state.mutationsSinceAudit = MAX_MUTATIONS_WITHOUT_AUDIT - 1;
  let releaseFirst;
  const first = { ...exec('write', { path: 'forge-server/example/src/test/java/FirstTest.java' }, agent), callId: 'writer-first' };
  const second = { ...exec('write', { path: 'forge-server/example/src/test/java/SecondTest.java' }, agent), callId: 'writer-second' };
  const firstDecision = handlers.get('tools/pre-execute')(
    first,
    async () => new Promise((resolve) => { releaseFirst = resolve; }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.writerReservations.has(first.callId), true, 'reservation must precede downstream allow');
  const replayDecision = await handlers.get('tools/pre-execute')(first, async () => ({ kind: 'allow' }));
  assert.equal(replayDecision.kind, 'deny');
  assert.match(replayDecision.reason, /already reserved/u);
  const secondDecision = await handlers.get('tools/pre-execute')(second, async () => ({ kind: 'allow' }));
  assert.equal(secondDecision.kind, 'deny');
  assert.match(secondDecision.reason, /governance audit/u);
  releaseFirst({ kind: 'allow' });
  assert.equal((await firstDecision).kind, 'allow');
  handlers.get('tools/result')(first, ok());
  assert.equal(state.writerReservations.size, 0);
  assert.equal(state.mutationCount, 1);
  const settledReplay = await handlers.get('tools/pre-execute')(first, async () => ({ kind: 'allow' }));
  assert.equal(settledReplay.kind, 'deny');
  assert.match(settledReplay.reason, /already settled/u);

  state.mutationsSinceAudit = 0;
  const downstreamDenied = { ...exec('write', { path: 'forge-server/example/src/test/java/DeniedTest.java' }, agent), callId: 'writer-downstream-denied' };
  assert.equal(
    (await handlers.get('tools/pre-execute')(downstreamDenied, async () => ({ kind: 'deny', reason: 'downstream policy' }))).kind,
    'deny',
  );
  assert.equal(state.writerReservations.has(downstreamDenied.callId), false, 'downstream denial releases reservation');
  const failedWriter = { ...downstreamDenied, callId: 'writer-failed-result' };
  assert.equal((await handlers.get('tools/pre-execute')(failedWriter, async () => ({ kind: 'allow' }))).kind, 'allow');
  handlers.get('tools/result')(failedWriter, failed('write failed'));
  assert.equal(state.writerReservations.has(failedWriter.callId), false, 'failed result releases reservation');
  assert.equal(state.mutationCount, 1, 'failed writer does not commit mutation budget');
});

test('a policy-denied production write cannot close the required test-first mutation path', async () => {
  const handlers = new Map();
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  };
  const contract = compileForgeTaskExecutionContract({
    prompt: '修复后端并先写回归测试',
    ownedPaths: ['forge-server/example'],
    actionCeiling: 'workspace-write',
  });
  const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
    maxSteps: 80,
    admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
    resolveExecutionContext: async () => ({
      taskId: 'task-one', executionId: 'execution-test-first-denial', generation: 1, contract,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  });
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({
      kind: 'enter',
      messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修复后端' }] }],
    }),
  );
  const state = controller.states.get(agent);
  for (const skill of contract.requiredSkills.filter((name) => name !== 'forge-evidence-truth')) {
    await handlers.get('tools/result')(
      { ...exec('skill', { name: skill }, agent), callId: `test-first-skill-${skill}` }, ok(),
    );
  }
  state.currentStep = 9;
  const repeatedRead = exec('read', { path: 'forge-server/example/pom.xml' }, agent);
  observeToolResult(state, { ...repeatedRead, callId: 'test-first-read-one' }, ok('same source fact'));
  observeToolResult(state, { ...repeatedRead, callId: 'test-first-read-two' }, ok('same source fact'));
  assert.equal(state.progressDecision.decision, 'SWITCH_TO_IMPLEMENT');

  const production = {
    ...exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }, agent),
    callId: 'policy-denied-production',
  };
  const denied = await handlers.get('tools/pre-execute')(
    production, async () => ({ kind: 'allow' }),
  );
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /test-first contract/u);
  assert.match(denied.reason, /业务行为变化请先写真实回归测试并验证失败/u);
  assert.match(denied.reason, /仅修已有 lint\/格式且保持行为不变.*用户在原对话新一轮.*prepare_task 准备精确文件范围/u);
  assert.match(denied.reason, /不得自行豁免或伪造 RED/u);
  await handlers.get('tools/result')(production, failed(denied.reason));
  assert.equal(state.mutationAttemptCount, 0);
  assert.equal(state.progressDecision.decision, 'SWITCH_TO_IMPLEMENT');

  const testWrite = {
    ...exec('write', { path: 'forge-server/example/src/test/java/ExampleTest.java' }, agent),
    callId: 'test-first-recovery-write',
  };
  assert.equal((await handlers.get('tools/pre-execute')(
    testWrite, async () => ({ kind: 'allow' }),
  )).kind, 'allow');
});

test('stable protected identity preserves state across turns and only a new generation resets it', async () => {
  const handlers = new Map();
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  };
  const contract = compileForgeTaskExecutionContract({
    prompt: '修复后端并先写回归测试',
    ownedPaths: ['forge-server/example'],
    actionCeiling: 'workspace-write',
  });
  let generation = 0;
  const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
    maxSteps: 40,
    admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
    resolveExecutionContext: async () => ({
      taskId: 'task-one', executionId: 'execution-resume', generation, contract,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  });
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  const preStep = (turn, step) => handlers.get('agent/pre-step')(
    { agent, turn, step, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续实现' }] }] }),
  );
  await preStep(1, 3);
  const first = controller.states.get(agent);
  first.mutationCount = 2;
  first.mutationsSinceAudit = 2;
  await preStep(2, 1);
  const resumed = controller.states.get(agent);
  assert.equal(resumed, first);
  assert.equal(resumed.mutationCount, 2);
  assert.equal(resumed.currentStep, 4, 'step budget must accumulate instead of resetting per turn');

  generation = 1;
  await preStep(3, 1);
  const reset = controller.states.get(agent);
  assert.notEqual(reset, resumed);
  assert.equal(reset.executionContextGeneration, 1);
  assert.equal(reset.mutationCount, 0);
});

test('tool-continuation steps preserve protected identity while a new unresolved direct prompt invalidates it', async () => {
  const handlers = new Map();
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  };
  const contract = compileForgeTaskExecutionContract({
    prompt: '修复后端分页并先写回归测试',
    ownedPaths: ['forge-server/example'],
    actionCeiling: 'workspace-write',
  });
  let failDirectResolution = false;
  let resolverCalls = 0;
  const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
    maxSteps: 40,
    resolveExecutionContext: async ({ decision }) => {
      resolverCalls += 1;
      const direct = decision.messages.filter((message) => message?.source?.kind === 'user');
      if (direct.length === 0) return undefined;
      if (failDirectResolution) throw new Error('protected identity lookup failed');
      return {
        taskId: 'task-one', executionId: 'execution-continuation', generation: 0, contract,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
    },
  });
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  const preStep = (step, messages) => handlers.get('agent/pre-step')(
    { agent, turn: 1, step, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages }),
  );
  const directPrompt = {
    role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修复后端分页' }],
  };

  await preStep(1, [directPrompt]);
  const admitted = controller.states.get(agent);
  assert.equal(admitted.executionContextStatus, 'ready');

  await preStep(2, []);
  assert.equal(
    controller.states.get(agent).executionContextStatus,
    'ready',
    'an empty tool-continuation batch must retain the current protected identity',
  );

  failDirectResolution = true;
  await preStep(3, [directPrompt]);
  assert.equal(
    controller.states.get(agent).executionContextStatus,
    'unavailable',
    'a new direct prompt that cannot be bound must fail closed',
  );
  assert.equal(resolverCalls, 2, 'empty continuation steps must not perform an authority lookup');
});

test('task execution contract requires the exact domain Skills and rejects shell mutation bypasses', () => {
  const common = createInitialPhaseState({ turn: 3, maxSteps: 40 });
  authorizeWriterState(common, {
    prompt: '新增 Forge Admin 管理页面',
    ownedPaths: ['forge-admin-ui/src/views/order'],
  });
  for (const skill of [
    'forge-task-contract',
    'forge-task-router',
    'forge-change-design',
    'forge-testing-observability',
    'forge-backend-architecture',
  ]) observeToolResult(common, exec('skill', { name: skill }), ok());

  const frontendWrite = exec('write', { path: 'forge-admin-ui/src/views/order/index.vue' });
  assert.match(toolDenialReason(common, frontendWrite), /forge-frontend-admin/u);
  assert.match(toolDenialReason(common, frontendWrite), /forge-security-tenancy-permission/u);
  observeToolResult(common, exec('skill', { name: 'forge-frontend-admin' }), ok());
  observeToolResult(common, exec('skill', { name: 'forge-security-tenancy-permission' }), ok());
  const frontendProfiles = ['frontend-red-test', 'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build'];
  setReadyAdmission(common, frontendProfiles);
  const frontendTestWrite = exec('write', { path: 'forge-admin-ui/src/views/order/index.spec.js' });
  assert.equal(toolDenialReason(common, frontendTestWrite), undefined);
  observeToolResult(common, frontendTestWrite, ok());
  assert.equal(toolDenialReason(common, frontendWrite), undefined);

  const migration = routedState();
  authorizeWriterState(migration, {
    prompt: '新增数据库迁移',
    ownedPaths: ['forge-server/example/src/main/resources/db/migration'],
  });
  const sqlWrite = exec('write', { path: 'forge-server/example/src/main/resources/db/migration/V1.2.3__orders.sql' });
  assert.match(toolDenialReason(migration, sqlWrite), /forge-database-migration/u);

  assert.match(
    toolDenialReason(routedState(), exec('write', { path: 'unclassified/Custom.java' })),
    /outside the protected contract/u,
  );
  assert.match(
    toolDenialReason(routedState(), exec('bash', { command: 'touch forge-server/example/src/main/java/Bypass.java' })),
    /arbitrary shell/u,
  );
  assert.match(
    toolDenialReason(routedState(), exec('bash', { command: 'git add forge-server/example' })),
    /direct Git mutation/u,
  );
  assert.match(
    toolDenialReason(routedState(), exec('bash', { command: `printf '{"ok":true}'; forge-governance audit --base ${base}` })),
    /exact reviewed argv shape/u,
  );
  assert.match(
    toolDenialReason(routedState(), exec('bash', { command: 'forge-governance catalog --format json' })),
    /arbitrary shell/u,
  );
});

test('read-only stderr redirection is not a mutation and an empty-diff audit does not consume repair', () => {
  assert.equal(isMutationExecution(exec('bash', { command: 'git status 2>/dev/null; mvn -v 2>&1 | head -3' })), false);
  assert.equal(isMutationExecution(exec('bash', { command: 'grep -n "junit|<scope>test" pom.xml | head -40' })), false);
  assert.equal(isMutationExecution(exec('bash', { command: 'printf value > result.txt' })), true);

  const state = routedState();
  observeToolResult(
    state,
    exec('bash', { command: `forge-governance audit --root . --base ${base} --format json` }),
    ok(governanceReceipt(false)),
  );
  assert.equal(state.repairWindowUsed, false);
  observeToolResult(state, exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }), ok());
  observeToolResult(
    state,
    exec('bash', { command: `forge-governance audit --root . --base ${base} --format json` }),
    ok(governanceReceipt(false)),
  );
  assert.equal(state.repairAvailable, true);

  const unavailable = routedState();
  observeToolResult(unavailable, exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }), ok());
  const capability = exec('bash', { command: 'forge-verify capability --profile backend-module-test' });
  observeToolResult(unavailable, capability, failed('VERIFY_CAPABILITY_UNAVAILABLE: broker-token is not mounted'));
  assert.equal(unavailable.verificationBlocked, true);
  assert.equal(unavailable.repairAvailable, false, 'an environment capability blocker must not open a source repair window');
  assert.match(toolDenialReason(unavailable, capability), /do not retry/u);

  const cacheMiss = routedState();
  observeToolResult(cacheMiss, exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }), ok());
  const cacheCapability = exec('bash', { command: 'forge-verify capability --profile backend-module-test' });
  observeToolResult(
    cacheMiss,
    cacheCapability,
    ok('{"outcome":"cache_miss","reasonCode":"VERIFY_CACHE_MISS"}'),
  );
  assert.equal(cacheMiss.verificationBlocked, true);
  assert.equal(cacheMiss.verificationFailed, true);
  assert.equal(cacheMiss.repairAvailable, false);
  assert.match(toolDenialReason(cacheMiss, cacheCapability), /do not retry/u);

  const executorUnavailable = routedState();
  observeToolResult(
    executorUnavailable,
    cacheCapability,
    ok('{"outcome":"executor_unavailable","reasonCode":"VERIFY_EXECUTOR_PROBE_FAILED"}'),
  );
  assert.equal(executorUnavailable.verificationBlocked, true);
  assert.equal(executorUnavailable.verificationFailed, true);
  assert.match(toolDenialReason(executorUnavailable, cacheCapability), /do not retry/u);
});

test('runtime hook preserves downstream prompt, observes final results, corrects once, then cancels', async () => {
  const handlers = new Map();
  let monotonicGuard;
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard(handler) { monotonicGuard = handler; return () => {}; } },
  };
  const createUserMessage = (input) => ({ id: `plugin-${Math.random()}`, role: 'user', ...input });
  const controller = installPhaseBudgetGuard(ctx, createUserMessage, { maxSteps: 40 });
  const steered = [];
  const cancelled = [];
  const agent = {
    session: { events: [] },
    steer(message) { steered.push(message); },
    cancel(cause) { cancelled.push(cause); },
  };
  const directPrompt = { id: 'prompt-1', role: 'user', content: [{ type: 'text', text: '先写失败测试，再修复实现' }], source: { kind: 'user' } };
  const decision = await handlers.get('agent/pre-step')(
    { agent, turn: 11, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [directPrompt] }),
  );
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages[0], directPrompt, 'soft phase reminder must preserve the claimed direct prompt');
  assert.match(decision.messages[1].content[0].text, new RegExp(PHASE_GUARD_MARKER, 'u'));

  const state = controller.states.get(agent);
  assert.equal(state.tddRequired, true);
  assert.equal(monotonicGuard(exec('write', {}, agent)), toolDenialReason(state, exec('write', {}, agent)));
  handlers.get('tools/result')(exec('skill', { name: 'forge-task-router' }, agent), ok());
  handlers.get('tools/result')(exec('skill', { name: 'forge-task-contract' }, agent), ok());
  handlers.get('tools/result')(exec('skill', { name: 'forge-backend-architecture' }, agent), ok());
  const admittedEdit = exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }, agent);
  reserveAllowedAttempt(state, admittedEdit);
  state.writerReservations.get(admittedEdit.callId).allowed = true;
  handlers.get('tools/result')(admittedEdit, ok());

  agent.session.events.push({
    type: 'assistant/message',
    seq: 10,
    data: { turn: 11, message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'Done' }] } },
  });
  handlers.get('agent/turn-stopping')({ agent, turn: 11 });
  assert.equal(steered.length, 1);
  assert.match(steered[0].content[0].text, /final-governance-audit-missing/u);
  handlers.get('agent/turn-stopping')({ agent, turn: 11 });
  assert.equal(steered.length, 1, 'same assistant message must not consume the correction twice');

  agent.session.events.push({
    type: 'user/message',
    seq: 11,
    data: {
      turn: 11,
      message: {
        id: 'phase-correction-1',
        role: 'user',
        source: { kind: 'plugin', plugin: 'forge-phase-budget-guard', form: 'correction' },
        content: [{ type: 'text', text: 'Correct closeout' }],
      },
    },
  });

  agent.session.events.push({
    type: 'assistant/message',
    seq: 12,
    data: { turn: 11, message: { id: 'assistant-2', role: 'assistant', content: [{ type: 'text', text: 'Done again' }] } },
  });
  handlers.get('agent/turn-stopping')({ agent, turn: 11 });
  assert.deepEqual(cancelled, [{
    kind: 'hook',
    reason: `${PHASE_GUARD_MARKER}: closeout obligations remained unsatisfied after one correction`,
  }]);
});

test('ordinary response contract reaches the same old agent on every new turn without a Skill call', async () => {
  const handlers = new Map();
  installPhaseBudgetGuard({
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  }, (input) => ({ role: 'user', ...input }));
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  const preStep = (turn, text) => handlers.get('agent/pre-step')(
    { agent, turn, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [{
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }],
    }] }),
  );

  const first = await preStep(41, '上次做了什么？');
  const second = await preStep(42, '这次调查列表的改动发布成功了吗？');
  for (const decision of [first, second]) {
    const notice = decision.messages.at(-1).content[0].text;
    assert.match(notice, /ORDINARY RESPONSE CONTRACT/u);
    assert.match(notice, /user's main language, normally in 1-3 short paragraphs/u);
    assert.match(notice, /Do not force headings or default to technical IDs, hashes, original commands, receipt tables/u);
  }
  assert.equal(agent.session.events.length, 0, 'the response contract does not depend on a Skill call');
});

test('only a current protected A9 proposal turn ends before operator Host verification', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-a9-proposal-closeout-'));
  try {
    const catalog = JSON.parse(await readFile(new URL('../docker/harness/skills/forge-task-router/references/phase-profiles.json', import.meta.url), 'utf8'));
    const phase = resolveForgeDeliveryPhase({ catalog, workflowId: 'crud-production', caseFamily: 'crud-complete', phaseId: 'database' });
    const actorUserId = '123e4567-e89b-42d3-a456-426614174000';
    const metadata = { schemaVersion: 2, projectSlug: 'forge-project', taskId: 'task-one', actorId: 'alice', actorUserId,
      conversationId: 'conversation:phase:001', accessMode: 'conversation', status: 'active' };
    const content = [{ type: 'text', text: '实现供应商数据库迁移与测试；Host 验证由操作端在提案结束后运行。' }];
    const request = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request',
      rpcId: '123e4567-e89b-42d3-a456-426614174111', method: 'session.prompt',
      payload: { sessionId: 'session-one', mode: 'queue', content } })), 'session.prompt');
    const { idempotent: _idempotent, refreshed: _refreshed, ...context } = await prepareProtectedExecutionContext({
      projectRoot: root, projectSlug: metadata.projectSlug, taskMetadata: metadata,
      request: { ...request, requestId: 'request-one', actorUserId, actorUsername: 'alice', conversationId: metadata.conversationId },
      policyPath: path.resolve('tests/fixtures/forge-harness-behavior-evals/execution-policy.test-shadow.json'),
      trustedPolicyInput: { profile: 'test-shadow', sourceCommit: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3',
        caseFamily: 'crud-complete', phaseAuthority: { workflowId: phase.workflowId, phaseId: phase.phase.id,
          phaseIndex: phase.phase.index, catalogVersion: phase.catalogVersion, catalogDigest: phase.catalogDigest,
          actionCeiling: phase.phase.actionCeiling, ownedPaths: phase.phase.ownedPaths, taskProfiles: phase.phase.taskProfiles,
          requiredProfiles: phase.phase.contractVerificationProfiles } },
    });
    const controls = [
      ['protected A9', undefined, true],
      ['unvalidated context', (state) => { state.protectedExecutionContextValidated = false; }, false],
      ['unavailable context', (state) => { state.executionContextStatus = 'unavailable'; }, false],
      ['expired context', (state) => { state.executionContextExpiresAt = new Date(0).toISOString(); }, false],
      ['production writer', (state) => { state.executionAuthorityClass = 'production-task-writer'; state.executionTestOnly = false; }, false],
      ['unphased context', (state) => { state.executionWorkflowId = null; state.executionPhaseId = null; }, false],
      ['missing phase', (state) => { state.executionPhaseId = null; }, false],
      ['missing catalog binding', (state) => { state.executionPhaseCatalogDigest = null; }, false],
      ['different contract', (state) => { state.executionIdentity.contractId = 'another-contract'; }, false],
    ];
    for (const [name, invalidate, proposalMayEnd] of controls) await t.test(name, async () => {
      const handlers = new Map();
      const steered = [], cancelled = [];
      let guard;
      let completionCalls = 0;
      const ctx = { on(name, handler) { handlers.set(name, handler); },
        tools: { guard(handler) { guard = handler; return () => {}; } } };
      const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
        resolveExecutionContext: async () => structuredClone(context),
        admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
        resolveProtectedCompletion: async () => { completionCalls += 1; return null; },
      });
      const agent = { session: { events: [] }, steer(message) { steered.push(message); }, cancel(cause) { cancelled.push(cause); } };
      const entered = await handlers.get('agent/pre-step')({ agent, turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content }] }));
      const state = controller.states.get(agent);
      assert.equal(state.protectedExecutionContextValidated, true);
      assert.equal(completionCalls, 0, 'A9 operator-owned acceptance does not query protected completion');
      if (name === 'protected A9') {
        assert.equal(entered.messages.at(-1).content[0].text, reminderForState(state),
          'Controller-owned A9 keeps the existing notice unchanged');
        assert.doesNotMatch(entered.messages.at(-1).content[0].text, /ORDINARY RESPONSE CONTRACT/u);
      }
      const mutation = exec('write', { path: 'forge-server/db/migration/V1.0.999__test_supplier.sql' }, agent);
      reserveAllowedAttempt(state, mutation);
      state.writerReservations.get(mutation.callId).allowed = true;
      await handlers.get('tools/result')(mutation, ok('migration proposal written'));
      assert.equal(state.mutationCount, 1);
      assert.ok(closeoutBlockers(state).includes('typed-verification-profile-missing:changed-safe'));
      assert.ok(closeoutBlockers(state).includes('typed-verification-profile-missing:full-regression'));
      const deniedBefore = guard(exec('write', { path: 'ops/project.env' }, agent));
      assert.ok(deniedBefore, 'out-of-scope mutation is still denied');
      invalidate?.(state);
      for (let i = 1; i <= 2; i += 1) {
        agent.session.events.push({ type: 'assistant/message', seq: i, data: { turn: 1,
          message: { id: `proposal-${i}`, role: 'assistant', content: [{ type: 'text', text: 'Proposal only; Host verification has not run.' }] } } });
        handlers.get('agent/turn-stopping')({ agent, turn: 1 });
      }
      assert.equal(steered.length, proposalMayEnd ? 0 : 1);
      assert.equal(cancelled.length, proposalMayEnd ? 0 : 1);
      assert.equal(state.verificationProfileReceipts.size, 0, 'turn completion must not manufacture Host receipts');
      if (proposalMayEnd) {
        assert.equal(guard(exec('write', { path: 'ops/project.env' }, agent)), deniedBefore);
        assert.ok(closeoutBlockers(state).length > 0, 'generic closeout requirements remain intact');
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('protected phase runtime projects routing and ready admission into the execution reducer store', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-phase-projection-'));
  try {
    const handlers = new Map();
    const ctx = {
      on(name, handler) { handlers.set(name, handler); },
      tools: { guard() { return () => {}; } },
    };
    const contract = compileForgeTaskExecutionContract({
      prompt: '修复后端并先写回归测试',
      ownedPaths: ['forge-server/example'],
      actionCeiling: 'workspace-write',
    });
    const issuedAt = new Date(Date.now() - 1_000).toISOString();
    const store = new ForgeExecutionStore({ root });
    const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
      maxSteps: 40,
      executionStore: store,
      admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
      resolveExecutionContext: async () => ({
        projectSlug: 'forge-project',
        taskId: 'task-one',
        executionId: 'execution-projected',
        generation: 1,
        contract,
        issuedAt,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    });
    const agent = { session: { events: [] }, steer() {}, cancel() {} };
    await handlers.get('agent/pre-step')(
      { agent, turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({
        kind: 'enter',
        messages: [{
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: '继续实现' }],
        }],
      }),
    );
    const state = controller.states.get(agent);
    assert.equal(state.executionProjectionStatus, 'ready');
    for (const skill of contract.requiredSkills.filter((entry) => entry !== 'forge-evidence-truth')) {
      await handlers.get('tools/result')(exec('skill', { name: skill }, agent), ok());
    }

    let projected = await store.read('execution-projected');
    assert.equal(projected.state.phase, 'DISCOVER');
    assert.equal(projected.state.admission.admissionId, admissionId);
    assert.deepEqual(projected.state.requiredSkills, contract.requiredSkills
      .filter((entry) => entry !== 'forge-evidence-truth').sort());
    assert.equal(projected.state.actionCeiling, 'workspace-write');
    assert.ok(projected.events.some((event) => event.operation === 'checkpoint'
      && event.payload.stage === 'phase-guard-runtime'
      && event.payload.result.legacyPhase === PHASES.DISCOVER));

    const productionWrite = exec('edit', {
      path: 'forge-server/example/src/main/java/Example.java',
    }, agent);
    let downstreamCalled = false;
    const premature = await handlers.get('tools/pre-execute')(
      productionWrite,
      async () => { downstreamCalled = true; return { kind: 'allow' }; },
    );
    assert.equal(premature.kind, 'deny');
    assert.match(premature.reason, /typed failing-test receipt/u);
    assert.equal(downstreamCalled, false);

    const testWrite = exec('write', {
      path: 'forge-server/example/src/test/java/ExampleTest.java',
    }, agent);
    const testDecision = await handlers.get('tools/pre-execute')(
      testWrite, async () => ({ kind: 'allow' }),
    );
    assert.equal(testDecision.kind, 'allow');
    await handlers.get('tools/result')(testWrite, ok());
    projected = await store.read('execution-projected');
    assert.equal(projected.state.phase, 'RED_GATE');
    assert.equal(projected.state.budgets.used.mutations, 1);

    const failedTestEdit = exec('str_replace_editor', {
      command: 'str_replace',
      path: 'forge-server/example/src/test/java/ExampleTest.java',
      old_str: 'old',
      new_str: 'new',
    }, agent);
    assert.equal((await handlers.get('tools/pre-execute')(
      failedTestEdit, async () => ({ kind: 'allow' }),
    )).kind, 'allow');
    await handlers.get('tools/result')(failedTestEdit, failed('edit failed'));
    projected = await store.read('execution-projected');
    assert.equal(projected.state.budgets.used.mutations, 1);
    assert.equal(projected.state.budgets.reserved.mutations, 0,
      'a failed writer result must release its projected mutation reservation');

    const redCommand = exec('bash', {
      command: `forge-verify run --profile backend-red-test --module forge-server/example --test ExampleTest --idempotency-key red-test-0001 --admission-id ${admissionId}`,
    }, agent);
    await handlers.get('tools/result')(redCommand, ok(strictFailingTestReceipt({ profile: 'backend-red-test' })));
    assert.equal(state.redGateAdapterRejection, undefined);
    projected = await store.read('execution-projected');
    assert.equal(projected.state.phase, 'IMPLEMENT_INCREMENT');
    assert.equal(projected.state.increment.mutationBaseline, 1);
    assert.equal(state.repairAvailable, false);

    const productionDecision = await handlers.get('tools/pre-execute')(
      productionWrite, async () => ({ kind: 'allow' }),
    );
    assert.equal(productionDecision.kind, 'allow');
    await handlers.get('tools/result')(productionWrite, ok());
    projected = await store.read('execution-projected');
    assert.equal(projected.state.budgets.used.mutations, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime suspension permits the first scoped source edit through the real reducer without RED or Skill calls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-drafting-order-'));
  try {
    const handlers = new Map();
    const contract = compileForgeTaskExecutionContract({
      prompt: '修复后端', ownedPaths: ['forge-server/example'], actionCeiling: 'workspace-write',
    });
    const store = new ForgeExecutionStore({ root });
    const controller = installRuntimePhaseBudgetGuard({
      on(name, handler) { handlers.set(name, handler); },
      tools: { guard() { return () => {}; } },
    }, (input) => ({ role: 'user', ...input }), {
      executionStore: store,
      admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
      resolveExecutionContext: async () => ({
        projectSlug: 'forge-project', taskId: 'task-one', executionId: 'drafting-order',
        generation: 1, contract,
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    });
    const agent = { session: { events: [] }, steer() {}, cancel() {} };
    await handlers.get('agent/pre-step')({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({
      kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: '继续修复' }] }],
    }));
    const write = exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }, agent);
    const draftDecision = await handlers.get('tools/pre-execute')(write, async () => ({ kind: 'allow' }));
    assert.equal(draftDecision.kind, 'allow', draftDecision.reason);
    await handlers.get('tools/result')(write, ok('scoped draft saved'));
    const projected = await store.read('drafting-order');
    assert.equal(projected.state.phase, 'IMPLEMENT_INCREMENT');
    assert.equal(projected.state.tddRequired, false);
    assert.equal(projected.state.budgets.used.mutations, 1);
    const state = controller.states.get(agent);
    assert.equal(state.invokedSkills.size, 0);
    assert.equal(state.redGateEvidence, undefined);
    assert.ok(closeoutBlockers(state).includes('typed-verification-profile-missing:backend-module-test'));
    assert.equal((await handlers.get('tools/pre-execute')(
      exec('edit', { path: 'ops/project.env' }, agent), async () => ({ kind: 'allow' }),
    )).kind, 'deny');
    state.actionCeiling = 'read-only';
    assert.match(toolDenialReason(state, write), /read-only/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an explicitly required reducer projection fails writer calls closed when its store is unavailable', async () => {
  const handlers = new Map();
  const ctx = {
    on(name, handler) { handlers.set(name, handler); },
    tools: { guard() { return () => {}; } },
  };
  const contract = compileForgeTaskExecutionContract({
    prompt: '修复后端并先写回归测试',
    ownedPaths: ['forge-server/example'],
    actionCeiling: 'workspace-write',
  });
  const unavailableStore = {
    async create() {
      const error = new Error('store unavailable');
      error.code = 'EXECUTION_STORE_UNAVAILABLE';
      throw error;
    },
  };
  const controller = installPhaseBudgetGuard(ctx, (input) => ({ role: 'user', ...input }), {
    maxSteps: 40,
    executionStore: unavailableStore,
    admitExecution: async (profiles) => JSON.parse(admissionReceipt(profiles)),
    resolveExecutionContext: async () => ({
      projectSlug: 'forge-project',
      taskId: 'task-one',
      executionId: 'execution-projection-failure',
      generation: 1,
      contract,
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }),
  });
  const agent = { session: { events: [] }, steer() {}, cancel() {} };
  await handlers.get('agent/pre-step')(
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({
      kind: 'enter',
      messages: [{
        role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续实现' }],
      }],
    }),
  );
  const state = controller.states.get(agent);
  assert.equal(state.executionProjectionStatus, 'failed');
  assert.equal(state.executionProjectionErrorCode, 'EXECUTION_STORE_UNAVAILABLE');
  let downstreamCalled = false;
  const decision = await handlers.get('tools/pre-execute')(
    exec('edit', { path: 'forge-server/example/src/main/java/Example.java' }, agent),
    async () => { downstreamCalled = true; return { kind: 'allow' }; },
  );
  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /reducer projection is unavailable/u);
  assert.equal(downstreamCalled, false);
});


test('suspended Skill order also permits authorized checkpoint integration and release without Skill calls', () => {
  const state = createInitialPhaseState({ turn: 1, maxSteps: 40, suspendHeuristicStops: true });
  authorizeWriterState(state, { actionCeiling: 'release', generation: 1 });
  state.protectedExecutionContextValidated = true;
  state.executionAuthorityClass = 'production-task-writer';
  state.executionTestOnly = false;
  state.executionSourceCommit = base;
  state.executionWorkspaceFingerprint = 'b'.repeat(64);
  const commands = [
    'forge-release checkpoint --path forge-server/example --message-base64 Y2hlY2twb2ludA --expected-head ' + base + ' --expected-fingerprint ' + 'b'.repeat(64),
    'forge-release integrate --mode start --expected-head ' + base + ' --expected-fingerprint ' + 'b'.repeat(64) + ' --canonical-head ' + 'c'.repeat(40),
    'forge-release release --services forge-admin',
  ];
  for (const command of commands) {
    assert.equal(toolDenialReason(state, exec('bash', { command })), undefined, command);
  }
  assert.equal(state.invokedSkills.size, 0, 'Skipping a procedural requirement never fabricates a Skill invocation');
  state.promptReadOnlyConstraint = true;
  for (const command of commands) assert.match(toolDenialReason(state, exec('bash', { command })), /read-only/);
  state.promptReadOnlyConstraint = false;
  state.actionCeiling = 'workspace-write';
  state.taskContract = { ...state.taskContract, actionCeiling: 'workspace-write' };
  for (const command of commands) assert.match(toolDenialReason(state, exec('bash', { command })), /exceeds the protected contract ceiling/);
});
