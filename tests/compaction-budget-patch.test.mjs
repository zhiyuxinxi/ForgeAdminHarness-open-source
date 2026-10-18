import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { patchAgentModelSelection, patchCompactionBudget, patchLegacyCompactionBudget } from '../docker/harness/forge-compaction-budget-patch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.FORGE_TEST_NATIVE_RUNTIME || process.env.FORGE_TEST_NATIVE_SOURCE_RUNTIME || resolve(root, 'tmp/runtime-deps-ci');
const nativeRequire = createRequire(resolve(runtime, 'package.json'));
const nativePath = nativeRequire.resolve('@deepseek-ai/dsh-compaction-basic');
const original = readFileSync(process.env.FORGE_TEST_COMPACTION_SOURCE || nativePath, 'utf8');
const patched = patchCompactionBudget(original);
const installed = Boolean(process.env.FORGE_TEST_NATIVE_RUNTIME);
if (installed) assert.equal(patched, original, 'installed dependency must already contain the complete patch');
const moduleUrl = installed ? pathToFileURL(nativePath).href : `data:text/javascript;base64,${Buffer.from(patched.replace(/^import (.+) from "([^"]+)";$/gmu, (_, names, name) => `import ${names} from ${JSON.stringify(name.startsWith("node:") ? name : pathToFileURL(nativeRequire.resolve(name)).href)};`)).toString('base64')}`;
const { BasicCompactionEngine } = await import(moduleUrl);
const { Session } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-session')).href);
const { TokenMeter } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-token-meter')).href);
const { LlmError, resolveRetryPolicy } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-llm')).href);
const agentPath = nativeRequire.resolve('@deepseek-ai/dsh-agent');
const originalAgent = readFileSync(process.env.FORGE_TEST_AGENT_SOURCE || agentPath, 'utf8');
const patchedAgent = patchAgentModelSelection(originalAgent);
if (installed) assert.equal(patchedAgent, originalAgent, 'installed model selection bridge must already contain the complete patch');
const agentModuleUrl = installed ? pathToFileURL(agentPath).href : `data:text/javascript;base64,${Buffer.from(patchedAgent.replace(/^import (.+) from "([^"]+)";$/gmu, (_, names, name) => `import ${names} from ${JSON.stringify(name.startsWith('node:') ? name : pathToFileURL(nativeRequire.resolve(name)).href)};`)).toString('base64')}`;
const { installModelSelection } = await import(agentModuleUrl);

