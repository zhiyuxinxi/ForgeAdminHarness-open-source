#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { access, lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = '/opt/forge-harness-runtime';
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_TREE_FILES = 100_000;
const MAX_TREE_BYTES = 4 * 1024 * 1024 * 1024;
const REGISTRY_PREFIX = 'https://registry.npmjs.org/';
const ROOT_PACKAGE_FIELDS = new Set([
  'allowScripts',
  'cpu',
  'dependencies',
  'description',
  'forgeRuntimePolicy',
  'libc',
  'name',
  'os',
  'private',
  'version',
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')}`;
}

async function readJsonFile(file, label) {
  const stat = await lstat(file).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
    throw new Error(`${label} is missing, linked, non-regular, or oversized.`);
  }
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function validSha512Integrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  const encoded = value.slice('sha512-'.length);
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.length === 64
    && decoded.toString('base64').replace(/=+$/u, '') === encoded.replace(/=+$/u, '');
}

function currentRuntimePlatform() {
  let libc = 'none';
  if (process.platform === 'linux') {
    const header = process.report?.getReport?.().header ?? {};
    libc = typeof header.glibcVersionRuntime === 'string' && header.glibcVersionRuntime.length > 0
      ? 'glibc'
      : 'musl';
  }
  return { os: process.platform, arch: process.arch, libc };
}

function selectorAllows(values, expected) {
  if (values === undefined) return true;
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) return false;
  if (values.includes(`!${expected}`)) return false;
  const allowed = values.filter((value) => !value.startsWith('!'));
  return allowed.length === 0 || allowed.includes(expected);
}

function validateRuntimePolicy(packageJson, sourcePackages, fullClosure) {
  const unexpected = Object.keys(packageJson)
    .filter((key) => !ROOT_PACKAGE_FIELDS.has(key))
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (unexpected.length > 0) {
    throw new Error(`Runtime package.json contains forbidden root fields: ${unexpected.join(', ')}`);
  }
  const runtime = currentRuntimePlatform();
  const selectors = { os: packageJson.os, arch: packageJson.cpu, libc: packageJson.libc };
  if (JSON.stringify(selectors.os) !== JSON.stringify([runtime.os])
      || JSON.stringify(selectors.arch) !== JSON.stringify([runtime.arch])
      || JSON.stringify(selectors.libc) !== JSON.stringify([runtime.libc])) {
    throw new Error(`Runtime package policy must exactly target ${runtime.os}/${runtime.arch}/${runtime.libc}.`);
  }
  const configured = packageJson.forgeRuntimePolicy?.requiredOptionalPackages;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error('Runtime package.json must declare a requiredOptionalPackages policy object.');
  }
  const requiredOptionalPackages = Object.entries(configured)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, version]) => {
      if (!key.startsWith('node_modules/')
          || typeof version !== 'string'
          || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
        throw new Error(`Required platform-optional package policy is not exact: ${key}`);
      }
      const entry = sourcePackages[key];
      if (!entry || entry.optional !== true || entry.version !== version || !fullClosure.has(key)) {
        throw new Error(`Required platform-optional package is absent or not optional in the reviewed closure: ${key}`);
      }
      if (!selectorAllows(entry.os, runtime.os)
          || !selectorAllows(entry.cpu, runtime.arch)
          || !selectorAllows(entry.libc, runtime.libc)) {
        throw new Error(`Required platform-optional package is incompatible with the reviewed runtime: ${key}`);
      }
      return { key, version };
    });
  return { platform: runtime, requiredOptionalPackages };
}

function packageParentKey(key) {
  const marker = key.lastIndexOf('/node_modules/');
  return marker === -1 ? '' : key.slice(0, marker);
}

function packageNameFromKey(key) {
  const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/u.exec(key);
  if (!match) throw new Error(`Invalid package-lock path: ${key}`);
  return match[1];
}

function bundledAncestor(packages, key) {
  for (let parent = packageParentKey(key); parent; parent = packageParentKey(parent)) {
    const entry = packages[parent];
    if (entry && entry.inBundle !== true) return parent;
  }
  throw new Error(`Bundled runtime package has no independently integrity-bound ancestor: ${key}`);
}

