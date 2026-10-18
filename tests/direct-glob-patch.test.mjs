import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyPatch, patchDirectGlob } from '../docker/harness/forge-direct-glob-patch.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.FORGE_TEST_NATIVE_RUNTIME || resolve(repository, '../ForgeAdminHarness/tmp/runtime-deps-ci');
const directory = resolve(runtime, 'node_modules/@deepseek-ai/dsh-tool-fs-search');
const packageBytes = await readFile(join(directory, 'package.json'));
const pkg = JSON.parse(packageBytes);
assert.equal(pkg.version, '0.1.1-rc.2');
const source = await readFile(join(directory, 'lib/index.js'), 'utf8');
const patched = patchDirectGlob(source);
if (process.env.FORGE_TEST_INSTALLED_GLOB_PATCH === '1') assert.equal(patched, source);

async function nativeSearch(t) {
  const temporary = await mkdtemp(join(os.tmpdir(), 'forge-direct-glob-native-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await symlink(resolve(runtime, 'node_modules'), join(temporary, 'node_modules'), 'junction');
  const file = join(temporary, 'search.mjs');
  await writeFile(file, patched);
  return import(pathToFileURL(file));
}

test('direct glob installs idempotently on the pinned package and rejects source drift', async t => {
  const temporary = await mkdtemp(join(os.tmpdir(), 'forge-direct-glob-install-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const target = join(temporary, '@deepseek-ai/dsh-tool-fs-search');
  await mkdir(join(target, 'lib'), { recursive: true });
  await writeFile(join(target, 'package.json'), packageBytes);
  await writeFile(join(target, 'lib/index.js'), source);
  assert.equal(applyPatch(temporary).changed, source !== patched);
  assert.equal(applyPatch(temporary).changed, false);
  assert.equal(await readFile(join(target, 'lib/index.js'), 'utf8'), patched);
  await writeFile(join(target, 'package.json'), JSON.stringify({ ...pkg, version: 'unknown' }));
  assert.throws(() => applyPatch(temporary), /Unsupported fs-search package/);
  assert.throws(() => patchDirectGlob('unknown source'), /Unsupported/);
  assert.throws(() => patchDirectGlob(source + source), /Unsupported|Incomplete/);
  assert.throws(() => patchDirectGlob(patched.replace('--sort=path', '--sort=none')), /Incomplete/);
  assert.equal(await readFile(join(directory, 'lib/index.js'), 'utf8'), source);
});

test('actual glob argv and all user-facing ordering text match direct and default behavior', async t => {
  const api = await nativeSearch(t);
  const previous = process.env.FORGE_DEVELOPMENT_MODE;
  t.after(() => previous === undefined ? delete process.env.FORGE_DEVELOPMENT_MODE : process.env.FORGE_DEVELOPMENT_MODE = previous);
  const input = { pattern: '**/*.ts', path: '-literal-path' };
  let directArgv;
  for (const mode of ['direct', 'default']) {
    if (mode === 'direct') process.env.FORGE_DEVELOPMENT_MODE = mode;
    else delete process.env.FORGE_DEVELOPMENT_MODE;
    const order = mode === 'direct' ? 'path' : 'modification-time';
    const argv = api.buildGlobCommand(input);
    assert.ok(argv.includes(mode === 'direct' ? '--sort=path' : '--sort=modified'));
    assert.deepEqual(argv.slice(-2), ['--', '-literal-path']);
    assert.ok(argv.includes('--glob=!**/.git/**'));
    if (mode === 'direct') directArgv = argv;
    else assert.deepEqual(argv.map(x => x === '--sort=modified' ? '--sort=path' : x), directArgv);
    for (const sampleOverCapGlobResults of [false, true]) {
      let prompt, tool;
      api.applyGlobTool({ systemPrompt: { section(value) { prompt = value.text; } },
        tools: { register(value) { tool = value; } }, on() {} }, { maxResults: 2, timeoutMs: 30000, sampleOverCapGlobResults });
      assert.ok(prompt.includes(`${order} order`));
      assert.ok(tool.description.includes(`${order} order`));
      if (mode === 'direct') assert.doesNotMatch(`${prompt}\n${tool.description}`, /modification-time/);
    }
    const sampled = api.formatGlobOutput({ items: ['a/x', 'b/y'], shown: 2, total: 3 }, 7);
    assert.ok(sampled.includes(`instead of taken in ${order} order`));
  }
  const grepStart = '//#region lib/types/grep.js';
  assert.equal(patched.slice(patched.indexOf(grepStart)), source.slice(source.indexOf(grepStart)), 'grep remains byte-for-byte unchanged');
});
