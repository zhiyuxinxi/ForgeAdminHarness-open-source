import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SOURCE_QUALITY_PROFILE, SOURCE_QUALITY_BUNDLE_SHA256, sourceQualitySelectors } from '../docker/harness/forge-backend-source-quality.mjs';

import {
  hostExecutionEnvironment,
  HOST_FRONTEND_TYPECHECK_PATH,
  hostSandboxCommand,
  hostSandboxReadOnlyRoots,
  hostProfilePolicyDigest,
  hostProfilePolicyDescriptor,
  validateH5ProfilePolicyTransition,
  hostVerificationCommand,
  validateHostVerificationContract,
} from '../docker/harness/host-verify-policy.mjs';
import { assertHostJobDirectories, HostVerificationRunner, preparedFrontendDependencies, preparedDependencyInputs, runHostProcess } from '../docker/harness/host-verification-runner.mjs';
import { hostRevalidationToolchainsMatch, validateHostExecutionAdmissionReceipt, validateHostRunReceipt } from '../docker/harness/forge-host-verification-receipt.mjs';
import { controlledEvidenceReceipt } from '../docker/harness/forge-controlled-command.mjs';
import { VERIFY_PROFILE_NAMES, governanceRoleGrantPolicyForContract, governanceTaskScopeForContract, revalidatedGovernanceTaskArguments } from '../docker/harness/verify-policy.mjs';
import { createDependencySeedManifest } from '../docker/harness/host-dependency-seed.mjs';
import { sourceTransitionCanonicalDigest } from '../docker/harness/taskspace-policy.mjs';
import { normalizeReferenceProvenancePolicy } from '../docker/harness/forge-reference-provenance.mjs';
import { reconstructReviewedReceiptSourceProjection } from '../docker/harness/host-verification-runner.mjs';
import { nodeTestReportResults } from '../docker/harness/verification-runner.mjs';
import { hostRunReceiptDigest, reviewedReceiptGovernanceBindingDigest,
  validateReviewedReceiptSourcePolicy } from '../docker/harness/forge-host-verification-receipt.mjs';

async function reviewedSourceHostCase(sub, profile, consumeProjection) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-reviewed-source-'));
    sub.after(() => rm(root, { recursive: true, force: true }));
    await fixture(root);
    const descriptor = (relative, text) => ({ relative, bytes: Buffer.byteLength(text),
      sha256: crypto.createHash('sha256').update(text).digest('hex') });
    const scoped = descriptor('forge-server/example/src/test/java/example/MapperTest.java', 'original test');
    let files = [scoped];
    const inventory = async () => {
      const sorted = [...files].sort((a, b) => a.relative < b.relative ? -1 : 1);
      const digest = crypto.createHash('sha256');
      for (const file of sorted) digest.update(file.relative).update('\0').update(file.sha256).update('\0').update(String(file.bytes)).update('\0');
      return { head: 'b'.repeat(40), files: sorted, fileCount: sorted.length, bytes: sorted.reduce((n, f) => n + f.bytes, 0),
        workspaceFingerprint: digest.digest('hex'), dependencyManifestFingerprint: 'c'.repeat(64), dependencyManifestFiles: [] };
    };
    const currentContract = validateHostVerificationContract(contract(root));
    let policies;
    let revokeOnBind = false;
    let bindings = 0;
    let executions = 0;
    const trustedBinding = id => ({ governanceTaskScope: { contractId: id, ownedPaths: [scoped.relative] },
      governanceRoleGrantPolicy: { contractId: id, decisions: [] } });
    const runner = new HostVerificationRunner({ projectSlug: 'forge-host', contract: currentContract, inventory, snapshot,
      toolchainProbe: async () => toolchainIdentity(currentContract),
      command: async (_exe, argv, options) => {
        if (['merge-base', 'rev-parse', 'diff', 'ls-files', 'ls-tree'].includes(argv[0])) return result();
        executions += 1;
        if (argv.at(-1) === 'test') {
          const reports = path.join(options.cwd, 'target', 'surefire-reports');
          await mkdir(reports, { recursive: true });
          await writeFile(path.join(reports, 'TEST-example.xml'), '<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>');
        }
        return result();
      }, acceptanceIssuerClient: async (route, body) => {
        if (route !== '/v1/candidate-bindings') return { accepted: true };
        // Match the real HTTP boundary: undefined fields disappear on the wire.
        body = JSON.parse(JSON.stringify(body));
        assert.deepEqual(Object.keys(body).sort(), ['admissionReceipt', 'candidateBinding', 'contractId', 'taskId']);
        validateHostExecutionAdmissionReceipt(body.admissionReceipt, { projectSlug: 'forge-host', taskId: 'task-one' });
        bindings += 1;
        const current = await inventory();
        return { acceptanceContract: { contractId: body.contractId, projectSlug: 'forge-host', taskId: 'task-one',
          candidate: { source: { head: current.head, fingerprint: current.workspaceFingerprint } } },
        ...trustedBinding(body.contractId), ...(policies === undefined ? {} : {
          reviewedReceiptSourceProjections: revokeOnBind && bindings % 2 === 0 ? [] : policies }) };
      } });
    const selectors = profile === 'governance' ? {} : { modules: ['forge-server/example'], tests: ['example.MapperTest'] };
    const initial = await runner.admit('task-one', [profile]);
    const request = { taskId: 'task-one', action: 'run', profile, selectors, admissionId: initial.admissionId,
      acceptanceContractId: 'd'.repeat(64), candidateBinding: {}, idempotencyKey: 'original-reviewed-source' };
    const original = await runner.execute(request);
    assert.equal(original.status, 'passed');
    const receiptFile = path.join(runner.stateRoot, 'receipts', 'task-one', `${original.receiptId}.json`);
    const originalBytes = await readFile(receiptFile);
    const logBytes = await readFile(original.logs.path);
    const executed = executions;
    runner.prepareJob = async () => assert.fail('reviewed receipt reuse must never start another execution');
    const additions = [descriptor('code-copilot/changes/writer/spec.md', 'unrelated spec'),
      descriptor('forge-admin-ui/src/new.js', 'unrelated frontend'),
      descriptor('forge-server/db/migration/V999__unrelated.sql', 'unrelated SQL')];
    files = [...files, ...additions];
    const admission = await runner.admit('task-one', [profile]);
    const binding = trustedBinding('e'.repeat(64));
    const policy = { schemaVersion: 1, projectSlug: original.projectSlug, taskId: original.taskId,
      receiptId: original.receiptId, originalReceiptSha256: hostRunReceiptDigest(original), profile,
      selectorsSha256: original.request.selectorsSha256, head: original.source.head,
      originalFingerprint: original.source.workspaceFingerprint, currentFingerprint: admission.source.workspaceFingerprint,
      dependencyManifestFingerprint: original.source.dependencyManifestFingerprint,
      originalToolchainDigest: original.toolchain.digest, currentToolchainDigest: admission.toolchain.digest,
      profilePolicyDigest: original.policy.profilePolicyDigest, profileCatalogVersion: original.policy.profileCatalogVersion,
      reviewBase: 'b'.repeat(40), governanceBindingSha256: reviewedReceiptGovernanceBindingDigest(binding),
      scopeFiles: [{ path: scoped.relative, bytes: scoped.bytes, sha256: scoped.sha256 }],
      changes: additions.map(({ relative, bytes, sha256 }) => ({ path: relative, before: null, after: { bytes, sha256 } })),
      reviewEvidenceSha256: '9'.repeat(64) };
    policies = [policy];
    const reuse = { ...request, receiptId: original.receiptId, admissionId: admission.admissionId,
      acceptanceContractId: 'e'.repeat(64), idempotencyKey: 'reviewed-source-reuse' };
    const projected = await runner.execute(reuse);
    if (consumeProjection) return consumeProjection({ profile, selectors, admission, original, projected, reuse, receiptFile, originalBytes,
      policy, binding, source: { inventory: await inventory(), reviewBase: 'b'.repeat(40) } });
    validateHostRunReceipt(projected, { sourceFingerprint: admission.source.workspaceFingerprint });
    assert.deepEqual((await runner.execute(reuse)).revalidation, projected.revalidation);
    assert.deepEqual(projected.source, original.source);
    assert.deepEqual(projected.execution, original.execution);
    assert.equal(executions, executed);
    assert.deepEqual(await readFile(receiptFile), originalBytes);
    assert.deepEqual(await readFile(original.logs.path), logBytes);
    const source = { inventory: await inventory(), reviewBase: 'b'.repeat(40) };
    const reject = (changedPolicy = policy, changedSource = source, changedBinding = binding) =>
      assert.throws(() => reconstructReviewedReceiptSourceProjection(changedSource, original, changedPolicy, changedBinding, admission.toolchain));
    for (const field of ['taskId', 'receiptId', 'originalReceiptSha256', 'selectorsSha256', 'originalFingerprint',
      'currentFingerprint', 'dependencyManifestFingerprint', 'originalToolchainDigest', 'currentToolchainDigest',
      'profilePolicyDigest', 'profileCatalogVersion', 'reviewBase', 'governanceBindingSha256']) {
      reject({ ...policy, [field]: field === 'reviewBase' ? '0'.repeat(40) : '0'.repeat(64) });
    }
    reject({ ...policy, profile: profile === 'governance' ? 'backend-test-class' : 'governance' });
    reject(policy, { ...source, inventory: { ...source.inventory, files: [...source.inventory.files, descriptor('unknown.txt', 'new')] } });
    reject(policy, { ...source, inventory: { ...source.inventory, files: source.inventory.files.map(f => f.relative === scoped.relative ? { ...f, sha256: '0'.repeat(64) } : f) } });
    reject(policy, source, { ...binding, governanceRoleGrantPolicy: { ...binding.governanceRoleGrantPolicy, decisions: ['changed'] } });
    for (const mutate of [p => { p.changes[0].after.sha256 = '0'.repeat(64); },
      p => { p.changes[0].before = { bytes: 1, sha256: '0'.repeat(64) }; },
      p => { p.changes[0].path = 'code-copilot'; }]) {
      const changed = structuredClone(policy); mutate(changed); reject(changed);
    }
    const invalid = { ...policy, ignoreDirectories: ['forge-server/db/migration'] };
    assert.throws(() => validateReviewedReceiptSourcePolicy(invalid));
    bindings = 0; revokeOnBind = true;
    await assert.rejects(runner.execute({ ...reuse, idempotencyKey: 'revoked-reviewed-source' }), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
    revokeOnBind = false; policies = undefined;
    await assert.rejects(runner.execute({ ...reuse, idempotencyKey: 'missing-reviewed-source' }), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
    assert.equal(executions, executed);
}

test('operator reviewed source accepts 20 exact changes while rejecting 65 changes, scoped edits and omitted changes', async t => {
  for (const profile of ['backend-test-class', 'governance']) {
    await t.test(profile, sub => reviewedSourceHostCase(sub, profile, ({ admission, original, policy, binding, source }) => {
      const extra = Array.from({ length: 62 }, (_, index) => {
        const text = `reviewed addition ${index}`;
        return { relative: `notes/reviewed-${String(index).padStart(2, '0')}.md`, bytes: Buffer.byteLength(text),
          sha256: crypto.createHash('sha256').update(text).digest('hex') };
      });
      const inventory = files => {
        const sorted = [...files].sort((a, b) => a.relative < b.relative ? -1 : 1);
        const digest = crypto.createHash('sha256');
        for (const file of sorted) digest.update(file.relative).update('\0').update(file.sha256).update('\0').update(String(file.bytes)).update('\0');
        return { ...source.inventory, files: sorted, fileCount: sorted.length,
          bytes: sorted.reduce((sum, file) => sum + file.bytes, 0), workspaceFingerprint: digest.digest('hex') };
      };
      const delta = ({ relative, bytes, sha256 }) => ({ path: relative, before: null, after: { bytes, sha256 } });
      const current = { ...source, inventory: inventory([...source.inventory.files, ...extra.slice(0, 17)]) };
      const twenty = { ...policy, currentFingerprint: current.inventory.workspaceFingerprint,
        changes: [...policy.changes, ...extra.slice(0, 17).map(delta)] };
      assert.equal(twenty.changes.length, 20);
      assert.equal(validateReviewedReceiptSourcePolicy(twenty), twenty);
      const projection = reconstructReviewedReceiptSourceProjection(current, original, twenty, binding, admission.toolchain);
      assert.equal(projection.reconstructedFingerprint, original.source.workspaceFingerprint);
      assert.equal(projection.currentFingerprint, current.inventory.workspaceFingerprint);

      const oversized = { ...twenty, changes: [...policy.changes, ...extra.map(delta)] };
      assert.equal(oversized.changes.length, 65);
      assert.throws(() => validateReviewedReceiptSourcePolicy(oversized), /reviewed source paths are unbounded/u);
      const scopedEdit = { ...current, inventory: inventory(current.inventory.files.map(file =>
        file.relative === policy.scopeFiles[0].path ? { ...file, sha256: '0'.repeat(64) } : file)) };
      assert.throws(() => reconstructReviewedReceiptSourceProjection(scopedEdit, original,
        { ...twenty, currentFingerprint: scopedEdit.inventory.workspaceFingerprint }, binding, admission.toolchain),
      /reviewed task scope bytes changed/u);
      assert.throws(() => reconstructReviewedReceiptSourceProjection(current, original,
        { ...twenty, changes: twenty.changes.slice(1) }, binding, admission.toolchain),
      /cannot reconstruct the complete original inventory/u);
    }));
  }
});

test('operator reviewed source Host preserves both original executions and rejects unreviewed differences', async t => {
  for (const profile of ['backend-test-class', 'governance']) {
    await t.test(profile, sub => reviewedSourceHostCase(sub, profile));
  }
});

test('operator reviewed source controlled parser accepts produced projections without changing original receipt identity', async t => {
  for (const profile of ['backend-test-class', 'governance']) {
    await reviewedSourceHostCase(t, profile, async ({ selectors, admission, original, projected, reuse, receiptFile, originalBytes }) => {
      const command = ['forge-verify', 'run', '--profile', profile, '--admission-id', admission.admissionId,
        '--reuse-receipt', original.receiptId, '--idempotency-key', reuse.idempotencyKey,
        ...(selectors.modules ?? []).flatMap(module => ['--module', module]),
        ...(selectors.tests ?? []).flatMap(name => ['--test', name])].join(' ');
      const parsed = controlledEvidenceReceipt(command, JSON.stringify(projected));
      assert.ok(parsed, `${profile}: B must accept the actual Host revalidation output`);
      assert.equal(parsed.receipt.receiptId, original.receiptId);
      assert.equal(hostRunReceiptDigest(parsed.receipt), hostRunReceiptDigest(original));
      assert.deepEqual(parsed.receipt.source, original.source);
      assert.deepEqual(parsed.receipt.revalidation, projected.revalidation);
      assert.deepEqual(await readFile(receiptFile), originalBytes);
    });
  }
});

const LINT_FORMAT_ARGS = [
  '--rule', 'style/quotes: off',
  '--rule', 'style/arrow-parens: off',
  '--rule', 'style/max-statements-per-line: off',
  '--rule', 'vue/singleline-html-element-content-newline: off',
  '--rule', 'vue/component-name-in-template-casing: off',
  '--rule', 'vue/html-self-closing: off',
  '--rule', 'perfectionist/sort-imports: off',
  '--rule', 'format/prettier: off',
  '--rule', 'unocss/order-attributify: off',
  '--rule', 'antfu/if-newline: off',
  '--rule', 'antfu/consistent-list-newline: off',
  '--rule', 'antfu/curly: off',
];

function provenancePolicy(contractId, repository = 'forge-host') {
  return normalizeReferenceProvenancePolicy({ schemaVersion: 1, contractId, repository,
    baseCommit: 'b'.repeat(40), head: 'b'.repeat(40), sourceManifestSha256: 'a'.repeat(64),
    reviewEvidenceSha256: 'b'.repeat(64), sources: [], prohibitedPaths: [], prohibitedIdentifiers: [],
    files: [{ path: 'notes/change.md', oldPath: null, status: 'U', sha256: 'c'.repeat(64),
      origin: 'original-change', sourceIds: [], reviewEvidenceSha256: 'd'.repeat(64), dependencyReviewSha256: null }] });
}

test('protected source provenance Host plan preserves role and scope bindings without inheriting a different source review', () => {
  const policy = provenancePolicy('a'.repeat(64));
  const scope = { contractId: policy.contractId, ownedPaths: ['notes/change.md'] };
  const role = { contractId: policy.contractId, decisions: [] };
  const argv = hostVerificationCommand('governance', {}, policy.head, { snapshotRoot: '/snapshot' },
    { forgeGovernance: '/tools/forge-governance' }, policy.baseCommit, undefined, undefined, scope, role, policy).steps[0].argv;
  assert.deepEqual(JSON.parse(argv.at(-1)), policy);
  assert.deepEqual(revalidatedGovernanceTaskArguments(argv, scope, role, policy), argv);
  assert.equal(revalidatedGovernanceTaskArguments(argv, scope, role), null);
  assert.equal(revalidatedGovernanceTaskArguments(argv.slice(0, -2), scope, role, policy), null);
  assert.equal(revalidatedGovernanceTaskArguments(argv, scope, role, { ...policy, reviewEvidenceSha256: 'f'.repeat(64) }), null);
  const next = 'e'.repeat(64);
  assert.equal(revalidatedGovernanceTaskArguments(argv, { ...scope, contractId: next }, { ...role, contractId: next }, { ...policy, contractId: next }), null);
  const wrongScope = [...argv]; wrongScope[wrongScope.indexOf('--task-contract-id') + 1] = next;
  assert.equal(revalidatedGovernanceTaskArguments(wrongScope, scope, role, policy), null);
  for (const changed of [{ ...policy, head: '0'.repeat(40) }, { ...policy, baseCommit: '0'.repeat(40) }, { ...policy, contractId: next }]) {
    assert.throws(() => hostVerificationCommand('governance', {}, policy.head, { snapshotRoot: '/snapshot' },
      { forgeGovernance: '/tools/forge-governance' }, policy.baseCommit, undefined, undefined, scope, role, changed), /must bind/);
  }
});

test('Host source provenance consumes protected binding for execution and idempotency and rejects stale receipt reuse', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-provenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  const commands = [];
  let policy = provenancePolicy('d'.repeat(64));
  const runner = new HostVerificationRunner({ projectSlug: 'forge-host', contract: currentContract,
    inventory: state.inventory, snapshot, toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async (_executable, argv) => { commands.push([...argv]); return result(); },
    acceptanceIssuerClient: async (route, body) => {
      if (route !== '/v1/candidate-bindings') return { accepted: true };
      const source = await state.inventory();
      return { acceptanceContract: { contractId: body.contractId, projectSlug: 'forge-host', taskId: 'task-one',
        candidate: { source: { head: source.head, fingerprint: source.workspaceFingerprint } } },
      governanceTaskScope: { contractId: body.contractId, ownedPaths: ['notes/change.md'] },
      governanceRoleGrantPolicy: { contractId: body.contractId, decisions: [] },
      governanceSourceProvenancePolicy: policy };
    } });
  const admission = await runner.admit('task-one', ['governance']);
  const request = { taskId: 'task-one', action: 'run', profile: 'governance', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'source-review-same-key',
    acceptanceContractId: policy.contractId, candidateBinding: {} };
  const first = await runner.execute(request);
  assert.equal(first.status, 'passed');
  assert.deepEqual(JSON.parse(first.execution.steps[0].argv.at(-1)), policy);
  assert.equal((await runner.execute(request)).receiptId, first.receiptId);
  assert.equal(commands.length, 1);
  policy = { ...policy, reviewEvidenceSha256: 'f'.repeat(64) };
  await assert.rejects(runner.execute({ ...request, receiptId: first.receiptId,
    idempotencyKey: 'stale-source-review' }), error => error.code === 'VERIFY_RECEIPT_REUSE_INVALID');
  const second = await runner.execute(request);
  assert.notEqual(second.receiptId, first.receiptId);
  assert.equal(commands.length, 2);
  policy = { ...policy, repository: 'another-project' };
  await assert.rejects(runner.execute(request), error => error.code === 'VERIFY_ACCEPTANCE_BINDING_INVALID');
  assert.equal(commands.length, 2, 'An invalid protected binding must not execute.');
});

test('protected role policy remains mandatory for workspace, checkpoint and release Host plans', () => {
  for (const actionCeiling of ['workspace-write', 'git-checkpoint', 'release']) {
    const contract = { contractId: 'a'.repeat(64), actionCeiling, ownedPaths: ['forge-server/db'], roleGrantDecisions: [] };
    const scope = governanceTaskScopeForContract(contract);
    const policy = governanceRoleGrantPolicyForContract(contract);
    const argv = hostVerificationCommand('governance', {}, '1'.repeat(40), { snapshotRoot: '/snapshot' },
      { forgeGovernance: '/tools/forge-governance' }, '2'.repeat(40), undefined, undefined, scope, policy).steps[0].argv;
    assert.deepEqual(JSON.parse(argv.at(-1)), policy);
    assert.equal(argv.at(-2), '--role-grant-policy');
    assert.equal(argv.includes('--task-owned-path'), actionCeiling === 'workspace-write');
    const renewed = { ...contract, contractId: 'b'.repeat(64) };
    const compared = revalidatedGovernanceTaskArguments(argv, governanceTaskScopeForContract(renewed), governanceRoleGrantPolicyForContract(renewed));
    assert.equal(JSON.parse(compared.at(-1)).contractId, renewed.contractId);
    assert.equal(JSON.parse(argv.at(-1)).contractId, contract.contractId, 'Original execution facts remain immutable.');
    assert.equal(revalidatedGovernanceTaskArguments(argv.slice(0, -2), scope, policy), null);
    const changed = { ...policy, decisions: [{ path: 'forge-server/db/roles.sql', roleKeys: ['admin'],
      statementSha256: 'c'.repeat(64), fileSha256: 'd'.repeat(64) }] };
    assert.equal(revalidatedGovernanceTaskArguments(argv, scope, changed), null);
  }
});

test('Host governance uses protected role decisions for execution, idempotency and receipt reuse', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-role-governance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  const commands = [];
  let decisions = [];
  const runner = new HostVerificationRunner({ projectSlug: 'forge-host', contract: currentContract,
    inventory: state.inventory, snapshot, toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async (_executable, argv) => { commands.push([...argv]); return result(); },
    acceptanceIssuerClient: async (route, body) => {
      if (route !== '/v1/candidate-bindings') return { accepted: true };
      const source = await state.inventory();
      return { acceptanceContract: { contractId: body.contractId, projectSlug: 'forge-host', taskId: 'task-one',
        candidate: { source: { head: source.head, fingerprint: source.workspaceFingerprint } } },
      governanceRoleGrantPolicy: { contractId: body.contractId, decisions } };
    } });
  const admission = await runner.admit('task-one', ['governance']);
  const request = { taskId: 'task-one', action: 'run', profile: 'governance', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'role-governance-same-key',
    acceptanceContractId: 'd'.repeat(64), candidateBinding: {} };
  const first = await runner.execute(request);
  assert.equal(first.status, 'passed');
  assert.deepEqual(JSON.parse(first.execution.steps[0].argv.at(-1)).decisions, []);
  const reused = await runner.execute({ ...request, acceptanceContractId: 'e'.repeat(64), receiptId: first.receiptId,
    idempotencyKey: 'role-governance-renewed' });
  assert.equal(reused.revalidation.contractId, 'e'.repeat(64));
  assert.equal(commands.length, 1);
  decisions = [{ path: 'forge-server/db/roles.sql', roleKeys: ['admin'], statementSha256: 'a'.repeat(64), fileSha256: 'b'.repeat(64) }];
  await assert.rejects(runner.execute({ ...request, receiptId: first.receiptId,
    idempotencyKey: 'role-governance-no-stale-reuse' }), error => error.code === 'VERIFY_RECEIPT_REUSE_INVALID');
  const second = await runner.execute(request);
  assert.notEqual(first.receiptId, second.receiptId);
  assert.equal(commands.length, 2);
  assert.deepEqual(JSON.parse(second.execution.steps[0].argv.at(-1)).decisions, decisions);
});

test('Host governance uses protected task scope for execution, idempotency and receipt reuse', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-task-governance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  const commands = [];
  let ownedPaths = ['forge-server/current/Current.java'];
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async (_executable, argv) => { commands.push([...argv]); return result(); },
    acceptanceIssuerClient: async (route, body) => {
      if (route !== '/v1/candidate-bindings') return { accepted: true };
      const source = await state.inventory();
      return { acceptanceContract: { contractId: body.contractId, projectSlug: 'forge-host', taskId: 'task-one',
        candidate: { source: { head: source.head, fingerprint: source.workspaceFingerprint } } },
      governanceTaskScope: { contractId: body.contractId, ownedPaths } };
    },
  });
  const admission = await runner.admit('task-one', ['governance']);
  const request = { taskId: 'task-one', action: 'run', profile: 'governance', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'task-governance-same-key',
    acceptanceContractId: 'd'.repeat(64), candidateBinding: {} };
  const first = await runner.execute(request);
  assert.equal(first.status, 'passed');
  assert.deepEqual(first.execution.steps[0].argv.slice(-4), ['--task-contract-id', 'd'.repeat(64),
    '--task-owned-path', ownedPaths[0]]);
  const receiptFile = path.join(runner.stateRoot, 'receipts', 'task-one', `${first.receiptId}.json`);
  const originalBytes = await readFile(receiptFile);
  const reused = await runner.execute({ ...request, receiptId: first.receiptId,
    acceptanceContractId: 'e'.repeat(64), idempotencyKey: 'task-governance-renewed-contract' });
  assert.equal(reused.revalidation.contractId, 'e'.repeat(64));
  assert.deepEqual(reused.execution, first.execution, 'revalidation retains the original contract ID in execution facts');
  assert.deepEqual(await readFile(receiptFile), originalBytes);
  assert.equal(commands.length, 1, 'a renewed contract alone must not rerun the same scoped audit');
  ownedPaths = [...ownedPaths, 'forge-server/next/Next.java'];
  await assert.rejects(runner.execute({ ...request, receiptId: first.receiptId,
    idempotencyKey: 'task-governance-refuse-narrow-reuse' }), error => error.code === 'VERIFY_RECEIPT_REUSE_INVALID');
  assert.equal(commands.length, 1, 'scope mismatch must not rerun the old check');
  const second = await runner.execute(request);
  assert.notEqual(second.receiptId, first.receiptId, 'changed protected scope cannot hit the old idempotency entry');
  assert.equal(second.execution.steps[0].argv.filter(arg => arg === '--task-owned-path').length, 2);
  ownedPaths = ['../escape'];
  await assert.rejects(runner.execute({ ...request, idempotencyKey: 'task-governance-invalid-scope' }), /scope is invalid/u);
  assert.equal(commands.length, 2);
});

test('Host run restores dependency seeds before commands and preserves isolated TaskSpace caches', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-seed-run-'));
  const seedRoot = path.join(root, 'protected-seed');
  const modeTree = async (directory, readOnly) => {
    const metadata = await lstat(directory).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!metadata) return;
    if (!readOnly) await chmod(directory, metadata.isDirectory() ? 0o700 : 0o600);
    if (metadata.isDirectory()) for (const name of await readdir(directory)) await modeTree(path.join(directory, name), readOnly);
    if (readOnly) await chmod(directory, metadata.isDirectory() ? 0o555 : 0o444);
  };
  t.after(async () => { await modeTree(seedRoot, false); await rm(root, { recursive: true, force: true }); });
  const state = inventoryState();
  const inputs = [
    ['forge-server/pom.xml', '<project/>'],
    ['forge-admin-ui/pnpm-lock.yaml', 'lockfileVersion: 9.0\n'],
    ['forge-h5-ui/pnpm-lock.yaml', 'lockfileVersion: 9.0\n'],
  ];
  for (const taskId of ['task-one', 'task-two']) {
    const workspace = await fixture(root, taskId);
    for (const [relative, contents] of inputs) {
      await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
      await writeFile(path.join(workspace, relative), contents);
    }
  }
  const inventory = async () => ({ ...await state.inventory(), files: inputs.map(([relative, contents]) => ({
    relative, sha256: crypto.createHash('sha256').update(contents).digest('hex'), bytes: Buffer.byteLength(contents),
  })) });
  const initialContract = contract(root);
  const tools = toolchainIdentity(initialContract);
  for (const [name, version] of Object.entries({ java: 'openjdk version "17.0.16" 2025-07-15',
    maven: 'Apache Maven 3.8.7', node: process.version, pnpm: '11.7.0' })) tools.executables[name].version = version;
  tools.digest = crypto.createHash('sha256').update(JSON.stringify({ javaHome: tools.javaHome, executables: tools.executables })).digest('hex');
  const mavenRelative = path.join('m2', 'repository', 'example', 'sample.jar');
  const pnpmRelative = path.join('pnpm', 'store', 'v10', 'files', 'sample');
  for (const [relative, bytes] of [[mavenRelative, 'seed Maven'], [pnpmRelative, 'seed pnpm']]) {
    await mkdir(path.dirname(path.join(seedRoot, relative)), { recursive: true });
    await writeFile(path.join(seedRoot, relative), bytes);
  }
  const manifest = await createDependencySeedManifest({
    root: seedRoot, projectSlug: 'forge-host', sourceHead: 'b'.repeat(40), inventory: await inventory(), toolchain: tools,
    mavenSettingsSha256: crypto.createHash('sha256').update(await readFile(
      new URL('../docker/harness/maven-verification-settings.xml', import.meta.url))).digest('hex'),
  });
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  await writeFile(path.join(seedRoot, 'manifest.json'), manifestBytes);
  await modeTree(seedRoot, true);
  const currentContract = validateHostVerificationContract({ ...initialContract, dependencySeed: {
    root: seedRoot, manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
  } });
  const cacheFor = (taskId) => path.join(currentContract.stateRoot, 'taskspaces', taskId, 'cache');
  const commands = [];
  let expectedTask = 'task-one';
  let expectedMaven = 'seed Maven';
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory, snapshot,
    toolchainProbe: async () => tools,
    command: async (executable, argv, options) => {
      const cache = cacheFor(expectedTask);
      assert.equal(executable, tools.executables.maven.resolvedPath);
      assert.ok(argv.includes(`-Dmaven.repo.local=${path.join(cache, 'm2', 'repository')}`));
      assert.ok(argv.includes('test-compile'), 'restoring dependencies must still execute the requested compile profile');
      assert.equal(path.basename(options.cwd), 'forge-server');
      assert.equal(await readFile(path.join(cache, mavenRelative), 'utf8'), expectedMaven);
      await assert.rejects(access(path.join(cache, 'pnpm')), { code: 'ENOENT' }, 'backend verification must not copy the frontend store');
      commands.push({ taskId: expectedTask, argv });
      return result({ exitCode: commands.length === 1 ? 9 : 0, stderr: commands.length === 1 ? 'compile failed after seed restoration' : '' });
    },
  });
  const seedOutcomes = [];
  const prepareJob = runner.prepareJob.bind(runner);
  runner.prepareJob = async (...args) => {
    assert.equal(args[4].seedDependencies, true, 'run must enable the real default restoration path');
    const prepared = await prepareJob(...args);
    seedOutcomes.push(prepared.dependencySeed);
    return prepared;
  };
  const run = async (taskId, id) => {
    const admission = await runner.admit(taskId, ['backend-module-compile']);
    return runner.run(taskId, { action: 'run', profile: 'backend-module-compile',
      selectors: { modules: ['forge-server/forge-business/forge-business-core'] },
      admissionId: admission.admissionId, idempotencyKey: id });
  };
  const failed = await run('task-one', 'seed-run-first');
  assert.equal(failed.status, 'failed', 'a valid seed must not turn a failing command into acceptance');
  assert.deepEqual(seedOutcomes[0].restored, ['m2']);
  expectedMaven = 'task-one Maven change';
  await writeFile(path.join(cacheFor('task-one'), mavenRelative), expectedMaven);
  assert.equal((await run('task-one', 'seed-run-second')).status, 'passed');
  assert.deepEqual(seedOutcomes[1].restored, []);
  assert.deepEqual(seedOutcomes[1].preserved, ['m2']);
  assert.equal(seedOutcomes[1].payloadVerified, false);
  expectedTask = 'task-two'; expectedMaven = 'seed Maven';
  assert.equal((await run('task-two', 'seed-run-other-task')).status, 'passed');
  assert.deepEqual(seedOutcomes[2].restored, ['m2']);
  assert.deepEqual(commands.map((entry) => entry.taskId), ['task-one', 'task-one', 'task-two']);
  assert.equal(await readFile(path.join(cacheFor('task-one'), mavenRelative), 'utf8'), 'task-one Maven change');
  assert.equal(await readFile(path.join(seedRoot, mavenRelative), 'utf8'), 'seed Maven');
  assert.equal(await readFile(path.join(seedRoot, pnpmRelative), 'utf8'), 'seed pnpm');
});

