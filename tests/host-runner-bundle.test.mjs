import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  activateHostRunnerBundle,
  createHostRunnerBundle,
  doctorHostRunnerBundle,
  installHostRunnerBundle,
  rollbackHostRunnerBundle,
  validateHostRunnerBundle,
} from '../scripts/forge-host-runner-bundle.mjs';

const execute = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const compatibility = { profileCatalogVersion: '2026.09.01.6', nodeMajor: 24 };

test('source quality v17 contains the trusted runtime and still validates exact v16 inventory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-source-quality-bundle-'));
  try {
    const version = '2026.10.09.1-source-quality-test';
    await build(root, version);
    const bundle = path.join(root, `bundle-${version}`);
    const manifestPath = path.join(bundle, 'runner.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.schemaVersion, 'forge-host-runner-bundle/v17');
    assert.ok(manifest.files.some(file => file.path === 'lib/backend-source-quality/runtime.zip'));
    assert.ok(manifest.files.some(file => file.path === 'lib/forge-backend-source-quality.mjs'));
    const additions = manifest.files.filter(file => file.path.startsWith('lib/backend-source-quality/')
      || file.path.startsWith('lib/forge-backend-source-quality'));
    assert.equal(additions.length, 10);
    for (const file of additions) await rm(path.join(bundle, file.path));
    manifest.files = manifest.files.filter(file => !additions.includes(file));
    manifest.schemaVersion = 'forge-host-runner-bundle/v16';
    manifest.treeSha256 = treeHash(manifest.files);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await validateHostRunnerBundle(bundle, compatibility);
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

async function build(root, version) {
  const outputRoot = path.join(root, `bundle-${version}`);
  return createHostRunnerBundle({
    sourceRoot: repositoryRoot,
    outputRoot,
    bundleVersion: version,
    profileCatalogVersions: ['2026.09.01.6'],
    nodeMajors: [22, 24],
  });
}

async function crashLifecycleSubprocess(modulePath, exportName, options) {
  const source = [
    `const lifecycle = await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
    `await lifecycle[${JSON.stringify(exportName)}](${JSON.stringify(options)});`,
    "throw new Error('Expected lifecycle crash was not injected.');",
  ].join(' ');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Timed out waiting for lifecycle SIGKILL.')); }, 10000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stderr }); });
  });
  assert.equal(result.code, null, result.stderr);
  assert.equal(result.signal, 'SIGKILL', result.stderr);
}

function treeHash(files) {
  const hash = crypto.createHash('sha256').update('FORGE_HOST_RUNNER_BUNDLE_V1\0');
  for (const file of files) hash.update(file.path).update('\0').update(file.sha256).update('\0').update(String(file.bytes)).update('\0');
  return hash.digest('hex');
}

const legacyBasePaths = Object.freeze([
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
]);
const legacyPhasePaths = Object.freeze([
  'lib/forge-delivery-phase-controller.mjs',
  'lib/forge-delivery-phase-response.mjs',
  'lib/forge-delivery-phase-runtime.mjs',
  'lib/forge-execution-context.mjs',
  'lib/forge-phase-work-package.mjs',
  'lib/forge-prepare-headless-execution.mjs',
  'lib/forge-task-execution-contract.mjs',
  'lib/taskspace-policy.mjs',
]);

function legacyPaths(release) {
  return new Set([
    ...legacyBasePaths,
    ...(release >= 2 ? ['bin/forge-host-runner-bundle.mjs'] : []),
    ...(release >= 7 ? legacyPhasePaths : []),
    ...(release >= 12 ? ['lib/forge-host-verification-receipt.mjs'] : []),
  ]);
}

async function rewriteAsLegacyBundle(bundleRoot, release) {
  await rewriteAsPreviousBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const allowed = legacyPaths(release);
  manifest.schemaVersion = 'forge-host-runner-bundle/v1';
  manifest.bundleVersion = `2026.09.03.${release}`;
  delete manifest.phaseWorkspaceObserverEntrypoint;
  if (release < 7) {
    delete manifest.phaseControllerEntrypoint;
    delete manifest.phasePrepareEntrypoint;
  }
  const removed = manifest.files.filter((file) => !allowed.has(file.path));
  manifest.files = manifest.files.filter((file) => allowed.has(file.path));
  manifest.treeSha256 = treeHash(manifest.files);
  for (const file of removed) await rm(path.join(bundleRoot, ...file.path.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsPreviousBundle(bundleRoot) {
  await rewriteAsRecoveryBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const recoveryFiles = new Set([
    'bin/run-forge-protected-headless-recovery.mjs',
    'lib/forge-recover-headless-execution.mjs',
    'lib/forge-protected-session-mode.mjs',
  ]);
  manifest.schemaVersion = 'forge-host-runner-bundle/v2';
  delete manifest.protectedRecoveryEntrypoint;
  manifest.files = manifest.files.filter((file) => !recoveryFiles.has(file.path));
  manifest.treeSha256 = treeHash(manifest.files);
  for (const file of recoveryFiles) await rm(path.join(bundleRoot, ...file.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsRecoveryBundle(bundleRoot) {
  await rewriteAsProductionGrantBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const grantFile = 'lib/forge-production-task-grant.mjs';
  manifest.schemaVersion = 'forge-host-runner-bundle/v3';
  manifest.files = manifest.files.filter((file) => file.path !== grantFile);
  manifest.treeSha256 = treeHash(manifest.files);
  await rm(path.join(bundleRoot, ...grantFile.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsProductionGrantBundle(bundleRoot) {
  await rewriteAsCrossLayerBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const runtimeEvidenceFile = 'lib/forge-cross-layer-runtime-evidence.mjs';
  manifest.schemaVersion = 'forge-host-runner-bundle/v4';
  manifest.files = manifest.files.filter((file) => file.path !== runtimeEvidenceFile);
  manifest.treeSha256 = treeHash(manifest.files);
  await rm(path.join(bundleRoot, ...runtimeEvidenceFile.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsCrossLayerBundle(bundleRoot) {
  await rewriteAsSemanticReviewBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const reviewFile = 'lib/forge-independent-semantic-review.mjs';
  manifest.schemaVersion = 'forge-host-runner-bundle/v5';
  manifest.files = manifest.files.filter((file) => file.path !== reviewFile);
  manifest.treeSha256 = treeHash(manifest.files);
  await rm(path.join(bundleRoot, ...reviewFile.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsSemanticReviewBundle(bundleRoot) {
  await rewriteAsDependencySeedBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const seedFile = 'lib/host-dependency-seed.mjs';
  manifest.schemaVersion = 'forge-host-runner-bundle/v6';
  manifest.files = manifest.files.filter((file) => file.path !== seedFile);
  manifest.treeSha256 = treeHash(manifest.files);
  await rm(path.join(bundleRoot, ...seedFile.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsDependencySeedBundle(bundleRoot) {
  await rewriteAsPreparedDependencyBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const preparedFile = 'lib/host-prepared-dependencies.mjs';
  manifest.schemaVersion = 'forge-host-runner-bundle/v7';
  manifest.files = manifest.files.filter((file) => file.path !== preparedFile);
  manifest.treeSha256 = treeHash(manifest.files);
  await rm(path.join(bundleRoot, ...preparedFile.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsPreparedDependencyBundle(bundleRoot) {
  await rewriteAsDualReviewBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const reviewContractFile = 'lib/forge-change-contract.mjs';
  manifest.schemaVersion = 'forge-host-runner-bundle/v8';
  manifest.files = manifest.files.filter(file => file.path !== reviewContractFile);
  manifest.treeSha256 = treeHash(manifest.files);
  await rm(path.join(bundleRoot, ...reviewContractFile.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsDualReviewBundle(bundleRoot) {
  await rewriteAsSourceProvenanceBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const sourceReviewFile = 'lib/forge-reference-provenance.mjs';
  manifest.schemaVersion = 'forge-host-runner-bundle/v9';
  manifest.files = manifest.files.filter(file => file.path !== sourceReviewFile);
  manifest.treeSha256 = treeHash(manifest.files);
  await rm(path.join(bundleRoot, ...sourceReviewFile.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsSourceProvenanceBundle(bundleRoot) {
  await rewriteAsWorkflowInventoryBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const inventoryFile = 'lib/forge-workflow-migration-safety.mjs';
  manifest.schemaVersion = 'forge-host-runner-bundle/v10';
  manifest.files = manifest.files.filter(file => file.path !== inventoryFile);
  manifest.treeSha256 = treeHash(manifest.files);
  await rm(path.join(bundleRoot, ...inventoryFile.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsWorkflowInventoryBundle(bundleRoot) {
  await rewriteAsSemanticResourceBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const resourceFile = 'lib/forge-semantic-resource-lease.mjs';
  manifest.schemaVersion = 'forge-host-runner-bundle/v11';
  manifest.files = manifest.files.filter(file => file.path !== resourceFile);
  manifest.treeSha256 = treeHash(manifest.files);
  await rm(path.join(bundleRoot, ...resourceFile.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsDeadWriterBundle(bundleRoot) {
  await rewriteAsBusinessDataPreviewBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const addition = 'lib/forge-business-data-approval.mjs';
  manifest.schemaVersion = 'forge-host-runner-bundle/v13';
  manifest.files = manifest.files.filter(file => file.path !== addition);
  manifest.treeSha256 = treeHash(manifest.files);
  await rm(path.join(bundleRoot, ...addition.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsBusinessDataPreviewBundle(bundleRoot) {
  await rewriteAsBusinessDataConsumptionBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const additions = new Set(['lib/forge-business-data-consumption.mjs', 'lib/forge-acceptance-aggregator.mjs']);
  manifest.schemaVersion = 'forge-host-runner-bundle/v14';
  manifest.files = manifest.files.filter(file => !additions.has(file.path));
  manifest.treeSha256 = treeHash(manifest.files);
  for (const target of additions) await rm(path.join(bundleRoot, ...target.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rewriteAsBusinessDataConsumptionBundle(bundleRoot) {
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const additions = new Set(['lib/frontend-typecheck.mjs', 'lib/vue-typecheck-entity-compat.mjs']);
  manifest.schemaVersion = 'forge-host-runner-bundle/v15';
  manifest.files = manifest.files.filter(file => !additions.has(file.path));
  manifest.treeSha256 = treeHash(manifest.files);
  for (const target of additions) await rm(path.join(bundleRoot, ...target.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test('Host bundle v16 installs both typecheck helpers and retains exact v15 upgrade and rollback inventory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-typecheck-v16-'));
  t.after(() => cleanupRoot(root));
  const previous = await build(root, '2026.10.06.15');
  const next = await build(root, '2026.10.06.16');
  const additions = ['lib/frontend-typecheck.mjs', 'lib/vue-typecheck-entity-compat.mjs'];
  assert.equal(next.manifest.schemaVersion, 'forge-host-runner-bundle/v16');
  assert.equal(next.manifest.files.length, 41);
  for (const relative of additions) {
    const entry = next.manifest.files.find(file => file.path === relative);
    assert.ok(entry);
    assert.equal(entry.sha256, crypto.createHash('sha256').update(
      await readFile(path.join(repositoryRoot, 'docker/harness', path.basename(relative)))).digest('hex'));
  }
  await rewriteAsBusinessDataConsumptionBundle(previous.root);
  const prior = await validateHostRunnerBundle(previous.root, compatibility);
  assert.equal(prior.manifest.schemaVersion, 'forge-host-runner-bundle/v15');
  assert.equal(prior.manifest.files.length, 39);
  assert.deepEqual(prior.manifest.files.map(file => file.path),
    next.manifest.files.filter(file => !additions.includes(file.path)).map(file => file.path));
  for (const relative of additions) await assert.rejects(lstat(path.join(previous.root, relative)), { code: 'ENOENT' });
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: previous.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.10.06.15', ...compatibility });
  await installHostRunnerBundle({ bundleRoot: next.root, installRoot, ...compatibility });
  const upgraded = await activateHostRunnerBundle({ installRoot, version: '2026.10.06.16', ...compatibility });
  assert.equal(upgraded.previousVersion, '2026.10.06.15');
  const installed = path.join(installRoot, 'versions', '2026.10.06.16');
  const installedCurrent = await validateHostRunnerBundle(installed, compatibility);
  assert.equal(installedCurrent.manifest.treeSha256, next.manifest.treeSha256);
  await execute(process.execPath, ['--input-type=module', '-e', [
    'const checker = await import(process.argv[1]);',
    'const compatibility = await import(process.argv[2]);',
    'if (typeof checker.prepareFrontendTypecheck !== "function" || typeof checker.runFrontendTypecheck !== "function"',
    ' || typeof compatibility.installVueTypecheckEntityCompatibility !== "function") throw new Error("Missing installed typecheck exports");',
  ].join('\n'), ...additions.map(relative => pathToFileURL(path.join(installed, relative)).href)], { cwd: root });
  await rollbackHostRunnerBundle({ installRoot, version: '2026.10.06.15', ...compatibility });
  assert.equal((await doctorHostRunnerBundle({ installRoot, ...compatibility })).version, '2026.10.06.15');
  const retained = await validateHostRunnerBundle(path.join(installRoot, 'versions', '2026.10.06.15'), compatibility);
  assert.equal(retained.manifest.treeSha256, prior.manifest.treeSha256);
  assert.equal(JSON.parse(await readFile(path.join(installRoot, 'active.json'), 'utf8')).manager.bundleVersion, '2026.10.06.16');
  const manifestPath = path.join(previous.root, 'runner.manifest.json');
  const mislabeled = JSON.parse(await readFile(manifestPath, 'utf8'));
  mislabeled.schemaVersion = 'forge-host-runner-bundle/v16';
  await writeFile(manifestPath, JSON.stringify(mislabeled));
  await assert.rejects(validateHostRunnerBundle(previous.root, compatibility), /file inventory is incomplete/u);
});

test('AUTHZ003 Host bundle v16 imports the real policy consumption dependency closure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-preview-import-'));
  t.after(() => cleanupRoot(root));
  const bundle = await build(root, '2026.10.03.14');
  assert.equal(bundle.manifest.schemaVersion, 'forge-host-runner-bundle/v16');
  assert.equal(bundle.manifest.files.length, 41);
  assert.equal(bundle.manifest.files.some(file => file.path === 'lib/forge-business-data-preview.mjs'), false,
    'The Harness-only native tool is not a Host runtime dependency.');
  for (const name of ['host-verification-runner.mjs', 'taskspace-policy.mjs', 'forge-business-data-consumption.mjs']) {
    await execute(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);',
      pathToFileURL(path.join(bundle.root, 'lib', name)).href], { cwd: root });
  }
  for (const name of ['forge-business-data-approval.mjs', 'forge-business-data-consumption.mjs', 'forge-acceptance-aggregator.mjs']) {
    assert.equal(bundle.manifest.files.find(file => file.path === `lib/${name}`).sha256,
      crypto.createHash('sha256').update(await readFile(path.join(repositoryRoot, 'docker/harness', name))).digest('hex'));
  }
  await rm(path.join(bundle.root, 'lib/forge-business-data-consumption.mjs'));
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);',
    pathToFileURL(path.join(bundle.root, 'lib/taskspace-policy.mjs')).href], { cwd: root }), /ERR_MODULE_NOT_FOUND/u);
});

test('AUTHZ003 Host bundle preserves exact v14 inventory and its upgrade rollback manager', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-data-v14-'));
  t.after(() => cleanupRoot(root));
  const previous = await build(root, '2026.10.03.14');
  const next = await build(root, '2026.10.03.15');
  await rewriteAsBusinessDataPreviewBundle(previous.root);
  const checked = await validateHostRunnerBundle(previous.root, compatibility);
  assert.equal(checked.manifest.schemaVersion, 'forge-host-runner-bundle/v14');
  assert.equal(checked.manifest.files.length, 37);
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: previous.root, installRoot, ...compatibility });
  await installHostRunnerBundle({ bundleRoot: next.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.10.03.14', ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.10.03.15', ...compatibility });
  await rollbackHostRunnerBundle({ installRoot, version: '2026.10.03.14', ...compatibility });
  assert.equal((await doctorHostRunnerBundle({ installRoot, ...compatibility })).version, '2026.10.03.14');
  assert.equal(JSON.parse(await readFile(path.join(installRoot, 'active.json'), 'utf8')).manager.bundleVersion, '2026.10.03.15');
  const manifestPath = path.join(previous.root, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.schemaVersion = 'forge-host-runner-bundle/v15';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateHostRunnerBundle(previous.root, compatibility), /file inventory is incomplete/u);
});

test('preview Host bundle preserves exact v13 inventory and rollback compatibility', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-preview-v13-'));
  t.after(() => cleanupRoot(root));
  const previous = await build(root, '2026.10.03.13');
  const next = await build(root, '2026.10.03.14');
  await rewriteAsDeadWriterBundle(previous.root);
  const checked = await validateHostRunnerBundle(previous.root, compatibility);
  assert.equal(checked.manifest.schemaVersion, 'forge-host-runner-bundle/v13');
  assert.equal(checked.manifest.files.length, 36);
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: previous.root, installRoot, ...compatibility });
  await installHostRunnerBundle({ bundleRoot: next.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.10.03.13', ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.10.03.14', ...compatibility });
  await rollbackHostRunnerBundle({ installRoot, version: '2026.10.03.13', ...compatibility });
  assert.equal((await doctorHostRunnerBundle({ installRoot, ...compatibility })).version, '2026.10.03.13');
  const active = JSON.parse(await readFile(path.join(installRoot, 'active.json'), 'utf8'));
  assert.equal(active.manager.bundleVersion, '2026.10.03.14');
  const manifestPath = path.join(previous.root, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.schemaVersion = 'forge-host-runner-bundle/v14';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateHostRunnerBundle(previous.root, compatibility), /file inventory is incomplete/u);
});

async function rewriteAsSemanticResourceBundle(bundleRoot) {
  await rewriteAsDeadWriterBundle(bundleRoot);
  const manifestPath = path.join(bundleRoot, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const additions = new Set(['lib/forge-writer-scope-lease.mjs', 'bin/recover-forge-dead-writer.mjs']);
  manifest.schemaVersion = 'forge-host-runner-bundle/v12';
  manifest.files = manifest.files.filter(file => !additions.has(file.path));
  manifest.treeSha256 = treeHash(manifest.files);
  for (const target of additions) await rm(path.join(bundleRoot, ...target.split('/')));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test('dead writer Host bundle v16 contains the operator and protected store closure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-dead-writer-'));
  t.after(() => cleanupRoot(root));
  const bundle = await build(root, '2026.10.03.13');
  assert.equal(bundle.manifest.schemaVersion, 'forge-host-runner-bundle/v16');
  assert.equal(bundle.manifest.files.length, 41);
  for (const relative of ['bin/recover-forge-dead-writer.mjs', 'lib/forge-writer-scope-lease.mjs']) {
    assert(bundle.manifest.files.some(file => file.path === relative));
    await execute(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);',
      pathToFileURL(path.join(bundle.root, relative)).href], { cwd: root });
  }
  const lease = await import(pathToFileURL(path.join(bundle.root, 'lib/forge-writer-scope-lease.mjs')).href);
  assert.equal(typeof lease.recoverForgeWriterScopeLease, 'function');
});

test('dead writer Host bundle retains exact v12 inventory and rollback compatibility', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-dead-writer-v12-'));
  t.after(() => cleanupRoot(root));
  const previous = await build(root, '2026.10.03.12');
  const next = await build(root, '2026.10.03.13');
  await rewriteAsSemanticResourceBundle(previous.root);
  const checked = await validateHostRunnerBundle(previous.root, compatibility);
  assert.equal(checked.manifest.schemaVersion, 'forge-host-runner-bundle/v12');
  assert.equal(checked.manifest.files.length, 34);
  assert(!checked.manifest.files.some(file => file.path === 'lib/forge-writer-scope-lease.mjs'));
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: previous.root, installRoot, ...compatibility });
  await installHostRunnerBundle({ bundleRoot: next.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.10.03.12', ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.10.03.13', ...compatibility });
  await rollbackHostRunnerBundle({ installRoot, version: '2026.10.03.12', ...compatibility });
  assert.equal((await doctorHostRunnerBundle({ installRoot, ...compatibility })).version, '2026.10.03.12');
  const active = JSON.parse(await readFile(path.join(installRoot, 'active.json'), 'utf8'));
  assert.equal(active.manager.bundleVersion, '2026.10.03.13');
});

test('semantic Host bundle v16 imports its closed runtime and compiles trusted resources', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-semantic-import-'));
  t.after(() => cleanupRoot(root));
  const bundle = await build(root, '2026.10.03.12');
  assert.equal(bundle.manifest.schemaVersion, 'forge-host-runner-bundle/v16');
  assert.equal(bundle.manifest.files.length, 41);
  const resourcePath = 'lib/forge-semantic-resource-lease.mjs';
  const resource = bundle.manifest.files.find(file => file.path === resourcePath);
  assert.equal(resource.sha256, crypto.createHash('sha256').update(
    await readFile(path.join(repositoryRoot, 'docker/harness/forge-semantic-resource-lease.mjs'))).digest('hex'));
  for (const name of ['host-verification-runner.mjs', 'forge-governance.mjs', 'forge-execution-context.mjs']) {
    await execute(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);',
      pathToFileURL(path.join(bundle.root, 'lib', name)).href], { cwd: root });
  }
  const compiler = await import(pathToFileURL(path.join(bundle.root, 'lib/forge-task-execution-contract.mjs')).href);
  const contract = compiler.compileForgeTaskExecutionContract({ prompt: '调整设备页面提示。',
    ownedPaths: ['forge-admin-ui/src/views/device/index.vue'], actionCeiling: 'workspace-write',
    taskProfiles: ['frontend-admin'] }, { semanticResources: [{ type: 'table-column', key: 'PUBLIC.ORDERS#STATUS' }] });
  assert.deepEqual(contract.semanticResources, [{ type: 'table-column', key: 'public.orders#status' }]);
  assert.deepEqual(compiler.validateForgeTaskExecutionContract(contract), contract);
});

test('semantic Host bundle keeps exact v11 inventory and its upgrade rollback manager', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-semantic-v11-'));
  t.after(() => cleanupRoot(root));
  const previous = await build(root, '2026.10.03.11');
  const current = await build(root, '2026.10.03.12');
  await rewriteAsWorkflowInventoryBundle(previous.root);
  const validated = await validateHostRunnerBundle(previous.root, compatibility);
  assert.equal(validated.manifest.schemaVersion, 'forge-host-runner-bundle/v11');
  assert.equal(validated.manifest.files.length, 33);
  assert.equal(validated.manifest.files.some(file => file.path === 'lib/forge-semantic-resource-lease.mjs'), false);
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: previous.root, installRoot, ...compatibility });
  await installHostRunnerBundle({ bundleRoot: current.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.10.03.11', ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.10.03.12', ...compatibility });
  await rollbackHostRunnerBundle({ installRoot, version: '2026.10.03.11', ...compatibility });
  const doctor = await doctorHostRunnerBundle({ installRoot, ...compatibility });
  assert.equal(doctor.version, '2026.10.03.11');
  const active = JSON.parse(await readFile(path.join(installRoot, 'active.json'), 'utf8'));
  assert.equal(active.manager.bundleVersion, '2026.10.03.12', 'rollback preserves the reviewed current manager');
  const manifestPath = path.join(previous.root, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.schemaVersion = 'forge-host-runner-bundle/v12';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateHostRunnerBundle(previous.root, compatibility), /file inventory is incomplete/u);
});

test('Host Runner bundle binds the exact executable closure and compatibility matrix', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-bundle-'));
  t.after(() => cleanupRoot(root));
  const bundle = await build(root, '2026.09.03.1');
  assert.equal(bundle.manifest.schemaVersion, 'forge-host-runner-bundle/v16');
  assert.equal(bundle.manifest.files.length, 41);
  assert.equal(bundle.manifest.files.some(file => file.path === 'lib/forge-semantic-resource-lease.mjs'), true);
  assert.equal(bundle.manifest.files.some(file => file.path === 'lib/forge-workflow-migration-safety.mjs'), true);
  assert.equal(bundle.manifest.files.some(file => file.path === 'lib/forge-reference-provenance.mjs'), true);
  assert.equal(bundle.manifest.files.some(file => file.path === 'lib/forge-change-contract.mjs'), true);
  assert.equal(bundle.manifest.files.some((file) => file.path === 'lib/host-dependency-seed.mjs'), true);
  assert.equal(bundle.manifest.files.some((file) => file.path === 'lib/forge-independent-semantic-review.mjs'), true);
  assert.equal(bundle.manifest.files.some((file) => file.path === 'lib/forge-production-task-grant.mjs'), true);
  assert.equal(bundle.manifest.files.some((file) => file.path === 'lib/forge-cross-layer-runtime-evidence.mjs'), true);
  assert.deepEqual(bundle.manifest.compatibleNodeMajors, [22, 24]);
  assert.equal(bundle.manifest.entrypoint, 'lib/host-verification-runner.mjs');
  assert.equal(bundle.manifest.phaseControllerEntrypoint, 'lib/forge-delivery-phase-controller.mjs');
  assert.equal(bundle.manifest.phasePrepareEntrypoint, 'lib/forge-prepare-headless-execution.mjs');
  assert.equal(bundle.manifest.phaseWorkspaceObserverEntrypoint, 'lib/forge-delivery-phase-workspace-observer.mjs');
  assert.equal(bundle.manifest.protectedRecoveryEntrypoint, 'bin/run-forge-protected-headless-recovery.mjs');
  const packagedPolicy = await import(pathToFileURL(path.join(bundle.root, 'lib/host-verify-policy.mjs')).href);
  const packagedVerifyPolicy = await import(pathToFileURL(path.join(bundle.root, 'lib/verify-policy.mjs')).href);
  const packagedTempRoot = path.join(root, 'state', 'taskspaces', 'task-one', 'jobs', 'job-one', 'tmp');
  const packagedEnvironment = packagedPolicy.hostExecutionEnvironment({ projectSlug: 'forge-host' }, {
    homeRoot: path.join(root, 'home'),
    cacheRoot: path.join(root, 'cache'),
    tempRoot: packagedTempRoot,
    npmConfig: path.join(root, 'config', 'npmrc'),
    gitConfig: path.join(root, 'config', 'gitconfig'),
  }, {
    javaHome: path.dirname(process.execPath),
    maven: process.execPath,
    node: process.execPath,
    pnpm: process.execPath,
    git: process.execPath,
    forgeGovernance: process.execPath,
  });
  assert.equal(
    packagedEnvironment.JAVA_TOOL_OPTIONS,
    `-Djava.io.tmpdir=${packagedTempRoot} -Duser.home=${path.join(root, 'home')}`,
  );
  assert.doesNotMatch(packagedEnvironment.MAVEN_OPTS, /user\.home/u);
  assert.equal(packagedPolicy.hostProfilePolicyDigest({
    profileCatalogVersion: '2026.09.03.4',
    profiles: [...packagedVerifyPolicy.VERIFY_PROFILE_NAMES],
  }), 'e092bca903f15512f3802e19c3f95e8d6f66c1816e9405e70faab5ef234492b0');
  await assert.rejects(validateHostRunnerBundle(bundle.root, { ...compatibility, nodeMajor: 21 }), /incompatible with the selected Node major/u);

  const extra = path.join(root, 'extra');
  await cp(bundle.root, extra, { recursive: true });
  await writeFile(path.join(extra, 'unexpected.txt'), 'unexpected\n');
  await assert.rejects(validateHostRunnerBundle(extra, compatibility), /differs from its exact inventory/u);

  const drift = path.join(root, 'drift');
  await cp(bundle.root, drift, { recursive: true });
  await writeFile(path.join(drift, 'lib/host-verify-policy.mjs'), '// drift\n');
  await assert.rejects(validateHostRunnerBundle(drift, compatibility), /differs from its exact inventory/u);

  const incompletePhaseRuntime = path.join(root, 'incomplete-phase-runtime');
  await cp(bundle.root, incompletePhaseRuntime, { recursive: true });
  const incompleteManifestPath = path.join(incompletePhaseRuntime, 'runner.manifest.json');
  const incompleteManifest = JSON.parse(await readFile(incompleteManifestPath, 'utf8'));
  delete incompleteManifest.phaseWorkspaceObserverEntrypoint;
  await writeFile(incompleteManifestPath, `${JSON.stringify(incompleteManifest, null, 2)}\n`);
  await assert.rejects(validateHostRunnerBundle(incompletePhaseRuntime, compatibility), /entrypoints are invalid/u);

  const recovery = path.join(root, 'recovery');
  await cp(bundle.root, recovery, { recursive: true });
  await rewriteAsRecoveryBundle(recovery);
  const recoveryBundle = await validateHostRunnerBundle(recovery, compatibility);
  assert.equal(recoveryBundle.manifest.schemaVersion, 'forge-host-runner-bundle/v3');
  assert.equal(recoveryBundle.manifest.files.length, 25);

  const productionGrant = path.join(root, 'production-grant');
  await cp(bundle.root, productionGrant, { recursive: true });
  await rewriteAsProductionGrantBundle(productionGrant);
  const productionGrantBundle = await validateHostRunnerBundle(productionGrant, compatibility);
  assert.equal(productionGrantBundle.manifest.schemaVersion, 'forge-host-runner-bundle/v4');
  assert.equal(productionGrantBundle.manifest.files.length, 26);
  assert.equal(productionGrantBundle.manifest.files.some(
    (file) => file.path === 'lib/forge-cross-layer-runtime-evidence.mjs'), false);

  const crossLayer = path.join(root, 'cross-layer');
  await cp(bundle.root, crossLayer, { recursive: true });
  await rewriteAsCrossLayerBundle(crossLayer);
  const crossLayerBundle = await validateHostRunnerBundle(crossLayer, compatibility);
  assert.equal(crossLayerBundle.manifest.schemaVersion, 'forge-host-runner-bundle/v5');
  assert.equal(crossLayerBundle.manifest.files.length, 27);

  const previous = path.join(root, 'previous');
  await cp(bundle.root, previous, { recursive: true });
  await rewriteAsPreviousBundle(previous);
  const previousBundle = await validateHostRunnerBundle(previous, compatibility);
  assert.equal(previousBundle.manifest.schemaVersion, 'forge-host-runner-bundle/v2');
  assert.equal(previousBundle.manifest.files.length, 22);
});

test('legacy v1 validation binds every historical .1-.17 release to its exact shipped inventory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-legacy-inventory-'));
  t.after(() => cleanupRoot(root));
  const source = await build(root, '2026.09.03.20');
  const expectedCounts = new Map([
    ...[1].map((release) => [release, 11]),
    ...[2, 3, 4, 5, 6].map((release) => [release, 12]),
    ...[7, 8, 9, 10, 11].map((release) => [release, 20]),
    ...[12, 13, 14, 15, 16, 17].map((release) => [release, 21]),
  ]);
  for (const [release, expectedCount] of expectedCounts) {
    const candidate = path.join(root, `legacy-${release}`);
    await cp(source.root, candidate, { recursive: true });
    await rewriteAsLegacyBundle(candidate, release);
    const validated = await validateHostRunnerBundle(candidate, compatibility);
    assert.equal(validated.manifest.bundleVersion, `2026.09.03.${release}`);
    assert.equal(validated.manifest.files.length, expectedCount);
    assert.equal(validated.manifest.phaseControllerEntrypoint === undefined, release < 7);
  }

  for (const [sourceRelease, claimedRelease, message] of [
    [1, 2, /file inventory is incomplete/u],
    [6, 7, /entrypoints are invalid/u],
    [11, 12, /file inventory is incomplete/u],
    [17, 18, /legacy manifest release identity is unsupported/u],
  ]) {
    const mismatched = path.join(root, `mismatch-${sourceRelease}-as-${claimedRelease}`);
    await cp(source.root, mismatched, { recursive: true });
    await rewriteAsLegacyBundle(mismatched, sourceRelease);
    const manifestPath = path.join(mismatched, 'runner.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.bundleVersion = `2026.09.03.${claimedRelease}`;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(validateHostRunnerBundle(mismatched, compatibility), message);
  }
});

test('Host Runner bundle rejects symbolic links when the host permits creating them', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-link-'));
  t.after(() => cleanupRoot(root));
  const bundle = await build(root, '2026.09.03.1');
  const linked = path.join(root, 'linked');
  await cp(bundle.root, linked, { recursive: true });
  await rm(path.join(linked, 'lib/host-verify-policy.mjs'));
  try {
    await symlink(path.join(linked, 'lib/verify-policy.mjs'), path.join(linked, 'lib/host-verify-policy.mjs'), 'file');
  } catch (error) {
    t.skip(`Creating file symlinks is unavailable: ${error.code}`);
    return;
  }
  await assert.rejects(validateHostRunnerBundle(linked, compatibility), /symbolic link/u);
});

test('an installed v4 bundle upgrades to v5 without treating the new runtime evidence module as historical', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-v4-upgrade-'));
  t.after(() => cleanupRoot(root));
  const oldV4 = await build(root, '2026.09.03.1');
  const currentV5 = await build(root, '2026.09.03.2');
  await rewriteAsProductionGrantBundle(oldV4.root);
  const oldValidated = await validateHostRunnerBundle(oldV4.root, compatibility);
  assert.equal(oldValidated.manifest.schemaVersion, 'forge-host-runner-bundle/v4');
  assert.equal(oldValidated.manifest.files.length, 26);
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: oldV4.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.09.03.1', ...compatibility });
  await installHostRunnerBundle({ bundleRoot: currentV5.root, installRoot, ...compatibility });
  const upgraded = await activateHostRunnerBundle({
    installRoot, version: '2026.09.03.2', ...compatibility,
  });
  assert.equal(upgraded.previousVersion, '2026.09.03.1');
  const installedV4 = await validateHostRunnerBundle(
    path.join(installRoot, 'versions', '2026.09.03.1'), compatibility);
  const installedV5 = await validateHostRunnerBundle(
    path.join(installRoot, 'versions', '2026.09.03.2'), compatibility);
  assert.equal(installedV4.manifest.schemaVersion, 'forge-host-runner-bundle/v4');
  assert.equal(installedV5.manifest.schemaVersion, 'forge-host-runner-bundle/v16');
  assert.equal(installedV5.manifest.files.some(
    (file) => file.path === 'lib/forge-cross-layer-runtime-evidence.mjs'), true);
});

test('a v6 bundle retains its exact inventory and supports install, doctor, upgrade, and rollback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-v6-upgrade-'));
  t.after(() => cleanupRoot(root));
  const previous = await build(root, '2026.09.20.3');
  const current = await build(root, '2026.09.20.4');
  await rewriteAsSemanticReviewBundle(previous.root);
  const validated = await validateHostRunnerBundle(previous.root, compatibility);
  assert.equal(validated.manifest.schemaVersion, 'forge-host-runner-bundle/v6');
  assert.equal(validated.manifest.files.length, 28);
  assert.equal(validated.manifest.files.some((file) => file.path === 'lib/host-dependency-seed.mjs'), false);

  const incomplete = path.join(root, 'incomplete-v7');
  await cp(previous.root, incomplete, { recursive: true });
  const manifestPath = path.join(incomplete, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.schemaVersion = 'forge-host-runner-bundle/v7';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(validateHostRunnerBundle(incomplete, compatibility), /file inventory is incomplete/u);

  const installRoot = path.join(root, 'installed');
  const installed = await installHostRunnerBundle({ bundleRoot: previous.root, installRoot, ...compatibility });
  assert.equal(installed.installed, true);
  const activation = await activateHostRunnerBundle({ installRoot, version: '2026.09.20.3', ...compatibility });
  assert.equal(activation.manager.bundleVersion, '2026.09.20.3');
  const previousDoctor = await doctorHostRunnerBundle({ installRoot, ...compatibility });
  assert.equal(previousDoctor.ok, true);
  assert.equal(previousDoctor.version, '2026.09.20.3');
  assert.equal(previousDoctor.treeSha256, validated.treeSha256);
  assert.equal((await activateHostRunnerBundle({ installRoot, version: '2026.09.20.3', ...compatibility })).idempotent, true);

  await installHostRunnerBundle({ bundleRoot: current.root, installRoot, ...compatibility });
  const upgrade = await activateHostRunnerBundle({ installRoot, version: '2026.09.20.4', ...compatibility });
  assert.equal(upgrade.previousVersion, '2026.09.20.3');
  assert.equal(upgrade.manager.bundleVersion, '2026.09.20.4');
  const currentDoctor = await doctorHostRunnerBundle({ installRoot, ...compatibility });
  assert.equal(currentDoctor.ok, true);
  assert.equal(currentDoctor.version, '2026.09.20.4');

  const rollback = await rollbackHostRunnerBundle({ installRoot, ...compatibility });
  assert.equal(rollback.version, '2026.09.20.3');
  const rollbackDoctor = await doctorHostRunnerBundle({ installRoot, ...compatibility });
  assert.equal(rollbackDoctor.ok, true);
  assert.equal(rollbackDoctor.version, '2026.09.20.3');
  assert.equal(rollbackDoctor.treeSha256, validated.treeSha256);
  assert.equal(rollbackDoctor.manager.bundleVersion, '2026.09.20.4');
});

test('v10 inventory upgrades to v11 and rolls back with a durable lifecycle manager', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-v11-inventory-'));
  t.after(() => cleanupRoot(root));
  const current = await build(root, '2026.10.02.11');
  for (const name of ['host-verification-runner.mjs', 'forge-host-verification-receipt.mjs']) {
    await execute(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);',
      pathToFileURL(path.join(current.root, 'lib', name)).href]);
  }
  const previous = await build(root, '2026.10.02.10');
  await rewriteAsSourceProvenanceBundle(previous.root);
  assert.equal((await validateHostRunnerBundle(previous.root, compatibility)).manifest.files.length, 32);
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: previous.root, installRoot, ...compatibility });
  await installHostRunnerBundle({ bundleRoot: current.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.10.02.10', ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.10.02.11', ...compatibility });
  await rollbackHostRunnerBundle({ installRoot, version: '2026.10.02.10', ...compatibility });
  const active = JSON.parse(await readFile(path.join(installRoot, 'active.json'), 'utf8'));
  assert.equal(active.version, '2026.10.02.10');
  assert.equal(active.manager.bundleVersion, '2026.10.02.11', 'rollback preserves the reviewed current manager');
  const manifestPath = path.join(previous.root, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.schemaVersion = 'forge-host-runner-bundle/v11';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateHostRunnerBundle(previous.root, compatibility), /file inventory is incomplete/u);
});

test('v9 inventory remains exact while v10 supplies source provenance to its real consumers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-v10-origin-'));
  t.after(() => cleanupRoot(root));
  const current = await build(root, '2026.10.02.10');
  for (const name of ['host-verification-runner.mjs', 'forge-governance.mjs', 'verify-policy.mjs']) {
    await execute(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);',
      pathToFileURL(path.join(current.root, 'lib', name)).href]);
  }
  const previous = await build(root, '2026.10.02.9');
  await rewriteAsDualReviewBundle(previous.root);
  const validated = await validateHostRunnerBundle(previous.root, compatibility);
  assert.equal(validated.manifest.schemaVersion, 'forge-host-runner-bundle/v9');
  assert.equal(validated.manifest.files.length, 31);
  const manifestPath = path.join(previous.root, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.schemaVersion = 'forge-host-runner-bundle/v10';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateHostRunnerBundle(previous.root, compatibility), /file inventory is incomplete/u);
});

test('v8 inventory remains exact while v9 supplies the dual-review module to its real consumer', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-v9-review-'));
  t.after(() => cleanupRoot(root));
  const current = await build(root, '2026.10.01.9');
  await execute(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);',
    pathToFileURL(path.join(current.root, 'lib/forge-independent-semantic-review.mjs')).href]);
  await execute(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1]);',
    pathToFileURL(path.join(current.root, 'lib/host-verification-runner.mjs')).href]);
  const previous = await build(root, '2026.10.01.8');
  await rewriteAsPreparedDependencyBundle(previous.root);
  const validated = await validateHostRunnerBundle(previous.root, compatibility);
  assert.equal(validated.manifest.schemaVersion, 'forge-host-runner-bundle/v8');
  assert.equal(validated.manifest.files.length, 30);
  assert.equal(validated.manifest.files.some(file => file.path === 'lib/forge-change-contract.mjs'), false);
  const manifestPath = path.join(previous.root, 'runner.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.schemaVersion = 'forge-host-runner-bundle/v9';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateHostRunnerBundle(previous.root, compatibility), /file inventory is incomplete/u);
});

test('Host Runner install, activation failure recovery, doctor, and rollback are immutable and idempotent', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-lifecycle-'));
  t.after(() => cleanupRoot(root));
  const first = await build(root, '2026.09.03.1');
  const second = await build(root, '2026.09.03.2');
  await rewriteAsLegacyBundle(first.root, 1);
  assert.equal((await validateHostRunnerBundle(first.root, compatibility)).manifest.schemaVersion, 'forge-host-runner-bundle/v1');
  const installRoot = path.join(root, 'installed');
  assert.equal((await installHostRunnerBundle({ bundleRoot: first.root, installRoot, ...compatibility })).installed, true);
  assert.equal((await installHostRunnerBundle({ bundleRoot: first.root, installRoot, ...compatibility })).idempotent, true);
  await installHostRunnerBundle({ bundleRoot: second.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.09.03.1', ...compatibility });
  await assert.rejects(activateHostRunnerBundle({ installRoot, version: '2026.09.03.2', failpoint: 'after-current-switch', ...compatibility }), /Injected Host Runner activation failure/u);
  assert.match((await readlink(path.join(installRoot, 'current'))).replaceAll('\\', '/'), /versions\/2026\.09\.03\.1$/u);
  const activated = await activateHostRunnerBundle({ installRoot, version: '2026.09.03.2', ...compatibility });
  assert.equal(activated.manager.bundleVersion, '2026.09.03.2');
  assert.match(activated.manager.entrypoint.replaceAll('\\', '/'), /versions\/2026\.09\.03\.2\/bin\/forge-host-runner-bundle\.mjs$/u);
  const activeDoctor = await doctorHostRunnerBundle({ installRoot, ...compatibility });
  assert.equal(activeDoctor.version, '2026.09.03.2');
  assert.deepEqual(activeDoctor.manager, activated.manager);
  const rollback = await rollbackHostRunnerBundle({ installRoot, ...compatibility });
  assert.equal(rollback.version, '2026.09.03.1');
  assert.deepEqual(rollback.manager, activated.manager);
  assert.equal((await rollbackHostRunnerBundle({ installRoot, ...compatibility })).idempotent, true);
  const rollbackDoctor = await doctorHostRunnerBundle({ installRoot, ...compatibility });
  assert.equal(rollbackDoctor.version, '2026.09.03.1');
  assert.equal(rollbackDoctor.phaseWorkspaceObserverEntrypoint, null);
  assert.deepEqual(rollbackDoctor.manager, activated.manager);
});

test('an immutable current manager subprocess remains callable after current rolls back to v1 without a manager', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-pinned-manager-'));
  t.after(() => cleanupRoot(root));
  const legacy = await build(root, '2026.09.03.1');
  const current = await build(root, '2026.09.03.20');
  await rewriteAsLegacyBundle(legacy.root, 1);
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: legacy.root, installRoot, ...compatibility });
  await installHostRunnerBundle({ bundleRoot: current.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.09.03.1', ...compatibility });

  const pinnedManager = path.join(installRoot, 'versions', '2026.09.03.20', 'bin', 'forge-host-runner-bundle.mjs');
  const commonArguments = [
    '--install-root', installRoot,
    '--profile-catalog-version', compatibility.profileCatalogVersion,
    '--node-major', String(compatibility.nodeMajor),
  ];
  const activation = JSON.parse((await execute(process.execPath, [
    pinnedManager, 'activate', '--version', '2026.09.03.20', ...commonArguments,
  ])).stdout);
  assert.equal(activation.version, '2026.09.03.20');
  assert.equal(path.resolve(activation.manager.entrypoint), path.resolve(pinnedManager));
  assert.match((await readlink(path.join(installRoot, 'current'))).replaceAll('\\', '/'), /versions\/2026\.09\.03\.20$/u);

  const rollback = JSON.parse((await execute(process.execPath, [pinnedManager, 'rollback', ...commonArguments])).stdout);
  assert.equal(rollback.version, '2026.09.03.1');
  assert.equal(path.resolve(rollback.manager.entrypoint), path.resolve(pinnedManager));
  assert.match((await readlink(path.join(installRoot, 'current'))).replaceAll('\\', '/'), /versions\/2026\.09\.03\.1$/u);
  await assert.rejects(readFile(path.join(installRoot, 'current', 'bin', 'forge-host-runner-bundle.mjs')), { code: 'ENOENT' });

  const durableState = JSON.parse(await readFile(path.join(installRoot, 'active.json'), 'utf8'));
  const operationalManager = durableState.manager.entrypoint;
  assert.equal(path.resolve(operationalManager), path.resolve(pinnedManager));
  const doctor = JSON.parse((await execute(process.execPath, [operationalManager, 'doctor', ...commonArguments])).stdout);
  assert.equal(doctor.version, '2026.09.03.1');
  assert.equal(path.resolve(doctor.manager.entrypoint), path.resolve(pinnedManager));
  const idempotent = JSON.parse((await execute(process.execPath, [operationalManager, 'rollback', ...commonArguments])).stdout);
  assert.equal(idempotent.idempotent, true);
  assert.equal(path.resolve(idempotent.manager.entrypoint), path.resolve(pinnedManager));
});

test('a legal v3 manager pin atomically activates v5 while v1, v2, and tampered pins remain rejected', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-v3-v5-'));
  t.after(() => cleanupRoot(root));
  const v1 = await build(root, '2026.09.03.17');
  const v2 = await build(root, '2026.09.09.2');
  const v3 = await build(root, '2026.09.10.2');
  const v5 = await build(root, '2026.09.10.3');
  await rewriteAsLegacyBundle(v1.root, 17);
  await rewriteAsPreviousBundle(v2.root);
  await rewriteAsRecoveryBundle(v3.root);

  const installRoot = path.join(root, 'installed');
  for (const bundle of [v1, v2, v3, v5]) {
    await installHostRunnerBundle({ bundleRoot: bundle.root, installRoot, ...compatibility });
  }
  await activateHostRunnerBundle({ installRoot, version: '2026.09.10.2', ...compatibility });

  const activePath = path.join(installRoot, 'active.json');
  const active = JSON.parse(await readFile(activePath, 'utf8'));
  const pin = async (bundleVersion) => {
    const bundleRoot = path.join(installRoot, 'versions', bundleVersion);
    const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'runner.manifest.json'), 'utf8'));
    return {
      schemaVersion: 1,
      bundleVersion,
      bundleRoot,
      entrypoint: path.join(bundleRoot, 'bin', 'forge-host-runner-bundle.mjs'),
      treeSha256: manifest.treeSha256,
    };
  };
  const writeActiveManager = async (manager) => {
    await writeFile(activePath, `${JSON.stringify({ ...active, schemaVersion: 2, manager }, null, 2)}\n`);
  };
  const activateV5 = () => activateHostRunnerBundle({
    installRoot,
    version: '2026.09.10.3',
    ...compatibility,
  });

  await writeActiveManager(await pin('2026.09.03.17'));
  await assert.rejects(activateV5(), /immutable v3, v4, v5, v6, v7, v8, or v9 bundle/u);
  await writeActiveManager(await pin('2026.09.09.2'));
  await assert.rejects(activateV5(), /immutable v3, v4, v5, v6, v7, v8, or v9 bundle/u);
  const v3Pin = await pin('2026.09.10.2');
  await writeActiveManager({ ...v3Pin, treeSha256: '0'.repeat(64) });
  await assert.rejects(activateV5(), /immutable v3, v4, v5, v6, v7, v8, or v9 bundle/u);

  await writeActiveManager(v3Pin);
  const activated = await activateV5();
  assert.equal(activated.version, '2026.09.10.3');
  assert.equal(activated.previousVersion, '2026.09.10.2');
  assert.equal(activated.manager.bundleVersion, '2026.09.10.3');
  assert.match((await readlink(path.join(installRoot, 'current'))).replaceAll('\\', '/'), /versions\/2026\.09\.10\.3$/u);
  const durable = JSON.parse(await readFile(activePath, 'utf8'));
  assert.equal(durable.manager.bundleVersion, '2026.09.10.3');
});

test('Host Runner lifecycle safely migrates an empty legacy activation lock in place while exclusively locked', async (t) => {
  if (process.platform === 'win32') {
    t.skip('The empty activation.lock migration is specific to the production POSIX flock path.');
    return;
  }
  try {
    await execute('/usr/bin/flock', ['--version']);
  } catch {
    t.skip('/usr/bin/flock is unavailable on this host.');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-legacy-lock-'));
  t.after(() => cleanupRoot(root));
  const bundle = await build(root, '2026.09.03.20');
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: bundle.root, installRoot, ...compatibility });
  const lockPath = path.join(installRoot, 'activation.lock');
  await writeFile(lockPath, '');
  await chmod(lockPath, 0o600);
  const before = await lstat(lockPath);

  await activateHostRunnerBundle({ installRoot, version: '2026.09.03.20', ...compatibility });

  const after = await lstat(lockPath);
  assert.equal(await readFile(lockPath, 'utf8'), 'forge-host-runner-activation-lock/v1\n');
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, 1);
  assert.equal(after.mode & 0o777, 0o600);
});

test('Host Runner lifecycle does not migrate an empty legacy activation lock owned by another process', async (t) => {
  if (process.platform === 'win32') {
    t.skip('The empty activation.lock migration is specific to the production POSIX flock path.');
    return;
  }
  try {
    await execute('/usr/bin/flock', ['--version']);
  } catch {
    t.skip('/usr/bin/flock is unavailable on this host.');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-contended-legacy-lock-'));
  t.after(() => cleanupRoot(root));
  const bundle = await build(root, '2026.09.03.20');
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: bundle.root, installRoot, ...compatibility });
  const lockPath = path.join(installRoot, 'activation.lock');
  await writeFile(lockPath, '');
  await chmod(lockPath, 0o600);
  const holder = spawn('/usr/bin/flock', [
    '--exclusive', '--nonblock', lockPath,
    process.execPath, '-e', "process.stdout.write('LOCKED\\n'); process.stdin.resume();",
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { holder.stdin.destroy(); holder.kill(); });
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for the legacy lock holder.')), 5000);
    holder.stdout.setEncoding('utf8');
    holder.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('LOCKED\n')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    holder.once('error', (error) => { clearTimeout(timeout); reject(error); });
    holder.once('close', (code) => {
      if (!output.includes('LOCKED\n')) {
        clearTimeout(timeout);
        reject(new Error(`Legacy lock holder exited early with ${code}.`));
      }
    });
  });

  await assert.rejects(
    activateHostRunnerBundle({ installRoot, version: '2026.09.03.20', ...compatibility }),
    /Another Host Runner lifecycle action owns the activation lock/u,
  );
  assert.equal(await readFile(lockPath, 'utf8'), '');
  const holderClosed = new Promise((resolve, reject) => {
    holder.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Legacy lock holder exited with ${code}.`)));
    holder.once('error', reject);
  });
  holder.stdin.end();
  await holderClosed;
});

