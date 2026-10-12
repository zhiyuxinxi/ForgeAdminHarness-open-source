#!/usr/bin/env node

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const LEGACY_SCHEMA = 'forge-host-runner-bundle/v1';
const PREVIOUS_SCHEMA = 'forge-host-runner-bundle/v2';
const RECOVERY_SCHEMA = 'forge-host-runner-bundle/v3';
const PRODUCTION_GRANT_SCHEMA = 'forge-host-runner-bundle/v4';
const CROSS_LAYER_SCHEMA = 'forge-host-runner-bundle/v5';
const SEMANTIC_REVIEW_SCHEMA = 'forge-host-runner-bundle/v6';
const DEPENDENCY_SEED_SCHEMA = 'forge-host-runner-bundle/v7';
const PREPARED_DEPENDENCY_SCHEMA = 'forge-host-runner-bundle/v8';
const DUAL_REVIEW_SCHEMA = 'forge-host-runner-bundle/v9';
const SOURCE_PROVENANCE_SCHEMA = 'forge-host-runner-bundle/v10';
const WORKFLOW_INVENTORY_SCHEMA = 'forge-host-runner-bundle/v11';
const SEMANTIC_RESOURCE_SCHEMA = 'forge-host-runner-bundle/v12';
const DEAD_WRITER_SCHEMA = 'forge-host-runner-bundle/v13';
const BUSINESS_DATA_PREVIEW_SCHEMA = 'forge-host-runner-bundle/v14';
const BUSINESS_DATA_CONSUMPTION_SCHEMA = 'forge-host-runner-bundle/v15';
const TYPECHECK_SCHEMA = 'forge-host-runner-bundle/v16';
const SCHEMA = 'forge-host-runner-bundle/v17';
const MANIFEST = 'runner.manifest.json';
const ACTIVE = 'active.json';
const PENDING = 'activation.pending.json';
const LIFECYCLE_LOCK = 'activation.lock';
const WINDOWS_LIFECYCLE_OWNER = '.activation.lock.owner';
const FLOCK_EXECUTABLE = '/usr/bin/flock';
const BASH_EXECUTABLE = '/bin/bash';
const VERSION = /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+(?:-[a-z0-9.-]+)?$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PREVIOUS_SOURCE_MAP = Object.freeze([
  ['scripts/forge-host-runner-bundle.mjs', 'bin/forge-host-runner-bundle.mjs'],
  ['docker/harness/forge-governance', 'bin/forge-governance'],
  ['docker/harness/forge-governance-policy.json', 'lib/forge-governance-policy.json'],
  ['docker/harness/forge-governance.mjs', 'lib/forge-governance.mjs'],
  ['docker/harness/forge-delivery-phase-controller.mjs', 'lib/forge-delivery-phase-controller.mjs'],
  ['docker/harness/forge-delivery-phase-workspace-observer.mjs', 'lib/forge-delivery-phase-workspace-observer.mjs'],
  ['docker/harness/forge-delivery-phase-response.mjs', 'lib/forge-delivery-phase-response.mjs'],
  ['docker/harness/forge-delivery-phase-runtime.mjs', 'lib/forge-delivery-phase-runtime.mjs'],
  ['docker/harness/forge-execution-context.mjs', 'lib/forge-execution-context.mjs'],
  ['docker/harness/forge-phase-work-package.mjs', 'lib/forge-phase-work-package.mjs'],
  ['docker/harness/forge-prepare-headless-execution.mjs', 'lib/forge-prepare-headless-execution.mjs'],
  ['docker/harness/forge-task-execution-contract.mjs', 'lib/forge-task-execution-contract.mjs'],
  ['docker/harness/forge-ui-contract.json', 'lib/forge-ui-contract.json'],
  ['docker/harness/forge-ui-contract.mjs', 'lib/forge-ui-contract.mjs'],
  ['docker/harness/forge-host-verification-receipt.mjs', 'lib/forge-host-verification-receipt.mjs'],
  ['docker/harness/host-verification-runner.mjs', 'lib/host-verification-runner.mjs'],
  ['docker/harness/host-verify-policy.mjs', 'lib/host-verify-policy.mjs'],
  ['docker/harness/maven-verification-policy.mjs', 'lib/maven-verification-policy.mjs'],
  ['docker/harness/maven-verification-settings.xml', 'lib/maven-verification-settings.xml'],
  ['docker/harness/taskspace-policy.mjs', 'lib/taskspace-policy.mjs'],
  ['docker/harness/verification-runner.mjs', 'lib/verification-runner.mjs'],
  ['docker/harness/verify-policy.mjs', 'lib/verify-policy.mjs'],
]);
const LEGACY_BASE_TARGETS = Object.freeze([
  'bin/forge-governance',
  'lib/forge-governance-policy.json',
  'lib/forge-governance.mjs',
  'lib/forge-ui-contract.json',
  'lib/forge-ui-contract.mjs',
  'lib/host-verification-runner.mjs',
  'lib/host-verify-policy.mjs',
  'lib/maven-verification-policy.mjs',
  'lib/maven-verification-settings.xml',
  'lib/verification-runner.mjs',
  'lib/verify-policy.mjs',
].sort(comparePath));
const LEGACY_MANAGER_TARGET = 'bin/forge-host-runner-bundle.mjs';
const LEGACY_PHASE_TARGETS = Object.freeze([
  'lib/forge-delivery-phase-controller.mjs',
  'lib/forge-delivery-phase-response.mjs',
  'lib/forge-delivery-phase-runtime.mjs',
  'lib/forge-execution-context.mjs',
  'lib/forge-phase-work-package.mjs',
  'lib/forge-prepare-headless-execution.mjs',
  'lib/forge-task-execution-contract.mjs',
  'lib/taskspace-policy.mjs',
].sort(comparePath));
const LEGACY_RECEIPT_TARGET = 'lib/forge-host-verification-receipt.mjs';
const RECOVERY_SOURCE_MAP = Object.freeze([
  ...PREVIOUS_SOURCE_MAP,
  ['scripts/run-forge-protected-headless-recovery.mjs', 'bin/run-forge-protected-headless-recovery.mjs'],
  ['docker/harness/forge-recover-headless-execution.mjs', 'lib/forge-recover-headless-execution.mjs'],
  ['docker/harness/forge-protected-session-mode.mjs', 'lib/forge-protected-session-mode.mjs'],
]);
const PRODUCTION_GRANT_SOURCE_MAP = Object.freeze([
  ...RECOVERY_SOURCE_MAP,
  ['docker/harness/forge-production-task-grant.mjs', 'lib/forge-production-task-grant.mjs'],
]);
const CROSS_LAYER_SOURCE_MAP = Object.freeze([
  ...PRODUCTION_GRANT_SOURCE_MAP,
  ['docker/harness/forge-cross-layer-runtime-evidence.mjs', 'lib/forge-cross-layer-runtime-evidence.mjs'],
]);
const SEMANTIC_REVIEW_SOURCE_MAP = Object.freeze([
  ...CROSS_LAYER_SOURCE_MAP,
  ['docker/harness/forge-independent-semantic-review.mjs', 'lib/forge-independent-semantic-review.mjs'],
]);
const DEPENDENCY_SEED_SOURCE_MAP = Object.freeze([
  ...SEMANTIC_REVIEW_SOURCE_MAP,
  ['docker/harness/host-dependency-seed.mjs', 'lib/host-dependency-seed.mjs'],
]);
const PREPARED_DEPENDENCY_SOURCE_MAP = Object.freeze([
  ...DEPENDENCY_SEED_SOURCE_MAP,
  ['docker/harness/host-prepared-dependencies.mjs', 'lib/host-prepared-dependencies.mjs'],
]);
const DUAL_REVIEW_SOURCE_MAP = Object.freeze([
  ...PREPARED_DEPENDENCY_SOURCE_MAP,
  ['docker/harness/forge-change-contract.mjs', 'lib/forge-change-contract.mjs'],
]);
const SOURCE_PROVENANCE_SOURCE_MAP = Object.freeze([
  ...DUAL_REVIEW_SOURCE_MAP,
  ['docker/harness/forge-reference-provenance.mjs', 'lib/forge-reference-provenance.mjs'],
]);
const WORKFLOW_INVENTORY_SOURCE_MAP = Object.freeze([
  ...SOURCE_PROVENANCE_SOURCE_MAP,
  ['docker/harness/forge-workflow-migration-safety.mjs', 'lib/forge-workflow-migration-safety.mjs'],
]);
const SEMANTIC_RESOURCE_SOURCE_MAP = Object.freeze([
  ...WORKFLOW_INVENTORY_SOURCE_MAP,
  ['docker/harness/forge-semantic-resource-lease.mjs', 'lib/forge-semantic-resource-lease.mjs'],
]);
const DEAD_WRITER_SOURCE_MAP = Object.freeze([
  ...SEMANTIC_RESOURCE_SOURCE_MAP,
  ['docker/harness/forge-writer-scope-lease.mjs', 'lib/forge-writer-scope-lease.mjs'],
  ['scripts/recover-forge-dead-writer.mjs', 'bin/recover-forge-dead-writer.mjs'],
]);
const BUSINESS_DATA_PREVIEW_SOURCE_MAP = Object.freeze([
  ...DEAD_WRITER_SOURCE_MAP,
  ['docker/harness/forge-business-data-approval.mjs', 'lib/forge-business-data-approval.mjs'],
]);
const BUSINESS_DATA_CONSUMPTION_SOURCE_MAP = Object.freeze([
  ...BUSINESS_DATA_PREVIEW_SOURCE_MAP,
  ['docker/harness/forge-business-data-consumption.mjs', 'lib/forge-business-data-consumption.mjs'],
  ['docker/harness/forge-acceptance-aggregator.mjs', 'lib/forge-acceptance-aggregator.mjs'],
]);
const TYPECHECK_SOURCE_MAP = Object.freeze([
  ...BUSINESS_DATA_CONSUMPTION_SOURCE_MAP,
  ['docker/harness/frontend-typecheck.mjs', 'lib/frontend-typecheck.mjs'],
  ['docker/harness/vue-typecheck-entity-compat.mjs', 'lib/vue-typecheck-entity-compat.mjs'],
]);
const SOURCE_MAP = Object.freeze([
  ...TYPECHECK_SOURCE_MAP,
  ['docker/harness/forge-backend-source-quality.mjs', 'lib/forge-backend-source-quality.mjs'],
  ['docker/harness/forge-backend-source-quality-runner.mjs', 'lib/forge-backend-source-quality-runner.mjs'],
  ...['run.py', 'backend-quality.py', 'pom.xml', 'pmd.xml', 'checkstyle.xml', 'manifest.json', 'runtime.zip', 'runtime-manifest.json']
    .map(name => [`docker/harness/backend-source-quality/${name}`, `lib/backend-source-quality/${name}`]),
]);
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:DSA |EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
]);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalRelative(value) {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Host Runner bundle contains an unsafe relative path.');
  }
  return normalized;
}

