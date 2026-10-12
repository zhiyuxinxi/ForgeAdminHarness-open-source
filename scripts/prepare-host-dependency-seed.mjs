#!/usr/bin/env node

// Operator-only dependency preparation. No business build, test, or acceptance receipt.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { hostExecutionEnvironment, hostSandboxCommand, hostSandboxReadOnlyRoots, validateHostVerificationContract } from '../docker/harness/host-verify-policy.mjs';
import { runHostProcess } from '../docker/harness/host-verification-runner.mjs';
import { inventoryWorkspace } from '../docker/harness/verification-runner.mjs';
import { createDependencySeedManifest, dependencySeedExecutable, dependencySeedInputs, dependencySeedToolchains, restoreDependencySeed, verifyDependencySeed } from '../docker/harness/host-dependency-seed.mjs';
import { validateMavenVerificationSettings } from '../docker/harness/maven-verification-policy.mjs';
import { prepareInstalledDependencies } from './prepare-host-installed-dependencies.mjs';

const SETTINGS = fileURLToPath(new URL('../docker/harness/maven-verification-settings.xml', import.meta.url));
const RECIPE = 'forge-host-dependency-seed-prepare/v1';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function fail(code) { throw Object.assign(new Error(code), { code }); }
const stat = (file) => lstat(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });

export function parsePreparationArguments(argv) {
  const keys = ['--source', '--source-commit', '--contract', '--output-root'];
  const allowed = [...keys, '--seed-source', '--seed-sha256'];
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.includes(argv[i]) || result[argv[i]] !== undefined || !argv[i + 1]) fail('INVALID_ARGUMENTS');
    result[argv[i]] = argv[i + 1];
  }
  if (keys.some((key) => !result[key]) || !/^[0-9a-f]{40}$/u.test(result['--source-commit'])) fail('INVALID_ARGUMENTS');
  if ((result['--seed-source'] === undefined) !== (result['--seed-sha256'] === undefined)
    || (result['--seed-sha256'] !== undefined && !/^[0-9a-f]{64}$/u.test(result['--seed-sha256']))) fail('SEED_SOURCE_REQUIRES_SHA256');
  for (const key of [...keys.filter((key) => key !== '--source-commit'), ...(result['--seed-source'] ? ['--seed-source'] : [])]) {
    if (!path.isAbsolute(result[key]) || /[\x00-\x1f]/u.test(result[key])) fail('ABSOLUTE_PATH_REQUIRED');
    result[key] = path.resolve(result[key]);
  }
  return result;
}

function seedRelative(value) {
  if (typeof value !== 'string' || /[\\:\x00-\x1f]/u.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..')
    || (!value.startsWith('m2/repository/') && !value.startsWith('pnpm/store/'))) fail('INVALID_EXPORTED_SEED_PATH');
  return value;
}

function readOnly(info) {
  if (process.platform !== 'win32' && (info.mode & 0o222) !== 0) fail('EXPORTED_SEED_MUST_BE_READ_ONLY');
}

async function seedFileHash(file) {
  await ordinaryDirectory(path.dirname(file));
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) fail('EXPORTED_SEED_NON_ORDINARY');
  readOnly(before);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const same = (info) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'nlink'].every((key) => before[key] === info[key]);
  try {
    if (!same(await handle.stat())) fail('EXPORTED_SEED_CHANGED');
    const digest = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead; digest.update(buffer.subarray(0, result.bytesRead));
    }
    if (!same(await handle.stat()) || !same(await lstat(file)) || bytes !== before.size) fail('EXPORTED_SEED_CHANGED');
    return { bytes, sha256: digest.digest('hex') };
  } finally { await handle.close(); }
}

