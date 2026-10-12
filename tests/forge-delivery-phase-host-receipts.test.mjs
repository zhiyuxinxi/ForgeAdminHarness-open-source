import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { collectForgePhaseHostReceipts, readForgePhaseHostReceipt } from '../docker/harness/forge-delivery-phase-host-receipts.mjs';
import { createForgePhaseHostReceipt } from './helpers/forge-phase-host-receipt-fixture.mjs';

const receiptId = '123e4567-e89b-12d3-a456-426614174000';
const input = { projectSlug: 'forge-project', taskId: 'task-one', sourceFingerprint: 'b'.repeat(64),
  sourceCommit: 'a'.repeat(40), patchDigest: 'd'.repeat(64), profiles: ['governance'] };
const proposal = { payload: { checks: [{ profile: 'governance', receiptId, status: 'passed' }] } };
const identity = { projectSlug: input.projectSlug, taskId: input.taskId, receiptId };

test('phase Host receipts use real evidence, required order and one read per hinted ID', async () => {
  const other = '123e4567-e89b-12d3-a456-426614174002';
  const reads = [];
  const result = await collectForgePhaseHostReceipts({ ...input, profiles: ['frontend-admin-test', 'governance'],
    proposal: { nested: [proposal, proposal, { profile: 'frontend-admin-test', receiptId: other, status: 'failed' },
      { profile: 'full-regression', receiptId: '123e4567-e89b-12d3-a456-426614174003' }] },
    receiptReader: async (request) => {
      reads.push(request);
      return createForgePhaseHostReceipt({ receiptId: request.receiptId,
        profile: request.receiptId === other ? 'frontend-admin-test' : 'governance' });
    } });
  assert.equal(result.status, 'verified');
  assert.deepEqual(reads.map((entry) => entry.receiptId), [other, receiptId]);
  assert.deepEqual(result.receipts.map((entry) => entry.profile), ['frontend-admin-test', 'governance']);
  assert.deepEqual(result.missingProfiles, []);
  assert.deepEqual(result.failures, []);
  for (const [index, native] of result.nativeReceipts.entries()) {
    const digest = crypto.createHash('sha256').update(`${JSON.stringify(native, null, 2)}\n`).digest('hex');
    assert.equal(result.receipts[index].receiptDigest, digest);
    assert.equal(result.receipts[index].patchDigest, input.patchDigest);
    assert.notEqual(result.receipts[index].patchDigest, native.source.workspaceFingerprint);
  }
});

test('model claimed pass cannot replace an actual failed Host result', async () => {
  const native = createForgePhaseHostReceipt();
  native.status = 'failed';
  native.execution.exitCode = native.execution.steps[0].exitCode = 1;
  native.results = { ...native.results, passed: 0, failed: 1 };
  native.truth.verificationProven = false;
  const result = await collectForgePhaseHostReceipts({ ...input, proposal, receiptReader: async () => native });
  assert.equal(result.status, 'required');
  assert.deepEqual(result.receipts, []);
  assert.deepEqual(result.nativeReceipts, []);
  assert.deepEqual(result.missingProfiles, ['governance']);
  assert.equal(result.failures[0].code, 'PHASE_HOST_RECEIPT_NOT_PASSED');
});

test('phase Host receipts reject other identities, source, head, stale and narrowed checks', async (t) => {
  const cases = {
    project: (value) => { value.projectSlug = 'another-project'; },
    task: (value) => { value.taskId = 'another-task'; },
    receipt: (value) => { value.receiptId = '123e4567-e89b-12d3-a456-426614174004'; },
    profile: (value) => { value.request.profile = 'frontend-admin-test'; },
    source: (value) => { value.source.workspaceFingerprint = value.source.snapshotSha256 = 'e'.repeat(64); },
    head: (value) => { value.source.head = 'f'.repeat(40); },
    stale: (value) => { value.freshness = 'stale'; },
    selectors: (value) => { value.request.selectors = { testFiles: ['one.test.js'] }; },
  };
  for (const [name, mutate] of Object.entries(cases)) await t.test(name, async () => {
    const native = createForgePhaseHostReceipt();
    mutate(native);
    const result = await collectForgePhaseHostReceipts({ ...input, proposal, receiptReader: async () => native });
    assert.equal(result.status, 'required');
    assert.deepEqual(result.receipts, []);
    assert.deepEqual(result.missingProfiles, ['governance']);
    assert.equal(result.failures.length, 1);
  });
});

test('missing IDs and deeply nested hints cannot manufacture or start verification', async () => {
  let deep = proposal;
  for (let depth = 0; depth < 14; depth += 1) deep = { nested: deep };
  const result = await collectForgePhaseHostReceipts({ ...input,
    proposal: { checks: [{ profile: 'governance', status: 'passed' },
      { profile: 'governance', receiptId: '--run-something' }], deep },
    receiptReader: async () => assert.fail('No usable receipt ID was supplied') });
  assert.equal(result.status, 'required');
  assert.deepEqual(result.missingProfiles, ['governance']);
  assert.deepEqual(result.failures, []);
});

