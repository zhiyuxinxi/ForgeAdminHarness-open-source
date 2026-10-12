import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chown, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { executeForgeWriterScopeLease, recoverForgeWriterScopeLease, hasActiveForgeTaskWriter } from '../docker/harness/forge-writer-scope-lease.mjs';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const identityKeys = ['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest', 'executionId', 'generation', 'contractId'];
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function deathProof(generation = 1) {
  return { schemaVersion: 1, containerId: 'e'.repeat(64), startedAt: new Date(NOW - 60_000).toISOString(),
    finishedAt: '2026-10-02T12:00:00.123456789Z', removed: true, fenceEpoch: 'recovery-1',
    evidenceSha256: 'f'.repeat(64), toolResult: 'unknown', revokedThroughGeneration: generation };
}

async function fixture(t) {
  const projectRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forge-writer-scope-')));
  t.after(async () => {
    assert.ok(path.basename(projectRoot).startsWith('forge-writer-scope-'));
    await rm(projectRoot, { recursive: true, force: true });
  });
  const statePath = path.join(projectRoot, 'taskspaces', '.broker', 'writer-scope-leases.json');
  async function owner(name, ownedPaths = ['src/shared']) {
    const taskMetadata = { projectSlug: 'lease-project', taskId: `task-${name}`, actorUserId: randomUUID(), conversationId: `conversation-${name}`, status: 'active' };
    const workspace = path.join(projectRoot, 'taskspaces', taskMetadata.taskId, 'workspace');
    await mkdir(path.join(workspace, 'src', 'shared'), { recursive: true });
    await writeFile(path.join(workspace, 'src', 'shared', 'value.txt'), 'before');
    const context = { ...taskMetadata, dshSessionId: `session-${name}`, rpcId: `rpc-${name}`, textDigest: 'a'.repeat(64),
      executionId: randomUUID(), generation: 1, contractId: 'b'.repeat(64), authorityClass: 'production-task-writer',
      testOnly: false, actionCeiling: 'workspace-write', sourceCommit: 'c'.repeat(40), workspaceFingerprint: 'd'.repeat(64),
      issuedAt: new Date(NOW - 1000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(), ownedPaths: [...ownedPaths],
      contract: { contractId: 'b'.repeat(64), actionCeiling: 'workspace-write', ownedPaths: [...ownedPaths] } };
    return { taskMetadata, workspace, context };
  }
  function request(subject, callId = 'call-1', filePath = 'src/shared/value.txt', toolName = 'edit') {
    return { action: 'writer-scope-lease', operation: 'acquire',
      ...Object.fromEntries(identityKeys.map((key) => [key, subject.context[key]])), callId, toolName, filePath };
  }
  const run = (subject, request, extra = {}) => executeForgeWriterScopeLease({ projectRoot, taskMetadata: subject.taskMetadata,
    workspace: subject.workspace, request, readContext: async () => subject.context, now: NOW, ...extra });
  const settle = (subject, acquiredRequest, permit, extra = {}) => run(subject,
    { ...acquiredRequest, operation: 'settle', permitId: permit.permitId }, extra);
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const recover = (subject, permit, extra = {}) => recoverForgeWriterScopeLease({ projectRoot,
    taskMetadata: subject.taskMetadata, workspace: subject.workspace, permitId: permit.permitId,
    expectedExecutionId: subject.context.executionId, expectedGeneration: subject.context.generation,
    verifyQuiescence: async () => deathProof(subject.context.generation), now: NOW + 1000, ...extra });
  return { projectRoot, statePath, owner, request, run, settle, state, recover };
}

test('cancelled acquisition settles only its exact capability and rejects a late acquire', async t => {
  const f = await fixture(t); const a = await f.owner('cancel-a');
  const unrelated = { ...f.request(a, 'still-running'), permitId: randomUUID() };
  const other = await f.run(a, unrelated);
  for (const beforeAcquire of [false, true]) {
    const req = { ...f.request(a, `timeout-${beforeAcquire}`), permitId: randomUUID() };
    if (!beforeAcquire) await f.run(a, req);
    const cancel = { ...req, operation: 'cancel-acquire' };
    const activeBefore = (await f.state()).active;
    for (const patch of [...(beforeAcquire ? [] : [{ callId: 'wrong-call' }]),
      { generation: 99 }, { rpcId: 'wrong-rpc' }, { actorUserId: randomUUID() }]) {
      await assert.rejects(f.run(a, { ...cancel, ...patch }));
      assert.deepEqual((await f.state()).active, activeBefore);
    }
    const result = await f.run(a, cancel);
    assert.equal(result.status, 'acquisition-cancelled');
    assert.equal(result.permitId, req.permitId);
    assert.deepEqual((await f.state()).active.map(x => x.permitId), [other.permitId]);
    assert.deepEqual(await f.run(a, cancel), result);
    await assert.rejects(f.run(a, req), { code: 'WRITER_SCOPE_CALL_REPLAY' });
  }
  await f.settle(a, unrelated, other);
});

test('cancelled acquisition cannot revive after history pruning or authority expiry', async t => {
  const f = await fixture(t); const a = await f.owner('cancel-stale');
  const req = { ...f.request(a, 'never-entered'), permitId: randomUUID() };
  await f.run(a, { ...req, operation: 'cancel-acquire' });
  a.context = { ...a.context, generation: 2, executionId: randomUUID(), rpcId: 'rpc-new' };
  const current = { ...f.request(a, 'new-running'), permitId: randomUUID() };
  const permit = await f.run(a, current);
  assert.equal((await f.state()).settled.length, 0);
  await assert.rejects(f.run(a, req), { code: 'WRITER_SCOPE_CONTEXT_INVALID' });
  await assert.rejects(f.run(a, { ...current, callId: 'expired', permitId: randomUUID() },
    { now: NOW + 120_000 }), { code: 'WRITER_SCOPE_CONTEXT_INVALID' });
  assert.deepEqual((await f.state()).active.map(x => x.permitId), [permit.permitId]);
  await f.settle(a, current, permit);
});

test('semantic writer excludes normalized API resources across independent files until release', async (t) => {
  const f = await fixture(t);
  const a = await f.owner('semantic-a', ['src/shared/a.txt']); const b = await f.owner('semantic-b', ['src/shared/b.txt']);
  a.context.contract.semanticResources = [{ type: 'api', key: 'get /orders/{id}/' }];
  b.context.contract.semanticResources = [{ type: 'api', key: 'GET /orders/:id' }];
  const ar = f.request(a, 'a', 'src/shared/a.txt', 'write'); const br = f.request(b, 'b', 'src/shared/b.txt', 'write');
  const ap = await f.run(a, ar);
  assert.notEqual(a.workspace, b.workspace);
  assert.deepEqual((await f.state()).active[0].semanticResources, [{ type: 'api', key: 'GET /orders/:id' }]);
  assert.equal(Object.hasOwn(ap, 'semanticResources'), false, 'The existing client response remains unchanged.');
  await assert.rejects(f.run(b, br), { code: 'SEMANTIC_RESOURCE_CONFLICT' });
  await assert.rejects(readFile(path.join(b.workspace, br.filePath)), { code: 'ENOENT' });
  await writeFile(path.join(a.workspace, ar.filePath), 'owner wrote');
  await f.settle(a, ar, ap);
  const bp = await f.run(b, br);
  await writeFile(path.join(b.workspace, br.filePath), 'contender wrote after release');
  await f.settle(b, br, bp);
  assert.equal(await readFile(path.join(a.workspace, ar.filePath), 'utf8'), 'owner wrote');
  assert.equal(await readFile(path.join(b.workspace, br.filePath), 'utf8'), 'contender wrote after release');
  assert.equal((await f.state()).active.length, 0);
});

test('semantic writer allows distinct resources and keeps same-owner calls until all settle', async (t) => {
  const f = await fixture(t); const a = await f.owner('a', ['src/a']); const b = await f.owner('b', ['src/b']);
  const c = await f.owner('c', ['src/c']);
  a.context.contract.semanticResources = [{ type: 'table-column', key: 'orders#status' }];
  b.context.contract.semanticResources = [{ type: 'table-column', key: 'orders#description' }];
  c.context.contract.semanticResources = [{ type: 'table-column', key: 'orders#status' }];
  const ar = f.request(a, 'a-1', 'src/a/one.txt', 'write'); const ar2 = f.request(a, 'a-2', 'src/a/two.txt', 'write');
  const br = f.request(b, 'b', 'src/b/one.txt', 'write'); const cr = f.request(c, 'c', 'src/c/one.txt', 'write');
  const ap = await f.run(a, ar); const ap2 = await f.run(a, ar2);
  const bp = await f.run(b, br); assert.equal((await f.state()).active.length, 3);
  await f.settle(a, ar, ap);
  await assert.rejects(f.run(c, cr), { code: 'SEMANTIC_RESOURCE_CONFLICT' });
  await f.settle(a, ar2, ap2); const cp = await f.run(c, cr);
  await f.settle(b, br, bp); await f.settle(c, cr, cp);
});

test('semantic writer table-column conflicts are symmetric and expired active resources cannot be taken over', async (t) => {
  const f = await fixture(t); const a = await f.owner('a', ['src/a']); const b = await f.owner('b', ['src/b']);
  a.context.contract.semanticResources = [{ type: 'table', key: 'PUBLIC.ORDERS' }];
  b.context.contract.semanticResources = [{ type: 'table-column', key: 'public.orders#STATUS' }];
  const ar = f.request(a, 'table', 'src/a/table.txt', 'write'); const br = f.request(b, 'column', 'src/b/column.txt', 'write');
  const ap = await f.run(a, ar); const later = NOW + 120_000;
  b.context.expiresAt = new Date(later + 60_000).toISOString();
  await assert.rejects(f.run(b, br, { now: later }), { code: 'SEMANTIC_RESOURCE_CONFLICT' });
  await f.settle(a, ar, ap, { now: later });
  const bp = await f.run(b, br, { now: later });
  a.context.expiresAt = new Date(later + 60_000).toISOString();
  await assert.rejects(f.run(a, f.request(a, 'table-again', ar.filePath, 'write'), { now: later }), { code: 'SEMANTIC_RESOURCE_CONFLICT' });
  await f.settle(b, br, bp, { now: later });
});

test('semantic writer treats legacy active resources as unknown while exact legacy settlement remains available', async (t) => {
  const f = await fixture(t); const legacy = await f.owner('legacy', ['src/legacy']); const b = await f.owner('b', ['src/b']);
  b.context.contract.semanticResources = [{ type: 'permission', key: 'orders:read' }];
  const lr = f.request(legacy, 'legacy', 'src/legacy/one.txt', 'write'); const lp = await f.run(legacy, lr);
  const stored = await f.state(); assert.deepEqual(stored.active[0].semanticResources, []);
  delete stored.active[0].semanticResources; await writeFile(f.statePath, JSON.stringify(stored));
  const later = NOW + 120_000; b.context.expiresAt = new Date(later + 60_000).toISOString();
  const br = f.request(b, 'b', 'src/b/one.txt', 'write');
  await assert.rejects(f.run(b, br, { now: later }), { code: 'SEMANTIC_SCOPE_UNCLASSIFIED' });
  assert.equal((await f.state()).active[0].permitId, lp.permitId);
  legacy.context = null;
  const settled = await f.settle(legacy, lr, lp, { now: later, readContext() { throw new Error('Legacy settlement must not read current context.'); } });
  assert.equal(settled.status, 'settled');
  assert.equal(Object.hasOwn((await f.state()).settled[0], 'semanticResources'), false);
  const bp = await f.run(b, br, { now: later }); await f.settle(b, br, bp, { now: later });
  assert.equal((await f.settle(legacy, lr, lp, { now: later })).status, 'settled');
});

test('semantic writer uses only the freshly read contract and rejects model claims or malformed stored declarations', async (t) => {
  const f = await fixture(t); const a = await f.owner('a', ['src/a']); const b = await f.owner('b', ['src/b']);
  a.context.contract.semanticResources = [{ type: 'table', key: 'orders' }];
  b.context.contract.semanticResources = [{ type: 'table', key: 'orders' }];
  const ar = f.request(a, 'a', 'src/a/one.txt', 'write'); const br = f.request(b, 'b', 'src/b/one.txt', 'write');
  for (const patch of [{ semanticResources: [] }, { resources: [] }, { contract: { semanticResources: [] } }]) {
    await assert.rejects(f.run(a, { ...ar, ...patch }), { code: 'WRITER_SCOPE_SCHEMA_INVALID' });
  }
  const ap = await f.run(a, ar);
  b.context = { ...b.context, rpcId: 'new-authorized-rpc', executionId: randomUUID(), generation: 2,
    contractId: 'e'.repeat(64), contract: { ...b.context.contract, contractId: 'e'.repeat(64), semanticResources: [{ type: 'table', key: 'customers' }] } };
  await assert.rejects(f.run(b, br), { code: 'WRITER_SCOPE_CONTEXT_INVALID' });
  const fresh = f.request(b, 'fresh', br.filePath, 'write'); const bp = await f.run(b, fresh);
  assert.deepEqual((await f.state()).active.find(x => x.permitId === bp.permitId).semanticResources, [{ type: 'table', key: 'customers' }]);
  await f.settle(a, ar, ap); await f.settle(b, fresh, bp);
  const stored = await f.state(); stored.settled[0].semanticResources = [{ type: 'table', key: 'ORDERS' }];
  await writeFile(f.statePath, JSON.stringify(stored));
  await assert.rejects(f.run(b, { ...fresh, callId: 'malformed-state' }), { code: 'WRITER_SCOPE_STATE_INVALID' });
});

test('writer scope accepts contract Unicode and package paths while rejecting lexical aliases', async (t) => {
  const f = await fixture(t);
  const subject = await f.owner('unicode', ['src/@模块/合法 名称']);
  const request = f.request(subject, 'unicode', 'src/@模块/合法 名称/é.ts');
  const permit = await f.run(subject, request);
  assert.equal(permit.filePath, request.filePath);
  await f.settle(subject, request, permit);
  for (const filePath of [request.filePath.normalize('NFD'), request.filePath.replaceAll('/', '\\'), 'src/@模块/../outside.ts']) {
    await assert.rejects(f.run(subject, { ...request, callId: 'alias', filePath }), { code: 'WRITER_SCOPE_PATH_INVALID' });
  }
});

test('independent TaskSpace clones conflict on entire protected scope until every owner call settles', async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const b = await f.owner('b');
  const firstRequest = f.request(a); const secondRequest = f.request(a, 'call-2', 'src/shared/new.txt', 'write');
  const first = await f.run(a, firstRequest); const second = await f.run(a, secondRequest);
  assert.notEqual(a.workspace, b.workspace);
  await assert.rejects(f.run(b, f.request(b, 'other', 'src/shared/another.txt', 'copy_file')), { code: 'PATH_RESOURCE_CONFLICT' });
  await f.settle(a, firstRequest, first);
  await assert.rejects(f.run(b, f.request(b)), { code: 'PATH_RESOURCE_CONFLICT' });
  await f.settle(a, secondRequest, second);
  const admitted = await f.run(b, f.request(b));
  assert.equal(admitted.status, 'acquired');
  const stored = await f.state();
  assert.equal(stored.active.length, 1); assert.equal(stored.settled.length, 2);
  assert.deepEqual(stored.active[0].ownedPaths, b.context.contract.ownedPaths);
  assert.equal(stored.active[0].sourceCommit, b.context.sourceCommit);
  assert.equal(stored.active[0].workspaceFingerprint, b.context.workspaceFingerprint);
  assert.equal(stored.active[0].expiresAt, b.context.expiresAt);
  if (process.platform !== 'win32') assert.equal((await lstat(f.statePath)).mode & 0o777, 0o600);
});

