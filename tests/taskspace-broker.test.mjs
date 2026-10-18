import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createForgeBusinessDataDeniedPreview, issueForgeBusinessDataApprovalAttestation } from '../docker/harness/forge-business-data-approval.mjs';
import {
  createTaskspaceBrokerServer,
  installTaskspaceBrokerShutdown,
  TaskspaceBroker,
} from '../docker/harness/taskspace-broker.mjs';
import {
  classifyPinnedDshPromptBody,
  digestProductionTaskAuthorityBinding,
  EXECUTION_CONTEXT_TTL_MS,
  prepareProtectedExecutionContext,
  readProtectedExecutionContext,
} from '../docker/harness/forge-execution-context.mjs';
import { hashTaskspaceToken, taskspaceError, validateSourceTransition, validateTaskspaceAction } from '../docker/harness/taskspace-policy.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
import { canonicalSha256 } from '../docker/harness/forge-acceptance-aggregator.mjs';
import { inventoryWorkspace } from '../docker/harness/verification-runner.mjs';

const execFileAsync = promisify(execFile);
test('Broker state reader accepts its persisted integration record above the HTTP limit', async () => {
  const fixture = await createFixture([], 'forge-broker-state-size-');
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base' });
  const stateFile = broker.integrationStateFile('task-a');
  const automaticStagedPaths = Array.from({ length: 499 }, (_, index) =>
    `forge-admin-ui/src/components/page-pattern-samples/${index}-${'a'.repeat(90)}.vue`);
  const record = {
    schemaVersion: 1, operationId: randomUUID(), phase: 'conflict-open',
    task: { projectSlug: 'forge-base', taskId: 'task-a', actorUsername: 'actor-a',
      actorUserId: '11111111-1111-4111-8111-111111111111', conversationId: 'conversation-a' },
    canonicalHead: fixture.baseCommit,
    conflictPaths: ['forge-admin-ui/src/components/__tests__/DictSelect.spec.js'],
    dirtyPaths: automaticStagedPaths,
    automaticStagedPaths,
    automaticIndexDigest: 'a'.repeat(64),
  };
  await broker.writeIntegratedReviewBaseState(stateFile, record);
  const saved = await stat(stateFile);
  assert.ok(saved.size > 64 * 1024);
  assert.ok(saved.size < 2 * 1024 * 1024);
  assert.deepEqual(await broker.readBrokerState(stateFile), record);
});

test('Broker state reader still rejects persisted JSON above two MiB', async () => {
  const fixture = await createFixture([], 'forge-broker-state-oversized-');
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base' });
  const stateFile = broker.integrationStateFile('task-a');
  await broker.writeIntegratedReviewBaseState(stateFile, {
    schemaVersion: 1, phase: 'conflict-open', padding: 'x'.repeat(2 * 1024 * 1024),
  });
  assert.ok((await stat(stateFile)).size > 2 * 1024 * 1024);
  await assert.rejects(broker.readBrokerState(stateFile), {
    code: 'TASKSPACE_INTEGRATION_STATE_INVALID',
  });
});

test('Broker prepare-task HTTP budget preserves complete referenced prompts and ordinary limits', async (t) => {
  const fixturePath = process.env.FORGE_PREPARE_TASK_PROMPT_FIXTURE;
  const promptText = fixturePath
    ? await readFile(fixturePath, 'utf8')
    : 'Original referenced business requirement.\n'.repeat(7500);
  if (fixturePath) {
    assert.equal(Buffer.byteLength(promptText), 288875);
    assert.equal(createHash('sha256').update(promptText).digest('hex'),
      '8a46b51f5e1f603af83570916293d9ed55ddd5cf176cc84c370db5d5b47c6344');
    t.diagnostic('Original 288875-byte leadership prompt consumed without shortening.');
  }
  assert.ok(Buffer.byteLength(promptText) > 64 * 1024);
  const token = 'f'.repeat(64);
  const authenticated = [];
  const dispatched = [];
  const task = { taskId: 'large-prompt' };
  // Exercise the real authentication dispatcher and real action schema, while
  // stopping before business preparation/permissions issuance in the fixture.
  const broker = {
    executeAuthenticated: TaskspaceBroker.prototype.executeAuthenticated,
    async taskForToken(value) {
      authenticated.push(value);
      if (value !== token) throw taskspaceError('TASKSPACE_AUTHENTICATION_FAILED', 'Invalid fixture token.');
      return task;
    },
    async executeForTask(actualTask, value) {
      assert.equal(actualTask, task);
      const request = validateTaskspaceAction(value);
      dispatched.push(request);
      return { action: request.action, operation: request.operation, authenticatedTaskId: task.taskId };
    },
  };
  const server = createTaskspaceBrokerServer({ broker });
  server.keepAliveTimeout = 25;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/actions`;
  async function post(value, suppliedToken = token) {
    const response = await fetch(endpoint, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(suppliedToken === null ? {} : { 'x-forge-taskspace-token': suppliedToken }) },
      body: JSON.stringify(value), signal: AbortSignal.timeout(5000) });
    return { status: response.status, value: await response.json() };
  }
  const lookup = { projectSlug: 'forge-base', taskId: task.taskId, conversationId: 'conversation-large-prompt',
    actorUserId: '11111111-1111-4111-8111-111111111111', dshSessionId: 'session-large-prompt',
    rpcId: 'rpc-large-prompt', textDigest: createHash('sha256').update(promptText).digest('hex') };
  const request = { action: 'prepare-task', operation: 'inspect', lookup,
    expectedExecutionId: '22222222-2222-4222-8222-222222222222', expectedGeneration: 1, promptText };
  for (const operation of ['inspect', 'propose']) {
    const value = { ...request, operation, ...(operation === 'propose' ? { proposal: { ownedPaths: ['src/goal.ts'] } } : {}) };
    const response = await post(value);
    assert.equal(response.status, 200);
    assert.deepEqual(response.value.result, { action: 'prepare-task', operation, authenticatedTaskId: task.taskId });
    assert.equal(dispatched.at(-1).promptText, promptText);
    assert.deepEqual(dispatched.at(-1).lookup, lookup);
  }
  assert.equal(authenticated.length, 2);
  const ordinary = await post({ action: 'status' });
  assert.equal(ordinary.status, 200);
  const callsBeforeRejections = dispatched.length;
  const ordinaryLarge = await post({ action: 'status', padding: 'x'.repeat(64 * 1024) });
  assert.equal(ordinaryLarge.status, 413);
  assert.equal(ordinaryLarge.value.error.code, 'REQUEST_TOO_LARGE');
  const oversizedPrepare = await post({ ...request, promptText: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(oversizedPrepare.status, 413);
  assert.equal(oversizedPrepare.value.error.code, 'REQUEST_TOO_LARGE');
  const authBeforeMissing = authenticated.length;
  const missingToken = await post(request, null);
  assert.equal(missingToken.status, 403);
  assert.equal(missingToken.value.error.code, 'TASKSPACE_AUTHENTICATION_FAILED');
  assert.equal(authenticated.length, authBeforeMissing);
  const invalidToken = await post(request, 'invalid-fixture-token');
  assert.equal(invalidToken.status, 403);
  assert.equal(invalidToken.value.error.code, 'TASKSPACE_AUTHENTICATION_FAILED');
  assert.equal(dispatched.length, callsBeforeRejections);
});

test('Broker binds a checksum migration failure from the accepted runtime repair child without replay', async (t) => {
  const { createForgeDeliveryPhaseState, beginForgeDeliveryPhase, completeForgeDeliveryPhase,
    createForgeDeliveryPhaseArtifact, loadForgeDeliveryPhaseCatalog, writeForgeDeliveryPhaseState } =
    await import('../docker/harness/forge-delivery-phase-runtime.mjs');
  const phaseController = await import('../docker/harness/forge-delivery-phase-controller.mjs');
  const { prepareForgeCrossLayerPreparation } = phaseController;
  const { snapshotForgeDeliveryWorkspace, observeForgeDeliveryPhase } =
    await import('../docker/harness/forge-delivery-phase-workspace-observer.mjs');
  const { createProjectReleaseStatusServer } = await import('../docker/harness/project-release-status.mjs');
  const { createHash } = await import('node:crypto');
  const { rm } = await import('node:fs/promises');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const bytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
  const put = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
  const timeline = Date.now() - 7200000;
  const at = offset => new Date(timeline + offset).toISOString();
  const actorUserId = '11111111-1111-4111-8111-111111111111';
  const fixture = await createFixture([{ taskId: 'r62b', actorId: 'migration-owner', actorUserId,
    conversationId: 'migration-conversation', token: 'a'.repeat(64), accessMode: 'conversation' }], 'r62b-');
  t.after(() => rm(fixture.projectRoot, { recursive: true, force: true }));
  const task = fixture.tasks.get('r62b');
  const inventoryContractPath = path.join(fixture.projectRoot, 'verification', 'contract.json');
  const inventoryContract = JSON.parse(await readFile(inventoryContractPath, 'utf8'));
  inventoryContract.profiles = [...(await import('../docker/harness/verify-policy.mjs')).VERIFY_PROFILE_NAMES];
  await writeFile(inventoryContractPath, JSON.stringify(inventoryContract));
  const catalogFile = path.resolve('docker/harness/skills/forge-task-router/references/phase-profiles.json');
  const { catalog } = await loadForgeDeliveryPhaseCatalog(catalogFile);
  const sessionId = 'session:failed-migration';
  const phaseDirectory = path.join(fixture.projectRoot, 'taskspaces', '.broker', 'delivery-phases', task.taskId, 'phase-control');
  const stateFile = path.join(phaseDirectory, 'state.json');
  const artifactsDirectory = path.join(phaseDirectory, 'artifacts');
  await mkdir(artifactsDirectory, { recursive: true });
  await writeFile(path.join(task.workspace, 'migration.sql'), '-- accepted forward migration\n');
  const before = await snapshotForgeDeliveryWorkspace({ workspace: task.workspace, baseCommit: fixture.baseCommit });
  const observed = await observeForgeDeliveryPhase({ workspace: task.workspace, baseCommit: fixture.baseCommit, before });
  let state = createForgeDeliveryPhaseState({ catalog, workflowId: 'crud-production', caseFamily: 'crud-complete',
    taskId: task.taskId, sessionId, sourceCommit: fixture.baseCommit, now: at(0) });
  for (const phase of catalog.workflows.find(v => v.id === 'crud-production').phases.slice(0, 7)) {
    state = beginForgeDeliveryPhase({ state, catalog, phaseId: phase.id, rpcId: `rpc:accepted:${phase.index}`,
      promptDigest: sha(phase.id), executionGeneration: phase.index + 1, now: at(phase.index * 1000) });
    const changedPaths = phase.sourceMutation ? [`${phase.ownedPaths[0]}/fixture.txt`] : [];
    const payload = Object.fromEntries(phase.requiredPayloadKeys.map(key => [key, key === 'changedPaths' ? changedPaths : {}]));
    const artifact = createForgeDeliveryPhaseArtifact({ state, catalog, phaseId: phase.id,
      attemptId: state.activeAttempt.attemptId, sourceFingerprint: phase.index < 2 ? sha('') : observed.cumulativePatchDigest, changedPaths,
      patchDigest: phase.patchScope === 'none' ? null : observed.cumulativePatchDigest, payload });
    ({ state } = completeForgeDeliveryPhase({ state, catalog, decision: 'accepted', artifact,
      hostReceipts: phase.hostVerificationProfiles.map(profile => ({ profile, status: 'passed',
        receiptDigest: sha(profile), patchDigest: observed.cumulativePatchDigest })), now: at(phase.index * 1000 + 500) }));
    await writeFile(path.join(artifactsDirectory, `${phase.artifactKind}.json`), JSON.stringify(artifact));
  }
  await writeForgeDeliveryPhaseState(stateFile, state, catalog);
  const inventory = await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS);
  const prepared = await prepareForgeCrossLayerPreparation({ catalogFile, stateFile, artifactsDirectory,
    sourceCommit: fixture.baseCommit, workspaceFingerprint: inventory.workspaceFingerprint,
    taskId: task.taskId, sessionId, rpcId: 'rpc:prepare:old', promptText: '' });
  const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request',
    rpcId: 'rpc:prepare:old', method: 'session.prompt', payload: { sessionId, mode: 'queue',
      content: [{ type: 'text', text: 'Prepare the accepted candidate read-only.' }] } })), 'session.prompt');
  const context = await prepareProtectedExecutionContext({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
    taskMetadata: task.metadata, policyPath: path.resolve('docker/harness/forge-execution-policy.json'),
    now: timeline + 10000,
    request: { ...classified, actorUserId, actorUsername: task.actorId, conversationId: task.conversationId,
      requestId: 'request:migration:failed' },
    trustedPhase: { sourceCommit: fixture.baseCommit, caseFamily: 'crud-complete', phaseAuthority: prepared.phaseAuthority,
      crossLayerPreparation: true, preparationBinding: prepared.preparationBinding } });
  const executionFile = path.join(fixture.projectRoot, 'taskspaces', '.broker', 'executions', `${task.taskId}.json`);
  const execution = JSON.parse(await readFile(executionFile, 'utf8'));
  execution.current.generation = 8;
  execution.lifecycle.status = 'consumed';
  await writeFile(executionFile, JSON.stringify(execution));
  const root = path.join(phaseDirectory, 'runtime-preparations', randomUUID());
  const repository = path.join(root, 'source.git');
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await execFileAsync('git', ['clone', '--bare', task.workspace, repository]);
  await writeFile(path.join(root, 'evidence', 'accepted.patch'), observed.cumulativePatch);
  const env = { ...process.env, GIT_INDEX_FILE: path.join(root, 'candidate.index'),
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const privateGit = async (...args) => (await execFileAsync('git', ['-C', repository, ...args], { env })).stdout.trim();
  await privateGit('read-tree', fixture.baseCommit);
  await privateGit('apply', '--cached', '--binary', path.join(root, 'evidence', 'accepted.patch'));
  const candidateTree = await privateGit('write-tree');
  const candidateCommit = await privateGit('commit-tree', candidateTree, '-p', fixture.baseCommit,
    '-m', `Accepted cross-layer candidate ${state.stateDigest}`);
  const startedAt = new Date(Date.parse(context.issuedAt) + 1000).toISOString();
  const completedAt = new Date(Date.parse(context.issuedAt) + 1200000).toISOString();
  const jobId = randomUUID();
  let diagnosis = { active: false, activeJobId: null, lastJob: { jobId, status: 'failed',
    stage: 'failed', failedStage: 'test-database-migration', commit: candidateCommit,
    provenance: { source: 'taskspace', taskId: task.taskId, actorId: task.actorId,
      conversationId: task.conversationId, candidateCommit }, startedAt, completedAt,
    error: { code: 'MIGRATION_EXECUTION_FAILED', diagnosticExcerpt: 'must never be projected' } },
    testDatabaseRecovery: { status: 'restore-required', lastAttempt: { jobId, commit: candidateCommit, status: 'failed' } } };
  const calls = [];
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', phaseCatalogFile: catalogFile,
    releaseClient: async value => { calls.push(value.action); assert.equal(value.action, 'diagnose'); return structuredClone(diagnosis); } });
  const input = { taskId: task.taskId, actorUserId, actorUsername: task.actorId, conversationId: task.conversationId,
    dshSessionId: sessionId, expectedHead: fixture.baseCommit, expectedFingerprint: inventory.workspaceFingerprint };
  const bound = await broker.readCrossLayerMigrationFailure(input);
  assert.equal(bound.status, 'failed-migration-bound');
  assert.equal(bound.failure.jobId, jobId);
  assert.equal(bound.failure.executionId, context.executionId);
  assert.equal(bound.failure.executionGeneration, 8);
  assert.equal(bound.failure.candidateTree, candidateTree);
  assert.deepEqual(bound.failure.acceptedArtifactDigests, state.acceptedArtifacts);
  assert.equal(sha(await readFile(bound.failureEvidenceFile)), bound.expectedFailureEvidenceSha256);
  assert.equal(JSON.stringify(bound).includes('must never be projected'), false);
  assert.deepEqual(await broker.readCrossLayerMigrationFailure(input), bound);
  for (const patch of [{ actorUsername: 'other' }, { dshSessionId: 'session:other' },
    { expectedFingerprint: 'f'.repeat(64) }, { jobId }]) {
    await assert.rejects(broker.readCrossLayerMigrationFailure({ ...input, ...patch }));
  }
  const original = structuredClone(diagnosis);
  for (const patch of [{ active: true }, { lastJob: { ...original.lastJob, status: 'prepared' } },
    { lastJob: { ...original.lastJob, failedStage: 'candidate-build' } },
    { lastJob: { ...original.lastJob, provenance: { ...original.lastJob.provenance, taskId: 'other' } } },
    { testDatabaseRecovery: { ...original.testDatabaseRecovery, lastAttempt: { ...original.testDatabaseRecovery.lastAttempt, jobId: randomUUID() } } }]) {
    diagnosis = { ...original, ...patch };
    await assert.rejects(broker.readCrossLayerMigrationFailure(input));
  }
  diagnosis = original;
  const rootStateBytes = await readFile(stateFile);
  await put(path.join(phaseDirectory, 'original-request.md'), Buffer.from('Implement the accepted fixture module.\n'));
  await put(path.join(phaseDirectory, 'phase-6-workspace-before.json'), bytes({ schemaVersion: 1, fixture: 'access baseline' }));
  const oldDirectory = path.join(phaseDirectory, 'access-wiring-repair');
  await phaseController.prepareForgeAccessWiringRepairContinuation({ catalogFile, sourceStateFile: stateFile,
    expectedSourceStateSha256: sha(rootStateBytes), sourceArtifactsDirectory: artifactsDirectory, sourceCommit: fixture.baseCommit,
    originalRequestFile: path.join(phaseDirectory, 'original-request.md'), outputDirectory: oldDirectory,
    repairRequestText: '修复当前权限迁移失败。', failureEvidenceFile: bound.failureEvidenceFile,
    expectedFailureEvidenceSha256: bound.expectedFailureEvidenceSha256 });
  const phases = catalog.workflows.find(value => value.id === 'crud-production').phases;
  const acceptAccess = async (directory, generation, offset) => {
    const file = path.join(directory, 'state.json');
    let current = JSON.parse(await readFile(file, 'utf8'));
    current = beginForgeDeliveryPhase({ state: current, catalog, phaseId: 'access-wiring', rpcId: `rpc:access:${generation}`,
      promptDigest: sha(`access:${generation}`), executionGeneration: generation, now: at(offset) });
    const phase = phases[6];
    const changedPaths = [`${phase.ownedPaths[0]}/fixture.txt`];
    const payload = Object.fromEntries(phase.requiredPayloadKeys.map(key => [key, key === 'changedPaths' ? changedPaths : {}]));
    const artifact = createForgeDeliveryPhaseArtifact({ state: current, catalog, phaseId: phase.id,
      attemptId: current.activeAttempt.attemptId, sourceFingerprint: observed.cumulativePatchDigest, changedPaths,
      patchDigest: observed.cumulativePatchDigest, payload });
    ({ state: current } = completeForgeDeliveryPhase({ state: current, catalog, decision: 'accepted', artifact,
      hostReceipts: phase.hostVerificationProfiles.map(profile => ({ profile, status: 'passed',
        receiptDigest: sha(`${profile}:${generation}`), patchDigest: observed.cumulativePatchDigest })), now: at(offset + 500) }));
    await put(path.join(directory, 'artifacts', `${phase.artifactKind}.json`), bytes(artifact));
    await writeForgeDeliveryPhaseState(file, current, catalog);
    return current;
  };
  let oldState = await acceptAccess(oldDirectory, 9, 1300000);
  const runtimePrompt = '当前候选运行检查结果，保留已完成的权限迁移。\n';
  const { digestDirectUserTextContent } = await import('../docker/harness/forge-execution-context.mjs');
  oldState = beginForgeDeliveryPhase({ state: oldState, catalog, phaseId: 'cross-layer-acceptance', rpcId: 'rpc:runtime:36',
    promptDigest: digestDirectUserTextContent([{ type: 'text', text: runtimePrompt.trimEnd() }]),
    executionGeneration: 36, now: at(1400000) });
  const oldStateFile = path.join(oldDirectory, 'state.json');
  await writeForgeDeliveryPhaseState(oldStateFile, oldState, catalog);
  await put(path.join(oldDirectory, 'current-prompt.md'), Buffer.from(runtimePrompt));
  const oldStateBytes = await readFile(oldStateFile);
  const preparationBinding = { stateDigest: oldState.stateDigest, acceptedArtifactDigests: oldState.acceptedArtifacts,
    baseSourceCommit: fixture.baseCommit, workspaceFingerprint: inventory.workspaceFingerprint };
  const preparationExecution = { ...execution.current, executionId: randomUUID(), claimId: randomUUID(), generation: 40,
    rpcId: 'rpc:runtime:40', issuedAt: at(1500000), expiresAt: at(2100000), preparationBinding };
  const preparationTerminal = { ...Object.fromEntries(['executionId', 'generation', 'dshSessionId', 'rpcId', 'textDigest']
    .map(key => [key, preparationExecution[key]])), terminalReason: 'completed', sessionRunning: false,
    turn: 40, requestSeq: 338128, terminalSeq: 340082, terminalEventDigest: '4'.repeat(64) };
  const observationId = '31ab7ebb-4c7d-4225-9a48-c01d5887db74';
  const common = { sourceCommit: candidateCommit, taskId: task.taskId, executionId: preparationExecution.executionId,
    stateDigest: oldState.stateDigest, baseSourceCommit: fixture.baseCommit, workspaceFingerprint: inventory.workspaceFingerprint,
    acceptedPatchSha256: observed.cumulativePatchDigest, candidateTree, observationId, observedAt: at(1501000) };
  const bundle = { manifestSha256: '0'.repeat(64), subject: { workflowId: oldState.workflowId, taskId: task.taskId,
    baseSourceCommit: fixture.baseCommit, stateDigest: oldState.stateDigest, catalogVersion: oldState.catalogVersion,
    catalogDigest: oldState.catalogDigest, cumulativePatchSha256: observed.cumulativePatchDigest },
    runtimeSource: { commit: candidateCommit, tree: candidateTree }, evidence: {
      deployment: { ...common, status: 'success', startup: { migrationValidated: true, applicationStarted: true } },
      api: { ...common, status: 'passed', roleAuthorizationVerified: false },
      database: { ...common, status: 'failed', checks: [{ id: 'fixture-role', status: 'failed', rowCount: 0, resultSha256: sha('') }] },
      browser: { ...common, status: 'not-executed', reason: 'owner-excluded' } }, sourceLineage: {} };
  const inputReceipt = { schemaVersion: 'forge-cross-layer-runtime-input-receipt/v1', sourceStateDigest: oldState.stateDigest,
    sessionId, lastExecutionGeneration: 36, acceptedArtifacts: oldState.acceptedArtifacts, manifestSha256: bundle.manifestSha256,
    bundleSha256: sha(bytes(bundle)), promptDigest: oldState.activeAttempt.promptDigest, promptSha256: sha(runtimePrompt),
    modelStarted: false, acceptedStageCountChanged: false, preparationBinding };
  const archiveDirectory = path.join(oldDirectory, 'runtime-rechecks', sha('rpc:old:reprobe'));
  const archived = { 'state.json': oldStateBytes, 'runtime-evidence.json': bytes({ old: true }),
    'runtime-input-receipt.json': bytes({ old: true }), 'current-prompt.md': Buffer.from(runtimePrompt) };
  for (const [name, value] of Object.entries(archived)) await put(path.join(archiveDirectory, name), value);
  const reprobe = { schemaVersion: 'forge-cross-layer-runtime-reprobe/v1', status: 'imported', rpcId: 'rpc:old:reprobe',
    requestSha256: '5'.repeat(64), taskId: task.taskId, sessionId, stateDigest: oldState.stateDigest,
    attemptId: oldState.activeAttempt.attemptId, baseSourceCommit: fixture.baseCommit, workspaceFingerprint: inventory.workspaceFingerprint,
    acceptedArtifactDigests: oldState.acceptedArtifacts, candidateCommit, candidateTree, acceptedPatchSha256: observed.cumulativePatchDigest,
    previousManifestSha256: '6'.repeat(64), previousObservationId: randomUUID(), previousStateDigest: oldState.stateDigest,
    previousExecutionId: randomUUID(), previousExecutionGeneration: 36, archiveDirectory,
    archivedSha256: Object.fromEntries(Object.entries(archived).map(([name, value]) => [name, sha(value)])),
    replacementManifestSha256: bundle.manifestSha256, replacementObservationId: observationId,
    replacementSha256: { 'runtime-evidence.json': sha(bytes(bundle)), 'runtime-input-receipt.json': sha(bytes(inputReceipt)) } };
  await put(path.join(oldDirectory, 'runtime-evidence.json'), bytes(bundle));
  await put(path.join(oldDirectory, 'runtime-input-receipt.json'), bytes(inputReceipt));
  await put(path.join(oldDirectory, 'runtime-reprobe.json'), bytes(reprobe));
  const runtimeDirectory = path.join(oldDirectory, 'runtime-access-repair');
  await phaseController.prepareForgeAccessWiringRuntimeRepairContinuation({ catalogFile, sourceStateFile: oldStateFile,
    expectedSourceStateSha256: sha(oldStateBytes), sourceArtifactsDirectory: path.join(oldDirectory, 'artifacts'),
    sourceCommit: fixture.baseCommit, originalRequestFile: path.join(oldDirectory, 'original-request.md'), outputDirectory: runtimeDirectory,
    repairRequestText: '请修复当前候选权限接线。', preparationExecution, preparationTerminal });
  const runtimeState = await acceptAccess(runtimeDirectory, 42, 1600000);
  const runtimeStateFile = path.join(runtimeDirectory, 'state.json');
  const runtimeStateBytes = await readFile(runtimeStateFile);
  const runtimePrepared = await prepareForgeCrossLayerPreparation({ catalogFile, stateFile: runtimeStateFile,
    artifactsDirectory: path.join(runtimeDirectory, 'artifacts'), sourceCommit: fixture.baseCommit,
    workspaceFingerprint: inventory.workspaceFingerprint, taskId: task.taskId, sessionId, rpcId: 'rpc:prepare:45', promptText: '' });
  execution.current = { ...execution.current, executionId: randomUUID(), claimId: randomUUID(), generation: 45,
    rpcId: 'rpc:prepare:45', issuedAt: at(1700000), expiresAt: at(2300000), preparationBinding: runtimePrepared.preparationBinding };
  await writeFile(executionFile, JSON.stringify(execution));
  const runtimeRoot = path.join(runtimeDirectory, 'runtime-preparations', randomUUID());
  await mkdir(path.join(runtimeRoot, 'evidence'), { recursive: true });
  await execFileAsync('git', ['clone', '--bare', repository, path.join(runtimeRoot, 'source.git')]);
  await writeFile(path.join(runtimeRoot, 'evidence', 'accepted.patch'), observed.cumulativePatch);
  const runtimeCandidate = await privateGit('commit-tree', candidateTree, '-p', fixture.baseCommit,
    '-m', `Accepted cross-layer candidate ${runtimeState.stateDigest}`);
  await execFileAsync('git', ['-C', path.join(runtimeRoot, 'source.git'), 'fetch', repository, runtimeCandidate]);
  const runtimeJobId = randomUUID();
  diagnosis = { active: false, activeJobId: null, lastJob: { ...original.lastJob, jobId: runtimeJobId,
    commit: runtimeCandidate, provenance: { ...original.lastJob.provenance, candidateCommit: runtimeCandidate },
    startedAt: at(1701000), completedAt: at(2900000), error: { code: 'MIGRATION_HISTORY_FAILED',
      diagnosticExcerpt: 'checksum mismatch; failedHistoryCount=0; must never be projected' } },
    testDatabaseRecovery: { status: 'restore-required', lastAttempt: { jobId: runtimeJobId, commit: runtimeCandidate, status: 'failed' } } };
  const callCount = calls.length;
  const runtimeBound = await broker.readCrossLayerMigrationFailure(input);
  assert.equal(calls.length - callCount, 2);
  assert.equal(runtimeBound.status, 'failed-migration-bound');
  assert.equal(runtimeBound.failure.errorCode, 'MIGRATION_HISTORY_FAILED');
  assert.equal(runtimeBound.failure.executionGeneration, 45);
  assert.equal(runtimeBound.failure.parentStateDigest, runtimeState.stateDigest);
  assert.equal(runtimeBound.failure.candidateCommit, runtimeCandidate);
  assert.equal(runtimeBound.failure.jobId, runtimeJobId);
  assert.equal(runtimeBound.failureEvidenceFile, path.join(runtimeRoot, 'migration-failure.json'));
  assert.deepEqual(runtimeBound.failure.acceptedArtifactDigests, runtimeState.acceptedArtifacts);
  assert.equal(JSON.stringify(runtimeBound).includes('must never be projected'), false);
  assert.deepEqual(await broker.readCrossLayerMigrationFailure(input), runtimeBound);
  const runtimeDiagnosis = structuredClone(diagnosis);
  for (const patch of [{ actorUsername: 'other' }, { dshSessionId: 'session:other' }, { expectedFingerprint: 'f'.repeat(64) }, { jobId: runtimeJobId }]) {
    await assert.rejects(broker.readCrossLayerMigrationFailure({ ...input, ...patch }));
  }
  for (const patch of [{ active: true }, { lastJob: { ...runtimeDiagnosis.lastJob, status: 'prepared' } },
    { lastJob: { ...runtimeDiagnosis.lastJob, failedStage: 'candidate-build' } },
    { lastJob: { ...runtimeDiagnosis.lastJob, error: { code: 'CANDIDATE_BUILD_FAILED' } } },
    { lastJob: { ...runtimeDiagnosis.lastJob, provenance: { ...runtimeDiagnosis.lastJob.provenance, taskId: 'other' } } },
    { testDatabaseRecovery: { ...runtimeDiagnosis.testDatabaseRecovery, lastAttempt: { ...runtimeDiagnosis.testDatabaseRecovery.lastAttempt, jobId: randomUUID() } } }]) {
    diagnosis = { ...runtimeDiagnosis, ...patch };
    await assert.rejects(broker.readCrossLayerMigrationFailure(input));
  }
  diagnosis = runtimeDiagnosis;
  assert.deepEqual(await readFile(stateFile), rootStateBytes);
  assert.deepEqual(await readFile(oldStateFile), oldStateBytes);
  assert.deepEqual(await readFile(runtimeStateFile), runtimeStateBytes);
  await writeFile(path.join(task.workspace, 'migration.sql'), '-- drift\n');
  await assert.rejects(broker.readCrossLayerMigrationFailure(input));
  assert.equal(calls.every(action => action === 'diagnose'), true);
  assert.equal(await readFile(executionFile, 'utf8'), JSON.stringify(execution));
  assert.equal((await readFile(stateFile, 'utf8')).includes(state.stateDigest), true);
  const server = createProjectReleaseStatusServer(async () => ({}), async value => ({ failure: value.taskId }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/cross-layer-migration-failure`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, { failure: task.taskId });
});