test('hint collection bounds unique IDs and caches failures without leaking diagnostics', async () => {
  const hints = Array.from({ length: 40 }, (_, index) => ({ profile: 'governance',
    receiptId: `123e4567-e89b-12d3-a456-${String(index).padStart(12, '0')}` }));
  let calls = 0;
  const result = await collectForgePhaseHostReceipts({ ...input, proposal: [hints, hints],
    receiptReader: async () => { calls += 1; throw new Error('private diagnostic text'); } });
  assert.equal(calls, 32);
  assert.equal(result.failures.length, 32);
  assert.equal(result.status, 'required');
  assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
  assert.ok(result.failures.every((entry) => entry.code === 'PHASE_HOST_RECEIPT_UNAVAILABLE'));
});

test('validated diagnostic excerpts are removed from native evidence and digest', async () => {
  const canonical = createForgePhaseHostReceipt();
  const native = { ...canonical, logs: { ...canonical.logs, excerpt: 'bounded diagnostic\nnot evidence' } };
  const result = await collectForgePhaseHostReceipts({ ...input, proposal, receiptReader: async () => native });
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.nativeReceipts, [canonical]);
  assert.ok(Object.hasOwn(native.logs, 'excerpt'), 'Caller input is not mutated');
  const digest = crypto.createHash('sha256').update(`${JSON.stringify(canonical, null, 2)}\n`).digest('hex');
  assert.equal(result.receipts[0].receiptDigest, digest);
  for (const excerpt of ['\u0000', '\r', '\u0085', 'x'.repeat(16 * 1024 + 1), 1]) {
    const rejected = await collectForgePhaseHostReceipts({ ...input, proposal,
      receiptReader: async () => ({ ...canonical, logs: { ...canonical.logs, excerpt } }) });
    assert.equal(rejected.status, 'required');
    assert.equal(rejected.failures[0].code, 'PHASE_HOST_RECEIPT_INVALID');
  }
});

test('frontend lint receipts cover every changed frontend source file', async () => {
  const files = ['forge-admin-ui/src/views/business/example.vue',
    'forge-admin-ui/src/views/business/example-contract.js',
    'forge-admin-ui/src/views/business/__tests__/example-contract.test.js'];
  const options = { ...input, profiles: ['frontend-admin-lint'],
    phaseChangedPaths: [...files, 'docs/example.md'],
    proposal: { checks: [{ profile: 'frontend-admin-lint', receiptId }] } };
  const native = createForgePhaseHostReceipt({ profile: 'frontend-admin-lint', selectors: { files: [...files].reverse() } });
  const result = await collectForgePhaseHostReceipts({ ...options, receiptReader: async () => native });
  assert.equal(result.status, 'verified');
  assert.deepEqual(result.nativeReceipts, [native]);
  const incomplete = createForgePhaseHostReceipt({ profile: 'frontend-admin-lint', selectors: { files: files.slice(0, 2) } });
  const rejected = await collectForgePhaseHostReceipts({ ...options, receiptReader: async () => incomplete });
  assert.equal(rejected.status, 'required');
  assert.deepEqual(rejected.missingProfiles, ['frontend-admin-lint']);
  assert.equal(rejected.failures[0].code, 'PHASE_HOST_RECEIPT_SELECTORS_NARROWED');
  const unknownScope = await collectForgePhaseHostReceipts({ ...options, phaseChangedPaths: [], receiptReader: async () => native });
  assert.equal(unknownScope.status, 'required');
});

