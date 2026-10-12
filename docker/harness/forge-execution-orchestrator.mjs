import { executionSha256, failurePolicy } from './forge-execution-state.mjs';

export const FORGE_EXECUTION_ORCHESTRATOR_SCHEMA_VERSION = 1;
export const FORGE_EXECUTION_ORCHESTRATOR_TYPE = 'forge-execution-orchestrator/v1';

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,127}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export class ForgeExecutionOrchestratorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeExecutionOrchestratorError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ForgeExecutionOrchestratorError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('EXECUTION_ORCHESTRATOR_RESULT_INVALID', `${label} is invalid.`);
  return value;
}

function canonicalCode(value, fallback) {
  if (typeof value === 'string' && SAFE_CODE.test(value)) return value;
  return fallback;
}

function adapter(name, value) {
  if (typeof value !== 'function') fail('EXECUTION_ORCHESTRATOR_CONFIG_INVALID', `${name} adapter is required.`);
  return value;
}

function checkpointResult(snapshot, stage) {
  const event = snapshot.events.find((candidate) => candidate.operation === 'checkpoint'
    && candidate.payload?.stage === stage);
  return event?.payload?.result;
}

function readyNegotiation(value) {
  return plainObject(value)
    && value.schemaVersion === 1
    && value.negotiationType === 'forge-execution/capability-negotiation'
    && value.outcome === 'READY'
    && SHA256.test(value.negotiationDigest ?? '')
    && Array.isArray(value.blockingGaps)
    && value.blockingGaps.length === 0;
}

function readyAdmission(value) {
  return plainObject(value) && value.outcome === 'ready' && plainObject(value.receipt);
}

function readyRoute(value) {
  return plainObject(value) && value.outcome === 'ready'
    && typeof value.routeId === 'string' && SAFE_ID.test(value.routeId)
    && Array.isArray(value.observedSkills);
}

function stopFailure(result, defaults) {
  const failureClass = typeof result?.failureClass === 'string'
    ? result.failureClass : defaults.failureClass;
  let policy;
  try {
    policy = failurePolicy(failureClass);
  } catch {
    fail('EXECUTION_ORCHESTRATOR_RESULT_INVALID', 'Adapter returned an unsupported failure class.');
  }
  const code = canonicalCode(result?.reasonCode, defaults.reasonCode);
  return {
    outcome: policy.terminalOutcome,
    failure: {
      failureClass,
      code,
      resolutionAuthority: typeof result?.resolutionAuthority === 'string'
        && SAFE_ID.test(result.resolutionAuthority)
        ? result.resolutionAuthority : defaults.resolutionAuthority,
      attemptKey: `${failureClass}:${executionSha256({ failureClass, code }).slice(0, 32)}`,
    },
  };
}