test('in-flight scope stays held while an actual asynchronous write has not finished', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const b = await f.owner('b');
  const entered = deferred(); const finish = deferred(); const req = f.request(a, 'write-held', 'src/shared/value.txt', 'write');
  const work = (async () => {
    const permit = await f.run(a, req); entered.resolve(); await finish.promise;
    await writeFile(path.join(a.workspace, req.filePath), 'written');
    await f.settle(a, req, permit);
  })();
  await entered.promise;
  try {
    assert.equal(await readFile(path.join(a.workspace, req.filePath), 'utf8'), 'before');
    await assert.rejects(f.run(b, f.request(b)), { code: 'PATH_RESOURCE_CONFLICT' });
    assert.equal((await f.state()).active.length, 1);
  } finally { finish.resolve(); await work; }
  assert.equal(await readFile(path.join(a.workspace, req.filePath), 'utf8'), 'written');
  assert.equal((await f.run(b, f.request(b))).status, 'acquired');
});

test('expired in-flight lease cannot be stolen and original settlement survives a replaced context', async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const b = await f.owner('b');
  const req = f.request(a); const permit = await f.run(a, req); const later = NOW + 120_000;
  b.context.expiresAt = new Date(later + 60_000).toISOString();
  await assert.rejects(f.run(b, f.request(b), { now: later }), { code: 'PATH_RESOURCE_CONFLICT' });
  a.context = { ...a.context, executionId: randomUUID(), generation: 2, expiresAt: new Date(later + 60_000).toISOString() };
  await assert.rejects(f.run(a, f.request(a, 'new-generation'), { now: later }), { code: 'PATH_RESOURCE_CONFLICT' });
  await f.settle(a, req, permit, { now: later, readContext() { throw new Error('Settlement must not read current context.'); } });
  assert.equal((await f.run(b, f.request(b), { now: later })).status, 'acquired');
});

