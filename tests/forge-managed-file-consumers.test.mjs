import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskspaceBroker } from '../docker/harness/taskspace-broker.mjs';
import { validateTaskspaceAction } from '../docker/harness/taskspace-policy.mjs';
import { registerManagedFileTool } from '../docker/harness/forge-managed-file-tool.mjs';

test('managed file targets and tool use the authenticated Broker DTO without model authority fields', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'managed-file-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actor = '11111111-1111-4111-8111-111111111111';
  const config = { schemaVersion: 1, projectSlug: 'forge-project', targets: [{ targetId: 'site', name: 'Site', transport: 'local',
    serverDirectory: '/data/site', expectedDevice: 1, expectedInode: 2, readActorIds: [actor], writeActorIds: [] }] };
  const broker = new TaskspaceBroker({ projectRoot: root, projectSlug: 'forge-project', managedFileTargets: () => config });
  const task = { metadata: { actorUserId: actor, status: 'active', accessMode: 'conversation' } };
  const listed = await broker.executeForTask(task, { action: 'managed-files', operation: 'targets' });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.targets, [{ targetId: 'site', name: 'Site', transport: 'local', server: 'current-host',
    serverDirectory: '/data/site', toolPath: 'managed_file:site/', read: true, write: false,
    scope: 'explicit-task', requiresExplicitRequest: true }]);
  assert.deepEqual((await broker.executeForTask({ metadata: { ...task.metadata, actorUserId: 'other' } },
    { action: 'managed-files', operation: 'targets' })).targets, []);
  const context = { projectSlug: 'forge-project', taskId: 'task-001', actorUserId: actor, conversationId: 'conversation-001',
    dshSessionId: 'session-001', rpcId: 'rpc-001', textDigest: 'a'.repeat(64), executionId: actor, generation: 1 };
  let tool; let body;
  registerManagedFileTool({ tools: { register(value) { tool = value; } } }, value => value, {
    resolveContext: () => context, client: async value => { body = validateTaskspaceAction(value); return listed; },
  });
  assert.deepEqual(await tool.execute({ operation: 'targets' }, {}), listed);
  await tool.execute({ operation: 'read', targetId: 'site', relativePath: 'index.html' }, { agent: { session: { id: context.dshSessionId } } });
  assert.equal(body.lookup.rpcId, context.rpcId);
  assert.equal(Object.hasOwn(body, 'promptText'), false);
  assert.equal(Object.hasOwn(body, 'serverDirectory'), false);
  await assert.rejects(tool.execute({ operation: 'write', targetId: 'site', relativePath: 'index.html',
    expectedVersion: 'absent', content: 'hello', authorized: true }, {}), { code: 'MANAGED_FILE_SCHEMA' });
  assert.throws(() => validateTaskspaceAction({ action: 'managed-files', operation: 'targets', targetId: 'invented' }));
});
