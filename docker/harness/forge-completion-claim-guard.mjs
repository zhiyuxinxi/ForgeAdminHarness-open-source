import {
  controlledEvidenceReceipt,
  parseControlledEvidenceCommand,
  parseControlledReleaseMutationCommand,
} from './forge-controlled-command.mjs';
import { canonicalSha256 } from './forge-acceptance-aggregator.mjs';
import { readFile } from 'node:fs/promises';

const GUARD_MARKER = 'FORGE_COMPLETION_CLAIM_GUARD_V1';
const PROTECTED_COMPLETION_OBSERVATION_MARKER = 'FORGE_PROTECTED_COMPLETION_OBSERVATION_V1';
function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function assistantText(message) {
  return message?.role === 'assistant' ? messageText(message) : '';
}

function latestAssistantText(agent, turn) {
  const events = agent?.session?.events;
  if (!Array.isArray(events)) return '';
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'assistant/message' && event.data?.turn === turn) {
      return assistantText(event.data.message);
    }
  }
  return '';
}

function toolArguments(event) {
  const value = event?.data?.arguments;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(value ?? '{}'); } catch { return {}; }
}

function toolResultText(event) {
  return (event?.data?.message?.content ?? [])
    .flatMap((block) => block?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function toolResultFailed(event) {
  const blocks = event?.data?.message?.content ?? [];
  if (blocks.some((block) => block?.isError === true)) return true;
  const text = toolResultText(event);
  return /\[(?:exit code:\s*[1-9]\d*|timed out\b|killed by signal:)/iu.test(text)
    || /(?:^|\n)[A-Z][A-Z0-9_-]*EXIT:\s*[1-9]\d*\b/u.test(text)
    || /"ok"\s*:\s*false\b/u.test(text);
}

function protectedCompletionProjectionReady(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const expectedKeys = [
    'attestation', 'blockers', 'candidateDiffSha256', 'cannotClaim', 'evaluatedAt',
    'evaluationMode', 'gateDigest', 'gateType', 'ledgerDigest', 'ledgerSummary',
    'ledgerSummaryDigest', 'maximumTerminalOutcome', 'outcome', 'schemaVersion',
    'signedVerdictVerified', 'sourceFingerprint',
    ...(Object.hasOwn(value, 'nonBlockingLegacyObligations') ? ['nonBlockingLegacyObligations'] : []),
    ...(Object.hasOwn(value, 'backendTestSelectors') ? ['backendTestSelectors'] : []),
  ].sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) return false;
  if (Object.hasOwn(value, 'backendTestSelectors')) {
    const selectors = value.backendTestSelectors;
    if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)
      || JSON.stringify(Object.keys(selectors).sort()) !== '["modules","tests"]') return false;
    for (const [key, pattern] of [
      ['modules', /^forge-server(?:\/[A-Za-z0-9_.-]+)*$/u],
      ['tests', /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u],
    ]) {
      const entries = selectors[key];
      if (!Array.isArray(entries) || entries.length === 0 || new Set(entries).size !== entries.length
        || entries.some(entry => typeof entry !== 'string' || !pattern.test(entry)
          || (key === 'modules' && entry.split('/').some(part => part === '.' || part === '..')))) return false;
    }
  }
  const legacy = value.nonBlockingLegacyObligations ?? [];
  if (!Array.isArray(legacy) || new Set(legacy).size !== legacy.length
    || legacy.some(id => !['crud:permission', 'crud:validation', 'crud:observability',
      'shared-owner:inventory', 'shared-owner:consumer-tests'].includes(id))) return false;
  const open = value.ledgerSummary?.open;
  if (value.ledgerSummary?.counts?.open !== legacy.length
    || (legacy.length > 0 && (!Array.isArray(open) || open.length !== legacy.length
      || open.some(id => !legacy.includes(id))))) return false;
  const { gateDigest, ...payload } = value;
  if (gateDigest !== canonicalSha256(payload)
      || value.schemaVersion !== 1
      || value.gateType !== 'forge-protected-completion-gate/v1'
      || value.evaluationMode !== 'read-only-verifier'
      || value.attestation !== 'local-integrity-only; upstream-authentication-is-ed25519'
      || value.outcome !== 'READY'
      || value.maximumTerminalOutcome !== 'COMPLETE'
      || value.signedVerdictVerified !== true
      || !Array.isArray(value.blockers) || value.blockers.length !== 0
      || !Array.isArray(value.cannotClaim) || value.cannotClaim.length !== 0) return false;
  const ledgerSource = value.ledgerSummary?.sourceFingerprint;
  const normalizedLedgerSource = typeof ledgerSource === 'string'
    ? (ledgerSource.startsWith('sha256:') ? ledgerSource : `sha256:${ledgerSource}`) : null;
  return normalizedLedgerSource === value.sourceFingerprint;
}

