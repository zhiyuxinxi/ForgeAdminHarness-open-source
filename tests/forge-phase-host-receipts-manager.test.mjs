import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createConversationManager } from '../docker/harness/conversation-manager.mjs';
import { classifyPinnedDshPromptBody, digestDirectUserTextContent,
  prepareProtectedExecutionContext } from '../docker/harness/forge-execution-context.mjs';
import { forgeDeliveryPhaseRetryPromptReceiptPath, initializeForgeDeliveryPhaseRun,
  preflightForgeDeliveryPhaseRun } from '../docker/harness/forge-delivery-phase-controller.mjs';
import { beginForgeDeliveryPhase, completeForgeDeliveryPhase, createForgeDeliveryPhaseArtifact,
  loadForgeDeliveryPhaseCatalog, readForgeDeliveryPhaseState,
  writeForgeDeliveryPhaseState } from '../docker/harness/forge-delivery-phase-runtime.mjs';
import { buildForgeDeliveryPhasePrompt } from '../docker/harness/forge-delivery-phase-response.mjs';
import { snapshotForgeDeliveryWorkspace } from '../docker/harness/forge-delivery-phase-workspace-observer.mjs';
import { ProtectedAcceptanceService } from '../docker/harness/forge-protected-acceptance-service.mjs';
import { VERIFY_PROFILE_NAMES } from '../docker/harness/verify-policy.mjs';
import { createForgePhaseHostReceipt } from './helpers/forge-phase-host-receipt-fixture.mjs';

const CATALOG_FILE = fileURLToPath(new URL(
  '../docker/harness/skills/forge-task-router/references/phase-profiles.json', import.meta.url,
));
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const FRONTEND_PATH = 'forge-admin-ui/src/views/business/customer-archive.vue';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const identityFields = ['executionId', 'generation', 'projectSlug', 'taskId', 'actorUserId',
  'actorUsername', 'conversationId', 'dshSessionId', 'rpcId', 'sourceCommit', 'workspaceFingerprint',
  'workflowId', 'phaseId', 'phaseIndex', 'phaseCatalogVersion', 'phaseCatalogDigest', 'contractId', 'textDigest'];
const identity = (execution) => Object.fromEntries(identityFields.map((key) => [key, execution[key]]));

function post(port, pathname, token, body) {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: pathname,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'content-length': bytes.length } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode,
        value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.on('error', reject);
    request.end(bytes);
  });
}

