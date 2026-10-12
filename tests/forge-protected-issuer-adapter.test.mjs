import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { protectedCompletionProjectionReady } from '../docker/harness/forge-completion-claim-guard.mjs';
import {
  ACCEPTANCE_DOCUMENT_TYPES,
  aggregateAcceptance,
  canonicalSha256,
  sealAcceptanceDocument,
  signAcceptanceDocument,
} from '../docker/harness/forge-acceptance-aggregator.mjs';
import {
  FORGE_OBLIGATION_ISSUERS,
  FORGE_OBLIGATION_RECEIPT_KINDS,
  applyForgeObligationReceipt,
  createForgeObligationLedger,
  sealForgeObligationReceipt,
  summarizeForgeObligationLedger,
} from '../docker/harness/forge-obligation-ledger.mjs';
import {
  applyProtectedIssuerReceipt,
  evaluateProtectedLedgerCompletion,
} from '../docker/harness/forge-protected-issuer-adapter.mjs';

const SOURCE = 'b'.repeat(64);
const CONTRACT_ID = 'c'.repeat(64);
const HEAD = 'a'.repeat(40);
const DIFF = `sha256:${'d'.repeat(64)}`;
const NOW = '2026-09-01T01:00:00.000Z';

function pair(keyId, subjectId = undefined) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    keyId,
    ...(subjectId === undefined ? {} : { subjectId }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey,
  };
}

function publicDescriptor(value) {
  return {
    keyId: value.keyId,
    ...(value.subjectId === undefined ? {} : { subjectId: value.subjectId }),
    publicKeyPem: value.publicKeyPem,
  };
}

function signer(value) {
  return { keyId: value.keyId, privateKey: value.privateKey };
}

