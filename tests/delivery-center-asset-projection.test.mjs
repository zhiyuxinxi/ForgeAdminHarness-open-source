import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { projectDeliverySnapshot, collectDeliverySnapshot, deliverySnapshotDigest } from '../docker/harness/delivery-center-projection.mjs';
import { deliveryAssetId, mergeDeliveryHistoryPackets, projectDeliveryStageAssets } from '../docker/harness/delivery-center-asset-projection.mjs';
import { readDeliverySources, importDeliverySources } from '../docker/harness/delivery-center-import.mjs';
import { DeliveryCenterStore, validateDeliverySnapshot } from '../docker/harness/delivery-center-store.mjs';
import { deliverySummary } from '../docker/harness/delivery-center-views.mjs';
import { deliveryDisplayRecord } from '../docker/harness/delivery-center-semantics.mjs';
import { parseForgeDeliveryPhaseProposal, FORGE_DELIVERY_PHASE_RESPONSE_START, FORGE_DELIVERY_PHASE_RESPONSE_END } from '../docker/harness/forge-delivery-phase-response.mjs';

const NOW = '2026-10-07T03:00:00.000Z';
const PROJECT = { projectSlug: 'forge-base', projectName: '示例客户', observedAt: NOW };
const seal = (value, key) => ({ ...value, [key]: deliverySnapshotDigest(value) });
const artifact = (artifactKind, phaseId, payload) => seal({ schemaVersion: 'forge-delivery-phase-artifact/v1', workflowId: 'crud-production', artifactKind, phaseId, sourceFingerprint: 'b'.repeat(64), payload }, 'artifactDigest');
function snapshot(artifacts, accepted = artifacts, observedAt = NOW, receipted = artifacts) {
  const state = seal({ schemaVersion: 'forge-delivery-phase-state/v2', taskId: 'task-assets', workflowId: 'crud-production',
    sessionId: 'session-assets', sourceCommit: 'a'.repeat(40), status: 'active', currentPhaseId: 'backend', createdAt: NOW, updatedAt: NOW,
    acceptedArtifacts: Object.fromEntries(accepted.map(item => [item.artifactKind, item.artifactDigest])),
    history: receipted.map(item => ({ phaseId: item.phaseId, artifactDigest: item.artifactDigest, decision: 'accepted', completedAt: NOW })),
  }, 'stateDigest');
  return projectDeliverySnapshot({ ...PROJECT, observedAt, records: [{ state, artifacts, isCurrent: true, depth: 0 }] });
}
function packet(overrides = {}) {
  return { schemaVersion: 1, projectSlug: 'forge-base', sourceCommit: 'a'.repeat(40), recordedAt: NOW,
    source: { kind: 'source-corpus', revision: 'a'.repeat(40), label: '固定源码' }, menus: [], batches: [], requirements: [], requirementVersions: [], assets: [], currentAssetVersionIds: [], ...overrides };
}

test('phase assets preserve entity relationships, endpoint shapes, keyed objects and all retained versions without invented acceptance', () => {
  const old = artifact('domain-api-contract', 'domain-contract', {
    businessEntities: { Worker: { description: '作业人员', attributes: [{ name: 'companyId', businessType: 'CompanyId' }],
      relationships: [{ target: 'Company', cardinality: 'many-to-one', description: '所属单位' }], menuPath: ['相关方', '作业人员'] } },
    apiContracts: [{ method: 'GET', path: '/workers', name: '查询人员', request: { query: [{ name: 'companyId' }] },
      response: { dtoOwner: 'WorkerVO.java', fields: [{ name: 'id', wireType: 'string' }] }, internalDependencies: [{ method: 'GET', path: '/companies' }] }],
    dictionaries: { workerStatus: { active: '有效', disabled: '停用' } },
  });
  const current = artifact('domain-api-contract', 'domain-contract', { businessEntities: { Worker: { description: '新版人员定义', attributes: [{ name: 'name' }] } } });
  const value = snapshot([old, current], [current]);
  const assets = value.artifacts.filter(item => item.kind === 'specification-asset');
  const workers = assets.filter(item => item.payload.kind === 'entity');
  assert.equal(workers.length, 2); assert.equal(workers[0].payload.assetId, workers[1].payload.assetId);
  const historic = workers.find(item => item.payload.description === '作业人员');
  assert.equal(historic.payload.status, 'accepted');
  assert.equal(value.stages.find(stage => stage.id === historic.stageId).isCurrent, false);
  assert.equal(historic.payload.details.attributes[0].businessType, 'CompanyId');
  assert.equal(historic.payload.relations[0].targetId, deliveryAssetId('forge-base', 'entity', 'Company'));
  assert.equal(historic.payload.relations[0].cardinality, 'many-to-one');
  const api = assets.find(item => item.payload.kind === 'api').payload;
  assert.equal(api.details.request.query[0].name, 'companyId');
  assert.equal(api.details.response.dtoOwner, 'WorkerVO.java');
  assert.equal(api.details.internalDependencies[0].path, '/companies');
  assert.deepEqual(api.commits, []); assert.deepEqual(api.releaseIds, []);
  assert.equal(value.stages.find(stage => stage.digest === old.artifactDigest).details.businessEntities.Worker.relationships[0].target, 'Company');
  assert.deepEqual(snapshot([old, current], [current], '2026-10-08T03:00:00.000Z').artifacts, value.artifacts);
  validateDeliverySnapshot(value);
});

test('menu packet aliases only exact complete paths, retains immutable asset IDs, and explicitly selects current history versions', () => {
  const req = artifact('requirements-contract', 'requirements', { useCases: [{ id: 'UC-1', name: '登记人员', menuPath: ['相关方', '作业人员'] }] });
  const value = snapshot([req]); const originalAsset = structuredClone(value.artifacts[0]);
  const oldMenuId = value.menus.find(menu => menu.name === '作业人员').id;
  const selected = { ...structuredClone(originalAsset), id: 'history-version-one', stageId: null,
    payload: { ...structuredClone(originalAsset.payload), sourceRevision: 'commit-1', status: 'source-only' } };
  mergeDeliveryHistoryPackets(value, [packet({ menus: [{ id: 'menu-db-1', parentId: null, name: '相关方', path: ['相关方'] },
    { id: 'menu-db-2', parentId: 'menu-db-1', name: '作业人员', path: ['相关方', '作业人员'] }],
  assets: [selected], currentAssetVersionIds: [selected.id] })]);
  assert.equal(value.requirements[0].menuId, 'menu-db-2');
  assert.equal(value.coverage.menuAliases[oldMenuId], 'menu-db-2');
  assert.deepEqual(value.artifacts.find(item => item.id === originalAsset.id), originalAsset);
  assert.deepEqual(value.coverage.currentAssetVersionIds, ['history-version-one']);
  assert.equal(value.menus.length, 2); validateDeliverySnapshot(value);
  assert.throws(() => mergeDeliveryHistoryPackets(value, [packet({ projectSlug: 'other-project' })]), /PACKET_INVALID/u);
  assert.throws(() => mergeDeliveryHistoryPackets(value, [packet({ currentAssetVersionIds: ['missing'] })]), /CURRENT_INVALID/u);
});

