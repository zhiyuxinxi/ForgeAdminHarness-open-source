import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { recoverForgeDeadWriter } from '../scripts/recover-forge-dead-writer.mjs';
import { executeForgeWriterScopeLease, recoverForgeWriterScopeLease } from '../docker/harness/forge-writer-scope-lease.mjs';

const execute = promisify(execFile);
const taskId = 'c-' + '1'.repeat(24), containerId = 'a'.repeat(64), image = 'sha256:' + 'b'.repeat(64);
const actor = '11111111-1111-4111-8111-111111111111', conversation = '22222222-2222-4222-8222-222222222222';
const executionId = '33333333-3333-4333-8333-333333333333', permitId = '44444444-4444-4444-8444-444444444444';
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'forge-dead-writer-test-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await realpath(os.tmpdir()));
    assert(path.basename(root).startsWith('forge-dead-writer-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const projectRoot = path.join(root, 'projects', 'forge-base'), taskRoot = path.join(projectRoot, 'taskspaces', taskId);
  const workspace = path.join(taskRoot, 'workspace'), dshHome = path.join(taskRoot, 'dsh-home');
  for (const directory of [workspace, dshHome, path.join(taskRoot, 'maintenance'), path.join(projectRoot, 'taskspaces', '.broker')]) {
    await mkdir(directory, { recursive: true });
  }
  const metadata = { projectSlug: 'forge-base', taskId, actorUserId: actor, actorId: 'operator', conversationId: conversation,
    status: 'active', accessMode: 'conversation' };
  await writeFile(path.join(taskRoot, 'metadata.json'), JSON.stringify(metadata), { mode: 0o600 });
  await writeFile(path.join(taskRoot, 'task.env'), Object.entries({ TASKSPACE_COMPOSE_PROJECT_NAME: `forge-forge-base-task-${taskId}`,
    PROJECT_COMPOSE_NAME: 'forge-forge-base', TASKSPACE_ROOT: taskRoot, PROJECT_SLUG: 'forge-base', TASKSPACE_ID: taskId })
    .map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  const fenceFile = path.join(taskRoot, 'maintenance', 'proxy-fence.json');
  await writeFile(fenceFile, JSON.stringify({ schemaVersion: 1, state: 'committed', epoch: 'previous' }) + '\n', { mode: 0o600 });
  await writeFile(path.join(workspace, 'keep.txt'), 'existing business bytes\n');
  const target = { Id: containerId, Image: image, Name: '/original-dead-runtime',
    State: { Status: 'exited', Running: false, Restarting: false, Paused: false, Pid: 0,
      StartedAt: '2026-10-03T00:00:00.000000001Z', FinishedAt: '2026-10-03T00:10:00.000000002Z' },
    HostConfig: { RestartPolicy: { Name: 'no' } }, Config: { Labels: { 'com.docker.compose.project': `forge-forge-base-task-${taskId}`,
      'com.docker.compose.service': 'harness' } },
    Mounts: [{ Type: 'bind', Source: workspace, Destination: '/workspace', RW: true },
      { Type: 'bind', Source: dshHome, Destination: '/home/node/.dsh', RW: true }] };
  const containers = new Map([[containerId, target]]), removed = [], proofs = [];
  const docker = { async inspect(id) { return structuredClone(containers.get(id) ?? null); },
    async listContainers() { return structuredClone([...containers.values()]); },
    async remove(id) { assert.equal(containers.get(id)?.State.Status, 'exited'); removed.push(id); containers.delete(id); } };
  const descriptor = { schemaVersion: 1, operationId: 'dead-writer-test', projectSlug: 'forge-base', taskId,
    permitId, expectedExecutionId: executionId, expectedGeneration: 7, expectedContainerId: containerId,
    expectedImage: image, trustedControlContainers: [] };
  const record = { ...metadata, permitId, executionId, generation: 7, status: 'in-flight' };
  const context = { ...metadata, generation: 8 };
  let lockChecks = 0;
  const options = { descriptor, allowedRoot: root, docker, validateSharedLocks: async () => { lockChecks += 1; },
    readCurrentContext: async args => { assert.equal(args.allowExpiredForRenewal, true); return structuredClone(context); },
    recoverLease: async args => {
      assert.equal(args.permitId, permitId); assert.equal(args.expectedExecutionId, executionId);
      const proof = await args.verifyQuiescence(Object.freeze(structuredClone(record))); proofs.push(proof);
      if (record.status === 'recovered') assert.deepEqual(proof, record.proof);
      const idempotent = record.status === 'recovered'; record.status = 'recovered'; record.proof = proof;
      return { schemaVersion: 2, status: 'recovered', permitId, proof, idempotent };
    } };
  const operationFile = path.join(projectRoot, 'taskspaces', '.broker', 'dead-writer-recovery', descriptor.operationId, 'operation.json');
  return { root, projectRoot, taskRoot, workspace, dshHome, target, containers, removed, proofs, context, descriptor, options, record,
    run: extra => recoverForgeDeadWriter({ ...options, ...extra }), fenceFile, operationFile,
    readOperation: async () => JSON.parse(await readFile(operationFile, 'utf8')), lockChecks: () => lockChecks };
}

test('dead writer adapter removes only exact dead target and checks trusted controls under the store callback', async t => {
  const f = await fixture(t), backup = structuredClone(f.target);
  backup.Id = 'c'.repeat(64); f.containers.set(backup.Id, backup);
  const control = structuredClone(f.target); control.Id = 'd'.repeat(64);
  control.State = { ...control.State, Status: 'running', Running: true, Pid: 500 };
  control.Mounts = [{ Type: 'bind', Source: f.projectRoot, Destination: '/project', RW: true }];
  f.containers.set(control.Id, control); f.descriptor.trustedControlContainers.push({ id: control.Id, image });
  control.Mounts.push({ Type: 'tmpfs', Source: '', Destination: '/tmp', RW: true });
  const result = await f.run();
  assert.equal(result.status, 'recovered'); assert.equal(result.toolResult, 'unknown'); assert.equal(result.taskFenced, true);
  assert.deepEqual(f.removed, [containerId]); assert(f.containers.has(control.Id) && f.containers.has(backup.Id));
  assert.equal(f.proofs[0].revokedThroughGeneration, 8); assert(f.lockChecks() >= 4);
  assert.equal((await f.readOperation()).deathEvidence.afterRemoval.controls[0].id, control.Id);
  assert.equal(JSON.parse(await readFile(f.fenceFile, 'utf8')).state, 'maintenance');
  assert.equal(await readFile(path.join(f.workspace, 'keep.txt'), 'utf8'), 'existing business bytes\n');
});

test('dead writer adapter refuses live restarting paused and auto-restart writers without stopping them', async t => {
  for (const variant of ['running', 'restarting', 'paused', 'restart-policy']) {
    await t.test(variant, async t => {
      const f = await fixture(t);
      if (variant === 'running') Object.assign(f.target.State, { Status: 'running', Running: true, Pid: 100 });
      if (variant === 'restarting') f.target.State.Restarting = true;
      if (variant === 'paused') f.target.State.Paused = true;
      if (variant === 'restart-policy') f.target.HostConfig.RestartPolicy.Name = 'always';
      await assert.rejects(f.run(), { code: 'DEAD_WRITER_NOT_QUIESCENT' });
      assert.deepEqual(f.removed, []); assert.equal(f.proofs.length, 0);
      assert.equal(JSON.parse(await readFile(f.fenceFile, 'utf8')).state, 'maintenance');
    });
  }
});

test('dead writer adapter rejects unknown writable ancestors and disguised trusted TaskSpace writers', async t => {
  const f = await fixture(t), unknown = structuredClone(f.target); unknown.Id = 'e'.repeat(64);
  unknown.Mounts = [{ Type: 'bind', Source: f.projectRoot, Destination: '/unlabelled', RW: true }];
  unknown.State.Running = true; unknown.State.Status = 'running'; unknown.State.Pid = 123;
  f.containers.set(unknown.Id, unknown);
  await assert.rejects(f.run(), { code: 'DEAD_WRITER_NOT_QUIESCENT' });
  assert.deepEqual(f.removed, []);
  const g = await fixture(t), disguised = structuredClone(g.target); disguised.Id = 'f'.repeat(64);
  g.containers.set(disguised.Id, disguised); g.descriptor.trustedControlContainers.push({ id: disguised.Id, image });
  await assert.rejects(g.run(), { code: 'DEAD_WRITER_CONTROL_INVALID' });
  assert.deepEqual(g.removed, []);
});

test('dead writer adapter rescans after removal and resumes the same durable operation after a failed store attempt', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ recoverLease: async args => {
    await args.verifyQuiescence(f.record); throw Object.assign(new Error('injected store failure'), { code: 'STORE_UNAVAILABLE' });
  } }), { code: 'STORE_UNAVAILABLE' });
  assert.deepEqual(f.removed, [containerId]); assert.equal((await f.readOperation()).phase, 'removed');
  f.context.generation = 9; // No committed recovery yet: a fresh higher generation must be revoked too.
  const result = await f.run(); assert.equal(result.proof.revokedThroughGeneration, 9);
  assert.deepEqual(f.removed, [containerId]);
  const operation = await f.readOperation();
  assert.equal(operation.attempts[0].code, 'STORE_UNAVAILABLE'); assert.equal(operation.supersededUncommittedProofs.length, 1);
  f.context.generation = 10;
  const repeated = await f.run(); assert.equal(repeated.result.idempotent, true);
  assert.equal(repeated.proof.revokedThroughGeneration, 9, 'Repeated recovery does not revoke a later generation');
});

