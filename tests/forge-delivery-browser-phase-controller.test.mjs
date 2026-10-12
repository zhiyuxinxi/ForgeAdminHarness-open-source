import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  beginForgeDeliveryBrowserPhase,
  createForgeDeliveryPhaseFormatRetryPrompt,
  initializeForgeDeliveryPhaseRun,
  prepareForgeDeliveryBrowserPhase,
  retryForgeRequirementsOverloadPhase,
} from '../docker/harness/forge-delivery-phase-controller.mjs';
import { prepareForgeDeliveryBrowserSessionBaseline, captureForgeDeliveryBrowserPhaseTerminal }
  from '../docker/harness/forge-delivery-phase-browser-session.mjs';
import {
  beginForgeDeliveryPhase,
  completeForgeDeliveryPhase,
  createForgeDeliveryPhaseArtifact,
  loadForgeDeliveryPhaseCatalog,
  readForgeDeliveryPhaseState,
  writeForgeDeliveryPhaseState,
} from '../docker/harness/forge-delivery-phase-runtime.mjs';
import { buildForgeDeliveryPhasePrompt } from '../docker/harness/forge-delivery-phase-response.mjs';
import {
  classifyPinnedDshPromptBody,
  digestDirectUserTextContent,
  digestProductionTaskAuthorityBinding,
  prepareProtectedExecutionContext,
} from '../docker/harness/forge-execution-context.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CATALOG_FILE = path.join(
  ROOT,
  'docker/harness/skills/forge-task-router/references/phase-profiles.json',
);
const POLICY_FILE = path.join(ROOT, 'docker/harness/forge-execution-policy.json');
const SOURCE_COMMIT = '908e13bdc08ec2cbb071d355a2c33a77c970bdd3';
const PROJECT_SLUG = 'validation-project';
const TASK_ID = 'task-browser-phase';
const SESSION_ID = 'session-browser-phase';
const ACTOR_USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-browser-phase-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalRequestFile = path.join(root, 'request.md');
  const stateFile = path.join(root, 'phase-control', 'state.json');
  const artifactsDirectory = path.join(root, 'phase-control', 'artifacts');
  const promptFile = path.join(root, 'phase-control', 'current-prompt.md');
  await writeFile(originalRequestFile, '实现一个生产级员工 CRUD。\n', 'utf8');
  await initializeForgeDeliveryPhaseRun({
    catalogFile: CATALOG_FILE,
    workflowId: 'crud-production',
    caseFamily: 'crud-complete',
    taskId: TASK_ID,
    sessionId: SESSION_ID,
    sourceCommit: SOURCE_COMMIT,
    originalRequestFile,
    stateFile,
    artifactsDirectory,
    promptFile,
  });
  return {
    root,
    executionRoot: path.join(root, 'execution'),
    originalRequestFile,
    stateFile,
    artifactsDirectory,
    promptFile,
  };
}

function controllerArgs(context, rpcId, overrides = {}) {
  return {
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    originalRequestFile: context.originalRequestFile,
    promptFile: context.promptFile,
    sourceCommit: SOURCE_COMMIT,
    taskId: TASK_ID,
    sessionId: SESSION_ID,
    rpcId,
    ...overrides,
  };
}

function requestFor(prompt, rpcId, requestId = `request:${rpcId}`) {
  const body = Buffer.from(JSON.stringify({
    type: 'client-request',
    rpcId,
    method: 'session.prompt',
    payload: { sessionId: SESSION_ID, mode: 'queue', content: [{ type: 'text', text: prompt }] },
  }));
  return {
    ...classifyPinnedDshPromptBody(body, 'session.prompt'),
    requestId,
    actorUserId: ACTOR_USER_ID,
    actorUsername: 'alice',
    conversationId: 'conversation:browser-phase',
  };
}

