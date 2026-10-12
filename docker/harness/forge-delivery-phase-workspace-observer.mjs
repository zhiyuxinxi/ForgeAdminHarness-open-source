import crypto from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_SCHEMA = 'forge-delivery-phase-workspace-snapshot/v2';

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function git(workspace, args, { allowDifference = false } = {}) {
  const result = spawnSync('git', ['-C', workspace, '-c', `safe.directory=${workspace}`, ...args], {
    encoding: null,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true,
  });
  const allowed = allowDifference ? [0, 1] : [0];
  if (result.error || !allowed.includes(result.status)) {
    fail('PHASE_OBSERVER_GIT_FAILED', `Git observation failed: ${args[0]}.`);
  }
  return result.stdout;
}

function nulPaths(bytes, label) {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) fail('PHASE_OBSERVER_GIT_INVALID', `${label} is not NUL terminated.`);
  return bytes.subarray(0, bytes.length - 1).toString('utf8').split('\0');
}

function validateRelativePath(value) {
  const normalized = value.replaceAll('\\', '/');
  if (normalized.length === 0 || normalized.includes('\0') || path.posix.isAbsolute(normalized)
    || normalized.split('/').includes('..')) {
    fail('PHASE_OBSERVER_PATH_INVALID', 'Git returned an unsafe project path.');
  }
  return normalized;
}

async function changedEntries(workspace, baseCommit) {
  const tracked = nulPaths(git(workspace, ['diff', '--name-only', '-z', baseCommit, '--']), 'tracked paths');
  const untracked = nulPaths(git(workspace, ['ls-files', '--others', '--exclude-standard', '-z']), 'untracked paths');
  const changedPaths = [...new Set([...tracked, ...untracked].map(validateRelativePath))]
    .sort((left, right) => left.localeCompare(right, 'en'));
  const entries = {};
  for (const relative of changedPaths) {
    const absolute = path.resolve(workspace, ...relative.split('/'));
    const root = path.resolve(workspace);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
      fail('PHASE_OBSERVER_PATH_INVALID', 'Changed path escaped the workspace.');
    }
    const information = await lstat(absolute).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (information === null) {
      entries[relative] = { kind: 'deleted', sha256: null, bytes: 0 };
      continue;
    }
    if (!information.isFile() || information.isSymbolicLink()) {
      fail('PHASE_OBSERVER_PATH_INVALID', `Changed path is not an ordinary file: ${relative}.`);
    }
    const bytes = await readFile(absolute);
    entries[relative] = { kind: 'file', sha256: sha256(bytes), bytes: bytes.length };
  }
  return entries;
}

function sameEntry(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail('PHASE_OBSERVER_SNAPSHOT_INVALID', `${label} does not match the reviewed schema.`);
  }
}

function renderPatch(workspace, baseCommit, changedPaths, currentEntries) {
  if (changedPaths.length === 0) return Buffer.alloc(0);
  const tracked = [];
  const untracked = [];
  for (const relative of changedPaths) {
    const known = git(workspace, ['ls-files', '--error-unmatch', '--', relative], { allowDifference: true });
    if (known.length > 0) tracked.push(relative);
    else if (currentEntries[relative]?.kind === 'file') untracked.push(relative);
  }
  const chunks = [];
  if (tracked.length > 0) chunks.push(git(workspace, ['diff', '--binary', baseCommit, '--', ...tracked]));
  for (const relative of untracked) {
    const result = spawnSync('git', ['-C', workspace, 'diff', '--binary', '--no-index', '--', '/dev/null', relative], {
      encoding: null,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    });
    if (result.error || result.status !== 1) {
      fail('PHASE_OBSERVER_GIT_FAILED', `Git could not render untracked path ${relative}.`);
    }
    chunks.push(result.stdout);
  }
  return Buffer.concat(chunks);
}

async function writeExclusive(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Phase evidence crosses a strict container identity boundary: the observer
  // writes as uid/gid 1000 while the controller runs as capability-dropped
  // uid 0 with only gid 1000 added. Keep evidence private to that reviewed
  // producer/consumer group instead of relying on root DAC bypass.
  const handle = await open(file, 'wx', 0o640);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function snapshotValue(baseCommit, entries, cumulativePatchDigest) {
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA,
    baseCommit,
    changedPaths: Object.keys(entries),
    entries,
    cumulativePatchDigest,
    snapshotDigest: '',
  };
  snapshot.snapshotDigest = sha256(Buffer.from(JSON.stringify({
    baseCommit,
    entries,
    cumulativePatchDigest,
  }), 'utf8'));
  return snapshot;
}

