import { createHash } from 'node:crypto';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const HEAD = /^[0-9a-f]{40}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u;

export class ForgeChangeContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ForgeChangeContractError';
    this.code = code;
  }
}

function fail(code, message) { throw new ForgeChangeContractError(code, message); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
    fail('SCHEMA_INVALID', `${label} has unsupported or missing fields.`);
  }
}
function text(value, label) {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 4000) fail('SCHEMA_INVALID', `${label} is invalid.`);
  return value;
}
function id(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail('SCHEMA_INVALID', `${label} is invalid.`);
  return value;
}
function strings(value, pattern, label, { nonempty = false } = {}) {
  if (!Array.isArray(value) || nonempty && value.length === 0 || value.some((item) => typeof item !== 'string' || !pattern.test(item))
      || new Set(value).size !== value.length) fail('SCHEMA_INVALID', `${label} is invalid or contains duplicates.`);
  return [...value].sort();
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
function digest(value) { return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`; }
function freeze(value) {
  if (plain(value) || Array.isArray(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function normalizeSource(source) {
  exact(source, ['head', 'fingerprint'], 'source');
  if (!HEAD.test(source.head ?? '') || !SHA256.test(source.fingerprint ?? '')) fail('SCHEMA_INVALID', 'source binding is invalid.');
  return { head: source.head, fingerprint: source.fingerprint };
}

function normalizeWhat(what) {
  exact(what, ['objective', 'requirements', 'assumptions'], 'what');
  text(what.objective, 'what.objective');
  if (!Array.isArray(what.requirements) || what.requirements.length === 0 || !Array.isArray(what.assumptions)) fail('SCHEMA_INVALID', 'what collections are invalid.');
  const requirements = what.requirements.map((item) => {
    exact(item, ['requirementId', 'statement', 'acceptanceCriteria'], 'requirement');
    return {
      requirementId: id(item.requirementId, 'requirement.requirementId'),
      statement: text(item.statement, 'requirement.statement'),
      acceptanceCriteria: strings(item.acceptanceCriteria, /^.{1,1000}$/u, 'requirement.acceptanceCriteria', { nonempty: true }),
    };
  }).sort((left, right) => left.requirementId.localeCompare(right.requirementId));
  if (new Set(requirements.map((item) => item.requirementId)).size !== requirements.length) fail('SCHEMA_INVALID', 'requirement ids are duplicated.');
  return { objective: what.objective, requirements, assumptions: strings(what.assumptions, /^.{1,1000}$/u, 'what.assumptions') };
}

function normalizeHow(how) {
  exact(how, ['decisions', 'risks'], 'how');
  if (!Array.isArray(how.decisions) || how.decisions.length === 0 || !Array.isArray(how.risks)) fail('SCHEMA_INVALID', 'how collections are invalid.');
  const decisions = how.decisions.map((item) => {
    exact(item, ['decisionId', 'statement', 'rationale'], 'decision');
    return { decisionId: id(item.decisionId, 'decision.decisionId'), statement: text(item.statement, 'decision.statement'), rationale: text(item.rationale, 'decision.rationale') };
  }).sort((left, right) => left.decisionId.localeCompare(right.decisionId));
  const risks = how.risks.map((item) => {
    exact(item, ['riskId', 'statement', 'mitigation'], 'risk');
    return { riskId: id(item.riskId, 'risk.riskId'), statement: text(item.statement, 'risk.statement'), mitigation: text(item.mitigation, 'risk.mitigation') };
  }).sort((left, right) => left.riskId.localeCompare(right.riskId));
  if (new Set(decisions.map((item) => item.decisionId)).size !== decisions.length || new Set(risks.map((item) => item.riskId)).size !== risks.length) fail('SCHEMA_INVALID', 'decision or risk ids are duplicated.');
  return { decisions, risks };
}

function normalizeTasks(tasks, requirementIds, decisionIds) {
  if (!Array.isArray(tasks) || tasks.length === 0) fail('SCHEMA_INVALID', 'tasks must be non-empty.');
  const normalized = tasks.map((item) => {
    exact(item, ['taskId', 'summary', 'dependsOn', 'requirementIds', 'decisionIds', 'ownedPaths'], 'task');
    return {
      taskId: id(item.taskId, 'task.taskId'), summary: text(item.summary, 'task.summary'),
      dependsOn: strings(item.dependsOn, SAFE_ID, 'task.dependsOn'),
      requirementIds: strings(item.requirementIds, SAFE_ID, 'task.requirementIds', { nonempty: true }),
      decisionIds: strings(item.decisionIds, SAFE_ID, 'task.decisionIds', { nonempty: true }),
      ownedPaths: strings(item.ownedPaths, SAFE_PATH, 'task.ownedPaths', { nonempty: true }),
    };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId));
  const taskIds = new Set(normalized.map((item) => item.taskId));
  if (taskIds.size !== normalized.length) fail('SCHEMA_INVALID', 'task ids are duplicated.');
  for (const task of normalized) {
    if (task.dependsOn.includes(task.taskId) || task.dependsOn.some((value) => !taskIds.has(value))) fail('TASK_REFERENCE_INVALID', `${task.taskId} has an invalid dependency.`);
    if (task.requirementIds.some((value) => !requirementIds.has(value)) || task.decisionIds.some((value) => !decisionIds.has(value))) fail('TASK_REFERENCE_INVALID', `${task.taskId} references an unknown requirement or decision.`);
  }
  const visiting = new Set(); const visited = new Set(); const byId = new Map(normalized.map((item) => [item.taskId, item]));
  function visit(taskId) {
    if (visiting.has(taskId)) fail('TASK_CYCLE', `Task dependency cycle contains ${taskId}.`);
    if (visited.has(taskId)) return;
    visiting.add(taskId); byId.get(taskId).dependsOn.forEach(visit); visiting.delete(taskId); visited.add(taskId);
  }
  normalized.forEach((item) => visit(item.taskId));
  return normalized;
}

export function sealForgeChangeContract(input) {
  exact(input, ['schemaVersion', 'contractType', 'contractId', 'projectSlug', 'revision', 'source', 'what', 'how', 'tasks'], 'change contract');
  if (input.schemaVersion !== 1 || input.contractType !== 'forge-change/what-how-task' || !Number.isSafeInteger(input.revision) || input.revision < 1) fail('SCHEMA_INVALID', 'change contract header is invalid.');
  const what = normalizeWhat(input.what); const how = normalizeHow(input.how);
  const tasks = normalizeTasks(input.tasks, new Set(what.requirements.map((item) => item.requirementId)), new Set(how.decisions.map((item) => item.decisionId)));
  const normalized = { schemaVersion: 1, contractType: input.contractType, contractId: id(input.contractId, 'contractId'), projectSlug: id(input.projectSlug, 'projectSlug'), revision: input.revision, source: normalizeSource(input.source), what, how, tasks };
  const whatSha256 = digest(what);
  const howSha256 = digest({ whatSha256, how });
  const tasksSha256 = digest({ whatSha256, howSha256, tasks });
  const layerDigests = { whatSha256, howSha256, tasksSha256 };
  return freeze({ ...normalized, layerDigests, integrity: { canonicalSha256: digest({ ...normalized, layerDigests }) } });
}

export function createForgeChangeContractBinding(contract, input) {
  const sealed = contract?.layerDigests === undefined ? sealForgeChangeContract(contract) : unseal(contract);
  exact(input, ['bindingId', 'purpose'], 'binding');
  if (!['implementation', 'review', 'verification'].includes(input.purpose)) fail('SCHEMA_INVALID', 'binding purpose is invalid.');
  return freeze({ schemaVersion: 1, bindingType: 'forge-change/downstream-binding', bindingId: id(input.bindingId, 'bindingId'), purpose: input.purpose, contractId: sealed.contractId, revision: sealed.revision, source: sealed.source, layerDigests: sealed.layerDigests, contractSha256: sealed.integrity.canonicalSha256 });
}

function unseal(contract) {
  exact(contract, ['schemaVersion', 'contractType', 'contractId', 'projectSlug', 'revision', 'source', 'what', 'how', 'tasks', 'layerDigests', 'integrity'], 'sealed change contract');
  const { layerDigests, integrity, ...input } = contract;
  const sealed = sealForgeChangeContract(input);
  if (JSON.stringify(sealed.layerDigests) !== JSON.stringify(layerDigests) || sealed.integrity.canonicalSha256 !== integrity?.canonicalSha256) fail('CONTRACT_INTEGRITY_INVALID', 'change contract digest verification failed.');
  return sealed;
}

export function verifyForgeChangeContractBinding(contract, binding) {
  const sealed = unseal(contract);
  const expected = createForgeChangeContractBinding(sealed, { bindingId: binding?.bindingId, purpose: binding?.purpose });
  const valid = JSON.stringify(expected) === JSON.stringify(binding);
  return freeze({ valid, reasonCode: valid ? 'BINDING_CURRENT' : 'BINDING_STALE', currentContractSha256: sealed.integrity.canonicalSha256 });
}

export function evaluateForgeChangeContractDrift(baseline, current) {
  const before = unseal(baseline); const after = unseal(current);
  if (before.contractId !== after.contractId || before.projectSlug !== after.projectSlug) fail('CONTRACT_IDENTITY_MISMATCH', 'Cannot compare different change contracts.');
  const whatChanged = before.layerDigests.whatSha256 !== after.layerDigests.whatSha256;
  const howChanged = before.layerDigests.howSha256 !== after.layerDigests.howSha256;
  const tasksChanged = before.layerDigests.tasksSha256 !== after.layerDigests.tasksSha256;
  const sourceChanged = before.source.head !== after.source.head || before.source.fingerprint !== after.source.fingerprint;
  const invalidatedLayers = whatChanged ? ['what', 'how', 'tasks', 'downstream']
    : howChanged ? ['how', 'tasks', 'downstream']
      : tasksChanged ? ['tasks', 'downstream'] : sourceChanged ? ['downstream'] : [];
  return freeze({ status: invalidatedLayers.length === 0 ? 'current' : 'blocked', reasonCode: invalidatedLayers.length === 0 ? 'NO_DRIFT' : 'CONTRACT_DRIFT', whatChanged, howChanged, tasksChanged, sourceChanged, invalidatedLayers });
}

const REVIEW_PACKAGE_KEYS = ['schemaVersion', 'packageType', 'acceptanceContractId', 'projectSlug', 'taskId',
  'source', 'baseCommit', 'diffSha256', 'changeContractSource', 'changeContractSha256', 'layerDigests',
  'testReceipts', 'files', 'previousReview'];
const RAW_SHA256 = /^[0-9a-f]{64}$/u;
function prefixedReviewDigest(value) {
  if (typeof value !== 'string' || !(RAW_SHA256.test(value) || SHA256.test(value))) fail('REVIEW_PACKAGE_INVALID', 'Review source digest is invalid.');
  return value.startsWith('sha256:') ? value : `sha256:${value}`;
}

function reviewPath(value) {
  if (typeof value !== 'string' || value.length > 512 || value !== value.normalize('NFC')
    || !/^(?:forge-server|forge-admin-ui)\//u.test(value) || /[\\:\u0000-\u001f\u007f]/u.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) fail('REVIEW_PACKAGE_INVALID', 'Review path is outside the bounded source roots.');
  return value;
}

export function sealForgeDualReviewPackage(value) {
  exact(value, REVIEW_PACKAGE_KEYS, 'dual review package');
  if (value.schemaVersion !== 1 || value.packageType !== 'forge-review/spec-quality'
    || !RAW_SHA256.test(value.acceptanceContractId ?? '') || !HEAD.test(value.baseCommit ?? '')
    || !SHA256.test(value.diffSha256 ?? '') || !SHA256.test(value.changeContractSha256 ?? '')) {
    fail('REVIEW_PACKAGE_INVALID', 'Dual review package identity or source digests are invalid.');
  }
  id(value.projectSlug, 'review project'); id(value.taskId, 'review task'); normalizeSource(value.source);
  exact(value.changeContractSource, ['sourcePath', 'sha256'], 'review contract source');
  reviewPath(value.changeContractSource.sourcePath);
  if (!value.changeContractSource.sourcePath.endsWith('.json') || !RAW_SHA256.test(value.changeContractSource.sha256 ?? '')) {
    fail('REVIEW_PACKAGE_INVALID', 'Review contract source must have its actual JSON file digest.');
  }
  exact(value.layerDigests, ['whatSha256', 'howSha256', 'tasksSha256'], 'review layer digests');
  if (Object.values(value.layerDigests).some(hash => !SHA256.test(hash))) fail('REVIEW_PACKAGE_INVALID', 'WHAT/HOW/task digests are required.');
  if (!Array.isArray(value.testReceipts) || value.testReceipts.length < 1 || value.testReceipts.length > 64
    || new Set(value.testReceipts.map(item => item?.receiptId)).size !== value.testReceipts.length) {
    fail('REVIEW_PACKAGE_INVALID', 'Review requires distinct protected test receipts.');
  }
  for (const receipt of value.testReceipts) {
    exact(receipt, ['receiptId', 'profile', 'canonicalSha256', 'logSha256'], 'review test receipt');
    id(receipt.receiptId, 'test receipt id'); id(receipt.profile, 'test receipt profile');
    if (!SHA256.test(receipt.canonicalSha256 ?? '') || !SHA256.test(receipt.logSha256 ?? '')) {
      fail('REVIEW_PACKAGE_INVALID', 'Review test receipt digest is invalid.');
    }
  }
  if (!value.testReceipts.some(item => /(?:^|-)test(?:-|$)/u.test(item.profile))) {
    fail('REVIEW_PACKAGE_INVALID', 'Build or static receipts alone cannot establish the review test prerequisite.');
  }
  if (!Array.isArray(value.files) || value.files.length < 1 || value.files.length > 512
    || new Set(value.files.map(file => file?.path)).size !== value.files.length) fail('REVIEW_PACKAGE_INVALID', 'Review input manifest is invalid.');
  for (const file of value.files) {
    exact(file, ['path', 'sha256', 'lineCount'], 'review input file'); reviewPath(file.path);
    if (!RAW_SHA256.test(file.sha256 ?? '') || !Number.isSafeInteger(file.lineCount) || file.lineCount < 0) {
      fail('REVIEW_PACKAGE_INVALID', 'Review input file hash or line count is invalid.');
    }
  }
  if (!value.files.some(file => file.path === value.changeContractSource.sourcePath && file.sha256 === value.changeContractSource.sha256)) {
    fail('REVIEW_PACKAGE_INVALID', 'The WHAT/HOW/task source is missing from the reviewed file manifest.');
  }
  if (value.previousReview !== null) {
    exact(value.previousReview, ['reviewId', 'packageSha256', 'head', 'blockingFindings'], 'previous review');
    id(value.previousReview.reviewId, 'previous review id');
    if (!SHA256.test(value.previousReview.packageSha256 ?? '') || !HEAD.test(value.previousReview.head ?? '')) {
      fail('REVIEW_PACKAGE_INVALID', 'Previous review binding is invalid.');
    }
    strings(value.previousReview.blockingFindings, SHA256, 'previous blocking findings', { nonempty: true });
  }
  const normalized = structuredClone(value);
  normalized.files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  normalized.testReceipts.sort((a, b) => a.receiptId.localeCompare(b.receiptId, 'en'));
  return freeze({ ...normalized, integrity: { canonicalSha256: digest(normalized) } });
}

export function validateForgeDualReviewPackage(value) {
  exact(value, [...REVIEW_PACKAGE_KEYS, 'integrity'], 'sealed dual review package');
  exact(value.integrity, ['canonicalSha256'], 'dual review integrity');
  const { integrity, ...input } = value;
  const sealed = sealForgeDualReviewPackage(input);
  if (sealed.integrity.canonicalSha256 !== integrity.canonicalSha256) fail('REVIEW_PACKAGE_STALE', 'The review package was changed after binding.');
  return sealed;
}

export function forgeReviewFindingDigest(finding) { return digest(finding); }

export function validateForgeReviewPredecessor(value) {
  exact(value, ['binding', 'findings'], 'protected previous review');
  const binding = value.binding;
  exact(binding, ['reviewId', 'packageSha256', 'head', 'blockingFindings'], 'previous review binding');
  id(binding.reviewId, 'previous review id');
  if (!SHA256.test(binding.packageSha256 ?? '') || !HEAD.test(binding.head ?? '')) fail('REVIEW_PACKAGE_INVALID', 'Previous review identity is invalid.');
  const ids = strings(binding.blockingFindings, SHA256, 'previous blocking findings', { nonempty: true });
  if (ids.length > 64 || !Array.isArray(value.findings) || value.findings.length !== ids.length) {
    fail('REVIEW_FINDING_OPEN', 'Protected previous findings are incomplete or exceed the bounded review.');
  }
  const seen = new Set();
  for (const item of value.findings) {
    exact(item, ['findingSha256', 'finding'], 'previous finding');
    if (!ids.includes(item.findingSha256) || seen.has(item.findingSha256)
      || digest(item.finding) !== item.findingSha256 || item.finding.severity !== 'blocking') {
      fail('REVIEW_FINDING_OPEN', 'Previous finding differs from its protected binding.');
    }
    seen.add(item.findingSha256);
  }
  return freeze(structuredClone(value));
}

export function validateForgeDualReviewEvidence(value, { decision, contract = null, testReceipts = null } = {}) {
  exact(value, ['package', 'provider', 'model', 'providerRequestId', 'specVerdict', 'qualityVerdict', 'findings', 'findingResolutions'], 'dual review evidence');
  const reviewed = validateForgeDualReviewPackage(value.package);
  id(value.provider, 'review provider'); id(value.model, 'review model'); id(value.providerRequestId, 'review request');
  if (contract !== null && (reviewed.acceptanceContractId !== contract.contractId || reviewed.projectSlug !== contract.projectSlug
    || reviewed.taskId !== contract.taskId || reviewed.source.head !== contract.candidate.source.head
    || reviewed.source.fingerprint !== prefixedReviewDigest(contract.candidate.source.fingerprint)
    || JSON.stringify(canonical(reviewed.changeContractSource)) !== JSON.stringify(canonical(contract.dualReview)))) {
    fail('REVIEW_PACKAGE_STALE', 'The review package does not match the protected current contract and source.');
  }
  if (contract !== null && digest(reviewed.previousReview) !== digest(contract.previousReview?.binding ?? null)) {
    fail('REVIEW_FINDING_OPEN', 'The review omitted or replaced the protected previous rejection.');
  }
  if (testReceipts !== null && digest([...testReceipts].sort((a, b) => a.receiptId.localeCompare(b.receiptId, 'en'))) !== digest(reviewed.testReceipts)) {
    fail('REVIEW_TEST_RECEIPTS_STALE', 'Review test evidence differs from the current protected receipts.');
  }
  validateForgeDualReviewResult({ specVerdict: value.specVerdict, qualityVerdict: value.qualityVerdict,
    findings: value.findings, findingResolutions: value.findingResolutions }, reviewed, decision);
  return freeze(structuredClone(value));
}

export function validateForgeDualReviewResult(value, reviewPackage, decision) {
  exact(value, ['specVerdict', 'qualityVerdict', 'findings', 'findingResolutions'], 'dual review result');
  const reviewed = validateForgeDualReviewPackage(reviewPackage);
  const files = new Map(reviewed.files.map(file => [file.path, file]));
  const evidence = (items) => {
    if (!Array.isArray(items) || items.length < 1 || items.length > 32) fail('REVIEW_VERDICT_INVALID', 'Each verdict or finding resolution needs bounded source evidence.');
    for (const item of items) {
      exact(item, ['path', 'line', 'detail'], 'review evidence'); text(item.detail, 'review evidence detail');
      if (!files.has(item.path) || !Number.isSafeInteger(item.line) || item.line < 1 || item.line > files.get(item.path).lineCount) {
        fail('REVIEW_VERDICT_INVALID', 'Review evidence must cite a real input file and line.');
      }
    }
  };
  for (const verdict of [value.specVerdict, value.qualityVerdict]) {
    exact(verdict, ['status', 'summary', 'evidence'], 'review verdict');
    if (!['pass', 'fail'].includes(verdict.status)) fail('REVIEW_VERDICT_INVALID', 'Both review verdicts are required.');
    text(verdict.summary, 'review verdict summary'); evidence(verdict.evidence);
  }
  if (!Array.isArray(value.findings) || value.findings.length > 20
    || value.findings.some(item => !plain(item) || !['blocking', 'advisory'].includes(item.severity))) {
    fail('REVIEW_VERDICT_INVALID', 'Review findings are invalid.');
  }
  for (const finding of value.findings) {
    exact(finding, ['path', 'line', 'severity', 'detail', 'changeEvidence'], 'review finding');
    evidence([{ path: finding.path, line: finding.line, detail: finding.detail }]);
    if (finding.severity === 'advisory') {
      if (finding.changeEvidence !== null) fail('REVIEW_VERDICT_INVALID', 'Advisory findings cannot claim blocking change evidence.');
    } else {
      exact(finding.changeEvidence, ['path', 'side', 'line', 'explanation'], 'blocking change evidence');
      text(finding.changeEvidence.explanation, 'blocking change explanation');
      if (!files.has(finding.changeEvidence.path) || !['before', 'after'].includes(finding.changeEvidence.side)
        || !Number.isSafeInteger(finding.changeEvidence.line) || finding.changeEvidence.line < 1) {
        fail('REVIEW_VERDICT_INVALID', 'Blocking findings require bounded actual-input change evidence.');
      }
    }
  }
  const expected = new Set(reviewed.previousReview?.blockingFindings ?? []);
  if (!Array.isArray(value.findingResolutions) || value.findingResolutions.length !== expected.size) {
    fail('REVIEW_FINDING_OPEN', 'Every previous blocking finding needs a current resolution.');
  }
  const resolved = new Set();
  for (const resolution of value.findingResolutions) {
    exact(resolution, ['findingSha256', 'status', 'evidence'], 'finding resolution');
    if (!expected.has(resolution.findingSha256) || resolved.has(resolution.findingSha256)
      || !['resolved', 'open'].includes(resolution.status)) fail('REVIEW_FINDING_OPEN', 'Finding resolution identity or status is invalid.');
    evidence(resolution.evidence); resolved.add(resolution.findingSha256);
  }
  const passes = value.specVerdict.status === 'pass' && value.qualityVerdict.status === 'pass'
    && value.findings.every(item => item.severity !== 'blocking') && value.findingResolutions.every(item => item.status === 'resolved');
  if (!['approved', 'rejected'].includes(decision) || (decision === 'approved') !== passes) {
    fail('REVIEW_VERDICT_CONFLICT', 'Passing review requires both verdicts and closure of all blocking findings.');
  }
  if (decision === 'rejected' && !value.findings.some(item => item.severity === 'blocking')
    && !value.findingResolutions.some(item => item.status === 'open')) {
    fail('REVIEW_VERDICT_CONFLICT', 'A rejection must preserve a concrete blocking or unresolved finding.');
  }
  if (passes && reviewed.previousReview !== null && reviewed.previousReview.head === reviewed.source.head) {
    fail('REVIEW_REPAIR_COMMIT_REQUIRED', 'A passing re-review must bind the repaired commit, preserving the original rejection.');
  }
  return freeze(structuredClone(value));
}
