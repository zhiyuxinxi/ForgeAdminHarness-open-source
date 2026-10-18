import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyPatch, patchCodexOverload } from '../docker/harness/forge-codex-overload-patch.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.FORGE_TEST_NATIVE_RUNTIME || resolve(repository, 'tmp/runtime-deps-ci');
const directory = resolve(runtime, 'node_modules/@deepseek-ai/dsh-llm-pi-ai');
const packageBytes = await readFile(join(directory, 'package.json'));
const pkg = JSON.parse(packageBytes);
assert.equal(pkg.name, '@deepseek-ai/dsh-llm-pi-ai');
assert.equal(pkg.version, '0.1.1-rc.2');
const adapterPath = join(directory, 'lib/index.js');
const source = await readFile(adapterPath, 'utf8');
const patched = patchCodexOverload(source);
if (process.env.FORGE_TEST_INSTALLED_OVERLOAD_PATCH === '1') {
  assert.equal(patched, source, 'the image adapter must already contain the patch');
}
const require = createRequire(adapterPath);
const { resolveRetryPolicy } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const { apply: installRetry } = await import(pathToFileURL(resolve(runtime, 'node_modules/@deepseek-ai/dsh-llm-retry/lib/index.js')));
const observedOverload = 'Codex error: Our servers are currently overloaded. Please try again later.';

async function actualAdapter(t) {
  const temporary = await mkdtemp(join(os.tmpdir(), 'forge-codex-overload-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  // Native ESM resolution consumes the pinned dependency tree without rewriting imports.
  await symlink(resolve(runtime, 'node_modules'), join(temporary, 'node_modules'), 'junction');
  const file = join(temporary, 'adapter.mjs');
  await writeFile(file, `${patched}\nexport { toStreamChunks };\n`);
  return (await import(pathToFileURL(file))).toStreamChunks;
}

async function terminalFailure(toStreamChunks, errorMessage) {
  const error = { role: 'assistant', provider: 'openai-codex', model: 'gpt-5.6-sol',
    content: [], stopReason: 'error', errorMessage,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const chunks = [];
  for await (const chunk of toStreamChunks([{ type: 'error', error }], 128000)) chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.kind, 'error');
  return chunks.at(-1).reason.failure;
}

test('Codex overload patch installs on a copy and rejects package or source drift', async t => {
  const temporary = await mkdtemp(join(os.tmpdir(), 'forge-codex-overload-install-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const target = join(temporary, '@deepseek-ai/dsh-llm-pi-ai');
  await mkdir(join(target, 'lib'), { recursive: true });
  await writeFile(join(target, 'package.json'), packageBytes);
  await writeFile(join(target, 'lib/index.js'), source);
  assert.deepEqual(applyPatch(temporary), { patch: 'forge-codex-overload-v1', changed: source !== patched });
  assert.equal(await readFile(join(target, 'lib/index.js'), 'utf8'), patched);
  assert.equal(applyPatch(temporary).changed, false);
  await writeFile(join(target, 'package.json'), JSON.stringify({ ...pkg, version: 'unknown' }));
  assert.throws(() => applyPatch(temporary), /Unsupported pi-ai adapter package/);
  assert.throws(() => patchCodexOverload('unknown source'), /Unsupported/);
  assert.throws(() => patchCodexOverload(source + source), /Unsupported|Incomplete/);
  assert.throws(() => patchCodexOverload(patched.replace(observedOverload, 'different error')), /Incomplete/);
  assert.equal(await readFile(adapterPath, 'utf8'), source, 'shared runtime remains unchanged');
});

test('the actual pi-ai stream maps only the observed transient Codex overload to SERVER', async t => {
  const adapter = await actualAdapter(t);
  const policy = resolveRetryPolicy();
  const failure = await terminalFailure(adapter, observedOverload);
  assert.deepEqual(failure, { message: observedOverload, code: 'SERVER' });
  assert.equal(policy.retryableCodes.includes(failure.code), true);
  for (const message of [
    'Codex error: 401 Unauthorized',
    'Codex error: 403 Forbidden',
    'Codex error: The gpt-5.6-sol model is not supported when using Codex with a ChatGPT account.',
    'Codex error: Monthly usage limit reached',
    'Codex error: 400 invalid request',
    'Codex error: An unrelated provider failure',
    `${observedOverload} 401 Unauthorized`,
  ]) {
    const permanent = await terminalFailure(adapter, message);
    assert.notEqual(permanent.code, 'SERVER', message);
    assert.equal(policy.retryableCodes.includes(permanent.code), false, message);
  }
});

test('the observed overload uses the existing finite retry budget and respects cancellation', async t => {
  const failure = await terminalFailure(await actualAdapter(t), observedOverload);
  const defaults = resolveRetryPolicy();
  assert.equal(defaults.mode, 'normal');
  assert.equal(defaults.maxRetries, 5);
  let recover;
  installRetry({ on(name, listener) { assert.equal(name, 'agent/request-error'); recover = listener; return () => {}; },
    effect(create) { t.after(create()); } });
  const events = [];
  const agent = { session: { events, append(type, data) { events.push({ type, data }); } } };
  // Only test delays are zero; eligibility and the production default budget are untouched.
  const retryPolicy = { ...defaults, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };
  const input = { agent, turn: 1, step: 19, provider: 'openai-codex', failure, retryPolicy,
    signal: new AbortController().signal };
  let delegated = 0;
  const next = () => { delegated++; };
  for (let attempt = 0; attempt < defaults.maxRetries; attempt++) {
    assert.deepEqual(await recover(input, next), { kind: 'retry' });
  }
  assert.equal(await recover(input, next), undefined);
  assert.equal(delegated, 1);
  assert.equal(events.filter(event => event.type === 'llm/retry').length, defaults.maxRetries);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await recover({ ...input, step: 20, signal: cancelled.signal }, next), undefined);
  assert.equal(events.filter(event => event.type === 'llm/retry').length, defaults.maxRetries);
});