function comparePath(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function stableFile(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('Host Runner payload must contain only ordinary unlinked files.');
  }
  const content = await readFile(file);
  const after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('Host Runner payload changed while it was being hashed.');
  }
  if (SECRET_PATTERNS.some((expression) => expression.test(content.toString('utf8')))) {
    throw new Error('Host Runner payload contains credential-shaped content.');
  }
  return { bytes: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

async function payloadFiles(root, relative = '') {
  const directory = path.resolve(root, relative);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Host Runner payload root must be an ordinary directory.');
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => comparePath(a.name, b.name))) {
    const child = canonicalRelative(relative ? `${relative}/${entry.name}` : entry.name);
    if (!relative && child === MANIFEST) continue;
    const absolute = path.resolve(root, ...child.split('/'));
    if (!inside(root, absolute)) throw new Error('Host Runner payload escaped its root.');
    const item = await lstat(absolute);
    if (entry.isSymbolicLink() || item.isSymbolicLink()) throw new Error(`Host Runner payload contains a symbolic link: ${child}`);
    if (entry.isDirectory() && item.isDirectory()) files.push(...await payloadFiles(root, child));
    else if (entry.isFile() && item.isFile()) files.push({ path: child, ...await stableFile(absolute) });
    else throw new Error(`Host Runner payload contains an unsupported node: ${child}`);
  }
  return files.sort((a, b) => comparePath(a.path, b.path));
}

function treeHash(files) {
  const hash = crypto.createHash('sha256').update('FORGE_HOST_RUNNER_BUNDLE_V1\0');
  for (const file of files) hash.update(file.path).update('\0').update(file.sha256).update('\0').update(String(file.bytes)).update('\0');
  return hash.digest('hex');
}

function legacyReleaseInventory(bundleVersion) {
  const match = /^2026\.09\.03\.(\d+)$/u.exec(bundleVersion);
  const release = match === null ? NaN : Number(match[1]);
  if (!Number.isInteger(release) || release < 1 || release > 17) {
    throw new Error('Host Runner legacy manifest release identity is unsupported.');
  }
  const targets = [...LEGACY_BASE_TARGETS];
  if (release >= 2) targets.push(LEGACY_MANAGER_TARGET);
  if (release >= 7) targets.push(...LEGACY_PHASE_TARGETS);
  if (release >= 12) targets.push(LEGACY_RECEIPT_TARGET);
  return Object.freeze({ release, targets: targets.sort(comparePath), hasPhaseRuntime: release >= 7 });
}