function fixture({ governanceInLedger = false, contractExpiresAt = '2026-09-01T02:00:00.000Z', legacyCrud = false, legacyShared = false } = {}) {
  const keys = {
    platform: pair('platform-key'),
    governance: pair('governance-key', 'governance-engine-1'),
    verification: pair('verification-key', 'verification-runner-1'),
    semantic: pair('semantic-key', 'reviewer-1'),
    verdict: pair('verdict-key'),
  };
  const trustPolicy = {
    schemaVersion: 1,
    policyType: ACCEPTANCE_DOCUMENT_TYPES.trustPolicy,
    policyId: 'protected-chain-policy',
    platformContractSigner: publicDescriptor(keys.platform),
    issuers: {
      governance: [publicDescriptor(keys.governance)],
      verification: [publicDescriptor(keys.verification)],
      semanticReview: [publicDescriptor(keys.semantic)],
    },
    verdictSigner: publicDescriptor(keys.verdict),
    issuedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2026-09-01T02:00:00.000Z',
  };
  const taskContract = {
    schemaVersion: 1,
    contractId: CONTRACT_ID,
    taskProfiles: legacyShared ? ['backend', 'shared-owner'] : legacyCrud ? ['backend', 'crud'] : ['backend'],
    ...(legacyCrud ? { suspendedReviewObligations: ['complete-crud-vertical-slice'] } : {}),
    ...(legacyShared ? { suspendedReviewObligations: ['unique-semantic-owner'] } : {}),
    requiredSkills: [],
    tddRequired: true,
    requiredVerificationProfiles: governanceInLedger ? ['governance'] : ['backend-test'],
    requiredObligations: governanceInLedger ? ['governed-diff'] : ['tests-pass', ...(legacyShared ? ['dual-consumer-contract-tests'] : [])],
    semanticOwners: [],
    actionCeiling: 'read-only',
    ownedPaths: [],
    sourceFingerprint: SOURCE,
  };
  const acceptanceContract = signAcceptanceDocument({
    schemaVersion: 1,
    contractType: ACCEPTANCE_DOCUMENT_TYPES.contract,
    contractId: CONTRACT_ID,
    projectSlug: 'forge-project',
    taskId: 'task-001',
    candidate: {
      authorId: 'author-1',
      source: { head: HEAD, fingerprint: SOURCE },
      diffSha256: DIFF,
    },
    requiredGovernanceProfile: 'governance',
    requiredProfiles: governanceInLedger ? [] : ['backend-test'],
    requiredObligations: [
      { id: 'governed-diff', dimension: 'implemented', evidenceType: 'governance', profile: null },
      ...(governanceInLedger ? [] : [
        { id: 'tests-pass', dimension: 'execution', evidenceType: 'verification', profile: 'backend-test' },
        ...(legacyShared ? [{ id: 'dual-consumer-contract-tests', dimension: 'execution', evidenceType: 'verification', profile: 'backend-test' }] : []),
      ]),
    ],
    requiredDimensions: governanceInLedger ? ['implemented'] : ['implemented', 'execution'],
    issuedAt: '2026-09-01T00:05:00.000Z',
    expiresAt: contractExpiresAt,
  }, signer(keys.platform));
  const common = (receiptId, receiptType, issuer) => ({
    schemaVersion: 1,
    receiptType,
    receiptId,
    contractId: CONTRACT_ID,
    contractFingerprint: acceptanceContract.integrity.canonicalSha256,
    projectSlug: 'forge-project',
    taskId: 'task-001',
    issuer,
    source: { head: HEAD, fingerprint: SOURCE },
    candidateDiffSha256: DIFF,
    issuedAt: '2026-09-01T00:30:00.000Z',
    expiresAt: '2026-09-01T01:30:00.000Z',
    status: 'passed',
  });
  const governanceReceipt = signAcceptanceDocument({
    ...common('governance-1', ACCEPTANCE_DOCUMENT_TYPES.receipts.governance, {
      keyId: keys.governance.keyId,
      subjectId: keys.governance.subjectId,
      role: 'governance-engine',
    }),
    profile: 'governance',
    obligations: ['governed-diff'],
  }, signer(keys.governance));
  const verificationReceipt = governanceInLedger ? null : signAcceptanceDocument({
    ...common('verification-1', ACCEPTANCE_DOCUMENT_TYPES.receipts.verification, {
      keyId: keys.verification.keyId,
      subjectId: keys.verification.subjectId,
      role: 'verification-runner',
    }),
    profile: 'backend-test',
    dimension: 'execution',
    obligations: ['tests-pass', ...(legacyShared ? ['dual-consumer-contract-tests'] : [])],
    execution: { exitCode: 0, timedOut: false, logSha256: `sha256:${'e'.repeat(64)}` },
  }, signer(keys.verification));
  const acceptanceInput = {
    contract: acceptanceContract,
    current: {
      source: { head: HEAD, fingerprint: SOURCE },
      candidateDiffSha256: DIFF,
      observedAt: NOW,
    },
    governanceReceipt,
    verificationReceipts: verificationReceipt === null ? [] : [verificationReceipt],
    semanticReviewReceipts: [],
  };
  const signedVerdict = aggregateAcceptance(acceptanceInput, {
    trustPolicy,
    verdictSigner: signer(keys.verdict),
  });
  return {
    keys,
    trustPolicy,
    taskContract,
    acceptanceContract,
    governanceReceipt,
    verificationReceipt,
    signedVerdict,
    ledger: createForgeObligationLedger(taskContract),
    current: { sourceFingerprint: SOURCE, candidateDiffSha256: DIFF, evaluatedAt: NOW },
  };
}

function adaptVerification(value) {
  return applyProtectedIssuerReceipt({
    ledger: value.ledger,
    taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract,
    trustPolicy: value.trustPolicy,
    receipt: value.verificationReceipt,
    kind: 'verification',
    evaluatedAt: NOW,
    obligationIds: ['verification:backend-test', 'contract:tests-pass',
      ...(value.taskContract.requiredObligations.includes('dual-consumer-contract-tests') ? ['contract:dual-consumer-contract-tests'] : [])],
  });
}

