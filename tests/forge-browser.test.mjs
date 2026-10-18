import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { browserCommand, browserCliCommand, createBrowserSessions, registerBrowserTool, closeBrowserSession, reconcileBrowserAuthority } from '../docker/harness/forge-browser.mjs';
import { withDirectToolPolicy } from '../docker/harness/forge-direct-development.mjs';
import { describeGovernedTool, isReadExecution, isMutationExecution, createInitialPhaseState, toolDenialReason } from '../docker/harness/forge-phase-budget-guard.mjs';
import { compileForgeTaskExecutionContract } from '../docker/harness/forge-task-execution-contract.mjs';
import { directWorkerConfinement } from '../docker/harness/forge-direct-worker-sandbox.mjs';

function fixture(options = {}) {
  let mode = 'workspace-write', next = 0;
  const handles = [], wraps = [], hooks = new Map();
  const ctx = {
    sandboxPolicy: { resolve: ({ session }) => ({ mode, workspaceRoot: '/workspace', sessionId: session.id }) },
    sandbox: { confine: (argv, policy) => { wraps.push({ argv, policy }); return { argv: ['sandbox', ...argv] }; } },
    subprocess: { resolveExecutable: async () => '/usr/local/bin/node', spawn: spec => {
      let resolveDone, count = 0;
      const stdout = new PassThrough(), done = new Promise(resolve => { resolveDone = resolve; });
      const handle = { id: ++next, spec, stdout, done, collected: {}, requests: [], dead: false,
        terminate() { this.dead = true; setImmediate(() => { stdout.end(); resolveDone({ exitCode: 0 }); }); },
        waitForExit: async () => true,
      };
      handle.stdin = new Writable({ write(bytes, _encoding, callback) {
        const request = JSON.parse(bytes.toString());
        handle.requests.push(request);
        if (request.action !== 'console') setTimeout(() => {
          if (!handle.dead) stdout.write(`${JSON.stringify({ id: request.id, exitCode: 0,
            output: `${handle.id}:${++count}:${request.action}`, truncated: false })}\n`);
        }, 2);
        callback();
      } });
      handles.push(handle); return handle;
    } },
    on: (event, handler) => hooks.set(event, handler), tools: { register: tool => { ctx.tool = tool; } },
  };
  const manager = createBrowserSessions(ctx, { timeoutMs: 1000, ...options });
  const agent = id => ({ session: { id, events: [] } });
  return { ctx, manager, handles, wraps, hooks, agent, setMode: value => { mode = value; } };
}
test('browser accepts literal operations and rejects arbitrary code, flags, endpoints and unsafe URL schemes', () => {
  assert.deepEqual(browserCommand({ action: 'fill', args: ['e12', '$(touch file)'] }), { action: 'fill', args: ['e12', '$(touch file)'] });
  for (const args of [ { action: 'run-code', args: ['() => process.exit()'] }, { action: 'eval', args: ['1'] },
    { action: 'open', args: ['file:///etc/passwd'] }, { action: 'open', args: ['http://user:secret@example.test'] },
    { action: 'open', args: ['http://example.test'], env: {} }, { action: 'click', args: ['--config=bad'] },
    { action: 'click', args: ['getByRole("button")'] }, { action: 'snapshot', args: ['--filename=/workspace/a'] } ]) {
    assert.throws(() => browserCommand(args));
  }
  assert.equal(isReadExecution({ name: 'browser', arguments: { action: 'snapshot' } }), true);
  assert.equal(isMutationExecution({ name: 'browser', arguments: { action: 'fill', args: ['e1', 'x'] } }), true);
  assert.equal(describeGovernedTool('browser').classification, 'argument-dependent');
});
test('same agent reuses one confined worker, concurrent commands serialize and different agents do not share it', async () => {
  const f = fixture(), first = f.agent('a'), second = f.agent('b');
  try {
    assert.match((await f.manager.execute({ action: 'open', args: ['http://example.test'] }, { agent: first })).output, /^1:1:/u);
    const results = await Promise.all(['snapshot', 'click'].map(action => f.manager.execute({ action, ...(action === 'click' ? { args: ['e1'] } : {}) }, { agent: first })));
    assert.match(results[0].output, /^1:2:/u); assert.match(results[1].output, /^1:3:/u);
    assert.match((await f.manager.execute({ action: 'open', args: ['http://example.test'] }, { agent: second })).output, /^2:1:/u);
    assert.equal(f.wraps.length, 2); assert.equal(f.handles[0].spec.argv[0], 'sandbox');
    assert.deepEqual(f.wraps[0].argv, ['/usr/local/bin/node', '/usr/local/lib/forge-browser-worker.mjs']);
    await f.manager.execute({ action: 'close' }, { agent: first });
    assert.equal(f.handles[0].dead, true); assert.equal(f.handles[1].dead, false);
  } finally { await f.manager.dispose(); }
});

