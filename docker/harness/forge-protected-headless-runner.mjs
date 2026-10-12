// This protected plugin is installed under /usr/local/lib while the pinned DSH
// runtime is rooted at /opt/forge-harness-runtime. Bare ESM specifiers resolve
// from the importing file, not from DSH's executable, so use the reviewed image
// layout explicitly and fail closed if that immutable runtime layout changes.
import { installModelSelection } from '/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-agent/lib/index.js';
import { createUserMessage } from '/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import { SessionId } from '/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import z from '/opt/forge-harness-runtime/node_modules/@deepseek-ai/schemastery/lib/index.mjs';
import {
  openForgeProtectedAgent,
  resolveForgeProtectedSessionMode,
} from './forge-protected-session-mode.mjs';

const SAFE_SESSION_ID = /^[^\0\r\n]{1,1024}$/u;
const SAFE_RPC_ID = /^[^\0\r\n]{1,256}$/u;

export const name = 'forge-protected-headless-runner';
// The patch resolves its task from ctx.headlessStartup during loader
// interpolation. Declaring the service is required before Cordis may evaluate
// that expression; omitting it fails the complete plugin tree before any model
// request is created.
export const inject = ['agentDefaultModel', 'agents', 'headlessStartup', 'sessions'];
export const Config = z.object({ task: z.string().required() });

export const internals = {
  stdout: process.stdout,
  stderr: process.stderr,
};

function requiredIdentity(name, pattern) {
  const value = process.env[name];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${name} is required for protected headless execution.`);
  }
  return value;
}

function summarize(events, firstSeq) {
  let started = false;
  let text = '';
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === 'turn/start') {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (joined !== '') text = joined;
    }
    if (event.type === 'turn/end') reason = event.data.reason;
  }
  return { text, reason };
}

async function run(ctx, task, io) {
  await ctx.get('loader')?.await();
  const agents = ctx.get('agents');
  const defaultModel = ctx.get('agentDefaultModel');
  const sessions = ctx.get('sessions');
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return;
  const sessionId = requiredIdentity('FORGE_PROTECTED_HEADLESS_SESSION_ID', SAFE_SESSION_ID);
  const rpcId = requiredIdentity('FORGE_PROTECTED_HEADLESS_RPC_ID', SAFE_RPC_ID);
  const sessionMode = resolveForgeProtectedSessionMode();
  const selection = defaultModel.currentSelection();
  const setup = (agentCtx) => {
    // Agent setup is a side-effect callback. Do not return the model-selection
    // registration value: the Agent manager treats a non-void return as a
    // transactional scope and calls .commit() on it.
    installModelSelection(agentCtx, { current: selection, assembled: undefined });
  };
  const { agent } = await openForgeProtectedAgent({
    agents,
    sessionMode,
    sessionId: SessionId(sessionId),
    agentOptions: { provider: selection.provider, model: selection.model },
    setup,
  });
  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: task }],
    source: { kind: 'user', rpcId },
  }));
  await agent.whenIdle();
  await sessions.flush(agent.session);
  const outcome = summarize(agent.session.events, firstSeq);
  io.stdout.write(`${outcome.text}\n`);
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1);
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit');
  if (exit === undefined) throw new Error('protected headless runner requires the launcher appExit service.');
  run(ctx, config.task, { stdout: internals.stdout, stderr: internals.stderr, exit }).catch((error) => {
    internals.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
}
