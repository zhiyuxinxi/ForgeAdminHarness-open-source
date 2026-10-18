import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { sealForgeDualReviewPackage } from '../docker/harness/forge-change-contract.mjs';
import {
  ACCEPTANCE_DOCUMENT_TYPES,
  AcceptanceSchemaError,
  aggregateAcceptance,
  validateAcceptanceContract,
  canonicalJson,
  canonicalSha256,
  sealAcceptanceDocument,
  signAcceptanceDocument,
  verifyAcceptanceIntegrity,
  verifyAcceptanceSignature,
  verifyAcceptanceVerdict,
} from '../docker/harness/forge-acceptance-aggregator.mjs';

const SHA = (character) => `sha256:${character.repeat(64)}`;
const HEAD = 'a'.repeat(40);
const NOW = '2026-09-01T01:00:00.000Z';

function keyPair(keyId, subjectId = undefined) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    ...(subjectId === undefined ? {} : { subjectId }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey,
  };
}

function publicDescriptor(pair) {
  return {
    keyId: pair.keyId,
    ...(pair.subjectId === undefined ? {} : { subjectId: pair.subjectId }),
    publicKeyPem: pair.publicKeyPem,
  };
}

function signer(pair, overrideKeyId = pair.keyId) {
  return { keyId: overrideKeyId, privateKey: pair.privateKey };
}

function fixture() {
  const keys = {
    platform: keyPair('platform-contract-key'),
    governance: keyPair('governance-key', 'governance-engine-1'),
    verification: keyPair('verification-key', 'verification-runner-1'),
    semantic: keyPair('semantic-key', 'reviewer-1'),
    authorSemantic: keyPair('author-semantic-key', 'author-1'),
    verdict: keyPair('verdict-key'),
    attacker: keyPair('attacker-key', 'attacker-1'),
    wrong: keyPair('wrong-key', 'wrong-1'),
  };
  const trustPolicy = {
    schemaVersion: 1,
    policyType: ACCEPTANCE_DOCUMENT_TYPES.trustPolicy,
    policyId: 'acceptance-trust-v1',
    platformContractSigner: publicDescriptor(keys.platform),
    issuers: {
      governance: [publicDescriptor(keys.governance)],
      verification: [publicDescriptor(keys.verification)],
      semanticReview: [publicDescriptor(keys.semantic), publicDescriptor(keys.authorSemantic)],
    },
    verdictSigner: publicDescriptor(keys.verdict),
    issuedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-01T02:00:00.000Z',
  };
  const contract = signAcceptanceDocument({
    schemaVersion: 1,
    contractType: ACCEPTANCE_DOCUMENT_TYPES.contract,
    contractId: 'contract-001',
    projectSlug: 'forge-base',
    taskId: 'task-001',
    candidate: {
      authorId: 'author-1',
      source: { head: HEAD, fingerprint: SHA('b') },
      diffSha256: SHA('c'),
    },
    requiredGovernanceProfile: 'forge-governance-v1',
    requiredProfiles: ['backend-test', 'browser-smoke', 'security-negative'],
    requiredObligations: [
      { id: 'governed-diff', dimension: 'implemented', evidenceType: 'governance', profile: null },
      { id: 'tests-pass', dimension: 'execution', evidenceType: 'verification', profile: 'backend-test' },
      { id: 'browser-path', dimension: 'browser', evidenceType: 'verification', profile: 'browser-smoke' },
      { id: 'tenant-negative', dimension: 'security', evidenceType: 'verification', profile: 'security-negative' },
      { id: 'independent-semantics', dimension: 'semantic', evidenceType: 'semantic-review', profile: null },
    ],
    requiredDimensions: ['implemented', 'execution', 'semantic', 'browser', 'security'],
    issuedAt: '2026-09-01T00:05:00.000Z',
    expiresAt: '2026-09-01T02:00:00.000Z',
  }, signer(keys.platform));
  const common = (receiptId, receiptType, issuer, status = 'passed') => ({
    schemaVersion: 1,
    receiptType,
    receiptId,
    contractId: contract.contractId,
    contractFingerprint: contract.integrity.canonicalSha256,
    projectSlug: contract.projectSlug,
    taskId: contract.taskId,
    issuer,
    source: contract.candidate.source,
    candidateDiffSha256: contract.candidate.diffSha256,
    issuedAt: '2026-09-01T00:30:00.000Z',
    expiresAt: '2026-09-01T01:30:00.000Z',
    status,
  });
  const governanceReceipt = signAcceptanceDocument({
    ...common('governance-1', ACCEPTANCE_DOCUMENT_TYPES.receipts.governance,
      { keyId: keys.governance.keyId, subjectId: keys.governance.subjectId, role: 'governance-engine' }),
    profile: 'forge-governance-v1',
    obligations: ['governed-diff'],
  }, signer(keys.governance));
  const verification = (receiptId, profile, dimension, obligations, status = 'passed', signingKey = keys.verification) => signAcceptanceDocument({
    ...common(receiptId, ACCEPTANCE_DOCUMENT_TYPES.receipts.verification,
      { keyId: signingKey.keyId, subjectId: keys.verification.subjectId, role: 'verification-runner' }, status),
    profile,
    dimension,
    obligations,
    execution: { exitCode: status === 'passed' ? 0 : 1, timedOut: false, logSha256: SHA('d') },
  }, signer(signingKey));
  const semanticReview = (reviewer = keys.semantic, status = 'passed', signingKey = reviewer) => signAcceptanceDocument({
    ...common('semantic-1', ACCEPTANCE_DOCUMENT_TYPES.receipts.semanticReview,
      { keyId: signingKey.keyId, subjectId: reviewer.subjectId, role: 'independent-reviewer' }, status),
    obligations: ['independent-semantics'],
    review: { reviewerId: reviewer.subjectId, decision: status === 'passed' ? 'approved' : 'rejected', summarySha256: SHA('e') },
  }, signer(signingKey));
  const input = {
    contract,
    current: { source: contract.candidate.source, candidateDiffSha256: contract.candidate.diffSha256, observedAt: NOW },
    governanceReceipt,
    verificationReceipts: [
      verification('verify-backend', 'backend-test', 'execution', ['tests-pass']),
      verification('verify-browser', 'browser-smoke', 'browser', ['browser-path']),
      verification('verify-security', 'security-negative', 'security', ['tenant-negative']),
    ],
    semanticReviewReceipts: [semanticReview()],
  };
  const protectedContext = { trustPolicy, verdictSigner: signer(keys.verdict) };
  Object.defineProperty(input, 'helpers', {
    value: { verification, semanticReview, keys, protectedContext }, enumerable: false,
  });
  return input;
}

