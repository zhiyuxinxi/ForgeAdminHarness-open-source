import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { deliveryDisplayRecord } from './delivery-center-semantics.mjs';
import { generateExplicitRelationshipDiagram, withFlowDiagramNavigation } from './delivery-center-diagrams.mjs';
import { validateSpecificationArtifact, deliveryAssetVersions, listDeliveryAssets, getDeliveryAsset, deliveryAssetCounts, deliveryMenuDescendants, groupsDeliveryMenuReferences, withExplicitRelationDetails } from './delivery-center-assets.mjs';
import { DELIVERY_VIEWS, viewReadDetailKeys, HEADER_KEYS, summaryDetailKeys, semanticMatch, deliverySummary, historyMetadata,
  requirementType, recordRef, buildSubview, paginateView, requirementMatrix, matrixIdentityCounts, withFunctionAssociation } from './delivery-center-views.mjs';
export { readDeliveryDatabaseConfig as readDeliveryCenterDatabaseConfig } from './delivery-center-config.mjs';

const require = createRequire(import.meta.url);
const SLUG = /^[a-z][a-z0-9-]{2,31}$/u;
const MAX_ENTITIES = 10000;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const ENTITY_LISTS = ['batches', 'menus', 'requirements', 'stages', 'releases', 'artifacts'];

