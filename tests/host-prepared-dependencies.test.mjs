import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPreparedDependencyResolver, preparedDependencyDigest, verifyPreparedDependencyContent,
  frontendDependencyInputs, isFrontendProjectIsolated } from '../docker/harness/host-prepared-dependencies.mjs';
import { prepareInstalledDependencies } from '../scripts/prepare-host-installed-dependencies.mjs';
import { hostSandboxCommand } from '../docker/harness/host-verify-policy.mjs';
import { HostVerificationRunner, startHostVerificationServers } from '../docker/harness/host-verification-runner.mjs';
import { VERIFY_PROFILE_NAMES } from '../docker/harness/verify-policy.mjs';

const inventory = { files: [{ relative: 'forge-admin-ui/package.json', sha256: 'a'.repeat(64) },
  { relative: 'forge-admin-ui/pnpm-lock.yaml', sha256: 'b'.repeat(64) }] };
const toolchain = { executables: Object.fromEntries(Object.entries({ java: 'openjdk version "17.0.20"',
  maven: 'Apache Maven 3.8.7', node: 'v22.23.2', pnpm: '10.34.5' }).map(([name, version]) => [name, { version }])) };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-server-dependencies-'));
  const writable = async (directory) => {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) return;
    await chmod(directory, info.isDirectory() ? 0o700 : 0o600);
    if (info.isDirectory()) for (const name of await readdir(directory)) await writable(path.join(directory, name));
  };
  t.after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });
  const source = path.join(root, 'installed');
  await mkdir(path.join(source, 'example'), { recursive: true });
  await writeFile(path.join(source, 'example', 'index.js'), 'module.exports = 42;');
  const options = { root: path.join(root, 'published'), projectSlug: 'forge-test', inventory, toolchain,
    sources: [{ project: 'forge-admin-ui', root: source }] };
  return { root, source, options };
}

test('server prepared dependencies are adopted once and reused across new tasks without copying or installing', async (t) => {
  const { source, options } = await fixture(t);
  const before = await lstat(path.join(source, 'example/index.js'));
  const binding = await prepareInstalledDependencies(options);
  const resolve = createPreparedDependencyResolver();
  const request = { binding, projectSlug: 'forge-test', project: 'forge-admin-ui', inventory, toolchain };
  const one = await resolve(request), two = await resolve({ ...request });
  assert.equal(one.status, 'ready'); assert.deepEqual(two, one);
  assert.equal((await lstat(path.join(one.root, 'example/index.js'))).ino, before.ino);
  await assert.rejects(lstat(source), { code: 'ENOENT' });
  assert.deepEqual(await prepareInstalledDependencies(options), binding, 'publication is idempotent');
  const changed = structuredClone(inventory); changed.files[1].sha256 = 'c'.repeat(64);
  assert.equal((await resolve({ ...request, inventory: changed })).status, 'incompatible');
  assert.equal((await resolve({ ...request, projectSlug: 'other-project' })).status, 'incompatible');
  const changedTools = structuredClone(toolchain); changedTools.executables.node.version = 'v24.0.0';
  assert.equal((await resolve({ ...request, toolchain: changedTools })).status, 'incompatible');
  const file = path.join(one.root, 'example/index.js');
  await chmod(file, 0o600); await writeFile(file, 'poisoned'); await chmod(file, 0o444);
  await assert.rejects(createPreparedDependencyResolver()(request), /payload mismatch/u, 'a fresh Host rejects changed protected bytes');
});