test('Host Maven partial cache stays offline through admission, execution and receipt reuse; missing artifacts request preparation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-partial-seed-'));
  const seedRoot = path.join(root, 'protected-seed');
  const modeTree = async (directory, readOnly) => {
    const info = await lstat(directory).catch(() => null);
    if (!info) return;
    if (!readOnly) await chmod(directory, info.isDirectory() ? 0o700 : 0o600);
    if (info.isDirectory()) for (const name of await readdir(directory)) await modeTree(path.join(directory, name), readOnly);
    if (readOnly) await chmod(directory, info.isDirectory() ? 0o555 : 0o444);
  };
  t.after(async () => { await modeTree(seedRoot, false); await rm(root, { recursive: true, force: true }); });
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const tools = toolchainIdentity(currentContract);
  for (const [name, version] of Object.entries({ java: 'openjdk version "17.0.16"',
    maven: 'Apache Maven 3.8.7', node: process.version, pnpm: '11.7.0' })) tools.executables[name].version = version;
  const originalInventory = { ...await inventoryState().inventory(), files: [
    { relative: 'forge-server/pom.xml', sha256: '1'.repeat(64) },
    { relative: 'forge-admin-ui/package.json', sha256: '2'.repeat(64) },
  ] };
  const currentInventory = structuredClone(originalInventory);
  currentInventory.files[0].sha256 = '3'.repeat(64);
  currentInventory.files[1].sha256 = '4'.repeat(64);
  for (const [file, bytes] of [['m2/repository/example/retained.jar', 'verified existing dependency'], ['pnpm/store/package', 'pnpm']]) {
    await mkdir(path.dirname(path.join(seedRoot, file)), { recursive: true });
    await writeFile(path.join(seedRoot, file), bytes);
  }
  const manifest = await createDependencySeedManifest({ root: seedRoot, projectSlug: 'forge-host', sourceHead: originalInventory.head,
    inventory: originalInventory, toolchain: tools, mavenSettingsSha256: crypto.createHash('sha256').update(await readFile(
      new URL('../docker/harness/maven-verification-settings.xml', import.meta.url))).digest('hex') });
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  await writeFile(path.join(seedRoot, 'manifest.json'), manifestBytes);
  await modeTree(seedRoot, true);
  currentContract.dependencySeed = { root: seedRoot, manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex') };
  const authority = { acceptanceContractId: 'd'.repeat(64), candidateBinding: {} };
  let missing = false, calls = 0;
  const runner = new HostVerificationRunner({ projectSlug: 'forge-host', contract: currentContract,
    inventory: async () => currentInventory, snapshot, toolchainProbe: async () => tools,
    command: async (_executable, argv) => {
      calls += 1;
      assert.equal(argv[0], '--offline');
      assert.equal(await readFile(path.join(seedRoot, 'm2/repository/example/retained.jar'), 'utf8'), 'verified existing dependency');
      return result(missing ? { exitCode: 1,
        stderr: 'Cannot access forge-central-public (https://repo.maven.apache.org/maven2) in offline mode and the artifact example:missing:jar:1 has not been downloaded from it before.' } : {});
    },
    acceptanceIssuerClient: async (route, body) => {
      if (route === '/v1/candidate-bindings') return { acceptanceContract: { contractId: body.contractId,
        projectSlug: 'forge-host', taskId: 'task-one', candidate: { source: {
          head: currentInventory.head, fingerprint: currentInventory.workspaceFingerprint } } } };
      validateHostRunReceipt(body.runnerReceipt, { projectSlug: 'forge-host', taskId: 'task-one', allowRevalidation: true });
      return { accepted: true };
    },
  });
  // Use the real resolver and prepare path on every OS; process execution is a
  // stub here. The Linux sandbox mount is asserted separately below.
  const prepareJob = runner.prepareJob.bind(runner);
  const preparations = [];
  runner.prepareJob = async (...args) => {
    const previous = runner.contract;
    runner.contract = { ...previous, processIsolation: 'bubblewrap' };
    try {
      const job = await prepareJob(...args);
      preparations.push(job);
      assert.equal(job.dependencySeed.status, 'partial');
      assert.equal(job.dependencySeed.inputsChanged, true);
      assert.equal(job.dependencySeed.copiedFiles, 0);
      assert.equal(job.dependencySeed.installed, false);
      await assert.rejects(access(path.join(job.paths.cacheRoot, 'm2/repository')), { code: 'ENOENT' });
      return job;
    } finally { runner.contract = previous; }
  };
  const admission = await runner.admit('task-one', ['backend-module-compile']);
  const request = { action: 'run', profile: 'backend-module-compile',
    selectors: { modules: ['forge-server/example'] }, admissionId: admission.admissionId, idempotencyKey: 'partial-existing' };
  const passed = await runner.run('task-one', request, authority);
  assert.equal(passed.status, 'passed');
  validateHostRunReceipt(passed, { projectSlug: 'forge-host', taskId: 'task-one' });
  const log = await readFile(passed.logs.path, 'utf8');
  assert.match(log, /"status":"partial"/u);
  assert.match(log, /"inputsChanged":true/u);
  const reused = await runner.run('task-one', { ...request, receiptId: passed.receiptId, idempotencyKey: 'partial-reuse' }, authority);
  assert.equal(reused.receiptId, passed.receiptId);
  assert.equal(calls, 1, 'acceptance of the offline execution must not rerun it');
  missing = true;
  await assert.rejects(runner.run('task-one', { ...request, idempotencyKey: 'partial-missing' }, authority), (error) => {
    assert.equal(error.code, 'VERIFY_DEPENDENCY_PREPARATION_REQUIRED');
    assert.match(error.message, /prepare only the missing dependencies/u);
    assert.ok(error.backgroundDiagnostic.logs.sha256);
    return true;
  });
  assert.equal(calls, 2, 'a cache miss must never retry online');
  const logNames = await readdir(path.join(currentContract.stateRoot, 'taskspaces/task-one/logs'));
  const missingLog = await readFile(path.join(currentContract.stateRoot, 'taskspaces/task-one/logs', logNames.find(name => name !== `${passed.receiptId}.log`)), 'utf8');
  assert.match(missingLog, /example:missing:jar:1/u);
  assert.match(missingLog, /"status":"partial"/u);
  assert.deepEqual(await readFile(path.join(seedRoot, 'manifest.json')), Buffer.from(manifestBytes));
  tools.executables.maven.version = 'Apache Maven 3.9.9';
  await assert.rejects(runner.run('task-one', { ...request, idempotencyKey: 'partial-wrong-tools' }, authority),
    error => error.code === 'VERIFY_DEPENDENCY_PREPARATION_REQUIRED');
  assert.equal(calls, 2, 'incompatible toolchains must not use the old seed or start downloads');
  const linuxPaths = { jobRoot: '/srv/state/taskspaces/task-one/jobs/job-one', cacheRoot: '/srv/state/taskspaces/task-one/cache' };
  const seedPath = '/srv/protected-seed';
  const mounted = hostSandboxCommand({ executable: '/usr/bin/mvn', cwd: `${linuxPaths.jobRoot}/workspace/forge-server`, argv: ['--offline'] },
    linuxPaths, { node: '/usr/bin/node', maven: '/usr/bin/mvn' }, [{ ...preparations[0].readOnlyDependencies[0], root: `${seedPath}/m2/repository` }],
    { dependencySeed: { root: seedPath } });
  const offset = mounted.argv.indexOf(`${seedPath}/m2/repository`);
  assert.deepEqual(mounted.argv.slice(offset - 1, offset + 2), ['--ro-bind', `${seedPath}/m2/repository`, `${linuxPaths.cacheRoot}/m2/repository`]);
});

test('Host sandbox exposes only the current job, task cache and fixed runtime inputs', () => {
  const jobRoot = '/srv/forge-delivery/projects/test/verification/host-state/taskspaces/task-one/jobs/job-one';
  const paths = { jobRoot, cacheRoot: path.posix.resolve(jobRoot, '../../cache') };
  const nodeRoot = '/srv/forge-delivery/canary/test/toolchains/versions/node-v22.23.2-linux-x64';
  const tools = { node: `${nodeRoot}/bin/node`, java: '/usr/lib/jvm/java-17/bin/java', git: '/usr/bin/git' };
  const step = { executable: tools.node, argv: ['run', 'test'], cwd: `${jobRoot}/workspace/forge-admin-ui` };
  const plan = hostSandboxCommand(step, paths, tools);
  assert.equal(plan.executable, '/usr/bin/bwrap');
  assert.deepEqual(hostSandboxReadOnlyRoots(tools), [nodeRoot]);
  const writable = plan.argv.flatMap((value, i, argv) => value === '--bind' ? [[argv[i + 1], argv[i + 2]]] : []);
  assert.deepEqual(writable, [[jobRoot, jobRoot], [paths.cacheRoot, paths.cacheRoot]]);
  assert.ok(plan.argv.includes('--unshare-pid'));
  assert.ok(plan.argv.includes('--disable-userns'));
  assert.ok(plan.argv.includes('--assert-userns-disabled'));
  assert.equal(plan.argv.filter((value) => value === '/proc').length, 1, 'proc is private, never a host bind');
  assert.equal(plan.argv.includes('/etc'), false);
  assert.equal(plan.argv.includes('/etc/maven'), false, 'host Maven credentials are not exposed');
  assert.deepEqual(plan.argv.slice(-4), ['--', tools.node, 'run', 'test']);
  assert.throws(() => hostSandboxCommand(step, { ...paths, cacheRoot: '/srv/forge-delivery/secrets' }, tools), /scope/u);
  assert.throws(() => hostSandboxCommand({ ...step, cwd: `${jobRoot}/workspace-other` }, paths, tools), /scope/u);
  assert.throws(() => hostSandboxReadOnlyRoots({ node: '/srv/forge-delivery/secrets/bin/node' }), /versioned/u);
  const legacy = validateHostVerificationContract(contract(path.resolve('sandbox-contract')));
  const isolated = validateHostVerificationContract({ ...legacy, processIsolation: 'bubblewrap' });
  assert.notEqual(hostProfilePolicyDigest(legacy), hostProfilePolicyDigest(isolated));
  assert.throws(() => validateHostVerificationContract({ ...legacy, processIsolation: 'fallback' }), /bubblewrap/u);
});

test('Host refuses a child-replaced report root or a cache ancestor symlink before reading reports', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-output-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(['jobRoot', 'snapshotRoot', 'outputRoot', 'cacheRoot'].map((key) => [key, path.join(root, key)]));
  for (const directory of Object.values(paths)) await mkdir(directory);
  await assertHostJobDirectories(paths);
  await rm(paths.outputRoot, { recursive: true });
  await symlink(paths.cacheRoot, paths.outputRoot, 'junction');
  await assert.rejects(assertHostJobDirectories(paths), (error) => error.code === 'VERIFY_HOST_PATH_INVALID');
  await rm(paths.outputRoot, { recursive: true });
  await mkdir(paths.outputRoot);
  await symlink(root, path.join(root, 'linked'), 'junction');
  await assert.rejects(assertHostJobDirectories({ ...paths, cacheRoot: path.join(root, 'linked', 'cacheRoot') }),
    (error) => error.code === 'VERIFY_HOST_PATH_INVALID');
});

test('Host dependency seed binding is optional and cannot point into writable taskspaces', () => {
  const legacy = contract(path.resolve('seed-contract'));
  assert.equal(validateHostVerificationContract({ ...legacy, dependencySeed: null }).dependencySeed, undefined);
  const dependencySeed = { root: path.resolve('protected-dependency-seeds', 'seed-one'), manifestSha256: 'a'.repeat(64) };
  assert.deepEqual(validateHostVerificationContract({ ...legacy, dependencySeed }).dependencySeed, dependencySeed);
  assert.throws(() => validateHostVerificationContract({ ...legacy, dependencySeed: { ...dependencySeed, manifestSha256: 'bad' } }), /digest/u);
  for (const root of [legacy.taskspacesRoot, path.join(legacy.taskspacesRoot, 'task-one'), path.join(legacy.stateRoot, 'taskspaces', 'task-one', 'cache')]) {
    assert.throws(() => validateHostVerificationContract({ ...legacy, dependencySeed: { ...dependencySeed, root } }), /outside writable/u);
  }
});

test('Host binds the admitted candidate before executing and preserves canonical receipt shape', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-candidate-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  const routes = [];
  let commands = 0;
  let bindingIssuedAt;
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async () => { assert.ok(bindingIssuedAt); commands += 1; return result(); },
    acceptanceIssuerClient: async (route, body) => {
      routes.push({ route, body });
      if (route === '/v1/candidate-bindings') {
        bindingIssuedAt ??= new Date().toISOString();
        return { acceptanceContract: {
          contractId: 'd'.repeat(64), projectSlug: 'forge-host', taskId: 'task-one',
          candidate: { source: { head: 'b'.repeat(40), fingerprint: 'e'.repeat(64) } },
          issuedAt: bindingIssuedAt,
        } };
      }
      assert.ok(Date.parse(body.runnerReceipt.execution.startedAt) >= Date.parse(bindingIssuedAt));
      return { accepted: true };
    },
  });
  state.setFingerprint('e'.repeat(64));
  const admission = await runner.admit('task-one', ['frontend-admin-build']);
  const request = {
    taskId: 'task-one', acceptanceContractId: 'd'.repeat(64),
    candidateBinding: { contractId: 'd'.repeat(64), rpcId: 'rpc:writer:1' },
    action: 'run', profile: 'frontend-admin-build', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'candidate-binding-build',
  };
  const receipt = await runner.execute(request);
  assert.equal(receipt.status, 'passed');
  assert.equal(commands, 2);
  assert.deepEqual(routes.map((r) => r.route), ['/v1/candidate-bindings', '/v1/verification']);
  assert.deepEqual(routes[0].body.admissionReceipt, admission);
  assert.deepEqual(routes[0].body.candidateBinding, request.candidateBinding);
  assert.equal(Object.hasOwn(receipt, 'candidateBinding'), false);
  assert.equal(Object.hasOwn(receipt.request, 'candidateBinding'), false);
  assert.equal(validateHostRunReceipt(receipt), receipt);
  const repeated = await runner.execute(request);
  assert.equal(repeated.receiptId, receipt.receiptId);
  assert.equal(commands, 2, 'idempotent execution does not rerun the job');
});

test('Host receipt reader exposes confirmed frontend revalidation to phase collection without rewriting historical execution', async (t) => {
  const { collectForgePhaseHostReceipts } = await import('../docker/harness/forge-delivery-phase-host-receipts.mjs');
  for (const profile of ['frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-build']) {
    await t.test(profile, async (sub) => {
      const f = await hostReceiptReuseFixture(sub, profile, {}, 'forge-admin-ui');
      const originalLog = await readFile(f.original.logs.path);
      const changed = structuredClone(f.original.toolchain);
      Object.assign(changed.executables.forgeGovernance, {
        configuredPath: `${changed.executables.forgeGovernance.configuredPath}-next`,
        resolvedPath: `${changed.executables.forgeGovernance.resolvedPath}-next`, modifiedMs: 2,
      });
      const bindDigest = value => {
        const { digest: _digest, ...descriptor } = value;
        value.digest = crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex');
        return value;
      };
      let toolchain = bindDigest(changed);
      f.runner.toolchainProbe = async () => toolchain;
      const readReceipt = () => f.runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: f.original.receiptId });
      assert.equal((await readReceipt()).freshness, 'stale');
      const admission = await f.runner.admit('task-one', [profile]);
      const request = { ...f.request, admissionId: admission.admissionId };
      const before = f.commands();
      f.runner.prepareJob = async () => assert.fail('explicit receipt reuse must not rerun checks');
      const issuer = f.runner.acceptanceIssuerClient;
      f.runner.acceptanceIssuerClient = async (route, ...args) => {
        if (route === '/v1/verification') throw new Error('submission unconfirmed');
        return issuer(route, ...args);
      };
      await assert.rejects(f.runner.execute(request), /submission unconfirmed/u);
      assert.equal((await readReceipt()).freshness, 'stale', 'unconfirmed submission is not current proof');
      f.runner.acceptanceIssuerClient = issuer;
      const projection = await f.runner.execute(request);
      const routesBeforeRead = f.routes.length;
      const observed = await readReceipt();
      assert.equal(observed.freshness, 'current');
      assert.deepEqual(observed.revalidation, projection.revalidation);
      assert.deepEqual(observed.execution, f.original.execution);
      const collected = await collectForgePhaseHostReceipts({
        projectSlug: 'forge-host', taskId: 'task-one', phaseId: 'frontend',
        sourceFingerprint: f.original.source.workspaceFingerprint, sourceCommit: f.original.source.head,
        patchDigest: 'e'.repeat(64), profiles: [profile],
        proposal: { evidence: [{ profile, receiptId: f.original.receiptId }] },
        phaseChangedPaths: ['forge-admin-ui/src/example.ts'], receiptReader: readReceipt,
      });
      assert.equal(collected.status, 'verified');
      assert.deepEqual(collected.failures, []);
      assert.equal(f.routes.length, routesBeforeRead, 'reading never resubmits acceptance');
      assert.equal(f.commands(), before);
      assert.deepEqual(await readFile(f.receiptFile), f.originalBytes);
      assert.deepEqual(await readFile(f.original.logs.path), originalLog);
      f.state.setFingerprint('e'.repeat(64));
      assert.equal((await readReceipt()).freshness, 'stale');
      const sourceAdmission = await f.runner.admit('task-one', [profile]);
      await assert.rejects(f.runner.execute({ ...request, admissionId: sourceAdmission.admissionId,
        idempotencyKey: 'changed-source' }), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
      f.state.setFingerprint(f.original.source.workspaceFingerprint);
      toolchain = structuredClone(toolchain);
      toolchain.executables.node.modifiedMs += 1;
      bindDigest(toolchain);
      assert.equal((await readReceipt()).freshness, 'stale');
      const toolAdmission = await f.runner.admit('task-one', [profile]);
      await assert.rejects(f.runner.execute({ ...request, admissionId: toolAdmission.admissionId,
        idempotencyKey: 'changed-used-tool' }), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
      await writeFile(f.receiptFile, JSON.stringify({ ...f.original, status: 'failed' }));
      const failed = await readReceipt();
      assert.equal(failed.status, 'failed');
      assert.equal(failed.freshness, 'stale');
      assert.equal(Object.hasOwn(failed, 'revalidation'), false);
    });
  }
});

test('Host explicitly revalidates a canonical passed receipt under current authority without executing again', async (t) => {
  const context = await hostReceiptReuseFixture(t);
  const { runner, original, originalBytes, receiptFile, request, admission, routes } = context;
  const commandsBefore = context.commands();
  runner.prepareJob = async () => assert.fail('revalidation must not prepare a job');
  const projection = await runner.execute(request);
  assert.equal(context.commands(), commandsBefore);
  assert.equal(projection.receiptId, original.receiptId);
  assert.deepEqual(projection.execution, original.execution);
  assert.deepEqual(projection.request, original.request);
  assert.deepEqual(projection.truth, original.truth);
  assert.notEqual(original.request.admissionId, admission.admissionId);
  assert.deepEqual(projection.revalidation.admissionReceipt, admission);
  assert.equal(projection.revalidation.contractId, request.acceptanceContractId);
  assert.equal(projection.revalidation.receiptType, 'forge-verify/host-revalidation');
  assert.match(projection.revalidation.originalReceiptSha256, /^[0-9a-f]{64}$/u);
  validateHostRunReceipt(projection, { reuseReceiptId: original.receiptId, admissionId: admission.admissionId });
  assert.deepEqual(await readFile(receiptFile), originalBytes);
  assert.equal(routes.at(-1).body.contractId, request.acceptanceContractId);
  assert.deepEqual(routes.at(-1).body.runnerReceipt, projection);

  const submissionsBeforeRepeat = routes.filter((entry) => entry.route === '/v1/verification').length;
  const repeated = await runner.execute(request);
  assert.deepEqual(repeated, projection, 'same admitted request returns its original revalidation projection');
  assert.equal(routes.filter((entry) => entry.route === '/v1/verification').length, submissionsBeforeRepeat,
    'a confirmed submission is not signed again on idempotent retry');
  assert.equal(context.commands(), commandsBefore);
  const callsBeforeRead = routes.length;
  const historical = await runner.receipt('task-one', original.receiptId);
  assert.equal(Object.hasOwn(historical, 'revalidation'), false);
  assert.equal(routes.length, callsBeforeRead, 'read-only receipt does not reissue acceptance');
  assert.deepEqual(await readFile(receiptFile), originalBytes);

  const anotherContract = await runner.execute({ ...request, acceptanceContractId: '9'.repeat(64),
    candidateBinding: { ...request.candidateBinding, contractId: '9'.repeat(64) } });
  assert.equal(anotherContract.revalidation.contractId, '9'.repeat(64), 'revalidation cache binds the current contract');
  assert.equal(context.commands(), commandsBefore);
  assert.deepEqual(await readFile(receiptFile), originalBytes);
});

