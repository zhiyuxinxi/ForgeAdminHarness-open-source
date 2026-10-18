import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import test from 'node:test';
import { collectDeliverySnapshot, projectDeliverySnapshot, DELIVERY_PHASES } from '../docker/harness/delivery-center-projection.mjs';
import { DeliveryCenterStore, validateDeliverySnapshot } from '../docker/harness/delivery-center-store.mjs';
import { deliverySummary } from '../docker/harness/delivery-center-views.mjs';

const NOW = '2026-10-07T03:00:00.000Z';
const SOURCE = 'a'.repeat(40);
const PROJECT = { projectSlug: 'example-project', projectName: '示例项目', observedAt: NOW };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const sha = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const seal = (value, key) => ({ ...value, [key]: sha(value) });
function artifact(kind, phaseId, payload, attemptId = 'attempt-one') {
  return seal({ schemaVersion: 'forge-delivery-phase-artifact/v1', workflowId: 'crud-production', phaseId,
    artifactKind: kind, attemptId, sourceFingerprint: 'b'.repeat(64), upstreamArtifactDigests: {},
    unresolvedDecisions: [], changedPaths: [], patchDigest: null, payload }, 'artifactDigest');
}
function record(taskId, artifacts, override = {}) {
  return { artifacts, depth: 0, isCurrent: true, state: seal({ schemaVersion: 'forge-delivery-phase-state/v2', taskId,
    sessionId: `session-${taskId}`, workflowId: 'crud-production', sourceCommit: SOURCE, status: 'active',
    currentPhaseId: 'domain-contract', activeAttempt: null, revision: 3, createdAt: NOW, updatedAt: NOW,
    acceptedArtifacts: Object.fromEntries(artifacts.map(item => [item.artifactKind, item.artifactDigest])),
    history: artifacts.map(item => ({ phaseId: item.phaseId, artifactDigest: item.artifactDigest,
      decision: 'accepted', completedAt: NOW, receiptDigest: sha(item.artifactDigest) })), ...override }, 'stateDigest') };
}
const requirement = (description = '按名称查询设备') => ({ menuPath: ['设备管理', '设备台账'], page: '设备台账',
  id: 'REQ-001', name: '查询设备', description, fields: [{ field: 'name', label: '设备名称', required: false }],
  actions: [{ key: 'search', label: '查询' }], rules: ['支持名称模糊匹配'] });

test('menu-first projection retains successive requirement revisions without automatically declaring an iteration conflict', () => {
  const first = artifact('requirements-contract', 'requirements', { useCases: [requirement()] });
  const same = artifact('requirements-contract', 'requirements', { requirements: [requirement()] });
  const conflicting = artifact('requirements-contract', 'requirements', { features: [requirement('仅允许按完整名称查询')] });
  const snapshot = projectDeliverySnapshot({ ...PROJECT, records: [record('task-one', [first]), record('task-two', [same]), record('task-three', [conflicting])] });
  assert.equal(snapshot.requirements.length, 1);
  const row = snapshot.requirements[0];
  assert.deepEqual(row.menuPath, ['设备管理', '设备台账']);
  assert.equal(row.batchIds.length, 3);
  assert.equal(row.sources.length, 3);
  assert.equal(row.variants.length, 3);
  assert.equal(row.status, 'documented');
  assert.equal(snapshot.coverage.conflicts, 0);
  assert.equal(row.description, '按名称查询设备');
  assert.equal(row.stageStatus.requirements, 'accepted');
  assert.equal(row.stageStatus.frontend, undefined);
  assert.equal(snapshot.menus.length, 2);
  const leaf = snapshot.menus.find(item => item.name === '设备台账');
  assert.equal(snapshot.menus.find(item => item.name === '设备管理').id, leaf.parentId);
  assert.equal(projectDeliverySnapshot({ ...PROJECT, records: [record('task-one', [first])] }).requirements[0].id, row.id);
  assert.equal(validateDeliverySnapshot(snapshot).requirements.length, 1);
});

test('array, object, markdown and explicit menu hierarchy are readable while unknown mappings remain unclassified', () => {
  const payload = { useCases: [{ id: 'UC-1', name: '登记巡检', outcome: '留存巡检结果' }],
    requirementTrace: { authoritativeInputs: ['需求材料'], coverageStatus: { delivered: false } },
    requirementMatrix: '| 一级菜单 | 二级菜单 | 功能点 | 需求说明 |\n| --- | --- | --- | --- |\n| 设备管理 | 巡检记录 | 查询巡检 | 按日期筛选 |',
    menus: [{ name: '物资管理', children: [{ name: '领用记录', features: [{ id: 'REC-1', name: '查看记录', description: '只读列表' }] }] }],
    requirements: { 'REQ-MAP': { name: '对象型需求', menuPath: ['设备管理', '设备台账'] } } };
  const snapshot = projectDeliverySnapshot({ ...PROJECT, records: [record('task-one', [artifact('requirements-contract', 'requirements', payload)])] });
  assert.deepEqual(snapshot.requirements.find(item => item.name === '查询巡检').menuPath, ['设备管理', '巡检记录']);
  assert.deepEqual(snapshot.requirements.find(item => item.name === '查看记录').menuPath, ['物资管理', '领用记录']);
  assert.deepEqual(snapshot.requirements.find(item => item.name === '登记巡检').menuPath, ['未分类需求']);
  assert.equal(snapshot.coverage.unmappedRequirements, 1);
  assert.equal(snapshot.coverage.availability, 'partial');
  assert.deepEqual(snapshot.requirements.find(item => item.name === '对象型需求').menuPath, ['设备管理', '设备台账']);
  assert.equal(validateDeliverySnapshot(snapshot).requirements.find(item => item.name === '登记巡检').page, null);
});

