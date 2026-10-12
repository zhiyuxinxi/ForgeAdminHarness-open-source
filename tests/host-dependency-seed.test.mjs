import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

import {
  createDependencySeedManifest, DependencySeedError, dependencySeedInputs,
  dependencySeedToolchains, restoreDependencySeed, verifyDependencySeed, createReadOnlyMavenResolver,
  dependencySeedPolicyTransition,
} from '../docker/harness/host-dependency-seed.mjs';
import { validateHostProfilePolicyTransition } from '../docker/harness/host-verify-policy.mjs';
import { VERIFY_PROFILE_NAMES } from '../docker/harness/verify-policy.mjs';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const inventory = { head: '1'.repeat(40), files: [
  { relative: 'forge-server/pom.xml', sha256: sha('pom') },
  { relative: 'forge-admin-ui/pnpm-lock.yaml', sha256: sha('lock') },
  { relative: 'forge-admin-ui/package.json', sha256: sha('package') },
] };
const toolchain = { javaHome: '/temporary/jdk', executables: {
  java: { version: 'openjdk version "17.0.16" 2025-07-15 | OpenJDK Runtime Environment', resolvedPath: '/tmp/jdk/bin/java' },
  maven: { version: 'Apache Maven 3.8.7 | Maven home: /tmp/maven | Java version: 17.0.16' },
  node: { version: 'v22.23.2' }, pnpm: { version: '11.7.0' }, forgeGovernance: { version: 'r-old' },
} };
const settings = sha('fixed non-secret Maven settings');

async function writableTree(root) {
  const metadata = await lstat(root).catch(() => null);
  if (!metadata || metadata.isSymbolicLink()) return;
  await chmod(root, metadata.isDirectory() ? 0o700 : 0o600);
  if (metadata.isDirectory()) for (const name of await readdir(root)) await writableTree(path.join(root, name));
}

async function readonlyTree(root) {
  const metadata = await lstat(root);
  if (metadata.isDirectory()) for (const name of await readdir(root)) await readonlyTree(path.join(root, name));
  await chmod(root, metadata.isDirectory() ? 0o555 : 0o444);
}

const executablePath = `pnpm/store/v10/files/ab/${'c'.repeat(126)}-exec`;

async function fixture(t, executable = false, seedToolchain = toolchain) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'forge-host-seed-'));
  t.after(async () => { await writableTree(base); await rm(base, { recursive: true, force: true }); });
  const root = path.join(base, 'seed');
  const cacheRoot = path.join(base, 'task-cache');
  await mkdir(path.join(root, 'm2', 'repository', 'org', 'example'), { recursive: true });
  await mkdir(path.join(root, 'pnpm', 'store', 'v10', 'files'), { recursive: true });
  await writeFile(path.join(root, 'm2', 'repository', 'org', 'example', 'sample.jar'), 'trusted Maven bytes');
  await writeFile(path.join(root, 'pnpm', 'store', 'v10', 'files', 'package'), 'trusted pnpm bytes');
  if (executable) {
    await mkdir(path.dirname(path.join(root, executablePath)), { recursive: true });
    await writeFile(path.join(root, executablePath), '#!/bin/sh\nprintf "seed-executable-ok"\n');
  }
  const create = (overrides = {}) => createDependencySeedManifest({ root, projectSlug: 'forge-base',
    sourceHead: inventory.head, inventory, toolchain: seedToolchain, mavenSettingsSha256: settings, ...overrides });
  const manifest = await create();
  const encoded = `${JSON.stringify(manifest)}\n`;
  await writeFile(path.join(root, 'manifest.json'), encoded);
  await readonlyTree(root);
  const binding = { root, manifestSha256: sha(encoded) };
  const restore = (overrides = {}) => restoreDependencySeed({ binding, projectSlug: 'forge-base', inventory,
    toolchain: seedToolchain, mavenSettingsSha256: settings, cacheRoot, ...overrides });
  return { base, root, cacheRoot, binding, manifest, create, restore };
}

function seedInvalid(error) {
  return error instanceof DependencySeedError && error.code === 'HOST_DEPENDENCY_SEED_INVALID';
}