test('Host revalidates only an issuer-bound same-content checkpoint without rewriting original evidence', async (t) => {
  for (const scenario of ['checkpoint', 'missing', 'integrated', 'changed-content', 'wrong-from', 'wrong-task']) {
    await t.test(scenario, async (subtest) => {
      const f = await hostReceiptReuseFixture(subtest);
      const nextHead = '8'.repeat(40);
      const payload = {
        schemaVersion: 1, operationId: crypto.randomUUID(),
        task: { projectSlug: 'forge-host', taskId: 'task-one', actorUserId: crypto.randomUUID(),
          actorUsername: 'owner', conversationId: 'conversation-one', dshSessionId: 'session-one' },
        from: { head: f.original.source.head, fingerprint: f.original.source.workspaceFingerprint },
        to: { head: nextHead, fingerprint: f.original.source.workspaceFingerprint },
        canonicalHead: f.original.source.head, phase: 'checkpointed',
        sourceAuthority: { executionId: crypto.randomUUID(), generation: 1, contractId: 'd'.repeat(64),
          productionAuthorityDigest: '1'.repeat(64), controllerGrantDigest: '2'.repeat(64), actionCeiling: 'release',
          issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
        digestAlgorithm: 'sha256', digestEncoding: 'canonical-json-v1',
      };
      if (scenario === 'integrated') payload.phase = 'integrated';
      if (scenario === 'changed-content') payload.from.fingerprint = '0'.repeat(64);
      if (scenario === 'wrong-from') payload.from.head = '0'.repeat(40);
      if (scenario === 'wrong-task') payload.task.taskId = 'another-task';
      const transition = { ...payload, digest: sourceTransitionCanonicalDigest(payload) };
      f.state.setHead(nextHead);
      // Source admission still independently observes and binds the actual new HEAD.
      f.runner.source = async () => ({ workspace: f.runner.taskWorkspace('task-one'),
        inventory: await f.state.inventory(), reviewBase: f.original.source.head });
      const admission = await f.runner.admit('task-one', [f.request.profile]);
      assert.equal((await f.runner.receipt('task-one', f.original.receiptId)).freshness, 'stale',
        'read-only receipt lookup does not claim the old HEAD was already revalidated');
      const issuer = f.runner.acceptanceIssuerClient;
      f.runner.acceptanceIssuerClient = async (route, body, options) => {
        const result = await issuer(route, body, options);
        return route === '/v1/candidate-bindings' && scenario !== 'missing'
          ? { ...result, sourceTransition: transition } : result;
      };
      const request = { ...f.request, admissionId: admission.admissionId };
      const commands = f.commands();
      f.runner.prepareJob = async () => assert.fail('checkpoint reuse must not rerun checks');
      if (scenario === 'checkpoint' || scenario === 'integrated') {
        const projection = await f.runner.execute(request);
        assert.deepEqual(projection.source, f.original.source);
        assert.deepEqual(projection.revalidation.sourceTransition, transition);
        assert.equal(projection.revalidation.admissionReceipt.source.head, nextHead);
        validateHostRunReceipt(projection);
      } else {
        await assert.rejects(f.runner.execute(request), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
      }
      assert.equal(f.commands(), commands);
      assert.deepEqual(await readFile(f.receiptFile), f.originalBytes);
    });
  }
});

test('Host consecutive checkpoint reuse preserves confirmed predecessors and idempotent retries', async t => {
  for (const scenario of ['accepted', 'unconfirmed', 'tampered-predecessor']) {
    await t.test(scenario, async sub => {
      const f = await hostReceiptReuseFixture(sub, 'frontend-admin-lint',
        { files: ['forge-admin-ui/src/example.ts'] }, 'forge-admin-ui');
      const logBytes = await readFile(f.original.logs.path);
      const commands = f.commands();
      f.runner.prepareJob = async () => assert.fail('consecutive checkpoint reuse must not execute checks');
      f.runner.source = async () => ({ workspace: f.runner.taskWorkspace('task-one'),
        inventory: { ...await f.state.inventory(), files: [{ relative: 'forge-admin-ui/src/example.ts', deleted: false }], fileCount: 1 },
        reviewBase: f.original.source.head,
        readGit: async argv => result({ stdout: argv[0] === 'diff' ? 'forge-admin-ui/src/example.ts\0' : '' }) });
      const task = { projectSlug: 'forge-host', taskId: 'task-one', actorUserId: crypto.randomUUID(),
        actorUsername: 'owner', conversationId: 'conversation-one', dshSessionId: 'session-one' };
      let transition;
      const issuer = f.runner.acceptanceIssuerClient;
      f.runner.acceptanceIssuerClient = async (route, body, options) => {
        const response = await issuer(route, body, options);
        return route === '/v1/candidate-bindings' ? { ...response, sourceTransition: transition } : response;
      };
      const advance = async (from, to, contractId, key) => {
        const payload = { schemaVersion: 1, operationId: crypto.randomUUID(), task,
          from: { head: from, fingerprint: f.original.source.workspaceFingerprint },
          to: { head: to, fingerprint: f.original.source.workspaceFingerprint },
          canonicalHead: f.original.source.head, phase: 'checkpointed',
          sourceAuthority: { executionId: crypto.randomUUID(), generation: 1, contractId,
            productionAuthorityDigest: '1'.repeat(64), controllerGrantDigest: '2'.repeat(64), actionCeiling: 'git-checkpoint',
            issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
          digestAlgorithm: 'sha256', digestEncoding: 'canonical-json-v1' };
        transition = { ...payload, digest: sourceTransitionCanonicalDigest(payload) };
        f.state.setHead(to);
        const admission = await f.runner.admit('task-one', [f.request.profile]);
        return { ...f.request, admissionId: admission.admissionId, acceptanceContractId: contractId,
          candidateBinding: { ...f.request.candidateBinding, contractId }, idempotencyKey: key };
      };
      const firstRequest = await advance(f.original.source.head, '8'.repeat(40), 'e'.repeat(64), 'checkpoint-first');
      const first = await f.runner.execute(firstRequest);
      const retainedFile = path.join(path.dirname(f.receiptFile), `${f.original.receiptId}.revalidation.json`);
      const retained = JSON.parse(await readFile(retainedFile, 'utf8'));
      assert.equal(retained.acceptanceSubmitted, true);
      if (scenario === 'unconfirmed') retained.acceptanceSubmitted = false;
      if (scenario === 'tampered-predecessor') retained.revalidationProjection.revalidation.sourceTransition.from.head = '0'.repeat(40);
      if (scenario !== 'accepted') await writeFile(retainedFile, JSON.stringify(retained));
      const request = await advance('8'.repeat(40), '9'.repeat(40), 'f'.repeat(64), 'checkpoint-second');
      if (scenario === 'accepted') {
        const second = await f.runner.execute(request);
        validateHostRunReceipt(second);
        assert.deepEqual(second.revalidation.previousRevalidation, first.revalidation);
        assert.deepEqual(second.revalidation.sourceTransition, transition);
        assert.deepEqual(second.source, f.original.source);
        const submissions = f.routes.filter(entry => entry.route === '/v1/verification').length;
        assert.deepEqual(await f.runner.execute(request), second, 'confirmed retry returns the same two-hop projection');
        assert.equal(f.routes.filter(entry => entry.route === '/v1/verification').length, submissions);
        const admission = await f.runner.admit('task-one', [f.request.profile]);
        const readmitted = await f.runner.execute({ ...request, admissionId: admission.admissionId, idempotencyKey: 'checkpoint-readmitted' });
        assert.deepEqual(readmitted.revalidation.previousRevalidation, first.revalidation);
        assert.deepEqual(readmitted.revalidation.sourceTransition, transition);
        for (const edge of ['sourceTransition', 'previousRevalidation']) {
          const forged = structuredClone(second);
          const descriptor = edge === 'sourceTransition' ? forged.revalidation.sourceTransition
            : forged.revalidation.previousRevalidation.sourceTransition;
          descriptor.from.head = '0'.repeat(40);
          const { digest: ignored, ...payload } = descriptor;
          descriptor.digest = sourceTransitionCanonicalDigest(payload);
          assert.throws(() => validateHostRunReceipt(forged), /source|checkpoint/iu);
        }
      } else {
        await assert.rejects(f.runner.execute(request), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
      }
      assert.equal(f.commands(), commands);
      assert.deepEqual(await readFile(f.receiptFile), f.originalBytes);
      assert.deepEqual(await readFile(f.original.logs.path), logBytes);
    });
  }
});

test('Host revalidation retries an unconfirmed submission with the same preserved projection', async (t) => {
  const context = await hostReceiptReuseFixture(t);
  const issuer = context.runner.acceptanceIssuerClient;
  let firstProjection;
  let submissions = 0;
  context.runner.acceptanceIssuerClient = async (route, body, options) => {
    if (route === '/v1/verification') {
      submissions += 1;
      if (submissions === 1) {
        firstProjection = structuredClone(body.runnerReceipt);
        throw new Error('issuer submission outcome is uncertain');
      }
    }
    return issuer(route, body, options);
  };
  const commandsBefore = context.commands();
  await assert.rejects(context.runner.execute(context.request), /submission outcome is uncertain/u);
  const retried = await context.runner.execute(context.request);
  assert.deepEqual(retried, firstProjection);
  assert.equal(submissions, 2);
  assert.deepEqual(await context.runner.execute(context.request), firstProjection);
  assert.equal(submissions, 2, 'confirmed submission is not repeated');
  assert.equal(context.commands(), commandsBefore);
  assert.deepEqual(await readFile(context.receiptFile), context.originalBytes);
});

test('Host revalidation accepts actual preinstalled execution without installing or running checks again', async (t) => {
  const module = 'forge-server/forge-business/forge-business-core';
  for (const [profile, selectors, preparedProject] of [
    ['frontend-admin-test', {}, 'forge-admin-ui'],
    ['frontend-admin-test', { testFiles: ['forge-admin-ui/src/example.spec.ts'] }, 'forge-admin-ui'],
    ['frontend-admin-lint', { files: ['forge-admin-ui/src/example.ts'] }, 'forge-admin-ui'],
    ['frontend-admin-typecheck', {}, 'forge-admin-ui'],
    ['frontend-admin-build', {}, 'forge-admin-ui'],
    ['frontend-h5-build', {}, 'forge-h5-ui'],
    ['backend-module-test', { modules: [module] }, 'm2'],
    ['full-regression', {}, 'm2'],
  ]) {
    await t.test(`${profile} ${JSON.stringify(selectors)}`, async (caseTest) => {
      const context = await hostReceiptReuseFixture(caseTest, profile, selectors, preparedProject);
      const { runner, original, originalBytes, receiptFile, request, routes } = context;
      assert.equal(context.commands(), 1, 'original execution runs only the requested check, never installation');
      assert.equal(original.execution.steps.length, 1);
      if (preparedProject === 'm2') assert.equal(original.execution.steps[0].argv[0], '--offline');
      const logBytes = await readFile(original.logs.path);
      runner.prepareJob = async () => assert.fail('receipt reuse must not prepare dependencies or another job');
      const projection = await runner.execute(request);
      assert.equal(context.commands(), 1, 'revalidation never reruns the check');
      assert.deepEqual(projection.execution, original.execution);
      assert.deepEqual(projection.request, original.request);
      assert.deepEqual(projection.results, original.results);
      assert.deepEqual(await readFile(receiptFile), originalBytes);
      assert.deepEqual(await readFile(original.logs.path), logBytes);
      assert.deepEqual(routes.at(-1).body.runnerReceipt, projection);
      assert.equal(routes.at(-1).body.contractId, request.acceptanceContractId);
      validateHostRunReceipt(projection, { reuseReceiptId: original.receiptId, admissionId: request.admissionId });
    });
  }
});

test('Host preinstalled receipt reuse still rejects command, scope, result and preparation tampering', async (t) => {
  for (const [profile, selectors, preparedProject, mutations] of [
    ['frontend-admin-test', { testFiles: ['forge-admin-ui/src/example.spec.ts'] }, 'forge-admin-ui', {
      command: (raw) => { raw.execution.steps[0].argv[0] = 'build'; },
      scope: (raw) => { raw.execution.steps[0].argv[1] = 'src/other.spec.ts'; },
      cwd: (raw) => { raw.execution.steps[0].cwd = path.dirname(raw.execution.steps[0].cwd); },
      executable: (raw) => { raw.execution.steps[0].executable += '-other'; },
      'extra step': (raw) => { raw.execution.steps.push(structuredClone(raw.execution.steps[0])); },
      'offline frontend': (raw) => { raw.execution.steps[0].argv.unshift('--offline'); },
      'zero tests': (raw) => { Object.assign(raw.results, { executed: 0, passed: 0, reportFiles: 0 }); },
      'failed result': (raw) => { raw.status = 'failed'; },
    }],
    ['backend-module-test', { modules: ['forge-server/forge-business/forge-business-core'] }, 'm2', {
      'duplicate offline': (raw) => { raw.execution.steps[0].argv.unshift('--offline'); },
      'different module': (raw) => { const argv = raw.execution.steps[0].argv; argv[argv.indexOf('-pl') + 1] = 'another-module'; },
      'extra option': (raw) => { raw.execution.steps[0].argv.push('-DskipTests'); },
    }],
  ]) {
    await t.test(profile, async (caseTest) => {
      const context = await hostReceiptReuseFixture(caseTest, profile, selectors, preparedProject);
      const submissions = context.routes.filter((entry) => entry.route === '/v1/verification').length;
      context.runner.prepareJob = async () => assert.fail('invalid reuse must not prepare a job');
      for (const [name, mutate] of Object.entries(mutations)) {
        const raw = structuredClone(context.original);
        mutate(raw);
        await writeFile(context.receiptFile, JSON.stringify(raw));
        await assert.rejects(context.runner.execute(context.request), { code: 'VERIFY_RECEIPT_REUSE_INVALID' }, name);
        assert.equal(context.commands(), 1, name);
        assert.equal(context.routes.filter((entry) => entry.route === '/v1/verification').length, submissions, name);
        assert.deepEqual(JSON.parse(await readFile(context.receiptFile, 'utf8')), raw, 'do not repair historical evidence');
      }
    });
  }
});

test('Host revalidation after a runner revision change allows only unused governance tool changes', async (t) => {
  const context = await hostReceiptReuseFixture(t, 'frontend-admin-test', {}, 'forge-admin-ui');
  const { runner, original, currentContract } = context;
  runner.contract = { ...currentContract, runnerRevision: 'forge-host-runner-revalidation-fix' };
  runner.runnerBootId = crypto.randomUUID();
  runner.admissions.clear();
  runner.prepareJob = async () => assert.fail('a new Runner must reuse the retained execution, not rerun it');
  const admission = await runner.admit('task-one', ['frontend-admin-test']);
  assert.equal(admission.runner.revision, runner.contract.runnerRevision);
  assert.equal(admission.profilePolicyDigest, original.policy.profilePolicyDigest);
  assert.deepEqual(admission.toolchain, original.toolchain);
  const projection = await runner.execute({ ...context.request, admissionId: admission.admissionId });
  assert.deepEqual(projection.execution, original.execution);
  assert.deepEqual(projection.revalidation.admissionReceipt, admission);

  runner.toolchainProbe = async () => toolchainIdentity({ ...runner.contract, toolchains: {
    ...runner.contract.toolchains, forgeGovernance: path.join(path.dirname(process.execPath), 'another-version', 'forge-governance'),
  } });
  const changed = await runner.admit('task-one', ['frontend-admin-test']);
  assert.notEqual(changed.toolchain.digest, original.toolchain.digest, 'moving an unchanged tool still changes its bound identity');
  const reused = await runner.execute({ ...context.request, admissionId: changed.admissionId });
  validateHostRunReceipt(reused);
  assert.deepEqual(reused.toolchain, original.toolchain, 'the original execution identity is not rewritten');
  assert.deepEqual(reused.revalidation.admissionReceipt.toolchain, changed.toolchain);
  runner.toolchainProbe = async () => toolchainIdentity({ ...runner.contract, toolchains: {
    ...runner.contract.toolchains, node: path.join(path.dirname(process.execPath), 'another-version', 'node'),
  } });
  const changedNode = await runner.admit('task-one', ['frontend-admin-test']);
  await assert.rejects(runner.execute({ ...context.request, admissionId: changedNode.admissionId }),
    { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
  assert.equal(context.commands(), 1);
  assert.deepEqual(await readFile(context.receiptFile), context.originalBytes);
});

test('Host governance-only tool updates reuse backend and lint evidence but keep governance checks strict', async (t) => {
  for (const [profile, selectors, preparedProject] of [
    ['backend-module-test', { modules: ['forge-server/forge-business/forge-business-core'] }, 'm2'],
    ['frontend-admin-lint', { files: ['forge-admin-ui/src/example.ts'] }, 'forge-admin-ui'],
    ['governance', {}, undefined],
    ['changed-safe', {}, undefined],
  ]) {
    await t.test(profile, async (subtest) => {
      const f = await hostReceiptReuseFixture(subtest, profile, selectors, preparedProject);
      const logBytes = await readFile(f.original.logs.path);
      const commands = f.commands();
      f.runner.prepareJob = async () => assert.fail('toolchain revalidation must not execute another job');
      f.runner.toolchainProbe = async () => {
        const toolchain = toolchainIdentity(f.currentContract);
        toolchain.executables.forgeGovernance.bytes += 1;
        toolchain.executables.forgeGovernance.modifiedMs += 1;
        toolchain.digest = crypto.createHash('sha256').update(JSON.stringify({
          javaHome: toolchain.javaHome, executables: toolchain.executables,
        })).digest('hex');
        return toolchain;
      };
      const admission = await f.runner.admit('task-one', [profile]);
      const request = { ...f.request, admissionId: admission.admissionId };
      if (['governance', 'changed-safe'].includes(profile)) {
        await assert.rejects(f.runner.execute(request), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
      } else {
        const projection = await f.runner.execute(request);
        validateHostRunReceipt(projection);
        assert.deepEqual(projection.execution, f.original.execution);
        assert.deepEqual(projection.toolchain, f.original.toolchain);
        assert.deepEqual(projection.results, f.original.results);
        assert.deepEqual(f.routes.at(-1).body.runnerReceipt, projection);
      }
      assert.equal(f.commands(), commands);
      assert.deepEqual(await readFile(f.receiptFile), f.originalBytes);
      assert.deepEqual(await readFile(f.original.logs.path), logBytes);
    });
  }
});

test('Host frontend receipt reuse ignores unused Java updates but preserves actual frontend identity', async (t) => {
  const changedJava = (original) => {
    const current = structuredClone(original);
    current.javaHome += '-updated';
    for (const name of ['java', 'maven']) {
      current.executables[name].version += '-updated';
      current.executables[name].modifiedMs += 1;
    }
    current.digest = crypto.createHash('sha256').update(JSON.stringify({
      javaHome: current.javaHome, executables: current.executables,
    })).digest('hex');
    return current;
  };
  for (const profile of ['frontend-admin-lint', 'frontend-admin-test', 'frontend-admin-typecheck',
    'frontend-admin-build', 'frontend-h5-build']) {
    await t.test(profile, async (subtest) => {
      const selectors = profile === 'frontend-admin-lint' ? { files: ['forge-admin-ui/src/example.ts'] } : {};
      const f = await hostReceiptReuseFixture(subtest, profile, selectors,
        profile === 'frontend-h5-build' ? 'forge-h5-ui' : 'forge-admin-ui');
      const current = changedJava(f.original.toolchain);
      f.runner.toolchainProbe = async () => current;
      const admission = await f.runner.admit('task-one', [profile]);
      const commands = f.commands();
      f.runner.prepareJob = async () => assert.fail('unchanged frontend execution must be reused');
      const projection = await f.runner.execute({ ...f.request, admissionId: admission.admissionId });
      validateHostRunReceipt(projection);
      assert.deepEqual(f.routes.at(-1).body.runnerReceipt, projection, 'issuer consumes the same validated projection');
      assert.deepEqual(projection.toolchain, f.original.toolchain);
      assert.deepEqual(projection.revalidation.admissionReceipt.toolchain, current);
      assert.equal(f.commands(), commands);
      assert.deepEqual(await readFile(f.receiptFile), f.originalBytes);
      for (const name of ['node', 'pnpm', 'git']) {
        const changed = structuredClone(current);
        changed.executables[name].modifiedMs += 1;
        changed.digest = crypto.createHash('sha256').update(JSON.stringify({
          javaHome: changed.javaHome, executables: changed.executables,
        })).digest('hex');
        assert.equal(hostRevalidationToolchainsMatch(f.original.toolchain, changed, profile), false, name);
      }
      assert.equal(hostRevalidationToolchainsMatch(f.original.toolchain, { ...current, digest: '0'.repeat(64) }, profile), false);
      assert.equal(hostRevalidationToolchainsMatch({ ...f.original.toolchain, digest: '0'.repeat(64) }, current, profile), false);
      for (const strict of ['backend-module-compile', 'backend-module-test', 'backend-test-class', 'full-regression', 'governance', 'changed-safe']) {
        assert.equal(hostRevalidationToolchainsMatch(f.original.toolchain, current, strict), false, strict);
      }
    });
  }
});

test('Host backend source projection reuses the original execution across frontend-only additions', async (t) => {
  const deletedBackend = { relative: 'forge-server/src/Withdrawn.java', deleted: true, bytes: 0 };
  let files = [deletedBackend];
  const state = {
    async inventory() {
      const fingerprint = crypto.createHash('sha256');
      for (const item of files) if (!item.deleted) fingerprint.update(item.relative).update('\0').update(item.sha256).update('\0').update(String(item.bytes)).update('\0');
      return { head: 'b'.repeat(40), fileCount: files.length, bytes: files.reduce((sum, item) => sum + item.bytes, 0),
        files, workspaceFingerprint: fingerprint.digest('hex'), dependencyManifestFingerprint: 'c'.repeat(64), dependencyManifestFiles: [] };
    },
  };
  const selectors = { modules: ['forge-server/forge-business/forge-business-core'], tests: ['ExampleTest'] };
  const f = await hostReceiptReuseFixture(t, 'backend-test-class', selectors, 'm2', false, state);
  const commands = f.commands();
  const logBytes = await readFile(f.original.logs.path);
  f.runner.prepareJob = async () => assert.fail('frontend source changes must not rerun backend execution');
  files = [{ relative: 'forge-admin-ui/src/utils/new-query.js', bytes: 1, sha256: crypto.createHash('sha256').update('x').digest('hex') }, deletedBackend];
  const admission = await f.runner.admit('task-one', ['backend-test-class']);
  const projection = await f.runner.execute({ ...f.request, admissionId: admission.admissionId });
  validateHostRunReceipt(projection, { sourceFingerprint: admission.source.workspaceFingerprint });
  assert.equal(projection.revalidation.sourceProjection.reconstructedFingerprint, f.original.source.workspaceFingerprint);
  assert.deepEqual(projection.revalidation.sourceProjection.frontendPaths, [files[0].relative]);
  assert.equal(f.commands(), commands, 'only source metadata is read; no execution is repeated');
  assert.deepEqual(projection.source, f.original.source);
  assert.deepEqual(await readFile(f.receiptFile), f.originalBytes);
  assert.deepEqual(await readFile(f.original.logs.path), logBytes);
  assert.deepEqual(f.routes.at(-1).body.runnerReceipt, projection);

  files = [...files, { relative: 'forge-server/src/Changed.java', bytes: 1, sha256: files[0].sha256 }];
  const backendChanged = await f.runner.admit('task-one', ['backend-test-class']);
  await assert.rejects(f.runner.execute({ ...f.request, admissionId: backendChanged.admissionId }), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
  assert.equal(f.commands(), commands);
  assert.deepEqual(await readFile(f.receiptFile), f.originalBytes);
});

test('Host backend reuse preserves already dirty frontend hashes and refuses changed backend or retained evidence', async (t) => {
  const item = (relative, content) => ({ relative, content, bytes: Buffer.byteLength(content),
    sha256: crypto.createHash('sha256').update(content).digest('hex') });
  const backend = item('forge-server/Existing.java', 'unchanged backend');
  const initial = [item('forge-admin-ui/src/Existing.vue', 'previous dirty frontend'),
    item('forge-admin-ui/src/Removed.vue', 'uncommitted frontend addition'), backend];
  let files = initial;
  const state = {
    async inventory() {
      const fingerprint = crypto.createHash('sha256');
      for (const value of [...files].sort((a, b) => a.relative < b.relative ? -1 : 1)) {
        fingerprint.update(value.relative).update('\0').update(value.sha256).update('\0').update(String(value.bytes)).update('\0');
      }
      return { head: 'b'.repeat(40), files, fileCount: files.length,
        bytes: files.reduce((sum, value) => sum + value.bytes, 0), workspaceFingerprint: fingerprint.digest('hex'),
        dependencyManifestFingerprint: 'c'.repeat(64), dependencyManifestFiles: [] };
    },
  };
  const selectors = { modules: ['forge-server/forge-business/forge-business-core'] };
  const f = await hostReceiptReuseFixture(t, 'backend-module-test', selectors, 'm2', false, state);
  const commands = f.commands();
  const log = await readFile(f.original.logs.path);
  f.runner.prepareJob = async () => assert.fail('reuse must not copy dependencies or execute another backend job');
  files = [item(initial[0].relative, 'next frontend edit'), item('forge-admin-ui/src/Added.vue', 'new frontend'), backend];
  const admission = await f.runner.admit('task-one', ['backend-module-test']);
  const projection = await f.runner.execute({ ...f.request, admissionId: admission.admissionId });
  validateHostRunReceipt(projection, { sourceFingerprint: admission.source.workspaceFingerprint });
  assert.equal(projection.revalidation.sourceProjection.reconstructedFingerprint, f.original.source.workspaceFingerprint);
  assert.deepEqual(projection.revalidation.sourceProjection.frontendPaths,
    ['forge-admin-ui/src/Added.vue', 'forge-admin-ui/src/Existing.vue', 'forge-admin-ui/src/Removed.vue']);
  assert.equal(f.commands(), commands);
  assert.deepEqual(f.routes.at(-1).body.runnerReceipt, projection);
  assert.deepEqual(await readFile(f.receiptFile), f.originalBytes);
  assert.deepEqual(await readFile(f.original.logs.path), log);

  files = [...files.slice(0, 2), item(backend.relative, 'changed backend')];
  const changed = await f.runner.admit('task-one', ['backend-module-test']);
  await assert.rejects(f.runner.execute({ ...f.request, admissionId: changed.admissionId }), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
  files = [...files.slice(0, 2), backend];
  const savedPath = path.join(f.runner.stateRoot, 'receipt-source-frontends', 'task-one', `${f.original.receiptId}.json`);
  const saved = JSON.parse(await readFile(savedPath, 'utf8'));
  saved.files[0].sha256 = '0'.repeat(64);
  await writeFile(savedPath, JSON.stringify(saved));
  const tampered = await f.runner.admit('task-one', ['backend-module-test']);
  await assert.rejects(f.runner.execute({ ...f.request, admissionId: tampered.admissionId }), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
  assert.equal(f.commands(), commands);
  assert.deepEqual(await readFile(f.receiptFile), f.originalBytes);
});

test('Host reuses successful lint with the previous observed formatting exceptions', async (t) => {
  const context = await hostReceiptReuseFixture(t, 'frontend-admin-lint',
    { files: ['forge-admin-ui/src/example.ts'] }, 'forge-admin-ui', true);
  const { runner, original, receiptFile, request } = context;
  original.execution.steps[0].argv.push(...LINT_FORMAT_ARGS.slice(0, 14));
  await writeFile(receiptFile, JSON.stringify(original));
  const before = await readFile(receiptFile);
  runner.prepareJob = async () => assert.fail('reuse the stricter successful lint without executing again');
  const reused = await runner.execute(request);
  assert.deepEqual(reused.execution, original.execution);
  assert.deepEqual(await readFile(receiptFile), before);
  assert.equal(context.commands(), 1);
});

test('Host lint revalidation accepts only the original strict successful command plan', async (t) => {
  const context = await hostReceiptReuseFixture(t, 'frontend-admin-lint',
    { files: ['forge-admin-ui/src/example.ts'] }, 'forge-admin-ui', true);
  const { runner, original, originalBytes, receiptFile, request } = context;
  assert.deepEqual(original.execution.steps[0].argv,
    ['exec', 'eslint', 'src/example.ts', '--max-warnings=0']);
  runner.prepareJob = async () => assert.fail('legacy strict lint must be reused without execution');
  const projection = await runner.execute(request);
  assert.deepEqual(projection.execution, original.execution);
  assert.deepEqual(await readFile(receiptFile), originalBytes);
  assert.equal(context.commands(), 1);
  for (const [name, mutate] of Object.entries({
    'disabled real rule': (raw) => { raw.execution.steps[0].argv.push('--rule', 'ts/no-use-before-define: off'); },
    'changed file': (raw) => { raw.execution.steps[0].argv[2] = 'src/other.ts'; },
    'changed cwd': (raw) => { raw.execution.steps[0].cwd = path.dirname(raw.execution.steps[0].cwd); },
    'changed policy': (raw) => { raw.policy.profilePolicyDigest = '0'.repeat(64); },
    'failed receipt': (raw) => {
      raw.status = 'failed'; raw.execution.exitCode = 1;
      raw.execution.steps[0].exitCode = 1; raw.truth.verificationProven = false;
    },
  })) {
    await t.test(name, async () => {
      const raw = structuredClone(original);
      mutate(raw);
      await writeFile(receiptFile, JSON.stringify(raw));
      await assert.rejects(runner.execute(request), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
      assert.equal(context.commands(), 1);
      assert.deepEqual(JSON.parse(await readFile(receiptFile, 'utf8')), raw);
    });
  }
});

test('Host revalidation rejects changed canonical facts and logs without falling back to execution', async (t) => {
  const changes = {
    'project identity': (raw) => { raw.projectSlug = 'other-project'; },
    'task identity': (raw) => { raw.taskId = 'other-task'; },
    'receipt identity': (raw) => { raw.receiptId = crypto.randomUUID(); },
    'source HEAD': (raw) => { raw.source.head = '2'.repeat(40); },
    'source fingerprint': (raw) => { raw.source.workspaceFingerprint = '2'.repeat(64); },
    'dependency fingerprint': (raw) => { raw.source.dependencyManifestFingerprint = '2'.repeat(64); },
    profile: (raw) => { raw.request.profile = 'frontend-h5-build'; },
    selectors: (raw) => { raw.request.selectors = { files: ['forge-admin-ui/src/other.ts'] }; },
    'selectors digest': (raw) => { raw.request.selectorsSha256 = '2'.repeat(64); },
    'toolchain digest': (raw) => { raw.toolchain.digest = '2'.repeat(64); },
    'toolchain descriptor': (raw) => { raw.toolchain.executables.node.version = 'changed-version'; },
    'profile policy': (raw) => { raw.policy.profilePolicyDigest = '2'.repeat(64); },
    'catalog version': (raw) => { raw.policy.profileCatalogVersion = 'another-version'; },
    'failed execution': (raw) => { raw.status = 'failed'; },
    'unfinished process': (raw) => { raw.execution.steps[0].processEnded = false; },
    'unproven cleanup': (raw) => { raw.isolation.cleanupProven = false; },
    'different command': (raw) => { raw.execution.steps[0].argv.push('--unexpected'); },
    'different cwd': (raw) => { raw.execution.steps[0].cwd = path.dirname(raw.execution.steps[0].cwd); },
    'different executable': (raw) => { raw.execution.steps[0].executable += '.changed'; },
    'different task cache': (raw) => { raw.isolation.cacheRoot += '-other'; },
    'different log path': (raw) => { raw.logs.path += '-other'; },
    'different log size': (raw) => { raw.logs.bytes += 1; },
    'different log digest': (raw) => { raw.logs.sha256 = '2'.repeat(64); },
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, async (caseTest) => {
      const context = await hostReceiptReuseFixture(caseTest);
      const raw = structuredClone(context.original);
      change(raw);
      await writeFile(context.receiptFile, `${JSON.stringify(raw)}\n`);
      const alteredBytes = await readFile(context.receiptFile);
      const commandsBefore = context.commands();
      const submissionsBefore = context.routes.filter((entry) => entry.route === '/v1/verification').length;
      context.runner.prepareJob = async () => assert.fail('invalid reuse must never prepare a new job');
      await assert.rejects(context.runner.execute(context.request));
      assert.equal(context.commands(), commandsBefore);
      assert.equal(context.routes.filter((entry) => entry.route === '/v1/verification').length, submissionsBefore);
      assert.deepEqual(await readFile(context.receiptFile), alteredBytes, 'rejection must not repair or rewrite the original');
    });
  }
  await t.test('modified retained log after an earlier successful revalidation', async (caseTest) => {
    const context = await hostReceiptReuseFixture(caseTest);
    await context.runner.execute(context.request);
    await writeFile(context.original.logs.path, 'changed after successful revalidation');
    const commandsBefore = context.commands();
    await assert.rejects(context.runner.execute(context.request), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
    assert.equal(context.commands(), commandsBefore, 'cache hits must recheck the actual retained log');
  });
});

test('Host revalidation retains current admission and protected authority boundaries', async (t) => {
  for (const scenario of ['missing-binding', 'missing-issuer', 'expired-admission', 'changed-source', 'changed-runtime', 'wrong-task-admission']) {
    await t.test(scenario, async (caseTest) => {
      const context = await hostReceiptReuseFixture(caseTest);
      if (scenario === 'missing-binding') delete context.request.candidateBinding;
      if (scenario === 'missing-issuer') context.runner.acceptanceIssuerClient = null;
      if (scenario === 'expired-admission') context.runner.now = () => Date.now() + 6 * 60 * 1000;
      if (scenario === 'changed-source') context.state.setFingerprint('3'.repeat(64));
      if (scenario === 'changed-runtime') context.runner.toolchainProbe = async () => toolchainIdentity(context.currentContract, '-changed');
      if (scenario === 'wrong-task-admission') context.runner.admissions.get(context.admission.admissionId).taskId = 'other-task';
      context.runner.prepareJob = async () => assert.fail('invalid authority must not start a new execution');
      const commandsBefore = context.commands();
      await assert.rejects(context.runner.execute(context.request));
      assert.equal(context.commands(), commandsBefore);
      assert.deepEqual(await readFile(context.receiptFile), context.originalBytes);
    });
  }
});

async function integratedGovernanceReuseFixture(t, scenario = 'nonempty') {
  const output = scenario === 'unproven-scan' ? ''
    : `PASS Forge governance 2026.09.20.2: ${scenario === 'empty-scan' ? 0 : 2} files, 0 blocking findings, 0 unchanged legacy findings retained.\n`;
  const f = await hostReceiptReuseFixture(t, 'governance', {}, undefined, false, undefined, output);
  const nextHead = '8'.repeat(40);
  const payload = {
    schemaVersion: 1, operationId: crypto.randomUUID(),
    task: { projectSlug: 'forge-host', taskId: 'task-one', actorUserId: crypto.randomUUID(),
      actorUsername: 'owner', conversationId: 'conversation-one', dshSessionId: 'session-one' },
    from: { head: f.original.source.head, fingerprint: f.original.source.workspaceFingerprint },
    to: { head: nextHead, fingerprint: f.original.source.workspaceFingerprint },
    canonicalHead: nextHead, phase: 'integrated',
    sourceAuthority: { executionId: crypto.randomUUID(), generation: 1, contractId: 'd'.repeat(64),
      productionAuthorityDigest: '1'.repeat(64), controllerGrantDigest: '2'.repeat(64), actionCeiling: 'release',
      issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    digestAlgorithm: 'sha256', digestEncoding: 'canonical-json-v1',
  };
  f.transition = { ...payload, digest: sourceTransitionCanonicalDigest(payload) };
  f.state.setHead(nextHead);
  if (scenario === 'changed-content') f.state.setFingerprint('9'.repeat(64));
  f.runner.source = async () => ({ workspace: f.runner.taskWorkspace('task-one'),
    inventory: await f.state.inventory(), reviewBase: scenario === 'changed-base' ? '9'.repeat(40) : f.original.source.head });
  const admission = await f.runner.admit('task-one', ['governance']);
  const issuer = f.runner.acceptanceIssuerClient;
  f.runner.acceptanceIssuerClient = async (route, body, options) => {
    const result = await issuer(route, body, options);
    return route === '/v1/candidate-bindings' && scenario !== 'missing-transition'
      ? { ...result, sourceTransition: f.transition } : result;
  };
  f.request = { ...f.request, admissionId: admission.admissionId };
  f.runner.prepareJob = async () => assert.fail('governance receipt reuse must not create a new job');
  return f;
}

test('Host reuses a nonempty governance audit when same-content integration only removes the old HEAD guard', async (t) => {
  const f = await integratedGovernanceReuseFixture(t);
  const commands = f.commands();
  assert.deepEqual(f.original.execution.steps[0].argv,
    ['audit', '--base', f.original.source.head, '--expected-no-change-head', f.original.source.head]);
  const projection = await f.runner.execute(f.request);
  assert.equal(f.commands(), commands);
  assert.equal(projection.receiptId, f.original.receiptId);
  assert.deepEqual(projection.execution, f.original.execution);
  assert.deepEqual(projection.revalidation.sourceTransition, f.transition);
  assert.equal(projection.revalidation.admissionReceipt.source.head, f.transition.to.head);
  validateHostRunReceipt(projection);
  assert.equal(f.routes.at(-1).route, '/v1/governance');
  assert.deepEqual(f.routes.at(-1).body.runnerReceipt, projection);
  assert.deepEqual(await readFile(f.receiptFile), f.originalBytes);
});

test('Host governance HEAD-guard reuse rejects other command plan changes', async (t) => {
  for (const scenario of ['changed-base', 'changed-tool', 'changed-cwd', 'extra-step', 'extra-flag', 'wrong-guard-head']) {
    await t.test(scenario, async (caseTest) => {
      const f = await integratedGovernanceReuseFixture(caseTest, scenario);
      const original = structuredClone(f.original);
      const step = original.execution.steps[0];
      if (scenario === 'changed-tool') step.executable += '-different';
      if (scenario === 'changed-cwd') step.cwd = path.join(step.cwd, 'different');
      if (scenario === 'extra-step') original.execution.steps.push(structuredClone(step));
      if (scenario === 'extra-flag') step.argv.push('--format', 'json');
      if (scenario === 'wrong-guard-head') step.argv[4] = '7'.repeat(40);
      await writeFile(f.receiptFile, JSON.stringify(original));
      const commands = f.commands();
      await assert.rejects(f.runner.execute(f.request), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
      assert.equal(f.commands(), commands);
      assert.equal(f.routes.filter(row => row.route === '/v1/governance').length, 1, 'only the original execution was submitted');
    });
  }
});

test('Host governance HEAD-guard reuse requires a valid transition and nonempty canonical scan evidence', async (t) => {
  for (const scenario of ['missing-transition', 'changed-content', 'empty-scan', 'unproven-scan', 'tampered-log']) {
    await t.test(scenario, async (caseTest) => {
      const f = await integratedGovernanceReuseFixture(caseTest, scenario);
      if (scenario === 'tampered-log') await writeFile(f.original.logs.path, 'PASS Forge governance 2026.09.20.2: 2 files, 0 blocking findings, 0 unchanged legacy findings retained.\n');
      const commands = f.commands();
      await assert.rejects(f.runner.execute(f.request), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
      assert.equal(f.commands(), commands);
      assert.deepEqual(await readFile(f.receiptFile), f.originalBytes);
      assert.equal(f.routes.filter(row => row.route === '/v1/governance').length, 1);
    });
  }
});

test('Host revalidation compares the current governance review base and rejects zero executed tests', async (t) => {
  await t.test('governance review base is part of the exact command plan', async (caseTest) => {
    const context = await hostReceiptReuseFixture(caseTest, 'governance');
    const projection = await context.runner.execute(context.request);
    assert.equal(projection.results.executed, 0, 'non-test governance remains valid with no tests');
    const raw = structuredClone(context.original);
    raw.execution.steps[0].argv[2] = '8'.repeat(40);
    await writeFile(context.receiptFile, JSON.stringify(raw));
    await assert.rejects(context.runner.execute(context.request), /fixed plan or review base/u);
  });
  await t.test('technical test evidence preserves its limited truth claims', async (caseTest) => {
    const context = await hostReceiptReuseFixture(caseTest, 'frontend-admin-test');
    const commandsBefore = context.commands();
    const projection = await context.runner.execute(context.request);
    assert.equal(projection.results.executed, 1);
    assert.equal(projection.truth.databaseIntegrationProven, false);
    assert.equal(projection.truth.semanticCorrectnessProven, false);
    assert.equal(projection.truth.releaseProven, false);
    const raw = structuredClone(context.original);
    Object.assign(raw.results, { executed: 0, passed: 0, failed: 0, skipped: 0, reportFiles: 0 });
    await writeFile(context.receiptFile, JSON.stringify(raw));
    await assert.rejects(context.runner.execute(context.request), /completed successful verification/u);
    assert.equal(context.commands(), commandsBefore);
  });
});

test('Host rejects invalid run task identities before creating state or escaping task paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-invalid-run-task-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentContract = validateHostVerificationContract(contract(root));
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract,
    inventory: async () => assert.fail('invalid task identity must not read source inventory'),
    command: async () => assert.fail('invalid task identity must not execute commands'),
  });
  const request = { action: 'run', profile: 'frontend-admin-build', selectors: {},
    admissionId: crypto.randomUUID(), idempotencyKey: 'invalid-task-must-not-write' };
  const escapedTask = path.join(root, 'escaped-task');
  for (const taskId of ['../escaped-task', '../../escaped-task', '..\\escaped-task', escapedTask, '', null]) {
    await assert.rejects(runner.run(taskId, request), { code: 'VERIFY_TASK_INVALID' });
    assert.equal(runner.activeByTask.size, 0);
  }
  await assert.rejects(access(escapedTask), { code: 'ENOENT' });
  await assert.rejects(access(path.join(currentContract.stateRoot, 'escaped-task')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(currentContract.stateRoot, 'verification-jobs')), { code: 'ENOENT' });
  await assert.rejects(access(currentContract.stateRoot), { code: 'ENOENT' });
});

test('Host refuses candidate binding failures before creating or executing a job', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-binding-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  let commands = 0;
  let snapshots = 0;
  let wrongIdentity = false;
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory,
    snapshot: async () => { snapshots += 1; },
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async () => { commands += 1; return result(); },
    acceptanceIssuerClient: async () => {
      if (!wrongIdentity) throw Object.assign(new Error('current writer grant does not match'), {
        code: 'VERIFY_ACCEPTANCE_ISSUER_REJECTED',
      });
      return { acceptanceContract: { contractId: '0'.repeat(64) } };
    },
  });
  const admission = await runner.admit('task-one', ['frontend-admin-build']);
  const request = {
    taskId: 'task-one', acceptanceContractId: 'd'.repeat(64), candidateBinding: {},
    action: 'run', profile: 'frontend-admin-build', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'candidate-binding-denied',
  };
  let bindingFailure;
  await assert.rejects(runner.execute(request), (error) => {
    bindingFailure = error;
    return error.code === 'VERIFY_ACCEPTANCE_ISSUER_REJECTED' && /writer grant/u.test(error.message);
  });
  const failedJobId = failedHostJobId(bindingFailure);
  const terminal = await runner.status('task-one', failedJobId);
  assert.equal(terminal.active, false);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error.code, 'VERIFY_ACCEPTANCE_ISSUER_REJECTED');
  assert.match(terminal.diagnostic.message, /writer grant/u);
  assert.equal(terminal.diagnostic.executionProven, false);
  assert.equal(terminal.diagnostic.verificationProven, false);
  await assert.rejects(access(path.join(runner.stateRoot, 'taskspaces', 'task-one', 'jobs', failedJobId)), { code: 'ENOENT' });
  await assert.rejects(runner.receipt('task-one', terminal.receiptId), { code: 'VERIFY_RECEIPT_NOT_FOUND' });
  wrongIdentity = true;
  await assert.rejects(runner.execute(request), (error) => error.code === 'VERIFY_ACCEPTANCE_BINDING_INVALID');
  assert.equal(commands, 0);
  assert.equal(snapshots, 0);
  await assert.rejects(runner.execute({
    action: 'receipt', taskId: 'task-one', receiptId: crypto.randomUUID(), candidateBinding: {},
  }), (error) => error.code === 'VERIFY_REQUEST_INVALID');
});

test('Host rejects source drift after candidate binding instead of submitting an obsolete receipt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-binding-drift-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  const privateValue = 'source-drift-diagnostic-private-value';
  let submissions = 0;
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async () => {
      state.setFingerprint('e'.repeat(64));
      return result({
        stdout: `retained stdout token=${privateValue}\n${currentContract.stateRoot}/task-output`,
        stderr: `retained stderr password=${privateValue}\n${'多字节执行输出'.repeat(600)}`,
      });
    },
    acceptanceIssuerClient: async (route) => {
      if (route !== '/v1/candidate-bindings') { submissions += 1; return { accepted: true }; }
      return { acceptanceContract: {
        contractId: 'd'.repeat(64), projectSlug: 'forge-host', taskId: 'task-one',
        candidate: { source: { head: 'b'.repeat(40), fingerprint: 'a'.repeat(64) } },
      } };
    },
  });
  const admission = await runner.admit('task-one', ['frontend-admin-build']);
  let driftFailure;
  await assert.rejects(runner.execute({
    taskId: 'task-one', acceptanceContractId: 'd'.repeat(64), candidateBinding: {},
    action: 'run', profile: 'frontend-admin-build', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'candidate-binding-drift',
  }), (error) => {
    driftFailure = error;
    return error.code === 'VERIFY_SOURCE_CHANGED';
  });
  assert.equal(submissions, 0);
  const failedJobId = failedHostJobId(driftFailure);
  const terminal = await runner.status('task-one', failedJobId);
  assert.equal(terminal.active, false);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error.code, 'VERIFY_SOURCE_CHANGED');
  assert.equal(terminal.truth.verificationProven, false);
  assert.equal(terminal.diagnostic.executionProven, false);
  assert.equal(terminal.diagnostic.verificationProven, false);
  assert.match(terminal.diagnostic.message, /VERIFY_SOURCE_CHANGED/u);
  assert.match(terminal.diagnostic.message, /retained stdout/u);
  assert.match(terminal.diagnostic.message, /retained stderr/u);
  assert.match(terminal.diagnostic.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(Buffer.byteLength(terminal.diagnostic.message, 'utf8') <= 2000);
  assert.ok(!terminal.diagnostic.message.includes('\uFFFD'), 'UTF-8 truncation must preserve complete characters');
  const persisted = JSON.parse(await readFile(path.join(runner.stateRoot, 'verification-jobs', 'task-one', `${failedJobId}.json`), 'utf8'));
  const stringsIn = (value) => typeof value === 'string' ? [value]
    : value !== null && typeof value === 'object' ? Object.values(value).flatMap(stringsIn) : [];
  const hostPaths = [currentContract.stateRoot, currentContract.stateRoot.replaceAll('\\', '/')];
  for (const text of stringsIn({ terminal, persisted })) {
    assert.ok(!text.includes(privateValue), 'decoded diagnostics must redact process secrets');
    assert.ok(hostPaths.every((prefix) => !text.includes(prefix)), 'decoded diagnostics must redact host paths');
  }
  assert.deepEqual(Object.keys(terminal.diagnostic.logs).sort(), ['bytes', 'file', 'sha256']);
  assert.equal(path.basename(terminal.diagnostic.logs.file), terminal.diagnostic.logs.file);
  const log = await readFile(path.join(runner.stateRoot, 'taskspaces', 'task-one', 'logs', terminal.diagnostic.logs.file));
  assert.equal(log.length, terminal.diagnostic.logs.bytes);
  assert.equal(crypto.createHash('sha256').update(log).digest('hex'), terminal.diagnostic.logs.sha256);
  const logText = log.toString('utf8');
  assert.match(logText, /VERIFY_SOURCE_CHANGED/u);
  assert.match(logText, /retained stdout/u);
  assert.match(logText, /retained stderr/u);
  assert.ok(!logText.includes(privateValue), 'the retained log must redact secrets too');
  assert.ok(hostPaths.every((prefix) => !logText.includes(prefix)), 'the retained log must redact host paths too');
  assert.equal(runner.activeByTask.has('task-one'), false);
  await assert.rejects(access(path.join(runner.stateRoot, 'taskspaces', 'task-one', 'jobs', failedJobId)), { code: 'ENOENT' });
  await assert.rejects(runner.receipt('task-one', terminal.receiptId), { code: 'VERIFY_RECEIPT_NOT_FOUND' });
  const restarted = new HostVerificationRunner({ projectSlug: 'forge-host', contract: currentContract });
  assert.deepEqual(await restarted.status('task-one', failedJobId), terminal);
  assert.deepEqual(await restarted.status('task-two', failedJobId), { active: false, jobId: failedJobId });
});

test('Host preserves passed canonical receipt and log when the later acceptance issuer rejects it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-post-execution-issuer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  let commands = 0;
  let issuedReceipt;
  let receiptBefore;
  let logBefore;
  let rejectSubmission = true;
  let submissions = 0;
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async () => { commands += 1; return result({ stdout: 'completed verification output' }); },
    acceptanceIssuerClient: async (route, body) => {
      assert.equal(route, '/v1/verification');
      submissions += 1;
      if (body.contractId !== 'd'.repeat(64)) {
        throw Object.assign(new Error('current acceptance contract rejected this receipt'),
          { code: 'VERIFY_ACCEPTANCE_CONTRACT_MISMATCH' });
      }
      issuedReceipt = structuredClone(body.runnerReceipt);
      receiptBefore = await readFile(path.join(runner.stateRoot, 'receipts', 'task-one', `${issuedReceipt.receiptId}.json`));
      logBefore = await readFile(issuedReceipt.logs.path);
      if (rejectSubmission) {
        throw Object.assign(new Error('current authority rejected completed execution'), { code: 'VERIFY_ACCEPTANCE_ISSUER_REJECTED' });
      }
      return { accepted: true };
    },
  });
  const admission = await runner.admit('task-one', ['frontend-admin-build']);
  let issuerFailure;
  const request = { taskId: 'task-one', acceptanceContractId: 'd'.repeat(64),
    action: 'run', profile: 'frontend-admin-build', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'post-execution-issuer-rejection' };
  await assert.rejects(runner.execute(request), (error) => {
    issuerFailure = error;
    return error.code === 'VERIFY_ACCEPTANCE_ISSUER_REJECTED';
  });
  assert.equal(commands, 2, 'the fixed execution steps finish before the issuer rejection');
  const jobId = failedHostJobId(issuerFailure);
  assert.equal(jobId, issuedReceipt.jobId);
  const terminal = await runner.status('task-one', jobId);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.error.code, 'VERIFY_ACCEPTANCE_ISSUER_REJECTED');
  assert.equal(terminal.receiptId, issuedReceipt.receiptId);
  assert.equal(terminal.truth.verificationProven, false, 'failed acceptance submission is not acceptance proof');
  assert.deepEqual(await readFile(path.join(runner.stateRoot, 'receipts', 'task-one', `${issuedReceipt.receiptId}.json`)), receiptBefore);
  assert.deepEqual(await readFile(issuedReceipt.logs.path), logBefore);
  assert.equal(terminal.diagnostic.logs.file, path.basename(issuedReceipt.logs.path));
  assert.equal(terminal.diagnostic.logs.bytes, logBefore.length);
  assert.equal(terminal.diagnostic.logs.sha256, crypto.createHash('sha256').update(logBefore).digest('hex'));
  const receipt = await runner.receipt('task-one', issuedReceipt.receiptId);
  validateHostRunReceipt(receipt);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.truth.executionProven, true);
  assert.equal(receipt.truth.verificationProven, true);
  await assert.rejects(access(path.join(runner.stateRoot, 'taskspaces', 'task-one', 'jobs', jobId)), { code: 'ENOENT' });

  const originalReceiptBytes = receiptBefore;
  const originalLogBytes = logBefore;
  await assert.rejects(runner.execute(request), { code: 'VERIFY_ACCEPTANCE_ISSUER_REJECTED' });
  assert.equal(commands, 2, 'a repeated issuer refusal must not rerun the completed commands');
  assert.equal(submissions, 2, 'the same-key run must reach the issuer instead of claiming acceptance');
  rejectSubmission = false;
  const recovered = await runner.execute(request);
  assert.equal(recovered.receiptId, receipt.receiptId);
  assert.equal(submissions, 3);
  assert.equal(commands, 2, 'recovery submits the original receipt without reinstalling or running checks');
  assert.deepEqual(issuedReceipt, JSON.parse(originalReceiptBytes));
  assert.equal(Object.hasOwn(issuedReceipt, 'freshness'), false, 'submit the canonical receipt, not its read-only projection');
  assert.deepEqual(await readFile(path.join(runner.stateRoot, 'receipts', 'task-one', `${receipt.receiptId}.json`)), originalReceiptBytes);
  assert.deepEqual(await readFile(receipt.logs.path), originalLogBytes);
  assert.deepEqual(await runner.status('task-one', jobId), terminal, 'the original failed job remains historical evidence');
  await assert.rejects(runner.execute({ ...request, acceptanceContractId: 'e'.repeat(64) }),
    { code: 'VERIFY_ACCEPTANCE_CONTRACT_MISMATCH' });
  assert.equal(submissions, 4, 'the current issuer still decides whether the original receipt is applicable');
  assert.equal(commands, 2);
});

