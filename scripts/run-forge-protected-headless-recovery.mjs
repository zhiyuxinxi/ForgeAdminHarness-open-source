#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants, realpathSync } from 'node:fs';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RECOVERY_SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const EXECUTION_CONTEXT_MODULE = path.basename(RECOVERY_SCRIPT_DIRECTORY) === 'bin'
  ? path.join(RECOVERY_SCRIPT_DIRECTORY, '..', 'lib', 'forge-execution-context.mjs')
  : path.join(RECOVERY_SCRIPT_DIRECTORY, '..', 'docker', 'harness', 'forge-execution-context.mjs');
const {
  digestDirectUserTextContent,
  readProtectedExecutionRecoveryStatus,
} = await import(pathToFileURL(EXECUTION_CONTEXT_MODULE).href);

export const HOST_RECOVERY_DESCRIPTOR_SCHEMA = 'forge-protected-headless-host-recovery/v4';
export const HOST_RECOVERY_JOURNAL_SCHEMA = 'forge-protected-headless-host-recovery-journal/v1';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const TASK_ID = /^[a-z0-9][a-z0-9-]{1,47}$/u;
const ACTOR_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/u;
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const DSH_ID = /^[^\0\r\n]{1,1024}$/u;
const RPC_ID = /^[^\0\r\n]{1,256}$/u;
const AUTHORIZATION_REFERENCE = /^[^\0\r\n]{1,256}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const CONTAINER_ID = /^[0-9a-f]{64}$/u;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const HARNESS_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u;
const SESSION_CWD = /^\/[^\0\r\n]{0,4095}$/u;
const MAX_DESCRIPTOR_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const HELPER_PATH = '/usr/local/lib/forge-recover-headless-execution.mjs';
const NODE_PATH = '/usr/local/bin/node';
const FIXED_UID = 1000;
const FIXED_GID = 983;
const FIXED_USER = '1000:983';
const FIXED_DSH_PORT = 3080;
const FIXED_PROXY_PORT = 23080;
const FIXED_BROKER_PIDS_LIMIT = 256;
const FIXED_BROKER_MEMORY_BYTES = 768 * 1024 * 1024;
const FIXED_BROKER_NANO_CPUS = 1_000_000_000;
const FIXED_MAINTENANCE_HEALTH_PATH = '/forge-maintenance/healthz';
const HEALTH_PROBE_TIMEOUT_MS = 10_000;
const MAX_HEALTH_RESPONSE_BYTES = 32 * 1024;
const MAX_HEALTH_PROBE_OUTPUT_BYTES = 256 * 1024;
const PROJECT_DEFAULT_BROKER_TOPOLOGY = 'project-default';
const DEDICATED_CANARY_BROKER_TOPOLOGY = 'dedicated-canary';
const MAX_RECOVERY_AUTHORIZATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_RUNTIME_PATH = '/opt/java/openjdk/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SAFE_NODE_PATH = '/opt/forge-harness-runtime/node_modules';
const FORBIDDEN_RUNTIME_ENVIRONMENT = new Set([
  'BASH_ENV', 'ENV', 'LD_AUDIT', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'OPENSSL_CONF', 'OPENSSL_MODULES',
  'SSL_CERT_DIR', 'SSL_CERT_FILE', 'ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY',
  'all_proxy', 'http_proxy', 'https_proxy', 'ssl_cert_dir', 'ssl_cert_file',
]);

export class HostRecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostRecoveryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new HostRecoveryError(code, message);
}

function assertAuthorizationCurrent(descriptor, now) {
  const observedNow = now();
  if (!(observedNow instanceof Date) || !Number.isFinite(observedNow.getTime())
    || observedNow.getTime() < Date.parse(descriptor.operation.authorizationIssuedAt)
    || observedNow.getTime() >= Date.parse(descriptor.operation.authorizationExpiresAt)) {
    fail('HOST_RECOVERY_AUTHORIZATION_EXPIRED', 'Operator recovery authorization is not currently valid.');
  }
  return observedNow;
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', `${label} has an invalid shape.`);
  }
}

