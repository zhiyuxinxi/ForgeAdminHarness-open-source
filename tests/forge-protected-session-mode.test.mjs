import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FORGE_PROTECTED_RECOVERY_MODE,
  inspectForgeProtectedRecoveryReadback,
  openForgeProtectedAgent,
  resolveForgeProtectedRecoveryMode,
  resolveForgeProtectedSessionMode,
} from '../docker/harness/forge-protected-session-mode.mjs';

test('protected session mode defaults to create and rejects unreviewed modes', () => {
  assert.equal(resolveForgeProtectedSessionMode(undefined), 'create');
  assert.equal(resolveForgeProtectedSessionMode('resume'), 'resume');
  assert.throws(() => resolveForgeProtectedSessionMode('continue'), /must be create or resume/u);
});

test('protected recovery mode is explicit and session readback proves one exact RPC is absent', () => {
  assert.equal(resolveForgeProtectedRecoveryMode(undefined), null);
  assert.equal(resolveForgeProtectedRecoveryMode(FORGE_PROTECTED_RECOVERY_MODE), FORGE_PROTECTED_RECOVERY_MODE);
  assert.throws(() => resolveForgeProtectedRecoveryMode('refresh'), /must be expired-unsubmitted/u);
  const readback = inspectForgeProtectedRecoveryReadback({
    events: [
      { type: 'turn/start', seq: 10, data: { turn: 1 } },
      {
        type: 'user/message', seq: 11,
        data: { message: { source: { kind: 'user', rpcId: 'prior-rpc' } } },
      },
      { type: 'turn/end', seq: 12, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
    sessionId: 'session-1',
    rpcId: 'generation-28-rpc',
    textDigest: 'a'.repeat(64),
    observedSeq: 12,
    sessionObserved: true,
    historyComplete: true,
    observedAt: '2026-09-05T00:00:00.000Z',
  });
  assert.equal(readback.requestObserved, false);
  assert.equal(readback.turnOpen, false);
  assert.match(readback.eventDigest, /^[0-9a-f]{64}$/u);
  assert.throws(() => inspectForgeProtectedRecoveryReadback({
    events: [{ type: 'turn/end', seq: 12, data: { turn: 1 } }],
    sessionId: 'session-1',
    rpcId: 'generation-28-rpc',
    textDigest: 'a'.repeat(64),
    observedSeq: 13,
    sessionObserved: true,
    historyComplete: true,
    observedAt: '2026-09-05T00:00:00.000Z',
  }), /does not close/u);
  assert.throws(() => inspectForgeProtectedRecoveryReadback({
    events: [],
    sessionId: 'session-1',
    rpcId: 'generation-28-rpc',
    textDigest: 'a'.repeat(64),
    observedSeq: 0,
    sessionObserved: false,
    historyComplete: true,
    observedAt: '2026-09-05T00:00:00.000Z',
  }), /input is invalid/u);
});

test('protected recovery readback rejects an existing RPC and an open turn', () => {
  const common = {
    sessionId: 'session-1',
    rpcId: 'generation-28-rpc',
    textDigest: 'b'.repeat(64),
    sessionObserved: true,
    historyComplete: true,
    observedAt: '2026-09-05T00:00:00.000Z',
  };
  assert.throws(() => inspectForgeProtectedRecoveryReadback({
    ...common,
    observedSeq: 20,
    events: [{
      type: 'user/message', seq: 20,
      data: { source: { kind: 'user', rpcId: 'generation-28-rpc' } },
    }],
  }), /already present/u);
  assert.throws(() => inspectForgeProtectedRecoveryReadback({
    ...common,
    observedSeq: 21,
    events: [{ type: 'turn/start', seq: 21, data: { turn: 2 } }],
  }), /open turn/u);
});

test('first phase creates a session with cwd metadata', async () => {
  const calls = [];
  const result = await openForgeProtectedAgent({
    agents: {
      create: async (options) => { calls.push(['create', options]); return { agent: 'created' }; },
      resume: async (options) => { calls.push(['resume', options]); return { agent: 'resumed' }; },
    },
    sessionMode: 'create',
    sessionId: 'session-1',
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    setup() {},
  });
  assert.deepEqual(result, { agent: 'created' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'create');
  assert.equal(calls[0][1].sessionId, 'session-1');
  assert.equal(calls[0][1].meta.cwd, process.cwd());
  assert.equal(calls[0][1].resumeSessionId, undefined);
});

test('later phases resume the exact persisted session without create metadata', async () => {
  const calls = [];
  const result = await openForgeProtectedAgent({
    agents: {
      create: async (options) => { calls.push(['create', options]); return { agent: 'created' }; },
      resume: async (options) => { calls.push(['resume', options]); return { agent: 'resumed' }; },
    },
    sessionMode: 'resume',
    sessionId: 'session-1',
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    setup() {},
  });
  assert.deepEqual(result, { agent: 'resumed' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'resume');
  assert.equal(calls[0][1].resumeSessionId, 'session-1');
  assert.equal(calls[0][1].sessionId, undefined);
  assert.equal(calls[0][1].meta, undefined);
});