test('current artifact digest wins over obsolete accepted history and proposals never become accepted requirements', () => {
  const old = artifact('requirements-contract', 'requirements', { requirements: [requirement('旧需求')] });
  const current = artifact('requirements-contract', 'requirements', { requirements: [requirement('当前需求')] }, 'attempt-two');
  const pending = artifact('ui-interaction-contract', 'ui-design', { fields: [{ field: 'private', label: '尚未接受' }] });
  const input = record('task-one', [old, current, pending], { acceptedArtifacts: { 'requirements-contract': current.artifactDigest },
    history: [{ phaseId: 'requirements', artifactDigest: old.artifactDigest, decision: 'accepted', completedAt: NOW },
      { phaseId: 'requirements', artifactDigest: current.artifactDigest, decision: 'accepted', completedAt: NOW }] });
  const snapshot = projectDeliverySnapshot({ ...PROJECT, records: [input] });
  assert.equal(snapshot.requirements.length, 1);
  assert.equal(snapshot.requirements[0].description, '当前需求');
  assert.equal(snapshot.stages.find(item => item.digest === old.artifactDigest).status, 'historical');
  assert.equal(snapshot.stages.find(item => item.digest === pending.artifactDigest).status, 'draft');
  assert.equal(snapshot.coverage.acceptedStages, 1);
  current.payload.requirements[0].description = '摘要已不匹配';
  const invalid = projectDeliverySnapshot({ ...PROJECT, records: [input] });
  assert.equal(invalid.requirements.length, 0);
  assert.ok(invalid.coverage.gaps.some(item => item.code === 'ARTIFACT_INVALID'));
});

test('accepted UI fields can bind an explicitly identified single menu and projection strips credentials and raw diagnostics', () => {
  const req = artifact('requirements-contract', 'requirements', { requirements: [{ ...requirement(), fields: [], actions: [] }], privateChat: 'never show this chat' });
  const menu = artifact('access-wiring-implementation', 'access-wiring', { menuSeed: { resourceName: '设备台账', parent: { name: '设备管理' }, path: '/equipment' } });
  const ui = artifact('ui-interaction-contract', 'ui-design', { fields: [{ field: 'serial', label: '设备编号', required: true, password: 'do-not-publish' }],
    actions: [{ key: 'view', label: '查看' }], permissionBindings: { menu: 'equipment:view' },
    states: { error: 'password=verysecret' }, rawChat: 'hidden native chat', connectionString: 'mysql://root:secret@host' });
  const snapshot = projectDeliverySnapshot({ ...PROJECT, records: [record('task-one', [req, ui, menu])] });
  assert.equal(snapshot.requirements[0].fields[0].field, 'serial');
  assert.equal(snapshot.requirements[0].stageStatus['ui-design'], 'accepted');
  assert.doesNotMatch(JSON.stringify(snapshot), /do-not-publish|verysecret|never show|hidden native|root:secret/);
  assert.match(JSON.stringify(snapshot), /敏感内容已隐藏/u);
});

test('more than 300 dynamic fields, long descriptions and deep explicit menu paths are preserved without silent truncation', () => {
  const fields = Object.fromEntries(Array.from({ length: 350 }, (_, index) => [`customField${index}`, {
    label: `字段${index}`, wireType: 'string', customValidation: { fullLength: index + 1 },
  }]));
  fields.secretCredential = 'never-publish';
  const longDescription = '完整需求描述'.repeat(1000);
  const menuPath = Array.from({ length: 10 }, (_, index) => `菜单${index + 1}`);
  const value = artifact('requirements-contract', 'requirements', { requirements: [{ name: '大字段表单', menuPath, description: longDescription, fields }] });
  const snapshot = projectDeliverySnapshot({ ...PROJECT, records: [record('task-one', [value])] });
  const row = snapshot.requirements[0];
  assert.equal(row.fields.length, 350);
  assert.equal(row.fields.at(-1).name, 'customField349');
  assert.equal(row.fields.at(-1).customValidation.fullLength, 350);
  assert.equal(row.description, longDescription);
  assert.deepEqual(row.menuPath, menuPath);
  assert.doesNotMatch(JSON.stringify(snapshot), /never-publish/u);
  assert.equal(validateDeliverySnapshot(snapshot).requirements[0].fields.length, 350);
  const tooLongName = artifact('requirements-contract', 'requirements', { requirements: [{ name: '长'.repeat(513) }] });
  const limited = projectDeliverySnapshot({ ...PROJECT, records: [record('task-one', [tooLongName])] });
  assert.equal(limited.coverage.availability, 'partial');
  assert.deepEqual(limited.coverage.gaps.map(item => item.code), ['PROJECTION_LIMIT']);
});

