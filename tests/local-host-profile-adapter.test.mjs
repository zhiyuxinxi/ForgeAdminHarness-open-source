import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { HostVerificationRunner } from '../docker/harness/host-verification-runner.mjs';
import { validateTaskspaceMetadata } from '../docker/harness/taskspace-policy.mjs';
import { VERIFY_PROFILE_NAMES } from '../docker/harness/verify-policy.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrapperPath = path.join(repositoryRoot, 'scripts', 'run-local-forge-host-profile.sh');
const driverPath = path.join(repositoryRoot, 'scripts', 'run-host-verification-once.mjs');

test('operator metadata producer is consumed by the real Host source path and refuses identity drift', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-adapter-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = 'eval-crud-complete';
  const projectSlug = 'forge-harness-eval';
  const taskRoot = path.join(root, 'taskspaces', taskId);
  const workspace = path.join(taskRoot, 'workspace');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await chmod(taskRoot, 0o700);
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  const gitPath = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [git], { encoding: 'utf8' }).trim().split(/\r?\n/u)[0];
  const runGit = (...args) => execFileSync(gitPath, ['-C', workspace, ...args], { encoding: 'utf8' }).trim();
  runGit('init');
  runGit('config', 'user.name', 'Host Adapter Test');
  runGit('config', 'user.email', 'host-adapter@example.invalid');
  await writeFile(path.join(workspace, 'baseline.txt'), 'baseline\n');
  runGit('add', 'baseline.txt');
  runGit('commit', '-m', 'baseline');
  const head = runGit('rev-parse', 'HEAD');
  await writeFile(path.join(workspace, 'candidate.txt'), 'candidate\n');

  const wrapper = await readFile(wrapperPath, 'utf8');
  const producer = wrapper.match(/# Host-only TaskSpace identity lives beside the workspace, outside candidate writes\.[\s\S]*?<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/u)?.[1];
  assert.ok(producer, 'test executes the actual operator producer heredoc');
  const validatorFile = path.join(repositoryRoot, 'docker', 'harness', 'taskspace-policy.mjs');
  const owner = 'a1b2c3d4e5f60708';
  const invoke = (expectedProject = projectSlug, expectedHead = head) => spawnSync(process.execPath,
    ['-', path.join(root, 'taskspaces'), taskId, expectedProject, 'crud-complete', owner, head, expectedHead, validatorFile],
    { input: producer, encoding: 'utf8' });
  const produced = invoke();
  assert.equal(produced.status, 0, produced.stderr);
  const metadataFile = path.join(taskRoot, 'metadata.json');
  const original = await readFile(metadataFile, 'utf8');
  const metadata = validateTaskspaceMetadata(JSON.parse(original), projectSlug);
  assert.equal(metadata.taskId, taskId);
  assert.equal(metadata.baseCommit, head);
  assert.equal(metadata.projectSlug, projectSlug);
  assert.equal(metadata.branch, `task/host-operator/${taskId}`);
  assert.equal(metadata.schemaVersion, 1);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(metadataFile)).mode & 0o077, 0);
    assert.equal((await lstat(taskRoot)).mode & 0o077, 0);
  }
  assert.equal((await lstat(path.join(workspace, 'metadata.json')).catch(() => null)), null);

  const executable = path.resolve(process.execPath);
  const contract = {
    schemaVersion: 2, executionMode: 'host-toolchain', projectSlug,
    runnerRevision: 'forge-host-runner-2026.09.14.1', profileCatalogVersion: '2026.09.03.22',
    taskspacesRoot: path.join(root, 'taskspaces'), stateRoot: path.join(root, 'state'),
    toolchains: { java: executable, javaHome: path.dirname(executable), maven: executable,
      node: executable, pnpm: executable, git: gitPath, forgeGovernance: executable },
    profiles: [...VERIFY_PROFILE_NAMES],
    limits: { maxFiles: 1000, maxBytes: 32 * 1024 * 1024, maxLogBytes: 1024 * 1024,
      defaultTimeoutSeconds: 30, maxConcurrent: 1 },
  };
  await mkdir(contract.stateRoot, { mode: 0o700 });
  const runner = new HostVerificationRunner({ projectSlug, contract });
  const source = await runner.source(taskId);
  assert.equal(source.inventory.head, head);
  assert.equal(source.reviewBase, head);

  const identity = await lstat(metadataFile);
  assert.equal(invoke().status, 0);
  assert.equal(await readFile(metadataFile, 'utf8'), original);
  assert.equal((await lstat(metadataFile)).mtimeMs, identity.mtimeMs);
  assert.notEqual(invoke(projectSlug, 'f'.repeat(40)).status, 0, 'reconstructed HEAD drift is rejected');
  assert.notEqual(invoke('wrong-project').status, 0, 'a new project identity cannot overwrite metadata');
  assert.equal(await readFile(metadataFile, 'utf8'), original);

  for (const changed of [
    { ...metadata, projectSlug: 'wrong-project' },
    { ...metadata, taskId: 'wrong-task' },
    { ...metadata, baseCommit: 'f'.repeat(40) },
  ]) {
    await writeFile(metadataFile, `${JSON.stringify(changed)}\n`);
    assert.notEqual(invoke().status, 0, 'producer refuses existing wrong identity or stale base');
    await assert.rejects(runner.source(taskId), (error) => error.code === 'VERIFY_SOURCE_INVALID');
  }
});

