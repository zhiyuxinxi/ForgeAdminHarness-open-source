import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  validateForgeDeliveryPhaseArtifact,
  currentForgeRuntimeSourceArtifactKind,
  validateForgeDeliveryPhaseCatalog,
  validateForgeDeliveryPhaseState,
} from './forge-delivery-phase-runtime.mjs';

const executeFile = promisify(execFile);
const MANIFEST_SCHEMA = 'forge-cross-layer-runtime-evidence/v1';
const REVIEW_SCHEMA = 'forge-cross-layer-runtime-repair-review/v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{1,127}$/u;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 256 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const EVIDENCE_KINDS = Object.freeze(['deployment', 'api', 'browser', 'database']);

export class ForgeCrossLayerRuntimeEvidenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeCrossLayerRuntimeEvidenceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeCrossLayerRuntimeEvidenceError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys, label) {
  if (!plainObject(value)) fail('CROSS_LAYER_RUNTIME_SCHEMA_INVALID', `${label} must be an object.`);
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('CROSS_LAYER_RUNTIME_SCHEMA_INVALID', `${label} fields do not match the reviewed schema.`);
  }
}

function requiredString(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('CROSS_LAYER_RUNTIME_SCHEMA_INVALID', `${label} is invalid.`);
  }
  return value;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function decodeJson(bytes, label) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = JSON.parse(text);
    if (!plainObject(value)) throw new Error('not an object');
    return value;
  } catch {
    fail('CROSS_LAYER_RUNTIME_JSON_INVALID', `${label} must be a UTF-8 JSON object.`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function relativeEvidencePath(value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
      || value.includes('\\') || path.isAbsolute(value)) {
    fail('CROSS_LAYER_RUNTIME_PATH_INVALID', `${label} must be a bounded canonical relative path.`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('CROSS_LAYER_RUNTIME_PATH_INVALID', `${label} escapes the evidence directory.`);
  }
  return value;
}

async function privateDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    fail('CROSS_LAYER_RUNTIME_PATH_INVALID', 'Evidence directory must be absolute.');
  }
  let resolved;
  try { resolved = realpathSync(directory); } catch {
    fail('CROSS_LAYER_RUNTIME_PATH_INVALID', 'Evidence directory is unavailable.');
  }
  const information = await lstat(directory);
  const trustedUid = process.getuid?.();
  if (resolved !== path.resolve(directory) || !information.isDirectory() || information.isSymbolicLink()
      || (process.platform !== 'win32' && ((information.mode & 0o077) !== 0
        || (trustedUid !== undefined && information.uid !== trustedUid)))) {
    fail('CROSS_LAYER_RUNTIME_PATH_INVALID', 'Evidence directory must be an ordinary private directory.');
  }
  return { resolved, information };
}

async function boundedPrivateFile(root, rootInfo, relative, maximumBytes, label) {
  const normalized = relativeEvidencePath(relative, label);
  const file = path.resolve(root, ...normalized.split('/'));
  if (!file.startsWith(`${root}${path.sep}`)) {
    fail('CROSS_LAYER_RUNTIME_PATH_INVALID', `${label} escapes the evidence directory.`);
  }
  const before = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') fail('CROSS_LAYER_RUNTIME_FILE_MISSING', `${label} does not exist.`);
    throw error;
  });
  let realFile;
  try { realFile = realpathSync(file); } catch {
    fail('CROSS_LAYER_RUNTIME_PATH_INVALID', `${label} cannot be resolved safely.`);
  }
  if (realFile !== file || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < 1 || before.size > maximumBytes
      || (process.platform !== 'win32' && ((before.mode & 0o077) !== 0 || before.uid !== rootInfo.uid))) {
    fail('CROSS_LAYER_RUNTIME_PATH_INVALID', `${label} must be a bounded private ordinary file.`);
  }
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.nlink !== 1) {
      fail('CROSS_LAYER_RUNTIME_PATH_INVALID', `${label} changed during admission.`);
    }
    return { bytes: await handle.readFile(), path: normalized };
  } finally {
    await handle.close();
  }
}

