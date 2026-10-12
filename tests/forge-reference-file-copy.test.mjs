import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { referenceCopyPaths, copyReferenceFile, registerReferenceCopyTool } from '../docker/harness/forge-typed-file-removal.mjs';

const linux = process.platform === 'linux';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const version = (s) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const errorCode = (code) => (error) => error.code === code;

async function fixture(t, bytes = Buffer.from('\ufeffpackage example;\r\n// 原字节\r\n')) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-reference-copy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputRoot = `${root}/inputs`, workspaceRoot = `${root}/workspace`;
  await mkdir(`${inputRoot}/incoming/batch`, { recursive: true });
  await mkdir(`${workspaceRoot}/src/test`, { recursive: true });
  const source = `${inputRoot}/incoming/batch/original.java.txt`;
  const destination = `${workspaceRoot}/src/test/Example.java`;
  await writeFile(source, bytes);
  await writeFile(destination, 'previous candidate\n');
  const observations = new Map([[source, version(await stat(source, { bigint: true }))],
    [destination, version(await stat(destination, { bigint: true }))]]);
  const writes = [], events = [];
  const exec = { agent: { session: { id: 'one-session' } }, signal: new AbortController().signal };
  const ctx = {
    sandboxPolicy: { resolve: ({ session }) => {
      assert.equal(session, exec.agent.session); return { mode: 'workspace-write', workspaceRoot };
    } },
    fs: {
      resolve: async (value) => ({ displayPath: value }), processPath: (target) => target.displayPath,
      stat: async (target) => ({ version: version(await stat(target.displayPath, { bigint: true })) }),
      writeText: async (target, content, intent, signal, policy) => {
        assert.equal(policy.workspaceRoot, workspaceRoot); assert.equal(signal, exec.signal);
        assert.equal(target.displayPath, destination);
        const current = version(await stat(destination, { bigint: true }));
        if (!intent || intent.version !== current) throw Object.assign(new Error('unobserved or stale destination'), { code: 'FS_STALE_VERSION' });
        writes.push({ target, content }); await writeFile(destination, content);
        return { operation: 'update', version: version(await stat(destination, { bigint: true })) };
      },
    },
    waterfall: async (name, target, actor) => {
      assert.ok(['fs/edit-intent', 'fs/write-intent'].includes(name)); assert.equal(actor, exec);
      const observed = observations.get(target.displayPath);
      return observed ? { version: observed } : undefined;
    },
    emit: (...args) => events.push(args),
  };
  const args = { source_path: source, file_path: 'src/test/Example.java', source_sha256: sha(bytes) };
  return { root, inputRoot, workspaceRoot, source, destination, bytes, observations, writes, events, ctx, exec, args,
    copy: (overrides = {}) => copyReferenceFile(ctx, { ...args, ...overrides }, exec, { inputRoot, workspaceRoot }),
  };
}

test('copy_file has one exact destination and only a private input source with a pinned digest', () => {
  const args = { file_path: 'src/Test.java', source_path: '/project-inputs/incoming/one/original.txt', source_sha256: 'a'.repeat(64) };
  assert.equal(referenceCopyPaths(args).relative, 'src/Test.java');
  for (const source_path of ['/etc/passwd', '/workspace/src/Test.java', '/project-inputs/../secret', '/project-inputs/.env', '/project-inputs/a/key.pem', '/project-inputs/a//b', '/project-inputs/a\\b']) {
    assert.throws(() => referenceCopyPaths({ ...args, source_path }), errorCode('FORGE_COPY_SOURCE_PATH'));
  }
  for (const file_path of ['../other.java', '/etc/file', '.git/config', 'pom.xml', 'src/key.pem']) {
    assert.throws(() => referenceCopyPaths({ ...args, file_path }), errorCode('FORGE_COPY_DESTINATION_PATH'));
  }
  assert.throws(() => referenceCopyPaths({ ...args, content: 'injected' }), errorCode('FORGE_COPY_ARGUMENTS'));
  assert.throws(() => referenceCopyPaths({ ...args, source_sha256: 'wrong' }), errorCode('FORGE_COPY_ARGUMENTS'));
  let registered;
  registerReferenceCopyTool({ tools: { register: (tool) => { registered = tool; } } }, (tool) => tool);
  assert.equal(registered.name, 'copy_file');
  assert.deepEqual(Object.keys(registered.parameters).sort(), ['file_path', 'source_path', 'source_sha256']);
});

test('copy_file preserves BOM, CRLF and non-ASCII bytes through the observed native writer', { skip: !linux }, async (t) => {
  const f = await fixture(t);
  const result = await f.copy();
  assert.deepEqual(await readFile(f.destination), f.bytes);
  assert.deepEqual(await readFile(f.source), f.bytes);
  assert.equal(result.sourceSha256, sha(f.bytes)); assert.equal(result.bytes, f.bytes.length);
  assert.equal(result.copied, true); assert.equal(result.operation, 'update');
  assert.equal(f.writes.length, 1); assert.equal(f.events[0][0], 'fs/observed');
  assert.equal(f.events[0][2].kind, 'present');
});

test('copy_file rejects digest mismatch, unobserved source, invalid UTF8, NUL and linked sources before writing', { skip: !linux }, async (t) => {
  const wrong = await fixture(t);
  await assert.rejects(wrong.copy({ source_sha256: '0'.repeat(64) }), errorCode('FORGE_COPY_SOURCE_DIGEST'));
  wrong.observations.delete(wrong.source);
  await assert.rejects(wrong.copy(), errorCode('FS_NOT_OBSERVED'));
  assert.equal(wrong.writes.length, 0);
  for (const raw of [Buffer.from([0xff, 0x61]), Buffer.from('text\0text')]) {
    const f = await fixture(t, raw);
    await assert.rejects(f.copy(), errorCode('FORGE_COPY_TEXT_REQUIRED')); assert.equal(f.writes.length, 0);
  }
  const linked = await fixture(t);
  const alias = `${linked.inputRoot}/incoming/batch/alias.txt`;
  await symlink(linked.source, alias); linked.observations.set(alias, linked.observations.get(linked.source));
  await assert.rejects(linked.copy({ source_path: alias }));
  await link(linked.source, `${linked.inputRoot}/incoming/batch/hardlink.txt`);
  await assert.rejects(linked.copy(), errorCode('FORGE_COPY_NOT_REGULAR'));
  assert.equal(linked.writes.length, 0);
});

test('copy_file preserves sandbox, source freshness, destination observation and cancellation boundaries', { skip: !linux }, async (t) => {
  const ro = await fixture(t); ro.ctx.sandboxPolicy.resolve = () => ({ mode: 'read-only', workspaceRoot: ro.workspaceRoot });
  await assert.rejects(ro.copy(), errorCode('FS_SANDBOX_DENIED')); assert.equal(ro.writes.length, 0);
  const staleSource = await fixture(t); staleSource.observations.set(staleSource.source, 'old');
  await assert.rejects(staleSource.copy(), errorCode('FS_STALE_VERSION')); assert.equal(staleSource.writes.length, 0);
  const staleTarget = await fixture(t); await writeFile(staleTarget.destination, 'concurrent work');
  await assert.rejects(staleTarget.copy(), errorCode('FS_STALE_VERSION'));
  assert.equal(await readFile(staleTarget.destination, 'utf8'), 'concurrent work');
  const cancel = await fixture(t); const abort = new AbortController(); abort.abort(); cancel.exec.signal = abort.signal;
  await assert.rejects(cancel.copy(), { name: 'AbortError' }); assert.equal(cancel.writes.length, 0);
});