test('append-only seed reuse proves complete retained entries and rejects changed or removed files', async t => {
  for (const scenario of ['append', 'changed', 'removed', 'settings']) await t.test(scenario, async sub => {
    const f = await fixture(sub);
    const next = structuredClone(f.manifest);
    if (scenario === 'changed') next.files[0].sha256 = sha('different old bytes');
    if (scenario === 'removed') next.files.shift();
    if (scenario === 'settings') next.mavenSettingsSha256 = sha('different settings');
    next.files.push({ path: 'm2/repository/new/new.jar', bytes: 1, sha256: sha('x') });
    next.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    next.packDigest = sha(JSON.stringify(next.files));
    const nextRoot = path.join(f.base, 'next'); await mkdir(nextRoot);
    const bytes = `${JSON.stringify(next)}\n`; await writeFile(path.join(nextRoot, 'manifest.json'), bytes); await readonlyTree(nextRoot);
    const binding = { root: nextRoot, manifestSha256: sha(bytes) };
    const descriptor = { policyRevision: 'forge-host-verify-policy/v7', profileCatalogVersion: '2026.09.03.22',
      profiles: [...VERIFY_PROFILE_NAMES], processIsolation: 'bubblewrap/v1', dependencySeed: binding.manifestSha256 };
    const oldDigest = sha(JSON.stringify({ ...descriptor, dependencySeed: f.binding.manifestSha256 }));
    const operation = () => dependencySeedPolicyTransition({ binding, descriptor, previousDigest: oldDigest, projectSlug: 'forge-base' });
    if (scenario !== 'append') return assert.rejects(operation(), seedInvalid);
    const proof = await operation();
    assert.equal(proof.dependencySeedTransition.retainedFileCount, f.manifest.files.length);
    assert.deepEqual(proof.dependencySeedTransition.addedFiles, [next.files.find(x => x.path.endsWith('new.jar'))]);
    assert.equal(validateHostProfilePolicyTransition(proof, oldDigest, sha(JSON.stringify(descriptor)), 'backend-test-class', 'forge-base'), proof);
    const forged = structuredClone(proof); forged.preparedDependencies = 'f'.repeat(64);
    assert.throws(() => validateHostProfilePolicyTransition(forged, oldDigest, sha(JSON.stringify(descriptor)), 'backend-test-class', 'forge-base'));
  });
});

test('Maven directly reuses a protected repository across new tasks without populating a private cache', async (t) => {
  const { root, cacheRoot, binding } = await fixture(t);
  const resolve = createReadOnlyMavenResolver();
  const options = { binding, projectSlug: 'forge-base', inventory, toolchain, mavenSettingsSha256: settings };
  const first = await resolve(options), next = await resolve(options);
  assert.deepEqual(next, first);
  assert.equal(first.root, path.join(root, 'm2', 'repository'));
  assert.equal(first.source, 'server-preinstalled');
  await assert.rejects(lstat(cacheRoot), { code: 'ENOENT' });
  const changed = structuredClone(inventory); changed.files[0].sha256 = 'f'.repeat(64);
  const partial = await resolve({ ...options, inventory: changed });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.inputsChanged, true);
  assert.deepEqual(partial.reasons, ['inputs']);
  assert.equal(partial.root, first.root);
  assert.notEqual(partial.preparedInputsDigest, partial.currentInputsDigest);
  assert.equal((await verifyDependencySeed({ ...options, inventory: changed, groups: ['m2'] })).status, 'incompatible');
  assert.equal((await restoreDependencySeed({ ...options, inventory: changed, groups: ['m2'], cacheRoot })).status, 'incompatible');
  const file = path.join(root, 'm2', 'repository', 'org', 'example', 'sample.jar');
  await chmod(file, 0o600); await writeFile(file, 'changed'); await chmod(file, 0o444);
  await assert.rejects(createReadOnlyMavenResolver()(options), seedInvalid);
});