test('Host Runner lifecycle rejects unknown non-empty activation lock content without rewriting it', async (t) => {
  if (process.platform === 'win32') {
    t.skip('activation.lock content is validated by the production POSIX flock path.');
    return;
  }
  try {
    await execute('/usr/bin/flock', ['--version']);
  } catch {
    t.skip('/usr/bin/flock is unavailable on this host.');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-unknown-lock-'));
  t.after(() => cleanupRoot(root));
  const bundle = await build(root, '2026.09.03.20');
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: bundle.root, installRoot, ...compatibility });
  const lockPath = path.join(installRoot, 'activation.lock');
  const unknown = 'unknown-legacy-lock-format\n';
  await writeFile(lockPath, unknown);
  await chmod(lockPath, 0o600);

  await assert.rejects(
    activateHostRunnerBundle({ installRoot, version: '2026.09.03.20', ...compatibility }),
    /Host Runner lifecycle lock identity is invalid/u,
  );
  assert.equal(await readFile(lockPath, 'utf8'), unknown);
});

test('Host Runner lifecycle mutation is serialized by one cross-process lock owner', async (t) => {
  if (process.platform !== 'win32') {
    try {
      await execute('/usr/bin/flock', ['--version']);
    } catch {
      t.skip('/usr/bin/flock is unavailable on this host.');
      return;
    }
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-flock-'));
  t.after(() => cleanupRoot(root));
  const legacy = await build(root, '2026.09.03.1');
  const candidate = await build(root, '2026.09.03.20');
  await rewriteAsLegacyBundle(legacy.root, 1);
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: legacy.root, installRoot, ...compatibility });
  await installHostRunnerBundle({ bundleRoot: candidate.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.09.03.1', ...compatibility });
  const lockPath = path.join(installRoot, 'activation.lock');
  const ownerPath = path.join(installRoot, '.activation.lock.owner');
  const lockIdentity = process.platform === 'win32' ? null : await lstat(lockPath);
  const pinnedManager = path.join(installRoot, 'versions', '2026.09.03.20', 'bin', 'forge-host-runner-bundle.mjs');
  const holder = process.platform === 'win32'
    ? spawn(process.execPath, ['--input-type=module', '-e', [
      "import { open, rm } from 'node:fs/promises';",
      `const file = ${JSON.stringify(ownerPath)};`,
      "const handle = await open(file, 'wx', 0o600);",
      "await handle.writeFile('external-owner\\n');",
      "process.stdout.write('LOCKED\\n');",
      'process.stdin.resume();',
      "process.stdin.once('end', async () => { await handle.close(); await rm(file); });",
    ].join(' ')], { stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn('/usr/bin/flock', [
      '--exclusive', '--nonblock', lockPath,
      process.execPath, '-e', "process.stdout.write('LOCKED\\n'); process.stdin.resume();",
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { holder.stdin.destroy(); holder.kill(); });
  await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for the external lifecycle lock holder.')), 5000);
    holder.stdout.setEncoding('utf8');
    holder.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('LOCKED\n')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    holder.once('error', (error) => { clearTimeout(timeout); reject(error); });
    holder.once('close', (code) => {
      if (!output.includes('LOCKED\n')) {
        clearTimeout(timeout);
        reject(new Error(`External lifecycle lock holder exited early with ${code}.`));
      }
    });
  });
  await assert.rejects(execute(process.execPath, [
    pinnedManager, 'activate', '--version', '2026.09.03.20',
    '--install-root', installRoot,
    '--profile-catalog-version', compatibility.profileCatalogVersion,
    '--node-major', String(compatibility.nodeMajor),
  ]), (error) => error.code === 1 && /Another Host Runner lifecycle action owns the activation lock/u.test(error.stderr));
  const holderClosed = new Promise((resolve, reject) => {
    holder.once('close', (code) => code === 0 ? resolve() : reject(new Error(`External lifecycle lock holder exited with ${code}.`)));
    holder.once('error', reject);
  });
  holder.stdin.end();
  await holderClosed;
  const activated = JSON.parse((await execute(process.execPath, [
    pinnedManager, 'activate', '--version', '2026.09.03.20',
    '--install-root', installRoot,
    '--profile-catalog-version', compatibility.profileCatalogVersion,
    '--node-major', String(compatibility.nodeMajor),
  ])).stdout);
  assert.equal(activated.version, '2026.09.03.20');
  if (process.platform === 'win32') {
    await assert.rejects(lstat(ownerPath), { code: 'ENOENT' });
  } else {
    const after = await lstat(lockPath);
    assert.equal(after.dev, lockIdentity.dev);
    assert.equal(after.ino, lockIdentity.ino);
    assert.equal(after.nlink, 1);
  }
});

test('SIGKILL lifecycle recovery deterministically aborts pre-commit states and accepts only a durable post-commit state', async (t) => {
  if (process.platform === 'win32') {
    t.skip('SIGKILL releases the production POSIX flock; the Windows fallback intentionally requires stale-lease review.');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-crash-reconcile-'));
  t.after(() => cleanupRoot(root));
  const legacy = await build(root, '2026.09.03.1');
  const candidate = await build(root, '2026.09.03.20');
  await rewriteAsLegacyBundle(legacy.root, 1);
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: legacy.root, installRoot, ...compatibility });
  await installHostRunnerBundle({ bundleRoot: candidate.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.09.03.1', ...compatibility });
  const manager = path.join(installRoot, 'versions', '2026.09.03.20', 'bin', 'forge-host-runner-bundle.mjs');
  const activation = { installRoot, version: '2026.09.03.20', ...compatibility };

  await crashLifecycleSubprocess(manager, 'activateHostRunnerBundle', { ...activation, testCrashAt: 'after-pending-write' });
  let doctor = await doctorHostRunnerBundle({ installRoot, ...compatibility });
  assert.equal(doctor.version, '2026.09.03.1');
  assert.equal(doctor.reconciledTransition.status, 'aborted-pre-switch');

  await crashLifecycleSubprocess(manager, 'activateHostRunnerBundle', { ...activation, testCrashAt: 'after-current-switch' });
  doctor = await doctorHostRunnerBundle({ installRoot, ...compatibility });
  assert.equal(doctor.version, '2026.09.03.1');
  assert.equal(doctor.reconciledTransition.status, 'rolled-back-uncommitted-switch');

  await crashLifecycleSubprocess(manager, 'activateHostRunnerBundle', { ...activation, testCrashAt: 'after-active-write' });
  doctor = await doctorHostRunnerBundle({ installRoot, ...compatibility });
  assert.equal(doctor.version, '2026.09.03.20');
  assert.equal(doctor.reconciledTransition.status, 'completed-post-commit');
  await assert.rejects(lstat(path.join(installRoot, 'activation.pending.json')), { code: 'ENOENT' });
});

test('published and partially frozen Host Runner installs recover idempotently with immutable modes', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode and fsync recovery is verified on POSIX hosts.');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-install-crash-'));
  t.after(() => cleanupRoot(root));
  const candidate = await build(root, '2026.09.03.20');
  const installRoot = path.join(root, 'installed');
  const sourceManager = path.join(repositoryRoot, 'scripts', 'forge-host-runner-bundle.mjs');
  const install = { bundleRoot: candidate.root, installRoot, ...compatibility };

  await crashLifecycleSubprocess(sourceManager, 'installHostRunnerBundle', { ...install, testCrashAt: 'after-install-publish' });
  const target = path.join(installRoot, 'versions', '2026.09.03.20');
  assert.equal((await lstat(path.join(target, 'bin', 'forge-host-runner-bundle.mjs'))).mode & 0o777, 0o555);
  assert.equal((await lstat(path.join(target, 'lib', 'verify-policy.mjs'))).mode & 0o777, 0o444);
  assert.equal((await lstat(target)).mode & 0o777, 0o700, 'the crash fixture must expose the pre-root-freeze publication boundary');
  assert.equal((await installHostRunnerBundle(install)).idempotent, true);
  assert.equal((await lstat(target)).mode & 0o777, 0o555);

  const drifted = path.join(target, 'lib', 'verify-policy.mjs');
  await chmod(drifted, 0o666);
  const pinnedManager = path.join(target, 'bin', 'forge-host-runner-bundle.mjs');
  await crashLifecycleSubprocess(pinnedManager, 'installHostRunnerBundle', { ...install, testCrashAt: 'during-existing-refreeze' });
  assert.notEqual((await lstat(drifted)).mode & 0o222, 0, 'the injected partial refreeze should leave a later file writable');
  const repaired = await installHostRunnerBundle(install);
  assert.equal(repaired.idempotent, true);
  assert.equal((await lstat(drifted)).mode & 0o777, 0o444);
  assert.equal((await lstat(target)).mode & 0o777, 0o555);
});