test('canonical hashing is deterministic but is not treated as authentication', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(canonicalSha256({ b: 2, a: 1 }), canonicalSha256({ a: 1, b: 2 }));
  const unsigned = sealAcceptanceDocument({ schemaVersion: 1, value: 'original' });
  assert.equal(verifyAcceptanceIntegrity(unsigned), true);
  assert.equal(verifyAcceptanceSignature(unsigned, { keyId: 'none', publicKeyPem: 'not-a-key' }), false);
  assert.throws(() => canonicalJson({ invalid: undefined }), AcceptanceSchemaError);
});

test('valid Ed25519 contract, role receipts and protected verdict signer produce an accepted chain', () => {
  const input = fixture();
  const verdict = aggregateAcceptance(input, input.helpers.protectedContext);
  assert.equal(verdict.verdict, 'accepted');
  assert.equal(verdict.attestation, 'signed-verdict');
  assert.equal(verdict.dimensions.implemented.status, 'proven');
  assert.equal(verdict.dimensions.execution.status, 'proven');
  assert.equal(verdict.dimensions.semantic.status, 'proven');
  assert.equal(verdict.dimensions.database.status, 'not-required');
  assert.equal(verdict.dimensions.browser.status, 'proven');
  assert.equal(verdict.dimensions.security.status, 'proven');
  assert.equal(verdict.dimensions.release.status, 'not-required');
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verifyAcceptanceVerdict(verdict, input.helpers.protectedContext.trustPolicy), true);
});

