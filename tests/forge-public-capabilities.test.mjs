import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { inspectPublicCapabilities } from '../docker/harness/forge-public-capabilities.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../docker/harness/forge-public-capabilities.mjs', import.meta.url));
const catalogPath = 'code-copilot/knowledge/public-capabilities.json';
const apiPath = 'module/src/main/java/example/Directory.java';
const declaration = 'String find(String id);';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-capability-description-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (relative, body) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  };
  const entry = { id: 'custom.directory', name: 'Project-owned directory', purpose: 'Find stable IDs',
    owner: 'module Directory', stage: 'source-contract', keywords: ['member'], usage: 'Use the declared interface.',
    selection: 'Keep the selected stable source.', limitations: 'Source proof only; no runtime invocation grant.',
    sources: [{ path: apiPath, declarations: ['public interface Directory', declaration] }],
    modules: [{ path: 'module/pom.xml', artifactId: 'module', dependencies: ['example:core'] }] };
  const save = () => write(catalogPath, JSON.stringify({ schemaVersion: 1, capabilities: [entry] }));
  await write(apiPath, `package example; public interface Directory { ${declaration} }`);
  await write('module/pom.xml', '<project><artifactId>module</artifactId><dependencies><dependency><groupId>example</groupId><artifactId>core</artifactId></dependency></dependencies></project>');
  await save();
  return { root, write, entry, save };
}

test('current project custom description is searchable and bound to source without runtime authority', async t => {
  const f = await fixture(t);
  const result = await inspectPublicCapabilities({ workspaceRoot: f.root, query: 'member' });
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.id, 'custom.directory');
  assert.equal(item.sourceCheck, 'declarations-matched');
  assert.equal(item.runtimeVerified, false);
  assert.equal(item.invocationGranted, false);
  assert.equal(item.selectionReference.id, item.id);
  assert.equal(item.selectionReference.sourceDigests.length, 2);
  const original = item.selectionReference.sourceDigests[0].sha256;
  await f.write(apiPath, 'package example; public interface Directory { String renamed(String id); }');
  const changed = (await inspectPublicCapabilities({ workspaceRoot: f.root, id: item.id })).items[0];
  assert.equal(changed.sourceCheck, 'incomplete');
  assert.equal(changed.gaps[0].code, 'DECLARATION_MISMATCH');
  assert.notEqual(changed.selectionReference.sourceDigests[0].sha256, original);
});

test('a description, comment or dependencyManagement alone cannot prove an API or assembled consumer', async t => {
  const f = await fixture(t);
  await f.write(apiPath, `public interface Directory { /* ${declaration} */ }`);
  await f.write('module/pom.xml', '<project><artifactId>module</artifactId><dependencyManagement><dependencies><dependency><groupId>example</groupId><artifactId>core</artifactId></dependency></dependencies></dependencyManagement></project>');
  const item = (await inspectPublicCapabilities({ workspaceRoot: f.root })).items[0];
  assert.deepEqual(item.gaps.map(gap => gap.code), ['DECLARATION_MISMATCH', 'MODULE_OR_DEPENDENCY_MISMATCH']);
  assert.equal(item.sourceCheck, 'incomplete');
});

test('an absent description stays unknown and missing source stays a concrete gap', async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, apiPath));
  const result = await inspectPublicCapabilities({ workspaceRoot: f.root });
  assert.equal(result.items[0].gaps[0].code, 'SOURCE_MISSING');
  await rm(path.join(f.root, catalogPath));
  const absent = await inspectPublicCapabilities({ workspaceRoot: f.root });
  assert.equal(absent.status, 'not-described');
  assert.equal(absent.runtimeVerified, false);
  assert.deepEqual(absent.items, []);
});

test('description cannot select host, parent, credential or symbolic-link source paths', async t => {
  const f = await fixture(t);
  for (const relative of ['../other/Api.java', '/etc/Api.java', 'C:/private/Api.java', '.env', 'module/../Api.java']) {
    f.entry.sources[0].path = relative;
    await f.save();
    await assert.rejects(inspectPublicCapabilities({ workspaceRoot: f.root }), { code: 'INVALID_SOURCE_PATH' });
  }
  f.entry.sources[0].path = apiPath;
  await f.save();
  const external = await mkdtemp(path.join(os.tmpdir(), 'forge-capability-other-project-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, 'Directory.java'), `public interface Directory { ${declaration} }`);
  await rm(path.join(f.root, 'module/src/main/java/example'), { recursive: true });
  await symlink(external, path.join(f.root, 'module/src/main/java/example'), process.platform === 'win32' ? 'junction' : 'dir');
  const item = (await inspectPublicCapabilities({ workspaceRoot: f.root })).items[0];
  assert.equal(item.sourceCheck, 'incomplete');
  assert.equal(item.gaps[0].code, 'SOURCE_UNREADABLE');
  assert.equal(item.evidence.some(row => row.kind === 'source-declarations'), false);
});

test('installed command uses its current workspace and offers no root override or invocation action', async t => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.root, catalogPath), 'utf8');
  const result = await execute(process.execPath, [cli, '--id', 'custom.directory'], { cwd: f.root });
  assert.equal(JSON.parse(result.stdout).items[0].sourceCheck, 'declarations-matched');
  for (const args of [['--root', '..'], ['--invoke', 'custom.directory'], ['--id', 'custom.directory', '--query', 'member']]) {
    await assert.rejects(execute(process.execPath, [cli, ...args], { cwd: f.root }), error => error.code === 1);
  }
  assert.equal(await readFile(path.join(f.root, catalogPath), 'utf8'), before);
});
