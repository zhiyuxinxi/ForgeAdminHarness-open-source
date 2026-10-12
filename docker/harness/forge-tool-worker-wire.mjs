// Fixed, local tool-service transport. The container mount/PID boundary, not
// this protocol or a path filter, is responsible for credential isolation.
import net from 'node:net';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_FRAME = 64 * 1024 * 1024;
export function encode(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME) throw new Error('TOOL_WORKER_FRAME_TOO_LARGE');
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}
export async function* frames(socket) {
  let pending = Buffer.alloc(0);
  for await (const bytes of socket) {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= 4) {
      const length = pending.readUInt32BE();
      if (length > MAX_FRAME) throw new Error('TOOL_WORKER_FRAME_TOO_LARGE');
      if (pending.length < length + 4) break;
      const body = pending.subarray(4, length + 4);
      pending = pending.subarray(length + 4);
      yield JSON.parse(body.toString('utf8'));
    }
  }
  if (pending.length) throw new Error('TOOL_WORKER_TRUNCATED_FRAME');
}
export async function send(socket, value) {
  if (!socket.write(encode(value))) await once(socket, 'drain');
}
export function wireError(error) {
  return { name: error?.name ?? 'Error', message: String(error?.message ?? error),
    ...(typeof error?.code === 'string' ? { code: error.code } : {}) };
}
export function throwWire(error) {
  const failure = new Error(error.message); failure.name = error.name;
  if (error.code) failure.code = error.code;
  throw failure;
}
export async function* exchange(socketPath, request, signal) {
  signal?.throwIfAborted();
  const socket = net.createConnection(socketPath);
  const abort = () => socket.destroy(signal.reason ?? new Error('Aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await once(socket, 'connect');
    await send(socket, request);
    for await (const frame of frames(socket)) {
      if (frame.error) throwWire(frame.error);
      yield frame;
    }
  } finally {
    signal?.removeEventListener('abort', abort); socket.destroy();
  }
}
export async function call(socketPath, request, signal) {
  for await (const reply of exchange(socketPath, request, signal)) {
    if (reply.kind !== 'result') throw new Error('TOOL_WORKER_UNEXPECTED_REPLY');
    return reply.value;
  }
  throw new Error('TOOL_WORKER_MISSING_REPLY');
}
export function callSync(socketPath, request, timeoutMs = 5000) {
  // Native spawn() and collector.readFrom() are synchronous. A fixed helper
  // waits for their actual worker result; it never evaluates caller code.
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 11000) throw new Error('TOOL_WORKER_INVALID_DEADLINE');
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--call', socketPath, String(timeoutMs)], {
    input: JSON.stringify(request), encoding: 'utf8', maxBuffer: MAX_FRAME,
    env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {},
    windowsHide: true,
    timeout: timeoutMs + 100,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('TOOL_WORKER_BRIDGE_FAILED');
  const reply = JSON.parse(result.stdout);
  if (reply.error) throwWire(reply.error);
  return reply.value;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== '--call' || process.argv.length !== 5) throw new Error('Invalid bridge invocation');
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const timeoutMs = Number(process.argv[4]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 11000) throw new Error('Invalid bridge deadline');
  try { process.stdout.write(JSON.stringify({ value: await call(process.argv[3], request, AbortSignal.timeout(timeoutMs)) })); }
  catch (error) { process.stdout.write(JSON.stringify({ error: wireError(error) })); }
}