function validateFileRef(value, label) {
  exactKeys(value, ['path', 'sha256'], label);
  return {
    path: relativeEvidencePath(value.path, `${label}.path`),
    sha256: requiredString(value.sha256, SHA256, `${label}.sha256`),
  };
}

function validateManifest(value) {
  exactKeys(value, ['schemaVersion', 'subject', 'runtimeSource', 'acceptedPatch', 'repairs', 'evidence'], 'manifest');
  if (value.schemaVersion !== MANIFEST_SCHEMA) {
    fail('CROSS_LAYER_RUNTIME_SCHEMA_INVALID', 'Manifest schemaVersion is unsupported.');
  }
  exactKeys(value.subject, [
    'workflowId', 'taskId', 'catalogVersion', 'catalogDigest', 'stateDigest',
    'baseSourceCommit', 'cumulativePatchSha256',
  ], 'manifest.subject');
  requiredString(value.subject.workflowId, SAFE_ID, 'manifest.subject.workflowId');
  requiredString(value.subject.taskId, SAFE_ID, 'manifest.subject.taskId');
  requiredString(value.subject.catalogVersion, SAFE_ID, 'manifest.subject.catalogVersion');
  requiredString(value.subject.catalogDigest, SHA256, 'manifest.subject.catalogDigest');
  requiredString(value.subject.stateDigest, SHA256, 'manifest.subject.stateDigest');
  requiredString(value.subject.baseSourceCommit, COMMIT, 'manifest.subject.baseSourceCommit');
  requiredString(value.subject.cumulativePatchSha256, SHA256, 'manifest.subject.cumulativePatchSha256');
  exactKeys(value.runtimeSource, ['commit', 'tree'], 'manifest.runtimeSource');
  requiredString(value.runtimeSource.commit, COMMIT, 'manifest.runtimeSource.commit');
  requiredString(value.runtimeSource.tree, GIT_OBJECT_ID, 'manifest.runtimeSource.tree');
  const acceptedPatch = validateFileRef(value.acceptedPatch, 'manifest.acceptedPatch');
  if (!Array.isArray(value.repairs) || value.repairs.length > 8) {
    fail('CROSS_LAYER_RUNTIME_SCHEMA_INVALID', 'manifest.repairs must contain at most eight reviewed repairs.');
  }
  const repairs = value.repairs.map((entry, index) => {
    exactKeys(entry, ['patch', 'review'], `manifest.repairs[${index}]`);
    return {
      patch: validateFileRef(entry.patch, `manifest.repairs[${index}].patch`),
      review: validateFileRef(entry.review, `manifest.repairs[${index}].review`),
    };
  });
  exactKeys(value.evidence, EVIDENCE_KINDS, 'manifest.evidence');
  const evidence = Object.fromEntries(EVIDENCE_KINDS.map((kind) => [
    kind,
    validateFileRef(value.evidence[kind], `manifest.evidence.${kind}`),
  ]));
  const paths = [acceptedPatch.path, ...repairs.flatMap((entry) => [entry.patch.path, entry.review.path]),
    ...Object.values(evidence).map((entry) => entry.path)];
  if (new Set(paths).size !== paths.length || paths.includes('manifest.json')) {
    fail('CROSS_LAYER_RUNTIME_SCHEMA_INVALID', 'Manifest file references must be unique and cannot reference the manifest.');
  }
  return { ...value, acceptedPatch, repairs, evidence };
}

function validateRepairReview(value, patchSha256, index) {
  const label = `repair review ${index}`;
  exactKeys(value, ['schemaVersion', 'reviewerId', 'candidateAuthorId', 'subject', 'verdict', 'summary'], label);
  if (value.schemaVersion !== REVIEW_SCHEMA) fail('CROSS_LAYER_RUNTIME_REPAIR_REVIEW_INVALID', `${label} schema is unsupported.`);
  requiredString(value.reviewerId, SAFE_ID, `${label}.reviewerId`);
  requiredString(value.candidateAuthorId, SAFE_ID, `${label}.candidateAuthorId`);
  if (value.reviewerId === value.candidateAuthorId) {
    fail('CROSS_LAYER_RUNTIME_REPAIR_REVIEW_INVALID', `${label} is self-authored.`);
  }
  exactKeys(value.subject, ['patchSha256'], `${label}.subject`);
  if (value.subject.patchSha256 !== patchSha256 || !['PASS', 'approved'].includes(value.verdict)
      || typeof value.summary !== 'string' || value.summary !== value.summary.trim()
      || Buffer.byteLength(value.summary, 'utf8') < 1 || Buffer.byteLength(value.summary, 'utf8') > 8192
      || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value.summary)) {
    fail('CROSS_LAYER_RUNTIME_REPAIR_REVIEW_INVALID', `${label} does not approve the exact repair patch.`);
  }
}

