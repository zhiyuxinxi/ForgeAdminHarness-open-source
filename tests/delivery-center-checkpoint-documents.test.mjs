import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { captureDeliveryCheckpointDocuments } from '../docker/harness/delivery-center-checkpoint-documents.mjs';
import { parseDeliveryDocumentDefinitions, collectCommittedDeliveryDocuments, deliveryDocumentDiagnostic } from '../docker/harness/delivery-center-document-source.mjs';
import { sourceTransitionCanonicalDigest, hashTaskspaceToken } from '../docker/harness/taskspace-policy.mjs';
import { TaskspaceBroker } from '../docker/harness/taskspace-broker.mjs';
import { classifyPinnedDshPromptBody, digestProductionTaskAuthorityBinding,
  prepareProtectedExecutionContext, readProtectedExecutionContext } from '../docker/harness/forge-execution-context.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
import { inventoryWorkspace } from '../docker/harness/verification-runner.mjs';
import { VERIFY_PROFILE_NAMES } from '../docker/harness/verify-policy.mjs';

const DOC = 'code-copilot/changes/platform-fixture/spec.md';
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-c', `safe.directory=${root}`, '-C', root, ...args],
  { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const record = { name: '平台夹具要求，非客户定义', statement: '保留这一条已提交共享定义。',
  deliveryCenter: { schemaVersion: 1, id: 'fixture.requirement.one', kind: 'requirement', nature: 'design' } };
const content = `PRIVATE-OUTSIDE-BLOCK\n\n\`\`\`json delivery-center\n${JSON.stringify(record)}\n\`\`\`\nPRIVATE-AFTER-BLOCK\n`;
const limits = { maxFiles: 250000, maxBytes: 4 * 1024 ** 3, maxLogBytes: 8 * 1024 ** 2, defaultTimeoutSeconds: 900 };

async function fixture(t) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'delivery-checkpoint-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const repositoryRoot = path.join(projectRoot, 'workspace');
  const stateRoot = path.join(projectRoot, 'taskspaces', '.broker');
  await mkdir(repositoryRoot, { recursive: true }); await mkdir(stateRoot, { recursive: true });
  git(repositoryRoot, 'init'); git(repositoryRoot, 'config', 'user.name', 'Platform Fixture');
  git(repositoryRoot, 'config', 'user.email', 'fixture@example.invalid'); git(repositoryRoot, 'config', 'core.autocrlf', 'false');
  git(repositoryRoot, 'config', 'commit.gpgsign', 'false');
  await mkdir(path.join(projectRoot, 'empty-hooks')); git(repositoryRoot, 'config', 'core.hooksPath', path.join(projectRoot, 'empty-hooks'));
  await writeFile(path.join(repositoryRoot, 'base.txt'), 'base\n');
  git(repositoryRoot, 'add', '.'); git(repositoryRoot, 'commit', '-m', 'platform fixture base');
  const base = git(repositoryRoot, 'rev-parse', 'HEAD');
  const commit = async text => {
    await mkdir(path.dirname(path.join(repositoryRoot, DOC)), { recursive: true });
    await writeFile(path.join(repositoryRoot, DOC), text);
    git(repositoryRoot, 'add', '--', DOC); git(repositoryRoot, 'commit', '-m', 'platform fixture document');
    return git(repositoryRoot, 'rev-parse', 'HEAD');
  };
  return { projectRoot, repositoryRoot, stateRoot, base, commit };
}

function transition(base, commit, projectSlug = 'forge-base') {
  const value = { schemaVersion: 1, operationId: randomUUID(), task: { projectSlug,
    taskId: 'fixture-task', actorUserId: '11111111-1111-4111-8111-111111111111', actorUsername: 'fixture',
    conversationId: 'fixture-conversation', dshSessionId: 'session:fixture' },
  from: { head: base, fingerprint: 'a'.repeat(64) }, to: { head: commit, fingerprint: 'b'.repeat(64) },
  canonicalHead: base, phase: 'checkpointed', sourceAuthority: { executionId: randomUUID(), generation: 1,
    contractId: 'c'.repeat(64), productionAuthorityDigest: 'd'.repeat(64), controllerGrantDigest: 'e'.repeat(64),
    actionCeiling: 'git-checkpoint', issuedAt: '2026-10-08T00:00:00Z', expiresAt: '2026-10-08T01:00:00Z' },
  digestAlgorithm: 'sha256', digestEncoding: 'canonical-json-v1' };
  return { ...value, digest: sourceTransitionCanonicalDigest(value) };
}

