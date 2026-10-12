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
const agentPath = nativeRequire.resolve('@deepseek-ai/dsh-agent');
const originalAgent = readFileSync(process.env.FORGE_TEST_AGENT_SOURCE || agentPath, 'utf8');
const patchedAgent = patchAgentModelSelection(originalAgent);
if (installed) assert.equal(patchedAgent, originalAgent, 'installed model selection bridge must already contain the complete patch');
const agentModuleUrl = installed ? pathToFileURL(agentPath).href : `data:text/javascript;base64,${Buffer.from(patchedAgent.replace(/^import (.+) from "([^"]+)";$/gmu, (_, names, name) => `import ${names} from ${JSON.stringify(name.startsWith('node:') ? name : pathToFileURL(nativeRequire.resolve(name)).href)};`)).toString('base64')}`;
const { installModelSelection } = await import(agentModuleUrl);

function fixture({ contextWindow = 24000, fail = false, config = {} } = {}) {
  const listeners = new Map();
  const calls = [];
  const modelInfoCalls = [];
  const ctx = {
    reflect: { provide(name, value) { ctx[name] = value; } },
    inject() {}, on(name, fn) { listeners.set(name, fn); }, get() {},
    logger: { info() {}, warn() {} }, sessions: { async flush() {} },
    llm: {
      async resolveModelInfo(provider, model) { modelInfoCalls.push({ provider, model }); return { context: { contextWindow } }; },
      async *stream(options) {
        calls.push(options);
        if (fail) { fail = false; throw Object.assign(new Error('pi-ai stream idle timeout after 300000ms'), { code: 'TIMEOUT' }); }
        assert.ok(ctx.tokenMeter.estimateMessage({ role: 'user', content: [{ type: 'text', text: JSON.stringify({ system: options.system, tools: options.tools, messages: options.messages }) }] }) + options.maxTokens + 1024 <= contextWindow * engine.config.thresholdRatio, 'every native summary call is within the configured estimate, including serialized fields; not an exact tokenizer proof');
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
  const f = fixture({ fail: true });
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
