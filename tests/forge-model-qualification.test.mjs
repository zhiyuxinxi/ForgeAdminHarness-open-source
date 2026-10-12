import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MODEL_QUALIFICATION_POLICY,
  DEFAULT_MODEL_QUALIFICATION_POLICY_DIGEST,
  ForgeModelQualificationError,
  canonicalModelQualificationJson,
  modelQualificationDigest,
  evaluateProviderOperationalHealth,
  qualifyModel as evaluateQualification,
  restoreModelQualificationDecision,
  routeTask,
  serializeModelQualificationDecision,
} from '../docker/harness/forge-model-qualification.mjs';

const TEST_EVALUATED_AT = '2026-09-01T00:00:00.000Z';
const attest = (summary) => {
  const bindingEnvironment = summary.binding.environmentClass;
  const bindingTestOnly = summary.binding.testOnly;
  return {
    ...summary,
    protectedAttestation: {
      schemaVersion: 1,
      issuerId: 'protected-test-issuer',
      keyId: 'test-key-1',
      evidenceDigest: modelQualificationDigest(summary),
      signature: 'verified-test-signature',
      environmentClass: bindingEnvironment,
      testOnly: bindingTestOnly,
    },
  };
};
const qualifyModel = (options) => evaluateQualification({
  evaluatedAt: TEST_EVALUATED_AT,
  verifyProtectedAttestation: () => true,
  ...options,
  runSummaries: (options.runSummaries ?? []).map((summary) => (
    summary.protectedAttestation ? summary : attest(summary)
  )),
});

const digest = (character) => `sha256:${character.repeat(64)}`;
const binding = (overrides = {}) => ({
  provider: 'provider-a',
  model: 'model-a',
  providerDeploymentDigest: digest('a'),
  proxyConfigDigest: digest('b'),
  samplingConfigDigest: digest('c'),
  imageDigest: digest('1'),
  presetHash: digest('2'),
  policyVersion: DEFAULT_MODEL_QUALIFICATION_POLICY.policyVersion,
  policyDigest: DEFAULT_MODEL_QUALIFICATION_POLICY_DIGEST,
  taskProfile: 'backend',
  protocolDigest: digest('3'),
  executionPackDigest: digest('4'),
  runnerRevision: 'runner-vpn71',
  phaseRole: 'writer',
  complexityClass: 'L1',
  environmentClass: 'production',
  testOnly: false,
  ...overrides,
});

const run = (runId, modelBinding, overrides = {}) => ({
  runId,
  observedAt: `2026-08-${String(Number(runId.replace(/\D/gu, '') || 1)).padStart(2, '0')}T00:00:00.000Z`,
  validated: true,
  caseFamily: `case-${runId}`,
  sourceRevision: 'source-6eb2881',
  taskContractDigest: digest('d'),
  binding: modelBinding,
  platformValidity: 'valid',
  capabilityAdmission: 'ready',
  securityViolations: 0,
  protocolCompliant: true,
  obligationsSatisfied: true,
  verificationCloseoutSatisfied: true,
  noProgress: false,
  ...overrides,
});

const goodRuns = (count, modelBinding = binding()) => Array.from(
  { length: count }, (_, index) => run(`run-${index + 1}`, modelBinding),
);

const readyAdmission = (taskProfile = 'backend') => ({ outcome: 'ready', current: true, taskProfile });

function expectCode(code, operation) {
  assert.throws(operation, (error) => (
    error instanceof ForgeModelQualificationError && error.code === code
  ));
}

test('platform-invalid and capability-blocked samples are excluded from the model denominator', () => {
  const modelBinding = binding();
  const decision = qualifyModel({
    binding: modelBinding,
    runSummaries: [
      run('run-1', modelBinding),
      run('run-2', modelBinding, {
        platformValidity: 'invalid',
        capabilityAdmission: 'ready',
        securityViolations: 99,
        protocolCompliant: false,
      }),
      run('run-3', modelBinding, {
        capabilityAdmission: 'blocked',
        securityViolations: 99,
        noProgress: true,
      }),
    ],
  });
  assert.equal(decision.metrics.totalSamples, 3);
  assert.equal(decision.metrics.eligibleSamples, 1);
  assert.equal(decision.metrics.excludedPlatformInvalid, 1);
  assert.equal(decision.metrics.excludedCapabilityBlocked, 1);
  assert.equal(decision.metrics.securityViolations, 198);
  assert.equal(decision.metrics.protocolCompliant, 1);
  assert.equal(decision.state, 'quarantined');
  assert.equal(decision.actionTier, 'A0');
  assert.ok(decision.reasonCodes.includes('SECURITY_VIOLATION_QUARANTINE'));
});