function packageBinding(entry, key, packages) {
  if (!entry || typeof entry.version !== 'string') throw new Error(`Lock entry has no version: ${key}`);
  if (entry.link === true || entry.extraneous === true) {
    throw new Error(`Linked or extraneous runtime package is forbidden: ${key}`);
  }
  if (entry.inBundle === true) {
    const ancestorKey = bundledAncestor(packages, key);
    const ancestor = packages[ancestorKey];
    if (!ancestor || typeof ancestor.resolved !== 'string' || !ancestor.resolved.startsWith(REGISTRY_PREFIX)
        || !validSha512Integrity(ancestor.integrity)) {
      throw new Error(`Bundled runtime package is not covered by a registry sha512 ancestor: ${key}`);
    }
    return { version: entry.version, resolved: null, integrity: null, bundledBy: ancestorKey };
  }
  if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(REGISTRY_PREFIX)
      || !validSha512Integrity(entry.integrity)) {
    throw new Error(`Runtime package lacks a registry HTTPS source and sha512 integrity: ${key}`);
  }
  return { version: entry.version, resolved: entry.resolved, integrity: entry.integrity, bundledBy: null };
}

function resolveDependencyKey(packages, parentKey, dependencyName) {
  for (let current = parentKey; ; current = packageParentKey(current)) {
    const candidate = current ? `${current}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`;
    if (packages[candidate]) return candidate;
    if (!current) break;
  }
  return undefined;
}

function dependencyNames(entry, includeOptional) {
  const optional = new Set(Object.keys(entry.optionalDependencies ?? {}));
  const names = new Set(
    Object.keys(entry.dependencies ?? {}).filter((name) => includeOptional || !optional.has(name)),
  );
  if (includeOptional) for (const name of optional) names.add(name);
  for (const name of Object.keys(entry.peerDependencies ?? {})) {
    if (entry.peerDependenciesMeta?.[name]?.optional !== true) names.add(name);
  }
  return [...names].sort((left, right) => left.localeCompare(right, 'en'));
}

function packageClosure(packages, includeOptional) {
  const visited = new Set(['']);
  const queue = [''];
  while (queue.length > 0) {
    const key = queue.shift();
    const entry = packages[key];
    if (!entry) throw new Error(`Package lock closure references a missing entry: ${key || '<root>'}`);
    for (const name of dependencyNames(entry, includeOptional)) {
      const resolved = resolveDependencyKey(packages, key, name);
      if (!resolved) throw new Error(`Package lock omits dependency ${name} required by ${key || '<root>'}.`);
      if (!visited.has(resolved)) {
        visited.add(resolved);
        queue.push(resolved);
      }
    }
  }
  visited.delete('');
  return visited;
}

function validateInstallScriptPolicy(packageJson, sourcePackages, fullClosure) {
  const configured = packageJson.allowScripts;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error('Runtime package.json must declare an explicit allowScripts object.');
  }
  const expected = new Set();
  for (const key of fullClosure) {
    const entry = sourcePackages[key];
    if (entry?.hasInstallScript === true) expected.add(`${packageNameFromKey(key)}@${entry.version}`);
  }
  const actual = Object.keys(configured).sort((left, right) => left.localeCompare(right, 'en'));
  if (actual.some((key) => configured[key] !== true || !/^(@[^/]+\/)?[^@/]+@[^\s]+$/u.test(key))
      || JSON.stringify(actual) !== JSON.stringify([...expected].sort((left, right) => left.localeCompare(right, 'en')))) {
    throw new Error('Runtime install-script approvals must exactly pin every reviewed script package and nothing else.');
  }
  return actual;
}

async function installedPackageKeys(modulesRoot, relative = '') {
  const directory = path.join(modulesRoot, ...relative.split('/').filter(Boolean));
  const directoryStat = await lstat(directory).catch(() => null);
  if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Installed node_modules path is unsafe: ${relative || 'node_modules'}`);
  }
  const keys = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.name === '.bin') {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Installed executable directory is unsafe: ${relative || 'node_modules'}/.bin`);
      continue;
    }
    if (entry.name === '.package-lock.json') continue;
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name.startsWith('@')) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Installed package scope is unsafe: ${entryRelative}`);
      keys.push(...await installedPackageKeys(modulesRoot, entryRelative));
      continue;
    }
    const packageDirectory = path.join(modulesRoot, ...entryRelative.split('/'));
    const stat = await lstat(packageDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Installed package is linked or non-directory: ${entryRelative}`);
    const packageJson = await readJsonFile(path.join(packageDirectory, 'package.json'), `installed package ${entryRelative}`);
    keys.push({ key: `node_modules/${entryRelative}`, name: packageJson.name, version: packageJson.version });
    const nested = path.join(packageDirectory, 'node_modules');
    const nestedStat = await lstat(nested).catch(() => null);
    if (nestedStat) {
      if (!nestedStat.isDirectory() || nestedStat.isSymbolicLink()) throw new Error(`Nested node_modules is unsafe: ${entryRelative}`);
      keys.push(...await installedPackageKeys(modulesRoot, `${entryRelative}/node_modules`));
    }
  }
  return keys;
}

