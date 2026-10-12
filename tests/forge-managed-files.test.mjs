import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  MANAGED_FILE_LIMIT,
  authorizeManagedFileRequest,
  loadManagedFileTargets,
  managedFileIntentForPrompt,
  managedFileRelativePath,
  managedFileTargetList,
  validateManagedFileArguments,
  validateManagedFileTargets,
} from '../docker/harness/forge-managed-files.mjs';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const READER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-10-10T00:00:00.000Z');
const target = (changes = {}) => ({ targetId: 'reports', name: '项目文件', transport: 'local',
  serverDirectory: '/data/reports', expectedDevice: 1, expectedInode: 2,
  readActorIds: [ACTOR, READER], writeActorIds: [ACTOR], ...changes });
const configuration = (targets = [target()]) => validateManagedFileTargets({ schemaVersion: 1,
  projectSlug: 'forge-base', targets }, 'forge-base');
const fails = (fn, code) => assert.throws(fn, error => error?.code === code);

function request(prompt = '请修改 /data/reports/index.html。', config = configuration()) {
  const identity = { projectSlug: 'forge-base', taskId: 'task-managed', actorUserId: ACTOR,
    actorUsername: 'owner', conversationId: 'conversation:one', dshSessionId: 'session:one',
    rpcId: 'rpc:one', promptTextDigest: 'a'.repeat(64) };
  const input = { ...identity, targetId: 'reports', operation: 'write', relativePath: 'index.html' };
  const record = { ...identity, workspaceWriteAuthorized: true, authorizedActionCeiling: 'workspace-write',
    expiresAt: new Date(NOW + 60_000).toISOString(),
    managedFileIntent: managedFileIntentForPrompt(prompt, config, ACTOR) };
  return { input, record, config, now: NOW };
}

test('managed file configuration accepts only explicit local project targets and account lists', () => {
  const config = configuration();
  assert.deepEqual(managedFileTargetList(config, OTHER).targets, []);
  assert.equal(managedFileTargetList(config, ACTOR).targets[0].write, true);
  assert.equal(managedFileTargetList(config, READER).targets[0].write, false);
  assert.equal(managedFileTargetList(config, ACTOR).targets[0].requiresExplicitRequest, true);
  for (const transport of ['ssh', 'http', 'docker']) {
    fails(() => configuration([target({ transport })]), 'MANAGED_FILE_CONFIG');
  }
  fails(() => validateManagedFileTargets(config, 'another-project'), 'MANAGED_FILE_CONFIG');
  fails(() => configuration([target(), target()]), 'MANAGED_FILE_CONFIG');
  fails(() => configuration([target({ readActorIds: [ACTOR, ACTOR] })]), 'MANAGED_FILE_CONFIG');
  fails(() => configuration([target({ readActorIds: [READER], writeActorIds: [ACTOR] })]), 'MANAGED_FILE_CONFIG');
  fails(() => configuration([target({ readActorIds: ['*'] })]), 'MANAGED_FILE_CONFIG');
  fails(() => configuration([target({ shell: '/bin/sh' })]), 'MANAGED_FILE_SCHEMA');
});

test('managed file registry rejects system roots aliases and model-selected config mounts', () => {
  for (const serverDirectory of ['/', '/srv', '/data', '/mnt', '/etc/config', '/root/files', '/home/user',
    '/proc/self', '/sys/config', '/dev/shm', '/var/lib/app', '/srv/forge-delivery', '/srv/forge-delivery/projects/other',
    '/data/reports/../other', '/data//reports', '/data/reports/', '/data/.private', 'data/reports']) {
    fails(() => configuration([target({ serverDirectory })]), 'MANAGED_FILE_CONFIG');
  }
  assert.deepEqual(loadManagedFileTargets('forge-base', '').targets, []);
  fails(() => loadManagedFileTargets('forge-base', '/workspace/targets.json'), 'MANAGED_FILE_CONFIG');
  // Realpath, symlink, file type and root ownership checks require the separate Linux fixture.
});