function metadata() {
  return {
    schemaVersion: 2,
    projectSlug: PROJECT_SLUG,
    taskId: TASK_ID,
    actorId: 'alice',
    actorUserId: ACTOR_USER_ID,
    conversationId: 'conversation:browser-phase',
    accessMode: 'conversation',
    status: 'active',
  };
}

async function realReadOnlyExecution(context, prepared) {
  return prepareProtectedExecutionContext({
    projectRoot: context.executionRoot,
    projectSlug: PROJECT_SLUG,
    taskMetadata: metadata(),
    request: requestFor(prepared.promptText, prepared.rpcId),
    policyPath: POLICY_FILE,
    trustedPhase: {
      sourceCommit: prepared.executionSourceCommit,
      caseFamily: prepared.caseFamily,
      phaseAuthority: prepared.phaseAuthority,
    },
    now: Date.now(),
  });
}

test('browser prepare returns only the current Controller-generated protected prompt binding', async (t) => {
  const context = await fixture(t);
  const rpcId = 'rpc:browser:requirements:1';
  const prepared = await prepareForgeDeliveryBrowserPhase(controllerArgs(context, rpcId));
  const prompt = (await readFile(context.promptFile, 'utf8')).replace(/(?:\r?\n)+$/u, '');
  assert.equal(prepared.promptText, prompt);
  assert.equal(prepared.promptDigest, digestDirectUserTextContent([{ type: 'text', text: prompt }]));
  assert.notEqual(prepared.promptDigest, crypto.createHash('sha256').update(prompt).digest('hex'));
  assert.equal(prepared.sourceCommit, SOURCE_COMMIT);
  assert.equal(prepared.executionSourceCommit, SOURCE_COMMIT);
  assert.equal(prepared.phaseId, 'requirements');
  assert.equal(prepared.phaseAuthority.phaseId, 'requirements');
  assert.equal(prepared.idempotent, false);

  const explicit = await prepareForgeDeliveryBrowserPhase(controllerArgs(context, rpcId, { promptText: prompt }));
  assert.deepEqual(explicit, prepared);
  await assert.rejects(
    prepareForgeDeliveryBrowserPhase(controllerArgs(context, rpcId, { promptText: `${prompt}\nchanged` })),
    (error) => error.code === 'PHASE_CONTROLLER_BROWSER_PROMPT_MISMATCH',
  );
  await assert.rejects(
    prepareForgeDeliveryBrowserPhase(controllerArgs(context, rpcId, { sourceCommit: 'a'.repeat(40) })),
    (error) => error.code === 'PHASE_CONTROLLER_BROWSER_IDENTITY_MISMATCH',
  );
});

test('browser begin validates a real production phase execution and replays the exact RPC idempotently', async (t) => {
  const context = await fixture(t);
  const rpcId = 'rpc:browser:requirements:2';
  const prepared = await prepareForgeDeliveryBrowserPhase(controllerArgs(context, rpcId));
  const execution = await realReadOnlyExecution(context, prepared);
  const first = await beginForgeDeliveryBrowserPhase({
    ...controllerArgs(context, rpcId), prepared, execution,
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.attempt.rpcId, rpcId);
  assert.equal(first.attempt.promptDigest, prepared.promptDigest);
  assert.equal(first.attempt.executionGeneration, execution.generation);
  const stateAfterFirst = await readFile(context.stateFile);

  const replay = await beginForgeDeliveryBrowserPhase({
    ...controllerArgs(context, rpcId), prepared, execution,
  });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.attempt.attemptId, first.attempt.attemptId);
  assert.deepEqual(await readFile(context.stateFile), stateAfterFirst);

  await assert.rejects(
    prepareForgeDeliveryBrowserPhase(controllerArgs(context, 'rpc:browser:different')),
    (error) => error.code === 'PHASE_CONTROLLER_BROWSER_PREPARE_DENIED',
  );
  await assert.rejects(
    beginForgeDeliveryBrowserPhase({
      ...controllerArgs(context, rpcId), prepared,
      execution: { ...execution, phaseId: 'domain-contract', phaseIndex: 1 },
    }),
    (error) => ['PHASE_CONTROLLER_BROWSER_EXECUTION_INVALID',
      'PHASE_CONTROLLER_BROWSER_EXECUTION_MISMATCH'].includes(error.code),
  );
});

