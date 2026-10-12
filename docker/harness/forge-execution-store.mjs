import { constants as fsConstants } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalExecutionJson,
  commitExecutionBudget,
  createExecutionState,
  executionSha256,
  observeExecutionFailure,
  reduceExecutionState,
  releaseExecutionBudget,
  reserveExecutionBudget,
  stopExecution,
  validateExecutionState,
  verifyExecutionReceiptChain,
} from './forge-execution-state.mjs';

export const FORGE_EXECUTION_STORE_SCHEMA_VERSION = 1;
export const FORGE_EXECUTION_STORE_TYPE = 'forge-execution-store/v1';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_FILE = /^(\d{12})\.json$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OPERATIONS = new Set([
  'transition',
  'failure',
  'budget.reserve',
  'budget.commit',
  'budget.release',
  'stop',
  'checkpoint',
]);

export class ForgeExecutionStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeExecutionStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeExecutionStoreError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('EXECUTION_STORE_FIELD_INVALID', `${label} is invalid.`);
  return value;
}

function requiredTimestamp(value, label) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)
      || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('EXECUTION_STORE_FIELD_INVALID', `${label} must be a canonical UTC timestamp.`);
  }
  return value;
}

function requiredInteger(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) fail('EXECUTION_STORE_FIELD_INVALID', `${label} is invalid.`);
  return value;
}

function cloneJson(value) {
  return JSON.parse(canonicalExecutionJson(value));
}

function digestRecord(record) {
  return executionSha256({ ...record, eventDigest: '' });
}

function eventPath(recordRoot, revision) {
  return path.join(recordRoot, 'events', `${String(revision).padStart(12, '0')}.json`);
}

function snapshotPath(recordRoot, revision) {
  return path.join(recordRoot, 'snapshots', `${String(revision).padStart(12, '0')}.json`);
}

