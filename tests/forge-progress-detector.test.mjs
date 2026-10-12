import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ForgeProgressDetectorError,
  detectExecutionProgress,
} from '../docker/harness/forge-progress-detector.mjs';

const digest = (character) => `sha256:${character.repeat(64)}`;
const base = (overrides = {}) => ({
  phase: 'DISCOVER',
  counters: { requests: 3, toolCalls: 4, mutations: 0 },
  limits: { requests: 10, toolCalls: 12, mutations: 0 },
  requiredProgressKeys: ['owner', 'consumer-a', 'consumer-b'],
  observations: [
    { requestOrdinal: 1, toolCallOrdinal: 1, progressKeys: ['owner'] },
    { requestOrdinal: 2, toolCallOrdinal: 2, progressKeys: ['consumer-a'] },
    { requestOrdinal: 3, toolCallOrdinal: 4, progressKeys: ['consumer-b'] },
  ],
  ...overrides,
});

test('suspending heuristic stops preserves observations and permits remaining budget use', () => {
  for (const phase of ['DISCOVER', 'IMPLEMENT_INCREMENT']) {
    const decision = detectExecutionProgress(base({
      phase,
      suspendHeuristicStops: true,
      counters: { requests: 9, toolCalls: 8, mutations: 1 },
      limits: { requests: 10, toolCalls: 12, mutations: 4 },
      observations: [1, 2, 3, 4].map((ordinal) => ({
        requestOrdinal: ordinal, toolCallOrdinal: ordinal,
        actionDigest: digest('a'), resultDigest: digest('b'), progressKeys: [],
      })),
    }));
    assert.equal(decision.decision, 'CONTINUE');
    assert.equal(decision.currentNoProgressStreak, 4);
    assert.equal(decision.maximumRepeatedActionResultsObserved, 4);
    assert.equal(decision.remaining.requests, 1);
  }
});

test('suspended heuristics do not mask exhausted budgets or safety and capability blockers', () => {
  for (const dimension of ['requests', 'toolCalls', 'mutations']) {
    const counters = { requests: 3, toolCalls: 4, mutations: 1 };
    const limits = { requests: 10, toolCalls: 12, mutations: 4 };
    counters[dimension] = limits[dimension];
    const decision = detectExecutionProgress(base({
      phase: 'IMPLEMENT_INCREMENT', suspendHeuristicStops: true, counters, limits,
      observations: [1, 2, 3].map((ordinal) => ({ requestOrdinal: ordinal, toolCallOrdinal: ordinal, progressKeys: [] })),
    }));
    assert.equal(decision.decision, 'STOP');
    assert.deepEqual(decision.reasonCodes, ['PHASE_BUDGET_EXHAUSTED']);
  }
  const safety = detectExecutionProgress(base({ suspendHeuristicStops: true,
    observations: [{ requestOrdinal: 1, toolCallOrdinal: 1, safetyViolation: true }],
  }));
  assert.deepEqual(safety.reasonCodes, ['SAFETY_VIOLATION']);
  const capability = detectExecutionProgress(base({ suspendHeuristicStops: true,
    observations: [
      { requestOrdinal: 1, toolCallOrdinal: 1, dependencyBlocked: true },
      { requestOrdinal: 2, toolCallOrdinal: 2, capabilityProbe: true },
    ],
  }));
  assert.deepEqual(capability.reasonCodes, ['CAPABILITY_PROBE_AFTER_TYPED_BLOCKER']);
});

test('machine-observable obligation coverage continues within the phase budget', () => {
  const decision = detectExecutionProgress(base());
  assert.equal(decision.decision, 'CONTINUE');
  assert.deepEqual(decision.missingProgressKeys, []);
  assert.deepEqual(decision.reasonCodes, ['PROGRESS_WITHIN_BOUNDS']);
  assert.match(decision.digest, /^sha256:[0-9a-f]{64}$/u);
});