function fixture({ contextWindow = 24000, defaultMaxTokens, fail = false, config = {}, streamHook, retryPolicy = resolveRetryPolicy({ mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 10, jitterRatio: 0 } }, 'test') } = {}) {
  const listeners = new Map();
  const calls = [];
  const modelInfoCalls = [];
  const ctx = {
    reflect: { provide(name, value) { ctx[name] = value; } },
    inject() {}, on(name, fn) { listeners.set(name, fn); }, get() {},
    logger: { info() {}, warn() {} }, sessions: { async flush() {} },
    llm: {
      providerRetryPolicy() { return retryPolicy; },
      async resolveModelInfo(provider, model) { modelInfoCalls.push({ provider, model }); return { context: { contextWindow }, defaultMaxTokens }; },
      async *stream(options) {
        calls.push(options);
        if (fail) { fail = false; throw Object.assign(new Error('pi-ai stream idle timeout after 300000ms'), { code: 'TIMEOUT' }); }
        if (streamHook) { yield* streamHook(options, calls.length); return; }
        assert.ok(ctx.tokenMeter.estimateMessage({ role: 'user', content: [{ type: 'text', text: JSON.stringify({ system: options.system, tools: options.tools, messages: options.messages }) }] }) + options.maxTokens + 1024 <= contextWindow, 'every native summary call is within model capacity, including serialized fields and output reserve; not an exact tokenizer proof');
        yield { type: 'text-delta', index: 0, text: 'The original task, accepted contracts, failed checks, and next verification remain required.' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  new TokenMeter(ctx);
  const engine = new BasicCompactionEngine(ctx, { thresholdRatio: 0.2, retainTokens: 1, maxTokens: 64, ...config });
  const session = Session.create('compaction-budget-fixture');
  session.append('request/header', { header: { config: { provider: 'openai-codex', model: 'gpt-5.5' }, system: 'Retain the original authorized task.', tools: [] } });
  const user = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } });
  const agent = { session, options: { provider: 'openai-codex', model: 'gpt-5.5' }, async runMaintenance(fn) { return fn(new AbortController().signal); } };
  return { ctx, engine, session, agent, calls, modelInfoCalls, user, listeners };
}

function selectForCompaction(f, current) {
  const selection = { current };
  const dispose = installModelSelection({ agent: f.agent, on() { return () => {}; } }, selection);
  return { selection, dispose };
}

async function runSelectedCompaction(f) {
  f.session.append('request/header', { header: { config: { provider: 'zhipu', model: 'glm-5.3' }, system: 'Keep the original task.', tools: [] } });
  for (let i = 0; i < 4; i += 1) f.session.append('user/message', f.user(`selected-old-${i}`, 'a'.repeat(6000)), { surfaceOp: 'append' });
  const originalEvents = JSON.stringify(f.session.events);
  f.session.append('turn/start', { turn: 51 });
  const pending = f.user('selected-followup', 'Continue the original work with the current model.');
  const decision = { kind: 'enter', messages: [pending], assembly: {} };
  assert.equal(await f.listeners.get('agent/pre-step')({ agent: f.agent, signal: new AbortController().signal }, async () => decision), decision);
  assert.ok(f.calls.length > 0, 'the native pre-step must actually summarize');
  assert.equal(JSON.stringify(f.session.events.slice(0, JSON.parse(originalEvents).length)), originalEvents, 'model selection must not rewrite prior events or request headers');
  assert.deepEqual(f.session.requestHeader().config, { provider: 'zhipu', model: 'glm-5.3' });
}

test('compaction selection uses the current native choice for pre-step budgets policy and summary', async () => {
  const f = fixture({ config: { modelPolicies: [{ provider: 'openai-codex', model: 'gpt-5.6-luna', maxTokens: 96 }] } });
  const binding = selectForCompaction(f, { provider: 'zhipu', model: 'glm-5.3' });
  binding.selection.current = { provider: 'openai-codex', model: 'gpt-5.6-luna' };
  await runSelectedCompaction(f);
  assert.ok(f.modelInfoCalls.length > 0);
  assert.ok(f.modelInfoCalls.every((call) => call.provider === 'openai-codex' && call.model === 'gpt-5.6-luna'));
  assert.ok(f.calls.every((call) => call.provider === 'openai-codex' && call.model === 'gpt-5.6-luna' && call.maxTokens === 96));
  const other = fixture();
  assert.equal(other.agent[Symbol.for('forge.current-model-selection.v1')], undefined, 'the choice is local to this agent');
  binding.dispose();
  assert.equal(f.agent[Symbol.for('forge.current-model-selection.v1')], undefined);
});

test('compaction selection preserves explicit summarization overrides and their budget target', async () => {
  const f = fixture({ config: { summarizationProvider: 'summary-route', summarizationModel: 'summary-model' } });
  selectForCompaction(f, { provider: 'openai-codex', model: 'gpt-5.6-luna' });
  await runSelectedCompaction(f);
  assert.ok(f.calls.every((call) => call.provider === 'summary-route' && call.model === 'summary-model'));
  assert.ok(f.modelInfoCalls.some((call) => call.provider === 'summary-route' && call.model === 'summary-model'));
  assert.ok(f.modelInfoCalls.some((call) => call.provider === 'openai-codex' && call.model === 'gpt-5.6-luna'));
  assert.ok(f.modelInfoCalls.every((call) => call.provider !== 'zhipu'));
});

test('compaction selection retains logged and agent defaults when no active choice exists', async () => {
  const logged = fixture();
  selectForCompaction(logged, undefined);
  await runSelectedCompaction(logged);
  assert.ok(logged.calls.every((call) => call.provider === 'zhipu' && call.model === 'glm-5.3'));
  assert.ok(logged.modelInfoCalls.every((call) => call.provider === 'zhipu' && call.model === 'glm-5.3'));
  const blank = fixture();
  blank.agent.session = Session.create('compaction-selected-blank');
  await blank.engine.summarize({ messages: [] }, blank.agent, new AbortController().signal);
  assert.equal(blank.calls[0].provider, 'openai-codex');
  assert.equal(blank.calls[0].model, 'gpt-5.5');
});

test('compaction selection upgrades complete v1 and rejects partial v2 on both native consumers', () => {
  // Source validation consumes the saved v1 package. Installed-v2 verification
  // reuses that upgrade evidence and only checks the actual installed result.
  if (!original.includes('forge-compaction-model-selection-v2')) {
    const legacy = patchLegacyCompactionBudget(original);
    assert.equal(patchLegacyCompactionBudget(legacy), legacy);
    assert.equal(patchCompactionBudget(legacy), patched);
  }
  assert.equal(patchCompactionBudget(patched), patched);
  assert.equal(patchAgentModelSelection(patchedAgent), patchedAgent);
  assert.throws(() => patchCompactionBudget(patched.replace('const latest = forgeRoutedTarget(agent);', 'const latest = undefined;')), /Incomplete/);
  assert.throws(() => patchAgentModelSelection(patchedAgent.replace('const readSelection = () => selection.current;', 'const readSelection = () => undefined;')), /Incomplete/);
});

test('native compaction bounds real summary prefixes and preserves a failed pending turn for normal continuation', async () => {
  const f = fixture({ fail: true, retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'test') });
  for (let i = 0; i < 4; i += 1) f.session.append('user/message', f.user(`old-${i}`, 'a'.repeat(6000)), { surfaceOp: 'append' });
  const originalEvents = JSON.stringify(f.session.events);
  f.session.append('turn/start', { turn: 48 });
  const pending = f.user('original-phase-prompt', 'b'.repeat(5000));
  const notice = f.user('guard-notice', 'Required scope and actor identity remain enforced.');
  const decision = { kind: 'enter', messages: [pending, notice], assembly: {} };
  let nextCalls = 0;
  await assert.rejects(f.listeners.get('agent/pre-step')({ agent: f.agent, signal: new AbortController().signal, messages: [pending] }, async () => { nextCalls += 1; return decision; }), /timeout/);
  assert.equal(nextCalls, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.session.events.filter((e) => e.type === 'user/message').slice(-2).map((e) => e.data), [pending, notice]);
  assert.equal(JSON.stringify(f.session.events.slice(0, JSON.parse(originalEvents).length)), originalEvents);
  assert.match(f.session.events.find((e) => e.type === 'compaction/end').data.error, /timeout/);
  f.session.append('turn/end', { turn: 48, reason: { kind: 'error' } });
  f.session.append('turn/start', { turn: 49 });
  const followup = f.user('normal-followup', 'Continue the original verification.');
  const nextDecision = { kind: 'enter', messages: [followup], assembly: {} };
  assert.equal(await f.listeners.get('agent/pre-step')({ agent: f.agent, signal: new AbortController().signal, messages: [followup] }, async () => nextDecision), nextDecision);
  const summary = f.session.events.find((e) => e.type === 'compaction/summary');
  assert.equal(summary.data.llmStreamCall, true);
  assert.equal(summary.data.provider, 'openai-codex');
  const surface = f.session.surface.nodes.map((seq) => f.session.deriveEventMessage(f.session.events[seq]));
  assert.deepEqual(surface.slice(-2), [pending, notice], 'unsummarized pending suffix remains byte-exact');
  assert.ok(f.calls.length <= 3, 'original one failure plus existing two-attempt convergence budget');
  const tool = fixture();
  const first = tool.session.append('user/message', tool.user('prefix', 'p'.repeat(6000)), { surfaceOp: 'append' });
  tool.session.append('turn/start', { turn: 1 });
  tool.session.append('step/start', { turn: 1, step: 1 });
  tool.session.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'paired-call', name: 'read', arguments: JSON.stringify({ path: 'p'.repeat(6000) }) }], replayState: { reasoning: 'signed'.repeat(600) } } }, { surfaceOp: 'append' });
  tool.session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'paired-call', content: [{ type: 'text', text: 'r'.repeat(10000) }] }] } }, { surfaceOp: 'append' });
  tool.session.append('step/end', { turn: 1, step: 1 });
  tool.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  tool.session.append('user/message', tool.user('last', 'Keep this current instruction.'), { surfaceOp: 'append' });
  const suffix = JSON.stringify(tool.session.surface.nodes.slice(1).map((seq) => tool.session.events[seq]));
  const manual = await tool.engine.compactNow(tool.agent, new AbortController().signal);
  assert.deepEqual(manual.shadowedSeqs, [first.seq], 'bounded prefix cannot cut a tool call from its result, including serialized replay metadata');
  assert.equal(JSON.stringify(tool.session.surface.nodes.slice(1).map((seq) => tool.session.events[seq])), suffix);

  const incidentPath = process.env.FORGE_TEST_COMPACTION_INCIDENT || resolve(root, 'output/validation/fire-eight-stage-20261005/fire-management-eight-stage-tail-1791313157980057800.json');
  const incident = JSON.parse(readFileSync(incidentPath, 'utf8'));
  const actual = incident.history.events.map((entry) => entry.event).filter((event) => event.seq === 397943 || event.seq === 397944).map((event) => event.data);
  assert.equal(actual.length, 2);
  assert.deepEqual(actual.map((message) => Buffer.byteLength(message.content.map((block) => block.text || '').join(''))), [233052, 6643]);
  const originals = actual.map((message) => createHash('sha256').update(JSON.stringify(message)).digest('hex'));
  const liveShape = fixture({ contextWindow: 272000, config: { thresholdRatio: 0.8, maxTokens: 8192 } });
  // The live request/header was not available; this explicitly synthetic large header is not a runtime binding.
  liveShape.session.append('request/header', { header: { config: { provider: 'openai-codex', model: 'gpt-5.5', maxTokens: 8192 }, system: 'Authorized platform rules. '.repeat(2500), tools: [{ name: 'controlled_verification', description: 'Tool schema and protected inputs. '.repeat(2500), parameters: { type: 'object', properties: {} } }] } });
  for (let i = 0; i < 5; i += 1) liveShape.session.append('user/message', liveShape.user(`prior-${i}`, 'historic original context '.repeat(6500)), { surfaceOp: 'append' });
  liveShape.session.append('turn/start', { turn: 49 });
  const actualDecision = { kind: 'enter', messages: actual, assembly: {} };
  assert.equal(await liveShape.listeners.get('agent/pre-step')({ agent: liveShape.agent, signal: new AbortController().signal, messages: [actual[0]] }, async () => actualDecision), actualDecision);
  assert.deepEqual(actual.map((message) => createHash('sha256').update(JSON.stringify(message)).digest('hex')), originals);
  assert.ok(liveShape.session.events.some((event) => event.type === 'compaction/summary' && event.data.llmStreamCall));
  assert.equal(patchCompactionBudget(patched), patched);
  assert.throws(() => patchCompactionBudget(patched.replace('forge-compaction-budget-v1', 'incomplete-compaction-budget')), /Unsupported/);
});