test('Broker shutdown stops admission and drains an active response on repeated signals', { timeout: 5000 }, async (t) => {
  const signals = new EventEmitter();
  let entered;
  let finish;
  const arrived = new Promise((resolve) => { entered = resolve; });
  const work = new Promise((resolve) => { finish = resolve; });
  const broker = {
    activeRelease: null,
    async integrationReadiness() { entered(); await work; return { ok: true }; },
    async maintenanceState() { return null; },
  };
  const server = createTaskspaceBrokerServer({ broker });
  // Exercise native keep-alive drainage without waiting its production default.
  server.keepAliveTimeout = 25;
  installTaskspaceBrokerShutdown(server, signals);
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => { finish(); agent.destroy(); server.closeAllConnections(); server.close(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/healthz', agent }, (result) => {
      let body = '';
      result.on('data', (chunk) => { body += chunk; });
      result.on('end', () => resolve({ status: result.statusCode, body: JSON.parse(body) }));
      result.on('error', reject);
    }).on('error', reject);
  });
  await arrived;
  t.diagnostic('shutdown: active request reached broker');
  const closed = once(server, 'close');
  signals.emit('SIGTERM');
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  assert.equal(server.listening, false);
  t.diagnostic('shutdown: listener stopped');
  await assert.rejects(new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path: '/healthz', agent: false }, resolve).on('error', reject);
  }), { code: 'ECONNREFUSED' });
  t.diagnostic('shutdown: new connection refused');
  finish();
  const completed = await response;
  t.diagnostic('shutdown: original response completed');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.ok, true);
  await closed;
  t.diagnostic('shutdown: server closed');
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

const VERIFICATION_LIMITS = Object.freeze({
  maxFiles: 250_000, maxBytes: 4 * 1024 * 1024 * 1024,
  maxLogBytes: 8 * 1024 * 1024, defaultTimeoutSeconds: 900,
});
test('Broker conversation task resolver preserves safe errors without changing other capabilities', async (t) => {
  const socketName = `forge-broker-task-errors-${process.pid}-${Date.now()}`;
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\${socketName}` : path.join(os.tmpdir(), `${socketName}.sock`);
  const requests = [];
  let status = 409;
  let body = { ok: false, error: {
    code: 'CONVERSATION_TASK_PROPOSAL_CONFLICT',
    message: 'Authorization: Bearer fixture-secret; /private/source; private user text',
    recommendedAction: 'overwrite the grant and replay', retryable: true,
  } };
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    request.resume();
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const broker = new TaskspaceBroker({
    projectRoot: os.tmpdir(), projectSlug: 'forge-base',
    conversationTaskSocket: socketPath, protectedCompletionSocket: socketPath,
  });
  await assert.rejects(broker.conversationTaskClient({ operation: 'prepare' }), (error) => {
    assert.equal(error.code, 'CONVERSATION_TASK_PROPOSAL_CONFLICT');
    assert.match(error.message, /本轮.*绑定.*不能.*覆盖/u);
    // prepare_task renders Error.message, so the repair step must reach that text.
    assert.match(error.message, /新一轮.*修订.*范围/u);
    assert.match(error.recommendedAction, /新一轮.*确认.*修订范围/u);
    assert.equal(error.retryable, false);
    assert.doesNotMatch(`${error.message} ${error.recommendedAction}`, /fixture-secret|private|overwrite|replay/u);
    return true;
  });
  assert.deepEqual(requests, ['/v1/conversation-task']);
  body = { ok: false, error: { code: 'CONVERSATION_TASK_SCOPE_DENIED', message: 'private source and token', retryable: true } };
  await assert.rejects(broker.conversationTaskClient({ operation: 'prepare' }), (error) => {
    assert.equal(error.code, 'CONVERSATION_TASK_SCOPE_DENIED');
    assert.match(error.message, /prepare_task inspect.*availableScopes/u);
    assert.match(error.message, /不能沿用上一任务的发布授权/u);
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /private source|token/u);
    return true;
  });
  await assert.rejects(broker.protectedCandidateBindingClient({}), { code: 'CANDIDATE_BINDING_UNAVAILABLE' });
  await assert.rejects(broker.protectedCompletionClient({}), { code: 'PROTECTED_COMPLETION_UNAVAILABLE' });
  body = { ok: false, error: { code: 'CONVERSATION_EXECUTION_AUTHORITY_UNAVAILABLE', retryable: true, message: 'private reason' } };
  await assert.rejects(broker.executionRenewalClient({}), (error) => {
    assert.equal(error.code, 'CONVERSATION_EXECUTION_AUTHORITY_UNAVAILABLE');
    assert.equal(error.retryable, true);
    assert.match(error.recommendedAction, /同一请求/u);
    assert.doesNotMatch(error.message, /private reason/u);
    return true;
  });
  body = { ok: false, error: { code: 'CONVERSATION_EXECUTION_RENEWAL_DENIED', retryable: true, message: 'private reason' } };
  await assert.rejects(broker.executionRenewalClient({}), (error) => {
    assert.equal(error.code, 'CONVERSATION_EXECUTION_RENEWAL_DENIED');
    assert.equal(error.retryable, false);
    return true;
  });
  body = { ok: false, error: { code: 'CONVERSATION_TASK_SOURCE_CHANGED', message: 'private source' } };
  await assert.rejects(broker.conversationTaskClient({}), (error) => {
    assert.equal(error.code, 'CONVERSATION_TASK_SOURCE_CHANGED');
    assert.equal(error.retryable, false);
    assert.doesNotMatch(`${error.message} ${error.recommendedAction}`, /private source/u);
    return true;
  });
  for (const invalid of [null, [], { code: 'bad\ncode' }, { code: 'X'.repeat(97) }, { code: { secret: true } }]) {
    body = { ok: false, error: invalid };
    await assert.rejects(broker.conversationTaskClient({}), { code: 'CONVERSATION_TASK_RESPONSE_INVALID' });
  }
  body = '{invalid private response';
  await assert.rejects(broker.conversationTaskClient({}), { code: 'CONVERSATION_TASK_RESPONSE_INVALID' });
  status = 200;
  body = { ok: true, result: { status: 'prepared', idempotent: true } };
  assert.deepEqual(await broker.conversationTaskClient({}), body.result);
});

test('standalone review Broker binds the authenticated task and never invokes release', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const calls = [];
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
    releaseClient: async () => { assert.fail('Review must never invoke release'); },
    verificationClient: async request => {
      calls.push(request);
      throw Object.assign(new Error('Current protected review is not ready'), { code: 'VERIFY_REVIEW_NOT_READY' });
    },
  });
  const request = { action: 'verify-review', acceptanceContractId: '1'.repeat(64) };
  await assert.rejects(broker.executeAuthenticated(task.token, request), { code: 'VERIFY_REVIEW_NOT_READY' });
  assert.deepEqual(calls, [{ action: 'semantic-review', taskId: task.taskId, acceptanceContractId: request.acceptanceContractId }]);
  await assert.rejects(broker.executeAuthenticated(task.token, { ...request, taskId: 'task-b' }));
  await assert.rejects(broker.executeAuthenticated('invalid-token', request));
  assert.equal(calls.length, 1);
});

test('Broker derives writer candidate binding from consumed protected state and rejects caller injection', async () => {
  const actorUserId = '11111111-1111-4111-8111-111111111111';
  const fixture = await createFixture([{
    taskId: 'writer-binding-task', actorId: 'actor-writer', actorUserId,
    conversationId: 'conversation-writer', token: 'w'.repeat(64), accessMode: 'conversation',
  }]);
  const task = fixture.tasks.get('writer-binding-task');
  const prompt = '实现供应商档案后端并验证租户权限。';
  const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
    type: 'client-request', rpcId: 'rpc:writer-binding:1', method: 'session.prompt',
    payload: { sessionId: 'session:writer-binding:1', mode: 'queue', content: [{ type: 'text', text: prompt }] },
  })), 'session.prompt');
  const taskAuthority = {
    actionCeiling: 'workspace-write',
    ownedPaths: ['forge-server/forge-business/forge-business-core/src'],
    taskProfiles: ['backend', 'security'],
  };
  const contract = compileForgeTaskExecutionContract({ prompt, ...taskAuthority });
  const authority = {
    projectSlug: 'forge-base', taskId: task.taskId, actorUserId, actorUsername: task.actorId,
    conversationId: task.conversationId, dshSessionId: classified.dshSessionId,
    route: classified.route, rpcId: classified.rpcId, promptDigest: classified.textDigest,
    sourceCommit: fixture.baseCommit, workspaceFingerprint: '1'.repeat(64), caseFamily: 'maintenance',
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174226',
    controllerGrantDigest: '3'.repeat(64), contractId: contract.contractId,
    actionCeiling: taskAuthority.actionCeiling, ownedPaths: taskAuthority.ownedPaths,
  };
  const prepared = await prepareProtectedExecutionContext({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', taskMetadata: task.metadata,
    request: {
      ...classified, actorUserId, actorUsername: task.actorId,
      conversationId: task.conversationId, requestId: 'request:writer-binding:0001',
    },
    policyPath: path.resolve('docker/harness/forge-execution-policy.json'),
    trustedPolicyInput: {
      profile: 'production-controller', sourceCommit: authority.sourceCommit,
      workspaceFingerprint: authority.workspaceFingerprint, caseFamily: authority.caseFamily,
      productionAuthorityId: authority.productionAuthorityId,
      productionAuthorityDigest: digestProductionTaskAuthorityBinding(authority),
      controllerGrantDigest: authority.controllerGrantDigest, expectedContractId: contract.contractId, taskAuthority,
    },
  });
  const calls = [];
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
    verificationClient: async (request) => { calls.push(request); return { ok: true }; },
  });
  const run = {
    action: 'verify-run', profile: 'backend-module-test',
    selectors: { modules: ['forge-server/forge-business/forge-business-core'] },
    idempotencyKey: 'writer-binding-backend', admissionId: '12345678-1234-1234-1234-123456789abc',
  };
  assert.deepEqual(prepared.requiredProfiles, contract.requiredVerificationProfiles);
  assert.equal(prepared.requiredProfiles.includes('backend-red-test'), false);
  assert.deepEqual(contract.requiredRedProfiles, ['backend-red-test']);
  await assert.rejects(broker.executeAuthenticated(task.token, run), /consumed/u);
  await broker.executeAuthenticated(task.token, {
    action: 'execution-context', projectSlug: 'forge-base', taskId: task.taskId,
    conversationId: task.conversationId, actorUserId, dshSessionId: classified.dshSessionId,
    rpcId: classified.rpcId, textDigest: classified.textDigest,
  });
  await assert.rejects(broker.executeAuthenticated(task.token, {
    ...run, candidateBinding: { rpcId: 'forged-rpc' },
  }), /unsupported field/u);
  assert.equal(calls.length, 0);
  const admissionProfiles = [
    'governance', 'backend-red-test', 'backend-module-test', 'changed-safe', 'full-regression',
  ];
  await broker.executeAuthenticated(task.token, {
    action: 'verify-admit', profiles: admissionProfiles,
  });
  await broker.executeAuthenticated(task.token, run);
  assert.deepEqual(calls[1].candidateBinding, {
    projectSlug: 'forge-base', taskId: task.taskId, actorUserId, actorUsername: task.actorId,
    conversationId: task.conversationId, dshSessionId: classified.dshSessionId,
    executionId: prepared.executionId, generation: prepared.generation, rpcId: classified.rpcId,
    contractId: contract.contractId, authorityClass: 'production-task-writer', actionCeiling: 'workspace-write',
    sourceCommit: authority.sourceCommit, authorityWorkspaceFingerprint: authority.workspaceFingerprint,
    productionAuthorityId: prepared.productionAuthorityId,
    productionAuthorityDigest: prepared.productionAuthorityDigest, controllerGrantDigest: authority.controllerGrantDigest,
  });
  assert.equal(calls[1].acceptanceContractId, contract.contractId);
  await broker.executeAuthenticated(task.token, {
    action: 'verify-run', profile: 'backend-red-test',
    selectors: {
      modules: ['forge-server/forge-business/forge-business-core'],
      tests: ['SupplierArchiveControllerRouteContractTest'],
    },
    idempotencyKey: 'writer-binding-backend-red',
    admissionId: '12345678-1234-1234-1234-123456789abc',
  });
  assert.equal(calls[2].profile, 'backend-red-test');
  assert.deepEqual(calls[2].selectors, {
    modules: ['forge-server/forge-business/forge-business-core'],
    tests: ['SupplierArchiveControllerRouteContractTest'],
  });
  await assert.rejects(broker.executeAuthenticated(task.token, {
    action: 'verify-run', profile: 'frontend-admin-build',
    selectors: {},
    idempotencyKey: 'writer-binding-unrelated-frontend',
    admissionId: '12345678-1234-1234-1234-123456789abc',
  }), (error) => error.code === 'CANDIDATE_VALIDATION_PROFILE_DENIED');
  assert.equal(calls.length, 3);
  await broker.executeAuthenticated(task.token, { ...run, profile: 'full-regression', selectors: {},
    executionMode: 'background', idempotencyKey: 'writer-background-regression' });
  assert.equal(calls.at(-1).executionMode, 'background');
  assert.deepEqual(calls.at(-1).candidateBinding, calls[1].candidateBinding);
  assert.equal(calls.at(-1).acceptanceContractId, contract.contractId);
  await broker.executeAuthenticated(task.token, { action: 'verify-status', jobId: run.admissionId, waitSeconds: 60 });
  assert.deepEqual(calls.at(-1), { taskId: task.taskId, action: 'status', jobId: run.admissionId, waitSeconds: 60 });
  await broker.executeAuthenticated(task.token, { ...run, profile: 'backend-test-class',
    selectors: { modules: run.selectors.modules, tests: ['SupplierArchiveControllerRouteContractTest'] },
    executionMode: 'background', idempotencyKey: 'writer-focused-backend' });
  assert.equal(calls.at(-1).profile, 'backend-test-class');
  assert.deepEqual(calls.at(-1).candidateBinding, calls[1].candidateBinding);
  assert.equal(calls.at(-1).acceptanceContractId, contract.contractId);
  assert.equal(contract.requiredVerificationProfiles.includes('backend-test-class'), false);
  await broker.executeAuthenticated(task.token, { ...run, profile: 'backend-module-compile',
    idempotencyKey: 'writer-binding-backend-compile' });
  assert.equal(calls.at(-1).profile, 'backend-module-compile');
  assert.deepEqual(calls.at(-1).selectors, run.selectors);
  assert.deepEqual(calls.at(-1).candidateBinding, calls[1].candidateBinding);
  assert.equal(calls.at(-1).acceptanceContractId, contract.contractId);
  assert.equal(contract.requiredVerificationProfiles.includes('backend-module-compile'), false);
});

async function git(cwd, ...args) {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.stdout.trim();
}

async function commit(cwd, message) {
  await git(cwd, 'add', '--all');
  await git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

async function createFixture(taskDefinitions = [
  { taskId: 'task-a', actorId: 'actor-a', conversationId: 'conversation-a', token: 'a'.repeat(64) },
  { taskId: 'task-b', actorId: 'actor-b', conversationId: 'conversation-b', token: 'b'.repeat(64) },
], temporaryPrefix = 'forge-taskspace-broker-') {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), temporaryPrefix));
  const workspaceRoot = path.join(projectRoot, 'workspace');
  const taskspacesRoot = path.join(projectRoot, 'taskspaces');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(taskspacesRoot, { recursive: true });
  await mkdir(path.join(projectRoot, 'verification'), { recursive: true });
  await writeFile(path.join(projectRoot, 'verification', 'contract.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectSlug: 'forge-base',
    runnerRevision: 'test-runner-v1',
    toolchainImage: `test.invalid/forge@sha256:${'f'.repeat(64)}`,
    cacheRoot: path.join(projectRoot, 'verification', 'cache'),
    stateRoot: path.join(projectRoot, 'verification', 'state'),
    profiles: [...(await import('../docker/harness/verify-policy.mjs')).VERIFY_PROFILE_NAMES],
    limits: VERIFICATION_LIMITS,
  }, null, 2)}\n`);
  await git(workspaceRoot, 'init');
  await git(workspaceRoot, 'config', 'core.autocrlf', 'false');
  await git(workspaceRoot, 'config', 'user.name', 'Forge Test');
  await git(workspaceRoot, 'config', 'user.email', 'forge-test@example.invalid');
  await mkdir(path.join(workspaceRoot, 'forge-admin-ui', 'src'), { recursive: true });
  await writeFile(path.join(workspaceRoot, 'shared.txt'), 'base\n');
  await writeFile(path.join(workspaceRoot, 'forge-admin-ui', 'src', 'shared.ts'), 'export const side = "base";\n');
  await writeFile(path.join(workspaceRoot, 'migration.sql'), '-- base\n');
  const baseCommit = await commit(workspaceRoot, 'base');
  const createdAt = new Date().toISOString();
  const tasks = new Map();
  let port = 21000;
  for (const definition of taskDefinitions) {
    const taskRoot = path.join(taskspacesRoot, definition.taskId);
    const taskWorkspace = path.join(taskRoot, 'workspace');
    await mkdir(taskRoot, { recursive: true });
    await execFileAsync('git', ['-c', 'core.autocrlf=false', 'clone', '--no-hardlinks', workspaceRoot, taskWorkspace], { encoding: 'utf8' });
    await git(taskWorkspace, 'config', 'core.autocrlf', 'false');
    await git(taskWorkspace, 'config', 'user.name', definition.actorId);
    await git(taskWorkspace, 'config', 'user.email', `${definition.actorId}@example.invalid`);
    await git(taskWorkspace, 'checkout', '-b', `task/${definition.actorId}/${definition.taskId}`, baseCommit);
    const metadata = {
      schemaVersion: definition.actorUserId === undefined ? 1 : 2,
      projectSlug: 'forge-base',
      taskId: definition.taskId,
      actorId: definition.actorId,
      ...(definition.actorUserId === undefined ? {} : { actorUserId: definition.actorUserId }),
      conversationId: definition.conversationId,
      branch: `task/${definition.actorId}/${definition.taskId}`,
      baseCommit,
      status: 'active',
      createdAt,
      updatedAt: createdAt,
      accessTokenHash: hashTaskspaceToken(definition.token),
      harnessPort: port++,
      ...(definition.accessMode === undefined ? {} : { accessMode: definition.accessMode }),
    };
    await writeFile(path.join(taskRoot, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    tasks.set(definition.taskId, { ...definition, root: taskRoot, workspace: taskWorkspace, metadata });
  }
  return { projectRoot, workspaceRoot, taskspacesRoot, baseCommit, tasks };
}

async function writeHostInventoryContract(fixture, overrides = {}) {
  const containerContract = JSON.parse(await readFile(path.join(fixture.projectRoot, 'verification', 'contract.json'), 'utf8'));
  const contractPath = path.join(fixture.projectRoot, 'verification', 'host-contract.json');
  await writeFile(contractPath, `${JSON.stringify({
    schemaVersion: 2,
    executionMode: 'host-toolchain',
    projectSlug: 'forge-base',
    runnerRevision: 'forge-host-runner-test',
    profileCatalogVersion: '2026.09.03.6',
    taskspacesRoot: fixture.taskspacesRoot,
    stateRoot: path.join(fixture.projectRoot, 'verification', 'host-state'),
    toolchains: {
      java: process.execPath,
      javaHome: path.dirname(process.execPath),
      maven: process.execPath,
      node: process.execPath,
      pnpm: process.execPath,
      git: process.execPath,
      forgeGovernance: process.execPath,
    },
    profiles: containerContract.profiles,
    limits: { ...containerContract.limits, maxConcurrent: 2 },
    ...overrides,
  }, null, 2)}\n`);
  return contractPath;
}

async function authorizeProductionAction(fixture, task, {
  actionCeiling = 'release', ownedPaths = ['forge-admin-ui/src'], now = Date.now(), promptText, developmentMode,
} = {}) {
  task.metadata = JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8'));
  const actorUserId = task.metadata.actorUserId ?? `11111111-1111-4111-8111-${task.taskId === 'task-b' ? '222222222222' : '111111111111'}`;
  task.metadata = {
    ...task.metadata, schemaVersion: 2, actorUserId, accessMode: 'conversation',
  };
  await writeFile(path.join(task.root, 'metadata.json'), `${JSON.stringify(task.metadata, null, 2)}\n`);
  const sourceCommit = await git(task.workspace, 'rev-parse', 'HEAD');
  const source = await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS);
  const prompt = actionCeiling === 'release' ? '发布当前已验证候选。' : '提交当前精确改动。';
  const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({
    type: 'client-request', rpcId: `rpc:${task.taskId}:${actionCeiling}:${now}`,
    method: 'session.prompt',
    payload: {
      sessionId: `session:${task.taskId}:${actionCeiling}`,
      mode: 'queue', content: [{ type: 'text', text: promptText ?? prompt }],
    },
  })), 'session.prompt');
  const taskAuthority = { actionCeiling, ownedPaths, taskProfiles: developmentMode === 'direct' ? ['project-files'] : ['requirements'] };
  const contract = compileForgeTaskExecutionContract({ prompt: promptText ?? prompt, ...taskAuthority },
    developmentMode === 'direct' ? { developmentMode } : {});
  if (developmentMode === 'direct') taskAuthority.contract = contract;
  const authority = {
    projectSlug: 'forge-base', taskId: task.taskId, actorUserId,
    actorUsername: task.actorId, conversationId: task.conversationId,
    dshSessionId: classified.dshSessionId, route: classified.route, rpcId: classified.rpcId,
    promptDigest: classified.textDigest, sourceCommit,
    workspaceFingerprint: source.workspaceFingerprint, caseFamily: 'maintenance',
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174226',
    controllerGrantDigest: '3'.repeat(64), contractId: contract.contractId,
    actionCeiling, ownedPaths,
  };
  const context = await prepareProtectedExecutionContext({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', taskMetadata: task.metadata,
    request: {
      ...classified, actorUserId, actorUsername: task.actorId,
      conversationId: task.conversationId, requestId: `request:${task.taskId}:${actionCeiling}:${now}`,
    },
    now,
    policyPath: path.resolve('docker/harness/forge-execution-policy.json'),
    trustedPolicyInput: {
      profile: 'production-controller', sourceCommit, workspaceFingerprint: source.workspaceFingerprint,
      caseFamily: authority.caseFamily, productionAuthorityId: authority.productionAuthorityId,
      productionAuthorityDigest: digestProductionTaskAuthorityBinding(authority),
      controllerGrantDigest: authority.controllerGrantDigest,
      expectedContractId: contract.contractId, taskAuthority,
    },
  });
  await readProtectedExecutionContext({
    projectRoot: fixture.projectRoot, taskMetadata: task.metadata, now: now + 1,
    lookup: {
      projectSlug: 'forge-base', taskId: task.taskId, conversationId: task.conversationId,
      actorUserId, dshSessionId: classified.dshSessionId, rpcId: classified.rpcId,
      textDigest: classified.textDigest,
    },
  });
  const ledgerPayload = {
    schemaVersion: 1, summaryType: 'forge-obligation-ledger-summary/v1',
    taskContractId: contract.contractId, sourceFingerprint: source.workspaceFingerprint,
    generation: 1, ledgerDigest: '4'.repeat(64),
    counts: { total: 0, open: 0, closed: 0, stale: 0 },
    open: [], closed: [], stale: [],
  };
  const ledgerSummary = { ...ledgerPayload, summaryDigest: canonicalSha256(ledgerPayload) };
  const projectionPayload = {
    schemaVersion: 1, gateType: 'forge-protected-completion-gate/v1',
    evaluationMode: 'read-only-verifier', ledgerDigest: ledgerSummary.ledgerDigest,
    ledgerSummaryDigest: ledgerSummary.summaryDigest,
    sourceFingerprint: `sha256:${source.workspaceFingerprint}`,
    candidateDiffSha256: `sha256:${'5'.repeat(64)}`,
    evaluatedAt: new Date(now + 2).toISOString(), signedVerdictVerified: true,
    outcome: 'READY', maximumTerminalOutcome: 'COMPLETE', cannotClaim: [], blockers: [],
    ledgerSummary, attestation: 'local-integrity-only; upstream-authentication-is-ed25519',
  };
  const projection = { ...projectionPayload, gateDigest: canonicalSha256(projectionPayload) };
  return {
    context, source, projection,
    protectedCompletionClient: async ({ taskId }) => {
      assert.equal(taskId, task.taskId);
      return projection;
    },
  };
}

async function integrateStartRequest(fixture, task, authorization, paths) {
  return {
    action: 'integrate',
    mode: 'start',
    expectedHead: await git(task.workspace, 'rev-parse', 'HEAD'),
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
    canonicalHead: await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'),
    paths,
  };
}

async function attachLocalPrivateRemote(fixture) {
  const remoteRoot = path.join(fixture.projectRoot, 'private-remote.git');
  const branch = await git(fixture.workspaceRoot, 'branch', '--show-current');
  await execFileAsync('git', ['init', '--bare', remoteRoot], { encoding: 'utf8' });
  await git(fixture.workspaceRoot, 'remote', 'add', 'origin', remoteRoot);
  await git(fixture.workspaceRoot, 'push', 'origin', `${fixture.baseCommit}:refs/heads/${branch}`);
  return { remoteRoot, branch };
}

test('conversation-owned TaskSpace metadata remains a valid Broker authentication source', async () => {
  const fixture = await createFixture([
    {
      taskId: 'conversation-task',
      actorId: 'actor-a',
      conversationId: 'conversation-a',
      token: 'c'.repeat(64),
      accessMode: 'conversation',
    },
  ]);
  const task = fixture.tasks.get('conversation-task');
  const stub = releaseStub();
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: stub.client,
  });

  const contract = await broker.executeAuthenticated(task.token, { action: 'contract' });

  assert.equal(contract.task.taskId, task.taskId);
  assert.equal(contract.task.actorId, task.actorId);
  assert.equal(contract.task.accessMode, 'conversation');
  assert.equal(contract.runnerContract.projectSlug, 'forge-base');
});

test('Broker returns only the current token-authenticated protected execution context', async () => {
  const actorUserId = '11111111-1111-4111-8111-111111111111';
  const fixture = await createFixture([{
    taskId: 'protected-task',
    actorId: 'actor-a',
    actorUserId,
    conversationId: 'conversation-a',
    token: 'p'.repeat(64),
    accessMode: 'conversation',
  }]);
  const task = fixture.tasks.get('protected-task');
  const body = Buffer.from(JSON.stringify({
    type: 'client-request',
    rpcId: 'rpc:protected:1',
    method: 'session.prompt',
    payload: {
      sessionId: 'session:protected:1',
      mode: 'queue',
      content: [{ type: 'text', text: '只读分析当前模块' }],
    },
  }));
  const classified = classifyPinnedDshPromptBody(body, 'session.prompt');
  const prepared = await prepareProtectedExecutionContext({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    taskMetadata: task.metadata,
    request: {
      ...classified,
      actorUserId,
      actorUsername: 'actor-a',
      conversationId: 'conversation-a',
      requestId: 'request:protected:0001',
    },
  });
  const verificationCalls = [];
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: releaseStub().client,
    verificationClient: async (request) => { verificationCalls.push(request); return { ok: true }; },
  });
  const lookup = {
    action: 'execution-context',
    projectSlug: 'forge-base',
    taskId: 'protected-task',
    conversationId: 'conversation-a',
    actorUserId,
    dshSessionId: classified.dshSessionId,
    rpcId: classified.rpcId,
    textDigest: classified.textDigest,
  };

  const context = await broker.executeAuthenticated(task.token, lookup);
  assert.equal(context.executionId, prepared.executionId);
  assert.equal(context.generation, 1);
  assert.equal(context.actionCeiling, 'read-only');
  assert.deepEqual(context.ownedPaths, []);
  await broker.executeAuthenticated(task.token, {
    action: 'verify-run', profile: 'governance', selectors: {},
    idempotencyKey: 'protected-verification-0001',
    admissionId: '12345678-1234-1234-1234-123456789abc',
  });
  assert.equal(verificationCalls[0].acceptanceContractId, prepared.contractId);
  assert.equal(Object.hasOwn(verificationCalls[0], 'candidateBinding'), false);
  await assert.rejects(
    broker.executeAuthenticated(task.token, { ...lookup, rpcId: 'rpc:protected:stale' }),
    (error) => error.code === 'EXECUTION_CONTEXT_MISMATCH',
  );
  await assert.rejects(
    broker.executeAuthenticated('wrong-token-value-that-is-long-enough', lookup),
    /token/u,
  );
});

