import assert from 'node:assert/strict';
import test from 'node:test';
import {
  installControlledDeliveryConcurrency,
  isControlledDeliveryConcurrencySafe,
} from '../docker/harness/forge-phase-budget-guard.mjs';

const command = '/usr/local/bin/forge-delivery change transition --change test-change --to designed --expected-version 1 --idempotency-key writer-a';

test('only exact locked CAS metadata transitions gain concurrent scheduling', () => {
  for (const args of [{ command }, { command, workdir: '/workspace', description: '推进状态', timeoutMs: 5000 },
    { command: command.replace('/usr/local/bin/forge-delivery', 'forge-delivery'), workdir: '.', run_in_background: false }]) {
    assert.equal(isControlledDeliveryConcurrencySafe(args), true);
  }
  for (const args of [null, [], {}, { command: 'echo hello' }, { command: command + '; echo bad' },
    { command: command.replace('--expected-version 1', '--expected-version 0') },
    { command: command.replace('--expected-version 1 ', '') },
    { command: command.replace('designed', 'evidence-recorded') },
    { command: command + ' --verification record-1' },
    { command, workdir: '/other' }, { command, run_in_background: true },
    { command, sandbox_permissions: 'require_escalated' }, { command, justification: 'test' },
    { command, env: {} }, { command: 'forge-delivery change status --change test-change' },
    { command: 'forge-delivery change init --change test-change --objective test --idempotency-key init-a' },
    { command: 'forge-release checkpoint --message update' },
  ]) assert.equal(isControlledDeliveryConcurrencySafe(args), false, JSON.stringify(args));
});

test('native definition hint is idempotent and disposal preserves other policy owners', () => {
  const handlers = new Map();
  const original = args => args.command === 'existing-safe-operation';
  const tool = { name: 'bash', isConcurrencySafe: original, execute: () => 'original-body' };
  let current = tool;
  const ctx = {
    tools: { get: name => name === 'bash' ? current : undefined },
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => handlers.get(name).delete(fn);
    },
  };
  const dispose = installControlledDeliveryConcurrency(ctx);
  const wrapper = tool.isConcurrencySafe;
  const duplicateDispose = installControlledDeliveryConcurrency(ctx);
  assert.equal(tool.isConcurrencySafe, wrapper);
  assert.equal(wrapper({ command }), true);
  assert.equal(wrapper({ command: 'existing-safe-operation' }), true);
  assert.equal(wrapper({ command: 'echo not-supported' }), false);
  assert.equal(tool.execute(), 'original-body');
  duplicateDispose();
  assert.equal(tool.isConcurrencySafe, wrapper);
  current = { name: 'bash' };
  for (const fn of handlers.get('tools/change')) fn();
  assert.equal(current.isConcurrencySafe({ command }), true);
  dispose();
  assert.equal(tool.isConcurrencySafe, original);
  assert.equal(Object.hasOwn(current, 'isConcurrencySafe'), false);
  dispose();
});

test('late bash registration is decorated and a later policy replacement survives cleanup', () => {
  const handlers = new Map();
  let tool;
  const ctx = { tools: { get: () => tool }, on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } };
  const dispose = installControlledDeliveryConcurrency(ctx);
  tool = { name: 'bash' };
  handlers.get('tools/change')();
  assert.equal(tool.isConcurrencySafe({ command }), true);
  const replacement = () => false;
  tool.isConcurrencySafe = replacement;
  dispose();
  assert.equal(tool.isConcurrencySafe, replacement);
});

test('agent preset scoped bash gains its hint before model tool scheduling', async () => {
  const handlers = new Map();
  const agent = {};
  const scoped = { name: 'bash' };
  const ctx = {
    tools: { get: (name, scope) => name === 'bash' && scope === agent ? scoped : undefined },
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
  };
  const dispose = installControlledDeliveryConcurrency(ctx);
  const decision = { kind: 'continue' };
  const next = async () => decision;
  assert.equal(await handlers.get('agent/pre-step')({ agent }, next), decision);
  assert.equal(scoped.isConcurrencySafe({ command }), true);
  assert.equal(scoped.isConcurrencySafe({ command: 'echo unsafe' }), false);
  const wrapper = scoped.isConcurrencySafe;
  await handlers.get('agent/pre-step')({ agent }, next);
  assert.equal(scoped.isConcurrencySafe, wrapper);
  dispose();
  assert.equal(Object.hasOwn(scoped, 'isConcurrencySafe'), false);
  assert.equal(handlers.has('agent/pre-step'), false);
});
