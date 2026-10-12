import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { beginForgeDeliveryPhase, completeForgeDeliveryPhase, createForgeDeliveryPhaseArtifact,
  createForgeDeliveryPhaseState, currentForgeRuntimeSourceArtifactKind, recordForgeAccessAcceptedCorrection,
} from '../docker/harness/forge-delivery-phase-runtime.mjs';
import { buildForgeDeliveryPhasePrompt } from '../docker/harness/forge-delivery-phase-response.mjs';
const catalog = JSON.parse(await readFile(new URL('../docker/harness/skills/forge-task-router/references/phase-profiles.json', import.meta.url), 'utf8'));
const sourceCommit = '6eb2881e6f6af85a5348acf3da63cef53a873b0e';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const stamp = generation => `2026-09-03T00:${String(generation).padStart(2, '0')}:00.000Z`;
function begin(state, generation) {
  return beginForgeDeliveryPhase({ state, catalog, phaseId: state.currentPhaseId,
    rpcId: `rpc-${generation}`, promptDigest: sha(`prompt-${generation}`), executionGeneration: generation, now: stamp(generation) });
}
function accept(state, generation, fingerprint) {
  state = begin(state, generation);
  const phase = catalog.workflows[0].phases[state.currentPhaseIndex];
  const artifact = createForgeDeliveryPhaseArtifact({ state, catalog, phaseId: phase.id, attemptId: state.activeAttempt.attemptId,
    sourceFingerprint: fingerprint, changedPaths: phase.patchScope === 'phase' ? [`${phase.ownedPaths[0]}/isolated.txt`] : [],
    patchDigest: phase.patchScope === 'none' ? null : sha(`${phase.id}-${generation}`),
    payload: Object.fromEntries(phase.requiredPayloadKeys.map(key => [key, []])) });
  const hostReceipts = phase.hostVerificationProfiles.map(profile => ({ profile, status: 'passed', receiptDigest: sha(`${profile}-${generation}`), patchDigest: fingerprint }));
  return { artifact, ...completeForgeDeliveryPhase({ state, catalog, decision: 'accepted', artifact, hostReceipts, now: stamp(generation) }) };
}
function runtimeFor(state, fingerprint) {
  return { manifestSha256: sha('isolated-manifest'), subject: { workflowId: state.workflowId, taskId: state.taskId,
    stateDigest: state.stateDigest, catalogVersion: state.catalogVersion, catalogDigest: state.catalogDigest,
    baseSourceCommit: state.sourceCommit, cumulativePatchSha256: fingerprint } };
}
function promptEvidence(state, artifacts, fingerprint) {
  const text = buildForgeDeliveryPhasePrompt({ state, catalog, originalRequest: 'Verify only the isolated platform candidate.',
    upstreamArtifacts: [...artifacts.values()], runtimeEvidence: runtimeFor(state, fingerprint) });
  return JSON.parse(text.split('PRIOR ACCEPTED PHASE EVIDENCE (Controller-bound):\n')[1].split('\nThis evidence proves')[0]);
}

test('cross-layer prompt binds current phase receipts and repaired backend cumulative source without rewriting history', () => {
  let state = createForgeDeliveryPhaseState({ catalog, workflowId: 'crud-production', caseFamily: 'crud-complete',
    taskId: 'eval-backend-prompt', sessionId: 'session-backend-prompt', sourceCommit, now: stamp(0) });
  const artifacts = new Map(), oldSource = sha('old-source'), repairedSource = sha('repaired-source');
  for (let generation = 1; generation <= 7; generation++) {
    const accepted = accept(state, generation, oldSource); state = accepted.state; artifacts.set(accepted.artifact.artifactKind, accepted.artifact);
  }
  const originalHistory = JSON.stringify(state.history), originalArtifacts = JSON.stringify([...artifacts]);
  const originalEvidence = promptEvidence(state, artifacts, oldSource);
  assert.equal(currentForgeRuntimeSourceArtifactKind(state), 'access-wiring-implementation');
  assert.equal(originalEvidence.cumulativePatchDigest, oldSource);
  const cross = begin(state, 8);
  const correction = recordForgeAccessAcceptedCorrection({ state: cross, catalog, phaseId: 'backend', now: stamp(8), binding: {
    acceptedSourceFingerprint: oldSource, failureEvidenceSha256: sha('failure'), jobId: null,
    executionId: '11111111-1111-4111-8111-111111111111', executionGeneration: 8, rpcId: cross.activeAttempt.rpcId,
    workspaceFingerprint: oldSource, candidateCommit: sourceCommit, sourceStateSha256: sha(JSON.stringify(cross)), repairRequestSha256: sha('backend repair'),
    runtimeFailure: { observationId: '22222222-2222-4222-8222-222222222222', manifestSha256: sha('failed-manifest'), formalTerminalSha256: sha('terminal') },
  } });
  const repaired = accept(correction, 9, repairedSource), currentArtifacts = new Map(artifacts);
  currentArtifacts.set('backend-implementation', repaired.artifact);
  const filtered = repaired.state.history.filter(receipt => receipt.decision === 'accepted'
    && receipt.artifactDigest === repaired.state.acceptedArtifacts[catalog.workflows[0].phases[receipt.phaseIndex].artifactKind]);
  assert.deepEqual(filtered.map(receipt => receipt.phaseIndex), [0, 1, 2, 3, 5, 6, 4]);
  const repairedHistory = JSON.stringify(repaired.state.history), repairedArtifacts = JSON.stringify([...currentArtifacts]);
  const evidence = promptEvidence(repaired.state, currentArtifacts, repairedSource);
  assert.equal(currentForgeRuntimeSourceArtifactKind(repaired.state), 'backend-implementation');
  assert.equal(evidence.cumulativePatchDigest, repairedSource);
  assert.deepEqual(evidence.accepted.map(receipt => receipt.phaseId), catalog.workflows[0].phases.slice(0, 7).map(phase => phase.id));
  assert.equal(evidence.accepted[4].artifactDigest, repaired.artifact.artifactDigest);
  assert.equal(evidence.accepted[4].controllerReceiptDigest, repaired.state.history.at(-1).receiptDigest);
  assert.deepEqual(evidence.accepted[4].hostReceiptDigests, repaired.state.history.at(-1).hostReceiptDigests);
  for (let index = 0; index < 7; index++) if (index !== 4) assert.deepEqual(evidence.accepted[index], originalEvidence.accepted[index]);
  assert.throws(() => promptEvidence(repaired.state, currentArtifacts, oldSource), /runtime evidence is missing or bound to another candidate/);
  assert.throws(() => promptEvidence(repaired.state, artifacts, repairedSource), /backend-implementation is stale/);
  assert.equal(JSON.stringify(repaired.state.history), repairedHistory);
  assert.equal(JSON.stringify(repaired.state.history.slice(0, -2)), originalHistory);
  assert.equal(JSON.stringify([...artifacts]), originalArtifacts);
  assert.equal(JSON.stringify([...currentArtifacts]), repairedArtifacts);
});