test('business data preview: Broker authenticates current task and denies unapproved batch data intent', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const promptText = '历史消息里有 OK。现在请求批量改两条数据，请先展示精确拟修改预览。';
  const prepared = await authorizeProductionAction(fixture, task, { actionCeiling: 'workspace-write', promptText });
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client });
  const context = prepared.context;
  const request = { action: 'business-data-preview', operation: 'request',
    lookup: Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest'].map(key => [key, context[key]])),
    expectedExecutionId: context.executionId, expectedGeneration: context.generation, promptText, callId: 'preview:one',
    proposal: { action: 'eq-repair-ledger-batch-edit', scope: { tenantId: '9201', purpose: 'coverage-preview', maximumObjects: 2 },
      objects: ['9231', '9291'].map(objectId => ({ objectType: 'EqRepairLedger', objectId,
        changes: [{ field: 'acceptanceNo', before: 'declared-before', after: 'proposed-after' }] })) },
  };
  const before = await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS);
  const result = await broker.executeAuthenticated(task.token, request);
  assert.equal(result.gate.reasonCode, 'APPROVAL_REQUIRED');
  assert.equal(result.writerAuthorized, false);
  assert.equal(result.databaseVerified, false);
  assert.equal(result.snapshotSource, 'caller-proposed/unverified');
  assert.deepEqual(result.objects.map(item => item.objectId), ['9231', '9291']);
  assert.equal(result.request.actor.actorUserId, task.metadata.actorUserId);
  assert.equal(result.binding.callId, request.callId);
  assert.equal((await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS)).workspaceFingerprint, before.workspaceFingerprint);
  await assert.rejects(broker.executeAuthenticated(fixture.tasks.get('task-b').token, request));
  await assert.rejects(broker.executeAuthenticated(task.token, { ...request, operation: 'apply' }));
  await assert.rejects(broker.executeAuthenticated(task.token, { ...request, attestation: 'OK' }));
  await assert.rejects(broker.executeAuthenticated(task.token, { ...request, promptText: 'OK' }), { code: 'DATA_PREVIEW_CONTEXT_MISMATCH' });
  await writeFile(path.join(task.workspace, 'shared.txt'), 'changed after protected context\n');
  await assert.rejects(broker.executeAuthenticated(task.token, request), { code: 'DATA_PREVIEW_SOURCE_CHANGED' });
});

test('business data apply: Broker binds a source-read-only execution and live source before its fixed consumer', async () => {
  const fixture = await createFixture(); const task = fixture.tasks.get('task-a');
  const promptText = '请按已签发审批，把指定维修台账的备注修改为“已核对”。取消本次未消费审批。不要修改源码。';
  task.metadata = { ...task.metadata, schemaVersion: 2, actorUserId: '11111111-1111-4111-8111-111111111111', accessMode: 'conversation' };
  await writeFile(path.join(task.root, 'metadata.json'), `${JSON.stringify(task.metadata, null, 2)}\n`);
  const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'rpc:data-read-only:1', method: 'session.prompt',
    payload: { sessionId: 'session:data-read-only:1', mode: 'queue', content: [{ type: 'text', text: promptText }] } })), 'session.prompt');
  const context = await prepareProtectedExecutionContext({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', taskMetadata: task.metadata,
    request: { ...classified, actorUserId: task.metadata.actorUserId, actorUsername: task.actorId, conversationId: task.conversationId, requestId: 'request:data-read-only:0001' } });
  const currentLookup = Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest'].map(key => [key, context[key]]));
  await readProtectedExecutionContext({ projectRoot: fixture.projectRoot, taskMetadata: task.metadata, lookup: currentLookup });
  assert.equal(context.authorityClass, 'production-read-only'); assert.equal(context.actionCeiling, 'read-only');
  assert.deepEqual(context.ownedPaths, []); assert.equal(context.sourceCommit, null); assert.equal(context.workspaceFingerprint, null);
  const source = { head: await git(task.workspace, 'rev-parse', 'HEAD'), fingerprint: (await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS)).workspaceFingerprint };
  const { privateKey } = generateKeyPairSync('ed25519');
  const proposal = { action: 'eq-repair-ledger-note-update', scope: { tenantId: '9201', purpose: 'exact-note-correction', maximumObjects: 1 },
    objects: [{ objectType: 'eq-repair-ledger', objectId: '9231', changes: [{ field: 'remark', before: 'before', after: 'after' }] }] };
  const preview = await createForgeBusinessDataDeniedPreview(proposal, { requestId: randomUUID(), projectSlug: context.projectSlug,
    actorUserId: context.actorUserId, source: { head: source.head, fingerprint: `sha256:${source.fingerprint}` },
    binding: { taskId: context.taskId, conversationId: context.conversationId, dshSessionId: context.dshSessionId, rpcId: context.rpcId,
      textDigest: context.textDigest, executionId: context.executionId, generation: context.generation, callId: 'data-preview' },
    requestedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: context.expiresAt });
  const attestation = issueForgeBusinessDataApprovalAttestation({ request: preview.request, approvalId: randomUUID(), expiresAt: context.expiresAt },
    { issuer: { subjectId: 'protected-data-approver', keyId: 'data-key', role: 'business-data-approver' }, privateKey, observedAt: new Date().toISOString() });
  const body = { action: 'business-data-apply', operation: 'apply', request: preview.request, attestation, proposal,
    lookup: currentLookup,
    expectedExecutionId: context.executionId, expectedGeneration: context.generation, promptText, callId: 'data-apply' };
  let forwarded = 0;
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
    businessDataConsumer: async input => {
      forwarded++; const { request, attestation, operation, executionBinding } = input;
      assert.equal(executionBinding.taskId, task.taskId); assert.equal(executionBinding.callId, body.callId);
      return { schemaVersion: 1, receiptType: 'forge-business-data/consumption', receiptId: randomUUID(), operation,
        status: operation === 'apply' ? 'applied' : 'cancelled', requestId: request.requestId, requestDigest: request.requestDigest,
        approvalId: attestation.approvalId, consumptionKey: canonicalSha256({ approvalId: attestation.approvalId, requestDigest: request.requestDigest, actor: request.actor, source: request.source }),
        executionBindingDigest: canonicalSha256(executionBinding), projectSlug: request.projectSlug, tenantId: request.scope.tenantId,
        actorUserId: request.actor.actorUserId, objects: request.objects, mutationCount: operation === 'apply' ? 1 : 0,
        auditCount: operation === 'apply' ? 1 : 0, committedAt: new Date().toISOString() };
    } });
  assert.equal((await broker.executeAuthenticated(task.token, body)).status, 'applied');
  assert.equal((await broker.executeAuthenticated(task.token, { ...body, operation: 'cancel' })).status, 'cancelled');
  await assert.rejects(broker.executeAuthenticated(fixture.tasks.get('task-b').token, body));
  await assert.rejects(broker.executeAuthenticated(task.token, { ...body, target: 'http://other/' }));
  assert.equal(forwarded, 2);
  await writeFile(path.join(task.workspace, 'shared.txt'), 'changed after approved source\n');
  await assert.rejects(broker.executeAuthenticated(task.token, body), { code: 'DATA_APPLY_SOURCE_CHANGED' });
  assert.equal(forwarded, 2);
});

test('writer scope Broker binds current authority across clones and settles old permits during maintenance', async () => {
  const fixture = await createFixture();
  const a = fixture.tasks.get('task-a');
  const b = fixture.tasks.get('task-b');
  const originalA = await authorizeProductionAction(fixture, a, { actionCeiling: 'workspace-write' });
  const originalB = await authorizeProductionAction(fixture, b, { actionCeiling: 'workspace-write' });
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client });
  const request = (context, callId) => ({
    action: 'writer-scope-lease', operation: 'acquire',
    ...Object.fromEntries(['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId',
      'rpcId', 'textDigest', 'executionId', 'generation', 'contractId'].map((key) => [key, context[key]])),
    callId, toolName: 'write', filePath: 'forge-admin-ui/src/shared.ts',
  });
  const oldA = request(originalA.context, 'call:a:1');
  const pendingB = request(originalB.context, 'call:b:1');
  const acquired = await broker.executeAuthenticated(a.token, oldA);
  assert.equal(acquired.status, 'acquired');
  await assert.rejects(broker.executeAuthenticated(b.token, oldA), { code: 'WRITER_SCOPE_IDENTITY_MISMATCH' });
  await assert.rejects(broker.executeAuthenticated(b.token, pendingB), { code: 'PATH_RESOURCE_CONFLICT' });
  await assert.rejects(broker.executeAuthenticated(a.token, { ...oldA, callId: 'outside', filePath: 'shared.txt' }), { code: 'WRITER_SCOPE_PATH_DENIED' });
  await assert.rejects(broker.executeAuthenticated(a.token, { ...oldA, ownedPaths: ['shared.txt'] }), /unsupported field/u);
  await assert.rejects(broker.executeAuthenticated(a.token, { ...oldA, filePath: '../shared.txt' }), /traversal/u);
  await assert.rejects(broker.executeAuthenticated(a.token, { ...oldA, rpcId: undefined }), /rpcId/u);
  const currentA = await authorizeProductionAction(fixture, a, { actionCeiling: 'workspace-write' });
  assert.ok(currentA.context.generation > originalA.context.generation);
  await assert.rejects(broker.executeAuthenticated(a.token, { ...oldA, callId: 'stale-a' }), { code: 'EXECUTION_CONTEXT_MISMATCH' });
  const maintenance = path.join(fixture.taskspacesRoot, '.broker', 'maintenance.json');
  await writeFile(maintenance, JSON.stringify({ schemaVersion: 1, operationId: 'writer-test-maintenance', startedAt: new Date().toISOString() }));
  await assert.rejects(broker.executeAuthenticated(b.token, pendingB), { code: 'TASKSPACE_PLATFORM_MAINTENANCE' });
  const settled = await broker.executeAuthenticated(a.token, { ...oldA, operation: 'settle', permitId: acquired.permitId });
  assert.equal(settled.status, 'settled');
  const cancelledRequest = { ...request(currentA.context, 'cancelled-before-arrival'), operation: 'cancel-acquire',
    permitId: 'a0377f7a-17c1-401d-8d2e-6524acfa86c4' };
  await assert.rejects(broker.executeAuthenticated(b.token, cancelledRequest), { code: 'WRITER_SCOPE_IDENTITY_MISMATCH' });
  assert.equal((await broker.executeAuthenticated(a.token, cancelledRequest)).status, 'acquisition-cancelled');
  await unlink(maintenance);
  await assert.rejects(broker.executeAuthenticated(a.token, { ...cancelledRequest, operation: 'acquire' }),
    { code: 'WRITER_SCOPE_CALL_REPLAY' });
  const peer = await broker.executeAuthenticated(b.token, pendingB);
  assert.equal(peer.status, 'acquired');
  await broker.executeAuthenticated(b.token, { ...pendingB, operation: 'settle', permitId: peer.permitId });
  const registry = JSON.parse(await readFile(path.join(fixture.taskspacesRoot, '.broker', 'writer-scope-leases.json'), 'utf8'));
  assert.equal(registry.active.length, 0);
  assert.equal(registry.settled.length, 2, 'new-generation cancellation prunes only the old settled owner call');
});

test('Broker keeps an expired generation lease invalid while forwarding a Runner admission for candidate validation', async () => {
  const actorUserId = '22222222-2222-4222-8222-222222222222';
  const fixture = await createFixture([{
    taskId: 'candidate-validation-task',
    actorId: 'actor-candidate',
    actorUserId,
    conversationId: 'conversation-candidate',
    token: 'v'.repeat(64),
    accessMode: 'conversation',
  }]);
  const task = fixture.tasks.get('candidate-validation-task');
  const body = Buffer.from(JSON.stringify({
    type: 'client-request',
    rpcId: 'rpc:candidate:1',
    method: 'session.prompt',
    payload: {
      sessionId: 'session:candidate:1',
      mode: 'queue',
      content: [{ type: 'text', text: '只读验证已封存候选' }],
    },
  }));
  const classified = classifyPinnedDshPromptBody(body, 'session.prompt');
  const preparedAt = Date.now() - EXECUTION_CONTEXT_TTL_MS - 60_000;
  const prepared = await prepareProtectedExecutionContext({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    taskMetadata: task.metadata,
    request: {
      ...classified,
      actorUserId,
      actorUsername: task.actorId,
      conversationId: task.conversationId,
      requestId: 'request:candidate:0001',
    },
    now: preparedAt,
  });
  const lookup = {
    action: 'execution-context',
    projectSlug: 'forge-base',
    taskId: task.taskId,
    conversationId: task.conversationId,
    actorUserId,
    dshSessionId: classified.dshSessionId,
    rpcId: classified.rpcId,
    textDigest: classified.textDigest,
  };
  const admissionId = '23456789-2345-4234-8234-23456789abcd';
  const earlyVerificationCalls = [];
  const preConsumptionBroker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: releaseStub().client,
    verificationClient: async (request) => { earlyVerificationCalls.push(request); return {}; },
  });
  await assert.rejects(
    preConsumptionBroker.executeAuthenticated(task.token, {
      action: 'verify-run', profile: 'governance', selectors: {},
      idempotencyKey: 'candidate-validation-0001', admissionId,
    }),
    (error) => error.code === 'CANDIDATE_VALIDATION_NOT_READY',
  );
  assert.deepEqual(earlyVerificationCalls, []);
  await readProtectedExecutionContext({
    projectRoot: fixture.projectRoot,
    taskMetadata: task.metadata,
    lookup,
    now: preparedAt + 1_000,
  });
  const runnerReceipt = {
    receiptType: 'forge-verify/run',
    projectSlug: 'forge-base',
    taskId: task.taskId,
    source: {
      head: fixture.baseCommit,
      workspaceFingerprint: '1'.repeat(64),
      snapshotSha256: '1'.repeat(64),
    },
    request: {
      profile: 'governance',
      selectors: {},
      admissionId,
      idempotencyDigest: '2'.repeat(64),
    },
    runner: { revision: 'runner-v35' },
    cache: { packDigest: '3'.repeat(64) },
    toolchain: { digest: '4'.repeat(64) },
  };
  const verificationCalls = [];
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: releaseStub().client,
    verificationClient: async (request) => {
      verificationCalls.push(request);
      return runnerReceipt;
    },
  });

  await assert.rejects(
    broker.executeAuthenticated(task.token, lookup),
    (error) => error.code === 'EXECUTION_CONTEXT_EXPIRED',
  );
  await assert.rejects(
    broker.executeAuthenticated(task.token, {
      action: 'verify-run',
      profile: 'backend-module-test',
      selectors: { modules: ['forge-server/forge-common'] },
      idempotencyKey: 'candidate-validation-outside-contract',
      admissionId,
    }),
    (error) => error.code === 'CANDIDATE_VALIDATION_PROFILE_DENIED',
  );
  assert.deepEqual(verificationCalls, []);
  await assert.rejects(
    broker.executeAuthenticated(task.token, {
      action: 'verify-run',
      profile: 'governance',
      selectors: {},
      idempotencyKey: 'candidate-validation-contract-injection',
      admissionId,
      acceptanceContractId: '0'.repeat(64),
    }),
    /unsupported field/u,
  );
  const statePath = path.join(
    fixture.taskspacesRoot,
    '.broker',
    'executions',
    `${task.taskId}.json`,
  );
  const originalStateBytes = await readFile(statePath);
  const mismatchCases = [
    ['project', (state) => { state.current.projectSlug = 'other-project'; }, 'EXECUTION_CONTEXT_MISMATCH'],
    ['task', (state) => { state.current.taskId = 'other-task'; }, 'EXECUTION_CONTEXT_MISMATCH'],
    ['actor', (state) => { state.current.actorUserId = '33333333-3333-4333-8333-333333333333'; }, 'EXECUTION_CONTEXT_MISMATCH'],
    ['conversation', (state) => { state.current.conversationId = 'other-conversation'; }, 'EXECUTION_CONTEXT_MISMATCH'],
    ['contract', (state) => { state.current.contractId = '0'.repeat(64); }, 'EXECUTION_CONTEXT_INVALID'],
    ['state', (state) => { state.revision = 0; }, 'EXECUTION_STATE_INVALID'],
  ];
  for (const [label, mutate, expectedCode] of mismatchCases) {
    const tampered = JSON.parse(originalStateBytes.toString('utf8'));
    mutate(tampered);
    try {
      await writeFile(statePath, `${JSON.stringify(tampered, null, 2)}\n`);
      await assert.rejects(
        broker.executeAuthenticated(task.token, {
          action: 'verify-run', profile: 'governance', selectors: {},
          idempotencyKey: `candidate-validation-${label}-mismatch`, admissionId,
        }),
        (error) => error.code === expectedCode,
      );
    } finally {
      await writeFile(statePath, originalStateBytes);
    }
  }
  assert.deepEqual(verificationCalls, []);
  const receipt = await broker.executeAuthenticated(task.token, {
    action: 'verify-run',
    profile: 'governance',
    selectors: {},
    idempotencyKey: 'candidate-validation-0001',
    admissionId,
  });

  assert.deepEqual(verificationCalls, [{
    taskId: task.taskId,
    acceptanceContractId: prepared.contractId,
    action: 'run',
    profile: 'governance',
    selectors: {},
    idempotencyKey: 'candidate-validation-0001',
    admissionId,
  }]);
  assert.equal(verificationCalls.some((request) => request.action === 'admit'), false);
  assert.deepEqual(receipt, runnerReceipt);
});

test('integration Git metadata permission drift is exposed as an operator-owned platform fault', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: releaseStub().client,
  });
  const command = broker.command;
  broker.command = async (executable, args, options) => {
    if (executable === 'git' && path.resolve(args[1]) === path.resolve(fixture.workspaceRoot)) {
      const error = new Error('git failed with exit code 128.');
      error.code = 'COMMAND_FAILED';
      error.errorOutput = 'fatal: .git/index: index file open failed: Permission denied';
      throw error;
    }
    return command(executable, args, options);
  };

  const readiness = await broker.integrationReadiness();
  assert.equal(readiness.ok, false);
  assert.equal(readiness.error.code, 'TASKSPACE_INTEGRATION_GIT_METADATA_UNREADABLE');
  assert.match(readiness.error.recommendedAction, /platform operator/i);
  await assert.rejects(
    broker.executeAuthenticated(task.token, { action: 'preflight' }),
    (error) => error.code === 'TASKSPACE_INTEGRATION_GIT_METADATA_UNREADABLE'
      && /integration repository Git metadata/i.test(error.message),
  );
});

test('Broker readiness checks do not take optional Git index locks', async () => {
  const fixture = await createFixture();
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: releaseStub().client,
  });
  const command = broker.command;
  const readEnvironments = [];
  broker.command = async (executable, args, options) => {
    if (executable === 'git' && ['rev-parse', 'status'].includes(args[2])) {
      readEnvironments.push(options?.env ?? {});
    }
    return command(executable, args, options);
  };

  const readiness = await broker.integrationReadiness();

  assert.equal(readiness.ok, true);
  assert.equal(readEnvironments.length, 2);
  assert.ok(readEnvironments.every((environment) => environment.GIT_OPTIONAL_LOCKS === '0'));
});

test('a platform maintenance fence blocks new releases without blocking TaskSpace work', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: releaseStub().client,
  });
  const brokerState = path.join(fixture.taskspacesRoot, '.broker');
  await mkdir(brokerState, { recursive: true });
  await writeFile(path.join(brokerState, 'maintenance.json'), JSON.stringify({
    schemaVersion: 1,
    operationId: 'ownership-upgrade-test',
    startedAt: new Date().toISOString(),
  }));

  await writeFile(path.join(task.workspace, 'shared.txt'), 'AI keeps editing during maintenance\n');
  await assert.rejects(
    broker.executeAuthenticated(task.token, { action: 'preflight' }),
    (error) => error.code === 'TASKSPACE_PLATFORM_MAINTENANCE'
      && error.retryable === true,
  );
  const contract = await broker.executeAuthenticated(task.token, { action: 'contract' });
  assert.equal(contract.task.taskId, task.taskId);
  assert.equal(await readFile(path.join(task.workspace, 'shared.txt'), 'utf8'), 'AI keeps editing during maintenance\n');
});

function releaseStub(overrides = {}) {
  const calls = [];
  const client = async (request) => {
    calls.push(request);
    if (request.action === 'prepare') {
      if (overrides.prepare) return overrides.prepare(request, calls);
      return { status: 'prepared', jobId: '123e4567-e89b-42d3-a456-426614174229', commit: request.provenance.candidateCommit };
    }
    if (overrides.client) return overrides.client(request, calls);
    if (request.action === 'release') {
      return {
        jobId: `job-${calls.length}`,
        commit: request.provenance.candidateCommit,
        testDatabaseSandbox: { status: 'healthy' },
      };
    }
    if (request.action === 'contract') return { schemaVersion: 3, projectSlug: 'forge-base' };
    if (request.action === 'diagnose') return { active: false, lastJob: null };
    return { workspaceClean: true, head: '0'.repeat(40) };
  };
  return { calls, client };
}

test('Broker binds typed verification calls to the authenticated TaskSpace identity', async () => {
  const fixture = await createFixture();
  const taskA = fixture.tasks.get('task-a');
  const taskB = fixture.tasks.get('task-b');
  const calls = [];
  const verificationClient = async (request) => {
    calls.push(request);
    return { receiptType: `forge-verify/${request.action}`, taskId: request.taskId };
  };
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: releaseStub().client,
    verificationClient,
  });

  const capability = await broker.executeAuthenticated(taskA.token, {
    action: 'verify-capability', profile: 'backend-module-test',
  });
  assert.equal(capability.taskId, taskA.taskId);
  assert.deepEqual(calls[0], { taskId: taskA.taskId, action: 'capability', profile: 'backend-module-test' });

  const admission = await broker.executeAuthenticated(taskA.token, {
    action: 'verify-admit', profiles: ['governance', 'backend-module-test', 'full-regression'],
  });
  assert.equal(admission.taskId, taskA.taskId);
  assert.deepEqual(calls[1], {
    taskId: taskA.taskId,
    action: 'admit',
    profiles: ['governance', 'backend-module-test', 'full-regression'],
  });

  const receipt = await broker.executeAuthenticated(taskB.token, {
    action: 'verify-receipt', receiptId: '12345678-1234-1234-1234-123456789abc',
  });
  assert.equal(receipt.taskId, taskB.taskId);
  assert.equal(calls[2].taskId, taskB.taskId);
  assert.equal(Object.hasOwn(calls[2], 'workspace'), false);

  await broker.executeAuthenticated(taskB.token, {
    action: 'verify-receipt', receiptId: '12345678-1234-1234-1234-123456789abc', includeDiagnostics: true,
  });
  assert.deepEqual(calls.at(-1), {
    taskId: taskB.taskId, action: 'receipt', receiptId: '12345678-1234-1234-1234-123456789abc', includeDiagnostics: true,
  });
  for (const extra of [{ includeDiagnostics: false }, { includeDiagnostics: 'true' }, { includeDiagnostics: true, taskId: taskA.taskId }, { includeDiagnostics: true, path: '/etc/passwd' }]) {
    await assert.rejects(broker.executeAuthenticated(taskB.token, {
      action: 'verify-receipt', receiptId: '12345678-1234-1234-1234-123456789abc', ...extra,
    }), /unsupported field|includeDiagnostics/u);
  }

  await assert.rejects(
    broker.executeAuthenticated(taskA.token, {
      action: 'verify-run', profile: 'governance', selectors: {},
      idempotencyKey: 'verification-0001', admissionId: '12345678-1234-1234-1234-123456789abc',
      command: 'curl https://example.invalid',
    }),
    /unsupported field/u,
  );
  await assert.rejects(
    broker.executeAuthenticated(taskA.token, {
      action: 'verify-run', profile: 'governance', selectors: [],
      idempotencyKey: 'verification-0001', admissionId: '12345678-1234-1234-1234-123456789abc',
    }),
    /selectors must be an object/u,
  );
  await assert.rejects(
    broker.executeAuthenticated(taskA.token, {
      action: 'verify-admit', profiles: ['full-regression', 'governance'],
    }),
    /catalog order/u,
  );
  await assert.rejects(
    broker.executeAuthenticated(taskA.token, {
      action: 'verify-capability', profile: 'unreviewed-profile',
    }),
    /not allowed/u,
  );
});

test('Broker bounds verification calls and propagates cancellation to the Runner client', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  let cancelled = false;
  const verificationClient = async (request, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      cancelled = true;
      const error = new Error('runner request cancelled');
      error.code = 'VERIFY_RUNNER_CANCELLED';
      reject(error);
    }, { once: true });
  });
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: releaseStub().client,
    verificationClient,
    verificationTimeoutMs: 1_000,
  });
  const startedAt = Date.now();
  await assert.rejects(
    () => broker.executeAuthenticated(task.token, {
      action: 'verify-capability', profile: 'governance',
    }),
    (error) => error.code === 'VERIFY_RUNNER_TIMEOUT' && error.retryable === true,
  );
  assert.equal(cancelled, true);
  assert.ok(Date.now() - startedAt < 2_500, 'bounded timeout must not leave the caller waiting indefinitely');
});

test('independent TaskSpaces can edit the same file without sharing uncommitted state', async () => {
  const fixture = await createFixture();
  const taskA = fixture.tasks.get('task-a');
  const taskB = fixture.tasks.get('task-b');
  await writeFile(path.join(taskA.workspace, 'shared.txt'), 'actor A\n');
  await writeFile(path.join(taskB.workspace, 'shared.txt'), 'actor B\n');
  const headA = await commit(taskA.workspace, 'actor A changes shared file');
  const headB = await commit(taskB.workspace, 'actor B changes shared file');
  const stub = releaseStub();
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: stub.client,
  });

  const submittedA = await broker.executeAuthenticated(taskA.token, { action: 'submit' });
  const submittedB = await broker.executeAuthenticated(taskB.token, { action: 'submit' });

  assert.equal(submittedA.taskspace.head, headA);
  assert.equal(submittedB.taskspace.head, headB);
  assert.notEqual(headA, headB);
  assert.equal(await readFile(path.join(taskA.workspace, 'shared.txt'), 'utf8'), 'actor A\n');
  assert.equal(await readFile(path.join(taskB.workspace, 'shared.txt'), 'utf8'), 'actor B\n');
  assert.equal(await readFile(path.join(fixture.workspaceRoot, 'shared.txt'), 'utf8'), 'base\n');
  await assert.rejects(
    broker.executeAuthenticated('not-a-valid-taskspace-token', { action: 'status' }),
    (error) => error.code === 'TASKSPACE_AUTHENTICATION_FAILED',
  );
});

test('checkpoint freezes only the exact verified owned dirty paths into one auditable commit', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const relative = 'forge-admin-ui/src/checkpoint.ts';
  await mkdir(path.dirname(path.join(task.workspace, relative)), { recursive: true });
  await writeFile(path.join(task.workspace, relative), 'export const checkpoint = true;\n');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'],
  });
  const stub = releaseStub();
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: stub.client,
  });

  const result = await broker.executeAuthenticated(task.token, {
    action: 'checkpoint', paths: [relative], message: 'Freeze exact checkpoint source',
    expectedHead: fixture.baseCommit,
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
  });

  assert.equal(result.beforeHead, fixture.baseCommit);
  assert.match(result.commit, /^[0-9a-f]{40}$/u);
  assert.match(result.tree, /^[0-9a-f]{40}$/u);
  assert.equal(result.status, 'checkpointed');
  assert.deepEqual(result.changedPaths, [relative]);
  assert.equal(result.workspaceClean, true);
  assert.equal(result.canonicalHead, fixture.baseCommit);
  assert.equal(result.sourceTransition.phase, 'checkpointed');
  assert.deepEqual(result.sourceTransition.from, {
    head: authorization.source.head, fingerprint: authorization.source.workspaceFingerprint,
  });
  assert.deepEqual(result.sourceTransition.to, {
    head: result.commit, fingerprint: result.workspaceFingerprint,
  });
  assert.equal(result.sourceTransition.sourceAuthority.actionCeiling, 'git-checkpoint');
  assert.deepEqual(validateSourceTransition(result.sourceTransition), result.sourceTransition);
  assert.deepEqual(JSON.parse(await readFile(path.join(
    fixture.taskspacesRoot, '.broker', 'source-transitions', `${task.taskId}.json`,
  ), 'utf8')), result.sourceTransition);
  assert.equal(await git(task.workspace, 'rev-parse', 'HEAD^'), fixture.baseCommit);
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1'), '');
  assert.equal(stub.calls.some((call) => call.action === 'release'), false);
  const audit = await readFile(path.join(fixture.taskspacesRoot, '.broker', 'audit.jsonl'), 'utf8');
  assert.match(audit, /taskspace-checkpoint/);
  assert.doesNotMatch(audit, /released|accepted|verified/u);
});