test('prompt activity reads only the requested task and retains expired in-flight writers until settlement', async t => {
  const f = await fixture(t); const a = await f.owner('a'); const b = await f.owner('b');
  const active = subject => hasActiveForgeTaskWriter({ projectRoot: f.projectRoot,
    projectSlug: subject.taskMetadata.projectSlug, taskId: subject.taskMetadata.taskId });
  assert.equal(await active(a), false);
  const req = f.request(a); const permit = await f.run(a, req);
  assert.equal(await active(a), true, 'expired timestamp is never evidence that the tool finished');
  assert.equal(await active(b), false, 'another task cannot be blocked by this permit');
  const before = await readFile(f.statePath);
  await active(a);
  assert.deepEqual(await readFile(f.statePath), before, 'activity is read only');
  await f.settle(a, req, permit, { now: NOW + 120_000,
    readContext() { throw new Error('Settlement must use the original permit.'); } });
  assert.equal(await active(a), false);
});

test('settlement matches the exact original permit and call identity, and acquired or settled calls cannot replay', async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const b = await f.owner('b');
  const req = f.request(a); const permit = await f.run(a, req);
  await assert.rejects(f.run(a, req), { code: 'WRITER_SCOPE_CALL_REPLAY' });
  await assert.rejects(f.settle(b, f.request(b), permit), { code: 'WRITER_SCOPE_PERMIT_MISMATCH' });
  for (const patch of [{ permitId: randomUUID() }, { callId: 'changed' }, { generation: 2 }, { toolName: 'remove_file' }, { filePath: 'src/shared/else.txt' }]) {
    await assert.rejects(f.run(a, { ...req, operation: 'settle', permitId: permit.permitId, ...patch }), { code: 'WRITER_SCOPE_PERMIT_MISMATCH' });
  }
  await f.settle(a, req, permit);
  await assert.rejects(f.run(a, req), { code: 'WRITER_SCOPE_CALL_REPLAY' });
  assert.deepEqual(await f.settle(a, req, permit), { schemaVersion: 1, status: 'settled', permitId: permit.permitId, callId: req.callId });
  assert.equal((await f.state()).active.length, 0);
});