function requiredString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', `${label} is invalid.`);
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(stableValue(value))}\n`, 'utf8');
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function descriptorDigest(value) {
  const copy = structuredClone(value);
  copy.operation.descriptorSha256 = null;
  return sha256(canonicalJsonBytes(copy));
}

function relativeInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameCanonicalHostPath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function pathsOverlap(left, right) {
  return relativeInside(left, right) || relativeInside(right, left);
}

function requireHostPath(value, allowedRoot, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    fail('HOST_RECOVERY_PATH_INVALID', `${label} must be an absolute host path.`);
  }
  const resolved = path.resolve(value);
  if (!relativeInside(allowedRoot, resolved)) {
    fail('HOST_RECOVERY_PATH_INVALID', `${label} escaped the machine-local allowed root.`);
  }
  return resolved;
}

export function validateHostRecoveryDescriptor(value, { allowedRoot } = {}) {
  if (typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) {
    fail('HOST_RECOVERY_PATH_INVALID', 'A machine-local absolute allowed root is required.');
  }
  exactKeys(value, ['schemaVersion', 'operation', 'target', 'execution', 'paths', 'digests'], 'descriptor');
  if (value.schemaVersion !== HOST_RECOVERY_DESCRIPTOR_SCHEMA) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Descriptor schema is unsupported.');
  }
  exactKeys(value.operation, [
    'operationId', 'authorizationReference', 'authorizationIssuedAt',
    'authorizationExpiresAt', 'descriptorSha256',
  ], 'operation');
  requiredString(value.operation.operationId, UUID, 'operationId');
  requiredString(value.operation.authorizationReference, AUTHORIZATION_REFERENCE, 'authorizationReference');
  requiredString(value.operation.descriptorSha256, SHA256, 'descriptorSha256');
  const authorizationIssuedAt = Date.parse(value.operation.authorizationIssuedAt);
  const authorizationExpiresAt = Date.parse(value.operation.authorizationExpiresAt);
  if (!Number.isFinite(authorizationIssuedAt) || !Number.isFinite(authorizationExpiresAt)
    || authorizationExpiresAt <= authorizationIssuedAt
    || authorizationExpiresAt - authorizationIssuedAt > MAX_RECOVERY_AUTHORIZATION_WINDOW_MS) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Recovery authorization timestamps are invalid or exceed the absolute window.');
  }

  exactKeys(value.target, [
    'projectSlug', 'taskId', 'canaryId', 'runId', 'attemptDirectoryName',
    'harnessContainerId', 'harnessImageId', 'harnessStartedAt', 'harnessUser',
    'harnessRevision', 'harnessSkillBundleVersion', 'harnessRuntimeProfile',
    'taskspaceAccessMode',
    'brokerContainerId', 'brokerImageId', 'brokerStartedAt',
    'brokerUser', 'brokerRevision', 'recoveryHelperImageId', 'recoveryHelperRevision',
    'recoveryHelperBuildInputDigest', 'recoveryHelperSourceSha256', 'skillBundleVersion',
    'harnessApplicationNetworkId', 'harnessTaskspacesNetworkId', 'harnessUploadsNetworkId',
    'brokerTopologyMode', 'brokerServiceNetworkName', 'brokerServiceNetworkId',
    'brokerServiceNetworkAlias',
    'brokerTaskspacesNetworkId', 'brokerGitRemoteNetworkId',
    'brokerGitRemoteRequired', 'brokerGitRemoteReady', 'brokerGitRemoteName',
    'brokerGitRemoteBranch',
    'hostProxyPort', 'dshPort',
  ], 'target');
  requiredString(value.target.projectSlug, TASK_ID, 'projectSlug');
  requiredString(value.target.taskId, TASK_ID, 'taskId');
  requiredString(value.target.canaryId, /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/u, 'canaryId');
  requiredString(value.target.runId, /^[a-z0-9][a-z0-9-]{1,63}$/u, 'runId');
  requiredString(value.target.attemptDirectoryName, /^[0-9]{2}-[a-z0-9][a-z0-9-]{1,63}$/u, 'attemptDirectoryName');
  requiredString(value.target.harnessContainerId, CONTAINER_ID, 'harnessContainerId');
  requiredString(value.target.harnessImageId, IMAGE_ID, 'harnessImageId');
  requiredString(value.target.harnessRevision, HARNESS_REVISION, 'harnessRevision');
  requiredString(value.target.harnessSkillBundleVersion, HARNESS_REVISION, 'harnessSkillBundleVersion');
  requiredString(value.target.harnessRuntimeProfile, HARNESS_REVISION, 'harnessRuntimeProfile');
  if (value.target.taskspaceAccessMode !== 'conversation') {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Protected recovery requires conversation-scoped TaskSpace access.');
  }
  requiredString(value.target.brokerContainerId, CONTAINER_ID, 'brokerContainerId');
  requiredString(value.target.brokerImageId, IMAGE_ID, 'brokerImageId');
  requiredString(value.target.brokerRevision, HARNESS_REVISION, 'brokerRevision');
  requiredString(value.target.recoveryHelperImageId, IMAGE_ID, 'recoveryHelperImageId');
  requiredString(value.target.recoveryHelperRevision, HARNESS_REVISION, 'recoveryHelperRevision');
  requiredString(value.target.recoveryHelperBuildInputDigest, /^sha256:[0-9a-f]{64}$/u, 'recoveryHelperBuildInputDigest');
  requiredString(value.target.recoveryHelperSourceSha256, SHA256, 'recoveryHelperSourceSha256');
  requiredString(value.target.skillBundleVersion, HARNESS_REVISION, 'skillBundleVersion');
  for (const key of [
    'harnessApplicationNetworkId', 'harnessTaskspacesNetworkId', 'harnessUploadsNetworkId',
    'brokerServiceNetworkId', 'brokerTaskspacesNetworkId',
  ]) requiredString(value.target[key], /^[0-9a-f]{64}$/u, key);
  if (value.target.harnessTaskspacesNetworkId !== value.target.brokerTaskspacesNetworkId) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Harness and Broker TaskSpace network identities disagree.');
  }
  const projectNetworkPrefix = `forge-${value.target.projectSlug}`;
  const projectTaskspacesNetwork = `${projectNetworkPrefix}_taskspaces`;
  const dedicatedCanaryNetwork = `${projectNetworkPrefix}-task-${value.target.taskId}_uploads`;
  if (![PROJECT_DEFAULT_BROKER_TOPOLOGY, DEDICATED_CANARY_BROKER_TOPOLOGY]
    .includes(value.target.brokerTopologyMode)
    || value.target.brokerServiceNetworkAlias !== 'taskspace-broker') {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Broker topology mode or service alias is invalid.');
  }
  if (value.target.brokerTopologyMode === PROJECT_DEFAULT_BROKER_TOPOLOGY
    && (value.target.brokerServiceNetworkName !== projectTaskspacesNetwork
      || value.target.brokerServiceNetworkId !== value.target.brokerTaskspacesNetworkId)) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Default Broker service network binding is invalid.');
  }
  if (value.target.brokerTopologyMode === DEDICATED_CANARY_BROKER_TOPOLOGY
    && (value.target.brokerServiceNetworkName !== dedicatedCanaryNetwork
      || value.target.brokerServiceNetworkId !== value.target.harnessUploadsNetworkId
      || value.target.brokerServiceNetworkId === value.target.brokerTaskspacesNetworkId)) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Dedicated Canary Broker service network binding is invalid.');
  }
  const defaultGitRemoteBinding = value.target.brokerTopologyMode === PROJECT_DEFAULT_BROKER_TOPOLOGY
    && /^[0-9a-f]{64}$/u.test(value.target.brokerGitRemoteNetworkId ?? '')
    && ['true', 'false'].includes(value.target.brokerGitRemoteRequired)
    && ['true', 'false'].includes(value.target.brokerGitRemoteReady)
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value.target.brokerGitRemoteName ?? '')
    && typeof value.target.brokerGitRemoteBranch === 'string'
    && !value.target.brokerGitRemoteBranch.includes('\0')
    && value.target.brokerGitRemoteBranch.length <= 255;
  const dedicatedGitRemoteBinding = value.target.brokerTopologyMode === DEDICATED_CANARY_BROKER_TOPOLOGY
    && value.target.brokerGitRemoteNetworkId === null
    && value.target.brokerGitRemoteRequired === 'false'
    && value.target.brokerGitRemoteReady === 'false'
    && value.target.brokerGitRemoteName === null
    && value.target.brokerGitRemoteBranch === null;
  if (!defaultGitRemoteBinding && !dedicatedGitRemoteBinding) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Broker Git remote binding is invalid.');
  }
  if (value.target.brokerTopologyMode === DEDICATED_CANARY_BROKER_TOPOLOGY
    && (value.target.brokerImageId !== value.target.recoveryHelperImageId
      || value.target.brokerRevision !== value.target.recoveryHelperRevision)) {
    fail(
      'HOST_RECOVERY_DESCRIPTOR_INVALID',
      'Dedicated Canary Broker must use the exact recovery helper image identity.',
    );
  }
  for (const key of ['harnessStartedAt', 'brokerStartedAt']) {
    if (typeof value.target[key] !== 'string' || !Number.isFinite(Date.parse(value.target[key]))) {
      fail('HOST_RECOVERY_DESCRIPTOR_INVALID', `${key} is invalid.`);
    }
  }
  if (value.target.harnessUser !== FIXED_USER || value.target.hostProxyPort !== FIXED_PROXY_PORT
    || value.target.brokerUser !== FIXED_USER || value.target.dshPort !== FIXED_DSH_PORT) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Harness/Broker user or fixed recovery ports are invalid.');
  }

  exactKeys(value.execution, [
    'actorId', 'actorUserId', 'conversationId', 'sessionId', 'sessionCwd', 'rpcId',
    'caseFamily', 'sourceCommit', 'workflowId', 'phaseId', 'phaseAttemptId',
    'executionId', 'claimId', 'generation', 'contractId', 'expectedBaselineSeq',
    'acceptedArtifactDigests', 'workspaceSnapshotDigest', 'cumulativePatchDigest',
  ], 'execution');
  requiredString(value.execution.actorId, ACTOR_ID, 'actorId');
  requiredString(value.execution.actorUserId, UUID, 'actorUserId');
  requiredString(value.execution.conversationId, CONVERSATION_ID, 'conversationId');
  requiredString(value.execution.sessionId, DSH_ID, 'sessionId');
  requiredString(value.execution.sessionCwd, SESSION_CWD, 'sessionCwd');
  requiredString(value.execution.rpcId, RPC_ID, 'rpcId');
  requiredString(value.execution.caseFamily, TASK_ID, 'caseFamily');
  requiredString(value.execution.sourceCommit, SOURCE_COMMIT, 'sourceCommit');
  requiredString(value.execution.workflowId, TASK_ID, 'workflowId');
  requiredString(value.execution.phaseId, TASK_ID, 'phaseId');
  for (const key of ['phaseAttemptId', 'executionId', 'claimId']) {
    requiredString(value.execution[key], UUID, key);
  }
  if (!Number.isSafeInteger(value.execution.generation) || value.execution.generation < 1
    || !Number.isSafeInteger(value.execution.expectedBaselineSeq)
    || value.execution.expectedBaselineSeq < 0) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Recovery generation or baseline sequence is invalid.');
  }
  requiredString(value.execution.contractId, SHA256, 'contractId');
  if (value.execution.acceptedArtifactDigests === null
    || typeof value.execution.acceptedArtifactDigests !== 'object'
    || Array.isArray(value.execution.acceptedArtifactDigests)
    || Object.keys(value.execution.acceptedArtifactDigests).length < 1
    || Object.entries(value.execution.acceptedArtifactDigests).some(([kind, digest]) => (
      !/^[a-z0-9][a-z0-9-]{1,63}$/u.test(kind) || !SHA256.test(digest)
    ))) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'acceptedArtifactDigests is invalid.');
  }
  requiredString(value.execution.workspaceSnapshotDigest, SHA256, 'workspaceSnapshotDigest');
  requiredString(value.execution.cumulativePatchDigest, SHA256, 'cumulativePatchDigest');

  exactKeys(value.paths, [
    'projectControlRoot', 'canaryRoot', 'runRoot', 'attemptDirectory', 'workspaceDirectory',
    'skillBundleRoot', 'skillBundleDirectory',
    'phaseControlDirectory', 'artifactsDirectory', 'phaseStateFile',
    'maintenanceDirectory', 'maintenanceFenceFile',
    'deepseekKeyFile', 'kimiKeyFile', 'glmKeyFile',
    'evidenceDirectory', 'promptFile', 'executionPolicyFile', 'phaseCatalogFile',
    'prepareReceiptFile', 'workspaceSnapshotFile',
  ], 'paths');
  const normalizedPaths = {};
  for (const [key, candidate] of Object.entries(value.paths)) {
    normalizedPaths[key] = requireHostPath(candidate, allowedRoot, key);
  }
  if (path.dirname(normalizedPaths.phaseStateFile) !== normalizedPaths.phaseControlDirectory
    || path.dirname(normalizedPaths.maintenanceFenceFile) !== normalizedPaths.maintenanceDirectory) {
    fail('HOST_RECOVERY_PATH_INVALID', 'Phase state or maintenance fence escaped its declared directory.');
  }
  if (new Set([
    normalizedPaths.deepseekKeyFile, normalizedPaths.kimiKeyFile, normalizedPaths.glmKeyFile,
  ]).size !== 3) {
    fail('HOST_RECOVERY_PATH_INVALID', 'Harness secret mount sources must be distinct files.');
  }
  const expectedCanaryRoot = path.join(path.resolve(allowedRoot), 'canary', value.target.canaryId);
  const expectedSecretRoot = path.join(path.resolve(allowedRoot), 'secrets');
  const expectedGlmKeyFile = value.target.brokerTopologyMode === DEDICATED_CANARY_BROKER_TOPOLOGY
    ? path.join(expectedCanaryRoot, 'secrets', 'glm-api-key-unconfigured')
    : path.join(expectedSecretRoot, 'glm-api-key');
  if (normalizedPaths.deepseekKeyFile !== path.join(expectedSecretRoot, 'deepseek-api-key')
    || normalizedPaths.kimiKeyFile !== path.join(expectedSecretRoot, 'kimi-api-key')
    || normalizedPaths.glmKeyFile !== expectedGlmKeyFile) {
    fail('HOST_RECOVERY_PATH_INVALID', 'Harness secret mount sources are not the canonical provider key files.');
  }
  const expectedTaskRoot = path.join(
    normalizedPaths.projectControlRoot, 'taskspaces', value.target.taskId,
  );
  if (path.dirname(path.dirname(normalizedPaths.projectControlRoot)) !== path.resolve(allowedRoot)
    || path.basename(path.dirname(normalizedPaths.projectControlRoot)) !== 'projects'
    || path.basename(normalizedPaths.projectControlRoot) !== value.target.projectSlug
    || path.basename(normalizedPaths.evidenceDirectory) !== value.operation.operationId
    || path.basename(path.dirname(normalizedPaths.evidenceDirectory)) !== 'recovery-evidence') {
    fail('HOST_RECOVERY_PATH_INVALID', 'Project or operation evidence directory is not canonically scoped.');
  }
  if (normalizedPaths.maintenanceDirectory !== path.join(expectedTaskRoot, 'maintenance')) {
    fail('HOST_RECOVERY_PATH_INVALID', 'Maintenance directory is not the exact TaskSpace maintenance root.');
  }
  if (normalizedPaths.workspaceDirectory !== path.join(expectedTaskRoot, 'workspace')) {
    fail('HOST_RECOVERY_PATH_INVALID', 'Workspace directory is not the exact TaskSpace workspace.');
  }
  const expectedRunRoot = path.join(expectedCanaryRoot, 'runs', value.target.runId);
  const expectedAttemptDirectory = path.join(
    expectedRunRoot, 'phases', value.target.attemptDirectoryName,
  );
  const expectedSkillBundleDirectory = path.join(
    expectedCanaryRoot, 'skill-bundles', 'versions', value.target.skillBundleVersion, 'skills',
  );
  if (normalizedPaths.canaryRoot !== expectedCanaryRoot
    || normalizedPaths.runRoot !== expectedRunRoot
    || normalizedPaths.attemptDirectory !== expectedAttemptDirectory
    || normalizedPaths.skillBundleRoot !== path.join(expectedCanaryRoot, 'skill-bundles')
    || normalizedPaths.skillBundleDirectory !== expectedSkillBundleDirectory
    || normalizedPaths.phaseControlDirectory !== path.join(expectedRunRoot, 'controller')
    || normalizedPaths.artifactsDirectory !== path.join(expectedRunRoot, 'controller', 'artifacts')
    || normalizedPaths.phaseStateFile !== path.join(expectedRunRoot, 'controller', 'state.json')
    || normalizedPaths.evidenceDirectory !== path.join(
      expectedRunRoot, 'recovery-evidence', value.operation.operationId,
    )
    || normalizedPaths.promptFile !== path.join(expectedAttemptDirectory, 'prompt.md')
    || normalizedPaths.prepareReceiptFile !== path.join(expectedAttemptDirectory, 'prepare-receipt.json')
    || normalizedPaths.workspaceSnapshotFile !== path.join(
      expectedAttemptDirectory, 'recovery-workspace-snapshot.json',
    )) {
    fail('HOST_RECOVERY_PATH_INVALID', 'Run, phase, attempt, evidence, or recovery input paths are not canonically scoped.');
  }
  if (!relativeInside(path.join(expectedCanaryRoot, 'policies'), normalizedPaths.executionPolicyFile)
    || normalizedPaths.phaseCatalogFile !== path.join(
      expectedSkillBundleDirectory, 'forge-task-router', 'references', 'phase-profiles.json',
    )) {
    fail('HOST_RECOVERY_PATH_INVALID', 'Policy or phase catalog escaped the canonical Canary authority roots.');
  }

  exactKeys(value.digests, [
    'promptFileSha256', 'promptTextSha256', 'executionPolicySha256', 'phaseCatalogSha256',
    'phaseStateSha256', 'executionStateSha256', 'taskspaceMetadataSha256',
    'prepareReceiptSha256', 'workspaceSnapshotFileSha256',
  ], 'digests');
  for (const [key, digest] of Object.entries(value.digests)) requiredString(digest, SHA256, key);
  if (descriptorDigest(value) !== value.operation.descriptorSha256) {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Descriptor digest does not match its canonical content.');
  }
  return Object.freeze({ descriptor: structuredClone(value), allowedRoot: path.resolve(allowedRoot), paths: normalizedPaths });
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function stableOrdinaryFile(file, maxBytes, label) {
  const resolved = await realpath(file).catch(() => undefined);
  const expected = path.resolve(file);
  const before = await lstat(file).catch(() => undefined);
  if (resolved !== expected || before === undefined || !before.isFile() || before.isSymbolicLink()
    || before.nlink !== 1 || before.size < 1 || before.size > maxBytes) {
    fail('HOST_RECOVERY_INPUT_INVALID', `${label} is not a bounded canonical ordinary file.`);
  }
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs) {
    fail('HOST_RECOVERY_INPUT_DRIFT', `${label} changed while it was hashed.`);
  }
  return Object.freeze({ bytes, sha256: sha256(bytes), stat: before });
}

async function canonicalDirectory(directory, label) {
  const resolved = await realpath(directory).catch(() => undefined);
  const information = await lstat(directory).catch(() => undefined);
  if (resolved !== path.resolve(directory) || information === undefined
    || !information.isDirectory() || information.isSymbolicLink()) {
    fail('HOST_RECOVERY_INPUT_INVALID', `${label} is not a canonical ordinary directory.`);
  }
  return information;
}

export function validateRecoverySecretSourceMetadata(
  information,
  { label, expectedUid, expectedGid, expectedMode, expectedSize },
) {
  const invalidSize = expectedSize === undefined
    ? information?.size < 1
    : information?.size !== expectedSize;
  if (information === undefined || typeof information.isFile !== 'function'
    || typeof information.isSymbolicLink !== 'function'
    || !information.isFile() || information.isSymbolicLink() || information.nlink !== 1
    || invalidSize || information.uid !== expectedUid || information.gid !== expectedGid
    || (information.mode & 0o7777) !== expectedMode) {
    fail('HOST_RECOVERY_SECRET_SOURCE_INVALID', `${label} is not the exact private ordinary file.`);
  }
  return true;
}

async function validateCanonicalSecretMountSources(descriptor, paths) {
  const sharedProviderSecret = Object.freeze({ expectedUid: 0, expectedGid: FIXED_GID, expectedMode: 0o640 });
  const glmSecret = descriptor.target.brokerTopologyMode === DEDICATED_CANARY_BROKER_TOPOLOGY
    ? Object.freeze({ expectedUid: 0, expectedGid: 0, expectedMode: 0o400, expectedSize: 0 })
    : sharedProviderSecret;
  for (const [label, file, expected] of [
    ['DeepSeek key', paths.deepseekKeyFile, sharedProviderSecret],
    ['Kimi key', paths.kimiKeyFile, sharedProviderSecret],
    ['GLM key', paths.glmKeyFile, glmSecret],
  ]) {
    const [resolved, information] = await Promise.all([
      realpath(file).catch(() => undefined),
      lstat(file).catch(() => undefined),
    ]);
    if (resolved !== path.resolve(file)) {
      fail('HOST_RECOVERY_SECRET_SOURCE_INVALID', `${label} is not a canonical private ordinary file.`);
    }
    validateRecoverySecretSourceMetadata(information, { label, ...expected });
  }
  return true;
}

async function snapshotExclusive(bytes, destination) {
  const handle = await open(destination, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o444);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(destination, 0o444);
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    await chown(destination, FIXED_UID, FIXED_GID);
  }
  await syncDirectory(path.dirname(destination));
}

async function writeExclusive(file, bytes, mode = 0o600) {
  const handle = await open(file, 'wx', mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function atomicReplace(file, bytes, { mode, uid, gid }) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== 'win32') await chown(temporary, uid, gid);
  await rename(temporary, file);
  await syncDirectory(directory);
}

function helperAccessBits(information) {
  const mode = information.mode & 0o777;
  if (information.uid === FIXED_UID) return (mode & 0o700) >> 6;
  if (information.gid === FIXED_GID) return (mode & 0o070) >> 3;
  return mode & 0o007;
}

function assertHelperDirectoryAccess(information, label, { writable, enforce }) {
  if (!enforce) return;
  const permissions = information.mode & 0o777;
  const required = writable ? 0b111 : 0b101;
  if ((permissions & 0o002) !== 0 || (helperAccessBits(information) & required) !== required) {
    fail(
      'HOST_RECOVERY_DIRECTORY_PERMISSION_INVALID',
      `${label} is world-writable or is not ${writable ? 'readable/writable/traversable' : 'readable/traversable'} by the fixed helper identity.`,
    );
  }
}

function assertHelperFileReadable(information, label, enforce) {
  if (!enforce) return;
  const permissions = information.mode & 0o777;
  if ((permissions & 0o002) !== 0 || (helperAccessBits(information) & 0b100) === 0) {
    fail('HOST_RECOVERY_FILE_PERMISSION_INVALID', `${label} is world-writable or unreadable by the fixed helper identity.`);
  }
}

function hostRecoveryFilePaths(descriptor, paths) {
  const executionStateFile = path.join(
    paths.projectControlRoot, 'taskspaces', '.broker', 'executions', `${descriptor.target.taskId}.json`,
  );
  const taskspaceMetadataFile = path.join(
    paths.projectControlRoot, 'taskspaces', descriptor.target.taskId, 'metadata.json',
  );
  return Object.freeze({
    promptFile: paths.promptFile,
    executionPolicyFile: paths.executionPolicyFile,
    phaseCatalogFile: paths.phaseCatalogFile,
    phaseStateFile: paths.phaseStateFile,
    executionStateFile,
    taskspaceMetadataFile,
    prepareReceiptFile: paths.prepareReceiptFile,
    workspaceSnapshotFile: paths.workspaceSnapshotFile,
  });
}

const HOST_RECOVERY_DIGEST_MAPPING = Object.freeze({
  promptFile: 'promptFileSha256',
  executionPolicyFile: 'executionPolicySha256',
  phaseCatalogFile: 'phaseCatalogSha256',
  phaseStateFile: 'phaseStateSha256',
  executionStateFile: 'executionStateSha256',
  taskspaceMetadataFile: 'taskspaceMetadataSha256',
  prepareReceiptFile: 'prepareReceiptSha256',
  workspaceSnapshotFile: 'workspaceSnapshotFileSha256',
});

function parseJsonBytes(bytes, code, label) {
  try { return JSON.parse(bytes.toString('utf8')); } catch {
    fail(code, `${label} is not valid JSON.`);
  }
}

function validatePhaseStateRecoveryBinding(bytes, descriptor) {
  const state = parseJsonBytes(bytes, 'HOST_RECOVERY_PHASE_STATE_INVALID', 'Phase state');
  const { execution, target } = descriptor;
  const attempt = state?.activeAttempt;
  if (state?.schemaVersion !== 'forge-delivery-phase-state/v1'
    || state.workflowId !== execution.workflowId || state.taskId !== target.taskId
    || state.sessionId !== execution.sessionId || state.sourceCommit !== execution.sourceCommit
    || state.status !== 'active' || state.currentPhaseId !== execution.phaseId
    || JSON.stringify(state.acceptedArtifacts) !== JSON.stringify(execution.acceptedArtifactDigests)
    || attempt?.attemptId !== execution.phaseAttemptId || attempt?.phaseId !== execution.phaseId
    || attempt?.rpcId !== execution.rpcId || attempt?.executionGeneration !== execution.generation
    || attempt?.sessionMode !== 'resume' || attempt?.promptDigest !== descriptor.digests.promptTextSha256) {
    fail(
      'HOST_RECOVERY_PHASE_STATE_INVALID',
      'Phase state no longer binds the exact active attempt, accepted artifacts, prompt, or source identity.',
    );
  }
  return state;
}

let workspaceObserverModule;
async function loadWorkspaceObserverModule() {
  if (workspaceObserverModule !== undefined) return workspaceObserverModule;
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, '..', 'docker', 'harness', 'forge-delivery-phase-workspace-observer.mjs'),
    path.resolve(moduleDirectory, '..', 'lib', 'forge-delivery-phase-workspace-observer.mjs'),
  ];
  for (const candidate of candidates) {
    const resolved = await realpath(candidate).catch(() => undefined);
    if (resolved === undefined || !sameCanonicalHostPath(resolved, candidate)) continue;
    workspaceObserverModule = await import(pathToFileURL(candidate).href);
    if (typeof workspaceObserverModule.snapshotForgeDeliveryWorkspace !== 'function'
      || typeof workspaceObserverModule.validateForgeDeliveryWorkspaceSnapshot !== 'function') {
      fail('HOST_RECOVERY_WORKSPACE_OBSERVER_INVALID', 'Versioned workspace observer exports are incomplete.');
    }
    return workspaceObserverModule;
  }
  fail('HOST_RECOVERY_WORKSPACE_OBSERVER_INVALID', 'Versioned workspace observer is unavailable.');
}

let phaseRuntimeModule;
async function loadPhaseRuntimeModule() {
  if (phaseRuntimeModule !== undefined) return phaseRuntimeModule;
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, '..', 'docker', 'harness', 'forge-delivery-phase-runtime.mjs'),
    path.resolve(moduleDirectory, '..', 'lib', 'forge-delivery-phase-runtime.mjs'),
  ];
  for (const candidate of candidates) {
    const resolved = await realpath(candidate).catch(() => undefined);
    if (resolved === undefined || !sameCanonicalHostPath(resolved, candidate)) continue;
    phaseRuntimeModule = await import(pathToFileURL(candidate).href);
    if (typeof phaseRuntimeModule.validateForgeDeliveryPhaseArtifact !== 'function') {
      fail('HOST_RECOVERY_PHASE_RUNTIME_INVALID', 'Versioned phase runtime exports are incomplete.');
    }
    return phaseRuntimeModule;
  }
  fail('HOST_RECOVERY_PHASE_RUNTIME_INVALID', 'Versioned phase runtime is unavailable.');
}

async function validateAcceptedArtifactsRecoveryBinding(descriptor, paths) {
  const runtime = await loadPhaseRuntimeModule();
  for (const [kind, expectedDigest] of Object.entries(descriptor.execution.acceptedArtifactDigests)) {
    const artifactFile = path.join(paths.artifactsDirectory, `${kind}.json`);
    if (!relativeInside(paths.artifactsDirectory, artifactFile)) {
      fail('HOST_RECOVERY_ARTIFACT_INVALID', 'Accepted phase artifact escaped its exact directory.');
    }
    const input = await stableOrdinaryFile(artifactFile, MAX_INPUT_BYTES, `accepted artifact ${kind}`);
    let artifact;
    try {
      artifact = runtime.validateForgeDeliveryPhaseArtifact(parseJsonBytes(
        input.bytes, 'HOST_RECOVERY_ARTIFACT_INVALID', `Accepted artifact ${kind}`,
      ));
    } catch (error) {
      if (error instanceof HostRecoveryError) throw error;
      fail('HOST_RECOVERY_ARTIFACT_INVALID', `Accepted artifact ${kind} is invalid: ${error.message}`);
    }
    if (artifact.workflowId !== descriptor.execution.workflowId
      || artifact.artifactKind !== kind || artifact.artifactDigest !== expectedDigest) {
      fail('HOST_RECOVERY_ARTIFACT_INVALID', `Accepted artifact ${kind} no longer matches phase state.`);
    }
  }
  return true;
}

async function validateWorkspaceRecoveryBinding(descriptor, paths, snapshotBytes) {
  const observer = await loadWorkspaceObserverModule();
  let recorded;
  try {
    recorded = observer.validateForgeDeliveryWorkspaceSnapshot(parseJsonBytes(
      snapshotBytes, 'HOST_RECOVERY_WORKSPACE_IDENTITY_INVALID', 'Workspace recovery snapshot',
    ));
  } catch (error) {
    if (error instanceof HostRecoveryError) throw error;
    fail('HOST_RECOVERY_WORKSPACE_IDENTITY_INVALID', `Workspace recovery snapshot is invalid: ${error.message}`);
  }
  if (recorded.baseCommit !== descriptor.execution.sourceCommit
    || recorded.snapshotDigest !== descriptor.execution.workspaceSnapshotDigest
    || recorded.cumulativePatchDigest !== descriptor.execution.cumulativePatchDigest) {
    fail('HOST_RECOVERY_WORKSPACE_IDENTITY_INVALID', 'Recorded workspace snapshot does not match the descriptor.');
  }
  const live = await observer.snapshotForgeDeliveryWorkspace({
    workspace: paths.workspaceDirectory,
    baseCommit: descriptor.execution.sourceCommit,
  });
  if (live.snapshotDigest !== recorded.snapshotDigest
    || live.cumulativePatchDigest !== recorded.cumulativePatchDigest
    || JSON.stringify(live.changedPaths) !== JSON.stringify(recorded.changedPaths)) {
    fail('HOST_RECOVERY_WORKSPACE_DRIFT', 'TaskSpace workspace content or cumulative patch drifted.');
  }
  return Object.freeze({
    snapshotDigest: live.snapshotDigest,
    cumulativePatchDigest: live.cumulativePatchDigest,
    changedPaths: Object.freeze([...live.changedPaths]),
  });
}

async function persistValidatedPreModelWorkspaceSnapshot(descriptor, paths) {
  const observer = await loadWorkspaceObserverModule();
  const snapshot = await observer.snapshotForgeDeliveryWorkspace({
    workspace: paths.workspaceDirectory,
    baseCommit: descriptor.execution.sourceCommit,
  });
  if (snapshot.snapshotDigest !== descriptor.execution.workspaceSnapshotDigest
    || snapshot.cumulativePatchDigest !== descriptor.execution.cumulativePatchDigest) {
    fail('HOST_RECOVERY_WORKSPACE_DRIFT', 'TaskSpace workspace drifted before the recovery helper started.');
  }

  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  const file = path.join(paths.evidenceDirectory, 'before-snapshot.json');
  await snapshotExclusive(bytes, file).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await stableOrdinaryFile(file, MAX_INPUT_BYTES, 'pre-model workspace snapshot');
    if (!existing.bytes.equals(bytes)) {
      fail('HOST_RECOVERY_WORKSPACE_DRIFT', 'Existing pre-model workspace snapshot differs from the live TaskSpace.');
    }
  });

  const persisted = await stableOrdinaryFile(file, MAX_INPUT_BYTES, 'pre-model workspace snapshot');
  let validated;
  try {
    validated = observer.validateForgeDeliveryWorkspaceSnapshot(parseJsonBytes(
      persisted.bytes,
      'HOST_RECOVERY_WORKSPACE_IDENTITY_INVALID',
      'Pre-model workspace snapshot',
    ));
  } catch (error) {
    if (error instanceof HostRecoveryError) throw error;
    fail(
      'HOST_RECOVERY_WORKSPACE_IDENTITY_INVALID',
      `Pre-model workspace snapshot is invalid: ${error.message}`,
    );
  }
  const liveAfterPersistence = await observer.snapshotForgeDeliveryWorkspace({
    workspace: paths.workspaceDirectory,
    baseCommit: descriptor.execution.sourceCommit,
  });
  if (validated.snapshotDigest !== snapshot.snapshotDigest
    || liveAfterPersistence.snapshotDigest !== snapshot.snapshotDigest
    || validated.cumulativePatchDigest !== snapshot.cumulativePatchDigest
    || liveAfterPersistence.cumulativePatchDigest !== snapshot.cumulativePatchDigest
    || JSON.stringify(validated.changedPaths) !== JSON.stringify(snapshot.changedPaths)
    || JSON.stringify(liveAfterPersistence.changedPaths) !== JSON.stringify(snapshot.changedPaths)) {
    fail('HOST_RECOVERY_WORKSPACE_DRIFT', 'TaskSpace workspace changed while its pre-model snapshot was persisted.');
  }
  return Object.freeze({
    file,
    sha256: persisted.sha256,
    snapshotDigest: validated.snapshotDigest,
    cumulativePatchDigest: validated.cumulativePatchDigest,
    changedPaths: Object.freeze([...validated.changedPaths]),
  });
}

async function collectAndValidateHostRecoveryFiles(descriptor, paths, filePaths, enforceHostOwnership) {
  const files = {};
  for (const [key, file] of Object.entries(filePaths)) {
    files[key] = await stableOrdinaryFile(file, MAX_INPUT_BYTES, key);
    if (files[key].sha256 !== descriptor.digests[HOST_RECOVERY_DIGEST_MAPPING[key]]) {
      fail('HOST_RECOVERY_INPUT_DRIFT', `${key} digest drifted from the descriptor.`);
    }
  }
  const normalizedPrompt = files.promptFile.bytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  if (digestDirectUserTextContent([{ type: 'text', text: normalizedPrompt }])
    !== descriptor.digests.promptTextSha256) {
    fail('HOST_RECOVERY_INPUT_DRIFT', 'Canonical prompt text digest drifted from the descriptor.');
  }
  assertHelperFileReadable(files.phaseStateFile.stat, 'phase state', enforceHostOwnership);
  assertHelperFileReadable(files.executionStateFile.stat, 'execution state', enforceHostOwnership);
  assertHelperFileReadable(files.taskspaceMetadataFile.stat, 'TaskSpace metadata', enforceHostOwnership);
  validatePhaseStateRecoveryBinding(files.phaseStateFile.bytes, descriptor);
  return files;
}

function assertRecoveryMountTopology(paths, executionStateDirectory, inputDirectory) {
  const sources = {
    project: paths.projectControlRoot,
    execution: executionStateDirectory,
    phase: paths.phaseControlDirectory,
    input: inputDirectory,
    evidence: paths.evidenceDirectory,
    maintenance: paths.maintenanceDirectory,
  };
  const allowedOverlaps = new Set(['execution\0project', 'maintenance\0project']);
  const entries = Object.entries(sources);
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [leftName, leftPath] = entries[leftIndex];
      const [rightName, rightPath] = entries[rightIndex];
      if (!pathsOverlap(leftPath, rightPath)) continue;
      const key = [leftName, rightName].sort().join('\0');
      if (!allowedOverlaps.has(key)) {
        fail(
          'HOST_RECOVERY_MOUNT_OVERLAP',
          `Recovery mount sources ${leftName} and ${rightName} overlap outside the reviewed narrow overlay topology.`,
        );
      }
    }
  }
}

export async function prepareHostRecoveryInputs(validated, { enforceHostOwnership = false } = {}) {
  const { descriptor, paths } = validated;
  if (enforceHostOwnership) await validateCanonicalSecretMountSources(descriptor, paths);
  for (const [directory, label] of [
    [paths.projectControlRoot, 'project control root'],
    [paths.canaryRoot, 'Canary root'],
    [paths.runRoot, 'run root'],
    [paths.attemptDirectory, 'attempt directory'],
    [paths.workspaceDirectory, 'TaskSpace workspace'],
    [paths.skillBundleRoot, 'external Skill bundle root'],
    [paths.skillBundleDirectory, 'external Skill bundle'],
    [paths.phaseControlDirectory, 'phase control directory'],
    [paths.artifactsDirectory, 'accepted artifacts directory'],
    [paths.maintenanceDirectory, 'maintenance directory'],
    [paths.evidenceDirectory, 'evidence directory'],
  ]) await canonicalDirectory(directory, label);
  const activeSkillDirectory = await realpath(path.join(paths.skillBundleRoot, 'current', 'skills')).catch(() => undefined);
  if (activeSkillDirectory !== paths.skillBundleDirectory) {
    fail('HOST_RECOVERY_SKILL_BUNDLE_DRIFT', 'Active external Skill bundle does not match the pinned version.');
  }

  const filePaths = hostRecoveryFilePaths(descriptor, paths);
  const executionStateFile = filePaths.executionStateFile;
  const taskspaceMetadataFile = filePaths.taskspaceMetadataFile;
  const executionStateDirectoryInformation = await canonicalDirectory(
    path.dirname(executionStateFile), 'execution state directory',
  );
  assertHelperDirectoryAccess(executionStateDirectoryInformation, 'execution state directory', {
    writable: true, enforce: enforceHostOwnership,
  });
  assertHelperDirectoryAccess(
    await canonicalDirectory(paths.phaseControlDirectory, 'phase control directory'),
    'phase control directory', { writable: true, enforce: enforceHostOwnership },
  );
  assertHelperDirectoryAccess(
    await canonicalDirectory(paths.evidenceDirectory, 'evidence directory'),
    'evidence directory', { writable: true, enforce: enforceHostOwnership },
  );
  const files = await collectAndValidateHostRecoveryFiles(
    descriptor, paths, filePaths, enforceHostOwnership,
  );
  const workspaceIdentity = await validateWorkspaceRecoveryBinding(
    descriptor, paths, files.workspaceSnapshotFile.bytes,
  );
  await validateAcceptedArtifactsRecoveryBinding(descriptor, paths);

  const operationRoot = path.dirname(path.dirname(paths.evidenceDirectory));
  const inputRoot = path.join(operationRoot, 'recovery-input');
  const inputDirectory = path.join(inputRoot, descriptor.operation.operationId);
  await mkdir(inputRoot, { recursive: true, mode: 0o700 });
  await canonicalDirectory(inputRoot, 'recovery input root');
  await mkdir(inputDirectory, { mode: 0o700 }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  await canonicalDirectory(inputDirectory, 'operation input snapshot');
  assertRecoveryMountTopology(paths, path.dirname(executionStateFile), inputDirectory);
  const snapshots = {
    promptFile: path.join(inputDirectory, 'prompt.md'),
    executionPolicyFile: path.join(inputDirectory, 'execution-policy.json'),
    phaseCatalogFile: path.join(inputDirectory, 'phase-catalog.json'),
    prepareReceiptFile: path.join(inputDirectory, 'prepare-receipt.json'),
  };
  for (const [key, destination] of Object.entries(snapshots)) {
    await snapshotExclusive(files[key].bytes, destination).catch(async (error) => {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await stableOrdinaryFile(destination, MAX_INPUT_BYTES, `${key} snapshot`);
      if (existing.sha256 !== files[key].sha256) {
        fail('HOST_RECOVERY_INPUT_DRIFT', `${key} snapshot already exists with different content.`);
      }
    });
    const snapshot = await stableOrdinaryFile(destination, MAX_INPUT_BYTES, `${key} snapshot`);
    if (snapshot.sha256 !== files[key].sha256) {
      fail('HOST_RECOVERY_INPUT_DRIFT', `${key} snapshot does not match the bytes that were validated.`);
    }
  }
  if (enforceHostOwnership) {
    await chown(inputDirectory, FIXED_UID, FIXED_GID);
    await chmod(inputDirectory, 0o500);
  }
  assertHelperDirectoryAccess(await canonicalDirectory(inputDirectory, 'operation input snapshot'),
    'operation input snapshot', { writable: false, enforce: enforceHostOwnership });
  await syncDirectory(inputDirectory);
  return Object.freeze({
    executionStateDirectory: path.dirname(executionStateFile),
    executionStateFile,
    taskspaceMetadataFile,
    filePaths,
    inputDirectory,
    enforceHostOwnership,
    snapshots,
    workspaceIdentity,
  });
}

export async function prepareHostRecoveryReconciliationInputs(
  validated,
  { enforceHostOwnership = false } = {},
) {
  const { descriptor, paths } = validated;
  if (enforceHostOwnership) await validateCanonicalSecretMountSources(descriptor, paths);
  for (const [directory, label] of [
    [paths.projectControlRoot, 'project control root'],
    [paths.phaseControlDirectory, 'phase control directory'],
    [paths.maintenanceDirectory, 'maintenance directory'],
    [paths.evidenceDirectory, 'evidence directory'],
  ]) await canonicalDirectory(directory, label);
  const operationRoot = path.dirname(path.dirname(paths.evidenceDirectory));
  const inputDirectory = path.join(
    operationRoot, 'recovery-input', descriptor.operation.operationId,
  );
  await canonicalDirectory(inputDirectory, 'operation input snapshot');
  const snapshots = {
    promptFile: path.join(inputDirectory, 'prompt.md'),
    executionPolicyFile: path.join(inputDirectory, 'execution-policy.json'),
    phaseCatalogFile: path.join(inputDirectory, 'phase-catalog.json'),
    prepareReceiptFile: path.join(inputDirectory, 'prepare-receipt.json'),
  };
  for (const [key, snapshotPath] of Object.entries(snapshots)) {
    const snapshot = await stableOrdinaryFile(snapshotPath, MAX_INPUT_BYTES, `${key} snapshot`);
    if (snapshot.sha256 !== descriptor.digests[HOST_RECOVERY_DIGEST_MAPPING[key]]) {
      fail('HOST_RECOVERY_INPUT_DRIFT', `${key} immutable snapshot drifted before reconciliation.`);
    }
  }
  const prompt = await stableOrdinaryFile(snapshots.promptFile, MAX_INPUT_BYTES, 'prompt snapshot');
  const normalizedPrompt = prompt.bytes.toString('utf8').replace(/(?:\r?\n)+$/u, '');
  if (digestDirectUserTextContent([{ type: 'text', text: normalizedPrompt }])
    !== descriptor.digests.promptTextSha256) {
    fail('HOST_RECOVERY_INPUT_DRIFT', 'Canonical prompt snapshot drifted before reconciliation.');
  }
  assertHelperDirectoryAccess(
    await canonicalDirectory(inputDirectory, 'operation input snapshot'),
    'operation input snapshot', { writable: false, enforce: enforceHostOwnership },
  );
  return Object.freeze({
    executionStateDirectory: path.join(paths.projectControlRoot, 'taskspaces', '.broker', 'executions'),
    inputDirectory,
    enforceHostOwnership,
    snapshots,
  });
}

export async function revalidateHostRecoveryInputs(validated, prepared) {
  const { descriptor, paths } = validated;
  if (prepared.enforceHostOwnership === true) await validateCanonicalSecretMountSources(descriptor, paths);
  const expectedPaths = hostRecoveryFilePaths(descriptor, paths);
  if (JSON.stringify(expectedPaths) !== JSON.stringify(prepared.filePaths)) {
    fail('HOST_RECOVERY_INPUT_DRIFT', 'Prepared live input paths no longer match the descriptor.');
  }
  const activeSkillDirectory = await realpath(path.join(paths.skillBundleRoot, 'current', 'skills')).catch(() => undefined);
  if (activeSkillDirectory !== paths.skillBundleDirectory) {
    fail('HOST_RECOVERY_SKILL_BUNDLE_DRIFT', 'Active external Skill bundle changed after preparation.');
  }
  const files = await collectAndValidateHostRecoveryFiles(
    descriptor, paths, expectedPaths, prepared.enforceHostOwnership === true,
  );
  const workspaceIdentity = await validateWorkspaceRecoveryBinding(
    descriptor, paths, files.workspaceSnapshotFile.bytes,
  );
  if (workspaceIdentity.snapshotDigest !== prepared.workspaceIdentity.snapshotDigest
    || workspaceIdentity.cumulativePatchDigest !== prepared.workspaceIdentity.cumulativePatchDigest
    || JSON.stringify(workspaceIdentity.changedPaths) !== JSON.stringify(prepared.workspaceIdentity.changedPaths)) {
    fail('HOST_RECOVERY_WORKSPACE_DRIFT', 'TaskSpace workspace identity changed after preparation.');
  }
  await validateAcceptedArtifactsRecoveryBinding(descriptor, paths);
  assertHelperDirectoryAccess(
    await canonicalDirectory(prepared.executionStateDirectory, 'execution state directory'),
    'execution state directory', { writable: true, enforce: prepared.enforceHostOwnership === true },
  );
  assertHelperDirectoryAccess(
    await canonicalDirectory(paths.phaseControlDirectory, 'phase control directory'),
    'phase control directory', { writable: true, enforce: prepared.enforceHostOwnership === true },
  );
  assertHelperDirectoryAccess(
    await canonicalDirectory(paths.evidenceDirectory, 'evidence directory'),
    'evidence directory', { writable: true, enforce: prepared.enforceHostOwnership === true },
  );
  assertHelperDirectoryAccess(
    await canonicalDirectory(prepared.inputDirectory, 'operation input snapshot'),
    'operation input snapshot', { writable: false, enforce: prepared.enforceHostOwnership === true },
  );
  for (const [key, snapshotPath] of Object.entries(prepared.snapshots)) {
    const snapshot = await stableOrdinaryFile(snapshotPath, MAX_INPUT_BYTES, `${key} snapshot`);
    if (snapshot.sha256 !== descriptor.digests[HOST_RECOVERY_DIGEST_MAPPING[key]]) {
      fail('HOST_RECOVERY_INPUT_DRIFT', `${key} snapshot drifted after preparation.`);
    }
  }
  return true;
}

function envMap(values) {
  const result = new Map();
  for (const entry of values ?? []) {
    const separator = entry.indexOf('=');
    const key = separator < 0 ? entry : entry.slice(0, separator);
    const value = separator < 0 ? '' : entry.slice(separator + 1);
    if (result.has(key)) fail('HOST_RECOVERY_CONTAINER_INVALID', `Container environment repeats ${key}.`);
    result.set(key, value);
  }
  return result;
}

function runtimeEnvironmentIsSafe(environment) {
  return environment.get('PATH') === SAFE_RUNTIME_PATH
    && environment.get('NODE_PATH') === SAFE_NODE_PATH
    && [...FORBIDDEN_RUNTIME_ENVIRONMENT].every((key) => !environment.has(key));
}

function hasNoNewPrivileges(options) {
  return Array.isArray(options) && options.length === 1
    && options[0] === 'no-new-privileges:true';
}

function hasCapDropAll(value) {
  return Array.isArray(value) && value.length === 1 && String(value[0]).toUpperCase() === 'ALL';
}

function emptyDockerList(value) {
  return value === undefined || value === null || (Array.isArray(value) && value.length === 0);
}

function constrainedDockerHostBoundary(hostConfig, { restartPolicy, networkModes }) {
  const networkMode = hostConfig?.NetworkMode ?? '';
  return hasCapDropAll(hostConfig?.CapDrop)
    && emptyDockerList(hostConfig?.CapAdd)
    && hasNoNewPrivileges(hostConfig?.SecurityOpt)
    && emptyDockerList(hostConfig?.Devices)
    && emptyDockerList(hostConfig?.DeviceRequests)
    && emptyDockerList(hostConfig?.ExtraHosts)
    && emptyDockerList(hostConfig?.Links)
    && emptyDockerList(hostConfig?.Dns)
    && emptyDockerList(hostConfig?.DnsOptions)
    && emptyDockerList(hostConfig?.DnsSearch)
    && ['', 'private'].includes(hostConfig?.IpcMode ?? '')
    && (hostConfig?.PidMode ?? '') === ''
    && (hostConfig?.UTSMode ?? '') === ''
    && hostConfig?.RestartPolicy?.Name === restartPolicy
    && hostConfig?.LogConfig?.Type === 'json-file'
    && hostConfig?.LogConfig?.Config?.['max-size'] === '20m'
    && hostConfig?.LogConfig?.Config?.['max-file'] === '5'
    && networkModes.includes(networkMode);
}

function constrainedBrokerResourceBoundary(hostConfig) {
  const tmpfs = hostConfig?.Tmpfs;
  if (tmpfs === null || typeof tmpfs !== 'object' || Array.isArray(tmpfs)
    || JSON.stringify(Object.keys(tmpfs).sort()) !== JSON.stringify(['/tmp'])) return false;
  const options = new Set(String(tmpfs['/tmp'] ?? '').split(',').filter(Boolean));
  return hostConfig?.PidsLimit === FIXED_BROKER_PIDS_LIMIT
    && hostConfig?.Memory === FIXED_BROKER_MEMORY_BYTES
    && hostConfig?.NanoCpus === FIXED_BROKER_NANO_CPUS
    && options.has('rw') && options.has('noexec') && options.has('nosuid')
    && options.has('size=512m')
    && !options.has('ro') && !options.has('exec') && !options.has('suid');
}

function dockerSocketMount(mounts) {
  return (mounts ?? []).some((mount) => [mount.Source, mount.Destination]
    .some((value) => typeof value === 'string' && /(?:^|\/)docker\.sock$/u.test(value)));
}

function hasPublishedPorts(ports) {
  return Object.values(ports ?? {}).some((bindings) => Array.isArray(bindings) && bindings.length > 0);
}

function exactMountAt(mounts, destination, { source, writable }) {
  const matches = (mounts ?? []).filter((mount) => mount.Destination === destination);
  return matches.length === 1 && matches[0].Type === 'bind'
    && path.resolve(matches[0].Source ?? '') === path.resolve(source)
    && matches[0].RW === writable;
}

function exactBindMountInventory(mounts, expected) {
  if (!Array.isArray(mounts) || mounts.length !== expected.length) return false;
  return expected.every((specification) => {
    const matches = mounts.filter((mount) => mount.Destination === specification.destination);
    if (matches.length !== 1 || matches[0].Type !== 'bind'
      || matches[0].RW !== specification.writable) return false;
    const actualSource = path.resolve(matches[0].Source ?? '');
    const sources = Array.isArray(specification.source)
      ? specification.source.map((source) => path.resolve(source))
      : [path.resolve(specification.source)];
    return sources.includes(actualSource);
  });
}

function exactNetworkInventory(networks, expected) {
  if (networks === null || typeof networks !== 'object' || Array.isArray(networks)) return false;
  const actualNames = Object.keys(networks).sort();
  const expectedNames = Object.keys(expected).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) return false;
  return expectedNames.every((name) => networks[name]?.NetworkID === expected[name]);
}

function harnessBindMountSpecifications(descriptor, paths) {
  const taskRoot = path.join(paths.projectControlRoot, 'taskspaces', descriptor.target.taskId);
  const allowedRoot = path.dirname(path.dirname(paths.projectControlRoot));
  const acceptedInputRoot = path.join(paths.projectControlRoot, 'shared-inputs', 'accepted');
  const readOnlyProjectRoot = descriptor.target.brokerTopologyMode === DEDICATED_CANARY_BROKER_TOPOLOGY
    ? path.join(paths.canaryRoot, 'project-shadow')
    : paths.projectControlRoot;
  return [
    { destination: '/workspace', source: path.join(taskRoot, 'workspace'), writable: true },
    { destination: '/workspace/PROJECT_CONTEXT.md', source: path.join(readOnlyProjectRoot, 'governance', 'PROJECT_CONTEXT.md'), writable: false },
    { destination: '/integration', source: path.join(readOnlyProjectRoot, 'workspace'), writable: false },
    { destination: '/home/node/.dsh', source: path.join(taskRoot, 'dsh-home'), writable: true },
    { destination: '/opt/forge-skill-bundles', source: paths.skillBundleRoot, writable: false },
    { destination: '/project-inputs', source: path.join(taskRoot, 'uploads'), writable: false },
    { destination: '/project-ftp-inputs', source: [path.join(allowedRoot, 'file-gateway', 'data', descriptor.target.projectSlug), acceptedInputRoot], writable: false },
    { destination: '/project-shared-inputs', source: acceptedInputRoot, writable: false },
    { destination: '/run/forge-taskspace/browser-access-token', source: path.join(taskRoot, 'tokens', 'browser'), writable: false },
    { destination: '/run/forge-taskspace/broker-token', source: path.join(taskRoot, 'tokens', 'broker'), writable: false },
    { destination: '/run/forge-conversation-auth', source: path.join(allowedRoot, 'conversation-control-plane', 'auth-ipc'), writable: false },
    { destination: '/run/forge-taskspace-maintenance', source: paths.maintenanceDirectory, writable: false },
    { destination: '/workspace/.forge-cache/m2', source: path.join(taskRoot, 'cache', 'm2'), writable: true },
    { destination: '/workspace/.forge-cache/npm', source: path.join(taskRoot, 'cache', 'npm'), writable: true },
    { destination: '/workspace/.forge-cache/pnpm', source: path.join(taskRoot, 'cache', 'pnpm'), writable: true },
    { destination: '/workspace/.forge-cache/general', source: path.join(taskRoot, 'cache', 'general'), writable: true },
    { destination: '/run/secrets/deepseek-api-key', source: paths.deepseekKeyFile, writable: false },
    { destination: '/run/secrets/kimi-api-key', source: paths.kimiKeyFile, writable: false },
    { destination: '/run/secrets/glm-api-key', source: paths.glmKeyFile, writable: false },
  ];
}

function brokerBindMountSpecifications(descriptor, paths) {
  if (descriptor.target.brokerTopologyMode === DEDICATED_CANARY_BROKER_TOPOLOGY) {
    return [
      { destination: path.join(paths.projectControlRoot, 'workspace'), source: path.join(paths.projectControlRoot, 'workspace'), writable: true },
      { destination: path.join(paths.projectControlRoot, 'taskspaces'), source: path.join(paths.projectControlRoot, 'taskspaces'), writable: true },
      { destination: '/run/forge-release', source: path.join(paths.projectControlRoot, 'ops', 'release-ipc'), writable: false },
      { destination: '/run/forge-verify', source: path.join(paths.projectControlRoot, 'verification', 'canary-host', 'ipc'), writable: false },
      { destination: '/broker-healthcheck.mjs', source: path.join(paths.canaryRoot, 'config', 'verification-admission', 'broker-healthcheck.mjs'), writable: false },
    ];
  }
  const allowedRoot = path.dirname(path.dirname(paths.projectControlRoot));
  return [
    { destination: path.join(paths.projectControlRoot, 'workspace'), source: path.join(paths.projectControlRoot, 'workspace'), writable: true },
    { destination: path.join(paths.projectControlRoot, 'taskspaces'), source: path.join(paths.projectControlRoot, 'taskspaces'), writable: true },
    { destination: '/run/forge-release', source: path.join(paths.projectControlRoot, 'ops', 'release-ipc'), writable: false },
    { destination: '/run/forge-verify', source: path.join(paths.projectControlRoot, 'verification', 'ipc'), writable: false },
    { destination: '/run/forge-acceptance-resolver', source: path.join(paths.projectControlRoot, 'acceptance', 'ipc-resolver'), writable: false },
    { destination: '/run/forge-git', source: path.join(allowedRoot, 'git-remotes', descriptor.target.projectSlug), writable: false },
  ];
}

function brokerNetworkSpecifications(descriptor) {
  const projectNetworkPrefix = `forge-${descriptor.target.projectSlug}`;
  if (descriptor.target.brokerTopologyMode === DEDICATED_CANARY_BROKER_TOPOLOGY) {
    return {
      [descriptor.target.brokerServiceNetworkName]: descriptor.target.brokerServiceNetworkId,
      [`${projectNetworkPrefix}_taskspaces`]: descriptor.target.brokerTaskspacesNetworkId,
    };
  }
  return {
    [`${projectNetworkPrefix}_taskspaces`]: descriptor.target.brokerTaskspacesNetworkId,
    [`${projectNetworkPrefix}_git-remote`]: descriptor.target.brokerGitRemoteNetworkId,
  };
}

export async function validateLiveContainerBindMounts(inspect, specifications) {
  if (process.platform !== 'linux') {
    fail('HOST_RECOVERY_MOUNT_IDENTITY_UNAVAILABLE', 'Live bind-mount inode validation requires Linux /proc.');
  }
  const value = Array.isArray(inspect) ? inspect[0] : inspect;
  const pid = value?.State?.Pid;
  if (!Number.isSafeInteger(pid) || pid < 1
    || !exactBindMountInventory(value?.Mounts, specifications)) {
    fail('HOST_RECOVERY_MOUNT_IDENTITY_DRIFT', 'Container bind-mount inventory is not exact.');
  }
  for (const specification of specifications) {
    const mount = value.Mounts.find((entry) => entry.Destination === specification.destination);
    const source = path.resolve(mount.Source);
    const containerView = path.join(`/proc/${pid}/root`, specification.destination.slice(1));
    const [sourceReal, sourceInformation, containerInformation] = await Promise.all([
      realpath(source).catch(() => undefined),
      lstat(source).catch(() => undefined),
      lstat(containerView).catch(() => undefined),
    ]);
    if (sourceReal !== source || sourceInformation === undefined || containerInformation === undefined
      || sourceInformation.isSymbolicLink() || containerInformation.isSymbolicLink()
      || sourceInformation.dev !== containerInformation.dev
      || sourceInformation.ino !== containerInformation.ino) {
      fail(
        'HOST_RECOVERY_MOUNT_IDENTITY_DRIFT',
        `Container bind mount ${specification.destination} no longer identifies its current host source inode.`,
      );
    }
  }
  return true;
}

export async function validatePinnedBrokerDnsBoundary(run, descriptor, harnessInspect, brokerInspect) {
  const harness = Array.isArray(harnessInspect) ? harnessInspect[0] : harnessInspect;
  const broker = Array.isArray(brokerInspect) ? brokerInspect[0] : brokerInspect;
  const serviceNetwork = descriptor.target.brokerServiceNetworkName;
  const harnessAttachment = harness?.NetworkSettings?.Networks?.[serviceNetwork];
  const brokerAttachment = broker?.NetworkSettings?.Networks?.[serviceNetwork];
  const brokerAddress = String(brokerAttachment?.IPAddress ?? brokerAttachment?.IPAMConfig?.IPv4Address ?? '')
    .split('/')[0];
  if (harnessAttachment?.NetworkID !== descriptor.target.brokerServiceNetworkId
    || brokerAttachment?.NetworkID !== descriptor.target.brokerServiceNetworkId
    || !Array.isArray(brokerAttachment?.Aliases)
    || !brokerAttachment.Aliases.includes(descriptor.target.brokerServiceNetworkAlias)
    || Object.entries(broker?.NetworkSettings?.Networks ?? {}).some(([name, attachment]) => (
      name !== serviceNetwork
      && Array.isArray(attachment?.Aliases)
      && attachment.Aliases.includes(descriptor.target.brokerServiceNetworkAlias)
    ))
    || !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(brokerAddress)) {
    fail('HOST_RECOVERY_BROKER_DNS_DRIFT', 'Pinned Broker network endpoint identity is incomplete.');
  }
  const source = "import dns from 'node:dns/promises';const a=(await dns.resolve4('taskspace-broker')).sort();process.stdout.write(JSON.stringify({addresses:a})+'\\n');";
  const result = await run('docker', [
    'exec', '--user', FIXED_USER, descriptor.target.harnessContainerId,
    NODE_PATH, '--input-type=module', '--eval', source,
  ]);
  let resolved;
  try { resolved = JSON.parse(result.stdout); } catch { resolved = null; }
  if (result.code !== 0 || !Array.isArray(resolved?.addresses)
    || resolved.addresses.length !== 1 || resolved.addresses[0] !== brokerAddress) {
    fail(
      'HOST_RECOVERY_BROKER_DNS_DRIFT',
      'TaskSpace Broker DNS does not resolve uniquely to the pinned Broker endpoint.',
    );
  }
  return true;
}

const CRITICAL_RUNTIME_DESTINATIONS = new Set([
  '/bin',
  '/etc/ld.so.conf',
  '/etc/ld.so.conf.d',
  '/etc/ld.so.preload',
  '/lib',
  '/lib64',
  '/opt/java/openjdk/bin',
  '/opt/forge-harness-runtime/node_modules',
  '/usr/bin',
  '/usr/lib',
  '/usr/lib64',
  '/usr/local/bin/dsh',
  '/usr/local/bin/node',
  '/usr/local/bin/start-harness',
  '/usr/local/lib',
  '/usr/local/share/forge-governance-runtime.patch.yml',
  '/opt/forge-harness-runtime',
  '/usr/local/lib/forge-execution-context.mjs',
  '/usr/local/lib/forge-prepare-headless-execution.mjs',
  '/usr/local/lib/forge-recover-headless-execution.mjs',
  '/usr/local/lib/forge-phase-budget-guard.mjs',
  '/usr/local/lib/forge-progress-detector.mjs',
  '/usr/local/lib/taskspace-broker.mjs',
]);

function containerPathsOverlap(left, right) {
  const normalizedLeft = path.posix.resolve('/', left ?? '');
  const normalizedRight = path.posix.resolve('/', right ?? '');
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}/`)
    || normalizedRight.startsWith(`${normalizedLeft}/`);
}

