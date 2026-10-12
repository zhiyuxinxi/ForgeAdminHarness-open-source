import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from 'node:crypto';
import { normalizeForgeDualReviewBinding } from './forge-task-execution-contract.mjs';
import { validateForgeDualReviewEvidence, validateForgeReviewPredecessor } from './forge-change-contract.mjs';
import { validateForgeWorkflowInventoryObservation } from './forge-workflow-migration-safety.mjs';

export const ACCEPTANCE_SCHEMA_VERSION = 1;
export const PROOF_DIMENSIONS = Object.freeze([
  'implemented', 'execution', 'semantic', 'database', 'browser', 'security', 'release',
]);

const CONTRACT_TYPE = 'forge-acceptance/task-execution-contract';
const TRUST_POLICY_TYPE = 'forge-acceptance/trust-policy';
const VERDICT_TYPE = 'forge-acceptance/verdict';
export const ACCEPTANCE_DIAGNOSTIC_RECEIPT_TYPE = 'forge-acceptance/diagnostic-verification-receipt';
const RECEIPT_TYPES = Object.freeze({
  governance: 'forge-acceptance/governance-receipt',
  verification: 'forge-acceptance/verification-receipt',
  semanticReview: 'forge-acceptance/semantic-review-receipt',
});
const RECEIPT_KIND_BY_TYPE = new Map(Object.entries(RECEIPT_TYPES).map(([kind, type]) => [type, kind]));
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PROFILE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const SHA256 = /^(?:sha256:)?[0-9a-f]{64}$/u;
const INTEGRITY_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const GIT_HEAD = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u;
const VERIFICATION_DIMENSIONS = new Set(['execution', 'database', 'browser', 'security', 'release']);

export class AcceptanceSchemaError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'AcceptanceSchemaError';
    this.code = code;
  }
}

