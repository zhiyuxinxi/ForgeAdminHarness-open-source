import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, link, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removalPath, removeObservedFile, registerRemovalTool } from '../docker/harness/forge-typed-file-removal.mjs';

const linux = process.platform === 'linux';
const version = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const errorCode = (code) => (error) => error.code === code;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-remove-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(`${root}/src/tests`, { recursive: true });
  const relative = 'src/tests/duplicate.spec.js';
  const file = `${root}/${relative}`;
  const contents = 'test("existing coverage", () => {});\n';
  await writeFile(file, contents);
  let observation = version(await stat(file, { bigint: true }));
  const events = [];
  const exec = { agent: { session: { id: 'session-a' } }, signal: new AbortController().signal };
  const ctx = {
    sandboxPolicy: { resolve: ({ session }) => { assert.equal(session, exec.agent.session); return { mode: 'workspace-write', workspaceRoot: root }; } },
    fs: {
      resolve: async (value) => ({ displayPath: value }),
      processPath: (target) => target.displayPath,
      stat: async (target) => ({ version: version(await stat(target.displayPath, { bigint: true })) }),
    },
    waterfall: async (event, _target, actor) => {
      assert.equal(event, 'fs/edit-intent'); assert.equal(actor, exec);
      return observation === null ? undefined : { version: observation };
    },
    emit: (...args) => events.push(args),
  };
  return { root, file, relative, contents, ctx, exec, events,
    forget: () => { observation = null; },
    remove: (args = { file_path: relative }) => removeObservedFile(ctx, args, exec, { workspaceRoot: root }),
  };
}

test('remove_file exposes one path and rejects recursive, alias and protected arguments', () => {
  assert.deepEqual(removalPath({ file_path: '/workspace/src/tests/one.spec.js' }), {
    relative: 'src/tests/one.spec.js', absolute: '/workspace/src/tests/one.spec.js',
  });
  for (const file_path of ['../outside.js', 'src/../outside.js', '/elsewhere/a.js', '.git/config', 'src/.env', 'src//a.js', 'src\\a.js', 'src/a.js\n', 'src/./a.js']) {
    assert.throws(() => removalPath({ file_path }), errorCode('FORGE_REMOVE_PATH'));
  }
  for (const file_path of ['package.json', 'pnpm-lock.yaml', 'pom.xml', 'src/AGENTS.md', 'jsconfig.json', 'src/client.key']) {
    assert.throws(() => removalPath({ file_path }), errorCode('FORGE_REMOVE_PROTECTED'));
  }
  assert.throws(() => removalPath({ file_path: 'src/a.js', recursive: true }), errorCode('FORGE_REMOVE_ARGUMENTS'));
  let registered;
  registerRemovalTool({ tools: { register: (tool) => { registered = tool; } } }, (tool) => tool);
  assert.equal(registered.name, 'remove_file');
  assert.deepEqual(Object.keys(registered.parameters), ['file_path']);
});

test('remove_file deletes the observed ordinary file and records absence and exact prior digest', { skip: !linux }, async (t) => {
  const f = await fixture(t);
  const result = await f.remove();
  assert.deepEqual(result, { path: f.relative, deleted: true, previousSha256: createHash('sha256').update(f.contents).digest('hex') });
  await assert.rejects(readFile(f.file), errorCode('ENOENT'));
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0][0], 'fs/observed');
  assert.deepEqual(f.events[0][2], { kind: 'absent' });
  assert.equal(f.events[0][3], f.exec);
  await assert.rejects(f.remove());
});

test('remove_file refuses unread, stale and concurrently replaced files without mutation', { skip: !linux }, async (t) => {
  const f = await fixture(t);
  f.forget();
  await assert.rejects(f.remove(), errorCode('FS_NOT_OBSERVED'));
  assert.equal(await readFile(f.file, 'utf8'), f.contents);
  const stale = await fixture(t);
  await writeFile(stale.file, 'changed by another action');
  await assert.rejects(stale.remove(), errorCode('FS_STALE_VERSION'));
  assert.equal(await readFile(stale.file, 'utf8'), 'changed by another action');
  const race = await fixture(t);
  const originalStat = race.ctx.fs.stat;
  race.ctx.fs.stat = async (target) => {
    const before = await originalStat(target);
    await writeFile(race.file, 'concurrent replacement');
    return before;
  };
  await assert.rejects(race.remove(), errorCode('FS_STALE_VERSION'));
  assert.equal(await readFile(race.file, 'utf8'), 'concurrent replacement');
  assert.equal(race.events.length, 0);
  const large = await fixture(t);
  await truncate(large.file, 8 * 1024 * 1024 + 1);
  await assert.rejects(large.remove(), errorCode('FS_TOO_LARGE'));
  assert.equal((await stat(large.file)).size, 8 * 1024 * 1024 + 1);
  assert.equal(large.events.length, 0);
});

test('remove_file refuses directories, symlinks, symlink parents and hardlinks', { skip: !linux }, async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.remove({ file_path: 'src/tests' }), errorCode('FORGE_REMOVE_NOT_REGULAR'));
  await symlink(f.file, `${f.root}/src/alias.js`);
  await assert.rejects(f.remove({ file_path: 'src/alias.js' }));
  await symlink(`${f.root}/src/tests`, `${f.root}/linked`);
  await assert.rejects(f.remove({ file_path: 'linked/duplicate.spec.js' }));
  await link(f.file, `${f.root}/src/linked.js`);
  await assert.rejects(f.remove(), errorCode('FORGE_REMOVE_NOT_REGULAR'));
  assert.equal(await readFile(f.file, 'utf8'), f.contents);
  assert.equal(f.events.length, 0);
});

test('remove_file honors session sandbox, resolved identity and cancellation', { skip: !linux }, async (t) => {
  const f = await fixture(t);
  const originalPolicy = f.ctx.sandboxPolicy.resolve;
  f.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only', workspaceRoot: f.root });
  await assert.rejects(f.remove(), errorCode('FS_SANDBOX_DENIED'));
  f.ctx.sandboxPolicy.resolve = () => ({ mode: 'workspace-write', workspaceRoot: '/other-workspace' });
  await assert.rejects(f.remove(), errorCode('FS_SANDBOX_DENIED'));
  f.ctx.sandboxPolicy.resolve = originalPolicy;
  f.ctx.fs.processPath = () => '/other-workspace/aliased.js';
  await assert.rejects(f.remove(), errorCode('FORGE_REMOVE_PATH'));
  f.ctx.fs.processPath = (target) => target.displayPath;
  const abort = new AbortController(); abort.abort(); f.exec.signal = abort.signal;
  await assert.rejects(f.remove(), { name: 'AbortError' });
  assert.equal(await readFile(f.file, 'utf8'), f.contents);
  assert.equal(f.events.length, 0);
});