function hasCriticalRuntimeOverlay(mounts) {
  return (mounts ?? []).some((mount) => [...CRITICAL_RUNTIME_DESTINATIONS]
    .some((critical) => containerPathsOverlap(mount.Destination, critical)));
}

function emptyEntrypoint(value) {
  return value == null || (Array.isArray(value) && value.length === 0);
}

export function validateHarnessRecoveryBoundary(inspect, descriptor, paths) {
  const value = Array.isArray(inspect) ? inspect[0] : inspect;
  const projectNetworkPrefix = `forge-${descriptor.target.projectSlug}`;
  const harnessNetworks = {
    [`${projectNetworkPrefix}_application`]: descriptor.target.harnessApplicationNetworkId,
    [`${projectNetworkPrefix}_taskspaces`]: descriptor.target.harnessTaskspacesNetworkId,
    [`${projectNetworkPrefix}-task-${descriptor.target.taskId}_uploads`]:
      descriptor.target.harnessUploadsNetworkId,
  };
  if (!value || value.Id !== descriptor.target.harnessContainerId
    || value.Image !== descriptor.target.harnessImageId
    || value.State?.Running !== true || value.State?.Paused === true
    || value.State?.Restarting === true || value.State?.Dead === true
    || value.State?.StartedAt !== descriptor.target.harnessStartedAt
    || value.Config?.User !== FIXED_USER
    || !emptyEntrypoint(value.Config?.Entrypoint)
    || JSON.stringify(value.Config?.Cmd) !== JSON.stringify(['/usr/local/bin/start-harness'])
    || value.Config?.WorkingDir !== '/workspace'
    || value.Config?.Labels?.['org.opencontainers.image.revision'] !== descriptor.target.harnessRevision
    || value.Config?.Labels?.['com.forge-delivery.harness-skill-bundle']
      !== descriptor.target.harnessSkillBundleVersion
    || value.Config?.Labels?.['com.forge-delivery.harness-runtime-profile']
      !== descriptor.target.harnessRuntimeProfile
    || value.HostConfig?.ReadonlyRootfs !== true || value.HostConfig?.Privileged !== false
    || !constrainedDockerHostBoundary(value.HostConfig, {
      restartPolicy: 'unless-stopped', networkModes: Object.keys(harnessNetworks),
    })
    || !exactNetworkInventory(value.NetworkSettings?.Networks, harnessNetworks)
    || dockerSocketMount(value.Mounts) || hasCriticalRuntimeOverlay(value.Mounts)) {
    fail('HOST_RECOVERY_HARNESS_DRIFT', 'Harness identity or security boundary drifted.');
  }
  const environment = envMap(value.Config.Env);
  const expectedEnvironment = {
    HOME: '/home/node',
    DSH_HOME: '/home/node/.dsh',
    DSH_PERMISSION_MODE: 'workspace-write',
    DSH_BUNDLED_SKILL_DIR: '/opt/forge-skill-bundles/current/skills',
    HARNESS_DEFAULT_WORKSPACE: '/workspace',
    HARNESS_BIND_ADDRESS: '127.0.0.1',
    HARNESS_INTERNAL_PORT: String(FIXED_DSH_PORT),
    HARNESS_PORT: String(FIXED_PROXY_PORT),
    HARNESS_MAINTENANCE_FENCE_FILE: '/run/forge-taskspace-maintenance/proxy-fence.json',
    HARNESS_ACCESS_MODE: descriptor.target.taskspaceAccessMode,
    HARNESS_ACCESS_TOKEN_FILE: '/run/forge-taskspace/browser-access-token',
    HARNESS_ACCESS_AUTHZ_SOCKET: '/run/forge-conversation-auth/authorize.sock',
    FORGE_TASKSPACE_BROKER_URL: 'http://taskspace-broker:3100',
    FORGE_TASKSPACE_TOKEN_FILE: '/run/forge-taskspace/broker-token',
    PROJECT_SLUG: descriptor.target.projectSlug,
    FORGE_TASKSPACE_ID: descriptor.target.taskId,
    FORGE_TASKSPACE_ACTOR_ID: descriptor.execution.actorId,
    FORGE_TASKSPACE_ACTOR_USER_ID: descriptor.execution.actorUserId,
    FORGE_TASKSPACE_CONVERSATION_ID: descriptor.execution.conversationId,
  };
  if (!runtimeEnvironmentIsSafe(environment)
    || Object.entries(expectedEnvironment).some(([key, expected]) => environment.get(key) !== expected)
    || [...environment.keys()].some((key) => key.startsWith('FORGE_TEST_SHADOW_'))
    || environment.get('HARNESS_BIND_ADDRESS') !== '127.0.0.1'
    || environment.get('HARNESS_INTERNAL_PORT') !== String(FIXED_DSH_PORT)
    || environment.get('HARNESS_PORT') !== String(FIXED_PROXY_PORT)) {
    fail('HOST_RECOVERY_HARNESS_DRIFT', 'Harness loopback recovery ports drifted.');
  }
  const ports = value.NetworkSettings?.Ports ?? {};
  const publishedProxy = ports[`${FIXED_PROXY_PORT}/tcp`];
  const publishedDsh = value.NetworkSettings?.Ports?.[`${FIXED_DSH_PORT}/tcp`];
  if (!Array.isArray(publishedProxy) || publishedProxy.length !== 1
    || publishedProxy[0]?.HostIp !== '127.0.0.1'
    || publishedProxy[0]?.HostPort !== String(descriptor.target.hostProxyPort)
    || publishedDsh != null
    || Object.entries(ports).some(([key, bindings]) => (
      key !== `${FIXED_PROXY_PORT}/tcp` && Array.isArray(bindings) && bindings.length > 0
    ))) {
    fail('HOST_RECOVERY_HARNESS_DRIFT', 'Harness ports are not constrained to the reviewed loopback boundary.');
  }
  const maintenance = (value.Mounts ?? []).filter((mount) => path.resolve(mount.Source ?? '') === paths.maintenanceDirectory);
  if (maintenance.length !== 1 || maintenance[0].RW !== false || maintenance[0].Type !== 'bind') {
    fail('HOST_RECOVERY_HARNESS_DRIFT', 'Harness maintenance mount does not match the TaskSpace fence.');
  }
  if (!exactBindMountInventory(value.Mounts, harnessBindMountSpecifications(descriptor, paths))) {
    fail('HOST_RECOVERY_HARNESS_DRIFT', 'Harness TaskSpace identity mounts drifted.');
  }
  return Object.freeze({ id: value.Id, image: value.Image, pid: value.State.Pid, restartCount: value.RestartCount });
}

