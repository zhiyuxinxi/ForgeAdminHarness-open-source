import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DeliveryError, ForgeDeliveryStore } from '../docker/harness/forge-delivery.mjs';

const exec = promisify(execFile);
// Empty platform fixture only; never uses a business workspace or state record.
test('illegal state jump preserves exact record bytes, version and append-only history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coverage-fsm-state-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('coverage-fsm-state-'));
    await rm(root, { recursive: true, force: true });
  });
  await exec('git', ['-C', root, 'init']);
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '/.forge-delivery/\n');
  await exec('git', ['-C', root, '-c', 'user.name=Coverage Platform Fixture',
    '-c', 'user.email=coverage@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'Empty platform fixture']);
  const store = new ForgeDeliveryStore(root);
  const changeId = 'coverage_fsm';
  await store.initChange({ changeId, objective: 'Reject illegal platform state jump', idempotencyKey: 'coverage-init-001' });
  const recordPath = path.join(root, '.forge-delivery', 'changes', `${changeId}.json`);
  const before = await readFile(recordPath);
  const state = (await store.statusChange(changeId)).change;
  assert.equal(state.state, 'scoped');
  assert.equal(state.version, 1);
  assert.equal(state.history.length, 1);
  await assert.rejects(store.transitionChange({ changeId, to: 'implemented', expectedVersion: 1,
    idempotencyKey: 'coverage-illegal-001' }), error => error instanceof DeliveryError && error.code === 'ILLEGAL_STATE_TRANSITION');
  assert.deepEqual(await readFile(recordPath), before);
  assert.deepEqual((await store.statusChange(changeId)).change, state);
});
