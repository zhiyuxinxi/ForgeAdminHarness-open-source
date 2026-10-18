import { randomUUID } from 'node:crypto';
import { currentDirectToolPolicy } from './forge-direct-development.mjs';

export const name = 'forge-browser';
export const inject = ['tools', 'sandbox', 'sandboxPolicy', 'subprocess'];
// Opening an explicit page is required to observe it in a read-only task.
// Form/element interactions and history/reload actions retain their write boundary.
export const BROWSER_READ_ACTIONS = new Set(['open', 'goto', 'snapshot', 'tab-list', 'console', 'network', 'close']);
const ZERO = new Set(['snapshot', 'tab-list', 'console', 'network', 'close', 'go-back', 'go-forward', 'reload']);
const REF = new Set(['click', 'dblclick', 'hover', 'check', 'uncheck']);
const SNAPSHOT_REF = /^(?:f[0-9]+)?e[0-9]+$/u;
const owners = new WeakMap();
export async function closeBrowserSession(agent) { if (agent) await owners.get(agent)?.destroy(agent); }
export async function reconcileBrowserAuthority(agent, authority) { if (agent) await owners.get(agent)?.reconcile(agent, authority); }
const identity = ({ expiresAt: _expiresAt, ...policy }) => JSON.stringify(policy);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// Model input is data for a fixed CLI, never shell, JavaScript, environment,
// session names, browser endpoints, profiles, configuration or output paths.
export function browserCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['action', 'args'].includes(key))) fail('BROWSER_ARGUMENTS', 'Use action and optional args only.');
  const { action } = input, args = input.args ?? [];
  if (typeof action !== 'string' || !Array.isArray(args) || args.length > 2
    || args.some(value => typeof value !== 'string' || value.length > 16000 || /[\u0000\r\n]/u.test(value) || value.startsWith('-'))) {
    fail('BROWSER_ARGUMENTS', 'Browser arguments must be bounded literal values, without CLI flags.');
  }
  if (ZERO.has(action) && args.length === 0) return { action, args };
  if (['open', 'goto'].includes(action) && args.length === 1) {
    let url; try { url = new URL(args[0]); } catch { fail('BROWSER_URL', 'Use an explicit HTTP(S) URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('BROWSER_URL', 'Only HTTP(S) URLs without embedded credentials are supported.');
    return { action, args };
  }
  if (REF.has(action) && args.length === 1 && SNAPSHOT_REF.test(args[0])) return { action, args };
  if (['fill', 'select'].includes(action) && args.length === 2 && SNAPSHOT_REF.test(args[0])) return { action, args };
  if (action === 'press' && args.length === 1 && /^[A-Za-z0-9+_-]{1,80}$/u.test(args[0])) return { action, args };
  fail('BROWSER_ARGUMENTS', 'Unsupported browser action or arguments; use current snapshot element refs.');
}

// Keep the public action and authority contract stable while using the pinned CLI spelling.
export function browserCliCommand(input) {
  const command = browserCommand(input);
  return command.action === 'network' ? { ...command, action: 'requests' } : command;
}

export function createBrowserSessions(ctx, { timeoutMs = 60000, idleMs = 300000,
  workerPath = '/usr/local/lib/forge-browser-worker.mjs' } = {}) {
  const sessions = new Map(), queues = new WeakMap();
  const policyFor = async agent => {
    const policy = await ctx.sandboxPolicy.resolve({ session: agent.session });
    const direct = process.env.FORGE_DEVELOPMENT_MODE === 'direct' ? currentDirectToolPolicy() : policy;
    // Direct mode already resolves the authenticated task via the same guard
    // as Bash. A user's explicit native read-only override remains narrower.
    const override = agent.session.events?.findLast(event => event.type === 'sandbox/mode')?.data?.mode;
    return { ...direct, mode: override === 'read-only' ? 'read-only' : direct.mode,
      workspaceRoot: policy.workspaceRoot, sessionId: agent.session.id };
  };
  async function destroy(agent, error = new Error('Browser session closed.')) {
    const session = sessions.get(agent);
    if (!session) return;
    sessions.delete(agent); if (owners.get(agent) === manager) owners.delete(agent); clearTimeout(session.idle);
    session.pending?.reject(error); session.pending = undefined;
    session.handle.terminate();
    if (!await session.handle.waitForExit(AbortSignal.timeout(10000))) fail('BROWSER_CLEANUP', 'Browser process tree did not stop.');
  }
  async function start(agent, policy, signal) {
    const executable = await ctx.subprocess.resolveExecutable('node', undefined, signal);
    signal?.throwIfAborted();
    const confined = ctx.sandbox.confine([executable, workerPath], policy);
    const handle = ctx.subprocess.spawn({ argv: confined.argv, cwd: '/tmp', graceMs: 1000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 8192 } } });
    const session = { handle, key: identity(policy), taskKey: policy.taskKey, mode: policy.mode, buffer: '', pending: undefined, idle: undefined };
    sessions.set(agent, session);
    owners.set(agent, manager);
    const failed = error => { if (sessions.get(agent) === session) void destroy(agent, error).catch(() => {}); };
    handle.stdin.on('error', failed); handle.stdout.on('error', failed);
    handle.stdout.setEncoding('utf8');
    handle.stdout.on('data', chunk => {
      session.buffer += chunk;
      if (session.buffer.length > 1024 * 1024) return failed(new Error('BROWSER_PROTOCOL_LIMIT'));
      let end;
      while ((end = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, end); session.buffer = session.buffer.slice(end + 1);
        try {
          const value = JSON.parse(line), pending = session.pending;
          if (!pending || value.id !== pending.id || typeof value.output !== 'string') throw new Error('BROWSER_PROTOCOL');
          session.pending = undefined; pending.resolve(value);
        } catch (error) { failed(error); return; }
      }
    });
    handle.done.then(() => failed(new Error(`BROWSER_EXITED: ${handle.collected.stderr?.readFrom(0).text ?? ''}`)), failed);
    return session;
  }
  async function execute(input, exec) {
    const command = browserCommand(input), agent = exec?.agent;
    if (!agent?.session) fail('BROWSER_OWNER', 'Browser requires the current native agent session.');
    const cancelled = () => { void destroy(agent, exec.signal.reason ?? new Error('Browser action cancelled.')).catch(() => {}); };
    exec.signal?.addEventListener('abort', cancelled, { once: true });
    const previous = queues.get(agent) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      exec.signal?.throwIfAborted();
      const policy = await policyFor(agent);
      let session = sessions.get(agent);
      if (session && session.key !== identity(policy)) { await destroy(agent); session = undefined; }
      if (command.action === 'close') { await destroy(agent); return { action: 'close', exitCode: 0, output: 'Browser session closed.', truncated: false }; }
      if (!['read-only', 'workspace-write'].includes(policy.mode)) fail('BROWSER_POLICY', 'Browser requires an enforced read-only or workspace-write sandbox.');
      const remaining = policy.expiresAt === undefined ? Infinity : Date.parse(policy.expiresAt) - Date.now();
      if (!(remaining > 0)) { await destroy(agent); fail('BROWSER_AUTHORITY_EXPIRED', 'Current browser authority expired.'); }
      if (policy.mode === 'read-only' && !BROWSER_READ_ACTIONS.has(command.action)) fail('BROWSER_READ_ONLY', 'This browser action is not authorized by the current read-only task.');
      if (!session && command.action !== 'open') fail('BROWSER_NOT_OPEN', 'No live browser for this agent. Open the authorized page first; prior refs are no longer valid.');
      session ??= await start(agent, policy, exec.signal);
      clearTimeout(session.idle);
      let timer, onAbort;
      try {
        const reply = new Promise((resolve, reject) => {
          const id = randomUUID(); session.pending = { id, resolve, reject };
          onAbort = () => reject(exec.signal.reason ?? new Error('Browser action cancelled.'));
          exec.signal?.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => reject(new Error('BROWSER_TIMEOUT_OR_AUTHORITY_EXPIRED')), Math.min(timeoutMs, remaining));
          if (exec.signal?.aborted) onAbort();
          else session.handle.stdin.write(`${JSON.stringify({ id, ...command })}\n`, error => { if (error) reject(error); });
        });
        const result = await reply;
        // A policy switch during an operation invalidates its session/results.
        if (identity(await policyFor(agent)) !== session.key) fail('BROWSER_POLICY_CHANGED', 'Browser policy changed during the action.');
        const idleBudget = Math.min(idleMs, policy.expiresAt === undefined ? Infinity : Date.parse(policy.expiresAt) - Date.now());
        if (!(idleBudget > 0)) fail('BROWSER_AUTHORITY_EXPIRED', 'Current browser authority expired.');
        session.idle = setTimeout(() => { void destroy(agent).catch(() => {}); }, idleBudget); session.idle.unref?.();
        return { action: command.action, exitCode: Number.isInteger(result.exitCode) ? result.exitCode : -1, output: result.output, truncated: result.truncated === true };
      } catch (error) { await destroy(agent, error); throw error; }
      finally { clearTimeout(timer); exec.signal?.removeEventListener('abort', onAbort); }
    });
    queues.set(agent, task);
    try { return await task; } finally { exec.signal?.removeEventListener('abort', cancelled); }
  }
  const manager = { execute, destroy, dispose: () => Promise.all([...sessions.keys()].map(agent => destroy(agent))),
    reconcile: async (agent, authority) => {
      const session = sessions.get(agent);
      if (session && (!authority || authority.taskKey !== session.taskKey || authority.mode !== session.mode
        || !(Date.parse(authority.expiresAt) > Date.now()))) await destroy(agent);
    },
    closeSession: session => Promise.all([...sessions.keys()].filter(agent => agent.session === session).map(agent => destroy(agent))) };
  return manager;
}