test('only real release terminal audits form versions; base commits and task IDs do not invent historical functionality', () => {
  const actual = { type: 'controlled-release', jobId: 'job-one', status: 'success', projectSlug: PROJECT.projectSlug,
    version: 'release-20261007', commit: SOURCE, completedAt: NOW, services: ['forge-admin', 'forge-ui', 'mysql'],
    provenance: { taskId: 'task-one', candidateCommit: SOURCE },
    images: { 'forge-admin': { image: 'registry/example:release-one', id: `sha256:${'c'.repeat(64)}` } },
    approvalRef: 'private approval text', rollbackEnv: '/private/path' };
  const snapshot = projectDeliverySnapshot({ ...PROJECT, records: [record('task-one', [artifact('requirements-contract', 'requirements', { requirements: [requirement()] })])],
    releases: [actual, { ...actual, type: 'candidate-preparation', jobId: 'prepared-one', status: 'prepared' },
      { ...actual, jobId: 'other-project', projectSlug: 'someone-else' }, { type: 'controlled-release', jobId: 'failed-one', status: 'failed', completedAt: NOW }] });
  assert.equal(snapshot.releases.length, 2);
  const release = snapshot.releases.find(item => item.jobId === 'job-one');
  assert.equal(release.scopeBinding, 'unknown');
  assert.deepEqual(release.requirementIds, []);
  assert.deepEqual(release.requirementSnapshots, []);
  assert.equal(release.environment, 'unknown');
  assert.equal(release.artifactIds.length, 1);
  assert.equal(snapshot.artifacts[0].releaseId, release.id);
  assert.deepEqual(snapshot.artifacts[0].releaseIds, [release.id]);
  assert.doesNotMatch(JSON.stringify(snapshot), /private approval|private\/path|mysql/u);
  assert.deepEqual(projectDeliverySnapshot({ ...PROJECT, observedAt: '2026-10-08T00:00:00Z', releases: [actual] }).releases[0], release);
  const frozen = seal({ schemaVersion: 1, status: 'bound', scope: 'validated-task-delivery', projectSlug: PROJECT.projectSlug,
    taskId: 'task-one', commit: SOURCE, sourceFingerprint: 'b'.repeat(64), acceptanceGateDigest: 'd'.repeat(64), stateDigest: 'e'.repeat(64),
    baseSourceCommit: '0'.repeat(40), phasePatchDigest: '9'.repeat(64),
    acceptedArtifactDigests: Object.fromEntries(DELIVERY_PHASES.map(([, kind]) => [kind, 'f'.repeat(64)])),
    requirements: [{ id: 'req-frozen', name: '当时功能', menuPath: ['设备'], fields: [] }] }, 'digest');
  const bound = projectDeliverySnapshot({ ...PROJECT, releases: [{ ...actual, deliveryCenterSnapshot: frozen }] }).releases[0];
  assert.deepEqual(bound.requirementIds, ['req-frozen']);
  assert.equal(bound.requirementSnapshots[0].name, '当时功能');
  assert.equal(bound.scope, 'validated-task-delivery');
  assert.equal(bound.scopeBindingEvidence.runnerJobId, 'job-one');
  const brokerAudit = { type: 'taskspace-release', status: 'success', projectSlug: PROJECT.projectSlug, runnerJobId: actual.jobId,
    taskId: 'task-one', commit: SOURCE, deliveryCenterSnapshot: frozen };
  assert.equal(projectDeliverySnapshot({ ...PROJECT, releases: [actual], brokerAudits: [brokerAudit] }).releases[0].scopeBinding, 'frozen-explicit-snapshot');
  for (const changed of [{ runnerJobId: 'another-job' }, { commit: '0'.repeat(40) }, { projectSlug: 'another-project' }, { taskId: 'task-two' }]) {
    assert.equal(projectDeliverySnapshot({ ...PROJECT, releases: [actual], brokerAudits: [{ ...brokerAudit, ...changed }] }).releases[0].scopeBinding, 'unknown');
  }
  const { digest: ignoredDigest, ...incompletePayload } = structuredClone(frozen);
  incompletePayload.requirements.push({ id: 'invalid requirement id', name: '不得静默删除的坏行' });
  const incomplete = seal(incompletePayload, 'digest');
  const rejectedBinding = projectDeliverySnapshot({ ...PROJECT, releases: [{ ...actual, deliveryCenterSnapshot: incomplete }] }).releases[0];
  assert.equal(rejectedBinding.scopeBinding, 'unknown');
  assert.deepEqual(rejectedBinding.requirementSnapshots, []);
  frozen.requirements[0].name = '被修改';
  assert.equal(projectDeliverySnapshot({ ...PROJECT, releases: [{ ...actual, deliveryCenterSnapshot: frozen }] }).releases[0].scopeBinding, 'unknown');
});

