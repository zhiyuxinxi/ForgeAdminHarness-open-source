import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { applyPatch, patchPromptAdmission } from '../docker/harness/forge-prompt-admission-patch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.FORGE_TEST_NATIVE_RUNTIME || resolve(root, 'tmp/runtime-deps-ci');
const nativeRequire = createRequire(resolve(runtime, 'package.json'));
const nativePath = nativeRequire.resolve('@deepseek-ai/dsh-host-apiproxy');
const packageBytes = await readFile(nativeRequire.resolve('@deepseek-ai/dsh-host-apiproxy/package.json'));
const pkg = JSON.parse(packageBytes);
assert.equal(pkg.name, '@deepseek-ai/dsh-host-apiproxy');
assert.equal(pkg.version, '0.1.1-rc.2');
const sourceBytes = await readFile(nativePath);
const source = sourceBytes.toString('utf8');
const patched = patchPromptAdmission(source);
if (process.env.FORGE_TEST_NATIVE_RUNTIME) {
  assert.equal(patched, source, 'the installed native host must already contain the complete patch');
}

function exactSection(text, start, end) {
  const offset = text.indexOf(start);
  assert.notEqual(offset, -1, `missing fixed native section: ${start}`);
  assert.equal(text.indexOf(start, offset + start.length), -1, `duplicate native section: ${start}`);
  const finish = text.indexOf(end, offset + start.length);
  assert.notEqual(finish, -1, `missing native section end: ${start}`);
  return text.slice(offset, finish + end.length);
}

test('pinned native prompt admission installs on a copy, is idempotent and rejects package drift', async t => {
  const temporary = await mkdtemp(join(os.tmpdir(), 'forge-prompt-admission-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const packageDirectory = join(temporary, '@deepseek-ai/dsh-host-apiproxy');
  const file = join(packageDirectory, 'lib/index.js');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(join(packageDirectory, 'package.json'), packageBytes);
  await writeFile(file, sourceBytes);
  assert.deepEqual(applyPatch(temporary), { patch: 'forge-prompt-admission-v1', changed: patched !== source });
  assert.equal(await readFile(file, 'utf8'), patched);
  assert.deepEqual(applyPatch(temporary), { patch: 'forge-prompt-admission-v1', changed: false });
  const installed = await readFile(file);
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ ...pkg, version: '0.1.1-unknown' }));
  assert.throws(() => applyPatch(temporary), /Unsupported Harness API proxy package/);
  assert.deepEqual(await readFile(file), installed, 'unknown package cannot modify the native file');
  assert.deepEqual(await readFile(nativePath), sourceBytes, 'the shared native cache remains untouched');
});

test('native prompt admission refuses missing, duplicate and partially patched projection anchors', () => {
  assert.equal(patchPromptAdmission(patched), patched);
  assert.throws(() => patchPromptAdmission('unknown upstream source'), /Unsupported/);
  assert.throws(() => patchPromptAdmission(source + source), /Unsupported|Incomplete/);
  assert.throws(() => patchPromptAdmission(patched.replace('agent?.inbox?.hasPending === true', 'false')), /Incomplete/);
});

test('actual native list projection includes pending maintenance while empty maintenance remains idle', async () => {
  const loopSource = await readFile(nativeRequire.resolve('@deepseek-ai/dsh-agent-loop'), 'utf8');
  const statusGetter = exactSection(loopSource, 'get status() {', '\n\t}');
  const nativeStatus = Object.getOwnPropertyDescriptor(vm.runInNewContext(`({ ${statusGetter} })`), 'status').get;
  const { Inbox } = await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-agent')).href);
  const summarize = exactSection(patched, 'function summarize(session, running) {', '\n}');
  const list = exactSection(patched, 'async function listVisibleSessionSummaries(signal) {', '\n\t}');
  const session = { id: 'native-admission-session', events: [], header: { cwd: '/workspace' } };
  let agent;
  const context = vm.createContext({
    ctx: { agents: { get: () => agent }, sessions: { list: () => [session] }, get: () => undefined },
    // Unchanged metadata providers are isolated; the real native list and summary execute below.
    listProjectionsFor: () => undefined,
    sessionListMetadata: () => ({ blank: false }),
    sessionListUpdatedAt: () => 123,
    sessionListFields: header => ({ cwd: header.cwd }),
  });
  vm.runInContext(`${summarize}\n${list}`, context);
  for (const phase of ['idle', 'maintenance', 'running']) {
    for (const target of [null, 'next-turn', 'next-step']) {
      const inbox = Object.create(Inbox.prototype);
      inbox.state = { 'next-turn': [], 'next-step': [] };
      if (target !== null) inbox.state[target].push({ id: 'accepted-native-message' });
      agent = { phase: { kind: phase }, inbox };
      Object.defineProperty(agent, 'status', { get: nativeStatus });
      const rows = await context.listVisibleSessionSummaries();
      assert.equal(rows[0].running, phase === 'running' || target !== null, `${phase}/${target}`);
      assert.equal(agent.status, phase === 'running' ? 'running' : 'idle', 'native Agent semantics stay unchanged');
      assert.equal(rows[0].sessionId, session.id);
      assert.equal(rows[0].cwd, '/workspace');
      assert.equal(rows[0].blank, false);
      assert.equal(rows[0].updatedAt, 123);
    }
  }
  agent = undefined;
  assert.equal((await context.listVisibleSessionSummaries())[0].running, false);
});