test('requirements overload keeps evidence and prompt, rejects once and exhausts only the existing budget', async (t) => {
  const context = await fixture(t);
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const originalPrompt = await readFile(context.promptFile);
  const actual = JSON.parse(await readFile(new URL('./fixtures/requirements-provider-overload-events.json', import.meta.url), 'utf8'));
  async function failedAttempt(rpcId) {
    const prepared = await prepareForgeDeliveryBrowserPhase(controllerArgs(context, rpcId));
    const { idempotent: _idempotent, refreshed: _refreshed, ...execution } = await realReadOnlyExecution(context, prepared);
    const begin = await beginForgeDeliveryBrowserPhase({ ...controllerArgs(context, rpcId), prepared, execution });
    const session = { sessionId: SESSION_ID, cwd: '/workspace', blank: false, running: false, updatedAt: 10,
      identityDigest: 'f'.repeat(64) };
    const history = (events) => ({ events, pages: 1, eventCount: events.length, session });
    const baseline = await prepareForgeDeliveryBrowserSessionBaseline({ execution, port: 1, expectedCwd: '/workspace',
      readHistory: async () => history([]) });
    const events = [{ seq: 10, type: 'turn/start', data: { turn: 1 } },
      { seq: 11, type: 'user/message', data: { turn: 1, message: { source: { kind: 'user', rpcId },
        content: [{ type: 'text', text: prepared.promptText }] } } }, ...actual];
    const capture = await captureForgeDeliveryBrowserPhaseTerminal({ execution, baseline, port: 1, expectedCwd: '/workspace',
      readHistory: async () => history(events) });
    const attemptDirectory = path.join(path.dirname(context.stateFile), 'browser-attempts', execution.executionId);
    await mkdir(attemptDirectory, { recursive: true });
    for (const [name, value] of Object.entries({ 'execution.json': execution, 'session-baseline.json': baseline,
      'begin.json': begin, '需求阶段-供应方临时故障证明.json': capture.providerFailureProof })) {
      await writeFile(path.join(attemptDirectory, name), JSON.stringify(value));
    }
    return { attemptDirectory, execution, begin, proof: capture.providerFailureProof };
  }
  const first = await failedAttempt('requirements:overload:1');
  const before = await readFile(context.stateFile);
  const proofFile = path.join(first.attemptDirectory, '需求阶段-供应方临时故障证明.json');
  for (const [key, value] of Object.entries({ sourceCommit: 'b'.repeat(40), actorUsername: 'other',
    phaseCatalogDigest: 'b'.repeat(64), terminalReason: 'completed', toolCallCount: 1 })) {
    await writeFile(proofFile, JSON.stringify({ ...first.proof, [key]: value }));
    await assert.rejects(retryForgeRequirementsOverloadPhase({ ...controllerArgs(context, 'unused'),
      attemptDirectory: first.attemptDirectory }));
    assert.deepEqual(await readFile(context.stateFile), before);
  }
  await writeFile(proofFile, JSON.stringify(first.proof));
  const retryArgs = { ...controllerArgs(context, 'unused'), attemptDirectory: first.attemptDirectory };
  const retry = await retryForgeRequirementsOverloadPhase(retryArgs);
  assert.equal(retry.status, 'retry-ready');
  assert.equal(retry.receipt.remainingAttempts, 1);
  assert.equal(retry.receipt.stateAdvanced, false);
  let state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].reasonCode, 'REQUIREMENTS_PROVIDER_OVERLOAD');
  assert.equal(state.currentPhaseId, 'requirements');
  assert.equal(state.activeAttempt, null);
  assert.deepEqual(state.acceptedArtifacts, {});
  assert.deepEqual(await readFile(context.promptFile), originalPrompt);
  assert.deepEqual(await retryForgeRequirementsOverloadPhase(retryArgs), retry);
  const second = await failedAttempt('requirements:overload:2');
  assert.ok(second.execution.generation > first.execution.generation);
  assert.deepEqual(await readFile(context.promptFile), originalPrompt);
  const exhausted = await retryForgeRequirementsOverloadPhase({ ...controllerArgs(context, 'unused'),
    attemptDirectory: second.attemptDirectory });
  assert.equal(exhausted.status, 'exhausted');
  state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(state.status, 'blocked');
  assert.equal(state.history.length, 2);
  assert.deepEqual(state.acceptedArtifacts, {});
  await assert.rejects(prepareForgeDeliveryBrowserPhase(controllerArgs(context, 'requirements:overload:3')));
});

