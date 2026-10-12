import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256File, sha256SkillTree } from '../docker/harness/validate-skill-bundle.mjs';

import {
  activateExternalSkillBundle,
  createExternalSkillBundle,
  doctorExternalSkillBundle,
  installExternalSkillBundle,
  rollbackExternalSkillBundle,
  validateExternalSkillBundle,
} from '../scripts/forge-skill-bundle.mjs';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(testRoot, 'fixtures', 'forge-skill-evals', 'valid');
const DSH_VERSION = '0.1.1-rc.2';

test('directly invoked Skill executors survive immutable installation and idempotent activation', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-skill-executor-mode-'));
  try {
    const source = await sourceFixture(root, '2099.09.30.1');
    const skill = path.join(source.skillsRoot, 'fixture-read');
    const skillFile = path.join(skill, 'SKILL.md');
    await writeFile(skillFile, (await readFile(skillFile, 'utf8')) + '\nYou must run `scripts/check.sh`.\n');
    await mkdir(path.join(skill, 'scripts'));
    const script = path.join(skill, 'scripts/check.sh');
    await writeFile(script, '#!/bin/sh\nexit 88\n', { mode: 0o755 });
    const catalog = JSON.parse(await readFile(source.catalogPath, 'utf8'));
    const entry = catalog.skills.find(row => row.name === 'fixture-read');
    entry.contentSha256 = await sha256File(skillFile);
    entry.treeSha256 = await sha256SkillTree(skill);
    await writeFile(source.catalogPath, JSON.stringify(catalog));
    const bundleRoot = path.join(root, 'bundle');
    await createExternalSkillBundle({ sourceSkillsRoot: source.skillsRoot, sourceCatalogPath: source.catalogPath,
      outputRoot: bundleRoot, compatibleDshVersions: [DSH_VERSION] });
    const options = { bundleRoot, installRoot: path.join(root, 'installed'), expectedDshVersion: DSH_VERSION };
    const installed = await installExternalSkillBundle(options);
    // The actual post-install validator must still accept the directly invoked
    // script. No declared executor is run by build/install/activation.
    await validateExternalSkillBundle(installed.target, { expectedDshVersion: DSH_VERSION });
    const installedScript = path.join(installed.target, 'skills/fixture-read/scripts/check.sh');
    assert.equal((await lstat(installedScript)).mode & 0o777, 0o555);
    assert.equal((await lstat(path.join(installed.target, 'skills/fixture-read/SKILL.md'))).mode & 0o777, 0o444);
    assert.equal(await sha256File(installedScript), await sha256File(script));
    assert.equal((await installExternalSkillBundle(options)).idempotent, true);
    await activateExternalSkillBundle({ ...options, version: '2099.09.30.1' });
    assert.equal((await doctorExternalSkillBundle(options)).version, '2099.09.30.1');
    assert.equal((await activateExternalSkillBundle({ ...options, version: '2099.09.30.1' })).idempotent, true);
  } finally { await cleanupRoot(root); }
});

async function cleanupRoot(root) {
  if (process.platform !== 'win32') {
    async function makeWritable(directory) {
      let entries;
      try {
        await chmod(directory, 0o700);
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) if (entry.isDirectory()) await makeWritable(path.join(directory, entry.name));
    }
    await makeWritable(root);
  }
  await rm(root, { recursive: true, force: true });
}

async function sourceFixture(root, version) {
  const source = path.join(root, `source-${version}`);
  await cp(fixtureRoot, source, { recursive: true });
  const catalogPath = path.join(source, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.bundleVersion = version;
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return { source, catalogPath, skillsRoot: path.join(source, 'skills') };
}

async function build(root, version) {
  const source = await sourceFixture(root, version);
  const bundle = path.join(root, `bundle-${version}`);
  await createExternalSkillBundle({
    sourceSkillsRoot: source.skillsRoot,
    sourceCatalogPath: source.catalogPath,
    outputRoot: bundle,
    compatibleDshVersions: [DSH_VERSION],
  });
  return { ...source, bundle };
}

test('external Skill bundle binds every payload file, catalog identity, tree hash, and DSH compatibility', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-external-skills-'));
  try {
    const { bundle } = await build(root, '2099.01.01.1');
    const result = await validateExternalSkillBundle(bundle, { expectedDshVersion: DSH_VERSION });
    assert.equal(result.manifest.bundleVersion, '2099.01.01.1');
    assert.equal(result.manifest.skillCount, 2);
    assert.ok(result.manifest.files.some((item) => item.path === 'catalog.json'));
    assert.ok(result.manifest.files.some((item) => item.path === 'skills/fixture-read/SKILL.md'));
    assert.match(result.treeSha256, /^[0-9a-f]{64}$/u);
    await assert.rejects(
      validateExternalSkillBundle(bundle, { expectedDshVersion: '9.9.9' }),
      /incompatible/u,
    );
  } finally {
    await cleanupRoot(root);
  }
});