function documentedReleaseFixture() {
  const release = { type: 'controlled-release', jobId: 'documented-release', status: 'success', projectSlug: PROJECT.projectSlug,
    commit: SOURCE, completedAt: NOW, provenance: { taskId: 'task-one' } };
  const releaseId = projectDeliverySnapshot({ ...PROJECT, releases: [release] }).releases[0].id;
  const unknown = seal({ schemaVersion: 1, status: 'unknown', scope: 'validated-task-delivery', projectSlug: PROJECT.projectSlug,
    taskId: 'task-one', commit: SOURCE, sourceFingerprint: 'b'.repeat(64), acceptanceGateDigest: 'c'.repeat(64),
    reason: 'PHASE_DELIVERY_NOT_COMPLETED' }, 'digest');
  const audit = { type: 'taskspace-release', status: 'success', projectSlug: PROJECT.projectSlug, runnerJobId: release.jobId,
    taskId: 'task-one', commit: SOURCE, deliveryCenterSnapshot: unknown };
  const change = { name: '合成示例变更', description: '用于平台读模型验证的事后说明', changeType: 'modified', before: '原说明', after: '新说明',
    deliveryCenter: { schemaVersion: 1, kind: 'requirement', id: 'example:release-change:one', revision: 'explanation-v1',
      recordType: 'release-change', nature: 'historical-compilation', menuRefs: [{ kind: 'menu', id: 'example:menu', revision: 'menu-v1' }],
      sources: [{ kind: 'git', commit: SOURCE, sourcePath: 'example/change.md' }],
      relations: [{ type: 'describes-release-change', to: { kind: 'release', id: releaseId, revision: SOURCE },
        sources: [{ kind: 'git', commit: SOURCE }] }] } };
  const document = { path: 'code-copilot/changes/example-platform-fixture.md', commit: 'd'.repeat(40), blob: 'e'.repeat(40),
    contentDigest: 'f'.repeat(64), committedAt: NOW, isCurrent: true, line: 4, fenceLine: 3,
    records: [{ name: '示例菜单当时名称', deliveryCenter: { schemaVersion: 1, kind: 'menu', id: 'example:menu', revision: 'menu-v1' } }, change] };
  return { release, releaseId, audit, document, change };
}

test('documented release changes remain readable with an unknown snapshot without becoming validated scope', () => {
  const { release, audit, document, change } = documentedReleaseFixture();
  const newer = structuredClone(change); newer.deliveryCenter.revision = 'explanation-v2'; newer.after = { description: '保留独立新修订' };
  document.records.push(newer, { name: '当前菜单新名称', deliveryCenter: { schemaVersion: 1, kind: 'menu', id: 'example:menu', revision: 'menu-v2' } });
  const before = structuredClone(document);
  const snapshot = projectDeliverySnapshot({ ...PROJECT, releases: [release], brokerAudits: [audit], documents: [document] });
  const result = snapshot.releases[0];
  assert.equal(result.status, 'success');
  assert.equal(result.scopeBinding, 'unknown'); assert.equal(result.scope, 'unknown');
  assert.equal(result.scopeBindingDiagnostic, 'PHASE_DELIVERY_NOT_COMPLETED');
  assert.deepEqual(result.requirementIds, []); assert.deepEqual(result.requirementSnapshots, []);
  assert.equal(result.documentedChangeCount, 2);
  assert.deepEqual(result.documentedChanges.map(row => row.revision), ['explanation-v1', 'explanation-v2']);
  const row = result.documentedChanges[0];
  assert.equal(row.status, 'documented'); assert.equal(row.changeType, 'modified'); assert.equal(row.before, '原说明');
  assert.deepEqual(row.menuNames, ['示例菜单当时名称']);
  assert.deepEqual(row.menuRefs, change.deliveryCenter.menuRefs);
  assert.deepEqual(row.provenance, { recordRef: { kind: 'requirement', id: change.deliveryCenter.id, revision: 'explanation-v1' },
    nature: 'historical-compilation', sourceCommit: document.commit, sourceScope: 'source-commit', sourcePath: document.path });
  assert.equal(row.sources[0].pointer, '/records/1'); assert.equal(row.sources[0].commit, document.commit);
  assert.ok(row.sources.some(source => source.kind === 'git' && source.commit === SOURCE));
  assert.equal(row.adoption, undefined); assert.equal(row.isCurrent, undefined);
  assert.equal(snapshot.stages.length, 0); assert.equal(snapshot.coverage.acceptedStages, 0);
  assert.deepEqual(result.documentedChanges[1].after, { description: '保留独立新修订' });
  assert.deepEqual(document, before, 'Projection must preserve the original explanation and its source.');
  assert.equal(validateDeliverySnapshot(snapshot).releases[0].documentedChangeCount, 2);
});

