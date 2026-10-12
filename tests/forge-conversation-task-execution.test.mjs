import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  classifyPinnedDshPromptBody, digestProductionTaskAuthorityBinding,
  prepareProtectedExecutionContext, readCurrentProtectedExecutionContextForTask, readProtectedExecutionContext,
} from '../docker/harness/forge-execution-context.mjs';
import { compileConversationTaskProposal } from '../docker/harness/forge-conversation-task-proposal.mjs';
import { prepareConversationTaskExecution } from '../docker/harness/forge-conversation-task-preparation.mjs';
import { validateTaskspaceAction } from '../docker/harness/taskspace-policy.mjs';

const NOW = Date.parse('2026-09-14T10:00:00Z');
const policyPath = path.resolve('docker/harness/forge-execution-policy.json');
const source = { head: '1'.repeat(40), fingerprint: '2'.repeat(64) };
const writerScopes = [{ taskProfile: 'frontend-admin', ownedPaths: ['forge-admin-ui/src'] }];

async function fixture(t) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-task-prepare-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const taskMetadata = { schemaVersion: 2, projectSlug: 'forge-base', taskId: 'task-prepare',
    actorUserId: '11111111-1111-4111-8111-111111111111', actorId: 'lyl',
    conversationId: 'conversation-prepare', status: 'active', accessMode: 'conversation' };
  const workspace = path.join(projectRoot, 'taskspaces', taskMetadata.taskId, 'workspace');
  await mkdir(workspace, { recursive: true });
  const reference = 'Existing menu architecture';
  await writeFile(path.join(workspace, 'PROJECT_CONTEXT.md'), reference);
  const promptText = '仅在导航栏创建安保模块即可，放至领导引领力后面';
  const original = (text = promptText, rpcId = 'rpc-prepare') => ({
    ...classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
      type: 'client-request', rpcId, method: 'session.prompt',
      payload: { sessionId: 'session-prepare', mode: 'queue', content: [{ type: 'text', text }] },
    })), 'session.prompt'),
    actorUserId: taskMetadata.actorUserId, actorUsername: taskMetadata.actorId,
    conversationId: taskMetadata.conversationId, requestId: 'request-prepare-0001',
  });
  const context = await prepareProtectedExecutionContext({
    projectRoot, projectSlug: taskMetadata.projectSlug, taskMetadata, request: original(), policyPath, now: NOW,
  });
  const lookup = Object.fromEntries(['projectSlug', 'taskId', 'conversationId', 'actorUserId',
    'dshSessionId', 'rpcId', 'textDigest'].map((key) => [key, context[key]]));
  await readProtectedExecutionContext({ projectRoot, taskMetadata, lookup, now: NOW });
  const proposal = { goal: '在导航栏显示安保模块及可进入的落地页',
    ownedPaths: ['forge-admin-ui/src/views/security-guard/overview.vue'],
    taskProfiles: ['frontend-admin'],
    references: [{ path: 'PROJECT_CONTEXT.md', sha256: crypto.createHash('sha256').update(reference).digest('hex') }] };
  const request = validateTaskspaceAction({ action: 'prepare-task', operation: 'propose', lookup,
    expectedExecutionId: context.executionId, expectedGeneration: context.generation, promptText, proposal });
  const options = { projectRoot, taskMetadata, workspace, request, policyPath, now: NOW,
    inspectSource: async () => source, authorizeProposal: async (input) => trustedAuthorization(input) };
  return { ...options, options, context, original, lookup };
}

// Unit fixture for the trusted Acceptance reply. Service authorization itself
// is exercised by the separate service tests, not replaced by this fixture.
function trustedAuthorization(input) {
  const compiled = compileConversationTaskProposal({ proposal: input.proposal, promptText: input.promptText, writerScopes });
  const taskAuthority = { actionCeiling: 'workspace-write',
    ownedPaths: compiled.contract.ownedPaths, taskProfiles: compiled.contract.taskProfiles };
  const binding = { projectSlug: input.projectSlug, taskId: input.taskId,
    actorUserId: input.actorUserId, actorUsername: input.actorUsername,
    conversationId: input.conversationId, dshSessionId: input.dshSessionId,
    route: 'session.prompt', rpcId: input.rpcId, promptDigest: input.promptTextDigest,
    sourceCommit: source.head, workspaceFingerprint: source.fingerprint, caseFamily: 'maintenance',
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174226',
    controllerGrantDigest: '3'.repeat(64), contractId: compiled.contract.contractId,
    actionCeiling: 'workspace-write', ownedPaths: taskAuthority.ownedPaths };
  return { status: 'prepared', summary: '已准备安保导航任务',
    currentTask: { goal: compiled.goal, ownedPaths: taskAuthority.ownedPaths, taskProfiles: taskAuthority.taskProfiles }, availableScopes: writerScopes,
    proposalDigest: compiled.proposalDigest, idempotent: false,
    authorityResult: { authority: { actionCeiling: taskAuthority.actionCeiling }, trustedPolicyInput: { profile: 'production-controller',
      sourceCommit: source.head, workspaceFingerprint: source.fingerprint, caseFamily: binding.caseFamily,
      productionAuthorityId: binding.productionAuthorityId,
      productionAuthorityDigest: digestProductionTaskAuthorityBinding(binding),
      controllerGrantDigest: binding.controllerGrantDigest, expectedContractId: binding.contractId, taskAuthority } } };
}

