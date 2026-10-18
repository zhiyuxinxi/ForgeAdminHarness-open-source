import crypto from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
} from 'node:fs/promises';
import path from 'node:path';

import { digestDirectUserTextContent } from './forge-execution-context.mjs';
import { validateSourceTransition } from './taskspace-policy.mjs';
import {
  canonicalStringify,
  compileForgeTaskExecutionContract,
  validateForgeTaskExecutionContract,
} from './forge-task-execution-contract.mjs';

export const PRODUCTION_TASK_GRANT_RECORD_TYPE = 'forge-production-task-grant/v1';
export const PRODUCTION_TASK_GRANT_RECEIPT_TYPE = 'forge-production-task-grant-receipt/v1';

const ISSUER = 'forge-phase-controller';
const ROUTE = 'session.prompt';
const CASE_FAMILY = 'maintenance';
const DEFAULT_ACTION_CEILING = 'workspace-write';
const ACTION_CEILINGS = Object.freeze(['workspace-write', 'git-checkpoint', 'release']);
const ACTION_CEILING_SET = new Set(ACTION_CEILINGS);
const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 900;

const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const PROJECT_SLUG_PATTERN = TASK_ID_PATTERN;
const ACTOR_USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTOR_USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const DSH_SESSION_ID_PATTERN = /^[^\0\r\n]{1,1024}$/u;
const RPC_ID_PATTERN = /^[^\0\r\n]{1,256}$/u;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const SPEC_KEYS = Object.freeze([
  'schemaVersion',
  'projectSlug',
  'taskId',
  'actorUserId',
  'actorUsername',
  'conversationId',
  'dshSessionId',
  'promptText',
  'sourceCommit',
  'workspaceFingerprint',
  'ownedPaths',
  'taskProfiles',
  'ttlSeconds',
]);
const SPEC_KEYS_WITH_ACTION_CEILING = Object.freeze([...SPEC_KEYS, 'actionCeiling']);

const GRANT_KEYS = Object.freeze([
  'schemaVersion',
  'recordType',
  'grantId',
  'issuer',
  'projectSlug',
  'taskId',
  'actorUserId',
  'actorUsername',
  'conversationId',
  'dshSessionId',
  'route',
  'promptTextDigest',
  'sourceCommit',
  'workspaceFingerprint',
  'caseFamily',
  'actionCeiling',
  'ownedPaths',
  'taskProfiles',
  'taskContract',
  'issuedAt',
  'expiresAt',
  'claim',
  'grantDigest',
  'recordDigest',
]);

const IMMUTABLE_GRANT_KEYS = Object.freeze([
  'schemaVersion',
  'recordType',
  'grantId',
  'issuer',
  'projectSlug',
  'taskId',
  'actorUserId',
  'actorUsername',
  'conversationId',
  'dshSessionId',
  'route',
  'promptTextDigest',
  'sourceCommit',
  'workspaceFingerprint',
  'caseFamily',
  'actionCeiling',
  'ownedPaths',
  'taskProfiles',
  'taskContract',
  'issuedAt',
  'expiresAt',
]);

const CLAIM_KEYS = Object.freeze([
  'claimId',
  'rpcId',
  'productionAuthorityId',
  'productionAuthorityDigest',
  'claimedAt',
]);

export class ProductionTaskGrantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductionTaskGrantError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionTaskGrantError(code, message);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail('PRODUCTION_TASK_GRANT_SCHEMA_INVALID', `${label} has unsupported or missing fields.`);
  }
}