function evidenceSources(value, kind) {
  if (!plainObject(value)) fail('CROSS_LAYER_RUNTIME_EVIDENCE_INVALID', `${kind} evidence must be an object.`);
  const commits = [value.sourceCommit, value.releaseState?.commit, value.provenance?.candidateCommit]
    .filter((entry) => entry !== undefined);
  if (commits.length < 1 || commits.some((entry) => typeof entry !== 'string')) {
    fail('CROSS_LAYER_RUNTIME_EVIDENCE_SOURCE_MISMATCH', `${kind} evidence has no valid source commit.`);
  }
  return { commits, status: kind === 'deployment' ? value.status ?? value.releaseState?.status : null };
}

function validateEvidenceDocument(value, kind, runtimeSource, evidenceReferences) {
  const source = evidenceSources(value, kind);
  if (source.commits.some((commit) => commit !== runtimeSource.commit)) {
    fail('CROSS_LAYER_RUNTIME_EVIDENCE_SOURCE_MISMATCH', `${kind} evidence targets another source commit.`);
  }
  if (kind === 'deployment' && source.status !== 'success') {
    fail('CROSS_LAYER_RUNTIME_DEPLOYMENT_NOT_SUCCESSFUL', 'Deployment evidence does not record success.');
  }
  const crossReferences = kind === 'browser'
    ? { apiEvidenceSha256: 'api', deploymentEvidenceSha256: 'deployment' }
    : kind === 'database' ? { apiEvidenceSha256: 'api' } : {};
  for (const [field, target] of Object.entries(crossReferences)) {
    if (value[field] !== undefined && value[field] !== evidenceReferences[target].sha256) {
      fail('CROSS_LAYER_RUNTIME_EVIDENCE_SOURCE_MISMATCH', `${kind} evidence ${field} targets another evidence file.`);
    }
  }
}

async function writeExclusive(file, bytes) {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(file, 0o600);
}

async function git(repository, args, environment = {}) {
  try {
    const result = await executeFile('git', ['-C', repository, ...args], {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...environment },
    });
    return result.stdout.trim();
  } catch {
    fail('CROSS_LAYER_RUNTIME_SOURCE_INVALID', `Git could not verify ${args[0]}.`);
  }
}