test('fresh context only clears settled records for an older generation of that same owner', async (t) => {
  const f = await fixture(t); const a = await f.owner('a', ['src/a']); const b = await f.owner('b', ['src/b']);
  const ar = f.request(a, 'a-1', 'src/a/file.txt', 'write'); const br = f.request(b, 'b-1', 'src/b/file.txt', 'write');
  const ap = await f.run(a, ar); const bp = await f.run(b, br);
  await f.settle(a, ar, ap); await f.settle(b, br, bp);
  a.context = { ...a.context, generation: 2, executionId: randomUUID(), rpcId: 'rpc-a-new' };
  await f.run(a, f.request(a, 'a-2', 'src/a/next.txt', 'write'));
  const stored = await f.state();
  assert.deepEqual(stored.settled.map((item) => item.taskId), [b.taskMetadata.taskId]);
  await assert.rejects(f.run(a, ar), { code: 'WRITER_SCOPE_CONTEXT_INVALID' });
});

test('disjoint scopes including character prefixes can proceed, but parent-child scopes conflict', async (t) => {
  const f = await fixture(t); const a = await f.owner('a', ['src/a']); const b = await f.owner('b', ['src/ab']); const c = await f.owner('c', ['src/a/child']);
  await f.run(a, f.request(a, 'a', 'src/a/file.txt', 'write'));
  await f.run(b, f.request(b, 'b', 'src/ab/file.txt', 'copy_file'));
  await assert.rejects(f.run(c, f.request(c, 'c', 'src/a/child/file.txt', 'write')), { code: 'PATH_RESOURCE_CONFLICT' });
  assert.equal((await f.state()).active.length, 2);
});

test('only the current production writer context and authenticated owner may acquire', async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const req = f.request(a);
  for (const patch of [{ generation: 2 }, { rpcId: 'changed' }, { textDigest: 'e'.repeat(64) }, { contractId: 'f'.repeat(64) }]) {
    await assert.rejects(f.run(a, { ...req, ...patch }), { code: 'WRITER_SCOPE_CONTEXT_INVALID' });
  }
  await assert.rejects(f.run(a, { ...req, taskId: 'task-forged' }), { code: 'WRITER_SCOPE_IDENTITY_MISMATCH' });
  for (const patch of [{ testOnly: true }, { authorityClass: 'test-shadow-writer' }, { actionCeiling: 'read-only' }, { expiresAt: new Date(NOW).toISOString() }]) {
    await assert.rejects(f.run(a, req, { readContext: async () => ({ ...a.context, ...patch }) }), { code: 'WRITER_SCOPE_CONTEXT_INVALID' });
  }
  await assert.rejects(f.run(a, { ...req, sourceCommit: 'e'.repeat(40) }), { code: 'WRITER_SCOPE_SCHEMA_INVALID' });
  await assert.rejects(f.run(a, { ...req, toolName: 'bash' }), { code: 'WRITER_SCOPE_SCHEMA_INVALID' });
  await assert.rejects(f.run(a, { ...req, filePath: 'src/outside/file.txt' }), { code: 'WRITER_SCOPE_PATH_DENIED' });
});

