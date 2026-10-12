import assert from 'node:assert/strict';
import test from 'node:test';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
import {
  FORGE_OBLIGATION_ISSUERS,
  FORGE_OBLIGATION_RECEIPT_KINDS,
  ForgeObligationLedgerError,
  advanceForgeObligationLedgerSource,
  applyForgeObligationReceipt,
  compileForgeObligationLedgerContract,
  createForgeObligationLedger,
  restoreForgeObligationLedger,
  sealForgeObligationReceipt,
  serializeForgeObligationLedger,
  summarizeForgeObligationLedger,
} from '../docker/harness/forge-obligation-ledger.mjs';

const SOURCE_A = 'a'.repeat(64);

test('requested frontend verification ledger preserves explicit checks and rejects forged contracts', () => {
  const input = { prompt: '请执行 frontend-admin-typecheck 和 frontend-admin-build。',
    ownedPaths: ['forge-admin-ui/src/components/ai-form/AiCrudPage.vue'],
    taskProfiles: ['frontend-admin'], actionCeiling: 'workspace-write' };
  const options = { independentReview: 'suspended', verificationScope: 'changed' };
  const contract = compileForgeTaskExecutionContract(input, options);
  const ledger = createForgeObligationLedger(contract);
  const ids = ledger.definitions.map(item => item.id);
  for (const profile of ['frontend-admin-typecheck', 'frontend-admin-build']) {
    assert.ok(ids.includes(`verification:${profile}`));
  }
  assert.deepEqual(restoreForgeObligationLedger(serializeForgeObligationLedger(ledger), contract), ledger);
  const ordinary = createForgeObligationLedger(compileForgeTaskExecutionContract({ ...input, prompt: '修复组件格式问题。' }, options));
  assert.equal(ordinary.definitions.some(item => /frontend-admin-(?:typecheck|build)$/u.test(item.id)), false);
  for (const mutation of [
    { requestedVerificationProfiles: ['backend-module-test'] },
    { requiredVerificationProfiles: contract.requiredVerificationProfiles.filter(profile => profile !== 'frontend-admin-build') },
    { sourceFingerprint: 'f'.repeat(64) },
  ]) assert.throws(() => createForgeObligationLedger({ ...contract, ...mutation }),
    error => ['CONTRACT_FIELD_INVALID', 'CONTRACT_DERIVATION_MISMATCH', 'CONTRACT_HASH_MISMATCH'].includes(error.code));
  assert.throws(() => createForgeObligationLedger({ ...contract, arbitraryVerification: true }), { code: 'LEDGER_UNSUPPORTED_FIELD' });
});

test('semantic resource contracts retain actual ledger obligations and reject tampered claims', () => {
  const input = { prompt: '更新页面标题', ownedPaths: ['forge-admin-ui/src/views/security/index.vue'], actionCeiling: 'workspace-write' };
  const legacy = compileForgeTaskExecutionContract(input);
  const scoped = compileForgeTaskExecutionContract(input, { semanticResources: [{ type: 'table', key: 'security' }] });
  const ledger = compileForgeObligationLedgerContract(scoped);
  const baseline = compileForgeObligationLedgerContract(legacy);
  assert.deepEqual(ledger.definitions, baseline.definitions);
  assert.equal(ledger.taskContractId, scoped.contractId);
  assert.notEqual(ledger.taskContractId, baseline.taskContractId);
  assert.throws(() => compileForgeObligationLedgerContract({ ...scoped, semanticResources: [{ type: 'table', key: 'other' }] }));
});
const SOURCE_B = 'b'.repeat(64);
const CONTRACT_ID = 'c'.repeat(64);
const evidenceDigest = (character = 'd') => `sha256:${character.repeat(64)}`;

function taskContract(overrides = {}) {
  return {
    schemaVersion: 1,
    contractId: CONTRACT_ID,
    taskProfiles: ['backend', 'crud', 'shared-owner'],
    requiredSkills: [],
    tddRequired: true,
    requiredVerificationProfiles: ['governance', 'backend-module-test', 'full-regression'],
    requiredObligations: [
      'final-verification',
      'complete-crud-vertical-slice',
      'tenant-and-permission-fail-closed',
      'unique-semantic-owner',
      'dual-consumer-contract-tests',
    ],
    semanticOwners: ['backend-module-contract', 'crud-vertical-slice', 'shared-contract'],
    actionCeiling: 'workspace-write',
    ownedPaths: ['forge-server/example'],
    sourceFingerprint: SOURCE_A,
    ...overrides,
  };
}

function ref(kind, value, character = 'd') {
  return { kind, ref: value, digest: evidenceDigest(character) };
}

let receiptCounter = 0;
function receipt({
  ledger,
  obligationId,
  receiptType,
  issuer,
  evidenceRefs,
  sourceFingerprint = ledger.sourceFingerprint,
  receiptId = `receipt-${String(++receiptCounter).padStart(8, '0')}`,
}) {
  return sealForgeObligationReceipt({
    receiptType,
    receiptId,
    sourceFingerprint,
    issuer,
    obligationId,
    evidenceRefs,
  });
}

