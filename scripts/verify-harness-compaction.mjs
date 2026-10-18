#!/usr/bin/env node
// Existing image verification needs an explicit, protected equivalence receipt
// because a compacted filesystem intentionally has different layer ancestry.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const configDigest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const immutable = value => /^sha256:[a-f0-9]{64}$/u.test(value ?? '');
const patchModulePath = /^(?:\/usr\/local\/lib\/[a-z0-9-]+\.mjs|\/usr\/local\/bin\/forge-release)$/u;
const inspect = ref => JSON.parse(execFileSync('docker', ['image', 'inspect', ref], { encoding: 'utf8' }))[0];

export function validateCompaction({ receipt, image, source, foundation }) {
  assert.equal(receipt.schemaVersion, 'forge-image-compaction-registration/v1');
  assert.equal(receipt.status, 'verified');
  for (const id of [image.Id, source.Id, foundation.Id]) assert(immutable(id));
  assert.equal(receipt.imageId, image.Id); assert.equal(receipt.sourceImage, source.Id);
  assert.equal(receipt.foundationImage, foundation.Id);
  assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64');
  assert.equal(source.Os, image.Os); assert.equal(source.Architecture, image.Architecture);
  assert.deepEqual(image.Config, source.Config);
  assert.equal(configDigest(image.Config), receipt.configSha256);
  assert.equal(image.RootFS.Layers.length, 1);
  assert.deepEqual(image.RootFS.Layers, receipt.targetLayers);
  assert.deepEqual(source.RootFS.Layers, receipt.sourceLayers);
  assert(foundation.RootFS.Layers.length > 0);
  assert.deepEqual(source.RootFS.Layers.slice(0, foundation.RootFS.Layers.length), foundation.RootFS.Layers);
  assert.deepEqual(receipt.filesystemBefore, receipt.filesystemAfter);
  assert(/^[a-f0-9]{64}$/u.test(receipt.filesystemAfter?.digest ?? ''));
  assert(receipt.filesystemAfter.files > 0 && receipt.filesystemAfter.bytes > 0);
  assert.equal(receipt.runtime.uid, 1000);
  assert.match(image.Config.User, /^1000:\d+$/u);
  return { registered: true, ok: true, kind: 'compacted-equivalent-target', imageId: image.Id,
    sourceImageId: source.Id, baseImageId: foundation.Id, foundationImageId: foundation.Id,
    configDigest: `sha256:${receipt.configSha256}`, buildDigest: `sha256:${receipt.filesystemAfter.digest}` };
}