async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function installedTreeReceipt(modulesRoot) {
  const hash = createHash('sha256');
  let fileCount = 0;
  let directoryCount = 0;
  let totalBytes = 0;
  let symlinkCount = 0;

  async function walk(directory, relative = '') {
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const target = path.join(directory, child.name);
      const portablePath = relative ? `${relative}/${child.name}` : child.name;
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) {
        const isExecutableLink = path.basename(directory) === '.bin'
          && path.basename(path.dirname(directory)) === 'node_modules';
        if (!isExecutableLink) throw new Error(`Runtime dependency tree contains a linked entry: ${portablePath}`);
        const linkTarget = await readlink(target);
        if (!linkTarget || path.isAbsolute(linkTarget)) {
          throw new Error(`Runtime executable link is not a relative reviewed launcher: ${portablePath}`);
        }
        const resolvedTarget = await realpath(path.resolve(directory, linkTarget)).catch(() => null);
        const modulesPrefix = `${modulesRoot}${path.sep}`;
        if (!resolvedTarget || !resolvedTarget.startsWith(modulesPrefix)) {
          throw new Error(`Runtime executable link escapes the installed dependency root: ${portablePath}`);
        }
        const resolvedStat = await lstat(resolvedTarget);
        if (!resolvedStat.isFile() || resolvedStat.isSymbolicLink()) {
          throw new Error(`Runtime executable link does not resolve to a regular file: ${portablePath}`);
        }
        symlinkCount += 1;
        hash.update(`L\0${portablePath}\0${linkTarget}\0${path.relative(modulesRoot, resolvedTarget).split(path.sep).join('/')}\n`);
        continue;
      }
      const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
      if (stat.isDirectory()) {
        directoryCount += 1;
        hash.update(`D\0${portablePath}\0${mode}\n`);
        await walk(target, portablePath);
      } else if (stat.isFile()) {
        fileCount += 1;
        totalBytes += stat.size;
        if (fileCount > MAX_TREE_FILES || totalBytes > MAX_TREE_BYTES) {
          throw new Error('Runtime dependency content tree exceeds the reviewed validation bounds.');
        }
        hash.update(`F\0${portablePath}\0${mode}\0${stat.size}\0${await fileSha256(target)}\n`);
      } else {
        throw new Error(`Runtime dependency tree contains a non-file entry: ${portablePath}`);
      }
    }
  }

  await walk(modulesRoot);
  return {
    digest: `sha256:${hash.digest('hex')}`,
    fileCount,
    directoryCount,
    totalBytes,
    symlinkCount,
  };
}

async function importInstalledPackage(modulesRoot, name) {
  const packageDirectory = path.join(modulesRoot, ...name.split('/'));
  const metadata = await readJsonFile(path.join(packageDirectory, 'package.json'), `runtime capability ${name}`);
  const main = typeof metadata.main === 'string' && metadata.main.length > 0 ? metadata.main : 'index.js';
  return import(pathToFileURL(path.join(packageDirectory, main)).href);
}