test('dual review acceptance rejects a signed single verdict and requires both source-bound verdicts', () => {
  const input = fixture();
  const { keys, protectedContext } = input.helpers;
  const binding = { sourcePath: 'forge-server/review-contract.json', sha256: 'a'.repeat(64) };
  input.contract = signAcceptanceDocument({ ...input.contract, contractId: 'b'.repeat(64), dualReview: binding,
    requiredObligations: [...input.contract.requiredObligations,
      { id: 'spec-and-quality-review', dimension: 'semantic', evidenceType: 'semantic-review', profile: null }] }, signer(keys.platform));
  const rebind = (receipt, key) => signAcceptanceDocument({ ...receipt, contractId: input.contract.contractId,
    contractFingerprint: input.contract.integrity.canonicalSha256 }, signer(key));
  input.governanceReceipt = rebind(input.governanceReceipt, keys.governance);
  input.verificationReceipts = input.verificationReceipts.map(receipt => rebind(receipt, keys.verification));
  let review = rebind({ ...input.semanticReviewReceipts[0], obligations: ['independent-semantics', 'spec-and-quality-review'] }, keys.semantic);
  input.semanticReviewReceipts = [review];
  const legacy = aggregateAcceptance(input, protectedContext);
  assert.notEqual(legacy.verdict, 'accepted');
  assert.ok(legacy.blockers.some(item => item.code === 'SEMANTIC_REVIEW_DUAL_VERDICTS_REQUIRED'));
  const testReceipt = input.verificationReceipts[0];
  const reviewed = sealForgeDualReviewPackage({ schemaVersion: 1, packageType: 'forge-review/spec-quality',
    acceptanceContractId: input.contract.contractId, projectSlug: input.contract.projectSlug, taskId: input.contract.taskId,
    source: input.contract.candidate.source, baseCommit: 'c'.repeat(40), diffSha256: SHA('d'),
    changeContractSource: binding, changeContractSha256: SHA('e'),
    layerDigests: { whatSha256: SHA('1'), howSha256: SHA('2'), tasksSha256: SHA('3') },
    testReceipts: [{ receiptId: testReceipt.receiptId, profile: testReceipt.profile,
      canonicalSha256: testReceipt.integrity.canonicalSha256, logSha256: testReceipt.execution.logSha256 }],
    files: [{ path: binding.sourcePath, sha256: binding.sha256, lineCount: 8 }], previousReview: null });
  const verdict = { status: 'pass', summary: 'Current source checked.', evidence: [{ path: binding.sourcePath, line: 1, detail: 'Actual input evidence.' }] };
  const dualReview = { package: reviewed, provider: 'openai-codex', model: 'gpt-5.6-luna', providerRequestId: 'resp-review',
    specVerdict: verdict, qualityVerdict: verdict, findings: [], findingResolutions: [] };
  review = signAcceptanceDocument({ ...review, review: { ...review.review, dualReview } }, signer(keys.semantic));
  input.semanticReviewReceipts = [review];
  assert.equal(aggregateAcceptance(input, protectedContext).verdict, 'accepted');
  const incomplete = structuredClone(review); delete incomplete.review.dualReview.qualityVerdict;
  input.semanticReviewReceipts = [signAcceptanceDocument(incomplete, signer(keys.semantic))];
  assert.notEqual(aggregateAcceptance(input, protectedContext).verdict, 'accepted', 'even a trusted signature cannot replace the missing quality verdict');
});

test('an otherwise valid result without a protected verdict signer remains an unsigned blocked intermediate', () => {
  const input = fixture();
  const verdict = aggregateAcceptance(input, { ...input.helpers.protectedContext, verdictSigner: null });
  assert.equal(verdict.verdict, 'candidate-blocked');
  assert.equal(verdict.attestation, 'unsigned-intermediate');
  assert.equal('signature' in verdict, false);
  assert.ok(verdict.blockers.some((item) => item.code === 'VERDICT_SIGNATURE_REQUIRED'));
  assert.equal(verifyAcceptanceVerdict(verdict, input.helpers.protectedContext.trustPolicy), false);
});

test('recomputing the canonical hash cannot forge a receipt without the protected issuer private key', () => {
  const input = fixture();
  const original = input.verificationReceipts[0];
  const resealed = sealAcceptanceDocument({ ...original, profile: 'browser-smoke', obligations: ['browser-path'] });
  input.verificationReceipts[0] = { ...resealed, signature: original.signature };
  const verdict = aggregateAcceptance(input, input.helpers.protectedContext);
  assert.equal(verdict.verdict, 'candidate-blocked');
  assert.ok(verdict.blockers.some((item) => item.code === 'RECEIPT_SIGNATURE_INVALID'));
});

test('trusted issuer replacement inside a signed contract is rejected even after hash recomputation', () => {
  const input = fixture();
  const resealed = sealAcceptanceDocument({ ...input.contract, trustedIssuers: { verification: ['attacker-key'] } });
  input.contract = { ...resealed, signature: input.contract.signature };
  assert.throws(() => aggregateAcceptance(input, input.helpers.protectedContext),
    (error) => error.code === 'SCHEMA_INVALID' || error.code === 'CONTRACT_SIGNATURE_INVALID');
});

