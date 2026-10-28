import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { patchDeepSeekProgressTimeout } from '../docker/harness/forge-deepseek-progress-timeout-patch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.FORGE_TEST_NATIVE_RUNTIME || resolve(root, 'tmp/runtime-deps-ci');
const nativeRequire = createRequire(resolve(runtime, 'package.json'));
const nativeModule = (name) => import(pathToFileURL(nativeRequire.resolve(name)).href);
function sourceModule(source) {
  // Load the real pinned implementation; only bare import locations change.
  const absolute = source.replace(/^import (.+) from "([^"]+)";$/gmu, (_, names, name) =>
    `import ${names} from ${JSON.stringify(name.startsWith('node:') ? name : pathToFileURL(nativeRequire.resolve(name)).href)};`);
  return import(`data:text/javascript;base64,${Buffer.from(absolute).toString('base64')}`);
}
const adapterPath = nativeRequire.resolve('@deepseek-ai/dsh-llm-deepseek');
const original = readFileSync(adapterPath, 'utf8');
const patched = patchDeepSeekProgressTimeout(original);
if (process.env.FORGE_TEST_INSTALLED_DEEPSEEK_PROGRESS_PATCH === '1') {
  assert.equal(patched, original, 'the installed adapter must already contain the full patch');
}
const { DeepSeekAdapter, resolveAdapterOptions } = await sourceModule(patched);
const { Context } = await nativeModule('@deepseek-ai/cordis');
const { LlmRuntime, createAssistantMessage, createToolResultMessage, createUserMessage } = await nativeModule('@deepseek-ai/dsh-llm');
const { Session } = await nativeModule('@deepseek-ai/dsh-session');
const { Inbox } = await nativeModule('@deepseek-ai/dsh-agent');
const { apply: applyRetry } = await nativeModule('@deepseek-ai/dsh-llm-retry');
// ReactLoopAgent is private upstream. Export it only from this test-loaded copy;
// its step, turn, kick and terminal-error implementation remain byte-for-byte native.
const loopSource = readFileSync(nativeRequire.resolve('@deepseek-ai/dsh-agent-loop'), 'utf8');
const { ReactLoopAgent } = await sourceModule(`${loopSource}\nexport { ReactLoopAgent };\n`);

function seedCompletedTool(session) {
  const callId = 'already-completed-release';
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
    source: { provider: 'deepseek-official', model: 'deepseek-chat' },
    content: [{ type: 'tool-call', id: callId, name: 'release', arguments: '{}' }],
  }) }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'release', arguments: {} });
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
    callId, isError: false, content: [{ type: 'text', text: 'Release already succeeded; receipt retained.' }],
  }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return JSON.stringify(session.events);
}