test('dead writer adapter refuses a writer appearing after exact removal and does not invoke store', async t => {
  const f = await fixture(t), originalRemove = f.options.docker.remove;
  f.options.docker.remove = async id => {
    await originalRemove(id); const revived = structuredClone(f.target); revived.Id = '9'.repeat(64);
    Object.assign(revived.State, { Status: 'running', Running: true, Pid: 456 }); f.containers.set(revived.Id, revived);
  };
  await assert.rejects(f.run(), { code: 'DEAD_WRITER_NOT_QUIESCENT' }); assert.equal(f.proofs.length, 0);
  assert.equal((await f.readOperation()).phase, 'remove-authorized');
});

test('dead writer adapter requires exact descriptor locks mounts and fence without accepting hand-written death claims', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run({ validateSharedLocks: undefined }), { code: 'DEAD_WRITER_LOCK_REQUIRED' });
  await assert.rejects(f.run({ descriptor: { ...f.descriptor, dead: true } }), { code: 'DEAD_WRITER_DESCRIPTOR_INVALID' });
  f.target.Mounts[0].Source = f.dshHome;
  await assert.rejects(f.run(), { code: 'DEAD_WRITER_TARGET_MISMATCH' }); assert.deepEqual(f.removed, []);
  await writeFile(f.fenceFile, JSON.stringify({ schemaVersion: 1, state: 'maintenance', epoch: 'another-operation' }));
  await assert.rejects(f.run(), { code: 'DEAD_WRITER_FENCE_CHANGED' }); assert.deepEqual(f.removed, []);
});