function seedRecovery(f) {
  f.session.append('user/message', f.user('original-task', 'Keep the authorized goal and completed work. '.repeat(130)), { surfaceOp: 'append' });
  for (let i = 0; i < 3; i++) f.session.append('user/message', f.user(`retained-evidence-${i}`, 'a'.repeat(6000)), { surfaceOp: 'append' });
  f.session.append('turn/start', { turn: 1 });
  f.session.append('step/start', { turn: 1, step: 1 });
  f.session.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'completed-write', name: 'write', arguments: '{"path":"already-written"}' }] } }, { surfaceOp: 'append' });
  f.session.append('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'completed-write', content: [{ type: 'text', text: 'already completed' }] }] } }, { surfaceOp: 'append' });
  f.session.append('step/end', { turn: 1, step: 1 });
  f.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  f.session.append('turn/start', { turn: 2 });
  return JSON.stringify(f.session.events);
}

async function* validSummary() {
  yield { type: 'text-delta', index: 0, text: 'Original goal retained. The write already completed; do not repeat it. Continue the pending task.' };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

test('compaction transport recovery resumes the same pre-step and discards partial output without replaying tools', async () => {
  const f = fixture({ streamHook: async function* (options, attempt) {
    if (attempt === 1) {
      yield { type: 'text-delta', index: 0, text: 'INCOMPLETE CHECKPOINT MUST BE DISCARDED' };
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'terminated', requestId: 'incident-request' } } };
    } else yield* validSummary();
  } });
  const before = seedRecovery(f);
  const pending = f.user('continue-same-turn', 'Continue the original task.');
  const decision = { kind: 'enter', messages: [pending], assembly: {} };
  let nextCalls = 0;
  assert.equal(await f.listeners.get('agent/pre-step')({ agent: f.agent, signal: new AbortController().signal }, async () => { nextCalls++; return decision; }), decision);
  assert.equal(nextCalls, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify(f.session.events.slice(0, JSON.parse(before).length)), before);
  assert.equal(f.session.events.filter((e) => e.type === 'tool/result').length, 1);
  assert.equal(f.session.events.filter((e) => e.type === 'llm/retry').length, 1);
  assert.equal(f.session.events.filter((e) => e.type === 'llm/retry-started').length, 1);
  assert.equal(f.session.events.find((e) => e.type === 'llm/retry').data.failure.requestId, 'incident-request');
  assert.ok(f.session.events.some((e) => e.type === 'compaction/summary'));
  assert.ok(!JSON.stringify(f.session.events).includes('INCOMPLETE CHECKPOINT MUST BE DISCARDED'));
  assert.deepEqual(f.calls[0].messages, f.calls[1].messages);
});