export function registerBrowserTool(ctx, defineTool, options) {
  const manager = createBrowserSessions(ctx, options);
  ctx.tools.register(defineTool({ name: 'browser',
    description: 'Operate one persistent isolated browser belonging to this agent. Use open with HTTP(S) URL, then snapshot for inline page text and element refs. Other actions: goto/URL, click/ref, fill/ref/text, select/ref/value, press/key, check/ref, uncheck/ref, hover/ref, dblclick/ref, go-back, go-forward, reload, tab-list, console, network, close. Snapshot paths printed by open are private; use snapshot instead of filesystem read. Read-only permits open/goto navigation, observations and close; form/element interactions and history/reload require write authority. No shell, arbitrary code, config, profile or custom session. Cancellation, timeout or changed permission destroys the session.',
    parameters: { action: { type: 'string', required: true }, args: { type: 'array', items: { type: 'string' } } },
    output: { schema: { type: 'object', additionalProperties: false,
      properties: { action: { type: 'string', required: true }, exitCode: { type: 'integer', required: true },
        output: { type: 'string', required: true }, truncated: { type: 'boolean', required: true } } },
      render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: manager.execute,
  }));
  ctx.on('session/event', (session, event) => { if (event.type === 'sandbox/mode') void manager.closeSession(session).catch(() => {}); });
  ctx.on('agent/turn-stopping', ({ agent }) => manager.destroy(agent));
  ctx.on('dispose', manager.dispose);
  return manager;
}
export async function apply(ctx) {
  const { defineTool } = await import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  registerBrowserTool(ctx, defineTool);
}