test('ordinary CRUD completion preserves unsupported legacy entries without rejecting signed current acceptance', () => {
  const value = fixture({ legacyCrud: true, contractExpiresAt: '2026-09-01T01:30:00.000Z' });
  const input = {
    ledger: adaptVerification(value).ledger, taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract, trustPolicy: value.trustPolicy,
    signedReceipts: [{ kind: 'governance', receipt: value.governanceReceipt },
      { kind: 'verification', receipt: value.verificationReceipt }],
    signedVerdict: value.signedVerdict, current: value.current,
  };
  const original = JSON.stringify(input);
  const result = evaluateProtectedLedgerCompletion(input);
  assert.equal(result.outcome, 'READY');
  assert.equal(result.ledgerSummary.counts.open, 3, 'Historical entries are not falsely closed.');
  assert.deepEqual(result.nonBlockingLegacyObligations, ['crud:observability', 'crud:permission', 'crud:validation']);
  assert.equal(protectedCompletionProjectionReady(result), true, 'The real Broker and completion consumer agree.');
  assert.equal(JSON.stringify(input), original, 'Read-only projection does not rewrite evidence.');
  for (const changed of [
    { ...input, ledger: value.ledger },
    { ...input, signedVerdict: null },
    { ...input, current: { ...value.current, sourceFingerprint: 'f'.repeat(64) } },
    { ...input, current: { ...value.current, evaluatedAt: value.acceptanceContract.expiresAt } },
    { ...input, signedReceipts: [{ kind: 'verification', receipt: { ...value.verificationReceipt, status: 'failed' } }] },
  ]) {
    const blocked = evaluateProtectedLedgerCompletion(changed);
    assert.equal(blocked.outcome, 'BOUNDED_BLOCKED');
    assert.equal(protectedCompletionProjectionReady(blocked), false);
  }
});

test('ordinary shared-owner completion preserves legacy entries but still requires signed consumer tests', () => {
  const value = fixture({ legacyShared: true, contractExpiresAt: '2026-09-01T01:30:00.000Z' });
  const input = {
    ledger: adaptVerification(value).ledger, taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract, trustPolicy: value.trustPolicy,
    signedReceipts: [{ kind: 'governance', receipt: value.governanceReceipt },
      { kind: 'verification', receipt: value.verificationReceipt }],
    signedVerdict: value.signedVerdict, current: value.current,
  };
  const original = JSON.stringify(input);
  const result = evaluateProtectedLedgerCompletion(input);
  assert.equal(result.outcome, 'READY');
  assert.deepEqual(result.nonBlockingLegacyObligations, ['shared-owner:consumer-tests', 'shared-owner:inventory']);
  assert.equal(result.ledgerSummary.counts.open, 2);
  assert.equal(protectedCompletionProjectionReady(result), true);
  assert.equal(JSON.stringify(input), original);
  for (const changed of [
    { ...input, ledger: value.ledger },
    { ...input, signedVerdict: null },
    { ...input, current: { ...value.current, sourceFingerprint: 'f'.repeat(64) } },
    { ...input, current: { ...value.current, evaluatedAt: value.acceptanceContract.expiresAt } },
    { ...input, signedReceipts: [{ kind: 'verification', receipt: { ...value.verificationReceipt, status: 'failed' } }] },
  ]) {
    const blocked = evaluateProtectedLedgerCompletion(changed);
    assert.equal(blocked.outcome, 'BOUNDED_BLOCKED');
    assert.equal(protectedCompletionProjectionReady(blocked), false);
  }
  const strict = { ...value.taskContract, suspendedReviewObligations: [] };
  const strictResult = evaluateProtectedLedgerCompletion({ ...input, taskContract: strict,
    ledger: createForgeObligationLedger(strict) });
  assert.deepEqual(strictResult.nonBlockingLegacyObligations, undefined);
  assert.equal(protectedCompletionProjectionReady(strictResult), false);
});