test('an incomplete discovery gate escalates only at a pre-mutation immutable boundary', () => {
  const decision = detectExecutionProgress(base({
    counters: { requests: 10, toolCalls: 11, mutations: 0 },
    observations: [
      { requestOrdinal: 1, toolCallOrdinal: 1, progressKeys: ['owner'] },
      { requestOrdinal: 2, toolCallOrdinal: 2, progressKeys: ['consumer-a'] },
    ],
  }));
  assert.equal(decision.decision, 'ESCALATE_AT_IMMUTABLE_BOUNDARY');
  assert.equal(decision.immutableBoundary, true);
  assert.deepEqual(decision.missingProgressKeys, ['consumer-b']);

  const dirty = detectExecutionProgress(base({
    counters: { requests: 10, toolCalls: 11, mutations: 1 },
    limits: { requests: 10, toolCalls: 12, mutations: 4 },
    observations: [{ requestOrdinal: 1, toolCallOrdinal: 1, progressKeys: ['owner'] }],
  }));
  assert.equal(dirty.decision, 'STOP');
  assert.equal(dirty.immutableBoundary, false);
});

test('repeated identical action results and no progress stop before the wall clock timeout', () => {
  const repeated = detectExecutionProgress(base({
    requiredProgressKeys: [],
    observations: [
      { requestOrdinal: 1, toolCallOrdinal: 1, actionDigest: digest('a'), resultDigest: digest('b') },
      { requestOrdinal: 2, toolCallOrdinal: 2, actionDigest: digest('a'), resultDigest: digest('b') },
    ],
  }));
  assert.equal(repeated.decision, 'STOP');
  assert.deepEqual(repeated.reasonCodes, ['REPEATED_ACTION_RESULT_NO_PROGRESS']);

  const stalled = detectExecutionProgress(base({
    requiredProgressKeys: [],
    observations: [1, 2, 3].map((ordinal) => ({
      requestOrdinal: ordinal, toolCallOrdinal: ordinal, progressKeys: [],
    })),
  }));
  assert.equal(stalled.decision, 'STOP');
  assert.deepEqual(stalled.reasonCodes, ['NO_MACHINE_OBSERVABLE_PROGRESS']);
});

test('pre-mutation discovery stagnation switches to implementation without becoming a hard stop', () => {
  const repeated = detectExecutionProgress(base({
    counters: { requests: 4, toolCalls: 5, mutations: 0 },
    limits: { requests: 10, toolCalls: 12, mutations: 4 },
    requiredProgressKeys: [],
    observations: [
      {
        requestOrdinal: 1,
        toolCallOrdinal: 1,
        progressKeys: ['source-fact:first'],
        actionDigest: digest('a'),
        resultDigest: digest('b'),
      },
      {
        requestOrdinal: 2,
        toolCallOrdinal: 2,
        actionDigest: digest('a'),
        resultDigest: digest('b'),
      },
    ],
  }));
  assert.equal(repeated.decision, 'SWITCH_TO_IMPLEMENT');
  assert.deepEqual(repeated.reasonCodes, ['REPEATED_ACTION_RESULT_NO_PROGRESS']);

  const stalled = detectExecutionProgress(base({
    counters: { requests: 4, toolCalls: 5, mutations: 0 },
    limits: { requests: 10, toolCalls: 12, mutations: 4 },
    requiredProgressKeys: [],
    observations: [1, 2, 3].map((ordinal) => ({
      requestOrdinal: ordinal,
      toolCallOrdinal: ordinal,
      progressKeys: [],
    })),
  }));
  assert.equal(stalled.decision, 'SWITCH_TO_IMPLEMENT');
  assert.deepEqual(stalled.reasonCodes, ['NO_MACHINE_OBSERVABLE_PROGRESS']);
});