function validateManifest(value) {
  exactKeys(value, ['schemaVersion', 'bundleVersion', 'compatibleProfileCatalogVersions', 'compatibleNodeMajors', 'entrypoint', 'governanceEntrypoint', 'phaseControllerEntrypoint', 'phasePrepareEntrypoint', 'phaseWorkspaceObserverEntrypoint', 'protectedRecoveryEntrypoint', 'files', 'treeSha256'], 'Host Runner manifest');
  const legacySchema = value.schemaVersion === LEGACY_SCHEMA;
  const previousSchema = value.schemaVersion === PREVIOUS_SCHEMA;
  const recoverySchema = value.schemaVersion === RECOVERY_SCHEMA;
  const productionGrantSchema = value.schemaVersion === PRODUCTION_GRANT_SCHEMA;
  const crossLayerSchema = value.schemaVersion === CROSS_LAYER_SCHEMA;
  const semanticReviewSchema = value.schemaVersion === SEMANTIC_REVIEW_SCHEMA;
  if ((!legacySchema && !previousSchema && !recoverySchema && !productionGrantSchema
      && !crossLayerSchema && !semanticReviewSchema && value.schemaVersion !== DEPENDENCY_SEED_SCHEMA
      && value.schemaVersion !== PREPARED_DEPENDENCY_SCHEMA && value.schemaVersion !== DUAL_REVIEW_SCHEMA
      && value.schemaVersion !== SOURCE_PROVENANCE_SCHEMA && value.schemaVersion !== WORKFLOW_INVENTORY_SCHEMA
       && value.schemaVersion !== SEMANTIC_RESOURCE_SCHEMA && value.schemaVersion !== DEAD_WRITER_SCHEMA
       && value.schemaVersion !== BUSINESS_DATA_PREVIEW_SCHEMA
       && value.schemaVersion !== BUSINESS_DATA_CONSUMPTION_SCHEMA && value.schemaVersion !== TYPECHECK_SCHEMA && value.schemaVersion !== SCHEMA)
    || typeof value.bundleVersion !== 'string' || !VERSION.test(value.bundleVersion)) throw new Error('Host Runner manifest identity is invalid.');
  if (!Array.isArray(value.compatibleProfileCatalogVersions) || value.compatibleProfileCatalogVersions.length < 1
    || value.compatibleProfileCatalogVersions.length > 16 || new Set(value.compatibleProfileCatalogVersions).size !== value.compatibleProfileCatalogVersions.length
    || value.compatibleProfileCatalogVersions.some((version) => typeof version !== 'string' || !VERSION.test(version))) {
    throw new Error('Host Runner compatible profile catalog versions are invalid.');
  }
  if (!Array.isArray(value.compatibleNodeMajors) || value.compatibleNodeMajors.length < 1 || value.compatibleNodeMajors.length > 4
    || new Set(value.compatibleNodeMajors).size !== value.compatibleNodeMajors.length
    || value.compatibleNodeMajors.some((major) => !Number.isInteger(major) || major < 20 || major > 30)) {
    throw new Error('Host Runner compatible Node majors are invalid.');
  }
  const legacyRelease = legacySchema ? legacyReleaseInventory(value.bundleVersion) : null;
  if (value.entrypoint !== 'lib/host-verification-runner.mjs'
    || value.governanceEntrypoint !== 'bin/forge-governance'
    || (legacySchema && (value.phaseWorkspaceObserverEntrypoint !== undefined
      || value.protectedRecoveryEntrypoint !== undefined
      || (legacyRelease.hasPhaseRuntime
        ? (value.phaseControllerEntrypoint !== 'lib/forge-delivery-phase-controller.mjs'
          || value.phasePrepareEntrypoint !== 'lib/forge-prepare-headless-execution.mjs')
        : (value.phaseControllerEntrypoint !== undefined || value.phasePrepareEntrypoint !== undefined))))
    || (!legacySchema && (value.phaseControllerEntrypoint !== 'lib/forge-delivery-phase-controller.mjs'
      || value.phasePrepareEntrypoint !== 'lib/forge-prepare-headless-execution.mjs'
      || value.phaseWorkspaceObserverEntrypoint !== 'lib/forge-delivery-phase-workspace-observer.mjs'))
    || ((legacySchema || previousSchema) && value.protectedRecoveryEntrypoint !== undefined)
    || (!legacySchema && !previousSchema
      && value.protectedRecoveryEntrypoint !== 'bin/run-forge-protected-headless-recovery.mjs')) {
    throw new Error('Host Runner entrypoints are invalid.');
  }
  const expected = legacySchema
    ? legacyRelease.targets
    : (previousSchema ? PREVIOUS_SOURCE_MAP
      : (recoverySchema ? RECOVERY_SOURCE_MAP
        : (productionGrantSchema ? PRODUCTION_GRANT_SOURCE_MAP
          : (crossLayerSchema ? CROSS_LAYER_SOURCE_MAP : semanticReviewSchema ? SEMANTIC_REVIEW_SOURCE_MAP
            : value.schemaVersion === DEPENDENCY_SEED_SCHEMA ? DEPENDENCY_SEED_SOURCE_MAP
              : value.schemaVersion === PREPARED_DEPENDENCY_SCHEMA ? PREPARED_DEPENDENCY_SOURCE_MAP
                : value.schemaVersion === DUAL_REVIEW_SCHEMA ? DUAL_REVIEW_SOURCE_MAP
                  : value.schemaVersion === SOURCE_PROVENANCE_SCHEMA ? SOURCE_PROVENANCE_SOURCE_MAP
                    : value.schemaVersion === WORKFLOW_INVENTORY_SCHEMA ? WORKFLOW_INVENTORY_SOURCE_MAP
                      : value.schemaVersion === SEMANTIC_RESOURCE_SCHEMA ? SEMANTIC_RESOURCE_SOURCE_MAP
                        : value.schemaVersion === DEAD_WRITER_SCHEMA ? DEAD_WRITER_SOURCE_MAP
                          : value.schemaVersion === BUSINESS_DATA_PREVIEW_SCHEMA ? BUSINESS_DATA_PREVIEW_SOURCE_MAP
                            : value.schemaVersion === BUSINESS_DATA_CONSUMPTION_SCHEMA ? BUSINESS_DATA_CONSUMPTION_SOURCE_MAP
                              : value.schemaVersion === TYPECHECK_SCHEMA ? TYPECHECK_SOURCE_MAP : SOURCE_MAP))))
      .map(([, target]) => target).sort(comparePath);
  if (!Array.isArray(value.files) || value.files.length !== expected.length) throw new Error('Host Runner file inventory is incomplete.');
  const seen = new Set();
  for (const file of value.files) {
    exactKeys(file, ['path', 'bytes', 'sha256'], 'Host Runner file entry');
    const relative = canonicalRelative(file.path);
    if (relative !== file.path || seen.has(relative) || !Number.isInteger(file.bytes) || file.bytes < 1 || !SHA256.test(file.sha256 ?? '')) throw new Error('Host Runner file inventory entry is invalid.');
    seen.add(relative);
  }
  if (value.files.some((file, index) => file.path !== expected[index])) throw new Error('Host Runner file inventory is not the exact canonical runtime closure.');
  if (!SHA256.test(value.treeSha256 ?? '')) throw new Error('Host Runner tree hash is invalid.');
  return value;
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let published = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    published = true;
    await syncDirectory(path.dirname(file));
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => {});
  }
}