async function verifyManagerHostReceipts(t, { acceptAccessWiring = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-manager-host-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectSlug = 'host-receipt-project';
  const taskId = 'frontend-host-receipts';
  const conversationId = 'conversation:frontend:host-receipts';
  const sessionId = 'session:frontend:host-receipts';
  const token = 'h'.repeat(64);
  const taskspace = path.join(root, 'taskspaces', taskId);
  const workspace = path.join(taskspace, 'workspace');
  const phaseDirectory = path.join(root, 'taskspaces', '.broker', 'delivery-phases', taskId, 'phase-control');
  const artifactsDirectory = path.join(phaseDirectory, 'artifacts');
  const stateFile = path.join(phaseDirectory, 'state.json');
  const originalRequestFile = path.join(phaseDirectory, 'original-request.md');
  const promptFile = path.join(phaseDirectory, 'current-prompt.md');
  const intakeRoot = path.join(root, 'intake');
  const controlScript = path.join(root, 'taskspacectl.sh');
  await mkdir(workspace, { recursive: true });
  await mkdir(intakeRoot, { recursive: true });
  await mkdir(phaseDirectory, { recursive: true, mode: 0o700 });
  await writeFile(controlScript, '#!/bin/sh\nexit 0\n');
  const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Forge Host Receipt Test');
  git('config', 'user.email', 'host-receipts@example.invalid');
  await writeFile(path.join(workspace, 'README.md'), '# Host receipt integration fixture\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'fixture');
  const sourceCommit = git('rev-parse', 'HEAD');
  const metadata = { schemaVersion: 2, projectSlug, taskId, actorId: 'alice', actorUserId: ACTOR_ID,
    conversationId, branch: `task/alice/${taskId}`, accessMode: 'conversation', status: 'active',
    accessTokenHash: '0'.repeat(64), lastCandidate: null, lastRelease: null, harnessPort: 23001,
    baseCommit: sourceCommit, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeFile(path.join(taskspace, 'metadata.json'), `${JSON.stringify(metadata)}\n`);
  const promptBody = (rpcId, text) => JSON.stringify({ type: 'client-request', rpcId,
    method: 'session.prompt', payload: { sessionId, mode: 'queue', content: [{ type: 'text', text }] } });
  const requestIdentity = { actorUserId: ACTOR_ID, actorUsername: 'alice', conversationId };
  // Keep execution generations aligned with the five canonical upstream fixture attempts.
  for (let generation = 1; generation <= 5; generation += 1) {
    const body = promptBody(`rpc:upstream:${generation}`, '查询当前项目状态');
    await prepareProtectedExecutionContext({ projectRoot: root, projectSlug, taskMetadata: metadata,
      request: { ...classifyPinnedDshPromptBody(Buffer.from(body), 'session.prompt'),
        ...requestIdentity, requestId: `request:upstream:${generation}` } });
  }
  const originalRequest = '实现完整的客户准入档案功能。';
  await writeFile(originalRequestFile, `${originalRequest}\n`);
  await initializeForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, workflowId: 'crud-production',
    caseFamily: 'crud-complete', taskId, sessionId, sourceCommit, originalRequestFile,
    stateFile, artifactsDirectory, promptFile });
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const workflow = catalog.workflows.find((item) => item.id === 'crud-production');
  for (let generation = 1; generation <= 5; generation += 1) {
    let state = await readForgeDeliveryPhaseState(stateFile, catalog);
    const phase = workflow.phases[state.currentPhaseIndex];
    state = beginForgeDeliveryPhase({ state, catalog, phaseId: phase.id,
      rpcId: `rpc:accepted:${generation}`, executionGeneration: generation,
      promptDigest: digestDirectUserTextContent([{ type: 'text', text: (await readFile(promptFile, 'utf8')).trimEnd() }]) });
    const changedPaths = phase.id === 'database'
      ? ['forge-server/db/migration/V1.0.999__customer_archive.sql',
        'forge-server/forge-business/forge-business-core/src/test/java/customerarchive/CustomerArchiveMigrationContractTest.java']
      : phase.id === 'backend'
        ? ['forge-server/forge-business/forge-business-core/src/main/java/customerarchive/CustomerArchive.java'] : [];
    for (const relative of changedPaths) {
      await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
      await writeFile(path.join(workspace, relative), `fixture ${phase.id}\n`);
    }
    const artifact = createForgeDeliveryPhaseArtifact({ state, catalog, phaseId: phase.id,
      attemptId: state.activeAttempt.attemptId, sourceFingerprint: sha256(''), changedPaths,
      patchDigest: phase.patchScope === 'none' ? null : sha256(''),
      payload: Object.fromEntries(phase.requiredPayloadKeys.map((key) => [key, {}])) });
    const completed = completeForgeDeliveryPhase({ state, catalog, decision: 'accepted', artifact,
      hostReceipts: phase.hostVerificationProfiles.map((profile) => ({ profile, status: 'passed',
        receiptDigest: sha256(`upstream:${generation}:${profile}`), patchDigest: sha256('') })) });
    await writeFile(path.join(artifactsDirectory, `${artifact.artifactKind}.json`), `${JSON.stringify(artifact)}\n`);
    await writeForgeDeliveryPhaseState(stateFile, completed.state, catalog);
    const nextPhase = workflow.phases[completed.state.currentPhaseIndex];
    const upstreamArtifacts = await Promise.all(nextPhase.requiresArtifacts.map(async (kind) => (
      JSON.parse(await readFile(path.join(artifactsDirectory, `${kind}.json`), 'utf8'))
    )));
    await writeFile(promptFile, `${buildForgeDeliveryPhasePrompt({
      state: completed.state, catalog, originalRequest, upstreamArtifacts })}\n`);
  }
  const upstreamBytes = new Map(await Promise.all((await readdir(artifactsDirectory)).map(async (name) => (
    [name, await readFile(path.join(artifactsDirectory, name))]
  ))));
  assert.equal(upstreamBytes.size, 5);
  const privatePem = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  const acceptance = new ProtectedAcceptanceService({ config: {
    schemaVersion: 1, serviceType: 'forge-protected-acceptance-service/v1', projectSlug,
    policyId: `${projectSlug}-acceptance`, stateRoot: path.join(root, 'acceptance-state'), contractTtlSeconds: 900,
    allowedVerificationProfiles: [...VERIFY_PROFILE_NAMES],
    conversationWriterScopes: [
      ...['frontend-admin', 'dictionary'].map((taskProfile) => ({ taskProfile, ownedPaths: [FRONTEND_PATH] })),
      { taskProfile: 'security', ownedPaths: [FRONTEND_PATH, 'forge-server/db/migration',
        'forge-server/forge-business/forge-business-core/src/test/java'] },
    ],
    trustWindow: { issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z' },
    keys: { platform: { keyId: 'platform-key' },
      governance: { keyId: 'governance-key', subjectId: 'governance-engine' },
      verification: { keyId: 'verification-key', subjectId: 'verification-runner' },
      semanticReview: { keyId: 'semantic-key', subjectId: 'semantic-reviewer' }, verdict: { keyId: 'verdict-key' } },
  }, platformKeyPem: privatePem(), governanceKeyPem: privatePem(), verificationKeyPem: privatePem(),
  semanticKeyPem: privatePem(), verdictKeyPem: privatePem() });
  const phase = workflow.phases[5];
  const hints = phase.hostVerificationProfiles.map((profile) => ({ profile, receiptId: crypto.randomUUID() }));
  const proposal = { schemaVersion: 'forge-delivery-phase-proposal/v1', phaseId: phase.id,
    unresolvedDecisions: [], payload: Object.fromEntries(phase.requiredPayloadKeys.map((key) => [key,
      key === 'changedPaths' ? [FRONTEND_PATH] : { evidence: `${phase.id}:${key}` }])) };
  proposal.payload.redTests = { hostVerification: { receipts: hints } };
  let modelResponse = `## 当前阶段结果\n前端候选等待真实验证与审查。\n\n<forge-phase-artifact>${JSON.stringify(proposal)}</forge-phase-artifact>\n`;
  const receipts = new Map();
  const readerCalls = [];
  const authorityInputs = [];
  let captureCalls = 0;
  let observationCalls = 0;
  const observeSource = async () => {
    observationCalls += 1;
    const snapshot = await snapshotForgeDeliveryWorkspace({ workspace, baseCommit: sourceCommit, expectedHead: sourceCommit });
    return { schemaVersion: 1, observationType: 'forge-verify/source', projectSlug, taskId,
      source: { head: sourceCommit, fingerprint: snapshot.snapshotDigest, snapshotSha256: snapshot.snapshotDigest } };
  };
  const manager = createConversationManager({ projectRoot: root, projectSlug, intakeRoot, controlScript,
    managerToken: token, auditPath: path.join(root, 'ops', 'manager-audit.jsonl'), phaseCatalogFile: CATALOG_FILE,
    runControl: async () => { throw new Error('capture must not start a service'); },
    sourceObservationClient: observeSource,
    acceptanceControlClient: (input) => acceptance.issueContract(input),
    executionAuthorityClient: (input) => {
      authorityInputs.push(structuredClone(input));
      return acceptance.issueExecutionAuthority(input);
    },
    phaseSessionBaseline: async ({ execution }) => ({ ...identity(execution),
      schemaVersion: 'forge-delivery-phase-browser-session-baseline/v1', eventCount: 0, observedSeq: 0,
      eventDigest: sha256(''), sessionCwd: '/workspace' }),
    phaseSessionCapture: async ({ execution, baseline }) => {
      captureCalls += 1;
      return { modelResponse, sessionProof: { ...identity(execution),
        schemaVersion: 'forge-delivery-phase-browser-session-proof/v1', baselineObservedSeq: baseline.observedSeq,
        requestSeq: 1, assistantMessageSeq: 2, terminalSeq: 3, terminalReason: 'completed',
        modelResponseSha256: sha256(modelResponse), terminalEventDigest: 'b'.repeat(64),
        toolCallCount: 0, toolResultCount: 0, toolResults: [], sessionCwd: '/workspace',
        sessionRunning: false, historyPages: 1, historyEventCount: 3, hostReceiptsDerived: false } };
    },
    phaseHostReceiptReader: async (input) => {
      readerCalls.push(input);
      assert.equal(input.projectSlug, projectSlug);
      assert.equal(input.taskId, taskId);
      if (!receipts.has(input.receiptId)) throw Object.assign(new Error('receipt not available'), {
        code: 'PHASE_HOST_RECEIPT_UNAVAILABLE' });
      return structuredClone(receipts.get(input.receiptId));
    },
  });
  await new Promise((resolve, reject) => {
    manager.once('error', reject);
    manager.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => manager.close((error) => error ? reject(error) : resolve())));
  const port = manager.address().port;
  const raw = promptBody('rpc:frontend:6', '实现客户档案前端页面、字典和租户隔离权限并补齐测试。');
  const prepared = await post(port, `/v1/taskspaces/${taskId}/executions/prepare`, token, {
    ...classifyPinnedDshPromptBody(Buffer.from(raw), 'session.prompt'), ...requestIdentity,
    projectSlug, taskId, promptBody: raw, requestId: 'request:frontend:6', workspaceWriteAuthorized: true,
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
  assert.equal(prepared.value.execution.authorityClass, 'production-task-writer');
  assert.equal(prepared.value.execution.generation, 6);
  assert.equal(prepared.value.execution.phaseId, 'frontend');
  await mkdir(path.dirname(path.join(workspace, FRONTEND_PATH)), { recursive: true });
  const frontendBytes = '<template><div>frontend candidate</div></template>\n';
  await writeFile(path.join(workspace, FRONTEND_PATH), frontendBytes);
  const stateBefore = await readFile(stateFile);
  const executionIndex = path.join(root, 'taskspaces', '.broker', 'executions', `${taskId}.json`);
  const executionBefore = await readFile(executionIndex);
  const attemptDirectory = path.join(phaseDirectory, 'browser-attempts', prepared.value.execution.executionId);
  const captureBody = { projectSlug, taskId, ...requestIdentity, executionId: prepared.value.execution.executionId };
  const capture = () => post(port, `/v1/taskspaces/${taskId}/phase-terminal/capture`, token, captureBody);
  const aggregateFile = path.join(attemptDirectory, '阶段宿主验证回执.json');
  const bindingFile = path.join(attemptDirectory, '阶段宿主验证绑定.json');

  const missing = await capture();
  assert.equal(missing.status, 200, JSON.stringify(missing.value));
  assert.equal(missing.value.status, 'captured');
  assert.equal(missing.value.assessment.code, 'PHASE_HOST_VERIFICATION_REQUIRED');
  assert.equal(missing.value.assessment.hostVerification.status, 'required');
  assert.deepEqual(missing.value.assessment.hostVerification.missingProfiles, phase.hostVerificationProfiles);
  await assert.rejects(readFile(aggregateFile), { code: 'ENOENT' });
  await assert.rejects(readFile(bindingFile), { code: 'ENOENT' });
  const immutableNames = ['阶段终态采集.json', '会话终态证明.json', '模型最终回答.txt',
    '阶段候选检查结果.json', '阶段候选预检凭据.json'];
  const originals = new Map(await Promise.all(immutableNames.map(async (name) => [name,
    await readFile(path.join(attemptDirectory, name))])));
  const preflight = JSON.parse(originals.get('阶段候选预检凭据.json'));
  const source = (await observeSource()).source;
  assert.notEqual(source.fingerprint, preflight.cumulativePatchDigest,
    'native source snapshot fingerprints must not be substituted for Controller patch hashes');
  for (const hint of hints) receipts.set(hint.receiptId, createForgePhaseHostReceipt({ ...hint,
    projectSlug, taskId, sourceCommit, sourceFingerprint: source.fingerprint,
    selectors: hint.profile === 'frontend-admin-lint' ? { files: [FRONTEND_PATH] } : {} }));
  const observationsBefore = observationCalls;
  const verified = await capture();
  assert.equal(verified.status, 200, JSON.stringify(verified.value));
  assert.equal(verified.value.assessment.code, 'PHASE_SEMANTIC_REVIEW_REQUIRED');
  assert.equal(verified.value.assessment.hostVerification.status, 'verified');
  assert.equal(verified.value.assessment.stateAdvanced, false);
  assert.equal(observationCalls - observationsBefore, 2, 'receipt binding requires source observations before and after reads');
  assert.equal(captureCalls, 1, 'refresh reads Host evidence without capturing or rerunning the model');
  const aggregateBytes = await readFile(aggregateFile);
  const aggregate = JSON.parse(aggregateBytes);
  const bindingBytes = await readFile(bindingFile);
  const binding = JSON.parse(bindingBytes);
  assert.equal(binding.source.fingerprint, source.fingerprint);
  assert.equal(binding.cumulativePatchDigest, preflight.cumulativePatchDigest);
  assert.equal(binding.phasePatchDigest, preflight.phasePatchDigest);
  assert.equal(binding.phaseAttemptId, JSON.parse(stateBefore).activeAttempt.attemptId);
  assert.equal(binding.modelResponseSha256, sha256(modelResponse));
  assert.equal(binding.stateAdvanced, false);
  assert.deepEqual(binding.hostReceipts, aggregate);
  assert.equal(aggregate.length, phase.hostVerificationProfiles.length);
  for (const hint of hints) {
    const bytes = Buffer.from(`${JSON.stringify(receipts.get(hint.receiptId), null, 2)}\n`);
    assert.deepEqual(await readFile(path.join(attemptDirectory, `宿主验证回执-${hint.receiptId}.json`)), bytes);
    assert.deepEqual(aggregate.find((item) => item.profile === hint.profile), {
      profile: hint.profile, status: 'passed', receiptDigest: sha256(bytes), patchDigest: preflight.cumulativePatchDigest });
  }
  const replay = await capture();
  assert.equal(replay.status, 200, JSON.stringify(replay.value));
  assert.equal(replay.value.assessment.code, 'PHASE_SEMANTIC_REVIEW_REQUIRED');
  assert.deepEqual(await readFile(aggregateFile), aggregateBytes);
  assert.deepEqual(await readFile(bindingFile), bindingBytes);

  const staleHint = hints[0];
  receipts.get(staleHint.receiptId).freshness = 'stale';
  const stale = await capture();
  assert.equal(stale.status, 200, JSON.stringify(stale.value));
  assert.equal(stale.value.assessment.code, 'PHASE_HOST_VERIFICATION_REQUIRED');
  assert.equal(stale.value.assessment.hostVerification.status, 'required');
  assert.deepEqual(stale.value.assessment.hostVerification.missingProfiles, [staleHint.profile]);
  assert.deepEqual(await readFile(aggregateFile), aggregateBytes, 'historical passed evidence is preserved, not returned as current');
  receipts.get(staleHint.receiptId).freshness = 'current';
  await writeFile(path.join(workspace, FRONTEND_PATH), `${frontendBytes}<!-- changed after capture -->\n`);
  const readsBeforeChange = readerCalls.length;
  const changed = await capture();
  assert.equal(changed.status, 409, JSON.stringify(changed.value));
  assert.equal(changed.value.code, 'PHASE_CAPTURE_RECORD_CONFLICT');
  assert.equal(readerCalls.length, readsBeforeChange, 'actual workspace drift rejects before old receipts can be reused');
  assert.equal(captureCalls, 1);
  assert.deepEqual(await readFile(stateFile), stateBefore);
  assert.deepEqual(await readFile(executionIndex), executionBefore);
  for (const [name, bytes] of originals) assert.deepEqual(await readFile(path.join(attemptDirectory, name)), bytes);
  for (const [name, bytes] of upstreamBytes) assert.deepEqual(await readFile(path.join(artifactsDirectory, name)), bytes);
  assert.equal((await readdir(artifactsDirectory)).length, 5);
  await assert.rejects(readFile(path.join(artifactsDirectory, `${phase.artifactKind}.json`)), { code: 'ENOENT' });

  // Continue with the same captured candidate; no new model response or phase attempt is created.
  await writeFile(path.join(workspace, FRONTEND_PATH), frontendBytes);
  const prepareMessage = (rpcId, text, extra = {}) => {
    const body = promptBody(rpcId, text);
    return post(port, `/v1/taskspaces/${taskId}/executions/prepare`, token, {
      ...classifyPinnedDshPromptBody(Buffer.from(body), 'session.prompt'), ...requestIdentity,
      projectSlug, taskId, promptBody: body, requestId: `request:${rpcId}`,
      workspaceWriteAuthorized: true, ...extra,
    });
  };

  await t.test('a writer can request protected read-only clarification without consuming the pending phase', async () => {
    const readsBefore = readerCalls.length;
    const clarified = await prepareMessage('rpc:clarify:7', '只读解释来源，不修改文件，也不要发版。', {
      authorizedActionCeiling: 'release',
    });
    assert.equal(clarified.status, 200, JSON.stringify(clarified.value));
    assert.equal(clarified.value.execution.authorityClass, 'production-read-only');
    assert.equal(clarified.value.execution.actionCeiling, 'read-only');
    assert.equal(clarified.value.execution.generation, 7);
    assert.equal(clarified.value.execution.phaseId, null);
    assert.equal(clarified.value.forwardBody, undefined, 'the real clarification must reach the conversation unchanged');
    assert.equal(authorityInputs.at(-1).workspaceWriteAuthorized, false);
    assert.equal(Object.hasOwn(authorityInputs.at(-1), 'authorizedActionCeiling'), false);
    assert.equal(Object.hasOwn(authorityInputs.at(-1), 'controllerPhase'), false);
    assert.equal(readerCalls.length, readsBefore, 'clarification does not revalidate or accept a phase');
    assert.deepEqual(await readFile(stateFile), stateBefore);
    assert.equal((await readdir(path.join(phaseDirectory, 'browser-attempts'))).length, 1);
    assert.equal(await readFile(path.join(workspace, FRONTEND_PATH), 'utf8'), frontendBytes);
    const current = JSON.parse(await readFile(executionIndex, 'utf8')).current;
    assert.equal(current.executionId, clarified.value.execution.executionId);
    assert.notEqual(current.executionId, prepared.value.execution.executionId);

    const originalCapture = await capture();
    assert.equal(originalCapture.status, 200, JSON.stringify(originalCapture.value));
    assert.equal(originalCapture.value.executionId, prepared.value.execution.executionId);
    assert.equal(originalCapture.value.assessment.hostVerification.status, 'verified');
    assert.equal(originalCapture.value.assessment.stateAdvanced, false);
    assert.equal(captureCalls, 1);
  });

  await t.test('a repair request, stale Host receipt, or wrong saved attempt cannot accept the frontend', async () => {
    const explanationIndex = await readFile(executionIndex);
    const repair = await prepareMessage('rpc:repair:8', '继续修改页面的交互。');
    assert.equal(repair.status, 409, JSON.stringify(repair.value));
    assert.deepEqual(await readFile(stateFile), stateBefore);
    assert.deepEqual(await readFile(executionIndex), explanationIndex);

    receipts.get(staleHint.receiptId).freshness = 'stale';
    const staleContinuation = await prepareMessage('rpc:stale:8', '继续完成。');
    assert.equal(staleContinuation.status, 409, JSON.stringify(staleContinuation.value));
    assert.equal(staleContinuation.value.code, 'PHASE_HOST_VERIFICATION_REQUIRED');
    assert.deepEqual(await readFile(stateFile), stateBefore);
    assert.deepEqual(await readFile(executionIndex), explanationIndex);
    receipts.get(staleHint.receiptId).freshness = 'current';

    const beginFile = path.join(attemptDirectory, 'begin.json');
    const beginBytes = await readFile(beginFile);
    const wrongBegin = JSON.parse(beginBytes);
    wrongBegin.attempt.attemptId = crypto.randomUUID();
    await writeFile(beginFile, `${JSON.stringify(wrongBegin)}\n`);
    try {
      const wrongIdentity = await prepareMessage('rpc:wrong-attempt:8', '继续完成。');
      assert.equal(wrongIdentity.status, 409, JSON.stringify(wrongIdentity.value));
      assert.deepEqual(await readFile(stateFile), stateBefore);
      assert.deepEqual(await readFile(executionIndex), explanationIndex);
    } finally {
      await writeFile(beginFile, beginBytes);
    }
    await assert.rejects(readFile(path.join(artifactsDirectory, `${phase.artifactKind}.json`)), { code: 'ENOENT' });
  });

  await t.test('explicit continuation accepts the original phase after clarification and preserves its evidence', async () => {
    const continued = await prepareMessage('rpc:continue:8', '继续完成。');
    assert.equal(continued.status, 200, JSON.stringify(continued.value));
    assert.equal(continued.value.execution.generation, 8);
    assert.equal(continued.value.execution.phaseId, workflow.phases[6].id);
    const after = await readForgeDeliveryPhaseState(stateFile, catalog);
    const before = JSON.parse(stateBefore);
    assert.equal(after.currentPhaseId, workflow.phases[6].id);
    assert.deepEqual(after.history.slice(0, before.history.length), before.history);
    assert.equal(after.history.length, before.history.length + 1);
    assert.equal(after.history.at(-1).decision, 'accepted');
    assert.equal(after.history.at(-1).attemptId, before.activeAttempt.attemptId);
    assert.equal(after.history.at(-1).executionGeneration, 6, 'the clarification generation is not a business attempt');
    assert.equal(after.history.filter((entry) => entry.phaseId === 'frontend').length, 1);
    assert.equal(after.activeAttempt.executionGeneration, 8);
    for (const [name, bytes] of originals) assert.deepEqual(await readFile(path.join(attemptDirectory, name)), bytes);
    for (const [name, bytes] of upstreamBytes) assert.deepEqual(await readFile(path.join(artifactsDirectory, name)), bytes);
    const accepted = JSON.parse(await readFile(path.join(artifactsDirectory, `${phase.artifactKind}.json`), 'utf8'));
    assert.equal(accepted.artifactDigest, preflight.candidateArtifactDigest);
    assert.equal(await readFile(path.join(workspace, FRONTEND_PATH), 'utf8'), frontendBytes);
    assert.equal(captureCalls, 1, 'continuation reuses the original real terminal capture');

    const replayed = await prepareMessage('rpc:continue:8', '继续完成。');
    assert.equal(replayed.status, 200, JSON.stringify(replayed.value));
    assert.equal(replayed.value.execution.executionId, continued.value.execution.executionId);
    assert.deepEqual(await readForgeDeliveryPhaseState(stateFile, catalog), after);
  });

  await t.test('access-wiring format repair retains unresolved decisions and forwards bounded user facts within the original budget', async () => {
    const accessPhase = workflow.phases[6];
    const firstState = await readForgeDeliveryPhaseState(stateFile, catalog);
    const firstExecution = JSON.parse(await readFile(executionIndex, 'utf8')).current;
    const firstDirectory = path.join(phaseDirectory, 'browser-attempts', firstExecution.executionId);
    const accessPaths = ['forge-server/db/migration/V1.0.1000__customer_archive_access.sql',
      'forge-server/forge-business/forge-business-core/src/test/java/customerarchive/CustomerArchiveAccessMigrationContractTest.java'];
    for (const relative of accessPaths) {
      await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
      await writeFile(path.join(workspace, relative), `fixture access wiring ${relative}\n`);
    }
    const unresolved = ['隔离验收租户的字典数据补齐方式待确认'];
    const accessProposal = { schemaVersion: 'forge-delivery-phase-proposal/v1', phaseId: accessPhase.id,
      unresolvedDecisions: unresolved, payload: Object.fromEntries(accessPhase.requiredPayloadKeys.map((key) => [key,
        key === 'changedPaths' ? accessPaths : { evidence: `access-wiring:${key}` }])) };
    accessProposal.payload.verificationEvidence = { reported: true };
    const responseFor = (value) => `## 权限接线结果\n${value.unresolvedDecisions.length > 0
      ? '隔离租户字典补齐方式仍待确认。' : '字典补齐方式已明确，权限接线候选等待阶段验收。'}\n\n<forge-phase-artifact>${JSON.stringify(value)}</forge-phase-artifact>\n`;
    modelResponse = responseFor(accessProposal);
    const captureExecution = (executionId) => post(port, `/v1/taskspaces/${taskId}/phase-terminal/capture`, token,
      { ...captureBody, executionId });
    const captured = await captureExecution(firstExecution.executionId);
    assert.equal(captured.status, 200, JSON.stringify(captured.value));
    assert.equal(captured.value.assessment.code, 'PHASE_RESPONSE_INVALID');
    const retainedNames = ['阶段终态采集.json', '会话终态证明.json', '模型最终回答.txt', '阶段候选检查结果.json'];
    const retained = new Map(await Promise.all(retainedNames.map(async (name) => (
      [name, await readFile(path.join(firstDirectory, name))]
    ))));
    const stateBytes = await readFile(stateFile);
    const executionBytes = await readFile(executionIndex);
    const request = '继续修改。隔离验收租户的字典值采用已确认清单，请修复权限接线输出并保留待核实事项。其余按此前确认的要求执行。';
    for (const [rpcId, text, extra, code] of [
      ['rpc:access:no-write', request, { workspaceWriteAuthorized: false }, 'PHASE_USER_SCOPE_REQUIRED'],
      ['rpc:access:no-repair', '继续完成。', {}, 'PHASE_TERMINAL_REPAIR_REQUIRED'],
    ]) {
      const denied = await prepareMessage(rpcId, text, extra);
      assert.equal(denied.status, 409, JSON.stringify(denied.value));
      assert.equal(denied.value.code, code);
      assert.deepEqual(await readFile(stateFile), stateBytes);
      assert.deepEqual(await readFile(executionIndex), executionBytes);
    }
    const repaired = await prepareMessage('rpc:access:repair:9', request);
    assert.equal(repaired.status, 200, JSON.stringify(repaired.value));
    assert.equal(repaired.value.execution.generation, 9);
    assert.equal(repaired.value.execution.phaseId, 'access-wiring');
    assert.notEqual(repaired.value.execution.executionId, firstExecution.executionId);
    const forwarded = JSON.parse(repaired.value.forwardBody);
    const retryPrompt = forwarded.payload.content[0].text;
    assert.ok(retryPrompt.includes(JSON.stringify(request)), 'the actual model input contains the new user facts');
    assert.ok(retryPrompt.includes(JSON.stringify(unresolved[0])), 'the prior unresolved decision remains visible');
    assert.equal(authorityInputs.at(-1).controllerPhase.originalPromptText, request);
    const nextDirectory = path.join(phaseDirectory, 'browser-attempts', repaired.value.execution.executionId);
    const nextExecution = JSON.parse(await readFile(path.join(nextDirectory, 'execution.json'), 'utf8'));
    assert.equal(nextExecution.textDigest, digestDirectUserTextContent(forwarded.payload.content));
    const after = await readForgeDeliveryPhaseState(stateFile, catalog);
    const failed = after.history.at(-1);
    assert.equal(failed.attemptId, firstState.activeAttempt.attemptId);
    assert.equal(failed.decision, 'rejected');
    assert.equal(failed.reasonCode, 'FORMAT_UNEXPECTED_PAYLOAD_KEYS');
    assert.equal(after.activeAttempt.executionGeneration, 9);
    assert.notEqual(after.activeAttempt.attemptId, failed.attemptId);
    assert.equal(after.currentPhaseId, 'access-wiring');
    assert.deepEqual(after.acceptedArtifacts, firstState.acceptedArtifacts);
    const retryReceipt = JSON.parse(await readFile(
      forgeDeliveryPhaseRetryPromptReceiptPath(promptFile, failed.attemptId), 'utf8'));
    assert.equal(retryReceipt.responseSha256, sha256(retained.get('模型最终回答.txt')));
    assert.equal(retryReceipt.retryPromptDigest, sha256(retryPrompt));
    assert.equal(retryReceipt.remainingAttempts, accessPhase.maxAttempts - 1);
    for (const [name, bytes] of retained) assert.deepEqual(await readFile(path.join(firstDirectory, name)), bytes);
    for (const [name, bytes] of upstreamBytes) assert.deepEqual(await readFile(path.join(artifactsDirectory, name)), bytes);
    assert.equal(await readFile(path.join(workspace, FRONTEND_PATH), 'utf8'), frontendBytes);
    const replayed = await prepareMessage('rpc:access:repair:9', request);
    assert.equal(replayed.status, 200, JSON.stringify(replayed.value));
    assert.equal(replayed.value.execution.executionId, repaired.value.execution.executionId);
    assert.deepEqual(await readForgeDeliveryPhaseState(stateFile, catalog), after);

    // Fixing only the extra key still cannot pass full preflight while the business question remains unresolved.
    const corrected = structuredClone(accessProposal);
    delete corrected.payload.verificationEvidence;
    const correctedFile = path.join(root, 'access-format-corrected-unresolved.txt');
    await writeFile(correctedFile, responseFor(corrected));
    const forbiddenReceipt = path.join(root, 'access-unresolved-preflight.json');
    await assert.rejects(preflightForgeDeliveryPhaseRun({ catalogFile: CATALOG_FILE, stateFile,
      artifactsDirectory, responseFile: correctedFile, receiptFile: forbiddenReceipt,
      allChangedPathsFile: path.join(firstDirectory, '累计变更文件.json'),
      phaseChangedPathsFile: path.join(firstDirectory, '本阶段变更文件.json'),
      phasePatchFile: path.join(firstDirectory, '本阶段实际变更.patch'),
      cumulativePatchFile: path.join(firstDirectory, '累计实际变更.patch'),
      expectedAttemptId: after.activeAttempt.attemptId,
    }), { code: 'PHASE_CONTROLLER_BUSINESS_DECISION_REQUIRED' });
    await assert.rejects(readFile(forbiddenReceipt), { code: 'ENOENT' });
    assert.deepEqual(await readForgeDeliveryPhaseState(stateFile, catalog), after);
    assert.equal(after.acceptedArtifacts[accessPhase.artifactKind], undefined);

    if (!acceptAccessWiring) {
      // A second malformed answer cannot obtain a third attempt from the same repair route.
      const secondCapture = await captureExecution(repaired.value.execution.executionId);
      assert.equal(secondCapture.value.assessment.code, 'PHASE_RESPONSE_INVALID');
      const exhausted = await prepareMessage('rpc:access:repair:10', request);
      assert.equal(exhausted.status, 409, JSON.stringify(exhausted.value));
      assert.equal(exhausted.value.code, 'PHASE_TERMINAL_REPAIR_REQUIRED');
      assert.deepEqual(await readForgeDeliveryPhaseState(stateFile, catalog), after);
      assert.equal(JSON.parse(await readFile(executionIndex, 'utf8')).current.executionId, nextExecution.executionId);
      return;
    }

    // This independent fixture supplies a different second answer; no captured failure is overwritten.
    const accessHints = accessPhase.hostVerificationProfiles.map((profile) => ({ profile, receiptId: crypto.randomUUID() }));
    corrected.unresolvedDecisions = [];
    corrected.payload.permissionCoherence.hostVerification = { receipts: accessHints };
    modelResponse = responseFor(corrected);
    const secondCapture = await captureExecution(repaired.value.execution.executionId);
    assert.equal(secondCapture.status, 200, JSON.stringify(secondCapture.value));
    assert.equal(secondCapture.value.assessment.code, 'PHASE_HOST_VERIFICATION_REQUIRED');
    const missingHost = await prepareMessage('rpc:access:missing-host:10', '继续完成。');
    assert.equal(missingHost.status, 409, JSON.stringify(missingHost.value));
    assert.equal(missingHost.value.code, 'PHASE_HOST_VERIFICATION_REQUIRED');
    assert.deepEqual(await readForgeDeliveryPhaseState(stateFile, catalog), after);
    const source = (await observeSource()).source;
    for (const hint of accessHints) receipts.set(hint.receiptId, createForgePhaseHostReceipt({ ...hint,
      projectSlug, taskId, sourceCommit, sourceFingerprint: source.fingerprint }));
    const noWrite = await prepareMessage('rpc:access:complete-no-write:10', '继续完成。', { workspaceWriteAuthorized: false });
    assert.equal(noWrite.status, 409, JSON.stringify(noWrite.value));
    assert.deepEqual(await readForgeDeliveryPhaseState(stateFile, catalog), after);
    const completed = await prepareMessage('rpc:access:complete:10', '继续完成。');
    assert.equal(completed.status, 409, JSON.stringify(completed.value));
    assert.equal(completed.value.code, 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED');
    assert.match(completed.value.message, /权限接线已接受.*跨层验收缺少.*尚未启动下一轮/u);
    assert.equal(completed.value.execution, undefined);
    const acceptedState = await readForgeDeliveryPhaseState(stateFile, catalog);
    assert.equal(acceptedState.currentPhaseId, 'cross-layer-acceptance');
    assert.equal(acceptedState.currentPhaseIndex, 7);
    assert.equal(acceptedState.activeAttempt, null);
    assert.equal(acceptedState.history.at(-1).decision, 'accepted');
    assert.equal(acceptedState.history.at(-1).attemptId, after.activeAttempt.attemptId);
    assert.equal(acceptedState.history.filter((entry) => entry.phaseId === 'access-wiring').length, accessPhase.maxAttempts);
    const result = JSON.parse(await readFile(path.join(nextDirectory, 'controller/controller-result.json'), 'utf8'));
    assert.equal(result.acceptedPhaseId, 'access-wiring');
    assert.equal(result.acceptedPhaseIndex, 6);
    assert.equal(result.nextPromptPendingReason, 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED');
    assert.equal(JSON.parse(await readFile(executionIndex, 'utf8')).current.executionId, nextExecution.executionId);
    for (const [name, bytes] of retained) assert.deepEqual(await readFile(path.join(firstDirectory, name)), bytes);
    const repeated = await prepareMessage('rpc:access:complete-again:10', '继续完成。');
    assert.equal(repeated.value.code, 'CROSS_LAYER_RUNTIME_EVIDENCE_REQUIRED');
    assert.deepEqual(await readForgeDeliveryPhaseState(stateFile, catalog), acceptedState);
  });
}

test('manager binds current native Host receipts to one captured frontend candidate without accepting its phase', verifyManagerHostReceipts);
test('manager accepts a repaired access-wiring candidate and preserves the cross-layer runtime evidence boundary',
  (t) => verifyManagerHostReceipts(t, { acceptAccessWiring: true }));
