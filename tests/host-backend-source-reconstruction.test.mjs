import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { reconstructBackendSourceProjection } from '../docker/harness/host-verification-runner.mjs';
import { inventoryWorkspace } from '../docker/harness/verification-runner.mjs';

const execute = promisify(execFile);
const limits = { maxFiles: 32, maxBytes: 10 * 1024 };
const backend = 'forge-server/src/Example.java';
const frontend = 'forge-admin-ui/src/existing.js';
const h5Frontend = 'forge-h5-ui/src/existing.js';
const addedFrontend = 'forge-admin-ui/src/added.js';

async function fixture(t, frontendBytes = 'export const existing = 1;\n') {
  const temporaryRoot = path.resolve(os.tmpdir());
  const workspace = await mkdtemp(path.join(temporaryRoot, 'forge-backend-projection-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(workspace)), temporaryRoot);
    assert.ok(path.basename(workspace).startsWith('forge-backend-projection-'));
    await rm(workspace, { recursive: true, force: true });
  });
  const command = async (executable, argv) => {
    assert.equal(executable, 'git');
    try {
      const result = await execute(executable, argv, {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: path.join(workspace, '.absent-global-gitconfig') },
      });
      return { ...result, exitCode: 0, signal: null, timedOut: false, truncated: false };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code,
        signal: error.signal ?? null, timedOut: error.killed, truncated: false };
    }
  };
  const git = argv => command('git', ['-c', `safe.directory=${workspace}`, '-c', 'core.autocrlf=false', ...argv]);
  const put = async (relative, contents) => {
    await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await writeFile(path.join(workspace, relative), contents);
  };
  const inventory = () => inventoryWorkspace(workspace, limits, command);
  for (const [relative, contents] of [
    [backend, 'class Example { int value = 1; }\n'],
    [frontend, frontendBytes],
    [h5Frontend, 'export const h5 = 1;\n'],
    ['forge-server/pom.xml', '<project/>\n'],
    ['package.json', '{"name":"projection-fixture"}\n'],
    ['build.config.js', 'export default {};\n'],
  ]) await put(relative, contents);
  for (const argv of [['init', '--quiet'], ['add', '.'],
    ['-c', 'user.name=Projection Fixture', '-c', 'user.email=projection@example.invalid',
      'commit', '--quiet', '-m', 'initial fixture']]) {
    const result = await git(argv);
    assert.equal(result.exitCode, 0, result.stderr);
  }
  // The original backend check can itself cover uncommitted backend work.
  await put(backend, 'class Example { int value = 2; }\n');
  const original = () => inventory().then(value => ({ source: {
    head: value.head, workspaceFingerprint: value.workspaceFingerprint,
    dependencyManifestFingerprint: value.dependencyManifestFingerprint,
    fileCount: value.fileCount, bytes: value.bytes,
  } }));
  const project = async (previous, profile) => {
    const before = await inventory();
    const bytes = await Promise.all(before.files.map(item => item.deleted ? null : readFile(item.absolute)));
    const result = await reconstructBackendSourceProjection({ inventory: before, readGit: git }, previous, profile);
    const after = await inventory();
    assert.equal(after.head, before.head, 'reconstruction must not move HEAD');
    assert.deepEqual(after, before, 'reconstruction must not change worktree inventory');
    assert.deepEqual(await Promise.all(after.files.map(item => item.deleted ? null : readFile(item.absolute))),
      bytes, 'reconstruction must not write worktree bytes');
    return { result, current: before };
  };
  return { workspace, put, original, project };
}

for (const [label, profile, changedPath, change] of [
  ['added frontend file', 'backend-test-class', addedFrontend, f => f.put(addedFrontend, 'export const added = 2;\n')],
  ['modified tracked frontend file', 'backend-module-test', h5Frontend, f => f.put(h5Frontend, 'export const h5 = 3;\n')],
  ['deleted tracked frontend file', 'backend-module-compile', frontend, f => rm(path.join(f.workspace, frontend))],
]) {
  test(`backend source reconstruction preserves the original full fingerprint after ${label}`, async t => {
    const f = await fixture(t);
    const original = await f.original();
    await change(f);
    const { result, current } = await f.project(original, profile);
    assert.notEqual(current.workspaceFingerprint, original.source.workspaceFingerprint);
    assert.equal(result?.reconstructedFingerprint, original.source.workspaceFingerprint);
    assert.equal(result?.currentFingerprint, current.workspaceFingerprint);
    assert.equal(result?.profile, profile);
    assert.deepEqual(result?.frontendPaths, [changedPath]);
  });
}

for (const [label, changedPath, contents] of [
  ['backend source', backend, 'class Example { int value = 9; }\n'],
  ['root build configuration', 'build.config.js', 'export default { changed: true };\n'],
  ['dependency manifest', 'forge-server/pom.xml', '<project><name>changed</name></project>\n'],
]) {
  test(`backend source reconstruction rejects additional ${label} changes`, async t => {
    const f = await fixture(t);
    const original = await f.original();
    await f.put(addedFrontend, 'export const added = 2;\n');
    await f.put(changedPath, contents);
    assert.equal((await f.project(original, 'backend-test-class')).result, null);
  });
}

test('backend source reconstruction rejects RED and non-backend profiles', async t => {
  const f = await fixture(t);
  const original = await f.original();
  await f.put(addedFrontend, 'export const added = 2;\n');
  for (const profile of ['backend-red-test', 'frontend-admin-test', 'governance']) {
    assert.equal((await f.project(original, profile)).result, null, profile);
  }
});

test('backend source reconstruction refuses an unproven old dirty frontend baseline', async t => {
  const f = await fixture(t);
  await f.put(frontend, 'export const existing = 7;\n');
  const original = await f.original();
  await f.put(addedFrontend, 'export const added = 2;\n');
  assert.equal((await f.project(original, 'backend-test-class')).result, null);
});

test('backend source reconstruction refuses lossy UTF-8 decoding of an original frontend blob', async t => {
  const f = await fixture(t, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
  const original = await f.original();
  await f.put(frontend, 'export const replacement = true;\n');
  assert.equal((await f.project(original, 'backend-test-class')).result, null);
});