export function createForgeExecutionOrchestrator({
  store,
  prepare,
  negotiate,
  admit,
  route,
  clock = () => new Date().toISOString(),
} = {}) {
  if (!store || typeof store.create !== 'function' || typeof store.appendCheckpoint !== 'function'
      || typeof store.appendTransition !== 'function' || typeof store.appendStop !== 'function') {
    fail('EXECUTION_ORCHESTRATOR_CONFIG_INVALID', 'A compatible execution store is required.');
  }
  const prepareAdapter = adapter('prepare', prepare);
  const negotiateAdapter = adapter('negotiate', negotiate);
  const admitAdapter = adapter('admit', admit);
  const routeAdapter = adapter('route', route);

  return Object.freeze({
    async run(request) {
      if (!plainObject(request)) fail('EXECUTION_ORCHESTRATOR_REQUEST_INVALID', 'Orchestrator request must be an object.');
      const callOrder = [];
      callOrder.push('prepare');
      const prepared = await prepareAdapter(request);
      if (!plainObject(prepared) || !plainObject(prepared.initialStateInput)) {
        fail('EXECUTION_ORCHESTRATOR_RESULT_INVALID', 'Prepare adapter returned an invalid execution input.');
      }
      const generation = Number.isSafeInteger(prepared.generation) && prepared.generation >= 1
        ? prepared.generation : 1;
      if (prepared.initialStateInput.actionCeiling !== 'read-only') {
        fail('EXECUTION_WRITER_DISABLED', 'The minimal orchestrator keeps production writer execution disabled.');
      }
      let snapshot = await store.create({ generation, initialStateInput: prepared.initialStateInput });

      const appendCheckpoint = async (stage, result) => {
        snapshot = await store.appendCheckpoint({
          executionId: snapshot.state.executionId,
          expectedGeneration: generation,
          expectedRevision: snapshot.revision,
          eventId: `${snapshot.state.executionId}:${stage}`,
          payload: { stage, result },
          recordedAt: clock(),
        });
      };
      const appendTransition = async (stage, payload) => {
        snapshot = await store.appendTransition({
          executionId: snapshot.state.executionId,
          expectedGeneration: generation,
          expectedRevision: snapshot.revision,
          eventId: `${snapshot.state.executionId}:${stage}`,
          payload,
          recordedAt: clock(),
        });
      };
      const appendStop = async (stage, result, defaults) => {
        const stopped = stopFailure(result, defaults);
        snapshot = await store.appendStop({
          executionId: snapshot.state.executionId,
          expectedGeneration: generation,
          expectedRevision: snapshot.revision,
          eventId: `${snapshot.state.executionId}:${stage}:stop`,
          payload: {
            outcome: stopped.outcome,
            observedAt: clock(),
            failure: stopped.failure,
            openCriteria: snapshot.state.openCriteria,
          },
          recordedAt: clock(),
        });
      };

      if (checkpointResult(snapshot, 'prepared') === undefined) {
        await appendCheckpoint('prepared', {
          outcome: 'ready',
          inputDigest: executionSha256(prepared.initialStateInput),
        });
      }

      let negotiation = checkpointResult(snapshot, 'negotiated');
      if (negotiation === undefined) {
        callOrder.push('negotiate');
        try {
          negotiation = await negotiateAdapter({ request, prepared, state: snapshot.state });
        } catch {
          negotiation = {
            outcome: 'blocked',
            failureClass: 'CAPABILITY_TRANSIENT',
            reasonCode: 'CAPABILITY_NEGOTIATION_UNAVAILABLE',
            resolutionAuthority: 'platform-operator',
          };
        }
        if (!plainObject(negotiation)) fail('EXECUTION_ORCHESTRATOR_RESULT_INVALID', 'Negotiate adapter returned an invalid result.');
        await appendCheckpoint('negotiated', negotiation);
      }
      if (!readyNegotiation(negotiation)) {
        if (snapshot.state.terminalOutcome === null) {
          await appendStop('negotiation', negotiation, {
            failureClass: 'CAPABILITY_HARD',
            reasonCode: 'CAPABILITY_NEGOTIATION_BLOCKED',
            resolutionAuthority: 'platform-operator',
          });
        }
        return Object.freeze({
          schemaVersion: FORGE_EXECUTION_ORCHESTRATOR_SCHEMA_VERSION,
          orchestratorType: FORGE_EXECUTION_ORCHESTRATOR_TYPE,
          outcome: snapshot.state.terminalOutcome,
          callOrder,
          snapshot,
        });
      }

      let admission = checkpointResult(snapshot, 'admitted');
      if (admission === undefined) {
        callOrder.push('admit');
        try {
          admission = await admitAdapter({ request, prepared, negotiation, state: snapshot.state });
        } catch {
          admission = {
            outcome: 'blocked',
            failureClass: 'CAPABILITY_TRANSIENT',
            reasonCode: 'EXECUTION_ADMISSION_UNAVAILABLE',
            resolutionAuthority: 'verification-operator',
          };
        }
        if (!plainObject(admission)) fail('EXECUTION_ORCHESTRATOR_RESULT_INVALID', 'Admit adapter returned an invalid result.');
        await appendCheckpoint('admitted', admission);
      }
      if (!readyAdmission(admission)) {
        if (snapshot.state.terminalOutcome === null) {
          await appendStop('admission', admission, {
            failureClass: 'CAPABILITY_HARD',
            reasonCode: 'EXECUTION_ADMISSION_BLOCKED',
            resolutionAuthority: 'verification-operator',
          });
        }
        return Object.freeze({
          schemaVersion: FORGE_EXECUTION_ORCHESTRATOR_SCHEMA_VERSION,
          orchestratorType: FORGE_EXECUTION_ORCHESTRATOR_TYPE,
          outcome: snapshot.state.terminalOutcome,
          callOrder,
          snapshot,
        });
      }

      let routeResult = checkpointResult(snapshot, 'routed');
      if (routeResult === undefined) {
        callOrder.push('route');
        try {
          routeResult = await routeAdapter({ request, prepared, negotiation, admission, state: snapshot.state });
        } catch {
          routeResult = {
            outcome: 'blocked',
            failureClass: 'CAPABILITY_TRANSIENT',
            reasonCode: 'MODEL_ROUTE_UNAVAILABLE',
            resolutionAuthority: 'policy-owner',
          };
        }
        if (!plainObject(routeResult)) fail('EXECUTION_ORCHESTRATOR_RESULT_INVALID', 'Route adapter returned an invalid result.');
        await appendCheckpoint('routed', routeResult);
      }
      if (!readyRoute(routeResult)) {
        if (snapshot.state.terminalOutcome === null) {
          await appendStop('route', routeResult, {
            failureClass: 'AUTHORITY',
            reasonCode: 'MODEL_ROUTE_BLOCKED',
            resolutionAuthority: 'policy-owner',
          });
        }
        return Object.freeze({
          schemaVersion: FORGE_EXECUTION_ORCHESTRATOR_SCHEMA_VERSION,
          orchestratorType: FORGE_EXECUTION_ORCHESTRATOR_TYPE,
          outcome: snapshot.state.terminalOutcome,
          callOrder,
          snapshot,
        });
      }

      if (snapshot.state.phase === 'ADMIT') {
        await appendTransition('reducer-route', {
          type: 'route.completed',
          observedAt: clock(),
          observedSkills: routeResult.observedSkills,
        });
      }
      if (snapshot.state.phase === 'ROUTE') {
        await appendTransition('reducer-preflight-started', {
          type: 'preflight.started',
          observedAt: clock(),
        });
      }
      if (snapshot.state.phase === 'PREFLIGHT') {
        await appendTransition('reducer-preflight-completed', {
          type: 'preflight.completed',
          observedAt: clock(),
          receipt: admission.receipt,
        });
      }
      return Object.freeze({
        schemaVersion: FORGE_EXECUTION_ORCHESTRATOR_SCHEMA_VERSION,
        orchestratorType: FORGE_EXECUTION_ORCHESTRATOR_TYPE,
        outcome: 'ready',
        callOrder,
        negotiationDigest: executionSha256(negotiation),
        admissionDigest: executionSha256(admission.receipt),
        routeDigest: executionSha256(routeResult),
        snapshot,
      });
    },
  });
}
