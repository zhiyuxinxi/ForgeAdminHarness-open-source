import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConversationOutputStore } from '../docker/harness/conversation-output-store.mjs';
import { projectConversationOutput } from '../docker/harness/conversation-output-projection.mjs';

const scope = { scopeType: 'taskspace-private', projectSlug: 'forge-demo', taskspaceId: 'task-1', actorId: 'alice', conversationId: 'conversation-1' };
const digest = 'a'.repeat(64);
function snapshot(overrides = {}) {
  return { schemaVersion: 'forge-conversation-output/v1', sessionId: 'session-1', status: 'completed',
    firstSeq: 1, lastSeq: 2, eventCount: 2, eventDigest: digest,
    entries: [{ seq: 1, type: 'message', role: 'user', text: '请给出方案' },
      { seq: 2, type: 'message', role: 'assistant', text: '完整中文结果\n第二行' }],
    files: [{ name: '方案.md', mediaType: 'text/markdown; charset=utf-8', content: '# 附件\n内容' }], ...overrides };
}
async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-output-store-'));
  const store = createConversationOutputStore({ root, scope, ...options });
  return { root, store };
}

test('saves unicode projection, lists metadata, and reads bytes', async (t) => {
  const { root, store } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const saved = await store.save(snapshot());
  assert.equal(saved.idempotent, false);
  const page = await store.list({ sessionId: 'session-1' });
  assert.equal(page.items.length, 1); assert.equal(page.items[0].scope.conversationId, scope.conversationId);
  const output = await store.read({ sessionId: 'session-1', snapshotId: saved.snapshotId, name: 'conversation.md' });
  assert.match(output.buffer.toString('utf8'), /完整中文结果/); assert.equal(output.sha256, saved.manifest.files[0].sha256);
});

test('Chinese list and read labels preserve sealed files, canonical references, and snapshot identity', async (t) => {
  const { root, store } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const source = snapshot();
  const saved = await store.save(source);
  const originalManifest = structuredClone(saved.manifest);
  const directory = path.join(root, 'outputs', source.sessionId, saved.snapshotId);
  const originalNames = (await readdir(directory)).sort();
  const originalBytes = new Map(await Promise.all(originalNames.map(async (name) => [name, await readFile(path.join(directory, name))])));
  const reopened = createConversationOutputStore({ root, scope });
  const listed = (await reopened.list({ sessionId: source.sessionId })).items[0];
  assert.equal(listed.snapshotId, saved.snapshotId);
  assert.deepEqual(listed.files.map((file) => file.name).sort(), originalNames);
  assert.equal(listed.files.find((file) => file.name === 'conversation.md').displayName, '对话全文.md');
  assert.equal(listed.files.find((file) => file.name === 'manifest.json').displayName, '归档文件清单.json');
  for (const file of listed.files) {
    assert.equal(file.phaseLabel, '对话记录（未关联阶段）');
    assert.match(file.downloadName, /^对话记录_/u);
    assert.match(file.modelPath, new RegExp(`/outputs/${source.sessionId}/${saved.snapshotId}/`));
    assert.ok(file.modelPath.endsWith(`/${file.name}`));
    const read = await reopened.read({ sessionId: source.sessionId, snapshotId: saved.snapshotId, name: file.name });
    assert.equal(read.name, file.name);
    assert.equal(read.displayName, file.displayName);
    assert.equal(read.downloadName, file.downloadName);
    assert.equal(read.versionLabel, file.versionLabel);
    assert.equal(read.primary, file.primary);
    assert.deepEqual(read.buffer, originalBytes.get(file.name));
    assert.equal(read.sha256, file.sha256);
    assert.equal(createHash('sha256').update(read.buffer).digest('hex'), file.sha256);
    assert.equal(read.buffer.length, file.bytes);
  }
  const storedManifest = JSON.parse(originalBytes.get('manifest.json'));
  assert.deepEqual(storedManifest, originalManifest);
  assert.ok(storedManifest.files.every((file) => !Object.hasOwn(file, 'displayName') && !Object.hasOwn(file, 'downloadName')));
  const savedAgain = await reopened.save(source);
  assert.equal(savedAgain.idempotent, true);
  assert.equal(savedAgain.snapshotId, saved.snapshotId);
  assert.deepEqual(savedAgain.manifest, originalManifest);
  assert.deepEqual((await readdir(directory)).sort(), originalNames);
  for (const [name, bytes] of originalBytes) assert.deepEqual(await readFile(path.join(directory, name)), bytes);
});

test('same input is idempotent under concurrent saves', async (t) => {
  const { root, store } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const results = await Promise.all(Array.from({ length: 8 }, () => store.save(snapshot())));
  assert.equal(new Set(results.map((item) => item.snapshotId)).size, 1);
  assert.equal(results.filter((item) => !item.idempotent).length, 1);
  assert.equal((await store.list()).items.length, 1);
});

test('read-only listing does not create storage and accepts a redacted history projection', async (t) => {
  const { root, store } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual((await store.list()).items, []);
  await assert.rejects(lstat(path.join(root, 'outputs')), { code: 'ENOENT' });
  const projected = projectConversationOutput({ session: { sessionId: 'session-1', cwd: '/workspace', running: false },
    events: [{ seq: 1, type: 'request/header', data: { header: { token: 'hidden' } } },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完整中文内容' }] } } },
      { seq: 3, type: 'request/context', data: {} }] });
  const saved = await store.save(projected);
  assert.equal(saved.manifest.eventCount, 3);
  const manifest = await store.read({ sessionId: 'session-1', snapshotId: saved.snapshotId, name: 'manifest.json' });
  assert.equal(JSON.parse(manifest.buffer).snapshotId, saved.snapshotId);
  assert.ok((await store.list()).items[0].files.some((file) => file.name === 'manifest.json'));
  await mkdir(path.join(root, 'outputs', 'session-1', `.stage-${digest}-00000000-0000-0000-0000-000000000000`));
  assert.equal((await store.list()).items.length, 1);
});