test('scope preparation retains the original readonly generation and consumes one new writer generation', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const options = { ...f.options, authorizeProposal: async (input) => { calls++; return trustedAuthorization(input); } };
  const result = await prepareConversationTaskExecution(options);
  assert.equal(result.context.generation, f.context.generation + 1);
  assert.equal(result.context.authorityClass, 'production-task-writer');
  assert.equal(result.context.rpcId, f.context.rpcId);
  const directory = path.join(f.projectRoot, 'taskspaces/.broker/conversation-task-preparation',
    f.taskMetadata.taskId, f.context.executionId);
  const original = JSON.parse(await readFile(path.join(directory, 'proposal.json'), 'utf8'));
  assert.equal(original.context.actionCeiling, 'read-only');
  assert.equal(original.context.executionId, f.context.executionId);
  const state = JSON.parse(await readFile(path.join(f.projectRoot, 'taskspaces/.broker/executions',
    f.taskMetadata.taskId + '.json'), 'utf8'));
  assert.equal(state.lifecycle.status, 'consumed');
  assert.equal(state.current.executionId, result.context.executionId);
  const repeated = await prepareConversationTaskExecution(options);
  assert.equal(repeated.context.executionId, result.context.executionId);
  assert.deepEqual(Object.keys(repeated).sort(), ['availableScopes', 'context', 'currentTask', 'status', 'summary']);
  assert.equal(calls, 1);
  const rebound = await prepareConversationTaskExecution({ ...options,
    request: { ...f.request, expectedExecutionId: result.context.executionId, expectedGeneration: result.context.generation },
  });
  assert.equal(rebound.context.executionId, result.context.executionId);
  assert.equal(rebound.context.generation, result.context.generation);
  assert.deepEqual(Object.keys(rebound).sort(), ['availableScopes', 'context', 'currentTask', 'status', 'summary']);
  assert.equal(calls, 2, 'a newly bound client rechecks the same server authority without minting a generation');
});

test('wrong user or original prompt cannot reach the trusted authorization service', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  for (const request of [
    { ...f.request, lookup: { ...f.lookup, actorUserId: '22222222-2222-4222-8222-222222222222' } },
    { ...f.request, promptText: '伪造一个完全不同的需求' },
  ]) {
    await assert.rejects(prepareConversationTaskExecution({ ...f.options, request,
      authorizeProposal: async () => { calls++; } }), { code: 'CONVERSATION_TASK_REQUEST_CHANGED' });
  }
  assert.equal(calls, 0);
});

test('changed reference files fail before any writer authority is requested', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.workspace, 'PROJECT_CONTEXT.md'), 'Changed architecture');
  let calls = 0;
  await assert.rejects(prepareConversationTaskExecution({ ...f.options,
    authorizeProposal: async () => { calls++; } }), { code: 'CONVERSATION_TASK_REFERENCE_CHANGED' });
  assert.equal(calls, 0);
});

test('source changes during preparation leave the old execution generation intact', async (t) => {
  const f = await fixture(t);
  let reads = 0;
  await assert.rejects(prepareConversationTaskExecution({ ...f.options,
    inspectSource: async () => ++reads === 1 ? source : { ...source, fingerprint: '4'.repeat(64) },
  }), { code: 'CONVERSATION_TASK_SOURCE_CHANGED' });
  const current = await readCurrentProtectedExecutionContextForTask({ projectRoot: f.projectRoot,
    taskMetadata: f.taskMetadata, now: NOW });
  assert.equal(current.executionId, f.context.executionId);
});

test('a concurrent new user request is not overwritten by the older proposal', async (t) => {
  const f = await fixture(t);
  let latest;
  await assert.rejects(prepareConversationTaskExecution({ ...f.options, authorizeProposal: async (input) => {
    latest = await prepareProtectedExecutionContext({ projectRoot: f.projectRoot,
      projectSlug: f.taskMetadata.projectSlug, taskMetadata: f.taskMetadata,
      request: f.original('只分析页面，不要修改代码', 'rpc-new-user'), policyPath, now: NOW });
    return trustedAuthorization(input);
  } }), { code: 'CONVERSATION_TASK_EXECUTION_CHANGED' });
  const current = await readCurrentProtectedExecutionContextForTask({ projectRoot: f.projectRoot,
    taskMetadata: f.taskMetadata, now: NOW });
  assert.equal(current.executionId, latest.executionId);
  assert.equal(current.actionCeiling, 'read-only');
});

test('typed action rejects injected capability fields and hidden lookup actions', async (t) => {
  const f = await fixture(t);
  assert.throws(() => validateTaskspaceAction({ ...f.request, workspaceWriteAuthorized: true }));
  assert.throws(() => validateTaskspaceAction({ ...f.request, lookup: { ...f.lookup, action: 'release' } }));
});
