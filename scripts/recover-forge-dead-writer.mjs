#!/usr/bin/env node
// Operator-only recovery. No Broker route, tool replay, container start or workspace write.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chown, lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const sha = raw => createHash('sha256').update(raw).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function requireValue(condition, code, message) { if (!condition) fail(code, message); }
function exact(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'DEAD_WRITER_DESCRIPTOR_INVALID', `${label} fields are invalid.`);
}
function validateDescriptor(value) {
  exact(value, ['schemaVersion', 'operationId', 'projectSlug', 'taskId', 'permitId', 'expectedExecutionId',
    'expectedGeneration', 'expectedContainerId', 'expectedImage', 'trustedControlContainers'], 'Operator descriptor');
  requireValue(value.schemaVersion === 1 && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.operationId)
    && /^[a-z0-9][a-z0-9-]{0,62}$/u.test(value.projectSlug) && /^c-[a-f0-9]{24}$/u.test(value.taskId)
    && UUID.test(value.permitId) && UUID.test(value.expectedExecutionId)
    && Number.isSafeInteger(value.expectedGeneration) && value.expectedGeneration >= 1
    && SHA.test(value.expectedContainerId) && /^sha256:[a-f0-9]{64}$/u.test(value.expectedImage)
    && Array.isArray(value.trustedControlContainers) && value.trustedControlContainers.length <= 512,
  'DEAD_WRITER_DESCRIPTOR_INVALID', 'Operator identity or container binding is invalid.');
  const seen = new Set();
  for (const item of value.trustedControlContainers) {
    exact(item, ['id', 'image'], 'Trusted control container');
    requireValue(SHA.test(item.id) && /^sha256:[a-f0-9]{64}$/u.test(item.image)
      && item.id !== value.expectedContainerId && !seen.has(item.id),
    'DEAD_WRITER_DESCRIPTOR_INVALID', 'Trusted control identity is invalid or duplicated.');
    seen.add(item.id);
  }
  return structuredClone(value);
}
async function directory(name) {
  const info = await lstat(name);
  requireValue(info.isDirectory() && !info.isSymbolicLink() && await realpath(name) === path.resolve(name),
    'DEAD_WRITER_PATH_INVALID', 'A recovery directory is not canonical.');
  return info;
}
async function ordinaryFile(name, limit = 1024 * 1024) {
  const before = await lstat(name);
  requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= limit
    && await realpath(name) === path.resolve(name) && (process.platform === 'win32' || (before.mode & 0o022) === 0),
  'DEAD_WRITER_PATH_INVALID', 'A protected recovery input is unsafe.');
  const raw = await readFile(name), after = await lstat(name);
  requireValue(before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs, 'DEAD_WRITER_INPUT_CHANGED', 'A recovery input changed while reading.');
  return { raw, info: after };
}
async function atomic(name, raw, info) {
  const temporary = `${name}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', info ? info.mode & 0o777 : 0o600);
    await handle.writeFile(raw); await handle.sync(); await handle.close(); handle = undefined;
    if (info && process.platform !== 'win32') await chown(temporary, info.uid, info.gid);
    await rename(temporary, name);
    if (process.platform !== 'win32') {
      const parent = await open(path.dirname(name), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
async function runtimeModules() {
  for (const root of [path.resolve(import.meta.dirname, '../lib'), path.resolve(import.meta.dirname, '../docker/harness')]) {
    const storeFile = path.join(root, 'forge-writer-scope-lease.mjs');
    const exists = await lstat(storeFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!exists) continue;
    const store = await import(pathToFileURL(storeFile).href);
    const context = await import(pathToFileURL(path.join(root, 'forge-execution-context.mjs')).href);
    requireValue(typeof store.recoverForgeWriterScopeLease === 'function'
      && typeof context.readCurrentProtectedExecutionContextForTask === 'function',
    'DEAD_WRITER_RUNTIME_INVALID', 'Versioned recovery exports are unavailable.');
    return { recoverLease: store.recoverForgeWriterScopeLease, readCurrentContext: context.readCurrentProtectedExecutionContextForTask };
  }
  fail('DEAD_WRITER_RUNTIME_INVALID', 'Versioned recovery modules are unavailable.');
}
async function command(args) {
  return execute('/usr/bin/docker', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
}
const liveDocker = {
  async listContainers() {
    const ids = (await command(['ps', '--all', '--quiet', '--no-trunc'])).stdout.trim().split(/\s+/u).filter(Boolean);
    requireValue(ids.every(id => SHA.test(id)), 'DEAD_WRITER_DOCKER_INVALID', 'Docker returned invalid container identities.');
    const containers = [];
    for (let offset = 0; offset < ids.length; offset += 128) {
      containers.push(...JSON.parse((await command(['inspect', '--type', 'container', ...ids.slice(offset, offset + 128)])).stdout));
    }
    return containers;
  },
  async inspect(id) {
    try { return JSON.parse((await command(['inspect', '--type', 'container', id])).stdout)[0]; }
    catch (error) {
      if (error.code === 1 && /No such (?:object|container)/iu.test(error.stderr ?? '')) return null;
      throw error;
    }
  },
  async remove(id) { await command(['rm', '--', id]); },
};
function projection(container) {
  return { id: container.Id, image: container.Image, name: container.Name,
    inspectCanonicalSha256: sha(canonical(container)),
    commandSha256: sha(canonical({ entrypoint: container.Config?.Entrypoint ?? null, command: container.Config?.Cmd ?? null })),
    composeProject: container.Config?.Labels?.['com.docker.compose.project'],
    composeService: container.Config?.Labels?.['com.docker.compose.service'],
    state: Object.fromEntries(['Status', 'Running', 'Paused', 'Restarting', 'Pid', 'StartedAt', 'FinishedAt'].map(key => [key, container.State?.[key]])),
    restartPolicy: container.HostConfig?.RestartPolicy?.Name,
    mounts: container.Mounts.map(mount => ({ type: mount.Type, source: mount.Source, destination: mount.Destination, rw: mount.RW })) };
}
function staticDead(container) {
  requireValue(container.State?.Status === 'exited' && container.State.Running === false
    && container.State.Restarting === false && container.State.Paused === false && container.State.Pid === 0
    && container.HostConfig?.RestartPolicy?.Name === 'no', 'DEAD_WRITER_NOT_QUIESCENT',
  'Every potential writer must already be exited, PID zero, unpaused and restart=no; this tool never stops live containers.');
}
async function ancestry(name) {
  const canonicalPath = await realpath(name);
  const entries = [];
  for (let current = canonicalPath; ; current = path.dirname(current)) {
    const info = await stat(current); entries.push(`${info.dev}:${info.ino}`);
    if (current === path.dirname(current)) break;
  }
  return { path: canonicalPath, entries };
}
async function overlaps(source, roots) {
  requireValue(typeof source === 'string' && path.isAbsolute(source), 'DEAD_WRITER_DOCKER_INVALID', 'Docker writable mount source is invalid.');
  const candidate = await ancestry(source);
  return roots.some(root => root.entries.includes(candidate.entries[0]) || candidate.entries.includes(root.entries[0]));
}
async function missingMount(source, container, roots) {
  staticDead(container);
  const missingComponents = [];
  let current = source;
  for (;;) {
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missingComponents.push(current);
      const parent = path.dirname(current);
      requireValue(parent !== current, 'DEAD_WRITER_PATH_INVALID', 'Missing mount has no verifiable existing ancestor.');
      current = parent;
      continue;
    }
    requireValue(info.isDirectory() && !info.isSymbolicLink(), 'DEAD_WRITER_PATH_INVALID',
      'A missing mount traverses a symlink or non-directory; quiescence is not established.');
    const ancestor = await ancestry(current);
    const matched = roots.some(root => root.entries.includes(ancestor.entries[0]) || ancestor.entries.includes(root.entries[0]));
    return { containerId: container.Id, source, missingComponents,
      ancestor: { source: current, canonicalPath: ancestor.path, identity: ancestor.entries[0] }, overlapsProtected: matched };
  }
}
async function scan(docker, descriptor, roots) {
  const containers = await docker.listContainers();
  requireValue(Array.isArray(containers) && new Set(containers.map(item => item.Id)).size === containers.length,
    'DEAD_WRITER_DOCKER_INVALID', 'Docker snapshot is invalid.');
  const trusted = new Map(descriptor.trustedControlContainers.map(item => [item.id, item]));
  for (const [id, expected] of trusted) {
    const actual = containers.find(item => item.Id === id);
    requireValue(actual && actual.Image === expected.image && Array.isArray(actual.Mounts)
      && !actual.Mounts.some(mount => ['/workspace', '/home/node/.dsh'].includes(mount.Destination)),
    'DEAD_WRITER_CONTROL_INVALID', 'Trusted control container is missing, changed, or exposes a TaskSpace runtime mount.');
  }
  const writers = [], controls = [], missingMounts = [];
  for (const container of containers) {
    requireValue(SHA.test(container.Id) && Array.isArray(container.Mounts), 'DEAD_WRITER_DOCKER_INVALID', 'Container snapshot is malformed.');
    let matched = false;
    for (const mount of container.Mounts) {
      if (mount.RW !== true || mount.Type === 'tmpfs') continue;
      requireValue(['bind', 'volume'].includes(mount.Type), 'DEAD_WRITER_DOCKER_INVALID', 'Unknown writable mount type.');
      try { if (await overlaps(mount.Source, roots)) matched = true; }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const evidence = await missingMount(mount.Source, container, roots);
        missingMounts.push(evidence);
        if (evidence.overlapsProtected) matched = true;
      }
    }
    if (!matched) continue;
    if (trusted.has(container.Id)) { controls.push(projection(container)); continue; }
    staticDead(container); writers.push(projection(container));
  }
  return { writers: writers.sort((a, b) => a.id.localeCompare(b.id)), controls: controls.sort((a, b) => a.id.localeCompare(b.id)),
    missingMounts: missingMounts.sort((a, b) => a.containerId.localeCompare(b.containerId) || a.source.localeCompare(b.source)) };
}
async function exactTarget(container, descriptor, workspace, dshHome) {
  requireValue(container && container.Id === descriptor.expectedContainerId && container.Image === descriptor.expectedImage
    && container.Config?.Labels?.['com.docker.compose.project'] === `forge-${descriptor.projectSlug}-task-${descriptor.taskId}`
    && container.Config?.Labels?.['com.docker.compose.service'] === 'harness',
  'DEAD_WRITER_TARGET_MISMATCH', 'Exact dead container identity does not match the protected TaskSpace.');
  staticDead(container);
  for (const [destination, source] of [['/workspace', workspace], ['/home/node/.dsh', dshHome]]) {
    const matches = container.Mounts.filter(mount => mount.Destination === destination);
    requireValue(matches.length === 1 && matches[0].Type === 'bind' && matches[0].RW === true
      && await realpath(matches[0].Source) === source, 'DEAD_WRITER_TARGET_MISMATCH', 'Dead container mounts do not identify this TaskSpace.');
  }
  requireValue(Number.isFinite(Date.parse(container.State.StartedAt)) && Number.isFinite(Date.parse(container.State.FinishedAt))
    && Date.parse(container.State.FinishedAt) >= Date.parse(container.State.StartedAt),
  'DEAD_WRITER_TARGET_MISMATCH', 'Dead container timestamps are invalid.');
  return projection(container);
}

export async function recoverForgeDeadWriter({ descriptor: input, allowedRoot, validateSharedLocks,
  docker = liveDocker, recoverLease, readCurrentContext }) {
  const descriptor = validateDescriptor(input);
  requireValue(typeof validateSharedLocks === 'function', 'DEAD_WRITER_LOCK_REQUIRED', 'Inherited lifecycle lock validation is required.');
  await validateSharedLocks();
  requireValue(path.isAbsolute(allowedRoot) && await realpath(allowedRoot) === path.resolve(allowedRoot),
    'DEAD_WRITER_PATH_INVALID', 'Delivery root is not canonical.');
  const projectRoot = path.join(allowedRoot, 'projects', descriptor.projectSlug);
  const taskRoot = path.join(projectRoot, 'taskspaces', descriptor.taskId);
  const workspace = path.join(taskRoot, 'workspace'), dshHome = path.join(taskRoot, 'dsh-home');
  for (const item of [projectRoot, path.dirname(taskRoot), taskRoot, workspace, dshHome, path.join(taskRoot, 'maintenance')]) await directory(item);
  const metadata = JSON.parse((await ordinaryFile(path.join(taskRoot, 'metadata.json'))).raw);
  requireValue(metadata.projectSlug === descriptor.projectSlug && metadata.taskId === descriptor.taskId
    && UUID.test(metadata.actorUserId) && UUID.test(metadata.conversationId),
  'DEAD_WRITER_TASK_MISMATCH', 'Protected TaskSpace metadata does not match the recovery target.');
  const taskEnv = (await ordinaryFile(path.join(taskRoot, 'task.env'))).raw.toString('utf8');
  for (const [key, value] of Object.entries({ TASKSPACE_COMPOSE_PROJECT_NAME: `forge-${descriptor.projectSlug}-task-${descriptor.taskId}`,
    PROJECT_COMPOSE_NAME: `forge-${descriptor.projectSlug}`, TASKSPACE_ROOT: taskRoot, PROJECT_SLUG: descriptor.projectSlug, TASKSPACE_ID: descriptor.taskId })) {
    const found = taskEnv.split(/\r?\n/u).filter(line => line.startsWith(`${key}=`));
    requireValue(found.length === 1 && found[0] === `${key}=${value}`, 'DEAD_WRITER_TASK_MISMATCH', 'TaskSpace environment identity differs from metadata.');
  }
  const stateRoot = path.join(projectRoot, 'taskspaces', '.broker'); await directory(stateRoot);
  const operations = path.join(stateRoot, 'dead-writer-recovery');
  await mkdir(operations, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); await directory(operations);
  const operationRoot = path.join(operations, descriptor.operationId);
  await mkdir(operationRoot, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; }); await directory(operationRoot);
  const operationFile = path.join(operationRoot, 'operation.json');
  const fenceFile = path.join(taskRoot, 'maintenance', 'proxy-fence.json');
  const descriptorDigest = sha(canonical(descriptor)), maintenance = Buffer.from(`${JSON.stringify({ schemaVersion: 1, state: 'maintenance', epoch: descriptor.operationId })}\n`);
  let operation, ownsOperation = false;
  try { operation = JSON.parse((await ordinaryFile(operationFile, 16 * 1024 * 1024)).raw); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const save = async () => {
    const raw = Buffer.from(`${JSON.stringify(operation, null, 2)}\n`);
    requireValue(raw.length <= 16 * 1024 * 1024, 'DEAD_WRITER_EVIDENCE_LIMIT', 'Bounded recovery evidence storage is full; preserve the fence.');
    await atomic(operationFile, raw);
  };
  const assertFence = async () => requireValue((await ordinaryFile(fenceFile, 4096)).raw.equals(maintenance),
    'DEAD_WRITER_FENCE_CHANGED', 'Recovery maintenance fence changed; keep the task quarantined.');
  try {
    const fence = await ordinaryFile(fenceFile, 4096);
    if (!operation) {
      const value = JSON.parse(fence.raw); exact(value, ['schemaVersion', 'state', 'epoch'], 'TaskSpace fence');
      requireValue(value.schemaVersion === 1 && value.state === 'committed', 'DEAD_WRITER_FENCE_CHANGED', 'Another maintenance operation owns the TaskSpace.');
      operation = { schemaVersion: 1, descriptorDigest, descriptor, phase: 'prepared', fenceBeforeBase64: fence.raw.toString('base64'),
        target: null, proof: null, attempts: [], toolResult: 'unknown' };
      ownsOperation = true;
      await save();
    } else {
      requireValue(operation.schemaVersion === 1 && operation.descriptorDigest === descriptorDigest
        && canonical(operation.descriptor) === canonical(descriptor), 'DEAD_WRITER_OPERATION_MISMATCH', 'Existing recovery belongs to another exact operation.');
      ownsOperation = true;
    }
    const before = Buffer.from(operation.fenceBeforeBase64, 'base64');
    requireValue(fence.raw.equals(before) || fence.raw.equals(maintenance), 'DEAD_WRITER_FENCE_CHANGED', 'TaskSpace fence CAS preimage differs.');
    if (!fence.raw.equals(maintenance)) await atomic(fenceFile, maintenance, fence.info);
    await assertFence();
    const roots = await Promise.all([workspace, dshHome].map(ancestry));
    const existing = await docker.inspect(descriptor.expectedContainerId);
    if (existing) {
      const target = await exactTarget(existing, descriptor, workspace, dshHome);
      if (operation.target) requireValue(canonical(operation.target) === canonical(target), 'DEAD_WRITER_TARGET_MISMATCH', 'Recorded dead container changed before removal.');
      operation.target = target; operation.beforeRemoval = await scan(docker, descriptor, roots);
      operation.phase = 'remove-authorized'; await save();
      await validateSharedLocks(); await assertFence();
      await exactTarget(await docker.inspect(descriptor.expectedContainerId), descriptor, workspace, dshHome);
      await docker.remove(descriptor.expectedContainerId); // No --force: a revived container cannot be killed here.
    } else {
      requireValue(operation.target && ['remove-authorized', 'removed', 'recovered'].includes(operation.phase),
        'DEAD_WRITER_TARGET_MISSING', 'Missing target has no durable previously verified removal authorization.');
    }
    requireValue(await docker.inspect(descriptor.expectedContainerId) === null, 'DEAD_WRITER_TARGET_PRESENT', 'Exact container was not removed.');
    operation.afterRemoval = await scan(docker, descriptor, roots);
    if (operation.phase !== 'recovered') operation.phase = 'removed';
    await save();
    if (!recoverLease || !readCurrentContext) {
      const runtime = await runtimeModules(); recoverLease ??= runtime.recoverLease; readCurrentContext ??= runtime.readCurrentContext;
    }
    const recovered = await recoverLease({ projectRoot, taskMetadata: metadata, workspace,
      permitId: descriptor.permitId, expectedExecutionId: descriptor.expectedExecutionId, expectedGeneration: descriptor.expectedGeneration,
      verifyQuiescence: async record => {
        await validateSharedLocks(); await assertFence();
        requireValue(record.permitId === descriptor.permitId && record.executionId === descriptor.expectedExecutionId
          && record.generation === descriptor.expectedGeneration && record.projectSlug === metadata.projectSlug
          && record.taskId === metadata.taskId && record.actorUserId === metadata.actorUserId && record.conversationId === metadata.conversationId,
        'DEAD_WRITER_PERMIT_MISMATCH', 'Store callback differs from the exact protected task and permit.');
        requireValue(await docker.inspect(descriptor.expectedContainerId) === null, 'DEAD_WRITER_TARGET_PRESENT', 'Dead container identity exists again.');
        const observed = await scan(docker, descriptor, roots);
        const context = await readCurrentContext({ projectRoot, taskMetadata: metadata, allowExpiredForRenewal: true });
        requireValue(context.projectSlug === metadata.projectSlug && context.taskId === metadata.taskId
          && context.actorUserId === metadata.actorUserId && context.conversationId === metadata.conversationId
          && Number.isSafeInteger(context.generation) && context.generation >= 1,
        'DEAD_WRITER_CONTEXT_MISMATCH', 'Fresh protected execution identity or generation differs.');
        if (!operation.proof || (record.status === 'in-flight' && context.generation > operation.proof.revokedThroughGeneration)) {
          if (operation.proof) {
            operation.supersededUncommittedProofs ??= [];
            operation.supersededUncommittedProofs.push(operation.proof);
          }
          const evidence = { descriptorDigest, target: operation.target, beforeRemoval: operation.beforeRemoval,
            afterRemoval: observed, fenceSha256: sha(maintenance), protectedGeneration: context.generation };
          operation.deathEvidence = evidence;
          operation.proof = { schemaVersion: 1, containerId: descriptor.expectedContainerId,
            startedAt: operation.target.state.StartedAt, finishedAt: operation.target.state.FinishedAt,
            removed: true, fenceEpoch: descriptor.operationId, evidenceSha256: sha(canonical(evidence)), toolResult: 'unknown',
            revokedThroughGeneration: Math.max(context.generation, record.generation) };
          await save(); // Survives a crash after container removal, before or after atomic store recovery.
        }
        requireValue(operation.proof.evidenceSha256 === sha(canonical(operation.deathEvidence)),
          'DEAD_WRITER_OPERATION_MISMATCH', 'Persisted death evidence changed.');
        await assertFence(); await validateSharedLocks();
        return Object.freeze({ ...operation.proof });
      } });
    operation.phase = 'recovered'; operation.result = recovered;
    operation.attempts.push({ at: new Date().toISOString(), status: 'recovered' }); await save();
    return { schemaVersion: 1, status: 'recovered', operationId: descriptor.operationId, permitId: descriptor.permitId,
      operationFile, result: recovered, proof: operation.proof, taskFenced: true, toolResult: 'unknown',
      businessWrites: 0, toolReplays: 0, containersStarted: 0 };
  } catch (error) {
    if (operation && ownsOperation) {
      operation.attempts.push({ at: new Date().toISOString(), status: 'failed', code: error.code ?? 'ERROR', message: String(error.message) });
      await save();
    }
    throw error;
  }
}

function sharedLocks(allowedRoot, slug) {
  const registry = path.join(allowedRoot, 'registry');
  return [path.join(registry, 'harness-image-upgrade.lock'), path.join(registry, 'taskspaces.lock'), path.join(registry, `${slug}.recovery.lock`)];
}
const LOCK_WORKER = `set -Eeuo pipefail
exec 7>>"$1"; flock --exclusive --nonblock 7 || exit 75
exec 8>>"$2"; flock --exclusive --nonblock 8 || exit 76
exec 9>>"$3"; flock --exclusive --nonblock 9 || exit 77
shift 3
exec "$@"`;
async function checkedLock(file) {
  const info = await lstat(file);
  requireValue(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o002) === 0
    && await realpath(file) === file, 'DEAD_WRITER_LOCK_INVALID', 'Shared lifecycle lock is missing or unsafe.');
  return info;
}
export async function validateDeadWriterInheritedLocks(files) {
  for (let index = 0; index < files.length; index += 1) {
    const fd = index + 7, file = files[index], before = await checkedLock(file);
    const descriptorPath = `/proc/self/fd/${fd}`, opened = await stat(descriptorPath);
    requireValue(await realpath(descriptorPath) === file && opened.dev === before.dev && opened.ino === before.ino,
      'DEAD_WRITER_LOCK_INVALID', 'Inherited lifecycle descriptor differs from its real lock file.');
    const self = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'],
        { stdio: ['ignore', 'ignore', 'pipe', fd] });
      child.once('error', reject); child.once('close', resolve);
    });
    requireValue(self === 0, 'DEAD_WRITER_LOCK_INVALID', 'Inherited lifecycle lock was not acquired.');
    let contender = 0;
    try { await execute('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', file, 'true'], { timeout: 5000 }); }
    catch (error) { contender = error.code; }
    requireValue(contender === 75, 'DEAD_WRITER_LOCK_INVALID', 'Lifecycle lock is not held exclusively.');
    const after = await checkedLock(file);
    requireValue(before.dev === after.dev && before.ino === after.ino, 'DEAD_WRITER_LOCK_INVALID', 'Lifecycle lock was replaced.');
  }
}
async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: recover-forge-dead-writer.mjs --descriptor <operator-owned.json> --allowed-root <delivery-root>\nKeeps the TaskSpace fenced; never starts containers or replays writes.'); return;
  }
  requireValue(process.platform === 'linux', 'DEAD_WRITER_PLATFORM_INVALID', 'The operator CLI requires Linux lifecycle locks and Docker.');
  requireValue(process.getuid() === 0, 'DEAD_WRITER_OPERATOR_REQUIRED',
    'The operator CLI requires root to verify all real Docker mount ancestry; unreadable sources cannot establish quiescence.');
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    requireValue(['--descriptor', '--allowed-root', '--locked-descriptor-sha256'].includes(args[index])
      && args[index + 1] && !options.has(args[index]), 'DEAD_WRITER_ARGUMENT_INVALID', 'Invalid CLI arguments.');
    options.set(args[index], args[index + 1]);
  }
  requireValue(options.has('--descriptor') && options.has('--allowed-root'), 'DEAD_WRITER_ARGUMENT_INVALID', 'Descriptor and allowed root are required.');
  const descriptorFile = path.resolve(options.get('--descriptor')), allowedRoot = path.resolve(options.get('--allowed-root'));
  const input = await ordinaryFile(descriptorFile), descriptor = validateDescriptor(JSON.parse(input.raw));
  requireValue((input.info.mode & 0o077) === 0 && input.info.uid === process.getuid(),
    'DEAD_WRITER_DESCRIPTOR_INVALID', 'Operator descriptor must be private and owned by the executing host identity.');
  requireValue(!descriptorFile.startsWith(path.join(allowedRoot, 'projects') + path.sep),
    'DEAD_WRITER_DESCRIPTOR_INVALID', 'Operator descriptor cannot be provided from project or TaskSpace storage.');
  await directory(allowedRoot); await directory(path.join(allowedRoot, 'registry'));
  const locks = sharedLocks(allowedRoot, descriptor.projectSlug);
  for (const file of locks) await checkedLock(file);
  if (!options.has('--locked-descriptor-sha256')) {
    const exit = await new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', ['-c', LOCK_WORKER, 'forge-dead-writer-locks', ...locks, process.execPath,
        fileURLToPath(import.meta.url), '--descriptor', descriptorFile, '--allowed-root', allowedRoot,
        '--locked-descriptor-sha256', sha(input.raw)], { stdio: 'inherit' });
      child.once('error', reject); child.once('close', resolve);
    });
    process.exitCode = exit ?? 1; return;
  }
  requireValue(options.get('--locked-descriptor-sha256') === sha(input.raw), 'DEAD_WRITER_DESCRIPTOR_INVALID', 'Descriptor changed across lifecycle lock acquisition.');
  const result = await recoverForgeDeadWriter({ descriptor, allowedRoot, validateSharedLocks: () => validateDeadWriterInheritedLocks(locks) });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'ERROR', message: error.message, toolResult: 'unknown', automaticallyReplayed: false }));
    process.exitCode = 1;
  });
}