test('background same-key recovery resubmits completed evidence without rerunning checks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-background-issuer-recovery-'));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  let commands = 0;
  let submissions = 0;
  let rejectSubmission = true;
  let canonical;
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async () => { commands += 1; return result(); },
    acceptanceIssuerClient: async (_route, body) => {
      submissions += 1;
      canonical = structuredClone(body.runnerReceipt);
      if (rejectSubmission) throw Object.assign(new Error('issuer temporarily refused the completed receipt'),
        { code: 'VERIFY_ACCEPTANCE_ISSUER_REJECTED' });
      return { accepted: true };
    },
  });
  t.after(async () => {
    await Promise.all([...runner.backgroundJobs.values()].map(job => job.completion));
    await rm(root, { recursive: true, force: true });
  });
  const admission = await runner.admit('task-one', ['frontend-admin-build']);
  const request = { taskId: 'task-one', acceptanceContractId: 'd'.repeat(64), action: 'run',
    profile: 'frontend-admin-build', selectors: {}, admissionId: admission.admissionId,
    idempotencyKey: 'background-issuer-recovery', executionMode: 'background' };
  const accepted = await runner.execute(request);
  await runner.backgroundJobs.get(accepted.jobId)?.completion;
  const failed = await runner.status('task-one', accepted.jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'VERIFY_ACCEPTANCE_ISSUER_REJECTED');
  const receiptFile = path.join(runner.stateRoot, 'receipts', 'task-one', `${failed.receiptId}.json`);
  const receiptBytes = await readFile(receiptFile);
  const logBytes = await readFile(canonical.logs.path);
  const jobBytes = await readFile(path.join(runner.stateRoot, 'verification-jobs', 'task-one', `${failed.jobId}.json`));
  assert.equal(JSON.parse(receiptBytes).status, 'passed');
  assert.equal(commands, 2);
  await assert.rejects(runner.execute(request), { code: 'VERIFY_ACCEPTANCE_ISSUER_REJECTED' });
  assert.equal(submissions, 2, 'a repeated background submission must reach the issuer again');
  assert.equal(commands, 2, 'an unchanged refusal cannot rerun checks');
  rejectSubmission = false;
  const recovered = await runner.execute(request);
  assert.equal(recovered.receiptType, 'forge-verify/host-run');
  assert.equal(recovered.receiptId, failed.receiptId);
  assert.equal(recovered.status, 'passed');
  validateHostRunReceipt(recovered);
  assert.equal(submissions, 3);
  assert.equal(commands, 2);
  assert.deepEqual(canonical, JSON.parse(receiptBytes));
  assert.deepEqual(await readFile(receiptFile), receiptBytes);
  assert.deepEqual(await readFile(canonical.logs.path), logBytes);
  assert.deepEqual(await readFile(path.join(runner.stateRoot, 'verification-jobs', 'task-one', `${failed.jobId}.json`)), jobBytes);
  const idempotencyRoot = path.join(runner.stateRoot, 'idempotency');
  const retained = await readdir(idempotencyRoot);
  assert.equal(retained.length, 1);
  await rm(path.join(idempotencyRoot, retained[0]));
  await assert.rejects(runner.execute(request), { code: 'VERIFY_RECEIPT_NOT_FOUND' });
  assert.equal(commands, 2, 'missing recovery state must never fall through to a new execution');
  assert.equal(submissions, 3);
});

test('Host preserves the original execution error when terminal state persistence fails', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-terminal-write-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  const blockedTaskPath = path.join(currentContract.stateRoot, 'verification-jobs', 'task-one');
  await mkdir(path.dirname(blockedTaskPath), { recursive: true });
  await writeFile(blockedTaskPath, 'ordinary-file-blocking-job-records');
  const originalFailure = Object.assign(new Error('Verification request was cancelled before command returned.'), {
    code: 'VERIFY_REQUEST_CANCELLED',
  });
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async () => { throw originalFailure; },
  });
  const admission = await runner.admit('task-one', ['frontend-admin-build']);
  await assert.rejects(runner.execute({ taskId: 'task-one', action: 'run', profile: 'frontend-admin-build', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'terminal-write-failure' }), (error) => {
    assert.equal(error, originalFailure, 'record write failure must not replace the original exception');
    assert.equal(error.code, 'VERIFY_REQUEST_CANCELLED');
    assert.match(error.message, /cancelled before command returned/u);
    assert.match(error.message, /Failure status could not be persisted/u);
    return true;
  });
  const jobId = failedHostJobId(originalFailure);
  assert.equal(await readFile(blockedTaskPath, 'utf8'), 'ordinary-file-blocking-job-records');
  assert.equal(runner.activeByTask.size, 0);
  await assert.rejects(access(path.join(runner.stateRoot, 'taskspaces', 'task-one', 'jobs', jobId)), { code: 'ENOENT' });
  await assert.rejects(access(path.join(runner.stateRoot, 'receipts', 'task-one')), { code: 'ENOENT' });
});

function failedHostJobId(error) {
  const match = error.message.match(/Host job ([0-9a-f-]{36}); inspect it with forge-verify status --job-id \1\./u);
  assert.ok(match, 'the run error must identify the failed job and its supported status command');
  return match[1];
}

function contract(root, projectSlug = 'forge-host') {
  const executable = path.resolve(process.execPath);
  return {
    schemaVersion: 2,
    executionMode: 'host-toolchain',
    projectSlug,
    runnerRevision: 'vpn72-host-runner-1',
    profileCatalogVersion: '2026.09.01.6',
    taskspacesRoot: path.join(root, 'taskspaces'),
    stateRoot: path.join(root, 'state'),
    toolchains: {
      java: executable,
      javaHome: path.dirname(executable),
      maven: executable,
      node: executable,
      pnpm: executable,
      git: executable,
      forgeGovernance: executable,
    },
    profiles: [...VERIFY_PROFILE_NAMES],
    limits: {
      maxFiles: 1000,
      maxBytes: 32 * 1024 * 1024,
      maxLogBytes: 1024 * 1024,
      defaultTimeoutSeconds: 30,
      maxConcurrent: 2,
    },
  };
}

function toolchainIdentity(currentContract, suffix = '') {
  const executables = {};
  for (const name of ['java', 'maven', 'node', 'pnpm', 'git', 'forgeGovernance']) {
    executables[name] = {
      configuredPath: currentContract.toolchains[name],
      resolvedPath: currentContract.toolchains[name],
      bytes: 100,
      modifiedMs: 1,
      version: `${name}-version-1${suffix}`,
    };
  }
  const descriptor = { javaHome: currentContract.toolchains.javaHome, executables };
  return { ...descriptor, digest: crypto.createHash('sha256').update(JSON.stringify(descriptor)).digest('hex') };
}