async function smokeRuntimeCapabilities(modulesRoot) {
  const landlock = await importInstalledPackage(modulesRoot, '@deepseek-ai/node-addon-landlock-run');
  if (typeof landlock.probe !== 'function' || await landlock.probe() !== 'full'
      || typeof landlock.launcherPath !== 'function') {
    throw new Error('Landlock runtime capability is unavailable or degraded.');
  }
  const landlockLauncher = landlock.launcherPath();
  if (typeof landlockLauncher !== 'string' || landlockLauncher.length === 0) {
    throw new Error('Landlock launcher path is invalid.');
  }
  await access(landlockLauncher, constants.X_OK);

  const sharpModule = await importInstalledPackage(modulesRoot, 'sharp');
  const sharp = sharpModule.default;
  if (typeof sharp !== 'function') throw new Error('Sharp native runtime did not load.');
  const sharpMetadata = await sharp({
    create: { width: 1, height: 1, channels: 4, background: '#00000000' },
  }).metadata();
  if (sharpMetadata.width !== 1 || sharpMetadata.height !== 1 || sharpMetadata.channels !== 4) {
    throw new Error('Sharp native runtime smoke test failed.');
  }

  const koffi = await importInstalledPackage(modulesRoot, 'koffi');
  if (!koffi.default || typeof koffi.default !== 'object') throw new Error('Koffi native runtime did not load.');

  const canvas = await importInstalledPackage(modulesRoot, '@napi-rs/canvas');
  if (typeof canvas.createCanvas !== 'function' || canvas.createCanvas(1, 1).width !== 1) {
    throw new Error('Canvas native runtime smoke test failed.');
  }

  const ripgrep = await importInstalledPackage(modulesRoot, '@vscode/ripgrep');
  if (typeof ripgrep.rgPath !== 'string' || ripgrep.rgPath.length === 0) {
    throw new Error('Ripgrep runtime path is unavailable.');
  }
  const ripgrepVersion = execFileSync(ripgrep.rgPath, ['--version'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  }).split(/\r?\n/u)[0];
  if (!/^ripgrep \d+\.\d+\.\d+/u.test(ripgrepVersion)) throw new Error('Ripgrep runtime smoke test failed.');

  const requireBuiltin = await importInstalledPackage(modulesRoot, 'node-addon-require-builtin');
  if (typeof requireBuiltin.requireBuiltin !== 'function') {
    throw new Error('Native built-in loader runtime did not load.');
  }
  return {
    landlock: 'full',
    sharp: true,
    koffi: true,
    canvas: true,
    ripgrep: true,
    requireBuiltin: true,
  };
}