export function validateBrokerRecoveryBoundary(inspect, descriptor, paths) {
  const value = Array.isArray(inspect) ? inspect[0] : inspect;
  const dedicatedCanary = descriptor.target.brokerTopologyMode
    === DEDICATED_CANARY_BROKER_TOPOLOGY;
  const brokerNetworks = brokerNetworkSpecifications(descriptor);
  const serviceAttachment = value?.NetworkSettings?.Networks?.[
    descriptor.target.brokerServiceNetworkName
  ];
  const brokerCommandIsExact = dedicatedCanary
    ? JSON.stringify(value?.Config?.Entrypoint) === JSON.stringify([NODE_PATH])
      && JSON.stringify(value?.Config?.Cmd) === JSON.stringify(['/usr/local/lib/taskspace-broker.mjs'])
    : emptyEntrypoint(value?.Config?.Entrypoint)
      && JSON.stringify(value?.Config?.Cmd) === JSON.stringify([NODE_PATH, '/usr/local/lib/taskspace-broker.mjs']);
  if (!value || value.Id !== descriptor.target.brokerContainerId
    || value.Image !== descriptor.target.brokerImageId
    || (dedicatedCanary && value.Image !== descriptor.target.recoveryHelperImageId)
    || value.State?.Running !== true || value.State?.Paused === true
    || value.State?.Restarting === true || value.State?.Dead === true
    || value.State?.StartedAt !== descriptor.target.brokerStartedAt
    || value.State?.Health?.Status !== 'healthy'
    || value.Config?.User !== FIXED_USER || !brokerCommandIsExact
    || value.Config?.WorkingDir !== '/workspace'
    || value.Config?.Labels?.['org.opencontainers.image.revision'] !== descriptor.target.brokerRevision
    || (dedicatedCanary && descriptor.target.brokerRevision !== descriptor.target.recoveryHelperRevision)
    || value.HostConfig?.ReadonlyRootfs !== true || value.HostConfig?.Privileged !== false
    || !constrainedDockerHostBoundary(value.HostConfig, {
      restartPolicy: 'unless-stopped', networkModes: Object.keys(brokerNetworks),
    })
    || !constrainedBrokerResourceBoundary(value.HostConfig)
    || !exactNetworkInventory(value.NetworkSettings?.Networks, brokerNetworks)
    || serviceAttachment?.NetworkID !== descriptor.target.brokerServiceNetworkId
    || !Array.isArray(serviceAttachment?.Aliases)
    || !serviceAttachment.Aliases.includes(descriptor.target.brokerServiceNetworkAlias)
    || Object.entries(value.NetworkSettings?.Networks ?? {}).some(([name, attachment]) => (
      name !== descriptor.target.brokerServiceNetworkName
      && Array.isArray(attachment?.Aliases)
      && attachment.Aliases.includes(descriptor.target.brokerServiceNetworkAlias)
    ))
    || dockerSocketMount(value.Mounts) || hasCriticalRuntimeOverlay(value.Mounts)) {
    fail('HOST_RECOVERY_BROKER_DRIFT', 'TaskSpace Broker identity or security boundary drifted.');
  }
  const environment = envMap(value.Config.Env);
  const expectedEnvironment = {
    TASKSPACE_PROJECT_ROOT: paths.projectControlRoot,
    TASKSPACE_PROJECT_SLUG: descriptor.target.projectSlug,
    TASKSPACE_BROKER_ADDRESS: '0.0.0.0',
    TASKSPACE_BROKER_PORT: '3100',
    RELEASE_RUNNER_SOCKET: '/run/forge-release/runner.sock',
    VERIFICATION_RUNNER_SOCKET: '/run/forge-verify/runner.sock',
    TASKSPACE_GIT_REMOTE_REQUIRED: descriptor.target.brokerGitRemoteRequired,
    TASKSPACE_GIT_REMOTE_READY: descriptor.target.brokerGitRemoteReady,
  };
  if (!dedicatedCanary) Object.assign(expectedEnvironment, {
    PROTECTED_ACCEPTANCE_RESOLVER_SOCKET: '/run/forge-acceptance-resolver/resolver.sock',
    TASKSPACE_GIT_REMOTE_NAME: descriptor.target.brokerGitRemoteName,
    TASKSPACE_GIT_REMOTE_BRANCH: descriptor.target.brokerGitRemoteBranch,
    TASKSPACE_GIT_SSH_COMMAND: 'ssh -i /run/forge-git/id_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/run/forge-git/known_hosts',
  });
  const dedicatedForbiddenEnvironment = [
    'PROTECTED_ACCEPTANCE_RESOLVER_SOCKET',
    'TASKSPACE_GIT_REMOTE_NAME',
    'TASKSPACE_GIT_REMOTE_BRANCH',
    'TASKSPACE_GIT_SSH_COMMAND',
  ];
  if (!runtimeEnvironmentIsSafe(environment)
    || Object.entries(expectedEnvironment).some(([key, expected]) => environment.get(key) !== expected)
    || (dedicatedCanary && (descriptor.target.brokerGitRemoteRequired !== 'false'
      || descriptor.target.brokerGitRemoteReady !== 'false'
      || descriptor.target.brokerGitRemoteNetworkId !== null
      || descriptor.target.brokerGitRemoteName !== null
      || descriptor.target.brokerGitRemoteBranch !== null
      || dedicatedForbiddenEnvironment.some((key) => environment.has(key))))
    || !exactBindMountInventory(value.Mounts, brokerBindMountSpecifications(descriptor, paths))
    || hasPublishedPorts(value.NetworkSettings?.Ports)) {
    fail('HOST_RECOVERY_BROKER_DRIFT', 'TaskSpace Broker project identity or mount boundary drifted.');
  }
  return Object.freeze({ id: value.Id, image: value.Image, pid: value.State.Pid, restartCount: value.RestartCount });
}

const HELPER_IMAGE_PROBE_SOURCE = `const fs=require('node:fs');const c=require('node:crypto');
const h=(p)=>{const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw new Error('unsafe');const b=fs.readFileSync(p);return c.createHash('sha256').update(b).digest('hex')};
const receipt=JSON.parse(fs.readFileSync('/usr/local/share/forge-image-build/receipt.json','utf8'));
process.stdout.write(JSON.stringify({schemaVersion:'forge-recovery-helper-image-probe/v1',buildInputDigest:receipt.digest,helperSha256:h('/usr/local/lib/forge-recover-headless-execution.mjs'),executionContextSha256:h('/usr/local/lib/forge-execution-context.mjs'),phaseGuardSha256:h('/usr/local/lib/forge-phase-budget-guard.mjs'),brokerSha256:h('/usr/local/lib/taskspace-broker.mjs')})+'\\n');`;

export function validateRecoveryHelperImageBoundary(inspect, probe, descriptor) {
  const value = Array.isArray(inspect) ? inspect[0] : inspect;
  const labels = value?.Config?.Labels ?? {};
  if (!value || value.Id !== descriptor.target.recoveryHelperImageId
    || value.Os !== 'linux' || value.Config?.User !== '1000:1000'
    || value.Config?.WorkingDir !== '/workspace' || !emptyEntrypoint(value.Config?.Entrypoint)
    || JSON.stringify(value.Config?.Cmd) !== JSON.stringify(['/usr/local/bin/start-harness'])
    || labels['org.opencontainers.image.revision'] !== descriptor.target.recoveryHelperRevision
    || labels['com.forge-delivery.harness-skill-bundle']
      !== descriptor.target.harnessSkillBundleVersion
    || labels['com.forge-delivery.harness-runtime-profile']
      !== descriptor.target.harnessRuntimeProfile) {
    fail('HOST_RECOVERY_HELPER_IMAGE_DRIFT', 'Recovery helper image identity or provenance drifted.');
  }
  const imageEnvironment = envMap(value.Config?.Env);
  if (!runtimeEnvironmentIsSafe(imageEnvironment)) {
    fail('HOST_RECOVERY_HELPER_IMAGE_DRIFT', 'Recovery helper image runtime environment is unsafe.');
  }
  if (probe?.schemaVersion !== 'forge-recovery-helper-image-probe/v1'
    || probe.buildInputDigest !== descriptor.target.recoveryHelperBuildInputDigest
    || probe.helperSha256 !== descriptor.target.recoveryHelperSourceSha256
    || [probe.executionContextSha256, probe.phaseGuardSha256, probe.brokerSha256]
      .some((digest) => !SHA256.test(digest ?? ''))) {
    fail('HOST_RECOVERY_HELPER_IMAGE_DRIFT', 'Recovery helper image closure does not match reviewed build evidence.');
  }
  return Object.freeze({
    id: value.Id,
    revision: labels['org.opencontainers.image.revision'],
    buildInputDigest: probe.buildInputDigest,
    helperSha256: probe.helperSha256,
    imageEnvironment: Object.freeze(Object.fromEntries(
      [...imageEnvironment.entries()].sort(([left], [right]) => left.localeCompare(right)),
    )),
  });
}

async function inspectRecoveryHelperImage(run, descriptor) {
  const inspect = await dockerJson(run, ['image', 'inspect', descriptor.target.recoveryHelperImageId]);
  const probeResult = await run('docker', [
    'run', '--rm', '--network', 'none', '--user', FIXED_USER, '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '32', '--memory', '128m', '--cpus', '0.25',
    '--entrypoint', NODE_PATH, descriptor.target.recoveryHelperImageId,
    '-e', HELPER_IMAGE_PROBE_SOURCE,
  ]);
  let probe;
  try { probe = JSON.parse(probeResult.stdout); } catch { probe = undefined; }
  if (probeResult.code !== 0 || probeResult.timedOut || probeResult.outputExceeded || probe === undefined) {
    fail('HOST_RECOVERY_HELPER_IMAGE_DRIFT', 'Recovery helper image probe failed closed.');
  }
  return validateRecoveryHelperImageBoundary(inspect, probe, descriptor);
}

function mountSpec(source, destination, readonly) {
  return `type=bind,src=${source},dst=${destination}${readonly ? ',readonly' : ''}`;
}

export function recoveryContainerEnvironment(descriptor) {
  const { target, execution, operation } = descriptor;
  return Object.freeze({
    FORGE_EVAL_PROJECT_ROOT: '/forge-recovery/project',
    PROJECT_SLUG: target.projectSlug,
    FORGE_TASKSPACE_ID: target.taskId,
    FORGE_TASKSPACE_ACTOR_USER_ID: execution.actorUserId,
    FORGE_TASKSPACE_ACTOR_ID: execution.actorId,
    FORGE_TASKSPACE_CONVERSATION_ID: execution.conversationId,
    FORGE_PROTECTED_HEADLESS_SESSION_ID: execution.sessionId,
    FORGE_PROTECTED_HEADLESS_SESSION_MODE: 'resume',
    FORGE_PROTECTED_HEADLESS_RPC_ID: execution.rpcId,
    FORGE_EVAL_SOURCE_COMMIT: execution.sourceCommit,
    FORGE_EVAL_CASE_FAMILY: execution.caseFamily,
    FORGE_EVAL_PROMPT_FILE: '/forge-recovery/input/prompt.md',
    FORGE_EXECUTION_POLICY_FILE: '/forge-recovery/input/execution-policy.json',
    FORGE_EVAL_PHASE_WORKFLOW_ID: execution.workflowId,
    FORGE_EVAL_PHASE_ID: execution.phaseId,
    FORGE_EVAL_PHASE_CATALOG_FILE: '/forge-recovery/input/phase-catalog.json',
    FORGE_EVAL_PHASE_STATE_FILE: `/forge-recovery/phase/${path.basename(descriptor.paths.phaseStateFile)}`,
    FORGE_PROTECTED_HEADLESS_RECOVERY_MODE: 'expired-unsubmitted-exact-context-v1',
    FORGE_PROTECTED_HEADLESS_RECOVERY_OPERATION_ID: operation.operationId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_DESCRIPTOR_SHA256: operation.descriptorSha256,
    FORGE_PROTECTED_HEADLESS_RECOVERY_AUTHORIZATION_REFERENCE: operation.authorizationReference,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PHASE_ATTEMPT_ID: execution.phaseAttemptId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_ID: execution.executionId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CLAIM_ID: execution.claimId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_GENERATION: String(execution.generation),
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_CONTRACT_ID: execution.contractId,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_PROMPT_DIGEST: descriptor.digests.promptTextSha256,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_EXECUTION_STATE_SHA256:
      descriptor.digests.executionStateSha256,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_BASELINE_SEQ: String(execution.expectedBaselineSeq),
    FORGE_PROTECTED_HEADLESS_RECOVERY_EXPECTED_SESSION_CWD: execution.sessionCwd,
    FORGE_PROTECTED_HEADLESS_RECOVERY_EVIDENCE_DIRECTORY: '/forge-recovery/evidence',
    FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_FENCE_FILE:
      `/forge-recovery/maintenance/${path.basename(descriptor.paths.maintenanceFenceFile)}`,
    FORGE_PROTECTED_HEADLESS_RECOVERY_MAINTENANCE_EPOCH: `recovery-${operation.operationId}`,
    FORGE_PROTECTED_HEADLESS_RECOVERY_PROXY_PORT: String(target.hostProxyPort),
    FORGE_PROTECTED_HEADLESS_RECOVERY_DSH_PORT: String(target.dshPort),
    FORGE_PROTECTED_HEADLESS_RECOVERY_ACTION: 'execute',
  });
}