test('packaged Runner modules and governance executable resolve only their adjacent immutable closure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-exec-'));
  t.after(() => cleanupRoot(root));
  const bundle = await build(root, '2026.09.03.1');
  await execute(process.execPath, ['--check', path.join(bundle.root, 'lib/host-verification-runner.mjs')]);
  await execute(process.execPath, ['--check', path.join(bundle.root, 'lib/forge-delivery-phase-controller.mjs')]);
  await execute(process.execPath, ['--check', path.join(bundle.root, 'lib/forge-cross-layer-runtime-evidence.mjs')]);
  await execute(process.execPath, ['--check', path.join(bundle.root, 'lib/forge-production-task-grant.mjs')]);
  await execute(process.execPath, ['--check', path.join(bundle.root, 'lib/forge-prepare-headless-execution.mjs')]);
  await execute(process.execPath, ['--check', path.join(bundle.root, 'lib/forge-delivery-phase-workspace-observer.mjs')]);
  await execute(process.execPath, ['--check', path.join(bundle.root, 'lib/forge-recover-headless-execution.mjs')]);
  await execute(process.execPath, ['--check', path.join(bundle.root, 'lib/forge-protected-session-mode.mjs')]);
  await execute(process.execPath, ['--check', path.join(bundle.root, 'bin/run-forge-protected-headless-recovery.mjs')]);
  const help = await execute(process.execPath, [path.join(bundle.root, 'bin/forge-governance'), '--help'], { maxBuffer: 1024 * 1024 });
  assert.match(help.stdout, /forge-governance/u);
  assert.doesNotMatch(help.stderr, /BOOTSTRAP_FAILED/u);
});