test('failed and stopped snapshots are retained independently', async (t) => {
  const { root, store } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const failed = await store.save(snapshot({ status: 'failed' }));
  const stopped = await store.save(snapshot({ status: 'stopped', eventDigest: 'b'.repeat(64) }));
  assert.notEqual(failed.snapshotId, stopped.snapshotId);
  assert.deepEqual(new Set((await store.list()).items.map((item) => item.status)), new Set(['failed', 'stopped']));
});

test('rejects manifest state and history boundary drift on read and list', async (t) => {
  const { root, store } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const saved = await store.save(snapshot({ status: 'failed' }));
  const manifestPath = path.join(root, 'outputs', 'session-1', saved.snapshotId, 'manifest.json');
  const changes = { status: 'completed', sessionId: 'session-other', firstSeq: 0,
    lastSeq: 3, eventCount: 3, eventDigest: 'b'.repeat(64) };
  for (const [field, value] of Object.entries(changes)) {
    await t.test(field, async () => {
      await writeFile(manifestPath, `${JSON.stringify({ ...saved.manifest, [field]: value }, null, 2)}\n`);
      const rejected = (error) => ['OUTPUT_MANIFEST_DRIFT', 'OUTPUT_SCOPE_MISMATCH'].includes(error.code);
      await Promise.all([
        assert.rejects(store.read({ sessionId: 'session-1', snapshotId: saved.snapshotId, name: 'conversation.md' }), rejected),
        assert.rejects(store.list(), rejected),
      ]);
    });
  }
});

test('rejects traversal, reserved and duplicate file names', async (t) => {
  const { root, store } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(store.save(snapshot({ files: [{ name: '../x.md', mediaType: 'text/markdown', content: 'x' }] })), /invalid/iu);
  await assert.rejects(store.save(snapshot({ files: [{ name: 'manifest.json', mediaType: 'application/json', content: '{}' }] })), /reserved/iu);
  await assert.rejects(store.save(snapshot({ files: [{ name: 'x.txt', mediaType: 'text/plain', content: '1' }, { name: 'x.txt', mediaType: 'text/plain', content: '2' }] })), /duplicated/iu);
});

test('detects content hash tampering and symbolic members', async (t) => {
  const { root, store } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const saved = await store.save(snapshot());
  const directory = path.join(root, 'outputs', 'session-1', saved.snapshotId);
  await writeFile(path.join(directory, 'conversation.md'), 'tampered');
  await assert.rejects(store.read({ sessionId: 'session-1', snapshotId: saved.snapshotId, name: 'conversation.md' }), /differs/iu);
  await rm(path.join(directory, 'conversation.md'));
  try { await symlink(path.join(directory, 'conversation.json'), path.join(directory, 'conversation.md')); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(store.list(), /unsafe/iu);
});

test('rejects hard-linked members', async (t) => {
  const { root, store } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const saved = await store.save(snapshot());
  const directory = path.join(root, 'outputs', 'session-1', saved.snapshotId);
  await rm(path.join(directory, 'conversation.md'));
  await link(path.join(directory, 'conversation.json'), path.join(directory, 'conversation.md'));
  await assert.rejects(store.list(), /unsafe/iu);
});

test('rejects a snapshot created under another server scope', async (t) => {
  const { root, store } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const saved = await store.save(snapshot());
  const other = createConversationOutputStore({ root, scope: { ...scope, conversationId: 'conversation-2' } });
  await assert.rejects(other.read({ sessionId: 'session-1', snapshotId: saved.snapshotId, name: 'conversation.json' }), /scope/iu);
});

test('quota reservation is released on failure and concurrent loser', async (t) => {
  let reserved = 0; let released = 0;
  const { root, store } = await fixture({ reserveBytes: async (bytes) => { reserved += bytes; }, releaseBytes: async (bytes) => { released += bytes; } });
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([store.save(snapshot()), store.save(snapshot())]);
  assert.ok(reserved > 0); assert.ok(released > 0); assert.ok(reserved > released);
  const rejecting = createConversationOutputStore({ root, scope, maxBytes: 4,
    reserveBytes: async () => assert.fail('oversize must fail before reservation'), releaseBytes: async () => {} });
  await assert.rejects(rejecting.save(snapshot({ eventDigest: 'c'.repeat(64) })), /size limit/iu);
});

test('empty store and empty snapshot are normal', async (t) => {
  const { root, store } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await store.list(), { items: [], offset: 0, limit: 20, hasMore: false });
  const saved = await store.save(snapshot({ status: 'empty', firstSeq: 0, lastSeq: 0, eventCount: 0, entries: [], files: [] }));
  assert.equal(saved.manifest.status, 'empty');
});

test('rejects unsafe root and session directory links', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'forge-output-link-')); t.after(() => rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, 'target'); await mkdir(target); const linked = path.join(parent, 'linked');
  try { await symlink(target, linked, 'dir'); } catch (error) { if (error.code === 'EPERM') return; throw error; }
  const badRoot = createConversationOutputStore({ root: linked, scope });
  await assert.rejects(badRoot.list(), /unsafe/iu);
});