test('checkpoint task locking permits independent saves during release without touching its state', { skip: process.platform !== 'linux' }, async () => {
  const fixture = await createFixture();
  const taskA = fixture.tasks.get('task-a');
  const taskB = fixture.tasks.get('task-b');
  const relative = 'forge-admin-ui/src/shared.ts';
  await writeFile(path.join(taskA.workspace, relative), 'export const side = "release";\n');
  await commit(taskA.workspace, 'Prepare other TaskSpace release');
  const releaseAuthority = await authorizeProductionAction(fixture, taskA);
  await writeFile(path.join(taskB.workspace, relative), 'export const side = "local save";\n');
  const saveAuthority = await authorizeProductionAction(fixture, taskB, {
    actionCeiling: 'git-checkpoint', ownedPaths: [relative],
  });
  let releaseStarted;
  let finishRelease;
  const started = new Promise(resolve => { releaseStarted = resolve; });
  const held = new Promise(resolve => { finishRelease = resolve; });
  const stub = releaseStub({ client: async request => {
    if (request.action !== 'release') return { workspaceClean: true };
    releaseStarted();
    await held;
    return { jobId: 'independent-save-release', commit: request.provenance.candidateCommit };
  } });
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
    releaseClient: stub.client, protectedCompletionClient: releaseAuthority.protectedCompletionClient });
  const peer = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: stub.client });
  const releasing = broker.executeAuthenticated(taskA.token, {
    action: 'release', services: ['forge-admin'], approvalRef: 'Authorized independent release.',
  });
  try {
    await Promise.race([started, releasing.then(() => assert.fail('Release must reach the held Runner'))]);
    const active = broker.activeRelease;
    const ownerBytes = await readFile(broker.releaseLockOwnerFile);
    const request = { action: 'checkpoint', paths: [relative], message: 'Save independently',
      expectedHead: fixture.baseCommit, expectedWorkspaceFingerprint: saveAuthority.source.workspaceFingerprint };
    for (const consumer of [broker, peer]) {
      await assert.rejects(consumer.executeAuthenticated(taskA.token, request),
        error => error.code === 'TASKSPACE_RELEASE_IN_PROGRESS');
    }
    const result = await broker.executeAuthenticated(taskB.token, request);
    assert.equal(result.status, 'checkpointed');
    assert.equal(await git(taskB.workspace, 'show', `HEAD:${relative}`), 'export const side = "local save";');
    assert.notEqual(result.commit, fixture.baseCommit);
    assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), await git(taskA.workspace, 'rev-parse', 'HEAD'));
    await assert.rejects(peer.executeAuthenticated(taskB.token, { ...request, expectedHead: '0'.repeat(40) }),
      error => error.code === 'TASKSPACE_CHECKPOINT_HEAD_CHANGED');
    // A failed project-lock acquisition must also release only its own task lock.
    await assert.rejects(peer.release(taskB, { services: ['forge-admin'] }),
      error => error.code === 'TASKSPACE_RELEASE_IN_PROGRESS');
    assert.equal(broker.activeRelease, active);
    assert.deepEqual(await readFile(broker.releaseLockOwnerFile), ownerBytes);
    await peer.acquireTaskOperationLock('released-after-failure', taskB);
    await peer.releaseTaskOperationLock('released-after-failure', taskB);
  } finally {
    finishRelease();
    await releasing;
  }
});

test('checkpoint task locking excludes every same-task writer across instances and acquisition order', { skip: process.platform !== 'linux' }, async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const relative = 'forge-admin-ui/src/shared.ts';
  await writeFile(path.join(task.workspace, relative), 'export const saved = true;\n');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: [relative],
  });
  const options = { projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client };
  const broker = new TaskspaceBroker(options);
  const peer = new TaskspaceBroker(options);
  const request = { action: 'checkpoint', paths: [relative], message: 'Exclusive local save',
    expectedHead: fixture.baseCommit, expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint };
  let entered;
  let resume;
  const started = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { resume = resolve; });
  const inspect = broker.inspectCandidate.bind(broker);
  broker.inspectCandidate = async (...args) => { entered(); await hold; return inspect(...args); };
  const saving = broker.executeAuthenticated(task.token, request);
  try {
    await Promise.race([started, saving.then(() => assert.fail('Checkpoint must reach its held inspection'))]);
    for (const attempt of [
      () => peer.executeAuthenticated(task.token, request),
      () => peer.prepareCrossLayer(task, {}),
      () => peer.integrate(task, { mode: 'start' }),
      () => peer.release(task, { services: ['forge-admin'] }),
    ]) await assert.rejects(attempt(), error => error.code === 'TASKSPACE_RELEASE_IN_PROGRESS');
    await assert.rejects(readFile(broker.releaseLockOwnerFile), { code: 'ENOENT' });
  } finally {
    resume();
    assert.equal((await saving).status, 'checkpointed');
  }
  // Hold the reverse order after project owner publication, before the
  // project writer checks for an in-flight checkpoint task lock.
  let projectEntered;
  let publishProject;
  const projectStarted = new Promise(resolve => { projectEntered = resolve; });
  const projectHold = new Promise(resolve => { publishProject = resolve; });
  const acquireProject = broker.acquireProjectReleaseLock.bind(broker);
  broker.acquireProjectReleaseLock = async (...args) => {
    await acquireProject(...args); projectEntered(); await projectHold;
  };
  const operationId = randomUUID();
  const acquiring = broker.acquireReleaseLock(operationId, task, 'release');
  try {
    await projectStarted;
    await assert.rejects(peer.executeAuthenticated(task.token, request),
      error => error.code === 'TASKSPACE_RELEASE_IN_PROGRESS');
  } finally {
    publishProject();
    await acquiring;
    await broker.releaseReleaseLock(operationId, task);
  }
});

test('checkpoint task locking preserves foreign owners and maintenance on rejection and cleanup', { skip: process.platform !== 'linux' }, async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const options = { projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client };
  const broker = new TaskspaceBroker(options);
  const peer = new TaskspaceBroker(options);
  const request = { action: 'checkpoint', paths: ['forge-admin-ui/src/shared.ts'], message: 'Do not bypass locks',
    expectedHead: fixture.baseCommit, expectedWorkspaceFingerprint: '0'.repeat(64) };
  await mkdir(broker.releaseLockRoot, { recursive: true });
  for (const owner of [{}, { instanceId: 'external', operationId: 'maintenance', action: 'maintenance', taskId: 'task-b' }]) {
    const bytes = Buffer.from(JSON.stringify(owner));
    await writeFile(broker.releaseLockOwnerFile, bytes);
    await assert.rejects(broker.executeAuthenticated(task.token, request),
      error => error.code === 'TASKSPACE_RELEASE_IN_PROGRESS');
    assert.deepEqual(await readFile(broker.releaseLockOwnerFile), bytes);
  }
  await unlink(broker.releaseLockOwnerFile);
  await assert.rejects(broker.executeAuthenticated(task.token, request),
    error => error.code === 'TASKSPACE_RELEASE_IN_PROGRESS');
  const foreign = Buffer.from(JSON.stringify({ instanceId: broker.instanceId, operationId: 'different-operation',
    action: 'release', taskId: 'task-b' }));
  await writeFile(broker.releaseLockOwnerFile, foreign);
  const operationId = randomUUID();
  await broker.acquireTaskOperationLock(operationId, task);
  const inode = (await stat(broker.taskOperationLockFile(task))).ino;
  await peer.releaseTaskOperationLock(operationId, task);
  await broker.releaseTaskOperationLock('different-operation', task);
  await assert.rejects(peer.acquireTaskOperationLock('foreign-acquire', task),
    error => error.code === 'TASKSPACE_RELEASE_IN_PROGRESS');
  await broker.releaseReleaseLock(operationId, task);
  assert.deepEqual(await readFile(broker.releaseLockOwnerFile), foreign);
  await peer.acquireTaskOperationLock('after-cleanup', task);
  await peer.releaseTaskOperationLock('after-cleanup', task);
  assert.equal((await stat(broker.taskOperationLockFile(task))).ino, inode);
  // A vanished project owner must not strand the matching task lock either.
  await broker.acquireTaskOperationLock(operationId, task);
  await unlink(broker.releaseLockOwnerFile);
  await broker.releaseReleaseLock(operationId, task);
  await peer.acquireTaskOperationLock('after-cleanup', task);
  await peer.releaseTaskOperationLock('after-cleanup', task);
  assert.equal((await stat(broker.taskOperationLockFile(task))).ino, inode);
  await writeFile(broker.maintenanceFile, JSON.stringify({ schemaVersion: 1,
    operationId: 'external-maintenance', startedAt: new Date().toISOString() }));
  await assert.rejects(broker.executeAuthenticated(task.token, request),
    error => error.code === 'TASKSPACE_PLATFORM_MAINTENANCE');
});

