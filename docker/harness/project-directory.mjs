import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const PROJECT_REGISTRY_COLUMNS = Object.freeze([
  'slug',
  'display_name',
  'ui_port',
  'harness_port',
  'forge_ref',
  'forge_commit',
  'created_at',
  'project_kind',
  'mysql_database',
  'mysql_test_database',
  'redis_database',
  'redis_test_database',
]);

const SLUG_PATTERN = /^[a-z][a-z0-9-]{2,31}$/;
const PROJECT_KIND_PATTERN = /^(foundation|delivery|replica)$/;

function parsePort(value, label) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${label} is invalid in the project registry.`);
  }
  return port;
}

export function parseProjectRegistry(raw) {
  if (typeof raw !== 'string') throw new Error('Project registry must be text.');
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error('Project registry is empty.');
  const header = lines[0].split('\t');
  if (header.length < PROJECT_REGISTRY_COLUMNS.length
    || PROJECT_REGISTRY_COLUMNS.some((column, index) => header[index] !== column)) {
    throw new Error('Project registry header is unsupported.');
  }
  const projects = [];
  const slugs = new Set();
  const uiPorts = new Set();
  for (const [offset, line] of lines.slice(1).entries()) {
    const fields = line.split('\t');
    if (fields.length < PROJECT_REGISTRY_COLUMNS.length) {
      throw new Error(`Project registry row ${offset + 2} is incomplete.`);
    }
    const [slug, displayName, uiPortText, legacyHarnessPort, forgeRef, forgeCommit, createdAt, projectKind] = fields;
    if (!SLUG_PATTERN.test(slug) || slugs.has(slug)) {
      throw new Error(`Project registry row ${offset + 2} has an invalid or duplicate slug.`);
    }
    if (!displayName || /[\t\r\n\u0000-\u001f\u007f]/u.test(displayName)) {
      throw new Error(`Project registry row ${offset + 2} has an invalid display name.`);
    }
    const uiPort = parsePort(uiPortText, 'Forge UI port');
    if (uiPorts.has(uiPort)) throw new Error(`Project registry row ${offset + 2} reuses a Forge UI port.`);
    if (legacyHarnessPort !== '') parsePort(legacyHarnessPort, 'Legacy Harness port');
    if (!PROJECT_KIND_PATTERN.test(projectKind)) {
      throw new Error(`Project registry row ${offset + 2} has an invalid project kind.`);
    }
    if (!/^[a-f0-9]{40}$/.test(forgeCommit)) {
      throw new Error(`Project registry row ${offset + 2} has an invalid Forge commit.`);
    }
    if (Number.isNaN(Date.parse(createdAt))) {
      throw new Error(`Project registry row ${offset + 2} has an invalid creation time.`);
    }
    slugs.add(slug);
    uiPorts.add(uiPort);
    projects.push(Object.freeze({
      slug,
      displayName,
      uiPort,
      legacyHarnessPort: legacyHarnessPort === '' ? null : Number.parseInt(legacyHarnessPort, 10),
      forgeRef,
      forgeCommit,
      createdAt,
      projectKind,
    }));
  }
  return projects;
}

export class RegistryProjectDirectory {
  constructor({ registryPath, capabilityRoot }) {
    if (typeof registryPath !== 'string' || !path.isAbsolute(registryPath)) {
      throw new Error('registryPath must be absolute.');
    }
    if (typeof capabilityRoot !== 'string' || !path.isAbsolute(capabilityRoot)) {
      throw new Error('capabilityRoot must be absolute.');
    }
    this.registryPath = registryPath;
    this.capabilityRoot = path.resolve(capabilityRoot);
  }

  async list() {
    return parseProjectRegistry(await readFile(this.registryPath, 'utf8'));
  }

  async get(slug) {
    if (!SLUG_PATTERN.test(slug)) return undefined;
    return (await this.list()).find((project) => project.slug === slug);
  }

  capabilityPaths(slug) {
    if (!SLUG_PATTERN.test(slug)) throw new Error('Project slug is invalid.');
    const projectRoot = path.resolve(this.capabilityRoot, slug);
    if (!projectRoot.startsWith(`${this.capabilityRoot}${path.sep}`)) {
      throw new Error('Project capability path escaped its root.');
    }
    return {
      socketPath: path.join(projectRoot, 'ipc', 'manager.sock'),
      tokenPath: path.join(projectRoot, 'manager-token'),
    };
  }
}