test('Maven startup preparation fills only its same-process payload cache and retains task compatibility checks', async (t) => {
  const { root, cacheRoot, binding } = await fixture(t);
  const resolve = createReadOnlyMavenResolver();
  assert.equal((await resolve.prepare({ binding, projectSlug: 'forge-base' })).status, 'ready');
  const options = { binding, projectSlug: 'forge-base', inventory, toolchain, mavenSettingsSha256: settings };
  const changed = structuredClone(inventory); changed.files[0].sha256 = 'f'.repeat(64);
  assert.equal((await resolve({ ...options, inventory: changed })).status, 'partial');
  assert.equal((await resolve({ ...options, mavenSettingsSha256: 'f'.repeat(64) })).status, 'incompatible');
  const changedTools = structuredClone(toolchain); changedTools.executables.node.version = 'v24.0.0';
  assert.equal((await resolve({ ...options, toolchain: changedTools })).status, 'ready');
  await assert.rejects(resolve.prepare({ binding, projectSlug: 'other-project' }), seedInvalid);
  const file = path.join(root, 'm2/repository/org/example/sample.jar');
  // Fixture-only mutation proves a cache hit; a fresh resolver must rescan and reject it.
  await chmod(file, 0o600); await writeFile(file, 'changed after startup'); await chmod(file, 0o444);
  assert.equal((await resolve(options)).status, 'ready');
  await assert.rejects(createReadOnlyMavenResolver().prepare({ binding, projectSlug: 'forge-base' }), seedInvalid);
  await assert.rejects(lstat(cacheRoot), { code: 'ENOENT' });
});

test('Maven seed reuses the same Java feature patch without replacing its bound manifest or repository', async (t) => {
  const originalTools = structuredClone(toolchain);
  originalTools.executables.java.version = 'openjdk version "17.0.20" 2026-07-21';
  const value = await fixture(t, false, originalTools);
  const patchedTools = structuredClone(originalTools);
  patchedTools.executables.java.version = 'openjdk version "17.0.20.1" 2026-08-18';
  patchedTools.executables.maven.version = 'Apache Maven 3.8.7 | Java version: 17.0.20.1';
  const options = { binding: value.binding, projectSlug: 'forge-base', inventory,
    toolchain: patchedTools, mavenSettingsSha256: settings };
  const manifestBefore = await readFile(path.join(value.root, 'manifest.json'));
  const artifact = path.join(value.root, 'm2/repository/org/example/sample.jar');
  const artifactBefore = await readFile(artifact);
  const resolve = createReadOnlyMavenResolver();
  await resolve.prepare({ binding: value.binding, projectSlug: 'forge-base' });
  const reused = await resolve(options);
  assert.equal(reused.status, 'ready');
  assert.equal(reused.root, path.join(value.root, 'm2/repository'));
  assert.equal(reused.source, 'server-preinstalled');
  await assert.rejects(lstat(value.cacheRoot), { code: 'ENOENT' });
  const verified = await verifyDependencySeed({ ...options, groups: ['m2'] });
  assert.equal(verified.status, 'ready');
  assert.equal(verified.fileCount, 1);
  assert.deepEqual(verified.manifest, value.manifest);
  // The fallback must apply the same compatibility rule to an existing cache.
  const existing = path.join(value.cacheRoot, 'm2/repository/retained.jar');
  await mkdir(path.dirname(existing), { recursive: true });
  await writeFile(existing, 'already available task-local bytes');
  const restored = await value.restore({ toolchain: patchedTools, groups: ['m2'] });
  assert.equal(restored.status, 'ready');
  assert.deepEqual(restored.restored, []);
  assert.deepEqual(restored.preserved, ['m2']);
  assert.equal(await readFile(existing, 'utf8'), 'already available task-local bytes');
  assert.deepEqual(await readFile(path.join(value.root, 'manifest.json')), manifestBefore);
  assert.equal(sha(manifestBefore), value.binding.manifestSha256);
  assert.deepEqual(await readFile(artifact), artifactBefore);
  await assert.rejects(lstat(path.join(value.cacheRoot, 'm2/repository/org/example/sample.jar')), { code: 'ENOENT' });
});

test('Maven Java patch compatibility keeps Maven toolchains and combined groups strict', async (t) => {
  const value = await fixture(t);
  const options = { binding: value.binding, projectSlug: 'forge-base', inventory,
    toolchain, mavenSettingsSha256: settings };
  for (const [name, java, other] of [
    ['different Java feature', '21.0.1'],
    ['unknown Java version', 'future'],
    ['early access Java', '17-ea'],
    ['changed Maven', '17.0.16.1', ['maven', 'Apache Maven 3.9.9']],
  ]) {
    await t.test(name, async () => {
      const changed = structuredClone(toolchain);
      changed.executables.java.version = `openjdk version "${java}"`;
      if (other) changed.executables[other[0]].version = other[1];
      for (const result of [await createReadOnlyMavenResolver()({ ...options, toolchain: changed }),
        await verifyDependencySeed({ ...options, toolchain: changed, groups: ['m2'] }),
        await value.restore({ toolchain: changed, groups: ['m2'] })]) {
        assert.equal(result.status, 'incompatible');
        assert.deepEqual(result.reasons, ['toolchains']);
      }
    });
  }
  const patched = structuredClone(toolchain);
  patched.executables.java.version = 'openjdk version "17.0.16.1"';
  for (const groups of [['m2', 'pnpm']]) {
    assert.equal((await value.restore({ toolchain: patched, groups })).status, 'incompatible');
    assert.equal((await verifyDependencySeed({ ...options, toolchain: patched, groups })).status, 'incompatible');
  }
  await assert.rejects(lstat(value.cacheRoot), { code: 'ENOENT' });
});

