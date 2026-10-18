import { createHash } from 'node:crypto';
import { INPUT_SOURCE_PROJECTION, validateVerificationInputIdentity, validateInputSourceProjection } from './verification-inputs.mjs';
import { SOURCE_QUALITY_PROFILE, validateSourceQualityPayload } from './forge-backend-source-quality.mjs';
import { validateHostProfilePolicyTransition } from './host-verify-policy.mjs';
import { validateSourceTransition } from './taskspace-policy.mjs';
import { validateForgeWorkflowInventoryObservation } from './forge-workflow-migration-safety.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PROFILE = /^[a-z][a-z0-9-]{1,63}$/u;
const GIT_HEAD = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const HOST_RUN_STATUSES = new Set(['passed', 'failed', 'timed-out', 'failed-zero-tests']);
const HOST_TOOL_NAMES = ['forgeGovernance', 'git', 'java', 'maven', 'node', 'pnpm'];
export const FRONTEND_HOST_TOOL_NAMES = Object.freeze(['node', 'pnpm', 'git']);
const FRONTEND_REUSE_PROFILES = new Set([
  'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck',
  'frontend-admin-build', 'frontend-h5-test', 'frontend-h5-build',
]);
const NON_GOVERNANCE_REUSE_PROFILES = new Set([
  'backend-module-compile', 'backend-module-test', 'backend-test-class',
  'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck',
  'frontend-admin-build', 'frontend-h5-test', 'frontend-h5-build', 'full-regression',
]);
const TRUTH_FIELDS = [
  'databaseIntegrationProven',
  'executionProven',
  'releaseProven',
  'semanticCorrectnessProven',
  'verificationProven',
];

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  const ordered = (item) => Array.isArray(item) ? item.map(ordered)
    : plainObject(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, ordered(item[key])])) : item;
  return JSON.stringify(ordered(value));
}

export function hostRunReceiptDigest(value) {
  if (!plainObject(value)) throw new Error('host run receipt digest input is invalid.');
  const { freshness, revalidation, ...original } = value;
  return createHash('sha256').update(canonicalJson(original)).digest('hex');
}

export const REVIEWED_RECEIPT_SOURCE_PROJECTION = 'operator-reviewed-receipt-source-projection';

export function reviewedReceiptPolicyDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// Contract renewal may change its id, never its reviewed scope, roles or rules.
export function reviewedReceiptGovernanceBindingDigest(binding) {
  return reviewedReceiptPolicyDigest(Object.fromEntries([
    'governanceTaskScope', 'governanceRoleGrantPolicy', 'governanceSourceProvenancePolicy',
    ...(binding?.governanceAcceptedApiContract === undefined ? [] : ['governanceAcceptedApiContract']),
  ].map(key => {
    if (binding?.[key] === undefined) return [key, null];
    const { contractId, ...facts } = binding[key];
    return [key, facts];
  })));
}

export function validateReviewedReceiptSourcePolicy(value) {
  exactKeys(value, ['schemaVersion', 'projectSlug', 'taskId', 'receiptId', 'originalReceiptSha256',
    'profile', 'selectorsSha256', 'head', 'originalFingerprint', 'currentFingerprint',
    'dependencyManifestFingerprint', 'originalToolchainDigest', 'currentToolchainDigest',
    'profilePolicyDigest', 'profileCatalogVersion', 'reviewBase', 'governanceBindingSha256',
    'scopeFiles', 'changes', 'reviewEvidenceSha256'], 'reviewed receipt source policy');
  if (value.schemaVersion !== 1 || !['backend-test-class', 'governance'].includes(value.profile)) {
    throw new Error('reviewed receipt source policy schema or profile is invalid.');
  }
  for (const field of ['projectSlug', 'taskId', 'profileCatalogVersion']) requiredString(value[field], SAFE_ID, field);
  requiredString(value.receiptId, UUID, 'reviewed receipt id');
  for (const field of ['head', 'reviewBase']) requiredString(value[field], GIT_HEAD, field);
  for (const field of ['originalReceiptSha256', 'selectorsSha256', 'originalFingerprint', 'currentFingerprint',
    'dependencyManifestFingerprint', 'originalToolchainDigest', 'currentToolchainDigest',
    'profilePolicyDigest', 'governanceBindingSha256', 'reviewEvidenceSha256']) requiredString(value[field], SHA256, field);
  if (value.originalFingerprint === value.currentFingerprint) throw new Error('reviewed receipt projection requires an exact source change.');
  const file = item => {
    exactKeys(item, ['sha256', 'bytes'], 'reviewed source file');
    requiredString(item.sha256, SHA256, 'reviewed source file digest');
    nonnegativeInteger(item.bytes, 'reviewed source file bytes');
  };
  const paths = (items, limit) => {
    if (!Array.isArray(items) || items.length === 0 || items.length > limit) throw new Error('reviewed source paths are unbounded.');
    for (const [index, item] of items.entries()) {
      if (typeof item?.path !== 'string' || !/^[^\\\u0000-\u001f\u007f:]+$/u.test(item.path)
        || item.path.split('/').some(part => !part || part === '.' || part === '..')
        || (index > 0 && items[index - 1].path >= item.path)) throw new Error('reviewed source paths must be exact sorted unique files.');
    }
  };
  paths(value.scopeFiles, 7);
  // Bound delta metadata independently of the unchanged reviewed task scope.
  paths(value.changes, 64);
  for (const item of value.scopeFiles) {
    exactKeys(item, ['path', 'sha256', 'bytes'], 'reviewed scope file');
    file({ sha256: item.sha256, bytes: item.bytes });
  }
  for (const item of value.changes) {
    exactKeys(item, ['path', 'before', 'after'], 'reviewed source change');
    if (item.before !== null) file(item.before);
    if (item.after !== null) file(item.after);
    if (canonicalJson(item.before) === canonicalJson(item.after)
      || value.scopeFiles.some(scope => scope.path === item.path)) throw new Error('reviewed source change must leave every scoped file unchanged.');
  }
  return value;
}

