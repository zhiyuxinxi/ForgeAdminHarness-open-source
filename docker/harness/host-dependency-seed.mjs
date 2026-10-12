import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';

const SCHEMA = 'forge-host-dependency-seed/v1';
const SHA256 = /^[0-9a-f]{64}$/u;
const GROUPS = ['m2', 'pnpm'];
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const jsonDigest = (value) => digest(JSON.stringify(value));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// pnpm's content-addressed store distinguishes executable payloads by this
// suffix. Legacy packs lost Unix modes but retained these manifest-bound paths.
export function dependencySeedExecutable(relative, mode = 0) {
  return (mode & 0o111) !== 0
    || /^pnpm\/store\/v[0-9]+\/files\/[0-9a-f]{2}\/[0-9a-f]{126}-exec$/u.test(relative);
}

export class DependencySeedError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'DependencySeedError';
    this.code = code;
  }
}

function invalid(message) {
  throw new DependencySeedError('HOST_DEPENDENCY_SEED_INVALID', message);
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':')
    || /[\x00-\x1f]/u.test(value) || value.startsWith('/')
    || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    invalid('Dependency seed path must be an ordinary repository-relative path.');
  }
  return value;
}

function dependencyInput(relative) {
  return /(?:^|\/)(?:pom\.xml|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.cjs|mvnw|mvnw\.cmd)$/u.test(relative)
    || /(?:^|\/)(?:\.mvn|patches)\//u.test(relative)
    || /(?:^|\/)(?:maven\.config|jvm\.config|settings\.xml|toolchains\.xml)$/u.test(relative);
}

function selectedDependencyInputs(inputs, groups) {
  if (groups.includes('m2') && groups.includes('pnpm')) return inputs;
  const maven = (relative) => /(?:^|\/)(?:pom\.xml|mvnw|mvnw\.cmd|maven\.config|jvm\.config|settings\.xml|toolchains\.xml)$/u.test(relative)
    || /(?:^|\/)\.mvn\//u.test(relative);
  return inputs.filter((entry) => groups.includes('m2') === maven(entry.path));
}

export function dependencySeedInputs(inventory) {
  if (!Array.isArray(inventory?.files)) invalid('Dependency seed inventory.files is required.');
  const seen = new Set();
  const result = [];
  for (const entry of inventory.files) {
    const relative = relativePath(entry?.relative);
    if (seen.has(relative)) invalid('Dependency seed inventory contains a duplicate path.');
    seen.add(relative);
    if (!dependencyInput(relative)) continue;
    if (entry.deleted === true) result.push({ path: relative, deleted: true });
    else {
      if (!SHA256.test(entry.sha256 ?? '')) invalid('Dependency seed input SHA-256 is invalid.');
      result.push({ path: relative, sha256: entry.sha256 });
    }
  }
  return result.sort((a, b) => compare(a.path, b.path));
}

export function dependencySeedToolchains(toolchain) {
  const versions = {};
  const patterns = {
    java: /(?:openjdk|java) version\s+"([^"\s]+)"/u,
    maven: /Apache Maven\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?)/u,
    node: /^v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?)(?:\s|$)/u,
    pnpm: /^([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?)(?:\s|$)/u,
  };
  for (const name of ['java', 'maven', 'node', 'pnpm']) {
    const version = toolchain?.executables?.[name]?.version;
    if (typeof version !== 'string') invalid(`Dependency seed ${name} version is missing.`);
    const normalized = version.replace(/\x1b\[[0-9;]*m/gu, '').trim();
    const match = patterns[name].exec(normalized);
    if (!match || !/^[A-Za-z0-9._+-]+$/u.test(match[1])) invalid(`Dependency seed ${name} version is invalid.`);
    versions[name] = match[1];
  }
  return { platform: process.platform, arch: process.arch, ...versions };
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) invalid('Dependency seed root must be absolute.');
  return path.resolve(value);
}

async function optionalStat(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function requireDirectory(metadata, label, readOnly = false) {
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) invalid(`${label} must be an ordinary directory.`);
  if (readOnly && process.platform !== 'win32' && (metadata.mode & 0o222) !== 0) invalid(`${label} must be read-only.`);
}

