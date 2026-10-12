#!/usr/bin/env node
// Operator-only: retain already installed dependencies as a versioned read-only
// artifact. No download, business verification, acceptance receipt or cleanup.
import crypto from 'node:crypto';
import { chmod, chown, lchown, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPreparedDependencyManifest, createPreparedDependencyResolver } from '../docker/harness/host-prepared-dependencies.mjs';
import { dependencySeedExecutable } from '../docker/harness/host-dependency-seed.mjs';

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const optionalStat = (file) => lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
function fail(message) { throw new Error(message); }

export async function prepareInstalledDependencies({ root, sources, projectSlug, inventory, toolchain, seed }) {
  if (!path.isAbsolute(root) || !Array.isArray(sources) || !sources.length
    || new Set(sources.map((entry) => entry.project)).size !== sources.length
    || sources.some((entry) => !['forge-admin-ui', 'forge-h5-ui'].includes(entry.project) || !path.isAbsolute(entry.root))) fail('Invalid prepared dependency inputs.');
  root = path.resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) fail('Output must be an ordinary directory.');
  const manifestFile = path.join(root, 'manifest.json');
  if (await optionalStat(manifestFile)) {
    const manifestSha256 = hash(await readFile(manifestFile));
    const resolve = createPreparedDependencyResolver();
    for (const { project } of sources) {
      if ((await resolve({ binding: { root, manifestSha256 }, projectSlug, project, inventory, toolchain })).status !== 'ready') fail('Existing prepared version does not match.');
    }
    return { root, manifestSha256 };
  }
  // Legacy seed files lost executable modes. Repair only installed bytes whose
  // SHA-256 belongs to an executable entry in the protected seed manifest.
  const executableHashes = new Set();
  if (seed) {
    const content = await readFile(path.join(seed.root, 'manifest.json'));
    if (hash(content) !== seed.manifestSha256) fail('Seed manifest binding mismatch.');
    const manifest = JSON.parse(content);
    if (manifest.schemaVersion !== 'forge-host-dependency-seed/v1' || manifest.projectSlug !== projectSlug) fail('Seed identity mismatch.');
    for (const entry of manifest.files) if (dependencySeedExecutable(entry.path)) executableHashes.add(entry.sha256);
  }
  const freeze = async (directory) => {
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name), info = await lstat(file);
      if (info.isSymbolicLink()) {
        // The manifest builder checks every link's destination.
        if (process.getuid?.() === 0) await lchown(file, 0, 0);
        continue;
      }
      if (info.isDirectory()) await freeze(file);
      else if (info.isFile() && info.nlink === 1) {
        const executable = (info.mode & 0o111) || (executableHashes.size && executableHashes.has(hash(await readFile(file))));
        await chmod(file, executable ? 0o555 : 0o444);
        if (process.getuid?.() === 0) await chown(file, 0, 0);
      } else fail('Installed dependency must not contain shared or special files.');
    }
    await chmod(directory, 0o555);
    if (process.getuid?.() === 0) await chown(directory, 0, 0);
  };
  for (const entry of sources) {
    const source = path.resolve(entry.root), target = path.join(root, entry.project, 'node_modules');
    if (source === root || source.startsWith(root + path.sep) || root.startsWith(source + path.sep)) fail('Source and output must be separate.');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if (!(await optionalStat(target))) {
      if (!(await lstat(source)).isDirectory() || await realpath(source) !== source) fail('Installed source must be ordinary.');
      await rename(source, target); // EXDEV is explicit; never fall back to another full copy.
    } else if (await optionalStat(source)) fail('Source and target both exist; refuse ambiguous adoption.');
    await chmod(target, 0o700);
    for (const name of ['.vite', '.vite-temp', '.cache']) {
      const directory = path.join(target, name);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) fail('Tool cache mount target must be ordinary.');
    }
    await freeze(target);
    await chmod(path.dirname(target), 0o555);
    if (process.getuid?.() === 0) await chown(path.dirname(target), 0, 0);
  }
  const manifest = await createPreparedDependencyManifest({ root, projectSlug, inventory, toolchain, projects: sources.map((entry) => entry.project) });
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  await writeFile(manifestFile, bytes, { mode: 0o444, flag: 'wx' });
  await chmod(root, 0o555);
  return { root, manifestSha256: hash(bytes) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4 || process.argv[2] !== '--input' || !path.isAbsolute(process.argv[3])) {
    process.stderr.write('Usage: prepare-host-installed-dependencies.mjs --input <absolute operator recipe.json>\n');
    process.exitCode = 2;
  } else {
    prepareInstalledDependencies(JSON.parse(await readFile(process.argv[3], 'utf8')))
      .then((binding) => process.stdout.write(JSON.stringify({ status: 'ready', preparedDependencies: binding, businessAcceptance: false }) + '\n'))
      .catch((error) => { process.stderr.write(JSON.stringify({ status: 'failed', error: error.message }) + '\n'); process.exitCode = 1; });
  }
}