test('managed file direct prompt derives exact file or explicitly named directory authority', () => {
  const config = configuration();
  const exact = managedFileIntentForPrompt('本次请修改 `/data/reports/index.html`。', config, ACTOR);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].relativePath, 'index.html');
  assert.deepEqual(exact[0].operations, ['read', 'write']);
  const root = managedFileIntentForPrompt('请在 /data/reports 下新建文件。', config, ACTOR);
  assert.equal(root.length, 1);
  assert.equal(root[0].relativePath, '');
  assert.deepEqual(root[0].operations, ['read', 'write']);
  assert.deepEqual(managedFileIntentForPrompt('请修改当前 Forge 的 index.html。', config, ACTOR), []);
  assert.deepEqual(managedFileIntentForPrompt('请修改 /data/reports-backup/index.html。', config, ACTOR), []);
  assert.deepEqual(managedFileIntentForPrompt('请修改 /data/reports/index.html。', config, OTHER), []);
  assert.deepEqual(managedFileIntentForPrompt('请修改 /data/reports/index.html。', config, READER)[0].operations, ['read']);
});

test('managed file negative quoted hypothetical and question prompts do not authorize a target', () => {
  for (const prompt of [
    '不要修改 /data/reports/index.html。', '本次不授权修改 /data/reports/index.html。',
    '如果以后需要，请修改 /data/reports/index.html。', '假设我要修改 /data/reports/index.html。',
    '能否修改 /data/reports/index.html？', '可以帮我修改 /data/reports/index.html 吗',
    '示例：请修改 /data/reports/index.html。', '这里只记录原话：请修改 /data/reports/index.html。',
    '引用：\n请修改 /data/reports/index.html。', '“请修改 /data/reports/index.html。”',
    '> 请修改 /data/reports/index.html。', '```text\n请修改 /data/reports/index.html。\n```',
    '上一轮已经授权修改 /data/reports/index.html。', '上次让你修改 /data/reports/index.html，现在仅分析。',
  ]) {
    assert.deepEqual(managedFileIntentForPrompt(prompt, configuration(), ACTOR), [], prompt);
  }
});

test('managed file operations derive independently and never imply delete or restore from write', () => {
  const config = configuration();
  for (const [verb, expected] of [['查看', ['read']], ['修改', ['read', 'write']],
    ['删除', ['read', 'remove']], ['恢复', ['read', 'restore']]]) {
    assert.deepEqual(managedFileIntentForPrompt(`请${verb} /data/reports/index.html。`, config, ACTOR)[0].operations, expected);
  }
  const value = request();
  assert.equal(authorizeManagedFileRequest(value).operation, 'write');
  for (const operation of ['remove', 'restore']) {
    fails(() => authorizeManagedFileRequest({ ...value, input: { ...value.input, operation } }), 'MANAGED_FILE_EXPLICIT_REQUEST_REQUIRED');
  }
});

test('managed file authorization binds actor project request identity time and account ceiling', () => {
  const value = request();
  const authorized = authorizeManagedFileRequest(value);
  assert.equal(authorized.actorUserId, ACTOR);
  assert.equal(authorized.rpcId, value.input.rpcId);
  assert.equal(authorized.relativePath, 'index.html');
  for (const [key, replacement] of [['projectSlug', 'another-project'], ['taskId', 'task-old'], ['actorUserId', OTHER],
    ['actorUsername', 'other'], ['conversationId', 'conversation:other'], ['dshSessionId', 'session:other'],
    ['rpcId', 'rpc:old'], ['promptTextDigest', 'b'.repeat(64)]]) {
    fails(() => authorizeManagedFileRequest({ ...value, input: { ...value.input, [key]: replacement } }), 'MANAGED_FILE_AUTHORITY');
  }
  for (const patch of [{ expiresAt: new Date(NOW).toISOString() }, { expiresAt: 'invalid' },
    { workspaceWriteAuthorized: false }, { authorizedActionCeiling: 'read-only' }]) {
    fails(() => authorizeManagedFileRequest({ ...value, record: { ...value.record, ...patch } }), 'MANAGED_FILE_AUTHORITY');
  }
  const reader = { ...value, input: { ...value.input, actorUserId: READER },
    record: { ...value.record, actorUserId: READER } };
  fails(() => authorizeManagedFileRequest(reader), 'MANAGED_FILE_AUTHORITY');
});