test('checkpoint task locking releases its Broker fd after SIGKILL and permits a real save', {
  skip: process.platform !== 'linux', timeout: 20_000,
}, async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const relative = 'forge-admin-ui/src/shared.ts';
  await writeFile(path.join(task.workspace, relative), 'export const savedAfterExit = true;\n');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: [relative],
  });
  const request = { action: 'checkpoint', paths: [relative], message: 'Save after interrupted checkpoint',
    expectedHead: fixture.baseCommit, expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint };
  const moduleUrl = new URL('../docker/harness/taskspace-broker.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    const { TaskspaceBroker } = await import(process.argv[1]);
    const broker = new TaskspaceBroker({ projectRoot: process.argv[2], projectSlug: 'forge-base' });
    const keepAlive = setInterval(() => {}, 1000);
    broker.inspectCandidate = async () => {
      process.stdout.write('checkpoint-locked\\n');
      await new Promise(() => {});
    };
    try { await broker.executeAuthenticated(process.argv[3], JSON.parse(process.argv[4])); }
    finally { clearInterval(keepAlive); }
  `, moduleUrl, fixture.projectRoot, task.token, JSON.stringify(request)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const ready = new Promise(resolve => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('checkpoint-locked\n')) resolve();
    });
  });
  const peer = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base' });
  try {
    await Promise.race([ready, exited.then(([code, signal]) => {
      assert.fail(`Checkpoint holder exited before acquiring its fd: ${code}/${signal}: ${stderr}`);
    })]);
    const inode = (await stat(peer.taskOperationLockFile(task))).ino;
    await assert.rejects(peer.executeAuthenticated(task.token, request),
      error => error.code === 'TASKSPACE_RELEASE_IN_PROGRESS');
    assert.equal(child.kill('SIGKILL'), true);
    const [code, signal] = await exited;
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    const saved = await peer.executeAuthenticated(task.token, request);
    assert.equal(saved.status, 'checkpointed');
    assert.equal(await git(task.workspace, 'show', `HEAD:${relative}`), 'export const savedAfterExit = true;');
    assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), fixture.baseCommit);
    assert.equal((await stat(peer.taskOperationLockFile(task))).ino, inode);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

test('checkpoint saves a lagging TaskSpace without integrating or advancing canonical history', async () => {
  const fixture = await createFixture();
  const contractPath = path.join(fixture.projectRoot, 'verification', 'contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  contract.profiles = [...(await import('../docker/harness/verify-policy.mjs')).VERIFY_PROFILE_NAMES];
  await writeFile(contractPath, JSON.stringify(contract));
  const task = fixture.tasks.get('task-a');
  const relative = 'forge-admin-ui/src/checkpoint.ts';
  await writeFile(path.join(task.workspace, relative), 'export const checkpoint = true;\n');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'],
  });
  await writeFile(path.join(fixture.workspaceRoot, 'shared.txt'), 'another task advanced canonical\n');
  const canonicalHead = await commit(fixture.workspaceRoot, 'Advance canonical after local authorization');
  const canonicalTree = await git(fixture.workspaceRoot, 'rev-parse', 'HEAD^{tree}');
  const stub = releaseStub();
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: stub.client,
  });

  const result = await broker.executeAuthenticated(task.token, {
    action: 'checkpoint', paths: [relative], message: 'Save authorized source on the original base',
    expectedHead: fixture.baseCommit,
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
  });

  assert.equal(result.status, 'checkpointed');
  assert.equal(result.beforeHead, fixture.baseCommit);
  assert.equal(result.canonicalHead, canonicalHead);
  assert.deepEqual(result.changedPaths, [relative]);
  assert.equal(result.workspaceClean, true);
  assert.equal(await git(task.workspace, 'rev-parse', 'HEAD^'), fixture.baseCommit);
  assert.equal(await readFile(path.join(task.workspace, 'shared.txt'), 'utf8'), 'base\n');
  assert.equal(result.sourceTransition.phase, 'checkpointed');
  assert.equal(result.sourceTransition.sourceAuthority.actionCeiling, 'git-checkpoint');
  assert.deepEqual(validateSourceTransition(result.sourceTransition), result.sourceTransition);
  const preflight = await broker.executeAuthenticated(task.token, { action: 'preflight' });
  assert.equal(preflight.taskspace.includesCanonical, false);
  assert.equal(preflight.taskspace.releaseEligible, false);
  assert.equal(preflight.taskspace.baseCommit, fixture.baseCommit);
  await assert.rejects(broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'start', paths: [], canonicalHead,
    expectedHead: result.commit, expectedWorkspaceFingerprint: result.workspaceFingerprint,
  }), { code: 'TASKSPACE_INTEGRATION_HEAD_CHANGED' });
  await assert.rejects(broker.executeAuthenticated(task.token, {
    action: 'release', services: ['forge-admin'], approvalRef: 'Local save cannot promote a lagging candidate.',
  }), { code: 'TASKSPACE_REBASE_REQUIRED' });
  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), canonicalHead);
  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD^{tree}'), canonicalTree);
  assert.equal(await git(fixture.workspaceRoot, 'status', '--porcelain=v1'), '');
  assert.equal(await git(task.workspace, 'rev-parse', 'HEAD'), result.commit);
  assert.equal(stub.calls.some((call) => ['prepare', 'release'].includes(call.action)), false);
});

test('checkpoint preserves unrelated tracked untracked and deleted candidates outside its exact owned paths', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const relative = 'forge-admin-ui/src/checkpoint.ts';
  const tracked = 'forge-admin-ui/src/prior.ts';
  const deleted = 'forge-admin-ui/src/prior-deleted.ts';
  const untracked = 'forge-admin-ui/src/prior-untracked.ts';
  await mkdir(path.dirname(path.join(task.workspace, relative)), { recursive: true });
  await writeFile(path.join(task.workspace, tracked), 'export const prior = 0;\n');
  await writeFile(path.join(task.workspace, deleted), 'export const deleted = true;\n');
  const beforeHead = await commit(task.workspace, 'Prepare independent prior candidates');
  await writeFile(path.join(task.workspace, tracked), 'export const prior = 1;\n');
  await unlink(path.join(task.workspace, deleted));
  await writeFile(path.join(task.workspace, untracked), 'export const pending = true;\n');
  await writeFile(path.join(task.workspace, relative), 'export const checkpoint = true;\n');
  const others = [tracked, deleted, untracked];
  const statusBefore = await git(task.workspace, 'status', '--porcelain=v1', '--untracked-files=all', '--', ...others);
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: [relative],
  });
  const stub = releaseStub();
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: stub.client });
  const result = await broker.executeAuthenticated(task.token, {
    action: 'checkpoint', paths: [relative], message: 'Save only the owned candidate',
    expectedHead: beforeHead, expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
  });
  assert.equal(result.status, 'checkpointed');
  assert.equal(result.workspaceClean, false);
  assert.deepEqual([...result.remainingDirtyPaths].sort(), [...others].sort());
  assert.deepEqual(result.changedPaths, [relative]);
  assert.equal(await git(task.workspace, 'diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', result.commit), relative);
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1', '--untracked-files=all', '--', ...others), statusBefore);
  assert.equal(await git(task.workspace, 'diff', '--cached', '--name-only'), '');
  assert.equal(await readFile(path.join(task.workspace, tracked), 'utf8'), 'export const prior = 1;\n');
  assert.equal(await readFile(path.join(task.workspace, untracked), 'utf8'), 'export const pending = true;\n');
  await assert.rejects(readFile(path.join(task.workspace, deleted)), { code: 'ENOENT' });
  assert.equal(await git(task.workspace, 'show', `HEAD:${tracked}`), 'export const prior = 0;');
  assert.equal(await git(task.workspace, 'show', `HEAD:${deleted}`), 'export const deleted = true;');
  assert.equal(await git(task.workspace, 'ls-files', '--', untracked), '');
  assert.equal(stub.calls.some(call => call.action === 'release'), false);
  assert.deepEqual(validateSourceTransition(result.sourceTransition), result.sourceTransition);
});

test('checkpoint accepts credential-handling source under the same exact ownership boundary as task preparation', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const relative = 'forge-server/forge-framework/forge-plugin-parent/forge-plugin-system/src/test/java/com/mdframe/forge/plugin/system/security/ClientCredentialSurfaceContractTest.java';
  await mkdir(path.dirname(path.join(task.workspace, relative)), { recursive: true });
  await writeFile(path.join(task.workspace, relative), 'class ClientCredentialSurfaceContractTest {}\n');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: [relative],
  });
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client });
  const result = await broker.executeAuthenticated(task.token, {
    action: 'checkpoint', paths: [relative], message: 'Freeze verified credential handling test',
    expectedHead: fixture.baseCommit, expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
  });
  assert.equal(result.status, 'checkpointed');
  assert.deepEqual(result.changedPaths, [relative]);
  assert.equal(result.workspaceClean, true);
  for (const denied of [relative.replace('/security/', '/secrets/'), relative.replace('ClientCredentialSurfaceContractTest.java', 'client-credentials.json'), relative.replace('ClientCredentialSurfaceContractTest.java', 'PrivateKeyCredentialTest.java')]) {
    await assert.rejects(broker.assertCheckpointPaths(task, [denied], [denied]), { code: 'TASKSPACE_CHECKPOINT_PATH_DENIED' });
  }
  await assert.rejects(broker.assertCheckpointPaths(task, [relative], ['forge-admin-ui/src']), { code: 'TASKSPACE_CHECKPOINT_PATH_DENIED' });
});

test('checkpoint renewal uses only the Broker transition and current source for the same RPC', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const relative = 'forge-admin-ui/src/checkpoint-renewal.ts';
  await mkdir(path.dirname(path.join(task.workspace, relative)), { recursive: true });
  await writeFile(path.join(task.workspace, relative), 'export const checkpoint = 0;\n');
  await commit(task.workspace, 'Prepare tracked checkpoint source');
  await writeFile(path.join(task.workspace, relative), 'export const checkpoint = 1;\n');
  const { context, source } = await authorizeProductionAction(fixture, task);
  const calls = [];
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
    releaseClient: releaseStub().client,
    executionRenewalClient: async (request) => {
      calls.push(request);
      const authorityId = '123e4567-e89b-42d3-a456-426614174229';
      const next = { ...context, sourceCommit: request.source.head, workspaceFingerprint: request.source.fingerprint,
        productionAuthorityId: authorityId, controllerGrantDigest: '6'.repeat(64) };
      return { sourceTransition: request.sourceTransition,
        authority: { ...next, authorityId, productionAuthorityDigest: digestProductionTaskAuthorityBinding(next) },
        trustedPolicyInput: { profile: 'production-controller', expectedContractId: context.contractId,
          taskAuthority: { actionCeiling: context.actionCeiling } } };
    },
  });
  const checkpoint = await broker.executeAuthenticated(task.token, {
    action: 'checkpoint', paths: [relative], message: 'Keep exact verified content',
    expectedHead: source.head, expectedWorkspaceFingerprint: source.workspaceFingerprint,
  });
  assert.equal(checkpoint.sourceTransition.from.fingerprint, checkpoint.sourceTransition.to.fingerprint);
  const lookup = { action: 'execution-context',
    ...Object.fromEntries(['projectSlug', 'taskId', 'conversationId', 'actorUserId', 'dshSessionId',
      'rpcId', 'textDigest'].map((key) => [key, context[key]])) };
  await assert.rejects(broker.executeAuthenticated(task.token, { ...lookup, sourceTransition: checkpoint.sourceTransition }),
    /unsupported field/u);
  await writeFile(path.join(task.workspace, relative), 'export const checkpoint = 2;\n');
  await assert.rejects(broker.executeAuthenticated(task.token, lookup), { code: 'EXECUTION_RENEWAL_SOURCE_CHANGED' });
  assert.equal(calls.length, 0);
  await writeFile(path.join(task.workspace, relative), 'export const checkpoint = 1;\n');
  const updated = await broker.executeAuthenticated(task.token, lookup);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].sourceTransition, checkpoint.sourceTransition);
  assert.equal(updated.sourceCommit, checkpoint.commit);
  assert.equal(updated.rpcId, context.rpcId);
  assert.equal(updated.executionId, context.executionId);
  assert.equal(updated.actionCeiling, context.actionCeiling);
  assert.equal((await broker.executeAuthenticated(task.token, lookup)).sourceCommit, checkpoint.commit);
  assert.equal(calls.length, 1);
});

test('checkpoint treats a required change Spec as one exact file rather than a writable directory root', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const spec = 'code-copilot/changes/customer-qualification-archive/spec.md';
  await mkdir(path.dirname(path.join(task.workspace, spec)), { recursive: true });
  await writeFile(path.join(task.workspace, spec), '# Customer qualification archive\n');
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base' });
  await broker.assertCheckpointPaths(task, [spec], [spec]);
  for (const denied of [`${spec}/script.sh`, 'code-copilot/changes/customer-qualification-archive/tasks.md']) {
    await assert.rejects(
      broker.assertCheckpointPaths(task, [denied], [spec]),
      (error) => error.code === 'TASKSPACE_CHECKPOINT_PATH_DENIED',
    );
  }
});

test('checkpoint inventories against the explicitly selected Host contract limits', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const hostContract = await writeHostInventoryContract(fixture);
  const relative = 'forge-admin-ui/src/host-checkpoint.ts';
  await mkdir(path.dirname(path.join(task.workspace, relative)), { recursive: true });
  await writeFile(path.join(task.workspace, relative), 'export const hostCheckpoint = true;\n');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'],
  });
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    verificationMode: 'host-toolchain',
    verificationContractPath: hostContract,
    releaseClient: releaseStub().client,
  });
  const result = await broker.executeAuthenticated(task.token, {
    action: 'checkpoint', paths: [relative], message: 'Checkpoint through Host inventory contract',
    expectedHead: fixture.baseCommit,
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
  });
  assert.equal(result.status, 'checkpointed');
  assert.equal(await git(task.workspace, 'rev-parse', 'HEAD^'), fixture.baseCommit);
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1'), '');
});

test('Host inventory mode rejects missing or container-shaped contracts without legacy fallback', async (t) => {
  await t.test('missing Host contract', async () => {
    const fixture = await createFixture();
    const task = fixture.tasks.get('task-a');
    const broker = new TaskspaceBroker({
      projectRoot: fixture.projectRoot,
      projectSlug: 'forge-base',
      verificationMode: 'host-toolchain',
      verificationContractPath: path.join(fixture.projectRoot, 'verification', 'host-contract.json'),
      releaseClient: releaseStub().client,
    });
    await assert.rejects(
      broker.inventoryTaskspace(task),
      (error) => error.code === 'TASKSPACE_VERIFICATION_CONTRACT_INVALID',
    );
  });
  await t.test('container contract at Host path', async () => {
    const fixture = await createFixture();
    const task = fixture.tasks.get('task-a');
    const hostPath = path.join(fixture.projectRoot, 'verification', 'host-contract.json');
    await writeFile(hostPath, await readFile(path.join(fixture.projectRoot, 'verification', 'contract.json')));
    const broker = new TaskspaceBroker({
      projectRoot: fixture.projectRoot,
      projectSlug: 'forge-base',
      verificationMode: 'host-toolchain',
      verificationContractPath: hostPath,
      releaseClient: releaseStub().client,
    });
    await assert.rejects(
      broker.inventoryTaskspace(task),
      (error) => error.code === 'TASKSPACE_VERIFICATION_CONTRACT_INVALID'
        && /host verification contract/u.test(error.message),
    );
  });
  assert.throws(
    () => new TaskspaceBroker({ projectRoot: path.resolve('.'), projectSlug: 'forge-base', verificationMode: 'automatic' }),
    /verification mode is invalid/u,
  );
});

for (const fileName of ['deleted.ts', '[type].vue']) test(`TODO-120 checkpoint preserves exact tracked deletion ${fileName} beside a glob-matching file`, async () => {
  const fixture = await createFixture();
  const contractPath = path.join(fixture.projectRoot, 'verification', 'contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  contract.profiles = [...(await import('../docker/harness/verify-policy.mjs')).VERIFY_PROFILE_NAMES];
  await writeFile(contractPath, JSON.stringify(contract));
  const task = fixture.tasks.get('task-a');
  const relative = `forge-admin-ui/src/${fileName}`;
  const neighbor = 'forge-admin-ui/src/t.vue';
  await mkdir(path.dirname(path.join(task.workspace, relative)), { recursive: true });
  await writeFile(path.join(task.workspace, relative), 'export const removed = true;\n');
  await writeFile(path.join(task.workspace, neighbor), 'export const untouched = true;\n');
  const beforeHead = await commit(task.workspace, 'add tracked deletion fixture');
  await unlink(path.join(task.workspace, relative));
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  assert.equal(authorization.source.files.find((item) => item.relative === relative)?.deleted, true);

  const release = releaseStub();
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: release.client,
    protectedCompletionClient: authorization.protectedCompletionClient,
  });
  const result = await broker.executeAuthenticated(task.token, {
    action: 'checkpoint', paths: [relative], message: 'Remove tracked source exactly',
    expectedHead: beforeHead,
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
  });
  const committedInventory = await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS);

  assert.equal(result.status, 'checkpointed');
  assert.equal(result.workspaceFingerprint, committedInventory.workspaceFingerprint);
  assert.notEqual(result.commit, beforeHead);
  assert.deepEqual(result.sourceTransition.from, {
    head: authorization.source.head, fingerprint: authorization.source.workspaceFingerprint,
  });
  assert.deepEqual(result.sourceTransition.to, {
    head: result.commit, fingerprint: committedInventory.workspaceFingerprint,
  });
  assert.equal(result.sourceTransition.sourceAuthority.actionCeiling, 'release');
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1'), '');
  assert.equal(await git(task.workspace, 'diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', result.commit), relative);
  assert.equal(committedInventory.files.some((item) => item.relative === relative), false);
  assert.equal(await readFile(path.join(task.workspace, neighbor), 'utf8'), 'export const untouched = true;\n');
  assert.equal(await git(task.workspace, '--literal-pathspecs', 'ls-files', '--stage', '--', relative), '');
  if (fileName === '[type].vue') {
    // The old query still matches the neighboring t.vue after the real deletion.
    assert.match(await git(task.workspace, 'ls-files', '--stage', '--', relative), /t\.vue$/u);
  }
  await assert.rejects(
    broker.executeAuthenticated(task.token, {
      action: 'release', services: ['forge-admin'], approvalRef: 'Old source evidence must not release.',
    }),
    (error) => error.code === 'TASKSPACE_RELEASE_AUTHORITY_STALE',
  );
  assert.equal(release.calls.some((call) => call.action === 'release'), false);
});

test('TODO-120 checkpoint preserves an existing bracket-named file and its untouched neighbor', async () => {
  const fixture = await createFixture();
  const contractPath = path.join(fixture.projectRoot, 'verification', 'contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  contract.profiles = [...(await import('../docker/harness/verify-policy.mjs')).VERIFY_PROFILE_NAMES];
  await writeFile(contractPath, JSON.stringify(contract));
  const task = fixture.tasks.get('task-a');
  const relative = 'forge-admin-ui/src/[type].vue';
  const neighbor = 'forge-admin-ui/src/t.vue';
  await writeFile(path.join(task.workspace, relative), 'export const value = 1;\n');
  await writeFile(path.join(task.workspace, neighbor), 'export const untouched = true;\n');
  const beforeHead = await commit(task.workspace, 'add bracket path fixture');
  await writeFile(path.join(task.workspace, relative), 'export const value = 2;\n');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'],
  });
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
    protectedCompletionClient: authorization.protectedCompletionClient });
  const result = await broker.executeAuthenticated(task.token, {
    action: 'checkpoint', paths: [relative], message: 'Update literal bracket path',
    expectedHead: beforeHead, expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
  });
  assert.equal(result.status, 'checkpointed');
  assert.equal(await git(task.workspace, 'diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', result.commit), relative);
  assert.equal(await readFile(path.join(task.workspace, relative), 'utf8'), 'export const value = 2;\n');
  assert.equal(await readFile(path.join(task.workspace, neighbor), 'utf8'), 'export const untouched = true;\n');
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1'), '');
});

test('checkpoint preserves an exact verified rename as one deletion plus one added path', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const oldRelative = 'forge-admin-ui/src/old-name.ts';
  const newRelative = 'forge-admin-ui/src/new-name.ts';
  await mkdir(path.dirname(path.join(task.workspace, oldRelative)), { recursive: true });
  await writeFile(path.join(task.workspace, oldRelative), 'export const renamed = true;\n');
  const beforeHead = await commit(task.workspace, 'add tracked rename fixture');
  await rename(path.join(task.workspace, oldRelative), path.join(task.workspace, newRelative));
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'],
  });
  assert.equal(authorization.source.files.find((item) => item.relative === oldRelative)?.deleted, true);
  assert.match(authorization.source.files.find((item) => item.relative === newRelative)?.sha256 ?? '', /^[0-9a-f]{64}$/u);

  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
  });
  const result = await broker.executeAuthenticated(task.token, {
    action: 'checkpoint', paths: [oldRelative, newRelative], message: 'Rename tracked source exactly',
    expectedHead: beforeHead,
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
  });
  const committedInventory = await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS);

  assert.equal(result.status, 'checkpointed');
  assert.equal(result.workspaceFingerprint, committedInventory.workspaceFingerprint);
  assert.notEqual(result.workspaceFingerprint, authorization.source.workspaceFingerprint);
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1'), '');
  assert.deepEqual(
    (await git(task.workspace, 'diff-tree', '--no-renames', '--no-commit-id', '--name-only', '-r', result.commit)).split(/\r?\n/u).sort(),
    [newRelative, oldRelative].sort(),
  );
  assert.equal(committedInventory.files.some((item) => item.relative === oldRelative), false);
  assert.match(committedInventory.files.find((item) => item.relative === newRelative)?.sha256 ?? '', /^[0-9a-f]{64}$/u);
});

test('checkpoint rejects mismatched, unowned, prestaged, stale, unauthorized, and expired inputs without committing', async () => {
  const cases = [
    {
      name: 'dirty mismatch',
      authorize: { actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'] },
      requestPaths: ['forge-admin-ui/src/other.ts'], expectedCode: 'TASKSPACE_CHECKPOINT_DIRTY_MISMATCH',
    },
    {
      name: 'outside ownedPaths',
      authorize: { actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src/other'] },
      expectedCode: 'TASKSPACE_CHECKPOINT_PATH_DENIED',
    },
    {
      name: 'prestaged', prestage: true,
      authorize: { actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'] },
      expectedCode: 'TASKSPACE_CHECKPOINT_INDEX_NOT_EMPTY',
    },
    {
      name: 'stale head',
      authorize: { actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'] },
      head: '0'.repeat(40), expectedCode: 'TASKSPACE_CHECKPOINT_HEAD_CHANGED',
    },
    {
      name: 'stale fingerprint',
      authorize: { actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'] },
      fingerprint: '0'.repeat(64), expectedCode: 'TASKSPACE_CHECKPOINT_FINGERPRINT_CHANGED',
    },
    {
      name: 'unauthorized ceiling',
      authorize: { actionCeiling: 'workspace-write', ownedPaths: ['forge-admin-ui/src'] },
      expectedCode: 'TASKSPACE_ACTION_CEILING_DENIED',
    },
    {
      name: 'expired authority',
      authorize: {
        actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'],
        now: Date.now() - EXECUTION_CONTEXT_TTL_MS - 1_000,
      },
      expectedCode: 'EXECUTION_CONTEXT_EXPIRED',
    },
  ];
  for (const item of cases) {
    const fixture = await createFixture();
    const contractPath = path.join(fixture.projectRoot, 'verification', 'contract.json');
    const contract = JSON.parse(await readFile(contractPath, 'utf8'));
    contract.profiles = [...(await import('../docker/harness/verify-policy.mjs')).VERIFY_PROFILE_NAMES];
    await writeFile(contractPath, JSON.stringify(contract));
    const task = fixture.tasks.get('task-a');
    const relative = 'forge-admin-ui/src/checkpoint.ts';
    await mkdir(path.dirname(path.join(task.workspace, relative)), { recursive: true });
    await writeFile(path.join(task.workspace, relative), `export const value = ${JSON.stringify(item.name)};\n`);
    if (item.prestage) await git(task.workspace, 'add', '--', relative);
    const authorization = await authorizeProductionAction(fixture, task, item.authorize);
    await writeFile(path.join(fixture.workspaceRoot, 'shared.txt'), 'canonical advanced independently\n');
    const canonicalHead = await commit(fixture.workspaceRoot, 'Advance canonical before rejected local save');
    const broker = new TaskspaceBroker({
      projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
    });
    await assert.rejects(
      broker.executeAuthenticated(task.token, {
        action: 'checkpoint', paths: item.requestPaths ?? [relative],
        message: `Reject ${item.name}`, expectedHead: item.head ?? fixture.baseCommit,
        expectedWorkspaceFingerprint: item.fingerprint ?? authorization.source.workspaceFingerprint,
      }),
      (error) => error.code === item.expectedCode,
      item.name,
    );
    assert.equal(await git(task.workspace, 'rev-parse', 'HEAD'), fixture.baseCommit, item.name);
    assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), canonicalHead, item.name);
    await assert.rejects(readFile(path.join(
      fixture.taskspacesRoot, '.broker', 'source-transitions', `${task.taskId}.json`,
    )), { code: 'ENOENT' }, item.name);
  }
});

test('checkpoint preserves the committed repository when transition persistence fails without publishing completion', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const relative = 'forge-admin-ui/src/checkpoint-transition-failure.ts';
  await mkdir(path.dirname(path.join(task.workspace, relative)), { recursive: true });
  await writeFile(path.join(task.workspace, relative), 'export const checkpoint = "committed";\n');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'],
  });
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
  });
  broker.writeSourceTransition = async () => {
    throw new Error('injected transition persistence failure');
  };

  await assert.rejects(broker.executeAuthenticated(task.token, {
    action: 'checkpoint', paths: [relative], message: 'Preserve partial checkpoint truth',
    expectedHead: fixture.baseCommit,
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
  }), /injected transition persistence failure/u);

  const committedHead = await git(task.workspace, 'rev-parse', 'HEAD');
  assert.notEqual(committedHead, fixture.baseCommit);
  assert.equal(await git(task.workspace, 'rev-parse', 'HEAD^'), fixture.baseCommit);
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1'), '');
  await assert.rejects(readFile(path.join(
    fixture.taskspacesRoot, '.broker', 'source-transitions', `${task.taskId}.json`,
  )), { code: 'ENOENT' });
  const audit = (await readFile(path.join(fixture.taskspacesRoot, '.broker', 'audit.jsonl'), 'utf8'))
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(audit.some((entry) => entry.type === 'taskspace-checkpoint' && entry.status === 'success'), false);
  assert.equal(audit.at(-1).status, 'failed');
});

test('integrate updates a clean lagging TaskSpace to the exact canonical commit and publishes a fact-only transition', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  await writeFile(path.join(fixture.workspaceRoot, 'shared.txt'), 'canonical update\n');
  const canonicalHead = await commit(fixture.workspaceRoot, 'canonical update');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'],
  });
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
  });

  const result = await broker.executeAuthenticated(task.token, await integrateStartRequest(
    fixture, task, authorization, [],
  ));

  assert.equal(result.status, 'integrated');
  assert.equal(result.head, canonicalHead);
  assert.equal(result.savedSourceCommit, null);
  assert.equal(result.workspaceClean, true);
  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), canonicalHead, 'sync cannot advance canonical');
  assert.match(await readFile(path.join(task.workspace, 'shared.txt'), 'utf8'), /^canonical update\r?\n$/u);
  assert.equal(result.sourceTransition.phase, 'integrated');
  assert.equal(result.sourceTransition.from.head, fixture.baseCommit);
  assert.equal(result.sourceTransition.to.head, canonicalHead);
  assert.equal(result.sourceTransition.canonicalHead, canonicalHead);
  assert.equal(result.sourceTransition.sourceAuthority.actionCeiling, 'git-checkpoint');
  assert.match(result.sourceTransition.digest, /^[0-9a-f]{64}$/u);
  const { digest, ...digestPayload } = result.sourceTransition;
  assert.equal(digest, canonicalSha256(digestPayload).slice('sha256:'.length));
  assert.equal(Object.hasOwn(result.sourceTransition, 'outcome'), false);
  assert.deepEqual(
    { ...result.reviewBaseTransition, appliedAt: null },
    { from: fixture.baseCommit, to: canonicalHead, appliedAt: null },
  );
  assert.match(result.reviewBaseTransition.appliedAt, /^\d{4}-\d{2}-\d{2}T/u);
  const advancedMetadata = JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8'));
  assert.equal(advancedMetadata.baseCommit, canonicalHead);
  const completedIntegration = JSON.parse(await readFile(path.join(
    fixture.taskspacesRoot, '.broker', 'integrations', `${task.taskId}.json`,
  ), 'utf8'));
  assert.deepEqual(completedIntegration.reviewBaseTransition, result.reviewBaseTransition);
  const audit = await readFile(path.join(fixture.taskspacesRoot, '.broker', 'audit.jsonl'), 'utf8');
  const successAudit = audit.trim().split(/\r?\n/u).map((line) => JSON.parse(line))
    .find((entry) => entry.type === 'taskspace-integrate' && entry.status === 'success');
  assert.deepEqual(successAudit.reviewBaseTransition, result.reviewBaseTransition);
  const preflight = await broker.executeAuthenticated(task.token, { action: 'preflight' });
  assert.equal(preflight.integration.phase, 'integrated');
  assert.equal(preflight.sourceTransition.operationId, result.operationId);
  assert.equal(preflight.taskspace.baseCommit, canonicalHead);
});

test('integrated renewal consumes the Broker completed clean operation and advances the same RPC', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  await writeFile(path.join(fixture.workspaceRoot, 'shared.txt'), 'integrated source\n');
  await commit(fixture.workspaceRoot, 'canonical integration for same RPC');
  const { context } = await authorizeProductionAction(fixture, task, { actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src'] });
  const calls = [];
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
    executionRenewalClient: async request => {
      calls.push(request);
      const authorityId = '123e4567-e89b-42d3-a456-426614174229';
      const next = { ...context, sourceCommit: request.source.head, workspaceFingerprint: request.source.fingerprint,
        productionAuthorityId: authorityId, controllerGrantDigest: '6'.repeat(64) };
      return { sourceTransition: request.sourceTransition,
        authority: { ...next, authorityId, productionAuthorityDigest: digestProductionTaskAuthorityBinding(next) },
        trustedPolicyInput: { profile: 'production-controller', expectedContractId: context.contractId,
          taskAuthority: { actionCeiling: context.actionCeiling } } };
    } });
  const authorization = { context, source: await broker.inventoryTaskspace(await broker.readTask(task.taskId)) };
  const integrated = await broker.executeAuthenticated(task.token, await integrateStartRequest(fixture, task, authorization, []));
  const lookup = { action: 'execution-context',
    ...Object.fromEntries(['projectSlug', 'taskId', 'conversationId', 'actorUserId', 'dshSessionId', 'rpcId', 'textDigest']
      .map(key => [key, context[key]])) };
  const stateFile = broker.integrationStateFile(task.taskId);
  const completed = JSON.parse(await readFile(stateFile, 'utf8'));
  await writeFile(stateFile, JSON.stringify({ ...completed, phase: 'conflict-open' }));
  await assert.rejects(broker.executeAuthenticated(task.token, lookup), { code: 'TASKSPACE_INTEGRATION_REVIEW_BASE_INVALID' });
  assert.equal(calls.length, 0);
  await writeFile(stateFile, JSON.stringify(completed));
  await writeFile(path.join(task.workspace, 'shared.txt'), 'changed after integrate\n');
  await assert.rejects(broker.executeAuthenticated(task.token, lookup), { code: 'EXECUTION_RENEWAL_SOURCE_CHANGED' });
  assert.equal(calls.length, 0);
  await writeFile(path.join(task.workspace, 'shared.txt'), 'integrated source\n');
  const updated = await broker.executeAuthenticated(task.token, lookup);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].sourceTransition, integrated.sourceTransition);
  assert.equal(updated.sourceCommit, integrated.head);
  assert.equal(updated.generation, context.generation + 1);
  assert.notEqual(updated.executionId, context.executionId);
  assert.equal(updated.rpcId, context.rpcId);
  assert.equal(updated.actionCeiling, 'git-checkpoint');
  assert.deepEqual(await broker.executeAuthenticated(task.token, lookup), updated);
  assert.equal(calls.length, 1);
});

test('integrate preserves exact dirty source and non-conflicting canonical history in a clean merge commit', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const localPath = 'forge-admin-ui/src/local.ts';
  await mkdir(path.dirname(path.join(task.workspace, localPath)), { recursive: true });
  await writeFile(path.join(task.workspace, localPath), 'export const local = true;\n');
  await writeFile(path.join(fixture.workspaceRoot, 'migration.sql'), '-- canonical migration\n');
  const canonicalHead = await commit(fixture.workspaceRoot, 'canonical migration');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
  });

  const result = await broker.executeAuthenticated(task.token, await integrateStartRequest(
    fixture, task, authorization, [localPath],
  ));

  assert.equal(result.status, 'integrated');
  assert.match(result.savedSourceCommit, /^[0-9a-f]{40}$/u);
  assert.equal(await readFile(path.join(task.workspace, localPath), 'utf8'), 'export const local = true;\n');
  assert.match(await readFile(path.join(task.workspace, 'migration.sql'), 'utf8'), /^-- canonical migration\r?\n$/u);
  assert.deepEqual(
    (await git(task.workspace, 'rev-list', '--parents', '-n', '1', result.head)).split(' '),
    [result.head, result.savedSourceCommit, canonicalHead],
  );
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1'), '');
  assert.equal(
    JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8')).baseCommit,
    canonicalHead,
  );
});

test('integrate start and checkpoint accept a later edited candidate only through its exact protected authority binding', async (t) => {
  for (const [action, expired] of [['integrate', false], ['checkpoint', false], ['checkpoint', true]]) {
    await t.test(`${action}${expired ? ' expired authority' : ''}`, async () => {
      const fixture = await createFixture();
      const task = fixture.tasks.get('task-a');
      const authorization = await authorizeProductionAction(fixture, task, expired
        ? { now: Date.now() - EXECUTION_CONTEXT_TTL_MS - 1_000 } : {});
      const relative = 'forge-admin-ui/src/edited-after-authority.ts';
      await mkdir(path.dirname(path.join(task.workspace, relative)), { recursive: true });
      await writeFile(path.join(task.workspace, relative), 'export const edited = true;\n');
      const candidate = await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS);
      const context = authorization.context;
      const bindingKeys = ['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId',
        'dshSessionId', 'executionId', 'generation', 'rpcId', 'contractId', 'authorityClass',
        'actionCeiling', 'sourceCommit', 'productionAuthorityId', 'productionAuthorityDigest', 'controllerGrantDigest'];
      let binding = {
        schemaVersion: 1, projectionType: 'forge-candidate-authority-binding/v1', taskId: task.taskId,
        contractId: context.contractId, candidate: { source: { head: candidate.head, fingerprint: candidate.workspaceFingerprint } },
        sourceAuthorityBinding: { ...Object.fromEntries(bindingKeys.map((key) => [key, context[key]])),
          authorityWorkspaceFingerprint: context.workspaceFingerprint }, recordDigest: `sha256:${'9'.repeat(64)}`,
      };
      let bindingRequests = 0;
      const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
        releaseClient: releaseStub().client, protectedCandidateBindingClient: async () => { bindingRequests += 1; return binding; } });
      const request = action === 'integrate'
        ? { ...await integrateStartRequest(fixture, task, authorization, [relative]),
          expectedWorkspaceFingerprint: candidate.workspaceFingerprint }
        : { action: 'checkpoint', paths: [relative], message: 'Checkpoint Host-bound edited candidate',
          expectedHead: candidate.head, expectedWorkspaceFingerprint: candidate.workspaceFingerprint };
      if (expired) {
        await assert.rejects(broker.executeAuthenticated(task.token, request), { code: 'EXECUTION_CONTEXT_EXPIRED' });
        assert.equal(bindingRequests, 0, 'an expired context cannot acquire candidate authority');
        assert.equal(await git(task.workspace, 'rev-parse', 'HEAD'), fixture.baseCommit);
        assert.equal(await git(task.workspace, 'diff', '--cached', '--name-only'), '');
        return;
      }
      const valid = structuredClone(binding);
      binding.sourceAuthorityBinding.rpcId = 'other-rpc';
      await assert.rejects(broker.executeAuthenticated(task.token, request),
        (error) => error.code === 'TASKSPACE_CONTINUATION_CANDIDATE_BINDING_MISMATCH');
      assert.equal(await git(task.workspace, 'rev-parse', 'HEAD'), fixture.baseCommit);
      binding = valid;
      const result = await broker.executeAuthenticated(task.token, request);
      assert.equal(result.status, action === 'integrate' ? 'integrated' : 'checkpointed');
      assert.equal(result.workspaceClean, true);
      assert.equal(result.sourceTransition.from.fingerprint, candidate.workspaceFingerprint);
      assert.equal(result.sourceTransition.sourceAuthority.executionId, context.executionId);
      if (action === 'checkpoint') {
        assert.equal(result.sourceTransition.from.fingerprint, result.sourceTransition.to.fingerprint);
      }
    });
  }
});

test('integrated review-base finalization preserves freshly written unrelated TaskSpace metadata', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  await writeFile(path.join(fixture.workspaceRoot, 'migration.sql'), '-- canonical metadata race\n');
  const canonicalHead = await commit(fixture.workspaceRoot, 'canonical metadata race');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
  });
  const finalize = broker.finalizeIntegratedReviewBase.bind(broker);
  const concurrentCandidate = { commit: fixture.baseCommit, submittedAt: new Date().toISOString() };
  broker.finalizeIntegratedReviewBase = async (...args) => {
    const metadataPath = path.join(task.root, 'metadata.json');
    const current = JSON.parse(await readFile(metadataPath, 'utf8'));
    await writeFile(metadataPath, `${JSON.stringify({
      ...current, lastCandidate: concurrentCandidate, updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    return finalize(...args);
  };

  const result = await broker.executeAuthenticated(task.token, await integrateStartRequest(
    fixture, task, authorization, [],
  ));
  const metadata = JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8'));
  assert.equal(result.status, 'integrated');
  assert.equal(metadata.baseCommit, canonicalHead);
  assert.deepEqual(metadata.lastCandidate, concurrentCandidate);
});

test('an integrated operation resumes each review-base finalization failure without another merge', async (t) => {
  for (const failurePoint of ['before-metadata', 'after-metadata', 'after-state']) {
    await t.test(failurePoint, async () => {
      const fixture = await createFixture();
      const task = fixture.tasks.get('task-a');
      const localPath = 'forge-admin-ui/src/review-base-resume.ts';
      await writeFile(path.join(task.workspace, localPath), `export const point = ${JSON.stringify(failurePoint)};\n`);
      await writeFile(path.join(fixture.workspaceRoot, 'migration.sql'), `-- ${failurePoint}\n`);
      const canonicalHead = await commit(fixture.workspaceRoot, `canonical ${failurePoint}`);
      const authorization = await authorizeProductionAction(fixture, task, {
        actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
      });
      const broker = new TaskspaceBroker({
        projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
      });
      let mergeCount = 0;
      const checkpointGit = broker.checkpointGit.bind(broker);
      broker.checkpointGit = async (cwd, ...args) => {
        if (args[0] === 'merge') mergeCount += 1;
        return checkpointGit(cwd, ...args);
      };
      let fail = true;
      if (failurePoint === 'before-metadata') {
        const writeTask = broker.writeTask.bind(broker);
        broker.writeTask = async (...args) => {
          if (fail) { fail = false; throw new Error('injected metadata write failure'); }
          return writeTask(...args);
        };
      } else if (failurePoint === 'after-metadata') {
        const writeState = broker.writeIntegratedReviewBaseState.bind(broker);
        broker.writeIntegratedReviewBaseState = async (...args) => {
          if (fail) { fail = false; throw new Error('injected applied marker failure'); }
          return writeState(...args);
        };
      } else {
        const audit = broker.audit.bind(broker);
        broker.audit = async (...args) => {
          if (fail) { fail = false; throw new Error('injected success audit failure'); }
          return audit(...args);
        };
      }

      const startRequest = await integrateStartRequest(fixture, task, authorization, [localPath]);
      let firstError;
      try {
        await broker.executeAuthenticated(task.token, startRequest);
      } catch (error) {
        firstError = error;
      }
      assert.match(firstError?.message ?? '', /injected/u);
      assert.match(firstError?.integration?.operationId ?? '', /^[0-9a-f-]{36}$/u);
      assert.equal(firstError.integration.phase, 'integrated');
      assert.equal(mergeCount, 1);

      const integratedSource = await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS);
      const resumed = await broker.executeAuthenticated(task.token, {
        ...startRequest,
        mode: 'continue',
        operationId: firstError.integration.operationId,
        expectedHead: integratedSource.head,
        expectedWorkspaceFingerprint: integratedSource.workspaceFingerprint,
      });
      assert.equal(resumed.status, 'integrated');
      assert.equal(resumed.canonicalHead, canonicalHead);
      assert.equal(resumed.workspaceClean, true);
      assert.equal(mergeCount, 1);
      assert.equal(JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8')).baseCommit, canonicalHead);
      const completed = JSON.parse(await readFile(path.join(
        fixture.taskspacesRoot, '.broker', 'integrations', `${task.taskId}.json`,
      ), 'utf8'));
      assert.match(completed.reviewBaseTransition.appliedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.equal(resumed.sourceTransition.operationId, resumed.operationId);
      assert.equal(resumed.sourceTransition.to.head, resumed.head);
    });
  }
});

async function openIntegrationConflict() {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const conflictPath = 'forge-admin-ui/src/shared.ts';
  await writeFile(path.join(task.workspace, conflictPath), 'export const side = "local";\n');
  await writeFile(path.join(fixture.workspaceRoot, conflictPath), 'export const side = "canonical";\n');
  await writeFile(path.join(fixture.workspaceRoot, 'migration.sql'), '-- automatically merged canonical change\n');
  const canonicalHead = await commit(fixture.workspaceRoot, 'canonical conflicting change');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
  });
  const opened = await broker.executeAuthenticated(task.token, await integrateStartRequest(
    fixture, task, authorization, [conflictPath],
  ));
  assert.equal(opened.status, 'conflict-open');
  assert.deepEqual(opened.conflictPaths, [conflictPath]);
  assert.equal(await git(task.workspace, 'rev-parse', 'MERGE_HEAD'), canonicalHead);
  assert.match(await readFile(path.join(task.workspace, conflictPath), 'utf8'), /<<<<<<< HEAD/u);
  const pending = await broker.executeAuthenticated(task.token, { action: 'status' });
  assert.equal(pending.integration.operationId, opened.operationId);
  assert.equal(pending.integration.phase, 'conflict-open');
  assert.deepEqual(pending.integration.conflictPaths, [conflictPath]);
  assert.equal(pending.sourceTransition.phase, 'conflict-open');
  assert.equal(
    JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8')).baseCommit,
    fixture.baseCommit,
  );
  return { fixture, task, broker, opened, canonicalHead, conflictPath };
}

async function openNinetySevenPathIntegrationConflict() {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const conflictPath = 'forge-admin-ui/src/shared.ts';
  const localPaths = [conflictPath];
  for (let index = 1; index <= 12; index += 1) {
    const relative = `forge-admin-ui/src/local-${String(index).padStart(2, '0')}.ts`;
    localPaths.push(relative);
    await writeFile(path.join(task.workspace, relative), `export const local${index} = true;\n`);
  }
  await writeFile(path.join(task.workspace, conflictPath), 'export const side = "local";\n');
  await writeFile(path.join(fixture.workspaceRoot, conflictPath), 'export const side = "canonical";\n');
  for (let index = 1; index <= 96; index += 1) {
    const relative = `forge-admin-ui/src/upstream-${String(index).padStart(2, '0')}.ts`;
    await writeFile(path.join(fixture.workspaceRoot, relative), `export const upstream${index} = true;\n`);
  }
  const canonicalHead = await commit(fixture.workspaceRoot, 'canonical 96 automatic paths and one conflict');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
  });
  const opened = await broker.executeAuthenticated(task.token, await integrateStartRequest(
    fixture, task, authorization, localPaths,
  ));
  assert.equal(opened.status, 'conflict-open');
  assert.equal(opened.dirtyPaths.length, 97);
  assert.deepEqual(opened.conflictPaths, [conflictPath]);
  const pending = JSON.parse(await readFile(path.join(
    fixture.taskspacesRoot, '.broker', 'integrations', `${task.taskId}.json`,
  ), 'utf8'));
  assert.equal(pending.automaticStagedPaths.length, 96);
  assert.equal(await git(task.workspace, 'rev-parse', 'MERGE_HEAD'), canonicalHead);
  assert.equal(
    JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8')).baseCommit,
    fixture.baseCommit,
  );
  return { fixture, task, broker, opened, pending, canonicalHead, conflictPath, localPaths };
}

test('integrate keeps 96 automatic upstream paths internal while one conflict remains the bounded continue contract', async () => {
  const { fixture, task, broker, opened, canonicalHead, conflictPath } = await openNinetySevenPathIntegrationConflict();
  const projected = await broker.executeAuthenticated(task.token, { action: 'preflight' });
  assert.equal(projected.taskspace.dirtyPaths.length, 97);
  assert.deepEqual(projected.integration.conflictPaths, [conflictPath]);
  await writeFile(path.join(task.workspace, conflictPath), 'export const side = "local + canonical";\n');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  const result = await broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'continue', operationId: opened.operationId,
    expectedHead: opened.savedSourceCommit,
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
    canonicalHead, paths: [conflictPath],
  });
  assert.equal(result.status, 'integrated');
  assert.equal(result.workspaceClean, true);
  assert.deepEqual(
    (await git(task.workspace, 'rev-list', '--parents', '-n', '1', result.head)).split(' '),
    [result.head, opened.savedSourceCommit, canonicalHead],
  );
  assert.equal(
    JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8')).baseCommit,
    canonicalHead,
  );
});

test('the 97-path continuation still rejects automatic-index and extra-worktree drift', async (t) => {
  await t.test('automatic staged index content changed', async () => {
    const { fixture, task, broker, opened, canonicalHead, conflictPath } = await openNinetySevenPathIntegrationConflict();
    await writeFile(path.join(task.workspace, 'forge-admin-ui/src/upstream-01.ts'), 'export const tampered = true;\n');
    await git(task.workspace, 'add', '--', 'forge-admin-ui/src/upstream-01.ts');
    const authorization = await authorizeProductionAction(fixture, task, {
      actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
    });
    await assert.rejects(broker.executeAuthenticated(task.token, {
      action: 'integrate', mode: 'continue', operationId: opened.operationId,
      expectedHead: opened.savedSourceCommit,
      expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
      canonicalHead, paths: [conflictPath],
    }), (error) => error.code === 'TASKSPACE_INTEGRATION_AUTOMERGE_CHANGED');
  });

  await t.test('extra untracked worktree path appeared', async () => {
    const { fixture, task, broker, opened, canonicalHead, conflictPath } = await openNinetySevenPathIntegrationConflict();
    await writeFile(path.join(task.workspace, 'forge-admin-ui/src/extra.ts'), 'export const extra = true;\n');
    const authorization = await authorizeProductionAction(fixture, task, {
      actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
    });
    await assert.rejects(broker.executeAuthenticated(task.token, {
      action: 'integrate', mode: 'continue', operationId: opened.operationId,
      expectedHead: opened.savedSourceCommit,
      expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
      canonicalHead, paths: [conflictPath],
    }), (error) => error.code === 'TASKSPACE_INTEGRATION_EXTRA_DIRTY');
  });
});

async function openCleanUnownedAddAddConflict({ checkpoint = false } = {}) {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const conflictPath = 'forge-admin-ui/src/DictSelect.spec.js';
  const automaticPath = 'forge-admin-ui/src/upstream.ts';
  await writeFile(path.join(task.workspace, conflictPath), 'export const side = "sample";\n');
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client });
  let candidate;
  if (checkpoint) {
    const source = await authorizeProductionAction(fixture, task, {
      actionCeiling: 'git-checkpoint', ownedPaths: [conflictPath],
    });
    const saved = await broker.executeAuthenticated(task.token, {
      action: 'checkpoint', paths: [conflictPath], message: 'Existing sample checkpoint',
      expectedHead: source.source.head, expectedWorkspaceFingerprint: source.source.workspaceFingerprint,
    });
    candidate = saved.commit;
  } else {
    candidate = await commit(task.workspace, 'Existing sample checkpoint');
  }
  await writeFile(path.join(fixture.workspaceRoot, conflictPath), 'export const side = "upstream";\n');
  await writeFile(path.join(fixture.workspaceRoot, automaticPath), 'export const upstream = true;\n');
  const canonicalHead = await commit(fixture.workspaceRoot, 'Upstream shared component test');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src/sample.vue'],
  });
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1'), '');
  await assert.rejects(broker.executeAuthenticated(task.token,
    await integrateStartRequest(fixture, task, authorization, [])), { code: 'TASKSPACE_CHECKPOINT_PATH_DENIED' });
  const audit = (await readFile(broker.auditFile, 'utf8')).trim().split('\n').map(JSON.parse);
  const operationId = audit.at(-1).operationId;
  assert.equal(await git(task.workspace, 'rev-parse', 'HEAD'), candidate);
  assert.equal(await git(task.workspace, 'rev-parse', 'MERGE_HEAD'), canonicalHead);
  assert.match(await git(task.workspace, 'status', '--porcelain=v1'), /AA forge-admin-ui\/src\/DictSelect.spec.js/u);
  return { fixture, task, broker, conflictPath, automaticPath, candidate, canonicalHead, operationId };
}