async function fixture(root, taskId = 'task-one') {
  const workspace = path.join(root, 'taskspaces', taskId, 'workspace');
  await mkdir(path.join(workspace, '.git'), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(path.join(root, 'taskspaces', taskId, 'metadata.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectSlug: 'forge-host',
    taskId,
    actorId: 'actor-one',
    conversationId: `conversation-${taskId}`,
    branch: `task/actor-one/${taskId}`,
    baseCommit: 'b'.repeat(40),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    accessTokenHash: 'a'.repeat(64),
    harnessPort: 30001,
    accessMode: 'conversation',
  }, null, 2)}\n`);
  return workspace;
}

test('Host workflow inventory records the method output with its execution and immutable log', async t => {
  const observation = {
    schemaVersion: 1, observationType: 'forge-workflow/engine-inventory-observation',
    capturedAt: null,
    definition: { processKey: 'inventory-test', definitionId: 'inventory-test:1:abc', version: 1,
      bpmnSha256: `sha256:${'a'.repeat(64)}`, nodeKeys: ['approval', 'end', 'start'] },
    instances: [{ instanceId: 'instance-one', definitionId: 'inventory-test:1:abc', definitionVersion: 1,
      businessKey: 'inventory:one', currentNodeKey: 'approval', state: 'active' }],
  };
  const marker = () => {
    observation.capturedAt = new Date().toISOString();
    return `FORGE_WORKFLOW_INVENTORY_V1:${Buffer.from(JSON.stringify(observation)).toString('base64')}\n`;
  };
  const f = await hostReceiptReuseFixture(t, 'backend-test-class',
    { modules: ['forge-server/example'], tests: ['example.InventoryTest#observesInventory'] },
    'm2', false, undefined, '', marker);
  assert.deepEqual(f.original.workflowInventoryObservation, observation);
  validateHostRunReceipt(f.original);
  const log = await readFile(f.original.logs.path, 'utf8');
  assert.equal(log.split('\n').filter(line => line.startsWith('FORGE_WORKFLOW_INVENTORY_V1:')).length, 1);
  assert.equal(crypto.createHash('sha256').update(log).digest('hex'), f.original.logs.sha256);
  assert.ok(f.original.execution.startedAt <= observation.capturedAt);
  assert.ok(observation.capturedAt <= f.original.execution.finishedAt);
  assert.equal(Object.hasOwn(f.original.workflowInventoryObservation, 'protected'), false);
});

test('Host workflow inventory rejects ambiguous output before issuing a receipt', async t => {
  await assert.rejects(hostReceiptReuseFixture(t, 'backend-test-class',
    { modules: ['forge-server/example'], tests: ['example.InventoryTest#observesInventory'] },
    'm2', false, undefined, '', () => 'FORGE_WORKFLOW_INVENTORY_V1:e30=\nFORGE_WORKFLOW_INVENTORY_V1:e30=\n'),
  { code: 'INVENTORY_OBSERVATION_INVALID' });
});

async function hostReceiptReuseFixture(t, profile = 'frontend-admin-build', selectors = {}, preparedProject, legacyStrictLint = false, sourceState, governanceOutput = '', backendOutput, reportFixture = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = sourceState ?? inventoryState();
  const routes = [];
  let commands = 0;
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: async () => {
      const inventory = await state.inventory();
      const files = profile === 'frontend-admin-typecheck' || (profile === 'frontend-admin-lint' && selectors.files === undefined)
        ? ['forge-admin-ui/src/example.ts'] : selectors.files;
      return ['frontend-admin-lint', 'frontend-admin-typecheck'].includes(profile) ? { ...inventory,
        files: files.map(relative => ({ relative, deleted: false })), fileCount: files.length } : inventory;
    }, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async (_executable, argv, options) => {
      if (argv.includes('diff')) return result({ stdout: (profile === 'frontend-admin-typecheck'
        ? ['forge-admin-ui/src/example.ts'] : selectors.files ?? (profile === 'frontend-admin-lint' ? ['forge-admin-ui/src/example.ts'] : [])).join('\0') + '\0' });
      if (argv.includes('ls-files')) return result();
      if (argv[0] === 'ls-tree') return result();
      // Model the old Host's strict invocation at the fixture command boundary,
      // so its original receipt and log retain the same actual command facts.
      if (legacyStrictLint && argv[0] === 'exec' && argv[1] === 'eslint' && argv.includes('--rule')) {
        assert.deepEqual(argv.slice(-LINT_FORMAT_ARGS.length), LINT_FORMAT_ARGS);
        argv.splice(-LINT_FORMAT_ARGS.length);
      }
      commands += 1;
      const output = argv.find((value) => value.startsWith('--outputFile='));
      if (output) {
        await writeFile(output.slice('--outputFile='.length), JSON.stringify({
          numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
          testResults: [{ assertionResults: [{ status: 'passed', fullName: 'isolated technical test' }] }],
        }));
      }
      if (preparedProject === 'm2' && argv.at(-1) === 'test') {
        const reports = path.join(options.cwd, 'target', 'surefire-reports');
        await mkdir(reports, { recursive: true });
        await writeFile(path.join(reports, 'TEST-example.xml'),
          reportFixture.xml ?? '<testsuite tests="1" failures="0" errors="0" skipped="0"></testsuite>');
      }
      return result({ stdout: profile === 'governance' ? governanceOutput
        : backendOutput && argv.at(-1) === 'test' ? backendOutput() : '' });
    },
    acceptanceIssuerClient: async (route, body) => {
      routes.push({ route, body });
      if (route === '/v1/candidate-bindings') {
        const inventory = await state.inventory();
        return { acceptanceContract: {
          contractId: body.contractId, projectSlug: 'forge-host', taskId: 'task-one',
          candidate: { source: { head: inventory.head, fingerprint: inventory.workspaceFingerprint } },
        } };
      }
      return { accepted: true };
    },
  });
  if (preparedProject) {
    // Supply the preparation result; run() must itself produce the canonical
    // skipped-install/offline execution, rather than hand-editing a receipt.
    const prepareJob = runner.prepareJob.bind(runner);
    runner.prepareJob = async (...args) => {
      const job = await prepareJob(...args);
      job.readOnlyDependencies.push({ project: preparedProject, root: path.join(root, 'protected-dependencies', preparedProject) });
      return job;
    };
  }
  const firstAdmission = await runner.admit('task-one', [profile]);
  const original = await runner.execute({
    taskId: 'task-one', acceptanceContractId: 'd'.repeat(64),
    action: 'run', profile, selectors, admissionId: firstAdmission.admissionId,
    idempotencyKey: 'original-host-execution',
  });
  assert.equal(original.status, reportFixture.expectedStatus ?? 'passed');
  const receiptFile = path.join(runner.stateRoot, 'receipts', 'task-one', `${original.receiptId}.json`);
  const originalBytes = await readFile(receiptFile);
  const admission = await runner.admit('task-one', [profile]);
  return {
    runner, state, currentContract, original, originalBytes, receiptFile, admission, routes,
    commands: () => commands,
    request: {
      taskId: 'task-one', acceptanceContractId: 'f'.repeat(64),
      candidateBinding: { contractId: 'f'.repeat(64), rpcId: 'rpc:writer:revalidate' },
      action: 'run', profile, selectors, admissionId: admission.admissionId,
      receiptId: original.receiptId, idempotencyKey: 'explicit-revalidation',
    },
  };
}

function inventoryState() {
  let head = 'b'.repeat(40);
  let fingerprint = 'a'.repeat(64);
  return {
    setHead(value) { head = value; },
    setFingerprint(value) { fingerprint = value; },
    async inventory() {
      return {
        head,
        fileCount: 0,
        bytes: 0,
        files: [],
        workspaceFingerprint: fingerprint,
        dependencyManifestFingerprint: 'c'.repeat(64),
        dependencyManifestFiles: [],
      };
    },
  };
}

function typecheckInventoryState() {
  const state = inventoryState();
  return { ...state, inventory: async () => ({ ...await state.inventory(), fileCount: 1,
    files: [{ relative: 'forge-admin-ui/src/example.ts', deleted: false }] }) };
}

async function snapshot(_source, snapshotRoot) {
  await mkdir(path.join(snapshotRoot, 'forge-server'), { recursive: true });
  await mkdir(path.join(snapshotRoot, 'forge-admin-ui'), { recursive: true });
  await mkdir(path.join(snapshotRoot, 'forge-h5-ui'), { recursive: true });
}

function result(overrides = {}) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: '',
    bytes: 0,
    truncated: false,
    processEnded: true,
    ...overrides,
  };
}

test('optional backend source quality keeps scope and real exit status in a retained Host receipt', async t => {
  const selected = 'forge-server/example/src/main/java/Example.java';
  assert.deepEqual(sourceQualitySelectors({ files: [selected] }), { files: [selected] });
  assert.throws(() => sourceQualitySelectors({ files: ['forge-server/../outside.java'] }));
  assert.throws(() => sourceQualitySelectors({ files: ['forge-server/example/target/Example.java'] }));
  assert.throws(() => sourceQualitySelectors({ modules: ['forge-server/example'] }));
  assert.equal(VERIFY_PROFILE_NAMES.includes(SOURCE_QUALITY_PROFILE), false);
  for (const [status, exitCode] of [['passed', 0], ['findings', 1], ['error', 2]]) {
    await t.test(status, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'forge-source-quality-'));
      try {
        await fixture(root);
        const current = validateHostVerificationContract(contract(root));
        const state = inventoryState();
        const report = { schemaVersion: 1, mode: 'fast', bundleSha256: SOURCE_QUALITY_BUNDLE_SHA256,
          status, files: [{ path: selected, sha256: 'd'.repeat(64) }],
          findings: status === 'findings' ? [{ tool: 'pmd', rule: 'GodClass', reviewKind: 'structure', path: selected }] : [],
          errors: status === 'error' ? ['scanner unavailable'] : [] };
        let commands = 0;
        const runner = new HostVerificationRunner({ projectSlug: 'forge-host', contract: current,
          inventory: state.inventory, snapshot, runnerBootId: 'source-quality-boot',
          toolchainProbe: async () => toolchainIdentity(current),
          command: async (_executable, argv) => {
            commands += 1;
            assert.equal(argv[0].endsWith('forge-backend-source-quality-runner.mjs'), true);
            assert.deepEqual(argv.slice(-2), ['--file', selected]);
            const output = argv[argv.indexOf('--output') + 1];
            await mkdir(output, { recursive: true });
            await writeFile(path.join(output, 'result.json'), JSON.stringify(report));
            return result({ exitCode });
          },
        });
        const admission = await runner.admit('task-one', ['governance']);
        const receipt = await runner.run('task-one', { action: 'run', profile: SOURCE_QUALITY_PROFILE,
          selectors: { files: [selected] }, admissionId: admission.admissionId,
          idempotencyKey: `quality-${status}-001` });
        assert.equal(commands, 1);
        assert.equal(receipt.status, exitCode === 0 ? 'passed' : 'failed');
        assert.equal(receipt.execution.exitCode, exitCode);
        assert.equal(receipt.sourceQuality.report.status, status);
        assert.equal(receipt.results.executed, 0);
        validateHostRunReceipt(receipt);
        const retained = await runner.receipt('task-one', receipt.receiptId);
        assert.deepEqual(retained.sourceQuality, receipt.sourceQuality);
        const forged = structuredClone(receipt);
        forged.sourceQuality.report.status = status === 'passed' ? 'findings' : 'passed';
        assert.throws(() => validateHostRunReceipt(forged));
        const issuers = [];
        runner.acceptanceIssuerClient = async (...args) => issuers.push(args);
        await runner.submitProtectedAcceptance('task-one', 'a'.repeat(64), receipt);
        assert.equal(issuers.length, 0);
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});

test('foreground lint terminal status recovers its existing receipt by jobId without rerunning or weakening freshness', async t => {
  const context = await hostReceiptReuseFixture(t, 'frontend-admin-lint');
  const { runner, state, original, receiptFile, originalBytes } = context;
  const jobFile = path.join(runner.stateRoot, 'verification-jobs', 'task-one', `${original.jobId}.json`);
  await assert.rejects(access(jobFile), { code: 'ENOENT' });
  const commands = context.commands();
  const terminal = await runner.status('task-one', original.jobId);
  assert.equal(terminal.active, false);
  assert.equal(terminal.status, 'passed');
  assert.equal(terminal.receiptId, original.receiptId);
  assert.equal(terminal.freshness, 'current');
  assert.equal(terminal.finishedAt, original.execution.finishedAt);
  assert.equal(terminal.truth.verificationProven, false, 'status points to the formal receipt');
  assert.equal((await runner.receipt('task-one', terminal.receiptId)).freshness, 'current');
  const otherRoot = path.join(runner.stateRoot, 'receipts', 'task-two');
  await mkdir(otherRoot, { recursive: true });
  await writeFile(path.join(otherRoot, `${original.receiptId}.json`), originalBytes);
  assert.deepEqual(await runner.status('task-two', original.jobId), { active: false, jobId: original.jobId });
  state.setFingerprint('f'.repeat(64));
  const stale = await runner.status('task-one', original.jobId);
  assert.equal(stale.receiptId, original.receiptId);
  assert.equal(stale.freshness, 'stale', 'historical pass must not become current proof');
  assert.equal(context.commands(), commands, 'status and receipt reads never execute lint again');
  assert.deepEqual(await readFile(receiptFile), originalBytes);
  await assert.rejects(access(jobFile), { code: 'ENOENT' });
});

test('background verification survives submission disconnect and duplicate submissions share one real execution', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-background-'));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  let commands = 0;
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async (_executable, _argv, options) => {
      commands += 1;
      started();
      await held;
      assert.equal(options.signal.aborted, false, 'the submission socket does not own the Host job');
      return result();
    },
  });
  t.after(async () => { release(); await Promise.all([...runner.backgroundJobs.values()].map((job) => job.completion)); await rm(root, { recursive: true, force: true }); });
  const admission = await runner.admit('task-one', ['frontend-admin-build']);
  const request = { taskId: 'task-one', action: 'run', profile: 'frontend-admin-build', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'background-build-one', executionMode: 'background' };
  const connection = new AbortController();
  const [accepted, duplicate] = await Promise.all([
    runner.execute(request, { signal: connection.signal }), runner.execute(request),
  ]);
  assert.equal(accepted.jobId, duplicate.jobId);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.truth.verificationProven, false);
  connection.abort();
  await running;
  assert.equal((await runner.status('task-one', accepted.jobId)).active, true);
  assert.deepEqual(await runner.status('task-two', accepted.jobId), { active: false, jobId: accepted.jobId });
  const commandsBeforeBusy = commands;
  const { executionMode: _mode, ...foregroundRequest } = request;
  for (const busyRequest of [
    { ...request, idempotencyKey: 'another-build-key' },
    { ...foregroundRequest, idempotencyKey: 'foreground-build-key' },
  ]) {
    await assert.rejects(runner.execute(busyRequest), (error) => {
      assert.equal(error.code, 'VERIFY_TASK_BUSY');
      assert.ok(error.message.includes(accepted.jobId), 'busy response must identify the existing job');
      assert.ok(error.message.includes(`forge-verify status --job-id ${accepted.jobId}`));
      return true;
    });
    assert.equal(commands, commandsBeforeBusy, 'busy requests must not start another execution');
  }
  const completion = runner.backgroundJobs.get(accepted.jobId).completion;
  const waiting = runner.status('task-one', accepted.jobId, 60);
  release();
  await completion;
  const finished = await waiting;
  assert.equal(finished.active, false);
  assert.equal(finished.status, 'passed');
  assert.equal(finished.truth.verificationProven, false, 'job status alone is not a signed verification receipt');
  const receipt = await runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: finished.receiptId });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.freshness, 'current');
  validateHostRunReceipt(receipt);
  assert.equal(commands, 2, 'one build with its two fixed steps');
  assert.equal((await runner.execute(request)).jobId, accepted.jobId);
  assert.equal(commands, 2, 'a repeated completed submission never executes again');
});

test('background backend checks preserve selectors, job identity and real reports after client disconnect', async (t) => {
  for (const profile of ['backend-module-test', 'backend-test-class']) {
    await t.test(profile, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'forge-background-backend-'));
      await fixture(root);
      const currentContract = validateHostVerificationContract(contract(root));
      const state = inventoryState();
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      let executions = 0;
      let acceptanceCalls = 0;
      const focused = profile === 'backend-test-class';
      const selectors = { modules: ['forge-server/example'], ...(focused ? { tests: ['ExampleTest'] } : {}) };
      const runner = new HostVerificationRunner({
        projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
        toolchainProbe: async () => toolchainIdentity(currentContract),
        acceptanceIssuerClient: async (route, input) => {
          assert.equal(route, '/v1/verification');
          assert.equal(input.runnerReceipt.request.profile, profile, 'issuer receives the actual class or module profile');
          acceptanceCalls += 1;
        },
        command: async (_executable, argv, options) => {
          executions += 1;
          await held;
          assert.equal(options.signal.aborted, false);
          assert.equal(argv.includes('-Dtest=ExampleTest'), focused);
          const reports = path.join(options.cwd, 'target', 'surefire-reports');
          await mkdir(reports, { recursive: true });
          await writeFile(path.join(reports, 'TEST-ExampleTest.xml'),
            `<testsuite tests="1" failures="${focused ? 1 : 0}" errors="0" skipped="0"></testsuite>`);
          return result({ exitCode: focused ? 1 : 0, stderr: focused ? 'expected behavior is absent' : '' });
        },
      });
      t.after(async () => {
        release();
        await Promise.all([...runner.backgroundJobs.values()].map((job) => job.completion));
        await rm(root, { recursive: true, force: true });
      });
      const admission = await runner.admit('task-one', [profile]);
      const request = { taskId: 'task-one', action: 'run', profile, selectors, acceptanceContractId: 'd'.repeat(64),
        admissionId: admission.admissionId, idempotencyKey: `backend-${profile}`, executionMode: 'background' };
      const connection = new AbortController();
      const accepted = await runner.execute(request, { signal: connection.signal });
      connection.abort();
      assert.equal(accepted.status, 'accepted');
      assert.equal((await runner.execute(request)).jobId, accepted.jobId);
      assert.equal((await runner.status('task-one', accepted.jobId)).active, true);
      assert.deepEqual(await runner.status('task-two', accepted.jobId), { active: false, jobId: accepted.jobId });
      const completion = runner.backgroundJobs.get(accepted.jobId).completion;
      release();
      await completion;
      const terminal = await runner.status('task-one', accepted.jobId);
      const receipt = await runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: terminal.receiptId });
      validateHostRunReceipt(receipt);
      assert.equal(receipt.status, focused ? 'failed' : 'passed');
      assert.equal(receipt.results.executed, 1);
      assert.deepEqual(receipt.request.selectors, selectors);
      assert.equal((await runner.execute(request)).jobId, accepted.jobId);
      assert.equal(executions, 1);
      assert.equal(acceptanceCalls, 1);
    });
  }
});

test('TODO-080 live process counters preserve raw buffers and withhold split secrets and UTF8 text', async () => {
  const chunks = ['token=split-', 'secret\n中文\n', 'unterminated-private-value'];
  const code = `const chunks=${JSON.stringify(chunks)}; process.stdout.write(chunks[0]); setTimeout(()=>process.stdout.write(chunks[1]),20); setTimeout(()=>process.stderr.write(chunks[2]),40);`;
  for (const maximum of [4096, 8]) {
    const updates = [];
    const value = await runHostProcess(process.execPath, ['-e', code], {
      env: process.env, maxOutputBytes: maximum, timeoutSeconds: 5,
      onOutputProgress: update => updates.push(update),
    });
    assert.equal(value.exitCode, 0);
    assert.ok(updates.length >= 2);
    assert.equal(updates.at(-1).observedBytes, Buffer.byteLength(chunks.join('')));
    assert.equal(updates.at(-1).capturedBytes, Math.min(maximum, Buffer.byteLength(chunks.join(''))));
    assert.equal(updates.at(-1).truncated, maximum === 8);
    assert.deepEqual(Object.keys(updates[0]).sort(), ['capturedBytes', 'observedBytes', 'truncated']);
    assert.doesNotMatch(JSON.stringify(updates), /split|secret|中文|private/u);
    assert.equal(value.stdout, maximum === 8 ? 'token=sp' : chunks[0] + chunks[1]);
    assert.equal(value.stderr, maximum === 8 ? '' : chunks[2]);
  }
});

test('TODO-080 same-job status exposes nonterminal counters and preserves final receipt logs', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-live-output-'));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  const finishFile = path.join(root, 'finish');
  let notify;
  const observed = new Promise(resolve => { notify = resolve; });
  const raw = 'password=private-value\n中文构建输出\n';
  let executionResult;
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async (_executable, argv, options) => {
      if (!argv.includes('build')) return result();
      executionResult = await runHostProcess(process.execPath, ['-e',
        `const fs=require('node:fs');process.stdout.write(${JSON.stringify(raw)});const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finishFile)})){clearInterval(timer);process.stderr.write('done\\n');}},10);`], {
        ...options, onOutputProgress: update => { options.onOutputProgress(update); notify(); },
      });
      return executionResult;
    },
  });
  t.after(async () => {
    await writeFile(finishFile, 'finish');
    await Promise.all([...runner.backgroundJobs.values()].map(job => job.completion));
    await rm(root, { recursive: true, force: true });
  });
  const admission = await runner.admit('task-one', ['frontend-admin-build']);
  const accepted = await runner.execute({ taskId: 'task-one', action: 'run', profile: 'frontend-admin-build',
    admissionId: admission.admissionId, idempotencyKey: 'live-output-fixture', executionMode: 'background' });
  await observed;
  const live = await runner.status('task-one', accepted.jobId);
  assert.equal(live.active, true);
  assert.equal(live.status, 'accepted');
  assert.equal(live.truth.verificationProven, false);
  assert.equal(live.progress.phase, 'frontend-admin-build');
  assert.equal(live.progress.output.observedBytes, Buffer.byteLength(raw));
  assert.equal(live.progress.output.capturedBytes, Buffer.byteLength(raw));
  assert.equal(live.progress.output.contentWithheld, true);
  assert.equal(live.progress.output.untrusted, true);
  assert.equal(live.progress.output.verificationProven, false);
  assert.doesNotMatch(JSON.stringify(live), /private-value|中文构建输出/u);
  assert.deepEqual(await runner.status('task-two', accepted.jobId), { active: false, jobId: accepted.jobId });
  await writeFile(finishFile, 'finish');
  await runner.backgroundJobs.get(accepted.jobId).completion;
  const terminal = await runner.status('task-one', accepted.jobId);
  assert.equal(terminal.active, false);
  const receipt = await runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: accepted.receiptId });
  validateHostRunReceipt(receipt);
  assert.equal(receipt.status, 'passed');
  assert.equal(executionResult.stdout, raw);
  assert.equal(executionResult.stderr, 'done\n');
  const log = await readFile(receipt.logs.path);
  assert.equal(crypto.createHash('sha256').update(log).digest('hex'), receipt.logs.sha256);
  assert.equal(log.length, receipt.logs.bytes);
  assert.match(log.toString('utf8'), /password=\[REDACTED\]/u);
  assert.match(log.toString('utf8'), /中文构建输出/u);
  assert.doesNotMatch(log.toString('utf8'), /private-value/u);
});

test('background frontend tests retain selectors and real report outcomes after client disconnect', async (t) => {
  for (const scenario of ['full', 'selected', 'zero-tests']) {
    await t.test(scenario, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'forge-background-test-'));
      await fixture(root);
      const currentContract = validateHostVerificationContract(contract(root));
      const state = inventoryState();
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const selectors = scenario === 'selected' ? { testFiles: ['forge-admin-ui/src/example.test.js'] } : {};
      let testCommands = 0;
      const runner = new HostVerificationRunner({
        projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
        toolchainProbe: async () => toolchainIdentity(currentContract),
        command: async (_executable, argv, options) => {
          await held;
          assert.equal(options.signal.aborted, false);
          if (argv[0] !== 'test') return result();
          testCommands += 1;
          for (const name of ['VITEST_MAX_THREADS', 'VITEST_MIN_THREADS', 'VITEST_MAX_FORKS', 'VITEST_MIN_FORKS']) {
            assert.equal(options.env[name], '1', 'the actual test process must receive the Host worker bound');
          }
          if (scenario === 'selected') assert.ok(argv.includes('src/example.test.js'));
          if (scenario !== 'zero-tests') {
            const outputFile = argv.find((value) => value.startsWith('--outputFile=')).slice('--outputFile='.length);
            await writeFile(outputFile, JSON.stringify({ numTotalTests: 1, numPassedTests: 1,
              numFailedTests: 0, numPendingTests: 0, testResults: [{ name: path.join(options.cwd, 'src/example.test.js'),
                assertionResults: [{ status: 'passed', fullName: 'selected behavior', failureMessages: [] }] }] }));
          }
          return result();
        },
      });
      t.after(async () => { release(); await Promise.all([...runner.backgroundJobs.values()].map((job) => job.completion)); await rm(root, { recursive: true, force: true }); });
      const admission = await runner.admit('task-one', ['frontend-admin-test']);
      const request = { taskId: 'task-one', action: 'run', profile: 'frontend-admin-test', selectors,
        admissionId: admission.admissionId, idempotencyKey: `background-test-${scenario}`, executionMode: 'background' };
      const connection = new AbortController();
      const accepted = await runner.execute(request, { signal: connection.signal });
      connection.abort();
      assert.equal(accepted.truth.verificationProven, false);
      assert.equal((await runner.execute(request)).jobId, accepted.jobId);
      const completion = runner.backgroundJobs.get(accepted.jobId).completion;
      release();
      await completion;
      const receipt = await runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: accepted.receiptId });
      validateHostRunReceipt(receipt);
      assert.deepEqual(receipt.request.selectors, selectors);
      assert.equal(receipt.status, 'passed');
      assert.equal(receipt.truth.verificationProven, true);
      if (scenario === 'zero-tests') assert.equal(receipt.results.executed, 0);
      assert.equal(testCommands, 1);
    });
  }
});

test('background failures, timeout, cancellation and source drift remain queryable without inventing receipts', async (t) => {
  for (const scenario of ['failed', 'timed-out', 'cancelled', 'source-changed', 'stale-admission']) {
    await t.test(scenario, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'forge-background-result-'));
      await fixture(root);
      t.after(() => rm(root, { recursive: true, force: true }));
      const currentContract = validateHostVerificationContract(contract(root));
      const state = inventoryState();
      const runner = new HostVerificationRunner({
        projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
        toolchainProbe: async () => toolchainIdentity(currentContract),
        command: async () => {
          if (scenario === 'cancelled') throw Object.assign(new Error('Verification request was cancelled.'), { code: 'VERIFY_REQUEST_CANCELLED' });
          if (scenario === 'source-changed') state.setFingerprint('e'.repeat(64));
          return result({ exitCode: scenario === 'failed' ? 1 : 0, timedOut: scenario === 'timed-out', stderr: 'bounded execution diagnostic' });
        },
      });
      const admission = await runner.admit('task-one', ['frontend-admin-build']);
      if (scenario === 'stale-admission') state.setFingerprint('f'.repeat(64));
      const accepted = await runner.execute({ taskId: 'task-one', action: 'run', profile: 'frontend-admin-build', selectors: {},
        admissionId: admission.admissionId, idempotencyKey: `background-${scenario}`, executionMode: 'background' });
      await runner.backgroundJobs.get(accepted.jobId)?.completion;
      const status = await runner.status('task-one', accepted.jobId);
      assert.equal(status.active, false);
      assert.equal(status.truth.verificationProven, false);
      assert.equal(status.status, ['source-changed', 'stale-admission'].includes(scenario) ? 'failed' : scenario);
      if (['failed', 'timed-out'].includes(scenario)) {
        const receipt = await runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: status.receiptId, includeDiagnostics: true });
        assert.equal(receipt.status, scenario);
        assert.match(receipt.logs.excerpt, /bounded execution diagnostic/u);
      } else {
        assert.ok(status.error.code);
        assert.match(status.diagnostic.message, new RegExp(status.error.code, 'u'));
        assert.equal(status.diagnostic.executionProven, false);
        assert.equal(status.diagnostic.verificationProven, false);
        assert.ok(Buffer.byteLength(status.diagnostic.message, 'utf8') <= 2000);
        if (scenario === 'source-changed') {
          assert.match(status.diagnostic.message, /bounded execution diagnostic/u,
            'a later source rejection must preserve output from completed commands');
        }
        await assert.rejects(runner.receipt('task-one', status.receiptId), { code: 'VERIFY_RECEIPT_NOT_FOUND' });
      }
    });
  }
});

test('a restarted Host reports an interrupted background job and never replays it automatically', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-background-restart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const currentContract = validateHostVerificationContract(contract(root));
  const runner = new HostVerificationRunner({ projectSlug: 'forge-host', contract: currentContract });
  const jobId = crypto.randomUUID();
  const dir = path.join(runner.stateRoot, 'verification-jobs', 'task-one');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${jobId}.json`), JSON.stringify({ schemaVersion: 1, receiptType: 'forge-verify/host-job',
    taskId: 'task-one', jobId, status: 'accepted', runnerBootId: 'previous-boot',
    truth: { executionProven: false, verificationProven: false, releaseProven: false } }));
  const status = await runner.status('task-one', jobId);
  assert.equal(status.status, 'interrupted');
  assert.equal(status.active, false);
  assert.equal(status.error.code, 'VERIFY_JOB_INTERRUPTED');
  assert.equal(runner.activeByTask.size, 0);
});

async function vitestFailureFixture(root, options = {}) {
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  const acceptanceBodies = [];
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host',
    contract: currentContract,
    inventory: state.inventory,
    snapshot,
    command: async (_executable, argv, commandOptions) => {
      if (argv[0] !== 'test') return result();
      const outputFile = argv.find((value) => value.startsWith('--outputFile=')).slice('--outputFile='.length);
      await writeFile(outputFile, `${JSON.stringify({
        numTotalTests: 925,
        numPassedTests: 923,
        numFailedTests: 2,
        numPendingTests: 0,
        testResults: [
          {
            name: path.join(commandOptions.cwd, 'src', 'first.test.js'),
            assertionResults: [{
              status: 'failed',
              fullName: `first failure ${'名'.repeat(600)}`,
              failureMessages: [`${'错'.repeat(1200)} Bearer abcdefghijklmnop \"token\":\"json-secret\"\u001b[31m\u0001`],
            }],
          },
          {
            name: path.join(commandOptions.cwd, 'src', 'second.test.js'),
            assertionResults: [{
              status: 'failed',
              fullName: 'second failure keeps its name',
              failureMessages: ['API_KEY=unsafe-api-key\r\npassword=unsafe-password'],
            }],
          },
        ],
      })}\n`);
      return result({
        exitCode: 1,
        stdout: `stdout-head ${'x'.repeat(5000)} stdout-tail ${commandOptions.cwd}\n`,
        stderr: `stderr-head ${'y'.repeat(5000)} stderr-tail token=unsafe-step-token\n`,
        truncated: true,
      });
    },
    toolchainProbe: async () => toolchainIdentity(currentContract),
    acceptanceIssuerClient: options.acceptance === true
      ? async (_route, body) => { acceptanceBodies.push(body); return { accepted: true }; }
      : null,
  });
  const admission = await runner.admit('task-one', ['frontend-admin-test']);
  return { runner, admission, acceptanceBodies };
}

test('host contract and profile plan reject dynamic command surfaces and use absolute reviewed executables', () => {
  const root = path.resolve(os.tmpdir(), 'forge-host-policy');
  const current = validateHostVerificationContract(contract(root), 'forge-host');
  assert.equal(current.executionMode, 'host-toolchain');
  assert.equal(
    hostProfilePolicyDigest(current),
    'adb49f9acca2990bdf9e656cb80c3bb927b242fd7aa28efbd6a63120a4100599',
  );
  assert.throws(() => validateHostVerificationContract({ ...contract(root), shell: '/bin/sh' }), /unsupported field/u);
  assert.throws(() => validateHostVerificationContract({ ...contract(root), profiles: ['governance'] }), /reviewed ordered/u);

  const paths = {
    snapshotRoot: path.join(root, 'workspace'),
    outputRoot: path.join(root, 'output'),
    cacheRoot: path.join(root, 'cache'),
    mavenSettings: path.join(root, 'config', 'settings.xml'),
  };
  const plan = hostVerificationCommand('backend-test-class', {
    modules: ['forge-server/forge-business/forge-business-core'],
    tests: ['com.example.ExampleTest#works'],
  }, 'd'.repeat(40), paths, current.toolchains);
  assert.equal(plan.steps[0].executable, current.toolchains.maven);
  assert.ok(plan.steps[0].argv.includes(`-Dmaven.repo.local=${path.join(root, 'cache', 'm2', 'repository')}`));
  assert.ok(plan.steps[0].argv.includes(`-Dtest=com.example.ExampleTest#works`));
  assert.ok(plan.steps[0].argv.includes('-Dsurefire.failIfNoSpecifiedTests=false'));
  for (const profile of ['backend-red-test', 'backend-module-compile', 'backend-module-test', 'backend-test-class', 'full-regression']) {
    const selectors = profile === 'full-regression' ? {} : {
      modules: ['forge-server/forge-admin-server'],
      ...(['backend-red-test', 'backend-test-class'].includes(profile) ? { tests: ['com.example.ExampleTest#works'] } : {}),
    };
    const backend = hostVerificationCommand(profile, selectors, 'd'.repeat(40), paths, current.toolchains);
    assert.deepEqual(backend.steps[0].argv.filter(arg => arg.startsWith('-P')), ['-Pdev,enable-tests']);
    assert.ok(backend.steps[0].argv.includes('-Dforge.compiler.skip=false'));
    assert.ok(backend.steps[0].argv.includes('-Dforge.tests.skip=false'));
    assert.equal(backend.steps[0].argv.includes('-DskipTests'), profile === 'backend-module-compile');
  }
  assert.equal(plan.steps[0].argv.some((value) => ['curl', 'bash', 'sh', '-c'].includes(value)), false);
  const governance = hostVerificationCommand(
    'governance', {}, 'd'.repeat(40), paths, current.toolchains, 'c'.repeat(40),
  );
  assert.deepEqual(governance.steps[0].argv, ['audit', '--base', 'c'.repeat(40)]);
  assert.throws(
    () => hostVerificationCommand('governance', {}, 'd'.repeat(40), paths, current.toolchains),
    /review base is invalid/u,
  );
  const redPlan = hostVerificationCommand('backend-red-test', {
    modules: ['forge-server/forge-business/forge-business-core'],
    tests: ['com.example.ExampleTest#failsFirst'],
  }, 'd'.repeat(40), paths, current.toolchains);
  assert.ok(redPlan.steps[0].argv.includes('-Dsurefire.failIfNoSpecifiedTests=false'));
  assert.equal(redPlan.steps[0].argv.includes('-Dsurefire.failIfNoSpecifiedTests=true'), false);
  const typecheck = hostVerificationCommand(
    'frontend-admin-typecheck', {}, 'd'.repeat(40), paths, current.toolchains,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, ['forge-admin-ui/src/example.ts'],
  );
  assert.deepEqual(typecheck.steps, [
    {
      cwd: paths.snapshotRoot,
      executable: current.toolchains.pnpm,
      argv: [
        '--dir', path.join(paths.snapshotRoot, 'forge-admin-ui'), 'install', '--frozen-lockfile', '--ignore-scripts',
        '--store-dir', path.join(paths.cacheRoot, 'pnpm', 'store'),
      ],
    },
    {
      cwd: paths.snapshotRoot,
      executable: current.toolchains.node,
      argv: [HOST_FRONTEND_TYPECHECK_PATH, '--project', 'forge-admin-ui', '--files', '["forge-admin-ui/src/example.ts"]'],
    },
  ]);
  const focusedLint = hostVerificationCommand('frontend-admin-lint', {
    files: [
      'forge-admin-ui/src/views/supplier-profile/index.vue',
      'forge-admin-ui/src/views/supplier-profile/supplier-profile-contract.js',
    ],
  }, 'd'.repeat(40), paths, current.toolchains, 'd'.repeat(40), [
    'forge-admin-ui/src/views/supplier-profile/index.vue',
    'forge-admin-ui/src/views/supplier-profile/supplier-profile-contract.js',
  ]);
  assert.deepEqual(focusedLint.steps[1].argv, [
    'exec', 'eslint',
    'src/views/supplier-profile/index.vue',
    'src/views/supplier-profile/supplier-profile-contract.js',
    '--max-warnings=0',
    ...LINT_FORMAT_ARGS,
  ]);
  const focusedTest = hostVerificationCommand('frontend-admin-test', {
    testFiles: ['forge-admin-ui/src/views/supplier-profile/__tests__/supplier-profile-contract.test.js'],
  }, 'd'.repeat(40), paths, current.toolchains);
  assert.deepEqual(focusedTest.steps[1].argv, [
    'test',
    'src/views/supplier-profile/__tests__/supplier-profile-contract.test.js',
    '--reporter=json', `--outputFile=${path.join(paths.outputRoot, 'test-results-admin.json')}`,
  ]);
  assert.throws(() => hostVerificationCommand('frontend-admin-lint', {
    files: ['forge-admin-ui/src/../package.json'],
  }, 'd'.repeat(40), paths, current.toolchains), /files are invalid/u);
  assert.throws(() => hostVerificationCommand('backend-test-class', {
    modules: ['forge-server/core;curl'], tests: ['ExampleTest'],
  }, 'd'.repeat(40), paths, current.toolchains), /modules are invalid/u);
  assert.throws(() => hostVerificationCommand(
    'governance', { base: 'a'.repeat(40) }, 'd'.repeat(40), paths, current.toolchains, 'c'.repeat(40),
  ), /unsupported field/u);
});

test('Host emits the no-change baseline only for governance at its protected task base', () => {
  const root = path.resolve(os.tmpdir(), 'forge-host-no-change-policy');
  const current = validateHostVerificationContract(contract(root), 'forge-host');
  const paths = {
    snapshotRoot: path.join(root, 'workspace'), outputRoot: path.join(root, 'output'),
    cacheRoot: path.join(root, 'cache'), mavenSettings: path.join(root, 'config', 'settings.xml'),
  };
  const head = 'd'.repeat(40);
  assert.deepEqual(hostVerificationCommand('governance', {}, head, paths, current.toolchains, head).steps[0].argv,
    ['audit', '--base', head, '--expected-no-change-head', head]);
  assert.deepEqual(hostVerificationCommand('governance', {}, head, paths, current.toolchains, 'c'.repeat(40)).steps[0].argv,
    ['audit', '--base', 'c'.repeat(40)]);
  assert.deepEqual(hostVerificationCommand('changed-safe', {}, head, paths, current.toolchains, head).steps[0].argv,
    ['audit', '--base', head]);
});

test('host governance audits a clean single-parent checkpoint against the platform TaskSpace base', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-governance-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'taskspaces', 'task-one', 'workspace');
  await mkdir(workspace, { recursive: true });
  execFileSync('git', ['init', '--quiet', workspace]);
  execFileSync('git', ['-C', workspace, 'config', 'user.name', 'Forge Test']);
  execFileSync('git', ['-C', workspace, 'config', 'user.email', 'forge-test@example.invalid']);
  await writeFile(path.join(workspace, 'README.md'), 'baseline\n');
  execFileSync('git', ['-C', workspace, 'add', 'README.md']);
  execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'baseline']);
  const reviewBase = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await mkdir(path.join(workspace, 'forge-admin-ui', 'src', 'api'), { recursive: true });
  await writeFile(path.join(workspace, 'forge-admin-ui', 'src', 'api', 'safe.js'), 'export const safe = true\n');
  execFileSync('git', ['-C', workspace, 'add', 'forge-admin-ui/src/api/safe.js']);
  execFileSync('git', ['-C', workspace, 'commit', '--quiet', '-m', 'checkpoint candidate']);
  const sourceHead = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const parents = execFileSync('git', ['-C', workspace, 'rev-list', '--parents', '-n', '1', 'HEAD'], { encoding: 'utf8' }).trim().split(' ');
  assert.deepEqual(parents, [sourceHead, reviewBase]);
  assert.equal(execFileSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  const now = new Date().toISOString();
  await writeFile(path.join(root, 'taskspaces', 'task-one', 'metadata.json'), `${JSON.stringify({
    schemaVersion: 1, projectSlug: 'forge-host', taskId: 'task-one', actorId: 'actor-one',
    conversationId: 'conversation-task-one', branch: 'task/actor-one/task-one', baseCommit: reviewBase,
    status: 'active', createdAt: now, updatedAt: now, accessTokenHash: 'a'.repeat(64),
    harnessPort: 30001, accessMode: 'conversation',
  }, null, 2)}\n`);
  const gitExecutable = (process.platform === 'win32'
    ? execFileSync('where.exe', ['git'], { encoding: 'utf8' })
    : execFileSync('which', ['git'], { encoding: 'utf8' })).trim().split(/\r?\n/u)[0];
  const currentContract = validateHostVerificationContract({
    ...contract(root),
    toolchains: { ...contract(root).toolchains, git: gitExecutable },
  });
  let governanceArgv;
  const governanceCli = path.resolve('docker/harness/forge-governance');
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async (executable, argv, options) => {
      if (executable === process.execPath && argv[0] === 'audit') {
        governanceArgv = [...argv];
        return runHostProcess(process.execPath, [governanceCli, ...argv, '--format', 'json'], options);
      }
      return runHostProcess(executable, argv, options);
    },
  });
  const admission = await runner.admit('task-one', ['governance']);
  const receipt = await runner.run('task-one', {
    action: 'run', profile: 'governance', selectors: {}, admissionId: admission.admissionId,
    idempotencyKey: 'trusted-review-base-0001',
  });
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(governanceArgv, ['audit', '--base', reviewBase]);
  assert.equal(receipt.source.head, sourceHead);
});

test('Host changed-root typecheck binds its exact scope through execution and receipt reuse', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-typecheck-roots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await fixture(root);
  const git = (...argv) => execFileSync('git', ['-C', workspace, ...argv], { encoding: 'utf8' });
  git('init', '--quiet'); git('config', 'user.name', 'Typecheck Test'); git('config', 'user.email', 'types@example.invalid');
  const src = path.join(workspace, 'forge-admin-ui/src');
  await mkdir(src, { recursive: true });
  await writeFile(path.join(src, 'untouched.vue'), '<template>untouched</template>\n');
  await writeFile(path.join(src, 'edited.vue'), '<template>before</template>\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'baseline');
  const base = git('rev-parse', 'HEAD').trim();
  const metadataPath = path.join(root, 'taskspaces/task-one/metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, baseCommit: base }));
  const gitExecutable = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/u)[0];
  const current = validateHostVerificationContract({ ...contract(root), toolchains: { ...contract(root).toolchains, git: gitExecutable } });
  const calls = [];
  const runner = new HostVerificationRunner({ projectSlug: 'forge-host', contract: current,
    toolchainProbe: async () => toolchainIdentity(current),
    command: async (executable, argv, options) => {
      if (argv[0] === '--dir' || argv[0] === HOST_FRONTEND_TYPECHECK_PATH) {
        calls.push({ executable, argv: [...argv], cwd: options.cwd, nodeOptions: options.env.NODE_OPTIONS });
        return result();
      }
      return runHostProcess(executable, argv, options);
    },
  });
  let admission = await runner.admit('task-one', ['frontend-admin-typecheck']);
  await assert.rejects(runner.run('task-one', { action: 'run', profile: 'frontend-admin-typecheck', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'empty-typecheck-roots' }), { code: 'VERIFY_TYPECHECK_EMPTY_SCOPE' });
  assert.equal(calls.length, 0);
  await writeFile(path.join(src, 'edited.vue'), '<template>after</template>\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'task checkpoint');
  for (const name of ['src/new.js', 'tests/new.ts']) {
    const file = path.join(workspace, 'forge-admin-ui', name);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'export const changed = true;\n');
  }
  const files = ['forge-admin-ui/src/edited.vue', 'forge-admin-ui/src/new.js', 'forge-admin-ui/tests/new.ts'];
  admission = await runner.admit('task-one', ['frontend-admin-typecheck']);
  const receipt = await runner.run('task-one', { action: 'run', profile: 'frontend-admin-typecheck', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'changed-typecheck-roots' });
  validateHostRunReceipt(receipt);
  assert.equal(receipt.status, 'passed');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].argv, [HOST_FRONTEND_TYPECHECK_PATH, '--project', 'forge-admin-ui', '--files', JSON.stringify(files)]);
  assert.equal(calls[1].executable, current.toolchains.node);
  assert.equal(calls[1].cwd, path.dirname(calls[0].argv[1]));
  assert.equal(calls[1].nodeOptions, '--max-old-space-size=8192');
  const receiptPath = path.join(runner.stateRoot, 'receipts/task-one', `${receipt.receiptId}.json`);
  const originalBytes = await readFile(receiptPath);
  runner.prepareJob = async () => assert.fail('reusing the same typecheck must not prepare or execute another job');
  runner.acceptanceIssuerClient = async (route, body) => route === '/v1/candidate-bindings'
    ? { acceptanceContract: { contractId: body.contractId, projectSlug: 'forge-host', taskId: 'task-one',
      candidate: { source: { head: body.admissionReceipt.source.head, fingerprint: body.admissionReceipt.source.workspaceFingerprint } } } }
    : { accepted: true };
  admission = await runner.admit('task-one', ['frontend-admin-typecheck']);
  const reused = await runner.run('task-one', { action: 'run', profile: 'frontend-admin-typecheck', selectors: {},
    admissionId: admission.admissionId, receiptId: receipt.receiptId, idempotencyKey: 'reuse-typecheck-roots' },
  { acceptanceContractId: 'd'.repeat(64), candidateBinding: { contractId: 'd'.repeat(64), rpcId: 'typecheck-reuse' } });
  validateHostRunReceipt(reused);
  assert.equal(reused.receiptId, receipt.receiptId);
  assert.equal(calls.length, 2);
  assert.deepEqual(await readFile(receiptPath), originalBytes);
});