function buildFixedRecoveryContainerCreateArgs(
  descriptor,
  prepared,
  { action, imageEnvironment = { PATH: SAFE_RUNTIME_PATH, NODE_PATH: SAFE_NODE_PATH } },
) {
  if (!['execute', 'reconcile', 'cancel-pre-ingress'].includes(action)) {
    fail('HOST_RECOVERY_CONTAINER_INVALID', 'Recovery helper action is invalid.');
  }
  const readOnlyPhase = action !== 'execute';
  const name = action === 'reconcile'
    ? `forge-recovery-reconcile-${descriptor.operation.operationId}`
    : action === 'cancel-pre-ingress'
      ? `forge-recovery-cancel-${descriptor.operation.operationId}`
      : `forge-recovery-${descriptor.operation.operationId}`;
  const environment = {
    ...recoveryContainerEnvironment(descriptor),
    FORGE_PROTECTED_HEADLESS_RECOVERY_ACTION: action,
  };
  const expectedEnvironment = Object.freeze({ ...imageEnvironment, ...environment });
  const mounts = readOnlyPhase ? [
    mountSpec(descriptor.paths.projectControlRoot, '/forge-recovery/project', true),
    mountSpec(prepared.executionStateDirectory, '/forge-recovery/project/taskspaces/.broker/executions', false),
    mountSpec(descriptor.paths.phaseControlDirectory, '/forge-recovery/phase', true),
    mountSpec(prepared.inputDirectory, '/forge-recovery/input', true),
    mountSpec(descriptor.paths.evidenceDirectory, '/forge-recovery/evidence', false),
    mountSpec(descriptor.paths.maintenanceDirectory, '/forge-recovery/maintenance', true),
  ] : [
    mountSpec(descriptor.paths.projectControlRoot, '/forge-recovery/project', true),
    mountSpec(prepared.executionStateDirectory, '/forge-recovery/project/taskspaces/.broker/executions', false),
    mountSpec(descriptor.paths.phaseControlDirectory, '/forge-recovery/phase', false),
    mountSpec(prepared.inputDirectory, '/forge-recovery/input', true),
    mountSpec(descriptor.paths.evidenceDirectory, '/forge-recovery/evidence', false),
    mountSpec(descriptor.paths.maintenanceDirectory, '/forge-recovery/maintenance', true),
  ];
  const args = [
    'create', '--name', name,
    '--label', `com.forge.recovery.operation=${descriptor.operation.operationId}`,
    '--label', `com.forge.recovery.descriptor-sha256=${descriptor.operation.descriptorSha256}`,
    '--pull', 'never', '--network', `container:${descriptor.target.harnessContainerId}`,
    '--user', FIXED_USER, '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--pids-limit', '128',
    '--memory', '512m', '--cpus', '1', '--restart', 'no',
    '--log-driver', 'json-file', '--log-opt', 'max-size=20m', '--log-opt', 'max-file=5',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=983,mode=0700',
  ];
  for (const mount of mounts) args.push('--mount', mount);
  for (const [key, value] of Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))) {
    args.push('--env', `${key}=${value}`);
  }
  args.push('--entrypoint', NODE_PATH, descriptor.target.recoveryHelperImageId, HELPER_PATH);
  const expectedMounts = readOnlyPhase ? [
    { Source: descriptor.paths.projectControlRoot, Destination: '/forge-recovery/project', RW: false, Type: 'bind' },
    { Source: prepared.executionStateDirectory, Destination: '/forge-recovery/project/taskspaces/.broker/executions', RW: true, Type: 'bind' },
    { Source: descriptor.paths.phaseControlDirectory, Destination: '/forge-recovery/phase', RW: false, Type: 'bind' },
    { Source: prepared.inputDirectory, Destination: '/forge-recovery/input', RW: false, Type: 'bind' },
    { Source: descriptor.paths.evidenceDirectory, Destination: '/forge-recovery/evidence', RW: true, Type: 'bind' },
    { Source: descriptor.paths.maintenanceDirectory, Destination: '/forge-recovery/maintenance', RW: false, Type: 'bind' },
  ] : [
    { Source: descriptor.paths.projectControlRoot, Destination: '/forge-recovery/project', RW: false, Type: 'bind' },
    { Source: prepared.executionStateDirectory, Destination: '/forge-recovery/project/taskspaces/.broker/executions', RW: true, Type: 'bind' },
    { Source: descriptor.paths.phaseControlDirectory, Destination: '/forge-recovery/phase', RW: true, Type: 'bind' },
    { Source: prepared.inputDirectory, Destination: '/forge-recovery/input', RW: false, Type: 'bind' },
    { Source: descriptor.paths.evidenceDirectory, Destination: '/forge-recovery/evidence', RW: true, Type: 'bind' },
    { Source: descriptor.paths.maintenanceDirectory, Destination: '/forge-recovery/maintenance', RW: false, Type: 'bind' },
  ];
  return Object.freeze({
    name,
    mode: action,
    args: Object.freeze(args),
    environment: Object.freeze(environment),
    expectedEnvironment,
    mounts: Object.freeze(mounts),
    expectedMounts: Object.freeze(expectedMounts),
  });
}

export function buildRecoveryContainerCreateArgs(descriptor, prepared, imageEnvironment = undefined) {
  return buildFixedRecoveryContainerCreateArgs(descriptor, prepared, { action: 'execute', imageEnvironment });
}

export function buildRecoveryReconciliationContainerCreateArgs(descriptor, prepared, imageEnvironment = undefined) {
  return buildFixedRecoveryContainerCreateArgs(descriptor, prepared, { action: 'reconcile', imageEnvironment });
}

export function buildRecoveryPreIngressCancellationContainerCreateArgs(
  descriptor,
  prepared,
  imageEnvironment = undefined,
) {
  return buildFixedRecoveryContainerCreateArgs(
    descriptor,
    prepared,
    { action: 'cancel-pre-ingress', imageEnvironment },
  );
}

function normalizedMount(mount) {
  return `${path.resolve(mount.Source)}\0${mount.Destination}\0${mount.RW === true ? 'rw' : 'ro'}\0${mount.Type}`;
}

export function validateRecoveryContainerBoundary(
  inspect,
  descriptor,
  prepared,
  definition,
  { requireCreated = true } = {},
) {
  const value = Array.isArray(inspect) ? inspect[0] : inspect;
  const expectedMounts = definition.expectedMounts.map(normalizedMount).sort();
  const actualMounts = (value?.Mounts ?? []).map(normalizedMount).sort();
  const labels = value?.Config?.Labels ?? {};
  const entrypoint = value?.Config?.Entrypoint;
  const command = value?.Config?.Cmd;
  if (!value || value.Image !== descriptor.target.recoveryHelperImageId
    || (requireCreated && (value.State?.Status !== 'created' || value.State?.Running !== false
      || value.State?.Paused === true || value.State?.Restarting === true || value.State?.Dead === true))
    || value.Config?.User !== FIXED_USER || value.HostConfig?.ReadonlyRootfs !== true
    || value.HostConfig?.Privileged !== false
    || !constrainedDockerHostBoundary(value.HostConfig, {
      restartPolicy: 'no', networkModes: [`container:${descriptor.target.harnessContainerId}`],
    })
    || value.HostConfig?.NetworkMode !== `container:${descriptor.target.harnessContainerId}`
    || value.HostConfig?.PidsLimit !== 128 || value.HostConfig?.Memory !== 512 * 1024 * 1024
    || value.HostConfig?.NanoCpus !== 1_000_000_000
    || value.HostConfig?.RestartPolicy?.Name !== 'no'
    || (value.HostConfig?.Devices?.length ?? 0) !== 0
    || JSON.stringify(entrypoint) !== JSON.stringify([NODE_PATH])
    || JSON.stringify(command) !== JSON.stringify([HELPER_PATH])
    || labels['org.opencontainers.image.revision'] !== descriptor.target.recoveryHelperRevision
    || labels['com.forge.recovery.operation'] !== descriptor.operation.operationId
    || labels['com.forge.recovery.descriptor-sha256'] !== descriptor.operation.descriptorSha256
    || JSON.stringify(actualMounts) !== JSON.stringify(expectedMounts)
    || dockerSocketMount(value.Mounts)
    || Object.keys(value.NetworkSettings?.Ports ?? {}).length !== 0) {
    fail('HOST_RECOVERY_CONTAINER_INVALID', 'Recovery container escaped its fixed security boundary.');
  }
  const actualEnvironment = envMap(value.Config.Env);
  const actualEnvironmentValue = Object.fromEntries([...actualEnvironment.entries()].sort());
  const expectedEnvironmentValue = Object.fromEntries(
    Object.entries(definition.expectedEnvironment).sort(),
  );
  if (!runtimeEnvironmentIsSafe(actualEnvironment)
    || JSON.stringify(actualEnvironmentValue) !== JSON.stringify(expectedEnvironmentValue)) {
    fail(
      'HOST_RECOVERY_CONTAINER_INVALID',
      'Recovery container environment escaped its exact image and operation projection.',
    );
  }
  for (const key of actualEnvironment.keys()) {
    if (/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY)/iu.test(key)) {
      fail('HOST_RECOVERY_CONTAINER_INVALID', 'Recovery container inherited a credential-shaped environment name.');
    }
  }
  return Object.freeze({ id: value.Id, image: value.Image, name: definition.name });
}

const HARNESS_MAINTENANCE_HEALTH_PROGRAM = `'use strict';
const http = require('node:http');
const fail = () => { process.exitCode = 70; };
const request = http.request({
  host: '127.0.0.1', port: ${FIXED_PROXY_PORT}, path: '${FIXED_MAINTENANCE_HEALTH_PATH}', method: 'GET', agent: false,
  headers: { accept: 'application/json', connection: 'close' },
}, (response) => {
  const chunks = [];
  let length = 0;
  response.on('data', (chunk) => {
    length += chunk.length;
    if (length > ${MAX_HEALTH_RESPONSE_BYTES}) {
      response.destroy();
      fail();
    } else {
      chunks.push(chunk);
    }
  });
  response.once('end', () => {
    if (process.exitCode) return;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      process.stdout.write(JSON.stringify({ status: response.statusCode ?? 0, body }));
    } catch {
      fail();
    }
  });
  response.once('error', fail);
});
request.setTimeout(5000, () => request.destroy());
request.once('error', fail);
request.end();`;

export async function probeHarnessMaintenanceHealth({ run = runProcess, harnessContainerId }) {
  if (typeof run !== 'function' || !CONTAINER_ID.test(harnessContainerId ?? '')) {
    fail('HOST_RECOVERY_HEALTH_PROBE_INVALID', 'Harness maintenance probe identity is invalid.');
  }
  const result = await run('docker', [
    'exec', '--user', FIXED_USER, harnessContainerId,
    NODE_PATH, '--eval', HARNESS_MAINTENANCE_HEALTH_PROGRAM,
  ], {
    timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
    maxOutputBytes: MAX_HEALTH_PROBE_OUTPUT_BYTES,
  });
  if (result?.code !== 0 || result.timedOut === true || result.outputExceeded === true
    || typeof result.stdout !== 'string'
    || Buffer.byteLength(result.stdout, 'utf8') > MAX_HEALTH_PROBE_OUTPUT_BYTES) {
    fail('HOST_RECOVERY_HEALTH_PROBE_FAILED', 'Harness maintenance loopback probe failed.');
  }
  let value;
  try { value = JSON.parse(result.stdout); } catch {
    fail('HOST_RECOVERY_HEALTH_PROBE_FAILED', 'Harness maintenance loopback probe returned invalid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['body', 'status'])
    || !Number.isInteger(value.status) || value.status < 100 || value.status > 599
    || value.body === null || typeof value.body !== 'object' || Array.isArray(value.body)) {
    fail('HOST_RECOVERY_HEALTH_PROBE_FAILED', 'Harness maintenance loopback probe returned an invalid response shape.');
  }
  return Object.freeze({ status: value.status, body: value.body });
}

function drainedHealth(value, epoch) {
  return value?.status === 503 && value.body?.ok === false
    && value.body.status === 'maintenance' && value.body.code === 'TASKSPACE_MAINTENANCE'
    && value.body.epoch === epoch && value.body.drain?.mode === 'connection-tracked'
    && value.body.drain.drained === true && value.body.drain.activeTcpConnections === 0
    && value.body.drain.activeHttpRequests === 0 && value.body.drain.activeUpgradeConnections === 0;
}

export async function waitForStableMaintenanceDrain({
  port,
  epoch,
  health,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = 60,
}) {
  if (typeof health !== 'function') {
    fail('HOST_RECOVERY_HEALTH_PROBE_INVALID', 'A bounded Harness maintenance health probe is required.');
  }
  let consecutive = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let observation;
    try { observation = await health({ port, requestPath: '/forge-maintenance/healthz' }); } catch { observation = null; }
    consecutive = drainedHealth(observation, epoch) ? consecutive + 1 : 0;
    if (consecutive === 2) return Object.freeze({ attempts: attempt, stableObservations: 2, epoch });
    if (attempt < attempts) await sleep(250);
  }
  fail('HOST_RECOVERY_MAINTENANCE_NOT_DRAINED', 'TaskSpace maintenance did not reach two stable drained observations.');
}

async function runProcess(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs === null ? null : (options.timeoutMs ?? 5 * 60 * 1000);
    const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
    const childOptions = { ...options };
    delete childOptions.timeoutMs;
    delete childOptions.maxOutputBytes;
    const child = spawn(program, args, {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...childOptions,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    const killForOutput = () => {
      outputExceeded = true;
      child.kill('SIGKILL');
    };
    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxOutputBytes) stdout.push(chunk);
      else killForOutput();
    });
    child.stderr?.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxOutputBytes) stderr.push(chunk);
      else killForOutput();
    });
    const timer = timeoutMs === null ? null : setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      if (timer !== null) clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (timer !== null) clearTimeout(timer);
      resolve({
        code, signal, timedOut, outputExceeded,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function dockerJson(run, args) {
  const result = await run('docker', args);
  if (result.code !== 0) fail('HOST_RECOVERY_DOCKER_FAILED', 'Docker inspection failed.');
  try { return JSON.parse(result.stdout); } catch { fail('HOST_RECOVERY_DOCKER_FAILED', 'Docker inspection returned invalid JSON.'); }
}

async function writeJournal(file, base, state, extra = {}, { createOnly = false } = {}) {
  const value = {
    schemaVersion: HOST_RECOVERY_JOURNAL_SCHEMA,
    ...base,
    state,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await writeExclusive(file, bytes);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    if (createOnly) {
      fail('HOST_RECOVERY_JOURNAL_INVALID', 'Recovery journal appeared concurrently during initialization.');
    }
    const current = await readJournal(file, {
      operation: { operationId: base.operationId, descriptorSha256: base.descriptorSha256 },
      target: {
        harnessContainerId: base.harnessContainerId,
        brokerContainerId: base.brokerContainerId,
        recoveryHelperImageId: base.recoveryHelperImageId,
        recoveryHelperBuildInputDigest: base.recoveryHelperBuildInputDigest,
      },
    });
    if (JSON.stringify(journalBaseFrom(current)) !== JSON.stringify(base)) {
      fail('HOST_RECOVERY_JOURNAL_INVALID', 'Recovery journal identity changed before its state transition.');
    }
    const metadata = await lstat(file);
    await atomicReplace(file, bytes, { mode: metadata.mode & 0o777, uid: metadata.uid, gid: metadata.gid });
  }
  return value;
}

function journalIdentity(value, descriptor) {
  const expected = {
    operationId: descriptor.operation.operationId,
    descriptorSha256: descriptor.operation.descriptorSha256,
    harnessContainerId: descriptor.target.harnessContainerId,
    brokerContainerId: descriptor.target.brokerContainerId,
    recoveryHelperImageId: descriptor.target.recoveryHelperImageId,
    recoveryHelperBuildInputDigest: descriptor.target.recoveryHelperBuildInputDigest,
  };
  if (value?.schemaVersion !== HOST_RECOVERY_JOURNAL_SCHEMA
    || Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)
    || !SHA256.test(value.originalFenceSha256 ?? '')
    || typeof value.originalFenceFile !== 'string'
    || path.basename(value.originalFenceFile) !== value.originalFenceFile
    || typeof value.originalFenceEpoch !== 'string'
    || !Number.isInteger(value.originalFenceMode) || value.originalFenceMode < 0
    || !Number.isInteger(value.originalFenceUid) || value.originalFenceUid < 0
    || !Number.isInteger(value.originalFenceGid) || value.originalFenceGid < 0) {
    fail('HOST_RECOVERY_JOURNAL_INVALID', 'Existing recovery journal identity is invalid or foreign.');
  }
  return value;
}

async function readJournal(file, descriptor) {
  const input = await stableOrdinaryFile(file, MAX_INPUT_BYTES, 'host recovery journal');
  return journalIdentity(parseJsonBytes(input.bytes, 'HOST_RECOVERY_JOURNAL_INVALID', 'Host recovery journal'), descriptor);
}

async function readJournalIfPresent(file, descriptor) {
  const information = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  return information === null ? null : readJournal(file, descriptor);
}

function journalBaseFrom(value) {
  return Object.freeze({
    operationId: value.operationId,
    descriptorSha256: value.descriptorSha256,
    harnessContainerId: value.harnessContainerId,
    brokerContainerId: value.brokerContainerId,
    recoveryHelperImageId: value.recoveryHelperImageId,
    recoveryHelperBuildInputDigest: value.recoveryHelperBuildInputDigest,
    originalFenceFile: value.originalFenceFile,
    originalFenceSha256: value.originalFenceSha256,
    originalFenceEpoch: value.originalFenceEpoch,
    originalFenceMode: value.originalFenceMode,
    originalFenceUid: value.originalFenceUid,
    originalFenceGid: value.originalFenceGid,
  });
}

function exactFence(bytes, expectedState = undefined, expectedEpoch = undefined) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('HOST_RECOVERY_FENCE_INVALID', 'Maintenance fence is invalid JSON.'); }
  exactKeys(value, ['schemaVersion', 'state', 'epoch'], 'maintenance fence');
  if (value.schemaVersion !== 1 || !['committed', 'maintenance'].includes(value.state)
    || typeof value.epoch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.epoch)
    || (expectedState !== undefined && value.state !== expectedState)
    || (expectedEpoch !== undefined && value.epoch !== expectedEpoch)) {
    fail('HOST_RECOVERY_FENCE_INVALID', 'Maintenance fence identity is invalid.');
  }
  return value;
}

function parseHelperResult(stdout) {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 1) return null;
  try {
    const value = JSON.parse(lines[0]);
    const receiptFile = typeof value.receiptFile === 'string' ? value.receiptFile : '';
    if (value.schemaVersion !== 'forge-protected-headless-recovery-cli/v1'
      || ![
        'accepted', 'submitted-observed', 'observed-unconsumed', 'not-observed-no-resend',
        'pre-ingress-failed',
      ].includes(value.status)
      || !SHA256.test(value.receiptSha256 ?? '') || !Number.isSafeInteger(value.receiptBytes)
      || receiptFile.length < 1 || receiptFile.includes('/') || receiptFile.includes('\\')
      || path.basename(receiptFile) !== receiptFile) return null;
    return value;
  } catch { return null; }
}

function validateStableReconciliationReceipt(bytes, helperResult, descriptor, intentIdentity) {
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); } catch {
    fail('HOST_RECOVERY_RESULT_INVALID', 'Recovery reconciliation receipt is not valid JSON.');
  }
  const { execution, operation, target, digests } = descriptor;
  const consumption = receipt?.executionConsumption;
  const observed = receipt?.readback?.requestObserved === true;
  const consumed = consumption?.consumed === true
    && consumption.lifecycleStatus === 'consumed'
    && consumption.recoveryStatus === 'consumed'
    && consumption.exactIdentity !== false;
  const expectedStatus = consumed
    ? 'submitted-observed'
    : observed ? 'observed-unconsumed' : 'not-observed-no-resend';
  const stableIdleReadback = receipt?.readback?.historyComplete === true
    && receipt.readback?.turnOpen === false && receipt.readback?.session?.running === false;
  const terminalization = receipt?.executionTerminalization;
  const terminalized = !consumed
    && terminalization?.lifecycleStatus === 'abandoned'
    && terminalization?.recoveryStatus === 'abandoned'
    && terminalization?.exactIdentity === true
    && terminalization?.tombstone?.operationId === operation.operationId
    && terminalization?.tombstone?.phaseAttemptId === execution.phaseAttemptId
    && terminalization?.tombstone?.executionId === execution.executionId
    && terminalization?.tombstone?.claimId === execution.claimId
    && terminalization?.tombstone?.generation === execution.generation
    && terminalization?.tombstone?.contractId === execution.contractId
    && terminalization?.tombstone?.rpcId === execution.rpcId
    && terminalization?.tombstone?.dshSessionId === execution.sessionId
    && terminalization?.tombstone?.textDigest === digests.promptTextSha256
    && terminalization?.tombstone?.reason === 'stable-idle-unconsumed-no-resend';
  if (receipt?.schemaVersion !== 'forge-protected-headless-reconciliation/v2'
    || helperResult.status !== expectedStatus || receipt.status !== expectedStatus
    || receipt.operationId !== operation.operationId || receipt.taskId !== target.taskId
    || receipt.sessionId !== execution.sessionId || receipt.rpcId !== execution.rpcId
    || receipt.promptDigest !== digests.promptTextSha256
    || receipt.phaseAttemptId !== execution.phaseAttemptId || receipt.phaseId !== execution.phaseId
    || receipt.executionId !== execution.executionId || receipt.claimId !== execution.claimId
    || receipt.generation !== execution.generation || receipt.contractId !== execution.contractId
    || receipt.sourceCommit !== execution.sourceCommit
    || receipt.maintenance?.epoch !== `recovery-${operation.operationId}`
    || receipt.maintenance?.drained !== true
    || receipt.durableIntent?.file !== `submission-intent-${operation.operationId}.json`
    || receipt.durableIntent?.sha256 !== intentIdentity.sha256
    || receipt.durableIntent?.automaticResendForbidden !== true
    || consumption?.exactIdentity !== true
    || (consumed ? terminalization !== null : (!stableIdleReadback || !terminalized))
    || receipt.safeToRestoreUserIngress !== true || receipt.safeToResend !== false
    || receipt.proofScope?.phaseGuardBound !== false
    || receipt.proofScope?.brokerExecutionContextConsumed !== consumed
    || receipt.proofScope?.classification !== (consumed
      ? 'broker-execution-context-consumed'
      : 'broker-execution-context-abandoned-after-stable-idle')) {
    fail(
      'HOST_RECOVERY_RESULT_INVALID',
      'Recovery reconciliation receipt does not prove one exact stable no-resend boundary.',
    );
  }
  return receipt;
}

