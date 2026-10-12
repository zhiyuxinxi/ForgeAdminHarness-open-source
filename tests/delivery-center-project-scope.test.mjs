import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDeliveryReadServer, createDeliveryCenterClient } from '../docker/harness/delivery-center-service.mjs';

test('single-project reader exposes forge-base equally to its callers and refuses other stored projects', async () => {
  const calls = [];
  const store = {
    listProjects: async () => [{ slug: 'forge-base', name: '示例客户' }, { slug: 'other-project', name: '其他项目' }],
    listRequirements: async (project) => { calls.push(project); return { items: [], total: 0, page: 1, pageSize: 50 }; },
    exportRequirements: async (project) => { calls.push(project); return []; },
  };
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\forge-dc-scope-${crypto.randomUUID()}` : path.join(os.tmpdir(), `dc-scope-${crypto.randomUUID()}.sock`);
  const server = createDeliveryReadServer({ store, projectSlug: 'forge-base' });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try {
    const client = createDeliveryCenterClient({ socketPath });
    assert.deepEqual((await client.listProjects()).map((row) => row.slug), ['forge-base']);
    await client.listRequirements('forge-base');
    await assert.rejects(client.listRequirements('other-project'), (error) => error.status === 404);
    await assert.rejects(client.exportRequirements('other-project'), (error) => error.status === 404);
    assert.deepEqual(calls, ['forge-base']);
    assert.throws(() => createDeliveryReadServer({ store, projectSlug: '../escape' }), /DELIVERY_PROJECT_SCOPE_INVALID/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