test('browser accepts current frame-qualified snapshot refs and rejects malformed refs', () => {
  for (const ref of ['e90', 'f1e90', 'f23e456']) {
    for (const action of ['click', 'dblclick', 'hover', 'check', 'uncheck', 'fill', 'select']) {
      const input = { action, args: [ref, ...(['fill', 'select'].includes(action) ? ['literal value'] : [])] };
      assert.deepEqual(browserCommand(input), input);
    }
  }
  for (const ref of ['f1', 'f1e', 'fe90', 'f-1e90', 'f1f2e90', 'f1e90 >> body', 'f1e90;code', '--ref=f1e90', 'f1e90\n']) {
    assert.throws(() => browserCommand({ action: 'click', args: [ref] }), { code: 'BROWSER_ARGUMENTS' });
  }
});

test('browser maps network to the pinned CLI requests command without widening public arguments', () => {
  assert.deepEqual(browserCommand({ action: 'network' }), { action: 'network', args: [] });
  assert.deepEqual(browserCliCommand({ action: 'network' }), { action: 'requests', args: [] });
  assert.deepEqual(browserCliCommand({ action: 'fill', args: ['f1e90', 'literal value'] }),
    { action: 'fill', args: ['f1e90', 'literal value'] });
  for (const input of [{ action: 'requests' }, { action: 'network', args: ['--clear'] },
    { action: 'network', args: ['1'] }, { action: 'network', config: '/tmp/custom' }]) {
    assert.throws(() => browserCliCommand(input), { code: 'BROWSER_ARGUMENTS' });
  }
});