function schemaError(code, message) {
  throw new AcceptanceSchemaError(code, message);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value, location = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) schemaError('CANONICAL_VALUE_INVALID', `${location} is not a canonical JSON number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${location}[${index}]`));
  if (!plainObject(value)) schemaError('CANONICAL_VALUE_INVALID', `${location} is not a plain JSON object.`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) schemaError('CANONICAL_VALUE_INVALID', `${location}.${key} is undefined.`);
    result[key] = canonicalValue(value[key], `${location}.${key}`);
  }
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function canonicalSha256(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function unsignedContent(document) {
  if (!plainObject(document)) schemaError('DOCUMENT_INVALID', 'The document must be a plain JSON object.');
  const { integrity: _integrity, signature: _signature, ...unsigned } = document;
  return unsigned;
}

function signedPayload(document) {
  const { signature: _signature, ...payload } = document;
  return Buffer.from(canonicalJson(payload), 'utf8');
}

export function sealAcceptanceDocument(document) {
  const unsigned = canonicalValue(unsignedContent(document));
  return {
    ...unsigned,
    integrity: { algorithm: 'sha256', canonicalSha256: canonicalSha256(unsigned) },
  };
}

export function verifyAcceptanceIntegrity(document) {
  if (!plainObject(document?.integrity)
    || document.integrity.algorithm !== 'sha256'
    || !INTEGRITY_SHA256.test(document.integrity.canonicalSha256 ?? '')) return false;
  try {
    return canonicalSha256(unsignedContent(document)) === document.integrity.canonicalSha256;
  } catch {
    return false;
  }
}

function exactKeys(value, keys, location) {
  if (!plainObject(value)) schemaError('SCHEMA_INVALID', `${location} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    schemaError('SCHEMA_INVALID', `${location} has missing or unknown fields.`);
  }
}

function requiredString(value, pattern, location) {
  if (typeof value !== 'string' || !pattern.test(value)) schemaError('SCHEMA_INVALID', `${location} is invalid.`);
  return value;
}

function requiredTimestamp(value, location) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    schemaError('SCHEMA_INVALID', `${location} must be a canonical UTC timestamp.`);
  }
  return Date.parse(value);
}

function uniqueStrings(value, pattern, location, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) schemaError('SCHEMA_INVALID', `${location} must be an array.`);
  value.forEach((item, index) => requiredString(item, pattern, `${location}[${index}]`));
  if (new Set(value).size !== value.length) schemaError('SCHEMA_INVALID', `${location} contains duplicates.`);
  return value;
}

function validateIntegrity(value, location) {
  exactKeys(value, ['algorithm', 'canonicalSha256'], location);
  if (value.algorithm !== 'sha256' || !INTEGRITY_SHA256.test(value.canonicalSha256 ?? '')) {
    schemaError('INTEGRITY_INVALID', `${location} is invalid.`);
  }
}

function validateSignature(value, location) {
  exactKeys(value, ['algorithm', 'keyId', 'value'], location);
  if (value.algorithm !== 'Ed25519') schemaError('SIGNATURE_INVALID', `${location}.algorithm must be Ed25519.`);
  requiredString(value.keyId, SAFE_ID, `${location}.keyId`);
  if (typeof value.value !== 'string' || !BASE64_SIGNATURE.test(value.value)) schemaError('SIGNATURE_INVALID', `${location}.value is invalid.`);
  const decoded = Buffer.from(value.value, 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== value.value) schemaError('SIGNATURE_INVALID', `${location}.value is not canonical Ed25519 signature bytes.`);
}

function publicKeyObject(publicKeyPem, location = 'publicKeyPem') {
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----\n')
    || !publicKeyPem.endsWith('-----END PUBLIC KEY-----\n')) schemaError('TRUST_KEY_INVALID', `${location} must be a public SPKI PEM.`);
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') schemaError('TRUST_KEY_INVALID', `${location} must be Ed25519.`);
    return key;
  } catch (error) {
    if (error instanceof AcceptanceSchemaError) throw error;
    schemaError('TRUST_KEY_INVALID', `${location} is not a valid Ed25519 public key.`);
  }
}

function privateKeyObject(privateKey, location = 'privateKey') {
  try {
    const key = privateKey?.type === 'private' ? privateKey : createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ed25519') schemaError('SIGNER_KEY_INVALID', `${location} must be Ed25519.`);
    return key;
  } catch (error) {
    if (error instanceof AcceptanceSchemaError) throw error;
    schemaError('SIGNER_KEY_INVALID', `${location} is not a valid Ed25519 private key.`);
  }
}

function publicKeyFingerprint(publicKeyPem) {
  const der = publicKeyObject(publicKeyPem).export({ type: 'spki', format: 'der' });
  return canonicalSha256({ spkiDerBase64: der.toString('base64') });
}

export function signAcceptanceDocument(document, signer) {
  exactKeys(signer, ['keyId', 'privateKey'], 'signer');
  requiredString(signer.keyId, SAFE_ID, 'signer.keyId');
  const sealed = sealAcceptanceDocument(document);
  const value = ed25519Sign(null, signedPayload(sealed), privateKeyObject(signer.privateKey)).toString('base64');
  return { ...sealed, signature: { algorithm: 'Ed25519', keyId: signer.keyId, value } };
}

export function verifyAcceptanceSignature(document, verifier) {
  try {
    if (!verifyAcceptanceIntegrity(document)) return false;
    validateSignature(document.signature, 'document.signature');
    requiredString(verifier?.keyId, SAFE_ID, 'verifier.keyId');
    if (document.signature.keyId !== verifier.keyId) return false;
    return ed25519Verify(null, signedPayload(document), publicKeyObject(verifier.publicKeyPem), Buffer.from(document.signature.value, 'base64'));
  } catch {
    return false;
  }
}

function validateSource(value, location) {
  exactKeys(value, ['fingerprint', 'head'], location);
  requiredString(value.head, GIT_HEAD, `${location}.head`);
  requiredString(value.fingerprint, SHA256, `${location}.fingerprint`);
}

function validateSignerDescriptor(value, location, includeSubject) {
  exactKeys(value, includeSubject ? ['keyId', 'publicKeyPem', 'subjectId'] : ['keyId', 'publicKeyPem'], location);
  requiredString(value.keyId, SAFE_ID, `${location}.keyId`);
  if (includeSubject) requiredString(value.subjectId, SAFE_ID, `${location}.subjectId`);
  publicKeyObject(value.publicKeyPem, `${location}.publicKeyPem`);
}

function validateIssuerList(value, location) {
  if (!Array.isArray(value) || value.length === 0) schemaError('TRUST_POLICY_INVALID', `${location} must be a non-empty array.`);
  value.forEach((item, index) => validateSignerDescriptor(item, `${location}[${index}]`, true));
}

export function validateAcceptanceTrustPolicy(policy, evaluatedAt = Date.now()) {
  exactKeys(policy, [
    'expiresAt', 'issuedAt', 'issuers', 'platformContractSigner', 'policyId', 'policyType',
    'schemaVersion', 'verdictSigner',
  ], 'trustPolicy');
  if (policy.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION || policy.policyType !== TRUST_POLICY_TYPE) {
    schemaError('TRUST_POLICY_INVALID', 'Trust policy type or version is unsupported.');
  }
  requiredString(policy.policyId, SAFE_ID, 'trustPolicy.policyId');
  validateSignerDescriptor(policy.platformContractSigner, 'trustPolicy.platformContractSigner', false);
  validateSignerDescriptor(policy.verdictSigner, 'trustPolicy.verdictSigner', false);
  exactKeys(policy.issuers, ['governance', 'semanticReview', 'verification'], 'trustPolicy.issuers');
  validateIssuerList(policy.issuers.governance, 'trustPolicy.issuers.governance');
  validateIssuerList(policy.issuers.verification, 'trustPolicy.issuers.verification');
  validateIssuerList(policy.issuers.semanticReview, 'trustPolicy.issuers.semanticReview');
  const issuedAt = requiredTimestamp(policy.issuedAt, 'trustPolicy.issuedAt');
  const expiresAt = requiredTimestamp(policy.expiresAt, 'trustPolicy.expiresAt');
  if (expiresAt <= issuedAt || evaluatedAt < issuedAt || evaluatedAt >= expiresAt) {
    schemaError('TRUST_POLICY_STALE', 'The protected trust policy is not current at evaluation time.');
  }
  const descriptors = [
    policy.platformContractSigner, policy.verdictSigner,
    ...policy.issuers.governance, ...policy.issuers.verification, ...policy.issuers.semanticReview,
  ];
  if (new Set(descriptors.map((item) => item.keyId)).size !== descriptors.length) {
    schemaError('TRUST_POLICY_INVALID', 'Trust policy key ids must be globally unique across roles.');
  }
  if (new Set(descriptors.map((item) => publicKeyFingerprint(item.publicKeyPem))).size !== descriptors.length) {
    schemaError('TRUST_POLICY_INVALID', 'Trust policy public keys must be distinct across roles.');
  }
  return policy;
}

function validateObligation(obligation, index, requiredProfiles) {
  const location = `contract.requiredObligations[${index}]`;
  exactKeys(obligation, ['dimension', 'evidenceType', 'id', 'profile'], location);
  requiredString(obligation.id, SAFE_ID, `${location}.id`);
  if (!PROOF_DIMENSIONS.includes(obligation.dimension)) schemaError('SCHEMA_INVALID', `${location}.dimension is invalid.`);
  if (!['governance', 'verification', 'semantic-review'].includes(obligation.evidenceType)) schemaError('SCHEMA_INVALID', `${location}.evidenceType is invalid.`);
  if (obligation.evidenceType === 'verification') {
    requiredString(obligation.profile, SAFE_PROFILE, `${location}.profile`);
    if (!requiredProfiles.includes(obligation.profile)) schemaError('SCHEMA_INVALID', `${location}.profile is not a required profile.`);
  } else if (obligation.profile !== null) schemaError('SCHEMA_INVALID', `${location}.profile must be null for this evidence type.`);
}

export function validateAcceptanceContract(contract, trustPolicy) {
  exactKeys(contract, [
    'candidate', 'contractId', 'contractType', 'expiresAt', 'integrity', 'issuedAt', 'projectSlug',
    'requiredDimensions', 'requiredGovernanceProfile', 'requiredObligations', 'requiredProfiles',
    'schemaVersion', 'signature', 'taskId',
    ...(Object.hasOwn(contract, 'dualReview') ? ['dualReview'] : []),
    ...(Object.hasOwn(contract, 'previousReview') ? ['previousReview'] : []),
  ], 'contract');
  if (contract.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION || contract.contractType !== CONTRACT_TYPE) schemaError('CONTRACT_TYPE_INVALID', 'The task execution contract type or version is unsupported.');
  requiredString(contract.contractId, SAFE_ID, 'contract.contractId');
  requiredString(contract.projectSlug, SAFE_ID, 'contract.projectSlug');
  requiredString(contract.taskId, SAFE_ID, 'contract.taskId');
  requiredString(contract.requiredGovernanceProfile, SAFE_PROFILE, 'contract.requiredGovernanceProfile');
  exactKeys(contract.candidate, ['authorId', 'diffSha256', 'source'], 'contract.candidate');
  requiredString(contract.candidate.authorId, SAFE_ID, 'contract.candidate.authorId');
  requiredString(contract.candidate.diffSha256, SHA256, 'contract.candidate.diffSha256');
  validateSource(contract.candidate.source, 'contract.candidate.source');
  const requiredProfiles = uniqueStrings(contract.requiredProfiles, SAFE_PROFILE, 'contract.requiredProfiles', { allowEmpty: true });
  const requiredDimensions = uniqueStrings(contract.requiredDimensions, SAFE_ID, 'contract.requiredDimensions');
  if (requiredDimensions.some((item) => !PROOF_DIMENSIONS.includes(item)) || !requiredDimensions.includes('implemented')) schemaError('SCHEMA_INVALID', 'contract.requiredDimensions must contain implemented and only known proof dimensions.');
  if (!Array.isArray(contract.requiredObligations) || contract.requiredObligations.length === 0) schemaError('SCHEMA_INVALID', 'contract.requiredObligations must be a non-empty array.');
  contract.requiredObligations.forEach((item, index) => validateObligation(item, index, requiredProfiles));
  const dualObligation = contract.requiredObligations.find((item) => item.id === 'spec-and-quality-review');
  if (Boolean(dualObligation) !== Object.hasOwn(contract, 'dualReview')
    || (dualObligation && (dualObligation.dimension !== 'semantic' || dualObligation.evidenceType !== 'semantic-review'))) {
    schemaError('CONTRACT_DUAL_REVIEW_INVALID', 'Dual review binding and protected semantic obligation must be present together.');
  }
  if (dualObligation) normalizeForgeDualReviewBinding(contract.dualReview);
  if (Object.hasOwn(contract, 'previousReview')) {
    if (!dualObligation) schemaError('CONTRACT_DUAL_REVIEW_INVALID', 'Previous review requires its protected dual-review obligation.');
    validateForgeReviewPredecessor(contract.previousReview);
  }
  if (new Set(contract.requiredObligations.map((item) => item.id)).size !== contract.requiredObligations.length) schemaError('SCHEMA_INVALID', 'contract.requiredObligations contains duplicate ids.');
  const issuedAt = requiredTimestamp(contract.issuedAt, 'contract.issuedAt');
  const expiresAt = requiredTimestamp(contract.expiresAt, 'contract.expiresAt');
  if (expiresAt <= issuedAt) schemaError('SCHEMA_INVALID', 'contract.expiresAt must be later than issuedAt.');
  if (issuedAt < Date.parse(trustPolicy.issuedAt) || expiresAt > Date.parse(trustPolicy.expiresAt)) {
    schemaError('CONTRACT_TRUST_WINDOW_INVALID', 'Contract validity must remain inside the protected trust policy window.');
  }
  validateIntegrity(contract.integrity, 'contract.integrity');
  validateSignature(contract.signature, 'contract.signature');
  if (!verifyAcceptanceIntegrity(contract)) schemaError('CONTRACT_INTEGRITY_INVALID', 'The task execution contract integrity hash does not match.');
  if (!verifyAcceptanceSignature(contract, trustPolicy.platformContractSigner)) schemaError('CONTRACT_SIGNATURE_INVALID', 'The task execution contract is not signed by the protected platform contract key.');
  return contract;
}

function trustedIssuer(trustPolicy, kind, issuer) {
  const candidate = trustPolicy.issuers[kind].find((item) => item.keyId === issuer.keyId);
  if (candidate === undefined || candidate.subjectId !== issuer.subjectId) schemaError('RECEIPT_SIGNER_UNTRUSTED', 'Receipt signer is not trusted for this evidence role.');
  return candidate;
}

function validateReceiptCommon(receipt, contract, trustPolicy, kind, evaluatedAt, receiptType = RECEIPT_TYPES[kind]) {
  if (receipt.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION || receipt.receiptType !== receiptType) schemaError('RECEIPT_TYPE_INVALID', 'Receipt type or version is unsupported.');
  requiredString(receipt.receiptId, SAFE_ID, 'receipt.receiptId');
  requiredString(receipt.contractId, SAFE_ID, 'receipt.contractId');
  requiredString(receipt.contractFingerprint, INTEGRITY_SHA256, 'receipt.contractFingerprint');
  requiredString(receipt.projectSlug, SAFE_ID, 'receipt.projectSlug');
  requiredString(receipt.taskId, SAFE_ID, 'receipt.taskId');
  validateSource(receipt.source, 'receipt.source');
  requiredString(receipt.candidateDiffSha256, SHA256, 'receipt.candidateDiffSha256');
  exactKeys(receipt.issuer, ['keyId', 'role', 'subjectId'], 'receipt.issuer');
  requiredString(receipt.issuer.keyId, SAFE_ID, 'receipt.issuer.keyId');
  requiredString(receipt.issuer.subjectId, SAFE_ID, 'receipt.issuer.subjectId');
  requiredString(receipt.issuer.role, SAFE_ID, 'receipt.issuer.role');
  if (!['passed', 'failed', 'blocked'].includes(receipt.status)) schemaError('SCHEMA_INVALID', 'receipt.status is invalid.');
  const issuedAt = requiredTimestamp(receipt.issuedAt, 'receipt.issuedAt');
  const expiresAt = requiredTimestamp(receipt.expiresAt, 'receipt.expiresAt');
  if (expiresAt <= issuedAt) schemaError('SCHEMA_INVALID', 'receipt.expiresAt must be later than issuedAt.');
  validateIntegrity(receipt.integrity, 'receipt.integrity');
  validateSignature(receipt.signature, 'receipt.signature');
  if (!verifyAcceptanceIntegrity(receipt)) schemaError('RECEIPT_INTEGRITY_INVALID', 'Receipt integrity hash does not match.');
  if (receipt.contractId !== contract.contractId || receipt.contractFingerprint !== contract.integrity.canonicalSha256
    || receipt.projectSlug !== contract.projectSlug || receipt.taskId !== contract.taskId) schemaError('RECEIPT_CONTRACT_MISMATCH', 'Receipt is bound to another contract or task.');
  if (receipt.source.head !== contract.candidate.source.head || receipt.source.fingerprint !== contract.candidate.source.fingerprint
    || receipt.candidateDiffSha256 !== contract.candidate.diffSha256) schemaError('RECEIPT_SOURCE_MISMATCH', 'Receipt source or candidate diff does not match the contract.');
  if (issuedAt < Date.parse(contract.issuedAt) || issuedAt > evaluatedAt || expiresAt <= evaluatedAt
    || expiresAt > Date.parse(contract.expiresAt) || expiresAt > Date.parse(trustPolicy.expiresAt)) {
    schemaError('RECEIPT_STALE', 'Receipt is expired, predates the contract, is from the future, or outlives its trust window.');
  }
  const verifier = trustedIssuer(trustPolicy, kind, receipt.issuer);
  if (!verifyAcceptanceSignature(receipt, verifier)) schemaError('RECEIPT_SIGNATURE_INVALID', 'Receipt signature does not verify against its protected role key.');
}

function validateReceiptObligations(receipt, contract, kind, profile = null) {
  uniqueStrings(receipt.obligations, SAFE_ID, 'receipt.obligations', { allowEmpty: true });
  const declarations = new Map(contract.requiredObligations.map((item) => [item.id, item]));
  const evidenceType = kind === 'semanticReview' ? 'semantic-review' : kind;
  for (const id of receipt.obligations) {
    const declaration = declarations.get(id);
    if (declaration === undefined || declaration.evidenceType !== evidenceType
      || (kind === 'verification' && declaration.profile !== profile)) schemaError('RECEIPT_OBLIGATION_INVALID', 'Receipt claims an undeclared or incompatible obligation.');
  }
}

function validateGovernanceReceipt(receipt, contract, trustPolicy, evaluatedAt) {
  exactKeys(receipt, [
    'candidateDiffSha256', 'contractFingerprint', 'contractId', 'expiresAt', 'integrity', 'issuedAt',
    'issuer', 'obligations', 'profile', 'projectSlug', 'receiptId', 'receiptType', 'schemaVersion',
    'signature', 'source', 'status', 'taskId',
  ], 'governanceReceipt');
  validateReceiptCommon(receipt, contract, trustPolicy, 'governance', evaluatedAt);
  requiredString(receipt.profile, SAFE_PROFILE, 'governanceReceipt.profile');
  if (receipt.profile !== contract.requiredGovernanceProfile || receipt.issuer.role !== 'governance-engine') schemaError('GOVERNANCE_RECEIPT_INVALID', 'Governance profile or issuer role is invalid.');
  validateReceiptObligations(receipt, contract, 'governance');
  return { kind: 'governance', dimension: 'implemented', profile: receipt.profile, receipt };
}

function validateVerificationReceipt(receipt, contract, trustPolicy, evaluatedAt) {
  exactKeys(receipt, [
    'candidateDiffSha256', 'contractFingerprint', 'contractId', 'dimension', 'execution', 'expiresAt',
    'integrity', 'issuedAt', 'issuer', 'obligations', 'profile', 'projectSlug', 'receiptId',
    'receiptType', 'schemaVersion', 'signature', 'source', 'status', 'taskId',
  ], 'verificationReceipt');
  validateReceiptCommon(receipt, contract, trustPolicy, 'verification', evaluatedAt);
  requiredString(receipt.profile, SAFE_PROFILE, 'verificationReceipt.profile');
  if (!contract.requiredProfiles.includes(receipt.profile)) schemaError('VERIFICATION_PROFILE_UNEXPECTED', 'Verification receipt profile is not required by the contract.');
  if (!VERIFICATION_DIMENSIONS.has(receipt.dimension) || receipt.issuer.role !== 'verification-runner') schemaError('VERIFICATION_RECEIPT_INVALID', 'Verification dimension or issuer role is invalid.');
  exactKeys(receipt.execution, ['exitCode', 'logSha256', 'timedOut'], 'verificationReceipt.execution');
  if (!Number.isSafeInteger(receipt.execution.exitCode) || receipt.execution.exitCode < 0
    || typeof receipt.execution.timedOut !== 'boolean' || !SHA256.test(receipt.execution.logSha256 ?? '')) schemaError('VERIFICATION_RECEIPT_INVALID', 'Verification execution facts are invalid.');
  if (receipt.status === 'passed' && (receipt.execution.exitCode !== 0 || receipt.execution.timedOut)) schemaError('VERIFICATION_TRUTH_MISMATCH', 'A passing verification receipt contradicts its execution facts.');
  validateReceiptObligations(receipt, contract, 'verification', receipt.profile);
  return { kind: 'verification', dimension: receipt.dimension, profile: receipt.profile, receipt };
}

function validateSemanticReviewReceipt(receipt, contract, trustPolicy, evaluatedAt) {
  exactKeys(receipt, [
    'candidateDiffSha256', 'contractFingerprint', 'contractId', 'expiresAt', 'integrity', 'issuedAt',
    'issuer', 'obligations', 'projectSlug', 'receiptId', 'receiptType', 'review', 'schemaVersion',
    'signature', 'source', 'status', 'taskId',
  ], 'semanticReviewReceipt');
  validateReceiptCommon(receipt, contract, trustPolicy, 'semanticReview', evaluatedAt);
  exactKeys(receipt.review, ['decision', 'reviewerId', 'summarySha256',
    ...(Object.hasOwn(receipt.review, 'dualReview') ? ['dualReview'] : [])], 'semanticReviewReceipt.review');
  if (Object.hasOwn(contract, 'dualReview') !== Object.hasOwn(receipt.review, 'dualReview')) {
    schemaError('SEMANTIC_REVIEW_DUAL_VERDICTS_REQUIRED', 'A dual-review contract requires both source-bound verdicts; a legacy decision cannot close it.');
  }
  if (contract.dualReview !== undefined) validateForgeDualReviewEvidence(receipt.review.dualReview, { decision: receipt.review.decision, contract });
  requiredString(receipt.review.reviewerId, SAFE_ID, 'semanticReviewReceipt.review.reviewerId');
  requiredString(receipt.review.summarySha256, SHA256, 'semanticReviewReceipt.review.summarySha256');
  if (!['approved', 'rejected'].includes(receipt.review.decision) || receipt.review.reviewerId !== receipt.issuer.subjectId
    || receipt.issuer.role !== 'independent-reviewer') schemaError('SEMANTIC_REVIEW_INVALID', 'Semantic review identity or decision is invalid.');
  if (receipt.review.reviewerId === contract.candidate.authorId) schemaError('SEMANTIC_REVIEW_SELF_AUTHORED', 'The candidate author cannot approve the semantic review.');
  if ((receipt.status === 'passed') !== (receipt.review.decision === 'approved')) schemaError('SEMANTIC_REVIEW_TRUTH_MISMATCH', 'Semantic review status contradicts its decision.');
  validateReceiptObligations(receipt, contract, 'semanticReview');
  return { kind: 'semantic-review', dimension: 'semantic', profile: null, receipt };
}

// An exact method result is evidence about that execution, not satisfaction of
// the class contract. Keep its type outside the aggregate's accepted kinds.
export function verifyAcceptanceDiagnosticReceipt(input) {
  exactKeys(input, ['contract', 'evaluatedAt', 'receipt', 'trustPolicy'], 'diagnosticVerification');
  const evaluatedAt = requiredTimestamp(input.evaluatedAt, 'diagnosticVerification.evaluatedAt');
  const trustPolicy = validateAcceptanceTrustPolicy(input.trustPolicy, evaluatedAt);
  const contract = validateAcceptanceContract(input.contract, trustPolicy);
  const receipt = input.receipt;
  exactKeys(receipt, [
    'candidateDiffSha256', 'contractFingerprint', 'contractId', 'execution', 'expiresAt',
    'fullContractCovered', 'integrity', 'issuedAt', 'issuer', 'obligations', 'profile',
    'projectSlug', 'receiptId', 'receiptType', 'results', 'runnerReceiptSha256',
    'schemaVersion', 'selectors', 'signature', 'source', 'status', 'taskId',
    ...(Object.hasOwn(receipt, 'workflowInventory') ? ['workflowInventory'] : []),
  ], 'diagnosticReceipt');
  validateReceiptCommon(receipt, contract, trustPolicy, 'verification', evaluatedAt, ACCEPTANCE_DIAGNOSTIC_RECEIPT_TYPE);
  if (receipt.profile !== 'backend-test-class' || receipt.issuer.role !== 'verification-runner'
    || receipt.fullContractCovered !== false || !Array.isArray(receipt.obligations) || receipt.obligations.length !== 0) {
    schemaError('DIAGNOSTIC_RECEIPT_SCOPE_INVALID', 'Method diagnostics cannot claim any full contract obligation.');
  }
  exactKeys(receipt.selectors, ['modules', 'tests'], 'diagnosticReceipt.selectors');
  uniqueStrings(receipt.selectors.modules, /^forge-server(?:\/[A-Za-z0-9_.-]+)+$/u, 'diagnosticReceipt.selectors.modules');
  if (receipt.selectors.modules.some(module => module.split('/').some(part => part === '.' || part === '..'))) {
    schemaError('DIAGNOSTIC_RECEIPT_SCOPE_INVALID', 'Diagnostic module paths must be repository-relative.');
  }
  uniqueStrings(receipt.selectors.tests, /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*#[A-Za-z_$][\w$]*$/u, 'diagnosticReceipt.selectors.tests');
  requiredString(receipt.runnerReceiptSha256, INTEGRITY_SHA256, 'diagnosticReceipt.runnerReceiptSha256');
  exactKeys(receipt.execution, ['exitCode', 'logSha256', 'timedOut'], 'diagnosticReceipt.execution');
  if (!Number.isSafeInteger(receipt.execution.exitCode) || receipt.execution.exitCode < 0
    || typeof receipt.execution.timedOut !== 'boolean' || !SHA256.test(receipt.execution.logSha256 ?? '')) {
    schemaError('DIAGNOSTIC_RECEIPT_TRUTH_INVALID', 'Diagnostic execution facts are invalid.');
  }
  exactKeys(receipt.results, ['executed', 'failed', 'passed', 'skipped'], 'diagnosticReceipt.results');
  if (Object.values(receipt.results).some(count => !Number.isSafeInteger(count) || count < 0)
    || receipt.results.executed !== receipt.results.passed + receipt.results.failed + receipt.results.skipped
    || (receipt.status === 'passed' && (receipt.execution.exitCode !== 0 || receipt.execution.timedOut
      || receipt.results.passed < 1 || receipt.results.failed > 0))) {
    schemaError('DIAGNOSTIC_RECEIPT_TRUTH_INVALID', 'Diagnostic result contradicts execution facts.');
  }
  let workflowInventory;
  if (Object.hasOwn(receipt, 'workflowInventory')) {
    const inventory = receipt.workflowInventory;
    exactKeys(inventory, ['policyId', 'observation', 'executionStartedAt', 'executionFinishedAt'], 'diagnosticReceipt.workflowInventory');
    requiredString(inventory.policyId, SAFE_ID, 'workflow inventory policyId');
    const observation = validateForgeWorkflowInventoryObservation(inventory.observation);
    const startedAt = requiredTimestamp(inventory.executionStartedAt, 'inventory executionStartedAt');
    const finishedAt = requiredTimestamp(inventory.executionFinishedAt, 'inventory executionFinishedAt');
    const capturedAt = Date.parse(observation.capturedAt);
    if (receipt.status !== 'passed' || receipt.results.executed !== 1 || receipt.results.passed !== 1
        || receipt.selectors.tests.length !== 1 || receipt.selectors.modules.length !== 1
        || startedAt > capturedAt || capturedAt > finishedAt || finishedAt > Date.parse(receipt.issuedAt)) {
      schemaError('WORKFLOW_INVENTORY_EVIDENCE_INVALID', 'Inventory must be observed within its successful method execution.');
    }
    workflowInventory = Object.freeze({ ...structuredClone(inventory), observation,
      observationDigest: canonicalSha256(observation), currentRuntimeProven: false,
      deployAuthorized: false, instanceCasProven: false });
  }
  return Object.freeze({ receiptId: receipt.receiptId, status: receipt.status,
    fullContractCovered: false, selectors: structuredClone(receipt.selectors), results: { ...receipt.results },
    source: { ...receipt.source }, runnerReceiptSha256: receipt.runnerReceiptSha256,
    executionLogSha256: receipt.execution.logSha256, integrityDigest: receipt.integrity.canonicalSha256,
    ...(workflowInventory ? { workflowInventory } : {}) });
}

export function verifyAcceptanceEvidenceReceipt(input) {
  exactKeys(input, ['contract', 'evaluatedAt', 'kind', 'receipt', 'trustPolicy'], 'evidenceVerification');
  const evaluatedAt = requiredTimestamp(input.evaluatedAt, 'evidenceVerification.evaluatedAt');
  const trustPolicy = validateAcceptanceTrustPolicy(input.trustPolicy, evaluatedAt);
  const contract = validateAcceptanceContract(input.contract, trustPolicy);
  if (!['governance', 'verification', 'semanticReview'].includes(input.kind)) {
    schemaError('RECEIPT_TYPE_INVALID', 'Evidence verification kind is unsupported.');
  }
  const item = input.kind === 'governance'
    ? validateGovernanceReceipt(input.receipt, contract, trustPolicy, evaluatedAt)
    : input.kind === 'verification'
      ? validateVerificationReceipt(input.receipt, contract, trustPolicy, evaluatedAt)
      : validateSemanticReviewReceipt(input.receipt, contract, trustPolicy, evaluatedAt);
  return Object.freeze({
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    verificationType: 'forge-acceptance/verified-evidence-projection',
    kind: input.kind,
    receiptId: item.receipt.receiptId,
    receiptType: item.receipt.receiptType,
    status: item.receipt.status,
    source: Object.freeze({ ...item.receipt.source }),
    candidateDiffSha256: item.receipt.candidateDiffSha256,
    profile: item.profile,
    dimension: item.dimension,
    obligations: Object.freeze([...item.receipt.obligations]),
    executionLogSha256: input.kind === 'verification' ? item.receipt.execution.logSha256 : null,
    integrityDigest: item.receipt.integrity.canonicalSha256,
    signerKeyId: item.receipt.issuer.keyId,
    signerSubjectId: item.receipt.issuer.subjectId,
  });
}

function blocker(code, detail, receiptId = null) {
  return { code, detail, receiptId };
}

function receiptIdHint(value) {
  return plainObject(value) && typeof value.receiptId === 'string' && SAFE_ID.test(value.receiptId) ? value.receiptId : null;
}

function receiptFailure(error, value) {
  return blocker(error instanceof AcceptanceSchemaError ? error.code : 'RECEIPT_INVALID',
    error instanceof AcceptanceSchemaError ? error.message : 'Receipt validation failed.', receiptIdHint(value));
}

function validateCurrent(current) {
  exactKeys(current, ['candidateDiffSha256', 'observedAt', 'source'], 'current');
  validateSource(current.source, 'current.source');
  requiredString(current.candidateDiffSha256, SHA256, 'current.candidateDiffSha256');
  return requiredTimestamp(current.observedAt, 'current.observedAt');
}

function sortBlockers(items) {
  return [...items].sort((left, right) => left.code.localeCompare(right.code, 'en')
    || (left.receiptId ?? '').localeCompare(right.receiptId ?? '', 'en')
    || left.detail.localeCompare(right.detail, 'en'));
}

function protectedVerdictSigner(context, trustPolicy) {
  if (context.verdictSigner === null) return null;
  exactKeys(context.verdictSigner, ['keyId', 'privateKey'], 'protectedContext.verdictSigner');
  if (context.verdictSigner.keyId !== trustPolicy.verdictSigner.keyId) return false;
  try {
    const challenge = Buffer.from('forge-acceptance-verdict-signer-v1', 'utf8');
    const signature = ed25519Sign(null, challenge, privateKeyObject(context.verdictSigner.privateKey));
    return ed25519Verify(null, challenge, publicKeyObject(trustPolicy.verdictSigner.publicKeyPem), signature)
      ? context.verdictSigner : false;
  } catch {
    return false;
  }
}

export function verifyAcceptanceVerdict(verdict, trustPolicy) {
  try {
    exactKeys(verdict, [
      'acceptedObligations', 'acceptedProfiles', 'attestation', 'blockers', 'candidateDiffSha256',
      'contractFingerprint', 'contractId', 'dimensions', 'evaluatedAt', 'evidenceReceiptIds',
      'integrity', 'schemaVersion', 'signature', 'source', 'trustPolicyFingerprint', 'verdict',
      'verdictType',
    ], 'verdict');
    const evaluatedAt = requiredTimestamp(verdict.evaluatedAt, 'verdict.evaluatedAt');
    validateAcceptanceTrustPolicy(trustPolicy, evaluatedAt);
    if (verdict.schemaVersion !== ACCEPTANCE_SCHEMA_VERSION || verdict.verdictType !== VERDICT_TYPE
      || verdict.attestation !== 'signed-verdict' || !['accepted', 'candidate-blocked'].includes(verdict.verdict)
      || verdict.trustPolicyFingerprint !== canonicalSha256(trustPolicy)) return false;
    requiredString(verdict.contractId, SAFE_ID, 'verdict.contractId');
    requiredString(verdict.contractFingerprint, INTEGRITY_SHA256, 'verdict.contractFingerprint');
    requiredString(verdict.candidateDiffSha256, SHA256, 'verdict.candidateDiffSha256');
    validateSource(verdict.source, 'verdict.source');
    uniqueStrings(verdict.acceptedProfiles, SAFE_PROFILE, 'verdict.acceptedProfiles', { allowEmpty: true });
    uniqueStrings(verdict.acceptedObligations, SAFE_ID, 'verdict.acceptedObligations', { allowEmpty: true });
    uniqueStrings(verdict.evidenceReceiptIds, SAFE_ID, 'verdict.evidenceReceiptIds', { allowEmpty: true });
    exactKeys(verdict.dimensions, PROOF_DIMENSIONS, 'verdict.dimensions');
    for (const dimension of PROOF_DIMENSIONS) {
      const proof = verdict.dimensions[dimension];
      exactKeys(proof, ['receiptIds', 'required', 'status'], `verdict.dimensions.${dimension}`);
      if (typeof proof.required !== 'boolean' || !['proven', 'blocked', 'not-required'].includes(proof.status)) return false;
      uniqueStrings(proof.receiptIds, SAFE_ID, `verdict.dimensions.${dimension}.receiptIds`, { allowEmpty: true });
    }
    if (!Array.isArray(verdict.blockers)) return false;
    for (const item of verdict.blockers) {
      exactKeys(item, ['code', 'detail', 'receiptId'], 'verdict.blockers[]');
      requiredString(item.code, SAFE_ID, 'verdict.blockers[].code');
      if (typeof item.detail !== 'string' || item.detail.length === 0 || item.detail.length > 512) return false;
      if (item.receiptId !== null) requiredString(item.receiptId, SAFE_ID, 'verdict.blockers[].receiptId');
    }
    if ((verdict.verdict === 'accepted') !== (verdict.blockers.length === 0)) return false;
    validateIntegrity(verdict.integrity, 'verdict.integrity');
    validateSignature(verdict.signature, 'verdict.signature');
    return verifyAcceptanceSignature(verdict, trustPolicy.verdictSigner);
  } catch {
    return false;
  }
}

export function aggregateAcceptance(input, protectedContext) {
  exactKeys(input, ['contract', 'current', 'governanceReceipt', 'semanticReviewReceipts', 'verificationReceipts'], 'input');
  exactKeys(protectedContext, ['trustPolicy', 'verdictSigner'], 'protectedContext');
  const evaluatedAt = validateCurrent(input.current);
  const trustPolicy = validateAcceptanceTrustPolicy(protectedContext.trustPolicy, evaluatedAt);
  const contract = validateAcceptanceContract(input.contract, trustPolicy);
  if (!Array.isArray(input.verificationReceipts) || !Array.isArray(input.semanticReviewReceipts)) schemaError('SCHEMA_INVALID', 'Receipt collections must be arrays.');

  const blockers = [];
  if (evaluatedAt < Date.parse(contract.issuedAt) || evaluatedAt >= Date.parse(contract.expiresAt)) blockers.push(blocker('CONTRACT_STALE', 'The task execution contract is not current at evaluation time.'));
  if (input.current.source.head !== contract.candidate.source.head || input.current.source.fingerprint !== contract.candidate.source.fingerprint) blockers.push(blocker('SOURCE_FINGERPRINT_STALE', 'Current source does not match the contracted candidate source.'));
  if (input.current.candidateDiffSha256 !== contract.candidate.diffSha256) blockers.push(blocker('CANDIDATE_DIFF_STALE', 'Current candidate diff does not match the contracted candidate diff.'));

  const validated = [];
  const receipts = [
    { kind: 'governance', value: input.governanceReceipt },
    ...input.verificationReceipts.map((value) => ({ kind: 'verification', value })),
    ...input.semanticReviewReceipts.map((value) => ({ kind: 'semanticReview', value })),
  ];
  const receiptIds = new Set();
  for (const { kind, value } of receipts) {
    if (!plainObject(value)) {
      blockers.push(blocker('RECEIPT_NOT_STRUCTURED', 'Receipt evidence must be a typed JSON object; stdout or prose is not evidence.'));
      continue;
    }
    try {
      if (RECEIPT_KIND_BY_TYPE.get(value.receiptType) !== kind) schemaError('RECEIPT_TYPE_INVALID', 'Receipt was supplied in the wrong typed collection.');
      const item = kind === 'governance' ? validateGovernanceReceipt(value, contract, trustPolicy, evaluatedAt)
        : kind === 'verification' ? validateVerificationReceipt(value, contract, trustPolicy, evaluatedAt)
          : validateSemanticReviewReceipt(value, contract, trustPolicy, evaluatedAt);
      if (receiptIds.has(item.receipt.receiptId)) schemaError('RECEIPT_DUPLICATE', 'Receipt id is duplicated.');
      receiptIds.add(item.receipt.receiptId);
      validated.push(item);
      if (item.receipt.status !== 'passed') blockers.push(blocker('RECEIPT_FAILED', 'A required-contract receipt is failed or blocked.', item.receipt.receiptId));
    } catch (error) {
      blockers.push(receiptFailure(error, value));
    }
  }

  const passing = validated.filter((item) => item.receipt.status === 'passed');
  const provenDimensions = new Map(PROOF_DIMENSIONS.map((dimension) => [dimension, []]));
  const acceptedProfiles = new Set();
  const acceptedObligations = new Set();
  for (const item of passing) {
    provenDimensions.get(item.dimension).push(item.receipt.receiptId);
    if (item.kind === 'verification') acceptedProfiles.add(item.profile);
    item.receipt.obligations.forEach((id) => acceptedObligations.add(id));
  }
  if (!passing.some((item) => item.kind === 'governance')) blockers.push(blocker('GOVERNANCE_RECEIPT_MISSING', 'A current passing governance receipt is required.'));
  for (const profile of contract.requiredProfiles) if (!acceptedProfiles.has(profile)) blockers.push(blocker('REQUIRED_PROFILE_MISSING', `Required verification profile is missing: ${profile}.`));
  for (const obligation of contract.requiredObligations) if (!acceptedObligations.has(obligation.id)) blockers.push(blocker('REQUIRED_OBLIGATION_MISSING', `Required obligation is missing: ${obligation.id}.`));
  for (const dimension of contract.requiredDimensions) if (provenDimensions.get(dimension).length === 0) blockers.push(blocker('REQUIRED_DIMENSION_MISSING', `Required proof dimension is missing: ${dimension}.`));

  const verdictSigner = protectedVerdictSigner(protectedContext, trustPolicy);
  if (verdictSigner === false) blockers.push(blocker('VERDICT_SIGNER_INVALID', 'Protected verdict signer does not match the trust policy verdict key.'));
  if (verdictSigner === null && blockers.length === 0) blockers.push(blocker('VERDICT_SIGNATURE_REQUIRED', 'An unsigned intermediate cannot claim an accepted verdict.'));
  const normalizedBlockers = sortBlockers(blockers);
  const dimensions = Object.fromEntries(PROOF_DIMENSIONS.map((dimension) => {
    const receiptIdsForDimension = [...provenDimensions.get(dimension)].sort();
    const required = contract.requiredDimensions.includes(dimension);
    return [dimension, { required, status: receiptIdsForDimension.length > 0 ? 'proven' : required ? 'blocked' : 'not-required', receiptIds: receiptIdsForDimension }];
  }));
  const signed = verdictSigner !== null && verdictSigner !== false;
  const verdict = {
    schemaVersion: ACCEPTANCE_SCHEMA_VERSION,
    verdictType: VERDICT_TYPE,
    verdict: normalizedBlockers.length === 0 && signed ? 'accepted' : 'candidate-blocked',
    attestation: signed ? 'signed-verdict' : 'unsigned-intermediate',
    contractId: contract.contractId,
    contractFingerprint: contract.integrity.canonicalSha256,
    trustPolicyFingerprint: canonicalSha256(trustPolicy),
    evaluatedAt: input.current.observedAt,
    source: input.current.source,
    candidateDiffSha256: input.current.candidateDiffSha256,
    dimensions,
    acceptedProfiles: [...acceptedProfiles].sort(),
    acceptedObligations: [...acceptedObligations].sort(),
    evidenceReceiptIds: passing.map((item) => item.receipt.receiptId).sort(),
    blockers: normalizedBlockers,
  };
  if (!signed) return sealAcceptanceDocument(verdict);
  const signedVerdict = signAcceptanceDocument(verdict, verdictSigner);
  if (!verifyAcceptanceVerdict(signedVerdict, trustPolicy)) schemaError('VERDICT_SIGNING_FAILED', 'Protected verdict signing did not produce a verifiable verdict.');
  return signedVerdict;
}

export const ACCEPTANCE_DOCUMENT_TYPES = Object.freeze({
  contract: CONTRACT_TYPE,
  trustPolicy: TRUST_POLICY_TYPE,
  verdict: VERDICT_TYPE,
  receipts: RECEIPT_TYPES,
});
