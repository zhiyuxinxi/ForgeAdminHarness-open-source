import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { withinRoot } from '../docker/harness/validate-image-build-inputs.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const validator = path.join(repositoryRoot, 'docker', 'harness', 'validate-image-build-inputs.mjs');
const spec = path.join(repositoryRoot, 'docker', 'harness', 'image-build-inputs.json');

function validate(root, specPath = spec) {
  return spawnSync(process.execPath, [
    validator,
    '--mode', 'source',
    '--root', root,
    '--spec', specPath,
    '--json',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
}

test('root-filesystem validation accepts descendants without a doubled-separator escape false positive', () => {
  const filesystemRoot = path.parse(repositoryRoot).root;
  const relative = path.relative(filesystemRoot, repositoryRoot).split(path.sep).join('/');
  assert.equal(withinRoot(filesystemRoot, relative), repositoryRoot);
});

test('reviewed Harness Docker inputs produce one complete deterministic receipt', () => {
  const first = validate(repositoryRoot);
  const second = validate(repositoryRoot);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  const firstReceipt = JSON.parse(first.stdout);
  const secondReceipt = JSON.parse(second.stdout);
  assert.deepEqual(firstReceipt, secondReceipt);
  assert.match(firstReceipt.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(firstReceipt.fileCount >= 50);
  assert.equal(firstReceipt.dependencyCount, 5);
});

test('every local Docker COPY must be bound to the manifest destination', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-image-inputs-'));
  try {
    await cp(path.join(repositoryRoot, 'config'), path.join(temporaryRoot, 'config'), { recursive: true });
    await cp(path.join(repositoryRoot, 'docker'), path.join(temporaryRoot, 'docker'), { recursive: true });
    const dockerfile = path.join(temporaryRoot, 'docker', 'harness', 'Dockerfile.overlay');
    await writeFile(path.join(temporaryRoot, 'docker', 'harness', 'unreviewed-runtime.mjs'), 'export default true;\n');
    await writeFile(dockerfile, `${await readFile(dockerfile, 'utf8')}\nCOPY docker/harness/unreviewed-runtime.mjs /usr/local/lib/unreviewed-runtime.mjs\n`);
    const result = validate(temporaryRoot, path.join(temporaryRoot, 'docker', 'harness', 'image-build-inputs.json'));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /COPY source is not covered/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('conversation-output consumers import from the manifest destinations and reject a missing store', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-output-image-closure-'));
  try {
    const value = JSON.parse(await readFile(spec, 'utf8'));
    for (const entry of value.mappings.filter((entry) => entry.type === 'file' && entry.destination.startsWith('usr/local/lib/'))) {
      const destination = path.join(temporaryRoot, entry.destination);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(repositoryRoot, entry.source), destination);
    }
    const [base, overlay, verifier] = await Promise.all([
      readFile(path.join(repositoryRoot, 'docker/harness/Dockerfile'), 'utf8'),
      readFile(path.join(repositoryRoot, 'docker/harness/Dockerfile.overlay'), 'utf8'),
      readFile(path.join(repositoryRoot, 'scripts/lib/harness-image-verifier.sh'), 'utf8'),
    ]);
    const command = /--input-type=module -e '(await import\("\/usr\/local\/lib\/harness-tcp-proxy\.mjs"\);[^']+)'/u.exec(base)?.[1];
    assert.ok(command, 'base image must import the real archive consumers');
    assert.ok(overlay.includes(command), 'overlay must execute the same consumer check');
    assert.ok(verifier.includes(command), 'existing-project target image verification must execute the same check');
    assert.ok(verifier.indexOf(command) > verifier.indexOf('verify_target_harness_image()'), 'old foundation is not required to already contain the new feature');
    const lib = pathToFileURL(`${path.join(temporaryRoot, 'usr/local/lib')}${path.sep}`).href;
    const localCommand = command.replaceAll('/usr/local/lib/', lib);
    // Match the image's NODE_PATH dependency lookup using the existing local install.
    const options = { encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_PATH: path.join(repositoryRoot, 'node_modules') } };
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', localCommand], options);
    assert.equal(result.status, 0, result.stderr);
    await rm(path.join(temporaryRoot, 'usr/local/lib/conversation-output-store.mjs'));
    const missing = spawnSync(process.execPath, ['--input-type=module', '-e', localCommand], options);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/u);
    assert.match(missing.stderr, /conversation-output-store\.mjs/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('missing and non-regular manifest inputs fail closed', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-image-inputs-missing-'));
  try {
    const value = JSON.parse(await readFile(spec, 'utf8'));
    value.mappings.push({
      source: 'docker/harness/does-not-exist.mjs',
      destination: 'usr/local/lib/does-not-exist.mjs',
      type: 'file',
      mode: '0644',
    });
    const temporarySpec = path.join(temporaryRoot, 'spec.json');
    await writeFile(temporarySpec, `${JSON.stringify(value)}\n`);
    const result = validate(repositoryRoot, temporarySpec);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing or linked path segment|not a regular no-follow file/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('file mappings reject a symlink or junction in any parent path segment', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-image-inputs-linked-root-'));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'forge-image-inputs-linked-outside-'));
  try {
    await cp(path.join(repositoryRoot, 'config'), path.join(temporaryRoot, 'config'), { recursive: true });
    await cp(path.join(repositoryRoot, 'docker'), path.join(temporaryRoot, 'docker'), { recursive: true });
    await mkdir(path.join(outsideRoot, 'payload'));
    await writeFile(path.join(outsideRoot, 'payload', 'outside.txt'), 'outside the declared source root\n');
    await symlink(
      path.join(outsideRoot, 'payload'),
      path.join(temporaryRoot, 'linked-parent'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const value = JSON.parse(await readFile(path.join(temporaryRoot, 'docker', 'harness', 'image-build-inputs.json'), 'utf8'));
    value.mappings.push({
      source: 'linked-parent/outside.txt',
      destination: 'usr/local/share/forge-image-build/outside.txt',
      type: 'file',
      mode: '0644',
    });
    const temporarySpec = path.join(temporaryRoot, 'linked-spec.json');
    await writeFile(temporarySpec, `${JSON.stringify(value)}\n`);
    const result = validate(temporaryRoot, temporarySpec);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /linked path segment|resolves through/u);
  } finally {
    await Promise.all([
      rm(temporaryRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  }
});