test('host manifest history packets collect without phase state, reject relative paths and preserve existing projection on missing history', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'delivery-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const history = path.join(directory, 'history.json'); const manifest = path.join(directory, 'sources.json');
  await writeFile(history, JSON.stringify(packet({ menus: [{ id: 'menu-legacy', name: '人员', parentId: null, path: ['人员'] }] })));
  const project = { ...PROJECT, phaseRoot: null, releaseAuditPath: null, historyPacketPaths: [history] };
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, projects: [project] }));
  assert.equal((await readDeliverySources(manifest))[0].historyPacketPaths[0], history);
  const value = await collectDeliverySnapshot(project);
  assert.equal(value.menus[0].id, 'menu-legacy'); assert.equal(value.stages.length, 0);
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, projects: [{ ...project, historyPacketPaths: ['../history.json'] }] }));
  await assert.rejects(readDeliverySources(manifest), /SOURCE_INVALID/u);
  let imported = false;
  const receipt = await importDeliverySources({ store: { overview: async () => null, importSnapshot: async () => { imported = true; } },
    projects: [{ ...project, historyPacketPaths: [path.join(directory, 'missing.json')] }] });
  assert.equal(imported, false); assert.equal(receipt.results[0].preservedPreviousSnapshot, true);
  assert.ok(receipt.results[0].gapCodes.includes('HISTORY_PACKET_UNAVAILABLE'));
});

test('distinct production menu IDs sharing the same path are retained and never treated as a rename', () => {
  const value = snapshot([]);
  mergeDeliveryHistoryPackets(value, [packet({ menus: [
    { id: 'forge-base:menu:9288', name: 'InOutHistory', path: ['InOutHistory'], parentId: null },
    { id: 'forge-base:menu:9372', name: 'InOutHistory', path: ['InOutHistory'], parentId: null },
  ] })]);
  assert.equal(value.menus.length, 2);
  assert.deepEqual(value.coverage.menuAliases, {});
  validateDeliverySnapshot(value);
});

test('explicit stage flow and entity definitions generate source-linked diagrams before stable version hashing', () => {
  const req = artifact('requirements-contract', 'requirements', { useCases: [{ id: 'UC-FLOW', name: '人员入场',
    steps: [{ id: 'submit', name: '提交申请' }, { id: 'check', name: '审核材料' }, { id: 'allow', name: '允许入场' }],
    transitions: [{ from: 'submit', to: 'check' }, { from: 'check', to: 'allow', label: '审核通过' }] }] });
  const domain = artifact('domain-api-contract', 'domain-contract', { businessEntities: {
    Company: { description: '单位', attributes: [{ name: 'name', type: 'string' }] },
    Worker: { description: '人员', attributes: [{ name: 'name', type: 'string' }], relationships: [{ target: 'Company', cardinality: 'N:1', label: '所属单位' }] },
  } });
  const value = snapshot([req, domain]);
  const assets = value.artifacts.filter(item => item.kind === 'specification-asset').map(item => item.payload);
  const flow = assets.find(item => item.kind === 'scene'); const worker = assets.find(item => item.name === 'Worker');
  assert.equal(flow.diagram.type, 'flowchart'); assert.match(flow.diagram.source, /审核通过/u);
  assert.equal(worker.diagram.type, 'erDiagram'); assert.match(worker.diagram.source, /Company/u); assert.match(worker.diagram.source, /所属单位/u);
  assert.ok(worker.diagram.sourceRefs.every(source => source.digest === domain.artifactDigest));
  assert.deepEqual(snapshot([req, domain], [req, domain], '2026-10-09T03:00:00.000Z').artifacts, value.artifacts);
  validateDeliverySnapshot(value);
});

