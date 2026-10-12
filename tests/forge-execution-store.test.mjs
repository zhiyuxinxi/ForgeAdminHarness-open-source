import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ForgeExecutionStore,
  ForgeExecutionStoreError,
} from '../docker/harness/forge-execution-store.mjs';
import { executionSha256 } from '../docker/harness/forge-execution-state.mjs';

const SHA = (character) => character.repeat(64);
const TIME = (minute) => `2026-09-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

function initialStateInput(overrides = {}) {
  return {
    executionId: 'execution-store-001',
    projectSlug: 'forge-admin-harness',
    taskId: 'task-store-001',
    contractId: SHA('a'),
    registryDigest: SHA('b'),
    actionCeiling: 'read-only',
    tddRequired: false,
    requiredSkills: ['forge-task-router'],
    requiredProfiles: [],
    criteria: ['criterion-1'],
    sourceFingerprint: SHA('c'),
    createdAt: TIME(0),
    ...overrides,
  };
}

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-execution-store-'));
  try {
    return await run(new ForgeExecutionStore({ root }), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function expectCode(code, action) {
  return assert.rejects(action, (error) => error instanceof ForgeExecutionStoreError && error.code === code);
}

test('append-only execution events use revision and generation CAS and replay deterministically', async () => {
  await withStore(async (store) => {
    let snapshot = await store.create({ generation: 7, initialStateInput: initialStateInput() });
    assert.equal(snapshot.revision, 0);
    snapshot = await store.appendCheckpoint({
      executionId: snapshot.state.executionId,
      expectedGeneration: 7,
      expectedRevision: 0,
      eventId: 'event-prepared',
      payload: { stage: 'prepared', result: { outcome: 'ready' } },
      recordedAt: TIME(1),
    });
    assert.equal(snapshot.revision, 1);
    const stateDigest = executionSha256(snapshot.state);

    const replayed = await store.read(snapshot.state.executionId);
    assert.equal(replayed.revision, 1);
    assert.equal(executionSha256(replayed.state), stateDigest);
    assert.deepEqual(replayed.events, snapshot.events);

    const idempotent = await store.appendCheckpoint({
      executionId: snapshot.state.executionId,
      expectedGeneration: 7,
      expectedRevision: 0,
      eventId: 'event-prepared',
      payload: { stage: 'prepared', result: { outcome: 'ready' } },
      recordedAt: TIME(2),
    });
    assert.equal(idempotent.idempotent, true);
    assert.equal(idempotent.revision, 1);

    await expectCode('EXECUTION_STORE_EVENT_CONFLICT', () => store.appendCheckpoint({
      executionId: snapshot.state.executionId,
      expectedGeneration: 7,
      expectedRevision: 1,
      eventId: 'event-prepared',
      payload: { stage: 'prepared', result: { outcome: 'blocked' } },
      recordedAt: TIME(2),
    }));
    await expectCode('EXECUTION_STORE_GENERATION_CONFLICT', () => store.appendCheckpoint({
      executionId: snapshot.state.executionId,
      expectedGeneration: 8,
      expectedRevision: 1,
      eventId: 'event-generation-conflict',
      payload: { stage: 'next', result: { outcome: 'ready' } },
      recordedAt: TIME(2),
    }));
    await expectCode('EXECUTION_STORE_REVISION_CONFLICT', () => store.appendCheckpoint({
      executionId: snapshot.state.executionId,
      expectedGeneration: 7,
      expectedRevision: 0,
      eventId: 'event-revision-conflict',
      payload: { stage: 'next', result: { outcome: 'ready' } },
      recordedAt: TIME(2),
    }));
  });
});
test('typed stop is append-only and preserves a verifiable reducer stop receipt', async () => {
  await withStore(async (store) => {
    const created = await store.create({ generation: 1, initialStateInput: initialStateInput() });
    const stopped = await store.appendStop({
      executionId: created.state.executionId,
      expectedGeneration: 1,
      expectedRevision: 0,
      eventId: 'event-platform-stop',
      payload: {
        outcome: 'BOUNDED_BLOCKED',
        observedAt: TIME(1),
        openCriteria: ['criterion-1'],
        failure: {
          failureClass: 'CAPABILITY_HARD',
          code: 'VERIFY_CACHE_MISS',
          resolutionAuthority: 'platform-operator',
          attemptKey: 'capability:cache',
        },
      },
      recordedAt: TIME(1),
    });
    assert.equal(stopped.state.terminalOutcome, 'BOUNDED_BLOCKED');
    assert.equal(stopped.state.stopReceipt.schemaVersion, 'forge-execution/stop/v1');
    assert.equal(stopped.state.stopReceipt.failure.code, 'VERIFY_CACHE_MISS');
    assert.equal(stopped.state.stopReceipt.truth.implemented, false);
    const replayed = await store.read(created.state.executionId);
    assert.deepEqual(replayed.state.stopReceipt, stopped.state.stopReceipt);
  });
});

test('event tampering is rejected during deterministic replay', async () => {
  await withStore(async (store, root) => {
    const created = await store.create({ generation: 1, initialStateInput: initialStateInput() });
    await store.appendCheckpoint({
      executionId: created.state.executionId,
      expectedGeneration: 1,
      expectedRevision: 0,
      eventId: 'event-tamper-target',
      payload: { stage: 'prepared', result: { outcome: 'ready' } },
      recordedAt: TIME(1),
    });
    const eventPath = path.join(root, created.state.executionId, 'events', '000000000001.json');
    const event = JSON.parse(await readFile(eventPath, 'utf8'));
    event.payload.result.outcome = 'blocked';
    await writeFile(eventPath, `${JSON.stringify(event)}\n`, 'utf8');
    await expectCode('EXECUTION_STORE_EVENT_TAMPERED', () => store.read(created.state.executionId));
  });
});
