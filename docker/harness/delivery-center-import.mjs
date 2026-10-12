#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readDeliveryDatabaseConfig } from './delivery-center-config.mjs';
import { createDeliveryCenterPool, DeliveryCenterStore } from './delivery-center-store.mjs';
import { collectDeliverySnapshot } from './delivery-center-projection.mjs';
import { parseProjectRegistry } from './project-directory.mjs';

export async function readDeliverySources(filename) {
  if (!filename || !path.isAbsolute(filename)) throw new Error('DELIVERY_SOURCES_PATH_INVALID');
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('DELIVERY_SOURCES_FILE_INVALID');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.projects) || manifest.projects.length > 1000) throw new Error('DELIVERY_SOURCES_INVALID');
  const seen = new Set();
  for (const entry of manifest.projects) {
    if (!entry || !/^[a-z][a-z0-9-]{2,31}$/.test(entry.projectSlug ?? '') || seen.has(entry.projectSlug)
      || typeof entry.projectName !== 'string' || !entry.projectName || entry.projectName.length > 255
      || !(entry.phaseRoot === null || (typeof entry.phaseRoot === 'string' && path.isAbsolute(entry.phaseRoot)))
      || !(entry.releaseAuditPath === null || (typeof entry.releaseAuditPath === 'string' && path.isAbsolute(entry.releaseAuditPath)))
      || (entry.brokerAuditPath !== undefined && entry.brokerAuditPath !== null
        && !(typeof entry.brokerAuditPath === 'string' && path.isAbsolute(entry.brokerAuditPath)))
      || (entry.historyPacketPaths !== undefined && (!Array.isArray(entry.historyPacketPaths) || entry.historyPacketPaths.length > 32
        || entry.historyPacketPaths.some(file => typeof file !== 'string' || !path.isAbsolute(file))))
      || (entry.committedDocuments !== undefined && (!entry.committedDocuments || typeof entry.committedDocuments !== 'object'
        || Array.isArray(entry.committedDocuments) || typeof entry.committedDocuments.repositoryRoot !== 'string'
        || !path.isAbsolute(entry.committedDocuments.repositoryRoot)))) throw new Error('DELIVERY_SOURCE_INVALID');
    seen.add(entry.projectSlug);
  }
  return manifest.projects;
}

export function selectDeliveryProjects(projects, projectSlug) {
  if (projectSlug === undefined) return projects;
  if (typeof projectSlug !== 'string' || !/^[a-z][a-z0-9-]{2,31}$/.test(projectSlug)) throw new Error('DELIVERY_ARGUMENT_INVALID');
  const selected = projects.filter((project) => project.projectSlug === projectSlug);
  if (!selected.length) throw Object.assign(new Error('DELIVERY_PROJECT_NOT_FOUND'), { code: 'DELIVERY_PROJECT_NOT_FOUND' });
  return selected;
}

export async function readRegistryDeliverySources({ registryPath, projectsRoot }) {
  if (typeof registryPath !== 'string' || !path.isAbsolute(registryPath)
    || typeof projectsRoot !== 'string' || !path.isAbsolute(projectsRoot)) throw new Error('DELIVERY_REGISTRY_PATH_INVALID');
  // Only ENOENT denotes an unconfigured source. Permission failures, non-directory
  // ancestors and symbolic links must not turn an existing source into null.
  const inspect = async (target, directory, missingAllowed = false) => {
    const absolute = path.resolve(target); const root = path.parse(absolute).root;
    const segments = path.relative(root, absolute).split(path.sep).filter(Boolean);
    let current = root; let info;
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      try { info = await lstat(current); }
      catch (error) { if (missingAllowed && error.code === 'ENOENT') return null; throw error; }
      if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory())) throw new Error('DELIVERY_REGISTRY_SOURCE_UNSAFE');
    }
    if (!info) info = await lstat(root);
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('DELIVERY_REGISTRY_SOURCE_INVALID');
    return info;
  };
  const registry = await inspect(registryPath, false);
  if (registry.size > 1024 * 1024) throw new Error('DELIVERY_REGISTRY_TOO_LARGE');
  await inspect(projectsRoot, true);
  const bytes = await readFile(registryPath);
  if (bytes.length > 1024 * 1024) throw new Error('DELIVERY_REGISTRY_TOO_LARGE');
  const projects = parseProjectRegistry(bytes.toString('utf8'));
  if (projects.length > 1000) throw new Error('DELIVERY_REGISTRY_TOO_LARGE');
  const sources = [];
  for (const project of projects) {
    const projectRoot = path.join(path.resolve(projectsRoot), project.slug);
    const phaseRoot = path.join(projectRoot, 'taskspaces', '.broker', 'delivery-phases');
    const releaseAuditPath = path.join(projectRoot, 'ops', 'release-audit.jsonl');
    const brokerAuditPath = path.join(projectRoot, 'taskspaces', '.broker', 'audit.jsonl');
    sources.push({ projectSlug: project.slug, projectName: project.displayName,
      phaseRoot: await inspect(phaseRoot, true, true) ? phaseRoot : null,
      releaseAuditPath: await inspect(releaseAuditPath, false, true) ? releaseAuditPath : null,
      brokerAuditPath: await inspect(brokerAuditPath, false, true) ? brokerAuditPath : null });
  }
  return sources;
}

