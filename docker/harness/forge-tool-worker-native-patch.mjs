import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'forge-tool-worker-transport-v1';
const BEFORE = 'import { Worker } from "node:worker_threads";';
const AFTER = `import { Worker as NativeWorker } from "node:worker_threads";
import { RemoteWorkflowWorker } from "/usr/local/lib/forge-tool-worker-provider.mjs";
// ${MARKER}: the model program executes inside the credential-free container.
const Worker = process.env.FORGE_TOOL_WORKER_SOCKET ? RemoteWorkflowWorker : NativeWorker;`;

export function patchToolWorkerTransport(source) {
  if (source.includes(MARKER)) {
    if (source.split(AFTER).length !== 2 || source.split(MARKER).length !== 2 || source.includes(BEFORE)) {
      throw new Error('Incomplete tool worker transport patch');
    }
    return source;
  }
  if (source.split(BEFORE).length !== 2 || source.split('this.worker = new Worker(entry, options);').length !== 2) {
    throw new Error('Unsupported native workflow Worker constructor');
  }
  return source.replace(BEFORE, AFTER);
}

export function applyPatch(root) {
  const directory = resolve(root, '@deepseek-ai/dsh-workflow-worker-thread');
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.name !== '@deepseek-ai/dsh-workflow-worker-thread' || pkg.version !== '0.1.1-rc.2') {
    throw new Error('Unsupported native workflow package');
  }
  const file = resolve(directory, 'lib/index.js');
  const before = readFileSync(file, 'utf8');
  const after = patchToolWorkerTransport(before);
  if (after !== before) writeFileSync(file, after);
  return { patch: MARKER, changed: after !== before };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node forge-tool-worker-native-patch.mjs NODE_MODULES_ROOT');
  console.log(JSON.stringify(applyPatch(process.argv[2])));
}