async function directoryChain(directory, { create = false } = {}) {
  const resolved = absolute(directory);
  const parent = path.dirname(resolved);
  if (parent !== resolved) await directoryChain(parent, { create });
  let metadata = await optionalStat(resolved);
  if (metadata === null && create) {
    try { await mkdir(resolved, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    metadata = await lstat(resolved);
  }
  requireDirectory(metadata, 'Dependency seed directory ancestor');
  return metadata;
}

function regular(metadata, readOnly) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) invalid('Dependency seed files must be ordinary files with one link.');
  if (readOnly && process.platform !== 'win32' && (metadata.mode & 0o222) !== 0) invalid('Dependency seed file must be read-only.');
}

function sameFile(a, b) {
  return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'nlink'].every((key) => a[key] === b[key]);
}

async function hashFile(file, readOnly, capture = false) {
  const before = await lstat(file);
  regular(before, readOnly);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(before, await handle.stat())) invalid('Dependency seed file changed while opening.');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const chunks = [];
    let bytes = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      hash.update(buffer.subarray(0, result.bytesRead));
      if (capture) {
        if (bytes > 64 * 1024 * 1024) invalid('Dependency seed manifest exceeds 64 MiB.');
        chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
      }
    }
    if (!sameFile(before, await handle.stat()) || !sameFile(before, await lstat(file)) || bytes !== before.size) {
      invalid('Dependency seed file changed while reading.');
    }
    return { bytes, sha256: hash.digest('hex'), ...(capture ? { content: Buffer.concat(chunks) } : {}) };
  } finally { await handle.close(); }
}

function payloadPath(relative) {
  relativePath(relative);
  if (!relative.startsWith('m2/repository/') && !relative.startsWith('pnpm/store/')) invalid('Dependency seed payload is outside m2/repository or pnpm/store.');
  return relative;
}

async function inventorySeed(root, readOnly, groups = GROUPS) {
  await directoryChain(root);
  const files = [];
  const visit = async (directory, relative = '') => {
    requireDirectory(await lstat(directory), 'Dependency seed directory', readOnly);
    const entries = (await readdir(directory)).sort(compare);
    for (const name of entries) {
      if (relative === '' && GROUPS.includes(name) && !groups.includes(name)) continue;
      const child = relative ? `${relative}/${name}` : name;
      relativePath(child);
      const file = path.join(directory, name);
      const metadata = await lstat(file);
      if (child === 'manifest.json') {
        regular(metadata, readOnly);
        continue;
      }
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        if (!['m2', 'm2/repository', 'pnpm', 'pnpm/store'].includes(child)) payloadPath(`${child}/_`);
        await visit(file, child);
      } else {
        payloadPath(child);
        files.push({ path: child, ...await hashFile(file, readOnly) });
      }
    }
  };
  await visit(root);
  if (groups.some((group) => !files.some((entry) => entry.path.startsWith(`${group}/`)))) invalid('Dependency seed requires the selected Maven/pnpm payloads.');
  return files.sort((a, b) => compare(a.path, b.path));
}

function project(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,47}$/u.test(value)) invalid('Dependency seed project identity is invalid.');
  return value;
}

function settingsDigest(value) {
  if (!SHA256.test(value ?? '')) invalid('Dependency seed Maven settings SHA-256 is invalid.');
  return value;
}

