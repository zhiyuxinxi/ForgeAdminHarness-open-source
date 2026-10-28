import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const { resolveTaskspaceTransport } = createRequire(import.meta.url)('../docker/harness/forge-release');
test('release transport retains a version-qualified internal origin and rejects lookalikes', () => {
  const environment = { FORGE_TASKSPACE_ID: 'task-one' };
  for (const channel of ['stable', 'enhanced']) {
    const url = `http://taskspace-broker-${channel}-r11:3100`;
    assert.equal(resolveTaskspaceTransport({ ...environment, FORGE_TASKSPACE_BROKER_URL: url }).brokerUrlValue, url);
  }
  for (const url of ['http://taskspace-broker-stable-r11:3100/evil', 'http://user@taskspace-broker-stable-r11:3100',
    'http://taskspace-broker-stable-r11.evil:3100', 'http://taskspace-broker-stable-r0:3100']) {
    assert.throws(() => resolveTaskspaceTransport({ ...environment, FORGE_TASKSPACE_BROKER_URL: url }));
  }
});
