import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as controller from '../docker/harness/forge-delivery-phase-controller.mjs';
import { beginForgeDeliveryPhase, completeForgeDeliveryPhase, createForgeDeliveryPhaseArtifact,
  createForgeDeliveryPhaseState, loadForgeDeliveryPhaseCatalog, readForgeDeliveryPhaseState,
  writeForgeDeliveryPhaseState } from '../docker/harness/forge-delivery-phase-runtime.mjs';

const CATALOG_FILE = path.resolve(import.meta.dirname, '../docker/harness/skills/forge-task-router/references/phase-profiles.json');
const SOURCE_COMMIT = '908e13bdc08ec2cbb071d355a2c33a77c970bdd3';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const put = async (file, bytes) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
};

async function acceptedAccessFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-access-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { catalog } = await loadForgeDeliveryPhaseCatalog(CATALOG_FILE);
  const directory = path.join(root, 'phase-control');
  const stateFile = path.join(directory, 'state.json');
  const artifactsDirectory = path.join(directory, 'artifacts');
  const originalRequestFile = path.join(directory, 'original-request.md');
  const changed = {
    2: ['forge-server/db/migration/V20261001__fixture.sql',
      'forge-server/forge-business/forge-business-core/src/test/java/FixtureMigrationTest.java'],
    4: ['forge-server/forge-business/forge-business-core/src/main/java/FixtureController.java'],
    5: ['forge-admin-ui/src/views/Fixture.vue'],
    6: ['forge-server/db/migration/V20261010__fixture_access.sql',
      'forge-server/forge-business/forge-business-core/src/test/java/FixtureAccessTest.java'],
  };
  let state = createForgeDeliveryPhaseState({ catalog, workflowId: 'crud-production', caseFamily: 'crud-complete',
    taskId: 'task-access-repair', sessionId: 'session-access-repair', sourceCommit: SOURCE_COMMIT });
  let fingerprint = sha256('');
  for (const phase of catalog.workflows.find(item => item.id === 'crud-production').phases.slice(0, 7)) {
    state = beginForgeDeliveryPhase({ state, catalog, phaseId: phase.id, rpcId: `rpc-fixture-${phase.index}`,
      promptDigest: sha256(`fixture prompt ${phase.index}`), executionGeneration: phase.index + 1 });
    const paths = changed[phase.index] ?? [];
    if (paths.length) fingerprint = sha256(`fixture cumulative ${phase.index}`);
    const artifact = createForgeDeliveryPhaseArtifact({ state, catalog, phaseId: phase.id,
      attemptId: state.activeAttempt.attemptId, sourceFingerprint: fingerprint, changedPaths: paths,
      patchDigest: paths.length ? sha256(`fixture phase ${phase.index}`) : null,
      payload: Object.fromEntries(phase.requiredPayloadKeys.map(key => [key, []])) });
    const completed = completeForgeDeliveryPhase({ state, catalog, decision: 'accepted', artifact,
      hostReceipts: phase.hostVerificationProfiles.map(profile => ({ profile, status: 'passed',
        receiptDigest: sha256(`fixture ${phase.index} ${profile}`), patchDigest: fingerprint })) });
    state = completed.state;
    await put(path.join(artifactsDirectory, `${phase.artifactKind}.json`), `${JSON.stringify(artifact)}\n`);
  }
  await writeForgeDeliveryPhaseState(stateFile, state, catalog);
  await put(originalRequestFile, '平台关联修复测试的原始请求。\n');
  await put(path.join(directory, 'phase-6-workspace-before.json'), '{"fixture":"original phase 6 baseline"}\n');
  return { root, catalog, directory, state, stateFile, artifactsDirectory, originalRequestFile };
}