test('persistent compaction failure stops within provider budget, retains original surface and typed cause', async () => {
  const f = fixture({ streamHook: async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'terminated', status: 502, requestId: 'request-final' } } };
  } });
  const before = seedRecovery(f);
  const surface = [...f.session.surface.nodes];
  const pending = f.user('pending-preserved-once', 'Continue original work.');
  await assert.rejects(f.listeners.get('agent/pre-step')({ agent: f.agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [pending], assembly: {} })), (error) => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.failure.code, 'TRANSPORT');
    assert.equal(error.failure.status, 502);
    assert.equal(error.failure.requestId, 'request-final');
    assert.match(error.message, /已自动重试 2 次/);
    assert.equal(error.cause.failure.message, 'terminated');
    return true;
  });
  assert.equal(f.calls.length, 3);
  assert.equal(JSON.stringify(f.session.events.slice(0, JSON.parse(before).length)), before);
  assert.deepEqual(f.session.surface.nodes.slice(0, surface.length), surface);
  assert.equal(f.session.events.filter((e) => e.type === 'compaction/summary').length, 0);
  assert.equal(f.session.events.filter((e) => e.type === 'user/message' && e.data.id === pending.id).length, 1);
});

test('compaction does not retry authentication, invalid requests, truncated summaries or provider aborts', async () => {
  for (const reason of [
    { kind: 'error', failure: { code: 'AUTH', message: 'authentication failed' } },
    { kind: 'error', failure: { code: 'INVALID_REQUEST', message: 'invalid input' } },
    { kind: 'max-tokens' },
    { kind: 'aborted', failure: { code: 'TRANSPORT', message: 'user stopped' } },
  ]) {
    const f = fixture({ streamHook: async function* () { yield { type: 'finish', reason }; } });
    await assert.rejects(f.engine.summarize({ messages: [] }, f.agent, new AbortController().signal));
    assert.equal(f.calls.length, 1, reason.kind);
    assert.equal(f.session.events.filter((e) => e.type === 'llm/retry').length, 0);
  }
});

