import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertResumeBinding, copySeedPayload, parsePreparationArguments, preparationLogSink, preparationPaths,
  preparationRecipe, preparationToolchainProbe, runPreparationProcess, importExportedSeed, inspectExportedSeed,
} from '../scripts/prepare-host-dependency-seed.mjs';
import { hostSandboxCommand } from '../docker/harness/host-verify-policy.mjs';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-seed-producer-'));
  t.after(async () => { await treeMode(root, true); await rm(root, { recursive: true, force: true }); });
  return root;
}

async function treeMode(root, writable) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    if (writable) await chmod(root, 0o700);
    for (const name of await readdir(root)) await treeMode(path.join(root, name), writable);
    if (!writable) await chmod(root, 0o555);
  } else await chmod(root, writable ? 0o600 : 0o444);
}

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

test('export import and seed packing preserve pnpm executable payloads while keeping ordinary files nonexecutable',
  { skip: process.platform === 'win32' }, async (t) => {
    const root = await temporary(t), source = path.join(root, 'export'), cache = path.join(root, 'cache');
    const executable = `pnpm/store/v10/files/ab/${'c'.repeat(126)}-exec`;
    const sha256 = await exportedFixture(source, { 'm2/repository/a.jar': 'maven', [executable]: 'executable' });
    await mkdir(cache);
    await importExportedSeed(await inspectExportedSeed(source, sha256), cache);
    assert.equal((await lstat(path.join(cache, executable))).mode & 0o777, 0o700);
    const output = path.join(root, 'payload');
    await copySeedPayload(cache, output);
    assert.equal((await lstat(path.join(output, executable))).mode & 0o777, 0o700);
    assert.equal((await lstat(path.join(output, 'm2/repository/a.jar'))).mode & 0o111, 0);
  });
async function exportedFixture(root, contents, { hardlink = false, namespace = 'forge-forge-base', project = 'forge-base' } = {}) {
  const files = [];
  await mkdir(root);
  for (const [relative, bytes] of Object.entries(contents).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
    files.push({ path: relative, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) });
  }
  if (hardlink) await link(path.join(root, files[0].path), path.join(path.dirname(root), 'source-hardlink'));
  const manifest = JSON.stringify({ schemaVersion: 'forge-buildkit-dependency-export/v1', files,
    source: { project, namespace }, treeSha256: digest(JSON.stringify(files)), status: 'exported-unverified' });
  await writeFile(path.join(root, 'export-inventory.json'), manifest);
  await treeMode(root, false);
  return digest(manifest);
}

test('operator arguments reject additional commands, duplicate scope, and floating commits', () => {
  const argv = ['--source', path.resolve('source'), '--source-commit', 'a'.repeat(40),
    '--contract', path.resolve('contract.json'), '--output-root', path.resolve('output')];
  assert.equal(parsePreparationArguments(argv)['--source-commit'], 'a'.repeat(40));
  assert.throws(() => parsePreparationArguments([...argv, '--command', 'anything']), /INVALID_ARGUMENTS/u);
  assert.throws(() => parsePreparationArguments([...argv, '--source', path.resolve('other')]), /INVALID_ARGUMENTS/u);
  assert.throws(() => parsePreparationArguments(argv.map((value) => value === 'a'.repeat(40) ? 'HEAD' : value)), /INVALID_ARGUMENTS/u);
  assert.throws(() => preparationPaths(path.resolve('output'), 'seed-warm', '../../outside'), /INVALID_PREPARATION_PATH/u);
  assert.throws(() => parsePreparationArguments([...argv, '--seed-source', path.resolve('export')]), /SEED_SOURCE_REQUIRES_SHA256/u);
  assert.throws(() => parsePreparationArguments([...argv, '--seed-sha256', 'f'.repeat(64)]), /SEED_SOURCE_REQUIRES_SHA256/u);
  assert.equal(parsePreparationArguments([...argv, '--seed-source', path.resolve('export'), '--seed-sha256', 'f'.repeat(64)])['--seed-sha256'], 'f'.repeat(64));
});