async function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncFile(file) {
  if (process.platform === 'win32') return;
  const handle = await open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function validateHostRunnerBundle(rootPath, options = {}) {
  const root = path.resolve(rootPath);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error('Host Runner bundle root is unsafe.');
  const manifestMetadata = await lstat(path.join(root, MANIFEST));
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.nlink !== 1) throw new Error('Host Runner manifest is unsafe.');
  const manifest = validateManifest(JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8')));
  if (options.profileCatalogVersion && !manifest.compatibleProfileCatalogVersions.includes(options.profileCatalogVersion)) throw new Error('Host Runner bundle is incompatible with the selected profile catalog.');
  if (options.nodeMajor && !manifest.compatibleNodeMajors.includes(Number(options.nodeMajor))) throw new Error('Host Runner bundle is incompatible with the selected Node major.');
  const files = await payloadFiles(root);
  if (files.length !== manifest.files.length || files.some((file, index) => file.path !== manifest.files[index].path || file.bytes !== manifest.files[index].bytes || file.sha256 !== manifest.files[index].sha256)) throw new Error('Host Runner payload differs from its exact inventory.');
  if (treeHash(files) !== manifest.treeSha256) throw new Error('Host Runner tree hash is invalid.');
  return { root, manifest, treeSha256: manifest.treeSha256 };
}

export async function createHostRunnerBundle(options) {
  const sourceRoot = path.resolve(options.sourceRoot);
  const outputRoot = path.resolve(options.outputRoot);
  await lstat(outputRoot).then(() => { throw new Error('Host Runner bundle output already exists.'); }, (error) => { if (error.code !== 'ENOENT') throw error; });
  const staging = `${outputRoot}.creating-${crypto.randomUUID()}`;
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const [source, target] of SOURCE_MAP) {
      const from = path.resolve(sourceRoot, ...source.split('/'));
      const to = path.resolve(staging, ...target.split('/'));
      if (!inside(sourceRoot, from) || !inside(staging, to)) throw new Error('Host Runner source mapping escaped its root.');
      await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await copyFile(from, to);
    }
    if (process.platform !== 'win32') {
      await chmod(path.join(staging, 'bin/forge-governance'), 0o555);
      await chmod(path.join(staging, 'bin/run-forge-protected-headless-recovery.mjs'), 0o555);
    }
    const files = await payloadFiles(staging);
    const manifest = validateManifest({
      schemaVersion: SCHEMA,
      bundleVersion: options.bundleVersion,
      compatibleProfileCatalogVersions: [...options.profileCatalogVersions],
      compatibleNodeMajors: [...options.nodeMajors].map(Number),
      entrypoint: 'lib/host-verification-runner.mjs',
      governanceEntrypoint: 'bin/forge-governance',
      phaseControllerEntrypoint: 'lib/forge-delivery-phase-controller.mjs',
      phasePrepareEntrypoint: 'lib/forge-prepare-headless-execution.mjs',
      phaseWorkspaceObserverEntrypoint: 'lib/forge-delivery-phase-workspace-observer.mjs',
      protectedRecoveryEntrypoint: 'bin/run-forge-protected-headless-recovery.mjs',
      files,
      treeSha256: treeHash(files),
    });
    await writeFile(path.join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await validateHostRunnerBundle(staging);
    await rename(staging, outputRoot);
    return validateHostRunnerBundle(outputRoot);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function installRoots(installRoot) {
  const root = path.resolve(installRoot);
  const versions = path.join(root, 'versions');
  await mkdir(versions, { recursive: true, mode: 0o755 });
  for (const directory of [root, versions]) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Host Runner install root is unsafe.');
    if (process.platform !== 'win32') await chmod(directory, 0o755);
  }
  return { root, versions };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === 1 && right.nlink === 1;
}

async function runFlock(fd) {
  return new Promise((resolve, reject) => {
    const child = spawn(FLOCK_EXECUTABLE, ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', fd],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr: stderr.slice(0, 4096) }));
  });
}

async function startFlockHolder(fd) {
  const child = spawn(BASH_EXECUTABLE, [
    '--noprofile', '--norc', '-c',
    `${FLOCK_EXECUTABLE} --exclusive --nonblock 3 || exit 75; printf 'LOCKED\\n'; read -r _ || true`,
  ], {
    stdio: ['pipe', 'pipe', 'pipe', fd],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { if (stdout.length < 4096) stdout += chunk; });
  child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk; });
  const closed = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal, error: null }));
  });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out acquiring the Host Runner lifecycle flock.')), 5000);
    child.stdout.on('data', () => {
      if (stdout.includes('LOCKED\n')) {
        clearTimeout(timeout);
        resolve(true);
      }
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      if (!stdout.includes('LOCKED\n')) {
        clearTimeout(timeout);
        reject(new Error(code === 75 && signal === null
          ? 'Another Host Runner lifecycle action owns the activation lock.'
          : `Host Runner lifecycle flock helper failed (${code ?? signal}): ${stderr.slice(0, 512)}`));
      }
    });
  }).catch(async (error) => {
    child.stdin.destroy();
    child.kill();
    await closed;
    throw error;
  });
  if (ready !== true) throw new Error('Host Runner lifecycle flock helper did not become ready.');
  return { child, closed };
}

