import crypto from 'node:crypto';
import { SUSPENDABLE_INDEPENDENT_REVIEW_OBLIGATIONS, normalizeForgeDualReviewBinding, normalizeForgeRoleGrantDecisions, validateForgeTaskExecutionContract } from './forge-task-execution-contract.mjs';

export const FORGE_OBLIGATION_LEDGER_SCHEMA_VERSION = 1;
export const FORGE_OBLIGATION_LEDGER_TYPE = 'forge-obligation-ledger/v1';

const SHA256 = /^[0-9a-f]{64}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9:._-]{1,159}$/u;
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$/u;

const RECEIPT_KINDS = Object.freeze({
  governance: 'forge-obligation-receipt/governance/v1',
  verification: 'forge-obligation-receipt/verification/v1',
  semanticReview: 'forge-obligation-receipt/semantic-review/v1',
  ownerInventory: 'forge-obligation-receipt/shared-owner-inventory/v1',
  ownerDecision: 'forge-obligation-receipt/shared-owner-decision/v1',
  consumerTests: 'forge-obligation-receipt/shared-consumer-tests/v1',
  crudContract: 'forge-obligation-receipt/crud-contract/v1',
  crudPermission: 'forge-obligation-receipt/crud-permission/v1',
  crudValidation: 'forge-obligation-receipt/crud-validation/v1',
  crudObservability: 'forge-obligation-receipt/crud-observability/v1',
});

const ISSUERS = Object.freeze({
  governance: 'forge-governance-engine',
  verification: 'forge-verification-runner',
  semanticReview: 'forge-semantic-reviewer',
  staticAnalysis: 'forge-static-analyzer',
  observability: 'forge-observability-runner',
});

const RECEIPT_KEYS = new Set([
  'receiptType', 'receiptId', 'receiptDigest', 'sourceFingerprint',
  'issuer', 'obligationId', 'evidenceRefs',
]);
const UNSIGNED_RECEIPT_KEYS = new Set([
  'receiptType', 'receiptId', 'sourceFingerprint', 'issuer', 'obligationId', 'evidenceRefs',
]);
const EVIDENCE_REF_KEYS = new Set(['kind', 'ref', 'digest']);
const LEDGER_KEYS = new Set([
  'schemaVersion', 'ledgerType', 'taskContractId', 'initialSourceFingerprint',
  'sourceFingerprint', 'generation', 'definitions', 'history', 'ledgerDigest',
]);

export class ForgeObligationLedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeObligationLedgerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeObligationLedgerError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail('LEDGER_INVALID_TYPE', `${label} must be a plain object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('LEDGER_UNSUPPORTED_FIELD', `${label} contains unsupported field ${key}.`);
  }
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('LEDGER_NOT_SERIALIZABLE', 'Canonical JSON rejects non-finite numbers.');
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) {
    fail('LEDGER_NOT_SERIALIZABLE', 'Canonical JSON accepts acyclic JSON values only.');
  }
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = value.map((entry) => canonicalValue(entry, seen));
  else {
    if (!isPlainObject(value)) fail('LEDGER_NOT_SERIALIZABLE', 'Canonical JSON accepts plain objects only.');
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail('LEDGER_NOT_SERIALIZABLE', `Undefined field is forbidden: ${key}.`);
      result[key] = canonicalValue(value[key], seen);
    }
  }
  seen.delete(value);
  return result;
}

export function canonicalForgeObligationJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function digestOf(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalForgeObligationJson(value), 'utf8').digest('hex')}`;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function uniqueIds(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !SAFE_ID.test(entry))) {
    fail('LEDGER_CONTRACT_INVALID', `${label} must be an array of stable obligation identifiers.`);
  }
  if (new Set(value).size !== value.length) fail('LEDGER_CONTRACT_INVALID', `${label} must be unique.`);
  return [...value];
}

function requirements(...pairs) {
  return pairs.map(([kind, minimum]) => ({ kind, minimum }));
}

function definition(id, category, receiptKinds, issuers, evidenceRequirements) {
  return {
    id,
    category,
    sourceBound: true,
    allowedReceiptKinds: [...receiptKinds].sort(),
    allowedIssuers: [...issuers].sort(),
    evidenceRequirements: evidenceRequirements.map((item) => ({ ...item })),
  };
}

