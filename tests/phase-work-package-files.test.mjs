import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPhaseWorkPackageFiles } from '../docker/harness/phase-work-package-files.mjs';
import { writeForgePhaseWorkPackage } from '../docker/harness/forge-phase-work-package.mjs';
import { canonicalStringify } from '../docker/harness/forge-task-execution-contract.mjs';
import { createConversationManager } from '../docker/harness/conversation-manager.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stamp = '2026-09-15T08:00:00.000Z';
const json = async (file, value) => writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-phase-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = {
    schemaVersion: 2, projectSlug: 'test-project', taskId: 'task-phase-files', actorId: 'alice',
    actorUserId: '11111111-1111-4111-8111-111111111111', conversationId: 'conversation:alice',
    branch: 'task/alice/task-phase-files', baseCommit: 'a'.repeat(40), status: 'stopped',
    createdAt: stamp, updatedAt: stamp, accessTokenHash: '0'.repeat(64), harnessPort: 23001,
    accessMode: 'conversation', lastCandidate: null, lastRelease: null,
  };
  const taskspacesRoot = path.join(root, 'taskspaces');
  const taskRoot = path.join(taskspacesRoot, metadata.taskId);
  const control = path.join(taskspacesRoot, '.broker', 'delivery-phases', metadata.taskId, 'phase-control');
  await mkdir(taskRoot, { recursive: true });
  await json(path.join(taskRoot, 'metadata.json'), metadata);
  const store = () => createPhaseWorkPackageFiles({ taskspacesRoot, projectSlug: metadata.projectSlug, taskMetadata: metadata });
  return { root, metadata, taskspacesRoot, taskRoot, control, store };
}

async function sealedAttempt(context, { generation = 1, completedAt = stamp, decision = 'accepted', legacyVersion = false,
  control = context.control, phaseId = 'requirements', phaseIndex = 0 } = {}) {
  const executionId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const directory = path.join(control, 'browser-attempts', executionId);
  const output = path.join(directory, 'controller');
  const packageDirectory = path.join(output, 'work-package');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const execution = { executionId, projectSlug: context.metadata.projectSlug, taskId: context.metadata.taskId,
    conversationId: context.metadata.conversationId, actorUserId: context.metadata.actorUserId,
    actorUsername: context.metadata.actorId, authorityClass: 'production-read-only', testOnly: false,
    route: 'session.prompt', generation, workflowId: 'crud-production', phaseId, phaseIndex,
    dshSessionId: 'session:alice',
    rpcId: `rpc:${generation}`, promptDigest: '1'.repeat(64) };
  const begun = { schemaVersion: 'forge-delivery-browser-phase-begin/v1', workflowId: execution.workflowId,
    phaseId: execution.phaseId, phaseIndex: execution.phaseIndex, stateDigest: '2'.repeat(64), idempotent: false,
    attempt: { attemptId, phaseId: execution.phaseId, phaseIndex: execution.phaseIndex,
      executionGeneration: generation, rpcId: execution.rpcId, promptDigest: execution.promptDigest,
      sessionMode: generation === 1 ? 'create' : 'resume', startedAt: completedAt } };
  const receipt = { schemaVersion: 'forge-delivery-phase-receipt/v1', issuer: 'forge-phase-controller',
    workflowId: execution.workflowId, phaseId: execution.phaseId, phaseIndex: execution.phaseIndex,
    attemptId, executionGeneration: generation, decision, reasonCode: decision === 'accepted' ? null : 'BUSINESS_DECISION_REQUIRED',
    artifactDigest: decision === 'accepted' ? '3'.repeat(64) : null, patchDigest: null,
    hostReceiptDigests: [], completedAt };
  receipt.receiptDigest = sha256(canonicalStringify(receipt));
  const artifactKind = `${phaseId}-contract`;
  const artifact = decision === 'accepted' ? { artifactKind, artifactDigest: receipt.artifactDigest,
    patchDigest: null, changedPaths: [], upstreamArtifactDigests: {}, unresolvedDecisions: [], payload: { summary: '员工管理需求' } } : null;
  const built = await writeForgePhaseWorkPackage({ directory: packageDirectory,
    state: { workflowId: execution.workflowId, taskId: execution.taskId, sourceCommit: context.metadata.baseCommit },
    phase: { id: execution.phaseId, index: phaseIndex, actionCeiling: 'read-only', sourceMutation: false, ownedPaths: [],
      artifactKind, requiredSkills: ['forge-phase-work-package'], hostVerificationProfiles: [] },
    proposal: { unresolvedDecisions: decision === 'accepted' ? [] : ['确认字段'], payload: { summary: '员工管理需求' } },
    artifact, receipt, hostReceipts: [], requestDigest: '4'.repeat(64), catalogVersion: '2026.09.03.2',
    workflowStatus: decision === 'accepted' ? 'active' : 'blocked', nextPhaseId: decision === 'accepted' ? 'domain-contract' : null,
    phaseCount: 8, humanResponse: '员工管理的需求说明。' });
  let manifest = built.manifest;
  if (legacyVersion) {
    const { packageDigest: _ignored, ...identity } = { ...manifest, workPackageVersion: '2026.09.03.2' };
    manifest = { ...identity, packageDigest: sha256(canonicalStringify(identity)) };
    await json(path.join(packageDirectory, 'manifest.json'), manifest);
  }
  await json(path.join(directory, 'execution.json'), execution);
  await json(path.join(directory, 'begin.json'), begun);
  await json(path.join(output, 'phase-receipt.json'), receipt);
  const result = { schemaVersion: 'forge-delivery-phase-controller-finalize/v1', workflowId: execution.workflowId,
    acceptedPhaseId: execution.phaseId, acceptedPhaseIndex: execution.phaseIndex,
    phaseArtifactDigest: receipt.artifactDigest, workPackageDigest: manifest.packageDigest,
    workPackageManifest: 'work-package/manifest.json' };
  if (decision === 'accepted') await json(path.join(output, 'controller-result.json'), result);
  return { executionId, directory, output, packageDirectory, execution, begun, receipt, result, manifest };
}