test('document parse diagnostics distinguish source failures with safe block locations and no body disclosure', () => {
  const invalidRecord = { ...record, name: 'PRIVATE_SOURCE_BODY', deliveryCenter: { ...record.deliveryCenter, kind: 'statement' } };
  const cases = [
    ['invalid-json', '{PRIVATE_SOURCE_BODY', true, undefined],
    ['invalid-metadata', JSON.stringify([record, invalidRecord]), true, 1],
    ['unterminated-fence', JSON.stringify(record), false, undefined],
  ];
  for (const [reason, body, closed, recordIndex] of cases) {
    const input = `PRIVATE_OUTSIDE\n\n\`\`\`json delivery-center\n${body}\n${closed ? '\`\`\`\n' : ''}`;
    assert.throws(() => parseDeliveryDocumentDefinitions(input, { path: DOC, content: 'PRIVATE_SOURCE_BODY' }), error => {
      assert.equal(error.code, 'COMMITTED_DOCUMENT_INVALID_JSON'); assert.equal(error.reason, reason);
      assert.equal(error.path, DOC); assert.equal(error.fenceLine, 3); assert.equal(error.line, 4);
      assert.equal(error.recordIndex, recordIndex);
      assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE_SOURCE_BODY|PRIVATE_OUTSIDE/u);
      assert.deepEqual(Object.keys(error).sort(), ['code','reason','path','fenceLine','line', ...(recordIndex === undefined ? [] : ['recordIndex'])].sort());
      return true;
    });
  }
  for (const unsafe of ['/private/spec.md', 'C:\\private\\spec.md', 'code-copilot/changes/../private.md', 'code-copilot/changes/./private.md', 'code-copilot/changes//private.md', `code-copilot/changes/${'x'.repeat(512)}.md`]) {
    assert.equal(deliveryDocumentDiagnostic({ path: unsafe, reason: 'invalid-json', content: 'PRIVATE_SOURCE_BODY', command: 'PRIVATE_COMMAND' }).path, undefined);
  }
  assert.deepEqual(deliveryDocumentDiagnostic({ reason: 'PRIVATE_SOURCE_BODY', path: DOC, fenceLine: -1, line: 0, recordIndex: 9, content: 'PRIVATE_SOURCE_BODY' }), { path: DOC });
});

test('checkpoint source diagnostics survive fixed Git capture and historical collection without promising blind retry', async t => {
  const f = await fixture(t);
  const bad = { ...record, name: 'PRIVATE_SOURCE_BODY', deliveryCenter: { ...record.deliveryCenter, kind: 'statement' } };
  const invalidCommit = await f.commit(`PRIVATE_OUTSIDE\n\n\`\`\`json delivery-center\n${JSON.stringify([record, bad])}\n\`\`\`\n`);
  const options = { ...f, commit: invalidCommit, tree: git(f.repositoryRoot, 'rev-parse', `${invalidCommit}^{tree}`), sourceTransition: transition(f.base, invalidCommit), changedPaths: [DOC] };
  const failed = await captureDeliveryCheckpointDocuments(options);
  assert.equal(failed.code, 'COMMITTED_DOCUMENT_INVALID_JSON'); assert.equal(failed.reason, 'invalid-metadata');
  assert.equal(failed.recovery, 'source-correction-required'); assert.equal(failed.path, DOC);
  assert.equal(failed.fenceLine, 3); assert.equal(failed.line, 4); assert.equal(failed.recordIndex, 1);
  assert.match(failed.message, /记录类型不受支持/u); assert.match(failed.message, /重复采集原提交不能修复/u);
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_SOURCE_BODY|PRIVATE_OUTSIDE/u);
  await writeFile(path.join(f.repositoryRoot, DOC), content);
  assert.deepEqual(await captureDeliveryCheckpointDocuments(options), failed, 'a corrected worktree cannot change the diagnosis of the fixed bad commit');
  const correctedCommit = await f.commit(content);
  const collected = await collectCommittedDeliveryDocuments({ repositoryRoot: f.repositoryRoot });
  const historical = collected.coverage.invalidHistoricalDefinitions.find(row => row.commit === invalidCommit);
  assert.deepEqual({ reason: historical.reason, path: historical.path, fenceLine: historical.fenceLine, line: historical.line, recordIndex: historical.recordIndex },
    { reason: 'invalid-metadata', path: DOC, fenceLine: 3, line: 4, recordIndex: 1 });
  assert.doesNotMatch(JSON.stringify(historical), /PRIVATE_SOURCE_BODY|PRIVATE_OUTSIDE/u);
  const blockedRoot = path.join(f.projectRoot, 'blocked-storage'); await writeFile(blockedRoot, 'occupied');
  const storageFailure = await captureDeliveryCheckpointDocuments({ ...options, commit: correctedCommit, tree: git(f.repositoryRoot, 'rev-parse', `${correctedCommit}^{tree}`), sourceTransition: transition(f.base, correctedCommit), stateRoot: blockedRoot });
  assert.equal(storageFailure.status, 'failed'); assert.equal(storageFailure.recovery, 'cause-resolution-required');
  assert.equal(storageFailure.reason, undefined); assert.match(storageFailure.message, /先排查并解除/u);
  assert.notEqual(storageFailure.recovery, 'same-committed-source');
});