test('documented release links require the exact release, commit and an explicit Git relation source', () => {
  const mutations = [
    relation => { relation.to.id = 'release-another'; },
    relation => { relation.to.revision = '0'.repeat(40); },
    relation => { relation.sources = []; },
    relation => { relation.sources = [{ kind: 'git', commit: '0'.repeat(40) }]; },
    relation => { relation.sources = [{ kind: 'document', commit: SOURCE }]; },
    relation => { relation.from = { kind: 'requirement', id: 'another-record', revision: 'explanation-v1' }; },
  ];
  for (const mutate of mutations) {
    const { release, document, change } = documentedReleaseFixture();
    mutate(change.deliveryCenter.relations[0]);
    const result = projectDeliverySnapshot({ ...PROJECT, releases: [release], documents: [document] }).releases[0];
    assert.equal(result.documentedChangeCount, 0); assert.deepEqual(result.documentedChanges, []);
    assert.equal(result.scopeBinding, 'unknown'); assert.deepEqual(result.requirementIds, []);
  }
  const { release, document, change } = documentedReleaseFixture();
  change.deliveryCenter.nature = 'implementation-observation';
  const checkpoint = { ...document, sourceScope: 'taskspace-checkpoint', batchId: 'checkpoint-one', taskId: 'task-one' };
  const result = projectDeliverySnapshot({ ...PROJECT, releases: [release],
    checkpointDocuments: { batches: [], gaps: [], coverage: {}, documents: [checkpoint] } }).releases[0];
  assert.equal(result.documentedChangeCount, 1);
  assert.equal(result.documentedChanges[0].provenance.sourceScope, 'taskspace-checkpoint');
  assert.equal(result.documentedChanges[0].provenance.nature, 'implementation-observation');
  assert.equal(result.scopeBinding, 'unknown'); assert.deepEqual(result.requirementIds, []);
});

test('release snapshot diagnostics preserve only the unique exact audit binding', () => {
  const { release, audit } = documentedReleaseFixture();
  for (const changed of [{ runnerJobId: 'another-job' }, { taskId: 'task-other' }, { commit: '0'.repeat(40) },
    { projectSlug: 'another-project' }]) {
    const result = projectDeliverySnapshot({ ...PROJECT, releases: [release], brokerAudits: [{ ...audit, ...changed }] }).releases[0];
    assert.equal(result.scopeBindingDiagnostic, null);
  }
  const untrusted = structuredClone(audit); untrusted.deliveryCenterSnapshot.reason = 'PRIVATE_UNVERIFIED_REASON';
  assert.equal(projectDeliverySnapshot({ ...PROJECT, releases: [release], brokerAudits: [untrusted] }).releases[0].scopeBindingDiagnostic, null);
  const other = structuredClone(audit); const { digest: ignored, ...payload } = other.deliveryCenterSnapshot;
  other.deliveryCenterSnapshot = seal({ ...payload, reason: 'CURRENT_PHASE_DIGESTS_INCOMPLETE' }, 'digest');
  const conflict = projectDeliverySnapshot({ ...PROJECT, releases: [release], brokerAudits: [audit, other] });
  assert.equal(conflict.releases[0].scopeBindingDiagnostic, null);
  assert.ok(conflict.coverage.gaps.some(gap => gap.code === 'RELEASE_BINDING_CONFLICT'));
});

