import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { chmod } from 'node:fs/promises';
import { once } from 'node:events';
import { frames, send, wireError } from './forge-tool-worker-wire.mjs';

// The caller supplies the installed native services in the dedicated worker
// container. Never instantiate this endpoint in the credential-bearing native
// container. No operation calls back into its filesystem, environment or exec.
export function nativeCollectorSnapshot(reader) {
  // Fixed 0.1.1-rc.2 LocalSubprocessRuntime exposes its OutputCollector as the
  // actual collected reader. Validate its exact byte window against readFrom;
  // never reconstruct bytes from replacement-decoded text.
  if (!Array.isArray(reader.chunks) || !reader.chunks.every(Buffer.isBuffer)
    || !Number.isSafeInteger(reader.total) || !Number.isSafeInteger(reader.bytes)) throw new Error('TOOL_WORKER_UNKNOWN_COLLECTOR');
  const buffer = Buffer.concat(reader.chunks), observed = reader.readFrom(0);
  if (buffer.length !== reader.bytes || reader.total < buffer.length
    || observed.text !== buffer.toString('utf8') || observed.nextOffset !== reader.total
    || observed.lossy !== (reader.total > buffer.length)) throw new Error('TOOL_WORKER_COLLECTOR_SNAPSHOT_MISMATCH');
  return { bytes: buffer.toString('base64'), total: reader.total,
    ...(observed.spillPath === undefined ? {} : { spillPath: observed.spillPath }) };
}
export async function serveToolWorker({ socketPath, fs, subprocess, sandbox, typed, workflowEntry }) {
  const processes = new Map();
  const sockets = new Set();
  const workflows = new Set();
  const target = async value => ({ ...value, processPath: fs.processPath(value), fileUrl: fs.fileUrl(value) });
  const getProcess = id => {
    const entry = processes.get(id);
    if (!entry) throw new Error('TOOL_WORKER_UNKNOWN_PROCESS');
    return entry;
  };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    const controller = new AbortController();
    socket.once('close', () => controller.abort());
    const signal = controller.signal;
    (async () => {
      const incoming = frames(socket)[Symbol.asyncIterator]();
      const first = await incoming.next();
      if (first.done) return;
      const { op, args = [] } = first.value;
      let value;
      switch (op) {
        case 'fs.capabilities': value = { sandboxMode: fs.sandboxMode }; break;
        case 'sandbox.confine': value = sandbox.confine(...args); break;
        case 'typed.remove':
        case 'typed.copy': {
          const request = args[0];
          const observations = [];
          const context = { fs, sandboxPolicy: { resolve: () => request.policy },
            waterfall: async (event, target) => {
              const observation = request.intents.find(row => row.event === event && row.targetKey === target.targetKey);
              return observation?.intent;
            },
            emit: (event, target, observation) => { observations.push({ event,
              target: { ...target, processPath: fs.processPath(target), fileUrl: fs.fileUrl(target) }, observation }); },
          };
          const execute = op === 'typed.remove' ? typed.removeObservedFile : typed.copyReferenceFile;
          const result = await execute(context, request.args, { signal }, request.roots);
          value = { result, observations }; break;
        }
        case 'fs.resolve': value = await target(await fs.resolve(args[0], { ...args[1], signal })); break;
        case 'fs.stat': value = await fs.stat(args[0], signal); break;
        case 'fs.lstat': value = await fs.lstat(args[0], args[1], signal); break;
        case 'fs.contains': value = fs.contains(...args); break;
        case 'fs.readText': value = await fs.readText(args[0], signal); break;
        case 'fs.readBytes': value = Buffer.from(await fs.readBytes(args[0], signal, args[1])).toString('base64'); break;
        case 'fs.listDir': value = await Promise.all((await fs.listDir(args[0], signal)).map(async entry => ({ ...entry, target: await target(entry.target) }))); break;
        case 'fs.writeText': value = await fs.writeText(args[0], args[1], args[2], signal, args[3]); break;
        case 'fs.editText': value = await fs.editText(args[0], args[1], args[2], signal, args[3]); break;
        case 'fs.streamText':
          for await (const text of await fs.streamText(args[0], signal)) await send(socket, { kind: 'chunk', text });
          socket.end(); return;
        case 'process.resolveExecutable': value = await subprocess.resolveExecutable(args[0], args[1], signal); break;
        case 'process.spawn': {
          const handle = subprocess.spawn(args[0]);
          const id = randomUUID();
          const entry = { handle, outcome: handle.done.then(value => ({ value }), error => ({ error: wireError(error) })), observed: false };
          // A client dying between the synchronous spawn acknowledgement and
          // watch must not orphan a running process. This is not a retry lease.
          entry.unobserved = setTimeout(() => { if (!entry.observed) { handle.terminate(); processes.delete(id); } }, 30000);
          entry.unobserved.unref(); processes.set(id, entry);
          value = { id, pid: handle.pid }; break;
        }
        case 'process.readFrom': value = getProcess(args[0]).handle.collected[args[1]].readFrom(args[2]); break;
        case 'process.terminate': getProcess(args[0]).handle.terminate(); value = null; break;
        case 'process.waitForExit': value = await getProcess(args[0]).handle.waitForExit(signal); break;
        case 'process.stdin': {
          const stdin = getProcess(args[0]).handle.stdin;
          if (!stdin) throw new Error('TOOL_WORKER_STDIN_NOT_PIPE');
          if (args[1] === null) stdin.end();
          else if (!stdin.write(Buffer.from(args[1], 'base64'))) await once(stdin, 'drain');
          value = null; break;
        }
        case 'terminal.spawn': {
          const handle = await subprocess.spawnTerminal(args[0]);
          const id = randomUUID();
          const entry = { handle, terminal: true, outcome: handle.done.then(value => ({ value }), error => ({ error: wireError(error) })), observed: false };
          entry.unobserved = setTimeout(() => { if (!entry.observed) { void handle.terminate(); processes.delete(id); } }, 30000);
          entry.unobserved.unref(); processes.set(id, entry);
          value = { id, pid: handle.pid }; break;
        }
        case 'terminal.write': value = await getProcess(args[0]).handle.write(args[1]); break;
        case 'terminal.inspectForeground': value = await getProcess(args[0]).handle.inspectForeground(); break;
        case 'terminal.signalForeground': value = await getProcess(args[0]).handle.signalForeground(args[1]); break;
        case 'terminal.terminate': value = await getProcess(args[0]).handle.terminate(); break;
        case 'terminal.watch': {
          const entry = getProcess(args[0]);
          if (entry.observed || !entry.terminal) throw new Error('TOOL_WORKER_INVALID_TERMINAL_WATCH');
          entry.observed = true; clearTimeout(entry.unobserved);
          const terminate = () => { void entry.handle.terminate(); }; socket.once('close', terminate);
          try {
            for await (const chunk of entry.handle.output) await send(socket, { kind: 'output', bytes: Buffer.from(chunk).toString('base64') });
            await send(socket, { kind: 'done', outcome: await entry.outcome });
            await entry.handle.terminate();
            await send(socket, { kind: 'tree-exited' });
            await incoming.next();
          } finally {
            socket.off('close', terminate); await entry.handle.terminate(); processes.delete(args[0]);
          }
          socket.end(); return;
        }
        case 'process.watch': {
          const entry = getProcess(args[0]);
          if (entry.observed) throw new Error('TOOL_WORKER_PROCESS_ALREADY_OBSERVED');
          entry.observed = true; clearTimeout(entry.unobserved);
          const terminate = () => entry.handle.terminate(); socket.once('close', terminate);
          try {
            const streams = ['stdout', 'stderr'].map(async name => {
              if (!entry.handle[name]) return;
              for await (const chunk of entry.handle[name]) await send(socket, { kind: name, bytes: Buffer.from(chunk).toString('base64') });
            });
            const outcome = await entry.outcome;
            await Promise.all(streams);
            const collected = Object.fromEntries(Object.entries(entry.handle.collected).map(([name, reader]) => [name, nativeCollectorSnapshot(reader)]));
            await send(socket, { kind: 'done', outcome, collected });
            await entry.handle.waitForExit();
            await send(socket, { kind: 'tree-exited' });
            await incoming.next(); // owner acknowledges terminal facts by closing
          } finally {
            socket.off('close', terminate); entry.handle.terminate();
            await entry.handle.waitForExit(); processes.delete(args[0]);
          }
          socket.end(); return;
        }
        case 'workflow.run': {
          if (!workflowEntry) throw new Error('TOOL_WORKER_WORKFLOW_NOT_INSTALLED');
          // This is the *installed fixed native* script engine. Its thread is
          // inside the isolated container; it is not the isolation boundary.
          const worker = new Worker(workflowEntry, { workerData: args[0], env: {}, execArgv: [] });
          workflows.add(worker);
          const terminate = () => void worker.terminate(); socket.once('close', terminate);
          let sending = Promise.resolve();
          const emit = event => { sending = sending.then(() => send(socket, event)); sending.catch(terminate); };
          worker.on('message', message => emit({ kind: 'message', message }));
          worker.on('error', error => emit({ kind: 'worker-error', errorInfo: wireError(error) }));
          worker.once('exit', code => { emit({ kind: 'exit', code }); sending.finally(() => socket.end()).catch(() => {}); });
          try {
            for (;;) {
              const next = await incoming.next(); if (next.done) break;
              if (next.value.kind === 'post') worker.postMessage(next.value.message);
              else if (next.value.kind === 'terminate') { await worker.terminate(); break; }
              else throw new Error('TOOL_WORKER_INVALID_WORKFLOW_MESSAGE');
            }
          } finally { socket.off('close', terminate); await worker.terminate(); workflows.delete(worker); }
          return;
        }
        default: throw new Error('TOOL_WORKER_UNKNOWN_OPERATION');
      }
      await send(socket, { kind: 'result', value }); socket.end();
    })().catch(async error => {
      if (!socket.destroyed) { try { await send(socket, { error: wireError(error) }); } catch {} socket.end(); }
    });
  });
  server.listen(socketPath); await once(server, 'listening');
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  return { async close() {
    for (const socket of sockets) socket.destroy();
    for (const entry of processes.values()) { clearTimeout(entry.unobserved); entry.handle.terminate(); }
    await Promise.all([...processes.values()].map(entry => entry.terminal ? entry.handle.terminate() : entry.handle.waitForExit()));
    await Promise.all([...workflows].map(worker => worker.terminate()));
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
