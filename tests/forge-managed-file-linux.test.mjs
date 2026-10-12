import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authorizeManagedFileRequest, executeManagedFileOperation, managedFileIntentForPrompt,
  validateManagedFileTargets } from '../docker/harness/forge-managed-files.mjs';

// Run in the existing no-network consumer with a private writable tmpfs at
// /run/forge-managed-files (owned by its non-root UID); never a live target mount.
test('managed local Linux files preserve versions backups and mount boundaries', { skip: process.platform !== 'linux' }, t => {
  const targetId = `test-${randomUUID().slice(0, 12)}`;
  const root = `/run/forge-managed-files/targets/${targetId}`;
  const stateRoot = mkdtempSync(path.join(os.tmpdir(), 'forge-managed-state-'));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(stateRoot, { recursive: true, force: true }); });
  const info = statSync(root); const actor = '11111111-1111-4111-8111-111111111111';
  const config = validateManagedFileTargets({ schemaVersion: 1, projectSlug: 'forge-project', targets: [{
    targetId, name: 'Test only', transport: 'local', serverDirectory: '/data/test-site',
    expectedDevice: info.dev, expectedInode: info.ino, readActorIds: [actor], writeActorIds: [actor],
  }] }, 'forge-project');
  const identity = { projectSlug: 'forge-project', taskId: 'task-001', actorUserId: actor, actorUsername: 'owner',
    conversationId: 'conversation-001', dshSessionId: 'session-001', rpcId: 'rpc-001', promptTextDigest: 'a'.repeat(64) };
  const record = { ...identity, workspaceWriteAuthorized: true, authorizedActionCeiling: 'workspace-write',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    managedFileIntent: managedFileIntentForPrompt('请在 /data/test-site 创建、修改、删除和恢复文件。', config, actor) };
  const invoke = (operation, args = {}, activeConfig = config) => {
    const normalized = { operation, targetId, relativePath: 'index.html', ...args };
    const authorization = authorizeManagedFileRequest({ input: { ...identity, targetId, operation, relativePath: normalized.relativePath }, record, config });
    return executeManagedFileOperation({ args: normalized, authorization, config: activeConfig, stateRoot });
  };
  assert.equal(invoke('read').version, 'absent');
  const created = invoke('write', { content: '<h1>Hello</h1>', expectedVersion: 'absent' });
  assert.equal(readFileSync(`${root}/index.html`, 'utf8'), '<h1>Hello</h1>');
  const changed = invoke('write', { content: '<h1>Changed</h1>', expectedVersion: created.version });
  assert.throws(() => invoke('write', { content: 'stale', expectedVersion: created.version }), { code: 'MANAGED_FILE_STALE' });
  const restored = invoke('restore', { revisionId: changed.revisionId, expectedVersion: changed.version });
  assert.equal(invoke('read').content, '<h1>Hello</h1>');
  const removed = invoke('remove', { expectedVersion: restored.version });
  assert.equal(invoke('read').exists, false);
  invoke('restore', { revisionId: removed.revisionId, expectedVersion: 'absent' });
  assert.equal(invoke('read').content, '<h1>Hello</h1>');
  symlinkSync('/etc/passwd', `${root}/alias.txt`);
  assert.throws(() => invoke('read', { relativePath: 'alias.txt' }));
  mkdirSync(`${root}/nested`); symlinkSync('/etc', `${root}/nested/outside`);
  assert.throws(() => invoke('read', { relativePath: 'nested/outside/passwd' }));
  const before = invoke('read'); writeFileSync(`${root}/index.html`, 'external writer');
  assert.throws(() => invoke('write', { content: 'overwrite', expectedVersion: before.version }), { code: 'MANAGED_FILE_STALE' });
  assert.equal(invoke('read').content, 'external writer');
  const lock = path.join(stateRoot, 'managed-files', targetId, `${createHash('sha256').update('index.html').digest('hex')}.lock`);
  mkdirSync(lock);
  assert.throws(() => invoke('read'), { code: 'MANAGED_FILE_BUSY' });
  assert.equal(statSync(lock).isDirectory(), true, 'another operation lock remains owned by it');
  rmdirSync(lock);
  const wrongRoot = `${root}-replacement`;
  mkdirSync(wrongRoot);
  t.after(() => rmSync(wrongRoot, { recursive: true, force: true }));
  // A newly registered inode is not interchangeable with the actual mount.
  config.targets[0].expectedInode = statSync(wrongRoot).ino;
  record.managedFileIntent = managedFileIntentForPrompt('请读取 /data/test-site 文件。', config, actor);
  assert.throws(() => invoke('read'), { code: 'MANAGED_FILE_MOUNT_MISMATCH' });
});