export class DeliveryCenterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DeliveryCenterError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message) { throw new DeliveryCenterError('DELIVERY_INPUT_INVALID', message); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, label, maximum = 191, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid.`);
  return value;
}
function slug(value) { if (typeof value !== 'string' || !SLUG.test(value)) invalid('Project slug is invalid.'); return value; }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function digest(value) {
  const hash = createHash('sha256');
  const write = (item, arrayItem = false) => {
    if (Array.isArray(item)) {
      hash.update('[');
      for (let index = 0; index < item.length; index++) { if (index) hash.update(','); write(item[index], true); }
      hash.update(']');
    } else if (record(item)) {
      // Canonical objects retain ECMAScript integer-key enumeration after sorting.
      // An own toJSON function is a rare non-JSON input: preserve the old serializer semantics.
      if (typeof item.toJSON === 'function' && Object.hasOwn(item, 'toJSON')) { hash.update(JSON.stringify(stable(item))); return; }
      const keys = Object.keys(Object.fromEntries(Object.keys(item).sort().map(key => [key, null])));
      hash.update('{'); let first = true;
      for (const key of keys) {
        const child = item[key];
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
        if (!first) hash.update(','); first = false;
        hash.update(JSON.stringify(key)); hash.update(':'); write(child);
      }
      hash.update('}');
    } else {
      const encoded = JSON.stringify(item);
      hash.update(encoded === undefined && arrayItem ? 'null' : encoded);
    }
  };
  write(value); return hash.digest('hex');
}

function cloneSnapshotJson(input) {
  // Clone bounded items, not a full snapshot string followed by a full parse.
  // JSON.stringify on the one-member wrapper preserves toJSON(key) and JSON omissions.
  if (typeof input.toJSON === 'function') {
    const encoded = JSON.stringify(input);
    if (Buffer.byteLength(encoded) > MAX_SNAPSHOT_BYTES) invalid('Delivery snapshot is oversized.');
    return JSON.parse(encoded);
  }
  let bytes = 2; let first = true;
  const add = count => { bytes += count; if (bytes > MAX_SNAPSHOT_BYTES) invalid('Delivery snapshot is oversized.'); };
  const member = (key, value) => {
    const encoded = JSON.stringify({ [key]: value });
    return encoded === '{}' ? undefined : encoded.slice(JSON.stringify(key).length + 2, -1);
  };
  const snapshot = {};
  for (const key of Object.keys(input)) {
    const value = input[key]; let cloned;
    if (Array.isArray(value) && typeof value.toJSON !== 'function') {
      add((first ? 0 : 1) + Buffer.byteLength(JSON.stringify(key)) + 1 + 2); first = false;
      cloned = [];
      for (let index = 0; index < value.length; index++) {
        const encoded = member(String(index), value[index]) ?? 'null';
        add((index ? 1 : 0) + Buffer.byteLength(encoded)); cloned.push(JSON.parse(encoded));
      }
    } else {
      const encoded = member(key, value); if (encoded === undefined) continue;
      add((first ? 0 : 1) + Buffer.byteLength(JSON.stringify(key)) + 1 + Buffer.byteLength(encoded)); first = false;
      cloned = JSON.parse(encoded);
    }
    Object.defineProperty(snapshot, key, { value: cloned, writable: true, enumerable: true, configurable: true });
  }
  return snapshot;
}
function json(value) { return JSON.stringify(value); }
function decoded(value) { return typeof value === 'string' ? JSON.parse(value) : Buffer.isBuffer(value) ? JSON.parse(value.toString('utf8')) : value; }
function jsonProjection(column, keys) { return `JSON_OBJECT(${keys.map(key => `'${key}', JSON_EXTRACT(${column}, '$.${key}')`).join(', ')})`; }
function scopeOf(projectSlug, filters, row = {}) {
  return { mode: filters.releaseId ? 'release' : filters.batchId ? 'iteration' : 'current', project: projectSlug,
    menuId: filters.menuId ?? null, menuScope: filters.menuScope ?? 'descendants', menuBinding: filters.menuBinding ?? 'any',
    batchId: filters.batchId ?? null, releaseId: filters.releaseId ?? null, directoryScope: filters.directoryScope ?? 'current',
    filters: Object.fromEntries(['q', 'origin', 'businessChange', 'adoption', 'recordType', 'nature', 'status', 'functionId', 'functionRevision'].filter(key => filters[key] !== undefined).map(key => [key, filters[key]])),
    snapshotDigest: row.snapshot_digest ?? null, observedAt: row.observed_at ?? null };
}
function publicCoverage(value) {
  if (!record(value)) return value;
  // These are internal selectors, not business coverage information. Keeping
  // them in the database does not require sending them on every page load.
  const { currentAssetVersionIds, menuAliases, ...summary } = value;
  return summary;
}
function timestamp(value, label, nullable = true) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(`${label} is invalid.`);
  return new Date(value).toISOString();
}
function strings(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ENTITIES) invalid(`${label} must be a bounded array.`);
  return [...new Set(value.map((item) => text(item, label)))];
}
function searchText(value) { return [value.name, value.page, value.description, ...(value.menuPath ?? [])].filter((part) => typeof part === 'string').join('\n'); }

const RELEASE_SCOPE_FIELDS = new Set(['scopeBinding', 'scope', 'scopeBindingReason', 'scopeBindingEvidence', 'requirementIds', 'requirementSnapshots']);
const RELEASE_DOCUMENTATION_FIELDS = new Set(['documentedChanges', 'documentedChangeCount', 'documentedChangePreview', 'scopeBindingDiagnostic']);
const RELEASE_ARTIFACT_KINDS = ['requirements-contract', 'domain-api-contract', 'database-implementation', 'ui-interaction-contract',
  'backend-implementation', 'frontend-implementation', 'access-wiring-implementation', 'cross-layer-acceptance'];
const HEX_DIGEST = /^[a-f0-9]{64}$/u;

function releaseComparable(value) {
  const { annotationHistory, ...release } = value;
  release.documentedChanges ??= [];
  release.documentedChangeCount ??= release.documentedChanges.length;
  release.documentedChangePreview ??= release.documentedChanges.slice(0, 3).map(({ id, revision, name }) => ({ id, revision, name: name.slice(0, 96) }));
  release.scopeBindingDiagnostic ??= null;
  release.scope ??= 'unknown';
  release.scopeBindingEvidence ??= null;
  release.scopeBindingReason ??= null;
  // Earlier projections omitted these explanatory metadata fields. Comparing
  // their canonical meaning does not rewrite the original stored evidence.
  if (release.scopeBinding === 'unknown' && release.scope === 'unknown' && release.scopeBindingEvidence === null
    && Array.isArray(release.requirementIds) && release.requirementIds.length === 0
    && Array.isArray(release.requirementSnapshots) && release.requirementSnapshots.length === 0) release.scopeBindingReason = null;
  return release;
}

function releaseDocumentationKey(change) {
  const origin = change.provenance;
  return JSON.stringify([change.id, change.revision, origin.sourceScope, origin.sourceCommit, origin.sourcePath]);
}

function mergeReleaseDocumentation(previous, next) {
  const known = new Map((previous.documentedChanges ?? []).map(change => [releaseDocumentationKey(change), change]));
  const added = [];
  for (const change of next.documentedChanges ?? []) {
    const key = releaseDocumentationKey(change); const existing = known.get(key);
    if (existing && digest(existing) !== digest(change)) throw new DeliveryCenterError('DELIVERY_RELEASE_IMMUTABLE', 'A recorded release explanation revision cannot be overwritten.', 409);
    if (!existing) { known.set(key, change); added.push(change.provenance); }
  }
  const documentedChanges = [...known.values()].sort((a, b) => a.id.localeCompare(b.id) || a.revision.localeCompare(b.revision)
    || a.provenance.sourceCommit.localeCompare(b.provenance.sourceCommit));
  if (documentedChanges.length > MAX_ENTITIES) invalid('Release explanations exceed the supported bound.');
  const fields = { documentedChanges, documentedChangeCount: documentedChanges.length,
    documentedChangePreview: documentedChanges.slice(0, 3).map(({ id, revision, name }) => ({ id, revision, name: name.slice(0, 96) })),
    scopeBindingDiagnostic: next.scopeBindingDiagnostic ?? previous.scopeBindingDiagnostic ?? null };
  return { fields, added, changed: added.length > 0 || fields.scopeBindingDiagnostic !== (previous.scopeBindingDiagnostic ?? null) };
}

function supplementReleaseDocumentation(previous, next, previousDigest, observedAt) {
  const core = value => Object.fromEntries(Object.entries(releaseComparable(value)).filter(([key]) => !RELEASE_DOCUMENTATION_FIELDS.has(key)));
  if (digest(core(previous)) !== digest(core(next))) return null;
  const merged = mergeReleaseDocumentation(previous, next);
  if (!merged.changed) return previous;
  return { ...previous, ...merged.fields, annotationHistory: [...(previous.annotationHistory ?? []), {
    kind: 'release-documentation-added', observedAt, previousContentDigest: previousDigest, addedSources: merged.added,
    previousScopeBindingDiagnostic: previous.scopeBindingDiagnostic ?? null, scopeBindingDiagnostic: merged.fields.scopeBindingDiagnostic,
  }] };
}

function supplementReleaseScope(previous, next, projectSlug, previousDigest, observedAt) {
  const deny = () => { throw new DeliveryCenterError('DELIVERY_RELEASE_IMMUTABLE', 'Existing release records cannot be overwritten.', 409); };
  const before = releaseComparable(previous); const after = releaseComparable(next);
  if ((previous.annotationHistory ?? []).some(entry => entry.kind !== 'release-documentation-added') || before.scopeBinding !== 'unknown' || before.scope !== 'unknown'
    || before.scopeBindingEvidence !== null || !Array.isArray(before.requirementIds) || before.requirementIds.length
    || !Array.isArray(before.requirementSnapshots) || before.requirementSnapshots.length
    || after.scopeBinding !== 'frozen-explicit-snapshot' || after.scope !== 'validated-task-delivery'
    || after.scopeBindingReason !== null || after.status !== 'success') deny();
  const core = (release) => Object.fromEntries(Object.entries(release).filter(([key]) => !RELEASE_SCOPE_FIELDS.has(key) && !RELEASE_DOCUMENTATION_FIELDS.has(key)));
  if (digest(core(before)) !== digest(core(after))) deny();
  const evidence = after.scopeBindingEvidence;
  if (!record(evidence) || evidence.scope !== 'validated-task-delivery' || evidence.projectSlug !== projectSlug
    || !before.taskId || evidence.taskId !== before.taskId || !before.jobId || evidence.runnerJobId !== before.jobId
    || !/^[a-f0-9]{40}$/u.test(before.commit ?? '') || evidence.commit !== before.commit
    || !/^[a-f0-9]{40}$/u.test(evidence.baseSourceCommit ?? '')
    || ['sourceFingerprint', 'phasePatchDigest', 'acceptanceGateDigest', 'stateDigest', 'snapshotDigest'].some((key) => !HEX_DIGEST.test(evidence[key] ?? ''))
    || !record(evidence.acceptedArtifactDigests)
    || Object.keys(evidence.acceptedArtifactDigests).sort().join(',') !== [...RELEASE_ARTIFACT_KINDS].sort().join(',')
    || Object.values(evidence.acceptedArtifactDigests).some((value) => !HEX_DIGEST.test(value ?? ''))) deny();
  const ids = after.requirementIds;
  const snapshotIds = after.requirementSnapshots.map((item) => item.id);
  if (new Set(ids).size !== ids.length || new Set(snapshotIds).size !== snapshotIds.length
    || JSON.stringify([...ids].sort()) !== JSON.stringify([...snapshotIds].sort())) deny();
  const documentation = mergeReleaseDocumentation(previous, next);
  return { ...next, ...(previous.documentedChanges !== undefined || next.documentedChanges !== undefined ? documentation.fields : {}),
    annotationHistory: [...(previous.annotationHistory ?? []), { kind: 'scope-binding-added', observedAt, previousContentDigest: previousDigest,
      previousRelease: structuredClone(previous) }] };
}

/** Escape LIKE metacharacters using an explicit, SQL-mode-independent escape. */
export function escapeDeliveryLike(value) { return String(value).replace(/[!%_]/gu, (character) => `!${character}`); }

export function validateDeliverySnapshot(input) {
  if (!record(input) || input.schemaVersion !== 1 || !record(input.project)) invalid('Delivery snapshot schema is invalid.');
  let snapshot;
  try { snapshot = cloneSnapshotJson(input); } catch (error) { if (error instanceof DeliveryCenterError) throw error; invalid('Delivery snapshot must be JSON.'); }
  slug(snapshot.project.slug);
  text(snapshot.project.name, 'Project name', 255);
  snapshot.observedAt = timestamp(snapshot.observedAt, 'Observation time', false);
  if (!record(snapshot.coverage)) invalid('Coverage must be an object.');
  if (snapshot.coverage.currentAssetVersionIds !== undefined) snapshot.coverage.currentAssetVersionIds = strings(snapshot.coverage.currentAssetVersionIds, 'Current asset version ids');
  for (const key of ENTITY_LISTS) {
    if (!Array.isArray(snapshot[key]) || snapshot[key].length > MAX_ENTITIES) invalid(`${key} must be a bounded array.`);
    const ids = new Set();
    for (const entity of snapshot[key]) {
      if (!record(entity)) invalid(`${key} entity must be an object.`);
      text(entity.id, `${key} id`);
      // A stage id can have multiple immutable content versions in one snapshot.
      const identity = key === 'stages' ? `${entity.id}:${digest({ ...entity, isCurrent: undefined })}` : entity.id;
      if (ids.has(identity)) invalid(`${key} contains duplicate ids.`);
      ids.add(identity);
      // Full code and relationship assets from recorded sources need a bounded 2 MiB allowance.
      const maxEntityBytes = key === 'artifacts' && entity.kind === 'specification-asset' ? 2 * 1024 * 1024 : 1024 * 1024;
      if (Buffer.byteLength(json(entity)) > maxEntityBytes) invalid(`${key} entity is oversized.`);
    }
  }
  for (const menu of snapshot.menus) {
    text(menu.name, 'Menu name', 512);
    menu.parentId = text(menu.parentId, 'Parent menu id', 191, true);
    if (!Array.isArray(menu.path) || menu.path.some((part) => typeof part !== 'string')) invalid('Menu path is invalid.');
  }
  if (snapshot.requirementVersions !== undefined && (!Array.isArray(snapshot.requirementVersions) || snapshot.requirementVersions.length > 20000)) invalid('Requirement versions must be a bounded array.');
  for (const requirement of [...snapshot.requirements, ...(snapshot.requirementVersions ?? [])]) {
    if (!record(requirement)) invalid('Requirement version must be an object.');
    text(requirement.id, 'Requirement id');
    if (Buffer.byteLength(json(requirement)) > 1024 * 1024) invalid('Requirement version is oversized.');
    text(requirement.name, 'Requirement name', 512);
    requirement.menuId = text(requirement.menuId, 'Requirement menu id', 191, true);
    text(requirement.page, 'Page name', 512, true);
    for (const key of ['menuPath', 'fields', 'actions', 'rules', 'permissions', 'sources']) {
      if (!Array.isArray(requirement[key])) invalid(`Requirement ${key} must be an array.`);
    }
    if (requirement.menuPath.some((part) => typeof part !== 'string')) invalid('Requirement menu path is invalid.');
    requirement.batchIds = strings(requirement.batchIds, 'Requirement batch ids');
    if (requirement.menuIds !== undefined) requirement.menuIds = strings(requirement.menuIds, 'Requirement menu ids');
    timestamp(requirement.sourceRecordedAt, 'Requirement source time');
    if (!record(requirement.stageStatus)) invalid('Requirement stage status is invalid.');
    requirement.status = text(requirement.status ?? 'unknown', 'Requirement status', 64);
    for (const source of requirement.sources) {
      if (!record(source)) invalid('Requirement source is invalid.');
      text(source.batchId, 'Source batch id', 191, true);
      text(source.stageId, 'Source stage id', 191, true);
      text(source.digest, 'Source digest', 128, true);
    }
  }
  for (const stage of snapshot.stages) {
    text(stage.phaseId, 'Phase id', 64, true);
    text(stage.batchId, 'Stage batch id', 191, true);
    stage.status = text(stage.status ?? 'unknown', 'Stage status', 64);
    if (typeof stage.isCurrent !== 'boolean') invalid('Stage current marker must be boolean.');
    timestamp(stage.createdAt, 'Stage creation time');
  }
  for (const release of snapshot.releases) {
    if (Object.hasOwn(release, 'annotationHistory')) invalid('Release annotation history is reserved for stored evidence.');
    if (release.scopeBindingDiagnostic !== undefined && release.scopeBindingDiagnostic !== null
      && !/^[A-Z][A-Z0-9_]{1,79}$/u.test(release.scopeBindingDiagnostic)) invalid('Release scope diagnostic is invalid.');
    if (release.documentedChanges !== undefined) {
      if (!Array.isArray(release.documentedChanges) || release.documentedChanges.length > MAX_ENTITIES) invalid('Release explanations must be a bounded array.');
      const revisions = new Set();
      for (const change of release.documentedChanges) {
        const origin = change?.provenance; const ref = origin?.recordRef;
        if (!record(change) || change.status !== 'documented' || !record(origin) || !record(ref)
          || ref.kind !== 'requirement' || ref.id !== change.id || ref.revision !== change.revision
          || !['historical-compilation', 'implementation-observation'].includes(origin.nature)
          || !['source-commit', 'taskspace-checkpoint'].includes(origin.sourceScope)
          || !/^[a-f0-9]{40}$/u.test(origin.sourceCommit ?? '') || !Array.isArray(change.sources)
          || !change.sources.some(source => (source?.kind === 'git' || source?.type === 'git') && source.commit === release.commit)
          || !change.sources.some(source => source?.kind === 'committed-document' && source.commit === origin.sourceCommit
            && source.sourcePath === origin.sourcePath && typeof source.pointer === 'string')) invalid('Release explanation lacks its exact document and released-commit sources.');
        text(change.id, 'Release explanation id'); text(change.revision, 'Release explanation revision');
        text(change.name, 'Release explanation name'); text(origin.sourcePath, 'Release explanation path');
        const key = releaseDocumentationKey(change);
        if (revisions.has(key)) invalid('Release explanation source revision is duplicated.');
        revisions.add(key);
      }
      const preview = release.documentedChanges.slice(0, 3).map(({ id, revision, name }) => ({ id, revision, name: name.slice(0, 96) }));
      if ((release.documentedChangeCount !== undefined && release.documentedChangeCount !== release.documentedChanges.length)
        || (release.documentedChangePreview !== undefined && digest(release.documentedChangePreview) !== digest(preview))) invalid('Release explanation summary does not match its source records.');
    }
    text(release.version, 'Release version', 255, true);
    text(release.commit, 'Release commit', 64, true);
    text(release.environment, 'Release environment', 128, true);
    release.status = text(release.status ?? 'unknown', 'Release status', 64);
    timestamp(release.releasedAt, 'Release time');
    release.requirementIds = strings(release.requirementIds ?? [], 'Release requirement ids');
    release.artifactIds = strings(release.artifactIds ?? [], 'Release artifact ids');
    if (!Array.isArray(release.requirementSnapshots)) invalid('Release requirement snapshots must be an array.');
    const ids = new Set();
    for (const requirement of release.requirementSnapshots) {
      if (!record(requirement)) invalid('Release requirement snapshot is invalid.');
      text(requirement.id, 'Release requirement id');
      if (ids.has(requirement.id)) invalid('Release requirement snapshot is duplicated.');
      ids.add(requirement.id);
      text(requirement.menuId, 'Release requirement menu id', 191, true);
      if (requirement.menuPath !== undefined && (!Array.isArray(requirement.menuPath) || requirement.menuPath.some((part) => typeof part !== 'string'))) invalid('Release requirement menu path is invalid.');
    }
  }
  for (const artifact of snapshot.artifacts) validateSpecificationArtifact(artifact);
  return snapshot;
}

export function createDeliveryCenterPool(config) {
  const mysql = require('mysql2/promise');
  return mysql.createPool({ ...config, charset: 'utf8mb4', timezone: 'Z', connectionLimit: 4,
    connectTimeout: 10000, waitForConnections: true, queueLimit: 32, multipleStatements: false,
    supportBigNumbers: true, bigNumberStrings: true });
}

function pagination(filters = {}) {
  const page = filters.page === undefined ? 1 : Number(filters.page);
  const pageSize = filters.pageSize === undefined ? 50 : Number(filters.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200 || (page - 1) * pageSize > 10000000) invalid('Pagination is invalid.');
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export class DeliveryCenterStore {
  constructor({ pool }) {
    if (!pool || typeof pool.execute !== 'function' || typeof pool.getConnection !== 'function') throw new Error('Delivery Center requires a MySQL pool.');
    this.pool = pool;
  }

  async initialize() {
    const schema = await readFile(new URL('./delivery-center-schema.sql', import.meta.url), 'utf8');
    for (const statement of schema.replace(/^--.*$/gmu, '').split(';').map((item) => item.trim()).filter(Boolean)) await this.pool.execute(statement);
    return { schemaVersion: 1 };
  }

  async importSnapshot(input) {
    const snapshot = validateDeliverySnapshot(input);
    const projectSlug = snapshot.project.slug;
    const snapshotDigest = digest({ ...snapshot, observedAt: undefined });
    const connection = await this.pool.getConnection();
    let begun = false;
    try {
      await connection.beginTransaction(); begun = true;
      await connection.execute('INSERT IGNORE INTO delivery_center_projects (slug, name, observed_at, snapshot_digest, coverage) VALUES (?, ?, ?, ?, ?)',
        [projectSlug, snapshot.project.name, snapshot.observedAt, '', json(snapshot.coverage)]);
      const [[project]] = await connection.execute('SELECT snapshot_digest FROM delivery_center_projects WHERE slug = ? FOR UPDATE', [projectSlug]);
      const changed = project.snapshot_digest !== snapshotDigest;
      if (changed) await this.#importEntities(connection, snapshot);
      await connection.execute('UPDATE delivery_center_projects SET name = ?, observed_at = ?, snapshot_digest = ?, coverage = ? WHERE slug = ?',
        [snapshot.project.name, snapshot.observedAt, snapshotDigest, json(snapshot.coverage), projectSlug]);
      await connection.commit(); begun = false;
      return { projectSlug, changed, observedAt: snapshot.observedAt, counts: Object.fromEntries(ENTITY_LISTS.map((key) => [key, snapshot[key].length])) };
    } catch (error) {
      if (begun) await connection.rollback().catch(() => {});
      throw error;
    } finally { connection.release(); }
  }

  async #importEntities(connection, snapshot) {
    const project = snapshot.project.slug;
    for (const table of ['batches', 'menus', 'requirements', 'stages']) await connection.execute(`UPDATE delivery_center_${table} SET is_current = FALSE WHERE project_slug = ?`, [project]);
    for (const batch of snapshot.batches) await connection.execute(
      'INSERT INTO delivery_center_batches (project_slug, id, name, created_at, is_current, data) VALUES (?, ?, ?, ?, TRUE, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), created_at = VALUES(created_at), is_current = TRUE, data = VALUES(data)',
      [project, batch.id, batch.name ?? batch.title ?? null, timestamp(batch.createdAt, 'Batch creation time'), json(batch)]);
    for (const [index, menu] of snapshot.menus.entries()) await connection.execute(
      'INSERT INTO delivery_center_menus (project_slug, id, parent_id, name, sort_order, is_current, data) VALUES (?, ?, ?, ?, ?, TRUE, ?) ON DUPLICATE KEY UPDATE parent_id = VALUES(parent_id), name = VALUES(name), sort_order = VALUES(sort_order), is_current = TRUE, data = VALUES(data)',
      [project, menu.id, menu.parentId, menu.name, index, json(menu)]);
    await connection.execute('DELETE FROM delivery_center_requirement_batches WHERE project_slug = ?', [project]);
    await connection.execute('DELETE FROM delivery_center_requirement_sources WHERE project_slug = ?', [project]);
    for (const requirement of snapshot.requirements) {
      const requirementDigest = digest(requirement);
      await connection.execute('INSERT INTO delivery_center_requirements (project_slug, id, menu_id, page_name, name, status, search_text, content_digest, is_current, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?) ON DUPLICATE KEY UPDATE menu_id = VALUES(menu_id), page_name = VALUES(page_name), name = VALUES(name), status = VALUES(status), search_text = VALUES(search_text), content_digest = VALUES(content_digest), is_current = TRUE, data = VALUES(data)',
        [project, requirement.id, requirement.menuId, requirement.page ?? null, requirement.name, requirement.status, searchText(requirement), requirementDigest, json(requirement)]);
      await connection.execute('INSERT IGNORE INTO delivery_center_requirement_versions (project_slug, requirement_id, content_digest, observed_at, data) VALUES (?, ?, ?, ?, ?)',
        [project, requirement.id, requirementDigest, timestamp(requirement.sourceRecordedAt ?? requirement.recordedAt ?? snapshot.observedAt, 'Requirement source time', false), json(requirement)]);
      for (const batch of requirement.batchIds) await connection.execute('INSERT INTO delivery_center_requirement_batches (project_slug, requirement_id, batch_id) VALUES (?, ?, ?)', [project, requirement.id, batch]);
      const sourceKeys = new Set();
      for (const source of requirement.sources) {
        const key = digest(source); if (sourceKeys.has(key)) continue; sourceKeys.add(key);
        await connection.execute('INSERT INTO delivery_center_requirement_sources (project_slug, requirement_id, source_key, batch_id, stage_id, digest, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [project, requirement.id, key, source.batchId ?? null, source.stageId ?? null, source.digest ?? null, json(source)]);
      }
    }
    for (const requirement of snapshot.requirementVersions ?? []) await connection.execute(
      'INSERT IGNORE INTO delivery_center_requirement_versions (project_slug, requirement_id, content_digest, observed_at, data) VALUES (?, ?, ?, ?, ?)',
      [project, requirement.id, digest(requirement), timestamp(requirement.sourceRecordedAt ?? requirement.recordedAt ?? snapshot.observedAt, 'Requirement source time', false), json(requirement)]);
    for (const stage of snapshot.stages) await connection.execute(
      'INSERT INTO delivery_center_stages (project_slug, id, content_digest, phase_id, batch_id, status, is_current, created_at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE is_current = VALUES(is_current)',
      [project, stage.id, digest({ ...stage, isCurrent: undefined }), stage.phaseId ?? null, stage.batchId ?? null, stage.status, stage.isCurrent, timestamp(stage.createdAt, 'Stage creation time'), json(stage)]);
    for (const release of snapshot.releases) {
      const releaseDigest = digest(release);
      const [existing] = await connection.execute('SELECT content_digest, data FROM delivery_center_releases WHERE project_slug = ? AND id = ?', [project, release.id]);
      if (existing.length) {
        if (existing[0].content_digest === releaseDigest) continue;
        const previous = decoded(existing[0].data);
        if (digest(releaseComparable(previous)) === digest(releaseComparable(release))) continue;
        const documented = supplementReleaseDocumentation(previous, release, existing[0].content_digest, snapshot.observedAt);
        if (documented !== null) {
          if (documented === previous) continue;
          const [updated] = await connection.execute('UPDATE delivery_center_releases SET content_digest = ?, data = ? WHERE project_slug = ? AND id = ? AND content_digest = ?',
            [digest(releaseComparable(documented)), json(documented), project, release.id, existing[0].content_digest]);
          if (updated.affectedRows !== 1) throw new DeliveryCenterError('DELIVERY_RELEASE_IMMUTABLE', 'Existing release changed during documentation annotation.', 409);
          continue;
        }
        const annotated = supplementReleaseScope(previous, release, project, existing[0].content_digest, snapshot.observedAt);
        const [[bindings]] = await connection.execute('SELECT COUNT(*) AS total FROM delivery_center_release_requirements WHERE project_slug = ? AND release_id = ?', [project, release.id]);
        if (Number(bindings.total) !== 0) throw new DeliveryCenterError('DELIVERY_RELEASE_IMMUTABLE', 'Existing release feature bindings cannot be overwritten.', 409);
        const [updated] = await connection.execute('UPDATE delivery_center_releases SET content_digest = ?, data = ? WHERE project_slug = ? AND id = ? AND content_digest = ?',
          [releaseDigest, json(annotated), project, release.id, existing[0].content_digest]);
        if (updated.affectedRows !== 1) throw new DeliveryCenterError('DELIVERY_RELEASE_IMMUTABLE', 'Existing release changed during scope annotation.', 409);
      } else {
        await connection.execute('INSERT INTO delivery_center_releases (project_slug, id, version, commit_sha, environment, status, released_at, content_digest, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [project, release.id, release.version ?? null, release.commit ?? null, release.environment ?? null, release.status, timestamp(release.releasedAt, 'Release time'), releaseDigest, json(release)]);
      }
      const frozen = new Map(release.requirementSnapshots.map((item) => [item.id, item]));
      for (const id of new Set([...release.requirementIds, ...frozen.keys()])) {
        // Never backfill a historic release with today's requirement definition.
        const value = frozen.get(id) ?? { id, name: null, menuId: null, menuPath: [], page: null, description: null,
          fields: [], actions: [], rules: [], permissions: [], batchIds: [], stageStatus: {}, status: 'unknown',
          sources: [], revision: null, historicalSnapshotAvailable: false };
        await connection.execute('INSERT INTO delivery_center_release_requirements (project_slug, release_id, requirement_id, menu_id, search_text, snapshot) VALUES (?, ?, ?, ?, ?, ?)',
          [project, release.id, id, value.menuId ?? null, searchText(value), json(value)]);
      }
    }
    for (const artifact of snapshot.artifacts) {
      const artifactDigest = digest(artifact);
      const [existing] = await connection.execute('SELECT content_digest FROM delivery_center_artifacts WHERE project_slug = ? AND id = ?', [project, artifact.id]);
      if (existing.length) {
        if (existing[0].content_digest !== artifactDigest) throw new DeliveryCenterError('DELIVERY_ARTIFACT_IMMUTABLE', 'Existing artifact records cannot be overwritten.', 409);
      } else await connection.execute('INSERT INTO delivery_center_artifacts (project_slug, id, release_id, stage_id, content_digest, data) VALUES (?, ?, ?, ?, ?, ?)',
        [project, artifact.id, artifact.releaseId ?? null, artifact.stageId ?? null, artifactDigest, json(artifact)]);
    }
  }

  async listProjects() {
    // Coverage includes explicit asset-version heads and can exceed MySQL's
    // filesort buffer. Read the complete bounded set without sorting JSON rows;
    // UTF-8 byte ordering preserves the table's binary name/slug ordering.
    const [rows] = await this.pool.execute('SELECT slug, name, observed_at, coverage FROM delivery_center_projects LIMIT 10001');
    if (rows.length > MAX_ENTITIES) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', 'Project list exceeds its supported bound.', 413);
    rows.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
      || Buffer.compare(Buffer.from(left.slug), Buffer.from(right.slug)));
    return rows.map((row) => ({ slug: row.slug, name: row.name, observedAt: row.observed_at, coverage: publicCoverage(decoded(row.coverage)) }));
  }

  async overview(projectSlug) {
    slug(projectSlug);
    const [[project]] = await this.pool.execute('SELECT slug, name, observed_at, coverage FROM delivery_center_projects WHERE slug = ?', [projectSlug]);
    if (!project) return null;
    const counts = {};
    for (const table of ENTITY_LISTS) {
      const current = ['menus', 'requirements', 'batches'].includes(table) ? ' AND is_current = TRUE'
        : table === 'artifacts' ? " AND (JSON_EXTRACT(data, '$.kind') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.kind')) <> 'specification-asset')" : '';
      const [[row]] = await this.pool.execute(`SELECT COUNT(*) AS total FROM delivery_center_${table} WHERE project_slug = ?${current}`, [projectSlug]);
      counts[table] = Number(row.total);
    }
    const coverage = decoded(project.coverage);
    const assetCounts = await this.#assetCounts(projectSlug, coverage);
    return { project: { slug: project.slug, name: project.name }, observedAt: project.observed_at, coverage: publicCoverage(coverage), counts, assetCounts };
  }

  async #releaseMenus(client, projectSlug, releaseId) {
    const [rows] = await client.execute("SELECT DISTINCT JSON_EXTRACT(snapshot, '$.menuPath') AS menu_path FROM delivery_center_release_requirements WHERE project_slug = ? AND release_id = ? LIMIT 10001", [projectSlug, text(releaseId, 'Release id')]);
    if (rows.length > MAX_ENTITIES) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', 'Historical menu list exceeds its supported bound.', 413);
    const menus = new Map();
    for (const row of rows) {
      const parts = decoded(row.menu_path);
      if (!Array.isArray(parts) || parts.some((part) => typeof part !== 'string' || !part)) continue;
      let parentId = null;
      for (let index = 0; index < parts.length; index += 1) {
        const branch = parts.slice(0, index + 1);
        const id = `menu-${digest([projectSlug, branch]).slice(0, 32)}`;
        menus.set(id, { id, parentId, name: parts[index], path: branch });
        parentId = id;
      }
    }
    if (menus.size > MAX_ENTITIES) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', 'Historical menu list exceeds its supported bound.', 413);
    return [...menus.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  async listMenus(projectSlug, filters = {}) {
    slug(projectSlug);
    if (filters.releaseId) {
      let menus = await this.#releaseMenus(this.pool, projectSlug, filters.releaseId);
      if (filters.menuId) { const ids = filters.menuScope === 'self' ? new Set([filters.menuId]) : deliveryMenuDescendants(menus, filters.menuId); menus = menus.filter(item => ids.has(item.id)); }
      return menus.filter(item => semanticMatch(item, filters) && (!filters.q || JSON.stringify(item).toLocaleLowerCase().includes(filters.q.toLocaleLowerCase())));
    }
    const directory = filters.directoryScope === 'all' ? '' : filters.directoryScope === 'historical' ? ' AND is_current = FALSE' : ' AND is_current = TRUE';
    const [rows] = await this.pool.execute(`SELECT data, is_current FROM delivery_center_menus WHERE project_slug = ?${directory} ORDER BY sort_order, id LIMIT 10001`, [projectSlug]);
    if (rows.length > MAX_ENTITIES) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', 'Menu list exceeds its supported bound.', 413);
    let items = rows.map((row) => ({ ...decoded(row.data), directoryStatus: row.is_current === undefined ? null : Boolean(row.is_current) ? 'current' : 'historical' }));
    if (filters.menuId) { const ids = filters.menuScope === 'self' ? new Set([filters.menuId]) : deliveryMenuDescendants(items, filters.menuId); items = items.filter(item => ids.has(item.id)); }
    items = items.filter(item => semanticMatch(item, filters));
    if (filters.q) { const needle = filters.q.toLocaleLowerCase(); items = items.filter(item => JSON.stringify(item).toLocaleLowerCase().includes(needle)); }
    return items;
  }

  async listRequirements(projectSlug, filters = {}) {
    if (filters.projection === 'summary' && !filters._consistent) return this.#readConsistent(reader => reader.listRequirements(projectSlug, { ...filters, _consistent: true }));
    slug(projectSlug);
    const paging = pagination(filters);
    const { table, release, historical, predicate, parameters } = await this.#requirementQuery(this.pool, projectSlug, filters);
    const [[count]] = await this.pool.execute(`SELECT COUNT(*) AS total FROM ${table} r WHERE ${predicate}`, parameters);
    const [rows] = await this.pool.execute(`SELECT r.${release ? 'snapshot' : 'data'} AS data FROM ${table} r WHERE ${predicate} ORDER BY r.${release ? 'requirement_id' : 'id'}${historical ? ', r.content_digest' : ''} LIMIT ? OFFSET ?`, [...parameters, paging.pageSize, paging.offset]);
    return { items: rows.map((row) => { const value = withFunctionAssociation(deliveryDisplayRecord(decoded(row.data)), filters); return filters.projection === 'summary' ? deliverySummary({ ...value, recordType: requirementType(value) }) : value; }), total: Number(count.total), page: paging.page, pageSize: paging.pageSize,
      ...(filters.projection === 'summary' ? { scope: await this.#scope(projectSlug, filters), rowMeaning: historical ? 'recorded-revisions' : 'selected-definitions' } : {}) };
  }

  async #requirementQuery(client, projectSlug, filters) {
    const release = filters.releaseId === undefined || filters.releaseId === null || filters.releaseId === '' ? null : text(filters.releaseId, 'Release id');
    const parameters = [projectSlug];
    const where = ['r.project_slug = ?'];
    const historical = !release && filters.batchId && (filters.projection === 'summary' || filters._definitionScope);
    const table = release ? 'delivery_center_release_requirements' : historical
      ? `(SELECT project_slug, requirement_id AS id, content_digest, data, NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.menuId')), 'null') AS menu_id,
        CONCAT_WS(' ', JSON_UNQUOTE(JSON_EXTRACT(data, '$.name')), JSON_UNQUOTE(JSON_EXTRACT(data, '$.description')), JSON_UNQUOTE(JSON_EXTRACT(data, '$.menuPath'))) AS search_text FROM delivery_center_requirement_versions)`
      : 'delivery_center_requirements';
    if (release) { where.push('r.release_id = ?'); parameters.push(release); }
    else if (!historical) where.push('r.is_current = TRUE');
    if (filters.menuId) {
      const menuId = text(filters.menuId, 'Menu id');
      if (release) {
        // Frozen paths are authoritative, including menus since renamed or removed.
        const selected = (await this.#releaseMenus(client, projectSlug, release)).find((menu) => menu.id === menuId);
        if (!selected) where.push('1 = 0');
        else selected.path.forEach((part, index) => {
          where.push(`JSON_EXTRACT(r.snapshot, '$.menuPath[${index}]') = CAST(? AS JSON)`);
          parameters.push(JSON.stringify(part));
        });
        if (selected && filters.menuScope === 'self') { where.push("JSON_LENGTH(JSON_EXTRACT(r.snapshot, '$.menuPath')) = ?"); parameters.push(selected.path.length); }
      } else {
      // Include all descendants when selecting a first/second-level business menu.
      const directory = filters.directoryScope === 'all' || filters.directoryScope === 'historical' ? '' : ' AND is_current = TRUE';
      const [menuRows] = await client.execute(`SELECT data FROM delivery_center_menus WHERE project_slug = ?${directory} ORDER BY sort_order, id LIMIT 10001`, [projectSlug]);
      if (menuRows.length > MAX_ENTITIES) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', 'Menu list exceeds its supported bound.', 413);
      const menus = menuRows.map((row) => decoded(row.data));
      const selected = filters.menuScope === 'self' ? new Set([menuId]) : deliveryMenuDescendants(menus, menuId);
      where.push(`(r.menu_id IN (${[...selected].map(() => '?').join(', ')}) OR JSON_OVERLAPS(JSON_EXTRACT(r.data, '$.menuIds'), CAST(? AS JSON)))`);
      parameters.push(...selected, JSON.stringify([...selected]));
      }
    }
    const column = release ? 'r.snapshot' : 'r.data';
    if (filters.functionRevision && !filters.functionId) invalid('关联功能修订缺少功能编号。');
    if (filters.functionId) {
      const ref = { kind: 'function', id: text(filters.functionId, 'Function id'),
        ...(filters.functionRevision ? { revision: text(filters.functionRevision, 'Function revision') } : {}) };
      where.push(`JSON_CONTAINS(JSON_EXTRACT(${column}, '$.functionRefs'), CAST(? AS JSON))`); parameters.push(JSON.stringify(ref));
    }
    for (const [filter, field] of [['origin', 'origin'], ['businessChange', 'businessChange'], ['adoption', 'adoption.state'], ['nature', 'nature']]) {
      if (filters[filter]) { where.push(`COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.${field}')), 'null'), 'unknown') = ?`); parameters.push(text(filters[filter], filter)); }
    }
    if (filters.recordType) {
      where.push(`COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.recordType')), 'null'), CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.granularity')) = 'specification-section' THEN 'source-section' ELSE 'unknown' END) = ?`);
      parameters.push(text(filters.recordType, 'Record type'));
    }
    if (filters.menuBinding && filters.menuBinding !== 'any') {
      where.push(`(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.menuApplicability')) = 'none' THEN 'none' WHEN r.menu_id IS NOT NULL OR COALESCE(JSON_LENGTH(JSON_EXTRACT(${column}, '$.menuIds')), 0) > 0 OR COALESCE(JSON_LENGTH(JSON_EXTRACT(${column}, '$.menuRefs')), 0) > 0 THEN 'linked' ELSE 'unknown' END) = ?`);
      parameters.push(filters.menuBinding);
    }
    if (filters.batchId) {
      const batch = text(filters.batchId, 'Batch id');
      if (release || historical) { where.push(`JSON_CONTAINS(r.${release ? 'snapshot' : 'data'}, JSON_QUOTE(?), '$.batchIds')`); parameters.push(batch); }
      else { where.push('EXISTS (SELECT 1 FROM delivery_center_requirement_batches b WHERE b.project_slug = r.project_slug AND b.requirement_id = r.id AND b.batch_id = ?)'); parameters.push(batch); }
    }
    if (filters.q !== undefined && filters.q !== '') {
      if (typeof filters.q !== 'string' || filters.q.length > 256) invalid('Search query is invalid.');
      where.push(`(r.search_text LIKE ? ESCAPE '!' OR (COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.description')), 'null'), '') = '' AND JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.details.statement')) LIKE ? ESCAPE '!'))`);
      const pattern = `%${escapeDeliveryLike(filters.q)}%`; parameters.push(pattern, pattern);
    }
    return { table, release, historical, predicate: where.join(' AND '), parameters };
  }

  async exportRequirements(projectSlug, filters = {}) {
    slug(projectSlug);
    const connection = await this.pool.getConnection();
    let begun = false;
    try {
      await connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.beginTransaction(); begun = true;
      const { table, release, predicate, parameters } = await this.#requirementQuery(connection, projectSlug, filters);
      const [rows] = await connection.execute(`SELECT r.${release ? 'snapshot' : 'data'} AS data FROM ${table} r WHERE ${predicate} ORDER BY r.${release ? 'requirement_id' : 'id'} LIMIT 100001`, parameters);
      if (rows.length > 100000) throw new DeliveryCenterError('DELIVERY_EXPORT_TOO_LARGE', 'The export exceeds 100000 requirements. Narrow its scope.', 422);
      const items = rows.map((row) => withFunctionAssociation(deliveryDisplayRecord(decoded(row.data)), filters));
      await connection.commit(); begun = false;
      return items;
    } catch (error) {
      if (begun) await connection.rollback().catch(() => {});
      throw error;
    } finally { connection.release(); }
  }

  async getRequirement(projectSlug, id, filters = {}) {
    if (filters.detailMode === 'single' && !filters._consistent) return this.#readConsistent(reader => reader.getRequirement(projectSlug, id, { ...filters, _consistent: true }));
    slug(projectSlug); text(id, 'Requirement id');
    if (filters.releaseId) {
      const releaseId = text(filters.releaseId, 'Release id');
      const [[row]] = await this.pool.execute('SELECT snapshot AS data FROM delivery_center_release_requirements WHERE project_slug = ? AND release_id = ? AND requirement_id = ?', [projectSlug, releaseId, id]);
      const value = row ? deliveryDisplayRecord(decoded(row.data)) : null;
      if (value && filters.revision !== undefined && String(value.revision) !== String(filters.revision)) return null;
      return value ? { ...value, releaseId, isCurrent: false } : null;
    }
    const [[row]] = await this.pool.execute('SELECT data, is_current FROM delivery_center_requirements WHERE project_slug = ? AND id = ?', [projectSlug, id]);
    const versionData = filters.detailMode === 'single' ? `${jsonProjection('data', ['id', 'revision', 'recordedAt', 'nature', 'status', 'sourceRevision', 'changeSummary', 'sources', 'batchIds', 'adoption'])} AS data` : 'data';
    const batchWhere = filters.batchId ? " AND JSON_CONTAINS(data, JSON_QUOTE(?), '$.batchIds')" : '';
    const [versions] = await this.pool.execute(`SELECT content_digest, observed_at, ${versionData} FROM delivery_center_requirement_versions WHERE project_slug = ? AND requirement_id = ?${batchWhere} ORDER BY observed_at DESC, content_digest LIMIT 101`, [projectSlug, id, ...(filters.batchId ? [filters.batchId] : [])]);
    if (!row && versions.length === 0) return null;
    const revisions = versions.slice(0, 100).map(entry => ({ ...deliveryDisplayRecord(decoded(entry.data)), digest: entry.content_digest, observedAt: entry.observed_at,
      recordedAt: decoded(entry.data).recordedAt ?? entry.observed_at, revision: decoded(entry.data).revision ?? entry.content_digest }))
      .map(item => filters.detailMode === 'single' ? historyMetadata(item) : item);
    if (filters.revision !== undefined || filters.batchId) {
      const adopted = versions.filter(item => decoded(item.data).adoption?.state === 'adopted');
      if (filters.revision === undefined && filters.detailMode === 'single' && versions.length > 1 && adopted.length !== 1) {
        throw new DeliveryCenterError('DELIVERY_REVISION_REQUIRED', '该迭代包含多个已记录修订，请选择具体版本。', 409);
      }
      const revision = filters.revision ?? (adopted.length === 1 ? adopted[0] : versions[0])?.content_digest;
      if (revision === undefined) return null;
      const [[historical]] = await this.pool.execute('SELECT content_digest, observed_at, data FROM delivery_center_requirement_versions WHERE project_slug = ? AND requirement_id = ? AND (content_digest = ? OR JSON_UNQUOTE(JSON_EXTRACT(data, \'$.revision\')) = ?) LIMIT 1',
        [projectSlug, id, String(revision), String(revision)]);
      if (!historical) return null;
      if (filters.batchId && !(decoded(historical.data).batchIds ?? []).includes(filters.batchId)) return null;
      return { ...deliveryDisplayRecord(decoded(historical.data)), recordedAt: decoded(historical.data).recordedAt ?? historical.observed_at,
        isCurrent: Boolean(row?.is_current) && historical.content_digest === digest(decoded(row.data)), revisions, revisionsHasMore: versions.length > 100 };
    }
    if (!row?.is_current && filters.detailMode === 'single') return null;
    return { ...deliveryDisplayRecord(decoded(row?.data ?? versions[0].data)), isCurrent: Boolean(row?.is_current), revisions, revisionsHasMore: versions.length > 100 };
  }

  async #assetCounts(projectSlug, coverage) {
    // Overview only needs identity/current/version metadata. Do not transfer
    // every field definition, specification body and diagram just to count it.
    const [rows] = await this.pool.execute(`SELECT a.id, a.stage_id,
      JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.payload.assetId')) AS asset_id,
      JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.payload.kind')) AS asset_kind,
      JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.payload.sourceScope')) AS source_scope,
      JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.payload.recordedAt')) AS recorded_at,
      CASE WHEN a.stage_id IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM delivery_center_stages s WHERE s.project_slug = a.project_slug AND s.id = a.stage_id AND s.is_current = TRUE) END AS stage_current
      FROM delivery_center_artifacts a WHERE a.project_slug = ? AND JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.kind')) = 'specification-asset' LIMIT 10001`, [projectSlug]);
    if (rows.length > MAX_ENTITIES) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', 'Asset versions exceed the supported bound.', 413);
    const heads = new Set(coverage?.currentAssetVersionIds ?? []);
    return deliveryAssetCounts(rows.map(row => ({ assetId: row.asset_id, kind: row.asset_kind, sourceScope: row.source_scope, recordedAt: row.recorded_at, versionId: row.id,
      isCurrent: row.stage_id ? row.stage_current === true || Number(row.stage_current) === 1 : heads.has(row.id) })));
  }

  async #scope(projectSlug, filters, client = this.pool) {
    const [[row]] = await client.execute('SELECT snapshot_digest, observed_at FROM delivery_center_projects WHERE slug = ?', [projectSlug]);
    if (filters.snapshotDigest && row?.snapshot_digest !== filters.snapshotDigest) throw new DeliveryCenterError('DELIVERY_SCOPE_CHANGED', '资料已更新，请刷新列表后再导出。', 409);
    return scopeOf(projectSlug, filters, row);
  }

  async #assetModel(projectSlug, filters = {}, knownCoverage) {
    slug(projectSlug);
    let coverage = knownCoverage;
    if (coverage === undefined) {
      const [[project]] = await this.pool.execute('SELECT coverage FROM delivery_center_projects WHERE slug = ?', [projectSlug]);
      coverage = project ? decoded(project.coverage) : {};
    }
    const where = ['a.project_slug = ?', "JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.kind')) = 'specification-asset'"];
    const parameters = [projectSlug];
    if (filters.assetId) { where.push("JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.payload.assetId')) = ?"); parameters.push(text(filters.assetId, 'Asset id')); }
    if (filters.kind) { where.push("JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.payload.kind')) = ?"); parameters.push(text(filters.kind, 'Asset kind')); }
    if (filters.functionRevision && !filters.functionId) invalid('关联功能修订缺少功能编号。');
    if (filters.functionId) {
      const ref = { kind: 'function', id: text(filters.functionId, 'Function id'),
        ...(filters.functionRevision ? { revision: text(filters.functionRevision, 'Function revision') } : {}) };
      // Keep all revisions of matching identities: scope/head selection must
      // precede checking the chosen revision's own reference in semanticMatch.
      // Materialize the small ID set once; an IN subquery can make MySQL
      // repeatedly evaluate JSON against the same project records.
      const [matches] = await this.pool.execute(`SELECT DISTINCT JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.payload.assetId')) AS asset_id FROM delivery_center_artifacts a WHERE ${where.join(' AND ')} AND JSON_CONTAINS(JSON_EXTRACT(a.data, '$.payload.functionRefs'), CAST(? AS JSON)) LIMIT 10001`, [...parameters, JSON.stringify(ref)]);
      if (matches.length > MAX_ENTITIES) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', '关联功能的资产超过查询上限，请缩小范围。', 413);
      const ids = [...new Set(matches.map(row => row.asset_id).filter(id => typeof id === 'string' && id))];
      if (!ids.length) return { versions: [] };
      where.push(`JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.payload.assetId')) IN (${ids.map(() => '?').join(', ')})`);
      parameters.push(...ids);
    }
    // Only version metadata crosses the driver boundary; full bodies are read
    // after current/release selection and paging. No unbounded payload cache.
    let payload = jsonProjection('a.data', HEADER_KEYS.map(key => `payload.${key}`)).replaceAll("'payload.", "'");
    for (const key of ['description', 'summary', 'purpose']) payload = payload.replace(`JSON_EXTRACT(a.data, '$.payload.${key}')`, `LEFT(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.payload.${key}')), 'null'), 240)`);
    const projection = `JSON_OBJECT('id', a.id, 'kind', 'specification-asset', 'stageId', a.stage_id, 'releaseId', a.release_id, 'payload', ${payload})`;
    const search = filters.q ? ", CAST(a.data AS CHAR CHARACTER SET utf8mb4) LIKE ? ESCAPE '!' AS search_match" : '';
    const [rows] = await this.pool.execute(`SELECT ${projection} AS data, CASE WHEN a.stage_id IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM delivery_center_stages s WHERE s.project_slug = a.project_slug AND s.id = a.stage_id AND s.is_current = TRUE) END AS stage_current${search} FROM delivery_center_artifacts a WHERE ${where.join(' AND ')} ORDER BY a.id LIMIT 10001`, [...(filters.q ? [`%${escapeDeliveryLike(filters.q)}%`] : []), ...parameters]);
    if (rows.length > MAX_ENTITIES) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', 'Asset versions exceed the supported bound. Narrow the asset kind.', 413);
    return { versions: deliveryAssetVersions(rows, coverage) };
  }

  async listAssets(projectSlug, filters = {}) {
    if (filters.projection === 'summary' && !filters._consistent) return this.#readConsistent(reader => reader.listAssets(projectSlug, { ...filters, _consistent: true }));
    pagination(filters);
    const { versions } = await this.#assetModel(projectSlug, filters);
    const menus = await this.listMenus(projectSlug, filters.releaseId ? { releaseId: filters.releaseId } : { directoryScope: filters.directoryScope === 'historical' ? 'all' : filters.directoryScope });
    const release = filters.releaseId ? await this.getRelease(projectSlug, filters.releaseId) : null;
    let referencePages = [];
    if (groupsDeliveryMenuReferences(filters)) {
      const pages = await this.#assetModel(projectSlug, { kind: 'page' });
      const selected = listDeliveryAssets({ versions: pages.versions, menus, filters: {
        kind: 'page', menuId: filters.menuId, menuScope: filters.menuScope, page: 1, pageSize: MAX_ENTITIES } });
      referencePages = await this.#assetBodies(projectSlug, selected.items, ['component', 'apiBindings', 'relatedComponents']);
    }
    const result = listDeliveryAssets({ versions, menus, filters: { ...filters, projection: undefined }, release, referencePages });
    result.items = await this.#assetBodies(projectSlug, result.items, filters.projection === 'summary' ? summaryDetailKeys() : null);
    result.items = result.items.map(item => withFunctionAssociation(item, filters));
    if (filters.projection === 'summary') { result.items = result.items.map(deliverySummary); result.scope = await this.#scope(projectSlug, filters); }
    return result;
  }

  async getAsset(projectSlug, id, filters = {}) {
    if (filters.detailMode === 'single' && !filters._consistent) return this.#readConsistent(reader => reader.getAsset(projectSlug, id, { ...filters, _consistent: true }));
    text(id, 'Asset id');
    const { versions } = await this.#assetModel(projectSlug, { assetId: id });
    const menus = await this.listMenus(projectSlug, filters.releaseId ? { releaseId: filters.releaseId } : { directoryScope: filters.directoryScope === 'historical' ? 'all' : filters.directoryScope });
    const release = filters.releaseId ? await this.getRelease(projectSlug, filters.releaseId) : null;
    const selected = getDeliveryAsset({ versions, menus, assetId: id, filters, release });
    if (!selected) return null;
    const [body] = await this.#assetBodies(projectSlug, [selected]);
    const full = withFlowDiagramNavigation(withExplicitRelationDetails(body));
    const revisions = filters.detailMode === 'single' ? selected.revisions : await this.#assetBodies(projectSlug, selected.revisions);
    const relationshipDiagram = generateExplicitRelationshipDiagram(full);
    return { ...full, ...(selected.readingSelection ? { readingSelection: selected.readingSelection } : {}), ...(relationshipDiagram ? { relationshipDiagram } : {}), usedByMenus: selected.usedByMenus, revisions, revisionsHasMore: selected.revisionsHasMore,
      ...(filters.detailMode === 'single' ? { scope: await this.#scope(projectSlug, filters) } : {}) };
  }

  async #assetBodies(projectSlug, headers, detailKeys = null, fullTopicDetails = false) {
    if (!headers.length) return [];
    if (detailKeys !== null) detailKeys = [...new Set([...detailKeys, 'name', 'label', 'title', 'pageName'])];
    const result = new Map();
    // Small bounded IN groups avoid packet-sized statements and historical
    // arrays; subviews request only their own child collections.
    for (let offset = 0; offset < headers.length; offset += 200) {
      const ids = headers.slice(offset, offset + 200).map(item => item.versionId);
      const topKeys = (detailKeys ?? []).includes('semanticChanges') ? ['semanticChanges'] : (detailKeys ?? []).includes('relations') ? ['relations'] : [];
      const topFields = topKeys.map(key => `, '${key}', JSON_EXTRACT(a.data, '$.payload.${key}')`).join('');
      const projectedDetails = detailKeys === null ? null : jsonProjection('a.data', detailKeys.map(key => `payload.details.${key}`)).replaceAll("'payload.details.", "'");
      // These bounded stage reports use arbitrary role/profile names as keys.
      // Preserve that source structure for their subviews, without widening
      // ordinary summaries or loading every asset body.
      const details = fullTopicDetails
        ? `CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(a.data, '$.payload.recordType')) IN ('permission-contract', 'permission-enforcement', 'test-evidence-report') THEN JSON_EXTRACT(a.data, '$.payload.details') ELSE ${projectedDetails} END`
        : projectedDetails;
      const select = detailKeys === null ? 'a.data' : `JSON_OBJECT('id', a.id, 'payload', JSON_OBJECT('details', ${details}${topFields})) AS data`;
      const [rows] = await this.pool.execute(`SELECT ${select} FROM delivery_center_artifacts a WHERE a.project_slug = ? AND a.id IN (${ids.map(() => '?').join(', ')})`, [projectSlug, ...ids]);
      for (const row of rows) { const artifact = decoded(row.data); if (artifact?.payload && ids.includes(artifact.id)) result.set(artifact.id, artifact.payload); }
    }
    return headers.map(header => deliveryDisplayRecord({ ...header, ...result.get(header.versionId), id: header.id, versionId: header.versionId,
      isCurrent: header.isCurrent, resolvedMenuIds: header.resolvedMenuIds }));
  }

  async #readConsistent(operation) {
    const connection = await this.pool.getConnection(); let begun = false;
    try {
      await connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.beginTransaction(); begun = true;
      const reader = new DeliveryCenterStore({ pool: { execute: connection.execute.bind(connection), getConnection: async () => connection } });
      const result = await operation(reader);
      await connection.commit(); begun = false; return result;
    } catch (error) { if (begun) await connection.rollback().catch(() => {}); throw error; }
    finally { connection.release(); }
  }

  async #viewRequirements(projectSlug, filters) {
    const { table, release, historical, predicate, parameters } = await this.#requirementQuery(this.pool, projectSlug, { ...filters, _definitionScope: true });
    const column = `r.${release ? 'snapshot' : 'data'}`;
    const keys = ['id', 'name', 'kind', 'revision', 'recordType', 'granularity', 'nature', 'menuId', 'menuIds', 'menuRefs',
      'menuPath', 'menuPaths', 'menuApplicability', 'functionRefs', 'description', 'status', 'adoption', 'sources', 'batchIds', 'semanticChanges', 'recordedAt'];
    if (filters._matrixContent) keys.push('requirementType', 'conditions', 'applicableConditions', 'implementation', 'implementationEvidence',
      'verification', 'verificationEvidence', 'publication', 'publicationEvidence', 'details', 'fields', 'actions', 'rules', 'permissions', 'acceptanceCriteria');
    const projection = jsonProjection(column, keys).replace(`JSON_EXTRACT(${column}, '$.description')`,
      `COALESCE(NULLIF(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.description')), 'null'), ''), JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.details.statement')))`);
    if (filters._matrixContent) {
      const items = []; let bytes = 0;
      for (let offset = 0; offset <= 100000; offset += 200) {
        const [part] = await this.pool.execute(`SELECT ${projection} AS data FROM ${table} r WHERE ${predicate} ORDER BY r.${release ? 'requirement_id' : 'id'}${historical ? ', r.content_digest' : ''} LIMIT 200 OFFSET ?`, [...parameters, offset]);
        for (const row of part) { const item = decoded(row.data); bytes += Buffer.byteLength(JSON.stringify(item)); if (bytes > 32 * 1024 * 1024 || items.length >= 100000) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', '矩阵完整正文超过查询上限，请缩小范围。', 413); items.push(item); }
        if (part.length < 200) return items;
      }
    }
    const [rows] = await this.pool.execute(`SELECT ${projection} AS data FROM ${table} r WHERE ${predicate} ORDER BY r.${release ? 'requirement_id' : 'id'}${historical ? ', r.content_digest' : ''} LIMIT 100001`, parameters);
    if (rows.length > 100000) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', '需求资料超过查询上限，请缩小范围。', 413);
    return rows.map(row => decoded(row.data));
  }

  async #viewAssets(projectSlug, filters, kinds, detailKeys = []) {
    let versions = [];
    // One metadata read for mixed kinds, no N+1 per business menu.
    const model = await this.#assetModel(projectSlug, kinds.length === 1 && kinds[0] !== '*' ? { kind: kinds[0] } : {});
    versions = model.versions.filter(item => kinds.includes('*') || kinds.includes(item.kind));
    const menus = await this.listMenus(projectSlug, filters.releaseId ? { releaseId: filters.releaseId } : { directoryScope: filters.directoryScope === 'historical' ? 'all' : filters.directoryScope });
    const release = filters.releaseId ? await this.getRelease(projectSlug, filters.releaseId) : null;
    const selected = listDeliveryAssets({ versions, menus, release, filters: { ...filters, q: undefined, recordType: undefined,
      projection: undefined, page: 1, pageSize: MAX_ENTITIES } });
    const fullTopicDetails = ['permission-rules', 'permission-matrix', 'permission-evidence', 'test-executions', 'test-cases'].includes(filters.view);
    return detailKeys.length ? this.#assetBodies(projectSlug, selected.items, detailKeys, fullTopicDetails) : selected.items;
  }

  async #historyView(projectSlug, filters) {
    if (!filters.recordId) invalid('历史查询必须指定记录。');
    const paging = pagination(filters);
    if (filters.kind === 'requirement') {
      if (filters.releaseId) { const item = await this.getRequirement(projectSlug, filters.recordId, filters); return { items: item ? [historyMetadata(item)] : [], total: item ? 1 : 0, page: 1, pageSize: paging.pageSize }; }
      const parameters = [projectSlug, filters.recordId];
      const batch = filters.batchId ? " AND JSON_CONTAINS(data, JSON_QUOTE(?), '$.batchIds')" : '';
      if (filters.batchId) parameters.push(filters.batchId);
      const [[count]] = await this.pool.execute(`SELECT COUNT(*) AS total FROM delivery_center_requirement_versions WHERE project_slug = ? AND requirement_id = ?${batch}`, parameters);
      const projection = jsonProjection('data', ['id', 'revision', 'recordedAt', 'nature', 'status', 'sourceRevision', 'changeSummary', 'sources']);
      const [rows] = await this.pool.execute(`SELECT content_digest, observed_at, ${projection} AS data FROM delivery_center_requirement_versions WHERE project_slug = ? AND requirement_id = ?${batch} ORDER BY observed_at DESC, content_digest LIMIT ? OFFSET ?`, [...parameters, paging.pageSize, paging.offset]);
      return { items: rows.map(row => historyMetadata({ ...decoded(row.data), digest: row.content_digest })), total: Number(count.total), page: paging.page, pageSize: paging.pageSize };
    }
    const { versions } = await this.#assetModel(projectSlug, { assetId: filters.recordId });
    const menus = await this.listMenus(projectSlug, filters.releaseId ? { releaseId: filters.releaseId } : {});
    const release = filters.releaseId ? await this.getRelease(projectSlug, filters.releaseId) : null;
    // Selection enforces frozen release membership; ordinary history may include
    // all revisions without silently selecting a historical body as current.
    let candidates = versions.filter(item => !filters.batchId || (item.batchIds ?? []).includes(filters.batchId));
    if (filters.releaseId) candidates = candidates.filter(item => getDeliveryAsset({ versions: [item], menus, assetId: filters.recordId, filters: { ...filters, revision: item.versionId }, release }));
    return paginateView(candidates.map(historyMetadata), { ...filters, revision: undefined, kind: undefined, recordType: undefined });
  }

  async #view(projectSlug, filters, exporting = false) {
    slug(projectSlug); pagination(filters);
    const view = filters.view;
    if (!Object.hasOwn(DELIVERY_VIEWS, view ?? '')) invalid('查看类型无效。');
    const scope = await this.#scope(projectSlug, filters);
    if (view === 'history') return { ...await this.#historyView(projectSlug, filters), scope };
    let rows = []; let counts; let columns;
    if (['requirement-matrix', 'requirements-sources'].includes(view)) {
      const requirements = await this.#viewRequirements(projectSlug, { ...filters, q: undefined,
        recordType: view === 'requirement-matrix' ? 'requirement' : undefined, _matrixContent: view === 'requirement-matrix' });
      if (view === 'requirements-sources') rows = requirements.filter(item => requirementType(item) !== 'requirement')
        .map(item => ({ ...deliverySummary(item), recordType: requirementType(item), parentRef: recordRef(item, 'requirement'), localId: null }));
      else {
        const assets = await this.#viewAssets(projectSlug, filters, ['function']);
        const { versions: functionVersions } = await this.#assetModel(projectSlug, { kind: 'function' });
        const menus = filters.batchId && !filters.releaseId ? []
          : await this.listMenus(projectSlug, filters.releaseId ? { releaseId: filters.releaseId } : {});
        rows = requirementMatrix(requirements, assets, menus, functionVersions);
      }
    } else if (view === 'menu-matrix') {
      const menus = await this.listMenus(projectSlug, filters.releaseId ? { releaseId: filters.releaseId } : { directoryScope: filters.directoryScope });
      const assets = await this.#viewAssets(projectSlug, { ...filters, origin: undefined, businessChange: undefined }, ['*']);
      const requirements = await this.#viewRequirements(projectSlug, { ...filters, origin: undefined, businessChange: undefined, recordType: undefined });
      const category = { function: 'functions', page: 'pages', scene: 'processes', entity: 'entities', table: 'tables', api: 'apis', permission: 'permissions', test: 'acceptance' };
      const documents = [...requirements.filter(item => requirementType(item) === 'requirement').map(item => ({ ...item, category: 'requirements' })),
        ...assets.filter(item => category[item.kind]).map(item => ({ ...item, category: category[item.kind] }))];
      rows = (await this.listMenus(projectSlug, filters)).map(menu => {
        const descendants = deliveryMenuDescendants(menus, menu.id); descendants.delete(menu.id);
        const values = Object.fromEntries(['requirements', 'functions', 'pages', 'processes', 'entities', 'tables', 'apis', 'permissions', 'acceptance', 'releases'].map(key => [key, null]));
        for (const document of documents) {
          const ids = new Set([document.menuId, ...(document.menuIds ?? []), ...(document.resolvedMenuIds ?? [])].filter(Boolean));
          const direct = ids.has(menu.id); const child = [...ids].some(id => descendants.has(id));
          if (!direct && !child) continue;
          const value = values[document.category] ??= { direct: 0, descendants: 0, shared: null, total: 0, meaning: 'recorded-associations' };
          value.direct += Number(direct); value.descendants += Number(!direct && child); value.total++;
        }
        return { ...menu, counts: values, parentRef: recordRef(menu, 'menu'), origin: menu.origin ?? 'unknown', businessChange: menu.businessChange ?? 'unknown' };
      });
    } else if (['business-versions', 'release-attempts', 'environments'].includes(view)) {
      const selection = filters.projection === 'summary' ? "JSON_REMOVE(data, '$.documentedChanges') AS data" : 'data';
      const [stored] = await this.pool.execute(`SELECT ${selection} FROM delivery_center_releases WHERE project_slug = ? ORDER BY released_at DESC, id LIMIT 10001`, [projectSlug]);
      if (stored.length > MAX_ENTITIES) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', '发布记录超过查询上限。', 413);
      const releases = stored.map(row => decoded(row.data)).filter(item => (!filters.releaseId || item.id === filters.releaseId) && (!filters.environment || item.environment === filters.environment)
        && (!filters.status || item.status === filters.status));
      if (view === 'release-attempts') rows = releases.map(item => ({ ...(filters.projection === 'summary' ? deliverySummary(item) : item), parentRef: recordRef(item, 'release') }));
      if (view === 'business-versions') rows = releases.flatMap(item => (Array.isArray(item.businessVersions) ? item.businessVersions : item.businessVersion ? [item.businessVersion] : []).map((version, index) => ({ ...(record(version) ? version : { name: version }), parentRef: recordRef(item, 'release'), localId: `/businessVersions/${index}` })));
      if (view === 'environments') rows = releases.flatMap(item => (item.environmentObservations ?? []).map((observation, index) => ({ ...observation, parentRef: recordRef(item, 'release'), localId: `/environmentObservations/${index}` })));
    } else {
      const assets = await this.#viewAssets(projectSlug, { ...filters, nature: undefined }, DELIVERY_VIEWS[view], viewReadDetailKeys(view));
      rows = buildSubview(view, assets);
      if (view === 'changes') {
        const requirements = await this.#viewRequirements(projectSlug, { ...filters, recordType: undefined });
        rows.push(...buildSubview(view, requirements.map(item => ({ ...item, kind: 'requirement' }))));
      }
      if (view === 'permission-matrix') {
        rows = rows.filter(row => semanticMatch(row, { nature: filters.nature }));
        const subjects = new Map(); const operations = new Map();
        for (const row of rows) {
          const subjectKey = row.subjectId ?? JSON.stringify([row.subjectType ?? null, row.subject]);
          const operationId = row.operationId ?? JSON.stringify([row.operation, row.resource]);
          operations.set(operationId, { id: operationId, name: row.operation ?? '未明确操作', resource: row.resource });
          if (!subjects.has(subjectKey)) subjects.set(subjectKey, { id: subjectKey, subject: row.subject, subjectType: row.subjectType ?? null, name: row.subject, cells: [] });
          subjects.get(subjectKey).cells.push(...row.cells.map(cell => ({ ...cell, operationId, operation: row.operation, resource: row.resource, dataScope: row.dataScope })));
        }
        rows = [...subjects.values()]; columns = [...operations.values()];
        if (columns.length > 200) throw new DeliveryCenterError('DELIVERY_RESULT_LIMIT', '权限操作超过 200 列，请选择具体菜单或缩小范围。', 413);
      }
    }
    const matched = paginateView(rows, { q: filters.q, ...(view !== 'permission-matrix' ? { nature: filters.nature } : {}), page: 1, pageSize: Math.max(rows.length, 1) });
    if (view === 'requirement-matrix') counts = matrixIdentityCounts(matched.items);
    if (exporting) return { items: matched.items, total: matched.total, scope, counts };
    const page = paginateView(matched.items, { page: filters.page, pageSize: filters.pageSize });
    if (view === 'requirement-matrix') page.items = page.items.map(deliverySummary);
    return { ...page, scope, ...(counts ? { counts } : {}), ...(columns ? { columns } : {}) };
  }

  listView(projectSlug, filters = {}) { return this.#readConsistent(reader => reader.#view(projectSlug, filters)); }
  exportView(projectSlug, filters = {}) {
    if (filters.view !== 'requirement-matrix') invalid('该视图尚不支持导出。');
    return this.#readConsistent(reader => reader.#view(projectSlug, filters, true));
  }

  async #list(projectSlug, table, filters = {}) {
    slug(projectSlug);
    const paging = pagination(filters);
    const where = ['project_slug = ?']; const parameters = [projectSlug];
    if (table === 'batches') where.push('is_current = TRUE');
    if (table === 'artifacts') where.push("(JSON_EXTRACT(data, '$.kind') IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(data, '$.kind')) <> 'specification-asset')");
    const columns = table === 'stages' ? { batchId: 'batch_id', phaseId: 'phase_id', status: 'status' }
      : table === 'releases' ? { environment: 'environment', status: 'status' }
        : table === 'artifacts' ? { releaseId: 'release_id', stageId: 'stage_id' } : { batchId: 'id' };
    for (const [filter, column] of Object.entries(columns)) if (filters[filter]) { where.push(`${column} = ?`); parameters.push(text(filters[filter], filter)); }
    if (filters.q !== undefined && filters.q !== '') {
      if (typeof filters.q !== 'string' || filters.q.length > 256) invalid('Search query is invalid.');
      where.push("CAST(data AS CHAR CHARACTER SET utf8mb4) LIKE ? ESCAPE '!'"); parameters.push(`%${escapeDeliveryLike(filters.q)}%`);
    }
    if (table === 'stages') { where.push('is_current = ?'); parameters.push(filters.isCurrent === undefined || filters.isCurrent === true || filters.isCurrent === 'true'); }
    const predicate = where.join(' AND ');
    const [[count]] = await this.pool.execute(`SELECT COUNT(*) AS total FROM delivery_center_${table} WHERE ${predicate}`, parameters);
    // Preserve the Controller's DELIVERY_PHASES order within each original task batch.
    const stageOrder = "batch_id, CASE phase_id WHEN 'requirements' THEN 0 WHEN 'domain-contract' THEN 1 WHEN 'database' THEN 2 WHEN 'ui-design' THEN 3 WHEN 'backend' THEN 4 WHEN 'frontend' THEN 5 WHEN 'access-wiring' THEN 6 WHEN 'cross-layer-acceptance' THEN 7 ELSE 8 END, created_at DESC, content_digest, id";
    const order = table === 'releases' ? 'released_at DESC, id' : table === 'stages' ? stageOrder : 'id';
    const selection = table === 'stages' ? `${filters.projection === 'summary' ? "JSON_REMOVE(data, '$.details') AS data" : 'data'}, is_current, content_digest`
      : table === 'releases' && filters.projection === 'summary' ? "JSON_REMOVE(data, '$.documentedChanges') AS data" : 'data';
    const [rows] = await this.pool.execute(`SELECT ${selection} FROM delivery_center_${table} WHERE ${predicate} ORDER BY ${order} LIMIT ? OFFSET ?`, [...parameters, paging.pageSize, paging.offset]);
    const items = rows.map((row) => table === 'stages' ? { ...decoded(row.data), revision: row.content_digest, isCurrent: Boolean(row.is_current) } : decoded(row.data));
    if (table === 'stages') {
      const batchIds = [...new Set(items.filter(item => !item.taskId && item.batchId).map(item => item.batchId))];
      if (batchIds.length) {
        const [batches] = await this.pool.execute(`SELECT id, JSON_UNQUOTE(JSON_EXTRACT(data, '$.taskId')) AS task_id FROM delivery_center_batches WHERE project_slug = ? AND id IN (${batchIds.map(() => '?').join(',')})`, [projectSlug, ...batchIds]);
        const tasks = new Map(batches.filter(batch => typeof batch.task_id === 'string' && batch.task_id.trim() && batch.task_id !== 'null').map(batch => [batch.id, batch.task_id]));
        for (const item of items) if (!item.taskId && tasks.has(item.batchId)) item.taskId = tasks.get(item.batchId);
      }
    }
    return { items: filters.projection === 'summary' ? items.map(deliverySummary) : items, total: Number(count.total), page: paging.page, pageSize: paging.pageSize,
      ...(filters.projection === 'summary' ? { scope: await this.#scope(projectSlug, filters) } : {}) };
  }

  listBatches(projectSlug, filters) { return this.#list(projectSlug, 'batches', filters); }
  listStages(projectSlug, filters) { return this.#list(projectSlug, 'stages', filters); }
  listReleases(projectSlug, filters) { return this.#list(projectSlug, 'releases', filters); }
  listArtifacts(projectSlug, filters) { return this.#list(projectSlug, 'artifacts', filters); }

  async getStage(projectSlug, id, filters = {}) {
    slug(projectSlug); text(id, 'Stage id');
    // This identifies an immutable stored row, not its original artifact digest.
    if (typeof filters.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(filters.revision)) return null;
    const batchPredicate = filters.batchId ? ' AND s.batch_id = ?' : '';
    const parameters = [projectSlug, id, filters.revision, ...(filters.batchId ? [text(filters.batchId, 'Batch id')] : [])];
    const [[row]] = await this.pool.execute("SELECT s.data, s.content_digest, s.is_current, JSON_UNQUOTE(JSON_EXTRACT(b.data, '$.taskId')) AS batch_task_id FROM delivery_center_stages s LEFT JOIN delivery_center_batches b ON b.project_slug = s.project_slug AND b.id = s.batch_id WHERE s.project_slug = ? AND s.id = ? AND s.content_digest = ?" + batchPredicate, parameters);
    if (!row) return null;
    const item = { ...decoded(row.data), revision: row.content_digest, isCurrent: Boolean(row.is_current) };
    if (!item.taskId && typeof row.batch_task_id === 'string' && row.batch_task_id.trim() && row.batch_task_id !== 'null') item.taskId = row.batch_task_id;
    return item;
  }

  async getRelease(projectSlug, id) {
    slug(projectSlug); text(id, 'Release id');
    const [[row]] = await this.pool.execute('SELECT data FROM delivery_center_releases WHERE project_slug = ? AND id = ?', [projectSlug, id]);
    return row ? decoded(row.data) : null;
  }

  async close() { await this.pool.end(); }
}