// A matching digest is only a claim until the Host/issuer obtains this policy
// from its protected candidate binding/service configuration independently.
export function validateReviewedReceiptSourceBinding(policy, original, current, binding, toolchain) {
  validateReviewedReceiptSourcePolicy(policy);
  if (policy.projectSlug !== original.projectSlug || policy.taskId !== original.taskId
    || policy.receiptId !== original.receiptId || policy.originalReceiptSha256 !== hostRunReceiptDigest(original)
    || policy.profile !== original.request.profile || policy.selectorsSha256 !== original.request.selectorsSha256
    || policy.head !== original.source.head || policy.head !== current.head
    || policy.originalFingerprint !== original.source.workspaceFingerprint
    || policy.currentFingerprint !== current.workspaceFingerprint
    || policy.dependencyManifestFingerprint !== original.source.dependencyManifestFingerprint
    || policy.dependencyManifestFingerprint !== current.dependencyManifestFingerprint
    || policy.originalToolchainDigest !== original.toolchain.digest
    || policy.currentToolchainDigest !== toolchain?.digest
    || !hostRevalidationToolchainsMatch(original.toolchain, toolchain, original.request.profile)
    || policy.profilePolicyDigest !== original.policy.profilePolicyDigest
    || policy.profileCatalogVersion !== original.policy.profileCatalogVersion
    || policy.governanceBindingSha256 !== reviewedReceiptGovernanceBindingDigest(binding)
    || canonicalJson(policy.scopeFiles.map(item => item.path)) !== canonicalJson(binding?.governanceTaskScope?.ownedPaths)) {
    throw new Error('reviewed receipt source policy does not bind these exact execution and task facts.');
  }
  if (policy.profile === 'governance' && (original.execution.steps.length !== 1
    || original.execution.steps[0].argv[0] !== 'audit' || original.execution.steps[0].argv[1] !== '--base'
    || original.execution.steps[0].argv[2] !== policy.reviewBase)) throw new Error('reviewed governance base does not match the original command.');
  return policy;
}

export function validateReviewedReceiptSourceProjection(value, original, current) {
  exactKeys(value, ['schemaVersion', 'kind', 'profile', 'head', 'originalFingerprint', 'currentFingerprint',
    'reconstructedFingerprint', 'policySha256'], 'reviewed receipt source projection');
  if (value.schemaVersion !== 1 || value.kind !== REVIEWED_RECEIPT_SOURCE_PROJECTION
    || !['backend-test-class', 'governance'].includes(original.request.profile)
    || value.profile !== original.request.profile || value.head !== original.source.head || value.head !== current.head
    || value.originalFingerprint !== original.source.workspaceFingerprint
    || value.reconstructedFingerprint !== original.source.workspaceFingerprint
    || value.currentFingerprint !== current.workspaceFingerprint
    || original.source.dependencyManifestFingerprint !== current.dependencyManifestFingerprint) {
    throw new Error('reviewed receipt source projection does not bind the original and current source.');
  }
  requiredString(value.policySha256, SHA256, 'reviewed receipt source policy digest');
  return { ...original.source, workspaceFingerprint: current.workspaceFingerprint };
}

// Shape/source validation only: the issuer also matches this fact to its
// protected scope, which was bound to the Broker's original claimed authority.
export function validateHostCheckpointTransition(value, original, current, { projectSlug, taskId }) {
  const transition = validateSourceTransition(value);
  if (!['checkpointed', 'integrated'].includes(transition.phase)
    || transition.task.projectSlug !== projectSlug || transition.task.taskId !== taskId
    || transition.from.head !== original.head || transition.to.head !== current.head
    || transition.from.head === transition.to.head
    || transition.from.fingerprint !== original.workspaceFingerprint
    || transition.to.fingerprint !== current.workspaceFingerprint
    || transition.from.fingerprint !== transition.to.fingerprint
    || original.dependencyManifestFingerprint !== current.dependencyManifestFingerprint) {
    throw new Error('Host revalidation requires an exact same-content checkpoint transition.');
  }
  return transition;
}