async function linkedFrontend(context) {
  const control = path.join(context.control, 'frontend-repair');
  await mkdir(control, { recursive: true, mode: 0o700 });
  const parent = { taskId: context.metadata.taskId, sessionId: 'session:alice', sourceCommit: context.metadata.baseCommit,
    stateDigest: '5'.repeat(64), catalogDigest: '6'.repeat(64), catalogVersion: '2026.09.03.2', lastExecutionGeneration: 11 };
  const stateFile = path.join(context.control, 'state.json');
  await json(stateFile, parent);
  const receipt = { schemaVersion: 'forge-delivery-frontend-repair-continuation/v1', phaseId: 'frontend', phaseIndex: 5,
    taskId: parent.taskId, sessionId: parent.sessionId, sourceCommit: parent.sourceCommit,
    sourceStateSha256: sha256(await readFile(stateFile)), sourceStateDigest: parent.stateDigest,
    catalogDigest: parent.catalogDigest, catalogVersion: parent.catalogVersion,
    parentLastExecutionGeneration: 11, nextExecutionGenerationMinimum: 12 };
  const receiptFile = path.join(control, '前端阶段-关联修复凭据.json');
  await json(receiptFile, receipt);
  return { control, stateFile, receiptFile, receipt };
}

test('lists and reads parent and formally linked frontend packages without replacing the parent bytes', async (t) => {
  const context = await fixture(t);
  const parent = await sealedAttempt(context);
  const parentBytes = await readFile(path.join(parent.packageDirectory, '01-result.md'));
  const repair = await linkedFrontend(context);
  const child = await sealedAttempt(context, { control: repair.control, phaseId: 'frontend', phaseIndex: 5,
    generation: 12, completedAt: '2026-09-15T09:00:00.000Z' });
  const list = await context.store().list();
  assert.deepEqual(list.items.map((item) => item.packageId), [child.manifest.packageDigest, parent.manifest.packageDigest]);
  assert.equal(list.items[0].phaseId, 'frontend');
  for (const document of child.manifest.documents) {
    const file = await context.store().read({ packageId: child.manifest.packageDigest, name: document.path });
    assert.deepEqual(file.buffer, await readFile(path.join(child.packageDirectory, document.path)));
    assert.match(file.displayName, /[\u4e00-\u9fff]/u);
  }
  assert.deepEqual((await context.store().read({ packageId: parent.manifest.packageDigest, name: '01-result.md' })).buffer, parentBytes);
  await rm(repair.receiptFile);
  assert.deepEqual((await context.store().list()).items.map((item) => item.packageId), [parent.manifest.packageDigest]);
  await assert.rejects(context.store().read({ packageId: child.manifest.packageDigest, name: '01-result.md' }), { code: 'PHASE_OUTPUT_NOT_FOUND' });
});

