import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrateConversationControlPlane } from '../scripts/migrate-conversation-control-plane.mjs';

const header = 'slug\tdisplay_name\tui_port\tharness_port\tforge_ref\tforge_commit\tcreated_at\tproject_kind\tmysql_database\tmysql_test_database\tredis_database\tredis_test_database';
const commit = 'a'.repeat(40);

function state({ userId, username, role, passwordHash, conversationId, taskId }) {
  const now = '2026-08-28T10:00:00.000Z';
  return {
    schemaVersion: 1,
    revision: 7,
    users: [{ id: userId, username, displayName: username, role, status: 'active', passwordHash, mustChangePassword: false, sessionVersion: 3, createdAt: now, updatedAt: now }],
    sessions: [{ tokenHash: 'revoked', userId, sessionVersion: 3, createdAt: now, lastSeenAt: now, absoluteExpiresAt: '2030-01-01T00:00:00.000Z' }],
    conversations: [{ id: conversationId, taskId, ownerUserId: userId, title: taskId, status: 'active', port: 25000, createdAt: now, updatedAt: now, lastOpenedAt: now, lastError: null }],
    idempotency: [],
  };
}

test('migration uses canonical accounts, maps project memberships and conversations, revokes sessions, and is idempotent', async () => {
  const deliveryRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-control-migrate-'));
  const targetStateRoot = path.join(deliveryRoot, 'conversation-control-plane', 'state');
  try {
    await mkdir(path.join(deliveryRoot, 'registry'), { recursive: true });
    await writeFile(path.join(deliveryRoot, 'registry', 'projects.tsv'), `${header}\nforge-base\tForge Base\t18080\t13080\tbase\t${commit}\t2026-08-28T10:00:00Z\tfoundation\tdb\tdb_test\t1\t2\nforge-copy\tForge Copy\t18081\t13081\tcopy\t${commit}\t2026-08-28T11:00:00Z\treplica\tdb2\tdb2_test\t3\t4\n`);
    const baseRoot = path.join(deliveryRoot, 'projects', 'forge-base', 'conversation-gateway');
    const copyRoot = path.join(deliveryRoot, 'projects', 'forge-copy', 'conversation-gateway');
    await mkdir(baseRoot, { recursive: true });
    await mkdir(copyRoot, { recursive: true });
    await writeFile(path.join(baseRoot, 'state.json'), JSON.stringify(state({ userId: 'base-admin', username: 'admin', role: 'admin', passwordHash: 'canonical-hash', conversationId: 'base-conversation', taskId: 'c-base-task' })));
    await writeFile(path.join(copyRoot, 'state.json'), JSON.stringify(state({ userId: 'copy-admin', username: 'admin', role: 'admin', passwordHash: 'other-salted-hash', conversationId: 'copy-conversation', taskId: 'c-copy-task' })));
    await writeFile(path.join(baseRoot, 'audit.jsonl'), '{"at":"2026-08-28T10:00:00Z","actor":"admin","action":"test"}\n');

    const first = await migrateConversationControlPlane({ deliveryRoot, targetStateRoot, canonicalProject: 'forge-base' });
    assert.equal(first.changed, true);
    assert.equal(first.users, 1);
    assert.equal(first.conversations, 2);
    assert.equal(first.collisions.length, 1);
    const migrated = JSON.parse(await readFile(path.join(targetStateRoot, 'state.json'), 'utf8'));
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.users[0].passwordHash, 'canonical-hash');
    assert.deepEqual(migrated.sessions, []);
    assert.deepEqual(migrated.memberships.map((entry) => entry.projectSlug).sort(), ['forge-base', 'forge-copy']);
    assert.deepEqual(migrated.conversations.map(({ projectSlug, ownerUserId }) => ({ projectSlug, ownerUserId })).sort((a, b) => a.projectSlug.localeCompare(b.projectSlug)), [
      { projectSlug: 'forge-base', ownerUserId: 'base-admin' },
      { projectSlug: 'forge-copy', ownerUserId: 'base-admin' },
    ]);
    assert.equal((await migrateConversationControlPlane({ deliveryRoot, targetStateRoot, canonicalProject: 'forge-base' })).changed, false);
  } finally {
    await rm(deliveryRoot, { recursive: true, force: true });
  }
});