test('server frontend installation ignores Java updates without rewriting its protected manifest', async (t) => {
  const { options } = await fixture(t);
  const binding = await prepareInstalledDependencies(options);
  const manifestFile = path.join(binding.root, 'manifest.json');
  const before = await readFile(manifestFile);
  const current = structuredClone(toolchain);
  current.javaHome = '/different/java-home';
  current.executables.java.version = 'openjdk version "17.0.20.1"';
  current.executables.maven.version = 'Apache Maven 3.8.7 | Java version: 17.0.20.1';
  const resolve = createPreparedDependencyResolver();
  const request = { binding, projectSlug: 'forge-test', project: 'forge-admin-ui', inventory, toolchain: current };
  const ready = await resolve(request);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.root, path.join(binding.root, 'forge-admin-ui/node_modules'));
  assert.deepEqual(await readFile(manifestFile), before);
  for (const [name, version] of [['node', 'v24.0.0'], ['pnpm', '11.0.0']]) {
    const changed = structuredClone(current); changed.executables[name].version = version;
    assert.equal((await resolve({ ...request, toolchain: changed })).status, 'incompatible');
  }
  for (const name of ['platform', 'arch']) {
    const foreign = JSON.parse(before);
    foreign.toolchains[name] = 'other-' + foreign.toolchains[name];
    const content = Buffer.from(JSON.stringify(foreign) + '\n');
    await chmod(manifestFile, 0o600);
    await writeFile(manifestFile, content);
    await chmod(manifestFile, 0o444);
    const foreignBinding = { ...binding, manifestSha256: crypto.createHash('sha256').update(content).digest('hex') };
    assert.equal((await resolve({ ...request, binding: foreignBinding })).status, 'incompatible', name);
  }
});