function fixture({ baseURL = 'https://deepseek.invalid', streamProgressTimeoutMs = 30, streamIdleTimeoutMs = 1000 } = {}) {
  const connection = resolveAdapterOptions({
    baseURL, ...(streamIdleTimeoutMs === null ? {} : { streamIdleTimeoutMs }),
    ...(streamProgressTimeoutMs === null ? {} : { streamProgressTimeoutMs }),
    // Retain the real normal-mode default count and codes, shortening only waits.
    retryPolicy: { mode: 'normal', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } },
  });
  const adapter = new DeepSeekAdapter({
    options: () => connection, resolveApiKey: async () => 'fixture-key', resolveUserId: () => 'fixture-user',
  });
  const context = new Context();
  const llm = new LlmRuntime(context);
  const unregister = llm.registerAdapter(['deepseek-official'], adapter);
  let recovery, disposeRecovery, toolExecutions = 0;
  applyRetry({
    on(name, listener) { assert.equal(name, 'agent/request-error'); recovery = listener; return () => {}; },
    effect(factory) { disposeRecovery = factory(); }, logger: { warn() {} },
  });
  const session = Session.create('deepseek-progress-recovery-fixture');
  const priorEvents = seedCompletedTool(session);
  const emitted = [];
  const requests = [];
  const agent = Object.create(ReactLoopAgent.prototype);
  Object.assign(agent, {
    id: session.id, session, options: { provider: 'deepseek-official', model: 'deepseek-chat' },
    phase: { kind: 'running', turn: 1, step: 0, abort: new AbortController(), wakeRequested: false },
    inbox: { nextStep: [], hasPending: false },
    loopCtx: { llm, agents: { requireInitiator() { toolExecutions++; throw new Error('completed tool was replayed'); } } },
    dispatch: {
      emit(name, payload) { emitted.push({ name, payload }); },
      async serial() {},
      async waterfall(name, payload, next) {
        assert.equal(name, 'agent/request-error');
        return recovery({ agent, ...payload }, next);
      },
    },
    async preStep() {
      return { kind: 'enter', assembly: { sections: [], variables: {}, tools: [] },
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Summarize the saved result.' }] })] };
    },
    async buildRequest(turn, step, tools, system, messages, signal) {
      const preparedCall = await llm.prepareCall(this.options, signal);
      const request = { ...preparedCall.config, tools, system, messages, signal };
      requests.push({ turn, step, messages: JSON.stringify(messages) });
      return { request, preparedCall };
    },
  });
  return { agent, session, priorEvents, connection, emitted, requests,
    toolExecutions: () => toolExecutions,
    async dispose() { unregister(); await disposeRecovery(); },
  };
}

function assertRetainedTool(f) {
  const before = JSON.parse(f.priorEvents);
  assert.equal(JSON.stringify(f.session.events.slice(0, before.length)), f.priorEvents);
  assert.equal(f.session.events.filter((event) => event.type === 'tool/call').length, 1);
  assert.equal(f.session.events.filter((event) => event.type === 'tool/result').length, 1);
  assert.equal(f.toolExecutions(), 0, 'the native loop must not execute the historical tool again');
  assert.ok(f.requests.every((request) => request.messages.includes('Release already succeeded; receipt retained.')));
}

test('native no-progress failure ends the turn without normal retries and retains completed tools', async () => {
  const f = fixture();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, { signal }) => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) {
        const pulse = setInterval(() => controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 5);
        signal.addEventListener('abort', () => { clearInterval(pulse); controller.error(signal.reason); }, { once: true });
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    await f.agent.kick();
    assert.equal(calls, 1);
    assert.equal(f.connection.retryPolicy.maxRetries, 5);
    assert.equal(f.session.events.filter((event) => event.type === 'llm/retry').length, 0);
    const terminal = f.session.events.findLast((event) => event.type === 'turn/end');
    assert.equal(terminal.data.reason.kind, 'error');
    assert.equal(terminal.data.reason.error.code, 'DEEPSEEK_NO_PROGRESS');
    assert.match(terminal.data.reason.error.message, /未返回有效内容.*原会话和已完成的工具结果保留/u);
    assert.equal(f.agent.status, 'idle');
    assert.ok(f.emitted.some((event) => event.name === 'agent/error' && event.payload.error.code === 'DEEPSEEK_NO_PROGRESS'));
    assertRetainedTool(f);
  } finally { globalThis.fetch = previousFetch; await f.dispose(); }
});

