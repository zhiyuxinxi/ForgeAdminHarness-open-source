import assert from 'node:assert/strict';
import test from 'node:test';
import { configDigest, validateCompaction, validateCompactedPatch } from '../scripts/verify-harness-compaction.mjs';

const id = char => `sha256:${char.repeat(64)}`;
function fixture() {
  const Config = { User: '1000:1000', Env: ['A=preserved'], Cmd: ['start-harness'],
    Healthcheck: { Test: ['CMD', 'node', 'health.js'], Interval: 1000000 }, Labels: { revision: 'original' } };
  const foundation = { Id: id('a'), RootFS: { Layers: [id('b')] } };
  const source = { Id: id('c'), Os: 'linux', Architecture: 'amd64', Config,
    RootFS: { Layers: [id('b'), id('d'), id('e')] } };
  const image = { ...structuredClone(source), Id: id('f'), RootFS: { Layers: [id('1')] } };
  const fs = { digest: '2'.repeat(64), files: 41000, bytes: 710000000 };
  const receipt = { schemaVersion: 'forge-image-compaction-registration/v1', status: 'verified',
    imageId: image.Id, sourceImage: source.Id, foundationImage: foundation.Id,
    configSha256: configDigest(Config), sourceLayers: source.RootFS.Layers, targetLayers: image.RootFS.Layers,
    filesystemBefore: fs, filesystemAfter: structuredClone(fs), runtime: { uid: 1000 } };
  return { receipt, image, source, foundation };
}
test('accepts changed layer topology while preserving complete runtime configuration', () => {
  assert.equal(validateCompaction(fixture()).kind, 'compacted-equivalent-target');
});
test('rejects an unbound image, layer substitution and an unrelated foundation', () => {
  for (const mutate of [f => { f.image.Id = id('3'); }, f => { f.image.RootFS.Layers = [id('4')]; },
    f => { f.foundation.RootFS.Layers = [id('5')]; }]) {
    const f = fixture(); mutate(f); assert.throws(() => validateCompaction(f));
  }
});
test('rejects changed environment, healthcheck, user and command', () => {
  for (const key of ['Env','Healthcheck','User','Cmd']) {
    const f = fixture(); delete f.image.Config[key]; assert.throws(() => validateCompaction(f));
  }
});
test('rejects failed or unequal filesystem evidence and root runtime', () => {
  for (const mutate of [f => { f.receipt.status = 'failed'; },
    f => { f.receipt.filesystemAfter.digest = '6'.repeat(64); }, f => { f.receipt.runtime.uid = 0; }]) {
    const f = fixture(); mutate(f); assert.throws(() => validateCompaction(f));
  }
});

function patchFixture() {
  const base = fixture();
  const parent = base.image, image = structuredClone(parent);
  image.Id = id('7'); image.RootFS.Layers.push(id('8'));
  const sourceCommit = '9'.repeat(40), skillBundle = '2026.10.14.2';
  image.Config.Labels = { ...image.Config.Labels, 'org.opencontainers.image.revision': sourceCommit,
    'com.forge-delivery.harness-skill-bundle': skillBundle, 'org.forge.delivery.parent-image-id': parent.Id };
  image.Config.Env.push(`FORGE_HARNESS_SKILL_BUNDLE_VERSION=${skillBundle}`);
  const modules = { '/usr/local/lib/forge-direct-development-prompt.mjs': 'a'.repeat(64) };
  const receipt = { schemaVersion: 'forge-image-compaction-patch-registration/v1', status: 'verified',
    imageId: image.Id, parentImage: parent.Id, foundationImage: base.foundation.Id, sourceCommit, skillBundle,
    targetLayers: image.RootFS.Layers, configSha256: configDigest(image.Config), modules,
    consumer: { status: 'passed', exit: 0, imageId: image.Id, sourceCommit, evidenceSha256: 'b'.repeat(64) } };
  return { ...base, parent, parentReceipt: base.receipt, image, receipt, modules: structuredClone(modules) };
}
test('accepts a source-bound patch over a verified fixed compacted parent', () => {
  assert.equal(validateCompactedPatch(patchFixture()).kind, 'compacted-parent-patch');
  const f = patchFixture();
  f.parent.Config.Env.unshift('FORGE_HARNESS_SKILL_BUNDLE_VERSION=2026.10.13.2');
  f.source.Config.Env = [...f.parent.Config.Env];
  f.parentReceipt.configSha256 = configDigest(f.parent.Config);
  f.image.Config.Env = ['FORGE_HARNESS_SKILL_BUNDLE_VERSION=2026.10.14.2', 'A=preserved'];
  f.receipt.configSha256 = configDigest(f.image.Config);
  assert.equal(validateCompactedPatch(f).kind, 'compacted-parent-patch');
});
test('patch rejects changed isolation, ancestry, consumer, source and installed bytes', () => {
  for (const mutate of [f => { f.image.Config.User = '0:0'; },
    f => { f.image.Config.Healthcheck = null; }, f => { f.image.Config.Env.push('UNREVIEWED=1'); },
    f => { f.image.RootFS.Layers[0] = id('4'); }, f => { f.image.RootFS.Layers.push(id('5')); },
    f => { f.parentReceipt.filesystemAfter.digest = 'c'.repeat(64); },
    f => { f.receipt.consumer.exit = 1; }, f => { f.receipt.consumer.sourceCommit = 'd'.repeat(40); },
    f => { f.receipt.consumer.imageId = id('e'); },
    f => { f.modules['/usr/local/lib/forge-direct-development-prompt.mjs'] = 'f'.repeat(64); }]) {
    const f = patchFixture(); mutate(f); assert.throws(() => validateCompactedPatch(f));
  }
});

test('accepts the forge-release CLI with matching installed bytes alongside library modules', () => {
  const f = patchFixture();
  const file = '/usr/local/bin/forge-release', hash = 'c'.repeat(64);
  f.receipt.modules[file] = hash;
  f.modules[file] = hash;
  assert.equal(validateCompactedPatch(f).kind, 'compacted-parent-patch');
});

test('rejects a forge-release CLI whose installed bytes differ or are missing', () => {
  for (const installed of ['d'.repeat(64), undefined]) {
    const f = patchFixture();
    const file = '/usr/local/bin/forge-release';
    f.receipt.modules[file] = 'c'.repeat(64);
    if (installed !== undefined) f.modules[file] = installed;
    assert.throws(() => validateCompactedPatch(f), /Installed patch module differs/u);
  }
});

test('rejects other executables and path traversal even with matching byte evidence', () => {
  for (const file of ['/usr/local/bin/forge-other', '/usr/local/bin/forge-release.mjs',
    '/usr/local/bin/../bin/forge-release', '/usr/local/lib/../bin/forge-release',
    '/usr/local/bin/forge-release/../forge-other', '/usr/local/lib/../forge-release.mjs']) {
    const f = patchFixture();
    f.receipt.modules[file] = 'c'.repeat(64);
    f.modules[file] = 'c'.repeat(64);
    assert.throws(() => validateCompactedPatch(f));
  }
});
