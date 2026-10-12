import { createRequire } from 'node:module';
import { readFile, lstat, unlink, mkdir } from 'node:fs/promises';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveToolWorker } from './forge-tool-worker.mjs';
import { call } from './forge-tool-worker-wire.mjs';

async function clearStoppedSocket(socketPath) {
  const before = await lstat(socketPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!before) return;
  if (!before.isSocket()) throw new Error('TOOL_WORKER_SOCKET_PATH_UNSAFE');
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => { socket.destroy(); reject(new Error('TOOL_WORKER_ALREADY_RUNNING')); });
    socket.once('error', error => { socket.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(error); });
  });
  const after = await lstat(socketPath);
  if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino) throw new Error('TOOL_WORKER_SOCKET_CHANGED');
  await unlink(socketPath);
}

export async function startToolWorker(config, runtimeRoot = '/opt/forge-harness-runtime') {
  if (!config || !['read-only', 'workspace-write', 'danger-full-access'].includes(config.mode)
    || typeof config.workspaceRoot !== 'string' || typeof config.inputRoot !== 'string'
    || typeof config.socketPath !== 'string') throw new Error('TOOL_WORKER_CONFIGURATION_REQUIRED');
  const require = createRequire(join(runtimeRoot, 'package.json'));
  const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
  const [{ Context }, { SandboxPolicyService }, { SandboxedFileSystem }, { LocalSubprocessRuntime }, { LocalSandboxProvider }, typed] = await Promise.all([
    load('cordis'), load('dsh-sandbox-policy'), load('dsh-fs-sandbox'), load('dsh-subprocess-local'), load('dsh-sandbox-local'),
    import('./forge-typed-file-removal.mjs'),
  ]);
  const ctx = new Context();
  try {
    await ctx.plugin(SandboxPolicyService, { mode: config.mode, workspaceRoot: config.workspaceRoot });
    await ctx.plugin(SandboxedFileSystem, { cwd: config.workspaceRoot, ...config.filesystem });
    await ctx.plugin(LocalSubprocessRuntime);
    await ctx.plugin(LocalSandboxProvider, config.sandbox ?? {});
    const service = await serveToolWorker({ socketPath: config.socketPath, fs: ctx.fs, subprocess: ctx.subprocess,
      sandbox: ctx.sandbox, typed,
      workflowEntry: join(dirname(require.resolve('@deepseek-ai/dsh-workflow-worker-thread')), 'worker.cjs') });
    return { ctx, async close() { await service.close(); await ctx.fiber.dispose(); } };
  } catch (error) { await ctx.fiber.dispose(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length === 4 && process.argv[2] === '--health') {
    const result = await call(process.argv[3], { op: 'fs.capabilities', args: [] }, AbortSignal.timeout(2000));
    if (result.sandboxMode !== 'workspace-write') throw new Error('TOOL_WORKER_HEALTH_MODE_MISMATCH');
    process.exit(0);
  }
  if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('Expected --config <read-only worker configuration>');
  const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
  await mkdir('/tmp/forge-tool-home', { recursive: true, mode: 0o700 });
  await clearStoppedSocket(config.socketPath);
  const worker = await startToolWorker(config);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await worker.close(); };
  process.once('SIGTERM', () => { void close(); }); process.once('SIGINT', () => { void close(); });
}