test('release change list summaries keep bounded previews while exact detail preserves every complete explanation', async () => {
  const { release, document, change } = documentedReleaseFixture();
  const explanations = Array.from({ length: 5 }, (_, index) => {
    const value = structuredClone(change); value.deliveryCenter.revision = `explanation-v${index}`;
    value.name = `示例${index}${'名称'.repeat(100)}`; value.description = `完整说明${index}${'正文'.repeat(5000)}`;
    return value;
  });
  document.records = [document.records[0], ...explanations];
  const full = projectDeliverySnapshot({ ...PROJECT, releases: [release], documents: [document] }).releases[0];
  assert.equal(full.documentedChangeCount, 5); assert.equal(full.documentedChangePreview.length, 3);
  assert.ok(full.documentedChangePreview.every(row => row.name.length === 96 && Object.keys(row).join(',') === 'id,revision,name'));
  const before = structuredClone(full); const calls = [];
  const pool = { async execute(sql) {
    calls.push(sql);
    if (sql.startsWith('SET TRANSACTION')) return [[], []];
    if (sql.startsWith('SELECT COUNT(*)')) return [[{ total: 1 }], []];
    if (sql.startsWith('SELECT snapshot_digest')) return [[{ snapshot_digest: 'a'.repeat(64), observed_at: NOW }], []];
    if (sql.startsWith("SELECT JSON_REMOVE(data, '$.documentedChanges') AS data")) {
      const { documentedChanges, ...summary } = full; return [[{ data: summary }], []];
    }
    if (sql.startsWith('SELECT data FROM delivery_center_releases WHERE')) return [[{ data: full }], []];
    throw new Error(`Unexpected fixture query: ${sql}`);
  }, async getConnection() { return this; }, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
  const store = new DeliveryCenterStore({ pool });
  const listed = await store.listReleases(PROJECT.projectSlug, { projection: 'summary' });
  assert.equal(listed.items[0].documentedChanges, undefined);
  assert.equal(listed.items[0].documentedChangeCount, 5);
  assert.deepEqual(listed.items[0].documentedChangePreview, full.documentedChangePreview);
  assert.ok(calls.some(sql => sql.includes("JSON_REMOVE(data, '$.documentedChanges')")));
  const attempts = await store.listView(PROJECT.projectSlug, { view: 'release-attempts', projection: 'summary' });
  assert.equal(attempts.items[0].documentedChanges, undefined);
  assert.equal(attempts.items[0].documentedChangeCount, 5);
  assert.deepEqual(attempts.items[0].documentedChangePreview, full.documentedChangePreview);
  assert.ok(calls.some(sql => sql.startsWith("SELECT JSON_REMOVE(data, '$.documentedChanges')") && sql.endsWith('LIMIT 10001')));
  const defensive = deliverySummary({ ...full, documentedChangePreview: explanations.map(item => ({
    id: item.deliveryCenter.id, revision: item.deliveryCenter.revision, name: item.name, description: item.description })) });
  assert.equal(defensive.documentedChanges, undefined); assert.equal(defensive.documentedChangePreview.length, 3);
  assert.ok(defensive.documentedChangePreview.every(row => row.name.length === 96 && row.description === undefined));
  const detail = await store.getRelease(PROJECT.projectSlug, full.id);
  assert.equal(detail.documentedChanges.length, 5);
  assert.equal(detail.documentedChanges[4].description, explanations[4].description);
  assert.deepEqual(detail, before); assert.deepEqual(full, before);
});

test('collector reads bounded artifact records, verifies linked correction directories and never reads private chat files', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dc-projection-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const phaseRoot = path.join(temp, 'delivery-phases'); const directory = path.join(phaseRoot, 'task-one', 'phase-control');
  await mkdir(path.join(directory, 'artifacts'), { recursive: true });
  const original = artifact('requirements-contract', 'requirements', { requirements: [requirement('原需求')] });
  const parent = record('task-one', [original]);
  const parentBytes = JSON.stringify(parent.state);
  await writeFile(path.join(directory, 'state.json'), parentBytes);
  await writeFile(path.join(directory, 'artifacts', 'requirements-contract.json'), JSON.stringify(original));
  await writeFile(path.join(directory, 'original-request.md'), 'PRIVATE CHAT password=never-read');
  const childDirectory = path.join(directory, 'access-wiring-repair');
  await mkdir(path.join(childDirectory, 'artifacts'), { recursive: true });
  const repaired = artifact('access-wiring-implementation', 'access-wiring', { menuSeed: { resourceName: '设备台账', parent: { name: '设备管理' } } });
  const child = record('task-one', [original, repaired], { currentPhaseId: 'cross-layer-acceptance' });
  await writeFile(path.join(childDirectory, 'state.json'), JSON.stringify(child.state));
  await writeFile(path.join(childDirectory, '权限接线阶段-关联修复凭据.json'), JSON.stringify({ taskId: 'task-one', sessionId: parent.state.sessionId,
    sourceStateDigest: parent.state.stateDigest, sourceStateSha256: sha(parentBytes), sourceCommit: SOURCE,
    inheritedArtifactDigests: parent.state.acceptedArtifacts }));
  await writeFile(path.join(childDirectory, 'artifacts', 'requirements-contract.json'), JSON.stringify(original));
  await writeFile(path.join(childDirectory, 'artifacts', `access-wiring-implementation-${repaired.artifactDigest}.json`), JSON.stringify(repaired));
  const audit = path.join(temp, 'release-audit.jsonl');
  await writeFile(audit, `${JSON.stringify({ type: 'controlled-release', jobId: 'job-one', projectSlug: PROJECT.projectSlug, status: 'success', commit: SOURCE, completedAt: NOW })}\n{unfinished`);
  const snapshot = await collectDeliverySnapshot({ ...PROJECT, phaseRoot, releaseAuditPath: audit });
  assert.equal(snapshot.coverage.acceptedStages, 2);
  assert.ok(snapshot.coverage.gaps.some(item => item.code === 'RELEASE_AUDIT_INVALID_LINE'));
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE CHAT|never-read/);
  assert.equal(await readFile(path.join(directory, 'original-request.md'), 'utf8'), 'PRIVATE CHAT password=never-read');
  await assert.rejects(collectDeliverySnapshot({ ...PROJECT, phaseRoot: path.join(temp, 'missing') }), /DELIVERY_PHASE_SOURCE_UNAVAILABLE/u);
});

test('collector skips symlink task roots instead of traversing another source', async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dc-links-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'phases'); const outside = path.join(temp, 'outside');
  await mkdir(root); await mkdir(outside);
  await symlink(outside, path.join(root, 'task-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await collectDeliverySnapshot({ ...PROJECT, phaseRoot: root });
  assert.equal(result.batches.length, 0);
  assert.ok(result.coverage.gaps.some(item => item.code === 'TASK_PATH_UNSAFE'));
});