test('external Skill bundle rejects missing, extra, drifted, symlinked, and secret-shaped payloads', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-external-skills-negative-'));
  try {
    const missing = await build(root, '2099.01.01.2');
    await rm(path.join(missing.bundle, 'skills', 'fixture-read', 'references', 'contract.md'));
    await assert.rejects(validateExternalSkillBundle(missing.bundle), /exact file inventory/u);

    const extra = await build(root, '2099.01.01.3');
    await writeFile(path.join(extra.bundle, 'unexpected.txt'), 'unexpected\n');
    await assert.rejects(validateExternalSkillBundle(extra.bundle), /exact file inventory/u);

    const drift = await build(root, '2099.01.01.4');
    await writeFile(path.join(drift.bundle, 'skills', 'fixture-read', 'SKILL.md'), 'drift\n');
    await assert.rejects(validateExternalSkillBundle(drift.bundle), /exact file inventory/u);

    const linked = await build(root, '2099.01.01.5');
    const target = path.join(linked.bundle, 'skills', 'fixture-read', 'references', 'contract.md');
    const link = path.join(linked.bundle, 'skills', 'fixture-read', 'references', 'linked.md');
    try {
      await symlink(target, link, 'file');
      await assert.rejects(validateExternalSkillBundle(linked.bundle), /symbolic link/u);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) t.diagnostic('symlink creation is unavailable on this Windows host');
      else throw error;
    }

    const secretSource = await sourceFixture(root, '2099.01.01.6');
    await writeFile(
      path.join(secretSource.skillsRoot, 'fixture-read', 'SKILL.md'),
      `---\nname: fixture-read\ndescription: Unsafe ${`sk-${'A'.repeat(24)}`}\n---\n`,
    );
    await assert.rejects(createExternalSkillBundle({
      sourceSkillsRoot: secretSource.skillsRoot,
      sourceCatalogPath: secretSource.catalogPath,
      outputRoot: path.join(root, 'secret-bundle'),
      compatibleDshVersions: [DSH_VERSION],
    }), /validation failed/u);
  } finally {
    await cleanupRoot(root);
  }
});

test('install is immutable and idempotent; activate failure restores current; doctor and rollback are idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-external-skills-lifecycle-'));
  try {
    const first = await build(root, '2099.02.01.1');
    const second = await build(root, '2099.02.01.2');
    const installRoot = path.join(root, 'installed');
    const installedFirst = await installExternalSkillBundle({ bundleRoot: first.bundle, installRoot, expectedDshVersion: DSH_VERSION });
    assert.equal(installedFirst.installed, true);
    assert.equal((await installExternalSkillBundle({ bundleRoot: first.bundle, installRoot, expectedDshVersion: DSH_VERSION })).idempotent, true);
    await installExternalSkillBundle({ bundleRoot: second.bundle, installRoot, expectedDshVersion: DSH_VERSION });
    await activateExternalSkillBundle({ installRoot, version: '2099.02.01.1', expectedDshVersion: DSH_VERSION });
    assert.equal((await activateExternalSkillBundle({ installRoot, version: '2099.02.01.1', expectedDshVersion: DSH_VERSION })).idempotent, true);

    await assert.rejects(activateExternalSkillBundle({
      installRoot,
      version: '2099.02.01.2',
      expectedDshVersion: DSH_VERSION,
      failpoint: 'after-current-switch',
    }), /Injected activation failure/u);
    assert.match((await readlink(path.join(installRoot, 'current'))).replaceAll('\\', '/'), /2099\.02\.01\.1$/u);

    const activated = await activateExternalSkillBundle({ installRoot, version: '2099.02.01.2', expectedDshVersion: DSH_VERSION });
    assert.equal(activated.previousVersion, '2099.02.01.1');
    assert.equal((await doctorExternalSkillBundle({ installRoot, expectedDshVersion: DSH_VERSION })).version, '2099.02.01.2');
    const rollback = await rollbackExternalSkillBundle({ installRoot, expectedDshVersion: DSH_VERSION });
    assert.equal(rollback.version, '2099.02.01.1');
    assert.equal((await rollbackExternalSkillBundle({ installRoot, expectedDshVersion: DSH_VERSION })).idempotent, true);
    assert.equal((await doctorExternalSkillBundle({ installRoot, expectedDshVersion: DSH_VERSION })).version, '2099.02.01.1');
    assert.ok((await lstat(path.join(installRoot, 'versions', '2099.02.01.2'))).isDirectory());
    if (process.platform !== 'win32') {
      assert.equal((await lstat(installRoot)).mode & 0o777, 0o755);
      assert.equal((await lstat(path.join(installRoot, 'versions'))).mode & 0o777, 0o755);
      assert.equal((await lstat(path.join(installRoot, 'versions', '2099.02.01.1'))).mode & 0o777, 0o555);
    }
  } finally {
    await cleanupRoot(root);
  }
});