// The protected Host reconstructs the old full source digest from current
// inventory and original frontend hashes (HEAD or retained execution metadata).
// This only validates that bounded
// proof; it never replaces the original execution or grants a new source HEAD.
function validateBackendSourceProjection(value, original, current, profile) {
  exactKeys(value, ['schemaVersion', 'kind', 'profile', 'head', 'originalFingerprint',
    'currentFingerprint', 'reconstructedFingerprint', 'frontendPaths'], 'host run source projection');
  if (value.schemaVersion !== 1 || value.kind !== 'backend-frontend-source-projection'
    || !['backend-test-class', 'backend-module-test', 'backend-module-compile'].includes(profile)
    || value.profile !== profile) {
    throw new Error('host run source projection profile or schema is invalid.');
  }
  requiredString(value.head, GIT_HEAD, 'host run source projection head');
  for (const field of ['originalFingerprint', 'currentFingerprint', 'reconstructedFingerprint']) {
    requiredString(value[field], SHA256, `host run source projection ${field}`);
  }
  if (value.head !== original.head || value.originalFingerprint !== original.workspaceFingerprint
    || value.reconstructedFingerprint !== original.workspaceFingerprint
    || value.currentFingerprint !== current.workspaceFingerprint
    || original.dependencyManifestFingerprint !== current.dependencyManifestFingerprint) {
    throw new Error('host run source projection does not bind the original and current source.');
  }
  if (!Array.isArray(value.frontendPaths) || value.frontendPaths.length === 0
    || value.frontendPaths.some((file, index) => typeof file !== 'string'
      || !/^forge-(?:admin|h5)-ui\/src\/[^\\\u0000-\u001f\u007f]+$/u.test(file)
      || file.split('/').some(part => part === '' || part === '.' || part === '..')
      || (index > 0 && value.frontendPaths[index - 1] >= file))) {
    throw new Error('host run source projection paths must be sorted unique frontend source files.');
  }
  return { ...original, workspaceFingerprint: current.workspaceFingerprint };
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} fields are invalid.`);
  }
  return value;
}

function requiredString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))
      || new Date(value).toISOString() !== value) throw new Error(`${label} is invalid.`);
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`);
  return value;
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validateProfiles(values, expected) {
  if (!Array.isArray(values) || values.length < 1
      || values.some((value) => typeof value !== 'string' || !PROFILE.test(value))
      || new Set(values).size !== values.length) throw new Error('host admission profiles are invalid.');
  if (expected !== undefined && !sameArray(values, expected)) {
    throw new Error('host admission profiles do not match the controlled command.');
  }
  return [...values];
}

function validateFalseTruth(value, label) {
  exactKeys(value, TRUTH_FIELDS, label);
  if (TRUTH_FIELDS.some((field) => value[field] !== false)) {
    throw new Error(`${label} must not claim proof before execution.`);
  }
}

function validateToolchain(value) {
  exactKeys(value, ['digest', 'executables', 'javaHome'], 'host toolchain');
  requiredString(value.javaHome, /^.{1,4096}$/u, 'host toolchain javaHome');
  requiredString(value.digest, SHA256, 'host toolchain digest');
  exactKeys(value.executables, HOST_TOOL_NAMES, 'host toolchain executables');
  for (const name of HOST_TOOL_NAMES) {
    const executable = exactKeys(value.executables[name], [
      'bytes', 'configuredPath', 'modifiedMs', 'resolvedPath', 'version',
    ], `host toolchain ${name}`);
    requiredString(executable.configuredPath, /^.{1,4096}$/u, `host toolchain ${name} configuredPath`);
    requiredString(executable.resolvedPath, /^.{1,4096}$/u, `host toolchain ${name} resolvedPath`);
    requiredString(executable.version, /^[^\r\n]{1,1024}$/u, `host toolchain ${name} version`);
    nonnegativeInteger(executable.bytes, `host toolchain ${name} bytes`);
    nonnegativeInteger(executable.modifiedMs, `host toolchain ${name} modifiedMs`);
  }
  return value;
}

function originalToolchainDigest(value) {
  // Preserve the serialization order used by the existing Host probe, including
  // receipts issued before this matcher. Do not rewrite their recorded digest.
  const executables = {};
  for (const name of ['java', 'maven', 'node', 'pnpm', 'git', 'forgeGovernance']) {
    const { configuredPath, resolvedPath, bytes, modifiedMs, version } = value.executables[name];
    executables[name] = { configuredPath, resolvedPath, bytes, modifiedMs, version };
  }
  return createHash('sha256').update(JSON.stringify({ javaHome: value.javaHome, executables })).digest('hex');
}