test('checkpoint capture reads only fixed committed shared blocks and preserves immutable identity on retry', async t => {
  const f = await fixture(t); const commit = await f.commit(content);
  await writeFile(path.join(f.repositoryRoot, DOC), 'UNCOMMITTED PRIVATE TEXT');
  await mkdir(path.join(f.repositoryRoot, 'uploads')); await writeFile(path.join(f.repositoryRoot, 'uploads', 'private.md'), content);
  const options = { ...f, commit, tree: git(f.repositoryRoot, 'rev-parse', `${commit}^{tree}`),
    sourceTransition: transition(f.base, commit), changedPaths: [DOC, 'uploads/private.md'], now: () => '2026-10-08T01:00:00Z' };
  const result = await captureDeliveryCheckpointDocuments(options);
  assert.equal(result.status, 'captured'); assert.equal(result.documentBlocks, 1);
  const filename = path.join(f.stateRoot, 'delivery-phases', result.relativePath);
  const bytes = await readFile(filename); const envelope = JSON.parse(bytes);
  assert.equal(result.sha256, sha(bytes)); assert.equal(envelope.schemaVersion, 'forge-delivery-checkpoint-documents/v1');
  assert.equal(envelope.sourceTransitionDigest, options.sourceTransition.digest);
  assert.equal(envelope.dshSessionId, 'session:fixture'); assert.equal(envelope.sourceTree, options.tree);
  assert.equal(envelope.documents[0].contentDigest, sha(content));
  assert.equal(envelope.documents[0].blob, git(f.repositoryRoot, 'rev-parse', `${commit}:${DOC}`));
  assert.equal(envelope.documents[0].line, 4); assert.equal(envelope.documents[0].fenceLine, 3);
  assert.deepEqual(envelope.documents[0].records, [record]);
  assert.doesNotMatch(bytes.toString(), /PRIVATE|UNCOMMITTED|uploads/u);
  assert.deepEqual(await captureDeliveryCheckpointDocuments({ ...options, now: () => '2026-10-09T00:00:00Z' }), result);
  assert.deepEqual(await readFile(filename), bytes);
  await writeFile(filename, `${JSON.stringify({ ...envelope, conversationId: 'wrong' })}\n`);
  const originalBad = await readFile(filename);
  const mismatch = await captureDeliveryCheckpointDocuments(options);
  assert.equal(mismatch.status, 'failed'); assert.equal(mismatch.code, 'CHECKPOINT_DOCUMENT_EXISTING_MISMATCH');
  assert.deepEqual(await readFile(filename), originalBad);
  const disabled = await captureDeliveryCheckpointDocuments({ ...options, stateRoot: path.join(f.projectRoot, 'must-not-create'),
    sourceTransition: transition(f.base, commit, 'other-project') });
  assert.equal(disabled.status, 'not-applicable'); assert.equal(disabled.reason, 'project-not-enabled');
  await assert.rejects(readFile(path.join(f.projectRoot, 'must-not-create')), { code: 'ENOENT' });
  const noDocument = await captureDeliveryCheckpointDocuments({ ...options, changedPaths: ['src/feature.js'] });
  assert.equal(noDocument.status, 'not-applicable');
});