test('compaction user cancellation interrupts active stream and backoff without another request', async () => {
  for (const duringBackoff of [false, true]) {
    const controller = new AbortController();
    const stop = new Error('explicit user stop');
    const f = fixture({
      retryPolicy: resolveRetryPolicy({ mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1000, maxDelayMs: 1000 } }, 'test'),
      streamHook: async function* () {
        if (!duringBackoff) controller.abort(stop);
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'terminated' } } };
      },
    });
    f.ctx.sessions.flush = async () => { if (duringBackoff) setTimeout(() => controller.abort(stop), 5); };
    await assert.rejects(f.engine.summarize({ messages: [] }, f.agent, controller.signal), (error) => error === stop);
    assert.equal(f.calls.length, 1);
    assert.equal(f.session.events.filter((e) => e.type === 'llm/retry-started').length, 0);
  }
});

test('compaction bounds always policy and honors excessive Retry-After without an early retry', async () => {
  const f = fixture({ retryPolicy: resolveRetryPolicy({ mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }, 'test'), streamHook: async function* () { throw new LlmError('terminated', 'TRANSPORT'); } });
  await assert.rejects(f.engine.summarize({ messages: [] }, f.agent, new AbortController().signal), /TRANSPORT/);
  assert.equal(f.calls.length, resolveRetryPolicy(undefined, 'test').maxRetries + 1);
  const delayed = fixture({ streamHook: async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'wait', providerRetryAfterMs: 10000 } } }; } });
  await assert.rejects(delayed.engine.summarize({ messages: [] }, delayed.agent, new AbortController().signal), (error) => error.failure.providerRetryAfterMs === 10000);
  assert.equal(delayed.calls.length, 1);
});