test('writer tiers cannot be reached below the five eligible sample floor', () => {
  const four = qualifyModel({ binding: binding(), runSummaries: goodRuns(4) });
  assert.equal(four.state, 'candidate');
  assert.equal(four.actionTier, 'A1');

  const five = qualifyModel({ binding: binding(), runSummaries: goodRuns(5) });
  assert.equal(five.state, 'qualified');
  assert.equal(five.actionTier, 'A2');
});

test('one eligible security violation directly quarantines the exact binding', () => {
  const runs = goodRuns(5);
  runs[4] = { ...runs[4], securityViolations: 1 };
  const decision = qualifyModel({ binding: binding(), runSummaries: runs });
  assert.equal(decision.state, 'quarantined');
  assert.equal(decision.actionTier, 'A0');
  assert.ok(decision.reasonCodes.includes('SECURITY_VIOLATION_QUARANTINE'));
});

test('recent deterioration degrades an otherwise qualified binding', () => {
  const modelBinding = binding();
  const runs = goodRuns(10, modelBinding);
  for (const index of [8, 9]) {
    runs[index] = {
      ...runs[index],
      protocolCompliant: false,
      obligationsSatisfied: false,
      verificationCloseoutSatisfied: false,
      noProgress: true,
    };
  }
  const decision = qualifyModel({ binding: modelBinding, runSummaries: runs });
  assert.equal(decision.state, 'degraded');
  assert.equal(decision.actionTier, 'A0');
  assert.ok(decision.reasonCodes.includes('RECENT_BEHAVIOR_DEGRADED'));
  assert.equal(decision.recent.windowSize, 3);
});

test('routing refuses to run without a current ready batch admission', () => {
  const qualification = qualifyModel({ binding: binding(), runSummaries: goodRuns(5) });
  for (const batchAdmission of [undefined, { outcome: 'blocked', current: true, taskProfile: 'backend' }]) {
    const route = routeTask({ taskProfile: 'backend', requiredActionTier: 'A2', qualifications: [qualification], batchAdmission });
    assert.equal(route.decision, 'NO_ROUTE');
    assert.deepEqual(route.reasonCodes, ['CURRENT_READY_BATCH_ADMISSION_REQUIRED']);
  }
});

test('qualification never leaks across task profiles', () => {
  const backendBinding = binding();
  const backend = qualifyModel({ binding: backendBinding, runSummaries: goodRuns(5, backendBinding) });
  const route = routeTask({
    taskProfile: 'frontend',
    requiredActionTier: 'A2',
    qualifications: [backend],
    batchAdmission: readyAdmission('frontend'),
  });
  assert.equal(route.decision, 'NO_ROUTE');
  assert.deepEqual(route.reasonCodes, ['NO_MATCHING_QUALIFIED_BINDING']);
});

test('a model switch requires an immutable boundary and still remains shadow-only', () => {
  const current = binding({ model: 'current', imageDigest: digest('3') });
  const next = binding({ model: 'next', imageDigest: digest('4') });
  const qualification = qualifyModel({ binding: next, runSummaries: goodRuns(5, next) });
  const common = {
    taskProfile: 'backend',
    requiredActionTier: 'A2',
    qualifications: [qualification],
    batchAdmission: readyAdmission(),
    currentBinding: current,
  };
  const dirty = routeTask(common);
  assert.equal(dirty.decision, 'NO_ROUTE');
  assert.deepEqual(dirty.reasonCodes, ['IMMUTABLE_BOUNDARY_REQUIRED_FOR_MODEL_SWITCH']);

  const immutable = routeTask({ ...common, immutableBoundary: true });
  assert.equal(immutable.decision, 'NO_ROUTE');
  assert.equal(immutable.authorizationMode, 'shadow');
  assert.deepEqual(immutable.reasonCodes, ['PROTECTED_ISSUER_VERIFICATION_REQUIRED']);
  assert.equal(immutable.selectedBinding, null);
  assert.deepEqual(immutable.shadowSelectedBinding, next);
});

test('single samples named Pro, Flash, or Kimi receive no name-based privilege', () => {
  for (const model of ['DeepSeek Pro', 'DeepSeek Flash', 'Kimi']) {
    const modelBinding = binding({ model });
    const decision = qualifyModel({ binding: modelBinding, runSummaries: [run('run-1', modelBinding)] });
    assert.equal(decision.state, 'candidate', model);
    assert.equal(decision.actionTier, 'A0', model);
    assert.ok(decision.reasonCodes.includes('INSUFFICIENT_SAMPLES_FOR_A1'), model);
  }
});