test('fixed warm and offline recipes exclude reactor artifacts without running business lifecycle goals', () => {
  const paths = { snapshotRoot: path.resolve('job/workspace'), cacheRoot: path.resolve('task/cache'), mavenSettings: path.resolve('job/config/settings.xml') };
  const tools = { maven: '/usr/bin/mvn', pnpm: '/usr/bin/pnpm' };
  const warm = preparationRecipe(paths, tools), offline = preparationRecipe(paths, tools, true);
  assert.deepEqual(warm.map((step) => step.name), ['maven', 'maven-surefire-provider', 'maven-junit-launcher', 'maven-commons-collections', 'forge-admin-ui', 'forge-h5-ui']);
  assert.equal(warm[0].argv.at(-1), 'org.apache.maven.plugins:maven-dependency-plugin:3.9.0:go-offline');
  assert.ok(warm[0].argv.includes('-DexcludeReactor=true'));
  assert.equal(warm[0].argv.some((value) => ['compile', 'test-compile', 'test', 'package', 'install', 'deploy'].includes(value)), false);
  assert.ok(warm[0].argv.includes('-DskipTests'));
  assert.ok(warm[0].argv.includes('-Dforge.compiler.skip=false'));
  assert.ok(warm[0].argv.includes('-Dforge.tests.skip=false'));
  assert.ok(warm[0].argv.includes('--strict-checksums'));
  for (const step of warm.filter((step) => step.executable === tools.pnpm)) {
    assert.ok(step.argv.includes('--frozen-lockfile')); assert.ok(step.argv.includes('--ignore-scripts'));
    assert.equal(step.argv[2], 'install'); assert.ok(step.argv.includes('--store-dir'));
  }
  for (let i = 0; i < warm.length; i++) assert.deepEqual(offline[i].argv.filter((value) => value !== '--offline'), warm[i].argv);
  assert.ok(offline.every((step) => step.argv.includes('--offline')));
  assert.equal(warm.some((step) => step.argv.some((value) => ['test', 'build', 'package', 'deploy', 'publish'].includes(value))), false);
});

test('pnpm identity uses a neutral job directory while other probes and business recipes stay sandboxed', () => {
  const paths = { jobRoot: '/seed/taskspaces/warm/jobs/job', snapshotRoot: '/seed/taskspaces/warm/jobs/job/workspace',
    cacheRoot: '/seed/taskspaces/warm/cache', mavenSettings: '/seed/taskspaces/warm/jobs/job/config/settings.xml' };
  const tools = { java: '/usr/bin/java', maven: '/usr/bin/mvn', node: '/usr/bin/node', pnpm: '/usr/bin/pnpm' };
  assert.deepEqual(preparationToolchainProbe('pnpm', ['--version'], paths, tools),
    { executable: tools.pnpm, argv: ['--version'], cwd: paths.jobRoot });
  assert.notEqual(paths.jobRoot, paths.snapshotRoot);
  assert.equal(paths.jobRoot.startsWith(`${paths.snapshotRoot}/`), false);
  assert.deepEqual(preparationToolchainProbe('pnpm', ['install'], paths, tools).argv, ['--version']);
  for (const [name, argv] of [['java', ['-version']], ['maven', ['-version']], ['node', ['--version']]]) {
    assert.deepEqual(preparationToolchainProbe(name, argv, paths, tools),
      hostSandboxCommand({ executable: tools[name], argv, cwd: paths.snapshotRoot }, paths, tools));
  }
  for (const offline of [false, true]) {
    for (const step of preparationRecipe(paths, tools, offline)) {
      const linuxStep = { ...step, cwd: step.cwd.replaceAll('\\', '/') };
      const command = hostSandboxCommand(linuxStep, paths, tools);
      assert.equal(command.executable, '/usr/bin/bwrap');
      assert.equal(command.argv[command.argv.indexOf('--chdir') + 1], linuxStep.cwd);
      assert.ok(linuxStep.cwd === paths.snapshotRoot || linuxStep.cwd.startsWith(`${paths.snapshotRoot}/`));
    }
  }
});