test('dependency seed compatibility follows the selected ecosystem without changing the protected manifest', async (t) => {
  const value = await fixture(t);
  const options = { binding: value.binding, projectSlug: 'forge-base', inventory,
    toolchain, mavenSettingsSha256: settings };
  const originalManifest = await readFile(path.join(value.root, 'manifest.json'));
  const frontendChanges = structuredClone(inventory);
  frontendChanges.files[1].sha256 = sha('new frontend lock');
  frontendChanges.files.push({ relative: 'forge-h5-ui/package.json', sha256: sha('new frontend') });
  const frontendTools = structuredClone(toolchain);
  frontendTools.executables.node.version = 'v24.0.0';
  frontendTools.executables.pnpm.version = '12.0.0';
  const maven = await createReadOnlyMavenResolver()({ ...options, inventory: frontendChanges, toolchain: frontendTools });
  assert.equal(maven.status, 'ready');
  assert.equal(maven.root, path.join(value.root, 'm2/repository'));
  assert.equal((await verifyDependencySeed({ ...options, inventory: frontendChanges, toolchain: frontendTools,
    groups: ['m2', 'pnpm'] })).status, 'incompatible');
  const backendChanges = structuredClone(inventory);
  backendChanges.files[0].sha256 = sha('new backend pom');
  const backendTools = structuredClone(toolchain);
  backendTools.executables.java.version = 'openjdk version "21.0.1"';
  backendTools.executables.maven.version = 'Apache Maven 3.9.9';
  assert.equal((await verifyDependencySeed({ ...options, inventory: backendChanges, toolchain: backendTools,
    mavenSettingsSha256: sha('new Maven policy'), groups: ['pnpm'] })).status, 'ready');
  for (const change of [
    { relative: 'forge-server/pom.xml', sha256: sha('new version') },
    { relative: 'forge-server/pom.xml', deleted: true },
    { relative: '.mvn/maven.config', sha256: sha('new configuration') },
    { relative: 'forge-server/module/pom.xml', sha256: sha('new module') },
  ]) {
    const changed = { ...inventory, files: inventory.files.filter((entry) => entry.relative !== change.relative).concat(change) };
    assert.deepEqual((await createReadOnlyMavenResolver()({ ...options, inventory: changed })).reasons, ['inputs']);
  }
  assert.deepEqual(await readFile(path.join(value.root, 'manifest.json')), originalManifest);
  await assert.rejects(lstat(value.cacheRoot), { code: 'ENOENT' });
});

test('failed Maven startup preparation cannot become a cached success', async (t) => {
  const { root, binding } = await fixture(t);
  const file = path.join(root, 'm2/repository/org/example/sample.jar');
  const original = await readFile(file);
  await chmod(file, 0o600); await writeFile(file, 'changed'); await chmod(file, 0o444);
  const resolve = createReadOnlyMavenResolver();
  await assert.rejects(resolve.prepare({ binding, projectSlug: 'forge-base' }), seedInvalid);
  await chmod(file, 0o600); await writeFile(file, original); await chmod(file, 0o444);
  assert.equal((await resolve.prepare({ binding, projectSlug: 'forge-base' })).status, 'ready');
});