export async function inspectExportedSeed(root, manifestSha256, limits = { maxFiles: 250_000, maxBytes: 4 * 1024 ** 3 }) {
  if (!path.isAbsolute(root) || !/^[0-9a-f]{64}$/u.test(manifestSha256)) fail('INVALID_EXPORTED_SEED_BINDING');
  readOnly(await ordinaryDirectory(root));
  const manifestFile = path.join(root, 'export-inventory.json');
  const manifestInfo = await lstat(manifestFile); readOnly(manifestInfo);
  if (manifestInfo.size > 64 * 1024 * 1024) fail('EXPORTED_SEED_MANIFEST_LIMIT');
  const bytes = await ordinaryFile(manifestFile);
  if (hash(bytes) !== manifestSha256) fail('EXPORTED_SEED_MANIFEST_MISMATCH');
  const manifest = JSON.parse(bytes);
  if (manifest?.schemaVersion !== 'forge-buildkit-dependency-export/v1' || !Array.isArray(manifest.files)
    || Object.keys(manifest).some((key) => !['schemaVersion', 'files', 'source', 'treeSha256', 'status'].includes(key))) fail('INVALID_EXPORTED_SEED_MANIFEST');
  if (manifest.source?.project !== 'forge-base' || !['forge-forge-base', ''].includes(manifest.source?.namespace)) fail('EXPORTED_SEED_PROJECT_MISMATCH');
  const files = [];
  let previous = '', total = 0;
  for (const entry of manifest.files) {
    const relative = seedRelative(entry?.path);
    if (relative <= previous || Object.keys(entry).sort().join(',') !== 'bytes,path,sha256'
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{64}$/u.test(entry.sha256 ?? '')) fail('INVALID_EXPORTED_SEED_MANIFEST');
    previous = relative; total += entry.bytes;
    if (files.length >= limits.maxFiles || total > limits.maxBytes) fail('EXPORTED_SEED_LIMIT');
    files.push({ path: relative, bytes: entry.bytes, sha256: entry.sha256 });
  }
  const treeSha256 = hash(JSON.stringify(files));
  if (manifest.treeSha256 !== undefined && manifest.treeSha256 !== treeSha256) fail('EXPORTED_SEED_TREE_DIGEST_MISMATCH');
  const actual = [];
  const visit = async (directory, relative = '') => {
    readOnly(await ordinaryDirectory(directory));
    for (const name of (await readdir(directory)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const file = path.join(directory, name), info = await lstat(file);
      if (child === 'export-inventory.json') continue;
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) fail('EXPORTED_SEED_NON_ORDINARY');
      readOnly(info);
      if (info.isDirectory()) {
        if (!['m2', 'm2/repository', 'pnpm', 'pnpm/store'].includes(child)) seedRelative(`${child}/_`);
        await visit(file, child);
      } else { seedRelative(child); actual.push({ path: child, ...await seedFileHash(file) }); }
    }
  };
  await visit(root); actual.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (JSON.stringify(actual) !== JSON.stringify(files)) fail('EXPORTED_SEED_PAYLOAD_MISMATCH');
  return { root: path.resolve(root), manifestSha256, treeSha256, files };
}

export async function importExportedSeed(seed, cacheRoot) {
  await ordinaryDirectory(cacheRoot);
  const sourceRelative = path.relative(seed.root, cacheRoot), reverse = path.relative(cacheRoot, seed.root);
  const outside = (relative) => path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
  if (!outside(sourceRelative) || !outside(reverse)) fail('EXPORTED_SEED_AND_CACHE_OVERLAP');
  let imported = 0, preserved = 0, excluded = 0;
  for (const entry of seed.files) {
    const relative = seedRelative(entry.path);
    if (/^pnpm\/store\/(?:.*\/)?projects(?:\/|$)/u.test(relative) || /\.(?:lastUpdated|part|lock)$/u.test(relative)) { excluded++; continue; }
    const source = path.join(seed.root, relative), target = path.join(cacheRoot, relative);
    await ordinaryDirectory(path.dirname(target), true);
    const existing = await stat(target);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) fail('EXISTING_CACHE_NON_ORDINARY');
      preserved++; continue;
    }
    // Publish a fully verified private copy without replacing a concurrently created cache file.
    await ordinaryDirectory(path.dirname(source));
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) fail('EXPORTED_SEED_NON_ORDINARY');
    readOnly(sourceInfo);
    const temporary = path.join(path.dirname(target), `.seed-import-${crypto.randomUUID()}`);
    await copyFile(source, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await chmod(temporary, 0o400);
    const copied = await seedFileHash(temporary);
    if (copied.bytes !== entry.bytes || copied.sha256 !== entry.sha256 || (await lstat(temporary)).nlink !== 1) fail('EXPORTED_SEED_CHANGED_DURING_COPY');
    await chmod(temporary, dependencySeedExecutable(relative, sourceInfo.mode) ? 0o700 : 0o600);
    try { await link(temporary, target); imported++; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await lstat(target);
      if (!current.isFile() || current.isSymbolicLink()) fail('EXISTING_CACHE_NON_ORDINARY');
      preserved++;
    }
    await unlink(temporary);
  }
  return { imported, preserved, excluded, sourceManifestSha256: seed.manifestSha256, sourceTreeSha256: seed.treeSha256,
    status: 'imported-unverified', businessAcceptance: false };
}