test('lease identities reuse TaskSpace policy including colon conversation IDs and reject invalid identities', async (t) => {
  const f = await fixture(t); const a = await f.owner('a');
  a.taskMetadata.conversationId = 'channel:thread-1'; a.context.conversationId = a.taskMetadata.conversationId;
  a.context.dshSessionId = 'session:with-colon'; a.context.rpcId = 'rpc:with-colon';
  const req = f.request(a, 'call:with|provider-suffix');
  const permit = await f.run(a, req);
  assert.equal((await f.state()).active[0].conversationId, 'channel:thread-1');
  await f.settle(a, req, permit);
  for (const patch of [
    { projectSlug: 'Uppercase' }, { projectSlug: 'a'.repeat(49) }, { taskId: 'task_with_underscore' }, { taskId: 'a' },
    { conversationId: 'channel/thread' }, { conversationId: 'c'.repeat(129) }, { actorUserId: 'not-a-uuid' },
    ...['callId', 'rpcId', 'dshSessionId'].flatMap((key) => ['\0', '\r', '\n'].map((control) => ({ [key]: `identity${control}suffix` }))),
  ]) await assert.rejects(f.run(a, { ...req, ...patch }), { code: 'WRITER_SCOPE_SCHEMA_INVALID' });
});

test('protected shadow and production writers share exclusion while authority pairs retain their real source types', async (t) => {
  const f = await fixture(t); const shadow = await f.owner('shadow'); const production = await f.owner('production');
  Object.assign(shadow.context, { authorityClass: 'test-shadow-writer', testOnly: true, workspaceFingerprint: null });
  const sr = f.request(shadow); const pr = f.request(production);
  const sp = await f.run(shadow, sr);
  const record = (await f.state()).active[0];
  assert.equal(record.authorityClass, 'test-shadow-writer'); assert.equal(record.testOnly, true);
  assert.equal(record.workspaceFingerprint, null); assert.equal(record.sourceCommit, shadow.context.sourceCommit);
  await assert.rejects(f.run(production, pr), { code: 'PATH_RESOURCE_CONFLICT' });
  await f.settle(shadow, sr, sp);
  const pp = await f.run(production, pr);
  const nextShadow = f.request(shadow, 'shadow-next');
  await assert.rejects(f.run(shadow, nextShadow), { code: 'PATH_RESOURCE_CONFLICT' });
  await f.settle(production, pr, pp);
  for (const patch of [
    { testOnly: false }, { workspaceFingerprint: 'e'.repeat(64) }, { authorityClass: 'production-task-writer' },
    { authorityClass: 'production-task-writer', testOnly: false }, { sourceCommit: 'invalid' },
    { actionCeiling: 'release', contract: { ...shadow.context.contract, actionCeiling: 'release' } },
    { actionCeiling: 'git-checkpoint', contract: { ...shadow.context.contract, actionCeiling: 'git-checkpoint' } },
  ]) await assert.rejects(f.run(shadow, nextShadow, { readContext: async () => ({ ...shadow.context, ...patch }) }), { code: 'WRITER_SCOPE_CONTEXT_INVALID' });
  assert.equal((await f.run(shadow, nextShadow)).status, 'acquired');
  const original = await readFile(f.statePath);
  for (const patch of [{ testOnly: false }, { workspaceFingerprint: 'e'.repeat(64) }, { authorityClass: 'production-task-writer' }]) {
    const state = JSON.parse(original); Object.assign(state.active[0], patch);
    await writeFile(f.statePath, JSON.stringify(state), { mode: 0o600 });
    await assert.rejects(f.run(shadow, f.request(shadow, 'another')), { code: 'WRITER_SCOPE_STATE_INVALID' });
  }
  await writeFile(f.statePath, original, { mode: 0o600 });
});