test('managed file read-only account may read its explicitly requested target but cannot mutate it', () => {
  const value = request('请读取 /data/reports/index.html。');
  value.input.actorUserId = value.record.actorUserId = READER;
  value.input.operation = 'read';
  value.record.workspaceWriteAuthorized = false;
  value.record.authorizedActionCeiling = 'read-only';
  value.record.managedFileIntent = managedFileIntentForPrompt('请读取 /data/reports/index.html。', value.config, READER);
  assert.equal(authorizeManagedFileRequest(value).operation, 'read');
  for (const operation of ['write', 'remove', 'restore']) {
    fails(() => authorizeManagedFileRequest({ ...value, input: { ...value.input, operation } }), 'MANAGED_FILE_AUTHORITY');
  }
  fails(() => authorizeManagedFileRequest({ ...value, input: { ...value.input, relativePath: 'other.html' } }), 'MANAGED_FILE_EXPLICIT_REQUEST_REQUIRED');
});

test('managed file saved intent cannot be supplied by a model or carried into a new request', () => {
  const value = request();
  for (const extra of [{ promptText: '请修改 /data/reports/index.html。' },
    { managedFileIntent: value.record.managedFileIntent }, { serverDirectory: '/data/reports' }, { scopeRoot: '/' }]) {
    fails(() => authorizeManagedFileRequest({ ...value, input: { ...value.input, ...extra } }), 'MANAGED_FILE_SCHEMA');
  }
  const next = request('请修改当前 Forge 的 README.md。');
  next.input.rpcId = next.record.rpcId = 'rpc:next';
  fails(() => authorizeManagedFileRequest(next), 'MANAGED_FILE_EXPLICIT_REQUEST_REQUIRED');
  fails(() => authorizeManagedFileRequest({ ...value, record: { ...value.record, managedFileIntent: [] } }), 'MANAGED_FILE_EXPLICIT_REQUEST_REQUIRED');
  for (const relativePath of ['other.html', 'index.html/child.txt']) {
    fails(() => authorizeManagedFileRequest({ ...value, input: { ...value.input, relativePath } }), 'MANAGED_FILE_EXPLICIT_REQUEST_REQUIRED');
  }
  const directory = request('请在 /data/reports 下新建文件。');
  assert.equal(authorizeManagedFileRequest({ ...directory, input: { ...directory.input, relativePath: 'nested/report.txt' } }).relativePath, 'nested/report.txt');
});

test('managed file target registry changes invalidate saved intent and cannot select another target', () => {
  const value = request();
  const changed = configuration([target({ serverDirectory: '/data/reports-new' })]);
  fails(() => authorizeManagedFileRequest({ ...value, config: changed }), 'MANAGED_FILE_EXPLICIT_REQUEST_REQUIRED');
  const revoked = configuration([target({ writeActorIds: [] })]);
  fails(() => authorizeManagedFileRequest({ ...value, config: revoked }), 'MANAGED_FILE_AUTHORITY');
  const both = configuration([target(), target({ targetId: 'other', serverDirectory: '/data/other' })]);
  const original = request('请修改 /data/reports/index.html。', both);
  fails(() => authorizeManagedFileRequest({ ...original, input: { ...original.input, targetId: 'other' } }), 'MANAGED_FILE_EXPLICIT_REQUEST_REQUIRED');
});