test('canonical serialization is stable and tampered decisions cannot be restored or routed', () => {
  assert.equal(
    canonicalModelQualificationJson({ z: 1, a: { z: false, a: 'e\u0301' } }),
    canonicalModelQualificationJson({ a: { a: '\u00e9', z: false }, z: 1 }),
  );
  const qualification = qualifyModel({ binding: binding(), runSummaries: goodRuns(5) });
  const restored = restoreModelQualificationDecision(serializeModelQualificationDecision(qualification));
  assert.deepEqual(restored, qualification);
  const tampered = structuredClone(qualification);
  tampered.actionTier = 'A3';
  expectCode('MODEL_DECISION_DIGEST_INVALID', () => (
    restoreModelQualificationDecision(`${JSON.stringify(tampered)}\n`)
  ));
  expectCode('MODEL_DECISION_DIGEST_INVALID', () => routeTask({
    taskProfile: 'backend',
    requiredActionTier: 'A3',
    qualifications: [tampered],
    batchAdmission: readyAdmission(),
  }));
});

test('run summaries require explicit validated true', () => {
  const modelBinding = binding();
  const sample = run('run-1', modelBinding);
  delete sample.validated;
  expectCode('MODEL_RUN_SUMMARY_UNVALIDATED', () => qualifyModel({
    binding: modelBinding,
    runSummaries: [sample],
  }));
});

test('the canonical policy version cannot be reused with weaker policy content', () => {
  const weak = structuredClone(DEFAULT_MODEL_QUALIFICATION_POLICY);
  weak.minimumEligibleSamples.A2 = 1;
  weak.minimumEligibleSamples.A3 = 1;
  expectCode('MODEL_QUALIFICATION_POLICY_INVALID', () => qualifyModel({
    binding: binding(),
    runSummaries: goodRuns(1),
    policy: weak,
  }));

  const syntacticallyValidWeak = structuredClone(DEFAULT_MODEL_QUALIFICATION_POLICY);
  syntacticallyValidWeak.thresholds.A2.protocolComplianceRate = 0;
  expectCode('MODEL_POLICY_CONTENT_MISMATCH', () => qualifyModel({
    binding: binding(),
    runSummaries: goodRuns(5),
    policy: syntacticallyValidWeak,
  }));
  assert.match(DEFAULT_MODEL_QUALIFICATION_POLICY_DIGEST, /^sha256:[0-9a-f]{64}$/u);
});

test('the same case evidence tuple cannot be replayed under a new run id', () => {
  const modelBinding = binding();
  const first = run('run-1', modelBinding);
  const replay = {
    ...run('run-2', modelBinding),
    caseFamily: first.caseFamily,
    sourceRevision: first.sourceRevision,
    taskContractDigest: first.taskContractDigest,
  };
  expectCode('MODEL_RUN_CASE_DUPLICATE', () => qualifyModel({
    binding: modelBinding,
    runSummaries: [first, replay],
  }));
});

test('future timestamps beyond bounded clock skew are rejected', () => {
  const modelBinding = binding();
  expectCode('MODEL_RUN_SUMMARY_FUTURE', () => qualifyModel({
    binding: modelBinding,
    evaluatedAt: '2026-09-01T00:00:00.000Z',
    runSummaries: [run('run-1', modelBinding, { observedAt: '2026-09-01T00:05:00.001Z' })],
  }));
});

test('samples older than the canonical freshness window are rejected', () => {
  const modelBinding = binding();
  expectCode('MODEL_RUN_SUMMARY_STALE', () => qualifyModel({
    binding: modelBinding,
    runSummaries: [run('run-1', modelBinding, { observedAt: '2026-05-01T00:00:00.000Z' })],
  }));
});

test('binding omits no provider deployment, proxy, or sampling identity', () => {
  for (const field of [
    'providerDeploymentDigest', 'proxyConfigDigest', 'samplingConfigDigest',
    'protocolDigest', 'executionPackDigest', 'runnerRevision', 'phaseRole',
    'complexityClass', 'environmentClass', 'testOnly',
  ]) {
    const incomplete = binding();
    delete incomplete[field];
    expectCode('MODEL_BINDING_INVALID', () => qualifyModel({
      binding: incomplete,
      runSummaries: [],
    }));
  }
});