// Operator-only pack preparation: returning this document does not publish or trust a cache.
export async function createDependencySeedManifest({ root, projectSlug, sourceHead, inventory, toolchain, mavenSettingsSha256 }) {
  if (!/^[0-9a-f]{40}$/u.test(sourceHead ?? '')) invalid('Dependency seed source head is invalid.');
  const inputs = dependencySeedInputs(inventory);
  const files = await inventorySeed(absolute(root), false);
  return {
    schemaVersion: SCHEMA,
    projectSlug: project(projectSlug),
    sourceHead,
    inputs,
    inputsDigest: jsonDigest(inputs),
    toolchains: dependencySeedToolchains(toolchain),
    mavenSettingsSha256: settingsDigest(mavenSettingsSha256),
    files,
    packDigest: jsonDigest(files),
  };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(',') !== ['schemaVersion', 'projectSlug', 'sourceHead', 'inputs', 'inputsDigest', 'toolchains', 'mavenSettingsSha256', 'files', 'packDigest'].sort().join(',')
    || manifest.schemaVersion !== SCHEMA || !/^[0-9a-f]{40}$/u.test(manifest.sourceHead ?? '')
    || !Array.isArray(manifest.inputs) || !Array.isArray(manifest.files)
    || !SHA256.test(manifest.inputsDigest ?? '') || !SHA256.test(manifest.packDigest ?? '')) invalid('Dependency seed manifest schema is invalid.');
  project(manifest.projectSlug);
  settingsDigest(manifest.mavenSettingsSha256);
  const normalized = dependencySeedInputs({ files: manifest.inputs.map((entry) => ({ relative: entry.path, ...entry })) });
  if (JSON.stringify(normalized) !== JSON.stringify(manifest.inputs) || jsonDigest(normalized) !== manifest.inputsDigest) invalid('Dependency seed input manifest digest is invalid.');
  if (!manifest.toolchains || Object.keys(manifest.toolchains).join(',') !== 'platform,arch,java,maven,node,pnpm'
    || Object.values(manifest.toolchains).some((value) => typeof value !== 'string' || !/^[A-Za-z0-9._+-]+$/u.test(value))) invalid('Dependency seed toolchain manifest is invalid.');
  let previous = '';
  for (const entry of manifest.files) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'bytes,path,sha256'
      || !SHA256.test(entry.sha256 ?? '') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) invalid('Dependency seed file manifest is invalid.');
    payloadPath(entry.path);
    if (compare(previous, entry.path) >= 0) invalid('Dependency seed files must be unique and canonically sorted.');
    previous = entry.path;
  }
  if (jsonDigest(manifest.files) !== manifest.packDigest) invalid('Dependency seed pack digest is invalid.');
}

async function preserveExisting(cacheRoot, group) {
  await directoryChain(cacheRoot);
  const metadata = await optionalStat(path.join(cacheRoot, group));
  if (metadata === null) return false;
  requireDirectory(metadata, 'Existing TaskSpace dependency cache');
  return true;
}

async function restoreGroup(root, cacheRoot, group, files) {
  if (await preserveExisting(cacheRoot, group)) return 'preserved';
  const lock = path.join(cacheRoot, `.dependency-seed-${group}.lock`);
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Another publisher may release its lock after mkdir reports EEXIST.
    // Validate an existing lock; a missing lock alone does not prove publication.
    const currentLock = await optionalStat(lock);
    if (currentLock) requireDirectory(currentLock, 'Dependency seed copy lock');
    return await preserveExisting(cacheRoot, group) ? 'preserved' : 'pending';
  }
  let temporary;
  let published = false;
  try {
    if (await preserveExisting(cacheRoot, group)) return 'preserved';
    temporary = await mkdtemp(path.join(cacheRoot, `.dependency-seed-${group}-`));
    await chmod(temporary, 0o700);
    for (const entry of files.filter((item) => item.path.startsWith(`${group}/`))) {
      const source = path.join(root, entry.path);
      await directoryChain(path.dirname(source));
      const sourceInfo = await lstat(source);
      regular(sourceInfo, true);
      const target = path.join(temporary, entry.path.slice(group.length + 1));
      await directoryChain(path.dirname(target), { create: true });
      await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await chmod(target, dependencySeedExecutable(entry.path, sourceInfo.mode) ? 0o700 : 0o600);
      const copied = await hashFile(target, false);
      if (copied.bytes !== entry.bytes || copied.sha256 !== entry.sha256) invalid('Dependency seed changed during cache copy.');
    }
    if (await preserveExisting(cacheRoot, group)) return 'preserved';
    await directoryChain(temporary);
    try { await rename(temporary, path.join(cacheRoot, group)); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      if (await preserveExisting(cacheRoot, group)) return 'preserved';
      throw error;
    }
    published = true;
    return 'restored';
  } finally {
    // Failed, populated staging directories remain for diagnosis; never recursively delete caches.
    if (temporary && !published) await rmdir(temporary).catch((error) => {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error;
    });
    await rmdir(lock);
  }
}