test('bound backend selectors remain consumable in a ready protected projection', () => {
  const value = fixture({ legacyShared: true });
  const module = 'forge-server/forge-business/forge-business-core';
  const testPath = `${module}/src/test/java/com/example/DisplayMigrationTest.java`;
  const migration = 'forge-server/db/migration/V1.0.20261006__display_metadata.sql';
  value.taskContract.ownedPaths = [migration, testPath];
  value.taskContract.backendTestBindings = [{ module, test: 'com.example.DisplayMigrationTest',
    testPath, testSha256: 'e'.repeat(64), coveredPaths: [migration, testPath].sort() }];
  value.ledger = createForgeObligationLedger(value.taskContract);
  const result = evaluateProtectedLedgerCompletion({
    ledger: adaptVerification(value).ledger, taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract, trustPolicy: value.trustPolicy,
    signedReceipts: [{ kind: 'governance', receipt: value.governanceReceipt },
      { kind: 'verification', receipt: value.verificationReceipt }],
    signedVerdict: value.signedVerdict, current: value.current,
  });
  assert.equal(result.outcome, 'READY');
  assert.deepEqual(result.backendTestSelectors, { modules: [module], tests: ['com.example.DisplayMigrationTest'] });
  assert.equal(protectedCompletionProjectionReady(result), true);
  const reseal = (changes) => {
    const { gateDigest, ...payload } = { ...result, ...changes };
    return { ...payload, gateDigest: canonicalSha256(payload) };
  };
  for (const selectors of [null, {}, { modules: [], tests: ['com.example.Test'] },
    { modules: [module], tests: [] }, { modules: ['forge-server/../outside'], tests: ['com.example.Test'] },
    { modules: [module], tests: ['bad/test'] }, { modules: [module, module], tests: ['com.example.Test'] },
    { modules: [module], tests: ['com.example.Test', 'com.example.Test'] },
    { modules: [module], tests: ['com.example.Test'], extra: true }]) {
    assert.equal(protectedCompletionProjectionReady(reseal({ backendTestSelectors: selectors })), false);
  }
  assert.equal(protectedCompletionProjectionReady({ ...result, backendTestSelectors: { modules: [module], tests: ['com.example.OtherTest'] } }), false);
  assert.equal(protectedCompletionProjectionReady(reseal({ signedVerdictVerified: false })), false);
  assert.equal(protectedCompletionProjectionReady(reseal({ unknownField: true })), false);
});