test('runtime Surefire dependencies resolve transitively without repeating the reactor or changing the private cache', () => {
  const paths = preparationPaths(path.resolve('output'), 'seed-warm', 'retained-job');
  const tools = { maven: '/usr/bin/mvn', pnpm: '/usr/bin/pnpm' };
  const recipe = preparationRecipe(paths, tools);
  const expected = ['org.apache.maven.surefire:surefire-junit-platform:3.1.2', 'org.junit.platform:junit-platform-launcher:1.12.2', 'org.apache.commons:commons-collections4:4.3'];
  for (const [index, step] of recipe.slice(1, 4).entries()) {
    assert.equal(step.executable, recipe[0].executable);
    assert.equal(step.cwd, paths.snapshotRoot);
    assert.notEqual(step.cwd, recipe[0].cwd);
    assert.ok(step.argv.includes('--non-recursive'));
    assert.ok(step.argv.includes('-Dtransitive=true'));
    assert.deepEqual(step.argv.filter((arg) => arg.startsWith('-Dartifact=')), [`-Dartifact=${expected[index]}`]);
    assert.equal(step.argv.at(-1), 'org.apache.maven.plugins:maven-dependency-plugin:3.9.0:get');
    assert.equal(step.argv[step.argv.indexOf('--settings') + 1], paths.mavenSettings);
    assert.deepEqual(step.argv.filter((arg) => arg.startsWith('-Dmaven.repo.local=')),
      recipe[0].argv.filter((arg) => arg.startsWith('-Dmaven.repo.local=')));
    assert.equal(step.argv.some((arg) => ['compile', 'test-compile', 'test', 'package', 'install', 'deploy'].includes(arg)), false);
  }
});

test('runtime artifact retrieval stays inside the actual Host sandbox workspace', () => {
  const paths = { jobRoot: '/seed/taskspaces/warm/jobs/job', snapshotRoot: '/seed/taskspaces/warm/jobs/job/workspace',
    cacheRoot: '/seed/taskspaces/warm/cache', mavenSettings: '/seed/taskspaces/warm/jobs/job/config/settings.xml' };
  const tools = { maven: '/usr/bin/mvn', pnpm: '/usr/bin/pnpm' };
  for (const step of preparationRecipe(paths, tools).slice(1, 4)) {
    const command = hostSandboxCommand(step, paths, tools);
    assert.equal(command.executable, '/usr/bin/bwrap');
    assert.equal(command.argv[command.argv.indexOf('--chdir') + 1], paths.snapshotRoot);
  }
});

test('resume requires identical source, inputs, tools, policy, and producer recipe', () => {
  const binding = { sourceHead: 'a'.repeat(40), inputs: [{ path: 'forge-h5-ui/pnpm-lock.yaml', sha256: 'b'.repeat(64) }],
    toolchains: { pnpm: '11.7.0' }, mavenSettingsSha256: 'c'.repeat(64), recipeSha256: 'd'.repeat(64) };
  const previous = { recipe: 'forge-host-dependency-seed-prepare/v1', binding };
  assert.doesNotThrow(() => assertResumeBinding(previous, structuredClone(binding)));
  for (const key of Object.keys(binding)) assert.throws(() => assertResumeBinding(previous, { ...binding, [key]: 'changed' }), /RESUME_INPUT_MISMATCH/u);
  assert.throws(() => assertResumeBinding({ ...previous, recipe: 'old' }, binding), /RESUME_INPUT_MISMATCH/u);
});

test('stream redaction holds split credentials and bounds huge lines before persistence', () => {
  const output = [], sink = preparationLogSink((bytes) => output.push(bytes), 1024);
  const stream = sink.stream();
  stream.push(Buffer.from('token=sec')); assert.equal(output.length, 0);
  stream.push(Buffer.from('ret https://user:pass@registry.test/file\nAuthorization: Bear'));
  stream.push(Buffer.from('er very-secret-value\n'));
  stream.push(Buffer.from('x'.repeat(70 * 1024))); stream.push(Buffer.from('token=hidden\nnormal\n')); stream.end();
  const text = Buffer.concat(output).toString();
  for (const secret of ['secret', 'user:pass', 'very-secret-value', 'hidden']) assert.equal(text.includes(secret), false);
  assert.match(text, /REDACTED/u); assert.match(text, /overlong/u); assert.match(text, /normal/u);
  assert.ok(sink.summary().bytes <= 1024);
});