async function repairLegacyExecutables(cacheRoot, files) {
  if (process.platform === 'win32') return;
  for (const entry of files.filter((item) => dependencySeedExecutable(item.path))) {
    const target = path.join(cacheRoot, entry.path);
    const before = await optionalStat(target);
    if (!before || (before.mode & 0o100) !== 0) continue;
    await directoryChain(path.dirname(target));
    regular(before, false);
    const actual = await hashFile(target, false);
    // Never change private package bytes or grant execution to an unverified file.
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) continue;
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameFile(before, await handle.stat())) invalid('Private dependency changed during executable repair.');
      await handle.chmod((before.mode & 0o666) | 0o100);
    } finally { await handle.close(); }
  }
}

async function protectedManifest(binding) {
  if (binding === undefined || binding === null) return { status: 'unavailable', restored: [], preserved: [] };
  if (!binding || Object.keys(binding).sort().join(',') !== 'manifestSha256,root' || !SHA256.test(binding.manifestSha256 ?? '')) invalid('Dependency seed binding is invalid.');
  const root = absolute(binding.root);
  await directoryChain(root);
  requireDirectory(await lstat(root), 'Dependency seed root', true);
  const manifestFile = await hashFile(path.join(root, 'manifest.json'), true, true);
  if (manifestFile.sha256 !== binding.manifestSha256) invalid('Dependency seed manifest SHA-256 does not match its protected binding.');
  let manifest;
  try { manifest = JSON.parse(manifestFile.content.toString('utf8')); } catch { invalid('Dependency seed manifest is not valid JSON.'); }
  validateManifest(manifest);
  return { status: 'ready', root, manifest };
}

