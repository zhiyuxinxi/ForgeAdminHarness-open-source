#!/usr/bin/env node

import crypto from 'node:crypto';
import path from 'node:path';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { validateSkillBundle } from '../docker/harness/validate-skill-bundle.mjs';

const MANIFEST_NAME = 'bundle.manifest.json';
const ACTIVE_NAME = 'active.json';
const PENDING_NAME = 'activation.pending.json';
const SCHEMA_VERSION = 'forge-external-skill-bundle/v1';
const VERSION_PATTERN = /^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+(?:-[a-z0-9.-]+)?$/u;
const DSH_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains an unsupported field: ${key}`);
  }
}

function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalRelative(relative) {
  const normalized = relative.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')
    || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Skill bundle contains an unsafe relative path.');
  }
  return normalized;
}

function comparePath(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function atomicJson(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

async function stableFile(file) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('Skill bundle payload must contain only ordinary unlinked files and directories.');
  }
  const content = await readFile(file);
  const after = await lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs) {
    throw new Error('Skill bundle payload changed while it was being hashed.');
  }
  return {
    bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    content,
  };
}

async function payloadFiles(root, relative = '') {
  const directory = path.resolve(root, relative);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Skill bundle payload root must be an ordinary directory.');
  }
  const results = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => comparePath(left.name, right.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (!relative && child === MANIFEST_NAME) continue;
    const canonical = canonicalRelative(child);
    const absolute = path.resolve(root, ...canonical.split('/'));
    if (!inside(root, absolute)) throw new Error('Skill bundle payload escaped its root.');
    const childMetadata = await lstat(absolute);
    if (childMetadata.isSymbolicLink() || entry.isSymbolicLink()) {
      throw new Error(`Skill bundle payload contains a symbolic link: ${canonical}`);
    }
    if (childMetadata.isDirectory() && entry.isDirectory()) {
      results.push(...await payloadFiles(root, canonical));
    } else if (childMetadata.isFile() && entry.isFile()) {
      const item = await stableFile(absolute);
      results.push({ path: canonical, bytes: item.bytes, sha256: item.sha256 });
    } else {
      throw new Error(`Skill bundle payload contains an unsupported node: ${canonical}`);
    }
  }
  return results.sort((left, right) => comparePath(left.path, right.path));
}

function payloadTreeSha256(files) {
  const hash = crypto.createHash('sha256');
  hash.update('FORGE_EXTERNAL_SKILL_BUNDLE_V1\0', 'utf8');
  for (const item of files) {
    hash.update(item.path, 'utf8').update('\0');
    hash.update(item.sha256, 'ascii').update('\0');
    hash.update(String(item.bytes), 'ascii').update('\0');
  }
  return hash.digest('hex');
}

async function copyPayload(sourceRoot, destinationRoot, files) {
  await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
  for (const item of files) {
    const target = path.resolve(destinationRoot, ...item.path.split('/'));
    if (!inside(destinationRoot, target)) throw new Error('Skill bundle copy target escaped its root.');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.resolve(sourceRoot, ...item.path.split('/')), target);
  }
}

async function freezeTree(root) {
  if (process.platform === 'win32') return;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else {
        const executable = ((await lstat(target)).mode & 0o111) !== 0;
        await chmod(target, executable ? 0o555 : 0o444);
      }
    }
    await chmod(directory, 0o555);
  }
  await walk(root);
}

async function thawTree(root) {
  if (process.platform === 'win32') return;
  async function walk(directory) {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(directory, entry.name));
    }
  }
  await walk(root);
}

function validateManifestShape(manifest) {
  exactKeys(manifest, [
    'schemaVersion', 'bundleVersion', 'compatibleDshVersions', 'catalogPath',
    'skillsRoot', 'skillCount', 'files', 'treeSha256',
  ], 'Skill bundle manifest');
  if (manifest.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported Skill bundle manifest schema.');
  if (typeof manifest.bundleVersion !== 'string' || !VERSION_PATTERN.test(manifest.bundleVersion)) {
    throw new Error('Skill bundle version is invalid.');
  }
  if (!Array.isArray(manifest.compatibleDshVersions) || manifest.compatibleDshVersions.length < 1
    || manifest.compatibleDshVersions.length > 16
    || new Set(manifest.compatibleDshVersions).size !== manifest.compatibleDshVersions.length
    || manifest.compatibleDshVersions.some((version) => typeof version !== 'string' || !DSH_VERSION_PATTERN.test(version))) {
    throw new Error('Skill bundle compatible DSH versions are invalid.');
  }
  if (manifest.catalogPath !== 'catalog.json' || manifest.skillsRoot !== 'skills') {
    throw new Error('Skill bundle payload paths are invalid.');
  }
  if (!Number.isInteger(manifest.skillCount) || manifest.skillCount < 1 || manifest.skillCount > 128) {
    throw new Error('Skill bundle skill count is invalid.');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length < 2 || manifest.files.length > 4096) {
    throw new Error('Skill bundle file inventory is invalid.');
  }
  const seen = new Set();
  for (const item of manifest.files) {
    exactKeys(item, ['path', 'bytes', 'sha256'], 'Skill bundle file entry');
    const relative = canonicalRelative(item.path);
    if (relative !== item.path || seen.has(relative) || !Number.isInteger(item.bytes) || item.bytes < 0
      || typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)) {
      throw new Error('Skill bundle file inventory entry is invalid.');
    }
    seen.add(relative);
  }
  const ordered = [...manifest.files].sort((left, right) => comparePath(left.path, right.path));
  if (ordered.some((item, index) => item.path !== manifest.files[index].path)) {
    throw new Error('Skill bundle file inventory is not canonically sorted.');
  }
  if (typeof manifest.treeSha256 !== 'string' || !SHA256_PATTERN.test(manifest.treeSha256)) {
    throw new Error('Skill bundle tree hash is invalid.');
  }
  return manifest;
}

export async function validateExternalSkillBundle(bundleRoot, options = {}) {
  const root = path.resolve(bundleRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Skill bundle root must be an ordinary directory.');
  }
  const manifestFile = path.join(root, MANIFEST_NAME);
  const manifestMetadata = await lstat(manifestFile);
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.nlink !== 1) {
    throw new Error('Skill bundle manifest must be an ordinary unlinked file.');
  }
  const manifest = validateManifestShape(JSON.parse(await readFile(manifestFile, 'utf8')));
  if (options.expectedDshVersion !== undefined
    && !manifest.compatibleDshVersions.includes(options.expectedDshVersion)) {
    throw new Error('Skill bundle is incompatible with the requested DSH version.');
  }
  const actual = await payloadFiles(root);
  if (actual.length !== manifest.files.length
    || actual.some((item, index) => item.path !== manifest.files[index].path
      || item.bytes !== manifest.files[index].bytes
      || item.sha256 !== manifest.files[index].sha256)) {
    throw new Error('Skill bundle payload differs from its exact file inventory.');
  }
  const treeSha256 = payloadTreeSha256(actual);
  if (treeSha256 !== manifest.treeSha256) throw new Error('Skill bundle tree hash is invalid.');
  const skillValidation = await validateSkillBundle({
    skillsRoot: path.join(root, manifest.skillsRoot),
    catalogPath: path.join(root, manifest.catalogPath),
    capabilityInventoryPath: options.capabilityInventoryPath,
    strict: true,
  });
  if (skillValidation.bundleVersion !== manifest.bundleVersion
    || skillValidation.skillCount !== manifest.skillCount) {
    throw new Error('Skill bundle manifest identity differs from the validated catalog.');
  }
  return { manifest, treeSha256, skillValidation, root };
}

export async function createExternalSkillBundle(options) {
  const sourceSkillsRoot = path.resolve(options.sourceSkillsRoot);
  const sourceCatalogPath = path.resolve(options.sourceCatalogPath);
  const outputRoot = path.resolve(options.outputRoot);
  const compatibleDshVersions = options.compatibleDshVersions;
  if (!Array.isArray(compatibleDshVersions) || compatibleDshVersions.length === 0) {
    throw new Error('At least one compatible DSH version is required.');
  }
  const validation = await validateSkillBundle({
    skillsRoot: sourceSkillsRoot,
    catalogPath: sourceCatalogPath,
    capabilityInventoryPath: options.capabilityInventoryPath,
    strict: true,
  });
  await lstat(outputRoot).then(
    () => { throw new Error('Skill bundle output already exists.'); },
    (error) => { if (error.code !== 'ENOENT') throw error; },
  );
  const staging = `${outputRoot}.creating-${crypto.randomUUID()}`;
  try {
    await mkdir(staging, { recursive: false, mode: 0o700 });
    await copyFile(sourceCatalogPath, path.join(staging, 'catalog.json'));
    const sourceFiles = await payloadFiles(sourceSkillsRoot);
    await copyPayload(sourceSkillsRoot, path.join(staging, 'skills'), sourceFiles);
    const files = await payloadFiles(staging);
    const manifest = validateManifestShape({
      schemaVersion: SCHEMA_VERSION,
      bundleVersion: validation.bundleVersion,
      compatibleDshVersions: [...compatibleDshVersions],
      catalogPath: 'catalog.json',
      skillsRoot: 'skills',
      skillCount: validation.skillCount,
      files,
      treeSha256: payloadTreeSha256(files),
    });
    await writeFile(path.join(staging, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await validateExternalSkillBundle(staging, { capabilityInventoryPath: options.capabilityInventoryPath });
    await rename(staging, outputRoot);
    return validateExternalSkillBundle(outputRoot, { capabilityInventoryPath: options.capabilityInventoryPath });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function ensureInstallRoot(installRoot) {
  const root = path.resolve(installRoot);
  await mkdir(root, { recursive: true, mode: 0o755 });
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Skill install root is unsafe.');
  if (process.platform !== 'win32') await chmod(root, 0o755);
  const versions = path.join(root, 'versions');
  await mkdir(versions, { recursive: true, mode: 0o755 });
  const versionsMetadata = await lstat(versions);
  if (!versionsMetadata.isDirectory() || versionsMetadata.isSymbolicLink()) {
    throw new Error('Skill versions root is unsafe.');
  }
  if (process.platform !== 'win32') await chmod(versions, 0o755);
  return { root, versions };
}

export async function installExternalSkillBundle(options) {
  const source = await validateExternalSkillBundle(options.bundleRoot, {
    expectedDshVersion: options.expectedDshVersion,
    capabilityInventoryPath: options.capabilityInventoryPath,
  });
  const { root, versions } = await ensureInstallRoot(options.installRoot);
  const target = path.join(versions, source.manifest.bundleVersion);
  if (!inside(versions, target)) throw new Error('Skill bundle install target escaped the version root.');
  try {
    const existing = await validateExternalSkillBundle(target, options);
    if (existing.treeSha256 !== source.treeSha256) throw new Error('Installed Skill version has different immutable content.');
    return { installed: false, idempotent: true, version: source.manifest.bundleVersion, target, treeSha256: source.treeSha256 };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try {
        await lstat(target);
        throw error;
      } catch (targetError) {
        if (targetError.code !== 'ENOENT') throw targetError;
      }
    }
  }
  const staging = path.join(root, `.install-${source.manifest.bundleVersion}-${crypto.randomUUID()}`);
  let published = false;
  try {
    const files = [{ path: MANIFEST_NAME }, ...source.manifest.files];
    await mkdir(staging, { mode: 0o700 });
    for (const item of files) {
      const destination = path.resolve(staging, ...item.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(path.join(source.root, ...item.path.split('/')), destination);
    }
    const staged = await validateExternalSkillBundle(staging, options);
    if (staged.treeSha256 !== source.treeSha256) throw new Error('Staged Skill bundle digest changed during installation.');
    await rename(staging, target);
    published = true;
    await freezeTree(target);
    return { installed: true, idempotent: false, version: source.manifest.bundleVersion, target, treeSha256: source.treeSha256 };
  } catch (error) {
    const failedCandidate = published ? target : staging;
    await thawTree(failedCandidate).catch(() => {});
    await rm(failedCandidate, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function currentVersion(root, options = {}) {
  const current = path.join(root, 'current');
  let metadata;
  try {
    metadata = await lstat(current);
  } catch (error) {
    if (error.code === 'ENOENT' && options.optional === true) return null;
    throw error;
  }
  if (!metadata.isSymbolicLink()) throw new Error('Skill current pointer must be a symbolic link.');
  const link = await readlink(current);
  const resolved = path.resolve(path.dirname(current), link);
  const versions = path.resolve(root, 'versions');
  if (!inside(versions, resolved) || path.dirname(resolved) !== versions || !VERSION_PATTERN.test(path.basename(resolved))) {
    throw new Error('Skill current pointer escaped the immutable version root.');
  }
  const canonical = await realpath(resolved);
  if (path.resolve(canonical) !== path.resolve(resolved)) throw new Error('Skill current target must not contain an indirect link.');
  return { version: path.basename(resolved), target: resolved, link };
}

async function replaceCurrent(root, version) {
  const current = path.join(root, 'current');
  const temporary = path.join(root, `.current-${crypto.randomUUID()}`);
  const target = process.platform === 'win32'
    ? path.join(root, 'versions', version)
    : path.join('versions', version);
  await symlink(target, temporary, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await rename(temporary, current);
    return 'atomic-rename';
  } catch (error) {
    if (process.platform !== 'win32' || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    const backup = path.join(root, `.current-backup-${crypto.randomUUID()}`);
    await rename(current, backup);
    try {
      await rename(temporary, current);
      await rm(backup, { force: true });
      return 'recoverable-windows-replace';
    } catch (replaceError) {
      await rename(backup, current).catch(() => {});
      throw replaceError;
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function activateVersion(options, operation) {
  const { root, versions } = await ensureInstallRoot(options.installRoot);
  if (typeof options.version !== 'string' || !VERSION_PATTERN.test(options.version)) throw new Error('Skill activation version is invalid.');
  const target = path.join(versions, options.version);
  const bundle = await validateExternalSkillBundle(target, options);
  const previous = await currentVersion(root, { optional: true });
  let active = null;
  try {
    active = JSON.parse(await readFile(path.join(root, ACTIVE_NAME), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous?.version === options.version
    && active?.version === options.version
    && (operation !== 'rollback' || active.operation === 'rollback')) {
    return { activated: false, idempotent: true, version: options.version, previousVersion: active.previousVersion ?? null, treeSha256: bundle.treeSha256 };
  }
  const transactionId = crypto.randomUUID();
  const pendingFile = path.join(root, PENDING_NAME);
  await atomicJson(pendingFile, {
    schemaVersion: 1,
    transactionId,
    operation,
    fromVersion: previous?.version ?? null,
    toVersion: options.version,
    treeSha256: bundle.treeSha256,
  });
  let switched = false;
  try {
    const switchMode = await replaceCurrent(root, options.version);
    switched = true;
    if (options.failpoint === 'after-current-switch') throw new Error('Injected activation failure after current switch.');
    const state = {
      schemaVersion: 1,
      transactionId,
      operation,
      version: options.version,
      previousVersion: previous?.version ?? null,
      treeSha256: bundle.treeSha256,
      switchMode,
    };
    await atomicJson(path.join(root, ACTIVE_NAME), state);
    await rm(pendingFile, { force: true });
    return { activated: true, idempotent: false, ...state };
  } catch (error) {
    if (switched) {
      if (previous === null) await rm(path.join(root, 'current'), { force: true });
      else await replaceCurrent(root, previous.version);
    }
    await rm(pendingFile, { force: true });
    throw error;
  }
}

export async function activateExternalSkillBundle(options) {
  return activateVersion(options, 'activate');
}

export async function rollbackExternalSkillBundle(options) {
  const { root } = await ensureInstallRoot(options.installRoot);
  const current = await currentVersion(root);
  const active = JSON.parse(await readFile(path.join(root, ACTIVE_NAME), 'utf8'));
  if (active.version !== current.version) throw new Error('Skill activation state differs from the current pointer.');
  if (active.operation === 'rollback') {
    return { activated: false, idempotent: true, version: current.version, previousVersion: active.previousVersion ?? null, treeSha256: active.treeSha256 };
  }
  if (typeof active.previousVersion !== 'string' || !VERSION_PATTERN.test(active.previousVersion)) {
    throw new Error('No prior Skill version is available for rollback.');
  }
  return activateVersion({ ...options, version: active.previousVersion }, 'rollback');
}

export async function doctorExternalSkillBundle(options) {
  const { root } = await ensureInstallRoot(options.installRoot);
  try {
    await lstat(path.join(root, PENDING_NAME));
    throw new Error('An incomplete Skill activation transaction requires operator review.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const current = await currentVersion(root);
  const active = JSON.parse(await readFile(path.join(root, ACTIVE_NAME), 'utf8'));
  exactKeys(active, [
    'schemaVersion', 'transactionId', 'operation', 'version', 'previousVersion',
    'treeSha256', 'switchMode',
  ], 'Skill activation state');
  if (active.schemaVersion !== 1 || active.version !== current.version || !SHA256_PATTERN.test(active.treeSha256 ?? '')) {
    throw new Error('Skill activation state is invalid or differs from current.');
  }
  const bundle = await validateExternalSkillBundle(current.target, options);
  if (bundle.treeSha256 !== active.treeSha256) throw new Error('Active Skill bundle differs from activation state.');
  return {
    ok: true,
    version: current.version,
    previousVersion: active.previousVersion ?? null,
    treeSha256: bundle.treeSha256,
    skillCount: bundle.manifest.skillCount,
    compatibleDshVersions: bundle.manifest.compatibleDshVersions,
    skillDirectory: path.join(root, 'current', 'skills'),
  };
}

function parseArguments(argv) {
  const action = argv[0];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error('Skill bundle arguments must be --name value pairs.');
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
  }
  return { action, values };
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const { action, values } = parseArguments(process.argv.slice(2));
  const capabilityInventoryPath = values.get('--capability-inventory');
  let result;
  if (action === 'build') {
    result = await createExternalSkillBundle({
      sourceSkillsRoot: required(values, '--skills-root'),
      sourceCatalogPath: required(values, '--catalog'),
      outputRoot: required(values, '--output'),
      compatibleDshVersions: required(values, '--dsh-version').split(','),
      capabilityInventoryPath,
    });
  } else if (action === 'validate') {
    result = await validateExternalSkillBundle(required(values, '--bundle'), {
      expectedDshVersion: values.get('--dsh-version'),
      capabilityInventoryPath,
    });
  } else if (action === 'install') {
    result = await installExternalSkillBundle({
      bundleRoot: required(values, '--bundle'),
      capabilityInventoryPath,
      installRoot: required(values, '--install-root'),
      expectedDshVersion: required(values, '--dsh-version'),
    });
  } else if (action === 'activate') {
    result = await activateExternalSkillBundle({
      installRoot: required(values, '--install-root'),
      version: required(values, '--version'),
      capabilityInventoryPath,
      expectedDshVersion: required(values, '--dsh-version'),
    });
  } else if (action === 'rollback') {
    result = await rollbackExternalSkillBundle({
      capabilityInventoryPath,
      installRoot: required(values, '--install-root'),
      expectedDshVersion: required(values, '--dsh-version'),
    });
  } else if (action === 'doctor') {
    result = await doctorExternalSkillBundle({
      capabilityInventoryPath,
      installRoot: required(values, '--install-root'),
      expectedDshVersion: required(values, '--dsh-version'),
    });
  } else {
    throw new Error('Usage: forge-skill-bundle.mjs <build|validate|install|activate|rollback|doctor> --name value ...');
  }
  const printable = result?.manifest === undefined ? result : {
    bundleVersion: result.manifest.bundleVersion,
    skillCount: result.manifest.skillCount,
    treeSha256: result.treeSha256,
    compatibleDshVersions: result.manifest.compatibleDshVersions,
  };
  process.stdout.write(`${JSON.stringify({ ok: true, ...printable })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
}