test('explicitly unconfigured phase sources preserve release-only and wholly uncollected projects without inventing stage data', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dc-release-only-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const audit = path.join(temporary, 'release-audit.jsonl');
  await writeFile(audit, `${JSON.stringify({ type: 'controlled-release', projectSlug: PROJECT.projectSlug,
    jobId: 'release-only', version: 'release-historical', status: 'success', commit: SOURCE, completedAt: NOW })}\n`);
  const releaseOnly = await collectDeliverySnapshot({ ...PROJECT, phaseRoot: null, releaseAuditPath: audit });
  assert.equal(releaseOnly.project.slug, PROJECT.projectSlug);
  assert.equal(releaseOnly.releases.length, 1);
  assert.equal(releaseOnly.stages.length, 0);
  assert.equal(releaseOnly.requirements.length, 0);
  assert.deepEqual(releaseOnly.coverage.gaps.map(item => item.code), ['PHASE_SOURCE_NOT_CONFIGURED']);
  assert.equal(validateDeliverySnapshot(releaseOnly).releases[0].version, 'release-historical');
  const empty = await collectDeliverySnapshot({ ...PROJECT, phaseRoot: null, releaseAuditPath: null });
  assert.equal(empty.project.slug, PROJECT.projectSlug);
  assert.equal(empty.releases.length, 0);
  assert.equal(empty.stages.length, 0);
  assert.equal(empty.coverage.availability, 'partial');
  assert.deepEqual(empty.coverage.gaps.map(item => item.code), ['PHASE_SOURCE_NOT_CONFIGURED', 'RELEASE_SOURCE_NOT_CONFIGURED']);
  validateDeliverySnapshot(empty);
  await assert.rejects(collectDeliverySnapshot({ ...PROJECT, phaseRoot: path.join(temporary, 'missing'), releaseAuditPath: null }), /DELIVERY_PHASE_SOURCE_UNAVAILABLE/u);
});