test('target aliases cannot bypass the protected workspace boundary', async (t) => {
  const f = await fixture(t); const a = await f.owner('a');
  for (const filePath of ['../outside', '/absolute', 'src\\shared\\value.txt', 'src/shared/../outside']) {
    await assert.rejects(f.run(a, f.request(a, 'bad', filePath)), { code: 'WRITER_SCOPE_PATH_INVALID' });
  }
  const outside = path.join(f.projectRoot, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(a.workspace, 'src', 'shared', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.run(a, f.request(a, 'alias', 'src/shared/alias/file.txt', 'write')), { code: 'WRITER_SCOPE_PATH_INVALID' });
  await symlink(path.join(a.workspace, 'src', 'shared'), path.join(a.workspace, 'src', 'shared', 'inside-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.run(a, f.request(a, 'inside-alias', 'src/shared/inside-alias/file.txt', 'write')), { code: 'WRITER_SCOPE_PATH_INVALID' });
});

test('protected state rejects corruption and a symlink without changing its target', async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const req = f.request(a);
  const permit = await f.run(a, req); await f.settle(a, req, permit);
  await writeFile(f.statePath, '{bad json', { mode: 0o600 });
  await assert.rejects(f.run(a, f.request(a, 'next')), { code: 'WRITER_SCOPE_STATE_INVALID' });
  assert.equal(await readFile(f.statePath, 'utf8'), '{bad json');
  await rm(f.statePath);
  const targetRoot = path.join(f.projectRoot, 'unrelated'); await mkdir(targetRoot);
  const target = path.join(targetRoot, 'unrelated.json'); await writeFile(target, 'untouched');
  // Windows file symlinks require privileges unavailable on this runner; a real
  // junction exercises the same state-entry alias rejection without granting them.
  await symlink(process.platform === 'win32' ? targetRoot : target, f.statePath, process.platform === 'win32' ? 'junction' : 'file');
  await assert.rejects(f.run(a, f.request(a, 'next')), { code: 'WRITER_SCOPE_STATE_INVALID' });
  assert.equal(await readFile(target, 'utf8'), 'untouched');
});

test('project lock covers awaited context reading and cannot register two concurrent owners', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const b = await f.owner('b');
  const entered = deferred(); const release = deferred();
  const first = f.run(a, f.request(a), { readContext: async () => { entered.resolve(); await release.promise; return a.context; } });
  await entered.promise;
  // Same-Broker transactions wait for the actual prior result, then apply
  // the existing ownership conflict instead of racing the OS state lock.
  const second = assert.rejects(f.run(b, f.request(b)), { code: 'PATH_RESOURCE_CONFLICT' });
  release.resolve();
  await first;
  await second;
  assert.equal((await f.state()).active.length, 1);
});

test('concurrent writer transactions settle each original permit without losing active entries', async t => {
  const f = await fixture(t);
  const subjects = await Promise.all(Array.from({ length: 4 }, (_, i) => f.owner(`parallel-${i}`, [`src/shared/task-${i}`])));
  const requests = subjects.map((subject, i) => f.request(subject, `call-${i}`, `src/shared/task-${i}/value.txt`));
  const permits = await Promise.all(subjects.map((subject, i) => f.run(subject, requests[i])));
  assert.equal((await f.state()).active.length, 4);
  const receipts = await Promise.all(subjects.map((subject, i) => f.settle(subject, requests[i], permits[i])));
  assert.deepEqual(receipts.map(r => r.permitId), permits.map(p => p.permitId));
  const state = await f.state();
  assert.deepEqual(state.active, []);
  assert.deepEqual(state.settled.map(r => r.permitId).sort(), permits.map(p => p.permitId).sort());
  const repeated = await Promise.all([0, 0].map(i => f.settle(subjects[i], requests[i], permits[i])));
  assert.deepEqual(repeated, [receipts[0], receipts[0]]);
  assert.equal((await f.state()).settled.length, 4);
});

test('rejected writer transaction releases its queue without accepting a mismatched settlement', async t => {
  const f = await fixture(t); const a = await f.owner('a'); const request = f.request(a);
  const permit = await f.run(a, request);
  const results = await Promise.allSettled([
    f.run(a, { ...request, operation: 'settle', permitId: permit.permitId, callId: 'wrong-call' }),
    f.settle(a, request, permit),
    f.settle(a, request, permit),
  ]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.code, 'WRITER_SCOPE_PERMIT_MISMATCH');
  for (const result of results.slice(1)) {
    assert.equal(result.status, 'fulfilled');
    assert.deepEqual(result.value, { schemaVersion: 1, status: 'settled', permitId: permit.permitId, callId: request.callId });
  }
  const state = await f.state();
  assert.deepEqual(state.active, []); assert.equal(state.settled.length, 1);
});

test('writer transaction queue is isolated to its canonical project state path', { timeout: 10_000 }, async t => {
  const firstProject = await fixture(t); const a = await firstProject.owner('a');
  const secondProject = await fixture(t); const b = await secondProject.owner('b');
  const entered = deferred(); const release = deferred();
  const firstRequest = firstProject.request(a);
  const first = firstProject.run(a, firstRequest, { readContext: async () => { entered.resolve(); await release.promise; return a.context; } });
  await entered.promise;
  try {
    const secondRequest = secondProject.request(b);
    const secondPermit = await secondProject.run(b, secondRequest);
    await secondProject.settle(b, secondRequest, secondPermit);
    assert.equal((await secondProject.state()).settled.length, 1);
  } finally { release.resolve(); }
  await firstProject.settle(a, firstRequest, await first);
  assert.deepEqual((await firstProject.state()).active, []);
});

test('dead writer recovery refuses missing, live, expired-only and malformed evidence without changing state', async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const request = f.request(a);
  const permit = await f.run(a, request); const original = await readFile(f.statePath);
  await assert.rejects(f.recover(a, permit, { verifyQuiescence: undefined }), { code: 'WRITER_SCOPE_RECOVERY_PROOF_REQUIRED' });
  const invalid = [null, {}, { ...deathProof(), removed: false }, { ...deathProof(), toolResult: 'success' },
    { ...deathProof(), containerId: 'short-id' }, { ...deathProof(), evidenceSha256: 'missing' },
    { ...deathProof(), fenceEpoch: '' }, { ...deathProof(), revokedThroughGeneration: 0 },
    { ...deathProof(), revokedThroughGeneration: 1.5 }, { ...deathProof(), extra: true },
    { ...deathProof(), startedAt: new Date(NOW + 100).toISOString() },
    { ...deathProof(), finishedAt: new Date(NOW - 2000).toISOString() },
    { ...deathProof(), finishedAt: new Date(NOW + 2000).toISOString() }];
  for (const proof of invalid) {
    await assert.rejects(f.recover(a, permit, { verifyQuiescence: async () => proof }), { code: 'WRITER_SCOPE_RECOVERY_PROOF_INVALID' });
    assert.deepEqual(await readFile(f.statePath), original);
  }
  await assert.rejects(f.recover(a, permit, { now: NOW + 120_000, verifyQuiescence: async () => ({ expired: true }) }),
    { code: 'WRITER_SCOPE_RECOVERY_PROOF_INVALID' });
  await assert.rejects(f.recover(a, permit, { verifyQuiescence: async () => { throw new Error('Docker observation unavailable'); } }),
    /Docker observation unavailable/u);
  await assert.rejects(f.run(a, { ...request, operation: 'recover' }), { code: 'WRITER_SCOPE_SCHEMA_INVALID' });
  assert.deepEqual(await readFile(f.statePath), original);
});