// A seed is an immutable cache input, not permission to replace executed tests.
// Compare its complete manifest before attesting an additive cache-only change.
export async function dependencySeedPolicyTransition({ binding, descriptor, previousDigest, projectSlug }) {
  if (!binding || descriptor.dependencySeed !== binding.manifestSha256) return null;
  const current = await protectedManifest(binding);
  if (current.manifest.projectSlug !== projectSlug) invalid('Dependency seed project changed.');
  const versions = await readdir(path.dirname(current.root), { withFileTypes: true });
  if (versions.length > 32) invalid('Dependency seed transition lookup is not bounded.');
  for (const entry of versions) {
    if (!entry.isDirectory() || entry.name === path.basename(current.root)) continue;
    const root = path.join(path.dirname(current.root), entry.name);
    let file;
    try { file = await hashFile(path.join(root, 'manifest.json'), true, true); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (jsonDigest({ ...descriptor, dependencySeed: file.sha256 }) !== previousDigest) continue;
    const previous = await protectedManifest({ root, manifestSha256: file.sha256 });
    const metadata = ({ files: _files, packDigest: _packDigest, ...value }) => value;
    if (JSON.stringify(metadata(previous.manifest)) !== JSON.stringify(metadata(current.manifest))) {
      invalid('Dependency seed metadata, inputs, toolchains or settings changed.');
    }
    const retained = new Map(previous.manifest.files.map(item => [item.path, item]));
    const currentFiles = new Map(current.manifest.files.map(item => [item.path, item]));
    for (const [relative, item] of retained) {
      if (JSON.stringify(currentFiles.get(relative)) !== JSON.stringify(item)) {
        invalid('Dependency seed removed or changed a previously available file.');
      }
    }
    const addedFiles = current.manifest.files.filter(item => !retained.has(item.path));
    if (retained.size === 0 || addedFiles.length === 0 || addedFiles.length > 1024
        || addedFiles.some(item => !item.path.startsWith('m2/repository/'))) {
      invalid('Dependency seed transition must only append bounded Maven cache files.');
    }
    return { ...descriptor, dependencySeedTransition: {
      kind: 'dependency-seed-append-only/v1', projectSlug,
      previousManifestSha256: file.sha256,
      metadataSha256: jsonDigest(metadata(current.manifest)),
      previousPackDigest: previous.manifest.packDigest,
      currentPackDigest: current.manifest.packDigest,
      retainedFileCount: retained.size, addedFiles,
    } };
  }
  return null;
}

async function boundManifest({ binding, projectSlug, inventory, toolchain, mavenSettingsSha256, groups = GROUPS,
  allowMavenInputChanges = false, allowPnpmInputChanges = false }) {
  const bound = await protectedManifest(binding);
  if (bound.status !== 'ready') return bound;
  const { manifest } = bound;
  const reasons = [];
  if (manifest.projectSlug !== project(projectSlug)) reasons.push('project');
  const preparedInputsDigest = jsonDigest(selectedDependencyInputs(manifest.inputs, groups));
  const currentInputsDigest = jsonDigest(selectedDependencyInputs(dependencySeedInputs(inventory), groups));
  if (preparedInputsDigest !== currentInputsDigest) reasons.push('inputs');
  const currentToolchains = dependencySeedToolchains(toolchain);
  // Maven artifacts may be read by a patched JDK of the same feature version.
  // Execution receipts still bind the exact runtime; the seed manifest is unchanged.
  const javaFeature = (version) => /^([1-9][0-9]*)(?:\.[0-9]+){0,3}(?:\+[0-9]+)?$/u.exec(version)?.[1];
  const seedFeature = javaFeature(manifest.toolchains.java);
  if (Array.isArray(groups) && groups.length === 1 && groups[0] === 'm2'
    && Number(seedFeature) >= 9 && seedFeature === javaFeature(currentToolchains.java)) {
    currentToolchains.java = manifest.toolchains.java;
  }
  const tools = ['platform', 'arch', ...(groups.includes('m2') ? ['java', 'maven'] : []),
    ...(groups.includes('pnpm') ? ['node', 'pnpm'] : [])];
  if (tools.some((name) => manifest.toolchains[name] !== currentToolchains[name])) reasons.push('toolchains');
  if (groups.includes('m2') && manifest.mavenSettingsSha256 !== settingsDigest(mavenSettingsSha256)) reasons.push('maven-settings');
  // Changed POMs do not invalidate immutable artifacts already present. They do
  // invalidate the completeness claim: only the read-only, offline consumer may
  // try this partial base, and must report missing artifacts as preparation work.
  // A pnpm store is content, not an installed dependency tree. Verified old
  // packages can seed a private cache; frozen-lockfile installation still runs.
  if (groups.length === 1 && ((allowMavenInputChanges && groups[0] === 'm2')
    || (allowPnpmInputChanges && groups[0] === 'pnpm'))
    && reasons.length === 1 && reasons[0] === 'inputs') {
    return { ...bound, status: 'partial', reasons, inputsChanged: true, preparedInputsDigest, currentInputsDigest };
  }
  if (reasons.length) return { status: 'incompatible', reasons, restored: [], preserved: [] };
  return bound;
}

function typed(error) {
  if (error instanceof DependencySeedError) return error;
  return new DependencySeedError('HOST_DEPENDENCY_SEED_IO', 'Dependency seed could not be verified or restored.', { cause: error });
}

// Expected identity comes from the caller's protected contract and source inventory, not this manifest.
export async function verifyDependencySeed(options) {
  try {
    const bound = await boundManifest(options);
    if (bound.status !== 'ready') return bound;
    const groups = options.groups ?? GROUPS;
    if (!groups.length || new Set(groups).size !== groups.length || groups.some((group) => !GROUPS.includes(group))) invalid('Dependency seed groups are invalid.');
    return await verifyPayload(bound, groups);
  } catch (error) { throw typed(error); }
}

async function verifyPayload(bound, groups) {
  const actual = await inventorySeed(bound.root, true, groups);
  const expected = bound.manifest.files.filter((entry) => groups.includes(entry.path.split('/')[0]));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) invalid('Dependency seed payload differs from its manifest.');
  return { ...bound, payloadVerified: true, packDigest: bound.manifest.packDigest, fileCount: actual.length };
}

