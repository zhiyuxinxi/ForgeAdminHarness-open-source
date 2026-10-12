import {
  controlledEvidenceReceipt,
  parseControlledEvidenceCommand,
  parseControlledReleaseMutationCommand,
} from './forge-controlled-command.mjs';
import { canonicalSha256 } from './forge-acceptance-aggregator.mjs';
import { readFile } from 'node:fs/promises';

const GUARD_MARKER = 'FORGE_COMPLETION_CLAIM_GUARD_V1';
const PROTECTED_COMPLETION_OBSERVATION_MARKER = 'FORGE_PROTECTED_COMPLETION_OBSERVATION_V1';
const MAX_CORRECTION_STEPS = 2;

const COMPLETION_CLAIMS = Object.freeze([
  /所有(?:工作|任务|需求|实现)?(?:均|都)?已(?:经)?完成/giu,
  /(?:全部|所有)(?:工作|任务|需求|实现)(?:均|都)?(?:已经|已)?完成/giu,
  /(?:工作|任务|需求|实现)(?:均|都)?已(?:经)?(?:全部|完全)?完成/giu,
  /已(?:经)?完成(?:全部|所有)(?:工作|任务|需求|实现)/giu,
  /\b(?:all|every)\s+(?:work|tasks?|requirements?|implementation)\s+(?:is|are|has been|have been)\s+(?:fully\s+)?(?:complete|completed)\b/giu,
  /\b(?:the\s+)?(?:task|work|implementation)\s+(?:is|has been)\s+(?:fully\s+)?(?:complete|completed)\b/giu,
  /(?:全部|所有|整体)?(?:验证|测试|验收)(?:均|都)?(?:已经|已)?通过/giu,
  /(?:任务|工作|实现|交付)(?:已经|已)?(?:就绪|通过验收|全部交付)/giu,
  /\b(?:everything|implementation|task|work)\s+(?:is\s+|has\s+been\s+)?(?:done|ready|passed|verified|accepted|fully\s+delivered)\b/giu,
  /\b(?:all|every)\s+(?:checks?|tests?|verification|acceptance)\s+(?:has\s+|have\s+)?(?:passed|been\s+verified|been\s+accepted)\b/giu,
]);