test('optional nested definitions keep functions distinct, retain draft menus and select only sourced requirement adoption', () => {
  // Synthetic platform fixtures: these are not customer business deliverables.
  const source = { sourceId: 'fixture-decision-1', path: 'fixture-spec.md', line: 1 };
  const metadata = (kind, id, revision, extra = {}) => ({ schemaVersion: 1, kind, id, revision, nature: 'design', sources: [source], ...extra });
  const functionId = 'forge-base:function:fixture-submit';
  const menuId = 'forge-base:menu:fixture-menu';
  const requirementId = 'forge-base:requirement:fixture-rule';
  const feature = { name: '示例提交功能', goal: '提交示例对象', observableResult: '形成示例记录',
    deliveryCenter: metadata('function', functionId, 'function-v1', { menuApplicability: 'none' }) };
  const requirement = (revision, description, adoption) => ({ name: '示例独立要求', description,
    deliveryCenter: metadata('requirement', requirementId, revision, { recordType: 'requirement', adoption,
      menuRefs: [{ kind: 'menu', id: menuId, revision: 'menu-v1' }], functionRefs: [{ kind: 'function', id: functionId, revision: 'function-v1' }] }) });
  const old = artifact('requirements-contract', 'requirements', { requirementTrace: {
    requirements: [requirement('rule-v1', '原采用要求', { state: 'adopted', sources: [source] })],
    menus: [{ name: '示例菜单', menuPath: ['示例菜单'], deliveryCenter: metadata('menu', menuId, 'menu-v1', { origin: 'baseline', originSources: [source] }) }],
  } });
  const pending = artifact('requirements-contract', 'requirements', { requirementTrace: {
    functions: [feature],
    requirements: [requirement('rule-v2', '尚未采用的新要求', { state: 'proposed', sources: [source], supersedes: [{ kind: 'requirement', id: requirementId, revision: 'rule-v1' }] })],
    menus: [{ name: '草稿菜单', menuPath: ['草稿菜单'], deliveryCenter: metadata('menu', 'forge-base:menu:fixture-draft', 'menu-draft', { origin: 'business-added', originSources: [source] }) }],
  } });
  const value = snapshot([old, pending], [old], NOW, [old]);
  assert.equal(value.requirements.length, 1);
  assert.equal(value.requirements[0].id, requirementId);
  assert.equal(value.requirements[0].description, '原采用要求');
  assert.equal(value.requirements[0].adoption.state, 'adopted');
  assert.equal(value.requirements[0].adoptionSelection, 'explicit-decision');
  assert.equal(value.requirements[0].recordedAt, NOW);
  assert.equal(value.requirementVersions.length, 2);
  assert.equal(value.requirementVersions.find(row => row.revision === 'rule-v2').recordedAt, null);
  assert.deepEqual(value.requirements[0].functionRefs, [{ kind: 'function', id: functionId, revision: 'function-v1' }]);
  assert.equal(value.menus.find(row => row.id === menuId).origin, 'baseline');
  assert.equal(value.menus.find(row => row.name === '草稿菜单').stageStatus.requirements, 'draft');
  const functions = value.artifacts.filter(row => row.payload?.kind === 'function');
  assert.equal(functions.length, 1);
  assert.equal(functions[0].payload.assetId, functionId);
  assert.equal(functions[0].payload.revision, 'function-v1');
  assert.equal(functions[0].payload.status, 'draft');
  assert.equal(functions[0].payload.nature, 'design');
  assert.equal(functions[0].payload.sourceRevision, pending.artifactDigest);
  assert.equal(functions[0].payload.recordedAt, null);
  assert.equal(value.stages.find(row => row.id === functions[0].stageId).isCurrent, false);
  assert.deepEqual(functions[0].payload.menuIds, []);
  assert.equal(functions[0].payload.menuApplicability, 'none');
  assert.deepEqual(snapshot([old, pending], [old], '2026-10-08T03:00:00.000Z', [old]).artifacts, value.artifacts);
  validateDeliverySnapshot(value);
});

test('same-ID runtime menu observations retain semantic history and cannot apply a proposed rename or merge another explicit identity', () => {
  const decision = { sourceId: 'fixture-menu-decision', line: 7 };
  const menu = state => ({ name: '提议名称', menuPath: ['提议目录', '提议名称'], route: '/proposed',
    deliveryCenter: { schemaVersion: 1, kind: 'menu', id: 'fixture-stable-menu', revision: 'menu-v2', nature: 'design',
      origin: 'business-added', originSources: [decision], adoption: { state, sources: [decision] } } });
  const observation = packet({ menus: [{ id: 'fixture-stable-menu', name: '已配置名称', parentId: null,
    path: ['已配置名称'], route: '/configured', visible: false }] });
  const pending = snapshot([artifact('requirements-contract', 'requirements', { requirementTrace: { menus: [menu('proposed'),
    { name: '另一个明确身份', menuPath: ['已配置名称'], deliveryCenter: { schemaVersion: 1, kind: 'menu', id: 'fixture-other-menu', revision: 'other-v1' } }] } })]);
  mergeDeliveryHistoryPackets(pending, [observation]); validateDeliverySnapshot(pending);
  const retained = pending.menus.find(row => row.id === 'fixture-stable-menu');
  assert.equal(retained.name, '已配置名称'); assert.deepEqual(retained.path, ['已配置名称']); assert.equal(retained.route, '/configured');
  assert.equal(retained.revision, 'menu-v2'); assert.equal(retained.adoption.state, 'proposed');
  assert.equal(retained.details.name, '提议名称'); assert.equal(retained.variants[0].name, '提议名称');
  assert.equal(retained.origin, 'business-added'); assert.deepEqual(retained.originSources, [decision]);
  assert.equal(retained.runtimeObservation.visible, false); assert.equal(retained.runtimeObservation.sourceRevision, observation.sourceCommit);
  assert.equal(retained.sources.some(row => row.stageId), true); assert.equal(retained.sources.some(row => row.kind === 'source-corpus'), true);
  assert.equal(pending.menus.some(row => row.id === 'fixture-other-menu'), true);
  assert.equal(pending.coverage.menuAliases['fixture-other-menu'], undefined);
  const adopted = snapshot([artifact('requirements-contract', 'requirements', { requirementTrace: { menus: [menu('adopted')] } })]);
  mergeDeliveryHistoryPackets(adopted, [observation]); validateDeliverySnapshot(adopted);
  const current = adopted.menus.find(row => row.id === 'fixture-stable-menu');
  assert.equal(current.name, '提议名称'); assert.deepEqual(current.path, ['提议目录', '提议名称']);
  assert.equal(current.runtimeObservation.name, '已配置名称'); assert.equal(current.runtimeObservation.route, '/configured');
});

test('history packet semantic menu and runtime observation merges are symmetric without adopting proposed navigation', () => {
  const decision = { sourceId: 'fixture-menu-packet-decision', line: 7 };
  const observation = packet({ sourceCommit: 'c'.repeat(40), recordedAt: '2026-10-06T03:00:00.000Z',
    source: { kind: 'menu-configuration', revision: 'c'.repeat(40), label: '已配置菜单' },
    menus: [{ id: 'fixture-packet-menu', name: '已配置名称', parentId: null, path: ['已配置名称'], route: '/configured', visible: false }] });
  for (const state of ['proposed', 'adopted']) {
    const semantic = snapshot([artifact('requirements-contract', 'requirements', { requirementTrace: { menus: [
      { name: '迭代名称', menuPath: ['迭代目录', '迭代名称'], route: '/iteration', deliveryCenter: {
        schemaVersion: 1, kind: 'menu', id: 'fixture-packet-menu', revision: 'menu-v2', nature: 'design',
        origin: 'business-added', originSources: [decision], adoption: { state, sources: [decision] } } }
    ] } })]).menus.find(row => row.id === 'fixture-packet-menu');
    const definition = packet({ menus: [semantic] });
    const first = snapshot([]); const second = snapshot([]);
    mergeDeliveryHistoryPackets(first, [observation, definition]);
    mergeDeliveryHistoryPackets(second, [definition, observation]);
    validateDeliverySnapshot(first); validateDeliverySnapshot(second);
    assert.deepEqual(first.menus, second.menus);
    const retained = first.menus.find(row => row.id === semantic.id);
    assert.equal(retained.name, state === 'adopted' ? '迭代名称' : '已配置名称');
    assert.deepEqual(retained.path, state === 'adopted' ? ['迭代目录', '迭代名称'] : ['已配置名称']);
    assert.equal(retained.route, state === 'adopted' ? '/iteration' : '/configured');
    assert.equal(retained.visible, false);
    assert.equal(retained.revision, 'menu-v2'); assert.equal(retained.adoption.state, state);
    assert.deepEqual(retained.variants, semantic.variants);
    assert.equal(retained.origin, 'business-added'); assert.deepEqual(retained.originSources, [decision]);
    assert.equal(retained.runtimeObservation.name, '已配置名称');
    assert.equal(retained.runtimeObservation.route, '/configured');
    assert.equal(retained.runtimeObservation.sourceRevision, observation.sourceCommit);
    assert.equal(retained.runtimeObservation.recordedAt, observation.recordedAt);
    assert.deepEqual(retained.runtimeObservation.sources, [observation.source]);
    assert.equal(retained.sources.some(row => row.stageId), true);
    assert.equal(retained.sources.some(row => row.kind === 'menu-configuration'), true);
  }
});