test('frame-qualified refs reach only the owning worker and retain read-only authority', async () => {
  const f = fixture(), agent = f.agent('frame-owner');
  try {
    await f.manager.execute({ action: 'open', args: ['http://example.test'] }, { agent });
    await f.manager.execute({ action: 'fill', args: ['f1e90', 'literal value'] }, { agent });
    assert.deepEqual(f.handles[0].requests.at(-1).args, ['f1e90', 'literal value']);
    f.setMode('read-only');
    await assert.rejects(f.manager.execute({ action: 'click', args: ['f1e90'] }, { agent }), { code: 'BROWSER_READ_ONLY' });
    assert.equal(f.handles[0].dead, true);
    assert.equal(f.handles.length, 1);
    await assert.rejects(f.manager.execute({ action: 'snapshot' }, { agent }), { code: 'BROWSER_NOT_OPEN' });
  } finally { await f.manager.dispose(); }
});
test('permission downgrade destroys the old browser and rejects write actions without spawning a replacement', async () => {
  const f = fixture(), agent = f.agent('a');
  await f.manager.execute({ action: 'open', args: ['http://example.test'] }, { agent });
  f.setMode('read-only');
  await assert.rejects(f.manager.execute({ action: 'click', args: ['e1'] }, { agent }), { code: 'BROWSER_READ_ONLY' });
  assert.equal(f.handles[0].dead, true); assert.equal(f.handles.length, 1);
  await assert.rejects(f.manager.execute({ action: 'snapshot' }, { agent }), { code: 'BROWSER_NOT_OPEN' });
});
test('timeout and user cancellation terminate the owned tree; cancelled stale refs cannot continue', async () => {
  for (const cancellation of [false, true]) {
    const f = fixture({ timeoutMs: 30 }), agent = f.agent('a'), controller = new AbortController();
    await f.manager.execute({ action: 'open', args: ['http://example.test'] }, { agent });
    const pending = f.manager.execute({ action: 'console' }, { agent, signal: controller.signal });
    if (cancellation) setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending); assert.equal(f.handles[0].dead, true);
    await assert.rejects(f.manager.execute({ action: 'snapshot' }, { agent }), { code: 'BROWSER_NOT_OPEN' });
  }
});
test('native permission change, stopped turn and disposal close matching owners only', async () => {
  const f = fixture(), first = f.agent('a'), second = f.agent('b');
  const manager = registerBrowserTool(f.ctx, value => value);
  await manager.execute({ action: 'open', args: ['http://example.test'] }, { agent: first });
  await manager.execute({ action: 'open', args: ['http://example.test'] }, { agent: second });
  f.hooks.get('session/event')(first.session, { type: 'sandbox/mode', data: { mode: 'read-only' } });
  assert.equal(f.handles[0].dead, true); assert.equal(f.handles[1].dead, false);
  await f.hooks.get('agent/turn-stopping')({ agent: second }); assert.equal(f.handles[1].dead, true);
  await manager.dispose();
});
test('direct authenticated policy cannot override an explicit native read-only mode', async () => {
  const before = process.env.FORGE_DEVELOPMENT_MODE; process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  const f = fixture(), agent = f.agent('a');
  try {
    f.setMode('read-only');
    await withDirectToolPolicy({ mode: 'workspace-write', workspaceRoot: '/workspace' }, () => f.manager.execute({ action: 'open', args: ['http://example.test'] }, { agent }));
    agent.session.events.push({ type: 'sandbox/mode', data: { mode: 'read-only' } });
    await assert.rejects(withDirectToolPolicy({ mode: 'workspace-write', workspaceRoot: '/workspace' }, () => f.manager.execute({ action: 'fill', args: ['e1', 'x'] }, { agent })), { code: 'BROWSER_READ_ONLY' });
    assert.equal(f.handles[0].dead, true);
  } finally { await f.manager.dispose(); if (before === undefined) delete process.env.FORGE_DEVELOPMENT_MODE; else process.env.FORGE_DEVELOPMENT_MODE = before; }
});
test('read-only navigation opens a confined browser while interactions and cancelled navigation remain denied', async () => {
  const f = fixture(), agent = f.agent('read-only');
  f.setMode('read-only');
  try {
    for (const action of ['open', 'goto']) {
      const result = await f.manager.execute({ action, args: ['http://example.test/forge/'] }, { agent });
      assert.match(result.output, new RegExp(`:${action}$`, 'u'));
    }
    assert.match((await f.manager.execute({ action: 'snapshot' }, { agent })).output, /:snapshot$/u);
    assert.equal(f.wraps.length, 1);
    assert.equal(f.wraps[0].policy.mode, 'read-only');
    for (const command of [{ action: 'click', args: ['e1'] }, { action: 'fill', args: ['e1', 'value'] },
      { action: 'press', args: ['Enter'] }, { action: 'reload' }]) {
      await assert.rejects(f.manager.execute(command, { agent }), { code: 'BROWSER_READ_ONLY' });
    }
    await assert.rejects(f.manager.execute({ action: 'open', args: ['http://example.test/forge/'] },
      { agent: f.agent('cancelled'), signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(f.handles.length, 1, 'cancelled navigation must not spawn a worker');
  } finally { await f.manager.dispose(); }
});

test('authenticated read-only browser navigation passes both request ceilings while code writes and stopped requests remain denied', () => {
  const before = process.env.FORGE_DEVELOPMENT_MODE; process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  try {
    for (const actionCeiling of ['workspace-write', 'read-only']) {
      const taskContract = compileForgeTaskExecutionContract({ prompt: '只读检查公共验证实例的登录页面是否真正显示，不修改代码',
        actionCeiling, taskProfiles: [actionCeiling === 'read-only' ? 'read-only-review' : 'project-files'],
        ownedPaths: actionCeiling === 'read-only' ? [] : ['.'] }, { developmentMode: 'direct' });
      const state = Object.assign(createInitialPhaseState(), { taskContract, taskIntent: taskContract, actionCeiling,
        promptReadOnlyConstraint: true, protectedExecutionContextValidated: true,
        executionContextStatus: 'ready', executionTestOnly: false,
        executionAuthorityClass: actionCeiling === 'read-only' ? 'production-read-only' : 'production-task-writer',
        executionIdentity: { taskId: 'readonly-browser' }, executionContextExpiresAt: new Date(Date.now() + 60000).toISOString() });
      for (const action of ['open', 'goto']) {
        const execution = { name: 'browser', arguments: { action, args: ['http://example.test/forge/'] }, callId: `browser-${action}` };
        assert.equal(isReadExecution(execution), true);
        assert.equal(isMutationExecution(execution), false);
        assert.equal(toolDenialReason(state, execution), undefined);
        assert.match(toolDenialReason(state, { ...execution, signal: AbortSignal.abort() }), /stopped/u);
      }
      assert.match(toolDenialReason(state, { name: 'browser', arguments: { action: 'click', args: ['e1'] }, callId: 'browser-write' }), /read-only/u);
      assert.match(toolDenialReason(state, { name: 'write', arguments: { file_path: 'forge-admin-ui/src/views/example.vue', content: 'changed' }, callId: 'code-write' }), /read-only/u);
    }
  } finally { if (before === undefined) delete process.env.FORGE_DEVELOPMENT_MODE; else process.env.FORGE_DEVELOPMENT_MODE = before; }
});

test('browser guard requires fresh authenticated authority and denies read-only, paused or unknown-context writes', () => {
  const before = process.env.FORGE_DEVELOPMENT_MODE; process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  try {
    const taskContract = compileForgeTaskExecutionContract({ prompt: '检查并验证页面表单', actionCeiling: 'workspace-write',
      taskProfiles: ['project-files'], ownedPaths: ['.'] }, { developmentMode: 'direct' });
    const state = Object.assign(createInitialPhaseState(), { taskContract, taskIntent: taskContract, actionCeiling: 'workspace-write',
      protectedExecutionContextValidated: true, executionContextStatus: 'ready', executionTestOnly: false,
      executionAuthorityClass: 'production-task-writer', executionIdentity: { taskId: 'a' },
      executionContextExpiresAt: new Date(Date.now() + 60000).toISOString() });
    const exec = { name: 'browser', arguments: { action: 'click', args: ['e1'] }, callId: 'browser-one' };
    assert.equal(toolDenialReason(state, exec), undefined);
    state.promptReadOnlyConstraint = true;
    assert.match(toolDenialReason(state, exec), /read-only or stopped/u);
    assert.equal(toolDenialReason(state, { ...exec, arguments: { action: 'snapshot' } }), undefined);
    state.promptReadOnlyConstraint = false;
    assert.match(toolDenialReason(state, { ...exec, signal: AbortSignal.abort() }), /stopped/u);
    state.executionContextExpiresAt = new Date(0).toISOString();
    assert.match(toolDenialReason(state, exec), /authenticated/u);
    assert.match(toolDenialReason(undefined, exec), /authenticated/u);
  } finally { if (before === undefined) delete process.env.FORGE_DEVELOPMENT_MODE; else process.env.FORGE_DEVELOPMENT_MODE = before; }
});
test('signed task identity changes or denied guard close prior sessions; unchanged renewal preserves them and expiry cleans up', async () => {
  const before = process.env.FORGE_DEVELOPMENT_MODE; process.env.FORGE_DEVELOPMENT_MODE = 'direct';
  const f = fixture(), agent = f.agent('a');
  const authority = { mode: 'workspace-write', workspaceRoot: '/workspace', taskKey: 'task-a', expiresAt: new Date(Date.now() + 10000).toISOString() };
  const invoke = (command, grant = authority) => withDirectToolPolicy(grant, () => f.manager.execute(command, { agent }));
  try {
    await invoke({ action: 'open', args: ['http://example.test'] });
    const renewed = { ...authority, expiresAt: new Date(Date.now() + 20000).toISOString() };
    await reconcileBrowserAuthority(agent, renewed);
    assert.match((await invoke({ action: 'snapshot' }, renewed)).output, /^1:2:/u);
    await reconcileBrowserAuthority(agent, { ...renewed, taskKey: 'different-task' });
    assert.equal(f.handles[0].dead, true);
    await invoke({ action: 'open', args: ['http://example.test'] });
    await closeBrowserSession(agent); assert.equal(f.handles[1].dead, true);
    await invoke({ action: 'open', args: ['http://example.test'] }, { ...authority, expiresAt: new Date(Date.now() + 50).toISOString() });
    await new Promise(resolve => setTimeout(resolve, 70)); assert.equal(f.handles[2].dead, true);
  } finally { await f.manager.dispose(); if (before === undefined) delete process.env.FORGE_DEVELOPMENT_MODE; else process.env.FORGE_DEVELOPMENT_MODE = before; }
});
test('private proc is restricted to the exact trusted browser worker; ordinary and lookalike argv preserve static proc', () => {
  const filesystem = { realpathSync: value => value, readdirSync: () => [], lstatSync: () => { throw new Error('not needed'); } };
  const policy = { mode: 'workspace-write', workspaceRoot: '/workspace' };
  const allowed = directWorkerConfinement(['/usr/local/bin/node', '/usr/local/lib/forge-browser-worker.mjs'], policy, { filesystem }).argv;
  assert.ok(allowed.includes('--unshare-pid')); assert.equal(allowed[allowed.indexOf('/proc') - 1], '--proc');
  for (const argv of [['node', '/usr/local/lib/forge-browser-worker.mjs'],
    ['/usr/local/bin/node', '/workspace/forge-browser-worker.mjs'],
    ['/usr/local/bin/node', '/usr/local/lib/forge-browser-worker.mjs', '--extra'],
    ['bash', '-c', '/usr/local/bin/node /usr/local/lib/forge-browser-worker.mjs']]) {
    const value = directWorkerConfinement(argv, { ...policy, browser: true }, { filesystem }).argv;
    assert.equal(value[value.indexOf('/proc') - 1], '--tmpfs');
    assert.equal(value.includes('--proc'), false);
  }
});

test('browser private proc restores sensitive masks and readonly paths; ordinary commands keep static proc', () => {
  const filesystem = { realpathSync: value => value, readdirSync: () => [] };
  const policy = { mode: 'workspace-write', workspaceRoot: '/workspace' };
  const options = { filesystem, systemPathExists: () => true };
  const browser = directWorkerConfinement(['/usr/local/bin/node', '/usr/local/lib/forge-browser-worker.mjs'], policy, options).argv;
  for (const name of ['bus', 'fs', 'irq', 'sys', 'sysrq-trigger']) {
    assert.ok(browser.some((value, i) => value === '--ro-bind' && browser[i + 1] === `/proc/${name}` && browser[i + 2] === `/proc/${name}`));
  }
  for (const name of ['interrupts', 'kcore', 'keys', 'latency_stats', 'sched_debug', 'timer_list', 'timer_stats']) {
    assert.ok(browser.some((value, i) => value === '--ro-bind' && browser[i + 1] === '/dev/null' && browser[i + 2] === `/proc/${name}`));
  }
  const ordinary = directWorkerConfinement(['/bin/sh', '-c', 'true'], policy, options).argv;
  assert.equal(ordinary.includes('--proc'), false);
  for (const command of [browser, ordinary]) {
    for (const target of ['/sys/firmware', '/sys/devices/virtual/powercap']) {
      assert.ok(command.some((value, i) => value === '--tmpfs' && command[i + 1] === target && command[i + 2] === '--remount-ro'));
    }
  }
});