test('dead writer recovery binds the complete TaskSpace identity, exact execution, permit and generation before observing death', async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const permit = await f.run(a, f.request(a));
  const b = await f.owner('b'); const original = await readFile(f.statePath); let observed = 0;
  const verifyQuiescence = async () => { observed += 1; return deathProof(); };
  for (const patch of [{ permitId: randomUUID() }, { expectedExecutionId: randomUUID() }, { expectedGeneration: 2 },
    { taskMetadata: { ...a.taskMetadata, actorUserId: randomUUID() } },
    { taskMetadata: { ...a.taskMetadata, conversationId: 'other-conversation' } },
    { taskMetadata: b.taskMetadata, workspace: b.workspace }]) {
    await assert.rejects(f.recover(a, permit, { ...patch, verifyQuiescence }), { code: 'WRITER_SCOPE_PERMIT_MISMATCH' });
  }
  await assert.rejects(f.recover(a, permit, { workspace: b.workspace, verifyQuiescence }), { code: 'WRITER_SCOPE_PATH_INVALID' });
  await assert.rejects(f.recover(a, permit, { taskMetadata: { ...a.taskMetadata, projectSlug: 'different-project' }, verifyQuiescence }),
    { code: 'WRITER_SCOPE_STATE_INVALID' });
  assert.equal(observed, 0); assert.deepEqual(await readFile(f.statePath), original);
});

test('dead writer recovery upgrades legacy state to explicit recovered while preserving the unknown tool result and ordinary settlements', async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const b = await f.owner('b');
  const request = f.request(a); const permit = await f.run(a, request);
  const legacy = await f.state(); assert.equal(legacy.schemaVersion, 1);
  delete legacy.active[0].semanticResources;
  await writeFile(f.statePath, JSON.stringify(legacy), { mode: 0o600 });
  const originalRecord = structuredClone(legacy.active[0]);
  const recovered = await f.recover(a, permit);
  assert.equal(recovered.status, 'recovered'); assert.equal(recovered.idempotent, false);
  const state = await f.state(); assert.equal(state.schemaVersion, 2);
  assert.deepEqual(state.active, []); assert.deepEqual(state.settled, []);
  assert.deepEqual(state.recovered, [{ ...originalRecord, status: 'recovered', recoveredAt: new Date(NOW + 1000).toISOString(), proof: deathProof() }]);
  await assert.rejects(f.settle(a, request, permit), { code: 'WRITER_SCOPE_PERMIT_RECOVERED' });
  const br = f.request(b); const bp = await f.run(b, br); await f.settle(b, br, bp);
  assert.equal((await f.state()).settled[0].permitId, bp.permitId);
  assert.deepEqual((await f.state()).recovered, state.recovered);
});

test('dead writer recovery is idempotent only for the same death proof and never relabels normal settlement', async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const b = await f.owner('b');
  const permit = await f.run(a, f.request(a)); const first = await f.recover(a, permit);
  const original = await readFile(f.statePath); let observed = 0;
  const again = await f.recover(a, permit, { now: NOW + 2000, verifyQuiescence: async (record) => {
    observed += 1; assert.equal(record.status, 'recovered'); assert.deepEqual(record.proof, first.proof); return deathProof();
  } });
  assert.equal(observed, 1); assert.deepEqual(again, { ...first, idempotent: true });
  assert.deepEqual(await readFile(f.statePath), original);
  for (const patch of [{ containerId: 'a'.repeat(64) }, { evidenceSha256: 'a'.repeat(64) }, { revokedThroughGeneration: 2 }]) {
    await assert.rejects(f.recover(a, permit, { verifyQuiescence: async () => ({ ...deathProof(), ...patch }) }),
      { code: 'WRITER_SCOPE_RECOVERY_PROOF_MISMATCH' });
    assert.deepEqual(await readFile(f.statePath), original);
  }
  const request = f.request(b); const bp = await f.run(b, request); await f.settle(b, request, bp);
  await assert.rejects(f.recover(b, bp), { code: 'WRITER_SCOPE_RECOVERY_NOT_ACTIVE' });
});

test('dead writer recovery permanently rejects the revoked generation floor across new executions and permits a newer trusted generation', async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const oldContext = structuredClone(a.context);
  const permit = await f.run(a, f.request(a));
  await f.recover(a, permit, { verifyQuiescence: async () => deathProof(3) });
  const recovered = (await f.state()).recovered;
  for (const generation of [1, 2, 3]) {
    Object.assign(a.context, { generation, executionId: randomUUID(), dshSessionId: `replacement-${generation}` });
    await assert.rejects(f.run(a, f.request(a, `new-call-${generation}`)), { code: 'WRITER_SCOPE_GENERATION_RECOVERED' });
  }
  a.context.generation = 4;
  const newRequest = f.request(a, 'new-generation'); const newer = await f.run(a, newRequest);
  const repeat = await f.recover(a, permit, { expectedExecutionId: oldContext.executionId, expectedGeneration: 1,
    verifyQuiescence: async () => deathProof(3) });
  assert.equal(repeat.idempotent, true); assert.equal((await f.state()).active[0].permitId, newer.permitId);
  await f.settle(a, newRequest, newer);
  a.context.generation = 5; a.context.executionId = randomUUID();
  const lastRequest = f.request(a, 'newer-generation'); const last = await f.run(a, lastRequest);
  assert.equal((await f.state()).settled.length, 0, 'Normal old settled records are still pruned.');
  assert.deepEqual((await f.state()).recovered, recovered, 'Recovery history and floor are never pruned.');
  await f.settle(a, lastRequest, last);
  a.context.generation = 3;
  await assert.rejects(f.run(a, f.request(a, 'old-generation-retry')), { code: 'WRITER_SCOPE_GENERATION_RECOVERED' });
});