test('legacy pnpm executables regain execution in new and existing private caches without changing bytes',
  { skip: process.platform === 'win32' }, async (t) => {
    const value = await fixture(t, true);
    const file = path.join(value.cacheRoot, executablePath);
    assert.equal((await lstat(path.join(value.root, executablePath))).mode & 0o111, 0);
    await value.restore({ groups: ['pnpm'] });
    assert.equal((await lstat(file)).mode & 0o777, 0o700);
    const { execFileSync } = await import('node:child_process');
    assert.equal(execFileSync(file, { encoding: 'utf8' }), 'seed-executable-ok');
    await chmod(file, 0o600);
    assert.deepEqual((await value.restore({ groups: ['pnpm'] })).preserved, ['pnpm']);
    assert.equal(execFileSync(file, { encoding: 'utf8' }), 'seed-executable-ok');
    assert.equal((await lstat(path.join(value.cacheRoot, 'pnpm/store/v10/files/package'))).mode & 0o111, 0);
    await chmod(file, 0o600);
    await writeFile(file, 'untrusted replacement');
    await value.restore({ groups: ['pnpm'] });
    assert.equal((await lstat(file)).mode & 0o111, 0, 'changed bytes are never granted execution');
    assert.equal(await readFile(file, 'utf8'), 'untrusted replacement');
  });

test('restore selects only the consumer cache and later seeds the other without replacing existing bytes', async (t) => {
  const value = await fixture(t);
  const maven = await value.restore({ groups: ['m2'] });
  assert.deepEqual(maven.restored, ['m2']);
  assert.deepEqual(maven.verifiedGroups, ['m2']);
  assert.equal(maven.payloadVerified, false, 'a selected group is not a claim about the whole payload');
  await assert.rejects(lstat(path.join(value.cacheRoot, 'pnpm')), { code: 'ENOENT' });
  const file = path.join(value.cacheRoot, 'm2', 'repository', 'org', 'example', 'sample.jar');
  await writeFile(file, 'private existing bytes');
  assert.deepEqual((await value.restore({ groups: ['pnpm'] })).restored, ['pnpm']);
  assert.equal(await readFile(file, 'utf8'), 'private existing bytes');
  assert.deepEqual((await value.restore({ groups: ['m2'] })).preserved, ['m2']);
  await assert.rejects(value.restore({ groups: ['../other'] }), seedInvalid);
});

test('dependency inputs include nested package, Maven configuration, patches and deletions in canonical order', () => {
  const paths = ['pom.xml', '.mvn/maven.config', '.mvn/wrapper/maven-wrapper.properties', 'nested/settings.xml',
    'nested/package.json', 'nested/pnpm-lock.yaml', 'nested/pnpm-workspace.yaml', 'nested/.npmrc',
    'nested/.pnpmfile.cjs', 'nested/patches/pkg.patch', 'mvnw', 'mvnw.cmd'];
  const files = paths.map((relative) => ({ relative, sha256: sha(relative) }));
  files.push({ relative: 'deleted/pom.xml', deleted: true }, { relative: 'src/app.java', sha256: sha('business') });
  const result = dependencySeedInputs({ files });
  assert.equal(result.length, paths.length + 1);
  assert.deepEqual(result, dependencySeedInputs({ files: [...files].reverse() }));
  assert.deepEqual(result.find((entry) => entry.path === 'deleted/pom.xml'), { path: 'deleted/pom.xml', deleted: true });
  assert.throws(() => dependencySeedInputs({ files: [{ relative: '../pom.xml', sha256: sha('x') }] }), seedInvalid);
  assert.throws(() => dependencySeedInputs({ files: [...files, files[0]] }), seedInvalid);
});

test('stable toolchain identity excludes installation paths, governance and probe metadata', () => {
  const altered = structuredClone(toolchain);
  altered.javaHome = '/another/temporary/root';
  altered.executables.java.resolvedPath = '/another/java';
  altered.executables.maven.version = 'Apache Maven 3.8.7 | Maven home: /another/maven | Java version: 17.0.16';
  altered.executables.forgeGovernance.version = 'r-new';
  assert.deepEqual(dependencySeedToolchains(toolchain), dependencySeedToolchains(altered));
  assert.deepEqual(dependencySeedToolchains(toolchain), { platform: process.platform, arch: process.arch,
    java: '17.0.16', maven: '3.8.7', node: '22.23.2', pnpm: '11.7.0' });
  assert.throws(() => dependencySeedToolchains({ executables: {} }), seedInvalid);
});