function verificationReceipt(ledger, profile, overrides = {}) {
  return receipt({
    ledger,
    obligationId: `verification:${profile}`,
    receiptType: FORGE_OBLIGATION_RECEIPT_KINDS.verification,
    issuer: FORGE_OBLIGATION_ISSUERS.verification,
    evidenceRefs: [
      ref('verification-profile', profile),
      ref('execution-log', `verify-run:${profile}`, 'e'),
    ],
    ...overrides,
  });
}

test('compiles stable verification, shared-owner, and CRUD obligation identifiers', () => {
  const compiled = compileForgeObligationLedgerContract(taskContract());
  const ids = compiled.definitions.map((item) => item.id);
  for (const id of [
    'verification:backend-module-test',
    'verification:governance',
    'verification:full-regression',
    'shared-owner:inventory',
    'shared-owner:decision',
    'shared-owner:consumer-tests',
    'crud:contract',
    'crud:permission',
    'crud:validation',
    'crud:observability',
    'contract:complete-crud-vertical-slice',
  ]) assert.ok(ids.includes(id), id);
  assert.equal(new Set(ids).size, ids.length);
  const governance = compiled.definitions.find((item) => item.id === 'verification:governance');
  assert.deepEqual(governance.allowedReceiptKinds, [FORGE_OBLIGATION_RECEIPT_KINDS.governance]);
  assert.deepEqual(governance.allowedIssuers, [FORGE_OBLIGATION_ISSUERS.governance]);
});

test('shared owner inventory cannot be closed by a prose claim or model boolean', () => {
  const ledger = createForgeObligationLedger(taskContract());
  assert.throws(() => sealForgeObligationReceipt({
    receiptType: FORGE_OBLIGATION_RECEIPT_KINDS.ownerInventory,
    receiptId: 'receipt-model-claim',
    sourceFingerprint: SOURCE_A,
    issuer: FORGE_OBLIGATION_ISSUERS.staticAnalysis,
    obligationId: 'shared-owner:inventory',
    evidenceRefs: [ref('evidence', '已检查，没有问题')],
    checked: true,
  }), (error) => error instanceof ForgeObligationLedgerError
    && error.code === 'LEDGER_UNSUPPORTED_FIELD');

  const proseOnly = receipt({
    ledger,
    obligationId: 'shared-owner:inventory',
    receiptType: FORGE_OBLIGATION_RECEIPT_KINDS.ownerInventory,
    issuer: FORGE_OBLIGATION_ISSUERS.staticAnalysis,
    evidenceRefs: [ref('evidence', '已检查 shared owner')],
  });
  assert.throws(() => applyForgeObligationReceipt(ledger, proseOnly),
    (error) => error.code === 'LEDGER_EVIDENCE_INCOMPLETE');

  const inventory = receipt({
    ledger,
    obligationId: 'shared-owner:inventory',
    receiptType: FORGE_OBLIGATION_RECEIPT_KINDS.ownerInventory,
    issuer: FORGE_OBLIGATION_ISSUERS.staticAnalysis,
    evidenceRefs: [
      ref('search', 'rg:PageQuery'),
      ref('owner', 'forge-framework/PageQuery.java'),
      ref('consumer', 'employee/EmployeeMapper.java'),
      ref('consumer', 'social/SocialSyncLogMapper.java'),
    ],
  });
  const closed = applyForgeObligationReceipt(ledger, inventory);
  assert.ok(summarizeForgeObligationLedger(closed).closed
    .some((item) => item.id === 'shared-owner:inventory'));
});

test('issuer permissions are obligation-specific and exact verification profile evidence is required', () => {
  const ledger = createForgeObligationLedger(taskContract());
  const wrongIssuer = verificationReceipt(ledger, 'backend-module-test', {
    issuer: FORGE_OBLIGATION_ISSUERS.semanticReview,
  });
  assert.throws(() => applyForgeObligationReceipt(ledger, wrongIssuer),
    (error) => error.code === 'LEDGER_RECEIPT_ISSUER_FORBIDDEN');

  const unknownIssuer = verificationReceipt(ledger, 'backend-module-test', {
    issuer: 'model-self-report',
  });
  assert.throws(() => applyForgeObligationReceipt(ledger, unknownIssuer),
    (error) => error.code === 'LEDGER_RECEIPT_ISSUER_FORBIDDEN');

  const wrongProfileEvidence = verificationReceipt(ledger, 'backend-module-test', {
    evidenceRefs: [
      ref('verification-profile', 'full-regression'),
      ref('execution-log', 'verify-run:backend-module-test'),
    ],
  });
  assert.throws(() => applyForgeObligationReceipt(ledger, wrongProfileEvidence),
    (error) => error.code === 'LEDGER_EVIDENCE_INCOMPLETE');

  const verified = applyForgeObligationReceipt(
    ledger,
    verificationReceipt(ledger, 'backend-module-test'),
  );
  assert.equal(summarizeForgeObligationLedger(verified).counts.closed, 1);

  const decisionByStaticAnalyzer = receipt({
    ledger,
    obligationId: 'shared-owner:decision',
    receiptType: FORGE_OBLIGATION_RECEIPT_KINDS.ownerDecision,
    issuer: FORGE_OBLIGATION_ISSUERS.staticAnalysis,
    evidenceRefs: [
      ref('decision-record', 'extract-to-framework'),
      ref('owner', 'forge-framework/PageQuery.java'),
      ref('consumer', 'consumer-a'),
      ref('consumer', 'consumer-b'),
    ],
  });
  assert.throws(() => applyForgeObligationReceipt(ledger, decisionByStaticAnalyzer),
    (error) => error.code === 'LEDGER_RECEIPT_ISSUER_FORBIDDEN');
});

