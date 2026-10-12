// Local API fixture only. A child process shares the host filesystem and is
// deliberately NOT accepted as evidence of the deployment's isolation boundary.
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveToolWorker } from '../../docker/harness/forge-tool-worker.mjs';
import { startToolWorker } from '../../docker/harness/forge-tool-worker-start.mjs';
const [runtime, socketPath, cwd, subset] = process.argv.slice(2);
const require = createRequire(join(runtime, 'package.json'));
const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)).href);
if (subset !== 'fs-workflow') {
  const worker = await startToolWorker({ socketPath, workspaceRoot: cwd, inputRoot: join(cwd, 'inputs'), mode: 'workspace-write' }, runtime);
  process.send({ status: 'ready' });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await worker.close(); process.disconnect(); };
  process.on('message', message => { if (message === 'close') void close(); });
  process.on('disconnect', () => { void close(); });
} else {
console.error('fixture: loading fixed native providers');
const [{ Context }, { LocalFileSystem }, subprocessModule] = await Promise.all([
  load('cordis'), load('dsh-fs-local'), subset === 'fs-workflow' ? undefined : load('dsh-subprocess-local'),
]);
const ctx = new Context();
console.error('fixture: providers loaded');
await ctx.plugin(LocalFileSystem, { cwd });
console.error('fixture: filesystem ready');
if (subprocessModule) await ctx.plugin(subprocessModule.LocalSubprocessRuntime);
console.error('fixture: subprocess ready');
const service = await serveToolWorker({ socketPath, fs: ctx.fs, subprocess: ctx.subprocess,
  workflowEntry: join(dirname(require.resolve('@deepseek-ai/dsh-workflow-worker-thread')), 'worker.cjs') });
process.send({ status: 'ready' });
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await service.close(); await ctx.fiber.dispose(); process.disconnect();
}
process.on('message', message => { if (message === 'close') void close(); });
process.on('disconnect', () => { void close(); });
}