function genericDefinition(id) {
  const normalized = id.toLowerCase();
  if (normalized === 'idempotent-workflow-callbacks'
    || /(?:test|verification|browser|responsive|loading|busy)/u.test(normalized)) {
    return definition(`contract:${id}`, 'task-contract', [RECEIPT_KINDS.verification],
      [ISSUERS.verification], requirements(['evidence', 1]));
  }
  if (normalized === 'spec-and-quality-review' || /(?:owner|crud|dictionary|api-error|workflow-state)/u.test(normalized)) {
    return definition(`contract:${id}`, 'task-contract', [RECEIPT_KINDS.semanticReview],
      [ISSUERS.semanticReview], requirements(['evidence', 1]));
  }
  return definition(`contract:${id}`, 'task-contract', [RECEIPT_KINDS.governance],
    [ISSUERS.governance], requirements(['evidence', 1]));
}

function definitionsFromTaskContract(taskContract) {
  exactKeys(taskContract, new Set([
    'schemaVersion', 'contractId', 'taskProfiles', 'requiredSkills', 'tddRequired',
    'requiredVerificationProfiles', 'requiredObligations', 'semanticOwners',
    'actionCeiling', 'ownedPaths', 'sourceFingerprint',
    ...(Object.hasOwn(taskContract, 'requiredRedProfiles') ? ['requiredRedProfiles'] : []),
    ...(Object.hasOwn(taskContract, 'suspendedReviewObligations') ? ['suspendedReviewObligations'] : []),
    ...(Object.hasOwn(taskContract, 'backendTestBindings') ? ['backendTestBindings'] : []),
    ...(Object.hasOwn(taskContract, 'dualReview') ? ['dualReview'] : []),
    ...(Object.hasOwn(taskContract, 'roleGrantDecisions') ? ['roleGrantDecisions'] : []),
    ...(Object.hasOwn(taskContract, 'semanticResources') ? ['semanticResources'] : []),
    ...(Object.hasOwn(taskContract, 'requestedVerificationProfiles') ? ['requestedVerificationProfiles'] : []),
    ...(Object.hasOwn(taskContract, 'developmentMode') ? ['developmentMode'] : []),
  ]), 'task contract');
  if (typeof taskContract.contractId !== 'string' || !SHA256.test(taskContract.contractId)
    || taskContract.schemaVersion !== 1
    || typeof taskContract.sourceFingerprint !== 'string' || !SHA256.test(taskContract.sourceFingerprint)) {
    fail('LEDGER_CONTRACT_INVALID', 'Task contract identity and source fingerprint must be lowercase SHA-256 values.');
  }
  const profiles = uniqueIds(taskContract.requiredVerificationProfiles, 'requiredVerificationProfiles');
  const contractObligations = uniqueIds(taskContract.requiredObligations, 'requiredObligations');
  if (contractObligations.includes('spec-and-quality-review') !== Object.hasOwn(taskContract, 'dualReview')) {
    fail('LEDGER_CONTRACT_INVALID', 'Dual review requires both a bound source and its semantic obligation.');
  }
  if (taskContract.dualReview !== undefined) normalizeForgeDualReviewBinding(taskContract.dualReview);
  if (taskContract.roleGrantDecisions !== undefined) normalizeForgeRoleGrantDecisions(taskContract.roleGrantDecisions, taskContract.ownedPaths);
  if (Object.hasOwn(taskContract, 'developmentMode') || Object.hasOwn(taskContract, 'semanticResources') || Object.hasOwn(taskContract, 'requestedVerificationProfiles')) {
    validateForgeTaskExecutionContract(taskContract);
  }
  const suspended = new Set(uniqueIds(taskContract.suspendedReviewObligations ?? [], 'suspendedReviewObligations'));
  if ([...suspended].some(id => !SUSPENDABLE_INDEPENDENT_REVIEW_OBLIGATIONS.includes(id) || contractObligations.includes(id))) {
    fail('LEDGER_CONTRACT_INVALID', 'Suspended review cannot remove technical proof or remain required.');
  }
  const taskProfiles = uniqueIds(taskContract.taskProfiles, 'taskProfiles');
  const semanticOwners = uniqueIds(taskContract.semanticOwners, 'semanticOwners');
  const result = [];
  for (const profile of profiles) {
    const governanceProfile = profile === 'governance';
    result.push(definition(
      `verification:${profile}`,
      'required-verification-profile',
      [governanceProfile ? RECEIPT_KINDS.governance : RECEIPT_KINDS.verification],
      [governanceProfile ? ISSUERS.governance : ISSUERS.verification],
      governanceProfile
        ? requirements(['verification-profile', 1], ['evidence', 1])
        : requirements(['verification-profile', 1], ['execution-log', 1]),
    ));
  }
  result.push(...contractObligations.map(genericDefinition));
  if (taskProfiles.includes('shared-owner') || semanticOwners.includes('shared-contract')) {
    result.push(
      definition('shared-owner:inventory', 'shared-owner', [RECEIPT_KINDS.ownerInventory],
        [ISSUERS.staticAnalysis], requirements(['search', 1], ['owner', 1], ['consumer', 2])),
      ...(suspended.has('unique-semantic-owner') ? [] : [
        definition('shared-owner:decision', 'shared-owner', [RECEIPT_KINDS.ownerDecision],
          [ISSUERS.semanticReview], requirements(['decision-record', 1], ['owner', 1], ['consumer', 2])),
      ]),
      definition('shared-owner:consumer-tests', 'shared-owner', [RECEIPT_KINDS.consumerTests],
        [ISSUERS.verification], requirements(['consumer-test', 2])),
    );
  }
  if (taskProfiles.includes('crud')) {
    result.push(
      ...(suspended.has('complete-crud-vertical-slice') ? [] : [
        definition('crud:contract', 'crud', [RECEIPT_KINDS.crudContract],
          [ISSUERS.semanticReview], requirements(['api-contract', 1], ['persistence-contract', 1])),
      ]),
      definition('crud:permission', 'crud', [RECEIPT_KINDS.crudPermission],
        [ISSUERS.governance], requirements(['permission-contract', 1], ['negative-test', 1])),
      definition('crud:validation', 'crud', [RECEIPT_KINDS.crudValidation],
        [ISSUERS.verification], requirements(['validation-test', 1])),
      definition('crud:observability', 'crud', [RECEIPT_KINDS.crudObservability],
        [ISSUERS.observability], requirements(['observability-signal', 1])),
    );
  }
  const byId = new Map();
  for (const item of result) {
    if (byId.has(item.id) && canonicalForgeObligationJson(byId.get(item.id)) !== canonicalForgeObligationJson(item)) {
      fail('LEDGER_DEFINITION_CONFLICT', `Obligation definition conflicts: ${item.id}.`);
    }
    byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function withoutDigest(value, digestKey) {
  const result = { ...value };
  delete result[digestKey];
  return result;
}

function sealLedger(payload) {
  const ledger = { ...payload, ledgerDigest: digestOf(payload) };
  return deepFreeze(ledger);
}

export function compileForgeObligationLedgerContract(taskContract) {
  return deepFreeze({
    taskContractId: taskContract.contractId,
    initialSourceFingerprint: taskContract.sourceFingerprint,
    definitions: definitionsFromTaskContract(taskContract),
  });
}

export function createForgeObligationLedger(taskContract) {
  const compiled = compileForgeObligationLedgerContract(taskContract);
  return sealLedger({
    schemaVersion: FORGE_OBLIGATION_LEDGER_SCHEMA_VERSION,
    ...(taskContract.developmentMode === 'direct' ? { developmentMode: 'direct' } : {}),
    ledgerType: FORGE_OBLIGATION_LEDGER_TYPE,
    taskContractId: compiled.taskContractId,
    initialSourceFingerprint: compiled.initialSourceFingerprint,
    sourceFingerprint: compiled.initialSourceFingerprint,
    generation: 0,
    definitions: compiled.definitions,
    history: [],
  });
}

function validateEvidenceRefs(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    fail('LEDGER_RECEIPT_INVALID', 'evidenceRefs must contain from 1 to 64 typed references.');
  }
  const seen = new Set();
  for (const item of value) {
    exactKeys(item, EVIDENCE_REF_KEYS, 'evidence reference');
    if (typeof item.kind !== 'string' || !SAFE_ID.test(item.kind)
      || typeof item.ref !== 'string' || item.ref.length < 1 || item.ref.length > 512
      || item.ref !== item.ref.trim() || /[\u0000-\u001f\u007f]/u.test(item.ref)
      || typeof item.digest !== 'string' || !DIGEST.test(item.digest)) {
      fail('LEDGER_RECEIPT_INVALID', 'Evidence references require a typed kind, bounded ref, and SHA-256 digest.');
    }
    const key = `${item.kind}\0${item.ref}`;
    if (seen.has(key)) fail('LEDGER_RECEIPT_INVALID', 'Evidence references must be unique.');
    seen.add(key);
  }
  return value.map((item) => ({ ...item }));
}

function validateReceipt(receipt, definition_, sourceFingerprint) {
  exactKeys(receipt, RECEIPT_KEYS, 'obligation receipt');
  if (typeof receipt.receiptType !== 'string'
    || !definition_.allowedReceiptKinds.includes(receipt.receiptType)) {
    fail('LEDGER_RECEIPT_KIND_FORBIDDEN', `Receipt kind cannot close ${definition_.id}.`);
  }
  if (typeof receipt.receiptId !== 'string' || !RECEIPT_ID.test(receipt.receiptId)
    || typeof receipt.receiptDigest !== 'string' || !DIGEST.test(receipt.receiptDigest)) {
    fail('LEDGER_RECEIPT_INVALID', 'Receipt identity and digest are required.');
  }
  if (receipt.obligationId !== definition_.id) {
    fail('LEDGER_RECEIPT_OBLIGATION_MISMATCH', 'Receipt obligation does not match the selected ledger entry.');
  }
  if (receipt.sourceFingerprint !== sourceFingerprint) {
    fail('LEDGER_RECEIPT_STALE_SOURCE', 'Receipt source fingerprint is stale.');
  }
  if (typeof receipt.issuer !== 'string' || !definition_.allowedIssuers.includes(receipt.issuer)) {
    fail('LEDGER_RECEIPT_ISSUER_FORBIDDEN', `Issuer cannot close ${definition_.id}.`);
  }
  const refs = validateEvidenceRefs(receipt.evidenceRefs);
  for (const requirement of definition_.evidenceRequirements) {
    const matching = refs.filter((item) => item.kind === requirement.kind);
    if (matching.length < requirement.minimum) {
      fail(
        'LEDGER_EVIDENCE_INCOMPLETE',
        `${definition_.id} requires at least ${requirement.minimum} ${requirement.kind} evidence reference(s).`,
      );
    }
  }
  if (definition_.category === 'required-verification-profile') {
    const expectedProfile = definition_.id.slice('verification:'.length);
    if (!refs.some((item) => item.kind === 'verification-profile' && item.ref === expectedProfile)) {
      fail('LEDGER_EVIDENCE_INCOMPLETE', `${definition_.id} requires evidence for its exact verification profile.`);
    }
  }
  const expectedDigest = digestOf(withoutDigest(receipt, 'receiptDigest'));
  if (receipt.receiptDigest !== expectedDigest) fail('LEDGER_RECEIPT_DIGEST_INVALID', 'Receipt digest is invalid.');
  return canonicalValue(receipt);
}

export function sealForgeObligationReceipt(input) {
  exactKeys(input, UNSIGNED_RECEIPT_KEYS, 'unsigned obligation receipt');
  const payload = canonicalValue(input);
  return deepFreeze({ ...payload, receiptDigest: digestOf(payload) });
}

function validateDefinition(value) {
  exactKeys(value, new Set([
    'id', 'category', 'sourceBound', 'allowedReceiptKinds', 'allowedIssuers', 'evidenceRequirements',
  ]), 'obligation definition');
  if (typeof value.id !== 'string' || !SAFE_ID.test(value.id)
    || typeof value.category !== 'string' || !SAFE_ID.test(value.category)
    || value.sourceBound !== true
    || !Array.isArray(value.allowedReceiptKinds) || value.allowedReceiptKinds.length < 1
    || !Array.isArray(value.allowedIssuers) || value.allowedIssuers.length < 1
    || !Array.isArray(value.evidenceRequirements) || value.evidenceRequirements.length < 1) {
    fail('LEDGER_DEFINITION_INVALID', 'Obligation definition is invalid.');
  }
  for (const requirement of value.evidenceRequirements) {
    exactKeys(requirement, new Set(['kind', 'minimum']), 'evidence requirement');
    if (typeof requirement.kind !== 'string' || !SAFE_ID.test(requirement.kind)
      || !Number.isSafeInteger(requirement.minimum) || requirement.minimum < 1 || requirement.minimum > 64) {
      fail('LEDGER_DEFINITION_INVALID', 'Evidence requirement is invalid.');
    }
  }
}

function replayLedger(ledger) {
  const definitions = new Map();
  for (const item of ledger.definitions) {
    validateDefinition(item);
    if (definitions.has(item.id)) fail('LEDGER_DEFINITION_CONFLICT', `Duplicate obligation: ${item.id}.`);
    definitions.set(item.id, item);
  }
  let sourceFingerprint = ledger.initialSourceFingerprint;
  let generation = 0;
  const receiptIds = new Set();
  const closedInGeneration = new Set();
  for (let index = 0; index < ledger.history.length; index += 1) {
    const event = ledger.history[index];
    if (!isPlainObject(event) || event.sequence !== index + 1) {
      fail('LEDGER_HISTORY_INVALID', 'Ledger event sequence is invalid.');
    }
    if (event.type === 'closure') {
      exactKeys(event, new Set([
        'sequence', 'type', 'generation', 'sourceFingerprint', 'obligationId', 'receipt',
      ]), 'closure event');
      const definition_ = definitions.get(event.obligationId);
      if (!definition_ || event.generation !== generation || event.sourceFingerprint !== sourceFingerprint) {
        fail('LEDGER_HISTORY_INVALID', 'Closure event does not match the active source generation.');
      }
      if (closedInGeneration.has(event.obligationId)) {
        fail('LEDGER_CLOSURE_CONFLICT', `Obligation already closed in this generation: ${event.obligationId}.`);
      }
      const receipt = validateReceipt(event.receipt, definition_, sourceFingerprint);
      if (receiptIds.has(receipt.receiptId)) fail('LEDGER_RECEIPT_DUPLICATE', 'Receipt id was already consumed.');
      receiptIds.add(receipt.receiptId);
      closedInGeneration.add(event.obligationId);
    } else if (event.type === 'source-mutation') {
      exactKeys(event, new Set([
        'sequence', 'type', 'generation', 'previousSourceFingerprint', 'sourceFingerprint', 'mutationId',
      ]), 'source mutation event');
      if (event.previousSourceFingerprint !== sourceFingerprint
        || event.sourceFingerprint === sourceFingerprint || !SHA256.test(event.sourceFingerprint)
        || event.generation !== generation + 1
        || typeof event.mutationId !== 'string' || !RECEIPT_ID.test(event.mutationId)) {
        fail('LEDGER_HISTORY_INVALID', 'Source mutation event is invalid.');
      }
      generation = event.generation;
      sourceFingerprint = event.sourceFingerprint;
      closedInGeneration.clear();
    } else fail('LEDGER_HISTORY_INVALID', `Unknown ledger event type: ${String(event.type)}.`);
  }
  if (ledger.sourceFingerprint !== sourceFingerprint || ledger.generation !== generation) {
    fail('LEDGER_HISTORY_INVALID', 'Ledger head does not match replayed history.');
  }
  return { definitions, receiptIds, closedInGeneration };
}

function declaredGovernanceDefinitions(definitions, taskContract, acceptanceContract, history) {
  if (acceptanceContract === undefined) return definitions;
  if (acceptanceContract?.contractId !== taskContract.contractId
    || !Array.isArray(acceptanceContract.requiredObligations)) {
    fail('LEDGER_CONTRACT_MISMATCH', 'Acceptance evidence declarations do not identify the expected task contract.');
  }
  // A governance-only contract can explicitly classify a historical test-named
  // obligation as governance. The signed declaration, not its name, is authority.
  if (!taskContract.requiredVerificationProfiles.includes('governance')
    || taskContract.requiredVerificationProfiles.some(profile => profile !== 'governance')) return definitions;
  const declared = new Set(acceptanceContract.requiredObligations
    .filter(item => item.evidenceType === 'governance' && item.profile === null)
    .map(item => `contract:${item.id}`));
  return definitions.map(item => {
    if (!declared.has(item.id) || item.category !== 'task-contract'
      || item.allowedReceiptKinds.length !== 1 || item.allowedReceiptKinds[0] !== RECEIPT_KINDS.verification
      || item.allowedIssuers.length !== 1 || item.allowedIssuers[0] !== ISSUERS.verification
      || history.some(event => event.type === 'closure' && event.obligationId === item.id
        && event.receipt.receiptType !== RECEIPT_KINDS.governance)) return item;
    return definition(item.id, item.category, [RECEIPT_KINDS.governance],
      [ISSUERS.governance], item.evidenceRequirements);
  });
}

function validateLedgerDocument(ledger, expectedTaskContract, acceptanceContract) {
  exactKeys(ledger, new Set([...LEDGER_KEYS, ...(Object.hasOwn(ledger, 'developmentMode') ? ['developmentMode'] : [])]), 'obligation ledger');
  if (Object.hasOwn(ledger, 'developmentMode') && (ledger.developmentMode !== 'direct'
    || (expectedTaskContract !== undefined && expectedTaskContract.developmentMode !== 'direct'))) {
    fail('LEDGER_CONTRACT_INVALID', 'Direct ledger must retain its direct task authority.');
  }
  if (ledger.schemaVersion !== FORGE_OBLIGATION_LEDGER_SCHEMA_VERSION
    || ledger.ledgerType !== FORGE_OBLIGATION_LEDGER_TYPE
    || typeof ledger.taskContractId !== 'string' || !SHA256.test(ledger.taskContractId)
    || typeof ledger.initialSourceFingerprint !== 'string' || !SHA256.test(ledger.initialSourceFingerprint)
    || typeof ledger.sourceFingerprint !== 'string' || !SHA256.test(ledger.sourceFingerprint)
    || !Number.isSafeInteger(ledger.generation) || ledger.generation < 0
    || !Array.isArray(ledger.definitions) || (ledger.developmentMode !== 'direct' && ledger.definitions.length < 1)
    || !Array.isArray(ledger.history)
    || typeof ledger.ledgerDigest !== 'string' || !DIGEST.test(ledger.ledgerDigest)) {
    fail('LEDGER_DOCUMENT_INVALID', 'Ledger document is incomplete or invalid.');
  }
  if (ledger.ledgerDigest !== digestOf(withoutDigest(ledger, 'ledgerDigest'))) {
    fail('LEDGER_DIGEST_INVALID', 'Ledger digest verification failed.');
  }
  if (expectedTaskContract !== undefined) {
    const compiled = compileForgeObligationLedgerContract(expectedTaskContract);
    // Preserve the exact historical definition and its receipts on restore;
    // newly compiled ledgers always require verification for this obligation.
    const legacyDefinitions = compiled.definitions.map(item => item.id === 'contract:idempotent-workflow-callbacks'
      ? definition(item.id, 'task-contract', [RECEIPT_KINDS.governance],
        [ISSUERS.governance], requirements(['evidence', 1])) : item);
    const permittedDefinitions = [compiled.definitions, legacyDefinitions];
    if (acceptanceContract !== undefined) {
      if (acceptanceContract.candidate?.source?.fingerprint !== ledger.sourceFingerprint) {
        fail('LEDGER_CONTRACT_MISMATCH', 'Acceptance evidence declarations target another ledger source.');
      }
      permittedDefinitions.push(...permittedDefinitions.map(definitions => declaredGovernanceDefinitions(
        definitions, expectedTaskContract, acceptanceContract, ledger.history)));
    }
    if (ledger.taskContractId !== compiled.taskContractId
      || ledger.initialSourceFingerprint !== compiled.initialSourceFingerprint
      || !permittedDefinitions.some(definitions => canonicalForgeObligationJson(ledger.definitions)
        === canonicalForgeObligationJson(definitions))) {
      fail('LEDGER_CONTRACT_MISMATCH', 'Restored ledger does not match the expected task contract.');
    }
  }
  replayLedger(ledger);
  return ledger;
}

export function applyForgeObligationReceipt(ledger, receipt) {
  validateLedgerDocument(ledger);
  const replay = replayLedger(ledger);
  const definition_ = replay.definitions.get(receipt?.obligationId);
  if (!definition_) fail('LEDGER_OBLIGATION_UNKNOWN', `Unknown obligation: ${String(receipt?.obligationId)}.`);
  if (replay.receiptIds.has(receipt.receiptId)) fail('LEDGER_RECEIPT_DUPLICATE', 'Receipt id was already consumed.');
  if (replay.closedInGeneration.has(definition_.id)) {
    fail('LEDGER_CLOSURE_CONFLICT', `Obligation already has a current closure: ${definition_.id}.`);
  }
  const validatedReceipt = validateReceipt(receipt, definition_, ledger.sourceFingerprint);
  return sealLedger({
    ...withoutDigest(ledger, 'ledgerDigest'),
    history: [...ledger.history, {
      sequence: ledger.history.length + 1,
      type: 'closure',
      generation: ledger.generation,
      sourceFingerprint: ledger.sourceFingerprint,
      obligationId: definition_.id,
      receipt: validatedReceipt,
    }],
  });
}

export function advanceForgeObligationLedgerSource(ledger, { sourceFingerprint, mutationId }) {
  validateLedgerDocument(ledger);
  if (typeof sourceFingerprint !== 'string' || !SHA256.test(sourceFingerprint)
    || sourceFingerprint === ledger.sourceFingerprint) {
    fail('LEDGER_SOURCE_INVALID', 'A source mutation requires a different lowercase SHA-256 fingerprint.');
  }
  if (typeof mutationId !== 'string' || !RECEIPT_ID.test(mutationId)) {
    fail('LEDGER_SOURCE_INVALID', 'A source mutation requires a stable mutation id.');
  }
  return sealLedger({
    ...withoutDigest(ledger, 'ledgerDigest'),
    sourceFingerprint,
    generation: ledger.generation + 1,
    history: [...ledger.history, {
      sequence: ledger.history.length + 1,
      type: 'source-mutation',
      generation: ledger.generation + 1,
      previousSourceFingerprint: ledger.sourceFingerprint,
      sourceFingerprint,
      mutationId,
    }],
  });
}

export function summarizeForgeObligationLedger(ledger) {
  validateLedgerDocument(ledger);
  const currentClosures = new Map();
  const historicalClosures = new Map();
  for (const event of ledger.history) {
    if (event.type !== 'closure') continue;
    if (!historicalClosures.has(event.obligationId)) historicalClosures.set(event.obligationId, []);
    historicalClosures.get(event.obligationId).push(event.receipt.receiptId);
    if (event.sourceFingerprint === ledger.sourceFingerprint && event.generation === ledger.generation) {
      currentClosures.set(event.obligationId, event.receipt.receiptId);
    }
  }
  const closed = [];
  const stale = [];
  const open = [];
  for (const definition_ of ledger.definitions) {
    if (currentClosures.has(definition_.id)) {
      closed.push({ id: definition_.id, receiptId: currentClosures.get(definition_.id) });
    } else {
      open.push(definition_.id);
      if (historicalClosures.has(definition_.id)) {
        stale.push({ id: definition_.id, historicalReceiptIds: historicalClosures.get(definition_.id) });
      }
    }
  }
  const payload = {
    schemaVersion: FORGE_OBLIGATION_LEDGER_SCHEMA_VERSION,
    summaryType: 'forge-obligation-ledger-summary/v1',
    taskContractId: ledger.taskContractId,
    sourceFingerprint: ledger.sourceFingerprint,
    generation: ledger.generation,
    ledgerDigest: ledger.ledgerDigest,
    counts: {
      total: ledger.definitions.length,
      open: open.length,
      closed: closed.length,
      stale: stale.length,
    },
    open,
    closed,
    stale,
  };
  return deepFreeze({ ...payload, summaryDigest: digestOf(payload) });
}

export function serializeForgeObligationLedger(ledger) {
  validateLedgerDocument(ledger);
  return `${canonicalForgeObligationJson(ledger)}\n`;
}

export function restoreForgeObligationLedger(serialized, expectedTaskContract, acceptanceContract) {
  if (typeof serialized !== 'string' || serialized.length < 2 || serialized.length > 16 * 1024 * 1024) {
    fail('LEDGER_SERIALIZED_INVALID', 'Serialized ledger must be bounded JSON text.');
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    fail('LEDGER_SERIALIZED_INVALID', 'Serialized ledger is not valid JSON.');
  }
  validateLedgerDocument(parsed, expectedTaskContract, acceptanceContract);
  if (expectedTaskContract !== undefined && acceptanceContract !== undefined) {
    const definitions = declaredGovernanceDefinitions(parsed.definitions, expectedTaskContract,
      acceptanceContract, parsed.history);
    if (canonicalForgeObligationJson(definitions) !== canonicalForgeObligationJson(parsed.definitions)) {
      return sealLedger({ ...withoutDigest(parsed, 'ledgerDigest'), definitions });
    }
  }
  return deepFreeze(canonicalValue(parsed));
}

export const FORGE_OBLIGATION_RECEIPT_KINDS = RECEIPT_KINDS;
export const FORGE_OBLIGATION_ISSUERS = ISSUERS;