test('history packet semantic revisions retain iterations and sources while legacy identity conflicts stay rejected', () => {
  const decision = { sourceId: 'fixture-history-adoption', line: 4 };
  const build = (revision, state, supersedes = []) => {
    const meta = kind => ({ schemaVersion: 1, kind, id: `fixture-packet-${kind}`, revision, nature: 'design',
      adoption: { state, sources: state === 'unknown' ? [] : [decision],
        supersedes: supersedes.map(previous => ({ kind, id: `fixture-packet-${kind}`, revision: previous })) } });
    const result = snapshot([artifact('requirements-contract', 'requirements', { requirementTrace: {
      menus: [{ name: `菜单${revision}`, menuPath: [`菜单${revision}`], route: `/${revision}`, deliveryCenter: meta('menu') }],
      requirements: [{ name: `要求${revision}`, description: `完整要求${revision}`, deliveryCenter: meta('requirement') }]
    } })]);
    return packet({ menus: result.menus, requirements: result.requirements, requirementVersions: result.requirementVersions });
  };
  const old = build('r1', 'adopted'); const proposed = build('r2', 'proposed'); const unknown = build('r3', 'unknown');
  const anotherSource = structuredClone(old);
  for (const rows of [anotherSource.menus, anotherSource.requirements, anotherSource.requirementVersions]) for (const row of rows) {
    row.sources = [{ kind: 'committed-document', sourcePath: 'fixture-history.md', commit: 'd'.repeat(40), line: 3 }];
    row.sourceRevision = 'd'.repeat(40);
    for (const variant of row.variants ?? []) { variant.sources = row.sources; variant.sourceRevision = row.sourceRevision; }
  }
  const first = snapshot([]); const second = snapshot([]);
  mergeDeliveryHistoryPackets(first, [old, proposed, unknown, anotherSource]);
  mergeDeliveryHistoryPackets(second, [anotherSource, unknown, proposed, old]);
  validateDeliverySnapshot(first); validateDeliverySnapshot(second);
  assert.deepEqual(first.menus, second.menus); assert.deepEqual(first.requirements, second.requirements);
  for (const record of [...first.menus, ...first.requirements]) {
    assert.equal(record.revision, 'r1'); assert.equal(record.adoption.state, 'adopted');
    assert.equal(record.adoptionSelection, 'explicit-decision'); assert.equal(record.variants.length, 4);
    assert.equal(record.sources.some(source => source.kind === 'committed-document'), true);
    assert.equal(record.runtimeObservation, undefined);
  }
  assert.equal(first.requirementVersions.length, 4);
  assert.equal(first.requirementVersions.filter(row => row.revision === 'r1').length, 2);
  assert.equal(first.requirements[0].description, '完整要求r1');
  const conflict = snapshot([]);
  mergeDeliveryHistoryPackets(conflict, [old, build('r4', 'adopted')]);
  for (const record of [...conflict.menus, ...conflict.requirements]) {
    assert.equal(record.adoptionSelection, 'unresolved'); assert.equal(record.adoption.state, 'unknown');
    assert.equal(record.variants.length, 2);
  }
  const replacement = snapshot([]);
  mergeDeliveryHistoryPackets(replacement, [build('r5', 'adopted', ['r1']), old]);
  for (const record of [...replacement.menus, ...replacement.requirements]) {
    assert.equal(record.revision, 'r5'); assert.equal(record.adoptionSelection, 'explicit-decision');
  }
  for (const key of ['requirements', 'batches']) {
    assert.throws(() => mergeDeliveryHistoryPackets(snapshot([]), [packet({ [key]: [{ id: 'legacy-id', name: '原记录' }] }),
      packet({ [key]: [{ id: 'legacy-id', name: '冲突记录' }] })]), /DELIVERY_HISTORY_ID_CONFLICT/u);
  }
  const asset = { id: 'fixture-asset-version', kind: 'specification-asset', payload: { kind: 'entity', assetId: 'fixture-entity',
    revision: 'entity-r1', sourceRevision: 'a'.repeat(40), sources: [decision], name: '原对象' } };
  assert.throws(() => mergeDeliveryHistoryPackets(snapshot([]), [packet({ assets: [asset] }),
    packet({ assets: [{ ...asset, payload: { ...asset.payload, name: '冲突对象' } }] })]), /DELIVERY_HISTORY_ID_CONFLICT/u);
});

