import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { collectDeliverySnapshot, projectDeliverySnapshot } from '../docker/harness/delivery-center-projection.mjs';
import { importDeliverySources } from '../docker/harness/delivery-center-import.mjs';
import { validateDeliverySnapshot } from '../docker/harness/delivery-center-store.mjs';
import { deliveryAssetVersions, listDeliveryAssets } from '../docker/harness/delivery-center-assets.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const PROJECT = { projectSlug: 'forge-base', projectName: '平台合成示例', releaseAuditPath: null };
const DOC = 'code-copilot/changes/synthetic-checkpoint/spec.md';
const at = '2026-10-08T12:00:00.000Z';
const ids = { menu: 'fixture:menu', function: 'fixture:function', requirement: 'fixture:requirement' };
const metadata = (kind, revision) => ({ schemaVersion: 1, kind, id: ids[kind], revision,
  nature: 'design', adoption: { state: 'proposed', sources: [] },
  menuRefs: kind === 'menu' ? [] : [{ kind: 'menu', id: ids.menu, revision: null }] });
const definitions = revision => [
  { name: `${revision} 菜单`, menuPath: [revision], route: `/${revision}`, deliveryCenter: metadata('menu', revision) },
  { name: `${revision} 功能`, description: '来自原过程块的正文', deliveryCenter: metadata('function', revision) },
  { name: `${revision} 要求`, statement: '来自原过程块的要求', deliveryCenter: metadata('requirement', revision) },
];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-checkpoint-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const phaseRoot = path.join(root, 'delivery-phases'); await mkdir(phaseRoot);
  const brokerAuditPath = path.join(root, 'audit.jsonl'); await writeFile(brokerAuditPath, '');
  const audits = [];
  const saveAudits = () => writeFile(brokerAuditPath, audits.map(row => JSON.stringify(row)).join('\n'));
  async function add(taskId, revision, digit) {
    const commit = digit.repeat(40); const tree = 'f'.repeat(40);
    const payload = { schemaVersion: 1, operationId: `operation-${taskId}`,
      task: { projectSlug: PROJECT.projectSlug, taskId, conversationId: `conversation-${taskId}`, dshSessionId: `session-${taskId}` },
      from: { head: '0'.repeat(40), fingerprint: 'a'.repeat(64) }, to: { head: commit, fingerprint: 'b'.repeat(64) },
      canonicalHead: '0'.repeat(40), phase: 'checkpointed', sourceAuthority: { actionCeiling: 'git-checkpoint' },
      digestAlgorithm: 'sha256', digestEncoding: 'canonical-json-v1' };
    const sourceTransition = { ...payload, digest: hash(payload) };
    const envelope = { schemaVersion: 'forge-delivery-checkpoint-documents/v1', projectSlug: PROJECT.projectSlug,
      taskId, conversationId: payload.task.conversationId, dshSessionId: payload.task.dshSessionId,
      sourceCommit: commit, sourceTree: tree, sourceTransitionDigest: sourceTransition.digest, capturedAt: at,
      documents: [{ path: DOC, blob: 'e'.repeat(40), commit, committedAt: at, contentDigest: 'c'.repeat(64),
        line: 4, fenceLine: 3, records: definitions(revision) }] };
    const relativePath = `.committed-documents/${taskId}/${commit}.json`;
    const filename = path.join(phaseRoot, relativePath);
    const bytes = `${JSON.stringify(envelope)}\n`;
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes);
    const audit = { type: 'taskspace-checkpoint', action: 'checkpoint', operation: 'checkpoint',
      taskId, operationId: payload.operationId, conversationId: payload.task.conversationId,
      status: 'success', checkpointStatus: 'checkpointed', commit, tree, changedPaths: [DOC], sourceTransition,
      deliveryCenterDocuments: { status: 'captured', relativePath, sha256: hash(bytes), sourceCommit: commit, documentBlocks: 1 } };
    audits.push(audit); await saveAudits(); return { audit, envelope, filename, bytes };
  }
  return { root, project: { ...PROJECT, phaseRoot, brokerAuditPath }, audits, saveAudits, add };
}