async function ensurePosixLifecycleLock(root) {
  const lockPath = path.join(root, LIFECYCLE_LOCK);
  const marker = 'forge-host-runner-activation-lock/v1\n';
  const markerBytes = Buffer.from(marker, 'utf8');
  try {
    await writeFile(lockPath, marker, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  function lockMetadataIsSafe(metadata) {
    return metadata.isFile()
      && !metadata.isSymbolicLink()
      && metadata.nlink === 1
      && (metadata.mode & 0o077) === 0;
  }

  async function assertCanonicalLock(handle, phase) {
    const opened = await handle.stat();
    const named = await lstat(lockPath);
    if (!lockMetadataIsSafe(opened) || !lockMetadataIsSafe(named)) {
      throw new Error('Host Runner lifecycle lock file is unsafe.');
    }
    if (!sameFileIdentity(opened, named)) {
      throw new Error(`Host Runner lifecycle lock identity changed ${phase}.`);
    }
    return opened;
  }

  async function readCanonicalLock(handle) {
    const before = await handle.stat();
    if (before.size > markerBytes.length) return null;
    const content = Buffer.alloc(before.size);
    const { bytesRead } = before.size === 0
      ? { bytesRead: 0 }
      : await handle.read(content, 0, content.length, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size) {
      throw new Error('Host Runner lifecycle lock content changed while reading it.');
    }
    return content.toString('utf8');
  }

  const metadata = await lstat(lockPath);
  if (!lockMetadataIsSafe(metadata)) {
    throw new Error('Host Runner lifecycle lock file is unsafe.');
  }
  const handle = await open(lockPath, 'r+');
  let holder = null;
  try {
    await assertCanonicalLock(handle, 'while opening it');
    holder = await startFlockHolder(handle.fd);
    await assertCanonicalLock(handle, 'after acquisition');

    // A separately opened descriptor must be unable to acquire the lock. This
    // proves that the inherited-descriptor flock is held on the canonical inode;
    // merely observing a ready helper is insufficient.
    const contender = await open(lockPath, 'r+');
    try {
      const probe = await runFlock(contender.fd);
      if (probe.code === 0 && probe.signal === null) throw new Error('Host Runner lifecycle flock did not remain held.');
      if (probe.code !== 1 || probe.signal !== null) {
        throw new Error(`Host Runner lifecycle flock contention probe failed unexpectedly (${probe.code ?? probe.signal}): ${probe.stderr.slice(0, 512)}`);
      }
    } finally {
      await contender.close();
    }

    const content = await readCanonicalLock(handle);
    if (content === '') {
      const legacyMetadata = await assertCanonicalLock(handle, 'before legacy migration');
      if ((legacyMetadata.mode & 0o777) !== 0o600) {
        throw new Error('Host Runner legacy lifecycle lock file is unsafe.');
      }
      const { bytesWritten } = await handle.write(markerBytes, 0, markerBytes.length, 0);
      if (bytesWritten !== markerBytes.length) throw new Error('Host Runner lifecycle lock migration was incomplete.');
      await handle.truncate(markerBytes.length);
      await handle.sync();
      await syncDirectory(root);
      await assertCanonicalLock(handle, 'after legacy migration');
      if (await readCanonicalLock(handle) !== marker) {
        throw new Error('Host Runner lifecycle lock migration could not be verified.');
      }
    } else if (content !== marker) {
      throw new Error('Host Runner lifecycle lock identity is invalid.');
    } else {
      await handle.sync();
      await syncDirectory(root);
      await assertCanonicalLock(handle, 'after durability verification');
      if (await readCanonicalLock(handle) !== marker) {
        throw new Error('Host Runner lifecycle lock identity is invalid.');
      }
    }

    return async () => {
      let releaseError = null;
      try {
        if (!sameFileIdentity(await handle.stat(), await lstat(lockPath))) {
          releaseError = new Error('Host Runner lifecycle lock identity changed before release.');
        }
      } finally {
        holder.child.stdin.end();
        const stopped = await holder.closed;
        await handle.close();
        if (stopped.error || stopped.code !== 0 || stopped.signal !== null) {
          releaseError ??= new Error(`Host Runner lifecycle flock helper exited unexpectedly (${stopped.error?.message ?? stopped.code ?? stopped.signal}).`);
        }
      }
      if (releaseError !== null) throw releaseError;
    };
  } catch (error) {
    if (holder !== null) {
      holder.child.stdin.destroy();
      holder.child.kill();
      await holder.closed.catch(() => {});
    }
    await handle.close().catch(() => {});
    throw error;
  }
}

async function acquireWindowsLifecycleLease(root) {
  const ownerPath = path.join(root, WINDOWS_LIFECYCLE_OWNER);
  let handle;
  try {
    handle = await open(ownerPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another Host Runner lifecycle action owns the activation lock.');
    throw error;
  }
  try {
    const token = crypto.randomUUID();
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, token, pid: process.pid })}\n`);
    const opened = await handle.stat();
    if (!sameFileIdentity(opened, await lstat(ownerPath))) throw new Error('Host Runner lifecycle lease identity changed while opening it.');
    return async () => {
      let releaseError = null;
      try {
        const beforeRelease = await lstat(ownerPath);
        const content = JSON.parse(await readFile(ownerPath, 'utf8'));
        if (!sameFileIdentity(await handle.stat(), beforeRelease) || content.schemaVersion !== 1 || content.token !== token) {
          releaseError = new Error('Host Runner lifecycle lease ownership changed before release.');
        }
      } catch (error) {
        releaseError = error;
      } finally {
        await handle.close();
        handle = null;
      }
      if (releaseError !== null) throw releaseError;
      await rm(ownerPath);
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function withLifecycleLock(installRoot, action) {
  const roots = await installRoots(installRoot);
  const release = process.platform === 'win32'
    ? await acquireWindowsLifecycleLease(roots.root)
    : await ensurePosixLifecycleLock(roots.root);
  try {
    return await action(roots);
  } finally {
    await release();
  }
}

const EXECUTABLE_BUNDLE_TARGETS = Object.freeze(new Set([
  'bin/forge-governance',
  'bin/forge-host-runner-bundle.mjs',
  'bin/run-forge-protected-headless-recovery.mjs',
]));

function maybeCrashForTest(options, point) {
  if (options?.testCrashAt !== point) return;
  if (process.env.NODE_ENV !== 'test') throw new Error('Host Runner crash injection is test-only.');
  process.kill(process.pid, 'SIGKILL');
}

function assertCrashInjectionAllowed(options) {
  if (options?.testCrashAt !== undefined && process.env.NODE_ENV !== 'test') {
    throw new Error('Host Runner crash injection is test-only.');
  }
}

async function freeze(root, options = {}) {
  if (process.platform === 'win32') return;
  let frozenFiles = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(item);
      else {
        const relative = path.relative(root, item).replaceAll('\\', '/');
        await chmod(item, EXECUTABLE_BUNDLE_TARGETS.has(relative) ? 0o555 : 0o444);
        frozenFiles += 1;
        if (frozenFiles === 1) maybeCrashForTest(options, options.crashPoint);
      }
    }
    await chmod(directory, options.deferRootFreeze === true && path.resolve(directory) === path.resolve(root) ? 0o700 : 0o555);
  }
  await visit(root);
}

async function verifyFrozenBundle(root, manifest, options = {}) {
  if (process.platform === 'win32') return;
  for (const relative of [MANIFEST, ...manifest.files.map((file) => file.path)]) {
    const metadata = await lstat(path.join(root, ...relative.split('/')));
    const expected = EXECUTABLE_BUNDLE_TARGETS.has(relative) ? 0o555 : 0o444;
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== expected) {
      throw new Error(`Installed Host Runner mode is not immutable: ${relative}`);
    }
  }
  const directories = new Set([root]);
  for (const relative of manifest.files.map((file) => file.path)) {
    let directory = path.dirname(path.join(root, ...relative.split('/')));
    while (inside(root, directory)) {
      directories.add(directory);
      if (path.resolve(directory) === path.resolve(root)) break;
      directory = path.dirname(directory);
    }
  }
  for (const directory of directories) {
    const metadata = await lstat(directory);
    const expected = options.deferRootFreeze === true && path.resolve(directory) === path.resolve(root) ? 0o700 : 0o555;
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== expected) {
      throw new Error('Installed Host Runner directory mode is not immutable.');
    }
  }
}

async function syncBundle(root, manifest) {
  for (const relative of [MANIFEST, ...manifest.files.map((file) => file.path)]) {
    await syncFile(path.join(root, ...relative.split('/')));
  }
  if (process.platform === 'win32') return;
  const directories = new Set([root]);
  for (const relative of manifest.files.map((file) => file.path)) {
    let directory = path.dirname(path.join(root, ...relative.split('/')));
    while (inside(root, directory)) {
      directories.add(directory);
      if (path.resolve(directory) === path.resolve(root)) break;
      directory = path.dirname(directory);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) await syncDirectory(directory);
}

async function thaw(root) {
  if (process.platform === 'win32') return;
  async function visit(directory) {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    }
  }
  await visit(root);
}

async function installHostRunnerBundleLocked(options, source, roots) {
  const { root, versions } = roots;
  const target = path.join(versions, source.manifest.bundleVersion);
  try {
    const existing = await validateHostRunnerBundle(target, options);
    if (existing.treeSha256 !== source.treeSha256) throw new Error('Installed Host Runner version has different immutable content.');
    await freeze(target, { ...options, crashPoint: 'during-existing-refreeze' });
    await verifyFrozenBundle(target, existing.manifest);
    await syncBundle(target, existing.manifest);
    await syncDirectory(versions);
    await validateHostRunnerBundle(target, options);
    return { installed: false, idempotent: true, version: source.manifest.bundleVersion, treeSha256: source.treeSha256, target };
  } catch (error) {
    try { await lstat(target); throw error; } catch (targetError) { if (targetError.code !== 'ENOENT') throw targetError; }
  }
  const staging = path.join(root, `.install-${source.manifest.bundleVersion}-${crypto.randomUUID()}`);
  let published = false;
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const file of [MANIFEST, ...source.manifest.files.map((item) => item.path)]) {
      const destination = path.resolve(staging, ...file.split('/'));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(path.resolve(source.root, ...file.split('/')), destination);
    }
    await validateHostRunnerBundle(staging, options);
    await freeze(staging, { ...options, crashPoint: 'during-install-freeze', deferRootFreeze: true });
    await verifyFrozenBundle(staging, source.manifest, { deferRootFreeze: true });
    await syncBundle(staging, source.manifest);
    await rename(staging, target);
    published = true;
    await syncDirectory(versions);
    maybeCrashForTest(options, 'after-install-publish');
    if (process.platform !== 'win32') await chmod(target, 0o555);
    await verifyFrozenBundle(target, source.manifest);
    await syncDirectory(target);
    await syncDirectory(versions);
    await validateHostRunnerBundle(target, options);
    return { installed: true, idempotent: false, version: source.manifest.bundleVersion, treeSha256: source.treeSha256, target };
  } catch (error) {
    const failedCandidate = published ? target : staging;
    await thaw(failedCandidate).catch(() => {});
    await rm(failedCandidate, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function installHostRunnerBundle(options) {
  assertCrashInjectionAllowed(options);
  const source = await validateHostRunnerBundle(options.bundleRoot, options);
  return withLifecycleLock(options.installRoot, (roots) => installHostRunnerBundleLocked(options, source, roots));
}

async function current(root, optional = false) {
  const pointer = path.join(root, 'current');
  let metadata;
  try { metadata = await lstat(pointer); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!metadata.isSymbolicLink()) throw new Error('Host Runner current pointer must be a symbolic link.');
  const link = await readlink(pointer);
  const resolved = path.resolve(root, link);
  const versions = path.resolve(root, 'versions');
  if (!inside(versions, resolved) || path.dirname(resolved) !== versions || !VERSION.test(path.basename(resolved))) throw new Error('Host Runner current pointer escaped the version root.');
  if (path.resolve(await realpath(resolved)) !== resolved) throw new Error('Host Runner current target contains an indirect link.');
  return { version: path.basename(resolved), target: resolved };
}

async function replaceCurrent(root, version) {
  const pointer = path.join(root, 'current');
  const temporary = path.join(root, `.current-${crypto.randomUUID()}`);
  const target = process.platform === 'win32' ? path.join(root, 'versions', version) : path.join('versions', version);
  await symlink(target, temporary, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await rename(temporary, pointer);
  } catch (error) {
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    const backup = path.join(root, `.current-backup-${crypto.randomUUID()}`);
    await rename(pointer, backup);
    try { await rename(temporary, pointer); await rm(backup, { force: true }); } catch (replaceError) { await rename(backup, pointer).catch(() => {}); throw replaceError; }
  } finally { await rm(temporary, { force: true }); }
  await syncDirectory(root);
}

function validateActiveState(value) {
  const hasManagerPin = value?.schemaVersion === 2;
  exactKeys(value, hasManagerPin
    ? ['schemaVersion', 'transactionId', 'operation', 'version', 'previousVersion', 'treeSha256', 'manager']
    : ['schemaVersion', 'transactionId', 'operation', 'version', 'previousVersion', 'treeSha256'], 'Host Runner activation state');
  if (![1, 2].includes(value.schemaVersion)
    || typeof value.transactionId !== 'string' || value.transactionId.length < 16 || value.transactionId.length > 128
    || !['activate', 'rollback'].includes(value.operation)
    || !VERSION.test(value.version ?? '')
    || (value.previousVersion !== null && !VERSION.test(value.previousVersion ?? ''))
    || !SHA256.test(value.treeSha256 ?? '')
    || (hasManagerPin && (!value.manager || typeof value.manager !== 'object' || Array.isArray(value.manager)))) {
    throw new Error('Host Runner activation state is invalid.');
  }
  return value;
}

function validatePendingState(value) {
  const hasManagerPin = value?.schemaVersion === 2;
  exactKeys(value, hasManagerPin
    ? ['schemaVersion', 'transactionId', 'operation', 'fromVersion', 'toVersion', 'treeSha256', 'manager']
    : ['schemaVersion', 'transactionId', 'operation', 'fromVersion', 'toVersion', 'treeSha256'], 'Host Runner pending activation state');
  if (![1, 2].includes(value.schemaVersion)
    || typeof value.transactionId !== 'string' || value.transactionId.length < 16 || value.transactionId.length > 128
    || !['activate', 'rollback'].includes(value.operation)
    || (value.fromVersion !== null && !VERSION.test(value.fromVersion ?? ''))
    || !VERSION.test(value.toVersion ?? '')
    || value.fromVersion === value.toVersion
    || (value.operation === 'rollback' && value.fromVersion === null)
    || !SHA256.test(value.treeSha256 ?? '')
    || (hasManagerPin && (!value.manager || typeof value.manager !== 'object' || Array.isArray(value.manager)))) {
    throw new Error('Host Runner pending activation state is invalid.');
  }
  return value;
}

async function readStableJson(file, optional, label) {
  let before;
  try {
    before = await lstat(file);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`${label} is unsafe.`);
  const content = await readFile(file, 'utf8');
  const after = await lstat(file);
  if (!sameFileIdentity(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`${label} changed while it was being read.`);
  }
  return { value: JSON.parse(content), metadata: after };
}

function isLifecycleManagerSchema(schemaVersion) {
  return schemaVersion === RECOVERY_SCHEMA
    || schemaVersion === PRODUCTION_GRANT_SCHEMA
    || schemaVersion === CROSS_LAYER_SCHEMA
    || schemaVersion === SEMANTIC_REVIEW_SCHEMA
    || schemaVersion === DEPENDENCY_SEED_SCHEMA
    || schemaVersion === PREPARED_DEPENDENCY_SCHEMA
    || schemaVersion === DUAL_REVIEW_SCHEMA
    || schemaVersion === SOURCE_PROVENANCE_SCHEMA
    || schemaVersion === WORKFLOW_INVENTORY_SCHEMA
    || schemaVersion === SEMANTIC_RESOURCE_SCHEMA
    || schemaVersion === DEAD_WRITER_SCHEMA
    || schemaVersion === BUSINESS_DATA_PREVIEW_SCHEMA
    || schemaVersion === SCHEMA;
}

function managerPinForBundle(bundle) {
  if (!isLifecycleManagerSchema(bundle.manifest.schemaVersion)) {
    throw new Error('Only a v3 through v15 Host Runner bundle can be pinned as lifecycle manager.');
  }
  return Object.freeze({
    schemaVersion: 1,
    bundleVersion: bundle.manifest.bundleVersion,
    bundleRoot: bundle.root,
    entrypoint: path.join(bundle.root, 'bin', 'forge-host-runner-bundle.mjs'),
    treeSha256: bundle.treeSha256,
  });
}

async function validateManagerPin(root, value, options) {
  exactKeys(value, ['schemaVersion', 'bundleVersion', 'bundleRoot', 'entrypoint', 'treeSha256'], 'Host Runner lifecycle manager pin');
  if (value.schemaVersion !== 1 || !VERSION.test(value.bundleVersion ?? '') || !SHA256.test(value.treeSha256 ?? '')
    || !path.isAbsolute(value.bundleRoot ?? '') || !path.isAbsolute(value.entrypoint ?? '')) {
    throw new Error('Host Runner lifecycle manager pin is invalid.');
  }
  const expectedRoot = path.join(root, 'versions', value.bundleVersion);
  const expectedEntrypoint = path.join(expectedRoot, 'bin', 'forge-host-runner-bundle.mjs');
  if (path.resolve(value.bundleRoot) !== path.resolve(expectedRoot)
    || path.resolve(value.entrypoint) !== path.resolve(expectedEntrypoint)
    || path.resolve(await realpath(value.bundleRoot)) !== path.resolve(expectedRoot)
    || path.resolve(await realpath(value.entrypoint)) !== path.resolve(expectedEntrypoint)) {
    throw new Error('Host Runner lifecycle manager pin escaped its immutable version root.');
  }
  const bundle = await validateHostRunnerBundle(expectedRoot, options);
  if (!isLifecycleManagerSchema(bundle.manifest.schemaVersion) || bundle.treeSha256 !== value.treeSha256) {
    throw new Error('Host Runner lifecycle manager pin differs from its immutable v3, v4, v5, v6, v7, v8, or v9 bundle.');
  }
  return managerPinForBundle(bundle);
}

async function transitionManagerPin(root, selected, previous, active, options) {
  if (active?.schemaVersion === 2) await validateManagerPin(root, active.manager, options);
  if (isLifecycleManagerSchema(selected.manifest.schemaVersion)) return managerPinForBundle(selected);
  if (active?.schemaVersion === 2) return validateManagerPin(root, active.manager, options);
  if (previous !== null) {
    const previousBundle = await validateHostRunnerBundle(previous.target, options);
    if (isLifecycleManagerSchema(previousBundle.manifest.schemaVersion)) return managerPinForBundle(previousBundle);
  }
  return null;
}

async function readActiveState(root, optional = false) {
  const document = await readStableJson(path.join(root, ACTIVE), optional, 'Host Runner activation state');
  return document === null ? null : validateActiveState(document.value);
}

async function validateInstalledActive(root, active, options) {
  const bundle = await validateHostRunnerBundle(path.join(root, 'versions', active.version), options);
  if (bundle.treeSha256 !== active.treeSha256) throw new Error('Host Runner activation state differs from its installed bundle.');
  if (active.schemaVersion === 2) await validateManagerPin(root, active.manager, options);
  return bundle;
}

function sameManagerPin(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameActivationState(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

async function removePendingTransition(root, metadata) {
  const pendingFile = path.join(root, PENDING);
  if (!sameFileIdentity(metadata, await lstat(pendingFile))) {
    throw new Error('Host Runner pending activation state changed before reconciliation.');
  }
  await rm(pendingFile);
  await syncDirectory(root);
}

async function reconcilePendingTransition(root, options) {
  const document = await readStableJson(path.join(root, PENDING), true, 'Host Runner pending activation state');
  if (document === null) return null;
  const pending = validatePendingState(document.value);
  const target = await validateHostRunnerBundle(path.join(root, 'versions', pending.toVersion), options);
  if (target.treeSha256 !== pending.treeSha256) throw new Error('Host Runner pending activation target differs from its installed bundle.');
  const pendingManager = pending.schemaVersion === 2
    ? await validateManagerPin(root, pending.manager, options)
    : null;
  const selected = await current(root, true);
  const active = await readActiveState(root, true);

  const committed = selected?.version === pending.toVersion
    && active?.transactionId === pending.transactionId
    && active.operation === pending.operation
    && active.version === pending.toVersion
    && active.previousVersion === pending.fromVersion
    && active.treeSha256 === pending.treeSha256
    && active.schemaVersion === pending.schemaVersion
    && sameManagerPin(active.manager, pendingManager);
  if (committed) {
    await validateInstalledActive(root, active, options);
    await removePendingTransition(root, document.metadata);
    return Object.freeze({ status: 'completed-post-commit', transactionId: pending.transactionId, version: pending.toVersion });
  }

  const priorStateValid = pending.fromVersion === null
    ? active === null
    : active?.version === pending.fromVersion;
  if (!priorStateValid) throw new Error('Host Runner pending activation cannot be reconciled with the prior activation state.');
  if (active !== null) await validateInstalledActive(root, active, options);

  if ((pending.fromVersion === null && selected === null) || selected?.version === pending.fromVersion) {
    await removePendingTransition(root, document.metadata);
    return Object.freeze({ status: 'aborted-pre-switch', transactionId: pending.transactionId, version: pending.fromVersion });
  }
  if (selected?.version === pending.toVersion) {
    if (pending.fromVersion === null) {
      await rm(path.join(root, 'current'));
      await syncDirectory(root);
    } else {
      await replaceCurrent(root, pending.fromVersion);
    }
    await removePendingTransition(root, document.metadata);
    return Object.freeze({ status: 'rolled-back-uncommitted-switch', transactionId: pending.transactionId, version: pending.fromVersion });
  }
  throw new Error('Host Runner pending activation has an ambiguous current pointer and requires review.');
}

async function switchVersionLocked(options, operation, roots, inheritedManagerPin = null) {
  const { root, versions } = roots;
  if (!VERSION.test(options.version ?? '')) throw new Error('Host Runner activation version is invalid.');
  const reconciledTransition = await reconcilePendingTransition(root, options);
  const selected = await validateHostRunnerBundle(path.join(versions, options.version), options);
  const previous = await current(root, true);
  const active = await readActiveState(root, true);
  const manager = inheritedManagerPin === null
    ? await transitionManagerPin(root, selected, previous, active, options)
    : await validateManagerPin(root, inheritedManagerPin, options);
  const hasRequiredManagerPin = ![CROSS_LAYER_SCHEMA, SEMANTIC_REVIEW_SCHEMA, DEPENDENCY_SEED_SCHEMA,
    PREPARED_DEPENDENCY_SCHEMA, DUAL_REVIEW_SCHEMA, SOURCE_PROVENANCE_SCHEMA, WORKFLOW_INVENTORY_SCHEMA, SEMANTIC_RESOURCE_SCHEMA, DEAD_WRITER_SCHEMA, BUSINESS_DATA_PREVIEW_SCHEMA, SCHEMA]
    .includes(selected.manifest.schemaVersion) || active?.schemaVersion === 2;
  if (previous?.version === options.version && active?.version === options.version && !hasRequiredManagerPin) {
    throw new Error('Active v3 Host Runner lacks a durable manager pin and requires reviewed repair.');
  }
  if (previous?.version === options.version && active?.version === options.version
    && hasRequiredManagerPin && (operation !== 'rollback' || active.operation === 'rollback')) {
    if (active.schemaVersion === 2) await validateManagerPin(root, active.manager, options);
    return {
      activated: false,
      idempotent: true,
      version: options.version,
      previousVersion: active.previousVersion ?? null,
      treeSha256: selected.treeSha256,
      manager: active.schemaVersion === 2 ? active.manager : null,
      ...(reconciledTransition === null ? {} : { reconciledTransition }),
    };
  }
  const state = {
    schemaVersion: manager === null ? 1 : 2,
    transactionId: crypto.randomUUID(),
    operation,
    fromVersion: previous?.version ?? null,
    toVersion: options.version,
    treeSha256: selected.treeSha256,
    ...(manager === null ? {} : { manager }),
  };
  const activeState = {
    schemaVersion: state.schemaVersion,
    transactionId: state.transactionId,
    operation,
    version: options.version,
    previousVersion: previous?.version ?? null,
    treeSha256: selected.treeSha256,
    ...(manager === null ? {} : { manager }),
  };
  await atomicJson(path.join(root, PENDING), state);
  maybeCrashForTest(options, 'after-pending-write');
  try {
    await replaceCurrent(root, options.version);
    maybeCrashForTest(options, 'after-current-switch');
    if (options.failpoint === 'after-current-switch') throw new Error('Injected Host Runner activation failure.');
    await atomicJson(path.join(root, ACTIVE), activeState);
    maybeCrashForTest(options, 'after-active-write');
    await rm(path.join(root, PENDING), { force: true });
    await syncDirectory(root);
    return {
      activated: true,
      idempotent: false,
      ...activeState,
      ...(reconciledTransition === null ? {} : { reconciledTransition }),
    };
  } catch (error) {
    let observedActive;
    let observedCurrent;
    try {
      observedActive = await readActiveState(root, true);
      observedCurrent = await current(root, true);
    } catch (stateError) {
      throw new AggregateError([error, stateError], 'Host Runner activation failed with an ambiguous durable commit state.');
    }
    if (sameActivationState(observedActive, activeState)) {
      // The active commit was atomically published. Keep current and any
      // remaining pending record so the next locked invocation can complete
      // post-commit reconciliation; rolling back here would split truth.
      if (observedCurrent?.version !== options.version) {
        throw new AggregateError([error], 'Host Runner activation commit exists but current is ambiguous.');
      }
      throw error;
    }
    if (!sameActivationState(observedActive, active)) {
      throw new AggregateError([error], 'Host Runner activation failed after the activation state changed ambiguously.');
    }
    const priorVersion = previous?.version ?? null;
    if (observedCurrent?.version === options.version) {
      if (previous) await replaceCurrent(root, previous.version);
      else await rm(path.join(root, 'current'), { force: true });
    } else if ((observedCurrent?.version ?? null) !== priorVersion) {
      throw new AggregateError([error], 'Host Runner activation failed with an ambiguous current pointer.');
    }
    await rm(path.join(root, PENDING), { force: true });
    await syncDirectory(root);
    throw error;
  }
}

export function activateHostRunnerBundle(options) {
  assertCrashInjectionAllowed(options);
  return withLifecycleLock(options.installRoot, (roots) => switchVersionLocked(options, 'activate', roots));
}

export async function rollbackHostRunnerBundle(options) {
  assertCrashInjectionAllowed(options);
  return withLifecycleLock(options.installRoot, async (roots) => {
    const reconciledTransition = await reconcilePendingTransition(roots.root, options);
    const selected = await current(roots.root);
    const active = await readActiveState(roots.root);
    if (active.version !== selected.version) throw new Error('Host Runner activation state differs from current.');
    const manager = active.schemaVersion === 2
      ? await validateManagerPin(roots.root, active.manager, options)
      : null;
    if (active.operation === 'rollback') {
      return {
        activated: false,
        idempotent: true,
        version: selected.version,
        previousVersion: active.previousVersion ?? null,
        treeSha256: active.treeSha256,
        manager,
        ...(reconciledTransition === null ? {} : { reconciledTransition }),
      };
    }
    if (!VERSION.test(active.previousVersion ?? '')) throw new Error('No prior Host Runner version is available for rollback.');
    const result = await switchVersionLocked({ ...options, version: active.previousVersion }, 'rollback', roots, manager);
    return reconciledTransition === null ? result : { ...result, reconciledTransition };
  });
}

export async function doctorHostRunnerBundle(options) {
  return withLifecycleLock(options.installRoot, async ({ root }) => {
    const reconciledTransition = await reconcilePendingTransition(root, options);
    const selected = await current(root);
    const active = await readActiveState(root);
    if (active.version !== selected.version) throw new Error('Host Runner activation state differs from current.');
    const bundle = await validateHostRunnerBundle(selected.target, options);
    if (bundle.treeSha256 !== active.treeSha256) throw new Error('Active Host Runner differs from activation state.');
    const manager = active.schemaVersion === 2
      ? await validateManagerPin(root, active.manager, options)
      : null;
    return {
      ok: true,
      version: selected.version,
      previousVersion: active.previousVersion ?? null,
      treeSha256: bundle.treeSha256,
      manager,
      ...(reconciledTransition === null ? {} : { reconciledTransition }),
      entrypoint: path.join(root, 'current', bundle.manifest.entrypoint),
      governanceEntrypoint: path.join(root, 'current', bundle.manifest.governanceEntrypoint),
      phaseControllerEntrypoint: bundle.manifest.phaseControllerEntrypoint === undefined
        ? null : path.join(root, 'current', bundle.manifest.phaseControllerEntrypoint),
      phasePrepareEntrypoint: bundle.manifest.phasePrepareEntrypoint === undefined
        ? null : path.join(root, 'current', bundle.manifest.phasePrepareEntrypoint),
      phaseWorkspaceObserverEntrypoint: bundle.manifest.phaseWorkspaceObserverEntrypoint === undefined
        ? null : path.join(root, 'current', bundle.manifest.phaseWorkspaceObserverEntrypoint),
      protectedRecoveryEntrypoint: bundle.manifest.protectedRecoveryEntrypoint === undefined
        ? null : path.join(root, 'current', bundle.manifest.protectedRecoveryEntrypoint),
    };
  });
}

function argumentsMap(argv) {
  const action = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) throw new Error('Host Runner bundle arguments must be unique --name value pairs.');
    values.set(key, value);
  }
  return { action, values };
}

function required(values, key) { const value = values.get(key); if (!value) throw new Error(`${key} is required.`); return value; }

async function main() {
  const { action, values } = argumentsMap(process.argv.slice(2));
  const compatibility = { profileCatalogVersion: values.get('--profile-catalog-version'), nodeMajor: values.get('--node-major') };
  let result;
  if (action === 'build') result = await createHostRunnerBundle({ sourceRoot: required(values, '--source-root'), outputRoot: required(values, '--output'), bundleVersion: required(values, '--bundle-version'), profileCatalogVersions: required(values, '--profile-catalog-version').split(','), nodeMajors: required(values, '--node-major').split(',') });
  else if (action === 'validate') result = await validateHostRunnerBundle(required(values, '--bundle'), compatibility);
  else if (action === 'install') result = await installHostRunnerBundle({ bundleRoot: required(values, '--bundle'), installRoot: required(values, '--install-root'), ...compatibility });
  else if (action === 'activate') result = await activateHostRunnerBundle({ installRoot: required(values, '--install-root'), version: required(values, '--version'), ...compatibility });
  else if (action === 'rollback') result = await rollbackHostRunnerBundle({ installRoot: required(values, '--install-root'), ...compatibility });
  else if (action === 'doctor') result = await doctorHostRunnerBundle({ installRoot: required(values, '--install-root'), ...compatibility });
  else throw new Error('Usage: forge-host-runner-bundle.mjs <build|validate|install|activate|rollback|doctor> --name value ...');
  const printable = result?.manifest ? { bundleVersion: result.manifest.bundleVersion, treeSha256: result.treeSha256, compatibleProfileCatalogVersions: result.manifest.compatibleProfileCatalogVersions, compatibleNodeMajors: result.manifest.compatibleNodeMajors } : result;
  process.stdout.write(`${JSON.stringify({ ok: true, ...printable })}\n`);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(realpathSync(path.resolve(process.argv[1]))) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) main().catch((error) => { process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`); process.exitCode = 1; });