// A reviewed patch keeps the single-layer parent as its fixed build base. Its
// evidence is a patch receipt, never a claim of filesystem equivalence.
export function validateCompactedPatch({ receipt, image, parent, parentReceipt, source, foundation, modules }) {
  validateCompaction({ receipt: parentReceipt, image: parent, source, foundation });
  assert.equal(receipt.schemaVersion, 'forge-image-compaction-patch-registration/v1');
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.imageId, image.Id); assert(immutable(image.Id));
  assert.equal(receipt.parentImage, parent.Id);
  assert.equal(receipt.foundationImage, foundation.Id);
  assert.equal(image.Os, parent.Os); assert.equal(image.Architecture, parent.Architecture);
  assert.equal(image.RootFS.Layers.length, 2);
  assert.equal(image.RootFS.Layers[0], parent.RootFS.Layers[0]);
  assert(image.RootFS.Layers.every(immutable));
  assert.deepEqual(image.RootFS.Layers, receipt.targetLayers);
  assert.match(receipt.sourceCommit, /^[a-f0-9]{40}$/u);
  const expected = structuredClone(parent.Config);
  expected.Labels = { ...expected.Labels,
    'org.opencontainers.image.revision': receipt.sourceCommit,
    'com.forge-delivery.harness-skill-bundle': receipt.skillBundle,
    'org.forge.delivery.parent-image-id': parent.Id };
  assert.match(receipt.skillBundle, /^\d{4}\.\d{2}\.\d{2}\.\d+$/u);
  const key = 'FORGE_HARNESS_SKILL_BUNDLE_VERSION=';
  const hasBundle = (expected.Env ?? []).some(value => value.startsWith(key));
  expected.Env = (expected.Env ?? []).map(value => value.startsWith(key) ? key + receipt.skillBundle : value);
  if (!hasBundle) expected.Env.push(key + receipt.skillBundle);
  assert.deepEqual(image.Config, expected, 'Unreviewed runtime configuration change');
  assert.equal(configDigest(image.Config), receipt.configSha256);
  assert.equal(receipt.consumer?.status, 'passed');
  assert.equal(receipt.consumer.exit, 0);
  assert.equal(receipt.consumer.imageId, image.Id);
  assert.equal(receipt.consumer.sourceCommit, receipt.sourceCommit);
  assert.match(receipt.consumer.evidenceSha256, /^[a-f0-9]{64}$/u);
  assert(receipt.modules && Object.keys(receipt.modules).length > 0);
  for (const [file, hash] of Object.entries(receipt.modules)) {
    assert.match(file, patchModulePath);
    assert.match(hash, /^[a-f0-9]{64}$/u);
    assert.equal(modules[file], hash, 'Installed patch module differs');
  }
  return { registered: true, ok: true, kind: 'compacted-parent-patch', imageId: image.Id,
    baseImageId: parent.Id, foundationImageId: foundation.Id,
    configDigest: `sha256:${receipt.configSha256}`, buildDigest: `sha256:${configDigest(receipt.modules)}` };
}

function main() {
  const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
    index % 2 === 0 ? [...pairs, [value.replace(/^--/u, ''), all[index + 1]]] : pairs, []));
  const image = inspect(options.image);
  assert(immutable(image.Id));
  const root = path.resolve(options['receipt-root']);
  const file = path.join(root, `${image.Id.slice(7)}.json`);
  if (!existsSync(file)) { console.log(JSON.stringify({ registered: false })); return; }
  const protectedReceipt = target => {
    const st = lstatSync(target);
    assert(!st.isSymbolicLink() && st.uid === 0 && (st.mode & 0o022) === 0,
      'Compaction receipt must be root-owned and not group/world writable');
    assert.equal(realpathSync(target), target);
    if (target !== root) assert(st.isFile() && st.nlink === 1 && st.size < 1024 * 1024);
  };
  protectedReceipt(root); protectedReceipt(file);
  const receipt = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(receipt.foundationImage, options['foundation-id']);
  if (receipt.schemaVersion === 'forge-image-compaction-patch-registration/v1') {
    assert(immutable(receipt.parentImage));
    const parentFile = path.join(root, `${receipt.parentImage.slice(7)}.json`);
    protectedReceipt(parentFile);
    const parentReceipt = JSON.parse(readFileSync(parentFile, 'utf8'));
    const files = Object.keys(receipt.modules ?? {});
    assert(files.length > 0 && files.length <= 64);
    for (const file of files) assert.match(file, patchModulePath);
    const probe = `const fs=require('node:fs'),c=require('node:crypto');console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(files)}.map(p=>[p,c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))));`;
    const modules = JSON.parse(execFileSync('docker', ['run','--rm','--pull=never','--read-only','--network=none',
      '--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint','node',image.Id,'-e',probe],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }));
    console.log(JSON.stringify(validateCompactedPatch({ receipt, image, parent: inspect(receipt.parentImage),
      parentReceipt, source: inspect(parentReceipt.sourceImage), foundation: inspect(receipt.foundationImage), modules })));
    return;
  }
  const result = validateCompaction({ receipt, image, source: inspect(receipt.sourceImage),
    foundation: inspect(receipt.foundationImage) });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (error) { console.error(`Harness compaction verification: ${error.message}`); process.exitCode = 1; }
}
