import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DeliveryError, ForgeDeliveryStore } from '../docker/harness/forge-delivery.mjs';

const exec = promisify(execFile);
// Empty temporary platform repositories only. These are not business tests,
// model traces or protected-runtime acceptance receipts.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coverage-cas-state-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('coverage-cas-state-'));
    await rm(root, { recursive: true, force: true });
  });
  await exec('git', ['-C', root, 'init']);
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '/.forge-delivery/\n');
  await exec('git', ['-C', root, '-c', 'user.name=Coverage Platform Fixture',
    '-c', 'user.email=coverage@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'Empty platform fixture']);
  const store = new ForgeDeliveryStore(root);
  const changeId = 'coverage_cas';
  const recordPath = path.join(root, '.forge-delivery', 'changes', `${changeId}.json`);
  await store.initChange({ changeId, objective: 'Bounded platform state invariant', idempotencyKey: 'coverage-init-001' });
  return { store, changeId, recordPath };
}

async function snapshot(value) {
  return { bytes: await readFile(value.recordPath), change: (await value.store.statusChange(value.changeId)).change };
}

test('stale CAS rejection preserves exact state bytes, version and history', async t => {
  const value = await fixture(t);
  await value.store.transitionChange({ changeId: value.changeId, to: 'designed', expectedVersion: 1, idempotencyKey: 'coverage-design-001' });
  const before = await snapshot(value);
  await assert.rejects(value.store.transitionChange({ changeId: value.changeId, to: 'implementing', expectedVersion: 1,
    idempotencyKey: 'coverage-stale-001' }), error => error instanceof DeliveryError && error.code === 'VERSION_CONFLICT');
  assert.deepEqual(await snapshot(value), before);
  assert.equal(before.change.version, 2);
  assert.equal(before.change.history.length, 2);
});

test('same-request replay and conflicting-key rejection never append or rewrite state', async t => {
  const value = await fixture(t);
  const request = { changeId: value.changeId, to: 'designed', expectedVersion: 1, idempotencyKey: 'coverage-replay-001' };
  const first = await value.store.transitionChange(request);
  assert.equal(first.idempotent, false);
  const before = await snapshot(value);
  const replay = await value.store.transitionChange(request);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.change, first.change);
  assert.deepEqual(await snapshot(value), before);
  await assert.rejects(value.store.transitionChange({ ...request, to: 'implementing', expectedVersion: 2 }),
    error => error instanceof DeliveryError && error.code === 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual(await snapshot(value), before);
});

test('two concurrent writers produce exactly one state transition', async t => {
  const value = await fixture(t);
  const results = await Promise.allSettled(['writer-one-001', 'writer-two-001'].map(idempotencyKey =>
    value.store.transitionChange({ changeId: value.changeId, to: 'designed', expectedVersion: 1, idempotencyKey })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected').reason;
  assert.ok(rejected instanceof DeliveryError);
  assert.ok(['CHANGE_LOCKED', 'VERSION_CONFLICT'].includes(rejected.code), rejected.code);
  const after = await snapshot(value);
  assert.equal(after.change.state, 'designed');
  assert.equal(after.change.version, 2);
  assert.equal(after.change.history.length, 2);
  assert.deepEqual(after.change.history.map(entry => entry.toVersion), [1, 2]);
  const winner = results.find(result => result.status === 'fulfilled').value;
  assert.deepEqual(after.change, winner.change);
});