test('expired protected acceptance explicitly requires revalidation without making evidence ready', () => {
  const value = fixture({ contractExpiresAt: '2026-09-01T01:30:00.000Z' });
  const input = {
    ledger: adaptVerification(value).ledger, taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract, trustPolicy: value.trustPolicy,
    signedReceipts: [{ kind: 'governance', receipt: value.governanceReceipt },
      { kind: 'verification', receipt: value.verificationReceipt }],
    signedVerdict: value.signedVerdict, current: value.current,
  };
  const original = JSON.stringify(input);
  assert.equal(evaluateProtectedLedgerCompletion(input).outcome, 'READY');
  const expired = evaluateProtectedLedgerCompletion({ ...input,
    current: { ...value.current, evaluatedAt: value.acceptanceContract.expiresAt } });
  assert.equal(expired.outcome, 'BOUNDED_BLOCKED');
  assert.ok(expired.cannotClaim.includes('released'));
  assert.ok(expired.blockers.some(({ code }) => code === 'ACCEPTANCE_CONTRACT_EXPIRED'));
  assert.ok(expired.blockers.every(({ code }) => [
    'ACCEPTANCE_CONTRACT_EXPIRED', 'SIGNED_RECEIPT_INVALID', 'LEDGER_CLOSURE_PROVENANCE_INVALID',
  ].includes(code)));
  const invalidReceipt = { ...input,
    signedReceipts: [input.signedReceipts[0], { kind: 'verification',
      receipt: { ...value.verificationReceipt, status: 'failed' } }],
  };
  for (const evaluatedAt of [NOW, value.acceptanceContract.expiresAt]) {
    const rejected = evaluateProtectedLedgerCompletion({ ...invalidReceipt,
      current: { ...value.current, evaluatedAt } });
    assert.equal(rejected.outcome, 'BOUNDED_BLOCKED', 'An expired contract never makes a tampered receipt acceptable.');
    assert.ok(rejected.blockers.some(({ code }) => code === 'SIGNED_RECEIPT_INVALID'));
    assert.equal(rejected.blockers.some(({ code }) => code === 'ACCEPTANCE_CONTRACT_EXPIRED'), evaluatedAt !== NOW);
    assert.ok(rejected.cannotClaim.includes('released'));
  }
  assert.equal(JSON.stringify(input), original, 'Read-only classification must not extend or rewrite evidence.');
  assert.throws(() => evaluateProtectedLedgerCompletion({ ...input,
    acceptanceContract: { ...value.acceptanceContract, expiresAt: '2026-09-01T01:29:00.000Z' },
    current: { ...value.current, evaluatedAt: value.acceptanceContract.expiresAt },
  }), { code: 'PROTECTED_ACCEPTANCE_CONTRACT_INVALID' });
  assert.throws(() => evaluateProtectedLedgerCompletion({ ...input,
    current: { ...value.current, evaluatedAt: value.trustPolicy.expiresAt },
  }), { code: 'PROTECTED_ACCEPTANCE_CONTRACT_INVALID' });
});

test('verified upstream Ed25519 evidence closes only derivable obligations and ledger open=0 gates completion', () => {
  const value = fixture();
  const adapted = adaptVerification(value);
  assert.equal(adapted.report.authentication, 'verified-upstream-ed25519');
  assert.equal(summarizeForgeObligationLedger(adapted.ledger).counts.open, 0);

  const withoutVerdict = evaluateProtectedLedgerCompletion({
    ledger: adapted.ledger,
    taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract,
    trustPolicy: value.trustPolicy,
    signedReceipts: [
      { kind: 'governance', receipt: value.governanceReceipt },
      { kind: 'verification', receipt: value.verificationReceipt },
    ],
    signedVerdict: null,
    current: value.current,
  });
  assert.equal(withoutVerdict.outcome, 'BOUNDED_BLOCKED');
  assert.ok(withoutVerdict.blockers.some((item) => item.code === 'INDEPENDENT_VERDICT_REQUIRED'));
  assert.ok(withoutVerdict.cannotClaim.includes('complete'));

  const ready = evaluateProtectedLedgerCompletion({
    ledger: adapted.ledger,
    taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract,
    trustPolicy: value.trustPolicy,
    signedReceipts: [
      { kind: 'governance', receipt: value.governanceReceipt },
      { kind: 'verification', receipt: value.verificationReceipt },
    ],
    signedVerdict: value.signedVerdict,
    current: value.current,
  });
  assert.equal(ready.outcome, 'READY');
  assert.equal(ready.maximumTerminalOutcome, 'COMPLETE');
  assert.deepEqual(ready.blockers, []);
  assert.equal(ready.signedVerdictVerified, true);
  assert.equal(ready.attestation, 'local-integrity-only; upstream-authentication-is-ed25519');
});