test('browser begin rejects a changed Controller prompt without advancing state', async (t) => {
  const context = await fixture(t);
  const rpcId = 'rpc:browser:requirements:stale';
  const prepared = await prepareForgeDeliveryBrowserPhase(controllerArgs(context, rpcId));
  const execution = await realReadOnlyExecution(context, prepared);
  const before = await readFile(context.stateFile);
  await writeFile(context.promptFile, `${prepared.promptText}\nchanged\n`, 'utf8');
  await assert.rejects(
    beginForgeDeliveryBrowserPhase({
      ...controllerArgs(context, rpcId), prepared, execution,
    }),
    (error) => error.code === 'PHASE_CONTROLLER_BROWSER_PROMPT_MISMATCH',
  );
  assert.deepEqual(await readFile(context.stateFile), before);
});

test('browser prepare accepts only a Controller receipt-bound format retry prompt', async (t) => {
  const context = await fixture(t);
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  let state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  const basePrompt = (await readFile(context.promptFile, 'utf8')).replace(/(?:\r?\n)+$/u, '');
  state = beginForgeDeliveryPhase({
    state,
    catalog,
    phaseId: 'requirements',
    rpcId: 'rpc:format:first',
    promptDigest: digestDirectUserTextContent([{ type: 'text', text: basePrompt }]),
    executionGeneration: 1,
  });
  await writeForgeDeliveryPhaseState(context.stateFile, state, catalog);
  const evidence = path.join(context.root, 'format');
  await mkdir(evidence, { recursive: true });
  const files = {
    responseFile: path.join(evidence, 'response.md'),
    allChangedPathsFile: path.join(evidence, 'all.json'),
    phaseChangedPathsFile: path.join(evidence, 'phase.json'),
    phasePatchFile: path.join(evidence, 'phase.patch'),
    cumulativePatchFile: path.join(evidence, 'cumulative.patch'),
  };
  await Promise.all([
    writeFile(files.responseFile, '<forge-phase-artifact>{invalid}</forge-phase-artifact>\n'),
    writeFile(files.allChangedPathsFile, '[]\n'),
    writeFile(files.phaseChangedPathsFile, '[]\n'),
    writeFile(files.phasePatchFile, ''),
    writeFile(files.cumulativePatchFile, ''),
  ]);
  await createForgeDeliveryPhaseFormatRetryPrompt({
    catalogFile: CATALOG_FILE,
    stateFile: context.stateFile,
    artifactsDirectory: context.artifactsDirectory,
    originalRequestFile: context.originalRequestFile,
    promptFile: context.promptFile,
    rejectionReceiptFile: path.join(evidence, 'format-rejection-receipt.json'),
    ...files,
  });
  const prepared = await prepareForgeDeliveryBrowserPhase(controllerArgs(
    context,
    'rpc:format:retry',
  ));
  assert.match(prepared.promptText, /REJECTED FORMAT FEEDBACK/u);
  assert.equal(prepared.idempotent, false);

  const rejected = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  const receiptFile = `${context.promptFile}.${rejected.history.at(-1).attemptId}.retry-receipt.json`;
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  await writeFile(receiptFile, `${JSON.stringify({ ...receipt, retryPromptDigest: '0'.repeat(64) }, null, 2)}\n`);
  await assert.rejects(
    prepareForgeDeliveryBrowserPhase(controllerArgs(context, 'rpc:format:retry')),
    (error) => error.code === 'PHASE_CONTROLLER_RETRY_RECEIPT_INVALID',
  );
});

