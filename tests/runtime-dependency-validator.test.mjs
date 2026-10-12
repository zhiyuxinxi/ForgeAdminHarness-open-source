import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateRuntimeDependencies } from '../docker/harness/validate-runtime-dependencies.mjs';

async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function integrity(byte = 0x41) {
  return `sha512-${Buffer.alloc(64, byte).toString('base64')}`;
}

function binding(version = '1.0.0', integrityValue = integrity()) {
  return {
    version,
    resolved: `https://registry.npmjs.org/alpha/-/alpha-${version}.tgz`,
    integrity: integrityValue,
  };
}

function runtimeSelectors() {
  let libc = 'none';
  if (process.platform === 'linux') {
    const header = process.report?.getReport?.().header ?? {};
    libc = typeof header.glibcVersionRuntime === 'string' && header.glibcVersionRuntime.length > 0
      ? 'glibc'
      : 'musl';
  }
  return { os: [process.platform], cpu: [process.arch], libc: [libc] };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-runtime-lock-'));
  const declared = { alpha: '1.0.0' };
  await json(path.join(root, 'package.json'), {
    name: 'fixture', version: '1.0.0', private: true, description: 'fixture',
    ...runtimeSelectors(),
    forgeRuntimePolicy: { requiredOptionalPackages: {} },
    allowScripts: {}, dependencies: declared,
  });
  await json(path.join(root, 'package-lock.json'), {
    name: 'fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.0.0', dependencies: declared }, 'node_modules/alpha': binding() },
  });
  await json(path.join(root, 'node_modules', '.package-lock.json'), {
    name: 'fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { 'node_modules/alpha': binding() },
  });
  await json(path.join(root, 'node_modules', 'alpha', 'package.json'), { name: 'alpha', version: '1.0.0' });
  await writeFile(path.join(root, 'node_modules', 'alpha', 'index.js'), 'export const reviewed = true;\n');
  return root;
}

