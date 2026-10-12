import assert from 'node:assert/strict';
import test from 'node:test';
import fixture from './fixtures/forge-change-contract/valid.json' with { type: 'json' };
import {
  ForgeChangeContractError,
  createForgeChangeContractBinding,
  evaluateForgeChangeContractDrift,
  sealForgeChangeContract,
  sealForgeDualReviewPackage,
  validateForgeDualReviewEvidence,
  validateForgeDualReviewPackage,
  verifyForgeChangeContractBinding,
} from '../docker/harness/forge-change-contract.mjs';

const sha = (character) => `sha256:${character.repeat(64)}`;

function input() {
  return structuredClone(fixture);
}

function dualReviewFixture() {
  const change = sealForgeChangeContract(input());
  const sourcePath = 'forge-server/review-contract.json';
  const reviewed = sealForgeDualReviewPackage({ schemaVersion: 1, packageType: 'forge-review/spec-quality',
    acceptanceContractId: 'a'.repeat(64), projectSlug: change.projectSlug, taskId: 'task-review',
    source: change.source, baseCommit: 'c'.repeat(40), diffSha256: sha('d'),
    changeContractSource: { sourcePath, sha256: 'e'.repeat(64) }, changeContractSha256: change.integrity.canonicalSha256,
    layerDigests: change.layerDigests, testReceipts: [{ receiptId: 'test-1', profile: 'backend-test-class',
      canonicalSha256: sha('f'), logSha256: sha('1') }],
    files: [{ path: sourcePath, sha256: 'e'.repeat(64), lineCount: 20 },
      { path: 'forge-server/Order.java', sha256: '2'.repeat(64), lineCount: 10 }], previousReview: null });
  const proof = { package: reviewed, provider: 'openai-codex', model: 'gpt-5.6-luna', providerRequestId: 'resp-review-1',
    specVerdict: { status: 'pass', summary: 'Requirements match the candidate.', evidence: [{ path: sourcePath, line: 1, detail: 'Requirement checked.' }] },
    qualityVerdict: { status: 'pass', summary: 'Current implementation is consistent.', evidence: [{ path: 'forge-server/Order.java', line: 3, detail: 'Implementation checked.' }] },
    findings: [], findingResolutions: [] };
  return { proof, contract: { contractId: reviewed.acceptanceContractId, projectSlug: reviewed.projectSlug, taskId: reviewed.taskId,
    candidate: { source: reviewed.source }, dualReview: reviewed.changeContractSource } };
}

test('dual review package binds every input and rejects stale source, missing verdict or invented citation', () => {
  const { proof, contract } = dualReviewFixture();
  assert.deepEqual(validateForgeDualReviewEvidence(proof, { decision: 'approved', contract, testReceipts: proof.package.testReceipts }), proof);
  for (const mutate of [value => { value.diffSha256 = sha('3'); }, value => { value.layerDigests.whatSha256 = sha('3'); },
    value => { value.testReceipts[0].logSha256 = sha('3'); }, value => { value.source.head = 'd'.repeat(40); }]) {
    const changed = structuredClone(proof.package); mutate(changed);
    expectCode('REVIEW_PACKAGE_STALE', () => validateForgeDualReviewPackage(changed));
  }
  for (const field of ['specVerdict', 'qualityVerdict']) {
    const missing = structuredClone(proof); delete missing[field];
    expectCode('SCHEMA_INVALID', () => validateForgeDualReviewEvidence(missing, { decision: 'approved', contract }));
  }
  const invented = structuredClone(proof); invented.qualityVerdict.evidence[0].line = 11;
  expectCode('REVIEW_VERDICT_INVALID', () => validateForgeDualReviewEvidence(invented, { decision: 'approved', contract }));
  const failed = structuredClone(proof); failed.specVerdict.status = 'fail';
  expectCode('REVIEW_VERDICT_CONFLICT', () => validateForgeDualReviewEvidence(failed, { decision: 'approved', contract }));
  const malformed = structuredClone(proof); malformed.findings = [{ severity: 'advisory' }];
  expectCode('SCHEMA_INVALID', () => validateForgeDualReviewEvidence(malformed, { decision: 'approved', contract }));
  const stale = structuredClone(contract); stale.candidate.source.fingerprint = sha('5');
  expectCode('REVIEW_PACKAGE_STALE', () => validateForgeDualReviewEvidence(proof, { decision: 'approved', contract: stale }));
  expectCode('REVIEW_TEST_RECEIPTS_STALE', () => validateForgeDualReviewEvidence(proof, { decision: 'approved', contract, testReceipts: [] }));
});

