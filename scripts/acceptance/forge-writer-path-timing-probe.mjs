// Isolated timing instrumentation, never a grant or a model-facing tool.
// Mount the operator-owned config and release directory read-only, outside
// /workspace. Mount a separate writable directory for arrival evidence.
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const name = 'forge-writer-path-timing-probe';
const inject = Object.freeze(['tools']);
const CONFIG_KEYS = ['schemaVersion', 'testOnly', 'dshSessionId', 'toolName', 'filePath', 'nonce', 'timeoutMs', 'releaseDirectory', 'arrivedDirectory'];
const MUTATIONS = new Set(['write', 'edit', 'remove_file', 'copy_file']);
const RELEASE_KEYS = ['schemaVersion', 'operation', 'nonce', 'callId', 'dshSessionId', 'toolName', 'filePath'];

function fail(code, message) {
  throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function bounded(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function relativeFile(value, allowPrefix = false) {
  if (!bounded(value, 1024) || /[\\:]/u.test(value)) return undefined;
  let result = value;
  if (allowPrefix && result.startsWith('/workspace/')) result = result.slice(11);
  if (allowPrefix && result.startsWith('./')) result = result.slice(2);
  if (result.length > 512 || result !== result.normalize('NFC') || result.startsWith('/')
    || result.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  return result;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function controlPath(value, directory) {
  if (!bounded(value, 2048) || !path.isAbsolute(value)
    || path.resolve(value) !== value || inside(path.resolve('/workspace'), value)
    || await realpath(value) !== value) {
    fail('WRITER_TIMING_CONTROL_PATH', 'Control paths must be canonical, outside /workspace, and contain no symlink aliases.');
  }
  const stat = await lstat(value);
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    fail('WRITER_TIMING_CONTROL_PATH', 'The control path has the wrong file type.');
  }
  return stat;
}

async function configuration(raw) {
  if (!exactKeys(raw, CONFIG_KEYS) || raw.schemaVersion !== 1 || raw.testOnly !== true
    || !bounded(raw.dshSessionId, 1024) || !MUTATIONS.has(raw.toolName)
    || !bounded(raw.filePath, 512) || relativeFile(raw.filePath) !== raw.filePath
    || !/^[a-f0-9]{32,64}$/u.test(raw.nonce ?? '')
    || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 25 || raw.timeoutMs > 300_000) {
    fail('WRITER_TIMING_CONFIG', 'An exact test-only session/tool/path/nonce and a bounded timeout are required.');
  }
  await controlPath(raw.releaseDirectory, true);
  await controlPath(raw.arrivedDirectory, true);
  if (inside(raw.releaseDirectory, raw.arrivedDirectory) || inside(raw.arrivedDirectory, raw.releaseDirectory)) {
    fail('WRITER_TIMING_CONTROL_PATH', 'Release and arrival directories must be separate.');
  }
  return Object.freeze({ ...raw });
}

async function readJson(filename) {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192) fail('WRITER_TIMING_CONTROL_FILE', 'Expected one small regular JSON control file.');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

function target(exec, config) {
  return exec?.agent?.session?.id === config.dshSessionId && exec?.name === config.toolName
    && relativeFile(exec?.arguments?.file_path, true) === config.filePath;
}

async function waitForRelease(config, binding, signal) {
  const deadline = performance.now() + config.timeoutMs;
  const releaseFile = path.join(config.releaseDirectory, `${config.nonce}.json`);
  signal.throwIfAborted();
  const arrivedFile = path.join(config.arrivedDirectory, `${config.nonce}.json`);
  const pendingFile = `${arrivedFile}.pending`;
  await writeFile(pendingFile, `${JSON.stringify({
    schemaVersion: 1, status: 'native-execute-waiting', ...binding,
    arrivedAt: new Date().toISOString(), pid: process.pid,
  })}\n`, { flag: 'wx', mode: 0o600 });
  // Publish a complete record without ever overwriting evidence from this nonce.
  try { await link(pendingFile, arrivedFile); } finally { await unlink(pendingFile); }
  for (;;) {
    signal.throwIfAborted();
    if (performance.now() >= deadline) fail('WRITER_TIMING_TIMEOUT', 'Explicit release was not received; the original body was not called.');
    let release;
    try { release = await readJson(releaseFile); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    signal.throwIfAborted();
    if (performance.now() >= deadline) fail('WRITER_TIMING_TIMEOUT', 'Explicit release was not received before the deadline.');
    if (release !== undefined) {
      if (!exactKeys(release, RELEASE_KEYS) || release.schemaVersion !== 1 || release.operation !== 'release'
        || Object.entries(binding).some(([key, value]) => release[key] !== value)) {
        fail('WRITER_TIMING_RELEASE_MISMATCH', 'Release must match the actual nonce, call, session, tool and path.');
      }
      return;
    }
    try { await delay(Math.min(25, Math.max(1, deadline - performance.now())), undefined, { signal }); }
    catch (error) { signal.throwIfAborted(); throw error; }
  }
}

export async function installForgeWriterPathTimingProbe(ctx, rawConfig) {
  const config = await configuration(rawConfig);
  let selected = false;
  let consumed = false;
  return ctx.on('tools/execute', async (exec, next) => {
    if (selected || consumed || !target(exec, config)) return next();
    if (!bounded(exec.callId, 1024) || typeof exec.signal?.throwIfAborted !== 'function') {
      fail('WRITER_TIMING_EXECUTION', 'The native call identity and cancellation signal are required.');
    }
    const tool = ctx.tools.get(exec.name, exec.agent);
    if (typeof tool?.execute !== 'function') fail('WRITER_TIMING_TOOL', 'The native scoped tool definition is unavailable.');
    const original = tool.execute;
    const binding = Object.freeze({ nonce: config.nonce, callId: exec.callId,
      dshSessionId: config.dshSessionId, toolName: config.toolName, filePath: config.filePath });
    let entered = false;
    let active = true;
    const wrapper = async function (args, runExec) {
      if (!active || runExec !== exec || runExec?.callId !== binding.callId
        || !target(runExec, config) || relativeFile(args?.file_path, true) !== binding.filePath) {
        return original.call(this, args, runExec);
      }
      if (entered) fail('WRITER_TIMING_REPLAY', 'This native execution has already entered the one-shot probe.');
      entered = true;
      consumed = true;
      await waitForRelease(config, binding, runExec.signal);
      runExec.signal.throwIfAborted();
      return await original.call(this, args, runExec);
    };
    selected = true;
    tool.execute = wrapper;
    try { return await next(); } finally {
      active = false;
      if (tool.execute === wrapper) tool.execute = original;
      selected = false;
    }
  });
}

async function apply(ctx) {
  const filename = process.env.FORGE_WRITER_PATH_TIMING_PROBE_CONFIG;
  const stat = await controlPath(filename, false);
  if (process.platform !== 'linux' || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    fail('WRITER_TIMING_CONFIG_OWNER', 'Runtime config must be an operator-owned Linux file, not writable by group or others.');
  }
  const config = await configuration(await readJson(filename));
  if (inside(config.arrivedDirectory, filename) || inside(config.releaseDirectory, filename)) {
    fail('WRITER_TIMING_CONTROL_PATH', 'Configuration must be separate from the arrival and release channels.');
  }
  const releaseStat = await lstat(config.releaseDirectory);
  if (releaseStat.uid !== 0 || (releaseStat.mode & 0o022) !== 0) {
    fail('WRITER_TIMING_RELEASE_OWNER', 'The release input directory must be operator-owned and not group/other writable.');
  }
  return installForgeWriterPathTimingProbe(ctx, config);
}

export { name, inject, apply };