test('captured release explanations bind an unversioned self reference to the recorded body but reject explicit wrong revisions', () => {
  // Both record shapes and metadata are preserved from the af1f9c22 capture; no latest revision is selected.
  const records = [{"name":"事故统计从静态演示改为真实可筛选统计","description":"统计分析菜单不再展示写死日期、固定指标、演示行动清单和模拟图表；页面改为按年份、事故类型、事故原因、部门/装置、事故等级查询。事故数量来自当前租户内未删除且状态为“审核通过”的事故上报，按发生年份和事故等级去重聚合；事故原因筛选通过上报 ID 关联未删除调查记录的根本原因。无符合条件的数据时显示明确空状态。","deliveryCenter":{"schemaVersion":1,"id":"release-06d3d61.change.accident-statistics-live-data","kind":"requirement","recordType":"release-change","revision":null,"nature":"historical-compilation","menuRefs":[{"kind":"menu","id":"forge-base:menu:10205","revision":null}],"functionRefs":[],"sources":[{"kind":"git","commit":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5","sourcePath":"forge-admin-ui/src/views/accident/stats.vue","locator":"patch lines 64-809; target hunk replaces lines 1-570 with lines 1-211"},{"kind":"git","commit":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5","sourcePath":"forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/accident/controller/AccidentController.java","locator":"patch lines 810-839; target lines 45-51 add GET /statistics and business:accidentStats:list"},{"kind":"git","commit":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5","sourcePath":"forge-server/forge-business/forge-business-core/src/main/resources/mapper/business/AccidentMapper.xml","locator":"patch lines 1006-1087; target lines 83-159 add tenant-scoped approved-report aggregation and filter option queries"},{"path":"forge-server/db/migration/V1.0.159__add_accident_batch_bcd.sql","lines":"137-166","evidence":"既有统计分析菜单路径、组件和权限定义；该菜单不是本发布 patch 新增"},{"path":"forge-server/db/migration/V1.0.181__rename_and_reorder_accident_menus.sql","lines":"17-23","evidence":"稳定菜单 ID 10205 对应统计分析"}],"relations":[{"id":"release-06d3d61.relation.accident-statistics-live-data","revision":null,"type":"describes-release-change","from":{"kind":"requirement","id":"release-06d3d61.change.accident-statistics-live-data","revision":null},"to":{"kind":"release","id":"release-80079406c83f90e2c27551c9a1ec60d8","revision":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5"},"conditions":["比较基线仅为唯一父提交 5ff10ebc2fff3f6a1d69a443b9a453c3b8faab0e","不代表相对上一生产版本的完整差异"],"sources":[{"kind":"git","commit":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5","sourcePath":"forge-admin-ui/src/views/accident/stats.vue","locator":"patch lines 64-809; query form, live request, chart and empty state"},{"kind":"git","commit":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5","sourcePath":"forge-server/forge-business/forge-business-core/src/main/resources/mapper/business/AccidentMapper.xml","locator":"patch lines 1006-1087; selectStatistics and filter-source queries"}]}],"adoption":{"state":"unknown","sources":[]}}},{"name":"无真实来源的三项事故 KPI 停止展示模拟值","description":"事故率、安全工时、可记录伤害/疾病发生率在没有人工维护数据源时不再显示写死趋势或数字，而是标明“人工维护”并显示暂无数据源。后端响应显式返回 manualMetricsAvailable=false，三个指标列表为空。","deliveryCenter":{"schemaVersion":1,"id":"release-06d3d61.change.accident-statistics-no-simulated-kpi","kind":"requirement","recordType":"release-change","revision":null,"nature":"historical-compilation","menuRefs":[{"kind":"menu","id":"forge-base:menu:10205","revision":null}],"functionRefs":[],"sources":[{"kind":"git","commit":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5","sourcePath":"forge-admin-ui/src/views/accident/stats.vue","locator":"patch lines 263-275 and 291-452; empty manual KPI cards replace hard-coded metrics and chart arrays"},{"kind":"git","commit":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5","sourcePath":"forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/accident/vo/AccidentStatisticsVO.java","locator":"patch lines 979-1005; manualMetricsAvailable plus empty KPI lists"},{"kind":"git","commit":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5","sourcePath":"forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/accident/service/impl/AccidentServiceImpl.java","locator":"patch lines 942-956; service sets manualMetricsAvailable to false"}],"relations":[{"id":"release-06d3d61.relation.accident-statistics-no-simulated-kpi","revision":null,"type":"describes-release-change","from":{"kind":"requirement","id":"release-06d3d61.change.accident-statistics-no-simulated-kpi","revision":null},"to":{"kind":"release","id":"release-80079406c83f90e2c27551c9a1ec60d8","revision":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5"},"conditions":["比较基线仅为唯一父提交 5ff10ebc2fff3f6a1d69a443b9a453c3b8faab0e","人工维护数据源的后续建设和采用状态未知"],"sources":[{"kind":"git","commit":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5","sourcePath":"forge-admin-ui/src/views/accident/stats.vue","locator":"patch lines 263-275 and 291-452; removes simulated KPI presentation"},{"kind":"git","commit":"06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5","sourcePath":"forge-server/forge-business/forge-business-core/src/main/java/com/mdframe/forge/business/core/accident/vo/AccidentStatisticsVO.java","locator":"patch lines 991-1004; unavailable flag and empty KPI collections"}]}],"adoption":{"state":"unknown","sources":[]}}}];
  const project = { projectSlug: 'forge-base', projectName: 'Forge base fixture', observedAt: NOW };
  const event = { type: 'controlled-release', projectSlug: 'forge-base', jobId: 'ef1da95d-d20d-4896-8bef-ad547d4f1604',
    status: 'success', commit: '06d3d61dfc29dfc35cb744c4ee6003cae33fc5d5', completedAt: NOW,
    provenance: { taskId: 'c-7d4261f446fd89d5e427f354' } };
  const document = {"path":"code-copilot/changes/delivery-center-release-06d3d61/spec.md","commit":"af1f9c22566c996803841ab2d68c1e2774104eaa","blob":"b491476be391ee41e7e1dc3ad2d0f6a70a8d0960","contentDigest":"9c18ece69dd7835a7ecc659e3382b6faf02fdcf0a3251fc61e8ddf2ee686359e","committedAt":"2026-10-09T12:26:42+08:00","line":22,"fenceLine":21};
  const projectRecords = rows => projectDeliverySnapshot({ ...project, releases: [event], checkpointDocuments: {
    batches: [], gaps: [], coverage: {}, documents: [{ ...document, records: rows, sourceScope: 'taskspace-checkpoint',
      batchId: 'checkpoint-fixture', taskId: 'c-7d2ec5bbd185cb69fbce1056' }] } });
  const preserved = structuredClone(records);
  const snapshot = projectRecords(records); const release = snapshot.releases[0];
  assert.equal(release.documentedChangeCount, 2);
  assert.equal(release.scopeBinding, 'unknown'); assert.deepEqual(release.requirementIds, []);
  for (const row of release.documentedChanges) {
    assert.match(row.revision, /^[a-f0-9]{64}$/u);
    assert.equal(row.status, 'documented');
    assert.deepEqual(row.provenance.recordRef, { kind: 'requirement', id: row.id, revision: row.revision });
    assert.equal(row.provenance.sourceCommit, document.commit);
  }
  assert.deepEqual(records, preserved);
  assert.ok(records.every(row => row.deliveryCenter.revision === null && row.deliveryCenter.relations[0].from.revision === null));
  const wrong = structuredClone(records);
  wrong[0].deliveryCenter.relations[0].from.revision = 'explicit-wrong-revision';
  const rejected = projectRecords(wrong).releases[0];
  assert.equal(rejected.documentedChangeCount, 1);
  assert.equal(rejected.documentedChanges[0].id, records[1].deliveryCenter.id);
  assert.equal(validateDeliverySnapshot(snapshot).releases[0].documentedChangeCount, 2);
});
