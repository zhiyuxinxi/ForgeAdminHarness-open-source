import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fixture from './fixtures/forge-change-contract/valid.json' with { type: 'json' };
import { executeCommand } from '../docker/harness/forge-delivery.mjs';
import { parseControlledDeliveryCommand } from '../docker/harness/forge-controlled-command.mjs';

async function setup(t) {
  const parent = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(parent, 'forge-contract-cli-'));
  t.after(async () => {
    const resolved = await realpath(root);
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('forge-contract-cli-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init'); git('config', 'user.name', 'Contract fixture'); git('config', 'user.email', 'contract@example.invalid');
  await writeFile(path.join(root, '.git/info/exclude'), '/.forge-delivery/\n');
  const { source, ...input } = structuredClone(fixture);
  await writeFile(path.join(root, 'contract.json'), JSON.stringify(input));
  git('add', 'contract.json'); git('commit', '-m', 'fixture');
  const run = (...args) => executeCommand(['contract', ...args], { cwd: root });
  return { root, input, run, head: git('rev-parse', 'HEAD').trim() };
}

test('contract CLI binds actual source and preserves old review/verification bindings after WHAT or HOW drift', async t => {
  const { root, input, run, head } = await setup(t);
  const inspected = await run('inspect', '--source', 'contract.json');
  assert.equal(inspected.contract.source.head, head); assert.equal(inspected.executionProved, false);
  await assert.rejects(stat(path.join(root, '.forge-delivery')), { code: 'ENOENT' });
  const records = {};
  for (const purpose of ['review', 'verification']) {
    const result = await run('bind', '--source', 'contract.json', '--binding', purpose + '-001', '--purpose', purpose);
    assert.equal(result.executionProved, false); assert.equal(result.idempotent, false);
    const again = await run('bind', '--source', 'contract.json', '--binding', purpose + '-001', '--purpose', purpose);
    assert.equal(again.idempotent, true); assert.deepEqual(again.record, result.record);
    const file = path.join(root, '.forge-delivery/contracts', purpose + '-001.json');
    records[purpose] = { file, bytes: await readFile(file) };
  }
  const reordered = structuredClone(input); reordered.what.requirements.reverse(); reordered.how.decisions.reverse(); reordered.tasks.reverse();
  await writeFile(path.join(root, 'contract.json'), JSON.stringify(reordered, null, 4) + '\n');
  assert.equal((await run('verify', '--source', 'contract.json', '--binding', 'review-001')).verification.valid, true);
  for (const layer of ['how', 'what']) {
    const changed = structuredClone(input); changed.revision = 2;
    if (layer === 'what') changed.what.requirements[0].statement = 'Require the newly approved semantic requirement.';
    else changed.how.decisions[0].statement = 'Use the newly selected implementation approach.';
    await writeFile(path.join(root, 'contract.json'), JSON.stringify(changed));
    for (const [purpose, old] of Object.entries(records)) {
      await assert.rejects(run('verify', '--source', 'contract.json', '--binding', purpose + '-001'), error => {
        assert.equal(error.code, 'STALE_CONTRACT_BINDING');
        assert.equal(error.details.executionProved, false);
        assert.equal(error.details.drift.whatChanged, layer === 'what');
        assert.equal(error.details.drift.howChanged, true); assert.equal(error.details.drift.tasksChanged, true);
        return true;
      });
      assert.deepEqual(await readFile(old.file), old.bytes);
    }
    await assert.rejects(run('bind', '--source', 'contract.json', '--binding', 'review-001', '--purpose', 'review'), { code: 'CONTRACT_BINDING_ALREADY_EXISTS' });
  }
});

test('contract CLI refuses caller-supplied source identity, source substitution, and tampered saved bindings', async t => {
  const { root, input, run } = await setup(t);
  await assert.rejects(run('inspect', '--source', '../contract.json'), { code: 'INVALID_RELATIVE_PATH' });
  await run('bind', '--source', 'contract.json', '--binding', 'review-001', '--purpose', 'review');
  await writeFile(path.join(root, 'other.json'), JSON.stringify(input));
  await assert.rejects(run('verify', '--source', 'other.json', '--binding', 'review-001'), { code: 'CONTRACT_SOURCE_MISMATCH' });
  await writeFile(path.join(root, 'contract.json'), JSON.stringify({ ...input, source: fixture.source }));
  await assert.rejects(run('inspect', '--source', 'contract.json'), { code: 'INVALID_CONTRACT_INPUT' });
  await writeFile(path.join(root, 'contract.json'), JSON.stringify(input));
  const file = path.join(root, '.forge-delivery/contracts/review-001.json');
  const bad = JSON.parse(await readFile(file, 'utf8')); bad.binding.purpose = 'verification';
  await writeFile(file, JSON.stringify(bad)); const bytes = await readFile(file);
  await assert.rejects(run('verify', '--source', 'contract.json', '--binding', 'review-001'), { code: 'INVALID_CONTRACT_RECORD' });
  assert.deepEqual(await readFile(file), bytes);
});

test('controlled contract syntax exposes metadata only and rejects composed or ambiguous source commands', () => {
  for (const command of [
    'forge-delivery contract inspect --source spec.json',
    'forge-delivery contract verify --source spec.json --binding review-001',
    'forge-delivery contract bind --source spec.json --binding review-001 --purpose review',
  ]) assert.ok(parseControlledDeliveryCommand(command), command);
  assert.equal(parseControlledDeliveryCommand('forge-delivery contract inspect --source spec.json').mutation, false);
  assert.equal(parseControlledDeliveryCommand('forge-delivery contract bind --source spec.json --binding verify-001 --purpose verification').mutation, true);
  for (const command of [
    'forge-delivery contract inspect --source ../spec.json',
    'forge-delivery contract inspect --source spec.json --source other.json',
    'forge-delivery contract inspect --source spec.json; echo passed',
    'forge-delivery contract bind --source spec.json --binding release-001 --purpose release',
    'forge-delivery contract inspect --source .forge-delivery/contracts/fake.json',
  ]) assert.equal(parseControlledDeliveryCommand(command), null, command);
});