function validatePreIngressCancellationReceipt(bytes, helperResult, descriptor) {
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); } catch {
    fail('HOST_RECOVERY_RESULT_INVALID', 'Pre-ingress cancellation receipt is not valid JSON.');
  }
  const { execution, operation, target, digests } = descriptor;
  const status = receipt?.executionStatus;
  const terminalization = receipt?.executionTerminalization;
  const tombstone = terminalization?.tombstone;
  const permitted = receipt?.preIngressState === 'permitted'
    && status?.recoveryReadbackSeq === null
    && status?.recoveryReadbackDigest === null
    && receipt?.readback?.observedSeq === execution.expectedBaselineSeq
    && receipt?.readback?.baselineObservedSeq === null
    && receipt?.readback?.baselineEventDigest === null;
  const claimed = receipt?.preIngressState === 'submission-attempted'
    && status?.recoveryReadbackSeq === execution.expectedBaselineSeq
    && SHA256.test(status?.recoveryReadbackDigest ?? '')
    && receipt?.readback?.baselineObservedSeq === execution.expectedBaselineSeq
    && receipt?.readback?.baselineEventDigest === status.recoveryReadbackDigest;
  const sourceStateMatches = status?.lifecycleStatus === 'abandoned'
    || (permitted && ['prepared', 'legacy-unverified'].includes(status?.lifecycleStatus)
      && status?.recoveryStatus === 'permitted')
    || (claimed && status?.lifecycleStatus === 'submission-attempted'
      && status?.recoveryStatus === 'submission-attempted');
  if (receipt?.schemaVersion !== 'forge-protected-headless-pre-ingress-cancellation/v1'
    || helperResult.status !== 'not-observed-no-resend'
    || receipt.status !== 'not-observed-no-resend'
    || receipt.operationId !== operation.operationId || receipt.taskId !== target.taskId
    || receipt.sessionId !== execution.sessionId || receipt.rpcId !== execution.rpcId
    || receipt.promptDigest !== digests.promptTextSha256
    || receipt.phaseAttemptId !== execution.phaseAttemptId || receipt.phaseId !== execution.phaseId
    || receipt.executionId !== execution.executionId || receipt.claimId !== execution.claimId
    || receipt.generation !== execution.generation || receipt.contractId !== execution.contractId
    || receipt.sourceCommit !== execution.sourceCommit
    || receipt.maintenance?.epoch !== `recovery-${operation.operationId}`
    || receipt.maintenance?.drained !== true || receipt.durableIntent !== null
    || (!permitted && !claimed) || !sourceStateMatches || status?.exactIdentity !== true
    || status?.consumed === true
    || receipt.readback?.historyComplete !== true
    || receipt.readback?.requestObserved !== false
    || receipt.readback?.turnOpen !== false
    || receipt.readback?.session?.running !== false
    || receipt.readback?.session?.sessionId !== execution.sessionId
    || !Number.isSafeInteger(receipt.readback?.observedSeq)
    || !SHA256.test(receipt.readback?.eventDigest ?? '')
    || terminalization?.lifecycleStatus !== 'abandoned'
    || terminalization?.recoveryStatus !== 'abandoned'
    || terminalization?.exactIdentity !== true
    || tombstone?.operationId !== operation.operationId
    || tombstone?.phaseAttemptId !== execution.phaseAttemptId
    || tombstone?.executionId !== execution.executionId
    || tombstone?.claimId !== execution.claimId
    || tombstone?.generation !== execution.generation
    || tombstone?.contractId !== execution.contractId
    || tombstone?.rpcId !== execution.rpcId
    || tombstone?.dshSessionId !== execution.sessionId
    || tombstone?.textDigest !== digests.promptTextSha256
    || tombstone?.reason !== 'stable-idle-pre-ingress-cancelled-no-resend'
    || tombstone?.requestObserved !== false
    || receipt.proofScope?.brokerExecutionContextConsumed !== false
    || receipt.proofScope?.ingressForwarded !== false
    || receipt.proofScope?.phaseGuardBound !== false
    || receipt.proofScope?.classification
      !== 'broker-execution-context-abandoned-before-ingress'
    || receipt.safeToRestoreUserIngress !== true || receipt.safeToResend !== false) {
    fail(
      'HOST_RECOVERY_RESULT_INVALID',
      'Cancellation receipt does not prove exact stable pre-ingress terminalization.',
    );
  }
  return receipt;
}

function isExactUnclaimedPreIngressStatus(status) {
  const common = status?.exactIdentity === true
    && Number.isSafeInteger(status.revision) && status.revision >= 0
    && ['prepared', 'legacy-unverified'].includes(status.lifecycleStatus)
    && status.consumed === false && status.consumedAt === null
    && status.recoveryReadbackSeq === null && status.recoveryReadbackDigest === null
    && status.terminalTombstone === null;
  const permitted = status?.recoveryStatus === 'permitted'
    && status.descriptorExecutionStateUnchanged === false
    && status.executionStateSha256 === null;
  const unpermitted = status?.recoveryStatus === null
    && status.descriptorExecutionStateUnchanged === true
    && SHA256.test(status.executionStateSha256 ?? '');
  return common && (permitted || unpermitted);
}

function sameExactUnclaimedPreIngressStatus(left, right) {
  return isExactUnclaimedPreIngressStatus(left) && isExactUnclaimedPreIngressStatus(right)
    && left.revision === right.revision
    && left.taskId === right.taskId && left.operationId === right.operationId
    && left.executionId === right.executionId && left.claimId === right.claimId
    && left.generation === right.generation && left.contractId === right.contractId
    && left.phaseAttemptId === right.phaseAttemptId
    && left.lifecycleStatus === right.lifecycleStatus
    && left.recoveryStatus === right.recoveryStatus
    && left.descriptorExecutionStateUnchanged === right.descriptorExecutionStateUnchanged
    && left.executionStateSha256 === right.executionStateSha256;
}

function validatePreIngressFailureReceipt(bytes, helperResult, descriptor, observedStatus) {
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); } catch {
    fail('HOST_RECOVERY_RESULT_INVALID', 'Pre-ingress failure receipt is not valid JSON.');
  }
  const { execution, operation, target, digests } = descriptor;
  const status = receipt?.executionStatus;
  const failureCode = receipt?.failure?.code;
  const genericFailure = failureCode === 'RECOVERY_PRE_INGRESS_VALIDATION_FAILED';
  if (receipt?.schemaVersion !== 'forge-protected-headless-pre-ingress-failure/v1'
    || helperResult.status !== 'pre-ingress-failed' || receipt.status !== 'pre-ingress-failed'
    || receipt.operationId !== operation.operationId
    || receipt.descriptorSha256 !== operation.descriptorSha256
    || receipt.taskId !== target.taskId
    || receipt.sessionId !== execution.sessionId || receipt.rpcId !== execution.rpcId
    || receipt.promptDigest !== digests.promptTextSha256
    || receipt.phaseAttemptId !== execution.phaseAttemptId || receipt.phaseId !== execution.phaseId
    || receipt.executionId !== execution.executionId || receipt.claimId !== execution.claimId
    || receipt.generation !== execution.generation || receipt.contractId !== execution.contractId
    || receipt.sourceCommit !== execution.sourceCommit
    || receipt.maintenanceEpoch !== `recovery-${operation.operationId}`
    || typeof failureCode !== 'string'
    || !/^[A-Z][A-Z0-9_]{2,127}$/u.test(failureCode)
    || receipt.failure?.structured !== !genericFailure
    || receipt.durableIntent !== null
    || !['permitted-unclaimed', 'unpermitted-state-unchanged'].includes(receipt.preIngressState)
    || !isExactUnclaimedPreIngressStatus(status)
    || status.taskId !== target.taskId || status.operationId !== operation.operationId
    || status.executionId !== execution.executionId || status.claimId !== execution.claimId
    || status.generation !== execution.generation || status.contractId !== execution.contractId
    || status.phaseAttemptId !== execution.phaseAttemptId
    || (receipt.preIngressState === 'permitted-unclaimed')
      !== (status.recoveryStatus === 'permitted')
    || (status.descriptorExecutionStateUnchanged
      && status.executionStateSha256 !== digests.executionStateSha256)
    || !sameExactUnclaimedPreIngressStatus(status, observedStatus)
    || receipt.proofScope?.brokerRecoveryPermitIssued
      !== (receipt.preIngressState === 'permitted-unclaimed')
    || receipt.proofScope?.brokerExecutionContextClaimed !== false
    || receipt.proofScope?.durableIntentWritten !== false
    || receipt.proofScope?.ingressForwarded !== false
    || receipt.proofScope?.modelRequestSubmitted !== false
    || receipt.proofScope?.classification !== 'exact-unclaimed-pre-ingress-helper-failure'
    || receipt.safeToRestoreUserIngress !== true
    || receipt.automaticRetryAuthorized !== false) {
    fail(
      'HOST_RECOVERY_RESULT_INVALID',
      'Pre-ingress failure receipt does not prove one exact unclaimed no-intent boundary.',
    );
  }
  return receipt;
}

function validateDefinitiveRecoveryReceipt(bytes, helperResult, descriptor, intentIdentity) {
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); } catch {
    fail('HOST_RECOVERY_RESULT_INVALID', 'Recovery receipt is not valid JSON.');
  }
  const { execution, operation, target, digests } = descriptor;
  const consumption = receipt?.executionConsumption;
  const expectedIntentFile = `submission-intent-${operation.operationId}.json`;
  if (receipt?.schemaVersion !== 'forge-protected-headless-recovery/v1'
    || receipt.status !== helperResult.status
    || receipt.operationId !== operation.operationId || receipt.taskId !== target.taskId
    || receipt.sessionId !== execution.sessionId || receipt.rpcId !== execution.rpcId
    || receipt.promptDigest !== digests.promptTextSha256
    || receipt.phaseAttemptId !== execution.phaseAttemptId || receipt.phaseId !== execution.phaseId
    || receipt.executionId !== execution.executionId || receipt.claimId !== execution.claimId
    || receipt.generation !== execution.generation || receipt.contractId !== execution.contractId
    || receipt.sourceCommit !== execution.sourceCommit
    || receipt.maintenance?.epoch !== `recovery-${operation.operationId}`
    || receipt.maintenance?.drained !== true
    || receipt.durableIntent?.file !== expectedIntentFile
    || receipt.durableIntent?.sha256 !== intentIdentity.sha256
    || receipt.durableIntent?.writtenBeforeIngress !== true
    || receipt.durableIntent?.automaticResendForbidden !== true
    || receipt.ingress?.forwarded !== true || receipt.ingress?.idempotent !== false
    || consumption?.taskId !== target.taskId || consumption?.operationId !== operation.operationId
    || consumption?.executionId !== execution.executionId || consumption?.claimId !== execution.claimId
    || consumption?.generation !== execution.generation || consumption?.contractId !== execution.contractId
    || consumption?.phaseAttemptId !== execution.phaseAttemptId
    || consumption?.lifecycleStatus !== 'consumed' || consumption?.recoveryStatus !== 'consumed'
    || consumption?.consumed !== true || consumption?.exactIdentity !== true
    || typeof consumption?.consumedAt !== 'string' || !Number.isFinite(Date.parse(consumption.consumedAt))
    || receipt.proofScope?.brokerExecutionContextConsumed !== true
    || receipt.proofScope?.phaseGuardBound !== false
    || receipt.proofScope?.classification !== 'broker-execution-context-consumed') {
    fail(
      'HOST_RECOVERY_RESULT_INVALID',
      'Recovery receipt does not prove exact Broker consumption of the one-shot recovery identity.',
    );
  }
  return receipt;
}

async function recoveryIntentPresent(evidenceDirectory, operationId) {
  const intentFile = path.join(evidenceDirectory, `submission-intent-${operationId}.json`);
  const information = await lstat(intentFile).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  return information !== undefined;
}

async function observeExactHostRecoveryStatus(readRecoveryStatus, descriptor) {
  try {
    const value = await readRecoveryStatus({
      projectRoot: descriptor.paths.projectControlRoot,
      taskId: descriptor.target.taskId,
      operationId: descriptor.operation.operationId,
      executionId: descriptor.execution.executionId,
      claimId: descriptor.execution.claimId,
      generation: descriptor.execution.generation,
      contractId: descriptor.execution.contractId,
      phaseAttemptId: descriptor.execution.phaseAttemptId,
    });
    if (value?.taskId !== descriptor.target.taskId
      || value.operationId !== descriptor.operation.operationId
      || value.executionId !== descriptor.execution.executionId
      || value.claimId !== descriptor.execution.claimId
      || value.generation !== descriptor.execution.generation
      || value.contractId !== descriptor.execution.contractId
      || value.phaseAttemptId !== descriptor.execution.phaseAttemptId) {
      fail('HOST_RECOVERY_STATUS_MISMATCH', 'Protected recovery status returned a different identity.');
    }
    return Object.freeze({
      ...value,
      exactIdentity: true,
    });
  } catch (error) {
    return Object.freeze({
      consumed: false,
      lifecycleStatus: null,
      recoveryStatus: null,
      exactIdentity: false,
      errorCode: error?.code ?? 'HOST_RECOVERY_STATUS_UNAVAILABLE',
    });
  }
}