test('an attacker cannot replace the platform contract signer or inject trust policy through evidence input', () => {
  const input = fixture();
  input.contract = signAcceptanceDocument(input.contract, signer(
    input.helpers.keys.attacker, input.helpers.keys.platform.keyId,
  ));
  assert.throws(() => aggregateAcceptance(input, input.helpers.protectedContext),
    (error) => error.code === 'CONTRACT_SIGNATURE_INVALID');

  const second = fixture();
  assert.throws(() => aggregateAcceptance({
    ...second,
    trustPolicy: second.helpers.protectedContext.trustPolicy,
  }, second.helpers.protectedContext), (error) => error.code === 'SCHEMA_INVALID');
});

test('a self-signed attacker key cannot create verification evidence', () => {
  const input = fixture();
  input.verificationReceipts[0] = input.helpers.verification(
    'verify-backend', 'backend-test', 'execution', ['tests-pass'], 'passed', input.helpers.keys.attacker,
  );
  const verdict = aggregateAcceptance(input, input.helpers.protectedContext);
  assert.equal(verdict.verdict, 'candidate-blocked');
  assert.ok(verdict.blockers.some((item) => item.code === 'RECEIPT_SIGNER_UNTRUSTED'));
});

test('a trusted key from another role cannot sign semantic review evidence', () => {
  const input = fixture();
  input.semanticReviewReceipts = [input.helpers.semanticReview(
    input.helpers.keys.semantic, 'passed', input.helpers.keys.governance,
  )];
  const verdict = aggregateAcceptance(input, input.helpers.protectedContext);
  assert.equal(verdict.verdict, 'candidate-blocked');
  assert.ok(verdict.blockers.some((item) => item.code === 'RECEIPT_SIGNER_UNTRUSTED'));
});

test('a wrong public key in the protected policy rejects a correctly shaped signed receipt', () => {
  const input = fixture();
  const policy = structuredClone(input.helpers.protectedContext.trustPolicy);
  policy.issuers.verification[0].publicKeyPem = input.helpers.keys.wrong.publicKeyPem;
  const verdict = aggregateAcceptance(input, { trustPolicy: policy, verdictSigner: input.helpers.protectedContext.verdictSigner });
  assert.equal(verdict.verdict, 'candidate-blocked');
  assert.ok(verdict.blockers.some((item) => item.code === 'RECEIPT_SIGNATURE_INVALID'));
});

test('changing a field after signing invalidates both integrity and signature', () => {
  const input = fixture();
  input.governanceReceipt = { ...input.governanceReceipt, profile: 'forged-profile' };
  assert.equal(verifyAcceptanceIntegrity(input.governanceReceipt), false);
  const verdict = aggregateAcceptance(input, input.helpers.protectedContext);
  assert.equal(verdict.verdict, 'candidate-blocked');
  assert.ok(verdict.blockers.some((item) => item.code === 'RECEIPT_INTEGRITY_INVALID'));
});

test('source, candidate diff, receipt freshness, profile and obligation gates remain fail-closed', () => {
  const input = fixture();
  input.verificationReceipts[0] = signAcceptanceDocument({
    ...input.verificationReceipts[0], expiresAt: '2026-09-01T00:45:00.000Z',
  }, signer(input.helpers.keys.verification));
  input.verificationReceipts[1] = signAcceptanceDocument({
    ...input.verificationReceipts[1], obligations: [],
  }, signer(input.helpers.keys.verification));
  input.current = {
    ...input.current,
    source: { ...input.current.source, fingerprint: SHA('f') },
    candidateDiffSha256: SHA('0'),
  };
  const verdict = aggregateAcceptance(input, input.helpers.protectedContext);
  assert.equal(verdict.verdict, 'candidate-blocked');
  assert.ok(verdict.blockers.some((item) => item.code === 'RECEIPT_STALE'));
  assert.ok(verdict.blockers.some((item) => item.code === 'REQUIRED_PROFILE_MISSING'));
  assert.ok(verdict.blockers.some((item) => item.code === 'REQUIRED_OBLIGATION_MISSING'));
  assert.ok(verdict.blockers.some((item) => item.code === 'SOURCE_FINGERPRINT_STALE'));
  assert.ok(verdict.blockers.some((item) => item.code === 'CANDIDATE_DIFF_STALE'));
});