export function hostRevalidationToolchainsMatch(original, current, profile) {
  validateToolchain(original);
  validateToolchain(current);
  if (canonicalJson(original) === canonicalJson(current)) return true;
  if (FRONTEND_REUSE_PROFILES.has(profile)) {
    return original.digest === originalToolchainDigest(original)
      && current.digest === originalToolchainDigest(current)
      && FRONTEND_HOST_TOOL_NAMES.every((name) => canonicalJson(original.executables[name]) === canonicalJson(current.executables[name]));
  }
  if (!NON_GOVERNANCE_REUSE_PROFILES.has(profile)
      || original.javaHome !== current.javaHome
      || HOST_TOOL_NAMES.some((name) => name !== 'forgeGovernance'
        && canonicalJson(original.executables[name]) !== canonicalJson(current.executables[name]))) return false;
  // Only the unused governance descriptor may differ; both complete identities
  // must still bind their own descriptor rather than an invented matching hash.
  return original.digest === originalToolchainDigest(original)
    && current.digest === originalToolchainDigest(current);
}

export function frontendHostToolchainDigest(toolchain) {
  validateToolchain(toolchain);
  if (toolchain.digest !== originalToolchainDigest(toolchain)) throw new Error('host toolchain digest does not bind its descriptors.');
  return createHash('sha256').update(canonicalJson({
    platform: process.platform, arch: process.arch,
    executables: Object.fromEntries(FRONTEND_HOST_TOOL_NAMES.map((name) => [name, toolchain.executables[name]])),
  })).digest('hex');
}

export function isHostExecutionAdmissionReceipt(value) {
  return value?.schemaVersion === 2
    && value?.receiptType === 'forge-verify/host-execution-admission';
}

export function validateHostExecutionAdmissionReceipt(value, options = {}) {
  exactKeys(value, [
    'admissionId', 'expiresAt', 'issuedAt', 'outcome', 'profileCatalogVersion',
    'profilePolicyDigest', 'profiles', 'projectSlug', 'reasonCode', 'receiptType',
    'runner', 'schemaVersion', 'source', 'taskId', 'toolchain', 'truth',
  ], 'host execution admission receipt');
  if (!isHostExecutionAdmissionReceipt(value) || value.outcome !== 'ready' || value.reasonCode !== null) {
    throw new Error('host execution admission type, schema, or outcome is invalid.');
  }
  requiredString(value.admissionId, UUID, 'host admissionId');
  requiredString(value.projectSlug, SAFE_ID, 'host admission projectSlug');
  requiredString(value.taskId, SAFE_ID, 'host admission taskId');
  if (options.projectSlug !== undefined && value.projectSlug !== options.projectSlug) {
    throw new Error('host admission project identity is invalid.');
  }
  if (options.taskId !== undefined && value.taskId !== options.taskId) {
    throw new Error('host admission TaskSpace identity is invalid.');
  }
  const profiles = validateProfiles(value.profiles, options.profiles);
  exactKeys(value.runner, ['bootId', 'revision'], 'host admission runner');
  requiredString(value.runner.bootId, UUID, 'host admission runner bootId');
  requiredString(value.runner.revision, SAFE_ID, 'host admission runner revision');
  exactKeys(value.source, [
    'dependencyManifestFingerprint', 'head', 'workspaceFingerprint',
  ], 'host admission source');
  requiredString(value.source.head, GIT_HEAD, 'host admission source head');
  requiredString(value.source.workspaceFingerprint, SHA256, 'host admission source fingerprint');
  requiredString(value.source.dependencyManifestFingerprint, SHA256, 'host admission dependency fingerprint');
  if (options.sourceFingerprint !== undefined
      && value.source.workspaceFingerprint !== options.sourceFingerprint) {
    throw new Error('host admission source fingerprint is stale.');
  }
  requiredString(value.profileCatalogVersion, SAFE_ID, 'host admission profile catalog version');
  requiredString(value.profilePolicyDigest, SHA256, 'host admission profile policy digest');
  validateToolchain(value.toolchain);
  validateFalseTruth(value.truth, 'host admission truth');
  const issuedAt = canonicalTimestamp(value.issuedAt, 'host admission issuedAt');
  const expiresAt = canonicalTimestamp(value.expiresAt, 'host admission expiresAt');
  const leaseMs = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (leaseMs < 30_000 || leaseMs > 15 * 60_000) throw new Error('host admission lease is invalid.');
  if (options.observedAt !== undefined) {
    const observedAt = Date.parse(canonicalTimestamp(options.observedAt, 'host admission observedAt'));
    if (observedAt < Date.parse(issuedAt) || observedAt > Date.parse(expiresAt)) {
      throw new Error('host admission is not current at observation.');
    }
  }
  return {
    executionMode: 'host-toolchain',
    profiles,
    dependencyManifestFingerprint: value.source.dependencyManifestFingerprint,
    toolchainDigest: value.toolchain.digest,
    profilePolicyDigest: value.profilePolicyDigest,
    receipt: value,
  };
}

export function isHostCapabilityReceipt(value) {
  return value?.schemaVersion === 2 && value?.receiptType === 'forge-verify/host-capability';
}