function protectedCompletionProjectionNotRequired(value) {
  if (process.env.FORGE_DEVELOPMENT_MODE !== 'direct' || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { statusDigest, ...status } = value;
  return value.schemaVersion === 1 && value.projectionType === 'forge-direct-development-status/v1'
    && value.developmentMode === 'direct' && value.status === 'not_required'
    && value.verification === 'not_claimed' && value.release === 'not_claimed'
    && typeof value.taskContractId === 'string' && /^[a-f0-9]{64}$/u.test(value.taskContractId)
    && typeof value.source?.head === 'string' && /^[a-f0-9]{40}$/u.test(value.source.head)
    && typeof value.source?.fingerprint === 'string' && /^[a-f0-9]{64}$/u.test(value.source.fingerprint)
    && statusDigest === canonicalSha256(status);
}

function protectedCompletionObservation(value) {
  if (!protectedCompletionProjectionReady(value)) return null;
  const counts = value.ledgerSummary?.counts;
  const taskContractId = value.ledgerSummary?.taskContractId;
  if (typeof taskContractId !== 'string' || taskContractId.length === 0
      || typeof value.sourceFingerprint !== 'string'
      || typeof value.candidateDiffSha256 !== 'string'
      || typeof value.evaluatedAt !== 'string'
      || typeof value.gateDigest !== 'string'
      || !Number.isSafeInteger(counts?.closed) || counts.closed < 0
      || !Number.isSafeInteger(counts?.open)) return null;
  const facts = JSON.stringify({
    taskContractId,
    sourceFingerprint: value.sourceFingerprint,
    candidateDiffSha256: value.candidateDiffSha256,
    evaluatedAt: value.evaluatedAt,
    gateDigest: value.gateDigest,
    signedVerdictVerified: value.signedVerdictVerified,
    closed: counts.closed,
    open: counts.open,
    ...(value.nonBlockingLegacyObligations ? { nonBlockingLegacyObligations: value.nonBlockingLegacyObligations } : {}),
  });
  return `${PROTECTED_COMPLETION_OBSERVATION_MARKER}: Trusted read-only resolver observation: the current code contract execution acceptance is READY. ${facts} This does not prove UAT, business semantic correctness, independent RED/TDD/browser proof, a Git checkpoint, release, or deployment. Do not reinterpret non-required UAT as a blocker for this code contract execution acceptance.`;
}

function protectedBlockedCompletionFact(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const expected = ['attestation', 'blockers', 'candidateDiffSha256', 'cannotClaim', 'evaluatedAt',
      'evaluationMode', 'gateDigest', 'gateType', 'ledgerDigest', 'ledgerSummary', 'ledgerSummaryDigest',
      'maximumTerminalOutcome', 'outcome', 'schemaVersion', 'signedVerdictVerified', 'sourceFingerprint',
      ...(Object.hasOwn(value, 'nonBlockingLegacyObligations') ? ['nonBlockingLegacyObligations'] : []),
      ...(Object.hasOwn(value, 'backendTestSelectors') ? ['backendTestSelectors'] : [])];
    const { gateDigest, ...payload } = value;
    const summary = value.ledgerSummary;
    const { summaryDigest, ...summaryPayload } = summary ?? {};
    const sha = /^sha256:[0-9a-f]{64}$/u;
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected.sort())
      || gateDigest !== canonicalSha256(payload) || value.schemaVersion !== 1
      || value.gateType !== 'forge-protected-completion-gate/v1' || value.evaluationMode !== 'read-only-verifier'
      || value.attestation !== 'local-integrity-only; upstream-authentication-is-ed25519'
      || value.outcome !== 'BOUNDED_BLOCKED' || value.maximumTerminalOutcome !== 'BOUNDED_BLOCKED'
      || typeof value.signedVerdictVerified !== 'boolean' || !Number.isFinite(Date.parse(value.evaluatedAt))
      || ![value.sourceFingerprint, value.candidateDiffSha256, value.ledgerDigest].every(item => sha.test(item))
      || summary?.schemaVersion !== 1 || summary.summaryType !== 'forge-obligation-ledger-summary/v1'
      || typeof summary.taskContractId !== 'string' || summary.taskContractId.length === 0
      || summaryDigest !== canonicalSha256(summaryPayload) || value.ledgerSummaryDigest !== summaryDigest
      || value.ledgerDigest !== summary.ledgerDigest
      || (summary.sourceFingerprint?.startsWith('sha256:') ? summary.sourceFingerprint : `sha256:${summary.sourceFingerprint}`) !== value.sourceFingerprint
      || !['total', 'closed', 'open', 'stale'].every(key => Number.isSafeInteger(summary.counts?.[key]) && summary.counts[key] >= 0)
      || summary.counts.total !== summary.counts.closed + summary.counts.open
      || !['closed', 'open', 'stale'].every(key => Array.isArray(summary[key]) && summary[key].length === summary.counts[key])
      || !Array.isArray(value.blockers) || value.blockers.length === 0
      || !value.blockers.every(item => /^[A-Z][A-Z0-9_]{0,95}$/u.test(item?.code ?? '') && typeof item.detail === 'string')
      || !Array.isArray(value.cannotClaim) || value.cannotClaim.length === 0
      || !value.cannotClaim.every(item => ['implemented', 'verified', 'accepted', 'complete', 'released'].includes(item))) return null;
    return { outcome: value.outcome, taskContractId: summary.taskContractId, sourceFingerprint: value.sourceFingerprint,
      evaluatedAt: value.evaluatedAt, gateDigest, signedVerdictVerified: value.signedVerdictVerified,
      counts: summary.counts, blockerCodes: [...new Set(value.blockers.map(item => item.code))] };
  } catch { return null; }
}