// Files that changed during collection must never erase a previously complete projection.
// REPAIR_LINK_UNVERIFIED is historical binding uncertainty: the collector retains
// those validated records as noncurrent history and keeps the coverage gap. It
// must not block independently readable history packets; actual read/digest
// failures remain blocking below.
const BLOCKING_GAPS = /UNAVAILABLE|UNREADABLE|SOURCE_CHANGED|STATE_|ARTIFACT_READ_FAILED|ARTIFACT_INVALID|COUNT_LIMIT|DEPTH_LIMIT|SCAN_LIMIT|FILE_LIMIT|PROJECTION_LIMIT|INVALID_JSON|TOO_LARGE|SYMLINK|PATH_UNSAFE|ROOT_MISSING|RELEASE_AUDIT_INVALID_LINE|BROKER_AUDIT_INVALID_LINE|RELEASE_BINDING_CONFLICT/i;

export async function importDeliverySources({ store, projects, collect = collectDeliverySnapshot, now = () => new Date().toISOString() }) {
  const results = [];
  for (const project of projects) {
    try {
      if (project.phaseRoot === null && (await store.overview(project.projectSlug))?.counts?.stages > 0) {
        results.push({ projectSlug: project.projectSlug, ok: false, code: 'DELIVERY_SOURCE_REMOVED', preservedPreviousSnapshot: true });
        continue;
      }
      const snapshot = await collect({ ...project, observedAt: now() });
      const gaps = snapshot.coverage?.gaps ?? [];
      if (snapshot.coverage?.readComplete === false || gaps.some((gap) => BLOCKING_GAPS.test(typeof gap === 'string' ? gap : gap.code ?? ''))) {
        const gapCodes = [...new Set(gaps.map((gap) => typeof gap === 'string' ? gap : gap.code)
          .filter((code) => typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(code)))];
        results.push({ projectSlug: project.projectSlug, ok: false, code: 'DELIVERY_SOURCE_INCOMPLETE', gapCodes, preservedPreviousSnapshot: true });
        continue;
      }
      const receipt = await store.importSnapshot(snapshot);
      results.push({ ...receipt, ok: true });
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'DELIVERY_IMPORT_FAILED';
      results.push({ projectSlug: project.projectSlug, ok: false, code, preservedPreviousSnapshot: true });
    }
  }
  return { ok: results.every((result) => result.ok), results };
}

export function parseDeliveryImportOptions(argv) {
  const result = { interval: 60, watch: false, initialize: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--watch') result.watch = true;
    else if (flag === '--initialize') result.initialize = true;
    else if (['--config', '--sources', '--registry', '--projects-root', '--project', '--interval-seconds'].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('DELIVERY_ARGUMENT_INVALID');
      result[flag === '--interval-seconds' ? 'interval' : flag === '--projects-root' ? 'projectsRoot' : flag.slice(2)] = value;
    } else throw new Error('DELIVERY_ARGUMENT_INVALID');
  }
  result.interval = Number(result.interval);
  const validSources = result.sources ? !result.registry && !result.projectsRoot
    : typeof result.registry === 'string' && path.isAbsolute(result.registry)
      && typeof result.projectsRoot === 'string' && path.isAbsolute(result.projectsRoot);
  if (!Number.isInteger(result.interval) || result.interval < 15 || result.interval > 3600 || !result.config || !validSources
    || (result.project !== undefined && !/^[a-z][a-z0-9-]{2,31}$/.test(result.project))) throw new Error('DELIVERY_ARGUMENT_INVALID');
  return result;
}

async function main() {
  const args = parseDeliveryImportOptions(process.argv.slice(2));
  const store = new DeliveryCenterStore({ pool: createDeliveryCenterPool(await readDeliveryDatabaseConfig(path.resolve(args.config))) });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (args.initialize) await store.initialize();
    do {
      const projects = args.sources ? await readDeliverySources(path.resolve(args.sources))
        : await readRegistryDeliverySources({ registryPath: args.registry, projectsRoot: args.projectsRoot });
      const receipt = await importDeliverySources({ store, projects: selectDeliveryProjects(projects, args.project) });
      process.stdout.write(`${JSON.stringify({ observedAt: new Date().toISOString(), ...receipt })}\n`);
      if (!args.watch) { if (!receipt.ok) process.exitCode = 1; break; }
      try { await delay(args.interval * 1000, undefined, { signal: controller.signal }); } catch (error) { if (error.name !== 'AbortError') throw error; }
    } while (!controller.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    await store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(error.code === 'DELIVERY_PROJECT_NOT_FOUND'
      ? 'DELIVERY_PROJECT_NOT_FOUND: 未在来源中找到指定项目，未执行导入。\n'
      : 'DELIVERY_IMPORT_FAILED: 检查私有数据库配置、只读来源路径及数据库连接。\n');
    process.exitCode = 1;
  });
}
