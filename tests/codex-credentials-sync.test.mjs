import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { REF, validateRequest, syncStore } from '../scripts/lib/sync-codex-credentials.mjs';

const token = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({
  exp: Math.floor(Date.now() / 1000) + 3600,
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' },
})).toString('base64url')}.fixture`;

test('worker refuses arbitrary paths, expired tokens and refresh-style input', () => {
  const input = { action: 'set', token, targets: [{ path: '/targets/0', kind: 'home' }] };
  assert.equal(validateRequest(input), input);
  assert.throws(() => validateRequest({ ...input, targets: [{ path: '/etc', kind: 'home' }] }));
  assert.throws(() => validateRequest({ ...input, token: 'opaque' }));
  assert.throws(() => validateRequest({ ...input, action: 'unset' }));
  assert.throws(() => validateRequest(input, Math.floor(Date.now() / 1000) + 7200));
});

// The versioned image supplies these dependencies in deployment. Local tests use
// the existing package cache, without fetching or starting any Harness plugins.
let native;
try {
  const runtime = process.env.FORGE_TEST_NATIVE_RUNTIME || resolve('../ForgeAdminHarness/tmp/runtime-deps-ci');
  const require = createRequire(join(runtime, 'package.json'));
  native = {};
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-credentials-local',
    '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-settings-file', '@deepseek-ai/dsh-llm-pi-ai']) {
    Object.assign(native, await import(pathToFileURL(require.resolve(name)).href));
  }
} catch { native = undefined; }

test('native writer preserves other refs and OAuth grants; repeat is byte-identical; logout removes only its ref', { skip: !native }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-codex-native-'));
  const filename = join(home, '.credentials.yaml');
  try {
    await writeFile(filename, 'version: 1\nrefs:\n  OTHER_PROVIDER: fixture-other\n', { mode: 0o600 });
    const ctx = new native.Context();
    try {
      await ctx.plugin(native.LocalCredentialProvider, { path: filename, watch: false });
      await ctx.credentials.modifyRecord(native.credentialKey('llm-pi-ai', 'openai-codex'), () => ({
        kind: 'grant', payload: { refresh: 'synthetic-existing-grant' },
      }));
    } finally { await ctx.fiber.dispose(); }
    assert.equal(await syncStore({ path: home, kind: 'home' }, { action: 'set', token }, native), 1);
    const before = await readFile(filename, 'utf8');
    const beforeStat = await stat(filename);
    assert.match(before, /OTHER_PROVIDER: fixture-other/);
    assert.match(before, /synthetic-existing-grant/);
    assert.equal(await syncStore({ path: home, kind: 'home' }, { action: 'set', token }, native), 0);
    assert.equal(await readFile(filename, 'utf8'), before);
    assert.equal((await stat(filename)).mtimeMs, beforeStat.mtimeMs);
    assert.equal(await syncStore({ path: home, kind: 'home' }, { action: 'unset' }, native), 1);
    const after = await readFile(filename, 'utf8');
    assert.doesNotMatch(after, new RegExp(REF));
    assert.match(after, /synthetic-existing-grant/);
    assert.match(after, /OTHER_PROVIDER: fixture-other/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('native settings update changes only Codex route leaves and rejects custom endpoint', { skip: !native }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-codex-settings-'));
  const filename = join(home, 'settings.yaml');
  try {
    await writeFile(filename, '# preserve comment\nother-namespace:\n  fixture: retained\nllm-pi-ai:\n  providers:\n    deepseek:\n      apiKeyEnv: DEEPSEEK_API_KEY\n    openai-codex:\n      displayName: Existing label\n', { mode: 0o600 });
    const input = { action: 'set', token, configureProviders: true };
    assert.equal(await syncStore({ path: home, kind: 'home' }, input, native), 2);
    const text = await readFile(filename, 'utf8');
    assert.match(text, /# preserve comment/);
    assert.match(text, /fixture: retained/);
    assert.match(text, /apiKeyEnv: DEEPSEEK_API_KEY/);
    assert.match(text, /displayName: Existing label/);
    assert.match(text, /transport: sse/);
    assert.match(text, new RegExp(`apiKeyEnv: ${REF}`));
    assert.equal(await syncStore({ path: home, kind: 'home' }, input, native), 0);
    assert.equal(await readFile(filename, 'utf8'), text);
    await writeFile(filename, 'llm-pi-ai:\n  providers:\n    openai-codex:\n      baseURL: https://fixture.invalid\n', { mode: 0o600 });
    await assert.rejects(syncStore({ path: home, kind: 'home' }, input, native), /codex-provider-conflict/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('project seed cannot hold unrelated references', { skip: !native }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-codex-seed-'));
  try {
    await writeFile(join(home, 'credentials.yaml'), 'version: 1\nrefs:\n  OTHER_PROVIDER: fixture\n', { mode: 0o600 });
    await assert.rejects(syncStore({ path: home, kind: 'seed' }, { action: 'set', token }, native), /seed-not-exclusive/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('fresh native seed matches the lifecycle single-reference format', { skip: !native }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-codex-new-seed-'));
  try {
    assert.equal(await syncStore({ path: home, kind: 'seed' }, { action: 'set', token }, native), 1);
    assert.equal(await readFile(join(home, 'credentials.yaml'), 'utf8'), `version: 1\nrefs:\n  ${REF}: ${token}\n`);
    assert.equal(await syncStore({ path: home, kind: 'seed' }, { action: 'unset' }, native), 1);
    assert.equal(await readFile(join(home, 'credentials.yaml'), 'utf8'), 'version: 1\nrefs: {}\n');
  } finally { await rm(home, { recursive: true, force: true }); }
});