test('accepted access migration failure creates one bound repair child preserving the parent and six upstream stages', async (t) => {
  const fixture = await acceptedAccessFixture(t);
  const { directory, state: parent, stateFile, artifactsDirectory, originalRequestFile, catalog } = fixture;
  const parentBytes = await readFile(stateFile);
  const originals = new Map(await Promise.all(Object.keys(parent.acceptedArtifacts).map(async kind =>
    [kind, await readFile(path.join(artifactsDirectory, `${kind}.json`))])));
  const preparationDirectory = path.join(directory, 'runtime-preparations', '11111111-1111-4111-8111-111111111111');
  const failureEvidenceFile = path.join(preparationDirectory, 'migration-failure.json');
  const access = JSON.parse(originals.get('access-wiring-implementation'));
  const failure = { schemaVersion: 'forge-cross-layer-preparation-failure/v1',
    taskId: parent.taskId, sessionId: parent.sessionId, actorUserId: '123e4567-e89b-42d3-a456-426614174000',
    actorUsername: 'alice', conversationId: 'conversation:access-repair',
    executionId: '22222222-2222-4222-8222-222222222222', executionGeneration: 12, rpcId: 'rpc:crosslayer:prepare',
    parentStateDigest: parent.stateDigest, baseSourceCommit: SOURCE_COMMIT, workspaceFingerprint: 'a'.repeat(64),
    acceptedArtifactDigests: parent.acceptedArtifacts, jobId: '788b55aa-6a99-4d86-9f6e-caf797e00cdd',
    candidateCommit: 'b'.repeat(40), candidateTree: 'c'.repeat(40), acceptedPatchSha256: access.sourceFingerprint,
    status: 'failed', failedStage: 'test-database-migration', startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(), errorCode: 'TEST_DATABASE_MIGRATION_FAILED',
    runnerEvidenceSha256: 'd'.repeat(64), preparationDirectory, sourceBindingSha256: 'e'.repeat(64) };
  const failureBytes = Buffer.from(`${JSON.stringify(failure)}\n`);
  await put(failureEvidenceFile, failureBytes);
  const repairRequestText = '请修复当前消防候选的这一个权限迁移缺陷，并通过必要的真实迁移验证。保留未受影响阶段、有效候选、缓存和原始失败记录。';
  const args = { catalogFile: CATALOG_FILE, sourceStateFile: stateFile,
    expectedSourceStateSha256: sha256(parentBytes), sourceArtifactsDirectory: artifactsDirectory,
    sourceCommit: SOURCE_COMMIT, originalRequestFile, outputDirectory: path.join(directory, 'access-wiring-repair'),
    repairRequestText, failureEvidenceFile, expectedFailureEvidenceSha256: sha256(failureBytes) };
  const resolveArgs = { catalogFile: CATALOG_FILE, sourceStateFile: stateFile, sourceArtifactsDirectory: artifactsDirectory,
    sourceCommit: SOURCE_COMMIT, taskId: parent.taskId, sessionId: parent.sessionId };
  assert.equal(typeof controller.prepareForgeAccessWiringRepairContinuation, 'function');
  assert.equal(await controller.readForgeAccessWiringRepairContinuation(resolveArgs), null);
  // A model claim, stale parent/source or unrelated Runner failure cannot create a repair child.
  await assert.rejects(controller.prepareForgeAccessWiringRepairContinuation({ ...args,
    expectedFailureEvidenceSha256: '0'.repeat(64) }));
  for (const override of [{ status: 'running' }, { failedStage: 'candidate-build' },
    { taskId: 'another-task' }, { sessionId: 'another-session' }, { parentStateDigest: '0'.repeat(64) },
    { acceptedPatchSha256: '0'.repeat(64) }, { executionGeneration: parent.lastExecutionGeneration }]) {
    const bytes = Buffer.from(`${JSON.stringify({ ...failure, ...override })}\n`);
    await put(failureEvidenceFile, bytes);
    await assert.rejects(controller.prepareForgeAccessWiringRepairContinuation({ ...args,
      expectedFailureEvidenceSha256: sha256(bytes) }));
  }
  await put(failureEvidenceFile, failureBytes);
  await assert.rejects(controller.prepareForgeAccessWiringRepairContinuation({ ...args, sourceCommit: '0'.repeat(40) }));
  const receipt = await controller.prepareForgeAccessWiringRepairContinuation(args);
  const childFile = path.join(args.outputDirectory, 'state.json');
  let child = await readForgeDeliveryPhaseState(childFile, catalog);
  assert.equal(child.currentPhaseId, 'access-wiring');
  assert.equal(child.currentPhaseIndex, 6);
  assert.equal(child.activeAttempt, null);
  assert.deepEqual(child.history, parent.history.filter(item => item.phaseIndex < 6));
  assert.equal(Object.keys(child.acceptedArtifacts).length, 6);
  assert.equal(receipt.nextExecutionGenerationMinimum, 13);
  assert.equal(receipt.preparationExecutionGeneration, 12);
  assert.equal(receipt.failureEvidenceSha256, sha256(failureBytes));
  assert.deepEqual(receipt.parentAccessReceiptDigests, parent.history.filter(item => item.phaseIndex === 6).map(item => item.receiptDigest));
  assert.deepEqual(await controller.prepareForgeAccessWiringRepairContinuation(args), receipt);
  assert.deepEqual(await controller.readForgeAccessWiringRepairContinuation(resolveArgs),
    { phaseDirectory: args.outputDirectory, continuation: receipt });
  const prompt = await readFile(path.join(args.outputDirectory, 'current-prompt.md'), 'utf8');
  assert.ok(prompt.includes(repairRequestText));
  child = beginForgeDeliveryPhase({ state: child, catalog, phaseId: 'access-wiring', rpcId: 'rpc:access:repair',
    promptDigest: sha256(prompt), executionGeneration: receipt.nextExecutionGenerationMinimum });
  await writeForgeDeliveryPhaseState(childFile, child, catalog);
  const activeBytes = await readFile(childFile);
  assert.deepEqual(await controller.prepareForgeAccessWiringRepairContinuation(args), receipt);
  assert.deepEqual(await readFile(childFile), activeBytes);
  assert.equal((await controller.readForgeAccessWiringRepairContinuation(resolveArgs)).continuation.nextExecutionGenerationMinimum, 13);
  await assert.rejects(controller.readForgeAccessWiringRepairContinuation({ ...resolveArgs, sessionId: 'another-session' }));
  await assert.rejects(controller.prepareForgeAccessWiringRepairContinuation({ ...args, repairRequestText: '不同的修复请求。' }));
  assert.deepEqual(await readFile(stateFile), parentBytes);
  for (const [kind, bytes] of originals) {
    assert.deepEqual(await readFile(path.join(artifactsDirectory, `${kind}.json`)), bytes);
    if (kind !== 'access-wiring-implementation') {
      assert.deepEqual(await readFile(path.join(args.outputDirectory, 'artifacts', `${kind}.json`)), bytes);
    }
  }
  assert.deepEqual(await readFile(path.join(args.outputDirectory, 'phase-6-workspace-before.json')),
    await readFile(path.join(directory, 'phase-6-workspace-before.json')));
});
