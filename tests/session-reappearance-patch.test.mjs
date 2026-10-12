import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { applyPatch, patchSessionReappearance } from '../docker/harness/forge-session-reappearance-patch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.FORGE_TEST_NATIVE_RUNTIME || resolve(root, 'tmp/runtime-deps-ci');
const nativeRequire = createRequire(resolve(runtime, 'package.json'));
const nativePath = nativeRequire.resolve('@deepseek-ai/dsh-client-runtime/client');
const packageBytes = await readFile(nativeRequire.resolve('@deepseek-ai/dsh-client-runtime/package.json'));
const pkg = JSON.parse(packageBytes);
assert.equal(pkg.name, '@deepseek-ai/dsh-client-runtime');
assert.equal(pkg.version, '0.1.1-rc.2');
const nativeBytes = await readFile(nativePath);
let source = nativeBytes.toString('utf8');
if (process.env.FORGE_TEST_NATIVE_CAPTURE) {
  const capture = JSON.parse(await readFile(process.env.FORGE_TEST_NATIVE_CAPTURE, 'utf8'));
  assert.equal(capture.remoteExitCode, 0);
  source = JSON.parse(capture.stdout).source;
  assert.equal(createHash('sha256').update(source).digest('hex').slice(0, 8), '26b82aa9');
}
const patched = patchSessionReappearance(source);
if (process.env.FORGE_TEST_NATIVE_RUNTIME) {
  assert.equal(patched, source, 'the installed native runtime must contain the complete patch');
}

function section(text, start, end) {
  const offset = text.indexOf(start);
  assert.notEqual(offset, -1, `missing native section: ${start}`);
  assert.equal(text.indexOf(start, offset + start.length), -1, `duplicate native section: ${start}`);
  const finish = text.indexOf(end, offset + start.length);
  assert.notEqual(finish, -1, `missing native section end: ${start}`);
  return text.slice(offset, finish + end.length);
}

function loadNativeClasses(text) {
  const anchor = '\t\texports.SessionRuntime = SessionRuntime;';
  assert.equal(text.split(anchor).length, 2);
  let exported;
  // Run the whole real native bundle. Only test-only export aliases are added;
  // the constructors, lifecycle handlers, and baseline merging stay native.
  vm.runInNewContext(text.replace(anchor, anchor
    + '\n\t\texports.__Session = Session;\n\t\texports.__SessionManager = SessionManager;'), {
    window: { __ModuleLoader__: { load({ factory }) {
      exported = factory((name) => {
        // Registration-only services are not instantiated by these data tests.
        if (name === '@deepseek-ai/cordis') return { Service: class {} };
        if (name === '@deepseek-ai/dsh-client-ui-slots') return {};
        throw new Error('Unexpected external native dependency: ' + name);
      });
    } } },
    queueMicrotask, setTimeout, clearTimeout, AbortController,
  }, { filename: nativePath, timeout: 3000 });
  return exported;
}
const classes = loadNativeClasses(patched);
const SID = 'session-reappearance-native-fixture';
const summary = (id = SID) => ({ sessionId: id, running: false, blank: false, updatedAt: 1, cwd: '/workspace' });

// Use the native host producer callbacks and WebSocket envelope function;
// this guards the real carrier contract instead of hand-writing an envelope.
const proxyDirectory = dirname(nativeRequire.resolve('@deepseek-ai/dsh-host-apiproxy'));
const proxySource = await readFile(join(proxyDirectory, 'types/api-proxy.js'), 'utf8');
const connectionSource = await readFile(nativeRequire.resolve('@deepseek-ai/dsh-client-connection'), 'utf8');
const hostSection = proxySource.slice(proxySource.indexOf('host(_request, signal) {'));
const eventStart = hostSection.indexOf("ctx.on('session/created', (session) => {");
const eventEnd = hostSection.indexOf("ctx.on('agent/status'", eventStart);
assert.ok(eventStart >= 0 && eventEnd > eventStart);
const { resolveSessionPreset } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-agent-presets')).href);
const { serverRequestSchema } = await import(pathToFileURL(join(proxyDirectory, 'types/api/rpc.schema.js')).href);
const { hostFrameSchema } = await import(pathToFileURL(join(proxyDirectory, 'types/api/events.schema.js')).href);
const callbacks = new Map();
const frames = [];
const producer = vm.createContext({ randomUUID, RpcId: (id) => id, resolveSessionPreset,
  ctx: { on(event, callback) { callbacks.set(event, callback); } },
  queue: { push(frame) { frames.push(frame); } },
});
vm.runInContext([
  section(proxySource, 'function frame(payload) {', '\n}'),
  section(proxySource, 'function sessionBlank(session) {', '\n}'),
  section(proxySource, 'function sessionListFields(header, events = []) {', '\n}'),
  section(connectionSource, 'function serverRequest(frame) {', '\n}'),
  '[' + hostSection.slice(eventStart, eventEnd) + ']',
].join('\n'), producer);
function event(kind, id = SID) {
  callbacks.get(kind)({ id, header: { cwd: '/workspace' }, events: [{ type: 'turn/start' }] });
  const envelope = producer.serverRequest(frames.pop());
  serverRequestSchema.parse(envelope);
  hostFrameSchema.parse(envelope.payload);
  assert.equal(envelope.method, envelope.payload.type);
  return envelope;
}
const added = (id = SID) => event('session/created', id);
const removed = () => event('session/disposed');

