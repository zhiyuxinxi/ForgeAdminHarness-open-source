import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { acquirePreparedDependencyLock, frontendInstallationPolicyDigest, portableFrontendDependencies,
  preparedDependencyInputs, preparedFrontendDependencies } from '../docker/harness/host-verification-runner.mjs';
import { hostSandboxCommand } from '../docker/harness/host-verify-policy.mjs';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const lock = "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n\nimporters:\n  .:\n    dependencies:\n      example:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  example@1.0.0:\n    resolution: {integrity: sha512-YWJjZA==}\n\nsnapshots:\n\n  example@1.0.0: {}\n";
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-shared-'));
  t.after(async () => {
    const thaw = async (directory) => {
      await chmod(directory, 0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await thaw(path.join(directory, entry.name));
    };
    await thaw(root); await rm(root, { recursive: true, force: true });
  });
  const paths = (task, job = 'job-one') => {
    const jobRoot = path.join(root, 'taskspaces', task, 'jobs', job);
    return { jobRoot, snapshotRoot: path.join(jobRoot, 'workspace'), cacheRoot: path.join(root, 'taskspaces', task, 'cache') };
  };
  const inputs = async (where, changed = {}) => {
    const content = { 'forge-admin-ui/package.json': '{"dependencies":{"example":"1.0.0"}}',
      'forge-admin-ui/pnpm-lock.yaml': lock, 'forge-admin-ui/pnpm-workspace.yaml': "packages:\n  - '.'\n", ...changed };
    const files = [];
    for (const [relative, bytes] of Object.entries(content)) {
      const file = path.join(where.snapshotRoot, relative);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
      files.push({ relative, sha256: sha(bytes) });
    }
    return { files, dependencyManifestFingerprint: sha(JSON.stringify(files)) };
  };
  return { root, paths, inputs };
}

test('portable registry inputs are eligible; hooks, custom registry, local sources and unknown lock formats stay private', async (t) => {
  const { paths, inputs } = await fixture(t);
  const cases = [
    [{}, true], [{ 'forge-admin-ui/.npmrc': 'registry=https://private.example/\n' }, false],
    [{ 'forge-admin-ui/pnpm-lock.yaml': lock.replace('    resolution:', '    deprecated: https://github.com/example/project#deprecated\n    resolution:') }, true],
    [{ 'forge-admin-ui/package.json': '{"dependencies":{"require-directory":"1.0.0"}}',
      'forge-admin-ui/pnpm-lock.yaml': lock.replaceAll('example', 'require-directory') }, true],
    [{ 'forge-admin-ui/pnpm-workspace.yaml': "allowBuilds:\n  esbuild: true\n  vue-demi: true\nignoreBuilds:\n  '@carbon/icons': true\n  '@parcel/watcher': true\n  core-js-pure: true\n  cpu-features: true\n  es5-ext: true\n  ssh2: true\n",
      'forge-admin-ui/pnpm-lock.yaml': lock.replace('specifier: 1.0.0', "specifier: '>=1.0.0 || ^2.0.0'") }, true],
    [{ 'forge-admin-ui/pnpm-lock.yaml': lock.replace('specifier: 1.0.0', 'specifier: |\n          file:../private') }, false],
    [{ 'forge-admin-ui/.pnpmfile.cjs': 'module.exports={}' }, false],
    [{ 'forge-admin-ui/.pnpmfile.mjs': 'export default {}' }, false],
    [{ 'forge-admin-ui/package.json': '{"dependencies":{"example":"file:../private"}}' }, false],
    [{ 'forge-admin-ui/pnpm-lock.yaml': lock.replace('resolution: {integrity: sha512-YWJjZA==}', 'resolution: {tarball: https://private.example/archive.tgz}') }, false],
    [{ 'forge-admin-ui/pnpm-lock.yaml': lock.replace('resolution: {integrity: sha512-YWJjZA==}', 'resolution: {directory: ../private}') }, false],
    [{ 'forge-admin-ui/pnpm-workspace.yaml': "packages:\n  - '../private'\n" }, false],
    [{ 'forge-admin-ui/package.json': '{"pnpm":{"overrides":{"example":"file:../private"}}}' }, false],
    [{ 'forge-admin-ui/pnpm-lock.yaml': lock.replace('sha512-YWJjZA==', 'sha1-YWJjZA==') }, false],
  ];
  for (let i = 0; i < cases.length; i++) {
    const current = paths(`task-${i}`), [changed, expected] = cases[i];
    const inventory = await inputs(current, changed);
    assert.equal(await portableFrontendDependencies({ inventory, project: 'forge-admin-ui', workspace: current.snapshotRoot }), expected, `case ${i}`);
  }
});