const NEGATED_CLAIM_PREFIX = /(?:(?:没有\s*(?:任何)?\s*(?:运行时|实际|真实)?)|(?:(?:不|未|不能|不得|禁止|不可|并非|尚未|拒绝|避免)\s*(?:(?:应|能|可|得|该|宜)\s*)?(?:(?:声称|宣称|声明|认定|认为|称为|说|表述为|算(?:作|是)?)\s*)?)|(?:(?:must\s+not|cannot|can't|do\s+not|never)\s+(?:(?:claim|say|state|call)(?:\s+that)?\s*)?))$/iu;
const NEGATED_CLAIM_SCOPE = /(?:没有\s*宣布|(?:不能|不得|禁止|不可|拒绝|避免|无法|未|不)\s*(?:据此\s*)?(?:(?:应|能|可|得|该|宜)\s*)?(?:声称|宣称|声明|认定|认为|称为|说|表述为|记录|证明|算(?:作|是)?)|(?:must\s+not|cannot|can't|do\s+not|never)\s+(?:claim|say|state|call)(?:\s+that)?)\s*[^\r\n。！？；;,，]{0,96}$/iu;
const CLAIM_SCOPE_BOUNDARY = /(?:\r?\n|[。！？；;,，]|\b(?:but|however|yet)\b|(?:但是|不过|然而|但|却))/giu;
const UNPROVEN_MARKERS = Object.freeze([
  /未(?:验证|执行|运行|证明|通过|验收|闭环)/iu,
  /尚未(?:验证|执行|运行|证明|通过|验收|闭环)/iu,
  /(?:无法|不能)(?:验证|执行|运行|证明|通过|验收)/iu,
  /(?:受阻|阻塞项|缺少(?:运行|测试|迁移|浏览器|验收)?证据)/iu,
  /\b(?:unverified|not\s+verified|not\s+executed|not\s+run|not\s+proven|not\s+accepted|blocked|unable\s+to\s+(?:verify|run|execute|prove)|missing\s+(?:runtime\s+|test\s+)?evidence)\b/iu,
  /(?:失败|未通过|不通过|发生错误|退出码为?\s*[1-9]\d*)/iu,
]);

const MUTATION_TOOLS = new Set(['edit', 'write', 'str_replace_editor']);
const WRITE_INTENT = /\b(?:implement|fix|modify|change|add|create|delete|refactor|build)\b|修复|修改|新增|创建|删除|重构|改代码|写代码|(?:请|需要|要|开始|继续|直接)[^\r\n]{0,12}实现|实现[^\r\n]{0,12}(?:功能|需求|代码|修复|改动)/iu;

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

function maskQuotedExamples(text) {
  return text
    .replace(/```[\s\S]*?```/gu, (value) => value.replace(/[^\n]/gu, ' '))
    .replace(/`[^`\r\n]*`/gu, (value) => ' '.repeat(value.length))
    .replace(/[“”][^“”\r\n]*[“”]/gu, (value) => ' '.repeat(value.length))
    .replace(/"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/gu, (value) => ' '.repeat(value.length));
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

function currentAcceptanceClaim(text) {
  for (const clause of maskQuotedExamples(text).split(CLAIM_SCOPE_BOUNDARY)) {
    if (/^\s*>|[?？]|是否|能否|待确认|待核对/u.test(clause)
      || /历史|此前|先前|之前|上一轮|上次|曾经|\bhistorical\b|\bpreviously\b/iu.test(clause)) continue;
    const current = /当前|现在|目前|本轮|本次|正式|最终|代码合同|任务合同|\bcurrent\b/iu.exec(clause);
    const claim = /\bREADY\b|验收(?:已经|已)?(?:完成|通过)|验收(?:状态|结论)(?:已经|已|为|是|保持|仍为|仍是)?\s*[:：]?\s*(?:完成|通过|就绪)/iu.exec(clause);
    if (!current || !claim || current.index > claim.index) continue;
    const prefix = clause.slice(0, claim.index);
    if (NEGATED_CLAIM_PREFIX.test(prefix) || NEGATED_CLAIM_SCOPE.test(prefix)
      || /未|不再|不是|并非|不能|不可|无法|\bnot\b|\bcannot\b/iu.test(prefix.slice(current.index))) continue;
    return clause.trim();
  }
  return null;
}

function blockedCompletionObservation(fact) {
  return `${PROTECTED_COMPLETION_OBSERVATION_MARKER}: Trusted read-only resolver observation: current code contract execution acceptance is BOUNDED_BLOCKED. ${JSON.stringify(fact)} Correct the claim of current READY or completed acceptance. Closed obligation counts alone do not establish current acceptance; signedVerdictVerified, even when true, does not override these blockers, and false never proves acceptance. Preserve historical passed test results without presenting them as current accepted evidence. Contract expiry is not a failed test. This status correction does not authorize renewal, receipt revalidation, rerunning checks, source changes, independent review, or release; respect the current read-only request and report the actual bounded status.`;
}

function verificationFamily(command) {
  const controlled = parseControlledEvidenceCommand(command);
  if (controlled?.family === 'governance') return 'forge-governance';
  if (controlled?.executable === 'forge-verify'
    && ['run', 'receipt'].includes(controlled.action)) return controlled.family;
  if (/\bmvn(?:w)?\b[^\r\n]*(?:test|verify|package|compile)\b/iu.test(command)) return 'maven';
  if (/\b(?:pnpm|npm|yarn)\b[^\r\n]*(?:test|build|lint)\b|\bvitest\b/iu.test(command)) return 'frontend';
  if (/\b(?:flyway|mysql)\b[^\r\n]*(?:migrate|validate|source|<)\b/iu.test(command)) return 'migration';
  return null;
}

function completionEvidence(agent, turn, protectedCompletionProjection = null) {
  const events = Array.isArray(agent?.session?.events) ? agent.session.events : [];
  const calls = new Map();
  const results = new Map();
  let mutationObserved = false;
  let evidenceSkillObserved = false;
  let writeIntentObserved = false;
  for (const event of events) {
    if (event?.data?.turn !== turn) continue;
    if (event.type === 'user/message') {
      const message = event.data?.message && typeof event.data.message === 'object'
        ? event.data.message : event.data;
      if (message?.source?.kind !== 'plugin' && WRITE_INTENT.test(messageText(message))) {
        writeIntentObserved = true;
      }
    } else if (event.type === 'tool/call') {
      calls.set(event.data.callId, event);
      const args = toolArguments(event);
      if (MUTATION_TOOLS.has(event.data.name)) mutationObserved = true;
      const requestedSkill = args.skill ?? args.name;
      if (event.data.name === 'skill' && requestedSkill === 'forge-evidence-truth') evidenceSkillObserved = true;
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId;
      if (typeof callId === 'string') results.set(callId, event);
    }
  }
  const latestVerification = new Map();
  for (const call of calls.values()) {
    if (call.data.name !== 'bash') continue;
    const command = toolArguments(call).command;
    if (typeof command !== 'string') continue;
    const family = verificationFamily(command);
    if (!family) continue;
    const result = results.get(call.data.callId);
    const text = toolResultText(result);
    const controlled = parseControlledEvidenceCommand(command);
    const typed = controlled ? controlledEvidenceReceipt(command, text) : null;
    const failed = !result || toolResultFailed(result)
      || (family === 'forge-governance'
        && (typed === null || typed.receipt.ok !== true))
      || (family.startsWith('forge-verify-')
        && (typed === null
          || typed.receipt.status !== 'passed'
          || typed.receipt.truth?.verificationProven !== true));
    latestVerification.set(family, {
      failed,
      obligations: family === 'forge-governance' && typed !== null
        ? typed.receipt.obligations
        : [],
    });
  }
  const blockers = [];
  if (writeIntentObserved && !mutationObserved) blockers.push('source-implementation-evidence-missing');
  if (mutationObserved && !latestVerification.has('forge-governance')) blockers.push('forge-governance-audit-missing');
  for (const [family, result] of latestVerification) if (result.failed) blockers.push(`${family}-verification-failed`);
  const governance = latestVerification.get('forge-governance');
  if (governance?.obligations?.length > 0 && !protectedCompletionProjectionReady(protectedCompletionProjection)) {
    blockers.push('protected-obligation-closure-missing-or-blocked');
  }
  return { writeIntentObserved, mutationObserved, evidenceSkillObserved, blockers };
}

function* unnegatedCompletionClaims(text) {
  const evaluated = maskQuotedExamples(text)
    .split(/(\r?\n)/u)
    .map((line) => line.includes('|') && UNPROVEN_MARKERS.some((pattern) => pattern.test(line))
      ? line.replace(/[^\r\n]/gu, ' ')
      : line)
    .join('');
  for (const pattern of COMPLETION_CLAIMS) {
    pattern.lastIndex = 0;
    for (const match of evaluated.matchAll(pattern)) {
      const prefix = evaluated.slice(Math.max(0, match.index - 128), match.index);
      CLAIM_SCOPE_BOUNDARY.lastIndex = 0;
      const scopedPrefix = prefix.split(CLAIM_SCOPE_BOUNDARY).at(-1) ?? prefix;
      if (!NEGATED_CLAIM_PREFIX.test(prefix) && !NEGATED_CLAIM_SCOPE.test(scopedPrefix)) yield match[0];
    }
  }
}

function reportedUnprovenStatus(text) {
  return maskQuotedExamples(text)
    .replace(/(?:没有|不存在|无)\s*(?:任何)?(?:未验证项|未执行项|阻塞项|失败项)/gu, ' ')
    .replace(/\bno\s+(?:unverified|unexecuted|blocked|failed)\s+(?:items?|work|evidence|checks?)\b/giu, ' ')
    .replace(/\b0\s*(?:失败|failures?\b)/giu, ' ')
    .replace(/失败(?:数|数量)(?:为|是|[:：=])?\s*0(?![\d.eE])/gu, ' ')
    .replace(/(?:历史|此前|先前)(?:的)?失败(?:记录|日志|回执)(?:已经|已)(?:保留|留存|归档)/gu, ' ');
}

function completionClaimConflict(text, evidence = { blockers: [] }, protectedCompletionProjection = null) {
  if (typeof text !== 'string' || text.length === 0) return null;
  // A current protected code-contract result does not claim that a separate release succeeded.
  const claimText = evidence.blockers?.length === 0 && protectedCompletionObservation(protectedCompletionProjection)
    ? text.replace(/(^|[\r\n。！？；])([ \t]*(?:[-*][ \t]+)?(?:\*\*)?)代码合同执行验收(?:已经|已)?通过(?=$|[\s。！？；，：.!?;,*])/gu, '$1$2 ')
    : text;
  const evaluated = reportedUnprovenStatus(text);
  const evidenceBlocker = evidence.blockers?.[0];
  for (const claim of unnegatedCompletionClaims(claimText)) {
    // A test result does not claim a separate deployment or release succeeded.
    // Keep test-related clauses and every machine-evidence blocker; broader
    // completion claims still have to account for the entire response.
    const status = /测试|\btests?\b/iu.test(claim)
      ? evaluated.split(CLAIM_SCOPE_BOUNDARY).filter((clause) =>
        !/(?:部署|发布|上线|\bdeploy(?:ment|ed)?\b|\brelease\b)/iu.test(clause)
        || /(?:测试|验证|\btests?\b|\bverification\b)/iu.test(clause)).join('。')
      : evaluated;
    const blocker = UNPROVEN_MARKERS.find((pattern) => pattern.test(status));
    if (blocker || evidenceBlocker) return { claim, blocker: evidenceBlocker ?? blocker.source };
  }
  return null;
}

function correctionText(conflict) {
  return `${GUARD_MARKER}: Your latest assistant response contains a broad completion claim (${JSON.stringify(conflict.claim)}) while the same response reports failed, blocked, unexecuted, or unverified required evidence. Do not repeat the broad completion claim. Reissue a corrected final status that separates implemented candidate work from executed proof, lists every bounded blocker, and does not call the task completed, passed, verified, accepted, or fully delivered.`;
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

function unfinishedTodoObservation(count) {
  return `${GUARD_MARKER}: The latest successful todo_write in this turn still has ${count} in_progress item(s), but this turn is about to end and no uncollected native background job was observed. Reconcile that state before your final reply. Continue only the remaining work already authorized by the current user request when it is actionable; do not leave an internal evidence-closeout step unfinished while telling the user to keep waiting. Rebind applicable passed receipts with forge-verify run --reuse-receipt using current admission and original selectors; receipt only reads proof, and review is a separate independent semantic review. If a real source change invalidates one check, run only that required affected check and preserve the other results. Respect an explicit pause, stop, analysis-only request, missing authority, or real external blocker: do not resume such work; explain the exact blocker or paused state and update the todo honestly. Do not mark an unresolved item completed by renaming it to recording a gap. Only an actually registered unfinished native background job justifies a claim that work will continue automatically. This is one status reconciliation, not new authorization, a test rerun requirement, or an automatic retry.`;
}

function installCompletionClaimGuard(ctx, createUserMessage, resolveProtectedCompletion = null) {
  if (resolveProtectedCompletion !== null && typeof resolveProtectedCompletion !== 'function') {
    throw new TypeError('resolveProtectedCompletion must be a protected synchronous resolver or null');
  }
  const attempts = new WeakMap();
  const observedTurns = new WeakMap();
  const blockedObservedTurns = new WeakMap();
  const reconciledTodoTurns = new WeakMap();
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const events = Array.isArray(agent?.session?.events) ? agent.session.events : [];
    const assistantEvent = events.findLast(
      (event) => event?.type === 'assistant/message' && event.data?.turn === turn,
    );
    const evaluate = (projection) => {
      const observation = protectedCompletionObservation(projection);
      const text = assistantText(assistantEvent?.data?.message);
      const blockedFact = protectedBlockedCompletionFact(projection);
      const blockedClaim = blockedFact && currentAcceptanceClaim(text);
      const conflict = blockedClaim ? { claim: blockedClaim, blocker: 'protected-current-acceptance-blocked' }
        : completionClaimConflict(text, completionEvidence(agent, turn, projection), projection);
      const needsObservation = conflict || UNPROVEN_MARKERS.some((pattern) => pattern.test(reportedUnprovenStatus(text)));
      const unfinishedTodos = assistantEvent ? unfinishedTurnTodos(events, turn) : 0;
      if (unfinishedTodos && reconciledTodoTurns.get(agent) !== turn) {
        reconciledTodoTurns.set(agent, turn);
        if (observation) observedTurns.set(agent, turn);
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: [observation, unfinishedTodoObservation(unfinishedTodos)].filter(Boolean).join('\n\n') }],
          source: { kind: 'plugin', plugin: 'forge-completion-claim-guard', form: 'todo-status-reconciliation' },
        }));
        return;
      }
      // A correct final answer must be allowed to end. Steering an unconditional
      // READY acknowledgement starts an unnecessary model stream that can stall.
      if (observation && needsObservation && (!observedTurns.has(agent) || observedTurns.get(agent) !== turn)) {
        observedTurns.set(agent, turn);
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: observation }],
          source: { kind: 'plugin', plugin: 'forge-completion-claim-guard', form: 'trusted-observation' },
        }));
        return;
      }
      if (!conflict) {
        attempts.delete(agent);
        return;
      }
      const state = attempts.get(agent);
      const messageIdentity = assistantEvent?.data?.message?.id ?? assistantEvent?.seq ?? assistantEvent;
      if (state?.turn === turn && state.messageIdentity === messageIdentity) return;
      const count = state?.turn === turn ? state.count + 1 : 1;
      attempts.set(agent, { turn, count, messageIdentity });
      if (count > MAX_CORRECTION_STEPS) {
        throw new Error(`${GUARD_MARKER}: model repeated a contradictory completion claim after ${MAX_CORRECTION_STEPS} correction steps`);
      }
      const firstBlockedObservation = blockedClaim && blockedObservedTurns.get(agent) !== turn;
      if (firstBlockedObservation) blockedObservedTurns.set(agent, turn);
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: firstBlockedObservation ? blockedCompletionObservation(blockedFact)
          : blockedClaim ? `${GUARD_MARKER}: The trusted resolver still contradicts this current READY or completed-acceptance claim. Correct only the final status using the already supplied bounded-blocked facts; this is not authorization to renew, revalidate receipts, rerun checks or release.`
            : correctionText(conflict) }],
        source: { kind: 'plugin', plugin: 'forge-completion-claim-guard',
          ...(firstBlockedObservation ? { form: 'trusted-blocked-observation' } : {}) },
      }));
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
  MAX_CORRECTION_STEPS,
  PROTECTED_COMPLETION_OBSERVATION_MARKER,
  apply,
  completionClaimConflict,
  completionEvidence,
  installCompletionClaimGuard,
  latestAssistantText,
  name,
  protectedCompletionProjectionReady,
  resolveProtectedCompletionFromBroker,
};