test('cross-contract receipts and stdout text remain inadmissible', () => {
  const input = fixture();
  input.verificationReceipts[0] = signAcceptanceDocument({
    ...input.verificationReceipts[0], contractId: 'contract-foreign',
  }, signer(input.helpers.keys.verification));
  input.semanticReviewReceipts.push('PASS semantic review receipt sha256:pretend');
  const verdict = aggregateAcceptance(input, input.helpers.protectedContext);
  assert.equal(verdict.verdict, 'candidate-blocked');
  assert.ok(verdict.blockers.some((item) => item.code === 'RECEIPT_CONTRACT_MISMATCH'));
  assert.ok(verdict.blockers.some((item) => item.code === 'RECEIPT_NOT_STRUCTURED'));
});

test('self-authored semantic approval remains blocked even with a trusted semantic key', () => {
  const input = fixture();
  input.semanticReviewReceipts = [input.helpers.semanticReview(input.helpers.keys.authorSemantic)];
  const verdict = aggregateAcceptance(input, input.helpers.protectedContext);
  assert.equal(verdict.verdict, 'candidate-blocked');
  assert.ok(verdict.blockers.some((item) => item.code === 'SEMANTIC_REVIEW_SELF_AUTHORED'));
  assert.equal(verdict.dimensions.semantic.status, 'blocked');
});

test('wrong protected verdict private key cannot create an accepted verdict', () => {
  const input = fixture();
  const verdict = aggregateAcceptance(input, {
    trustPolicy: input.helpers.protectedContext.trustPolicy,
    verdictSigner: signer(input.helpers.keys.attacker, input.helpers.keys.verdict.keyId),
  });
  assert.equal(verdict.verdict, 'candidate-blocked');
  assert.equal(verdict.attestation, 'unsigned-intermediate');
  assert.ok(verdict.blockers.some((item) => item.code === 'VERDICT_SIGNER_INVALID'));
});

test('failed signed evidence blocks acceptance even when another receipt for that profile passed', () => {
  const input = fixture();
  input.verificationReceipts.push(input.helpers.verification(
    'verify-backend-failed', 'backend-test', 'execution', [], 'failed',
  ));
  const verdict = aggregateAcceptance(input, input.helpers.protectedContext);
  assert.equal(verdict.verdict, 'candidate-blocked');
  assert.ok(verdict.blockers.some((item) => item.code === 'RECEIPT_FAILED'));
  assert.equal(verifyAcceptanceVerdict(verdict, input.helpers.protectedContext.trustPolicy), true);
});

test('verdict verification rejects signed documents outside the strict verdict schema', () => {
  const input = fixture();
  const verdict = aggregateAcceptance(input, input.helpers.protectedContext);
  const expanded = signAcceptanceDocument({ ...verdict, modelClaim: 'accepted' }, input.helpers.protectedContext.verdictSigner);
  assert.equal(verifyAcceptanceVerdict(expanded, input.helpers.protectedContext.trustPolicy), false);
});


test('direct development signed identity contract may omit development obligations only on the configured consumer', () => {
  const input = fixture();
  const { integrity, signature, ...payload } = input.contract;
  const direct = signAcceptanceDocument({ ...payload, developmentMode: 'direct',
    requiredDimensions: [], requiredObligations: [], requiredProfiles: [] }, signer(input.helpers.keys.platform));
  const previous = process.env.FORGE_DEVELOPMENT_MODE;
  delete process.env.FORGE_DEVELOPMENT_MODE;
  try {
    assert.throws(() => validateAcceptanceContract(direct, input.helpers.protectedContext.trustPolicy),
      { code: 'CONTRACT_MODE_INVALID' });
    process.env.FORGE_DEVELOPMENT_MODE = 'direct';
    assert.equal(validateAcceptanceContract(direct, input.helpers.protectedContext.trustPolicy), direct);
    const forged = { ...direct, taskId: 'another-task' };
    assert.throws(() => validateAcceptanceContract(forged, input.helpers.protectedContext.trustPolicy),
      { code: 'CONTRACT_INTEGRITY_INVALID' });
    const governedEmpty = signAcceptanceDocument({ ...payload, requiredDimensions: [], requiredObligations: [], requiredProfiles: [] }, signer(input.helpers.keys.platform));
    assert.throws(() => validateAcceptanceContract(governedEmpty, input.helpers.protectedContext.trustPolicy));
  } finally {
    if (previous === undefined) delete process.env.FORGE_DEVELOPMENT_MODE;
    else process.env.FORGE_DEVELOPMENT_MODE = previous;
  }
});