test('stable definitions preserve relationship revisions and explicit replacements independently of menu names or stage acceptance', () => {
  const decision = { sourceId: 'fixture-explicit-correction', path: 'fixture.md', line: 4 };
  const reqId = 'forge-base:requirement:stable';
  const make = (revision, name, adoption) => artifact('requirements-contract', 'requirements', { requirementTrace: { requirements: [{ name, description: name,
    menuPath: [name], deliveryCenter: { schemaVersion: 1, id: reqId, kind: 'requirement', revision, nature: 'original', adoption } }] } });
  const old = make('r1', '改名前', { state: 'adopted', sources: [decision] });
  const newer = make('r2', '改名后', { state: 'adopted', sources: [decision], supersedes: [{ kind: 'requirement', id: reqId, revision: 'r1' }] });
  const model = artifact('domain-api-contract', 'domain-contract', { businessEntities: [{ name: '示例对象', attributes: [],
    deliveryCenter: { schemaVersion: 1, kind: 'entity', id: 'forge-base:entity:fixture', revision: 'model-r2', contextId: 'fixture-context', recordType: 'entity', nature: 'design',
      origin: 'baseline', // no origin evidence: not a baseline fact
      relations: [{ id: 'fixture-relation', revision: 'relation-r3', type: 'uses',
        from: { kind: 'entity', id: 'forge-base:entity:fixture', revision: 'model-r2' },
        to: { kind: 'requirement', id: reqId, revision: 'r1', localId: 'condition-1' },
        conditions: { when: '明确条件', effectiveFrom: '2026-01-01' }, sources: [decision] }],
      stageId: 'invented-stage', sourceRevision: 'invented-digest', recordedAt: '2099-01-01T00:00:00Z', status: 'passed' } }] });
  const value = snapshot([old, newer, model], [old], NOW, [old]);
  assert.equal(value.requirements.length, 1);
  assert.equal(value.requirements[0].name, '改名后');
  assert.equal(value.requirements[0].revision, 'r2');
  assert.equal(value.requirements[0].stageStatus.requirements, 'draft');
  assert.equal(value.requirements[0].variants.length, 2);
  assert.equal(value.menus.length, 0); // a requirement's path does not invent a menu
  const projected = value.artifacts.find(row => row.payload?.kind === 'entity');
  assert.equal(projected.payload.assetId, 'forge-base:entity:fixture');
  assert.equal(projected.payload.revision, 'model-r2');
  assert.equal(projected.payload.contextId, 'fixture-context');
  assert.equal(projected.payload.status, 'draft');
  assert.equal(projected.payload.recordedAt, null);
  assert.equal(projected.payload.sourceRevision, model.artifactDigest);
  assert.notEqual(projected.stageId, 'invented-stage');
  const relation = projected.payload.relations[0];
  assert.equal(relation.id, 'fixture-relation');
  assert.equal(relation.revision, 'relation-r3');
  assert.deepEqual(relation.to, { kind: 'requirement', id: reqId, revision: 'r1', localId: 'condition-1' });
  assert.equal(relation.targetRevision, 'r1');
  assert.deepEqual(relation.conditions, { when: '明确条件', effectiveFrom: '2026-01-01' });
  assert.deepEqual(relation.sources, [decision]);
  validateDeliverySnapshot(value);
  const noEvidence = make('r3', '无决定来源', { state: 'adopted' });
  assert.equal(snapshot([noEvidence]).requirements[0].adoption.state, 'unknown');
});

test('document statement and pageName aliases preserve original content without inventing titles or execution', () => {
  const statement = '平台合成示例的已有要求正文。'.repeat(30);
  const verification = '实现观察说明，未提供执行回执。';
  const meta = (kind, id) => ({ schemaVersion: 1, kind, id, revision: 'definition-v1',
    nature: 'implementation-observation', menuApplicability: 'none', adoption: { state: 'unknown', sources: [] } });
  const value = projectDeliverySnapshot({ ...PROJECT, documents: [{
    path: 'code-copilot/changes/fixture/spec.md', commit: 'a'.repeat(40), blob: 'b'.repeat(40),
    contentDigest: 'c'.repeat(64), committedAt: NOW, line: 4, fenceLine: 3, isCurrent: true,
    records: [
      { code: 'FIXTURE-REQ-001', statement, verification,
        deliveryCenter: meta('requirement', 'fixture-requirement-no-title') },
      { name: '已有要求标题', description: '已有说明优先', statement,
        deliveryCenter: meta('requirement', 'fixture-requirement-explicit-description') },
      { pageName: '已有页面名称', route: '/fixture-page', regions: [{ name: '已有区域', purpose: '原有用途' }],
        deliveryCenter: meta('page', 'fixture-page-stable-id') },
    ],
  }] });
  const requirement = value.requirements.find(row => row.id === 'fixture-requirement-no-title');
  assert.equal(requirement.name, 'fixture-requirement-no-title');
  assert.equal(requirement.description, statement);
  assert.equal(requirement.details.statement, statement);
  assert.equal(requirement.details.verification, verification);
  assert.equal(requirement.revision, 'definition-v1');
  assert.equal(requirement.nature, 'implementation-observation');
  assert.equal(requirement.adoption.state, 'unknown');
  assert.equal(requirement.status, 'documented');
  assert.deepEqual(requirement.stageStatus, {});
  const summary = deliverySummary(requirement);
  assert.equal(summary.description, statement.slice(0, 240));
  assert.equal(requirement.description, statement);
  assert.equal(value.requirements.find(row => row.id === 'fixture-requirement-explicit-description').description, '已有说明优先');
  const page = value.artifacts.find(row => row.payload?.assetId === 'fixture-page-stable-id').payload;
  assert.equal(page.name, '已有页面名称');
  assert.equal(page.details.pageName, '已有页面名称');
  assert.equal(page.revision, 'definition-v1');
  assert.equal(page.adoption.state, 'unknown');
  assert.deepEqual(page.releaseIds, []);
  assert.equal(value.stages.length, 0);
});

