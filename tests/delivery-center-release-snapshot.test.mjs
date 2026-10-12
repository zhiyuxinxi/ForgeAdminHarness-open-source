import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freezeDeliveryReleaseSnapshot } from '../docker/harness/delivery-center-release-snapshot.mjs';
import { DELIVERY_PHASES, deliverySnapshotDigest } from '../docker/harness/delivery-center-projection.mjs';
import { canonicalSha256 } from '../docker/harness/forge-acceptance-aggregator.mjs';
import { snapshotForgeDeliveryWorkspace } from '../docker/harness/forge-delivery-phase-workspace-observer.mjs';
import { inventoryWorkspace } from '../docker/harness/verification-runner.mjs';

const commit = 'a'.repeat(40); const sourceFingerprint = 'b'.repeat(64); const contractId = 'contract-release';
const ledger = { schemaVersion: 1, summaryType: 'forge-obligation-ledger-summary/v1', taskContractId: contractId,
  sourceFingerprint, ledgerDigest: 'c'.repeat(64), counts: { total: 0, open: 0, closed: 0, stale: 0 }, open: [], closed: [], stale: [] };
const ledgerSummary = { ...ledger, summaryDigest: canonicalSha256(ledger) };
const gate = { schemaVersion: 1, gateType: 'forge-protected-completion-gate/v1', evaluationMode: 'read-only-verifier',
  ledgerDigest: ledger.ledgerDigest, ledgerSummaryDigest: ledgerSummary.summaryDigest, ledgerSummary,
  sourceFingerprint: `sha256:${sourceFingerprint}`, candidateDiffSha256: `sha256:${'d'.repeat(64)}`,
  evaluatedAt: '2026-10-07T03:00:00.000Z', signedVerdictVerified: true, outcome: 'READY', maximumTerminalOutcome: 'COMPLETE',
  cannotClaim: [], blockers: [], attestation: 'local-integrity-only; upstream-authentication-is-ed25519' };
const protectedGate = { ...gate, gateDigest: canonicalSha256(gate) };
const accepted = Object.fromEntries(DELIVERY_PHASES.map(([, kind], index) => [kind, String(index + 1).repeat(64)]));
const phasePatchDigest = '9'.repeat(64);
const fixture = () => ({ coverage: { gaps: [{ code: 'RELEASE_SOURCE_NOT_CONFIGURED' }] },
  batches: [{ id: 'batch-one', taskId: 'task-one', status: 'completed', sourceCommit: '0'.repeat(40), stateDigest: 'e'.repeat(64), acceptedArtifactDigests: accepted }],
  stages: DELIVERY_PHASES.map(([phaseId, kind]) => ({ batchId: 'batch-one', phaseId, status: 'accepted', isCurrent: true,
    digest: accepted[kind], sourceFingerprint: phasePatchDigest })),
  requirements: [{ id: 'req-one', name: '受验任务的功能', menuPath: ['业务菜单'], fields: [], actions: [], rules: [], permissions: [],
    batchIds: ['batch-one'], status: 'documented', sources: [] }] });
const args = { projectSlug: 'example-project', projectRoot: process.cwd(), taskId: 'task-one', commit, sourceFingerprint, contractId, protectedGate,
  workspace: process.cwd(), observe: async () => ({ cumulativePatchDigest: phasePatchDigest }),
  inspectSource: async () => ({ head: commit, workspaceFingerprint: sourceFingerprint }) };

test('release scope freezes only the exact accepted task with all eight current digests and protected candidate fingerprint', async () => {
  let requested;
  const result = await freezeDeliveryReleaseSnapshot({ ...args, collect: async input => { requested = input; return fixture(); } });
  assert.equal(requested.taskIdFilter, 'task-one');
  assert.equal(requested.releaseAuditPath, null);
  assert.equal(result.status, 'bound');
  assert.equal(result.scope, 'validated-task-delivery');
  assert.equal(result.commit, commit);
  assert.deepEqual(result.acceptedArtifactDigests, accepted);
  assert.equal(result.phasePatchDigest, phasePatchDigest);
  assert.notEqual(result.phasePatchDigest, result.sourceFingerprint);
  assert.equal(result.requirements[0].id, 'req-one');
  const { digest, ...payload } = result;
  assert.equal(digest, deliverySnapshotDigest(payload));
});