test('managed file paths reject traversal credentials hidden files database wildcard and encoded aliases', () => {
  for (const file of ['index.html', 'nested/说明.md', 'source/example.py']) assert.equal(managedFileRelativePath(file), file);
  for (const file of ['', '.', '..', '../file.txt', 'nested/../file.txt', '/etc/passwd', 'C:/file.txt', 'a\\file.txt',
    'a//b.txt', 'a/./b.txt', ' file.txt', 'file.txt ', 'a\nfile.txt', '.env', '.git/config', '.forge-state/value',
    'id_rsa', 'nested/credentials.json', 'nested/private-key.txt', 'key.pem', 'data.sqlite3', 'database.db',
    '*.html', 'a?[x].txt', '{a,b}.txt', 'a/%2e%2e/file.txt', 'a/%2Fetc/passwd', 'a/%252e%252e/file.txt']) {
    fails(() => managedFileRelativePath(file), 'MANAGED_FILE_PATH');
  }
});

test('managed file arguments accept bounded text and explicit revisions without command or root fields', () => {
  const write = { operation: 'write', targetId: 'reports', relativePath: 'index.html', content: '<p>说明</p>', expectedVersion: 'absent' };
  assert.deepEqual(validateManagedFileArguments(write), write);
  assert.deepEqual(validateManagedFileArguments({ operation: 'targets' }), { operation: 'targets' });
  for (const extra of [{ command: 'whoami' }, { serverDirectory: '/etc' }, { promptText: 'authorized' }, { actorUserId: OTHER }]) {
    fails(() => validateManagedFileArguments({ ...write, ...extra }), 'MANAGED_FILE_SCHEMA');
  }
  fails(() => validateManagedFileArguments({ ...write, expectedVersion: undefined }), 'MANAGED_FILE_VERSION');
  fails(() => validateManagedFileArguments({ ...write, content: '中'.repeat(MANAGED_FILE_LIMIT) }), 'MANAGED_FILE_SIZE');
  fails(() => validateManagedFileArguments({ ...write, content: '\0binary' }), 'MANAGED_FILE_SIZE');
  fails(() => validateManagedFileArguments({ operation: 'restore', targetId: 'reports', relativePath: 'index.html',
    expectedVersion: 'a'.repeat(64), revisionId: '../../backup' }), 'MANAGED_FILE_SCHEMA');
});


test('managed file adjacent explicit directory request preserves the proof request and refuses unsafe carry', () => {
  const directory = '/srv/forge-delivery/file-gateway/data/forge-base/harness-file-proof-20261010';
  const config = configuration([target({ targetId: 'file-proof-20261010', serverDirectory: directory })]);
  const prompt = readFileSync(new URL('./fixtures/managed-directory-proof-20261010.txt', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
  const grants = managedFileIntentForPrompt(prompt, config, ACTOR);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].relativePath, 'backend-file-proof-20261010.txt');
  assert.deepEqual(grants[0].operations, ['read', 'write', 'remove']);
  assert.deepEqual(managedFileIntentForPrompt(prompt, config, OTHER), []);
  assert.deepEqual(managedFileIntentForPrompt(prompt, config, READER)[0].operations, ['read']);
  const anchor = `请验证本次明确指定的目录 ${directory}。`;
  const action = '只在这个目录内新建文件 proof.txt。';
  for (const invalid of [anchor, `不要验证目录 ${directory}。${action}`, `“${anchor}”${action}`,
    `引用：${anchor}${action}`, `引用：\n${anchor}${action}`, `指定目录 ${directory} 吗。${action}`,  `如果指定目录 ${directory}。${action}`,
    `${anchor}本次只读。${action}`, `${anchor}这是其他话题。${action}`,
    `${anchor}“其他说明”${action}`, `${anchor}只在这个目录内不要新建文件 proof.txt。`,
    `${anchor}只在这个目录内新建文件 proof.txt 并写入 /data/other。`,
    `指定目录 ${directory} 和 /data/other。${action}`, `指定目录 /data/unregistered。${action}`]) {
    assert.deepEqual(managedFileIntentForPrompt(invalid, config, ACTOR), [], invalid);
  }
});