test('frozen history body aliases remain readable without changing packet identities or evidence', async () => {
  const statement = '附件字段存储 fileId，支持预算记录上传附件。';
  const requirement = { schemaVersion: 1, kind: 'requirement', id: 'budget.requirement.attachment-file-id',
    name: 'budget.requirement.attachment-file-id', description: '', revision: 'definition-v1',
    sourceRevision: 'a'.repeat(40), nature: 'implementation-observation', adoption: { state: 'unknown', sources: [] },
    details: { code: 'REQ-BUDGET-005', statement, verification: '迁移新增 attachment varchar(1000)，前端 FileUpload 绑定 editForm.attachment。' },
    menuIds: [], menuPaths: [], menuPath: [], menuId: null, batchIds: [], stageStatus: {}, status: 'documented',
    sources: [{ kind: 'committed-document', sourcePath: 'code-copilot/changes/delivery-center-history-budget/spec.md', commit: 'a'.repeat(40) }] };
  const page = { id: 'frozen-budget-page-version', kind: 'specification-asset', stageId: null, releaseId: null,
    payload: { assetId: 'budget.page.fee-budget', kind: 'page', revision: 'definition-v1', sourceRevision: 'a'.repeat(40),
      name: 'code-copilot/changes/delivery-center-history-budget/spec.md · page', description: '',
      details: { pageName: '预算和使用页面', component: 'budget/feeBudget.vue' },
      nature: 'implementation-observation', adoption: { state: 'unknown', sources: [] }, status: 'documented',
      menuIds: [], menuPaths: [], batchIds: [], releaseIds: [], relations: [], commits: [], sources: requirement.sources } };
  const original = packet({ requirements: [requirement], assets: [page], currentAssetVersionIds: [page.id] });
  const bytes = JSON.stringify(original); const originalDigest = deliverySnapshotDigest(original);
  const projected = projectDeliverySnapshot({ ...PROJECT, historyPackets: [original] });
  assert.deepEqual(projected.artifacts.find(row => row.id === page.id), page);
  const calls = []; const execute = async sql => {
    calls.push(sql);
    if (sql.startsWith('SELECT coverage')) return [[{ coverage: projected.coverage }], []];
    if (sql.startsWith('SELECT snapshot_digest')) return [[{ snapshot_digest: originalDigest, observed_at: NOW }], []];
    if (sql.includes('COUNT(*)')) return [[{ total: 1 }], []];
    if (sql.includes('delivery_center_requirement_versions')) return [[], []];
    if (sql.includes('delivery_center_requirements')) return [[{ data: requirement, is_current: true }], []];
    if (sql.includes('delivery_center_artifacts')) {
      const payload = sql.includes('a.id IN') ? page.payload : { ...page.payload, details: undefined };
      return [[{ data: { ...page, payload } }], []];
    }
    return [[], []];
  };
  const pool = { execute, getConnection: async () => ({ execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} }) };
  const store = new DeliveryCenterStore({ pool });
  const list = await store.listRequirements('forge-base', { projection: 'summary' });
  const detail = await store.getRequirement('forge-base', requirement.id, { detailMode: 'single' });
  const exported = await store.exportRequirements('forge-base');
  for (const row of [list.items[0], detail, exported[0]]) {
    assert.equal(row.description, statement); assert.equal(row.name, requirement.id);
    assert.equal(row.revision, requirement.revision); assert.equal(row.sourceRevision, requirement.sourceRevision);
    assert.equal(row.nature, 'implementation-observation'); assert.equal(row.adoption.state, 'unknown');
  }
  assert.equal(detail.details.verification, requirement.details.verification);
  assert.deepEqual(detail.stageStatus, {});
  const pageList = await store.listAssets('forge-base', { kind: 'page', projection: 'summary' });
  const pageDetail = await store.getAsset('forge-base', page.payload.assetId, { detailMode: 'single' });
  for (const row of [pageList.items[0], pageDetail]) {
    assert.equal(row.name, '预算和使用页面'); assert.equal(row.id, page.payload.assetId);
    assert.equal(row.versionId, page.id); assert.equal(row.revision, page.payload.revision);
    assert.deepEqual(row.releaseIds, []); assert.equal(row.adoption.state, 'unknown');
  }
  assert.equal(deliveryDisplayRecord({ ...requirement, description: '显式说明' }).description, '显式说明');
  assert.equal(deliveryDisplayRecord({ ...page.payload, name: '显式页面名称' }).name, '显式页面名称');
  assert.equal(deliveryDisplayRecord({ ...page.payload, details: { ...page.payload.details, name: '显式原文名称' } }).name, page.payload.name);
  assert.equal(deliverySummary(deliveryDisplayRecord({ ...requirement, details: { ...requirement.details, statement: statement.repeat(20) } })).description.length, 240);
  assert.equal(JSON.stringify(original), bytes); assert.equal(deliverySnapshotDigest(original), originalDigest);
  assert.ok(calls.every(sql => !/^(?:INSERT|UPDATE|DELETE) /u.test(sql)));
  assert.ok(calls.filter(sql => sql.includes('a.id IN')).every(sql => sql.includes('IN (?)')));
});

test('optional nested producer shape passes the unchanged phase payload key contract', () => {
  const requiredPayloadKeys = ['actors', 'useCases', 'businessRules', 'acceptanceCriteria', 'nonGoals', 'dataOwnership', 'permissionMatrix', 'requirementTrace'];
  const payload = Object.fromEntries(requiredPayloadKeys.map(key => [key, []]));
  payload.requirementTrace = { functions: [{ name: '平台示例功能', goal: '示例目标', observableResult: '示例结果',
    deliveryCenter: { schemaVersion: 1, id: 'fixture-project:function:example', kind: 'function', nature: 'design', revision: 'v1', menuApplicability: 'none' } }] };
  const proposal = { schemaVersion: 'forge-delivery-phase-proposal/v1', phaseId: 'requirements', unresolvedDecisions: [], payload };
  const parsed = parseForgeDeliveryPhaseProposal({ phase: { id: 'requirements', requiredPayloadKeys },
    text: `${FORGE_DELIVERY_PHASE_RESPONSE_START}${JSON.stringify(proposal)}${FORGE_DELIVERY_PHASE_RESPONSE_END}` });
  assert.deepEqual(Object.keys(parsed.payload), requiredPayloadKeys);
  assert.equal(parsed.payload.requirementTrace.functions[0].deliveryCenter.kind, 'function');
  const value = snapshot([artifact('requirements-contract', 'requirements', parsed.payload)]);
  assert.equal(value.requirements.length, 0);
  assert.equal(value.artifacts.filter(row => row.payload?.kind === 'function').length, 1);
  validateDeliverySnapshot(value);
});


