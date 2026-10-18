#!/usr/bin/env node
// Projects existing, read-only source records. It never authors customer artifacts.
import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { enrichDeliveryPacketDiagrams } from './delivery-center-diagram-index.mjs';

const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const unique = values => [...new Set(values.filter(Boolean))];
const cleanTitle = value => value.replace(/^[\d.、\s]+/, '').replace(/[*`]/g, '').replace(/\s*[（(]菜单\s*\d+[）)].*$/, '').trim();
const technical = /^(id|tenant_id|create_by|created_by|create_time|created_at|update_by|updated_by|update_time|updated_at|deleted|del_flag|version)$/i;

export function buildHistoryPacket({ projectSlug, sourceCommit, recordedAt, menuMetadata, schemaMetadata, sourceCorpus, documentHistory, codeAssets = [] }) {
  if (!/^[a-z][a-z0-9-]{2,31}$/.test(projectSlug) || !/^[a-f0-9]{40}$/.test(sourceCommit) || !Number.isFinite(Date.parse(recordedAt))) throw Error('DELIVERY_HISTORY_IDENTITY_INVALID');
  const resources = menuMetadata.items ?? [], menuRows = resources.filter(row => [1, 2].includes(row.resourceType));
  const byResource = new Map(menuRows.map(row => [String(row.id), row]));
  const menuId = id => `${projectSlug}:menu:${id}`;
  // Preserve malformed legacy configuration without hiding the rest of the tree.
  // Only display parents are cut; the original parent remains inspectable.
  const cycleRoots = new Set();
  for (const row of menuRows) {
    const chain = []; let cursor = row;
    while (cursor) {
      const id = String(cursor.id), repeated = chain.indexOf(id);
      if (repeated >= 0) { chain.slice(repeated).forEach(value => cycleRoots.add(value)); break; }
      chain.push(id); cursor = byResource.get(String(cursor.parentId));
    }
  }
  function lineage(row, seen = new Set()) {
    if (seen.has(String(row.id))) throw Error('DELIVERY_MENU_CYCLE');
    seen.add(String(row.id)); const parent = cycleRoots.has(String(row.id)) ? null : byResource.get(String(row.parentId));
    return [...(parent ? lineage(parent, seen) : []), row.name];
  }
  const menus = menuRows.map(row => ({ id: menuId(row.id), parentId: !cycleRoots.has(String(row.id)) && byResource.has(String(row.parentId)) ? menuId(row.parentId) : null,
    name: row.name, path: lineage(row), sourceKey: `sys_resource:${row.id}`, route: row.path, component: row.component,
    status: Number(row.status) === 1 ? 'enabled' : 'disabled', visible: Number(row.visible) === 1,
    resourceType: row.resourceType, clientCode: row.clientCode, tenantId: row.tenantId, sort: row.sort,
    sourceParentId: String(row.parentId), hierarchyNote: cycleRoots.has(String(row.id)) ? '来源父级存在循环，当前以根节点展示，原配置未修改。' : null,
    sources: [{ kind: 'menu-configuration', sourcePath: `${menuMetadata.schema}.sys_resource`, sourceId: String(row.id), recordedAt }] }));
  const menuById = new Map(menus.map(row => [row.id, row]));
  const names = new Map(), components = new Map();
  for (const menu of menus) {
    names.set(menu.name, [...(names.get(menu.name) ?? []), menu.id]);
    if (menu.component) components.set(menu.component.replace(/^\/+|\.vue$/g, ''), [...(components.get(menu.component.replace(/^\/+|\.vue$/g, '')) ?? []), menu.id]);
  }
  function parentMenu(row) {
    const seen = new Set(); let current = row;
    while (current && !seen.has(String(current.id))) {
      seen.add(String(current.id)); if (byResource.has(String(current.id))) return menuId(current.id);
      current = resources.find(candidate => String(candidate.id) === String(current.parentId));
    }
    return null;
  }
  function explicitMenus(text) {
    const ids = [];
    for (const match of text.matchAll(/(?:forge-admin-ui\/src\/)?views\/([^\s`'"<>]+?)\.vue/g)) ids.push(...(components.get(match[1]) ?? []));
    // A fully specified menu route is an explicit reference. Generic API prefixes
    // and fuzzy title similarity are deliberately not treated as menu ownership.
    for (const match of text.matchAll(/[`'"]([^`'"\n]+)[`'"]/g)) {
      for (const menu of menus) if (menu.route?.startsWith('/') && menu.route === match[1]) ids.push(menu.id);
    }
    return unique(ids);
  }
  const batches = new Map(), assets = new Map(), currentAssetVersionIds = new Set(), requirements = [], requirementVersions = [];
  const audits = documentHistory.audit ?? [];
  const commitInfo = new Map((documentHistory.commits ?? []).map(item => [item.commit, item]));
  function batchFor(commit, at, title) {
    const id = `${projectSlug}:commit:${commit}`;
    if (!batches.has(id)) {
      const refs = audits.filter(item => item.commit === commit);
      batches.set(id, { id, name: commitInfo.get(commit)?.subject ?? title, createdAt: at, sourceCommit: commit,
        taskId: unique(refs.map(item => item.taskId))[0] ?? null,
        sessionId: unique(refs.map(item => item.conversationId))[0] ?? null,
        conversationIds: unique(refs.map(item => item.conversationId)), taskIds: unique(refs.map(item => item.taskId)),
        sources: refs.map(item => ({ kind: 'delivery-audit', commit, taskId: item.taskId ?? null,
          conversationId: item.conversationId ?? null, jobId: item.jobId ?? item.runnerJobId ?? null, status: item.status ?? null, at: item.at ?? item.completedAt ?? null })) });
    }
    return id;
  }
  function addAsset(input, current = true) {
    const base = { description: '', menuIds: [], menuPaths: [], batchIds: [], sourceRevision: sourceCommit, recordedAt,
      status: 'source-only', certainty: 'explicit', sources: [], details: {}, relations: [], commits: [], releaseIds: [], diagram: null, ...input };
    base.menuIds = unique(base.menuIds); base.menuPaths = base.menuIds.map(id => menuById.get(id)?.path).filter(Boolean);
    delete base.revision;
    const revision = hash(base), payload = { ...base, revision };
    const id = `spec-${hash([payload.assetId, revision])}`;
    assets.set(id, { id, kind: 'specification-asset', stageId: null, releaseId: null, payload });
    if (current) currentAssetVersionIds.add(id);
    return payload.assetId;
  }
  const menuSource = row => [{ kind: 'menu-configuration', sourcePath: `${menuMetadata.schema}.sys_resource`, sourceId: String(row.id), recordedAt }];
  for (const row of resources.filter(row => [3, 4].includes(row.resourceType))) {
    const owner = parentMenu(row), kind = row.resourceType === 3 ? 'permission' : 'api';
    addAsset({ assetId: `${projectSlug}:resource:${row.id}`, kind, name: row.name, description: row.remark ?? '',
      menuIds: owner ? [owner] : [], status: Number(row.status) === 1 ? 'configuration-enabled' : 'configuration-disabled',
      sourceRevision: `resource:${hash(row)}`, sources: menuSource(row), details: kind === 'api'
        ? { method: row.apiMethod, path: row.apiUrl, code: row.permission, definitionType: 'registered-api-resource', implementationVerified: false }
        : { code: row.permission, actions: [row.name], roleBindings: '未读取角色授权数据', definitionType: 'button-resource' } });
  }
  const tableCode = new Map(codeAssets.filter(item => item.kind === 'table').map(item => [item.assetId, item]));
  for (const table of schemaMetadata.tables ?? []) {
    const assetId = `${projectSlug}:table:${table.name}`, code = tableCode.get(assetId), fields = (schemaMetadata.columns ?? []).filter(col => col.table === table.name)
      .map(col => ({ name: col.name, type: col.type, nullable: col.nullable === 'YES' || col.nullable === true,
        primaryKey: col.key === 'PRI', description: col.comment, ordinal: col.ordinal, extra: col.extra, isTechnical: technical.test(col.name) }));
    addAsset({ ...code, assetId, kind: 'table', name: table.name, description: table.comment || code?.description || '',
      sourceRevision: `schema:${hash([table, fields])}`, status: 'schema-observed', certainty: 'implementation-derived',
      sources: [{ kind: 'database-metadata', sourcePath: `${schemaMetadata.schema}.${table.name}`, recordedAt }, ...(code?.sources ?? [])],
      details: { ...(code?.details ?? {}), schema: schemaMetadata.schema, fields,
        businessFields: fields.filter(field => !field.isTechnical).map(field => field.name),
        technicalFields: fields.filter(field => field.isTechnical).map(field => field.name),
        indexes: (schemaMetadata.indexes ?? []).filter(index => index.table === table.name),
        physicalForeignKeysRead: false, definitionType: 'observed-schema' } });
  }
  for (const asset of codeAssets.filter(item => item.kind !== 'table')) addAsset(asset);

  const currentFiles = new Map((sourceCorpus.files ?? []).filter(file => file.path.startsWith('code-copilot/changes/') && file.path.endsWith('.md')).map(file => [file.path, file]));
  const documents = [...(documentHistory.documents ?? [])];
  // Include existing documents absent from the path-limited Git history. Their
  // creation commit remains unknown; sourceCommit only identifies the snapshot.
  for (const file of currentFiles.values()) if (file.path.endsWith('/spec.md') && !documents.some(doc => doc.path === file.path && doc.sha256 === file.sha256)) {
    documents.push({ ...file, commit: sourceCommit, committedAt: null, snapshotOnly: true });
  }
  const currentDocumentVersions = new Map();
  for (const doc of documents) if (!currentDocumentVersions.has(doc.path) && currentFiles.get(doc.path)?.sha256 === doc.sha256) currentDocumentVersions.set(doc.path, `${doc.commit}:${doc.sha256}`);
  for (const doc of documents) {
    if (/\/(?:tasks|execution-log)\.md$/.test(doc.path)) continue;
    const isSpec = /\/spec\.md$/.test(doc.path), isTest = /\/test-spec\.md$/.test(doc.path);
    if (!isSpec && !isTest) continue;
    const at = doc.committedAt ?? recordedAt, current = currentDocumentVersions.get(doc.path) === `${doc.commit}:${doc.sha256}`;
    const title = doc.content.match(/^#\s+(.+)$/m)?.[1] ?? path.posix.basename(path.posix.dirname(doc.path));
    const batchId = batchFor(doc.commit, at, title), source = { kind: doc.snapshotOnly ? 'repository-snapshot' : 'git-document',
      sourcePath: doc.path, sourceCommit: doc.commit, digest: doc.sha256, batchId, stageId: null, recordedAt: doc.committedAt,
      conversationIds: batches.get(batchId).conversationIds };
    const documentMenus = explicitMenus(doc.content), sections = [];
    const lines = doc.content.split(/\r?\n/); let section = { title, start: 1, lines: [] };
    for (let index = 0; index < lines.length; index++) {
      const match = lines[index].match(/^##\s+(.+)$/);
      if (match) { if (section.lines.join('\n').trim()) sections.push(section); section = { title: match[1], start: index + 1, lines: [] }; }
      else section.lines.push(lines[index]);
    }
    if (section.lines.join('\n').trim()) sections.push(section);
    let inheritedMenus = [];
    for (const entry of sections) {
      const body = entry.lines.join('\n').trim(); if (!body) continue;
      const heading = cleanTitle(entry.title), exact = names.get(heading);
      if (exact?.length === 1) inheritedMenus = exact;
      const scope = exact?.length === 1 ? exact : unique([...inheritedMenus, ...explicitMenus(body)]);
      const linkedMenus = scope.length ? scope : documentMenus;
      const sourceDetail = { ...source, line: entry.start, sourceId: `${doc.path}#${entry.title}` };
      if (isTest) {
        addAsset({ assetId: `${projectSlug}:test:${hash([doc.path, entry.title]).slice(0, 32)}`, kind: 'test', name: `${title} · ${entry.title}`,
          description: body, menuIds: linkedMenus, batchIds: [batchId], sourceRevision: doc.commit, recordedAt: at,
          status: 'documented', sources: [sourceDetail], details: { expectedResult: body, actualResult: null, evidence: [], sourceDocument: doc.path }, commits: [doc.commit] }, current);
        continue;
      }
      // The row remains a quoted specification section, not an invented atomic
      // feature. Counts label this granularity separately from stage use cases.
      const id = `${projectSlug}:requirement:${hash([doc.path, entry.title]).slice(0, 32)}`;
      const item = { id, menuId: linkedMenus[0] ?? null, menuIds: linkedMenus, menuPath: menuById.get(linkedMenus[0])?.path ?? [],
        page: null, name: `${title} · ${entry.title}`, description: body, fields: [], actions: [], rules: [], permissions: [],
        batchIds: [batchId], stageStatus: {}, status: 'documented', certainty: 'explicit', sources: [sourceDetail],
        sourceCommit: doc.commit, sourceRecordedAt: doc.committedAt, granularity: 'specification-section',
        originalDocument: { path: doc.path, title, section: entry.title, line: entry.start }, commits: [doc.commit] };
      item.revision = hash(item);
      requirementVersions.push(item); if (current) requirements.push(item);
      let diagramIndex = 0;
      for (const match of body.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)) {
        const diagram = match[1].trim(), type = /^erDiagram\b/.test(diagram) ? 'erDiagram' : /^(?:flowchart|graph)\b/.test(diagram) ? 'flowchart' : null;
        if (!type) continue;
        addAsset({ assetId: `${projectSlug}:diagram:${hash([doc.path, entry.title, diagramIndex++]).slice(0, 32)}`, kind: type === 'erDiagram' ? 'entity' : 'scene',
          name: `${title} · ${entry.title}`, description: body, menuIds: linkedMenus, batchIds: [batchId], sourceRevision: doc.commit, recordedAt: at,
          status: 'documented', sources: [sourceDetail], commits: [doc.commit], details: { definitionType: 'source-diagram', sourceDocument: doc.path },
          diagram: { type, source: diagram, sourceRefs: [sourceDetail] } }, current);
      }
      if (/业务流程|审批流程|状态流转|场景|工作流/.test(heading)) addAsset({ assetId: `${projectSlug}:scene:${hash([doc.path, entry.title]).slice(0, 32)}`,
        kind: 'scene', name: `${title} · ${entry.title}`, description: body, menuIds: linkedMenus, batchIds: [batchId], sourceRevision: doc.commit, recordedAt: at,
        status: 'documented', sources: [sourceDetail], commits: [doc.commit], details: { description: body, definitionType: 'specification-section' } }, current);
    }
  }
  return { schemaVersion: 1, projectSlug, sourceCommit, recordedAt,
    source: { kind: 'verified-source-projection', revision: sourceCommit, label: `${projectSlug} 历史文档、菜单配置及数据库结构只读提取` },
    menus, batches: [...batches.values()], requirements, requirementVersions,
    assets: [...assets.values()], currentAssetVersionIds: [...currentAssetVersionIds],
    coverage: { menuConfigurationCount: menus.length, specificationSectionCount: requirements.length,
      unlinkedSpecificationSections: requirements.filter(item => !item.menuId).length,
      documentRevisionCount: documents.length, businessRowsRead: 0, automaticInference: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, output] = process.argv.slice(2); if (!directory || !output) throw Error('Usage: delivery-center-history-index.mjs SOURCE_DIRECTORY OUTPUT_JSON');
  const read = async filename => JSON.parse((await readFile(path.join(directory, filename), 'utf8')).replace(/^\uFEFF/, ''));
  const [menuMetadata, schemaMetadata, sourceCorpus, documentHistory] = await Promise.all(['menu-metadata.json', 'schema-metadata.json', 'source-corpus.json', 'document-history.json'].map(read));
  const recordedAt = (await stat(path.join(directory, 'menu-metadata.json'))).mtime.toISOString();
  let codeAssets = []; try { codeAssets = await read('code-assets.json'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const packet = enrichDeliveryPacketDiagrams(buildHistoryPacket({ projectSlug: sourceCorpus.projectSlug, sourceCommit: sourceCorpus.sourceCommit, recordedAt, menuMetadata, schemaMetadata, sourceCorpus, documentHistory, codeAssets }));
  await writeFile(output, `${JSON.stringify(packet)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ menus: packet.menus.length, batches: packet.batches.length, requirements: packet.requirements.length,
    requirementVersions: packet.requirementVersions.length, assets: packet.assets.length, currentAssets: packet.currentAssetVersionIds.length, coverage: packet.coverage }));
}
