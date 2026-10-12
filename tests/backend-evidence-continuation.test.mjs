import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { beginForgeDeliveryPhase, completeForgeDeliveryPhase, createForgeDeliveryPhaseArtifact, createForgeDeliveryPhaseState,
  recordForgeAccessAcceptedCorrection, writeForgeDeliveryPhaseState, readForgeDeliveryPhaseState } from '../docker/harness/forge-delivery-phase-runtime.mjs';
import { prepareForgeDatabaseLeaseContinuation, beginForgeDeliveryBrowserPhase } from '../docker/harness/forge-delivery-phase-controller.mjs';
import { buildForgeDeliveryPhasePrompt } from '../docker/harness/forge-delivery-phase-response.mjs';
import { snapshotForgeDeliveryWorkspace, observeForgeDeliveryPhase } from '../docker/harness/forge-delivery-phase-workspace-observer.mjs';
import { classifyPinnedDshPromptBody, digestDirectUserTextContent, digestProductionTaskAuthorityBinding } from '../docker/harness/forge-execution-context.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
const catalogFile = path.resolve(import.meta.dirname, '../docker/harness/skills/forge-task-router/references/phase-profiles.json');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value) + '\n';
const stamp = '2026-09-03T00:00:00.000Z';

test('formal backend correction supplements evidence in the same candidate and attempt', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-backend-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = 'eval-backend-evidence', sessionId = 'session-backend-evidence';
  const workspace = path.join(root, taskId, 'workspace'); await mkdir(workspace, { recursive: true });
  const git = (...args) => { const r = spawnSync('git', ['-C', workspace, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'isolated fixture');
  const sourceCommit = git('rev-parse', 'HEAD');
  const directory = path.join(root, '.broker', 'delivery-phases', taskId, 'phase-control', 'access-wiring-repair', 'runtime-access-repair', 'access-wiring-repair');
  const artifactsDirectory = path.join(directory, 'artifacts'); await mkdir(artifactsDirectory, { recursive: true });
  const stateFile = path.join(directory, 'state.json'), promptFile = path.join(directory, 'current-prompt.md'), originalRequestFile = path.join(directory, 'original-request.md');
  const catalog = JSON.parse(await readFile(catalogFile, 'utf8')), phases = catalog.workflows[0].phases, backend = phases[4];
  const paths = [`${backend.ownedPaths[0]}/Evidence.java`, `${backend.ownedPaths[1]}/EvidenceTest.java`].sort();
  const putSource = async text => { for (const file of paths) { await mkdir(path.dirname(path.join(workspace, file)), { recursive: true }); await writeFile(path.join(workspace, file), text); } };
  await putSource('before\n');
  const before = await snapshotForgeDeliveryWorkspace({ workspace, baseCommit: sourceCommit });
  let state = createForgeDeliveryPhaseState({ catalog, workflowId: 'crud-production', caseFamily: 'crud-complete', taskId, sessionId, sourceCommit, now: stamp });
  const artifacts = [];
  for (let generation = 1; generation <= 7; generation++) {
    state = beginForgeDeliveryPhase({ state, catalog, phaseId: state.currentPhaseId, rpcId: `rpc-${generation}`, promptDigest: sha(`prompt-${generation}`), executionGeneration: generation, now: stamp });
    const phase = phases[state.currentPhaseIndex];
    const artifact = createForgeDeliveryPhaseArtifact({ state, catalog, phaseId: phase.id, attemptId: state.activeAttempt.attemptId,
      sourceFingerprint: sha('original-source'), changedPaths: phase.id === 'backend' ? paths : phase.patchScope === 'phase' ? [`${phase.ownedPaths[0]}/${phase.id}.txt`] : [], patchDigest: phase.patchScope === 'none' ? null : sha(phase.id),
      payload: Object.fromEntries(phase.requiredPayloadKeys.map(key => [key, {}])) });
    artifacts.push(artifact); await writeFile(path.join(artifactsDirectory, `${artifact.artifactKind}.json`), json(artifact));
    state = completeForgeDeliveryPhase({ state, catalog, decision: 'accepted', artifact, now: stamp,
      hostReceipts: phase.hostVerificationProfiles.map(profile => ({ profile, status: 'passed', receiptDigest: sha(profile), patchDigest: artifact.sourceFingerprint })) }).state;
  }
  state = beginForgeDeliveryPhase({ state, catalog, phaseId: state.currentPhaseId, rpcId: 'rpc-cross', promptDigest: sha('cross'), executionGeneration: 8, now: stamp });
  const feedback = 'Repair the current backend runtime failure.';
  state = recordForgeAccessAcceptedCorrection({ state, catalog, phaseId: 'backend', now: stamp, binding: {
    acceptedSourceFingerprint: sha('original-source'), failureEvidenceSha256: sha('failure'), jobId: null,
    executionId: crypto.randomUUID(), executionGeneration: 8, rpcId: state.activeAttempt.rpcId, workspaceFingerprint: sha('original-source'),
    candidateCommit: sourceCommit, sourceStateSha256: sha(json(state)), repairRequestSha256: sha(feedback),
    runtimeFailure: { observationId: crypto.randomUUID(), manifestSha256: sha('manifest'), formalTerminalSha256: sha('terminal') },
  } });
  const request = 'Complete the isolated backend candidate.';
  await writeFile(originalRequestFile, request);
  await writeFile(path.join(directory, `后端阶段-后验纠正请求-${state.history.at(-1).acceptedReceiptDigest}.txt`), feedback);
  const originalPrompt = buildForgeDeliveryPhasePrompt({ state, catalog, originalRequest: `${request}\n\n${feedback}`, upstreamArtifacts: artifacts.filter(item => backend.requiresArtifacts.includes(item.artifactKind)) });
  await writeFile(promptFile, originalPrompt);
  state = beginForgeDeliveryPhase({ state, catalog, phaseId: 'backend', rpcId: 'rpc-backend',
    promptDigest: digestDirectUserTextContent([{ type: 'text', text: originalPrompt }]), executionGeneration: 9, now: stamp });
  await writeForgeDeliveryPhaseState(stateFile, state, catalog);
  await writeFile(path.join(directory, 'phase-4-workspace-before.json'), json(before));
  await putSource('after\n');
  const observed = await observeForgeDeliveryPhase({ workspace, baseCommit: sourceCommit, before });
  assert.deepEqual(observed.phaseChangedPaths, paths); assert.ok(paths.every(file => Object.hasOwn(before.entries, file)));
  const contract = compileForgeTaskExecutionContract({ prompt: 'Continue current backend evidence.', actionCeiling: 'workspace-write', ownedPaths: backend.ownedPaths, taskProfiles: backend.taskProfiles });
  const owner = { actorUserId: crypto.randomUUID(), actorUsername: 'owner', conversationId: crypto.randomUUID() };
  function executionFor(rpcId, text, generation) {
    const classified = classifyPinnedDshPromptBody(Buffer.from(json({ type: 'client-request', rpcId, method: 'session.prompt',
      payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] } })), 'session.prompt');
    const execution = { schemaVersion: 1, issuer: 'forge-conversation-gateway', audience: 'forge-phase-budget-guard', executionId: crypto.randomUUID(), claimId: crypto.randomUUID(),
      generation, projectSlug: 'evidence-project', taskId, ...owner, dshSessionId: sessionId, route: classified.route, classification: classified.classification,
      rpcId, mode: classified.mode, bodyDigest: classified.bodyDigest, textDigest: classified.textDigest, bodyBytes: classified.bodyBytes, promptDigest: classified.textDigest,
      policyVersion: 'forge-conversation-execution/v1', authorityClass: 'production-task-writer', testOnly: false, sourceCommit, workspaceFingerprint: sha('current-source'),
      caseFamily: 'maintenance', productionAuthorityId: crypto.randomUUID(), controllerGrantDigest: sha('grant'), workflowId: state.workflowId,
      phaseId: 'backend', phaseIndex: 4, phaseCatalogVersion: state.catalogVersion, phaseCatalogDigest: state.catalogDigest, contractId: contract.contractId,
      contractDigest: contract.contractId, actionCeiling: contract.actionCeiling, ownedPaths: contract.ownedPaths, requiredProfiles: contract.requiredVerificationProfiles, contract,
      requestId: `request:evidence:${generation}`, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
    execution.productionAuthorityDigest = digestProductionTaskAuthorityBinding(execution); return execution;
  }
  const execution = executionFor('rpc-backend', originalPrompt, 9), attemptDirectory = path.join(directory, 'browser-attempts', execution.executionId);
  await mkdir(attemptDirectory, { recursive: true });
  const identity = Object.fromEntries(['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId', 'rpcId',
    'sourceCommit', 'workspaceFingerprint', 'workflowId', 'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'].map(key => [key, execution[key]]));
  const proposal = { schemaVersion: 'forge-delivery-phase-proposal/v1', phaseId: 'backend', unresolvedDecisions: [],
    payload: { ...Object.fromEntries(backend.requiredPayloadKeys.map(key => [key, {}])), changedPaths: paths } };
  const modelResponse = '<forge-phase-artifact>' + JSON.stringify(proposal) + '</forge-phase-artifact>';
  const capture = { modelResponse, sessionProof: { schemaVersion: 'forge-delivery-phase-browser-session-proof/v1', ...identity,
    terminalReason: 'completed', hostReceiptsDerived: false, baselineObservedSeq: 1, sessionCwd: '/workspace', requestSeq: 2, assistantMessageSeq: 3, terminalSeq: 4,
    terminalEventDigest: sha('terminal'), modelResponseSha256: sha(modelResponse) } };
  const files = { 'execution.json': execution, 'session-baseline.json': { schemaVersion: 'forge-delivery-phase-browser-session-baseline/v1', ...identity, observedSeq: 1, sessionCwd: '/workspace' },
    'begin.json': { schemaVersion: 'forge-delivery-browser-phase-begin/v1', workflowId: state.workflowId, phaseId: 'backend', phaseIndex: 4, attempt: state.activeAttempt },
    '阶段终态采集.json': capture, '累计变更文件.json': observed.allChangedPaths, '本阶段变更文件.json': paths,
    '阶段候选预检凭据.json': { schemaVersion: 'forge-delivery-phase-controller-preflight/v1', workflowId: state.workflowId, phaseId: 'backend', phaseIndex: 4,
      phaseAttemptId: state.activeAttempt.attemptId, candidateArtifactDigest: sha('isolated-candidate'), phasePatchDigest: observed.phasePatchDigest,
      cumulativePatchDigest: observed.cumulativePatchDigest, changedPaths: paths, hostVerificationProfiles: backend.hostVerificationProfiles, safeForOperatorHostVerification: true, stateAdvanced: false },
    '阶段候选检查结果.json': { status: 'preflight-ready', code: 'PHASE_HOST_VERIFICATION_REQUIRED', phaseAttemptId: state.activeAttempt.attemptId, modelResponseSha256: sha(modelResponse) } };
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(attemptDirectory, name), json(value));
  const args = { catalogFile, stateFile, artifactsDirectory, originalRequestFile, promptFile, taskId, sessionId, sourceCommit,
    rpcId: 'rpc-evidence', previousExecutionId: execution.executionId, continuationText: '补齐当前后端候选的真实治理回执，保留已通过的编译和测试。', evidenceCorrection: true,
    draftSource: { sourceCommit, workspaceFingerprint: execution.workspaceFingerprint, snapshotDigest: observed.snapshot.snapshotDigest, changedPaths: paths } };
  await assert.rejects(prepareForgeDatabaseLeaseContinuation({ ...args, sessionId: 'another-session' }), { code: 'PHASE_CONTROLLER_DATABASE_RESUME_DENIED' });
  await putSource('drift\n');
  await assert.rejects(prepareForgeDatabaseLeaseContinuation(args), { code: 'PHASE_CONTROLLER_DATABASE_RESUME_DENIED' });
  await putSource('after\n');
  const prepared = await prepareForgeDatabaseLeaseContinuation(args);
  assert.equal(prepared.phaseId, 'backend'); assert.ok(prepared.promptText.includes(args.continuationText));
  assert.deepEqual(await readForgeDeliveryPhaseState(stateFile, catalog), state);
  const nextExecution = executionFor(args.rpcId, prepared.promptText, 10);
  const begun = await beginForgeDeliveryBrowserPhase({ catalogFile, stateFile, artifactsDirectory, originalRequestFile, promptFile, prepared, execution: nextExecution });
  assert.equal(begun.attempt.attemptId, state.activeAttempt.attemptId); assert.equal(begun.attempt.executionGeneration, 10);
  const continued = await readForgeDeliveryPhaseState(stateFile, catalog);
  assert.deepEqual(continued.history, state.history); assert.deepEqual(continued.acceptedArtifacts, state.acceptedArtifacts);
  for (const [name, value] of Object.entries(files)) assert.equal(await readFile(path.join(attemptDirectory, name), 'utf8'), json(value));
  assert.deepEqual((await observeForgeDeliveryPhase({ workspace, baseCommit: sourceCommit, before })).phaseChangedPaths, paths);
});