test('concurrent same-project tasks install one tree and then reuse it read-only; corruption and changed inputs miss', async (t) => {
  const { root, paths, inputs } = await fixture(t);
  const locks = new Map(), verified = new Set();
  const one = paths('task-one'), two = paths('task-two');
  const inventory = await inputs(one); await inputs(two);
  const options = { project: 'forge-admin-ui', dependencyFingerprint: preparedDependencyInputs(inventory, 'forge-admin-ui', true),
    toolchainDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64), shared: true, verified };
  let installations = 0;
  const execute = async (current) => {
    const release = await acquirePreparedDependencyLock(locks, options.dependencyFingerprint, { timeoutSeconds: 5 });
    try {
      let ready, diagnostic;
      const params = { ...options, paths: current, onReady: (value) => { ready = value; }, onDiagnostic: (value) => { diagnostic = value; } };
      if (await preparedFrontendDependencies({ ...params, operation: 'restore' }) !== 'restored') {
        installations++;
        const file = path.join(current.snapshotRoot, 'forge-admin-ui/node_modules/example/index.js');
        await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'module.exports = 42;');
        assert.equal(await preparedFrontendDependencies({ ...params, operation: 'capture' }), 'captured', JSON.stringify(diagnostic));
      }
      return ready;
    } finally { release(); }
  };
  const [a, b] = await Promise.all([execute(one), execute(two)]);
  assert.equal(installations, 1); assert.deepEqual(a, b);
  assert.ok(a.root.startsWith(path.join(root, 'prepared-dependencies')));
  await assert.rejects(lstat(path.join(two.snapshotRoot, 'forge-admin-ui/node_modules')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(a.root, 'example/index.js'), 'utf8'), 'module.exports = 42;');
  if (process.platform !== 'win32') assert.equal((await lstat(path.join(a.root, 'example/index.js'))).mode & 0o222, 0);
  assert.equal(await preparedFrontendDependencies({ ...options, paths: paths('task-three'), dependencyFingerprint: 'd'.repeat(64), operation: 'restore' }), 'unavailable');
  const file = path.join(a.root, 'example/index.js'); await chmod(file, 0o600); await writeFile(file, 'corrupted');
  assert.equal(await preparedFrontendDependencies({ ...options, verified: new Set(), paths: paths('task-restart'), operation: 'restore' }), 'invalid');
  verified.clear(); await execute(paths('task-repair')); assert.equal(installations, 2);
  await execute(paths('task-after-repair')); assert.equal(installations, 2);
});

test('installer policy survives task and verification-profile differences while changed flags invalidate it', () => {
  const paths = (task) => ({ snapshotRoot: `/state/taskspaces/${task}/jobs/job/workspace`, cacheRoot: `/state/taskspaces/${task}/cache` });
  const step = (p) => ({ argv: ['--dir', `${p.snapshotRoot}/forge-admin-ui`, 'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', `${p.cacheRoot}/pnpm/store`] });
  const a = paths('a'), b = paths('b');
  assert.equal(frontendInstallationPolicyDigest(step(a), a), frontendInstallationPolicyDigest(step(b), b));
  assert.notEqual(frontendInstallationPolicyDigest(step(a), a), frontendInstallationPolicyDigest({ argv: step(a).argv.filter((v) => v !== '--ignore-scripts') }, a));
});

test('failed or cancelled producers release the same-key queue', async () => {
  const locks = new Map();
  const first = await acquirePreparedDependencyLock(locks, 'key', { timeoutSeconds: 5 });
  const controller = new AbortController();
  const cancelled = acquirePreparedDependencyLock(locks, 'key', { timeoutSeconds: 5, signal: controller.signal });
  controller.abort(); await assert.rejects(cancelled, { code: 'VERIFY_REQUEST_CANCELLED' });
  let entered = false;
  const next = acquirePreparedDependencyLock(locks, 'key', { timeoutSeconds: 5 }).then((release) => { entered = true; release(); });
  await Promise.resolve(); assert.equal(entered, false);
  first(); await next;
});

test('Host shared mounts are narrowly bound, read-only and give tool caches private tmpfs', { skip: process.platform === 'win32' }, async (t) => {
  const { root, paths } = await fixture(t), current = paths('task-one');
  const dependency = path.join(root, 'prepared-dependencies/forge-admin-ui', 'a'.repeat(64), 'node_modules');
  await mkdir(dependency, { recursive: true, mode: 0o700 });
  const step = { executable: '/usr/bin/node', argv: ['--version'], cwd: current.snapshotRoot };
  const command = hostSandboxCommand(step, current, { node: '/usr/bin/node' }, [{ project: 'forge-admin-ui', root: dependency }], { stateRoot: root });
  const start = command.argv.indexOf(dependency);
  assert.equal(command.argv[start - 1], '--ro-bind');
  for (const name of ['.vite', '.vite-temp', '.cache']) assert.ok(command.argv.includes(`${current.snapshotRoot}/forge-admin-ui/node_modules/${name}`));
  assert.throws(() => hostSandboxCommand(step, current, { node: '/usr/bin/node' }, [{ project: 'forge-admin-ui', root: dependency }], { stateRoot: root + '-other' }), /escaped/u);
  await chmod(path.dirname(dependency), 0o777);
  assert.throws(() => hostSandboxCommand(step, current, { node: '/usr/bin/node' }, [{ project: 'forge-admin-ui', root: dependency }], { stateRoot: root }), /Host-owned/u);
});
