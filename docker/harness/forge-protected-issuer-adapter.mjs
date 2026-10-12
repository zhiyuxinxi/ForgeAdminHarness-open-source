import {
  canonicalJson,
  canonicalSha256,
  validateAcceptanceContract,
  validateAcceptanceTrustPolicy,
  verifyAcceptanceEvidenceReceipt,
  verifyAcceptanceVerdict,
} from './forge-acceptance-aggregator.mjs';
import {
  FORGE_OBLIGATION_ISSUERS,
  FORGE_OBLIGATION_RECEIPT_KINDS,
  applyForgeObligationReceipt,
  restoreForgeObligationLedger,
  sealForgeObligationReceipt,
  serializeForgeObligationLedger,
  summarizeForgeObligationLedger,
} from './forge-obligation-ledger.mjs';
import { backendTestSelectorsForContract } from './forge-task-execution-contract.mjs';

export const PROTECTED_ISSUER_ADAPTER_SCHEMA_VERSION = 1;
export const PROTECTED_COMPLETION_GATE_TYPE = 'forge-protected-completion-gate/v1';

const SHA256 = /^(?:sha256:)?[0-9a-f]{64}$/u;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const INPUT_KEYS = new Set([
  'acceptanceContract', 'evaluatedAt', 'kind', 'ledger', 'obligationIds',
  'receipt', 'taskContract', 'trustPolicy',
]);
const GATE_KEYS = new Set([
  'acceptanceContract', 'current', 'ledger', 'signedReceipts', 'signedVerdict',
  'taskContract', 'trustPolicy',
]);
const CURRENT_KEYS = new Set(['candidateDiffSha256', 'evaluatedAt', 'sourceFingerprint']);

export class ForgeProtectedIssuerAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeProtectedIssuerAdapterError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeProtectedIssuerAdapterError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) fail('PROTECTED_ADAPTER_INPUT_INVALID', `${label} must be a plain object.`);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    fail('PROTECTED_ADAPTER_INPUT_INVALID', `${label} has missing or unsupported fields.`);
  }
}