async function brokerFixture(t, invalidDocument = false) {
  const f = await fixture(t); const taskId = 'fixture-task'; const actorId = 'fixture';
  const actorUserId = '11111111-1111-4111-8111-111111111111'; const conversationId = 'fixture-conversation';
  const taskRoot = path.join(f.projectRoot, 'taskspaces', taskId); const workspace = path.join(taskRoot, 'workspace');
  await mkdir(taskRoot, { recursive: true });
  execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '--no-hardlinks', f.repositoryRoot, workspace], { stdio: 'pipe', windowsHide: true });
  git(workspace, 'config', 'user.name', actorId); git(workspace, 'config', 'user.email', 'fixture@example.invalid');
  git(workspace, 'config', 'core.autocrlf', 'false'); git(workspace, 'checkout', '-b', `task/${actorId}/${taskId}`);
  const token = 'a'.repeat(64); const now = Date.now();
  const metadata = { schemaVersion: 2, projectSlug: 'forge-base', taskId, actorId, actorUserId, conversationId,
    branch: `task/${actorId}/${taskId}`, baseCommit: f.base, status: 'active', createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(), accessTokenHash: hashTaskspaceToken(token), harnessPort: 21000, accessMode: 'conversation' };
  await writeFile(path.join(taskRoot, 'metadata.json'), JSON.stringify(metadata));
  await mkdir(path.join(f.projectRoot, 'verification'));
  await writeFile(path.join(f.projectRoot, 'verification', 'contract.json'), JSON.stringify({ schemaVersion: 1,
    projectSlug: 'forge-base', runnerRevision: 'test-runner-v1', toolchainImage: `test.invalid/forge@sha256:${'f'.repeat(64)}`,
    cacheRoot: path.join(f.projectRoot, 'verification', 'cache'), stateRoot: path.join(f.projectRoot, 'verification', 'state'),
    profiles: VERIFY_PROFILE_NAMES, limits }));
  await mkdir(path.dirname(path.join(workspace, DOC)), { recursive: true });
  await writeFile(path.join(workspace, DOC), invalidDocument ? '```json delivery-center\ninvalid\n```\n' : content);
  const source = await inventoryWorkspace(workspace, limits);
  const prompt = '提交当前精确改动。'; const actionCeiling = 'git-checkpoint'; const ownedPaths = [DOC];
  const classified = classifyPinnedDshPromptBody(Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'rpc:checkpoint-doc',
    method: 'session.prompt', payload: { sessionId: 'session:fixture', mode: 'queue', content: [{ type: 'text', text: prompt }] } })), 'session.prompt');
  const taskAuthority = { actionCeiling, ownedPaths, taskProfiles: ['requirements'] };
  const contract = compileForgeTaskExecutionContract({ prompt, ...taskAuthority });
  const authority = { projectSlug: 'forge-base', taskId, actorUserId, actorUsername: actorId, conversationId,
    dshSessionId: classified.dshSessionId, route: classified.route, rpcId: classified.rpcId, promptDigest: classified.textDigest,
    sourceCommit: f.base, workspaceFingerprint: source.workspaceFingerprint, caseFamily: 'maintenance',
    productionAuthorityId: randomUUID(), controllerGrantDigest: '3'.repeat(64), contractId: contract.contractId, actionCeiling, ownedPaths };
  await prepareProtectedExecutionContext({ projectRoot: f.projectRoot, projectSlug: 'forge-base', taskMetadata: metadata,
    request: { ...classified, actorUserId, actorUsername: actorId, conversationId, requestId: 'request:checkpoint-doc' }, now,
    policyPath: path.resolve('docker/harness/forge-execution-policy.json'), trustedPolicyInput: { profile: 'production-controller',
      sourceCommit: f.base, workspaceFingerprint: source.workspaceFingerprint, caseFamily: authority.caseFamily,
      productionAuthorityId: authority.productionAuthorityId, productionAuthorityDigest: digestProductionTaskAuthorityBinding(authority),
      controllerGrantDigest: authority.controllerGrantDigest, expectedContractId: contract.contractId, taskAuthority } });
  await readProtectedExecutionContext({ projectRoot: f.projectRoot, taskMetadata: metadata, now: now + 1,
    lookup: { projectSlug: 'forge-base', taskId, conversationId, actorUserId, dshSessionId: classified.dshSessionId,
      rpcId: classified.rpcId, textDigest: classified.textDigest } });
  return { ...f, workspace, token, source };
}