test('restore creates writable, isolated private copies without hard links', async (t) => {
  const value = await fixture(t);
  const result = await value.restore();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.restored, ['m2', 'pnpm']);
  const relative = path.join('m2', 'repository', 'org', 'example', 'sample.jar');
  const source = path.join(value.root, relative);
  const copy = path.join(value.cacheRoot, relative);
  assert.equal((await lstat(copy)).nlink, 1);
  assert.equal((await lstat(source)).nlink, 1);
  if (process.platform !== 'win32') assert.equal((await lstat(copy)).mode & 0o200, 0o200);
  await writeFile(copy, 'task-local modified dependency');
  assert.equal(await readFile(source, 'utf8'), 'trusted Maven bytes');
  const other = path.join(value.base, 'another-task-cache');
  await value.restore({ cacheRoot: other });
  assert.equal(await readFile(path.join(other, relative), 'utf8'), 'trusted Maven bytes');
});

test('standalone verification hashes payloads against external identity without creating a cache', async (t) => {
  const value = await fixture(t);
  const options = { binding: value.binding, projectSlug: 'forge-base', inventory, toolchain, mavenSettingsSha256: settings };
  const verified = await verifyDependencySeed(options);
  assert.equal(verified.status, 'ready');
  assert.equal(verified.fileCount, 2);
  assert.equal(verified.payloadVerified, true);
  assert.equal(verified.packDigest, value.manifest.packDigest);
  assert.deepEqual(verified.manifest, value.manifest);
  assert.equal(await lstat(value.cacheRoot).catch(() => null), null);
  const mismatch = await verifyDependencySeed({ ...options, projectSlug: 'wrong-project' });
  assert.equal(mismatch.status, 'incompatible');
  const file = path.join(value.root, 'm2', 'repository', 'org', 'example', 'sample.jar');
  await chmod(file, 0o600);
  await writeFile(file, 'tamper');
  await chmod(file, 0o444);
  await assert.rejects(verifyDependencySeed(options), seedInvalid);
});

test('manifest binding and payload tampering fail closed before either group is published', async (t) => {
  const value = await fixture(t);
  await assert.rejects(value.restore({ binding: { ...value.binding, manifestSha256: '0'.repeat(64) } }), seedInvalid);
  const file = path.join(value.root, 'pnpm', 'store', 'v10', 'files', 'package');
  await chmod(file, 0o600);
  await writeFile(file, 'tampered pnpm bytes');
  await chmod(file, 0o444);
  await assert.rejects(value.restore(), seedInvalid);
  assert.equal(await lstat(path.join(value.cacheRoot, 'm2')).catch(() => null), null);
});

test('input, tool version, project or settings mismatch returns incompatible without creating caches', async (t) => {
  const value = await fixture(t);
  const changed = structuredClone(inventory);
  changed.files[0].sha256 = sha('changed pom');
  const changedTools = structuredClone(toolchain);
  changedTools.executables.maven.version = 'Apache Maven 3.9.9';
  for (const [override, reason] of [[{ inventory: changed }, 'inputs'], [{ toolchain: changedTools }, 'toolchains'],
    [{ projectSlug: 'other-project' }, 'project'], [{ mavenSettingsSha256: sha('other settings') }, 'maven-settings']]) {
    const result = await value.restore(override);
    assert.equal(result.status, 'incompatible');
    assert.deepEqual(result.reasons, [reason]);
  }
  assert.equal(await lstat(value.cacheRoot).catch(() => null), null);
  assert.equal((await value.restore({ binding: undefined })).status, 'unavailable');
});

test('pnpm input changes reuse verified private package bytes as partial without claiming an installed tree', async (t) => {
  const value = await fixture(t);
  const changed = structuredClone(inventory);
  changed.files.find((entry) => entry.relative.endsWith('package.json')).sha256 = sha('add vue-i18n');
  changed.files.find((entry) => entry.relative.endsWith('pnpm-lock.yaml')).sha256 = sha('new frozen lock');
  const result = await value.restore({ inventory: changed, groups: ['pnpm'] });
  assert.equal(result.status, 'partial');
  assert.equal(result.inputsChanged, true);
  assert.deepEqual(result.reasons, ['inputs']);
  assert.notEqual(result.preparedInputsDigest, result.currentInputsDigest);
  assert.deepEqual(result.restored, ['pnpm']);
  assert.deepEqual(result.verifiedGroups, ['pnpm']);
  assert.equal(await readFile(path.join(value.cacheRoot, 'pnpm/store/v10/files/package'), 'utf8'), 'trusted pnpm bytes');
  await assert.rejects(lstat(path.join(value.cacheRoot, 'm2')), { code: 'ENOENT' });
  const preserved = await value.restore({ inventory: changed, groups: ['pnpm'] });
  assert.equal(preserved.status, 'partial');
  assert.deepEqual(preserved.preserved, ['pnpm']);
  assert.equal((await value.restore({ inventory: changed })).status, 'incompatible', 'combined complete-seed checks remain strict');
  assert.equal((await verifyDependencySeed({ binding: value.binding, projectSlug: 'forge-base', inventory: changed,
    toolchain, mavenSettingsSha256: settings, groups: ['pnpm'] })).status, 'incompatible', 'standalone complete verification remains strict');
});