function normalizedSha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail('PROTECTED_ADAPTER_BINDING_INVALID', `${label} must be SHA-256.`);
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('PROTECTED_ADAPTER_INPUT_INVALID', `${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function ledgerClone(ledger, taskContract, acceptanceContract) {
  return restoreForgeObligationLedger(serializeForgeObligationLedger(ledger), taskContract, acceptanceContract);
}

function definitionMap(ledger) {
  return new Map(ledger.definitions.map((definition) => [definition.id, definition]));
}

function receiptAuthority(kind) {
  if (kind === 'governance') return {
    receiptType: FORGE_OBLIGATION_RECEIPT_KINDS.governance,
    issuer: FORGE_OBLIGATION_ISSUERS.governance,
  };
  if (kind === 'verification') return {
    receiptType: FORGE_OBLIGATION_RECEIPT_KINDS.verification,
    issuer: FORGE_OBLIGATION_ISSUERS.verification,
  };
  if (kind === 'semanticReview') return {
    receiptType: FORGE_OBLIGATION_RECEIPT_KINDS.semanticReview,
    issuer: FORGE_OBLIGATION_ISSUERS.semanticReview,
  };
  fail('PROTECTED_ADAPTER_KIND_INVALID', `Unsupported protected issuer kind: ${String(kind)}.`);
}

function projectionAuthorizes(definition, projection) {
  if (definition.id.startsWith('verification:')) {
    return projection.profile === definition.id.slice('verification:'.length);
  }
  const declaredId = definition.id.startsWith('contract:')
    ? definition.id.slice('contract:'.length) : definition.id;
  return projection.obligations.includes(declaredId) || projection.obligations.includes(definition.id);
}

function evidenceRefs(definition, projection) {
  const refs = [{
    kind: 'protected-signed-receipt',
    ref: projection.receiptId,
    digest: projection.integrityDigest,
  }];
  for (const requirement of definition.evidenceRequirements) {
    if (requirement.minimum !== 1) {
      fail('PROTECTED_EVIDENCE_NOT_DERIVABLE', `${definition.id} requires plural evidence that the signed receipt schema does not expose.`);
    }
    if (requirement.kind === 'verification-profile' && projection.profile !== null) {
      refs.push({ kind: requirement.kind, ref: projection.profile, digest: projection.integrityDigest });
    } else if (requirement.kind === 'execution-log' && projection.executionLogSha256 !== null) {
      refs.push({
        kind: requirement.kind,
        ref: projection.receiptId,
        digest: normalizedSha256(projection.executionLogSha256, 'execution log digest'),
      });
    } else if (requirement.kind === 'evidence') {
      refs.push({ kind: requirement.kind, ref: projection.receiptId, digest: projection.integrityDigest });
    } else {
      fail('PROTECTED_EVIDENCE_NOT_DERIVABLE', `${definition.id} requires ${requirement.kind} evidence absent from the signed receipt schema.`);
    }
  }
  return refs.sort((left, right) => left.kind.localeCompare(right.kind) || left.ref.localeCompare(right.ref));
}

function adaptedReceiptId(projection, obligationId) {
  return `adapter-${canonicalSha256({ receiptId: projection.receiptId, obligationId }).slice(7, 39)}`;
}

function verifiedProjection({ acceptanceContract, trustPolicy, receipt, kind, evaluatedAt }) {
  let projection;
  try {
    projection = verifyAcceptanceEvidenceReceipt({
      contract: acceptanceContract,
      trustPolicy,
      receipt,
      kind,
      evaluatedAt,
    });
  } catch (error) {
    fail('PROTECTED_UPSTREAM_RECEIPT_INVALID', `Protected upstream receipt verification failed: ${error.code ?? error.message}`);
  }
  if (projection.status !== 'passed') fail('PROTECTED_UPSTREAM_RECEIPT_NOT_PASSING', 'Only a passing signed receipt can close an obligation.');
  return projection;
}

export function applyProtectedIssuerReceipt(input) {
  exactKeys(input, INPUT_KEYS, 'adapter input');
  timestamp(input.evaluatedAt, 'evaluatedAt');
  if (!Array.isArray(input.obligationIds) || input.obligationIds.length === 0
      || input.obligationIds.some((id) => typeof id !== 'string' || !SAFE_ID.test(id))
      || new Set(input.obligationIds).size !== input.obligationIds.length) {
    fail('PROTECTED_ADAPTER_INPUT_INVALID', 'obligationIds must be a non-empty unique identifier array.');
  }
  let ledger = ledgerClone(input.ledger, input.taskContract, input.acceptanceContract);
  if (input.acceptanceContract.contractId !== ledger.taskContractId) {
    fail('PROTECTED_ADAPTER_BINDING_INVALID', 'Signed acceptance contract does not identify this obligation ledger contract.');
  }
  if (normalizedSha256(input.acceptanceContract.candidate?.source?.fingerprint, 'acceptance source fingerprint')
      !== normalizedSha256(ledger.sourceFingerprint, 'ledger source fingerprint')) {
    fail('PROTECTED_ADAPTER_BINDING_INVALID', 'Signed acceptance contract source differs from the ledger head.');
  }
  const projection = verifiedProjection(input);
  const authority = receiptAuthority(input.kind);
  const definitions = definitionMap(ledger);
  const applied = [];
  for (const obligationId of [...input.obligationIds].sort()) {
    const definition = definitions.get(obligationId);
    if (!definition) fail('PROTECTED_OBLIGATION_UNKNOWN', `Unknown obligation ${obligationId}.`);
    if (!definition.allowedReceiptKinds.includes(authority.receiptType)
        || !definition.allowedIssuers.includes(authority.issuer)
        || !projectionAuthorizes(definition, projection)) {
      fail('PROTECTED_RECEIPT_NOT_AUTHORIZED', `Signed receipt ${projection.receiptId} cannot close ${obligationId}.`);
    }
    const refs = evidenceRefs(definition, projection);
    const adapted = sealForgeObligationReceipt({
      receiptType: authority.receiptType,
      receiptId: adaptedReceiptId(projection, obligationId),
      sourceFingerprint: ledger.sourceFingerprint,
      issuer: authority.issuer,
      obligationId,
      evidenceRefs: refs,
    });
    ledger = applyForgeObligationReceipt(ledger, adapted);
    applied.push({ obligationId, ledgerReceiptId: adapted.receiptId });
  }
  const report = {
    schemaVersion: PROTECTED_ISSUER_ADAPTER_SCHEMA_VERSION,
    reportType: 'forge-protected-issuer-adapter-report/v1',
    authentication: 'verified-upstream-ed25519',
    upstreamReceiptId: projection.receiptId,
    upstreamIntegrityDigest: projection.integrityDigest,
    ledgerDigest: ledger.ledgerDigest,
    applied,
  };
  return deepFreeze({ ledger, report: { ...report, reportDigest: canonicalSha256(report) } });
}

function currentClosures(ledger) {
  return ledger.history.filter((event) => event.type === 'closure'
    && event.generation === ledger.generation
    && event.sourceFingerprint === ledger.sourceFingerprint);
}

function blocker(code, detail) {
  return { code, detail };
}

export function evaluateProtectedLedgerCompletion(input) {
  exactKeys(input, GATE_KEYS, 'completion gate input');
  exactKeys(input.current, CURRENT_KEYS, 'completion gate current');
  timestamp(input.current.evaluatedAt, 'current.evaluatedAt');
  if (!PREFIXED_SHA256.test(input.current.candidateDiffSha256 ?? '')) {
    fail('PROTECTED_ADAPTER_INPUT_INVALID', 'current.candidateDiffSha256 must be a prefixed SHA-256 digest.');
  }
  if (!Array.isArray(input.signedReceipts)) fail('PROTECTED_ADAPTER_INPUT_INVALID', 'signedReceipts must be an array.');
  const ledger = ledgerClone(input.ledger, input.taskContract, input.acceptanceContract);
  let trustPolicy;
  let acceptanceContract;
  try {
    trustPolicy = validateAcceptanceTrustPolicy(input.trustPolicy, Date.parse(input.current.evaluatedAt));
    acceptanceContract = validateAcceptanceContract(input.acceptanceContract, trustPolicy);
  } catch (error) {
    fail('PROTECTED_ACCEPTANCE_CONTRACT_INVALID', `Protected acceptance contract validation failed: ${error.code ?? error.message}`);
  }
  const blockers = [];
  if (Date.parse(input.current.evaluatedAt) >= Date.parse(acceptanceContract.expiresAt)) {
    blockers.push(blocker('ACCEPTANCE_CONTRACT_EXPIRED', 'The signed acceptance contract has expired; current authority and evidence require formal revalidation.'));
  }
  if (acceptanceContract.contractId !== ledger.taskContractId) {
    blockers.push(blocker('CONTRACT_LEDGER_MISMATCH', 'Acceptance contract does not identify this obligation ledger.'));
  }
  if (normalizedSha256(ledger.sourceFingerprint, 'ledger source fingerprint')
      !== normalizedSha256(input.current.sourceFingerprint, 'current source fingerprint')
      || normalizedSha256(acceptanceContract.candidate.source.fingerprint, 'acceptance source fingerprint')
      !== normalizedSha256(input.current.sourceFingerprint, 'current source fingerprint')) {
    blockers.push(blocker('SOURCE_FINGERPRINT_MISMATCH', 'Ledger, signed contract, and current source are not identical.'));
  }
  if (acceptanceContract.candidate.diffSha256 !== input.current.candidateDiffSha256) {
    blockers.push(blocker('CANDIDATE_DIFF_MISMATCH', 'Signed contract candidate diff differs from current evidence.'));
  }

  const projections = new Map();
  for (const [index, entry] of input.signedReceipts.entries()) {
    if (!plainObject(entry) || !['governance', 'verification', 'semanticReview'].includes(entry.kind)
        || !plainObject(entry.receipt) || Object.keys(entry).length !== 2) {
      blockers.push(blocker('SIGNED_RECEIPT_INPUT_INVALID', `signedReceipts[${index}] is invalid.`));
      continue;
    }
    try {
      const projection = verifyAcceptanceEvidenceReceipt({
        contract: acceptanceContract,
        trustPolicy,
        receipt: entry.receipt,
        kind: entry.kind,
        evaluatedAt: input.current.evaluatedAt,
      });
      if (projections.has(projection.receiptId)) {
        blockers.push(blocker('SIGNED_RECEIPT_DUPLICATE', `Signed receipt ${projection.receiptId} is duplicated.`));
      } else projections.set(projection.receiptId, projection);
    } catch {
      blockers.push(blocker('SIGNED_RECEIPT_INVALID', `signedReceipts[${index}] failed protected verification.`));
    }
  }

  const definitions = definitionMap(ledger);
  for (const event of currentClosures(ledger)) {
    const protectedRefs = event.receipt.evidenceRefs.filter((ref) => ref.kind === 'protected-signed-receipt');
    if (protectedRefs.length !== 1) {
      blockers.push(blocker('LEDGER_CLOSURE_UNAUTHENTICATED', `Ledger closure ${event.obligationId} lacks one signed provenance reference.`));
      continue;
    }
    const projection = projections.get(protectedRefs[0].ref);
    const definition = definitions.get(event.obligationId);
    if (!projection || projection.status !== 'passed'
        || protectedRefs[0].digest !== projection.integrityDigest || !definition) {
      blockers.push(blocker('LEDGER_CLOSURE_PROVENANCE_INVALID', `Ledger closure ${event.obligationId} has invalid signed provenance.`));
      continue;
    }
    try {
      const authority = receiptAuthority(projection.kind);
      const expectedRefs = evidenceRefs(definition, projection);
      if (event.receipt.receiptType !== authority.receiptType
          || event.receipt.issuer !== authority.issuer
          || event.receipt.receiptId !== adaptedReceiptId(projection, event.obligationId)
          || !projectionAuthorizes(definition, projection)
          || canonicalJson(event.receipt.evidenceRefs) !== canonicalJson(expectedRefs)) {
        blockers.push(blocker('LEDGER_CLOSURE_PROJECTION_MISMATCH', `Ledger closure ${event.obligationId} is not the deterministic protected projection.`));
      }
    } catch {
      blockers.push(blocker('LEDGER_CLOSURE_PROJECTION_MISMATCH', `Ledger closure ${event.obligationId} cannot be derived from signed evidence.`));
    }
  }

  const summary = summarizeForgeObligationLedger(ledger);
  // Ordinary contracts suspend the unsupported CRUD review chain. These three
  // legacy, profile-added entries have no signed receipt producer and are not
  // obligations of that contract. Keep the original ledger visible and intact;
  // never manufacture closures or exempt anything explicitly required.
  const legacyIds = input.taskContract.taskProfiles.includes('crud')
    && input.taskContract.suspendedReviewObligations?.includes('complete-crud-vertical-slice')
    ? ['crud:permission', 'crud:validation', 'crud:observability'] : [];
  // The same ordinary-contract suspension applies to legacy shared-owner
  // inventory/test receipt types that have no protected producer. Keep the
  // contract's signed dual-consumer tests mandatory and leave raw entries open.
  if ((input.taskContract.taskProfiles.includes('shared-owner')
      || input.taskContract.semanticOwners.includes('shared-contract'))
    && input.taskContract.suspendedReviewObligations?.includes('unique-semantic-owner')
    && input.taskContract.requiredObligations.includes('dual-consumer-contract-tests')
    && acceptanceContract.requiredObligations.some(item => item.id === 'dual-consumer-contract-tests'
      && item.evidenceType === 'verification')) {
    legacyIds.push('shared-owner:inventory', 'shared-owner:consumer-tests');
  }
  const nonBlockingLegacyObligations = summary.open.filter(id => legacyIds.includes(id)
    && !input.taskContract.requiredObligations.includes(id)
    && !acceptanceContract.requiredObligations.some(item => item.id === id));
  const blockingOpen = summary.open.filter(id => !nonBlockingLegacyObligations.includes(id));
  if (blockingOpen.length !== 0) {
    const selectors = blockingOpen.includes('verification:backend-test-class')
      && acceptanceContract.requiredProfiles.includes('backend-test-class')
      ? backendTestSelectorsForContract(input.taskContract) : null;
    const selectionHint = selectors === null ? ''
      : ` backend-test-class 需要一份覆盖当前完整选择器组合的通过回执：${JSON.stringify(selectors)}。局部 passed 只证明所选测试成功，不等于该义务已闭合；不同局部回执不会自动合并。先复核已有完整组合回执，没有时只运行上述组合，不全量扫描或重复其他已通过检查。`;
    blockers.push(blocker('OBLIGATION_LEDGER_OPEN', `${blockingOpen.length} current obligation(s) remain open.${selectionHint}`));
  }
  let verdictVerified = false;
  if (input.signedVerdict === null) {
    blockers.push(blocker('INDEPENDENT_VERDICT_REQUIRED', 'Completion requires a signed verdict from the independent verdict service.'));
  } else if (!verifyAcceptanceVerdict(input.signedVerdict, trustPolicy)) {
    blockers.push(blocker('INDEPENDENT_VERDICT_INVALID', 'Independent verdict signature or schema is invalid.'));
  } else if (input.signedVerdict.verdict !== 'accepted'
      || input.signedVerdict.contractId !== acceptanceContract.contractId
      || normalizedSha256(input.signedVerdict.source.fingerprint, 'verdict source fingerprint')
        !== normalizedSha256(input.current.sourceFingerprint, 'current source fingerprint')
      || input.signedVerdict.candidateDiffSha256 !== input.current.candidateDiffSha256) {
    blockers.push(blocker('INDEPENDENT_VERDICT_NOT_CURRENT_ACCEPTANCE', 'Independent verdict is not an accepted verdict for current source.'));
  } else {
    const provenanceIds = new Set(currentClosures(ledger).flatMap((event) => event.receipt.evidenceRefs
      .filter((ref) => ref.kind === 'protected-signed-receipt').map((ref) => ref.ref)));
    if ([...provenanceIds].some((id) => !input.signedVerdict.evidenceReceiptIds.includes(id))) {
      blockers.push(blocker('INDEPENDENT_VERDICT_EVIDENCE_INCOMPLETE', 'Independent verdict omits ledger closure provenance.'));
    } else verdictVerified = true;
  }

  const normalizedBlockers = blockers.sort((left, right) => left.code.localeCompare(right.code)
    || left.detail.localeCompare(right.detail));
  const payload = {
    schemaVersion: PROTECTED_ISSUER_ADAPTER_SCHEMA_VERSION,
    gateType: PROTECTED_COMPLETION_GATE_TYPE,
    evaluationMode: 'read-only-verifier',
    ledgerDigest: ledger.ledgerDigest,
    ledgerSummaryDigest: summary.summaryDigest,
    sourceFingerprint: normalizedSha256(input.current.sourceFingerprint, 'current source fingerprint'),
    candidateDiffSha256: input.current.candidateDiffSha256,
    evaluatedAt: input.current.evaluatedAt,
    signedVerdictVerified: verdictVerified,
    outcome: normalizedBlockers.length === 0 ? 'READY' : 'BOUNDED_BLOCKED',
    maximumTerminalOutcome: normalizedBlockers.length === 0 ? 'COMPLETE' : 'BOUNDED_BLOCKED',
    cannotClaim: normalizedBlockers.length === 0 ? [] : ['implemented', 'verified', 'accepted', 'complete', 'released'],
    blockers: normalizedBlockers,
    ledgerSummary: summary,
    ...(input.taskContract?.backendTestBindings === undefined ? {} : {
      backendTestSelectors: backendTestSelectorsForContract(input.taskContract),
    }),
    ...(nonBlockingLegacyObligations.length > 0 ? { nonBlockingLegacyObligations } : {}),
    attestation: 'local-integrity-only; upstream-authentication-is-ed25519',
  };
  return deepFreeze({ ...payload, gateDigest: canonicalSha256(payload) });
}