test('linked frontend discovery rejects copied identities, stale parent binding and redirected child directories', async (t) => {
  const context = await fixture(t);
  const repair = await linkedFrontend(context);
  const child = await sealedAttempt(context, { control: repair.control, phaseId: 'frontend', phaseIndex: 5, generation: 12 });
  assert.equal((await context.store().list()).items[0].packageId, child.manifest.packageDigest);
  for (const [key, value] of [['taskId', 'task-other'], ['conversationId', 'conversation:other'],
    ['actorUsername', 'bob'], ['dshSessionId', 'session:other'], ['generation', 11]]) {
    await json(path.join(child.directory, 'execution.json'), { ...child.execution, [key]: value });
    await assert.rejects(context.store().read({ packageId: child.manifest.packageDigest, name: '01-result.md' }), { code: 'PHASE_OUTPUT_SOURCE_INVALID' });
  }
  await json(path.join(child.directory, 'execution.json'), child.execution);
  for (const [key, value] of [['taskId', 'task-other'], ['sessionId', 'session:other'],
    ['sourceStateSha256', 'f'.repeat(64)], ['sourceCommit', 'f'.repeat(40)]]) {
    await json(repair.receiptFile, { ...repair.receipt, [key]: value });
    await assert.rejects(context.store().list(), { code: 'PHASE_OUTPUT_SOURCE_INVALID' });
  }
  await json(repair.receiptFile, repair.receipt);
  const moved = path.join(context.root, 'moved-frontend-repair');
  await rename(repair.control, moved);
  await symlink(moved, repair.control, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(context.store().list(), { code: 'PHASE_OUTPUT_SOURCE_INVALID' });
});

test('lists real sealed browser packages with pagination and reads the original six document bytes while stopped', async (t) => {
  const context = await fixture(t);
  const older = await sealedAttempt(context, { legacyVersion: true });
  const newer = await sealedAttempt(context, { generation: 2, completedAt: '2026-09-15T09:00:00.000Z', decision: 'blocked' });
  const list = await context.store().list({ limit: 1 });
  assert.equal(list.items[0].packageId, newer.manifest.packageDigest);
  assert.equal(list.items[0].decision, 'blocked');
  assert.equal(list.hasMore, true);
  assert.equal(list.items[0].files.length, 6);
  assert.equal(list.items[0].files.find((file) => file.primary).name, '01-result.md');
  const next = await context.store().list({ offset: 1, limit: 1 });
  assert.equal(next.items[0].packageId, older.manifest.packageDigest);
  assert.equal(next.hasMore, false);
  for (const document of older.manifest.documents) {
    const file = await context.store().read({ packageId: older.manifest.packageDigest, name: document.path });
    assert.deepEqual(file.buffer, await readFile(path.join(older.packageDirectory, document.path)));
    assert.equal(file.sha256, sha256(file.buffer));
    assert.equal(file.bytes, file.buffer.length);
    assert.match(file.displayName, /[\u4e00-\u9fff]/u);
  }
  assert.deepEqual((await context.store().list({ offset: 2, limit: 1 })).items, []);
  await assert.rejects(context.store().list({ offset: -1 }), { code: 'INVALID_PHASE_OUTPUT_PAGE' });
  await assert.rejects(context.store().list({ limit: 101 }), { code: 'INVALID_PHASE_OUTPUT_PAGE' });
});

test('unbound shared legacy and absent browser outputs are explicit and never scan business directories', async (t) => {
  const context = await fixture(t);
  assert.equal((await context.store().list()).unavailable.code, 'PHASE_OUTPUTS_NOT_YET_AVAILABLE');
  const sealed = await sealedAttempt(context);
  await mkdir(path.join(context.taskRoot, 'workspace'), { recursive: true });
  await rename(path.join(context.control, 'browser-attempts'), path.join(context.taskRoot, 'workspace', 'browser-attempts'));
  assert.equal((await context.store().list()).items.length, 0);
  const { actorUserId: _ignored, ...legacy } = context.metadata;
  legacy.schemaVersion = 1;
  const store = createPhaseWorkPackageFiles({ taskspacesRoot: context.taskspacesRoot, projectSlug: legacy.projectSlug, taskMetadata: legacy });
  assert.equal((await store.list()).unavailable.code, 'PHASE_OUTPUTS_UNBOUND');
  await assert.rejects(store.read({ packageId: sealed.manifest.packageDigest, name: '01-result.md' }), { code: 'PHASE_OUTPUT_NOT_FOUND' });
});

test('rejects copied task, conversation and actor bindings and mismatched Controller identities', async (t) => {
  const context = await fixture(t);
  const sealed = await sealedAttempt(context);
  for (const [key, value] of [['taskId', 'task-other'], ['conversationId', 'conversation:other'], ['actorUsername', 'bob'],
    ['actorUserId', '22222222-2222-4222-8222-222222222222']]) {
    await json(path.join(sealed.directory, 'execution.json'), { ...sealed.execution, [key]: value });
    await assert.rejects(context.store().list(), { code: 'PHASE_OUTPUT_SOURCE_INVALID' });
  }
  await json(path.join(sealed.directory, 'execution.json'), sealed.execution);
  await json(path.join(sealed.directory, 'begin.json'), { ...sealed.begun, attempt: { ...sealed.begun.attempt, attemptId: crypto.randomUUID() } });
  await assert.rejects(context.store().list(), { code: 'PHASE_OUTPUT_SOURCE_INVALID' });
  await json(path.join(sealed.directory, 'begin.json'), sealed.begun);
  await json(path.join(sealed.output, 'controller-result.json'), { ...sealed.result, workPackageDigest: 'f'.repeat(64) });
  await assert.rejects(context.store().list(), { code: 'PHASE_OUTPUT_SOURCE_INVALID' });
  await json(path.join(sealed.output, 'controller-result.json'), sealed.result);
  await json(path.join(sealed.output, 'phase-receipt.json'), { ...sealed.receipt, completedAt: '2026-09-15T10:00:00.000Z' });
  await assert.rejects(context.store().list(), { code: 'PHASE_OUTPUT_SOURCE_INVALID' });
});

test('refuses truncated, oversized, redirected and noncanonical files', async (t) => {
  const context = await fixture(t);
  const sealed = await sealedAttempt(context);
  const file = path.join(sealed.packageDirectory, '01-result.md');
  const before = await readFile(file);
  await writeFile(file, before.subarray(0, before.length - 1));
  await assert.rejects(context.store().read({ packageId: sealed.manifest.packageDigest, name: '01-result.md' }), { code: 'PHASE_OUTPUT_PACKAGE_INVALID' });
  await writeFile(file, Buffer.alloc(512 * 1024 + 1, 65));
  await assert.rejects(context.store().list(), { code: 'PHASE_OUTPUT_SOURCE_INVALID' });
  await writeFile(file, before);
  await assert.rejects(context.store().read({ packageId: sealed.manifest.packageDigest, name: '../execution.json' }), { code: 'INVALID_PHASE_OUTPUT_PATH' });
  await assert.rejects(context.store().read({ packageId: 'f'.repeat(64), name: '01-result.md' }), { code: 'PHASE_OUTPUT_NOT_FOUND' });
  const moved = `${sealed.packageDirectory}-moved`;
  await rename(sealed.packageDirectory, moved);
  await symlink(moved, sealed.packageDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(context.store().list(), { code: 'PHASE_OUTPUT_SOURCE_INVALID' });
});

test('Manager authenticates phase reads, keeps stopped task state and returns the exact original download bytes', async (t) => {
  const context = await fixture(t);
  const sealed = await sealedAttempt(context);
  const token = 'm'.repeat(64);
  const before = await readFile(path.join(context.taskRoot, 'metadata.json'));
  const server = createConversationManager({ projectRoot: context.root, projectSlug: context.metadata.projectSlug,
    intakeRoot: path.join(context.root, 'intake'), controlScript: path.join(context.root, 'taskspacectl.sh'),
    managerToken: token, auditPath: path.join(context.root, 'audit.jsonl'),
    runControl: async () => { assert.fail('phase file reads must not control TaskSpaces'); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/v1/taskspaces/${context.metadata.taskId}/phase-outputs`;
  assert.equal((await fetch(base)).status, 401);
  const headers = { authorization: `Bearer ${token}` };
  const listing = await fetch(base, { headers });
  assert.equal(listing.status, 200);
  assert.equal((await listing.json()).items[0].packageId, sealed.manifest.packageDigest);
  const download = await fetch(`${base}/${sealed.manifest.packageDigest}/01-result.md`, { headers });
  assert.equal(download.status, 200);
  const data = await download.json();
  const bytes = Buffer.from(data.base64, 'base64');
  assert.deepEqual(bytes, await readFile(path.join(sealed.packageDirectory, '01-result.md')));
  assert.equal(data.sha256, sha256(bytes));
  assert.equal(data.bytes, bytes.length);
  assert.match(data.downloadName, /[\u4e00-\u9fff]/u);
  assert.equal((await fetch(`${base}?limit=2abc`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/${sealed.manifest.packageDigest}/..%2Fexecution.json`, { headers })).status, 400);
  assert.equal((await fetch(base.replace(context.metadata.taskId, 'task-other'), { headers })).status, 404);
  assert.deepEqual(await readFile(path.join(context.taskRoot, 'metadata.json')), before);
});