async function materializeSource(repository, manifest, verifiedPatchBytes) {
  if (typeof repository !== 'string' || !path.isAbsolute(repository)) {
    fail('CROSS_LAYER_RUNTIME_SOURCE_INVALID', 'sourceRepository must be an absolute repository path.');
  }
  let resolved;
  try { resolved = realpathSync(repository); } catch {
    fail('CROSS_LAYER_RUNTIME_SOURCE_INVALID', 'sourceRepository is unavailable.');
  }
  const info = await lstat(repository);
  if (resolved !== path.resolve(repository) || !info.isDirectory() || info.isSymbolicLink()) {
    fail('CROSS_LAYER_RUNTIME_SOURCE_INVALID', 'sourceRepository must be an ordinary canonical directory.');
  }
  const originalObjects = await git(resolved, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'forge-cross-layer-runtime-'));
  await chmod(temporary, 0o700);
  const objectDirectory = path.join(temporary, 'objects');
  const indexFile = path.join(temporary, 'index');
  const patchDirectory = path.join(temporary, 'patches');
  await mkdir(objectDirectory, { mode: 0o700 });
  await mkdir(patchDirectory, { mode: 0o700 });
  const environment = {
    GIT_INDEX_FILE: indexFile,
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: originalObjects,
  };
  try {
    const patchSnapshots = [];
    for (let index = 0; index < verifiedPatchBytes.length; index += 1) {
      const snapshot = path.join(patchDirectory, `${String(index).padStart(2, '0')}.patch`);
      await writeExclusive(snapshot, verifiedPatchBytes[index]);
      patchSnapshots.push(snapshot);
    }
    const base = await git(resolved, ['rev-parse', '--verify', `${manifest.subject.baseSourceCommit}^{commit}`], environment);
    const runtimeCommit = await git(resolved, ['rev-parse', '--verify', `${manifest.runtimeSource.commit}^{commit}`], environment);
    const runtimeTree = await git(resolved, ['rev-parse', '--verify', `${manifest.runtimeSource.commit}^{tree}`], environment);
    if (base !== manifest.subject.baseSourceCommit || runtimeCommit !== manifest.runtimeSource.commit
        || runtimeTree !== manifest.runtimeSource.tree) {
      fail('CROSS_LAYER_RUNTIME_SOURCE_MISMATCH', 'Manifest source identities do not match the repository.');
    }
    await git(resolved, ['read-tree', manifest.subject.baseSourceCommit], environment);
    for (const patchSnapshot of patchSnapshots) {
      await git(resolved, ['apply', '--cached', '--binary', '--whitespace=nowarn', patchSnapshot], environment);
    }
    const materializedTree = await git(resolved, ['write-tree'], environment);
    if (materializedTree !== runtimeTree) {
      fail('CROSS_LAYER_RUNTIME_SOURCE_MISMATCH', 'Base, accepted patch, and reviewed repairs do not materialize the runtime tree.');
    }
    return { baseCommit: base, runtimeCommit, runtimeTree, materializedTree };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function loadForgeCrossLayerRuntimeEvidence({
  directory,
  expectedManifestSha256,
  expectedStateDigest,
  state,
  catalog,
  acceptedArtifacts,
  sourceRepository,
}) {
  requiredString(expectedManifestSha256, SHA256, 'expectedManifestSha256');
  const validatedCatalog = validateForgeDeliveryPhaseCatalog(catalog);
  const validatedState = validateForgeDeliveryPhaseState(state, validatedCatalog);
  const boundStateDigest = expectedStateDigest ?? validatedState.stateDigest;
  requiredString(boundStateDigest, SHA256, 'expectedStateDigest');
  const workflow = validatedCatalog.workflows.find((entry) => entry.id === validatedState.workflowId);
  const phase = workflow?.phases[validatedState.currentPhaseIndex];
  if (validatedState.status !== 'active' || phase?.id !== 'cross-layer-acceptance'
      || validatedState.currentPhaseIndex < 1) {
    fail('CROSS_LAYER_RUNTIME_STATE_INVALID', 'Runtime evidence is only valid for the active cross-layer acceptance phase.');
  }
  if (!Array.isArray(acceptedArtifacts)) {
    fail('CROSS_LAYER_RUNTIME_STATE_INVALID', 'acceptedArtifacts must be an array.');
  }
  const artifacts = acceptedArtifacts.map((artifact) => validateForgeDeliveryPhaseArtifact(artifact));
  const priorPhases = workflow.phases.slice(0, validatedState.currentPhaseIndex);
  if (artifacts.length !== priorPhases.length) {
    fail('CROSS_LAYER_RUNTIME_STATE_INVALID', 'Accepted phase artifacts are incomplete.');
  }
  const byKind = new Map(artifacts.map((artifact) => [artifact.artifactKind, artifact]));
  if (byKind.size !== artifacts.length || priorPhases.some((prior) => {
    const artifact = byKind.get(prior.artifactKind);
    return artifact?.workflowId !== validatedState.workflowId || artifact?.phaseId !== prior.id
      || artifact?.artifactDigest !== validatedState.acceptedArtifacts[prior.artifactKind];
  })) {
    fail('CROSS_LAYER_RUNTIME_STATE_INVALID', 'Accepted phase artifacts do not match the active state.');
  }
  const acceptedSource = byKind.get(currentForgeRuntimeSourceArtifactKind(validatedState));
  const root = await privateDirectory(directory);
  const manifestFile = await boundedPrivateFile(root.resolved, root.information, 'manifest.json', MAX_JSON_BYTES, 'runtime evidence manifest');
  if (sha256(manifestFile.bytes) !== expectedManifestSha256) {
    fail('CROSS_LAYER_RUNTIME_DIGEST_MISMATCH', 'Runtime evidence manifest differs from the reviewed digest.');
  }
  const manifest = validateManifest(decodeJson(manifestFile.bytes, 'runtime evidence manifest'));
  const subject = manifest.subject;
  if (subject.workflowId !== validatedState.workflowId || subject.taskId !== validatedState.taskId
      || subject.catalogVersion !== validatedState.catalogVersion
      || subject.catalogDigest !== validatedState.catalogDigest || subject.stateDigest !== boundStateDigest
      || subject.baseSourceCommit !== validatedState.sourceCommit
      || subject.cumulativePatchSha256 !== acceptedSource.sourceFingerprint
      || manifest.acceptedPatch.sha256 !== subject.cumulativePatchSha256) {
    fail('CROSS_LAYER_RUNTIME_BINDING_MISMATCH', 'Runtime evidence subject does not match the accepted phase boundary.');
  }

  const acceptedPatch = await boundedPrivateFile(root.resolved, root.information,
    manifest.acceptedPatch.path, MAX_PATCH_BYTES, 'accepted cumulative patch');
  if (sha256(acceptedPatch.bytes) !== manifest.acceptedPatch.sha256) {
    fail('CROSS_LAYER_RUNTIME_DIGEST_MISMATCH', 'Accepted cumulative patch digest changed.');
  }
  const repairPatchBytes = [];
  const repairBundles = [];
  for (let index = 0; index < manifest.repairs.length; index += 1) {
    const entry = manifest.repairs[index];
    const patchFile = await boundedPrivateFile(root.resolved, root.information,
      entry.patch.path, MAX_PATCH_BYTES, `repair patch ${index}`);
    const reviewFile = await boundedPrivateFile(root.resolved, root.information,
      entry.review.path, MAX_JSON_BYTES, `repair review ${index}`);
    if (sha256(patchFile.bytes) !== entry.patch.sha256 || sha256(reviewFile.bytes) !== entry.review.sha256) {
      fail('CROSS_LAYER_RUNTIME_DIGEST_MISMATCH', `Repair ${index} evidence digest changed.`);
    }
    const review = decodeJson(reviewFile.bytes, `repair review ${index}`);
    validateRepairReview(review, entry.patch.sha256, index);
    repairPatchBytes.push(Buffer.from(patchFile.bytes));
    repairBundles.push({ patch: clone(entry.patch), review: clone(review) });
  }

  const evidence = {};
  for (const kind of EVIDENCE_KINDS) {
    const reference = manifest.evidence[kind];
    const file = await boundedPrivateFile(root.resolved, root.information,
      reference.path, MAX_JSON_BYTES, `${kind} runtime evidence`);
    if (sha256(file.bytes) !== reference.sha256) {
      fail('CROSS_LAYER_RUNTIME_DIGEST_MISMATCH', `${kind} runtime evidence digest changed.`);
    }
    const value = decodeJson(file.bytes, `${kind} runtime evidence`);
    validateEvidenceDocument(value, kind, manifest.runtimeSource, manifest.evidence);
    evidence[kind] = clone(value);
  }

  const lineage = await materializeSource(sourceRepository, manifest, [
    Buffer.from(acceptedPatch.bytes),
    ...repairPatchBytes,
  ]);
  return deepFreeze({
    manifestSha256: expectedManifestSha256,
    subject: clone(subject),
    runtimeSource: clone(manifest.runtimeSource),
    evidence,
    sourceLineage: {
      ...lineage,
      patchInput: 'verified-byte-snapshots',
      acceptedPatch: clone(manifest.acceptedPatch),
      repairs: repairBundles,
    },
  });
}