test('unknown phase, stale digest, wrong fingerprint, another task and incomplete reads remain nonblocking unknowns', async () => {
  const variants = [
    ['PHASE_DELIVERY_NOT_COMPLETED', value => { value.batches[0].status = 'active'; }],
    ['CURRENT_PHASE_DIGESTS_INCOMPLETE', value => { value.stages[7].isCurrent = false; }],
    ['CURRENT_PHASE_DIGESTS_INCOMPLETE', value => { value.stages[7].digest = 'f'.repeat(64); }],
    ['PHASE_SOURCE_FINGERPRINT_MISMATCH', value => { value.stages[7].sourceFingerprint = '0'.repeat(64); }],
    ['TASK_REQUIREMENT_SCOPE_INCOMPLETE', value => { value.requirements[0].batchIds.push('batch-another'); }],
    ['PROJECTION_LIMIT', value => { value.coverage.gaps.push({ code: 'PROJECTION_LIMIT' }); }],
  ];
  for (const [reason, change] of variants) {
    const value = fixture(); change(value);
    const result = await freezeDeliveryReleaseSnapshot({ ...args, collect: async () => value });
    assert.equal(result.status, 'unknown', reason); assert.equal(result.reason, reason);
    assert.equal(result.requirements, undefined);
  }
  const unavailable = await freezeDeliveryReleaseSnapshot({ ...args, collect: async () => { throw new Error('private diagnostic details'); } });
  assert.equal(unavailable.reason, 'PHASE_SNAPSHOT_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(unavailable), /private diagnostic/u);
  const untrusted = await freezeDeliveryReleaseSnapshot({ ...args, protectedGate: { ...protectedGate, signedVerdictVerified: false },
    collect: async () => { throw new Error('must not collect'); } });
  assert.equal(untrusted.reason, 'PROTECTED_ACCEPTANCE_UNBOUND');
});

test('real Controller patch bytes bridge to the protected workspace fingerprint of the exact committed candidate', async t => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'dc-release-source-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const run = promisify(execFile);
  const git = async (...arguments_) => (await run('git', ['-C', workspace, ...arguments_], { windowsHide: true })).stdout.trim();
  await git('init'); await git('config', 'user.name', 'Delivery fixture'); await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(workspace, 'feature.txt'), 'before\n'); await git('add', '--all'); await git('commit', '-m', 'base');
  const baseCommit = await git('rev-parse', 'HEAD');
  await writeFile(path.join(workspace, 'feature.txt'), 'after\n'); await git('add', '--all'); await git('commit', '-m', 'candidate');
  const candidate = await git('rev-parse', 'HEAD');
  const limits = { maxFiles: 100, maxBytes: 1024 * 1024 };
  const actual = await inventoryWorkspace(workspace, limits);
  const phaseObservation = await snapshotForgeDeliveryWorkspace({ workspace, baseCommit, expectedHead: candidate });
  assert.notEqual(phaseObservation.cumulativePatchDigest, actual.workspaceFingerprint);
  const candidateLedger = { ...ledger, sourceFingerprint: actual.workspaceFingerprint };
  const candidateSummary = { ...candidateLedger, summaryDigest: canonicalSha256(candidateLedger) };
  const candidateGate = { ...gate, sourceFingerprint: `sha256:${actual.workspaceFingerprint}`,
    ledgerSummary: candidateSummary, ledgerSummaryDigest: candidateSummary.summaryDigest };
  const phase = fixture(); phase.batches[0].sourceCommit = baseCommit;
  phase.stages[7].sourceFingerprint = phaseObservation.cumulativePatchDigest;
  const input = { ...args, workspace, commit: candidate, sourceFingerprint: actual.workspaceFingerprint,
    protectedGate: { ...candidateGate, gateDigest: canonicalSha256(candidateGate) }, collect: async () => phase,
    observe: snapshotForgeDeliveryWorkspace, inspectSource: () => inventoryWorkspace(workspace, limits) };
  const frozen = await freezeDeliveryReleaseSnapshot(input);
  assert.equal(frozen.status, 'bound');
  assert.equal(frozen.commit, candidate);
  assert.equal(frozen.baseSourceCommit, baseCommit);
  assert.equal(frozen.phasePatchDigest, phaseObservation.cumulativePatchDigest);
  assert.equal(frozen.sourceFingerprint, actual.workspaceFingerprint);
  await writeFile(path.join(workspace, 'feature.txt'), 'changed during collection\n');
  const stale = await freezeDeliveryReleaseSnapshot(input);
  assert.equal(stale.status, 'unknown');
  assert.equal(stale.reason, 'CANDIDATE_SOURCE_CHANGED');
});