test('checkpoint documents keep two parallel batches readable without replacing integrated definitions or inventing stages', async t => {
  const fixtureValue = await fixture(t); const { project, add, root } = fixtureValue;
  await add('task-one', 'local-one', '1'); await add('task-two', 'local-two', '2');
  const main = projectDeliverySnapshot({ ...PROJECT, documents: [{ path: DOC, blob: 'e'.repeat(40),
    commit: '0'.repeat(40), committedAt: at, contentDigest: 'c'.repeat(64), line: 4, fenceLine: 3,
    records: definitions('main'), isCurrent: true }] });
  const packet = { schemaVersion: 1, projectSlug: PROJECT.projectSlug, source: { kind: 'synthetic-integrated', revision: 'fixture-main' },
    menus: main.menus, requirements: main.requirements, requirementVersions: main.requirementVersions,
    assets: main.artifacts, currentAssetVersionIds: main.coverage.currentAssetVersionIds };
  const packetPath = path.join(root, 'main.json'); await writeFile(packetPath, JSON.stringify(packet));
  const snapshot = await collectDeliverySnapshot({ ...project, historyPacketPaths: [packetPath] });
  validateDeliverySnapshot(snapshot);
  assert.equal(snapshot.batches.length, 2); assert.equal(snapshot.stages.length, 0);
  assert.equal(snapshot.coverage.acceptedStages, 0);
  assert.equal(snapshot.coverage.gaps.some(row => row.code === 'STATE_UNAVAILABLE'), false);
  assert.equal(snapshot.menus.find(row => row.id === ids.menu).name, 'main 菜单');
  assert.equal(snapshot.menus.find(row => row.id === ids.menu).route, '/main');
  assert.deepEqual(snapshot.requirements, main.requirements);
  assert.deepEqual(snapshot.coverage.currentAssetVersionIds, main.coverage.currentAssetVersionIds);
  const versions = deliveryAssetVersions(snapshot.artifacts, snapshot.coverage);
  assert.equal(listDeliveryAssets({ versions, filters: { kind: 'function' } }).items[0].revision, 'main');
  for (const batch of snapshot.batches) {
    assert.equal(batch.sourceScope, 'taskspace-checkpoint'); assert.equal(batch.status, 'documented');
    assert.equal(batch.isCurrent, false); assert.match(batch.name, /^local-(?:one|two) 功能、local-(?:one|two) 要求 · 工作舱提交$/u);
    const result = listDeliveryAssets({ versions, menus: snapshot.menus, filters: { kind: 'function', batchId: batch.id } });
    assert.equal(result.total, 1); assert.equal(result.items[0].isCurrent, false);
    assert.equal(result.items[0].sourceScope, 'taskspace-checkpoint');
    assert.equal(result.items[0].status, 'documented'); assert.deepEqual(result.items[0].releaseIds, []);
    const requirement = snapshot.requirementVersions.filter(row => row.batchIds.includes(batch.id));
    assert.equal(requirement.length, 1); assert.equal(requirement[0].revision, result.items[0].revision);
    assert.deepEqual(requirement[0].stageStatus, {}); assert.equal(requirement[0].isCurrent, false);
    assert.equal(requirement[0].sources[0].dshSessionId, batch.sessionId);
    assert.equal(requirement[0].sources[0].commit, batch.sourceCommit);
    assert.equal(requirement[0].sources[0].blob, 'e'.repeat(40));
    assert.equal(requirement[0].sources[0].sourceTransitionDigest, batch.sourceTransitionDigest);
  }
  assert.deepEqual(snapshot.menus[0].variants.map(row => row.revision).sort(), ['local-one', 'local-two', 'main']);
});

