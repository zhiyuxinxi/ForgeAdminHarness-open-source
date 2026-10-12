import path from 'node:path';
import { protectedCompletionProjectionReady } from './forge-completion-claim-guard.mjs';
import { collectDeliverySnapshot, deliverySnapshotDigest, DELIVERY_PHASES } from './delivery-center-projection.mjs';
import { snapshotForgeDeliveryWorkspace } from './forge-delivery-phase-workspace-observer.mjs';

const SHA = /^[a-f0-9]{64}$/u;
const fingerprint = value => typeof value === 'string' && SHA.test(value.replace(/^sha256:/u, '')) ? value.replace(/^sha256:/u, '') : null;

/** Reporting-only capture after the existing release authorization and gate.
 * Failure to establish scope is recorded as unknown; it never authorizes,
 * rejects, retries or otherwise changes the underlying controlled release.
 */
export async function freezeDeliveryReleaseSnapshot({ projectSlug, projectRoot, taskId, commit, sourceFingerprint,
  contractId, protectedGate, workspace, inspectSource, collect = collectDeliverySnapshot, observe = snapshotForgeDeliveryWorkspace }) {
  const evidence = { schemaVersion: 1, projectSlug, taskId, commit, scope: 'validated-task-delivery',
    sourceFingerprint: fingerprint(sourceFingerprint), acceptanceGateDigest: fingerprint(protectedGate?.gateDigest) };
  const unknown = reason => { const value = { ...evidence, status: 'unknown', reason }; return { ...value, digest: deliverySnapshotDigest(value) }; };
  try {
    if (!/^[a-f0-9]{40}$/u.test(commit ?? '') || evidence.sourceFingerprint === null
      || !protectedCompletionProjectionReady(protectedGate)
      || fingerprint(protectedGate.sourceFingerprint) !== evidence.sourceFingerprint
      || protectedGate.ledgerSummary?.taskContractId !== contractId) return unknown('PROTECTED_ACCEPTANCE_UNBOUND');
    const snapshot = await collect({ projectSlug, projectName: projectSlug,
      phaseRoot: path.join(projectRoot, 'taskspaces', '.broker', 'delivery-phases'), taskIdFilter: taskId,
      releaseAuditPath: null, brokerAuditPath: null, observedAt: protectedGate.evaluatedAt });
    const fatal = (snapshot.coverage?.gaps ?? []).find(gap => gap.code !== 'RELEASE_SOURCE_NOT_CONFIGURED');
    if (fatal) return unknown(/^[A-Z][A-Z0-9_]{1,79}$/u.test(fatal.code ?? '') ? fatal.code : 'PHASE_SOURCE_INCOMPLETE');
    const batch = snapshot.batches.find(item => item.taskId === taskId);
    if (!batch || batch.status !== 'completed' || !SHA.test(batch.stateDigest ?? '')) return unknown('PHASE_DELIVERY_NOT_COMPLETED');
    const current = snapshot.stages.filter(stage => stage.batchId === batch.id && stage.isCurrent === true && stage.status === 'accepted');
    if (current.length !== DELIVERY_PHASES.length || DELIVERY_PHASES.some(([phaseId, kind]) => {
      const matches = current.filter(stage => stage.phaseId === phaseId);
      return matches.length !== 1 || !SHA.test(matches[0].digest ?? '') || matches[0].digest !== batch.acceptedArtifactDigests?.[kind];
    })) return unknown('CURRENT_PHASE_DIGESTS_INCOMPLETE');
    const final = current.find(stage => stage.phaseId === 'cross-layer-acceptance');
    // Controller sourceFingerprint is the cumulative binary patch digest. The
    // protected gate uses a complete workspace inventory fingerprint. Observe
    // the exact candidate with the Controller's existing patch implementation
    // and recheck its inventory; comparing these different hashes is invalid.
    if (!/^[a-f0-9]{40}$/u.test(batch.sourceCommit ?? '') || typeof inspectSource !== 'function') return unknown('CANDIDATE_OBSERVATION_UNAVAILABLE');
    const observed = await observe({ workspace, baseCommit: batch.sourceCommit, expectedHead: commit });
    const source = await inspectSource();
    if (source.head !== commit || source.workspaceFingerprint !== evidence.sourceFingerprint) return unknown('CANDIDATE_SOURCE_CHANGED');
    if (!SHA.test(observed.cumulativePatchDigest ?? '') || final.sourceFingerprint !== observed.cumulativePatchDigest) return unknown('PHASE_SOURCE_FINGERPRINT_MISMATCH');
    if (!snapshot.requirements.length || snapshot.requirements.some(item => item.status === 'conflict'
      || item.batchIds.some(id => id !== batch.id))) return unknown('TASK_REQUIREMENT_SCOPE_INCOMPLETE');
    const value = { ...evidence, status: 'bound', stateDigest: batch.stateDigest,
      baseSourceCommit: batch.sourceCommit, phasePatchDigest: observed.cumulativePatchDigest,
      acceptedArtifactDigests: { ...batch.acceptedArtifactDigests }, requirements: snapshot.requirements,
      frozenAt: protectedGate.evaluatedAt };
    if (Buffer.byteLength(JSON.stringify(value)) > 768 * 1024) return unknown('SNAPSHOT_SIZE_LIMIT');
    return { ...value, digest: deliverySnapshotDigest(value) };
  } catch (error) {
    const reason = error.message === 'DELIVERY_PHASE_SOURCE_UNAVAILABLE' ? 'PHASE_SOURCE_UNAVAILABLE' : 'PHASE_SNAPSHOT_UNAVAILABLE';
    return unknown(reason);
  }
}