test('dual review repair requires every blocking finding closed on a new bound commit', () => {
  const { proof } = dualReviewFixture();
  const { integrity, ...packageInput } = proof.package;
  const candidate = structuredClone(proof);
  packageInput.previousReview = { reviewId: 'review-original', packageSha256: integrity.canonicalSha256,
    head: packageInput.source.head, blockingFindings: [sha('9')] };
  candidate.package = sealForgeDualReviewPackage(packageInput);
  expectCode('REVIEW_FINDING_OPEN', () => validateForgeDualReviewEvidence(candidate, { decision: 'approved' }));
  candidate.findingResolutions = [{ findingSha256: sha('9'), status: 'open', evidence: candidate.qualityVerdict.evidence }];
  expectCode('REVIEW_VERDICT_CONFLICT', () => validateForgeDualReviewEvidence(candidate, { decision: 'approved' }));
  candidate.findingResolutions[0].status = 'resolved';
  expectCode('REVIEW_REPAIR_COMMIT_REQUIRED', () => validateForgeDualReviewEvidence(candidate, { decision: 'approved' }));
  packageInput.source = { ...packageInput.source, head: 'd'.repeat(40), fingerprint: sha('4') };
  candidate.package = sealForgeDualReviewPackage(packageInput);
  assert.equal(validateForgeDualReviewEvidence(candidate, { decision: 'approved' }).qualityVerdict.status, 'pass');
});

function expectCode(code, callback) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof ForgeChangeContractError);
    assert.equal(error.code, code);
    return true;
  });
}

test('WHAT, HOW, and Task layers are canonical and chained in dependency order', () => {
  const first = sealForgeChangeContract(input());
  const reordered = input();
  reordered.what.requirements.reverse();
  reordered.what.assumptions.reverse();
  reordered.how.decisions.reverse();
  reordered.tasks.reverse();
  reordered.tasks[0].ownedPaths.reverse();
  const second = sealForgeChangeContract(reordered);
  assert.deepEqual(second, first);
  assert.match(first.layerDigests.whatSha256, /^sha256:[0-9a-f]{64}$/u);
  assert.match(first.integrity.canonicalSha256, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(first));
});

test('WHAT drift invalidates HOW, Task, and every downstream binding', () => {
  const before = sealForgeChangeContract(input());
  const changed = input();
  changed.revision = 2;
  changed.what.requirements[0].statement = 'Unauthorized and expired sessions are rejected.';
  const after = sealForgeChangeContract(changed);
  assert.deepEqual(evaluateForgeChangeContractDrift(before, after), {
    status: 'blocked', reasonCode: 'CONTRACT_DRIFT', whatChanged: true, howChanged: true,
    tasksChanged: true, sourceChanged: false, invalidatedLayers: ['what', 'how', 'tasks', 'downstream'],
  });
  const binding = createForgeChangeContractBinding(before, { bindingId: 'verify-001', purpose: 'verification' });
  assert.equal(verifyForgeChangeContractBinding(after, binding).valid, false);
});

test('HOW and Task drift have narrower invalidation while source drift invalidates receipts', () => {
  const before = sealForgeChangeContract(input());
  const howInput = input(); howInput.revision = 2; howInput.how.decisions[0].rationale = 'Keep one authorization owner and audit path.';
  const how = evaluateForgeChangeContractDrift(before, sealForgeChangeContract(howInput));
  assert.equal(how.whatChanged, false); assert.equal(how.howChanged, true);
  assert.deepEqual(how.invalidatedLayers, ['how', 'tasks', 'downstream']);

  const taskInput = input(); taskInput.revision = 2; taskInput.tasks[0].summary = 'Implement, verify, and document the mutation.';
  const task = evaluateForgeChangeContractDrift(before, sealForgeChangeContract(taskInput));
  assert.equal(task.whatChanged, false); assert.equal(task.howChanged, false); assert.equal(task.tasksChanged, true);
  assert.deepEqual(task.invalidatedLayers, ['tasks', 'downstream']);

  const sourceInput = input(); sourceInput.revision = 2; sourceInput.source.fingerprint = sha('c');
  const source = evaluateForgeChangeContractDrift(before, sealForgeChangeContract(sourceInput));
  assert.equal(source.sourceChanged, true); assert.deepEqual(source.invalidatedLayers, ['downstream']);
});

test('current exact bindings verify and tampered contracts fail closed', () => {
  const contract = sealForgeChangeContract(input());
  const binding = createForgeChangeContractBinding(contract, { bindingId: 'review-001', purpose: 'review' });
  assert.deepEqual(verifyForgeChangeContractBinding(contract, binding), {
    valid: true, reasonCode: 'BINDING_CURRENT', currentContractSha256: contract.integrity.canonicalSha256,
  });
  const tampered = structuredClone(contract); tampered.what.objective = 'A different objective.';
  expectCode('CONTRACT_INTEGRITY_INVALID', () => verifyForgeChangeContractBinding(tampered, binding));
});

test('unknown references and dependency cycles fail closed', () => {
  const unknown = input(); unknown.tasks[0].requirementIds = ['REQ-404'];
  expectCode('TASK_REFERENCE_INVALID', () => sealForgeChangeContract(unknown));
  const cycle = input(); cycle.tasks[1].dependsOn = ['TASK-2'];
  expectCode('TASK_CYCLE', () => sealForgeChangeContract(cycle));
});