async function acceptCurrentReadOnly(context, catalog, generation, payloadOverrides = {}) {
  let state = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  const phase = catalog.workflows[0].phases[state.currentPhaseIndex];
  const prompt = (await readFile(context.promptFile, 'utf8')).replace(/(?:\r?\n)+$/u, '');
  state = beginForgeDeliveryPhase({
    state,
    catalog,
    phaseId: phase.id,
    rpcId: `rpc:advance:${generation}`,
    promptDigest: digestDirectUserTextContent([{ type: 'text', text: prompt }]),
    executionGeneration: generation,
  });
  const artifact = createForgeDeliveryPhaseArtifact({
    state,
    catalog,
    phaseId: phase.id,
    attemptId: state.activeAttempt.attemptId,
    sourceFingerprint: EMPTY_SHA256,
    payload: { ...Object.fromEntries(phase.requiredPayloadKeys.map((key) => [key, {}])), ...payloadOverrides },
  });
  const completed = completeForgeDeliveryPhase({
    state,
    catalog,
    decision: 'accepted',
    artifact,
    hostReceipts: [],
  });
  await writeFile(path.join(context.artifactsDirectory, `${artifact.artifactKind}.json`),
    `${JSON.stringify(artifact, null, 2)}\n`);
  await writeForgeDeliveryPhaseState(context.stateFile, completed.state, catalog);
  const nextPhase = catalog.workflows[0].phases[completed.state.currentPhaseIndex];
  const artifacts = await Promise.all(nextPhase.requiresArtifacts.map(async (kind) => (
    JSON.parse(await readFile(path.join(context.artifactsDirectory, `${kind}.json`), 'utf8'))
  )));
  const nextPrompt = buildForgeDeliveryPhasePrompt({
    state: completed.state,
    catalog,
    originalRequest: (await readFile(context.originalRequestFile, 'utf8')).trimEnd(),
    upstreamArtifacts: artifacts,
  });
  await writeFile(context.promptFile, `${nextPrompt}\n`);
}