test('checkpoint transition recovery preserves the prior record through saved and legacy replay', async (t) => {
  for (const legacy of [false, true]) await t.test(legacy ? 'legacy missing record' : 'saved rejection', async () => {
    const { fixture, task, broker, candidate, canonicalHead, operationId, conflictPath } =
      await openCleanUnownedAddAddConflict({ checkpoint: true });
    if (legacy) await unlink(broker.integrationStateFile(task.taskId));
    const transitionFile = broker.sourceTransitionFile(task.taskId);
    const originalTransition = await readFile(transitionFile, 'utf8');
    const prior = validateSourceTransition(JSON.parse(originalTransition));
    assert.equal(prior.phase, 'checkpointed');
    assert.notEqual(prior.operationId, operationId);
    assert.equal(prior.to.head, candidate);
    const beforeIndex = await git(task.workspace, 'ls-files', '--stage', '-z');
    const beforeBytes = await readFile(path.join(task.workspace, conflictPath), 'utf8');
    const fresh = await authorizeProductionAction(fixture, task, {
      actionCeiling: 'git-checkpoint', ownedPaths: [conflictPath],
    });
    const request = { action: 'integrate', mode: 'continue', operationId, expectedHead: candidate,
      expectedWorkspaceFingerprint: fresh.source.workspaceFingerprint, canonicalHead, paths: [conflictPath] };
    const recovered = await broker.executeAuthenticated(task.token, request);
    assert.equal(recovered.recoveryOnly, true);
    assert.equal(recovered.status, 'conflict-open');
    assert.equal(recovered.sourceTransition, null);
    assert.equal(await readFile(transitionFile, 'utf8'), originalTransition);
    assert.equal(await git(task.workspace, 'ls-files', '--stage', '-z'), beforeIndex);
    assert.equal(await readFile(path.join(task.workspace, conflictPath), 'utf8'), beforeBytes);
    await writeFile(path.join(task.workspace, conflictPath), 'export const side = "both preserved";\n');
    const edited = await authorizeProductionAction(fixture, task, {
      actionCeiling: 'git-checkpoint', ownedPaths: [conflictPath],
    });
    const integrated = await broker.executeAuthenticated(task.token,
      { ...request, expectedWorkspaceFingerprint: edited.source.workspaceFingerprint });
    assert.equal(integrated.status, 'integrated');
    assert.equal(integrated.workspaceClean, true);
    assert.deepEqual((await git(task.workspace, 'rev-list', '--parents', '-n', '1', integrated.head)).split(' '),
      [integrated.head, candidate, canonicalHead]);
  });
});

test('checkpoint transition recovery rejects changed transition identity, digest and source binding', async (t) => {
  const { fixture, task, broker, candidate, canonicalHead, operationId, conflictPath } =
    await openCleanUnownedAddAddConflict({ checkpoint: true });
  await unlink(broker.integrationStateFile(task.taskId));
  const transitionFile = broker.sourceTransitionFile(task.taskId);
  const original = JSON.parse(await readFile(transitionFile, 'utf8'));
  const fresh = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: [conflictPath],
  });
  const request = { action: 'integrate', mode: 'continue', operationId, expectedHead: candidate,
    expectedWorkspaceFingerprint: fresh.source.workspaceFingerprint, canonicalHead, paths: [conflictPath] };
  const beforeIndex = await git(task.workspace, 'ls-files', '--stage', '-z');
  const beforeBytes = await readFile(path.join(task.workspace, conflictPath), 'utf8');
  for (const change of ['active', 'integrated', 'same-operation', 'identity', 'digest', 'to-head', 'from-head', 'orig-head']) {
    await t.test(change, async () => {
      const transition = structuredClone(original);
      if (change === 'active') transition.phase = 'conflict-open';
      if (change === 'integrated') transition.phase = 'integrated';
      if (change === 'same-operation') transition.operationId = operationId;
      if (change === 'identity') transition.task.dshSessionId = 'session-other';
      if (change === 'to-head') transition.to.head = fixture.baseCommit;
      if (change === 'from-head') transition.from.head = canonicalHead;
      const { digest, ...payload } = transition;
      transition.digest = change === 'digest' ? '0'.repeat(64) : canonicalSha256(payload);
      const bytes = JSON.stringify(transition);
      await writeFile(transitionFile, bytes);
      if (change === 'orig-head') await git(task.workspace, 'update-ref', 'ORIG_HEAD', fixture.baseCommit);
      await assert.rejects(broker.executeAuthenticated(task.token, request),
        { code: change === 'orig-head' ? 'TASKSPACE_INTEGRATION_RECOVERY_MISMATCH' : 'TASKSPACE_INTEGRATION_STATE_INVALID' });
      assert.equal(await readFile(transitionFile, 'utf8'), bytes);
      assert.equal(await git(task.workspace, 'ls-files', '--stage', '-z'), beforeIndex);
      assert.equal(await readFile(path.join(task.workspace, conflictPath), 'utf8'), beforeBytes);
      await assert.rejects(readFile(broker.integrationStateFile(task.taskId)), { code: 'ENOENT' });
      if (change === 'orig-head') await git(task.workspace, 'update-ref', 'ORIG_HEAD', candidate);
    });
  }
});

test('checkpoint transition recovery still enforces owned paths and immutable automatic index', async () => {
  const { fixture, task, broker, candidate, canonicalHead, operationId, conflictPath, automaticPath } =
    await openCleanUnownedAddAddConflict({ checkpoint: true });
  await unlink(broker.integrationStateFile(task.taskId));
  const transitionFile = broker.sourceTransitionFile(task.taskId);
  const original = await readFile(transitionFile, 'utf8');
  const denied = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src/sample.vue'],
  });
  const request = { action: 'integrate', mode: 'continue', operationId, expectedHead: candidate,
    expectedWorkspaceFingerprint: denied.source.workspaceFingerprint, canonicalHead, paths: [conflictPath] };
  await assert.rejects(broker.executeAuthenticated(task.token, request), { code: 'TASKSPACE_CHECKPOINT_PATH_DENIED' });
  await writeFile(path.join(task.workspace, automaticPath), 'export const tampered = true;\n');
  await git(task.workspace, 'add', '--', automaticPath);
  const fresh = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: [conflictPath],
  });
  await assert.rejects(broker.executeAuthenticated(task.token,
    { ...request, expectedWorkspaceFingerprint: fresh.source.workspaceFingerprint }),
  { code: 'TASKSPACE_INTEGRATION_RECOVERY_REPLAY_MISMATCH' });
  assert.equal(await readFile(transitionFile, 'utf8'), original);
  await assert.rejects(readFile(broker.integrationStateFile(task.taskId)), { code: 'ENOENT' });
});

test('path-denied clean integration preserves a recoverable failure without a new source commit', async () => {
  const { task, broker, candidate, canonicalHead, operationId } = await openCleanUnownedAddAddConflict();
  const pending = JSON.parse(await readFile(broker.integrationStateFile(task.taskId), 'utf8'));
  assert.equal(pending.phase, 'source-saved-error');
  assert.equal(pending.error.code, 'TASKSPACE_CHECKPOINT_PATH_DENIED');
  assert.equal(pending.savedSourceCommit, candidate);
  assert.equal(pending.from.head, candidate);
  assert.equal(pending.savedSourceTree, await git(task.workspace, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(pending.operationId, operationId);
  assert.equal(pending.canonicalHead, canonicalHead);
});

test('path-denied clean integration recovers saved and legacy merges after canonical advances then syncs latest', async (t) => {
  for (const legacy of [false, true]) await t.test(legacy ? 'legacy missing record' : 'saved rejection', async () => {
    const { fixture, task, broker, candidate, canonicalHead, operationId, conflictPath } = await openCleanUnownedAddAddConflict();
    if (legacy) await unlink(broker.integrationStateFile(task.taskId)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await writeFile(path.join(fixture.workspaceRoot, 'forge-admin-ui/src/parallel.ts'), 'export const parallel = true;\n');
    const latestCanonical = await commit(fixture.workspaceRoot, 'Parallel task advances canonical');
    await assert.rejects(git(task.workspace, 'cat-file', '-e', `${latestCanonical}^{commit}`));
    const before = await git(task.workspace, 'ls-files', '--stage', '-z');
    const bytes = await readFile(path.join(task.workspace, conflictPath), 'utf8');
    const denied = await authorizeProductionAction(fixture, task, { actionCeiling: 'git-checkpoint', ownedPaths: ['forge-admin-ui/src/sample.vue'] });
    const request = { action: 'integrate', mode: 'continue', operationId, expectedHead: candidate,
      expectedWorkspaceFingerprint: denied.source.workspaceFingerprint, canonicalHead, paths: [conflictPath] };
    await assert.rejects(broker.executeAuthenticated(task.token, request), { code: 'TASKSPACE_CHECKPOINT_PATH_DENIED' });
    const fresh = await authorizeProductionAction(fixture, task, { actionCeiling: 'git-checkpoint', ownedPaths: [conflictPath] });
    request.expectedWorkspaceFingerprint = fresh.source.workspaceFingerprint;
    const recovered = await broker.executeAuthenticated(task.token, request);
    assert.equal(recovered.status, 'conflict-open');
    assert.equal(recovered.recoveryOnly, true);
    assert.equal(recovered.sourceTransition, null);
    assert.equal(recovered.head, candidate);
    assert.equal(await git(task.workspace, 'ls-files', '--stage', '-z'), before);
    assert.equal(await readFile(path.join(task.workspace, conflictPath), 'utf8'), bytes);
    await writeFile(path.join(task.workspace, conflictPath), 'export const side = "both preserved";\n');
    const edited = await authorizeProductionAction(fixture, task, { actionCeiling: 'git-checkpoint', ownedPaths: [conflictPath] });
    const integrated = await broker.executeAuthenticated(task.token, { ...request, expectedWorkspaceFingerprint: edited.source.workspaceFingerprint });
    assert.equal(integrated.status, 'integrated');
    assert.equal(integrated.workspaceClean, true);
    assert.deepEqual((await git(task.workspace, 'rev-list', '--parents', '-n', '1', integrated.head)).split(' '), [integrated.head, candidate, canonicalHead]);
    assert.equal(integrated.canonicalHead, canonicalHead, 'completion must describe only the fixed old target');
    assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), latestCanonical);
    assert.equal(JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8')).baseCommit, canonicalHead);
    const next = await authorizeProductionAction(fixture, task, { actionCeiling: 'git-checkpoint', ownedPaths: [conflictPath] });
    const latest = await broker.executeAuthenticated(task.token, await integrateStartRequest(fixture, task, next, []));
    assert.equal(latest.status, 'integrated');
    assert.equal(latest.canonicalHead, latestCanonical);
    assert.equal(latest.workspaceClean, true);
    await git(task.workspace, 'merge-base', '--is-ancestor', latestCanonical, latest.head);
  });
});

test('path-denied recovery rejects a canonical rollback or divergent successor', async (t) => {
  for (const divergent of [false, true]) await t.test(divergent ? 'divergent' : 'rollback', async () => {
    const { fixture, task, broker, candidate, canonicalHead, operationId, conflictPath } = await openCleanUnownedAddAddConflict();
    await unlink(broker.integrationStateFile(task.taskId));
    await git(fixture.workspaceRoot, 'checkout', '-b', 'parallel-replacement', fixture.baseCommit);
    if (divergent) {
      await writeFile(path.join(fixture.workspaceRoot, 'forge-admin-ui/src/replacement.ts'), 'export const replacement = true;\n');
      await commit(fixture.workspaceRoot, 'Unrelated canonical branch');
    }
    const fresh = await authorizeProductionAction(fixture, task, { actionCeiling: 'git-checkpoint', ownedPaths: [conflictPath] });
    const before = await git(task.workspace, 'ls-files', '--stage', '-z');
    await assert.rejects(broker.executeAuthenticated(task.token, {
      action: 'integrate', mode: 'continue', operationId, expectedHead: candidate,
      expectedWorkspaceFingerprint: fresh.source.workspaceFingerprint, canonicalHead, paths: [conflictPath],
    }), { code: 'TASKSPACE_INTEGRATION_TARGET_CHANGED' });
    assert.equal(await git(task.workspace, 'ls-files', '--stage', '-z'), before);
    await assert.rejects(readFile(broker.integrationStateFile(task.taskId)), { code: 'ENOENT' });
  });
});

test('path-denied legacy recovery rejects altered automatic index, conflict bytes and unrelated operation', async (t) => {
  for (const change of ['index', 'conflict', 'operation']) await t.test(change, async () => {
    const { fixture, task, broker, candidate, canonicalHead, operationId, conflictPath, automaticPath } = await openCleanUnownedAddAddConflict();
    await unlink(broker.integrationStateFile(task.taskId)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (change === 'index') {
      await writeFile(path.join(task.workspace, automaticPath), 'export const tampered = true;\n');
      await git(task.workspace, 'add', '--', automaticPath);
    }
    if (change === 'conflict') await writeFile(path.join(task.workspace, conflictPath), 'export const replaced = true;\n');
    const fresh = await authorizeProductionAction(fixture, task, { actionCeiling: 'git-checkpoint', ownedPaths: [conflictPath] });
    await assert.rejects(broker.executeAuthenticated(task.token, {
      action: 'integrate', mode: 'continue', operationId: change === 'operation' ? randomUUID() : operationId,
      expectedHead: candidate, expectedWorkspaceFingerprint: fresh.source.workspaceFingerprint, canonicalHead, paths: [conflictPath],
    }), { code: change === 'operation' ? 'TASKSPACE_INTEGRATION_NOT_PENDING' : 'TASKSPACE_INTEGRATION_RECOVERY_REPLAY_MISMATCH' });
    await assert.rejects(readFile(broker.integrationStateFile(task.taskId)), { code: 'ENOENT' });
    assert.equal(await git(task.workspace, 'rev-parse', 'HEAD'), candidate);
  });
});

test('the exact r35 dirty-limit error is replayed into a conflict baseline before ordinary continuation', async () => {
  const { fixture, task, broker, opened, pending, canonicalHead, conflictPath } = await openNinetySevenPathIntegrationConflict();
  const integrationFile = path.join(fixture.taskspacesRoot, '.broker', 'integrations', `${task.taskId}.json`);
  const transitionFile = path.join(fixture.taskspacesRoot, '.broker', 'source-transitions', `${task.taskId}.json`);
  const legacyError = {
    ...pending,
    phase: 'source-saved-error',
    error: {
      code: 'TASKSPACE_INTEGRATION_DIRTY_LIMIT',
      message: 'The open merge exceeds the bounded 64-path continuation contract.',
      retryable: false,
    },
    updatedAt: new Date().toISOString(),
  };
  for (const key of [
    'conflictPaths', 'dirtyPaths', 'conflictFileSnapshots', 'automaticStagedPaths',
    'automaticIndexDigest', 'reviewBaseBeforeIntegration', 'to',
  ]) delete legacyError[key];
  await writeFile(integrationFile, `${JSON.stringify(legacyError, null, 2)}\n`);
  await unlink(transitionFile);

  const before = {
    head: await git(task.workspace, 'rev-parse', 'HEAD'),
    mergeHead: await git(task.workspace, 'rev-parse', 'MERGE_HEAD'),
    status: await git(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    index: await git(task.workspace, 'ls-files', '--stage', '-z'),
    conflictBytes: await readFile(path.join(task.workspace, conflictPath), 'utf8'),
  };
  const fresh = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  const recovered = await broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'continue', operationId: opened.operationId,
    expectedHead: opened.savedSourceCommit,
    expectedWorkspaceFingerprint: fresh.source.workspaceFingerprint,
    canonicalHead, paths: [conflictPath],
  });
  assert.equal(recovered.status, 'conflict-open');
  assert.equal(recovered.recoveryOnly, true);
  assert.equal(recovered.continuationRequired, true);
  assert.equal(recovered.sourceTransition, null);
  assert.equal(recovered.dirtyPaths.length, 97);
  assert.deepEqual(recovered.conflictPaths, [conflictPath]);
  assert.equal(await git(task.workspace, 'rev-parse', 'HEAD'), before.head);
  assert.equal(await git(task.workspace, 'rev-parse', 'MERGE_HEAD'), before.mergeHead);
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'), before.status);
  assert.equal(await git(task.workspace, 'ls-files', '--stage', '-z'), before.index);
  assert.equal(await readFile(path.join(task.workspace, conflictPath), 'utf8'), before.conflictBytes);
  assert.equal(
    JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8')).baseCommit,
    fixture.baseCommit,
  );
  await assert.rejects(readFile(transitionFile), /ENOENT/u);
  const recoveredState = JSON.parse(await readFile(integrationFile, 'utf8'));
  assert.equal(recoveredState.phase, 'conflict-open');
  assert.equal(Object.hasOwn(recoveredState, 'error'), false);
  assert.equal(recoveredState.recovery.kind, 'source-saved-dirty-limit-v1');
  assert.equal(recoveredState.recovery.historical.phase, 'source-saved-error');
  assert.equal(recoveredState.recovery.historical.error.code, 'TASKSPACE_INTEGRATION_DIRTY_LIMIT');
  assert.equal(recoveredState.from.head, opened.savedSourceCommit);
  assert.equal(recoveredState.from.fingerprint, fresh.source.workspaceFingerprint);
  assert.equal(recoveredState.sourceAuthority.executionId, fresh.context.executionId);
  assert.equal(recoveredState.automaticStagedPaths.length, 96);
  assert.match(await readFile(path.join(
    fixture.projectRoot, recoveredState.recovery.referencePath, 'repository', '.git', 'HEAD',
  ), 'utf8'), /^[0-9a-f]{40}\r?\n$/u);

  await writeFile(path.join(task.workspace, conflictPath), 'export const side = "resolved after replay";\n');
  const edited = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  const integrated = await broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'continue', operationId: opened.operationId,
    expectedHead: opened.savedSourceCommit,
    expectedWorkspaceFingerprint: edited.source.workspaceFingerprint,
    canonicalHead, paths: [conflictPath],
  });
  assert.equal(integrated.status, 'integrated');
  assert.equal(integrated.workspaceClean, true);
  assert.equal(integrated.sourceTransition.phase, 'integrated');
  assert.equal(
    JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8')).baseCommit,
    canonicalHead,
  );
  assert.deepEqual(
    { ...integrated.reviewBaseTransition, appliedAt: null },
    { from: fixture.baseCommit, to: canonicalHead, appliedAt: null },
  );
  const finalizedState = JSON.parse(await readFile(integrationFile, 'utf8'));
  assert.deepEqual(finalizedState.reviewBaseTransition, integrated.reviewBaseTransition);
  const audit = (await readFile(path.join(fixture.taskspacesRoot, '.broker', 'audit.jsonl'), 'utf8'))
    .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.deepEqual(
    audit.find((entry) => entry.type === 'taskspace-integrate'
      && entry.status === 'success' && entry.integrateStatus === 'integrated'
      && entry.operationId === opened.operationId)?.reviewBaseTransition,
    integrated.reviewBaseTransition,
  );
  assert.deepEqual(integrated.sourceTransition.from, {
    head: opened.savedSourceCommit, fingerprint: edited.source.workspaceFingerprint,
  });
  const next = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  assert.equal(next.context.sourceCommit, integrated.head);
  assert.equal(next.context.workspaceFingerprint, integrated.workspaceFingerprint);
});

test('dirty-limit recovery rejects a live automatic index that differs from immutable replay', async () => {
  const { fixture, task, broker, opened, pending, canonicalHead, conflictPath } = await openNinetySevenPathIntegrationConflict();
  const integrationFile = path.join(fixture.taskspacesRoot, '.broker', 'integrations', `${task.taskId}.json`);
  const transitionFile = path.join(fixture.taskspacesRoot, '.broker', 'source-transitions', `${task.taskId}.json`);
  const legacyError = {
    ...pending,
    phase: 'source-saved-error',
    error: {
      code: 'TASKSPACE_INTEGRATION_DIRTY_LIMIT',
      message: 'The open merge exceeds the bounded 64-path continuation contract.',
      retryable: false,
    },
    updatedAt: new Date().toISOString(),
  };
  for (const key of [
    'conflictPaths', 'dirtyPaths', 'conflictFileSnapshots', 'automaticStagedPaths',
    'automaticIndexDigest', 'reviewBaseBeforeIntegration', 'to',
  ]) delete legacyError[key];
  await writeFile(integrationFile, `${JSON.stringify(legacyError, null, 2)}\n`);
  await unlink(transitionFile);
  await writeFile(path.join(task.workspace, 'forge-admin-ui/src/upstream-01.ts'), 'export const tampered = true;\n');
  await git(task.workspace, 'add', '--', 'forge-admin-ui/src/upstream-01.ts');
  const fresh = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  await assert.rejects(broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'continue', operationId: opened.operationId,
    expectedHead: opened.savedSourceCommit,
    expectedWorkspaceFingerprint: fresh.source.workspaceFingerprint,
    canonicalHead, paths: [conflictPath],
  }), (error) => error.code === 'TASKSPACE_INTEGRATION_RECOVERY_REPLAY_MISMATCH');
  const unchanged = JSON.parse(await readFile(integrationFile, 'utf8'));
  assert.equal(unchanged.phase, 'source-saved-error');
  assert.equal(unchanged.error.code, 'TASKSPACE_INTEGRATION_DIRTY_LIMIT');
  await assert.rejects(readFile(transitionFile), /ENOENT/u);
});