test('dead writer recovery refuses a second active permit for the same task instead of deleting other work', async (t) => {
  const f = await fixture(t); const a = await f.owner('a');
  const ar = f.request(a, 'first'); const first = await f.run(a, ar);
  const br = f.request(a, 'second'); const second = await f.run(a, br);
  const original = await readFile(f.statePath); let observed = false;
  await assert.rejects(f.recover(a, first, { verifyQuiescence: async () => { observed = true; return deathProof(); } }),
    { code: 'WRITER_SCOPE_RECOVERY_MULTIPLE_ACTIVE' });
  assert.equal(observed, false); assert.deepEqual(await readFile(f.statePath), original);
  await f.settle(a, br, second); await f.recover(a, first);
  const state = await f.state(); assert.equal(state.recovered[0].permitId, first.permitId);
  assert.equal(state.settled[0].permitId, second.permitId);
});

test('dead writer recovery awaits trusted observation within the original project lock and protects the record from mutation', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t); const a = await f.owner('a'); const b = await f.owner('b');
  const permit = await f.run(a, f.request(a)); const entered = deferred(); const release = deferred();
  const recovering = f.recover(a, permit, { verifyQuiescence: async (record) => {
    assert.ok(Object.isFrozen(record)); assert.ok(Object.isFrozen(record.ownedPaths));
    assert.throws(() => { record.generation = 99; }, TypeError);
    entered.resolve(); await release.promise; return deathProof();
  } });
  await entered.promise;
  try { await assert.rejects(f.run(b, f.request(b)), { code: 'EXECUTION_STATE_BUSY' }); }
  finally { release.resolve(); }
  await recovering;
  assert.equal((await f.run(b, f.request(b))).status, 'acquired');
  assert.equal((await f.state()).recovered[0].generation, 1);
});

test('root operator recovery preserves UID1000 state and lock while ordinary cross-owner access stays rejected', async t => {
  if (process.platform !== 'linux' || process.geteuid() !== 0) {
    t.skip('Requires actual Linux root recovery and an actual UID1000 child; no identity mocking.'); return;
  }
  const f = await fixture(t); const a = await f.owner('owner-preserved');
  for (const entry of [f.projectRoot, path.join(f.projectRoot, 'taskspaces'), path.dirname(a.workspace),
    a.workspace, path.join(a.workspace, 'src'), path.join(a.workspace, 'src/shared'), path.join(a.workspace, 'src/shared/value.txt')]) {
    await chown(entry, 1000, 1000);
  }
  const moduleUrl = new URL('../docker/harness/forge-writer-scope-lease.mjs', import.meta.url).href;
  const contextModuleUrl = new URL('../docker/harness/forge-execution-context.mjs', import.meta.url).href;
  const childSource = `import {executeForgeWriterScopeLease} from ${JSON.stringify(moduleUrl)};
    const input=JSON.parse(process.argv[1]);
    console.log(JSON.stringify(await executeForgeWriterScopeLease({...input,readContext:async()=>input.context})));`;
  const execute = promisify(execFile);
  const runAsWriter = async request => {
    const result = await execute(process.execPath, ['--input-type=module', '-e', childSource, JSON.stringify({
      projectRoot: f.projectRoot, taskMetadata: a.taskMetadata, workspace: a.workspace, request, context: a.context, now: NOW,
    })], { uid: 1000, gid: 1000 });
    assert.equal(result.stderr, ''); return JSON.parse(result.stdout);
  };
  const originalRequest = f.request(a); const permit = await runAsWriter(originalRequest);
  const stateBefore = await lstat(f.statePath), lockBefore = await lstat(f.statePath + '.lock');
  assert.equal(stateBefore.uid, 1000); assert.equal(lockBefore.uid, 1000);
  await assert.rejects(f.run(a, f.request(a, 'root-must-not-acquire')), { code: 'EXECUTION_STATE_LOCK_INVALID' });
  await assert.rejects(f.settle(a, originalRequest, permit), { code: 'EXECUTION_STATE_LOCK_INVALID' });
  // A non-root caller cannot select another owner's lock, even before any file operation.
  const forbidden = `import assert from 'node:assert/strict'; import {withExecutionStateLock} from ${JSON.stringify(contextModuleUrl)};
    await assert.rejects(withExecutionStateLock(${JSON.stringify(f.statePath)},async()=>{}, {uid:0,gid:0}),{code:'EXECUTION_STATE_LOCK_OWNER_INVALID'});`;
  await execute(process.execPath, ['--input-type=module', '-e', forbidden], { uid: 1000, gid: 1000 });
  await f.recover(a, permit);
  const verifyOwner = async () => {
    for (const entry of [f.statePath, f.statePath + '.lock']) {
      const info = await lstat(entry);
      assert.equal(info.uid, 1000); assert.equal(info.gid, 1000); assert.equal(info.mode & 0o777, 0o600);
    }
  };
  await verifyOwner(); assert.equal((await lstat(f.statePath + '.lock')).ino, lockBefore.ino);
  Object.assign(a.context, { generation: 2, executionId: randomUUID() });
  const secondRequest = f.request(a, 'after-root-recovery'); const second = await runAsWriter(secondRequest);
  // If a protected lock has never existed, root creates it for the original state owner.
  await rm(f.statePath + '.lock');
  await f.recover(a, second); await verifyOwner();
  Object.assign(a.context, { generation: 3, executionId: randomUUID() });
  const thirdRequest = f.request(a, 'ordinary-writer-resumed'); const third = await runAsWriter(thirdRequest);
  await runAsWriter({ ...thirdRequest, operation: 'settle', permitId: third.permitId });
  const state = await f.state(); assert.equal(state.recovered.length, 2); assert.equal(state.active.length, 0);
  assert.equal(state.settled[0].permitId, third.permitId); await verifyOwner();
});
