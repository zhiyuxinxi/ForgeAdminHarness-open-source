import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WORKSPACE_STORE_VERSION = 2;

function requireAbsolutePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

function validateExistingStore(store) {
  if (store === null || typeof store !== 'object' || Array.isArray(store)
    || store.unit?.name !== 'workspace' || store.unit?.version !== WORKSPACE_STORE_VERSION
    || store.global === null || typeof store.global !== 'object'
    || !Array.isArray(store.global.workspaceIds)
    || !Array.isArray(store.global.archivedSessionIds)
    || store.tables === null || typeof store.tables !== 'object'
    || store.tables.workspaces === null || typeof store.tables.workspaces !== 'object'
    || Array.isArray(store.tables.workspaces)) {
    throw new Error('Existing DSH workspace storage has an unsupported schema; refusing to overwrite it.');
  }
}

export async function ensureDefaultWorkspace(options = {}) {
  const dshHome = requireAbsolutePath(options.dshHome, 'DSH home');
  const workspacePath = requireAbsolutePath(options.workspacePath, 'Default workspace');
  const title = String(options.title ?? '').trim();
  if (title.length < 1 || title.length > 120) {
    throw new Error('Default workspace title must contain 1 to 120 characters.');
  }

  const workspaceStat = await lstat(workspacePath);
  if (!workspaceStat.isDirectory()) throw new Error('Default workspace is not a directory.');

  const storageRoot = path.join(dshHome, 'storages');
  const storagePath = path.join(storageRoot, 'workspace.json');
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });

  let store;
  try {
    store = JSON.parse(await readFile(storagePath, 'utf8'));
    validateExistingStore(store);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    store = {
      unit: { name: 'workspace', version: WORKSPACE_STORE_VERSION },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
      tables: { workspaces: {} },
    };
  }

  const existingEntries = Object.entries(store.tables.workspaces);
  const registered = existingEntries.find(([, entry]) => entry?.path === workspacePath);
  if (registered !== undefined) {
    return { changed: false, reason: 'already-registered', workspaceId: registered[0], storagePath };
  }
  if (store.global.workspaceIds.length > 0 || existingEntries.length > 0) {
    return { changed: false, reason: 'existing-workspace-preserved', storagePath };
  }

  const workspaceId = randomUUID();
  const now = new Date().toISOString();
  store.global.initialized = true;
  store.global.workspaceIds = [workspaceId];
  store.tables.workspaces = {
    [workspaceId]: {
      path: workspacePath,
      title,
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    },
  };

  const temporaryPath = path.join(storageRoot, `.workspace.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, storagePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return { changed: true, reason: 'registered', workspaceId, storagePath };
}

async function main() {
  const workspacePath = process.env.HARNESS_DEFAULT_WORKSPACE;
  if (workspacePath === undefined || workspacePath.length === 0) return;
  const result = await ensureDefaultWorkspace({
    dshHome: process.env.DSH_HOME ?? path.join(process.env.HOME ?? '/home/node', '.dsh'),
    workspacePath,
    title: process.env.HARNESS_DEFAULT_WORKSPACE_TITLE ?? 'Forge Admin 项目工作区',
  });
  process.stdout.write(`Default workspace ${result.reason}: ${workspacePath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`Default workspace initialization failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