export function validateForgeDeliveryWorkspaceSnapshot(value) {
  exactKeys(value, [
    'schemaVersion', 'baseCommit', 'changedPaths', 'entries',
    'cumulativePatchDigest', 'snapshotDigest',
  ], 'workspace snapshot');
  if (value.schemaVersion !== SNAPSHOT_SCHEMA || !COMMIT_PATTERN.test(value.baseCommit ?? '')
    || !SHA256_PATTERN.test(value.cumulativePatchDigest ?? '')
    || !SHA256_PATTERN.test(value.snapshotDigest ?? '')) {
    fail('PHASE_OBSERVER_SNAPSHOT_INVALID', 'Workspace snapshot identity is invalid.');
  }
  if (!Array.isArray(value.changedPaths)) {
    fail('PHASE_OBSERVER_SNAPSHOT_INVALID', 'Workspace snapshot paths are invalid.');
  }
  const normalizedPaths = value.changedPaths.map((entry) => (
    typeof entry === 'string' ? validateRelativePath(entry) : fail(
      'PHASE_OBSERVER_SNAPSHOT_INVALID',
      'Workspace snapshot paths are invalid.',
    )
  ));
  const canonicalPaths = [...normalizedPaths].sort((left, right) => left.localeCompare(right, 'en'));
  if (new Set(normalizedPaths).size !== normalizedPaths.length
    || JSON.stringify(normalizedPaths) !== JSON.stringify(canonicalPaths)) {
    fail('PHASE_OBSERVER_SNAPSHOT_INVALID', 'Workspace snapshot paths are not canonical.');
  }
  exactKeys(value.entries, normalizedPaths, 'workspace snapshot entries');
  if (JSON.stringify(Object.keys(value.entries)) !== JSON.stringify(normalizedPaths)) {
    fail('PHASE_OBSERVER_SNAPSHOT_INVALID', 'Workspace snapshot entry order is not canonical.');
  }
  for (const relative of normalizedPaths) {
    const entry = value.entries[relative];
    exactKeys(entry, ['kind', 'sha256', 'bytes'], `workspace snapshot entry ${relative}`);
    const validFile = entry.kind === 'file' && SHA256_PATTERN.test(entry.sha256 ?? '')
      && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0;
    const validDeletion = entry.kind === 'deleted' && entry.sha256 === null && entry.bytes === 0;
    if (!validFile && !validDeletion) {
      fail('PHASE_OBSERVER_SNAPSHOT_INVALID', `Workspace snapshot entry ${relative} is invalid.`);
    }
  }
  const expectedDigest = sha256(Buffer.from(JSON.stringify({
    baseCommit: value.baseCommit,
    entries: value.entries,
    cumulativePatchDigest: value.cumulativePatchDigest,
  }), 'utf8'));
  if (value.snapshotDigest !== expectedDigest) {
    fail('PHASE_OBSERVER_SNAPSHOT_INVALID', 'Workspace snapshot digest is invalid.');
  }
  return Object.freeze(structuredClone(value));
}