test('writer begin accepts only the production-authorized leaf scope inside the Controller phase roots', async (t) => {
  const context = await fixture(t);
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  await acceptCurrentReadOnly(context, catalog, 1);
  await acceptCurrentReadOnly(context, catalog, 2);
  const rpcId = 'rpc:browser:database:3';
  const prepared = await prepareForgeDeliveryBrowserPhase(controllerArgs(context, rpcId));
  assert.equal(prepared.phaseId, 'database');
  const ownedPaths = [
    'forge-server/db/migration/V1.0.999__fixture.sql',
    'forge-server/forge-business/forge-business-core/src/test/java/example/FixtureMigrationContractTest.java',
  ];
  for (let generation = 1; generation <= 2; generation += 1) {
    await prepareProtectedExecutionContext({
      projectRoot: context.executionRoot,
      projectSlug: PROJECT_SLUG,
      taskMetadata: metadata(),
      request: requestFor(`read-only ${generation}`, `rpc:prior:${generation}`, `request:prior:${generation}`),
      policyPath: POLICY_FILE,
      now: Date.now(),
    });
  }
  const request = requestFor(prepared.promptText, rpcId);
  const taskProfiles = prepared.phaseAuthority.taskProfiles;
  const contract = compileForgeTaskExecutionContract({
    prompt: prepared.promptText,
    ownedPaths,
    actionCeiling: prepared.phaseAuthority.actionCeiling,
    taskProfiles,
  });
  const productionAuthorityId = '223e4567-e89b-42d3-a456-426614174000';
  const workspaceFingerprint = 'b'.repeat(64);
  const controllerGrantDigest = 'c'.repeat(64);
  const productionAuthorityDigest = digestProductionTaskAuthorityBinding({
    projectSlug: PROJECT_SLUG,
    taskId: TASK_ID,
    actorUserId: ACTOR_USER_ID,
    actorUsername: 'alice',
    conversationId: 'conversation:browser-phase',
    dshSessionId: SESSION_ID,
    route: request.route,
    rpcId,
    promptDigest: request.textDigest,
    sourceCommit: SOURCE_COMMIT,
    workspaceFingerprint,
    caseFamily: 'maintenance',
    productionAuthorityId,
    controllerGrantDigest,
    contractId: contract.contractId,
    actionCeiling: contract.actionCeiling,
    ownedPaths: contract.ownedPaths,
  });
  const execution = await prepareProtectedExecutionContext({
    projectRoot: context.executionRoot,
    projectSlug: PROJECT_SLUG,
    taskMetadata: metadata(),
    request,
    policyPath: POLICY_FILE,
    trustedPolicyInput: {
      profile: 'production-controller',
      sourceCommit: SOURCE_COMMIT,
      workspaceFingerprint,
      caseFamily: 'maintenance',
      productionAuthorityId,
      productionAuthorityDigest,
      controllerGrantDigest,
      expectedContractId: contract.contractId,
      taskAuthority: {
        actionCeiling: contract.actionCeiling,
        ownedPaths,
        taskProfiles,
      },
    },
    trustedPhase: {
      sourceCommit: prepared.executionSourceCommit,
      caseFamily: prepared.caseFamily,
      phaseAuthority: prepared.phaseAuthority,
    },
    now: Date.now(),
  });
  const begun = await beginForgeDeliveryBrowserPhase({
    ...controllerArgs(context, rpcId), prepared, execution,
  });
  assert.equal(begun.idempotent, false);
  assert.deepEqual(execution.ownedPaths, ownedPaths);
  assert.ok(execution.ownedPaths.every((candidate) => prepared.phaseAuthority.ownedPaths.some(
    (root) => candidate === root || candidate.startsWith(`${root}/`),
  )));
  assert.notDeepEqual(execution.ownedPaths, prepared.phaseAuthority.ownedPaths);
});