test('formal stage reports retain actual role groups, denials and receipt declarations without promoting stage acceptance', () => {
  // Mechanical topic excerpts from business-evidence-source-20261009.txt; declaration, not new verification.
  const actual = {
  "backend": {
    "redTests": {
      "receipts": [
        {
          "reuse": "reused without rerun because source remained unchanged",
          "status": "passed",
          "profile": "governance",
          "receiptId": "491069ef-6851-4243-9115-b7df8697cd8b",
          "blockingFindings": 0
        },
        {
          "status": "passed",
          "profile": "backend-module-compile",
          "freshness": "current",
          "receiptId": "5f98d49b-419b-4217-a37c-5690f70cec5a",
          "executionExitCode": 0
        },
        {
          "reuse": "reused without rerun because source remained unchanged",
          "failed": 0,
          "passed": 1569,
          "status": "passed",
          "profile": "backend-module-test",
          "skipped": 0,
          "executed": 1569,
          "receiptId": "52cc0e23-29cd-424f-a2d5-31f645c4242c"
        }
      ],
      "focusedTests": [
        {
          "path": "forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/fire/service/FireManagementServiceTest.java",
          "coverage": [
            "alarm connection fails closed as unconfigured with null timestamps",
            "DCS equipment fails closed as unconfigured without invented telemetry"
          ]
        },
        {
          "path": "forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/fire/mapper/FireManagementMapperContractTest.java",
          "coverage": [
            "approval node stable states and assigned-handler guards",
            "tenant, active-row, version, tombstone and non-negative stock SQL guards"
          ]
        },
        {
          "path": "forge-server/forge-business/forge-business-core/src/test/java/com/mdframe/forge/business/core/fire/controller/FireControllerContractTest.java",
          "coverage": [
            "all endpoints on the 12 fire controllers have explicit non-empty @SaCheckPermission bindings"
          ]
        }
      ],
      "evidenceBinding": {
        "workspaceFingerprint": "0600142f8d06261f04341a4568a73280da192c020c02db4ba8c1efb4943ddf84",
        "releaseOrLiveAcceptanceProven": false,
        "allReceiptsBindToCurrentCandidate": true
      }
    },
    "permissionEnforcement": {
      "dataScopes": {
        "FIRE_MANAGEMENT": "AUTHORIZED_ORG_ZONE_DEVICE",
        "externalSystems": "CONTRACT_BOUND_SOURCE with no user-page permission",
        "APPLICANT_drafts": "OWN_DRAFTS",
        "APPLICANT_applications": "OWN_APPLICATIONS",
        "inspectionAndApprovalHandlers": "ASSIGNED_TASKS"
      },
      "endpointRule": "Every implemented fire endpoint has a non-empty @SaCheckPermission binding matching the accepted permission contract.",
      "trustedContext": "tenantId is read from TenantContextHolder; current user and organization are read from SessionHelper.",
      "failClosedRules": [
        "Missing or ambiguous role assignment does not fall back to all users or the applicant.",
        "Alarm and fire-map interfaces remain read-only.",
        "File upload alone does not create a fire attachment association or grant business access.",
        "Cross-tenant, out-of-scope, stale-version, duplicate-request and wrong-assignee operations fail closed."
      ],
      "assignedTaskRules": [
        "Inspection maintainer signature requires the persisted inspectorUserId.",
        "Fire-management signature and equipment audit require the configured unique role user for the device organization.",
        "Approval decisions require the persisted pending-node assignee.",
        "Actual-time and recovery-time commands require the assigned PRODUCTION_DISPATCHER node."
      ]
    }
  },
  "access": {
    "roleVisibilityContract": {
      "APPLICANT": {
        "dataScope": "OWN_DRAFTS and OWN_APPLICATIONS",
        "canPerform": [
          "create, edit own draft, submit and resubmit occupy, water and isolation applications",
          "view own applications and results"
        ],
        "displayNameZh": "申请人"
      },
      "denyRules": [
        "Users without fire role keep fail-closed access to fire pages and direct fire APIs.",
        "Production seed does not bind protected ordinary aliases submitter or manager to fire roles.",
        "No admin or wildcard permission is granted to ordinary test identities."
      ],
      "FIRE_MANAGEMENT": {
        "dataScope": "AUTHORIZED_ORG_ZONE_DEVICE",
        "canPerform": [
          "maintain fire equipment ledger, attachments, import and export",
          "maintain detect and maintain records",
          "manage inspection items, maintenance reports and spare parts",
          "read fire alarm data and fire map"
        ],
        "displayNameZh": "消防管理岗位"
      },
      "taskHandlerRoles": {
        "roleKeys": [
          "MAINTENANCE_UNIT_INSPECTOR",
          "FIRE_MANAGEMENT_SIGNER",
          "EQUIPMENT_MANAGEMENT_AUDITOR",
          "DEVICE_MANAGER_APPROVER",
          "EHSS_FIRE_SPECIALIST_APPROVER",
          "EHSS_TRAFFIC_SPECIALIST_APPROVER",
          "FIRE_BRIGADE_APPROVER",
          "EHSS_DEPARTMENT_APPROVER",
          "OPERATIONS_DEPARTMENT_APPROVER",
          "EHSS_DEPARTMENT_MANAGER_APPROVER",
          "OPERATIONS_GENERAL_MANAGER_APPROVER",
          "PRODUCTION_DISPATCHER"
        ],
        "dataScope": "ASSIGNED_TASKS",
        "canPerform": [
          "only the currently assigned inspection, approval, actual-time or recovery-time task for the matching role"
        ]
      }
    },
    "permissionCoherence": {
      "contractId": "063596d103afbdee83cd14bf5c628c12d0b123e1f9b63399492f7031a8214814",
      "governance": {
        "truth": {
          "releaseProven": false,
          "executionProven": true,
          "verificationProven": true,
          "databaseIntegrationProven": false,
          "semanticCorrectnessProven": false
        },
        "status": "passed",
        "profile": "governance",
        "receiptId": "f7a96646-d7ca-4ec8-b458-826fe4516b79",
        "blockingFindings": 0,
        "advisoriesOrRequiresRetained": [
          "FLOW-001 advisory retained from upstream workflow boundary",
          "PERMISSION-001 requires reviewed permission contract",
          "DB-REVIEW-001 requires independent database review",
          "BE-RELIABILITY-001 requires mutation boundary review",
          "OBS-001 requires observability/runbook review"
        ]
      },
      "admissionId": "a8713a0c-bb58-46f6-8928-b10364afeb5b",
      "notYetProven": [
        "real restored test database migration execution for V1.0.20261010",
        "post-repair role allow path with isolated role/org binding",
        "minimal fire CRUD, approval, tenant/org scope, audit, logical delete, Long ID and i18n runtime checks",
        "release or live business acceptance"
      ],
      "backendModuleTest": {
        "truth": {
          "releaseProven": false,
          "executionProven": true,
          "verificationProven": true,
          "databaseIntegrationProven": false,
          "semanticCorrectnessProven": false
        },
        "failed": 0,
        "module": "forge-server/forge-business/forge-business-core",
        "passed": 1576,
        "status": "passed",
        "profile": "backend-module-test",
        "skipped": 0,
        "executed": 1576,
        "freshness": "current",
        "receiptId": "664745f1-c914-44c0-86ed-3291ceda4df6"
      },
      "sourceFingerprint": "5cb0ef8c22ff42628bc5b88127a7bd7e7a704a6c6d1c6b8c6c2784dc5ada0494",
      "runtimeEvidenceReused": {
        "scope": [
          "protected ordinary aliases can log in",
          "ordinary user without fire role is rejected from fire equipment page"
        ],
        "receiptId": "31ab7ebb-4c7d-4225-9a48-c01d5887db74",
        "notRevalidatedThisTurn": true
      },
      "focusedMigrationContractTest": {
        "failed": 0,
        "passed": 7,
        "status": "passed",
        "profile": "backend-red-test",
        "skipped": 0,
        "coverage": [
          "fire role seed contains all 14 active business roles",
          "role_type=3, org_scope_type=2, data_scope=3, role_status=1 and is_system=1 are enforced for active tenant-1 fire roles",
          "sys_role_org applicability is seeded for active tenant-1 organizations",
          "sys_user_org_role and sys_user_role production bindings are not seeded"
        ],
        "executed": 7,
        "receiptId": "7fe7ea53-ca1f-4401-9117-20f18777baef"
      }
    }
  }
};
  const value = snapshot([artifact('backend-implementation', 'backend', actual.backend), artifact('access-wiring-implementation', 'access-wiring', actual.access)]);
  const reports=value.artifacts.filter(row=>row.kind==='specification-asset').map(row=>row.payload);
  assert.equal(reports.length,4);
  const byTopic=new Map(reports.map(row=>[row.sourceTopic,row]));
  for(const [topic,details]of Object.entries({...actual.backend,...actual.access})) {
    const row=byTopic.get(topic);assert.ok(row);assert.deepEqual(row.details,details);
    assert.equal(row.status,'recorded');assert.equal(row.sourcePhaseStatus,'accepted');
    assert.equal(row.sources[0].pointer,`/${topic}`);assert.equal(row.sources[0].taskId,'task-assets');
    assert.deepEqual(row.menuIds,[]);assert.deepEqual(row.menuPaths,[]);assert.deepEqual(row.releaseIds,[]);
    assert.equal(row.functionRefs,undefined);assert.equal(row.menuRefs,undefined);
    assert.equal(row.verification,undefined);assert.equal(row.adoption,undefined);
  }
  assert.equal(byTopic.get('roleVisibilityContract').kind,'permission');
  assert.equal(byTopic.get('roleVisibilityContract').recordType,'permission-contract');
  assert.equal(byTopic.get('roleVisibilityContract').nature,'design');
  assert.equal(byTopic.get('roleVisibilityContract').details.taskHandlerRoles.roleKeys.length,12);
  assert.equal(byTopic.get('roleVisibilityContract').details.denyRules.length,3);
  assert.equal(byTopic.get('permissionEnforcement').recordType,'permission-enforcement');
  assert.equal(byTopic.get('permissionEnforcement').nature,'implementation-observation');
  assert.equal(byTopic.get('redTests').details.receipts.length,3);
  assert.equal(byTopic.get('redTests').details.evidenceBinding.releaseOrLiveAcceptanceProven,false);
  for(const topic of ['redTests','permissionCoherence']){
    assert.equal(byTopic.get(topic).kind,'test');assert.equal(byTopic.get(topic).recordType,'test-evidence-report');assert.equal(byTopic.get(topic).nature,'execution');
  }
  assert.ok(byTopic.get('permissionCoherence').details.notYetProven.length);
  for(const key of ['governance','backendModuleTest','focusedMigrationContractTest'])assert.ok(byTopic.get('permissionCoherence').details[key].receiptId);
});