test('dead writer operator help and import have no runtime or Docker dependency', async () => {
  const result = await execute(process.execPath, [path.resolve(import.meta.dirname, '../scripts/recover-forge-dead-writer.mjs'), '--help']);
  assert.match(result.stdout, /Keeps the TaskSpace fenced/u); assert.equal(result.stderr, '');
});

test('dead writer adapter proof reaches the real store atomically and permanently rejects the old generation', async t => {
  const f = await fixture(t), now = Date.parse('2026-10-03T00:05:00.000Z');
  const context = { ...f.context, generation: 7, executionId, dshSessionId: 'session-dead-writer', rpcId: 'rpc-dead-writer',
    textDigest: '1'.repeat(64), contractId: '2'.repeat(64), authorityClass: 'production-task-writer', testOnly: false,
    actionCeiling: 'workspace-write', sourceCommit: '3'.repeat(40), workspaceFingerprint: '4'.repeat(64),
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), ownedPaths: ['keep.txt'],
    contract: { contractId: '2'.repeat(64), actionCeiling: 'workspace-write', ownedPaths: ['keep.txt'] } };
  const keys = ['projectSlug', 'taskId', 'actorUserId', 'conversationId', 'dshSessionId', 'rpcId', 'textDigest', 'executionId', 'generation', 'contractId'];
  const request = { action: 'writer-scope-lease', operation: 'acquire', ...Object.fromEntries(keys.map(key => [key, context[key]])),
    callId: 'native-edit-held', toolName: 'edit', filePath: 'keep.txt' };
  const taskMetadata = JSON.parse(await readFile(path.join(f.taskRoot, 'metadata.json'), 'utf8'));
  const run = request => executeForgeWriterScopeLease({ projectRoot: f.projectRoot, taskMetadata, workspace: f.workspace,
    request, readContext: async () => context, now });
  const acquired = await run(request); f.descriptor.permitId = acquired.permitId;
  const result = await f.run({ recoverLease: args => recoverForgeWriterScopeLease({ ...args, now: now + 15 * 60 * 1000 }) });
  assert.equal(result.result.status, 'recovered'); assert.equal(result.proof.revokedThroughGeneration, 8);
  const state = JSON.parse(await readFile(path.join(f.projectRoot, 'taskspaces', '.broker', 'writer-scope-leases.json'), 'utf8'));
  assert.equal(state.active.length, 0); assert.equal(state.settled.length, 0); assert.equal(state.recovered.length, 1);
  assert.equal(state.recovered[0].proof.toolResult, 'unknown');
  await assert.rejects(run({ ...request, callId: 'must-not-replay' }), { code: 'WRITER_SCOPE_GENERATION_RECOVERED' });
  assert.equal(await readFile(path.join(f.workspace, 'keep.txt'), 'utf8'), 'existing business bytes\n');
});