test('same native Session accepts a fresh dialogue after heartbeat timeout without replaying completed tools', { timeout: 150000 }, async t => {
  // The real adapter talks over HTTP to a controlled SSE peer. This is not an
  // upstream-model or original-owner dialogue; no production session is used.
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const bytes = [];
    for await (const chunk of request) bytes.push(chunk);
    requests.push(JSON.parse(Buffer.concat(bytes).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    if (requests.length === 1) {
      const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 50);
      response.on('close', () => clearInterval(heartbeat));
    } else {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'The retained result is available; this is the recovery reply.' } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const productionTimeout = process.env.FORGE_TEST_REAL_PROGRESS_TIMEOUT === '1';
  const f = fixture({ baseURL: `http://127.0.0.1:${server.address().port}`, streamProgressTimeoutMs: productionTimeout ? null : 180, streamIdleTimeoutMs: productionTimeout ? null : 1000 });
  // Use the provider's resolved default in the production-duration case.
  if (productionTimeout) {
    assert.equal(f.connection.streamProgressTimeoutMs, 120000);
    assert.equal(f.connection.streamIdleTimeoutMs, 300000);
  }
  f.agent.inbox = new Inbox(f.session, { inserted() {}, discarded() {}, claimed() {} });
  f.agent.loopCtx.agents.withInitiator = async (_agent, run) => run();
  f.agent.preStep = async (target, position) => ({ kind: 'enter', assembly: { sections: [], variables: {}, tools: [] }, messages: f.agent.inbox.claim(target, position.turn) });
  f.agent.setPhase({ kind: 'idle', lastTurn: 1 });
  const begin = performance.now();
  try {
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Please report the retained result.' }] }));
    await f.agent.whenIdle();
    const elapsedMs = Math.round(performance.now() - begin);
    const failed = f.session.events.findLast(event => event.type === 'turn/end');
    assert.equal(failed.data.reason.kind, 'error');
    assert.equal(failed.data.reason.error.code, 'DEEPSEEK_NO_PROGRESS');
    assert.equal(f.agent.status, 'idle');
    assert.equal(requests.length, 1);
    assert.equal(f.session.events.filter(event => event.type === 'llm/retry').length, 0);
    if (productionTimeout) assert.ok(elapsedMs >= 119000 && elapsedMs < 135000, `actual default timeout was ${elapsedMs}ms`);
    const retained = JSON.stringify(f.session.events);
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue from the retained result; do not repeat completed work.' }] }));
    await f.agent.whenIdle();
    const recovered = f.session.events.findLast(event => event.type === 'turn/end');
    assert.equal(recovered.data.reason.kind, 'completed');
    assert.equal(recovered.data.turn, failed.data.turn + 1);
    assert.equal(f.agent.status, 'idle');
    assert.equal(requests.length, 2);
    assert.equal(JSON.stringify(f.session.events.slice(0, JSON.parse(retained).length)), retained);
    assert.ok(JSON.stringify(requests[1]).includes('Release already succeeded; receipt retained.'));
    assertRetainedTool(f);
    t.diagnostic(JSON.stringify({ evidenceKind: 'isolated-native-session-controlled-http-sse', timeoutMs: f.connection.streamProgressTimeoutMs, elapsedMs, requests: requests.length, retries: 0, failedTurn: failed.data.turn, recoveredTurn: recovered.data.turn, terminal: recovered.data.reason.kind, historicalToolExecutions: f.toolExecutions() }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await f.dispose();
  }
});

test('native TRANSPORT recovery exhausts its existing normal budget within the same step', async () => {
  const f = fixture();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('fixture transport disconnected'); };
  try {
    await f.agent.kick();
    assert.equal(calls, 6, 'one initial call plus the native five retries');
    const retries = f.session.events.filter((event) => event.type === 'llm/retry');
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3, 4, 5]);
    assert.ok(retries.every((event) => event.data.failure.code === 'TRANSPORT' && event.data.maxRetries === 5));
    assert.equal(new Set(f.requests.map(({ turn, step }) => `${turn}/${step}`)).size, 1);
    assert.equal(new Set(f.requests.map(({ messages }) => messages)).size, 1, 'every retry consumes the same completed tool result');
    const terminal = f.session.events.findLast((event) => event.type === 'turn/end');
    assert.equal(terminal.data.reason.kind, 'error');
    assert.equal(terminal.data.reason.error.code, 'TRANSPORT');
    assert.equal(f.agent.status, 'idle');
    assertRetainedTool(f);
  } finally { globalThis.fetch = previousFetch; await f.dispose(); }
});