test('whole report identities bind task phase and topic while explicit metadata and ordinary collections keep authority', () => {
  const original={name:'Shared report title',receipts:[{profile:'governance',receiptId:'fixture-receipt',status:'passed'}],notYetProven:['runtime']};
  const first=snapshot([artifact('backend-implementation','backend',{redTests:original})]);
  const firstReport=first.artifacts.find(row=>row.kind==='specification-asset').payload;
  const revised=snapshot([artifact('backend-implementation','backend',{redTests:{...original,name:'Changed report title',notYetProven:['runtime','release']}})]);
  assert.equal(revised.artifacts.find(row=>row.kind==='specification-asset').payload.assetId,firstReport.assetId);
  const both=snapshot([artifact('backend-implementation','backend',{redTests:original,testEvidence:original}),artifact('frontend-implementation','frontend',{redTests:original})]);
  const payloads=both.artifacts.filter(row=>row.kind==='specification-asset').map(row=>row.payload);
  assert.equal(new Set(payloads.map(row=>row.assetId)).size,3,'backend/frontend/topic reports must not collide');
  const changedTask=structuredClone(first);changedTask.batches[0].taskId='another-task';changedTask.coverage.currentAssetVersionIds=[];
  assert.notEqual(projectDeliveryStageAssets(changedTask).find(row=>row.kind==='specification-asset').payload.assetId,firstReport.assetId);
  const explicit={...original,deliveryCenter:{schemaVersion:1,id:'fixture.explicit.report',kind:'rule',recordType:'owner-defined-report',nature:'design',revision:'explicit-r1',menuApplicability:'none'}};
  const withMetadata=snapshot([artifact('backend-implementation','backend',{redTests:explicit,testEvidence:[{...explicit,deliveryCenter:{...explicit.deliveryCenter,id:'fixture.array.report'}}],apiImplementation:[{name:'Read example',method:'GET',path:'/fixture/read'}]})]);
  const explicitRows=withMetadata.artifacts.filter(row=>row.kind==='specification-asset').map(row=>row.payload);
  for(const id of ['fixture.explicit.report','fixture.array.report']){
    const row=explicitRows.find(row=>row.assetId===id);assert.equal(row.kind,'rule');assert.equal(row.revision,'explicit-r1');assert.equal(row.recordType,'owner-defined-report');assert.equal(row.nature,'design');assert.equal(row.sourceTopic,undefined);assert.equal(row.sourcePhaseStatus,undefined);
  }
  assert.equal(explicitRows.filter(row=>row.kind==='api').length,1);
});