test('partial pnpm reuse still rejects tool, project, bound-manifest and payload changes', async (t) => {
  const value = await fixture(t);
  const changed = structuredClone(inventory); changed.files[1].sha256 = sha('new lock');
  const changedTools = structuredClone(toolchain); changedTools.executables.pnpm.version = '12.0.0';
  for (const override of [{ toolchain: changedTools }, { projectSlug: 'another-project' }]) {
    assert.equal((await value.restore({ ...override, inventory: changed, groups: ['pnpm'] })).status, 'incompatible');
  }
  await assert.rejects(value.restore({ inventory: changed, groups: ['pnpm'],
    binding: { ...value.binding, manifestSha256: sha('wrong manifest') } }), seedInvalid);
  const file = path.join(value.root, 'pnpm/store/v10/files/package');
  await chmod(file, 0o600); await writeFile(file, 'tampered pnpm bytes'); await chmod(file, 0o444);
  await assert.rejects(value.restore({ inventory: changed, groups: ['pnpm'] }), seedInvalid);
  await assert.rejects(lstat(path.join(value.cacheRoot, 'pnpm')), { code: 'ENOENT' });
});

test('existing groups are preserved and repeated jobs do not rehash unused seed payloads', async (t) => {
  const value = await fixture(t);
  await mkdir(path.join(value.cacheRoot, 'm2'), { recursive: true });
  await writeFile(path.join(value.cacheRoot, 'm2', 'mine'), 'existing');
  const first = await value.restore();
  assert.deepEqual(first.preserved, ['m2']);
  assert.deepEqual(first.restored, ['pnpm']);
  assert.equal(await readFile(path.join(value.cacheRoot, 'm2', 'mine'), 'utf8'), 'existing');
  const payload = path.join(value.root, 'm2', 'repository', 'org', 'example', 'sample.jar');
  await chmod(payload, 0o600);
  await writeFile(payload, 'unused seed content changed');
  await chmod(payload, 0o444);
  const second = await value.restore();
  assert.deepEqual(second.preserved, ['m2', 'pnpm']);
  assert.deepEqual(second.restored, []);
  assert.equal(second.payloadVerified, false, 'preserving writable caches makes no seed/cache verification claim');
});

test('concurrent restores publish each group once and never overwrite the winner', async (t) => {
  const value = await fixture(t);
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => value.restore()));
  const errors = attempts.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (errors.length) throw errors[0];
  const results = attempts.map((result) => result.value);
  for (const group of ['m2', 'pnpm']) {
    assert.equal(results.filter((result) => result.restored.includes(group)).length, 1);
    assert.ok((await lstat(path.join(value.cacheRoot, group))).isDirectory());
  }
  assert.ok(results.every((result) => ['ready', 'busy'].includes(result.status)));
  assert.deepEqual((await readdir(value.cacheRoot)).sort(), ['m2', 'pnpm']);
});

