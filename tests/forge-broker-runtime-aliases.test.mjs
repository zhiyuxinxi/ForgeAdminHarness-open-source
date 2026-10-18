import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrokerAdmissionClient, createBrokerExecutionContextResolver } from '../docker/harness/forge-phase-budget-guard.mjs';
import { createBrokerPrepareTaskClient } from '../docker/harness/forge-prepare-task.mjs';
import { createBrokerWriterScopeLeaseClient } from '../docker/harness/forge-writer-scope-client.mjs';
import { createBrokerBusinessDataPreviewClient, createBrokerBusinessDataApplyClient } from '../docker/harness/forge-business-data-preview.mjs';

const options = {
  tokenFile: '/run/forge-taskspace/broker-token',
  projectSlug: 'runtime-fixture',
  taskId: 'runtime-fixture-task',
  conversationId: 'runtime-fixture-conversation',
  actorUserId: 'runtime-fixture-actor',
};

const clients = [
  ['admission', createBrokerAdmissionClient],
  ['execution context', createBrokerExecutionContextResolver],
  ['prepare task', createBrokerPrepareTaskClient],
  ['writer scope', createBrokerWriterScopeLeaseClient],
  ['business preview', createBrokerBusinessDataPreviewClient],
  ['business apply', createBrokerBusinessDataApplyClient],
  ['managed files', value => createBrokerBusinessDataPreviewClient({ ...value, action: 'managed-files' })],
];

for (const [name, create] of clients) {
  test(`${name} accepts the exact versioned Broker aliases and existing endpoints`, () => {
    for (const hostname of ['taskspace-broker-stable', 'taskspace-broker-enhanced', 'taskspace-broker', 'localhost', '127.0.0.1']) {
      assert.equal(typeof create({ ...options, brokerUrl: `http://${hostname}:3100` }), 'function', hostname);
    }
  });

  test(`${name} rejects other hosts and unsafe forms of versioned endpoints`, () => {
    for (const brokerUrl of [
      'http://external.example:3100',
      'http://taskspace-broker-other:3100',
      'http://taskspace-broker-stable.example:3100',
      'http://taskspace-broker-enhanced-other:3100',
      'http://192.0.2.148:3100',
      'https://taskspace-broker-stable:3100',
      'http://user:password@taskspace-broker-enhanced:3100',
      'http://taskspace-broker-stable:3100/other',
    ]) {
      assert.throws(() => create({ ...options, brokerUrl }), Error, brokerUrl);
    }
  });

  test(`${name} still requires the protected TaskSpace token path with a versioned endpoint`, () => {
    assert.throws(() => create({ ...options, brokerUrl: 'http://taskspace-broker-stable:3100', tokenFile: '/tmp/token' }));
  });
}