function descriptorBoundUnpermittedHostStatus(bytes, digest, descriptor) {
  let state;
  try { state = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  const { execution, operation, target, digests } = descriptor;
  const current = state?.current;
  const legacy = state?.schemaVersion === 1;
  const lifecycleStatus = legacy ? 'legacy-unverified' : state?.lifecycle?.status;
  const recovery = legacy ? null : state?.recovery;
  const tombstones = legacy || state?.schemaVersion === 2 ? [] : state?.tombstones;
  if (![1, 2, 3].includes(state?.schemaVersion)
    || !Number.isSafeInteger(state.revision) || state.revision < 1
    || state.projectSlug !== target.projectSlug || state.taskId !== target.taskId
    || state.actorUserId !== execution.actorUserId || state.actorUsername !== execution.actorId
    || state.conversationId !== execution.conversationId
    || state.generation !== execution.generation
    || !['prepared', 'legacy-unverified'].includes(lifecycleStatus)
    || (!legacy && state.lifecycle?.consumedAt !== null)
    || recovery !== null || !Array.isArray(tombstones)
    || tombstones.some((entry) => entry?.operationId === operation.operationId
      || entry?.executionId === execution.executionId)
    || current?.projectSlug !== target.projectSlug || current.taskId !== target.taskId
    || current.actorUserId !== execution.actorUserId || current.actorUsername !== execution.actorId
    || current.conversationId !== execution.conversationId
    || current.executionId !== execution.executionId || current.claimId !== execution.claimId
    || current.generation !== execution.generation || current.contractId !== execution.contractId
    || current.rpcId !== execution.rpcId || current.dshSessionId !== execution.sessionId
    || current.textDigest !== digests.promptTextSha256
    || current.sourceCommit !== execution.sourceCommit || current.caseFamily !== execution.caseFamily
    || current.workflowId !== execution.workflowId || current.phaseId !== execution.phaseId
    || current.testOnly !== true || current.authorityClass !== 'test-shadow-writer') return null;
  return Object.freeze({
    revision: state.revision,
    taskId: target.taskId,
    operationId: operation.operationId,
    executionId: execution.executionId,
    claimId: execution.claimId,
    generation: execution.generation,
    contractId: execution.contractId,
    phaseAttemptId: execution.phaseAttemptId,
    lifecycleStatus,
    recoveryStatus: null,
    consumed: false,
    consumedAt: null,
    recoveryReadbackSeq: null,
    recoveryReadbackDigest: null,
    terminalTombstone: null,
    exactIdentity: true,
    descriptorExecutionStateUnchanged: true,
    executionStateSha256: digest,
  });
}

async function observeExactHostPreIngressStatus(
  readRecoveryStatus, descriptor, executionStateFile,
) {
  const recoveryStatus = await observeExactHostRecoveryStatus(readRecoveryStatus, descriptor);
  if (recoveryStatus.exactIdentity === true
    && Number.isSafeInteger(recoveryStatus.revision) && recoveryStatus.revision >= 0
    && ['prepared', 'legacy-unverified'].includes(recoveryStatus.lifecycleStatus)
    && recoveryStatus.recoveryStatus === 'permitted'
    && recoveryStatus.consumed === false && recoveryStatus.consumedAt === null
    && recoveryStatus.recoveryReadbackSeq === null
    && recoveryStatus.recoveryReadbackDigest === null
    && recoveryStatus.terminalTombstone === null) {
    return Object.freeze({
      ...recoveryStatus,
      descriptorExecutionStateUnchanged: false,
      executionStateSha256: null,
    });
  }
  const state = await stableOrdinaryFile(
    executionStateFile, MAX_INPUT_BYTES, 'pre-ingress execution state',
  );
  if (state.sha256 !== descriptor.digests.executionStateSha256) return recoveryStatus;
  return descriptorBoundUnpermittedHostStatus(state.bytes, state.sha256, descriptor)
    ?? recoveryStatus;
}

function canContinueBeforeIngress(status, { intentPresent }) {
  if (status?.exactIdentity !== true || status.consumed === true) return false;
  if (status.lifecycleStatus === 'submission-attempted'
    && status.recoveryStatus === 'submission-attempted') return true;
  return intentPresent === false
    && ['prepared', 'legacy-unverified'].includes(status.lifecycleStatus)
    && status.recoveryStatus === 'permitted';
}

async function authorizePreIngressContainerContinuation({
  evidenceDirectory, descriptor, containerId, stoppedInspection, clock,
}) {
  const state = (Array.isArray(stoppedInspection) ? stoppedInspection[0] : stoppedInspection)?.State;
  if (!containerCanNoLongerSubmit(stoppedInspection)
    || typeof state?.StartedAt !== 'string' || state.StartedAt.length < 1) {
    fail('HOST_RECOVERY_RESTART_BLOCKED', 'Stopped recovery container has no stable start identity.');
  }
  const markerFile = path.join(
    evidenceDirectory,
    `pre-ingress-continuation-${descriptor.operation.operationId}.json`,
  );
  const marker = {
    schemaVersion: 'forge-protected-headless-pre-ingress-continuation/v1',
    operationId: descriptor.operation.operationId,
    descriptorSha256: descriptor.operation.descriptorSha256,
    containerId,
    beforeStartedAt: state.StartedAt,
    authorizedAt: new Date(clock()).toISOString(),
    invariant: 'Only one actual restart of this immutable stopped container is authorized before ingress.',
  };
  const bytes = canonicalJsonBytes(marker);
  try {
    await writeExclusive(markerFile, bytes);
    return Object.freeze({ file: path.basename(markerFile), sha256: sha256(bytes), reused: false });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const existing = await stableOrdinaryFile(markerFile, 16 * 1024, 'pre-ingress continuation marker');
  const value = parseJsonBytes(
    existing.bytes, 'HOST_RECOVERY_RESTART_BLOCKED', 'Pre-ingress continuation marker',
  );
  if (value?.schemaVersion !== marker.schemaVersion || value.operationId !== marker.operationId
    || value.descriptorSha256 !== marker.descriptorSha256 || value.containerId !== containerId
    || value.beforeStartedAt !== state.StartedAt
    || value.invariant !== marker.invariant || !Number.isFinite(Date.parse(value.authorizedAt))) {
    fail('HOST_RECOVERY_RESTART_BLOCKED', 'The one permitted pre-ingress continuation was already consumed.');
  }
  fail(
    'HOST_RECOVERY_RESTART_BLOCKED',
    'The one permitted pre-ingress continuation marker already exists; its start outcome is ambiguous.',
  );
}

function containerCanNoLongerSubmit(value) {
  const state = (Array.isArray(value) ? value[0] : value)?.State;
  return state !== undefined && state.Running === false && state.Paused !== true
    && state.Restarting !== true;
}

async function stableStoppedContainer(run, containerId, descriptor, prepared, definition) {
  const first = await dockerJson(run, ['inspect', containerId]);
  validateRecoveryContainerBoundary(first, descriptor, prepared, definition, { requireCreated: false });
  if (!containerCanNoLongerSubmit(first)) return null;
  const second = await dockerJson(run, ['inspect', containerId]);
  validateRecoveryContainerBoundary(second, descriptor, prepared, definition, { requireCreated: false });
  if (!containerCanNoLongerSubmit(second)) return null;
  return second;
}

async function validateHelperArtifact({
  helperResult,
  descriptor,
  intentIdentity,
  evidenceDirectory,
  reconciliation,
  cancellation = false,
  preIngressFailure = false,
  observedStatus = undefined,
}) {
  const receiptName = path.basename(helperResult.receiptFile);
  const receipt = await stableOrdinaryFile(
    path.join(evidenceDirectory, receiptName), MAX_INPUT_BYTES,
    preIngressFailure
      ? 'pre-ingress failure receipt'
      : cancellation
      ? 'pre-ingress cancellation receipt'
      : reconciliation ? 'recovery reconciliation receipt' : 'recovery receipt',
  );
  if (receipt.sha256 !== helperResult.receiptSha256 || receipt.bytes.length !== helperResult.receiptBytes) {
    fail('HOST_RECOVERY_RESULT_INVALID', 'Recovery receipt identity does not match helper output.');
  }
  const value = preIngressFailure
    ? validatePreIngressFailureReceipt(receipt.bytes, helperResult, descriptor, observedStatus)
    : cancellation
    ? validatePreIngressCancellationReceipt(receipt.bytes, helperResult, descriptor)
    : reconciliation
      ? validateStableReconciliationReceipt(receipt.bytes, helperResult, descriptor, intentIdentity)
      : validateDefinitiveRecoveryReceipt(receipt.bytes, helperResult, descriptor, intentIdentity);
  return Object.freeze({ receiptName, receipt, value });
}

async function runStableRecoveryReconciliation({
  descriptor, prepared, run, evidenceDirectory, helperImageEnvironment,
}) {
  const definition = buildRecoveryReconciliationContainerCreateArgs(
    descriptor, prepared, helperImageEnvironment,
  );
  const existing = await run('docker', ['inspect', definition.name]);
  let containerId;
  let output;
  if (existing.code === 0) {
    let inspection;
    try { inspection = JSON.parse(existing.stdout); } catch {
      fail('HOST_RECOVERY_DOCKER_FAILED', 'Existing reconciliation container inspection is invalid.');
    }
    const identity = validateRecoveryContainerBoundary(
      inspection, descriptor, prepared, definition, { requireCreated: false },
    );
    containerId = identity.id;
    if (!containerCanNoLongerSubmit(inspection)) {
      fail('HOST_RECOVERY_RECONCILIATION_RUNNING', 'Recovery reconciliation is still running.');
    }
    const priorOutput = await run('docker', ['logs', containerId]);
    const priorResult = parseHelperResult(priorOutput.stdout);
    output = priorOutput.code === 0 && priorResult !== null
      && ['submitted-observed', 'observed-unconsumed', 'not-observed-no-resend']
        .includes(priorResult.status)
      ? priorOutput
      : await run('docker', ['start', '--attach', containerId]);
  } else {
    const created = await run('docker', definition.args);
    if (created.code !== 0 || !CONTAINER_ID.test(created.stdout.trim())) {
      fail('HOST_RECOVERY_DOCKER_FAILED', 'Recovery reconciliation container creation failed.');
    }
    containerId = created.stdout.trim();
    validateRecoveryContainerBoundary(
      await dockerJson(run, ['inspect', containerId]), descriptor, prepared, definition,
    );
    output = await run('docker', ['start', '--attach', containerId]);
  }
  const helperResult = parseHelperResult(output.stdout);
  if (output.code !== 0 || helperResult === null
    || !['submitted-observed', 'observed-unconsumed', 'not-observed-no-resend']
      .includes(helperResult.status)) {
    fail('HOST_RECOVERY_RECONCILIATION_AMBIGUOUS', 'Stable recovery reconciliation did not produce a valid result.');
  }
  const stopped = await stableStoppedContainer(run, containerId, descriptor, prepared, definition);
  if (stopped === null) {
    fail('HOST_RECOVERY_RECONCILIATION_RUNNING', 'Recovery reconciliation did not reach a stopped boundary.');
  }
  const intent = await stableOrdinaryFile(
    path.join(evidenceDirectory, `submission-intent-${descriptor.operation.operationId}.json`),
    MAX_INPUT_BYTES,
    'durable recovery intent',
  );
  const artifact = await validateHelperArtifact({
    helperResult,
    descriptor,
    intentIdentity: intent,
    evidenceDirectory,
    reconciliation: true,
  });
  return Object.freeze({ containerId, helperResult, ...artifact });
}

async function runStablePreIngressCancellation({
  descriptor, prepared, run, evidenceDirectory, helperImageEnvironment,
}) {
  if (await recoveryIntentPresent(evidenceDirectory, descriptor.operation.operationId)) {
    fail(
      'HOST_RECOVERY_CANCELLATION_BLOCKED',
      'Durable recovery intent exists; pre-ingress cancellation is forbidden.',
    );
  }
  const definition = buildRecoveryPreIngressCancellationContainerCreateArgs(
    descriptor, prepared, helperImageEnvironment,
  );
  const existing = await run('docker', ['inspect', definition.name]);
  let containerId;
  let output;
  if (existing.code === 0) {
    let inspection;
    try { inspection = JSON.parse(existing.stdout); } catch {
      fail('HOST_RECOVERY_DOCKER_FAILED', 'Existing cancellation container inspection is invalid.');
    }
    const identity = validateRecoveryContainerBoundary(
      inspection, descriptor, prepared, definition, { requireCreated: false },
    );
    containerId = identity.id;
    if (!containerCanNoLongerSubmit(inspection)) {
      fail('HOST_RECOVERY_CANCELLATION_RUNNING', 'Pre-ingress cancellation is still running.');
    }
    const priorOutput = await run('docker', ['logs', containerId]);
    const priorResult = parseHelperResult(priorOutput.stdout);
    output = priorOutput.code === 0 && priorResult?.status === 'not-observed-no-resend'
      ? priorOutput
      : await run('docker', ['start', '--attach', containerId]);
  } else {
    const created = await run('docker', definition.args);
    if (created.code !== 0 || !CONTAINER_ID.test(created.stdout.trim())) {
      fail('HOST_RECOVERY_DOCKER_FAILED', 'Pre-ingress cancellation container creation failed.');
    }
    containerId = created.stdout.trim();
    validateRecoveryContainerBoundary(
      await dockerJson(run, ['inspect', containerId]), descriptor, prepared, definition,
    );
    output = await run('docker', ['start', '--attach', containerId]);
  }
  const helperResult = parseHelperResult(output.stdout);
  if (output.code !== 0 || helperResult?.status !== 'not-observed-no-resend') {
    fail(
      'HOST_RECOVERY_CANCELLATION_AMBIGUOUS',
      'Pre-ingress cancellation did not produce a valid no-resend result.',
    );
  }
  const stopped = await stableStoppedContainer(run, containerId, descriptor, prepared, definition);
  if (stopped === null) {
    fail('HOST_RECOVERY_CANCELLATION_RUNNING', 'Pre-ingress cancellation did not reach a stopped boundary.');
  }
  if (await recoveryIntentPresent(evidenceDirectory, descriptor.operation.operationId)) {
    fail(
      'HOST_RECOVERY_CANCELLATION_BLOCKED',
      'Durable recovery intent appeared during pre-ingress cancellation.',
    );
  }
  const artifact = await validateHelperArtifact({
    helperResult,
    descriptor,
    intentIdentity: null,
    evidenceDirectory,
    reconciliation: false,
    cancellation: true,
  });
  return Object.freeze({ containerId, helperResult, ...artifact });
}

async function assertRuntimeIdentitiesUnchanged({
  run, descriptor, paths, harnessIdentity, brokerIdentity,
  enforceHostOwnership, validateLiveMounts,
}) {
  const harnessInspect = await dockerJson(run, ['inspect', descriptor.target.harnessContainerId]);
  const brokerInspect = await dockerJson(run, ['inspect', descriptor.target.brokerContainerId]);
  const harness = validateHarnessRecoveryBoundary(harnessInspect, descriptor, paths);
  const broker = validateBrokerRecoveryBoundary(brokerInspect, descriptor, paths);
  if (enforceHostOwnership) {
    await validateLiveMounts(harnessInspect, harnessBindMountSpecifications(descriptor, paths));
    await validateLiveMounts(brokerInspect, brokerBindMountSpecifications(descriptor, paths));
  }
  if (harness.pid !== harnessIdentity.pid || harness.restartCount !== harnessIdentity.restartCount) {
    fail('HOST_RECOVERY_HARNESS_DRIFT', 'Harness restarted during the protected recovery operation.');
  }
  if (broker.pid !== brokerIdentity.pid || broker.restartCount !== brokerIdentity.restartCount) {
    fail('HOST_RECOVERY_BROKER_DRIFT', 'TaskSpace Broker restarted during the protected recovery operation.');
  }
  return Object.freeze({ harness, broker });
}

export async function executeHostProtectedRecovery({
  descriptor,
  allowedRoot,
  run = runProcess,
  health,
  sleep,
  enforceHostOwnership = false,
  readRecoveryStatus = readProtectedExecutionRecoveryStatus,
  validateSharedLocks = async () => {},
  validateLiveMounts = validateLiveContainerBindMounts,
  validateBrokerDns = validatePinnedBrokerDnsBoundary,
  now = () => new Date(),
}) {
  await validateSharedLocks();
  const validated = validateHostRecoveryDescriptor(descriptor, { allowedRoot });
  const maintenanceHealth = health ?? (() => probeHarnessMaintenanceHealth({
    run,
    harnessContainerId: descriptor.target.harnessContainerId,
  }));
  const { paths } = validated;
  const maintenanceEpoch = `recovery-${descriptor.operation.operationId}`;
  const observedFence = await stableOrdinaryFile(paths.maintenanceFenceFile, 4096, 'maintenance fence');
  const observedFenceValue = exactFence(observedFence.bytes);
  const ownsExistingMaintenance = observedFenceValue.state === 'maintenance'
    && observedFenceValue.epoch === maintenanceEpoch;
  if (!ownsExistingMaintenance) assertAuthorizationCurrent(descriptor, now);
  const durableIntentPresentAtAdmission = ownsExistingMaintenance
    && await recoveryIntentPresent(paths.evidenceDirectory, descriptor.operation.operationId);
  const prepared = durableIntentPresentAtAdmission
    ? await prepareHostRecoveryReconciliationInputs(validated, { enforceHostOwnership })
    : await prepareHostRecoveryInputs(validated, { enforceHostOwnership });
  const liveInputsPrepared = prepared.filePaths !== undefined;
  const helperImageIdentity = await inspectRecoveryHelperImage(run, descriptor);
  const journalFile = path.join(paths.evidenceDirectory, 'host-recovery-journal.json');
  const originalFenceFileName = `original-fence-${descriptor.operation.operationId}.json`;
  const originalFenceFile = path.join(paths.evidenceDirectory, originalFenceFileName);
  let originalFence;
  let originalFenceInput;
  let journalBase;
  let resumedMaintenance = false;

  if (observedFenceValue.state === 'committed') {
    originalFence = exactFence(observedFence.bytes, 'committed');
    await snapshotExclusive(observedFence.bytes, originalFenceFile).catch(async (error) => {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await stableOrdinaryFile(originalFenceFile, 4096, 'original maintenance fence snapshot');
      if (existing.sha256 !== observedFence.sha256 || !existing.bytes.equals(observedFence.bytes)) {
        fail('HOST_RECOVERY_JOURNAL_INVALID', 'Existing original fence snapshot differs from the committed fence.');
      }
    });
    originalFenceInput = await stableOrdinaryFile(originalFenceFile, 4096, 'original maintenance fence snapshot');
    const candidateBase = {
      operationId: descriptor.operation.operationId,
      descriptorSha256: descriptor.operation.descriptorSha256,
      harnessContainerId: descriptor.target.harnessContainerId,
      brokerContainerId: descriptor.target.brokerContainerId,
      recoveryHelperImageId: helperImageIdentity.id,
      recoveryHelperBuildInputDigest: helperImageIdentity.buildInputDigest,
      originalFenceFile: originalFenceFileName,
      originalFenceSha256: originalFenceInput.sha256,
      originalFenceEpoch: originalFence.epoch,
      originalFenceMode: observedFence.stat.mode & 0o777,
      originalFenceUid: observedFence.stat.uid,
      originalFenceGid: observedFence.stat.gid,
    };
    const priorJournal = await readJournalIfPresent(journalFile, descriptor);
    if (priorJournal !== null) {
      journalBase = journalBaseFrom(priorJournal);
      if (JSON.stringify(journalBase) !== JSON.stringify(candidateBase)
        || priorJournal.state === 'restored') {
        fail('HOST_RECOVERY_REPLAY_BLOCKED', 'A completed or identity-drifted recovery operation cannot be replayed.');
      }
    } else {
      journalBase = Object.freeze(candidateBase);
    }
    await writeJournal(
      journalFile, journalBase, 'prepared', {}, { createOnly: priorJournal === null },
    );
  } else {
    if (observedFenceValue.state !== 'maintenance' || observedFenceValue.epoch !== maintenanceEpoch) {
      fail('HOST_RECOVERY_FENCE_OWNERSHIP_LOST', 'A foreign maintenance fence was preserved.');
    }
    const priorJournal = await readJournal(journalFile, descriptor);
    journalBase = journalBaseFrom(priorJournal);
    if (journalBase.originalFenceFile !== originalFenceFileName) {
      fail('HOST_RECOVERY_JOURNAL_INVALID', 'Recovery journal points to an unexpected original fence snapshot.');
    }
    originalFenceInput = await stableOrdinaryFile(originalFenceFile, 4096, 'original maintenance fence snapshot');
    if (originalFenceInput.sha256 !== journalBase.originalFenceSha256) {
      fail('HOST_RECOVERY_JOURNAL_INVALID', 'Original fence snapshot digest drifted.');
    }
    originalFence = exactFence(originalFenceInput.bytes, 'committed', journalBase.originalFenceEpoch);
    resumedMaintenance = true;
    await writeJournal(journalFile, journalBase, 'reconcile-resumed', {
      maintenanceEpoch, originalFenceRestored: false,
    });
  }

  const harnessBefore = await dockerJson(run, ['inspect', descriptor.target.harnessContainerId]);
  const harnessIdentity = validateHarnessRecoveryBoundary(harnessBefore, descriptor, paths);
  const brokerBefore = await dockerJson(run, ['inspect', descriptor.target.brokerContainerId]);
  const brokerIdentity = validateBrokerRecoveryBoundary(brokerBefore, descriptor, paths);
  if (enforceHostOwnership) {
    await validateLiveMounts(harnessBefore, harnessBindMountSpecifications(descriptor, paths));
    await validateLiveMounts(brokerBefore, brokerBindMountSpecifications(descriptor, paths));
    await validateBrokerDns(run, descriptor, harnessBefore, brokerBefore);
  }
  const maintenanceBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1, state: 'maintenance', epoch: maintenanceEpoch,
  })}\n`, 'utf8');

  let maintenanceOwned = resumedMaintenance;
  let safeToRestoreFence = false;
  let containerId = null;
  let terminalOutcome = null;
  const reconcileStoppedOperation = async () => {
    const reconciled = await runStableRecoveryReconciliation({
      descriptor, prepared, run, evidenceDirectory: paths.evidenceDirectory,
      helperImageEnvironment: helperImageIdentity.imageEnvironment,
    });
    await assertRuntimeIdentitiesUnchanged({
      run, descriptor, paths, harnessIdentity, brokerIdentity,
      enforceHostOwnership, validateLiveMounts,
    });
    safeToRestoreFence = true;
    terminalOutcome = {
      state: 'reconciled',
      helperStatus: reconciled.helperResult.status,
      receipt: {
        file: reconciled.receiptName,
        sha256: reconciled.receipt.sha256,
        bytes: reconciled.receipt.bytes.length,
      },
    };
    await writeJournal(journalFile, journalBase, 'reconciled', {
      maintenanceEpoch, containerId, ...terminalOutcome,
    });
    return Object.freeze({
      status: reconciled.helperResult.status,
      operationId: descriptor.operation.operationId,
      descriptorSha256: descriptor.operation.descriptorSha256,
      containerId: containerId ?? reconciled.containerId,
      reconciliationContainerId: reconciled.containerId,
      receiptFile: reconciled.receiptName,
      receiptSha256: reconciled.receipt.sha256,
      automaticResendForbidden: true,
    });
  };
  const cancelStoppedPreIngressOperation = async (reason) => {
    safeToRestoreFence = false;
    const cancelled = await runStablePreIngressCancellation({
      descriptor,
      prepared,
      run,
      evidenceDirectory: paths.evidenceDirectory,
      helperImageEnvironment: helperImageIdentity.imageEnvironment,
    });
    await assertRuntimeIdentitiesUnchanged({
      run, descriptor, paths, harnessIdentity, brokerIdentity,
      enforceHostOwnership, validateLiveMounts,
    });
    safeToRestoreFence = true;
    terminalOutcome = {
      state: 'pre-ingress-cancelled',
      reason,
      helperStatus: cancelled.helperResult.status,
      receipt: {
        file: cancelled.receiptName,
        sha256: cancelled.receipt.sha256,
        bytes: cancelled.receipt.bytes.length,
      },
    };
    await writeJournal(journalFile, journalBase, 'pre-ingress-cancelled', {
      maintenanceEpoch,
      containerId,
      cancellationContainerId: cancelled.containerId,
      ...terminalOutcome,
    });
    return Object.freeze({
      status: cancelled.helperResult.status,
      operationId: descriptor.operation.operationId,
      descriptorSha256: descriptor.operation.descriptorSha256,
      containerId,
      cancellationContainerId: cancelled.containerId,
      receiptFile: cancelled.receiptName,
      receiptSha256: cancelled.receipt.sha256,
      automaticResendForbidden: true,
      preIngressCancelled: true,
      reason,
    });
  };
  try {
    if (!resumedMaintenance) {
      await validateSharedLocks();
      const fenceRecheck = await stableOrdinaryFile(paths.maintenanceFenceFile, 4096, 'maintenance fence');
      if (fenceRecheck.sha256 !== observedFence.sha256 || fenceRecheck.stat.dev !== observedFence.stat.dev
        || fenceRecheck.stat.ino !== observedFence.stat.ino) {
        fail('HOST_RECOVERY_FENCE_OWNERSHIP_LOST', 'Maintenance fence changed before recovery admission.');
      }
      await atomicReplace(paths.maintenanceFenceFile, maintenanceBytes, {
        mode: journalBase.originalFenceMode,
        uid: journalBase.originalFenceUid,
        gid: journalBase.originalFenceGid,
      });
      maintenanceOwned = true;
      safeToRestoreFence = true;
      await writeJournal(journalFile, journalBase, 'fence-installed', { maintenanceEpoch });
    }
    const drain = await waitForStableMaintenanceDrain({
      port: descriptor.target.hostProxyPort, epoch: maintenanceEpoch, health: maintenanceHealth, sleep,
    });
    await writeJournal(journalFile, journalBase, 'drained', { maintenanceEpoch, drain });
    const harnessRecheck = await dockerJson(run, ['inspect', descriptor.target.harnessContainerId]);
    const recheckedIdentity = validateHarnessRecoveryBoundary(harnessRecheck, descriptor, paths);
    if (recheckedIdentity.pid !== harnessIdentity.pid || recheckedIdentity.restartCount !== harnessIdentity.restartCount) {
      fail('HOST_RECOVERY_HARNESS_DRIFT', 'Harness restarted after maintenance admission.');
    }
    const brokerRecheck = validateBrokerRecoveryBoundary(
      await dockerJson(run, ['inspect', descriptor.target.brokerContainerId]), descriptor, paths,
    );
    if (brokerRecheck.pid !== brokerIdentity.pid || brokerRecheck.restartCount !== brokerIdentity.restartCount) {
      fail('HOST_RECOVERY_BROKER_DRIFT', 'TaskSpace Broker restarted after recovery admission.');
    }
    if (enforceHostOwnership) {
      await validateLiveMounts(harnessRecheck, harnessBindMountSpecifications(descriptor, paths));
      const brokerMountRecheck = await dockerJson(run, ['inspect', descriptor.target.brokerContainerId]);
      validateBrokerRecoveryBoundary(brokerMountRecheck, descriptor, paths);
      await validateLiveMounts(brokerMountRecheck, brokerBindMountSpecifications(descriptor, paths));
      await validateBrokerDns(run, descriptor, harnessRecheck, brokerMountRecheck);
    }
    if (liveInputsPrepared) await revalidateHostRecoveryInputs(validated, prepared);
    const definition = buildRecoveryContainerCreateArgs(
      descriptor, prepared, helperImageIdentity.imageEnvironment,
    );
    const existing = await run('docker', ['inspect', definition.name]);
    let containerReadyToStart = false;
    if (existing.code === 0) {
      let existingInspect;
      try { existingInspect = JSON.parse(existing.stdout); } catch {
        fail('HOST_RECOVERY_DOCKER_FAILED', 'Existing recovery container inspection is invalid.');
      }
      const existingIdentity = validateRecoveryContainerBoundary(
        existingInspect, descriptor, prepared, definition, { requireCreated: false },
      );
      containerId = existingIdentity.id;
      const stopped = await stableStoppedContainer(run, containerId, descriptor, prepared, definition);
      if (stopped === null) {
        safeToRestoreFence = false;
        await writeJournal(journalFile, journalBase, 'existing-container-ambiguous', {
          maintenanceEpoch, containerId, originalFenceRestored: false, reason: 'container-running-or-unknown',
        });
        fail('HOST_RECOVERY_RECONCILIATION_RUNNING', 'Existing recovery container is still running or unstable.');
      }
      const intentPresent = await recoveryIntentPresent(paths.evidenceDirectory, descriptor.operation.operationId);
      const status = await observeExactHostRecoveryStatus(readRecoveryStatus, descriptor);
      if (canContinueBeforeIngress(status, { intentPresent })) {
        safeToRestoreFence = true;
        try {
          assertAuthorizationCurrent(descriptor, now);
        } catch (error) {
          if (intentPresent) {
            safeToRestoreFence = false;
            return await reconcileStoppedOperation();
          }
          return await cancelStoppedPreIngressOperation('authorization-expired-before-ingress');
        }
        const containerState = (Array.isArray(stopped) ? stopped[0] : stopped)?.State;
        let continuation = null;
        if (containerState?.Status !== 'created') {
          try {
            continuation = await authorizePreIngressContainerContinuation({
              evidenceDirectory: paths.evidenceDirectory,
              descriptor,
              containerId,
              stoppedInspection: stopped,
              clock: now,
            });
          } catch (error) {
            if (error?.code === 'HOST_RECOVERY_RESTART_BLOCKED') {
              return await cancelStoppedPreIngressOperation('pre-ingress-continuation-exhausted');
            }
            throw error;
          }
        }
        await writeJournal(journalFile, journalBase, 'pre-ingress-continuation-authorized', {
          maintenanceEpoch, containerId, intentPresent, executionStatus: status,
          ...(continuation === null ? {} : { continuation }),
        });
        containerReadyToStart = true;
      } else if (intentPresent) {
        safeToRestoreFence = false;
        return await reconcileStoppedOperation();
      } else {
        const containerState = (Array.isArray(stopped) ? stopped[0] : stopped)?.State;
        safeToRestoreFence = containerState?.Status === 'created';
        fail(
          'HOST_RECOVERY_REPLAY_BLOCKED',
          'Stopped recovery container has no durable intent and no exact pre-ingress state; it was not restarted.',
        );
      }
    }
    if (existing.code !== 0 && resumedMaintenance) {
      const intentPresent = await recoveryIntentPresent(paths.evidenceDirectory, descriptor.operation.operationId);
      if (intentPresent) {
        safeToRestoreFence = false;
        return await reconcileStoppedOperation();
      }
      safeToRestoreFence = true;
    }
    if (!containerReadyToStart) {
      try {
        assertAuthorizationCurrent(descriptor, now);
      } catch (error) {
        const intentPresent = await recoveryIntentPresent(
          paths.evidenceDirectory, descriptor.operation.operationId,
        );
        if (intentPresent) {
          safeToRestoreFence = false;
          return await reconcileStoppedOperation();
        }
        const status = await observeExactHostRecoveryStatus(readRecoveryStatus, descriptor);
        if (canContinueBeforeIngress(status, { intentPresent: false })) {
          return await cancelStoppedPreIngressOperation('authorization-expired-before-ingress');
        }
        throw error;
      }
      const created = await run('docker', definition.args);
      if (created.code !== 0 || !CONTAINER_ID.test(created.stdout.trim())) {
        fail('HOST_RECOVERY_DOCKER_FAILED', 'Recovery container creation failed.');
      }
      containerId = created.stdout.trim();
      const helperInspect = await dockerJson(run, ['inspect', containerId]);
      validateRecoveryContainerBoundary(helperInspect, descriptor, prepared, definition);
      await writeJournal(journalFile, journalBase, 'container-created', { maintenanceEpoch, containerId });
    }
    const finalHarnessInspect = await dockerJson(run, ['inspect', descriptor.target.harnessContainerId]);
    const finalHarness = validateHarnessRecoveryBoundary(finalHarnessInspect, descriptor, paths);
    if (finalHarness.pid !== harnessIdentity.pid || finalHarness.restartCount !== harnessIdentity.restartCount) {
      fail('HOST_RECOVERY_HARNESS_DRIFT', 'Harness restarted before the recovery helper started.');
    }
    const finalBroker = validateBrokerRecoveryBoundary(
      await dockerJson(run, ['inspect', descriptor.target.brokerContainerId]), descriptor, paths,
    );
    if (finalBroker.pid !== brokerIdentity.pid || finalBroker.restartCount !== brokerIdentity.restartCount) {
      fail('HOST_RECOVERY_BROKER_DRIFT', 'TaskSpace Broker restarted before the recovery helper started.');
    }
    if (enforceHostOwnership) {
      await validateLiveMounts(finalHarnessInspect, harnessBindMountSpecifications(descriptor, paths));
      const finalBrokerInspect = await dockerJson(run, ['inspect', descriptor.target.brokerContainerId]);
      validateBrokerRecoveryBoundary(finalBrokerInspect, descriptor, paths);
      await validateLiveMounts(finalBrokerInspect, brokerBindMountSpecifications(descriptor, paths));
      await validateBrokerDns(run, descriptor, finalHarnessInspect, finalBrokerInspect);
    }
    if (liveInputsPrepared) await revalidateHostRecoveryInputs(validated, prepared);
    exactFence((await stableOrdinaryFile(paths.maintenanceFenceFile, 4096, 'maintenance fence')).bytes,
      'maintenance', maintenanceEpoch);
    safeToRestoreFence = true;
    const intentFile = path.join(
      paths.evidenceDirectory, `submission-intent-${descriptor.operation.operationId}.json`,
    );
    let started;
    let helperResult;
    for (let startAttempt = 1; startAttempt <= 2; startAttempt += 1) {
      try {
        assertAuthorizationCurrent(descriptor, now);
      } catch (error) {
        const intentPresent = await recoveryIntentPresent(
          paths.evidenceDirectory, descriptor.operation.operationId,
        );
        if (intentPresent) return await reconcileStoppedOperation();
        const status = await observeExactHostRecoveryStatus(readRecoveryStatus, descriptor);
        if (canContinueBeforeIngress(status, { intentPresent: false })) {
          return await cancelStoppedPreIngressOperation('authorization-expired-before-ingress');
        }
        safeToRestoreFence = true;
        throw error;
      }
      await persistValidatedPreModelWorkspaceSnapshot(descriptor, paths);
      safeToRestoreFence = false;
      started = await run('docker', ['start', '--attach', containerId]);
      helperResult = parseHelperResult(started.stdout);
      if (started.code === 0 && helperResult !== null) break;
      const stopped = await stableStoppedContainer(run, containerId, descriptor, prepared, definition)
        .catch(() => null);
      if (stopped === null) {
        fail('HOST_RECOVERY_RESULT_AMBIGUOUS', 'Recovery helper is still running or its state is unknown.');
      }
      const intentPresent = await recoveryIntentPresent(
        paths.evidenceDirectory, descriptor.operation.operationId,
      );
      const status = await observeExactHostRecoveryStatus(readRecoveryStatus, descriptor);
      if (!canContinueBeforeIngress(status, { intentPresent })) {
        if (intentPresent) return await reconcileStoppedOperation();
        safeToRestoreFence = false;
        fail(
          'HOST_RECOVERY_RESULT_AMBIGUOUS',
          'Stopped recovery helper has no exact pre-ingress continuation state; it was not restarted.',
        );
      }
      if (startAttempt >= 2) {
        return await cancelStoppedPreIngressOperation('pre-ingress-continuation-exhausted');
      }
      let continuation;
      try {
        continuation = await authorizePreIngressContainerContinuation({
          evidenceDirectory: paths.evidenceDirectory,
          descriptor,
          containerId,
          stoppedInspection: stopped,
          clock: now,
        });
      } catch (error) {
        if (error?.code === 'HOST_RECOVERY_RESTART_BLOCKED') {
          return await cancelStoppedPreIngressOperation('pre-ingress-continuation-exhausted');
        }
        safeToRestoreFence = false;
        throw error;
      }
      await writeJournal(journalFile, journalBase, 'pre-ingress-continuation-authorized', {
        maintenanceEpoch, containerId, intentPresent, executionStatus: status, continuation,
      });
      safeToRestoreFence = true;
    }
    if (helperResult.status === 'pre-ingress-failed') {
      safeToRestoreFence = false;
      const stopped = await stableStoppedContainer(run, containerId, descriptor, prepared, definition);
      if (stopped === null) {
        fail(
          'HOST_RECOVERY_RESULT_AMBIGUOUS',
          'Pre-ingress failure receipt arrived before the helper reached a stopped boundary.',
        );
      }
      if (await recoveryIntentPresent(paths.evidenceDirectory, descriptor.operation.operationId)) {
        fail(
          'HOST_RECOVERY_RESULT_AMBIGUOUS',
          'Pre-ingress failure receipt conflicts with a durable submission intent.',
        );
      }
      const observedStatus = await observeExactHostPreIngressStatus(
        readRecoveryStatus, descriptor, prepared.executionStateFile,
      );
      if (!isExactUnclaimedPreIngressStatus(observedStatus)) {
        fail(
          'HOST_RECOVERY_RESULT_AMBIGUOUS',
          'Pre-ingress failure receipt conflicts with the exact Broker recovery state.',
        );
      }
      const failureArtifact = await validateHelperArtifact({
        helperResult,
        descriptor,
        intentIdentity: null,
        evidenceDirectory: paths.evidenceDirectory,
        reconciliation: false,
        preIngressFailure: true,
        observedStatus,
      });
      await assertRuntimeIdentitiesUnchanged({
        run, descriptor, paths, harnessIdentity, brokerIdentity,
        enforceHostOwnership, validateLiveMounts,
      });
      exactFence((await stableOrdinaryFile(
        paths.maintenanceFenceFile, 4096, 'maintenance fence',
      )).bytes, 'maintenance', maintenanceEpoch);
      const intentPresentAfterValidation = await recoveryIntentPresent(
        paths.evidenceDirectory, descriptor.operation.operationId,
      );
      const confirmedStatus = await observeExactHostPreIngressStatus(
        readRecoveryStatus, descriptor, prepared.executionStateFile,
      );
      if (intentPresentAfterValidation
        || !sameExactUnclaimedPreIngressStatus(observedStatus, confirmedStatus)) {
        fail(
          'HOST_RECOVERY_RESULT_AMBIGUOUS',
          'Pre-ingress failure boundary drifted while the Host verified it.',
        );
      }
      const failureCode = failureArtifact.value.failure.code;
      await writeJournal(journalFile, journalBase, 'pre-ingress-failed', {
        maintenanceEpoch,
        containerId,
        helperStatus: helperResult.status,
        failureCode,
        executionRevision: confirmedStatus.revision,
        receipt: {
          file: failureArtifact.receiptName,
          sha256: failureArtifact.receipt.sha256,
          bytes: failureArtifact.receipt.bytes.length,
        },
      });
      safeToRestoreFence = true;
      terminalOutcome = {
        state: 'pre-ingress-failed',
        helperStatus: helperResult.status,
        failureCode,
        executionRevision: confirmedStatus.revision,
        receipt: {
          file: failureArtifact.receiptName,
          sha256: failureArtifact.receipt.sha256,
          bytes: failureArtifact.receipt.bytes.length,
        },
      };
      return Object.freeze({
        status: helperResult.status,
        operationId: descriptor.operation.operationId,
        descriptorSha256: descriptor.operation.descriptorSha256,
        containerId,
        receiptFile: failureArtifact.receiptName,
        receiptSha256: failureArtifact.receipt.sha256,
        failureCode,
        preIngressFailed: true,
        automaticRetryAuthorized: false,
        automaticResendForbidden: true,
      });
    }
    const durableIntent = await stableOrdinaryFile(intentFile, MAX_INPUT_BYTES, 'durable recovery intent');
    const directArtifact = await validateHelperArtifact({
      helperResult,
      descriptor,
      intentIdentity: durableIntent,
      evidenceDirectory: paths.evidenceDirectory,
      reconciliation: false,
    });
    const stopped = await stableStoppedContainer(run, containerId, descriptor, prepared, definition);
    if (stopped === null) {
      fail('HOST_RECOVERY_RESULT_AMBIGUOUS', 'Recovery helper result arrived before the container reached a stopped boundary.');
    }
    await assertRuntimeIdentitiesUnchanged({
      run, descriptor, paths, harnessIdentity, brokerIdentity,
      enforceHostOwnership, validateLiveMounts,
    });
    await writeJournal(journalFile, journalBase, 'helper-consumed', {
      maintenanceEpoch, containerId, helperStatus: helperResult.status,
      receipt: {
        file: directArtifact.receiptName,
        sha256: directArtifact.receipt.sha256,
        bytes: directArtifact.receipt.bytes.length,
      },
    });
    safeToRestoreFence = true;
    terminalOutcome = {
      state: 'helper-consumed',
      helperStatus: helperResult.status,
      receipt: {
        file: directArtifact.receiptName,
        sha256: directArtifact.receipt.sha256,
        bytes: directArtifact.receipt.bytes.length,
      },
    };
    return Object.freeze({
      status: helperResult.status,
      operationId: descriptor.operation.operationId,
      descriptorSha256: descriptor.operation.descriptorSha256,
      containerId,
      receiptFile: directArtifact.receiptName,
      receiptSha256: directArtifact.receipt.sha256,
      automaticResendForbidden: true,
    });
  } finally {
    const currentFenceObservation = await stableOrdinaryFile(
      paths.maintenanceFenceFile, 4096, 'maintenance fence',
    ).then((value) => ({ value }), (error) => ({ error }));
    if (maintenanceOwned && safeToRestoreFence && currentFenceObservation.error !== undefined) {
      await writeJournal(journalFile, journalBase, 'fence-restore-failed', {
        maintenanceEpoch, containerId, originalFenceRestored: false,
        errorCode: currentFenceObservation.error?.code ?? 'HOST_RECOVERY_FENCE_UNREADABLE',
      }).catch(() => undefined);
      fail('HOST_RECOVERY_FENCE_RESTORE_FAILED', 'Maintenance fence became unreadable before restoration.');
    }
    const currentFence = currentFenceObservation.value;
    if (maintenanceOwned && safeToRestoreFence) {
      await validateSharedLocks();
      try {
        exactFence(currentFence.bytes, 'maintenance', maintenanceEpoch);
      } catch {
        await writeJournal(journalFile, journalBase, 'fence-ownership-lost', {
          maintenanceEpoch, containerId, originalFenceRestored: false,
        });
        fail('HOST_RECOVERY_FENCE_OWNERSHIP_LOST', 'Recovery no longer owns the maintenance fence; foreign state was preserved.');
      }
      await atomicReplace(paths.maintenanceFenceFile, originalFenceInput.bytes, {
        mode: journalBase.originalFenceMode,
        uid: journalBase.originalFenceUid,
        gid: journalBase.originalFenceGid,
      });
      const restored = await stableOrdinaryFile(paths.maintenanceFenceFile, 4096, 'restored maintenance fence');
      if (restored.sha256 !== originalFenceInput.sha256) fail('HOST_RECOVERY_FENCE_RESTORE_FAILED', 'Original fence bytes were not restored.');
      const openHealth = await maintenanceHealth({
        port: descriptor.target.hostProxyPort,
        requestPath: FIXED_MAINTENANCE_HEALTH_PATH,
      });
      if (openHealth.status !== 200 || openHealth.body?.ok !== true || openHealth.body.status !== 'open'
        || openHealth.body.epoch !== originalFence.epoch) {
        fail('HOST_RECOVERY_FENCE_RESTORE_FAILED', 'TaskSpace did not reopen on the original fence epoch.');
      }
      await writeJournal(journalFile, journalBase, 'restored', {
        maintenanceEpoch, containerId, originalFenceRestored: true,
        ...(terminalOutcome === null ? {} : { terminalOutcome }),
      });
    } else if (maintenanceOwned && !safeToRestoreFence) {
      await writeJournal(journalFile, journalBase, 'ambiguous-no-resend', {
        maintenanceEpoch, containerId, originalFenceRestored: false,
      });
    }
  }
}

async function readDescriptor(file) {
  const input = await stableOrdinaryFile(file, MAX_DESCRIPTOR_BYTES, 'recovery descriptor');
  try { return JSON.parse(input.bytes.toString('utf8')); } catch {
    fail('HOST_RECOVERY_DESCRIPTOR_INVALID', 'Descriptor is not valid JSON.');
  }
}

function argumentsMap(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) {
      fail('HOST_RECOVERY_ARGUMENT_INVALID', 'Arguments must be unique --name value pairs.');
    }
    values.set(key, value);
  }
  for (const key of values.keys()) {
    if (![
      '--descriptor', '--allowed-root', '--worker-token', '--expected-descriptor-sha256',
      '--harness-image-lock-fd', '--recovery-lock-fd', '--taskspaces-lock-fd',
    ].includes(key)) {
      fail('HOST_RECOVERY_ARGUMENT_INVALID', `Unsupported argument ${key}.`);
    }
  }
  return values;
}

export function sharedRecoveryLockPaths(allowedRoot, projectSlug) {
  const registry = path.join(path.resolve(allowedRoot), 'registry');
  return Object.freeze({
    registry,
    harnessImage: path.join(registry, 'harness-image-upgrade.lock'),
    recovery: path.join(registry, `${projectSlug}.recovery.lock`),
    taskspaces: path.join(registry, 'taskspaces.lock'),
  });
}

async function validateSharedLockFile(file, label) {
  const resolved = await realpath(file).catch(() => undefined);
  const information = await lstat(file).catch(() => undefined);
  if (resolved !== path.resolve(file) || information === undefined || !information.isFile()
    || information.isSymbolicLink() || information.nlink !== 1 || (information.mode & 0o002) !== 0) {
    fail('HOST_RECOVERY_SHARED_LOCK_INVALID', `${label} is missing or unsafe.`);
  }
  return information;
}

async function ensureSharedLockFile(file, label, registryInformation) {
  const existing = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing === undefined) {
    let handle;
    try {
      handle = await open(
        file,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o660,
      );
      await handle.sync();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      await handle?.close();
    }
    if (handle !== undefined) {
      if (process.platform !== 'win32') {
        await chown(file, registryInformation.uid, registryInformation.gid);
      }
      await chmod(file, 0o660);
      await syncDirectory(path.dirname(file));
    }
  }
  return validateSharedLockFile(file, label);
}

async function validateInheritedSharedLock(fdText, lockFile, label) {
  if (!/^[3-9][0-9]?$/u.test(fdText ?? '')) {
    fail('HOST_RECOVERY_SHARED_LOCK_INVALID', `${label} descriptor is invalid.`);
  }
  const descriptorPath = `/proc/self/fd/${fdText}`;
  const linked = await readlink(descriptorPath).catch(() => undefined);
  const canonical = linked === undefined ? undefined : await realpath(descriptorPath).catch(() => undefined);
  if (canonical !== path.resolve(lockFile)) {
    fail('HOST_RECOVERY_SHARED_LOCK_INVALID', `${label} was not inherited on the expected descriptor.`);
  }
  const pathBefore = await validateSharedLockFile(lockFile, label);
  const descriptorBefore = await stat(descriptorPath).catch(() => undefined);
  if (descriptorBefore === undefined || descriptorBefore.dev !== pathBefore.dev
    || descriptorBefore.ino !== pathBefore.ino || descriptorBefore.nlink !== 1) {
    fail('HOST_RECOVERY_SHARED_LOCK_INVALID', `${label} descriptor and path do not identify the same file.`);
  }
  const inheritedDescriptor = Number.parseInt(fdText, 10);
  const selfCheckStdio = ['ignore', 'pipe', 'pipe', inheritedDescriptor];
  const selfCheck = await runProcess('flock', [
    '--exclusive', '--nonblock', '--conflict-exit-code', '75', '3', 'true',
  ], { timeoutMs: 5_000, stdio: selfCheckStdio });
  if (selfCheck.code !== 0 || selfCheck.timedOut || selfCheck.outputExceeded) {
    fail('HOST_RECOVERY_SHARED_LOCK_INVALID', `${label} is not locked by its inherited open-file description.`);
  }
  const contender = await runProcess('flock', [
    '--exclusive', '--nonblock', '--conflict-exit-code', '75', lockFile, 'true',
  ], { timeoutMs: 5_000 });
  if (contender.code !== 75 || contender.timedOut || contender.outputExceeded) {
    fail('HOST_RECOVERY_SHARED_LOCK_INVALID', `${label} is not held exclusively by the recovery worker.`);
  }
  const pathAfter = await validateSharedLockFile(lockFile, label);
  const descriptorAfter = await stat(descriptorPath).catch(() => undefined);
  if (descriptorAfter === undefined || descriptorAfter.dev !== pathAfter.dev
    || descriptorAfter.ino !== pathAfter.ino || descriptorAfter.nlink !== 1
    || pathAfter.dev !== pathBefore.dev || pathAfter.ino !== pathBefore.ino) {
    fail('HOST_RECOVERY_SHARED_LOCK_INVALID', `${label} was replaced while the recovery worker held it.`);
  }
}

const SHARED_LOCK_WORKER = `set -Eeuo pipefail
harness_image_lock="$1"
taskspaces_lock="$2"
recovery_lock="$3"
shift 3
exec 7>>"${'$'}harness_image_lock"
flock --exclusive --nonblock 7 || exit 75
exec 8>>"${'$'}taskspaces_lock"
flock --exclusive --nonblock 8 || exit 76
exec 9>>"${'$'}recovery_lock"
flock --exclusive --nonblock 9 || exit 77
exec "${'$'}@"`;

async function runRecoveryWorkerWithSharedLocks({ descriptorFile, allowedRoot, descriptor }) {
  const locks = sharedRecoveryLockPaths(allowedRoot, descriptor.target.projectSlug);
  const registryInformation = await canonicalDirectory(locks.registry, 'delivery registry');
  if ((registryInformation.mode & 0o002) !== 0) {
    fail('HOST_RECOVERY_SHARED_LOCK_INVALID', 'Delivery registry is writable by untrusted users.');
  }
  await ensureSharedLockFile(locks.harnessImage, 'Harness image upgrade lock', registryInformation);
  await ensureSharedLockFile(locks.taskspaces, 'TaskSpace lifecycle lock', registryInformation);
  await ensureSharedLockFile(locks.recovery, 'project recovery lock', registryInformation);
  const workerToken = crypto.randomUUID();
  const child = await runProcess('bash', [
    '-c', SHARED_LOCK_WORKER, 'forge-protected-headless-recovery-locks',
    locks.harnessImage, locks.taskspaces, locks.recovery,
    process.execPath, fileURLToPath(import.meta.url),
    '--descriptor', descriptorFile,
    '--allowed-root', allowedRoot,
    '--worker-token', workerToken,
    '--expected-descriptor-sha256', descriptor.operation.descriptorSha256,
    '--harness-image-lock-fd', '7',
    '--taskspaces-lock-fd', '8',
    '--recovery-lock-fd', '9',
  ], {
    timeoutMs: null,
    env: { ...process.env, FORGE_HOST_RECOVERY_WORKER_TOKEN: workerToken },
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  if (child.code !== 0 || child.timedOut || child.outputExceeded) process.exitCode = child.code ?? 1;
}

async function main() {
  const values = argumentsMap(process.argv.slice(2));
  const descriptorFile = values.get('--descriptor');
  const allowedRoot = values.get('--allowed-root');
  if (!descriptorFile || !allowedRoot) fail('HOST_RECOVERY_ARGUMENT_INVALID', '--descriptor and --allowed-root are required.');
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    fail('HOST_RECOVERY_OPERATOR_INVALID', 'The host recovery CLI must run as root on Linux.');
  }
  const canonicalDescriptorFile = path.resolve(descriptorFile);
  const canonicalAllowedRoot = path.resolve(allowedRoot);
  const descriptor = await readDescriptor(canonicalDescriptorFile);
  validateHostRecoveryDescriptor(descriptor, { allowedRoot: canonicalAllowedRoot });
  const workerToken = values.get('--worker-token');
  if (workerToken === undefined) {
    if ([
      '--expected-descriptor-sha256', '--harness-image-lock-fd',
      '--recovery-lock-fd', '--taskspaces-lock-fd',
    ].some((key) => values.has(key))) {
      fail('HOST_RECOVERY_ARGUMENT_INVALID', 'Internal worker arguments require a shared-lock worker token.');
    }
    await runRecoveryWorkerWithSharedLocks({
      descriptorFile: canonicalDescriptorFile,
      allowedRoot: canonicalAllowedRoot,
      descriptor,
    });
    return;
  }
  if (!UUID.test(workerToken)
    || process.env.FORGE_HOST_RECOVERY_WORKER_TOKEN !== workerToken
    || values.get('--expected-descriptor-sha256') !== descriptor.operation.descriptorSha256) {
    fail('HOST_RECOVERY_SHARED_LOCK_INVALID', 'Recovery worker identity or descriptor binding is invalid.');
  }
  const locks = sharedRecoveryLockPaths(canonicalAllowedRoot, descriptor.target.projectSlug);
  const validateSharedLocks = async () => {
    await validateInheritedSharedLock(
      values.get('--harness-image-lock-fd'), locks.harnessImage, 'Harness image upgrade lock',
    );
    await validateInheritedSharedLock(
      values.get('--taskspaces-lock-fd'), locks.taskspaces, 'TaskSpace lifecycle lock',
    );
    await validateInheritedSharedLock(
      values.get('--recovery-lock-fd'), locks.recovery, 'project recovery lock',
    );
  };
  await validateSharedLocks();
  const result = await executeHostProtectedRecovery({
    descriptor,
    allowedRoot: canonicalAllowedRoot,
    enforceHostOwnership: true,
    validateSharedLocks,
  });
  process.stdout.write(`${JSON.stringify({ schemaVersion: 'forge-protected-headless-host-recovery-cli/v1', ...result })}\n`);
}

function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return path.resolve(realpathSync(path.resolve(process.argv[1]))) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(`host protected recovery failed [${error?.code ?? 'HOST_RECOVERY_FAILED'}]: ${error.message}\n`);
    process.exitCode = 1;
  });
}