test('Host changed-file lint observes empty scope and batches only committed and working changes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-changed-lint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await fixture(root);
  const git = (...argv) => execFileSync('git', ['-C', workspace, ...argv], { encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'user.name', 'Lint Test'); git('config', 'user.email', 'lint@example.invalid');
  const src = path.join(workspace, 'forge-admin-ui/src');
  await mkdir(src, { recursive: true });
  for (const name of ['unchanged', 'dirty', 'removed', 'rename']) await writeFile(path.join(src, `${name}.js`), 'export const value = 1;\n');
  git('add', '.'); git('commit', '--quiet', '-m', 'baseline');
  const base = git('rev-parse', 'HEAD').trim();
  const metadataPath = path.join(root, 'taskspaces/task-one/metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, baseCommit: base }));
  const gitExecutable = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/u)[0];
  const current = validateHostVerificationContract({ ...contract(root), toolchains: { ...contract(root).toolchains, git: gitExecutable } });
  const pnpmCalls = [];
  const runner = new HostVerificationRunner({ projectSlug: 'forge-host', contract: current,
    toolchainProbe: async () => toolchainIdentity(current),
    command: async (executable, argv, options) => {
      if (executable === process.execPath && ['--dir', 'exec'].includes(argv[0])) {
        pnpmCalls.push([...argv]); return result();
      }
      return runHostProcess(executable, argv, options);
    },
  });
  const prepareJob = runner.prepareJob.bind(runner);
  const preparations = [];
  runner.prepareJob = async (...args) => { preparations.push(args[4]); return prepareJob(...args); };
  const reuse = async (receipt, key) => {
    const oldPreparationCount = preparations.length;
    const oldPnpmCount = pnpmCalls.length;
    const receiptPath = path.join(runner.stateRoot, 'receipts/task-one', `${receipt.receiptId}.json`);
    const originalBytes = await readFile(receiptPath);
    runner.acceptanceIssuerClient = async (route, body) => route === '/v1/candidate-bindings'
      ? { acceptanceContract: { contractId: body.contractId, projectSlug: 'forge-host', taskId: 'task-one',
        candidate: { source: { head: body.admissionReceipt.source.head,
          fingerprint: body.admissionReceipt.source.workspaceFingerprint } } } }
      : { accepted: true };
    const admission = await runner.admit('task-one', ['frontend-admin-lint']);
    const projection = await runner.run('task-one', { action: 'run', profile: 'frontend-admin-lint', selectors: {},
      admissionId: admission.admissionId, receiptId: receipt.receiptId, idempotencyKey: key },
    { acceptanceContractId: 'd'.repeat(64), candidateBinding: { contractId: 'd'.repeat(64), rpcId: 'lint-reuse' } });
    validateHostRunReceipt(projection);
    assert.equal(projection.receiptId, receipt.receiptId);
    assert.equal(projection.revalidation.contractId, 'd'.repeat(64));
    assert.equal(preparations.length, oldPreparationCount);
    assert.equal(pnpmCalls.length, oldPnpmCount);
    assert.deepEqual(await readFile(receiptPath), originalBytes);
    runner.acceptanceIssuerClient = null;
  };
  let admission = await runner.admit('task-one', ['frontend-admin-lint']);
  const empty = await runner.run('task-one', { action: 'run', profile: 'frontend-admin-lint', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'initial-empty-lint' });
  assert.equal(empty.status, 'passed'); validateHostRunReceipt(empty);
  assert.equal(pnpmCalls.length, 0, 'initial scope neither installs nor invokes ESLint');
  assert.equal(preparations[0].seedDependencies, false);
  assert.equal(preparations[0].frontendProject, undefined);
  const log = await readFile(empty.logs.path, 'utf8');
  assert.ok(log.includes('"applicableFiles":0') && log.includes('"eslintExecuted":false'));
  await reuse(empty, 'reuse-empty-lint-scope');
  await writeFile(path.join(src, 'committed.js'), 'export const committed = true;\n');
  git('add', 'forge-admin-ui/src/committed.js'); git('commit', '--quiet', '-m', 'current task checkpoint');
  await writeFile(path.join(src, 'dirty.js'), 'export const value = 2;\n');
  await rm(path.join(src, 'removed.js'));
  await rename(path.join(src, 'rename.js'), path.join(src, 'renamed.js'));
  for (let index = 0; index < 33; index++) await writeFile(path.join(src, `new-${index}.js`), 'export const added = true;\n');
  admission = await runner.admit('task-one', ['frontend-admin-lint']);
  const changed = await runner.run('task-one', { action: 'run', profile: 'frontend-admin-lint', selectors: {},
    admissionId: admission.admissionId, idempotencyKey: 'changed-file-lint-batches' });
  assert.equal(changed.status, 'passed'); validateHostRunReceipt(changed);
  const lint = pnpmCalls.filter((argv) => argv[0] === 'exec');
  assert.deepEqual(lint.map((argv) => argv.indexOf('--max-warnings=0') - 2), [32, 4]);
  assert.ok(lint.every((argv) => JSON.stringify(argv.slice(-LINT_FORMAT_ARGS.length)) === JSON.stringify(LINT_FORMAT_ARGS)));
  const files = lint.flatMap((argv) => argv.slice(2, argv.indexOf('--max-warnings=0')));
  assert.ok(files.includes('src/committed.js') && files.includes('src/dirty.js') && files.includes('src/renamed.js'));
  assert.ok(!files.includes('.') && !files.includes('src/unchanged.js') && !files.includes('src/removed.js') && !files.includes('src/rename.js'));
  await reuse(changed, 'reuse-changed-lint-batches');
});

test('host admission binds source HEAD and TaskSpace base even when committed bytes are unchanged', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-admission-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async (_executable, argv) => {
      if (argv[0] === 'rev-parse') return result({ stdout: `${'b'.repeat(40)}\n` });
      if (argv[0] === 'merge-base') return result();
      return result();
    },
  });
  const admission = await runner.admit('task-one', ['governance']);
  state.setHead('c'.repeat(40));
  await assert.rejects(runner.run('task-one', {
    action: 'run', profile: 'governance', selectors: {}, admissionId: admission.admissionId,
    idempotencyKey: 'stale-head-same-content-0001',
  }), (error) => error.code === 'VERIFY_ADMISSION_SOURCE_CHANGED');
});

test('Host invalidates the old admission and gives fresh governance the integrated canonical review base', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-integrated-review-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  const governanceArgv = [];
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async (_executable, argv) => {
      if (argv[0] === 'audit') governanceArgv.push([...argv]);
      return result();
    },
  });
  const oldAdmission = await runner.admit('task-one', ['governance']);
  const canonicalHead = 'c'.repeat(40);
  state.setHead(canonicalHead);
  const metadataPath = path.join(root, 'taskspaces', 'task-one', 'metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  await writeFile(metadataPath, `${JSON.stringify({
    ...metadata, baseCommit: canonicalHead, updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  await assert.rejects(runner.run('task-one', {
    action: 'run', profile: 'governance', selectors: {}, admissionId: oldAdmission.admissionId,
    idempotencyKey: 'stale-pre-integration-review-base',
  }), (error) => error.code === 'VERIFY_ADMISSION_SOURCE_CHANGED');
  const freshAdmission = await runner.admit('task-one', ['governance']);
  const receipt = await runner.run('task-one', {
    action: 'run', profile: 'governance', selectors: {}, admissionId: freshAdmission.admissionId,
    idempotencyKey: 'fresh-integrated-review-base',
  });
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(governanceArgv, [['audit', '--base', canonicalHead, '--expected-no-change-head', canonicalHead]]);
  assert.equal(receipt.source.head, canonicalHead);
});

async function semanticReleaseFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-semantic-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = await fixture(root);
  const git = (...argv) => execFileSync('git', ['-C', workspace, ...argv], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Forge Test');
  git('config', 'user.email', 'forge-test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  await writeFile(path.join(workspace, 'README.md'), 'baseline\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'initial task baseline');
  const baseCommit = git('rev-parse', 'HEAD');
  const sqlPath = 'forge-server/db/migration/V1.0.1__released.sql';
  await mkdir(path.dirname(path.join(workspace, sqlPath)), { recursive: true });
  await writeFile(path.join(workspace, sqlPath), 'SELECT 1;\n');
  git('add', sqlPath);
  git('commit', '--quiet', '-m', 'published SQL');
  const releasedCommit = git('rev-parse', 'HEAD');
  const frontendPath = 'forge-admin-ui/src/views/security/components/SecurityListPage.vue';
  await mkdir(path.dirname(path.join(workspace, frontendPath)), { recursive: true });
  await writeFile(path.join(workspace, frontendPath), '<template><p>待接入</p></template>\n');
  git('add', frontendPath);
  git('commit', '--quiet', '-m', 'frontend follow-up');
  const head = git('rev-parse', 'HEAD');
  const metadataPath = path.join(root, 'taskspaces', 'task-one', 'metadata.json');
  const metadata = { ...JSON.parse(await readFile(metadataPath, 'utf8')), baseCommit };
  const release = {
    status: 'success', commit: releasedCommit,
    operationId: crypto.randomUUID(), runnerJobId: crypto.randomUUID(),
    acceptanceGateDigest: `sha256:${'d'.repeat(64)}`, completedAt: new Date().toISOString(),
  };
  const saveRelease = async (lastRelease) => writeFile(metadataPath, `${JSON.stringify({
    ...metadata, ...(lastRelease === undefined ? {} : { lastRelease }),
  })}\n`);
  await saveRelease(release);
  const gitExecutable = (process.platform === 'win32'
    ? execFileSync('where.exe', ['git'], { encoding: 'utf8' })
    : execFileSync('which', ['git'], { encoding: 'utf8' })).trim().split(/\r?\n/u)[0];
  const currentContract = validateHostVerificationContract({
    ...contract(root), processIsolation: 'bubblewrap', independentReview: 'api-error-and-auth-contract',
    toolchains: { ...contract(root).toolchains, git: gitExecutable },
  });
  const createRunner = (options = {}) => new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract,
    toolchainProbe: async () => toolchainIdentity(currentContract), ...options,
  });
  return { baseCommit, releasedCommit, head, sqlPath, frontendPath, release, saveRelease, createRunner, git };
}

test('host blocked semantic review explains receipt reuse without running checks or a reviewer', async (t) => {
  const f = await semanticReleaseFixture(t);
  let reasonCode;
  const routes = [];
  const runner = f.createRunner({
    acceptanceIssuerClient: async (route, body) => {
      routes.push(route);
      assert.equal(route, '/v1/semantic-review-context');
      assert.deepEqual(body, { taskId: 'task-one', contractId: 'a'.repeat(64) });
      return { status: 'blocked', reasonCode };
    },
    semanticReviewer: async () => assert.fail('A blocked review must not invoke a reviewer'),
  });
  runner.source = async () => assert.fail('A blocked review must not start source verification');
  runner.run = async () => assert.fail('Review guidance must not automatically run or reuse a receipt');
  for (reasonCode of ['REVIEW_SCOPE_UNSUPPORTED', 'TECHNICAL_ACCEPTANCE_INCOMPLETE']) {
    await assert.rejects(runner.reviewCandidate('task-one', 'a'.repeat(64)), error => {
      assert.equal(error.code, 'VERIFY_REVIEW_NOT_READY');
      assert.equal(error.retryable, false);
      assert.ok(error.message.includes(reasonCode));
      assert.match(error.message, /review 不是已有测试回执复核/u);
      assert.match(error.recommendedAction, /forge-verify run --profile <原profile> --admission-id <当前ID> --idempotency-key <新键> --reuse-receipt <原receiptId>/u);
      assert.match(error.recommendedAction, /保留原选择器/u);
      assert.match(error.recommendedAction, /VERIFY_RECEIPT_REUSE_INVALID/u);
      assert.match(error.recommendedAction, /只补当前范围内失效的检查/u);
      assert.match(error.recommendedAction, /后端回执可复用不代表旧治理或前端回执有效/u);
      assert.match(error.recommendedAction, /当前合同确需独审时仍须解决其真实前提/u);
      return true;
    });
    assert.equal(runner.activeByTask.size, 0, 'A rejected review must release its activity slot');
  }
  assert.deepEqual(routes, ['/v1/semantic-review-context', '/v1/semantic-review-context']);
});

test('host semantic review uses the released SQL baseline without changing ordinary source or admission', async (t) => {
  const f = await semanticReleaseFixture(t);
  let context;
  let reviewedInput;
  const routes = [];
  const runner = f.createRunner({
    acceptanceIssuerClient: async (route) => {
      routes.push(route);
      if (route === '/v1/semantic-review-context') return context;
      assert.equal(route, '/v1/semantic-review');
      return { status: 'passed', receiptId: crypto.randomUUID() };
    },
    semanticReviewer: async (input) => {
      reviewedInput = input;
      return { provider: 'fixture', model: 'fixture', providerRequestId: 'fixture-review', review: {
        decision: 'approved', summary: 'Static review fixture.',
        checks: { apiErrors: 'checked', authorization: 'checked', tenantIsolation: 'checked', changeScope: 'checked' },
        findings: [],
      } };
    },
  });
  const ordinary = await runner.source('task-one');
  assert.equal(ordinary.reviewBase, f.baseCommit);
  const admission = await runner.admit('task-one', ['governance']);
  await assert.doesNotReject(runner.validatedAdmission('task-one', 'governance', admission.admissionId, ordinary, {}));
  context = {
    status: 'ready', projectSlug: 'forge-host', taskId: 'task-one', contractId: 'a'.repeat(64),
    contractFingerprint: `sha256:${'b'.repeat(64)}`, candidateDiffSha256: `sha256:${'c'.repeat(64)}`,
    source: { head: f.head, fingerprint: ordinary.inventory.workspaceFingerprint },
    expiresAt: new Date(Date.now() + 120_000).toISOString(), reviewerId: 'fixture-reviewer',
    obligations: ['api-error-and-auth-contract'],
  };
  await runner.reviewCandidate('task-one', context.contractId);
  assert.equal(reviewedInput.reviewBase, f.releasedCommit);
  assert.deepEqual(reviewedInput.changedFiles, [f.frontendPath]);
  assert.deepEqual(reviewedInput.files.map((file) => file.path), [f.frontendPath]);
  assert.ok(reviewedInput.diff.includes(f.frontendPath));
  assert.ok(reviewedInput.diff.includes('待接入'));
  assert.equal(reviewedInput.diff.includes(f.sqlPath), false);
  assert.deepEqual(routes, ['/v1/semantic-review-context', '/v1/semantic-review']);
  assert.equal((await runner.source('task-one')).reviewBase, f.baseCommit);
});

test('host semantic review retains the original base for missing failed or incomplete release evidence', async (t) => {
  const f = await semanticReleaseFixture(t);
  const runner = f.createRunner();
  const cases = [
    ['missing', undefined],
    ['failed', { ...f.release, status: 'failed' }],
    ['incomplete', { status: 'success', commit: f.releasedCommit }],
    ['invalid operation identity', { ...f.release, operationId: 'unverified' }],
    ['invalid runner identity', { ...f.release, runnerJobId: 'unverified' }],
    ['invalid gate digest', { ...f.release, acceptanceGateDigest: 'unverified' }],
    ['invalid completion time', { ...f.release, completedAt: 'unverified' }],
    ['invalid commit', { ...f.release, commit: 'unverified' }],
  ];
  for (const [label, release] of cases) {
    await f.saveRelease(release);
    const source = await runner.source('task-one', { semanticReview: true });
    assert.equal(source.reviewBase, f.baseCommit, label);
    const changes = await source.readGit(['diff', '--name-only', source.reviewBase, '--']);
    assert.equal(changes.exitCode, 0, label);
    assert.ok(changes.stdout.includes(f.sqlPath), `${label}: unproven releases cannot hide SQL`);
    assert.ok(changes.stdout.includes(f.frontendPath), `${label}: frontend remains in scope`);
  }
});

test('host semantic review rejects a complete release record whose commit is not an ancestor', async (t) => {
  const f = await semanticReleaseFixture(t);
  const sideCommit = f.git('commit-tree', `${f.releasedCommit}^{tree}`, '-p', f.baseCommit, '-m', 'unreleased side branch');
  await f.saveRelease({ ...f.release, commit: sideCommit });
  const runner = f.createRunner();
  await assert.rejects(runner.source('task-one', { semanticReview: true }),
    (error) => error.code === 'VERIFY_SOURCE_INVALID' && /not an ancestor/u.test(error.message));
  assert.equal((await runner.source('task-one')).reviewBase, f.baseCommit);
});

test('host source rejects invalid metadata and a review base outside current HEAD ancestry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-review-base-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const metadataPath = path.join(root, 'taskspaces', 'task-one', 'metadata.json');
  const original = JSON.parse(await readFile(metadataPath, 'utf8'));
  await writeFile(metadataPath, `${JSON.stringify({ ...original, baseCommit: 'invalid' })}\n`);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  let runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory,
    toolchainProbe: async () => toolchainIdentity(currentContract), command: async () => result(),
  });
  await assert.rejects(runner.admit('task-one', ['governance']), (error) => error.code === 'VERIFY_SOURCE_INVALID');

  await writeFile(metadataPath, `${JSON.stringify(original)}\n`);
  state.setHead('c'.repeat(40));
  runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async (_executable, argv) => argv[0] === 'rev-parse'
      ? result({ stdout: `${original.baseCommit}\n` })
      : result({ exitCode: 1 }),
  });
  await assert.rejects(
    runner.admit('task-one', ['governance']),
    (error) => error.code === 'VERIFY_SOURCE_INVALID' && /not an ancestor/u.test(error.message),
  );
});

test('host execution environment is a closed per-TaskSpace map and does not inherit user settings, proxies, or secrets', () => {
  const root = path.resolve(os.tmpdir(), 'forge-host-env');
  const current = validateHostVerificationContract(contract(root));
  const paths = {
    homeRoot: path.join(root, 'taskspaces', 'task-one', 'jobs', 'job', 'home'),
    cacheRoot: path.join(root, 'taskspaces', 'task-one', 'cache'),
    tempRoot: path.join(root, 'taskspaces', 'task-one', 'jobs', 'job', 'tmp'),
    npmConfig: path.join(root, 'taskspaces', 'task-one', 'jobs', 'job', 'config', 'npmrc'),
    gitConfig: path.join(root, 'taskspaces', 'task-one', 'jobs', 'job', 'config', 'gitconfig'),
  };
  const env = hostExecutionEnvironment(current, paths, current.toolchains);
  assert.equal(env.HOME, path.resolve(paths.homeRoot));
  assert.equal(env.MAVEN_USER_HOME, path.join(paths.cacheRoot, 'm2'));
  assert.equal(env.TMPDIR, paths.tempRoot);
  assert.equal(env.TMP, paths.tempRoot);
  assert.equal(env.TEMP, paths.tempRoot);
  assert.equal(
    env.JAVA_TOOL_OPTIONS,
    `-Djava.io.tmpdir=${paths.tempRoot} -Duser.home=${path.resolve(paths.homeRoot)}`,
  );
  assert.equal(
    env.MAVEN_OPTS,
    `-Djava.io.tmpdir=${paths.tempRoot} -Djansi.tmpdir=${path.join(paths.tempRoot, 'maven-jansi')}`,
  );
  assert.equal(env.NPM_CONFIG_USERCONFIG, paths.npmConfig);
  assert.doesNotMatch(env.MAVEN_OPTS, /user\.home/u);
  assert.equal(env.GIT_CONFIG_GLOBAL, paths.gitConfig);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.deepEqual(Object.keys(env).sort(), [
    'CI', 'FORGE_VERIFICATION_PROJECT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_OPTIONAL_LOCKS',
    'HOME', 'JAVA_HOME', 'JAVA_TOOL_OPTIONS', 'LANG', 'LC_ALL', 'LOGNAME', 'MAVEN_CONFIG', 'MAVEN_OPTS', 'MAVEN_USER_HOME',
    'NO_COLOR', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_USERCONFIG', 'PATH', 'PNPM_HOME', 'PNPM_STORE_DIR', 'TEMP',
    'TMP', 'TMPDIR', 'USER', 'VITEST_MAX_THREADS', 'VITEST_MIN_THREADS', 'VITEST_MAX_FORKS', 'VITEST_MIN_FORKS',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  ].sort());
  assert.throws(() => hostExecutionEnvironment(current, {
    ...paths,
    tempRoot: `${paths.tempRoot} unsafe`,
  }, current.toolchains), /cannot be represented safely/u);
  assert.throws(() => hostExecutionEnvironment(current, {
    ...paths,
    homeRoot: `${paths.homeRoot} unsafe`,
  }, current.toolchains), /cannot be represented safely/u);
});