test('new machine progress resets the local stagnation window while post-mutation stagnation remains hard', () => {
  const recovered = detectExecutionProgress(base({
    counters: { requests: 5, toolCalls: 5, mutations: 0 },
    limits: { requests: 10, toolCalls: 12, mutations: 4 },
    requiredProgressKeys: [],
    observations: [
      {
        requestOrdinal: 1,
        toolCallOrdinal: 1,
        progressKeys: ['source-fact:first'],
        actionDigest: digest('a'),
        resultDigest: digest('b'),
      },
      { requestOrdinal: 2, toolCallOrdinal: 2, progressKeys: [] },
      { requestOrdinal: 3, toolCallOrdinal: 3, progressKeys: [] },
      {
        requestOrdinal: 4,
        toolCallOrdinal: 4,
        progressKeys: ['source-fact:second'],
        actionDigest: digest('c'),
        resultDigest: digest('d'),
      },
      {
        requestOrdinal: 5,
        toolCallOrdinal: 5,
        actionDigest: digest('a'),
        resultDigest: digest('b'),
      },
    ],
  }));
  assert.equal(recovered.decision, 'CONTINUE');
  assert.equal(recovered.currentNoProgressStreak, 1);
  assert.equal(recovered.maximumRepeatedActionResultsObserved, 1);
  assert.equal(recovered.longestNoProgressStreak, 2);

  const dirty = detectExecutionProgress(base({
    phase: 'IMPLEMENT_INCREMENT',
    counters: { requests: 5, toolCalls: 5, mutations: 1 },
    limits: { requests: 10, toolCalls: 12, mutations: 4 },
    requiredProgressKeys: [],
    observations: [
      {
        requestOrdinal: 4,
        toolCallOrdinal: 4,
        progressKeys: ['mutation:first'],
        actionDigest: digest('e'),
        resultDigest: digest('f'),
      },
      {
        requestOrdinal: 5,
        toolCallOrdinal: 5,
        actionDigest: digest('e'),
        resultDigest: digest('f'),
      },
    ],
  }));
  assert.equal(dirty.decision, 'STOP');
  assert.deepEqual(dirty.reasonCodes, ['REPEATED_ACTION_RESULT_NO_PROGRESS']);
});

test('capability probing after a typed dependency blocker stops immediately', () => {
  const decision = detectExecutionProgress(base({
    requiredProgressKeys: [],
    observations: [
      { requestOrdinal: 1, toolCallOrdinal: 1, dependencyBlocked: true, progressKeys: ['blocker-receipt'] },
      { requestOrdinal: 2, toolCallOrdinal: 2, capabilityProbe: true },
    ],
  }));
  assert.equal(decision.decision, 'STOP');
  assert.deepEqual(decision.reasonCodes, ['CAPABILITY_PROBE_AFTER_TYPED_BLOCKER']);
});

test('closeout requests are reserved and safety violations override every softer outcome', () => {
  const reserve = detectExecutionProgress(base({
    phase: 'IMPLEMENT_INCREMENT',
    counters: { requests: 8, toolCalls: 6, mutations: 2 },
    limits: { requests: 10, toolCalls: 12, mutations: 6 },
    requiredProgressKeys: [],
    observations: [{ requestOrdinal: 8, toolCallOrdinal: 6, progressKeys: ['increment-a'] }],
  }));
  assert.equal(reserve.decision, 'RESERVE_CLOSEOUT');

  const unsafe = detectExecutionProgress(base({
    observations: [{
      requestOrdinal: 1, toolCallOrdinal: 1, safetyViolation: true, progressKeys: ['owner'],
    }],
  }));
  assert.equal(unsafe.decision, 'STOP');
  assert.deepEqual(unsafe.reasonCodes, ['SAFETY_VIOLATION']);
});

test('invalid progress evidence fails closed', () => {
  assert.throws(() => detectExecutionProgress(base({
    observations: [{ requestOrdinal: 1, toolCallOrdinal: 1, actionDigest: 'not-a-digest' }],
  })), (error) => error instanceof ForgeProgressDetectorError
    && error.code === 'PROGRESS_INPUT_INVALID');
});