test('frontend compatibility excludes Maven inputs and scopes independent projects only with matching source bytes', async (t) => {
  const { root, options } = await fixture(t);
  const workspace = path.join(root, 'workspace');
  const files = [];
  const put = async (relative, content) => {
    const file = path.join(workspace, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    const entry = { relative, sha256: crypto.createHash('sha256').update(content).digest('hex') };
    const index = files.findIndex((item) => item.relative === relative);
    if (index === -1) files.push(entry); else files[index] = entry;
  };
  await put('package.json', '{"private":true}');
  for (const project of ['forge-admin-ui', 'forge-h5-ui']) {
    await put(`${project}/package.json`, '{"dependencies":{"example":"1.0.0"}}');
    await put(`${project}/pnpm-lock.yaml`, "lockfileVersion: '9.0'\npackages:\n  example@1.0.0:\n    resolution: {integrity: sha512-dHJ1c3RlZA==}\n    deprecated: https://github.com/lydell/resolve-url#deprecated\nsnapshots:\n  example@1.0.0:\n    dependencies:\n      get-caller-file: 2.0.5\n");
  }
  await put('shared/package.json', '{"name":"shared"}');
  const initial = structuredClone({ files });
  const h5 = path.join(root, 'h5-installed'); await mkdir(h5);
  await writeFile(path.join(h5, 'example.js'), 'trusted h5');
  const binding = await prepareInstalledDependencies({ ...options, inventory: initial,
    sources: [...options.sources, { project: 'forge-h5-ui', root: h5 }] });
  const resolve = createPreparedDependencyResolver();
  const request = { binding, projectSlug: 'forge-test', project: 'forge-h5-ui', inventory: { files }, toolchain, workspace };
  assert.equal((await resolve(request)).status, 'ready');
  await put('tools/quality/pom.xml', '<project/>');
  assert.equal((await resolve({ ...request, workspace: undefined })).status, 'ready', 'Maven inputs never affect frontend installs');
  await put('forge-admin-ui/package.json', '{"dependencies":{"example":"1.0.0","vue-i18n":"11.4.12"}}');
  await put('forge-admin-ui/pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages: {}\n");
  assert.equal((await resolve(request)).status, 'ready', 'unchanged independent H5 remains usable');
  assert.equal((await resolve({ ...request, project: 'forge-admin-ui' })).status, 'incompatible', 'changed Admin remains incomplete');
  assert.equal((await resolve({ ...request, workspace: undefined })).status, 'incompatible', 'hash-only inventory cannot assert independence');
  await put('shared/package.json', '{"name":"shared","version":"2"}');
  assert.equal((await resolve(request)).status, 'incompatible', 'shared inputs remain bound');
  await put('shared/package.json', '{"name":"shared"}');
  await writeFile(path.join(workspace, 'forge-h5-ui/package.json'), '{"dependencies":{"example":"file:../forge-admin-ui"}}');
  assert.equal(await isFrontendProjectIsolated(request), false, 'unbound bytes cannot supply an isolation proof');
  await put('forge-h5-ui/package.json', '{"dependencies":{"example":"file:../forge-admin-ui"}}');
  assert.equal(await isFrontendProjectIsolated(request), false, 'cross-root dependencies keep the complete input set');
  await put('forge-h5-ui/package.json', '{"dependencies":{"example":"link:../forge-admin-ui"}}');
  assert.equal(await isFrontendProjectIsolated(request), false, 'link sources remain rejected at a value boundary');
  await put('forge-h5-ui/package.json', '{"dependencies":{"example":"1.0.0"}}');
  await put('forge-h5-ui/pnpm-lock.yaml', "lockfileVersion: '9.0'\npackages:\n  example@1.0.0:\n    resolution: {tarball: https://example.invalid/package.tgz}\n    deprecated: https://github.com/lydell/resolve-url#deprecated\n");
  assert.equal(await isFrontendProjectIsolated(request), false, 'a source URL is still rejected beside a deprecation notice');
  await put('pnpm-workspace.yaml', "packages:\n  - 'forge-*-ui'\n");
  assert.equal(await isFrontendProjectIsolated(request), false);
  assert.deepEqual(frontendDependencyInputs({ files }, 'forge-h5-ui', true), frontendDependencyInputs({ files }), 'root workspaces couple projects');
});

test('legacy executable repair only grants execution to bytes bound by the seed executable manifest', async (t) => {
  const { root, source, options } = await fixture(t);
  const binary = Buffer.from('#!/bin/sh\nprintf repaired');
  await writeFile(path.join(source, 'tool'), binary, { mode: 0o600 });
  const seed = path.join(root, 'seed'); await mkdir(seed);
  const content = JSON.stringify({ schemaVersion: 'forge-host-dependency-seed/v1', projectSlug: 'forge-test', files: [
    { path: 'pnpm/store/v10/files/ab/' + 'a'.repeat(126) + '-exec', sha256: crypto.createHash('sha256').update(binary).digest('hex') },
  ] });
  await writeFile(path.join(seed, 'manifest.json'), content);
  const binding = await prepareInstalledDependencies({ ...options, seed: { root: seed, manifestSha256: crypto.createHash('sha256').update(content).digest('hex') } });
  if (process.platform !== 'win32') {
    const modules = path.join(binding.root, 'forge-admin-ui/node_modules');
    assert.equal((await lstat(path.join(modules, 'tool'))).mode & 0o777, 0o555);
    assert.equal((await lstat(path.join(modules, 'example/index.js'))).mode & 0o777, 0o444);
  }
});

test('Host restart reuses a protected digest only while the entire dependency metadata is unchanged', async (t) => {
  const { root, options } = await fixture(t);
  const binding = await prepareInstalledDependencies(options);
  const cacheRoot = path.join(root, 'host-state', 'prepared-dependency-checks');
  let contentChecks = 0;
  const digestTree = async (...args) => { contentChecks++; return preparedDependencyDigest(...args); };
  const prepare = () => createPreparedDependencyResolver({ cacheRoot, digestTree }).prepare({ binding, projectSlug: 'forge-test' });
  assert.equal((await prepare()).status, 'ready');
  assert.equal(contentChecks, 1);
  assert.equal((await prepare()).status, 'ready');
  assert.equal(contentChecks, 1, 'a fresh resolver does not reread unchanged dependency bytes');
  const payload = path.join(binding.root, 'forge-admin-ui/node_modules/example/index.js');
  const before = await lstat(payload);
  await chmod(payload, 0o600);
  await writeFile(payload, 'module.exports = 43;'); // Same size; restoring mtime must not hide a change.
  await utimes(payload, before.atime, before.mtime);
  await chmod(payload, 0o444);
  await assert.rejects(prepare(), /payload mismatch/u);
  assert.equal(contentChecks, 2);
  await assert.rejects(prepare(), /payload mismatch/u, 'failed verification cannot populate the cache');
});

test('task-private dependency restores reuse content proof and detect same-size tampering across calls', async (t) => {
  const { root, source } = await fixture(t);
  const sha256 = await preparedDependencyDigest(source);
  const cacheRoot = path.join(root, 'task-checks');
  let checks = 0;
  const verify = () => verifyPreparedDependencyContent({ root: source, sha256, cacheRoot,
    digestTree: async (...args) => { checks++; return preparedDependencyDigest(...args); } });
  assert.equal(await verify(), true);
  assert.equal(await verify(), true);
  assert.equal(checks, 1, 'Lint, test and build reuse the same content proof');
  const payload = path.join(source, 'example/index.js');
  const before = await lstat(payload);
  await writeFile(payload, 'module.exports = 43;');
  await utimes(payload, before.atime, before.mtime);
  assert.equal(await verify(), false, 'ctime and complete metadata invalidate modified bytes');
  assert.equal(checks, 2);
  assert.equal(await verify(), false, 'failed proof never becomes reusable');
  assert.equal(checks, 3);
  await writeFile(payload, 'module.exports = 42;');
  assert.equal(await verify(), true);
  const files = await readdir(cacheRoot);
  await writeFile(path.join(cacheRoot, files[0]), '{broken');
  assert.equal(await verify(), true, 'corrupt private proof falls back to real content verification');
  assert.equal(checks, 5);
});

test('missing, corrupt or unprotected digest cache falls back to verification without blocking valid dependencies', async (t) => {
  const { root, options } = await fixture(t);
  const binding = await prepareInstalledDependencies(options);
  const cacheRoot = path.join(root, 'checks');
  let contentChecks = 0;
  const digestTree = async (...args) => { contentChecks++; return preparedDependencyDigest(...args); };
  const prepare = () => createPreparedDependencyResolver({ cacheRoot, digestTree }).prepare({ binding, projectSlug: 'forge-test' });
  await prepare();
  const entries = await readdir(cacheRoot);
  assert.equal(entries.length, 1);
  await writeFile(path.join(cacheRoot, entries[0]), '{broken');
  assert.equal((await prepare()).status, 'ready');
  assert.equal(contentChecks, 2);
  if (process.platform !== 'win32') {
    await chmod(cacheRoot, 0o777);
    assert.equal((await prepare()).status, 'ready');
    assert.equal(contentChecks, 3, 'business-writable cache cannot authorize a reuse');
  }
});

test('prepared dependencies reject links outside the installed artifact', { skip: process.platform === 'win32' }, async (t) => {
  const { source, root } = await fixture(t);
  await writeFile(path.join(root, 'outside.js'), 'outside');
  await symlink('../../outside.js', path.join(source, 'example', 'escape.js'));
  await assert.rejects(preparedDependencyDigest(source), /escapes/u);
});

test('frontend startup preparation validates its bound artifact without inventing task inputs', async (t) => {
  const { options } = await fixture(t);
  const binding = await prepareInstalledDependencies(options);
  const resolve = createPreparedDependencyResolver();
  assert.deepEqual(await resolve.prepare({ binding, projectSlug: 'forge-test' }), { status: 'ready', projects: ['forge-admin-ui'] });
  const request = { binding, projectSlug: 'forge-test', project: 'forge-admin-ui', inventory, toolchain };
  const changed = structuredClone(inventory); changed.files[0].sha256 = 'c'.repeat(64);
  assert.equal((await resolve({ ...request, inventory: changed })).status, 'incompatible');
  const changedTools = structuredClone(toolchain); changedTools.executables.node.version = 'v24.0.0';
  assert.equal((await resolve({ ...request, toolchain: changedTools })).status, 'incompatible');
  assert.equal((await resolve({ ...request, projectSlug: 'other-project' })).status, 'incompatible');
  await assert.rejects(resolve({ ...request, binding: { ...binding, manifestSha256: 'f'.repeat(64) } }), /manifest digest mismatch/u);
  await assert.rejects(resolve.prepare({ binding, projectSlug: 'other-project' }), /project mismatch/u);
});

test('failed frontend startup preparation does not cache success and permits a repaired immutable artifact', async (t) => {
  const { options } = await fixture(t);
  const binding = await prepareInstalledDependencies(options);
  const file = path.join(binding.root, 'forge-admin-ui/node_modules/example/index.js');
  const original = await readFile(file);
  await chmod(file, 0o600); await writeFile(file, 'changed'); await chmod(file, 0o444);
  const resolve = createPreparedDependencyResolver();
  await assert.rejects(resolve.prepare({ binding, projectSlug: 'forge-test' }), /payload mismatch/u);
  await chmod(file, 0o600); await writeFile(file, original); await chmod(file, 0o444);
  assert.equal((await resolve.prepare({ binding, projectSlug: 'forge-test' })).status, 'ready');
});

test('shared frontend and Maven mounts require exact protected bindings for every new task', () => {
  const contract = { preparedDependencies: { root: '/srv/forge-delivery/prepared/version-one', manifestSha256: 'a'.repeat(64) },
    dependencySeed: { root: '/srv/forge-delivery/seeds/version-one', manifestSha256: 'b'.repeat(64) } };
  const dependencies = [{ project: 'forge-admin-ui', root: contract.preparedDependencies.root + '/forge-admin-ui/node_modules' },
    { project: 'm2', root: contract.dependencySeed.root + '/m2/repository' }];
  for (const task of ['new-task-one', 'new-task-two']) {
    const base = '/srv/forge-delivery/verification/taskspaces/' + task;
    const paths = { jobRoot: base + '/jobs/job-one', cacheRoot: base + '/cache' };
    const tools = { node: '/usr/bin/node' }, step = { executable: tools.node, argv: ['--version'], cwd: paths.jobRoot + '/workspace' };
    const command = hostSandboxCommand(step, paths, tools, dependencies, contract);
    for (const dependency of dependencies) assert.equal(command.argv[command.argv.indexOf(dependency.root) - 1], '--ro-bind');
    assert.throws(() => hostSandboxCommand(step, paths, tools, dependencies), /escaped/u);
    assert.throws(() => hostSandboxCommand(step, paths, tools, [{ ...dependencies[0], root: '/other/node_modules' }], contract), /escaped/u);
  }
});

test('Host preparation attaches the server installation for two fresh TaskSpaces without seed copying', async (t) => {
  const { root, options } = await fixture(t);
  const binding = await prepareInstalledDependencies(options);
  const tools = structuredClone(toolchain);
  for (const value of Object.values(tools.executables)) value.resolvedPath = process.execPath;
  tools.executables.git = { resolvedPath: process.execPath };
  tools.executables.forgeGovernance = { resolvedPath: process.execPath };
  tools.javaHome = path.dirname(process.execPath);
  const contract = { schemaVersion: 2, executionMode: 'host-toolchain', processIsolation: 'bubblewrap',
    projectSlug: 'forge-test', runnerRevision: 'prepared-test', profileCatalogVersion: '2026.09.03.22',
    taskspacesRoot: path.join(root, 'taskspaces'), stateRoot: path.join(root, 'host-state'), preparedDependencies: binding,
    toolchains: Object.fromEntries([...Object.keys(tools.executables).map((key) => [key, process.execPath]), ['javaHome', tools.javaHome]]),
    profiles: [...VERIFY_PROFILE_NAMES], limits: { maxFiles: 1000, maxBytes: 1024 ** 2, maxLogBytes: 1024 ** 2, defaultTimeoutSeconds: 30, maxConcurrent: 2 } };
  const runner = new HostVerificationRunner({ projectSlug: 'forge-test', contract,
    command: () => { throw new Error('No package install or download is permitted during reuse.'); },
    snapshot: async (_source, destination) => mkdir(path.join(destination, 'forge-admin-ui'), { recursive: true }) });
  const prepared = await runner.prepareInstalledDependencies();
  assert.equal(prepared[0].status, 'ready');
  assert.equal(prepared[0].manifestSha256, binding.manifestSha256);
  // Deliberate fixture-only corruption distinguishes a same-process Map hit
  // from another full scan. A fresh Host must still reject these bytes.
  const payload = path.join(binding.root, 'forge-admin-ui/node_modules/example/index.js');
  await chmod(payload, 0o600); await writeFile(payload, 'changed after startup'); await chmod(payload, 0o444);
  await assert.rejects(createPreparedDependencyResolver().prepare({ binding, projectSlug: 'forge-test' }), /payload mismatch/u);
  const bindings = [];
  for (const task of ['fresh-one', 'fresh-two']) {
    const job = await runner.prepareJob(task, crypto.randomUUID(), { inventory, workspace: path.join(root, task) }, tools,
      { seedDependencies: true, dependencyGroups: ['pnpm'], frontendProject: 'forge-admin-ui' });
    bindings.push(job.readOnlyDependencies);
    assert.equal(job.dependencySeed.copiedFiles, 0);
    assert.equal(job.dependencySeed.installed, false);
    await assert.rejects(lstat(path.join(job.paths.cacheRoot, 'pnpm')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(job.paths.snapshotRoot, 'forge-admin-ui/node_modules')), { code: 'ENOENT' });
  }
  assert.deepEqual(bindings[0], bindings[1]);
  const originalSettings = await readFile(new URL('../docker/harness/maven-verification-settings.xml', import.meta.url), 'utf8');
  runner.preinstalledMaven = async () => ({ status: 'ready', project: 'm2', root: '/protected/m2/repository' });
  const ready = await runner.prepareJob('maven-ready', crypto.randomUUID(), { inventory, workspace: path.join(root, 'maven-ready') }, tools,
    { seedDependencies: true, dependencyGroups: ['m2'] });
  const readonlySettings = await readFile(ready.paths.mavenSettings, 'utf8');
  assert.match(readonlySettings, /<id>central<\/id><mirrorOf>forge-prepared-central<\/mirrorOf>/u);
  assert.match(readonlySettings, /<mirrorOf>central,aliyun,public<\/mirrorOf>/u, 'existing verified repository policy remains');
  const urls = (xml) => [...new Set([...xml.matchAll(/<url>([^<]+)<\/url>/gu)].map((m) => m[1]))].sort();
  assert.deepEqual(urls(readonlySettings), urls(originalSettings), 'origin compatibility does not add a remote source');
  assert.equal(ready.dependencySeed.copiedFiles, 0);
  runner.preinstalledMaven = async () => ({ status: 'incompatible' });
  const miss = await runner.prepareJob('maven-miss', crypto.randomUUID(), { inventory, workspace: path.join(root, 'maven-miss') }, tools,
    { seedDependencies: true, dependencyGroups: ['m2'] });
  assert.equal(await readFile(miss.paths.mavenSettings, 'utf8'), originalSettings, 'unverified private repository cannot use the alias');
});

test('Host dependency startup failure closes its early source listener and leaves execution unopened', { skip: process.platform === 'win32' }, async (t) => {
  const { root, options } = await fixture(t);
  const binding = await prepareInstalledDependencies(options);
  const file = path.join(binding.root, 'forge-admin-ui/node_modules/example/index.js');
  await chmod(file, 0o600); await writeFile(file, 'poisoned'); await chmod(file, 0o444);
  const runner = Object.assign(Object.create(HostVerificationRunner.prototype), {
    projectSlug: 'forge-test', stateRoot: path.join(root, 'state'),
    contract: { processIsolation: 'bubblewrap', preparedDependencies: binding, runnerRevision: 'startup-test' },
    preinstalledFrontend: createPreparedDependencyResolver(),
  });
  const sockets = { socketPath: path.join(root, 'runner.sock'), sourceSocketPath: path.join(root, 'source.sock') };
  await assert.rejects(startHostVerificationServers(runner, sockets), /payload mismatch/u);
  for (const socket of Object.values(sockets)) await assert.rejects(lstat(socket), { code: 'ENOENT' });
});

test('Host serves source during preparation and opens execution only after same-process dependencies are ready', { skip: process.platform === 'win32' }, async (t) => {
  const { root, options } = await fixture(t);
  const binding = await prepareInstalledDependencies(options);
  const resolver = createPreparedDependencyResolver();
  const prepare = resolver.prepare;
  let allowPreparation;
  let preparationStarted;
  const barrier = new Promise((resolve) => { allowPreparation = resolve; });
  const preparing = new Promise((resolve) => { preparationStarted = resolve; });
  resolver.prepare = async (args) => { preparationStarted(); await barrier; return prepare(args); };
  let executions = 0;
  const runner = Object.assign(Object.create(HostVerificationRunner.prototype), {
    projectSlug: 'forge-test', stateRoot: path.join(root, 'state'), activeByTask: new Map(),
    contract: { processIsolation: 'bubblewrap', preparedDependencies: binding, runnerRevision: 'startup-test' },
    preinstalledFrontend: resolver,
    source: async (taskId) => {
      assert.equal(taskId, 'task-one');
      return { inventory: { head: 'a'.repeat(40), workspaceFingerprint: 'b'.repeat(64) } };
    },
    execute: async () => { executions += 1; return { executed: true }; },
  });
  const sockets = { socketPath: path.join(root, 'runner.sock'), sourceSocketPath: path.join(root, 'source.sock') };
  const starting = startHostVerificationServers(runner, sockets);
  t.after(async () => { allowPreparation(); await starting.then(servers => servers.close(), () => {}); });
  await Promise.race([preparing, starting]);
  const request = (socketPath, route, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: body ? 'POST' : 'GET', agent: false,
      headers: body ? { 'content-type': 'application/json' } : {} }, (response) => {
      let body = ''; response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const observed = await request(sockets.sourceSocketPath, '/v1/source', { taskId: 'task-one' });
  assert.equal(observed.status, 200);
  assert.equal(observed.body.result.source.fingerprint, 'b'.repeat(64));
  assert.equal((await lstat(sockets.sourceSocketPath)).mode & 0o777, 0o660);
  await assert.rejects(request(sockets.socketPath, '/v1/actions', { action: 'run' }), { code: 'ENOENT' });
  const invalid = await request(sockets.sourceSocketPath, '/v1/source', { taskId: 'task-one', action: 'run' });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, 'VERIFY_REQUEST_INVALID');
  assert.equal(executions, 0);
  allowPreparation();
  const servers = await starting;
  const health = await request(sockets.socketPath, '/healthz');
  assert.equal(health.status, 200); assert.equal(health.body.acceptingJobs, true);
  assert.equal(health.body.runnerRevision, 'startup-test');
  const dependencyRequest = { binding, projectSlug: 'forge-test', project: 'forge-admin-ui', inventory, toolchain };
  assert.equal((await runner.preinstalledFrontend(dependencyRequest)).status, 'ready');
  assert.equal((await lstat(sockets.socketPath)).mode & 0o777, 0o660);
  assert.equal((await request(sockets.socketPath, '/v1/actions', { action: 'run' })).status, 200);
  assert.equal(executions, 1);
  await servers.close();
  await servers.close();
  for (const socket of Object.values(sockets)) {
    await assert.rejects(lstat(socket), { code: 'ENOENT' });
    await assert.rejects(request(socket, '/healthz'), { code: 'ENOENT' });
  }
});

test('Host startup remains compatible when no protected dependency binding is configured', async () => {
  const runner = Object.assign(Object.create(HostVerificationRunner.prototype), {
    contract: { processIsolation: 'bubblewrap' },
    preinstalledFrontend: { prepare: () => assert.fail('unconfigured frontend must not be prepared') },
    preinstalledMaven: { prepare: () => assert.fail('unconfigured Maven must not be prepared') },
  });
  assert.deepEqual(await runner.prepareInstalledDependencies(), []);
});