async function writeExclusiveJson(filePath, value) {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags, 0o600);
  try {
    await handle.writeFile(`${canonicalExecutionJson(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readJson(filePath, code) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    fail(code, `Execution store data is unavailable or invalid: ${error.code ?? error.message}`);
  }
}

function applyStoredOperation(state, operation, payload) {
  switch (operation) {
    case 'transition': return reduceExecutionState(state, payload);
    case 'failure': return observeExecutionFailure(state, payload);
    case 'budget.reserve': return reserveExecutionBudget(state, payload);
    case 'budget.commit': return commitExecutionBudget(state, payload);
    case 'budget.release': return releaseExecutionBudget(state, payload);
    case 'stop': return stopExecution(state, payload);
    case 'checkpoint': return state;
    default: fail('EXECUTION_STORE_OPERATION_INVALID', `Unknown execution store operation ${String(operation)}.`);
  }
}

function validateManifest(value) {
  if (!plainObject(value) || value.schemaVersion !== FORGE_EXECUTION_STORE_SCHEMA_VERSION
      || value.storeType !== FORGE_EXECUTION_STORE_TYPE) {
    fail('EXECUTION_STORE_MANIFEST_INVALID', 'Execution store manifest envelope is invalid.');
  }
  requiredId(value.executionId, 'manifest.executionId');
  requiredId(value.projectSlug, 'manifest.projectSlug');
  requiredId(value.taskId, 'manifest.taskId');
  requiredInteger(value.generation, 1, 'manifest.generation');
  requiredTimestamp(value.createdAt, 'manifest.createdAt');
  if (!plainObject(value.initialStateInput)) fail('EXECUTION_STORE_MANIFEST_INVALID', 'Initial execution input is invalid.');
  const initialState = createExecutionState(value.initialStateInput);
  if (initialState.executionId !== value.executionId || initialState.projectSlug !== value.projectSlug
      || initialState.taskId !== value.taskId) {
    fail('EXECUTION_STORE_MANIFEST_INVALID', 'Initial execution identity differs from the manifest.');
  }
  if (executionSha256(value.initialStateInput) !== value.initialInputDigest) {
    fail('EXECUTION_STORE_MANIFEST_INVALID', 'Initial execution input digest differs from the manifest.');
  }
  return { manifest: value, initialState };
}

function validateEvent(value, expectedRevision, manifest, state) {
  if (!plainObject(value) || value.schemaVersion !== FORGE_EXECUTION_STORE_SCHEMA_VERSION
      || value.storeType !== 'forge-execution-event/v1') {
    fail('EXECUTION_STORE_EVENT_INVALID', 'Execution event envelope is invalid.');
  }
  requiredId(value.eventId, 'event.eventId');
  requiredInteger(value.revision, 1, 'event.revision');
  requiredInteger(value.generation, 1, 'event.generation');
  requiredTimestamp(value.recordedAt, 'event.recordedAt');
  if (value.revision !== expectedRevision || value.generation !== manifest.generation
      || value.executionId !== manifest.executionId || !OPERATIONS.has(value.operation)
      || !plainObject(value.payload)) {
    fail('EXECUTION_STORE_EVENT_INVALID', 'Execution event identity, operation, or revision is invalid.');
  }
  if (value.eventDigest !== digestRecord(value)) fail('EXECUTION_STORE_EVENT_TAMPERED', 'Execution event digest is invalid.');
  if (value.stateDigestBefore !== executionSha256(state)) {
    fail('EXECUTION_STORE_REPLAY_DIVERGED', 'Execution event previous-state digest differs during replay.');
  }
  const next = applyStoredOperation(state, value.operation, value.payload);
  validateExecutionState(next);
  if (!verifyExecutionReceiptChain(next) || value.stateDigestAfter !== executionSha256(next)) {
    fail('EXECUTION_STORE_REPLAY_DIVERGED', 'Execution event result differs during replay.');
  }
  if (value.operation === 'stop' && next.stopReceipt === null) {
    fail('EXECUTION_STORE_STOP_INVALID', 'A typed stop event did not produce a stop receipt.');
  }
  return next;
}

export class ForgeExecutionStore {
  constructor({ root }) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      fail('EXECUTION_STORE_ROOT_INVALID', 'Execution store root must be absolute.');
    }
    this.root = path.resolve(root);
  }

  recordRoot(executionId) {
    return path.join(this.root, requiredId(executionId, 'executionId'));
  }

  async create({ generation = 1, initialStateInput }) {
    if (!plainObject(initialStateInput)) fail('EXECUTION_STORE_CREATE_INVALID', 'initialStateInput is invalid.');
    requiredInteger(generation, 1, 'generation');
    const state = createExecutionState(initialStateInput);
    validateExecutionState(state);
    const recordRoot = this.recordRoot(state.executionId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await mkdir(recordRoot, { mode: 0o700 });
      await mkdir(path.join(recordRoot, 'events'), { mode: 0o700 });
      await mkdir(path.join(recordRoot, 'snapshots'), { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await this.read(state.executionId);
      if (existing.generation === generation
          && executionSha256(existing.manifest.initialStateInput) === executionSha256(initialStateInput)) {
        return { ...existing, idempotent: true };
      }
      fail('EXECUTION_STORE_CREATE_CONFLICT', 'Execution store identity already exists with different input.');
    }
    const manifest = {
      schemaVersion: FORGE_EXECUTION_STORE_SCHEMA_VERSION,
      storeType: FORGE_EXECUTION_STORE_TYPE,
      executionId: state.executionId,
      projectSlug: state.projectSlug,
      taskId: state.taskId,
      generation,
      createdAt: initialStateInput.createdAt,
      initialStateInput: cloneJson(initialStateInput),
      initialInputDigest: executionSha256(initialStateInput),
    };
    const snapshot = {
      schemaVersion: FORGE_EXECUTION_STORE_SCHEMA_VERSION,
      snapshotType: 'forge-execution-snapshot/v1',
      executionId: state.executionId,
      generation,
      revision: 0,
      state,
      stateDigest: executionSha256(state),
    };
    await writeExclusiveJson(path.join(recordRoot, 'manifest.json'), manifest);
    await writeExclusiveJson(snapshotPath(recordRoot, 0), snapshot);
    return { manifest, generation, revision: 0, state, events: [], idempotent: false };
  }

  async read(executionId) {
    const recordRoot = this.recordRoot(executionId);
    const { manifest, initialState } = validateManifest(
      await readJson(path.join(recordRoot, 'manifest.json'), 'EXECUTION_STORE_MANIFEST_INVALID'),
    );
    let names;
    try {
      names = (await readdir(path.join(recordRoot, 'events'))).filter((name) => EVENT_FILE.test(name)).sort();
    } catch (error) {
      fail('EXECUTION_STORE_EVENT_INVALID', `Execution event directory is unavailable: ${error.code ?? error.message}`);
    }
    let state = initialState;
    const events = [];
    const ids = new Set();
    for (let index = 0; index < names.length; index += 1) {
      const revision = index + 1;
      if (names[index] !== `${String(revision).padStart(12, '0')}.json`) {
        fail('EXECUTION_STORE_REVISION_GAP', 'Execution event revisions are not contiguous.');
      }
      const event = await readJson(path.join(recordRoot, 'events', names[index]), 'EXECUTION_STORE_EVENT_INVALID');
      if (ids.has(event.eventId)) fail('EXECUTION_STORE_EVENT_CONFLICT', 'Execution event id is duplicated.');
      ids.add(event.eventId);
      state = validateEvent(event, revision, manifest, state);
      events.push(event);
    }
    const revision = events.length;
    const existingSnapshot = await readJson(snapshotPath(recordRoot, revision), 'EXECUTION_STORE_SNAPSHOT_INVALID');
    if (!plainObject(existingSnapshot) || existingSnapshot.snapshotType !== 'forge-execution-snapshot/v1'
        || existingSnapshot.executionId !== executionId || existingSnapshot.generation !== manifest.generation
        || existingSnapshot.revision !== revision || existingSnapshot.stateDigest !== executionSha256(state)
        || canonicalExecutionJson(existingSnapshot.state) !== canonicalExecutionJson(state)) {
      fail('EXECUTION_STORE_SNAPSHOT_INVALID', 'Execution snapshot differs from deterministic replay.');
    }
    return { manifest, generation: manifest.generation, revision, state, events, idempotent: false };
  }

  async append({ executionId, expectedGeneration, expectedRevision, eventId, operation, payload, recordedAt }) {
    requiredId(eventId, 'eventId');
    requiredInteger(expectedGeneration, 1, 'expectedGeneration');
    requiredInteger(expectedRevision, 0, 'expectedRevision');
    requiredTimestamp(recordedAt, 'recordedAt');
    if (!OPERATIONS.has(operation) || !plainObject(payload)) {
      fail('EXECUTION_STORE_OPERATION_INVALID', 'Execution store operation or payload is invalid.');
    }
    const recordRoot = this.recordRoot(executionId);
    const lockPath = path.join(recordRoot, '.append.lock');
    let lock;
    try {
      lock = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') fail('EXECUTION_STORE_BUSY', 'Execution store has another append in progress.');
      throw error;
    }
    try {
      const current = await this.read(executionId);
      const proposedDigest = executionSha256({ operation, payload, generation: expectedGeneration });
      const existing = current.events.find((event) => event.eventId === eventId);
      if (existing) {
        const existingDigest = executionSha256({
          operation: existing.operation,
          payload: existing.payload,
          generation: existing.generation,
        });
        if (existingDigest !== proposedDigest) fail('EXECUTION_STORE_EVENT_CONFLICT', 'Event id was reused with different content.');
        return { ...current, event: existing, idempotent: true };
      }
      if (current.generation !== expectedGeneration) {
        fail('EXECUTION_STORE_GENERATION_CONFLICT', 'Execution generation compare-and-swap failed.');
      }
      if (current.revision !== expectedRevision) {
        fail('EXECUTION_STORE_REVISION_CONFLICT', 'Execution revision compare-and-swap failed.');
      }
      const nextState = applyStoredOperation(current.state, operation, payload);
      validateExecutionState(nextState);
      if (!verifyExecutionReceiptChain(nextState)) {
        fail('EXECUTION_STORE_RECEIPT_CHAIN_INVALID', 'Execution receipt chain is invalid after the event.');
      }
      if (operation === 'stop' && nextState.stopReceipt === null) {
        fail('EXECUTION_STORE_STOP_INVALID', 'Stop operation did not produce a typed stop receipt.');
      }
      const revision = current.revision + 1;
      const event = {
        schemaVersion: FORGE_EXECUTION_STORE_SCHEMA_VERSION,
        storeType: 'forge-execution-event/v1',
        executionId,
        generation: current.generation,
        revision,
        eventId,
        operation,
        payload: cloneJson(payload),
        recordedAt,
        stateDigestBefore: executionSha256(current.state),
        stateDigestAfter: executionSha256(nextState),
        eventDigest: '',
      };
      event.eventDigest = digestRecord(event);
      const snapshot = {
        schemaVersion: FORGE_EXECUTION_STORE_SCHEMA_VERSION,
        snapshotType: 'forge-execution-snapshot/v1',
        executionId,
        generation: current.generation,
        revision,
        state: nextState,
        stateDigest: executionSha256(nextState),
      };
      await writeExclusiveJson(snapshotPath(recordRoot, revision), snapshot);
      // The event file is the append commit marker. Writing the immutable
      // snapshot first means a crash can leave only an unreferenced future
      // snapshot, never a committed event without its replay checkpoint.
      await writeExclusiveJson(eventPath(recordRoot, revision), event);
      return {
        manifest: current.manifest,
        generation: current.generation,
        revision,
        state: nextState,
        events: [...current.events, event],
        event,
        idempotent: false,
      };
    } finally {
      await lock?.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  appendTransition(input) {
    return this.append({ ...input, operation: 'transition' });
  }

  appendStop(input) {
    return this.append({ ...input, operation: 'stop' });
  }

  appendBudgetReserve(input) {
    return this.append({ ...input, operation: 'budget.reserve' });
  }

  appendBudgetCommit(input) {
    return this.append({ ...input, operation: 'budget.commit' });
  }

  appendBudgetRelease(input) {
    return this.append({ ...input, operation: 'budget.release' });
  }

  appendCheckpoint(input) {
    return this.append({ ...input, operation: 'checkpoint' });
  }
}
