import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { collectCommittedDeliveryDocuments } from '../docker/harness/delivery-center-document-source.mjs';
import { collectDeliverySnapshot } from '../docker/harness/delivery-center-projection.mjs';
import { readDeliverySources, importDeliverySources } from '../docker/harness/delivery-center-import.mjs';
import { validateDeliverySnapshot } from '../docker/harness/delivery-center-store.mjs';

const PROJECT = { projectSlug: 'forge-base', projectName: '平台合成示例', phaseRoot: null, releaseAuditPath: null };
const DOC = 'code-copilot/changes/fixture/spec.md';
const ID = { menu: 'forge-base:menu:fixture', function: 'forge-base:function:fixture', requirement: 'forge-base:requirement:fixture' };
const git = (cwd, ...args) => execFileSync('git', ['-c', `safe.directory=${cwd}`, '-C', cwd, ...args],
  { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const fence = records => `# 平台合成示例，非客户产物\n\n\`\`\`json delivery-center\n${JSON.stringify({ records }, null, 2)}\n\`\`\`\n`;
const metadata = (kind, revision, extra = {}) => ({ schemaVersion: 1, kind, id: ID[kind], revision,
  nature: 'design', menuRefs: kind === 'menu' ? [] : [{ kind: 'menu', id: ID.menu, revision: 'menu-v1' }], ...extra });
const definitions = revision => [
  { name: '示例菜单', menuPath: ['示例菜单'], deliveryCenter: metadata('menu', 'menu-v1') },
  { name: '示例功能', description: revision, deliveryCenter: metadata('function', revision) },
  { name: '示例独立要求', description: revision, deliveryCenter: metadata('requirement', revision,
    { recordType: 'requirement', functionRefs: [{ kind: 'function', id: ID.function, revision }] }) },
];
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'delivery-documents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'user.name', 'Platform Fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  await mkdir(path.join(root, 'empty-hooks')); git(root, 'config', 'core.hooksPath', path.join(root, 'empty-hooks'));
  await mkdir(path.dirname(path.join(root, DOC)), { recursive: true });
  const commit = async content => { await writeFile(path.join(root, DOC), content); git(root, 'add', '--', 'code-copilot/changes'); git(root, 'commit', '-m', 'fixture'); return git(root, 'rev-parse', 'HEAD'); };
  return { root, commit, project: { ...PROJECT, committedDocuments: { repositoryRoot: root } } };
}

test('committed documents preserve true source, history and current IDs; unchanged HEAD uses cache and worktree text is ignored', async t => {
  const { root, commit, project } = await fixture(t);
  // More ordinary documents than the marked-file bound must not block startup.
  await Promise.all(Array.from({ length: 270 }, (_, index) => writeFile(path.join(root, `code-copilot/changes/ordinary-${index}.md`), '# 普通历史资料\n')));
  const first = await commit(fence(definitions('v1')));
  const config = path.join(root, 'sources.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, projects: [project] }));
  assert.equal((await readDeliverySources(config))[0].committedDocuments.repositoryRoot, root);
  const value = await collectDeliverySnapshot(project); validateDeliverySnapshot(value);
  assert.equal(value.stages.length, 0); assert.equal(value.batches.length, 0);
  assert.equal(value.requirements.length, 1); assert.equal(value.menus.length, 1);
  const feature = value.artifacts.find(row => row.payload.kind === 'function');
  assert.equal(feature.stageId, null); assert.equal(feature.payload.status, 'documented');
  assert.equal(feature.payload.adoption.state, 'unknown'); assert.equal(feature.payload.revision, 'v1');
  assert.deepEqual(feature.payload.commits, [first]); assert.equal(feature.payload.sourceRevision, first);
  assert.deepEqual(value.coverage.currentAssetVersionIds, [feature.id]);
  assert.equal(value.requirements[0].stageId, null); assert.deepEqual(value.requirements[0].stageStatus, {});
  const source = feature.payload.sources[0]; const blob = git(root, 'rev-parse', `${first}:${DOC}`);
  assert.equal(source.commit, first); assert.equal(source.blob, blob); assert.equal(source.sourcePath, DOC);
  assert.equal(source.fenceLine, 3); assert.equal(source.line, 4); assert.equal(source.pointer, '/records/1');
  assert.equal(value.coverage.committedDocuments.excludedMarkedFiles, 0);
  assert.equal(value.coverage.committedDocuments.includesUncommittedConversations, false);
  assert.equal(value.coverage.committedDocuments.definitionBlocks, 1);

  await writeFile(path.join(root, DOC), '```json delivery-center\ninvalid uncommitted text\n```');
  // Temporarily remove only this fixture's loose document blob. Resolving HEAD
  // still works; a repeated scan/cat-file would fail, whereas the cache succeeds.
  const objectFile = path.join(root, '.git/objects', blob.slice(0, 2), blob.slice(2));
  await rename(objectFile, `${objectFile}.fixture-held`);
  try {
    const unchanged = await collectDeliverySnapshot(project);
    assert.deepEqual(unchanged.artifacts, value.artifacts);
    assert.deepEqual(unchanged.requirementVersions, value.requirementVersions);
  } finally { await rename(`${objectFile}.fixture-held`, objectFile); }

  const second = await commit(fence(definitions('v2')));
  const updated = await collectDeliverySnapshot(project); validateDeliverySnapshot(updated);
  const assets = updated.artifacts.filter(row => row.payload.kind === 'function');
  assert.equal(assets.length, 2); assert.equal(updated.requirementVersions.length, 2);
  assert.deepEqual(new Set(assets.map(row => row.payload.sourceRevision)), new Set([first, second]));
  assert.deepEqual(updated.coverage.currentAssetVersionIds, [assets.find(row => row.payload.revision === 'v2').id]);
  assert.deepEqual(assets.find(row => row.payload.revision === 'v1'), feature);
  assert.equal(updated.coverage.committedDocuments.historyMode, 'incremental');
  await commit('# 专用块已移除，旧记录保持历史来源\n');
  const removed = await collectDeliverySnapshot(project); validateDeliverySnapshot(removed);
  assert.equal(removed.artifacts.length, 2); assert.deepEqual(removed.coverage.currentAssetVersionIds, []);
  await writeFile(config, JSON.stringify({ schemaVersion: 1, projects: [{ ...project, committedDocuments: { repositoryRoot: 'relative' } }] }));
  await assert.rejects(readDeliverySources(config), /DELIVERY_SOURCE_INVALID/u);
});

test('failed committed-source reads and malformed current JSON preserve the previous snapshot; corrected HEAD records old failure and resumes', async t => {
  const { root, commit, project } = await fixture(t);
  await commit(fence(definitions('v1')));
  const stored = []; const store = { overview: async () => ({ counts: { stages: 0 } }),
    importSnapshot: async snapshot => { validateDeliverySnapshot(snapshot); stored.push(snapshot); return { projectSlug: PROJECT.projectSlug, changed: true }; } };
  assert.equal((await importDeliverySources({ store, projects: [project] })).ok, true);
  const invalidCommit = await commit('```json delivery-center\n{ invalid\n```');
  const rejected = await importDeliverySources({ store, projects: [project] });
  assert.equal(rejected.ok, false); assert.equal(rejected.results[0].code, 'COMMITTED_DOCUMENT_INVALID_JSON');
  assert.equal(rejected.results[0].preservedPreviousSnapshot, true); assert.equal(stored.length, 1);
  const unavailable = await importDeliverySources({ store, projects: [{ ...project, committedDocuments: { repositoryRoot: path.join(root, 'missing') } }] });
  assert.equal(unavailable.ok, false); assert.equal(unavailable.results[0].preservedPreviousSnapshot, true); assert.equal(stored.length, 1);
  await commit(fence(definitions('v2')));
  assert.equal((await importDeliverySources({ store, projects: [project] })).ok, true);
  assert.equal(stored.length, 2); assert.equal(stored[1].artifacts.length, 2);
  assert.deepEqual(stored[1].coverage.committedDocuments.invalidHistoricalDefinitions.map(row => row.commit), [invalidCommit]);
  assert.equal(stored[1].coverage.committedDocuments.historicalRangeComplete, false);
});

test('bounded initial history can read an explicitly marked old revision after its block was removed', async t => {
  const { root, commit } = await fixture(t);
  const first = await commit(fence(definitions('v1')));
  await commit('# 普通现存文档\n');
  const result = await collectCommittedDeliveryDocuments({ projectSlug: PROJECT.projectSlug, repositoryRoot: root });
  assert.equal(result.documents.length, 1); assert.equal(result.documents[0].commit, first);
  assert.equal(result.documents[0].isCurrent, false); assert.equal(result.coverage.historyMode, 'bounded-history');
});