test('host execution environment propagates the fixed job-private Java temp option to nested processes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-java-temp-propagation-'));
  try {
    const current = validateHostVerificationContract(contract(root));
    const paths = {
      homeRoot: path.join(root, 'taskspaces', 'task-one', 'jobs', 'job', 'home'),
      cacheRoot: path.join(root, 'taskspaces', 'task-one', 'cache'),
      tempRoot: path.join(root, 'taskspaces', 'task-one', 'jobs', 'job', 'tmp'),
      npmConfig: path.join(root, 'taskspaces', 'task-one', 'jobs', 'job', 'config', 'npmrc'),
      gitConfig: path.join(root, 'taskspaces', 'task-one', 'jobs', 'job', 'config', 'gitconfig'),
    };
    const env = hostExecutionEnvironment(current, paths, current.toolchains);
    const nestedProbe = [
      "const { spawnSync } = require('node:child_process');",
      "const child = spawnSync(process.execPath, ['-p', 'process.env.JAVA_TOOL_OPTIONS'], { env: process.env, encoding: 'utf8' });",
      "if (child.status !== 0) process.exit(child.status ?? 1);",
      "process.stdout.write(child.stdout);",
    ].join('');
    const result = await runHostProcess(process.execPath, ['-e', nestedProbe], {
      cwd: root,
      env,
      timeoutSeconds: 30,
      maxOutputBytes: 16 * 1024,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.processEnded, true);
    assert.equal(result.stderr, '');
    assert.equal(
      result.stdout.trim(),
      `-Djava.io.tmpdir=${paths.tempRoot} -Duser.home=${path.resolve(paths.homeRoot)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host Runner trusts only the exact TaskSpace Git directory in its job-local protected config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-safe-directory-'));
  try {
    const workspace = await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const calls = [];
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host',
      contract: currentContract,
      command: async (executable, argv, options) => {
        calls.push({ executable, argv, options });
        if (argv[0] === 'clone') {
          assert.equal(
            await readFile(options.env.GIT_CONFIG_GLOBAL, 'utf8'),
            `[safe]\n\tdirectory = ${JSON.stringify(path.join(workspace, '.git'))}\n`,
          );
          await mkdir(argv.at(-1), { recursive: true });
        }
        return result();
      },
    });
    await runner.prepareJob(
      'task-one',
      '123e4567-e89b-12d3-a456-426614174000',
      { workspace, inventory: await inventoryState().inventory() },
      toolchainIdentity(currentContract),
    );
    assert.deepEqual(calls[0].argv, [
      'clone', '--no-hardlinks', '--no-checkout', '--', workspace,
      path.join(root, 'state', 'taskspaces', 'task-one', 'jobs', '123e4567-e89b-12d3-a456-426614174000', 'workspace'),
    ]);
    assert.doesNotMatch(await readFile(calls[0].options.env.GIT_CONFIG_GLOBAL, 'utf8'), /safe\.directory\s*=\s*\*/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default Host snapshot binds the validated project slug without inheriting source-local identity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-snapshot-project-'));
  try {
    const gitLookup = process.platform === 'win32' ? ['where.exe', ['git']] : ['which', ['git']];
    const gitExecutable = (await realpath(execFileSync(gitLookup[0], gitLookup[1], {
      encoding: 'utf8',
    }).trim().split(/\r?\n/u)[0]));
    const workspace = path.join(root, 'source');
    await mkdir(workspace, { recursive: true });
    execFileSync(gitExecutable, ['init'], { cwd: workspace, stdio: 'ignore' });
    execFileSync(gitExecutable, ['config', '--local', 'user.name', 'Host Snapshot Test'], { cwd: workspace });
    execFileSync(gitExecutable, ['config', '--local', 'user.email', 'host-snapshot@example.invalid'], { cwd: workspace });
    execFileSync(gitExecutable, ['config', '--local', 'forge-delivery.project-slug', 'source-controlled-project'], { cwd: workspace });
    await writeFile(path.join(workspace, 'tracked.txt'), 'snapshot\n');
    execFileSync(gitExecutable, ['add', 'tracked.txt'], { cwd: workspace });
    execFileSync(gitExecutable, ['commit', '-m', 'snapshot fixture'], { cwd: workspace, stdio: 'ignore' });
    const head = execFileSync(gitExecutable, ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const currentContract = validateHostVerificationContract(contract(root));
    const identity = toolchainIdentity(currentContract);
    identity.executables.git.configuredPath = gitExecutable;
    identity.executables.git.resolvedPath = gitExecutable;
    const runner = new HostVerificationRunner({ projectSlug: 'forge-host', contract: currentContract });
    const inventory = await inventoryState().inventory();
    const job = await runner.prepareJob(
      'task-one',
      '123e4567-e89b-12d3-a456-426614174000',
      { workspace, inventory: { ...inventory, head, files: [] } },
      identity,
    );
    assert.equal(
      execFileSync(gitExecutable, ['config', '--local', '--get', 'forge-delivery.project-slug'], {
        cwd: job.paths.snapshotRoot, encoding: 'utf8',
      }).trim(),
      'forge-host',
    );
    assert.equal(
      execFileSync(gitExecutable, ['config', '--local', '--get', 'forge-delivery.project-slug'], {
        cwd: workspace, encoding: 'utf8',
      }).trim(),
      'source-controlled-project',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host snapshot fails closed when its trusted project identity cannot be configured', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-snapshot-project-failure-'));
  try {
    const workspace = await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host',
      contract: currentContract,
      command: async (_executable, argv) => {
        if (argv[0] === 'clone') await mkdir(argv.at(-1), { recursive: true });
        if (argv[2] === 'config') return result({ exitCode: 1, stderr: 'config failed' });
        return result();
      },
    });
    await assert.rejects(
      runner.prepareJob(
        'task-one',
        '123e4567-e89b-12d3-a456-426614174000',
        { workspace, inventory: await inventoryState().inventory() },
        toolchainIdentity(currentContract),
      ),
      (error) => error.code === 'VERIFY_SOURCE_SNAPSHOT_FAILED'
        && /project identity/u.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host Runner maps shared inventory Git requests to the reviewed absolute executable with a closed environment', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-inventory-command-'));
  try {
    await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const calls = [];
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host',
      contract: currentContract,
      inventory: async (_workspace, _limits, inventoryCommand) => {
        await assert.rejects(
          Promise.resolve().then(() => inventoryCommand('sh', ['-c', 'id'], {})),
          /non-Git executable/u,
        );
        await inventoryCommand('git', ['--version'], { env: { LEAK: 'forbidden' } });
        return inventoryState().inventory();
      },
      command: async (executable, argv, options) => {
        calls.push({ executable, argv, options });
        return result({ stdout: 'git version 2.0.0\n' });
      },
      toolchainProbe: async () => toolchainIdentity(currentContract),
    });
    await runner.admit('task-one', ['governance']);
    assert.equal(calls.length, 1);
    assert.equal(path.isAbsolute(calls[0].executable), true);
    assert.equal(calls[0].executable, await realpath(process.execPath));
    assert.equal(calls[0].options.env.LEAK, undefined);
    assert.equal(calls[0].options.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(calls[0].options.env.GIT_CONFIG_GLOBAL, path.join(root, 'state', 'inventory.gitconfig'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default toolchain probes expose the complete reviewed toolchain path for wrapper dependencies without inheriting host PATH', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-toolchain-probe-'));
  try {
    await mkdir(path.join(root, 'state'), { recursive: true });
    const currentContract = validateHostVerificationContract(contract(root));
    const environments = [];
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host',
      contract: currentContract,
      command: async (_executable, _argv, options) => {
        environments.push(options.env);
        return result({ stdout: 'reviewed-tool 1.0.0\n' });
      },
    });
    const identity = await runner.toolchainProbe({});
    assert.match(identity.digest, /^[0-9a-f]{64}$/u);
    assert.equal(environments.length, 6);
    for (const environment of environments) {
      assert.equal(environment.PATH.includes(path.dirname(currentContract.toolchains.node)), true);
      assert.equal(environment.PATH.includes(process.env.PATH ?? ''), false);
      assert.equal(environment.OPENAI_API_KEY, undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host Runner records path/version fingerprints, redacts logs, and marks receipts stale on source drift', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-'));
  try {
    await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const state = inventoryState();
    const calls = [];
    const command = async (executable, argv, options) => {
      calls.push({ executable, argv, options });
      return result({ stdout: `completed sk-${'A'.repeat(24)} token=unsafe-value\n` });
    };
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host',
      contract: currentContract,
      inventory: state.inventory,
      snapshot,
      command,
      toolchainProbe: async () => toolchainIdentity(currentContract),
      runnerBootId: 'runner-boot-one',
    });
    const admission = await runner.admit('task-one', ['governance']);
    const receipt = await runner.run('task-one', {
      action: 'run',
      profile: 'governance',
      selectors: {},
      idempotencyKey: 'host-run-0001',
      admissionId: admission.admissionId,
    });
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.toolchain.executables.maven.resolvedPath, currentContract.toolchains.maven);
    assert.equal(receipt.toolchain.executables.maven.version, 'maven-version-1');
    assert.equal(receipt.isolation.globalUserConfigRead, false);
    assert.equal(receipt.isolation.cleanupProven, true);
    assert.equal(receipt.source.dependencyManifestFingerprint, 'c'.repeat(64));
    assert.equal(receipt.source.snapshotSha256, receipt.source.workspaceFingerprint);
    assert.equal(receipt.execution.steps[0].transportUncertain, false);
    assert.equal(receipt.execution.steps[0].cleanup.proven, true);
    assert.equal(receipt.logs.redacted, true);
    const logs = await readFile(receipt.logs.path, 'utf8');
    assert.doesNotMatch(logs, /unsafe-value|sk-/u);
    assert.match(logs, /\[REDACTED\]/u);
    assert.equal(calls[0].options.env.NPM_CONFIG_USERCONFIG.startsWith(path.join(root, 'state', 'taskspaces', 'task-one')), true);
    assert.equal((await runner.receipt('task-one', receipt.receiptId)).freshness, 'current');
    await assert.rejects(
      access(path.join(root, 'state', 'taskspaces', 'task-one', 'jobs', receipt.jobId)),
      (error) => error.code === 'ENOENT',
    );
    state.setFingerprint('e'.repeat(64));
    assert.equal((await runner.receipt('task-one', receipt.receiptId)).freshness, 'stale');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host Runner emits a typed RED receipt only for a reported non-infrastructure test failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-red-'));
  try {
    await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const state = inventoryState();
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host',
      contract: currentContract,
      inventory: state.inventory,
      snapshot,
      command: async (_executable, _argv, options) => {
        const reports = path.join(options.cwd, 'target', 'surefire-reports');
        await mkdir(reports, { recursive: true });
        await writeFile(
          path.join(reports, 'TEST-ExampleTest.xml'),
          '<testsuite tests="1" failures="1" errors="0" skipped="0"></testsuite>\n',
        );
        return result({ exitCode: 1 });
      },
      toolchainProbe: async () => toolchainIdentity(currentContract),
    });
    const admission = await runner.admit('task-one', ['backend-red-test']);
    const receipt = await runner.run('task-one', {
      action: 'run',
      profile: 'backend-red-test',
      selectors: { modules: ['forge-server/example'], tests: ['ExampleTest'] },
      idempotencyKey: 'host-red-0001',
      admissionId: admission.admissionId,
    });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.redExpectation.matched, true);
    assert.equal(receipt.redExpectation.failureKind, 'test-report');
    assert.equal(validateHostRunReceipt(receipt), receipt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host returns and saves auxiliary RED receipts with an issuer while GREEN still submits for acceptance', async (t) => {
  for (const profile of ['backend-red-test', 'frontend-red-test', 'backend-module-test']) {
    await t.test(profile, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-red-issuer-'));
      try {
        await fixture(root);
        const currentContract = validateHostVerificationContract(contract(root));
        const state = inventoryState();
        const red = profile !== 'backend-module-test';
        const issued = [];
        const runner = new HostVerificationRunner({
          projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
          toolchainProbe: async () => toolchainIdentity(currentContract),
          acceptanceIssuerClient: async (route, body) => {
            assert.equal(body.runnerReceipt.request.profile, 'backend-module-test', 'RED must not reach the formal issuer');
            issued.push({ route, body });
            return { accepted: true };
          },
          command: async (_executable, argv, options) => {
            if (profile === 'frontend-red-test') {
              if (argv[0] !== 'test') return result();
              const outputFile = argv.find((value) => value.startsWith('--outputFile=')).slice('--outputFile='.length);
              await writeFile(outputFile, JSON.stringify({
                numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0,
                testResults: [{ name: path.join(options.cwd, 'src/example.test.js'), assertionResults: [
                  { status: 'failed', fullName: 'missing behavior', failureMessages: ['expected behavior is absent'] },
                ] }],
              }));
            } else {
              const reports = path.join(options.cwd, 'target', 'surefire-reports');
              await mkdir(reports, { recursive: true });
              await writeFile(path.join(reports, 'TEST-ExampleTest.xml'),
                `<testsuite tests="1" failures="${red ? 1 : 0}" errors="0" skipped="0"></testsuite>\n`);
            }
            return result({ exitCode: red ? 1 : 0 });
          },
        });
        const admission = await runner.admit('task-one', [profile]);
        const selectors = profile === 'frontend-red-test' ? { testFiles: ['forge-admin-ui/src/example.test.js'] }
          : { modules: ['forge-server/example'], ...(red ? { tests: ['ExampleTest'] } : {}) };
        const receipt = await runner.execute({
          taskId: 'task-one', acceptanceContractId: 'd'.repeat(64), action: 'run', profile, selectors,
          admissionId: admission.admissionId, idempotencyKey: `issuer-${profile}-0001`,
        });
        const canonical = JSON.parse(await readFile(path.join(root, 'state', 'receipts', 'task-one', `${receipt.receiptId}.json`), 'utf8'));
        assert.deepEqual(receipt, canonical);
        assert.equal(validateHostRunReceipt(receipt), receipt);
        assert.equal(receipt.status, red ? 'failed' : 'passed');
        assert.equal(receipt.truth.verificationProven, !red);
        if (red) {
          assert.equal(receipt.redExpectation.matched, true);
          assert.equal(receipt.redExpectation.failureKind, 'test-report');
          assert.equal(issued.length, 0);
          await assert.rejects(runner.submitProtectedAcceptance('task-one', undefined, receipt),
            (error) => error.code === 'VERIFY_ACCEPTANCE_CONTRACT_REQUIRED');
        } else {
          assert.deepEqual(issued, [{ route: '/v1/verification', body: {
            taskId: 'task-one', contractId: 'd'.repeat(64), runnerReceipt: canonical,
          } }]);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('Host projects passed governance advisories from the verified log without changing canonical evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-governance-diagnostics-'));
  try {
    await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const state = inventoryState();
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
      toolchainProbe: async () => toolchainIdentity(currentContract),
      command: async () => result({ stdout: 'PASS Forge governance: 2 files, 0 blocking findings.\n'
        + 'ADVISORY FLOW-001 input.java:1 Approval intent has no Flowable binding.\n'
        + 'token=private-governance-diagnostic-value\n' }),
    });
    const admission = await runner.admit('task-one', ['governance']);
    const receipt = await runner.execute({ taskId: 'task-one', action: 'run', profile: 'governance',
      selectors: {}, idempotencyKey: 'governance-diagnostics-0001', admissionId: admission.admissionId });
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.results.executed, 0);
    assert.equal(receipt.logs.excerpt, undefined);
    const receiptFile = path.join(root, 'state', 'receipts', 'task-one', `${receipt.receiptId}.json`);
    const beforeReceipt = await readFile(receiptFile);
    const beforeLog = await readFile(receipt.logs.path);
    const projected = await runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: receipt.receiptId, includeDiagnostics: true });
    assert.match(projected.logs.excerpt, /ADVISORY FLOW-001 input\.java:1/u);
    assert.match(projected.logs.excerpt, /UNTRUSTED/u);
    assert.match(projected.logs.excerpt, /counts tests, not findings/u);
    assert.doesNotMatch(projected.logs.excerpt, /private-governance-diagnostic-value/u);
    assert.ok(Buffer.byteLength(projected.logs.excerpt, 'utf8') <= 16 * 1024);
    assert.equal(projected.status, 'passed');
    assert.deepEqual(projected.results, receipt.results);
    assert.deepEqual(projected.truth, receipt.truth);
    assert.deepEqual(await readFile(receiptFile), beforeReceipt);
    assert.deepEqual(await readFile(receipt.logs.path), beforeLog);
    assert.equal((await runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: receipt.receiptId })).logs.excerpt, undefined);
    const tampered = Buffer.from(beforeLog); tampered[0] ^= 1;
    await writeFile(receipt.logs.path, tampered);
    await assert.rejects(runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: receipt.receiptId, includeDiagnostics: true }), /log integrity/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host projects missing Maven assertion details from the retained log without rewriting receipt or outcome', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-maven-diagnostics-'));
  try {
    await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const state = inventoryState();
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
      toolchainProbe: async () => toolchainIdentity(currentContract),
      command: async (_executable, _argv, options) => {
        const reports = path.join(options.cwd, 'target', 'surefire-reports');
        await mkdir(reports, { recursive: true });
        await writeFile(path.join(reports, 'TEST-ExampleTest.xml'), '<testsuite tests="4" failures="1" errors="0" skipped="0"></testsuite>');
        return result({ exitCode: 1, stdout: `${'[INFO] unrelated compilation\n'.repeat(400)}[ERROR] Tests run: 4, Failures: 1 <<< FAILURE! -- in ExampleTest\n[ERROR] ExampleTest.rejectsMissingCategory <<< FAILURE!\nExpecting BusinessException but was NullPointerException\n at ImmutableCollections$Set12.contains\n token=private-maven-diagnostic-value\n[INFO] Next module\n${'[INFO] unrelated reactor summary\n'.repeat(400)}` });
      },
    });
    const admission = await runner.admit('task-one', ['backend-module-test']);
    const receipt = await runner.execute({ taskId: 'task-one', action: 'run', profile: 'backend-module-test',
      selectors: { modules: ['forge-server/example'] }, idempotencyKey: 'maven-diagnostics-0001', admissionId: admission.admissionId });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.results.failed, 1);
    const receiptFile = path.join(root, 'state', 'receipts', 'task-one', `${receipt.receiptId}.json`);
    const beforeReceipt = await readFile(receiptFile);
    const beforeLog = await readFile(receipt.logs.path);
    const projected = await runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: receipt.receiptId, includeDiagnostics: true });
    assert.match(projected.logs.excerpt, /ExampleTest\.rejectsMissingCategory/u);
    assert.match(projected.logs.excerpt, /BusinessException but was NullPointerException/u);
    assert.match(projected.logs.excerpt, /ImmutableCollections\$Set12\.contains/u);
    assert.doesNotMatch(projected.logs.excerpt, /private-maven-diagnostic-value/u);
    assert.ok(Buffer.byteLength(projected.logs.excerpt, 'utf8') <= 16 * 1024);
    assert.equal(projected.status, 'failed');
    assert.equal(projected.truth.verificationProven, false);
    assert.deepEqual(projected.results, receipt.results);
    assert.deepEqual(await readFile(receiptFile), beforeReceipt);
    assert.deepEqual(await readFile(receipt.logs.path), beforeLog);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host projects the first Maven compiler errors instead of only cascading tail errors without changing evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-compiler-diagnostics-'));
  try {
    await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const state = inventoryState();
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
      toolchainProbe: async () => toolchainIdentity(currentContract),
      command: async () => result({ exitCode: 1, stdout:
        `${'[INFO] successful dependency compilation\n'.repeat(400)}[ERROR] COMPILATION ERROR :\n[INFO] -------------------------------------------------------------\n`
        + "[ERROR] [JOB_WORKSPACE]/forge-server/example/src/main/java/SecurityDefenseController.java:[56,24] annotation values must be of the form 'name=value'\n"
        + "[ERROR] [JOB_WORKSPACE]/forge-server/example/src/main/java/SecurityDefenseController.java:[67,24] annotation values must be of the form 'name=value'\n"
        + ' token=private-compiler-diagnostic-value\n'
        + '[ERROR] [JOB_WORKSPACE]/forge-server/example/src/main/java/OtherService.java:[83,17] cannot find symbol\n'.repeat(400)
        + '[INFO] BUILD FAILURE\n' }),
    });
    const admission = await runner.admit('task-one', ['backend-module-test']);
    const receipt = await runner.execute({ taskId: 'task-one', action: 'run', profile: 'backend-module-test',
      selectors: { modules: ['forge-server/example'] }, idempotencyKey: 'compiler-diagnostics-0001', admissionId: admission.admissionId });
    const receiptFile = path.join(root, 'state', 'receipts', 'task-one', `${receipt.receiptId}.json`);
    const beforeReceipt = await readFile(receiptFile);
    const beforeLog = await readFile(receipt.logs.path);
    const projected = await runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: receipt.receiptId, includeDiagnostics: true });
    assert.match(projected.logs.excerpt, /SecurityDefenseController\.java:\[56,24\] annotation values/u);
    assert.match(projected.logs.excerpt, /SecurityDefenseController\.java:\[67,24\] annotation values/u);
    assert.doesNotMatch(projected.logs.excerpt, /private-compiler-diagnostic-value/u);
    assert.ok(Buffer.byteLength(projected.logs.excerpt, 'utf8') <= 16 * 1024);
    assert.equal(projected.status, 'failed');
    assert.equal(projected.truth.verificationProven, false);
    assert.deepEqual(projected.results, receipt.results);
    assert.deepEqual(await readFile(receiptFile), beforeReceipt);
    assert.deepEqual(await readFile(receipt.logs.path), beforeLog);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host Runner persists bounded Vitest failure diagnostics before deleting the job and projects them only on request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-diagnostics-'));
  try {
    const { runner, admission, acceptanceBodies } = await vitestFailureFixture(root, { acceptance: true });
    const projected = await runner.execute({
      taskId: 'task-one',
      action: 'run',
      profile: 'frontend-admin-test',
      selectors: {},
      idempotencyKey: 'host-diagnostics-0001',
      admissionId: admission.admissionId,
      acceptanceContractId: 'd'.repeat(64),
      includeDiagnostics: true,
    });
    assert.equal(projected.status, 'failed');
    assert.deepEqual(projected.results, {
      executed: 925, passed: 923, failed: 2, skipped: 0, reportFiles: 1, zeroTestsRejected: false,
    });
    assert.match(projected.logs.excerpt, /^===== BEGIN FORGE HOST FAILURE DIAGNOSTICS \(UNTRUSTED\) =====/u);
    assert.match(projected.logs.excerpt, /first failure/u);
    assert.match(projected.logs.excerpt, /second failure keeps its name/u);
    assert.match(projected.logs.excerpt, /stdout-head/u);
    assert.match(projected.logs.excerpt, /stdout-tail/u);
    assert.match(projected.logs.excerpt, /stderr-head/u);
    assert.match(projected.logs.excerpt, /stderr-tail/u);
    assert.match(projected.logs.excerpt, /message truncated at 2048 UTF-8 bytes/u);
    assert.match(projected.logs.excerpt, /process output was truncated/u);
    assert.doesNotMatch(projected.logs.excerpt, /json-secret|unsafe-api-key|unsafe-password|unsafe-step-token|Bearer abcdefghijklmnop/u);
    assert.doesNotMatch(projected.logs.excerpt, /\x1B|\u0001/u);
    assert.doesNotMatch(projected.logs.excerpt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'));
    assert.ok(Buffer.byteLength(projected.logs.excerpt, 'utf8') <= 16 * 1024);
    assert.doesNotMatch(projected.logs.excerpt, /\uFFFD/u);
    await assert.rejects(
      access(path.join(root, 'state', 'taskspaces', 'task-one', 'jobs', projected.jobId)),
      { code: 'ENOENT' },
    );

    const canonicalFile = path.join(root, 'state', 'receipts', 'task-one', `${projected.receiptId}.json`);
    const canonical = JSON.parse(await readFile(canonicalFile, 'utf8'));
    assert.equal(canonical.logs.excerpt, undefined);
    assert.deepEqual(controlledEvidenceReceipt(
      'forge-verify run --profile frontend-admin-test --admission-id ' + admission.admissionId + ' --idempotency-key host-diagnostics-0001',
      JSON.stringify(projected),
    )?.receipt, canonical);
    for (const invalid of [
      { action: 'receipt', receiptId: projected.receiptId, includeDiagnostics: false },
      { action: 'receipt', receiptId: projected.receiptId, includeDiagnostics: 'true' },
      { action: 'status', jobId: projected.jobId, includeDiagnostics: true },
      { action: 'admit', profiles: ['governance'], includeDiagnostics: true },
      { action: 'capability', profile: 'governance', includeDiagnostics: true },
    ]) await assert.rejects(runner.execute({ taskId: 'task-one', ...invalid }), /includeDiagnostics|unsupported field/u);

    assert.equal(validateHostRunReceipt(canonical), canonical);
    const persistedLog = await readFile(canonical.logs.path, 'utf8');
    assert.ok(persistedLog.startsWith('===== BEGIN FORGE HOST FAILURE DIAGNOSTICS (UNTRUSTED) =====\n'));
    assert.ok(persistedLog.indexOf('===== END FORGE HOST FAILURE DIAGNOSTICS (UNTRUSTED) =====') < persistedLog.indexOf('# step 1:'));
    assert.doesNotMatch(persistedLog, /json-secret|unsafe-api-key|unsafe-password|unsafe-step-token/u);
    assert.doesNotMatch(persistedLog, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'));
    assert.equal(acceptanceBodies.length, 1);
    assert.deepEqual(acceptanceBodies[0].runnerReceipt, canonical);
    assert.equal((await runner.receipt('task-one', projected.receiptId)).logs.excerpt, undefined);

    const oldReceiptResponse = await runner.execute({
      taskId: 'task-one', action: 'receipt', receiptId: projected.receiptId,
    });
    assert.equal(oldReceiptResponse.logs.excerpt, undefined);
    const oldRunResponse = await runner.execute({
      taskId: 'task-one', action: 'run', profile: 'frontend-admin-test', selectors: {},
      idempotencyKey: 'host-diagnostics-0001', admissionId: admission.admissionId,
      acceptanceContractId: 'd'.repeat(64),
    });
    assert.equal(oldRunResponse.logs.excerpt, undefined);

    const repeated = await runner.execute({
      taskId: 'task-one', action: 'receipt', receiptId: projected.receiptId, includeDiagnostics: true,
    });
    assert.equal(repeated.logs.excerpt, projected.logs.excerpt);
    const idempotent = await runner.execute({
      taskId: 'task-one',
      action: 'run',
      profile: 'frontend-admin-test',
      selectors: {},
      idempotencyKey: 'host-diagnostics-0001',
      admissionId: admission.admissionId,
      acceptanceContractId: 'd'.repeat(64),
      includeDiagnostics: true,
    });
    assert.equal(idempotent.receiptId, projected.receiptId);
    assert.equal(idempotent.logs.excerpt, projected.logs.excerpt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default Host frontend tests use the task base and accept an empty affected set without accepting empty focused tests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-changed-tests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  const commands = [];
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    command: async (_executable, argv) => { commands.push(argv); return result(); },
    toolchainProbe: async () => toolchainIdentity(currentContract),
  });
  const source = await runner.source('task-one');
  const admission = await runner.admit('task-one', ['frontend-admin-test']);
  const receipt = await runner.execute({ taskId: 'task-one', action: 'run', profile: 'frontend-admin-test', selectors: {},
    idempotencyKey: 'host-changed-tests-0001', admissionId: admission.admissionId });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.results.executed, 0);
  assert.equal(receipt.results.zeroTestsRejected, false);
  assert.ok(commands.find(argv => argv[0] === 'test')?.includes(`--changed=${source.reviewBase}`));
  assert.ok(commands.find(argv => argv[0] === 'test')?.includes('__forge_no_changed_frontend_tests__/'));
  const focused = await runner.execute({ taskId: 'task-one', action: 'run', profile: 'frontend-admin-test',
    selectors: { testFiles: ['forge-admin-ui/src/example.test.js'] },
    idempotencyKey: 'host-focused-tests-0002', admissionId: admission.admissionId });
  assert.equal(focused.status, 'failed-zero-tests');
});

test('host Runner reports Vitest suite-load and compatible top-level errors without inventing missing-report detail', async (t) => {
  await t.test('suite and unhandled errors', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-suite-diagnostics-'));
    try {
      await fixture(root);
      const currentContract = validateHostVerificationContract(contract(root));
      const state = inventoryState();
      const runner = new HostVerificationRunner({
        projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
        command: async (_executable, argv, commandOptions) => {
          if (argv[0] !== 'test') return result();
          const outputFile = argv.find((value) => value.startsWith('--outputFile=')).slice('--outputFile='.length);
          await writeFile(outputFile, `${JSON.stringify({
            numTotalTests: 0,
            numPassedTests: 0,
            numFailedTests: 0,
            numPendingTests: 0,
            testResults: [{
              name: path.join(commandOptions.cwd, 'src', 'suite-load.test.js'),
              status: 'failed',
              message: 'ReferenceError: URL class mismatch token=suite-secret',
              assertionResults: [],
            }],
            unhandledErrors: [{
              name: 'Unhandled Error',
              message: 'top-level failure API_KEY=top-level-secret',
            }],
          })}\n`);
          return result({ exitCode: 1 });
        },
        toolchainProbe: async () => toolchainIdentity(currentContract),
      });
      const admission = await runner.admit('task-one', ['frontend-admin-test']);
      const receipt = await runner.execute({
        taskId: 'task-one', action: 'run', profile: 'frontend-admin-test', selectors: {},
        idempotencyKey: 'host-suite-diagnostics-0001', admissionId: admission.admissionId,
        includeDiagnostics: true,
      });
      assert.equal(receipt.status, 'failed');
      assert.deepEqual(receipt.results, {
        executed: 0, passed: 0, failed: 0, skipped: 0, reportFiles: 1, zeroTestsRejected: false,
      });
      validateHostRunReceipt(await runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: receipt.receiptId }));
      assert.match(receipt.logs.excerpt, /suite: <suite load>/u);
      assert.match(receipt.logs.excerpt, /ReferenceError: URL class mismatch/u);
      assert.match(receipt.logs.excerpt, /unhandled error: Unhandled Error/u);
      assert.match(receipt.logs.excerpt, /top-level failure/u);
      assert.doesNotMatch(receipt.logs.excerpt, /suite-secret|top-level-secret/u);
      assert.match(receipt.logs.excerpt, /untrusted test\/process output/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test('missing report', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-missing-report-diagnostics-'));
    try {
      await fixture(root);
      const currentContract = validateHostVerificationContract(contract(root));
      const state = inventoryState();
      const runner = new HostVerificationRunner({
        projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
        command: async (_executable, argv) => argv[0] === 'test'
          ? result({ exitCode: 1 }) : result(),
        toolchainProbe: async () => toolchainIdentity(currentContract),
      });
      const admission = await runner.admit('task-one', ['frontend-admin-test']);
      const receipt = await runner.execute({
        taskId: 'task-one', action: 'run', profile: 'frontend-admin-test', selectors: {},
        idempotencyKey: 'host-missing-report-diagnostics-0001', admissionId: admission.admissionId,
        includeDiagnostics: true,
      });
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.results.reportFiles, 0);
      assert.equal(receipt.results.zeroTestsRejected, false);
      validateHostRunReceipt(await runner.execute({ taskId: 'task-one', action: 'receipt', receiptId: receipt.receiptId }));
      assert.match(receipt.logs.excerpt, /no detailed failed assertion was available/u);
      assert.doesNotMatch(receipt.logs.excerpt, /suite:|unhandled error:/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('host Runner returns failed typecheck stderr diagnostics but does not add diagnostics to a passing response or log', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-process-diagnostics-'));
  try {
    await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const state = typecheckInventoryState();
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
      command: async (_executable, argv) => argv[0] === 'diff'
        ? result({ stdout: 'forge-admin-ui/src/example.ts\0' }) : argv[0] === HOST_FRONTEND_TYPECHECK_PATH
        ? result({ exitCode: 1, stderr: 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL typecheck detail\n' })
        : result(),
      toolchainProbe: async () => toolchainIdentity(currentContract),
    });
    const failedAdmission = await runner.admit('task-one', ['frontend-admin-typecheck']);
    const failed = await runner.execute({
      taskId: 'task-one', action: 'run', profile: 'frontend-admin-typecheck', selectors: {},
      idempotencyKey: 'host-typecheck-diagnostics-0001', admissionId: failedAdmission.admissionId,
      includeDiagnostics: true,
    });
    assert.match(failed.logs.excerpt, /ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL typecheck detail/u);
    assert.doesNotMatch(failed.logs.excerpt, /Vitest failures/u);

    const passingRunner = new HostVerificationRunner({
      projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
      command: async () => result(), toolchainProbe: async () => toolchainIdentity(currentContract),
    });
    const passingAdmission = await passingRunner.admit('task-one', ['governance']);
    const passed = await passingRunner.execute({
      taskId: 'task-one', action: 'run', profile: 'governance', selectors: {},
      idempotencyKey: 'host-pass-diagnostics-0001', admissionId: passingAdmission.admissionId,
      includeDiagnostics: true,
    });
    assert.equal(passed.status, 'passed');
    assert.equal(passed.logs.excerpt, undefined);
    assert.doesNotMatch(await readFile(passed.logs.path, 'utf8'), /FAILURE DIAGNOSTICS/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host Runner fails closed when a diagnostic log is tampered or exceeds the hard size limit', async (t) => {
  await t.test('content tamper', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-log-tamper-'));
    try {
      const { runner, admission } = await vitestFailureFixture(root);
      const receipt = await runner.run('task-one', {
        action: 'run', profile: 'frontend-admin-test', selectors: {},
        idempotencyKey: 'host-log-tamper-0001', admissionId: admission.admissionId,
      });
      await writeFile(receipt.logs.path, Buffer.alloc(receipt.logs.bytes, 0x78));
      await assert.rejects(runner.execute({
        taskId: 'task-one', action: 'receipt', receiptId: receipt.receiptId, includeDiagnostics: true,
      }), /integrity does not match/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test('oversized content', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-log-oversize-'));
    try {
      const { runner, admission } = await vitestFailureFixture(root);
      const receipt = await runner.run('task-one', {
        action: 'run', profile: 'frontend-admin-test', selectors: {},
        idempotencyKey: 'host-log-oversize-0001', admissionId: admission.admissionId,
      });
      const oversized = Buffer.alloc(16 * 1024 * 1024 + 1, 0x61);
      await writeFile(receipt.logs.path, oversized);
      const receiptFile = path.join(root, 'state', 'receipts', 'task-one', `${receipt.receiptId}.json`);
      const canonical = JSON.parse(await readFile(receiptFile, 'utf8'));
      canonical.logs.bytes = oversized.length;
      canonical.logs.sha256 = crypto.createHash('sha256').update(oversized).digest('hex');
      await writeFile(receiptFile, `${JSON.stringify(canonical, null, 2)}\n`);
      await assert.rejects(runner.execute({
        taskId: 'task-one', action: 'receipt', receiptId: receipt.receiptId, includeDiagnostics: true,
      }), /exceeds the hard limit/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test('host Runner rejects symbolic-link diagnostic logs where the platform permits the fixture', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-log-symlink-'));
  try {
    const { runner, admission } = await vitestFailureFixture(root);
    const receipt = await runner.run('task-one', {
      action: 'run', profile: 'frontend-admin-test', selectors: {},
      idempotencyKey: 'host-log-symlink-0001', admissionId: admission.admissionId,
    });
    const original = await readFile(receipt.logs.path);
    const target = path.join(root, 'symlink-target.log');
    await writeFile(target, original);
    await rm(receipt.logs.path);
    try {
      await symlink(target, receipt.logs.path, 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
        t.skip(`Windows symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(runner.execute({
      taskId: 'task-one', action: 'receipt', receiptId: receipt.receiptId, includeDiagnostics: true,
    }), /ordinary non-symbolic-link file/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host Runner leaves historical receipts without retained diagnostics unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-log-legacy-'));
  try {
    const { runner, admission } = await vitestFailureFixture(root);
    const receipt = await runner.run('task-one', {
      action: 'run', profile: 'frontend-admin-test', selectors: {},
      idempotencyKey: 'host-log-legacy-0001', admissionId: admission.admissionId,
    });
    const legacy = Buffer.from(`old failure tail \"password\":\"legacy-secret\"\u001b[31m ${path.join(
      root, 'state', 'taskspaces', 'task-one', 'jobs', receipt.jobId, 'workspace', 'private-file.js',
    )}\n`, 'utf8');
    await writeFile(receipt.logs.path, legacy);
    const receiptFile = path.join(root, 'state', 'receipts', 'task-one', `${receipt.receiptId}.json`);
    const canonical = JSON.parse(await readFile(receiptFile, 'utf8'));
    canonical.logs.bytes = legacy.length;
    canonical.logs.sha256 = crypto.createHash('sha256').update(legacy).digest('hex');
    await writeFile(receiptFile, `${JSON.stringify(canonical, null, 2)}\n`);
    const projected = await runner.execute({
      taskId: 'task-one', action: 'receipt', receiptId: receipt.receiptId, includeDiagnostics: true,
    });
    assert.equal(projected.logs.excerpt, undefined);
    assert.deepEqual(projected, await runner.receipt('task-one', receipt.receiptId));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host typecheck execution alone gives nested Node an 8 GiB heap without changing other job environments', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-typecheck-heap-'));
  try {
    await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const state = typecheckInventoryState();
    const snapshots = [];
    const calls = [];
    const nestedProbe = [
      "const { spawnSync } = require('node:child_process');",
      "const child = spawnSync(process.execPath, ['-p', 'JSON.stringify({options:process.env.NODE_OPTIONS,heapLimit:require(\"node:v8\").getHeapStatistics().heap_size_limit})'], { env: process.env, encoding: 'utf8' });",
      "if (child.status !== 0) { process.stderr.write(child.stderr); process.exit(child.status ?? 1); }",
      "process.stdout.write(child.stdout);",
    ].join('');
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory,
      snapshot: async (source, snapshotRoot, _tools, environment) => {
        snapshots.push(environment);
        await snapshot(source, snapshotRoot);
      },
      toolchainProbe: async () => toolchainIdentity(currentContract),
      command: async (executable, argv, options) => {
        if (argv[0] === 'diff') return result({ stdout: 'forge-admin-ui/src/example.ts\0' });
        if (argv[0] === 'ls-files') return result();
        calls.push({ executable, argv: [...argv], environment: options.env });
        if (argv[0] === HOST_FRONTEND_TYPECHECK_PATH) {
          const probe = await runHostProcess(process.execPath, ['-e', nestedProbe], options);
          assert.equal(probe.exitCode, 0);
          const observed = JSON.parse(probe.stdout);
          assert.equal(observed.options, '--max-old-space-size=8192');
          assert.ok(observed.heapLimit >= 8192 * 1024 * 1024);
          assert.ok(observed.heapLimit < 9 * 1024 * 1024 * 1024);
          return probe;
        }
        return result();
      },
    });
    for (const profile of ['frontend-admin-typecheck', 'frontend-admin-build']) {
      const admission = await runner.admit('task-one', [profile]);
      const receipt = await runner.execute({
        taskId: 'task-one', action: 'run', profile, selectors: {},
        idempotencyKey: `host-fixed-heap-${profile}`, admissionId: admission.admissionId,
      });
      assert.equal(receipt.status, 'passed');
      assert.equal(receipt.policy.profilePolicyDigest, hostProfilePolicyDigest(currentContract));
      validateHostRunReceipt(receipt);
    }
    assert.equal(snapshots.length, 2);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[1].argv, [HOST_FRONTEND_TYPECHECK_PATH, '--project', 'forge-admin-ui', '--files', '["forge-admin-ui/src/example.ts"]']);
    assert.equal(calls[1].executable, currentContract.toolchains.node);
    assert.notEqual(calls[1].environment, snapshots[0]);
    const { NODE_OPTIONS, ...typecheckEnvironment } = calls[1].environment;
    assert.equal(NODE_OPTIONS, '--max-old-space-size=8192');
    assert.deepEqual(typecheckEnvironment, snapshots[0]);
    assert.equal(calls[0].environment, snapshots[0]);
    assert.equal(calls[2].environment, snapshots[1]);
    assert.equal(calls[3].environment, snapshots[1]);
    for (const environment of snapshots) {
      assert.equal(environment.NODE_OPTIONS, undefined);
      assert.equal(environment.HTTP_PROXY, undefined);
      assert.equal(environment.OPENAI_API_KEY, undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host typecheck profile fails closed when the protected checker reports unavailable project configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-typecheck-'));
  try {
    await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const state = typecheckInventoryState();
    const calls = [];
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host',
      contract: currentContract,
      inventory: state.inventory,
      snapshot,
      command: async (executable, argv, options) => {
        if (argv[0] === 'diff') return result({ stdout: 'forge-admin-ui/src/example.ts\0' });
        if (argv[0] === 'ls-files') return result();
        calls.push({ executable, argv, cwd: options.cwd });
        if (argv[0] === HOST_FRONTEND_TYPECHECK_PATH) {
          return result({ exitCode: 1, stderr: 'FRONTEND_TYPECHECK_CONFIG_UNAVAILABLE\n' });
        }
        return result();
      },
      toolchainProbe: async () => toolchainIdentity(currentContract),
    });
    const admission = await runner.admit('task-one', ['frontend-admin-typecheck']);
    const receipt = await runner.run('task-one', {
      action: 'run',
      profile: 'frontend-admin-typecheck',
      selectors: {},
      idempotencyKey: 'host-typecheck-0001',
      admissionId: admission.admissionId,
    });
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.truth.verificationProven, false);
    assert.deepEqual(calls.map(({ argv }) => argv), [
      [
        '--dir', path.join(root, 'state', 'taskspaces', 'task-one', 'jobs', receipt.jobId, 'workspace', 'forge-admin-ui'),
        'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', path.join(root, 'state', 'taskspaces', 'task-one', 'cache', 'pnpm', 'store'),
      ],
      [HOST_FRONTEND_TYPECHECK_PATH, '--project', 'forge-admin-ui', '--files', '["forge-admin-ui/src/example.ts"]'],
    ]);
    assert.equal(calls[0].executable, currentContract.toolchains.pnpm);
    assert.equal(calls[1].executable, currentContract.toolchains.node);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('QUAL06 Host backend outcomes follow reports without rewriting process facts', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-qual06-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fixture(root);
  const currentContract = validateHostVerificationContract(contract(root));
  const state = inventoryState();
  let scenario;
  const runner = new HostVerificationRunner({
    projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
    toolchainProbe: async () => toolchainIdentity(currentContract),
    command: async (_executable, argv, options) => {
      if (argv.at(-1) !== 'test') return result();
      if (scenario.xml) {
        const reports = path.join(options.cwd, 'target', 'surefire-reports');
        await mkdir(reports, { recursive: true });
        await writeFile(path.join(reports, 'TEST-ExampleTest.xml'), scenario.xml);
      }
      return result({ exitCode: scenario.exitCode ?? 0 });
    },
  });
  const admission = await runner.admit('task-one', [
    'backend-red-test', 'backend-module-compile', 'backend-module-test', 'backend-test-class',
  ]);
  const failed = '<testsuite tests="1" failures="1" errors="0" skipped="0"></testsuite>';
  const cases = [
    { name: 'passing with a skipped case', xml: '<testsuite tests="2" failures="0" errors="0" skipped="1"></testsuite>', status: 'passed', passed: 1, skipped: 1 },
    { name: 'module failure with exit zero', profile: 'backend-module-test', xml: failed, status: 'failed', failed: 1 },
    { name: 'test error with exit zero', xml: '<testsuite tests="1" failures="0" errors="1" skipped="0"></testsuite>', status: 'failed', failed: 1 },
    { name: 'missing report', status: 'failed-zero-tests' },
    { name: 'all cases skipped', xml: '<testsuite tests="2" failures="0" errors="0" skipped="2"></testsuite>', status: 'failed-zero-tests', skipped: 2 },
    { name: 'compile only', profile: 'backend-module-compile', status: 'passed' },
    { name: 'ignored red failure', profile: 'backend-red-test', xml: failed, status: 'failed', failed: 1, redMatched: false },
    { name: 'actual red failure', profile: 'backend-red-test', xml: failed, exitCode: 1, status: 'failed', failed: 1, redMatched: true },
  ];
  for (const [index, item] of cases.entries()) await t.test(item.name, async () => {
    scenario = item;
    const profile = item.profile ?? 'backend-test-class';
    const selectors = { modules: ['forge-server/example'],
      ...(['backend-test-class', 'backend-red-test'].includes(profile) ? { tests: ['ExampleTest#checks'] } : {}) };
    const receipt = await runner.run('task-one', { action: 'run', profile, selectors,
      idempotencyKey: `qual06-host-case-${index}`, admissionId: admission.admissionId });
    assert.equal(receipt.status, item.status);
    assert.equal(receipt.execution.exitCode, item.exitCode ?? 0);
    assert.equal(receipt.truth.verificationProven, item.status === 'passed');
    assert.equal(receipt.results.failed, item.failed ?? 0);
    assert.equal(receipt.results.passed, item.passed ?? 0);
    assert.equal(receipt.results.skipped, item.skipped ?? 0);
    validateHostRunReceipt(receipt);
    if (item.redMatched !== undefined) assert.equal(receipt.redExpectation.matched, item.redMatched);
    if (item.status !== 'passed') {
      const forged = structuredClone(receipt);
      forged.status = 'passed';
      forged.truth.verificationProven = true;
      forged.results.zeroTestsRejected = false;
      assert.throws(() => validateHostRunReceipt(forged), /Backend test success/u);
    } else if (profile === 'backend-test-class') {
      const forged = structuredClone(receipt);
      forged.status = 'failed';
      forged.truth.verificationProven = false;
      assert.throws(() => validateHostRunReceipt(forged), /status does not match/u);
    }
  });
});

