import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { call, callSync, exchange, frames, send } from './forge-tool-worker-wire.mjs';

export function collectedSnapshotRead(snapshot, fromByte) {
  const buffer = Buffer.from(snapshot.bytes, 'base64');
  const windowStart = snapshot.total - buffer.length;
  const lossy = fromByte < windowStart;
  return { text: (lossy ? buffer : buffer.subarray(fromByte - windowStart)).toString('utf8'),
    nextOffset: snapshot.total, lossy, ...(snapshot.spillPath === undefined ? {} : { spillPath: snapshot.spillPath }) };
}
export function createToolWorkerProviders({ FileSystem, FsError, SubprocessRuntime, SandboxProvider, SandboxUnavailableError }, { socketPath }) {
  const rpc = (op, args, signal) => call(socketPath, { op, args }, signal);
  const sync = (op, args) => callSync(socketPath, { op, args });
  class ToolWorkerFileSystem extends FileSystem {
    constructor(ctx) { super(ctx); this.workerSandboxMode = sync('fs.capabilities', []).sandboxMode; }
    get sandboxMode() { return this.workerSandboxMode; }
    async invoke(op, args, signal) {
      try { return await rpc(`fs.${op}`, args, signal); }
      catch (error) {
        if (typeof error.code === 'string' && error.code.startsWith('FS_')) throw new FsError(error.message, error.code);
        throw error;
      }
    }
    resolve(path, options = {}) { return this.invoke('resolve', [path, { cwd: options.cwd }], options.signal); }
    processPath(target) { return target.processPath; }
    fileUrl(target) { return target.fileUrl; }
    contains(parent, child) { return sync('fs.contains', [parent, child]); }
    stat(target, signal) { return this.invoke('stat', [target], signal); }
    lstat(path, options, signal) { return this.invoke('lstat', [path, options], signal); }
    readText(target, signal) { return this.invoke('readText', [target], signal); }
    async readBytes(target, signal, maxBytes) { return Buffer.from(await this.invoke('readBytes', [target, maxBytes], signal), 'base64'); }
    listDir(target, signal) { return this.invoke('listDir', [target], signal); }
    writeText(target, content, expected, signal, policy) { return this.invoke('writeText', [target, content, expected, policy], signal); }
    editText(target, edit, expected, signal, policy) { return this.invoke('editText', [target, edit, expected, policy], signal); }
    async typedTool(kind, ctx, args, exec, roots) {
      const { removalPath, referenceCopyPaths } = await import('./forge-typed-file-removal.mjs');
      const paths = kind === 'remove' ? removalPath(args, roots.workspaceRoot)
        : referenceCopyPaths(args, roots.workspaceRoot, roots.inputRoot);
      const policy = await ctx.sandboxPolicy.resolve(exec?.agent ? { session: exec.agent.session } : {});
      const target = await this.resolve(paths.absolute, { cwd: roots.workspaceRoot, signal: exec?.signal });
      const targets = kind === 'remove' ? [['fs/edit-intent', target]] : [
        ['fs/edit-intent', await this.resolve(paths.sourceAbsolute, { cwd: roots.inputRoot, signal: exec?.signal })],
        ['fs/write-intent', target],
      ];
      const intents = [];
      for (const [event, resolved] of targets) intents.push({ event, targetKey: resolved.targetKey,
        intent: await ctx.waterfall(event, resolved, exec, () => undefined) });
      const reply = await rpc(`typed.${kind}`, [{ args, roots, policy, intents }], exec?.signal);
      for (const observation of reply.observations) ctx.emit(observation.event, observation.target, observation.observation, exec);
      return reply.result;
    }
    removeObservedFile(ctx, args, exec, roots) { return this.typedTool('remove', ctx, args, exec, roots); }
    copyReferenceFile(ctx, args, exec, roots) { return this.typedTool('copy', ctx, args, exec, roots); }
    async streamText(target, signal) {
      return (async function* () {
        try {
          for await (const frame of exchange(socketPath, { op: 'fs.streamText', args: [target] }, signal)) {
            if (frame.kind !== 'chunk') throw new Error('TOOL_WORKER_INVALID_TEXT_CHUNK');
            yield frame.text;
          }
        } catch (error) {
          if (typeof error.code === 'string' && error.code.startsWith('FS_')) throw new FsError(error.message, error.code);
          throw error;
        }
      })();
    }
  }
  class ToolWorkerSandbox extends SandboxProvider {
    confine(argv, policy) {
      // The existing Linux chain has at most two 5s probes. The bridge adds
      // only a 1s transport ceiling; it never retries or changes runner budgets.
      try { return callSync(socketPath, { op: 'sandbox.confine', args: [argv, policy] }, 11000); }
      catch (error) {
        if (error.code === 'SANDBOX_UNAVAILABLE') throw new SandboxUnavailableError(policy.mode, error.message);
        throw error;
      }
    }
  }
  class ToolWorkerSubprocess extends SubprocessRuntime {
    live = new Set();
    constructor(ctx) {
      super(ctx);
      ctx.effect(() => () => this.disposeManagedProcesses());
    }
    resolveExecutable(command, env, signal) { return rpc('process.resolveExecutable', [command, env], signal); }
    spawn(spec) {
      spec.signal?.throwIfAborted();
      const { signal, ...serializable } = spec;
      const { id, pid } = sync('process.spawn', [serializable]);
      const watchController = new AbortController();
      const stdout = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined;
      const stderr = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined;
      let resolveDone, rejectDone;
      let settled = false;
      let snapshots;
      let treeExited = false, resolveTree, rejectTree;
      const treeExit = new Promise((resolve, reject) => { resolveTree = resolve; rejectTree = reject; });
      treeExit.catch(() => {});
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      const terminate = () => { if (!treeExited) void rpc('process.terminate', [id]).catch(rejectDone); };
      signal?.addEventListener('abort', terminate, { once: true });
      const handle = { pid, stdout, stderr, done, terminate,
        waitForExit: async abort => {
          if (treeExited) return true; if (abort?.aborted) return false;
          if (!abort) return treeExit;
          let listener;
          const aborted = new Promise(resolve => { listener = () => resolve(false); abort.addEventListener('abort', listener, { once: true }); });
          try { return await Promise.race([treeExit, aborted]); } finally { abort.removeEventListener('abort', listener); }
        },
        collected: {},
      };
      if (spec.stdio.stdin === 'pipe') handle.stdin = new Writable({
        write(chunk, _encoding, callback) { rpc('process.stdin', [id, Buffer.from(chunk).toString('base64')]).then(() => callback(), callback); },
        final(callback) { rpc('process.stdin', [id, null]).then(() => callback(), callback); },
      });
      for (const name of ['stdout', 'stderr']) if (typeof spec.stdio[name] === 'object') {
        handle.collected[name] = { readFrom: offset => snapshots ? collectedSnapshotRead(snapshots[name], offset)
          : sync('process.readFrom', [id, name, offset]) };
      }
      const entry = { handle, watchController, dispose: async () => {
        signal?.removeEventListener('abort', terminate);
        if (!treeExited) { await rpc('process.terminate', [id]); await treeExit; }
        watchController.abort();
      } };
      this.live.add(entry);
      (async () => {
        try {
          for await (const frame of exchange(socketPath, { op: 'process.watch', args: [id] }, watchController.signal)) {
            if (frame.kind === 'stdout' || frame.kind === 'stderr') {
              const stream = frame.kind === 'stdout' ? stdout : stderr;
              if (!stream) throw new Error('TOOL_WORKER_UNEXPECTED_PROCESS_PIPE');
              if (!stream.write(Buffer.from(frame.bytes, 'base64'))) await once(stream, 'drain');
            } else if (frame.kind === 'done') {
              settled = true;
              snapshots = frame.collected;
              stdout?.end(); stderr?.end();
              if (frame.outcome.error) { const error = new Error(frame.outcome.error.message); error.code = frame.outcome.error.code; rejectDone(error); }
              else resolveDone(frame.outcome.value);
            } else if (frame.kind === 'tree-exited') {
              treeExited = true; resolveTree(true); this.live.delete(entry); signal?.removeEventListener('abort', terminate);
              watchController.abort();
            } else throw new Error('TOOL_WORKER_INVALID_PROCESS_EVENT');
          }
        } catch (error) {
          stdout?.destroy(settled ? undefined : error); stderr?.destroy(settled ? undefined : error); rejectDone(error); rejectTree(error);
        }
      })();
      // Covers cancellation between synchronous spawn and listener attachment.
      if (signal?.aborted) terminate();
      return handle;
    }
    async spawnTerminal(spec) {
      const { signal, ...serializable } = spec;
      signal?.throwIfAborted();
      const { id, pid } = await rpc('terminal.spawn', [serializable], signal);
      const output = new PassThrough();
      const controller = new AbortController();
      let resolveDone, rejectDone;
      const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
      let termination;
      let settled = false;
      let treeExited = false, resolveTree, rejectTree;
      const treeExit = new Promise((resolve, reject) => { resolveTree = resolve; rejectTree = reject; });
      treeExit.catch(() => {});
      const terminate = () => termination ??= (async () => {
        if (!settled && !treeExited) await rpc('terminal.terminate', [id]);
        await treeExit;
      })();
      const onAbort = () => { void terminate().catch(rejectDone); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const handle = { pid, output, done, terminate,
        write: text => rpc('terminal.write', [id, text]),
        inspectForeground: () => rpc('terminal.inspectForeground', [id]),
        signalForeground: name => rpc('terminal.signalForeground', [id, name]),
      };
      const entry = { handle, dispose: terminate }; this.live.add(entry);
      (async () => {
        try {
          for await (const frame of exchange(socketPath, { op: 'terminal.watch', args: [id] }, controller.signal)) {
            if (frame.kind === 'output') {
              if (!output.write(Buffer.from(frame.bytes, 'base64'))) await once(output, 'drain');
            } else if (frame.kind === 'done') {
              settled = true; output.end();
              if (frame.outcome.error) rejectDone(new Error(frame.outcome.error.message)); else resolveDone(frame.outcome.value);
            } else if (frame.kind === 'tree-exited') {
              treeExited = true; resolveTree(true); controller.abort();
            }
            else throw new Error('TOOL_WORKER_INVALID_TERMINAL_EVENT');
          }
        } catch (error) { output.destroy(settled ? undefined : error); rejectDone(error); rejectTree(error); }
        finally { signal?.removeEventListener('abort', onAbort); this.live.delete(entry); }
      })();
      if (signal?.aborted) onAbort();
      return handle;
    }
    async disposeManagedProcesses() {
      const entries = [...this.live]; this.live.clear();
      const results = await Promise.allSettled(entries.map(entry => entry.dispose()));
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Tool worker disposal failed');
    }
  }
  return { ToolWorkerFileSystem, ToolWorkerSubprocess, ToolWorkerSandbox };
}

// Exact replacement for the fixed workflow engine's Worker constructor only.
// All child-agent authorization/lifecycle remains in its existing WorkerRun.
// The model script itself and its VM/thread execute in the no-credential worker.
export class RemoteWorkflowWorker extends EventEmitter {
  constructor(_entry, options, socketPath = process.env.FORGE_TOOL_WORKER_SOCKET) {
    super();
    if (!socketPath || !options?.workerData || options.eval || options.execArgv?.length) throw new Error('TOOL_WORKER_INVALID_WORKFLOW_CONFIGURATION');
    this.socket = net.createConnection(socketPath);
    this.ready = once(this.socket, 'connect').then(() => send(this.socket, { op: 'workflow.run', args: [options.workerData] }));
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    (async () => {
      try {
        await this.ready;
        for await (const frame of frames(this.socket)) {
          if (frame.kind === 'message') this.emit('message', frame.message);
          else if (frame.kind === 'worker-error') this.emit('error', new Error(frame.errorInfo.message));
          else if (frame.kind === 'exit') { this.resolveExit(frame.code); this.emit('exit', frame.code); return; }
          else throw new Error(frame.error?.message ?? 'TOOL_WORKER_INVALID_WORKFLOW_EVENT');
        }
        throw new Error('TOOL_WORKER_WORKFLOW_CONNECTION_LOST');
      } catch (error) { this.emit('error', error); this.resolveExit(1); this.emit('exit', 1); }
      finally { this.socket.destroy(); }
    })();
  }
  postMessage(message) { this.ready.then(() => send(this.socket, { kind: 'post', message })).catch(error => this.emit('error', error)); }
  async terminate() {
    if (!this.socket.destroyed) await this.ready.then(() => send(this.socket, { kind: 'terminate' })).catch(() => {});
    return this.exited;
  }
}

export const name = 'forge-tool-worker-provider';
export const inject = ['sandboxPolicy'];
export async function apply(ctx, config) {
  const [filesystem, subprocess, sandbox, { Context }, { LocalSubprocessRuntime }, { LocalBashExecutor }, { SandboxBashExecutor }, { createToolWorkerBashExecutor }] = await Promise.all([
    import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-fs/lib/index.js'),
    import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-subprocess/lib/index.js'),
    import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-sandbox/lib/index.js'),
    import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/cordis/lib/index.js'),
    import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js'),
    import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-bash-local/lib/index.js'),
    import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-bash-sandbox/lib/index.js'),
    import('./forge-tool-worker-bash.mjs'),
  ]);
  const providers = createToolWorkerProviders({ ...filesystem, ...subprocess, ...sandbox }, config);
  const privateContext = new Context();
  await privateContext.plugin(LocalSubprocessRuntime);
  await privateContext.plugin(LocalBashExecutor, { cwd: config.workspaceRoot ?? '/workspace', ...config.bash });
  ctx.effect(() => () => privateContext.fiber.dispose());
  await ctx.plugin(providers.ToolWorkerFileSystem);
  await ctx.plugin(providers.ToolWorkerSubprocess);
  await ctx.plugin(providers.ToolWorkerSandbox);
  await ctx.plugin(createToolWorkerBashExecutor(SandboxBashExecutor, privateContext.shell), { cwd: config.workspaceRoot ?? '/workspace', ...config.bash });
}