test('backend module receipts cover the actual phase paths and reject uncovered or escaping selectors', async () => {
  const module = 'forge-server/forge-business/forge-business-core';
  const paths = [`${module}/src/main/java/example/InventoryService.java`,
    `${module}/src/main/resources/mapper/InventoryMapper.xml`,
    `${module}/src/test/java/example/InventoryServiceTest.java`];
  for (const profile of ['backend-module-compile', 'backend-module-test']) {
    const collect = async (selectors, phaseChangedPaths = paths) => {
      const native = createForgePhaseHostReceipt({ profile, selectors });
      return collectForgePhaseHostReceipts({ ...input, phaseId: 'backend', profiles: [profile],
        phaseChangedPaths, proposal: { payload: { verification: [{ profile, receiptId }] } },
        receiptReader: async () => native });
    };
    const accepted = await collect({ modules: [module] });
    assert.equal(accepted.status, 'verified', profile);
    assert.deepEqual(accepted.missingProfiles, []);
    assert.equal(accepted.receipts[0].patchDigest, input.patchDigest);

    const otherModule = 'forge-server/inventory/inventory-core';
    const generic = await collect({ modules: [otherModule] }, [`${otherModule}/src/main/java/example/Item.java`]);
    assert.equal(generic.status, 'verified', `${profile}: another covered module`);
    for (const [name, selectors, changed] of [
      ['uncovered path', { modules: [module] }, [...paths, `${otherModule}/src/main/java/example/Item.java`]],
      ['sibling prefix', { modules: [module] }, [`${module}-other/src/main/java/example/Item.java`]],
      ['unrelated module', { modules: [module, otherModule] }, paths],
      ['duplicate module', { modules: [module, module] }, paths],
      ['module traversal', { modules: [`${module}/../other`] }, [`${module}/../other/src/main/java/example/Item.java`]],
      ['path traversal', { modules: [module] }, [`${module}/src/../../outside.java`]],
      ['absolute module', { modules: [`/${module}`] }, paths],
      ['extra selector', { modules: [module], tests: ['InventoryServiceTest'] }, paths],
      ['unknown phase paths', { modules: [module] }, []],
    ]) {
      const rejected = await collect(selectors, changed);
      assert.equal(rejected.status, 'required', `${profile}: ${name}`);
      assert.deepEqual(rejected.receipts, [], `${profile}: ${name}`);
      assert.deepEqual(rejected.missingProfiles, [profile], `${profile}: ${name}`);
      assert.equal(rejected.failures[0].code, 'PHASE_HOST_RECEIPT_SELECTORS_NARROWED', `${profile}: ${name}`);
    }
  }
});

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  return child;
}

test('receipt reader uses only the fixed TaskSpace CLI argv and discards diagnostics', async (t) => {
  const child = fakeProcess();
  const spawn = t.mock.method(childProcess, 'spawn', () => child);
  const pending = readForgePhaseHostReceipt(identity);
  const canonical = createForgePhaseHostReceipt();
  child.stdout.write(JSON.stringify({ ...canonical, logs: { ...canonical.logs, excerpt: 'diagnostic' } }));
  child.emit('close', 0);
  assert.deepEqual(await pending, canonical);
  assert.deepEqual(spawn.mock.calls[0].arguments, ['docker', [
    'exec', 'forge-forge-project-task-task-one-harness-1', '/usr/local/bin/forge-verify',
    'receipt', '--receipt-id', receiptId,
  ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }]);
  await assert.rejects(readForgePhaseHostReceipt({ ...identity, projectSlug: 'p;echo bad' }),
    { code: 'PHASE_HOST_RECEIPT_INPUT_INVALID' });
  await assert.rejects(readForgePhaseHostReceipt({ ...identity, receiptId: '--run' }),
    { code: 'PHASE_HOST_RECEIPT_INPUT_INVALID' });
  assert.equal(spawn.mock.callCount(), 1);
});

test('receipt reader bounds output, timeout and failures without returning stderr', async (t) => {
  for (const stream of ['stdout', 'stderr']) await t.test(`${stream} limit`, async (subtest) => {
    const child = fakeProcess();
    subtest.mock.method(childProcess, 'spawn', () => child);
    const pending = readForgePhaseHostReceipt(identity);
    child[stream].write(Buffer.alloc((stream === 'stdout' ? 2 * 1024 * 1024 : 64 * 1024) + 1));
    await assert.rejects(pending, { code: 'PHASE_HOST_RECEIPT_OUTPUT_LIMIT' });
    assert.deepEqual(child.signals, ['SIGTERM']);
  });
  await t.test('60 second deadline', async (subtest) => {
    const child = fakeProcess();
    subtest.mock.method(childProcess, 'spawn', () => child);
    subtest.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = readForgePhaseHostReceipt(identity);
    subtest.mock.timers.tick(60_000);
    await assert.rejects(pending, { code: 'PHASE_HOST_RECEIPT_TIMEOUT' });
    assert.deepEqual(child.signals, ['SIGTERM']);
  });
  await t.test('nonzero CLI result', async (subtest) => {
    const child = fakeProcess();
    subtest.mock.method(childProcess, 'spawn', () => child);
    const pending = readForgePhaseHostReceipt(identity);
    child.stderr.write('private diagnostic');
    child.emit('close', 1);
    await assert.rejects(pending, { code: 'PHASE_HOST_RECEIPT_UNAVAILABLE', message: 'PHASE_HOST_RECEIPT_UNAVAILABLE' });
  });
  await t.test('malformed JSON', async (subtest) => {
    const child = fakeProcess();
    subtest.mock.method(childProcess, 'spawn', () => child);
    const pending = readForgePhaseHostReceipt(identity);
    child.stdout.write('not json: private diagnostic');
    child.emit('close', 0);
    await assert.rejects(pending, { code: 'PHASE_HOST_RECEIPT_INVALID', message: 'PHASE_HOST_RECEIPT_INVALID' });
  });
});
