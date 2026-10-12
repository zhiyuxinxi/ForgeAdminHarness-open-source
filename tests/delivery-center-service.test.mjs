import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import test from 'node:test';
import { createDeliveryCenterClient, createDeliveryReadServer } from '../docker/harness/delivery-center-service.mjs';
import { importDeliverySources, parseDeliveryImportOptions, readDeliverySources, readRegistryDeliverySources, selectDeliveryProjects } from '../docker/harness/delivery-center-import.mjs';
import { collectDeliverySnapshot, deliverySnapshotDigest } from '../docker/harness/delivery-center-projection.mjs';
import { validateDeliverySnapshot } from '../docker/harness/delivery-center-store.mjs';
import { PROJECT_REGISTRY_COLUMNS } from '../docker/harness/project-directory.mjs';

test('stage detail transport carries exact revision and scope without list bodies or latest fallback', async () => {
  const revision = 'a'.repeat(64); const calls = [];
  const original = { id: 'task-a:stage-domain', revision, isCurrent: false,
    details: { rawDefinition: '历史阶段原件', sourcePath: 'stage/domain.json' } };
  const store = { getStage: async (project, id, filters) => {
    calls.push({ project, id, filters });
    return id === original.id && filters.revision === revision ? original : null;
  } };
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\forge-stage-detail-${crypto.randomUUID()}`
    : path.join(os.tmpdir(), `forge-stage-detail-${crypto.randomUUID()}.sock`);
  const server = createDeliveryReadServer({ store, projectSlug: 'forge-base' });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const client = createDeliveryCenterClient({ socketPath });
  try {
    const filters = { revision, batchId: 'batch-a', menuId: 'menu-a', detailMode: 'single', isCurrent: 'false' };
    assert.deepEqual(await client.getStage('forge-base', original.id, filters), original);
    assert.equal(calls[0].project, 'forge-base'); assert.equal(calls[0].id, original.id);
    for (const [key, value] of Object.entries(filters)) assert.equal(calls[0].filters[key], value);
    await assert.rejects(client.getStage('forge-base', original.id, {}), error => error.code === 'DELIVERY_NOT_FOUND' && error.status === 404);
    await assert.rejects(client.getStage('forge-base', original.id, { revision: 'b'.repeat(64) }), error => error.code === 'DELIVERY_NOT_FOUND' && error.status === 404);
    await assert.rejects(client.getStage('other-project', original.id, { revision }), error => error.code === 'DELIVERY_NOT_FOUND' && error.status === 404);
    assert.equal(calls.length, 3, 'wrong project never reaches stage lookup; no list fallback exists');
    assert.equal(calls[1].filters.revision, undefined); assert.equal(calls[2].filters.revision, 'b'.repeat(64));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('private read-service transport carries filters, frozen detail and full export, and has no write operation', async () => {
  const calls = [];
  const store = {
    listProjects: async () => [{ slug: 'demo-project', name: '示例' }],
    listMenus: async (project, filters) => [{ id: 'frozen-menu', name: filters.releaseId }],
    listRequirements: async (project, filters) => { calls.push({ project, filters }); return { items: [], total: 0, page: filters.page, pageSize: filters.pageSize }; },
    getRequirement: async (project, id, filters) => ({ id, project, revision: filters.releaseId }),
    listAssets: async (project, filters) => ({ items: [{ assetId: 'entity-shared', kind: filters.kind, menuIds: [filters.menuId] }], total: 1, page: filters.page, pageSize: filters.pageSize }),
    getAsset: async (project, id, filters) => id === 'missing' ? null : ({ assetId: id, project, revision: filters.revision }),
    exportRequirements: async () => [{ id: 'req-one' }, { id: 'req-two' }],
    listView: async (project, filters) => ({ items: [{ name: filters.view, parentRef: { kind: 'api', id: 'api-one', revision: 'r1' } }], total: 1, scope: { menuScope: filters.menuScope, snapshotDigest: 'a'.repeat(64) } }),
    exportView: async (project, filters) => ({ items: [{ rowType: 'unbound' }], scope: { snapshotDigest: filters.snapshotDigest }, counts: { relationRows: 1 } }),
    listStages: async () => { throw new Error('sensitive SQL connection information'); },
  };
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\forge-dc-${crypto.randomUUID()}` : path.join(os.tmpdir(), `forge-dc-${crypto.randomUUID()}.sock`);
  const server = createDeliveryReadServer({ store });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const client = createDeliveryCenterClient({ socketPath });
  try {
    assert.equal((await client.listProjects())[0].slug, 'demo-project');
    await client.listRequirements('demo-project', { q: '消防', menuId: 'menu-one', page: 2, pageSize: 20 });
    assert.equal(calls[0].filters.q, '消防'); assert.equal(calls[0].filters.page, 2);
    assert.equal((await client.getRequirement('demo-project', 'req-one', { releaseId: 'release-old' })).revision, 'release-old');
    assert.equal((await client.listMenus('demo-project', { releaseId: 'release-old' }))[0].name, 'release-old');
    assert.equal((await client.exportRequirements('demo-project', {})).length, 2);
    const view = await client.listView('demo-project', { view: 'calls', menuScope: 'self' });
    assert.equal(view.items[0].name, 'calls'); assert.equal(view.scope.menuScope, 'self');
    const matrix = await client.exportView('demo-project', { view: 'requirement-matrix', snapshotDigest: view.scope.snapshotDigest });
    assert.equal(matrix.scope.snapshotDigest, view.scope.snapshotDigest); assert.equal(matrix.counts.relationRows, 1);
    assert.equal((await client.listAssets('demo-project', { kind: 'entity', menuId: '100' })).items[0].menuIds[0], '100');
    assert.equal((await client.getAsset('demo-project', 'entity-shared', { revision: 'a'.repeat(64) })).revision, 'a'.repeat(64));
    await assert.rejects(client.getAsset('demo-project', 'missing'), error => error.code === 'DELIVERY_NOT_FOUND' && error.status === 404);
    await assert.rejects(client.listStages('demo-project'), (error) => error.code === 'DELIVERY_UNAVAILABLE' && !error.message.includes('sensitive'));
    const writeStatus = await new Promise((resolve, reject) => {
      const req = http.request({ socketPath, path: '/v1/requirements?project=demo-project', method: 'POST' }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(writeStatus, 405);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('importer project option selects only its named project for sources and each registry watch round', async () => {
  const projects = [{ projectSlug: 'forge-base' }, { projectSlug: 'other-project' }];
  const sourceArgs = parseDeliveryImportOptions(['--config', 'private.json', '--sources', 'sources.json', '--project', 'forge-base']);
  const registryArgs = parseDeliveryImportOptions(['--config', 'private.json', '--registry', path.resolve('projects.tsv'),
    '--projects-root', path.resolve('projects'), '--watch', '--project', 'forge-base']);
  assert.equal(sourceArgs.project, 'forge-base'); assert.equal(registryArgs.watch, true);
  assert.equal(selectDeliveryProjects(projects), projects);
  const imported = []; const collected = [];
  for (const [args, roundProjects] of [[sourceArgs, projects], [registryArgs, projects],
    [registryArgs, [...projects, { projectSlug: 'new-project' }]]]) {
    const receipt = await importDeliverySources({ projects: selectDeliveryProjects(roundProjects, args.project),
      collect: async ({ projectSlug }) => { collected.push(projectSlug); return { project: { slug: projectSlug } }; },
      store: { importSnapshot: async (snapshot) => { imported.push(snapshot.project.slug); return { projectSlug: snapshot.project.slug }; } } });
    assert.equal(receipt.ok, true); assert.equal(receipt.results.length, 1);
  }
  assert.deepEqual(collected, ['forge-base', 'forge-base', 'forge-base']); assert.deepEqual(imported, collected);
  assert.throws(() => selectDeliveryProjects(projects, 'missing-project'), { code: 'DELIVERY_PROJECT_NOT_FOUND' });
  assert.throws(() => selectDeliveryProjects([], registryArgs.project), { code: 'DELIVERY_PROJECT_NOT_FOUND' });
  assert.throws(() => parseDeliveryImportOptions(['--config', 'private.json', '--sources', 'sources.json', '--project']), /DELIVERY_ARGUMENT_INVALID/u);
  assert.throws(() => parseDeliveryImportOptions(['--config', 'private.json', '--sources', 'sources.json', '--project', '../other']), /DELIVERY_ARGUMENT_INVALID/u);
});

test('importer preserves prior snapshots after incomplete reads while importing independent readable projects', async () => {
  const written = [];
  const projects = [{ projectSlug: 'project-one' }, { projectSlug: 'project-two' }];
  const receipt = await importDeliverySources({ projects, store: { importSnapshot: async (value) => { written.push(value.project.slug); return { projectSlug: value.project.slug, changed: true }; } },
    collect: async ({ projectSlug }) => ({ project: { slug: projectSlug }, coverage: { gaps: projectSlug === 'project-one' ? [{ code: 'ARTIFACT_READ_FAILED' }] : [{ code: 'RELEASE_SOURCE_MISSING' }] } }) });
  assert.equal(receipt.ok, false); assert.deepEqual(written, ['project-two']);
  assert.equal(receipt.results[0].preservedPreviousSnapshot, true);
  assert.equal(receipt.results[1].ok, true);
});

test('importer admits readable history with noncurrent unverified repairs but preserves snapshots on removed or unreadable sources', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dc-source-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'sources.json');
  const phaseRoot = path.join(directory, 'phases');
  const phaseDirectory = path.join(phaseRoot, 'task-one', 'phase-control');
  const repairDirectory = path.join(phaseDirectory, 'access-wiring-repair');
  const now = '2026-10-08T13:00:00.000Z'; const commit = 'a'.repeat(40);
  const seal = (value, key) => ({ ...value, [key]: deliverySnapshotDigest(value) });
  const original = seal({ schemaVersion: 'forge-delivery-phase-artifact/v1', workflowId: 'crud-production',
    artifactKind: 'requirements-contract', phaseId: 'requirements', sourceFingerprint: 'b'.repeat(64),
    payload: { requirements: [{ id: 'REQ-1', name: '查看设备', menuPath: ['设备管理'] }] } }, 'artifactDigest');
  const repaired = seal({ schemaVersion: 'forge-delivery-phase-artifact/v1', workflowId: 'crud-production',
    artifactKind: 'access-wiring-implementation', phaseId: 'access-wiring', sourceFingerprint: 'b'.repeat(64),
    payload: { menuSeed: { resourceName: '未核实修复菜单' } } }, 'artifactDigest');
  const state = artifacts => seal({ schemaVersion: 'forge-delivery-phase-state/v2', taskId: 'task-one',
    sessionId: 'session-one', workflowId: 'crud-production', sourceCommit: commit, status: 'active',
    currentPhaseId: 'domain-contract', createdAt: now, updatedAt: now,
    acceptedArtifacts: Object.fromEntries(artifacts.map(item => [item.artifactKind, item.artifactDigest])),
    history: artifacts.map(item => ({ phaseId: item.phaseId, artifactDigest: item.artifactDigest,
      decision: 'accepted', completedAt: now })) }, 'stateDigest');
  for (const [folder, artifacts] of [[phaseDirectory, [original]], [repairDirectory, [original, repaired]]]) {
    await mkdir(path.join(folder, 'artifacts'), { recursive: true });
    await writeFile(path.join(folder, 'state.json'), JSON.stringify(state(artifacts)));
    for (const item of artifacts) await writeFile(path.join(folder, 'artifacts', `${item.artifactKind}.json`), JSON.stringify(item));
  }
  // Missing repair binding is retained as uncertainty, not promoted to current.
  const historyPath = path.join(directory, 'history.json');
  const historyAsset = { id: 'history-page-version', kind: 'specification-asset', stageId: null, releaseId: null,
    payload: { assetId: 'history-page', kind: 'page', name: '已有历史页面', description: '独立已提交文档',
      menuIds: [], menuPaths: [], batchIds: [], revision: 'c'.repeat(64), sourceRevision: commit,
      recordedAt: now, status: 'source-only', certainty: 'explicit',
      sources: [{ kind: 'git-document', path: 'code-copilot/changes/example/spec.md', commit }],
      details: { purpose: '查看设备' }, relations: [], commits: [], releaseIds: [], diagram: null } };
  await writeFile(historyPath, JSON.stringify({ schemaVersion: 1, projectSlug: 'repair-project',
    sourceCommit: commit, recordedAt: now, source: { kind: 'git-document', revision: commit },
    menus: [], batches: [], requirements: [], requirementVersions: [], assets: [historyAsset],
    currentAssetVersionIds: [historyAsset.id] }));
  const projects = [
    { projectSlug: 'old-project', projectName: '已有阶段', phaseRoot: null, releaseAuditPath: null },
    { projectSlug: 'new-project', projectName: '尚未收录', phaseRoot: null, releaseAuditPath: null },
    { projectSlug: 'repair-project', projectName: '关联未核对', phaseRoot, releaseAuditPath: null, historyPacketPaths: [historyPath] },
  ];
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, projects }));
  assert.deepEqual(await readDeliverySources(filename), projects);
  const collected = []; const written = [];
  const store = { overview: async slug => ({ counts: { stages: slug === 'old-project' ? 7 : 0 } }),
    importSnapshot: async snapshot => { validateDeliverySnapshot(snapshot); written.push(snapshot);
      return { projectSlug: snapshot.project.slug, changed: true }; } };
  const receipt = await importDeliverySources({ projects: await readDeliverySources(filename), store,
    now: () => now, collect: async options => { collected.push(options.projectSlug); return collectDeliverySnapshot(options); } });
  assert.deepEqual(collected, ['new-project', 'repair-project']);
  assert.deepEqual(written.map(snapshot => snapshot.project.slug), ['new-project', 'repair-project']);
  assert.equal(receipt.results[0].code, 'DELIVERY_SOURCE_REMOVED');
  assert.equal(receipt.results[0].preservedPreviousSnapshot, true);
  assert.equal(receipt.results[1].ok, true);
  assert.equal(receipt.results[2].ok, true);
  const imported = written[1];
  assert.equal(imported.coverage.availability, 'partial');
  assert.ok(imported.coverage.gaps.some(gap => gap.code === 'REPAIR_LINK_UNVERIFIED'));
  assert.deepEqual(imported.artifacts.find(item => item.id === historyAsset.id), historyAsset);
  assert.ok(imported.coverage.currentAssetVersionIds.includes(historyAsset.id));
  assert.equal(imported.stages.find(stage => stage.digest === original.artifactDigest).isCurrent, true);
  const historicRepair = imported.stages.find(stage => stage.digest === repaired.artifactDigest);
  assert.equal(historicRepair.isCurrent, false); assert.equal(historicRepair.status, 'historical');
  assert.ok(!imported.menus.some(menu => menu.name === '未核实修复菜单'));
  for (const [file, gapCode, validContent] of [
    [path.join(repairDirectory, 'state.json'), 'STATE_UNAVAILABLE', state([original, repaired])],
    [path.join(repairDirectory, 'artifacts', 'access-wiring-implementation.json'), 'ARTIFACT_READ_FAILED', repaired],
  ]) {
    await writeFile(file, '{unfinished');
    const failed = await importDeliverySources({ projects: [projects[2]], store, now: () => now });
    assert.equal(failed.ok, false); assert.equal(failed.results[0].code, 'DELIVERY_SOURCE_INCOMPLETE');
    assert.ok(failed.results[0].gapCodes.includes(gapCode));
    assert.equal(failed.results[0].preservedPreviousSnapshot, true);
    assert.equal(written.length, 2); assert.equal(written[1], imported);
    await writeFile(file, JSON.stringify(validContent));
  }
  for (const key of ['phaseRoot', 'releaseAuditPath']) {
    const missing = { ...projects[1] }; delete missing[key];
    await writeFile(filename, JSON.stringify({ schemaVersion: 1, projects: [missing] }));
    await assert.rejects(readDeliverySources(filename), /DELIVERY_SOURCE_INVALID/u);
  }
});

test('each registry read discovers newly available phase sources and newly registered projects without creating business directories', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dc-live-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const projectsRoot = path.join(directory, 'projects'); const registryPath = path.join(directory, 'projects.tsv');
  await mkdir(projectsRoot);
  const row = (slug, port, name) => [slug, name, port, '', 'main', 'a'.repeat(40), '2026-10-07T00:00:00Z', 'delivery', '', '', '', ''].join('\t');
  const header = PROJECT_REGISTRY_COLUMNS.join('\t');
  await writeFile(registryPath, `${header}\n${row('project-one', 18080, '原项目')}\n`);
  assert.deepEqual(await readRegistryDeliverySources({ registryPath, projectsRoot }), [
    { projectSlug: 'project-one', projectName: '原项目', phaseRoot: null, releaseAuditPath: null, brokerAuditPath: null },
  ]);
  const phase = path.join(projectsRoot, 'project-one', 'taskspaces', '.broker', 'delivery-phases');
  const audit = path.join(projectsRoot, 'project-one', 'ops', 'release-audit.jsonl');
  const brokerAudit = path.join(projectsRoot, 'project-one', 'taskspaces', '.broker', 'audit.jsonl');
  await mkdir(phase, { recursive: true }); await mkdir(path.dirname(audit)); await writeFile(audit, '');
  await writeFile(brokerAudit, '');
  await writeFile(registryPath, `${header}\n${row('project-one', 18080, '原项目')}\n${row('project-two', 18081, '新增项目')}\n`);
  assert.deepEqual(await readRegistryDeliverySources({ registryPath, projectsRoot }), [
    { projectSlug: 'project-one', projectName: '原项目', phaseRoot: phase, releaseAuditPath: audit, brokerAuditPath: brokerAudit },
    { projectSlug: 'project-two', projectName: '新增项目', phaseRoot: null, releaseAuditPath: null, brokerAuditPath: null },
  ]);
  // A symbolic project directory is an unsafe source, not an absent project.
  const outside = path.join(directory, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(projectsRoot, 'project-two'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readRegistryDeliverySources({ registryPath, projectsRoot }), /DELIVERY_REGISTRY_SOURCE_UNSAFE/u);
});
