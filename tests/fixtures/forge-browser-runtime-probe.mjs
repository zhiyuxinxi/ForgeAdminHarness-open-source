// Synthetic platform fixture: real native subprocess + tool-worker transport +
// production confinement + Chromium. This is not a business/model acceptance.
import assert from 'node:assert/strict';
import http from 'node:http';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Context } from '/app/dsh/vendor/cordis/lib/index.js';
import { LocalSubprocessRuntime } from '/app/dsh/packages/subprocess/subprocess-local/lib/index.js';
import { SubprocessRuntime } from '/app/dsh/packages/subprocess/subprocess/lib/index.js';
import { serveToolWorker } from '/usr/local/lib/forge-tool-worker.mjs';
import { createToolWorkerProviders } from '/usr/local/lib/forge-tool-worker-provider.mjs';
import { createBrowserSessions, reconcileBrowserAuthority } from '/usr/local/lib/forge-browser.mjs';
import { withDirectToolPolicy } from '/usr/local/lib/forge-direct-development.mjs';

process.env.FORGE_DEVELOPMENT_MODE = 'direct';
const socketPath = '/tmp/browser-native-worker.sock';
if (process.argv[2] === 'worker') {
  const ctx = new Context(); await ctx.plugin(LocalSubprocessRuntime);
  const service = await serveToolWorker({ socketPath, subprocess: ctx.subprocess, fs: {}, sandbox: {} });
  process.send('ready');
  process.once('message', async () => { await service.close(); await ctx.fiber.dispose(); process.disconnect(); });
} else {
  const host = fork(new URL(import.meta.url), ['worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const ctx = new Context(); let manager, web;
  try {
    assert.equal((await once(host, 'message'))[0], 'ready');
    const { ToolWorkerSubprocess, ToolWorkerSandbox } = createToolWorkerProviders({ SubprocessRuntime,
      FileSystem: class {}, FsError: Error, SandboxProvider: class {}, SandboxUnavailableError: Error }, { socketPath });
    await ctx.plugin(ToolWorkerSubprocess);
    const facade = { subprocess: ctx.subprocess, sandbox: new ToolWorkerSandbox(), sandboxPolicy: {
      resolve: ({ session }) => ({ mode: 'workspace-write', workspaceRoot: '/workspace', sessionId: session.id }),
    } };
    manager = createBrowserSessions(facade, { timeoutMs: 20000 });
    web = http.createServer((_request, response) => response.end('<title>Platform browser fixture</title><label>Name<input aria-label="Name"></label><button>Save</button>'));
    web.listen(18080, '127.0.0.1'); await once(web, 'listening');
    const first = { session: { id: 'first', events: [] } }, second = { session: { id: 'second', events: [] } };
    const authority = { mode: 'workspace-write', workspaceRoot: '/workspace', taskKey: 'synthetic-platform-task',
      expiresAt: new Date(Date.now() + 120000).toISOString() };
    const call = (agent, action, args = [], signal) => withDirectToolPolicy(authority,
      () => manager.execute({ action, args }, { agent, signal }));
    const opened = await call(first, 'open', ['http://127.0.0.1:18080']);
    assert.equal(opened.exitCode, 0, opened.output);
    const snapshot = await call(first, 'snapshot');
    const ref = /textbox "Name" \[ref=(e\d+)\]/u.exec(snapshot.output)?.[1];
    assert.ok(ref, snapshot.output);
    assert.equal((await call(first, 'fill', [ref, 'retained-across-native-calls'])).exitCode, 0);
    assert.match((await call(first, 'snapshot')).output, /retained-across-native-calls/u);
    assert.equal((await call(second, 'open', ['http://127.0.0.1:18080'])).exitCode, 0);
    assert.doesNotMatch((await call(second, 'snapshot')).output, /retained-across-native-calls/u);
    await call(first, 'close');
    assert.equal((await call(second, 'snapshot')).exitCode, 0);
    await reconcileBrowserAuthority(second, { ...authority, mode: 'read-only' });
    await assert.rejects(call(second, 'snapshot'), { code: 'BROWSER_NOT_OPEN' });
    process.stdout.write(JSON.stringify({ status: 'passed', nativeToolWorker: true, realChromium: true,
      retainedState: true, isolatedAgents: true, closePreservesOtherAgent: true, downgradeCleans: true }) + '\n');
  } finally {
    await manager?.dispose(); web?.close(); await ctx.fiber.dispose();
    if (host.connected) { const exited = once(host, 'exit'); host.send('close'); await exited; }
  }
}