test('source mutation makes source-bound closures stale while preserving history', () => {
  let ledger = createForgeObligationLedger(taskContract());
  ledger = applyForgeObligationReceipt(ledger, verificationReceipt(ledger, 'full-regression'));
  const oldReceiptId = summarizeForgeObligationLedger(ledger).closed[0].receiptId;
  ledger = advanceForgeObligationLedgerSource(ledger, {
    sourceFingerprint: SOURCE_B,
    mutationId: 'mutation-00000001',
  });
  const summary = summarizeForgeObligationLedger(ledger);
  assert.equal(summary.counts.closed, 0);
  assert.equal(summary.counts.stale, 1);
  assert.ok(summary.open.includes('verification:full-regression'));
  assert.deepEqual(summary.stale, [{
    id: 'verification:full-regression', historicalReceiptIds: [oldReceiptId],
  }]);
  assert.equal(ledger.history.filter((event) => event.type === 'closure').length, 1);

  const staleReceipt = receipt({
    ledger,
    sourceFingerprint: SOURCE_A,
    obligationId: 'verification:full-regression',
    receiptType: FORGE_OBLIGATION_RECEIPT_KINDS.verification,
    issuer: FORGE_OBLIGATION_ISSUERS.verification,
    evidenceRefs: [
      ref('verification-profile', 'full-regression'),
      ref('execution-log', 'verify-run:stale'),
    ],
  });
  assert.throws(() => applyForgeObligationReceipt(ledger, staleReceipt),
    (error) => error.code === 'LEDGER_RECEIPT_STALE_SOURCE');

  ledger = applyForgeObligationReceipt(ledger, verificationReceipt(ledger, 'full-regression'));
  const refreshed = summarizeForgeObligationLedger(ledger);
  assert.ok(refreshed.closed.some((item) => item.id === 'verification:full-regression'));
  assert.equal(refreshed.stale.length, 0);
});

test('duplicate receipt ids and conflicting current closures fail closed', () => {
  const initial = createForgeObligationLedger(taskContract());
  const firstReceipt = verificationReceipt(initial, 'backend-module-test', {
    receiptId: 'receipt-stable-0001',
  });
  const ledger = applyForgeObligationReceipt(initial, firstReceipt);
  assert.throws(() => applyForgeObligationReceipt(ledger, firstReceipt),
    (error) => error.code === 'LEDGER_RECEIPT_DUPLICATE');

  const conflicting = verificationReceipt(ledger, 'backend-module-test', {
    receiptId: 'receipt-stable-0002',
  });
  assert.throws(() => applyForgeObligationReceipt(ledger, conflicting),
    (error) => error.code === 'LEDGER_CLOSURE_CONFLICT');
});

test('serialization restores a verified digest and rejects tampering or another task contract', () => {
  let ledger = createForgeObligationLedger(taskContract());
  ledger = applyForgeObligationReceipt(ledger, verificationReceipt(ledger, 'backend-module-test'));
  const serialized = serializeForgeObligationLedger(ledger);
  const restored = restoreForgeObligationLedger(serialized, taskContract());
  assert.deepEqual(summarizeForgeObligationLedger(restored), summarizeForgeObligationLedger(ledger));
  assert.match(restored.ledgerDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(summarizeForgeObligationLedger(restored).summaryDigest, /^sha256:[0-9a-f]{64}$/u);

  const tampered = JSON.parse(serialized);
  tampered.sourceFingerprint = SOURCE_B;
  assert.throws(() => restoreForgeObligationLedger(JSON.stringify(tampered), taskContract()),
    (error) => error.code === 'LEDGER_DIGEST_INVALID');

  const otherContract = taskContract({ contractId: 'f'.repeat(64) });
  assert.throws(() => restoreForgeObligationLedger(serialized, otherContract),
    (error) => error.code === 'LEDGER_CONTRACT_MISMATCH');
});

test('receipt digest tampering is rejected before it can close an obligation', () => {
  const ledger = createForgeObligationLedger(taskContract());
  const original = verificationReceipt(ledger, 'backend-module-test');
  const tampered = {
    ...original,
    evidenceRefs: [
      ref('verification-profile', 'backend-module-test'),
      ref('execution-log', 'forged-log'),
    ],
  };
  assert.throws(() => applyForgeObligationReceipt(ledger, tampered),
    (error) => error.code === 'LEDGER_RECEIPT_DIGEST_INVALID');
});