test('payload copies cache bytes without hardlinks, project indexes or unrelated state', async (t) => {
  const root = await temporary(t), cache = path.join(root, 'cache'), output = path.join(root, 'payload');
  await mkdir(path.join(cache, 'm2', 'repository'), { recursive: true });
  await mkdir(path.join(cache, 'pnpm', 'store', 'v11', 'files'), { recursive: true });
  await mkdir(path.join(cache, 'pnpm', 'store', 'v11', 'projects'), { recursive: true });
  const jar = path.join(cache, 'm2', 'repository', 'library.jar');
  await writeFile(jar, 'maven'); await link(jar, path.join(root, 'existing-link'));
  await writeFile(path.join(cache, 'm2', 'repository', 'failed.jar.lastUpdated'), 'transient');
  await writeFile(path.join(cache, 'pnpm', 'store', 'v11', 'files', 'package'), 'pnpm');
  await writeFile(path.join(cache, 'pnpm', 'store', 'v11', 'projects', 'paths'), '/old/workspace');
  await writeFile(path.join(cache, 'credential-config'), 'must not copy');
  await copySeedPayload(cache, output);
  const copied = path.join(output, 'm2', 'repository', 'library.jar');
  assert.equal((await lstat(copied)).nlink, 1);
  await writeFile(copied, 'private'); assert.equal(await readFile(jar, 'utf8'), 'maven');
  for (const relative of ['credential-config', 'm2/repository/failed.jar.lastUpdated', 'pnpm/store/v11/projects']) {
    await assert.rejects(lstat(path.join(output, relative)), { code: 'ENOENT' });
  }
  await assert.rejects(copySeedPayload(cache, output), /PAYLOAD_DESTINATION_EXISTS/u);
  assert.equal(await readFile(jar, 'utf8'), 'maven', 'existing downloads must remain untouched');
});