test('host Runner rejects request argv/env/path injection, cross-TaskSpace admissions, timeouts, and zero-test success claims', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-negative-'));
  try {
    await fixture(root, 'task-one');
    await fixture(root, 'task-two');
    const currentContract = validateHostVerificationContract(contract(root));
    const state = inventoryState();
    const base = {
      projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
      toolchainProbe: async () => toolchainIdentity(currentContract), runnerBootId: 'runner-negative',
    };
    const runner = new HostVerificationRunner({ ...base, command: async () => result() });
    const admission = await runner.admit('task-one', ['governance', 'backend-red-test', 'frontend-admin-test']);
    await assert.rejects(runner.execute({
      taskId: 'task-one', action: 'run', profile: 'governance', selectors: {},
      idempotencyKey: 'host-run-0002', admissionId: admission.admissionId,
      command: '/bin/sh', env: { TOKEN: 'x' }, url: 'https://example.invalid',
    }), /unsupported field/u);
    await assert.rejects(runner.run('task-two', {
      action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'host-run-0003', admissionId: admission.admissionId,
    }), /another Runner or TaskSpace/u);
    await assert.rejects(runner.admit('../escape', ['governance']), /TaskSpace id is invalid/u);

    const zero = await runner.run('task-one', {
      action: 'run', profile: 'frontend-admin-test', selectors: { testFiles: ['forge-admin-ui/src/example.test.js'] },
      idempotencyKey: 'host-run-0004', admissionId: admission.admissionId,
    });
    assert.equal(zero.status, 'failed-zero-tests');
    assert.equal(zero.truth.verificationProven, false);

    const backendRedZero = await runner.run('task-one', {
      action: 'run',
      profile: 'backend-red-test',
      selectors: { modules: ['forge-server/example'], tests: ['ExampleTest#failsFirst'] },
      idempotencyKey: 'host-run-red-zero-0001',
      admissionId: admission.admissionId,
    });
    assert.equal(backendRedZero.status, 'failed-zero-tests');
    assert.equal(backendRedZero.results.zeroTestsRejected, true);
    assert.equal(backendRedZero.redExpectation.matched, false);
    assert.equal(backendRedZero.truth.verificationProven, false);

    const timeoutRunner = new HostVerificationRunner({
      ...base,
      runnerBootId: 'runner-timeout',
      command: async () => result({ exitCode: 124, timedOut: true }),
    });
    const timeoutAdmission = await timeoutRunner.admit('task-one', ['governance']);
    const timedOut = await timeoutRunner.run('task-one', {
      action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'host-run-0005', admissionId: timeoutAdmission.admissionId,
    });
    assert.equal(timedOut.status, 'timed-out');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host cache content survives a failed job and a new Runner instance while other TaskSpaces stay separate', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-cache-retry-'));
  try {
    await fixture(root, 'task-one');
    await fixture(root, 'task-two');
    const currentContract = validateHostVerificationContract(contract(root));
    const state = inventoryState();
    const observed = [];
    const execute = async (taskId, runIndex, shouldReuse) => {
      const runner = new HostVerificationRunner({
        projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot,
        runnerBootId: `cache-retry-${runIndex}`,
        toolchainProbe: async () => toolchainIdentity(currentContract),
        command: async (_executable, _argv, options) => {
          const cacheDirectories = [options.env.MAVEN_USER_HOME, options.env.PNPM_STORE_DIR, options.env.XDG_CACHE_HOME];
          for (const directory of cacheDirectories) {
            const marker = path.join(directory, 'retained-content.fixture');
            if (shouldReuse) assert.equal(await readFile(marker, 'utf8'), 'task-one');
            else {
              await assert.rejects(access(marker), { code: 'ENOENT' });
              await mkdir(directory, { recursive: true });
              await writeFile(marker, taskId);
            }
          }
          observed.push({ cacheDirectories, temporary: options.env.TMPDIR });
          return result({ exitCode: runIndex === 1 ? 1 : 0 });
        },
      });
      const admission = await runner.admit(taskId, ['governance']);
      return runner.run(taskId, {
        action: 'run', profile: 'governance', selectors: {},
        idempotencyKey: `cache-retry-${runIndex}`, admissionId: admission.admissionId,
      });
    };
    const failed = await execute('task-one', 1, false);
    assert.equal(failed.status, 'failed');
    const retried = await execute('task-one', 2, true);
    assert.equal(retried.status, 'passed');
    await execute('task-two', 3, false);
    assert.deepEqual(observed[0].cacheDirectories, observed[1].cacheDirectories);
    assert.notDeepEqual(observed[1].cacheDirectories, observed[2].cacheDirectories);
    assert.notEqual(observed[0].temporary, observed[1].temporary);
    for (const entry of observed) await assert.rejects(access(entry.temporary), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('host Runner enforces one active job per TaskSpace and physically separates TaskSpace caches and logs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-runner-lock-'));
  try {
    await fixture(root, 'task-one');
    await fixture(root, 'task-two');
    const currentContract = validateHostVerificationContract(contract(root));
    const state = inventoryState();
    let release;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    let commandCount = 0;
    const environments = [];
    const command = async (_executable, _argv, options) => {
      commandCount += 1;
      environments.push(options.env);
      assert.equal(options.env.TMP, options.env.TMPDIR);
      assert.equal(options.env.TEMP, options.env.TMPDIR);
      assert.equal(
        options.env.JAVA_TOOL_OPTIONS,
        `-Djava.io.tmpdir=${options.env.TMPDIR} -Duser.home=${options.env.HOME}`,
      );
      await access(options.env.TMPDIR);
      await access(path.join(options.env.TMPDIR, 'maven-jansi'));
      assert.equal(
        options.env.MAVEN_OPTS,
        `-Djava.io.tmpdir=${options.env.TMPDIR} -Djansi.tmpdir=${path.join(options.env.TMPDIR, 'maven-jansi')}`,
      );
      if (commandCount === 1) {
        started();
        await new Promise((resolve) => { release = resolve; });
      }
      return result();
    };
    const runner = new HostVerificationRunner({
      projectSlug: 'forge-host', contract: currentContract, inventory: state.inventory, snapshot, command,
      toolchainProbe: async () => toolchainIdentity(currentContract), runnerBootId: 'runner-lock',
    });
    const one = await runner.admit('task-one', ['governance']);
    const two = await runner.admit('task-two', ['governance']);
    const pending = runner.run('task-one', {
      action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'host-lock-0001', admissionId: one.admissionId,
    });
    await startedPromise;
    await assert.rejects(runner.run('task-one', {
      action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'host-lock-0002', admissionId: one.admissionId,
    }), /already has an active/u);
    release();
    const first = await pending;
    const second = await runner.run('task-two', {
      action: 'run', profile: 'governance', selectors: {}, idempotencyKey: 'host-lock-0003', admissionId: two.admissionId,
    });
    assert.notEqual(first.isolation.cacheRoot, second.isolation.cacheRoot);
    assert.notEqual(path.dirname(first.logs.path), path.dirname(second.logs.path));
    assert.equal(environments.length, 2);
    assert.notEqual(environments[0].TMPDIR, environments[1].TMPDIR);
    assert.notEqual(environments[0].HOME, environments[1].HOME);
    for (const environment of environments) {
      await assert.rejects(access(environment.TMPDIR), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Host concurrent portable tasks perform one install and one seed restore through the actual run path', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-host-shared-run-'));
  t.after(async () => {
    const thaw = async (directory) => {
      await chmod(directory, 0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await thaw(path.join(directory, entry.name));
    };
    await thaw(root); await rm(root, { recursive: true, force: true });
  });
  const bytes = {
    'forge-admin-ui/package.json': '{"dependencies":{"example":"1.0.0"}}',
    'forge-admin-ui/pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      example:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n  example@1.0.0:\n    resolution: {integrity: sha512-YWJjZA==}\n\nsnapshots:\n  example@1.0.0: {}\n",
    'forge-admin-ui/pnpm-workspace.yaml': "packages:\n  - '.'\n",
  };
  const populate = async (workspace) => {
    for (const [relative, value] of Object.entries(bytes)) {
      await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
      await writeFile(path.join(workspace, relative), value);
    }
  };
  for (const task of ['task-one', 'task-two']) await populate(await fixture(root, task));
  const currentContract = validateHostVerificationContract({ ...contract(root), processIsolation: 'bubblewrap',
    dependencySeed: { root: path.join(root, 'seed'), manifestSha256: 'f'.repeat(64) } });
  const state = inventoryState();
  let installs = 0, seeds = 0;
  const runner = new HostVerificationRunner({ projectSlug: 'forge-host', contract: currentContract,
    inventory: async () => ({ ...await state.inventory(), files: Object.entries(bytes).map(([relative, value]) => ({ relative,
      sha256: crypto.createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) })) }),
    snapshot: async (_source, destination) => { await snapshot(_source, destination); await populate(destination); },
    toolchainProbe: async () => toolchainIdentity(currentContract),
    restoreDependencySeed: async ({ cacheRoot }) => {
      assert.match(cacheRoot, /\/jobs\/[^/]+\/tmp\/registry-cache$/u);
      await assert.rejects(lstat(path.join(cacheRoot, 'pnpm')), { code: 'ENOENT' });
      seeds++; return { status: 'ready', restored: ['pnpm'], preserved: [] };
    },
    command: async (_executable, argv) => {
      if (argv.includes('--new-session')) {
        if (argv.some((value) => value.includes('forge-host-sandbox-ready/v1'))) return result({ stdout: 'forge-host-sandbox-ready/v1' });
        const command = argv.slice(argv.indexOf('--') + 2);
        if (command[0] === '--dir' && command[2] === 'install') {
          installs++;
          const file = path.join(command[1], 'node_modules/example/index.js');
          await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, 'module.exports = 42;');
        }
      }
      return result();
    } });
  runner.preinstalledFrontend = async () => ({ status: 'unavailable' });
  const requests = await Promise.all(['task-one', 'task-two'].map(async taskId => {
    const admission = await runner.admit(taskId, ['frontend-admin-build']);
    return { taskId, admissionId: admission.admissionId };
  }));
  const receipts = await Promise.all(requests.map(({ taskId, admissionId }) => runner.run(taskId, {
    action: 'run', profile: 'frontend-admin-build', selectors: {}, admissionId, idempotencyKey: `shared-run-${taskId}`,
  })));
  assert.equal(installs, 1); assert.equal(seeds, 1);
  for (const receipt of receipts) { assert.equal(receipt.status, 'passed'); validateHostRunReceipt(receipt); }
  const logs = await Promise.all(receipts.map(receipt => readFile(receipt.logs.path, 'utf8')));
  assert.ok(logs.some(log => log.includes('"source":"host-prepared-shared","copiedFiles":0,"installed":false')));
});

test('prepared frontend dependencies move once and bind read-only without per-job copying; changed inputs or tampering invalidate reuse', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-prepared-dependencies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const makePaths = (task, job) => {
    const jobRoot = path.join(root, 'taskspaces', task, 'jobs', job);
    return { jobRoot, snapshotRoot: path.join(jobRoot, 'workspace') };
  };
  const first = makePaths('task-one', 'job-first');
  const moduleFile = (paths) => path.join(paths.snapshotRoot, 'forge-admin-ui/node_modules/example/index.js');
  await mkdir(path.dirname(moduleFile(first)), { recursive: true });
  await writeFile(moduleFile(first), 'original dependency');
  const options = { project: 'forge-admin-ui', dependencyFingerprint: 'a'.repeat(64),
    toolchainDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64) };
  const before = await lstat(moduleFile(first));
  let captured, restored;
  assert.equal(await preparedFrontendDependencies({ ...options, paths: first, operation: 'capture', onReady: (value) => { captured = value; } }), 'captured');
  const protectedFile = path.join(captured.root, 'example/index.js');
  assert.equal((await lstat(protectedFile)).ino, before.ino, 'capture moves the installed tree without copying files');
  await assert.rejects(lstat(moduleFile(first)), { code: 'ENOENT' });
  const next = makePaths('task-one', 'job-next');
  assert.equal(await preparedFrontendDependencies({ ...options, paths: next, operation: 'restore', onReady: (value) => { restored = value; } }), 'restored');
  assert.deepEqual(restored, captured);
  await assert.rejects(lstat(moduleFile(next)), { code: 'ENOENT' }, 'the next job receives a mount, not another directory copy');
  const third = makePaths('task-one', 'job-third');
  assert.equal(await preparedFrontendDependencies({ ...options, paths: third, operation: 'restore' }), 'restored');
  assert.equal(await readFile(protectedFile, 'utf8'), 'original dependency');
  assert.equal(await preparedFrontendDependencies({ ...options, paths: makePaths('task-other', 'job-first'), operation: 'restore' }), 'unavailable');
  assert.equal(await preparedFrontendDependencies({ ...options, dependencyFingerprint: 'd'.repeat(64),
    paths: makePaths('task-one', 'job-new-dependency'), operation: 'restore' }), 'unavailable');
  await writeFile(protectedFile, 'tampered cache');
  assert.equal(await preparedFrontendDependencies({ ...options, paths: makePaths('task-one', 'job-tampered'), operation: 'restore' }), 'invalid');
  let diagnostic;
  assert.equal(await preparedFrontendDependencies({ ...options, paths: makePaths('task-one', 'job-missing'),
    operation: 'capture', onDiagnostic: (value) => { diagnostic = value; } }), 'unavailable');
  assert.equal(diagnostic.code, 'ENOENT');
});

test('frontend prepared cache keeps installed bytes across Java updates while frontend tools remain bound', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-frontend-toolchain-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = (job) => {
    const jobRoot = path.join(root, 'taskspaces/task-one/jobs', job);
    return { jobRoot, snapshotRoot: path.join(jobRoot, 'workspace') };
  };
  const first = paths('original');
  const file = path.join(first.snapshotRoot, 'forge-admin-ui/node_modules/example/index.js');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'module.exports = 42;');
  const original = toolchainIdentity(validateHostVerificationContract(contract(root)));
  const current = structuredClone(original);
  current.javaHome += '-updated';
  current.executables.java.version += '-updated';
  current.executables.maven.version += '-updated';
  current.digest = crypto.createHash('sha256').update(JSON.stringify({ javaHome: current.javaHome, executables: current.executables })).digest('hex');
  const options = { project: 'forge-admin-ui', dependencyFingerprint: 'a'.repeat(64), policyDigest: 'c'.repeat(64) };
  let captured, restored;
  assert.equal(await preparedFrontendDependencies({ ...options, paths: first, toolchain: original,
    toolchainDigest: original.digest, operation: 'capture', onReady: (value) => { captured = value; } }), 'captured');
  assert.equal(await preparedFrontendDependencies({ ...options, paths: paths('java-update'), toolchain: current,
    toolchainDigest: current.digest, operation: 'restore', onReady: (value) => { restored = value; } }), 'restored');
  assert.deepEqual(restored, captured);
  await assert.rejects(lstat(path.join(paths('java-update').snapshotRoot, 'forge-admin-ui/node_modules')), { code: 'ENOENT' });
  for (const name of ['node', 'pnpm', 'git']) {
    const changed = structuredClone(current);
    changed.executables[name].modifiedMs += 1;
    changed.digest = crypto.createHash('sha256').update(JSON.stringify({ javaHome: changed.javaHome, executables: changed.executables })).digest('hex');
    assert.equal(await preparedFrontendDependencies({ ...options, paths: paths(name), toolchain: changed,
      toolchainDigest: changed.digest, operation: 'restore' }), 'unavailable');
  }
});

test('prepared dependency sandbox mounts remain task-bound and expose only ephemeral tool caches as writable', () => {
  const paths = { jobRoot: '/srv/forge-delivery/projects/example/verification/taskspaces/task-one/jobs/job-one',
    cacheRoot: '/srv/forge-delivery/projects/example/verification/taskspaces/task-one/cache' };
  const dependency = { project: 'forge-admin-ui',
    root: `/srv/forge-delivery/projects/example/verification/taskspaces/task-one/prepared-dependencies/forge-admin-ui/${'a'.repeat(64)}/node_modules` };
  const tools = { node: '/usr/bin/node' };
  const step = { cwd: paths.jobRoot + '/workspace/forge-admin-ui', executable: tools.node, argv: ['test.mjs'] };
  const result = hostSandboxCommand(step, paths, tools, [dependency]);
  const offset = result.argv.indexOf(dependency.root);
  assert.equal(result.argv[offset - 1], '--ro-bind');
  assert.equal(result.argv[offset + 1], step.cwd + '/node_modules');
  for (const name of ['.vite', '.vite-temp', '.cache']) {
    assert.equal(result.argv[result.argv.indexOf(step.cwd + '/node_modules/' + name) - 1], '--tmpfs');
  }
  assert.throws(() => hostSandboxCommand(step, paths, tools, [{ ...dependency, root: dependency.root.replace('task-one', 'other-task') }]), /escaped/u);
  assert.throws(() => hostSandboxCommand(step, paths, tools, [dependency, dependency]), /escaped/u);
});

test('prepared dependency real Linux sandbox denies package edits and permits private tool caches',
  { skip: process.platform !== 'linux' || !process.env.FORGE_TEST_BWRAP_NODE }, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-prepared-bwrap-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const jobRoot = path.join(root, 'taskspaces/task-one/jobs/job-one');
    const paths = { jobRoot, snapshotRoot: jobRoot + '/workspace', cacheRoot: path.join(root, 'taskspaces/task-one/cache') };
    const project = 'forge-admin-ui';
    const moduleRoot = `${paths.snapshotRoot}/${project}/node_modules`;
    await mkdir(moduleRoot + '/example', { recursive: true });
    await mkdir(paths.cacheRoot, { recursive: true });
    await writeFile(moduleRoot + '/example/index.js', 'protected dependency');
    let binding;
    assert.equal(await preparedFrontendDependencies({ paths, project, dependencyFingerprint: 'a'.repeat(64),
      toolchainDigest: 'b'.repeat(64), policyDigest: 'c'.repeat(64), operation: 'capture',
      onReady: (value) => { binding = value; } }), 'captured');
    const tools = { node: process.env.FORGE_TEST_BWRAP_NODE };
    const code = `const fs=require('node:fs');const assert=require('node:assert/strict');
      assert.equal(fs.readFileSync('node_modules/example/index.js','utf8'),'protected dependency');
      assert.throws(()=>fs.writeFileSync('node_modules/example/index.js','poisoned'),{code:'EROFS'});
      assert.throws(()=>fs.chmodSync('node_modules/example/index.js',0o777),{code:'EROFS'});
      fs.writeFileSync('node_modules/.vite/cache','private');console.log('readonly-dependencies-ok');`;
    const command = hostSandboxCommand({ executable: tools.node, argv: ['-e', code],
      cwd: `${paths.snapshotRoot}/${project}` }, paths, tools, [binding]);
    assert.equal(execFileSync(command.executable, command.argv, { cwd: command.cwd, encoding: 'utf8' }).trim(), 'readonly-dependencies-ok');
    assert.equal(await readFile(binding.root + '/example/index.js', 'utf8'), 'protected dependency');
    await assert.rejects(lstat(binding.root + '/.vite/cache'), { code: 'ENOENT' });
  });

test('prepared dependency inputs include nested lockfiles and patches but ignore page wording', () => {
  const input = { dependencyManifestFingerprint: 'a'.repeat(64), files: [
    { relative: 'forge-admin-ui/pnpm-lock.yaml', sha256: 'b'.repeat(64) },
    { relative: 'forge-admin-ui/src/example.vue', sha256: 'c'.repeat(64) },
    { relative: 'forge-admin-ui/patches/library.patch', sha256: 'd'.repeat(64) },
  ] };
  const digest = preparedDependencyInputs(input);
  const wording = structuredClone(input);
  wording.files[1].sha256 = 'e'.repeat(64);
  assert.equal(preparedDependencyInputs(wording), digest);
  for (const index of [0, 2]) {
    const changed = structuredClone(input);
    changed.files[index].sha256 = 'f'.repeat(64);
    assert.notEqual(preparedDependencyInputs(changed), digest);
  }
});


test('H5 focused Node tests execute real reports and reject failed, empty and forged-zero outcomes', async t => {
  for (const [name, body, expected, counts] of [
    ['pass', "test('one',()=>{});describe('nested',()=>{test('two',()=>{});test.skip('three',()=>{});});", 'passed', [3,2,0,1]],
    ['failure', "test('bad',()=>{throw new Error('real node failure')});", 'failed', [1,0,1,0]],
    ['empty', "describe('empty',()=>{});", 'failed-zero-tests', [0,0,0,0]],
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-h5-node-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await fixture(root);
    const currentContract = validateHostVerificationContract(contract(root));
    const state = inventoryState();
    const file = 'forge-h5-ui/src/utils/__tests__/display.test.js';
    let processCount = 0;
    let actualReport;
    const runner = new HostVerificationRunner({ projectSlug: 'forge-host', contract: currentContract,
      inventory: state.inventory, toolchainProbe: async () => toolchainIdentity(currentContract),
      snapshot: async (source, target) => {
        await snapshot(source, target);
        await mkdir(path.dirname(path.join(target, file)), { recursive: true });
        await writeFile(path.join(target, file), `const {test,describe}=require('node:test');\n${body}`);
      }, command: async (exe, argv, options) => {
        if (argv[0] !== '--test') return result();
        processCount++;
        assert.equal(exe, process.execPath);
        assert.equal(path.basename(options.cwd), 'forge-h5-ui');
        assert.equal(argv.at(-1), 'src/utils/__tests__/display.test.js');
        let observed;
        try { observed = result({ stdout: execFileSync(exe, argv, { cwd: options.cwd, env: options.env, encoding: 'utf8' }) }); }
        catch (error) { observed = result({ exitCode: error.status, stdout: String(error.stdout), stderr: String(error.stderr) }); }
        actualReport = await readFile(argv.find(x => x.startsWith('--test-reporter-destination=')).split('=').slice(1).join('='), 'utf8');
        return observed;
      },
    });
    const admission = await runner.admit('task-one', ['frontend-h5-test']);
    const receipt = await runner.execute({ taskId: 'task-one', action: 'run', profile: 'frontend-h5-test',
      selectors: { testFiles: [file] }, admissionId: admission.admissionId, idempotencyKey: `h5-real-node-${name}` });
    assert.equal(processCount, 1);
    assert.equal(receipt.status, expected);
    assert.deepEqual(['executed','passed','failed','skipped'].map(k => receipt.results[k]), counts);
    assert.deepEqual(nodeTestReportResults(actualReport), Object.fromEntries(['executed','passed','failed','skipped'].map((k,i)=>[k,counts[i]])));
    validateHostRunReceipt(receipt);
    const persisted = JSON.parse(await readFile(path.join(runner.stateRoot, 'receipts', 'task-one', `${receipt.receiptId}.json`)));
    assert.deepEqual(persisted.results, receipt.results);
    if (name === 'pass') {
      for (const results of [{ ...receipt.results, executed: 0, passed: 0, skipped: 0 },
        { ...receipt.results, passed: 1, failed: 1 }]) {
        assert.throws(() => validateHostRunReceipt({ ...receipt, results }), /H5 test success/);
      }
    }
  }
});

test('H5 profile addition revalidates only the exact previous catalog without rerunning old checks', async t => {
  const context = await hostReceiptReuseFixture(t, 'frontend-admin-build');
  const { runner, currentContract, original, receiptFile, request } = context;
  const descriptor = hostProfilePolicyDescriptor(currentContract);
  const previous = { ...descriptor, profiles: descriptor.profiles.filter(x => x !== 'frontend-h5-test') };
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  original.policy.profilePolicyDigest = hash(previous);
  await writeFile(receiptFile, JSON.stringify(original));
  const originalBytes = await readFile(receiptFile);
  const before = context.commands();
  const projected = await runner.execute(request);
  assert.deepEqual(projected.revalidation.profilePolicyTransition, descriptor);
  validateHostRunReceipt(projected);
  assert.equal(context.commands(), before);
  assert.deepEqual(await readFile(receiptFile), originalBytes);
  assert.equal(context.routes.at(-1).route, '/v1/verification');
  for (const mutate of [d => { d.policyRevision = 'unknown'; }, d => { d.profiles = d.profiles.slice(1); },
    d => { d.preparedDependencies = 'a'.repeat(64); }]) {
    const invalid = structuredClone(projected); mutate(invalid.revalidation.profilePolicyTransition);
    assert.throws(() => validateHostRunReceipt(invalid));
  }
  assert.throws(() => validateH5ProfilePolicyTransition(descriptor, hash(previous), hash(descriptor), 'frontend-h5-test'));
  original.policy.profilePolicyDigest = '0'.repeat(64);
  await writeFile(receiptFile, JSON.stringify(original));
  await assert.rejects(runner.execute({ ...request, idempotencyKey: 'unknown-old-policy' }), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
});

test('Host seed-only policy reuse preserves original execution and refuses a real failed XML report', async t => {
  for (const scenario of ['passed', 'failed-xml']) await t.test(scenario, async sub => {
    const reportFixture = scenario === 'failed-xml'
      ? { xml: '<testsuite tests="1" failures="1" errors="0" skipped="0"></testsuite>', expectedStatus: 'failed' } : {};
    const f = await hostReceiptReuseFixture(sub, 'backend-test-class', {
      modules: ['forge-server/forge-business/forge-business-core'], tests: ['ExampleTest'],
    }, 'm2', false, undefined, '', undefined, reportFixture);
    const root = await mkdtemp(path.join(os.tmpdir(), 'forge-seed-reuse-'));
    sub.after(async () => {
      for (const name of ['previous', 'current']) {
        await chmod(path.join(root, name), 0o700); await chmod(path.join(root, name, 'manifest.json'), 0o600);
      }
      await rm(root, { recursive: true, force: true });
    });
    const hash = value => crypto.createHash('sha256').update(value).digest('hex');
    const base = { schemaVersion: 'forge-host-dependency-seed/v1', projectSlug: 'forge-host', sourceHead: 'a'.repeat(40),
      inputs: [], inputsDigest: hash('[]'), toolchains: { platform: 'linux', arch: 'x64', java: '17', maven: '3', node: '22', pnpm: '10' },
      mavenSettingsSha256: 'b'.repeat(64), files: [{ path: 'm2/repository/old/old.jar', bytes: 1, sha256: hash('x') }] };
    const bindings = {};
    for (const name of ['previous', 'current']) {
      const manifest = structuredClone(base);
      if (name === 'current') manifest.files.push({ path: 'm2/repository/zz/zz.jar', bytes: 1, sha256: hash('y') });
      manifest.packDigest = hash(JSON.stringify(manifest.files));
      const seedRoot = path.join(root, name); await mkdir(seedRoot);
      const bytes = `${JSON.stringify(manifest)}\n`; await writeFile(path.join(seedRoot, 'manifest.json'), bytes);
      await chmod(path.join(seedRoot, 'manifest.json'), 0o444); await chmod(seedRoot, 0o555);
      bindings[name] = { root: seedRoot, manifestSha256: hash(bytes) };
    }
    // Reconstruct the historical fixture policy, as the existing H5 fixture does.
    // The original process facts and report were produced by the real runner above.
    const oldContract = { ...f.currentContract, processIsolation: 'bubblewrap', dependencySeed: bindings.previous };
    f.original.policy.profilePolicyDigest = hostProfilePolicyDigest(oldContract);
    await writeFile(f.receiptFile, JSON.stringify(f.original));
    const originalBytes = await readFile(f.receiptFile);
    f.runner.contract = { ...oldContract, dependencySeed: bindings.current };
    f.runner.profilePolicyDigest = hostProfilePolicyDigest(f.runner.contract);
    const admission = await f.runner.admit('task-one', ['backend-test-class']);
    const before = f.commands(); f.runner.prepareJob = async () => assert.fail('seed-only reuse must not rerun tests');
    const request = { ...f.request, admissionId: admission.admissionId };
    if (scenario === 'failed-xml') {
      assert.equal(f.original.results.failed, 1); assert.equal(f.original.execution.exitCode, 0);
      await assert.rejects(f.runner.execute(request), { code: 'VERIFY_RECEIPT_REUSE_INVALID' });
    } else {
      const projection = await f.runner.execute(request);
      assert.equal(projection.revalidation.profilePolicyTransition.dependencySeedTransition.retainedFileCount, 1);
      assert.deepEqual(projection.execution, f.original.execution); assert.deepEqual(projection.results, f.original.results);
      validateHostRunReceipt(projection);
      assert.deepEqual(f.routes.at(-1).body.runnerReceipt, projection);
    }
    assert.equal(f.commands(), before); assert.deepEqual(await readFile(f.receiptFile), originalBytes);
  });
});