test('normal authorized Broker checkpoint audits automatic capture without publishing unmarked prose', async t => {
  const f = await brokerFixture(t);
  const broker = new TaskspaceBroker({ projectRoot: f.projectRoot, projectSlug: 'forge-base' });
  const result = await broker.executeAuthenticated(f.token, { action: 'checkpoint', paths: [DOC], message: 'Share fixture definition',
    expectedHead: f.base, expectedWorkspaceFingerprint: f.source.workspaceFingerprint });
  assert.equal(result.status, 'checkpointed'); assert.equal(result.deliveryCenterDocuments.status, 'captured');
  assert.equal(git(f.workspace, 'rev-parse', 'HEAD'), result.commit);
  const audit = JSON.parse((await readFile(path.join(f.stateRoot, 'audit.jsonl'), 'utf8')).trim().split('\n').at(-1));
  assert.equal(audit.status, 'success'); assert.equal(audit.checkpointStatus, 'checkpointed');
  assert.deepEqual(audit.deliveryCenterDocuments, result.deliveryCenterDocuments);
  const packet = JSON.parse(await readFile(path.join(f.stateRoot, 'delivery-phases', result.deliveryCenterDocuments.relativePath), 'utf8'));
  assert.equal(packet.sourceTransitionDigest, result.sourceTransition.digest); assert.equal(packet.sourceCommit, result.commit);
});

test('failed extraction and storage remain capture warnings after successful commits; same source can recover without a new commit', async t => {
  for (const failureMode of ['invalid-json', 'storage']) {
    const f = await brokerFixture(t, failureMode === 'invalid-json');
    const blockedDirectory = path.join(f.stateRoot, 'delivery-phases', '.committed-documents');
    if (failureMode === 'storage') {
      await mkdir(path.dirname(blockedDirectory), { recursive: true }); await writeFile(blockedDirectory, 'occupied');
    }
    const broker = new TaskspaceBroker({ projectRoot: f.projectRoot, projectSlug: 'forge-base' });
    const result = await broker.executeAuthenticated(f.token, { action: 'checkpoint', paths: [DOC], message: 'Commit remains independent',
      expectedHead: f.base, expectedWorkspaceFingerprint: f.source.workspaceFingerprint });
    assert.equal(result.status, 'checkpointed'); assert.equal(result.deliveryCenterDocuments.status, 'failed');
    assert.equal(git(f.workspace, 'rev-parse', 'HEAD'), result.commit); assert.equal(git(f.workspace, 'status', '--porcelain'), '');
    const audit = JSON.parse((await readFile(path.join(f.stateRoot, 'audit.jsonl'), 'utf8')).trim().split('\n').at(-1));
    assert.equal(audit.status, 'success'); assert.equal(audit.deliveryCenterDocuments.status, 'failed');
    assert.equal(audit.sourceTransition.task.dshSessionId, 'session:fixture');
    if (failureMode === 'storage') {
      await rm(blockedDirectory);
      const recovered = await captureDeliveryCheckpointDocuments({ stateRoot: f.stateRoot, repositoryRoot: f.workspace,
        sourceTransition: result.sourceTransition, commit: result.commit, tree: result.tree, changedPaths: result.changedPaths });
      assert.equal(recovered.status, 'captured'); assert.equal(git(f.workspace, 'rev-parse', 'HEAD'), result.commit);
    }
  }
});
