import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ensureDefaultWorkspace } from '../docker/harness/seed-default-workspace.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-default-workspace-'));
  const dshHome = path.join(root, 'dsh-home');
  const workspacePath = path.join(root, 'workspace');
  await mkdir(dshHome, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  return { root, dshHome, workspacePath, storagePath: path.join(dshHome, 'storages', 'workspace.json') };
}

test('an empty TaskSpace automatically registers its isolated workspace', async () => {
  const value = await fixture();
  try {
    const result = await ensureDefaultWorkspace({
      dshHome: value.dshHome,
      workspacePath: value.workspacePath,
      title: 'Forge Admin · validation-project',
    });
    assert.equal(result.changed, true);
    const store = JSON.parse(await readFile(value.storagePath, 'utf8'));
    assert.equal(store.unit.name, 'workspace');
    assert.equal(store.unit.version, 2);
    assert.equal(store.global.workspaceIds.length, 1);
    const workspace = store.tables.workspaces[store.global.workspaceIds[0]];
    assert.equal(workspace.path, value.workspacePath);
    assert.equal(workspace.title, 'Forge Admin · validation-project');
    assert.deepEqual(workspace.sessionIds, []);
    if (process.platform !== 'win32') {
      assert.equal((await stat(value.storagePath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('the initializer repairs only the pinned empty DSH workspace schema and is idempotent', async () => {
  const value = await fixture();
  try {
    await mkdir(path.dirname(value.storagePath), { recursive: true });
    await writeFile(value.storagePath, JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
      tables: { workspaces: {} },
    }));
    const first = await ensureDefaultWorkspace({ dshHome: value.dshHome, workspacePath: value.workspacePath, title: 'Forge Admin' });
    const firstContent = await readFile(value.storagePath, 'utf8');
    const second = await ensureDefaultWorkspace({ dshHome: value.dshHome, workspacePath: value.workspacePath, title: 'Changed title' });
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(second.reason, 'already-registered');
    assert.equal(await readFile(value.storagePath, 'utf8'), firstContent);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('an existing user-selected workspace and its sessions are never overwritten', async () => {
  const value = await fixture();
  const existingId = '11111111-1111-4111-8111-111111111111';
  const existing = {
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [existingId], archivedSessionIds: ['archived-session'] },
    tables: {
      workspaces: {
        [existingId]: {
          path: '/another-workspace', title: 'Existing', sessionIds: ['session-1'],
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  };
  try {
    await mkdir(path.dirname(value.storagePath), { recursive: true });
    await writeFile(value.storagePath, `${JSON.stringify(existing)}\n`);
    const before = await readFile(value.storagePath, 'utf8');
    const result = await ensureDefaultWorkspace({ dshHome: value.dshHome, workspacePath: value.workspacePath, title: 'Forge Admin' });
    assert.equal(result.changed, false);
    assert.equal(result.reason, 'existing-workspace-preserved');
    assert.equal(await readFile(value.storagePath, 'utf8'), before);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('unknown or corrupt DSH storage fails closed instead of deleting user state', async () => {
  const value = await fixture();
  try {
    await mkdir(path.dirname(value.storagePath), { recursive: true });
    await writeFile(value.storagePath, '{"unit":{"name":"workspace","version":99}}\n');
    await assert.rejects(
      ensureDefaultWorkspace({ dshHome: value.dshHome, workspacePath: value.workspacePath, title: 'Forge Admin' }),
      /unsupported schema/,
    );
    assert.match(await readFile(value.storagePath, 'utf8'), /"version":99/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
