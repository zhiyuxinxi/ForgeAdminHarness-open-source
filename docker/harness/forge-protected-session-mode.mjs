import crypto from 'node:crypto';

export const FORGE_PROTECTED_SESSION_MODES = Object.freeze(['create', 'resume']);
export const FORGE_PROTECTED_RECOVERY_MODE = 'expired-unsubmitted-exact-context-v1';

export function resolveForgeProtectedSessionMode(value = process.env.FORGE_PROTECTED_HEADLESS_SESSION_MODE) {
  const resolved = value ?? 'create';
  if (!FORGE_PROTECTED_SESSION_MODES.includes(resolved)) {
    throw new Error('FORGE_PROTECTED_HEADLESS_SESSION_MODE must be create or resume.');
  }
  return resolved;
}

export function resolveForgeProtectedRecoveryMode(
  value = process.env.FORGE_PROTECTED_HEADLESS_RECOVERY_MODE,
) {
  if (value === undefined) return null;
  if (value !== FORGE_PROTECTED_RECOVERY_MODE) {
    throw new Error(
      `FORGE_PROTECTED_HEADLESS_RECOVERY_MODE must be ${FORGE_PROTECTED_RECOVERY_MODE}.`,
    );
  }
  return value;
}

function eventMessage(event) {
  if (!event?.data || typeof event.data !== 'object') return undefined;
  return event.data.message && typeof event.data.message === 'object'
    ? event.data.message : event.data;
}

export function inspectForgeProtectedRecoveryReadback({
  events,
  sessionId,
  rpcId,
  textDigest,
  observedSeq,
  sessionObserved,
  historyComplete,
  observedAt = new Date().toISOString(),
}) {
  if (!Array.isArray(events) || typeof sessionId !== 'string' || sessionId.length < 1
    || typeof rpcId !== 'string' || rpcId.length < 1
    || !/^[0-9a-f]{64}$/u.test(textDigest ?? '')
    || !Number.isSafeInteger(observedSeq) || observedSeq < 0
    || sessionObserved !== true || historyComplete !== true
    || typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt))) {
    throw new Error('Protected recovery session readback input is invalid.');
  }
  const digest = crypto.createHash('sha256');
  let lastEventSeq = -1;
  let lastTurnStart = -1;
  let lastTurnEnd = -1;
  let requestObserved = false;
  for (const event of events) {
    if (!event || typeof event !== 'object' || !Number.isSafeInteger(event.seq)
      || event.seq < 0 || typeof event.type !== 'string' || event.seq <= lastEventSeq) {
      throw new Error('Protected recovery session history is malformed or unordered.');
    }
    lastEventSeq = event.seq;
    const sourceRpcId = event.type === 'user/message' ? eventMessage(event)?.source?.rpcId : undefined;
    digest.update(JSON.stringify([event.seq, event.type, sourceRpcId ?? null]));
    digest.update('\n');
    if (event.type === 'turn/start') lastTurnStart = event.seq;
    if (event.type === 'turn/end') lastTurnEnd = event.seq;
    if (sourceRpcId === rpcId) requestObserved = true;
  }
  const expectedObservedSeq = events.length === 0 ? 0 : lastEventSeq;
  if (observedSeq !== expectedObservedSeq) {
    throw new Error('Protected recovery session sequence does not close its complete event history snapshot.');
  }
  const turnOpen = lastTurnStart > lastTurnEnd;
  if (requestObserved) throw new Error('Protected recovery request RPC is already present in session history.');
  if (turnOpen) throw new Error('Protected recovery session still has an open turn.');
  return Object.freeze({
    schemaVersion: 'forge-protected-session-readback/v1',
    sessionId,
    rpcId,
    textDigest,
    observedSeq,
    eventDigest: digest.digest('hex'),
    sessionObserved: true,
    historyComplete: true,
    requestObserved: false,
    turnOpen: false,
    observedAt,
  });
}

export async function openForgeProtectedAgent({
  agents,
  sessionMode,
  sessionId,
  agentOptions,
  setup,
}) {
  if (!agents || typeof agents.create !== 'function' || typeof agents.resume !== 'function'
    || !FORGE_PROTECTED_SESSION_MODES.includes(sessionMode)
    || sessionId === undefined || sessionId === null
    || !agentOptions || typeof setup !== 'function') {
    throw new Error('Protected agent session request is invalid.');
  }
  if (sessionMode === 'create') {
    return agents.create({ sessionId, meta: { cwd: process.cwd() }, agentOptions, setup });
  }
  return agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
}