test('dead writer inherited flock verifies numeric descriptors without creating a file named 3', async t => {
  if (process.platform !== 'linux') { t.skip('Requires real Linux /proc file descriptors and util-linux flock.'); return; }
  const f = await fixture(t), files = ['image', 'taskspaces', 'recovery'].map(name => path.join(f.root, name + '.lock'));
  for (const file of files) await writeFile(file, '', { mode: 0o660 });
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../scripts/recover-forge-dead-writer.mjs')).href;
  const code = `const m=await import(${JSON.stringify(moduleUrl)});await m.validateDeadWriterInheritedLocks(${JSON.stringify(files)});`;
  await execute('/bin/bash', ['-c', 'exec 7>>"$1"; exec 8>>"$2"; exec 9>>"$3"; flock -xn 7 && flock -xn 8 && flock -xn 9 && exec "$4" --input-type=module -e "$5"',
    'dead-writer-lock-test', ...files, process.execPath, code], { cwd: f.root });
  await assert.rejects(readFile(path.join(f.root, '3')), { code: 'ENOENT' });
});

test('dead writer missing mount allows a stopped unrelated missing source and binds its evidence', async t => {
  const f = await fixture(t), unrelated = path.join(f.root, 'unrelated');
  await mkdir(unrelated);
  const old = structuredClone(f.target); old.Id = 'c'.repeat(64);
  const source = path.join(unrelated, 'missing', 'results');
  old.Mounts = [{ Type: 'bind', Source: source, Destination: '/results', RW: true }];
  f.containers.set(old.Id, old);
  const result = await f.run(), operation = await f.readOperation();
  assert.equal(result.status, 'recovered'); assert.deepEqual(f.removed, [containerId]);
  const evidence = operation.deathEvidence.afterRemoval.missingMounts;
  assert.equal(evidence.length, 1); assert.equal(evidence[0].containerId, old.Id); assert.equal(evidence[0].source, source);
  assert.deepEqual(evidence[0].missingComponents, [source, path.dirname(source)]);
  assert.equal(evidence[0].ancestor.canonicalPath, unrelated); assert.equal(evidence[0].overlapsProtected, false);
  assert.equal(operation.deathEvidence.afterRemoval.writers.some(c => c.id === old.Id), false);
  assert.deepEqual(operation.beforeRemoval.missingMounts, evidence);
});

test('dead writer missing mount rejects active and restart-enabled containers before exclusion', async t => {
  for (const mode of ['active', 'restart-enabled']) await t.test(mode, async sub => {
    const f = await fixture(sub), unrelated = path.join(f.root, 'unrelated'); await mkdir(unrelated);
    const old = structuredClone(f.target); old.Id = 'c'.repeat(64);
    old.Mounts = [{ Type: 'bind', Source: path.join(unrelated, 'missing'), Destination: '/results', RW: true }];
    if (mode === 'active') old.State = { ...old.State, Status: 'running', Running: true, Pid: 23 };
    else old.HostConfig.RestartPolicy.Name = 'unless-stopped';
    f.containers.set(old.Id, old);
    await assert.rejects(f.run(), { code: 'DEAD_WRITER_NOT_QUIESCENT' });
    assert.equal(f.removed.length, 0); assert.equal(f.proofs.length, 0);
  });
});

test('dead writer missing mount rejects dangling symlinks and aliases to the protected workspace', async t => {
  if (process.platform !== 'linux') { t.skip('Requires native Linux symbolic links without Windows privilege assumptions.'); return; }
  const { symlink } = await import('node:fs/promises');
  for (const mode of ['dangling', 'workspace-alias']) await t.test(mode, async sub => {
    const f = await fixture(sub), unrelated = path.join(f.root, 'unrelated'); await mkdir(unrelated);
    const alias = path.join(unrelated, 'alias');
    await symlink(mode === 'dangling' ? path.join(unrelated, 'absent') : f.workspace, alias, 'dir');
    const old = structuredClone(f.target); old.Id = 'c'.repeat(64);
    old.Mounts = [{ Type: 'bind', Source: path.join(alias, 'missing'), Destination: '/results', RW: true }];
    f.containers.set(old.Id, old);
    await assert.rejects(f.run(), { code: 'DEAD_WRITER_PATH_INVALID' });
    assert.equal(f.removed.length, 0); assert.equal(f.proofs.length, 0);
  });
});

test('dead writer missing mount retains a stopped writer whose existing ancestor overlaps the task', async t => {
  const f = await fixture(t), old = structuredClone(f.target); old.Id = 'c'.repeat(64);
  old.Mounts = [{ Type: 'bind', Source: path.join(f.workspace, 'missing', 'results'), Destination: '/results', RW: true }];
  f.containers.set(old.Id, old);
  await f.run();
  const scan = (await f.readOperation()).deathEvidence.afterRemoval;
  assert.deepEqual(scan.writers.map(c => c.id), [old.Id]);
  assert.equal(scan.missingMounts[0].overlapsProtected, true);
  assert.equal(scan.missingMounts[0].ancestor.canonicalPath, f.workspace);
  assert.deepEqual(f.removed, [containerId]);
});