test('restore preserves a winner that publishes and releases its lock before inspection', async t => {
  const value = await fixture(t);
  const lock = path.join(value.cacheRoot, '.dependency-seed-m2.lock');
  await mkdir(lock, { recursive: true });
  const originalLstat = fsPromises.lstat;
  let released = 0;
  const intercepted = t.mock.method(fsPromises, 'lstat', async (file, ...args) => {
    if (file === lock) {
      released++;
      await mkdir(path.join(value.cacheRoot, 'm2'));
      await writeFile(path.join(value.cacheRoot, 'm2', 'winner'), 'published by another restorer');
      await fsPromises.rmdir(lock);
    }
    return originalLstat(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await value.restore({ groups: ['m2'] });
    assert.equal(released, 1);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.preserved, ['m2']);
    assert.deepEqual(result.restored, []);
    assert.equal(await readFile(path.join(value.cacheRoot, 'm2', 'winner'), 'utf8'), 'published by another restorer');
    assert.deepEqual(await readdir(path.join(value.cacheRoot, 'm2')), ['winner']);
  } finally {
    intercepted.mock.restore();
    syncBuiltinESMExports();
  }
});

test('restore remains pending if a released lock has no published cache', async t => {
  const value = await fixture(t);
  const lock = path.join(value.cacheRoot, '.dependency-seed-m2.lock');
  await mkdir(lock, { recursive: true });
  const originalLstat = fsPromises.lstat;
  const intercepted = t.mock.method(fsPromises, 'lstat', async (file, ...args) => {
    if (file === lock) await fsPromises.rmdir(lock);
    return originalLstat(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await value.restore({ groups: ['m2'] });
    assert.equal(result.status, 'busy');
    assert.deepEqual(result.pending, ['m2']);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.preserved, []);
    assert.deepEqual(await readdir(value.cacheRoot), []);
  } finally {
    intercepted.mock.restore();
    syncBuiltinESMExports();
  }
});

test('restore rejects file and symlink copy locks without changing their targets', async t => {
  const value = await fixture(t);
  const lock = path.join(value.cacheRoot, '.dependency-seed-m2.lock');
  await mkdir(value.cacheRoot);
  await writeFile(lock, 'not a lock directory');
  await assert.rejects(value.restore({ groups: ['m2'] }), seedInvalid);
  assert.equal(await readFile(lock, 'utf8'), 'not a lock directory');
  await rm(lock);
  const outside = path.join(value.base, 'outside-lock');
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'unchanged');
  await symlink(outside, lock, 'junction');
  await assert.rejects(value.restore({ groups: ['m2'] }), seedInvalid);
  assert.equal((await lstat(lock)).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
  assert.deepEqual(await readdir(value.cacheRoot), ['.dependency-seed-m2.lock']);
});

test('operator manifest creation rejects symlink, hardlink and out-of-layout payloads', async (t) => {
  const value = await fixture(t);
  await writableTree(value.root);
  const original = path.join(value.root, 'm2', 'repository', 'org', 'example', 'sample.jar');
  const alias = path.join(value.root, 'm2', 'repository', 'alias.jar');
  await link(original, alias);
  await assert.rejects(value.create(), seedInvalid);
  await rm(alias);
  await symlink(path.join(value.root, 'pnpm'), path.join(value.root, 'm2', 'repository', 'linked'), 'junction');
  await assert.rejects(value.create(), seedInvalid);
  await rm(path.join(value.root, 'm2', 'repository', 'linked'));
  await writeFile(path.join(value.root, 'arbitrary-file'), 'not a package');
  await assert.rejects(value.create(), seedInvalid);
});

test('restore refuses seed hardlinks, destination symlinks and symlink ancestors', async (t) => {
  const value = await fixture(t);
  const target = path.join(value.base, 'outside');
  await mkdir(target);
  await mkdir(value.cacheRoot);
  await symlink(target, path.join(value.cacheRoot, 'm2'), 'junction');
  await assert.rejects(value.restore(), seedInvalid);
  await rm(path.join(value.cacheRoot, 'm2'));
  await symlink(target, path.join(value.base, 'linked-parent'), 'junction');
  await assert.rejects(value.restore({ cacheRoot: path.join(value.base, 'linked-parent', 'cache') }), seedInvalid);
  await link(path.join(value.root, 'm2', 'repository', 'org', 'example', 'sample.jar'), path.join(target, 'hardlink'));
  await assert.rejects(value.restore(), seedInvalid);
  assert.deepEqual(await readdir(value.cacheRoot), []);
});

test('Unix source files and all source directories must be read-only', { skip: process.platform === 'win32' }, async (t) => {
  const value = await fixture(t);
  await chmod(path.join(value.root, 'm2'), 0o755);
  await assert.rejects(value.restore(), seedInvalid);
  await chmod(path.join(value.root, 'm2'), 0o555);
  await chmod(path.join(value.root, 'pnpm', 'store', 'v10', 'files', 'package'), 0o644);
  await assert.rejects(value.restore(), seedInvalid);
});