async function fixture() {
  let list = async () => ({ result: { ok: true, value: { items: [summary()] } } });
  const manager = new classes.__SessionManager({ sessions: { list: (...args) => list(...args) } }, {}, SID);
  await manager.refreshList();
  const session = manager.get(SID);
  assert.equal(session instanceof classes.__Session, true);
  assert.equal(session.getSnapshot().removed, false);
  return { manager, session, setList(fn) { list = fn; } };
}

test('pinned session reappearance patch installs idempotently and rejects unsupported or partial sources', async t => {
  const temporary = await mkdtemp(join(os.tmpdir(), 'forge-session-reappearance-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = join(temporary, '@deepseek-ai/dsh-client-runtime');
  const file = join(directory, 'lib/client.js');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(join(directory, 'package.json'), packageBytes);
  await writeFile(file, source);
  assert.deepEqual(applyPatch(temporary), { patch: 'forge-session-reappearance-v1', changed: source !== patched });
  assert.equal(await readFile(file, 'utf8'), patched);
  assert.deepEqual(applyPatch(temporary), { patch: 'forge-session-reappearance-v1', changed: false });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ ...pkg, version: 'unknown' }));
  assert.throws(() => applyPatch(temporary), /Unsupported Harness client runtime/);
  assert.equal(await readFile(file, 'utf8'), patched);
  assert.deepEqual(await readFile(nativePath), nativeBytes, 'shared native cache stays untouched');
  assert.equal(patchSessionReappearance(patched), patched);
  assert.throws(() => patchSessionReappearance('unknown source'), /Unsupported/);
  assert.throws(() => patchSessionReappearance(source + source), /Unsupported|Incomplete/);
  assert.throws(() => patchSessionReappearance(patched.replace('if (presentIds.has(s.sessionId)) session.handlePresent();', '')), /Incomplete/);
});

test('native disposal and same identity creation release the old model lock', async () => {
  const { manager, session } = await fixture();
  manager.handleHostEnvelope(removed());
  assert.equal(session.getSnapshot().removed, true);
  manager.handleHostEnvelope(added());
  assert.equal(manager.get(SID), session);
  assert.equal(session.getSnapshot().removed, false);
  manager.handleHostEnvelope(removed());
  assert.equal(session.getSnapshot().removed, true, 'a later real disposal still locks the session');
});

test('fresh same identity list presence releases the old model lock', async () => {
  const { manager, session } = await fixture();
  manager.handleHostEnvelope(removed());
  await manager.refreshList();
  assert.equal(manager.getListSnapshot().items.some((item) => item.sessionId === SID), true);
  assert.equal(session.getSnapshot().removed, false);
});

test('a later removal wins over an older in-flight list response', async () => {
  const { manager, session, setList } = await fixture();
  let settle;
  setList(() => new Promise((resolve) => { settle = resolve; }));
  const refreshing = manager.refreshList();
  manager.handleHostEnvelope(removed());
  settle({ result: { ok: true, value: { items: [summary()] } } });
  await refreshing;
  assert.equal(manager.getListSnapshot().items.some((item) => item.sessionId === SID), false);
  assert.equal(session.getSnapshot().removed, true);
});

test('a fresh list that omits the identity cannot release its removed state', async () => {
  const { manager, session, setList } = await fixture();
  manager.handleHostEnvelope(removed());
  setList(async () => ({ result: { ok: true, value: { items: [] } } }));
  await manager.refreshList();
  assert.equal(manager.getListSnapshot().items.some((item) => item.sessionId === SID), false);
  assert.equal(session.getSnapshot().removed, true, 'an old resident object is not fresh existence evidence');
});

test('a missing or different identity cannot release a real removal', async () => {
  const { manager, session, setList } = await fixture();
  manager.handleHostEnvelope(removed());
  manager.handleHostEnvelope(added('session-unrelated-fixture'));
  setList(async () => ({ result: { ok: true, value: { items: [summary('session-unrelated-fixture')] } } }));
  await manager.refreshList();
  assert.equal(manager.getListSnapshot().items.some((item) => item.sessionId === SID), false);
  assert.equal(session.getSnapshot().removed, true);
});

if (process.env.FORGE_TEST_ENVELOPE_OUTPUT) {
  const id = 'session-2eae321e-4728-4430-89b6-c497896493f8';
  callbacks.get('session/disposed')({ id });
  const removal = producer.serverRequest(frames.pop());
  const addition = added(id);
  serverRequestSchema.parse(removal);
  hostFrameSchema.parse(removal.payload);
  await writeFile(process.env.FORGE_TEST_ENVELOPE_OUTPUT, JSON.stringify({
    provenance: 'native host lifecycle callbacks and native WebSocket envelope, isolated fixture only',
    runtimeSourceSha256: createHash('sha256').update(source).digest('hex'),
    hostProducerSha256: createHash('sha256').update(proxySource).digest('hex'),
    websocketProducerSha256: createHash('sha256').update(connectionSource).digest('hex'),
    frames: [removal, addition],
  }, null, 2) + '\n', { flag: 'wx' });
}