function blockedCompletionObservation(fact) {
  return `${PROTECTED_COMPLETION_OBSERVATION_MARKER}: Trusted read-only resolver observation: current code contract execution acceptance is BOUNDED_BLOCKED. ${JSON.stringify(fact)} Correct the claim of current READY or completed acceptance. Closed obligation counts alone do not establish current acceptance; signedVerdictVerified, even when true, does not override these blockers, and false never proves acceptance. Preserve historical passed test results without presenting them as current accepted evidence. Contract expiry is not a failed test. This status correction does not authorize renewal, receipt revalidation, rerunning checks, source changes, independent review, or release; respect the current read-only request and report the actual bounded status.`;
}

function unfinishedTurnTodos(events, turn) {
  const calls = new Map();
  const activeJobs = new Set();
  let todos = null;
  for (const event of events) {
    if (event?.data?.turn !== turn) continue;
    if (event.type === 'tool/call') calls.set(event.data.callId, event);
    if (event.type !== 'tool/result') continue;
    const call = calls.get(event.data?.message?.source?.callId);
    if (!call) continue;
    const args = toolArguments(call);
    const text = toolResultText(event);
    // A failed native job is still terminal; its failure must not keep the
    // saved plan looking as though an automatic continuation remains pending.
    if (call.data.name === 'job_output' && typeof args.job_id === 'string'
      && /\[status:\s*(?:completed|failed|cancelled|canceled|killed)\b/iu.test(text)) {
      activeJobs.delete(args.job_id);
      continue;
    }
    if (toolResultFailed(event)) continue;
    if (call.data.name === 'todo_write' && Array.isArray(args.todos)) todos = args.todos;
    if (call.data.name === 'bash' && (args.run_in_background === true
      || parseControlledReleaseMutationCommand(args.command)?.action === 'release')) {
      // Exact releases are dispatched as native jobs even when the recorded
      // model arguments omitted the flag. Only the actual successful job
      // acknowledgement establishes an observer; the command alone cannot.
      const id = (args.run_in_background === true
        ? /\bstarted background job ([A-Za-z0-9_-]+)\b/u.exec(text)
        : /^started background job (bash-[1-9]\d*)$/u.exec(text.trim()))?.[1];
      if (id) activeJobs.add(id);
    }
    if (call.data.name === 'job_output' && typeof args.job_id === 'string') {
      activeJobs.add(args.job_id);
    }
  }
  const activeCount = todos?.filter((item) => item?.status === 'in_progress').length ?? 0;
  return activeCount > 0 && activeJobs.size === 0 ? activeCount : 0;
}

function unfinishedTodoObservation(count, directDevelopment = false) {
  if (directDevelopment) return `${GUARD_MARKER}: The latest successful todo_write still has ${count} in_progress item(s), but no uncollected native background job was observed. Reconcile the plan with actual results before ending. Continue only currently authorized actionable work; respect pause, read-only requests, missing authority and real blockers. Development contract acceptance, fixed checks and independent review are not required in direct mode. Do not invent test, release or completion success; do not turn an optional unexecuted check into a new prerequisite.`;
  return `${GUARD_MARKER}: The latest successful todo_write in this turn still has ${count} in_progress item(s), but this turn is about to end and no uncollected native background job was observed. Reconcile that state before your final reply. Continue only the remaining work already authorized by the current user request when it is actionable; do not leave an internal evidence-closeout step unfinished while telling the user to keep waiting. Rebind applicable passed receipts with forge-verify run --reuse-receipt using current admission and original selectors; receipt only reads proof, and review is a separate independent semantic review. If a real source change invalidates one check, run only that required affected check and preserve the other results. Respect an explicit pause, stop, analysis-only request, missing authority, or real external blocker: do not resume such work; explain the exact blocker or paused state and update the todo honestly. Do not mark an unresolved item completed by renaming it to recording a gap. Only an actually registered unfinished native background job justifies a claim that work will continue automatically. This is one status reconciliation, not new authorization, a test rerun requirement, or an automatic retry.`;
}

function installCompletionClaimGuard(ctx, createUserMessage, resolveProtectedCompletion = null) {
  if (resolveProtectedCompletion !== null && typeof resolveProtectedCompletion !== 'function') {
    throw new TypeError('resolveProtectedCompletion must be a protected synchronous resolver or null');
  }
  const observedTurns = new WeakMap();
  const reconciledTodoTurns = new WeakMap();
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const events = Array.isArray(agent?.session?.events) ? agent.session.events : [];
    const assistantEvent = events.findLast(
      (event) => event?.type === 'assistant/message' && event.data?.turn === turn,
    );
    const evaluate = (projection) => {
      const observation = protectedCompletionObservation(projection);
      const blockedFact = protectedBlockedCompletionFact(projection);
      const unfinishedTodos = assistantEvent ? unfinishedTurnTodos(events, turn) : 0;
      if (unfinishedTodos && reconciledTodoTurns.get(agent) !== turn) {
        reconciledTodoTurns.set(agent, turn);
        if (observation) observedTurns.set(agent, turn);
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: [observation, unfinishedTodoObservation(unfinishedTodos,
            protectedCompletionProjectionNotRequired(projection))].filter(Boolean).join('\n\n') }],
          source: { kind: 'plugin', plugin: 'forge-completion-claim-guard', form: 'todo-status-reconciliation' },
        }));
        return;
      }
      // Natural-language claims are not execution evidence. Do not classify
      // synonyms, negation or historical clauses to block/rewrite a reply.
      // Supply an actual protected blocker once; trusted receipts/UI remain
      // the authority for completion and release status.
      if (blockedFact && observedTurns.get(agent) !== turn) {
        observedTurns.set(agent, turn);
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: blockedCompletionObservation(blockedFact) }],
          source: { kind: 'plugin', plugin: 'forge-completion-claim-guard', form: 'trusted-blocked-observation' },
        }));
      }
    };
    if (resolveProtectedCompletion === null) return evaluate(null);
    try {
      const projection = resolveProtectedCompletion({ agent, turn });
      return projection && typeof projection.then === 'function'
        ? projection.then(evaluate, () => evaluate(null))
        : evaluate(projection);
    } catch {
      return evaluate(null);
    }
  });
}

async function resolveProtectedCompletionFromBroker() {
  const brokerUrl = process.env.FORGE_TASKSPACE_BROKER_URL;
  const tokenFile = process.env.FORGE_TASKSPACE_TOKEN_FILE;
  if (typeof brokerUrl !== 'string' || !/^http:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(brokerUrl)
    || typeof tokenFile !== 'string' || !tokenFile.startsWith('/run/')) return null;
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${brokerUrl}/v1/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-taskspace-token': token },
      body: JSON.stringify({ action: 'protected-completion' }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const value = await response.json();
    return value?.ok === true ? value.result : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function apply(ctx) {
  const { createUserMessage } = await import('/opt/forge-harness-runtime/node_modules/@deepseek-ai/dsh-llm/lib/index.js');
  installCompletionClaimGuard(ctx, createUserMessage, resolveProtectedCompletionFromBroker);
}

const name = 'forge-completion-claim-guard';

export {
  GUARD_MARKER,
  PROTECTED_COMPLETION_OBSERVATION_MARKER,
  apply,
  installCompletionClaimGuard,
  latestAssistantText,
  name,
  protectedCompletionProjectionReady,
  protectedCompletionProjectionNotRequired,
  resolveProtectedCompletionFromBroker,
};