test('checkpoint source tampering rejects replacement while legacy and failed capture audits stay honest', async t => {
  const { project, add, audits, saveAudits } = await fixture(t);
  audits.push({ type: 'taskspace-checkpoint', action: 'checkpoint', status: 'success', checkpointStatus: 'checkpointed', taskId: 'legacy-task' });
  audits.push({ type: 'taskspace-checkpoint', action: 'checkpoint', status: 'success', checkpointStatus: 'checkpointed',
    taskId: 'failed-task', commit: '3'.repeat(40), deliveryCenterDocuments: { status: 'failed', code: 'COMMITTED_DOCUMENT_INVALID_JSON' } });
  const saved = await add('task-one', 'local-one', '1');
  const stored = [];
  const store = { overview: async () => ({ counts: { stages: 0 } }), importSnapshot: async snapshot => {
    validateDeliverySnapshot(snapshot); stored.push(snapshot); return { projectSlug: PROJECT.projectSlug, changed: true }; } };
  const first = await importDeliverySources({ store, projects: [project] });
  assert.equal(first.ok, true); assert.equal(stored.length, 1);
  assert.equal(stored[0].coverage.gaps.some(row => row.code === 'CHECKPOINT_DOCUMENT_CAPTURE_FAILED'), true);
  assert.equal(stored[0].requirements.length, 0); assert.equal(stored[0].requirementVersions.length, 1);
  await writeFile(saved.filename, `${saved.bytes} `);
  const rejected = await importDeliverySources({ store, projects: [project] });
  assert.equal(rejected.ok, false); assert.equal(rejected.results[0].code, 'CHECKPOINT_DOCUMENT_SOURCE_CHANGED');
  assert.equal(rejected.results[0].preservedPreviousSnapshot, true); assert.equal(stored.length, 1);
  await writeFile(saved.filename, saved.bytes);
  saved.audit.sourceTransition.task.dshSessionId = 'session-other'; await saveAudits();
  await assert.rejects(collectDeliverySnapshot(project), /CHECKPOINT_DOCUMENT_ARTIFACT_INVALID/u);
  // Even an envelope with a matching byte hash cannot switch the task/session
  // identity recorded by the successful source transition.
  saved.audit.sourceTransition.task.dshSessionId = 'session-task-one';
  saved.envelope.dshSessionId = 'session-other';
  const bytes = JSON.stringify(saved.envelope); await writeFile(saved.filename, bytes);
  saved.audit.deliveryCenterDocuments.sha256 = hash(bytes); await saveAudits();
  await assert.rejects(collectDeliverySnapshot(project), /CHECKPOINT_DOCUMENT_ARTIFACT_INVALID/u);
});

test('checkpoint capture gaps expose safe source correction locations without inventing legacy details or recovery', async t => {
  const { project, audits, saveAudits } = await fixture(t);
  const failed = capture => ({ type: 'taskspace-checkpoint', action: 'checkpoint', status: 'success',
    checkpointStatus: 'checkpointed', taskId: 'failed-task', commit: '3'.repeat(40), changedPaths: [DOC],
    deliveryCenterDocuments: { status: 'failed', ...capture } });
  audits.push(failed({ code: 'COMMITTED_DOCUMENT_INVALID_JSON', path: DOC, fenceLine: 12, line: 13,
    reason: 'invalid-metadata', recordIndex: 1, message: 'not copied: source body' }));
  audits.push(failed({ code: 'COMMITTED_DOCUMENT_INVALID_JSON', recovery: 'same-committed-source' }));
  audits.push(failed({ code: 'CHECKPOINT_DOCUMENT_CAPTURE_FAILED', path: '/private/source.md',
    fenceLine: 1, line: 2, reason: 'not copied: source body', recovery: 'same-committed-source' }));
  await saveAudits();
  const snapshot = await collectDeliverySnapshot(project);
  const gaps = snapshot.coverage.gaps.filter(row => row.code === 'CHECKPOINT_DOCUMENT_CAPTURE_FAILED');
  assert.equal(gaps.length, 3);
  assert.equal(gaps[0].sourcePath, DOC); assert.equal(gaps[0].fenceLine, 12); assert.equal(gaps[0].line, 13);
  assert.equal(gaps[0].reason, 'invalid-metadata'); assert.equal(gaps[0].recordIndex, 1); assert.equal(gaps[0].recovery, 'source-correction-required');
  assert.match(gaps[0].recoveryMessage, /原失败提交保留/);
  assert.equal(gaps[1].sourcePath, null); assert.equal(gaps[1].reason, null);
  assert.equal(gaps[1].recovery, 'source-correction-required');
  assert.equal(gaps[2].sourcePath, null); assert.equal(gaps[2].fenceLine, null);
  assert.equal(gaps[2].reason, null); assert.equal(gaps[2].recovery, 'cause-resolution-required');
  assert.doesNotMatch(JSON.stringify(gaps), /private\/source|not copied: source body/);
  assert.equal(snapshot.coverage.availability, 'partial');
  assert.equal(snapshot.batches.length, 0); assert.equal(snapshot.artifacts.length, 0);
});