async function ordinaryDirectory(directory, create = false) {
  const parent = path.dirname(directory);
  if (parent !== directory) await ordinaryDirectory(parent, create);
  let info = await stat(directory);
  if (!info && create) { await mkdir(directory, { mode: 0o700 }); info = await lstat(directory); }
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_DIRECTORY');
  return info;
}

async function ordinaryFile(file) {
  await ordinaryDirectory(path.dirname(file));
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('UNSAFE_FILE');
  return readFile(file);
}

async function atomicJson(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, json(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

export function redactPreparationLog(text) {
  return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '')
    .replace(/(https?:\/\/)[^\s/@]+@/giu, '$1[REDACTED]@')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"']+/giu, '[REDACTED AUTHORIZATION]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED]')
    .replace(/((?:password|passwd|token|secret|api[_ -]?key|_auth(?:Token)?)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1[REDACTED]');
}

// Buffer only one bounded line per stream, so a secret split across chunks is never persisted raw.
export function preparationLogSink(write, maximumBytes) {
  let bytes = 0, truncated = false;
  const emit = (line) => {
    const value = Buffer.from(`${redactPreparationLog(line)}\n`);
    if (bytes + value.length > maximumBytes) { truncated = true; return; }
    write(value); bytes += value.length;
  };
  const stream = () => {
    const decoder = new StringDecoder('utf8');
    let pending = '', dropping = false;
    const consume = (text) => {
      for (const part of text.split(/(\n|\r)/u)) {
        if (part === '\n' || part === '\r') {
          if (!dropping && pending) emit(pending);
          pending = ''; dropping = false;
        } else if (!dropping) {
          pending += part;
          if (pending.length > 64 * 1024) { emit('[overlong process line omitted]'); pending = ''; dropping = true; }
        }
      }
    };
    return { push: (chunk) => consume(decoder.write(chunk)), end: () => { consume(decoder.end()); if (pending && !dropping) emit(pending); } };
  };
  return { stream, summary: () => ({ bytes, truncated }) };
}

export async function runPreparationProcess(command, { environment, logFile, timeoutSeconds, maxLogBytes, signal }) {
  const fd = openSync(logFile, 'wx', 0o600);
  const sink = preparationLogSink((bytes) => writeSync(fd, bytes), maxLogBytes);
  const stdout = sink.stream(), stderr = sink.stream();
  const startedAt = new Date().toISOString();
  try {
    return await new Promise((resolve) => {
      const child = spawn(command.executable, command.argv, { cwd: command.cwd, env: environment,
        shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let timedOut = false, cancelled = false, spawnFailed = false, logWriteFailed = false, killTimer;
      const terminate = () => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        const kill = (kind) => { try { process.platform === 'win32' ? child.kill(kind) : process.kill(-child.pid, kind); } catch {} };
        kill('SIGTERM');
        killTimer ??= setTimeout(() => kill('SIGKILL'), 5000);
        killTimer.unref();
      };
      const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutSeconds * 1000);
      timer.unref();
      const abort = () => { cancelled = true; terminate(); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const append = (stream, chunk) => {
        if (logWriteFailed) return;
        try { stream.push(chunk); } catch { logWriteFailed = true; terminate(); }
      };
      child.stdout.on('data', (chunk) => append(stdout, chunk));
      child.stderr.on('data', (chunk) => append(stderr, chunk));
      child.once('error', () => { spawnFailed = true; });
      child.once('close', (exitCode, exitSignal) => {
        clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
        if (!logWriteFailed) { try { stdout.end(); stderr.end(); } catch { logWriteFailed = true; } }
        resolve({ startedAt, finishedAt: new Date().toISOString(), exitCode, signal: exitSignal,
          timedOut, cancelled, spawnFailed, logWriteFailed, ...sink.summary() });
      });
    });
  } finally { closeSync(fd); }
}

export function preparationPaths(root, taskId, jobId) {
  if (!path.isAbsolute(root) || !/^[a-zA-Z0-9-]+$/u.test(taskId) || !/^[a-zA-Z0-9-]+$/u.test(jobId)) fail('INVALID_PREPARATION_PATH');
  const taskRoot = path.join(root, 'taskspaces', taskId);
  const jobRoot = path.join(taskRoot, 'jobs', jobId);
  return { jobRoot, snapshotRoot: path.join(jobRoot, 'workspace'), cacheRoot: path.join(taskRoot, 'cache'),
    tempRoot: path.join(jobRoot, 'tmp'), homeRoot: path.join(jobRoot, 'home'),
    mavenSettings: path.join(jobRoot, 'config', 'maven-settings.xml'),
    npmConfig: path.join(jobRoot, 'config', 'npmrc'), gitConfig: path.join(jobRoot, 'config', 'gitconfig') };
}

export function preparationToolchainProbe(name, argv, paths, tools) {
  // Match the Host identity probe: project packageManager must not select another pnpm.
  if (name === 'pnpm') return { executable: tools.pnpm, argv: ['--version'], cwd: paths.jobRoot };
  return hostSandboxCommand({ executable: tools[name], argv, cwd: paths.snapshotRoot }, paths, tools);
}

export function preparationRecipe(paths, tools, offline = false) {
  const mavenArguments = [
    '--strict-checksums', '--settings', paths.mavenSettings, `-Dmaven.repo.local=${path.join(paths.cacheRoot, 'm2', 'repository')}`,
    '-Penable-tests', '-Dforge.compiler.skip=false', '-Dforge.tests.skip=false', '-DskipTests',
    ...(offline ? ['--offline'] : []),
  ];
  const maven = { name: 'maven', executable: tools.maven, cwd: path.join(paths.snapshotRoot, 'forge-server'),
    argv: [...mavenArguments, '-DexcludeReactor=true', 'org.apache.maven.plugins:maven-dependency-plugin:3.9.0:go-offline'] };
  // Surefire selects these at test runtime; go-offline only visits declared dependency graphs.
  const runtimeDependencies = [
    ['maven-surefire-provider', 'org.apache.maven.surefire:surefire-junit-platform:3.1.2'],
    ['maven-junit-launcher', 'org.junit.platform:junit-platform-launcher:1.12.2'],
    // The AI dependency graph can select this legacy cached version; bind its repository through Maven.
    ['maven-commons-collections', 'org.apache.commons:commons-collections4:4.3'],
  // dependency:get needs no project; a non-recursive business root cannot resolve its reactor BOM.
  ].map(([name, artifact]) => ({ ...maven, name, cwd: paths.snapshotRoot, argv: [...mavenArguments,
    '--non-recursive', '-Dtransitive=true', `-Dartifact=${artifact}`, 'org.apache.maven.plugins:maven-dependency-plugin:3.9.0:get'] }));
  return [maven, ...runtimeDependencies, ...['forge-admin-ui', 'forge-h5-ui'].map((project) => ({ name: project,
    executable: tools.pnpm, cwd: paths.snapshotRoot, argv: ['--dir', path.join(paths.snapshotRoot, project),
      'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', path.join(paths.cacheRoot, 'pnpm', 'store'),
      ...(offline ? ['--offline'] : [])] }))];
}

export function assertResumeBinding(previous, binding) {
  if (previous?.recipe !== RECIPE || JSON.stringify(previous.binding) !== JSON.stringify(binding)) fail('RESUME_INPUT_MISMATCH');
}

async function checkedCommand(executable, argv, cwd, env) {
  const result = await runHostProcess(executable, argv, { cwd, env, timeoutSeconds: 60, maxOutputBytes: 1024 * 1024 });
  if (result.exitCode !== 0 || result.timedOut || result.truncated) fail('SOURCE_OR_TOOLCHAIN_COMMAND_FAILED');
  return result.stdout.trim();
}

async function cloneSource(source, commit, paths, tools, environment) {
  if (!(await stat(paths.snapshotRoot))) {
    await checkedCommand(tools.git, ['-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=',
      'clone', '--no-local', '--no-hardlinks', '--no-checkout', '--', source, paths.snapshotRoot], paths.jobRoot, environment);
    await checkedCommand(tools.git, ['-C', paths.snapshotRoot, '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', commit], paths.jobRoot, environment);
  }
  await ordinaryDirectory(paths.snapshotRoot);
  const head = await checkedCommand(tools.git, ['-C', paths.snapshotRoot, 'rev-parse', 'HEAD'], paths.jobRoot, environment);
  const changes = await checkedCommand(tools.git, ['-C', paths.snapshotRoot, 'status', '--porcelain=v1', '--untracked-files=all'], paths.jobRoot, environment);
  if (head !== commit || changes) fail('SNAPSHOT_CHANGED');
}

async function initializeJob(paths, settings) {
  for (const directory of [paths.jobRoot, paths.tempRoot, paths.homeRoot, paths.cacheRoot, path.dirname(paths.mavenSettings), path.join(paths.tempRoot, 'maven-jansi')]) {
    await ordinaryDirectory(directory, true);
  }
  for (const [file, bytes] of [[paths.mavenSettings, settings], [paths.npmConfig, ''], [paths.gitConfig, '']]) {
    if (await stat(file)) { if (!(await ordinaryFile(file)).equals(Buffer.from(bytes))) fail('JOB_CONFIGURATION_CHANGED'); }
    else await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
  }
}

// Copy ordinary package bytes; never copy pnpm path indexes, node_modules, links, or transient Maven failures.
export async function copySeedPayload(cacheRoot, destination, limits = { maxFiles: 250_000, maxBytes: 4 * 1024 ** 3 }) {
  await ordinaryDirectory(cacheRoot);
  if (await stat(destination)) fail('PAYLOAD_DESTINATION_EXISTS');
  await mkdir(destination, { mode: 0o700 });
  let files = 0, bytes = 0;
  const visit = async (relative) => {
    const source = path.join(cacheRoot, relative);
    await ordinaryDirectory(path.dirname(source));
    const info = await lstat(source);
    if (info.isSymbolicLink()) fail('PAYLOAD_SYMBOLIC_LINK');
    if (/^pnpm\/store\/v[0-9]+\/projects(?:\/|$)/u.test(relative)) return;
    if (info.isDirectory()) {
      await mkdir(path.join(destination, relative), { recursive: true, mode: 0o700 });
      for (const name of (await readdir(source)).sort()) await visit(`${relative}/${name}`);
    } else {
      if (!info.isFile()) fail('PAYLOAD_NON_ORDINARY_FILE');
      if (/\.(?:lastUpdated|part|lock)$/u.test(relative)) return;
      if (++files > limits.maxFiles || (bytes += info.size) > limits.maxBytes) fail('PAYLOAD_LIMIT_EXCEEDED');
      const target = path.join(destination, relative);
      await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await chmod(target, dependencySeedExecutable(relative, info.mode) ? 0o700 : 0o600);
      const after = await lstat(source), copied = await lstat(target);
      if (copied.nlink !== 1 || copied.size !== info.size
        || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((key) => info[key] !== after[key])) fail('PAYLOAD_SOURCE_CHANGED');
    }
  };
  for (const relative of ['m2/repository', 'pnpm/store']) await visit(relative);
}

async function makeReadOnly(root) {
  for (const name of await readdir(root)) {
    const file = path.join(root, name), info = await lstat(file);
    if (info.isDirectory() && !info.isSymbolicLink()) await makeReadOnly(file);
    else if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) await chmod(file, (info.mode & 0o111) ? 0o555 : 0o444);
    else fail('PAYLOAD_NON_ORDINARY_FILE');
  }
  await chmod(root, 0o555);
}

async function acquireLock(root) {
  const lockPath = path.join(root, 'preparation.lock');
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const start = async (pid) => {
    try { const value = await readFile(`/proc/${pid}/stat`, 'utf8'); return value.slice(value.lastIndexOf(')') + 2).split(' ')[19]; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const owner = { boot, pid: process.pid, start: await start(process.pid), token: crypto.randomUUID() };
  if (await stat(lockPath)) {
    const previous = JSON.parse(await ordinaryFile(lockPath));
    if (!Number.isInteger(previous.pid) || typeof previous.start !== 'string' || typeof previous.boot !== 'string') fail('INVALID_PREPARATION_LOCK');
    if (previous.boot === boot && await start(previous.pid) === previous.start) fail('PREPARATION_ALREADY_RUNNING');
    await rename(lockPath, `${lockPath}.stale-${crypto.randomUUID()}`);
  }
  const handle = await open(lockPath, 'wx', 0o600);
  await handle.writeFile(json(owner)); await handle.close();
  return async () => { if (JSON.parse(await ordinaryFile(lockPath)).token === owner.token) await unlink(lockPath); };
}

export async function prepareHostDependencySeed(argv = process.argv.slice(2), { signal } = {}) {
  const args = parsePreparationArguments(argv);
  if (process.platform !== 'linux') fail('LINUX_HOST_REQUIRED');
  const output = args['--output-root'], source = args['--source'], commit = args['--source-commit'];
  if (!/^\/srv\/forge-delivery\/canary\/[A-Za-z0-9._/-]+$/u.test(output)
    || output === source || output.startsWith(`${source}/`) || source.startsWith(`${output}/`)) fail('OWNED_CANARY_OUTPUT_REQUIRED');
  await ordinaryDirectory(source);
  await ordinaryDirectory(output, true);
  const owner = await lstat(output);
  if (owner.uid !== process.getuid() || (owner.mode & 0o022) !== 0) fail('OUTPUT_NOT_PRIVATELY_OWNED');
  const release = await acquireLock(output);
  let state;
  const stateFile = path.join(output, 'preparation.json');
  try {
    const contractBytes = await ordinaryFile(args['--contract']);
    const contract = validateHostVerificationContract(JSON.parse(contractBytes), 'forge-base');
    if (contract.processIsolation !== 'bubblewrap') fail('HOST_SANDBOX_REQUIRED');
    const tools = Object.fromEntries(await Promise.all(Object.entries(contract.toolchains).map(async ([name, file]) => [name, await realpath(file)])));
    hostSandboxReadOnlyRoots(tools);
    const settings = await ordinaryFile(SETTINGS);
    validateMavenVerificationSettings(settings.toString('utf8'));
    const mavenSettingsSha256 = hash(settings);
    const exportedSeed = args['--seed-source'] === undefined ? null
      : await inspectExportedSeed(args['--seed-source'], args['--seed-sha256'], contract.limits);
    const gitEnvironment = { PATH: '/usr/bin:/bin', HOME: output, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', LANG: 'C.UTF-8' };
    const sourceHead = await checkedCommand(tools.git, ['-C', source, '-c', `safe.directory=${source}`, 'rev-parse', 'HEAD'], output, gitEnvironment);
    const dirty = await checkedCommand(tools.git, ['-C', source, '-c', `safe.directory=${source}`, 'status', '--porcelain=v1', '--untracked-files=all'], output, gitEnvironment);
    if (sourceHead !== commit || dirty) fail('SOURCE_MUST_BE_CLEAN_AT_EXACT_COMMIT');
    const previous = await stat(stateFile) ? JSON.parse(await ordinaryFile(stateFile)) : null;
    const warmPaths = preparationPaths(output, 'seed-warm', previous?.warmJobId ?? crypto.randomUUID());
    await initializeJob(warmPaths, settings);
    await cloneSource(source, commit, warmPaths, tools, gitEnvironment);
    const inventory = await inventoryWorkspace(warmPaths.snapshotRoot, contract.limits, (_cmd, values) => runHostProcess(tools.git, values, { env: gitEnvironment, maxOutputBytes: 4 * 1024 * 1024 }));
    const environment = hostExecutionEnvironment(contract, warmPaths, tools);
    const toolchain = { executables: {} };
    for (const [name, argv] of [['java', ['-version']], ['maven', ['-version']], ['node', ['--version']], ['pnpm', ['--version']]]) {
      const command = preparationToolchainProbe(name, argv, warmPaths, tools);
      const result = await runHostProcess(command.executable, command.argv, { cwd: command.cwd, env: environment, timeoutSeconds: 15, maxOutputBytes: 65536, signal });
      if (result.exitCode !== 0 || result.timedOut || result.truncated) fail('TOOLCHAIN_PROBE_FAILED');
      toolchain.executables[name] = { version: `${result.stdout}\n${result.stderr}`.trim() };
    }
    const binding = { projectSlug: contract.projectSlug, source, sourceHead, inputs: dependencySeedInputs(inventory),
      toolchains: dependencySeedToolchains(toolchain), mavenSettingsSha256, contractSha256: hash(contractBytes),
      ...(exportedSeed ? { seedSource: { root: exportedSeed.root, manifestSha256: exportedSeed.manifestSha256, treeSha256: exportedSeed.treeSha256 } } : {}),
      recipeSha256: hash(await ordinaryFile(fileURLToPath(import.meta.url))) };
    if (previous) assertResumeBinding(previous, binding);
    state = previous ?? { recipe: RECIPE, binding, warmJobId: path.basename(warmPaths.jobRoot), status: 'pending', warmCompleted: [], attempts: [] };
    if (state.status === 'ready') {
      const verified = await verifyDependencySeed({ binding: state.dependencySeed, projectSlug: contract.projectSlug, inventory, toolchain, mavenSettingsSha256 });
      if (verified.status !== 'ready' || state.offlineProof?.packDigest !== verified.packDigest) fail('READY_SEED_CHANGED');
      return state;
    }
    await atomicJson(stateFile, state);
    const logs = path.join(output, 'logs'); await ordinaryDirectory(logs, true);
    if (exportedSeed) {
      const result = await importExportedSeed(exportedSeed, warmPaths.cacheRoot);
      const logFile = path.join(logs, `seed-import-${crypto.randomUUID()}.json`);
      await writeFile(logFile, json(result), { flag: 'wx', mode: 0o600 });
      state.seedImport = { ...result, log: path.relative(output, logFile) };
      await atomicJson(stateFile, state);
    }
    const execute = async (phase, paths) => {
      for (const step of preparationRecipe(paths, tools, phase === 'offline')) {
        if (phase === 'warm' && state.warmCompleted.includes(step.name)) continue;
        if (signal?.aborted) fail('PREPARATION_CANCELLED');
        const command = hostSandboxCommand(step, paths, tools);
        if (phase === 'offline') command.argv.unshift('--unshare-net');
        const logFile = path.join(logs, `${phase}-${step.name}-${crypto.randomUUID()}.log`);
        const result = await runPreparationProcess(command, { environment: hostExecutionEnvironment(contract, paths, tools), logFile,
          timeoutSeconds: contract.limits.defaultTimeoutSeconds, maxLogBytes: contract.limits.maxLogBytes, signal });
        const evidence = { phase, step: step.name, log: path.relative(output, logFile), ...result, logSha256: hash(await ordinaryFile(logFile)) };
        state.attempts.push(evidence);
        if (result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.spawnFailed && !result.logWriteFailed && result.signal === null) {
          if (phase === 'warm') state.warmCompleted.push(step.name);
        } else { state.status = 'pending'; state.failure = { phase, step: step.name }; await atomicJson(stateFile, state); return false; }
        await atomicJson(stateFile, state);
      }
      return true;
    };
    if (!(await execute('warm', warmPaths))) return state;
    await cloneSource(source, commit, warmPaths, tools, gitEnvironment);
    if (!state.dependencySeed) {
      const packRoot = path.join(output, `prepared-dependencies-${crypto.randomUUID()}`);
      await copySeedPayload(warmPaths.cacheRoot, packRoot, contract.limits);
      const manifest = await createDependencySeedManifest({ root: packRoot, projectSlug: contract.projectSlug, sourceHead, inventory, toolchain, mavenSettingsSha256 });
      const bytes = json(manifest);
      await writeFile(path.join(packRoot, 'manifest.json'), bytes, { flag: 'wx', mode: 0o600 });
      await makeReadOnly(packRoot);
      state.dependencySeed = { root: packRoot, manifestSha256: hash(bytes) };
      await atomicJson(stateFile, state);
    }
    const offlinePaths = preparationPaths(output, `seed-offline-${crypto.randomUUID()}`, crypto.randomUUID());
    await initializeJob(offlinePaths, settings);
    await cloneSource(source, commit, offlinePaths, tools, gitEnvironment);
    const restored = await restoreDependencySeed({ binding: state.dependencySeed, projectSlug: contract.projectSlug, inventory, toolchain, mavenSettingsSha256, cacheRoot: offlinePaths.cacheRoot });
    if (restored.status !== 'ready' || restored.restored.length !== 2 || restored.preserved.length !== 0) fail('OFFLINE_CACHE_NOT_FRESH');
    if (!(await execute('offline', offlinePaths))) return state;
    await cloneSource(source, commit, offlinePaths, tools, gitEnvironment);
    state.preparedDependencies = await prepareInstalledDependencies({ root: path.join(output, 'installed-dependencies'),
      sources: ['forge-admin-ui', 'forge-h5-ui'].map((project) => ({ project, root: path.join(offlinePaths.snapshotRoot, project, 'node_modules') })),
      projectSlug: contract.projectSlug, inventory, toolchain, seed: state.dependencySeed });
    state.status = 'ready'; delete state.failure; delete state.errorCode;
    state.offlineProof = { job: path.relative(output, offlinePaths.jobRoot), network: 'unshare-net', businessAcceptance: false,
      packDigest: restored.packDigest, completedAt: new Date().toISOString() };
    await atomicJson(stateFile, state);
    return state;
  } catch (error) {
    if (state) { state.status = 'pending'; state.errorCode = /^[A-Z0-9_]+$/u.test(error.code ?? '') ? error.code : 'PREPARATION_FAILED'; await atomicJson(stateFile, state); }
    throw error;
  } finally { await release(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  prepareHostDependencySeed(process.argv.slice(2), { signal: controller.signal }).then((state) => {
    process.stdout.write(json({ status: state.status, failure: state.failure, dependencySeed: state.dependencySeed,
      preparedDependencies: state.preparedDependencies,
      seedImport: state.seedImport, offlineProof: state.offlineProof, businessAcceptance: false }));
    if (state.status !== 'ready') process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(json({ status: 'pending', code: /^[A-Z0-9_]+$/u.test(error.code ?? '') ? error.code : 'PREPARATION_FAILED', businessAcceptance: false }));
    process.exitCode = 1;
  });
}