test('browser begin binds the accepted explicit API projection and retains idempotent execution', async (t) => {
  const context = await fixture(t);
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  await acceptCurrentReadOnly(context, catalog, 1);
  // Same explicit path/exactPaths structure as retained domain contracts; generic platform routes only.
  const operations = [
    ...Array.from({ length: 59 }, (_, index) => ({ method: 'POST', path: `/inventory/item-${index}` })),
    ...Array.from({ length: 11 }, (_, index) => ({ method: 'GET', relativePath: `/action-${index}`,
      exactPaths: ['alpha', 'beta', 'gamma'].map(kind => `/inventory/${kind}/action-${index}`) })),
  ];
  await acceptCurrentReadOnly(context, catalog, 2, { apiContracts: { endpoints: [{ operations }] } });
  const rpcId = 'rpc:browser:api-boundary:3';
  const prepared = await prepareForgeDeliveryBrowserPhase(controllerArgs(context, rpcId));
  assert.equal(prepared.phaseId, 'database');
  const ownedPaths = [
    'forge-server/db/migration/V1.0.999__fixture.sql',
    'forge-server/forge-business/forge-business-core/src/test/java/example/FixtureMigrationContractTest.java',
  ];
  for (let generation = 1; generation <= 2; generation += 1) {
    await prepareProtectedExecutionContext({
      projectRoot: context.executionRoot,
      projectSlug: PROJECT_SLUG,
      taskMetadata: metadata(),
      request: requestFor(`read-only ${generation}`, `rpc:prior:${generation}`, `request:prior:${generation}`),
      policyPath: POLICY_FILE,
      now: Date.now(),
    });
  }
  const request = requestFor(prepared.promptText, rpcId);
  const taskProfiles = prepared.phaseAuthority.taskProfiles;
  const contract = compileForgeTaskExecutionContract({
    prompt: prepared.promptText,
    ownedPaths,
    actionCeiling: prepared.phaseAuthority.actionCeiling,
    taskProfiles,
  });
  const productionAuthorityId = '223e4567-e89b-42d3-a456-426614174000';
  const workspaceFingerprint = 'b'.repeat(64);
  const controllerGrantDigest = 'c'.repeat(64);
  const productionAuthorityDigest = digestProductionTaskAuthorityBinding({
    projectSlug: PROJECT_SLUG,
    taskId: TASK_ID,
    actorUserId: ACTOR_USER_ID,
    actorUsername: 'alice',
    conversationId: 'conversation:browser-phase',
    dshSessionId: SESSION_ID,
    route: request.route,
    rpcId,
    promptDigest: request.textDigest,
    sourceCommit: SOURCE_COMMIT,
    workspaceFingerprint,
    caseFamily: 'maintenance',
    productionAuthorityId,
    controllerGrantDigest,
    contractId: contract.contractId,
    actionCeiling: contract.actionCeiling,
    ownedPaths: contract.ownedPaths,
  });
  const execution = await prepareProtectedExecutionContext({
    projectRoot: context.executionRoot,
    projectSlug: PROJECT_SLUG,
    taskMetadata: metadata(),
    request,
    policyPath: POLICY_FILE,
    trustedPolicyInput: {
      profile: 'production-controller',
      sourceCommit: SOURCE_COMMIT,
      workspaceFingerprint,
      caseFamily: 'maintenance',
      productionAuthorityId,
      productionAuthorityDigest,
      controllerGrantDigest,
      expectedContractId: contract.contractId,
      taskAuthority: {
        actionCeiling: contract.actionCeiling,
        ownedPaths,
        taskProfiles,
      },
    },
    trustedPhase: {
      sourceCommit: prepared.executionSourceCommit,
      caseFamily: prepared.caseFamily,
      phaseAuthority: prepared.phaseAuthority,
    },
    now: Date.now(),
  });
  assert.equal(prepared.acceptedApiContract.endpoints.length, 92);
  const stateBefore = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.equal(prepared.acceptedApiContract.artifactDigest, stateBefore.acceptedArtifacts['domain-api-contract']);
  assert.equal(stateBefore.activeAttempt, null);
  const begun = await beginForgeDeliveryBrowserPhase({ ...controllerArgs(context, rpcId), prepared, execution });
  assert.equal(begun.idempotent, false);
  assert.equal(begun.attempt.executionGeneration, execution.generation);
  const begunBytes = await readFile(context.stateFile);
  const stateAfter = await readForgeDeliveryPhaseState(context.stateFile, catalog);
  assert.deepEqual(stateAfter.history, stateBefore.history);
  assert.deepEqual(stateAfter.acceptedArtifacts, stateBefore.acceptedArtifacts);
  for (const mutate of [
    value => { value.acceptedApiContract.endpoints[0].path = '/inventory/tampered'; },
    value => { value.acceptedApiContract.artifactDigest = '0'.repeat(64); },
    value => { delete value.acceptedApiContract; },
  ]) {
    const changed = structuredClone(prepared); mutate(changed);
    await assert.rejects(beginForgeDeliveryBrowserPhase({ ...controllerArgs(context, rpcId),
      prepared: changed, execution }), { code: 'PHASE_CONTROLLER_BROWSER_PREPARATION_STALE' });
    assert.deepEqual(await readFile(context.stateFile), begunBytes);
  }
  const replay = await beginForgeDeliveryBrowserPhase({ ...controllerArgs(context, rpcId), prepared, execution });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.attempt.attemptId, begun.attempt.attemptId);
  assert.deepEqual(await readFile(context.stateFile), begunBytes);
});