export async function snapshotForgeDeliveryWorkspace({ workspace, baseCommit, expectedHead = baseCommit }) {
  if (!path.isAbsolute(workspace) || !COMMIT_PATTERN.test(baseCommit ?? '') || !COMMIT_PATTERN.test(expectedHead ?? '')) {
    fail('PHASE_OBSERVER_ARGUMENT_INVALID', 'Workspace or base commit is invalid.');
  }
  const head = git(workspace, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (head !== expectedHead) {
    fail('PHASE_OBSERVER_SOURCE_DRIFT', 'Workspace HEAD does not match the pinned source commit.');
  }
  const entries = await changedEntries(workspace, baseCommit);
  const cumulativePatch = renderPatch(workspace, baseCommit, Object.keys(entries), entries);
  return validateForgeDeliveryWorkspaceSnapshot(snapshotValue(
    baseCommit,
    entries,
    sha256(cumulativePatch),
  ));
}

export async function observeForgeDeliveryPhase({ workspace, baseCommit, before }) {
  const prior = validateForgeDeliveryWorkspaceSnapshot(before);
  if (prior.baseCommit !== baseCommit) {
    fail('PHASE_OBSERVER_SNAPSHOT_INVALID', 'Before snapshot is invalid or stale.');
  }
  const currentEntries = await changedEntries(workspace, baseCommit);
  const phaseChangedPaths = [...new Set([...Object.keys(prior.entries), ...Object.keys(currentEntries)])]
    .filter((relative) => !sameEntry(prior.entries[relative], currentEntries[relative]))
    .sort((left, right) => left.localeCompare(right, 'en'));
  const allChangedPaths = Object.keys(currentEntries);
  const phasePatch = renderPatch(workspace, baseCommit, phaseChangedPaths, currentEntries);
  const cumulativePatch = renderPatch(workspace, baseCommit, allChangedPaths, currentEntries);
  return Object.freeze({
    snapshot: snapshotValue(baseCommit, currentEntries, sha256(cumulativePatch)),
    allChangedPaths,
    phaseChangedPaths,
    phasePatch,
    cumulativePatch,
    phasePatchDigest: sha256(phasePatch),
    cumulativePatchDigest: sha256(cumulativePatch),
  });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail('PHASE_OBSERVER_ARGUMENT_INVALID', 'Arguments must be --name value pairs.');
    const name = key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    if (Object.hasOwn(options, name)) fail('PHASE_OBSERVER_ARGUMENT_INVALID', `Duplicate argument ${key}.`);
    options[name] = value;
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.command === 'snapshot') {
    const expected = ['baseCommit', 'command', 'output', 'workspace'].sort();
    if (JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(expected)) {
      fail('PHASE_OBSERVER_ARGUMENT_INVALID', 'Snapshot arguments do not match the reviewed schema.');
    }
    const existing = await lstat(options.output).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    let snapshot;
    let reused;
    if (existing === null) {
      snapshot = await snapshotForgeDeliveryWorkspace(options);
      await writeExclusive(options.output, Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`));
      reused = false;
    } else {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size < 2 || existing.size > MAX_GIT_OUTPUT_BYTES) {
        fail('PHASE_OBSERVER_SNAPSHOT_INVALID', 'Existing phase-origin snapshot is not a bounded ordinary file.');
      }
      try {
        snapshot = validateForgeDeliveryWorkspaceSnapshot(JSON.parse(await readFile(options.output, 'utf8')));
      } catch (error) {
        if (error?.code === 'PHASE_OBSERVER_SNAPSHOT_INVALID') throw error;
        fail('PHASE_OBSERVER_SNAPSHOT_INVALID', 'Existing phase-origin snapshot is not valid JSON.');
      }
      if (snapshot.baseCommit !== options.baseCommit) {
        fail('PHASE_OBSERVER_SNAPSHOT_INVALID', 'Existing phase-origin snapshot belongs to another source commit.');
      }
      reused = true;
    }
    return {
      snapshotDigest: snapshot.snapshotDigest,
      cumulativePatchDigest: snapshot.cumulativePatchDigest,
      changedPaths: snapshot.changedPaths,
      reused,
    };
  }
  if (options.command === 'observe') {
    const expected = [
      'allChangedPaths', 'baseCommit', 'before', 'command', 'cumulativePatch', 'output',
      'phaseChangedPaths', 'phasePatch', 'workspace',
    ].sort();
    if (JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(expected)) {
      fail('PHASE_OBSERVER_ARGUMENT_INVALID', 'Observe arguments do not match the reviewed schema.');
    }
    const before = JSON.parse((await readFile(options.before, 'utf8')));
    const observation = await observeForgeDeliveryPhase({ ...options, before });
    await Promise.all([
      writeExclusive(options.output, Buffer.from(`${JSON.stringify(observation.snapshot, null, 2)}\n`)),
      writeExclusive(options.allChangedPaths, Buffer.from(`${JSON.stringify(observation.allChangedPaths)}\n`)),
      writeExclusive(options.phaseChangedPaths, Buffer.from(`${JSON.stringify(observation.phaseChangedPaths)}\n`)),
      writeExclusive(options.phasePatch, observation.phasePatch),
      writeExclusive(options.cumulativePatch, observation.cumulativePatch),
    ]);
    return {
      snapshotDigest: observation.snapshot.snapshotDigest,
      allChangedPaths: observation.allChangedPaths,
      phaseChangedPaths: observation.phaseChangedPaths,
      phasePatchDigest: observation.phasePatchDigest,
      cumulativePatchDigest: observation.cumulativePatchDigest,
    };
  }
  fail('PHASE_OBSERVER_ARGUMENT_INVALID', 'Command must be snapshot or observe.');
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(realpathSync(path.resolve(process.argv[1]))) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main(process.argv.slice(2))
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`forge phase observer: ${error.code ?? 'ERROR'}: ${error.message}\n`);
      process.exitCode = 1;
    });
}