export async function validateRuntimeDependencies(rootInput = DEFAULT_ROOT, options = {}) {
  const mode = options.mode ?? 'installed';
  const smoke = options.smoke === true;
  if (!['source', 'installed'].includes(mode) || (mode === 'source' && smoke)) {
    throw new Error('Runtime dependency validation mode is invalid.');
  }
  const root = path.resolve(rootInput);
  const stat = await lstat(root).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error('Runtime dependency root must be a real no-follow directory.');
  }
  const packageJson = await readJsonFile(path.join(root, 'package.json'), 'runtime package.json');
  const sourceLock = await readJsonFile(path.join(root, 'package-lock.json'), 'runtime package-lock.json');
  if (packageJson.private !== true || sourceLock.lockfileVersion !== 3 || !sourceLock.packages?.['']) {
    throw new Error('Runtime dependency lock schema is invalid.');
  }
  const sourceRoot = sourceLock.packages[''];
  if (sourceRoot.hasInstallScript === true
      || ['scripts', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'workspaces']
        .some((field) => sourceRoot[field] !== undefined)) {
    throw new Error('Runtime package-lock root contains forbidden lifecycle or dependency fields.');
  }
  const declared = packageJson.dependencies ?? {};
  if (Object.keys(declared).length === 0
      || Object.values(declared).some((version) => typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
      || JSON.stringify(stable(sourceLock.packages[''].dependencies ?? {})) !== JSON.stringify(stable(declared))) {
    throw new Error('Runtime package declarations must be exact and match the lock root.');
  }

  const sourceEntries = Object.entries(sourceLock.packages).filter(([key]) => key.startsWith('node_modules/'));
  const sourceByKey = new Map(sourceEntries.map(([key, entry]) => [key, packageBinding(entry, key, sourceLock.packages)]));
  const requiredClosure = packageClosure(sourceLock.packages, false);
  const fullClosure = packageClosure(sourceLock.packages, true);
  if (fullClosure.size !== sourceEntries.length || sourceEntries.some(([key]) => !fullClosure.has(key))) {
    throw new Error('Reviewed package lock contains entries outside the declared dependency closure.');
  }
  const approvedInstallScripts = validateInstallScriptPolicy(packageJson, sourceLock.packages, fullClosure);
  const runtimePolicy = validateRuntimePolicy(packageJson, sourceLock.packages, fullClosure);
  const sourceDigestInput = {
    declared,
    approvedInstallScripts,
    runtimePolicy,
    source: [...sourceByKey]
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => a.key.localeCompare(b.key, 'en')),
    required: [...requiredClosure].sort((a, b) => a.localeCompare(b, 'en')),
    full: [...fullClosure].sort((a, b) => a.localeCompare(b, 'en')),
  };
  if (mode === 'source') {
    return {
      ok: true,
      schemaVersion: 3,
      mode: 'source',
      sourcePackageCount: sourceEntries.length,
      requiredPackageCount: requiredClosure.size,
      directDependencies: stable(declared),
      approvedInstallScripts,
      runtimePolicy,
      digest: digest(sourceDigestInput),
    };
  }

  const installedLock = await readJsonFile(path.join(root, 'node_modules', '.package-lock.json'), 'installed hidden package lock');
  if (installedLock.lockfileVersion !== 3 || !installedLock.packages) {
    throw new Error('Installed runtime dependency lock schema is invalid.');
  }
  const installedEntries = Object.entries(installedLock.packages)
    .filter(([key]) => key.startsWith('node_modules/'))
    .map(([key, entry]) => [key, packageBinding(entry, key, installedLock.packages)]);
  const installedByKey = new Map(installedEntries);
  for (const [key, binding] of installedEntries) {
    const source = sourceByKey.get(key);
    if (!source || JSON.stringify(source) !== JSON.stringify(binding)) {
      throw new Error(`Installed lock drifted from the reviewed lock: ${key}`);
    }
  }
  for (const key of requiredClosure) {
    if (!installedByKey.has(key)) throw new Error(`Installed tree omits required runtime dependency: ${key}`);
  }
  for (const { key, version } of runtimePolicy.requiredOptionalPackages) {
    if (!installedByKey.has(key) || installedByKey.get(key).version !== version) {
      throw new Error(`Installed tree omits required platform-optional runtime dependency: ${key}`);
    }
  }
  const omittedOptional = sourceEntries
    .filter(([key, entry]) => !installedByKey.has(key) && !requiredClosure.has(key) && entry.optional === true)
    .map(([key]) => key)
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (sourceEntries.length !== installedEntries.length + omittedOptional.length) {
    throw new Error('Only lock-declared optional packages may be absent from the installed tree.');
  }
  for (const name of Object.keys(declared)) {
    const key = `node_modules/${name}`;
    if (!installedByKey.has(key) || installedByKey.get(key).version !== declared[name]) {
      throw new Error(`Direct runtime dependency is missing or drifted: ${name}`);
    }
  }

  const actual = await installedPackageKeys(path.join(root, 'node_modules'));
  for (const item of actual) {
    const locked = installedByKey.get(item.key);
    if (!locked || locked.version !== item.version || item.name !== packageNameFromKey(item.key)) {
      throw new Error(`Installed package content is not bound by the hidden lock: ${item.key}`);
    }
  }
  if (actual.length !== installedEntries.length) throw new Error('Installed package inventory and hidden lock have different cardinality.');

  const tree = await installedTreeReceipt(path.join(root, 'node_modules'));
  const capabilities = smoke ? await smokeRuntimeCapabilities(path.join(root, 'node_modules')) : null;
  const receipt = {
    ok: true,
    schemaVersion: 3,
    mode: 'installed',
    packageCount: actual.length,
    sourcePackageCount: sourceEntries.length,
    requiredPackageCount: requiredClosure.size,
    omittedOptionalCount: omittedOptional.length,
    directDependencies: stable(declared),
    approvedInstallScripts,
    runtimePolicy,
    capabilities,
    tree,
    digest: digest({
      sourcePolicy: sourceDigestInput,
      installed: installedEntries.map(([key, value]) => ({ key, ...value })).sort((a, b) => a.key.localeCompare(b.key, 'en')),
      omittedOptional,
      actual: actual.sort((a, b) => a.key.localeCompare(b.key, 'en')),
      capabilities,
      tree,
    }),
  };
  return receipt;
}

async function main(argv) {
  let root = DEFAULT_ROOT;
  let json = false;
  let mode = 'installed';
  let smoke = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') root = argv[++index];
    else if (argv[index] === '--json') json = true;
    else if (argv[index] === '--mode') mode = argv[++index];
    else if (argv[index] === '--smoke') smoke = true;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  const receipt = await validateRuntimeDependencies(root, { mode, smoke });
  const count = receipt.packageCount ?? receipt.sourcePackageCount;
  process.stdout.write(json ? `${JSON.stringify(receipt)}\n` : `PASS runtime dependencies (${mode}): ${count} packages, ${receipt.digest}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`runtime-dependency-validation: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}
