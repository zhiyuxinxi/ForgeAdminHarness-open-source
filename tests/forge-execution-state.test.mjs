import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ForgeExecutionStateError,
  commitExecutionBudget,
  createExecutionState,
  failurePolicy,
  observeExecutionFailure,
  reduceExecutionState,
  releaseExecutionBudget,
  reserveExecutionBudget,
  sealExecutionReceipt,
  stopExecution,
  validateExecutionState,
  verifyExecutionReceiptChain,
} from '../docker/harness/forge-execution-state.mjs';

const SHA = (character) => character.repeat(64);
const TIME = (minute) => `2026-09-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
const PROJECT_SLUG = 'forge-admin-harness';
const ADMISSION_ID = '123e4567-e89b-12d3-a456-426614174099';
const OTHER_ADMISSION_ID = '123e4567-e89b-12d3-a456-426614174100';

const executionAdmissionReceipt = (overrides = {}) => ({
  schemaVersion: 1,
  receiptType: 'forge-verify/execution-admission',
  admissionId: ADMISSION_ID,
  projectSlug: PROJECT_SLUG,
  taskId: 'task-001',
  runner: {
    bootId: '123e4567-e89b-12d3-a456-426614174101',
    revision: 'vpn-forge-delivery-toolkit-test',
  },
  profiles: ['backend-module-test'],
  source: {
    head: '1'.repeat(40),
    workspaceFingerprint: SHA('c'),
    dependencyManifestFingerprint: SHA('e'),
  },
  cache: {
    mode: 'project-scoped-immutable-pack',
    compatible: true,
    packDigest: SHA('f'),
  },
  executor: {
    proven: true,
    dockerApiProven: true,
    toolchainImageProven: true,
    samePathBindProven: true,
    stateWriteProven: true,
    cleanupProven: true,
  },
  issuedAt: TIME(2),
  expiresAt: TIME(12),
  outcome: 'ready',
  reasonCode: null,
  truth: {
    executionProven: false,
    verificationProven: false,
    semanticCorrectnessProven: false,
    databaseIntegrationProven: false,
    releaseProven: false,
  },
  ...overrides,
});

const hostExecutionAdmissionReceipt = (overrides = {}) => {
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
  return {
    schemaVersion: 2,
    receiptType: 'forge-verify/host-execution-admission',
    admissionId: ADMISSION_ID,
    projectSlug: PROJECT_SLUG,
    taskId: 'task-001',
    runner: {
      bootId: '123e4567-e89b-12d3-a456-426614174101',
      revision: 'vpn73-host-runner-2026.09.03.12',
    },
    profiles: ['backend-module-test'],
    source: {
      head: '1'.repeat(40),
      workspaceFingerprint: SHA('c'),
      dependencyManifestFingerprint: SHA('e'),
    },
    profileCatalogVersion: '2026.09.03.3',
    profilePolicyDigest: SHA('7'),
    toolchain: { javaHome: '/opt/forge-tools/java-home', executables, digest: SHA('8') },
    issuedAt: TIME(2),
    expiresAt: TIME(7),
    outcome: 'ready',
    reasonCode: null,
    truth: {
      executionProven: false,
      verificationProven: false,
      semanticCorrectnessProven: false,
      databaseIntegrationProven: false,
      releaseProven: false,
    },
    ...overrides,
  };
};

const redReceipt = (sourceFingerprint, overrides = {}) => sealExecutionReceipt({
  receiptType: 'forge-execution/red-gate/v1',
  receiptId: 'red-gate-1',
  sourceFingerprint,
  executedTests: 1,
  expectedFailureMatched: true,
  infrastructureFailure: false,
  sourceReceiptDigest: `sha256:${SHA('9')}`,
  ...overrides,
});

const governanceReceipt = (sourceFingerprint, overrides = {}) => sealExecutionReceipt({
  receiptType: 'forge-execution/governance-ref/v1',
  receiptId: 'governance-1',
  sourceFingerprint,
  status: 'passed',
  ...overrides,
});

const verificationReceipt = (sourceFingerprint, profile = 'backend-module-test', overrides = {}) =>
  sealExecutionReceipt({
    receiptType: 'forge-execution/verification-ref/v1',
    receiptId: `verification-${profile}`,
    admissionId: ADMISSION_ID,
    sourceFingerprint,
    profile,
    status: 'passed',
    verificationProven: true,
    ...overrides,
  });

const acceptanceReceipt = (sourceFingerprint, verdict = 'accepted', overrides = {}) =>
  sealExecutionReceipt({
    receiptType: 'forge-execution/acceptance-verdict-ref/v1',
    receiptId: 'acceptance-1',
    sourceFingerprint,
    verdict,
    signatureProven: true,
    ...overrides,
  });

const evidenceTruthReceipt = (state, overrides = {}) => sealExecutionReceipt({
  receiptType: 'forge-execution/evidence-truth/v1',
  receiptId: 'evidence-truth-1',
  sourceFingerprint: state.sourceFingerprint,
  evidenceHeadDigest: state.receiptHeadDigest,
  ...overrides,
});

function fixture(overrides = {}) {
  return createExecutionState({
    executionId: 'execution-001',
    projectSlug: PROJECT_SLUG,
    taskId: 'task-001',
    contractId: SHA('a'),
    registryDigest: SHA('b'),
    sourceFingerprint: SHA('c'),
    actionCeiling: 'workspace-write',
    tddRequired: true,
    requiredSkills: ['forge-task-router', 'forge-testing-observability'],
    requiredProfiles: ['backend-module-test'],
    criteria: ['AC-BACKEND'],
    createdAt: TIME(0),
    ...overrides,
  });
}

function routeAndPreflight(state) {
  let next = reduceExecutionState(state, {
    type: 'route.completed',
    observedSkills: ['forge-testing-observability', 'forge-task-router'],
    observedAt: TIME(1),
  });
  next = reduceExecutionState(next, { type: 'preflight.started', observedAt: TIME(2) });
  return reduceExecutionState(next, {
    type: 'preflight.completed',
    receipt: executionAdmissionReceipt(),
    observedAt: TIME(3),
  });
}

test('ordinary draft entry preserves production ceilings while refusing read-only, missing authority and TDD', () => {
  for (const [actionCeiling, draftBeforeVerification, tddRequired, allowed] of [
    ['workspace-write', true, false, true], ['git-checkpoint', true, false, true], ['release', true, false, true],
    ['read-only', true, false, false], ['release', false, false, false], ['release', true, true, false],
  ]) {
    let state = fixture({ actionCeiling, draftBeforeVerification, tddRequired });
    state = reduceExecutionState(state, { type: 'route.completed',
      observedSkills: ['forge-testing-observability', 'forge-task-router'], observedAt: TIME(1) });
    state = reduceExecutionState(state, { type: 'preflight.started', observedAt: TIME(2) });
    const enter = () => reduceExecutionState(state, { type: 'draft.started', observedAt: TIME(3) });
    if (allowed) {
      const next = enter();
      assert.equal(next.phase, 'DISCOVER');
      assert.equal(next.actionCeiling, actionCeiling);
      assert.equal(next.admission, null);
    } else assert.throws(enter, { code: 'EXECUTION_DRAFT_AUTHORITY_REQUIRED' });
  }
});

test('host-toolchain admission is stored as a distinct truthful runtime identity', () => {
  let state = fixture();
  state = reduceExecutionState(state, {
    type: 'route.completed',
    observedSkills: ['forge-testing-observability', 'forge-task-router'],
    observedAt: TIME(1),
  });
  state = reduceExecutionState(state, { type: 'preflight.started', observedAt: TIME(2) });
  state = reduceExecutionState(state, {
    type: 'preflight.completed',
    receipt: hostExecutionAdmissionReceipt(),
    observedAt: TIME(3),
  });
  assert.equal(state.phase, 'DISCOVER');
  assert.equal(state.admission.executionMode, 'host-toolchain');
  assert.equal(state.admission.toolchainDigest, SHA('8'));
  assert.equal(Object.hasOwn(state.admission, 'cachePackDigest'), false);
  assert.equal(verifyExecutionReceiptChain(state), true);

  const forged = structuredClone(state);
  forged.admission.toolchainDigest = SHA('9');
  assert.equal(verifyExecutionReceiptChain(forged), false);
});

test('host admission compares the same profile set in reviewed catalog order without weakening closure', () => {
  const initial = fixture({
    requiredProfiles: ['governance', 'backend-module-test'],
    redProfiles: ['backend-red-test'],
  });
  let routed = reduceExecutionState(initial, {
    type: 'route.completed',
    observedSkills: ['forge-testing-observability', 'forge-task-router'],
    observedAt: TIME(1),
  });
  routed = reduceExecutionState(routed, { type: 'preflight.started', observedAt: TIME(2) });
  const receipt = hostExecutionAdmissionReceipt({
    profiles: ['governance', 'backend-red-test', 'backend-module-test'],
  });
  const admitted = reduceExecutionState(routed, {
    type: 'preflight.completed', receipt, observedAt: TIME(3),
  });
  assert.deepEqual(admitted.admissionProfiles, [
    'backend-module-test', 'backend-red-test', 'governance',
  ], 'stored state ordering remains unchanged');
  assert.deepEqual(admitted.admission.profiles, receipt.profiles);

  for (const profiles of [
    ['governance', 'backend-module-test'],
    ['governance', 'backend-red-test', 'backend-module-test', 'changed-safe'],
  ]) assert.throws(
    () => reduceExecutionState(routed, {
      type: 'preflight.completed',
      receipt: hostExecutionAdmissionReceipt({ profiles }),
      observedAt: TIME(3),
    }),
    (error) => error instanceof ForgeExecutionStateError && error.code === 'EXECUTION_ADMISSION_INVALID',
  );
});

function reachRedGate(state = fixture()) {
  let next = routeAndPreflight(state);
  return reduceExecutionState(next, {
    type: 'discovery.completed',
    incrementId: 'increment-1',
    criteria: ['AC-BACKEND'],
    ownedPaths: ['forge-server/example/src/main/java/Example.java'],
    verificationProfiles: ['backend-module-test'],
    observedAt: TIME(4),
  });
}

function reachIncrementGate(state = fixture()) {
  let next = reachRedGate(state);
  next = reduceExecutionState(next, {
    type: 'red.completed',
    receipt: redReceipt(SHA('c')),
    observedAt: TIME(5),
  });
  next = reserveExecutionBudget(next, {
    reservationId: 'mutation-1', dimension: 'mutations', amount: 1, observedAt: TIME(6),
  });
  next = commitExecutionBudget(next, { reservationId: 'mutation-1' });
  next = reduceExecutionState(next, {
    type: 'implementation.completed', sourceFingerprint: SHA('d'), observedAt: TIME(7),
  });
  return next;
}

function reachVerifyAffected(state = fixture()) {
  return reduceExecutionState(reachIncrementGate(state), {
    type: 'increment-gate.completed',
    governanceReceipt: governanceReceipt(SHA('d')),
    verificationReceipts: [verificationReceipt(SHA('d'))],
    hasMoreIncrements: false,
    observedAt: TIME(8),
  });
}

test('normal TDD path closes only with current audit, verification, signed acceptance, and fresh evidence truth', () => {
  let state = reachVerifyAffected();
  assert.equal(state.phase, 'VERIFY_AFFECTED');
  state = reduceExecutionState(state, {
    type: 'affected-verification.completed',
    governanceReceipt: governanceReceipt(SHA('d')),
    verificationReceipts: [verificationReceipt(SHA('d'))],
    observedAt: TIME(9),
  });
  state = reduceExecutionState(state, {
    type: 'acceptance.completed', receipt: acceptanceReceipt(SHA('d')), observedAt: TIME(10),
  });
  state = reduceExecutionState(state, {
    type: 'closeout.completed', receipt: evidenceTruthReceipt(state), observedAt: TIME(11),
  });

  assert.equal(state.phase, 'COMPLETE');
  assert.equal(state.terminalOutcome, 'COMPLETE');
  assert.deepEqual(state.stopReceipt.truth, {
    implemented: true, audited: true, verified: true, accepted: true,
  });
  assert.deepEqual(state.openCriteria, []);
  assert.equal(state.admission.admissionId, ADMISSION_ID);
  assert.equal(state.admission.projectSlug, PROJECT_SLUG);
  const admissionTransition = state.phaseReceipts.find((receipt) => receipt.reasonCode === 'PREFLIGHT_READY');
  assert.ok(admissionTransition.evidenceReceiptDigests.includes(state.admission.admissionDigest));
  assert.equal(verifyExecutionReceiptChain(state), true);

  const tamperedAdmission = structuredClone(state);
  tamperedAdmission.admission.receipt.cache.packDigest = SHA('8');
  assert.equal(verifyExecutionReceiptChain(tamperedAdmission), false);

  const tamperedAcceptance = structuredClone(state);
  tamperedAcceptance.acceptance.receipt.signatureProven = false;
  assert.equal(verifyExecutionReceiptChain(tamperedAcceptance), false);

  const tamperedEvidenceTruth = structuredClone(state);
  tamperedEvidenceTruth.closeout.evidenceTruthReceipt.evidenceHeadDigest = `sha256:${SHA('f')}`;
  assert.equal(verifyExecutionReceiptChain(tamperedEvidenceTruth), false);

  const detachedEvidenceReference = structuredClone(state);
  detachedEvidenceReference.phaseReceipts.at(-1).evidenceReceiptDigests = [];
  assert.equal(verifyExecutionReceiptChain(detachedEvidenceReference), false);

  assert.ok(Object.isFrozen(state));
  assert.doesNotThrow(() => JSON.stringify(state));
});

test('RED gate rejects naked booleans, stale source, infrastructure failure, and digest tampering', () => {
  const state = reachRedGate();
  assert.throws(() => reduceExecutionState(state, {
    type: 'red.completed',
    executedTests: 1,
    expectedFailureMatched: true,
    infrastructureFailure: false,
    observedAt: TIME(5),
  }), (error) => error.code === 'EXECUTION_RECEIPT_INVALID');

  assert.throws(() => reduceExecutionState(state, {
    type: 'red.completed', receipt: redReceipt(SHA('f')), observedAt: TIME(5),
  }), (error) => error.code === 'EXECUTION_RED_INVALID');

  assert.throws(() => reduceExecutionState(state, {
    type: 'red.completed',
    receipt: redReceipt(SHA('c'), { infrastructureFailure: true }),
    observedAt: TIME(5),
  }), (error) => error.code === 'EXECUTION_RED_INVALID');

  const tampered = structuredClone(redReceipt(SHA('c')));
  tampered.executedTests = 2;
  assert.throws(() => reduceExecutionState(state, {
    type: 'red.completed', receipt: tampered, observedAt: TIME(5),
  }), (error) => error.code === 'EXECUTION_RECEIPT_DIGEST_INVALID');
});

test('RED preparation mutations consume budget but cannot satisfy implementation completion', () => {
  let state = reachRedGate();
  state = reserveExecutionBudget(state, {
    reservationId: 'red-test-file', dimension: 'mutations', amount: 1, observedAt: TIME(5),
  });
  state = commitExecutionBudget(state, { reservationId: 'red-test-file' });
  state = reduceExecutionState(state, {
    type: 'red.completed', receipt: redReceipt(SHA('c')), observedAt: TIME(6),
  });
  assert.equal(state.phase, 'IMPLEMENT_INCREMENT');
  assert.equal(state.increment.mutationBaseline, 1);
  assert.throws(() => reduceExecutionState(state, {
    type: 'implementation.completed', sourceFingerprint: SHA('d'), observedAt: TIME(7),
  }), (error) => error.code === 'EXECUTION_IMPLEMENTATION_INVALID');

  state = reserveExecutionBudget(state, {
    reservationId: 'production-source', dimension: 'mutations', amount: 1, observedAt: TIME(7),
  });
  state = commitExecutionBudget(state, { reservationId: 'production-source' });
  state = reduceExecutionState(state, {
    type: 'implementation.completed', sourceFingerprint: SHA('d'), observedAt: TIME(8),
  });
  assert.equal(state.phase, 'INCREMENT_GATE');
});

test('increment and affected gates require current typed governance and exact verification profile closure', () => {
  const increment = reachIncrementGate();
  assert.throws(() => reduceExecutionState(increment, {
    type: 'increment-gate.completed', governancePassed: true, verificationPassed: true,
    sourceFingerprint: SHA('d'), hasMoreIncrements: false, observedAt: TIME(8),
  }), (error) => error.code === 'EXECUTION_RECEIPT_INVALID');

  assert.throws(() => reduceExecutionState(increment, {
    type: 'increment-gate.completed',
    governanceReceipt: governanceReceipt(SHA('d')),
    verificationReceipts: [],
    hasMoreIncrements: false,
    observedAt: TIME(8),
  }), (error) => error.code === 'EXECUTION_VERIFICATION_PROFILE_INCOMPLETE');

  assert.throws(() => reduceExecutionState(increment, {
    type: 'increment-gate.completed',
    governanceReceipt: governanceReceipt(SHA('d')),
    verificationReceipts: [verificationReceipt(SHA('d'), 'backend-module-test', { verificationProven: false })],
    hasMoreIncrements: false,
    observedAt: TIME(8),
  }), (error) => error.code === 'EXECUTION_VERIFICATION_RECEIPT_INVALID');
  assert.throws(() => reduceExecutionState(increment, {
    type: 'increment-gate.completed',
    governanceReceipt: governanceReceipt(SHA('d')),
    verificationReceipts: [verificationReceipt(SHA('d'), 'backend-module-test', { admissionId: OTHER_ADMISSION_ID })],
    hasMoreIncrements: false,
    observedAt: TIME(8),
  }), (error) => error.code === 'EXECUTION_VERIFICATION_RECEIPT_INVALID');

  const affected = reachVerifyAffected();
  assert.throws(() => reduceExecutionState(affected, {
    type: 'affected-verification.completed', passed: true, sourceFingerprint: SHA('d'), observedAt: TIME(9),
  }), (error) => error.code === 'EXECUTION_RECEIPT_INVALID');
  assert.throws(() => reduceExecutionState(affected, {
    type: 'affected-verification.completed',
    governanceReceipt: governanceReceipt(SHA('c')),
    verificationReceipts: [verificationReceipt(SHA('d'))],
    observedAt: TIME(9),
  }), (error) => error.code === 'EXECUTION_GOVERNANCE_RECEIPT_INVALID');
});

test('acceptance and closeout require typed current receipts instead of naked authority booleans', () => {
  let acceptance = reachVerifyAffected();
  acceptance = reduceExecutionState(acceptance, {
    type: 'affected-verification.completed',
    governanceReceipt: governanceReceipt(SHA('d')),
    verificationReceipts: [verificationReceipt(SHA('d'))],
    observedAt: TIME(9),
  });
  assert.throws(() => reduceExecutionState(acceptance, {
    type: 'acceptance.completed', verdict: 'accepted', signed: true,
    sourceFingerprint: SHA('d'), observedAt: TIME(10),
  }), (error) => error.code === 'EXECUTION_RECEIPT_INVALID');
  assert.throws(() => reduceExecutionState(acceptance, {
    type: 'acceptance.completed',
    receipt: acceptanceReceipt(SHA('d'), 'accepted', { signatureProven: false }),
    observedAt: TIME(10),
  }), (error) => error.code === 'EXECUTION_ACCEPTANCE_INVALID');
  assert.throws(() => reduceExecutionState(acceptance, {
    type: 'acceptance.completed',
    receipt: acceptanceReceipt(SHA('d'), 'candidate-blocked', { signatureProven: false }),
    observedAt: TIME(10),
  }), (error) => error.code === 'EXECUTION_ACCEPTANCE_INVALID');

  const tamperedAcceptance = structuredClone(acceptanceReceipt(SHA('d')));
  tamperedAcceptance.verdict = 'candidate-blocked';
  assert.throws(() => reduceExecutionState(acceptance, {
    type: 'acceptance.completed', receipt: tamperedAcceptance, observedAt: TIME(10),
  }), (error) => error.code === 'EXECUTION_RECEIPT_DIGEST_INVALID');

  const closeout = reduceExecutionState(acceptance, {
    type: 'acceptance.completed', receipt: acceptanceReceipt(SHA('d')), observedAt: TIME(10),
  });
  assert.throws(() => reduceExecutionState(closeout, {
    type: 'closeout.completed', evidenceTruthFresh: true, observedAt: TIME(11),
  }), (error) => error.code === 'EXECUTION_RECEIPT_INVALID');
  assert.throws(() => reduceExecutionState(closeout, {
    type: 'closeout.completed',
    receipt: evidenceTruthReceipt(closeout, { sourceFingerprint: SHA('c') }),
    observedAt: TIME(11),
  }), (error) => error.code === 'EXECUTION_CLOSEOUT_INVALID');
  assert.throws(() => reduceExecutionState(closeout, {
    type: 'closeout.completed',
    receipt: evidenceTruthReceipt(closeout, { evidenceHeadDigest: `sha256:${SHA('f')}` }),
    observedAt: TIME(11),
  }), (error) => error.code === 'EXECUTION_CLOSEOUT_INVALID');
});

test('route and typed batch admission fail closed on incomplete routing or forged readiness', () => {
  const state = fixture();
  assert.throws(() => reduceExecutionState(state, {
    type: 'route.completed', observedSkills: ['forge-task-router'], observedAt: TIME(1),
  }), (error) => error instanceof ForgeExecutionStateError && error.code === 'EXECUTION_ROUTING_INCOMPLETE');

  let routed = reduceExecutionState(state, {
    type: 'route.completed',
    observedSkills: ['forge-task-router', 'forge-testing-observability'],
    observedAt: TIME(1),
  });
  routed = reduceExecutionState(routed, { type: 'preflight.started', observedAt: TIME(2) });
  assert.throws(() => reduceExecutionState(routed, {
    type: 'preflight.completed',
    capabilities: [{ profile: 'backend-module-test', outcome: 'cache_miss', sourceFingerprint: SHA('c') }],
    observedAt: TIME(3),
  }), (error) => error.code === 'EXECUTION_RECEIPT_INVALID');

  const rejected = (mutate, code) => {
    const receipt = structuredClone(executionAdmissionReceipt());
    mutate(receipt);
    assert.throws(() => reduceExecutionState(routed, {
      type: 'preflight.completed', receipt, observedAt: TIME(3),
    }), (error) => error.code === code);
  };
  rejected((receipt) => { receipt.extra = true; }, 'EXECUTION_RECEIPT_INVALID');
  rejected((receipt) => { receipt.expiresAt = TIME(2); }, 'EXECUTION_ADMISSION_LEASE_INVALID');
  rejected((receipt) => { receipt.issuedAt = TIME(4); receipt.expiresAt = TIME(5); }, 'EXECUTION_ADMISSION_LEASE_INVALID');
  rejected((receipt) => { receipt.issuedAt = TIME(0); receipt.expiresAt = TIME(16); }, 'EXECUTION_ADMISSION_LEASE_INVALID');
  rejected((receipt) => {
    receipt.issuedAt = '2026-09-01T00:02:50.000Z';
    receipt.expiresAt = '2026-09-01T00:03:10.000Z';
  }, 'EXECUTION_ADMISSION_LEASE_INVALID');
  rejected((receipt) => { receipt.taskId = 'other-task'; }, 'EXECUTION_ADMISSION_IDENTITY_MISMATCH');
  rejected((receipt) => { receipt.projectSlug = 'other-project'; }, 'EXECUTION_ADMISSION_IDENTITY_MISMATCH');
  rejected((receipt) => { receipt.source.workspaceFingerprint = SHA('9'); }, 'EXECUTION_ADMISSION_SOURCE_MISMATCH');
  rejected((receipt) => { receipt.source.dependencyManifestFingerprint = 'invalid'; }, 'EXECUTION_FIELD_INVALID');
  rejected((receipt) => { receipt.profiles = []; }, 'EXECUTION_ADMISSION_PROFILE_MISMATCH');
  rejected((receipt) => { receipt.profiles.push('backend-module-test'); }, 'EXECUTION_FIELD_INVALID');
  rejected((receipt) => { receipt.executor.cleanupProven = false; }, 'EXECUTION_ADMISSION_EXECUTOR_INVALID');
  rejected((receipt) => { receipt.cache.compatible = false; }, 'EXECUTION_ADMISSION_CACHE_INVALID');
  rejected((receipt) => { receipt.cache.packDigest = 'invalid'; }, 'EXECUTION_FIELD_INVALID');
  rejected((receipt) => { receipt.truth.verificationProven = true; }, 'EXECUTION_ADMISSION_TRUTH_INVALID');
});

test('hard environment failure stops before mutation with a typed bounded receipt', () => {
  let state = fixture();
  state = observeExecutionFailure(state, {
    observedAt: TIME(1),
    failure: {
      failureClass: 'CAPABILITY_HARD',
      code: 'VERIFY_CACHE_MISS',
      resolutionAuthority: 'platform-operator',
      attemptKey: 'capability:backend-module-test',
    },
  });
  assert.equal(state.terminalOutcome, 'BOUNDED_BLOCKED');
  assert.equal(state.stopReceipt.failure.failureClass, 'CAPABILITY_HARD');
  assert.equal(state.stopReceipt.truth.implemented, false);
  assert.equal(verifyExecutionReceiptChain(state), true);
  assert.throws(() => reserveExecutionBudget(state, {
    reservationId: 'late', dimension: 'steps', observedAt: TIME(2),
  }), (error) => error.code === 'EXECUTION_TERMINAL');
});

test('typed transient failures permit exactly one retry and never open source repair', () => {
  let state = routeAndPreflight(fixture());
  const failure = {
    failureClass: 'CAPABILITY_TRANSIENT',
    code: 'VERIFY_QUEUE_BUSY',
    resolutionAuthority: 'verification-runner',
    attemptKey: 'queue:backend-module-test',
  };
  state = observeExecutionFailure(state, { observedAt: TIME(4), failure });
  assert.equal(state.phase, 'DISCOVER');
  assert.equal(state.terminalOutcome, null);
  assert.equal(state.repair.used, false);
  state = observeExecutionFailure(state, { observedAt: TIME(5), failure });
  assert.equal(state.terminalOutcome, 'BOUNDED_BLOCKED');
  assert.equal(state.failureAttempts['queue:backend-module-test'], 2);
});

test('one source defect opens one repair window and a second failure is terminal', () => {
  let state = reachVerifyAffected();
  state = observeExecutionFailure(state, {
    observedAt: TIME(9),
    failure: {
      failureClass: 'SOURCE_DEFECT',
      code: 'BACKEND_TEST_FAILED',
      resolutionAuthority: 'task-agent',
      attemptKey: 'verify:backend-module-test',
      family: 'backend-module-test',
    },
  });
  assert.equal(state.phase, 'REPAIR');
  assert.equal(state.repair.used, true);
  assert.throws(() => reduceExecutionState(state, {
    type: 'repair.completed', sourceFingerprint: SHA('e'), observedAt: TIME(10),
  }), (error) => error.code === 'EXECUTION_REPAIR_INVALID');
  state = reserveExecutionBudget(state, {
    reservationId: 'repair-1', dimension: 'mutations', observedAt: TIME(10),
  });
  state = commitExecutionBudget(state, { reservationId: 'repair-1' });
  assert.throws(() => reduceExecutionState(state, {
    type: 'repair.completed', sourceFingerprint: SHA('d'), observedAt: TIME(11),
  }), (error) => error.code === 'EXECUTION_REPAIR_INVALID');
  assert.throws(() => reduceExecutionState(state, {
    type: 'repair.completed', sourceFingerprint: `sha256:${SHA('d')}`, observedAt: TIME(11),
  }), (error) => error.code === 'EXECUTION_REPAIR_INVALID');
  state = reduceExecutionState(state, {
    type: 'repair.completed', sourceFingerprint: SHA('e'), observedAt: TIME(11),
  });
  assert.equal(state.phase, 'VERIFY_AFFECTED');
  assert.equal(state.sourceFingerprint, SHA('e'));
  state = observeExecutionFailure(state, {
    observedAt: TIME(12),
    failure: {
      failureClass: 'SOURCE_DEFECT',
      code: 'BACKEND_TEST_FAILED_AGAIN',
      resolutionAuthority: 'task-agent',
      attemptKey: 'verify:backend-module-test:again',
      family: 'backend-module-test',
    },
  });
  assert.equal(state.terminalOutcome, 'FAILED_SOURCE');
  assert.equal(state.stopReceipt.truth.accepted, false);
});

test('parallel reservations count before commit and exceeding a global budget hard-stops', () => {
  let state = fixture({
    tddRequired: false,
    budgets: { limits: { steps: 10, requests: 10, toolCalls: 10, mutations: 2 }, repairMaxMutations: 2 },
  });
  state = routeAndPreflight(state);
  state = reduceExecutionState(state, {
    type: 'discovery.completed',
    incrementId: 'increment-1',
    criteria: ['AC-BACKEND'],
    ownedPaths: ['forge-server/example/src/main/java/Example.java'],
    verificationProfiles: ['backend-module-test'],
    observedAt: TIME(4),
  });
  state = reserveExecutionBudget(state, {
    reservationId: 'parallel-1', dimension: 'mutations', observedAt: TIME(5),
  });
  state = reserveExecutionBudget(state, {
    reservationId: 'parallel-2', dimension: 'mutations', observedAt: TIME(5),
  });
  assert.equal(state.budgets.reserved.mutations, 2);
  state = reserveExecutionBudget(state, {
    reservationId: 'parallel-3', dimension: 'mutations', observedAt: TIME(5),
  });
  assert.equal(state.terminalOutcome, 'INCOMPLETE_BUDGET');
  assert.equal(state.stopReceipt.failure.code, 'BUDGET_MUTATIONS_EXHAUSTED');
  assert.equal(state.budgets.used.mutations, 0);
  assert.equal(state.budgets.reserved.mutations, 2);
});

test('repair mutation reservations also fail closed before parallel calls exceed the repair window', () => {
  let state = reachVerifyAffected(fixture({
    budgets: { limits: { steps: 80, requests: 96, toolCalls: 120, mutations: 20 }, repairMaxMutations: 2 },
  }));
  state = observeExecutionFailure(state, {
    observedAt: TIME(9),
    failure: {
      failureClass: 'SOURCE_DEFECT', code: 'TEST_FAILED', resolutionAuthority: 'task-agent',
      attemptKey: 'test:failure', family: 'backend-module-test',
    },
  });
  state = reserveExecutionBudget(state, {
    reservationId: 'repair-a', dimension: 'mutations', observedAt: TIME(10),
  });
  state = reserveExecutionBudget(state, {
    reservationId: 'repair-b', dimension: 'mutations', observedAt: TIME(10),
  });
  state = reserveExecutionBudget(state, {
    reservationId: 'repair-c', dimension: 'mutations', observedAt: TIME(10),
  });
  assert.equal(state.terminalOutcome, 'FAILED_SOURCE');
  assert.equal(state.stopReceipt.failure.code, 'REPAIR_MUTATION_BUDGET_EXHAUSTED');
});

test('reservations are idempotent by exact id and release does not consume budget', () => {
  let state = fixture();
  state = reserveExecutionBudget(state, {
    reservationId: 'step-a', dimension: 'steps', amount: 2, observedAt: TIME(1),
  });
  const same = reserveExecutionBudget(state, {
    reservationId: 'step-a', dimension: 'steps', amount: 2, observedAt: TIME(1),
  });
  assert.equal(same, state);
  state = releaseExecutionBudget(state, { reservationId: 'step-a' });
  assert.equal(state.budgets.used.steps, 0);
  assert.equal(state.budgets.reserved.steps, 0);
  assert.throws(() => commitExecutionBudget(state, { reservationId: 'step-a' }),
    (error) => error.code === 'EXECUTION_RESERVATION_MISSING');
});

test('serialized state can resume without losing receipt or reservation semantics', () => {
  let state = fixture();
  state = reserveExecutionBudget(state, {
    reservationId: 'request-a', dimension: 'requests', observedAt: TIME(1),
  });
  state = JSON.parse(JSON.stringify(state));
  assert.equal(verifyExecutionReceiptChain(state), true);
  state = commitExecutionBudget(state, { reservationId: 'request-a' });
  assert.equal(state.budgets.used.requests, 1);
  assert.equal(state.budgets.reserved.requests, 0);
  assert.ok(Object.isFrozen(state));
});

test('trusted production action ceilings survive state creation and serialized resume', () => {
  for (const actionCeiling of ['git-checkpoint', 'release']) {
    const state = fixture({ actionCeiling });
    const resumed = JSON.parse(JSON.stringify(state));

    assert.equal(state.actionCeiling, actionCeiling);
    assert.equal(resumed.actionCeiling, actionCeiling);
    assert.equal(validateExecutionState(resumed).actionCeiling, actionCeiling);
    assert.equal(verifyExecutionReceiptChain(resumed), true);
  }
});

test('execution state rejects unknown action ceilings instead of granting writer authority', () => {
  assert.throws(
    () => fixture({ actionCeiling: 'unknown' }),
    (error) => error.code === 'EXECUTION_FIELD_INVALID',
  );

  const tampered = JSON.parse(JSON.stringify(fixture()));
  tampered.actionCeiling = 'unknown';
  assert.throws(
    () => validateExecutionState(tampered),
    (error) => error.code === 'EXECUTION_STATE_INVALID',
  );
});

test('step, request, and tool-call dimensions use the same reservation ceiling', () => {
  for (const dimension of ['steps', 'requests', 'toolCalls']) {
    let state = fixture({
      budgets: { limits: { steps: 1, requests: 1, toolCalls: 1, mutations: 2 }, repairMaxMutations: 1 },
    });
    state = reserveExecutionBudget(state, {
      reservationId: `${dimension}-1`, dimension, observedAt: TIME(1),
    });
    state = reserveExecutionBudget(state, {
      reservationId: `${dimension}-2`, dimension, observedAt: TIME(1),
    });
    assert.equal(state.terminalOutcome, 'INCOMPLETE_BUDGET', dimension);
    assert.equal(state.stopReceipt.failure.failureClass, 'BUDGET_EXHAUSTED', dimension);
  }
});

test('invalid phase rewinds and false completion are rejected', () => {
  const state = fixture();
  assert.throws(() => reduceExecutionState(state, {
    type: 'affected-verification.completed', passed: true, sourceFingerprint: SHA('c'), observedAt: TIME(1),
  }), (error) => error.code === 'EXECUTION_TRANSITION_INVALID');
  assert.throws(() => stopExecution(state, {
    outcome: 'COMPLETE', observedAt: TIME(1), openCriteria: [],
  }), (error) => error.code === 'EXECUTION_FALSE_COMPLETE');
  assert.throws(() => stopExecution(state, {
    outcome: 'SAFETY_HOLD',
    observedAt: TIME(1),
    failure: {
      failureClass: 'CAPABILITY_HARD', code: 'VERIFY_CACHE_MISS',
      resolutionAuthority: 'platform-operator', attemptKey: 'cache:miss',
    },
  }), (error) => error.code === 'EXECUTION_STOP_OUTCOME_MISMATCH');
});

test('candidate-blocked acceptance closes truthfully instead of becoming COMPLETE', () => {
  let state = reachVerifyAffected();
  state = reduceExecutionState(state, {
    type: 'affected-verification.completed',
    governanceReceipt: governanceReceipt(SHA('d')),
    verificationReceipts: [verificationReceipt(SHA('d'))],
    observedAt: TIME(9),
  });
  state = reduceExecutionState(state, {
    type: 'acceptance.completed',
    receipt: acceptanceReceipt(SHA('d'), 'candidate-blocked'),
    observedAt: TIME(10),
  });
  state = reduceExecutionState(state, {
    type: 'closeout.completed', receipt: evidenceTruthReceipt(state), observedAt: TIME(11),
  });
  assert.equal(state.terminalOutcome, 'BOUNDED_BLOCKED');
  assert.equal(state.stopReceipt.truth.verified, true);
  assert.equal(state.stopReceipt.truth.accepted, false);
});

test('receipt chain detects phase or stop receipt tampering', () => {
  let state = fixture();
  state = stopExecution(state, {
    outcome: 'BOUNDED_BLOCKED',
    observedAt: TIME(1),
    failure: {
      failureClass: 'CAPABILITY_HARD', code: 'VERIFY_CACHE_MISS',
      resolutionAuthority: 'platform-operator', attemptKey: 'cache:miss',
    },
  });
  assert.equal(verifyExecutionReceiptChain(state), true);
  const tamperedPhase = structuredClone(state);
  tamperedPhase.phaseReceipts[0].reasonCode = 'FORGED';
  assert.equal(verifyExecutionReceiptChain(tamperedPhase), false);
  const tamperedStop = structuredClone(state);
  tamperedStop.stopReceipt.truth.accepted = true;
  assert.equal(verifyExecutionReceiptChain(tamperedStop), false);
});

test('failure taxonomy exposes deterministic retry and terminal policies', () => {
  assert.deepEqual(failurePolicy('CAPABILITY_TRANSIENT'), {
    failureClass: 'CAPABILITY_TRANSIENT', maxRetries: 1, terminalOutcome: 'BOUNDED_BLOCKED',
  });
  assert.deepEqual(failurePolicy('DEPENDENCY_UNAVAILABLE'), {
    failureClass: 'DEPENDENCY_UNAVAILABLE', maxRetries: 0, terminalOutcome: 'BOUNDED_BLOCKED',
  });
  assert.deepEqual(failurePolicy('SAFETY_HOLD'), {
    failureClass: 'SAFETY_HOLD', maxRetries: 0, terminalOutcome: 'SAFETY_HOLD',
  });
});