// Immutable operator-published Maven repositories can be read directly. This
// resolver verifies each version once per Host boot and never creates a copy.
export function createReadOnlyMavenResolver() {
  const verified = new Map();
  const verifyBound = async (binding, bound) => {
    const key = JSON.stringify(binding);
    if (!verified.has(key)) {
      const promise = verifyPayload(bound, ['m2']).catch((error) => { throw typed(error); });
      verified.set(key, promise);
      promise.catch(() => verified.delete(key));
    }
    await verified.get(key);
    return { status: bound.status, project: 'm2', root: path.join(bound.root, 'm2', 'repository'), source: 'server-preinstalled',
      ...(bound.status === 'partial' ? { reasons: bound.reasons, inputsChanged: true,
        preparedInputsDigest: bound.preparedInputsDigest, currentInputsDigest: bound.currentInputsDigest } : {}) };
  };
  const resolve = async (options) => {
    const bound = await boundManifest({ ...options, groups: ['m2'], allowMavenInputChanges: true });
    return ['ready', 'partial'].includes(bound.status) ? verifyBound(options.binding, bound) : bound;
  };
  resolve.prepare = async ({ binding, projectSlug }) => {
    const bound = await protectedManifest(binding);
    if (bound.status !== 'ready') return bound;
    if (bound.manifest.projectSlug !== project(projectSlug)) invalid('Dependency seed project mismatch.');
    return verifyBound(binding, bound);
  };
  return resolve;
}

export async function restoreDependencySeed(options) {
  try {
    const groups = options.groups ?? GROUPS;
    if (!Array.isArray(groups) || groups.length === 0 || new Set(groups).size !== groups.length
      || groups.some((group) => !GROUPS.includes(group))) invalid('Dependency seed groups must select Maven or pnpm.');
    const bound = await boundManifest({ ...options, groups, allowPnpmInputChanges: true });
    if (!['ready', 'partial'].includes(bound.status)) return bound;
    const compatibility = bound.status === 'partial' ? { reasons: bound.reasons, inputsChanged: true,
      preparedInputsDigest: bound.preparedInputsDigest, currentInputsDigest: bound.currentInputsDigest } : {};
    const { root } = bound;
    const destination = absolute(options.cacheRoot);
    const relative = path.relative(root, destination);
    const reverse = path.relative(destination, root);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      || (!reverse.startsWith(`..${path.sep}`) && reverse !== '..' && !path.isAbsolute(reverse))) invalid('Dependency seed and TaskSpace cache roots must be separate.');
    await directoryChain(destination, { create: true });
    const existing = await Promise.all(groups.map((group) => preserveExisting(destination, group)));
    if (existing.every(Boolean)) {
      if (groups.includes('pnpm')) await repairLegacyExecutables(destination, bound.manifest.files);
      return { status: bound.status, ...compatibility, restored: [], preserved: [...groups], payloadVerified: false };
    }
    // A backend job must not read/copy the unrelated frontend store. Every file
    // copied below is verified against the protected manifest before publication.
    const allGroups = groups.length === GROUPS.length;
    const verified = allGroups ? await verifyDependencySeed(options) : bound;
    if (!['ready', 'partial'].includes(verified.status)) return verified;
    const { manifest } = verified;
    const restored = [], preserved = [], pending = [];
    for (const group of groups) {
      const outcome = await restoreGroup(root, destination, group, manifest.files);
      if (group === 'pnpm' && outcome === 'preserved') await repairLegacyExecutables(destination, manifest.files);
      ({ restored, preserved, pending })[outcome].push(group);
    }
    return { status: pending.length ? 'busy' : bound.status, ...compatibility, packDigest: manifest.packDigest,
      payloadVerified: allGroups, verifiedGroups: restored, restored, preserved, ...(pending.length ? { pending } : {}) };
  } catch (error) {
    throw typed(error);
  }
}