test('runtime dependency receipt binds declarations, reviewed lock, installed lock, and actual packages', async () => {
  const root = await fixture();
  try {
    const receipt = await validateRuntimeDependencies(root);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.schemaVersion, 3);
    assert.equal(receipt.packageCount, 1);
    assert.equal(receipt.sourcePackageCount, 1);
    assert.equal(receipt.requiredPackageCount, 1);
    assert.match(receipt.tree.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(receipt.digest, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source policy is enforced before node_modules exists', async () => {
  const root = await fixture();
  try {
    await rm(path.join(root, 'node_modules'), { recursive: true, force: true });
    const receipt = await validateRuntimeDependencies(root, { mode: 'source' });
    assert.equal(receipt.schemaVersion, 3);
    assert.equal(receipt.mode, 'source');
    assert.equal(receipt.sourcePackageCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('root lifecycle scripts are rejected by the pre-install policy', async () => {
  const root = await fixture();
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    packageJson.scripts = { postinstall: 'node leak.js' };
    await json(path.join(root, 'package.json'), packageJson);
    await assert.rejects(
      validateRuntimeDependencies(root, { mode: 'source' }),
      /forbidden root fields/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a required platform-optional package cannot be silently omitted', async () => {
  const root = await fixture();
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    packageJson.forgeRuntimePolicy.requiredOptionalPackages = { 'node_modules/native-alpha': '1.0.0' };
    await json(path.join(root, 'package.json'), packageJson);
    const sourceLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    sourceLock.packages['node_modules/alpha'].optionalDependencies = { 'native-alpha': '1.0.0' };
    sourceLock.packages['node_modules/native-alpha'] = {
      ...binding(),
      resolved: 'https://registry.npmjs.org/native-alpha/-/native-alpha-1.0.0.tgz',
      optional: true,
      os: runtimeSelectors().os,
      cpu: runtimeSelectors().cpu,
      libc: runtimeSelectors().libc,
    };
    await json(path.join(root, 'package-lock.json'), sourceLock);
    await assert.rejects(
      validateRuntimeDependencies(root),
      /omits required platform-optional runtime dependency/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installed integrity drift is rejected even when the package version is unchanged', async () => {
  const root = await fixture();
  try {
    await json(path.join(root, 'node_modules', '.package-lock.json'), {
      name: 'fixture', version: '1.0.0', lockfileVersion: 3,
      packages: { 'node_modules/alpha': binding('1.0.0', integrity(0x42)) },
    });
    await assert.rejects(validateRuntimeDependencies(root), /drifted from the reviewed lock/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a required transitive dependency cannot disappear from the installed closure', async () => {
  const root = await fixture();
  try {
    const sourceLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    sourceLock.packages['node_modules/alpha'].dependencies = { transitive: '1.0.0' };
    sourceLock.packages['node_modules/transitive'] = {
      ...binding(),
      resolved: 'https://registry.npmjs.org/transitive/-/transitive-1.0.0.tgz',
    };
    await json(path.join(root, 'package-lock.json'), sourceLock);
    await assert.rejects(validateRuntimeDependencies(root), /omits required runtime dependency/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installed package content changes are bound into the runtime receipt', async () => {
  const root = await fixture();
  try {
    const before = await validateRuntimeDependencies(root);
    await writeFile(path.join(root, 'node_modules', 'alpha', 'index.js'), 'export const reviewed = false;\n');
    const after = await validateRuntimeDependencies(root);
    assert.notEqual(after.tree.digest, before.tree.digest);
    assert.notEqual(after.digest, before.digest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('npm executable links are containment-checked and bound into the tree digest', async (t) => {
  const root = await fixture();
  try {
    const bin = path.join(root, 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    try {
      await symlink('../alpha/index.js', path.join(bin, 'alpha'), 'file');
    } catch (error) {
      if (error?.code === 'EPERM') { t.skip('Windows symlink privilege unavailable'); return; }
      throw error;
    }
    const safe = await validateRuntimeDependencies(root);
    assert.equal(safe.tree.symlinkCount, 1);
    await rm(path.join(bin, 'alpha'), { force: true });
    await writeFile(path.join(root, 'outside.js'), 'export const escaped = true;\n');
    await symlink('../../outside.js', path.join(bin, 'alpha'), 'file');
    await assert.rejects(
      validateRuntimeDependencies(root),
      /executable link escapes the installed dependency root/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source lock entries require an independently reviewed registry sha512 binding', async () => {
  const root = await fixture();
  try {
    const sourceLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
    delete sourceLock.packages['node_modules/alpha'].integrity;
    await json(path.join(root, 'package-lock.json'), sourceLock);
    await assert.rejects(validateRuntimeDependencies(root), /lacks a registry HTTPS source and sha512 integrity/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('install-script approvals must be exact and version pinned', async () => {
  const root = await fixture();
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    packageJson.allowScripts = { alpha: true };
    await json(path.join(root, 'package.json'), packageJson);
    await assert.rejects(validateRuntimeDependencies(root), /install-script approvals/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('actual package version drift is rejected even when both lock files agree', async () => {
  const root = await fixture();
  try {
    await json(path.join(root, 'node_modules', 'alpha', 'package.json'), { name: 'alpha', version: '9.9.9' });
    await assert.rejects(validateRuntimeDependencies(root), /not bound by the hidden lock/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('linked installed package directories fail closed', async (t) => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'forge-runtime-lock-outside-'));
  try {
    await rm(path.join(root, 'node_modules', 'alpha'), { recursive: true, force: true });
    await json(path.join(outside, 'package.json'), { name: 'alpha', version: '1.0.0' });
    try {
      await symlink(outside, path.join(root, 'node_modules', 'alpha'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error?.code === 'EPERM') { t.skip('Windows symlink privilege unavailable'); return; }
      throw error;
    }
    await assert.rejects(validateRuntimeDependencies(root), /linked or non-directory/u);
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});