test('a hash-only ledger issuer string cannot satisfy the protected completion gate', () => {
  const value = fixture();
  let ledger = value.ledger;
  for (const obligationId of ['verification:backend-test', 'contract:tests-pass']) {
    const verification = obligationId.startsWith('verification:');
    ledger = applyForgeObligationReceipt(ledger, sealForgeObligationReceipt({
      receiptType: FORGE_OBLIGATION_RECEIPT_KINDS.verification,
      receiptId: `spoofed-${obligationId.replaceAll(':', '-')}`,
      sourceFingerprint: SOURCE,
      issuer: FORGE_OBLIGATION_ISSUERS.verification,
      obligationId,
      evidenceRefs: verification ? [
        { kind: 'verification-profile', ref: 'backend-test', digest: `sha256:${'1'.repeat(64)}` },
        { kind: 'execution-log', ref: 'invented', digest: `sha256:${'2'.repeat(64)}` },
      ] : [
        { kind: 'evidence', ref: 'invented', digest: `sha256:${'3'.repeat(64)}` },
      ],
    }));
  }
  assert.equal(summarizeForgeObligationLedger(ledger).counts.open, 0, 'legacy hash ledger alone can appear closed');
  const gate = evaluateProtectedLedgerCompletion({
    ledger,
    taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract,
    trustPolicy: value.trustPolicy,
    signedReceipts: [{ kind: 'verification', receipt: value.verificationReceipt }],
    signedVerdict: value.signedVerdict,
    current: value.current,
  });
  assert.equal(gate.outcome, 'BOUNDED_BLOCKED');
  assert.equal(gate.blockers.filter((item) => item.code === 'LEDGER_CLOSURE_UNAUTHENTICATED').length, 2);
});

test('recomputed integrity cannot replace an upstream issuer signature', () => {
  const value = fixture();
  const original = value.verificationReceipt;
  const forged = {
    ...sealAcceptanceDocument({ ...original, profile: 'other-profile' }),
    signature: original.signature,
  };
  assert.throws(() => applyProtectedIssuerReceipt({
    ledger: value.ledger,
    taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract,
    trustPolicy: value.trustPolicy,
    receipt: forged,
    kind: 'verification',
    evaluatedAt: NOW,
    obligationIds: ['verification:backend-test'],
  }), (error) => error.code === 'PROTECTED_UPSTREAM_RECEIPT_INVALID');
});

test('signed governance receipt closes its mapped task-contract and governance-profile obligations', () => {
  const value = fixture({ governanceInLedger: true });
  const adapted = applyProtectedIssuerReceipt({
    ledger: value.ledger,
    taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract,
    trustPolicy: value.trustPolicy,
    receipt: value.governanceReceipt,
    kind: 'governance',
    evaluatedAt: NOW,
    obligationIds: ['verification:governance', 'contract:governed-diff'],
  });
  assert.equal(summarizeForgeObligationLedger(adapted.ledger).counts.open, 0);
  const ready = evaluateProtectedLedgerCompletion({
    ledger: adapted.ledger,
    taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract,
    trustPolicy: value.trustPolicy,
    signedReceipts: [{ kind: 'governance', receipt: value.governanceReceipt }],
    signedVerdict: value.signedVerdict,
    current: value.current,
  });
  assert.equal(ready.outcome, 'READY');
  assert.equal(ready.maximumTerminalOutcome, 'COMPLETE');
  assert.deepEqual(ready.blockers, []);
});

test('a validly signed verdict must still include every ledger provenance receipt', () => {
  const value = fixture();
  const adapted = adaptVerification(value);
  const incomplete = signAcceptanceDocument({
    ...value.signedVerdict,
    evidenceReceiptIds: ['governance-1'],
  }, signer(value.keys.verdict));
  const gate = evaluateProtectedLedgerCompletion({
    ledger: adapted.ledger,
    taskContract: value.taskContract,
    acceptanceContract: value.acceptanceContract,
    trustPolicy: value.trustPolicy,
    signedReceipts: [{ kind: 'verification', receipt: value.verificationReceipt }],
    signedVerdict: incomplete,
    current: value.current,
  });
  assert.equal(gate.outcome, 'BOUNDED_BLOCKED');
  assert.ok(gate.blockers.some((item) => item.code === 'INDEPENDENT_VERDICT_EVIDENCE_INCOMPLETE'));
});
