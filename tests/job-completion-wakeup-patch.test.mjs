import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { patchJobCompletionWakeup } from '../docker/harness/forge-job-completion-wakeup-patch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.FORGE_TEST_NATIVE_RUNTIME || resolve(root, 'tmp/runtime-deps-ci');
const nativeRequire = createRequire(resolve(runtime, 'package.json'));
let native;
try {
  const modulePath = nativeRequire.resolve('@deepseek-ai/dsh-tool-jobs');
  const source = await readFile(modulePath, 'utf8');
  const pkg = JSON.parse(await readFile(nativeRequire.resolve('@deepseek-ai/dsh-tool-jobs/package.json'), 'utf8'));
  assert.equal(pkg.version, '0.1.1-rc.2');
  const patched = patchJobCompletionWakeup(source);
  // Resolve the shipped package imports without editing its installed files.
  const importable = patched.replace(/^import (.+) from "([^"]+)";$/gmu,
    (_match, binding, name) => `import ${binding} from ${JSON.stringify(pathToFileURL(nativeRequire.resolve(name)).href)};`);
  const controller = await import(`data:text/javascript;base64,${Buffer.from(importable).toString('base64')}`);
  const { LocalJobRegistry } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-jobs-local')).href);
  native = { ...controller, LocalJobRegistry, source, patched };
} catch (error) {
  if (process.env.FORGE_TEST_NATIVE_RUNTIME || error.code !== 'MODULE_NOT_FOUND') throw error;
}

function controller(config = {}) {
  const listeners = new Map();
  let done;
  const ctx = {
    on(name, listener) { listeners.set(name, listener); },
    jobs: { attachController() {}, onJobDone(listener) { done = listener; } },
    tools: { register() {} },
    systemPrompt: { section() {} },
  };
  native.apply(ctx, native.Config(config));
  return { done, listeners };
}

function owner(status = 'idle') {
  return {
    id: 'session-wakeup-regression', status, wakes: [], contexts: [],
    followup(message) { this.wakes.push(message); },
    inject(message) { this.contexts.push(message); },
  };
}

function snapshot(index, extra = {}) {
  return { id: `bash-${index}`, kind: 'bash', label: `forge-verify watch --job-id fixture-${index}`,
    status: 'completed', detail: 'exit code: 0', reported: false, ...extra };
}

test('pinned native job controller wakes for the fourth and fifth completed jobs by default', { skip: !native }, () => {
  const consumer = controller();
  const agent = owner();
  assert.equal(native.Config({}).maxConsecutiveWakes, undefined);
  for (let index = 1; index <= 5; index += 1) consumer.done(snapshot(index), agent);
  assert.equal(agent.wakes.length, 5);
  assert.equal(agent.contexts.length, 0);
  assert.match(agent.wakes[4].content[0].text, /background job bash-5/);
});

test('explicit wake caps, busy injection and quiet delivery retain their native behavior', { skip: !native }, () => {
  const capped = controller({ maxConsecutiveWakes: 3 });
  const agent = owner();
  for (let index = 1; index <= 4; index += 1) capped.done(snapshot(index), agent);
  assert.equal(agent.wakes.length, 3);
  assert.equal(agent.contexts.length, 1);
  capped.listeners.get('agent/inbox/claimed')({ agent, message: { source: { kind: 'user' } } });
  capped.done(snapshot(5), agent);
  assert.equal(agent.wakes.length, 4);
  assert.throws(() => controller({ maxConsecutiveWakes: Infinity }), /whole number/);

  for (const [config, status] of [[{}, 'running'], [{ completionDelivery: 'quiet' }, 'idle']]) {
    const target = owner(status);
    controller(config).done(snapshot(1), target);
    assert.equal(target.wakes.length, 0);
    assert.equal(target.contexts.length, 1);
  }
});

test('native settlement remains once-only and cancelled or reported jobs do not wake', { skip: !native }, () => {
  const consumer = controller();
  const agent = owner();
  const registry = Object.create(native.LocalJobRegistry.prototype);
  registry.store = new Map();
  registry.listenersClosed = false;
  registry.listenersFor = () => [consumer.done];
  registry.notifyChanged = () => {};
  registry.selfCtx = { logger: { warn(message) { assert.fail(message); } } };
  let cancellations = 0;
  const job = (index) => ({ ...snapshot(index), owner: agent, status: 'running', waiters: 0,
    waitResolvers: new Set(), markSettled() {}, cancel() { cancellations += 1; } });
  const completed = job(1);
  registry.settle(completed, { status: 'completed', detail: 'exit code: 0' });
  registry.settle(completed, { status: 'completed', detail: 'late duplicate' });
  assert.equal(agent.wakes.length, 1);

  const cancelled = job(2);
  registry.store.set(cancelled.id, cancelled);
  assert.equal(registry.kill(cancelled.id, agent), 'requested');
  registry.settle(cancelled, { status: 'killed' });
  consumer.done(snapshot(3, { reported: true }), agent);
  consumer.done(snapshot(4), undefined);
  assert.equal(cancellations, 1);
  assert.equal(agent.wakes.length, 1);
  assert.equal(agent.contexts.length, 0);
});

test('native wakeup patch is idempotent and rejects incomplete or changed controller anchors', { skip: !native }, () => {
  const patched = native.patched;
  assert.equal(patchJobCompletionWakeup(patched), patched);
  assert.throws(() => patchJobCompletionWakeup(patched.replace('config.maxConsecutiveWakes ?? Infinity', 'config.maxConsecutiveWakes ?? 3')),
    /Incomplete/);
  assert.throws(() => patchJobCompletionWakeup(patched.replace('maxConsecutiveWakes: z.number().min(1)', 'maxConsecutiveWakes: z.number().min(1).default(3)')),
    /Incomplete/);
  assert.throws(() => patchJobCompletionWakeup(native.source + native.source), /Incomplete|Unsupported/);
});