test('each automatic summary consumes another original node even when the next node exceeds the soft batch budget', async () => {
  const f = fixture({ contextWindow: 8000 });
  const originals = new Set();
  for (let i = 0; i < 3; i++) originals.add(f.session.append('user/message', f.user(`large-original-${i}`, 'x'.repeat(20000)), { surfaceOp: 'append' }).seq);
  const history = JSON.stringify(f.session.events);
  f.session.append('turn/start', { turn: 1 });
  const pending = f.user('continue', 'Report the previous result.');
  const decision = { kind: 'enter', messages: [pending], assembly: {} };
  assert.equal(await f.listeners.get('agent/pre-step')({ agent: f.agent, signal: new AbortController().signal }, async () => decision), decision);
  const summaries = f.session.events.filter((event) => event.type === 'compaction/summary');
  assert.equal(summaries.length, 3);
  for (const summary of summaries) assert.ok(summary.data.shadowedSeqs.some((seq) => originals.delete(seq)), 'each bounded summary must include previously unprocessed original history');
  assert.equal(originals.size, 0);
  assert.equal(JSON.stringify(f.session.events.slice(0, JSON.parse(history).length)), history);
});

test('checkpoint-only pressure does not call the model again and only continues within actual capacity', async () => {
  for (const hardOverflow of [false, true]) {
    const f = fixture({ contextWindow: 8000 });
    const first = f.session.append('user/message', f.user('original', 'x'.repeat(12000)), { surfaceOp: 'append' });
    f.session.append('turn/start', { turn: 1 });
    await f.engine.compactRegion(first.seq, first.seq, f.agent, new AbortController().signal);
    const surface = [...f.session.surface.nodes];
    const pending = f.user('pending-checkpoint', 'p'.repeat(hardOverflow ? 40000 : 14000));
    const decision = { kind: 'enter', messages: [pending], assembly: {} };
    const run = f.listeners.get('agent/pre-step')({ agent: f.agent, signal: new AbortController().signal }, async () => decision);
    if (hardOverflow) {
      await assert.rejects(run, /exceeds model context capacity 8000.*original messages preserved.*new original history/);
      assert.deepEqual(f.session.events.filter((event) => event.type === 'user/message' && event.data.id === pending.id).map((event) => event.data), [pending]);
    } else {
      assert.equal(await run, decision);
      assert.deepEqual(f.session.surface.nodes, surface);
      assert.equal(f.session.events.filter((event) => event.type === 'user/message' && event.data.id === pending.id).length, 0, 'normal agent loop still owns successful pending-message admission');
    }
    assert.equal(f.calls.length, 1, 'the existing checkpoint is never sent alone for another summary');
  }
});