export function validateHostCapabilityReceipt(value, options = {}) {
  if (!isHostCapabilityReceipt(value)) throw new Error('host capability type or schema is invalid.');
  const ready = value.outcome === 'ready';
  exactKeys(value, ready ? [
    'observedAt', 'outcome', 'profile', 'profileCatalogVersion', 'profilePolicyDigest',
    'projectSlug', 'reasonCode', 'receiptId', 'receiptType', 'runner', 'schemaVersion',
    'source', 'taskId', 'toolchain', 'truth',
  ] : [
    'observedAt', 'outcome', 'profile', 'projectSlug', 'reasonCode', 'receiptId',
    'receiptType', 'schemaVersion', 'taskId', 'truth',
  ], 'host capability receipt');
  requiredString(value.receiptId, UUID, 'host capability receiptId');
  requiredString(value.projectSlug, SAFE_ID, 'host capability projectSlug');
  requiredString(value.taskId, SAFE_ID, 'host capability taskId');
  requiredString(value.profile, PROFILE, 'host capability profile');
  if (options.profile !== undefined && value.profile !== options.profile) {
    throw new Error('host capability profile does not match the controlled command.');
  }
  if (!['ready', 'executor_unavailable'].includes(value.outcome)) {
    throw new Error('host capability outcome is invalid.');
  }
  canonicalTimestamp(value.observedAt, 'host capability observedAt');
  validateFalseTruth(value.truth, 'host capability truth');
  if (ready) {
    if (value.reasonCode !== null) throw new Error('ready host capability cannot have a failure reason.');
    exactKeys(value.source, [
      'dependencyManifestFingerprint', 'head', 'workspaceFingerprint',
    ], 'host capability source');
    requiredString(value.source.head, GIT_HEAD, 'host capability source head');
    requiredString(value.source.workspaceFingerprint, SHA256, 'host capability source fingerprint');
    requiredString(value.source.dependencyManifestFingerprint, SHA256, 'host capability dependency fingerprint');
    exactKeys(value.runner, ['bootId', 'revision'], 'host capability runner');
    requiredString(value.runner.bootId, UUID, 'host capability runner bootId');
    requiredString(value.runner.revision, SAFE_ID, 'host capability runner revision');
    requiredString(value.profileCatalogVersion, SAFE_ID, 'host capability profile catalog version');
    requiredString(value.profilePolicyDigest, SHA256, 'host capability profile policy digest');
    validateToolchain(value.toolchain);
  } else {
    requiredString(value.reasonCode, SAFE_ID, 'host capability reasonCode');
  }
  return value;
}

export function isHostRunReceipt(value) {
  return value?.schemaVersion === 2 && value?.receiptType === 'forge-verify/host-run';
}

function validateHostRunSource(value) {
  exactKeys(value, [
    'bytes', 'dependencyManifestFingerprint', 'fileCount', 'head', 'snapshotSha256',
    'workspaceFingerprint',
  ], 'host run source');
  requiredString(value.head, GIT_HEAD, 'host run source head');
  requiredString(value.workspaceFingerprint, SHA256, 'host run source fingerprint');
  requiredString(value.dependencyManifestFingerprint, SHA256, 'host run dependency fingerprint');
  requiredString(value.snapshotSha256, SHA256, 'host run snapshot fingerprint');
  if (value.snapshotSha256 !== value.workspaceFingerprint) throw new Error('host run snapshot is stale.');
  nonnegativeInteger(value.fileCount, 'host run source fileCount');
  nonnegativeInteger(value.bytes, 'host run source bytes');
}

function validateHostRunExecution(value) {
  exactKeys(value, ['exitCode', 'finishedAt', 'signal', 'startedAt', 'steps'], 'host run execution');
  if (!Array.isArray(value.steps) || value.steps.length < 1) throw new Error('host run execution steps are invalid.');
  for (const [index, step] of value.steps.entries()) {
    exactKeys(step, [
      'argv', 'cleanup', 'cwd', 'executable', 'exitCode', 'processEnded', 'signal',
      'timedOut', 'transportUncertain',
    ], `host run execution step ${index}`);
    requiredString(step.executable, /^.{1,4096}$/u, `host run execution step ${index} executable`);
    requiredString(step.cwd, /^.{1,4096}$/u, `host run execution step ${index} cwd`);
    if (!Array.isArray(step.argv) || step.argv.some((argument) => typeof argument !== 'string')) {
      throw new Error(`host run execution step ${index} argv is invalid.`);
    }
    if (!Number.isSafeInteger(step.exitCode) || (step.timedOut === true && step.exitCode !== 124)
        || step.processEnded !== true || step.transportUncertain !== false) {
      throw new Error(`host run execution step ${index} process facts are invalid.`);
    }
    if (step.signal !== null && typeof step.signal !== 'string') {
      throw new Error(`host run execution step ${index} signal is invalid.`);
    }
    exactKeys(step.cleanup, ['proven'], `host run execution step ${index} cleanup`);
    if (step.cleanup.proven !== true) throw new Error(`host run execution step ${index} cleanup is unproven.`);
  }
  if (!Number.isSafeInteger(value.exitCode) || (value.signal !== null && typeof value.signal !== 'string')) {
    throw new Error('host run final process facts are invalid.');
  }
  canonicalTimestamp(value.startedAt, 'host run startedAt');
  canonicalTimestamp(value.finishedAt, 'host run finishedAt');
}