test('local Host Runner adapter reconstructs a complete patch and executes only catalog-selected profiles', async () => {
  const source = await readFile(wrapperPath, 'utf8');
  assert.match(source, /REQUIRED_SOURCE_COMMIT="908e13bdc08ec2cbb071d355a2c33a77c970bdd3"/u);
  assert.match(source, /sourceHead: '908e13bdc08ec2cbb071d355a2c33a77c970bdd3'/u);
  assert.match(source, /EXPECTED_PROFILE_CATALOG_VERSION="2026\.09\.03\.22"/u);
  assert.match(source, /EXPECTED_HOST_RUNNER_BUNDLE_VERSION="2026\.09\.14\.2"/u);
  assert.match(source, /manifest\.bundleVersion !== process\.argv\[2\]/u);
  assert.match(source, /runnerRevision: `forge-host-runner-\$\{runnerBundleVersion\}`/u);
  assert.match(source, /frontend-aicrudpage-api-contract/u);
  assert.match(source, /forge-host-runner-bundle\.mjs" validate/u);
  assert.match(source, /--profile-catalog-version "\$\{EXPECTED_PROFILE_CATALOG_VERSION\}"/u);
  assert.match(source, /--node-major "\$\{node_major\}"/u);
  assert.match(source, /case "\$\{node_major\}" in 22\|24\)/u);
  assert.match(source, /docker image inspect --format '\{\{\.Id\}\}' "\$\{IMAGE\}"/u);
  assert.match(source, /--runtime-root\) RUNTIME_ROOT="\$2"/u);
  assert.match(source, /\.forge-host-runtime-owner\.json/u);
  assert.match(source, /host workspace escaped the run-owned runtime root/u);
  assert.match(source, /fs\.rmSync\(workspace, \{ recursive: true, force: false/u);
  assert.match(source, /"\$\{git_path\}" clone --no-hardlinks --no-checkout -- "\$\{SOURCE\}" "\$\{workspace\}"/u);
  assert.match(source, /"\$\{git_path\}" -C "\$\{workspace\}" apply --binary/u);
  assert.match(source, /toolchains: \{ java, javaHome, maven, node, pnpm, git, forgeGovernance \}/u);
  assert.match(source, /"\$\{node_path\}" "\$\{SCRIPT_DIR\}\/run-host-verification-once\.mjs"/u);
  assert.match(source, /--bundle-root "\$\{RUNNER_BUNDLE\}"/u);
  assert.match(source, /--profile\) PROFILES\+=\("\$2"\)/u);
  assert.match(source, /\[\[ "\$\{#PROFILES\[@\]\}" -gt 0 \]\]/u);
  assert.match(source, /profiles=\("\$\{PROFILES\[@\]\}"\)/u);
  assert.match(source, /'frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck', 'frontend-admin-build'/u);
  assert.doesNotMatch(source, /database\|access-wiring\) profiles=/u);
  assert.doesNotMatch(source, /backend\) profiles=/u);
  assert.match(source, /forge-server\/forge-business\/forge-business-core/u);
  assert.doesNotMatch(source, /frontend\) profiles=/u);
  assert.doesNotMatch(source, /cross-layer-acceptance\) profiles=/u);
  assert.match(source, /for requested_profile in "\$\{profiles\[@\]\}"/u);
  assert.match(source, /\{"modules":\["forge-server\/forge-business\/forge-business-core"\]\}/u);
  assert.match(source, /--profile "\$\{requested_profile\}"[\s\\]*--selectors "\$\{profile_dir\}\/selectors\.json"/u);
  assert.match(source, /phase-host-receipts\.json/u);
  assert.match(source, /stateRoot/u);
  assert.match(source, /executionMode: 'host-toolchain'/u);
  assert.match(source, /harnessImageUsedForHostProcess: false/u);
  assert.match(source, /dependencyNetworkIsolationProven: false/u);
  assert.match(source, /arbitraryShellGranted: false/u);
  assert.match(source, /requestControlledEnvironment: false/u);
  assert.doesNotMatch(source, /^\s*docker\s+(?:pull|build|buildx)\b/mu);
  assert.doesNotMatch(source, /docker (?:create|run|start|rm|volume)/u);
  assert.doesNotMatch(source, /\/opt\/java\/openjdk|\/usr\/local\/bin\/pnpm/u);
  assert.doesNotMatch(source, /ssh|scp|curl\s*\|\s*(?:sh|bash)/u);
});

test('one-shot adapter validates the exact Runner bundle and rejects extra command surfaces', async () => {
  const source = await readFile(driverPath, 'utf8');
  assert.match(source, /validateHostRunnerBundle\(bundleRoot/u);
  assert.match(source, /stableSha256\(manifestPath\) !== expectedManifestSha256/u);
  assert.match(source, /new HostVerificationRunner\(\{ projectSlug: contract\.projectSlug, contract \}\)/u);
  assert.match(source, /runner\.admit\(options\['--task-id'\], \[options\['--profile'\]\]\)/u);
  assert.match(source, /runner\.run\(options\['--task-id'\]/u);
  assert.match(source, /exportedLog/u);
  assert.doesNotMatch(source, /shell:\s*true|\.\.\.process\.env/u);

  const rejected = spawnSync(process.execPath, [driverPath, '--shell', '/bin/sh'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Unsupported argument: --shell/u);
});
