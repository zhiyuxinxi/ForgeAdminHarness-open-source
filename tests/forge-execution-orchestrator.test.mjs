import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ForgeExecutionOrchestratorError,
  createForgeExecutionOrchestrator,
} from '../docker/harness/forge-execution-orchestrator.mjs';
import { ForgeExecutionStore } from '../docker/harness/forge-execution-store.mjs';

const SHA = (character) => character.repeat(64);
const TIME = (minute) => `2026-09-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
const ADMISSION_ID = '123e4567-e89b-12d3-a456-426614174099';

function input(overrides = {}) {
  return {
    executionId: 'execution-orchestrator-001',
    projectSlug: 'forge-admin-harness',
    taskId: 'task-orchestrator-001',
    contractId: SHA('a'),
    registryDigest: SHA('b'),
    actionCeiling: 'read-only',
    tddRequired: false,
    requiredSkills: ['forge-task-router'],
    requiredProfiles: ['backend-module-test'],
    criteria: ['criterion-1'],
    sourceFingerprint: SHA('c'),
    createdAt: TIME(0),
    ...overrides,
  };
}

function admissionReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    receiptType: 'forge-verify/execution-admission',
    admissionId: ADMISSION_ID,
    projectSlug: 'forge-admin-harness',
    taskId: 'task-orchestrator-001',
    runner: {
      bootId: '123e4567-e89b-12d3-a456-426614174100',
      revision: 'vpn-orchestrator-test',
    },
    profiles: ['backend-module-test'],
    source: {
      head: '1'.repeat(40),
      workspaceFingerprint: SHA('c'),
      dependencyManifestFingerprint: SHA('d'),
    },
    cache: {
      mode: 'project-scoped-immutable-pack',
      compatible: true,
      packDigest: SHA('e'),
    },
    executor: {
      proven: true,
      dockerApiProven: true,
      toolchainImageProven: true,
      samePathBindProven: true,
      stateWriteProven: true,
      cleanupProven: true,
    },
    issuedAt: TIME(0),
    expiresAt: TIME(10),
    outcome: 'ready',
    reasonCode: null,
    truth: {
      executionProven: false,
      verificationProven: false,
      semanticCorrectnessProven: false,
      databaseIntegrationProven: false,
      releaseProven: false,
    },
    ...overrides,
  };
}

async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-orchestrator-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function adapters(log, overrides = {}) {
  return {
    prepare: async () => {
      log.push('prepare');
      return { generation: 3, initialStateInput: input() };
    },
    negotiate: async () => {
      log.push('negotiate');
      return {
        schemaVersion: 1,
        negotiationType: 'forge-execution/capability-negotiation',
        outcome: 'READY',
        negotiationDigest: `sha256:${SHA('f')}`,
        blockingGaps: [],
      };
    },
    admit: async () => {
      log.push('admit');
      return { outcome: 'ready', receipt: admissionReceipt() };
    },
    route: async () => {
      log.push('route');
      return { outcome: 'ready', routeId: 'route-read-only', observedSkills: ['forge-task-router'] };
    },
    ...overrides,
  };
}

test('orchestrator invokes prepare -> negotiate -> admit -> route before entering reducer discovery', async () => {
  await withRoot(async (root) => {
    const log = [];
    const orchestrator = createForgeExecutionOrchestrator({
      store: new ForgeExecutionStore({ root }),
      ...adapters(log),
      clock: () => TIME(1),
    });
    const result = await orchestrator.run({ requestId: 'request-001' });
    assert.deepEqual(log, ['prepare', 'negotiate', 'admit', 'route']);
    assert.deepEqual(result.callOrder, ['prepare', 'negotiate', 'admit', 'route']);
    assert.equal(result.outcome, 'ready');
    assert.equal(result.snapshot.state.phase, 'DISCOVER');
    assert.equal(result.snapshot.state.admission.admissionId, ADMISSION_ID);
    assert.equal(result.snapshot.state.actionCeiling, 'read-only');
    assert.deepEqual(
      result.snapshot.events.filter((event) => event.operation === 'checkpoint')
        .map((event) => event.payload.stage),
      ['prepared', 'negotiated', 'admitted', 'routed'],
    );
  });
});

test('capability negotiation blocker stops before admission and route with zero mutations', async () => {
  await withRoot(async (root) => {
    const log = [];
    const base = adapters(log);
    const orchestrator = createForgeExecutionOrchestrator({
      store: new ForgeExecutionStore({ root }),
      ...base,
      negotiate: async () => {
        log.push('negotiate');
        return {
          outcome: 'BOUNDED_BLOCKED',
          failureClass: 'CAPABILITY_HARD',
          reasonCode: 'VERIFY_CACHE_MISS',
          resolutionAuthority: 'platform-operator',
        };
      },
      clock: () => TIME(1),
    });
    const result = await orchestrator.run({ requestId: 'request-001' });
    assert.deepEqual(log, ['prepare', 'negotiate']);
    assert.equal(result.outcome, 'BOUNDED_BLOCKED');
    assert.equal(result.snapshot.state.budgets.used.mutations, 0);
    assert.equal(result.snapshot.state.stopReceipt.failure.code, 'VERIFY_CACHE_MISS');
    assert.equal(result.snapshot.state.stopReceipt.truth.implemented, false);
  });
});

test('an untyped optimistic negotiation cannot cross the admission boundary', async () => {
  await withRoot(async (root) => {
    const log = [];
    const base = adapters(log);
    const orchestrator = createForgeExecutionOrchestrator({
      store: new ForgeExecutionStore({ root }),
      ...base,
      negotiate: async () => {
        log.push('negotiate');
        return { outcome: 'ready', negotiationId: 'caller-asserted-ready' };
      },
      clock: () => TIME(1),
    });
    const result = await orchestrator.run({ requestId: 'request-001' });
    assert.deepEqual(log, ['prepare', 'negotiate']);
    assert.equal(result.outcome, 'BOUNDED_BLOCKED');
    assert.equal(result.snapshot.state.budgets.used.mutations, 0);
  });
});

test('orchestrator replay reuses durable checkpoints instead of repeating negotiation, admission, or route', async () => {
  await withRoot(async (root) => {
    const log = [];
    const orchestrator = createForgeExecutionOrchestrator({
      store: new ForgeExecutionStore({ root }),
      ...adapters(log),
      clock: () => TIME(1),
    });
    const first = await orchestrator.run({ requestId: 'request-001' });
    const revision = first.snapshot.revision;
    const second = await orchestrator.run({ requestId: 'request-001' });
    assert.deepEqual(log, ['prepare', 'negotiate', 'admit', 'route', 'prepare']);
    assert.deepEqual(second.callOrder, ['prepare']);
    assert.equal(second.snapshot.revision, revision);
    assert.equal(second.snapshot.state.phase, 'DISCOVER');
  });
});

test('minimal orchestrator refuses writer state before capability negotiation', async () => {
  await withRoot(async (root) => {
    const log = [];
    const base = adapters(log);
    const orchestrator = createForgeExecutionOrchestrator({
      store: new ForgeExecutionStore({ root }),
      ...base,
      prepare: async () => {
        log.push('prepare');
        return { generation: 1, initialStateInput: input({ actionCeiling: 'workspace-write' }) };
      },
      clock: () => TIME(1),
    });
    await assert.rejects(
      () => orchestrator.run({ requestId: 'request-001' }),
      (error) => error instanceof ForgeExecutionOrchestratorError
        && error.code === 'EXECUTION_WRITER_DISABLED',
    );
    assert.deepEqual(log, ['prepare']);
  });
});