test('integration continuation rejects review-base drift before staging or committing the resolved conflict', async () => {
  const { fixture, task, broker, opened, canonicalHead, conflictPath } = await openIntegrationConflict();
  await writeFile(path.join(task.workspace, conflictPath), 'export const side = "resolved";\n');
  const metadataPath = path.join(task.root, 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  await writeFile(metadataPath, `${JSON.stringify({
    ...metadata, baseCommit: canonicalHead, updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  const beforeStatus = await git(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });

  await assert.rejects(broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'continue', operationId: opened.operationId,
    expectedHead: opened.savedSourceCommit,
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
    canonicalHead, paths: [conflictPath],
  }), (error) => error.code === 'TASKSPACE_INTEGRATION_REVIEW_BASE_CHANGED');

  assert.equal(await git(task.workspace, 'rev-parse', 'HEAD'), opened.savedSourceCommit);
  assert.equal(await git(task.workspace, 'rev-parse', 'MERGE_HEAD'), canonicalHead);
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'), beforeStatus);
  assert.equal(JSON.parse(await readFile(metadataPath, 'utf8')).baseCommit, canonicalHead);
});

test('integrate leaves same-line conflicts open and a valid continuation creates a clean two-parent merge', async () => {
  const { fixture, task, broker, opened, canonicalHead, conflictPath } = await openIntegrationConflict();
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  const authorityFingerprint = authorization.source.workspaceFingerprint;
  await writeFile(path.join(task.workspace, conflictPath), 'export const side = "local + canonical";\n');
  const candidate = await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS);
  assert.notEqual(candidate.workspaceFingerprint, authorityFingerprint);
  const context = authorization.context;
  broker.protectedCandidateBindingClient = async ({ taskId }) => ({
    schemaVersion: 1,
    projectionType: 'forge-candidate-authority-binding/v1',
    taskId,
    contractId: context.contractId,
    candidate: { source: { head: candidate.head, fingerprint: candidate.workspaceFingerprint } },
    sourceAuthorityBinding: {
      projectSlug: context.projectSlug, taskId: context.taskId,
      actorUserId: context.actorUserId, actorUsername: context.actorUsername,
      conversationId: context.conversationId, dshSessionId: context.dshSessionId,
      executionId: context.executionId, generation: context.generation, rpcId: context.rpcId,
      contractId: context.contractId, authorityClass: context.authorityClass,
      actionCeiling: context.actionCeiling, sourceCommit: context.sourceCommit,
      authorityWorkspaceFingerprint: context.workspaceFingerprint,
      productionAuthorityId: context.productionAuthorityId,
      productionAuthorityDigest: context.productionAuthorityDigest,
      controllerGrantDigest: context.controllerGrantDigest,
    },
    recordDigest: `sha256:${'9'.repeat(64)}`,
  });
  const result = await broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'continue', operationId: opened.operationId,
    expectedHead: opened.savedSourceCommit,
    expectedWorkspaceFingerprint: candidate.workspaceFingerprint,
    canonicalHead,
    paths: opened.conflictPaths,
  });

  assert.equal(result.status, 'integrated');
  assert.equal(result.workspaceClean, true);
  assert.match(await readFile(path.join(task.workspace, conflictPath), 'utf8'), /^export const side = "local \+ canonical";\r?\n$/u);
  assert.match(await readFile(path.join(task.workspace, 'migration.sql'), 'utf8'), /^-- automatically merged canonical change\r?\n$/u);
  assert.deepEqual(
    (await git(task.workspace, 'rev-list', '--parents', '-n', '1', result.head)).split(' '),
    [result.head, opened.savedSourceCommit, canonicalHead],
  );
  assert.equal(result.sourceTransition.phase, 'integrated');
  const transition = JSON.parse(await readFile(path.join(
    fixture.taskspacesRoot, '.broker', 'source-transitions', `${task.taskId}.json`,
  ), 'utf8'));
  assert.deepEqual(transition, result.sourceTransition);
  assert.deepEqual(validateSourceTransition(transition), transition);
  assert.deepEqual(transition.from, {
    head: opened.savedSourceCommit,
    fingerprint: candidate.workspaceFingerprint,
  });
  assert.deepEqual(transition.to, {
    head: result.head,
    fingerprint: result.workspaceFingerprint,
  });
  assert.deepEqual(transition.sourceAuthority, {
    executionId: authorization.context.executionId,
    generation: authorization.context.generation,
    contractId: authorization.context.contractId,
    productionAuthorityDigest: authorization.context.productionAuthorityDigest,
    controllerGrantDigest: authorization.context.controllerGrantDigest,
    actionCeiling: authorization.context.actionCeiling,
    issuedAt: authorization.context.issuedAt,
    expiresAt: authorization.context.expiresAt,
  });
  const completed = JSON.parse(await readFile(path.join(
    fixture.taskspacesRoot, '.broker', 'integrations', `${task.taskId}.json`,
  ), 'utf8'));
  assert.deepEqual(completed.from, opened.sourceTransition.from);
  assert.deepEqual(completed.sourceAuthority, opened.sourceTransition.sourceAuthority);
  assert.deepEqual(completed.continuationAuthority, transition.sourceAuthority);
  await assert.rejects(broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'continue', operationId: opened.operationId,
    expectedHead: result.head, expectedWorkspaceFingerprint: '0'.repeat(64),
    canonicalHead, paths: [],
  }), (error) => error.code === 'TASKSPACE_INTEGRATION_POSTCONDITION_FAILED');
  const repeated = await broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'continue', operationId: opened.operationId,
    expectedHead: result.head, expectedWorkspaceFingerprint: result.workspaceFingerprint,
    canonicalHead, paths: [],
  });
  assert.equal(repeated.operationId, result.operationId);
  assert.equal(repeated.head, result.head);
  assert.deepEqual(repeated.sourceTransition, result.sourceTransition);
  assert.deepEqual(
    (await git(task.workspace, 'rev-list', '--parents', '-n', '1', repeated.head)).split(' '),
    [repeated.head, opened.savedSourceCommit, canonicalHead],
  );
});

test('continue candidate binding is exact and rejects missing, stale, cross-identity, and replaced authority facts', () => {
  const broker = new TaskspaceBroker({
    projectRoot: path.resolve('.'), projectSlug: 'forge-base', releaseClient: releaseStub().client,
  });
  const task = { metadata: {
    taskId: 'task-a', actorId: 'actor-a', actorUserId: '11111111-1111-4111-8111-111111111111',
    conversationId: 'conversation-a', projectSlug: 'forge-base',
  } };
  const context = {
    projectSlug: 'forge-base', taskId: 'task-a', actorUserId: task.metadata.actorUserId,
    actorUsername: 'actor-a', conversationId: 'conversation-a', dshSessionId: 'session:task-a:release',
    executionId: '123e4567-e89b-42d3-a456-426614174001', generation: 3,
    rpcId: 'rpc:task-a:release:1', contractId: '1'.repeat(64), authorityClass: 'production-task-writer',
    actionCeiling: 'release', sourceCommit: '2'.repeat(40), workspaceFingerprint: '3'.repeat(64),
    productionAuthorityId: '123e4567-e89b-42d3-a456-426614174002',
    productionAuthorityDigest: '4'.repeat(64), controllerGrantDigest: '5'.repeat(64),
  };
  const request = { expectedHead: context.sourceCommit, expectedWorkspaceFingerprint: '6'.repeat(64) };
  const candidate = { head: request.expectedHead, workspaceFingerprint: request.expectedWorkspaceFingerprint };
  const projection = {
    schemaVersion: 1, projectionType: 'forge-candidate-authority-binding/v1', taskId: context.taskId,
    contractId: context.contractId, candidate: { source: {
      head: candidate.head, fingerprint: candidate.workspaceFingerprint,
    } },
    sourceAuthorityBinding: {
      actionCeiling: context.actionCeiling, actorUserId: context.actorUserId,
      actorUsername: context.actorUsername, authorityClass: context.authorityClass,
      authorityWorkspaceFingerprint: context.workspaceFingerprint, contractId: context.contractId,
      controllerGrantDigest: context.controllerGrantDigest, conversationId: context.conversationId,
      dshSessionId: context.dshSessionId, executionId: context.executionId, generation: context.generation,
      productionAuthorityDigest: context.productionAuthorityDigest,
      productionAuthorityId: context.productionAuthorityId, projectSlug: context.projectSlug,
      rpcId: context.rpcId, sourceCommit: context.sourceCommit, taskId: context.taskId,
    }, recordDigest: `sha256:${'7'.repeat(64)}`,
  };
  assert.doesNotThrow(() => broker.validateContinuationCandidateBinding(projection, task, context, request, candidate));
  for (const [name, damaged] of [
    ['missing binding', { ...projection, sourceAuthorityBinding: null }],
    ['stale candidate', { ...projection, candidate: { source: { ...projection.candidate.source, fingerprint: '8'.repeat(64) } } }],
    ['wrong grant', { ...projection, sourceAuthorityBinding: { ...projection.sourceAuthorityBinding, controllerGrantDigest: '8'.repeat(64) } }],
    ['cross identity', { ...projection, sourceAuthorityBinding: { ...projection.sourceAuthorityBinding, conversationId: 'conversation-b' } }],
    ['replaced authority', { ...projection, sourceAuthorityBinding: { ...projection.sourceAuthorityBinding, executionId: '123e4567-e89b-42d3-a456-426614174009' } }],
  ]) assert.throws(
    () => broker.validateContinuationCandidateBinding(damaged, task, context, request, candidate),
    (error) => error.code === 'TASKSPACE_CONTINUATION_CANDIDATE_BINDING_MISMATCH', name,
  );
});

test('status and preflight project current fingerprint and complete dirty paths from machine evidence', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client,
  });
  await writeFile(path.join(task.workspace, 'forge-admin-ui', 'src', 'shared.ts'), 'export const side = "edited";\n');
  await writeFile(path.join(task.workspace, 'forge-admin-ui', 'src', 'new.ts'), 'export const added = true;\n');
  const expected = await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS);
  await assert.rejects(
    broker.executeAuthenticated(task.token, { action: 'status', workspaceFingerprint: 'f'.repeat(64) }),
    /unsupported field/u,
    'caller-supplied source facts cannot forge the read-only projection',
  );
  for (const action of ['status', 'preflight']) {
    const result = await broker.executeAuthenticated(task.token, { action });
    assert.equal(result.taskspace.workspaceFingerprint, expected.workspaceFingerprint);
    assert.deepEqual(result.taskspace.dirtyPaths.sort(), [
      'forge-admin-ui/src/new.ts', 'forge-admin-ui/src/shared.ts',
    ]);
    assert.deepEqual(result.taskspace.sourceProjection, { available: true, missing: [] });
    assert.notEqual(result.taskspace.workspaceFingerprint, 'f'.repeat(64), 'caller/AI projection is not a source');
  }
  await assert.rejects(
    broker.executeAuthenticated(task.token, { action: 'preflight', workspaceFingerprint: 'f'.repeat(64) }),
    /unsupported field/u,
    'a caller cannot inject the projected source fingerprint',
  );
  const submit = await broker.executeAuthenticated(task.token, { action: 'submit' });
  assert.equal(Object.hasOwn(submit.taskspace, 'workspaceFingerprint'), false, 'submit route semantics stay unchanged');
});

test('integrate rejects an unedited conflict snapshot without requiring raw Git mutation', async () => {
  const { fixture, task, broker, opened, canonicalHead } = await openIntegrationConflict();
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  await assert.rejects(broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'continue', operationId: opened.operationId,
    expectedHead: opened.savedSourceCommit,
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
    canonicalHead, paths: opened.conflictPaths,
  }), (error) => error.code === 'TASKSPACE_INTEGRATION_CONFLICT_UNCHANGED');
  assert.equal(await git(task.workspace, 'rev-parse', 'MERGE_HEAD'), canonicalHead);
});

test('integrate continuation rejects an omitted pending conflict path', async () => {
  const { fixture, task, broker, opened, canonicalHead, conflictPath } = await openIntegrationConflict();
  await writeFile(path.join(task.workspace, conflictPath), 'export const side = "resolved";\n');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  await assert.rejects(broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'continue', operationId: opened.operationId,
    expectedHead: opened.savedSourceCommit,
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
    canonicalHead, paths: [],
  }), (error) => error.code === 'TASKSPACE_INTEGRATION_CONFLICT_MISMATCH');
  assert.equal(await git(task.workspace, 'rev-parse', 'MERGE_HEAD'), canonicalHead);
});

test('integrate continuation accepts an explicitly deleted conflict path through Broker staging', async () => {
  const { fixture, task, broker, opened, canonicalHead, conflictPath } = await openIntegrationConflict();
  await unlink(path.join(task.workspace, conflictPath));
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
  });
  const result = await broker.executeAuthenticated(task.token, {
    action: 'integrate', mode: 'continue', operationId: opened.operationId,
    expectedHead: opened.savedSourceCommit,
    expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
    canonicalHead, paths: opened.conflictPaths,
  });
  assert.equal(result.status, 'integrated');
  await assert.rejects(readFile(path.join(task.workspace, conflictPath)), /ENOENT/u);
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1'), '');
});

test('integrate continuation revalidates owned paths and the original automatic index', async (t) => {
  await t.test('current authority no longer owns the conflict path', async () => {
    const { fixture, task, broker, opened, canonicalHead, conflictPath } = await openIntegrationConflict();
    await writeFile(path.join(task.workspace, conflictPath), 'export const side = "resolved";\n');
    const authorization = await authorizeProductionAction(fixture, task, {
      actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src/other'],
    });
    await assert.rejects(broker.executeAuthenticated(task.token, {
      action: 'integrate', mode: 'continue', operationId: opened.operationId,
      expectedHead: opened.savedSourceCommit,
      expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
      canonicalHead, paths: opened.conflictPaths,
    }), (error) => error.code === 'TASKSPACE_CHECKPOINT_PATH_DENIED');
  });

  await t.test('automatically merged index content drifted', async () => {
    const { fixture, task, broker, opened, canonicalHead, conflictPath } = await openIntegrationConflict();
    await writeFile(path.join(task.workspace, conflictPath), 'export const side = "resolved";\n');
    await writeFile(path.join(task.workspace, 'migration.sql'), '-- altered automatic merge\n');
    await git(task.workspace, 'add', '--', 'migration.sql');
    const authorization = await authorizeProductionAction(fixture, task, {
      actionCeiling: 'release', ownedPaths: ['forge-admin-ui/src'],
    });
    await assert.rejects(broker.executeAuthenticated(task.token, {
      action: 'integrate', mode: 'continue', operationId: opened.operationId,
      expectedHead: opened.savedSourceCommit,
      expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
      canonicalHead, paths: opened.conflictPaths,
    }), (error) => error.code === 'TASKSPACE_INTEGRATION_AUTOMERGE_CHANGED');
  });
});

test('integrate rejects stale, unowned, extra-dirty, unauthorized, expired, drifted-target, and extra-staged inputs', async (t) => {
  await t.test('stale head and fingerprint', async () => {
    const fixture = await createFixture();
    const task = fixture.tasks.get('task-a');
    await writeFile(path.join(fixture.workspaceRoot, 'migration.sql'), '-- canonical\n');
    const canonicalHead = await commit(fixture.workspaceRoot, 'canonical');
    const authorization = await authorizeProductionAction(fixture, task, { ownedPaths: ['forge-admin-ui/src'] });
    const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client });
    await assert.rejects(broker.executeAuthenticated(task.token, {
      action: 'integrate', mode: 'start', expectedHead: '0'.repeat(40),
      expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
      canonicalHead, paths: [],
    }), (error) => error.code === 'TASKSPACE_INTEGRATION_HEAD_CHANGED');
    await assert.rejects(broker.executeAuthenticated(task.token, {
      action: 'integrate', mode: 'start', expectedHead: fixture.baseCommit,
      expectedWorkspaceFingerprint: '0'.repeat(64), canonicalHead, paths: [],
    }), (error) => error.code === 'TASKSPACE_INTEGRATION_FINGERPRINT_CHANGED');
  });

  for (const item of [
    { name: 'unowned', ownedPaths: ['forge-admin-ui/src/other'], paths: ['forge-admin-ui/src/shared.ts'], code: 'TASKSPACE_CHECKPOINT_PATH_DENIED' },
    { name: 'extra dirty', ownedPaths: ['forge-admin-ui/src'], paths: [], code: 'TASKSPACE_INTEGRATION_DIRTY_MISMATCH' },
  ]) {
    await t.test(item.name, async () => {
      const fixture = await createFixture();
      const task = fixture.tasks.get('task-a');
      await writeFile(path.join(task.workspace, 'forge-admin-ui/src/shared.ts'), `export const value = ${JSON.stringify(item.name)};\n`);
      await writeFile(path.join(fixture.workspaceRoot, 'migration.sql'), '-- canonical\n');
      await commit(fixture.workspaceRoot, 'canonical');
      const authorization = await authorizeProductionAction(fixture, task, { ownedPaths: item.ownedPaths });
      const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client });
      await assert.rejects(
        broker.executeAuthenticated(task.token, await integrateStartRequest(fixture, task, authorization, item.paths)),
        (error) => error.code === item.code,
      );
    });
  }

  for (const item of [
    { name: 'unauthorized', actionCeiling: 'workspace-write', now: Date.now(), code: 'TASKSPACE_ACTION_CEILING_DENIED' },
    { name: 'expired', actionCeiling: 'release', now: Date.now() - EXECUTION_CONTEXT_TTL_MS - 1_000, code: 'EXECUTION_CONTEXT_EXPIRED' },
  ]) {
    await t.test(item.name, async () => {
      const fixture = await createFixture();
      const task = fixture.tasks.get('task-a');
      await writeFile(path.join(fixture.workspaceRoot, 'migration.sql'), '-- canonical\n');
      await commit(fixture.workspaceRoot, 'canonical');
      const authorization = await authorizeProductionAction(fixture, task, {
        actionCeiling: item.actionCeiling, ownedPaths: ['forge-admin-ui/src'], now: item.now,
      });
      const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: releaseStub().client });
      await assert.rejects(
        broker.executeAuthenticated(task.token, await integrateStartRequest(fixture, task, authorization, [])),
        (error) => error.code === item.code,
      );
      await assert.rejects(readFile(path.join(fixture.taskspacesRoot, '.broker', 'integrations', `${task.taskId}.json`)), /ENOENT/u);
      await assert.rejects(readFile(path.join(fixture.taskspacesRoot, '.broker', 'source-transitions', `${task.taskId}.json`)), /ENOENT/u);
    });
  }

  await t.test('canonical target divergence during conflict', async () => {
    const { fixture, task, broker, opened, canonicalHead, conflictPath } = await openIntegrationConflict();
    await writeFile(path.join(task.workspace, conflictPath), 'export const side = "resolved";\n');
    await git(task.workspace, 'add', '--', conflictPath);
    const authorization = await authorizeProductionAction(fixture, task, { ownedPaths: ['forge-admin-ui/src'] });
    await git(fixture.workspaceRoot, 'checkout', '-b', 'divergent-canonical', fixture.baseCommit);
    await writeFile(path.join(fixture.workspaceRoot, 'migration.sql'), '-- target drift\n');
    await commit(fixture.workspaceRoot, 'target drift');
    await assert.rejects(broker.executeAuthenticated(task.token, {
      action: 'integrate', mode: 'continue', operationId: opened.operationId,
      expectedHead: opened.savedSourceCommit,
      expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
      canonicalHead, paths: opened.conflictPaths,
    }), (error) => error.code === 'TASKSPACE_INTEGRATION_TARGET_CHANGED');
    assert.equal(
      JSON.parse(await readFile(path.join(task.root, 'metadata.json'), 'utf8')).baseCommit,
      fixture.baseCommit,
    );
  });

  await t.test('extra staged path during continuation', async () => {
    const { fixture, task, broker, opened, canonicalHead, conflictPath } = await openIntegrationConflict();
    const extraPath = 'forge-admin-ui/src/extra.ts';
    await writeFile(path.join(task.workspace, conflictPath), 'export const side = "resolved";\n');
    await writeFile(path.join(task.workspace, extraPath), 'export const extra = true;\n');
    await git(task.workspace, 'add', '--', conflictPath, extraPath);
    const authorization = await authorizeProductionAction(fixture, task, { ownedPaths: ['forge-admin-ui/src'] });
    await assert.rejects(broker.executeAuthenticated(task.token, {
      action: 'integrate', mode: 'continue', operationId: opened.operationId,
      expectedHead: opened.savedSourceCommit,
      expectedWorkspaceFingerprint: authorization.source.workspaceFingerprint,
      canonicalHead, paths: opened.conflictPaths,
    }), (error) => error.code === 'TASKSPACE_INTEGRATION_EXTRA_STAGED');
  });
});

test('release after preparation identifies only current expired acceptance as resumable', async (t) => {
  for (const condition of ['expired', 'tampered-gate', 'wrong-source', 'wrong-contract', 'other-blocker', 'no-expiry', 'no-release-authority']) {
    await t.test(condition, async () => {
      const fixture = await createFixture();
      const task = fixture.tasks.get('task-a');
      await writeFile(path.join(task.workspace, 'shared.txt'), 'candidate awaiting long preparation\n');
      const candidateCommit = await commit(task.workspace, 'Prepare exact candidate');
      const authorization = await authorizeProductionAction(fixture, task,
        condition === 'no-release-authority' ? { actionCeiling: 'git-checkpoint' } : {});
      const { gateDigest: ignored, ...payload } = structuredClone(authorization.projection);
      Object.assign(payload, { outcome: 'BOUNDED_BLOCKED', maximumTerminalOutcome: 'BOUNDED_BLOCKED',
        cannotClaim: ['accepted', 'released'], blockers: [
          { code: 'ACCEPTANCE_CONTRACT_EXPIRED', detail: 'The current contract has expired.' },
          { code: 'SIGNED_RECEIPT_INVALID', detail: 'Expired signed receipt.' },
          { code: 'LEDGER_CLOSURE_PROVENANCE_INVALID', detail: 'Expired signed provenance.' },
        ] });
      if (condition === 'wrong-source') payload.sourceFingerprint = `sha256:${'0'.repeat(64)}`;
      if (condition === 'wrong-contract') payload.ledgerSummary.taskContractId = '0'.repeat(64);
      if (condition === 'other-blocker') payload.blockers.push({ code: 'OBLIGATION_LEDGER_OPEN', detail: 'A real required check is missing.' });
      if (condition === 'no-expiry') payload.blockers.shift();
      const blocked = { ...payload, gateDigest: condition === 'tampered-gate' ? `sha256:${'0'.repeat(64)}` : canonicalSha256(payload) };
      const calls = [];
      let prepared = false;
      const broker = new TaskspaceBroker({
        projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
        protectedCompletionClient: async () => prepared ? blocked : authorization.projection,
        releaseClient: async (request) => {
          if (request.action === 'prepare') {
            calls.push('prepare'); prepared = true;
            return { status: 'prepared', jobId: '123e4567-e89b-42d3-a456-426614174000', commit: candidateCommit };
          }
          if (request.action === 'release') calls.push('release');
          return { active: false };
        },
      });
      broker.promoteCandidate = async () => { calls.push('promote'); };
      await assert.rejects(broker.executeAuthenticated(task.token, {
        action: 'release', services: ['forge-admin'], approvalRef: 'Owner authorized this candidate release.',
      }), (error) => {
        const expected = condition === 'expired' ? 'TASKSPACE_ACCEPTANCE_REVALIDATION_REQUIRED'
          : condition === 'no-release-authority' ? 'TASKSPACE_ACTION_CEILING_DENIED' : 'TASKSPACE_ACCEPTANCE_NOT_READY';
        assert.equal(error.code, expected);
        if (condition === 'expired') {
          assert.equal(error.retryable, true);
          assert.match(error.recommendedAction, /prepared/u);
          assert.match(error.recommendedAction, /forge-verify run --reuse-receipt/u);
          assert.match(error.recommendedAction, /当前.*权限/u);
          assert.match(error.recommendedAction, /不.*重建/u);
        }
        return true;
      });
      assert.deepEqual(calls, condition === 'no-release-authority' ? [] : ['prepare']);
      assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), fixture.baseCommit);
    });
  }
});

test('release explains current missing acceptance without requesting a full rerun or promoting a blocked candidate', async () => {
  for (const condition of ['missing', 'failed', 'stale', 'semantic', 'semantic-mixed', 'semantic-stale', 'shared-owner', 'backend-selection', 'backend-selection-stale', 'backend-selection-helper', 'backend-selection-helper-stale']) {
    const fixture = await createFixture();
    const task = fixture.tasks.get('task-a');
    await writeFile(path.join(task.workspace, 'shared.txt'), `candidate ${condition}\n`);
    await commit(task.workspace, `candidate ${condition}`);
    const backendSelection = condition.startsWith('backend-selection');
    const helperSelection = condition.startsWith('backend-selection-helper');
    const authorization = await authorizeProductionAction(fixture, task, backendSelection ? {
      ownedPaths: helperSelection ? ['forge-server/example/src/test/java/example/RemarkFixture.java'] : [
        'forge-server/example/src/test/java/example/MapperTest.java',
        'forge-server/example/src/test/java/example/OtherTest.java',
        'forge-server/second/src/test/java/second/ConsumerTest.java',
      ],
    } : {});
    let projection = authorization.projection;
    if (condition === 'failed') projection = { ...projection, outcome: 'BOUNDED_BLOCKED' };
    if (condition.startsWith('semantic') || condition === 'shared-owner' || backendSelection) {
      const { summaryDigest, ...ledgerPayload } = projection.ledgerSummary;
      ledgerPayload.counts = { total: 1, open: 1, closed: 0, stale: 0 };
      ledgerPayload.open = ['contract:api-error-and-auth-contract'];
      if (condition === 'shared-owner') ledgerPayload.open = ['shared-owner:inventory'];
      if (backendSelection) ledgerPayload.open = ['verification:backend-test-class'];
      if (condition === 'semantic-mixed') {
        ledgerPayload.open.push('verification:backend-module-test');
        ledgerPayload.counts = { total: 2, open: 2, closed: 0, stale: 0 };
      }
      if (condition.endsWith('-stale')) ledgerPayload.sourceFingerprint = '0'.repeat(64);
      const ledgerSummary = { ...ledgerPayload, summaryDigest: canonicalSha256(ledgerPayload) };
      const { gateDigest, ...payload } = projection;
      Object.assign(payload, {
        outcome: 'BOUNDED_BLOCKED', maximumTerminalOutcome: 'BOUNDED_BLOCKED',
        signedVerdictVerified: false, ledgerSummary,
        ledgerSummaryDigest: ledgerSummary.summaryDigest,
        sourceFingerprint: `sha256:${ledgerPayload.sourceFingerprint}`,
        blockers: [{ code: 'OBLIGATION_LEDGER_OPEN', detail: 'private-review-detail-must-not-be-exposed' }],
        cannotClaim: ['accepted', 'complete', 'released'],
      });
      if (helperSelection) payload.backendTestSelectors = {
        modules: ['forge-server/example'], tests: ['example.RemarkValidation'],
      };
      projection = { ...payload, gateDigest: canonicalSha256(payload) };
    }
    if (condition === 'stale') {
      const ledgerPayload = {
        ...projection.ledgerSummary, sourceFingerprint: '0'.repeat(64),
      };
      delete ledgerPayload.summaryDigest;
      const ledgerSummary = { ...ledgerPayload, summaryDigest: canonicalSha256(ledgerPayload) };
      const payload = {
        ...projection, sourceFingerprint: `sha256:${'0'.repeat(64)}`,
        ledgerSummary, ledgerSummaryDigest: ledgerSummary.summaryDigest,
      };
      delete payload.gateDigest;
      projection = { ...payload, gateDigest: canonicalSha256(payload) };
    }
    let runnerReleaseCalls = 0;
    let promoteCalls = 0;
    const broker = new TaskspaceBroker({
      projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
      releaseClient: async (request) => {
        if (request.action === 'release') runnerReleaseCalls += 1;
        return { jobId: 'must-not-run' };
      },
      protectedCompletionClient: async () => {
        if (condition === 'missing') throw new Error('missing');
        return projection;
      },
    });
    const promoteCandidate = broker.promoteCandidate.bind(broker);
    broker.promoteCandidate = async (...args) => {
      promoteCalls += 1;
      return promoteCandidate(...args);
    };
    await assert.rejects(
      broker.executeAuthenticated(task.token, {
        action: 'release', services: ['forge-admin'], approvalRef: `Reject ${condition} acceptance.`,
      }),
      (error) => {
        assert.equal(error.code, 'TASKSPACE_ACCEPTANCE_NOT_READY');
        assert.doesNotMatch(error.recommendedAction, /new protected verification and independent acceptance cycle/u);
        assert.match(error.recommendedAction, /forge-verify run --reuse-receipt/u);
        if (condition === 'backend-selection') {
          assert.match(error.recommendedAction, /forge-server\/example/);
          assert.match(error.recommendedAction, /forge-server\/second/);
          assert.match(error.recommendedAction, /example\.MapperTest/);
          assert.match(error.recommendedAction, /example\.OtherTest/);
          assert.match(error.recommendedAction, /second\.ConsumerTest/);
          assert.match(error.recommendedAction, /一份.*回执/);
        } else assert.doesNotMatch(error.recommendedAction, /second\.ConsumerTest/);
        if (condition === 'backend-selection-helper') {
          assert.match(error.recommendedAction, /example\.RemarkValidation/);
          assert.doesNotMatch(error.recommendedAction, /example\.RemarkFixture/);
        } else assert.doesNotMatch(error.recommendedAction, /example\.RemarkValidation/);
        if (condition === 'shared-owner') assert.match(error.message, /shared-owner:inventory/u);
        if (condition === 'semantic' || condition === 'semantic-mixed') {
          assert.match(error.message, /contract:api-error-and-auth-contract/u);
          assert.match(error.recommendedAction, /独立.*审查/u);
          assert.match(error.recommendedAction, /不能由重复.*测试替代/u);
          assert.match(error.recommendedAction, /既有受控发布入口/u);
          assert.doesNotMatch(error.recommendedAction, /由平台提供.*路径/u);
          if (condition === 'semantic-mixed') {
            assert.match(error.message, /verification:backend-module-test/u);
            assert.match(error.recommendedAction, /还缺其他义务/u);
          }
        } else {
          assert.doesNotMatch(error.message, /contract:api-error-and-auth-contract/u,
            'stale or unverified projections must not describe their old obligations as current');
        }
        assert.doesNotMatch(`${error.message} ${error.recommendedAction}`, /private-review-detail/u);
        return true;
      },
      condition,
    );
    assert.equal(promoteCalls, 0, condition);
    assert.equal(runnerReleaseCalls, 0, condition);
    assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), fixture.baseCommit, condition);
  }
});

test('Host release obtains independent review and rechecks protected acceptance before promotion', async (t) => {
  for (const condition of ['approved', 'rejected', 'source-changed', 'still-blocked', 'old-host', 'stale-projection']) {
    await t.test(condition, async () => {
      const fixture = await createFixture();
      const task = fixture.tasks.get('task-a');
      const authorization = await authorizeProductionAction(fixture, task);
      const contractPath = await writeHostInventoryContract(fixture, condition === 'old-host' ? {} : {
        processIsolation: 'bubblewrap', independentReview: 'api-error-and-auth-contract',
      });
      const { summaryDigest, ...ledger } = authorization.projection.ledgerSummary;
      Object.assign(ledger, { counts: { total: 1, open: 1, closed: 0, stale: 0 }, open: ['contract:api-error-and-auth-contract'] });
      if (condition === 'stale-projection') ledger.sourceFingerprint = '0'.repeat(64);
      const ledgerSummary = { ...ledger, summaryDigest: canonicalSha256(ledger) };
      const { gateDigest, ...payload } = authorization.projection;
      Object.assign(payload, {
        outcome: 'BOUNDED_BLOCKED', maximumTerminalOutcome: 'BOUNDED_BLOCKED', signedVerdictVerified: false,
        ledgerSummary, ledgerSummaryDigest: ledgerSummary.summaryDigest,
        sourceFingerprint: `sha256:${ledger.sourceFingerprint}`,
        blockers: [{ code: 'OBLIGATION_LEDGER_OPEN' }], cannotClaim: ['released'],
      });
      let projection = { ...payload, gateDigest: canonicalSha256(payload) };
      const events = [];
      const release = releaseStub();
      const broker = new TaskspaceBroker({
        projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
        verificationMode: 'host-toolchain', verificationContractPath: contractPath,
        protectedCompletionClient: async () => { events.push('projection'); return projection; },
        verificationClient: async (request) => {
          events.push('independent-review');
          assert.deepEqual(request, {
            action: 'semantic-review', taskId: task.taskId, acceptanceContractId: authorization.context.contractId,
          });
          if (condition === 'rejected') throw Object.assign(new Error('read the independent report'), { code: 'VERIFY_SEMANTIC_REVIEW_REJECTED' });
          if (condition === 'source-changed') await writeFile(path.join(task.workspace, 'shared.txt'), 'changed during review\n');
          if (condition !== 'still-blocked') projection = authorization.projection;
          return { status: 'complete' };
        },
        releaseClient: async (request) => { if (['prepare', 'release'].includes(request.action)) events.push(request.action); return release.client(request); },
      });
      broker.promoteCandidate = async () => { events.push('promote'); };
      const action = broker.executeAuthenticated(task.token, {
        action: 'release', services: ['forge-admin'], approvalRef: 'Review and release this exact candidate.',
      });
      if (condition === 'approved') {
        await action;
        assert.deepEqual(events, ['projection', 'independent-review', 'projection', 'prepare', 'projection', 'promote', 'release']);
      } else {
        const code = condition === 'rejected' ? 'VERIFY_SEMANTIC_REVIEW_REJECTED'
          : condition === 'source-changed' ? 'TASKSPACE_RELEASE_AUTHORITY_STALE' : 'TASKSPACE_ACCEPTANCE_NOT_READY';
        await assert.rejects(action, { code });
        assert.equal(events.includes('promote'), false);
        assert.equal(events.includes('release'), false);
        assert.equal(events.includes('independent-review'), !['old-host', 'stale-projection'].includes(condition));
      }
    });
  }
});

test('one AI can keep working while another promotes and releases an isolated candidate', async () => {
  const fixture = await createFixture();
  const { VERIFY_PROFILE_NAMES } = await import('../docker/harness/verify-policy.mjs');
  const fixtureContractPath = path.join(fixture.projectRoot, 'verification', 'contract.json');
  const fixtureContract = JSON.parse(await readFile(fixtureContractPath, 'utf8'));
  await writeFile(fixtureContractPath, JSON.stringify({ ...fixtureContract, profiles: [...VERIFY_PROFILE_NAMES] }));
  const taskA = fixture.tasks.get('task-a');
  const taskB = fixture.tasks.get('task-b');
  await writeFile(path.join(taskA.workspace, 'shared.txt'), 'A is still working\n');
  await writeFile(path.join(taskB.workspace, 'shared.txt'), 'B candidate\n');
  const headB = await commit(taskB.workspace, 'B candidate');
  const authorization = await authorizeProductionAction(fixture, taskB);
  const stub = releaseStub();
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: stub.client,
    protectedCompletionClient: authorization.protectedCompletionClient,
  });

  const released = await broker.executeAuthenticated(taskB.token, {
    action: 'release',
    services: ['forge-admin'],
    approvalRef: 'B requested the reviewed TaskSpace release.',
  });

  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), headB);
  assert.equal(released.taskspace.taskId, 'task-b');
  assert.equal(await readFile(path.join(taskA.workspace, 'shared.txt'), 'utf8'), 'A is still working\n');
  assert.match(await git(taskA.workspace, 'status', '--porcelain'), /M shared\.txt$/m);
  const releaseCall = stub.calls.find((call) => call.action === 'release');
  assert.deepEqual(releaseCall.provenance, {
    source: 'taskspace',
    taskId: 'task-b',
    actorId: 'actor-b',
    conversationId: 'conversation-b',
    candidateCommit: headB,
  });
  const releaseAudit = (await readFile(path.join(fixture.projectRoot, 'taskspaces', '.broker', 'audit.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line)).findLast(item => item.type === 'taskspace-release' && item.status === 'success');
  assert.equal(releaseAudit.projectSlug, 'forge-base');
  assert.equal(releaseAudit.deliveryCenterSnapshot.commit, headB);
  assert.equal(releaseAudit.deliveryCenterSnapshot.status, 'unknown');
  assert.equal(releaseAudit.deliveryCenterSnapshot.reason, 'PHASE_SOURCE_UNAVAILABLE');
});

test('a required private remote without the pinned SSH command blocks before local promotion', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  await writeFile(path.join(task.workspace, 'shared.txt'), 'candidate without attached SSH trust\n');
  await commit(task.workspace, 'candidate without attached SSH trust');
  const authorization = await authorizeProductionAction(fixture, task);
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: releaseStub().client,
    protectedCompletionClient: authorization.protectedCompletionClient,
    gitRemoteRequired: true,
    gitRemoteReady: true,
    gitRemoteName: 'origin',
    gitRemoteBranch: 'main',
    gitSshCommand: '',
  });

  await assert.rejects(
    broker.executeAuthenticated(task.token, {
      action: 'release', services: ['forge-admin'], approvalRef: 'Owner approved release.',
    }),
    (error) => error.code === 'TASKSPACE_GIT_REMOTE_NOT_READY',
  );
  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), fixture.baseCommit);
});

test('a required private remote is fast-forwarded and verified before local integration promotion', async () => {
  const fixture = await createFixture();
  const remote = await attachLocalPrivateRemote(fixture);
  const task = fixture.tasks.get('task-a');
  await writeFile(path.join(task.workspace, 'shared.txt'), 'durable remote candidate\n');
  const candidate = await commit(task.workspace, 'durable remote candidate');
  const authorization = await authorizeProductionAction(fixture, task);
  const stub = releaseStub();
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: stub.client,
    protectedCompletionClient: authorization.protectedCompletionClient,
    gitRemoteRequired: true,
    gitRemoteReady: true,
    gitRemoteName: 'origin',
    gitRemoteBranch: remote.branch,
    gitSshCommand: 'ssh -o BatchMode=yes',
  });

  await broker.executeAuthenticated(task.token, {
    action: 'release', services: ['forge-admin'], approvalRef: 'Owner approved durable release.',
  });

  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), candidate);
  assert.equal(await git(remote.remoteRoot, 'rev-parse', `refs/heads/${remote.branch}`), candidate);
});

test('remote drift blocks promotion without changing the local integration HEAD', async () => {
  const fixture = await createFixture();
  const remote = await attachLocalPrivateRemote(fixture);
  const task = fixture.tasks.get('task-a');
  await writeFile(path.join(task.workspace, 'shared.txt'), 'candidate based on old integration\n');
  await commit(task.workspace, 'candidate based on old integration');
  const authorization = await authorizeProductionAction(fixture, task);

  const driftClone = path.join(fixture.projectRoot, 'remote-writer');
  await execFileAsync('git', ['clone', remote.remoteRoot, driftClone], { encoding: 'utf8' });
  await git(driftClone, 'config', 'user.name', 'Remote Writer');
  await git(driftClone, 'config', 'user.email', 'remote-writer@example.invalid');
  await writeFile(path.join(driftClone, 'remote.txt'), 'unexpected remote commit\n');
  await commit(driftClone, 'unexpected remote commit');
  await git(driftClone, 'push', 'origin', remote.branch);

  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: releaseStub().client,
    protectedCompletionClient: authorization.protectedCompletionClient,
    gitRemoteRequired: true,
    gitRemoteReady: true,
    gitRemoteName: 'origin',
    gitRemoteBranch: remote.branch,
    gitSshCommand: 'ssh -o BatchMode=yes',
  });

  await assert.rejects(
    broker.executeAuthenticated(task.token, {
      action: 'release', services: ['forge-admin'], approvalRef: 'Owner approved release.',
    }),
    (error) => error.code === 'TASKSPACE_GIT_REMOTE_DIVERGED',
  );
  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), fixture.baseCommit);
});

test('release operation tracking preserves one admitted operation, ownership and real terminal', { skip: process.platform !== 'linux', timeout: 20000 }, async (t) => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const other = fixture.tasks.get('task-b');
  const authorization = await authorizeProductionAction(fixture, task);
  let finish;
  let enter;
  const held = new Promise(resolve => { finish = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  t.after(() => finish());
  const stub = releaseStub({ prepare: async (request) => {
    enter(); await held;
    return { status: 'prepared', jobId: '123e4567-e89b-42d3-a456-426614174229', commit: request.provenance.candidateCommit };
  } });
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
    releaseClient: stub.client, releaseStatusClient: stub.client, protectedCompletionClient: authorization.protectedCompletionClient });
  const request = { action: 'release', services: ['forge-ui'], approvalRef: 'Owner authorized current release.', executionMode: 'background' };
  const accepted = await broker.executeAuthenticated(task.token, request);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.terminal, false);
  await entered;
  const operationId = accepted.operationId;
  assert.equal(broker.activeRelease.operationId, operationId);
  const running = await broker.executeAuthenticated(task.token, { action: 'status', operationId });
  assert.equal(running.release.operation.operationId, operationId);
  assert.equal(running.release.operation.status, 'running');
  const status = await broker.executeAuthenticated(task.token, { action: 'status' });
  assert.equal(status.release.ownership, 'same-task');
  assert.equal(status.release.operation.operationId, operationId);
  for (const [caller, owner] of [[task, 'same-task'], [other, 'other-task']]) {
    await assert.rejects(broker.executeAuthenticated(caller.token, request), error =>
      error.code === 'TASKSPACE_RELEASE_IN_PROGRESS' && error.releaseOwner === owner && error.operationId === operationId);
  }
  const secondBroker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', releaseClient: stub.client });
  await assert.rejects(secondBroker.executeAuthenticated(task.token, request), error =>
    error.code === 'TASKSPACE_RELEASE_IN_PROGRESS' && error.releaseOwner === 'same-task' && error.operationId === operationId);
  assert.equal((await broker.executeAuthenticated(other.token, { action: 'status', operationId })).release.operation, null);
  let drained = false;
  const drainage = broker.waitForReleases().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false);
  finish();
  await drainage;
  assert.equal(broker.activeRelease, null);
  assert.equal(stub.calls.filter(value => value.action === 'prepare').length, 1);
  assert.equal(stub.calls.filter(value => value.action === 'release').length, 1);
  const terminal = await broker.executeAuthenticated(task.token, { action: 'status', operationId });
  assert.equal(terminal.release.operation.operationId, operationId);
  assert.equal(terminal.release.operation.status, 'success');
  const unrelated = await broker.executeAuthenticated(task.token, { action: 'status', operationId: randomUUID() });
  assert.equal(unrelated.release.availability, 'unknown');
  assert.equal(unrelated.release.operation, null);
  // The task's existing saved result survives a later project status overwrite.
  const laterOperationId = randomUUID();
  await writeFile(broker.releaseStateFile, JSON.stringify({ operationId: laterOperationId, taskId: other.taskId,
    status: 'failed', completedAt: new Date(Date.now() + 1000).toISOString() }));
  const history = await broker.executeAuthenticated(task.token, { action: 'status' });
  assert.equal(history.release.ownership, 'other-task');
  assert.equal(history.release.operation.operationId, laterOperationId);
  assert.equal(history.release.operation.status, 'failed');
  assert.equal(history.release.operation.taskId, other.taskId);
  assert.equal(history.release.lastTaskRelease.operationId, operationId);
  assert.equal(history.release.lastTaskRelease.status, 'success');
  assert.equal(history.release.lastTaskRelease.taskId, task.taskId);
  assert.equal(history.release.lastTaskRelease.commit, terminal.release.operation.commit);
  assert.equal(history.release.lastTaskRelease.completedAt, terminal.release.operation.completedAt);
  assert.equal((await broker.executeAuthenticated(other.token, { action: 'status' })).release.lastTaskRelease, null);
  assert.equal((await broker.executeAuthenticated(task.token, { action: 'status', operationId })).release.operation.status, 'success');
});

test('release operation tracking rejects failed admission and preserves asynchronous failure', { skip: process.platform !== 'linux', timeout: 20000 }, async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const authorization = await authorizeProductionAction(fixture, task);
  const stub = releaseStub({ prepare: async () => { throw taskspaceError('TEST_PREPARATION_FAILED', 'Real preparation failure.'); } });
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
    releaseClient: stub.client, releaseStatusClient: stub.client, protectedCompletionClient: authorization.protectedCompletionClient });
  const request = { action: 'release', services: ['forge-ui'], approvalRef: 'Owner authorized current release.', executionMode: 'background' };
  const original = await readFile(path.join(task.workspace, 'shared.txt'));
  await writeFile(path.join(task.workspace, 'shared.txt'), 'Unadmitted dirty candidate\n');
  await assert.rejects(broker.executeAuthenticated(task.token, request), error => error.code === 'TASKSPACE_DIRTY');
  assert.equal(stub.calls.some(value => value.action === 'prepare'), false);
  await writeFile(path.join(task.workspace, 'shared.txt'), original);
  const accepted = await broker.executeAuthenticated(task.token, request);
  assert.equal(accepted.status, 'accepted');
  await broker.waitForReleases();
  const observed = await broker.executeAuthenticated(task.token, { action: 'status', operationId: accepted.operationId });
  assert.equal(observed.release.operation.operationId, accepted.operationId);
  assert.equal(observed.release.operation.status, 'failed');
  assert.equal((await broker.diagnose()).lastRelease.error.code, 'TEST_PREPARATION_FAILED');
  assert.equal(stub.calls.filter(value => value.action === 'prepare').length, 1);
  assert.equal(stub.calls.some(value => value.action === 'release'), false);
});

test('concurrent project release requests allow one active TaskSpace release only', async () => {
  const fixture = await createFixture();
  const taskA = fixture.tasks.get('task-a');
  const taskB = fixture.tasks.get('task-b');
  await writeFile(path.join(taskA.workspace, 'shared.txt'), 'A release\n');
  await commit(taskA.workspace, 'A release');
  await writeFile(path.join(taskB.workspace, 'migration.sql'), '-- B release\n');
  await commit(taskB.workspace, 'B release');
  const authorization = await authorizeProductionAction(fixture, taskA);
  let unblock;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const blockedPromise = new Promise((resolve) => { unblock = resolve; });
  const stub = releaseStub({
    client: async (request) => {
      if (request.action !== 'release') return { workspaceClean: true };
      started();
      await blockedPromise;
      return { jobId: 'job-a', commit: request.provenance.candidateCommit };
    },
  });
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: stub.client,
    protectedCompletionClient: authorization.protectedCompletionClient,
  });

  const releaseA = broker.executeAuthenticated(taskA.token, {
    action: 'release', services: ['forge-admin'], approvalRef: 'A approved release.',
  });
  await startedPromise;
  await assert.rejects(
    broker.executeAuthenticated(taskB.token, {
      action: 'release', services: ['forge-admin'], approvalRef: 'B approved release.',
    }),
    (error) => error.code === 'TASKSPACE_RELEASE_IN_PROGRESS' && error.retryable === true,
  );
  unblock();
  await releaseA;
  const audit = (await readFile(path.join(fixture.taskspacesRoot, '.broker', 'audit.jsonl'), 'utf8'))
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(audit.some((entry) => entry.status === 'rejected'
    && entry.taskId === 'task-b'
    && entry.error.code === 'TASKSPACE_RELEASE_IN_PROGRESS'
    && entry.activeRelease.taskId === 'task-a'));
});

test('the persistent project lock rejects a concurrent release from a second Broker instance', async () => {
  const fixture = await createFixture();
  const taskA = fixture.tasks.get('task-a');
  const taskB = fixture.tasks.get('task-b');
  await writeFile(path.join(taskA.workspace, 'shared.txt'), 'A release from broker one\n');
  await commit(taskA.workspace, 'A release from broker one');
  await writeFile(path.join(taskB.workspace, 'migration.sql'), '-- B release from broker two\n');
  await commit(taskB.workspace, 'B release from broker two');
  const authorization = await authorizeProductionAction(fixture, taskA);
  let unblock;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const blockedPromise = new Promise((resolve) => { unblock = resolve; });
  const stub = releaseStub({
    client: async (request) => {
      if (request.action === 'diagnose') return { active: true };
      if (request.action !== 'release') return { workspaceClean: true };
      started();
      await blockedPromise;
      return { jobId: 'job-cross-broker', commit: request.provenance.candidateCommit };
    },
  });
  const brokerOne = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: stub.client,
    protectedCompletionClient: authorization.protectedCompletionClient,
  });
  const brokerTwo = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: stub.client,
  });

  const releaseA = brokerOne.executeAuthenticated(taskA.token, {
    action: 'release', services: ['forge-admin'], approvalRef: 'A approved release.',
  });
  await startedPromise;
  await assert.rejects(
    brokerTwo.executeAuthenticated(taskB.token, {
      action: 'release', services: ['forge-admin'], approvalRef: 'B approved release.',
    }),
    (error) => error.code === 'TASKSPACE_RELEASE_IN_PROGRESS',
  );
  unblock();
  await releaseA;
  const audit = (await readFile(path.join(fixture.taskspacesRoot, '.broker', 'audit.jsonl'), 'utf8'))
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(audit.some((entry) => entry.status === 'rejected'
    && entry.taskId === 'task-b'
    && entry.error.code === 'TASKSPACE_RELEASE_IN_PROGRESS'
    && typeof entry.operationId === 'string'));
});

test('a restarted Broker recovers an expired lock only after Runner reports no active release', async () => {
  const fixture = await createFixture();
  const taskA = fixture.tasks.get('task-a');
  await writeFile(path.join(taskA.workspace, 'shared.txt'), 'release after broker restart\n');
  const candidate = await commit(taskA.workspace, 'release after broker restart');
  const authorization = await authorizeProductionAction(fixture, taskA);
  const lockRoot = path.join(fixture.taskspacesRoot, '.broker', 'release.lock');
  await mkdir(lockRoot, { recursive: true });
  await writeFile(path.join(lockRoot, 'owner.json'), JSON.stringify({
    schemaVersion: 1,
    instanceId: 'terminated-broker',
    operationId: 'interrupted-operation',
    taskId: 'task-a',
    actorId: 'actor-a',
    createdAt: '2026-01-01T00:00:00.000Z',
  }));
  const stub = releaseStub();
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: stub.client,
    protectedCompletionClient: authorization.protectedCompletionClient,
    staleLockAfterMs: 0,
  });
  const released = await broker.executeAuthenticated(taskA.token, {
    action: 'release', services: ['forge-admin'], approvalRef: 'A approved recovered release.',
  });
  assert.equal(released.commit, candidate);
  const audit = await readFile(path.join(fixture.taskspacesRoot, '.broker', 'audit.jsonl'), 'utf8');
  assert.match(audit, /taskspace-release-lock-recovery/);
  assert.match(audit, /terminated-broker/);
});

test('a later release of the same module must integrate the commit released immediately before it', async () => {
  const fixture = await createFixture();
  const taskA = fixture.tasks.get('task-a');
  const taskB = fixture.tasks.get('task-b');
  await writeFile(path.join(taskA.workspace, 'shared.txt'), 'A module version\n');
  const headA = await commit(taskA.workspace, 'A module release');
  await writeFile(path.join(taskB.workspace, 'shared.txt'), 'B module version\n');
  await commit(taskB.workspace, 'B module release');
  const authorizations = new Map();
  authorizations.set(taskA.taskId, await authorizeProductionAction(fixture, taskA));
  const stub = releaseStub();
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: stub.client,
    protectedCompletionClient: async (body) => authorizations.get(body.taskId).projection,
  });

  await broker.executeAuthenticated(taskA.token, {
    action: 'release', services: ['forge-admin'], approvalRef: 'A approved release.',
  });
  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), headA);
  await assert.rejects(
    broker.executeAuthenticated(taskB.token, {
      action: 'release', services: ['forge-admin'], approvalRef: 'B approved release.',
    }),
    (error) => error.code === 'TASKSPACE_REBASE_REQUIRED',
  );

  await git(taskB.workspace, 'fetch', fixture.workspaceRoot, headA);
  await assert.rejects(
    git(taskB.workspace, 'rebase', headA),
    /CONFLICT|could not apply|returned non-zero|exit code/i,
  );
  await git(taskB.workspace, 'rebase', '--abort');
  await git(taskB.workspace, 'merge', '--no-edit', '-s', 'ours', headA);
  await writeFile(path.join(taskB.workspace, 'shared.txt'), 'A and B reconciled module\n');
  const reconciledHead = await commit(taskB.workspace, 'reconcile A and B module changes');
  authorizations.set(taskB.taskId, await authorizeProductionAction(fixture, taskB));
  const releasedB = await broker.executeAuthenticated(taskB.token, {
    action: 'release', services: ['forge-admin'], approvalRef: 'B approved reconciled release.',
  });
  assert.equal(releasedB.taskspace.head, reconciledHead);
  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), reconciledHead);
});

test('a failed database migration remains project-scoped and the corrected forward release can recover', async () => {
  const fixture = await createFixture();
  const taskA = fixture.tasks.get('task-a');
  const taskB = fixture.tasks.get('task-b');
  await writeFile(path.join(taskA.workspace, 'migration.sql'), 'INVALID MIGRATION\n');
  const failedCommit = await commit(taskA.workspace, 'invalid migration candidate');
  let authorization = await authorizeProductionAction(fixture, taskA);
  let releaseAttempts = 0;
  const stub = releaseStub({
    prepare: async (request) => {
      releaseAttempts += 1;
      if (releaseAttempts === 1) {
        const error = new Error('Candidate test migration failed.');
        error.code = 'MIGRATION_VALIDATION_FAILED';
        error.retryable = false;
        throw error;
      }
      return { status: 'prepared', jobId: '123e4567-e89b-42d3-a456-426614174229', commit: request.provenance.candidateCommit };
    },
    client: async (request) => {
      if (request.action !== 'release') return { active: false };
      return {
        jobId: 'job-recovered',
        commit: request.provenance.candidateCommit,
        testDatabaseSandbox: { status: 'healthy', restoredFromVerifiedSnapshot: true },
      };
    },
  });
  const broker = new TaskspaceBroker({
    projectRoot: fixture.projectRoot,
    projectSlug: 'forge-base',
    releaseClient: stub.client,
    protectedCompletionClient: async (body) => authorization.protectedCompletionClient(body),
  });

  await assert.rejects(
    broker.executeAuthenticated(taskA.token, {
      action: 'release', services: ['forge-admin'], approvalRef: 'A approved migration release.',
    }),
    (error) => error.code === 'MIGRATION_VALIDATION_FAILED',
  );
  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), fixture.baseCommit);
  assert.notEqual(failedCommit, fixture.baseCommit);
  assert.equal(await git(taskB.workspace, 'rev-parse', 'HEAD'), fixture.baseCommit);
  assert.equal(
    (await readFile(path.join(taskB.workspace, 'migration.sql'), 'utf8')).replaceAll('\r\n', '\n'),
    '-- base\n',
  );

  await writeFile(path.join(taskA.workspace, 'migration.sql'), '-- corrected forward migration\n');
  const correctedCommit = await commit(taskA.workspace, 'correct forward migration');
  authorization = await authorizeProductionAction(fixture, taskA);
  const recovered = await broker.executeAuthenticated(taskA.token, {
    action: 'release', services: ['forge-admin'], approvalRef: 'A approved corrected migration release.',
  });
  assert.equal(recovered.commit, correctedCommit);
  assert.equal(recovered.testDatabaseSandbox.restoredFromVerifiedSnapshot, true);
  const state = JSON.parse(await readFile(path.join(fixture.taskspacesRoot, '.broker', 'release-state.json'), 'utf8'));
  assert.equal(state.status, 'success');
  assert.equal(state.commit, correctedCommit);
});


test('candidate build or startup failure cannot advance the shared integration branch', async (t) => {
  for (const code of ['CANDIDATE_BUILD_FAILED', 'MIGRATION_EXECUTION_FAILED']) {
    await t.test(code, async () => {
      const fixture = await createFixture();
      const task = fixture.tasks.get('task-a');
      const remote = await attachLocalPrivateRemote(fixture);
      await writeFile(path.join(task.workspace, 'migration.sql'), '-- unverified candidate\n');
      await commit(task.workspace, 'Draft candidate awaiting runtime validation');
      const authorization = await authorizeProductionAction(fixture, task);
      const calls = [];
      const broker = new TaskspaceBroker({
        projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
        gitRemoteRequired: true, gitRemoteReady: true, gitRemoteName: 'origin',
        gitRemoteBranch: remote.branch, gitSshCommand: 'ssh -o BatchMode=yes',
        protectedCompletionClient: authorization.protectedCompletionClient,
        releaseClient: async (request) => {
          calls.push(request.action);
          if (['prepare', 'release'].includes(request.action)) {
            throw Object.assign(new Error('Candidate runtime validation failed'), { code });
          }
          return { active: false };
        },
      });
      await assert.rejects(broker.executeAuthenticated(task.token, {
        action: 'release', services: ['forge-admin'], approvalRef: 'Owner approved the candidate release.',
      }), (error) => error.code === code);
      assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), fixture.baseCommit);
      assert.equal(await git(remote.remoteRoot, 'rev-parse', 'refs/heads/' + remote.branch), fixture.baseCommit);
      assert.deepEqual(calls.filter((action) => ['prepare', 'release'].includes(action)), ['prepare']);
    });
  }
});


function directBroker(fixture, options = {}) {
  const broker = new TaskspaceBroker({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base',
    developmentMode: 'direct', ...options });
  // Windows cannot execute Linux flock. The same cases use real locking when
  // run in the target Linux image; this local adapter covers only the caller.
  if (process.platform === 'win32') {
    broker.acquireTaskOperationLock = async () => {};
    broker.releaseTaskOperationLock = async () => {};
  }
  return broker;
}

test('container direct broker sends optional compile synchronously to its real executor type', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  await authorizeProductionAction(fixture, task, {
    actionCeiling: 'workspace-write', ownedPaths: ['.'], developmentMode: 'direct',
  });
  const broker = directBroker(fixture, { verificationMode: 'container-toolchain' });
  const requests = [];
  broker.callVerification = async request => { requests.push(request); return { status: 'passed' }; };
  const request = { action: 'verify-run', profile: 'backend-module-compile',
    selectors: { modules: ['forge-server/forge-business/forge-business-core'] },
    idempotencyKey: 'container-direct-compile', admissionId: randomUUID(), executionMode: 'background' };
  await broker.executeAuthenticated(task.token, request);
  assert.equal(requests[0].executionMode, undefined);
  assert.equal(requests[0].candidateBinding.actionCeiling, 'workspace-write');
  broker.verificationMode = 'host-toolchain';
  await broker.executeAuthenticated(task.token, request);
  assert.equal(requests[1].executionMode, 'background');
});

test('direct development checkpoint saves ordinary workspace files without a development whitelist', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  const authorization = await authorizeProductionAction(fixture, task, {
    actionCeiling: 'git-checkpoint', ownedPaths: ['.'], developmentMode: 'direct',
  });
  await writeFile(path.join(task.workspace, 'shared.txt'), 'direct source change\n');
  const changedSource = await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS);
  const broker = directBroker(fixture, { protectedCandidateBindingClient: async () => assert.fail('Direct save cannot require prior Host verification') });
  const result = await broker.executeAuthenticated(task.token, {
    action: 'checkpoint', paths: ['shared.txt'], message: 'Save direct source',
    expectedHead: authorization.source.head, expectedWorkspaceFingerprint: changedSource.workspaceFingerprint,
  });
  assert.notEqual(result.commit ?? result.head, fixture.baseCommit);
  assert.equal(await git(task.workspace, 'status', '--porcelain=v1'), '');
  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), fixture.baseCommit);
  const authenticated = await broker.taskForToken(task.token);
  await writeFile(path.join(task.workspace, 'PROJECT_CONTEXT.md'), 'platform authority');
  await assert.rejects(broker.assertCheckpointPaths(authenticated, ['PROJECT_CONTEXT.md'], ['.'], authorization.context),
    { code: 'TASKSPACE_CHECKPOINT_PATH_DENIED' });
  await writeFile(path.join(task.workspace, '.env'), 'local-value');
  await assert.rejects(broker.assertCheckpointPaths(authenticated, ['.env'], ['.'], authorization.context),
    { code: 'TASKSPACE_CHECKPOINT_PATH_DENIED' });
});

test('direct development verification permits an optional profile outside the empty development contract', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  await authorizeProductionAction(fixture, task, { actionCeiling: 'workspace-write', ownedPaths: ['.'], developmentMode: 'direct' });
  const requests = [];
  const broker = directBroker(fixture, { verificationClient: async request => { requests.push(request); return { status: 'failed', executionProven: true }; } });
  const receipt = await broker.executeAuthenticated(task.token, { action: 'verify-run', profile: 'backend-module-compile',
    selectors: { modules: ['forge-server/example'] }, admissionId: randomUUID(), idempotencyKey: 'direct-optional-compile' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].taskId, task.taskId);
  assert.equal(receipt.status, 'failed');
});

test('admitted direct release survives status turns while cancellation and source identity remain enforced', async t => {
  for (const condition of ['status', 'status-after-expiry', 'stop-then-status', 'new-source', 'stopped-task', 'other-session']) {
    await t.test(condition, async () => {
      const fixture = await createFixture(); const task = fixture.tasks.get('task-a');
      await writeFile(path.join(task.workspace, 'shared.txt'), 'release continuity\n');
      const candidate = await commit(task.workspace, 'release continuity candidate');
      const authorization = await authorizeProductionAction(fixture, task, { ownedPaths: ['.'], developmentMode: 'direct' });
      const original = authorization.context; const releases = [];
      const readOnlyTurn = async (prompt, offset) => {
        const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request',
          rpcId: `rpc:release-observation:${condition}:${offset}`, method: 'session.prompt', payload: {
            sessionId: condition === 'other-session' ? 'session:other' : original.dshSessionId,
            mode: 'queue', content: [{ type: 'text', text: prompt }],
          } })), 'session.prompt');
        await prepareProtectedExecutionContext({ projectRoot: fixture.projectRoot, projectSlug: 'forge-base', taskMetadata: task.metadata,
          request: { ...classified, actorUserId: original.actorUserId, actorUsername: original.actorUsername,
            conversationId: original.conversationId, requestId: `request:observation:${offset}` },
          now: Date.now() + offset, policyPath: path.resolve('docker/harness/forge-execution-policy.json') });
      };
      const broker = directBroker(fixture, { releaseClient: async request => {
        releases.push(request);
        if (request.action === 'prepare') {
          if (condition === 'stop-then-status') await readOnlyTurn('停止执行。', 1);
          await readOnlyTurn('仅查看当前发版进度，不需要新操作。', 2);
          if (condition === 'status-after-expiry') {
            const file = path.join(fixture.projectRoot, 'taskspaces/.broker/executions', `${task.taskId}.json`);
            const state = JSON.parse(await readFile(file, 'utf8'));
            state.current.issuedAt = new Date(Date.now() - 120000).toISOString();
            state.current.expiresAt = new Date(Date.now() - 60000).toISOString();
            await writeFile(file, JSON.stringify(state));
          }
          if (condition === 'new-source') await writeFile(path.join(task.workspace, 'shared.txt'), 'changed');
          if (condition === 'stopped-task') await writeFile(path.join(task.root, 'metadata.json'), JSON.stringify({ ...task.metadata, status: 'stopped' }));
          return { status: 'prepared', jobId: '123e4567-e89b-42d3-a456-426614174229', commit: candidate };
        }
        return { jobId: 'real-runner-result', commit: candidate, testDatabaseSandbox: { status: 'healthy' } };
      } });
      const result = broker.executeAuthenticated(task.token, { action: 'release', services: ['forge-ui'], approvalRef: 'Current user release' });
      if (['status', 'status-after-expiry'].includes(condition)) {
        await result; assert.deepEqual(releases.map(x => x.action), ['prepare', 'release']);
      } else {
        await assert.rejects(result, { code: condition === 'stop-then-status' ? 'TASKSPACE_RELEASE_CANCELLED'
          : condition === 'new-source' ? 'TASKSPACE_RELEASE_SOURCE_CHANGED' : 'TASKSPACE_RELEASE_AUTHORITY_STALE' });
        assert.equal(releases.some(x => x.action === 'release'), false);
        assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), fixture.baseCommit);
      }
    });
  }
});

test('direct development release bypasses development completion but preserves candidate preparation and authorization', async t => {
  for (const condition of ['authorized', 'no-release-authority', 'prepare-failed', 'source-drift', 'compatibility']) {
    await t.test(condition, async () => {
      const fixture = await createFixture();
      const task = fixture.tasks.get('task-a');
      await writeFile(path.join(task.workspace, 'shared.txt'), 'direct release\n');
      const candidate = await commit(task.workspace, 'direct release candidate');
      await authorizeProductionAction(fixture, task, { actionCeiling: condition === 'no-release-authority' ? 'workspace-write' : 'release',
        ownedPaths: ['.'], developmentMode: 'direct' });
      const releases = [];
      let completionCalls = 0;
      const broker = directBroker(fixture, {
        ...(condition === 'compatibility' ? { developmentMode: 'governed' } : {}),
        protectedCompletionClient: async () => { completionCalls += 1; throw new Error('Development obligations absent'); },
        releaseClient: async request => {
          releases.push(request);
          if (request.action === 'prepare') {
            if (condition === 'prepare-failed') throw new Error('Real candidate startup failed');
            if (condition === 'source-drift') await writeFile(path.join(task.workspace, 'shared.txt'), 'changed during preparation');
            return { status: 'prepared', jobId: '123e4567-e89b-42d3-a456-426614174229', commit: candidate };
          }
          return { jobId: 'real-runner-result', commit: candidate, testDatabaseSandbox: { status: 'healthy' } };
        },
      });
      const operation = broker.executeAuthenticated(task.token, { action: 'release', services: ['forge-ui'], approvalRef: 'User requested this release' });
      if (condition === 'authorized') {
        const result = await operation;
        assert.equal(result.developmentMode, 'direct');
        assert.equal(result.developmentVerification, 'not-required');
        assert.deepEqual(releases.map(item => item.action), ['prepare', 'release']);
        assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), candidate);
      } else {
        await assert.rejects(operation, condition === 'no-release-authority' ? { code: 'TASKSPACE_ACTION_CEILING_DENIED' }
          : condition === 'prepare-failed' ? /Real candidate startup failed/u
          : condition === 'source-drift' ? { code: 'TASKSPACE_RELEASE_SOURCE_CHANGED' }
          : { code: 'TASKSPACE_ACCEPTANCE_NOT_READY' });
        assert.equal(releases.some(item => item.action === 'release'), false);
        assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), fixture.baseCommit);
      }
      assert.equal(completionCalls, condition === 'compatibility' ? 1 : 0);
    });
  }
});


test('direct development integration preserves new canonical work and saves source without prior verification', async () => {
  const fixture = await createFixture();
  const task = fixture.tasks.get('task-a');
  await authorizeProductionAction(fixture, task, { actionCeiling: 'git-checkpoint', ownedPaths: ['.'], developmentMode: 'direct' });
  await writeFile(path.join(task.workspace, 'shared.txt'), 'direct task change\n');
  await writeFile(path.join(fixture.workspaceRoot, 'migration.sql'), '-- another task canonical change\n');
  const canonical = await commit(fixture.workspaceRoot, 'preserve another task');
  const source = await inventoryWorkspace(task.workspace, VERIFICATION_LIMITS);
  const broker = directBroker(fixture, { protectedCandidateBindingClient: async () => assert.fail('Direct integration does not require Host verification'),
    releaseClient: releaseStub().client });
  const result = await broker.executeAuthenticated(task.token, { action: 'integrate', mode: 'start', paths: ['shared.txt'],
    expectedHead: source.head, expectedWorkspaceFingerprint: source.workspaceFingerprint, canonicalHead: canonical });
  assert.equal(result.status, 'integrated');
  assert.equal(await readFile(path.join(task.workspace, 'shared.txt'), 'utf8'), 'direct task change\n');
  assert.equal(await readFile(path.join(task.workspace, 'migration.sql'), 'utf8'), '-- another task canonical change\n');
  assert.equal(await git(fixture.workspaceRoot, 'rev-parse', 'HEAD'), canonical);
});
