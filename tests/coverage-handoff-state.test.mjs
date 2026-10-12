import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DeliveryError, ForgeDeliveryStore } from '../docker/harness/forge-delivery.mjs';

const exec = promisify(execFile);
const expected = code => error => error instanceof DeliveryError && error.code === code;
// All commits, source markers and handoffs live in a private platform fixture.
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'coverage-handoff-state-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('coverage-handoff-state-'));
    await rm(root, { recursive: true, force: true });
  });
  const git = (...args) => exec('git', ['-C', root, '-c', 'user.name=Coverage Platform Fixture',
    '-c', 'user.email=coverage@example.invalid', '-c', 'commit.gpgsign=false', ...args]);
  await git('init');
  await writeFile(path.join(root, '.git', 'info', 'exclude'), '/.forge-delivery/\n');
  const source = path.join(root, 'source.txt');
  await writeFile(source, 'initial platform fixture\n');
  await git('add', 'source.txt');
  await git('commit', '-m', 'Platform handoff fixture');
  const store = new ForgeDeliveryStore(root);
  const changeId = 'coverage_handoff';
  await store.initChange({ changeId, objective: 'Verify platform handoff binding', idempotencyKey: 'coverage-init-001' });
  const handoffId = 'original_handoff';
  await store.createHandoff({ handoffId, changeId, sourcePaths: ['source.txt'] });
  const recordPath = path.join(root, '.forge-delivery', 'handoffs', `${handoffId}.json`);
  const record = await readFile(recordPath);
  assert.equal((await store.verifyHandoff(handoffId)).recordIntegrityValid, true);
  return { root, git, source, store, changeId, handoffId, recordPath, record };
}

test('source and record tampering are separately rejected without rewriting the handoff', async t => {
  const f = await fixture(t);
  const source = await readFile(f.source);
  await writeFile(f.source, 'tampered platform fixture\n');
  await assert.rejects(f.store.verifyHandoff(f.handoffId), expected('HANDOFF_SOURCE_TAMPERED'));
  assert.deepEqual(await readFile(f.recordPath), f.record);
  await writeFile(f.source, source);
  assert.equal((await f.store.verifyHandoff(f.handoffId)).recordIntegrityValid, true);
  const forged = JSON.parse(f.record); forged.sources[0].bytes += 1;
  await writeFile(f.recordPath, `${JSON.stringify(forged, null, 2)}\n`);
  const forgedBytes = await readFile(f.recordPath);
  await assert.rejects(f.store.verifyHandoff(f.handoffId), expected('HANDOFF_TAMPERED'));
  assert.deepEqual(await readFile(f.recordPath), forgedBytes);
});

test('commit drift with unchanged source requires a new handoff ID and preserves the old record', async t => {
  const f = await fixture(t);
  const source = await readFile(f.source);
  const oldCommit = (await f.git('rev-parse', 'HEAD')).stdout.trim();
  await f.git('commit', '--allow-empty', '-m', 'Advance platform fixture HEAD');
  const newCommit = (await f.git('rev-parse', 'HEAD')).stdout.trim();
  assert.notEqual(newCommit, oldCommit);
  assert.deepEqual(await readFile(f.source), source);
  await assert.rejects(f.store.verifyHandoff(f.handoffId), expected('STALE_HANDOFF_COMMIT'));
  assert.deepEqual(await readFile(f.recordPath), f.record);
  await assert.rejects(f.store.createHandoff({ handoffId: f.handoffId, changeId: f.changeId,
    sourcePaths: ['source.txt'] }), expected('HANDOFF_ALREADY_EXISTS'));
  assert.deepEqual(await readFile(f.recordPath), f.record);
  const created = await f.store.createHandoff({ handoffId: 'current_handoff', changeId: f.changeId,
    sourcePaths: ['source.txt'] });
  assert.equal(created.handoff.commit, newCommit);
  assert.equal((await f.store.verifyHandoff('current_handoff')).recordIntegrityValid, true);
  assert.deepEqual(await readFile(f.recordPath), f.record);
});