test('a custom policy requires explicit test-shadow mode and cannot authorize a route', () => {
  const custom = structuredClone(DEFAULT_MODEL_QUALIFICATION_POLICY);
  custom.policyVersion = 'forge-model-qualification-policy/test-v2';
  custom.thresholds.A2.protocolComplianceRate = 0;
  const productionCustomBinding = binding({ policyVersion: custom.policyVersion });
  productionCustomBinding.policyDigest = modelQualificationDigest(custom);
  expectCode('MODEL_CUSTOM_POLICY_SHADOW_ONLY', () => qualifyModel({
    binding: productionCustomBinding,
    runSummaries: goodRuns(5, productionCustomBinding),
    policy: custom,
  }));
  const customBinding = {
    ...productionCustomBinding,
    environmentClass: 'test-shadow',
    testOnly: true,
  };
  const qualification = qualifyModel({
    binding: customBinding,
    runSummaries: goodRuns(5, customBinding),
    policy: custom,
    evaluationMode: 'test-shadow',
  });
  assert.equal(qualification.authorizationMode, 'shadow');
  const route = routeTask({
    taskProfile: 'backend',
    requiredActionTier: 'A2',
    qualifications: [qualification],
    batchAdmission: readyAdmission(),
  });
  assert.equal(route.decision, 'NO_ROUTE');
  assert.equal(route.authorizationMode, 'shadow');
});

test('validated booleans are never accepted without a protected attestation verifier', () => {
  const modelBinding = binding();
  const sample = attest(run('run-1', modelBinding));
  expectCode('MODEL_RUN_ATTESTATION_VERIFIER_REQUIRED', () => evaluateQualification({
    binding: modelBinding,
    evaluatedAt: TEST_EVALUATED_AT,
    runSummaries: [sample],
  }));
  const tampered = structuredClone(sample);
  tampered.protocolCompliant = false;
  expectCode('MODEL_RUN_ATTESTATION_DIGEST_INVALID', () => evaluateQualification({
    binding: modelBinding,
    evaluatedAt: TEST_EVALUATED_AT,
    verifyProtectedAttestation: () => true,
    runSummaries: [tampered],
  }));
  expectCode('MODEL_RUN_ATTESTATION_UNVERIFIED', () => evaluateQualification({
    binding: modelBinding,
    evaluatedAt: TEST_EVALUATED_AT,
    verifyProtectedAttestation: () => false,
    runSummaries: [sample],
  }));
});

test('test-only environment identity cannot leak into production evaluation', () => {
  const shadowBinding = binding({ environmentClass: 'test-shadow', testOnly: true });
  expectCode('MODEL_QUALIFICATION_ENVIRONMENT_MISMATCH', () => qualifyModel({
    binding: shadowBinding,
    runSummaries: [],
  }));
  const productionBinding = binding();
  expectCode('MODEL_QUALIFICATION_ENVIRONMENT_MISMATCH', () => qualifyModel({
    binding: productionBinding,
    runSummaries: [],
    evaluationMode: 'test-shadow',
  }));
});

test('provider operational health is separate from behavioral qualification and only affects shadow selection', () => {
  const firstBinding = binding({ model: 'first' });
  const secondBinding = binding({ model: 'second', imageDigest: digest('5') });
  const first = qualifyModel({ binding: firstBinding, runSummaries: goodRuns(5, firstBinding) });
  const second = qualifyModel({ binding: secondBinding, runSummaries: goodRuns(5, secondBinding) });
  assert.equal(first.actionTier, 'A2');
  const unavailable = evaluateProviderOperationalHealth({
    binding: firstBinding,
    status: 'unavailable',
    observedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:10:00.000Z',
    reasonCodes: ['PROVIDER_TIMEOUT'],
  });
  const healthy = evaluateProviderOperationalHealth({
    binding: secondBinding,
    status: 'healthy',
    observedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:10:00.000Z',
  });
  const route = routeTask({
    taskProfile: 'backend',
    requiredActionTier: 'A2',
    qualifications: [first, second],
    batchAdmission: readyAdmission(),
    operationalHealth: [unavailable, healthy],
    routedAt: '2026-09-01T00:05:00.000Z',
  });
  assert.equal(route.decision, 'NO_ROUTE');
  assert.equal(route.authorizationMode, 'shadow');
  assert.deepEqual(route.shadowSelectedBinding, secondBinding);
  assert.equal(route.shadowSelectedOperationalHealthDigest, healthy.digest);
});

test('qualification and routing are shadow-only and never produce writer authorization', () => {
  const qualification = qualifyModel({ binding: binding(), runSummaries: goodRuns(8) });
  assert.equal(qualification.actionTier, 'A3');
  assert.equal(qualification.authorizationMode, 'shadow');
  const route = routeTask({
    taskProfile: 'backend',
    requiredActionTier: 'A3',
    qualifications: [qualification],
    batchAdmission: readyAdmission(),
  });
  assert.equal(route.decision, 'NO_ROUTE');
  assert.equal(route.authorizationMode, 'shadow');
  assert.deepEqual(route.reasonCodes, ['PROTECTED_ISSUER_VERIFICATION_REQUIRED']);
});