test('current symlink executes doctor and the Runner entrypoint never silently exits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-current-'));
  t.after(() => cleanupRoot(root));
  const bundle = await build(root, '2026.09.03.1');
  const installRoot = path.join(root, 'installed');
  await installHostRunnerBundle({ bundleRoot: bundle.root, installRoot, ...compatibility });
  await activateHostRunnerBundle({ installRoot, version: '2026.09.03.1', ...compatibility });
  const doctor = await execute(process.execPath, [
    path.join(installRoot, 'current/bin/forge-host-runner-bundle.mjs'),
    'doctor', '--install-root', installRoot,
    '--profile-catalog-version', compatibility.profileCatalogVersion,
    '--node-major', String(compatibility.nodeMajor),
  ]);
  const doctorReceipt = JSON.parse(doctor.stdout);
  assert.equal(doctorReceipt.version, '2026.09.03.1');
  assert.match(doctorReceipt.phaseControllerEntrypoint.replaceAll('\\', '/'), /current\/lib\/forge-delivery-phase-controller\.mjs$/u);
  assert.match(doctorReceipt.phasePrepareEntrypoint.replaceAll('\\', '/'), /current\/lib\/forge-prepare-headless-execution\.mjs$/u);
  assert.match(doctorReceipt.phaseWorkspaceObserverEntrypoint.replaceAll('\\', '/'), /current\/lib\/forge-delivery-phase-workspace-observer\.mjs$/u);
  assert.match(doctorReceipt.protectedRecoveryEntrypoint.replaceAll('\\', '/'), /current\/bin\/run-forge-protected-headless-recovery\.mjs$/u);
  await assert.rejects(
    execute(process.execPath, [doctorReceipt.phaseControllerEntrypoint]),
    (error) => error.code === 1 && /PHASE_CONTROLLER_ARGUMENT_INVALID/u.test(error.stderr),
  );
  await assert.rejects(
    execute(process.execPath, [doctorReceipt.phasePrepareEntrypoint], { env: {} }),
    (error) => error.code === 1 && /FORGE_EVAL_PROJECT_ROOT is invalid/u.test(error.stderr),
  );
  await assert.rejects(
    execute(process.execPath, [doctorReceipt.phaseWorkspaceObserverEntrypoint]),
    (error) => error.code === 1 && /PHASE_OBSERVER_ARGUMENT_INVALID/u.test(error.stderr),
  );
  await assert.rejects(
    execute(process.execPath, [doctorReceipt.protectedRecoveryEntrypoint]),
    (error) => error.code === 1 && /--descriptor and --allowed-root are required/u.test(error.stderr),
  );
  await assert.rejects(
    execute(process.execPath, [path.join(installRoot, 'current/lib/host-verification-runner.mjs')], { env: {} }),
    (error) => error.code === 1 && /Host verification contract, project, runner socket, and source socket are required/u.test(error.stderr),
  );
});