test('nonshrinking summary retains original context, continuing only when the complete request fits capacity', async () => {
  for (const hardOverflow of [false, true]) {
    const f = fixture({ contextWindow: hardOverflow ? 10000 : 24000, config: { maxTokens: 4096, thresholdRatio: 0.3 }, streamHook: async function* () {
      yield { type: 'text-delta', index: 0, text: 's'.repeat(10000) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } });
    const first = f.session.append('user/message', f.user('original-small', 'x'.repeat(6000)), { surfaceOp: 'append' });
    f.session.append('turn/start', { turn: 1 });
    const pending = f.user('pending-shrink', 'p'.repeat(hardOverflow ? 40000 : 6000));
    const decision = { kind: 'enter', messages: [pending], assembly: {} };
    const run = f.listeners.get('agent/pre-step')({ agent: f.agent, signal: new AbortController().signal }, async () => decision);
    if (hardOverflow) await assert.rejects(run, /exceeds model context capacity 10000.*summary is not smaller/);
    else assert.equal(await run, decision);
    assert.equal(f.calls.length, 1);
    assert.equal(f.session.surface.nodes[0], first.seq);
    assert.equal(f.session.events.filter((event) => event.type === 'compaction/summary').length, 0);
    assert.match(f.session.events.find((event) => event.type === 'compaction/end').data.error, /summary is not smaller/);
  }
});

test('pre-step preserves cancellation, provider failure and commit failure even below model capacity', async () => {
  for (const kind of ['cancel', 'provider', 'persistence']) {
    const controller = new AbortController();
    const stop = new Error('owner cancelled');
    const disk = new Error('summary persistence failed');
    const f = fixture({ streamHook: async function* () {
      if (kind === 'cancel') controller.abort(stop);
      if (kind === 'provider') throw new LlmError('authentication failed', 'AUTH');
      yield* validSummary();
    } });
    const history = seedRecovery(f);
    if (kind === 'persistence') {
      const append = f.session.append.bind(f.session);
      f.session.append = (type, ...args) => { if (type === 'compaction/summary') throw disk; return append(type, ...args); };
    }
    const pending = f.user(`pending-${kind}`, 'Keep the original authorized task.');
    await assert.rejects(f.listeners.get('agent/pre-step')({ agent: f.agent, signal: controller.signal }, async () => ({ kind: 'enter', messages: [pending], assembly: {} })), (error) => kind === 'cancel' ? error === stop : kind === 'persistence' ? error === disk : error.failure.code === 'AUTH');
    assert.equal(f.calls.length, 1);
    assert.equal(JSON.stringify(f.session.events.slice(0, JSON.parse(history).length)), history);
    assert.deepEqual(f.session.events.filter((event) => event.type === 'user/message' && event.data.id === pending.id).map((event) => event.data), [pending]);
  }
});

test('current model output reserve replaces historical adapter defaults without rewriting request history', async () => {
  for (const sameTarget of [false, true]) {
    const f = fixture({ defaultMaxTokens: 96 });
    const header = { config: { provider: 'openai-codex', model: sameTarget ? 'current-model' : 'old-model', maxTokens: 100000 }, adapterDefaults: { maxTokens: true }, system: 'Keep the original task.', tools: [] };
    f.session.append('request/header', { header });
    const recordedHeader = f.session.requestHeader();
    selectForCompaction(f, { provider: 'openai-codex', model: 'current-model' });
    f.session.append('turn/start', { turn: 1 });
    const pending = f.user('current-query', 'Is the previous release available?');
    const decision = { kind: 'enter', messages: [pending], assembly: {} };
    assert.equal(await f.listeners.get('agent/pre-step')({ agent: f.agent, signal: new AbortController().signal }, async () => decision), decision);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.session.requestHeader(), recordedHeader);
    assert.ok(f.modelInfoCalls.every((info) => info.model === 'current-model'));
  }
  const f = fixture({ defaultMaxTokens: 24000 });
  f.session.append('turn/start', { turn: 1 });
  const pending = f.user('current-large-default', 'Continue.');
  await assert.rejects(f.listeners.get('agent/pre-step')({ agent: f.agent, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [pending], assembly: {} })), /exceeds model context capacity 24000/);
});

test('progress patch is idempotent and rejects missing hard-capacity and original-node checks', () => {
  assert.equal(patchCompactionBudget(patched), patched);
  for (const anchor of ['if (!(error instanceof ForgeCompactionNoProgressError)) throw error;', '(!requireOriginal || includesOriginal)', 'if (estimated > budget.window)']) {
    assert.throws(() => patchCompactionBudget(patched.replace(anchor, '/* incomplete */')), /Incomplete compaction progress patch/);
  }
});