test('payload refuses a linked cache parent and retains failed staging without touching source', async (t) => {
  const root = await temporary(t), cache = path.join(root, 'cache'), external = path.join(root, 'external');
  await mkdir(cache); await mkdir(path.join(external, 'repository'), { recursive: true });
  await writeFile(path.join(external, 'repository', 'kept'), 'original');
  await symlink(external, path.join(cache, 'm2'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copySeedPayload(cache, path.join(root, 'payload')), /UNSAFE_DIRECTORY/u);
  assert.equal(await readFile(path.join(external, 'repository', 'kept'), 'utf8'), 'original');
});

test('operator process writes redacted progress before exit and preserves a failed command log', async (t) => {
  const root = await temporary(t), logFile = path.join(root, 'warm.log');
  const running = runPreparationProcess({ executable: process.execPath,
    argv: ['-e', "process.stdout.write('phase one\\npassword=private-value\\n');setTimeout(()=>process.exit(7),1200)"], cwd: root },
  { environment: {}, logFile, timeoutSeconds: 5, maxLogBytes: 4096 });
  let beforeExit = '';
  for (let i = 0; i < 30; i++) {
    beforeExit = await readFile(logFile, 'utf8');
    if (beforeExit.includes('phase one')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(beforeExit, /phase one/u); assert.equal(beforeExit.includes('private-value'), false);
  const result = await running;
  assert.equal(result.exitCode, 7); assert.equal(result.timedOut, false);
  assert.match(await readFile(logFile, 'utf8'), /password=\[REDACTED\]/u);
});

test('export import preserves existing downloads, breaks source hardlinks, and remains unverified', async (t) => {
  const root = await temporary(t), source = path.join(root, 'export'), cache = path.join(root, 'cache');
  const sha256 = await exportedFixture(source, { 'm2/repository/a.jar': 'maven', 'm2/repository/existing.jar': 'old-export',
    'pnpm/store/v10/files/package': 'pnpm10', 'pnpm/store/v10/projects/path': 'old-index' }, { hardlink: true });
  await mkdir(path.join(cache, 'm2', 'repository'), { recursive: true });
  await writeFile(path.join(cache, 'm2', 'repository', 'existing.jar'), 'existing-download');
  const seed = await inspectExportedSeed(source, sha256), first = await importExportedSeed(seed, cache);
  assert.deepEqual([first.imported, first.preserved, first.excluded], [2, 1, 1]);
  assert.equal(first.status, 'imported-unverified'); assert.equal(first.businessAcceptance, false);
  assert.equal(await readFile(path.join(cache, 'm2', 'repository', 'existing.jar'), 'utf8'), 'existing-download');
  assert.equal((await lstat(path.join(source, 'm2', 'repository', 'a.jar'))).nlink, 2);
  assert.equal((await lstat(path.join(cache, 'm2', 'repository', 'a.jar'))).nlink, 1);
  await writeFile(path.join(cache, 'm2', 'repository', 'a.jar'), 'private-change');
  assert.equal(await readFile(path.join(source, 'm2', 'repository', 'a.jar'), 'utf8'), 'maven');
  const repeated = await importExportedSeed(seed, cache);
  assert.deepEqual([repeated.imported, repeated.preserved, repeated.excluded], [0, 3, 1]);
  await assert.rejects(lstat(path.join(cache, 'pnpm', 'store', 'v10', 'projects')), { code: 'ENOENT' });
  assert.equal((await inspectExportedSeed(source, sha256)).treeSha256, seed.treeSha256);
});

test('export verification rejects changed content, extra files, and an incorrect manifest pin', async (t) => {
  const root = await temporary(t), source = path.join(root, 'export');
  const sha256 = await exportedFixture(source, { 'm2/repository/a.jar': 'maven', 'pnpm/store/v10/files/a': 'pnpm' });
  await assert.rejects(inspectExportedSeed(source, '0'.repeat(64)), /EXPORTED_SEED_MANIFEST_MISMATCH/u);
  const jar = path.join(source, 'm2', 'repository', 'a.jar');
  await chmod(jar, 0o600); await writeFile(jar, 'changed'); await chmod(jar, 0o444);
  await assert.rejects(inspectExportedSeed(source, sha256), /EXPORTED_SEED_PAYLOAD_MISMATCH/u);
  await chmod(jar, 0o600); await writeFile(jar, 'maven'); await chmod(jar, 0o444);
  const parent = path.dirname(jar); await chmod(parent, 0o700);
  await writeFile(path.join(parent, 'unlisted.jar'), 'extra'); await treeMode(parent, false);
  await assert.rejects(inspectExportedSeed(source, sha256), /EXPORTED_SEED_PAYLOAD_MISMATCH/u);
});

test('export source permits only forge-base with its proven named or legacy empty namespace', async (t) => {
  const root = await temporary(t), contents = { 'm2/repository/a.jar': 'maven', 'pnpm/store/v10/files/a': 'pnpm' };
  for (const [name, source, accepted] of [
    ['named', { namespace: 'forge-forge-base' }, true],
    ['legacy', { namespace: '' }, true],
    ['unrelated', { namespace: 'forge-another-project' }, false],
    ['other-project', { project: 'another-project', namespace: '' }, false],
  ]) {
    const directory = path.join(root, name), pin = await exportedFixture(directory, contents, source);
    if (accepted) assert.equal((await inspectExportedSeed(directory, pin)).files.length, 2);
    else await assert.rejects(inspectExportedSeed(directory, pin), /EXPORTED_SEED_PROJECT_MISMATCH/u);
  }
});

test('export verification refuses linked payload and credentials outside the dependency layout', async (t) => {
  const root = await temporary(t), linked = path.join(root, 'linked'), credential = path.join(root, 'credential');
  const linkPin = await exportedFixture(linked, { 'm2/repository/a.jar': 'maven' });
  await chmod(path.join(linked, 'm2', 'repository'), 0o700);
  await symlink(root, path.join(linked, 'm2', 'repository', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await chmod(path.join(linked, 'm2', 'repository'), 0o555);
  await assert.rejects(inspectExportedSeed(linked, linkPin), /EXPORTED_SEED_NON_ORDINARY/u);
  const credentialPin = await exportedFixture(credential, { 'm2/settings.xml': 'private-settings' });
  await assert.rejects(inspectExportedSeed(credential, credentialPin), /INVALID_EXPORTED_SEED_PATH/u);
});

test('final payload retains both project store versions for packageManager-selected consumers', async (t) => {
  const root = await temporary(t), cache = path.join(root, 'cache'), output = path.join(root, 'payload');
  for (const [relative, value] of Object.entries({ 'm2/repository/a.jar': 'maven',
    'pnpm/store/v10/files/a': 'retained-old', 'pnpm/store/v11/files/b': 'consumed-by-host' })) {
    await mkdir(path.dirname(path.join(cache, relative)), { recursive: true }); await writeFile(path.join(cache, relative), value);
  }
  await copySeedPayload(cache, output, { maxFiles: 10, maxBytes: 1000 });
  assert.equal(await readFile(path.join(output, 'pnpm', 'store', 'v11', 'files', 'b'), 'utf8'), 'consumed-by-host');
  assert.equal(await readFile(path.join(output, 'pnpm', 'store', 'v10', 'files', 'a'), 'utf8'), 'retained-old');
  assert.equal(await readFile(path.join(cache, 'pnpm', 'store', 'v10', 'files', 'a'), 'utf8'), 'retained-old');
});