export function validateHostRunReceipt(value, options = {}) {
  if ((options.revalidationDepth ?? 0) > 8) throw new Error('Host checkpoint revalidation depth exceeded.');
  if (!isHostRunReceipt(value)) throw new Error('host run type or schema is invalid.');
  const redProfile = ['backend-red-test', 'frontend-red-test'].includes(value.request?.profile);
  const revalidated = Object.hasOwn(value, 'revalidation');
  if (revalidated && options.allowRevalidation === false) {
    throw new Error('host run revalidation was not requested.');
  }
  exactKeys(value, [
    'execution', 'isolation', 'jobId', 'logs', 'policy', 'projectSlug', 'receiptId',
    'receiptType', 'request', 'results', 'schemaVersion', 'source', 'status', 'taskId',
    'toolchain', 'truth',
    ...(Object.hasOwn(value, 'inputIdentity') ? ['inputIdentity'] : []),
    ...(redProfile ? ['redExpectation'] : []),
    ...(Object.hasOwn(value, 'freshness') ? ['freshness'] : []),
    ...(Object.hasOwn(value, 'workflowInventoryObservation') ? ['workflowInventoryObservation'] : []),
    ...(Object.hasOwn(value, 'sourceQuality') ? ['sourceQuality'] : []),
    ...(revalidated ? ['revalidation'] : []),
  ], 'host run receipt');
  requiredString(value.receiptId, UUID, 'host run receiptId');
  requiredString(value.jobId, UUID, 'host run jobId');
  requiredString(value.projectSlug, SAFE_ID, 'host run projectSlug');
  requiredString(value.taskId, SAFE_ID, 'host run taskId');
  if (options.projectSlug !== undefined && value.projectSlug !== options.projectSlug) {
    throw new Error('host run project identity is invalid.');
  }
  if (options.taskId !== undefined && value.taskId !== options.taskId) {
    throw new Error('host run TaskSpace identity is invalid.');
  }
  if (!HOST_RUN_STATUSES.has(value.status)) throw new Error('host run status is invalid.');
  validateHostRunSource(value.source);
  if (value.inputIdentity !== undefined) validateVerificationInputIdentity(value.inputIdentity);
  let effectiveSourceFingerprint = value.source.workspaceFingerprint;
  exactKeys(value.request, [
    'admissionId', 'idempotencyDigest', 'profile', 'selectors', 'selectorsSha256',
  ], 'host run request');
  requiredString(value.request.admissionId, UUID, 'host run admissionId');
  requiredString(value.request.idempotencyDigest, SHA256, 'host run idempotency digest');
  requiredString(value.request.profile, PROFILE, 'host run profile');
  requiredString(value.request.selectorsSha256, SHA256, 'host run selectors digest');
  if (!plainObject(value.request.selectors)) throw new Error('host run selectors are invalid.');
  if (options.profile !== undefined && value.request.profile !== options.profile) {
    throw new Error('host run profile does not match the controlled command.');
  }
  const admissionId = revalidated ? value.revalidation?.admissionReceipt?.admissionId : value.request.admissionId;
  if (options.admissionId !== undefined && admissionId !== options.admissionId) {
    throw new Error('host run admission does not match the controlled command.');
  }
  exactKeys(value.policy, ['profileCatalogVersion', 'profilePolicyDigest'], 'host run policy');
  requiredString(value.policy.profileCatalogVersion, SAFE_ID, 'host run profile catalog version');
  requiredString(value.policy.profilePolicyDigest, SHA256, 'host run profile policy digest');
  validateToolchain(value.toolchain);
  exactKeys(value.isolation, [
    'arbitraryShell', 'cacheRoot', 'cleanupProven', 'globalUserConfigRead', 'mode',
    'requestControlledEnvironment', 'taskStateRoot',
  ], 'host run isolation');
  if (value.isolation.mode !== 'host-toolchain-isolated-taskspace'
      || value.isolation.globalUserConfigRead !== false
      || value.isolation.arbitraryShell !== false
      || value.isolation.requestControlledEnvironment !== false
      || value.isolation.cleanupProven !== true) {
    throw new Error('host run isolation facts are invalid.');
  }
  requiredString(value.isolation.taskStateRoot, /^.{1,4096}$/u, 'host run task state root');
  requiredString(value.isolation.cacheRoot, /^.{1,4096}$/u, 'host run cache root');
  validateHostRunExecution(value.execution);
  exactKeys(value.results, [
    'executed', 'failed', 'passed', 'reportFiles', 'skipped', 'zeroTestsRejected',
  ], 'host run results');
  if (Object.hasOwn(value, 'workflowInventoryObservation')) {
    const observed = validateForgeWorkflowInventoryObservation(value.workflowInventoryObservation);
    const observedAt = Date.parse(observed.capturedAt);
    if (value.request.profile !== 'backend-test-class' || value.status !== 'passed'
        || value.results.executed !== 1 || value.results.passed !== 1
        || value.request.selectors.tests?.length !== 1
        || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*#[A-Za-z_$][\w$]*$/u.test(value.request.selectors.tests[0])
        || observedAt < Date.parse(value.execution.startedAt)
        || observedAt > Date.parse(value.execution.finishedAt)) {
      throw new Error('Workflow inventory observation must belong to one successful method execution.');
    }
  }
  for (const field of ['executed', 'failed', 'passed', 'reportFiles', 'skipped']) {
    nonnegativeInteger(value.results[field], `host run results ${field}`);
  }
  if (value.results.zeroTestsRejected !== (value.status === 'failed-zero-tests')) {
    throw new Error('host run zero-test result is invalid.');
  }
  if (value.results.passed + value.results.failed + value.results.skipped !== value.results.executed) {
    throw new Error('host run test result totals are inconsistent.');
  }
  const backendTests = ['backend-module-test', 'backend-test-class', 'backend-red-test', 'full-regression']
    .includes(value.request.profile);
  const reportedBackendFailure = backendTests && value.results.failed > 0 && value.results.reportFiles > 0;
  const noExecutedTests = backendTests
    ? value.results.passed + value.results.failed === 0 : value.results.executed === 0;
  if (backendTests && value.status === 'passed'
      && (value.results.passed === 0 || value.results.failed !== 0 || value.results.reportFiles === 0)) {
    throw new Error('Backend test success requires an executed, failure-free test report.');
  }
  if (value.request.profile === 'frontend-h5-test' && value.status === 'passed'
      && (value.results.executed === 0 || value.results.failed !== 0 || value.results.reportFiles !== 1)) {
    throw new Error('H5 test success requires an executed, failure-free Node report.');
  }
  const finalStep = value.execution.steps.at(-1);
  if (value.request.profile === SOURCE_QUALITY_PROFILE && [0, 1, 2].includes(value.execution.exitCode)) {
    validateSourceQualityPayload(value.sourceQuality, value.execution.exitCode);
  } else if (Object.hasOwn(value, 'sourceQuality')) {
    throw new Error('Source quality payload is outside its diagnostic profile.');
  }
  const stepsPassed = value.execution.steps.every((step) => step.exitCode === 0);
  const timedOut = value.execution.steps.some((step) => step.timedOut === true);
  if (value.execution.exitCode !== finalStep.exitCode || value.execution.signal !== finalStep.signal
      || (value.status === 'passed' && (!stepsPassed || value.results.zeroTestsRejected))
      || (value.status === 'failed-zero-tests' && (!stepsPassed || !noExecutedTests))
      || (value.status === 'failed' && ((stepsPassed && !reportedBackendFailure) || timedOut))
      || (value.status === 'timed-out') !== timedOut) {
    throw new Error('host run status does not match its process facts.');
  }
  exactKeys(value.logs, ['bytes', 'path', 'redacted', 'sha256', 'truncated'], 'host run logs');
  requiredString(value.logs.path, /^.{1,4096}$/u, 'host run logs path');
  requiredString(value.logs.sha256, SHA256, 'host run logs digest');
  nonnegativeInteger(value.logs.bytes, 'host run logs bytes');
  if (typeof value.logs.truncated !== 'boolean' || typeof value.logs.redacted !== 'boolean') {
    throw new Error('host run log facts are invalid.');
  }
  exactKeys(value.truth, TRUTH_FIELDS, 'host run truth');
  if (value.truth.executionProven !== true
      || value.truth.verificationProven !== (value.status === 'passed')
      || value.truth.semanticCorrectnessProven !== false
      || value.truth.databaseIntegrationProven !== false
      || value.truth.releaseProven !== false) {
    throw new Error('host run truth claims are invalid.');
  }
  if (redProfile) {
    exactKeys(value.redExpectation, [
      'expectationType', 'failureKind', 'matched', 'profile', 'schemaVersion',
      'selectorsSha256',
    ], 'host run RED expectation');
    if (value.redExpectation.schemaVersion !== 1
        || value.redExpectation.expectationType !== 'selected-test-must-fail'
        || value.redExpectation.profile !== value.request.profile
        || value.redExpectation.selectorsSha256 !== value.request.selectorsSha256
        || typeof value.redExpectation.matched !== 'boolean'
        || !['test-report', 'unmatched'].includes(value.redExpectation.failureKind)
        || (value.redExpectation.matched === true) !== (value.redExpectation.failureKind === 'test-report')) {
      throw new Error('host run RED expectation is invalid.');
    }
  }
  if (Object.hasOwn(value, 'freshness') && !['current', 'stale'].includes(value.freshness)) {
    throw new Error('host run freshness is invalid.');
  }
  if (revalidated) {
    const review = exactKeys(value.revalidation, [
      'admissionReceipt', 'contractId', 'observedAt', 'originalReceiptSha256', 'receiptType', 'schemaVersion',
      ...(Object.hasOwn(value.revalidation, 'sourceTransition') ? ['sourceTransition'] : []),
      ...(Object.hasOwn(value.revalidation, 'previousRevalidation') ? ['previousRevalidation'] : []),
      ...(Object.hasOwn(value.revalidation, 'sourceProjection') ? ['sourceProjection'] : []),
      ...(Object.hasOwn(value.revalidation, 'profilePolicyTransition') ? ['profilePolicyTransition'] : []),
    ], 'host run revalidation');
    if (review.schemaVersion !== 1 || review.receiptType !== 'forge-verify/host-revalidation'
        || value.status !== 'passed' || redProfile) {
      throw new Error('host run revalidation requires a passed non-RED receipt.');
    }
    requiredString(review.contractId, SHA256, 'host run revalidation contractId');
    requiredString(review.originalReceiptSha256, SHA256, 'host run revalidation original receipt digest');
    canonicalTimestamp(review.observedAt, 'host run revalidation observedAt');
    if (review.originalReceiptSha256 !== hostRunReceiptDigest(value)
        || Date.parse(value.execution.finishedAt) > Date.parse(review.observedAt)) {
      throw new Error('host run revalidation original facts or observation time are invalid.');
    }
    const projected = Object.hasOwn(review, 'sourceProjection');
    const admission = validateHostExecutionAdmissionReceipt(review.admissionReceipt, {
      projectSlug: value.projectSlug, taskId: value.taskId, observedAt: review.observedAt,
      ...(projected ? {} : { sourceFingerprint: value.source.workspaceFingerprint }),
    }).receipt;
    let transitionSource = projected
      ? review.sourceProjection?.kind === INPUT_SOURCE_PROJECTION
        ? validateInputSourceProjection(review.sourceProjection, value, admission.source)
        : review.sourceProjection?.kind === REVIEWED_RECEIPT_SOURCE_PROJECTION
        ? validateReviewedReceiptSourceProjection(review.sourceProjection, value, admission.source)
        : validateBackendSourceProjection(review.sourceProjection, value.source, admission.source, value.request.profile)
      : value.source;
    if (review.previousRevalidation !== undefined) {
      if (projected || review.sourceTransition === undefined || value.request.profile === 'governance') {
        throw new Error('A checkpoint predecessor requires unchanged verification source.');
      }
      const prior = validateHostRunReceipt({ ...value, revalidation: review.previousRevalidation }, {
        projectSlug: value.projectSlug, taskId: value.taskId, profile: value.request.profile,
        reuseReceiptId: value.receiptId, revalidationDepth: (options.revalidationDepth ?? 0) + 1,
      });
      transitionSource = prior.revalidation.admissionReceipt.source;
      if (prior.revalidation.sourceProjection !== undefined
        || transitionSource.workspaceFingerprint !== value.source.workspaceFingerprint
        || Date.parse(prior.revalidation.observedAt) > Date.parse(review.observedAt)) {
        throw new Error('Checkpoint predecessor changed the original source or observation order.');
      }
    }
    const policyTransitioned = Object.hasOwn(review, 'profilePolicyTransition');
    if (policyTransitioned) validateHostProfilePolicyTransition(review.profilePolicyTransition,
      value.policy.profilePolicyDigest, admission.profilePolicyDigest, value.request.profile, value.projectSlug);
    const transitioned = Object.hasOwn(review, 'sourceTransition');
    if (transitioned) validateHostCheckpointTransition(review.sourceTransition, transitionSource, admission.source, value);
    const inputProjected = projected && review.sourceProjection.kind === INPUT_SOURCE_PROJECTION;
    if ((!transitioned && !inputProjected && admission.source.head !== value.source.head)
        || (!inputProjected && admission.source.dependencyManifestFingerprint !== value.source.dependencyManifestFingerprint)
        || !admission.profiles.includes(value.request.profile)
        || (!policyTransitioned && admission.profilePolicyDigest !== value.policy.profilePolicyDigest)
        || admission.profileCatalogVersion !== value.policy.profileCatalogVersion
        || !hostRevalidationToolchainsMatch(value.toolchain, admission.toolchain, value.request.profile)) {
      throw new Error('host run revalidation source, profile, toolchain or policy does not match the original run.');
    }
    effectiveSourceFingerprint = transitionSource.workspaceFingerprint;
  }
  if (options.sourceFingerprint !== undefined && effectiveSourceFingerprint !== options.sourceFingerprint) {
    throw new Error('host run source fingerprint is stale.');
  }
  if (options.reuseReceiptId !== undefined
      && (!revalidated || options.reuseReceiptId !== value.receiptId)) {
    throw new Error('host run revalidation receipt id does not match the controlled command.');
  }
  if (options.receiptId !== undefined && value.receiptId !== options.receiptId) {
    throw new Error('host run receipt id does not match the controlled command.');
  }
  if (options.requireCurrent === true && value.freshness !== 'current') {
    throw new Error('host run receipt is not current.');
  }
  return value;
}