function requiredString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('PRODUCTION_TASK_GRANT_SCHEMA_INVALID', `${label} is invalid.`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string') {
    fail('PRODUCTION_TASK_GRANT_SCHEMA_INVALID', `${label} is invalid.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail('PRODUCTION_TASK_GRANT_SCHEMA_INVALID', `${label} must be a canonical UTC timestamp.`);
  }
  return milliseconds;
}

function nowMilliseconds(now = Date.now()) {
  const milliseconds = now instanceof Date ? now.getTime() : now;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    fail('PRODUCTION_TASK_GRANT_TIME_INVALID', 'now must be a non-negative integer epoch millisecond or valid Date.');
  }
  return milliseconds;
}

function canonicalDigest(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

function immutableGrantPayload(record) {
  return Object.fromEntries(IMMUTABLE_GRANT_KEYS.map((key) => [key, record[key]]));
}

function recordPayload(record) {
  const { recordDigest: _ignored, ...payload } = record;
  return payload;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function frozenCopy(value) {
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function arraysEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function validateClaim(claim, issuedAtMs, expiresAtMs) {
  exactKeys(claim, CLAIM_KEYS, 'production task grant claim');
  requiredString(claim.claimId, UUID_V4_PATTERN, 'claim.claimId');
  requiredString(claim.rpcId, RPC_ID_PATTERN, 'claim.rpcId');
  requiredString(claim.productionAuthorityId, UUID_V4_PATTERN, 'claim.productionAuthorityId');
  requiredString(claim.productionAuthorityDigest, SHA256_PATTERN, 'claim.productionAuthorityDigest');
  const claimedAtMs = canonicalTimestamp(claim.claimedAt, 'claim.claimedAt');
  if (claimedAtMs < issuedAtMs || claimedAtMs >= expiresAtMs) {
    fail('PRODUCTION_TASK_GRANT_CLAIM_INVALID', 'claim.claimedAt must be inside the grant time window.');
  }
  return claim;
}

function validateOutputPath(file, label) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')
    || Buffer.byteLength(file, 'utf8') > MAX_PATH_BYTES) {
    fail('PRODUCTION_TASK_GRANT_PATH_INVALID', `${label} must be a bounded absolute path.`);
  }
  return path.resolve(file);
}

async function readBoundedJson(file, label) {
  const resolved = validateOutputPath(file, `${label} file`);
  const information = await lstat(resolved).catch((error) => {
    if (error?.code === 'ENOENT') {
      fail('PRODUCTION_TASK_GRANT_PATH_INVALID', `${label} must exist.`);
    }
    throw error;
  });
  if (!information.isFile() || information.isSymbolicLink()
    || information.size < 1 || information.size > MAX_SPEC_BYTES) {
    fail('PRODUCTION_TASK_GRANT_PATH_INVALID', `${label} must be a bounded ordinary file.`);
  }
  try {
    return JSON.parse(await readFile(resolved, 'utf8'));
  } catch (error) {
    if (error instanceof ProductionTaskGrantError) throw error;
    fail('PRODUCTION_TASK_GRANT_SCHEMA_INVALID', `${label} must contain valid JSON.`);
  }
}

async function assertAbsent(file, label) {
  const information = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (information !== null) {
    fail('PRODUCTION_TASK_GRANT_OUTPUT_EXISTS', `${label} already exists and will not be overwritten.`);
  }
}

function fileIdentity(information) {
  return {
    dev: information.dev,
    ino: information.ino,
    mode: information.mode,
    nlink: information.nlink,
    size: information.size,
    mtimeMs: information.mtimeMs,
    ctimeMs: information.ctimeMs,
  };
}

function sameFileIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function readOptionalGrantRecord(file) {
  const resolved = validateOutputPath(file, 'grantFile');
  const linkInformation = await lstat(resolved).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (linkInformation === null) return null;
  if (!linkInformation.isFile() || linkInformation.isSymbolicLink()
    || linkInformation.nlink !== 1
    || linkInformation.size < 1 || linkInformation.size > MAX_SPEC_BYTES) {
    fail(
      'PRODUCTION_TASK_GRANT_PATH_INVALID',
      'Existing production task grant must be a bounded, single-link ordinary file.',
    );
  }

  let handle;
  try {
    handle = await open(resolved, 'r');
    const openedInformation = await handle.stat();
    if (!openedInformation.isFile() || openedInformation.nlink !== 1
      || !sameFileIdentity(fileIdentity(linkInformation), fileIdentity(openedInformation))) {
      fail(
        'PRODUCTION_TASK_GRANT_PATH_INVALID',
        'Existing production task grant changed while it was opened.',
      );
    }
    const text = await handle.readFile('utf8');
    const finalInformation = await handle.stat();
    if (!sameFileIdentity(fileIdentity(openedInformation), fileIdentity(finalInformation))) {
      fail(
        'PRODUCTION_TASK_GRANT_PATH_INVALID',
        'Existing production task grant changed while it was read.',
      );
    }
    return {
      record: JSON.parse(text),
      contentDigest: crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
    };
  } catch (error) {
    if (error instanceof ProductionTaskGrantError) throw error;
    if (error instanceof SyntaxError) {
      fail('PRODUCTION_TASK_GRANT_SCHEMA_INVALID', 'Existing production task grant must contain valid JSON.');
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function protectedHistoryDirectory(stateRoot) {
  const historyDirectory = path.join(stateRoot, 'production-task-grants-history');
  await mkdir(historyDirectory, { recursive: true, mode: 0o700 });
  const information = await lstat(historyDirectory);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    fail(
      'PRODUCTION_TASK_GRANT_PATH_INVALID',
      'Production task grant history must be an ordinary directory.',
    );
  }
  await chmod(historyDirectory, 0o700);
  return historyDirectory;
}

async function writeExclusiveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      fail('PRODUCTION_TASK_GRANT_OUTPUT_EXISTS', 'Production task grant output already exists.');
    }
    throw error;
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateSpec(spec, independentReview, verificationScope, focusedBackendVerification, ordinaryFinalVerification, backendTestBindings, dualReview, roleGrantDecisions, semanticResources, developmentMode) {
  exactKeys(
    spec,
    Object.hasOwn(spec ?? {}, 'actionCeiling') ? SPEC_KEYS_WITH_ACTION_CEILING : SPEC_KEYS,
    'production task grant specification',
  );
  if (spec.schemaVersion !== 1) {
    fail('PRODUCTION_TASK_GRANT_SCHEMA_INVALID', 'spec.schemaVersion must equal 1.');
  }
  requiredString(spec.projectSlug, PROJECT_SLUG_PATTERN, 'spec.projectSlug');
  requiredString(spec.taskId, TASK_ID_PATTERN, 'spec.taskId');
  requiredString(spec.actorUserId, ACTOR_USER_ID_PATTERN, 'spec.actorUserId');
  requiredString(spec.actorUsername, ACTOR_USERNAME_PATTERN, 'spec.actorUsername');
  requiredString(spec.conversationId, CONVERSATION_ID_PATTERN, 'spec.conversationId');
  requiredString(spec.dshSessionId, DSH_SESSION_ID_PATTERN, 'spec.dshSessionId');
  requiredString(spec.sourceCommit, SOURCE_COMMIT_PATTERN, 'spec.sourceCommit');
  requiredString(spec.workspaceFingerprint, SHA256_PATTERN, 'spec.workspaceFingerprint');
  if (!Number.isSafeInteger(spec.ttlSeconds)
    || spec.ttlSeconds < MIN_TTL_SECONDS || spec.ttlSeconds > MAX_TTL_SECONDS) {
    fail(
      'PRODUCTION_TASK_GRANT_SCHEMA_INVALID',
      `spec.ttlSeconds must be an integer from ${MIN_TTL_SECONDS} through ${MAX_TTL_SECONDS}.`,
    );
  }
  if (typeof spec.promptText !== 'string') {
    fail('PRODUCTION_TASK_GRANT_SCHEMA_INVALID', 'spec.promptText must be a string.');
  }
  if (!Array.isArray(spec.ownedPaths) || spec.ownedPaths.length < 1
    || !Array.isArray(spec.taskProfiles) || spec.taskProfiles.length < 1) {
    fail('PRODUCTION_TASK_GRANT_SCHEMA_INVALID', 'spec ownedPaths and taskProfiles must be non-empty arrays.');
  }

  const actionCeiling = Object.hasOwn(spec, 'actionCeiling')
    ? spec.actionCeiling
    : DEFAULT_ACTION_CEILING;
  if (!ACTION_CEILING_SET.has(actionCeiling)) {
    fail(
      'PRODUCTION_TASK_GRANT_SCHEMA_INVALID',
      `spec.actionCeiling must be one of: ${ACTION_CEILINGS.join(', ')}.`,
    );
  }

  let taskContract;
  try {
    taskContract = compileForgeTaskExecutionContract({
      prompt: spec.promptText,
      ownedPaths: spec.ownedPaths,
      actionCeiling,
      taskProfiles: spec.taskProfiles,
    }, { independentReview, verificationScope, focusedBackendVerification, ordinaryFinalVerification, backendTestBindings, dualReview, roleGrantDecisions, semanticResources, developmentMode });
  } catch (error) {
    fail(
      'PRODUCTION_TASK_GRANT_SCHEMA_INVALID',
      `spec cannot compile a reviewed task contract (${error?.code ?? 'CONTRACT_INVALID'}).`,
    );
  }
  if (!arraysEqual(spec.ownedPaths, taskContract.ownedPaths)
    || !arraysEqual(spec.taskProfiles, taskContract.taskProfiles)) {
    fail(
      'PRODUCTION_TASK_GRANT_SCOPE_INVALID',
      'spec ownedPaths and taskProfiles must already equal the complete canonical task contract scope.',
    );
  }
  return { spec, actionCeiling, taskContract };
}

export function productionTaskGrantDigest(record) {
  return canonicalDigest(immutableGrantPayload(record));
}

export function productionTaskGrantRecordDigest(record) {
  return canonicalDigest(recordPayload(record));
}

export function productionTaskGrantFile(stateRoot, taskId) {
  const root = validateOutputPath(stateRoot, 'stateRoot');
  requiredString(taskId, TASK_ID_PATTERN, 'taskId');
  return path.join(root, 'production-task-grants', `${taskId}.json`);
}

export function validateProductionTaskGrantRecord(record, now, { allowExpired = false } = {}) {
  exactKeys(record, GRANT_KEYS, 'production task grant');
  if (record.schemaVersion !== 1 || record.recordType !== PRODUCTION_TASK_GRANT_RECORD_TYPE
    || record.issuer !== ISSUER || record.route !== ROUTE || record.caseFamily !== CASE_FAMILY
    || !ACTION_CEILING_SET.has(record.actionCeiling)) {
    fail('PRODUCTION_TASK_GRANT_SCHEMA_INVALID', 'Production task grant constants are invalid.');
  }
  requiredString(record.grantId, UUID_V4_PATTERN, 'grantId');
  requiredString(record.projectSlug, PROJECT_SLUG_PATTERN, 'projectSlug');
  requiredString(record.taskId, TASK_ID_PATTERN, 'taskId');
  requiredString(record.actorUserId, ACTOR_USER_ID_PATTERN, 'actorUserId');
  requiredString(record.actorUsername, ACTOR_USERNAME_PATTERN, 'actorUsername');
  requiredString(record.conversationId, CONVERSATION_ID_PATTERN, 'conversationId');
  requiredString(record.dshSessionId, DSH_SESSION_ID_PATTERN, 'dshSessionId');
  requiredString(record.promptTextDigest, SHA256_PATTERN, 'promptTextDigest');
  requiredString(record.sourceCommit, SOURCE_COMMIT_PATTERN, 'sourceCommit');
  requiredString(record.workspaceFingerprint, SHA256_PATTERN, 'workspaceFingerprint');
  requiredString(record.grantDigest, SHA256_PATTERN, 'grantDigest');
  requiredString(record.recordDigest, SHA256_PATTERN, 'recordDigest');

  let taskContract;
  try {
    taskContract = validateForgeTaskExecutionContract(record.taskContract);
  } catch (error) {
    fail(
      'PRODUCTION_TASK_GRANT_CONTRACT_INVALID',
      `Production task grant contract is invalid (${error?.code ?? 'CONTRACT_INVALID'}).`,
    );
  }
  if (taskContract.actionCeiling !== record.actionCeiling
    || !arraysEqual(record.ownedPaths, taskContract.ownedPaths)
    || !arraysEqual(record.taskProfiles, taskContract.taskProfiles)
    || record.ownedPaths.length < 1 || record.taskProfiles.length < 1) {
    fail('PRODUCTION_TASK_GRANT_SCOPE_INVALID', 'Production task grant scope does not match its task contract.');
  }

  const issuedAtMs = canonicalTimestamp(record.issuedAt, 'issuedAt');
  const expiresAtMs = canonicalTimestamp(record.expiresAt, 'expiresAt');
  const ttlMs = expiresAtMs - issuedAtMs;
  if (ttlMs < MIN_TTL_SECONDS * 1000 || ttlMs > MAX_TTL_SECONDS * 1000
    || ttlMs % 1000 !== 0) {
    fail('PRODUCTION_TASK_GRANT_TIME_INVALID', 'Production task grant lifetime is outside the reviewed window.');
  }
  if (record.claim !== null) validateClaim(record.claim, issuedAtMs, expiresAtMs);
  if (record.grantDigest !== productionTaskGrantDigest(record)
    || record.recordDigest !== productionTaskGrantRecordDigest(record)) {
    fail('PRODUCTION_TASK_GRANT_INTEGRITY_INVALID', 'Production task grant digest validation failed.');
  }
  const observedAtMs = nowMilliseconds(now);
  if (observedAtMs < issuedAtMs) {
    fail('PRODUCTION_TASK_GRANT_NOT_YET_VALID', 'Production task grant is not yet valid.');
  }
  const expired = observedAtMs >= expiresAtMs;
  if (expired && !allowExpired) {
    fail('PRODUCTION_TASK_GRANT_EXPIRED', 'Production task grant expired.');
  }
  return { grant: frozenCopy(record), expired };
}

export function validateProductionTaskGrant(record, now = Date.now()) {
  return validateProductionTaskGrantRecord(record, now).grant;
}

export function sealProductionTaskGrantClaim(record, claim, now = Date.now()) {
  const current = validateProductionTaskGrant(record, now);
  if (current.claim !== null) {
    fail('PRODUCTION_TASK_GRANT_ALREADY_CLAIMED', 'Production task grant has already been claimed.');
  }
  const issuedAtMs = Date.parse(current.issuedAt);
  const expiresAtMs = Date.parse(current.expiresAt);
  validateClaim(claim, issuedAtMs, expiresAtMs);
  const claimed = {
    ...JSON.parse(JSON.stringify(current)),
    claim: { ...claim },
    recordDigest: '',
  };
  claimed.recordDigest = productionTaskGrantRecordDigest(claimed);
  return validateProductionTaskGrant(claimed, now);
}

export function createProductionTaskGrant({ spec, now = Date.now(), continuationContract, independentReview = 'required', verificationScope = 'legacy', focusedBackendVerification = false, ordinaryFinalVerification = true, backendTestBindings, dualReview, roleGrantDecisions, semanticResources, developmentMode }) {
  const observedAtMs = nowMilliseconds(now);
  const validated = validateSpec(spec, independentReview, verificationScope, focusedBackendVerification, ordinaryFinalVerification, backendTestBindings, dualReview, roleGrantDecisions, semanticResources, developmentMode);
  // Only the protected issuer supplies this separate argument. It is not a
  // field accepted by the public grant specification.
  if (continuationContract !== undefined) {
    const continued = validateForgeTaskExecutionContract(continuationContract);
    const unchanged = canonicalStringify(continued.semanticResources ?? null)
      === canonicalStringify(validated.taskContract.semanticResources ?? null) && Object.keys(validated.taskContract)
      .filter((key) => !['contractId', 'sourceFingerprint'].includes(key))
      .every((key) => canonicalStringify(continued[key]) === canonicalStringify(validated.taskContract[key]));
    if (!unchanged) {
      fail('PRODUCTION_TASK_GRANT_SCOPE_INVALID', 'Continuation contract changes the current task requirements.');
    }
    validated.taskContract = continued;
  }
  const issuedAt = new Date(observedAtMs).toISOString();
  const expiresAt = new Date(observedAtMs + validated.spec.ttlSeconds * 1000).toISOString();
  const promptTextDigest = digestDirectUserTextContent([{
    type: 'text',
    text: validated.spec.promptText,
  }]);
  const grant = {
    schemaVersion: 1,
    recordType: PRODUCTION_TASK_GRANT_RECORD_TYPE,
    grantId: crypto.randomUUID(),
    issuer: ISSUER,
    projectSlug: validated.spec.projectSlug,
    taskId: validated.spec.taskId,
    actorUserId: validated.spec.actorUserId,
    actorUsername: validated.spec.actorUsername,
    conversationId: validated.spec.conversationId,
    dshSessionId: validated.spec.dshSessionId,
    route: ROUTE,
    promptTextDigest,
    sourceCommit: validated.spec.sourceCommit,
    workspaceFingerprint: validated.spec.workspaceFingerprint,
    caseFamily: CASE_FAMILY,
    actionCeiling: validated.actionCeiling,
    ownedPaths: [...validated.taskContract.ownedPaths],
    taskProfiles: [...validated.taskContract.taskProfiles],
    taskContract: JSON.parse(JSON.stringify(validated.taskContract)),
    issuedAt,
    expiresAt,
    claim: null,
    grantDigest: '',
    recordDigest: '',
  };
  grant.grantDigest = productionTaskGrantDigest(grant);
  grant.recordDigest = productionTaskGrantRecordDigest(grant);
  const validatedGrant = validateProductionTaskGrant(grant, observedAtMs);
  const receipt = {
    schemaVersion: 1,
    recordType: PRODUCTION_TASK_GRANT_RECEIPT_TYPE,
    issuer: ISSUER,
    grantId: validatedGrant.grantId,
    grantDigest: validatedGrant.grantDigest,
    contractId: validatedGrant.taskContract.contractId,
    promptTextDigest: validatedGrant.promptTextDigest,
    source: {
      sourceCommit: validatedGrant.sourceCommit,
      workspaceFingerprint: validatedGrant.workspaceFingerprint,
    },
    expiresAt: validatedGrant.expiresAt,
    scope: {
      projectSlug: validatedGrant.projectSlug,
      taskId: validatedGrant.taskId,
      actorUserId: validatedGrant.actorUserId,
      actorUsername: validatedGrant.actorUsername,
      conversationId: validatedGrant.conversationId,
      dshSessionId: validatedGrant.dshSessionId,
      route: validatedGrant.route,
      caseFamily: validatedGrant.caseFamily,
      actionCeiling: validatedGrant.actionCeiling,
      ownedPaths: [...validatedGrant.ownedPaths],
      taskProfiles: [...validatedGrant.taskProfiles],
    },
    receiptDigest: '',
  };
  receipt.receiptDigest = canonicalDigest((({ receiptDigest: _ignored, ...payload }) => payload)(receipt));
  return frozenCopy({ grant: validatedGrant, receipt });
}

async function inspectRotatableGrant(grantFile, spec, observedAtMs) {
  const existing = await readOptionalGrantRecord(grantFile);
  if (existing === null) return null;
  const validated = validateProductionTaskGrantRecord(
    existing.record,
    observedAtMs,
    { allowExpired: true },
  );
  if (validated.grant.projectSlug !== spec.projectSlug
    || validated.grant.taskId !== spec.taskId) {
    fail(
      'PRODUCTION_TASK_GRANT_IDENTITY_MISMATCH',
      'Existing production task grant does not match the requested project and task.',
    );
  }
  if (validated.grant.claim === null && !validated.expired) {
    fail(
      'PRODUCTION_TASK_GRANT_OUTPUT_EXISTS',
      'An active unclaimed production task grant already exists.',
    );
  }
  return {
    ...existing,
    grant: validated.grant,
  };
}

async function archiveRotatableGrant(grantFile, inspected) {
  const current = await readOptionalGrantRecord(grantFile);
  if (current === null || current.contentDigest !== inspected.contentDigest) {
    fail(
      'PRODUCTION_TASK_GRANT_OUTPUT_EXISTS',
      'Existing production task grant changed before rotation.',
    );
  }
  const stateRoot = path.dirname(path.dirname(grantFile));
  const historyDirectory = await protectedHistoryDirectory(stateRoot);
  const historyFile = path.join(
    historyDirectory,
    `${inspected.grant.taskId}.${inspected.grant.grantId}.${inspected.grant.recordDigest}.json`,
  );
  await assertAbsent(historyFile, 'production task grant history record');
  await rename(grantFile, historyFile);
  await chmod(historyFile, 0o600);

  const archived = await readOptionalGrantRecord(historyFile);
  if (archived === null || archived.contentDigest !== inspected.contentDigest) {
    fail(
      'PRODUCTION_TASK_GRANT_INTEGRITY_INVALID',
      'Archived production task grant does not match the validated record.',
    );
  }
  return historyFile;
}

export async function issueProductionTaskGrant({
  specFile,
  grantFile,
  receiptFile,
  now = Date.now(),
}) {
  const observedAtMs = nowMilliseconds(now);
  const resolvedSpecFile = validateOutputPath(specFile, 'specFile');
  const resolvedGrantFile = validateOutputPath(grantFile, 'grantFile');
  const resolvedReceiptFile = validateOutputPath(receiptFile, 'receiptFile');
  if (new Set([resolvedSpecFile, resolvedGrantFile, resolvedReceiptFile]).size !== 3) {
    fail('PRODUCTION_TASK_GRANT_PATH_INVALID', 'specFile, grantFile, and receiptFile must be different paths.');
  }
  const spec = await readBoundedJson(resolvedSpecFile, 'grant specification');
  const issued = createProductionTaskGrant({ spec, now: observedAtMs });

  const rotatableGrant = await inspectRotatableGrant(resolvedGrantFile, spec, observedAtMs);
  await assertAbsent(resolvedReceiptFile, 'receiptFile');
  if (rotatableGrant !== null) {
    await archiveRotatableGrant(resolvedGrantFile, rotatableGrant);
  }
  await writeExclusiveJson(resolvedGrantFile, issued.grant);
  await writeExclusiveJson(resolvedReceiptFile, issued.receipt);
  return issued;
}

// Used only by the trusted service after rechecking the active task and scope.
export function rebindProductionTaskGrantAfterIntegration(current, source, now = Date.now(), { sourceTransition } = {}) {
  const grant = validateProductionTaskGrantRecord(current, now, { allowExpired: true }).grant;
  let transition;
  try { transition = validateSourceTransition(sourceTransition); } catch { /* Reject below. */ }
  if (!['git-checkpoint', 'release'].includes(grant.actionCeiling) || grant.claim === null || transition?.phase !== 'integrated'
    || transition.from.head !== grant.sourceCommit || transition.to.head !== source.head
    || transition.from.head === transition.to.head || transition.to.fingerprint !== source.fingerprint
    || !['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
      .every((key) => transition.task[key] === grant[key])
    || transition.sourceAuthority.contractId !== grant.taskContract.contractId
    || transition.sourceAuthority.actionCeiling !== grant.actionCeiling
    || transition.sourceAuthority.productionAuthorityDigest !== grant.claim.productionAuthorityDigest
    || transition.sourceAuthority.controllerGrantDigest !== grant.grantDigest) {
    fail('PRODUCTION_TASK_RENEWAL_DENIED', 'Integration rebind requires the exact claimed checkpoint or release transition.');
  }
  return replacementSourceGrant(grant, source, now);
}

function replacementSourceGrant(grant, source, now) {
  const renewed = { ...grant, grantId: crypto.randomUUID(), sourceCommit: source.head, workspaceFingerprint: source.fingerprint,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)).toISOString(),
    claim: null, grantDigest: '', recordDigest: '' };
  renewed.grantDigest = productionTaskGrantDigest(renewed);
  renewed.recordDigest = productionTaskGrantRecordDigest(renewed);
  return validateProductionTaskGrant(renewed, now);
}

export function renewProductionTaskGrant(current, source, now = Date.now(), { sourceTransition } = {}) {
  const grant = validateProductionTaskGrantRecord(current, now, { allowExpired: true }).grant;
  let checkpointTransition = null;
  if (sourceTransition !== undefined) {
    try { checkpointTransition = validateSourceTransition(sourceTransition); } catch { /* Reject below. */ }
    if (checkpointTransition?.phase !== 'checkpointed'
      || checkpointTransition.from.head !== grant.sourceCommit || checkpointTransition.to.head !== source.head
      || checkpointTransition.from.head === checkpointTransition.to.head
      || checkpointTransition.from.fingerprint !== checkpointTransition.to.fingerprint
      || checkpointTransition.to.fingerprint !== source.fingerprint
      || !['projectSlug', 'taskId', 'actorUserId', 'actorUsername', 'conversationId', 'dshSessionId']
        .every((key) => checkpointTransition.task[key] === grant[key])
      || checkpointTransition.sourceAuthority.contractId !== grant.taskContract.contractId
      || checkpointTransition.sourceAuthority.actionCeiling !== grant.actionCeiling
      || checkpointTransition.sourceAuthority.productionAuthorityDigest !== grant.claim?.productionAuthorityDigest
      || checkpointTransition.sourceAuthority.controllerGrantDigest !== grant.grantDigest) {
      fail('PRODUCTION_TASK_RENEWAL_DENIED', 'Checkpoint renewal requires the exact claimed same-content transition.');
    }
  }
  if (!ACTION_CEILINGS.includes(grant.actionCeiling) || grant.claim === null
    || (source.head !== grant.sourceCommit && checkpointTransition === null) || !/^[0-9a-f]{64}$/u.test(source.fingerprint)) {
    fail('PRODUCTION_TASK_RENEWAL_DENIED', 'Only the same claimed task can renew its source binding.');
  }
  return replacementSourceGrant(grant, source, now);
}
